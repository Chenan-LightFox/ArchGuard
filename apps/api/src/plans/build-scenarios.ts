import type { PlanDraft, PlanScenario, PlanScenarioComparison, PlanScenarioInput } from '@archguard/contracts'
import { buildPlan } from './build-plan'

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

function requirementsMarkdown(plan: PlanDraft): string {
  return plan.requirements.map((item) => `## ${item.id} ${item.title}\n${item.description}`).join('\n\n')
}

function delta(base: PlanDraft, plan: PlanDraft) {
  return {
    effortHours: money(plan.metrics.effortHours - base.metrics.effortHours),
    cost: money(plan.metrics.cost - base.metrics.cost),
    durationDays: money(plan.metrics.durationDays - base.metrics.durationDays),
  }
}

export function buildScenarios(base: PlanDraft, version: number, input: PlanScenarioInput): PlanScenarioComparison {
  const markdown = requirementsMarkdown(base)

  const accept = buildPlan(markdown, input.acceptTasksCsv)
  const reduce = buildPlan(markdown, input.reduceTasksCsv)

  const scenarios: PlanScenario[] = [
    {
      kind: 'accept',
      title: '接受变更',
      plan: accept,
      delta: delta(base, accept),
      futurePlan: null,
      assumptions: ['方案按完整范围纳入当前交付计划。'],
      risks: ['需确认新增任务与原任务的依赖关系。'],
    },
    {
      kind: 'reduce',
      title: '缩小范围',
      plan: reduce,
      delta: delta(base, reduce),
      futurePlan: null,
      assumptions: ['方案仅保留输入 CSV 中的任务范围。'],
      risks: ['缩小范围可能留下可追踪的需求缺口。'],
    },
  ]

  if (input.deferTasksCsv.trim()) {
    const future = buildPlan(markdown, input.deferTasksCsv)
    scenarios.push({
      kind: 'defer',
      title: '延后实施',
      plan: base,
      delta: { effortHours: 0, cost: 0, durationDays: 0 },
      futurePlan: future,
      assumptions: ['当前交付任务保持原安排；未来计划使用单独 CSV 估算。'],
      risks: ['未来工期待进一步排期。'],
    })
  } else {
    scenarios.push({
      kind: 'defer',
      title: '延后实施',
      plan: base,
      delta: { effortHours: 0, cost: 0, durationDays: 0 },
      futurePlan: null,
      assumptions: ['当前交付任务保持原安排。'],
      risks: ['未来计划未提供，工期与成本待排期。'],
    })
  }

  return { basePlanVersion: version, basePlan: base, scenarios, formulaVersion: 'c-schedule-v1' }
}
