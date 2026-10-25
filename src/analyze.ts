// Turns the raw run files into the numbers of the report. Reads only committed data (no network), so anyone can
// rerun it; `verify` separately checks the raw data against the chain.
//
// Unit of analysis: one trial. Its transactions that landed in the targeted leader's window are ordered by
// (slot, index); a transaction pushed to a later slot of the same window counts as later. The block producer is the
// scheduled leader of the landing slot; the client is that leader's gossip client id in the run's snapshot.
// For each candidate rule, the trial's gamma = (pairs in the rule's order - pairs against it) / pairs the rule ranks
// differently. Trials are averaged per client with a 95% bootstrap interval that resamples ingress addresses (the
// QUIC address the trial was delivered to: validators behind one shared gateway are not independent) and a sign-flip
// permutation test; p-values are Holm-adjusted within each table. The headline is the decisive pairs: single pairs
// of roles that separate the rules, one indicator per trial.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockRow, BlockSummary } from './block.ts'
import type { Landed } from './collect.ts'
import { BASE_FEE_PER_SIGNATURE, loadedDataCost } from './design.ts'
import type { Snapshot } from './discover.ts'
import { binomialP, mean, median, signFlipP, spearman, wilson } from './stats.ts'
import { readJsonl, rng, toJson } from './util.ts'

/** First slot with Alpenglow active on mainnet; every measurement must be at or after it. */
export const ALPENGLOW_SLOT = 459_653_000

export const RULES = ['rewardPerCost', 'priorityPerCost', 'cuPrice', 'totalFee', 'sentFirst', 'rpcReleasedFirst'] as const
export type Rule = (typeof RULES)[number]
const RULE_LABEL: Record<Rule, string> = {
  rewardPerCost: 'reward/cost',
  priorityPerCost: 'prio fee/cost',
  cuPrice: 'CU price',
  totalFee: 'total fee',
  sentFirst: 'sent first',
  rpcReleasedFirst: 'RPC released first',
}

export interface Tx {
  run: string
  trial: number
  role: string
  signature: string
  sendIndex: number
  cuLimit: number
  cuPrice: number
  loadedLimit: number
  priorityFee: number
  sentMs: number
  /** rpc path: dispatch time plus the RPC's response time ("released") */
  releasedMs: number | null
  /** tpu path: the leader's QUIC stack acknowledged the whole transaction */
  acked: boolean | null
  slot: number | null
  index: number | null
  leader: string | null
}

export interface Trial {
  run: string
  trial: number
  path: string
  targetLeader: string
  targetClient: string
  windowStart: number
  slotAtSend: number
  mode: string
  delivery: string
  ingress: string
  ingressShared: number
  startedAt: string
}

export interface Unit {
  run: string
  trial: number
  client: string
  leader: string
  version: string | null
  path: string
  mode: string
  delivery: string
  ingress: string
  ingressShared: number
  /** roles in (slot, index) order */
  observedOrder: string
  slots: number[]
  gamma: Record<Rule, number | null>
}

/** The scheduler's view of one of our transactions (cost as in design.ts, for any stored role parameters). */
function score(t: Tx, rule: Rule): number | null {
  const cost = 720 + 2 * 300 + 7 + t.cuLimit + loadedDataCost(t.loadedLimit) + 1
  switch (rule) {
    case 'rewardPerCost':
      return (t.priorityFee + Number(BASE_FEE_PER_SIGNATURE) / 2) / cost
    case 'priorityPerCost':
      return t.priorityFee / cost
    case 'cuPrice':
      return t.cuPrice
    case 'totalFee':
      return t.priorityFee
    case 'sentFirst':
      return -t.sendIndex
    case 'rpcReleasedFirst':
      return t.releasedMs === null ? null : -t.releasedMs
  }
}

/** Pairs of `group` (in landing order) the rule ranks differently: how many are in its order, how many against. */
function concordance(group: Tx[], rule: Rule): { agree: number; disagree: number } {
  let agree = 0
  let disagree = 0
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++) {
      const a = score(group[i], rule)
      const b = score(group[j], rule)
      if (a === null || b === null || a === b) continue
      if (a > b) agree++
      else disagree++
    }
  return { agree, disagree }
}

const earlier = (a: Tx, b: Tx) => a.slot! - b.slot! || a.index! - b.index!

