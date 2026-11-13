# Polymarket NVIDIA CEO forecast — entry

Forecasts, minute by minute and 4 hours ahead, the Yes price of every trading
market of Polymarket's "Next CEO of NVIDIA?" event, as five quantiles
(0.05, 0.25, 0.5, 0.75, 0.95) per minute. Entry for make.fun bounty
`polymarket-nvidia-ceo-forecast-01`.

## How to run

Requires Node 22+ (standard library only, no dependencies, no network):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The program reads every `<id>.in` in the input directory and writes
`<id>.out` (`{"forecasts":[{"id","q"}]}`) to the output directory. It runs
one case in ~0.05 s (cap is 8 s) and is fully deterministic — two runs write
identical bytes.

## How it works

1. **Median = last price.** On this event the price is a near-martingale at
   4-hour horizons: on the six practice cases, every smoothing, drift
   extrapolation and mean-reversion rule tested was strictly worse than the
   last tick (a 30-minute EWMA was ~48% worse on mean absolute error).
2. **Joint sum-to-1 constraint.** The 24 Yes prices are probabilities of
   mutually exclusive outcomes, so their medians should sum to ~1. The
   book's midpoints do not (practice sums ran 0.81–1.09), partly real signal
   and partly spread noise, so each median is moved halfway toward the
   renormalization.
3. **Per-market adaptive spread (v3: EWMA).** Each market's core sigma is
   the recency-weighted (EWMA, half-life 60 min) RMS of its own 1-minute
   price changes, ignoring jumps (|move| > 0.02), times 0.8, floored at
   0.0003/min. Recent volatility predicts the next 4h better than a flat
   240-minute window. Quiet markets get narrow bands; jumpy ones get wide
   bands. The house baseline's single 0.0025 sigma for every market wastes
   most of its loss on quiet minutes.
4. **Horizon growth.** The spread widens like sqrt(h) plus a small term
   linear in h for jump risk, which accumulates linearly with the horizon.
5. **Shape (v3: peaked).** Normal quantiles, except the interquartile
   z-values are narrowed 0.7x and the 5% (downside) tail is widened 1.3x.
   Calibration diagnostics showed the middle band too wide — the realized
   interquartile range held 65% of outcomes against a 50% target, while
   the 90% interval was about right — so the shape is more peaked than
   normal. All quantiles are clamped to [0, 1], rounded to 6 decimals, and
   forced non-decreasing. The median is additionally shrunk by 0.995, a
   calibration fix: the v2 median's empirical coverage was 0.41 against a
   0.50 target.

## Practice results (6 sealed cases, scored on the 240 minutes after each)

Ground truth for cases p00–p04 taken from the following case's price history
(the practice answers are not shipped in the kit); p05 has no following case
in the kit, so it is checked for validity and runtime only.

| case | v3 (this entry) | v2 | house baseline |
|------|-----------|----------------|----------------|
| p00  | 0.4244    | 0.4186 | 0.5361         |
| p01  | 0.3076    | 0.3083 | 0.3804         |
| p02  | 0.3496    | 0.3464 | 0.4084         |
| p03  | 0.2570    | 0.2834 | 0.3686         |
| p04  | 0.2086    | 0.2099 | 0.2988         |
| **mean (p00–p04)** | **0.3026** | **0.3072** | **0.3925** |

Mean pinball loss ×100 (percentage points), lower is better. v3 beats the
house baseline on every practice case, by ~23% overall, and beats v2 by
0.0046 (-1.5%) overall. Median error 0.59–1.27 points; 90% coverage
0.83–0.97.

## Revision pass (2026-11-13)

29 parameter variants were tested on the same 5-case practice score
(window, tails, floor, renorm, jump term, sigma multiplier, alpha).
None was adopted: the best combo (sigma multiplier 0.75 + upside tail
1.15) scored 0.3059 vs the 0.3069 prototype baseline, a 0.001 gain under
1 standard error of the 5-case deltas, with mixed per-case signs —
noise-level fitting on 5 cases. The practice score is unchanged at
**0.3072** vs house 0.3925, and a line-by-line code review found no bugs.

## v3 — improvement pass (2026-11-13 ~22:30 WIB, after the live board
showed v2 at #968 with pinball 0.2748 against a 0.213 top)

Diagnostics first: per-tau coverage showed the v2 middle band too wide
(realized IQR held 65% vs a 50% target) while the 90% interval was about
right; the median's coverage was 0.41 vs 0.50; the top-3 leader markets
carry 38% of all loss and their realized volatility is poorly tracked by
a flat 240-minute RMS (realized/predicted sigma median 0.74, p25 0.35,
p75 1.30). Three changes, each validated separately and combined:

1. Interquartile z-values narrowed 0.7x (peaked shape) — alone -0.0028.
2. EWMA sigma, half-life 60 min, replacing the flat 240-min RMS — alone
   -0.0014 (longer half-lives were worse).
3. Median shrunk by 0.995 (median-coverage fix) — alone -0.0010.

Combined: **0.3026** vs v2 **0.3072** on the same 5 cases (-0.0046,
-1.5%; Node entry, verified with `work/evaluate.py`). About 50 further
variants were tested and rejected: sigma shrinkage to pooled, MAD sigma,
sigma caps, conditional drift, logit-normal quantiles, jump-cluster
spreads, vol-trend ratios, OU saturation, Student-t tails, empirical
quantiles, long-run vol blends — all flat or worse. Honest caveats: the
gain is small and concentrated in p03 (p00 and p02 get slightly worse,
wins 3/5); the mean per-case delta is 0.64 standard errors, so it is not
statistically significant on 5 cases, and dropping p03 flips the sign.
v3 is submitted as an ADDITIONAL entry because the account's best entry
is what counts — it has a better-than-even chance of beating v2 on the
12 fresh final cases. It does not replace v2.

## Files

- `main.ts` — the entry program (Node 22, stdlib only)
- `LICENSE` — MIT
- `README.md` — this file
