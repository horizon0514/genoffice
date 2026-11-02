import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FixtureRzClient,
  importRzSystemIntoWorkspace,
  loadWorkspace,
  manifestPath,
} from '../src/index.js'

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'))
  return dir
}

describe('workspace-store rz import (fixtures)', () => {
  let wsDir: string
  beforeEach(() => {
    wsDir = makeTmpDir()
  })
  it('creates a manifest and records rz projects', async () => {
    const client = new FixtureRzClient(join(__dirname, '../fixtures/rz'))
    const res = await importRzSystemIntoWorkspace({ workspaceDir: wsDir, client })
    expect(res.projects).toBeGreaterThan(0)
    const manifest = loadWorkspace(wsDir)!
    expect(manifest).toBeTruthy()
    expect(manifest.projects.length).toBe(res.projects)
    expect(manifest.rzSystem?.projectIds?.length).toBe(res.projects)
    expect(manifest.rzSystem?.importedAt).toBeTruthy()
  })
  it('keeps relative file links as relative', () => {
    // sanity check: a manual manifest write keeps relative paths; import sets none
    const path = manifestPath(wsDir)
    mkdirSync(require('node:path').dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          name: 'X',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          members: [],
          projects: [{ id: 'p1', name: 'P1', files: ['docs/spec.docx'] }],
        },
        null,
        2,
      ),
      'utf8',
    )
    const manifest = loadWorkspace(wsDir)!
    expect(manifest.projects[0]?.files[0]).toBe('docs/spec.docx')
  })
  it('is idempotent on repeated imports', async () => {
    const client = new FixtureRzClient(join(__dirname, '../fixtures/rz'))
    const a = await importRzSystemIntoWorkspace({ workspaceDir: wsDir, client })
    const b = await importRzSystemIntoWorkspace({ workspaceDir: wsDir, client })
    expect(a.projects).toBe(b.projects)
    const manifest = loadWorkspace(wsDir)!
    expect(new Set(manifest.projects.map((p) => p.id)).size).toBe(manifest.projects.length)
  })
  afterEach(() => {
    try {
      rmSync(wsDir, { recursive: true, force: true })
    } catch {}
  })
})