export interface Loaded {
  units: Unit[]
  txs: Tx[]
  trials: Trial[]
  blocks: Map<number, BlockSummary>
  runs: { id: string; startedAt: string; path: string; trials: number; minSlot: number | null; maxSlot: number | null; epochs: number[] }[]
}

export function loadRuns(runsRoot: string): Loaded {
  const out: Loaded = { units: [], txs: [], trials: [], blocks: new Map(), runs: [] }
  if (!existsSync(runsRoot)) return out
  for (const run of readdirSync(runsRoot).sort()) {
    const dir = join(runsRoot, run)
    if (!existsSync(join(dir, 'landed.json'))) continue
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    if (!meta.live) continue
    const snapshot: Snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
    const byIdentity = new Map(snapshot.validators.map((v) => [v.identity, v]))
    // ingress = the host of the advertised QUIC address: Harmonic gives validators separate ports on shared hosts
    const host = (addr: string) => addr.replace(/:\d+$/, '')
    const behind = new Map<string, number>()
    for (const v of snapshot.validators) if (v.tpuQuic && !v.delinquent && v.leaderSlots > 0) behind.set(host(v.tpuQuic), (behind.get(host(v.tpuQuic)) ?? 0) + 1)
    for (const b of readJsonl<BlockSummary>(join(dir, 'blocks.jsonl'))) out.blocks.set(b.slot, b)
    const landed = new Map((JSON.parse(readFileSync(join(dir, 'landed.json'), 'utf8')) as Landed[]).map((l) => [l.signature, l]))
    const trials: Trial[] = readJsonl(join(dir, 'trials.jsonl'))
      .filter((t) => t.live)
      .map((t) => ({
        run,
        trial: t.trial,
        // the pilot predates these fields: it went through the public RPC with "early"/"inwindow" timing
        path: t.path ?? 'rpc',
        targetLeader: t.leader,
        targetClient: t.client,
        windowStart: t.windowStart,
        slotAtSend: t.slotAtSend ?? t.fireSlot,
        mode: t.mode,
        delivery: t.delivery ?? `pilot-${t.timing}`,
        ingress: t.tpuQuic ? host(t.tpuQuic) : t.leader,
        ingressShared: t.tpuQuic ? (behind.get(host(t.tpuQuic)) ?? 1) : 1,
        startedAt: meta.startedAt,
      }))
    const txs: Tx[] = readJsonl(join(dir, 'txs.jsonl'))
      .filter((t) => t.live)
      .map((t) => {
        const l = landed.get(t.signature)
        const sentMs = Date.parse(t.sentAt)
        const path = trials.find((x) => x.trial === t.trial)?.path
        return {
          run,
          trial: t.trial,
          role: t.role,
          signature: t.signature,
          sendIndex: t.sendIndex,
          cuLimit: t.cuLimit,
          cuPrice: Number(t.cuPrice),
          loadedLimit: t.loadedLimit ?? 16_384,
          priorityFee: Number(t.priorityFee),
          sentMs,
          releasedMs: path === 'rpc' && typeof t.ackMs === 'number' ? sentMs + t.ackMs : null,
          acked: path === 'tpu' ? ('ackAt' in t ? t.ackAt !== null : null) : null,
          slot: l?.slot ?? null,
          index: l?.index ?? null,
          leader: l?.leader ?? null,
        }
      })
    out.trials.push(...trials)
    out.txs.push(...txs)
    const slots = txs.filter((t) => t.slot !== null).map((t) => t.slot!)
    out.runs.push({
      id: run,
      startedAt: meta.startedAt,
      path: trials[0]?.path ?? '?',
      trials: trials.length,
      minSlot: slots.length ? Math.min(...slots) : null,
      maxSlot: slots.length ? Math.max(...slots) : null,
      epochs: [...new Set(slots.map((s) => Math.floor(s / 432_000)))],
    })

    for (const t of trials) {
      // direct path: only what landed with the targeted leader; rpc pilot: everything (its target was rarely hit)
      const group = txs
        .filter((x) => x.trial === t.trial && x.slot !== null && x.index !== null && (t.path === 'rpc' || x.leader === t.targetLeader))
        .sort(earlier)
      if (group.length < 2) continue
      const leader = t.path === 'rpc' ? (group[0].leader ?? 'unknown') : t.targetLeader
      const v = byIdentity.get(leader)
      const gamma = Object.fromEntries(
        RULES.map((r) => {
          const { agree, disagree } = concordance(group, r)
          return [r, agree + disagree ? (agree - disagree) / (agree + disagree) : null]
        }),
      ) as Record<Rule, number | null>
      out.units.push({
        run,
        trial: t.trial,
        client: v?.client ?? 'unknown',
        leader,
        version: v?.version ?? null,
        path: t.path,
        mode: t.mode,
        delivery: t.delivery,
        ingress: t.path === 'rpc' ? leader : t.ingress,
        ingressShared: t.ingressShared,
        observedOrder: group.map((x) => x.role).join(''),
        slots: [...new Set(group.map((x) => x.slot!))],
        gamma,
      })
    }
  }
  return out
}

