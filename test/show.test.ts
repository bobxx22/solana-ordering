import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encode } from '../src/base58.ts'
import type { Rpc } from '../src/rpc.ts'
import { showTrial } from '../src/show.ts'
import { COMPUTE_BUDGET_PROGRAM } from '../src/tx.ts'
import { computeBudgetOf } from '../src/verify.ts'

const u32 = (tag: number, x: number) => {
  const b = new Uint8Array(5)
  b[0] = tag
  new DataView(b.buffer).setUint32(1, x, true)
  return encode(b)
}
const u64 = (tag: number, x: number) => {
  const b = new Uint8Array(9)
  b[0] = tag
  new DataView(b.buffer).setBigUint64(1, BigInt(x), true)
  return encode(b)
}
const message = (cuLimit: number, cuPrice: number, loadedLimit: number) => ({
  accountKeys: ['payer', 'anchor', '11111111111111111111111111111111', COMPUTE_BUDGET_PROGRAM],
  instructions: [
    { programIdIndex: 3, data: u32(2, cuLimit) },
    { programIdIndex: 3, data: u64(3, cuPrice) },
    { programIdIndex: 3, data: u32(4, loadedLimit) },
    { programIdIndex: 2, data: '3Bxs4Bc3VYuGVB19' },
  ],
})

const ROLES = [
  ['A', 1000, 4_000_000, 16_384],
  ['B', 40_000, 250_000, 16_384],
  ['C', 1000, 0, 16_384],
  ['D', 6000, 1_500_000, 16_384],
  ['E', 1000, 4_000_000, 16_384],
  ['F', 1000, 4_000_000, 64 * 1024 * 1024],
] as const

/** A run on disk and a chain that answers for it, the second free to disagree. */
function fixture(campaign: string, chainOrder: string, opts: { leaderSchedule?: string | null; recordedIndexOfA?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'show-'))
  const dir = join(root, 'run1')
  mkdirSync(dir)
  const slot = 500
  const sig = (r: string) => `sig${r}`
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ campaign, live: true }))
  writeFileSync(join(dir, 'trials.jsonl'), JSON.stringify({ trial: 7, live: true, windowStart: slot, leader: 'LeaderIdentity', client: 'JitoLabs', version: '4.3.2', delivery: 'buffered', mode: 'shared' }) + '\n')
  writeFileSync(join(dir, 'txs.jsonl'), ROLES.map(([role, cuLimit, cuPrice, loadedLimit], i) => JSON.stringify({ trial: 7, live: true, role, signature: sig(role), sendIndex: 5 - i, cuLimit, cuPrice: String(cuPrice), loadedLimit })).join('\n') + '\n')
  writeFileSync(join(dir, 'landed.json'), JSON.stringify(ROLES.map(([role]) => ({ trial: 7, role, signature: sig(role), slot, index: role === 'A' && opts.recordedIndexOfA !== undefined ? opts.recordedIndexOfA : chainOrder.indexOf(role), fee: null }))))
  const signatures = chainOrder.split('').map(sig)
  const rpc = {
    label: 'fake',
    call: async (method: string, params: unknown[]) => {
      if (method === 'getBlock') return { signatures, rewards: [{ rewardType: 'Fee', pubkey: 'Collector' }] }
      if (method === 'getSlotLeaders') {
        if (opts.leaderSchedule === null) throw new Error('not served')
        return [opts.leaderSchedule ?? 'LeaderIdentity']
      }
      if (method === 'getTransaction') {
        const r = ROLES.find(([role]) => sig(role) === params[0])!
        return { slot, meta: { fee: 5000 + Math.ceil((r[1] * r[2]) / 1e6) }, transaction: { message: message(r[1], r[2], r[3]) } }
      }
      throw new Error(`unexpected ${method}`)
    },
  } as unknown as Rpc
  return { root, rpc }
}

test('the ComputeBudget instructions are read from the chain format', () => {
  assert.deepEqual(computeBudgetOf(message(1000, 4_000_000, 16_384)), { cuLimit: 1000, cuPrice: 4_000_000, loadedLimit: 16_384 })
})

test('a trial in the reward/cost order: the order, the send order and the comparison with the run', async () => {
  const { root, rpc } = fixture('main', 'EADCFB')
  const s = await showTrial([rpc], root, 'run1', 7)
  assert.equal(s.order, 'EADCFB')
  assert.deepEqual(s.problems, [])
  const text = s.lines.join('\n')
  assert.match(text, /Sent in this order, from our log: F E D C B A/)
  assert.match(text, /In the window, in landing order: E A D C F B/)
  assert.match(text, / matches +reward\/cost/)
  assert.match(text, /does not match +total fee/)
  assert.match(text, /from the leader schedule: LeaderIdentity/)
  assert.match(text, /The recorded run agrees with the chain/)
})

test('with the swapped parameters the predictions are those of the swap', async () => {
  const { root, rpc } = fixture('rakurai-swap', 'BDAEFC')
  const text = (await showTrial([rpc], root, 'run1', 7)).lines.join('\n')
  assert.match(text, / matches +total fee/)
  assert.match(text, /does not match +the larger limit first/)
})

test('an index the chain does not confirm, and a leader the schedule does not name, are problems', async () => {
  const moved = fixture('main', 'EADCFB', { recordedIndexOfA: 3 })
  assert.match((await showTrial([moved.rpc], moved.root, 'run1', 7)).problems[0], /^A: on chain slot 500, index 1/)
  const other = fixture('main', 'EADCFB', { leaderSchedule: 'SomeoneElse' })
  assert.match((await showTrial([other.rpc], other.root, 'run1', 7)).problems[0], /the schedule names SomeoneElse/)
})

test('an epoch no endpoint still schedules falls back to the fee recipient, and says so', async () => {
  const { root, rpc } = fixture('main', 'EADCFB', { leaderSchedule: null })
  const s = await showTrial([rpc], root, 'run1', 7)
  assert.deepEqual(s.problems, [])
  assert.match(s.lines.join('\n'), /Fee recipient of slot 500 .*: Collector/)
})

test('an unknown run or trial is an error that says where the trials are listed', async () => {
  const { root, rpc } = fixture('main', 'EADCFB')
  await assert.rejects(showTrial([rpc], root, 'nope', 7), /no run nope/)
  await assert.rejects(showTrial([rpc], root, 'run1', 8), /orders\.md lists the trials/)
})
