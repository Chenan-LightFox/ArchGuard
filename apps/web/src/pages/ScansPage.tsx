import { useEffect, useState } from 'react'
import type { Project, ScanPreflight } from '@archguard/contracts'
import { api } from '../api'

const labels: Record<ScanPreflight['status'], string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '检查通过',
  failed: '检查失败',
}

const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })

export function ScansPage({ project }: { project: Project }) {
  const [jobs, setJobs] = useState<ScanPreflight[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pollError, setPollError] = useState('')
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    async function refresh() {
      try {
        const result = await api.listPreflights(project.id, controller.signal)
        if (controller.signal.aborted) return
        setJobs(result)
        setPollError('')
      } catch {
        if (!controller.signal.aborted) setPollError('无法读取检查记录，正在重试。')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 1000)
      }
    }

    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [project.id])

  async function startCheck() {
    setSubmitting(true)
    setSubmitError('')
    try {
      const job = await api.startPreflight(project.id)
      setJobs((current) => {
        if (current?.some((item) => item.id === job.id)) return current
        return [job, ...(current ?? [])]
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '无法提交检查任务。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="stack">
      <section className="card scan-header">
        <div>
          <h2>扫描环境检查</h2>
          <p className="muted">验证后台进程能接收任务并获取 Git 和 TypeScript 版本。仓库源码扫描将在下一阶段接入。</p>
        </div>
        <button className="primary" onClick={() => void startCheck()} disabled={submitting || jobs === null || Boolean(pollError)}>
          {submitting ? '提交中…' : '运行检查'}
        </button>
        {submitError && <p className="error" role="alert">{submitError}</p>}
      </section>
      <section className="card">
        <h2>检查记录</h2>
        {pollError && <p className="error" role="status">{pollError}</p>}
        {jobs === null && !pollError && <p className="muted">正在读取记录…</p>}
        {jobs?.length === 0 && <p className="muted">还没有检查记录。</p>}
        <ul className="item-list" aria-label="环境检查任务">
          {jobs?.map((job) => (
            <li key={job.id} className="job-item">
              <div className="job-heading">
                <span className={`status ${job.status}`}>{labels[job.status]}</span>
                <time dateTime={job.createdAt}>{formatDate.format(new Date(job.createdAt))}</time>
              </div>
              {job.result && <p>{job.result.git} · TypeScript {job.result.typescript}</p>}
              {job.error && <p className="error">{job.error}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
