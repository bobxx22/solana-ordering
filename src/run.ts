// The experiment loop. For each upcoming leader window of a validator whose client still needs trials, it signs a
// six-transaction burst, waits for the dispatch slot and delivers the burst in a random order.
//
// Delivery paths:
//   tpu (default): straight to the QUIC TPU address the leader advertises in gossip, connected a second ahead, so
//                  arrival time and order are under our control up to that address. For most validators that is the
//                  validator itself; BAM and Harmonic validators advertise shared gateways (recorded per trial as
//                  `ingressShared`), so for them the measurement starts at the gateway.
//   rpc:           through sendTransaction of an RPC endpoint, which decides when to forward (the pilot showed the
//                  public endpoint holding bursts for ~1.3 s and releasing them in its own order).
// Without --live nothing is sent and no wallet key is used: the burst is signed by throwaway keys and simulated
// with signature verification, and on the tpu path the QUIC handshake with the leader is still made. The same six
// transactions are simulated once more paid by a funded public wallet of the latest live run, unsigned (signature
// verification off, so they could never be valid on chain), which shows they execute: no error, 600 CU each.
//
// Runs belong to a campaign (`--campaign`). Quotas, per-validator counts and excluded addresses are seeded from the
// earlier live runs of the same campaign, so a run that stopped can be continued instead of started over.
//
// Quotas are per client label, or, with `byValidator` (`--validators`), per validator: the quota keys are then
// identity prefixes, only those validators are targeted, and the records keep the validator's client as usual.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlockhashCache, SlotClock } from './clock.ts'
import { collect } from './collect.ts'
import { checkCluster, type Config, fmtSol } from './config.ts'
import { type Cell, CELL_BLOCK, CellDealer, countsTowardsQuota, DEFAULT_QUOTAS, FIRE_OFFSET, GAP_MS, MEASURED_CU, ROLES, type Role, buildTrialTxs, expectedPriority, maxFee, trialCost, WINDOW_SLOTS } from './design.ts'
import { takeSnapshot } from './discover.ts'
import { decode32 } from './base58.ts'
import { generateKeypairBytes, loadKeypair, type Signer, signerFromBytes } from './keys.ts'
import { CapExceeded, Ledger, SWEEP_ALLOWANCE } from './ledger.ts'
import type { Log } from './log.ts'
import { stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { settleOpen } from './settle.ts'
import { TpuSender } from './tpu.ts'
import { appendJsonl, readJsonl, rng, shuffle, sleep, toJson } from './util.ts'
import { balances, fundSubPayers, loadSubPayers, SUB_LOW, SUB_PAYERS, SUB_TARGET } from './wallets.ts'

export type SendPath = 'tpu' | 'rpc'

/**
 * The commit of the code making a run, and whether `src` or `py` differ from it; null outside a git checkout (the
 * Docker image has none). Added after the confirmatory run: earlier runs tie to their code by time only.
 */
export function codeVersion(): { commit: string; dirty: boolean } | null {
  try {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'src', 'py') !== '' }
  } catch {
    return null
  }
}

export interface RunOptions {
  /** counted trials wanted per client label (countsTowardsQuota; the labels not listed are not targeted) */
  quotas: Record<string, number>
  /** the keys of `quotas` are identity prefixes of single validators instead of client labels */
  byValidator: boolean
  /** trials per validator; raised for clients whose leader slots sit with few validators */
  perValidator: number
  /** the block of cells dealt per client */
  cells: Cell[]
  path: SendPath
  /** runs of one campaign share quotas and exclusions; calibration runs use their own campaign */
  campaign: string
  spacingMs: number
  seed: number
  /** in a dry run, how many trials to simulate */
  dryTrials: number
  maxMinutes: number
  /** lamports each sub-payer is funded to (default SUB_TARGET, sized for the main run) */
  subTarget?: bigint
}

export const DEFAULT_CLIENTS = Object.keys(DEFAULT_QUOTAS)
const SLOT_MS = 200
/** how far ahead to look for the window of the client that needs a trial most */
const LOOKAHEAD_SLOTS = 60
/** QUIC connection is opened this many slots before dispatch */
const CONNECT_AHEAD = 5
/** landing is checked this long after a trial */
const CHECK_AFTER_MS = 5_000
/** a payer must hold the rent-exempt minimum plus the largest fee plus this margin before it is used */
const RENT_EXEMPT = 890_880n
const PAYER_MARGIN = 50_000n
/** a cached blockhash older than this is not signed with */
const MAX_BLOCKHASH_AGE_MS = 5_000
/** the run stops after this long of uninterrupted loop failures (RPC outage) */
const MAX_FAILING_MS = 5 * 60_000

