import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpException } from '@nestjs/common'
import { test } from 'node:test'
import type { ChangeSubmission, RepositoryScanResult } from '@archguard/contracts'
import { ActorResolver } from '../src/changes/actor'
import { createFixtureAdapters } from '../src/changes/fixture-adapters'
import { NotConnectedAnalysisAdapter, NotConnectedScenarioAdapter } from '../src/changes/adapters'
import { ChangesController } from '../src/changes/changes.module'
import { ImplementationController } from '../src/implementation/implementation.module'
import { ReportsController } from '../src/reports/reports.module'
import { buildPlan } from '../src/plans/build-plan'
import { detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import { SqliteStore } from '../src/storage/sqlite-store'

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,导出服务,REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\n')

function scanResult(commit: string): RepositoryScanResult {
  const graph = {
    files: ['src/export/a.ts', 'src/test/b.ts'],
    dependencies: [{ from: 'src/export/a.ts', to: 'src/test/b.ts', kind: 'import' as const, line: 1, specifier: '../test/b' }],
    unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
  }
  return { ...graph, commit, analyzerVersion: '1/ts-test', skippedFiles: 0, architecture: detectArchitecture(graph, parseArchitectureRules(undefined)) }
}

function bodyOf(error: unknown): { code?: string; status?: number } {
  const http = error as HttpException
  return http.getResponse() as { code?: string; status?: number }
}

function snapshotHash(submission: ChangeSubmission): string {
  return createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
}

test('controller enforces auth, roles, validation, and builds a stable report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-controller-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  try {
    const project = store.createProject({ name: '控制器演示', repositoryUrl: 'https://github.com/example/demo.git' })
    store.createPlan(project.id, buildPlan(requirements, csv))
    const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
    store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
    store.finishScan(scan.id, scanResult('abc'.repeat(13)), null)
    process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
      { token: 'member-token', actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [project.id] },
      { token: 'approver-token', actorId: 'u-approver', name: '审批乙', roles: ['member', 'approver'], projects: [project.id] },
    ])
    const actors = new ActorResolver()
    const { analysis: analysisAdapter, scenario: scenarioAdapter } = createFixtureAdapters()
    const changes = new ChangesController(store, actors, analysisAdapter, scenarioAdapter)
    const implementation = new ImplementationController(store, actors)
    const reports = new ReportsController(store, actors)

    assert.throws(() => changes.create(project.id, undefined, { title: 'x', description: '', basePlanVersion: 1, baseScanId: scan.id }), (error: Error & { code?: string }) => bodyOf(error).code === 'NOT_AUTHENTICATED')
    const created = changes.create(project.id, 'Bearer member-token', { title: '新增导出审计记录', description: '演示', basePlanVersion: 1, baseScanId: scan.id })
    const changeId = created.id

    const analysis = changes.addAnalysis(project.id, changeId, 'Bearer member-token', {})
    assert.ok(analysis.id)

    assert.throws(() => changes.addScenarios(project.id, changeId, 'Bearer member-token', {
      accept: { kind: 'accept', includedScope: [], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' }, metrics: { fake: true } },
      reduce: { kind: 'reduce', includedScope: [], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
      defer: { kind: 'defer', includedScope: [], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
    }), (error: Error & { code?: string }) => bodyOf(error).code === 'VALIDATION_ERROR')

    const scenarioInput = {
      accept: { kind: 'accept', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['写入成功'], taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }], estimationInput: { source: '测试来源', ruleVersion: 'v1', basis: '测试依据' } },
      reduce: { kind: 'reduce', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }], estimationInput: { source: '测试来源', ruleVersion: 'v1', basis: '测试依据' } },
      defer: { kind: 'defer', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: '测试来源', ruleVersion: 'v1', basis: '测试依据' } },
    }
    changes.addScenarios(project.id, changeId, 'Bearer member-token', scenarioInput)
    const submission = changes.submit(project.id, changeId, 'Bearer member-token', { selectedKind: 'accept' })

    const decideBody = { decision: 'approved' as const, idempotencyKey: 'c1', comment: '通过', submissionId: submission.id, expectedSnapshotHash: snapshotHash(submission) }
    assert.throws(() => changes.decide(project.id, changeId, 'Bearer member-token', { ...decideBody, comment: '' }), (error: Error & { code?: string }) => bodyOf(error).code === 'FORBIDDEN')
    const decision = changes.decide(project.id, changeId, 'Bearer approver-token', decideBody)
    assert.equal(decision.decision.publishedPlanVersion, 2)

    implementation.record(project.id, changeId, 'Bearer member-token', { submissionId: submission.id, status: 'in_progress', implementationCommit: 'abc'.repeat(13) })
    const report = reports.report(project.id, changeId, undefined, undefined, 'Bearer member-token')
    assert.equal(report.published.planVersion, 2)
    assert.equal(report.implementation?.status, 'in_progress')
    assert.ok(report.limitations.some((line) => line.includes('实施证据不完整')))
    assert.ok(!JSON.stringify(report).includes('member-token'))
  } finally {
    store.onModuleDestroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('returns not-ready when B/C adapters are not connected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-controller-notready-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  try {
    const project = store.createProject({ name: '未接通', repositoryUrl: 'https://github.com/example/demo.git' })
    store.createPlan(project.id, buildPlan(requirements, csv))
    const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
    store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
    store.finishScan(scan.id, scanResult('abc'.repeat(13)), null)
    process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
      { token: 'member-token', actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [project.id] },
    ])
    const actors = new ActorResolver()
    const changes = new ChangesController(store, actors, new NotConnectedAnalysisAdapter(), new NotConnectedScenarioAdapter())
    const created = changes.create(project.id, 'Bearer member-token', { title: 'x', description: '', basePlanVersion: 1, baseScanId: scan.id })
    assert.throws(() => changes.addAnalysis(project.id, created.id, 'Bearer member-token', {}), (error: Error & { code?: string }) => bodyOf(error).code === 'NOT_READY')
  } finally {
    store.onModuleDestroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects wrong submission and reports non-comparable rescans', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-controller-rescan-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  try {
    const project = store.createProject({ name: '复扫演示', repositoryUrl: 'https://github.com/example/demo.git' })
    store.createPlan(project.id, buildPlan(requirements, csv))
    const scan1 = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
    store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
    store.finishScan(scan1.id, scanResult('abc'.repeat(13)), null)
    const scan2 = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [{ name: 'UI', prefix: 'src/export' }], allowed: [] })
    store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
    const graph2 = {
      files: ['src/export/a.ts', 'src/test/b.ts'],
      dependencies: [{ from: 'src/export/a.ts', to: 'src/test/b.ts', kind: 'import' as const, line: 1, specifier: '../test/b' }],
      unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
    }
    store.finishScan(scan2.id, { ...graph2, commit: 'abc'.repeat(13), analyzerVersion: '1/ts-test', skippedFiles: 0, architecture: detectArchitecture(graph2, parseArchitectureRules({ layers: [{ name: 'UI', prefix: 'src/export' }], allowed: [] })) }, null)
    process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
      { token: 'member-token', actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [project.id] },
      { token: 'approver-token', actorId: 'u-approver', name: '审批乙', roles: ['member', 'approver'], projects: [project.id] },
    ])
    const actors = new ActorResolver()
    const { analysis: analysisAdapter, scenario: scenarioAdapter } = createFixtureAdapters()
    const changes = new ChangesController(store, actors, analysisAdapter, scenarioAdapter)
    const implementation = new ImplementationController(store, actors)
    const reports = new ReportsController(store, actors)
    const scenarioInput = {
      accept: { kind: 'accept', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
      reduce: { kind: 'reduce', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
      defer: { kind: 'defer', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
    }
    const submitOnly = () => {
      const change = changes.create(project.id, 'Bearer member-token', { title: '复扫', description: '', basePlanVersion: 1, baseScanId: scan1.id })
      changes.addAnalysis(project.id, change.id, 'Bearer member-token', {})
      changes.addScenarios(project.id, change.id, 'Bearer member-token', scenarioInput)
      const submission = changes.submit(project.id, change.id, 'Bearer member-token', { selectedKind: 'accept' })
      return { changeId: change.id, submissionId: submission.id, submission }
    }
    const a = submitOnly()
    const b = submitOnly()
    changes.decide(project.id, a.changeId, 'Bearer approver-token', { decision: 'approved', idempotencyKey: 'id-a', comment: '', submissionId: a.submissionId, expectedSnapshotHash: snapshotHash(a.submission) })
    assert.throws(() => implementation.record(project.id, a.changeId, 'Bearer member-token', { submissionId: b.submissionId, status: 'in_progress' }), (error: Error & { code?: string }) => bodyOf(error).code === 'NOT_FOUND')
    implementation.record(project.id, a.changeId, 'Bearer member-token', { submissionId: a.submissionId, status: 'in_progress', implementationCommit: 'abc'.repeat(13), postScanId: scan2.id })
    const report = reports.report(project.id, a.changeId, undefined, undefined, 'Bearer member-token')
    assert.equal(report.rescan.comparable, false)
    assert.ok(report.rescan.reason?.includes('规则版本'))
  } finally {
    store.onModuleDestroy()
    rmSync(directory, { recursive: true, force: true })
  }
})
