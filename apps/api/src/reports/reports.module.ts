import {
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common'
import type { ArchitectureComparison, ChangeReport } from '@archguard/contracts'
import { ActorResolver } from '../changes/actor'
import { ChangesModule } from '../changes/changes.module'
import { fail, toHttpException } from '../changes/errors'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'

@Controller('projects/:projectId/change-requests')
export class ReportsController {
  constructor(
    @Inject(SqliteStore) private readonly store: SqliteStore,
    @Inject(ActorResolver) private readonly actors: ActorResolver,
  ) {}

  @Get(':changeId/report')
  report(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Query('submissionId') submissionId: string | undefined,
    @Query('implementationCheckId') implementationCheckId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): ChangeReport {
    try {
      this.store.authorizeMember(this.actors.resolve(authorization), projectId)
      return this.build(projectId, changeId, submissionId, implementationCheckId)
    } catch (error) {
      throw toHttpException(error)
    }
  }

  private build(projectId: string, changeId: string, submissionId?: string, implementationCheckId?: string): ChangeReport {
    const project = this.store.getProject(projectId)
    if (!project) fail('NOT_FOUND', 404, '找不到该项目。')
    const liveChangeRequest = this.store.getChangeRequest(projectId, changeId)
    if (!liveChangeRequest) fail('NOT_FOUND', 404, '找不到该变更申请。')

    let check = implementationCheckId
      ? this.store.getImplementationCheck(projectId, changeId, implementationCheckId)
      : undefined
    if (implementationCheckId && !check) fail('NOT_FOUND', 404, '找不到该实施检查。')
    const submission = (submissionId
      ? this.store.getSubmission(projectId, changeId, submissionId)
      : check
        ? this.store.getSubmission(projectId, changeId, check.submissionId)
        : this.store.getLatestSubmission(projectId, changeId)) ?? null
    if (submissionId && !submission) fail('NOT_FOUND', 404, '找不到该提交。')
    if (submission && check && check.submissionId !== submission.id) {
      fail('VALIDATION_ERROR', 400, '该实施检查不属于指定的提交。')
    }
    if (submission && !check) {
      check = this.store.getImplementationCheckBySubmission(projectId, changeId, submission.id)
    }

    const changeRequest = submission?.snapshot.request ?? liveChangeRequest
    const frozenBaseline = submission?.snapshot.baseline ?? null
    const baselineScan = frozenBaseline
      ? this.store.getScan(projectId, frozenBaseline.scanId) ?? null
      : this.store.getScan(projectId, liveChangeRequest.baseScanId) ?? null
    const selectedScheme = submission
      ? submission.snapshot.scenarioRevision.scenarios[submission.selectedKind]
      : null
    const decision = submission
      ? this.store.getDecisionBySubmission(projectId, changeId, submission.id) ?? null
      : null
    const publishedVersion = decision?.publishedPlanVersion ?? null
    const deferredItem = decision?.deferredItemId
      ? this.store.getDeferredItem(projectId, changeId, decision.deferredItemId) ?? null
      : null

    let comparison: ArchitectureComparison | null = null
    let comparable = false
    let reason: string | null = null
    if (check?.postScanId && submission) {
      const postScan = this.store.getScan(projectId, check.postScanId)
      if (postScan) {
        const result = this.store.compareSubmissionRescan(projectId, submission, postScan)
        comparison = result.comparison
        comparable = result.comparable
        reason = result.reason
      }
    }

    const limitations: string[] = []
    if (!submission) limitations.push('尚未提交，缺少冻结的业务快照。')
    if (!decision) limitations.push('尚未审批，缺少审批记录。')
    if (!check) {
      limitations.push('尚未记录实施证据，无法核对复扫与验收。')
    } else if (!check.postScanId || !check.requirementAcceptance) {
      limitations.push('实施证据不完整，缺少复扫或需求验收结论。')
    }
    if (!comparable && check?.postScanId && reason) limitations.push(`复扫比较受限：${reason}`)
    if (submission && !submission.snapshot.baseline?.repositoryUrl) limitations.push('提交冻结的仓库来源无法确认，复扫结论按不可比处理。')
    if (comparison?.coverageLimited) limitations.push('扫描覆盖存在限制，结论需人工复核。')
    if (selectedScheme?.futureEstimate && !deferredItem?.scheduledAt) limitations.push('延期事项尚未正式排期。')

    return {
      project: { id: project.id, name: project.name, repositoryUrl: project.repositoryUrl },
      changeRequest,
      submission,
      baseline: {
        planVersion: frozenBaseline?.planVersion ?? changeRequest.basePlanVersion,
        plan: frozenBaseline?.plan ?? this.store.getPlan(projectId, changeRequest.basePlanVersion) ?? null,
        scanId: frozenBaseline?.scanId ?? changeRequest.baseScanId,
        scanCommit: frozenBaseline?.scanCommit ?? baselineScan?.result?.commit ?? null,
        analyzerVersion: frozenBaseline?.analyzerVersion ?? baselineScan?.result?.analyzerVersion ?? null,
        ruleVersion: frozenBaseline?.ruleVersion ?? baselineScan?.result?.architecture?.ruleVersion ?? null,
        rules: frozenBaseline?.rules ?? baselineScan?.result?.architecture?.rules ?? null,
      },
      analysis: submission?.snapshot.analysis ?? null,
      scenarioRevision: submission?.snapshot.scenarioRevision ?? null,
      estimation: selectedScheme ? {
        source: selectedScheme.estimationInput.source,
        ruleVersion: selectedScheme.estimationInput.ruleVersion,
        basis: selectedScheme.estimationInput.basis,
      } : null,
      decision,
      published: {
        planVersion: publishedVersion,
        parentVersion: publishedVersion === null
          ? null
          : this.store.getPlanLineageParent(projectId, publishedVersion),
        deferredItem,
      },
      implementation: check ?? null,
      rescan: { comparison, comparable, reason },
      limitations,
    }
  }
}

@Module({
  imports: [StorageModule, ChangesModule],
  controllers: [ReportsController],
})
export class ReportsModule {}