export interface RuleStat {
  rule: Rule
  trials: number
  clusters: number
  meanGamma: number
  ci: [number, number]
  p: number
  pHolm?: number
}

/** Mean gamma, a 95% bootstrap interval resampling ingress addresses (none with fewer than 3), sign-flip p. */
export function ruleStat(units: Unit[], rule: Rule, seed = 1): RuleStat {
  const us = units.filter((u) => u.gamma[rule] !== null)
  const v = us.map((u) => u.gamma[rule] as number)
  const byCluster = new Map<string, number[]>()
  for (const u of us) byCluster.set(u.ingress, [...(byCluster.get(u.ingress) ?? []), u.gamma[rule] as number])
  const clusters = [...byCluster.values()]
  let ci: [number, number] = [NaN, NaN]
  if (clusters.length >= 3) {
    const random = rng(seed)
    const means: number[] = []
    for (let b = 0; b < 4000; b++) {
      let s = 0
      let n = 0
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[Math.floor(random() * clusters.length)]
        for (const x of c) s += x
        n += c.length
      }
      means.push(s / n)
    }
    means.sort((a, b) => a - b)
    ci = [means[100], means[3899]]
  }
  return { rule, trials: v.length, clusters: clusters.length, meanGamma: mean(v), ci, p: signFlipP(v, seed) }
}

/** Holm step-down adjustment, in place. */
export function holm(stats: { p: number; pHolm?: number }[]): void {
  const ok = stats.filter((s) => Number.isFinite(s.p)).sort((a, b) => a.p - b.p)
  let running = 0
  ok.forEach((s, i) => {
    running = Math.max(running, Math.min(1, s.p * (ok.length - i)))
    s.pHolm = running
  })
}

/** Single pairs of roles the design makes decisive; one indicator per trial. */
export const PAIRS: { name: string; first: string; second: string; meaning: string }[] = [
  { name: 'A before F', first: 'A', second: 'F', meaning: 'same price and fee, F costs 8x: only a cost denominator (reward/cost) puts A first' },
  { name: 'E before F', first: 'E', second: 'F', meaning: 'the same contrast with the twin, as a replication' },
  { name: 'C before B', first: 'C', second: 'B', meaning: 'reward/cost with the base-fee share puts C first; prio fee/cost, price and total fee put B first' },
  { name: 'A before B', first: 'A', second: 'B', meaning: 'every per-unit rule puts A first; total fee puts B first' },
  { name: 'D before C', first: 'D', second: 'C', meaning: 'every rule agrees (positive control)' },
]

export interface PairStat {
  n: number
  k: number
  share: number
  ci: [number, number]
  p: number
  pHolm?: number
}

function landedOrder(units: Unit[], txs: Tx[]): Map<string, Tx[]> {
  const byTrial = new Map<string, Tx[]>()
  for (const t of txs) {
    const k = `${t.run}#${t.trial}`
    byTrial.set(k, [...(byTrial.get(k) ?? []), t])
  }
  const out = new Map<string, Tx[]>()
  for (const u of units) {
    const k = `${u.run}#${u.trial}`
    out.set(
      k,
      (byTrial.get(k) ?? []).filter((t) => t.slot !== null && t.index !== null && (u.path === 'rpc' || t.leader === u.leader)).sort(earlier),
    )
  }
  return out
}

export function pairStat(units: Unit[], txs: Tx[], first: string, second: string): PairStat {
  let n = 0
  let k = 0
  for (const g of landedOrder(units, txs).values()) {
    const i = g.findIndex((t) => t.role === first)
    const j = g.findIndex((t) => t.role === second)
    if (i < 0 || j < 0) continue
    n++
    if (i < j) k++
  }
  return { n, k, share: k / n, ci: wilson(k, n), p: binomialP(k, n) }
}

