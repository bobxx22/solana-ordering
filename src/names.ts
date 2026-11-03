// Two things the chain says about a validator apart from its trials, read once and committed so that `analyze` stays
// offline. Neither sends anything or reads a key.
//   names    the identity's own validator-info account of the Config program: self-declared, a name and not a proof
//            of who runs the node.
//   rakurai  the activation accounts of Rakurai's on-chain program: an on/off switch for Rakurai's scheduler, which
//            says what was approved, not what is running.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRuns } from './analyze.ts'
import { encode } from './base58.ts'
import type { Config } from './config.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'

const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111'

export interface NamesFile {
  takenAt: string
  source: string
  names: Record<string, { name: string; infoAccount: string }>
}

/** The identity and name in a jsonParsed account of the Config program; null when it is not validator info. */
export function parseValidatorInfo(account: any): { identity: string; name: string; infoAccount: string } | null {
  const parsed = account?.account?.data?.parsed
  if (parsed?.type !== 'validatorInfo') return null
  const identity = parsed.info?.keys?.find((k: any) => k.signer)?.pubkey
  const name = parsed.info?.configData?.name
  if (typeof identity !== 'string' || typeof name !== 'string' || !name.trim()) return null
  return { identity, name: name.trim(), infoAccount: account.pubkey }
}

/** names command: writes data/<cluster>/validator-names.json for every validator a direct-path trial aimed at. */
export async function writeValidatorNames(cfg: Config, rpc: Rpc, log: Log): Promise<void> {
  const wanted = new Set(loadRuns(join(cfg.dataDir, cfg.cluster, 'runs')).trials.filter((t) => t.path === 'tpu').map((t) => t.targetLeader))
  const accounts: any[] = await rpc.call('getProgramAccounts', [CONFIG_PROGRAM, { encoding: 'jsonParsed' }])
  const found = accounts
    .map(parseValidatorInfo)
    .filter((x): x is NonNullable<ReturnType<typeof parseValidatorInfo>> => !!x && wanted.has(x.identity))
    // an identity may hold several info accounts: the choice must not depend on the order the endpoint returns them in
    .sort((a, b) => a.identity.localeCompare(b.identity) || a.infoAccount.localeCompare(b.infoAccount))
  const names: NamesFile['names'] = {}
  for (const f of found) names[f.identity] ??= { name: f.name, infoAccount: f.infoAccount }
  const file: NamesFile = {
    takenAt: new Date().toISOString(),
    source: `getProgramAccounts ${CONFIG_PROGRAM}, jsonParsed, validatorInfo accounts signed by the identity; self-declared`,
    names,
  }
  mkdirSync(join(cfg.dataDir, cfg.cluster), { recursive: true })
  const out = join(cfg.dataDir, cfg.cluster, 'validator-names.json')
  writeFileSync(out, JSON.stringify(file, null, 1) + '\n')
  log.info(`names of ${Object.keys(names).length} of the ${wanted.size} validators of our trials written to ${out}, via ${rpc.label}`)
}

/** Rakurai's activation program on mainnet (rakurai_docs/rakurai_programs/README.md of rakurai-io/rakurai-validator). */
export const RAKURAI_ACTIVATION_PROGRAM = 'rAKACC6Qw8HYa87ntGPRbfYEMnK2D9JVLsmZaKPpMmi'
/** The RakuraiActivationAccount discriminator in Rakurai's published IDL. */
const ACTIVATION_DISCRIMINATOR = [23, 29, 221, 229, 148, 135, 217, 153]

export interface ActivationFile {
  takenAt: string
  source: string
  /** the authority is the validator's identity: all 71 accounts that derive from a staked identity were so on 2026-11-03 */
  accounts: { account: string; authority: string; isEnabled: boolean }[]
}

/** The fields we use of an account of the activation program: discriminator, is_enabled, proposer (an option), authority. */
export function parseActivationAccount(account: string, base64: string): ActivationFile['accounts'][number] | null {
  const d = Buffer.from(base64, 'base64')
  if (d.length < 8 + 2 + 32 || !ACTIVATION_DISCRIMINATOR.every((x, i) => d[i] === x)) return null
  let o = 8
  const isEnabled = d[o++] === 1
  if (d[o++] === 1) o += 32
  return { account, authority: encode(d.subarray(o, o + 32)), isEnabled }
}

/** rakurai command: writes data/<cluster>/rakurai-activation.json. */
export async function writeRakuraiActivation(cfg: Config, rpc: Rpc, log: Log): Promise<void> {
  const raw: any[] = await rpc.call('getProgramAccounts', [RAKURAI_ACTIVATION_PROGRAM, { encoding: 'base64' }])
  const accounts = raw
    .map((a) => parseActivationAccount(a.pubkey, a.account.data[0]))
    .filter((a): a is ActivationFile['accounts'][number] => !!a)
    .sort((a, b) => a.authority.localeCompare(b.authority) || a.account.localeCompare(b.account))
  const file: ActivationFile = {
    takenAt: new Date().toISOString(),
    source: `getProgramAccounts ${RAKURAI_ACTIVATION_PROGRAM}, base64, RakuraiActivationAccount layout of Rakurai's published IDL`,
    accounts,
  }
  mkdirSync(join(cfg.dataDir, cfg.cluster), { recursive: true })
  const out = join(cfg.dataDir, cfg.cluster, 'rakurai-activation.json')
  writeFileSync(out, JSON.stringify(file, null, 1) + '\n')
  log.info(`${accounts.length} activation accounts, ${accounts.filter((a) => a.isEnabled).length} enabled, written to ${out}, via ${rpc.label}`)
}
