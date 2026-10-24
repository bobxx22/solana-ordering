// Reduces a getBlock response (json encoding, full details, rewards) to what the analysis needs, per position.
import { BASE_FEE_PER_SIGNATURE } from './design.ts'

/** One row per transaction, in block order: [fee, costUnits, computeUnitsConsumed, priorityFee, failed, signatures] */
export type BlockRow = [number, number, number, number, 0 | 1, number]

export interface BlockSummary {
  slot: number
  blockhash: string
  parentSlot: number
  blockTime: number | null
  blockHeight: number | null
  /** identity that received the block's fee reward, i.e. the leader that produced it */
  leader: string | null
  txCount: number
  versions: Record<string, number>
  rows: BlockRow[]
}

export const BLOCK_REQUEST = { encoding: 'json', transactionDetails: 'full', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }

/**
 * Priority fee of any transaction in the block: version-1 transactions state it in their header; for legacy and v0
 * it is the fee above the per-signature base fee (exact unless the transaction also verifies precompile signatures).
 */
function priorityFeeOf(tx: any): number {
  const declared = tx.transaction?.message?.transactionConfig?.priorityFee
  if (typeof declared === 'number') return declared
  const sigs = tx.transaction?.message?.header?.numRequiredSignatures ?? 1
  return Math.max(0, tx.meta.fee - Number(BASE_FEE_PER_SIGNATURE) * sigs)
}

export function parseBlock(slot: number, block: any): { summary: BlockSummary; indexOf: Map<string, number> } {
  const indexOf = new Map<string, number>()
  const versions: Record<string, number> = {}
  const rows: BlockRow[] = block.transactions.map((tx: any, i: number): BlockRow => {
    indexOf.set(tx.transaction.signatures[0], i)
    const v = String(tx.version ?? 'legacy')
    versions[v] = (versions[v] ?? 0) + 1
    return [tx.meta.fee, tx.meta.costUnits ?? 0, tx.meta.computeUnitsConsumed ?? 0, priorityFeeOf(tx), tx.meta.err ? 1 : 0, tx.transaction.message.header.numRequiredSignatures]
  })
  const fee = (block.rewards ?? []).find((r: any) => r.rewardType === 'Fee')
  return {
    summary: {
      slot,
      blockhash: block.blockhash,
      parentSlot: block.parentSlot,
      blockTime: block.blockTime ?? null,
      blockHeight: block.blockHeight ?? null,
      leader: fee?.pubkey ?? null,
      txCount: rows.length,
      versions,
      rows,
    },
    indexOf,
  }
}
