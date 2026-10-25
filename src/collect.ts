// After a run: which of our transactions landed, in which block and at which position, and who led that slot.
// Settles the spend ledger with the fees actually charged. Safe to run repeatedly: a block is fetched again whenever
// one of our transactions in it has no recorded position, and `refresh` refetches every block.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK_REQUEST, type BlockSummary, parseBlock } from './block.ts'
import type { Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { settleOpen } from './settle.ts'
import { chunk, readJsonl, toJson } from './util.ts'

export interface Landed {
  trial: number
  role: string
  signature: string
  slot: number | null
  /** position inside the block, 0 = first transaction */
  index: number | null
  blockTxCount: number | null
  /** scheduled leader of the slot */
  leader: string | null
  /** recipient of the block's fee reward (not always the leader) */
  feeCollector: string | null
  fee: number | null
  costUnits: number | null
  err: unknown
}

const writeJsonl = (file: string, rows: unknown[]) => writeFileSync(file, rows.map((r) => toJson(r)).join('\n') + (rows.length ? '\n' : ''))

/** Scheduled leaders for a set of slots; null where the RPC no longer serves that epoch's schedule. */
export async function scheduledLeaders(rpc: Rpc, slots: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  if (!slots.length) return out
  const sorted = [...slots].sort((a, b) => a - b)
  // contiguous ranges of at most 5000 slots per request
  let i = 0
  while (i < sorted.length) {
    const from = sorted[i]
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] - from < 5000) j++
    try {
      const leaders: string[] = await rpc.call('getSlotLeaders', [from, sorted[j] - from + 1])
      for (let k = i; k <= j; k++) out.set(sorted[k], leaders[sorted[k] - from] ?? null)
    } catch {
      for (let k = i; k <= j; k++) out.set(sorted[k], null)
    }
    i = j + 1
  }
  return out
}

export async function collect(rpc: Rpc, runDir: string, ledger: Ledger | null, log: Log, refresh = false): Promise<Landed[]> {
  const txs = readJsonl(join(runDir, 'txs.jsonl')).filter((t) => t.live)
  // signatures written before their reservation, in case a run stopped between reserving and recording a send
  const planned = readJsonl(join(runDir, 'planned.jsonl'))
  if (txs.length === 0 && planned.length === 0) {
    log.info(`${runDir}: no live transactions to collect`)
    return []
  }
  const status = new Map<string, any>()
  for (const part of chunk(
    txs.map((t) => t.signature as string),
    256,
  )) {
    const { value } = await rpc.call('getSignatureStatuses', [part, { searchTransactionHistory: true }])
    part.forEach((sig, i) => {
      const st = value[i]
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) status.set(sig, st)
    })
  }

  const blocksFile = join(runDir, 'blocks.jsonl')
  const stored = readJsonl<BlockSummary>(blocksFile)
  // leaders already recorded are kept on --refresh: an RPC may no longer serve an old epoch's schedule
  const knownLeader = new Map(stored.map((b) => [b.slot, b.leader]))
  const blocks = new Map<number, BlockSummary>(refresh ? [] : stored.map((b) => [b.slot, b]))
  const positions = new Map<string, { slot: number; index: number }>(
    refresh ? [] : readJsonl(join(runDir, 'positions.jsonl')).map((p) => [p.signature, { slot: p.slot, index: p.index }]),
  )
  const bySlot = new Map<number, string[]>()
  for (const [sig, st] of status) bySlot.set(st.slot, [...(bySlot.get(st.slot) ?? []), sig])
  const slots = [...bySlot.keys()].sort((a, b) => a - b)
  for (const slot of slots) {
    const complete = blocks.has(slot) && bySlot.get(slot)!.every((s) => positions.get(s)?.slot === slot)
    if (complete) continue
    const raw = await rpc.call('getBlock', [slot, BLOCK_REQUEST])
    if (!raw) {
      log.info(`block ${slot} not available yet; run collect again later`)
      continue
    }
    const { summary, indexOf } = parseBlock(slot, raw)
    summary.leader = blocks.get(slot)?.leader ?? knownLeader.get(slot) ?? null
    blocks.set(slot, summary)
    for (const sig of bySlot.get(slot)!) {
      const i = indexOf.get(sig)
      if (i !== undefined) positions.set(sig, { slot, index: i })
    }
    log.info(`block ${slot}: ${summary.txCount} transactions`)
  }
  const missingLeader = [...blocks.values()].filter((b) => !b.leader).map((b) => b.slot)
  const leaders = await scheduledLeaders(rpc, missingLeader)
  for (const b of blocks.values()) if (!b.leader) b.leader = leaders.get(b.slot) ?? null

  writeJsonl(
    blocksFile,
    [...blocks.values()].sort((a, b) => a.slot - b.slot),
  )
  writeJsonl(
    join(runDir, 'positions.jsonl'),
    [...positions.entries()].map(([signature, p]) => ({ signature, ...p })),
  )

  const landed: Landed[] = txs.map((t) => {
    const st = status.get(t.signature)
    const slot: number | null = st?.slot ?? null
    const b = slot ? blocks.get(slot) : undefined
    const pos = positions.get(t.signature)
    const index = pos && pos.slot === slot ? pos.index : null
    const row = b && index !== null ? b.rows[index] : undefined
    return {
      trial: t.trial,
      role: t.role,
      signature: t.signature,
      slot,
      index,
      blockTxCount: b?.txCount ?? null,
      leader: b?.leader ?? null,
      feeCollector: b?.feeCollector ?? null,
      fee: row ? row[0] : null,
      costUnits: row ? row[1] : null,
      err: st?.err ?? null,
    }
  })
  writeFileSync(join(runDir, 'landed.json'), toJson(landed, 1))

  if (ledger) {
    const feeOf = new Map(landed.filter((l) => l.fee !== null).map((l) => [l.signature, l.fee as number]))
    const pending = [...planned, ...txs].map((t) => ({ signature: t.signature, lastValidBlockHeight: t.lastValidBlockHeight ?? null, sentAt: t.sentAt ?? t.plannedAt }))
    const r = await settleOpen(rpc, ledger, pending, (s) => feeOf.get(s) ?? null)
    if (r.open) log.info(`${r.open} reservations stay open until their blockhash expires; run collect again in a minute`)
  }
  const n = landed.filter((l) => l.slot !== null).length
  log.info(`${runDir}: ${n}/${landed.length} transactions landed in ${slots.length} blocks`)
  return landed
}

export const runExists = (runDir: string) => existsSync(join(runDir, 'txs.jsonl'))
