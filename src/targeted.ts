// The targeted run (docs/RAKURAI.md; frozen before its first trial, git tag prereg-rakurai). The main and confirmatory
// runs left a lead: among the JitoLabs validators reached, two of the three that ordered by total fee hold an enabled
// account of Rakurai's activation program, and none of the thirteen that followed reward/cost does. This run aims at
// new validators chosen by that account alone, and at matched validators without one, on one day.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Loaded, Trial, Tx, Unit } from './analyze.ts'
import type { Snapshot } from './discover.ts'
import type { NamesFile } from './names.ts'
import { binomialLowerTail, mean, wilson } from './stats.ts'
import { cellSafe, classifyOrder, ORDER_LABEL, tieStat, validatorReading } from './validators.ts'

export const RAKURAI_CAMPAIGN = 'rakurai'
/** the same design with the parameters of B and D swapped round (design.ts, SWAPPED_ROLES) */
export const SWAP_CAMPAIGN = 'rakurai-swap'
export const TARGETED_CAMPAIGNS = [RAKURAI_CAMPAIGN, SWAP_CAMPAIGN]
/** chosen by selectPanel from the committed snapshot and activation accounts; test/targeted.test.ts checks these lists */
export const HOLDERS = ['A9mvukTd', '8tjFeSAp', 'Ha1iade1', 'siidBVew', '2Df1aLCR', 'fishfish']
export const MATCHED = ['bitHUmbK', 'vu1sGn2f', 'HM19KBHD', '8o8wWCYN', '32ke3uf1', 'Cogent51']
/** ordered by total fee in both earlier runs */
export const KNOWN_TOTAL_FEE = 'C8Bey3LK'
/** ordered by reward/cost in the main run */
export const KNOWN_REWARD_COST = 'HEL1USMZ'
/** reported JitoLabs during the earlier runs, and a Harmonic client now */
export const LABEL_MOVED = 'EvnRmnMr'
/** the smallest share of all leader slots of a holder in the panel */
export const MIN_SLOT_SHARE = 0.001
/** fewer such trials and a validator does not enter H1: the floor of "Per validator" in the robustness section */
export const MIN_PER_VALIDATOR = 5
/** fewer such validators in either group: insufficient data for H1 */
export const MIN_VALIDATORS = 3
/** fewer trials: insufficient data for H2 and H3 */
export const MIN_TRIALS = 10
const ALPHA = 0.05

/** Under the swapped parameters: B 10 000 lamports for 1 000 CU, D 9 000 for 40 000 (test/design.test.ts). */
export const SWAP_ORDERS = {
  totalFee: /^BD[AEF]{3}C$/,
  largerLimitFirst: /^DB[AEF]{3}C$/,
  rewardCost: /^B(AE|EA)CFD$/,
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const portOf = (addr: string | null) => addr?.replace(/^.*:/, '') ?? null

/**
 * The panel, by the rule of docs/RAKURAI.md. Holders: report JitoLabs, are not delinquent, hold an enabled activation
 * account, have at least MIN_SLOT_SHARE of all leader slots, and were not aimed at in the buffered/shared cell of the
 * earlier runs. Matched: for each holder, by descending leader slots, the unused validator that reports JitoLabs 4.4.0,
 * is not delinquent, holds no enabled account, and is on the same side of port 11228, closest in leader slots.
 */
export function selectPanel(snapshot: Snapshot, enabled: Set<string>, aimedAtBefore: Set<string>): { holders: string[]; matched: string[] } {
  const active = snapshot.validators.filter((v) => !v.delinquent && v.leaderSlots > 0)
  const total = active.reduce((n, v) => n + v.leaderSlots, 0)
  const jito = active.filter((v) => v.client === 'JitoLabs' && v.tpuQuic)
  const holders = jito
    .filter((v) => enabled.has(v.identity) && !aimedAtBefore.has(v.identity) && v.leaderSlots / total >= MIN_SLOT_SHARE)
    .sort((a, b) => b.leaderSlots - a.leaderSlots || byText(a.identity, b.identity))
  const pool = jito.filter((v) => !enabled.has(v.identity) && v.version === '4.4.0')
  const used = new Set<string>()
  const matched = holders.map((h) => {
    const relayer = portOf(h.tpuQuic) === '11228'
    const m = pool
      .filter((v) => !used.has(v.identity) && (portOf(v.tpuQuic) === '11228') === relayer)
      .sort((a, b) => Math.abs(a.leaderSlots - h.leaderSlots) - Math.abs(b.leaderSlots - h.leaderSlots) || byText(a.identity, b.identity))[0]
    used.add(m.identity)
    return m.identity
  })
  return { holders: holders.map((v) => v.identity.slice(0, 8)), matched: matched.map((id) => id.slice(0, 8)) }
}

/**
 * Exact one-sided permutation test over validators: how often an assignment of the same values to two groups of the
 * same sizes gives a difference of means at least as large as the one observed. Its smallest value is one over the
 * number of assignments.
 */
export function permutationP(a: number[], b: number[]): number {
  const all = [...a, ...b]
  const total = all.reduce((s, x) => s + x, 0)
  const observed = mean(a) - mean(b)
  let at = 0
  let of = 0
  const choose = (from: number, left: number, sum: number) => {
    if (left === 0) {
      of++
      if (sum / a.length - (total - sum) / b.length >= observed - 1e-12) at++
      return
    }
    for (let i = from; i <= all.length - left; i++) choose(i + 1, left - 1, sum + all[i])
  }
  choose(0, a.length, 0)
  return at / of
}

/** Holm step-down adjustment of a family of p values, in their order. */
export function holmAdjust(ps: number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p)
  const out = new Array<number>(ps.length)
  let running = 0
  order.forEach(({ p, i }, k) => {
    running = Math.max(running, Math.min(1, p * (ps.length - k)))
    out[i] = running
  })
  return out
}

