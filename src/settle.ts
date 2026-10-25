// Closing spend reservations. A reservation is settled to the fee actually charged as soon as its transaction is
// found on chain, and to zero only when its blockhash has provably expired (the finalized block height is past the
// transaction's last valid block height) and a history search still does not find it.
import type { Ledger } from './ledger.ts'
import type { Rpc } from './rpc.ts'
import { chunk } from './util.ts'

export interface Pending {
  signature: string
  /** from getLatestBlockhash when the transaction was signed; absent in records made before it was stored */
  lastValidBlockHeight?: number | null
  sentAt?: string
}

/** Records without a last valid block height are treated as expired this long after sending. */
const LEGACY_EXPIRY_MS = 10 * 60_000

export async function finalizedHeight(rpc: Rpc): Promise<number> {
  return rpc.call<number>('getBlockHeight', [{ commitment: 'finalized' }])
}

/**
 * Settles every open reservation among `items` that can be decided now and returns what was decided.
 * `feeOf` gives the fee of a landed transaction when the caller already knows it (from a fetched block);
 * otherwise it is read with getTransaction.
 */
export async function settleOpen(
  rpc: Rpc,
  ledger: Ledger,
  items: Pending[],
  feeOf: (signature: string) => number | null = () => null,
): Promise<{ landed: number; expired: number; open: number }> {
  // one entry per signature; a later record (the sent one) overrides an earlier (planned) one
  const open = [...new Map(items.map((i) => [i.signature, i])).values()].filter((i) => ledger.isOpen(i.signature))
  if (open.length === 0) return { landed: 0, expired: 0, open: 0 }
  const height = await finalizedHeight(rpc)
  let landed = 0
  let expired = 0
  for (const part of chunk(open, 256)) {
    const { value } = await rpc.call('getSignatureStatuses', [part.map((p) => p.signature), { searchTransactionHistory: true }])
    for (let i = 0; i < part.length; i++) {
      const p = part[i]
      const st = value[i]
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        let fee = feeOf(p.signature)
        if (fee === null) {
          const tx = await rpc.call('getTransaction', [p.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
          fee = tx?.meta?.fee ?? null
        }
        if (fee !== null) {
          ledger.settle(p.signature, BigInt(fee))
          landed++
        }
      } else if (!st) {
        const dead = p.lastValidBlockHeight ? height > p.lastValidBlockHeight : p.sentAt !== undefined && Date.now() - Date.parse(p.sentAt) > LEGACY_EXPIRY_MS
        // a status search can miss history on some nodes; settling to zero also needs getTransaction to know nothing
        if (dead && !(await rpc.call('getTransaction', [p.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]))) {
          ledger.settle(p.signature, 0n)
          expired++
        }
      }
    }
  }
  return { landed, expired, open: open.length - landed - expired }
}
