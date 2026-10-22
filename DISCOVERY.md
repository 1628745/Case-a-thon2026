# DISCOVERY (development weeks 4-21 only)

> **Team review:** written and acted on without waiting, as PLAN.md asks. The team can request a change to the chosen settings on Thursday; the held-out evaluation (120 retrains) is cheap to rerun. Numbers: mean MAE in minutes over dev weeks; "seed spread" = max - min across seeds 0-2. No held-out week was looked at before the freeze.

## 1. Reference is stable
Reference MAE 191.11 / 191.16 / 191.13 (seeds 0/1/2); largest weekly seed spread 0.64 min; miss rate 21.9%, promise width 336 min. Weekly MAE ranges 84-239 min (the multi-day tail dominates), so every comparison below is **paired by week** against reference, never against a raw level.

## 2. What actually poisons the promise: the sloppy source, not old data
| Evidence (Guard off unless stated) | MAE | vs reference |
| --- | --- | --- |
| reference (4-week window) | 191.1 | |
| low_quality (20% of couriers bulk-scan + re-upload) | 197.6 | **+6.5** (seed spread 1.6) |
| combined (low_quality + all-weeks window + frozen features) | 194.5 | +3.4 |
| stale (all-weeks window + frozen features) | 192.3 | +1.1 |
| control: frozen features only | 191.0 | -0.1 |
| control: frozen model (trained once on weeks 0-3) | 193.6 | +2.5 |
| dose: sloppy share 0 / 15 / 35 / 60% | 191.1 / 196.5 / 203.5 / 214.8 | monotonic |

- **Shelf life of data is long here.** Training window 1/2/4/8/16/all weeks: reference 193.8 / 192.0 / 191.1 / 190.8 / 190.8 / 190.8; low_quality 202.4 / 200.2 / 198.6 / 197.2 / 196.2 / 196.0. No U-curve: more past data never hurt, and it *dilutes* a recent sloppy source (which is why combined is less damaged than low_quality). Frozen features cost nothing; what decays is the *model*: one never retrained loses 2.5 min.
- **More information hurts when it comes from an unreliable source.** Damage grows with the share of sloppy couriers and with their bulk-scan rate over the weeks.

## 3. Where the damage enters the chain (first dev week a link departs from reference by > 3x the reference's seed spread)
| Link | low_quality | combined | stale |
| --- | --- | --- | --- |
| Data: injected share of training rows | week 5 | 5 | n/a |
| Data: history-feature age | n/a | 8 | 8 |
| Training signal: KS(labels, truth), label median (+12.5 min mean) | 5 | 5 | 5 (median only, -0.9 min) |
| Model: probe-grid P80 shift (+14.5 min mean) | 5 | 5 | 5 |
| Decision: promise width / miss rate | 5 | 5 | 6 / 9 |
| Decision: MAE | 8 | 9 | 11 |

The sloppy feed moves every link in **week 5**, the first week its rows enter training: inflated labels (bulk scans push delivery to the end of the shift) → a model that predicts longer → wider promises, fewer misses, worse MAE once the dose grows (MAE crosses the threshold in week 8). Failure atlas (Guard off vs reference, same packages): the low_quality gap is concentrated in same-day packages (<= 24 h: +8.3 min) and early-morning acceptances (+11.3 min before 10:00), in common and rare area types alike. By courier: **the sloppy couriers' own packages carry a +40.3 min gap** (16.5% of packages: their inflated history features push their predictions up), while other couriers' packages lose only +1.0 min through the shared model. In combined the sloppy couriers' gap is +16.5 min (the frozen feature store stopped absorbing their inflated durations in late June). The stale gap sits almost entirely in the > 24 h tail (+36 min on 3% of packages).

## 4. Matching mechanisms to Guard layers (default Guard, pass 1)
- **L1 ingest checks** catch the sloppy source almost exactly: detector precision 0.93 (low_quality) / 0.91 (combined), FPR 0.8% / 0.6%. The oracle filter (drop exactly the injected rows) reaches 192.4; the default Guard 192.6; **random removal of the same volume 198.9** (worse than doing nothing): it is *which* rows, not how many.
- **Guard with the default settings recovered 81% of the low_quality gap but made combined worse (-37%) and stale worse (+3.3 min).** The cause is L2's rule "history features older than 7 days -> NaN": stale history is still informative (frozen-features control = reference), so dropping it throws signal away.
- **Deferral** at k = 2 was 17-18% (area rule 3%, interval-width rule the rest): over budget.

