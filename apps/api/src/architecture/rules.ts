import { createHash } from 'node:crypto'
import type {
  ArchitectureComparison, ArchitectureIssue, ArchitectureReport, ArchitectureRules, RepositoryAnalysis,
} from '@archguard/contracts'

export function parseArchitectureRules(value: unknown): ArchitectureRules {
  if (value === undefined) return { layers: [], allowed: [] }
  const rules = value as Partial<ArchitectureRules> | null
  if (!Array.isArray(rules?.layers) || !Array.isArray(rules.allowed) ||
      rules.layers.length > 100 || rules.allowed.length > 1000) {
    throw new Error('分层配置需要 layers 和 allowed 数组。')
  }
  const prefixes = new Set<string>()
  const names = new Set<string>()
  const layers = rules.layers.map((layer) => {
    if (typeof layer?.name !== 'string' || typeof layer.prefix !== 'string') throw new Error('每层需要名称和路径前缀。')
    const name = layer.name.trim()
    const prefix = layer.prefix.trim().replace(/\/$/, '')
    if (!name || name.length > 80 || prefix.length > 300 || /[\\:*?\u0000-\u001f]/u.test(prefix) ||
        prefix.split('/').some((part) => !part || part === '.' || part === '..') || prefixes.has(prefix)) {
      throw new Error('路径前缀必须是唯一的仓库相对路径，层名称不能为空。')
    }
    names.add(name)
    prefixes.add(prefix)
    return { name, prefix }
  }).sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix))
  const seen = new Set<string>()
  const allowed = rules.allowed.map((edge) => {
    if (!names.has(edge?.from) || !names.has(edge?.to)) throw new Error('允许的依赖必须引用已定义的层。')
    const key = JSON.stringify([edge.from, edge.to])
    if (seen.has(key)) throw new Error('允许的依赖存在重复项。')
    seen.add(key)
    return { from: edge.from, to: edge.to }
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return { layers, allowed }
}

type Edge = RepositoryAnalysis['dependencies'][number]
type Graph = Map<string, Edge[]>

// Iterative Kosaraju avoids exhausting the stack on long chains.
function components(forward: Graph, reverse: Graph): string[][] {
  const visited = new Set<string>()
  const order: string[] = []
  for (const start of forward.keys()) {
    if (visited.has(start)) continue
    visited.add(start)
    const stack = [{ file: start, index: 0 }]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const edge = forward.get(frame.file)![frame.index++]
      if (!edge) {
        order.push(frame.file)
        stack.pop()
      } else if (!visited.has(edge.to)) {
        visited.add(edge.to)
        stack.push({ file: edge.to, index: 0 })
      }
    }
  }
  visited.clear()
  const groups: string[][] = []
  for (const start of order.reverse()) {
    if (visited.has(start)) continue
    const group = [start]
    visited.add(start)
    for (let index = 0; index < group.length; index++) {
      for (const edge of reverse.get(group[index])!) {
        if (visited.has(edge.from)) continue
        visited.add(edge.from)
        group.push(edge.from)
      }
    }
    groups.push(group.sort())
  }
  return groups
}

function cycleEvidence(group: string[], forward: Graph): Edge[] {
  const start = group[0]
  const members = new Set(group)
  const previous = new Map<string, Edge>()
  const queue = [start]
  for (let index = 0; index < queue.length; index++) {
    for (const edge of forward.get(queue[index])!) {
      if (edge.to === start) {
        if (group.length > 1 && edge.from === start) continue
        const evidence = [edge]
        let cursor = edge.from
        while (cursor !== start) {
          const parent = previous.get(cursor)!
          evidence.push(parent)
          cursor = parent.from
        }
        return evidence.reverse()
      }
      if (!members.has(edge.to) || previous.has(edge.to)) continue
      previous.set(edge.to, edge)
      queue.push(edge.to)
    }
  }
  return []
}

function fingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function detectArchitecture(graph: RepositoryAnalysis, rules: ArchitectureRules): ArchitectureReport {
  const forward: Graph = new Map(graph.files.map((file) => [file, []]))
  const reverse: Graph = new Map(graph.files.map((file) => [file, []]))
  const assigned = new Map(graph.files.map((file) => [
    file, rules.layers.find(({ prefix }) => file === prefix || file.startsWith(prefix + '/'))?.name,
  ]))
  const allowed = new Set(rules.allowed.map(({ from, to }) => JSON.stringify([from, to])))
  const issues: ArchitectureIssue[] = []
  const layerIssues = new Map<string, ArchitectureIssue>()
  for (const edge of graph.dependencies) {
    if (!forward.has(edge.from) || !forward.has(edge.to) || edge.kind === 'type' || /\.d\.[cm]?ts$/i.test(edge.from)) continue
    if (edge.kind !== 'dynamic-import') {
      forward.get(edge.from)!.push(edge)
      reverse.get(edge.to)!.push(edge)
    }
    const from = assigned.get(edge.from)
    const to = assigned.get(edge.to)
    if (!from || !to || from === to || allowed.has(JSON.stringify([from, to]))) continue
    const id = fingerprint(['layer', from, to, edge.from, edge.to])
    const existing = layerIssues.get(id)
    if (existing) existing.evidence.push(edge)
    else layerIssues.set(id, { id, rule: 'layer', path: [edge.from, edge.to], evidence: [edge], layers: { from, to } })
  }
  for (const group of components(forward, reverse)) {
    if (group.length === 1 && !forward.get(group[0])!.some((edge) => edge.to === group[0])) continue
    const evidence = cycleEvidence(group, forward)
    issues.push({ id: fingerprint(['cycle', group]), rule: 'cycle', path: [evidence[0].from, ...evidence.map((edge) => edge.to)], evidence })
  }
  issues.push(...layerIssues.values())
  const unassignedFiles = rules.layers.length ? graph.files.filter((file) => !assigned.get(file)) : []
  return {
    ruleVersion: 1,
    rules,
    issues: issues.sort((a, b) => a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id)),
    unassignedFiles,
    coverageLimited: Boolean(!graph.files.length || graph.unresolved.length || graph.configurationWarnings?.length ||
      graph.syntaxWarningFiles?.length || graph.computedImportCount || unassignedFiles.length ||
      ('skippedFiles' in graph && graph.skippedFiles)),
  }
}

export function compareArchitecture(before: ArchitectureReport, after: ArchitectureReport): ArchitectureComparison {
  if (before.ruleVersion !== after.ruleVersion || JSON.stringify(before.rules) !== JSON.stringify(after.rules)) {
    throw new Error('请选择使用相同分层配置与规则版本的扫描结果。')
  }
  const oldIds = new Set(before.issues.map(({ id }) => id))
  const newIds = new Set(after.issues.map(({ id }) => id))
  return {
    added: after.issues.filter(({ id }) => !oldIds.has(id)),
    remaining: after.issues.filter(({ id }) => oldIds.has(id)),
    missing: before.issues.filter(({ id }) => !newIds.has(id)),
    coverageLimited: before.coverageLimited || after.coverageLimited,
  }
}
