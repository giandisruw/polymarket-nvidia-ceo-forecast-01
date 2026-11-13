// Polymarket "Next CEO of NVIDIA?" 4-hour-ahead quantile forecaster — v3.
//
// Model (own design, fitted only on the shape of the practice history, not on
// any single outcome):
//   * Median: the market's last price, moved halfway toward the sum-to-1
//     renormalization (the 24 Yes prices are probabilities of mutually
//     exclusive outcomes; practice sums ran 0.81-1.09), then shrunk by
//     0.995. On this event the price is a near-martingale at 4h horizons:
//     every smoothing, drift extrapolation and mean-reversion rule we tested
//     on the practice cases was strictly worse than the last tick (EWMA-30
//     was ~48% worse on mean |error|; conditional drift extrapolation was
//     also worse on every variant). The 0.995 shrink is a calibration fix:
//     the v2 median's empirical coverage was 0.41 against a 0.50 target
//     (prices land below the forecast median less often than half the time),
//     i.e. the median sat slightly high.
//   * Spread: per-market, from the market's own recent 1-minute moves. v3
//     replaces v2's flat 240-minute RMS with a recency-weighted (EWMA,
//     half-life 60 min) RMS of 1-minute changes, ignoring jumps
//     (|d| > 0.02, which belong to the tail, not the core), times 0.8,
//     floored at 0.0003/min. Recent volatility predicts the next 4h better
//     than a flat 240-minute window (EWMA-60 beat flat RMS on the practice
//     score; longer half-lives were worse).
//   * Growth: the spread widens like sqrt(h) (a random walk's), plus a small
//     term linear in h for jump risk, which accumulates linearly with the
//     horizon: spread(h) = sqrt((0.8*sigma*sqrt(h))^2 + (2e-5*h)^2).
//   * Shape: normal quantiles, except the interquartile z-values are
//     narrowed 0.7x and the 5% (downside) tail is widened 1.3x. Calibration
//     diagnostics on v2 showed the middle band too wide — the realized
//     interquartile range held 65% of outcomes against a 50% target, while
//     the 90% interval was about right (88% vs 90%) — so the shape is more
//     peaked than normal: narrower IQR, same tails.
//   * Everything is clamped to [0,1], rounded to 6 decimals, and made
//     non-decreasing; the program is deterministic (no randomness, no clock),
//     stdlib only, and runs a case in well under a second.
//
// v3 evidence (practice, 5 cases p00-p04, mean pinball loss x100):
//   v2 (shipped): 0.3072 overall (prototype 0.3069). v3: 0.3025 prototype.
//   The three changes together gain -0.0044 (-1.4%): IQR 0.7x alone -0.0028,
//   EWMA-60 alone -0.0014, median x0.995 alone -0.0010; combined -0.0044.
//   HONEST CAVEATS: the gain is small and concentrated in one case (p03
//   carries most of it; p00 and p02 get slightly worse, wins 3/5). The
//   mean per-case delta is 0.64 standard errors — not statistically
//   significant on 5 cases, and dropping p03 flips the sign. About 50
//   other variants were tested and rejected (sigma shrinkage to pooled,
//   MAD sigma, sigma caps, conditional drift, logit-normal quantiles,
//   jump-cluster spreads, vol-trend ratios, OU saturation, Student-t
//   tails, empirical quantiles — all flat or worse). v3 is shipped as an
//   ADDITIONAL entry because the account's best entry is what counts: it
//   has a better-than-even chance of beating v2 on the 12 fresh final
//   cases, and costs one submit slot. It does not replace v2.
//
// Input/output contract (program/v1): read every <id>.in in the input dir
// (MAKEFUN_INPUT_DIR, default /input), write <id>.out to the output dir
// (MAKEFUN_OUTPUT_DIR, default /output) as {"forecasts":[{"id","q"}]}, q
// exactly horizon_minutes rows of the five quantiles [0.05, 0.25, 0.5, 0.75,
// 0.95], one finite number in [0,1] per level, non-decreasing per row.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Interquartile z-values narrowed 0.7x (v3: peaked shape, see header). */
const IQR_K = 0.7;
/** Standard normal quantiles at those levels; the 5% tail is widened 1.3x. */
const Z = [-1.644854 * 1.3, -0.67449 * IQR_K, 0, 0.67449 * IQR_K, 1.644854];

/** Half-life (minutes) of the EWMA weights in the per-market sigma. */
const SIGMA_HALF_LIFE_MIN = 60;
/** |1-min move| above this counts as a jump: excluded from the core sigma. */
const JUMP_CUT = 0.02;
/** Core-sigma multiplier (calibrated on practice: 0.8 beats 1.0 and 0.7). */
const SIGMA_MULT = 0.8;
/** Floor on the per-minute core sigma, for markets that barely ever move. */
const SIGMA_FLOOR = 0.0003;
/** Extra spread per minute of horizon, for jump risk (linear in h). */
const JUMP_PER_MIN = 0.00002;
/** How far the medians move toward summing to 1 (0 = no renorm, 1 = full). */
const RENORM = 0.5;
/** Median shrink (v3: calibration fix for median coverage 0.41 vs 0.50). */
const MEDIAN_SHRINK = 0.995;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/**
 * A market's per-minute core sigma: recency-weighted (EWMA, half-life 60
 * min) RMS of its 1-minute changes, ignoring jumps. Falls back to the floor
 * when there is too little usable history.
 */
function coreSigma(prices: number[]): number {
  const n = prices.length;
  if (n < 2) return SIGMA_FLOOR;
  const dCount = n - 1;
  // EWMA decay: a = 1 - 0.5^(1/half-life); the most recent diff has weight 1.
  const a = 1 - Math.pow(0.5, 1 / SIGMA_HALF_LIFE_MIN);
  const decay = 1 - a;
  let sumW = 0;
  let sumWD2 = 0;
  for (let i = 0; i < dCount; i++) {
    const d = prices[i + 1] - prices[i];
    if (Math.abs(d) > JUMP_CUT) continue;
    // Weight of diff i: decay^(dCount - 1 - i); newest diff (i = dCount-1) = 1.
    const w = Math.pow(decay, dCount - 1 - i);
    sumW += w;
    sumWD2 += w * d * d;
  }
  if (sumW < 10) return SIGMA_FLOOR;
  return Math.max(SIGMA_FLOOR, SIGMA_MULT * Math.sqrt(sumWD2 / sumW));
}

/** The forecast rows for one market: horizon rows of the five quantiles. */
function forecast(median: number, sigma: number, horizon: number): number[][] {
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const spread = Math.sqrt((sigma * Math.sqrt(h)) ** 2 + (JUMP_PER_MIN * h) ** 2);
    const row = Z.map((z) => price6(median + z * spread));
    // Guarantee non-decreasing even after rounding/clamping.
    for (let j = 1; j < row.length; j++) {
      if (row[j] < row[j - 1]) row[j] = row[j - 1];
    }
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  }
  // Medians: last price, moved halfway toward the sum-to-1 renormalization,
  // then shrunk by 0.995 (v3 calibration fix).
  const lasts = c.markets.map((m) => (m.prices.length > 0 ? m.prices[m.prices.length - 1] : 0.5));
  const sum = lasts.reduce((a, b) => a + b, 0);
  const factor = sum > 0 ? 1 - RENORM + RENORM / sum : 1;
  const forecasts = c.markets.map((m, i) => ({
    id: m.id,
    q: forecast(lasts[i] * factor * MEDIAN_SHRINK, coreSigma(m.prices), c.horizon_minutes),
  }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
