import type {
  ArchitectureComparison, ArchitectureRules, CreateProjectInput, HealthStatus, LlmSettingsInput,
  LlmSettingsStatus, PlanDraft, PlanInput, PlanVersion, PlanVersionSummary, Project, RepositoryScan,
  RepositoryScanDetail, ScanPreflight,
} from '@archguard/contracts'

const siteBase = import.meta.env.BASE_URL.replace(/\/+$/, '')
const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '') ||
  (siteBase ? `${siteBase}/backend` : '/api')

const healthPath = '/health'

class ApiResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase}${path}`
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new Error(`无法请求 ${url}。`)
  }
  if (!response.ok) {
    const body: { message?: unknown } | null = await response.json().catch(() => null)
    const message = typeof body?.message === 'string' ? body.message : `${url} 返回 HTTP ${response.status}。`
    throw new ApiResponseError(response.status, message)
  }
  try {
    return await response.json() as T
  } catch (error) {
    if (init?.signal?.aborted) throw error
    const format = response.headers.get('Content-Type')?.includes('text/html') ? 'HTML 页面' : '无法解析的响应'
    throw new ApiResponseError(response.status, `${url} 返回 HTTP ${response.status} 和${format}，应返回 JSON。`)
  }
}

function json(method: 'POST' | 'PUT', body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export const api = {
  health: async (signal: AbortSignal): Promise<HealthStatus> => {
    const health = await request<HealthStatus>(healthPath, { signal, cache: 'no-store' })
    if (health?.status !== 'ok' || health.database !== 'ready') {
      throw new ApiResponseError(200, `${apiBase}${healthPath} 返回的 JSON 不是 ArchGuard 健康检查结果。`)
    }
    return health
  },
  listProjects: (signal: AbortSignal) => request<Project[]>('/projects', { signal, cache: 'no-store' }),
  createProject: (input: CreateProjectInput) => request<Project>('/projects', json('POST', input)),
  updateProject: (id: string, input: CreateProjectInput) =>
    request<Project>(`/projects/${id}`, json('PUT', input)),
  deleteProject: (id: string) => request<{ id: string }>(`/projects/${id}`, { method: 'DELETE' }),
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
