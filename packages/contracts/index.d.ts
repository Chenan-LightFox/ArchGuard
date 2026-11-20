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

export type ChangeAnalysisStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface ChangeAnalysisInput {
  description: string
  scanId: string
  planVersion: number
}

export interface ChangeEvidence {
  id: string
  kind: 'requirement' | 'task' | 'module' | 'dependency' | 'task-dependency'
  description: string
  path: string[]
}

export type AiImpactVerdict = 'affected' | 'uncertain' | 'unaffected'

export interface ChangeTaskCandidate {
  taskId: string
  title: string
  classification: 'change' | 'review' | 'schedule'
  path: string[]
  evidenceIds: string[]
}

export interface ChangeTaskImpact extends ChangeTaskCandidate {
  classification: 'change' | 'review' | 'schedule'
  path: string[]
}

export interface ChangeCodeImpact {
  file: string
  classification: 'mapped' | 'dependent'
  path: string[]
  evidenceIds: string[]
}

export interface AiChangeCandidate {
  taskId: string
  classification: 'change' | 'review' | 'schedule'
  verdict?: AiImpactVerdict
  rationale: string
  evidenceIds: string[]
}

export interface ChangeUpstreamTask {
  taskId: string
  title: string
  requirementIds: string[]
  modulePaths: string[]
  path: string[]
  evidenceIds: string[]
}

export interface AiUpstreamImpact extends ChangeUpstreamTask {
  verdict: AiImpactVerdict
  rationale: string
}

export interface AiNewRequirement {
  id: string
  title: string
  description: string
  rationale: string
  startingPoint: true
  requiresArchitectureReview: true
}

export interface ChangeAnalysisResult {
  matchedRequirementIds: string[]
  coverageLimited: boolean
  coverageWarnings: string[]
  candidates: ChangeTaskCandidate[]
  affectedTasks: ChangeTaskImpact[]
  affectedFiles: ChangeCodeImpact[]
  evidence: ChangeEvidence[]
  aiCandidates: AiChangeCandidate[]
  upstreamTasks?: ChangeUpstreamTask[]
  aiUpstreamImpacts?: AiUpstreamImpact[]
  newRequirements?: AiNewRequirement[]
  aiWarnings?: string[]
  confirmedTaskIds: string[]
}

export interface ChangeAnalysisSummary {
  id: string
  projectId: string
  scanId: string
  planVersion: number
  status: ChangeAnalysisStatus
  createdAt: string
  finishedAt: string | null
  description: string
  error: string | null
}

export interface ChangeAnalysis extends ChangeAnalysisSummary {
  result: ChangeAnalysisResult | null
}
