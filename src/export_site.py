"""Results -> docs/data/*.json (aggregates only) and final-week models -> docs/models/*.json.

python -m src.export_site            # real results (results/*.parquet, results/results.json)
python -m src.export_site --mock     # synthetic frames in the same schema (site skeleton)
python -m src.export_site --no-models  # skip model retraining/export

Nothing written to docs/ contains raw rows, courier ids, package or GPS coordinates. Console
scenarios are medians over groups of packages; their location inputs are snapped to a 0.1 degree
grid cell (about 10 km) and never displayed.
"""
import argparse
import json
import os
import shutil
import time

import numpy as np
import pandas as pd

from src.common import ROOT, load_config
from src.prep import FEATURES

DOCS = os.path.join(ROOT, "docs")
DATA = os.path.join(DOCS, "data")
MODELS = os.path.join(DOCS, "models")
METRICS = ["mae_min", "mae_trim_min", "p90_err_min", "miss_rate", "promise_width_min", "defer_rate", "rare_mae_min"]
TRACKS = ["mean_train_age_days", "sloppy_share_train", "dup_share_train", "injected_share_train", "feature_age_days",
          "n_test", "n_train_rows", "eff_n_train", "frac_downweighted"]
MARKERS = [dict(week=4, label="bulk scans begin (low quality)"), dict(week=8, label="feature store frozen (stale)"),
           dict(week=10, label="re-uploads begin"), dict(week=18, label="early scans begin (unseen)"),
           dict(week=22, label="held-out weeks; Golden Week")]
EXPORT_SPEC = dict(condition="low_quality", seed=0, week=25)


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else round(float(o), 5)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def dump(name, obj):
    with open(os.path.join(DATA, name), "w") as f:
        json.dump(_clean(obj), f, separators=(",", ":"))


def seed_band(df, keys, cols):
    g = df.groupby(keys + ["seed"])[cols].mean().reset_index()
    agg = g.groupby(keys)[cols].agg(["mean", "min", "max"])
    agg.columns = [f"{a}__{b}" for a, b in agg.columns]
    return agg.reset_index()


def build_timeline(w, res):
    m = w[w.family.isin(["main", "final"])].copy()
    m["guard"] = m.guard.astype(bool)
    band = seed_band(m, ["condition", "guard", "week"], METRICS)
    cells = []
    for (c, g), d in band.groupby(["condition", "guard"]):
        d = d.sort_values("week")
        cell = dict(condition=c, guard=bool(g), week=d.week.tolist())
        for k in METRICS:
            cell[k] = dict(mean=d[f"{k}__mean"].tolist(), lo=d[f"{k}__min"].tolist(), hi=d[f"{k}__max"].tolist())
        cells.append(cell)
    tr = m.groupby(["condition", "guard", "week"])[TRACKS].mean().reset_index()
    tracks = []
    for (c, g), d in tr.groupby(["condition", "guard"]):
        d = d.sort_values("week")
        tracks.append(dict(condition=c, guard=bool(g), week=d.week.tolist(), **{k: d[k].tolist() for k in TRACKS}))
    meta = m.drop_duplicates("run_id").set_index("run_id")
    alerts = []
    for a in res.get("alerts_dev", []) + res.get("alerts_final", []):
        if a["run_id"] in meta.index:
            r = meta.loc[a["run_id"]]
            alerts.append(dict(condition=r.condition, guard=bool(r.guard), seed=int(r.seed), week=a["week"],
                               kind=a.get("kind", "miss_rate")))
    return dict(cells=cells, tracks=tracks, markers=MARKERS, alerts=alerts,
                monitor=res.get("config", {}).get("guard", {}).get("monitor", {}))


