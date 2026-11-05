// Does the analysis read a rule it is given? Simulated leaders follow a stated rule, and their orders go through the
// code that reads the real trials: testFamily, verdict, interpret, validatorReading, twinStat and the swapped orders.
// Each simulated trial has a fresh random send order, as the real ones do. Seeded, so the file it writes is compared
// byte for byte by `reproduce`. Added on 2026-11-05, after every trial: it changes no test and no verdict.
//
// This tests the analysis, not the path to the leader. The known answers on chain are in REPORT: Agave 4.3.2, whose
// source we read, and Jito 4.4.0, whose change of ties the source predicted (H3 of the targeted run).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { interpret, PRIMARY, testFamily, type Tx, twinStat, type Unit, verdict, type Verdict } from './analyze.ts'
import { BASE_FEE_PER_SIGNATURE, expectedCost, LOCAL_CLIENTS, priorityFee, type Role, ROLES, type RoleSpec, SWAPPED_ROLES } from './design.ts'
import { before, SWAP_ORDERS, upperTail } from './targeted.ts'
import { rng, shuffle } from './util.ts'
import { validatorReading } from './validators.ts'

/** A simulated leader: from a send order, the order the six land in. */
export type Scheduler = (send: Role[], random: () => number) => Role[]
type Key = (s: RoleSpec) => number
type Tie = 'random' | 'oldest first' | 'newest first'

const reward = (s: RoleSpec, share: number) => Number(priorityFee(s)) + share * Number(BASE_FEE_PER_SIGNATURE)
const cost = (s: RoleSpec) => expectedCost(s) + 1
const fee = (s: RoleSpec) => Number(priorityFee(s))
export const KEYS = {
  rewardCost: (share = 0.5): Key => (s) => reward(s, share) / cost(s),
  linear: (lambda: number): Key => (s) => reward(s, 0.5) - lambda * cost(s),
  totalFee: fee,
  priorityPerCost: (s: RoleSpec) => fee(s) / cost(s),
  price: (s: RoleSpec) => Number(s.cuPrice),
  /** the larger requested compute-unit limit first, the larger fee between equal limits */
  largerLimit: (s: RoleSpec) => s.cuLimit * 1e6 + fee(s),
  costAlone: (s: RoleSpec) => -cost(s),
}

/** Sorts by the key, best first; equal keys go by the tie rule. */
export function sortBy(key: Key, tie: Tie = 'random', roles: RoleSpec[] = ROLES): Scheduler {
  return (send, random) => {
    const place = (r: RoleSpec) => send.indexOf(r.role)
    const start = tie === 'random' ? shuffle(roles, random) : [...roles].sort((a, b) => (tie === 'oldest first' ? place(a) - place(b) : place(b) - place(a)))
    return start.sort((a, b) => key(b) - key(a)).map((r) => r.role)
  }
}
const arrival: Scheduler = (send) => [...send]
const reverseArrival: Scheduler = (send) => [...send].reverse()
const anyOrder: Scheduler = (send, random) => shuffle(send, random)
/** Trial by trial, the first scheduler in this share of the trials, the second in the rest. */
const mix = (share: number, a: Scheduler, b: Scheduler): Scheduler => (send, random) => (random() < share ? a(send, random) : b(send, random))

/** What the plan says of a contrast when a key decides it: holds when the key puts the named order first. */
function expectedOf(key: Key): { control: boolean; verdicts: Verdict[] } {
  const role = (r: Role) => key(ROLES.find((x) => x.role === r)!)
  const say = (a: number, b: number): Verdict => (a > b ? 'holds' : a < b ? 'reversed' : 'no stable order')
  return { control: role('A') > role('C'), verdicts: [say(role('A'), role('F')), say(role('C'), role('B')), say(role('D'), role('C'))] }
}
const UNRELATED = { control: false, verdicts: ['no stable order', 'no stable order', 'no stable order'] as Verdict[] }

export interface KnownRule {
  name: string
  /** the order of the six the rule gives, for the table */
  order: string
  scheduler: Scheduler
  /** what the plan says when the analysis reads this rule right; none for a rule that is only partly followed */
  expected?: { control: boolean; verdicts: Verdict[] }
  /** the reading "Validator by validator" should give it */
  reading?: string
  /** trials per label: 30 as in the primary family, 15 as in the pipelines' */
  trials?: number
  note?: string
}

