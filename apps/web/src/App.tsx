import { useEffect, useState } from 'react'
import type { Project } from '@archguard/contracts'
import { api, apiLoginUrl, ApiResponseError } from './api'
import { ProjectsPage } from './pages/ProjectsPage'
import { RepositoryScansPage } from './pages/RepositoryScansPage'
import { PlansPage } from './pages/PlansPage'
import { LlmSettingsPage } from './pages/LlmSettingsPage'

const sections = {
  projects: { title: '项目工作区', nav: '项目' },
  scans: { title: '架构扫描', nav: '架构扫描' },
  plans: { title: '需求与计划', nav: '需求与计划' },
  changes: { title: '变更分析', nav: '变更分析' },
  approvals: { title: '审批与发布', nav: '审批与发布' },
  reports: { title: '复扫与报告', nav: '复扫与报告' },
  llm: { title: 'LLM 设置', nav: 'LLM 设置' },
} as const

type Section = keyof typeof sections

const connectionStatuses = {
  connecting: { tone: 'running', text: '正在连接 API' },
  ready: { tone: 'succeeded', text: 'API 已连接' },
  unauthorized: { tone: '', text: 'API 需要登录' },
  offline: { tone: 'failed', text: 'API 离线' },
} as const

export function App() {
  const [section, setSection] = useState<Section>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [ready, setReady] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [retry, setRetry] = useState(0)
  const [health, setHealth] = useState<keyof typeof connectionStatuses>('connecting')
  const [healthError, setHealthError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function checkHealth() {
      try {
        await api.health(controller.signal)
        if (!controller.signal.aborted) {
          setHealth('ready')
          setHealthError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const unauthorized = error instanceof ApiResponseError && error.status === 401
          setHealth(unauthorized ? 'unauthorized' : 'offline')
          setHealthError(unauthorized ? '' : error instanceof Error ? error.message : '无法连接 API。')
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void checkHealth(), 5000)
      }
    }
    void checkHealth()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (health !== 'ready') {
      setReady(false)
      setProjectError('')
      return
    }
    const controller = new AbortController()
    api.listProjects(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setProjects(result)
      setReady(true)
      setProjectError('')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setProjectError(error instanceof Error ? error.message : '无法加载项目列表。')
    })
    return () => controller.abort()
  }, [health, retry])

  const active = projects.find((project) => project.id === selectedId) ?? projects[0]
  const current = sections[section]
  const connection = connectionStatuses[health]

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">A</span>
          <strong>ArchGuard</strong>
        </div>
        <nav aria-label="工作台">
          {(Object.keys(sections) as Section[]).map((key) => (
            <button key={key} onClick={() => setSection(key)} aria-current={section === key ? 'page' : undefined}>
              {sections[key].nav}
            </button>
          ))}
        </nav>
      </aside>
      <main>
        <div className="topbar">
          <span>本地工作区{active ? ` / ${active.name}` : ''}</span>
          <div className="api-connection">
            <span className={`status ${connection.tone}`} role="status">{connection.text}</span>
            {health === 'unauthorized' && <a className="api-login" href={apiLoginUrl}>登录 API</a>}
          </div>
        </div>
        <header className="page-header">
          <h1>{current.title}</h1>
        </header>
        {(healthError || projectError) && (
          <div className="notice">
            <p className="error break-code" role="alert">{healthError || projectError}</p>
            {projectError && <button className="secondary" onClick={() => { setProjectError(''); setRetry((value) => value + 1) }}>重试</button>}
          </div>
        )}
        {section === 'projects' ? (
          <ProjectsPage
            projects={projects}
            selectedId={active?.id}
            ready={ready}
            onSelect={setSelectedId}
            onCreate={(project) => {
              setProjects((current) => [project, ...current])
              setSelectedId(project.id)
            }}
          />
        ) : section === 'scans' ? (
          active ? <RepositoryScansPage key={active.id} project={active} /> : (
            <section className="card">
              <h2>先选择一个项目</h2>
              <button className="secondary" onClick={() => setSection('projects')}>返回项目工作区</button>
            </section>
          )
        ) : section === 'plans' ? (
          active ? <PlansPage key={active.id} project={active} /> : (
            <section className="card">
              <h2>先选择一个项目</h2>
              <button className="secondary" onClick={() => setSection('projects')}>返回项目工作区</button>
            </section>
          )
        ) : section === 'llm' ? <LlmSettingsPage /> : (
          <section className="card">
            <span className="status">待接入</span>
          </section>
        )}
      </main>
    </div>
  )
}
