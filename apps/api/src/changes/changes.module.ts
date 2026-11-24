import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common'
import type {
  AnalysisRevision,
  ChangeRequest,
  ChangeSubmission,
  CreateChangeRequestInput,
  DecideInput,
  ApprovalResult,
  ApprovalDecision,
  ScenarioRevision,
  ScenarioInputSet,
  UpdateChangeRequestInput,
} from '@archguard/contracts'
import type { AnalysisAdapter, AnalysisContext, ScenarioAdapter } from './adapters'
import { ANALYSIS_ADAPTER, NotConnectedAnalysisAdapter, NotConnectedScenarioAdapter, SCENARIO_ADAPTER } from './adapters'
import { ActorResolver } from './actor'
import { createFixtureAdapters } from './fixture-adapters'
import { fail, toHttpException } from './errors'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'
import { ChangeAnalysesController } from './change-analyses.controller'
import { LlmModule, OpenAiCompatibleProvider } from '../llm/llm.module'

export { parseAiReview } from './change-analyses.controller'


function parseCreate(body: unknown): CreateChangeRequestInput {
  const input = body as Partial<CreateChangeRequestInput> | null
  if (typeof input?.title !== 'string' || typeof input.description !== 'string') {
    fail('VALIDATION_ERROR', 400, '请提供变更标题和描述。')
  }
  if (typeof input.basePlanVersion !== 'number' || typeof input.baseScanId !== 'string') {
    fail('VALIDATION_ERROR', 400, '请提供基线计划版本和基线扫描 ID。')
  }
  return {
    title: input.title,
    description: input.description,
    basePlanVersion: input.basePlanVersion,
    baseScanId: input.baseScanId,
  }
}

function parseUpdate(body: unknown): UpdateChangeRequestInput {
  const input = body as Partial<UpdateChangeRequestInput> | null
  if (input?.expectedRevision !== undefined && !Number.isInteger(input.expectedRevision)) {
    fail('VALIDATION_ERROR', 400, 'expectedRevision 必须为整数。')
  }
  return {
    title: input?.title,
    description: input?.description,
    basePlanVersion: input?.basePlanVersion,
    baseScanId: input?.baseScanId,
    expectedRevision: input?.expectedRevision as number,
  }
}

function parseDecide(body: unknown): DecideInput {
  const input = body as Partial<DecideInput> | null
  if (typeof input?.idempotencyKey !== 'string') fail('VALIDATION_ERROR', 400, '请提供 idempotencyKey。')
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    fail('VALIDATION_ERROR', 400, 'decision 必须为 approved 或 rejected。')
  }
  if (typeof input.submissionId !== 'string' || !input.submissionId.trim()) {
    fail('VALIDATION_ERROR', 400, '请提供 submissionId。')
  }
  if (typeof input.expectedSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash)) {
    fail('VALIDATION_ERROR', 400, '请提供 64 位十六进制 expectedSnapshotHash。')
  }
  return {
    decision: input.decision,
    comment: typeof input.comment === 'string' ? input.comment : undefined,
    idempotencyKey: input.idempotencyKey,
    submissionId: input.submissionId,
    expectedSnapshotHash: input.expectedSnapshotHash,
  }
}

const scenarioKinds = ['accept', 'reduce', 'defer'] as const
const scenarioInputKeys = ['kind', 'includedScope', 'excludedScope', 'acceptanceCriteria', 'taskDiffs', 'estimationInput']

function parseScenarioInputSet(body: unknown): ScenarioInputSet {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('VALIDATION_ERROR', 400, '请提供 accept、reduce、defer 三个方案的输入。')
  }
  const input = body as Record<string, unknown>
  const forbidden = Object.keys(input).filter((key) => !scenarioKinds.includes(key as (typeof scenarioKinds)[number]))
  if (forbidden.length) fail('VALIDATION_ERROR', 400, `不接受直接提交这些字段：${forbidden.join('、')}。metrics 和 candidatePlan 由服务端计算。`)
  const result = {} as Record<(typeof scenarioKinds)[number], unknown>
  for (const kind of scenarioKinds) {
    const scheme = input[kind]
    if (typeof scheme !== 'object' || scheme === null || Array.isArray(scheme)) {
      fail('VALIDATION_ERROR', 400, `${kind} 方案输入无效。`)
    }
    const keys = Object.keys(scheme)
    const extra = keys.filter((key) => !scenarioInputKeys.includes(key))
    if (extra.length) fail('VALIDATION_ERROR', 400, `${kind} 方案不接受字段：${extra.join('、')}。`)
    const typed = scheme as Record<string, unknown>
    if (typed.kind !== kind) fail('VALIDATION_ERROR', 400, `${kind} 方案的 kind 字段必须为 ${kind}。`)
    result[kind] = typed
  }
  return result as unknown as ScenarioInputSet
}

