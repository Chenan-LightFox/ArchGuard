import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareArchitecture, detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import { buildPlan } from '../src/plans/build-plan'
import { buildScenarios } from '../src/plans/build-scenarios'
import { analyzeChange } from '../src/changes/analyze-change'
import { parseAiReview } from '../src/changes/changes.module'
import type { ChangeAnalysisResult, PlanVersion, RepositoryAnalysis, RepositoryScanResult } from '@archguard/contracts'
import { SqliteStore } from '../src/storage/sqlite-store'

const graph: RepositoryAnalysis = {
  files: ['ui/a.ts', 'core/b.ts', 'core/c.ts', 'loose.ts'],
  dependencies: [
    { from: 'ui/a.ts', to: 'core/b.ts', kind: 'import', line: 1, specifier: '../core/b' },
    { from: 'core/b.ts', to: 'ui/a.ts', kind: 'import', line: 2, specifier: '../ui/a' },
    { from: 'core/c.ts', to: 'core/c.ts', kind: 'require', line: 3, specifier: './c' },
    { from: 'core/b.ts', to: 'core/c.ts', kind: 'type', line: 4, specifier: './c' },
  ],
  unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
}

test('reports cycles and forbidden layer edges with line evidence and stable fingerprints', () => {
  const rules = parseArchitectureRules({
    layers: [{ name: 'UI', prefix: 'ui/' }, { name: 'Core', prefix: 'core' }],
    allowed: [{ from: 'UI', to: 'Core' }],
  })
  const result = detectArchitecture(graph, rules)
  const cycles = result.issues.filter((issue) => issue.rule === 'cycle')
  assert.equal(cycles.length, 2)
  for (const issue of cycles) assert.equal(issue.path.at(0), issue.path.at(-1))
  assert.deepEqual(result.issues.filter((issue) => issue.rule === 'layer').map((issue) => issue.evidence[0].line), [2])
  assert.deepEqual(result.unassignedFiles, ['loose.ts'])
  assert.equal(result.coverageLimited, true)
  const withSelfLoop = detectArchitecture({
    ...graph,
    dependencies: [{ from: 'core/b.ts', to: 'core/b.ts', kind: 'import', line: 8, specifier: './b' }, ...graph.dependencies],
  }, rules)
  assert.ok(withSelfLoop.issues.some((issue) => issue.rule === 'cycle' && issue.path.includes('ui/a.ts')))
  const moved = detectArchitecture({ ...graph, dependencies: graph.dependencies.map((edge) => ({ ...edge, line: edge.line + 4 })) }, rules)
  assert.deepEqual(moved.issues.map((issue) => issue.id), result.issues.map((issue) => issue.id))
  const after = detectArchitecture({ ...graph, dependencies: graph.dependencies.slice(2) }, rules)
  assert.equal(compareArchitecture(result, after).missing.length, 2)
  assert.throws(() => compareArchitecture(result, detectArchitecture(graph, parseArchitectureRules(undefined))))
})

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,"导出,服务",REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\r\n')

test('imports a baseline and distinguishes effort from delivery duration', () => {
  const plan = buildPlan(requirements, csv)
  assert.equal(plan.tasks[0].title, '导出,服务')
  assert.equal(plan.tasks[1].earliestStart, 2)
  assert.equal(plan.metrics.durationDays, 5)
  assert.equal(plan.metrics.effortHours, 72)
  assert.equal(plan.metrics.cost, 8000)
  assert.deepEqual(plan.metrics.criticalPath, ['T3'])
  assert.equal(buildPlan(requirements, csv.replace('T1,16,,100', 'T1,24,,100')).metrics.durationDays, 5)
  assert.throws(() => buildPlan(requirements, csv.replace('REQ-07,,16', 'REQ-07,T2,16')), /循环/)
  assert.throws(() => buildPlan(requirements, csv.replace('REQ-07,T1', 'REQ-07,unknown')), /前置/)
  assert.throws(() => buildPlan(requirements, csv.replace('16,,150', '-16,,150')), /工时/)
})

