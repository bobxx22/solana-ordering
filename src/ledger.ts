// Spend cap enforced in code. Every live transaction reserves its maximum possible fee before it is sent; the
// reservation is later settled to the fee actually charged (or to zero when the transaction expired unlanded).
// The ledger is an append-only JSONL file, so the total survives restarts and is auditable.
import { appendJsonl, readJsonl } from './util.ts'

export class CapExceeded extends Error {}

interface Entry {
  t: string
  kind: 'reserve' | 'settle'
  signature: string
  lamports: string
  what?: string
}

export class Ledger {
  readonly file: string
  readonly cap: bigint
  private reserved = new Map<string, bigint>()
  private settled = new Map<string, bigint>()

  constructor(file: string, cap: bigint) {
    this.file = file
    this.cap = cap
    for (const e of readJsonl<Entry>(file)) {
      if (e.kind === 'reserve') this.reserved.set(e.signature, BigInt(e.lamports))
      else this.settled.set(e.signature, BigInt(e.lamports))
    }
  }

  /** Settled fees plus every reservation still open. */
  committed(): bigint {
    let sum = 0n
    for (const [sig, v] of this.reserved) sum += this.settled.get(sig) ?? v
    for (const [sig, v] of this.settled) if (!this.reserved.has(sig)) sum += v
    return sum
  }

  remaining(): bigint {
    return this.cap - this.committed()
  }

  /** Reserves all or nothing; throws CapExceeded if the batch would pass the cap. */
  reserve(items: { signature: string; lamports: bigint; what: string }[]): void {
    const add = items.reduce((s, i) => s + i.lamports, 0n)
    if (this.committed() + add > this.cap) throw new CapExceeded(`spend cap reached: committed ${this.committed()} + ${add} > cap ${this.cap} lamports`)
    for (const i of items) {
      this.reserved.set(i.signature, i.lamports)
      appendJsonl(this.file, { t: new Date().toISOString(), kind: 'reserve', signature: i.signature, lamports: i.lamports.toString(), what: i.what })
    }
  }

  isOpen(signature: string): boolean {
    return this.reserved.has(signature) && !this.settled.has(signature)
  }

  settle(signature: string, lamports: bigint): void {
    if (this.settled.get(signature) === lamports) return
    this.settled.set(signature, lamports)
    appendJsonl(this.file, { t: new Date().toISOString(), kind: 'settle', signature, lamports: lamports.toString() })
  }

  openSignatures(): string[] {
    return [...this.reserved.keys()].filter((s) => !this.settled.has(s))
  }
}
