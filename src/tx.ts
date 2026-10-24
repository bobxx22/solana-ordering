// Minimal legacy-transaction builder: compile a message, sign it, serialize it.
// Wire format: https://solana.com/docs/core/transactions (compact-u16 lengths, header, keys, blockhash, instructions).
import { decode32, encode } from './base58.ts'
import type { Signer } from './keys.ts'

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

export interface AccountMeta {
  pubkey: string
  isSigner: boolean
  isWritable: boolean
}

export interface Instruction {
  programId: string
  keys: AccountMeta[]
  data: Uint8Array
}

export interface SignedTx {
  signature: string
  /** wire bytes, ready for sendTransaction (base64) */
  bytes: Uint8Array
  message: Uint8Array
}

function shortVec(n: number): number[] {
  const out: number[] = []
  for (;;) {
    let b = n & 0x7f
    n >>= 7
    if (n === 0) {
      out.push(b)
      return out
    }
    out.push(b | 0x80)
  }
}

const u32 = (v: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v, true)
  return b
}
const u64 = (v: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, v, true)
  return b
}

export const computeUnitLimit = (units: number): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Uint8Array([2, ...u32(units)]) })
/** price in micro-lamports per compute unit */
export const computeUnitPrice = (microLamports: bigint): Instruction => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: new Uint8Array([3, ...u64(microLamports)]),
})
export const loadedAccountsDataSizeLimit = (bytes: number): Instruction => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  keys: [],
  data: new Uint8Array([4, ...u32(bytes)]),
})
export const memo = (text: string): Instruction => ({ programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(text) })
export const transfer = (from: string, to: string, lamports: bigint): Instruction => ({
  programId: SYSTEM_PROGRAM,
  keys: [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
  ],
  data: new Uint8Array([...u32(2), ...u64(lamports)]),
})

/** Compiles a legacy message. The fee payer comes first; then signers, writable before readonly. */
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): { message: Uint8Array; signers: string[] } {
  const metas = new Map<string, { signer: boolean; writable: boolean; order: number }>()
  const add = (pubkey: string, signer: boolean, writable: boolean) => {
    const m = metas.get(pubkey)
    if (m) {
      m.signer ||= signer
      m.writable ||= writable
    } else metas.set(pubkey, { signer, writable, order: metas.size })
  }
  add(feePayer, true, true)
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable)
    add(ix.programId, false, false)
  }
  const rank = (m: { signer: boolean; writable: boolean }) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1)
  const keys = [...metas.entries()].sort((a, b) => (a[0] === feePayer ? -1 : b[0] === feePayer ? 1 : rank(a[1]) - rank(b[1]) || a[1].order - b[1].order))
  const index = new Map(keys.map(([k], i) => [k, i]))
  const signers = keys.filter(([, m]) => m.signer).map(([k]) => k)
  const header = [
    signers.length,
    keys.filter(([, m]) => m.signer && !m.writable).length,
    keys.filter(([, m]) => !m.signer && !m.writable).length,
  ]
  const bytes: number[] = [...header, ...shortVec(keys.length)]
  for (const [k] of keys) bytes.push(...decode32(k))
  bytes.push(...decode32(recentBlockhash), ...shortVec(instructions.length))
  for (const ix of instructions) {
    bytes.push(index.get(ix.programId)!, ...shortVec(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!))
    bytes.push(...shortVec(ix.data.length), ...ix.data)
  }
  return { message: new Uint8Array(bytes), signers }
}

export function signTransaction(feePayer: Signer, instructions: Instruction[], recentBlockhash: string, extraSigners: Signer[] = []): SignedTx {
  const { message, signers } = compileMessage(feePayer.address, instructions, recentBlockhash)
  const byAddress = new Map([feePayer, ...extraSigners].map((s) => [s.address, s]))
  const sigs = signers.map((a) => {
    const s = byAddress.get(a)
    if (!s) throw new Error(`missing signer ${a}`)
    return s.sign(message)
  })
  const bytes = new Uint8Array([...shortVec(sigs.length), ...sigs.flatMap((s) => [...s]), ...message])
  if (bytes.length > 1232) throw new Error(`transaction is ${bytes.length} bytes, the limit is 1232`)
  return { signature: encode(sigs[0]), bytes, message }
}
