// Entry point: node src/cli.ts <command> [--flags]
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { collect } from './collect.ts'
import { type Args, type Config, fmtSol, loadConfig, parseArgs } from './config.ts'
import type { Timing } from './design.ts'
import { discover } from './discover.ts'
import { createKeypairFile, loadKeypair } from './keys.ts'
import { Ledger } from './ledger.ts'
import { Log, stamp } from './log.ts'
import { Rpc } from './rpc.ts'
import { DEFAULT_CLIENTS, ledgerFile, run, runsDir } from './run.ts'
import { balances, fundSubPayers, loadSubPayers, sweepSubPayers } from './wallets.ts'

const HELP = `usage: node src/cli.ts <command> [flags]

commands
  keygen     create a new wallet file (default keys/payer.json); prints only its address
  address    print the wallet address and balance
  airdrop    request test SOL (devnet / localnet only)
  discover   snapshot validators by client and stake into data/<cluster>/snapshots/
  run        the experiment; a dry run (simulation only) unless --live
               --clients A,B,..      clients to target (default: the eight largest)
               --per-client N        trials per client (default 50)
               --per-validator N     at most N trials per validator (default 4)
               --timings early,inwindow   --gap-ms 20   --spacing-ms 4000
               --seed N   --dry-trials 3   --minutes 240
  collect    landing slot and in-block position of a run's transactions; settles the ledger
               [run id, default: the latest run]
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
      const list = (k: string, d: string[]) => (typeof args.flags.get(k) === 'string' ? (args.flags.get(k) as string).split(',') : d)
      const num = (k: string, d: number) => (args.flags.has(k) ? Number(args.flags.get(k)) : d)
      await run(
        cfg,
        rpc,
        {
          clients: list('clients', DEFAULT_CLIENTS),
          perClient: num('per-client', 50),
          perValidator: num('per-validator', 4),
          timings: list('timings', ['early', 'inwindow']) as Timing[],
          gapMs: num('gap-ms', 20),
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
      const dir = runDir(cfg, args)
      await collect(rpc, dir, new Ledger(ledgerFile(cfg), cfg.spendCapLamports), log)
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
      const f = args.command === 'fund' ? fundSubPayers : sweepSubPayers
      await f(cfg, rpc, rpc, ledger, log, main, signers, cfg.live)
      if (!cfg.live) console.log('plan only; add --live to send')
      return
    }
    default:
      console.error(`unknown command: ${args.command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
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
