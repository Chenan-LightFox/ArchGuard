const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const cwd = resolve(__dirname, '..')
const gitPath = process.env.ARCHGUARD_GIT_PATH?.trim().replace(/^"(.*)"$/, '$1')

if (gitPath) process.env.ARCHGUARD_GIT_PATH = gitPath
if (!process.env.HTTPS_PROXY && !process.env.ALL_PROXY) {
  const proxy = spawnSync(gitPath || 'git.exe', [
    'config', '--global', '--get-urlmatch', 'http.proxy', 'https://github.com/',
  ], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (proxy.status === 0 && proxy.stdout.trim()) {
    process.env.HTTPS_PROXY = proxy.stdout.trim()
  }
}

const npm = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run dev'], {
  cwd, stdio: 'inherit',
})
if (npm.error) console.error('无法启动 npm.cmd（%s）。', npm.error.code ?? 'UNKNOWN')
process.exitCode = npm.status ?? 1
