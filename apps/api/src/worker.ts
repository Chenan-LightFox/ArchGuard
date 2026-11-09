import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { version as typescriptVersion } from 'typescript'
import { SqliteStore } from './storage/sqlite-store'

const runFile = promisify(execFile)
const leaseMs = 30_000

async function runWorker(): Promise<void> {
  const store = new SqliteStore()
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.info('ArchGuard 扫描进程已启动，等待环境检查任务。')

  try {
    while (!stopping) {
      const now = Date.now()
      const job = store.claimPreflight(new Date(now).toISOString(), new Date(now + leaseMs).toISOString())
      if (!job) {
        await delay(500)
        continue
      }

      const git = await runFile('git', ['--version'], { timeout: 5_000, windowsHide: true }).catch(() => null)
      if (git) {
        store.finishPreflight(job.id, { git: git.stdout.trim(), typescript: typescriptVersion }, null)
      } else {
        store.finishPreflight(job.id, null, 'Git 不可用或版本检查超时，请确认已安装 Git 并加入 PATH。')
      }
    }
  } finally {
    store.onModuleDestroy()
  }
}

runWorker().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
