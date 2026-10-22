# DECISIONS

Every judgment call made during the autonomous build: what, why, alternatives.

## Step 0: environment
- **git binary.** `/usr/bin/git` refuses to run (Xcode license not accepted; accepting needs `sudo`, which is off-limits). All git commands use `DEVELOPER_DIR=/Library/Developer/CommandLineTools` so the Command Line Tools git (2.39.5) is used. No global config changed. Alternative (accept the Xcode license) needs sudo.
- **Python.** System `python3` 3.13.5 in `.venv`; LightGBM 4.7.0 imported without needing libomp/conda, so no fallback was needed.
- **Repo visibility.** `api.github.com/repos/1628745/Case-a-thon2026` returns 200 (public), so GitHub Pages can serve `/docs` from `main`. `gh` is authenticated.