/** P(X >= k) for X ~ Binomial(n, 1/2). */
export const upperTail = (k: number, n: number) => (n === 0 ? 1 : k <= 0 ? 1 : 1 - binomialLowerTail(k - 1, n, 0.5))

/** In how many trials the first role landed before the second, of those with both in the window. */
export function before(orders: string[], first: string, second: string): { k: number; n: number } {
  const both = orders.filter((o) => o.includes(first) && o.includes(second))
  return { k: both.filter((o) => o.indexOf(first) < o.indexOf(second)).length, n: both.length }
}

export interface H1 {
  holders: { id: string; share: number; n: number }[]
  matched: { id: string; share: number; n: number }[]
  p: number
  /** enough validators in both groups */
  enough: boolean
}

/** H1: per validator the share of its trials with B before C; the validators with enough such trials, by group. */
export function testH1(ordersOf: (prefix: string) => string[]): H1 {
  const group = (ids: string[]) =>
    ids
      .map((id) => {
        const { k, n } = before(ordersOf(id), 'B', 'C')
        return { id, share: n ? k / n : NaN, n }
      })
      .filter((v) => v.n >= MIN_PER_VALIDATOR)
  const holders = group(HOLDERS)
  const matched = group(MATCHED)
  const enough = holders.length >= MIN_VALIDATORS && matched.length >= MIN_VALIDATORS
  return {
    holders,
    matched,
    enough,
    p: enough
      ? permutationP(
          holders.map((v) => v.share),
          matched.map((v) => v.share),
        )
      : 1,
  }
}

export const targetedVerdict = (enough: boolean, pHolm: number) => (!enough ? 'insufficient data' : pHolm < ALPHA ? 'confirmed' : 'not confirmed')

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–')
const fp = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3))
const orderList = (orders: string[]) => {
  const by = new Map<string, number>()
  for (const o of orders) by.set(o, (by.get(o) ?? 0) + 1)
  return [...by.entries()].sort((a, b) => byText(a[0], b[0])).map(([o, n]) => (n > 1 ? `${o} ×${n}` : o)).join(', ') || '–'
}

export interface TargetedInput {
  loaded: Loaded
  dataDir: string
  cluster: string
  /** the sensitivity filter of the primary */
  kept: (u: Unit) => boolean
}

