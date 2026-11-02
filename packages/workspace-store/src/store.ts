import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WorkspaceManifest, WorkspaceProjectLink } from './types.js'

const MANIFEST_DIR = '.genoffice'
const MANIFEST_FILE = 'workspace.json'

function nowIso(): string {
  return new Date().toISOString()
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function atomicWrite(path: string, data: unknown): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      // best-effort cleanup
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      existsSync(tmp) && renameSync(tmp, `${tmp}.bak`)
    } catch {}
    throw err
  }
}

export function manifestPath(workspaceDir: string): string {
  return join(workspaceDir, MANIFEST_DIR, MANIFEST_FILE)
}

export function loadWorkspace(workspaceDir: string): WorkspaceManifest | null {
  const path = manifestPath(workspaceDir)
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as WorkspaceManifest
  } catch {
    return null
  }
}

export function initWorkspace(workspaceDir: string, name?: string): WorkspaceManifest {
  const existing = loadWorkspace(workspaceDir)
  if (existing) return existing
  const title = ((name ?? basename(resolve(workspaceDir))) || 'Workspace').slice(0, 128)
  const now = nowIso()
  const manifest: WorkspaceManifest = {
    name: title,
    createdAt: now,
    updatedAt: now,
    members: [],
    projects: [],
  }
  atomicWrite(manifestPath(workspaceDir), manifest)
  return manifest
}

export function saveWorkspace(workspaceDir: string, manifest: WorkspaceManifest): void {
  const next = { ...manifest, updatedAt: nowIso() }
  atomicWrite(manifestPath(workspaceDir), next)
}

export function addOrUpdateProject(
  workspaceDir: string,
  manifest: WorkspaceManifest,
  project: { id: string; name: string },
  filesAbs: readonly string[] = [],
): WorkspaceManifest {
  const relFiles = dedupe(
    filesAbs
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => relative(resolve(workspaceDir), resolve(p)).replace(/\\/g, '/'))
      .filter((rel) => rel && !rel.split('/').includes('..')),
  )
  const existing = manifest.projects.find((p) => p.id === project.id)
  const link: WorkspaceProjectLink = existing
    ? { ...existing, name: project.name, files: dedupe([...existing.files, ...relFiles]) }
    : { id: project.id, name: project.name, files: relFiles }
  const next: WorkspaceManifest = {
    ...manifest,
    projects: [
      ...manifest.projects.filter((p) => p.id !== project.id),
      link,
    ].sort((a, b) => a.name.localeCompare(b.name, 'en')),
  }
  saveWorkspace(workspaceDir, next)
  return next
}

function dedupe<T>(arr: readonly T[]): T[] {
  return [...new Set(arr)]
}