def build_mechanism(w, chain, imp, probe, res):
    m = w[w.family.isin(["main", "final"])].copy()
    ch = chain.merge(m.drop_duplicates("run_id")[["run_id", "condition", "guard", "seed"]], on="run_id")
    dec = m.groupby(["condition", "guard", "week"])[["miss_rate", "promise_width_min", "p90_err_min", "rare_mae_min",
                                                     "mae_min", "mean_train_age_days", "sloppy_share_train",
                                                     "feature_age_days", "injected_share_train"]].mean().reset_index()
    cc = [c for c in ["train_label_median", "ref_label_median", "train_label_ks_vs_ref", "probe_shift_p50", "probe_shift_p80"] if c in ch]
    chm = ch.groupby(["condition", "guard", "week"])[cc].mean().reset_index().merge(dec, on=["condition", "guard", "week"])
    chain_out = []
    for (c, g), d in chm.groupby(["condition", "guard"]):
        d = d.sort_values("week")
        chain_out.append(dict(condition=c, guard=bool(g), week=d.week.tolist(),
                              **{k: d[k].tolist() for k in cc + list(dec.columns[3:])}))
    shap = []
    if len(imp):
        im = imp.merge(m[m.family == "main"].drop_duplicates("run_id")[["run_id", "condition", "guard"]], on="run_id")
        s = im.groupby(["condition", "guard", "feature"]).mean_abs_shap.mean().reset_index()
        shap = s.to_dict("records")
    ctl = w[w.family == "controls"]
    main0 = m[(m.family == "main") & (m.seed == 0)]
    series = []

    def add(label, d):
        d = d.groupby("week").mae_min.mean()
        series.append(dict(label=label, week=d.index.tolist(), mae=d.tolist()))

    add("reference", main0[(main0.condition == "reference") & ~main0.guard])
    add("low quality, Guard off", main0[(main0.condition == "low_quality") & ~main0.guard])
    add("low quality, Guard on", main0[(main0.condition == "low_quality") & main0.guard])
    for ctrl, lab in [("oracle", "oracle filter (drop exactly the injected rows)"), ("random", "random removal (same count)")]:
        add(lab, ctl[ctl.control == ctrl])
    frozen = []
    for lab, d in [("reference", main0[(main0.condition == "reference") & ~main0.guard]),
                   ("frozen model (trained once on weeks 0-3)", ctl[ctl.control == "frozen_model"]),
                   ("frozen features only", ctl[ctl.control == "frozen_features"]),
                   ("stale (all weeks + frozen features)", main0[(main0.condition == "stale") & ~main0.guard])]:
        d = d.groupby("week").mae_min.mean()
        frozen.append(dict(label=lab, week=d.index.tolist(), mae=d.tolist()))
    dose = w[w.family == "dose"].groupby(["severity", "guard"]).agg(
        mae=("mae_min", "mean"), miss=("miss_rate", "mean"), width=("promise_width_min", "mean"),
        defer=("defer_rate", "mean")).reset_index().to_dict("records")
    grid = None
    if len(probe):
        from src.diagnose import PROBE_DIST, PROBE_HOURS, PROBE_TYPES
        grid = dict(types=PROBE_TYPES, hours=PROBE_HOURS, dist=PROBE_DIST)
    return dict(chain=chain_out, shap=shap, controls=series, frozen=frozen, dose=dose, probe_grid=grid)


def build_shelf(w):
    s = w[w.family == "shelf_life"]
    out = s.groupby(["condition", "window_weeks"]).agg(mae=("mae_min", "mean"), p90=("p90_err_min", "mean"),
                                                       miss=("miss_rate", "mean"), width=("promise_width_min", "mean"),
                                                       rare_mae=("rare_mae_min", "mean")).reset_index()
    order = {"1": 1, "2": 2, "4": 4, "8": 8, "16": 16, "all": 99}
    out["order"] = out.window_weeks.map(order)
    return out.sort_values(["condition", "order"]).to_dict("records")


def build_modlog(ml):
    if ml is None or not len(ml):
        return []
    ml = ml[ml.seed == 0] if "seed" in ml else ml
    keys = ["condition", "mechanism"] + (["severity"] if "severity" in ml else [])
    ml = ml.copy()
    if "severity" in ml:
        ml["severity"] = ml.severity.fillna(-1)
    g = ml.groupby(keys).agg(weeks=("week", lambda s: f"{int(s.min())}-{int(s.max())}"), rows=("rows_affected", "sum"),
                             couriers=("n_couriers", "max"), params=("params", "first")).reset_index()
    if "severity" in g:
        g["severity"] = g.severity.where(g.severity >= 0, None)
    return g.to_dict("records")


