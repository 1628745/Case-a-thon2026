DONE (2026-10-22 02:35 ET). Site: https://1628745.github.io/Case-a-thon2026/ · tag guard-v1-frozen

# PROGRESS

## Summary for the team
1. Decision studied: delivery promise (P50 + P80 LightGBM, retrained weekly) on LaDe Chongqing, 904,679 packages, 26 weeks.
2. The poison is the source, not the age: a sloppy courier feed raises MAE in proportion to its share (dose 0/15/35/60% -> 191/196/203/215 min); older data never hurt (no shelf-life U-curve; frozen features cost 0; only a never-retrained model drifts, +2.5 min).
3. Damage enters every link in week 5, the first week sloppy rows reach training (labels -> probe promises -> width/miss), MAE follows by week 8; it lands mostly on the sloppy couriers' own packages (+40 min).
4. Guard (frozen: keep history, h=4, lambda=0.5, k=4) on held-out weeks 22-25: recovers 90% of the low-quality gap, 78% combined, 52% stale; +0.03% MAE on clean data; 5-8% deferral; detector precision 0.94-0.95.
5. Held-out scorecard 5/6 (dev 6/7): Promise quality fails (calibrated promise 2-4% wider on clean data).
6. Clear failure: unseen early-scan defect, 7% recovered; L1 catches 0.1% of it and the monitor stays quiet. Shown on the site.
7. Discovery overturned a plan rule: dropping 7-day-old features caused the Guard's combined failure; logged and tested in the one sweep.
8. In-browser models match Python exactly (80 predictions, max diff 0).
9. All judgment calls: DECISIONS.md; findings: DISCOVERY.md; talk + 15 Q&A: PRESENTATION.md.
10. GitHub Pages is enabled (main /docs); no raw data, ids or coordinates in git.

## Team to-dos
- Record the fallback video (shot list in PRESENTATION.md) and put its URL in docs/data/text.json as "video".
- Rehearse the 10-minute run of show on the live site; review DISCOVERY.md (held-out rerun is ~12 min if settings change).



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
- [x] 11 Website complete + Pages
- [x] 12 Paperwork, presentation kit, final review, DONE

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
- 2026-10-22 02:10 ET, step 11: site on real results; served locally: 19/19 assets HTTP 200, all docs JSON valid, no console errors, all 15 charts and every table render, no horizontal overflow at 1440x900 or 375 px (checked in the app's browser pane instead of Playwright); GitHub Pages enabled: https://1628745.github.io/Case-a-thon2026/
- 2026-10-22 02:35 ET, step 12: MANIFEST, README, AI_DISCLOSURE, PRESENTATION final; final review subagent: 3 material + 3 minor text findings (site Guard text matched rejected settings, volume 2.9x, manifest.json subset fields) all fixed; 19 tests pass; pushed. DONE.
