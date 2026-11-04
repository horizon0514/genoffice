import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HttpRzClient,
  loadWorkspace,
  parseRzProject,
  resolveRzFileUrl,
  syncRzProjectsToWorkspace,
} from '../src/index.js'

type Call = { url: string; init?: RequestInit }

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function rawProject() {
  return {
    id: 13,
    name: '交通建设绩效评价',
    projectCode: 'PERF-DEMO-12',
    status: 'doing',
    client: '绩效演示单位',
    ownerName: '陈晨',
    assistantNames: ['张三'],
    taskId: 1,
    updatedAt: '2026-11-03T02:35:00.000Z',
    processResults: [
      {
        key: 'draft',
        name: '报告初稿',
        files: [{ fileName: '绩效评价演示报告.pdf', fileUrl: '/PERF-DEMO-12/demo.pdf' }],
        adminFiles: [{ fileName: '审核稿.pdf', fileUrl: '/PERF-DEMO-12/admin/review.pdf' }],
      },
    ],
    finalResults: [],
    coreResults: [],
    task: {
      id: 1,
      name: '某某市财政局绩效评价',
      status: 0,
      ownerName: '张三',
      memberIds: [3, 2],
    },
  }
}

describe('HttpRzClient', () => {
  it('logs in, captures the session cookie, and maps real getProjects rows', async () => {
    const calls: Call[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v2/auth/login')) {
        return jsonResponse(
          { id: 38, name: 'GenOffice Demo', email: 'genoffice-demo', role: 'SUPER_ADMIN' },
          { headers: { 'set-cookie': 'rz-system-session=dummy-session; Path=/; HttpOnly' } },
        )
      }
      if (url.endsWith('/api/v2/project/getProjects')) {
        const cookie = (init?.headers as Record<string, string> | undefined)?.cookie
        if (!cookie) return new Response('{"error":"unauthorized"}', { status: 401 })
        return jsonResponse({ projects: [rawProject()], hasMore: false, nextPage: null, count: 1 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const client = new HttpRzClient({
      baseUrl: 'http://localhost:3000',
      email: 'genoffice-demo',
      password: '123456',
      fetchImpl,
    })
    const projects = await client.listProjects()

    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      id: '13',
      name: '交通建设绩效评价',
      projectCode: 'PERF-DEMO-12',
      status: 'doing',
      taskName: '某某市财政局绩效评价',
      taskUrl: 'http://localhost:3000/task/detail?taskId=1',
    })
    expect(projects[0]!.stages[0]!.files[0]).toEqual({
      fileName: '绩效评价演示报告.pdf',
      fileUrl: '/PERF-DEMO-12/demo.pdf',
    })
    expect(client.getSessionCookie()).toBe('rz-system-session=dummy-session')
    const rpcCall = calls.find(
      (c) => c.url.endsWith('/project/getProjects') && (c.init?.headers as any)?.cookie,
    )
    expect(rpcCall).toBeTruthy()
    const body = JSON.parse(String(rpcCall!.init!.body)) as Record<string, unknown>
    expect(body).toMatchObject({ take: 200, include: { task: true } })
  })

  it('resolves relative dufs URLs, including Chinese file names', () => {
    expect(resolveRzFileUrl('http://127.0.0.1:5100', '/PERF-DEMO-12/报告.pdf')).toBe(
      'http://127.0.0.1:5100/PERF-DEMO-12/%E6%8A%A5%E5%91%8A.pdf',
    )
    expect(resolveRzFileUrl('http://127.0.0.1:5100/', 'absolute.pdf')).toBe(
      'http://127.0.0.1:5100/absolute.pdf',
    )
  })
})

describe('syncRzProjectsToWorkspace', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('downloads attachments, records metadata, and never overwrites local edits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rz-sync-'))
    const project = parseRzProject(rawProject(), 'http://localhost:3000')!
    let fileRequests = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/PERF-DEMO-12/demo.pdf')) {
        fileRequests += 1
        return new Response(new Uint8Array([37, 80, 68, 70]))
      }
      if (url.endsWith('/PERF-DEMO-12/admin/review.pdf')) {
        fileRequests += 1
        return new Response(new Uint8Array([82, 69, 86]))
      }
      return new Response('missing', { status: 404 })
    }) as typeof fetch

    const client = {
      listProjects: async () => [project],
      listTasks: async () => [],
    }
    const result = await syncRzProjectsToWorkspace({
      workspaceDir: dir,
      client,
      projects: [project],
      filesBaseUrl: 'http://127.0.0.1:5100',
      fetchImpl,
    })

    expect(result).toMatchObject({ downloaded: 2, skipped: 0, failed: 0, projects: 1 })
    const draft = join(dir, 'PERF-DEMO-12', 'files', 'draft', '绩效评价演示报告.pdf')
    const admin = join(dir, 'PERF-DEMO-12', 'admin', 'draft', '审核稿.pdf')
    expect(readFileSync(draft)).toEqual(Buffer.from([37, 80, 68, 70]))
    expect(readFileSync(admin)).toEqual(Buffer.from([82, 69, 86]))

    const manifest = loadWorkspace(dir)!
    expect(manifest.projects[0]).toMatchObject({
      id: '13',
      name: '交通建设绩效评价',
      projectCode: 'PERF-DEMO-12',
      status: 'doing',
      taskId: '1',
      ownerName: '陈晨',
      url: 'http://localhost:3000/task/detail?taskId=1',
    })
    expect(manifest.projects[0]!.files).toHaveLength(2)
    expect(manifest.members.map((m) => m.name).sort()).toEqual(['张三', '陈晨'].sort())
    expect(manifest.rzSystem?.lastSyncAt).toBeTruthy()

    // Local edits stay put; a re-sync only reports the skip.
    writeFileSync(draft, 'local edit', 'utf8')
    const second = await syncRzProjectsToWorkspace({
      workspaceDir: dir,
      client,
      projects: [project],
      filesBaseUrl: 'http://127.0.0.1:5100',
      fetchImpl,
    })
    expect(second).toMatchObject({ downloaded: 0, skipped: 2, failed: 0 })
    expect(readFileSync(draft, 'utf8')).toBe('local edit')
    expect(fileRequests).toBe(2)
  })
})
