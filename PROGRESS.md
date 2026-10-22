# PROGRESS

Status: IN PROGRESS. Resume at the first unchecked step. Blockers (if any) go here at the top.

## Steps (see PLAN.md section 12)
- [x] 0 Environment, data placement, .gitignore, first push
- [x] 1 Audit
- [x] 2 Prep and features + leakage tests
- [x] 3 Reference walk-forward
- [x] 4 Injectors + modification log
- [x] 5 Guard v0 + diagnostics
- [x] 6 Site skeleton on mock data
- [x] 7 Grid pass 1 (main, controls, dose, shelf_life)
- [x] 8 Discovery + tuning, DISCOVERY.md
- [x] 9 Freeze (tag guard-v1-frozen) + final evaluation
- [x] 10 Aggregate, export, in-browser model check
- [ ] 11 Website complete + Pages
- [ ] 12 Paperwork, presentation kit, final review, DONE

## Log
(append one line per milestone: timestamp, step, what happened)
- 2026-10-21 22:45 ET, step 0: CSVs moved to data/raw (sizes 145068417 / 31532960 match), .venv with LightGBM 4.7.0, requirements pinned, repo public.
- 2026-10-21 22:44 ET, step 1: audit on YT and CQ; 26 weeks present; time format MM-DD HH:MM:SS confirmed against ds; GPS fix age always 0.
- 2026-10-21 22:48 ET, step 2: prep -> data/processed/cq.parquet (904,679 rows); 7 leakage tests pass.
- 2026-10-21 22:53 ET, step 3: reference dev weeks seeds 0-2: MAE 191.1/191.2/191.1, max weekly seed spread 0.7 min, miss 21.9%; beats naive (203-216).
- 2026-10-21 22:54 ET, step 4: degrade.py with 5 mechanisms + modification log; 7 injector tests pass; CQ doses match p(w) schedule (98 sloppy couriers, dup rate 0.799).
- 2026-10-21 22:58 ET, step 5: guard.py + diagnose.py; Guard on/off end to end on YT (weeks 14-15) and CQ (weeks 12/16/20, reference/low_quality/combined); 19 tests pass.
- 2026-10-21 23:12 ET, step 6: site skeleton (8 sections, vendored plotly 2.35.2, trees.js evaluator) on mock data from `export_site --mock`; served locally, all 15 charts and tables render, no console errors.
- 2026-10-21 23:00 ET, step 7 started: grid pass 1 (46 unique runs) in background, log logs/grid1.log.
- 2026-10-21 23:41 ET, step 7: grid pass 1 finished, 46/46 runs ok (0 failures, 828 weekly retrains, 37.6 min); aggregate ok. Default Guard on dev weeks: recovery low_quality 81%, combined -37%; no harm +0.3%; deferral 18%; detection precision 0.93/0.91; beats random removal (192.6 vs 198.9).
- 2026-10-21 23:42 ET, step 8 started: tuning sweep (12 configs h x lambda, k from reported defer-at-k) + 4 atlas runs in background, log logs/tune.log.
- 2026-10-22 01:02 ET, step 8: sweep 40/40 ok (12 configs + 4 atlas); chosen keep-history, h=4, lambda=0.5, k=4; main+dose Guard-on rerun 16/16 ok; dev scorecard (3 seeds) 6/7 pass: recovery LQ 87% / combined 74%, no harm +0.13%, deferral <= 7.7%, rare <= +1.7%, detection precision 0.93/0.91, beats random removal; FAIL promise quality (reference width 350 vs 336). DISCOVERY.md written.
- 2026-10-22 01:25 ET, step 9: pre-freeze review subagent: no high/medium findings; fixed low note (strict JSON in results.json). Tagging guard-v1-frozen.
- 2026-10-22 01:45 ET, step 9: tag guard-v1-frozen pushed (7d87d88); final family 30/30 ok; every final row config_hash e54a0bf568c4, git_sha 7d87d88. Held-out scorecard 5/6: recovery LQ 90% / combined 78% (stale 52%), no harm +0.03%, deferral <= 7.5%, rare <= +2.2%, precision 0.95/0.94; FAIL promise quality; unseen early-scan defect only 7% recovered. GitHub Pages enabled (main /docs).
- 2026-10-22 01:55 ET, step 10: aggregate + export_site (real results, week-25 low_quality seed-0 models, 300 trees each); in-browser model check `node scripts/check_models.js`: 80 predictions (20 inputs x 4 models, 10 with NaNs), max |js - python| = 0.000e+0 min -> PASS.
