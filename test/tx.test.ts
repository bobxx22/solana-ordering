import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { test } from 'node:test'
import { decode32, encode } from '../src/base58.ts'
import { generateKeypairBytes, signerFromBytes } from '../src/keys.ts'
import { COMPUTE_BUDGET_PROGRAM, compileMessage, computeUnitLimit, computeUnitPrice, MEMO_PROGRAM, memo, signTransaction, transfer } from '../src/tx.ts'

const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM'

test('keypair bytes round-trip and reject a mismatched public key', () => {
  const bytes = generateKeypairBytes()
  const s = signerFromBytes(bytes)
  assert.equal(s.address, encode(bytes.subarray(32)))
  const broken = bytes.slice()
  broken[40] ^= 1
  assert.throws(() => signerFromBytes(broken), /corrupt/)
})

test('message layout: header, key order, instruction indices', () => {
  const payer = signerFromBytes(generateKeypairBytes())
  const to = signerFromBytes(generateKeypairBytes()).address
  const { message, signers } = compileMessage(payer.address, [computeUnitLimit(1000), computeUnitPrice(5n), transfer(payer.address, to, 7n), memo('x')], BLOCKHASH)
  assert.deepEqual(signers, [payer.address])
  assert.deepEqual([...message.subarray(0, 3)], [1, 0, 3]) // 1 signer, 0 readonly signers, 3 readonly unsigned (3 programs)
  assert.equal(message[3], 5) // 5 account keys
  const key = (i: number) => encode(message.subarray(4 + 32 * i, 4 + 32 * (i + 1)))
  assert.equal(key(0), payer.address)
  assert.equal(key(1), to) // writable non-signer before readonly programs
  assert.deepEqual([key(2), key(3), key(4)], [COMPUTE_BUDGET_PROGRAM, '11111111111111111111111111111111', MEMO_PROGRAM])
  assert.equal(encode(message.subarray(4 + 32 * 5, 4 + 32 * 6)), BLOCKHASH)
  const ix = message.subarray(4 + 32 * 6)
  assert.equal(ix[0], 4) // instruction count
  assert.deepEqual([...ix.subarray(1, 9)], [2, 0, 5, 2, 0xe8, 0x03, 0, 0]) // program 2, no accounts, 5 bytes: SetComputeUnitLimit(1000)
})

test('signature verifies over the message bytes', () => {
  const payer = signerFromBytes(generateKeypairBytes())
  const tx = signTransaction(payer, [memo('order-test')], BLOCKHASH)
  assert.equal(tx.bytes[0], 1)
  const sig = tx.bytes.subarray(1, 65)
  assert.equal(encode(sig), tx.signature)
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(decode32(payer.address))])
  assert.ok(verify(null, tx.message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig))
  assert.deepEqual(tx.bytes.subarray(65), tx.message)
})
