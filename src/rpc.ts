// Small JSON-RPC client over fetch: timeouts, retries on 429/5xx, and a minimum gap between requests
// so that the free public endpoints are not hammered.
export class RpcError extends Error {
  code: number
  data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export interface RpcOptions {
  /** minimum milliseconds between two requests to this endpoint */
  minGapMs?: number
  timeoutMs?: number
  retries?: number
}

export class Rpc {
  readonly url: string
  private minGapMs: number
  private timeoutMs: number
  private retries: number
  private next = 0
  private id = 0

  constructor(url: string, opts: RpcOptions = {}) {
    this.url = url
    this.minGapMs = opts.minGapMs ?? 120
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.retries = opts.retries ?? 4
  }

  /** The endpoint with any API key in the query string masked, for logs. */
  get label(): string {
    try {
      const u = new URL(this.url)
      for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***')
      return u.toString()
    } catch {
      return '(invalid url)'
    }
  }

  private async pace(): Promise<void> {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.minGapMs
    if (at > now) await new Promise((r) => setTimeout(r, at - now))
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.pace()
      let res: Response
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        if (attempt >= this.retries) throw e
        await backoff(attempt)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        await backoff(attempt, Number(res.headers.get('retry-after')) * 1000 || 0)
        continue
      }
      const text = await res.text()
      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`${method}: HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      if (body.error) throw new RpcError(body.error.code, `${method}: ${body.error.message}`, body.error.data)
      return body.result as T
    }
  }
}

function backoff(attempt: number, atLeastMs = 0): Promise<void> {
  const ms = Math.max(atLeastMs, 500 * 2 ** attempt + Math.random() * 250)
  return new Promise((r) => setTimeout(r, ms))
}
