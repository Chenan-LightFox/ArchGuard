import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AnalysisDraft,
  AnalysisRevision,
  ArchitectureComparison,
  ApprovalDecision,
  ApprovalResult,
  CoverageReview,
  ChangeRequest,
  ChangeSnapshot,
  ChangeSubmission,

  ChangeAnalysis,
  ChangeAnalysisInput,
  ChangeAnalysisResult,
  ChangeAnalysisSummary,
  CreateProjectInput,
  CreateChangeRequestInput,
  DecideInput,
  DeferredItem,
  ArchitectureRules,
  ImplementationCheck,
  ImplementationCheckInput,
  ImplementationEvidence,
  PlanDraft,
  PlanVersion,
  PlanVersionSummary,
  Project,
  RequirementAcceptance,
  RepositoryScan,
  RepositoryScanDetail,
  RepositoryScanResult,
  ScanEnvironment,
  ScanPreflight,
  ScenarioDraft,
  ScenarioRevision,
  UpdateChangeRequestInput,
} from '@archguard/contracts'
import type { Actor } from '../changes/actor'
import { fail } from '../changes/errors'
import { recomputePlan } from '../plans/build-plan'
import { compareArchitecture } from '../architecture/rules'

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

const changeColumns = `
  id, project_id AS projectId, scan_id AS scanId, plan_version AS planVersion,
  status, created_at AS createdAt, finished_at AS finishedAt, description,
  result_json AS resultJson, error
`
const changeSummaryColumns = `
  id, project_id AS projectId, scan_id AS scanId, plan_version AS planVersion,
  status, created_at AS createdAt, finished_at AS finishedAt, description, error
`
type ChangeRow = Omit<ChangeAnalysis, 'result'> & { resultJson: string | null }

function readChange(row: ChangeRow): ChangeAnalysis {
  const { resultJson, ...analysis } = row
  return { ...analysis, result: resultJson === null ? null : JSON.parse(resultJson) }
}

function readScan(row: ScanRow): RepositoryScan {
  const { summaryJson, ...scan } = row
  return { ...scan, summary: summaryJson === null ? null : JSON.parse(summaryJson) }
}

function readJob(row: JobRow): ScanPreflight {
  const { resultJson, ...job } = row
  return { ...job, result: resultJson === null ? null : JSON.parse(resultJson) }
}

const changeRequestColumns = `
  id, project_id AS projectId, title, description, requester_id AS requesterId,
  draft_revision AS draftRevision, status, base_plan_version AS basePlanVersion,
  base_scan_id AS baseScanId, created_at AS createdAt, updated_at AS updatedAt,
  submitted_at AS submittedAt, decided_at AS decidedAt
`

type ChangeRequestRow = Omit<ChangeRequest, never>

const analysisColumns = `
  id, change_request_id AS changeRequestId, change_request_revision AS changeRequestRevision,
  revision, baseline_plan_version AS baselinePlanVersion,
  baseline_scan_id AS baselineScanId, confirmed_mappings_json AS confirmedMappingsJson,
  impact_tasks_json AS impactTasksJson, impact_paths_json AS impactPathsJson,
  evidence_refs_json AS evidenceRefsJson, open_items_json AS openItemsJson,
  confirmed_by AS confirmedBy, confirmed_at AS confirmedAt, created_at AS createdAt
`

type AnalysisRow = Omit<AnalysisRevision, 'confirmedMappings' | 'impactTasks' | 'impactPaths' | 'evidenceRefs' | 'openItems'> & {
  confirmedMappingsJson: string
  impactTasksJson: string
  impactPathsJson: string
  evidenceRefsJson: string
  openItemsJson: string
}

function readAnalysis(row: AnalysisRow): AnalysisRevision {
  const { confirmedMappingsJson, impactTasksJson, impactPathsJson, evidenceRefsJson, openItemsJson, ...rest } = row
  return {
    ...rest,
    confirmedMappings: JSON.parse(confirmedMappingsJson),
    impactTasks: JSON.parse(impactTasksJson),
    impactPaths: JSON.parse(impactPathsJson),
    evidenceRefs: JSON.parse(evidenceRefsJson),
    openItems: JSON.parse(openItemsJson),
  }
}

const scenarioColumns = `
  id, change_request_id AS changeRequestId, change_request_revision AS changeRequestRevision,
  revision, analysis_revision_id AS analysisRevisionId,
  baseline_plan_version AS baselinePlanVersion, baseline_scan_id AS baselineScanId,
  calculation_rule_version AS calculationRuleVersion, scenarios_json AS scenariosJson, created_at AS createdAt
`

type ScenarioRow = Omit<ScenarioRevision, 'scenarios'> & {
  scenariosJson: string
}

function readScenario(row: ScenarioRow): ScenarioRevision {
  const { scenariosJson, ...rest } = row
  return { ...rest, scenarios: JSON.parse(scenariosJson) }
}

const submissionColumns = `
  id, change_request_id AS changeRequestId, revision, base_plan_version AS basePlanVersion,
  base_scan_id AS baseScanId, base_scan_commit AS baseScanCommit,
  analysis_revision_id AS analysisRevisionId, scenario_revision_id AS scenarioRevisionId,
  selected_kind AS selectedKind,
  requester_id AS requesterId, snapshot_json AS snapshotJson, created_at AS createdAt
`

type SubmissionRow = Omit<ChangeSubmission, 'snapshot'> & {
  snapshotJson: string
}

function readSubmission(row: SubmissionRow): ChangeSubmission {
  const { snapshotJson, ...rest } = row
  return { ...rest, snapshot: JSON.parse(snapshotJson) }
}

const decisionColumns = `
  id, submission_id AS submissionId, approver_id AS approverId, decision, comment, created_at AS createdAt,
  published_plan_version AS publishedPlanVersion, deferred_item_id AS deferredItemId,
  idempotency_key AS idempotencyKey, request_fingerprint AS requestFingerprint
`

const deferredColumns = `
  id, project_id AS projectId, change_request_id AS changeRequestId, submission_id AS submissionId,
  decision_id AS decisionId, scope_json AS scopeJson, future_estimate_json AS futureEstimateJson,
  priority, scheduling_status AS schedulingStatus, created_at AS createdAt, scheduled_at AS scheduledAt
`

type DeferredRow = Omit<DeferredItem, 'scope' | 'futureEstimate'> & {
  scopeJson: string
  futureEstimateJson: string | null
}

function readDeferred(row: DeferredRow): DeferredItem {
  const { scopeJson, futureEstimateJson, ...rest } = row
  return { ...rest, scope: JSON.parse(scopeJson), futureEstimate: futureEstimateJson === null ? null : JSON.parse(futureEstimateJson) }
}

const evidenceColumns = `
  id, implementation_check_id AS implementationCheckId, revision, command,
  passed, executed_at AS executedAt, output_summary AS outputSummary,
  source, recorded_by AS recordedBy, created_at AS createdAt
`

type EvidenceRow = Omit<ImplementationEvidence, 'passed'> & { passed: number }

function readEvidence(row: EvidenceRow): ImplementationEvidence {
  return { ...row, passed: row.passed === 1 }
}

const implementationCheckColumns = `
  id, change_request_id AS changeRequestId, submission_id AS submissionId, revision, status,
  implementation_commit AS implementationCommit, pre_scan_id AS preScanId, post_scan_id AS postScanId,
  requirement_acceptance_json AS requirementAcceptanceJson,
  coverage_review_json AS coverageReviewJson,
  recorded_by AS recordedBy, created_at AS createdAt
`

type ImplementationCheckRow = Omit<ImplementationCheck, 'requirementAcceptance' | 'coverageReview' | 'evidence'> & {
  requirementAcceptanceJson: string | null
  coverageReviewJson: string | null
}

