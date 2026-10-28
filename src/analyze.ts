// Turns the raw run files into the numbers of the report. Reads only committed data (no network), so anyone can
// rerun it; `verify` separately checks the raw data against the chain. Every number REPORT.md quotes comes from here.
//
// Pre-registered analysis (README, "Noise versus rule"; frozen before the first trial of campaign "main", git tag
// prereg-main):
//   unit       one trial: its transactions that landed in the targeted leader's 4-slot window, ordered by (slot,
//              index); a transaction pushed to a later slot of the window counts as later. Landings outside the
//              window are counted as spill-over and left out. A contrast uses every trial in which both of its roles
//              landed in the window. (A trial counts towards the run's quota only with B, C, D, F and A or E in the
//              window: design.ts, countsTowardsQuota.)
//   primary    campaign "main", buffered/shared cell, the four local-scheduler labels (Agave, JitoLabs, Firedancer,
//              Rakurai; Agave pre-releases included, their priority formula is identical), three contrasts: A,E before
//              F (per trial the mean of the two indicators), C before B, D before C. Twelve tests, each one-sided
//              against chance by its exact null distribution, Holm-adjusted together; a test without data has p = 1.
//   verdict    insufficient data: fewer than 10 trials (below 8, even unanimous trials cannot pass the strictest
//              Holm step). Otherwise: holds: Holm p < 0.05. reversed: the upper end of the 95% interval of the
//              per-trial share < 0.5 (the opposite order dominates). no stable order: that upper end < 0.75 but not
//              < 0.5 (neither the near-deterministic order the source predicts nor the opposite). inconclusive:
//              anything else. Only "reversed" is read as evidence for an alternative rule.
//   control    A,E before C (same cost, strictly higher fee), outside the family. A label with fewer than 10 control
//              trials is "insufficient data"; one whose control has unadjusted p >= 0.05 is "no fee ordering
//              detected", whatever its other contrasts say.
//   pipelines  a secondary family, tested the same way: the four BAM and Harmonic labels, buffered/shared, control
//              and three contrasts, Holm within these twelve. A verdict describes the whole pipeline behind the
//              gateway, not a client's scheduler.
//   robustness reported, not tested: leave one validator out; per-validator shares; a one-sided sign-flip test over
//              validator means (pipelines: over ingress hosts), whose smallest possible p is 2^-k with k validators;
//              each label's coverage (validators, slot share, effective number, reachable share, validators
//              reached); a sensitivity analysis without reconnects, unknown or under-100 ms arrival margins or a
//              clock other than firstShred.
//   secondary  descriptive: independent mode, burst per label, streamed, the twins by version family, rule agreement
//              (gamma), calibration runs.
// Added after the main run, outside the plan, and marked so in results.md:
//   exploratory  the deviations from the exact reward/cost order, validator by validator; JitoLabs by advertised
//                QUIC port; send order against landing order, by cell; the slot share of the validators reached.
//   presentation total rows in the exact-order, delivery and coverage tables; the ingress table restricted to
//                campaign "main"; port, reconnect and arrival margin per trial in orders.md; the two charts of
//                REPORT.md (src/charts.ts).
// Confirmatory run (docs/CONFIRM.md; frozen before the first trial of campaign "confirm", git tag prereg-confirm):
//   unit       as above; campaign "confirm", buffered/shared, three of the four validators the exploratory deviations
//              table named (the fourth, 7cVfgArC, has had no leader slots since epoch 1070). Its trials enter only
//              their own section, the run list and orders.md.
//   H1         the JitoLabs validators EvnRmnMr and C8Bey3LK order by total fee: B before C, pooled, one-sided against
//              chance by its exact null distribution, like the primary contrasts.
//   H2         Firedancer JD549Hsb departs from the exact reward/cost order: the share of its trials with all six in
//              the window that are in that order (A/E either way), by the exact lower binomial tail against 80%.
//   verdict    Holm over the two tests. Fewer than 10 trials: insufficient data; otherwise confirmed when the Holm
//              p < 0.05, else not confirmed. Descriptive: the same per validator, and on the sensitivity filter.
// The block producer is the scheduled leader of the landing slot; the client is that leader's gossip client id in
// the run's snapshot.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockRow, BlockSummary } from './block.ts'
import { barChart } from './charts.ts'
import type { Landed } from './collect.ts'
import { BASE_FEE_PER_SIGNATURE, countsTowardsQuota, FIRE_OFFSET, LOCAL_CLIENTS, loadedDataCost, PIPELINE_CLIENTS, WINDOW_SLOTS } from './design.ts'
import type { Snapshot } from './discover.ts'
import { binomialLowerTail, bootstrapMeanCi, exactUpperTail, mean, median, pearson, signFlipP, signFlipUpperP, spearman, wilson } from './stats.ts'
import { readJsonl, rng, toJson } from './util.ts'

/**
 * First slot with Alpenglow active on mainnet; every measurement must be at or after it. It is the slot announced for
 * the switch from TowerBFT (https://solanacompass.com/news/alpenglow-is-pending-activation-on-solana-mainnet-with-
 * towerbft-set-to-retire-at-slot-459653000); on chain, the last block before it, slot 459 652 996, has block time
 * 2026-10-21 13:53:59 UTC.
 */
export const ALPENGLOW_SLOT = 459_653_000
/** the campaign whose buffered/shared trials carry the confirmatory tests */
export const MAIN_CAMPAIGN = 'main'
/** the campaign of the confirmatory run after the main run (docs/CONFIRM.md, git tag prereg-confirm) */
export const CONFIRM_CAMPAIGN = 'confirm'
/**
 * H1: JitoLabs validators whose main-run trials were all in the exact total-fee order. The third, 7cVfgArC, stopped
 * voting at slot 462 239 999 and has no leader slots in epochs 1070 and 1071, so it cannot be reached.
 */
export const CONFIRM_TOTAL_FEE = ['EvnRmnMr', 'C8Bey3LK']
/** H2: the Firedancer validator with 4 of 10 main-run trials in the exact reward/cost order */
export const CONFIRM_DEPARTS = 'JD549Hsb'
/** H2's reference rate: below 84%, the lower end of the Wilson interval of the other Firedancer validators' 20 of 20 */
export const CONFIRM_REFERENCE = 0.8
const ALPHA = 0.05
/** fewer trials than this give no verdict */
export const MIN_TRIALS = 10
/** below this upper bound a contrast is not the near-deterministic order the source predicts */
const NEAR_DETERMINISTIC = 0.75
/** labels pooled for the total rows and the send-order table */
const GROUPS: [string, string[]][] = [
  ['local schedulers', LOCAL_CLIENTS],
  ['BAM pipelines', ['AgaveBam', 'FireBAM']],
  ['Harmonic pipelines', ['HarmonicAgave', 'HarmonicFiredancer']],
]
const CELLS = ['buffered/shared', 'buffered/independent', 'burst/shared', 'streamed/shared', 'streamed/independent']
/** the exact reward/cost order, A and E either way */
const REWARD_COST = /^(AE|EA)DCFB$/
/** the exact total-fee order: B (10 000), D (9 000), then A, E and F (4 000 each) in any order, C (0) last */
const TOTAL_FEE = /^BD[AEF]{3}C$/

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
  /** tpu path: the leader's QUIC stack acknowledged the whole transaction; null without acknowledgement data */
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
  targetVersion: string | null
  windowStart: number
  slotAtSend: number
  mode: string
  /** the delivery, with its dispatch offset when that differs from the current design (calibration 1: buffered@-1) */
  delivery: string
  ingress: string
  ingressShared: number
  /** the port of the advertised QUIC address (null for the rpc pilot) */
  port: string | null
  clockSource: string | null
  reconnected: boolean
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
  family: string
  path: string
  mode: string
  delivery: string
  ingress: string
  ingressShared: number
  port: string | null
  clockSource: string | null
  reconnected: boolean
  marginMs: number | null
  /** roles in (slot, index) order, within the targeted window */
  observedOrder: string
  slots: number[]
  /** transactions of the trial that landed outside the targeted window */
  spill: number
  gamma: Record<Rule, number | null>
}

/**
 * How equal priorities are broken in the deployed source of the client's version (docs/schedulers.md). Only the tags
 * that were read are placed in a family; pipelines and Rakurai order outside the sources we read.
 */
