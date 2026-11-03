// Exploratory tables added after both runs, outside both pre-registered plans. They read the committed trials, blocks
// and snapshots again and test nothing new. They answer three questions: what did each validator do, did its reported
// client stay the same, and how far does the total-fee reading go.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Loaded, Trial, Tx, Unit } from './analyze.ts'
import type { BlockSummary } from './block.ts'
import { BASE_FEE_PER_SIGNATURE, LOCAL_CLIENTS, PIPELINE_CLIENTS } from './design.ts'
import type { Snapshot, Validator } from './discover.ts'
import type { ActivationFile, NamesFile } from './names.ts'
import { binomialLowerTail, fisherExact, median, spearman, wilson } from './stats.ts'

/** The orders of all six that have a name; A and E (and, for total fee, F) tie, so either way round. */
export const ORDERS = {
  /** reward/cost with the source's base-fee share */
  rewardCost: /^(AE|EA)DCFB$/,
  /** B (10 000 lamports), D (9 000), then A, E and F (4 000 each) in any order, C (0) last */
  totalFee: /^BD[AEF]{3}C$/,
  /** A, E and D first, then B and C either way round, F last */
  fLast: /^(AE|EA)D(BC|CB)F$/,
}
export type OrderName = keyof typeof ORDERS
const ORDER_NAMES = Object.keys(ORDERS) as OrderName[]
const ORDER_LABEL: Record<OrderName, string> = { rewardCost: 'reward/cost', totalFee: 'total fee', fLast: 'F last' }

/** below this many trials with all six there is no reading: the floor of "Per validator" in the robustness section */
export const MIN_VALIDATOR_TRIALS = 5
/** an order is a validator's reading when at least this share of its trials landed in it: H2's reference rate */
export const FOLLOWS_SHARE = 0.8

/** By code unit, so that the tables do not depend on the machine's locale: `reproduce` compares them byte for byte. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const classifyOrder = (order: string): OrderName | 'other' => ORDER_NAMES.find((n) => ORDERS[n].test(order)) ?? 'other'

export interface Reading {
  n: number
  counts: Record<OrderName | 'other', number>
  /** the named order with the most trials, and how many */
  top: OrderName | null
  topCount: number
  reading: string
}

export function validatorReading(orders: string[]): Reading {
  const counts: Reading['counts'] = { rewardCost: 0, totalFee: 0, fLast: 0, other: 0 }
  for (const o of orders) counts[classifyOrder(o)]++
  const top = ORDER_NAMES.reduce<OrderName | null>((best, n) => (counts[n] > (best ? counts[best] : 0) ? n : best), null)
  const topCount = top ? counts[top] : 0
  const n = orders.length
  const reading = n === 0 ? 'no trial with all six' : n < MIN_VALIDATOR_TRIALS ? 'too few trials' : top && topCount / n >= FOLLOWS_SHARE ? ORDER_LABEL[top] : 'mixed'
  return { n, counts, top, topCount, reading }
}

export interface TieStat {
  trials: number
  /** where F landed among the tied A, E, F: first, middle, last */
  fPosition: [number, number, number]
  /** P(F first in at least that many trials) if the three tie at random */
  p: number
  pairs: number
  pairsInSendOrder: number
}

/** The three roles that pay the same total fee, in trials that landed in the exact total-fee order. */
export function tieStat(units: Unit[], ordered: Map<string, Tx[]>): TieStat {
  const fPosition: TieStat['fPosition'] = [0, 0, 0]
  let pairs = 0
  let pairsInSendOrder = 0
  const us = units.filter((u) => ORDERS.totalFee.test(u.observedOrder))
  for (const u of us) {
    const g = (ordered.get(`${u.run}#${u.trial}`) ?? []).filter((t) => 'AEF'.includes(t.role))
    fPosition[g.findIndex((t) => t.role === 'F')]++
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        pairs++
        if (g[i].sendIndex < g[j].sendIndex) pairsInSendOrder++
      }
  }
  return { trials: us.length, fPosition, p: fPosition[0] ? 1 - binomialLowerTail(fPosition[0] - 1, us.length, 1 / 3) : 1, pairs, pairsInSendOrder }
}

export interface Head {
  size: number
  payers: number
  /** Spearman rho between position and the key; negative: a larger value earlier */
  feeAll: number | null
  rewardCostAll: number | null
  feePayers: number | null
  rewardCostPayers: number | null
}

