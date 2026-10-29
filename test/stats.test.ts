import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binomialP, kendallTau, median, quantile, signFlipP, spearman, wilson } from '../src/stats.ts'

test('kendall tau-b', () => {
  assert.equal(kendallTau([1, 2, 3, 4], [1, 2, 3, 4]), 1)
  assert.equal(kendallTau([1, 2, 3, 4], [4, 3, 2, 1]), -1)
  assert.equal(kendallTau([1, 1, 1], [1, 2, 3]), null)
  // one tie in x: concordant 2, discordant 0, ties in x 1 -> 2 / sqrt(3 * 2)
  assert.ok(Math.abs(kendallTau([1, 1, 2], [1, 2, 3])! - 2 / Math.sqrt(6)) < 1e-12)
})

test('spearman', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40])! - 1) < 1e-12)
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1])! + 1) < 1e-12)
})

test('quantiles', () => {
  assert.equal(quantile([4, 1, 3, 2], 0.5), median([4, 1, 3, 2]))
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2)
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})

test('wilson interval contains the estimate', () => {
  const [lo, hi] = wilson(30, 40)
  assert.ok(lo < 0.75 && 0.75 < hi && lo > 0.58 && hi < 0.87)
})

test('sign-flip p-values', () => {
  assert.equal(signFlipP([1, 1, 1, 1]), 2 / 16)
  assert.equal(signFlipP([1, -1]), 1)
  assert.ok(signFlipP(new Array(40).fill(0.5)) < 0.001)
})

test('binomial p-values', () => {
  assert.equal(binomialP(5, 10), 1)
  assert.ok(Math.abs(binomialP(10, 10) - 2 / 1024) < 1e-12)
})

test('exact upper tail of a sum', async () => {
  const { exactUpperTail } = await import('../src/stats.ts')
  // ten single pairs all in order: 2^-10
  assert.ok(Math.abs(exactUpperTail(Array(10).fill([0.5, 0, 0.5]), 20) - 2 ** -10) < 1e-15)
  // three two-pair trials (0/1/2 with 1/3 each), all 2: (1/3)^3
  assert.ok(Math.abs(exactUpperTail(Array(3).fill([1 / 3, 1 / 3, 1 / 3]), 6) - 1 / 27) < 1e-15)
  assert.equal(exactUpperTail([[0.5, 0, 0.5]], 0), 1)
})