export function versionFamily(client: string, version: string | null): string {
  if (PIPELINE_CLIENTS.includes(client)) return 'pipelines (order set outside the client)'
  if (client === 'Rakurai') return 'Rakurai (own scheduler, source not read)'
  if (client === 'Firedancer') return /^26\.10\.[34]$/.test(version ?? '') ? 'Firedancer 26.10.3-4 (treap ties)' : 'other versions (source not read)'
  if (version === '4.3.2') return 'Agave 4.3.2 (container-id ties)'
  if (['4.4.0-beta.1', '4.4.0-rc.0', '4.5.0-alpha.2'].includes(version ?? '')) return 'Agave 4.4/4.5 pre-releases (oldest-first ties)'
  return 'other versions (source not read)'
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
const key = (t: { run: string; trial: number }) => `${t.run}#${t.trial}`

export interface Loaded {
  units: Unit[]
  txs: Tx[]
  trials: Trial[]
  blocks: Map<number, BlockSummary>
  /** per trial key (run#trial), the transactions that count: in the targeted window, in landing order */
  ordered: Map<string, Tx[]>
  runs: { id: string; campaign: string; startedAt: string; path: string; trials: number; minSlot: number | null; maxSlot: number | null; epochs: number[] }[]
  /** live runs whose results were never collected (no landed.json): a problem to fix with `collect` */
  uncollected: string[]
  snapshots: { campaign: string; snapshot: Snapshot }[]
  /** per trial key, the roles that landed in the targeted leader's window (the pilot's ordered group is wider) */
  onTarget: Map<string, string[]>
  /** addresses a run of the campaign stopped targeting */
  excluded: { campaign: string; ingress: string }[]
}

export function loadRuns(runsRoot: string): Loaded {
  const out: Loaded = { units: [], txs: [], trials: [], blocks: new Map(), ordered: new Map(), runs: [], uncollected: [], snapshots: [], onTarget: new Map(), excluded: [] }
  if (!existsSync(runsRoot)) return out
  for (const run of readdirSync(runsRoot).sort()) {
    const dir = join(runsRoot, run)
    if (!existsSync(join(dir, 'run.json'))) continue
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    if (!meta.live) continue
    if (!existsSync(join(dir, 'landed.json'))) {
      if (readJsonl(join(dir, 'trials.jsonl')).length) out.uncollected.push(run)
      continue
    }
    const campaign: string = meta.campaign ?? 'calibration'
    const snapshot: Snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
    out.snapshots.push({ campaign, snapshot })
    const byIdentity = new Map(snapshot.validators.map((v) => [v.identity, v]))
    // ingress = the host of the advertised QUIC address: Harmonic gives validators separate ports on shared hosts
    const host = (addr: string) => addr.replace(/:\d+$/, '')
    const behind = new Map<string, number>()
    for (const v of snapshot.validators) if (v.tpuQuic && !v.delinquent && v.leaderSlots > 0) behind.set(host(v.tpuQuic), (behind.get(host(v.tpuQuic)) ?? 0) + 1)
    for (const b of readJsonl<BlockSummary>(join(dir, 'blocks.jsonl'))) out.blocks.set(b.slot, b)
    const landed = new Map((JSON.parse(readFileSync(join(dir, 'landed.json'), 'utf8')) as Landed[]).map((l) => [l.signature, l]))
    const offsets: Record<string, number> = meta.fireOffset ?? {}
    const events = readJsonl(join(dir, 'events.jsonl'))
    const margin = new Map<number, number | null>(events.filter((e) => e.type === 'landing-check').map((e) => [e.trial, e.marginMs ?? null]))
    for (const e of events) if (e.type === 'exclude') out.excluded.push({ campaign, ingress: e.ingress })
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
          targetVersion: t.version ?? null,
          windowStart: t.windowStart,
          slotAtSend: t.slotAtSend ?? t.fireSlot,
          mode: t.mode,
          delivery: off !== undefined && off !== (FIRE_OFFSET as Record<string, number>)[delivery] ? `${delivery}@${off}` : delivery,
          ingress: t.tpuQuic ? host(t.tpuQuic) : t.leader,
          ingressShared: t.tpuQuic ? (behind.get(host(t.tpuQuic)) ?? 1) : 1,
          port: t.tpuQuic ? t.tpuQuic.replace(/^.*:/, '') : null,
          clockSource: t.clockSource ?? null,
          reconnected: !!t.reconnected,
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
      const onTarget = (x: Tx) => x.leader === t.targetLeader && x.slot! >= t.windowStart && x.slot! < t.windowStart + WINDOW_SLOTS
      out.onTarget.set(key(t), mine.filter(onTarget).map((x) => x.role))
      // direct path: only what landed in the targeted leader's window; rpc pilot: everything (it rarely hit its target)
      const group = mine.filter((x) => t.path === 'rpc' || onTarget(x)).sort(earlier)
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
      const client = v?.client ?? 'unknown'
      out.units.push({
        run,
        trial: t.trial,
        campaign,
        client,
        leader,
        version: v?.version ?? null,
        family: versionFamily(client, v?.version ?? null),
        path: t.path,
        mode: t.mode,
        delivery: t.delivery,
        ingress: t.path === 'rpc' ? leader : t.ingress,
        ingressShared: t.ingressShared,
        port: t.port,
        clockSource: t.clockSource,
        reconnected: t.reconnected,
        marginMs: t.marginMs,
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

export interface ConfirmTest {
  hypothesis: string
  validators: string
  measure: string
  n: number
  share: number
  ci: [number, number]
  p: number
  pHolm?: number
  verdict?: string
}

export const confirmVerdict = (t: { n: number; p: number; pHolm?: number }) => (t.n < MIN_TRIALS ? 'insufficient data' : (t.pHolm ?? t.p) < ALPHA ? 'confirmed' : 'not confirmed')

/** The two pre-registered tests of the confirmatory run (docs/CONFIRM.md) on buffered/shared trials. */
export function confirmTests(units: Unit[], ordered: Map<string, Tx[]>): ConfirmTest[] {
  const trio = units.filter((u) => CONFIRM_TOTAL_FEE.some((v) => u.leader.startsWith(v)))
  const six = units.filter((u) => u.leader.startsWith(CONFIRM_DEPARTS) && u.observedOrder.length === 6)
  const exact = six.filter((u) => REWARD_COST.test(u.observedOrder)).length
  const tests: ConfirmTest[] = [
    { hypothesis: 'H1: orders by total fee', validators: `JitoLabs ${CONFIRM_TOTAL_FEE.join(', ')}`, measure: 'B before C (by chance 50%)', ...contrastStat(trio, ordered, B_BEFORE_C) },
    {
      hypothesis: 'H2: departs from the exact reward/cost order',
      validators: `Firedancer ${CONFIRM_DEPARTS}`,
      measure: `trials with all six in the exact reward/cost order (reference ${pct(CONFIRM_REFERENCE)})`,
      n: six.length,
      share: six.length ? exact / six.length : NaN,
      ci: wilson(exact, six.length),
      p: six.length ? binomialLowerTail(exact, six.length, CONFIRM_REFERENCE) : NaN,
    },
  ]
  for (const t of tests) if (!Number.isFinite(t.p)) t.p = 1
  holm(tests)
  for (const t of tests) t.verdict = confirmVerdict(t)
  return tests
}

/** Holm step-down adjustment, in place. A test without data enters the family with p = 1. */
export function holm(stats: { p: number; pHolm?: number }[]): void {
  const all = stats.map((s) => ({ s, p: Number.isFinite(s.p) ? s.p : 1 })).sort((a, b) => a.p - b.p)
  let running = 0
  all.forEach(({ s, p }, i) => {
    running = Math.max(running, Math.min(1, p * (all.length - i)))
    s.pHolm = running
  })
}

/** Contrasts between roles. Per trial, the share of its pairs in the named order; chance is 0.5. */
export interface Contrast {
  name: string
  pairs: [string, string][]
  meaning: string
}
export const CONTROL: Contrast = { name: 'A,E before C', pairs: [['A', 'C'], ['E', 'C']], meaning: 'same cost, strictly higher fee: every fee-aware rule agrees (positive control)' }
export const PRIMARY: Contrast[] = [
  { name: 'A,E before F', pairs: [['A', 'F'], ['E', 'F']], meaning: 'same price, fee and CU limit; F requests a 64 MiB loaded-data limit: only a cost that includes the requested loaded-data limit puts A and E first' },
  { name: 'C before B', pairs: [['C', 'B']], meaning: 'reward/cost with a base-fee share k > 0.12 puts C first; prio fee/cost, price and total fee put B first' },
  { name: 'D before C', pairs: [['D', 'C']], meaning: 'reward/cost with k < 0.84 puts D first; the whole base fee (k = 1) or cost alone would put C first' },
]
export const SECONDARY: Contrast[] = [{ name: 'A before B', pairs: [['A', 'B']], meaning: 'every per-unit rule puts A first; total fee puts B first' }]
/** H1 of the confirmatory run: the opposite of the primary "C before B" */
export const B_BEFORE_C: Contrast = { name: 'B before C', pairs: [['B', 'C']], meaning: 'total fee puts B first; reward/cost with k > 0.12 puts C first' }

export interface ContrastStat {
  n: number
  share: number
  ci: [number, number]
  p: number
  pHolm?: number
}

/**
 * Per trial, the share of the contrast's pairs that landed in the named order. Under random order a single pair is
 * 0 or 1 with probability 1/2; two pairs sharing a role (A,E vs F) give 0, 1/2 or 1 with probability 1/3 each. The
 * one-sided p is the exact upper tail of the sum under that null; the interval bootstraps trials.
 */
export function contrastStat(units: Unit[], ordered: Map<string, Tx[]>, c: Contrast, seed = 1): ContrastStat {
  const tv = trialValues(units, ordered, c)
  const values = tv.map((x) => x.value)
  const tables = tv.map((x) => (x.pairs === 1 ? [0.5, 0, 0.5] : [1 / 3, 1 / 3, 1 / 3]))
  const n = values.length
  if (!n) return { n, share: NaN, ci: [NaN, NaN], p: NaN }
  const p = exactUpperTail(tables, Math.round(values.reduce((s, x) => s + 2 * x, 0)))
  const share = mean(values)
  const ci: [number, number] = n >= 2 ? bootstrapMeanCi(values, seed) : [NaN, NaN]
  // a bootstrap of identical values collapses; fall back to the Wilson interval on trials
  if (ci[0] === ci[1]) {
    const w = wilson(Math.round(share * n), n)
    ci[0] = w[0]
    ci[1] = w[1]
  }
  return { n, share, ci, p }
}

/** Trials in which at least one of the contrast's pairs landed in the window: the share of those pairs in order. */
function trialValues(units: Unit[], ordered: Map<string, Tx[]>, c: Contrast): { u: Unit; value: number; pairs: number }[] {
  const out: { u: Unit; value: number; pairs: number }[] = []
  for (const u of units) {
    const g = ordered.get(key(u)) ?? []
    const ind = c.pairs
      .map(([a, b]) => [g.findIndex((t) => t.role === a), g.findIndex((t) => t.role === b)])
      .filter(([i, j]) => i >= 0 && j >= 0)
      .map(([i, j]) => (i < j ? 1 : 0))
    if (ind.length) out.push({ u, value: ind.reduce((s: number, x) => s + x, 0) / ind.length, pairs: ind.length })
  }
  return out
}

/**
 * The same contrast one level up: per cluster (validator, or ingress host for pipelines) the mean per-trial share
 * minus 0.5, and a one-sided sign-flip test over the clusters. It asks whether the order holds across the validators
 * reached rather than for the trials; with k clusters its p cannot go below 2^-k.
 */
export function clusterStat(units: Unit[], ordered: Map<string, Tx[]>, c: Contrast, clusterOf: (u: Unit) => string): { k: number; p: number } {
  const by = new Map<string, number[]>()
  for (const { u, value } of trialValues(units, ordered, c)) by.set(clusterOf(u), [...(by.get(clusterOf(u)) ?? []), value])
  const means = [...by.values()].map((v) => mean(v) - 0.5)
  return { k: means.length, p: signFlipUpperP(means) }
}

export type Verdict = 'holds' | 'reversed' | 'no stable order' | 'inconclusive' | 'insufficient data'
export function verdict(s: ContrastStat): Verdict {
  if (s.n < MIN_TRIALS) return 'insufficient data'
  if ((s.pHolm ?? s.p) < ALPHA) return 'holds'
  if (s.ci[1] < 0.5) return 'reversed'
  if (s.ci[1] < NEAR_DETERMINISTIC) return 'no stable order'
  return 'inconclusive'
}

/** The sensitivity filter: no reconnect before sending, an arrival margin of at least 100 ms, the firstShred clock. */
export const keptBySensitivity = (u: Unit) => !u.reconnected && u.marginMs !== null && u.marginMs >= 100 && (u.clockSource ?? 'firstShred') === 'firstShred'

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

/** What each verdict of each primary contrast says (docs/schedulers.md, "Reading the results"). */
const READING: Partial<Record<Verdict, string>>[] = [
  {
    holds: 'the requested loaded-data limit enters the ranking',
    reversed: 'F before A and E, which no candidate rule predicts',
    'no stable order': 'A, E and F in no stable order: consistent with the requested loaded-data limit not entering the ranking (the three would then tie)',
  },
  {
    holds: 'a base-fee share above 0.12 counts',
    reversed: 'B before C: the base fee does not count (prio fee/cost, price or total fee ranks)',
    'no stable order': 'no stable order between C and B',
  },
  {
    holds: 'the base-fee share is below 0.84',
    reversed: 'C before D: the whole base fee counts, or cost alone ranks',
    'no stable order': 'no stable order between D and C',
  },
]

/** Reading of a label's verdicts. Only "reversed" is read as an alternative rule; "no stable order" is not. */
export function interpret(control: ContrastStat, v: Verdict[]): string {
  if (control.n < MIN_TRIALS) return 'insufficient data'
  if (control.p >= ALPHA) return 'no fee ordering detected'
  if (v.every((x) => x === 'holds'))
    return 'consistent with reward per requested cost, the requested loaded-data limit included, with a base-fee share between 0.12 and 0.84 (the deployed source uses 0.5)'
  const parts = v.map((x, i) => READING[i][x]).filter((x): x is string => !!x)
  for (const open of ['inconclusive', 'insufficient data'] as Verdict[]) {
    const names = PRIMARY.filter((_, i) => v[i] === open).map((c) => c.name)
    if (names.length) parts.push(`${open}: ${names.join(', ')}`)
  }
  return parts.join('; ')
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–')
const pct1 = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '–')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–')
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–')
const fp = (p: number | undefined) => (p === undefined || !Number.isFinite(p) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3))
const cellText = (s: ContrastStat, withP = true) => (s.n ? `${pct(s.share)} of ${s.n} [${pct(s.ci[0])}–${pct(s.ci[1])}]${withP ? ` p=${fp(s.pHolm ?? s.p)}` : ''}` : '–')

/** A family of twelve tests (four labels, three contrasts) on a set of trials, Holm-adjusted together. */
function testFamily(us: Unit[], ordered: Map<string, Tx[]>, labels: string[] = LOCAL_CLIENTS) {
  const rows = labels.map((c) => {
    const cu = us.filter((u) => u.client === c)
    return { c, cu, control: contrastStat(cu, ordered, CONTROL), stats: PRIMARY.map((p) => contrastStat(cu, ordered, p)) }
  })
  holm(rows.flatMap((r) => r.stats))
  return rows
}

export function analyze(dataDir: string, cluster: string): string {
  const loaded = loadRuns(join(dataDir, cluster, 'runs'))
  const { blocks, ordered, runs, uncollected, snapshots, onTarget, excluded } = loaded
  // the confirmatory campaign has its own section and rows in the run list and orders.md; every other table covers the
  // main campaign and the runs before it, as when the main run was analysed
  const isConfirm = (t: { campaign: string }) => t.campaign === CONFIRM_CAMPAIGN
  const confirmRuns = new Set(loaded.trials.filter(isConfirm).map((t) => t.run))
  const units = loaded.units.filter((u) => !isConfirm(u))
  const trials = loaded.trials.filter((t) => !isConfirm(t))
  const txs = loaded.txs.filter((t) => !confirmRuns.has(t.run))
  const confirmAll = loaded.units.filter((u) => isConfirm(u) && u.path === 'tpu')
  const out: string[] = []
  const orders: string[] = []
  out.push('# Results (generated by `analyze` from the committed raw data; do not edit by hand)', '')
  out.push('The analysis plan is pre-registered in README ("Noise versus rule") and in the header of `src/analyze.ts`. Every number in REPORT.md is copied from this file.', '')

  out.push('## Runs', '')
  out.push('| run (UTC start) | campaign | path | trials | slots | epochs | after Alpenglow |')
  out.push('|---|---|---|---:|---|---|---|')
  for (const r of runs)
    out.push(`| ${r.startedAt} | ${r.campaign} | ${r.path} | ${r.trials} | ${r.minSlot ?? '–'}–${r.maxSlot ?? '–'} | ${r.epochs.join(', ')} | ${r.minSlot !== null && r.minSlot >= ALPENGLOW_SLOT ? 'yes' : 'NO'} |`)
  out.push('')
  if (uncollected.length) out.push(`**Problem:** live runs without collected results (run \`collect all\`): ${uncollected.join(', ')}.`, '')

  const tpu = units.filter((u) => u.path === 'tpu')
  const main = tpu.filter((u) => u.campaign === MAIN_CAMPAIGN)
  const local = (us: Unit[]) => us.filter((u) => LOCAL_CLIENTS.includes(u.client))
  const bufShared = (us: Unit[]) => us.filter((u) => u.delivery === 'buffered' && u.mode === 'shared')

  // ---------- primary, and the pipelines tested the same way ----------
  const family = (title: string, us: Unit[], labels: string[], subject: string) => {
    out.push(`## ${title}`, '')
    const rows = testFamily(us, ordered, labels)
    if (!us.length) {
      out.push('No trials of the main campaign yet.', '')
      return rows
    }
    out.push(
      `Per-trial share of pairs in the named order; 95% bootstrap interval over trials (the Wilson interval on trials when every trial has the same share); one-sided exact p against 0.5, Holm-adjusted over the twelve tests of this table. Verdicts: insufficient data (fewer than ${MIN_TRIALS} trials), holds (Holm p < ${ALPHA}), reversed (upper bound < 0.5), no stable order (upper bound < ${NEAR_DETERMINISTIC}), inconclusive. The control is outside the family: unadjusted p.`,
      '',
    )
    out.push(`| ${subject} | trials | validators | top validator's share | hosts | control: ${CONTROL.name} | ${PRIMARY.map((c) => c.name).join(' | ')} |`)
    out.push(`|---|---:|---:|---:|---:|---|${PRIMARY.map(() => '---').join('|')}|`)
    for (const r of rows) {
      const perValidator = new Map<string, number>()
      for (const u of r.cu) perValidator.set(u.leader, (perValidator.get(u.leader) ?? 0) + 1)
      const top = r.cu.length ? Math.max(...perValidator.values()) / r.cu.length : NaN
      out.push(
        `| ${r.c} | ${r.cu.length} | ${perValidator.size} | ${pct(top)} | ${new Set(r.cu.map((u) => u.ingress)).size} | ${cellText(r.control)} | ${r.stats.map((s) => `${cellText(s)} **${verdict(s)}**`).join(' | ')} |`,
      )
    }
    out.push('', `**Reading, per ${subject}** (from the verdicts, by the rule in docs/schedulers.md; it describes the validators of the label that we reached):`, '')
    for (const r of rows) out.push(`- ${r.c}: ${interpret(r.control, r.stats.map(verdict))}.`)
    out.push('')
    return rows
  }
  const primaryUnits = local(bufShared(main))
  const rows = family('Primary: buffered/shared, local schedulers (campaign "main")', primaryUnits, LOCAL_CLIENTS, 'label')
  out.push(...[CONTROL, ...PRIMARY, ...SECONDARY].map((c) => `- ${c.name}: ${c.meaning}.`), '')
  const pipelineUnits = bufShared(main).filter((u) => PIPELINE_CLIENTS.includes(u.client))
  family('Pipelines: BAM and Harmonic labels, buffered/shared (campaign "main"; secondary family)', pipelineUnits, PIPELINE_CLIENTS, 'pipeline')

  // ---------- robustness of the primary ----------
  if (primaryUnits.length) {
    out.push('## Robustness of the primary', '')
    out.push('Leave one validator out: the twelve tests rerun without each validator in turn. Worst (largest) Holm p over the reruns, and whether any rerun changes the verdict.', '')
    out.push(`| client | ${PRIMARY.map((c) => c.name).join(' | ')} |`)
    out.push(`|---|${PRIMARY.map(() => '---').join('|')}|`)
    const base = rows.map((r) => r.stats.map(verdict))
    const worst = rows.map((r) => r.stats.map(() => ({ p: 0, changed: false })))
    for (const v of new Set(primaryUnits.map((u) => u.leader))) {
      const rerun = testFamily(
        primaryUnits.filter((u) => u.leader !== v),
        ordered,
      )
      rerun.forEach((r, i) =>
        r.stats.forEach((s, j) => {
          worst[i][j].p = Math.max(worst[i][j].p, s.pHolm ?? 1)
          if (verdict(s) !== base[i][j]) worst[i][j].changed = true
        }),
      )
    }
    rows.forEach((r, i) => out.push(`| ${r.c} | ${worst[i].map((w, j) => `${base[i][j]}; worst p=${fp(w.p)}${w.changed ? ', **changes**' : ''}`).join(' | ')} |`))
    out.push('')
    out.push('Per validator (at least 5 primary trials), descriptive:', '')
    out.push(`| client | validator | version | trials | ${CONTROL.name} | ${PRIMARY.map((c) => c.name).join(' | ')} |`)
    out.push(`|---|---|---|---:|---|${PRIMARY.map(() => '---').join('|')}|`)
    for (const c of LOCAL_CLIENTS)
      for (const v of new Set(primaryUnits.filter((u) => u.client === c).map((u) => u.leader))) {
        const vu = primaryUnits.filter((u) => u.leader === v)
        if (vu.length < 5) continue
        out.push(`| ${c} | ${v.slice(0, 8)} | ${vu[0].version ?? '?'} | ${vu.length} | ${[CONTROL, ...PRIMARY].map((k) => cellText(contrastStat(vu, ordered, k), false)).join(' | ')} |`)
      }
    out.push('')
    out.push('Sensitivity: the same contrasts without trials that reconnected before sending, had an unknown arrival margin (not all six acknowledged) or one under 100 ms, or ran on a clock other than firstShred (unadjusted p).', '')
    out.push(`| client | trials kept | ${CONTROL.name} | ${PRIMARY.map((c) => c.name).join(' | ')} |`)
    out.push(`|---|---:|---|${PRIMARY.map(() => '---').join('|')}|`)
    const clean = primaryUnits.filter(keptBySensitivity)
    for (const c of LOCAL_CLIENTS) {
      const cu = clean.filter((u) => u.client === c)
      out.push(`| ${c} | ${cu.length} | ${[CONTROL, ...PRIMARY].map((k) => cellText(contrastStat(cu, ordered, k))).join(' | ')} |`)
    }
    out.push('')
  }
  const clusterTable = (us: Unit[], labels: string[], by: string, clusterOf: (u: Unit) => string) => {
    out.push(`| client | ${by} | ${[CONTROL, ...PRIMARY].map((c) => c.name).join(' | ')} |`)
    out.push(`|---|---:|${[CONTROL, ...PRIMARY].map(() => '---').join('|')}|`)
    for (const c of labels) {
      const cu = us.filter((u) => u.client === c)
      if (!cu.length) continue
      const st = [CONTROL, ...PRIMARY].map((k) => clusterStat(cu, ordered, k, clusterOf))
      out.push(`| ${c} | ${new Set(cu.map(clusterOf)).size} | ${st.map((x) => (x.k ? `p=${fp(x.p)} (k=${x.k}, smallest possible ${fp(2 ** -x.k)})` : '–')).join(' | ')} |`)
    }
    out.push('')
  }
  if (primaryUnits.length || pipelineUnits.length) {
    out.push('## Validator level', '')
    out.push('Each label\'s trials grouped by validator (pipelines: by ingress host); per group the mean share minus 0.5; one-sided sign-flip test over the groups (unadjusted). It asks whether the order holds across the validators reached, not only across trials; with k groups p cannot go below 2^-k.', '')
    if (primaryUnits.length) clusterTable(primaryUnits, LOCAL_CLIENTS, 'validators', (u) => u.leader)
    if (pipelineUnits.length) clusterTable(pipelineUnits, PIPELINE_CLIENTS, 'hosts', (u) => u.ingress)
  }

  // ---------- secondary, descriptive ----------
  const describe = (title: string, groups: { label: string; units: Unit[] }[]) => {
    if (!groups.some((g) => g.units.length)) return
    out.push(`## ${title}`, '')
    out.push('Descriptive: per-trial shares with 95% intervals, no test.', '')
    out.push(`| group | trials | ${CONTROL.name} | ${[...PRIMARY, ...SECONDARY].map((c) => c.name).join(' | ')} | twins: sent first landed first |`)
    out.push(`|---|---:|---|${[...PRIMARY, ...SECONDARY].map(() => '---').join('|')}|---|`)
    for (const g of groups) {
      if (!g.units.length) continue
      out.push(`| ${g.label} | ${g.units.length} | ${[CONTROL, ...PRIMARY, ...SECONDARY].map((c) => cellText(contrastStat(g.units, ordered, c), false)).join(' | ')} | ${cellText(twinStat(g.units, ordered), false)} |`)
    }
    out.push('')
  }
  const byLabel = (us: Unit[], labels: string[]) => [...labels.map((c) => ({ label: c, units: us.filter((u) => u.client === c) })), { label: 'local schedulers', units: local(us) }]
  describe('Secondary: buffered/independent (campaign "main")', byLabel(main.filter((u) => u.delivery === 'buffered' && u.mode === 'independent'), LOCAL_CLIENTS))
  describe('Secondary: burst inside the window, per label (campaign "main")', byLabel(main.filter((u) => u.delivery === 'burst'), LOCAL_CLIENTS))
  describe('Secondary: streamed 30 ms apart, local schedulers (campaign "main")', [
    { label: 'streamed/shared', units: local(main.filter((u) => u.delivery === 'streamed' && u.mode === 'shared')) },
    { label: 'streamed/independent', units: local(main.filter((u) => u.delivery === 'streamed' && u.mode === 'independent')) },
  ])
  const families = [...new Set(tpu.map((u) => u.family))].sort()
  describe(
    'Twins by how the deployed version breaks ties (buffered/shared, all labels, campaign "main")',
    families.map((f) => ({ label: f, units: bufShared(main).filter((u) => u.family === f) })),
  )
  const calibration = tpu.filter((u) => u.campaign !== MAIN_CAMPAIGN)
  describe(
    'Calibration and rehearsal runs (all labels; not part of any test)',
    [...new Set(calibration.map((u) => `${u.campaign}: ${u.delivery}/${u.mode}`))].sort().map((cell) => ({ label: cell, units: calibration.filter((u) => `${u.campaign}: ${u.delivery}/${u.mode}` === cell) })),
  )

  // ---------- exact orders ----------
  out.push('## Exact orders (buffered/shared, campaign "main")', '')
  out.push('Share of trials with all six in the window in exact reward/cost order (A/E either way; 2 in 720 by chance), and the pair of the reward/cost order most often reversed. The last three rows, added after the main run, pool the labels above.', '')
  out.push('| client | trials with all six | exact | most often reversed |')
  out.push('|---|---:|---:|---|')
  const ideal = ['A', 'E', 'D', 'C', 'F', 'B']
  const exactBars: { label: string; trials: number; exact: number }[] = []
  const exactRow = (label: string, labels: string[]) => {
    const full = bufShared(main).filter((u) => labels.includes(u.client) && u.observedOrder.length === 6)
    if (!full.length) return
    const exact = full.filter((u) => REWARD_COST.test(u.observedOrder)).length
    if (labels.length === 1) exactBars.push({ label, trials: full.length, exact })
    const flips = new Map<string, number>()
    for (const u of full)
      for (let i = 0; i < ideal.length; i++)
        for (let j = i + 1; j < ideal.length; j++) {
          if (ideal[i] + ideal[j] === 'AE') continue
          if (u.observedOrder.indexOf(ideal[i]) > u.observedOrder.indexOf(ideal[j])) flips.set(`${ideal[i]}<${ideal[j]}`, (flips.get(`${ideal[i]}<${ideal[j]}`) ?? 0) + 1)
        }
    const top = [...flips.entries()].sort((a, b) => b[1] - a[1])[0]
    out.push(`| ${label} | ${full.length} | ${exact} (${pct(exact / full.length)}) | ${top ? `${top[0]} reversed in ${top[1]}` : '–'} |`)
  }
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) exactRow(c, [c])
  for (const [label, labels] of GROUPS) exactRow(label, labels)
  out.push('')

  // ---------- exploratory: added after the main run, not pre-registered ----------
  const ports = (us: Unit[]) => [...new Set(us.map((u) => u.port ?? '–'))].join(', ')
  const deviations: string[] = []
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) {
    const full = bufShared(main).filter((u) => u.client === c && u.observedOrder.length === 6)
    const exactOnly: Unit[] = []
    let exactValidators = 0
    for (const v of new Set(full.map((u) => u.leader))) {
      const vu = full.filter((u) => u.leader === v)
      const rewardCost = vu.filter((u) => REWARD_COST.test(u.observedOrder)).length
      if (rewardCost === vu.length) {
        exactValidators++
        exactOnly.push(...vu)
        continue
      }
      const totalFee = vu.filter((u) => TOTAL_FEE.test(u.observedOrder)).length
      const others = new Map<string, number>()
      for (const u of vu) if (!REWARD_COST.test(u.observedOrder) && !TOTAL_FEE.test(u.observedOrder)) others.set(u.observedOrder, (others.get(u.observedOrder) ?? 0) + 1)
      deviations.push(
        `| ${c} | ${v.slice(0, 8)} | ${vu[0].version ?? '?'} | ${ports(vu)} | ${vu.length} | ${rewardCost} | ${totalFee} | ${[...others.entries()].sort().map(([o, n]) => `${o} ×${n}`).join(', ') || '–'} | ${vu.filter(keptBySensitivity).length} |`,
      )
    }
    if (exactValidators && exactOnly.length < full.length) deviations.push(`| ${c} | all ${exactValidators} others | | | ${exactOnly.length} | ${exactOnly.length} | 0 | – | ${exactOnly.filter(keptBySensitivity).length} |`)
  }
  if (deviations.length) {
    out.push('## Deviations from the reward/cost order, validator by validator (exploratory)', '')
    out.push('Added after the main run, outside the pre-registered plan. Buffered/shared trials of the main campaign with all six in the window, for every validator with at least one trial not in the exact reward/cost order (A/E either way, D C F B): the port of its advertised QUIC address, how many trials were in that order, how many in the exact total-fee order (B D, then A, E, F in any order, C last), the other orders seen, and how many trials the sensitivity filter of the primary keeps (no reconnect before sending, an arrival margin of at least 100 ms, the firstShred clock). Labels without a row had every trial in the exact reward/cost order.', '')
    out.push('| client | validator | version | QUIC port | trials with all six | exact reward/cost | exact total fee | other orders | kept by the sensitivity filter |')
    out.push('|---|---|---|---|---:|---:|---:|---|---:|')
    out.push(...deviations, '')
  }
  const jito = bufShared(main).filter((u) => u.client === 'JitoLabs' && u.observedOrder.length === 6)
  if (jito.length) {
    out.push('## JitoLabs by advertised QUIC port (exploratory)', '')
    out.push('Added after the main run, outside the pre-registered plan. The same JitoLabs trials, grouped by the port of the QUIC address the validator advertised. Port 11228 is most likely a Jito relayer in front of the validator (README, "Shared gateways").', '')
    out.push('| port | validators | trials with all six | exact reward/cost | exact total fee | other orders |')
    out.push('|---|---:|---:|---:|---:|---:|')
    const byPort = new Map<string, Unit[]>()
    for (const u of jito) byPort.set(u.port ?? '–', [...(byPort.get(u.port ?? '–') ?? []), u])
    for (const [p, us] of [...byPort.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const rewardCost = us.filter((u) => REWARD_COST.test(u.observedOrder)).length
      const totalFee = us.filter((u) => TOTAL_FEE.test(u.observedOrder)).length
      out.push(`| ${p} | ${new Set(us.map((u) => u.leader)).size} | ${us.length} | ${rewardCost} | ${totalFee} | ${us.length - rewardCost - totalFee} |`)
    }
    out.push('')
  }
  const sendRows: string[] = []
  const sendBars: { cell: string; pairs: number; inOrder: number }[] = []
  for (const [group, labels] of GROUPS)
    for (const cell of CELLS) {
      const us = main.filter((u) => labels.includes(u.client) && `${u.delivery}/${u.mode}` === cell)
      if (!us.length) continue
      let pairs = 0
      let inOrder = 0
      let whole = 0
      for (const u of us) {
        const g = ordered.get(key(u)) ?? []
        for (let i = 0; i < g.length; i++)
          for (let j = i + 1; j < g.length; j++) {
            pairs++
            if (g[i].sendIndex < g[j].sendIndex) inOrder++
          }
        if (g.every((t, i) => i === 0 || g[i - 1].sendIndex < t.sendIndex)) whole++
      }
      const gammas = us.map((u) => u.gamma.sentFirst).filter((x): x is number => x !== null)
      if (labels === LOCAL_CLIENTS) sendBars.push({ cell, pairs, inOrder })
      sendRows.push(`| ${group} | ${cell} | ${us.length} | ${inOrder} of ${pairs} (${pct(inOrder / pairs)}) | ${whole} of ${us.length} | ${f2(mean(gammas))} |`)
    }
  if (sendRows.length) {
    out.push('## Send order against landing order, by cell (exploratory)', '')
    out.push('Added after the main run, outside the pre-registered plan. Campaign "main", every cell: of all pairs of a trial\'s transactions in the targeted window, how many landed in the order they were sent; how many trials landed entirely in send order; and the mean gamma of the send order (the "sent first" rule of the rule-agreement tables). The send order is a fresh random permutation in every trial, so 50% of pairs is what an order unrelated to sending gives.', '')
    out.push('| group | cell | trials | pairs in send order | trials entirely in send order | mean gamma, sent first |')
    out.push('|---|---|---:|---:|---:|---:|')
    out.push(...sendRows, '')
  }

  // ---------- the confirmatory run, pre-registered after the main run ----------
  out.push('## Confirmatory run (campaign "confirm"; pre-registered in docs/CONFIRM.md, git tag prereg-confirm)', '')
  out.push('New buffered/shared trials aimed at three of the four validators whose main-run trials departed from the reward/cost order ("Deviations from the reward/cost order, validator by validator"; the fourth, 7cVfgArC, has had no leader slots since epoch 1070), planned and tagged before the first of them. Two tests, Holm-adjusted together: H1 one-sided against chance by its exact null distribution, like the primary contrasts; H2 by the exact lower binomial tail against the reference rate. Fewer than 10 trials: insufficient data; otherwise confirmed when the Holm p < 0.05, else not confirmed. These trials appear only in this section, the run list and orders.md.', '')
  const confirm = bufShared(confirmAll)
  if (!confirm.length) out.push('No trials of the confirmatory campaign yet.', '')
  else {
    out.push('| hypothesis | validators | measure | trials | share [95% interval] | p | Holm p | verdict |')
    out.push('|---|---|---|---:|---|---:|---:|---|')
    for (const t of confirmTests(confirm, ordered)) out.push(`| ${t.hypothesis} | ${t.validators} | ${t.measure} | ${t.n} | ${t.n ? `${pct(t.share)} [${pct(t.ci[0])}–${pct(t.ci[1])}]` : '–'} | ${fp(t.p)} | ${fp(t.pHolm)} | **${t.verdict}** |`)
    out.push('', 'Per validator (descriptive). B before C: of the trials with both in the window.', '')
    out.push('| client | validator | versions | QUIC port | trials | trials with all six | exact reward/cost | exact total fee | other orders | B before C | kept by the sensitivity filter |')
    out.push('|---|---|---|---|---:|---:|---:|---:|---|---:|---:|')
    for (const v of [...CONFIRM_TOTAL_FEE, CONFIRM_DEPARTS]) {
      const us = confirm.filter((u) => u.leader.startsWith(v))
      if (!us.length) {
        out.push(`| | ${v} | | | 0 | | | | | | |`)
        continue
      }
      const six = us.filter((u) => u.observedOrder.length === 6)
      const others = new Map<string, number>()
      for (const u of six) if (!REWARD_COST.test(u.observedOrder) && !TOTAL_FEE.test(u.observedOrder)) others.set(u.observedOrder, (others.get(u.observedOrder) ?? 0) + 1)
      const bc = trialValues(us, ordered, B_BEFORE_C)
      out.push(
        `| ${us[0].client} | ${v} | ${[...new Set(us.map((u) => u.version ?? '?'))].join(', ')} | ${[...new Set(us.map((u) => u.port ?? '–'))].join(', ')} | ${us.length} | ${six.length} | ${six.filter((u) => REWARD_COST.test(u.observedOrder)).length} | ${six.filter((u) => TOTAL_FEE.test(u.observedOrder)).length} | ${[...others.entries()].sort().map(([o, n]) => `${o} ×${n}`).join(', ') || '–'} | ${bc.filter((x) => x.value === 1).length} of ${bc.length} | ${us.filter(keptBySensitivity).length} |`,
      )
    }
    const kept = confirmTests(confirm.filter(keptBySensitivity), ordered)
    out.push('', `Sensitivity (descriptive; the filter of the primary, unadjusted p): ${kept.map((t) => `${t.hypothesis.split(':')[0]} ${t.n ? `${pct(t.share)} of ${t.n}, p=${fp(t.p)}` : 'no trials'}`).join('; ')}.`)
    const keys = new Set(confirmAll.map(key))
    const sent = loaded.trials.filter(isConfirm)
    const landed = loaded.txs.filter((t) => confirmRuns.has(t.run) && t.slot !== null).length
    const complete = sent.filter((t) => countsTowardsQuota(onTarget.get(key(t)) ?? [])).length
    out.push('', `Delivery: ${sent.length} trials dispatched, ${landed} of ${6 * sent.length} transactions landed, ${complete} trials with B, C, D, F and A or E in the window, ${keys.size} trials used.`, '')
  }

  // ---------- rule agreement ----------
  const ruleTable = (title: string, groups: { label: string; units: Unit[] }[], rules: Rule[]) => {
    if (!groups.some((g) => g.units.length)) return
    out.push(`## Rule agreement: ${title}`, '')
    out.push('Mean gamma per trial (+1: every pair the rule ranks differently landed in its order; 0: unrelated). The rules agree on most pairs by design: read the contrasts first. [95% interval resampling ingress hosts; – with fewer than 3], sign-flip p over host means, Holm-adjusted within the table.', '')
    out.push(`| group | trials | hosts | ${rules.map((r) => RULE_LABEL[r]).join(' | ')} |`)
    out.push(`|---|---:|---:|${rules.map(() => '---').join('|')}|`)
    const rs = groups.filter((g) => g.units.length).map((g) => ({ ...g, stats: rules.map((rule) => ruleStat(g.units, rule)) }))
    holm(rs.flatMap((r) => r.stats))
    for (const r of rs) out.push(`| ${r.label} | ${r.units.length} | ${new Set(r.units.map((u) => u.ingress)).size} | ${r.stats.map((st) => (st.trials ? `${f2(st.meanGamma)} [${f2(st.ci[0])}, ${f2(st.ci[1])}] p=${fp(st.pHolm)}` : '–')).join(' | ')} |`)
    out.push('')
  }
  const direct: Rule[] = ['rewardPerCost', 'priorityPerCost', 'cuPrice', 'totalFee', 'sentFirst']
  ruleTable('buffered/shared (campaign "main")', byLabel(bufShared(main), [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]), direct)
  const pilot = units.filter((u) => u.path === 'rpc')
  ruleTable(
    'pilot through the public RPC (for comparison)',
    [...[...new Set(pilot.map((u) => u.client))].map((c) => ({ label: c, units: pilot.filter((u) => u.client === c) })), { label: 'all pilot trials', units: pilot }],
    ['rewardPerCost', 'cuPrice', 'totalFee', 'sentFirst', 'rpcReleasedFirst'],
  )
  if (pilot.length) {
    const pilotKeys = new Set(trials.filter((t) => t.path === 'rpc').map(key))
    const pt = txs.filter((t) => pilotKeys.has(key(t)) && t.slot !== null && t.releasedMs !== null)
    const target = new Map(trials.map((t) => [key(t), t]))
    const ack = pt.map((t) => t.releasedMs! - t.sentMs)
    const delay = pt.map((t) => t.slot! - target.get(key(t))!.slotAtSend)
    const onTarget = pt.filter((t) => t.leader === target.get(key(t))!.targetLeader && t.slot! >= target.get(key(t))!.windowStart && t.slot! < target.get(key(t))!.windowStart + WINDOW_SLOTS).length
    out.push(
      `Pilot path: median RPC response to sendTransaction ${Math.round(median(ack))} ms (range ${Math.min(...ack)}–${Math.max(...ack)}); Pearson correlation between response time and slots from dispatch to landing ${f2(pearson(ack, delay) ?? NaN)} (${pt.length} transactions); landed in the targeted window: ${onTarget} of ${pt.length} (${pct(onTarget / pt.length)}).`,
      '',
    )
  }

  // ---------- delivery and context ----------
  out.push('## Delivery', '')
  out.push("In the targeted window: landed in a slot of the targeted leader's window. Complete: trials with B, C, D, F and A or E in the window (what the quota counts). Trials used: trials with two or more transactions in the ordered group, which for the pilot (rpc) is everything that landed, wherever: the public RPC rarely hit the targeted window. The last row, added after the main run, pools the main campaign's three deliveries.", '')
  out.push("| campaign / path / delivery | trials | sent | acknowledged by the leader's QUIC (of those with acknowledgement data) | landed | in the targeted window | spill-over | complete trials | trials used | median slots from dispatch to landing | median gap between sends, ms | arrival margin before the window, ms (median, min) | reconnected before sending |")
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|')
  const margins = (ts: Trial[]) => {
    const m = ts.map((t) => t.marginMs).filter((x): x is number => typeof x === 'number')
    return m.length ? `${Math.round(median(m))}, ${Math.round(Math.min(...m))}` : '–'
  }
  const deliveryRow = (c: string, ts: Trial[]) => {
    const keys = new Set(ts.map(key))
    const xs = txs.filter((t) => keys.has(key(t)))
    const landed = xs.filter((t) => t.slot !== null)
    const inWindow = [...keys].reduce((s, k) => s + (onTarget.get(k)?.length ?? 0), 0)
    const complete = [...keys].filter((k) => countsTowardsQuota(onTarget.get(k) ?? [])).length
    const withAck = xs.filter((x) => x.acked !== null)
    const used = units.filter((u) => keys.has(key(u)))
    const target = (x: Tx) => ts.find((y) => y.run === x.run && y.trial === x.trial)!
    const delays = landed.map((x) => x.slot! - target(x).slotAtSend)
    const gaps: number[] = []
    for (const t of ts) {
      const g = xs.filter((x) => x.run === t.run && x.trial === t.trial).sort((a, b) => a.sendIndex - b.sendIndex)
      for (let i = 1; i < g.length; i++) gaps.push(g[i].sentMs - g[i - 1].sentMs)
    }
    out.push(
      `| ${c} | ${ts.length} | ${xs.length} | ${withAck.length ? `${withAck.filter((x) => x.acked).length}/${withAck.length}` : '–'} | ${landed.length} (${pct(landed.length / xs.length)}) | ${inWindow} | ${landed.length - inWindow} | ${ts[0].path === 'tpu' ? complete : '–'} | ${used.length} | ${median(delays)} | ${median(gaps)} | ${margins(ts)} | ${ts.filter((t) => t.reconnected).length} |`,
    )
  }
  for (const c of [...new Set(trials.map((t) => `${t.campaign} / ${t.path} / ${t.delivery}`))]) deliveryRow(c, trials.filter((t) => `${t.campaign} / ${t.path} / ${t.delivery}` === c))
  const mainTrials = trials.filter((t) => t.campaign === MAIN_CAMPAIGN && t.path === 'tpu')
  if (mainTrials.length) deliveryRow(`${MAIN_CAMPAIGN} / tpu / all deliveries`, mainTrials)
  out.push('')

  out.push('## Versions', '')
  out.push('Share of each label\'s leader slots by version string, from the snapshots of the main campaign (of all runs while there is none), and the versions of the validators actually used in buffered/shared trials of the main campaign.', '')
  out.push('| client | versions by leader slots | versions in primary trials |')
  out.push('|---|---|---|')
  const snaps = snapshots.filter((s) => s.campaign === MAIN_CAMPAIGN).length ? snapshots.filter((s) => s.campaign === MAIN_CAMPAIGN) : snapshots
  const latest = snaps.at(-1)?.snapshot
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) {
    const vs = (latest?.validators ?? []).filter((v) => v.client === c && !v.delinquent && v.leaderSlots > 0)
    const total = vs.reduce((s, v) => s + v.leaderSlots, 0)
    const bySlots = new Map<string, number>()
    for (const v of vs) bySlots.set(v.version ?? '?', (bySlots.get(v.version ?? '?') ?? 0) + v.leaderSlots)
    const used = new Map<string, number>()
    for (const u of bufShared(main).filter((u) => u.client === c)) used.set(u.version ?? '?', (used.get(u.version ?? '?') ?? 0) + 1)
    out.push(
      `| ${c} | ${[...bySlots.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${pct(n / total)}`).join(', ')} | ${[...used.entries()].map(([v, n]) => `${v} ×${n}`).join(', ') || '–'} |`,
    )
  }
  out.push('')

  out.push('## Coverage per label', '')
  out.push("From the latest snapshot of the main campaign (of all runs while there is none). Effective number: (sum of slots)^2 / sum of squares, over the label's validators by leader slots, and over the validators reached by trials. Reachable: share of the label's slots whose validator advertises a QUIC address that no run of the main campaign excluded. Reached: validators in buffered/shared trials of the main campaign. Added after the main run: the last two columns, the leader slots held by the validators reached, as a share of all slots and of the label's (exploratory); and the two total rows.", '')
  out.push("| client | validators | share of all leader slots | effective number | reachable share of its slots | validators reached | effective number reached | validators reached: share of all leader slots | validators reached: share of the label's slots |")
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  const effective = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) ** 2 / xs.reduce((a, b) => a + b * b, 0) : NaN)
  const active = (latest?.validators ?? []).filter((v) => !v.delinquent && v.leaderSlots > 0)
  const allSlots = active.reduce((s, v) => s + v.leaderSlots, 0)
  const blocked = new Set(excluded.filter((e) => e.campaign === MAIN_CAMPAIGN).map((e) => e.ingress))
  const coverageRow = (label: string, labels: string[]) => {
    const vs = active.filter((v) => labels.includes(v.client))
    const slots = vs.reduce((s, v) => s + v.leaderSlots, 0)
    const reachable = vs.filter((v) => v.tpuQuic && !blocked.has(v.tpuQuic)).reduce((s, v) => s + v.leaderSlots, 0)
    const perValidator = new Map<string, number>()
    for (const u of bufShared(main).filter((u) => labels.includes(u.client))) perValidator.set(u.leader, (perValidator.get(u.leader) ?? 0) + 1)
    const reachedSlots = vs.filter((v) => perValidator.has(v.identity)).reduce((s, v) => s + v.leaderSlots, 0)
    out.push(
      `| ${label} | ${vs.length} | ${pct1(slots / allSlots)} | ${f1(effective(vs.map((v) => v.leaderSlots)))} | ${pct(reachable / slots)} | ${perValidator.size || '–'} | ${f1(effective([...perValidator.values()]))} | ${perValidator.size ? pct1(reachedSlots / allSlots) : '–'} | ${perValidator.size ? pct(reachedSlots / slots) : '–'} |`,
    )
  }
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) coverageRow(c, [c])
  coverageRow('local schedulers', LOCAL_CLIENTS)
  coverageRow('pipelines', PIPELINE_CLIENTS)
  out.push('')

  out.push('## Ingress: where the direct path delivered (campaign "main")', '')
  out.push('BAM and Harmonic validators advertise QUIC addresses on shared gateway hosts; for them the measurement starts at the gateway, not at the validator. The pipeline family\'s group-level test groups their trials by these hosts, and rule-agreement intervals resample hosts. (Restricted to campaign "main" after the main run; it had counted the calibration and rehearsal trials too.)', '')
  out.push('| client | trials used | validators | distinct ingress hosts | trials via a shared host | most validators behind one used host |')
  out.push('|---|---:|---:|---:|---:|---:|')
  for (const c of [...new Set(main.map((u) => u.client))].sort()) {
    const cu = main.filter((u) => u.client === c)
    out.push(`| ${c} | ${cu.length} | ${new Set(cu.map((u) => u.leader)).size} | ${new Set(cu.map((u) => u.ingress)).size} | ${cu.filter((u) => u.ingressShared > 1).length} | ${Math.max(...cu.map((u) => u.ingressShared))} |`)
  }
  out.push('')

  out.push('## Where our transactions stand in their blocks (direct path)', '')
  out.push("Median share of the block's other transactions (our own six excluded) with a lower reward per scheduled cost unit, and median position as a fraction of the block.", '')
  out.push('| role | landed | out-ranks (reward/cost) | position, buffered | position, burst | position, streamed |')
  out.push('|---|---:|---:|---:|---:|---:|')
  const trialOf = new Map(trials.map((t) => [key(t), t]))
  const ownIndices = new Map<number, Set<number>>()
  for (const t of txs) if (t.slot !== null && t.index !== null) ownIndices.set(t.slot, (ownIndices.get(t.slot) ?? new Set()).add(t.index))
  for (const role of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const ours = txs.filter((t) => t.role === role && t.slot !== null && t.index !== null && trialOf.get(key(t))?.path === 'tpu')
    const ranks: number[] = []
    const pos: Record<string, number[]> = { buffered: [], burst: [], streamed: [] }
    for (const t of ours) {
      const b = blocks.get(t.slot!)
      if (!b) continue
      const mine = (t.priorityFee + Number(BASE_FEE_PER_SIGNATURE) / 2) / (720 + 600 + 7 + t.cuLimit + loadedDataCost(t.loadedLimit))
      const own = ownIndices.get(t.slot!) ?? new Set()
      const others = b.rows.filter((_, i) => !own.has(i)).map((r) => rowReward(r) / Math.max(1, rowCost(r)))
      ranks.push(others.filter((x) => x < mine).length / others.length)
      pos[trialOf.get(key(t))!.delivery]?.push(t.index! / b.txCount)
    }
    out.push(`| ${role} | ${ours.length} | ${pct(median(ranks))} | ${pct(median(pos.buffered))} | ${pct(median(pos.burst))} | ${pct(median(pos.streamed))} |`)
  }
  const sizes = [...new Set(tpu.flatMap((u) => u.slots))].map((s) => blocks.get(s)?.txCount).filter((x): x is number => typeof x === 'number')
  if (sizes.length) out.push('', `Blocks holding our direct-path transactions: ${sizes.length}, with ${Math.min(...sizes)}–${Math.max(...sizes)} transactions (median ${median(sizes)}).`)
  out.push('')

  out.push('## Background: everyone else in the same blocks', '')
  out.push('Spearman rho between position and reward per scheduled cost unit over the other transactions; negative = higher reward/cost earlier.', '')
  out.push('| client | blocks | median rho, whole block | median rho, first 10% | blocks with rho < 0 |')
  out.push('|---|---:|---|---|---|')
  const clientOfSlot = new Map<number, string>()
  for (const u of tpu) for (const s of u.slots) clientOfSlot.set(s, u.client)
  for (const c of [...new Set(clientOfSlot.values())].sort()) {
    const rs = [...clientOfSlot.entries()].filter(([, cl]) => cl === c).map(([slot]) => (blocks.get(slot) ? backgroundRho(blocks.get(slot)!, ownIndices.get(slot) ?? new Set()) : null))
    const all = rs.map((r) => r?.all).filter((x): x is number => typeof x === 'number')
    const head = rs.map((r) => r?.head).filter((x): x is number => typeof x === 'number')
    out.push(`| ${c} | ${all.length} | ${f2(median(all))} | ${f2(median(head))} | ${pct(all.filter((x) => x < 0).length / all.length)} |`)
  }
  out.push('')

  // ---------- appendix: every trial's observed order ----------
  orders.push('# Observed orders, trial by trial (generated by `analyze`)', '')
  orders.push(
    'Roles in landing order within the targeted window (slot, then index). Reward/cost order: A E D C F B (A and E tie). Send order: the order the burst was dispatched in. Added after the main run: the port of the QUIC address the trial was sent to, whether the connection was re-established just before sending, and the arrival margin (ms between the leader acknowledging the last transaction and our clock seeing the window start; negative: after it).',
    '',
  )
  orders.push('| campaign | run | trial | client | validator | version | cell | send order | observed order | slots | QUIC port | reconnected | arrival margin, ms |')
  orders.push('|---|---|---:|---|---|---|---|---|---|---|---|---|---:|')
  const sendOrderOf = (u: Unit) =>
    loaded.txs
      .filter((t) => t.run === u.run && t.trial === u.trial)
      .sort((a, b) => a.sendIndex - b.sendIndex)
      .map((t) => t.role)
      .join('')
  for (const u of [...tpu, ...confirmAll])
    orders.push(
      `| ${u.campaign} | ${u.run} | ${u.trial} | ${u.client} | ${u.leader.slice(0, 8)} | ${u.version ?? '?'} | ${u.delivery}/${u.mode} | ${sendOrderOf(u)} | ${u.observedOrder} | ${u.slots.join(', ')} | ${u.port ?? '–'} | ${u.reconnected ? 'yes' : '–'} | ${u.marginMs === null ? '–' : Math.round(u.marginMs)} |`,
    )

  const resultsDir = join(dataDir, cluster, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const md = out.join('\n')
  writeFileSync(join(resultsDir, 'results.md'), md + '\n')
  writeFileSync(join(resultsDir, 'orders.md'), orders.join('\n') + '\n')
  writeFileSync(join(resultsDir, 'units.json'), toJson(loaded.units, 1))
  writeFileSync(join(resultsDir, 'summary.json'), toJson({ runs, units: loaded.units.length, uncollected }, 1))
  // the two charts REPORT.md shows: the exact-order rates, and the exploratory send-order table
  const thousands = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const exactBar = (b: (typeof exactBars)[number]) => ({ label: b.label, value: b.exact / b.trials, text: `${b.exact} of ${b.trials}` })
  if (exactBars.length)
    writeFileSync(
      join(resultsDir, 'exact-orders.svg'),
      barChart({
        title: 'Trials in the exact predicted order of all six',
        subtitle: ['Main run, buffered/shared trials with all six in the window ("Exact orders").', 'The order A E D C F B, A and E either way; by chance, 2 trials in 720.'],
        groups: [
          { heading: 'Local schedulers', bars: exactBars.filter((b) => LOCAL_CLIENTS.includes(b.label)).map(exactBar) },
          { heading: 'Pipelines', bars: exactBars.filter((b) => PIPELINE_CLIENTS.includes(b.label)).map(exactBar) },
        ],
      }),
    )
  if (sendBars.length)
    writeFileSync(
      join(resultsDir, 'send-order.svg'),
      barChart({
        title: 'Pairs that landed in the order they were sent (exploratory)',
        subtitle: ['Local schedulers, main run, by cell ("Send order against landing order, by cell").', 'The send order is random in every trial, so 50% means unrelated to sending.'],
        groups: [{ heading: '', bars: sendBars.map((b) => ({ label: b.cell, value: b.inOrder / b.pairs, text: `${pct(b.inOrder / b.pairs)} of ${thousands(b.pairs)} pairs` })) }],
        reference: { value: 0.5, label: 'chance' },
      }),
    )
  return md
}
