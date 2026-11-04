import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type {
  ImportResult,
  RzProject,
  RzProjectResult,
  RzProjectStage,
  RzSyncResult,
  RzSystemClient,
  RzTask,
  WorkspaceManifest,
  WorkspaceProjectLink,
} from './types.js'
import { addOrUpdateProject, initWorkspace, loadWorkspace, saveWorkspace } from './store.js'

const SESSION_COOKIE = 'rz-system-session'
const DEFAULT_API_PREFIX = '/api/v2'

export interface HttpRzClientOptions {
  /** API base, e.g. http://localhost:3000 */
  baseUrl: string
  /** Browser URL used for task deep links; defaults to baseUrl */
  webUrl?: string
  /** rz-system login email (the product calls this field "email") */
  email?: string
  password?: string
  /** Reuse an existing rz-system-session cookie instead of logging in */
  sessionCookie?: string
  /** Test seam */
  fetchImpl?: typeof fetch
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? ''))).filter(Boolean)
    : []
}

function isoDate(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return undefined
}

function normalizeFiles(value: unknown): Array<{ fileName: string; fileUrl: string }> {
  if (!Array.isArray(value)) return []
  const files: Array<{ fileName: string; fileUrl: string }> = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const fileName = asString(item.fileName)
    const fileUrl = asString(item.fileUrl)
    if (fileName && fileUrl) files.push({ fileName, fileUrl })
  }
  return files
}

function normalizeStage(raw: unknown): RzProjectStage | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const key = asString(item.key)
  if (!key) return null
  return {
    key,
    name: asString(item.name),
    files: normalizeFiles(item.files),
    adminFiles: normalizeFiles(item.adminFiles),
  }
}

function normalizeResult(raw: unknown): RzProjectResult | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const key = asString(item.key)
  if (!key) return null
  return {
    key,
    type: asString(item.type),
    files: normalizeFiles(item.files),
  }
}

/** Map a raw getProjects row into the shape GenOffice works with. */
export function parseRzProject(raw: unknown, webUrl?: string): RzProject | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = asString(p.id)
  const name = asString(p.name)
  if (!id || !name) return null
  const task = p.task && typeof p.task === 'object' ? (p.task as Record<string, unknown>) : null
  const taskId = asString(p.taskId) ?? asString(task?.id)
  const base = webUrl ? trimBase(webUrl) : undefined
  return {
    id,
    name,
    projectCode: asString(p.projectCode),
    status: asString(p.status),
    client: asString(p.client),
    ownerId: asString(p.ownerId),
    ownerName: asString(p.ownerName),
    assistantNames: asStringArray(p.assistantNames),
    taskId,
    taskName: asString(task?.name),
    taskStatus: typeof task?.status === 'number' ? task.status : undefined,
    taskOwnerName: asString(task?.ownerName),
    memberNames: asStringArray(task?.memberNames),
    updatedAt: isoDate(p.updatedAt),
    stages: Array.isArray(p.processResults)
      ? p.processResults.map(normalizeStage).filter((s): s is RzProjectStage => s !== null)
      : [],
    finalResults: Array.isArray(p.finalResults)
      ? p.finalResults.map(normalizeResult).filter((r): r is RzProjectResult => r !== null)
      : [],
    coreResults: Array.isArray(p.coreResults)
      ? p.coreResults.map(normalizeResult).filter((r): r is RzProjectResult => r !== null)
      : [],
    taskUrl:
      taskId && base ? `${base}/task/detail?taskId=${encodeURIComponent(taskId)}` : undefined,
  }
}

function readSessionCookie(headers: Headers): string | null {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const raw = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : []
  const lines = raw.length > 0 ? raw : [headers.get('set-cookie') ?? '']
  for (const line of lines) {
    const match = new RegExp(`(?:^|[,\\s])${SESSION_COOKIE}=([^;,\\s]+)`).exec(line)
    if (match) return `${SESSION_COOKIE}=${match[1]}`
  }
  return null
}

