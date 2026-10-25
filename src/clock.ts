// Follows the slot the cluster is producing right now. The earliest signal an RPC node offers is the
// `firstShredReceived` event of slotsUpdatesSubscribe: the node has begun receiving that slot's block, so its leader
// is producing it. Plain slotSubscribe reports a slot only after the node has processed it (about a slot later),
// so it is the fallback, and getSlot polling the last resort.
import { Rpc } from './rpc.ts'
import { sleep } from './util.ts'

export type ClockSource = 'firstShred' | 'slotNotification' | 'poll'

export class SlotClock {
  slot = 0
  /** Date.now() when `slot` was observed */
  seenAt = 0
  source: ClockSource = 'poll'
  /** when each recent slot was first observed (Date.now()), for the arrival margin of buffered bursts */
  readonly seen = new Map<number, number>()
  private rpc: Rpc
  private ws: WebSocket | undefined
  private stopped = false

  constructor(rpc: Rpc) {
    // a private client, so that polling never queues behind other requests
    this.rpc = new Rpc(rpc.url, { minGapMs: 0, retries: 1, timeoutMs: 5_000 })
  }

  private observe(slot: number, source: ClockSource): void {
    if (slot > this.slot) {
      this.slot = slot
      this.seenAt = Date.now()
      this.source = source
      this.seen.set(slot, this.seenAt)
      if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value!)
    }
  }

  async start(): Promise<void> {
    this.observe(await this.rpc.call<number>('getSlot', [{ commitment: 'processed' }]), 'poll')
    this.subscribe()
    void this.pollWhenQuiet()
  }

  /** Opens the websocket; reconnects a second after it closes for any reason. */
  private subscribe(): void {
    if (this.stopped) return
    try {
      const ws = new WebSocket(this.rpc.url.replace(/^http/, 'ws'))
      this.ws = ws
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotsUpdatesSubscribe' }))
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data))
          if (m.id === 1 && m.error) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slotSubscribe' }))
          else if (m.method === 'slotsUpdatesNotification' && m.params.result.type === 'firstShredReceived') this.observe(m.params.result.slot, 'firstShred')
          else if (m.method === 'slotNotification') this.observe(m.params.result.slot, 'slotNotification')
        } catch {}
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        if (!this.stopped) setTimeout(() => this.subscribe(), 1000)
      }
    } catch {
      if (!this.stopped) setTimeout(() => this.subscribe(), 1000)
    }
  }

  /** Polls only while the websocket has been silent for more than 600 ms (three slots). */
  private async pollWhenQuiet(): Promise<void> {
    while (!this.stopped) {
      await sleep(200)
      if (Date.now() - this.seenAt > 600) {
        try {
          this.observe(await this.rpc.call<number>('getSlot', [{ commitment: 'processed' }]), 'poll')
        } catch {}
      }
    }
  }

  async waitFor(slot: number, timeoutMs = 120_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (this.slot < slot) {
      if (Date.now() > until) throw new Error(`slot ${slot} not seen within ${timeoutMs} ms (at ${this.slot})`)
      await sleep(2)
    }
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
  }
}

/** Keeps a recent blockhash at hand so that signing right before dispatch needs no round trip. */
export class BlockhashCache {
  blockhash = ''
  /** last block height at which a transaction with this blockhash can still land */
  lastValidBlockHeight = 0
  fetchedAt = 0
  private rpc: Rpc
  private stopped = false

  constructor(rpc: Rpc) {
    this.rpc = rpc
  }

  async start(): Promise<void> {
    await this.refresh()
    void (async () => {
      while (!this.stopped) {
        await sleep(2000)
        try {
          await this.refresh()
        } catch {}
      }
    })()
  }

  private async refresh(): Promise<void> {
    const { value } = await this.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }])
    this.blockhash = value.blockhash
    this.lastValidBlockHeight = value.lastValidBlockHeight
    this.fetchedAt = Date.now()
  }

  stop(): void {
    this.stopped = true
  }
}
