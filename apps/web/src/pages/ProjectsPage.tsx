import { useState, type FormEvent } from 'react'
import type { Project } from '@archguard/contracts'
import { api } from '../api'

interface Props {
  projects: Project[]
  selectedId?: string
  ready: boolean
  onSelect: (id: string) => void
  onCreate: (project: Project) => void
}

export function ProjectsPage({ projects, selectedId, ready, onSelect, onCreate }: Props) {
  const [name, setName] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const project = await api.createProject({ name, repositoryUrl })
      onCreate(project)
      setName('')
      setRepositoryUrl('')
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法创建项目。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>登记项目</h2>
        <p className="muted">填写项目名称和 HTTPS Git 地址，将仓库登记到本地工作区。</p>
        <form onSubmit={createProject}>
          <label htmlFor="project-name">项目名称</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            placeholder="例如：课程演示项目"
            required
          />
          <label htmlFor="repository-url">Git 仓库地址</label>
          <input
            id="repository-url"
            type="url"
            value={repositoryUrl}
            onChange={(event) => setRepositoryUrl(event.target.value)}
            maxLength={2048}
            placeholder="https://github.com/org/repo"
            required
          />
          <button className="primary" disabled={saving || !ready}>
            {saving ? '保存中…' : '创建项目'}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </section>
      <section className="card">
        <h2>已登记项目</h2>
        {ready && projects.length === 0 && <p className="muted">创建一个项目后，可以运行扫描环境检查。</p>}
        {!ready && <p className="muted">等待项目列表。</p>}
        <ul className="item-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                className="project-item"
                onClick={() => onSelect(project.id)}
                aria-pressed={project.id === selectedId}
              >
                <strong>{project.name}</strong>
                <span>{project.repositoryUrl}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
