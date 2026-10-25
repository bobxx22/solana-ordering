// Settings come from the environment (optionally a .env file) and command-line flags; flags win.
import { existsSync } from 'node:fs'

export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'

export const LAMPORTS_PER_SOL = 1_000_000_000n
/** Hard ceiling for total spending on mainnet, whatever SPEND_CAP_SOL says. */
export const MAINNET_CAP_CEILING = 50_000_000n // 0.05 SOL

const DEFAULT_RPC: Record<Cluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
}

export interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | boolean>
}

/** Flags that never take a value, so `--live run` cannot swallow the command. */
const BOOLEAN_FLAGS = new Set(['live', 'help', 'refresh', 'offline', 'write'])

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      const [k, v] = [a.slice(2, eq), a.slice(eq + 1)]
      flags.set(k, BOOLEAN_FLAGS.has(k) ? v === 'true' || v === '1' || v === '' : v)
      if (BOOLEAN_FLAGS.has(k) && flags.get(k) === false) flags.delete(k)
    } else if (!BOOLEAN_FLAGS.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(a.slice(2), argv[++i])
    else flags.set(a.slice(2), true)
  }
  return { command: positional.shift() ?? 'help', positional, flags }
}

export interface Config {
  cluster: Cluster
  /** reads: slots, blocks, statuses, cluster info */
  rpcUrl: string
  /** where transactions are submitted */
  sendRpcUrl: string
  keypairPath: string
  dataDir: string
  spendCapLamports: bigint
  /** true only with the explicit --live flag */
  live: boolean
}

function solToLamports(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text.trim())
  if (!m) throw new Error(`not a SOL amount: ${text}`)
  return BigInt(m[1]) * LAMPORTS_PER_SOL + BigInt((m[2] ?? '').padEnd(9, '0'))
}

export function loadConfig(args: Args): Config {
  const envFile = (args.flags.get('env') as string) || '.env'
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const get = (flag: string, env: string): string | undefined => {
    const f = args.flags.get(flag)
    return typeof f === 'string' ? f : process.env[env] || undefined
  }
  const cluster = (get('cluster', 'CLUSTER') ?? 'mainnet-beta') as Cluster
  if (!(cluster in DEFAULT_RPC)) throw new Error(`unknown cluster ${cluster}`)
  const helius = process.env.HELIUS_API_KEY
  const heliusUrl = helius && (cluster === 'mainnet-beta' || cluster === 'devnet') ? `https://${cluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=${helius}` : undefined
  const rpcUrl = get('rpc', 'RPC_URL') ?? heliusUrl ?? DEFAULT_RPC[cluster]
  let cap = solToLamports(get('cap', 'SPEND_CAP_SOL') ?? '0.05')
  if (cluster === 'mainnet-beta' && cap > MAINNET_CAP_CEILING) {
    console.warn(`spend cap lowered to the mainnet ceiling of 0.05 SOL`)
    cap = MAINNET_CAP_CEILING
  }
  return {
    cluster,
    rpcUrl,
    // sends default to the public endpoint: free keyed plans allow about one sendTransaction per second
    sendRpcUrl: get('send-rpc', 'SEND_RPC_URL') ?? DEFAULT_RPC[cluster],
    keypairPath: get('keypair', 'KEYPAIR') ?? 'keys/payer.json',
    dataDir: get('data', 'DATA_DIR') ?? 'data',
    spendCapLamports: cap,
    live: args.flags.get('live') === true,
  }
}

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/**
 * Before anything is sent: both endpoints must serve the same chain, and the cluster label must match it. The mainnet
 * ceiling therefore follows the chain actually reached, not the --cluster flag.
 */
export async function checkCluster(cfg: Config, read: { call<T>(m: string, p?: unknown[]): Promise<T> }, send: { call<T>(m: string, p?: unknown[]): Promise<T> }): Promise<void> {
  const [a, b] = [await read.call<string>('getGenesisHash'), await send.call<string>('getGenesisHash')]
  if (a !== b) throw new Error('the read and send endpoints serve different chains')
  const isMainnet = a === MAINNET_GENESIS
  if (isMainnet !== (cfg.cluster === 'mainnet-beta')) throw new Error(`--cluster ${cfg.cluster} but the endpoints serve ${isMainnet ? 'mainnet' : 'another chain'}`)
  if (isMainnet && cfg.spendCapLamports > MAINNET_CAP_CEILING) throw new Error('spend cap above the mainnet ceiling')
}

export const fmtSol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