def build_manifest():
    audit = json.load(open(os.path.join(ROOT, "results", "audit.json")))
    return dict(
        name="LaDe (Last-mile Delivery), delivery subset, Chongqing", sources=[
            "https://huggingface.co/datasets/Cainiao-AI/LaDe", "https://github.com/wenhaomin/LaDe"],
        retrieved="2026-10-21", file=os.path.basename(audit["file"]), bytes=audit["bytes"], sha256=audit["sha256"],
        rows_raw=audit["rows_raw"], raw_couriers=audit["n_couriers"], raw_areas=audit["n_aoi"], raw_regions=audit["n_regions"],
        raw_date_range=audit["date_range_accept"],
        rows=904679, independent_cases="904,679 packages (one package = one scored case)", couriers=1449, areas=17382, regions=48,
        date_range=["2022-05-01 06:11", "2022-10-29 22:49"],
        fields={"order_id": "package id (duplicate check only)", "region_id, aoi_id, aoi_type": "integer codes (features)",
                "courier_id": "source identity for Guard and history features (never a feature, never published)",
                "lng, lat": "stop location, degrees (feature; not shown)", "accept_time": "MM-DD HH:MM:SS -> hour, minute, weekday",
                "accept_gps_*": "courier GPS at acceptance -> courier-to-stop km, GPS fix age (min)",
                "delivery_time": "target only: duration_min = delivery_time - accept_time (minutes)", "delivery_gps_*": "not used",
                "ds": "MMDD cross-check"},
        missing_values="No missing raw fields. History features are NaN when a courier/area has no deliveries in the prior 14 days (1.8% / 5.8% of rows); LightGBM handles NaN natively.",
        reference_copy="Raw files are read-only; every degradation is applied to an in-memory copy, so the file on disk (SHA-256 above) is the untouched reference.", time_format="MM-DD HH:MM:SS, year 2022 prepended",
        filters="accept date in weeks 0-25 (2022-05-01..2022-10-29); duration > 0",
        observed_issues=audit["observed_issues"],
        licenses=dict(repository_metadata="Apache-2.0", paper="CC BY-NC 4.0"),
        smoke_test_file="delivery_yt.csv (Yantai), smoke tests only")


# ---------------------------------------------------------------- models and console

def compact_tree(ts):
    f, t, dl, mt, l, r, v = [], [], [], [], [], [], []
    mt_code = {"None": 0, "Zero": 1, "NaN": 2}

    def walk(node):
        if "leaf_index" in node or "leaf_value" in node and "split_index" not in node:
            idx = len(v)
            v.append(node["leaf_value"])
            return ~idx
        i = len(f)
        f.append(node["split_feature"]); t.append(node["threshold"]); dl.append(1 if node["default_left"] else 0)
        mt.append(mt_code[node["missing_type"]]); l.append(None); r.append(None)
        assert node["decision_type"] == "<=", node["decision_type"]
        l[i] = walk(node["left_child"])
        r[i] = walk(node["right_child"])
        return i

    root = walk(ts)
    if root < 0:  # single-leaf tree
        return dict(f=[], t=[], dl=[], mt=[], l=[], r=[], v=v)
    return dict(f=f, t=t, dl=dl, mt=mt, l=l, r=r, v=v)


def export_model(mdl, path, offset=0.0):
    d = mdl.booster_.dump_model()
    trees = [compact_tree(ti["tree_structure"]) for ti in d["tree_info"]]
    names = d["feature_names"]
    # models are fit on arrays in FEATURES order, so LightGBM names them Column_0..n
    if len(names) == len(FEATURES) and all(n == f"Column_{i}" for i, n in enumerate(names)):
        names = FEATURES
    out = dict(features=names, objective=d.get("objective", ""), n_trees=len(trees), trees=trees)
    with open(path, "w") as fp:
        json.dump(out, fp, separators=(",", ":"))
    return out


