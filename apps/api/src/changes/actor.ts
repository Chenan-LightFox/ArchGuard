export interface Actor {
  id: string
  name: string
  roles: ReadonlySet<'member' | 'approver'>
  projects: ReadonlySet<string> | 'all'
}

interface ConfiguredActor {
  token: string
  actorId: string
  name: string
  roles: ('member' | 'approver')[]
  projects: string[]
}

function parseConfiguredActors(value: string | undefined): ConfiguredActor[] {
  if (!value || !value.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    throw new Error('ARCHGUARD_ACTORS_JSON 不是有效的 JSON。')
  }
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('ARCHGUARD_ACTORS_JSON 应为长度不超过 200 的数组。')
  return raw.map((item, index) => {
    const actor = item as Partial<ConfiguredActor> | null
    if (typeof actor?.token !== 'string' || !actor.token.trim() || actor.token.length > 512 ||
        /[\s\u0000-\u001f]/u.test(actor.token)) {
      throw new Error(`ARCHGUARD_ACTORS_JSON 第 ${index + 1} 项缺少有效的 token。`)
    }
    if (typeof actor.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(actor.actorId) ||
        typeof actor.name !== 'string' || !actor.name.trim() || actor.name.length > 100) {
      throw new Error(`ARCHGUARD_ACTORS_JSON 第 ${index + 1} 项的 actorId 或 name 无效。`)
    }
    const roles = actor.roles
    if (!Array.isArray(roles) || !roles.length || roles.some((role) => role !== 'member' && role !== 'approver')) {
      throw new Error(`ARCHGUARD_ACTORS_JSON 第 ${index + 1} 项的 roles 应为 member/approver 数组。`)
    }
    const projects = actor.projects === undefined || actor.projects === null
      ? ['*']
      : actor.projects
    if (!Array.isArray(projects) || projects.some((project) => typeof project !== 'string' || !project.trim())) {
      throw new Error(`ARCHGUARD_ACTORS_JSON 第 ${index + 1} 项的 projects 无效。`)
    }
    return {
      token: actor.token,
      actorId: actor.actorId,
      name: actor.name.trim(),
      roles: [...new Set(roles)],
      projects: projects.map((project) => project.trim()),
    }
  })
}

export class ActorResolver {
  private readonly actors: Map<string, Actor>

  constructor(tokensJson = process.env.ARCHGUARD_ACTORS_JSON) {
    this.actors = new Map()
    for (const configured of parseConfiguredActors(tokensJson)) {
      const projects = configured.projects.length === 1 && configured.projects[0] === '*'
        ? 'all'
        : new Set(configured.projects)
      this.actors.set(configured.token, {
        id: configured.actorId,
        name: configured.name,
        roles: new Set(configured.roles),
        projects,
      })
    }
  }

  resolve(header: string | undefined): Actor | undefined {
    if (typeof header !== 'string') return undefined
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return undefined
    return this.actors.get(match[1])
  }

  get size(): number {
    return this.actors.size
  }
}
