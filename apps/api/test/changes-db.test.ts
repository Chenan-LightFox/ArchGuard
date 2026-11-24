import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  Actor,
} from '../src/changes/actor'
import type { AnalysisContext, ScenarioContext } from '../src/changes/adapters'
import { createFixtureAdapters } from '../src/changes/fixture-adapters'
import { buildPlan } from '../src/plans/build-plan'
import { detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import { SqliteStore } from '../src/storage/sqlite-store'
import type { ChangeSubmission, RepositoryScanResult, ScenarioInputSet } from '@archguard/contracts'

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,"导出,服务",REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\n')

function makeScanResult(commit: string, files = ['src/export/a.ts', 'src/test/b.ts']): RepositoryScanResult {
  const graph = {
    files,
    dependencies: [{ from: files[0], to: files[1], kind: 'import' as const, line: 1, specifier: '../test/b' }],
    unresolved: [],
    externalCount: 0,
    configurationWarnings: [],
    syntaxWarningFiles: [],
    computedImportCount: 0,
  }
  return { ...graph, commit, analyzerVersion: '1/ts-test', skippedFiles: 0, architecture: detectArchitecture(graph, parseArchitectureRules(undefined)) }
}

interface Setup {
  store: SqliteStore
  directory: string
  projectId: string
  planVersion: number
  scanId: string
  member: Actor
  approver: Actor
}

function setup(t: { after: (fn: () => void) => void }): Setup {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-d-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  t.after(() => {
    try { store.onModuleDestroy() } catch { /* 已关闭 */ }
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  })
  const project = store.createProject({ name: '演示项目', repositoryUrl: 'https://github.com/example/demo.git' })
  const planVersion = store.createPlan(project.id, buildPlan(requirements, csv)).version
  const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
  const now = new Date().toISOString()
  const lease = new Date(Date.now() + 60_000).toISOString()
  store.claimScan(now, lease)
  store.finishScan(scan.id, makeScanResult('abc'.repeat(13)), null)
  const member: Actor = { id: 'u-member', name: '成员甲', roles: new Set<'member' | 'approver'>(['member']), projects: new Set([project.id]) }
  const approver: Actor = { id: 'u-approver', name: '审批乙', roles: new Set<'member' | 'approver'>(['member', 'approver']), projects: new Set([project.id]) }
  return { store, directory, projectId: project.id, planVersion, scanId: scan.id, member, approver }
}

function submitChange(store: SqliteStore, projectId: string, changeId: string, member: Actor, selectedKind: 'accept' | 'reduce' | 'defer' = 'accept') {
  const change = store.getChangeRequest(projectId, changeId)!
  const { analysis: analysisAdapter, scenario: scenarioAdapter } = createFixtureAdapters()
  const context: AnalysisContext = {
    projectId,
    changeRequest: change,
    baselinePlan: store.getPlan(projectId, change.basePlanVersion) ?? undefined,
    baselineScan: store.getScan(projectId, change.baseScanId),
    actor: member,
  }
  const analysis = store.saveAnalysisRevision(projectId, change.id, member, analysisAdapter.analyze(context, {}))
  const scenarioContext: ScenarioContext = { ...context, analysis, existingScenarios: [] }
  const input = scenarioInputs()
  const scenario = store.saveScenarioRevision(projectId, change.id, member, scenarioAdapter.compute(scenarioContext, input))
  const submission = store.submitChangeRequest(projectId, change.id, member, selectedKind)
  return { changeId: change.id, submission, scenario }
}

function createPending(store: SqliteStore, projectId: string, member: Actor, approver: Actor, selectedKind: 'accept' | 'reduce' | 'defer' = 'accept') {
  const change = store.createChangeRequest(projectId, member, {
    title: '新增导出审计记录', description: '演示变更', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id,
  })
  return submitChange(store, projectId, change.id, member, selectedKind)
}

function snapshotHash(submission: ChangeSubmission): string {
  return createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
}

function decide(
  store: SqliteStore,
  projectId: string,
  changeId: string,
  actor: Actor,
  submission: ChangeSubmission,
  decision: 'approved' | 'rejected',
  idempotencyKey: string,
  comment = '',
) {
  return store.decideChangeRequest(projectId, changeId, actor, {
    decision, idempotencyKey, comment,
    submissionId: submission.id, expectedSnapshotHash: snapshotHash(submission),
  })
}

function scenarioInputs(): ScenarioInputSet {
  const base = { includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['审计记录写入成功'], taskDiffs: [], estimationInput: { source: '测试估算', ruleVersion: 'v1', basis: '测试依据' } }
  return {
    accept: {
      ...base,
      kind: 'accept',
      taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计写入', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }],
    },
    reduce: {
      ...base,
      kind: 'reduce',
      taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }],
    },
    defer: {
      ...base,
      kind: 'defer',
      taskDiffs: [],
    },
  }
}

