# PLAN: LaDe Data Shelf-Life Guard

Source of truth for the autonomous build. Case prompt: W&M AI Club Case-a-thon 2026, "Unintentional Data Poisoning" (sponsor: Air Combat Command HQ ACC/ST). Core question from the prompt: *When does more information make an AI-enabled decision process worse, and what evidence shows that your intervention restores useful performance?*

**Thesis for the talk:** data has a shelf life and a source reputation. Past a point, older or noisier data makes delivery promises worse; we measure that point and act on it with a three-layer Guard.

---

## 1. Locked decisions

| Decision | Choice |
| --- | --- |
| Dataset | LaDe delivery, Chongqing: `data/raw/delivery_cq.csv` (145,068,417 bytes, roughly 1M rows). Yantai `delivery_yt.csv` (31,532,960 bytes) for smoke tests only. |
| Time span | 2022-05-01 to 2022-10-31. Weeks run Sunday-Saturday from 2022-05-01 (week 0). 26 full weeks (0-25); drop Oct 30-31. |
| User | Dispatcher who sets delivery promises |
| Decision | At task acceptance, set the promised delivery window for a package |
| AI component | LightGBM: a median model (`objective="l1"`, expected duration) and an 80th-percentile model (`objective="quantile", alpha=0.8`, the promise) |
| Consequence of error | Promise too short: missed promise. Promise too long: padded, uncompetitive service. |
| Evaluation unit | One package, scored in the week it was accepted; training and test never share a week |
| "Better" | Lower MAE and P90 error, promise-miss rate near 20%, narrower promises, deferral <= 10% |
| Product | "The Guard": data shelf-life and source-trust layer around the model |

Default model settings (fixed for every run): `n_estimators=300, learning_rate=0.05, num_leaves=63, min_child_samples=50, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, random_state=seed, verbose=-1`. **Do not use LightGBM categorical features** (use integer codes) so the exported trees stay simple for the in-browser model.

## 2. Walk-forward retraining

For each test week t: training window = weeks t-4..t-1 (reference); recompute history features from data available before each row's day; fit both models from scratch; predict every package accepted in week t; score against reference durations. Then t+1. "Frozen" = trained once on weeks 0-3 and reused (control run only).

| Block | Weeks | Dates (2022) | Use |
| --- | --- | --- | --- |
| Warm-up | 0-3 | May 1-28 | Training history only |
| Development | 4-21 | May 29-Oct 1 | All exploration, diagnostics, tuning |
| Held-out | 22-25 | Oct 2-29 | Final evaluation only, after freeze (includes most of National Day "Golden Week") |

## 3. Data, features, metrics

**Time parsing.** Inspect `accept_time`/`delivery_time` strings first. If they lack a year, prepend 2022 and cross-check against the `ds` column. Log the format in MANIFEST.md.

**Reference cleaning (minimal).** Drop only rows whose times fail to parse or whose duration <= 0. Keep everything else. The audit counts already-present problems (same-minute bursts per courier, durations > 12 h, missing GPS, GPS fix age) as *observed*, separate from injected defects.

**Target:** `duration_min = delivery_time - accept_time` in minutes.

**Features (all known at acceptance):**
- hour, minute of day, day of week (from `accept_time`)
- `region_id`, `aoi_id`, `aoi_type` (integer codes)
- stop location `lng`, `lat` (model input only; never shown on the site)
- courier-to-stop distance (km, haversine from `accept_gps_lng/lat` to `lng/lat`)
- courier open workload: courier's packages accepted earlier the same day and not yet delivered at this accept time
- courier history average: courier's mean recorded duration over the previous 14 days (days strictly before the row's day)
- area history average: same for `aoi_id`

**Guard metadata (not model features):** GPS fix age = `accept_time - accept_gps_time` (minutes), courier ID (source identity), history-feature age (days), quality flags.

**Leakage rules (tests in `tests/test_leakage.py`):** `delivery_time`, `delivery_gps_*` and anything derived from them are never features; history features use only prior days; a test week never appears in its own training window; injection labels never reach the model or the Guard.

**Metrics (per run x test week):** MAE (min) of the median model; P90 absolute error (min); promise-miss rate (share delivered after the P80 promise); promise width (mean P80 minus acceptance, min); deferral rate; share of training rows down-weighted and effective training size; rare-area MAE (area types under 2% of volume); detector confusion (positive = injected record: TP, FP, FN, TN, precision, recall, FPR); seconds per retrain. Scoring always uses reference (un-injected) durations.

## 4. Degradation conditions