async function responseError(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return `${res.status} ${res.statusText}`
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown }
      const message = asString(json.error) ?? asString(json.message)
      if (message) return `${res.status}: ${message}`
    } catch {
      // plain text body
    }
    return `${res.status}: ${text.slice(0, 400)}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}

/**
 * rz-system v2 client.
 *
 * rz-system exposes every operation as POST /api/v2/<domain>/<name>, and auth is
 * an HttpOnly `rz-system-session` cookie (not a bearer token). The client logs in
 * lazily and re-authenticates once when a cookie expires.
 */
export class HttpRzClient implements RzSystemClient {
  readonly baseUrl: string
  readonly webUrl: string
  private readonly email?: string
  private readonly password?: string
  private readonly fetchImpl: typeof fetch
  private sessionCookie: string | null

  constructor(options: HttpRzClientOptions) {
    this.baseUrl = trimBase(options.baseUrl)
    this.webUrl = trimBase(options.webUrl || options.baseUrl)
    this.email = options.email
    this.password = options.password
    this.sessionCookie = options.sessionCookie?.trim() || null
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  getSessionCookie(): string | null {
    return this.sessionCookie
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.sessionCookie ? { cookie: this.sessionCookie } : {}),
    }
  }

  async login(): Promise<{ id: string; name: string; email: string; role: string }> {
    if (!this.email || !this.password) {
      throw new Error('rz-system 未配置登录账号（需要 email + password）')
    }
    const res = await this.fetchImpl(`${this.baseUrl}${DEFAULT_API_PREFIX}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    })
    if (!res.ok) throw new Error(`rz-system 登录失败 ${await responseError(res)}`)
    const cookie = readSessionCookie(res.headers)
    if (!cookie) throw new Error('rz-system 登录成功但没有返回 rz-system-session cookie')
    this.sessionCookie = cookie
    const body = (await res.json()) as Record<string, unknown>
    return {
      id: String(body.id ?? ''),
      name: String(body.name ?? ''),
      email: String(body.email ?? this.email),
      role: String(body.role ?? ''),
    }
  }

  async me(): Promise<{ userId: number; name: string; email: string; role: string } | null> {
    if (!this.sessionCookie) return null
    const res = await this.fetchImpl(`${this.baseUrl}${DEFAULT_API_PREFIX}/auth/me`, {
      headers: this.headers(),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { user?: Record<string, unknown> | null }
    if (!body.user) return null
    return {
      userId: Number(body.user.userId ?? 0),
      name: String(body.user.name ?? ''),
      email: String(body.user.email ?? ''),
      role: String(body.user.role ?? ''),
    }
  }

  /** Establish a session (reuse a cookie when it is still valid). */
  async ensureAuthenticated(): Promise<{ email: string; name: string }> {
    if (this.sessionCookie) {
      const user = await this.me()
      if (user) return { email: user.email, name: user.name }
    }
    if (this.email && this.password) {
      const user = await this.login()
      return { email: user.email, name: user.name }
    }
    throw new Error('rz-system 登录已过期，请重新输入账号密码')
  }

  private async rpc(domain: string, name: string, input: unknown): Promise<unknown> {
    const call = () =>
      this.fetchImpl(`${this.baseUrl}${DEFAULT_API_PREFIX}/${domain}/${name}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input ?? {}),
      })
    let res = await call()
    if (res.status === 401 && this.email && this.password) {
      await this.login()
      res = await call()
    }
    if (!res.ok) throw new Error(`rz-system ${domain}/${name} 失败 ${await responseError(res)}`)
    return res.json()
  }

  async listProjects(): Promise<RzProject[]> {
    const json = (await this.rpc('project', 'getProjects', {
      take: 200,
      orderBy: { updatedAt: 'desc' },
      include: { task: true },
    })) as { projects?: unknown[] }
    const rows = Array.isArray(json) ? json : Array.isArray(json?.projects) ? json.projects : []
    return rows.map((row) => parseRzProject(row, this.webUrl)).filter((p): p is RzProject => !!p)
  }

  async listTasks(projectId: string): Promise<RzTask[]> {
    const numericId = Number(projectId)
    const json = (await this.rpc('task', 'getTasks', {
      where: Number.isFinite(numericId) ? { projectId: numericId } : undefined,
      take: 100,
      include: { projects: true },
    })) as { tasks?: unknown[] }
    const rows = Array.isArray(json) ? json : Array.isArray(json?.tasks) ? json.tasks : []
    return rows
      .map((row): RzTask | null => {
        if (!row || typeof row !== 'object') return null
        const t = row as Record<string, unknown>
        const id = asString(t.id)
        if (!id) return null
        return {
          id,
          projectId,
          title: asString(t.name) ?? '',
          status: typeof t.status === 'number' ? String(t.status) : asString(t.status),
          assignee: asString(t.ownerName),
        }
      })
      .filter((t): t is RzTask => !!t)
  }
}

export class FixtureRzClient implements RzSystemClient {
  private fixtureDir: string
  constructor(fixtureDir: string) {
    this.fixtureDir = fixtureDir
  }
  async listProjects(): Promise<RzProject[]> {
    const raw = JSON.parse(readFileSync(join(this.fixtureDir, 'projects.json'), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.map((p) => parseRzProject(p)).filter((p): p is RzProject => !!p)
  }
  async listTasks(projectId: string): Promise<RzTask[]> {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.fixtureDir, `tasks-${projectId}.json`), 'utf8'),
      ) as unknown
      if (!Array.isArray(raw)) return []
      return raw
        .map((t: any) => ({
          id: String(t.id ?? ''),
          projectId,
          title: String(t.title ?? t.name ?? ''),
          status: typeof t.status === 'string' ? t.status : undefined,
          assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
        }))
        .filter((t) => t.id)
    } catch {
      return []
    }
  }
}

export interface ImportOptions {
  /** restrict to these rz project ids; omit for all available */
  projectIds?: string[]
}

/**
 * Import rz-system projects into a workspace manifest (metadata only).
 * Kept for callers that only need a mirror of ids and names.
 */
export async function importRzSystemIntoWorkspace(args: {
  workspaceDir: string
  client: RzSystemClient
  options?: ImportOptions
}): Promise<ImportResult> {
  let manifest: WorkspaceManifest = loadWorkspace(args.workspaceDir) ?? {
    name: 'Workspace',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    members: [],
    projects: [],
  }
  const all = await args.client.listProjects()
  const wanted = args.options?.projectIds?.length
    ? all.filter((p) => args.options!.projectIds!.includes(p.id))
    : all
  let taskCount = 0
  for (const p of wanted) {
    const tasks = await args.client.listTasks(p.id).catch(() => [])
    taskCount += tasks.length
    manifest = addOrUpdateProject(args.workspaceDir, manifest, { id: p.id, name: p.name }, [])
  }
  manifest = {
    ...manifest,
    rzSystem: {
      ...(manifest.rzSystem ?? {}),
      projectIds: wanted.map((p) => p.id),
      importedAt: new Date().toISOString(),
    },
  }
  saveWorkspace(args.workspaceDir, manifest)
  return { projects: wanted.length, tasks: taskCount }
}

// ── Real project sync (metadata + attachments) ────────────────────────────────

/** Resolve an rz-system attachment URL against the dufs base. */
export function resolveRzFileUrl(filesBaseUrl: string, fileUrl: string): string {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl
  const base = `${trimBase(filesBaseUrl)}/`
  return new URL(fileUrl.replace(/^\/+/, ''), base).toString()
}

function sanitizeSegment(input: string, fallback = 'item'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
  return cleaned || fallback
}

function fileNameOf(urlOrName: string, fallback: string): string {
  const noQuery = urlOrName.split(/[?#]/)[0] ?? ''
  const raw = noQuery.split('/').pop() || fallback
  try {
    return sanitizeSegment(decodeURIComponent(raw), fallback)
  } catch {
    return sanitizeSegment(raw, fallback)
  }
}

function atomicWrite(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(5).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/** Directory name for a project workspace, safe on every desktop platform. */
export function workspaceDirNameForProject(project: RzProject): string {
  const code = project.projectCode ? `${project.projectCode}-` : ''
  return sanitizeSegment(`${code}${project.name}`, `rz-project-${project.id}`)
}

export interface SyncRzProjectsArgs {
  workspaceDir: string
  client: RzSystemClient
  projects: RzProject[]
  /** dufs base URL that serves rz-system attachments */
  filesBaseUrl?: string
  /** Test seam */
  fetchImpl?: typeof fetch
}

/**
 * Download every attachment referenced by the selected rz-system projects into
 * the workspace and update the manifest. Existing files are never overwritten:
 * a local document may contain edits that rz-system does not know about.
 */
export async function syncRzProjectsToWorkspace(args: SyncRzProjectsArgs): Promise<RzSyncResult> {
  const { workspaceDir, projects, filesBaseUrl } = args
  const fetchImpl = args.fetchImpl ?? fetch
  const root = resolve(workspaceDir)
  const warnings: string[] = []
  let downloaded = 0
  let skipped = 0
  let failed = 0
  const allFiles: string[] = []

  const initial = loadWorkspace(root)
  const name = projects.length === 1 ? projects[0]!.name : `rz-system (${projects.length} 个项目)`
  let manifest = initial ?? initWorkspace(root, name)

  const download = async (
    project: RzProject,
    relDir: string,
    file: { fileName: string; fileUrl: string },
  ) => {
    const fileName = sanitizeSegment(file.fileName || fileNameOf(file.fileUrl, 'file'))
    const rel = [
      project.projectCode ? sanitizeSegment(project.projectCode) : project.id,
      relDir,
      fileName,
    ]
      .filter(Boolean)
      .join('/')
    const abs = resolve(root, rel)
    if (!abs.startsWith(`${root}/`) && abs !== root) {
      warnings.push(`跳过越界路径 ${rel}`)
      failed += 1
      return null
    }
    allFiles.push(rel)
    if (existsSync(abs)) {
      skipped += 1
      return abs
    }
    if (!filesBaseUrl) {
      warnings.push(`未配置附件服务地址，无法下载 ${file.fileName}`)
      failed += 1
      return null
    }
    try {
      const url = resolveRzFileUrl(filesBaseUrl, file.fileUrl)
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      atomicWrite(abs, bytes)
      downloaded += 1
      return abs
    } catch (err) {
      failed += 1
      warnings.push(
        `下载失败 ${file.fileName}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  for (const project of projects) {
    const absFiles: string[] = []
    for (const stage of project.stages) {
      for (const file of stage.files) {
        const abs = await download(project, `files/${sanitizeSegment(stage.key)}`, file)
        if (abs) absFiles.push(abs)
      }
      for (const file of stage.adminFiles) {
        const abs = await download(project, `admin/${sanitizeSegment(stage.key)}`, file)
        if (abs) absFiles.push(abs)
      }
    }
    for (const result of project.finalResults) {
      for (const file of result.files) {
        const abs = await download(project, `final/${sanitizeSegment(result.key)}`, file)
        if (abs) absFiles.push(abs)
      }
    }
    for (const result of project.coreResults) {
      for (const file of result.files) {
        const abs = await download(project, `core/${sanitizeSegment(result.key)}`, file)
        if (abs) absFiles.push(abs)
      }
    }

    manifest = addOrUpdateProject(root, manifest, { id: project.id, name: project.name }, absFiles)
    const link = manifest.projects.find((p) => p.id === project.id)
    if (!link) continue
    const memberNames = dedupe(
      [
        project.ownerName,
        ...(project.assistantNames ?? []),
        project.taskOwnerName,
        ...(project.memberNames ?? []),
      ].filter((v): v is string => !!v && !!v.trim()),
    )
    const nextLink: WorkspaceProjectLink = {
      ...link,
      ...(project.projectCode ? { projectCode: project.projectCode } : {}),
      ...(project.status ? { status: project.status } : {}),
      ...(project.taskId ? { taskId: project.taskId } : {}),
      ...(project.taskName ? { taskName: project.taskName } : {}),
      ...(project.taskUrl ? { url: project.taskUrl } : {}),
      ...(project.ownerName ? { ownerName: project.ownerName } : {}),
      ...(memberNames.length > 0 ? { memberNames } : {}),
      syncedAt: new Date().toISOString(),
    }
    manifest = {
      ...manifest,
      members: mergeMembers(manifest.members, memberNames),
      projects: manifest.projects.map((p) => (p.id === project.id ? nextLink : p)),
    }
  }

  const now = new Date().toISOString()
  manifest = {
    ...manifest,
    name: manifest.name || name,
    rzSystem: {
      ...(manifest.rzSystem ?? {}),
      ...(filesBaseUrl ? { filesUrl: filesBaseUrl } : {}),
      projectIds: dedupe([...(manifest.rzSystem?.projectIds ?? []), ...projects.map((p) => p.id)]),
      importedAt: manifest.rzSystem?.importedAt ?? now,
      lastSyncAt: now,
    },
  }
  saveWorkspace(root, manifest)

  return {
    workspaceDir: root,
    workspaceName: manifest.name,
    projects: projects.length,
    downloaded,
    skipped,
    failed,
    files: dedupe(allFiles),
    warnings,
  }
}

function mergeMembers(
  existing: WorkspaceManifest['members'],
  names: string[],
): WorkspaceManifest['members'] {
  const byName = new Map(existing.map((m) => [m.name, m]))
  for (const name of names) {
    if (!byName.has(name)) byName.set(name, { id: `rz:${name}`, name, role: 'rz-system' })
  }
  return [...byName.values()]
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
