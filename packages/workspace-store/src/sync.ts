import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { DufsClient, type BasicAuth } from './dufs-client.js'
import { buildSnapshotIndex, hashFileSha256 } from './snapshot.js'
import { loadWorkspace, manifestPath } from './store.js'
import type { FileDiff, PullResult, PublishResult, SnapshotIndex } from './types.js'

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function mirrorRoot(workspaceDir: string, workspaceId: string): string {
  return join(workspaceDir, '.genoffice', 'mirror', workspaceId)
}

export interface PublishOptions {
  workspaceDir: string
  baseUrl: string
  auth?: BasicAuth
}

export interface PullOptions {
  workspaceDir: string
  baseUrl: string
  auth?: BasicAuth
}

export async function publishSnapshotToDufs(opts: PublishOptions): Promise<PublishResult> {
  try {
    const manifest = loadWorkspace(opts.workspaceDir)
    const { index, fileAbsByRel } = await buildSnapshotIndex(opts.workspaceDir, manifest)
    const client = new DufsClient(opts.baseUrl, opts.auth)
    const wsPath = `genoffice/${index.workspace.id}`
    const indexRelPath = `${wsPath}/snapshots/${index.version}/index.json`
    // Upload blobs (content-addressed)
    for (const file of index.files) {
      const abs = fileAbsByRel.get(file.path)
      if (!abs) continue
      const blobRel = `${index.blobsBasePath}/${file.sha256}`
      const buf = readFileSync(abs)
      await client.put(blobRel, buf, 'application/octet-stream')
    }
    // Upload index
    await client.putJson(indexRelPath, index)
    // Update latest pointer
    const latestRel = `${wsPath}/latest.json`
    await client.putJson(latestRel, {
      version: index.version,
      indexPath: `snapshots/${index.version}/index.json`,
      createdAt: index.createdAt,
    })
    return { ok: true, version: index.version, indexPath: indexRelPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchLatestIndex(
  baseUrl: string,
  auth: BasicAuth | undefined,
  workspaceId: string,
): Promise<SnapshotIndex> {
  const client = new DufsClient(baseUrl, auth)
  const latestRel = `genoffice/${workspaceId}/latest.json`
  const latestRaw = await client.get(latestRel)
  const latest = JSON.parse(Buffer.from(latestRaw).toString('utf8')) as {
    version: string
    indexPath: string
  }
  const indexRel = `genoffice/${workspaceId}/${latest.indexPath.replace(/^\/+/, '')}`
  const indexBuf = await client.get(indexRel)
  const index = JSON.parse(Buffer.from(indexBuf).toString('utf8')) as SnapshotIndex
  return index
}

async function computeLocalMap(workspaceDir: string): Promise<Map<string, { size: number; sha256: string }>> {
  const map = new Map<string, { size: number; sha256: string }>()
  // Read the latest manifest to anchor relative paths, but we include any file present in the index
  const root = resolve(workspaceDir)
  return map
}

function latestMirrorPointerPath(workspaceDir: string, id: string): string {
  return join(mirrorRoot(workspaceDir, id), 'latest.json')
}

export async function pullLatestSnapshotFromDufs(opts: PullOptions): Promise<PullResult> {
  try {
    const manifest = loadWorkspace(opts.workspaceDir)
    const wsId =
      manifest?.name && manifest?.name.trim()
        ? `${manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')}-${Buffer.from(
            resolve(opts.workspaceDir),
          )
            .toString('hex')
            .slice(0, 8)}`
        : // fall back to recomputing through the snapshot path (guaranteed consistent)
          undefined
    // We don't recompute id here; use the index-provided one to avoid drift
    // Fetch index
    // If wsId unknown, we can try both strategies: read local manifest then compute; but fetchLatestIndex requires id.
    // Use computed id from current manifest name + directory hash as in snapshot builder.
    const { index } = await buildSnapshotIndex(opts.workspaceDir, manifest)
    const workspaceId = index.workspace.id
    const remoteIndex = await fetchLatestIndex(opts.baseUrl, opts.auth, workspaceId)
    const version = remoteIndex.version
    // Prepare mirror dir
    const mRoot = mirrorRoot(opts.workspaceDir, workspaceId)
    const mDir = join(mRoot, version)
    ensureDir(mDir)
    ensureDir(join(mDir, 'files'))
    // Save index
    writeFileSync(join(mDir, 'index.json'), JSON.stringify(remoteIndex, null, 2), 'utf8')
    writeFileSync(
      latestMirrorPointerPath(opts.workspaceDir, workspaceId),
      JSON.stringify({ version, dir: mDir }, null, 2),
      'utf8',
    )
    // Download all files into mirror/files/<relpath>
    const client = new DufsClient(opts.baseUrl, opts.auth)
    for (const f of remoteIndex.files) {
      const blobRel = `${remoteIndex.blobsBasePath}/${f.sha256}`
      const data = await client.get(blobRel)
      const out = join(mDir, 'files', f.path)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, data)
    }
    // Compute diff vs local
    const diffs: FileDiff[] = []
    for (const f of remoteIndex.files) {
      const localAbs = join(opts.workspaceDir, f.path)
      if (!existsSync(localAbs)) {
        diffs.push({ kind: 'new', path: f.path, local: null, remote: { size: f.size, sha256: f.sha256 } })
      } else {
        const localHash = await hashFileSha256(localAbs)
        if (localHash !== f.sha256) {
          const sz = (() => {
            try {
              return statSync(localAbs).size
            } catch {
              return 0
            }
          })()
          diffs.push({
            kind: 'changed',
            path: f.path,
            local: { size: sz, sha256: localHash },
            remote: { size: f.size, sha256: f.sha256 },
          })
        } else {
          diffs.push({
            kind: 'unchanged',
            path: f.path,
            local: { size: f.size, sha256: f.sha256 },
            remote: { size: f.size, sha256: f.sha256 },
          })
        }
      }
    }
    // Deletions: files present locally but missing remotely
    // We only consider paths that exist locally under the same rel path set
    // Build a quick set for membership test
    const remotePaths = new Set(remoteIndex.files.map((f) => f.path))
    for (const rel of remotePaths) {
      // already covered
    }
    // Now scan local for extra files that are not in remote
    for (const rel of remotePaths) {
      // no-op
    }
    // A simple pass: iterate over diffs only from remote; deletions are not included in MVP
    return { ok: true, version, diff: diffs, mirrorDir: mDir }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function applySelectedFromMirror(opts: {
  workspaceDir: string
  /** Paths relative to workspace root, selected by user */
  paths: string[]
}): Promise<{ ok: boolean; applied: number; error?: string }> {
  try {
    // Load latest mirror pointer
    const manifest = loadWorkspace(opts.workspaceDir)
    const { index } = await buildSnapshotIndex(opts.workspaceDir, manifest)
    const workspaceId = index.workspace.id
    const latestPtrPath = latestMirrorPointerPath(opts.workspaceDir, workspaceId)
    const raw = JSON.parse(readFileSync(latestPtrPath, 'utf8')) as { version: string; dir: string }
    const mDir = raw.dir
    let applied = 0
    for (const rel of opts.paths) {
      const safeRel = toPosix(rel).replace(/^\/+/, '')
      const from = join(mDir, 'files', safeRel)
      const to = join(opts.workspaceDir, safeRel)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      applied++
    }
    return { ok: true, applied }
  } catch (err) {
    return { ok: false, applied: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