Defects corrupt training data and model inputs (including the history features, because the feature store reads the same feed). Scoring always uses reference durations. All randomness from the run's seed. Every injection writes a modification-log row (condition, seed, affected courier IDs hashed, rows by week, parameters).

| Condition | Mechanism | Stage hit | Exact parameters |
| --- | --- | --- | --- |
| reference | None | - | 4-week window, history features refreshed daily |
| stale | (a) training window = **all** weeks 0..t-1, equal weight. (b) history features **stop refreshing** after week 8 (values frozen as of 2022-06-25; couriers/areas first seen later get NaN). | (a) training mix, (b) inputs | as stated |
| low_quality | "Fast, sloppy feed": 20% of couriers active in weeks 0-3 (seeded draw) become **bulk scanners**: each of their packages in week w>=4 has probability p(w) = min(0.9, 0.10 + 0.80*(w-4)/17) of `delivery_time` := that courier-day's maximum delivery time. From week 10, each of their records is **re-uploaded** (duplicated, same package id) with probability 0.8. | training labels, source volume, history features | as stated |
| combined | stale + low_quality | all | as stated |
| unseen (final evaluation only) | A disjoint 15% of couriers **scan early** from week 18: `delivery_time` := `accept_time` + U(0.4, 0.7) x true duration. Weeks 22-25 also contain Golden Week. | labels, regime | as stated |

## 5. Run families (about 984 retrains)

| Family | Grid | Retrains |
| --- | --- | --- |
| main | 4 conditions x Guard off/on x seeds {0,1,2} x dev weeks 4-21 | 432 |
| shelf_life | windows {1,2,4,8,16,all} x {reference, low_quality} x weeks 4-21, Guard off, seed 0 | 216 |
| dose | sloppy-courier share {0, 0.15, 0.35, 0.60} x Guard off/on x weeks 4-21, seed 0 | 144 |
| controls | on low_quality: oracle filter (drop exactly the injected rows), random removal (same count); on reference data: frozen model only, frozen features only (stale (b) alone) x weeks 4-21, seed 0 | 72 |
| final (after freeze) | 4 conditions + unseen x Guard off/on x seeds {0,1,2} x weeks 22-25 | 120 |

Plus at most one tuning sweep in step 8 (<= 12 Guard configs x {reference, low_quality, combined} x dev weeks, seed 0). A gap between cells counts only if larger than the spread across seeds.

## 6. Code structure and results schema

```
config.yaml  requirements.txt  PROGRESS.md  DECISIONS.md  MANIFEST.md  README.md  AI_DISCLOSURE.md  DISCOVERY.md  PRESENTATION.md
data/raw/  data/processed/            # git-ignored
src/prep.py        # load, parse, minimal cleaning, features -> data/processed/cq.parquet
src/audit.py       # observed issues -> results/audit.json
src/degrade.py     # stale_history, stale_features, bulk_scan, duplicate_upload, early_scan (+ modification log)
src/guard.py       # L1 checks, L2 weights, L3 defer + conformal promise
src/model.py       # fit/predict median and P80 models
src/walkforward.py # one run: loop over weeks -> metrics rows (+ diagnostics hooks)
src/jobs.py        # writes jobs.csv (one row per run: family, condition, guard, seed, window, severity, weeks)
src/run.py         # python -m src.run --all [--family F] [--workers N]; resumable; writes results/runs/<run_id>/
src/diagnose.py    # SHAP sample importance, probe-grid predictions, chain metrics
src/aggregate.py   # merge runs -> results/*.parquet + results/results.json
src/export_site.py # results -> docs/data/*.json; final models -> docs/models/*.json
tests/             # leakage, injectors, Guard
docs/              # website (GitHub Pages)
```

Every parameter lives in `config.yaml`; every result row carries `config_hash` and `git_sha`.

| File | One row per | Columns |
| --- | --- | --- |
| `results/weekly_metrics.parquet` | run x test week | run_id, family, condition, guard, seed, window_weeks, severity, week, week_start, n_test, n_train_rows, eff_n_train, frac_downweighted, mean_train_age_days, sloppy_share_train, feature_age_days, mae_min, p90_err_min, miss_rate, promise_width_min, defer_rate, rare_mae_min, train_seconds, config_hash, git_sha |
| `results/detector.parquet` | run x week | run_id, week, tp, fp, fn, tn |
| `results/importance.parquet` | run x week x feature | run_id, week, feature, mean_abs_shap |
| `results/probe_preds.parquet` | run x week x probe | run_id, week, probe_id, pred_p50, pred_p80 (synthetic probe grid: area type x hour x distance) |
| `results/chain.parquet` | run x week | run_id, week, train_label_median, train_label_ks_vs_ref, probe_shift_p50, probe_shift_p80 |
| `results/results.json` | whole study | headline numbers per cell, scorecard, recovery %, config, versions |
| `results/modification_log.csv` | injection | condition, seed, week, rows_affected, params |

