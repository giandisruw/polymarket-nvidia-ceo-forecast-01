// Polymarket "Next CEO of NVIDIA?" 4-hour-ahead quantile forecaster.
//
// Model (own design, fitted only on the shape of the practice history, not on
// any single outcome):
//   * Median: the market's last price. On this event the price is a near-
//     martingale at 4h horizons: every smoothing, drift extrapolation and
//     mean-reversion rule we tested on the practice cases was strictly worse
//     than the last tick (EWMA-30 was ~48% worse on mean |error|), so the
//     median stays at the last price.
//   * Joint constraint: the 24 Yes prices are probabilities of mutually
//     exclusive outcomes, so their medians should sum to ~1. The book's
//     midpoints do not (practice sums ran 0.81-1.09), partly real signal and
//     partly spread noise, so each median is moved HALFWAY toward the
//     sum-to-1 renormalization: median_i = x_i * (0.5 + 0.5 / S), S = sum x.
//   * Spread: per-market, from the market's own recent 1-minute moves. For
//     each market, sigma is the RMS of its 1-minute price changes over the
//     last 240 minutes, ignoring jumps (|d| > 0.02, which belong to the tail,
//     not the core), times 0.8, floored at 0.0003/min. Quiet markets get
//     narrow bands, jumpy ones wide bands; the house baseline's one-size
//     0.0025 for every market wastes most of its loss on quiet minutes.
//   * Growth: the spread widens like sqrt(h) (a random walk's), plus a small
//     term linear in h for jump risk, which accumulates linearly with the
//     horizon: spread(h) = sqrt((0.8*sigma*sqrt(h))^2 + (2e-5*h)^2).
//   * Shape: normal quantiles, except the 5% (downside) tail is widened 1.3x:
//     on the practice data downside jumps were the more expensive misses.
//   * Everything is clamped to [0,1], rounded to 6 decimals, and made
//     non-decreasing; the program is deterministic (no randomness, no clock),
//     stdlib only, and runs a case in well under a second.
//
// Revision pass 2026-11-13: 29 parameter variants were tested on the same
// 5-case practice score (window, tails, floor, renorm, jump term, sigma
// multiplier, alpha). The best combo (sigma mult 0.75 + upside tail 1.15)
// scored 0.3059 vs the 0.3069 prototype baseline but was NOT adopted: the
// 0.001 gain is under 1 standard error of the 5-case deltas, with mixed
// per-case signs — noise-level fitting on 5 cases. Parameters stay at
// their robust values; a line-by-line review also found no bugs.
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
/** Standard normal quantiles at those levels; the 5% tail is widened 1.3x. */
const Z = [-1.644854 * 1.3, -0.67449, 0, 0.67449, 1.644854];

/** Minutes of recent history used for the per-market sigma. */
const SIGMA_WINDOW_MIN = 240;
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
 * A market's per-minute core sigma: RMS of its recent 1-minute changes,
 * ignoring jumps. Falls back to the floor when there is too little history.
 */
function coreSigma(prices: number[]): number {
  const n = prices.length;
  if (n < 2) return SIGMA_FLOOR;
  const start = Math.max(0, n - 1 - SIGMA_WINDOW_MIN);
  let sumSq = 0;
  let count = 0;
  for (let i = start + 1; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    if (Math.abs(d) <= JUMP_CUT) {
      sumSq += d * d;
      count++;
    }
  }
  if (count < 10) return SIGMA_FLOOR;
  return Math.max(SIGMA_FLOOR, SIGMA_MULT * Math.sqrt(sumSq / count));
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
  // Medians: last price, moved halfway toward the sum-to-1 renormalization.
  const lasts = c.markets.map((m) => (m.prices.length > 0 ? m.prices[m.prices.length - 1] : 0.5));
  const sum = lasts.reduce((a, b) => a + b, 0);
  const factor = sum > 0 ? 1 - RENORM + RENORM / sum : 1;
  const forecasts = c.markets.map((m, i) => ({
    id: m.id,
    q: forecast(lasts[i] * factor, coreSigma(m.prices), c.horizon_minutes),
  }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
