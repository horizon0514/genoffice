import { basename } from 'node:path'

export interface BasicAuth {
  user: string
  password?: string
}

export interface DufsEntry {
  name: string
  isDir: boolean
  /** Milliseconds since epoch */
  mtime: number
  size: number
}

export class DufsClient {
  private baseUrl: string
  private auth?: BasicAuth

  constructor(baseUrl: string, auth?: BasicAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.auth = auth
  }

  url(pathRel: string): string {
    const clean = pathRel.replace(/^\/+/, '')
    return `${this.baseUrl}/${clean}`
  }

  private headers(contentType?: string): HeadersInit {
    const h: Record<string, string> = {}
    if (contentType) h['Content-Type'] = contentType
    if (this.auth?.user) {
      const token = Buffer.from(`${this.auth.user}:${this.auth.password ?? ''}`, 'utf8').toString(
        'base64',
      )
      h['Authorization'] = `Basic ${token}`
    }
    return h
  }

  async put(pathRel: string, body: Uint8Array | string, contentType: string): Promise<void> {
    const res = await fetch(this.url(pathRel), {
      method: 'PUT',
      headers: this.headers(contentType),
      body: typeof body === 'string' ? body : Buffer.from(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`PUT ${basename(pathRel)} failed: ${res.status} ${text}`)
    }
  }

  async putJson(pathRel: string, obj: unknown): Promise<void> {
    const raw = JSON.stringify(obj, null, 2)
    await this.put(pathRel, raw, 'application/json')
  }

  async get(pathRel: string): Promise<Uint8Array> {
    const res = await fetch(this.url(pathRel), { method: 'GET', headers: this.headers() })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GET ${basename(pathRel)} failed: ${res.status} ${text}`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf
  }

  /** GET a file, returning null when it does not exist. */
  async tryGet(pathRel: string): Promise<Uint8Array | null> {
    const res = await fetch(this.url(pathRel), { method: 'GET', headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GET ${basename(pathRel)} failed: ${res.status} ${text}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  async getText(pathRel: string): Promise<string> {
    return Buffer.from(await this.get(pathRel)).toString('utf8')
  }

  /**
   * List a directory using dufs' JSON listing (`GET <dir>/?json`).
   * Returns an empty array when the directory does not exist yet.
   */
  async listDir(pathRel = ''): Promise<DufsEntry[]> {
    const clean = pathRel.replace(/^\/+|\/+$/g, '')
    const target = clean ? `${this.url(clean)}/?json` : `${this.baseUrl}/?json`
    const res = await fetch(target, { method: 'GET', headers: this.headers() })
    if (res.status === 404) return []
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LIST ${clean || '/'} failed: ${res.status} ${text}`)
    }
    const body = (await res.json()) as {
      paths?: Array<{
        name?: unknown
        path_type?: unknown
        mtime?: unknown
        size?: unknown
      }>
    }
    if (!Array.isArray(body.paths)) return []
    return body.paths.flatMap((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (!name) return []
      return [
        {
          name,
          isDir: entry.path_type === 'Dir',
          mtime: typeof entry.mtime === 'number' ? entry.mtime : 0,
          size: typeof entry.size === 'number' ? entry.size : 0,
        },
      ]
    })
  }
}
