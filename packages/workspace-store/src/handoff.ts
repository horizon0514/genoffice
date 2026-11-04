import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DufsClient, type BasicAuth } from './dufs-client.js'
import { hashFileSha256, listWorkspaceFiles, slugify } from './snapshot.js'
import { loadWorkspace } from './store.js'
import type {
  HandoffApplyResult,
  HandoffDiffEntry,
  HandoffDownloadResult,
  HandoffFileEntry,
  HandoffManifest,
  HandoffPublishResult,
  HandoffSummary,
} from './types.js'

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HANDOFF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface HandoffItemOptions {
  filesBaseUrl: string
  projectId: string
  auth?: BasicAuth
}

export interface PublishHandoffOptions {
  workspaceDir: string
  filesBaseUrl: string
  /** Defaults to the first project id in the workspace manifest */
  projectId?: string
  authorName: string
  authorEmail?: string
  note?: string
  auth?: BasicAuth
  /** Override the generated handoff id (used by tests) */
  handoffId?: string
  now?: Date
}

export interface DownloadHandoffOptions extends HandoffItemOptions {
  workspaceDir: string
  handoffId: string
}

export interface ApplyHandoffOptions {
  workspaceDir: string
  handoffId: string
  paths: string[]
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

export function handoffDirRel(projectId: string): string {
  return `genoffice/projects/${projectId}/handoffs`
}

export function handoffUrl(filesBaseUrl: string, projectId: string, handoffId: string): string {
  return `${trimBase(filesBaseUrl)}/${handoffDirRel(projectId)}/${handoffId}/`
}

/** Reject absolute paths, traversal, and NUL bytes coming from remote manifests. */
export function safeRelativePath(raw: string): string | null {
  const value = raw.replace(/\\/g, '/').trim()
  if (!value || value.includes('\0') || value.startsWith('/')) return null
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

function assertSegment(value: string, label: string, pattern: RegExp): string {
  const trimmed = value.trim()
  if (!pattern.test(trimmed)) throw new Error(`${label}不合法：${value}`)
  return trimmed
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function defaultHandoffId(authorName: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
    now.getHours(),
  )}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const who = slugify(authorName).replace(/-/g, '').slice(0, 20) || 'user'
  return `${stamp}-${who}-${randomBytes(2).toString('hex')}`
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function projectIdFromWorkspace(workspaceDir: string): string {
  const manifest = loadWorkspace(workspaceDir)
  if (!manifest) throw new Error('工作空间缺少 .genoffice/workspace.json')
  const projectId = manifest.rzSystem?.projectIds?.[0]
  if (!projectId) {
    throw new Error('该工作空间还没有绑定 rz-system 项目，请先从 rz-system 同步项目')
  }
  return assertSegment(projectId, '项目 ID', PROJECT_ID_RE)
}

function manifestFor(
  workspaceDir: string,
  projectId: string,
): {
  projectName: string
  projectCode?: string
  taskId?: string
  taskUrl?: string
} {
  const manifest = loadWorkspace(workspaceDir)
  const link =
    manifest?.projects.find((project) => project.id === projectId) ?? manifest?.projects[0]
  return {
    projectName: link?.name ?? manifest?.name ?? projectId,
    ...(link?.projectCode ? { projectCode: link.projectCode } : {}),
    ...(link?.taskId ? { taskId: link.taskId } : {}),
    ...(link?.url ? { taskUrl: link.url } : {}),
  }
}

async function fetchManifest(
  client: DufsClient,
  projectId: string,
  handoffId: string,
): Promise<HandoffManifest> {
  const rel = `${handoffDirRel(projectId)}/${handoffId}/manifest.json`
  const raw = await client.get(rel)
  const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as HandoffManifest
  if (parsed.schema !== 'genoffice-handoff@1' || parsed.handoffId !== handoffId) {
    throw new Error(`交接清单格式不正确：${handoffId}`)
  }
  return parsed
}

/**
 * Upload the current workspace as an immutable handoff package.
 * Files go first and `manifest.json` goes last, so a partial upload stays invisible.
 */
export async function publishHandoff(opts: PublishHandoffOptions): Promise<HandoffPublishResult> {
  try {
    const projectId = assertSegment(
      opts.projectId || projectIdFromWorkspace(opts.workspaceDir),
      '项目 ID',
      PROJECT_ID_RE,
    )
    const authorName = opts.authorName?.trim()
    if (!authorName) throw new Error('缺少提交人信息，请先在设置中连接 rz-system')
    const handoffId = assertSegment(
      opts.handoffId ?? defaultHandoffId(authorName, opts.now ?? new Date()),
      '交接 ID',
      HANDOFF_ID_RE,
    )
    const info = manifestFor(opts.workspaceDir, projectId)
    const client = new DufsClient(opts.filesBaseUrl, opts.auth)
    const root = `${handoffDirRel(projectId)}/${handoffId}`

    const files: HandoffFileEntry[] = []
    for (const rel of listWorkspaceFiles(opts.workspaceDir)) {
      const safe = safeRelativePath(rel)
      if (!safe) continue
      const abs = join(resolve(opts.workspaceDir), safe)
      let size = 0
      try {
        size = statSync(abs).size
      } catch {
        continue
      }
      const sha256 = await hashFileSha256(abs)
      files.push({ path: safe, size, sha256 })
      await client.put(`${root}/files/${safe}`, readFileSync(abs), 'application/octet-stream')
    }

    const manifest: HandoffManifest = {
      schema: 'genoffice-handoff@1',
      handoffId,
      projectId,
      projectName: info.projectName,
      ...(info.projectCode ? { projectCode: info.projectCode } : {}),
      ...(info.taskId ? { taskId: info.taskId } : {}),
      ...(info.taskUrl ? { taskUrl: info.taskUrl } : {}),
      author: {
        name: authorName,
        ...(opts.authorEmail ? { email: opts.authorEmail } : {}),
      },
      ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
      createdAt: (opts.now ?? new Date()).toISOString(),
      files,
    }
    await client.putJson(`${root}/manifest.json`, manifest)

    return {
      ok: true,
      handoffId,
      url: handoffUrl(opts.filesBaseUrl, projectId, handoffId),
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** List handoffs for a project, newest first. Directories without a manifest are skipped. */
export async function listHandoffs(opts: HandoffItemOptions): Promise<HandoffSummary[]> {
  const projectId = assertSegment(opts.projectId, '项目 ID', PROJECT_ID_RE)
  const client = new DufsClient(opts.filesBaseUrl, opts.auth)
  const entries = await client.listDir(handoffDirRel(projectId))
  const dirs = entries
    .filter((entry) => entry.isDir && HANDOFF_ID_RE.test(entry.name))
    .sort((a, b) => b.mtime - a.mtime)

  const manifests = await mapLimit(dirs, 6, async (entry) => {
    try {
      return await fetchManifest(client, projectId, entry.name)
    } catch {
      return null
    }
  })

  return manifests
    .flatMap((manifest): HandoffSummary[] => {
      if (!manifest) return []
      return [
        {
          id: manifest.handoffId,
          url: handoffUrl(opts.filesBaseUrl, projectId, manifest.handoffId),
          projectId,
          authorName: manifest.author.name,
          ...(manifest.author.email ? { authorEmail: manifest.author.email } : {}),
          ...(manifest.note ? { note: manifest.note } : {}),
          createdAt: manifest.createdAt,
          fileCount: manifest.files.length,
          totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        },
      ]
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** Download a handoff into `<workspace>/.genoffice/handoffs/<id>/` and diff it locally. */
export async function downloadHandoff(
  opts: DownloadHandoffOptions,
): Promise<HandoffDownloadResult> {
  try {
    const projectId = assertSegment(opts.projectId, '项目 ID', PROJECT_ID_RE)
    const handoffId = assertSegment(opts.handoffId, '交接 ID', HANDOFF_ID_RE)
    const client = new DufsClient(opts.filesBaseUrl, opts.auth)
    const manifest = await fetchManifest(client, projectId, handoffId)
    const targetDir = join(resolve(opts.workspaceDir), '.genoffice', 'handoffs', handoffId)
    const diff: HandoffDiffEntry[] = []

    for (const file of manifest.files) {
      const safe = safeRelativePath(file.path)
      if (!safe) continue
      const buf = await client.get(`${handoffDirRel(projectId)}/${handoffId}/files/${safe}`)
      const dest = join(targetDir, safe)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, buf)

      const localPath = join(resolve(opts.workspaceDir), safe)
      if (!existsSync(localPath)) {
        diff.push({ path: safe, kind: 'new' })
        continue
      }
      const localSha = await hashFileSha256(localPath)
      diff.push({ path: safe, kind: localSha === file.sha256 ? 'unchanged' : 'changed' })
    }

    return { ok: true, handoffId, dir: targetDir, diff }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Copy selected downloaded files into the workspace. Never deletes local files. */
export function applyHandoff(opts: ApplyHandoffOptions): HandoffApplyResult {
  try {
    const handoffId = assertSegment(opts.handoffId, '交接 ID', HANDOFF_ID_RE)
    const targetDir = join(resolve(opts.workspaceDir), '.genoffice', 'handoffs', handoffId)
    if (!existsSync(targetDir)) throw new Error('请先下载该交接，再应用到工作空间')
    let applied = 0
    for (const raw of opts.paths) {
      const safe = safeRelativePath(raw)
      if (!safe) continue
      const from = join(targetDir, safe)
      if (!existsSync(from)) continue
      const to = join(resolve(opts.workspaceDir), safe)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      applied += 1
    }
    return { ok: true, applied }
  } catch (err) {
    return { ok: false, applied: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
