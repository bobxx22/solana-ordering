// Snapshot of who produces blocks: every staked validator with its client (gossip clientId and version string),
// stake and number of leader slots in the current epoch. Client labels are taken at measurement time, because
// operators switch clients and versions; every run stores its own snapshot.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import type { Log } from './log.ts'
import { stamp } from './log.ts'
import type { Rpc } from './rpc.ts'

export interface Validator {
  identity: string
  vote: string
  stake: number
  delinquent: boolean
  /** gossip client id as reported by getClusterNodes, e.g. Agave, JitoLabs, Firedancer */
  client: string
  version: string | null
  featureSet: number | null
  leaderSlots: number
}

export interface Snapshot {
  takenAt: string
  cluster: string
  rpcVersion: unknown
  epoch: { epoch: number; slotIndex: number; slotsInEpoch: number; absoluteSlot: number; firstSlot: number }
  validators: Validator[]
}

export interface ClientSummary {
  client: string
  validators: number
  stakeShare: number
  leaderSlotShare: number
  versions: Record<string, number>
}

export async function takeSnapshot(rpc: Rpc, cluster: string, log: Log): Promise<{ snapshot: Snapshot; schedule: Record<string, number[]> }> {
  const commitment = { commitment: 'finalized' }
  const epochInfo = await rpc.call('getEpochInfo', [commitment])
  const rpcVersion = await rpc.call('getVersion')
  const nodes: any[] = await rpc.call('getClusterNodes')
  const votes: any = await rpc.call('getVoteAccounts', [commitment])
  const schedule: Record<string, number[]> = (await rpc.call('getLeaderSchedule', [null, commitment])) ?? {}
  log.info(`epoch ${epochInfo.epoch}, ${nodes.length} gossip nodes, ${votes.current.length} current + ${votes.delinquent.length} delinquent vote accounts`)

  const gossip = new Map(nodes.map((n) => [n.pubkey, n]))
  const validators: Validator[] = []
  for (const [list, delinquent] of [
    [votes.current, false],
    [votes.delinquent, true],
  ] as const) {
    for (const v of list) {
      if (!v.activatedStake) continue
      const g = gossip.get(v.nodePubkey)
      validators.push({
        identity: v.nodePubkey,
        vote: v.votePubkey,
        stake: v.activatedStake,
        delinquent,
        client: g ? String(g.clientId ?? 'Unknown') : 'NotInGossip',
        version: g?.version ?? null,
        featureSet: g?.featureSet ?? null,
        leaderSlots: schedule[v.nodePubkey]?.length ?? 0,
      })
    }
  }
  validators.sort((a, b) => b.stake - a.stake)
  const firstSlot = epochInfo.absoluteSlot - epochInfo.slotIndex
  return {
    snapshot: {
      takenAt: new Date().toISOString(),
      cluster,
      rpcVersion,
      epoch: { epoch: epochInfo.epoch, slotIndex: epochInfo.slotIndex, slotsInEpoch: epochInfo.slotsInEpoch, absoluteSlot: epochInfo.absoluteSlot, firstSlot },
      validators,
    },
    schedule,
  }
}

export function summarize(validators: Validator[]): ClientSummary[] {
  const totalStake = validators.reduce((s, v) => s + v.stake, 0) || 1
  const totalSlots = validators.reduce((s, v) => s + v.leaderSlots, 0) || 1
  const by = new Map<string, ClientSummary>()
  for (const v of validators) {
    const c = by.get(v.client) ?? { client: v.client, validators: 0, stakeShare: 0, leaderSlotShare: 0, versions: {} }
    c.validators++
    c.stakeShare += v.stake / totalStake
    c.leaderSlotShare += v.leaderSlots / totalSlots
    const ver = v.version ?? 'unknown'
    c.versions[ver] = (c.versions[ver] ?? 0) + 1
    by.set(v.client, c)
  }
  return [...by.values()].sort((a, b) => b.stakeShare - a.stakeShare)
}

export function formatSummary(rows: ClientSummary[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`.padStart(7)
  const lines = ['client                validators   stake  leader slots  versions']
  for (const r of rows) {
    const versions = Object.entries(r.versions)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v}×${n}`)
      .join(' ')
    lines.push(`${r.client.padEnd(22)}${String(r.validators).padStart(10)} ${pct(r.stakeShare)} ${pct(r.leaderSlotShare).padStart(13)}  ${versions}`)
  }
  return lines.join('\n')
}

/** discover command: writes data/snapshots/<time>.json and prints the client table. */
export async function discover(cfg: Config, rpc: Rpc, log: Log): Promise<Snapshot> {
  const { snapshot } = await takeSnapshot(rpc, cfg.cluster, log)
  const dir = join(cfg.dataDir, 'snapshots')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${stamp()}-epoch${snapshot.epoch.epoch}.json`)
  writeFileSync(file, JSON.stringify(snapshot, null, 1))
  log.info(`snapshot written to ${file}`)
  console.log(formatSummary(summarize(snapshot.validators)))
  return snapshot
}
