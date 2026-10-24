// Independent check of the raw data against the chain: for every landed transaction, the block at the recorded
// slot must list the recorded signature at the recorded index, and its fee reward must name the recorded leader.
// Uses `transactionDetails: 'signatures'`, so it is cheap enough for the free public endpoint.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Landed } from './collect.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { toJson } from './util.ts'

export async function verify(rpc: Rpc, runsRoot: string, log: Log, limitBlocks = Infinity): Promise<{ checked: number; blocks: number; mismatches: unknown[] }> {
  const landed: (Landed & { run: string })[] = []
  for (const run of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
    const f = join(runsRoot, run, 'landed.json')
    if (existsSync(f)) for (const l of JSON.parse(readFileSync(f, 'utf8')) as Landed[]) if (l.slot !== null && l.index !== null) landed.push({ ...l, run })
  }
  const slots = [...new Set(landed.map((l) => l.slot!))].sort((a, b) => a - b).slice(0, limitBlocks)
  const mismatches: unknown[] = []
  let checked = 0
  for (const slot of slots) {
    const b = await rpc.call('getBlock', [slot, { transactionDetails: 'signatures', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'finalized' }])
    const leader = (b.rewards ?? []).find((r: any) => r.rewardType === 'Fee')?.pubkey ?? null
    for (const l of landed.filter((x) => x.slot === slot)) {
      checked++
      if (b.signatures[l.index!] !== l.signature) mismatches.push({ run: l.run, signature: l.signature, slot, index: l.index, found: b.signatures.indexOf(l.signature) })
      else if (leader !== l.leader) mismatches.push({ run: l.run, signature: l.signature, slot, leader: l.leader, chainLeader: leader })
    }
  }
  const report = { verifiedAt: new Date().toISOString(), rpc: rpc.label, blocks: slots.length, checked, mismatches }
  writeFileSync(join(runsRoot, '..', 'verify.json'), toJson(report, 1))
  log.info(`verify: ${checked} transactions in ${slots.length} blocks checked against ${rpc.label}: ${mismatches.length} mismatches`)
  return report
}