export function targetedSection({ loaded, dataDir, cluster, kept }: TargetedInput): string[] {
  const out: string[] = []
  out.push('## Targeted run (campaigns "rakurai" and "rakurai-swap"; pre-registered in docs/RAKURAI.md, git tag prereg-rakurai)', '')
  out.push(
    `New buffered/shared trials, planned and tagged before the first of them. H1: the holders of an enabled Rakurai activation account among new JitoLabs validators put B before C more than matched JitoLabs validators without one (per validator the share of its trials with B before C, for validators with at least ${MIN_PER_VALIDATOR} such trials; exact one-sided permutation test of the difference of group means over validators; fewer than ${MIN_VALIDATORS} validators in either group: insufficient data). H2: with B paying 10 000 lamports for 1 000 CU and D 9 000 for 40 000, C8Bey3LK puts B before D. H3: at the matched validators, which report Jito 4.4.0, the twin sent first lands first. H2 and H3: one-sided exact binomial against chance; fewer than ${MIN_TRIALS} trials: insufficient data. All three Holm-adjusted together; confirmed when the Holm p < ${ALPHA}, else not confirmed. These trials appear only in this section, the run list, "Reported client over time" and orders.md.`,
    '',
  )
  const inCell = (t: Pick<Trial, 'path' | 'delivery' | 'mode'>) => t.path === 'tpu' && t.delivery === 'buffered' && t.mode === 'shared'
  const units = loaded.units.filter((u) => u.campaign === RAKURAI_CAMPAIGN && inCell(u))
  const swapUnits = loaded.units.filter((u) => u.campaign === SWAP_CAMPAIGN && inCell(u))
  const trials = loaded.trials.filter((t) => t.campaign === RAKURAI_CAMPAIGN && inCell(t))
  const swapTrials = loaded.trials.filter((t) => t.campaign === SWAP_CAMPAIGN && inCell(t))
  if (!trials.length && !swapTrials.length) {
    out.push('No trials of the targeted campaigns yet.', '')
    return out
  }
  const ordersOf = (us: Unit[], prefix: string) => us.filter((u) => u.leader.startsWith(prefix)).map((u) => u.observedOrder)

  // the tests
  const h1 = testH1((id) => ordersOf(units, id))
  const h2 = before(ordersOf(swapUnits, KNOWN_TOTAL_FEE), 'B', 'D')
  const twin = units.filter((u) => MATCHED.some((id) => u.leader.startsWith(id))).reduce(
    (s, u) => {
      const g: Tx[] = loaded.ordered.get(`${u.run}#${u.trial}`) ?? []
      const a = g.find((t) => t.role === 'A')
      const e = g.find((t) => t.role === 'E')
      if (!a || !e) return s
      const first = a.sendIndex < e.sendIndex ? a : e
      return { k: s.k + (g.indexOf(first) < g.indexOf(first === a ? e : a) ? 1 : 0), n: s.n + 1 }
    },
    { k: 0, n: 0 },
  )
  const ps = [h1.p, upperTail(h2.k, h2.n), upperTail(twin.k, twin.n)]
  const holm = holmAdjust(ps)
  const shareOf = (x: { k: number; n: number }) => (x.n ? `${pct(x.k / x.n)} of ${x.n} [${wilson(x.k, x.n).map(pct).join('–')}]` : '–')
  out.push('| hypothesis | validators | measure | result | p | Holm p | verdict |')
  out.push('|---|---|---|---|---:|---:|---|')
  out.push(
    `| H1: holders put B before C more than matched validators | ${h1.holders.length} holders, ${h1.matched.length} matched | mean over validators of the share of trials with B before C | holders ${pct(mean(h1.holders.map((v) => v.share)))}, matched ${pct(mean(h1.matched.map((v) => v.share)))} | ${fp(ps[0])} | ${fp(holm[0])} | **${targetedVerdict(h1.enough, holm[0])}** |`,
  )
  out.push(`| H2: total fee, not the larger limit | ${KNOWN_TOTAL_FEE}, swapped parameters | B before D (by chance 50%) | ${shareOf(h2)} | ${fp(ps[1])} | ${fp(holm[1])} | **${targetedVerdict(h2.n >= MIN_TRIALS, holm[1])}** |`)
  out.push(`| H3: oldest first at Jito 4.4.0 | ${MATCHED.length} matched | twin sent first landed first (by chance 50%) | ${shareOf(twin)} | ${fp(ps[2])} | ${fp(holm[2])} | **${targetedVerdict(twin.n >= MIN_TRIALS, holm[2])}** |`)
  out.push('')

  // validator by validator
  const namesFile = join(dataDir, cluster, 'validator-names.json')
  const names: NamesFile['names'] = existsSync(namesFile) ? (JSON.parse(readFileSync(namesFile, 'utf8')) as NamesFile).names : {}
  const nameOf = (prefix: string) => {
    const id = Object.keys(names).find((k) => k.startsWith(prefix))
    return id ? cellSafe(names[id].name) : '–'
  }
  out.push('Per validator (descriptive). A reading follows the rule of "Validator by validator". B before C: of the trials with both in the window.', '')
  out.push('| group | validator | name | reported | QUIC port | dispatched | with all six | reward/cost | total fee | F last | other orders | B before C | kept by the sensitivity filter | reading |')
  out.push('|---|---|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|')
  const row = (group: string, id: string) => {
    const ts = trials.filter((t) => t.targetLeader.startsWith(id))
    const us = units.filter((u) => u.leader.startsWith(id))
    const orders = us.map((u) => u.observedOrder).filter((o) => o.length === 6)
    const r = validatorReading(orders)
    const bc = before(us.map((u) => u.observedOrder), 'B', 'C')
    const reported = [...new Set(ts.map((t) => `${t.targetClient}${t.targetVersion ? ` ${t.targetVersion}` : ''}`))].join(', ') || '–'
    const ports = [...new Set(ts.map((t) => t.port ?? '–'))].join(', ') || '–'
    out.push(
      `| ${group} | ${id} | ${nameOf(id)} | ${reported} | ${ports} | ${ts.length} | ${r.n} | ${r.counts.rewardCost} | ${r.counts.totalFee} | ${r.counts.fLast} | ${orderList(orders.filter((o) => classifyOrder(o) === 'other'))} | ${bc.k} of ${bc.n} | ${us.filter(kept).length} | ${r.reading} |`,
    )
  }
  for (const id of HOLDERS) row('holder', id)
  for (const id of MATCHED) row('matched', id)
  row('known total fee', KNOWN_TOTAL_FEE)
  row('known reward/cost', KNOWN_REWARD_COST)
  row('label moved', LABEL_MOVED)
  out.push('')

  // the swapped parameters
  const six = swapUnits.filter((u) => u.observedOrder.length === 6).map((u) => u.observedOrder)
  const count = (re: RegExp) => six.filter((o) => re.test(o)).length
  out.push(`The swapped parameters, ${KNOWN_TOTAL_FEE}: of ${six.length} trials with all six, ${count(SWAP_ORDERS.totalFee)} in the exact total-fee order (B D, then A, E, F in any order, C), ${count(SWAP_ORDERS.largerLimitFirst)} in the exact order of the larger limit first (D B, then A, E, F, C), ${count(SWAP_ORDERS.rewardCost)} in the exact reward/cost order (B, A and E either way, C, F, D); other orders: ${orderList(six.filter((o) => !Object.values(SWAP_ORDERS).some((re) => re.test(o))))}.`, '')

  // delivery
  const deliveryOf = (ts: Trial[]) => {
    const keys = new Set(ts.map((t) => `${t.run}#${t.trial}`))
    const xs = loaded.txs.filter((t) => keys.has(`${t.run}#${t.trial}`))
    return `${ts.length} trials dispatched, ${xs.filter((t) => t.slot !== null).length} of ${xs.length} transactions landed, ${ts.filter((t) => t.reconnected).length} reconnected before sending`
  }
  out.push(`Delivery: "${RAKURAI_CAMPAIGN}": ${deliveryOf(trials)}; "${SWAP_CAMPAIGN}": ${deliveryOf(swapTrials)}.`, '')
  return out
}

