import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Actor } from '../src/changes/actor'
import { ActorResolver } from '../src/changes/actor'
import type { AnalysisContext } from '../src/changes/adapters'
import { createFixtureAdapters } from '../src/changes/fixture-adapters'
import { ReportsController } from '../src/reports/reports.module'
import { buildPlan } from '../src/plans/build-plan'
import { detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import { SqliteStore } from '../src/storage/sqlite-store'
import type {
  ChangeSubmission,
  RepositoryScanResult,
  ScenarioInputSet,
} from '@archguard/contracts'

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,导出服务,REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\n')

function graph(files: string[], unresolved: RepositoryScanResult['unresolved'] = []) {
  return {
    files,
    dependencies: [{ from: files[0], to: files[1], kind: 'import' as const, line: 1, specifier: '../b' }],
    unresolved,
    externalCount: 0,
    configurationWarnings: [],
    syntaxWarningFiles: [],
    computedImportCount: 0,
  }
}

function scanResult(commit: string, rules = { layers: [] as { name: string; prefix: string }[], allowed: [] as { from: string; to: string }[] }, unresolved: RepositoryScanResult['unresolved'] = []): RepositoryScanResult {
  const parsed = parseArchitectureRules(rules)
  const g = graph(['src/export/a.ts', 'src/test/b.ts'], unresolved)
  return { ...g, commit, analyzerVersion: '1/ts-test', skippedFiles: 0, architecture: detectArchitecture(g, parsed) }
}

function snapshotHash(submission: ChangeSubmission): string {
  return createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
}

function scenarioInputs(): ScenarioInputSet {
  const base = { includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['写入成功'], taskDiffs: [], estimationInput: { source: '测试来源', ruleVersion: 'v1', basis: '测试依据' } }
  return {
    accept: { ...base, kind: 'accept', taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }] },
    reduce: { ...base, kind: 'reduce', taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }] },
    defer: { ...base, kind: 'defer', taskDiffs: [] },
  }
}

interface Setup {
  store: SqliteStore
  directory: string
  projectId: string
  scanId: string
  member: Actor
  approver: Actor
}

function setup(t: { after: (fn: () => void) => void }): Setup {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-reg-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  t.after(() => {
    try { store.onModuleDestroy() } catch { /* 已关闭 */ }
    rmSync(directory, { recursive: true, force: true })
  })
  const project = store.createProject({ name: '回归演示', repositoryUrl: 'https://github.com/example/demo.git' })
  store.createPlan(project.id, buildPlan(requirements, csv))
  const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
  store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
  store.finishScan(scan.id, scanResult('abc'.repeat(13)), null)
  const member: Actor = { id: 'u-member', name: '成员甲', roles: new Set<'member' | 'approver'>(['member']), projects: new Set([project.id]) }
  const approver: Actor = { id: 'u-approver', name: '审批乙', roles: new Set<'member' | 'approver'>(['member', 'approver']), projects: new Set([project.id]) }
  return { store, directory, projectId: project.id, scanId: scan.id, member, approver }
}

function addAnalysisAndScenario(store: SqliteStore, projectId: string, changeId: string, member: Actor): void {
  const change = store.getChangeRequest(projectId, changeId)!
  const { analysis: analysisAdapter, scenario: scenarioAdapter } = createFixtureAdapters()
  const context: AnalysisContext = {
    projectId,
    changeRequest: change,
    baselinePlan: store.getPlan(projectId, change.basePlanVersion) ?? undefined,
    baselineScan: store.getScan(projectId, change.baseScanId),
    actor: member,
  }
  const analysis = store.saveAnalysisRevision(projectId, changeId, member, analysisAdapter.analyze(context, {}))
  store.saveScenarioRevision(projectId, changeId, member, scenarioAdapter.compute({ ...context, analysis, existingScenarios: [] }, scenarioInputs()))
}

