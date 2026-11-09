import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CreateProjectInput,
  Project,
  ScanEnvironment,
  ScanPreflight,
} from '@archguard/contracts'

const projectColumns = 'id, name, repository_url AS repositoryUrl, created_at AS createdAt'
const jobColumns = `
  id, project_id AS projectId, status, created_at AS createdAt,
  finished_at AS finishedAt, result_json AS resultJson, error
`

type JobRow = Omit<ScanPreflight, 'result'> & { resultJson: string | null }

function readJob(row: JobRow): ScanPreflight {
  const { resultJson, ...job } = row
  return { ...job, result: resultJson === null ? null : JSON.parse(resultJson) }
}

export class SqliteStore {
  private readonly db: DatabaseSync

  constructor() {
    const dataDir = resolve(process.env.ARCHGUARD_DATA_DIR || resolve(__dirname, '../../../../data'))
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(resolve(dataDir, 'archguard.sqlite'))
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repository_url TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scan_preflights (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
          created_at TEXT NOT NULL,
          lease_until TEXT,
          finished_at TEXT,
          result_json TEXT,
          error TEXT
        );

        CREATE INDEX IF NOT EXISTS scan_preflights_project_created
          ON scan_preflights(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS scan_preflights_status_created
          ON scan_preflights(status, created_at);
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  onModuleDestroy(): void {
    this.db.close()
  }

  ping(): void {
    this.db.prepare('SELECT 1').get()
  }

  listProjects(): Project[] {
    return this.db.prepare(`
      SELECT ${projectColumns} FROM projects ORDER BY created_at DESC, id
    `).all() as unknown as Project[]
  }

  hasProject(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined
  }

  createProject(input: CreateProjectInput): Project {
    const project = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.db.prepare(`
      INSERT INTO projects (id, name, repository_url, created_at) VALUES (?, ?, ?, ?)
    `).run(project.id, project.name, project.repositoryUrl, project.createdAt)
    return project
  }

  listPreflights(projectId: string): ScanPreflight[] {
    const rows = this.db.prepare(`
      SELECT ${jobColumns} FROM scan_preflights WHERE project_id = ?
      ORDER BY created_at DESC, id LIMIT 30
    `).all(projectId) as unknown as JobRow[]
    return rows.map(readJob)
  }

  enqueuePreflight(projectId: string): ScanPreflight {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO scan_preflights (id, project_id, status, created_at) VALUES (?, ?, 'queued', ?)
    `).run(id, projectId, createdAt)
    return { id, projectId, createdAt, status: 'queued', finishedAt: null, result: null, error: null }
  }

  claimPreflight(now: string, leaseUntil: string): { id: string } | undefined {
    this.db.prepare(`
      UPDATE scan_preflights
      SET status = 'failed', finished_at = ?, error = '检查进程中断或处理超时，请重新提交。',
          lease_until = NULL
      WHERE status = 'running' AND lease_until <= ?
    `).run(now, now)
    return this.db.prepare(`
      UPDATE scan_preflights
      SET status = 'running', lease_until = ?
      WHERE id = (
        SELECT id FROM scan_preflights WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
      )
      RETURNING id
    `).get(leaseUntil) as { id: string } | undefined
  }

  finishPreflight(id: string, result: ScanEnvironment | null, error: string | null): void {
    const finishedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE scan_preflights
      SET status = ?, finished_at = ?, result_json = ?, error = ?, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_until > ?
    `).run(
      result === null ? 'failed' : 'succeeded',
      finishedAt,
      result === null ? null : JSON.stringify(result),
      error,
      id,
      finishedAt,
    )
  }
}
