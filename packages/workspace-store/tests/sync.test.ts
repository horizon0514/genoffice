import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { initWorkspace } from '../src/store.js'
import { publishSnapshotToDufs, pullLatestSnapshotFromDufs, applySelectedFromMirror } from '../src/sync.js'

function saveBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

describe('dufs-like HTTP publish/pull', () => {
  let wsDir: string
  let remoteRoot: string
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeAll(async () => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'genoffice-remote-'))
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const rel = url.pathname.replace(/^\/+/, '')
      const path = join(remoteRoot, rel)
      if (req.method === 'PUT') {
        const data = await saveBody(req)
        await import('node:fs/promises').then(async (fs) => {
          await fs.mkdir(dirname(path), { recursive: true })
          await fs.writeFile(path, data)
        })
        res.statusCode = 200
        res.end('OK')
        return
      }
      if (req.method === 'GET') {
        try {
          const buf = readFileSync(path)
          res.statusCode = 200
          res.end(buf)
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
    const addr = server.address()
    if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(remoteRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'genoffice-ws-'))
  })
  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('publishes a snapshot and pulls into a mirror, then applies selection', async () => {
    writeFileSync(join(wsDir, 'doc1.md'), 'Hello world\n', 'utf8')
    initWorkspace(wsDir, 'HTTP Sync Test')

    const pub = await publishSnapshotToDufs({ workspaceDir: wsDir, baseUrl })
    expect(pub.ok).toBe(true)
    expect(pub.version).toBeTruthy()

    // Local change to produce a diff
    writeFileSync(join(wsDir, 'doc1.md'), 'Local change\n', 'utf8')

    // Pull
    const pull = await pullLatestSnapshotFromDufs({ workspaceDir: wsDir, baseUrl })
    expect(pull.ok).toBe(true)
    expect(pull.version).toBe(pub.version)
    expect(pull.mirrorDir && pull.mirrorDir.includes('.genoffice/mirror')).toBe(true)
    const changed = (pull.diff ?? []).filter((d) => d.kind === 'new' || d.kind === 'changed')
    expect(changed.length).toBeGreaterThanOrEqual(1)

    // Apply one file (doc1.md)
    const apply = await applySelectedFromMirror({ workspaceDir: wsDir, paths: ['doc1.md'] })
    expect(apply.ok).toBe(true)
    expect(apply.applied).toBe(1)
  })
})
