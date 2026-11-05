// `show <run> <trial>`: one trial read from the chain, not from our files. Position, slot, fee and ComputeBudget
// instructions come from public RPC; only the send order and which of two identical roles is which come from our log,
// and the output says so. It then compares what it read with what the run recorded. Nothing here needs a key.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Landed } from './collect.ts'
import { WINDOW_SLOTS } from './design.ts'
import type { Rpc } from './rpc.ts'
import { SWAP_CAMPAIGN, SWAP_ORDERS } from './targeted.ts'
import { readJsonl } from './util.ts'
import { ORDERS } from './validators.ts'
import { computeBudgetOf, first } from './verify.ts'

/** What each campaign's roles predict, in the words of the report. */
const PREDICTIONS: Record<string, [string, RegExp][]> = {
  standard: [
    ['reward/cost: A and E either way, D, C, F, B', ORDERS.rewardCost],
    ['total fee: B, D, then A, E, F in any order, C', ORDERS.totalFee],
    ['F last: A and E either way, D, B and C either way, F', ORDERS.fLast],
  ],
  [SWAP_CAMPAIGN]: [
    ['total fee: B, D, then A, E, F in any order, C', SWAP_ORDERS.totalFee],
    ['the larger limit first: D, B, then A, E, F, C', SWAP_ORDERS.largerLimitFirst],
    ['reward/cost: B, A and E either way, C, F, D', SWAP_ORDERS.rewardCost],
  ],
}

const pad = (x: unknown, n: number) => String(x).padEnd(n)
const padNum = (x: unknown, n: number) => String(x).padStart(n)

export interface Shown {
  lines: string[]
  /** where the chain and the recorded run differ */
  problems: string[]
  /** the roles in landing order, within the targeted window */
  order: string
}