/** The A/E twins differ only in send order: did the one sent first land first? */
export function twinStat(units: Unit[], txs: Tx[]): PairStat {
  let n = 0
  let k = 0
  for (const g of landedOrder(units, txs).values()) {
    const a = g.find((t) => t.role === 'A')
    const e = g.find((t) => t.role === 'E')
    if (!a || !e) continue
    n++
    const first = a.sendIndex < e.sendIndex ? a : e
    if (g.indexOf(first) < g.indexOf(first === a ? e : a)) k++
  }
  return { n, k, share: k / n, ci: wilson(k, n), p: binomialP(k, n) }
}

const rowCost = (r: BlockRow | number[]) => (r.length >= 10 ? (r[9] as number) : (r[1] as number))
const rowReward = (r: BlockRow | number[]) => (r[3] as number) + ((r[5] as number) * Number(BASE_FEE_PER_SIGNATURE)) / 2

/**
 * Everyone else in the blocks that hold our transactions: Spearman rho between position and reward per scheduled
 * cost unit (the scheduler's view before execution). Negative rho means higher reward/cost sits earlier. Our own
 * transactions are excluded; failed ones are kept (the scheduler cannot know in advance). Also over the first 10%.
 */
export function backgroundRho(b: BlockSummary, ours: Set<number>): { all: number | null; head: number | null } {
  const pos: number[] = []
  const prio: number[] = []
  b.rows.forEach((r, i) => {
    if (ours.has(i) || rowCost(r) <= 0) return
    pos.push(i)
    prio.push(rowReward(r) / rowCost(r))
  })
  const head = Math.max(3, Math.ceil(pos.length / 10))
  return { all: spearman(pos, prio), head: spearman(pos.slice(0, head), prio.slice(0, head)) }
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–')
const fp = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3))
const byCount = (units: Unit[]) => [...new Set(units.map((u) => u.client))].sort((a, b) => units.filter((u) => u.client === b).length - units.filter((u) => u.client === a).length)