/**
 * Everyone else in the first 10% of a block (the head of backgroundRho in analyze.ts), against the priority fee in
 * lamports and against reward per scheduled cost; also among the transactions that pay a priority fee, since a
 * total-fee order says nothing about how those that pay none are placed among themselves.
 */
export function headOfBlock(b: Pick<BlockSummary, 'rows'>, ours: Set<number>): Head {
  const others = b.rows
    .map((r, i) => ({ i, fee: r[3], cost: r[9], rewardCost: (r[3] + (r[5] * Number(BASE_FEE_PER_SIGNATURE)) / 2) / r[9] }))
    .filter((x) => !ours.has(x.i) && x.cost > 0)
  const head = others.slice(0, Math.max(3, Math.ceil(others.length / 10)))
  const payers = head.filter((x) => x.fee > 0)
  const rho = (xs: typeof head, f: (x: (typeof head)[number]) => number) =>
    spearman(
      xs.map((x) => x.i),
      xs.map(f),
    )
  return { size: head.length, payers: payers.length, feeAll: rho(head, (x) => x.fee), rewardCostAll: rho(head, (x) => x.rewardCost), feePayers: rho(payers, (x) => x.fee), rewardCostPayers: rho(payers, (x) => x.rewardCost) }
}

/** Every committed snapshot in time order: those of the runs and those of `discover`. */
export function allSnapshots(dataDir: string, cluster: string): Snapshot[] {
  const root = join(dataDir, cluster)
  const files: string[] = []
  if (existsSync(join(root, 'runs'))) for (const r of readdirSync(join(root, 'runs'))) if (existsSync(join(root, 'runs', r, 'snapshot.json'))) files.push(join(root, 'runs', r, 'snapshot.json'))
  if (existsSync(join(root, 'snapshots'))) for (const f of readdirSync(join(root, 'snapshots'))) if (f.endsWith('.json')) files.push(join(root, 'snapshots', f))
  return files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Snapshot).sort((a, b) => byText(a.takenAt, b.takenAt))
}

const stampOf = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
const labelOf = (v: Pick<Validator, 'client' | 'version'>) => `${v.client}${v.version ? ` ${v.version}` : ''}`

/** What changed for the given identities between two snapshots; an address unknown in either is not compared. */
export function changesBetween(a: Snapshot, b: Snapshot, ids: Set<string>): { compared: number; client: number; version: number; address: number } {
  const before = new Map(a.validators.map((v) => [v.identity, v]))
  const out = { compared: 0, client: 0, version: 0, address: 0 }
  for (const v of b.validators) {
    const w = before.get(v.identity)
    if (!w || !ids.has(v.identity)) continue
    out.compared++
    if (w.client !== v.client) out.client++
    else if (w.version !== v.version) out.version++
    if (w.tpuQuic && v.tpuQuic && w.tpuQuic !== v.tpuQuic) out.address++
  }
  return out
}

