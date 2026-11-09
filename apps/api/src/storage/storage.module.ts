import { Module } from '@nestjs/common'
import { SqliteStore } from './sqlite-store'

@Module({
  providers: [{ provide: SqliteStore, useFactory: () => new SqliteStore() }],
  exports: [SqliteStore],
})
export class StorageModule {}
