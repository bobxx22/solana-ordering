import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { answerRows, answerRowText, burstFates, SAME_ROLES_CAMPAIGNS } from '../src/answers.ts'
import type { Unit } from '../src/analyze.ts'

const unit = (leader: string, client: string, observedOrder: string, version = '4.3.2', campaign = 'main'): Unit => ({ run: 'r', trial: 0, campaign, client, leader, version, path: 'tpu', delivery: 'buffered', mode: 'shared', observedOrder }) as Unit
const many = (n: number, u: Unit) => Array.from({ length: n }, () => u)
const name = () => 'A name'
const rank = (id: string) => (id === 'big' ? 1 : 50)

test('one row per validator and reported client, what departs from the source first', () => {
  const rows = answerRows(
    [
      ...many(6, unit('big', 'JitoLabs', 'AEDCFB')),
      ...many(6, unit('moved', 'JitoLabs', 'BDAEFC')),
      ...many(5, unit('moved', 'HarmonicAgave', 'AEDCBF')),
      ...many(3, unit('mix', 'Agave', 'AEDCFB')),
      ...many(3, unit('mix', 'Agave', 'BDAEFC')),
    ],
    name,
    rank,
  )
  assert.deepEqual(
    rows.map((r) => [r.leader, r.client, r.reading]),
    [
      ['moved', 'JitoLabs', 'total fee'],
      ['moved', 'HarmonicAgave', 'F last'],
      ['mix', 'Agave', 'mixed'],
      ['big', 'JitoLabs', 'reward/cost'],
    ],
  )
})

test('only the same six roles, the primary cell and all six in the window count', () => {
  assert.ok(!SAME_ROLES_CAMPAIGNS.includes('rakurai-swap'))
  const rows = answerRows(
    [
      unit('v', 'Agave', 'AEDCFB'),
      unit('v', 'Agave', 'AEDCFB', '4.3.2', 'rakurai-swap'),
      unit('v', 'Agave', 'AEDCF'),
      { ...unit('v', 'Agave', 'AEDCFB'), mode: 'independent' },
      { ...unit('v', 'Agave', 'AEDCFB'), delivery: 'streamed' },
      { ...unit('v', 'Agave', 'AEDCFB'), delivery: 'buffered@-1' },
      { ...unit('v', 'Agave', 'AEDCFB'), path: 'rpc' },
    ],
    name,
    rank,
  )
  assert.equal(rows[0].n, 1)
})

test('a row in words: the share and its interval, or the counts when no order leads', () => {
  const [row] = answerRows(many(19, unit('EvnRmnMrd69k', 'JitoLabs', 'BDAEFC')), () => 'Everstake', () => 8)
  assert.equal(answerRowText(row), '| 8 | `EvnRmnMr` | Everstake | JitoLabs 4.3.2 | **total fee** | 19 of 19 | 83–100% |')
  const [mixed] = answerRows([...many(3, unit('mixedmixed', 'Agave', 'AEDCFB')), ...many(3, unit('mixedmixed', 'Agave', 'AEDBCF')), ...many(2, unit('mixedmixed', 'Agave', 'FEDCBA'))], () => '–', () => Infinity)
  assert.equal(answerRowText(mixed), '| – | `mixedmix` | – | Agave 4.3.2 | **no single order** | 3 reward/cost, 0 total fee, 3 F last, 2 other, of 8 | – |')
})

test('what became of a burst: every case, and a burst that lost one transaction is split', () => {
  const cases: [number, number][] = [
    [6, 6], // all in the window
    [0, 6], // all landed outside it
    [0, 0], // none landed
    [5, 5], // one lost
    [3, 6], // the window split it
    [0, 4], // some landed outside, some lost
  ]
  const trials = cases.map((_, i) => ({ run: 'r', trial: i }))
  assert.deepEqual(
    burstFates(
      trials,
      (t) => cases[t.trial][0],
      (t) => cases[t.trial][1],
    ),
    { trials: 6, allInWindow: 1, allOutside: 1, noneLanded: 1, split: 3 },
  )
})

// README is not in the Docker image, so this runs in the repository only
test('README copies the table of "Every validator with a reading" unchanged', { skip: !existsSync('README.md') }, () => {
  const results = readFileSync('data/mainnet-beta/results/results.md', 'utf8')
  const start = results.indexOf('## Every validator with a reading')
  const section = results.slice(start, results.indexOf('\n## ', start + 1))
  const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| rank'))
  assert.ok(rows.length >= 18)
  const readme = readFileSync('README.md', 'utf8')
  for (const r of rows) assert.ok(readme.includes(r), `README has no row: ${r}`)
})
