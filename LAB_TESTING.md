# LAB_TESTING: 5-minute manual test of the "Try it" page

Everything is on the local branch `live-demo`. Nothing has been pushed, and GitHub Pages still serves `main`.

## 0. Open it

A local server was left running. If it isn't, start it:

```bash
.venv/bin/python -m http.server 8000 -d docs
```

Open **http://localhost:8000/lab.html** in Chrome. Within a few seconds the pill under the headline should read **Python ready**, followed by load time, Pyodide 0.29.4, pandas 2.3.3 and LightGBM 4.6.0. The first visit downloads about 30 MB from cdn.jsdelivr.net; after that the browser has it cached.

## 1. Synthetic sample (about 1 minute)

1. Step 1: click **Use the synthetic sample**. File info shows `lab_sample.csv (synthetic)`, 3.5 MB, 23,143 rows.
2. Step 2 fills in: 8 full weeks, 45 couriers, a weekly bar chart (yellow = test week, blue = training weeks), and a table of issues already in the file (a few zero durations, late GPS fixes and far fixes were planted on purpose).
3. Step 3: **Sloppy couriers 20%** is already selected.
4. Step 4: click **Run the experiment**. The progress bar and step log move, and it finishes in about 3-5 s.
5. Step 5 should show:
   - A green banner: "The Guard recovered ~96% of the damage: MAE 196.0 → 172.1 min (reference 171.0)."
   - Four KPI cards (Reference / Poisoned, Guard off / Poisoned, Guard on / Damage recovered).
   - A bar chart of MAE and P90 error.
   - Guard activity tiles.
   - A detector scorecard (precision and recall around 90%+).
   - A reputation histogram and a table of the 10 lowest couriers. Most rows say "yes (sloppy)".

## 2. P2 features (about 2 minutes)

- **Explain a prediction:** switch the "Package" dropdown between the 5 examples. You get two waterfalls (Guard off vs on) and the L3 card (Approve/Defer with reasons). In "From a courier the poison dial made sloppy", the courier 14-day mean is inflated without the Guard and lower with it; those cells are red in the feature table.
- **Human in the loop:** tick **Release** on one courier, then click **Rerun with my overrides**. The line under the button reports the change, e.g. "With 1 courier(s) released: Guard-on MAE 172.1 → 171.7 min…".
- **Downloads:** click `lab_report.json`, `quarantine.csv` and `model_card.md`. All three are generated in the browser.
- **Compute vs human effort:** training seconds and ms per prediction appear next to dispatcher minutes, at an assumed 45 s per deferred package.
- **Sweep the dial** (P3): runs 8 model pairs in about 10-20 s and draws MAE vs sloppy share. Guard off climbs from 171 to 269 min; Guard on stays near 171-178.

## 3. Honesty checks (about 1 minute)

- Pick **Clean as uploaded** and run. You get two runs plus a "Cost of the Guard" card (about −0.2 min on the sample), and the detector says nothing was injected.
- Start a run and press **Cancel**. The log says "Cancelled", and Python restarts in the background (about 4 s).

## 4. Real data: Yantai (about 1 minute)

Drag `data/raw/delivery_yt.csv` onto the drop zone. The audit takes under a second: 206,431 rows, 26 full weeks, 205 couriers, test week Oct 23, 2022. Run the default preset. It finishes in about 10-15 s with "The Guard recovered 92% of the damage: MAE 136.2 → 99.1 min (reference 95.7)."

`delivery_cq.csv` (Chongqing, 145 MB) also works: it keeps the last 7 full weeks and the run takes about 50 s.

## 5. Narrative page

Open http://localhost:8000/index.html. The header has a yellow-outlined **Try it** link, and pressing `5` also opens the lab. Nothing else on the page changed.

## What was measured (headless Chromium on this Mac)

| Item | Budget | Measured |
| --- | --- | --- |
| Python first load (fresh profile) | ≤ 40 s | 5.9-6.5 s (fast connection) |
| Python load, cached | ≤ 5 s | 4.0 s |
| Yantai audit | ≤ 15 s | 0.1 s |
| Default run, Yantai | ≤ 90 s | 10.5 s |
| Default run, synthetic | ≤ 45 s | 3.3 s |
| Chongqing full file | ≤ 5 min | 47-48 s |

Browser vs native parity on Yantai (Sloppy 20%, Quick, seed 0), MAE in minutes: 95.74/95.74, 136.23/136.23, 99.08/98.78 (within 0.3%).

## Known limits

- One train/test split and one seed per run, so MAE differences under about 1% are noise. The banner says so when the gap is below that.
- The Quick budget caps training at 120,000 rows, taking whole couriers in a seeded order. On big files some test areas are then unseen in training and get deferred (Yantai stale preset: ~19% deferred).
- Stale preset on Yantai: the Guard recovers only ~12%. Early scans: the Guard is slightly worse. Both match the study's findings and are shown as they come out.
- Explain examples are auto-picked, not user-selectable packages.
- The new-city card is on the lab page, not on index.html; the plan only allows the nav link there.
- Mobile works at 390 px, but the experiment is meant for a laptop. Phones can run out of memory on big files.
- Tests: `.venv/bin/python -m pytest -q` (30 tests) and `.venv/bin/python tests/e2e_lab.py all` (needs network for Pyodide and `data/raw/delivery_yt.csv`).

## Publish (run only after you approve)

> **Run these only after you've tested and approved the page.** They push to GitHub and update the live site.

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git switch main
```

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git merge --ff-only live-demo
```

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git push
```

GitHub Pages rebuilds from `main` `/docs` within a minute or two. The page is then at https://1628745.github.io/Case-a-thon2026/lab.html.
