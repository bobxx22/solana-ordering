import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Tx, Unit } from '../src/analyze.ts'
import type { Snapshot } from '../src/discover.ts'
import { encode } from '../src/base58.ts'
import { parseActivationAccount, parseValidatorInfo } from '../src/names.ts'
import { fisherExact } from '../src/stats.ts'
import { cellSafe, changesBetween, classifyOrder, headOfBlock, tieStat, timeline, validatorReading } from '../src/validators.ts'

test('the named orders of the six do not overlap', () => {
  assert.equal(classifyOrder('AEDCFB'), 'rewardCost')
  assert.equal(classifyOrder('EADCFB'), 'rewardCost')
  assert.equal(classifyOrder('BDFEAC'), 'totalFee')
  assert.equal(classifyOrder('EADBCF'), 'fLast')
  assert.equal(classifyOrder('AEDCBF'), 'fLast')
  assert.equal(classifyOrder('AEDBFC'), 'other')
  assert.equal(classifyOrder('DEACFB'), 'other')
})

test('a validator gets a reading only from 5 trials, and only with one order in at least 80% of them', () => {
  assert.equal(validatorReading([]).reading, 'no trial with all six')
  assert.equal(validatorReading(['AEDCFB', 'AEDCFB', 'AEDCFB', 'AEDCFB']).reading, 'too few trials')
  assert.equal(validatorReading(Array(5).fill('EADCFB')).reading, 'reward/cost')
  // 15 of 16: C8Bey3LK
  assert.equal(validatorReading([...Array(15).fill('BDFAEC'), 'DEACFB']).reading, 'total fee')
  const mixed = validatorReading([...Array(3).fill('AEDCFB'), 'AEDBFC', 'EADCBF'])
  assert.equal(mixed.reading, 'mixed')
  assert.deepEqual(mixed.counts, { rewardCost: 3, totalFee: 0, fLast: 1, other: 1 })
  assert.equal(validatorReading([...Array(4).fill('AEDCFB'), 'AEDBFC']).reading, 'reward/cost')
})

test('ties among A, E and F: where F landed, by chance 1/3, and the pairs in send order', () => {
  const tx = (role: string, sendIndex: number) => ({ role, sendIndex }) as Tx
  const unit = (trial: number, observedOrder: string) => ({ run: 'r', trial, observedOrder }) as Unit
  const ordered = new Map([
    ['r#1', [tx('B', 0), tx('D', 1), tx('F', 2), tx('A', 3), tx('E', 4), tx('C', 5)]],
    ['r#2', [tx('B', 0), tx('D', 1), tx('A', 4), tx('F', 3), tx('E', 2), tx('C', 5)]],
    ['r#3', [tx('A', 0), tx('E', 1), tx('D', 2), tx('C', 3), tx('F', 4), tx('B', 5)]],
  ])
  const s = tieStat([unit(1, 'BDFAEC'), unit(2, 'BDAFEC'), unit(3, 'AEDCFB')], ordered)
  assert.equal(s.trials, 2)
  assert.deepEqual(s.fPosition, [1, 1, 0])
  assert.ok(Math.abs(s.p - (1 - (2 / 3) ** 2)) < 1e-12)
  assert.equal(s.pairs, 6)
  assert.equal(s.pairsInSendOrder, 3)
})

test('the head of a block: our transactions out, payers apart, negative rho for a larger value earlier', () => {
  // [fee, costUnits, consumed, priorityFee, failed, signatures, limit, explicit, loadedLimit, scheduledCost]
  const row = (priorityFee: number, scheduledCost: number) => [5000 + priorityFee, 0, 0, priorityFee, 0, 1, 0, 1, 0, scheduledCost] as never
  const rows = [row(0, 1000), row(9000, 1000), row(5000, 1000), row(3000, 1000), row(1000, 1000), row(0, 1000), ...Array(34).fill(row(0, 1000))]
  const h = headOfBlock({ rows }, new Set([0]))
  assert.equal(h.size, 4)
  assert.equal(h.payers, 4)
  assert.equal(h.feePayers, -1)
  assert.equal(h.rewardCostPayers, -1)
  // too few payers for a correlation
  assert.equal(headOfBlock({ rows: [row(0, 1000), row(0, 1000), row(5, 1000)] }, new Set()).feePayers, null)
})

const snap = (takenAt: string, ...vs: [string, string, string | null, string | null][]) =>
  ({ takenAt, validators: vs.map(([identity, client, version, tpuQuic]) => ({ identity, client, version, tpuQuic })) }) as Snapshot

