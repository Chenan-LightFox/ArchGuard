import type { PlanDraft, PlanRequirement, PlanTask } from '@archguard/contracts'

const columns = ['id', 'title', 'requirementIds', 'predecessorIds', 'effortHours', 'durationDays', 'hourlyRate', 'modulePaths']
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

function parseRequirements(markdown: string): PlanRequirement[] {
  const requirements: PlanRequirement[] = []
  const seen = new Set<string>()
  let section: PlanRequirement | undefined
  let fence: string | undefined
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && !fence) fence = marker
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length &&
        line.trim() === marker) fence = undefined
    const heading = !marker && !fence ? /^ {0,3}##\s+(REQ-[A-Za-z0-9_-]+)\s+(.+)$/.exec(line) : null
    if (!heading) {
      if (section) section.description += line + '\n'
      continue
    }
    const [, id, title] = heading
    if (!idPattern.test(id) || seen.has(id)) throw new Error(`需求编号无效或重复：${id}。`)
    if (!title.trim()) throw new Error(`需求 ${id} 缺少标题。`)
    seen.add(id)
    section = { id, title: title.trim(), description: '' }
    requirements.push(section)
  }
  if (!requirements.length) throw new Error('需求文档至少需要一个「## REQ-01 需求标题」小节。')
  return requirements.map((item) => ({ ...item, description: item.description.trim() }))
}

function parseCsv(source: string): string[][] {
  const input = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let state: 'plain' | 'quoted' | 'closed' = 'plain'
  function endField() {
    row.push(field.trim())
    field = ''
    state = 'plain'
  }
  function endRow() {
    endField()
    if (row.some(Boolean)) rows.push(row)
    row = []
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (state === 'quoted') {
      if (char !== '"') field += char
      else if (input[index + 1] === '"') { field += '"'; index++ }
      else state = 'closed'
    } else if (char === ',') endField()
    else if (char === '\n') endRow()
    else if (state === 'closed') throw new Error('CSV 引号结束后应为逗号或换行。')
    else if (char === '"' && !field) state = 'quoted'
    else if (char === '"') throw new Error('CSV 中的引号字段格式不正确。')
    else field += char
  }
  if (state === 'quoted') throw new Error('CSV 有未闭合的引号。')
  endRow()
  return rows
}

function numeric(value: string, label: string, id: string): number {
  const number = Number(value)
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(number) || number > 1_000_000) {
    throw new Error(`任务 ${id} 的${label}必须为 0 到 1,000,000 之间的数字，最多保留 6 位小数。`)
  }
  return number
}

function list(value: string, label: string, id: string): string[] {
  if (!value) return []
  const items = value.split('|').map((item) => item.trim())
  if (items.some((item) => !item) || items.length !== new Set(items).size) {
    throw new Error(`任务 ${id} 的${label}存在空值或重复项。`)
  }
  return items
}

function millionthsFromNumber(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error('工时和费率必须为非负数字。')
  const [integer, fraction] = value.toFixed(6).split('.')
  return BigInt(integer + fraction)
}

function taskCostCents(task: PlanTask): bigint {
  return millionthsFromNumber(task.effortHours) * millionthsFromNumber(task.hourlyRate)
}

export function planCost(tasks: readonly PlanTask[]): number {
  let preciseCost = 0n
  for (const task of tasks) preciseCost += taskCostCents(task)
  const cents = (preciseCost + 5_000_000_000n) / 10_000_000_000n
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('计划总成本超过可计算范围。')
  return Number(cents) / 100
}

export function scheduleTasks(input: readonly PlanTask[]): { tasks: PlanTask[]; criticalPath: string[] } {
  const tasks = new Map(input.map((task) => [task.id, { ...task, earliestStart: 0, earliestFinish: 0 }]))
  const next = new Map([...tasks.keys()].map((id) => [id, [] as string[]]))
  const remaining = new Map<string, number>()
  const queue: string[] = []
  for (const task of tasks.values()) {
    remaining.set(task.id, task.predecessorIds.length)
    if (!task.predecessorIds.length) queue.push(task.id)
    for (const predecessor of task.predecessorIds) {
      if (!tasks.has(predecessor)) throw new Error(`任务 ${task.id} 的前置任务 ${predecessor} 不存在。`)
      next.get(predecessor)!.push(task.id)
    }
  }
  const previous = new Map<string, string>()
  let last: PlanTask | undefined
  for (let index = 0; index < queue.length; index++) {
    const task = tasks.get(queue[index])!
    task.earliestFinish = task.earliestStart + task.durationDays
    if (!last || task.earliestFinish > last.earliestFinish) last = task
    for (const successor of next.get(task.id)!) {
      const following = tasks.get(successor)!
      if (!previous.has(successor) || task.earliestFinish > following.earliestStart) {
        following.earliestStart = task.earliestFinish
        previous.set(successor, task.id)
      }
      const count = remaining.get(successor)! - 1
      remaining.set(successor, count)
      if (!count) queue.push(successor)
    }
  }
  if (queue.length !== tasks.size) {
    const blocked = [...remaining].filter(([, count]) => count > 0).map(([id]) => id)
    throw new Error(`任务依赖存在循环，无法排程：${blocked.slice(0, 12).join('、')}。`)
  }
  const criticalPath: string[] = []
  for (let id = last?.id; id !== undefined; id = previous.get(id)) criticalPath.push(id)
  return { tasks: [...tasks.values()], criticalPath: criticalPath.reverse() }
}

