// 用于“读取后、获取提交锁前，草稿被另一进程修改”的并发提交测试。
// 参数：dataDir projectId changeId selectedKind readyFile goFile outFile
import { existsSync, writeFileSync } from 'node:fs'
import type { Actor } from '../src/changes/actor'
import { SqliteStore } from '../src/storage/sqlite-store'

const [dataDir, projectId, changeId, selectedKind, readyFile, goFile, outFile] = process.argv.slice(2)
process.env.ARCHGUARD_DATA_DIR = dataDir
const store = new SqliteStore()
const member: Actor = {
  id: 'u-member',
  name: '成员甲',
  roles: new Set<'member' | 'approver'>(['member']),
  projects: new Set([projectId]),
}

void (async () => {
  try {
    // 事务外预读，模拟“读取后等待提交锁”的旧行为。
    const preChange = store.getChangeRequest(projectId, changeId)
    writeFileSync(readyFile, JSON.stringify({ draftRevision: preChange?.draftRevision ?? 0 }))
    const deadline = Date.now() + 15_000
    while (!existsSync(goFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!existsSync(goFile)) {
      writeFileSync(outFile, JSON.stringify({ ok: false, code: 'TIMEOUT' }))
      return
    }
    const submission = store.submitChangeRequest(projectId, changeId, member, selectedKind as 'accept')
    writeFileSync(outFile, JSON.stringify({ ok: true, revision: submission.revision }))
  } catch (error) {
    const failure = error as { code?: string; status?: number; message?: string }
    writeFileSync(outFile, JSON.stringify({ ok: false, code: failure.code, status: failure.status }))
  } finally {
    store.onModuleDestroy()
  }
})()
