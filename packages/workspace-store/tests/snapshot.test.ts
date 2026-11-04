import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initWorkspace } from '../src/store.js'
import { buildSnapshotIndex, computeWorkspaceId } from '../src/snapshot.js'

describe('workspace snapshot index', () => {
  let wsDir: string
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'genoffice-ws-'))
  })
  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('hashes files and includes manifest', async () => {
    writeFileSync(join(wsDir, 'a.md'), '# A\n', 'utf8')
    writeFileSync(join(wsDir, 'b.txt'), 'hello', 'utf8')
    const manifest = initWorkspace(wsDir, 'Demo Workspace')
    const { index } = await buildSnapshotIndex(wsDir, manifest)
    expect(index.schema).toBe('genoffice-workspace-snapshot@1')
    expect(index.workspace.name).toBe('Demo Workspace')
    expect(index.version).toMatch(/^[0-9a-f]{8}$/)
    // at least 3 files (2 + manifest)
    expect(index.files.length).toBeGreaterThanOrEqual(3)
    const manifestEntry = index.files.find((f) => f.path.endsWith('.genoffice/workspace.json'))
    expect(manifestEntry?.sha256).toBe(index.manifest.sha256)
  })

  it('produces a stable workspace id for the same folder', async () => {
    initWorkspace(wsDir, 'My WS')
    const { index } = await buildSnapshotIndex(wsDir, null)
    const id1 = index.workspace.id
    const { index: index2 } = await buildSnapshotIndex(wsDir, null)
    const id2 = index2.workspace.id
    expect(id1).toBe(id2)
  })
})