const key = (k: Key, name: string, order: string, reading: string, note?: string): KnownRule => ({ name, order, scheduler: sortBy(k), expected: expectedOf(k), reading, note })
const rewardCost = sortBy(KEYS.rewardCost())
/** Harmonic's orders in the main run: A E D, then B before C in 19 of its 30 trials and C before B in 11, F last */
const movingShare = mix(19 / 30, sortBy(KEYS.rewardCost(0.117)), sortBy(KEYS.rewardCost(0.15)))

export const RULES: KnownRule[] = [
  key(KEYS.rewardCost(), "reward/cost, the source's formula", 'A E D C F B', 'reward/cost'),
  key(KEYS.linear(1.4), 'reward − 1.4 × cost', 'A E D C F B', 'reward/cost', 'a look-alike: the six do not separate it from reward/cost, and README says so'),
  key(KEYS.totalFee, 'total fee', 'B D, A E F, C', 'total fee'),
  key(KEYS.largerLimit, 'the larger limit first', 'B D, A E F, C', 'total fee', 'a look-alike: the six do not separate it from total fee; the swapped parameters do, below'),
  key(KEYS.priorityPerCost, 'priority fee per cost', 'A E D B F C', 'mixed'),
  key(KEYS.price, 'price per compute unit', 'A E F, D B C', 'mixed'),
  key(KEYS.rewardCost(1), 'reward/cost, the whole base fee', 'A E C D F B', 'mixed'),
  key(KEYS.costAlone, 'the smaller cost first', 'A E C, D F B', 'mixed'),
  key(KEYS.rewardCost(0.15), 'reward/cost, base-fee share 0.15', 'A E D C B F', 'F last'),
  { name: 'reward/cost, a share that moves between 0.117 and 0.15', order: 'A E D, B C either way, F', scheduler: movingShare, expected: { control: true, verdicts: ['holds', 'no stable order', 'holds'] }, reading: 'F last', trials: 15, note: 'what Harmonic did; 15 trials a label, as in its family' },
  { name: 'arrival, the first sent first', order: 'the send order', scheduler: arrival, expected: UNRELATED, reading: 'mixed' },
  { name: 'arrival, the last sent first', order: 'the send order reversed', scheduler: reverseArrival, expected: UNRELATED, reading: 'mixed' },
  { name: 'no rule: a random order', order: 'random', scheduler: anyOrder, expected: UNRELATED, reading: 'mixed' },
  { name: 'reward/cost in 90% of trials, else random', order: 'A E D C F B or random', scheduler: mix(0.9, rewardCost, anyOrder) },
  { name: 'reward/cost in 70% of trials, else random', order: 'A E D C F B or random', scheduler: mix(0.7, rewardCost, anyOrder) },
  { name: 'reward/cost in 50% of trials, else random', order: 'A E D C F B or random', scheduler: mix(0.5, rewardCost, anyOrder) },
  { name: 'reward/cost in 30% of trials, else random', order: 'A E D C F B or random', scheduler: mix(0.3, rewardCost, anyOrder) },
  { name: 'half reward/cost, half total fee', order: 'one or the other, by trial', scheduler: mix(0.5, rewardCost, sortBy(KEYS.totalFee)), expected: { control: true, verdicts: ['holds', 'no stable order', 'holds'] }, reading: 'mixed', note: 'what Ha1iade1 looked like' },
]

const ALL_ROLES = ROLES.map((r) => r.role)

/** One simulated label: its trials as the analysis sees them. */
function simulate(s: Scheduler, n: number, label: string, random: () => number, units: Unit[], ordered: Map<string, Tx[]>): void {
  for (let i = 0; i < n; i++) {
    const send = shuffle(ALL_ROLES, random)
    const landed = s(send, random)
    const trial = units.length
    units.push({ run: 'sim', trial, client: label, leader: label } as Unit)
    ordered.set(`sim#${trial}`, landed.map((role) => ({ role, sendIndex: send.indexOf(role) }) as Tx))
  }
}

export interface FamilyOutcome {
  /** counts of each verdict, per contrast of PRIMARY */
  verdicts: Map<Verdict, number>[]
  controlPasses: number
  readings: Map<string, number>
  labels: number
  /** tests with an exact p below 0.05 before any adjustment, of all tests */
  unadjusted: number
  tests: number
  /** data sets with at least one "holds" among the twelve */
  familiesWithHolds: number
  families: number
}

