import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { manifestPath } from './store.js'
import type { SnapshotFileEntry, SnapshotIndex, WorkspaceManifest } from './types.js'

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function hashBufferSha256(buf: Buffer): string {
  const h = createHash('sha256')
  h.update(buf)
  return h.digest('hex')
}

export function hashFileSha256(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', reject)
    stream.on('data', (chunk) => h.update(chunk))
    stream.on('end', () => resolveHash(h.digest('hex')))
  })
}

export function shortDigest(hexSha256: string, length = 8): string {
  return hexSha256.slice(0, length)
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 64)
}

export function computeWorkspaceId(workspaceDir: string, manifest: WorkspaceManifest | null): string {
  const base = slugify(
    manifest?.name?.trim()
      ? manifest.name
      : toPosixPath(dirname(resolve(workspaceDir))).endsWith('/')
      ? toPosixPath(workspaceDir).split('/').pop() ?? 'workspace'
      : toPosixPath(workspaceDir).split('/').pop() ?? 'workspace',
  )
  const salt = shortDigest(hashBufferSha256(Buffer.from(resolve(workspaceDir), 'utf8')))
  return `${base}-${salt}`
}

export function listWorkspaceFiles(workspaceDir: string): string[] {
  const root = resolve(workspaceDir)
  const results: string[] = []
  const skipNames = new Set<string>(['.genoffice', '.git', 'node_modules'])
  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir) as unknown as string[]
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, String(name))
      const rel = toPosixPath(relative(root, abs))
      const base = String(name)
      if (!rel || rel.startsWith('..')) continue
      if (skipNames.has(base)) continue
      // Ignore hidden dotfiles/folders at the root of workspace except .genoffice handled above
      if (rel.split('/').length === 1 && base.startsWith('.')) continue
      try {
        const st = lstatSync(abs)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          walk(abs)
        } else {
          results.push(rel)
        }
      } catch {
        // ignore entry
      }
    }
  }
  walk(root)
  return results.sort()
}

export async function buildSnapshotIndex(
  workspaceDir: string,
  manifest: WorkspaceManifest | null,
): Promise<{ index: SnapshotIndex; fileAbsByRel: Map<string, string> }> {
  const root = resolve(workspaceDir)
  const fileAbsByRel = new Map<string, string>()
  const paths = listWorkspaceFiles(workspaceDir)
  for (const rel of paths) fileAbsByRel.set(rel, join(root, rel))

  const manifestRel = toPosixPath(relative(root, manifestPath(workspaceDir)))
  if (existsSync(manifestPath(workspaceDir))) {
    if (!fileAbsByRel.has(manifestRel)) {
      fileAbsByRel.set(manifestRel, manifestPath(workspaceDir))
    }
  }

  const files: SnapshotFileEntry[] = []
  for (const [rel, abs] of fileAbsByRel) {
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(abs)
      size = st.size
      mtimeMs = Math.floor(st.mtimeMs)
    } catch {
      continue
    }
    const sha256 = await hashFileSha256(abs)
    files.push({ path: toPosixPath(rel), size, mtimeMs, sha256 })
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))

  // manifest digest and size
  const mPath = manifestPath(workspaceDir)
  const mSize = existsSync(mPath) ? statSync(mPath).size : 0
  const mSha = existsSync(mPath) ? await hashFileSha256(mPath) : hashBufferSha256(Buffer.alloc(0))

  const wsId = computeWorkspaceId(workspaceDir, manifest)
  const createdAt = new Date().toISOString()

  // preliminary index to derive overall hash and version
  const baseIndex = {
    schema: 'genoffice-workspace-snapshot@1' as const,
    workspace: { name: manifest?.name ?? 'Workspace', id: wsId },
    createdAt,
    version: '', // fill after hashing
    blobsBasePath: `genoffice/${wsId}/blobs/sha256`,
    files,
    manifest: { path: manifestRel, size: mSize, sha256: mSha },
    indexSha256: '', // fill after hashing
  }
  const payloadForHash = { ...baseIndex, version: '', indexSha256: '' }
  const indexSha256 = hashBufferSha256(Buffer.from(JSON.stringify(payloadForHash), 'utf8'))
  const version = shortDigest(indexSha256)
  const index: SnapshotIndex = { ...baseIndex, version, indexSha256 }
  return { index, fileAbsByRel }
}