def snap(x):
    return float(np.round(x * 10) / 10)


def scenario_inputs(rows):
    med = rows[FEATURES].median(numeric_only=True)
    out = {k: (None if pd.isna(med[k]) else float(med[k])) for k in FEATURES}
    for k in ["hour", "dow", "region_id", "aoi_id", "aoi_type"]:
        mode = rows[k].mode()
        out[k] = float(mode.iloc[0]) if len(mode) else out[k]
    out["minute_of_day"] = float(out["hour"] * 60 + 15)
    out["lng"], out["lat"] = snap(out["lng"]), snap(out["lat"])
    return out


def build_console(cfg, threads):
    """Retrain the week-25 models of low_quality seed 0 (Guard off and on) exactly as the final runs do,
    export them, and build five constructed scenarios from group medians."""
    from src.prep import add_dynamic_features
    from src.walkforward import build_run_feed, merged_guard_cfg, run
    base = pd.read_parquet(os.path.join(ROOT, cfg["data"]["processed_dir"], "cq.parquet"))
    wk = EXPORT_SPEC["week"]
    outs, feeds = {}, {}
    for g in (False, True):
        spec = dict(run_id=f"export_g{int(g)}", family="export", condition=EXPORT_SPEC["condition"], guard=g,
                    seed=EXPORT_SPEC["seed"], window=4, weeks=[wk])
        o = run(spec, base, cfg, threads=threads, diag=False, keep_models=True)
        outs[g] = o["models"][wk]
        feeds[g], _ = build_run_feed(base, spec, cfg)
    off, on = outs[False], outs[True]
    os.makedirs(MODELS, exist_ok=True)
    export_model(off["m50"], os.path.join(MODELS, "off_p50.json"))
    export_model(off["m80"], os.path.join(MODELS, "off_p80.json"))
    export_model(on["m50"], os.path.join(MODELS, "on_p50.json"))
    export_model(on["m80"], os.path.join(MODELS, "on_p80.json"))
    te_off = off["te"]
    te_on = feeds[True].loc[te_off.index]
    tr_on = on["tr"]
    area_rows = tr_on[~tr_on.order_id.duplicated()].aoi_id.value_counts()
    rep = on["rep"].rep
    sloppy_rep = float(rep.reindex(te_off[te_off.sloppy].courier_id.unique()).dropna().median())
    honest_rep = float(rep.reindex(te_off[~te_off.sloppy].courier_id.unique()).dropna().median())
    common = 1
    defs = []
    sel = (te_off.aoi_type == common) & (~te_off.sloppy) & te_off.hour.between(9, 11)
    defs.append(("normal", "Normal package", "A common area type mid-morning, reliable courier, fresh history.", sel, {}))
    defs.append(("stale", "Stale features", "Same package, but the feature store has not refreshed for 45 days (an outage).", sel,
                 {"stale_days": 45}))
    sel_s = (te_off.aoi_type == common) & te_off.sloppy & te_off.hour.between(9, 11)
    defs.append(("sloppy", "Sloppy-source area", "A courier whose recent scans are bulk end-of-day scans and re-uploads.", sel_s, {}))
    rare_types = te_off.aoi_type.value_counts(normalize=True)
    rare_t = [t for t in rare_types.index if rare_types[t] < cfg["rare_area_share"]]
    unseen = te_off.aoi_id.map(area_rows).fillna(0) == 0
    sel_r = te_off.aoi_type.isin(rare_t) & unseen
    defs.append(("rare", "Rare area", "A rare area type, and this area never appeared in the last four weeks.", sel_r, {}))
    sel_g = None
    gw = feeds[False]
    gw = gw[(gw.week == 22) & (~gw.is_dup) & (gw.accept_time < pd.Timestamp("2022-10-08"))]
    defs.append(("golden", "Golden Week", "A package accepted during National Day Golden Week, high open workload.",
                 gw.open_workload >= gw.open_workload.quantile(0.75), {"frame": gw}))
    start = pd.Timestamp(cfg["data"]["week0_start"])
    scenarios = []
    for sid, name, desc, mask, opt in defs:
        fr_off = opt.get("frame", te_off)
        rows_off = fr_off[mask]
        if sid == "golden":
            rows_on = feeds[True].loc[rows_off.index]
        else:
            rows_on = te_on.loc[rows_off.index]
        inp_off, inp_on = scenario_inputs(rows_off), scenario_inputs(rows_on)
        hist_age = 1.0
        if opt.get("stale_days"):
            day = int(rows_off.day.mode().iloc[0])
            r1 = rows_off[rows_off.day == day]
            stale = add_dynamic_features(feeds[False], cfg, freeze_day=day - opt["stale_days"] - 1, rows=r1)
            for k in ["courier_hist_mean", "area_hist_mean"]:
                v = stale[k].median()
                inp_off[k] = inp_on[k] = None if pd.isna(v) else float(v)
            hist_age = float(opt["stale_days"] + 1)
        ar = float(rows_off.aoi_id.map(area_rows).fillna(0).median())
        scenarios.append(dict(id=sid, name=name, description=desc, n_packages=int(len(rows_off)),
                              inputs_off=inp_off, inputs_on=inp_on,
                              meta=dict(hist_age_days=hist_age, gps_age_min=float(rows_off.gps_age_min.median()),
                                        area_rows=ar, aoi_type=int(inp_off["aoi_type"]),
                                        reputation=sloppy_rep if sid == "sloppy" else honest_rep)))
    g = merged_guard_cfg(cfg, {})
    console = dict(features=FEATURES, week=wk, condition=EXPORT_SPEC["condition"], seed=EXPORT_SPEC["seed"],
                   offsets=on["offset"], offset_global=on["offset_global"], width_med=on["width_med"],
                   width_glob=on["width_glob"], guard=dict(l2=g["l2"], l3=g["l3"]), review_seconds=45,
                   scenarios=scenarios, location_note="Location inputs snapped to a 0.1-degree grid cell; not displayed.")
    # 20-input verification set (kept out of docs/: real feature rows): 10 real test rows + 10 synthetic with NaNs
    rng = np.random.default_rng(0)
    real = te_off.sample(10, random_state=0)[FEATURES].to_numpy(np.float32).astype(float)
    synth = []
    for i in range(10):
        s = dict(scenarios[i % len(scenarios)]["inputs_off"])
        x = np.array([np.nan if s[k] is None else s[k] for k in FEATURES], float)
        x = x * rng.uniform(0.7, 1.3, len(x))
        x[rng.choice(len(x), 2, replace=False)] = np.nan
        x[[0, 2, 3, 4, 5]] = np.round(x[[0, 2, 3, 4, 5]])
        synth.append(x)
    X = np.vstack([real, np.vstack(synth)]).astype(np.float32)
    py = {k: outs[g_][m].predict(X, num_threads=1).tolist()
          for k, g_, m in [("off_p50", False, "m50"), ("off_p80", False, "m80"), ("on_p50", True, "m50"), ("on_p80", True, "m80")]}
    os.makedirs(os.path.join(ROOT, "logs"), exist_ok=True)
    with open(os.path.join(ROOT, "logs", "model_check_inputs.json"), "w") as fp:
        json.dump(dict(features=FEATURES, X=[[None if np.isnan(v) else float(v) for v in row] for row in X], python=py), fp)
    return console


