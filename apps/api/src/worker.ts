import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { version as typescriptVersion } from 'typescript'
import { SqliteStore } from './storage/sqlite-store'
import { scanRepository } from './scans/git-snapshot'
import { gitStartupError, resolveGitExecutable } from './scans/git-executable'
import { detectArchitecture } from './architecture/rules'

const runFile = promisify(execFile)
const leaseMs = 30_000

async function runWorker(): Promise<void> {
  const store = new SqliteStore()
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.info('ArchGuard 扫描进程已启动，等待仓库扫描或环境检查。')

  try {
    while (!stopping) {
      const now = Date.now()
      const job = store.claimPreflight(new Date(now).toISOString(), new Date(now + leaseMs).toISOString())
      if (!job) {
        const scan = store.claimScan(new Date(now).toISOString(), new Date(now + 300_000).toISOString())
        if (!scan) {
          await delay(500)
          continue
        }
        try {
          const result = await scanRepository(scan.repositoryUrl, scan.ref)
          store.finishScan(scan.id, { ...result, architecture: detectArchitecture(result, scan.rules) }, null)
        } catch (error) {
          const message = error instanceof Error && !('cmd' in error) ? error.message : '无法读取 Git 仓库对象。'
          store.finishScan(scan.id, null, message)
        }
        continue
      }

      let version: string
      try {
        const { stdout } = await runFile(resolveGitExecutable(), ['--version'], { timeout: 5_000, windowsHide: true })
        version = stdout.trim()
      } catch (error) {
        store.finishPreflight(job.id, null, gitStartupError(error))
        continue
      }
      store.finishPreflight(job.id, { git: version, typescript: typescriptVersion }, null)
    }
  } finally {
    store.onModuleDestroy()
  }
}

runWorker().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
