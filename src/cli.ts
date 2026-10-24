// Entry point: node src/cli.ts <command> [--flags]
import { join } from 'node:path'
import { fmtSol, loadConfig, parseArgs } from './config.ts'
import { discover } from './discover.ts'
import { createKeypairFile, loadKeypair } from './keys.ts'
import { Log, stamp } from './log.ts'
import { Rpc } from './rpc.ts'

const HELP = `usage: node src/cli.ts <command> [flags]

commands
  keygen     create a new wallet file (default keys/payer.json); prints only its address
  address    print the wallet address and balance
  airdrop    request test SOL (devnet / localnet only)
  discover   snapshot validators by client and stake into data/snapshots/

common flags
  --cluster mainnet-beta|devnet|localnet   (env CLUSTER, default mainnet-beta)
  --rpc URL                                (env RPC_URL)
  --keypair PATH                           (env KEYPAIR, default keys/payer.json)
  --data DIR                               (env DATA_DIR, default data)

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
    default:
      console.error(`unknown command: ${args.command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
