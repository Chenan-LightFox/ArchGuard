import { BadRequestException, Body, Controller, Get, Inject, Module, Post } from '@nestjs/common'
import type { CreateProjectInput, Project } from '@archguard/contracts'
import { SqliteStore } from '../storage/sqlite-store'
import { StorageModule } from '../storage/storage.module'

function parseProjectInput(body: unknown): CreateProjectInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('请输入项目名称和 Git 仓库地址。')
  }

  const input = body as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < 1 || name.length > 100) {
    throw new BadRequestException('项目名称应为 1 到 100 个字符。')
  }

  const repositoryUrl = typeof input.repositoryUrl === 'string' ? input.repositoryUrl.trim() : ''
  if (repositoryUrl.length > 2048) {
    throw new BadRequestException('Git 仓库地址过长。')
  }

  let url: URL
  try {
    url = new URL(repositoryUrl)
  } catch {
    throw new BadRequestException('请输入有效的 HTTPS Git 仓库地址。')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname === '/') {
    throw new BadRequestException('请输入不含凭据、查询参数或片段的 HTTPS Git 仓库地址。')
  }

  return { name, repositoryUrl: url.href }
}

@Controller('projects')
class ProjectsController {
  constructor(@Inject(SqliteStore) private readonly store: SqliteStore) {}

  @Get()
  list(): Project[] {
    return this.store.listProjects()
  }

  @Post()
  create(@Body() body: unknown): Project {
    return this.store.createProject(parseProjectInput(body))
  }
}

@Module({ imports: [StorageModule], controllers: [ProjectsController] })
export class ProjectsModule {}
