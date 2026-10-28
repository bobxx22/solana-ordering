// Entry point: node src/cli.ts <command> [--flags]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze } from './analyze.ts'
import { collect } from './collect.ts'
import { type Args, checkCluster, type Config, fmtSol, loadConfig, parseArgs } from './config.ts'
import { type Cell, CELL_BLOCK, DEFAULT_QUOTAS } from './design.ts'
import { discover } from './discover.ts'
import { createKeypairFile, loadKeypair } from './keys.ts'
import { Ledger } from './ledger.ts'
import { probePaths } from './paths.ts'
import { settleOpen } from './settle.ts'
import { Log, stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { ledgerFile, run, runsDir, type SendPath } from './run.ts'
import { verify } from './verify.ts'
import { balances, fundSubPayers, loadSubPayers, sweepSubPayers } from './wallets.ts'

const HELP = `usage: node src/cli.ts <command> [flags]

commands
  reproduce  what a judge runs (the Docker Compose default): regenerate the results from the committed raw data and
             compare them with the committed ones, verify every recorded transaction against the chain, and make
             one dry-run trial over the direct path (no keys, nothing sent)   --offline: only the first step
  keygen     create a new wallet file (default keys/payer.json); prints only its address
  address    print the wallet address and balance
  airdrop    request test SOL (devnet / localnet only)
  discover   snapshot validators by client and stake into data/<cluster>/snapshots/
  run        the experiment; a dry run (simulation only, written to data/<cluster>/dry-runs/) unless --live
               --path tpu|rpc        direct QUIC to the leader (default) or sendTransaction via --send-rpc
               --campaign NAME       required with --live: runs of one campaign share quotas and exclusions, so a
                                     stopped run is continued by running again with the same name
               --quota Agave=60,...  trials per client that count: B, C, D, F and A or E landed in the window
                                     (default: 60 per local scheduler, 30 per pipeline)
               --per-validator N     at least N trials allowed per validator (default 4; more for small clients)
               --validators 7cVfgArC=10,...  instead of --quota: only these validators (identity prefixes), each with
                                     its own quota of counted trials
               --cells buffered/shared,...   deal only these cells (delivery/mode; default the block of ten)
               --spacing-ms 4000   --seed N   --dry-trials 3   --minutes 240
  collect    landing slot, in-block position and slot leader of a run's transactions; settles the ledger
               [run id | all, default: the latest run]   --refresh refetches every block
  analyze    statistics of all live runs -> data/<cluster>/results/ (offline, from the committed raw data)
  verify     check the raw data against the chain (default endpoints: api.mainnet-beta.solana.com, then PublicNode);
             exit code 1 on mismatches (blocks no endpoint can serve are reported, not failed)
               [run id | all, default all]   --verify-rpc URL,URL
               --sample 60 (whole transactions checked, every role represented; all: every landed transaction)
               --row-blocks 3 (whole blocks whose rows are rebuilt)
               --write (all: data/<cluster>/verify.json; one run: data/<cluster>/verify/<run id>.json)
               --out FILE (write the report to FILE instead)
  paths      delivery-path probe: one transaction per endpoint per round -> data/<cluster>/paths/
               --endpoints URL,read,tpu   ('read' = the read RPC, keeping its key out of the command line;
                                           'tpu' = QUIC straight to the next leader)   --rounds 8
  status     spend ledger and wallet balances
  fund       top up the sub-payers (prints the plan unless --live)
  sweep      return all sub-payer balances to the main wallet (prints the plan unless --live)

common flags
  --cluster mainnet-beta|devnet|localnet   (env CLUSTER, default mainnet-beta)
  --rpc URL                                (env RPC_URL)
  --keypair PATH                           (env KEYPAIR, default keys/payer.json)
  --data DIR                               (env DATA_DIR, default data)
  --send-rpc URL                           (env SEND_RPC_URL, default the cluster's public endpoint)

Nothing is ever sent to mainnet without --live; the spend cap (env SPEND_CAP_SOL, at most 0.05) always applies.
`

/** "buffered/shared" -> a cell of the block of ten */
function parseCell(text: string): Cell {
  const cell = CELL_BLOCK.find((c) => `${c.delivery}/${c.mode}` === text)
  if (!cell) throw new Error(`--cells ${text}: not one of ${[...new Set(CELL_BLOCK.map((c) => `${c.delivery}/${c.mode}`))].join(', ')}`)
  return cell
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help' || args.flags.has('help')) {
    console.log(HELP)
    return
  }
  const cfg = loadConfig(args)
  const rpc = new Rpc(cfg.rpcUrl)
  const log = new Log(join(cfg.dataDir, 'logs', `${stamp()}-${args.command}.jsonl`))

  switch (args.command) {
    case 'keygen': {
      const out = (args.flags.get('out') as string) || cfg.keypairPath
      const signer = createKeypairFile(out)
      console.log(`new wallet written to ${out}`)
      console.log(`address: ${signer.address}`)
      console.log('The file is the wallet: keep a private backup of it and never commit or share it.')
      return
    }
    case 'address': {
      const signer = loadKeypair(cfg.keypairPath)
      const { value } = await rpc.call('getBalance', [signer.address, { commitment: 'confirmed' }])
      console.log(`${signer.address}  ${fmtSol(value)}  (${cfg.cluster}, ${rpc.label})`)
      return
    }
    case 'airdrop': {
      if (cfg.cluster === 'mainnet-beta') throw new Error('airdrop exists only on devnet, testnet and localnet')
      const signer = loadKeypair(cfg.keypairPath)
      const sol = Number(args.flags.get('sol') ?? 1)
      const sig = await rpc.call('requestAirdrop', [signer.address, Math.round(sol * 1e9)])
      log.event('airdrop', { cluster: cfg.cluster, address: signer.address, sol, signature: sig })
      console.log(`airdrop requested: ${sig}`)
      return
    }
    case 'discover':
      await discover(cfg, rpc, log)
      return
    case 'run': {
      const num = (k: string, d: number) => (args.flags.has(k) ? Number(args.flags.get(k)) : d)
      const campaign = typeof args.flags.get('campaign') === 'string' ? (args.flags.get('campaign') as string) : null
      if (cfg.live && !campaign) throw new Error('a live run needs --campaign NAME (the same name continues a stopped run)')
      const pairs = (flag: string) => Object.fromEntries((args.flags.get(flag) as string).split(',').map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])]))
      const byValidator = typeof args.flags.get('validators') === 'string'
      if (byValidator && args.flags.has('quota')) throw new Error('--validators and --quota exclude each other')
      const quotas = byValidator ? pairs('validators') : typeof args.flags.get('quota') === 'string' ? pairs('quota') : DEFAULT_QUOTAS
      const cells = typeof args.flags.get('cells') === 'string' ? (args.flags.get('cells') as string).split(',').map(parseCell) : CELL_BLOCK
      await run(
        cfg,
        rpc,
        {
          quotas,
          byValidator,
          perValidator: num('per-validator', 4),
          cells,
          campaign: campaign ?? 'dry',
          path: (args.flags.get('path') as SendPath) || 'tpu',
          spacingMs: num('spacing-ms', 4000),
          seed: num('seed', Date.now() % 2 ** 31),
          dryTrials: num('dry-trials', 3),
          maxMinutes: num('minutes', 240),
        },
        log,
      )
      return
    }
    case 'collect': {
      // settling needs the ledger lock; while a live run holds it, collect only reads
      let ledger: Ledger | null = new Ledger(ledgerFile(cfg), cfg.spendCapLamports)
      try {
        ledger.lock()
      } catch (e) {
        log.info(`${(e as Error).message}: collecting without settling`)
        ledger = null
      }
      const dirs = args.positional[0] === 'all' ? readdirSync(runsDir(cfg)).sort().map((id) => join(runsDir(cfg), id)) : [runDir(cfg, args)]
      for (const dir of dirs) await collect(rpc, dir, ledger, log, args.flags.get('refresh') === true)
      // reservations no run knows about (an interrupted fund, sweep or path probe)
      if (ledger) await settleOpen(rpc, ledger, ledger.openSignatures().map((signature) => ({ signature, sentAt: ledger!.reservedAt.get(signature) })))
      ledger?.unlock()
      return
    }
    case 'analyze':
      console.log(analyze(cfg.dataDir, cfg.cluster))
      return
    case 'reproduce': {
      // every file analyze writes is compared with the committed one
      const files = ['results.md', 'orders.md', 'units.json', 'summary.json', 'exact-orders.svg', 'send-order.svg'].map((f) => join(cfg.dataDir, cfg.cluster, 'results', f))
      const before = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null))
      analyze(cfg.dataDir, cfg.cluster)
      const differ = files.filter((f, i) => before[i] !== null && before[i] !== readFileSync(f, 'utf8'))
      if (before.every((b) => b === null)) log.info('reproduce: results generated (none were committed to compare with)')
      else if (!differ.length) log.info(`reproduce: the ${files.length} result files regenerated from the raw data are identical to the committed ones`)
      else {
        log.info(`reproduce: regenerated results DIFFER from the committed ones: ${differ.join(', ')} (see git diff data/)`)
        process.exitCode = 1
      }
      if (args.flags.has('offline')) return
      // a seeded sample of 120 blocks keeps this within minutes on the public endpoint; `verify` checks every block
      const r = await verify(verifyRpcs(cfg, args), runsDir(cfg), log, { maxBlocks: 120, sample: 30, rowBlocks: 2 })
      if (r.problems.length) process.exitCode = 1
      await run({ ...cfg, live: false }, rpc, { quotas: DEFAULT_QUOTAS, byValidator: false, perValidator: 4, cells: CELL_BLOCK, campaign: 'dry', path: 'tpu', spacingMs: 4000, seed: 1, dryTrials: 1, maxMinutes: 5 }, log)
      return
    }
    case 'paths': {
      const endpoints = typeof args.flags.get('endpoints') === 'string' ? (args.flags.get('endpoints') as string).split(',').map((u) => (u === 'read' ? cfg.rpcUrl : u)) : [cfg.sendRpcUrl]
      await probePaths(cfg, rpc, endpoints, Number(args.flags.get('rounds') ?? 8), log)
      return
    }
    case 'verify': {
      // one run: the per-session check of the runbook, written next to the others; all runs: verify.json; --out: any file
      const one = args.positional[0] && args.positional[0] !== 'all' ? args.positional[0] : undefined
      const out = args.flags.get('out')
      const writeTo = typeof out === 'string' ? out : args.flags.get('write') === true ? join(cfg.dataDir, cfg.cluster, ...(one ? ['verify', `${one}.json`] : ['verify.json'])) : undefined
      const sample = args.flags.get('sample') === 'all' ? Infinity : Number(args.flags.get('sample') ?? 60)
      const r = await verify(verifyRpcs(cfg, args), runsDir(cfg), log, { run: one, writeTo, sample, rowBlocks: Number(args.flags.get('row-blocks') ?? 3) })
      if (r.problems.length) process.exitCode = 1
      return
    }
    case 'status': {
      const ledger = new Ledger(ledgerFile(cfg), cfg.spendCapLamports)
      console.log(`spend ledger ${ledgerFile(cfg)}: committed ${fmtSol(ledger.committed())} of cap ${fmtSol(ledger.cap)}, ${ledger.openSignatures().length} open reservations`)
      if (existsSync(cfg.keypairPath)) {
        const main = loadKeypair(cfg.keypairPath)
        const { signers } = loadSubPayers(cfg, false)
        const bal = await balances(rpc, [main.address, ...signers.map((s) => s.address)])
        console.log(`main ${main.address}: ${fmtSol(bal[0])}; sub-payers: ${fmtSol(bal.slice(1).reduce((a, b) => a + b, 0n))}`)
      }
      return
    }
    case 'fund':
    case 'sweep': {
      const main = loadKeypair(cfg.keypairPath)
      const { signers } = loadSubPayers(cfg, args.command === 'fund' && cfg.live)
      const ledger = new Ledger(ledgerFile(cfg), cfg.spendCapLamports)
      if (cfg.live) {
        await checkCluster(cfg, rpc, rpc)
        ledger.lock()
      }
      const f = args.command === 'fund' ? fundSubPayers : sweepSubPayers
      await f(rpc, rpc, ledger, log, main, signers, cfg.live)
      ledger.unlock()
      if (!cfg.live) console.log('plan only; add --live to send')
      return
    }
    default:
      console.error(`unknown command: ${args.command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}

/**
 * Verification endpoints, tried in order: by default the public Solana endpoint, which keeps the whole history (most
 * free endpoints keep only a day or two of blocks), then PublicNode. --verify-rpc takes a comma-separated list.
 */
const VERIFY_RPCS: Record<string, string[]> = { 'mainnet-beta': ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'] }
function verifyRpcs(cfg: Config, args: Args): Rpc[] {
  const given = args.flags.get('verify-rpc')
  const urls = typeof given === 'string' ? given.split(',') : (VERIFY_RPCS[cfg.cluster] ?? [cfg.sendRpcUrl])
  return urls.map((u) => new Rpc(u, { minGapMs: 200, retries: 6 }))
}

/** A run directory: the id given as the first argument, or the latest run. */
function runDir(cfg: Config, args: Args): string {
  const root = runsDir(cfg)
  const id = args.positional[0] ?? (existsSync(root) ? readdirSync(root).sort().at(-1) : undefined)
  if (!id) throw new Error(`no runs in ${root}`)
  return join(root, id)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
