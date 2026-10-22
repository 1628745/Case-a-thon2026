# MANIFEST

Data manifest for the Case-a-thon 2026 submission. A machine-readable copy is `docs/data/manifest.json`.

## Source

| Item | Value |
| --- | --- |
| Dataset | LaDe: Last-mile Delivery dataset (Cainiao-AI), delivery subset |
| Sources | https://huggingface.co/datasets/Cainiao-AI/LaDe , https://github.com/wenhaomin/LaDe |
| Retrieved | 2026-10-21 (files supplied by the team) |
| Rights | Repository metadata: **Apache-2.0**. Authors' paper: **CC BY-NC 4.0**. We treat the stricter terms as binding: non-commercial research use, no redistribution of the raw files. |

## Files

| File | Use | Bytes | SHA-256 | Raw rows |
| --- | --- | --- | --- | --- |
| `data/raw/delivery_cq.csv` (Chongqing) | all experiments | 145,068,417 | `114a35e9a31f817a3c9efb8513924688706bcedfa85ccd69df696eb5e8eddea2` | 931,351 |
| `data/raw/delivery_yt.csv` (Yantai) | smoke tests only | 31,532,960 | `aa5bca7fdaa8c89d4ab50a2ed2b94fb09f608acc49fc1108a1a612e9c0f5a7ad` | 206,431 |

Neither file is in git (`.gitignore` covers `/data/`, `*.csv`, `*.parquet`). The raw files are read-only inputs: every degradation is applied to an in-memory copy, so the untouched reference copy is always the file on disk, and its SHA-256 above can be re-checked with `shasum -a 256`.

## Study subset (after filters)

| Item | Value |
| --- | --- |
| Rows kept | 904,679 packages (one row = one package = one independent case for scoring) |
| Couriers | 1,449 |
| Areas (`aoi_id`) | 17,382 |
| Regions | 48 |
| Accept dates | 2022-05-01 06:11 to 2022-10-29 22:49 |
| Weeks | 26 Sunday-Saturday weeks from 2022-05-01 (week 0) to 2022-10-29 (week 25); 20,925 to 85,991 packages per week |
| Splits | warm-up 0-3 (history only), development 4-21, held-out 22-25 |

## Fields and units

| Field | Meaning | Used as |
| --- | --- | --- |
| `order_id` | package id | duplicate check (Guard L1); never a feature |
| `region_id`, `aoi_id`, `aoi_type` | region, area of interest, area type (integer codes) | features |
| `courier_id` | courier id | source identity for Guard reputation and history features; never a feature, never published |
| `lng`, `lat` | stop location (degrees) | features; never shown on the site |
| `accept_time` | package accepted by courier, `MM-DD HH:MM:SS` (no year; 2022 prepended) | hour, minute of day, day of week |
| `accept_gps_time`, `accept_gps_lng`, `accept_gps_lat` | courier GPS fix at acceptance | courier-to-stop distance (km, haversine); GPS fix age (min, Guard metadata) |
| `delivery_time` | delivery scan, same format | target only: `duration_min = delivery_time - accept_time` (minutes); history features read other packages' scans before the row's day |
| `delivery_gps_*` | GPS at delivery | not used |
| `ds` | accept date as MMDD | cross-check of the parsed date (matches 99.9986%) |

Derived features (known at acceptance): open workload (courier's packages accepted earlier that day and not yet scanned delivered), courier and area 14-day history means (packages accepted in the previous 14 days and delivered before the row's day).

## Filters and missing values

- Kept: accept date in weeks 0-25 and `duration > 0`. Dropped: 4,853 rows with duration <= 0; 22,043 rows accepted from 2022-10-30 on (incl. 2 stray December rows); 0 unparseable times.
- No field has missing values in the raw file. Missing values arise only in the history features (no prior deliveries for that courier/area in the window: 1.8% / 5.8% of rows) and, under the stale condition or the Guard's 7-day rule, when history is frozen or dropped. LightGBM handles NaN natively.

## Observed issues (present in the raw data, kept, counted in `results/audit.json`)

| Issue | Rows (Chongqing raw) |
| --- | --- |
| duration <= 0 (dropped) | 4,853 |
| duration > 12 h | 48,584 |
| duration > 24 h | 31,231 |
| same-minute bursts (>= 5 packages, one courier) | 0 |
| missing GPS | 0 |
| GPS fix age > 30 min (fix age is 0 for every row) | 0 |
| courier-to-stop distance > 30 km | 2,384 |
| duplicate package ids | 0 |

## Introduced changes (experiments only; never written back to the raw files)

All injected changes are listed per condition, seed and week in `results/modification_log.csv` (affected couriers are recorded only as a hash of the sorted id list). See PLAN.md section 4 and DECISIONS.md for exact parameters:

- **stale**: training on all past weeks; history features frozen with data through 2022-06-25.
- **low_quality**: 20% of warm-up couriers become bulk scanners from week 4 (probability ramps 0.10 -> 0.90 by week 21) and re-upload records from week 10 (probability 0.8).
- **combined**: both.
- **unseen** (held-out only): a disjoint 15% of couriers scan early (40-70% of the true duration) from week 18.

Scoring always uses the untouched durations.
