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

export function gitFetchError(error: unknown, timeoutSeconds: number): string {
  const failure = error as { code?: string | number; killed?: boolean; stderr?: Buffer | string } | null
  if (failure?.code === 'ENOENT' || failure?.code === 'EACCES' || failure?.code === 'EPERM') {
    return gitStartupError(error)
  }
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git 拉取输出过大。请先尝试较小的公开仓库。'
  if (failure?.killed) return `Git 拉取超过 ${timeoutSeconds} 秒。请检查 Worker 到仓库主机的网络连接。`

  const stderr = failure?.stderr?.toString() ?? ''
  if (/couldn.t find remote ref/i.test(stderr)) {
    return '远程仓库中找不到指定的分支或标签。可留空扫描默认分支，标签请填写 refs/tags/标签名。'
  }
  if (/not our ref|unadvertised object/i.test(stderr)) {
    return '远程仓库未提供指定的提交 SHA。请核对 SHA，或使用包含该提交的分支或标签。'
  }
  if (/could not resolve (?:host|proxy)/i.test(stderr)) {
    return 'Git 无法解析仓库主机或代理地址。请检查 Worker 的 DNS 和代理配置。'
  }
  if (/SSL certificate|certificate verify failed|server certificate verification failed|untrusted root|SEC_E_UNTRUSTED_ROOT/i.test(stderr)) {
    return 'Git 无法验证远程 TLS 证书。请检查 Worker 的系统时间、CA 证书和网络代理。'
  }
  const httpCode = /(?:returned error:|HTTP(?:\/\d(?:\.\d)?)?(?: code)?)\s+(\d{3})\b/i.exec(stderr)?.[1]
  if (httpCode?.startsWith('3') || /unable to update url base from redirection|redirect prohibited/i.test(stderr)) {
    return '仓库地址发生跳转。请在仓库页面复制当前的 HTTPS 克隆地址。'
  }
  if (httpCode === '407') return 'Git 请求的网络代理要求身份验证。请检查 Worker 的代理配置。'
  if (httpCode === '401' || /authentication failed|could not read username|terminal prompts disabled/i.test(stderr)) {
    return '远程仓库要求身份验证。当前扫描支持匿名可访问的公开仓库。'
  }
  if (httpCode === '404' || /repository not found/i.test(stderr)) {
    return '远程仓库不存在或无法匿名访问。请核对公开仓库的 HTTPS 克隆地址。'
  }
  if (httpCode) return `Git 拉取收到 HTTP ${httpCode}。请在 Worker 所在服务器检查仓库访问和网络代理。`
  if (/failed to connect|timed out|connection reset|recv failure|network is unreachable/i.test(stderr)) {
    return 'Git 无法连接远程仓库。请检查 Worker 所在服务器的 HTTPS 出站连接和网络代理。'
  }
  return 'Git 拉取失败。请在 Worker 所在服务器使用 git ls-remote 检查仓库地址和引用。'
}
