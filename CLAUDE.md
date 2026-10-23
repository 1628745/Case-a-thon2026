# Case-a-thon 2026: phase 2, "Try it" live demo (autonomous build)

Phase 1 (study, results, narrative site) is DONE: see PROGRESS.md, DISCOVERY.md, DECISIONS.md, PLAN.md. The current task is the live demo page described in **LAB_PLAN.md**. Work **unattended**: the user is away and will test on localhost when you finish.

Read `LAB_PLAN.md` and `LAB_PROGRESS.md` at the start of every session and after every context compaction, then resume at the first unchecked step.

## Operating rules

1. Work through LAB_PLAN.md section 8 (steps L0-L10) in order. Run each step's "must pass" checks and show their output before ticking it in LAB_PROGRESS.md.
2. **IMPORTANT: never push.** No `git push`, no merging into `main`, no GitHub Pages or `gh` changes, no tags pushed. Work on the local branch `live-demo` and commit there after every step (explicit paths, never `git add -A` or `git add .`). The user will publish after testing.
3. Do not ask the user questions and do not stop to report progress. Log judgment calls under a "Phase 2" heading in DECISIONS.md and continue.
4. Stop only for: data files missing or corrupted; Pyodide or LightGBM-in-Pyodide impossible after three different fixes (then build the cached-result fallback, document it, and finish everything else); disk full. Write blockers at the top of LAB_PROGRESS.md.
5. **Never commit data.** No LaDe rows, raw courier IDs or coordinates in git or in `docs/`. Only the generated synthetic sample (`docs/data/lab_sample.csv`) and aggregate JSON may be committed. Run `git status --short` before every commit.
6. **Don't break the existing site.** `docs/index.html`, `docs/app.js`, `docs/style.css` were redesigned by a teammate; only add the "Try it" nav link (and an optional key `5`). The regression smoke test must pass.
7. **Never tune the Guard on uploaded data.** Use the frozen `config.yaml` guard settings. Show results honestly, including when the Guard doesn't help.
8. Keep the Mac awake: if `pgrep -x caffeinate` finds nothing, run `nohup caffeinate -dimsu > /dev/null 2>&1 &`.
9. Long-running commands (over ~3 minutes) go in the background with logs in `logs/`; keep working meanwhile.
10. Stay inside this folder. No `sudo`, no deleting outside the repo, no global config changes. Python packages go into `.venv`; Node packages (if needed) into a temp folder under `logs/` or `.cache/`, never into `docs/`.
11. Context hygiene: keep command output short. Use a review subagent before finishing (LAB_PLAN.md section 7, item 6).
12. Finish by leaving the local server running (`nohup .venv/bin/python -m http.server 8000 -d docs > logs/server.log 2>&1 &`), writing LAB_TESTING.md, and putting DONE at the top of LAB_PROGRESS.md. Your final message tells the user the URL to open and points to LAB_TESTING.md.

## Environment

- macOS, Apple Silicon. Repo https://github.com/1628745/Case-a-thon2026 (public).
- **git:** `/usr/bin/git` refuses to run (Xcode license not accepted). Prefix git commands with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`, as in phase 1 (see DECISIONS.md step 0).
- Python: `.venv` (Python 3.13, pandas 3.0.6, LightGBM 4.7.0). Browser code runs on Pyodide 0.29.4 (pandas 2.3.3, LightGBM 4.6.0): write code that works on both.
- Data: `data/raw/delivery_cq.csv` (Chongqing), `data/raw/delivery_yt.csv` (Yantai, use for parity and E2E). Both git-ignored.
- Node is installed (phase 1 ran `node scripts/check_models.js`).

## Done means

Every item in LAB_PLAN.md section 9 "Definition of done" is true.