/** Of the trials with A and E in the group, in how many the twin sent first landed first. */
export function twinFirst(units: Pick<Unit, 'run' | 'trial'>[], ordered: Map<string, Pick<Tx, 'role' | 'sendIndex'>[]>): { k: number; n: number } {
  let k = 0
  let n = 0
  for (const u of units) {
    const g = ordered.get(`${u.run}#${u.trial}`) ?? []
    const a = g.findIndex((t) => t.role === 'A')
    const e = g.findIndex((t) => t.role === 'E')
    if (a < 0 || e < 0) continue
    n++
    if (g[a].sendIndex < g[e].sendIndex === a < e) k++
  }
  return { k, n }
}

/**
 * Added after the targeted run, on its trials, and frozen by nothing: it tests no hypothesis. The section "Targeted run"
 * above is the one tagged prereg-rakurai.
 */
export function targetedAfterData({ loaded, dataDir, cluster }: Omit<TargetedInput, 'kept'>): string[] {
  const inCell = (u: Unit) => u.path === 'tpu' && u.delivery === 'buffered' && u.mode === 'shared'
  const units = loaded.units.filter((u) => TARGETED_CAMPAIGNS.includes(u.campaign) && inCell(u))
  if (!units.length) return []
  const main = units.filter((u) => u.campaign === RAKURAI_CAMPAIGN)
  const swap = units.filter((u) => u.campaign === SWAP_CAMPAIGN)
  const namesFile = join(dataDir, cluster, 'validator-names.json')
  const names: NamesFile['names'] = existsSync(namesFile) ? (JSON.parse(readFileSync(namesFile, 'utf8')) as NamesFile).names : {}
  const nameOf = (prefix: string) => {
    const id = Object.keys(names).find((k) => k.startsWith(prefix))
    return id ? cellSafe(names[id].name) : '–'
  }
  const ids = [...HOLDERS, ...MATCHED, KNOWN_TOTAL_FEE, KNOWN_REWARD_COST, LABEL_MOVED]
  const mine = (us: Unit[], id: string) => us.filter((u) => u.leader.startsWith(id))
  const sixOf = (us: Unit[]) => us.filter((u) => u.observedOrder.length === 6)
  const readingOf = (id: string) => validatorReading(sixOf(mine(main, id)).map((u) => u.observedOrder)).reading
  const share = (x: { k: number; n: number }) => (x.n ? `${x.k} of ${x.n} (${pct(x.k / x.n)} [${wilson(x.k, x.n).map(pct).join('–')}])` : '–')

  const out: string[] = ['## Targeted run: read after the data (exploratory)', '']
  out.push('Added after the targeted run, on the same trials. It tests nothing; the plan names none of this.', '')

  out.push('**The twins by reading.** The twin sent first landed first, per validator of campaign "rakurai" with a reading in the section above. C8Bey3LK\'s trials with the swapped parameters count with its reading. H3 takes the matched validators alone.', '')
  out.push('| reading | validators | twin sent first landed first |')
  out.push('|---|---|---:|')
  const readings = [...new Set(ids.map(readingOf))].filter((r) => !['no trial with all six', 'too few trials'].includes(r)).sort(byText)
  for (const r of readings) {
    const group = ids.filter((id) => readingOf(id) === r)
    const us = group.flatMap((id) => [...mine(main, id), ...mine(swap, id)])
    const each = group.map((id) => {
      const t = twinFirst([...mine(main, id), ...mine(swap, id)], loaded.ordered)
      return `${id} ${t.k} of ${t.n}`
    })
    out.push(`| ${r} | ${each.join(', ')} | ${share(twinFirst(us, loaded.ordered))} |`)
  }
  out.push('')

  const ties = tieStat(units, loaded.ordered)
  out.push(
    `**Ties.** A, E and F pay the same total fee. In the ${ties.trials} targeted trials in the exact total-fee order, both campaigns: F first, middle, last among the three in ${ties.fPosition.join(', ')} (by chance a third each; the chance of F first at least that often: ${fp(ties.p)}), and ${ties.pairsInSendOrder} of the ${ties.pairs} pairs among the three in send order (${pct(ties.pairsInSendOrder / ties.pairs)}). Compare "How far the total-fee reading goes", on the earlier runs.`,
    '',
  )

  out.push('**Orders in time.** The validators of campaign "rakurai" whose trials with all six fall under more than one name, in the order of their trials, with the UTC time of sending.', '')
  out.push('| validator | name | orders |')
  out.push('|---|---|---|')
  for (const id of ids) {
    const us = sixOf(mine(main, id)).sort((a, b) => a.trial - b.trial)
    if (new Set(us.map((u) => classifyOrder(u.observedOrder))).size < 2) continue
    const cells = us.map((u) => {
      const sent = loaded.ordered.get(`${u.run}#${u.trial}`)?.[0]?.sentMs
      const kind = classifyOrder(u.observedOrder)
      return `${sent ? new Date(sent).toISOString().slice(11, 16) : '–'} ${kind === 'other' ? u.observedOrder : ORDER_LABEL[kind]}`
    })
    out.push(`| ${id} | ${nameOf(id)} | ${cells.join(', ')} |`)
  }
  out.push('')
  return out
}