test('changes between snapshots: only the identities asked about, an unknown address is not a change', () => {
  const a = snap('2026-10-24T00:00:00Z', ['x', 'Firedancer', '26.10.4', null], ['y', 'Agave', '4.3.2', '1.1.1.1:1'], ['z', 'Agave', '4.3.2', '2.2.2.2:2'], ['n', 'Agave', '4.3.2', '3.3.3.3:3'])
  const b = snap('2026-10-27T00:00:00Z', ['x', 'JitoLabs', '4.3.2', '9.9.9.9:11228'], ['y', 'Agave', '4.4.0', '1.1.1.1:1'], ['z', 'Agave', '4.3.2', '2.2.2.2:3'], ['n', 'JitoLabs', '4.3.2', '8.8.8.8:8'])
  assert.deepEqual(changesBetween(a, b, new Set(['x', 'y', 'z'])), { compared: 3, client: 1, version: 1, address: 1 })
})

test('a timeline merges equal states; an unknown address takes the next one with the same label', () => {
  const line = timeline(
    [
      snap('2026-10-24T16:59:00Z', ['x', 'Firedancer', '26.10.4', null]),
      snap('2026-10-25T22:05:00Z', ['x', 'Firedancer', '26.10.4', '1.1.1.1:9007']),
      snap('2026-10-26T00:00:00Z', ['other', 'Agave', '4.3.2', null]),
      snap('2026-10-27T14:39:00Z', ['x', 'JitoLabs', '4.3.2', '2.2.2.2:11228']),
    ],
    'x',
  )
  assert.deepEqual(line, [
    { label: 'Firedancer 26.10.4', address: '1.1.1.1:9007', from: '2026-10-24T16:59:00Z', to: '2026-10-25T22:05:00Z' },
    { label: 'JitoLabs 4.3.2', address: '2.2.2.2:11228', from: '2026-10-27T14:39:00Z', to: '2026-10-27T14:39:00Z' },
  ])
})

test('names: only validator info with a signer and a name; safe inside a table cell', () => {
  const account = (info: unknown, type = 'validatorInfo') => ({ pubkey: 'info', account: { data: { parsed: { type, info } } } })
  const keys = [{ pubkey: 'Va1idator1nfo111111111111111111111111111111', signer: false }, { pubkey: 'identity', signer: true }]
  assert.deepEqual(parseValidatorInfo(account({ keys, configData: { name: ' Everstake ' } })), { identity: 'identity', name: 'Everstake', infoAccount: 'info' })
  assert.equal(parseValidatorInfo(account({ keys, configData: { name: ' ' } })), null)
  assert.equal(parseValidatorInfo(account({ keys: [keys[0]], configData: { name: 'x' } })), null)
  assert.equal(parseValidatorInfo(account({ keys, configData: { name: 'x' } }, 'stakeConfig')), null)
  assert.equal(cellSafe('a | b\n`c` [d](e)'), 'a b c d (e)')
})

test('an activation account: the flag and the authority, past an optional proposer; other accounts are skipped', () => {
  const disc = [23, 29, 221, 229, 148, 135, 217, 153]
  const authority = Array.from({ length: 32 }, (_, i) => i + 1)
  const proposer = Array(32).fill(9)
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')
  const name = encode(Uint8Array.from(authority))
  assert.deepEqual(parseActivationAccount('x', b64([...disc, 1, 0, ...authority])), { account: 'x', authority: name, isEnabled: true })
  assert.deepEqual(parseActivationAccount('x', b64([...disc, 0, 1, ...proposer, ...authority])), { account: 'x', authority: name, isEnabled: false })
  assert.equal(parseActivationAccount('x', b64([1, 2, 3, 4, 5, 6, 7, 8, 1, 0, ...authority])), null)
  assert.equal(parseActivationAccount('x', b64([...disc, 1])), null)
})

test('Fisher exact test, two-sided', () => {
  // 2 of 3 against 0 of 13: only the observed table is that unlikely
  assert.ok(Math.abs(fisherExact(2, 1, 0, 13) - 3 / 120) < 1e-12)
  // 4 of 10 against 14 of 20 exact: the value REPORT quotes
  assert.ok(Math.abs(fisherExact(4, 6, 14, 6) - 0.14) < 0.005)
  assert.equal(fisherExact(1, 1, 1, 1), 1)
})
