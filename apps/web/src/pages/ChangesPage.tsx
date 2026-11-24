import { useEffect, useState, type FormEvent } from 'react'
import type { PlanScenarioComparison, PlanVersionSummary, Project } from '@archguard/contracts'
import { api } from '../api'

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 })

export function ChangesPage({ project }: { project: Project }) {
  const [versions, setVersions] = useState<PlanVersionSummary[]>([])
  const [baseVersion, setBaseVersion] = useState<number>(0)
  const [acceptTasksCsv, setAcceptTasksCsv] = useState('')
  const [reduceTasksCsv, setReduceTasksCsv] = useState('')
  const [deferTasksCsv, setDeferTasksCsv] = useState('')
  const [comparison, setComparison] = useState<PlanScenarioComparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    api.listPlans(project.id, controller.signal).then((items) => {
      if (controller.signal.aborted) return
      setVersions(items)
      setBaseVersion((current) => current || items[0]?.version || 0)
    }).catch(() => {
      if (!controller.signal.aborted) setError('无法读取计划版本。')
    })
    return () => controller.abort()
  }, [project.id])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!baseVersion) return
    setBusy(true)
    setError('')
    try {
      setComparison(await api.previewScenarios(project.id, baseVersion, {
        basePlanVersion: baseVersion,
        acceptTasksCsv,
        reduceTasksCsv,
        deferTasksCsv,
      }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '方案计算失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy}>
            <label htmlFor="base-plan">计划版本</label>
            <select id="base-plan" value={baseVersion} onChange={(event) => setBaseVersion(Number(event.target.value))}>
              {versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
            </select>
            <label htmlFor="accept-csv">接受变更任务 CSV</label>
            <textarea id="accept-csv" rows={5} value={acceptTasksCsv} onChange={(event) => setAcceptTasksCsv(event.target.value)} required />
            <label htmlFor="reduce-csv">缩小范围任务 CSV</label>
            <textarea id="reduce-csv" rows={5} value={reduceTasksCsv} onChange={(event) => setReduceTasksCsv(event.target.value)} required />
            <label htmlFor="defer-csv">延期未来任务 CSV</label>
            <textarea id="defer-csv" rows={5} value={deferTasksCsv} onChange={(event) => setDeferTasksCsv(event.target.value)} />
            <button className="primary">计算方案</button>
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </section>

      {comparison && (
        <section className="card">
          <div className="scan-table">
            <table>
              <thead>
                <tr><th>方案</th><th>工时变化</th><th>成本变化</th><th>交付变化</th><th>工期</th></tr>
              </thead>
              <tbody>
                {comparison.scenarios.map((scenario) => (
                  <tr key={scenario.kind}>
                    <td>{scenario.title}</td>
                    <td>{number.format(scenario.delta.effortHours)} 人时</td>
                    <td>{number.format(scenario.delta.cost)} 元</td>
                    <td>{number.format(scenario.delta.durationDays)} 工作日</td>
                    <td>{scenario.futurePlan ? number.format(scenario.futurePlan.metrics.durationDays) : (scenario.kind === 'defer' ? '—' : number.format(scenario.plan.metrics.durationDays))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