/** Time allowed for the clock to reach a slot `ahead` slots away: twice the nominal time plus half a minute. */
const slotWaitMs = (ahead: number) => Math.max(0, ahead) * SLOT_MS * 2 + 30_000

export const runsDir = (cfg: Config) => join(cfg.dataDir, cfg.cluster, 'runs')
export const dryRunsDir = (cfg: Config) => join(cfg.dataDir, cfg.cluster, 'dry-runs')
export const ledgerFile = (cfg: Config) => join(cfg.dataDir, cfg.cluster, 'ledger.jsonl')

class Fatal extends Error {}

/**
 * For a dry run's execution check: the best-funded public wallet (main or sub-payer) of the latest live run. Only its
 * address is used, never a key; null when there is none with a balance.
 */
async function executionPayer(cfg: Config, rpc: Rpc): Promise<Signer | null> {
  const root = runsDir(cfg)
  const metas = (existsSync(root) ? readdirSync(root).sort() : [])
    .map((id) => join(root, id, 'run.json'))
    .filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, 'utf8')))
    .filter((m) => m.live)
  const last = metas.at(-1)
  if (!last) return null
  const wallets: string[] = [last.mainWallet, ...last.subPayers]
  const bal = await balances(rpc, wallets)
  const best = bal.indexOf(bal.reduce((a, b) => (b > a ? b : a), 0n))
  if (bal[best] < 1_000_000n) return null
  return { address: wallets[best], publicKey: decode32(wallets[best]), sign: () => new Uint8Array(64) }
}

/**
 * Counters carried over from the earlier live runs of a campaign: landed trials and their cells, dispatches,
 * per-validator counts (refused handshakes included) and excluded addresses. Whether an address takes unstaked
 * traffic is a fact about the address, not the campaign, so `everLanded` is built from every live run.
 */
function campaignState(cfg: Config, campaign: string, labelOf: (leader: string, client: string) => string | null = (_, client) => client) {
  const perClient = new Map<string, number>()
  const perValidator = new Map<string, number>()
  const dispatched = new Map<string, number>()
  const excluded = new Set<string>()
  const everLanded = new Set<string>()
  const cells: { client: string; cell: Cell }[] = []
  const root = runsDir(cfg)
  const runs: string[] = []
  for (const id of existsSync(root) ? readdirSync(root).sort() : []) {
    const f = join(root, id, 'run.json')
    if (!existsSync(f)) continue
    const meta = JSON.parse(readFileSync(f, 'utf8'))
    if (!meta.live) continue
    const trials = readJsonl(join(root, id, 'trials.jsonl'))
    const events = readJsonl(join(root, id, 'events.jsonl'))
    // any live run: addresses through which something landed
    const landedFile = join(root, id, 'landed.json')
    if (existsSync(landedFile)) {
      const landedTrials = new Set((JSON.parse(readFileSync(landedFile, 'utf8')) as { trial: number; slot: number | null }[]).filter((l) => l.slot !== null).map((l) => l.trial))
      for (const t of trials) if (t.tpuQuic && landedTrials.has(t.trial)) everLanded.add(t.tpuQuic)
    }
    for (const e of events) if (e.type === 'landing-check' && e.landed > 0) everLanded.add(e.ingress)
    if (meta.campaign !== campaign) continue
    runs.push(id)
    const byTrial = new Map(trials.map((t) => [t.trial, t]))
    for (const t of trials) {
      const label = labelOf(t.leader, t.client)
      if (label) dispatched.set(label, (dispatched.get(label) ?? 0) + 1)
      perValidator.set(t.leader, (perValidator.get(t.leader) ?? 0) + 1)
    }
    for (const e of events) {
      // runs before the quota rule of countsTowardsQuota recorded only how many landed
      if (e.type === 'landing-check' && (e.counts ?? e.landed >= 2)) {
        const t = byTrial.get(e.trial)
        const label = t ? labelOf(t.leader, t.client) : e.client
        if (!label) continue
        perClient.set(label, (perClient.get(label) ?? 0) + 1)
        if (t) cells.push({ client: label, cell: { mode: t.mode, delivery: t.delivery } })
      }
      if (e.type === 'refused') perValidator.set(e.leader, (perValidator.get(e.leader) ?? 0) + 1)
      if (e.type === 'exclude') excluded.add(e.ingress)
    }
  }
  return { runs, perClient, perValidator, dispatched, excluded, everLanded, cells }
}