/** One identity's label and address over time, consecutive equal states merged. */
export function timeline(snapshots: Snapshot[], identity: string): { label: string; address: string | null; from: string; to: string }[] {
  const points = snapshots.flatMap((s) => {
    const v = s.validators.find((x) => x.identity === identity)
    return v ? [{ takenAt: s.takenAt, label: labelOf(v), address: v.tpuQuic ?? null }] : []
  })
  // the oldest snapshots recorded no address: the next one with the same label stands in for it
  for (let i = points.length - 2; i >= 0; i--) if (!points[i].address && points[i].label === points[i + 1].label) points[i].address = points[i + 1].address
  const out: { label: string; address: string | null; from: string; to: string }[] = []
  for (const p of points) {
    const last = out.at(-1)
    if (last && last.label === p.label && last.address === p.address) last.to = p.takenAt
    else out.push({ label: p.label, address: p.address, from: p.takenAt, to: p.takenAt })
  }
  return out
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2).replace(/^-(0\.00)$/, '$1') : '–')
const fp = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3))
/** A name read from the chain, safe inside a Markdown table cell. */
export const cellSafe = (s: string) => s.replace(/[|\\`*_<>[\]]/g, ' ').replace(/\s+/g, ' ').trim()
const orderList = (orders: string[]) => {
  const by = new Map<string, number>()
  for (const o of orders) by.set(o, (by.get(o) ?? 0) + 1)
  return [...by.entries()].sort((a, b) => byText(a[0], b[0])).map(([o, n]) => (n > 1 ? `${o} ×${n}` : o)).join(', ') || '–'
}
const medianOf = (xs: (number | null)[]) => median(xs.filter((x): x is number => x !== null))

export interface SectionInput {
  loaded: Loaded
  dataDir: string
  cluster: string
  /** the snapshot the label tables use: the main campaign's latest */
  latest: Snapshot | undefined
  /** the Firedancer validator of H2 (identity prefix) */
  departs: string
}

const CAMPAIGNS = ['main', 'confirm']
const inCell = (t: Pick<Trial, 'campaign' | 'path' | 'delivery' | 'mode'>) => CAMPAIGNS.includes(t.campaign) && t.path === 'tpu' && t.delivery === 'buffered' && t.mode === 'shared'

/** Identity -> name, when `node src/cli.ts names` has been run. */
function readNames(dataDir: string, cluster: string): Map<string, string> {
  const f = join(dataDir, cluster, 'validator-names.json')
  if (!existsSync(f)) return new Map()
  const file: NamesFile = JSON.parse(readFileSync(f, 'utf8'))
  return new Map(Object.entries(file.names).map(([id, n]) => [id, cellSafe(n.name)]))
}

/** The activation accounts of Rakurai's program, when `node src/cli.ts rakurai` has been run. */
function readActivation(dataDir: string, cluster: string): ActivationFile | null {
  const f = join(dataDir, cluster, 'rakurai-activation.json')
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ActivationFile) : null
}

export function validatorSections({ loaded, dataDir, cluster, latest, departs }: SectionInput): string[] {
  const out: string[] = []
  const names = readNames(dataDir, cluster)
  const nameOf = (id: string) => names.get(id) ?? '–'
  const units = loaded.units.filter(inCell)
  const trials = loaded.trials.filter(inCell)
  const six = units.filter((u) => u.observedOrder.length === 6)
  const active = (latest?.validators ?? []).filter((v) => !v.delinquent && v.leaderSlots > 0)
  const slotsOf = new Map(active.map((v) => [v.identity, v.leaderSlots]))
  const rankOf = (id: string) => (slotsOf.has(id) ? 1 + active.filter((v) => v.leaderSlots > slotsOf.get(id)!).length : Infinity)

  // ---------- validator by validator ----------
  const rows = [...new Set(trials.map((t) => `${t.targetLeader}|${t.targetClient}`))].map((k) => {
    const [leader, client] = k.split('|')
    const us = six.filter((u) => u.leader === leader && u.client === client)
    const versions = [...new Set(trials.filter((t) => t.targetLeader === leader && t.targetClient === client).map((t) => t.targetVersion ?? '?'))]
    return {
      leader,
      client,
      versions,
      rank: rankOf(leader),
      dispatched: trials.filter((t) => t.targetLeader === leader && t.targetClient === client).length,
      main: us.filter((u) => u.campaign === 'main').length,
      confirm: us.filter((u) => u.campaign === 'confirm').length,
      orders: us.map((u) => u.observedOrder),
      r: validatorReading(us.map((u) => u.observedOrder)),
    }
  })
  rows.sort((a, b) => a.rank - b.rank || byText(a.leader, b.leader))
  out.push('## Validator by validator (exploratory)', '')
  out.push(
    `Added after both runs, outside both plans. The assignment's question, asked of each validator: every validator of the buffered/shared trials of campaigns "main" and "confirm", which ran a day apart and are pooled here. Rank: by leader slots in the main run's snapshot (epoch ${latest?.epoch.epoch ?? '?'}, ${active.length} validators with leader slots). Name: what the identity's own validator-info account says on chain (\`validator-names.json\`), self-declared. Dispatched: trials sent. Named orders of all six in the targeted window, A and E either way: reward/cost A E D C F B; total fee B D, then A, E, F in any order, C; F last A E D, then B and C either way, F. Reading: "too few trials" below ${MIN_VALIDATOR_TRIALS} trials with all six (the floor of "Per validator" in "Robustness of the primary"); otherwise the named order with at least ${pct(FOLLOWS_SHARE)} of the trials (the reference rate of docs/CONFIRM.md), or "mixed". Interval: Wilson 95% on the share of the most frequent named order, from ${MIN_VALIDATOR_TRIALS} trials on. A reading describes these trials on these days, not the validator in general.`,
    '',
  )
  out.push('| rank | validator | name | label | versions | dispatched | with all six (main + confirm) | reward/cost | total fee | F last | other orders | most frequent order [95%] | reading |')
  out.push('|---:|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|')
  for (const x of rows) {
    const others = x.orders.filter((o) => classifyOrder(o) === 'other')
    const share = x.r.n >= MIN_VALIDATOR_TRIALS && x.r.top ? `${pct(x.r.topCount / x.r.n)} [${wilson(x.r.topCount, x.r.n).map(pct).join('–')}]` : '–'
    out.push(
      `| ${Number.isFinite(x.rank) ? x.rank : '–'} | ${x.leader.slice(0, 8)} | ${nameOf(x.leader)} | ${x.client} | ${x.versions.join(', ')} | ${x.dispatched} | ${x.r.n} (${x.main} + ${x.confirm}) | ${x.r.counts.rewardCost} | ${x.r.counts.totalFee} | ${x.r.counts.fLast} | ${orderList(others)} | ${share} | ${x.r.reading} |`,
    )
  }
  out.push('')
  const measured = rows.filter((x) => x.r.n > 0)
  const deep = measured.filter((x) => x.r.n >= MIN_VALIDATOR_TRIALS)
  const trialsPer = measured.map((x) => x.r.n)
  out.push(
    `Validators with all six in at least one trial: ${measured.length}. With at least ${MIN_VALIDATOR_TRIALS} such trials: ${deep.length}; with at least 10: ${measured.filter((x) => x.r.n >= 10).length}. Median trials per validator: ${median(trialsPer)}. Dispatched without a single such trial: ${rows.length - measured.length}.`,
    '',
  )
  out.push(`The validators with fewer than ${MIN_VALIDATOR_TRIALS} such trials, pooled by label:`, '')
  out.push('| label | validators | trials with all six | reward/cost | total fee | F last | other |')
  out.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) {
    const few = measured.filter((x) => x.client === c && x.r.n < MIN_VALIDATOR_TRIALS)
    if (!few.length) continue
    const sum = (k: OrderName | 'other') => few.reduce((s, x) => s + x.r.counts[k], 0)
    out.push(`| ${c} | ${few.length} | ${few.reduce((s, x) => s + x.r.n, 0)} | ${sum('rewardCost')} | ${sum('totalFee')} | ${sum('fLast')} | ${sum('other')} |`)
  }
  out.push('')

  // ---------- the reported client over time ----------
  const snapshots = allSnapshots(dataDir, cluster)
  const ids = new Set(measured.map((x) => x.leader))
  out.push('## Reported client over time (exploratory)', '')
  out.push(
    `Added after both runs, outside both plans. A trial's label is what the validator reported in gossip in the snapshot taken at the start of its run; a run lasts up to two hours and nothing rechecks it during the run. Every committed snapshot (\`runs/*/snapshot.json\`, \`snapshots/\`), for the ${ids.size} validators of "Validator by validator": what changed between consecutive snapshots, then each validator whose reported client changed at any point. The oldest snapshot recorded no addresses.`,
    '',
  )
  out.push('| from (UTC) | to (UTC) | validators in both | client changed | version changed, same client | QUIC address changed |')
  out.push('|---|---|---:|---:|---:|---:|')
  for (let i = 1; i < snapshots.length; i++) {
    const c = changesBetween(snapshots[i - 1], snapshots[i], ids)
    out.push(`| ${stampOf(snapshots[i - 1].takenAt)} | ${stampOf(snapshots[i].takenAt)} | ${c.compared} | ${c.client} | ${c.version} | ${c.address} |`)
  }
  out.push('')
  const moved = [...ids]
    .map((id) => ({ id, line: timeline(snapshots, id) }))
    .filter((x) => new Set(x.line.map((p) => p.label.split(' ')[0])).size > 1)
    .sort((a, b) => rankOf(a.id) - rankOf(b.id) || byText(a.id, b.id))
  const leftGossip = moved.filter((m) => m.line.at(-1)!.label.startsWith('NotInGossip')).length
  out.push(`Validators whose reported client changed: ${moved.length} of ${ids.size}, ${leftGossip} of them by leaving gossip.`, '')
  if (moved.length) {
    out.push('| rank | validator | name | reported, with the first and last snapshot of each state |')
    out.push('|---:|---|---|---|')
    for (const m of moved)
      out.push(
        `| ${Number.isFinite(rankOf(m.id)) ? rankOf(m.id) : '–'} | ${m.id.slice(0, 8)} | ${nameOf(m.id)} | ${m.line.map((p) => `${p.label}${p.address ? ` at ${p.address}` : ''} (${stampOf(p.from)}${p.from === p.to ? '' : ` – ${stampOf(p.to)}`})`).join('; ')} |`,
      )
    out.push('')
    out.push("Every direct-path trial of these validators with at least two transactions in the window, by what the validator reported in that run's snapshot:", '')
    out.push('| validator | reported | campaign | cell | trials | observed orders |')
    out.push('|---|---|---|---|---:|---|')
    const direct = loaded.units.filter((u) => u.path === 'tpu')
    for (const m of moved) {
      const groups = new Map<string, Unit[]>()
      for (const u of direct.filter((u) => u.leader === m.id)) {
        const k = `${u.client}${u.version ? ` ${u.version}` : ''}|${u.campaign}|${u.delivery}/${u.mode}`
        groups.set(k, [...(groups.get(k) ?? []), u])
      }
      for (const [k, us] of [...groups.entries()].sort((a, b) => byText(a[1][0].run, b[1][0].run) || byText(a[0], b[0]))) {
        const [label, campaign, cell] = k.split('|')
        out.push(`| ${m.id.slice(0, 8)} | ${label} | ${campaign} | ${cell} | ${us.length} | ${orderList(us.map((u) => u.observedOrder))} |`)
      }
    }
    out.push('')
  }

  // ---------- how far the total-fee reading goes ----------
  const totalFeeIds = [...new Set(six.filter((u) => ORDERS.totalFee.test(u.observedOrder)).map((u) => u.leader))].sort((a, b) => rankOf(a) - rankOf(b))
  out.push('## How far the total-fee reading goes (exploratory)', '')
  out.push(
    'Added after both runs, outside both plans. **The order of the six.** B D, then A, E, F, C is also what "the larger requested compute-unit limit first, the larger fee between equal limits" predicts (40 000, 6 000, then 1 000 for the other four; `test/design.test.ts`), so these orders do not separate that rule from total fee.',
    '',
  )
  const tieRow = (label: string, us: Unit[]) => {
    const t = tieStat(us, loaded.ordered)
    if (!t.trials) return
    out.push(`| ${label} | ${t.trials} | ${t.fPosition.join(' / ')} | ${fp(t.p)} | ${t.pairsInSendOrder} of ${t.pairs} (${pct(t.pairsInSendOrder / t.pairs)}) |`)
  }
  out.push('**Ties.** A, E and F pay the same total fee. In the trials in the exact total-fee order (main + confirm): where F landed among the three, the chance of F first at least that often if the three tie at random (exact binomial, 1/3; chosen after seeing the data), and how many of the pairs among the three landed in send order.', '')
  out.push('| validators | trials | F first / middle / last | p | tied pairs in send order |')
  out.push('|---|---:|---:|---:|---:|')
  for (const id of totalFeeIds) tieRow(`${id.slice(0, 8)} ${nameOf(id)}`, six.filter((u) => u.leader === id))
  if (totalFeeIds.length > 1) tieRow('together', six.filter((u) => totalFeeIds.includes(u.leader)))
  out.push('')
  out.push(
    `**Everyone else at the head of their blocks.** The blocks holding the trials with all six (main + confirm, each block once): everyone else in the first 10% of the block (the head of "Background"), against the priority fee in lamports and against reward per scheduled cost, among all of them and among those that pay a priority fee. Median Spearman rho over blocks; negative: a larger value earlier. Descriptive: the other transactions' arrival is unknown, and blocks hold bundles.`,
    '',
  )
  out.push('| group | blocks | median others in the head | median of them paying a priority fee | payers: rho, priority fee | payers: rho, reward/cost | all: rho, priority fee | all: rho, reward/cost |')
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|')
  const own = new Map<number, Set<number>>()
  for (const t of loaded.txs) if (t.slot !== null && t.index !== null) own.set(t.slot, (own.get(t.slot) ?? new Set()).add(t.index))
  const headRow = (label: string, us: Unit[]) => {
    const heads = [...new Set(us.flatMap((u) => u.slots))].filter((s) => loaded.blocks.has(s)).map((s) => headOfBlock(loaded.blocks.get(s)!, own.get(s) ?? new Set()))
    if (!heads.length) return
    out.push(
      `| ${label} | ${heads.length} | ${median(heads.map((h) => h.size))} | ${median(heads.map((h) => h.payers))} | ${f2(medianOf(heads.map((h) => h.feePayers)))} | ${f2(medianOf(heads.map((h) => h.rewardCostPayers)))} | ${f2(medianOf(heads.map((h) => h.feeAll)))} | ${f2(medianOf(heads.map((h) => h.rewardCostAll)))} |`,
    )
  }
  for (const id of totalFeeIds) headRow(`JitoLabs ${id.slice(0, 8)} ${nameOf(id)}`, six.filter((u) => u.leader === id))
  headRow('JitoLabs, the other validators', six.filter((u) => u.client === 'JitoLabs' && !totalFeeIds.includes(u.leader)))
  headRow(`Firedancer ${departs} ${nameOf(six.find((u) => u.leader.startsWith(departs))?.leader ?? '')}`, six.filter((u) => u.leader.startsWith(departs)))
  headRow('Firedancer, the other validators', six.filter((u) => u.client === 'Firedancer' && !u.leader.startsWith(departs)))
  for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS].filter((c) => c !== 'JitoLabs' && c !== 'Firedancer')) headRow(c, six.filter((u) => u.client === c))
  out.push('')

  // ---------- Rakurai's on-chain switch ----------
  const activation = readActivation(dataDir, cluster)
  if (activation) {
    const enabled = new Set(activation.accounts.filter((a) => a.isEnabled).map((a) => a.authority))
    const staked = (latest?.validators ?? []).filter((v) => v.leaderSlots > 0)
    const holders = staked.filter((v) => enabled.has(v.identity))
    const byClient = new Map<string, number>()
    for (const v of holders) byClient.set(v.client, (byClient.get(v.client) ?? 0) + 1)
    out.push(
      `**Rakurai's on-chain switch.** Rakurai's activation program holds one account per validator, whose flag says the validator and Rakurai approved its scheduler (\`rakurai-activation.json\`, read ${activation.takenAt.slice(0, 16).replace('T', ' ')} UTC, days after the runs). Of the ${staked.length} validators with leader slots in the main run's snapshot, ${holders.length} hold an enabled account, reporting ${[...byClient.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).map(([c, n]) => `${c} ${n}`).join(', ')}: an account says what was approved, not what runs, and it can outlive a change of client. The validators of "Validator by validator", by whether they hold one:`,
      '',
    )
    out.push("| label | validators | holding an enabled account | their trials: reward/cost, total fee, F last, other | the others' trials: reward/cost, total fee, F last, other | holders |")
    out.push('|---|---:|---:|---|---|---|')
    const tally = (xs: typeof measured) => {
      const sum = (k: OrderName | 'other') => xs.reduce((s, x) => s + x.r.counts[k], 0)
      return xs.length ? `${sum('rewardCost')}, ${sum('totalFee')}, ${sum('fLast')}, ${sum('other')}` : '–'
    }
    for (const c of [...LOCAL_CLIENTS, ...PIPELINE_CLIENTS]) {
      const all = measured.filter((x) => x.client === c)
      const hold = all.filter((x) => enabled.has(x.leader))
      out.push(`| ${c} | ${all.length} | ${hold.length} | ${tally(hold)} | ${tally(all.filter((x) => !enabled.has(x.leader)))} | ${hold.map((x) => x.leader.slice(0, 8)).join(', ') || '–'} |`)
    }
    out.push('')
    const jito = measured.filter((x) => x.client === 'JitoLabs')
    const tf = jito.filter((x) => x.r.counts.totalFee > 0)
    const rest = jito.filter((x) => x.r.counts.totalFee === 0)
    const held = (xs: typeof measured) => xs.filter((x) => enabled.has(x.leader)).length
    out.push(
      `JitoLabs: ${held(tf)} of the ${tf.length} validators with a total-fee trial hold an enabled account, and ${held(rest)} of the other ${rest.length}; Fisher's exact test, two-sided, p = ${fp(fisherExact(held(tf), tf.length - held(tf), held(rest), rest.length - held(rest)))}. The comparison was chosen after seeing the data.`,
      '',
    )
  }
  return out
}