function approve(store: SqliteStore, projectId: string, changeId: string, approver: Actor, submission: ChangeSubmission, key: string) {
  return store.decideChangeRequest(projectId, changeId, approver, {
    decision: 'approved', idempotencyKey: key, comment: '通过',
    submissionId: submission.id, expectedSnapshotHash: snapshotHash(submission),
  })
}

test('v2 基线更新后，旧 v1 分析与方案不能提交', (t) => {
  const { store, projectId, member } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '旧基线', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  store.createPlan(projectId, buildPlan(requirements, csv.replace('T1,16,,150', 'T1,20,,150')))
  store.updateChangeRequest(projectId, change.id, member, { basePlanVersion: 2, expectedRevision: 1 })
  assert.throws(
    () => store.submitChangeRequest(projectId, change.id, member, 'accept'),
    (error: Error & { code?: string }) => error.code === 'STATE_CONFLICT',
  )
  addAnalysisAndScenario(store, projectId, change.id, member)
  const submission = store.submitChangeRequest(projectId, change.id, member, 'accept')
  assert.equal(submission.basePlanVersion, 2)
})

test('审批必须携带 submissionId 与 snapshotHash，旧页面不能批准重提交的新版本', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '审批绑定', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const first = store.submitChangeRequest(projectId, change.id, member, 'accept')
  assert.throws(
    () => store.decideChangeRequest(projectId, change.id, approver, { decision: 'approved', idempotencyKey: 'k1', comment: '', submissionId: first.id, expectedSnapshotHash: 'f'.repeat(64) }),
    (error: Error & { code?: string }) => error.code === 'STATE_CONFLICT',
  )
  store.decideChangeRequest(projectId, change.id, approver, {
    decision: 'rejected', idempotencyKey: 'k1', comment: '拒绝', submissionId: first.id, expectedSnapshotHash: snapshotHash(first),
  })
  const rejected = store.getChangeRequest(projectId, change.id)!
  store.updateChangeRequest(projectId, change.id, member, { title: '修订后', expectedRevision: rejected.draftRevision })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const second = store.submitChangeRequest(projectId, change.id, member, 'accept')
  assert.throws(
    () => store.decideChangeRequest(projectId, change.id, approver, { decision: 'approved', idempotencyKey: 'k2', comment: '', submissionId: first.id, expectedSnapshotHash: snapshotHash(first) }),
    (error: Error & { code?: string }) => error.code === 'ALREADY_DECIDED',
  )
  const result = approve(store, projectId, change.id, approver, second, 'k3')
  assert.equal(result.decision.publishedPlanVersion, 2)
})