## 5. Tuning sweep (one sweep, 12 configs x {reference, low_quality, combined}, seed 0)
Staleness response {drop after 7 d, keep} x h {4, inf} x lambda {0, 0.5, 1}; k read from each run's deferral-at-k. Recovery (low_quality / combined) and deferral at k = 4:

| Config | Recovery LQ | Recovery combined | Reference MAE (no harm) | Scorecard |
| --- | --- | --- | --- | --- |
| drop, h4, lambda 1 (PLAN default) | 80% | -28% | +0.30% | 5/7 |
| drop, any h, lambda | 80-88% | -13% to -53% | +0.15-0.33% | 5/7 |
| keep, h inf, lambda 0 / 0.5 / 1 | 85 / 85 / 80% | 50 / 47 / 37% | +0.2-0.3% | 5/7 |
| keep, h4, lambda 0 | 88% | 76% | +0.15% | 6/7 |
| **keep, h4, lambda 0.5 (chosen)** | **87%** | **74%** | **+0.15%** | **6/7** |
| keep, h4, lambda 1 | 80% | 60% | +0.30% | 6/7 |

## 6. Chosen settings (frozen as `guard-v1-frozen`)
- **Keep stale history** (no 7-day drop, no per-package deferral on feature age; a system-level feature-store alert fires instead when mean feature age exceeds 7 days).
- **h = 4** weeks (h = inf lost 1.0 min on combined).
- **lambda = 0.5**: statistically tied with lambda = 0 on dev weeks (0.1 min apart, inside the seed spread) and keeps the reputation layer, the only Guard defence against defects that leave no burst or duplicate trace (L1 cannot see them). lambda = 1 is measurably worse (0.6 min on low_quality, above the 0.33 seed spread).
- **k = 4**: the smallest tested value that keeps deferral within 10% (k = 3: 10.6% on reference). PLAN listed k in {1.5, 2, 3}; we extended it because the budget is the binding constraint.

**Main family rerun with the chosen settings (3 seeds, dev weeks):**

| Condition | MAE off | MAE on | Recovered | Miss on | Width off / on | Deferral | Rare-area MAE on vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| reference | 191.13 | 191.38 | (no harm: +0.13%) | 20.0% | 336 / 350 | 7.7% | +0.7% |
| stale | 192.27 | 191.78 | 42% | 20.0% | 332 / 350 | 5.9% | |
| low_quality | 197.62 | 191.97 | **87%** | 19.3% | 366 / 358 | 7.6% | +0.9% |
| combined | 194.55 | 192.00 | **74%** | 19.3% | 354 / 356 | 5.8% | +1.7% |

Guard-on seed spreads are 0.03-0.20 min, so every recovery above is far outside seed noise. Dose-response with the Guard: sloppy share 0 / 15 / 35 / 60% -> 191.4 / 191.9 / 192.4 / 193.2 (Guard off 191.1 / 196.5 / 203.5 / 214.8). **Scorecard on dev weeks: 6 of 7 lines pass; Promise quality fails** (see below).

## 7. Rejected settings and what failed
- **Drop stale history (PLAN default):** fails combined recovery in every variant.
- **h = inf:** under-weights recent weeks; combined recovery 37-50%.
- **lambda = 1:** over-penalises honest couriers whose areas differ from peers; costs 0.5-0.6 min.
- **k <= 3:** over the deferral budget.
- **Still failing: Promise quality.** The conformal P80 brings every condition's miss rate to about 19-20%, but in reference and stale it needs *wider* promises than the unguarded model (which already misses 21.9%, inside the 17-23% band): reference width 350 vs 336 min. The line fails by our strict reading (every condition, width no larger than Guard off). We report it rather than loosen the target.
- **Untested here:** the GPS-age checks (GPS fix age is 0 in every row of this data).