function readImplementationCheck(row: ImplementationCheckRow): Omit<ImplementationCheck, 'evidence'> {
  const { requirementAcceptanceJson, coverageReviewJson, ...rest } = row
  return {
    ...rest,
    requirementAcceptance: requirementAcceptanceJson === null ? null : JSON.parse(requirementAcceptanceJson) as RequirementAcceptance,
    coverageReview: coverageReviewJson === null ? null : JSON.parse(coverageReviewJson) as CoverageReview,
  }
}

export class SqliteStore {
  private readonly db: DatabaseSync

  constructor() {
    const dataDir = resolve(process.env.ARCHGUARD_DATA_DIR || resolve(__dirname, '../../../../data'))
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(resolve(dataDir, 'archguard.sqlite'))
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = OFF;')
    try {
      this.db.exec('BEGIN IMMEDIATE;')
      try {
        this.db.exec(`
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
          repository_url TEXT NOT NULL,
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

        CREATE TABLE IF NOT EXISTS change_requests (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          draft_revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
          base_plan_version INTEGER NOT NULL,
          base_scan_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          decided_at TEXT
        );
        CREATE INDEX IF NOT EXISTS change_requests_project_created
          ON change_requests(project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS analysis_revisions (
          id TEXT PRIMARY KEY,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          change_request_revision INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL,
          baseline_plan_version INTEGER NOT NULL,
          baseline_scan_id TEXT NOT NULL,
          confirmed_mappings_json TEXT NOT NULL,
          impact_tasks_json TEXT NOT NULL,
          impact_paths_json TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          open_items_json TEXT NOT NULL,
          confirmed_by TEXT,
          confirmed_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(change_request_id, revision)
        );

        CREATE TABLE IF NOT EXISTS scenario_revisions (
          id TEXT PRIMARY KEY,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          change_request_revision INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL,
          analysis_revision_id TEXT NOT NULL,
          baseline_plan_version INTEGER NOT NULL,
          baseline_scan_id TEXT NOT NULL,
          calculation_rule_version TEXT NOT NULL,
          scenarios_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(change_request_id, revision)
        );

        CREATE TABLE IF NOT EXISTS change_submissions (
          id TEXT PRIMARY KEY,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          revision INTEGER NOT NULL,
          base_plan_version INTEGER NOT NULL,
          base_scan_id TEXT NOT NULL,
          base_scan_commit TEXT NOT NULL,
          analysis_revision_id TEXT NOT NULL,
          scenario_revision_id TEXT NOT NULL,
          selected_kind TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(change_request_id, revision)
        );

        CREATE TABLE IF NOT EXISTS approval_decisions (
          id TEXT PRIMARY KEY,
          submission_id TEXT NOT NULL UNIQUE REFERENCES change_submissions(id),
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          approver_id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
          comment TEXT NOT NULL,
          created_at TEXT NOT NULL,
          published_plan_version INTEGER,
          deferred_item_id TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_fingerprint TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deferred_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          submission_id TEXT NOT NULL REFERENCES change_submissions(id),
          decision_id TEXT NOT NULL REFERENCES approval_decisions(id),
          scope_json TEXT NOT NULL,
          future_estimate_json TEXT,
          priority TEXT NOT NULL,
          scheduling_status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          scheduled_at TEXT
        );

        CREATE TABLE IF NOT EXISTS implementation_checks (
          id TEXT PRIMARY KEY,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          submission_id TEXT NOT NULL REFERENCES change_submissions(id),
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'waiting_scheduling', 'completed')),
          implementation_commit TEXT,
          pre_scan_id TEXT NOT NULL,
          post_scan_id TEXT,
          requirement_acceptance_json TEXT,
          coverage_review_json TEXT,
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(submission_id, revision)
        );

        CREATE TABLE IF NOT EXISTS implementation_evidences (
          id TEXT PRIMARY KEY,
          implementation_check_id TEXT NOT NULL REFERENCES implementation_checks(id),
          revision INTEGER NOT NULL,
          command TEXT NOT NULL,
          passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
          executed_at TEXT,
          output_summary TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'ci')),
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(implementation_check_id, revision)
        );

        CREATE TABLE IF NOT EXISTS change_analyses (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          scan_id TEXT NOT NULL REFERENCES repository_scans(id),
          plan_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
          created_at TEXT NOT NULL,
          lease_until TEXT,
          finished_at TEXT,
          description TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          FOREIGN KEY (project_id, plan_version) REFERENCES plan_versions(project_id, version)
        );
        CREATE INDEX IF NOT EXISTS change_analyses_project_created
          ON change_analyses(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS change_analyses_status_created
          ON change_analyses(status, created_at);
      `)
      const scanTableColumns = this.db.prepare('PRAGMA table_info(repository_scans)').all()
      if (!scanTableColumns.some((column) => column.name === 'repository_url')) {
        this.db.exec(`
          ALTER TABLE repository_scans ADD COLUMN repository_url TEXT NOT NULL DEFAULT '';
          UPDATE repository_scans SET repository_url = (
            SELECT repository_url FROM projects WHERE id = repository_scans.project_id
          );
        `)
      }
      const planColumns = this.db.prepare('PRAGMA table_info(plan_versions)').all()
      const planLineageColumns: [string, string][] = [
        ['parent_version', 'INTEGER'],
        ['source_change_request_id', 'TEXT'],
        ['source_submission_id', 'TEXT'],
        ['source_decision_id', 'TEXT'],
      ]
      for (const [column, type] of planLineageColumns) {
        if (!planColumns.some((existing) => existing.name === column)) {
          this.db.exec(`ALTER TABLE plan_versions ADD COLUMN ${column} ${type}`)
        }
      }
      this.migrateSchema()
      this.db.exec('COMMIT;')
      } catch (error) {
        try { this.db.exec('ROLLBACK;') } catch { /* 无活动事务 */ }
        throw error
      }
    } catch (error) {
      this.db.close()
      throw error
    } finally {
      try { this.db.exec('PRAGMA foreign_keys = ON;') } catch { /* 连接可能已关闭 */ }
    }
  }

