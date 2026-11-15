import { useEffect, useState, type FormEvent } from 'react'
import type { Project, RepositoryScan, RepositoryScanResult } from '@archguard/contracts'
import { api } from '../api'
import { PreflightPanel } from './ScansPage'
import { ArchitectureResults } from './ArchitectureResults'
import type { ArchitectureRules } from '@archguard/contracts'

const rulesExample = JSON.stringify({
  layers: [{ name: 'UI', prefix: 'src/ui' }, { name: 'Core', prefix: 'src/core' }],
  allowed: [{ from: 'UI', to: 'Core' }],
}, null, 2)

const statuses: Record<RepositoryScan['status'], string> = {
  queued: '排队中',
  running: '扫描中',
  succeeded: '扫描完成',
  failed: '扫描失败',
}

function ResultPanel({ result }: { result: RepositoryScanResult }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const query = search.trim().toLowerCase()
  const edges = result.dependencies.filter((edge) =>
    !query || [edge.from, edge.to, edge.specifier].some((value) => value.toLowerCase().includes(query)))
  const pageSize = 50
  const pageCount = Math.ceil(edges.length / pageSize)
  const visible = edges.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <section className="card">
      <h2>扫描结果</h2>
      <p className="muted">提交 <code className="break-code">{result.commit}</code></p>
      <p>{result.files.length} 个 JS/TS 文件 · {result.dependencies.length} 条内部引用 · {result.externalCount} 条外部引用 · {result.unresolved.length} 条未解析</p>
      {result.skippedFiles > 0 && <p className="muted">按扫描范围跳过 {result.skippedFiles} 个源码或配置条目。</p>}
      {result.configurationWarnings.length > 0 && (
        <p className="error">部分项目配置无法完整解析：{result.configurationWarnings.join('、')}</p>
      )}
      {(result.computedImportCount ?? 0) > 0 && <p className="muted">{result.computedImportCount} 条计算式导入无法确定目标。</p>}
      {(result.syntaxWarningFiles?.length ?? 0) > 0 && (
        <details className="scan-details">
          <summary>含语法错误的文件（{result.syntaxWarningFiles.length}）</summary>
          <ul className="scan-paths">{result.syntaxWarningFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        </details>
      )}
      <div className="scan-filter">
        <label htmlFor="dependency-search">筛选内部依赖</label>
        <input id="dependency-search" value={search} placeholder="输入文件路径或导入名" onChange={(event) => {
          setSearch(event.target.value)
          setPage(0)
        }} />
      </div>
      {visible.length === 0 ? <p className="muted">没有匹配的内部依赖。</p> : (
        <div className="scan-table">
          <table>
            <thead><tr><th>来源</th><th>目标</th><th>类别</th></tr></thead>
            <tbody>
              {visible.map((edge, index) => (
                <tr key={page * pageSize + index}>
                  <td><code>{edge.from}:{edge.line}</code></td>
                  <td><code>{edge.to}</code></td>
                  <td>{edge.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <div className="scan-pagination">
          <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page + 1} / {pageCount}</span>
          <button className="secondary" disabled={page + 1 === pageCount} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      <details className="scan-details">
        <summary>源码文件（{result.files.length}）</summary>
        <ul className="scan-paths">{result.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      </details>
      {result.unresolved.length > 0 && (
        <details className="scan-details">
          <summary>未解析引用（{result.unresolved.length}）</summary>
          <ul className="scan-paths">{result.unresolved.map((item, index) => (
            <li key={index}><code>{item.from}:{item.line}</code> → <code>{item.specifier}</code></li>
          ))}</ul>
        </details>
      )}
    </section>
  )
}

export function RepositoryScansPage({ project }: { project: Project }) {
  const [jobs, setJobs] = useState<RepositoryScan[]>([])
  const [ref, setRef] = useState('')
  const [ruleText, setRuleText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPreflight, setShowPreflight] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [result, setResult] = useState<RepositoryScanResult | null>(null)
  const [listError, setListError] = useState('')
  const [actionError, setActionError] = useState('')
  const [detailError, setDetailError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const list = await api.listScans(project.id, controller.signal)
        if (controller.signal.aborted) return
        setJobs(list)
        setListError('')
      } catch {
        if (!controller.signal.aborted) setListError('读取扫描记录失败，正在重试。')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 1500)
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [project.id])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    api.getScan(project.id, selectedId, controller.signal).then((detail) => {
      if (!controller.signal.aborted) setResult(detail.result)
    }).catch(() => {
      if (!controller.signal.aborted) setDetailError('读取扫描详情失败，请重试。')
    })
    return () => controller.abort()
  }, [project.id, selectedId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setActionError('')
    try {
      let rules: ArchitectureRules | undefined
      if (ruleText.trim()) {
        try { rules = JSON.parse(ruleText) } catch { throw new Error('分层规则不是有效的 JSON。') }
      }
      const job = await api.startScan(project.id, ref, rules)
      setJobs((current) => current.some((item) => item.id === job.id) ? current : [job, ...current])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '无法提交扫描。')
    } finally {
      setSubmitting(false)
    }
  }

  function openResult(id: string) {
    if (selectedId === id) return
    setResult(null)
    setDetailError('')
    setSelectedId(id)
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>扫描仓库</h2>
        <p className="muted break-code">{project.repositoryUrl}</p>
        <form onSubmit={submit}>
          <label htmlFor="scan-ref">分支、标签引用或提交 SHA</label>
          <input id="scan-ref" value={ref} maxLength={200} onChange={(event) => setRef(event.target.value)}
            placeholder="留空使用默认分支，标签示例 refs/tags/v1.0.0" />
          <details>
            <summary>分层规则（可选）</summary>
            <p className="muted">按最长路径前缀归层。跨层依赖须列入 allowed，层内依赖自动允许。</p>
            <button className="secondary" type="button" onClick={() => setRuleText(rulesExample)}>填入规则示例</button>
            <label htmlFor="architecture-rules">分层规则 JSON</label>
            <textarea id="architecture-rules" rows={7} value={ruleText} onChange={(event) => setRuleText(event.target.value)} />
          </details>
          <button className="primary" disabled={submitting}>{submitting ? '提交中…' : '提交扫描'}</button>
        </form>
        {actionError && <p className="error" role="alert">{actionError}</p>}
      </section>
      <section className="card">
        <h2>扫描记录</h2>
        {listError && <p className="error" role="status">{listError}</p>}
        {jobs.length === 0 && !listError && <p className="muted">暂无扫描记录。</p>}
        <ul className="item-list">
          {jobs.map((job) => (
            <li key={job.id} className="job-item">
              <div className="job-heading">
                <span className={`status ${job.status}`}>{statuses[job.status]}</span>
                <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString('zh-CN')}</time>
              </div>
              <p className="break-code">{job.ref}</p>
              {job.summary && <p>{job.summary.commit.slice(0, 12)} · {job.summary.files} 个文件 · {job.summary.dependencies} 条内部引用</p>}
              {job.error && <p className="error">{job.error}</p>}
              {job.summary && <button className="secondary" onClick={() => openResult(job.id)}>查看结果</button>}
            </li>
          ))}
        </ul>
      </section>
      {selectedId && (result ? <div key={selectedId} className="stack">
        {result.architecture && <ArchitectureResults report={result.architecture} projectId={project.id} scanId={selectedId} jobs={jobs} />}
        <ResultPanel result={result} />
      </div> : (
        <section className="card">
          <p role="status" className={detailError ? 'error' : 'muted'}>{detailError || '正在读取扫描详情…'}</p>
          {detailError && <button className="secondary" onClick={() => { setSelectedId(''); setDetailError('') }}>返回记录</button>}
        </section>
      ))}
      <div><button className="secondary" aria-expanded={showPreflight} onClick={() => setShowPreflight(!showPreflight)}>扫描环境检查</button></div>
      {showPreflight && <PreflightPanel project={project} />}
    </div>
  )
}
