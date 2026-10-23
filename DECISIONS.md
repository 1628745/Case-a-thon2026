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

## Step 7: grid pass 1
- 46 unique runs (48 family rows; reference window-4 Guard off seed 0 is shared by main and shelf_life, so run IDs are content hashes and shared specs run once). 828 weekly retrains, 37.6 min on 4 workers x 3 threads, 0 failures.
- **Committed results** are aggregates only (`results/*.parquet` is whitelisted in the team's `.gitignore`; no raw rows, no courier ids). `results/jobs.csv` stays local (regenerated by `python -m src.jobs`).
- Runs started before two harmless code additions (extra Guard outputs `defer_k*`, a per-group `breakdown` table); their weekly metrics are unaffected. `git_sha` in a row is HEAD when that run started.

## Step 8: tuning sweep design (changed after reading pass 1)
- **Evidence from pass 1 (dev weeks):** frozen *features* alone cost nothing (control 191.0 vs reference 191.1 min MAE), a frozen *model* costs +2.5, the shelf-life curve has no U (longer windows are as good or better in reference and low_quality), and the Guard made stale (+3.3 min) and combined (+1.3) worse while costing reference only +0.6. The common factor is L2's "history features older than 7 days -> NaN": it throws away features that are stale but still informative.
- **Sweep = 12 configs** = staleness response {drop after 7 days (PLAN), keep (no drop; L3 does not defer on age; staleness becomes a system-level alert)} x h {4, inf} x lambda {0, 0.5, 1}, each on reference, low_quality, combined, dev weeks, seed 0. **k is not a sweep dimension**: it only changes deferral (MAE is scored on every package), so every Guard run reports the deferral it would have at k = 1.5, 2, 3, 4 and k is chosen from those.
- **Deviation from PLAN's tunable list:** h = 2 and h = 8 are dropped to spend the 12-config budget on the staleness rule that discovery implicated. Pass 1 already shows shorter effective windows hurt (shelf life: 1- and 2-week windows are worse in both reference and low_quality), so h = 2 is the least promising value; h = 8 lies between 4 and inf. Alternative: run PLAN's 4x3 grid and leave the staleness rule untested; rejected because it would freeze a rule the evidence says is harmful without testing it.
- A first sweep with PLAN's exact h x lambda grid was started and stopped after 5 minutes (no results used).

## Step 8: chosen Guard settings
- **Chosen:** keep stale history (`hist_max_age_days: null`, `defer_hist_age_days: null`; a system-level feature-store alert replaces per-package deferral), h = 4, lambda = 0.5, k = 4. Evidence and rejected alternatives in DISCOVERY.md sections 5-7.
- **Selection rule.** No config passed all 7 lines (none passes Promise quality), so PLAN's fallback applies: choose the best config and report the failed line. "Best" = most lines passed, then dev MAE. keep/h4 with lambda 0 and 0.5 tie (0.1 min apart, inside seed spread); lambda 0.5 is chosen to keep the reputation layer, the only Guard defence against defects without burst/duplicate traces. This uses no held-out information. Alternative: lambda 0 (simplest; reputation off).
- **k = 4 is outside PLAN's listed {1.5, 2, 3}.** k = 3 gives 10.6% deferral on reference (over the 10% budget). Every Guard run reported deferral at k = 1.5/2/3/4, so no extra runs were needed.
- **Reruns.** Guard run ids now include a hash of the effective Guard config, so the main family's 12 Guard-on runs and the dose family's 4 Guard-on runs reran under the chosen settings (Guard-off runs are unchanged and reused). Pass-1 Guard-on runs are kept as families `main_v0`/`dose_v0` for the record.
- **Atlas group labels.** Courier-group labels for the failure atlas (`grp_sloppy`, `grp_early`) are added to every run's feed for analysis only; they are in the Guard test's scramble list.
- **Promise quality kept strict.** Read as: in every condition, Guard-on miss rate within 17-23% and promise width no more than 1% above Guard off. It fails in reference and stale (conformal calibration to 80% needs wider promises than an unguarded model already at 21.9% misses). Alternative reading (degraded conditions only) would pass; not adopted after seeing results.

## Step 9: pre-freeze review
- Review subagent (code vs PLAN): no leakage, scoring, held-out, metric or injector issues. Low notes: (1) `results.json` could contain bare `NaN` -> fixed (strict JSON); (2) workload/history use minute-resolution times, so a scan up to 59 s after an accept in the same minute counts as already delivered (other packages only; negligible; kept); (3) the width-deferral reference uses in-sample P50 on the calibration week (deferral is still measured on real test packages; kept); (4) the held-out scorecard has 6 lines (no random-removal control in held-out weeks).

## Steps 10-11: export and site
- Console models are the week-25 retrain of low_quality seed 0 (Guard off/on), retrained by `export_site` with the frozen config. LightGBM names array-fit features `Column_i`; the export writes the real names (same order).
- Site verification used the Claude desktop app's built-in browser (JS checks for console errors, chart rendering, overflow at 1440x900 and 375 px) instead of installing Playwright, which would download a browser outside the repo.
- GitHub Pages enabled via `gh api` (repo is public): https://1628745.github.io/Case-a-thon2026/ from `main` `/docs`; `docs/.nojekyll` added.

# Phase 2: "Try it" live demo

## L0
- Branch `live-demo` from `main` at 0a2bb7a. The modified CLAUDE.md and the new LAB_*.md files (written by the user before the run) are committed on this branch as the first commit.

## L1: importable core and the browser package
- **Refactors in `src/` (behaviour unchanged, phase-1 tests pass):** `common.py` imports `yaml`/`subprocess` lazily; `prep.load_clean` = `pd.read_csv` + new `clean_frame(raw, cfg, src_row=False)`; `audit.audit` = file info + new `audit_frame(raw, cfg)` (`ds` and delivery-GPS columns optional); `walkforward.build_run_feed` tail extracted as `attach_features(feed, cfg, gcfg, freeze_day)`; `guard.training_weights`/`apply_guard` take an optional `release` set (dispatcher override: reputation := 1, L1 flags kept). Default `release=None` changes nothing.
- **Lab orchestration lives in `src/lab.py`** (single source of truth) and is copied with the core into `docs/py/guardlab/` by `scripts/build_lab.py` (only rewrite: `from src.x import` -> `from .x import`). `tests/test_lab_parity.py` fails if the copies are stale.
- **Window mapping:** sloppy/early couriers are drawn from couriers active before the test week (`splits.warmup = [0, T-1]`), not from a warm-up month, because a 6-week file has no separate warm-up. Bulk-scan ramp: `start_week = T-4`, `p_span_weeks = 3` (0.10 at T-4 -> 0.90 at T-1, cap 0.90; the test week's own scans also stay at 0.90 as in the study, but test labels are never touched). Duplicates from `T-2`, prob 0.8. Early scans from `T-4`, 15% of couriers, disjoint from sloppy ones.
- **Stale preset = both halves of the study's stale condition:** history features frozen at the start of the training window, *and* training on every full week before the test week with equal weight (the study's "all weeks" window). Alternative (frozen features only, 4-week window) rejected because the study found frozen features alone cost almost nothing.
- **Row cap (Quick):** whole couriers in a seeded order (`rng([seed, 23])`) until training rows <= 120,000; the same courier set is used in every run of an experiment. History features still use every row.
- **Timing granularity:** `train_s` is per model pair (P50 + P80; the Guard pair also includes the conformal fit), not per single model.
- **Courier hashes** are salted SHA-256 (8 hex). The browser uses a random per-session salt, so hashes can't be reversed to small integer ids; the committed cached result uses a secret salt that isn't stored.
