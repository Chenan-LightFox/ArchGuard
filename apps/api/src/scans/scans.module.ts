import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common'
import type { ArchitectureComparison, ArchitectureRules, RepositoryScan, RepositoryScanDetail, ScanPreflight } from '@archguard/contracts'
import { compareArchitecture, detectArchitecture, parseArchitectureRules } from '../architecture/rules'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'
import { normalizeGitRef, validateRepositoryUrl } from './git-snapshot'

@Controller('projects/:projectId/scans/preflights')
class ScansController {
  constructor(@Inject(SqliteStore) private readonly store: SqliteStore) {}

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string): ScanPreflight[] {
    this.requireProject(projectId)
    return this.store.listPreflights(projectId)
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  enqueue(@Param('projectId', ParseUUIDPipe) projectId: string): ScanPreflight {
    this.requireProject(projectId)
    return this.store.enqueuePreflight(projectId)
  }

  private requireProject(projectId: string): void {
    if (!this.store.hasProject(projectId)) {
      throw new NotFoundException('找不到该项目。')
    }
  }
}

@Controller('projects/:projectId/scans')
class RepositoryScansController {
  constructor(@Inject(SqliteStore) private readonly store: SqliteStore) {}

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string): RepositoryScan[] {
    if (!this.store.hasProject(projectId)) throw new NotFoundException('找不到该项目。')
    return this.store.listScans(projectId)
  }

  @Get(':scanId')
  detail(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('scanId', ParseUUIDPipe) scanId: string,
  ): RepositoryScanDetail {
    const scan = this.store.getScan(projectId, scanId)
    if (!scan) throw new NotFoundException('找不到该扫描记录。')
    if (scan.result && !scan.result.architecture) {
      scan.result.architecture = detectArchitecture(scan.result, parseArchitectureRules(undefined))
    }
    return scan
  }

  @Get(':scanId/compare/:baselineId')
  compare(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('scanId', ParseUUIDPipe) scanId: string,
    @Param('baselineId', ParseUUIDPipe) baselineId: string,
  ): ArchitectureComparison {
    const before = this.detail(projectId, baselineId).result
    const after = this.detail(projectId, scanId).result
    if (!before?.architecture || !after?.architecture) throw new ConflictException('请选择两次已完成的扫描。')
    if (before.analyzerVersion !== after.analyzerVersion) throw new ConflictException('请选择使用同一解析器版本的扫描。')
    try {
      return compareArchitecture(before.architecture, after.architecture)
    } catch (error) {
      throw new ConflictException((error as Error).message)
    }
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  enqueue(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: unknown): RepositoryScan {
    const project = this.store.getProject(projectId)
    if (!project) throw new NotFoundException('找不到该项目。')
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
      throw new BadRequestException('扫描参数应为对象。')
    }
    let ref: string
    let rules: ArchitectureRules
    try {
      validateRepositoryUrl(project.repositoryUrl)
      const input = body as { ref?: unknown; rules?: unknown } | undefined
      ref = normalizeGitRef(input?.ref)
      rules = parseArchitectureRules(input?.rules)
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '扫描参数无效。')
    }
    return this.store.enqueueScan(projectId, ref, rules)
  }
}

@Module({ imports: [StorageModule], controllers: [ScansController, RepositoryScansController] })
export class ScansModule {}