export function analyze(dataDir: string, cluster: string): string {
  const { units, txs, trials, blocks, runs } = loadRuns(join(dataDir, cluster, 'runs'))
  const out: string[] = []
  out.push('# Results (generated by `analyze` from the committed raw data; do not edit by hand)', '')

  out.push('## Runs', '')
  out.push('| run (UTC start) | path | trials | slots | epochs | after Alpenglow |')
  out.push('|---|---|---:|---|---|---|')
  for (const r of runs)
    out.push(`| ${r.startedAt} | ${r.path} | ${r.trials} | ${r.minSlot ?? '–'}–${r.maxSlot ?? '–'} | ${r.epochs.join(', ')} | ${r.minSlot !== null && r.minSlot >= ALPENGLOW_SLOT ? 'yes' : 'NO'} |`)
  out.push('')

  out.push('## Delivery', '')
  out.push('| path / delivery | trials | sent | acknowledged by the leader\'s QUIC | landed | landed with the targeted leader | trials used (≥2 with the target) | median slots from dispatch to landing |')
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|')
  const cells = [...new Set(trials.map((t) => `${t.path} / ${t.delivery}`))]
  for (const c of cells) {
    const ts = trials.filter((t) => `${t.path} / ${t.delivery}` === c)
    const keys = new Set(ts.map((t) => `${t.run}#${t.trial}`))
    const xs = txs.filter((t) => keys.has(`${t.run}#${t.trial}`))
    const landed = xs.filter((t) => t.slot !== null)
    const target = (x: Tx) => ts.find((y) => y.run === x.run && y.trial === x.trial)!
    const onTarget = landed.filter((x) => x.leader === target(x).targetLeader).length
    const acked = xs.filter((x) => x.acked !== null)
    const used = units.filter((u) => keys.has(`${u.run}#${u.trial}`)).length
    const delays = landed.map((x) => x.slot! - target(x).slotAtSend)
    out.push(
      `| ${c} | ${ts.length} | ${xs.length} | ${acked.length ? `${acked.filter((x) => x.acked).length} (${pct(acked.filter((x) => x.acked).length / acked.length)})` : '–'} | ${landed.length} (${pct(landed.length / xs.length)}) | ${pct(onTarget / landed.length)} | ${used} | ${median(delays)} |`,
    )
  }
  out.push('')

  const tpuUnits = units.filter((u) => u.path === 'tpu')
  out.push('## Ingress: where the direct path delivered', '')
  out.push('BAM and Harmonic validators advertise QUIC addresses on shared gateway hosts; for them the measurement starts at the gateway, not at the validator. Statistics resample these hosts.', '')
  out.push('| client | trials used | validators | distinct ingress hosts | trials via a shared host | most validators behind one used host |')
  out.push('|---|---:|---:|---:|---:|---:|')
  for (const c of byCount(tpuUnits)) {
    const cu = tpuUnits.filter((u) => u.client === c)
    out.push(`| ${c} | ${cu.length} | ${new Set(cu.map((u) => u.leader)).size} | ${new Set(cu.map((u) => u.ingress)).size} | ${cu.filter((u) => u.ingressShared > 1).length} | ${Math.max(...cu.map((u) => u.ingressShared))} |`)
  }
  out.push('')

  const pairTable = (title: string, us: Unit[]) => {
    if (!us.length) return
    out.push(`## Decisive pairs: ${title}`, '')
    out.push('Share of trials where the first-named role landed first (slot, then index); 95% Wilson interval; exact binomial p against 50%, Holm-adjusted over the table.', '')
    out.push(`| client | trials | ${PAIRS.map((p) => p.name).join(' | ')} | twins: sent first landed first |`)
    out.push(`|---|---:|${PAIRS.map(() => '---').join('|')}|---|`)
    const rows: { c: string; n: number; stats: PairStat[] }[] = []
    for (const c of [...byCount(us), 'ALL']) {
      const cu = c === 'ALL' ? us : us.filter((u) => u.client === c)
      rows.push({ c, n: cu.length, stats: [...PAIRS.map((p) => pairStat(cu, txs, p.first, p.second)), twinStat(cu, txs)] })
    }
    holm(rows.filter((r) => r.c !== 'ALL').flatMap((r) => r.stats))
    holm(rows.filter((r) => r.c === 'ALL').flatMap((r) => r.stats))
    for (const r of rows) out.push(`| ${r.c} | ${r.n} | ${r.stats.map((st) => (st.n ? `${pct(st.share)} of ${st.n} [${pct(st.ci[0])}–${pct(st.ci[1])}] p=${fp(st.pHolm)}` : '–')).join(' | ')} |`)
    out.push('')
  }
  const ruleTable = (title: string, us: Unit[], rules: Rule[]) => {
    if (!us.length) return
    out.push(`## Rule agreement: ${title}`, '')
    out.push('Mean gamma per trial (+1: every pair the rule ranks differently landed in its order; 0: unrelated). The rules agree on most pairs by design, so read the decisive pairs first. [95% interval resampling ingress addresses; – with fewer than 3], Holm-adjusted p.', '')
    out.push(`| client | trials | ingresses | ${rules.map((r) => RULE_LABEL[r]).join(' | ')} |`)
    out.push(`|---|---:|---:|${rules.map(() => '---').join('|')}|`)
    const rows: { c: string; cu: Unit[]; stats: RuleStat[] }[] = []
    for (const c of [...byCount(us), 'ALL']) {
      const cu = c === 'ALL' ? us : us.filter((u) => u.client === c)
      rows.push({ c, cu, stats: rules.map((r) => ruleStat(cu, r)) })
    }
    holm(rows.filter((r) => r.c !== 'ALL').flatMap((r) => r.stats))
    holm(rows.filter((r) => r.c === 'ALL').flatMap((r) => r.stats))
    for (const r of rows)
      out.push(`| ${r.c} | ${r.cu.length} | ${new Set(r.cu.map((u) => u.ingress)).size} | ${r.stats.map((st) => (st.trials ? `${f2(st.meanGamma)} [${f2(st.ci[0])}, ${f2(st.ci[1])}] p=${fp(st.pHolm)}` : '–')).join(' | ')} |`)
    out.push('')
  }
  const direct: Rule[] = ['rewardPerCost', 'priorityPerCost', 'cuPrice', 'totalFee', 'sentFirst']
  for (const mode of ['shared', 'independent']) pairTable(`direct path, buffered, ${mode}`, tpuUnits.filter((u) => u.delivery === 'buffered' && u.mode === mode))
  pairTable('direct path, burst inside the window (both modes)', tpuUnits.filter((u) => u.delivery === 'burst'))
  pairTable('direct path, streamed 30 ms apart (both modes; arrival-order control)', tpuUnits.filter((u) => u.delivery === 'streamed'))
  out.push(...PAIRS.map((p) => `- ${p.name}: ${p.meaning}.`), '')
  for (const mode of ['shared', 'independent']) ruleTable(`direct path, buffered, ${mode}`, tpuUnits.filter((u) => u.delivery === 'buffered' && u.mode === mode), direct)
  ruleTable('direct path, burst inside the window', tpuUnits.filter((u) => u.delivery === 'burst'), direct)
  ruleTable('direct path, streamed', tpuUnits.filter((u) => u.delivery === 'streamed'), direct)
  ruleTable('pilot through the public RPC (for comparison)', units.filter((u) => u.path === 'rpc'), ['rewardPerCost', 'cuPrice', 'totalFee', 'sentFirst', 'rpcReleasedFirst'])

  out.push('## Where our transactions stand in their blocks (direct path)', '')
  out.push('Median share of the block\'s other transactions with a lower reward per scheduled cost unit (our rank among competitors), and median position as a fraction of the block.', '')
  out.push('| role | landed | out-ranks (reward/cost) | position, buffered | position, burst | position, streamed |')
  out.push('|---|---:|---:|---:|---:|---:|')
  const deliveryOf = new Map(trials.map((t) => [`${t.run}#${t.trial}`, t]))
  for (const role of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const ours = txs.filter((t) => t.role === role && t.slot !== null && t.index !== null && deliveryOf.get(`${t.run}#${t.trial}`)?.path === 'tpu')
    const ranks: number[] = []
    const pos: Record<string, number[]> = { buffered: [], burst: [], streamed: [] }
    for (const t of ours) {
      const b = blocks.get(t.slot!)
      if (!b) continue
      const mine = (t.priorityFee + Number(BASE_FEE_PER_SIGNATURE) / 2) / (720 + 600 + 7 + t.cuLimit + loadedDataCost(t.loadedLimit))
      const others = b.rows.filter((_, i) => i !== t.index).map((r) => rowReward(r) / Math.max(1, rowCost(r)))
      ranks.push(others.filter((x) => x < mine).length / others.length)
      pos[deliveryOf.get(`${t.run}#${t.trial}`)!.delivery]?.push(t.index! / b.txCount)
    }
    out.push(`| ${role} | ${ours.length} | ${pct(median(ranks))} | ${pct(median(pos.buffered))} | ${pct(median(pos.burst))} | ${pct(median(pos.streamed))} |`)
  }
  out.push('')

  out.push('## Background: everyone else in the same blocks', '')
  out.push('Spearman rho between position and reward per scheduled cost unit over the other transactions; negative = higher reward/cost earlier.', '')
  out.push('| client | blocks | median rho, whole block | median rho, first 10% | blocks with rho < 0 |')
  out.push('|---|---:|---|---|---|')
  const oursBySlot = new Map<number, Set<number>>()
  for (const t of txs) if (t.slot !== null && t.index !== null) oursBySlot.set(t.slot, (oursBySlot.get(t.slot) ?? new Set()).add(t.index))
  const clientOfSlot = new Map<number, string>()
  for (const u of tpuUnits) for (const s of u.slots) clientOfSlot.set(s, u.client)
  for (const c of [...new Set(clientOfSlot.values())].sort()) {
    const rs = [...clientOfSlot.entries()].filter(([, cl]) => cl === c).map(([slot]) => (blocks.get(slot) ? backgroundRho(blocks.get(slot)!, oursBySlot.get(slot) ?? new Set()) : null))
    const all = rs.map((r) => r?.all).filter((x): x is number => typeof x === 'number')
    const head = rs.map((r) => r?.head).filter((x): x is number => typeof x === 'number')
    out.push(`| ${c} | ${all.length} | ${f2(median(all))} | ${f2(median(head))} | ${pct(all.filter((x) => x < 0).length / all.length)} |`)
  }
  out.push('')

  out.push('## Exact orders (direct path, buffered)', '')
  const full = tpuUnits.filter((u) => u.delivery === 'buffered' && u.observedOrder.length === 6)
  const exact = full.filter((u) => /^(AE|EA)DCFB$/.test(u.observedOrder)).length
  out.push(`Trials with all six landed with the target: ${full.length}; in exact reward/cost order (A/E either way): ${exact} (by chance: 2 in 720).`, '')

  const resultsDir = join(dataDir, cluster, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const md = out.join('\n')
  writeFileSync(join(resultsDir, 'results.md'), md + '\n')
  writeFileSync(join(resultsDir, 'units.json'), toJson(units, 1))
  writeFileSync(join(resultsDir, 'summary.json'), toJson({ runs, units: units.length }, 1))
  return md
}
