import { useEffect, useState, type FormEvent } from 'react'
import type { AiImpactVerdict, ChangeAnalysis, ChangeAnalysisSummary, ChangeTaskImpact, PlanVersionSummary, Project, RepositoryScan } from '@archguard/contracts'
import { api } from '../api'

const classificationLabels: Record<ChangeTaskImpact['classification'], string> = {
  change: '描述直接指向',
  review: '关联候选，待核实',
  schedule: '仅受排期影响',
}

const verdictLabels: Record<AiImpactVerdict, string> = {
  affected: '可能受影响',
  uncertain: '需要人工核实',
  unaffected: '判断不受影响',
}

const analysisStatus: Record<ChangeAnalysis['status'], string> = {
  queued: '排队中',
  running: '分析中',
  succeeded: '分析完成',
  failed: '分析失败',
}

export function ChangesPage({ project }: { project: Project }) {
  const [description, setDescription] = useState('')
  const [plans, setPlans] = useState<PlanVersionSummary[]>([])
  const [scans, setScans] = useState<RepositoryScan[]>([])
  const [planVersion, setPlanVersion] = useState<number | ''>('')
  const [scanId, setScanId] = useState('')
  const [analyses, setAnalyses] = useState<ChangeAnalysisSummary[]>([])
  const [analysisId, setAnalysisId] = useState('')
  const [analysisDetail, setAnalysisDetail] = useState<ChangeAnalysis>()
  const [confirmed, setConfirmed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [error, setError] = useState('')
  const [aiError, setAiError] = useState('')
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      api.listPlans(project.id, controller.signal),
      api.listScans(project.id, controller.signal),
      api.listChangeAnalyses(project.id, controller.signal),
    ]).then(([planList, scanList, analysisList]) => {
      if (controller.signal.aborted) return
      const completedScans = scanList.filter((scan) => scan.status === 'succeeded' && scan.summary)
      setPlans(planList)
      setScans(completedScans)
      setPlanVersion((current) => current || planList[0]?.version || '')
      setScanId((current) => current || completedScans[0]?.id || '')
      setAnalyses(analysisList)
      setAnalysisId((current) => current || analysisList[0]?.id || '')
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法加载分析基线。')
    })
    return () => controller.abort()
  }, [project.id])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const items = await api.listChangeAnalyses(project.id, controller.signal)
        if (controller.signal.aborted) return
        setAnalyses(items)
        setListError('')
      } catch (failure) {
        if (!controller.signal.aborted) setListError(failure instanceof Error ? failure.message : '读取分析记录失败。')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 1500)
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [project.id])

  const selectedSummary = analyses.find((item) => item.id === analysisId)
  useEffect(() => {
    if (!analysisId) return
    const controller = new AbortController()
    setDetailError('')
    api.getChangeAnalysis(project.id, analysisId, controller.signal).then((detail) => {
      if (!controller.signal.aborted) setAnalysisDetail(detail)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setDetailError(failure instanceof Error ? failure.message : '读取分析详情失败。')
    })
    return () => controller.abort()
  }, [project.id, analysisId, selectedSummary?.status])

  const selected = analysisDetail?.id === analysisId ? analysisDetail : undefined
  const result = selected?.result

  useEffect(() => {
    setConfirmed(selected?.result?.confirmedTaskIds ?? [])
  }, [analysisId, selected?.result?.confirmedTaskIds])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (typeof planVersion !== 'number' || !scanId) return
    setBusy(true)
    setError('')
    try {
      const analysis = await api.startChangeAnalysis(project.id, { description, scanId, planVersion })
      setAnalyses((current) => [analysis, ...current.filter((item) => item.id !== analysis.id)])
      setAnalysisDetail(analysis)
      setAnalysisId(analysis.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法提交变更分析。')
    } finally {
      setBusy(false)
    }
  }

  async function saveConfirmation() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const updated = await api.confirmChangeAnalysis(project.id, selected.id, confirmed)
      setAnalysisDetail(updated)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存影响确认失败。')
    } finally {
      setBusy(false)
    }
  }

  async function extractCandidates() {
    if (!selected) return
    setAiBusy(true)
    setAiError('')
    try {
      const updated = await api.extractAiCandidates(project.id, selected.id)
      setAnalysisDetail(updated)
    } catch (failure) {
      setAiError(failure instanceof Error ? failure.message : 'AI 候选提取失败。')
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>变更影响分析</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="change-description">变更描述</label>
          <textarea id="change-description" rows={4} maxLength={10_000} required value={description}
            onChange={(event) => setDescription(event.target.value)} />
          <label htmlFor="change-plan">计划版本</label>
          <select id="change-plan" value={planVersion} required onChange={(event) => setPlanVersion(Number(event.target.value))}>
            {plans.map((plan) => <option key={plan.version} value={plan.version}>v{plan.version}</option>)}
          </select>
          <label htmlFor="change-scan">仓库扫描</label>
          <select id="change-scan" value={scanId} required onChange={(event) => setScanId(event.target.value)}>
            {scans.map((scan) => <option key={scan.id} value={scan.id}>{scan.ref} · {scan.summary?.commit.slice(0, 12)}</option>)}
          </select>
          <button className="primary" disabled={busy || !plans.length || !scans.length}>
            {busy ? '处理中…' : '分析影响'}
          </button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="card">
        <h2>分析记录</h2>
        {listError && <p className="error" role="status">{listError}</p>}
        {!analyses.length ? <p className="muted">暂无分析记录</p> : (
          <div className="scan-table">
            <table>
              <thead><tr><th>状态</th><th>变更描述</th><th>创建时间</th><th></th></tr></thead>
              <tbody>
                {analyses.map((analysis) => (
                  <tr key={analysis.id}>
                    <td><span className={`status ${analysis.status}`}>{analysisStatus[analysis.status]}</span></td>
                    <td>{analysis.description}</td>
                    <td><time dateTime={analysis.createdAt}>{new Date(analysis.createdAt).toLocaleString('zh-CN')}</time></td>
                    <td><button className="secondary" onClick={() => setAnalysisId(analysis.id)}>查看</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedSummary?.error && <p className="error" role="alert">{selectedSummary.error}</p>}
        {detailError && <p className="error" role="alert">{detailError}</p>}
        {!selected && !detailError && selectedSummary?.status === 'succeeded' && (
          <p className="muted" role="status">正在读取分析结果…</p>
        )}
      </section>

      {result && (
        <section className="card">
          <h2>影响候选</h2>
          {result.coverageLimited && <p className="error" role="status">扫描覆盖存在限制：{result.coverageWarnings.join('；')}</p>}
          <p>匹配需求：{result.matchedRequirementIds.join('、') || '无'}</p>
          {!result.affectedTasks.length ? <p className="muted">没有识别到现有任务依赖</p> : (
            <div className="scan-table">
              <table>
                <thead><tr><th>确认</th><th>任务</th><th>程序分类</th><th>AI 判断</th><th>AI 理由</th><th>影响路径</th><th>证据</th></tr></thead>
                <tbody>
                  {result.affectedTasks.map((task) => {
                    const review = result.aiCandidates.find((candidate) => candidate.taskId === task.taskId)
                    return (
                      <tr key={task.taskId}>
                        <td><input className="change-confirm" aria-label={`确认任务 ${task.taskId}`} type="checkbox"
                          checked={confirmed.includes(task.taskId)}
                          onChange={(event) => setConfirmed((items) => event.target.checked
                            ? [...items, task.taskId] : items.filter((id) => id !== task.taskId))} /></td>
                        <td><code>{task.taskId}</code> {task.title}</td>
                        <td>{classificationLabels[task.classification]}</td>
                        <td>{review?.verdict ? verdictLabels[review.verdict] : '尚未复核'}</td>
                        <td>{review?.rationale ?? '—'}</td>
                        <td><code>{task.path.join(' → ')}</code></td>
                        <td>{task.evidenceIds.join('、')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="scan-pagination">
            <button className="primary" disabled={busy} onClick={() => void saveConfirmation()}>保存确认</button>
            <button className="secondary" disabled={aiBusy} onClick={() => void extractCandidates()}>
              {aiBusy ? '复核中…' : 'AI 影响复核'}
            </button>
          </div>
          {aiError && <p className="error" role="alert">{aiError}</p>}
          {result.aiWarnings?.map((warning, index) => <p className="error" role="status" key={`${index}-${warning}`}>{warning}</p>)}
          {!!result.upstreamTasks?.length && (
            <>
              <h3>前置任务复核</h3>
              <div className="scan-table">
                <table>
                  <thead><tr><th>确认</th><th>前置任务</th><th>AI 判断</th><th>AI 理由</th><th>到受影响任务的路径</th><th>证据</th></tr></thead>
                  <tbody>
                    {result.upstreamTasks.map((task) => {
                      const review = result.aiUpstreamImpacts?.find((item) => item.taskId === task.taskId)
                      return (
                        <tr key={task.taskId}>
                          <td><input className="change-confirm" aria-label={`确认前置任务 ${task.taskId}`} type="checkbox"
                            checked={confirmed.includes(task.taskId)}
                            onChange={(event) => setConfirmed((items) => event.target.checked
                              ? [...items, task.taskId] : items.filter((id) => id !== task.taskId))} /></td>
                          <td><code>{task.taskId}</code> {task.title}</td>
                          <td>{review ? verdictLabels[review.verdict] : '尚未复核'}</td>
                          <td>{review?.rationale ?? '—'}</td>
                          <td><code>{task.path.join(' → ')}</code></td>
                          <td>{task.evidenceIds.join('、')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result.newRequirements?.length ? (
            <>
              <h3>独立新需求路径</h3>
              <div className="scan-table">
                <table>
                  <thead><tr><th>编号</th><th>需求</th><th>说明</th><th>独立性依据</th><th>处理</th></tr></thead>
                  <tbody>
                    {result.newRequirements.map((requirement) => (
                      <tr key={requirement.id}>
                        <td><code>{requirement.id}</code></td>
                        <td>{requirement.title}</td>
                        <td>{requirement.description}</td>
                        <td>{requirement.rationale}</td>
                        <td>需人工确认并设计架构；未写入计划</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <h3>代码影响路径</h3>
          {!result.affectedFiles.length ? <p className="muted">没有匹配到扫描文件</p> : (
            <div className="scan-table">
              <table>
                <thead><tr><th>分类</th><th>文件</th><th>路径</th><th>证据</th></tr></thead>
                <tbody>
                  {result.affectedFiles.map((file) => (
                    <tr key={file.file}>
                      <td>{file.classification === 'mapped' ? '任务/描述映射模块' : '反向依赖影响'}</td>
                      <td><code>{file.file}</code></td>
                      <td><code>{file.path.join(' → ')}</code></td>
                      <td>{file.evidenceIds.join('、')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>分析证据</h3>
          <ul className="item-list">
            {result.evidence.map((item) => (
              <li key={item.id} className="job-item">
                <strong><code>{item.id}</code> · {item.description}</strong>
                {item.path.length > 0 && <p><code>{item.path.join(' → ')}</code></p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
