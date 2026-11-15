import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveGitExecutable } from '../src/scans/git-executable'
import { analyzeSources } from '../src/scans/analyze-sources'
import { normalizeGitRef, validateRepositoryUrl } from '../src/scans/git-snapshot'

test('finds Git for Windows when PATH points to its installation directory', { skip: process.platform !== 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'archguard-git-path-'))
  const cmd = join(directory, 'cmd')
  const executable = join(cmd, 'git.exe')
  mkdirSync(cmd)
  writeFileSync(executable, '')
  t.after(() => {
    unlinkSync(executable)
    rmdirSync(cmd)
    rmdirSync(directory)
  })
  assert.equal(resolveGitExecutable({ Path: directory }), executable)
  assert.equal(resolveGitExecutable({ ARCHGUARD_GIT_PATH: executable }), executable)
  assert.throws(() => resolveGitExecutable({ ARCHGUARD_GIT_PATH: 'cmd/git.exe' }), /绝对路径/)
})

test('extracts internal dependencies with source locations and classifies missing imports', () => {
  const result = analyzeSources(new Map([
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@app/*":["./src/*"]}}}'],
    ['src/main.ts', [
      'import { value } from "@app/lib.js"',
      'export { nested } from "./nested/index.js"',
      'import type { Thing } from "./lib.js"',
      'const dep = require("./legacy.cjs")',
      'const late = import("./nested/index.js")',
      'import "./missing"',
      'import "@app/absent"',
      'import "node:fs"',
    ].join('\n')],
    ['src/lib.ts', 'export const value = 1; export type Thing = number'],
    ['src/nested/index.ts', 'export const nested = 2'],
    ['src/legacy.cjs', 'exports.dep = 3'],
  ]))
  assert.deepEqual(result.files, ['src/legacy.cjs', 'src/lib.ts', 'src/main.ts', 'src/nested/index.ts'])
  assert.deepEqual(result.dependencies.map(({ to, kind, line }) => [to, kind, line]), [
    ['src/lib.ts', 'import', 1],
    ['src/nested/index.ts', 're-export', 2],
    ['src/lib.ts', 'type', 3],
    ['src/legacy.cjs', 'require', 4],
    ['src/nested/index.ts', 'dynamic-import', 5],
  ])
  assert.deepEqual(result.unresolved.map(({ specifier }) => specifier), ['./missing', '@app/absent'])
  assert.equal(result.externalCount, 1)
})

test('ignores comments and computed imports, keeps virtual reads within the snapshot', () => {
  const result = analyzeSources(new Map([
    ['main.js', '// import "./fake"\nrequire(name)\nimport "../../package.json"'],
  ]))
  assert.equal(result.dependencies.length, 0)
  assert.equal(result.computedImportCount, 1)
  assert.deepEqual(result.unresolved.map(({ specifier }) => specifier), ['../../package.json'])
})

test('exposes syntax recovery and labels references from declaration files as type edges', () => {
  const result = analyzeSources(new Map([
    ['a.d.ts', 'export { Value } from "./b.js"'],
    ['b.d.ts', 'export interface Value {}'],
    ['bad.ts', 'const ='],
  ]))
  assert.deepEqual(result.syntaxWarningFiles, ['bad.ts'])
  assert.equal(result.dependencies[0].kind, 'type')
})

test('runtime imports resolve to JavaScript implementations when declarations coexist', () => {
  const result = analyzeSources(new Map([
    ['main.js', 'import "./module.js"; import "./declaration-only.js"'],
    ['module.js', 'export const value = 1'],
    ['module.d.ts', 'export declare const value: number'],
    ['declaration-only.d.ts', 'export declare const value: number'],
  ]))
  assert.deepEqual(result.dependencies.map(({ to, kind }) => [to, kind]), [
    ['module.js', 'import'],
  ])
  assert.deepEqual(result.unresolved.map(({ specifier }) => specifier), ['./declaration-only.js'])
})

test('respects the NodeNext module resolution inferred from project config', () => {
  const result = analyzeSources(new Map([
    ['tsconfig.json', '{"compilerOptions":{"module":"NodeNext"}}'],
    ['main.mts', 'import "./module"; import "./module.mjs"'],
    ['module.mts', 'export const value = 1'],
  ]))
  assert.deepEqual(result.dependencies.map(({ specifier, to }) => [specifier, to]), [['./module.mjs', 'module.mts']])
  assert.deepEqual(result.unresolved.map(({ specifier }) => specifier), ['./module'])
})

test('accepts public Git URL and normalizes supported Git references', () => {
  assert.equal(validateRepositoryUrl('https://github.com/example/repo.git'), 'https://github.com/example/repo.git')
  assert.equal(normalizeGitRef(undefined), 'HEAD')
  assert.equal(normalizeGitRef(' feature/review '), 'refs/heads/feature/review')
  assert.equal(normalizeGitRef('refs/tags/v1.0.0'), 'refs/tags/v1.0.0')
  assert.throws(() => normalizeGitRef('refs/heads/main:refs/heads/elsewhere'))
  assert.throws(() => normalizeGitRef('--upload-pack'))
  assert.throws(() => validateRepositoryUrl('https://github.com:1234/example/repo'))
  assert.throws(() => validateRepositoryUrl('https://127.0.0.1/example/repo'))
})
