import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common'
import type {
  AiChangeCandidate,
  AiImpactVerdict,
  AiNewRequirement,
  AiUpstreamImpact,
  ChangeAnalysis,
  ChangeAnalysisInput,
  ChangeAnalysisResult,
  ChangeAnalysisSummary,
} from '@archguard/contracts'
import { analyzeChange } from './analyze-change'
import { LlmGateway, OpenAiCompatibleProvider } from '../llm/llm.module'
import { SqliteStore } from '../storage/sqlite-store'

function parseInput(body: unknown): ChangeAnalysisInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('请输入变更描述、扫描 ID 和计划版本。')
  }
  const input = body as Record<string, unknown>
  if (typeof input.description !== 'string' || input.description.trim().length < 1 ||
      input.description.length > 10_000 || typeof input.scanId !== 'string' ||
      typeof input.planVersion !== 'number' || !Number.isSafeInteger(input.planVersion) || input.planVersion < 1) {
    throw new BadRequestException('变更描述须为 1 到 10,000 个字符，并指定有效扫描 ID 和计划版本。')
  }
  return { description: input.description.trim(), scanId: input.scanId, planVersion: input.planVersion }
}

function parseConfirmedTaskIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('请提交有效的 confirmedTaskIds 列表。')
  }
  const rawIds = (body as Record<string, unknown>).confirmedTaskIds
  if (!Array.isArray(rawIds) || rawIds.length > 1000) {
    throw new BadRequestException('请提交有效的 confirmedTaskIds 列表。')
  }
  const values: unknown[] = rawIds
  const ids: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 80) {
      throw new BadRequestException('确认任务编号格式无效。')
    }
    ids.push(value)
  }
  if (ids.length !== new Set(ids).size) throw new BadRequestException('确认任务列表不能包含重复编号。')
  return ids
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const source = (fence?.[1] ?? trimmed).trim()
  try {
    return JSON.parse(source)
  } catch {
    const start = source.indexOf('{')
    if (start < 0) throw new BadGatewayException('LLM 输出不是有效 JSON，未保存候选结果。')
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index++) {
      const character = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
      } else if (character === '"') inString = true
      else if (character === '{') depth++
      else if (character === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1))
          } catch {
            throw new BadGatewayException('LLM 输出不是有效 JSON，未保存候选结果。')
          }
        }
      }
    }
    throw new BadGatewayException('LLM 输出不是有效 JSON，未保存候选结果。')
  }
}

interface AiReviewOutput {
  candidates?: unknown[]
  upstreamTasks?: unknown[]
  newRequirements?: unknown[]
}

function isVerdict(value: unknown): value is AiImpactVerdict {
  return value === 'affected' || value === 'uncertain' || value === 'unaffected'
}

function readAiAssessments(
  input: unknown,
  allowedIds: Set<string>,
  label: string,
  warnings: string[],
): Map<string, { verdict: AiImpactVerdict; rationale: string }> {
  const assessments = new Map<string, { verdict: AiImpactVerdict; rationale: string }>()
  if (!Array.isArray(input)) {
    warnings.push(`AI 未返回有效的${label}列表。`)
    return assessments
  }
  const items: unknown[] = input
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('taskId' in item) ||
        typeof item.taskId !== 'string' || !('verdict' in item) || !isVerdict(item.verdict) ||
        !('rationale' in item) || typeof item.rationale !== 'string') {
      warnings.push(`忽略了一条格式无效的${label}判断。`)
      continue
    }
    if (!allowedIds.has(item.taskId)) {
      warnings.push(`忽略了不在本次${label}范围内的任务 ${item.taskId}。`)
      continue
    }
    if (assessments.has(item.taskId)) {
      warnings.push(`忽略了重复的${label}判断 ${item.taskId}。`)
      continue
    }
    const rationale = item.rationale.trim()
    if (!rationale || rationale.length > 500) {
      warnings.push(`忽略了任务 ${item.taskId} 的空解释或超长解释。`)
      continue
    }
    assessments.set(item.taskId, { verdict: item.verdict, rationale })
  }
  return assessments
}

