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

## L2: native lab experiment and the result schema
- `scripts/lab_native.py` runs `src/lab.py` natively; full results go to `logs/lab/` (git-ignored).
- **Row cap per window:** the reference run is capped over its 4-week window and the stale runs over their all-weeks window (separate seeded courier sets), so the reference is the same in every preset. Consequence on Yantai stale: the capped all-weeks window drops couriers, so ~19% of test packages are deferred as "area not seen in training" (`defer_min_area_rows: 1`). Kept and shown, not tuned.
- Recovery above 100% is reported as "recovered all of the damage and ended below the reference".
- **Native Yantai, Quick, seed 0 (MAE min, ref / off / on):** sloppy 95.7 / 136.2 / 98.8 (92% recovered); stale 95.7 / 110.4 / 108.7 (12%); sloppy+stale 95.7 / 116.4 / 109.0 (36%); unseen 95.7 / 101.9 / 103.0 (Guard worse, shown red); clean: Guard costs +1.6 min (95.7 -> 97.4).

### Result schema `guardlab-result/1` (fixed; produced by `src/lab.run_lab`, same in browser and native)
- `schema`, `source` (`native` | `browser` | `cached`)
- `settings`: preset, mechanisms [bulk|dup|stale|early], sloppy_share, seed, budget, n_estimators, num_leaves, row_cap, capped, couriers_kept, couriers_kept_stale_window, year, released [courier hashes], freeze_after, ramp {bulk_p, dup_from_week, dup_prob, early_share}
- `data`: week0_start, test_week, train_weeks, stale_weeks, test_start, train_start, first_full_week, rows_file, rows_used, trimmed_to_last_weeks
- `runs[]`: key (reference | degraded_off | degraded_on | clean_off | clean_on), label, guard, mae, p90_err, miss_rate, promise_mean, width_mean, defer_rate, n_deferred, mae_served, n_train, eff_n, frac_downweighted, n_test, train_s, run_s, predict_ms_per_pkg, feature_age_days
- `headline`: kind (injected | clean), gap_min or cost_min, noise_floor_min, recovery_pct (null under the noise floor), verdict (green | neutral | red), sentence
- `guard`: n_train, flags {nonpos, burst, dup, gps_age, far, any}, quarantined, frac_downweighted, eff_n, deferred, n_test, defer_reasons {hist, gps, area, width}
- `detector` (null when nothing injected): tp, fp, fn, tn, precision, recall, fpr, injected_train_rows
- `reputation`: edges, counts, n_couriers, lowest[10] {courier (hash), n, flag_rate, z, rep, sloppy, early, released}, n_sloppy, n_early, sloppy_caught
- `injection`: {mechanism: rows affected}
- `explain[]` (<= 5): kind, label, y, features[{name, off, on}], contrib_off[], contrib_on[], base_off, base_on, p50_off, p50_on, p80_off, p80_on, reasons {hist, gps, area, width}, decision
- `human`: deferred, sec_per_pkg_assumed (45), dispatcher_min, train_s_guard, predict_ms_per_pkg, n_test
- `quarantine`: columns [file_line, courier, reasons, note], rows
- `timings`: inject_s, score_s, total_s (+ audit_s, prepare_s, end_to_end_s natively; load/audit/run seconds in the browser)
- `versions`: python, pandas, numpy, lightgbm, platform; `config` (added by the caller): config_hash, guard_hash, guard

## L3: synthetic sample
- `scripts/make_sample.py` draws every value from a seeded generator (no LaDe rows read). 45 couriers x 8 weeks, about 23k rows (3.5 MB), Shanghai-area made-up coordinates, `city = SYNTHETIC`. Planted a few observed issues (0.15% zero durations, 0.2% late GPS fixes, 0.2% far fixes) so the audit and L1 have real issues to show. No same-minute bursts or duplicate ids are planted, so on the sample those come only from the poison dial.

## L4: worker
- Playwright 1.64.1 installed into `.venv`; `python -m playwright install chromium` put the browser in `~/Library/Caches/ms-playwright` (the standard location named by LAB_PLAN.md section 7). Its profile lives in `.cache/pw-profile` (git-ignored) so the Pyodide download stays cached between runs.
- Cancel = the page terminates the worker and starts a fresh one (a busy worker cannot read messages). Python errors are classed: `data` (a `LabError`, worded for the user), `memory`, `python` (traceback in `detail`), `load` (CDN or WebAssembly failure -> cached fallback offered).
- Results leave Python as strict JSON (`lab.to_json`: NaN/inf -> null).
- Added `lab.run_sweep` (P3 dose-response) now so the worker protocol is final; the UI comes in L8.

## L5: page
- The lab header reuses `.track` but has its own 5-step progress bar (`.lab-steps`), because the index route bar is built for 3 stops and is animated by app.js. Shared classes from style.css are reused unchanged (.btn, .ghost, .seg, .t, .gauge, .verdict, .facts, .err, .counter); lab-only rules live in lab.css.
- The cached Yantai result (`docs/data/lab_cached_yantai.json`, from `lab_native.py --cached`) is offered both when Python fails and as a "No time?" link in step 1. It has no feature values and no per-row quarantine list, and its courier hashes use a discarded random salt.
- The test server sends `Cache-Control: no-store` so tests always run against the current files; the Pyodide download stays cached in `.cache/pw-profile`.
- sklearn's "X does not have valid feature names" warnings are silenced in the worker (console noise only; the model inputs are the same arrays as natively).

