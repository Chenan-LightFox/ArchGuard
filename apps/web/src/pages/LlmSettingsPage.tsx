import { useEffect, useState, type FormEvent } from 'react'
import type { LlmSettingsStatus } from '@archguard/contracts'
import { api } from '../api'

export function LlmSettingsPage() {
  const [status, setStatus] = useState<LlmSettingsStatus>()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function apply(value: LlmSettingsStatus) {
    setStatus(value)
    setBaseUrl(value.baseUrl)
    setModel(value.model)
    setApiKey('')
  }

  useEffect(() => {
    const controller = new AbortController()
    api.llmStatus(controller.signal).then((value) => {
      if (!controller.signal.aborted) apply(value)
    }).catch(() => {
      if (!controller.signal.aborted) setError('无法读取 LLM 配置状态。')
    })
    return () => controller.abort()
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      apply(await api.configureLlm({ apiKey, baseUrl, model }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存 LLM 配置失败。')
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    setError('')
    try {
      apply(await api.clearLlm())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '清除 LLM 配置失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>模型连接配置</h2>
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy || (!status && !error)}>
          <label htmlFor="llm-key">LLM API Key</label>
          <input id="llm-key" type="password" autoComplete="off" required maxLength={2048} value={apiKey}
            onChange={(event) => setApiKey(event.target.value)} />
          <label htmlFor="llm-url">API 基础地址（可选）</label>
          <input id="llm-url" type="url" value={baseUrl} maxLength={2048} onChange={(event) => setBaseUrl(event.target.value)} />
          <label htmlFor="llm-model">模型名称（可选）</label>
          <input id="llm-model" value={model} maxLength={160} onChange={(event) => setModel(event.target.value)} />
          <div className="scan-pagination">
            <button className="primary">保存配置</button>
            {status?.configured && <button className="secondary" type="button" onClick={() => void clear()}>清除配置</button>}
          </div>
        </fieldset>
        {status && <p role="status">{status.configured ? 'API Key 已配置' : '尚未配置 API Key'}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  )
}
