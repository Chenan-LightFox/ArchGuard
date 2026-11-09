import type { CreateProjectInput, HealthStatus, Project, ScanPreflight } from '@archguard/contracts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    const body: { message?: unknown } | null = await response.json().catch(() => null)
    const message = typeof body?.message === 'string' ? body.message : `请求失败（${response.status}）。`
    throw new Error(message)
  }
  return response.json() as Promise<T>
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
}
