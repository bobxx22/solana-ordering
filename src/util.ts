import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
export const toJson = (v: unknown, indent?: number) => JSON.stringify(v, replacer, indent)

export function appendJsonl(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, toJson(row) + '\n')
}

export function readJsonl<T = any>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Deterministic PRNG (mulberry32) so that a run's random choices can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
