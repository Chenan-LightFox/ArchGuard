import { useRef, useState, type FormEvent } from 'react'
import type { CreateProjectInput, Project } from '@archguard/contracts'
import { api } from '../api'

interface Props {
  projects: Project[]
  selectedId?: string
  ready: boolean
  onSelect: (id: string) => void
  onCreate: (project: Project) => void
  onUpdate: (project: Project) => void
  onDelete: (id: string) => void
}

const emptyProject: CreateProjectInput = { name: '', repositoryUrl: '' }

export function ProjectsPage({ projects, selectedId, ready, onSelect, onCreate, onUpdate, onDelete }: Props) {
  const [draft, setDraft] = useState(emptyProject)
  const [editing, setEditing] = useState<Project>()
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string>()
  const [formError, setFormError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const { name, repositoryUrl } = editing ?? draft
  const busy = saving || deletingId !== undefined

  function changeField(field: keyof CreateProjectInput, value: string) {
    if (editing) setEditing({ ...editing, [field]: value })
    else setDraft({ ...draft, [field]: value })
  }

  function startEditing(project: Project) {
    setEditing(project)
    setFormError('')
    nameInput.current?.focus()
  }

  function stopEditing() {
    setEditing(undefined)
    setFormError('')
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !ready) return
    setSaving(true)
    setFormError('')
    try {
      if (editing) {
        onUpdate(await api.updateProject(editing.id, { name, repositoryUrl }))
        stopEditing()
      } else {
        onCreate(await api.createProject({ name, repositoryUrl }))
        setDraft(emptyProject)
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '无法保存项目。')
    } finally {
      setSaving(false)
    }
  }

  async function deleteProject(project: Project) {
    const confirmed = window.confirm(`删除项目「${project.name}」？项目的扫描记录和计划版本也会一并删除，且无法恢复。`)
    if (!confirmed) return
    setDeletingId(project.id)
    setDeleteError('')
    try {
      await api.deleteProject(project.id)
      onDelete(project.id)
      if (editing?.id === project.id) stopEditing()
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '无法删除项目。')
    } finally {
      setDeletingId(undefined)
    }
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>{editing ? '编辑项目' : '登记项目'}</h2>
        <form onSubmit={saveProject}>
          <label htmlFor="project-name">项目名称</label>
          <input
            id="project-name"
            ref={nameInput}
            value={name}
            onChange={(event) => changeField('name', event.target.value)}
            maxLength={100}
            disabled={busy}
            required
          />
          <label htmlFor="repository-url">Git 仓库地址</label>
          <input
            id="repository-url"
            type="url"
            value={repositoryUrl}
            onChange={(event) => changeField('repositoryUrl', event.target.value)}
            maxLength={2048}
            disabled={busy}
            required
          />
          <div className="project-actions">
            <button className="primary" disabled={busy || !ready}>
              {saving ? '保存中…' : editing ? '保存修改' : '创建项目'}
            </button>
            {editing && <button className="secondary" type="button" onClick={stopEditing} disabled={busy}>取消</button>}
          </div>
          {formError && <p className="error" role="alert">{formError}</p>}
        </form>
      </section>
      <section className="card">
        <h2>已登记项目</h2>
        {ready && projects.length === 0 && <p className="muted">暂无项目</p>}
        {!ready && <p className="muted">等待项目列表。</p>}
        {deleteError && <p className="error" role="alert">{deleteError}</p>}
        <ul className="item-list">
          {projects.map((project) => (
            <li className="project-row" key={project.id}>
              <button
                className="project-item"
                onClick={() => onSelect(project.id)}
                aria-pressed={project.id === selectedId}
              >
                <strong>{project.name}</strong>
                <span>{project.repositoryUrl}</span>
              </button>
              <div className="project-actions">
                <button className="secondary" aria-label={`编辑 ${project.name}`}
                  disabled={busy || !ready} onClick={() => startEditing(project)}>
                  编辑
                </button>
                <button className="secondary project-delete" aria-label={`删除 ${project.name}`}
                  disabled={busy || !ready} onClick={() => void deleteProject(project)}>
                  {deletingId === project.id ? '删除中…' : '删除'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