## L6: P2 features
- Built together with L5 (same files); L6 is ticked separately once the e2e covered each feature. `lab_report.json` drops lng/lat values from the explain examples and leaves the per-row quarantine list to `quarantine.csv`.

## L7: parity, fallback, budgets
- **Full week redefined:** data on all 7 days, each day >= 5% of the median daily volume. The first rule (dates inside the file's min-max range) made Chongqing unusable: a handful of stray November/December accept dates pushed the "last full week" into an empty November. Yantai and the sample keep the same split as before.
- Parity: browser and native agree to 0.3% MAE on Yantai (the Guard-on run differs slightly: LightGBM 4.6 vs 4.7 and float order). No budget was missed, so the Quick budget stays at 150 trees / 31 leaves / 120k rows.
- The cold-load time (5.9 s) was measured with a fresh browser profile on a fast connection; on a slow connection the ~30 MB download dominates. Progress is shown either way.

## L8: P3
- **New-city card goes on the lab page, not index.html.** LAB_PLAN constraint 4 allows only the nav link (and key 5) on the narrative page, which takes precedence over P3's "card in #analysis". The card reads `lab_cached_yantai.json` (92% recovered).
- The sweep always uses the Quick budget and bulk scans + duplicates, whatever the dial says, so it reproduces the study's dose-response design.

## L9: nav link
- index.html: one `<a class="ghost tryit" href="lab.html">Try it</a>` after the route nav (inside the nav would break its 3-stop layout and the van), and the keys hint now mentions 5. app.js: key 5 goes to lab.html. style.css: one new `.tryit` rule appended, no existing rule changed.
- The smoke test compares against a baseline recorded on the unchanged page (`logs/smoke_baseline.json`: 4 sections, 28 SVGs, 10 chart SVGs). Its 390 px check reloads the page, because index.html lays out its decorations at load.

## L10: review subagent and fixes
The review subagent found no high-severity issues, 2 medium and 4 low. Fixed:
- **(medium, honesty)** The verdict is now red whenever Guard-on MAE exceeds Guard-off by more than the noise floor, even when the defect itself was under the floor. Previously such a run showed neutral. Test added.
- **(medium)** Loading another file, changing the year or opening the cached result during a run is now refused with a message. Before, the audit replaced the pending run and the page stuck at "Running".
- **(medium)** The courier-hash salt is held by the page and passed with each run, so hashes and releases survive a Cancel (which restarts the worker).
- **(low)** Rerun reuses the previous run's settings, so the "With N released" diff is only due to the releases.
- **(low)** In quarantine.csv, rows the poison dial changed are noted "changed by the poison dial", as well as its duplicate copies.

Not fixed:
- **(low)** `file_line = src_row + 2` assumes one header line and no blank lines (pandas skips blank lines). LaDe files have none; this is documented here.

## After DONE: Advanced panel removed (user request, 2026-10-24)
- The "Advanced" panel under Poison it (sloppy-share slider, per-mechanism checkboxes, seed, Quick/Full budget) is gone. Each preset now fixes its defects; sloppy share is 20%, seed 0 and the budget Quick, all the previous defaults. The worker and `src/lab.py` still accept those options, so `scripts/lab_native.py` can still vary them.

## After DONE: simpler Results section (user request, 2026-10-24)
- **Removed:** "Sweep the dial" (UI, the worker's `sweep` message and `lab.run_sweep`), the courier reputation table and histogram, and the "Explain a prediction" waterfalls, dropdown and feature table.
- **Courier trust** is now one sentence under the detector scorecard. Python adds `reputation.n_below_half`, `below_half` (salted hashes) and `early_caught` to support it.
- **One "Dispatcher review" panel** replaces the separate compute-vs-human block. It shows deferred count with reasons, dispatcher time at an assumed 45 s, training time and ms per prediction. It also shows one package card picked in this order: deferred, then a sloppy courier's package, then the lowest-reputation courier's. The card gives the L3 result and reasons, history age, GPS fix age, and the promise with vs without the Guard; Python now adds `hist_age_days` and `gps_age_min` to each explained package.
- **"Restore trust for the flagged couriers and rerun"** releases every courier below 0.5 with the existing release logic, keeping the previous run's settings. The button is disabled when no courier is below 0.5 and on the cached result.
- **Condensed and collapsed:** "What the Guard did" is one line of three numbers, and Run facts is a collapsed `<details>`.
- **Unseen preset restored** (a teammate had removed it) so the Guard's failure case can be shown live. On the synthetic sample it recovers only 4%.
- The Python explain block (contributions etc.) is still computed and still lands in `lab_report.json`; only its UI is gone. The cached Yantai JSON was regenerated with the new fields.

## After DONE: fallback demo video (user request, 2026-10-24)
- The user's `Case-a-thon Demo Video.mov` (40 s screen recording of the lab on the synthetic sample; frames checked: page and aggregate results only, no LaDe rows) is repackaged without re-encoding as `docs/media/demo-run.mp4` (H.264 copied from the `.mov` into an MP4 with faststart, 17.8 MB), because only Safari plays `.mov` reliably. `demo-run-poster.jpg` is frame 1 s at 1280 px.
- It sits in a `<details>` right under the Python loading bar with `preload="none"`, so visitors download it only when they open it. Closing the dropdown pauses it. The original `.mov` in the repo root is left untracked (not committed; it would duplicate the MP4).
