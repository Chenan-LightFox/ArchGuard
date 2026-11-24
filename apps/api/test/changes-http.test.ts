import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { NestFactory } from '@nestjs/core'
import type { RepositoryScanResult } from '@archguard/contracts'
import { AppModule } from '../src/app.module'
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

async function request(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, init)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

test('real HTTP integration: auth, submit, decide, and report', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-http-'))
  process.env.ARCHGUARD_DATA_DIR = directory
  const store = new SqliteStore()
  const project = store.createProject({ name: 'HTTP 集成', repositoryUrl: 'https://github.com/example/demo.git' })
  store.createPlan(project.id, buildPlan(requirements, csv))
  const scan = store.enqueueScan(project.id, 'https://github.com/example/demo.git', 'HEAD', { layers: [], allowed: [] })
  store.claimScan(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())
  store.finishScan(scan.id, scanResult('abc'.repeat(13)), null)
  store.onModuleDestroy()
  process.env.ARCHGUARD_ACTORS_JSON = JSON.stringify([
    { token: 'member-token', actorId: 'u-member', name: '成员甲', roles: ['member'], projects: [project.id] },
    { token: 'approver-token', actorId: 'u-approver', name: '审批乙', roles: ['member', 'approver'], projects: [project.id] },
  ])
  process.env.ARCHGUARD_ENABLE_DEMO_FIXTURES = '1'

  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  try {
    await app.listen(0, '127.0.0.1')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`本沙箱禁止监听 127.0.0.1（${code}），跳过真实 HTTP 集成测试。`)
      await app.close()
      rmSync(directory, { recursive: true, force: true })
      return
    }
    throw error
  }

  const port = (app.getHttpServer().address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  try {
    const unauth = await request(base, `/api/projects/${project.id}/change-requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', description: '', basePlanVersion: 1, baseScanId: scan.id }),
    })
    assert.equal(unauth.status, 401)

    const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
    const created = await request(base, `/api/projects/${project.id}/change-requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('member-token') },
      body: JSON.stringify({ title: '新增导出审计记录', description: '演示', basePlanVersion: 1, baseScanId: scan.id }),
    })
    assert.equal(created.status, 201)
    const changeId = created.body.id as string

    assert.equal((await request(base, `/api/projects/${project.id}/change-requests/${changeId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('member-token') }, body: '{}',
    })).status, 201)
    const scenarioBody = {
      accept: { kind: 'accept', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: ['写入成功'], taskDiffs: [{ taskId: 'T4', operation: 'add', title: '审计', requirementIds: ['REQ-07'], effortHours: 8, durationDays: 1, hourlyRate: 120 }], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
      reduce: { kind: 'reduce', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [{ taskId: 'T1', operation: 'modify', effortHours: 22 }], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
      defer: { kind: 'defer', includedScope: ['REQ-07'], excludedScope: [], acceptanceCriteria: [], taskDiffs: [], estimationInput: { source: 's', ruleVersion: 'v1', basis: 'b' } },
    }
    assert.equal((await request(base, `/api/projects/${project.id}/change-requests/${changeId}/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('member-token') }, body: JSON.stringify(scenarioBody),
    })).status, 201)

    const submitted = await request(base, `/api/projects/${project.id}/change-requests/${changeId}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('member-token') }, body: JSON.stringify({ selectedKind: 'accept' }),
    })
    assert.equal(submitted.status, 200)
    const submission = submitted.body as unknown as { id: string; snapshot: unknown }
    const snapshotHash = createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')

    const missing = await request(base, `/api/projects/${project.id}/change-requests/${changeId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('approver-token') },
      body: JSON.stringify({ decision: 'approved', idempotencyKey: 'http-1', comment: '' }),
    })
    assert.equal(missing.status, 400)

    const wrongHash = await request(base, `/api/projects/${project.id}/change-requests/${changeId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('approver-token') },
      body: JSON.stringify({ decision: 'approved', idempotencyKey: 'http-1', comment: '', submissionId: submission.id, expectedSnapshotHash: 'f'.repeat(64) }),
    })
    assert.equal(wrongHash.status, 409)

    const decision = await request(base, `/api/projects/${project.id}/change-requests/${changeId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('approver-token') },
      body: JSON.stringify({ decision: 'approved', idempotencyKey: 'http-1', comment: '通过', submissionId: submission.id, expectedSnapshotHash: snapshotHash }),
    })
    assert.equal(decision.status, 200)
    assert.equal((decision.body as unknown as { decision: { publishedPlanVersion: number } }).decision.publishedPlanVersion, 2)

    const report = await request(base, `/api/projects/${project.id}/change-requests/${changeId}/report?submissionId=${submission.id}`, { headers: auth('member-token') })
    assert.equal(report.status, 200)
    assert.equal((report.body as unknown as { published: { planVersion: number } }).published.planVersion, 2)
    assert.ok(!JSON.stringify(report.body).includes('member-token'))
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
