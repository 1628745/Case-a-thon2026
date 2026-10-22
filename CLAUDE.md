# Case-a-thon 2026: autonomous build

You are building the complete W&M AI Club Case-a-thon 2026 submission (case: "Unintentional Data Poisoning", dataset: LaDe last-mile delivery) in this repo, **unattended**. The user is asleep or away. They chose this; do not wait for them.

- `PLAN.md` is the full spec: decisions, experiment design, Guard, website, execution order, definition of done.
- `PROGRESS.md` is the step log. **Read both at the start of every session and after every context compaction**, then resume at the first unchecked step.
- `DECISIONS.md` (you create it) records every judgment call: what, why, alternatives.

## Operating rules

1. Work through PLAN.md "Execution order" steps 0-12 in order. Each step's "must pass" checks must be run, with their output shown, before you tick it.
2. **Do not ask the user questions and do not stop to report progress.** When a choice is needed, pick per PLAN.md defaults, log it in DECISIONS.md, and continue. Reviews in PLAN.md are asynchronous: write the review document, then keep going.
3. Stop only for: data files missing or corrupted; `git push` still failing after three different fixes; disk full. In that case write the blocker at the top of PROGRESS.md, commit locally, and stop.
4. After every step: update PROGRESS.md, `git add` **explicit paths** (never `git add -A` or `git add .`), commit with a clear message, `git push`.
5. **IMPORTANT: never commit raw or processed data.** `delivery_cq.csv` is 145 MB (GitHub rejects files over 100 MB) and LaDe's terms do not allow redistribution. Step 0 moves both CSVs to `data/raw/`, and `.gitignore` already covers `data/`, `*.csv`, `*.parquet` (except `results/*.parquet`), `.venv/`, `results/runs/`, `logs/`. Run `git status --short` before every commit and make sure no CSV or large file is staged.
6. Long runs (anything over ~3 minutes): launch in the background with `nohup ... > logs/<name>.log 2>&1 &`, keep working on other steps (site skeleton, diagnostics code, docs), and check progress by reading the log and the runner's progress file. The runner must be resumable (skip finished runs).
7. Keep the Mac awake: at session start, if `pgrep -x caffeinate` finds nothing, run `nohup caffeinate -dimsu > /dev/null 2>&1 &`.
8. Stay inside this folder. No `sudo`, no deleting anything outside the repo, no global config changes. Install packages only into `.venv` (or a conda env named `lade`, see Environment).
9. Scientific honesty: never tune on held-out weeks 22-25; never use injection labels as model features or Guard inputs (only to score detectors); keep chronological order; report failures on the site. If the Guard fails a scorecard line, say so.
10. Context hygiene: keep command output short (`head`, `tail`, quiet flags, summaries). Before the freeze (step 9) and before the final push (step 12), run a review subagent on the diff against PLAN.md; fix only findings that affect correctness or stated requirements.
11. Schedule: target all steps done by Thu 2026-10-22 23:00 ET; hard deadline Fri 2026-10-23 18:00 ET. If step 9 has not started by Thu 2026-10-22 14:00 ET, apply PLAN.md "Cut list" in order and log it.

## Environment

- macOS on Apple Silicon. Remote: https://github.com/1628745/Case-a-thon2026 (HTTPS; push credentials are in the macOS keychain and a push has already succeeded).
- Python: `python3 -m venv .venv && source .venv/bin/activate` (Python >= 3.10). Install from `requirements.txt` and pin exact versions with `pip freeze` once working.
- If `import lightgbm` fails (usually missing libomp): try `brew install libomp`; if that fails, use miniconda: `~/miniconda3/bin/conda create -y -n lade -c conda-forge python=3.11 lightgbm pandas pyarrow scikit-learn shap pyyaml joblib`; last resort, sklearn `HistGradientBoostingRegressor` (loss `absolute_error` / `quantile` with quantile=0.8). Record the choice in DECISIONS.md and MANIFEST.md.
- Parallelism: `workers = max(1, os.cpu_count() // 3)`, threads per model = `max(1, os.cpu_count() // workers)`.
- Node may or may not be installed; check `command -v node` (also `~/.nvm`). It is only needed to verify the in-browser model; PLAN.md gives a fallback.

## Key paths

- `data/raw/delivery_cq.csv`: main dataset (Chongqing). `data/raw/delivery_yt.csv`: small Yantai copy for smoke tests only.
- `docs/`: the website, served by GitHub Pages from branch `main`, folder `/docs`.

## Done means

Every item in PLAN.md "Definition of done" is true, the last commit is pushed, and PROGRESS.md says DONE at the top with a short summary for the team.
