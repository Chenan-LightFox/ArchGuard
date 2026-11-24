// 用于真实多进程并发审批测试。参数：dataDir projectId changeId idempotencyKey outputFile
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { Actor } from '../src/changes/actor'
import { SqliteStore } from '../src/storage/sqlite-store'

const [dataDir, projectId, changeId, idempotencyKey, outputFile] = process.argv.slice(2)
process.env.ARCHGUARD_DATA_DIR = dataDir
const store = new SqliteStore()
const approver: Actor = {
  id: 'u-approver',
  name: '审批',
  roles: new Set<'member' | 'approver'>(['member', 'approver']),
  projects: new Set([projectId]),
}

try {
  const submission = store.getLatestSubmission(projectId, changeId)
  if (!submission) throw Object.assign(new Error('找不到提交'), { code: 'NOT_FOUND', status: 404 })
  const expectedSnapshotHash = createHash('sha256').update(JSON.stringify(submission.snapshot)).digest('hex')
  const result = store.decideChangeRequest(projectId, changeId, approver, {
    decision: 'approved',
    idempotencyKey,
    comment: '并发测试',
    submissionId: submission.id,
    expectedSnapshotHash,
  })
  writeFileSync(outputFile, JSON.stringify({ ok: true, planVersion: result.decision.publishedPlanVersion }))
} catch (error) {
  const failure = error as { code?: string; status?: number; message?: string }
  writeFileSync(outputFile, JSON.stringify({ ok: false, code: failure.code, status: failure.status }))
} finally {
  store.onModuleDestroy()
}
