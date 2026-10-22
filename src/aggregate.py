"""Merge finished runs -> results/*.parquet, results/modification_log.csv, results/results.json.

python -m src.aggregate [--results-dir results]
"""
import argparse
import json
import os
import platform

import numpy as np
import pandas as pd

from src.common import ROOT, config_hash, git_sha, load_config

TABLES = ["weekly", "detector", "importance", "probe", "chain", "modlog", "breakdown"]
OUT = {"weekly": "weekly_metrics", "detector": "detector", "importance": "importance", "probe": "probe_preds",
       "chain": "chain"}
CONDS = ["reference", "stale", "low_quality", "combined"]


def load_runs(res_dir):
    jobs = pd.read_csv(os.path.join(res_dir, "jobs.csv"), dtype=str, keep_default_na=False)
    runs = os.path.join(res_dir, "runs")
    data = {k: [] for k in TABLES}
    fam = jobs.groupby("run_id").family.apply(list).to_dict()
    tune = jobs.set_index("run_id").get("tune_name", pd.Series(dtype=str)).to_dict() if "tune_name" in jobs else {}
    missing = []
    for rid in jobs.run_id.unique():
        d = os.path.join(runs, rid)
        if not os.path.exists(os.path.join(d, "done.json")):
            missing.append(rid)
            continue
        for k in TABLES:
            p = os.path.join(d, f"{k}.parquet")
            if os.path.exists(p):
                df = pd.read_parquet(p)
                if len(df):
                    data[k].append(df)
    out = {k: (pd.concat(v, ignore_index=True) if v else pd.DataFrame()) for k, v in data.items()}
    w = out["weekly"]
    if len(w):
        w = w.drop(columns=["family"]).merge(
            pd.DataFrame([(r, f) for r, fs in fam.items() for f in fs], columns=["run_id", "family"]), on="run_id")
        w["tune_name"] = w.run_id.map(tune).fillna("") if tune else ""
        out["weekly"] = w
    return out, missing


def probe_shift(probe, weekly):
    """Mean probe-prediction shift vs the matching reference guard-off run (same seed, same block)."""
    meta = weekly.drop_duplicates("run_id").set_index("run_id")
    ref = meta[(meta.condition == "reference") & (~meta.guard) & (meta.control.isna()) &
               (meta.window_weeks == "4")]
    ref_by_seed = {}
    for rid, r in ref.iterrows():
        blk = "final" if r.week >= 22 else "dev"
        ref_by_seed.setdefault((int(r.seed), blk), rid)
    p = probe.merge(meta[["seed"]], left_on="run_id", right_index=True)
    p["blk"] = np.where(p.week >= 22, "final", "dev")
    p["ref_run"] = [ref_by_seed.get((int(s), b)) for s, b in zip(p.seed, p.blk)]
    r = probe.rename(columns={"run_id": "ref_run", "pred_p50": "r50", "pred_p80": "r80"})
    m = p.merge(r, on=["ref_run", "week", "probe_id"], how="left")
    m["d50"], m["d80"] = m.pred_p50 - m.r50, m.pred_p80 - m.r80
    return m.groupby(["run_id", "week"]).agg(probe_shift_p50=("d50", "mean"), probe_shift_p80=("d80", "mean")).reset_index()


def cell_table(w):
    """Per condition x guard: mean over weeks per seed, then mean and spread across seeds."""
    per_seed = w.groupby(["condition", "guard", "seed"]).agg(
        mae=("mae_min", "mean"), mae_trim=("mae_trim_min", "mean"), p90=("p90_err_min", "mean"),
        miss=("miss_rate", "mean"), width=("promise_width_min", "mean"), defer=("defer_rate", "mean"),
        downweighted=("frac_downweighted", "mean"), rare_mae=("rare_mae_min", "mean"),
        eff_n=("eff_n_train", "mean"), n_train=("n_train_rows", "mean"), secs=("train_seconds", "mean")).reset_index()
    g = per_seed.groupby(["condition", "guard"])
    mean = g.mean(numeric_only=True).drop(columns="seed")
    spread = g.agg(lambda s: s.max() - s.min()).drop(columns="seed").add_suffix("_spread")
    n = g.seed.nunique().rename("n_seeds")
    return pd.concat([mean, spread, n], axis=1).reset_index()


def recovery(cells, cond):
    c = cells.set_index(["condition", "guard"])
    try:
        deg, grd, ref = c.loc[(cond, False), "mae"], c.loc[(cond, True), "mae"], c.loc[("reference", False), "mae"]
    except KeyError:
        return None
    gap = deg - ref
    return dict(degraded=deg, guarded=grd, reference=ref, gap=gap,
                recovery=None if gap <= 0 else (deg - grd) / gap,
                gap_exceeds_seed_spread=bool(abs(gap) > max(c.loc[(cond, False), "mae_spread"], c.loc[("reference", False), "mae_spread"])))


