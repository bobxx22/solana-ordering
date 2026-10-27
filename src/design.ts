// The experimental design: what one trial sends and how its factors are assigned.
//
// A trial is a burst of six transactions aimed at one leader window. Their fee parameters are chosen so that the
// candidate ordering rules disagree with each other:
//   reward/cost (what Agave's and Firedancer's schedulers compute: priority fee plus the leader's half of the base
//   fee, over the scheduling cost), priority fee/cost (the same without the base fee), price per compute unit, and
//   total priority fee.
// A and E are identical twins: between them only the send order differs.
// F is A with the largest loaded-accounts-data limit: same price and fee, eight times the scheduling cost. A against F
// is a pure test of whether the cost denominator matters.
//
// Every transaction is: SetComputeUnitLimit, SetComputeUnitPrice, SetLoadedAccountsDataSizeLimit,
// and a 0-lamport System transfer from the trial's payer to an "anchor" account. The anchor is a fresh random
// address, which also makes every signature unique. In "shared" trials all six write the same anchor (a write-lock
// conflict the scheduler must serialize); in "independent" trials each writes its own, so nothing conflicts.
// Payers are distinct per transaction in both modes, because a shared fee payer would itself be a conflict.
//
// Delivery (with the direct TPU path):
//   buffered  the whole burst at once two slots before the leader's window, so all six wait in the leader's buffer
//             when its block starts (the main cell: the scheduler ranks six transactions available together);
//   burst     the whole burst at once one slot into the window, arriving while the block is being produced;
//   streamed  one transaction every 30 ms from one slot into the window: a control for arrival order, since a
//             leader that does not hold transactions back for 30 ms must include them in send order.
// Cells are dealt per client in shuffled blocks of ten (CELL_BLOCK): half of all trials are buffered/shared, the
// primary cell, where execution order equals scheduling order for every client (docs/schedulers.md).
import { randomBytes } from 'node:crypto'
import { encode } from './base58.ts'
import type { Signer } from './keys.ts'
import { computeUnitLimit, computeUnitPrice, loadedAccountsDataSizeLimit, signTransaction, transfer } from './tx.ts'
import { shuffle } from './util.ts'

export type Role = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export type Mode = 'shared' | 'independent'
export type Delivery = 'buffered' | 'burst' | 'streamed'

export interface RoleSpec {
  role: Role
  cuLimit: number
  /** micro-lamports per compute unit */
  cuPrice: bigint
  /** SetLoadedAccountsDataSizeLimit, bytes */
  loadedLimit: number
}

const SMALL_LOADED = 16_384
/** the protocol maximum, 64 MiB */
const MAX_LOADED = 64 * 1024 * 1024

export const ROLES: RoleSpec[] = [
  { role: 'A', cuLimit: 1_000, cuPrice: 4_000_000n, loadedLimit: SMALL_LOADED },
  { role: 'B', cuLimit: 40_000, cuPrice: 250_000n, loadedLimit: SMALL_LOADED },
  { role: 'C', cuLimit: 1_000, cuPrice: 0n, loadedLimit: SMALL_LOADED },
  { role: 'D', cuLimit: 6_000, cuPrice: 1_500_000n, loadedLimit: SMALL_LOADED },
  { role: 'E', cuLimit: 1_000, cuPrice: 4_000_000n, loadedLimit: SMALL_LOADED },
  { role: 'F', cuLimit: 1_000, cuPrice: 4_000_000n, loadedLimit: MAX_LOADED },
]

export const BASE_FEE_PER_SIGNATURE = 5_000n
/** measured on mainnet by simulation: the transaction consumes 600 CU and loads 235 bytes */
export const MEASURED_CU = 600
export const STREAM_GAP_MS = 30
export const GAP_MS: Record<Delivery, number> = { buffered: 0, burst: 0, streamed: STREAM_GAP_MS }
/** dispatch slot relative to the first slot of the leader's window */
export const FIRE_OFFSET: Record<Delivery, number> = { buffered: -2, burst: 1, streamed: 1 }

