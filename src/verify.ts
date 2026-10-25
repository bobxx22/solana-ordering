// Independent check of the raw data against the chain:
//   - every landed transaction: the block at the recorded slot lists its signature at the recorded index, with the
//     recorded fee, paid by one of the run's own wallets, writing the recorded anchor; the slot is after Alpenglow
//     and, where the RPC still serves the epoch's schedule, its leader is the recorded one;
//   - a sample of landed transactions (every role) is fetched whole and its ComputeBudget instructions must match the
//     recorded role parameters, which is what tells A, E and F apart (they pay the same fee);
//   - every transaction recorded as not landed is unknown to the chain;
//   - every sent transaction was planned before sending and reserved in the spend ledger.
// The per-block check uses `transactionDetails: 'accounts'`, light enough for free public endpoints.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALPENGLOW_SLOT } from './analyze.ts'
import { decode } from './base58.ts'
import type { BlockSummary } from './block.ts'
import { type Landed, scheduledLeaders } from './collect.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { COMPUTE_BUDGET_PROGRAM } from './tx.ts'
import { chunk, readJsonl, rng, shuffle, toJson } from './util.ts'

export interface VerifyReport {
  verifiedAt: string
  rpc: string
  blocks: number
  transactions: number
  blocksWithLeaderSchedule: number
  instructionsChecked: number
  unlandedChecked: number
  problems: unknown[]
}