export function buildPlan(markdown: string, csv: string): PlanDraft {
  const requirements = parseRequirements(markdown)
  const requirementIds = new Set(requirements.map(({ id }) => id))
  const [header, ...rows] = parseCsv(csv)
  if (!header || header.length !== columns.length || columns.some((column) => !header.includes(column))) {
    throw new Error('任务 CSV 表头应为 ' + columns.join(','))
  }
  if (!rows.length || rows.length > 1000) throw new Error('任务 CSV 需要包含 1 到 1,000 条任务。')
  const tasks = new Map<string, PlanTask>()
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) throw new Error(`第 ${index + 1} 条任务的列数与表头不符。`)
    const value = Object.fromEntries(header.map((column, position) => [column, row[position]]))
    const { id, title } = value
    if (!idPattern.test(id) || !title || tasks.has(id)) throw new Error(`第 ${index + 1} 条任务的编号或标题无效，或编号已存在。`)
    const relatedRequirements = list(value.requirementIds, '需求编号', id)
    for (const req of relatedRequirements) {
      if (!requirementIds.has(req)) throw new Error(`任务 ${id} 引用了不存在的需求 ${req}。`)
    }
    const modulePaths = list(value.modulePaths, '模块路径', id)
    for (const path of modulePaths) {
      if (/[\\:*?\u0000-\u001f]/u.test(path) || path.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`任务 ${id} 的模块路径须为仓库相对路径或目录前缀。`)
      }
    }
    const effortHours = numeric(value.effortHours, '工时', id)
    tasks.set(id, {
      id, title, requirementIds: relatedRequirements, modulePaths, effortHours,
      predecessorIds: list(value.predecessorIds, '前置任务', id),
      durationDays: value.durationDays ? numeric(value.durationDays, '持续时长', id) : effortHours / 8,
      hourlyRate: numeric(value.hourlyRate, '费率', id),
      earliestStart: 0, earliestFinish: 0,
    })
  }
  const { tasks: scheduled, criticalPath } = scheduleTasks([...tasks.values()])
  const effortHours = scheduled.reduce((sum, task) => sum + task.effortHours, 0)
  const last = scheduled.reduce((latest, task) => (task.earliestFinish > (latest?.earliestFinish ?? -1) ? task : latest), undefined as PlanTask | undefined)
  return {
    requirements,
    tasks: scheduled,
    metrics: {
      effortHours,
      durationDays: last?.earliestFinish ?? 0,
      cost: planCost(scheduled),
      criticalPath,
    },
  }
}

export function recomputePlan(plan: PlanDraft): PlanDraft {
  const requirementIds = new Set(plan.requirements.map(({ id }) => id))
  if (plan.requirements.length !== requirementIds.size) throw new Error('需求编号存在重复。')
  for (const requirement of plan.requirements) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(requirement.id) || !requirement.title.trim()) {
      throw new Error(`需求 ${requirement.id} 的编号或标题无效。`)
    }
  }
  const ids = new Set<string>()
  for (const task of plan.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(task.id) || !task.title || ids.has(task.id)) {
      throw new Error(`任务 ${task.id} 的编号或标题无效，或编号已存在。`)
    }
    ids.add(task.id)
    if (!Number.isFinite(task.effortHours) || task.effortHours < 0 || task.effortHours > 1_000_000) {
      throw new Error(`任务 ${task.id} 的工时无效。`)
    }
    if (!Number.isFinite(task.hourlyRate) || task.hourlyRate < 0 || task.hourlyRate > 1_000_000) {
      throw new Error(`任务 ${task.id} 的费率无效。`)
    }
    if (!Number.isFinite(task.durationDays) || task.durationDays < 0 || task.durationDays > 1_000_000) {
      throw new Error(`任务 ${task.id} 的持续时长无效。`)
    }
    for (const requirement of task.requirementIds) {
      if (!requirementIds.has(requirement)) throw new Error(`任务 ${task.id} 引用了不存在的需求 ${requirement}。`)
    }
  }
  const { tasks: scheduled, criticalPath } = scheduleTasks(plan.tasks)
  const last = scheduled.reduce((latest, task) => (task.earliestFinish > (latest?.earliestFinish ?? -1) ? task : latest), undefined as PlanTask | undefined)
  const metrics = {
    effortHours: scheduled.reduce((sum, task) => sum + task.effortHours, 0),
    durationDays: last?.earliestFinish ?? 0,
    cost: planCost(scheduled),
    criticalPath,
  }
  return { ...plan, tasks: scheduled, metrics }
}