test('migrates legacy schema and survives repeated startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-d-migrate-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  try {
    const first = new SqliteStore()
    const project = first.createProject({ name: '旧库', repositoryUrl: 'https://github.com/example/old.git' })
    first.createPlan(project.id, buildPlan(requirements, csv))
    first.onModuleDestroy()
    const second = new SqliteStore()
    assert.equal(second.listProjects().length, 1)
    assert.equal(second.listPlans(project.id).length, 1)
    second.onModuleDestroy()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects cross-project references and unauthorized access', (t) => {
  const { store, projectId, member } = setup(t)
  const other = store.createProject({ name: '其他项目', repositoryUrl: 'https://github.com/example/other.git' })
  store.createPlan(other.id, buildPlan(requirements, csv))
  const otherPlan = store.createPlan(other.id, buildPlan(requirements, csv.replace('T1,16,,150', 'T1,18,,150'))).version
  const otherScan = store.enqueueScan(other.id, 'https://github.com/example/other.git', 'HEAD', { layers: [], allowed: [] })
  assert.throws(
    () => store.createChangeRequest(projectId, member, { title: '越权', description: '', basePlanVersion: otherPlan, baseScanId: store.listScans(projectId)[0].id }),
    (error: Error & { code?: string }) => error.code === 'NOT_FOUND',
  )
  assert.throws(
    () => store.createChangeRequest(projectId, member, { title: '越权', description: '', basePlanVersion: 1, baseScanId: otherScan.id }),
    (error: Error & { code?: string }) => error.code === 'NOT_FOUND',
  )
  const outsider: Actor = { id: 'u-other', name: '外人', roles: new Set<'member' | 'approver'>(['member']), projects: new Set([other.id]) }
  assert.throws(
    () => store.createChangeRequest(projectId, outsider, { title: '越权', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id }),
    (error: Error & { code?: string }) => error.code === 'FORBIDDEN',
  )
})

test('enforces draft revision conflicts and freezes content after submission', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, {
    title: '初始标题', description: '草稿', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id,
  })
  assert.throws(
    () => store.updateChangeRequest(projectId, change.id, member, { title: '新标题', expectedRevision: 2 }),
    (error: Error & { code?: string }) => error.code === 'REVISION_CONFLICT',
  )
  store.updateChangeRequest(projectId, change.id, member, { title: '更新标题', expectedRevision: 1 })
  submitChange(store, projectId, change.id, member)
  const pending = store.getChangeRequest(projectId, change.id)!
  assert.equal(pending.status, 'pending')
  assert.throws(
    () => store.updateChangeRequest(projectId, change.id, member, { title: '再改', expectedRevision: pending.draftRevision }),
    (error: Error & { code?: string }) => error.code === 'STATE_CONFLICT',
  )
})

test('rejects unconfirmed mappings, missing estimation, and client-provided metrics', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const change = store.createChangeRequest(projectId, member, {
    title: '校验测试', description: '', basePlanVersion: 1, baseScanId: store.listScans(projectId)[0].id,
  })
  const { analysis: analysisAdapter } = createFixtureAdapters()
  const context: AnalysisContext = {
    projectId,
    changeRequest: change,
    baselinePlan: store.getPlan(projectId, change.basePlanVersion) ?? undefined,
    baselineScan: store.getScan(projectId, change.baseScanId),
    actor: member,
  }
  const draft = analysisAdapter.analyze(context, {})
  store.saveAnalysisRevision(projectId, change.id, member, { ...draft, confirmedBy: null })
  assert.throws(
    () => store.submitChangeRequest(projectId, change.id, member, 'accept'),
    (error: Error & { code?: string }) => error.code === 'STATE_CONFLICT',
  )
  store.saveAnalysisRevision(projectId, change.id, member, draft)
  const analysis = store.listAnalysisRevisions(projectId, change.id)[0]
  const { scenario: scenarioAdapter } = createFixtureAdapters()
  const scenarioContext: ScenarioContext = { ...context, analysis, existingScenarios: [] }
  const input = scenarioInputs()
  const computed = scenarioAdapter.compute(scenarioContext, input)
  assert.throws(
    () => store.saveScenarioRevision(projectId, change.id, member, {
      ...computed,
      scenarios: {
        ...computed.scenarios,
        accept: { ...computed.scenarios.accept, estimationInput: { ...computed.scenarios.accept.estimationInput, source: '' } },
      },
    }),
    (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR',
  )
})

