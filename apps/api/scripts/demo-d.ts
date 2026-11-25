// 角色 D 演示脚本：使用测试夹具，不依赖前端与真实 B/C 模型。
// 运行：npm run demo:d -w @archguard/api
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor } from '../src/changes/actor'
import { ActorResolver } from '../src/changes/actor'
import { createFixtureAdapters } from '../src/changes/fixture-adapters'
import { ReportsController } from '../src/reports/reports.module'
import { SqliteStore } from '../src/storage/sqlite-store'
import { buildPlan } from '../src/plans/build-plan'
import { detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import type { AnalysisContext } from '../src/changes/adapters'
import type { ChangeSubmission, ScenarioInputSet } from '@archguard/contracts'

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,导出服务,REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\n')

const memberToken = 'demo-member-token'
const approverToken = 'demo-approver-token'

function scenarioInputs(): ScenarioInputSet {
  const base = { includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['审计记录写入成功'], taskDiffs: [], estimationInput: { source: '演示夹具来源', ruleVersion: 'v1', basis: '演示估算依据' } }
  return {
    accept: { ...base, kind: 'accept', taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计写入', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }] },
    reduce: { ...base, kind: 'reduce', taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }] },
    defer: { ...base, kind: 'defer', taskDiffs: [] },
  }
}

function scenarioInputsExisting(): ScenarioInputSet {
  const base = { includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['审计记录写入成功'], taskDiffs: [], estimationInput: { source: '演示夹具来源', ruleVersion: 'v1', basis: '演示估算依据' } }
  return {
    accept: { ...base, kind: 'accept', taskDiffs: [{ taskId: 'T2', operation: 'modify', effortHours: 20 }] },
    reduce: { ...base, kind: 'reduce', taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 18 }] },
    defer: { ...base, kind: 'defer', taskDiffs: [] },
  }
}

function snapshotHash(submission: ChangeSubmission): string {
  return createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
}

function run(): void {
  const dataDir = process.env.ARCHGUARD_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'archguard-demo-'))
  process.env.ARCHGUARD_DATA_DIR = dataDir
  const store = new SqliteStore()
  try {
    const project = store.createProject({ name: '演示项目', repositoryUrl: 'https://github.com/example/demo.git' })
    const v1 = store.createPlan(project.id, buildPlan(requirements, csv))
    const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
    store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
    const files = ['src/export/a.ts', 'src/test/b.ts']
    const graph = {
      files,
      dependencies: [{ from: files[0], to: files[1], kind: 'import' as const, line: 1, specifier: '../test/b' }],
      unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
    }
    store.finishScan(scan.id, { ...graph, commit: 'a'.repeat(40), analyzerVersion: '1/ts-demo', skippedFiles: 0, architecture: detectArchitecture(graph, parseArchitectureRules(undefined)) }, null)

    process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
      { token: memberToken, actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [project.id] },
      { token: approverToken, actorId: 'u-approver', name: '审批乙', roles: ['member', 'approver'], projects: [project.id] },
    ])
    const actors = new ActorResolver()
    const member = actors.resolve(`Bearer ${memberToken}`) as Actor
    const approver = actors.resolve(`Bearer ${approverToken}`) as Actor
    const { analysis: analysisAdapter, scenario: scenarioAdapter } = createFixtureAdapters()

    const step = (label: string, value: unknown): void => {
      console.info(`\n== ${label} ==`)
      console.info(JSON.stringify(value, null, 2))
    }

    const prepare = (title: string, description: string, basePlanVersion: number, selectedKind: 'accept' | 'reduce' | 'defer') => {
      const item = store.createChangeRequest(project.id, member, { title, description, basePlanVersion, baseScanId: scan.id })
      const context: AnalysisContext = { projectId: project.id, changeRequest: item, baselinePlan: store.getPlan(project.id, basePlanVersion) ?? undefined, baselineScan: store.getScan(project.id, scan.id), actor: member }
      const analysis = store.saveAnalysisRevision(project.id, item.id, member, analysisAdapter.analyze(context, {}))
      const inputs = basePlanVersion === 2 ? scenarioInputsExisting() : scenarioInputs()
      store.saveScenarioRevision(project.id, item.id, member, scenarioAdapter.compute({ ...context, analysis, existingScenarios: [] }, inputs))
      const submission = store.submitChangeRequest(project.id, item.id, member, selectedKind)
      return { changeId: item.id, submission }
    }

    const change = prepare('新增导出审计记录', '演示变更', v1.version, 'accept')
    step('v1 创建并提交申请', { changeId: change.changeId, selectedKind: 'accept' })
    const stale = prepare('旧基线申请', '与上一项共用 v1 基线', v1.version, 'accept')
    step('提交第二项旧基线申请', { changeId: stale.changeId })

    const approved = store.decideChangeRequest(project.id, change.changeId, approver, {
      decision: 'approved', idempotencyKey: 'demo-approve-1', comment: '通过',
      submissionId: change.submission.id, expectedSnapshotHash: snapshotHash(change.submission),
    })
    step('批准第一项得到 v2', { planVersion: approved.decision.publishedPlanVersion })

    const replay = store.decideChangeRequest(project.id, change.changeId, approver, {
      decision: 'approved', idempotencyKey: 'demo-approve-1', comment: '通过',
      submissionId: change.submission.id, expectedSnapshotHash: snapshotHash(change.submission),
    })
    step('重复请求不新增版本', { sameDecisionId: replay.decision.id === approved.decision.id, planCount: store.listPlans(project.id).length })

    let staleResult = '意外成功'
    try {
      store.decideChangeRequest(project.id, stale.changeId, approver, {
        decision: 'approved', idempotencyKey: 'demo-stale', comment: '',
        submissionId: stale.submission.id, expectedSnapshotHash: snapshotHash(stale.submission),
      })
    } catch (error) {
      staleResult = (error as { code?: string }).code ?? '未知错误'
    }
    step('旧基线申请批准失败', { code: staleResult })

    const rejectChange = prepare('被拒绝申请', '基于 v2', 2, 'reduce')
    store.decideChangeRequest(project.id, rejectChange.changeId, approver, {
      decision: 'rejected', idempotencyKey: 'demo-reject', comment: '范围不合适',
      submissionId: rejectChange.submission.id, expectedSnapshotHash: snapshotHash(rejectChange.submission),
    })
    step('拒绝申请不改计划', { planCount: store.listPlans(project.id).length, status: store.getChangeRequest(project.id, rejectChange.changeId)?.status })

    const deferChange = prepare('延期申请', '基于 v2', 2, 'defer')
    const deferred = store.decideChangeRequest(project.id, deferChange.changeId, approver, {
      decision: 'approved', idempotencyKey: 'demo-defer', comment: '延后实施',
      submissionId: deferChange.submission.id, expectedSnapshotHash: snapshotHash(deferChange.submission),
    })
    step('延期待办', { deferredItemId: deferred.deferredItem?.id, planCount: store.listPlans(project.id).length })

    const report = new ReportsController(store, actors).report(project.id, change.changeId, undefined, undefined, `Bearer ${memberToken}`)
    step('查询报告', { publishedPlanVersion: report.published.planVersion, limitations: report.limitations })
  } finally {
    store.onModuleDestroy()
  }
}

run()