const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)

/** The primary family, repeated: four labels following the rule, three contrasts, Holm over the twelve, the real code. */
export function familyOutcome(rule: KnownRule, reps: number, seed: number): FamilyOutcome {
  const random = rng(seed)
  const out: FamilyOutcome = { verdicts: PRIMARY.map(() => new Map()), controlPasses: 0, readings: new Map(), labels: 0, unadjusted: 0, tests: 0, familiesWithHolds: 0, families: reps }
  for (let r = 0; r < reps; r++) {
    const units: Unit[] = []
    const ordered = new Map<string, Tx[]>()
    for (const label of LOCAL_CLIENTS) simulate(rule.scheduler, rule.trials ?? 30, label, random, units, ordered)
    const rows = testFamily(units, ordered)
    if (rows.some((row) => row.stats.some((x) => verdict(x) === 'holds'))) out.familiesWithHolds++
    for (const row of rows) {
      out.labels++
      const v = row.stats.map(verdict)
      v.forEach((x, i) => bump(out.verdicts[i], x))
      if (row.control.p < 0.05) out.controlPasses++
      bump(out.readings, interpret(row.control, v))
      for (const s of row.stats) {
        out.tests++
        if (s.p < 0.05) out.unadjusted++
      }
    }
  }
  return out
}

/** The reading of one validator with n trials, repeated. */
export function readingOutcome(s: Scheduler, n: number, reps: number, seed: number): Map<string, number> {
  const random = rng(seed)
  const out = new Map<string, number>()
  for (let r = 0; r < reps; r++) bump(out, validatorReading(Array.from({ length: n }, () => s(shuffle(ALL_ROLES, random), random).join(''))).reading)
  return out
}

/** The most frequent first, the others from 5% on. */
function shares(m: Map<string, number>): string {
  const total = [...m.values()].reduce((a, b) => a + b, 0)
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  return sorted
    .filter(([, c], i) => i === 0 || c / total >= 0.05)
    .map(([k, c]) => `${k} ${(100 * c / total).toFixed(0)}%`)
    .join(', ')
}
export const mostFrequent = <K>(m: Map<K, number>): K => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]

/** The swapped parameters: what H2 and the exact orders say of each rule. */
export function swapOutcome(k: Key, trials: number, reps: number, seed: number) {
  const random = rng(seed)
  const s = sortBy(k, 'random', SWAPPED_ROLES)
  let bBeforeD = 0
  let confirmed = 0
  const exact = { totalFee: 0, largerLimitFirst: 0, rewardCost: 0 }
  for (let r = 0; r < reps; r++) {
    const orders = Array.from({ length: trials }, () => s(shuffle(ALL_ROLES, random), random).join(''))
    const b = before(orders, 'B', 'D')
    bBeforeD += b.k
    if (upperTail(b.k, b.n) < 0.05) confirmed++
    for (const o of orders) for (const name of Object.keys(exact) as (keyof typeof exact)[]) if (SWAP_ORDERS[name].test(o)) exact[name]++
  }
  const n = trials * reps
  return { bBeforeD: bBeforeD / n, confirmed: confirmed / reps, exact: { totalFee: exact.totalFee / n, largerLimitFirst: exact.largerLimitFirst / n, rewardCost: exact.rewardCost / n } }
}

/** The twins: what twinStat says of each tie rule, and how often the exact test of H3 passes. */
export function twinOutcome(tie: Tie, trials: number, reps: number, seed: number) {
  const random = rng(seed)
  const s = sortBy(KEYS.rewardCost(), tie)
  let share = 0
  let passes = 0
  for (let r = 0; r < reps; r++) {
    const units: Unit[] = []
    const ordered = new Map<string, Tx[]>()
    simulate(s, trials, 'x', random, units, ordered)
    const t = twinStat(units, ordered)
    share += t.share
    if (upperTail(Math.round(t.share * t.n), t.n) < 0.05) passes++
  }
  return { share: share / reps, passes: passes / reps }
}

export const READING_SIZES = [5, 8, 15, 30]
/** data sets per rule: four labels each, so four times as many labels */
export const DEFAULT_REPS = 60
const READING_REPS = 4000
const OTHER_REPS = 1000