@Controller('projects/:projectId/change-requests')
export class ChangesController {
  constructor(
    @Inject(SqliteStore) private readonly store: SqliteStore,
    @Inject(ActorResolver) private readonly actors: ActorResolver,
    @Inject(ANALYSIS_ADAPTER) private readonly analysisAdapter: AnalysisAdapter,
    @Inject(SCENARIO_ADAPTER) private readonly scenarioAdapter: ScenarioAdapter,
  ) {}

  private run<T>(callback: () => T): T {
    try {
      return callback()
    } catch (error) {
      throw toHttpException(error)
    }
  }

  private analysisContext(projectId: string, changeRequest: ChangeRequest, actorHeader: string | undefined): AnalysisContext {
    const member = this.store.authorizeMember(this.actors.resolve(actorHeader), projectId)
    return {
      projectId,
      changeRequest,
      baselinePlan: this.store.getPlan(projectId, changeRequest.basePlanVersion) ?? undefined,
      baselineScan: this.store.getScan(projectId, changeRequest.baseScanId),
      actor: member,
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ChangeRequest {
    return this.run(() => this.store.createChangeRequest(projectId, this.actors.resolve(authorization), parseCreate(body)))
  }

  @Get()
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ChangeRequest[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listChangeRequests(projectId)
    })
  }

  @Get(':changeId')
  detail(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ChangeRequest {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      const row = this.store.getChangeRequest(projectId, changeId)
      if (!row) fail('NOT_FOUND', 404, '找不到该变更申请。')
      return row
    })
  }

  @Patch(':changeId')
  update(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ChangeRequest {
    return this.run(() => this.store.updateChangeRequest(projectId, changeId, this.actors.resolve(authorization), parseUpdate(body)))
  }

  @Post(':changeId/analyses')
  @HttpCode(HttpStatus.CREATED)
  addAnalysis(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): AnalysisRevision {
    return this.run(() => {
      const changeRequest = this.store.getChangeRequest(projectId, changeId)
      if (!changeRequest) fail('NOT_FOUND', 404, '找不到该变更申请。')
      const context = this.analysisContext(projectId, changeRequest, authorization)
      const draft = this.analysisAdapter.analyze(context, body)
      return this.store.saveAnalysisRevision(projectId, changeId, context.actor, draft)
    })
  }

  @Get(':changeId/analyses')
  listAnalyses(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): AnalysisRevision[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listAnalysisRevisions(projectId, changeId)
    })
  }

  @Post(':changeId/scenarios')
  @HttpCode(HttpStatus.CREATED)
  addScenarios(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ScenarioRevision {
    return this.run(() => {
      const changeRequest = this.store.getChangeRequest(projectId, changeId)
      if (!changeRequest) fail('NOT_FOUND', 404, '找不到该变更申请。')
      const context = this.analysisContext(projectId, changeRequest, authorization)
      const analysis = this.store.listAnalysisRevisions(projectId, changeId)[0]
      if (!analysis) fail('STATE_CONFLICT', 409, '请先创建分析版本。')
      const input = parseScenarioInputSet(body)
      const draft = this.scenarioAdapter.compute({ ...context, analysis, existingScenarios: this.store.listScenarioRevisions(projectId, changeId) }, input)
      return this.store.saveScenarioRevision(projectId, changeId, context.actor, draft)
    })
  }

  @Get(':changeId/scenarios')
  listScenarios(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ScenarioRevision[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listScenarioRevisions(projectId, changeId)
    })
  }

  @Post(':changeId/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ChangeSubmission {
    return this.run(() => {
      const input = body as { selectedKind?: unknown } | null
      if (!input || (input.selectedKind !== 'accept' && input.selectedKind !== 'reduce' && input.selectedKind !== 'defer')) {
        fail('VALIDATION_ERROR', 400, '请选择 accept、reduce 或 defer 方案。')
      }
      return this.store.submitChangeRequest(projectId, changeId, this.actors.resolve(authorization), input.selectedKind)
    })
  }

  @Get(':changeId/submissions')
  listSubmissions(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ChangeSubmission[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listSubmissions(projectId, changeId)
    })
  }

  @Post(':changeId/decisions')
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ApprovalResult {
    return this.run(() => this.store.decideChangeRequest(projectId, changeId, this.actors.resolve(authorization), parseDecide(body)))
  }

  @Get(':changeId/decisions')
  listDecisions(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ApprovalDecision[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listDecisions(projectId, changeId)
    })
  }
}

@Module({
  imports: [StorageModule, LlmModule],
  controllers: [ChangesController, ChangeAnalysesController],
  providers: [
    ActorResolver,
    OpenAiCompatibleProvider,
    {
      provide: ANALYSIS_ADAPTER,
      useFactory: () => process.env.ARCHGUARD_ENABLE_DEMO_FIXTURES === '1'
        ? createFixtureAdapters().analysis
        : new NotConnectedAnalysisAdapter(),
    },
    {
      provide: SCENARIO_ADAPTER,
      useFactory: () => process.env.ARCHGUARD_ENABLE_DEMO_FIXTURES === '1'
        ? createFixtureAdapters().scenario
        : new NotConnectedScenarioAdapter(),
    },
  ],
  exports: [ActorResolver],
})
export class ChangesModule {}
