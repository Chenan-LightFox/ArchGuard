import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CreateProjectInput,
  ArchitectureRules,
  PlanDraft,
  PlanVersion,
  PlanVersionSummary,
  Project,
  RepositoryScan,
  RepositoryScanDetail,
  RepositoryScanResult,
  ScanEnvironment,
  ScanPreflight,
} from '@archguard/contracts'

const projectColumns = 'id, name, repository_url AS repositoryUrl, created_at AS createdAt'
const jobColumns = `
  id, project_id AS projectId, status, created_at AS createdAt,
  finished_at AS finishedAt, result_json AS resultJson, error
`

type JobRow = Omit<ScanPreflight, 'result'> & { resultJson: string | null }
const scanColumns = `
  id, project_id AS projectId, ref, status, created_at AS createdAt,
  finished_at AS finishedAt, summary_json AS summaryJson, error
`

type ScanRow = Omit<RepositoryScan, 'summary'> & { summaryJson: string | null }

function readScan(row: ScanRow): RepositoryScan {
  const { summaryJson, ...scan } = row
  return { ...scan, summary: summaryJson === null ? null : JSON.parse(summaryJson) }
}

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

        CREATE TABLE IF NOT EXISTS repository_scans (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          ref TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
          created_at TEXT NOT NULL,
          lease_until TEXT,
          finished_at TEXT,
          summary_json TEXT,
          result_json TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS repository_scans_project_created
          ON repository_scans(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS repository_scans_status_created
          ON repository_scans(status, created_at);

        CREATE TABLE IF NOT EXISTS scan_rule_configs (
          scan_id TEXT PRIMARY KEY REFERENCES repository_scans(id),
          rules_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plan_versions (
          project_id TEXT NOT NULL REFERENCES projects(id),
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          PRIMARY KEY(project_id, version)
        );
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

  getProject(id: string): Project | undefined {
    return this.db.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as Project | undefined
  }

  listScans(projectId: string): RepositoryScan[] {
    const rows = this.db.prepare(`
      SELECT ${scanColumns} FROM repository_scans
      WHERE project_id = ? ORDER BY created_at DESC, id LIMIT 30
    `).all(projectId) as unknown as ScanRow[]
    return rows.map(readScan)
  }

  getScan(projectId: string, scanId: string): RepositoryScanDetail | undefined {
    const row = this.db.prepare(`
      SELECT ${scanColumns}, result_json AS resultJson FROM repository_scans WHERE project_id = ? AND id = ?
    `).get(projectId, scanId) as (ScanRow & { resultJson: string | null }) | undefined
    if (!row) return undefined
    const { resultJson, ...scan } = row
    return { ...readScan(scan), result: resultJson === null ? null : JSON.parse(resultJson) }
  }

  enqueueScan(projectId: string, ref: string, rules: ArchitectureRules): RepositoryScan {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        INSERT INTO repository_scans (id, project_id, ref, status, created_at) VALUES (?, ?, ?, 'queued', ?)
        RETURNING ${scanColumns}
      `).get(id, projectId, ref, createdAt) as unknown as ScanRow
      this.db.prepare('INSERT INTO scan_rule_configs VALUES (?, ?)').run(id, JSON.stringify(rules))
      this.db.exec('COMMIT')
      return readScan(row)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  claimScan(now: string, leaseUntil: string): { id: string; ref: string; repositoryUrl: string; rules: ArchitectureRules } | undefined {
    this.db.prepare(`
      UPDATE repository_scans
      SET status = 'failed', finished_at = ?, error = '扫描进程中断或处理超时，请重新提交。', lease_until = NULL
      WHERE status = 'running' AND lease_until <= ?
    `).run(now, now)
    const row = this.db.prepare(`
      UPDATE repository_scans SET status = 'running', lease_until = ?
      WHERE id = (SELECT id FROM repository_scans WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)
      RETURNING id, ref, (SELECT repository_url FROM projects WHERE projects.id = project_id) AS repositoryUrl,
        (SELECT rules_json FROM scan_rule_configs WHERE scan_id = repository_scans.id) AS rulesJson
    `).get(leaseUntil) as { id: string; ref: string; repositoryUrl: string; rulesJson: string | null } | undefined
    if (!row) return undefined
    const { rulesJson, ...scan } = row
    return { ...scan, rules: rulesJson ? JSON.parse(rulesJson) : { layers: [], allowed: [] } }
  }

  finishScan(id: string, result: RepositoryScanResult | null, error: string | null): void {
    const finishedAt = new Date().toISOString()
    const summary = result && {
      commit: result.commit,
      files: result.files.length,
      dependencies: result.dependencies.length,
      unresolved: result.unresolved.length,
    }
    this.db.prepare(`
      UPDATE repository_scans SET status = ?, finished_at = ?, summary_json = ?, result_json = ?,
        error = ?, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_until > ?
    `).run(
      result ? 'succeeded' : 'failed', finishedAt, summary && JSON.stringify(summary),
      result && JSON.stringify(result), error, id, finishedAt,
    )
  }

  createProject(input: CreateProjectInput): Project {
    const project = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.db.prepare(`
      INSERT INTO projects (id, name, repository_url, created_at) VALUES (?, ?, ?, ?)
    `).run(project.id, project.name, project.repositoryUrl, project.createdAt)
    return project
  }

  createPlan(projectId: string, plan: PlanDraft): PlanVersion {
    const createdAt = new Date().toISOString()
    const { version } = this.db.prepare(`
      INSERT INTO plan_versions (project_id, version, created_at, metrics_json, plan_json)
      SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM plan_versions WHERE project_id = ?
      RETURNING version
    `).get(projectId, createdAt, JSON.stringify(plan.metrics), JSON.stringify(plan), projectId) as { version: number }
    return { ...plan, version, createdAt }
  }

  listPlans(projectId: string): PlanVersionSummary[] {
    const rows = this.db.prepare(`
      SELECT version, created_at AS createdAt, metrics_json AS metricsJson FROM plan_versions
      WHERE project_id = ? ORDER BY version DESC
    `).all(projectId) as unknown as (Omit<PlanVersionSummary, 'metrics'> & { metricsJson: string })[]
    return rows.map(({ metricsJson, ...row }) => ({ ...row, metrics: JSON.parse(metricsJson) }))
  }

  getPlan(projectId: string, version: number): PlanVersion | undefined {
    const row = this.db.prepare(`
      SELECT created_at AS createdAt, plan_json AS planJson FROM plan_versions WHERE project_id = ? AND version = ?
    `).get(projectId, version) as { createdAt: string; planJson: string } | undefined
    if (row) return { ...JSON.parse(row.planJson), version, createdAt: row.createdAt }
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