export function parseAiReview(
  output: string,
  result: ChangeAnalysisResult,
  inventoryComplete: boolean,
): ChangeAnalysisResult {
  const payload = parseJsonOutput(output)
  if (typeof payload !== 'object' || payload === null || !('candidates' in payload) ||
      !Array.isArray(payload.candidates)) {
    throw new BadGatewayException('LLM 输出缺少有效的复核结果，未保存 AI 分析。')
  }
  const warnings: string[] = []
  const review = payload as AiReviewOutput
  const candidateIds = new Set(result.candidates.map(({ taskId }) => taskId))
  const upstreamTasks = result.upstreamTasks ?? []
  const upstreamIds = new Set(upstreamTasks.map(({ taskId }) => taskId))
  const candidateReviews = readAiAssessments(review.candidates, candidateIds, '程序候选', warnings)
  const upstreamReviews = readAiAssessments(review.upstreamTasks, upstreamIds, '前置任务', warnings)
  const candidates: AiChangeCandidate[] = result.candidates.map((candidate) => {
    const assessment = candidateReviews.get(candidate.taskId)
    if (!assessment) warnings.push(`AI 未明确判断 ${candidate.taskId}；该程序候选仍保留，请人工复核。`)
    return {
      ...candidate,
      verdict: assessment?.verdict ?? 'uncertain',
      rationale: assessment?.rationale ?? 'AI 未明确判断；程序识别的依赖仍保留，请人工复核。',
    }
  })
  const upstreamImpacts: AiUpstreamImpact[] = upstreamTasks.map((task) => {
    const assessment = upstreamReviews.get(task.taskId)
    if (!assessment) warnings.push(`AI 未明确判断前置任务 ${task.taskId}；该路径仍保留，请人工复核。`)
    return {
      ...task,
      verdict: assessment?.verdict ?? 'uncertain',
      rationale: assessment?.rationale ?? 'AI 未明确判断该前置任务；请人工核对其交付物和接口假设。',
    }
  })

  const newRequirements: AiNewRequirement[] = []
  if (review.newRequirements !== undefined && !Array.isArray(review.newRequirements)) {
    warnings.push('AI 返回的新需求列表格式无效，已忽略。')
  } else if (Array.isArray(review.newRequirements)) {
    const items: unknown[] = review.newRequirements
    if (!inventoryComplete && items.length) {
      warnings.push('项目映射资料不完整，无法确认新需求是否独立；AI 新路径建议未采纳。')
    } else {
      for (const item of items.slice(0, 10)) {
        if (typeof item !== 'object' || item === null || !('independent' in item) || item.independent !== true ||
            !('title' in item) || typeof item.title !== 'string' ||
            !('description' in item) || typeof item.description !== 'string' ||
            !('rationale' in item) || typeof item.rationale !== 'string') {
          warnings.push('忽略了一条未明确声明独立或字段不完整的新路径建议。')
          continue
        }
        const title = item.title.trim()
        const description = item.description.trim()
        const rationale = item.rationale.trim()
        if (!title || title.length > 160 || !description || description.length > 1000 ||
            !rationale || rationale.length > 500) {
          warnings.push('忽略了一条标题/描述为空或超长的新路径建议。')
          continue
        }
        const index = newRequirements.length
        newRequirements.push({
          id: `New${index}`,
          title,
          description,
          rationale,
          startingPoint: true,
          requiresArchitectureReview: true,
        })
      }
      if (items.length > 10) warnings.push('新路径建议超过 10 项，仅保留前 10 项。')
    }
  }
  return {
    ...result,
    aiCandidates: candidates,
    aiUpstreamImpacts: upstreamImpacts,
    newRequirements,
    aiWarnings: warnings,
  }
}

@Controller('projects/:projectId/change-analyses')
export class ChangeAnalysesController {
  constructor(
    @Inject(SqliteStore) private readonly store: SqliteStore,
    @Inject(LlmGateway) private readonly llm: LlmGateway,
    @Inject(OpenAiCompatibleProvider) private readonly provider: OpenAiCompatibleProvider,
  ) {}