test('approves accept/reduce and publishes only the selected plan', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  const before = store.listPlans(projectId).map((plan) => plan.version)
  const result = decide(store, projectId, changeId, approver, submission, 'approved', 'key-accept', '通过')
  assert.equal(result.decision.publishedPlanVersion, 2)
  assert.equal(result.publishedPlan?.version, 2)
  const after = store.listPlans(projectId).map((plan) => plan.version)
  assert.deepEqual(after, [2, ...before])
  assert.equal(store.getChangeRequest(projectId, changeId)?.status, 'approved')
  assert.equal(store.getPlanLineageParent(projectId, 2), 1)
})

test('rejection does not change plans and resubmission keeps history', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'reduce')
  const before = store.listPlans(projectId).map((plan) => plan.version)
  const rejected = decide(store, projectId, changeId, approver, submission, 'rejected', 'key-reject', '拒绝')
  assert.equal(rejected.decision.publishedPlanVersion, null)
  assert.deepEqual(store.listPlans(projectId).map((plan) => plan.version), before)
  // 拒绝后开新修订并重新提交
  const rejectedChange = store.getChangeRequest(projectId, changeId)!
  store.updateChangeRequest(projectId, changeId, member, { title: '修订后', expectedRevision: rejectedChange.draftRevision })
  const updated = store.getChangeRequest(projectId, changeId)!
  assert.equal(updated.status, 'draft')
  assert.equal(updated.draftRevision, rejectedChange.draftRevision + 1)
  assert.equal(store.listDecisions(projectId, changeId).length, 1)
})

test('defer creates a pending deferred item without changing plans', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'defer')
  const before = store.listPlans(projectId).map((plan) => plan.version)
  const result = decide(store, projectId, changeId, approver, submission, 'approved', 'key-defer', '延期')
  assert.equal(result.decision.publishedPlanVersion, null)
  assert.ok(result.deferredItem)
  assert.equal(result.deferredItem!.schedulingStatus, 'pending')
  assert.deepEqual(store.listPlans(projectId).map((plan) => plan.version), before)
  assert.equal(store.getChangeRequest(projectId, changeId)?.status, 'approved')
})

test('idempotency: same key replays, different payload conflicts, different key conflicts', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  const first = decide(store, projectId, changeId, approver, submission, 'approved', 'key-replay', '同意')
  const replay = decide(store, projectId, changeId, approver, submission, 'approved', 'key-replay', '同意')
  assert.equal(replay.decision.id, first.decision.id)
  assert.equal(replay.decision.publishedPlanVersion, 2)
  assert.equal(store.listPlans(projectId).length, 2)
  assert.throws(
    () => decide(store, projectId, changeId, approver, submission, 'rejected', 'key-replay', '不同意'),
    (error: Error & { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT',
  )
  assert.throws(
    () => decide(store, projectId, changeId, approver, submission, 'approved', 'key-other', '换键'),
    (error: Error & { code?: string }) => error.code === 'ALREADY_DECIDED',
  )
})

test('detects baseline expiry after a manual plan publish', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  store.createPlan(projectId, buildPlan(requirements, csv.replace('T1,16,,150', 'T1,20,,150')))
  assert.throws(
    () => decide(store, projectId, changeId, approver, submission, 'approved', 'key-stale'),
    (error: Error & { code?: string }) => error.code === 'BASELINE_EXPIRED',
  )
})

test('atomic rollback leaves no partial plan or decision', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  const before = store.listPlans(projectId).length
  // 自批应被拒绝，且不发布计划
  assert.throws(
    () => decide(store, projectId, changeId, member, submission, 'approved', 'key-self'),
    (error: Error & { code?: string }) => error.code === 'FORBIDDEN',
  )
  assert.equal(store.listPlans(projectId).length, before)
  assert.equal(store.getChangeRequest(projectId, changeId)?.status, 'pending')
})