test('rounds the sum of decimal labor costs to cents', () => {
  assert.equal(buildPlan(requirements, header + '\nT1,测试,REQ-07,,1.005,,1,').metrics.cost, 1.01)
})

test('traces requirement, reverse code dependencies, and downstream task scheduling with evidence', () => {
  const plan: PlanVersion = {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    requirements: [{ id: 'REQ-01', title: '导出审计记录', description: '保存导出事件。' }],
    tasks: [
      { id: 'T1', title: '修改导出服务', requirementIds: ['REQ-01'], predecessorIds: [], modulePaths: ['src/core'], effortHours: 8, durationDays: 1, hourlyRate: 1, earliestStart: 0, earliestFinish: 1 },
      { id: 'T2', title: '回归测试', requirementIds: [], predecessorIds: ['T1'], modulePaths: [], effortHours: 4, durationDays: 0.5, hourlyRate: 1, earliestStart: 1, earliestFinish: 1.5 },
      { id: 'T3', title: '界面复核', requirementIds: [], predecessorIds: [], modulePaths: ['src/ui'], effortHours: 2, durationDays: 0.25, hourlyRate: 1, earliestStart: 0, earliestFinish: 0.25 },
    ],
    metrics: { effortHours: 14, durationDays: 1.5, cost: 14, criticalPath: ['T1', 'T2'] },
  }
  const scan: RepositoryScanResult = {
    files: ['src/core/export.ts', 'src/api.ts', 'src/ui/view.ts'],
    dependencies: [
      { from: 'src/api.ts', to: 'src/core/export.ts', kind: 'import', line: 4, specifier: './core/export' },
      { from: 'src/ui/view.ts', to: 'src/api.ts', kind: 'import', line: 7, specifier: '../api' },
    ],
    unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
    commit: 'a'.repeat(40), analyzerVersion: '1/test', skippedFiles: 0,
  }
  const result = analyzeChange(
    { description: 'T1 修改导出服务 REQ-01', scanId: 'scan-id', planVersion: 1 },
    scan,
    plan,
  )

  assert.deepEqual(result.matchedRequirementIds, ['REQ-01'])
  assert.deepEqual(result.affectedTasks.map(({ taskId, classification }) => [taskId, classification]), [
    ['T1', 'change'], ['T2', 'schedule'], ['T3', 'review'],
  ])
  assert.deepEqual(result.affectedTasks[2].path, [
    'T3', 'src/ui', 'src/ui/view.ts', 'src/api.ts', 'src/core/export.ts',
  ])
  assert.deepEqual(result.affectedFiles.map(({ file }) => file), ['src/core/export.ts', 'src/api.ts', 'src/ui/view.ts'])
  assert.ok(result.evidence.some(({ description }) => description === 'src/api.ts:4 import → src/core/export.ts'))
  assert.deepEqual(result.candidates.map(({ taskId }) => taskId), ['T1', 'T2', 'T3'])
  assert.equal(result.coverageLimited, false)
  const limited = analyzeChange(
    { description: 'T1 修改导出服务 REQ-01', scanId: 'scan-id', planVersion: 1 },
    { ...scan, unresolved: [{ from: 'src/unknown.ts', specifier: './missing', line: 2, kind: 'import' }] },
    plan,
  )
  assert.equal(limited.coverageLimited, true)
  assert.deepEqual(limited.coverageWarnings, ['1 条依赖未解析'])
  const requirementOnly = analyzeChange(
    { description: 'REQ-01 导出审计记录', scanId: 'scan-id', planVersion: 1 },
    scan,
    plan,
  )
  assert.deepEqual(requirementOnly.affectedTasks.map(({ taskId, classification }) => [taskId, classification]), [
    ['T1', 'review'], ['T2', 'schedule'], ['T3', 'review'],
  ])
  assert.equal(requirementOnly.candidates.find(({ taskId }) => taskId === 'T1')?.classification, 'review')

  const mailPlan: PlanVersion = {
    ...plan,
    requirements: [{ id: 'REQ-03', title: '邮件接收与存储', description: '接收邮件并保存到收件箱。' }],
    tasks: [
      { ...plan.tasks[0], id: 'T4', title: '实现发件队列消费者', requirementIds: ['REQ-03'], predecessorIds: [], modulePaths: ['src/mail/queue'] },
      { ...plan.tasks[0], id: 'T5', title: '实现收件箱存储与已读状态', requirementIds: ['REQ-03'], predecessorIds: ['T4'], modulePaths: ['src/mail/inbox'] },
      { ...plan.tasks[0], id: 'T6', title: '实现邮件列表与详情页', requirementIds: ['REQ-03'], predecessorIds: ['T5'], modulePaths: ['src/web/inbox'] },
      { ...plan.tasks[0], id: 'T7', title: '实现搜索索引与查询接口', requirementIds: [], predecessorIds: ['T5'], modulePaths: ['src/mail/search'] },
      { ...plan.tasks[0], id: 'T8', title: '实现搜索页前端', requirementIds: [], predecessorIds: ['T7'], modulePaths: ['src/web/search'] },
    ],
  }
  const mailScan: RepositoryScanResult = {
    ...scan,
    files: [
      'src/mail/queue/consumer.ts', 'src/mail/inbox/store.ts', 'src/web/inbox/list.ts',
      'src/mail/search/index.ts', 'src/web/search/page.ts',
    ],
  }
  const mailResult = analyzeChange(
    { description: 'REQ-03 邮件接收与存储', scanId: 'scan-id', planVersion: 1 },
    mailScan,
    mailPlan,
  )
  assert.deepEqual(mailResult.affectedTasks.map(({ taskId, classification }) => [taskId, classification]), [
    ['T4', 'review'], ['T5', 'review'], ['T6', 'review'], ['T7', 'schedule'], ['T8', 'schedule'],
  ])
})

