import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ImportResult,
  RzProject,
  RzSystemClient,
  RzTask,
  WorkspaceManifest,
} from './types.js'
import { addOrUpdateProject, loadWorkspace, saveWorkspace } from './store.js'

export class HttpRzClient implements RzSystemClient {
  private baseUrl: string
  private token: string
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
  }
  async listProjects(): Promise<RzProject[]> {
    // Minimal scaffolding: exact API unknown; adapt here when docs are available.
    // Expect a GET /api/projects with bearer token.
    const res = await fetch(`${this.baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`rz-system listProjects failed: ${res.status}`)
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) return []
    return json
      .map((p: any) => ({ id: String(p.id ?? p.projectId ?? ''), name: String(p.name ?? p.title ?? '') }))
      .filter((p) => p.id && p.name)
  }
  async listTasks(projectId: string): Promise<RzTask[]> {
    const res = await fetch(`${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) return []
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) return []
    return json.map((t: any) => ({
      id: String(t.id ?? t.taskId ?? ''),
      projectId,
      title: String(t.title ?? t.name ?? ''),
      status: typeof t.status === 'string' ? t.status : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
    }))
  }
}

export class FixtureRzClient implements RzSystemClient {
  private fixtureDir: string
  constructor(fixtureDir: string) {
    this.fixtureDir = fixtureDir
  }
  async listProjects(): Promise<RzProject[]> {
    const path = join(this.fixtureDir, 'projects.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .map((p: any) => ({ id: String(p.id ?? ''), name: String(p.name ?? '') }))
      .filter((p) => p.id && p.name)
  }
  async listTasks(projectId: string): Promise<RzTask[]> {
    const path = join(this.fixtureDir, `tasks-${projectId}.json`)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.map((t: any) => ({
        id: String(t.id ?? ''),
        projectId,
        title: String(t.title ?? ''),
        status: typeof t.status === 'string' ? t.status : undefined,
        assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      }))
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
 * Import rz-system projects into a workspace manifest (read-only mirror of ids and names).
 * - Creates the workspace if missing.
 * - Does not create or edit any document files.
 * - Records the source info under manifest.rzSystem.
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
    const tasks = await args.client.listTasks(p.id).catch(() => []) // tasks are optional
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
