DONE

# LAB_PROGRESS

**Summary.** Built `docs/lab.html` ("Try it"). Anyone can load a LaDe-format CSV (or the synthetic sample), audit it, poison it with the study's defects (5 presets plus advanced controls), and train the median and P80 LightGBM models with the frozen Guard off and on, all in a Pyodide Web Worker inside the browser. Nothing is uploaded.
- **Results:** P1, P2 (explain waterfalls with the L3 card, releasing couriers by hand, three downloads, compute vs human effort) and P3 (dose sweep, new-city card on the lab page).
- **Yantai** (Sloppy 20%, Quick, seed 0): MAE 95.7 reference / 136.2 Guard off / 99.1 Guard on, 92% of the damage recovered. Browser matches native within 0.3%.
- **Timings** (headless Chromium): Python load 4 s cached and 6 s cold; synthetic run 3.3 s; Yantai run 10 s; Chongqing full file 47 s.
- **Tests:** pytest 31 passed; `tests/e2e_lab.py all` 86/86 with zero console errors.
- **Cut or changed:** the new-city card is on the lab page, not index.html (constraint 4). The full-week rule was changed so Chongqing's stray late dates don't break it. See DECISIONS.md "Phase 2".
- **Nothing pushed.** origin/main is unchanged (0a2bb7a).

Status: DONE.

origin/main at L0: 0a2bb7ac0fd2341b5d267acd3347874b64b9bc70 (must be unchanged at DONE). Resume at the first unchecked step. Blockers (if any) go here at the top.

## Steps (see LAB_PLAN.md section 8)
- [x] L0 Branch live-demo, read the site and src, baseline tests
- [x] L1 Importable core + build_lab.py + docs/py/guardlab + parity tests
- [x] L2 Native lab experiment (lab_native.py) + result schema
- [x] L3 Synthetic sample
- [x] L4 Web Worker with Pyodide
- [x] L5 lab.html: steps 1-5 + P1 results
- [x] L6 P2 features
- [x] L7 Yantai parity, cached fallback, performance budgets
- [x] L8 P3 (if time)
- [x] L9 Nav link, regression smoke test, screenshots
- [x] L10 Review, LAB_TESTING.md, local server running, DONE

## Log
(one line per milestone: timestamp, step, what happened, timings)
- 2026-10-23 L0: caffeinate running; pull --ff-only: already up to date; branch live-demo created; pytest 19 passed (10.9 s).
- 2026-10-23 L1: src refactors + src/lab.py + build_lab.py + docs/py/guardlab + tests/test_lab_parity.py; pytest 30 passed (13.6 s). Native Yantai sloppy-20% run 2.9 s.
- 2026-10-23 L2: lab_native.py; synthetic + Yantai all presets run natively (Yantai sloppy 95.7/136.2/98.8 MAE, 92% recovered; end to end 3.5 s). Schema in DECISIONS.md.
- 2026-10-23 L3: synthetic sample 23,143 rows / 3.5 MB, 8 full weeks, 45 couriers, 267 areas, P99 duration 36 h, city=SYNTHETIC; deterministic (same sha on rebuild); native sloppy run 1.1 s, Guard recovers 95%.
- 2026-10-23 L4: docs/lab-worker.js (Pyodide 0.29.4: pandas 2.3.3, LightGBM 4.6.0). tests/e2e_lab.py worker: 7/7 (same schema as native; sample MAE within 0.1% of native). Cached load 3.9 s, audit 0.14 s, sloppy run 3.2 s.
- 2026-10-23 L5: lab.html/lab.css/lab.js (steps 1-5, P1 results, cached fallback). tests/e2e_lab.py lab 63/63: synthetic default run 3.3 s (budget 45 s), clean run, Yantai audit 0.1 s, Yantai run 10.5 s (budget 90 s), zero console errors, no overflow at 1440/390.
- 2026-10-23 L6: P2 covered by e2e: explain (5 examples, TreeSHAP waterfalls + L3 card), release courier + rerun (diff shown), downloads lab_report.json / quarantine.csv / model_card.md validated (synthetic, clean, Yantai), compute vs human tiles.
- 2026-10-23 L7: Yantai parity (Sloppy 20%, Quick, seed 0) browser vs native MAE: reference 95.74 vs 95.74, poisoned off 136.23 vs 136.23, poisoned on 99.08 vs 98.78 (0.3%; LightGBM 4.6 vs 4.7). Cached fallback docs/data/lab_cached_yantai.json (aggregates only). Budgets (headless Chromium, this Mac): cold Python load 5.9 s (fresh profile; <= 40), cached 4.0 s (<= 5), Yantai audit 0.1 s (<= 15), Yantai default run 10.5 s (<= 90), synthetic 3.3 s (<= 45), Chongqing full file 48 s end to end incl. audit (<= 300; kept last 7 weeks, 931k rows read, 120k training cap).
- 2026-10-23 L8: P3 sweep (synthetic 0/20/40/60%: MAE off 171/196/233/269, on 171/172/175/178) and new-city card (lab page). e2e lab 64/64.
- 2026-10-23 L9: 'Try it' header link + key 5 on index.html (+1 CSS rule, keys hint updated). Smoke 11/11: same 4 sections, 28 SVGs, 10 charts as the pre-change baseline, zero console errors, no overflow at 1440/390, link and key 5 open lab.html. Screenshots in logs/lab_screens/.
- 2026-10-23 L10: review subagent (0 high, 2 medium, 4 low); fixed 3 medium/2 low (DECISIONS.md L10). pytest 31 passed; e2e all 86/86 (worker 7, lab 64, smoke 11, budgets 4), zero console errors. LAB_TESTING.md written; server left running on :8000.
