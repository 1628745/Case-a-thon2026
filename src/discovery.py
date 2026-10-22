"""Discovery analysis on development weeks only (4-21). Prints the tables DISCOVERY.md is written from
and saves them to results/discovery.json.

python -m src.discovery
"""
import json
import os

import numpy as np
import pandas as pd

from src.aggregate import cell_table, scorecard
from src.common import ROOT

R = os.path.join(ROOT, "results")
DEV = (4, 21)


def load():
    w = pd.read_parquet(os.path.join(R, "weekly_metrics.parquet"))
    w = w[w.week.between(*DEV)].copy()
    w["guard"] = w.guard.astype(bool)
    ch = pd.read_parquet(os.path.join(R, "chain.parquet"))
    det = pd.read_parquet(os.path.join(R, "detector.parquet"))
    bp = os.path.join(R, "breakdown.parquet")
    br = pd.read_parquet(bp) if os.path.exists(bp) else pd.DataFrame()
    return w, ch, det, br


def stability(w):
    ref = w[(w.family == "main") & (w.condition == "reference") & ~w.guard]
    p = ref.pivot_table(index="week", columns="seed", values="mae_min")
    return dict(mean_by_seed=p.mean().round(2).to_dict(), max_weekly_seed_spread=float((p.max(1) - p.min(1)).max()),
                weekly_mae_range=[float(p.mean(1).min()), float(p.mean(1).max())],
                week_to_week_sd=float(p.mean(1).diff().std()))


def atlas(w, br):
    if not len(br):
        return {}
    a = w[w.family == "atlas"].drop_duplicates("run_id")[["run_id", "condition"]]
    b = br.merge(a, on="run_id")
    ref = b[b.condition == "reference"][["week", "kind", "group", "mae", "n"]].rename(columns={"mae": "ref_mae", "n": "ref_n"})
    m = b.merge(ref, on=["week", "kind", "group"])
    m["gap"] = m.mae - m.ref_mae
    out = m.groupby(["condition", "kind", "group"]).apply(
        lambda g: pd.Series(dict(gap=np.average(g.gap, weights=g.n), share=g.n.sum()))).reset_index()
    tot = out.groupby(["condition", "kind"]).share.transform("sum")
    out["share"] = out.share / tot
    out["contribution"] = out.gap * out.share
    return out[out.condition != "reference"].round(3)


def first_departure(w, ch):
    """First dev week each link departs from reference by more than 3x the reference's own
    week-to-week noise (seed-0 main runs, Guard off)."""
    main = w[(w.family == "main") & (w.seed == 0) & ~w.guard]
    meta = main.drop_duplicates("run_id")[["run_id", "condition"]]
    c = ch.merge(meta, on="run_id")
    c = c[c.week.between(*DEV)]
    out = {}
    links = {"data: injected share of training rows": ("w", "injected_share_train"),
             "data: history-feature age (days)": ("w", "feature_age_days"),
             "data: mean training-row age (days)": ("w", "mean_train_age_days"),
             "training signal: KS(labels, truth)": ("c", "train_label_ks_vs_ref"),
             "training signal: label median (min)": ("c", "train_label_median"),
             "model: probe P80 shift (min)": ("c", "probe_shift_p80"),
             "model: probe P50 shift (min)": ("c", "probe_shift_p50"),
             "decision: MAE (min)": ("w", "mae_min"),
             "decision: promise width (min)": ("w", "promise_width_min"),
             "decision: miss rate": ("w", "miss_rate")}
    for cond in ["stale", "low_quality", "combined"]:
        res = {}
        for name, (src, col) in links.items():
            df = main if src == "w" else c
            if col not in df:
                continue
            x = df[df.condition == cond].set_index("week")[col].sort_index()
            r = df[df.condition == "reference"].set_index("week")[col].sort_index()
            d = (x - r).dropna()
            noise = r.diff().abs().median()
            thr = 3 * noise if noise and noise > 0 else 1e-9
            if col in ("probe_shift_p80", "probe_shift_p50"):
                d = x.dropna()
                thr = 3 * r.abs().median() if r.abs().median() > 0 else 1.0
            hit = d[d.abs() > thr]
            res[name] = dict(first_week=None if hit.empty else int(hit.index[0]), mean_diff=float(d.mean()),
                             last_diff=float(d.iloc[-1]) if len(d) else None, threshold=float(thr))
        out[cond] = res
    return out


