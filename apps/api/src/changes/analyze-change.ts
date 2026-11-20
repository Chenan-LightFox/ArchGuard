import type {
  ChangeAnalysisInput,
  ChangeAnalysisResult,
  ChangeCodeImpact,
  ChangeEvidence,
  ChangeTaskImpact,
  ChangeUpstreamTask,
  PlanVersion,
  RepositoryScanResult,
} from '@archguard/contracts'

const genericTerms = new Set(['增加', '修改', '实现', '支持', '功能', '需求', '任务', '变更', '系统', '项目'])

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase()
  const result = new Set(normalized.match(/[a-z0-9_-]{2,}/g) ?? [])
  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const text = match[0]
    for (let size = 2; size <= Math.min(3, text.length); size++) {
      for (let index = 0; index <= text.length - size; index++) {
        const term = text.slice(index, index + size)
        if (!genericTerms.has(term)) result.add(term)
      }
    }
  }
  return result
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  let count = 0
  for (const item of left) if (right.has(item)) count++
  return count > 0 && count / Math.min(left.size || 1, right.size || 1) >= 0.3
}

function matchesPath(file: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/+$/, '')
  return file === normalized || file.startsWith(normalized + '/')
}

export function analyzeChange(
  input: ChangeAnalysisInput,
  scan: RepositoryScanResult,
  plan: PlanVersion,
): ChangeAnalysisResult {
  const description = input.description.trim()
  const descriptionTerms = terms(description)
  const evidence: ChangeEvidence[] = []
  const evidenceKeys = new Map<string, string>()
  function addEvidence(
    kind: ChangeEvidence['kind'],
    detail: string,
    path: string[],
  ): string {
    const key = `${kind}:${detail}:${path.join('>')}`
    const existing = evidenceKeys.get(key)
    if (existing) return existing
    const id = `E${evidence.length + 1}`
    evidenceKeys.set(key, id)
    evidence.push({ id, kind, description: detail, path })
    return id
  }

  const matchedRequirements = plan.requirements.filter((requirement) => {
    const explicit = new RegExp(`(^|[^A-Za-z0-9_-])${requirement.id}([^A-Za-z0-9_-]|$)`, 'i').test(description)
    const title = requirement.title.toLocaleLowerCase()
    const matched = explicit || (title.length > 1 && description.toLocaleLowerCase().includes(title)) ||
      overlaps(descriptionTerms, terms(`${requirement.title} ${requirement.description}`))
    if (matched) addEvidence('requirement', `${requirement.id} ${requirement.title}`, [requirement.id])
    return matched
  })
  const matchedRequirementIds = new Set(matchedRequirements.map(({ id }) => id))
  const explicitTaskIds = new Set(plan.tasks
    .filter((task) => new RegExp(`(^|[^A-Za-z0-9_-])${task.id}([^A-Za-z0-9_-]|$)`, 'i').test(description))
    .map(({ id }) => id))

  const directlyMatched = new Set<string>()
  const requirementLinked = new Set<string>()
  const titleCandidates = new Set<string>()
  for (const task of plan.tasks) {
    const titleMatch = task.title.length > 1 && description.toLocaleLowerCase().includes(task.title.toLocaleLowerCase())
    const pathMatch = task.modulePaths.some((path) => description.includes(path))
    const requirementMatch = task.requirementIds.some((id) => matchedRequirementIds.has(id))
    if (explicitTaskIds.has(task.id) || titleMatch || pathMatch) directlyMatched.add(task.id)
    else if (overlaps(descriptionTerms, terms(task.title))) titleCandidates.add(task.id)
    if (requirementMatch) requirementLinked.add(task.id)
    if (directlyMatched.has(task.id) || titleCandidates.has(task.id) || requirementMatch) {
      addEvidence('task', `${task.id} ${task.title}`, [task.id])
      for (const requirementId of task.requirementIds.filter((id) => matchedRequirementIds.has(id))) {
        addEvidence('requirement', `需求 ${requirementId} 关联任务 ${task.id}`, [requirementId, task.id])
      }
    }
  }

  const directPaths = new Set<string>()
  for (const file of scan.files) if (description.includes(file)) directPaths.add(file)
  const candidateTaskIds = new Set([...directlyMatched, ...requirementLinked, ...titleCandidates])
  const mappedPaths = new Set<string>()
  for (const task of plan.tasks) {
    if (candidateTaskIds.has(task.id)) {
      for (const prefix of task.modulePaths) {
        for (const file of scan.files) if (matchesPath(file, prefix)) mappedPaths.add(file)
      }
    }
  }

  const reverseEdges = new Map<string, (typeof scan.dependencies)[number][]>()
  const dependencyByPair = new Map<string, (typeof scan.dependencies)[number]>()
  for (const edge of scan.dependencies) {
    const callers = reverseEdges.get(edge.to) ?? []
    callers.push(edge)
    reverseEdges.set(edge.to, callers)
    dependencyByPair.set(`${edge.to}\0${edge.from}`, edge)
  }
  const affectedPaths = new Map<string, string[]>()
  const queue: string[] = []
  for (const file of new Set([...directPaths, ...mappedPaths])) {
    affectedPaths.set(file, [file])
    queue.push(file)
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const dependency = queue[cursor]
    for (const edge of reverseEdges.get(dependency) ?? []) {
      const caller = edge.from
      if (affectedPaths.has(caller)) continue
      affectedPaths.set(caller, [...affectedPaths.get(dependency)!, caller])
      queue.push(caller)
    }
  }

  const impactedFiles = [...affectedPaths.keys()]
  const codeImpacts: ChangeCodeImpact[] = []
  for (const [file, path] of affectedPaths) {
    const mapped = directPaths.has(file) || mappedPaths.has(file)
    const evidenceIds: string[] = []
    evidenceIds.push(addEvidence('module', mapped ? `任务或描述映射到模块 ${file}` : `依赖影响模块 ${file}`, path))
    if (!mapped) {
      for (let index = 1; index < path.length; index++) {
        const edge = dependencyByPair.get(`${path[index - 1]}\0${path[index]}`)
        if (edge) evidenceIds.push(addEvidence(
          'dependency',
          `${edge.from}:${edge.line} ${edge.kind} → ${edge.to}`,
          [edge.to, edge.from],
        ))
      }
    }
    codeImpacts.push({ file, classification: mapped ? 'mapped' : 'dependent', path, evidenceIds })
  }

  const successors = new Map<string, string[]>()
  for (const task of plan.tasks) {
    for (const predecessor of task.predecessorIds) {
      const following = successors.get(predecessor) ?? []
      following.push(task.id)
      successors.set(predecessor, following)
    }
  }
  const schedulePaths = new Map<string, string[]>()
  const taskQueue = [...candidateTaskIds].map((id) => [id, id])
  for (let cursor = 0; cursor < taskQueue.length; cursor++) {
    const [source, current] = taskQueue[cursor]
    for (const successor of successors.get(current) ?? []) {
      if (candidateTaskIds.has(successor) || schedulePaths.has(successor)) continue
      const path = [...(schedulePaths.get(current) ?? [source]), successor]
      schedulePaths.set(successor, path)
      taskQueue.push([source, successor])
    }
  }

  const candidateRows: ChangeTaskImpact[] = []
  for (const task of plan.tasks) {
    let mappedFile: { prefix: string; file: string } | undefined
    for (const prefix of task.modulePaths) {
      const file = impactedFiles.find((candidate) => matchesPath(candidate, prefix))
      if (file) {
        mappedFile = { prefix, file }
        break
      }
    }
    const schedulePath = schedulePaths.get(task.id)
    const classification: ChangeTaskImpact['classification'] = directlyMatched.has(task.id)
      ? 'change'
      : requirementLinked.has(task.id) || titleCandidates.has(task.id) || mappedFile
        ? 'review'
        : 'schedule'
    const mappedCodePath = mappedFile
      ? [...(affectedPaths.get(mappedFile.file) ?? [mappedFile.file])].reverse()
        .filter((file) => file !== mappedFile.prefix)
      : []
    let path: string[]
    if (directlyMatched.has(task.id)) path = [task.id, ...(mappedFile ? [mappedFile.prefix, ...mappedCodePath] : [])]
    else if (mappedFile) path = [task.id, mappedFile.prefix, ...mappedCodePath]
    else if (classification === 'review') path = [task.id]
    else if (schedulePath) path = schedulePath
    else continue
    const evidenceIds = [addEvidence(
      classification === 'change' ? 'task' : classification === 'review' ? 'module' : 'task',
      classification === 'change' ? `需要修改：${task.id} ${task.title}` :
        classification === 'review' ? `需要复核：${task.id} 关联 ${mappedFile?.prefix}` : `排期受影响：${task.id} ${task.title}`,
      path,
    )]
    for (const requirementId of task.requirementIds) {
      if (matchedRequirementIds.has(requirementId)) {
        evidenceIds.push(addEvidence('requirement', `需求 ${requirementId} 关联任务 ${task.id}`, [requirementId, task.id]))
      }
    }
    candidateRows.push({
      taskId: task.id,
      title: task.title,
      classification,
      path,
      evidenceIds: [...new Set(evidenceIds)],
    })
  }

  const candidates = candidateRows.map(({ taskId, title, classification, path, evidenceIds }) => ({
    taskId, title, classification, path, evidenceIds,
  }))
  const candidateIds = new Set(candidateRows.map(({ taskId }) => taskId))
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
  const upstreamPaths = new Map<string, string[]>()
  for (const candidate of candidateRows) {
    const visited = new Set<string>()
    const pending = (taskById.get(candidate.taskId)?.predecessorIds ?? [])
      .map((taskId) => ({ taskId, path: [taskId, candidate.taskId] }))
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const current = pending[cursor]
      if (visited.has(current.taskId)) continue
      visited.add(current.taskId)
      if (!candidateIds.has(current.taskId) && !upstreamPaths.has(current.taskId)) {
        upstreamPaths.set(current.taskId, current.path)
      }
      const predecessor = taskById.get(current.taskId)
      for (const taskId of predecessor?.predecessorIds ?? []) {
        pending.push({ taskId, path: [taskId, ...current.path] })
      }
    }
  }
  const upstreamTasks: ChangeUpstreamTask[] = []
  for (const [taskId, path] of upstreamPaths) {
    const task = taskById.get(taskId)
    if (!task) continue
    const evidenceIds = [addEvidence('task', `前置任务：${task.id} ${task.title}`, [task.id])]
    for (let index = 0; index < path.length - 1; index++) {
      evidenceIds.push(addEvidence(
        'task-dependency',
        `${path[index]} 是 ${path[index + 1]} 的前置任务`,
        [path[index], path[index + 1]],
      ))
    }
    upstreamTasks.push({
      taskId,
      title: task.title,
      requirementIds: task.requirementIds,
      modulePaths: task.modulePaths,
      path,
      evidenceIds: [...new Set(evidenceIds)],
    })
  }
  const coverageWarnings = [
    scan.skippedFiles > 0 && `扫描跳过 ${scan.skippedFiles} 个文件`,
    scan.unresolved.length > 0 && `${scan.unresolved.length} 条依赖未解析`,
    scan.computedImportCount > 0 && `${scan.computedImportCount} 条动态依赖无法确定`,
    scan.syntaxWarningFiles.length > 0 && `${scan.syntaxWarningFiles.length} 个文件存在语法问题`,
    scan.configurationWarnings.length > 0 && '部分项目解析配置不完整',
  ].filter((warning): warning is string => Boolean(warning))
  return {
    matchedRequirementIds: [...matchedRequirementIds],
    coverageLimited: coverageWarnings.length > 0,
    coverageWarnings,
    candidates,
    affectedTasks: candidateRows,
    affectedFiles: codeImpacts,
    evidence,
    aiCandidates: [],
    upstreamTasks,
    aiUpstreamImpacts: [],
    newRequirements: [],
    aiWarnings: [],
    confirmedTaskIds: [],
  }
}
