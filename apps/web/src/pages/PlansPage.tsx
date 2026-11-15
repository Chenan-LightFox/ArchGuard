import { useEffect, useState, type FormEvent } from 'react'
import type { PlanDraft, PlanInput, PlanVersionSummary, Project } from '@archguard/contracts'
import { api } from '../api'

const example: PlanInput = {
  requirementsMarkdown: '## REQ-07 导出审计记录\n保存导出事件，验证事件字段。',
  tasksCsv: [
    'id,title,requirementIds,predecessorIds,effortHours,durationDays,hourlyRate,modulePaths',
    'T1,实现导出日志,REQ-07,,16,,150,src/export/',
    'T2,回归测试,REQ-07,T1,8,,100,test/',
  ].join('\n'),
}

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 })

function PlanSummary({ plan }: { plan: PlanDraft }) {
  return (
    <>
      <div className="metrics">
        <span>工时 <strong>{number.format(plan.metrics.effortHours)} 人时</strong></span>
        <span>交付工期 <strong>{number.format(plan.metrics.durationDays)} 工作日</strong></span>
        <span>人工成本 <strong>{number.format(plan.metrics.cost)} 元</strong></span>
      </div>
      <p>一条关键路径 <code>{plan.metrics.criticalPath.join(' → ')}</code></p>
      <div className="scan-table">
        <table>
          <thead><tr><th>任务</th><th>需求</th><th>前置</th><th>工时</th><th>开始 → 完成</th><th>关联代码</th></tr></thead>
          <tbody>
            {plan.tasks.map((task) => (
              <tr key={task.id}>
                <td><code>{task.id}</code> {task.title}</td>
                <td>{task.requirementIds.join('、') || '待关联'}</td>
                <td>{task.predecessorIds.join('、') || '—'}</td>
                <td>{number.format(task.effortHours)}</td>
                <td>{number.format(task.earliestStart)} → {number.format(task.earliestFinish)}</td>
                <td>{task.modulePaths.join('、') || '待关联'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="scan-details">
        <summary>查看需求（{plan.requirements.length}）</summary>
        <ul className="item-list">{plan.requirements.map((item) => (
          <li key={item.id}><strong>{item.id} {item.title}</strong><p className="preserve-lines">{item.description}</p></li>
        ))}</ul>
      </details>
    </>
  )
}

export function PlansPage({ project }: { project: Project }) {
  const [input, setInput] = useState<PlanInput>({ requirementsMarkdown: '', tasksCsv: '' })
  const [preview, setPreview] = useState<PlanDraft | null>(null)
  const [history, setHistory] = useState<PlanVersionSummary[]>([])
  const [version, setVersion] = useState<number | null>(null)
  const [saved, setSaved] = useState<PlanDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    api.listPlans(project.id, controller.signal).then((versions) => {
      if (controller.signal.aborted) return
      setHistory((current) => current.length ? current : versions)
      setVersion((current) => current ?? versions[0]?.version ?? null)
    }).catch(() => {
      if (!controller.signal.aborted) setHistoryError('无法读取计划历史。')
    })
    return () => controller.abort()
  }, [project.id])

  useEffect(() => {
    if (version === null) return
    const controller = new AbortController()
    api.getPlan(project.id, version, controller.signal).then((plan) => {
      if (!controller.signal.aborted) setSaved(plan)
    }).catch(() => {
      if (!controller.signal.aborted) setHistoryError('无法读取此计划版本。')
    })
    return () => controller.abort()
  }, [project.id, version])

  function update(value: PlanInput) {
    setInput(value)
    setPreview(null)
    setNotice('')
    setError('')
  }

  async function loadFile(file: File | undefined, field: keyof PlanInput) {
    if (!file) return
    setBusy(true)
    try {
      if (file.size > 1_000_000) throw new Error('文件大小应小于 1 MB。')
      const content = await file.text()
      update({ ...input, [field]: content })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取文件失败。')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (preview) {
        const plan = await api.createPlan(project.id, input)
        setHistory((versions) => [plan, ...versions])
        setVersion(plan.version)
        setSaved(plan)
        setPreview(null)
        setNotice(`已发布计划 v${plan.version}。`)
      } else {
        setPreview(await api.previewPlan(project.id, input))
        setNotice('')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '计划处理失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>导入计划基线</h2>
        <button type="button" className="secondary" disabled={busy} onClick={() => update(example)}>填入示例</button>
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy}>
            <label htmlFor="requirements-file">上传需求 Markdown</label>
            <input id="requirements-file" type="file" accept=".md,.markdown,text/markdown" onChange={(event) => {
              void loadFile(event.target.files?.[0], 'requirementsMarkdown')
              event.target.value = ''
            }} />
            <label htmlFor="requirements-markdown">需求 Markdown</label>
            <textarea id="requirements-markdown" value={input.requirementsMarkdown} rows={4} required
              onChange={(event) => update({ ...input, requirementsMarkdown: event.target.value })} />
            <label htmlFor="tasks-file">上传任务 CSV</label>
            <input id="tasks-file" type="file" accept=".csv,text/csv" onChange={(event) => {
              void loadFile(event.target.files?.[0], 'tasksCsv')
              event.target.value = ''
            }} />
            <label htmlFor="tasks-csv">任务 CSV</label>
            <textarea id="tasks-csv" value={input.tasksCsv} rows={5} required
              onChange={(event) => update({ ...input, tasksCsv: event.target.value })} />
            {preview && <section className="plan-preview"><h3>计划预览</h3><PlanSummary plan={preview} /></section>}
            <button className="primary">{busy ? '处理中…' : preview ? '确认发布基线' : '预览与校验'}</button>
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </form>
      </section>
      <section className="card">
        <h2>计划版本</h2>
        {historyError && <p className="error" role="alert">{historyError}</p>}
        {!history.length ? <p className="muted">暂无计划版本</p> : (
          <>
            <label htmlFor="plan-version">选择版本</label>
            <select id="plan-version" value={version ?? ''} onChange={(event) => {
              setSaved(null)
              setHistoryError('')
              setVersion(Number(event.target.value))
            }}>
              {history.map((item) => <option key={item.version} value={item.version}>v{item.version}{item.version === history[0].version ? '（当前）' : ''} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}
            </select>
            {saved && <PlanSummary plan={saved} />}
          </>
        )}
      </section>
    </div>
  )
}
