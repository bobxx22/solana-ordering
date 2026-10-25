// Reduces a getBlock response (json encoding, full details, rewards) to what the analysis needs, per position.
import { decode } from './base58.ts'
import { BASE_FEE_PER_SIGNATURE, loadedDataCost } from './design.ts'
import { COMPUTE_BUDGET_PROGRAM } from './tx.ts'

/**
 * One row per transaction, in block order:
 * [fee, costUnits, computeUnitsConsumed, priorityFee, failed, signatures, requestedCuLimit, limitExplicit,
 *  requestedLoadedDataLimit, scheduledCost]
 * costUnits is the block cost after execution (consumed CU, actually loaded bytes). scheduledCost is what the
 * scheduler saw before execution: signatures (and precompile verifications), write locks, instruction data, the
 * requested compute-unit limit and the requested loaded-accounts-data limit (64 MiB when not set).
 */
export type BlockRow = [number, number, number, number, 0 | 1, number, number, 0 | 1, number, number]

export interface BlockSummary {
  slot: number
  blockhash: string
  parentSlot: number
  blockTime: number | null
  blockHeight: number | null
  /** scheduled leader of the slot (leader schedule); filled in by collect */
  leader: string | null
  /**
   * recipient of the block's fee reward. Usually the leader's identity, but validators may direct block revenue to a
   * separate collector account, so it is not used to identify the leader.
   */
  feeCollector: string | null
  txCount: number
  versions: Record<string, number>
  rows: BlockRow[]
}

export const BLOCK_REQUEST = { encoding: 'json', transactionDetails: 'full', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }

// Agave cost model constants
const SIGNATURE_COST = 720
const WRITE_LOCK_COST = 300
const INSTRUCTION_DATA_BYTES_PER_CU = 4
const MAX_CU_LIMIT = 1_400_000
const DEFAULT_LOADED_LIMIT = 64 * 1024 * 1024
/** signature-verification precompiles: cost per verified signature (the count is the instruction data's first byte) */
const PRECOMPILES: Record<string, number> = {
  Ed25519SigVerify111111111111111111111111111: 2_400,
  KeccakSecp256k11111111111111111111111111111: 6_690,
  Secp256r1SigVerify1111111111111111111111111: 4_800,
}
// builtin programs: an instruction gets 3 000 CU instead of 200 000 when no limit is requested
const BUILTINS = new Set([
  '11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  COMPUTE_BUDGET_PROGRAM,
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  ...Object.keys(PRECOMPILES),
])

export interface Requested {
  cuLimit: number
  explicit: 0 | 1
  loadedLimit: number
  /** signatures verified by precompile instructions */
  precompileSigs: number
  precompileCost: number
  writeLocks: number
  dataBytes: number
}

/** What the transaction asked for, read from its v1 header or its ComputeBudget instructions, with the defaults. */
export function requested(tx: any): Requested {
  const msg = tx.transaction.message
  const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]
  let cuLimit: number | null = typeof msg.transactionConfig?.computeUnitLimit === 'number' ? msg.transactionConfig.computeUnitLimit : null
  let loadedLimit: number | null = typeof msg.transactionConfig?.loadedAccountsDataSizeLimit === 'number' ? msg.transactionConfig.loadedAccountsDataSizeLimit : null
  let fallback = 0
  let precompileSigs = 0
  let precompileCost = 0
  let dataBytes = 0
  for (const ix of msg.instructions) {
    const program = keys[ix.programIdIndex]
    const data = decode(ix.data ?? '')
    dataBytes += data.length
    fallback += BUILTINS.has(program) ? 3_000 : 200_000
    if (program === COMPUTE_BUDGET_PROGRAM && data.length >= 5) {
      const v = new DataView(data.buffer, data.byteOffset).getUint32(1, true)
      if (data[0] === 2 && cuLimit === null) cuLimit = v
      if (data[0] === 4 && loadedLimit === null) loadedLimit = v
    }
    if (program in PRECOMPILES && data.length > 0) {
      precompileSigs += data[0]
      precompileCost += data[0] * PRECOMPILES[program]
    }
  }
  const h = msg.header
  const staticWritable = h.numRequiredSignatures - h.numReadonlySignedAccounts + (msg.accountKeys.length - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts)
  return {
    cuLimit: cuLimit ?? Math.min(MAX_CU_LIMIT, fallback),
    explicit: cuLimit === null ? 0 : 1,
    loadedLimit: loadedLimit ?? DEFAULT_LOADED_LIMIT,
    precompileSigs,
    precompileCost,
    writeLocks: staticWritable + (tx.meta?.loadedAddresses?.writable?.length ?? 0),
    dataBytes,
  }
}

export function scheduledCostOf(tx: any, r: Requested = requested(tx)): number {
  const sigs = tx.transaction.message.header.numRequiredSignatures
  return sigs * SIGNATURE_COST + r.precompileCost + r.writeLocks * WRITE_LOCK_COST + Math.floor(r.dataBytes / INSTRUCTION_DATA_BYTES_PER_CU) + r.cuLimit + loadedDataCost(r.loadedLimit)
}

/** Priority fee: stated in the header of v1 transactions; otherwise the fee above the base fee for all signatures. */
function priorityFeeOf(tx: any, r: Requested): number {
  const declared = tx.transaction?.message?.transactionConfig?.priorityFee
  if (typeof declared === 'number') return declared
  const sigs = (tx.transaction?.message?.header?.numRequiredSignatures ?? 1) + r.precompileSigs
  return Math.max(0, tx.meta.fee - Number(BASE_FEE_PER_SIGNATURE) * sigs)
}

export function parseBlock(slot: number, block: any): { summary: BlockSummary; indexOf: Map<string, number> } {
  const indexOf = new Map<string, number>()
  const versions: Record<string, number> = {}
  const rows: BlockRow[] = block.transactions.map((tx: any, i: number): BlockRow => {
    indexOf.set(tx.transaction.signatures[0], i)
    const v = String(tx.version ?? 'legacy')
    versions[v] = (versions[v] ?? 0) + 1
    const r = requested(tx)
    return [
      tx.meta.fee,
      tx.meta.costUnits ?? -1,
      tx.meta.computeUnitsConsumed ?? 0,
      priorityFeeOf(tx, r),
      tx.meta.err ? 1 : 0,
      tx.transaction.message.header.numRequiredSignatures + r.precompileSigs,
      r.cuLimit,
      r.explicit,
      r.loadedLimit,
      scheduledCostOf(tx, r),
    ]
  })
  const fee = (block.rewards ?? []).find((r: any) => r.rewardType === 'Fee')
  return {
    summary: {
      slot,
      blockhash: block.blockhash,
      parentSlot: block.parentSlot,
      blockTime: block.blockTime ?? null,
      blockHeight: block.blockHeight ?? null,
      leader: null,
      feeCollector: fee?.pubkey ?? null,
      txCount: rows.length,
      versions,
      rows,
    },
    indexOf,
  }
}

/** Scheduling cost of a row as the scheduler saw it before execution. */
export const scheduledCost = (r: BlockRow) => r[9]
