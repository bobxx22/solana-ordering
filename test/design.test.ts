import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildTrialTxs, CellDealer, expectedCost, expectedPriority, priorityFee, priorityPerCost, ROLES, type Role, type RoleSpec, trialCost } from '../src/design.ts'
import { generateKeypairBytes, signerFromBytes } from '../src/keys.ts'
import { CapExceeded, Ledger, SWEEP_ALLOWANCE } from '../src/ledger.ts'
import { rng } from '../src/util.ts'

const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM'
const rank = (key: (s: RoleSpec) => number) =>
  [...ROLES]
    .sort((a, b) => key(b) - key(a))
    .map((s) => s.role)
    .join('')
const role = Object.fromEntries(ROLES.map((r) => [r.role, r])) as Record<Role, RoleSpec>

test('the candidate rules order the roles differently', () => {
  assert.equal(rank(expectedPriority), 'AEDCFB')
  assert.equal(rank(priorityPerCost), 'AEDBFC')
  assert.equal(rank((s) => Number(s.cuPrice)), 'AEFDBC')
  assert.equal(rank((s) => Number(priorityFee(s))), 'BDAEFC')
})

test('F differs from A only in scheduling cost', () => {
  assert.equal(role.F.cuPrice, role.A.cuPrice)
  assert.equal(priorityFee(role.F), priorityFee(role.A))
  assert.equal(expectedCost(role.A), 2_335)
  assert.equal(expectedCost(role.F), 18_711)
  assert.ok(expectedPriority(role.A) > 7 * expectedPriority(role.F))
})

test('a trial costs at most 61 000 lamports', () => {
  assert.equal(trialCost(), 61_000n)
})

test('shared trials write one anchor, independent trials six; signatures are unique', () => {
  const payers = ROLES.map(() => signerFromBytes(generateKeypairBytes()))
  const order: Role[] = ['C', 'A', 'E', 'B', 'F', 'D']
  const shared = buildTrialTxs('shared', order, payers, BLOCKHASH)
  const indep = buildTrialTxs('independent', order, payers, BLOCKHASH)
  assert.equal(new Set(shared.map((t) => t.anchor)).size, 1)
  assert.equal(new Set(indep.map((t) => t.anchor)).size, 6)
  assert.equal(new Set([...shared, ...indep].map((t) => t.signature)).size, 12)
  assert.deepEqual(
    shared.map((t) => t.sendIndex),
    [1, 3, 0, 5, 2, 4],
  )
})

test('cells are dealt by deficit: exact target shares, kept across a continuation and after failed trials', () => {
  const want = { 'buffered/independent': 4, 'buffered/shared': 10, 'burst/shared': 2, 'streamed/independent': 2, 'streamed/shared': 2 }
  const dealer = new CellDealer(rng(1))
  for (let i = 0; i < 20; i++) {
    const c = dealer.peek('X')
    assert.deepEqual(dealer.peek('X'), c) // stable until counted
    dealer.add('X', c)
  }
  assert.deepEqual(Object.fromEntries(Object.entries(dealer.countsFor('X')).sort()), want)
  // a failed trial is removed again and its cell is the next one dealt
  dealer.add('X', { mode: 'independent', delivery: 'streamed' }, -1)
  assert.deepEqual(dealer.peek('X'), { mode: 'independent', delivery: 'streamed' })
  // a continuation seeded with 7 landed cells completes the same 20-trial design
  const seeded = new CellDealer(rng(2))
  const first = new CellDealer(rng(3))
  for (let i = 0; i < 7; i++) {
    const c = first.peek('Y')
    first.add('Y', c)
    seeded.add('Y', c)
  }
  for (let i = 7; i < 20; i++) seeded.add('Y', seeded.peek('Y'))
  assert.deepEqual(Object.fromEntries(Object.entries(seeded.countsFor('Y')).sort()), want)
})

test('ledger: lock required, cap enforced with the sweep allowance, settled to actual fees', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const cap = 500_000n
  const l = new Ledger(file, cap)
  assert.throws(() => l.reserve([{ signature: 'x', lamports: 1n, what: 't' }]), /locked/)
  l.lock()
  assert.throws(() => new Ledger(file, cap).lock(), /in use/)
  l.reserve([{ signature: 'a', lamports: 300_000n, what: 't' }])
  // ordinary spending must leave the sweep allowance
  assert.throws(() => l.reserve([{ signature: 'b', lamports: cap - SWEEP_ALLOWANCE - 300_000n + 1n, what: 't' }]), CapExceeded)
  l.reserve([{ signature: 's', lamports: SWEEP_ALLOWANCE, what: 'sweep' }], true)
  l.settle('a', 9_000n)
  l.unlock()
  assert.equal(new Ledger(file, cap).committed(), 9_000n + SWEEP_ALLOWANCE) // replayed from the file
})
