// The experiment loop. For each upcoming leader window of a validator whose client still needs trials, it signs a
// five-transaction burst, waits for the dispatch slot and sends the burst in a random order with a fixed gap.
// Without --live every step runs except sending: the burst is simulated against the cluster instead (signatures
// verified), so the dry run proves the transactions are valid without spending anything.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlockhashCache, SlotClock } from './clock.ts'
import { collect } from './collect.ts'
import type { Config } from './config.ts'
import { fmtSol } from './config.ts'
import { CellDealer, ROLES, type Role, type Timing, buildTrialTxs, expectedPriority, trialCost } from './design.ts'
import { takeSnapshot } from './discover.ts'
import { generateKeypairBytes, loadKeypair, type Signer, signerFromBytes } from './keys.ts'
import { CapExceeded, Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import { stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { appendJsonl, rng, shuffle, sleep, toJson } from './util.ts'
import { balances, fundSubPayers, loadSubPayers } from './wallets.ts'

export interface RunOptions {
  clients: string[]
  perClient: number
  perValidator: number
  timings: Timing[]
  gapMs: number
  spacingMs: number
  seed: number
  /** in a dry run, how many trials to simulate */
  dryTrials: number
  maxMinutes: number
}

export const DEFAULT_CLIENTS = ['AgaveBam', 'JitoLabs', 'HarmonicAgave', 'HarmonicFiredancer', 'Firedancer', 'FireBAM', 'Rakurai', 'Agave']
const SLOT_MS = 200
const EARLY_SLOTS = 2
const INWINDOW_SLOTS = 1

/** Time allowed for the clock to reach a slot `ahead` slots away: twice the nominal time plus half a minute. */
const slotWaitMs = (ahead: number) => Math.max(0, ahead) * SLOT_MS * 2 + 30_000

export const runsDir = (cfg: Config) => join(cfg.dataDir, cfg.cluster, 'runs')
export const ledgerFile = (cfg: Config) => join(cfg.dataDir, cfg.cluster, 'ledger.jsonl')

export async function run(cfg: Config, rpc: Rpc, opts: RunOptions, log: Log): Promise<string> {
  const live = cfg.live
  const runId = stamp()
  const dir = join(runsDir(cfg), runId)
  mkdirSync(dir, { recursive: true })
  const events = (type: string, fields: Record<string, unknown>) => appendJsonl(join(dir, 'events.jsonl'), { t: new Date().toISOString(), type, ...fields })
  const sendRpc = new Rpc(cfg.sendRpcUrl, { minGapMs: 0, retries: 0, timeoutMs: 10_000 })

  let main: Signer
  if (existsSync(cfg.keypairPath)) main = loadKeypair(cfg.keypairPath)
  else if (live) throw new Error(`live run needs a funded wallet at ${cfg.keypairPath}`)
  else main = signerFromBytes(generateKeypairBytes())
  const { signers: subs, ephemeral } = loadSubPayers(cfg, live)
  if (ephemeral) log.info('dry run with throwaway sub-payer keys: simulations will report AccountNotFound for them, which still proves the signatures')
  const ledger = new Ledger(ledgerFile(cfg), cfg.spendCapLamports)

  const { snapshot } = await takeSnapshot(rpc, cfg.cluster, log)
  writeFileSync(join(dir, 'snapshot.json'), toJson(snapshot, 1))
  const byIdentity = new Map(snapshot.validators.map((v) => [v.identity, v]))

  const perTrial = trialCost()
  const planned = opts.clients.length * opts.perClient
  log.info(`${live ? 'LIVE' : 'dry run'} on ${cfg.cluster}: up to ${planned} trials, at most ${fmtSol(perTrial)} each (${fmtSol(perTrial * BigInt(planned))} in total)`)
  log.info(`spend cap ${fmtSol(ledger.cap)}, already committed ${fmtSol(ledger.committed())}; reads via ${rpc.label}, sends via ${sendRpc.label}`)
  for (const r of ROLES) log.info(`  role ${r.role}: limit ${r.cuLimit} CU, price ${r.cuPrice} µL/CU, reward/cost ${expectedPriority(r).toFixed(3)}`)

  writeFileSync(
    join(dir, 'run.json'),
    toJson(
      {
        runId,
        live,
        cluster: cfg.cluster,
        startedAt: new Date().toISOString(),
        options: opts,
        roles: ROLES,
        readRpc: rpc.label,
        sendRpc: sendRpc.label,
        mainWallet: main.address,
        subPayers: subs.map((s) => s.address),
        spendCap: ledger.cap,
        committedBefore: ledger.committed(),
        node: process.version,
      },
      1,
    ),
  )

  if (live) {
    const [mainBal] = await balances(rpc, [main.address])
    log.info(`main wallet ${main.address}: ${fmtSol(mainBal)}`)
    await fundSubPayers(cfg, rpc, rpc, ledger, log, main, subs, true)
  }

  const random = rng(opts.seed)
  const dealer = new CellDealer(random, opts.timings)
  const perClient = new Map<string, number>()
  const perValidator = new Map<string, number>()
  const clock = new SlotClock(rpc)
  await clock.start()
  const hashes = new BlockhashCache(rpc)
  await hashes.start()
  let leaders: string[] = []
  let leadersFrom = 0
  const refreshLeaders = async () => {
    leadersFrom = clock.slot
    leaders = await rpc.call('getSlotLeaders', [leadersFrom, 2000])
  }
  await refreshLeaders()

  let stopping = false
  const onSigint = () => {
    log.info('stopping after the current trial (Ctrl+C again to abort)')
    if (stopping) process.exit(130)
    stopping = true
  }
  process.on('SIGINT', onSigint)

  const deadline = Date.now() + opts.maxMinutes * 60_000
  let trial = 0
  let lastFire = 0
  try {
    while (!stopping && Date.now() < deadline) {
      if (live ? opts.clients.every((c) => (perClient.get(c) ?? 0) >= opts.perClient) : trial >= opts.dryTrials) break
      if (clock.slot - leadersFrom > 1500) await refreshLeaders()

      // the next window that needs a trial and leaves time to prepare
      const minFire = Math.max(clock.slot + 3, lastFire + Math.ceil(opts.spacingMs / SLOT_MS))
      let target: { start: number; leader: string; client: string; fire: number } | undefined
      for (let i = Math.max(1, minFire - leadersFrom - INWINDOW_SLOTS); i < leaders.length; i++) {
        const leader = leaders[i]
        if (leader === leaders[i - 1]) continue
        const client = byIdentity.get(leader)?.client ?? 'unknown'
        if (!opts.clients.includes(client) || (perClient.get(client) ?? 0) >= opts.perClient) continue
        if ((perValidator.get(leader) ?? 0) >= opts.perValidator) continue
        const start = leadersFrom + i
        const fire = dealer.peek(client).timing === 'early' ? start - EARLY_SLOTS : start + INWINDOW_SLOTS
        if (fire < minFire) continue
        target = { start, leader, client, fire }
        break
      }
      if (!target) {
        log.info('no suitable window in the known leader schedule; refreshing')
        await sleep(5000)
        await refreshLeaders()
        continue
      }
      const cell = dealer.take(target.client)
      const set = trial % 2
      const payers = shuffle(subs.slice(set * ROLES.length, (set + 1) * ROLES.length), random)
      const order = shuffle(
        ROLES.map((r) => r.role),
        random,
      ) as Role[]

      // sign a few slots ahead with the cached blockhash (at most ~2 s old; it stays valid for about a minute)
      await clock.waitFor(target.fire - 3, slotWaitMs(target.fire - clock.slot))
      const blockhash = hashes.blockhash
      const { txs } = buildTrialTxs(cell.mode, order, payers, blockhash)
      if (live) {
        try {
          ledger.reserve(txs.map((t) => ({ signature: t.signature, lamports: t.maxFee, what: `trial ${trial} ${t.role}` })))
        } catch (e) {
          if (e instanceof CapExceeded) {
            log.info(e.message)
            break
          }
          throw e
        }
      }
      if (clock.slot > target.fire) {
        log.info(`trial ${trial}: missed dispatch slot ${target.fire} (now ${clock.slot}), skipping`)
        if (live) for (const t of txs) ledger.settle(t.signature, 0n)
        continue
      }

      await clock.waitFor(target.fire, slotWaitMs(target.fire - clock.slot))
      const fireSeenAt = clock.seenAt
      const t0 = Date.now()
      const sent = await Promise.all(
        order.map(async (role, k) => {
          await sleep(t0 + k * opts.gapMs - Date.now())
          const tx = txs.find((t) => t.role === role)!
          const sentAt = new Date()
          const slotAtSend = clock.slot
          if (!live) return { role, sentAt, slotAtSend, ackMs: null, ok: true, error: null }
          try {
            const r = await sendRpc.call('sendTransaction', [tx.wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
            return { role, sentAt, slotAtSend, ackMs: Date.now() - sentAt.getTime(), ok: r === tx.signature, error: r === tx.signature ? null : `unexpected ${r}` }
          } catch (e) {
            return { role, sentAt, slotAtSend, ackMs: Date.now() - sentAt.getTime(), ok: false, error: (e as Error).message }
          }
        }),
      )
      lastFire = target.fire
      perClient.set(target.client, (perClient.get(target.client) ?? 0) + 1)
      perValidator.set(target.leader, (perValidator.get(target.leader) ?? 0) + 1)
      const v = byIdentity.get(target.leader)
      appendJsonl(join(dir, 'trials.jsonl'), {
        trial,
        windowStart: target.start,
        fireSlot: target.fire,
        fireSeenAt: new Date(fireSeenAt).toISOString(),
        clockSource: clock.source,
        leader: target.leader,
        client: target.client,
        version: v?.version ?? null,
        mode: cell.mode,
        timing: cell.timing,
        sendOrder: order,
        payerSet: set,
        gapMs: opts.gapMs,
        blockhash,
        live,
      })
      for (const t of txs) {
        const s = sent.find((x) => x.role === t.role)!
        const { wire, ...rest } = t
        appendJsonl(join(dir, 'txs.jsonl'), { trial, ...rest, sentAt: s.sentAt.toISOString(), slotAtSend: s.slotAtSend, ackMs: s.ackMs, sendOk: s.ok, sendError: s.error, live })
        // a send the RPC rejected is released now; if it landed anyway, collect settles it to the real fee
        if (live && !s.ok) ledger.settle(t.signature, 0n)
      }
      const failed = sent.filter((s) => !s.ok).length
      log.info(`trial ${trial}: ${target.client} ${target.leader.slice(0, 8)} window ${target.start} ${cell.mode}/${cell.timing} order ${order.join('')}${failed ? `, ${failed} send errors` : ''}`)

      if (!live) {
        for (const t of txs) {
          const r = await rpc.call('simulateTransaction', [t.wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])
          events('simulation', { trial, role: t.role, signature: t.signature, err: r.value.err, unitsConsumed: r.value.unitsConsumed })
          log.info(`  simulated ${t.role}: ${r.value.err ? JSON.stringify(r.value.err) : 'ok'}, ${r.value.unitsConsumed} CU`)
        }
      }
      trial++
      if (live && trial % 10 === 0) await fundSubPayers(cfg, rpc, rpc, ledger, log, main, subs, true)
    }
  } catch (e) {
    log.info(`run stopped by an error: ${(e as Error).message}`)
    events('error', { message: (e as Error).message })
  } finally {
    clock.stop()
    hashes.stop()
    process.off('SIGINT', onSigint)
  }
  log.info(`run ${runId}: ${trial} trials; per client ${toJson(Object.fromEntries(perClient))}`)
  // collect even after an error, so that no reservation is left open and no landed transaction goes unrecorded
  if (live && trial > 0) {
    log.info('waiting 30 s for the last transactions to settle, then collecting')
    await sleep(30_000)
    await collect(rpc, dir, ledger, log)
    log.info(`spend committed so far: ${fmtSol(ledger.committed())} of ${fmtSol(ledger.cap)}`)
  }
  return dir
}
