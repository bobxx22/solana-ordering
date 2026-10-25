// Turns the raw run files into the numbers of the report. Reads only committed data (no network), so anyone can
// rerun it; `verify` separately checks the raw data against the chain.
//
// Pre-registered analysis (README, "Noise versus rule"):
//   unit       one trial: its transactions that landed in the targeted leader's 4-slot window, ordered by (slot,
//              index); a transaction pushed to a later slot of the window counts as later. Landings outside the
//              window are counted as spill-over and left out.
//   primary    campaign "main", buffered/shared cell, the four local-scheduler labels (Agave, JitoLabs, Firedancer,
//              Rakurai), three decisive contrasts: A,E before F (per trial the mean of the two indicators), C before
//              B, D before C. Twelve tests, one-sided against chance by an exact sign-flip test, Holm-adjusted together.
//   control    A,E before C (same cost, strictly higher fee): every fee-aware rule agrees. A label that fails it is
//              reported as "no fee ordering detected", whatever its other pairs say.
//   secondary  descriptive: independent mode, burst and streamed (pooled over the local labels), the twins,
//              the pipelines (BAM, Harmonic), rule agreement (gamma), and calibration runs.
// The block producer is the scheduled leader of the landing slot; the client is that leader's gossip client id in
// the run's snapshot.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockRow, BlockSummary } from './block.ts'
import type { Landed } from './collect.ts'
import { BASE_FEE_PER_SIGNATURE, FIRE_OFFSET, LOCAL_CLIENTS, loadedDataCost, PIPELINE_CLIENTS } from './design.ts'
import type { Snapshot } from './discover.ts'
import { mean, median, signFlipP, spearman, wilson } from './stats.ts'
import { readJsonl, rng, toJson } from './util.ts'

/** First slot with Alpenglow active on mainnet; every measurement must be at or after it. */
export const ALPENGLOW_SLOT = 459_653_000
/** the campaign whose buffered/shared trials carry the confirmatory tests */
export const MAIN_CAMPAIGN = 'main'
const WINDOW_SLOTS = 4

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
  campaign: string
  path: string
  targetLeader: string
  targetClient: string
  windowStart: number
  slotAtSend: number
  mode: string
  /** the delivery, with its dispatch offset when that differs from the current design (calibration 1: buffered@-1) */
  delivery: string
  ingress: string
  ingressShared: number
  startedAt: string
  /** buffered bursts: ms between the leader acknowledging the last transaction and our clock seeing the window start */
  marginMs: number | null
}

export interface Unit {
  run: string
  trial: number
  campaign: string
  client: string
  leader: string
  version: string | null
  path: string
  mode: string
  delivery: string
  ingress: string
  ingressShared: number
  /** roles in (slot, index) order, within the targeted window */
  observedOrder: string
  slots: number[]
  /** transactions of the trial that landed outside the targeted window */
  spill: number
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
  /** per trial key (run#trial), the transactions that count: in the targeted window, in landing order */
  ordered: Map<string, Tx[]>
  runs: { id: string; campaign: string; startedAt: string; path: string; trials: number; minSlot: number | null; maxSlot: number | null; epochs: number[] }[]
}

const key = (t: { run: string; trial: number }) => `${t.run}#${t.trial}`