# ---------------------------------------------------------------- mock frames

def mock_frames(cfg):
    rng = np.random.default_rng(0)
    rows, chain, imp, probe, det = [], [], [], [], []
    conds = ["reference", "stale", "low_quality", "combined"]

    def mk(family, cond, guard, seed, weeks, **kw):
        rid = f"{family}-{cond}-{int(guard)}-{seed}-{kw.get('window_weeks', '4')}-{kw.get('severity')}-{kw.get('control')}"
        for t in weeks:
            base = 190 + 20 * np.sin(t / 3)
            pen = {"reference": 0, "stale": 4, "low_quality": 0.6 * t, "combined": 0.7 * t + 3, "unseen": 6 if t >= 18 else 0}[cond]
            if guard:
                pen *= 0.35
            mae = base + pen + rng.normal(0, 0.4)
            rows.append(dict(run_id=rid, family=family, condition=cond, guard=guard, seed=seed, week=t,
                             window_weeks=kw.get("window_weeks", "4"), severity=kw.get("severity"), control=kw.get("control"),
                             mae_min=mae, mae_trim_min=mae * 0.6, p90_err_min=mae * 1.3, miss_rate=0.2 + rng.normal(0, 0.01) - (0.03 if cond != "reference" and not guard else 0),
                             promise_width_min=330 + pen, defer_rate=0.07 if guard else 0.0, rare_mae_min=mae * 1.1,
                             mean_train_age_days=14 if cond in ("reference", "low_quality") else 7 * t / 2,
                             sloppy_share_train=0.2 * (cond in ("low_quality", "combined")) * (0.3 if guard else 1),
                             dup_share_train=0.05 * (cond in ("low_quality", "combined")),
                             injected_share_train=0.1 * (cond in ("low_quality", "combined")),
                             feature_age_days=1 if cond not in ("stale", "combined") else max(1, 7 * t - 55),
                             n_test=30000, n_train_rows=120000, eff_n_train=90000 if guard else 120000,
                             frac_downweighted=0.3 if guard else 0, train_seconds=8.0, config_hash="mock", git_sha="mock"))
            chain.append(dict(run_id=rid, week=t, train_label_median=150 + pen, ref_label_median=150,
                              train_label_ks_vs_ref=0.01 + pen / 100, probe_shift_p50=pen, probe_shift_p80=pen * 1.4))
            for f in FEATURES:
                imp.append(dict(run_id=rid, week=t, feature=f, mean_abs_shap=abs(rng.normal(20, 10))))
            if guard:
                det.append(dict(run_id=rid, week=t, tp=900, fp=60, fn=300, tn=100000))

    dev, fin = list(range(4, 22)), list(range(22, 26))
    for c in conds:
        for g in (False, True):
            for s in (0, 1, 2):
                mk("main", c, g, s, dev)
    for c in conds + ["unseen"]:
        for g in (False, True):
            for s in (0, 1, 2):
                mk("final", c, g, s, fin)
    for wdw in ["1", "2", "4", "8", "16", "all"]:
        for c in ["reference", "low_quality"]:
            mk("shelf_life", c, False, 0, dev, window_weeks=wdw)
    for sev in [0.0, 0.15, 0.35, 0.6]:
        for g in (False, True):
            mk("dose", "low_quality", g, 0, dev, severity=sev)
    for ctrl, c in [("oracle", "low_quality"), ("random", "low_quality"), ("frozen_model", "reference"), ("frozen_features", "reference")]:
        mk("controls", c, False, 0, dev, control=ctrl)
    w = pd.DataFrame(rows)
    return w, pd.DataFrame(chain), pd.DataFrame(imp), pd.DataFrame(probe), pd.DataFrame(det)


