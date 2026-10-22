# Data Shelf-Life Guard (Case-a-thon 2026)

W&M AI Club Case-a-thon 2026, case "Unintentional Data Poisoning". **When does more information make an AI-enabled decision process worse, and what evidence shows that an intervention restores useful performance?**

We answer it on six months of real last-mile deliveries (LaDe, Chongqing, 904,679 packages). A dispatcher must promise a delivery window when a courier accepts a package; two LightGBM models, retrained every week, give the expected duration (median) and the promise (80th percentile). We degrade the weekly feed three ways (stale training history and frozen features; a sloppy source that bulk-scans and re-uploads; both), measure the damage link by link (data → training signal → model → decision), and test a three-layer **Guard** (ingest checks, trust-weighted training, a serve-time check with a calibrated promise and deferral to a person). Settings were frozen before the held-out weeks and an unseen defect were scored.

## Results in one paragraph

On held-out weeks 22-25 (scored once, after the Guard settings were frozen at git tag `guard-v1-frozen`), the Guard recovered **90%** of the MAE lost to a sloppy data source and **78%** under sloppy + stale data, at +0.03% MAE on clean data and 5-8% of packages deferred to a dispatcher; its ingest checks flag injected records with 94-95% precision. It passes 5 of 6 held-out scorecard lines: the calibrated promise is 2-3% wider than the unguarded one on clean held-out data (4% on development weeks) (Promise quality fails). It **failed** on a defect it was never tuned on (couriers scanning packages delivered early): 7% recovery. Discovery also showed that old data was not the problem here (no shelf-life U-curve; frozen features cost nothing) and that the original plan's rule of dropping 7-day-old features was itself harmful.

- **Website (the presentation):** https://1628745.github.io/Case-a-thon2026/ (served from `docs/`)
- **Findings:** `DISCOVERY.md`; headline numbers and the scorecard in `results/results.json`
- **Run of show and judge Q&A:** `PRESENTATION.md`
- **Data manifest:** `MANIFEST.md` · **AI disclosure:** `AI_DISCLOSURE.md` · **Every judgment call:** `DECISIONS.md` · **Build log:** `PROGRESS.md`

## Reproduce

Requirements: Python >= 3.10 (built with 3.13.5 on macOS arm64), about 3 GB RAM per worker. Exact versions are pinned in `requirements.txt`.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# place delivery_cq.csv (and optionally delivery_yt.csv) in data/raw/  -- not redistributed (LaDe terms)
python -m src.audit                 # results/audit.json
python -m src.prep                  # data/processed/cq.parquet
python -m pytest -q tests           # leakage, injector and Guard tests
python -m src.jobs                  # results/jobs.csv: main, shelf_life, dose, controls
python -m src.run --all             # resumable; results/runs/<run_id>/
python -m src.aggregate             # results/*.parquet, results/results.json
python -m src.jobs --tune && python -m src.run --all --family tune,atlas && python -m src.discovery   # dev weeks only
python -m src.jobs --final && python -m src.run --all --family final && python -m src.aggregate
python -m src.export_site           # docs/data/*.json, docs/models/*.json
node scripts/check_models.js        # in-browser model check (20 inputs)
python -m http.server -d docs 8000  # view the site
```

Runtime on a 14-core Apple Silicon laptop (4 workers × 3 threads): grid pass 1 (46 runs, 828 weekly retrains) 38 min; tuning sweep (40 runs) 51 min; Guard reruns with the chosen settings (16 runs) 22 min; held-out evaluation (30 runs) about 12 min. Every parameter is in `config.yaml`; every result row carries `config_hash` and `git_sha`.

## Layout

```
config.yaml            all parameters
src/audit.py           observed issues -> results/audit.json
src/prep.py            parse, clean, features (history features use only deliveries scanned before the row's day)
src/degrade.py         stale / bulk-scan / re-upload / early-scan injectors + modification log
src/guard.py           L1 ingest checks, L2 weights + reputation, L3 conformal promise + deferral
src/model.py           median and P80 LightGBM models
src/walkforward.py     one run: weekly walk-forward retraining -> metrics, detector, diagnostics
src/diagnose.py        SHAP importance, synthetic probe grid, training-signal chain metrics
src/jobs.py, run.py    experiment grid, parallel resumable runner
src/aggregate.py       merge runs, scorecard, results.json
src/export_site.py     aggregates and models for the website
tests/                 leakage, injectors, Guard
docs/                  the website (GitHub Pages)
results/               aggregated results (committed); per-run outputs stay local
```

No raw or processed data is committed. The site shows only aggregates, a synthetic probe grid, constructed scenarios and trained models.
