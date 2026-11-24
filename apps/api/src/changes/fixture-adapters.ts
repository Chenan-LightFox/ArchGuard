// 仅供测试与演示角色 D 使用，不接入真实 B/C 模型，不冒充真实 AI 分析。
import type {
  AnalysisDraft,
  PlanDraft,
  ScenarioDraft,
  ScenarioInput,
  ScenarioInputSet,
  ScenarioScheme,
} from '@archguard/contracts'
import { recomputePlan } from '../plans/build-plan'
import type { AnalysisContext, AnalysisAdapter, ScenarioAdapter, ScenarioContext } from './adapters'
import { fail } from './errors'

export class FixtureAnalysisAdapter implements AnalysisAdapter {
  analyze(context: AnalysisContext): AnalysisDraft {
    const baseline = context.baselinePlan
    if (!baseline) fail('NOT_FOUND', 404, '找不到基线计划，无法生成测试分析。')
    const confirmedMappings: Record<string, string[]> = {}
    const impactTasks = baseline.tasks.map((task, index) => ({
      taskId: task.id,
      category: index === 0 ? 'change' as const : 'review' as const,
      reasons: ['演示夹具：按任务顺序确定性生成，不来自真实影响分析。'],
    }))
    const impactPaths = baseline.requirements.map((requirement) => {
      const related = baseline.tasks.filter((task) => task.requirementIds.includes(requirement.id))
      return related.length
        ? [requirement.id, ...related.map((task) => task.id)]
        : [requirement.id]
    })
    for (const task of baseline.tasks) confirmedMappings[task.id] = task.modulePaths
    const evidenceRefs = (context.baselineScan?.result?.files ?? []).slice(0, 20)
    return {
      baselinePlanVersion: context.changeRequest.basePlanVersion,
      baselineScanId: context.changeRequest.baseScanId,
      confirmedMappings,
      impactTasks,
      impactPaths,
      evidenceRefs,
      openItems: [],
      confirmedBy: context.actor.id,
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function applyDiffs(baseline: PlanDraft, input: ScenarioInput): PlanDraft {
  const tasks = new Map(baseline.tasks.map((task) => [task.id, { ...task }]))
  for (const diff of input.taskDiffs) {
    if (diff.operation === 'remove') {
      tasks.delete(diff.taskId)
      continue
    }
    const existing = tasks.get(diff.taskId)
    if (diff.operation === 'add' && existing) fail('VALIDATION_ERROR', 400, `任务 ${diff.taskId} 已存在，不能作为新增任务。`)
    if (diff.operation === 'modify' && !existing) fail('VALIDATION_ERROR', 400, `任务 ${diff.taskId} 不存在，不能修改。`)
    const base = existing ?? {
      id: diff.taskId,
      title: diff.title ?? diff.taskId,
      requirementIds: [],
      predecessorIds: [],
      modulePaths: [],
      effortHours: 0,
      durationDays: 0,
      hourlyRate: 0,
      earliestStart: 0,
      earliestFinish: 0,
    }
    tasks.set(diff.taskId, {
      ...base,
      title: diff.title ?? base.title,
      requirementIds: diff.requirementIds ?? base.requirementIds,
      predecessorIds: diff.predecessorIds ?? base.predecessorIds,
      modulePaths: diff.modulePaths ?? base.modulePaths,
      effortHours: diff.effortHours ?? base.effortHours,
      durationDays: diff.durationDays ?? base.durationDays,
      hourlyRate: diff.hourlyRate ?? base.hourlyRate,
    })
  }
  const draft = { ...baseline, tasks: [...tasks.values()] }
  try {
    return recomputePlan(draft)
  } catch (error) {
    fail('VALIDATION_ERROR', 400, (error as Error).message)
  }
}

export class FixtureScenarioAdapter implements ScenarioAdapter {
  compute(context: ScenarioContext, input: ScenarioInputSet): ScenarioDraft {
    const baseline = context.baselinePlan
    if (!baseline) fail('NOT_FOUND', 404, '找不到基线计划，无法计算测试方案。')
    const kinds: ['accept', 'reduce', 'defer'] = ['accept', 'reduce', 'defer']
    const ruleVersion = input.accept.estimationInput.ruleVersion
    for (const kind of kinds) {
      if (!input[kind]?.estimationInput?.source || !input[kind].estimationInput.ruleVersion || !input[kind].estimationInput.basis) {
        fail('VALIDATION_ERROR', 400, '三个方案的估算输入都必须包含来源、计算规则版本和依据。')
      }
      if (input[kind].estimationInput.ruleVersion !== ruleVersion) {
        fail('VALIDATION_ERROR', 400, '三个方案必须使用相同的计算规则版本。')
      }
    }
    const scenarios = Object.fromEntries(kinds.map((kind) => {
      const item = input[kind]
      const candidatePlan = kind === 'defer' ? baseline : applyDiffs(baseline, item)
      const futureEstimate = kind === 'defer'
        ? { effortHours: baseline.metrics.effortHours, cost: baseline.metrics.cost, durationDays: null }
        : null
      const scheme: ScenarioScheme = {
        includedScope: item.includedScope,
        excludedScope: item.excludedScope,
        acceptanceCriteria: item.acceptanceCriteria,
        taskDiffs: item.taskDiffs,
        estimationInput: item.estimationInput,
        candidatePlan,
        metrics: candidatePlan.metrics,
        deltas: {
          effortHours: round(candidatePlan.metrics.effortHours - baseline.metrics.effortHours),
          durationDays: round(candidatePlan.metrics.durationDays - baseline.metrics.durationDays),
          cost: round(candidatePlan.metrics.cost - baseline.metrics.cost),
        },
        assumptions: ['演示夹具：按现有排程规则确定性计算，不来自真实 C 计算器。'],
        risks: [],
        futureEstimate,
      }
      return [kind, scheme]
    }))
    return {
      analysisRevisionId: context.analysis.id,
      baselinePlanVersion: context.changeRequest.basePlanVersion,
      baselineScanId: context.changeRequest.baseScanId,
      calculationRuleVersion: ruleVersion,
      scenarios: scenarios as { accept: ScenarioScheme; reduce: ScenarioScheme; defer: ScenarioScheme },
    }
  }
}

export function createFixtureAdapters(): { analysis: AnalysisAdapter; scenario: ScenarioAdapter } {
  return { analysis: new FixtureAnalysisAdapter(), scenario: new FixtureScenarioAdapter() }
}
