# DECISIONS

Every judgment call made during the autonomous build: what, why, alternatives.

## Step 0: environment
- **git binary.** `/usr/bin/git` refuses to run (Xcode license not accepted; accepting needs `sudo`, which is off-limits). All git commands use `DEVELOPER_DIR=/Library/Developer/CommandLineTools` so the Command Line Tools git (2.39.5) is used. No global config changed. Alternative (accept the Xcode license) needs sudo.
- **Python.** System `python3` 3.13.5 in `.venv`; LightGBM 4.7.0 imported without needing libomp/conda, so no fallback was needed.
- **Repo visibility.** `api.github.com/repos/1628745/Case-a-thon2026` returns 200 (public), so GitHub Pages can serve `/docs` from `main`. `gh` is authenticated.

## Step 1: audit (results/audit.json, results/audit_yt.json)
- **Time format.** `accept_time`, `accept_gps_time`, `delivery_time`, `delivery_gps_time` are `MM-DD HH:MM:SS` with no year. We prepend 2022. `ds` (MMDD) equals the parsed accept date for 99.9986% of Chongqing rows, confirming the parse. 0 unparseable values.
- **Coverage.** Chongqing: 931,351 rows (PLAN said "roughly 1M"); accept dates 2022-05-01 to 2022-12-08. All 26 weeks 0-25 present; 22,043 rows outside weeks 0-25 (Oct 30 onward, plus 2 stray December rows) are dropped. Weekly volume 21k-37k in weeks 0-22, then a ramp: week 23 = 53.9k, 24 = 74.0k, 25 = 86.7k (held-out block; a real regime change on top of Golden Week).
- **Observed (pre-existing) issues, Chongqing:** duration <= 0: 4,853 rows (dropped, per PLAN); duration > 12 h: 48,584 (kept); > 24 h: 31,231 (kept); same-minute bursts of >= 5 packages per courier: **0**; missing GPS: 0; **GPS fix age is exactly 0 for every row**; courier-to-stop distance > 30 km: 2,384; duplicate order ids: 0. Duration median 151 min, P90 488 min, P99 3,333 min (heavy tail of next-day deliveries).
- **Consequence: GPS-age checks are inert.** Because `accept_gps_time == accept_time` everywhere, the L1 GPS-age flag and the L3 GPS-age deferral never fire on this data. We keep them (they cost nothing and the console shows them) and say on the site that this data cannot test them. Alternative (synthesize GPS lag) rejected: it would be an untested invented defect.
- **Consequence: burst check is clean.** Zero natural same-minute bursts means the L1 burst flag has no false positives from honest couriers in the raw data; any precision loss will come from injected-but-unflagged rows and from couriers who become bursty only via injection.
- **Heavy tail kept.** PLAN locks minimal cleaning; the > 24 h tail stays and will dominate P90 error. Alternative (cap at 24 h) rejected to honor the lock.

## Step 2: prep and features
- **Cleaning.** 931,351 raw rows -> 904,679 kept (dropped: duration <= 0, and accept dates outside weeks 0-25). Week = (accept date - 2022-05-01) // 7.
- **History features use only what was observable.** Courier/area history mean at day D = mean recorded duration of packages accepted on days D-14..D-1 **and delivered before day D starts**. (PLAN says "previous 14 days"; adding the delivered-before-D condition removes look-ahead from packages accepted yesterday but still out for delivery.) Computed with per-entity difference arrays.
- **Open workload** = courier's packages accepted earlier the same day and with a delivery scan after this accept time. It reads other packages' scans only up to the current time, so it is known at acceptance. Leakage tests check the row's own label never affects its own features.
- **Stale freeze date.** PLAN gives both "stop refreshing after week 8" and "frozen as of 2022-06-25"; 2022-06-25 is the last day of week 7. We use the explicit date: from 2022-06-26 (start of week 8) the history table is the one built with data through 2022-06-25. Config key `degrade.stale.freeze_data_through`.
- **History-feature age** = row day minus last data day seen by the feature store: 1 day when refreshed daily; grows by 1 per day after the freeze.
- **Training-label availability.** Training rows from week t-1 whose delivery scan falls inside test week t are kept in the window (PLAN's window definition). This uses no test-week labels; it is a mild optimism about label latency, noted as a limitation.

## Step 3: reference walk-forward
- **Area-support deferral threshold.** PLAN: defer if the package's `aoi_id` has < 50 training rows. In LaDe Chongqing an `aoi_id` is tiny (median 2 couriers, ~8 rows per 4-week window); measured on dev weeks with no labels, the share of test packages below a threshold of 1/3/5/10/20/50 rows is 3.1/8.4/12.8/22.2/35.5/59.2%. A threshold of 50 alone would defer ~59% and break the 10% deferral budget, so we use **1 (area never seen in the window, ~3.1%)**. Alternatives: 3 (8.4%, leaves no budget for other rules), region-level support (changes the rule's meaning).
- **Reference stability (dev weeks 4-21, seeds 0-2).** Mean MAE 191.1 / 191.2 / 191.1 min; largest weekly spread across seeds 0.7 min; miss rate 21.9%; promise width 336 min; ~7.8 s per retrain (two models, 12 threads). Naive baselines on the same weeks: global training median 215.9, per-area median 203.4. The model is better but not suspiciously so; most error is the multi-day tail.
- **Extra metric.** `mae_trim_min` = MAE over packages whose reference duration is <= 24 h, reported alongside the PLAN MAE because the tail (up to 89 days) dominates MAE. Scorecard uses PLAN's MAE.

