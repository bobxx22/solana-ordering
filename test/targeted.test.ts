import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadRuns } from '../src/analyze.ts'
import { buildTrialTxs, expectedCost, expectedPriority, expectedReward, priorityFee, priorityPerCost, ROLES, type Role, type RoleSpec, SWAPPED_ROLES, trialCost } from '../src/design.ts'
import type { Snapshot } from '../src/discover.ts'
import { generateKeypairBytes, signerFromBytes } from '../src/keys.ts'
import type { ActivationFile } from '../src/names.ts'
import { before, HOLDERS, holmAdjust, MATCHED, permutationP, selectPanel, SWAP_ORDERS, targetedVerdict, testH1, twinFirst, upperTail } from '../src/targeted.ts'

const rank = (key: (s: RoleSpec) => number) =>
  [...SWAPPED_ROLES]
    .sort((a, b) => key(b) - key(a))
    .map((s) => s.role)
    .join('')

test('the swapped parameters: only B and D change, and a trial costs the same', () => {
  for (const r of SWAPPED_ROLES) if (r.role !== 'B' && r.role !== 'D') assert.deepEqual(r, ROLES.find((x) => x.role === r.role))
  const role = Object.fromEntries(SWAPPED_ROLES.map((r) => [r.role, r])) as Record<Role, RoleSpec>
  assert.equal(priorityFee(role.B), 10_000n)
  assert.equal(priorityFee(role.D), 9_000n)
  assert.equal(role.B.cuLimit, 1_000)
  assert.equal(role.D.cuLimit, 40_000)
  assert.equal(expectedCost(role.D), 41_335)
  assert.equal(trialCost(), 61_000n)
  // no rule of the first design changes its mind about A, E, F and C
  assert.equal(Number(expectedReward(role.A)), 6_500)
})

test('the swapped parameters separate the rules the first design could not', () => {
  const totalFee = rank((s) => Number(priorityFee(s)))
  const largerLimit = rank((s) => s.cuLimit * 1e6 + Number(priorityFee(s)))
  const rewardCost = rank(expectedPriority)
  assert.equal(totalFee, 'BDAEFC')
  assert.equal(largerLimit, 'DBAEFC')
  assert.equal(rewardCost, 'BAECFD')
  assert.equal(rank(priorityPerCost), 'BAEDFC')
  assert.match(totalFee, SWAP_ORDERS.totalFee)
  assert.match(largerLimit, SWAP_ORDERS.largerLimitFirst)
  assert.match(rewardCost, SWAP_ORDERS.rewardCost)
  assert.doesNotMatch(largerLimit, SWAP_ORDERS.totalFee)
  assert.doesNotMatch(rewardCost, SWAP_ORDERS.totalFee)
})

test('a trial can be built with the swapped parameters', () => {
  const payers = SWAPPED_ROLES.map(() => signerFromBytes(generateKeypairBytes()))
  const txs = buildTrialTxs('shared', ['A', 'B', 'C', 'D', 'E', 'F'], payers, '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', SWAPPED_ROLES)
  const b = txs.find((t) => t.role === 'B')!
  const d = txs.find((t) => t.role === 'D')!
  assert.equal(b.cuLimit, 1_000)
  assert.equal(b.priorityFee, 10_000n)
  assert.equal(b.maxFee, 15_000n)
  assert.equal(d.cuLimit, 40_000)
  assert.equal(d.priorityFee, 9_000n)
  assert.equal(new Set(txs.map((t) => t.anchor)).size, 1)
})

test('the panel in the plan follows from its rule and the committed data', () => {
  const snapshot: Snapshot = JSON.parse(readFileSync('data/mainnet-beta/snapshots/2026-11-03T22-01-35Z-epoch1076.json', 'utf8'))
  const activation: ActivationFile = JSON.parse(readFileSync('data/mainnet-beta/rakurai-activation.json', 'utf8'))
  const enabled = new Set(activation.accounts.filter((a) => a.isEnabled).map((a) => a.authority))
  const earlier = new Set(
    loadRuns('data/mainnet-beta/runs')
      .trials.filter((t) => ['main', 'confirm'].includes(t.campaign) && t.delivery === 'buffered' && t.mode === 'shared')
      .map((t) => t.targetLeader),
  )
  assert.deepEqual(selectPanel(snapshot, enabled, earlier), { holders: HOLDERS, matched: MATCHED })
})

test('the exact permutation test over validators', () => {
  const ones = (k: number) => [...Array(k).fill(1), ...Array(6 - k).fill(0)]
  const zeros = Array(6).fill(0)
  // with k of the six holders at 1 and every matched validator at 0: C(12-k, 6-k) of the 924 assignments
  assert.ok(Math.abs(permutationP(ones(6), zeros) - 1 / 924) < 1e-12)
  assert.ok(Math.abs(permutationP(ones(5), zeros) - 7 / 924) < 1e-12)
  assert.ok(Math.abs(permutationP(ones(4), zeros) - 28 / 924) < 1e-12)
  assert.ok(Math.abs(permutationP(ones(3), zeros) - 84 / 924) < 1e-12)
  assert.equal(permutationP([0, 0, 0], [1, 1, 1]), 1)
  // both groups alike: every assignment is at least as large
  assert.equal(permutationP([1, 1], [1, 1]), 1)
})

test('H1 takes only validators with at least 5 trials with both roles, and at least 3 in each group', () => {
  const totalFee = Array(6).fill('BDAEFC')
  const rewardCost = Array(6).fill('AEDCFB')
  const all = (id: string) => (HOLDERS.includes(id) ? totalFee : MATCHED.includes(id) ? rewardCost : [])
  const h = testH1(all)
  assert.equal(h.enough, true)
  assert.equal(h.holders.length, 6)
  assert.ok(Math.abs(h.p - 1 / 924) < 1e-12)
  // too few trials at most holders: not enough
  const few = testH1((id) => (HOLDERS.slice(0, 2).includes(id) ? totalFee : MATCHED.includes(id) ? rewardCost : totalFee.slice(0, 4)))
  assert.equal(few.holders.length, 2)
  assert.equal(few.enough, false)
  assert.equal(few.p, 1)
  assert.equal(targetedVerdict(few.enough, few.p), 'insufficient data')
})

test('pairs, tails, Holm and verdicts of the targeted run', () => {
  assert.deepEqual(before(['BDAEFC', 'DBAEFC', 'ABC'], 'B', 'D'), { k: 1, n: 2 })
  assert.equal(upperTail(0, 0), 1)
  assert.ok(Math.abs(upperTail(12, 12) - 1 / 4096) < 1e-12)
  assert.ok(Math.abs(upperTail(10, 12) - 79 / 4096) < 1e-12)
  assert.deepEqual(holmAdjust([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
  assert.equal(targetedVerdict(true, 0.049), 'confirmed')
  assert.equal(targetedVerdict(true, 0.05), 'not confirmed')
})

test('the twin sent first landed first: counted either way round, and only with both twins', () => {
  const group = (...xs: [string, number][]) => xs.map(([role, sendIndex]) => ({ role, sendIndex }))
  const ordered = new Map([
    ['r#0', group(['A', 0], ['E', 1], ['B', 2])], // A sent first, landed first
    ['r#1', group(['E', 0], ['A', 1])], // E sent first, landed first
    ['r#2', group(['A', 1], ['E', 0])], // E sent first, A landed first
    ['r#3', group(['A', 0], ['B', 1])], // no E
  ])
  const units = [0, 1, 2, 3, 4].map((trial) => ({ run: 'r', trial }))
  assert.deepEqual(twinFirst(units, ordered), { k: 2, n: 3 })
})
