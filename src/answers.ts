// Two exploratory tables added on 2026-11-05, after every trial, outside all three plans. They read the committed trials
// again and test nothing. The first gathers the assignment's question, asked of each validator, over every run with the
// six roles of the main run; README copies it. The second asks whether a trial loses single transactions or whole
// bursts, which says whether requiring all six in the window can select on the order.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Loaded, Trial, Unit } from './analyze.ts'
import type { Snapshot } from './discover.ts'
import type { NamesFile } from './names.ts'
import { wilson } from './stats.ts'
import { before, RAKURAI_CAMPAIGN, SWAP_CAMPAIGN, SWAP_ORDERS } from './targeted.ts'
import { cellSafe, MIN_VALIDATOR_TRIALS, ORDER_LABEL, validatorReading } from './validators.ts'

/** The campaigns whose trials send the six roles of the main run; the swapped parameters are reported on their own. */
export const SAME_ROLES_CAMPAIGNS = ['main', 'confirm', RAKURAI_CAMPAIGN]
/** How a row sorts: what departs from the source first, then what follows it. */
const READING_ORDER = ['total fee', 'F last', 'mixed', 'reward/cost']
/** A name read from the chain is self-declared and may be long: a table cell keeps its start. */
const MAX_NAME = 30

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const shortName = (s: string) => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1).trimEnd()}…` : s)
const inPrimaryCell = (u: Pick<Unit, 'path' | 'delivery' | 'mode'>) => u.path === 'tpu' && u.delivery === 'buffered' && u.mode === 'shared'

export interface AnswerRow {
  leader: string
  name: string
  client: string
  versions: string[]
  rank: number
  n: number
  reading: string
  /** the trials in the order the reading names, or the most frequent named order when the reading is "mixed" */
  top: number
  counts: { rewardCost: number; totalFee: number; fLast: number; other: number }
}

/** One row per validator and reported client, for the validators with enough trials with all six in the window. */
export function answerRows(units: Unit[], nameOf: (id: string) => string, rankOf: (id: string) => number): AnswerRow[] {
  const six = units.filter((u) => SAME_ROLES_CAMPAIGNS.includes(u.campaign) && inPrimaryCell(u) && u.observedOrder.length === 6)
  const groups = new Map<string, Unit[]>()
  for (const u of six) groups.set(`${u.leader}|${u.client}`, [...(groups.get(`${u.leader}|${u.client}`) ?? []), u])
  const rows: AnswerRow[] = []
  for (const us of groups.values()) {
    const r = validatorReading(us.map((u) => u.observedOrder))
    rows.push({
      leader: us[0].leader,
      name: shortName(nameOf(us[0].leader)),
      client: us[0].client,
      versions: [...new Set(us.map((u) => u.version ?? '?'))].sort(byText),
      rank: rankOf(us[0].leader),
      n: r.n,
      reading: r.reading,
      top: r.topCount,
      counts: r.counts,
    })
  }
  const place = (x: AnswerRow) => {
    const i = READING_ORDER.indexOf(x.reading)
    return i < 0 ? READING_ORDER.length : i
  }
  return rows.sort((a, b) => place(a) - place(b) || a.rank - b.rank || byText(a.leader, b.leader) || byText(a.client, b.client))
}

/** The row as README shows it; test/answers.test.ts checks that README has every one of them, unchanged. */
export function answerRowText(x: AnswerRow): string {
  const reported = `${x.client} ${x.versions.join(', ')}`
  const rank = Number.isFinite(x.rank) ? String(x.rank) : '–'
  if (x.reading === 'mixed') {
    const c = x.counts
    return `| ${rank} | \`${x.leader.slice(0, 8)}\` | ${x.name} | ${reported} | **no single order** | ${c.rewardCost} reward/cost, ${c.totalFee} total fee, ${c.fLast} F last, ${c.other} other, of ${x.n} | – |`
  }
  const [lo, hi] = wilson(x.top, x.n)
  return `| ${rank} | \`${x.leader.slice(0, 8)}\` | ${x.name} | ${reported} | **${x.reading}** | ${x.top} of ${x.n} | ${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}% |`
}

