// Live feasibility test of direct QUIC delivery: 6 single role-A transactions, each to one upcoming leader.
// Kept as the record of how data/mainnet-beta/quic-test/2026-10-24T23-25Z*.jsonl was produced (run once from the
// repository root on 2026-10-25, when a trial still had five roles and buildTrialTxs returned { txs }).
// It spent through the same ledger as everything else. The experiment itself now uses `run --path tpu`.
// Edited after the run only to rename its output file (from the local date to the UTC time). It does not run
// against the current code, and it must not: it would send live without --live.
throw new Error('historical record of the 2026-10-24 QUIC feasibility test; it does not run')
import { BlockhashCache, SlotClock } from '../src/clock.ts'
import { buildTrialTxs } from '../src/design.ts'
import { Ledger } from '../src/ledger.ts'
import { Rpc } from '../src/rpc.ts'
import { TpuSender } from '../src/tpu.ts'
import { appendJsonl, sleep } from '../src/util.ts'
import { loadSubPayers } from '../src/wallets.ts'
process.loadEnvFile('.env')
const rpc = new Rpc(process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`)
const cfg: any = { keypairPath: 'keys/payer.json' }
const { signers: subs } = loadSubPayers(cfg, false)
const ledger = new Ledger('data/mainnet-beta/ledger.jsonl', 50_000_000n)
const out = 'data/mainnet-beta/quic-test/2026-10-24T23-25Z.jsonl'
const nodes: any[] = await rpc.call('getClusterNodes')
const byId = new Map(nodes.map((n) => [n.pubkey, n]))
const clock = new SlotClock(rpc); await clock.start()
const hashes = new BlockhashCache(rpc); await hashes.start()
const tpu = new TpuSender(); await tpu.ready()
const rows: any[] = []
const lvbh = (await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.lastValidBlockHeight
let lastStart = 0
for (let k = 0; k < 6; k++) {
  const from = clock.slot
  const leaders: string[] = await rpc.call('getSlotLeaders', [from, 100])
  let start = 0, leader = ''
  for (let i = 12; i < leaders.length; i++) { const s = from + i; if (s % 4 === 0 && s > lastStart + 8 && byId.get(leaders[i])?.tpuQuic) { start = s; leader = leaders[i]; break } }
  lastStart = start
  const n = byId.get(leader); const fire = k % 2 === 0 ? start - 1 : start + 1
  await clock.waitFor(fire - 6)
  const hs = await tpu.connect(n.tpuQuic)
  const payer = subs[k % subs.length]
  const { txs } = buildTrialTxs('independent', ['A', 'B', 'C', 'D', 'E'], [payer, ...subs.slice(6, 10)], hashes.blockhash)
  const tx = txs[0]
  await clock.waitFor(fire)
  ledger.reserve([{ signature: tx.signature, lamports: tx.maxFee, what: 'quic feasibility' }])
  const slotAtSend = clock.slot
  const r = await tpu.send(n.tpuQuic, [tx.wire], 0)
  const row = { signature: tx.signature, leader, client: n.clientId, version: n.version, windowStart: start, fireSlot: fire, slotAtSend, handshakeMs: hs.handshakeMs ?? null, handshakeOk: hs.ok, sendOk: r.ok, sendError: r.error ?? null, sentNs: r.sentNs?.[0] ?? null }
  rows.push(row); appendJsonl(out, row)
  console.log(`${k}: ${n.clientId} window ${start} fire ${fire} at ${slotAtSend} handshake ${hs.ok ? hs.handshakeMs + ' ms' : hs.error} send ${r.ok ? 'ok' : r.error}`)
  await sleep(1500); await tpu.close(n.tpuQuic)
}
clock.stop(); hashes.stop(); tpu.stop()
await sleep(15000)
const { value } = await rpc.call('getSignatureStatuses', [rows.map((r) => r.signature), { searchTransactionHistory: true }])
for (let i = 0; i < rows.length; i++) {
  const st = value[i]; const r = rows[i]
  let leaderOfLanding = null
  if (st?.slot) { const b = await rpc.call('getBlock', [st.slot, { transactionDetails: 'signatures', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); leaderOfLanding = b.rewards.find((x: any) => x.rewardType === 'Fee')?.pubkey; r.index = b.signatures.indexOf(r.signature); r.blockTxs = b.signatures.length }
  console.log(`${r.client.padEnd(18)} window ${r.windowStart} fire ${r.fireSlot >= r.windowStart ? '+1' : '-1'}: ${st ? `landed slot ${st.slot} (window+${st.slot - r.windowStart}) ${leaderOfLanding === r.leader ? 'TARGET LEADER' : 'other leader'} index ${r.index}/${r.blockTxs}` : 'not landed (yet)'}`)
  appendJsonl(out.replace('.jsonl', '-landed.jsonl'), { signature: r.signature, slot: st?.slot ?? null, leader: leaderOfLanding, index: r.index ?? null })
  if (st?.slot) ledger.settle(r.signature, 9000n)
}
// unlanded ones stay reserved until their blockhash has expired
for (;;) { const h: number = await rpc.call('getBlockHeight', [{ commitment: 'finalized' }]); if (h > lvbh + 5) break; await sleep(5000) }
const again = (await rpc.call('getSignatureStatuses', [rows.map((r) => r.signature), { searchTransactionHistory: true }])).value
rows.forEach((r, i) => { if (!again[i]) { ledger.settle(r.signature, 0n); console.log('expired unlanded', r.signature.slice(0, 12)) } else if (!value[i]) { ledger.settle(r.signature, 9000n); console.log('landed late', r.signature.slice(0, 12), again[i].slot) } })
console.log('committed', ledger.committed())