test('完成态要求测试证据、验收通过与可比复扫', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '完成门禁', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const submission = store.submitChangeRequest(projectId, change.id, member, 'accept')
  approve(store, projectId, change.id, approver, submission, 'done')

  const base = { submissionId: submission.id, implementationCommit: 'b'.repeat(13) }
  const evidence = { command: 'npm test', passed: true, outputSummary: '通过' }
  const acceptance = { verdict: 'accepted' as const, summary: '需求已验收' }

  assert.throws(
    () => store.saveImplementationCheck(projectId, change.id, member, { ...base, status: 'completed', requirementAcceptance: acceptance, postScanId: undefined }),
    (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR',
  )
  assert.throws(
    () => store.saveImplementationCheck(projectId, change.id, member, { ...base, status: 'completed', requirementAcceptance: { verdict: 'rejected' as const, summary: '验收失败' }, evidence }),
    (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR',
  )

  const postScan = store.enqueueScan(projectId, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
  store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
  store.finishScan(postScan.id, scanResult('b'.repeat(13)), null)
  const completed = store.saveImplementationCheck(projectId, change.id, member, {
    ...base, status: 'completed', postScanId: postScan.id, requirementAcceptance: acceptance, evidence,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.revision, 1)
  assert.equal(completed.requirementAcceptance?.verdict, 'accepted')
})

test('普通草稿修改递增修订，过期 expectedRevision 返回 409', (t) => {
  const { store, projectId, member } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '初始', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  assert.equal(change.draftRevision, 1)
  store.updateChangeRequest(projectId, change.id, member, { title: '第二版', expectedRevision: 1 })
  assert.equal(store.getChangeRequest(projectId, change.id)!.draftRevision, 2)
  assert.throws(
    () => store.updateChangeRequest(projectId, change.id, member, { title: '第三版', expectedRevision: 1 }),
    (error: Error & { code?: string }) => error.code === 'REVISION_CONFLICT',
  )
})

test('固定 submissionId 后，修改申请不会改变历史报告', (t) => {
  const { store, projectId, member, approver } = setup(t)
  process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
    { token: 'member-token', actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [projectId] },
  ])
  const actors = new ActorResolver()
  const reports = new ReportsController(store, actors)
  const change = store.createChangeRequest(projectId, member, { title: '历史标题', description: '历史描述', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const submission = store.submitChangeRequest(projectId, change.id, member, 'accept')
  store.decideChangeRequest(projectId, change.id, approver, {
    decision: 'rejected', idempotencyKey: 'hist', comment: '拒绝', submissionId: submission.id, expectedSnapshotHash: snapshotHash(submission),
  })
  const before = reports.report(projectId, change.id, submission.id, undefined, 'Bearer member-token')
  const rejected = store.getChangeRequest(projectId, change.id)!
  store.updateChangeRequest(projectId, change.id, member, { title: '新标题', description: '新描述', expectedRevision: rejected.draftRevision })
  const after = reports.report(projectId, change.id, submission.id, undefined, 'Bearer member-token')
  assert.equal(after.changeRequest.title, '历史标题')
  assert.equal(after.changeRequest.description, '历史描述')
  assert.equal(after.baseline.planVersion, before.baseline.planVersion)
  assert.equal(after.baseline.scanId, before.baseline.scanId)
})

test('实施检查追加版本且不覆盖历史', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '追加版本', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const submission = store.submitChangeRequest(projectId, change.id, member, 'accept')
  approve(store, projectId, change.id, approver, submission, 'append')
  const v1 = store.saveImplementationCheck(projectId, change.id, member, { submissionId: submission.id, status: 'in_progress', implementationCommit: 'aaa'.repeat(13) })
  const v2 = store.saveImplementationCheck(projectId, change.id, member, { submissionId: submission.id, status: 'in_progress', implementationCommit: 'bbb'.repeat(13) })
  assert.equal(v1.revision, 1)
  assert.equal(v2.revision, 2)
  const list = store.listImplementationChecks(projectId, change.id)
  assert.equal(list.length, 2)
  assert.equal(list.find((item) => item.revision === 1)?.implementationCommit, 'aaa'.repeat(13))
  assert.equal(store.getImplementationCheck(projectId, change.id, v1.id)?.implementationCommit, 'aaa'.repeat(13))
  assert.equal(store.getImplementationCheckBySubmission(projectId, change.id, submission.id)?.revision, 2)
})

test('真实旧库迁移：implementation_checks 与绑定列', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-legacy-'))
  const filename = join(directory, 'archguard.sqlite')
  const legacy = new DatabaseSync(filename)
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_url TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE repository_scans (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), repository_url TEXT NOT NULL,
        ref TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, lease_until TEXT,
        finished_at TEXT, summary_json TEXT, result_json TEXT, error TEXT
      );
      CREATE TABLE change_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        description TEXT NOT NULL, requester_id TEXT NOT NULL, draft_revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, base_plan_version INTEGER NOT NULL, base_scan_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT, decided_at TEXT
      );
      CREATE TABLE change_submissions (
        id TEXT PRIMARY KEY, change_request_id TEXT NOT NULL REFERENCES change_requests(id), revision INTEGER NOT NULL,
        base_plan_version INTEGER NOT NULL, base_scan_id TEXT NOT NULL, base_scan_commit TEXT NOT NULL,
        analysis_revision_id TEXT NOT NULL, scenario_revision_id TEXT NOT NULL, selected_kind TEXT NOT NULL,
        requester_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(change_request_id, revision)
      );
      CREATE TABLE implementation_checks (
        id TEXT PRIMARY KEY, change_request_id TEXT NOT NULL REFERENCES change_requests(id),
        submission_id TEXT NOT NULL UNIQUE REFERENCES change_submissions(id),
        status TEXT NOT NULL, implementation_commit TEXT, pre_scan_id TEXT NOT NULL, post_scan_id TEXT,
        requirement_acceptance TEXT, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE implementation_evidences (
        id TEXT PRIMARY KEY, implementation_check_id TEXT NOT NULL REFERENCES implementation_checks(id), revision INTEGER NOT NULL,
        command TEXT NOT NULL, passed INTEGER NOT NULL, executed_at TEXT, output_summary TEXT NOT NULL,
        source TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(implementation_check_id, revision)
      );
    `)
    legacy.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run('p1', '旧项目', 'https://github.com/example/demo.git', '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO repository_scans (id, project_id, repository_url, ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', 'p1', 'https://github.com/example/demo.git', 'HEAD', 'succeeded', '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO change_requests (id, project_id, title, description, requester_id, draft_revision, status, base_plan_version, base_scan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'p1', '旧申请', '旧描述', 'u1', 1, 'draft', 1, 's1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO change_submissions (id, change_request_id, revision, base_plan_version, base_scan_id, base_scan_commit, analysis_revision_id, scenario_revision_id, selected_kind, requester_id, snapshot_json, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('sub1', 'c1', 1, 1, 's1', 'abc', 'a1', 'sc1', 'accept', 'u1', '{}', 'h', '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO implementation_checks (id, change_request_id, submission_id, status, implementation_commit, pre_scan_id, recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('chk1', 'c1', 'sub1', 'completed', 'abc', 's1', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO implementation_evidences (id, implementation_check_id, revision, command, passed, output_summary, source, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ev1', 'chk1', 1, 'npm test', 1, '通过', 'manual', 'u1', '2026-01-01T00:00:00.000Z')
  } finally {
    legacy.close()
  }

  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  try {
    const check = store.getImplementationCheck('p1', 'c1', 'chk1')
    assert.ok(check)
    assert.equal(check.revision, 1)
    assert.equal(check.evidence.length, 1)
    assert.equal(check.requirementAcceptance, null)
    const analysisColumns = store.listAnalysisRevisions('p1', 'c1')
    assert.deepEqual(analysisColumns, [])
  } finally {
    store.onModuleDestroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('事务中途故障完整回滚', (t) => {
  class FaultyStore extends SqliteStore {
    protected override beforeDecisionCommit(): void {
      throw new Error('注入的提交前故障')
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'archguard-fault-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new FaultyStore()
  t.after(() => {
    try { store.onModuleDestroy() } catch { /* 已关闭 */ }
    rmSync(directory, { recursive: true, force: true })
  })
  const project = store.createProject({ name: '故障注入', repositoryUrl: 'https://github.com/example/demo.git' })
  store.createPlan(project.id, buildPlan(requirements, csv))
  const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
  store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
  store.finishScan(scan.id, scanResult('abc'.repeat(13)), null)
  const member: Actor = { id: 'u-member', name: '成员甲', roles: new Set<'member' | 'approver'>(['member']), projects: new Set([project.id]) }
  const approver: Actor = { id: 'u-approver', name: '审批乙', roles: new Set<'member' | 'approver'>(['member', 'approver']), projects: new Set([project.id]) }
  const change = store.createChangeRequest(project.id, member, { title: '故障', description: '', basePlanVersion: 1, baseScanId: scan.id })
  addAnalysisAndScenario(store, project.id, change.id, member)
  const submission = store.submitChangeRequest(project.id, change.id, member, 'accept')
  const beforePlans = store.listPlans(project.id).length
  assert.throws(
    () => approve(store, project.id, change.id, approver, submission, 'fault'),
    /注入的提交前故障/,
  )
  assert.equal(store.listPlans(project.id).length, beforePlans)
  assert.equal(store.getChangeRequest(project.id, change.id)?.status, 'pending')
  assert.equal(store.listDecisions(project.id, change.id).length, 0)
})

test('提交与草稿修改并发：旧修订不能冻结覆盖新修订', async (t) => {
  const { store, projectId, member, directory } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '并发提交', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)

  const readyFile = join(directory, 'ready.json')
  const goFile = join(directory, 'go.json')
  const outFile = join(directory, 'out.json')
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/submit-worker.ts', directory, projectId, change.id, 'accept', readyFile, goFile, outFile], {
    cwd: join(__dirname, '..'),
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })

  // 等待提交进程完成“事务外预读”。
  const deadline = Date.now() + 10_000
  while (!existsSync(readyFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(existsSync(readyFile), '提交进程未完成预读')
  assert.equal(JSON.parse(readFileSync(readyFile, 'utf8')).draftRevision, 1)

  // 另一进程（本进程用独立连接）把草稿改为修订2并提交。
  const otherStore = new SqliteStore()
  try {
    otherStore.updateChangeRequest(projectId, change.id, member, { title: '并发修订2', expectedRevision: 1 })
    addAnalysisAndScenario(otherStore, projectId, change.id, member)
    otherStore.submitChangeRequest(projectId, change.id, member, 'accept')
  } finally {
    otherStore.onModuleDestroy()
  }
  writeFileSync(goFile, 'go')

  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  const result = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(result.ok, false)
  assert.ok(['STATE_CONFLICT', 'REVISION_CONFLICT'].includes(result.code), `实际 code=${result.code} stderr=${stderr}`)
  const submissions = store.listSubmissions(projectId, change.id)
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].revision, 2)
  assert.equal(store.getChangeRequest(projectId, change.id)?.draftRevision, 2)
})

test('跨仓库复扫不可比，不能据此完成实施', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, { title: '跨仓库', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id })
  addAnalysisAndScenario(store, projectId, change.id, member)
  const submission = store.submitChangeRequest(projectId, change.id, member, 'accept')
  approve(store, projectId, change.id, approver, submission, 'cross-repo')

  store.updateProject(projectId, { name: '已改仓库', repositoryUrl: 'https://github.com/example/other.git' })
  const postScan = store.enqueueScan(projectId, 'https://github.com/example/other.git', 'HEAD', { layers: [], allowed: [] })
  store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
  store.finishScan(postScan.id, scanResult('b'.repeat(13)), null)

  assert.throws(
    () => store.saveImplementationCheck(projectId, change.id, member, {
      submissionId: submission.id,
      status: 'completed',
      implementationCommit: 'b'.repeat(13),
      postScanId: postScan.id,
      requirementAcceptance: { verdict: 'accepted', summary: '验收通过' },
      evidence: { command: 'npm test', passed: true, outputSummary: '通过' },
    }),
    (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR' && /仓库/.test(error.message),
  )

  const rescan = store.compareSubmissionRescan(projectId, submission, store.getScan(projectId, postScan.id)!)
  assert.equal(rescan.comparable, false)
  assert.match(rescan.reason ?? '', /仓库/)

  const legacy = { ...submission, snapshot: { ...submission.snapshot, baseline: { ...submission.snapshot.baseline, repositoryUrl: null } } }
  const legacyRescan = store.compareSubmissionRescan(projectId, legacy, store.getScan(projectId, postScan.id)!)
  assert.equal(legacyRescan.comparable, false)
  assert.match(legacyRescan.reason ?? '', /无法确认/)
})