export const priorityFee = (s: RoleSpec): bigint => (s.cuPrice * BigInt(s.cuLimit) + 999_999n) / 1_000_000n
export const maxFee = (s: RoleSpec): bigint => BASE_FEE_PER_SIGNATURE + priorityFee(s)

/** Cost of the loaded-accounts-data limit in Agave's cost model: 8 CU per started 32 KiB. */
export const loadedDataCost = (bytes: number) => Math.ceil(bytes / 32_768) * 8

/**
 * Scheduling cost as in Agave's cost model before execution: 720 per signature, 300 per write lock, instruction data
 * bytes / 4, the requested compute unit limit, and the loaded-accounts-data cost.
 * Our transactions have 1 signature, 2 write locks and 31 bytes of instruction data.
 */
export function expectedCost(s: RoleSpec): number {
  const dataBytes = 5 + 9 + 5 + 12
  return 720 + 2 * 300 + Math.floor(dataBytes / 4) + s.cuLimit + loadedDataCost(s.loadedLimit)
}

/** What the leader earns: the whole priority fee plus half of the base fee (the other half is burned). */
export const expectedReward = (s: RoleSpec): bigint => priorityFee(s) + BASE_FEE_PER_SIGNATURE / 2n

/** The ratio both production schedulers sort by. */
export const expectedPriority = (s: RoleSpec): number => Number(expectedReward(s)) / (expectedCost(s) + 1)

/** The same ratio without the base-fee share. */
export const priorityPerCost = (s: RoleSpec): number => Number(priorityFee(s)) / (expectedCost(s) + 1)

export interface PlannedTx {
  role: Role
  payer: string
  anchor: string
  cuLimit: number
  cuPrice: bigint
  loadedLimit: number
  priorityFee: bigint
  maxFee: bigint
  expectedCost: number
  expectedPriority: number
  /** position in the dispatch sequence, 0 = sent first */
  sendIndex: number
  signature: string
  wire: string
}

export function buildTrialTxs(mode: Mode, sendOrder: Role[], payers: Signer[], blockhash: string): PlannedTx[] {
  if (payers.length !== ROLES.length) throw new Error(`a trial needs ${ROLES.length} payers`)
  const sharedAnchor = encode(randomBytes(32))
  return ROLES.map((spec, i) => {
    const payer = payers[i]
    const anchor = mode === 'shared' ? sharedAnchor : encode(randomBytes(32))
    const tx = signTransaction(
      payer,
      [computeUnitLimit(spec.cuLimit), computeUnitPrice(spec.cuPrice), loadedAccountsDataSizeLimit(spec.loadedLimit), transfer(payer.address, anchor, 0n)],
      blockhash,
    )
    return {
      role: spec.role,
      payer: payer.address,
      anchor,
      cuLimit: spec.cuLimit,
      cuPrice: spec.cuPrice,
      loadedLimit: spec.loadedLimit,
      priorityFee: priorityFee(spec),
      maxFee: maxFee(spec),
      expectedCost: expectedCost(spec),
      expectedPriority: Number(expectedPriority(spec).toFixed(4)),
      sendIndex: sendOrder.indexOf(spec.role),
      signature: tx.signature,
      wire: Buffer.from(tx.bytes).toString('base64'),
    }
  })
}

export interface Cell {
  mode: Mode
  delivery: Delivery
}

const cells = (n: number, mode: Mode, delivery: Delivery): Cell[] => Array.from({ length: n }, () => ({ mode, delivery }))

/**
 * One block of ten cells, pre-registered before the main run: 5 buffered/shared (primary), 2 buffered/independent,
 * 1 burst/shared, and 1 streamed in each mode.
 */
export const CELL_BLOCK: Cell[] = [
  ...cells(5, 'shared', 'buffered'),
  ...cells(2, 'independent', 'buffered'),
  ...cells(1, 'shared', 'burst'),
  ...cells(1, 'shared', 'streamed'),
  ...cells(1, 'independent', 'streamed'),
]

