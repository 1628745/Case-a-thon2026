# PRESENTATION KIT

Everything is shown on the website (`docs/`, GitHub Pages). Each nav section is one "slide". Total 10:00. Numbers below come from `results/results.json` (section keys in brackets) so any judge question can be traced.

## Run of show

| Time | Section | Say (speaker notes) |
| --- | --- | --- |
| 0:00-1:00 | **1 Overview** | "A dispatcher in Chongqing accepts a package and has to promise when it arrives. Two LightGBM models, retrained every week on the last four weeks of deliveries, set that promise. Whatever enters the weekly feed enters the promise. We asked: when does more data make the promise worse, and can we prove a fix restores it?" Point to the four-link chain and the three headline numbers. Thesis: *data has a shelf life and a source reputation, and in this feed the reputation is what matters.* |
| 1:00-3:00 | **2 Console** | Normal package first: same answer Guard off and on, all checks green, Approve. Then *Sloppy-source area*: Guard off happily promises a padded window; Guard on uses the quarantined feed, shows the courier's low reputation. Then *Rare area*: area never seen in four weeks, Guard defers to the dispatcher with the reason. Use the correction panel: override the promise, tick "flag source", add a note, log it; point at the review-time estimate. Mention the predictions are computed live in the browser by the exported trees (inference time shown). |
| 3:00-4:45 | **3 Timeline** | Show MAE, Guard off only, 4 conditions: low quality pulls away from reference from week 5 and keeps growing as bulk scanning ramps up; stale barely moves. Switch Guard to "on": the low-quality and combined lines fall back onto reference. Switch the metric to miss rate: everything sits inside the 15-25% band. Data tracks underneath: injected rows carry ~10% of the training weight without the Guard and ~1% with it (the sloppy couriers' honest rows are kept). Shaded region = held-out weeks scored once after the freeze. |
| 4:45-6:15 | **4 Mechanism** | Four linked charts for low quality: data (injected share) → training labels (KS jumps in week 5) → model (probe promises shift up ~15 min) → decision (MAE gap). Same week for every link: the damage enters with the first sloppy rows. Controls: oracle filter vs Guard vs random removal: random removal of the same volume is *worse than doing nothing*, so it is which rows, not how many. Dose-response is monotonic without the Guard and flat with it. Frozen features cost nothing; a frozen model costs 2.5 min: the model has a shelf life, the history does not. |
| 6:15-7:45 | **5 Countermeasure** | Three layers in one sentence each. The 8-cell table (dev and held-out toggle). Recovery %. Detector: precision above 0.9, false-positive rate under 1%. Shelf-life curve: no U, longer windows never hurt here. Scorecard: say plainly which line fails (Promise quality: the calibrated promise is ~4% wider on clean data) and why we did not loosen it. |
| 7:45-9:00 | **6 Stress tests and limits** | Held-out weeks include Golden Week and a volume surge; plus the unseen early-scan defect the Guard was never tuned on. Read the held-out table. Name the failure(s) shown in red. Tradeoffs: deferral costs people, the Guard down-weights a lot of data, retrains take longer. When not to use it. |
| 9:00-10:00 | **7 Oversight** | Roles (dispatcher, data steward, model owner, ops manager), the correction path, human effort vs compute, the bounded pilot: shadow mode, one district, 4 weeks, checkpoints at weeks 2 and 4, explicit stop conditions. Close on the thesis. |

## Likely judge questions

| # | Question | Short answer | Source |
| --- | --- | --- | --- |
| 1 | Isn't the L1 burst check tailored to your own injected defect? | Partly, and we say so: bulk scanning leaves a same-minute burst, which is exactly what real end-of-shift bulk scans look like. That is why we froze the Guard and then tested an *unseen* defect (early scans) that leaves no burst; the held-out table shows how much the reputation layer alone recovers there. | Stress tests; `results.json` [final.recovery.unseen] |
| 2 | Why is MAE ~190 min when the median delivery is 151 min? | The data has a heavy multi-day tail (3.4% of packages take over 24 h, up to 89 days). We kept it (minimal cleaning) and compare conditions paired by week; MAE on packages <= 24 h is shown too. | MANIFEST observed issues; `mae_trim_min` |
| 3 | How do you know the gains are not noise? | Three seeds; Guard-on seed spreads are 0.03-0.2 min while the gaps are 2.5-5.6 min; a gap only counts if it exceeds the seed spread. | [dev.cells.*.mae_spread] |
| 4 | Did you tune on the test weeks? | No. All exploration and the one tuning sweep used weeks 4-21; the config was tagged `guard-v1-frozen` before weeks 22-25 were scored; every final row carries the config hash. | DISCOVERY.md, git tag, [final_config_hashes] |
| 5 | Do the injection labels leak into the Guard? | No. The Guard reads only feed columns; a test scrambles the labels and checks nothing changes. Labels are used only to score the detector. | `tests/test_guard.py` |
| 6 | Why not just delete flagged rows? | Irreversible, loses rare valid data; quarantine at weight 0.05 keeps them reviewable. Random removal of the same volume made things worse. | [controls] |
| 7 | What does "stale" actually do, and why does it barely hurt? | All-weeks training plus a feature store frozen in June. Courier and area averages are stable over months here, so stale history stays informative. What decays is a model that is never retrained (+2.5 min). | DISCOVERY.md section 2 |
| 8 | Your plan said to drop 7-day-old features. Why did you change it? | Discovery showed that rule caused the Guard's combined-condition failure (recovery -37%); the frozen-features control showed stale features are harmless. We tested it in the single tuning sweep and kept history instead, logged as a deviation. | DECISIONS.md step 8 |
| 9 | Why is the promise wider with the Guard on clean data? | The unguarded P80 under-covers (21.9% misses); the conformal promise is calibrated to 80% per area type, which costs width. We report the scorecard line as failed rather than loosen it. | Scorecard |
| 10 | How many packages get deferred and who handles them? | About 6-8% on dev weeks; the dispatcher handles them with the health card and reason; the data steward reviews flagged sources weekly. | Oversight section |
| 11 | What about rare areas? | Guard-on rare-area MAE is within 2% of reference in every condition (passes the 5% line). Unseen areas are deferred, not guessed. | [dev.scorecard Rare areas] |
| 12 | Could reputation punish honest couriers in unusual areas? | Reputation is shrunk toward neutral with a 30-record prior and compares couriers within the same area and hour; lambda 0.5 halves its effect; the steward can restore a courier. lambda 1 was measurably worse, which is one reason we chose 0.5. | DISCOVERY.md section 6 |
| 13 | Does this generalise to other cities? | The pipeline runs on Yantai (smoke test) unchanged; we have not evaluated it there. A new city needs a few weeks of history for reputation and calibration. | README, limits |
| 14 | Why LightGBM and not a bigger model? | It is the AI component under test; a bigger model would memorise noisy labels more, not less. The trees are small enough to run in a browser. | Countermeasure alternatives |
| 15 | What would you do next? | Run the shadow-mode pilot; measure real review time (we assumed 45 s); add a label-latency model (we assume labels arrive by the next week); test GPS-age checks on data where GPS lag exists. | Oversight, Stress tests |

## Fallback video shot list (record from the live site, 1440x900, ~4 minutes)

1. Overview: slow scroll over thesis, chain, headline numbers (20 s).
2. Console: Normal → Sloppy-source area → Rare area; log one correction (60 s).
3. Timeline: MAE Guard off, then on; then miss rate (40 s).
4. Mechanism: low quality four-chart row; controls; dose-response; frozen (40 s).
5. Countermeasure: diagram, table (toggle held-out), scorecard (30 s).
6. Stress tests: held-out table and the failure callouts (30 s).
7. Oversight: roles, pilot, stop conditions (20 s).

Add the video link to `docs/data/text.json` (`"video": "<url>"`); the Overview link updates automatically.
