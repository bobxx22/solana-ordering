import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, decode32, encode } from '../src/base58.ts'

test('known vectors', () => {
  assert.equal(encode(new Uint8Array(32)), '11111111111111111111111111111111')
  assert.equal(encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U')
  assert.equal(encode(new Uint8Array([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4')
  assert.deepEqual(decode('11233QC4'), new Uint8Array([0, 0, 0x28, 0x7f, 0xb4, 0xcd]))
})

test('program ids decode to 32 bytes and round-trip', () => {
  for (const id of ['ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Vote111111111111111111111111111111111111111']) {
    assert.equal(encode(decode32(id)), id)
  }
})

test('random round-trip', () => {
  for (let i = 0; i < 200; i++) {
    const b = new Uint8Array(1 + (i % 70)).map(() => (Math.random() < 0.1 ? 0 : (Math.random() * 256) | 0))
    assert.deepEqual(decode(encode(b)), b)
  }
})

test('rejects invalid characters', () => {
  assert.throws(() => decode('0OIl'))
})
