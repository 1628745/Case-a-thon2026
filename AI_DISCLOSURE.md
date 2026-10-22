# AI disclosure

## AI components under test (the subject of the study)

| Component | What it is | Role in the decision |
| --- | --- | --- |
| Median model | LightGBM regressor, `objective="l1"`, 300 trees, 63 leaves, fixed settings (PLAN.md section 1) | Expected delivery duration shown to the dispatcher |
| P80 model | LightGBM regressor, `objective="quantile"`, `alpha=0.8`, same settings | The promised delivery window |
| The Guard | Rule-based layers around the models (L1 ingest checks, L2 training weights incl. a courier reputation score, L3 conformal promise and deferral, a miss-rate monitor) | Decides which data trains the models and which packages go to a person |

Both models are retrained from scratch every week (about 1,100 weekly retrains in total across all experiments). The final-week models are exported to `docs/models/` and run in the browser on the site.

## AI used as a tool

Claude (Anthropic; Claude Code, model Claude Opus) built this submission autonomously from the team's written plan (`PLAN.md`, `CLAUDE.md`): it wrote the data pipeline, injectors, Guard, experiment runner, analysis, website and documents, ran all experiments, and wrote the findings. It worked unattended; every judgment call it made is logged with alternatives in `DECISIONS.md`, and every step's checks are recorded in `PROGRESS.md`. No other AI system generated content.

### Prompt summary

- The team wrote `PLAN.md` (the full specification: decision, data, splits, degradation conditions, Guard design, metrics, scorecard, website sections, execution order, definition of done) and `CLAUDE.md` (operating rules: work unattended, never commit data, keep chronological order, never tune on held-out weeks, never use injection labels as features or Guard inputs, report failures).
- The session prompt asked Claude to execute PLAN.md steps 0-12 in order, run each step's checks before ticking it, commit and push after each step, log decisions instead of asking questions, and stop only for a missing-data, push, or disk blocker.

### Safeguards on the AI tool's work

- Leakage tests (`tests/test_leakage.py`): no outcome-derived feature, history features use only deliveries scanned before the row's day, a row's own label never changes its own features, a test week is never in its own training window.
- Guard tests (`tests/test_guard.py`): scrambling the injection labels changes nothing the Guard computes.
- The Guard configuration was frozen (git tag `guard-v1-frozen`) before the held-out weeks were scored; every final result row carries the config hash.
- A review subagent checked the code against PLAN.md before the freeze and before the final push.

## Human review points

1. The plan itself (written by the team before the build).
2. `DISCOVERY.md`: the team may request changes to the chosen Guard settings; the held-out evaluation is cheap to rerun.
3. The site and `PRESENTATION.md` before the presentation; the team records the fallback video.
