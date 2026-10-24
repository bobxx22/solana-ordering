// Turns the raw run files into the numbers of the report. Reads only committed data (no network), so anyone can
// rerun it; `verify` separately checks the raw data against the chain.
//
// Unit of analysis: a trial's transactions that landed in the same block (the trial's largest same-block group).
// For each candidate rule we compute, per trial, Kendall's tau between the rule's score and earliness in the block
// (tau = +1: the block lists them exactly in the rule's order; 0: unrelated; -1: reversed). Trials are then averaged
// per client with a bootstrap interval and a sign-flip permutation test.
// The client is that of the leader that actually produced the block (from the block's fee reward), not the target.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockSummary } from './block.ts'
import type { Landed } from './collect.ts'
import { BASE_FEE_PER_SIGNATURE } from './design.ts'
import type { Snapshot } from './discover.ts'
import { binomialP, bootstrapMeanCi, kendallTau, mean, median, signFlipP, spearman, wilson } from './stats.ts'
import { readJsonl, toJson } from './util.ts'

export const RULES = ['rewardPerCost', 'totalFee', 'cuPrice', 'sentFirst'] as const
export type Rule = (typeof RULES)[number]

interface TxRow {
  run: string
  trial: number
  role: string
  signature: string
  sendIndex: number
  expectedPriority: number
  priorityFee: number
  cuPrice: number
  slot: number | null
  index: number | null
  leader: string | null
}

interface TrialRow {
  run: string
  trial: number
  targetClient: string
  targetLeader: string
  windowStart: number
  fireSlot: number
  mode: string
  timing: string
  sendOrder: string[]
}

export interface Unit {
  run: string
  trial: number
  slot: number
  leader: string
  client: string
  version: string | null
  mode: string
  timing: string
  hitTarget: boolean
  /** landing slot minus the window start the burst aimed at */
  slotsAfterTarget: number
  /** 0..3: which slot of its leader's 4-slot window the block is */
  slotInWindow: number
  roles: string[]
  /** roles in block order */
  observedOrder: string
  tau: Record<Rule, number | null>
}

const score: Record<Rule, (t: TxRow) => number> = {
  rewardPerCost: (t) => t.expectedPriority,
  totalFee: (t) => t.priorityFee,
  cuPrice: (t) => t.cuPrice,
  sentFirst: (t) => -t.sendIndex,
}

