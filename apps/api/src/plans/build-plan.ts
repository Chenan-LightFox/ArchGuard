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

function millionths(value: string): bigint {
  const [integer, fraction = ''] = value.split('.')
  return BigInt(integer + fraction.padEnd(6, '0'))
}

function list(value: string, label: string, id: string): string[] {
  if (!value) return []
  const items = value.split('|').map((item) => item.trim())
  if (items.some((item) => !item) || items.length !== new Set(items).size) {
    throw new Error(`任务 ${id} 的${label}存在空值或重复项。`)
  }
  return items
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
  let preciseCost = 0n
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
    preciseCost += millionths(value.effortHours) * millionths(value.hourlyRate)
  }
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
  let effortHours = 0
  for (let index = 0; index < queue.length; index++) {
    const task = tasks.get(queue[index])!
    task.earliestFinish = task.earliestStart + task.durationDays
    effortHours += task.effortHours
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
  // Both inputs use six decimal places. Round the total once, to cents.
  const cents = (preciseCost + 5_000_000_000n) / 10_000_000_000n
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('计划总成本超过可计算范围。')
  return {
    requirements, tasks: [...tasks.values()],
    metrics: { effortHours, durationDays: last?.earliestFinish ?? 0, cost: Number(cents) / 100, criticalPath: criticalPath.reverse() },
  }
}
