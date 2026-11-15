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
