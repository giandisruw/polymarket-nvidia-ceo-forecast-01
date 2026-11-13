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
3. **Per-market adaptive spread.** Each market's core sigma is the RMS of
   its own 1-minute price changes over the last 240 minutes, ignoring jumps
   (|move| > 0.02), times 0.8, floored at 0.0003/min. Quiet markets get
   narrow bands; jumpy ones get wide bands. The house baseline's single
   0.0025 sigma for every market wastes most of its loss on quiet minutes.
4. **Horizon growth.** The spread widens like sqrt(h) plus a small term
   linear in h for jump risk, which accumulates linearly with the horizon.
5. **Shape.** Normal quantiles, except the 5% (downside) tail is widened
   1.3x — downside jumps were the more expensive misses on the practice
   data. All quantiles are clamped to [0, 1], rounded to 6 decimals, and
   forced non-decreasing.

## Practice results (6 sealed cases, scored on the 240 minutes after each)

Ground truth for cases p00–p04 taken from the following case's price history
(the practice answers are not shipped in the kit); p05 has no following case
in the kit, so it is checked for validity and runtime only.

| case | this entry | house baseline |
|------|-----------|----------------|
| p00  | 0.4186    | 0.5361         |
| p01  | 0.3083    | 0.3804         |
| p02  | 0.3464    | 0.4084         |
| p03  | 0.2834    | 0.3686         |
| p04  | 0.2099    | 0.2988         |
| **mean (p00–p04)** | **0.3072** | **0.3925** |

Mean pinball loss ×100 (percentage points), lower is better. This entry beats
the house baseline on every practice case, by ~22% overall. The house
baseline scores 0.3636 on all six practice cases per the competition spec;
the five-case figure here (0.3925) is the same program scored on p00–p04
only. Median error 0.59–1.29 points; 90% coverage 0.83–0.98.

## Files

- `main.ts` — the entry program (Node 22, stdlib only)
- `LICENSE` — MIT
- `README.md` — this file
