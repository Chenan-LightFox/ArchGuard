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
  Post,
} from '@nestjs/common'
import type { ImplementationCheck, ImplementationCheckInput } from '@archguard/contracts'
import { ChangesModule } from '../changes/changes.module'
import { ActorResolver } from '../changes/actor'
import { fail, toHttpException } from '../changes/errors'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'

function parseInput(body: unknown): ImplementationCheckInput {
  const input = body as Partial<ImplementationCheckInput> | null
  if (typeof input?.submissionId !== 'string') fail('VALIDATION_ERROR', 400, '请提供 submissionId。')
  if (input.status !== 'not_started' && input.status !== 'in_progress' &&
      input.status !== 'waiting_scheduling' && input.status !== 'completed') {
    fail('VALIDATION_ERROR', 400, '实施状态无效。')
  }
  const evidence = input.evidence
  if (evidence !== undefined) {
    if (typeof evidence?.command !== 'string' || typeof evidence.passed !== 'boolean' ||
        typeof evidence.outputSummary !== 'string') {
      fail('VALIDATION_ERROR', 400, '测试证据需要 command、passed 和 outputSummary。')
    }
  }
  const requirementAcceptance = input.requirementAcceptance
  if (requirementAcceptance !== undefined && requirementAcceptance !== null) {
    if (typeof requirementAcceptance?.verdict !== 'string' || typeof requirementAcceptance.summary !== 'string') {
      fail('VALIDATION_ERROR', 400, '需求验收需要 verdict 和 summary。')
    }
  }
  const coverageReview = input.coverageReview
  if (coverageReview !== undefined && coverageReview !== null && typeof coverageReview?.accepted !== 'boolean') {
    fail('VALIDATION_ERROR', 400, '覆盖复核需要 accepted 布尔值。')
  }
  return {
    submissionId: input.submissionId,
    status: input.status,
    implementationCommit: input.implementationCommit,
    postScanId: input.postScanId,
    requirementAcceptance: input.requirementAcceptance,
    coverageReview: input.coverageReview,
    evidence,
  }
}

@Controller('projects/:projectId/change-requests')
export class ImplementationController {
  constructor(
    @Inject(SqliteStore) private readonly store: SqliteStore,
    @Inject(ActorResolver) private readonly actors: ActorResolver,
  ) {}

  private run<T>(callback: () => T): T {
    try {
      return callback()
    } catch (error) {
      throw toHttpException(error)
    }
  }

  @Post(':changeId/implementation-checks')
  @HttpCode(HttpStatus.OK)
  record(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): ImplementationCheck {
    return this.run(() => this.store.saveImplementationCheck(projectId, changeId, this.actors.resolve(authorization), parseInput(body)))
  }

  @Get(':changeId/implementation-checks')
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Headers('authorization') authorization: string | undefined,
  ): ImplementationCheck[] {
    return this.run(() => {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.store.listImplementationChecks(projectId, changeId)
    })
  }
}

@Module({
  imports: [StorageModule, ChangesModule],
  controllers: [ImplementationController],
})
export class ImplementationModule {}
