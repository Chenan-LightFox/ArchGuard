export interface HealthStatus {
  status: 'ok'
  database: 'ready'
}

export interface CreateProjectInput {
  name: string
  repositoryUrl: string
}

export interface Project extends CreateProjectInput {
  id: string
  createdAt: string
}

export interface ScanEnvironment {
  git: string
  typescript: string
}

export interface ScanPreflight {
  id: string
  projectId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  createdAt: string
  finishedAt: string | null
  result: ScanEnvironment | null
  error: string | null
}

export type DependencyKind = 'import' | 're-export' | 'type' | 'require' | 'dynamic-import'

export interface ImportReference {
  from: string
  specifier: string
  line: number
  kind: DependencyKind
}

export interface RepositoryAnalysis {
  files: string[]
  dependencies: (ImportReference & { to: string })[]
  unresolved: ImportReference[]
  externalCount: number
  configurationWarnings: string[]
  syntaxWarningFiles: string[]
  computedImportCount: number
}

export interface RepositoryScanResult extends RepositoryAnalysis {
  commit: string
  analyzerVersion: string
  skippedFiles: number
  architecture?: ArchitectureReport
}

export interface RepositoryScan {
  id: string
  projectId: string
  ref: string
  status: ScanPreflight['status']
  createdAt: string
  finishedAt: string | null
  error: string | null
  summary: {
    commit: string
    files: number
    dependencies: number
    unresolved: number
  } | null
}

export interface RepositoryScanDetail extends RepositoryScan {
  result: RepositoryScanResult | null
}

export interface ArchitectureRules {
  layers: { name: string; prefix: string }[]
  allowed: { from: string; to: string }[]
}

export interface ArchitectureIssue {
  id: string
  rule: 'cycle' | 'layer'
  path: string[]
  evidence: RepositoryAnalysis['dependencies']
  layers?: { from: string; to: string }
}

export interface ArchitectureReport {
  ruleVersion: number
  rules: ArchitectureRules
  issues: ArchitectureIssue[]
  unassignedFiles: string[]
  coverageLimited: boolean
}

export interface ArchitectureComparison {
  added: ArchitectureIssue[]
  remaining: ArchitectureIssue[]
  missing: ArchitectureIssue[]
  coverageLimited: boolean
}

export interface PlanInput {
  requirementsMarkdown: string
  tasksCsv: string
}

export interface PlanRequirement {
  id: string
  title: string
  description: string
}

export interface PlanTask {
  id: string
  title: string
  requirementIds: string[]
  predecessorIds: string[]
  modulePaths: string[]
  effortHours: number
  durationDays: number
  hourlyRate: number
  earliestStart: number
  earliestFinish: number
}

export interface PlanMetrics {
  effortHours: number
  durationDays: number
  cost: number
  criticalPath: string[]
}

export interface PlanDraft {
  requirements: PlanRequirement[]
  tasks: PlanTask[]
  metrics: PlanMetrics
}

export interface PlanVersionSummary {
  version: number
  createdAt: string
  metrics: PlanMetrics
}

export interface PlanVersion extends PlanVersionSummary, PlanDraft {}

export interface LlmSettingsInput {
  apiKey: string
  baseUrl?: string
  model?: string
}

export interface LlmSettingsStatus {
  configured: boolean
  baseUrl: string
  model: string
}

// ===== 角色 D：审批、存储与报告后端 =====

export type ChangeRequestStatus = 'draft' | 'pending' | 'approved' | 'rejected'

export interface ChangeRequest {
  id: string
  projectId: string
  title: string
  description: string
  requesterId: string
  draftRevision: number
  status: ChangeRequestStatus
  basePlanVersion: number
  baseScanId: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  decidedAt: string | null
}

export interface CreateChangeRequestInput {
  title: string
  description: string
  basePlanVersion: number
  baseScanId: string
}

export interface UpdateChangeRequestInput {
  title?: string
  description?: string
  basePlanVersion?: number
  baseScanId?: string
  expectedRevision: number
}

export type ImpactTaskCategory = 'change' | 'review' | 'schedule'

export interface ImpactTask {
  taskId: string
  category: ImpactTaskCategory
  reasons: string[]
}

export interface AnalysisRevision {
  id: string
  changeRequestId: string
  changeRequestRevision: number
  revision: number
  baselinePlanVersion: number
  baselineScanId: string
  confirmedMappings: Record<string, string[]>
  impactTasks: ImpactTask[]
  impactPaths: string[][]
  evidenceRefs: string[]
  openItems: string[]
  confirmedBy: string | null
  confirmedAt: string | null
  createdAt: string
}

export interface AnalysisDraft {
  baselinePlanVersion: number
  baselineScanId: string
  confirmedMappings: Record<string, string[]>
  impactTasks: ImpactTask[]
  impactPaths: string[][]
  evidenceRefs: string[]
  openItems: string[]
  confirmedBy: string | null
}

export type ScenarioKind = 'accept' | 'reduce' | 'defer'

export interface ScenarioTaskDiff {
  taskId: string
  operation: 'add' | 'modify' | 'remove'
  title?: string
  requirementIds?: string[]
  predecessorIds?: string[]
  modulePaths?: string[]
  effortHours?: number
  durationDays?: number
  hourlyRate?: number
}

export interface ScenarioEstimationInput {
  source: string
  ruleVersion: string
  basis: string
}

export interface FutureEstimate {
  effortHours: number
  cost: number
  durationDays: number | null
}