def detector_summary(det, weekly, conds):
    meta = weekly.drop_duplicates("run_id").set_index("run_id")
    d = det.merge(meta[["condition"]], left_on="run_id", right_index=True)
    out = {}
    for c in conds:
        x = d[d.condition == c][["tp", "fp", "fn", "tn"]].sum()
        if x.sum() == 0:
            continue
        tp, fp, fn, tn = (int(x[k]) for k in ["tp", "fp", "fn", "tn"])
        out[c] = dict(tp=tp, fp=fp, fn=fn, tn=tn, precision=tp / (tp + fp) if tp + fp else None,
                      recall=tp / (tp + fn) if tp + fn else None, fpr=fp / (fp + tn) if fp + tn else None)
    return out


def scorecard(cells, det, controls_w, main_w):
    c = cells.set_index(["condition", "guard"])
    rows = []

    def add(name, rule, value, ok, note=""):
        rows.append(dict(criterion=name, rule=rule, value=value, passed=bool(ok), note=note))

    rec = {k: recovery(cells, k) for k in ["low_quality", "combined"]}
    vals = {k: (None if v is None else v["recovery"]) for k, v in rec.items()}
    add("Recovery", ">= 50% of MAE gap recovered in low_quality and combined",
        {k: (None if v is None else round(v, 3)) for k, v in vals.items()},
        all(v is not None and v >= 0.5 for v in vals.values()))
    r_off, r_on = c.loc[("reference", False), "mae"], c.loc[("reference", True), "mae"]
    add("No harm", "reference MAE <= 3% worse with Guard on", round(r_on / r_off - 1, 4), r_on <= 1.03 * r_off)
    pq = {}
    ok = True
    for cond in CONDS:
        if (cond, True) not in c.index:
            continue
        miss, w_on, w_off = c.loc[(cond, True), "miss"], c.loc[(cond, True), "width"], c.loc[(cond, False), "width"]
        good = 0.17 <= miss <= 0.23 and w_on <= 1.01 * w_off
        pq[cond] = dict(miss_on=round(miss, 4), width_on=round(w_on, 1), width_off=round(w_off, 1), passed=bool(good))
        ok &= good
    add("Promise quality", "Guard-on miss rate 17-23% at equal (<= +1%) or smaller width, every condition", pq, ok)
    dfr = {cond: round(c.loc[(cond, True), "defer"], 4) for cond in CONDS if (cond, True) in c.index}
    add("Deferral", "<= 10% of packages, every condition", dfr, all(v <= 0.10 for v in dfr.values()))
    ref_rare = c.loc[("reference", False), "rare_mae"]
    rr = {cond: round(c.loc[(cond, True), "rare_mae"] / ref_rare - 1, 4)
          for cond in ["reference", "low_quality", "combined"] if (cond, True) in c.index}
    add("Rare areas", "Guard-on rare-area MAE <= 5% worse than reference (Guard off); reference, low_quality, combined",
        rr, all(v <= 0.05 for v in rr.values()))
    ds = detector_summary(det, main_w, ["low_quality", "combined"])
    prec = {k: (None if v["precision"] is None else round(v["precision"], 4)) for k, v in ds.items()}
    fpr = {k: (None if v["fpr"] is None else round(v["fpr"], 5)) for k, v in ds.items()}
    add("Detection", "precision >= 0.7 on injected rows (FPR reported)", dict(precision=prec, fpr=fpr),
        len(prec) > 0 and all(v is not None and v >= 0.7 for v in prec.values()))
    if controls_w is not None and len(controls_w):
        rnd = controls_w[controls_w.control == "random"].mae_min.mean()
        g0 = main_w[(main_w.condition == "low_quality") & main_w.guard & (main_w.seed == 0)].mae_min.mean()
        add("Beats control", "Guard (low_quality, seed 0) MAE < random removal of the same volume",
            dict(guard=round(g0, 2), random_removal=round(rnd, 2)), g0 < rnd)
    return rows


def summarize_block(main_w, det, controls_w=None, block="dev"):
    cells = cell_table(main_w)
    conds = sorted(main_w.condition.unique())
    rec = {k: recovery(cells, k) for k in conds if k != "reference"}
    out = dict(cells=cells.round(4).to_dict("records"), recovery=rec,
               detector=detector_summary(det, main_w, [k for k in conds if k != "reference"]))
    if block == "dev":
        out["scorecard"] = scorecard(cells, det, controls_w, main_w)
    else:
        out["scorecard"] = scorecard(cells[cells.condition.isin(CONDS)], det, None, main_w)
    return out