function namesFrom(dataDir: string, cluster: string): (id: string) => string {
  const f = join(dataDir, cluster, 'validator-names.json')
  const names: NamesFile['names'] = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as NamesFile).names : {}
  return (id) => (names[id] ? cellSafe(names[id].name) : '–')
}

export interface AnswerInput {
  loaded: Loaded
  dataDir: string
  cluster: string
  /** the snapshot of the ranks: the main campaign's latest, as in "Validator by validator" */
  latest: Snapshot | undefined
}

export function answerSection({ loaded, dataDir, cluster, latest }: AnswerInput): string[] {
  const active = (latest?.validators ?? []).filter((v) => !v.delinquent && v.leaderSlots > 0)
  const slotsOf = new Map(active.map((v) => [v.identity, v.leaderSlots]))
  const rankOf = (id: string) => (slotsOf.has(id) ? 1 + active.filter((v) => v.leaderSlots > slotsOf.get(id)!).length : Infinity)
  const all = answerRows(loaded.units, namesFrom(dataDir, cluster), rankOf)
  const rows = all.filter((x) => x.n >= MIN_VALIDATOR_TRIALS)
  const rest = all.filter((x) => x.n < MIN_VALIDATOR_TRIALS)
  const out: string[] = ['## Every validator with a reading, all runs (exploratory)', '']
  out.push(
    `Added on 2026-11-05, after every trial, outside all three plans; README copies this table. The assignment's question, asked of each validator: the buffered/shared trials with all six in the window of campaigns ${SAME_ROLES_CAMPAIGNS.map((c) => `"${c}"`).join(', ')}, which send the same six roles, one row per validator and reported client. The rule of "Validator by validator" gives the reading: at least ${MIN_VALIDATOR_TRIALS} such trials, and one named order in at least 80% of them. Rank: by leader slots in the main run's snapshot (epoch ${latest?.epoch.epoch ?? '?'}). Interval: Wilson 95% on that share. It pools days and versions, and describes these trials, not the validator in general.`,
    '',
  )
  out.push('| rank | validator | name on chain | reported client | order of the six | trials in that order | 95% |')
  out.push('|---:|---|---|---|---|---|---|')
  for (const x of rows) out.push(answerRowText(x))
  out.push('')
  const validators = new Set(rows.map((x) => x.leader))
  const count = (r: string) => rows.filter((x) => x.reading === r).length
  out.push(
    `Rows: ${rows.length}, for ${validators.size} validators (a validator that changed reported client has a row for each). By reading: ${READING_ORDER.map((r) => `${ORDER_NAME[r] ?? r} ${count(r)}`).join(', ')}. Labels among them: ${new Set(rows.map((x) => x.client)).size}.`,
    '',
  )
  const sum = (k: keyof AnswerRow['counts']) => rest.reduce((s, x) => s + x.counts[k], 0)
  out.push(
    `The other ${new Set(rest.map((x) => x.leader)).size} validators (${rest.length} rows) have 1 to ${MIN_VALIDATOR_TRIALS - 1} such trials each, too few for a reading of their own. Pooled, their ${rest.reduce((s, x) => s + x.n, 0)} trials: ${sum('rewardCost')} reward/cost, ${sum('totalFee')} total fee, ${sum('fLast')} F last, ${sum('other')} other.`,
    '',
  )
  const swap = loaded.units.filter((u) => u.campaign === SWAP_CAMPAIGN && inPrimaryCell(u))
  if (swap.length) {
    const orders = swap.map((u) => u.observedOrder)
    const b = before(orders, 'B', 'D')
    out.push(
      `Not in the table: campaign "${SWAP_CAMPAIGN}", the same trials with the parameters of B and D swapped, ${swap[0].leader.slice(0, 8)} only: B before D in ${b.k} of ${b.n}, ${orders.filter((o) => SWAP_ORDERS.totalFee.test(o)).length} of ${orders.length} in the exact total-fee order.`,
      '',
    )
  }
  const direct = loaded.trials.filter((t) => t.path === 'tpu')
  out.push(`Scale: ${direct.length} trials on the direct path over all campaigns, aimed at ${new Set(direct.map((t) => t.targetLeader)).size} validators.`, '')
  return out
}

