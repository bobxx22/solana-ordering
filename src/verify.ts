// Independent check of the raw data against the chain, built to work long after the measurements (judging time):
//   - every landed transaction: the block at the recorded slot lists its signature at the recorded index, and the
//     block's transaction count matches; the slot is after Alpenglow;
//   - the slot leader: against the leader schedule where an endpoint still serves that epoch (public RPCs keep only
//     a few epochs, so the main run is verified session by session, see docs/RUNBOOK.md), otherwise against the
//     block's fee-reward recipient, which equals the leader unless the validator collects revenue in a separate
//     account; such blocks are listed as unverifiable, not as problems;
//   - a sample of whole transactions, every role represented: fee, fee payer (one of the run's own wallets), the
//     written anchor, and the ComputeBudget instructions against the recorded role parameters (this is what tells A,
//     E and F apart: they pay the same fee);
//   - a sample of whole blocks: every row the background analysis uses (fees, requested limits, scheduled cost of
//     everyone else's transactions) rebuilt from the chain and compared with the recorded one;
//   - every transaction recorded as not landed is unknown to the chain, asked only of endpoints whose history
//     reaches back to its send slot (anything else is not evidence of absence, and is counted as unchecked);
//   - the delivery-path probes (paths/, quic-test/): each recorded landing slot, and each recorded non-landing;
//   - every sent transaction was planned before sending and reserved in the spend ledger.
// Endpoints are tried in order for each request; a block no endpoint can serve is reported as unavailable.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ALPENGLOW_SLOT } from './analyze.ts'
import { decode } from './base58.ts'
import { BLOCK_REQUEST, type BlockSummary, parseBlock } from './block.ts'
import { type Landed, scheduledLeaders } from './collect.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { COMPUTE_BUDGET_PROGRAM } from './tx.ts'
import { chunk, readJsonl, rng, shuffle, toJson } from './util.ts'

export interface VerifyReport {
  verifiedAt: string
  endpoints: string[]
  /** the live runs checked (all of them unless a run was named) */
  runs: string[]
  blocks: number
  blocksInData: number
  transactions: number
  leadersBySchedule: number
  leadersByFeeCollector: number
  leadersUnverifiable: { slot: number; leader: string; feeCollector: string | null }[]
  unavailableBlocks: number[]
  sampleChecked: number
  /** whole blocks whose rows were rebuilt from the chain, and the rows compared */
  rowBlocksChecked: number
  rowsChecked: number
  unlandedChecked: number
  /** recorded as not landed, but no endpoint with history back to the send slot answered */
  unlandedUnchecked: number
  probesChecked: number
  probesUnchecked: number
  problems: unknown[]
}

export interface VerifyOptions {
  /** whole transactions checked, spread over the roles (Infinity: every landed transaction) */
  sample?: number
  /** whole blocks whose rows are rebuilt */
  rowBlocks?: number
  /** at most this many blocks, a seeded sample */
  maxBlocks?: number
  /** only this live run (the per-session check of the runbook); default every run */
  run?: string
  /** where to write the report, if anywhere */
  writeTo?: string
}

/**
 * The first endpoint that answers with a value wins; an error or an empty answer passes the request on to the next.
 * Null when none can (e.g. the block is past every node's retention).
 */
async function first<T>(rpcs: Rpc[], method: string, params: unknown[]): Promise<{ value: T | null; error: string | null }> {
  let error: string | null = null
  for (const r of rpcs) {
    try {
      const value = await r.call<T>(method, params)
      if (value !== null && value !== undefined) return { value, error: null }
      error = `${r.label}: empty answer`
    } catch (e) {
      error = `${r.label}: ${(e as Error).message}`
    }
  }
  return { value: null, error }
}

/**
 * Statuses of signatures, each sent at a known slot. Only an endpoint whose history (getFirstAvailableBlock) reaches
 * back to a signature's send slot is asked about it, so that "unknown" means absent from the chain.
 */
async function statusesWithHistory(rpcs: Rpc[], items: { signature: string; sentSlot: number }[]): Promise<Map<string, { slot: number } | null>> {
  const out = new Map<string, { slot: number } | null>()
  const firstBlock: (number | null)[] = []
  for (const r of rpcs) firstBlock.push(await r.call<number>('getFirstAvailableBlock').catch(() => null))
  let pending = items
  for (let i = 0; i < rpcs.length && pending.length; i++) {
    const fb = firstBlock[i]
    if (fb === null) continue
    const askable = pending.filter((x) => x.sentSlot >= fb)
    // a history search for a signature the chain does not know takes ~1.6 s on the public endpoint: small requests
    // stay within the client's timeout
    for (const part of chunk(askable, 10)) {
      const res = await rpcs[i].call<any>('getSignatureStatuses', [part.map((x) => x.signature), { searchTransactionHistory: true }]).catch(() => null)
      if (!res) continue
      part.forEach((x, k) => out.set(x.signature, res.value[k] ? { slot: res.value[k].slot } : null))
    }
    pending = pending.filter((x) => !out.has(x.signature))
  }
  return out
}