  private migrateSchema(): void {
    for (const table of ['analysis_revisions', 'scenario_revisions']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all()
      if (!columns.some((column) => column.name === 'change_request_revision')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN change_request_revision INTEGER NOT NULL DEFAULT 0`)
      }
    }
    const checkColumns = this.db.prepare('PRAGMA table_info(implementation_checks)').all()
    const isLegacy = checkColumns.length > 0 &&
      (!checkColumns.some((column) => column.name === 'revision') || checkColumns.some((column) => column.name === 'updated_at'))
    if (isLegacy) {
      this.db.exec(`
        DROP TABLE IF EXISTS implementation_checks_new;
        CREATE TABLE implementation_checks_new (
          id TEXT PRIMARY KEY,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id),
          submission_id TEXT NOT NULL REFERENCES change_submissions(id),
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'waiting_scheduling', 'completed')),
          implementation_commit TEXT,
          pre_scan_id TEXT NOT NULL,
          post_scan_id TEXT,
          requirement_acceptance_json TEXT,
          coverage_review_json TEXT,
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(submission_id, revision)
        );
        INSERT INTO implementation_checks_new (
          id, change_request_id, submission_id, revision, status, implementation_commit,
          pre_scan_id, post_scan_id, requirement_acceptance_json, coverage_review_json,
          recorded_by, created_at
        ) SELECT
          id, change_request_id, submission_id, 1, status, implementation_commit,
          pre_scan_id, post_scan_id,
          CASE WHEN requirement_acceptance IS NULL OR requirement_acceptance = ''
            THEN NULL
            ELSE json_object('verdict', 'pending', 'summary', requirement_acceptance)
          END,
          NULL, recorded_by, created_at
        FROM implementation_checks;
        DROP TABLE implementation_checks;
        ALTER TABLE implementation_checks_new RENAME TO implementation_checks;
      `)
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

  private scanRepositoryUrl(projectId: string, scanId: string): string | null {
    const row = this.db.prepare(`
      SELECT repository_url AS repositoryUrl FROM repository_scans WHERE project_id = ? AND id = ?
    `).get(projectId, scanId) as { repositoryUrl: string } | undefined
    const value = row?.repositoryUrl ?? ''
    return value === '' ? null : value
  }

  enqueueScan(projectId: string, repositoryUrl: string, ref: string, rules: ArchitectureRules): RepositoryScan {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        INSERT INTO repository_scans (id, project_id, repository_url, ref, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)
        RETURNING ${scanColumns}
      `).get(id, projectId, repositoryUrl, ref, createdAt) as unknown as ScanRow
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
      RETURNING id, ref, repository_url AS repositoryUrl,
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

  updateProject(id: string, input: CreateProjectInput): Project | undefined {
    return this.db.prepare(`
      UPDATE projects SET name = ?, repository_url = ? WHERE id = ?
      RETURNING ${projectColumns}
    `).get(input.name, input.repositoryUrl, id) as Project | undefined
  }

  deleteProject(id: string): boolean {
    const changeRequests = this.db.prepare('SELECT COUNT(*) AS count FROM change_requests WHERE project_id = ?')
      .get(id) as { count: number }
    if (changeRequests.count > 0) {
      fail('STATE_CONFLICT', 409, '该项目存在变更申请与审批历史，不能删除。请保留历史或将项目归档。')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const stillPresent = this.db.prepare('SELECT COUNT(*) AS count FROM change_requests WHERE project_id = ?')
        .get(id) as { count: number }
      if (stillPresent.count > 0) fail('STATE_CONFLICT', 409, '该项目存在变更申请与审批历史，不能删除。')
      this.db.prepare(`
        DELETE FROM scan_rule_configs
        WHERE scan_id IN (SELECT id FROM repository_scans WHERE project_id = ?)
      `).run(id)
      this.db.prepare('DELETE FROM change_analyses WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM repository_scans WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM scan_preflights WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM plan_versions WHERE project_id = ?').run(id)
      const { changes } = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return changes > 0
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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

  listChangeAnalyses(projectId: string): ChangeAnalysisSummary[] {
    const rows = this.db.prepare(`
      SELECT ${changeSummaryColumns} FROM change_analyses
      WHERE project_id = ? ORDER BY created_at DESC, id LIMIT 30
    `).all(projectId) as unknown as ChangeAnalysisSummary[]
    return rows
  }

  getChangeAnalysis(projectId: string, id: string): ChangeAnalysis | undefined {
    const row = this.db.prepare(`
      SELECT ${changeColumns} FROM change_analyses WHERE project_id = ? AND id = ?
    `).get(projectId, id) as ChangeRow | undefined
    return row && readChange(row)
  }

  enqueueChangeAnalysis(projectId: string, input: ChangeAnalysisInput): ChangeAnalysis {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const row = this.db.prepare(`
      INSERT INTO change_analyses
        (id, project_id, scan_id, plan_version, status, created_at, description)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
      RETURNING ${changeColumns}
    `).get(id, projectId, input.scanId, input.planVersion, createdAt, input.description) as unknown as ChangeRow
    return readChange(row)
  }

  claimChangeAnalysis(now: string, leaseUntil: string):
    { id: string; projectId: string; scanId: string; planVersion: number; description: string } | undefined {
    this.db.prepare(`
      UPDATE change_analyses
      SET status = 'failed', finished_at = ?, error = '分析进程中断或处理超时，请重新提交。', lease_until = NULL
      WHERE status = 'running' AND lease_until <= ?
    `).run(now, now)
    return this.db.prepare(`
      UPDATE change_analyses SET status = 'running', lease_until = ?
      WHERE id = (
        SELECT id FROM change_analyses WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
      )
      RETURNING id, project_id AS projectId, scan_id AS scanId,
        plan_version AS planVersion, description
    `).get(leaseUntil) as {
      id: string; projectId: string; scanId: string; planVersion: number; description: string
    } | undefined
  }

  finishChangeAnalysis(id: string, result: ChangeAnalysisResult | null, error: string | null): void {
    const finishedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE change_analyses SET status = ?, finished_at = ?, result_json = ?, error = ?, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_until > ?
    `).run(result ? 'succeeded' : 'failed', finishedAt, result && JSON.stringify(result), error, id, finishedAt)
  }

  updateChangeAnalysisResult(id: string, result: ChangeAnalysisResult): ChangeAnalysis | undefined {
    const row = this.db.prepare(`
      UPDATE change_analyses SET result_json = ?
      WHERE id = ? AND status = 'succeeded'
      RETURNING ${changeColumns}
    `).get(JSON.stringify(result), id) as unknown as ChangeRow | undefined
    return row && readChange(row)
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

  // ===== 角色 D：变更申请、分析、方案、提交、审批、实施 =====

  private requireActor(actor: Actor | undefined, projectId: string): Actor {
    if (!actor) fail('NOT_AUTHENTICATED', 401, '缺少认证信息或演示令牌无效。')
    if (actor.projects !== 'all' && !actor.projects.has(projectId)) {
      fail('FORBIDDEN', 403, '当前身份不是该项目成员。')
    }
    return actor
  }

  private requireMember(actor: Actor | undefined, projectId: string): Actor {
    const member = this.requireActor(actor, projectId)
    if (!member.roles.has('member')) fail('FORBIDDEN', 403, '当前身份没有项目成员权限。')
    return member
  }

  private requireApprover(actor: Actor | undefined, projectId: string): Actor {
    const approver = this.requireActor(actor, projectId)
    if (!approver.roles.has('approver')) fail('FORBIDDEN', 403, '当前身份没有审批权限。')
    return approver
  }

  authorizeMember(actor: Actor | undefined, projectId: string): Actor {
    return this.requireMember(actor, projectId)
  }

  private requireChangeRequest(projectId: string, changeId: string): ChangeRequest {
    const row = this.db.prepare(`
      SELECT ${changeRequestColumns} FROM change_requests WHERE project_id = ? AND id = ?
    `).get(projectId, changeId) as ChangeRequestRow | undefined
    if (!row) fail('NOT_FOUND', 404, '找不到该变更申请。')
    return row
  }

  private getPlanDraft(projectId: string, version: number): PlanDraft | undefined {
    const row = this.db.prepare(`
      SELECT plan_json AS planJson FROM plan_versions WHERE project_id = ? AND version = ?
    `).get(projectId, version) as { planJson: string } | undefined
    return row ? JSON.parse(row.planJson) : undefined
  }

  private latestPlanVersion(projectId: string): number | undefined {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM plan_versions WHERE project_id = ?')
      .get(projectId) as { version: number | null } | undefined
    return row?.version ?? undefined
  }

  private validateBaseline(projectId: string, planVersion: number, scanId: string): { plan: PlanDraft } {
    const plan = this.getPlanDraft(projectId, planVersion)
    if (!plan) fail('NOT_FOUND', 404, '找不到基线计划版本。')
    const scan = this.getScan(projectId, scanId)
    if (!scan) fail('NOT_FOUND', 404, '找不到基线扫描。')
    if (scan.status !== 'succeeded' || !scan.result) fail('VALIDATION_ERROR', 400, '基线扫描尚未成功完成。')
    return { plan }
  }

  listChangeRequests(projectId: string): ChangeRequest[] {
    return this.db.prepare(`
      SELECT ${changeRequestColumns} FROM change_requests WHERE project_id = ? ORDER BY created_at DESC, id
    `).all(projectId) as unknown as ChangeRequest[]
  }

  getChangeRequest(projectId: string, changeId: string): ChangeRequest | undefined {
    return this.db.prepare(`
      SELECT ${changeRequestColumns} FROM change_requests WHERE project_id = ? AND id = ?
    `).get(projectId, changeId) as ChangeRequest | undefined
  }

  createChangeRequest(projectId: string, actor: Actor | undefined, input: CreateChangeRequestInput): ChangeRequest {
    const member = this.requireMember(actor, projectId)
    if (!this.hasProject(projectId)) fail('NOT_FOUND', 404, '找不到该项目。')
    const title = typeof input?.title === 'string' ? input.title.trim() : ''
    const description = typeof input?.description === 'string' ? input.description.trim() : ''
    if (!title || title.length > 200) fail('VALIDATION_ERROR', 400, '变更标题应为 1 到 200 个字符。')
    if (description.length > 10_000) fail('VALIDATION_ERROR', 400, '变更描述过长。')
    if (!Number.isInteger(input.basePlanVersion) || input.basePlanVersion < 1) {
      fail('VALIDATION_ERROR', 400, '请提供有效的基线计划版本。')
    }
    if (typeof input.baseScanId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.baseScanId)) {
      fail('VALIDATION_ERROR', 400, '请提供有效的基线扫描 ID。')
    }
    this.validateBaseline(projectId, input.basePlanVersion, input.baseScanId)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO change_requests (
        id, project_id, title, description, requester_id, draft_revision, status,
        base_plan_version, base_scan_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?)
    `).run(id, projectId, title, description, member.id, input.basePlanVersion, input.baseScanId, createdAt, createdAt)
    return this.requireChangeRequest(projectId, id)
  }

  updateChangeRequest(
    projectId: string,
    changeId: string,
    actor: Actor | undefined,
    input: UpdateChangeRequestInput,
  ): ChangeRequest {
    const member = this.requireMember(actor, projectId)
    const changeRequest = this.requireChangeRequest(projectId, changeId)
    if (changeRequest.status !== 'draft' && changeRequest.status !== 'rejected') {
      fail('STATE_CONFLICT', 409, '提交或审批后的变更申请不能修改。')
    }
    if (!Number.isInteger(input?.expectedRevision)) {
      fail('VALIDATION_ERROR', 400, '请提供 expectedRevision。')
    }
    const title = input.title === undefined ? changeRequest.title : (typeof input.title === 'string' ? input.title.trim() : '')
    const description = input.description === undefined ? changeRequest.description : (typeof input.description === 'string' ? input.description.trim() : '')
    if (!title || title.length > 200) fail('VALIDATION_ERROR', 400, '变更标题应为 1 到 200 个字符。')
    if (description.length > 10_000) fail('VALIDATION_ERROR', 400, '变更描述过长。')
    const basePlanVersion = input.basePlanVersion ?? changeRequest.basePlanVersion
    const baseScanId = input.baseScanId ?? changeRequest.baseScanId
    if (!Number.isInteger(basePlanVersion) || basePlanVersion < 1) fail('VALIDATION_ERROR', 400, '请提供有效的基线计划版本。')
    if (typeof baseScanId !== 'string') fail('VALIDATION_ERROR', 400, '请提供有效的基线扫描 ID。')
    this.validateBaseline(projectId, basePlanVersion, baseScanId)
    const updatedAt = new Date().toISOString()
    const { changes } = this.db.prepare(`
      UPDATE change_requests
      SET title = ?, description = ?, base_plan_version = ?, base_scan_id = ?,
          draft_revision = draft_revision + 1, status = 'draft', updated_at = ?,
          submitted_at = NULL, decided_at = NULL
      WHERE id = ? AND project_id = ?
        AND draft_revision = ? AND status IN ('draft', 'rejected')
    `).run(title, description, basePlanVersion, baseScanId, updatedAt, changeId, projectId, input.expectedRevision)
    if (changes !== 1) {
      fail('REVISION_CONFLICT', 409, '草稿修订号冲突或申请状态不允许修改。')
    }
    void member
    return this.requireChangeRequest(projectId, changeId)
  }

  listAnalysisRevisions(projectId: string, changeId: string): AnalysisRevision[] {
    this.requireChangeRequest(projectId, changeId)
    const rows = this.db.prepare(`
      SELECT ${analysisColumns} FROM analysis_revisions WHERE change_request_id = ? ORDER BY revision DESC
    `).all(changeId) as unknown as AnalysisRow[]
    return rows.map(readAnalysis)
  }

  getAnalysisRevision(projectId: string, changeId: string, analysisId: string): AnalysisRevision | undefined {
    const row = this.db.prepare(`
      SELECT ${analysisColumns} FROM analysis_revisions WHERE change_request_id = ? AND id = ?
    `).get(changeId, analysisId) as AnalysisRow | undefined
    return row ? readAnalysis(row) : undefined
  }

  private latestAnalysisRevision(changeId: string): AnalysisRevision | undefined {
    const row = this.db.prepare(`
      SELECT ${analysisColumns} FROM analysis_revisions WHERE change_request_id = ? ORDER BY revision DESC LIMIT 1
    `).get(changeId) as AnalysisRow | undefined
    return row ? readAnalysis(row) : undefined
  }

  saveAnalysisRevision(projectId: string, changeId: string, actor: Actor | undefined, draft: AnalysisDraft): AnalysisRevision {
    this.requireMember(actor, projectId)
    const changeRequest = this.requireChangeRequest(projectId, changeId)
    if (changeRequest.status !== 'draft') fail('STATE_CONFLICT', 409, '只有草稿状态的申请可以创建分析版本。')
    if (draft.baselinePlanVersion !== changeRequest.basePlanVersion || draft.baselineScanId !== changeRequest.baseScanId) {
      fail('VALIDATION_ERROR', 400, '分析版本必须基于申请冻结的基线和扫描。')
    }
    const baseline = this.getPlanDraft(projectId, draft.baselinePlanVersion)
    if (!baseline) fail('NOT_FOUND', 404, '找不到基线计划版本。')
    const taskIds = new Set(baseline.tasks.map((task) => task.id))
    if (!Array.isArray(draft.impactTasks) || !draft.impactTasks.length) fail('VALIDATION_ERROR', 400, '影响任务分类不能为空。')
    for (const impact of draft.impactTasks) {
      if (!taskIds.has(impact.taskId)) fail('VALIDATION_ERROR', 400, `影响任务引用了不存在的任务 ${impact.taskId}。`)
      if (!['change', 'review', 'schedule'].includes(impact.category)) fail('VALIDATION_ERROR', 400, '影响任务分类无效。')
    }
    for (const taskId of Object.keys(draft.confirmedMappings ?? {})) {
      if (!taskIds.has(taskId)) fail('VALIDATION_ERROR', 400, `确认映射引用了不存在的任务 ${taskId}。`)
    }
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const { revision } = this.db.prepare(`
      INSERT INTO analysis_revisions (
        id, change_request_id, change_request_revision, revision, baseline_plan_version, baseline_scan_id,
        confirmed_mappings_json, impact_tasks_json, impact_paths_json, evidence_refs_json,
        open_items_json, confirmed_by, confirmed_at, created_at
      ) SELECT ?, ?, ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM analysis_revisions WHERE change_request_id = ?
      RETURNING revision
    `).get(
      id, changeId, changeRequest.draftRevision, draft.baselinePlanVersion, draft.baselineScanId,
      JSON.stringify(draft.confirmedMappings ?? {}), JSON.stringify(draft.impactTasks),
      JSON.stringify(draft.impactPaths ?? []), JSON.stringify(draft.evidenceRefs ?? []),
      JSON.stringify(draft.openItems ?? []), draft.confirmedBy ?? null,
      draft.confirmedBy ? createdAt : null, createdAt, changeId,
    ) as { revision: number }
    return readAnalysis(this.db.prepare(`SELECT ${analysisColumns} FROM analysis_revisions WHERE id = ?`).get(id) as AnalysisRow)
  }

  listScenarioRevisions(projectId: string, changeId: string): ScenarioRevision[] {
    this.requireChangeRequest(projectId, changeId)
    const rows = this.db.prepare(`
      SELECT ${scenarioColumns} FROM scenario_revisions WHERE change_request_id = ? ORDER BY revision DESC
    `).all(changeId) as unknown as ScenarioRow[]
    return rows.map(readScenario)
  }

  getScenarioRevision(projectId: string, changeId: string, scenarioId: string): ScenarioRevision | undefined {
    const row = this.db.prepare(`
      SELECT ${scenarioColumns} FROM scenario_revisions WHERE change_request_id = ? AND id = ?
    `).get(changeId, scenarioId) as ScenarioRow | undefined
    return row ? readScenario(row) : undefined
  }

  private latestScenarioRevision(changeId: string): ScenarioRevision | undefined {
    const row = this.db.prepare(`
      SELECT ${scenarioColumns} FROM scenario_revisions WHERE change_request_id = ? ORDER BY revision DESC LIMIT 1
    `).get(changeId) as ScenarioRow | undefined
    return row ? readScenario(row) : undefined
  }

  saveScenarioRevision(projectId: string, changeId: string, actor: Actor | undefined, draft: ScenarioDraft): ScenarioRevision {
    this.requireMember(actor, projectId)
    const changeRequest = this.requireChangeRequest(projectId, changeId)
    if (changeRequest.status !== 'draft') fail('STATE_CONFLICT', 409, '只有草稿状态的申请可以创建方案版本。')
    const analysis = this.latestAnalysisRevision(changeId)
    if (!analysis) fail('STATE_CONFLICT', 409, '请先创建并确认分析版本。')
    if (analysis.changeRequestRevision !== changeRequest.draftRevision) {
      fail('STATE_CONFLICT', 409, '分析版本已过期，请基于当前申请修订重新分析。')
    }
    if (draft.analysisRevisionId !== analysis.id) fail('VALIDATION_ERROR', 400, '方案必须基于最新分析版本。')
    if (draft.baselinePlanVersion !== changeRequest.basePlanVersion || draft.baselineScanId !== changeRequest.baseScanId) {
      fail('VALIDATION_ERROR', 400, '方案必须基于申请冻结的基线和扫描。')
    }
    const baseline = this.getPlanDraft(projectId, draft.baselinePlanVersion)
    if (!baseline) fail('NOT_FOUND', 404, '找不到基线计划版本。')
    const kinds = ['accept', 'reduce', 'defer'] as const
    for (const kind of kinds) {
      const scheme = draft.scenarios[kind]
      if (!scheme) fail('VALIDATION_ERROR', 400, `缺少 ${kind} 方案。`)
      if (!scheme.estimationInput?.source || !scheme.estimationInput.ruleVersion || !scheme.estimationInput.basis) {
        fail('VALIDATION_ERROR', 400, `${kind} 方案缺少估算输入、来源或依据。`)
      }
      if (scheme.estimationInput.ruleVersion !== draft.calculationRuleVersion) {
        fail('VALIDATION_ERROR', 400, '三个方案必须使用相同的计算规则版本。')
      }
      const canonical = recomputePlan(scheme.candidatePlan)
      if (JSON.stringify(canonical.metrics) !== JSON.stringify(scheme.candidatePlan.metrics) ||
          JSON.stringify(canonical.metrics) !== JSON.stringify(scheme.metrics)) {
        fail('VALIDATION_ERROR', 400, `${kind} 方案的候选计划或指标未通过服务端重算校验。`)
      }
      const expected = {
        effortHours: canonical.metrics.effortHours - baseline.metrics.effortHours,
        durationDays: canonical.metrics.durationDays - baseline.metrics.durationDays,
        cost: canonical.metrics.cost - baseline.metrics.cost,
      }
      for (const field of ['effortHours', 'durationDays', 'cost'] as const) {
        if (Math.abs(scheme.deltas[field] - expected[field]) > 1e-6) {
          fail('VALIDATION_ERROR', 400, `${kind} 方案的增量与服务端重算不一致。`)
        }
      }
    }
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const { revision } = this.db.prepare(`
      INSERT INTO scenario_revisions (
        id, change_request_id, change_request_revision, revision, analysis_revision_id, baseline_plan_version,
        baseline_scan_id, calculation_rule_version, scenarios_json, created_at
      ) SELECT ?, ?, ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?, ?, ?, ?
        FROM scenario_revisions WHERE change_request_id = ?
      RETURNING revision
    `).get(
      id, changeId, changeRequest.draftRevision, draft.analysisRevisionId, draft.baselinePlanVersion, draft.baselineScanId,
      draft.calculationRuleVersion, JSON.stringify(draft.scenarios), createdAt, changeId,
    ) as { revision: number }
    return readScenario(this.db.prepare(`SELECT ${scenarioColumns} FROM scenario_revisions WHERE id = ?`).get(id) as ScenarioRow)
  }

  submitChangeRequest(
    projectId: string,
    changeId: string,
    actor: Actor | undefined,
    selectedKind: 'accept' | 'reduce' | 'defer',
  ): ChangeSubmission {
    const member = this.requireMember(actor, projectId)
    if (!['accept', 'reduce', 'defer'].includes(selectedKind)) fail('VALIDATION_ERROR', 400, '请选择有效的方案。')
    const id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 在写锁内重新读取，保证申请修订、基线、扫描、分析与方案和快照一致。
      const changeRequest = this.requireChangeRequest(projectId, changeId)
      if (changeRequest.status !== 'draft') fail('STATE_CONFLICT', 409, '只有草稿状态的申请可以提交。')
      const alreadySubmitted = this.db.prepare(`
        SELECT 1 FROM change_submissions WHERE change_request_id = ? AND revision = ?
      `).get(changeId, changeRequest.draftRevision)
      if (alreadySubmitted) fail('STATE_CONFLICT', 409, '该申请修订已经提交。')
      this.validateBaseline(projectId, changeRequest.basePlanVersion, changeRequest.baseScanId)
      if (this.latestPlanVersion(projectId) !== changeRequest.basePlanVersion) {
        fail('BASELINE_EXPIRED', 409, '基线计划已过期，请基于最新计划版本重算后重新提交。')
      }
      const analysis = this.latestAnalysisRevision(changeId)
      if (!analysis) fail('STATE_CONFLICT', 409, '提交前需要分析版本。')
      if (!analysis.confirmedBy || analysis.openItems.length) {
        fail('STATE_CONFLICT', 409, '必要映射尚未人工确认，或仍有待确认事项。')
      }
      if (analysis.changeRequestRevision !== changeRequest.draftRevision) {
        fail('STATE_CONFLICT', 409, '分析版本已过期，请基于当前申请修订重新分析。')
      }
      if (analysis.baselinePlanVersion !== changeRequest.basePlanVersion ||
          analysis.baselineScanId !== changeRequest.baseScanId) {
        fail('STATE_CONFLICT', 409, '分析版本与当前冻结的基线或扫描不一致。')
      }
      const scenarioRevision = this.latestScenarioRevision(changeId)
      if (!scenarioRevision) fail('STATE_CONFLICT', 409, '提交前需要三方案版本。')
      if (scenarioRevision.analysisRevisionId !== analysis.id) fail('STATE_CONFLICT', 409, '三方案与分析版本不一致。')
      if (scenarioRevision.changeRequestRevision !== changeRequest.draftRevision) {
        fail('STATE_CONFLICT', 409, '三方案版本已过期，请基于当前申请修订重新计算。')
      }
      if (scenarioRevision.baselinePlanVersion !== changeRequest.basePlanVersion ||
          scenarioRevision.baselineScanId !== changeRequest.baseScanId) {
        fail('STATE_CONFLICT', 409, '三方案与当前冻结的基线或扫描不一致。')
      }
      const selected = scenarioRevision.scenarios[selectedKind]
      const scan = this.getScan(projectId, changeRequest.baseScanId)!
      const architecture = scan.result?.architecture ?? null
      const snapshot: ChangeSnapshot = {
        request: { ...changeRequest, status: 'pending' },
        baseline: {
          planVersion: changeRequest.basePlanVersion,
          plan: this.getPlan(projectId, changeRequest.basePlanVersion) ?? null,
          scanId: changeRequest.baseScanId,
          repositoryUrl: this.scanRepositoryUrl(projectId, changeRequest.baseScanId),
          scanCommit: scan.result?.commit ?? null,
          analyzerVersion: scan.result?.analyzerVersion ?? null,
          ruleVersion: architecture?.ruleVersion ?? null,
          rules: architecture?.rules ?? null,
        },
        analysis,
        scenarioRevision,
        confirmedMappings: analysis.confirmedMappings,
        estimationBasis: selected.estimationInput.basis,
      }
      const snapshotJson = JSON.stringify(snapshot)
      const createdAt = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO change_submissions (
          id, change_request_id, revision, base_plan_version, base_scan_id, base_scan_commit,
          analysis_revision_id, scenario_revision_id, selected_kind, requester_id,
          snapshot_json, snapshot_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, changeId, changeRequest.draftRevision, changeRequest.basePlanVersion, changeRequest.baseScanId,
        scan.result!.commit, analysis.id, scenarioRevision.id, selectedKind, member.id,
        snapshotJson, createHash('sha256').update(snapshotJson).digest('hex'), createdAt,
      )
      const { changes } = this.db.prepare(`
        UPDATE change_requests SET status = 'pending', submitted_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND draft_revision = ? AND status = 'draft'
      `).run(createdAt, createdAt, changeId, projectId, changeRequest.draftRevision)
      if (changes !== 1) fail('REVISION_CONFLICT', 409, '申请修订已变化，请基于最新修订重新提交。')
      this.db.exec('COMMIT')
      return readSubmission(this.db.prepare(`SELECT ${submissionColumns} FROM change_submissions WHERE id = ?`).get(id) as SubmissionRow)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 事务可能已回滚或提交 */ }
      throw error
    }
  }

  listSubmissions(projectId: string, changeId: string): ChangeSubmission[] {
    this.requireChangeRequest(projectId, changeId)
    const rows = this.db.prepare(`
      SELECT ${submissionColumns} FROM change_submissions WHERE change_request_id = ? ORDER BY revision DESC
    `).all(changeId) as unknown as SubmissionRow[]
    return rows.map(readSubmission)
  }

  getSubmission(projectId: string, changeId: string, submissionId: string): ChangeSubmission | undefined {
    this.requireChangeRequest(projectId, changeId)
    const row = this.db.prepare(`
      SELECT ${submissionColumns} FROM change_submissions WHERE change_request_id = ? AND id = ?
    `).get(changeId, submissionId) as SubmissionRow | undefined
    return row ? readSubmission(row) : undefined
  }

  getLatestSubmission(projectId: string, changeId: string): ChangeSubmission | undefined {
    this.requireChangeRequest(projectId, changeId)
    const row = this.db.prepare(`
      SELECT ${submissionColumns} FROM change_submissions WHERE change_request_id = ? ORDER BY revision DESC LIMIT 1
    `).get(changeId) as SubmissionRow | undefined
    return row ? readSubmission(row) : undefined
  }

  private decisionResult(projectId: string, row: ApprovalDecision): ApprovalResult {
    const deferredItem = row.deferredItemId
      ? this.db.prepare(`SELECT ${deferredColumns} FROM deferred_items WHERE id = ?`).get(row.deferredItemId) as DeferredRow | undefined
      : undefined
    const publishedPlan = row.publishedPlanVersion === null || row.publishedPlanVersion === undefined
      ? null
      : this.getPlan(projectId, row.publishedPlanVersion) ?? null
    return {
      decision: row,
      publishedPlan,
      deferredItem: deferredItem ? readDeferred(deferredItem) : null,
    }
  }

  decideChangeRequest(
    projectId: string,
    changeId: string,
    actor: Actor | undefined,
    input: DecideInput,
  ): ApprovalResult {
    const approver = this.requireApprover(actor, projectId)
    if (!['approved', 'rejected'].includes(input?.decision)) fail('VALIDATION_ERROR', 400, '决定必须为 approved 或 rejected。')
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
      fail('VALIDATION_ERROR', 400, '请提供有效的幂等键。')
    }
    if (typeof input.submissionId !== 'string' || !input.submissionId.trim()) {
      fail('VALIDATION_ERROR', 400, '请提供 submissionId。')
    }
    if (typeof input.expectedSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash)) {
      fail('VALIDATION_ERROR', 400, '请提供 64 位十六进制 expectedSnapshotHash。')
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim() : ''
    if (comment.length > 10_000) fail('VALIDATION_ERROR', 400, '审批意见过长。')

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changeRequest = this.requireChangeRequest(projectId, changeId)
      const submissionRow = this.db.prepare(`
        SELECT ${submissionColumns}, snapshot_hash AS snapshotHash
        FROM change_submissions WHERE change_request_id = ? AND id = ?
      `).get(changeId, input.submissionId) as (SubmissionRow & { snapshotHash: string }) | undefined
      if (!submissionRow) fail('NOT_FOUND', 404, '找不到该提交。')
      const submission = readSubmission(submissionRow)
      if (input.expectedSnapshotHash !== submissionRow.snapshotHash) {
        fail('STATE_CONFLICT', 409, '预期快照摘要与提交不一致，请刷新后重试。')
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({
        changeId, submissionId: submission.id, snapshotHash: submissionRow.snapshotHash,
        decision: input.decision, comment, approverId: approver.id,
      })).digest('hex')

      const existingByKey = this.db.prepare(`
        SELECT ${decisionColumns} FROM approval_decisions WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as ApprovalDecision | undefined
      if (existingByKey) {
        if (existingByKey.requestFingerprint !== fingerprint) {
          fail('IDEMPOTENCY_CONFLICT', 409, '同一幂等键对应了不同的审批请求。')
        }
        const result = this.decisionResult(projectId, existingByKey)
        this.db.exec('COMMIT')
        return result
      }

      const existingBySubmission = this.db.prepare(`
        SELECT ${decisionColumns} FROM approval_decisions WHERE submission_id = ?
      `).get(submission.id) as ApprovalDecision | undefined
      if (existingBySubmission) fail('ALREADY_DECIDED', 409, '该提交已有最终决策。')
      if (changeRequest.status !== 'pending') fail('STATE_CONFLICT', 409, '申请当前不在待审批状态。')
      if (submission.revision !== changeRequest.draftRevision) {
        fail('STATE_CONFLICT', 409, '该提交不是当前有效的待审批版本。')
      }
      if (submission.requesterId === approver.id) fail('FORBIDDEN', 403, '不允许申请人自批。')
      const snapshotHash = createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
      if (snapshotHash !== submissionRow.snapshotHash) {
        fail('STATE_CONFLICT', 409, '提交快照摘要校验失败。')
      }
      this.validateSubmissionSnapshot(submission)

      const decisionId = randomUUID()
      const createdAt = new Date().toISOString()
      let publishedPlanVersion: number | null = null
      let deferredItemId: string | null = null

      if (input.decision === 'approved') {
        const latest = this.latestPlanVersion(projectId)
        if (latest !== submission.basePlanVersion) {
          fail('BASELINE_EXPIRED', 409, '基线计划已过期，请基于最新计划版本重新提交。')
        }
        const selected = submission.snapshot.scenarioRevision.scenarios[submission.selectedKind]
        if (submission.selectedKind === 'defer') {
          deferredItemId = randomUUID()
        } else {
          publishedPlanVersion = latest! + 1
          this.db.prepare(`
            INSERT INTO plan_versions (
              project_id, version, created_at, metrics_json, plan_json,
              parent_version, source_change_request_id, source_submission_id, source_decision_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId, publishedPlanVersion, createdAt,
            JSON.stringify(selected.candidatePlan.metrics), JSON.stringify(selected.candidatePlan),
            submission.basePlanVersion, changeId, submission.id, decisionId,
          )
        }
      }

      this.db.prepare(`
        INSERT INTO approval_decisions (
          id, submission_id, change_request_id, approver_id, decision, comment,
          created_at, published_plan_version, deferred_item_id, idempotency_key, request_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decisionId, submission.id, changeId, approver.id, input.decision, comment,
        createdAt, publishedPlanVersion, deferredItemId, input.idempotencyKey, fingerprint,
      )
      if (input.decision === 'approved' && submission.selectedKind === 'defer') {
        const selected = submission.snapshot.scenarioRevision.scenarios.defer
        this.db.prepare(`
          INSERT INTO deferred_items (
            id, project_id, change_request_id, submission_id, decision_id,
            scope_json, future_estimate_json, priority, scheduling_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', 'pending', ?)
        `).run(
          deferredItemId, projectId, changeId, submission.id, decisionId,
          JSON.stringify(selected.includedScope),
          selected.futureEstimate === null ? null : JSON.stringify(selected.futureEstimate),
          createdAt,
        )
      }
      this.db.prepare(`
        UPDATE change_requests SET status = ?, decided_at = ?, updated_at = ? WHERE id = ? AND project_id = ?
      `).run(input.decision === 'approved' ? 'approved' : 'rejected', createdAt, createdAt, changeId, projectId)

      const decisionRow = this.db.prepare(`
        SELECT ${decisionColumns} FROM approval_decisions WHERE id = ?
      `).get(decisionId) as unknown as ApprovalDecision
      const result = this.decisionResult(projectId, decisionRow)
      this.beforeDecisionCommit()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 事务可能已回滚或提交 */ }
      throw error
    }
  }

  private validateSubmissionSnapshot(submission: ChangeSubmission): void {
    const snapshot = submission.snapshot
    if (snapshot.request.basePlanVersion !== submission.basePlanVersion ||
        snapshot.request.baseScanId !== submission.baseScanId) {
      fail('STATE_CONFLICT', 409, '提交快照的基线或扫描与提交记录不一致。')
    }
    if (snapshot.analysis.id !== submission.analysisRevisionId ||
        snapshot.scenarioRevision.id !== submission.scenarioRevisionId) {
      fail('STATE_CONFLICT', 409, '提交快照的分析或方案版本与提交记录不一致。')
    }
    if (snapshot.analysis.changeRequestRevision !== submission.revision ||
        snapshot.scenarioRevision.changeRequestRevision !== submission.revision) {
      fail('STATE_CONFLICT', 409, '提交快照的分析或方案未绑定当前申请修订。')
    }
    if (snapshot.scenarioRevision.analysisRevisionId !== snapshot.analysis.id) {
      fail('STATE_CONFLICT', 409, '提交快照的三方案与分析版本不一致。')
    }
    if (snapshot.analysis.baselinePlanVersion !== submission.basePlanVersion ||
        snapshot.analysis.baselineScanId !== submission.baseScanId ||
        snapshot.scenarioRevision.baselinePlanVersion !== submission.basePlanVersion ||
        snapshot.scenarioRevision.baselineScanId !== submission.baseScanId ||
        snapshot.baseline.planVersion !== submission.basePlanVersion ||
        snapshot.baseline.scanId !== submission.baseScanId) {
      fail('STATE_CONFLICT', 409, '提交快照中的基线或扫描引用不一致。')
    }
  }

  protected beforeDecisionCommit(): void {
    // 测试专用注入点：子类可覆写以模拟事务中途故障。
  }

  listDecisions(projectId: string, changeId: string): ApprovalDecision[] {
    this.requireChangeRequest(projectId, changeId)
    return this.db.prepare(`
      SELECT ${decisionColumns} FROM approval_decisions WHERE change_request_id = ? ORDER BY created_at DESC
    `).all(changeId) as unknown as ApprovalDecision[]
  }

  getDecisionBySubmission(projectId: string, changeId: string, submissionId: string): ApprovalDecision | undefined {
    this.requireChangeRequest(projectId, changeId)
    const submission = this.db.prepare('SELECT id FROM change_submissions WHERE change_request_id = ? AND id = ?')
      .get(changeId, submissionId) as { id: string } | undefined
    if (!submission) return undefined
    return this.db.prepare(`SELECT ${decisionColumns} FROM approval_decisions WHERE submission_id = ?`)
      .get(submissionId) as ApprovalDecision | undefined
  }

  getDeferredItem(projectId: string, changeId: string, deferredItemId: string): DeferredItem | undefined {
    this.requireChangeRequest(projectId, changeId)
    const row = this.db.prepare(`
      SELECT ${deferredColumns} FROM deferred_items WHERE change_request_id = ? AND id = ?
    `).get(changeId, deferredItemId) as DeferredRow | undefined
    return row ? readDeferred(row) : undefined
  }

  saveImplementationCheck(
    projectId: string,
    changeId: string,
    actor: Actor | undefined,
    input: ImplementationCheckInput,
  ): ImplementationCheck {
    const member = this.requireMember(actor, projectId)
    const changeRequest = this.requireChangeRequest(projectId, changeId)
    const submissionRow = this.db.prepare(`
      SELECT ${submissionColumns} FROM change_submissions WHERE change_request_id = ? AND id = ?
    `).get(changeId, input.submissionId) as SubmissionRow | undefined
    if (!submissionRow) fail('NOT_FOUND', 404, '找不到该提交。')
    const submission = readSubmission(submissionRow)
    const decision = this.db.prepare(`
      SELECT ${decisionColumns} FROM approval_decisions WHERE submission_id = ?
    `).get(submission.id) as ApprovalDecision | undefined
    if (!decision || decision.decision !== 'approved') fail('STATE_CONFLICT', 409, '只有获批的提交才能记录实施。')
    if (!['not_started', 'in_progress', 'waiting_scheduling', 'completed'].includes(input.status)) {
      fail('VALIDATION_ERROR', 400, '实施状态无效。')
    }
    if (decision.deferredItemId && input.status !== 'waiting_scheduling') {
      const deferred = this.db.prepare(`SELECT ${deferredColumns} FROM deferred_items WHERE id = ?`).get(decision.deferredItemId) as DeferredRow | undefined
      if (!deferred?.scheduledAt) fail('STATE_CONFLICT', 409, '延期事项需正式排期后才能进入正常实施流程。')
    }
    const requirementAcceptance = this.parseAcceptance(input.requirementAcceptance)
    const coverageReview = this.parseCoverageReview(input.coverageReview)
    let postScan: RepositoryScanDetail | undefined
    if (input.postScanId !== undefined && input.postScanId !== null) {
      postScan = this.getScan(projectId, input.postScanId)
      if (!postScan || postScan.status !== 'succeeded' || !postScan.result) fail('VALIDATION_ERROR', 400, '复扫记录必须属于当前项目且已成功完成。')
      const frozenSource = submission.snapshot.baseline?.repositoryUrl ?? null
      const postSource = this.scanRepositoryUrl(projectId, input.postScanId)
      if (frozenSource && postSource && postSource !== frozenSource) {
        fail('VALIDATION_ERROR', 400, '复扫记录的来源仓库与提交冻结的来源仓库不一致。')
      }
    }
    const implementationCommit = input.implementationCommit === undefined || input.implementationCommit === null
      ? null
      : (typeof input.implementationCommit === 'string' ? input.implementationCommit.trim() : '')
    if (implementationCommit !== null && !implementationCommit) fail('VALIDATION_ERROR', 400, '实施提交不能为空。')
    if (implementationCommit !== null && postScan?.result && implementationCommit !== postScan.result.commit) {
      fail('VALIDATION_ERROR', 400, '实施提交必须与复扫结果一致。')
    }
    const now = new Date().toISOString()
    const evidenceInput = input.evidence
    if (evidenceInput !== undefined) {
      if (typeof evidenceInput.command !== 'string' || !evidenceInput.command.trim() || evidenceInput.command.length > 2000) {
        fail('VALIDATION_ERROR', 400, '测试命令不能为空且不能超过 2000 个字符。')
      }
      if (typeof evidenceInput.outputSummary !== 'string' || evidenceInput.outputSummary.length > 20_000) {
        fail('VALIDATION_ERROR', 400, '测试输出摘要过长。')
      }
    }

    let rescan: { comparable: boolean; coverageLimited: boolean; reason: string | null } | null = null
    if (input.status === 'completed') {
      if (!implementationCommit) fail('VALIDATION_ERROR', 400, '完成态需要实施提交。')
      if (!postScan) fail('VALIDATION_ERROR', 400, '完成态需要复扫结果。')
      if (!requirementAcceptance || requirementAcceptance.verdict !== 'accepted' || !requirementAcceptance.summary.trim()) {
        fail('VALIDATION_ERROR', 400, '完成态需要已通过的需求验收结论。')
      }
      if (!evidenceInput || !evidenceInput.passed) fail('VALIDATION_ERROR', 400, '完成态需要至少一条通过的测试证据。')
      rescan = this.compareSubmissionRescan(projectId, submission, postScan)
      if (!rescan.comparable) fail('VALIDATION_ERROR', 400, `复扫不可比：${rescan.reason}`)
      if (rescan.coverageLimited && !coverageReview?.accepted) {
        fail('VALIDATION_ERROR', 400, '复扫覆盖受限，需要人工复核通过后才能完成。')
      }
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { revision } = this.db.prepare(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM implementation_checks WHERE submission_id = ?
      `).get(submission.id) as { revision: number }
      const checkId = randomUUID()
      this.db.prepare(`
        INSERT INTO implementation_checks (
          id, change_request_id, submission_id, revision, status, implementation_commit,
          pre_scan_id, post_scan_id, requirement_acceptance_json, coverage_review_json,
          recorded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkId, changeId, submission.id, revision, input.status, implementationCommit,
        submission.baseScanId, input.postScanId ?? null,
        requirementAcceptance === null ? null : JSON.stringify(requirementAcceptance),
        coverageReview === null ? null : JSON.stringify(coverageReview),
        member.id, now,
      )
      if (evidenceInput !== undefined) {
        this.db.prepare(`
          INSERT INTO implementation_evidences (
            id, implementation_check_id, revision, command, passed, executed_at,
            output_summary, source, recorded_by, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), checkId, evidenceInput.command.trim(),
          evidenceInput.passed ? 1 : 0, evidenceInput.executedAt ?? null,
          evidenceInput.outputSummary.trim(), evidenceInput.source ?? 'manual', member.id, now,
        )
      }
      this.db.exec('COMMIT')
      const saved = this.db.prepare(`SELECT ${implementationCheckColumns} FROM implementation_checks WHERE id = ?`).get(checkId) as unknown as ImplementationCheckRow
      return this.readImplementationCheckWithEvidence(saved)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listImplementationChecks(projectId: string, changeId: string): ImplementationCheck[] {
    this.requireChangeRequest(projectId, changeId)
    const rows = this.db.prepare(`
      SELECT ${implementationCheckColumns} FROM implementation_checks WHERE change_request_id = ? ORDER BY revision DESC
    `).all(changeId) as unknown as ImplementationCheckRow[]
    return rows.map((row) => this.readImplementationCheckWithEvidence(row))
  }

  getImplementationCheck(projectId: string, changeId: string, checkId: string): ImplementationCheck | undefined {
    this.requireChangeRequest(projectId, changeId)
    const row = this.db.prepare(`
      SELECT ${implementationCheckColumns} FROM implementation_checks WHERE change_request_id = ? AND id = ?
    `).get(changeId, checkId) as ImplementationCheckRow | undefined
    if (!row) return undefined
    return this.readImplementationCheckWithEvidence(row)
  }

  getImplementationCheckBySubmission(
    projectId: string,
    changeId: string,
    submissionId: string,
    revision?: number,
  ): ImplementationCheck | undefined {
    this.requireChangeRequest(projectId, changeId)
    const row = revision === undefined
      ? this.db.prepare(`
          SELECT ${implementationCheckColumns} FROM implementation_checks
          WHERE change_request_id = ? AND submission_id = ? ORDER BY revision DESC LIMIT 1
        `).get(changeId, submissionId) as ImplementationCheckRow | undefined
      : this.db.prepare(`
          SELECT ${implementationCheckColumns} FROM implementation_checks
          WHERE change_request_id = ? AND submission_id = ? AND revision = ?
        `).get(changeId, submissionId, revision) as ImplementationCheckRow | undefined
    if (!row) return undefined
    return this.readImplementationCheckWithEvidence(row)
  }

  private readImplementationCheckWithEvidence(row: ImplementationCheckRow): ImplementationCheck {
    const evidences = this.db.prepare(`
      SELECT ${evidenceColumns} FROM implementation_evidences WHERE implementation_check_id = ? ORDER BY revision
    `).all(row.id) as unknown as EvidenceRow[]
    return { ...readImplementationCheck(row), evidence: evidences.map(readEvidence) }
  }

  private parseAcceptance(value: unknown): RequirementAcceptance | null {
    if (value === undefined || value === null) return null
    const acceptance = value as Partial<RequirementAcceptance> | null
    if (!acceptance || !['accepted', 'rejected', 'pending'].includes(acceptance.verdict as string) ||
        typeof acceptance.summary !== 'string' || acceptance.summary.length > 10_000) {
      fail('VALIDATION_ERROR', 400, '需求验收需要 verdict 和 summary。')
    }
    return { verdict: acceptance.verdict as RequirementAcceptance['verdict'], summary: acceptance.summary.trim() }
  }

  private parseCoverageReview(value: unknown): CoverageReview | null {
    if (value === undefined || value === null) return null
    const review = value as Partial<CoverageReview> | null
    if (!review || typeof review.accepted !== 'boolean') fail('VALIDATION_ERROR', 400, '覆盖复核需要 accepted 布尔值。')
    const note = typeof review.note === 'string' ? review.note.trim() : ''
    if (note.length > 10_000) fail('VALIDATION_ERROR', 400, '覆盖复核说明过长。')
    return { accepted: review.accepted, note: note || undefined }
  }

  compareSubmissionRescan(
    projectId: string,
    submission: ChangeSubmission,
    postScan: RepositoryScanDetail,
  ): { comparable: boolean; coverageLimited: boolean; reason: string | null; comparison: ArchitectureComparison | null } {
    const frozenSource = submission.snapshot.baseline?.repositoryUrl ?? null
    if (!frozenSource) {
      return { comparable: false, coverageLimited: true, reason: '提交冻结的仓库来源无法确认，不能判定可比。', comparison: null }
    }
    const preSource = this.scanRepositoryUrl(projectId, submission.baseScanId)
    const postSource = this.scanRepositoryUrl(projectId, postScan.id)
    if (preSource !== frozenSource || postSource !== frozenSource) {
      return { comparable: false, coverageLimited: true, reason: '基线、复扫或冻结来源的仓库不一致。', comparison: null }
    }
    const preScan = this.getScan(projectId, submission.baseScanId)
    const pre = preScan?.result?.architecture
    const post = postScan.result?.architecture
    if (!pre || !post) return { comparable: false, coverageLimited: true, reason: '基线或复扫缺少架构结果。', comparison: null }
    if (pre.ruleVersion !== post.ruleVersion || JSON.stringify(pre.rules) !== JSON.stringify(post.rules)) {
      return { comparable: false, coverageLimited: true, reason: '规则版本或分层配置不一致。', comparison: null }
    }
    if (preScan?.result?.analyzerVersion !== postScan.result?.analyzerVersion) {
      return { comparable: false, coverageLimited: true, reason: '解析器版本不一致。', comparison: null }
    }
    try {
      const comparison = compareArchitecture(pre, post)
      return { comparable: true, coverageLimited: comparison.coverageLimited, reason: null, comparison }
    } catch (error) {
      return { comparable: false, coverageLimited: true, reason: (error as Error).message, comparison: null }
    }
  }

  getPlanLineageParent(projectId: string, version: number): number | null {
    const row = this.db.prepare('SELECT parent_version AS parentVersion FROM plan_versions WHERE project_id = ? AND version = ?')
      .get(projectId, version) as { parentVersion: number | null } | undefined
    return row?.parentVersion ?? null
  }
}