  private requireProject(projectId: string): void {
    if (!this.store.hasProject(projectId)) throw new NotFoundException('找不到该项目。')
  }

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string): ChangeAnalysisSummary[] {
    this.requireProject(projectId)
    return this.store.listChangeAnalyses(projectId)
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  enqueue(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown): ChangeAnalysis {
    this.requireProject(projectId)
    const input = parseInput(body)
    const scan = this.store.getScan(projectId, input.scanId)
    if (!scan) throw new NotFoundException('找不到该项目的扫描记录。')
    if (scan.status !== 'succeeded' || !scan.result) throw new ConflictException('请选择已完成的仓库扫描。')
    if (!this.store.getPlan(projectId, input.planVersion)) throw new NotFoundException('找不到该计划版本。')
    return this.store.enqueueChangeAnalysis(projectId, input)
  }

  @Get(':analysisId')
  detail(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
  ): ChangeAnalysis {
    this.requireProject(projectId)
    const analysis = this.store.getChangeAnalysis(projectId, analysisId)
    if (!analysis) throw new NotFoundException('找不到该变更分析。')
    return analysis
  }

  @Post(':analysisId/confirm')
  confirm(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
    @Body() body: unknown,
  ): ChangeAnalysis {
    const analysis = this.detail(projectId, analysisId)
    if (!analysis.result) throw new ConflictException('分析尚未完成，无法确认影响任务。')
    const ids = parseConfirmedTaskIds(body)
    const allowedIds = new Set([
      ...analysis.result.candidates.map(({ taskId }) => taskId),
      ...(analysis.result.upstreamTasks ?? []).map(({ taskId }) => taskId),
    ])
    if (ids.some((id) => !allowedIds.has(id))) {
      throw new BadRequestException('确认列表包含本次影响路径中不存在的任务。')
    }
    const result = { ...analysis.result, confirmedTaskIds: ids }
    const updated = this.store.updateChangeAnalysisResult(analysisId, result)
    if (!updated) throw new ConflictException('变更分析状态已改变，请刷新后重试。')
    return updated
  }

  @Post(':analysisId/ai-candidates')
  async extractAiCandidates(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
  ): Promise<ChangeAnalysis> {
    const analysis = this.detail(projectId, analysisId)
    if (!analysis.result) throw new ConflictException('分析尚未完成，无法提取 AI 候选。')
    if (!this.llm.status().configured) throw new ConflictException('请先配置 LLM API Key。')
    const scan = this.store.getScan(projectId, analysis.scanId)
    const plan = this.store.getPlan(projectId, analysis.planVersion)
    if (!scan?.result || scan.status !== 'succeeded' || !plan) {
      throw new ConflictException('分析所引用的扫描或计划已不可用，请重新分析。')
    }
    const previousConfirmed = new Set(analysis.result.confirmedTaskIds)
    const result = analyzeChange(
      { description: analysis.description, scanId: analysis.scanId, planVersion: analysis.planVersion },
      scan.result,
      plan,
    )
    result.confirmedTaskIds = [...previousConfirmed].filter((id) =>
      result.candidates.some((candidate) => candidate.taskId === id) ||
      result.upstreamTasks?.some((task) => task.taskId === id))

    const evidence = new Map(result.evidence.map((item) => [item.id, item]))
    const candidates = result.candidates.map((candidate) => ({
      taskId: candidate.taskId,
      title: candidate.title,
      impactType: candidate.classification,
      impactPath: candidate.path,
      evidence: candidate.evidenceIds.map((id) => evidence.get(id)).filter(Boolean),
    }))
    const upstreamTasks = (result.upstreamTasks ?? []).map((task) => ({
      taskId: task.taskId,
      title: task.title,
      requirementIds: task.requirementIds,
      modulePaths: task.modulePaths,
      path: task.path,
      evidence: task.evidenceIds.map((id) => evidence.get(id)).filter(Boolean),
    }))
    const fullInventory = {
      requirements: plan.requirements,
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        requirementIds: task.requirementIds,
        predecessorIds: task.predecessorIds,
        modulePaths: task.modulePaths,
      })),
      codeModules: scan.result.files,
      codeDependencies: scan.result.dependencies.map(({ from, to, kind }) => ({ from, to, kind })),
    }
    let inventoryComplete = true
    let inventory: unknown = fullInventory
    const fullPrompt = {
      changeRequest: analysis.description,
      selectedDependencies: candidates,
      upstreamTasks,
      projectInventory: fullInventory,
      inventoryComplete: true,
    }
    if (JSON.stringify(fullPrompt).length > 80_000) {
      inventoryComplete = false
      const relevantIds = new Set([
        ...result.candidates.map(({ taskId }) => taskId),
        ...(result.upstreamTasks ?? []).map(({ taskId }) => taskId),
      ])
      const relevantRequirementIds = new Set(
        plan.tasks.filter((task) => relevantIds.has(task.id)).flatMap((task) => task.requirementIds),
      )
      inventory = {
        requirements: plan.requirements.filter((item) => relevantRequirementIds.has(item.id)),
        tasks: plan.tasks.filter((task) => relevantIds.has(task.id)).map((task) => ({
          id: task.id,
          title: task.title,
          requirementIds: task.requirementIds,
          predecessorIds: task.predecessorIds,
          modulePaths: task.modulePaths,
        })),
        codeModules: result.affectedFiles.map(({ file }) => file),
      }
    }
    const userContent = JSON.stringify({
      changeRequest: analysis.description,
      selectedDependencies: candidates,
      upstreamTasks,
      projectInventory: inventory,
      inventoryComplete,
    })
    if (userContent.length > 100_000) {
      throw new ConflictException('本次影响路径上下文过大，暂时无法安全提交给 AI；请缩小分析范围。')
    }
    let output: string
    try {
      output = await this.llm.complete(this.provider, {
        messages: [
          {
            role: 'system',
            content: [
              '你是软件项目需求变更影响复核助手。程序已经计算出 selectedDependencies，不能删除或改写其中任何任务、路径或分类。你负责判断每条程序依赖是否确实受本次变更影响，并说明理由。',
              '对 selectedDependencies 中的每个 taskId 都必须返回一条 candidates 结果：verdict 只能是 affected（有依据认为受影响）、unaffected（有依据认为不受影响）或 uncertain（上下文不足，需要人工核对）。即使 verdict 为 unaffected，也必须保留该任务和具体理由。',
              '再检查 upstreamTasks：它们是从受影响路径向前追溯的任务前置项。仅仅是前置任务不代表要返工；只有当变更破坏其交付的接口、数据结构、前置假设或验收条件时，才判断 affected。对每个 upstreamTasks.taskId 都返回 upstreamTasks 结果；不能创造不在输入中的任务。',
              '如果变更描述包含一个新的功能/需求，并且完整 projectInventory 表明它不属于已有需求、任务、模块或代码依赖，才将它作为独立新路径建议。只在 inventoryComplete=true 时允许提出；否则 newRequirements 必须为空。不要为普通的任务遗漏或未知信息编造 New0。',
              '新路径建议是待人工确认的需求草案，不得声称已写入计划；服务端会为建议分配 New0、New1 等编号，并标记需要人工设计架构。',
              '只基于输入事实推理，不得生成工时、日期、价格、代码路径或证据编号。理由要针对具体任务，不要把相同套话复制给多项。',
              '只返回 JSON，不要 Markdown 或额外文字。格式：{"candidates":[{"taskId":"T5","verdict":"affected|unaffected|uncertain","rationale":"具体理由"}],"upstreamTasks":[{"taskId":"T2","verdict":"affected|unaffected|uncertain","rationale":"说明前置交付是否需返工"}],"newRequirements":[{"independent":true,"title":"功能名","description":"需求草案","rationale":"为何与现有需求和路径独立"}]}。若没有前置影响或新增需求，返回空数组。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      })
    } catch (error) {
      throw new BadGatewayException(error instanceof Error ? error.message : 'AI 影响复核失败。')
    }
    if (output.length > 50_000) throw new BadGatewayException('LLM 复核输出超过 50,000 字符，未保存结果。')
    const reviewed = parseAiReview(output, result, inventoryComplete)
    const updated = this.store.updateChangeAnalysisResult(analysisId, reviewed)
    if (!updated) throw new ConflictException('变更分析状态已改变，请刷新后重试。')
    return updated
  }
}
