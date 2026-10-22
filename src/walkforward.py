"""One run: weekly walk-forward retraining -> metric rows (+ diagnostics, detector, modification log).

A run spec is a dict: run_id, family, condition, guard (bool), seed, window ('all' or int weeks),
severity (sloppy-courier share; None = config default), weeks (list), control (None | 'oracle' |
'random' | 'frozen_model' | 'frozen_features'), guard_cfg (optional overrides of config guard).
"""
import copy

import numpy as np
import pandas as pd

from src.common import config_hash, git_sha
from src.model import Timer, fit, predict
from src.prep import DYNAMIC, FEATURES, add_dynamic_features


def rare_types(base, cfg):
    w = base[base.week <= cfg["splits"]["warmup"][1]]
    share = w.aoi_type.value_counts(normalize=True)
    return set(share[share < cfg["rare_area_share"]].index)


def merged_guard_cfg(cfg, spec):
    g = copy.deepcopy(cfg["guard"])
    for layer, vals in (spec.get("guard_cfg") or {}).items():
        g[layer].update(vals)
    return g


def build_run_feed(base, spec, cfg):
    """Feed (possibly degraded) with dynamic features computed from that feed."""
    cond = spec["condition"]
    modlog = []
    if cond == "reference":
        feed = base.copy()
        feed["is_dup"] = False
        feed["injected"] = False
        feed["sloppy"] = False
    else:
        from src.degrade import build_feed
        feed, modlog = build_feed(base, cond, spec["seed"], cfg, severity=spec.get("severity"))
    stale_feats = cond in ("stale", "combined") or spec.get("control") == "frozen_features"
    freeze_day = None
    if stale_feats:
        freeze_day = (pd.Timestamp(cfg["degrade"]["stale"]["freeze_data_through"]) -
                      pd.Timestamp(cfg["data"]["week0_start"])).days
    dyn = add_dynamic_features(feed, cfg, freeze_day=freeze_day)
    feed = feed.drop(columns=[c for c in dyn.columns if c in feed.columns])
    feed = pd.concat([feed, dyn], axis=1)
    feed["label"] = (feed.delivery_time - feed.accept_time).dt.total_seconds() / 60
    return feed, modlog


def window_weeks(spec, t, cfg):
    if spec.get("control") == "frozen_model":
        return list(range(cfg["splits"]["warmup"][0], cfg["splits"]["warmup"][1] + 1))
    w = spec.get("window", cfg["splits"]["window_weeks"])
    if spec["condition"] in ("stale", "combined") or w == "all":
        return list(range(0, t))
    return list(range(max(0, t - int(w)), t))


def weighted_quantile(x, w, q):
    o = np.argsort(x)
    x, w = x[o], w[o]
    c = np.cumsum(w)
    return float(x[np.searchsorted(c, q * c[-1])]) if len(x) else np.nan


