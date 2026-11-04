import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyHandoff,
  downloadHandoff,
  listHandoffs,
  publishHandoff,
  safeRelativePath,
} from '../src/index.js'

function saveBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeManifest(dir: string, projectId: string, projectName: string): void {
  mkdirSync(join(dir, '.genoffice'), { recursive: true })
  writeFileSync(
    join(dir, '.genoffice', 'workspace.json'),
    JSON.stringify(
      {
        name: projectName,
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:00:00.000Z',
        rzSystem: { projectIds: [projectId], lastSyncAt: '2026-11-04T00:00:00.000Z' },
        members: [],
        projects: [{ id: projectId, name: projectName, files: [] }],
      },
      null,
      2,
    ),
    'utf8',
  )
}

describe('handoff packages', () => {
  let remoteRoot: string
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  const tempDirs: string[] = []

  beforeAll(async () => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'genoffice-handoff-remote-'))
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const path = join(remoteRoot, rel)
      if (!path.startsWith(remoteRoot)) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }
      if (req.method === 'PUT') {
        const body = await saveBody(req)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, body)
        res.statusCode = 200
        res.end('OK')
        return
      }
      if (req.method === 'GET' && url.searchParams.has('json')) {
        try {
          const entries = readdirSync(path, { withFileTypes: true })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              kind: 'Index',
              paths: entries.map((entry) => ({
                name: entry.name,
                path_type: entry.isDirectory() ? 'Dir' : 'File',
                mtime: 1762200000000,
                size: entry.isDirectory() ? null : 1,
              })),
            }),
          )
        } catch {
          res.statusCode = 404
          res.end('Not found')
        }
        return
      }
      if (req.method === 'GET') {
        try {
          res.statusCode = 200
          res.end(readFileSync(path))
        } catch {
          res.statusCode = 404
          res.end('Not found')
        }
        return
      }
      res.statusCode = 405
      res.end('Method Not Allowed')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(remoteRoot, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('publishes, lists, downloads and applies a handoff', async () => {
    const authorDir = mkdtempSync(join(tmpdir(), 'genoffice-handoff-author-'))
    const reviewerDir = mkdtempSync(join(tmpdir(), 'genoffice-handoff-reviewer-'))
    tempDirs.push(authorDir, reviewerDir)
    writeManifest(authorDir, '921', '核与辐射安全及污染防治')
    writeManifest(reviewerDir, '921', '核与辐射安全及污染防治')
    writeFileSync(join(authorDir, '报告.docx'), 'v1', 'utf8')
    writeFileSync(join(reviewerDir, '报告.docx'), 'v0', 'utf8')
    writeFileSync(join(reviewerDir, '旧文件.docx'), 'old', 'utf8')

    const published = await publishHandoff({
      workspaceDir: authorDir,
      filesBaseUrl: baseUrl,
      projectId: '921',
      authorName: '黄思远',
      note: '初稿完成',
      handoffId: '20261104-120000-test',
      now: new Date('2026-11-04T04:00:00.000Z'),
    })
    expect(published.ok).toBe(true)
    expect(published.fileCount).toBe(1)
    expect(
      readdirSync(join(remoteRoot, 'genoffice/projects/921/handoffs/20261104-120000-test')),
    ).toContain('manifest.json')

    const list = await listHandoffs({ filesBaseUrl: baseUrl, projectId: '921' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: '20261104-120000-test',
      authorName: '黄思远',
      note: '初稿完成',
    })

    const downloaded = await downloadHandoff({
      workspaceDir: reviewerDir,
      filesBaseUrl: baseUrl,
      projectId: '921',
      handoffId: '20261104-120000-test',
    })
    expect(downloaded.ok).toBe(true)
    const kinds = Object.fromEntries(
      (downloaded.diff ?? []).map((entry) => [entry.path, entry.kind]),
    )
    expect(kinds['报告.docx']).toBe('changed')

    const applied = applyHandoff({
      workspaceDir: reviewerDir,
      handoffId: '20261104-120000-test',
      paths: ['报告.docx'],
    })
    expect(applied).toEqual({ ok: true, applied: 1 })
    expect(readFileSync(join(reviewerDir, '报告.docx'), 'utf8')).toBe('v1')
    expect(readFileSync(join(reviewerDir, '旧文件.docx'), 'utf8')).toBe('old')
  })

  it('rejects traversal paths from remote manifests', () => {
    expect(safeRelativePath('a/b.docx')).toBe('a/b.docx')
    expect(safeRelativePath('../evil.docx')).toBeNull()
    expect(safeRelativePath('/etc/passwd')).toBeNull()
    expect(safeRelativePath('a/../../b.docx')).toBeNull()
  })
})
