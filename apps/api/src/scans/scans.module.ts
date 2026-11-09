import {
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
import type { ScanPreflight } from '@archguard/contracts'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'

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

@Module({ imports: [StorageModule], controllers: [ScansController] })
export class ScansModule {}
