import type {
  AnalysisDraft,
  AnalysisRevision,
  ChangeRequest,
  PlanDraft,
  RepositoryScanDetail,
  ScenarioDraft,
  ScenarioInputSet,
  ScenarioRevision,
} from '@archguard/contracts'
import type { Actor } from './actor'
import { fail } from './errors'

export interface AnalysisContext {
  projectId: string
  changeRequest: ChangeRequest
  baselinePlan: PlanDraft | undefined
  baselineScan: RepositoryScanDetail | undefined
  actor: Actor
}

export interface AnalysisAdapter {
  analyze(context: AnalysisContext, body: unknown): AnalysisDraft
}

export interface ScenarioContext extends AnalysisContext {
  analysis: AnalysisRevision
  existingScenarios: ScenarioRevision[]
}

export interface ScenarioAdapter {
  compute(context: ScenarioContext, input: ScenarioInputSet): ScenarioDraft
}

export class NotConnectedAnalysisAdapter implements AnalysisAdapter {
  analyze(): AnalysisDraft {
    fail('NOT_READY', 503, '需求映射与影响分析（角色 B）尚未接入，暂时无法创建分析版本。')
  }
}

export class NotConnectedScenarioAdapter implements ScenarioAdapter {
  compute(): ScenarioDraft {
    fail('NOT_READY', 503, '三方案计算（角色 C）尚未接入，暂时无法创建方案版本。')
  }
}

export const ANALYSIS_ADAPTER = Symbol('ANALYSIS_ADAPTER')
export const SCENARIO_ADAPTER = Symbol('SCENARIO_ADAPTER')
