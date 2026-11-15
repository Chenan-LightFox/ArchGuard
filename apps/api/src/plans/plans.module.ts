import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Module, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common'
import type { PlanDraft, PlanVersion, PlanVersionSummary } from '@archguard/contracts'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'
import { buildPlan } from './build-plan'

@Controller('projects/:projectId/plan-versions')
class PlansController {
  constructor(@Inject(SqliteStore) private readonly store: SqliteStore) {}

  private requireProject(id: string) {
    if (!this.store.hasProject(id)) throw new NotFoundException('找不到该项目。')
  }

  private parse(body: unknown): PlanDraft {
    const input = body as { requirementsMarkdown?: unknown; tasksCsv?: unknown } | null
    if (typeof input?.requirementsMarkdown !== 'string' || typeof input.tasksCsv !== 'string' ||
        input.requirementsMarkdown.length > 100_000 || input.tasksCsv.length > 250_000) {
      throw new BadRequestException('请提供需求 Markdown 和任务 CSV，长度上限分别为 100,000 和 250,000 字符。')
    }
    try {
      return buildPlan(input.requirementsMarkdown, input.tasksCsv)
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown): PlanDraft {
    this.requireProject(projectId)
    return this.parse(body)
  }

  @Post()
  create(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown): PlanVersion {
    this.requireProject(projectId)
    return this.store.createPlan(projectId, this.parse(body))
  }

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string): PlanVersionSummary[] {
    this.requireProject(projectId)
    return this.store.listPlans(projectId)
  }

  @Get(':version')
  detail(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('version', ParseIntPipe) version: number,
  ): PlanVersion {
    const plan = this.store.getPlan(projectId, version)
    if (!plan) throw new NotFoundException('找不到该计划版本。')
    return plan
  }
}

@Module({ imports: [StorageModule], controllers: [PlansController] })
export class PlansModule {}
