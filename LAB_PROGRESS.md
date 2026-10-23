# LAB_PROGRESS

Status: IN PROGRESS (L5).

origin/main at L0: 0a2bb7ac0fd2341b5d267acd3347874b64b9bc70 (must be unchanged at DONE). Resume at the first unchecked step. Blockers (if any) go here at the top.

## Steps (see LAB_PLAN.md section 8)
- [x] L0 Branch live-demo, read the site and src, baseline tests
- [x] L1 Importable core + build_lab.py + docs/py/guardlab + parity tests
- [x] L2 Native lab experiment (lab_native.py) + result schema
- [x] L3 Synthetic sample
- [x] L4 Web Worker with Pyodide
- [ ] L5 lab.html: steps 1-5 + P1 results
- [ ] L6 P2 features
- [ ] L7 Yantai parity, cached fallback, performance budgets
- [ ] L8 P3 (if time)
- [ ] L9 Nav link, regression smoke test, screenshots
- [x] L10 Review, LAB_TESTING.md, local server running, DONE

## Log
(one line per milestone: timestamp, step, what happened, timings)
- 2026-10-23 L0: caffeinate running; pull --ff-only: already up to date; branch live-demo created; pytest 19 passed (10.9 s).
- 2026-10-23 L1: src refactors + src/lab.py + build_lab.py + docs/py/guardlab + tests/test_lab_parity.py; pytest 30 passed (13.6 s). Native Yantai sloppy-20% run 2.9 s.
- 2026-10-23 L2: lab_native.py; synthetic + Yantai all presets run natively (Yantai sloppy 95.7/136.2/98.8 MAE, 92% recovered; end to end 3.5 s). Schema in DECISIONS.md.
- 2026-10-23 L3: synthetic sample 23,143 rows / 3.5 MB, 8 full weeks, 45 couriers, 267 areas, P99 duration 36 h, city=SYNTHETIC; deterministic (same sha on rebuild); native sloppy run 1.1 s, Guard recovers 95%.
- 2026-10-23 L4: docs/lab-worker.js (Pyodide 0.29.4: pandas 2.3.3, LightGBM 4.6.0). tests/e2e_lab.py worker: 7/7 (same schema as native; sample MAE within 0.1% of native). Cached load 3.9 s, audit 0.14 s, sloppy run 3.2 s.
