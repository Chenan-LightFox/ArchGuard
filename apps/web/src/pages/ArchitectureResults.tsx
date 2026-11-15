import { useEffect, useState } from 'react'
import type { ArchitectureComparison, ArchitectureIssue, ArchitectureReport, RepositoryScan } from '@archguard/contracts'
import { api } from '../api'

function Issues({ items }: { items: ArchitectureIssue[] }) {
  const [page, setPage] = useState(0)
  const pageSize = 20
  const pages = Math.ceil(items.length / pageSize)
  const current = Math.min(page, Math.max(0, pages - 1))
  if (!items.length) return <p className="muted">没有检出此类问题。</p>
  return (
    <>
      <ul className="item-list">
        {items.slice(current * pageSize, (current + 1) * pageSize).map((issue) => (
          <li className="job-item" key={issue.id}>
            <strong>{issue.rule === 'cycle' ? '循环依赖' : `分层违规 · ${issue.layers?.from} → ${issue.layers?.to}`}</strong>
            <p className="break-code"><code>{issue.path.join(' → ')}</code></p>
            <details className="scan-details">
              <summary>依赖证据（{issue.evidence.length}）</summary>
              <ul className="scan-paths">{issue.evidence.map((edge, index) => (
                <li key={index}><code>{edge.from}:{edge.line} → {edge.to}</code></li>
              ))}</ul>
            </details>
          </li>
        ))}
      </ul>
      {pages > 1 && <div className="scan-pagination">
        <button className="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button>
        <span>{current + 1} / {pages}</span>
        <button className="secondary" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>下一页</button>
      </div>}
    </>
  )
}

export function ArchitectureResults({ report, projectId, scanId, jobs }: {
  report: ArchitectureReport
  projectId: string
  scanId: string
  jobs: RepositoryScan[]
}) {
  const [filter, setFilter] = useState('all')
  const [baseline, setBaseline] = useState('')
  const [comparison, setComparison] = useState<ArchitectureComparison>()
  const [error, setError] = useState('')
  const candidates = jobs.filter((job) => job.id !== scanId && job.status === 'succeeded')
  const cycleCount = report.issues.filter(({ rule }) => rule === 'cycle').length

  useEffect(() => {
    if (!baseline) return
    const controller = new AbortController()
    api.compareScans(projectId, scanId, baseline, controller.signal).then((value) => {
      if (!controller.signal.aborted) setComparison(value)
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '复扫对比失败。')
    })
    return () => controller.abort()
  }, [projectId, scanId, baseline])

  return (
    <section className="card">
      <h2>架构检测</h2>
      <p>{cycleCount} 组循环依赖 · {report.rules.layers.length ? `${report.issues.length - cycleCount} 条分层违规` : '分层规则待配置'}</p>
      {report.coverageLimited && <p className="muted">扫描覆盖有限，请结合未归层文件、未解析引用、跳过文件和配置警告复核结果。</p>}
      {report.rules.layers.length > 0 && (
        <details className="scan-details">
          <summary>本次分层配置 · {report.unassignedFiles.length} 个文件未归层</summary>
          <pre className="preserve-lines">{JSON.stringify(report.rules, null, 2)}</pre>
          {report.unassignedFiles.length > 0 && <ul className="scan-paths">
            {report.unassignedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
          </ul>}
        </details>
      )}
      <label htmlFor="issue-filter">问题类型</label>
      <select id="issue-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">全部</option><option value="cycle">循环依赖</option><option value="layer">分层违规</option>
      </select>
      <Issues key={filter} items={report.issues.filter(({ rule }) => filter === 'all' || filter === rule)} />
      {candidates.length > 0 && <div className="plan-preview">
        <label htmlFor="baseline-scan">与历史扫描对比</label>
        <select id="baseline-scan" value={baseline} onChange={(event) => {
          setComparison(undefined)
          setError('')
          setBaseline(event.target.value)
        }}>
          <option value="">选择基线扫描</option>
          {candidates.map((job) => <option key={job.id} value={job.id}>
            {job.summary?.commit.slice(0, 12)} · {job.ref} · {new Date(job.createdAt).toLocaleString('zh-CN')}
          </option>)}
        </select>
        {error && <p className="error" role="alert">{error}</p>}
        {baseline && !error && !comparison && <p className="muted" role="status">正在对比…</p>}
        {comparison && <div>
          {comparison.coverageLimited && <p className="muted">至少一次扫描覆盖有限。不再检出的问题仍需复核。</p>}
          {([
            ['新增', comparison.added], ['仍存在', comparison.remaining], ['本次未检出', comparison.missing],
          ] as const).map(([label, issues]) => <details className="scan-details" key={label}>
            <summary>{label}（{issues.length}）</summary><Issues items={issues} />
          </details>)}
        </div>}
      </div>}
    </section>
  )
}