export async function run(cfg: Config, rpc: Rpc, opts: RunOptions, log: Log): Promise<string> {
  const live = cfg.live
  const runId = stamp()
  // dry runs never mix with the evidence
  const dir = join(live ? runsDir(cfg) : dryRunsDir(cfg), runId)
  mkdirSync(dir, { recursive: true })
  log.tee(join(dir, 'run.log'))
  const events = (type: string, fields: Record<string, unknown>) => appendJsonl(join(dir, 'events.jsonl'), { t: new Date().toISOString(), type, ...fields })
  const sendRpc = new Rpc(cfg.sendRpcUrl, { minGapMs: 0, retries: 0, timeoutMs: 10_000 })
  const clients = Object.keys(opts.quotas)
  const quota = (c: string) => opts.quotas[c] ?? 0

  // a dry run never touches a funded key: a simulated transaction signed by one could still be relayed and land
  const throwaway = () => signerFromBytes(generateKeypairBytes())
  const main: Signer = live ? loadKeypair(cfg.keypairPath) : throwaway()
  const subs: Signer[] = live ? loadSubPayers(cfg, true).signers : Array.from({ length: SUB_PAYERS }, throwaway)
  if (!live) log.info('dry run: throwaway keys, so simulations report AccountNotFound, which still proves the signatures')
  const unsignedPayer = live ? null : await executionPayer(cfg, rpc)
  if (!live) log.info(unsignedPayer ? `execution check: unsigned copies paid by ${unsignedPayer.address} (a public wallet of the latest live run)` : 'execution check skipped: no funded wallet of a live run')
  const ledger = new Ledger(ledgerFile(cfg), cfg.spendCapLamports)
  const subTarget = opts.subTarget ?? SUB_TARGET
  if (live) {
    await checkCluster(cfg, rpc, sendRpc)
    ledger.lock()
  }

  const { snapshot } = await takeSnapshot(rpc, cfg.cluster, log)
  writeFileSync(join(dir, 'snapshot.json'), toJson(snapshot, 1))
  const byIdentity = new Map(snapshot.validators.map((v) => [v.identity, v]))
  // validators behind one advertised QUIC address
  const behind = new Map<string, number>()
  for (const v of snapshot.validators) if (v.tpuQuic) behind.set(v.tpuQuic, (behind.get(v.tpuQuic) ?? 0) + 1)
  // effective number of validators per client by leader slots, (sum s)^2 / sum s^2: the cap per validator must let
  // a client whose slots sit with a few validators reach its quota
  const slotsOf = new Map<string, number[]>()
  for (const v of snapshot.validators) if (!v.delinquent && v.leaderSlots > 0) slotsOf.set(v.client, [...(slotsOf.get(v.client) ?? []), v.leaderSlots])
  const effective = (client: string) => {
    const s = slotsOf.get(client) ?? [1]
    return s.reduce((a, b) => a + b, 0) ** 2 / s.reduce((a, b) => a + b * b, 0)
  }
  // the label a leader's trials are counted under: its client, or with byValidator the prefix it matches (else none)
  const prefixOf = new Map<string, string>()
  if (opts.byValidator)
    for (const p of clients) {
      const m = snapshot.validators.filter((v) => v.identity.startsWith(p))
      if (m.length !== 1) throw new Error(`--validators ${p}: ${m.length} validators in the snapshot start with it`)
      prefixOf.set(m[0].identity, p)
      log.info(`  ${p}: ${m[0].identity} (${m[0].client} ${m[0].version ?? '?'}, ${m[0].leaderSlots} leader slots this epoch, QUIC ${m[0].tpuQuic ?? 'none'})`)
    }
  const labelOf = (leader: string, client: string) => (opts.byValidator ? (prefixOf.get(leader) ?? null) : client)
  // with a quota per validator the quota itself is the cap
  const capPerValidator = (label: string) => (opts.byValidator ? Infinity : Math.max(opts.perValidator, Math.ceil((1.5 * quota(label)) / effective(label))))

  const carried = live ? campaignState(cfg, opts.campaign, labelOf) : campaignState(cfg, '\u0000none')
  const { perClient, perValidator, dispatched, excluded, everLanded } = carried
  const perTrial = trialCost()
  const remainingTrials = live ? clients.reduce((s, c) => s + Math.max(0, quota(c) - (perClient.get(c) ?? 0)), 0) : opts.dryTrials
  log.info(`${live ? 'LIVE' : 'dry run'} on ${cfg.cluster} via ${opts.path}, campaign "${opts.campaign}": up to ${remainingTrials} more landed trials, at most ${fmtSol(perTrial)} each (${fmtSol(perTrial * BigInt(remainingTrials))})`)
  if (carried.runs.length) log.info(`continuing from ${carried.runs.length} earlier run(s): landed ${toJson(Object.fromEntries(perClient))}, ${excluded.size} excluded addresses`)
  log.info(`spend cap ${fmtSol(ledger.cap)} (of which ${fmtSol(SWEEP_ALLOWANCE)} kept for sweeping), committed ${fmtSol(ledger.committed())}; reads via ${rpc.label}`)
  for (const r of ROLES) log.info(`  role ${r.role}: limit ${r.cuLimit} CU, price ${r.cuPrice} µL/CU, loaded-data limit ${r.loadedLimit} B, reward/cost ${expectedPriority(r).toFixed(3)}`)

  writeFileSync(
    join(dir, 'run.json'),
    toJson(
      {
        runId,
        live,
        campaign: opts.campaign,
        continues: carried.runs,
        cluster: cfg.cluster,
        startedAt: new Date().toISOString(),
        code: codeVersion(),
        options: opts,
        roles: ROLES,
        gapMs: GAP_MS,
        fireOffset: FIRE_OFFSET,
        readRpc: rpc.label,
        sendRpc: opts.path === 'rpc' ? sendRpc.label : 'direct QUIC to the TPU address advertised in gossip',
        mainWallet: main.address,
        subPayers: subs.map((s) => s.address),
        spendCap: ledger.cap,
        committedBefore: ledger.committed(),
        node: process.version,
        platform: process.platform,
      },
      1,
    ),
  )

  if (live) {
    const [mainBal] = await balances(rpc, [main.address])
    log.info(`main wallet ${main.address}: ${fmtSol(mainBal)}`)
    // fund every payer for the whole run up front, so that a mid-run top-up is the exception
    await fundSubPayers(rpc, rpc, ledger, log, main, subs, true, (subTarget * 9n) / 10n, subTarget)
  }

  const tpu = opts.path === 'tpu' ? new TpuSender() : null
  if (tpu && !(await tpu.ready())) throw new Error('the QUIC sender (py/tpu_sender.py) did not start; install py/requirements.txt')
  const random = rng(opts.seed)
  const dealer = new CellDealer(random, opts.cells)
  for (const { client, cell } of carried.cells) dealer.add(client, cell)
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
  // `docker compose stop` sends SIGTERM: stop the same graceful way (landing checks and collection still run)
  process.on('SIGTERM', onSigint)

  const deadline = Date.now() + opts.maxMinutes * 60_000
  // A trial counts towards its client's quota once B, C, D, F and A or E are confirmed in the targeted window
  // (countsTowardsQuota). An address (validator or shared gateway) that has never landed anything and fails twice in
  // a row (two empty bursts, or refused handshakes) is no longer targeted; an address that landed before is never
  // excluded. A client stops being targeted after three times its quota of dispatches.
  const dropped = new Map<string, number>()
  type Check = { trial: number; client: string; label: string; ingress: string; cell: Cell; txs: { signature: string; role: Role; maxFee: bigint }[]; at: number; windowStart: number; lastAckMs: number | null }
  const checks: Check[] = []
  const failed = (ingress: string, client: string, why: string) => {
    dropped.set(ingress, (dropped.get(ingress) ?? 0) + 1)
    if (dropped.get(ingress)! >= 2 && !everLanded.has(ingress) && !excluded.has(ingress)) {
      excluded.add(ingress)
      log.info(`${ingress} (${behind.get(ingress) ?? 1} validators, last ${client}) never landed and failed twice in a row (${why}); no longer targeted`)
      events('exclude', { ingress, validatorsBehind: behind.get(ingress) ?? 1, client, why })
    }
  }
  const processChecks = async (all = false) => {
    while (checks.length && (all || checks[0].at <= Date.now())) {
      const c = checks[0]
      if (c.at > Date.now()) await sleep(c.at - Date.now())
      const { value } = await rpc.call('getSignatureStatuses', [c.txs.map((t) => t.signature)])
      checks.shift()
      const ok = value.map((st: any) => !!st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'))
      const landed = ok.filter(Boolean).length
      // the window's slots all belong to the targeted leader, so the slot alone places a transaction in the window
      const inWindow = c.txs.filter((t, i) => ok[i] && value[i].slot >= c.windowStart && value[i].slot < c.windowStart + WINDOW_SLOTS).map((t) => t.role)
      const counts = countsTowardsQuota(inWindow)
      // our fee is exactly base + priority (verify checks it against the chain); settling now frees the reservation
      c.txs.forEach((t, i) => ok[i] && ledger.settle(t.signature, t.maxFee))
      // arrival margin: how long before our clock saw the window's first slot the leader had acknowledged the burst
      // (our clock lags the leader, so the true margin is smaller by that lag)
      const windowSeen = clock.seen.get(c.windowStart) ?? null
      const marginMs = windowSeen !== null && c.lastAckMs !== null ? windowSeen - c.lastAckMs : null
      events('landing-check', { trial: c.trial, client: c.client, ingress: c.ingress, landed, inWindow: inWindow.sort().join(''), counts, marginMs })
      if (landed > 0) {
        everLanded.add(c.ingress)
        dropped.set(c.ingress, 0)
      }
      if (counts) perClient.set(c.label, (perClient.get(c.label) ?? 0) + 1)
      else {
        // the cell was counted at dispatch; a trial that does not count towards the quota gives it back
        dealer.add(c.label, c.cell, -1)
        if (landed === 0) failed(c.ingress, c.client, 'empty burst')
      }
    }
  }
  // trials still awaiting their landing check count as landed until the check says otherwise, so a client is not
  // targeted again in the seconds before its last trial is confirmed
  const pendingFor = (c: string) => checks.filter((x) => x.label === c).length
  const needed = (c: string) => quota(c) > 0 && (perClient.get(c) ?? 0) + pendingFor(c) < quota(c) && (!live || (dispatched.get(c) ?? 0) < 3 * quota(c))
  let trial = 0
  let attempt = 0
  let lastFire = 0
  let lastSettle = Date.now()
  let failingSince = 0
  while (!stopping && Date.now() < deadline) {
    try {
      if (tpu?.exited) throw new Fatal('the QUIC sender exited')
      if (live) await processChecks()
      if (live ? !clients.some(needed) && checks.length === 0 : trial >= opts.dryTrials) break
      if (clock.slot - leadersFrom > 1500) await refreshLeaders()
      const set = trial % 2
      const setPayers = subs.slice(set * ROLES.length, (set + 1) * ROLES.length)
      if (live) {
        // the set about to be used: idle since two trials, so a top-up cannot touch a transaction in flight
        const bal = await balances(rpc, setPayers.map((s) => s.address))
        const need = RENT_EXEMPT + ROLES.reduce((m, r) => (maxFee(r) > m ? maxFee(r) : m), 0n) + PAYER_MARGIN
        if (bal.some((b) => b < need)) {
          try {
            await fundSubPayers(rpc, rpc, ledger, log, main, setPayers, true, subTarget < SUB_LOW ? subTarget : SUB_LOW, subTarget)
          } catch (e) {
            // not fatal: the payers are re-checked before this set's next trial
            log.info(`top-up failed (${(e as Error).message}); retrying before the next trial of this set`)
            events('topup-failed', { message: (e as Error).message })
            await sleep(2000)
            continue
          }
        }
        // release expired reservations as the run goes, so open ones never pile up against the cap
        if (Date.now() - lastSettle > 60_000) {
          await settleOpen(rpc, ledger, readJsonl(join(dir, 'planned.jsonl')))
          lastSettle = Date.now()
        }
      }

      // among the windows of the next few seconds, the one whose client is furthest from its quota
      const minFire = Math.max(clock.slot + CONNECT_AHEAD + 2, lastFire + Math.ceil(opts.spacingMs / SLOT_MS))
      let target: { start: number; leader: string; client: string; label: string; fire: number; tpuQuic: string | null } | undefined
      let best = Infinity
      for (let i = Math.max(1, minFire - leadersFrom - 1); i < leaders.length && i < minFire - leadersFrom + LOOKAHEAD_SLOTS; i++) {
        const leader = leaders[i]
        if (leader === leaders[i - 1]) continue
        const v = byIdentity.get(leader)
        const client = v?.client ?? 'unknown'
        const label = labelOf(leader, client)
        if (!label || !needed(label) || (perValidator.get(leader) ?? 0) >= capPerValidator(label)) continue
        if (opts.path === 'tpu' && (!v?.tpuQuic || excluded.has(v.tpuQuic))) continue
        const start = leadersFrom + i
        const fire = start + FIRE_OFFSET[dealer.peek(label).delivery]
        if (fire < minFire) continue
        const need = (perClient.get(label) ?? 0) / quota(label)
        if (need < best) {
          best = need
          target = { start, leader, client, label, fire, tpuQuic: v?.tpuQuic ?? null }
        }
      }
      if (!target) {
        if (leaders.length - (clock.slot - leadersFrom) < LOOKAHEAD_SLOTS * 2) await refreshLeaders()
        await sleep(1000)
        failingSince = 0
        continue
      }
      attempt++
      const cell = dealer.peek(target.label)
      const payers = shuffle(setPayers, random)
      const order = shuffle(
        ROLES.map((r) => r.role),
        random,
      ) as Role[]
      const gapMs = GAP_MS[cell.delivery]
      const skip = (reason: string) => {
        if (tpu && target!.tpuQuic) tpu.closeLater(target!.tpuQuic, 0)
        log.info(`attempt ${attempt}: ${reason}; skipping`)
        events('skip', { attempt, reason, windowStart: target!.start, fireSlot: target!.fire, client: target!.client, slot: clock.slot })
      }

      // open the QUIC connection about a second ahead; sign a few slots ahead with the cached blockhash
      await clock.waitFor(target.fire - CONNECT_AHEAD, slotWaitMs(target.fire - clock.slot))
      let handshakeMs: number | null = null
      if (tpu) {
        const c = await tpu.connect(target.tpuQuic!)
        if (!c.ok) {
          if (tpu.exited) throw new Fatal('the QUIC sender exited')
          skip(`QUIC connect to ${target.client} failed: ${c.error}`)
          // a refusing address is not retried at every one of its windows, in this run or a continuation
          perValidator.set(target.leader, (perValidator.get(target.leader) ?? 0) + 1)
          events('refused', { leader: target.leader, client: target.client, ingress: target.tpuQuic })
          failed(target.tpuQuic!, target.client, 'handshake refused')
          continue
        }
        handshakeMs = c.handshakeMs ?? null
      }
      await clock.waitFor(target.fire - 2, slotWaitMs(target.fire - clock.slot))
      const blockhash = hashes.blockhash
      const lastValidBlockHeight = hashes.lastValidBlockHeight
      const blockhashAgeMs = Date.now() - hashes.fetchedAt
      if (blockhashAgeMs > MAX_BLOCKHASH_AGE_MS) {
        skip(`blockhash is ${blockhashAgeMs} ms old (read RPC not refreshing)`)
        continue
      }
      const txs = buildTrialTxs(cell.mode, order, payers, blockhash)
      if (clock.slot > target.fire) {
        skip(`dispatch slot ${target.fire} already passed (now ${clock.slot})`)
        continue
      }
      await clock.waitFor(target.fire, slotWaitMs(target.fire - clock.slot))
      if (clock.slot > target.fire) {
        skip(`clock jumped past dispatch slot ${target.fire} to ${clock.slot}`)
        continue
      }
      if (live) {
        // recorded before reserving, so a crash can never leave a reservation nobody knows about
        for (const t of txs) appendJsonl(join(dir, 'planned.jsonl'), { trial, signature: t.signature, lastValidBlockHeight, plannedAt: new Date().toISOString() })
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
      const fireSeenAt = clock.seenAt
      const slotAtSend = clock.slot
      const inOrder = order.map((role) => txs.find((t) => t.role === role)!)
      type Sent = { role: Role; sentAt: string; ackAt: string | null; ackMs: number | null; blocked: boolean | null; ok: boolean; error: string | null }
      let sent: Sent[]
      let connState: string | null = null
      let reconnected: string | null = null
      let reconnectMs: number | null = null
      if (!live) {
        sent = inOrder.map((t) => ({ role: t.role, sentAt: new Date().toISOString(), ackAt: null, ackMs: null, blocked: null, ok: true, error: null }))
      } else if (tpu) {
        const r = await tpu.send(target.tpuQuic!, inOrder.map((t) => t.wire), gapMs)
        connState = r.state ?? null
        reconnected = r.reconnected ?? null
        reconnectMs = r.reconnectMs ?? null
        const iso = (ns: string | null | undefined) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null)
        sent = inOrder.map((t, k) => ({
          role: t.role,
          sentAt: iso(r.sentNs?.[k]) ?? new Date().toISOString(),
          // delivery is proven only by the peer's acknowledgement of the whole stream
          ackAt: iso(r.ackNs?.[k]),
          ackMs: r.sentNs?.[k] && r.ackNs?.[k] ? Number(BigInt(r.ackNs[k]!) - BigInt(r.sentNs[k])) / 1e6 : null,
          blocked: r.blocked?.[k] ?? null,
          ok: r.ok && !!r.ackNs?.[k],
          error: !r.ok ? (r.error ?? 'send failed') : r.ackNs?.[k] ? null : 'no acknowledgement within 1.5 s',
        }))
      } else {
        const t0 = Date.now()
        sent = await Promise.all(
          inOrder.map(async (tx, k) => {
            await sleep(t0 + k * gapMs - Date.now())
            const at = Date.now()
            try {
              const r = await sendRpc.call('sendTransaction', [tx.wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
              return { role: tx.role, sentAt: new Date(at).toISOString(), ackAt: new Date().toISOString(), ackMs: Date.now() - at, blocked: null, ok: r === tx.signature, error: r === tx.signature ? null : `unexpected ${r}` }
            } catch (e) {
              return { role: tx.role, sentAt: new Date(at).toISOString(), ackAt: null, ackMs: Date.now() - at, blocked: null, ok: false, error: (e as Error).message }
            }
          }),
        )
      }
      if (tpu) tpu.closeLater(target.tpuQuic!)
      dealer.add(target.label, cell)
      lastFire = target.fire
      dispatched.set(target.label, (dispatched.get(target.label) ?? 0) + 1)
      perValidator.set(target.leader, (perValidator.get(target.leader) ?? 0) + 1)
      const ingress = target.tpuQuic ?? target.leader
      const acks = sent.map((s) => (s.ackAt ? Date.parse(s.ackAt) : NaN)).filter(Number.isFinite)
      const lastAckMs = acks.length === sent.length ? Math.max(...acks) : null
      if (live) checks.push({ trial, client: target.client, label: target.label, ingress, cell, txs: txs.map((t) => ({ signature: t.signature, role: t.role, maxFee: t.maxFee })), at: Date.now() + CHECK_AFTER_MS, windowStart: target.start, lastAckMs })
      else perClient.set(target.label, (perClient.get(target.label) ?? 0) + 1)
      const v = byIdentity.get(target.leader)
      appendJsonl(join(dir, 'trials.jsonl'), {
        trial,
        windowStart: target.start,
        fireSlot: target.fire,
        slotAtSend,
        fireSeenAt: new Date(fireSeenAt).toISOString(),
        clockSource: clock.source,
        leader: target.leader,
        client: target.client,
        version: v?.version ?? null,
        path: opts.path,
        tpuQuic: opts.path === 'tpu' ? target.tpuQuic : null,
        ingressShared: opts.path === 'tpu' && target.tpuQuic ? (behind.get(target.tpuQuic) ?? 1) : null,
        handshakeMs,
        connState,
        reconnected,
        reconnectMs,
        mode: cell.mode,
        delivery: cell.delivery,
        sendOrder: order,
        gapMs,
        payerSet: set,
        blockhash,
        blockhashAgeMs,
        lastValidBlockHeight,
        live,
      })
      for (const t of txs) {
        const s = sent.find((x) => x.role === t.role)!
        const { wire, ...rest } = t
        // a failed send keeps its reservation: the transaction may still have left; collect settles it later
        appendJsonl(join(dir, 'txs.jsonl'), { trial, ...rest, sentAt: s.sentAt, ackAt: s.ackAt, ackMs: s.ackMs, blocked: s.blocked, slotAtSend, sendOk: s.ok, sendError: s.error, lastValidBlockHeight, live })
      }
      const notAcked = sent.filter((s) => !s.ok).length
      log.info(`trial ${trial}: ${target.client} ${target.leader.slice(0, 8)} window ${target.start} ${cell.mode}/${cell.delivery} order ${order.join('')}${notAcked ? `, ${notAcked} not acknowledged` : ''}`)

      if (!live) {
        for (const t of txs) {
          const r = await rpc.call('simulateTransaction', [t.wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])
          events('simulation', { trial, role: t.role, signature: t.signature, err: r.value.err, unitsConsumed: r.value.unitsConsumed })
          log.info(`  simulated ${t.role}: ${r.value.err ? JSON.stringify(r.value.err) : 'ok'}, ${r.value.unitsConsumed} CU`)
        }
        if (unsignedPayer) {
          const copies = buildTrialTxs(cell.mode, order, Array(ROLES.length).fill(unsignedPayer), blockhash)
          for (const t of copies) {
            const r = await rpc.call('simulateTransaction', [t.wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }])
            const fine = !r.value.err && r.value.unitsConsumed === MEASURED_CU
            events('execution', { trial, role: t.role, err: r.value.err, unitsConsumed: r.value.unitsConsumed, expected: MEASURED_CU })
            log.info(`  executed ${t.role} (unsigned copy): ${r.value.err ? JSON.stringify(r.value.err) : 'ok'}, ${r.value.unitsConsumed} CU${fine ? '' : ` (UNEXPECTED: the design assumes no error and ${MEASURED_CU} CU)`}`)
            if (r.value.err) process.exitCode = 1
          }
        }
      }
      trial++
      failingSince = 0
    } catch (e) {
      if (e instanceof Fatal) {
        log.info(`run stopped: ${e.message}`)
        events('error', { message: e.message, fatal: true })
        break
      }
      // a transient failure (RPC error, timeout) costs an iteration, not the run
      failingSince ||= Date.now()
      log.info(`iteration failed: ${(e as Error).message}`)
      events('loop-error', { message: (e as Error).message })
      if (Date.now() - failingSince > MAX_FAILING_MS) {
        log.info('failing for five minutes in a row; stopping (continue later with the same --campaign)')
        events('error', { message: 'failing for five minutes', fatal: true })
        break
      }
      await sleep(Math.min(30_000, 1000 + (Date.now() - failingSince) / 10))
    }
  }
  clock.stop()
  hashes.stop()
  tpu?.stop()
  if (live) await processChecks(true).catch((e) => log.info(`final landing checks failed: ${(e as Error).message}`))
  log.info(
    live
      ? `run ${runId}: ${trial} trials in ${attempt} attempts; trials counting towards the quotas in the campaign ${toJson(Object.fromEntries(perClient))}; dispatched ${toJson(Object.fromEntries(dispatched))}`
      : `dry run ${runId}: ${trial} trials simulated in ${attempt} attempts, nothing sent`,
  )
  // collect even after an error, and keep collecting until no reservation of this run is open (blockhashes expire in ~1 min)
  if (live && trial > 0) {
    const mine = new Set(readJsonl(join(dir, 'planned.jsonl')).map((p) => p.signature as string))
    for (let round = 0; round < 8; round++) {
      await sleep(20_000)
      try {
        await collect(rpc, dir, ledger, log)
      } catch (e) {
        log.info(`collect failed (${(e as Error).message}); retrying`)
        continue
      }
      if (!ledger.openSignatures().some((s) => mine.has(s))) break
    }
    log.info(`spend committed so far: ${fmtSol(ledger.committed())} of ${fmtSol(ledger.cap)}`)
  }
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigint)
  ledger.unlock()
  return dir
}

export const DEFAULT_CELLS = CELL_BLOCK
