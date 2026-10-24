// After a run: which of our transactions landed, in which block and at which position. Settles the spend ledger
// with the fees actually charged. Safe to run repeatedly; blocks already fetched are not fetched again.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK_REQUEST, type BlockSummary, parseBlock } from './block.ts'
import type { Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { appendJsonl, chunk, readJsonl, toJson } from './util.ts'

export interface Landed {
  trial: number
  role: string
  signature: string
  slot: number | null
  /** position inside the block, 0 = first transaction */
  index: number | null
  blockTxCount: number | null
  leader: string | null
  fee: number | null
  costUnits: number | null
  err: unknown
}

/** Unlanded transactions older than this are treated as expired (a blockhash lives ~150 slots, about 60 s at most). */
const EXPIRED_AFTER_MS = 5 * 60_000

export async function collect(rpc: Rpc, runDir: string, ledger: Ledger | null, log: Log): Promise<Landed[]> {
  const txs = readJsonl(join(runDir, 'txs.jsonl')).filter((t) => t.live)
  if (txs.length === 0) {
    log.info(`${runDir}: no live transactions to collect`)
    return []
  }
  const status = new Map<string, any>()
  for (const part of chunk(
    txs.map((t) => t.signature as string),
    256,
  )) {
    const { value } = await rpc.call('getSignatureStatuses', [part, { searchTransactionHistory: true }])
    part.forEach((sig, i) => status.set(sig, value[i]))
  }

  const blocksFile = join(runDir, 'blocks.jsonl')
  const blocks = new Map<number, BlockSummary>(readJsonl<BlockSummary>(blocksFile).map((b) => [b.slot, b]))
  const positions = new Map<string, number>(readJsonl(join(runDir, 'positions.jsonl')).map((p) => [p.signature, p.index]))
  const slots = [...new Set([...status.values()].filter((s) => s && s.slot).map((s) => s.slot as number))].sort((a, b) => a - b)
  for (const slot of slots) {
    if (blocks.has(slot)) continue
    const raw = await rpc.call('getBlock', [slot, BLOCK_REQUEST])
    const { summary, indexOf } = parseBlock(slot, raw)
    blocks.set(slot, summary)
    appendJsonl(blocksFile, summary)
    for (const t of txs) {
      const i = indexOf.get(t.signature)
      if (i !== undefined && !positions.has(t.signature)) {
        positions.set(t.signature, i)
        appendJsonl(join(runDir, 'positions.jsonl'), { signature: t.signature, slot, index: i })
      }
    }
    log.info(`block ${slot}: ${summary.txCount} transactions, leader ${summary.leader}`)
  }

  const landed: Landed[] = txs.map((t) => {
    const st = status.get(t.signature)
    const slot: number | null = st?.slot ?? null
    const b = slot ? blocks.get(slot) : undefined
    const index = positions.get(t.signature) ?? null
    const row = b && index !== null ? b.rows[index] : undefined
    return {
      trial: t.trial,
      role: t.role,
      signature: t.signature,
      slot,
      index,
      blockTxCount: b?.txCount ?? null,
      leader: b?.leader ?? null,
      fee: row ? row[0] : null,
      costUnits: row ? row[1] : null,
      err: st?.err ?? null,
    }
  })
  writeFileSync(join(runDir, 'landed.json'), toJson(landed, 1))

  if (ledger) {
    const now = Date.now()
    for (const t of txs) {
      const l = landed.find((x) => x.signature === t.signature)!
      if (l.fee !== null) ledger.settle(t.signature, BigInt(l.fee))
      else if (now - Date.parse(t.sentAt) > EXPIRED_AFTER_MS && ledger.isOpen(t.signature)) ledger.settle(t.signature, 0n)
    }
  }
  const n = landed.filter((l) => l.slot !== null).length
  log.info(`${runDir}: ${n}/${landed.length} transactions landed in ${slots.length} blocks`)
  return landed
}

export const runExists = (runDir: string) => existsSync(join(runDir, 'txs.jsonl'))
