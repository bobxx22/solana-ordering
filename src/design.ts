// The experimental design: what one trial sends and how its factors are assigned.
//
// A trial is a burst of five transactions aimed at one leader window. Their fee parameters are chosen so that three
// candidate ordering rules disagree with each other:
//   reward/cost (what Agave's and Firedancer's schedulers compute), total priority fee, and price per compute unit.
// A and E are identical twins: between them only the send order differs.
//
// Every transaction is: SetComputeUnitLimit, SetComputeUnitPrice, SetLoadedAccountsDataSizeLimit,
// and a 0-lamport System transfer from the trial's payer to an "anchor" account. The anchor is a fresh random
// address, which also makes every signature unique. In "shared" trials all five write the same anchor (a write-lock
// conflict the scheduler must serialize); in "independent" trials each writes its own, so nothing conflicts.
// Payers are distinct per transaction in both modes, because a shared fee payer would itself be a conflict.
import { randomBytes } from 'node:crypto'
import { encode } from './base58.ts'
import type { Signer } from './keys.ts'
import { computeUnitLimit, computeUnitPrice, loadedAccountsDataSizeLimit, type SignedTx, signTransaction, transfer } from './tx.ts'
import { shuffle } from './util.ts'

export type Role = 'A' | 'B' | 'C' | 'D' | 'E'
export type Mode = 'shared' | 'independent'
/** early: the burst is dispatched two slots before the window opens; inwindow: one slot after it opened */
export type Timing = 'early' | 'inwindow'

export interface RoleSpec {
  role: Role
  cuLimit: number
  /** micro-lamports per compute unit */
  cuPrice: bigint
}

export const ROLES: RoleSpec[] = [
  { role: 'A', cuLimit: 1_000, cuPrice: 4_000_000n },
  { role: 'B', cuLimit: 40_000, cuPrice: 250_000n },
  { role: 'C', cuLimit: 1_000, cuPrice: 0n },
  { role: 'D', cuLimit: 6_000, cuPrice: 1_500_000n },
  { role: 'E', cuLimit: 1_000, cuPrice: 4_000_000n },
]

export const BASE_FEE_PER_SIGNATURE = 5_000n
export const LOADED_ACCOUNTS_DATA_LIMIT = 16_384
/** measured on mainnet by simulation: the transaction consumes 600 CU and loads 235 bytes */
export const MEASURED_CU = 600

export const priorityFee = (s: RoleSpec): bigint => (s.cuPrice * BigInt(s.cuLimit) + 999_999n) / 1_000_000n
export const maxFee = (s: RoleSpec): bigint => BASE_FEE_PER_SIGNATURE + priorityFee(s)

/**
 * Scheduling cost as in Agave's cost model before execution: 720 per signature, 300 per write lock, instruction data
 * bytes / 4, the requested compute unit limit, and 8 per started 32 KiB of the loaded-accounts-data limit.
 * Our transactions have 1 signature, 2 write locks and 31 bytes of instruction data.
 */
export function expectedCost(s: RoleSpec): number {
  const dataBytes = 5 + 9 + 5 + 12
  return 720 + 2 * 300 + Math.floor(dataBytes / 4) + s.cuLimit + Math.ceil(LOADED_ACCOUNTS_DATA_LIMIT / 32_768) * 8
}

/** What the leader earns: the whole priority fee plus half of the base fee (the other half is burned). */
export const expectedReward = (s: RoleSpec): bigint => priorityFee(s) + BASE_FEE_PER_SIGNATURE / 2n

/** The ratio both production schedulers sort by. */
export const expectedPriority = (s: RoleSpec): number => Number(expectedReward(s)) / (expectedCost(s) + 1)

export interface PlannedTx {
  role: Role
  payer: string
  anchor: string
  cuLimit: number
  cuPrice: bigint
  priorityFee: bigint
  maxFee: bigint
  expectedCost: number
  expectedPriority: number
  /** position in the dispatch sequence, 0 = sent first */
  sendIndex: number
  signature: string
  wire: string
}

export function buildTrialTxs(mode: Mode, sendOrder: Role[], payers: Signer[], blockhash: string): { txs: PlannedTx[]; signed: Map<Role, SignedTx> } {
  if (payers.length !== ROLES.length) throw new Error(`a trial needs ${ROLES.length} payers`)
  const sharedAnchor = encode(randomBytes(32))
  const signed = new Map<Role, SignedTx>()
  const txs = ROLES.map((spec, i) => {
    const payer = payers[i]
    const anchor = mode === 'shared' ? sharedAnchor : encode(randomBytes(32))
    const tx = signTransaction(
      payer,
      [computeUnitLimit(spec.cuLimit), computeUnitPrice(spec.cuPrice), loadedAccountsDataSizeLimit(LOADED_ACCOUNTS_DATA_LIMIT), transfer(payer.address, anchor, 0n)],
      blockhash,
    )
    signed.set(spec.role, tx)
    return {
      role: spec.role,
      payer: payer.address,
      anchor,
      cuLimit: spec.cuLimit,
      cuPrice: spec.cuPrice,
      priorityFee: priorityFee(spec),
      maxFee: maxFee(spec),
      expectedCost: expectedCost(spec),
      expectedPriority: Number(expectedPriority(spec).toFixed(4)),
      sendIndex: sendOrder.indexOf(spec.role),
      signature: tx.signature,
      wire: Buffer.from(tx.bytes).toString('base64'),
    }
  })
  return { txs, signed }
}

/** Factor cells are dealt per client in shuffled blocks of four, so every client gets a balanced design. */
export class CellDealer {
  private queues = new Map<string, { mode: Mode; timing: Timing }[]>()
  private random: () => number
  private timings: Timing[]

  constructor(random: () => number, timings: Timing[]) {
    this.random = random
    this.timings = timings
  }

  /** The cell the client's next trial will get. */
  peek(client: string): { mode: Mode; timing: Timing } {
    let q = this.queues.get(client)
    if (!q || q.length === 0) {
      const cells = (['shared', 'independent'] as Mode[]).flatMap((mode) => this.timings.map((timing) => ({ mode, timing })))
      q = shuffle(cells, this.random)
      this.queues.set(client, q)
    }
    return q[0]
  }

  take(client: string): { mode: Mode; timing: Timing } {
    const cell = this.peek(client)
    this.queues.get(client)!.shift()
    return cell
  }
}

export const trialCost = (): bigint => ROLES.reduce((s, r) => s + maxFee(r), 0n)