test('persists, claims, updates, and deletes change analyses with project data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'archguard-change-test-'))
  const previousDataDir = process.env.ARCHGUARD_DATA_DIR
  process.env.ARCHGUARD_DATA_DIR = dataDir
  let store: SqliteStore | undefined
  try {
    store = new SqliteStore()
    const project = store.createProject({ name: 'Change test', repositoryUrl: 'https://example.test/repo' })
    const plan = store.createPlan(project.id, buildPlan(requirements, csv))
    const now = Date.now()
    const queuedScan = store.enqueueScan(project.id, project.repositoryUrl, 'HEAD', parseArchitectureRules(undefined))
    const claimedScan = store.claimScan(new Date(now).toISOString(), new Date(now + 60_000).toISOString())
    assert.ok(claimedScan)
    const scanResult: RepositoryScanResult = {
      files: [], dependencies: [], unresolved: [], externalCount: 0, configurationWarnings: [],
      syntaxWarningFiles: [], computedImportCount: 0, commit: 'a'.repeat(40), analyzerVersion: '1/test', skippedFiles: 0,
    }
    store.finishScan(claimedScan.id, scanResult, null)
    const queued = store.enqueueChangeAnalysis(project.id, {
      description: 'REQ-07 导出记录', scanId: queuedScan.id, planVersion: plan.version,
    })
    assert.equal(queued.status, 'queued')
    const claimed = store.claimChangeAnalysis(new Date(now).toISOString(), new Date(now + 60_000).toISOString())
    assert.equal(claimed?.id, queued.id)
    assert.equal(claimed?.projectId, project.id)

    const result = analyzeChange(
      { description: queued.description, scanId: queued.scanId, planVersion: queued.planVersion },
      scanResult,
      plan,
    )
    store.finishChangeAnalysis(queued.id, result, null)
    assert.equal(store.getChangeAnalysis(project.id, queued.id)?.status, 'succeeded')
    assert.deepEqual(store.updateChangeAnalysisResult(queued.id, {
      ...result,
      confirmedTaskIds: result.candidates.map(({ taskId }) => taskId),
    })?.result?.confirmedTaskIds, result.candidates.map(({ taskId }) => taskId))
    assert.equal(store.deleteProject(project.id), true)
  } finally {
    store?.onModuleDestroy()
    if (previousDataDir === undefined) delete process.env.ARCHGUARD_DATA_DIR
    else process.env.ARCHGUARD_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('preserves program candidates while validating AI verdicts, upstream tasks, and independent paths', () => {
  const result: ChangeAnalysisResult = {
    matchedRequirementIds: [],
    coverageLimited: false,
    coverageWarnings: [],
    candidates: [
      { taskId: 'T1', title: '导出服务', classification: 'review', path: ['T1'], evidenceIds: ['E1'] },
      { taskId: 'T2', title: '导出界面', classification: 'schedule', path: ['T1', 'T2'], evidenceIds: ['E2'] },
    ],
    affectedTasks: [],
    affectedFiles: [],
    evidence: [],
    aiCandidates: [],
    upstreamTasks: [{
      taskId: 'T0', title: '认证服务', requirementIds: [], modulePaths: ['src/auth'],
      path: ['T0', 'T1'], evidenceIds: ['E3'],
    }],
    confirmedTaskIds: [],
  }
  const json = '{"candidates":[{"taskId":"T1","verdict":"unaffected","rationale":"任务只维护导出服务，不涉及本次变更。"},{"taskId":"UNKNOWN","verdict":"affected","rationale":"未知任务"}],"upstreamTasks":[{"taskId":"T0","verdict":"affected","rationale":"该服务提供的认证接口需要修改。"}],"newRequirements":[{"independent":true,"title":"通知中心","description":"新增独立通知中心。","rationale":"现有需求、任务和模块清单均无通知功能。"}]}'
  const reviewed = parseAiReview(`\`\`\`json\n${json}\n\`\`\``, result, true)
  assert.deepEqual(reviewed.aiCandidates.map(({ taskId, verdict, classification, evidenceIds }) =>
    [taskId, verdict, classification, evidenceIds]), [
    ['T1', 'unaffected', 'review', ['E1']],
    ['T2', 'uncertain', 'schedule', ['E2']],
  ])
  assert.equal(reviewed.aiUpstreamImpacts?.[0].verdict, 'affected')
  assert.deepEqual(reviewed.newRequirements?.map(({ id, requiresArchitectureReview }) =>
    [id, requiresArchitectureReview]), [['New0', true]])
  assert.ok(reviewed.aiWarnings?.some((warning) => warning.includes('UNKNOWN')))

  const incompleteInventory = parseAiReview(
    `结果如下：\n${json}\n以上为候选。`,
    result,
    false,
  )
  assert.deepEqual(incompleteInventory.newRequirements, [])
  assert.ok(incompleteInventory.aiWarnings?.some((warning) => warning.includes('资料不完整')))
  assert.throws(() => parseAiReview('没有 JSON 输出', result, true), /不是有效 JSON/)
  assert.throws(() => parseAiReview('{"upstreamTasks":[]}', result, true), /缺少有效的复核结果/)
})

test('compares accept, reduce and defer scenarios against one baseline', () => {
  const base = buildPlan(requirements, csv)
  const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
  const acceptCsv = [
    header,
    'T1,导出服务,REQ-07,,32,,150,src/export/',
    'T2,回归测试,REQ-07,T1,12,,100,test/',
  ].join('\n')
  const reduceCsv = [
    header,
    'T1,仅记录事件,REQ-07,,22,,150,src/export/',
    'T2,回归测试,REQ-07,T1,10,,100,test/',
  ].join('\n')
  const result = buildScenarios(base, 1, {
    basePlanVersion: 1,
    acceptTasksCsv: acceptCsv,
    reduceTasksCsv: reduceCsv,
    deferTasksCsv: acceptCsv,
  })
  assert.equal(result.scenarios.length, 3)
  assert.deepEqual(result.scenarios.map((item) => item.kind), ['accept', 'reduce', 'defer'])
  assert.equal(result.scenarios[0].delta.effortHours, -28)
  assert.equal(result.scenarios[1].delta.effortHours, -40)
  assert.equal(result.scenarios[2].delta.effortHours, 0)
  assert.equal(result.scenarios[2].futurePlan?.metrics.effortHours, 44)
})