/** How a reading is called in running text. */
const ORDER_NAME: Record<string, string> = { 'total fee': ORDER_LABEL.totalFee, 'F last': ORDER_LABEL.fLast, 'reward/cost': ORDER_LABEL.rewardCost, mixed: 'no single order' }

export interface Fate {
  trials: number
  /** all six in the targeted window */
  allInWindow: number
  /** none in the window, and all six landed in other slots */
  allOutside: number
  /** none of the six landed anywhere */
  noneLanded: number
  /** anything else: the burst was split by the window, or lost some transactions */
  split: number
}

/** What became of each burst: the unit of loss. */
export function burstFates(trials: Pick<Trial, 'run' | 'trial'>[], inWindow: (t: Pick<Trial, 'run' | 'trial'>) => number, landed: (t: Pick<Trial, 'run' | 'trial'>) => number): Fate {
  const f: Fate = { trials: trials.length, allInWindow: 0, allOutside: 0, noneLanded: 0, split: 0 }
  for (const t of trials) {
    const w = inWindow(t)
    const l = landed(t)
    if (w === 6) f.allInWindow++
    else if (l === 0) f.noneLanded++
    else if (w === 0 && l === 6) f.allOutside++
    else f.split++
  }
  return f
}

export function attritionSection(loaded: Loaded): string[] {
  const key = (t: { run: string; trial: number }) => `${t.run}#${t.trial}`
  const landedCount = new Map<string, number>()
  for (const x of loaded.txs) if (x.slot !== null) landedCount.set(key(x), (landedCount.get(key(x)) ?? 0) + 1)
  const inWindow = (t: { run: string; trial: number }) => loaded.onTarget.get(key(t))?.length ?? 0
  const landed = (t: { run: string; trial: number }) => landedCount.get(key(t)) ?? 0
  const campaigns = [...SAME_ROLES_CAMPAIGNS, SWAP_CAMPAIGN]
  const direct = loaded.trials.filter((t) => t.path === 'tpu' && campaigns.includes(t.campaign))
  const out: string[] = ['## What a trial loses: single transactions or whole bursts (exploratory)', '']
  out.push(
    'Added on 2026-11-05, after every trial, outside all three plans. Trials count only with their roles in the window, so a loss that depends on the role could select on the order. What became of each burst, by campaign and cell: all six in the targeted window; none in it, all six landed in other slots; none of the six landed; or split, some in the window and the rest elsewhere or lost.',
    '',
  )
  out.push('| campaign | cell | trials | all six in the window | all six outside it | none landed | split |')
  out.push('|---|---|---:|---:|---:|---:|---:|')
  const cellOf = (t: Trial) => `${t.delivery}/${t.mode}`
  for (const c of campaigns)
    for (const cell of [...new Set(direct.filter((t) => t.campaign === c).map(cellOf))].sort(byText)) {
      const f = burstFates(direct.filter((t) => t.campaign === c && cellOf(t) === cell), inWindow, landed)
      out.push(`| ${c} | ${cell} | ${f.trials} | ${f.allInWindow} | ${f.allOutside} | ${f.noneLanded} | ${f.split} |`)
    }
  out.push('')
  const held = direct.filter((t) => t.delivery === 'buffered')
  const f = burstFates(held, inWindow, landed)
  const primary = burstFates(direct.filter((t) => t.campaign === 'main' && cellOf(t) === 'buffered/shared'), inWindow, landed)
  const lostShare = (ts: Trial[]) => `${ts.filter((t) => landed(t) === 0).length} of ${ts.length}`
  out.push(
    `Every buffered trial of these campaigns: ${f.trials}, of which ${f.split} split. Main run, buffered/shared: ${primary.allInWindow} of ${primary.trials} with all six in the window, ${primary.allOutside} all outside it, ${primary.noneLanded} with none landed, ${primary.split} split. A burst that is not split has no role that was lost and others that were not, so in the cells without split trials, requiring all six cannot select on the order among the six. It can still select between bursts and validators. Buffered trials with none landed, by the port of the address aimed at: port 11228, ${lostShare(held.filter((t) => t.port === '11228'))}; other ports, ${lostShare(held.filter((t) => t.port !== '11228'))}.`,
    '',
  )
  return out
}
