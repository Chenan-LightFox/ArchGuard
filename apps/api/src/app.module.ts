import { Controller, Get, Inject, Module } from '@nestjs/common'
import type { HealthStatus } from '@archguard/contracts'
import { ProjectsModule } from './projects/projects.module'
import { ScansModule } from './scans/scans.module'
import { SqliteStore } from './storage/sqlite-store'
import { StorageModule } from './storage/storage.module'
import { PlansModule } from './plans/plans.module'
import { LlmModule } from './llm/llm.module'
import { ChangesModule } from './changes/changes.module'
import { ImplementationModule } from './implementation/implementation.module'
import { ReportsModule } from './reports/reports.module'

@Controller('health')
class HealthController {
  constructor(@Inject(SqliteStore) private readonly store: SqliteStore) {}

  @Get()
  check(): HealthStatus {
    this.store.ping()
    return { status: 'ok', database: 'ready' }
  }
}

@Module({
  imports: [StorageModule, ProjectsModule, ScansModule, PlansModule, LlmModule, ChangesModule, ImplementationModule, ReportsModule],
  controllers: [HealthController],
})
export class AppModule {}
