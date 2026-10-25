// Independent check of the raw data against the chain, built to work long after the measurements (judging time):
//   - every landed transaction: the block at the recorded slot lists its signature at the recorded index, and the
//     block's transaction count matches; the slot is after Alpenglow;
//   - the slot leader: against the leader schedule where an endpoint still serves that epoch (public RPCs keep only
//     a few epochs), otherwise against the block's fee-reward recipient, which equals the leader unless the validator
//     collects revenue in a separate account; such blocks are listed as unverifiable, not as problems;
//   - a sample of whole transactions, every role represented: fee, fee payer (one of the run's own wallets), the
//     written anchor, and the ComputeBudget instructions against the recorded role parameters (this is what tells A,
//     E and F apart: they pay the same fee);
//   - every transaction recorded as not landed is unknown to the chain;
//   - every sent transaction was planned before sending and reserved in the spend ledger.
// Endpoints are tried in order for each request; a block no endpoint can serve is reported as unavailable.
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
  endpoints: string[]
  blocks: number
  blocksInData: number
  transactions: number
  leadersBySchedule: number
  leadersByFeeCollector: number
  leadersUnverifiable: { slot: number; leader: string; feeCollector: string | null }[]
  unavailableBlocks: number[]
  sampleChecked: number
  unlandedChecked: number
  problems: unknown[]
}

/** The first endpoint that answers wins; null when none can (e.g. the block is past every node's retention). */
async function first<T>(rpcs: Rpc[], method: string, params: unknown[]): Promise<{ value: T | null; error: string | null }> {
  let error: string | null = null
  for (const r of rpcs) {
    try {
      return { value: await r.call<T>(method, params), error: null }
    } catch (e) {
      error = `${r.label}: ${(e as Error).message}`
    }
  }
  return { value: null, error }
}