export function knownAnswers(reps = DEFAULT_REPS): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`
  const out: string[] = []
  out.push('# Known answers (generated by `node src/cli.ts known-answers`; seeded, no network, no trial)', '')
  out.push(
    "Added on 2026-11-05, after every trial; it changes no test and no verdict. Does the analysis read a rule it is given? Simulated leaders follow a stated rule, and each simulated trial has a fresh random send order, as the real ones do. Their orders go through the code that reads the real trials (`testFamily`, `verdict`, `interpret`, `validatorReading`, `twinStat`, `src/knownanswers.ts`). This tests the analysis, not the path to the leader. The known answers on chain are in REPORT: Agave 4.3.2, whose source we read, and Jito 4.4.0, whose change of ties the source predicted.",
    '',
  )
  out.push(`## The primary family, ${reps} simulated data sets per rule`, '')
  out.push(
    `Each data set: four labels following the rule, 30 trials a label unless the rule says otherwise, three contrasts, Holm over the twelve tests. A cell gives how often each verdict came out, over ${reps * 4} labels (the most frequent first, the others from 5% on). Predicted: the verdicts of the plan, A,E before F / C before B / D before C, when a rule decides all three; "–" for a rule followed only in part. Control: the labels with A,E before C at p < 0.05 (below that the plan says "no fee ordering detected").`,
    '',
  )
  out.push(`| the simulated leader follows | its order | predicted | control passes | ${PRIMARY.map((c) => c.name).join(' | ')} | as predicted |`)
  out.push(`|---|---|---|---:|${PRIMARY.map(() => '---').join('|')}|---|`)
  const outcomes = RULES.map((rule, i) => familyOutcome(rule, reps, 1000 + i))
  RULES.forEach((rule, i) => {
    const o = outcomes[i]
    const predicted = rule.expected ? rule.expected.verdicts.join(' / ') : '–'
    const asPredicted = rule.expected ? (o.verdicts.every((m, j) => mostFrequent(m) === rule.expected!.verdicts[j]) && o.controlPasses / o.labels >= 0.5 === rule.expected.control ? 'yes' : '**no**') : '–'
    out.push(`| ${rule.name}${rule.trials ? ` (${rule.trials} trials a label)` : ''} | ${rule.order} | ${predicted} | ${pct(o.controlPasses / o.labels)} | ${o.verdicts.map((m) => shares(m)).join(' | ')} | ${asPredicted} |`)
  })
  out.push('')
  const predicted = RULES.map((rule, i) => ({ rule, o: outcomes[i] })).filter((x) => x.rule.expected)
  const asPredicted = predicted.filter(({ rule, o }) => o.verdicts.every((m, j) => mostFrequent(m) === rule.expected!.verdicts[j]) && o.controlPasses / o.labels >= 0.5 === rule.expected!.control).length
  out.push(`Of the ${predicted.length} rules with a prediction, ${asPredicted} were read as predicted: the most frequent verdict of every contrast, and the control.`, '')
  const notes = RULES.filter((r) => r.note).map((r) => `- ${r.name}: ${r.note}.`)
  out.push(...notes, '')
  const unrelated = RULES.flatMap((r, i) => (r.expected === UNRELATED ? [outcomes[i]] : []))
  const tests = unrelated.reduce((s, o) => s + o.tests, 0)
  const holdsAfter = unrelated.reduce((s, o) => s + o.verdicts.reduce((t, m) => t + (m.get('holds') ?? 0), 0), 0)
  const before5 = unrelated.reduce((s, o) => s + o.unadjusted, 0)
  const margin = 196 * Math.sqrt(0.05 * 0.95 / tests)
  const alarmed = unrelated.reduce((s, o) => s + o.familiesWithHolds, 0)
  const sets = unrelated.reduce((s, o) => s + o.families, 0)
  out.push(
    `**False alarms.** For the three orders unrelated to the fees (arrival either way, random), ${before5} of ${tests} tests (${(100 * before5 / tests).toFixed(1)}%) had an exact p below 0.05 before adjustment; a 5% test gives that within ${margin.toFixed(1)} points, at this many tests. After Holm, ${holdsAfter} of the ${tests} came out "holds", in ${alarmed} of the ${sets} data sets (${(100 * alarmed / sets).toFixed(1)}%; the family's level is 5%). Chance-level order is mostly "no stable order", and sometimes "inconclusive" or "reversed" by chance; the control then says "no fee ordering detected" for the label.`,
    '',
  )
  out.push('**The reading the plan prints for each rule**, the most frequent over its labels:', '')
  RULES.forEach((rule, i) => out.push(`- ${rule.name}: ${mostFrequent(outcomes[i].readings)}.`))
  out.push('')

  out.push(`## One validator with few trials, ${READING_REPS} simulated validators per rule and size`, '')
  out.push(`The reading of "Validator by validator": at least 5 trials with all six, and one named order in at least 80% of them. Predicted: the reading when the analysis reads the rule right.`, '')
  out.push(`| the simulated validator follows | predicted | ${READING_SIZES.map((n) => `${n} trials`).join(' | ')} |`)
  out.push(`|---|---|${READING_SIZES.map(() => '---').join('|')}|`)
  let namedFromNoise = 0
  let noiseValidators = 0
  RULES.forEach((rule, i) => {
    const cells = READING_SIZES.map((n, j) => readingOutcome(rule.scheduler, n, READING_REPS, 5000 + i * 10 + j))
    if (rule.expected === UNRELATED)
      for (const m of cells) {
        noiseValidators += READING_REPS
        namedFromNoise += READING_REPS - (m.get('mixed') ?? 0)
      }
    out.push(`| ${rule.name} | ${rule.reading ?? '–'} | ${cells.map(shares).join(' | ')} |`)
  })
  out.push('')
  out.push(
    `**What a reading is worth.** Under an order unrelated to the fees, ${namedFromNoise} of ${noiseValidators} simulated validators got the reading of a named order. A rule followed strictly is read at every size. A rule followed in 70% of trials can pass as a named order at 5 trials, about as often as not, and mostly reads "mixed" from 8 trials on. A validator that alternates between two rules reads as one of them in a third of cases at 5 trials: readings at the floor are the weakest, and the size of each reading is in the table it comes from.`,
    '',
  )

  out.push(`## The swapped parameters, 12 trials, ${OTHER_REPS} simulated runs`, '')
  out.push('B pays 10 000 lamports for 1 000 CU, D 9 000 for 40 000. H2 of the targeted run: B before D, one-sided exact binomial. Exact orders as in "Targeted run".', '')
  out.push('| the simulated leader follows | B before D | H2 passes at p < 0.05 | exact total-fee order | exact larger-limit order | exact reward/cost order |')
  out.push('|---|---:|---:|---:|---:|---:|')
  const swapRows: [string, Key][] = [['total fee', KEYS.totalFee], ['the larger limit first', KEYS.largerLimit], ['reward/cost', KEYS.rewardCost()]]
  swapRows.forEach(([name, k], i) => {
    const s = swapOutcome(k, 12, OTHER_REPS, 7000 + i)
    out.push(`| ${name} | ${pct(s.bBeforeD)} | ${pct(s.confirmed)} | ${pct(s.exact.totalFee)} | ${pct(s.exact.largerLimitFirst)} | ${pct(s.exact.rewardCost)} |`)
  })
  out.push('')
  out.push('H2 separates total fee from the larger limit first. It does not separate total fee from reward/cost, which also puts B before D here: the exact order does, and that is why REPORT gives both.', '')

  out.push(`## The twins, 32 trials, ${OTHER_REPS} simulated runs`, '')
  out.push('A and E have equal keys, so only the tie rule places them. The twin sent first landed first, as `twinStat` counts it; H3 of the targeted run is the one-sided exact binomial.', '')
  out.push('| ties go | twin sent first landed first | the exact test passes at p < 0.05 |')
  out.push('|---|---:|---:|')
  const ties: Tie[] = ['random', 'oldest first', 'newest first']
  ties.forEach((tie, i) => {
    const t = twinOutcome(tie, 32, OTHER_REPS, 8000 + i)
    out.push(`| ${tie} | ${pct(t.share)} | ${pct(t.passes)} |`)
  })
  out.push('')
  return out.join('\n')
}

export const KNOWN_ANSWERS_FILE = 'known-answers.md'

export function writeKnownAnswers(dataDir: string, cluster: string): void {
  const dir = join(dataDir, cluster, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, KNOWN_ANSWERS_FILE), knownAnswers())
}

