// Small, dependency-free statistics used by the analysis. All randomness is seeded so results are reproducible.
import { rng } from './util.ts'

/** Kendall's tau-b between two equally long series; null when either series is constant. */
export function kendallTau(x: number[], y: number[]): number | null {
  let concordant = 0
  let discordant = 0
  let tiesX = 0
  let tiesY = 0
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = Math.sign(x[i] - x[j])
      const dy = Math.sign(y[i] - y[j])
      if (dx === 0 && dy === 0) continue
      if (dx === 0) tiesX++
      else if (dy === 0) tiesY++
      else if (dx === dy) concordant++
      else discordant++
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY))
  return denom === 0 ? null : (concordant - discordant) / denom
}

/** Spearman's rank correlation (average ranks for ties); null for fewer than 3 points or a constant series. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3) return null
  const rx = ranks(x)
  const ry = ranks(y)
  const mx = mean(rx)
  const my = mean(ry)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my)
    sxx += (rx[i] - mx) ** 2
    syy += (ry[i] - my) ** 2
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy)
}

function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const r = new Array<number>(v.length)
  for (let i = 0; i < idx.length; ) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1
    i = j + 1
  }
  return r
}

export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)

export function median(v: number[]): number {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The q-quantile, interpolating linearly between order statistics; quantile(v, 0.5) is the median. */
export function quantile(v: number[], q: number): number {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

/** Wilson score interval for k successes out of n (95 %). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [NaN, NaN]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [c - h, c + h]
}

/** Percentile bootstrap 95 % interval of the mean. */
export function bootstrapMeanCi(v: number[], seed = 1, iterations = 4000): [number, number] {
  if (v.length < 2) return [NaN, NaN]
  const random = rng(seed)
  const means: number[] = []
  for (let b = 0; b < iterations; b++) {
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[Math.floor(random() * v.length)]
    means.push(s / v.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(0.025 * iterations)], means[Math.floor(0.975 * iterations)]]
}

/**
 * Two-sided sign-flip permutation test of mean(v) = 0. Valid when, under the null, each value is symmetric around
 * zero: a trial's tau is, if its transactions' order inside the block is unrelated to the predictor.
 * Exact for up to 16 values, Monte Carlo (seeded) above that.
 */
export function signFlipP(v: number[], seed = 1, iterations = 20_000): number {
  if (v.length === 0) return NaN
  const observed = Math.abs(v.reduce((a, b) => a + b, 0))
  let extreme = 0
  let total = 0
  const eps = 1e-12
  if (v.length <= 16) {
    for (let mask = 0; mask < 1 << v.length; mask++) {
      let s = 0
      for (let i = 0; i < v.length; i++) s += mask & (1 << i) ? -v[i] : v[i]
      if (Math.abs(s) >= observed - eps) extreme++
      total++
    }
  } else {
    const random = rng(seed)
    for (let b = 0; b < iterations; b++) {
      let s = 0
      for (const x of v) s += random() < 0.5 ? -x : x
      if (Math.abs(s) >= observed - eps) extreme++
      total++
    }
    extreme++ // count the observed assignment itself
    total++
  }
  return extreme / total
}

/**
 * One-sided sign-flip test of mean(v) > 0: the share of sign assignments whose sum is at least the observed one.
 * Used on cluster means (validators, hosts) of a per-trial share minus 0.5. Exact for up to 16 values, seeded Monte
 * Carlo above that; with k values the smallest possible p is 2^-k.
 */
export function signFlipUpperP(v: number[], seed = 1, iterations = 20_000): number {
  if (v.length === 0) return NaN
  const observed = v.reduce((a, b) => a + b, 0)
  const eps = 1e-12
  let extreme = 0
  let total = 0
  if (v.length <= 16) {
    for (let mask = 0; mask < 1 << v.length; mask++) {
      let s = 0
      for (let i = 0; i < v.length; i++) s += mask & (1 << i) ? -v[i] : v[i]
      if (s >= observed - eps) extreme++
      total++
    }
    return extreme / total
  }
  const random = rng(seed)
  for (let b = 0; b < iterations; b++) {
    let s = 0
    for (const x of v) s += random() < 0.5 ? -x : x
    if (s >= observed - eps) extreme++
    total++
  }
  return (extreme + 1) / (total + 1)
}

/** Two-sided exact binomial test of p = 0.5. */
export function binomialP(k: number, n: number): number {
  if (n === 0) return NaN
  const pmf = (i: number) => Math.exp(lnChoose(n, i) - n * Math.LN2)
  const pk = pmf(k)
  let p = 0
  for (let i = 0; i <= n; i++) if (pmf(i) <= pk * (1 + 1e-9)) p += pmf(i)
  return Math.min(1, p)
}

/** Exact lower tail P(X <= k) of X ~ Binomial(n, p). */
export function binomialLowerTail(k: number, n: number, p: number): number {
  let s = 0
  for (let i = 0; i <= Math.min(k, n); i++) s += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))
  return Math.min(1, s)
}

function lnChoose(n: number, k: number): number {
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i)
  return s
}

/**
 * Exact upper tail P(S >= observed) of a sum of independent integer-valued variables, each given by its probability
 * table (index = value). Used for contrasts whose per-trial null distribution is known exactly: a single pair is 0 or
 * 2 (half units) with probability 1/2 each; "A and E both before F" is 0, 1 or 2 with probability 1/3 each.
 */
export function exactUpperTail(tables: number[][], observed: number): number {
  let dist = [1]
  for (const t of tables) {
    const next = new Array<number>(dist.length + t.length - 1).fill(0)
    for (let i = 0; i < dist.length; i++) for (let j = 0; j < t.length; j++) next[i + j] += dist[i] * t[j]
    dist = next
  }
  let p = 0
  for (let s = Math.max(0, Math.ceil(observed - 1e-9)); s < dist.length; s++) p += dist[s]
  return Math.min(1, p)
}

/** Pearson correlation; null for fewer than 3 points or a constant series. */
export function pearson(x: number[], y: number[]): number | null {
  if (x.length < 3) return null
  const mx = mean(x)
  const my = mean(y)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
    syy += (y[i] - my) ** 2
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy)
}
