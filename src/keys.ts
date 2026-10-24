// Ed25519 keypairs in the solana-keygen file format: a JSON array of 64 bytes (32-byte seed + 32-byte public key).
// Signing uses node:crypto, so no third-party code ever touches the secret key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { encode } from './base58.ts'

export interface Signer {
  address: string
  publicKey: Uint8Array
  sign(message: Uint8Array): Uint8Array
}

// PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410)
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
// SubjectPublicKeyInfo DER of an Ed25519 key ends with the raw 32-byte public key
const rawPublic = (der: Buffer) => der.subarray(der.length - 32)

export function signerFromBytes(bytes: Uint8Array): Signer {
  if (bytes.length !== 64) throw new Error(`a keypair has 64 bytes, got ${bytes.length}`)
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
  const publicKey = new Uint8Array(rawPublic(createPublicKey(key).export({ format: 'der', type: 'spki' })))
  // the stored public key must be the one the seed derives, otherwise signatures would not verify on chain
  if (!Buffer.from(publicKey).equals(Buffer.from(bytes.subarray(32)))) throw new Error('keypair file is corrupt: public key does not match the seed')
  return {
    address: encode(publicKey),
    publicKey,
    sign: (message) => new Uint8Array(sign(null, message, key)),
  }
}

/** A fresh keypair as the 64 bytes of a solana-keygen file. */
export function generateKeypairBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  return new Uint8Array([...pkcs8.subarray(pkcs8.length - 32), ...rawPublic(publicKey.export({ format: 'der', type: 'spki' }))])
}

export function loadKeypair(path: string): Signer {
  if (!existsSync(path)) throw new Error(`no keypair at ${path} (create one with the keygen command)`)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`${path} is not a solana-keygen JSON array`)
  return signerFromBytes(Uint8Array.from(raw))
}

/** Writes a new keypair file (owner-only permissions) and returns its signer. Never overwrites. */
export function createKeypairFile(path: string): Signer {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a wallet`)
  mkdirSync(dirname(path), { recursive: true })
  const bytes = generateKeypairBytes()
  const signer = signerFromBytes(bytes)
  writeFileSync(path, JSON.stringify([...bytes]), { mode: 0o600, flag: 'wx' })
  return signer
}
