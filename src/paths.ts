// Delivery-path probe: single transactions through several paths, round-robin, each dispatched at a fresh slot
// boundary. The delay between the slot of dispatch and the slot of landing characterizes the path from our backend
// to the leader. Paths: an RPC URL (sendTransaction), 'read' (the read RPC, whose key stays out of the command line),
// or 'tpu' (QUIC straight to the leader of the next window, dispatched one slot before that window).
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BlockhashCache, SlotClock } from './clock.ts'
import { checkCluster, type Config, fmtSol } from './config.ts'
import { buildTrialTxs, ROLES } from './design.ts'
import { takeSnapshot } from './discover.ts'
import { generateKeypairBytes, signerFromBytes } from './keys.ts'
import { Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import { stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { settleOpen } from './settle.ts'
import { median } from './stats.ts'
import { TpuSender } from './tpu.ts'
import { appendJsonl, readJsonl, rng, shuffle, sleep } from './util.ts'
import { loadSubPayers } from './wallets.ts'

export async function probePaths(cfg: Config, rpc: Rpc, endpoints: string[], rounds: number, log: Log): Promise<void> {
  const dir = join(cfg.dataDir, cfg.cluster, cfg.live ? 'paths' : 'dry-runs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${stamp()}-paths.jsonl`)
  // a dry run never touches a funded key
  const { signers: loaded, ephemeral } = loadSubPayers(cfg, false)
  if (cfg.live && (ephemeral || !existsSync(cfg.keypairPath))) throw new Error('fund the sub-payers first (fund --live)')
  const subs = cfg.live ? loaded : loaded.map(() => signerFromBytes(generateKeypairBytes()))
  const ledger = new Ledger(join(cfg.dataDir, cfg.cluster, 'ledger.jsonl'), cfg.spendCapLamports)
  const senders = endpoints.map((u) => (u === 'tpu' ? null : new Rpc(u, { minGapMs: 0, retries: 0, timeoutMs: 10_000 })))
  if (cfg.live) {
    for (const s of senders) if (s) await checkCluster(cfg, rpc, s)
    ledger.lock()
  }
  const spec = ROLES[0] // role A: 4 000 lamports priority fee
  log.info(`${cfg.live ? 'LIVE' : 'dry run'}: ${rounds} rounds × ${endpoints.length} paths, at most ${fmtSol(BigInt(rounds * endpoints.length) * (5_000n + 4_000n))}`)
  const tpu = endpoints.includes('tpu') ? new TpuSender() : null
  const byIdentity = tpu ? new Map((await takeSnapshot(rpc, cfg.cluster, log)).snapshot.validators.map((v) => [v.identity, v])) : new Map()
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
        const others = subs.filter((s) => s !== payer).slice(0, ROLES.length - 1)
        const tx = buildTrialTxs('independent', ROLES.map((x) => x.role), [payer, ...others], hashes.blockhash).find((t) => t.role === spec.role)!
        const lastValidBlockHeight = hashes.lastValidBlockHeight
        let label: string
        let fireSlot: number
        let leader: string | null = null
        if (senders[k]) {
          label = senders[k]!.label
          fireSlot = clock.slot + 1
        } else {
          // the next window start at least 6 slots ahead whose leader has a QUIC address
          const from = clock.slot
          const leaders: string[] = await rpc.call('getSlotLeaders', [from, 64])
          const i = leaders.findIndex((l, j) => j >= 6 && (from + j) % 4 === 0 && byIdentity.get(l)?.tpuQuic)
          leader = leaders[i]
          fireSlot = from + i - 1
          label = `tpu ${byIdentity.get(leader)?.client}`
          await clock.waitFor(fireSlot - 5)
          const c = await tpu!.connect(byIdentity.get(leader)!.tpuQuic)
          if (!c.ok) {
            log.info(`round ${r} ${label}: QUIC connect failed (${c.error}); skipped`)
            continue
          }
        }
        await clock.waitFor(fireSlot)
        const slotAtSend = clock.slot
        const sentAt = new Date()
        let ok = true
        let error: string | null = null
        if (cfg.live) {
          appendJsonl(file, { kind: 'planned', signature: tx.signature, lastValidBlockHeight })
          ledger.reserve([{ signature: tx.signature, lamports: tx.maxFee, what: 'path probe' }])
          if (senders[k]) {
            try {
              await senders[k]!.call('sendTransaction', [tx.wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
            } catch (e) {
              ok = false
              error = (e as Error).message
            }
          } else {
            const s = await tpu!.send(byIdentity.get(leader!)!.tpuQuic, [tx.wire], 0)
            ok = s.ok
            error = s.error ?? null
          }
        }
        appendJsonl(file, { kind: 'sent', endpoint: label, leader, signature: tx.signature, payer: payer.address, slotAtSend, sentAt: sentAt.toISOString(), ackMs: Date.now() - sentAt.getTime(), ok, error, lastValidBlockHeight, live: cfg.live })
        log.info(`round ${r} ${label}: slot ${slotAtSend}${ok ? '' : ` error ${error}`}`)
        if (leader) tpu!.closeLater(byIdentity.get(leader)!.tpuQuic)
        await sleep(1500)
      }
    }
  } finally {
    clock.stop()
    hashes.stop()
    tpu?.stop()
  }
  if (!cfg.live) return
  const rows = readJsonl(file).filter((x) => x.kind === 'sent')
  // keep settling until every reservation is decided: landed, or expired by block height
  for (let round = 0; round < 12; round++) {
    await sleep(15_000)
    const r = await settleOpen(rpc, ledger, rows)
    if (r.open === 0) break
  }
  const { value } = await rpc.call('getSignatureStatuses', [rows.map((x) => x.signature), { searchTransactionHistory: true }])
  rows.forEach((x, i) => appendJsonl(file, { kind: 'landed', signature: x.signature, slot: value[i]?.slot ?? null, err: value[i]?.err ?? null }))
  for (const label of new Set(rows.map((x) => x.endpoint as string))) {
    const delays = rows
      .map((x, i) => [x, value[i]] as const)
      .filter(([x, st]) => x.endpoint === label && st?.slot)
      .map(([x, st]) => st.slot - x.slotAtSend)
      .sort((a, b) => a - b)
    const total = rows.filter((x) => x.endpoint === label).length
    console.log(`${label}: landed ${delays.length}/${total}, delay in slots median ${median(delays)}, min ${delays[0]}, max ${delays.at(-1)}`)
  }
  ledger.unlock()
}