/**
 * Landed trials wanted per client label, pre-registered: the client comparison rests on the four labels whose blocks
 * are ordered by a local scheduler; BAM and Harmonic labels are reported as pipelines.
 */
export const LOCAL_CLIENTS = ['Agave', 'JitoLabs', 'Firedancer', 'Rakurai']
export const PIPELINE_CLIENTS = ['AgaveBam', 'FireBAM', 'HarmonicAgave', 'HarmonicFiredancer']
export const DEFAULT_QUOTAS: Record<string, number> = Object.fromEntries([...LOCAL_CLIENTS.map((c) => [c, 60]), ...PIPELINE_CLIENTS.map((c) => [c, 30])])

/** a leader's window: consecutive slots of one leader */
export const WINDOW_SLOTS = 4

/**
 * A trial counts towards its label's quota only when every primary contrast can be read from it: B, C, D, F and at
 * least one of the twins A, E landed in the targeted window. Counting trials with any two landed would leave the
 * contrasts with fewer pairs than the quota promises (pre-registered with the power statement in README).
 */
export const countsTowardsQuota = (rolesInWindow: string[]): boolean =>
  ['B', 'C', 'D', 'F'].every((r) => rolesInWindow.includes(r)) && (rolesInWindow.includes('A') || rolesInWindow.includes('E'))

export const cellKey = (c: Cell) => `${c.delivery}/${c.mode}`

/**
 * Deals cells by deficit. A client's next cell is the one furthest below its target share (CELL_BLOCK), given the
 * cells the client already has: landed trials of the campaign (seeded at start, so a continuation run keeps the
 * balance) plus trials dispatched and awaiting their landing check. Ties are broken at random. A trial that does not
 * land is removed again, so the landed design stays balanced whatever happens to individual trials.
 */
export class CellDealer {
  private counts = new Map<string, Map<string, number>>()
  private chosen = new Map<string, Cell>()
  private random: () => number
  private targets: { cell: Cell; weight: number }[]

  constructor(random: () => number, block: Cell[] = CELL_BLOCK) {
    this.random = random
    const w = new Map<string, { cell: Cell; weight: number }>()
    for (const c of block) {
      const k = cellKey(c)
      w.set(k, { cell: c, weight: (w.get(k)?.weight ?? 0) + 1 / block.length })
    }
    this.targets = [...w.values()]
  }

  private countsOf(client: string): Map<string, number> {
    let m = this.counts.get(client)
    if (!m) this.counts.set(client, (m = new Map()))
    return m
  }

  /** The cell the client's next trial will get (stable until the client's counts change). */
  peek(client: string): Cell {
    const cached = this.chosen.get(client)
    if (cached) return cached
    const m = this.countsOf(client)
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    let best: Cell[] = []
    let bestDeficit = -Infinity
    for (const t of this.targets) {
      const deficit = t.weight * (total + 1) - (m.get(cellKey(t.cell)) ?? 0)
      if (deficit > bestDeficit + 1e-9) {
        best = [t.cell]
        bestDeficit = deficit
      } else if (Math.abs(deficit - bestDeficit) <= 1e-9) best.push(t.cell)
    }
    const cell = shuffle(best, this.random)[0]
    this.chosen.set(client, cell)
    return cell
  }

  /** Counts a cell for the client: +1 when dispatched (or seeded from a landed trial), -1 when a trial did not land. */
  add(client: string, cell: Cell, delta = 1): void {
    const m = this.countsOf(client)
    m.set(cellKey(cell), Math.max(0, (m.get(cellKey(cell)) ?? 0) + delta))
    this.chosen.delete(client)
  }

  countsFor(client: string): Record<string, number> {
    return Object.fromEntries(this.countsOf(client))
  }
}

export const trialCost = (): bigint => ROLES.reduce((s, r) => s + maxFee(r), 0n)