export async function verify(rpc: Rpc, runsRoot: string, log: Log, opts: { sample?: number; write?: boolean } = {}): Promise<VerifyReport> {
  const landed: (Landed & { run: string })[] = []
  const unlanded: { run: string; signature: string }[] = []
  const wallets = new Map<string, Set<string>>()
  const recorded = new Map<string, any>()
  const recordedBlocks = new Map<number, BlockSummary>()
  const problems: unknown[] = []
  for (const run of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
    const f = join(runsRoot, run, 'landed.json')
    if (!existsSync(f)) continue
    const meta = JSON.parse(readFileSync(join(runsRoot, run, 'run.json'), 'utf8'))
    wallets.set(run, new Set([meta.mainWallet, ...meta.subPayers]))
    for (const b of readJsonl<BlockSummary>(join(runsRoot, run, 'blocks.jsonl'))) recordedBlocks.set(b.slot, b)
    const sent = readJsonl(join(runsRoot, run, 'txs.jsonl')).filter((t) => t.live)
    for (const t of sent) recorded.set(t.signature, t)
    for (const l of JSON.parse(readFileSync(f, 'utf8')) as Landed[]) {
      if (l.slot !== null && l.index !== null) landed.push({ ...l, run })
      else unlanded.push({ run, signature: l.signature })
    }
    // planned before sent (runs that write planned.jsonl), and reserved in the ledger
    const plannedFile = join(runsRoot, run, 'planned.jsonl')
    if (existsSync(plannedFile)) {
      const planned = new Set(readJsonl(plannedFile).map((p) => p.signature))
      for (const t of sent) if (!planned.has(t.signature)) problems.push({ run, signature: t.signature, problem: 'sent but not planned' })
    }
  }
  const ledgerFile = join(runsRoot, '..', 'ledger.jsonl')
  const reserved = new Set(readJsonl(ledgerFile).filter((e) => e.kind === 'reserve').map((e) => e.signature))
  for (const sig of recorded.keys()) if (!reserved.has(sig)) problems.push({ signature: sig, problem: 'sent without a ledger reservation' })

  const slots = [...new Set(landed.map((l) => l.slot!))].sort((a, b) => a - b)
  const leaders = await scheduledLeaders(rpc, slots)
  let checked = 0
  for (const slot of slots) {
    const b = await rpc.call('getBlock', [slot, { transactionDetails: 'accounts', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    const collector = (b.rewards ?? []).find((r: any) => r.rewardType === 'Fee')?.pubkey ?? null
    const scheduled = leaders.get(slot) ?? null
    const rec = recordedBlocks.get(slot)
    if (rec && rec.txCount !== b.transactions.length) problems.push({ slot, problem: 'transaction count', recorded: rec.txCount, chain: b.transactions.length })
    if (rec && 'feeCollector' in rec && rec.feeCollector !== collector) problems.push({ slot, problem: 'fee collector', recorded: rec.feeCollector, chain: collector })
    for (const l of landed.filter((x) => x.slot === slot)) {
      checked++
      const tx = b.transactions[l.index!]
      const fail = (problem: string, extra: Record<string, unknown> = {}) => problems.push({ run: l.run, signature: l.signature, slot, index: l.index, problem, ...extra })
      if (slot < ALPENGLOW_SLOT) fail('before Alpenglow')
      if (!tx || tx.transaction.signatures[0] !== l.signature) {
        fail('signature not at the recorded index', { foundAt: b.transactions.findIndex((t: any) => t.transaction.signatures[0] === l.signature) })
        continue
      }
      const keys = tx.transaction.accountKeys
      if (!wallets.get(l.run)!.has(keys[0]?.pubkey)) fail('fee payer is not one of the run wallets', { payer: keys[0]?.pubkey })
      const anchor = recorded.get(l.signature)?.anchor
      if (anchor && !keys.some((k: any) => k.pubkey === anchor && k.writable)) fail('recorded anchor not written')
      if (l.fee !== null && tx.meta.fee !== l.fee) fail('fee', { recorded: l.fee, chain: tx.meta.fee })
      if (scheduled && l.leader && scheduled !== l.leader) fail('leader', { recorded: l.leader, chain: scheduled })
    }
  }

  // role parameters: a sample of whole transactions, every role represented
  const random = rng(7)
  const byRole = new Map<string, (Landed & { run: string })[]>()
  for (const l of landed) byRole.set(l.role, [...(byRole.get(l.role) ?? []), l])
  const perRole = Math.max(1, Math.ceil((opts.sample ?? 30) / Math.max(1, byRole.size)))
  const sample = [...byRole.values()].flatMap((ls) => shuffle(ls, random).slice(0, perRole))
  for (const l of sample) {
    const r = recorded.get(l.signature)
    const tx = await rpc.call('getTransaction', [l.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    if (!tx || !r) {
      problems.push({ signature: l.signature, problem: 'transaction not retrievable for the instruction check' })
      continue
    }
    const msg = tx.transaction.message
    const found: Record<string, number> = {}
    for (const ix of msg.instructions) {
      if (msg.accountKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM) continue
      const d = decode(ix.data)
      const view = new DataView(d.buffer, d.byteOffset)
      if (d[0] === 2) found.cuLimit = view.getUint32(1, true)
      if (d[0] === 3) found.cuPrice = Number(view.getBigUint64(1, true))
      if (d[0] === 4) found.loadedLimit = view.getUint32(1, true)
    }
    const want = { cuLimit: r.cuLimit, cuPrice: Number(r.cuPrice), loadedLimit: r.loadedLimit ?? 16_384 }
    if (found.cuLimit !== want.cuLimit || found.cuPrice !== want.cuPrice || found.loadedLimit !== want.loadedLimit) problems.push({ signature: l.signature, role: l.role, problem: 'role parameters', recorded: want, chain: found })
  }

  // recorded as not landed: the chain must not know them
  for (const part of chunk(unlanded, 256)) {
    const { value } = await rpc.call('getSignatureStatuses', [part.map((u) => u.signature), { searchTransactionHistory: true }])
    part.forEach((u, i) => value[i] && problems.push({ run: u.run, signature: u.signature, problem: 'recorded as not landed but found on chain', slot: value[i].slot }))
  }

  const report: VerifyReport = {
    verifiedAt: new Date().toISOString(),
    rpc: rpc.label,
    blocks: slots.length,
    transactions: checked,
    blocksWithLeaderSchedule: [...leaders.values()].filter(Boolean).length,
    instructionsChecked: sample.length,
    unlandedChecked: unlanded.length,
    problems,
  }
  if (opts.write) writeFileSync(join(runsRoot, '..', 'verify.json'), toJson(report, 1))
  log.info(
    `verify: ${checked} landed transactions in ${slots.length} blocks, ${sample.length} instruction sets, ${unlanded.length} unlanded, checked against ${rpc.label}: ${problems.length} problems (leader schedule for ${report.blocksWithLeaderSchedule} blocks)`,
  )
  for (const p of problems.slice(0, 10)) log.info(`  ${toJson(p)}`)
  return report
}
