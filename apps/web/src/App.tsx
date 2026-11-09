import { useEffect, useState } from 'react'
import type { Project } from '@archguard/contracts'
import { api } from './api'
import { ProjectsPage } from './pages/ProjectsPage'
import { ScansPage } from './pages/ScansPage'

const sections = {
  projects: { title: '项目工作区', nav: '项目', description: '登记仓库，建立架构扫描和需求变更的共同入口。' },
  scans: { title: '架构扫描', nav: '架构扫描', description: '查看当前项目的扫描环境检查状态。' },
  plans: { title: '需求与计划', nav: '需求与计划', description: '管理需求、任务依赖和代码模块之间的关联。' },
  changes: { title: '变更分析', nav: '变更分析', description: '追踪影响路径，比较接受变更、缩小范围和延后实施。' },
  approvals: { title: '审批与发布', nav: '审批与发布', description: '审核固定版本的变更方案并生成计划版本。' },
  reports: { title: '复扫与报告', nav: '复扫与报告', description: '对照实施后的测试证据、架构扫描和计划变化。' },
} as const

type Section = keyof typeof sections

export function App() {
  const [section, setSection] = useState<Section>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [ready, setReady] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [retry, setRetry] = useState(0)
  const [health, setHealth] = useState<'connecting' | 'ready' | 'offline'>('connecting')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function checkHealth() {
      try {
        await api.health(controller.signal)
        if (!controller.signal.aborted) setHealth('ready')
      } catch {
        if (!controller.signal.aborted) setHealth('offline')
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
    const controller = new AbortController()
    api.listProjects(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setProjects(result)
      setReady(true)
      setProjectError('')
    }).catch(() => {
      if (!controller.signal.aborted) setProjectError('无法加载项目列表，请确认 API 已启动。')
    })
    return () => controller.abort()
  }, [retry])

  const active = projects.find((project) => project.id === selectedId) ?? projects[0]
  const current = sections[section]

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div><strong>ArchGuard</strong><small>架构与变更工作台</small></div>
        </div>
        <nav aria-label="工作台">
          {(Object.keys(sections) as Section[]).map((key, index) => (
            <button key={key} onClick={() => setSection(key)} aria-current={section === key ? 'page' : undefined}>
              <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              {sections[key].nav}
            </button>
          ))}
        </nav>
      </aside>
      <main>
        <div className="topbar">
          <span>本地工作区{active ? ` / ${active.name}` : ''}</span>
          <span className={`status ${health === 'ready' ? 'succeeded' : health === 'offline' ? 'failed' : ''}`} role="status">
            {health === 'ready' ? 'API 已连接' : health === 'offline' ? 'API 离线' : '正在连接 API'}
          </span>
        </div>
        <header className="page-header">
          <h1>{current.title}</h1>
          <p>{current.description}</p>
        </header>
        {projectError && (
          <div className="notice">
            <p className="error" role="alert">{projectError}</p>
            <button className="secondary" onClick={() => { setProjectError(''); setRetry((value) => value + 1) }}>重试</button>
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
          active ? <ScansPage key={active.id} project={active} /> : (
            <section className="card">
              <h2>先选择一个项目</h2>
              <p className="muted">在项目工作区登记或选择仓库后，即可检查扫描环境。</p>
              <button className="secondary" onClick={() => setSection('projects')}>返回项目工作区</button>
            </section>
          )
        ) : (
          <section className="card">
            <span className="status">待接入</span>
            <h2>{current.nav}模块</h2>
            <p className="muted">已预留工作台入口。对应数据和操作将在后续阶段接入。</p>
          </section>
        )}
      </main>
    </div>
  )
}
