import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

export function resolveGitExecutable(env = process.env): string {
  const configured = env.ARCHGUARD_GIT_PATH?.trim()
  if (configured) {
    if (!isAbsolute(configured) || !isFile(configured)) {
      throw new Error('ARCHGUARD_GIT_PATH 必须指向 Git 可执行文件的绝对路径。')
    }
    return configured
  }

  if (process.platform !== 'win32') return 'git'
  for (const entry of (env.Path ?? env.PATH ?? '').split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!isAbsolute(directory)) continue
    const executable = join(directory, 'git.exe')
    if (isFile(executable)) return executable
    // Git for Windows may be registered by its installation root.
    const installed = join(directory, 'cmd', 'git.exe')
    if (isFile(installed)) return installed
  }
  return 'git'
}

export function gitStartupError(error: unknown): string {
  if (error instanceof Error && !('cmd' in error) && !('code' in error)) return error.message
  const failure = error as { code?: string | number; killed?: boolean } | null
  if (failure?.code === 'ENOENT') {
    return process.platform === 'win32'
      ? '扫描进程找不到 Git。请将包含 git.exe 的目录（通常是 Git 安装目录下的 cmd）加入 PATH，然后重启 ArchGuard。'
      : '扫描进程找不到 Git。请将 Git 加入 PATH，然后重启 ArchGuard。'
  }
  if (failure?.killed) return 'Git 版本检查超时。请在启动 ArchGuard 的终端运行 git --version 确认响应。'
  if (failure?.code === 'EACCES' || failure?.code === 'EPERM') return '扫描进程没有权限执行 Git。'
  return 'Git 执行失败。请在启动 ArchGuard 的终端运行 git --version 查看错误。'
}
