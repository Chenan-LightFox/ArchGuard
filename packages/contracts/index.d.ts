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
