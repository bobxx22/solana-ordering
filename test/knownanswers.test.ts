import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PRIMARY } from '../src/analyze.ts'
import { ROLES, SWAPPED_ROLES } from '../src/design.ts'
import { familyOutcome, KEYS, knownAnswers, mostFrequent, readingOutcome, RULES, sortBy, swapOutcome, twinOutcome } from '../src/knownanswers.ts'
import { rng } from '../src/util.ts'

const order = (s: ReturnType<typeof sortBy>, send = ROLES.map((r) => r.role)) => s(send, rng(1)).join('')
const rule = (name: string) => RULES.find((r) => r.name.startsWith(name))!

test('a simulated leader gives the order of its rule', () => {
  assert.match(order(sortBy(KEYS.rewardCost())), /^(AE|EA)DCFB$/)
  assert.match(order(sortBy(KEYS.linear(1.4))), /^(AE|EA)DCFB$/)
  assert.match(order(sortBy(KEYS.totalFee)), /^BD[AEF]{3}C$/)
  assert.match(order(sortBy(KEYS.largerLimit)), /^BD[AEF]{3}C$/)
  assert.match(order(sortBy(KEYS.rewardCost(0.15))), /^(AE|EA)DCBF$/)
  assert.match(order(sortBy(KEYS.rewardCost(0.117))), /^(AE|EA)DBCF$/)
  assert.match(order(sortBy(KEYS.rewardCost(1))), /^(AE|EA)CDFB$/)
  assert.match(order(sortBy(KEYS.totalFee, 'random', SWAPPED_ROLES)), /^BD[AEF]{3}C$/)
  assert.match(order(sortBy(KEYS.largerLimit, 'random', SWAPPED_ROLES)), /^DB[AEF]{3}C$/)
  assert.match(order(sortBy(KEYS.rewardCost(), 'random', SWAPPED_ROLES)), /^B(AE|EA)CFD$/)
})

test('ties go by the tie rule', () => {
  const send = ['E', 'B', 'A', 'C', 'D', 'F'] as (typeof ROLES)[number]['role'][]
  assert.equal(order(sortBy(KEYS.rewardCost(), 'oldest first'), send), 'EADCFB')
  assert.equal(order(sortBy(KEYS.rewardCost(), 'newest first'), send), 'AEDCFB')
})

test('the real code reads every rule that decides all three contrasts as the plan predicts', () => {
  for (const r of RULES.filter((x) => x.expected)) {
    const o = familyOutcome(r, 3, 1)
    PRIMARY.forEach((c, j) => {
      const decided = r.expected!.verdicts[j] !== 'no stable order'
      // a chance-level contrast can fall either way in a few data sets; a decided one cannot
      if (decided) assert.equal(mostFrequent(o.verdicts[j]), r.expected!.verdicts[j], `${r.name}: ${c.name}`)
      else assert.ok(!o.verdicts[j].has('holds') || r.trials, `${r.name}: ${c.name} should not hold`)
    })
    assert.equal(o.controlPasses / o.labels >= 0.5, r.expected!.control, `${r.name}: control`)
  }
})

test('what the plan prints: reward/cost, the look-alike, the whole base fee, and no rule', () => {
  const reading = (name: string) => mostFrequent(familyOutcome(rule(name), 2, 2).readings)
  assert.match(reading("reward/cost, the source's"), /^consistent with reward per requested cost/)
  assert.match(reading('reward − 1.4'), /^consistent with reward per requested cost/)
  assert.match(reading('reward/cost, the whole'), /C before D: the whole base fee counts/)
  assert.match(reading('total fee'), /B before C: the base fee does not count/)
  assert.equal(reading('no rule'), 'no fee ordering detected')
  assert.equal(reading('arrival, the first'), 'no fee ordering detected')
})

test('a validator with few trials: strict rules are read at the floor, noise never gets a name', () => {
  assert.equal(readingOutcome(rule("reward/cost, the source's").scheduler, 5, 50, 3).get('reward/cost'), 50)
  assert.equal(readingOutcome(rule('total fee').scheduler, 5, 50, 3).get('total fee'), 50)
  assert.equal(readingOutcome(rule('no rule').scheduler, 5, 200, 3).get('mixed'), 200)
})

test('the swapped parameters separate total fee from the larger limit, and the exact order from reward/cost', () => {
  const total = swapOutcome(KEYS.totalFee, 12, 5, 1)
  const larger = swapOutcome(KEYS.largerLimit, 12, 5, 1)
  const ratio = swapOutcome(KEYS.rewardCost(), 12, 5, 1)
  assert.deepEqual([total.bBeforeD, total.confirmed, total.exact.totalFee], [1, 1, 1])
  assert.deepEqual([larger.bBeforeD, larger.confirmed, larger.exact.largerLimitFirst], [0, 0, 1])
  assert.deepEqual([ratio.bBeforeD, ratio.exact.totalFee, ratio.exact.rewardCost], [1, 0, 1])
})

test('the twins: the tie rule shows, and random ties sit at chance', () => {
  assert.equal(twinOutcome('oldest first', 32, 3, 1).share, 1)
  assert.equal(twinOutcome('newest first', 32, 3, 1).share, 0)
  const random = twinOutcome('random', 32, 40, 1)
  assert.ok(Math.abs(random.share - 0.5) < 0.1)
})

test('the committed file says every rule was read as predicted', () => {
  const lines = readFileSync('data/mainnet-beta/results/known-answers.md', 'utf8').split('\n')
  assert.ok(lines.some((l) => l.includes('| as predicted |')))
  assert.ok(!lines.some((l) => l.endsWith('| **no** |')), 'a rule was not read as predicted')
})

test('the output is seeded: two calls agree', () => {
  assert.equal(knownAnswers(1), knownAnswers(1))
})
