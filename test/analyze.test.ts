import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type ContrastStat, interpret, keptBySensitivity, MIN_TRIALS, type Unit, verdict, versionFamily } from '../src/analyze.ts'
import { barChart } from '../src/charts.ts'
import { parseArgs } from '../src/config.ts'
import { countsTowardsQuota } from '../src/design.ts'
import { signFlipUpperP } from '../src/stats.ts'
import { readJsonl } from '../src/util.ts'

const stat = (n: number, share: number, ci: [number, number], p: number): ContrastStat => ({ n, share, ci, p, pHolm: p })

test('verdicts: a minimum of trials; only an interval below 0.5 is "reversed"', () => {
  assert.equal(verdict(stat(MIN_TRIALS - 1, 1, [0.7, 1], 0.001)), 'insufficient data')
  assert.equal(verdict(stat(30, 0.9, [0.8, 1], 0.001)), 'holds')
  assert.equal(verdict(stat(30, 0.2, [0.07, 0.37], 1)), 'reversed')
  // chance-level order: no stable order, not an alternative rule
  assert.equal(verdict(stat(25, 0.5, [0.3, 0.7], 0.6)), 'no stable order')
  assert.equal(verdict(stat(12, 0.7, [0.45, 0.9], 0.1)), 'inconclusive')
})

test('reading: only "reversed" names an alternative rule', () => {
  const control = stat(30, 1, [1, 1], 1e-9)
  assert.equal(interpret(stat(3, 1, [1, 1], 0.04), ['holds', 'holds', 'holds']), 'insufficient data')
  assert.equal(interpret(stat(30, 0.5, [0.3, 0.7], 0.5), ['holds', 'holds', 'holds']), 'no fee ordering detected')
  assert.match(interpret(control, ['holds', 'holds', 'holds']), /^consistent with reward per requested cost/)
  const chance = interpret(control, ['holds', 'no stable order', 'holds'])
  assert.match(chance, /no stable order between C and B/)
  assert.doesNotMatch(chance, /base fee does not count/)
  assert.match(interpret(control, ['holds', 'reversed', 'holds']), /B before C: the base fee does not count/)
  assert.match(interpret(control, ['holds', 'holds', 'reversed']), /C before D: the whole base fee counts/)
  assert.match(interpret(control, ['inconclusive', 'holds', 'insufficient data']), /inconclusive: A,E before F; insufficient data: D before C$/)
})

test('a trial counts towards the quota only when every primary contrast can be read', () => {
  assert.equal(countsTowardsQuota(['A', 'B', 'C', 'D', 'F']), true)
  assert.equal(countsTowardsQuota(['E', 'B', 'C', 'D', 'F']), true)
  assert.equal(countsTowardsQuota(['A', 'E', 'B', 'C', 'D']), false)
  assert.equal(countsTowardsQuota(['B', 'C', 'D', 'F']), false)
})

test('one-sided sign flip over clusters', () => {
  assert.equal(signFlipUpperP([0.5, 0.5, 0.5, 0.5]), 1 / 16)
  assert.equal(signFlipUpperP([-0.5, -0.5]), 1)
  assert.equal(signFlipUpperP([0.5, -0.5]), 3 / 4)
})

test('version families only for source tags that were read', () => {
  assert.equal(versionFamily('Agave', '4.3.2'), 'Agave 4.3.2 (container-id ties)')
  assert.equal(versionFamily('JitoLabs', '4.3.2'), 'Agave 4.3.2 (container-id ties)')
  assert.equal(versionFamily('Agave', '4.4.0-beta.1'), 'Agave 4.4/4.5 pre-releases (oldest-first ties)')
  assert.equal(versionFamily('JitoLabs', '4.3.0'), 'other versions (source not read)')
  assert.equal(versionFamily('Firedancer', '26.10.3'), 'Firedancer 26.10.3-4 (treap ties)')
  assert.equal(versionFamily('Firedancer', '0.1.1'), 'other versions (source not read)')
  assert.equal(versionFamily('AgaveBam', '4.3.2'), 'pipelines (order set outside the client)')
})

test('a torn last JSONL line is skipped, a torn middle line is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-'))
  writeFileSync(join(dir, 'a.jsonl'), '{"a":1}\n{"a":2}\n{"a":')
  assert.deepEqual(readJsonl(join(dir, 'a.jsonl')), [{ a: 1 }, { a: 2 }])
  writeFileSync(join(dir, 'b.jsonl'), '{"a":1}\n{"a":\n{"a":3}\n')
  assert.throws(() => readJsonl(join(dir, 'b.jsonl')), /line 2/)
})

test('--live takes no ambiguous value', () => {
  assert.throws(() => parseArgs(['run', '--live=']), /takes no value/)
  assert.throws(() => parseArgs(['run', '--live=yes']), /takes no value/)
  assert.equal(parseArgs(['run', '--live=1']).flags.get('live'), true)
  assert.equal(parseArgs(['run', '--live=0']).flags.has('live'), false)
})

test('the sensitivity filter: no reconnect, an arrival margin of at least 100 ms, the firstShred clock', () => {
  const unit = (o: Partial<Unit>) => ({ reconnected: false, marginMs: 300, clockSource: 'firstShred', ...o }) as Unit
  assert.equal(keptBySensitivity(unit({})), true)
  assert.equal(keptBySensitivity(unit({ clockSource: null })), true)
  assert.equal(keptBySensitivity(unit({ reconnected: true })), false)
  assert.equal(keptBySensitivity(unit({ marginMs: 99 })), false)
  assert.equal(keptBySensitivity(unit({ marginMs: null })), false)
  assert.equal(keptBySensitivity(unit({ clockSource: 'slotSubscribe' })), false)
})

test('charts: text is escaped, bars are clamped, a zero draws no bar but keeps its label', () => {
  const svg = barChart({
    title: 'A <b> & "c"',
    subtitle: ['one line'],
    groups: [{ heading: 'g', bars: [{ label: 'zero', value: 0, text: '0 of 15' }, { label: 'over', value: 1.5, text: 'x' }] }],
    reference: { value: 0.5, label: 'chance' },
  })
  assert.match(svg, /A &lt;b&gt; &amp; &quot;c&quot;/)
  assert.equal((svg.match(/class="bar"/g) ?? []).length, 1)
  assert.match(svg, />0 of 15</)
  // clamped to the full plot width (400 px from x = 176), with the 4 px rounded end
  assert.match(svg, /H572A4 4 0 0 1 576 /)
})
