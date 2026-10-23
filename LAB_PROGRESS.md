# LAB_PROGRESS

Status: IN PROGRESS (L2).

origin/main at L0: 0a2bb7ac0fd2341b5d267acd3347874b64b9bc70 (must be unchanged at DONE). Resume at the first unchecked step. Blockers (if any) go here at the top.

## Steps (see LAB_PLAN.md section 8)
- [x] L0 Branch live-demo, read the site and src, baseline tests
- [x] L1 Importable core + build_lab.py + docs/py/guardlab + parity tests
- [ ] L2 Native lab experiment (lab_native.py) + result schema
- [ ] L3 Synthetic sample
- [ ] L4 Web Worker with Pyodide
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