export interface ScenarioRevision {
  id: string
  changeRequestId: string
  changeRequestRevision: number
  revision: number
  analysisRevisionId: string
  baselinePlanVersion: number
  baselineScanId: string
  calculationRuleVersion: string
  scenarios: { accept: ScenarioScheme; reduce: ScenarioScheme; defer: ScenarioScheme }
  createdAt: string
}

export interface ScenarioScheme {
  includedScope: string[]
  excludedScope: string[]
  acceptanceCriteria: string[]
  taskDiffs: ScenarioTaskDiff[]
  estimationInput: ScenarioEstimationInput
  candidatePlan: PlanDraft
  metrics: PlanMetrics
  deltas: { effortHours: number; durationDays: number; cost: number }
  assumptions: string[]
  risks: string[]
  futureEstimate: FutureEstimate | null
}

export interface ScenarioInput {
  kind: ScenarioKind
  includedScope: string[]
  excludedScope: string[]
  acceptanceCriteria: string[]
  taskDiffs: ScenarioTaskDiff[]
  estimationInput: ScenarioEstimationInput
}

export interface ScenarioInputSet {
  accept: ScenarioInput
  reduce: ScenarioInput
  defer: ScenarioInput
}

export interface ScenarioDraft {
  analysisRevisionId: string
  baselinePlanVersion: number
  baselineScanId: string
  calculationRuleVersion: string
  scenarios: { accept: ScenarioScheme; reduce: ScenarioScheme; defer: ScenarioScheme }
}

export interface SnapshotBaseline {
  planVersion: number
  plan: PlanVersion | null
  scanId: string
  repositoryUrl: string | null
  scanCommit: string | null
  analyzerVersion: string | null
  ruleVersion: number | null
  rules: ArchitectureRules | null
}

export interface ChangeSnapshot {
  request: ChangeRequest
  baseline: SnapshotBaseline
  analysis: AnalysisRevision
  scenarioRevision: ScenarioRevision
  confirmedMappings: Record<string, string[]>
  estimationBasis: string
}

export interface ChangeSubmission {
  id: string
  changeRequestId: string
  revision: number
  basePlanVersion: number
  baseScanId: string
  baseScanCommit: string
  analysisRevisionId: string
  scenarioRevisionId: string
  selectedKind: ScenarioKind
  requesterId: string
  snapshot: ChangeSnapshot
  createdAt: string
}

export type ApprovalOutcome = 'approved' | 'rejected'

export interface ApprovalDecision {
  id: string
  submissionId: string
  approverId: string
  decision: ApprovalOutcome
  comment: string
  createdAt: string
  publishedPlanVersion: number | null
  deferredItemId: string | null
  idempotencyKey: string
  requestFingerprint: string
}

export interface ApprovalResult {
  decision: ApprovalDecision
  publishedPlan: PlanVersion | null
  deferredItem: DeferredItem | null
}

export interface DecideInput {
  decision: ApprovalOutcome
  comment?: string
  idempotencyKey: string
  submissionId: string
  expectedSnapshotHash: string
}

export interface DeferredItem {
  id: string
  projectId: string
  changeRequestId: string
  submissionId: string
  decisionId: string
  scope: string[]
  futureEstimate: FutureEstimate | null
  priority: string
  schedulingStatus: 'pending' | 'scheduled'
  createdAt: string
  scheduledAt: string | null
}

export type ImplementationStatus = 'not_started' | 'in_progress' | 'waiting_scheduling' | 'completed'

export type EvidenceSource = 'manual' | 'ci'

export type AcceptanceVerdict = 'accepted' | 'rejected' | 'pending'

export interface RequirementAcceptance {
  verdict: AcceptanceVerdict
  summary: string
}

export interface CoverageReview {
  accepted: boolean
  note?: string
}

export interface ImplementationEvidence {
  id: string
  implementationCheckId: string
  revision: number
  command: string
  passed: boolean
  executedAt: string | null
  outputSummary: string
  source: EvidenceSource
  recordedBy: string
  createdAt: string
}

export interface ImplementationCheck {
  id: string
  changeRequestId: string
  submissionId: string
  revision: number
  status: ImplementationStatus
  implementationCommit: string | null
  preScanId: string
  postScanId: string | null
  requirementAcceptance: RequirementAcceptance | null
  coverageReview: CoverageReview | null
  recordedBy: string
  createdAt: string
  evidence: ImplementationEvidence[]
}

export interface ImplementationCheckInput {
  submissionId: string
  status: ImplementationStatus
  implementationCommit?: string
  postScanId?: string
  requirementAcceptance?: RequirementAcceptance
  coverageReview?: CoverageReview
  evidence?: {
    command: string
    passed: boolean
    executedAt?: string
    outputSummary: string
    source?: EvidenceSource
  }
}

export interface ChangeReport {
  project: { id: string; name: string; repositoryUrl: string }
  changeRequest: ChangeRequest
  submission: ChangeSubmission | null
  baseline: {
    planVersion: number
    plan: PlanVersion | null
    scanId: string
    scanCommit: string | null
    analyzerVersion: string | null
    ruleVersion: number | null
    rules: ArchitectureRules | null
  }
  analysis: AnalysisRevision | null
  scenarioRevision: ScenarioRevision | null
  estimation: { source: string; ruleVersion: string; basis: string } | null
  decision: ApprovalDecision | null
  published: {
    planVersion: number | null
    parentVersion: number | null
    deferredItem: DeferredItem | null
  }
  implementation: ImplementationCheck | null
  rescan: {
    comparison: ArchitectureComparison | null
    comparable: boolean
    reason: string | null
  }
  limitations: string[]
}
