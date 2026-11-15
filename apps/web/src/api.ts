import type {
  ArchitectureComparison, ArchitectureRules, CreateProjectInput, HealthStatus, LlmSettingsInput,
  LlmSettingsStatus, PlanDraft, PlanInput, PlanVersion, PlanVersionSummary, Project, RepositoryScan,
  RepositoryScanDetail, ScanPreflight,
} from '@archguard/contracts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    const body: { message?: unknown } | null = await response.json().catch(() => null)
    const message = typeof body?.message === 'string' ? body.message : `请求失败（${response.status}）。`
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

function json(method: 'POST' | 'PUT', body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export const api = {
  health: (signal: AbortSignal) => request<HealthStatus>('/health', { signal }),
  listProjects: (signal: AbortSignal) => request<Project[]>('/projects', { signal }),
  createProject: (input: CreateProjectInput) => request<Project>('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }),
  listPreflights: (projectId: string, signal: AbortSignal) =>
    request<ScanPreflight[]>(`/projects/${projectId}/scans/preflights`, { signal }),
  startPreflight: (projectId: string) =>
    request<ScanPreflight>(`/projects/${projectId}/scans/preflights`, { method: 'POST' }),
  listScans: (projectId: string, signal: AbortSignal) =>
    request<RepositoryScan[]>(`/projects/${projectId}/scans`, { signal }),
  getScan: (projectId: string, scanId: string, signal: AbortSignal) =>
    request<RepositoryScanDetail>(`/projects/${projectId}/scans/${scanId}`, { signal }),
  startScan: (projectId: string, ref: string, rules?: ArchitectureRules) =>
    request<RepositoryScan>(`/projects/${projectId}/scans`, json('POST', { ref, rules })),
  compareScans: (projectId: string, scanId: string, baselineId: string, signal: AbortSignal) =>
    request<ArchitectureComparison>(`/projects/${projectId}/scans/${scanId}/compare/${baselineId}`, { signal }),
  listPlans: (projectId: string, signal: AbortSignal) =>
    request<PlanVersionSummary[]>(`/projects/${projectId}/plan-versions`, { signal }),
  getPlan: (projectId: string, version: number, signal: AbortSignal) =>
    request<PlanVersion>(`/projects/${projectId}/plan-versions/${version}`, { signal }),
  previewPlan: (projectId: string, input: PlanInput) =>
    request<PlanDraft>(`/projects/${projectId}/plan-versions/preview`, json('POST', input)),
  createPlan: (projectId: string, input: PlanInput) =>
    request<PlanVersion>(`/projects/${projectId}/plan-versions`, json('POST', input)),
  llmStatus: (signal: AbortSignal) => request<LlmSettingsStatus>('/llm/settings', { signal }),
  configureLlm: (input: LlmSettingsInput) => request<LlmSettingsStatus>('/llm/settings', json('PUT', input)),
  clearLlm: () => request<LlmSettingsStatus>('/llm/settings', { method: 'DELETE' }),
}