export async function verify(rpcs: Rpc[], runsRoot: string, log: Log, opts: { sample?: number; write?: boolean; maxBlocks?: number } = {}): Promise<VerifyReport> {
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
    // planned before sent (runs that write planned.jsonl)
    const plannedFile = join(runsRoot, run, 'planned.jsonl')
    if (existsSync(plannedFile)) {
      const planned = new Set(readJsonl(plannedFile).map((p) => p.signature))
      for (const t of sent) if (!planned.has(t.signature)) problems.push({ run, signature: t.signature, problem: 'sent but not planned' })
    }
  }
  const reserved = new Set(readJsonl(join(runsRoot, '..', 'ledger.jsonl')).filter((e) => e.kind === 'reserve').map((e) => e.signature))
  for (const sig of recorded.keys()) if (!reserved.has(sig)) problems.push({ signature: sig, problem: 'sent without a ledger reservation' })

  // every block, or a seeded random sample of them (the one-command check keeps the public endpoint's rate limit in mind)
  const allSlots = [...new Set(landed.map((l) => l.slot!))].sort((a, b) => a - b)
  const slots = opts.maxBlocks && allSlots.length > opts.maxBlocks ? shuffle(allSlots, rng(11)).slice(0, opts.maxBlocks).sort((a, b) => a - b) : allSlots
  // the leader schedule, from whichever endpoint still serves each epoch
  const schedule = new Map<number, string | null>()
  for (const r of rpcs) {
    const missing = slots.filter((s) => !schedule.get(s))
    if (!missing.length) break
    for (const [s, l] of await scheduledLeaders(r, missing)) if (l) schedule.set(s, l)
  }
  const unavailable: number[] = []
  const unverifiable: VerifyReport['leadersUnverifiable'] = []
  let bySchedule = 0
  let byCollector = 0
  let checked = 0
  for (const slot of slots) {
    const { value: b, error } = await first<any>(rpcs, 'getBlock', [slot, { transactionDetails: 'signatures', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    if (!b) {
      unavailable.push(slot)
      log.info(`block ${slot} unavailable: ${error}`)
      continue
    }
    const collector = (b.rewards ?? []).find((r: any) => r.rewardType === 'Fee')?.pubkey ?? null
    const rec = recordedBlocks.get(slot)
    if (rec && rec.txCount !== b.signatures.length) problems.push({ slot, problem: 'transaction count', recorded: rec.txCount, chain: b.signatures.length })
    if (rec && 'feeCollector' in rec && rec.feeCollector !== collector) problems.push({ slot, problem: 'fee collector', recorded: rec.feeCollector, chain: collector })
    const leader = landed.find((x) => x.slot === slot)?.leader ?? null
    const scheduled = schedule.get(slot) ?? null
    if (scheduled) {
      bySchedule++
      if (leader && scheduled !== leader) problems.push({ slot, problem: 'leader', recorded: leader, chain: scheduled })
    } else if (leader && leader === collector) byCollector++
    else if (leader) unverifiable.push({ slot, leader, feeCollector: collector })
    for (const l of landed.filter((x) => x.slot === slot)) {
      checked++
      if (slot < ALPENGLOW_SLOT) problems.push({ signature: l.signature, slot, problem: 'before Alpenglow' })
      if (b.signatures[l.index!] !== l.signature)
        problems.push({ run: l.run, signature: l.signature, slot, index: l.index, problem: 'signature not at the recorded index', foundAt: b.signatures.indexOf(l.signature) })
    }
  }

  // a sample of whole transactions, every role represented: payer, fee, anchor, role parameters
  const random = rng(7)
  const byRole = new Map<string, (Landed & { run: string })[]>()
  for (const l of landed) byRole.set(l.role, [...(byRole.get(l.role) ?? []), l])
  const perRole = Math.max(1, Math.ceil((opts.sample ?? 60) / Math.max(1, byRole.size)))
  const sample = [...byRole.values()].flatMap((ls) => shuffle(ls, random).slice(0, perRole))
  let sampleChecked = 0
  for (const l of sample) {
    const r = recorded.get(l.signature)
    const { value: tx } = await first<any>(rpcs, 'getTransaction', [l.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    if (!tx || !r) {
      unavailable.push(l.slot!)
      continue
    }
    sampleChecked++
    const msg = tx.transaction.message
    const fail = (problem: string, extra: Record<string, unknown> = {}) => problems.push({ run: l.run, signature: l.signature, role: l.role, problem, ...extra })
    if (tx.slot !== l.slot) fail('slot', { recorded: l.slot, chain: tx.slot })
    if (!wallets.get(l.run)!.has(msg.accountKeys[0])) fail('fee payer is not one of the run wallets', { payer: msg.accountKeys[0] })
    if (l.fee !== null && tx.meta.fee !== l.fee) fail('fee', { recorded: l.fee, chain: tx.meta.fee })
    if (r.anchor && !msg.accountKeys.includes(r.anchor)) fail('recorded anchor not in the transaction')
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
    if (found.cuLimit !== want.cuLimit || found.cuPrice !== want.cuPrice || found.loadedLimit !== want.loadedLimit) fail('role parameters', { recorded: want, chain: found })
  }

  // recorded as not landed: the chain must not know them
  for (const part of chunk(unlanded, 256)) {
    const { value } = await first<any>(rpcs, 'getSignatureStatuses', [part.map((u) => u.signature), { searchTransactionHistory: true }])
    if (!value) continue
    part.forEach((u, i) => value.value[i] && problems.push({ run: u.run, signature: u.signature, problem: 'recorded as not landed but found on chain', slot: value.value[i].slot }))
  }

  const report: VerifyReport = {
    verifiedAt: new Date().toISOString(),
    endpoints: rpcs.map((r) => r.label),
    blocks: slots.length,
    blocksInData: allSlots.length,
    transactions: checked,
    leadersBySchedule: bySchedule,
    leadersByFeeCollector: byCollector,
    leadersUnverifiable: unverifiable,
    unavailableBlocks: [...new Set(unavailable)],
    sampleChecked,
    unlandedChecked: unlanded.length,
    problems,
  }
  if (opts.write) writeFileSync(join(runsRoot, '..', 'verify.json'), toJson(report, 1))
  log.info(
    `verify: ${checked} landed transactions in ${slots.length} blocks (${report.unavailableBlocks.length} unavailable), ${sampleChecked} whole transactions, ${unlanded.length} unlanded; leaders: ${bySchedule} by schedule, ${byCollector} by fee collector, ${unverifiable.length} unverifiable; ${problems.length} problems`,
  )
  for (const p of problems.slice(0, 10)) log.info(`  ${toJson(p)}`)
  return report
}
