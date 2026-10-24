// Delivery-path probe: single transactions sent through several RPC endpoints, round-robin, each at a fresh slot
// boundary. The delay between the slot of dispatch and the slot of landing characterizes the path from our
// backend to the leader, which the ordering experiment cannot observe directly.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BlockhashCache, SlotClock } from './clock.ts'
import type { Config } from './config.ts'
import { fmtSol } from './config.ts'
import { buildTrialTxs, ROLES } from './design.ts'
import { loadKeypair } from './keys.ts'
import { Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import { stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { median } from './stats.ts'
import { appendJsonl, chunk, readJsonl, rng, shuffle, sleep } from './util.ts'
import { loadSubPayers } from './wallets.ts'

export async function probePaths(cfg: Config, rpc: Rpc, endpoints: string[], rounds: number, log: Log): Promise<void> {
  const file = join(cfg.dataDir, cfg.cluster, 'paths', `${stamp()}.jsonl`)
  mkdirSync(join(cfg.dataDir, cfg.cluster, 'paths'), { recursive: true })
  loadKeypair(cfg.keypairPath)
  const { signers: subs, ephemeral } = loadSubPayers(cfg, false)
  if (cfg.live && ephemeral) throw new Error('fund the sub-payers first (fund --live)')
  const ledger = new Ledger(join(cfg.dataDir, cfg.cluster, 'ledger.jsonl'), cfg.spendCapLamports)
  const spec = ROLES[0] // role A: 4 000 lamports priority fee
  const cost = BigInt(rounds * endpoints.length) * (5_000n + 4_000n)
  log.info(`${cfg.live ? 'LIVE' : 'dry run'}: ${rounds} rounds × ${endpoints.length} endpoints, at most ${fmtSol(cost)}`)
  const senders = endpoints.map((u) => new Rpc(u, { minGapMs: 0, retries: 0, timeoutMs: 10_000 }))
  const clock = new SlotClock(rpc)
  await clock.start()
  const hashes = new BlockhashCache(rpc)
  await hashes.start()
  const random = rng(Date.now() % 2 ** 31)
  let n = 0
  try {
    for (let r = 0; r < rounds; r++) {
      for (const k of shuffle(
        senders.map((_, i) => i),
        random,
      )) {
        const payer = subs[n++ % subs.length]
        // the trial builder makes the same transaction as role A of the experiment; only its first tx is used
        const { txs } = buildTrialTxs('independent', ['A', 'B', 'C', 'D', 'E'], [payer, ...subs.slice(0, 4)], hashes.blockhash)
        const tx = txs.find((t) => t.role === spec.role)!
        await clock.waitFor(clock.slot + 1)
        const slotAtSend = clock.slot
        const sentAt = new Date()
        let ok = true
        let error: string | null = null
        if (cfg.live) {
          ledger.reserve([{ signature: tx.signature, lamports: tx.maxFee, what: 'path probe' }])
          try {
            await senders[k].call('sendTransaction', [tx.wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
          } catch (e) {
            ok = false
            error = (e as Error).message
          }
        }
        appendJsonl(file, { endpoint: senders[k].label, signature: tx.signature, payer: payer.address, slotAtSend, sentAt: sentAt.toISOString(), ackMs: Date.now() - sentAt.getTime(), ok, error, live: cfg.live })
        log.info(`round ${r} ${senders[k].label}: slot ${slotAtSend}${ok ? '' : ` error ${error}`}`)
        await sleep(1500)
      }
    }
  } finally {
    clock.stop()
    hashes.stop()
  }
  if (!cfg.live) return
  await sleep(20_000)
  const rows = readJsonl(file)
  const status = new Map<string, any>()
  for (const part of chunk(rows, 256)) {
    const { value } = await rpc.call('getSignatureStatuses', [part.map((x) => x.signature), { searchTransactionHistory: true }])
    part.forEach((x, i) => status.set(x.signature, value[i]))
  }
  for (const row of rows) {
    const st = status.get(row.signature)
    appendJsonl(file.replace(/\.jsonl$/, '-landed.jsonl'), { signature: row.signature, slot: st?.slot ?? null, err: st?.err ?? null })
    ledger.settle(row.signature, st?.slot ? 9_000n : 0n)
  }
  for (const s of senders) {
    const mine = rows.filter((x) => x.endpoint === s.label)
    const delays = mine.map((x) => status.get(x.signature)?.slot - x.slotAtSend).filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
    console.log(`${s.label}: landed ${delays.length}/${mine.length}, delay in slots median ${median(delays)}, min ${delays[0]}, max ${delays.at(-1)}`)
  }
}