def mock_results(w, det):
    from src import aggregate as ag
    res = dict(config=load_config(), versions=ag.versions(), runs=int(w.run_id.nunique()), retrains=len(w), config_hash="mock",
               git_sha="mock", mock=True)
    res["dev"] = ag.summarize_block(w[w.family == "main"], det, w[w.family == "controls"], "dev")
    res["final"] = ag.summarize_block(w[w.family == "final"], det, None, "final")
    res["headline"] = ag.headline(res)
    for fam, keys in [("shelf_life", ["condition", "window_weeks"]), ("dose", ["severity", "guard"]), ("controls", ["condition", "control"])]:
        f = w[w.family == fam]
        res[fam] = f.groupby(keys).agg(mae=("mae_min", "mean")).reset_index().to_dict("records")
    return res


def mock_console(cfg):
    import lightgbm as lgb
    rng = np.random.default_rng(1)
    X = rng.normal(size=(3000, len(FEATURES))).astype(np.float32)
    X[rng.random(X.shape) < 0.05] = np.nan
    y = 150 + 40 * np.nan_to_num(X[:, 0]) + rng.normal(0, 20, 3000)
    os.makedirs(MODELS, exist_ok=True)
    for name, obj in [("off_p50", "l1"), ("off_p80", "quantile"), ("on_p50", "l1"), ("on_p80", "quantile")]:
        m = lgb.LGBMRegressor(n_estimators=20, num_leaves=7, objective=obj, alpha=0.8, verbose=-1).fit(X, y)
        export_model(m, os.path.join(MODELS, f"{name}.json"))
    base = {k: 0.0 for k in FEATURES}
    sc = []
    for sid, name in [("normal", "Normal package"), ("stale", "Stale features"), ("sloppy", "Sloppy-source area"),
                      ("rare", "Rare area"), ("golden", "Golden Week")]:
        sc.append(dict(id=sid, name=name, description="mock scenario", n_packages=100, inputs_off=dict(base), inputs_on=dict(base),
                       meta=dict(hist_age_days=46.0 if sid == "stale" else 1.0, gps_age_min=0.0,
                                 area_rows=0.0 if sid == "rare" else 12.0, aoi_type=1, reputation=0.2 if sid == "sloppy" else 1.0)))
    from src.walkforward import merged_guard_cfg
    g = merged_guard_cfg(cfg, {})
    return dict(features=FEATURES, week=25, condition="mock", seed=0, offsets={"1": 10.0}, offset_global=5.0,
                width_med={"1": 60.0}, width_glob=60.0, guard=dict(l2=g["l2"], l3=g["l3"]), review_seconds=45, scenarios=sc,
                location_note="mock")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--no-models", action="store_true")
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    cfg = load_config()
    os.makedirs(DATA, exist_ok=True)
    t0 = time.time()
    if a.mock:
        w, chain, imp, probe, det = mock_frames(cfg)
        res = mock_results(w, det)
        ml = pd.DataFrame()
    else:
        R = os.path.join(ROOT, "results")
        w = pd.read_parquet(os.path.join(R, "weekly_metrics.parquet"))
        chain = pd.read_parquet(os.path.join(R, "chain.parquet"))
        imp = pd.read_parquet(os.path.join(R, "importance.parquet"))
        probe = pd.read_parquet(os.path.join(R, "probe_preds.parquet"))
        det = pd.read_parquet(os.path.join(R, "detector.parquet"))
        res = json.load(open(os.path.join(R, "results.json")))
        mlp = os.path.join(R, "modification_log.csv")
        ml = pd.read_csv(mlp) if os.path.exists(mlp) else pd.DataFrame()
        shutil.copy(os.path.join(R, "results.json"), os.path.join(DATA, "results.json"))
    w["guard"] = w.guard.astype(bool)
    summary = {k: v for k, v in res.items() if k not in ("config",)}
    summary["guard_config"] = res.get("config", cfg).get("guard")
    summary["generated"] = time.strftime("%Y-%m-%d %H:%M %Z")
    dump("summary.json", summary)
    dump("timeline.json", build_timeline(w, res))
    dump("mechanism.json", build_mechanism(w, chain, imp, probe, res))
    dump("shelf.json", build_shelf(w))
    dump("modlog.json", build_modlog(ml))
    dump("manifest.json", build_manifest())
    cols = ["family", "condition", "guard", "seed", "window_weeks", "severity", "control", "week", "week_start"] + \
        [c for c in METRICS + TRACKS + ["train_seconds", "config_hash", "git_sha"] if c in w]
    w[[c for c in cols if c in w]].sort_values(["family", "condition", "guard", "seed", "week"]).to_csv(
        os.path.join(DATA, "weekly_metrics.csv"), index=False, float_format="%.4f")
    if a.mock:
        with open(os.path.join(DATA, "results.json"), "w") as f:
            json.dump(_clean(res), f)
        dump("console.json", mock_console(cfg))
    elif not a.no_models:
        dump("console.json", build_console(cfg, a.threads))
    print(f"exported in {time.time() - t0:.0f}s:", sorted(os.listdir(DATA)), sorted(os.listdir(MODELS)) if os.path.exists(MODELS) else [])


if __name__ == "__main__":
    main()
