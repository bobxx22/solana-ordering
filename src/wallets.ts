// The main wallet funds a pool of sub-payers (one per transaction of a trial, two sets so that consecutive trials
// never share a fee payer) and sweeps them back at the end. Sub-payer keys are files next to the main wallet.
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Config } from './config.ts'
import { fmtSol } from './config.ts'
import { createKeypairFile, generateKeypairBytes, loadKeypair, type Signer, signerFromBytes } from './keys.ts'
import type { Ledger } from './ledger.ts'
import type { Log } from './log.ts'
import type { Rpc } from './rpc.ts'
import { signTransaction, transfer } from './tx.ts'
import { chunk, sleep } from './util.ts'

export const SUB_PAYERS = 10
/** top up a sub-payer below this balance ... */
export const SUB_LOW = 1_100_000n
/** ... to this one (rent-exempt minimum for a 0-byte account is 890 880 lamports) */
export const SUB_TARGET = 2_000_000n
export const TX_FEE = 5_000n

export function subPayerPath(cfg: Config, i: number): string {
  return join(dirname(cfg.keypairPath), `sub-${String(i).padStart(2, '0')}.json`)
}

/** Loads (or, when `create`, creates) the sub-payer files; when they do not exist and !create, uses throwaway keys. */
export function loadSubPayers(cfg: Config, create: boolean): { signers: Signer[]; ephemeral: boolean } {
  const signers: Signer[] = []
  let ephemeral = false
  for (let i = 0; i < SUB_PAYERS; i++) {
    const p = subPayerPath(cfg, i)
    if (existsSync(p)) signers.push(loadKeypair(p))
    else if (create) signers.push(createKeypairFile(p))
    else {
      signers.push(signerFromBytes(generateKeypairBytes()))
      ephemeral = true
    }
  }
  return { signers, ephemeral }
}

export async function balances(rpc: Rpc, addresses: string[]): Promise<bigint[]> {
  const out: bigint[] = []
  for (const part of chunk(addresses, 100)) {
    const { value } = await rpc.call('getMultipleAccounts', [part, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])
    for (const a of value) out.push(BigInt(a?.lamports ?? 0))
  }
  return out
}

/** Sends one transaction and rebroadcasts it every 2 s until it is confirmed or its blockhash expires. */
export async function sendAndConfirm(sendRpc: Rpc, rpc: Rpc, wire: Uint8Array, signature: string, lastValidBlockHeight: number): Promise<boolean> {
  const b64 = Buffer.from(wire).toString('base64')
  for (;;) {
    try {
      await sendRpc.call('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
    } catch {}
    await sleep(2000)
    const { value } = await rpc.call('getSignatureStatuses', [[signature]])
    const st = value[0]
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      if (st.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`)
      return true
    }
    const height: number = await rpc.call('getBlockHeight', [{ commitment: 'confirmed' }])
    if (height > lastValidBlockHeight) return false
  }
}

async function transferBatch(
  rpc: Rpc,
  sendRpc: Rpc,
  ledger: Ledger,
  log: Log,
  feePayer: Signer,
  moves: { from: Signer; to: string; lamports: bigint }[],
  what: string,
): Promise<void> {
  const { value } = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const signers = [...new Map(moves.map((m) => [m.from.address, m.from])).values()].filter((s) => s.address !== feePayer.address)
  const tx = signTransaction(
    feePayer,
    moves.map((m) => transfer(m.from.address, m.to, m.lamports)),
    value.blockhash,
    signers,
  )
  const fee = TX_FEE * BigInt(1 + signers.length)
  ledger.reserve([{ signature: tx.signature, lamports: fee, what }])
  log.event('wallet-tx', { what, signature: tx.signature, moves: moves.map((m) => ({ from: m.from.address, to: m.to, lamports: m.lamports })) })
  const ok = await sendAndConfirm(sendRpc, rpc, tx.bytes, tx.signature, value.lastValidBlockHeight)
  ledger.settle(tx.signature, ok ? fee : 0n)
  if (!ok) throw new Error(`${what}: transaction expired without landing (${tx.signature}); nothing was moved`)
  log.info(`${what}: confirmed ${tx.signature}`)
}

/** Brings every sub-payer below SUB_LOW back up to SUB_TARGET. Without `live` only prints the plan. */
export async function fundSubPayers(cfg: Config, rpc: Rpc, sendRpc: Rpc, ledger: Ledger, log: Log, main: Signer, subs: Signer[], live: boolean): Promise<void> {
  const bal = await balances(rpc, subs.map((s) => s.address))
  const moves = subs.flatMap((s, i) => (bal[i] < SUB_LOW ? [{ from: main, to: s.address, lamports: SUB_TARGET - bal[i] }] : []))
  if (moves.length === 0) return
  const total = moves.reduce((s, m) => s + m.lamports, 0n)
  log.info(`top-up: ${moves.length} sub-payers, ${fmtSol(total)} from the main wallet`)
  if (!live) return
  for (const part of chunk(moves, 8)) await transferBatch(rpc, sendRpc, ledger, log, main, part, 'fund')
}

/** Returns every sub-payer's whole balance to the main wallet (which pays the fees), closing the accounts. */
export async function sweepSubPayers(cfg: Config, rpc: Rpc, sendRpc: Rpc, ledger: Ledger, log: Log, main: Signer, subs: Signer[], live: boolean): Promise<void> {
  const bal = await balances(rpc, subs.map((s) => s.address))
  const moves = subs.flatMap((s, i) => (bal[i] > 0n ? [{ from: s, to: main.address, lamports: bal[i] }] : []))
  const total = moves.reduce((s, m) => s + m.lamports, 0n)
  log.info(`sweep: ${moves.length} sub-payers hold ${fmtSol(total)}`)
  if (!live || moves.length === 0) return
  // four extra signatures per transaction keep it well under the 1232-byte limit
  for (const part of chunk(moves, 4)) await transferBatch(rpc, sendRpc, ledger, log, main, part, 'sweep')
}