## Step 4: injectors
- **Bulk scan "courier-day"** = courier x **delivery date**: a hit package's scan moves to that courier's last scan that day (an end-of-shift bulk scan). Rows already at that maximum cannot change, so the realised rate sits just below p(w) (e.g. week 21: 0.82 vs 0.90). Labels only get longer.
- **Nested doses.** Sloppy couriers are a prefix of one seeded permutation of warm-up couriers, so a 0.35 dose contains the 0.15 couriers; dose-response is then about volume, not about which couriers were drawn. 98 of 489 warm-up couriers at the default 0.20.
- **Unseen condition** = early scan **on top of reference data** (no sloppy feed), with its 15% of couriers taken from the other end of the same permutation, so they are disjoint from every sloppy draw (up to 0.60). This keeps "unseen vs reference" a clean comparison. Alternative (early scan on top of combined) would mix two defects in the one test meant to show generalisation.
- **Duplicates** keep package id and scans; they enter training data and history features, never the test set (one package = one scored unit).

## Step 5: Guard v0 and diagnostics
- **Guarded feature store.** With the Guard on, history means are computed from the feed minus L1-quarantined records, and open workload ignores duplicate copies. Rationale: the same sloppy feed feeds labels and history features (PLAN section 4), so the ingest quarantine should protect both. Guard-off runs read the raw feed.
- **Duplicate order.** "Keep first" uses arrival order; a re-upload arrives after its original.
- **Reputation details.** Peer disagreement = courier's mean of (log1p duration - mean log1p duration of *other* couriers' rows in the same `aoi_id` x hour), over non-quarantined rows with peers; robust z across couriers (median/MAD). Badness = shrink x (max(0, |z| - 1) + 5 x flag rate), shrink = n/(n+30); reputation = 0.1 + 0.9 exp(-badness). Two-sided |z| so short-label defects (early scans) are also caught. On CQ week 16 (low_quality): sloppy couriers median reputation 0.13, honest median 1.0.
- **Conformal calibration** uses the L2 weights (weighted 0.8-quantile of y - q80 per `aoi_type`, >= 30 calibration rows else pooled), so quarantined labels barely move the offset.
- **Stale-feature deferral vs. L2 nulling.** L2 already sets history features older than 7 days to NaN before the model sees them, so the L3 "history-feature age > 7 days" deferral only fires when L2 nulling is disabled (the served prediction then no longer depends on stale values). Otherwise the stale condition would defer 100% of packages from week 9 onward. The console shows such packages as "history stale: fallback used".
- **Courier cap kept as specified** (2x the median courier's total weight). The median courier has 164 rows in a 4-week window, the busiest 400-1,100, so the cap scales down ~65% of rows. `frac_downweighted` = share of rows whose final weight is below half their recency-only weight, so it includes the cap.
- **SHAP** values come from LightGBM's built-in TreeSHAP (`pred_contrib=True`), exact Shapley values for trees, on 1,000 test rows per run-week.
- **End-to-end check (CQ, weeks 12/16/20, seed 0).** MAE guard off -> on: reference 162.5->162.8, 160.4->161.0, 231.7->232.0; low_quality 168.6->163.8, 171.6->161.6, 250.6->233.7; combined 167.5->170.0, 166.6->165.4, 239.2->237.7. Detector precision ~0.95 on low_quality. Width deferral 15-22% at k=2 (over budget; k is tuned in step 8).

## Step 6: site skeleton
- **Console models** = the week-25 retrain of the **low_quality** feed, seed 0, Guard off and on (P50 and P80 each). Low quality is the production-like failure (a sloppy source in today's feed). Stale features and the other scenarios are shown as per-package situations on top of it. Models are retrained deterministically by `export_site` with the same seed and settings as the final runs.
- **Scenario locations.** The models use stop longitude/latitude, so scenarios need location inputs. They are medians over groups of packages snapped to a 0.1-degree cell (~10 km) and never displayed. Tree thresholds on lng/lat are part of the trained model, which PLAN allows on the site.
- **In-browser check inputs** (20 = 10 real test rows + 10 synthetic rows with NaNs) are written to `logs/` (git-ignored), never to `docs/` or `results/`.
- **Weekly metrics download** is `docs/data/weekly_metrics.csv`; `.gitignore` gets one exception for it (aggregates only, no ids).
- **Narrative text** that depends on findings (mechanism captions, stress-test callouts, video link) lives in `docs/data/text.json`, written after discovery.