export async function verify(rpcs: Rpc[], runsRoot: string, log: Log, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const landed: (Landed & { run: string })[] = []
  const unlanded: { run: string; signature: string; sentSlot: number }[] = []
  const wallets = new Map<string, Set<string>>()
  const recorded = new Map<string, any>()
  const recordedBlocks = new Map<number, BlockSummary>()
  const problems: unknown[] = []
  const runs: string[] = []
  const ids = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []
  if (opts.run && !ids.includes(opts.run)) throw new Error(`no run ${opts.run} in ${runsRoot}`)
  for (const run of ids) {
    if (opts.run && run !== opts.run) continue
    const f = join(runsRoot, run, 'landed.json')
    if (!existsSync(join(runsRoot, run, 'run.json'))) continue
    const meta = JSON.parse(readFileSync(join(runsRoot, run, 'run.json'), 'utf8'))
    if (!existsSync(f)) {
      // a live run that sent but was never collected is invisible to the analysis: run `collect all`
      if (meta.live && readJsonl(join(runsRoot, run, 'trials.jsonl')).length) problems.push({ run, problem: 'live run without collected results (landed.json)' })
      continue
    }
    runs.push(run)
    wallets.set(run, new Set([meta.mainWallet, ...meta.subPayers]))
    for (const b of readJsonl<BlockSummary>(join(runsRoot, run, 'blocks.jsonl'))) recordedBlocks.set(b.slot, b)
    const sent = readJsonl(join(runsRoot, run, 'txs.jsonl')).filter((t) => t.live)
    for (const t of sent) recorded.set(t.signature, t)
    for (const l of JSON.parse(readFileSync(f, 'utf8')) as Landed[]) {
      if (l.slot !== null && l.index !== null) landed.push({ ...l, run })
      else unlanded.push({ run, signature: l.signature, sentSlot: recorded.get(l.signature)?.slotAtSend ?? 0 })
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

  // a sample of whole blocks: the rows of everyone else's transactions, rebuilt from the chain
  let rowBlocksChecked = 0
  let rowsChecked = 0
  const rowSlots = shuffle(
    slots.filter((s) => recordedBlocks.has(s)),
    rng(13),
  ).slice(0, opts.rowBlocks ?? 3)
  for (const slot of rowSlots) {
    const { value: b } = await first<any>(rpcs, 'getBlock', [slot, { ...BLOCK_REQUEST, commitment: 'finalized' }])
    if (!b) {
      unavailable.push(slot)
      continue
    }
    const rows = parseBlock(slot, b).summary.rows
    const rec = recordedBlocks.get(slot)!.rows
    rowBlocksChecked++
    rowsChecked += rec.length
    const bad = rec.findIndex((r, i) => toJson(r) !== toJson(rows[i]))
    if (bad >= 0 || rows.length !== rec.length) problems.push({ slot, problem: 'block rows', index: bad, recorded: rec[bad] ?? null, chain: rows[bad] ?? null })
  }

  // recorded as not landed: the chain must not know them (asked only where history reaches back to the send slot)
  const unlandedStatus = await statusesWithHistory(rpcs, unlanded)
  for (const u of unlanded) {
    const st = unlandedStatus.get(u.signature)
    if (st) problems.push({ run: u.run, signature: u.signature, problem: 'recorded as not landed but found on chain', slot: st.slot })
  }
  const unlandedChecked = unlanded.filter((u) => unlandedStatus.has(u.signature)).length

  // the delivery-path probes: recorded landing slots, and recorded non-landings
  const probes: { file: string; signature: string; slot: number | null; sentSlot: number }[] = []
  if (!opts.run)
    for (const dir of ['paths', 'quic-test'].map((d) => join(runsRoot, '..', d)).filter(existsSync))
      for (const f of readdirSync(dir).filter((x) => x.endsWith('-landed.jsonl'))) {
        const sentSlot = new Map(readJsonl(join(dir, f.replace('-landed', ''))).map((x) => [x.signature, x.slotAtSend ?? 0]))
        for (const l of readJsonl(join(dir, f))) probes.push({ file: f, signature: l.signature, slot: l.slot ?? null, sentSlot: sentSlot.get(l.signature) ?? 0 })
      }
  const probeStatus = await statusesWithHistory(rpcs, probes)
  for (const p of probes) {
    if (!probeStatus.has(p.signature)) continue
    const st = probeStatus.get(p.signature)
    if ((st?.slot ?? null) !== p.slot) problems.push({ file: p.file, signature: p.signature, problem: 'probe landing slot', recorded: p.slot, chain: st?.slot ?? null })
  }
  const probesChecked = probes.filter((p) => probeStatus.has(p.signature)).length

  const report: VerifyReport = {
    verifiedAt: new Date().toISOString(),
    endpoints: rpcs.map((r) => r.label),
    runs,
    blocks: slots.length,
    blocksInData: allSlots.length,
    transactions: checked,
    leadersBySchedule: bySchedule,
    leadersByFeeCollector: byCollector,
    leadersUnverifiable: unverifiable,
    unavailableBlocks: [...new Set(unavailable)],
    sampleChecked,
    rowBlocksChecked,
    rowsChecked,
    unlandedChecked,
    unlandedUnchecked: unlanded.length - unlandedChecked,
    probesChecked,
    probesUnchecked: probes.length - probesChecked,
    problems,
  }
  if (opts.writeTo) {
    mkdirSync(dirname(opts.writeTo), { recursive: true })
    writeFileSync(opts.writeTo, toJson(report, 1))
  }
  log.info(
    `verify: ${runs.length} runs; ${checked} landed transactions in ${slots.length} blocks (${report.unavailableBlocks.length} unavailable), ${sampleChecked} whole transactions, ${rowsChecked} rows of ${rowBlocksChecked} whole blocks, ${unlandedChecked} of ${unlanded.length} unlanded checked, ${probesChecked} of ${probes.length} probe transactions; leaders: ${bySchedule} by schedule, ${byCollector} by fee collector, ${unverifiable.length} unverifiable; ${problems.length} problems`,
  )
  for (const p of problems.slice(0, 10)) log.info(`  ${toJson(p)}`)
  return report
}
