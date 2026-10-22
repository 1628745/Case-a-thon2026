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
- [ ] 7 Grid pass 1 (main, controls, dose, shelf_life)
- [ ] 8 Discovery + tuning, DISCOVERY.md
- [ ] 9 Freeze (tag guard-v1-frozen) + final evaluation
- [ ] 10 Aggregate, export, in-browser model check
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