## 7. The Guard (countermeasure)

Three layers; none uses injection labels.

- **L1 Ingest checks (data link).** Label-free flags: duration <= 0; >= 5 packages from one courier with the same delivery minute; duplicate package id (keep first); GPS fix age > 30 min; courier-to-stop distance > 30 km. Flagged rows are quarantined (weight 0.05), not deleted.
- **L2 Training weights (training-signal link).** weight = recency x reputation x flag factor. Recency = 0.5 ** (age_weeks / h), default h = 4. Reputation per courier, computed from the training window only: combine the courier's flag rate and peer disagreement (median of the courier's durations vs. the median of other couriers in the same `aoi_id` x hour, as a robust z-score), shrunk toward neutral by a prior of 30 records so small/rare couriers aren't punished; map to (0.1, 1]. Cap each courier's total weight at 2x the median courier total so volume can't buy influence. History features older than 7 days -> NaN.
- **L3 Serve-time check (decision link).** Promise = conformalized P80: fit on window weeks except the most recent, calibrate per `aoi_type` on the most recent training week (scores s = y - q80; add the coverage-0.8 quantile of s), so each area type stays near 80% coverage. Defer a package when: history-feature age > 7 days, GPS fix age > 30 min, its `aoi_id` has < 50 training rows in the window, or interval width (P80 - P50) > k x the area-type median width (default k = 2). Deferred packages still count in MAE (scored with the model's prediction) but are reported separately; deferral rate is a cost.
- **Monitor.** Weekly promise-miss rate; two consecutive weeks outside 15-25% = alert (shown on the site timeline).

Tunable settings (dev weeks only): h in {2, 4, 8, inf}, reputation strength lambda in {0, 0.5, 1} (weight = 1 - lambda*(1 - reputation)), k in {1.5, 2, 3}. Pick the simplest config that passes the scorecard.

**Alternatives rejected (for the site):** hard-delete flagged rows (irreversible, loses rare valid data; random-removal control shows volume loss costs accuracy); generic outlier detection (fails when the sloppy feed is the majority); retrain on shorter windows only (helps staleness, amplifies sloppy feed, starves rare areas); a bigger model (memorizes noisy labels); drift alarm alone (detects, doesn't fix); manual cleaning (doesn't scale or test).

## 8. Discovery process and scorecard

Chain measured per condition per week: (1) data: mean training-row age, sloppy share, duplicate share, feature age; (2) training signal: training-label median and KS distance vs reference; (3) model: probe-grid shift, SHAP importance; (4) decision: promise width, miss rate, P90, rare-area MAE.

Steps (development weeks only): check reference stability; failure atlas (weekly gap to reference, split by area type, courier group, hour); find the first link where each condition departs; read controls (oracle = ceiling; random removal = volume control; frozen model vs frozen features; dose-response should be monotonic; shelf-life U-curve); match mechanisms to Guard layers; run the tuning sweep; choose settings with the scorecard; write **DISCOVERY.md** (one-page findings, chosen settings, rejected settings, what failed); freeze.

| Scorecard criterion | Pass if |
| --- | --- |
| Recovery | >= 50% of the MAE gap recovered in low_quality and combined. Recovery % = (degraded - guarded) / (degraded - reference) |
| No harm | Reference MAE at most 3% worse with Guard on |
| Promise quality | Miss rate 17-23% at equal or smaller promise width |
| Deferral | <= 10% of packages |
| Rare areas | Rare-area MAE no more than 5% worse than reference |
| Detection | Precision >= 0.7 on injected rows; FPR reported |
| Beats control | Guard beats random removal of the same data volume |

If nothing passes, choose the best config, report which line failed, and say so prominently. A well-supported negative result is acceptable.

**Reviews are asynchronous.** The user wants this hands-off: write DISCOVERY.md, proceed immediately, and note at its top that the team can request a change Thursday (the final evaluation is cheap to rerun).

## 9. Website (docs/)

A static site: `docs/index.html` + `docs/app.js` + `docs/style.css` + `docs/data/*.json` + `docs/models/*.json`. **Vendor Plotly** (download an exact version, e.g. plotly.js 2.35.2 min, into `docs/vendor/`) so the page works offline. No server, no build step, no trackers. Light and dark themes via CSS variables. Works on a laptop projector (min 1280 px) and is readable on a phone.

**Data rules:** no raw LaDe rows, no courier IDs, no package or GPS coordinates, no maps of real locations. Only aggregates, the synthetic probe grid, constructed scenarios, and trained models. Show both license statements (repository metadata: Apache-2.0; author paper: CC BY-NC 4.0) on the Methods section.

**Sections (one page with a sticky nav; these double as the presentation slides):**

| Section | Content |
| --- | --- |
| 1. Overview | Thesis, the decision, the four-link chain (data -> training signal -> model -> decision), three headline numbers, link to fallback video (placeholder until the team adds it) and repo |
| 2. Dispatcher console | Scenario picker (normal, stale features, sloppy-source area, rare area, Golden Week). Guard off vs on side by side: expected duration, promise, health card (feature age, GPS age, area support, interval width), Approve/Defer with reason. Correction panel: override promise, flag source, note -> shows a logged correction and estimated review time. Predictions computed live by the in-browser models; show inference time (ms). |
| 3. Timeline | Weekly curves for the 8 main cells with seed bands; data tracks below (training-row age, sloppy share, feature age, volume); markers for defect start, real events, monitor alerts. Selectors: condition, Guard on/off, metric. |
| 4. Mechanism | Four linked small charts for the selected condition (data -> training labels -> probe predictions and SHAP -> decision); oracle vs random removal vs Guard; dose-response; frozen model vs frozen features. |
| 5. Countermeasure | The three layers in plain words (simple SVG diagram); 8-cell results table (MAE, P90, miss rate, width, deferral, data down-weighted, +/- seed spread); recovery %; detector confusion matrix; shelf-life U-curve; scorecard pass/fail. |
| 6. Stress tests and limits | Held-out weeks, unseen early-scan defect, rare areas, at least one clear failure, tradeoffs, when not to use the system. |
| 7. Oversight and governance | Roles (dispatcher uses; data steward reviews quarantine and reputation; model owner signs off weekly retrain and alerts; ops manager approves pilot); defer rules; correction path; human effort (deferred packages/day x assumed 45 s review, labeled as an assumption) vs compute latency; bounded pilot plan (shadow mode, one district, 4 weeks, checkpoint criteria, owner); stop conditions; optional NIST AI RMF mapping. |
| 8. Methods and downloads | Data manifest, splits, retraining disclosure, seeds, modification log summary, AI and prompt disclosure, setup instructions and versions; downloads: results.json, weekly metrics CSV, manifest. |

**In-browser models:** export the final-week Guard-off and Guard-on models (P50 and P80) with `booster.dump_model()` into compact JSON (per node: feature index, threshold, decision type, default_left, missing_type, children; leaf values). Implement tree traversal in `app.js` matching LightGBM's missing-value handling. **Verify:** on 20 test inputs, browser-equivalent predictions match Python within 0.01 minutes (use `node` to run the same evaluator if available; otherwise a line-by-line Python port of the JS traversal). Record the check in PROGRESS.md.

**Prompt requirement coverage (show this table on the Methods section):** 1 decision -> Overview, Console; 2 reference -> Timeline, Methods; 3 degradation separately and together -> Timeline, Methods; 4 over time with age/quality/volume -> Timeline; 5 mechanism -> Mechanism; 6 countermeasure incl. unseen period -> Countermeasure, Stress tests; 7 limits and next steps -> Stress tests, Oversight; oversight walkthrough -> Console, Oversight; results and manifest -> Methods; fallback video -> Overview.

**Hosting:** GitHub Pages from `main` `/docs`. Check repo visibility with `curl -s https://api.github.com/repos/1628745/Case-a-thon2026` (404 = private: Pages needs a public repo or GitHub Pro; note it for the user). If `gh` is installed and authenticated, enable Pages with `gh api -X POST repos/1628745/Case-a-thon2026/pages -f "source[branch]=main" -f "source[path]=/docs"`; otherwise leave the exact clicks at the top of PROGRESS.md (Settings -> Pages -> Deploy from a branch -> main -> /docs).

**Verify the site:** serve with `python -m http.server -d docs 8000`, fetch every asset with curl (all 200), validate every JSON file parses, and if Playwright can be installed into .venv, screenshot each section at 1440x900 and check for console errors.

## 10. Paperwork

- **MANIFEST.md** (and `docs/data/manifest.json`): source URLs (https://huggingface.co/datasets/Cainiao-AI/LaDe, https://github.com/wenhaomin/LaDe), retrieval date 2026-10-21, files, byte sizes, SHA-256, row count, independent-case count (packages, couriers, areas), date range, fields and units, subset/filter rules, missing-value treatment, rights statement (both licenses), observed issues vs introduced changes, untouched reference copy note.
- **README.md:** what this is, how to reproduce (setup, versions, commands, runtime), repo layout, link to the site.
- **AI_DISCLOSURE.md:** Claude (Anthropic) built the pipeline, experiments, analysis and site autonomously from PLAN.md under the team's direction; list the AI components being tested (LightGBM models) separately from AI used as a tool; summarize prompts; note human review points.
- **DECISIONS.md, DISCOVERY.md** as above.

## 11. Presentation kit (PRESENTATION.md)

10-minute run of show (all on the site): 0:00-1:00 Overview; 1:00-3:00 Console (normal package, then an unreliable one: health card, defer, correction); 3:00-4:45 Timeline; 4:45-6:15 Mechanism; 6:15-7:45 Countermeasure; 7:45-9:00 Stress tests and limits; 9:00-10:00 Oversight and the pilot. Include speaker notes per segment, 15 likely judge questions with short answers and where each number comes from, and a shot list for the recorded fallback video.

## 12. Execution order

| Step | Work | Must pass before moving on |
| --- | --- | --- |
| 0 | Start caffeinate. Move both CSVs into `data/raw/`. Confirm `.gitignore`. Create `.venv`, install, pin `requirements.txt`. Commit and push (`.gitignore`, CLAUDE.md, PLAN.md, PROGRESS.md, requirements). Check repo visibility. | Imports work; push succeeds; `git status` shows no CSV staged; CSV sizes match section 1 |
| 1 | `src/audit.py` on Yantai, then Chongqing: date range, rows/week, time format, observed issues -> `results/audit.json` + audit summary in DECISIONS.md | 26 weeks present; time format confirmed. If the audit contradicts a locked decision, choose the closest workable alternative, log it, continue. |
| 2 | `src/prep.py` -> `data/processed/cq.parquet`; leakage tests | Tests pass |
| 3 | `model.py`, `walkforward.py`; reference on dev weeks, seeds 0-2 | Weekly MAE stable across seeds and plausible (if suspiciously low, hunt for leakage) |
| 4 | `degrade.py` + modification log; unit tests | Each injector tested; doses match schedule |
| 5 | `guard.py`, `diagnose.py` | Guard on/off end to end on one run (Yantai first, then Chongqing, a few weeks) |
| 6 | Site skeleton in `docs/` on mock data in the exact schema | Page loads locally, all sections render |
| 7 | `jobs.py`, `run.py`; grid pass 1 in the background: main, controls, dose, shelf_life. Meanwhile continue the site and diagnostics. | All runs complete; failures rerun; aggregate succeeds |
| 8 | Discovery + tuning sweep; DISCOVERY.md; if settings changed, rerun the main family with the chosen settings | Scorecard computed on dev weeks only; DISCOVERY.md written |
| 9 | Review subagent on the diff; commit; tag `guard-v1-frozen`; push tag; run the final family | Config hash in every final row; tag pushed |
| 10 | `aggregate.py`, `export_site.py`, model JSON; verify in-browser model | 20-input check passes |
| 11 | Full website build; verify; publish via Pages (or leave clicks) | Every section shows real numbers; assets 200; JSON valid |
| 12 | MANIFEST.md, README.md, AI_DISCLOSURE.md, PRESENTATION.md, results.json; final review subagent; final push; PROGRESS.md -> DONE | Definition of done |

## 13. Cut list (apply in order only if behind schedule)

1. dose: 4 levels -> 2 (0 and 0.35). 2. seeds 3 -> 2. 3. SHAP -> LightGBM gain importance. 4. shelf_life windows 6 -> 4 (1, 4, 16, all). 5. Site: merge Mechanism into Countermeasure and Stress tests into Oversight. 6. L3: fixed P80 promise instead of conformal calibration.
**Never cut:** 4 conditions x Guard on/off, held-out weeks and unseen defect, oversight walkthrough, manifest, honesty about failures.

## 14. Definition of done

- [ ] All families complete; `results/` aggregated; `results.json` has headline numbers and the scorecard
- [ ] `guard-v1-frozen` tag pushed; final evaluation uses the frozen config
- [ ] `docs/` site complete with all 8 sections on real results; in-browser model verified; no raw data, IDs or coordinates in `docs/`
- [ ] GitHub Pages enabled, or exact enable steps at the top of PROGRESS.md
- [ ] MANIFEST.md, README.md, AI_DISCLOSURE.md, DECISIONS.md, DISCOVERY.md, PRESENTATION.md written
- [ ] Tests pass; `git status` clean; everything pushed; no file over 50 MB in git history
- [ ] PROGRESS.md starts with DONE, a 10-line summary of findings, and the team's remaining to-dos (record the video and add its link, rehearse)
