import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import type { RepositoryScanResult } from '@archguard/contracts'
import { analyzeSources, isSourcePath } from './analyze-sources'
import { gitFetchError, gitStartupError, resolveGitExecutable } from './git-executable'

const gitExec = promisify(execFile)
const maxSourceBytes = 16 * 1024 * 1024
const maxFileBytes = 512 * 1024
const fetchTimeoutSeconds = 45
const hosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])
const ignoredDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor'])
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i

export function validateRepositoryUrl(value: string): string {
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password ||
      url.search || url.hash || !/^\/(?:[\w.-]+\/)+[\w.-]+\/?$/.test(url.pathname)) {
    throw new Error('扫描支持 GitHub、GitLab 和 Bitbucket 的公开 HTTPS 仓库地址。')
  }
  return url.href
}

export function normalizeGitRef(value: unknown): string {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return 'HEAD'
  if (typeof value !== 'string') throw new Error('请输入分支、完整引用或提交 SHA。')
  const ref = value.trim()
  if (ref === 'HEAD' || hashPattern.test(ref)) return ref
  if (ref.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(ref) || ref.includes('..') ||
      ref.endsWith('.') || ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) ||
      (ref.startsWith('refs/') && !/^refs\/(heads|tags)\/.+/.test(ref))) {
    throw new Error('引用格式无效。请输入分支名、refs/heads/…、refs/tags/… 或完整提交 SHA。')
  }
  return ref.startsWith('refs/') ? ref : 'refs/heads/' + ref
}

async function git(executable: string, directory: string, args: string[], timeout = 10_000, maxBuffer = 8 * 1024 * 1024, input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)))
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https',
    LC_ALL: 'C',
  })
  const command = gitExec(executable, [
    '-c', 'http.followRedirects=false',
    '-c', 'credential.helper=',
    '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    ...args,
  ], { cwd: directory, env, timeout, maxBuffer, encoding: 'buffer', windowsHide: true })
  if (input !== undefined) {
    command.child.stdin?.on('error', () => {})
    command.child.stdin?.end(input)
  }
  const { stdout } = await command
  return stdout
}

interface BlobEntry {
  id: string
  size: number
  file: string
}

function selectBlobs(tree: Buffer) {
  const blobs: BlobEntry[] = []
  let bytes = 0
  let skipped = 0
  for (const entry of tree.toString('utf8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +([0-9]+)$/.exec(entry.slice(0, tab))
    const file = entry.slice(tab + 1)
    const parts = file.split('/')
    const name = parts.at(-1)!
    const config = name === 'package.json' || /^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/.test(name)
    if (!config && !isSourcePath(file)) continue
    if (!match || parts.some((part) => ignoredDirectories.has(part) || part === '.' || part === '..' || !part) ||
        /[\\\u0000-\u001f\ufffd]/u.test(file)) {
      skipped++
      continue
    }
    const size = Number(match[3])
    if (size > maxFileBytes) {
      skipped++
      continue
    }
    if (blobs.length >= 4000 || bytes + size > maxSourceBytes) {
      throw new Error('仓库超过 4,000 个可扫描文件或 16 MiB 源码上限。')
    }
    bytes += size
    blobs.push({ id: match[2], size, file })
  }
  return { blobs, skipped }
}

async function readBlobs(executable: string, directory: string, blobs: BlobEntry[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  // Group by object ID and send only hashes over the batch protocol.
  const entries = new Map<string, BlobEntry[]>()
  for (const blob of blobs) {
    const group = entries.get(blob.id) ?? []
    group.push(blob)
    entries.set(blob.id, group)
  }
  const objectIds = [...entries.keys()]
  const chunks: string[][] = []
  for (let offset = 0; offset < objectIds.length; offset += 100) chunks.push(objectIds.slice(offset, offset + 100))
  for (const chunk of chunks) {
    const output = await git(executable, directory, ['cat-file', '--batch'], 3000, maxSourceBytes + 1024 * 1024, chunk.join('\n') + '\n')
    let cursor = 0
    for (const id of chunk) {
      const group = entries.get(id)!
      const end = output.indexOf(10, cursor)
      if (end < 0 || output.toString('ascii', cursor, end) !== `${id} blob ${group[0].size}`) {
        throw new Error('Git 对象头与仓库清单不一致。')
      }
      const next = end + 1 + group[0].size
      if (output[next] !== 10) throw new Error('Git 对象内容不完整。')
      const source = output.toString('utf8', end + 1, next)
      for (const entry of group) contents.set(entry.file, source)
      cursor = next + 1
    }
  }
  return contents
}

export async function scanRepository(repositoryUrl: string, ref: string): Promise<RepositoryScanResult> {
  const url = validateRepositoryUrl(repositoryUrl)
  const safeRef = normalizeGitRef(ref)
  const executable = resolveGitExecutable()
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'archguard-scan-'))
  try {
    try {
      await git(executable, directory, ['init', '--bare', '--template='])
    } catch (error) {
      const failure = error as { code?: string; killed?: boolean }
      if (failure.code === 'ENOENT' || failure.code === 'EACCES' || failure.code === 'EPERM') {
        throw new Error(gitStartupError(error))
      }
      if (failure.killed) throw new Error('初始化 Git 扫描目录超时。')
      throw new Error('无法初始化 Git 扫描目录。')
    }
    try {
      await git(executable, directory, ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', url, safeRef], fetchTimeoutSeconds * 1000)
    } catch (error) {
      throw new Error(gitFetchError(error, fetchTimeoutSeconds))
    }
    const commit = (await git(executable, directory, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).toString().trim()
    if (!hashPattern.test(commit)) throw new Error('无法确认扫描使用的提交。')
    const { blobs, skipped } = selectBlobs(await git(executable, directory, ['ls-tree', '-rlz', commit]))
    const result = analyzeSources(await readBlobs(executable, directory, blobs))
    return { ...result, commit, analyzerVersion: '1/ts-' + ts.version, skippedFiles: skipped }
  } finally {
    const actual = await realpath(directory)
    if (dirname(actual) === parent && /^archguard-scan-[A-Za-z0-9]{6}$/.test(basename(actual))) {
      await rm(actual, { recursive: true, force: true })
    }
  }
}
