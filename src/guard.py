"""The Guard: L1 ingest checks, L2 training weights, L3 serve-time check (conformal promise + defer).

Inputs are feed columns only (scans, ids, GPS, features). The injection labels (`injected`,
`sloppy`, `is_dup`, `early`) are never read here; tests/test_guard.py checks that scrambling them
changes nothing.
"""
import numpy as np
import pandas as pd

from src.model import fit, predict
from src.prep import FEATURES

HIST = ["courier_hist_mean", "area_hist_mean"]


def l1_flags(feed, g):
    """Label-free ingest flags -> DataFrame of bool columns + 'any'. Duplicates: later copies of a
    package id (arrival order) are flagged; the first is kept."""
    c = g["l1"]
    dur = (feed.delivery_time - feed.accept_time).dt.total_seconds() / 60
    dup = feed.order_id.duplicated(keep="first")
    first = feed[~dup]
    dmin = first.delivery_time.dt.floor("min")
    burst_n = first.groupby([first.courier_id, dmin]).order_id.transform("size")
    burst = pd.Series(False, index=feed.index)
    burst.loc[first.index] = (burst_n >= c["burst_min_packages"]).to_numpy()
    # copies inherit their original's burst flag
    burst = burst | feed.order_id.map(dict(zip(first.order_id, burst.loc[first.index]))).astype(bool)
    f = pd.DataFrame({"nonpos": dur <= 0, "burst": burst, "dup": dup,
                      "gps_age": feed.gps_age_min > c["gps_age_max_min"], "far": feed.dist_km > c["dist_max_km"]})
    f["any"] = f.any(axis=1)
    return f


def courier_reputation(tr, flag, g):
    """Reputation in (rep_floor, 1] per courier from the training window only: flag rate and peer
    disagreement (log duration vs other couriers in the same aoi_id x hour, robust z), shrunk toward
    neutral with a prior of `prior_records` records."""
    c = g["l2"]
    d = pd.DataFrame({"courier": tr.courier_id.to_numpy(), "cell": tr.aoi_id.to_numpy() * 100 + tr.hour.to_numpy(),
                      "y": np.log1p(np.maximum(tr.label.to_numpy(), 0)), "flag": flag})
    stats = d.groupby("courier").agg(n=("y", "size"), flag_rate=("flag", "mean"))
    ok = d[~d.flag]
    cs = ok.groupby("cell").y.agg(["sum", "size"])
    cc = ok.groupby(["cell", "courier"]).y.agg(["sum", "size"]).reset_index()
    cc = cc.join(cs, on="cell", rsuffix="_cell")
    peer_n = cc.size_cell - cc["size"]
    cc = cc[peer_n > 0]
    peer_mean = (cc.sum_cell - cc["sum"]) / (cc.size_cell - cc["size"])
    cc = cc.assign(diff=cc["sum"] - cc["size"] * peer_mean)
    agg = cc.groupby("courier").agg(dsum=("diff", "sum"), dn=("size", "sum"))
    disagree = (agg.dsum / agg.dn).reindex(stats.index)
    med = disagree.median()
    mad = 1.4826 * (disagree - med).abs().median()
    z = ((disagree - med) / (mad if mad > 0 else 1.0)).fillna(0.0)
    shrink = stats.n / (stats.n + c["prior_records"])
    bad = shrink * (np.maximum(0.0, z.abs() - 1.0) + 5.0 * stats.flag_rate)
    rep = c["rep_floor"] + (1 - c["rep_floor"]) * np.exp(-bad)
    return pd.DataFrame({"rep": rep, "z": z, "flag_rate": stats.flag_rate, "n": stats.n})


def training_weights(tr, t, flags_any, g):
    c = g["l2"]
    h = c["half_life_weeks"]
    rec = np.ones(len(tr)) if h is None else 0.5 ** (tr.age_weeks.to_numpy() / h)
    rep = courier_reputation(tr, flags_any, g)
    r = tr.courier_id.map(rep.rep).to_numpy()
    lam = c["reputation_lambda"]
    r_eff = 1 - lam * (1 - r)
    flag_f = np.where(flags_any, g["l1"]["quarantine_weight"], 1.0)
    w = rec * r_eff * flag_f
    tot = pd.Series(w).groupby(tr.courier_id.to_numpy()).sum()
    cap = c["courier_cap_mult"] * tot.median()
    scale = (cap / tot).clip(upper=1.0)
    w = w * pd.Series(tr.courier_id.to_numpy()).map(scale).to_numpy()
    return w, rep, rec


def null_stale_history(df, g):
    m = g["l2"]["hist_max_age_days"]
    df = df.copy()
    if m is not None:
        stale = df.hist_age_days.to_numpy() > m
        for col in HIST:
            df.loc[stale, col] = np.nan
    return df