test('concurrent approval of the same submission publishes at most once', async (t) => {
  const { store, projectId, member, approver, directory } = setup(t)
  const { changeId } = createPending(store, projectId, member, approver, 'accept')
  const run = (idempotencyKey: string) => new Promise<{ ok: boolean; code?: string; status?: number; stderr?: string }>((resolve, reject) => {
    const outputFile = join(directory, `result-${idempotencyKey}.json`)
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/approve-worker.ts', directory, projectId, changeId, idempotencyKey, outputFile], {
      cwd: join(__dirname, '..'),
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(readFileSync(outputFile, 'utf8')))
      } catch (error) {
        reject(new Error(`approve-worker 结果无法读取（code=${code} signal=${signal}）。stderr: ${stderr}`))
      }
    })
  })
  const results = await Promise.all([run('concurrent-a'), run('concurrent-b')])
  const ok = results.filter((result) => result.ok)
  assert.equal(ok.length, 1)
  assert.equal(store.listPlans(projectId).filter((plan) => plan.version === 2).length, 1)
})

test('concurrent approval of two changes on the same baseline publishes once', async (t) => {
  const { store, projectId, member, approver, directory } = setup(t)
  const first = createPending(store, projectId, member, approver, 'accept')
  const second = createPending(store, projectId, member, approver, 'accept')
  const run = (changeId: string, idempotencyKey: string) => new Promise<{ ok: boolean; code?: string; status?: number; stderr?: string }>((resolve, reject) => {
    const outputFile = join(directory, `result-${idempotencyKey}.json`)
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/approve-worker.ts', directory, projectId, changeId, idempotencyKey, outputFile], {
      cwd: join(__dirname, '..'),
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(readFileSync(outputFile, 'utf8')))
      } catch (error) {
        reject(new Error(`approve-worker 结果无法读取（code=${code} signal=${signal}）。stderr: ${stderr}`))
      }
    })
  })
  const results = await Promise.all([run(first.changeId, 'two-a'), run(second.changeId, 'two-b')])
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => !result.ok && result.code === 'BASELINE_EXPIRED').length, 1)
  assert.equal(store.listPlans(projectId).filter((plan) => plan.version === 2).length, 1)
})

test('restart preserves records and idempotency', (t) => {
  const { store, projectId, member, approver, directory } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  decide(store, projectId, changeId, approver, submission, 'approved', 'key-persist', '通过')
  store.onModuleDestroy()
  process.env.ARCHGUARD_DATA_DIR = directory
  const reopened = new SqliteStore()
  const reopenedSubmission = reopened.getSubmission(projectId, changeId, submission.id)!
  const replay = decide(reopened, projectId, changeId, approver, reopenedSubmission, 'approved', 'key-persist', '通过')
  assert.equal(replay.decision.publishedPlanVersion, 2)
  assert.equal(reopened.listPlans(projectId).length, 2)
  reopened.onModuleDestroy()
})

test('separates approval and implementation status, gates completion', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  decide(store, projectId, changeId, approver, submission, 'approved', 'key-impl', '通过')
  const check = store.saveImplementationCheck(projectId, changeId, member, {
    submissionId: submission.id,
    status: 'in_progress',
    implementationCommit: 'abc'.repeat(13),
  })
  assert.equal(check.status, 'in_progress')
  assert.throws(
    () => store.saveImplementationCheck(projectId, changeId, member, { submissionId: submission.id, status: 'completed' }),
    (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR',
  )
})

test('keeps deferred change waiting until scheduled', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId: deferChangeId, submission: deferSubmission } = createPending(store, projectId, member, approver, 'defer')
  decide(store, projectId, deferChangeId, approver, deferSubmission, 'approved', 'key-defer-impl', '延期')
  assert.throws(
    () => store.saveImplementationCheck(projectId, deferChangeId, member, { submissionId: deferSubmission.id, status: 'in_progress' }),
    (error: Error & { code?: string }) => error.code === 'STATE_CONFLICT',
  )
})

test('report is stable, exposes missing evidence, and never leaks tokens', (t) => {
  const { store, projectId, member, approver } = setup(t)
  const { changeId, submission } = createPending(store, projectId, member, approver, 'accept')
  decide(store, projectId, changeId, approver, submission, 'approved', 'key-report', '通过')
  const change = store.getChangeRequest(projectId, changeId)!
  assert.ok(!JSON.stringify(change).includes('token'))
  const submissionSaved = store.getSubmission(projectId, changeId, submission.id)!
  assert.equal(submissionSaved.snapshot.scenarioRevision.scenarios.accept.estimationInput.source, '测试估算')
  assert.equal(submissionSaved.snapshot.analysis.id, submissionSaved.analysisRevisionId)
  // 历史快照不随最新草稿变化
  assert.equal(submissionSaved.snapshot.scenarioRevision.scenarios.accept.estimationInput.source, '测试估算')
})