export function loadRuns(runsRoot: string): { units: Unit[]; txs: TxRow[]; trials: TrialRow[]; blocks: Map<number, BlockSummary>; snapshots: Snapshot[] } {
  const units: Unit[] = []
  const allTxs: TxRow[] = []
  const allTrials: TrialRow[] = []
  const blocks = new Map<number, BlockSummary>()
  const snapshots: Snapshot[] = []
  if (!existsSync(runsRoot)) return { units, txs: allTxs, trials: allTrials, blocks, snapshots }
  for (const run of readdirSync(runsRoot).sort()) {
    const dir = join(runsRoot, run)
    if (!existsSync(join(dir, 'landed.json'))) continue
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    if (!meta.live) continue
    const snapshot: Snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
    snapshots.push(snapshot)
    const clientOf = new Map(snapshot.validators.map((v) => [v.identity, v]))
    for (const b of readJsonl<BlockSummary>(join(dir, 'blocks.jsonl'))) blocks.set(b.slot, b)
    const landed = new Map((JSON.parse(readFileSync(join(dir, 'landed.json'), 'utf8')) as Landed[]).map((l) => [l.signature, l]))
    const trials = readJsonl(join(dir, 'trials.jsonl')).filter((t) => t.live)
    const txs: TxRow[] = readJsonl(join(dir, 'txs.jsonl'))
      .filter((t) => t.live)
      .map((t) => {
        const l = landed.get(t.signature)
        return {
          run,
          trial: t.trial,
          role: t.role,
          signature: t.signature,
          sendIndex: t.sendIndex,
          expectedPriority: t.expectedPriority,
          priorityFee: Number(t.priorityFee),
          cuPrice: Number(t.cuPrice),
          slot: l?.slot ?? null,
          index: l?.index ?? null,
          leader: l?.leader ?? null,
        }
      })
    allTxs.push(...txs)
    for (const t of trials) {
      allTrials.push({ run, trial: t.trial, targetClient: t.client, targetLeader: t.leader, windowStart: t.windowStart, fireSlot: t.fireSlot, mode: t.mode, timing: t.timing, sendOrder: t.sendOrder })
      const mine = txs.filter((x) => x.trial === t.trial && x.slot !== null && x.index !== null)
      const bySlot = new Map<number, TxRow[]>()
      for (const x of mine) bySlot.set(x.slot!, [...(bySlot.get(x.slot!) ?? []), x])
      const groups = [...bySlot.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
      if (!groups.length || groups[0][1].length < 2) continue
      const [slot, group] = groups[0]
      const leader = group[0].leader ?? 'unknown'
      group.sort((a, b) => a.index! - b.index!)
      const earliness = group.map((x) => -x.index!)
      const tau = Object.fromEntries(RULES.map((r) => [r, kendallTau(group.map(score[r]), earliness)])) as Record<Rule, number | null>
      const v = clientOf.get(leader)
      units.push({
        run,
        trial: t.trial,
        slot,
        leader,
        client: v?.client ?? 'unknown',
        version: v?.version ?? null,
        mode: t.mode,
        timing: t.timing,
        hitTarget: leader === t.leader,
        slotsAfterTarget: slot - t.windowStart,
        slotInWindow: slot % LEADER_WINDOW,
        roles: group.map((x) => x.role),
        observedOrder: group.map((x) => x.role).join(''),
        tau,
      })
    }
  }
  return { units, txs: allTxs, trials: allTrials, blocks, snapshots }
}

/** Leader windows are 4 consecutive slots, aligned to multiples of 4 (epochs start on such a multiple). */
const LEADER_WINDOW = 4

export interface RuleStat {
  rule: Rule
  trials: number
  meanTau: number
  ci: [number, number]
  p: number
}

export function ruleStats(units: Unit[], seed = 1): RuleStat[] {
  return RULES.map((rule) => {
    const v = units.map((u) => u.tau[rule]).filter((x): x is number => x !== null)
    return { rule, trials: v.length, meanTau: mean(v), ci: bootstrapMeanCi(v, seed), p: signFlipP(v, seed) }
  })
}

/** The A/E twins differ only in send order: how often does the one sent first come first in the block? */
export function twinStat(units: Unit[], txs: TxRow[]): { pairs: number; sentFirstCameFirst: number; share: number; ci: [number, number]; p: number } {
  let pairs = 0
  let k = 0
  for (const u of units) {
    const a = txs.find((t) => t.run === u.run && t.trial === u.trial && t.role === 'A')
    const e = txs.find((t) => t.run === u.run && t.trial === u.trial && t.role === 'E')
    if (!a || !e || a.slot !== u.slot || e.slot !== u.slot) continue
    pairs++
    const first = a.sendIndex < e.sendIndex ? a : e
    const other = first === a ? e : a
    if (first.index! < other.index!) k++
  }
  return { pairs, sentFirstCameFirst: k, share: k / pairs, ci: wilson(k, pairs), p: binomialP(k, pairs) }
}

/**
 * Background: in every block that holds our transactions, how strongly does position follow the leader's reward per
 * cost unit among everyone else's successful transactions? rho < 0 means higher reward/cost sits earlier.
 */
export function backgroundRho(b: BlockSummary): number | null {
  const pos: number[] = []
  const prio: number[] = []
  b.rows.forEach(([, cost, , priorityFee, failed, sigs], i) => {
    if (failed || cost <= 0) return
    pos.push(i)
    prio.push((priorityFee + (sigs * Number(BASE_FEE_PER_SIGNATURE)) / 2) / cost)
  })
  return spearman(pos, prio)
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–')
const fp = (p: number) => (!Number.isFinite(p) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3))

export function analyze(dataDir: string, cluster: string): string {
  const runsRoot = join(dataDir, cluster, 'runs')
  const { units, txs, trials, blocks } = loadRuns(runsRoot)
  const out: string[] = []
  const sent = txs.length
  const landed = txs.filter((t) => t.slot !== null).length
  out.push(`# Results (generated by \`analyze\`; do not edit by hand)`, '')
  out.push(`Live trials: ${trials.length}; transactions sent: ${sent}; landed: ${landed} (${pct(landed / sent)}); blocks: ${blocks.size}.`)
  out.push(`Trials with at least two transactions in one block (units of analysis): ${units.length}.`)
  out.push(`Blocks produced by the targeted leader: ${units.filter((u) => u.hitTarget).length} of ${units.length}.`, '')

  const clients = [...new Set(units.map((u) => u.client))].sort((a, b) => units.filter((u) => u.client === b).length - units.filter((u) => u.client === a).length)
  out.push('## Agreement of in-block order with each candidate rule, by client', '')
  out.push('Mean Kendall tau per trial between the rule and earliness in the block; 95% bootstrap interval; sign-flip p-value.', '')
  out.push('| client | validators | trials | reward/cost | total fee | CU price | sent first |')
  out.push('|---|---:|---:|---|---|---|---|')
  const cell = (s: RuleStat) => (s.trials ? `${f2(s.meanTau)} [${f2(s.ci[0])}, ${f2(s.ci[1])}] p=${fp(s.p)}` : '–')
  const byClient: Record<string, unknown> = {}
  for (const c of [...clients, 'ALL']) {
    const us = c === 'ALL' ? units : units.filter((u) => u.client === c)
    const st = ruleStats(us)
    byClient[c] = { trials: us.length, validators: new Set(us.map((u) => u.leader)).size, rules: st }
    out.push(`| ${c} | ${new Set(us.map((u) => u.leader)).size} | ${us.length} | ${st.map(cell).join(' | ')} |`)
  }
  out.push('')

  out.push('## By contention and timing (all clients)', '')
  out.push('| mode | timing | trials | reward/cost | total fee | CU price | sent first |')
  out.push('|---|---|---:|---|---|---|---|')
  for (const mode of ['shared', 'independent'])
    for (const timing of ['early', 'inwindow']) {
      const us = units.filter((u) => u.mode === mode && u.timing === timing)
      out.push(`| ${mode} | ${timing} | ${us.length} | ${ruleStats(us).map(cell).join(' | ')} |`)
    }
  out.push('')

  const twin = twinStat(units, txs)
  out.push('## Twins A and E (identical fees, only the send order differs)', '')
  out.push(`Same block in ${twin.pairs} trials; the one sent first came first in ${twin.sentFirstCameFirst} (${pct(twin.share)}, 95% CI ${pct(twin.ci[0])}–${pct(twin.ci[1])}, binomial p=${fp(twin.p)}).`, '')

  out.push('## Exact orders', '')
  const full = units.filter((u) => u.roles.length === 5)
  const perfect = full.filter((u) => /^(AE|EA)DCB$/.test(u.observedOrder)).length
  out.push(`Trials with all five in one block: ${full.length}; in exact reward/cost order (A/E either way): ${perfect} (by chance: 2 in 120).`, '')

  out.push('## Background: everyone else in the same blocks', '')
  out.push('Spearman rho between position and reward/cost (fee to the leader per cost unit) over the other successful transactions; negative = higher reward/cost earlier.', '')
  out.push('| client | blocks | median rho | blocks with rho < 0 |')
  out.push('|---|---:|---|---|')
  const ourBlocks = new Map(units.map((u) => [u.slot, u.client]))
  for (const c of clients) {
    const rhos = [...ourBlocks.entries()]
      .filter(([, cl]) => cl === c)
      .map(([slot]) => (blocks.get(slot) ? backgroundRho(blocks.get(slot)!) : null))
      .filter((r): r is number => r !== null)
    out.push(`| ${c} | ${rhos.length} | ${f2(median(rhos))} | ${pct(rhos.filter((r) => r < 0).length / rhos.length)} |`)
  }
  out.push('')

  out.push('## Landing', '')
  out.push('| role | sent | landed | median slots after the target window start |')
  out.push('|---|---:|---:|---:|')
  for (const role of ['A', 'B', 'C', 'D', 'E']) {
    const r = txs.filter((t) => t.role === role)
    const l = r.filter((t) => t.slot !== null)
    const delays = l.map((t) => t.slot! - trials.find((x) => x.run === t.run && x.trial === t.trial)!.windowStart)
    out.push(`| ${role} | ${r.length} | ${l.length} | ${median(delays)} |`)
  }
  out.push('')

  const resultsDir = join(dataDir, cluster, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const md = out.join('\n')
  writeFileSync(join(resultsDir, 'results.md'), md + '\n')
  writeFileSync(join(resultsDir, 'units.json'), toJson(units, 1))
  writeFileSync(join(resultsDir, 'summary.json'), toJson({ byClient, twin, sent, landed, units: units.length }, 1))
  return md
}
