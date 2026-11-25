import { BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, Put } from '@nestjs/common'
import type { LlmSettingsStatus } from '@archguard/contracts'

interface LlmConnection {
  apiKey: string
  baseUrl: string
  model: string
}

export interface LlmRequest {
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[]
  signal?: AbortSignal
}

export interface LlmProvider {
  complete(connection: Readonly<LlmConnection>, request: LlmRequest): Promise<string>
}

@Injectable()
export class OpenAiCompatibleProvider implements LlmProvider {
  async complete(connection: Readonly<LlmConnection>, request: LlmRequest): Promise<string> {
    const baseUrl = connection.baseUrl ||'https://open.bigmodel.cn/api/paas/v4' //'https://api.openai.com/v1'
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: connection.model || 'glm-4-flash',//'gpt-4o-mini',
          messages: request.messages,
          temperature: 0.01,
        }),
        signal: request.signal ?? AbortSignal.timeout(20_000),
      })
    } catch (error) {
      if (request.signal?.aborted) throw error
      throw new Error('无法连接配置的 LLM 服务。')
    }
    if (!response.ok) throw new Error(`LLM 服务返回 HTTP ${response.status}。`)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('LLM 服务返回了无效 JSON。')
    }
    if (typeof payload !== 'object' || payload === null || !('choices' in payload) ||
        !Array.isArray(payload.choices)) {
      throw new Error('LLM 服务响应缺少候选内容。')
    }
    const first = payload.choices[0]
    if (typeof first !== 'object' || first === null || !('message' in first) ||
        typeof first.message !== 'object' || first.message === null || !('content' in first.message) ||
        typeof first.message.content !== 'string') {
      throw new Error('LLM 服务返回的候选内容格式无效。')
    }
    return first.message.content
  }
}

@Injectable()
export class LlmGateway {
  private connection?: LlmConnection

  status(): LlmSettingsStatus {
    return {
      configured: Boolean(this.connection),
      baseUrl: this.connection?.baseUrl ?? '',
      model: this.connection?.model ?? '',
    }
  }

  configure(body: unknown): LlmSettingsStatus {
    const input = body as Partial<Record<keyof LlmConnection, unknown>> | null
    const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
    const model = typeof input?.model === 'string' ? input.model.trim() : ''
    if (!apiKey || apiKey.length > 2048 || /[\s\u0000-\u001f]/u.test(apiKey) || model.length > 160 || baseUrl.length > 2048) {
      throw new BadRequestException('请输入有效的 API Key，并检查模型名称和地址长度。')
    }
    const url = baseUrl ? URL.parse(baseUrl) : null
    if (baseUrl && (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)) {
      throw new BadRequestException('API 地址须为 HTTPS，且不能包含凭据、查询或片段。')
    }
    this.connection = { apiKey, baseUrl: url?.href ?? '', model }
    return this.status()
  }

  clear(): LlmSettingsStatus {
    this.connection = undefined
    return this.status()
  }

  async complete(provider: LlmProvider, request: LlmRequest): Promise<string> {
    if (!this.connection) throw new Error('请先配置 LLM API Key。')
    return provider.complete({ ...this.connection }, request)
  }
}

@Controller('llm/settings')
class LlmSettingsController {
  constructor(@Inject(LlmGateway) private readonly gateway: LlmGateway) {}

  @Get()
  status() { return this.gateway.status() }

  @Put()
  configure(@Body() body: unknown) { return this.gateway.configure(body) }

  @Delete()
  clear() { return this.gateway.clear() }
}

@Module({ providers: [LlmGateway], controllers: [LlmSettingsController], exports: [LlmGateway] })
export class LlmModule {}
