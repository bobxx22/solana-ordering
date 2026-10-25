import assert from 'node:assert/strict'
import { test } from 'node:test'
import { holm, type RuleStat } from '../src/analyze.ts'
import { encode } from '../src/base58.ts'
import { requested, scheduledCostOf } from '../src/block.ts'
import { expectedCost, ROLES } from '../src/design.ts'
import { parseArgs } from '../src/config.ts'
import { Rpc } from '../src/rpc.ts'
import { COMPUTE_BUDGET_PROGRAM, computeUnitLimit, computeUnitPrice, loadedAccountsDataSizeLimit, transfer } from '../src/tx.ts'

const H = { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }

test('RPC labels never contain credentials', () => {
  assert.equal(new Rpc('https://mainnet.helius-rpc.com/?api-key=SECRET').label, 'https://mainnet.helius-rpc.com/ (credentials hidden)')
  assert.equal(new Rpc('https://x.solana-mainnet.quiknode.pro/SECRET/').label, 'https://x.solana-mainnet.quiknode.pro/ (credentials hidden)')
  assert.equal(new Rpc('https://user:pass@rpc.example.com').label, 'https://rpc.example.com/ (credentials hidden)')
  assert.equal(new Rpc('https://api.mainnet-beta.solana.com').label, 'https://api.mainnet-beta.solana.com/')
})

test('boolean flags never swallow the command', () => {
  const a = parseArgs(['--live', 'run', '--per-client', '3'])
  assert.equal(a.command, 'run')
  assert.equal(a.flags.get('live'), true)
  assert.equal(a.flags.get('per-client'), '3')
  assert.equal(parseArgs(['run', '--live=true']).flags.get('live'), true)
  assert.equal(parseArgs(['run', '--live=false']).flags.has('live'), false)
})

test('requested limits: v1 header, ComputeBudget instructions, defaults', () => {
  const v1 = { transaction: { message: { header: H, transactionConfig: { computeUnitLimit: 540, loadedAccountsDataSizeLimit: 262_144 }, accountKeys: ['p', 'q'], instructions: [] } } }
  assert.equal(requested(v1).cuLimit, 540)
  assert.equal(requested(v1).loadedLimit, 262_144)
  const limitIx = encode(new Uint8Array([2, 0x40, 0x9c, 0, 0])) // 40 000
  const legacy = { transaction: { message: { header: H, accountKeys: ['payer', COMPUTE_BUDGET_PROGRAM, 'SomeProgram1111111111111111111111111111111'], instructions: [{ programIdIndex: 1, data: limitIx }, { programIdIndex: 2, data: '' }] } }, meta: {} }
  assert.deepEqual([requested(legacy).cuLimit, requested(legacy).explicit, requested(legacy).loadedLimit], [40_000, 1, 64 * 1024 * 1024])
  // no limit requested: builtins 3 000 each (the System program here), others 200 000
  const defaults = { transaction: { message: { header: H, accountKeys: ['payer', '11111111111111111111111111111111', 'SomeProgram1111111111111111111111111111111'], instructions: [{ programIdIndex: 1, data: '' }, { programIdIndex: 2, data: '' }] } }, meta: {} }
  assert.deepEqual([requested(defaults).cuLimit, requested(defaults).explicit], [203_000, 0])
})

test('scheduled cost rebuilt from a block equals the design cost for every role, F included', () => {
  for (const r of ROLES) {
    const ixs = [computeUnitLimit(r.cuLimit), computeUnitPrice(r.cuPrice), loadedAccountsDataSizeLimit(r.loadedLimit), transfer('payer', 'anchor', 0n)]
    const keys = ['payer', 'anchor', COMPUTE_BUDGET_PROGRAM, '11111111111111111111111111111111']
    const tx = {
      transaction: {
        message: {
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
          accountKeys: keys,
          instructions: ixs.map((ix) => ({ programIdIndex: keys.indexOf(ix.programId), data: encode(ix.data) })),
        },
      },
      meta: {},
    }
    assert.equal(scheduledCostOf(tx), expectedCost(r), `role ${r.role}`)
  }
})

test('Holm adjustment is monotone and capped at 1', () => {
  const s = [0.01, 0.04, 0.03, 0.5].map((p) => ({ p }) as RuleStat)
  holm(s)
  assert.deepEqual(
    s.map((x) => Number(x.pHolm!.toFixed(4))),
    [0.04, 0.09, 0.09, 0.5],
  )
})