export function loadRuns(runsRoot: string): Loaded {
  const out: Loaded = { units: [], txs: [], trials: [], blocks: new Map(), ordered: new Map(), runs: [] }
  if (!existsSync(runsRoot)) return out
  for (const run of readdirSync(runsRoot).sort()) {
    const dir = join(runsRoot, run)
    if (!existsSync(join(dir, 'landed.json'))) continue
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    if (!meta.live) continue
    const campaign: string = meta.campaign ?? 'calibration'
    const snapshot: Snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
    const byIdentity = new Map(snapshot.validators.map((v) => [v.identity, v]))
    // ingress = the host of the advertised QUIC address: Harmonic gives validators separate ports on shared hosts
    const host = (addr: string) => addr.replace(/:\d+$/, '')
    const behind = new Map<string, number>()
    for (const v of snapshot.validators) if (v.tpuQuic && !v.delinquent && v.leaderSlots > 0) behind.set(host(v.tpuQuic), (behind.get(host(v.tpuQuic)) ?? 0) + 1)
    for (const b of readJsonl<BlockSummary>(join(dir, 'blocks.jsonl'))) out.blocks.set(b.slot, b)
    const landed = new Map((JSON.parse(readFileSync(join(dir, 'landed.json'), 'utf8')) as Landed[]).map((l) => [l.signature, l]))
    const offsets: Record<string, number> = meta.fireOffset ?? {}
    const margin = new Map<number, number | null>(readJsonl(join(dir, 'events.jsonl')).filter((e) => e.type === 'landing-check').map((e) => [e.trial, e.marginMs ?? null]))
    const trials: Trial[] = readJsonl(join(dir, 'trials.jsonl'))
      .filter((t) => t.live)
      .map((t) => {
        const delivery: string = t.delivery ?? `pilot-${t.timing}`
        const off = offsets[delivery]
        return {
          run,
          trial: t.trial,
          campaign,
          // the pilot predates these fields: it went through the public RPC with "early"/"inwindow" timing
          path: t.path ?? 'rpc',
          targetLeader: t.leader,
          targetClient: t.client,
          windowStart: t.windowStart,
          slotAtSend: t.slotAtSend ?? t.fireSlot,
          mode: t.mode,
          delivery: off !== undefined && off !== (FIRE_OFFSET as Record<string, number>)[delivery] ? `${delivery}@${off}` : delivery,
          ingress: t.tpuQuic ? host(t.tpuQuic) : t.leader,
          ingressShared: t.tpuQuic ? (behind.get(host(t.tpuQuic)) ?? 1) : 1,
          startedAt: meta.startedAt,
          marginMs: margin.get(t.trial) ?? null,
        }
      })
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
      campaign,
      startedAt: meta.startedAt,
      path: trials[0]?.path ?? '?',
      trials: trials.length,
      minSlot: slots.length ? Math.min(...slots) : null,
      maxSlot: slots.length ? Math.max(...slots) : null,
      epochs: [...new Set(slots.map((s) => Math.floor(s / 432_000)))],
    })

    for (const t of trials) {
      const mine = txs.filter((x) => x.trial === t.trial && x.slot !== null && x.index !== null)
      // direct path: only what landed in the targeted leader's window; rpc pilot: everything (it rarely hit its target)
      const inWindow = (x: Tx) => t.path === 'rpc' || (x.leader === t.targetLeader && x.slot! >= t.windowStart && x.slot! < t.windowStart + WINDOW_SLOTS)
      const group = mine.filter(inWindow).sort(earlier)
      out.ordered.set(key(t), group)
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
        campaign,
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
        spill: mine.length - group.length,
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

/** Mean gamma, a 95% bootstrap interval resampling ingress hosts (none with fewer than 3), and a sign-flip p over host means. */
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
  // trials through one host are not independent: the sign flip acts on host means
  return { rule, trials: v.length, clusters: clusters.length, meanGamma: mean(v), ci, p: signFlipP(clusters.map(mean), seed) }
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

/**
 * Contrasts between roles, one value per trial in [0, 1] (the mean when a contrast has two pairs). Chance is 0.5
 * for every contrast when the order is unrelated to the roles.
 */
export interface Contrast {
  name: string
  pairs: [string, string][]
  meaning: string
}
export const CONTROL: Contrast = { name: 'A,E before C', pairs: [['A', 'C'], ['E', 'C']], meaning: 'same cost, strictly higher fee: every fee-aware rule agrees (positive control)' }
export const PRIMARY: Contrast[] = [
  { name: 'A,E before F', pairs: [['A', 'F'], ['E', 'F']], meaning: 'same price and fee, F costs 8x: only a cost denominator puts A and E first' },
  { name: 'C before B', pairs: [['C', 'B']], meaning: 'reward/cost with half the base fee (both clients\' source) puts C first; prio fee/cost, price and total fee put B first' },
  { name: 'D before C', pairs: [['D', 'C']], meaning: 'reward/cost with half the base fee puts D first; counting the whole base fee, or cost alone, would put C first' },
]
export const SECONDARY: Contrast[] = [{ name: 'A before B', pairs: [['A', 'B']], meaning: 'every per-unit rule puts A first; total fee puts B first' }]

export interface ContrastStat {
  n: number
  share: number
  ci: [number, number]
  p: number
  pHolm?: number
}

export function contrastStat(units: Unit[], ordered: Map<string, Tx[]>, c: Contrast): ContrastStat {
  const values: number[] = []
  let pairs = 0
  let inOrder = 0
  for (const u of units) {
    const g = ordered.get(key(u)) ?? []
    const ind = c.pairs
      .map(([a, b]) => [g.findIndex((t) => t.role === a), g.findIndex((t) => t.role === b)])
      .filter(([i, j]) => i >= 0 && j >= 0)
      .map(([i, j]) => (i < j ? 1 : 0))
    if (!ind.length) continue
    values.push(ind.reduce((s, x) => s + x, 0) / ind.length)
    pairs += ind.length
    inOrder += ind.reduce((s, x) => s + x, 0)
  }
  const n = values.length
  // one-sided exact sign-flip test of the per-trial mean > 0.5 (symmetric under random order); the interval is the
  // Wilson interval of the pair share, which for two-pair contrasts is narrower than a per-trial interval would be
  const centred = values.map((x) => x - 0.5)
  const observed = centred.reduce((s, x) => s + x, 0)
  const twoSided = signFlipP(centred)
  const p = n === 0 ? NaN : observed > 0 ? twoSided / 2 : 1 - twoSided / 2
  return { n, share: inOrder / pairs, ci: wilson(inOrder, pairs), p }
}

/** The A/E twins differ only in send order: did the one sent first land first? */
export function twinStat(units: Unit[], ordered: Map<string, Tx[]>): ContrastStat {
  let n = 0
  let k = 0
  for (const u of units) {
    const g = ordered.get(key(u)) ?? []
    const a = g.find((t) => t.role === 'A')
    const e = g.find((t) => t.role === 'E')
    if (!a || !e) continue
    n++
    const first = a.sendIndex < e.sendIndex ? a : e
    if (g.indexOf(first) < g.indexOf(first === a ? e : a)) k++
  }
  return { n, share: k / n, ci: wilson(k, n), p: NaN }
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
const cellText = (s: ContrastStat, withP = true) => (s.n ? `${pct(s.share)} of ${s.n} [${pct(s.ci[0])}–${pct(s.ci[1])}]${withP ? ` p=${fp(s.pHolm ?? s.p)}` : ''}` : '–')

export function analyze(dataDir: string, cluster: string): string {
  const { units, txs, trials, blocks, ordered, runs } = loadRuns(join(dataDir, cluster, 'runs'))
  const out: string[] = []
  out.push('# Results (generated by `analyze` from the committed raw data; do not edit by hand)', '')
  out.push('The analysis plan is pre-registered in README ("Noise versus rule") and in the header of `src/analyze.ts`.', '')

  out.push('## Runs', '')
  out.push('| run (UTC start) | campaign | path | trials | slots | epochs | after Alpenglow |')
  out.push('|---|---|---|---:|---|---|---|')
  for (const r of runs)
    out.push(`| ${r.startedAt} | ${r.campaign} | ${r.path} | ${r.trials} | ${r.minSlot ?? '–'}–${r.maxSlot ?? '–'} | ${r.epochs.join(', ')} | ${r.minSlot !== null && r.minSlot >= ALPENGLOW_SLOT ? 'yes' : 'NO'} |`)
  out.push('')

  const tpu = units.filter((u) => u.path === 'tpu')
  const main = tpu.filter((u) => u.campaign === MAIN_CAMPAIGN)
  const local = (us: Unit[]) => us.filter((u) => LOCAL_CLIENTS.includes(u.client))

  // ---------- primary ----------
  out.push('## Primary: buffered/shared, local schedulers (campaign "main")', '')
  const primaryUnits = local(main.filter((u) => u.delivery === 'buffered' && u.mode === 'shared'))
  if (!primaryUnits.length) out.push('No trials of the main campaign yet.', '')
  else {
    out.push('Share of trials with the first-named role(s) first; 95% Wilson interval; one-sided exact sign-flip p against 50%, Holm-adjusted over the twelve primary tests. The control is reported first and is not part of the family.', '')
    out.push(`| client | trials | validators | hosts | control: ${CONTROL.name} | ${PRIMARY.map((c) => c.name).join(' | ')} |`)
    out.push(`|---|---:|---:|---:|---|${PRIMARY.map(() => '---').join('|')}|`)
    const rows = LOCAL_CLIENTS.map((c) => {
      const cu = primaryUnits.filter((u) => u.client === c)
      return { c, cu, control: contrastStat(cu, ordered, CONTROL), stats: PRIMARY.map((p) => contrastStat(cu, ordered, p)) }
    })
    holm(rows.flatMap((r) => r.stats))
    for (const r of rows)
      out.push(`| ${r.c} | ${r.cu.length} | ${new Set(r.cu.map((u) => u.leader)).size} | ${new Set(r.cu.map((u) => u.ingress)).size} | ${cellText(r.control)} | ${r.stats.map((s) => cellText(s)).join(' | ')} |`)
    out.push('')
  }
  out.push(...[CONTROL, ...PRIMARY, ...SECONDARY].map((c) => `- ${c.name}: ${c.meaning}.`), '')

  // ---------- secondary, descriptive ----------
  const describe = (title: string, us: Unit[], groups: { label: string; units: Unit[] }[]) => {
    if (!us.length) return
    out.push(`## ${title}`, '')
    out.push('Descriptive: shares with 95% Wilson intervals, no test.', '')
    out.push(`| group | trials | ${CONTROL.name} | ${[...PRIMARY, ...SECONDARY].map((c) => c.name).join(' | ')} | twins: sent first landed first |`)
    out.push(`|---|---:|---|${[...PRIMARY, ...SECONDARY].map(() => '---').join('|')}|---|`)
    for (const g of groups) {
      if (!g.units.length) continue
      out.push(`| ${g.label} | ${g.units.length} | ${[CONTROL, ...PRIMARY, ...SECONDARY].map((c) => cellText(contrastStat(g.units, ordered, c), false)).join(' | ')} | ${cellText(twinStat(g.units, ordered), false)} |`)
    }
    out.push('')
  }
  const byLabel = (us: Unit[], labels: string[]) => [
    ...labels.map((c) => ({ label: c, units: us.filter((u) => u.client === c) })),
    { label: 'local schedulers', units: local(us) },
  ]
  describe('Secondary: buffered/independent (campaign "main")', main.filter((u) => u.delivery === 'buffered' && u.mode === 'independent'), byLabel(main.filter((u) => u.delivery === 'buffered' && u.mode === 'independent'), LOCAL_CLIENTS))
  describe(
    'Secondary: during production, local schedulers pooled (campaign "main")',
    local(main.filter((u) => u.delivery !== 'buffered')),
    ['burst', 'streamed'].map((d) => ({ label: d, units: local(main.filter((u) => u.delivery === d)) })),
  )
  describe(
    'Pipelines: BAM and Harmonic labels, buffered/shared (campaign "main")',
    main.filter((u) => PIPELINE_CLIENTS.includes(u.client)),
    PIPELINE_CLIENTS.map((c) => ({ label: c, units: main.filter((u) => u.client === c && u.delivery === 'buffered' && u.mode === 'shared') })),
  )
  const calibration = tpu.filter((u) => u.campaign !== MAIN_CAMPAIGN)
  describe(
    'Calibration runs (not part of any test)',
    calibration,
    [...new Set(calibration.map((u) => `${u.delivery}/${u.mode}`))].sort().map((cell) => ({ label: cell, units: calibration.filter((u) => `${u.delivery}/${u.mode}` === cell) })),
  )

  // ---------- rule agreement ----------
  const ruleTable = (title: string, us: Unit[], rules: Rule[], labels: string[]) => {
    if (!us.length) return
    out.push(`## Rule agreement: ${title}`, '')
    out.push("Mean gamma per trial (+1: every pair the rule ranks differently landed in its order; 0: unrelated). The rules agree on most pairs by design: read the contrasts first. [95% interval resampling ingress hosts; – with fewer than 3], sign-flip p over host means, Holm-adjusted within the table.", '')
    out.push(`| group | trials | hosts | ${rules.map((r) => RULE_LABEL[r]).join(' | ')} |`)
    out.push(`|---|---:|---:|${rules.map(() => '---').join('|')}|`)
    const rows = [...labels.map((c) => ({ c, cu: us.filter((u) => u.client === c) })), { c: 'local schedulers', cu: local(us) }]
      .filter((r) => r.cu.length)
      .map((r) => ({ ...r, stats: rules.map((rule) => ruleStat(r.cu, rule)) }))
    holm(rows.flatMap((r) => r.stats))
    for (const r of rows) out.push(`| ${r.c} | ${r.cu.length} | ${new Set(r.cu.map((u) => u.ingress)).size} | ${r.stats.map((st) => (st.trials ? `${f2(st.meanGamma)} [${f2(st.ci[0])}, ${f2(st.ci[1])}] p=${fp(st.pHolm)}` : '–')).join(' | ')} |`)
    out.push('')
  }
  const direct: Rule[] = ['rewardPerCost', 'priorityPerCost', 'cuPrice', 'totalFee', 'sentFirst']
  ruleTable('buffered/shared (campaign "main")', main.filter((u) => u.delivery === 'buffered' && u.mode === 'shared'), direct, [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS])
  ruleTable('pilot through the public RPC (for comparison)', units.filter((u) => u.path === 'rpc'), ['rewardPerCost', 'cuPrice', 'totalFee', 'sentFirst', 'rpcReleasedFirst'], [...new Set(units.filter((u) => u.path === 'rpc').map((u) => u.client))])

  // ---------- delivery ----------
  out.push('## Delivery', '')
  out.push('| campaign / path / delivery | trials | sent | acknowledged by the leader\'s QUIC | landed | in the targeted window | trials used | spill-over | median slots from dispatch to landing | median gap between sends, ms | arrival margin before the window, ms (median, min) |')
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  const margins = (ts: Trial[]) => {
    const m = ts.map((t) => t.marginMs).filter((x): x is number => typeof x === 'number')
    return m.length ? `${Math.round(median(m))}, ${Math.round(Math.min(...m))}` : '–'
  }
  for (const c of [...new Set(trials.map((t) => `${t.campaign} / ${t.path} / ${t.delivery}`))]) {
    const ts = trials.filter((t) => `${t.campaign} / ${t.path} / ${t.delivery}` === c)
    const keys = new Set(ts.map(key))
    const xs = txs.filter((t) => keys.has(key(t)))
    const landed = xs.filter((t) => t.slot !== null)
    const inWindow = [...keys].reduce((s, k) => s + (ordered.get(k)?.length ?? 0), 0)
    const acked = xs.filter((x) => x.acked !== null)
    const used = units.filter((u) => keys.has(key(u)))
    const target = (x: Tx) => ts.find((y) => y.run === x.run && y.trial === x.trial)!
    const delays = landed.map((x) => x.slot! - target(x).slotAtSend)
    const gaps: number[] = []
    for (const t of ts) {
      const g = xs.filter((x) => x.run === t.run && x.trial === t.trial).sort((a, b) => a.sendIndex - b.sendIndex)
      for (let i = 1; i < g.length; i++) gaps.push(g[i].sentMs - g[i - 1].sentMs)
    }
    out.push(
      `| ${c} | ${ts.length} | ${xs.length} | ${acked.length ? `${acked.filter((x) => x.acked).length} (${pct(acked.filter((x) => x.acked).length / acked.length)})` : '–'} | ${landed.length} (${pct(landed.length / xs.length)}) | ${inWindow} | ${used.length} | ${used.reduce((s, u) => s + u.spill, 0)} | ${median(delays)} | ${median(gaps)} | ${margins(ts)} |`,
    )
  }
  out.push('')

  out.push('## Ingress: where the direct path delivered', '')
  out.push('BAM and Harmonic validators advertise QUIC addresses on shared gateway hosts; for them the measurement starts at the gateway, not at the validator. Statistics resample these hosts.', '')
  out.push('| client | trials used | validators | distinct ingress hosts | trials via a shared host | most validators behind one used host |')
  out.push('|---|---:|---:|---:|---:|---:|')
  for (const c of [...new Set(tpu.map((u) => u.client))].sort()) {
    const cu = tpu.filter((u) => u.client === c)
    out.push(`| ${c} | ${cu.length} | ${new Set(cu.map((u) => u.leader)).size} | ${new Set(cu.map((u) => u.ingress)).size} | ${cu.filter((u) => u.ingressShared > 1).length} | ${Math.max(...cu.map((u) => u.ingressShared))} |`)
  }
  out.push('')

  out.push('## Where our transactions stand in their blocks (direct path)', '')
  out.push("Median share of the block's other transactions (our own six excluded) with a lower reward per scheduled cost unit, and median position as a fraction of the block.", '')
  out.push('| role | landed | out-ranks (reward/cost) | position, buffered | position, burst | position, streamed |')
  out.push('|---|---:|---:|---:|---:|---:|')
  const trialOf = new Map(trials.map((t) => [key(t), t]))
  const ownIndices = new Map<string, Set<number>>()
  for (const t of txs) if (t.slot !== null && t.index !== null) ownIndices.set(`${t.slot}`, (ownIndices.get(`${t.slot}`) ?? new Set()).add(t.index))
  for (const role of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const ours = txs.filter((t) => t.role === role && t.slot !== null && t.index !== null && trialOf.get(key(t))?.path === 'tpu')
    const ranks: number[] = []
    const pos: Record<string, number[]> = { buffered: [], burst: [], streamed: [] }
    for (const t of ours) {
      const b = blocks.get(t.slot!)
      if (!b) continue
      const mine = (t.priorityFee + Number(BASE_FEE_PER_SIGNATURE) / 2) / (720 + 600 + 7 + t.cuLimit + loadedDataCost(t.loadedLimit))
      const own = ownIndices.get(`${t.slot}`) ?? new Set()
      const others = b.rows.filter((_, i) => !own.has(i)).map((r) => rowReward(r) / Math.max(1, rowCost(r)))
      ranks.push(others.filter((x) => x < mine).length / others.length)
      pos[trialOf.get(key(t))!.delivery]?.push(t.index! / b.txCount)
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
  for (const u of tpu) for (const s of u.slots) clientOfSlot.set(s, u.client)
  for (const c of [...new Set(clientOfSlot.values())].sort()) {
    const rs = [...clientOfSlot.entries()].filter(([, cl]) => cl === c).map(([slot]) => (blocks.get(slot) ? backgroundRho(blocks.get(slot)!, oursBySlot.get(slot) ?? new Set()) : null))
    const all = rs.map((r) => r?.all).filter((x): x is number => typeof x === 'number')
    const head = rs.map((r) => r?.head).filter((x): x is number => typeof x === 'number')
    out.push(`| ${c} | ${all.length} | ${f2(median(all))} | ${f2(median(head))} | ${pct(all.filter((x) => x < 0).length / all.length)} |`)
  }
  out.push('')

  out.push('## Exact orders (buffered/shared, campaign "main")', '')
  const full = main.filter((u) => u.delivery === 'buffered' && u.mode === 'shared' && u.observedOrder.length === 6)
  const exact = full.filter((u) => /^(AE|EA)DCFB$/.test(u.observedOrder)).length
  out.push(`Trials with all six in the targeted window: ${full.length}; in exact reward/cost order (A/E either way): ${exact} (by chance: 2 in 720).`, '')

  const resultsDir = join(dataDir, cluster, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const md = out.join('\n')
  writeFileSync(join(resultsDir, 'results.md'), md + '\n')
  writeFileSync(join(resultsDir, 'units.json'), toJson(units, 1))
  writeFileSync(join(resultsDir, 'summary.json'), toJson({ runs, units: units.length }, 1))
  return md
}
