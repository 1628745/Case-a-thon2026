# DECISIONS

Every judgment call made during the autonomous build: what, why, alternatives.

## Step 0: environment
- **git binary.** `/usr/bin/git` refuses to run (Xcode license not accepted; accepting needs `sudo`, which is off-limits). All git commands use `DEVELOPER_DIR=/Library/Developer/CommandLineTools` so the Command Line Tools git (2.39.5) is used. No global config changed. Alternative (accept the Xcode license) needs sudo.
- **Python.** System `python3` 3.13.5 in `.venv`; LightGBM 4.7.0 imported without needing libomp/conda, so no fallback was needed.
- **Repo visibility.** `api.github.com/repos/1628745/Case-a-thon2026` returns 200 (public), so GitHub Pages can serve `/docs` from `main`. `gh` is authenticated.

## Step 1: audit (results/audit.json, results/audit_yt.json)
- **Time format.** `accept_time`, `accept_gps_time`, `delivery_time`, `delivery_gps_time` are `MM-DD HH:MM:SS` with no year. We prepend 2022. `ds` (MMDD) equals the parsed accept date for 99.9986% of Chongqing rows, confirming the parse. 0 unparseable values.
- **Coverage.** Chongqing: 931,351 rows (PLAN said "roughly 1M"); accept dates 2022-05-01 to 2022-12-08. All 26 weeks 0-25 present; 22,043 rows outside weeks 0-25 (Oct 30 onward, plus 2 stray December rows) are dropped. Weekly volume 21k-37k in weeks 0-22, then a ramp: week 23 = 53.9k, 24 = 74.0k, 25 = 86.7k (held-out block; a real regime change on top of Golden Week).
- **Observed (pre-existing) issues, Chongqing:** duration <= 0: 4,853 rows (dropped, per PLAN); duration > 12 h: 48,584 (kept); > 24 h: 31,231 (kept); same-minute bursts of >= 5 packages per courier: **0**; missing GPS: 0; **GPS fix age is exactly 0 for every row**; courier-to-stop distance > 30 km: 2,384; duplicate order ids: 0. Duration median 151 min, P90 488 min, P99 3,333 min (heavy tail of next-day deliveries).
- **Consequence: GPS-age checks are inert.** Because `accept_gps_time == accept_time` everywhere, the L1 GPS-age flag and the L3 GPS-age deferral never fire on this data. We keep them (they cost nothing and the console shows them) and say on the site that this data cannot test them. Alternative (synthesize GPS lag) rejected: it would be an untested invented defect.
- **Consequence: burst check is clean.** Zero natural same-minute bursts means the L1 burst flag has no false positives from honest couriers in the raw data; any precision loss will come from injected-but-unflagged rows and from couriers who become bursty only via injection.
- **Heavy tail kept.** PLAN locks minimal cleaning; the > 24 h tail stays and will dominate P90 error. Alternative (cap at 24 h) rejected to honor the lock.
