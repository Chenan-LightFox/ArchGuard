import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareArchitecture, detectArchitecture, parseArchitectureRules } from '../src/architecture/rules'
import { buildPlan } from '../src/plans/build-plan'
import type { RepositoryAnalysis } from '@archguard/contracts'

const graph: RepositoryAnalysis = {
  files: ['ui/a.ts', 'core/b.ts', 'core/c.ts', 'loose.ts'],
  dependencies: [
    { from: 'ui/a.ts', to: 'core/b.ts', kind: 'import', line: 1, specifier: '../core/b' },
    { from: 'core/b.ts', to: 'ui/a.ts', kind: 'import', line: 2, specifier: '../ui/a' },
    { from: 'core/c.ts', to: 'core/c.ts', kind: 'require', line: 3, specifier: './c' },
    { from: 'core/b.ts', to: 'core/c.ts', kind: 'type', line: 4, specifier: './c' },
  ],
  unresolved: [], externalCount: 0, configurationWarnings: [], syntaxWarningFiles: [], computedImportCount: 0,
}

test('reports cycles and forbidden layer edges with line evidence and stable fingerprints', () => {
  const rules = parseArchitectureRules({
    layers: [{ name: 'UI', prefix: 'ui/' }, { name: 'Core', prefix: 'core' }],
    allowed: [{ from: 'UI', to: 'Core' }],
  })
  const result = detectArchitecture(graph, rules)
  const cycles = result.issues.filter((issue) => issue.rule === 'cycle')
  assert.equal(cycles.length, 2)
  for (const issue of cycles) assert.equal(issue.path.at(0), issue.path.at(-1))
  assert.deepEqual(result.issues.filter((issue) => issue.rule === 'layer').map((issue) => issue.evidence[0].line), [2])
  assert.deepEqual(result.unassignedFiles, ['loose.ts'])
  assert.equal(result.coverageLimited, true)
  const withSelfLoop = detectArchitecture({
    ...graph,
    dependencies: [{ from: 'core/b.ts', to: 'core/b.ts', kind: 'import', line: 8, specifier: './b' }, ...graph.dependencies],
  }, rules)
  assert.ok(withSelfLoop.issues.some((issue) => issue.rule === 'cycle' && issue.path.includes('ui/a.ts')))
  const moved = detectArchitecture({ ...graph, dependencies: graph.dependencies.map((edge) => ({ ...edge, line: edge.line + 4 })) }, rules)
  assert.deepEqual(moved.issues.map((issue) => issue.id), result.issues.map((issue) => issue.id))
  const after = detectArchitecture({ ...graph, dependencies: graph.dependencies.slice(2) }, rules)
  assert.equal(compareArchitecture(result, after).missing.length, 2)
  assert.throws(() => compareArchitecture(result, detectArchitecture(graph, parseArchitectureRules(undefined))))
})

const requirements = '## REQ-07 导出记录\n记录事件。'
const header = 'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths'
const csv = [
  header,
  'T1,"导出,服务",REQ-07,,16,,150,src/export/',
  'T2,验证,REQ-07,T1,16,,100,src/test/',
  'T3,并行,REQ-07,,40,5,100,',
].join('\r\n')

test('imports a baseline and distinguishes effort from delivery duration', () => {
  const plan = buildPlan(requirements, csv)
  assert.equal(plan.tasks[0].title, '导出,服务')
  assert.equal(plan.tasks[1].earliestStart, 2)
  assert.equal(plan.metrics.durationDays, 5)
  assert.equal(plan.metrics.effortHours, 72)
  assert.equal(plan.metrics.cost, 8000)
  assert.deepEqual(plan.metrics.criticalPath, ['T3'])
  assert.equal(buildPlan(requirements, csv.replace('T1,16,,100', 'T1,24,,100')).metrics.durationDays, 5)
  assert.throws(() => buildPlan(requirements, csv.replace('REQ-07,,16', 'REQ-07,T2,16')), /循环/)
  assert.throws(() => buildPlan(requirements, csv.replace('REQ-07,T1', 'REQ-07,unknown')), /前置/)
  assert.throws(() => buildPlan(requirements, csv.replace('16,,150', '-16,,150')), /工时/)
})

test('rounds the sum of decimal labor costs to cents', () => {
  assert.equal(buildPlan(requirements, header + '\nT1,测试,REQ-07,,1.005,,1,').metrics.cost, 1.01)
})
