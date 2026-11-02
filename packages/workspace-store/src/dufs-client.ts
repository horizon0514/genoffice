import { basename } from 'node:path'

export interface BasicAuth {
  user: string
  password?: string
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
}
