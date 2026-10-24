import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildTrialTxs, CellDealer, expectedPriority, priorityFee, ROLES, type Role, type RoleSpec, trialCost } from '../src/design.ts'
import { generateKeypairBytes, signerFromBytes } from '../src/keys.ts'
import { CapExceeded, Ledger } from '../src/ledger.ts'
import { rng } from '../src/util.ts'

const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM'
const rank = (key: (s: RoleSpec) => number) =>
  [...ROLES]
    .sort((a, b) => key(b) - key(a))
    .map((s) => s.role)
    .join('')

test('the three candidate rules order the roles differently', () => {
  const byPriority = rank(expectedPriority)
  const byTotalFee = rank((s) => Number(priorityFee(s)))
  const byPrice = rank((s) => Number(s.cuPrice))
  assert.equal(byPriority, 'AEDCB')
  assert.equal(byTotalFee, 'BDAEC')
  assert.equal(byPrice, 'AEDBC')
  // C vs B is the pair that separates reward/cost from price per CU
  const p = Object.fromEntries(ROLES.map((r) => [r.role, r])) as Record<Role, RoleSpec>
  assert.ok(expectedPriority(p.C) > expectedPriority(p.B) && p.B.cuPrice > p.C.cuPrice)
})

test('a trial costs at most 52 000 lamports', () => {
  assert.equal(trialCost(), 52_000n)
})

test('shared trials write one anchor, independent trials five; signatures are unique', () => {
  const payers = ROLES.map(() => signerFromBytes(generateKeypairBytes()))
  const order: Role[] = ['C', 'A', 'E', 'B', 'D']
  const shared = buildTrialTxs('shared', order, payers, BLOCKHASH).txs
  const indep = buildTrialTxs('independent', order, payers, BLOCKHASH).txs
  assert.equal(new Set(shared.map((t) => t.anchor)).size, 1)
  assert.equal(new Set(indep.map((t) => t.anchor)).size, 5)
  assert.equal(new Set([...shared, ...indep].map((t) => t.signature)).size, 10)
  assert.deepEqual(
    shared.map((t) => t.sendIndex),
    [1, 3, 0, 4, 2],
  )
})

test('cells are dealt in balanced blocks per client', () => {
  const dealer = new CellDealer(rng(1), ['early', 'inwindow'])
  const seen = new Map<string, number>()
  for (let i = 0; i < 8; i++) {
    const c = dealer.take('X')
    const k = `${c.mode}/${c.timing}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  assert.deepEqual([...seen.values()], [2, 2, 2, 2])
})

test('ledger refuses to pass the cap and settles to actual fees', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const l = new Ledger(file, 100_000n)
  l.reserve([{ signature: 'a', lamports: 60_000n, what: 't' }])
  assert.throws(() => l.reserve([{ signature: 'b', lamports: 50_000n, what: 't' }]), CapExceeded)
  l.settle('a', 9_000n)
  l.reserve([{ signature: 'b', lamports: 50_000n, what: 't' }])
  assert.equal(new Ledger(file, 100_000n).committed(), 59_000n) // replayed from the file
})