def monitor_alerts(w, lo, hi):
    out = []
    for (rid,), g in w.sort_values("week").groupby(["run_id"]):
        bad = ((g.miss_rate < lo) | (g.miss_rate > hi)).to_numpy()
        for i in range(1, len(bad)):
            if bad[i] and bad[i - 1]:
                out.append(dict(run_id=rid, week=int(g.week.iloc[i])))
    return out


def versions():
    import lightgbm
    import sklearn
    return dict(python=platform.python_version(), lightgbm=lightgbm.__version__, pandas=pd.__version__,
                numpy=np.__version__, sklearn=sklearn.__version__, platform=platform.platform())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results-dir", default=os.path.join(ROOT, "results"))
    a = ap.parse_args()
    cfg = load_config()
    data, missing = load_runs(a.results_dir)
    w = data["weekly"]
    print(f"runs loaded: {w.run_id.nunique()}  missing: {len(missing)}")
    chain = data["chain"]
    if len(data["probe"]):
        chain = chain.merge(probe_shift(data["probe"], w), on=["run_id", "week"], how="left")
    w.to_parquet(os.path.join(a.results_dir, "weekly_metrics.parquet"), index=False)
    data["detector"].to_parquet(os.path.join(a.results_dir, "detector.parquet"), index=False)
    if len(data["breakdown"]):
        data["breakdown"].to_parquet(os.path.join(a.results_dir, "breakdown.parquet"), index=False)
    data["importance"].to_parquet(os.path.join(a.results_dir, "importance.parquet"), index=False)
    data["probe"].to_parquet(os.path.join(a.results_dir, "probe_preds.parquet"), index=False)
    chain.to_parquet(os.path.join(a.results_dir, "chain.parquet"), index=False)
    ml = data["modlog"]
    if len(ml):
        ml = ml.drop_duplicates(["condition", "seed", "mechanism", "week"] + (["severity"] if "severity" in ml else []))
        ml.to_csv(os.path.join(a.results_dir, "modification_log.csv"), index=False)
    res = dict(config_hash=config_hash(cfg), git_sha=git_sha(), versions=versions(), config=cfg,
               runs=int(w.run_id.nunique()), retrains=int(len(w.drop_duplicates(["run_id", "week"]))), missing_runs=missing)
    main_dev = w[(w.family == "main")]
    ctrl = w[w.family == "controls"]
    if len(main_dev):
        res["dev"] = summarize_block(main_dev, data["detector"], ctrl, "dev")
        res["alerts_dev"] = monitor_alerts(main_dev, cfg["guard"]["monitor"]["miss_low"], cfg["guard"]["monitor"]["miss_high"])
    fin = w[w.family == "final"]
    if len(fin):
        res["final"] = summarize_block(fin, data["detector"], None, "final")
        res["final_config_hashes"] = sorted(fin.config_hash.unique().tolist())
        res["alerts_final"] = monitor_alerts(fin, cfg["guard"]["monitor"]["miss_low"], cfg["guard"]["monitor"]["miss_high"])
    for fam in ["shelf_life", "dose", "controls", "tune"]:
        f = w[w.family == fam]
        if len(f):
            keys = {"shelf_life": ["condition", "window_weeks"], "dose": ["severity", "guard"],
                    "controls": ["condition", "control"], "tune": ["tune_name", "condition"]}[fam]
            res[fam] = f.groupby(keys).agg(mae=("mae_min", "mean"), p90=("p90_err_min", "mean"), miss=("miss_rate", "mean"),
                                            width=("promise_width_min", "mean"), defer=("defer_rate", "mean"),
                                            rare_mae=("rare_mae_min", "mean")).reset_index().round(4).to_dict("records")
    if "dev" in res:
        res["headline"] = headline(res)
    with open(os.path.join(a.results_dir, "results.json"), "w") as f:
        json.dump(res, f, indent=1, default=lambda o: None if (isinstance(o, float) and np.isnan(o)) else (o.item() if hasattr(o, "item") else str(o)))
    print("wrote results.json")
    if "dev" in res:
        for r in res["dev"]["scorecard"]:
            print(("PASS " if r["passed"] else "FAIL ") + r["criterion"], json.dumps(r["value"])[:160])


def headline(res):
    blk = res.get("final", res["dev"])
    name = "final" if "final" in res else "dev"
    rec = blk["recovery"]
    return dict(block=name,
                recovery_low_quality=None if not rec.get("low_quality") else rec["low_quality"]["recovery"],
                recovery_combined=None if not rec.get("combined") else rec["combined"]["recovery"],
                mae_gap_low_quality=None if not rec.get("low_quality") else rec["low_quality"]["gap"],
                scorecard_passed=sum(r["passed"] for r in blk["scorecard"]), scorecard_total=len(blk["scorecard"]))


if __name__ == "__main__":
    main()
