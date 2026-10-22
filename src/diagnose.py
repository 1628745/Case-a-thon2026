"""Diagnostics per run x week: SHAP importance, synthetic probe-grid predictions, chain metrics.

SHAP values come from LightGBM's built-in TreeSHAP (`pred_contrib=True`), which computes exact
Shapley values for tree ensembles (same algorithm as shap.TreeExplainer).
"""
import numpy as np
import pandas as pd

from src.prep import FEATURES

PROBE_TYPES = [1, 14, 4, 0, 7, 2]           # four common area types + two rare ones
PROBE_HOURS = [8, 10, 12, 14, 16, 18, 20]
PROBE_DIST = [0.5, 2.0, 5.0, 10.0]
SHAP_SAMPLE = 1000


_GRID = {}


def probe_grid(base, cfg):
    """Fixed synthetic grid (area type x hour x distance). Other inputs are set to warm-up-week
    reference values for a representative area of each type, so every run sees identical probes."""
    if "g" in _GRID:
        return _GRID["g"]
    w = base[base.week <= cfg["splits"]["warmup"][1]]
    rows = []
    pid = 0
    for ty in PROBE_TYPES:
        wt = w[w.aoi_type == ty]
        aoi = int(wt.aoi_id.value_counts().index[0])
        wa = wt[wt.aoi_id == aoi]
        for h in PROBE_HOURS:
            for d in PROBE_DIST:
                rows.append(dict(probe_id=pid, aoi_type=ty, hour=h, minute_of_day=h * 60, dow=2,
                                 region_id=int(wa.region_id.mode()[0]), aoi_id=aoi,
                                 lng=float(wa.lng.median()), lat=float(wa.lat.median()), dist_km=d,
                                 open_workload=float(w.open_workload.median()),
                                 courier_hist_mean=float(wt.courier_hist_mean.median()),
                                 area_hist_mean=float(wt.area_hist_mean.median())))
                pid += 1
    g = pd.DataFrame(rows)
    _GRID["g"] = g
    return g


def weighted_ks(x, wx, y):
    """KS distance between weighted sample x and unweighted sample y."""
    x, wx, y = np.asarray(x), np.asarray(wx, float), np.sort(np.asarray(y))
    o = np.argsort(x)
    x, wx = x[o], wx[o]
    pts = np.union1d(x, y)
    cx = np.cumsum(wx)[np.clip(np.searchsorted(x, pts, "right") - 1, 0, None)] / wx.sum()
    cx = np.where(np.searchsorted(x, pts, "right") == 0, 0.0, cx)
    cy = np.searchsorted(y, pts, "right") / len(y)
    return float(np.max(np.abs(cx - cy)))


def weighted_median(x, w):
    o = np.argsort(x)
    c = np.cumsum(np.asarray(w)[o])
    return float(np.asarray(x)[o][np.searchsorted(c, 0.5 * c[-1])])


def diagnostics(spec, t, res, tr, te, Xte, cfg, base):
    rid = spec["run_id"]
    rng = np.random.default_rng([spec["seed"], t, 5])
    idx = rng.choice(len(Xte), size=min(SHAP_SAMPLE, len(Xte)), replace=False)
    contrib = res["m50"].booster_.predict(Xte[idx], pred_contrib=True)[:, :-1]
    imp = [dict(run_id=rid, week=t, feature=f, mean_abs_shap=float(v))
           for f, v in zip(FEATURES, np.abs(contrib).mean(0))]
    g = probe_grid(base, cfg)
    Xp = g[FEATURES].to_numpy(np.float32)
    p50 = res["m50"].predict(Xp, num_threads=1)
    p80 = res["m80"].predict(Xp, num_threads=1)
    if res.get("offset") is not None:
        p80 = p80 + g.aoi_type.map(res["offset"]).fillna(res.get("offset_global", 0.0)).to_numpy()
    probes = [dict(run_id=rid, week=t, probe_id=int(i), pred_p50=float(a), pred_p80=float(b))
              for i, a, b in zip(g.probe_id, p50, p80)]
    w = tr.w.to_numpy()
    ref = tr.loc[~tr.is_dup.to_numpy(), "ref_duration_min"].to_numpy()
    chain = dict(run_id=rid, week=t, train_label_median=weighted_median(tr.label.to_numpy(), w),
                 ref_label_median=float(np.median(ref)),
                 train_label_ks_vs_ref=weighted_ks(tr.label.to_numpy(), w, ref))
    return imp, probes, chain