def weighted_quantile(x, w, q):
    o = np.argsort(x)
    x, w = np.asarray(x)[o], np.asarray(w)[o]
    cw = np.cumsum(w)
    if len(x) == 0 or cw[-1] <= 0:
        return np.nan
    return float(x[min(len(x) - 1, np.searchsorted(cw, q * cw[-1]))])


def apply_guard(tr, te, t, cfg, g, seed, threads):
    flags = l1_flags(tr, g)
    fany = flags["any"].to_numpy()
    tr = null_stale_history(tr, g)
    te = null_stale_history(te, g)
    w, rep, rec = training_weights(tr, t, fany, g)
    tr = tr.assign(w=w, w_rec=rec)
    X = tr[FEATURES].to_numpy(np.float32)
    y = tr.label.to_numpy()
    m50 = fit(X, y, w, cfg, seed, threads)
    Xte = te[FEATURES].to_numpy(np.float32)
    p50_te = predict(m50, Xte)
    alpha = cfg["model"]["quantile_alpha"]
    l3 = g["l3"]
    last = tr.week.max()
    fit_m = tr.week.to_numpy() < last
    if l3["conformal"] and fit_m.any() and (~fit_m).any():
        m80 = fit(X[fit_m], y[fit_m], w[fit_m], cfg, seed, threads, quantile=alpha)
        cal = ~fit_m
        q_cal = predict(m80, X[cal])
        s = y[cal] - q_cal
        wc = w[cal]
        types = tr.aoi_type.to_numpy()[cal]
        glob = weighted_quantile(s, wc, l3["target_coverage"])
        offset = {}
        for ty in np.unique(types):
            m = types == ty
            offset[int(ty)] = weighted_quantile(s[m], wc[m], l3["target_coverage"]) if m.sum() >= 30 else glob
        off_te = te.aoi_type.map(offset).fillna(glob).to_numpy()
        p80_te = predict(m80, Xte) + off_te
        width_cal = pd.Series(q_cal + pd.Series(types).map(offset).fillna(glob).to_numpy() - predict(m50, X[cal]))
        wmed = width_cal.groupby(types).median()
        wglob = float(width_cal.median())
    else:
        m80 = fit(X, y, w, cfg, seed, threads, quantile=alpha)
        offset, glob = {}, 0.0
        p80_te = predict(m80, Xte)
        width_all = pd.Series(p80_te - p50_te)
        wmed = width_all.groupby(te.aoi_type.to_numpy()).median()
        wglob = float(width_all.median())
    width_te = p80_te - p50_te
    ref_w = te.aoi_type.map(wmed).fillna(wglob).to_numpy()
    nulling_on = g["l2"]["hist_max_age_days"] is not None and g["l2"]["hist_max_age_days"] <= l3["defer_hist_age_days"]
    r_hist = (te.hist_age_days.to_numpy() > l3["defer_hist_age_days"]) & (not nulling_on)
    r_gps = te.gps_age_min.to_numpy() > l3["defer_gps_age_min"]
    area_n = te.aoi_id.map(tr.loc[~flags["dup"].to_numpy()].aoi_id.value_counts()).fillna(0).to_numpy()
    r_area = area_n < l3["defer_min_area_rows"]
    r_width = width_te > l3["defer_width_k"] * np.maximum(ref_w, 1e-6)
    defer = r_hist | r_gps | r_area | r_width
    other = r_hist | r_gps | r_area
    extra = {f"defer_k{kk}": float((other | (width_te > kk * np.maximum(ref_w, 1e-6))).mean()) for kk in (1.5, 2.0, 3.0, 4.0)}
    extra.update(defer_hist=float(r_hist.mean()), defer_gps=float(r_gps.mean()), defer_area=float(r_area.mean()),
                 defer_width=float(r_width.mean()), frac_flagged_train=float(fany.mean()),
                 flag_burst=float(flags.burst.mean()), flag_dup=float(flags.dup.mean()), flag_far=float(flags.far.mean()),
                 mean_rep=float(rep.rep.mean()), frac_rep_below_half=float((rep.rep < 0.5).mean()))
    return {"m50": m50, "m80": m80, "offset": offset, "offset_global": glob,
            "width_med": {int(k): float(v) for k, v in wmed.items()}, "width_glob": wglob, "tr": tr, "Xte": Xte,
            "p80_test": p80_te, "defer": defer, "flag": fany, "rep": rep, "weekly_extra": extra,
            "defer_reasons": np.stack([r_hist, r_gps, r_area, r_width], 1)}


def guard_feature_store(feed, cfg, g, freeze_day):
    """Dynamic features as the guarded feature store computes them: history means skip
    L1-quarantined records; open workload ignores duplicate copies."""
    from src.prep import add_dynamic_features
    flags = l1_flags(feed, g)
    hist = add_dynamic_features(feed[~flags["any"].to_numpy()], cfg, freeze_day=freeze_day, rows=feed)
    wl = add_dynamic_features(feed[~flags["dup"].to_numpy()], cfg, freeze_day=freeze_day, rows=feed)
    hist["open_workload"] = wl["open_workload"]
    return hist
