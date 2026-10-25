// Spend cap enforced in code. Every live transaction reserves its maximum possible fee before it is sent; the
// reservation is settled to the fee actually charged once the transaction is found on chain, or to zero only once
// its blockhash has provably expired without it landing. The ledger is an append-only JSONL file, so the total
// survives restarts and is auditable.
//
// A process that sends holds an exclusive lock on the ledger (a lock file created with O_EXCL), so two live
// processes can never both spend against the same cap.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { appendJsonl, readJsonl } from './util.ts'

export class CapExceeded extends Error {}

/**
 * Part of the cap kept back for returning the sub-payers' balances to the main wallet: a run stops before eating it,
 * so `sweep` can always pay its own fees.
 */
export const SWEEP_ALLOWANCE = 100_000n

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
  private lockFile: string | null = null

  /** Reserves and their reservation times, needed to settle reservations nobody else knows about. */
  readonly reservedAt = new Map<string, string>()

  constructor(file: string, cap: bigint) {
    this.file = file
    this.cap = cap
    this.load()
  }

  private load(): void {
    this.reserved.clear()
    this.settled.clear()
    for (const e of readJsonl<Entry>(this.file)) {
      if (e.kind === 'reserve') {
        this.reserved.set(e.signature, BigInt(e.lamports))
        this.reservedAt.set(e.signature, e.t)
      } else this.settled.set(e.signature, BigInt(e.lamports))
    }
  }

  /**
   * Takes the exclusive lock needed for spending, then re-reads the ledger, so that whatever another process wrote
   * before the lock is counted. A stale lock is taken over only when it was written on this host by a process that
   * no longer exists; a lock from another host or container must be removed by hand.
   */
  lock(): this {
    const lockFile = this.file + '.lock'
    const me = `${hostname()} ${process.pid}`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockFile, 'wx')
        writeSync(fd, me)
        closeSync(fd)
        this.lockFile = lockFile
        process.once('exit', () => this.unlock())
        this.load()
        return this
      } catch {
        const [host, pidText] = (existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : '').split(' ')
        const pid = Number(pidText)
        if (host !== hostname()) throw new Error(`the spend ledger is locked by host ${host}; if no process there is spending, delete ${lockFile}`)
        if (pid && isAlive(pid)) throw new Error(`the spend ledger is in use by process ${pid}; only one live process may spend at a time`)
        try {
          unlinkSync(lockFile)
        } catch {}
      }
    }
    throw new Error(`could not lock ${lockFile}`)
  }

  unlock(): void {
    if (!this.lockFile) return
    try {
      unlinkSync(this.lockFile)
    } catch {}
    this.lockFile = null
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

  /**
   * Reserves all or nothing; throws CapExceeded if the batch would pass the cap. Ordinary spending must leave
   * SWEEP_ALLOWANCE untouched; only `forSweep` reservations may use it.
   */
  reserve(items: { signature: string; lamports: bigint; what: string }[], forSweep = false): void {
    if (!this.lockFile) throw new Error('the ledger must be locked before spending')
    const add = items.reduce((s, i) => s + i.lamports, 0n)
    const limit = forSweep ? this.cap : this.cap - SWEEP_ALLOWANCE
    if (this.committed() + add > limit) throw new CapExceeded(`spend cap reached: committed ${this.committed()} + ${add} > ${limit} lamports`)
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