def run(spec, base, cfg, threads=1, diag=True):
    gcfg = merged_guard_cfg(cfg, spec)
    feed, modlog = build_run_feed(base, spec, cfg)
    rare = rare_types(base, cfg)
    rng = np.random.default_rng(spec["seed"] + 1000)
    rows, det, imp, probes, chain = [], [], [], [], []
    frozen = None
    chash, sha = config_hash(cfg), git_sha()
    for t in spec["weeks"]:
        wks = window_weeks(spec, t, cfg)
        tr = feed[feed.week.isin(wks)].copy()
        te = feed[(feed.week == t) & (~feed.is_dup)].copy()
        if spec.get("control") == "oracle":
            tr = tr[~tr.injected]
        elif spec.get("control") == "random":
            n_drop = int(tr.injected.sum())
            tr = tr.drop(index=rng.choice(tr.index.to_numpy(), size=n_drop, replace=False))
        tr["w"] = 1.0
        tr["age_weeks"] = t - tr.week - 1
        info = {}
        with Timer() as tm:
            if spec["guard"]:
                from src.guard import apply_guard
                res = apply_guard(tr, te, t, cfg, gcfg, spec["seed"], threads)
            elif spec.get("control") == "frozen_model" and frozen is not None:
                res = frozen
            else:
                X = tr[FEATURES].to_numpy(np.float32)
                m50 = fit(X, tr.label.to_numpy(), None, cfg, spec["seed"], threads)
                m80 = fit(X, tr.label.to_numpy(), None, cfg, spec["seed"], threads, quantile=cfg["model"]["quantile_alpha"])
                res = {"m50": m50, "m80": m80, "tr": tr, "offset": None}
                if spec.get("control") == "frozen_model":
                    frozen = res
        tr_used = res["tr"]
        Xte = te[FEATURES].to_numpy(np.float32) if "Xte" not in res else res["Xte"]
        p50 = predict(res["m50"], Xte)
        p80 = res["p80_test"] if "p80_test" in res else predict(res["m80"], Xte)
        defer = res.get("defer", np.zeros(len(te), bool))
        y = te.ref_duration_min.to_numpy()
        err = np.abs(y - p50)
        w = tr_used.w.to_numpy()
        rare_mask = te.aoi_type.isin(rare).to_numpy()
        tstart = pd.Timestamp(cfg["data"]["week0_start"]) + pd.Timedelta(weeks=t)
        row = dict(run_id=spec["run_id"], family=spec["family"], condition=spec["condition"],
                   guard=bool(spec["guard"]), seed=spec["seed"], window_weeks=str(spec.get("window", 4)),
                   severity=spec.get("severity"), control=spec.get("control"), week=t,
                   week_start=str(tstart.date()), n_test=len(te), n_train_rows=len(tr_used),
                   eff_n_train=float(w.sum() ** 2 / (w ** 2).sum()),
                   frac_downweighted=float((w / w.max() < 0.5).mean()),
                   mean_train_age_days=float(np.average(t * 7 - tr_used.day.to_numpy(), weights=w)),
                   sloppy_share_train=float(np.average(tr_used.sloppy.to_numpy(), weights=w)),
                   dup_share_train=float(np.average(tr_used.is_dup.to_numpy(), weights=w)),
                   injected_share_train=float(np.average(tr_used.injected.to_numpy(), weights=w)),
                   feature_age_days=float(te.hist_age_days.mean()),
                   mae_min=float(err.mean()), p90_err_min=float(np.quantile(err, 0.9)),
                   miss_rate=float((y > p80).mean()), promise_width_min=float(p80.mean()),
                   defer_rate=float(defer.mean()),
                   mae_trim_min=float(err[y <= 1440].mean()),
                   mae_served_min=float(err[~defer].mean()) if (~defer).any() else np.nan,
                   miss_rate_served=float((y > p80)[~defer].mean()) if (~defer).any() else np.nan,
                   rare_mae_min=float(err[rare_mask].mean()) if rare_mask.any() else np.nan,
                   train_seconds=tm.s, config_hash=chash, git_sha=sha)
        for k, v in res.get("weekly_extra", {}).items():
            row[k] = v
        rows.append(row)
        if spec["guard"] and "flag" in res:
            fl, inj = res["flag"], tr_used.injected.to_numpy()
            det.append(dict(run_id=spec["run_id"], week=t, tp=int((fl & inj).sum()), fp=int((fl & ~inj).sum()),
                            fn=int((~fl & inj).sum()), tn=int((~fl & ~inj).sum())))
        if diag:
            from src.diagnose import diagnostics
            d_imp, d_probe, d_chain = diagnostics(spec, t, res, tr_used, te, Xte, cfg, base)
            imp += d_imp; probes += d_probe; chain.append(d_chain)
    out = {"weekly": pd.DataFrame(rows), "detector": pd.DataFrame(det), "importance": pd.DataFrame(imp),
           "probe": pd.DataFrame(probes), "chain": pd.DataFrame(chain), "modlog": pd.DataFrame(modlog)}
    return out
