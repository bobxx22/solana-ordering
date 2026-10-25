// Direct delivery to the leader: drives py/tpu_sender.py (QUIC, ALPN "solana-tpu") over JSON lines.
// Node has no QUIC client, so this one piece is Python (aioquic); it receives only already-signed transactions.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export function pythonPath(): string {
  if (process.env.PYTHON) return process.env.PYTHON
  for (const p of [join('.venv', 'Scripts', 'python.exe'), join('.venv', 'bin', 'python')]) if (existsSync(p)) return p
  return process.platform === 'win32' ? 'python' : 'python3'
}

export interface SendResult {
  ok: boolean
  error?: string
  /** wall-clock nanoseconds (as strings) when each transaction was handed to the socket */
  sentNs?: string[]
  /** when the leader's QUIC stack acknowledged each transaction; null = no acknowledgement within 1.5 s */
  ackNs?: (string | null)[]
  /** the stream had to wait for stream credit, so it left later than sentNs */
  blocked?: boolean[]
  state?: string
  /** set when a connection the peer had closed was reopened before sending: the close state and reason */
  reconnected?: string | null
}

export class TpuSender {
  private child: ChildProcessWithoutNullStreams
  private next = 1
  private pending = new Map<number, (r: any) => void>()
  private closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false
  /** the Python process exited (a run must not go on without its sender) */
  exited = false

  constructor() {
    this.child = spawn(pythonPath(), [join('py', 'tpu_sender.py')], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const r = JSON.parse(line)
        this.pending.get(r.id)?.(r)
        this.pending.delete(r.id)
      } catch {}
    })
    this.child.stderr.on('data', (d) => process.stderr.write(`[tpu] ${d}`))
    this.child.on('exit', () => {
      this.exited = true
      this.stopped = true
      for (const [id, done] of this.pending) done({ id, ok: false, error: 'QUIC sender exited' })
      this.pending.clear()
    })
  }

  private request(op: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
    if (this.stopped) return Promise.resolve({ ok: false, error: 'QUIC sender stopped' })
    const id = this.next++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ id, ok: false, error: `timeout after ${timeoutMs} ms` })
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.child.stdin.write(JSON.stringify({ id, ...op }) + '\n')
    })
  }

  /** Opens (or reopens) a QUIC connection to a TPU address host:port; resolves with the handshake time. */
  connect(addr: string): Promise<{ ok: boolean; handshakeMs?: number; error?: string }> {
    this.cancelClose(addr)
    return this.request({ op: 'connect', addr })
  }

  /** Writes each transaction on its own stream, `gapMs` apart, and waits for the acknowledgements. */
  send(addr: string, txs: string[], gapMs: number): Promise<SendResult> {
    this.cancelClose(addr)
    return this.request({ op: 'send', addr, txs, gapMs })
  }

  /** Closes the connection after `delayMs`, unless the same address is used again before that. */
  closeLater(addr: string, delayMs = 1500): void {
    this.cancelClose(addr)
    const t = setTimeout(() => {
      this.closeTimers.delete(addr)
      void this.request({ op: 'close', addr })
    }, delayMs)
    t.unref()
    this.closeTimers.set(addr, t)
  }

  private cancelClose(addr: string): void {
    const t = this.closeTimers.get(addr)
    if (t) clearTimeout(t)
    this.closeTimers.delete(addr)
  }

  async ready(): Promise<boolean> {
    return (await this.request({ op: 'ping' }, 20_000)).ok
  }

  stop(): void {
    for (const t of this.closeTimers.values()) clearTimeout(t)
    this.closeTimers.clear()
    this.stopped = true
    this.child.stdin.end()
  }
}