def controls(w):
    out = {}
    c = w[w.family == "controls"].groupby("control").mae_min.mean()
    m0 = w[(w.family == "main") & (w.seed == 0)]
    g = m0.groupby(["condition", "guard"]).mae_min.mean()
    out["mae"] = dict(oracle=c.get("oracle"), random=c.get("random"), frozen_model=c.get("frozen_model"),
                      frozen_features=c.get("frozen_features"), reference=g.get(("reference", False)),
                      low_quality_off=g.get(("low_quality", False)), low_quality_on=g.get(("low_quality", True)),
                      stale_off=g.get(("stale", False)))
    d = w[w.family == "dose"].groupby(["severity", "guard"]).mae_min.mean().unstack()
    out["dose"] = {str(k): v for k, v in d.round(3).to_dict("index").items()}
    out["dose_monotonic_off"] = bool(np.all(np.diff(d[False].to_numpy()) > 0))
    s = w[w.family == "shelf_life"].groupby(["condition", "window_weeks"]).mae_min.mean().unstack(0)
    out["shelf_life"] = s.round(3).to_dict()
    return out


def tuning(w, det):
    t = w[w.family == "tune"]
    if not len(t):
        return []
    ref_off = w[(w.family == "main") & (w.seed == 0) & ~w.guard]
    ctrl = w[w.family == "controls"]
    rows = []
    for name, g in t.groupby("tune_name"):
        mw = pd.concat([ref_off[ref_off.condition.isin(["reference", "low_quality", "combined"])], g])
        cells = cell_table(mw)
        dsub = det[det.run_id.isin(g.run_id.unique())]
        for kk in ["1.5", "2.0", "3.0", "4.0"]:
            col = f"defer_k{kk}"
            if col not in g:
                continue
            mw2 = mw.copy()
            mw2.loc[mw2.guard, "defer_rate"] = mw2.loc[mw2.guard, col]
            sc = scorecard(cell_table(mw2), dsub, ctrl, mw2.assign(seed=0))
            r = dict(config=name, k=float(kk), passed=sum(x["passed"] for x in sc), total=len(sc),
                     failed=[x["criterion"] for x in sc if not x["passed"]])
            cc = cells.set_index(["condition", "guard"])
            for cond in ["reference", "low_quality", "combined"]:
                r[f"mae_{cond}_on"] = round(float(cc.loc[(cond, True), "mae"]), 3)
                r[f"miss_{cond}_on"] = round(float(cc.loc[(cond, True), "miss"]), 4)
                r[f"width_{cond}_on"] = round(float(cc.loc[(cond, True), "width"]), 1)
                r[f"defer_{cond}_on"] = round(float(g[g.condition == cond][col].mean()), 4)
            for x in sc:
                if x["criterion"] in ("Recovery", "No harm"):
                    r[x["criterion"]] = x["value"]
            rows.append(r)
    return rows


def main():
    w, ch, det, br = load()
    out = dict(stability=stability(w), first_departure=first_departure(w, ch), controls=controls(w))
    at = atlas(w, br)
    if len(at):
        out["atlas"] = at.to_dict("records")
        top = at.sort_values("contribution", ascending=False).groupby(["condition", "kind"]).head(2)
        print("ATLAS (gap vs reference, min; Guard off, seed 0)\n", top.to_string(index=False))
    tu = tuning(w, det)
    out["tuning"] = tu
    print("STABILITY", json.dumps(out["stability"]))
    for cnd, links in out["first_departure"].items():
        print("FIRST DEPARTURE", cnd, {k: v["first_week"] for k, v in links.items()})
    print("CONTROLS", json.dumps(out["controls"]["mae"], default=float))
    print("DOSE", out["controls"]["dose"], "monotonic:", out["controls"]["dose_monotonic_off"])
    print("SHELF", out["controls"]["shelf_life"])
    if tu:
        t = pd.DataFrame(tu)
        print(t.drop(columns=[c for c in t.columns if c.startswith("width") or c.startswith("miss")]).to_string(index=False))
    with open(os.path.join(R, "discovery.json"), "w") as f:
        json.dump(out, f, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))


if __name__ == "__main__":
    main()