export async function showTrial(rpcs: Rpc[], runsRoot: string, run: string, trial: number): Promise<Shown> {
  const dir = join(runsRoot, run)
  if (!existsSync(join(dir, 'run.json'))) throw new Error(`no run ${run} in ${runsRoot}`)
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  const t = readJsonl(join(dir, 'trials.jsonl')).find((x) => x.trial === trial && x.live)
  if (!t) throw new Error(`no live trial ${trial} in run ${run}: data/mainnet-beta/results/orders.md lists the trials`)
  const txs = readJsonl(join(dir, 'txs.jsonl')).filter((x) => x.trial === trial && x.live)
  const recorded = new Map<string, Landed>(existsSync(join(dir, 'landed.json')) ? (JSON.parse(readFileSync(join(dir, 'landed.json'), 'utf8')) as Landed[]).map((l) => [l.signature, l]) : [])
  const problems: string[] = []
  const campaign: string = meta.campaign ?? 'calibration'

  const fromChain: { role: string; signature: string; slot: number | null; index: number | null; fee: number | null; budget: ReturnType<typeof computeBudgetOf> | null }[] = []
  const blocks = new Map<number, any>()
  for (const x of [...txs].sort((a, b) => a.role.localeCompare(b.role))) {
    const { value: tx } = await first<any>(rpcs, 'getTransaction', [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    if (!tx) {
      fromChain.push({ role: x.role, signature: x.signature, slot: null, index: null, fee: null, budget: null })
      continue
    }
    if (!blocks.has(tx.slot)) blocks.set(tx.slot, (await first<any>(rpcs, 'getBlock', [tx.slot, { transactionDetails: 'signatures', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'finalized' }])).value)
    const index: number | null = blocks.get(tx.slot)?.signatures.indexOf(x.signature) ?? null
    const budget = computeBudgetOf(tx.transaction.message)
    fromChain.push({ role: x.role, signature: x.signature, slot: tx.slot, index, fee: tx.meta.fee, budget })
    const want = { cuLimit: x.cuLimit, cuPrice: Number(x.cuPrice), loadedLimit: x.loadedLimit ?? 16_384 }
    if (budget.cuLimit !== want.cuLimit || budget.cuPrice !== want.cuPrice || budget.loadedLimit !== want.loadedLimit) problems.push(`${x.role}: the ComputeBudget instructions on chain are not the recorded ${JSON.stringify(want)}`)
    const r = recorded.get(x.signature)
    if (r && (r.slot !== tx.slot || r.index !== index || (r.fee !== null && r.fee !== tx.meta.fee))) problems.push(`${x.role}: on chain slot ${tx.slot}, index ${index}, fee ${tx.meta.fee}; recorded slot ${r.slot}, index ${r.index}, fee ${r.fee}`)
  }
  for (const x of fromChain) {
    const r = recorded.get(x.signature)
    if (x.slot === null && r && r.slot !== null) problems.push(`${x.role}: recorded in slot ${r.slot}, but no endpoint returned it`)
    if (x.slot !== null && r && r.slot === null) problems.push(`${x.role}: recorded as not landed, but on chain in slot ${x.slot}`)
  }

  const landed = fromChain.filter((x) => x.slot !== null).sort((a, b) => a.slot! - b.slot! || (a.index ?? 0) - (b.index ?? 0))
  const inWindow = (x: { slot: number | null }) => x.slot !== null && x.slot >= t.windowStart && x.slot < t.windowStart + WINDOW_SLOTS
  const order = landed.filter(inWindow).map((x) => x.role).join('')
  const sendOrder = [...txs].sort((a, b) => a.sendIndex - b.sendIndex).map((x) => x.role)
  const lines: string[] = []
  lines.push(`Run ${run}, trial ${trial}, campaign ${campaign}, cell ${t.delivery ?? t.timing}/${t.mode}`)
  lines.push(`Aimed at ${t.leader} (${t.client}${t.version ? ` ${t.version}` : ''} in the run's snapshot of gossip), window ${t.windowStart} to ${t.windowStart + WINDOW_SLOTS - 1}.`)
  lines.push(`Sent in this order, from our log: ${sendOrder.join(' ')}`)
  lines.push('')
  lines.push('From the chain, in landing order (the role names come from our log; the chain checks their fees and limits):')
  lines.push(`${padNum('slot', 10)} ${padNum('index', 5)}  ${pad('role', 4)} ${padNum('fee', 7)} ${padNum('CU limit', 8)} ${padNum('µL/CU', 9)} ${padNum('loaded limit', 12)}  signature`)
  for (const x of landed) lines.push(`${padNum(x.slot, 10)} ${padNum(x.index, 5)}  ${pad(x.role, 4)} ${padNum(x.fee, 7)} ${padNum(x.budget?.cuLimit, 8)} ${padNum(x.budget?.cuPrice, 9)} ${padNum(x.budget?.loadedLimit, 12)}  ${x.signature}`)
  for (const x of fromChain.filter((y) => y.slot === null)) lines.push(`${padNum('–', 10)} ${padNum('–', 5)}  ${pad(x.role, 4)} not on chain, or no endpoint keeps it  ${x.signature}`)
  lines.push('')
  for (const slot of [...new Set(landed.map((x) => x.slot!))]) {
    const { value: leaders } = await first<string[]>(rpcs, 'getSlotLeaders', [slot, 1])
    const collector = (blocks.get(slot)?.rewards ?? []).find((r: any) => r.rewardType === 'Fee')?.pubkey ?? null
    if (leaders?.[0]) {
      lines.push(`Leader of slot ${slot}, from the leader schedule: ${leaders[0]}`)
      if (inWindow({ slot }) && leaders[0] !== t.leader) problems.push(`slot ${slot}: the schedule names ${leaders[0]}, the trial aimed at ${t.leader}`)
    } else lines.push(`Fee recipient of slot ${slot} (no endpoint still serves that epoch's schedule; some validators collect in a separate account): ${collector ?? 'not available'}`)
  }
  lines.push('')
  lines.push(`In the window, in landing order: ${order.split('').join(' ') || 'nothing'}`)
  for (const [name, re] of PREDICTIONS[campaign] ?? PREDICTIONS.standard) lines.push(`  ${pad(re.test(order) ? 'matches' : 'does not match', 15)} ${name}`)
  lines.push(problems.length ? `The recorded run differs from the chain: ${problems.length} problems` : 'The recorded run agrees with the chain.')
  for (const p of problems) lines.push(`  ${p}`)
  return { lines, problems, order }
}
