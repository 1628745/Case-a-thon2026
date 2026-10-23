"""The "Try it" lab experiment: one split of the study on any LaDe-format file.

Runs natively (scripts/lab_native.py) and in the browser (docs/lab-worker.js runs the copy in
docs/py/guardlab that scripts/build_lab.py generates from the src package). No file I/O, yaml or subprocess here.
Must run on pandas 2.3 (Pyodide) and 3.0 (.venv).

Design (LAB_PLAN.md section 3): week 0 = the Sunday on or before the earliest accept date; only full
weeks are trained or tested; test week T = the last full week; training = weeks T-4..T-1; history
features come from all earlier data. Defects touch training data and history features only: the
test week is scored on the uploaded durations (`ref_duration_min`).
"""
import copy
import hashlib
import platform
import sys
import time

import numpy as np
import pandas as pd

from src.audit import audit_frame
from src.common import parse_times
from src.degrade import bulk_scan, duplicate_upload, early_couriers, early_scan, sloppy_couriers
from src.guard import apply_guard, l1_flags
from src.model import Timer, fit, predict
from src.prep import FEATURES, clean_frame
from src.walkforward import attach_features

SCHEMA = "guardlab-result/1"
REQUIRED = ["order_id", "courier_id", "region_id", "aoi_id", "aoi_type", "lng", "lat", "accept_time",
            "accept_gps_time", "accept_gps_lng", "accept_gps_lat", "delivery_time"]
OPTIONAL = ["delivery_gps_lng", "delivery_gps_lat", "ds"]
NUMERIC = ["order_id", "courier_id", "region_id", "aoi_id", "aoi_type", "lng", "lat", "accept_gps_lng",
           "accept_gps_lat", "delivery_gps_lng", "delivery_gps_lat", "ds"]
TIMES = ["accept_time", "accept_gps_time", "delivery_time"]
MIN_FULL_WEEKS = 6
TRAIN_WEEKS = 4
BIG_ROWS = 400_000
BIG_KEEP_WEEKS = 7
PRESETS = {
    "clean": [],
    "sloppy": ["bulk", "dup"],
    "stale": ["stale"],
    "sloppy_stale": ["bulk", "dup", "stale"],
    "unseen": ["early"],
}
BUDGETS = {"quick": dict(n_estimators=150, num_leaves=31, row_cap=120_000),
           "full": dict(n_estimators=None, num_leaves=None, row_cap=None)}  # None = config.yaml / no cap
DISPATCHER_SEC = 45  # assumed dispatcher time per deferred package


class LabError(Exception):
    """A problem with the user's file, worded for the user."""


def versions():
    import lightgbm
    return {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
            "lightgbm": lightgbm.__version__, "platform": sys.platform if sys.platform == "emscripten" else platform.platform()}


def courier_hash(ids, salt):
    return [hashlib.sha256((salt + ":" + str(int(i))).encode()).hexdigest()[:8] for i in ids]


# ---------------------------------------------------------------- reading and audit

def read_lab_csv(src):
    """Read only the needed columns with explicit dtypes. `src` = path or file-like."""
    try:
        head = pd.read_csv(src, nrows=0)
    except Exception as e:
        raise LabError(f"This doesn't look like a CSV file ({type(e).__name__}).")
    if hasattr(src, "seek"):
        src.seek(0)
    cols = [str(c).strip() for c in head.columns]
    missing = [c for c in REQUIRED if c not in cols]
    if missing:
        raise LabError("Missing column" + ("s" if len(missing) > 1 else "") + ": " + ", ".join(missing) +
                       ". The file needs the LaDe delivery columns (as in delivery_cq.csv).")
    use = [c for c in REQUIRED + OPTIONAL if c in cols]
    dtype = {c: "float64" for c in use if c in NUMERIC}
    dtype.update({c: object for c in use if c in TIMES})
    try:
        raw = pd.read_csv(src, usecols=use, dtype=dtype)
    except ValueError as e:
        raise LabError(f"A column has values that aren't numbers where numbers are expected ({e}).")
    return raw


def week_layout(at):
    """at: parsed accept times. -> week0 Sunday, full weeks (contiguous range), per-week rows."""
    t0, t1 = at.min().normalize(), at.max().normalize()
    week0 = t0 - pd.Timedelta(days=(t0.dayofweek + 1) % 7)  # Sunday on or before
    wk = ((at.dt.normalize() - week0).dt.days // 7)
    n = int(wk.max()) + 1
    full = [w for w in range(n) if week0 + pd.Timedelta(days=7 * w) >= t0 and week0 + pd.Timedelta(days=7 * w + 6) <= t1]
    counts = wk.value_counts().sort_index()
    rows = [{"week": int(w), "start": str((week0 + pd.Timedelta(days=7 * w)).date()), "rows": int(counts.get(w, 0)),
             "full": w in full} for w in range(n)]
    return week0, full, rows


def lab_audit(raw, cfg, year):
    """Schema/time checks, week coverage and the observed issues of src/audit.py."""
    at = parse_times(raw["accept_time"], year)
    dt = parse_times(raw["delivery_time"], year)
    ok_t = at.notna()
    if not ok_t.any():
        ex = str(raw["accept_time"].dropna().astype(str).head(1).tolist()[:1])
        raise LabError("None of the accept_time values could be read. Expected the LaDe format "
                       f"'MM-DD HH:MM:SS' (for example 06-18 08:00:00); found {ex}.")
    week0, full, rows = week_layout(at[ok_t])
    acfg = {"data": {"year": year, "week0_start": str(week0.date()), "n_weeks": len(rows)}}
    a = audit_frame(raw, acfg)
    keep = ["unparseable_accept", "unparseable_delivery", "date_range_accept", "duration_min_quantiles",
            "observed_issues", "n_couriers", "n_aoi", "n_regions"]
    out = {k: a[k] for k in keep}
    out["observed_issues"].pop("gps_fix_age_quantiles_min", None)
    out.update(rows=int(len(raw)), week0_start=str(week0.date()), weeks=rows, n_full_weeks=len(full),
               full_weeks=full, unparseable_any=int((at.isna() | dt.isna()).sum()),
               missing_ids=int(raw[["order_id", "courier_id", "aoi_id", "region_id", "aoi_type"]].isna().any(axis=1).sum()),
               columns_used=list(raw.columns), year=year)
    msgs = []
    if len(full) < MIN_FULL_WEEKS:
        msgs.append(f"Only {len(full)} full week(s) (Sunday to Saturday) of accept dates; the experiment needs at least "
                    f"{MIN_FULL_WEEKS}: {TRAIN_WEEKS} to train on, 1 earlier week for history features and 1 to test.")
    else:
        t = full[-1]
        thin = [w for w in range(t - TRAIN_WEEKS - 1, t + 1) if rows[w]["rows"] == 0 or w not in full]
        if thin:
            msgs.append("These weeks are empty or incomplete inside the needed range: " +
                        ", ".join(rows[w]["start"] for w in thin) + ".")
    if out["unparseable_any"] > 0.5 * len(raw):
        msgs.append(f"{out['unparseable_any']:,} of {len(raw):,} rows have times that can't be read as 'MM-DD HH:MM:SS'.")
    out["ok"] = not msgs
    out["problems"] = msgs
    if full:
        t = full[-1]
        out["plan"] = {"test_week": t, "test_start": rows[t]["start"],
                       "train_weeks": list(range(t - TRAIN_WEEKS, t)),
                       "train_start": rows[max(0, t - TRAIN_WEEKS)]["start"]}
    out["big_file"] = len(raw) > BIG_ROWS
    return out


# ---------------------------------------------------------------- preparation

def lab_config(cfg, week0, t, budget, sloppy_share):
    """config.yaml with the data span set to this file and the defect ramps mapped onto the training
    window (LAB_PLAN.md section 3). The guard block is not touched."""
    c = copy.deepcopy(cfg)
    c["data"]["week0_start"] = str(week0.date())
    c["data"]["n_weeks"] = t + 1
    s = t - TRAIN_WEEKS
    c["splits"]["warmup"] = [0, t - 1]  # sloppy/early couriers are drawn from couriers active before the test week
    lq = c["degrade"]["low_quality"]
    lq.update(start_week=s, p_span_weeks=TRAIN_WEEKS - 1, dup_start_week=s + TRAIN_WEEKS // 2, sloppy_share=sloppy_share)
    c["degrade"]["unseen"]["start_week"] = s
    b = BUDGETS[budget]
    if b["n_estimators"]:
        c["model"]["n_estimators"] = b["n_estimators"]
        c["model"]["num_leaves"] = b["num_leaves"]
    return c


def prepare(raw, cfg, year, budget="quick", sloppy_share=0.2):
    """-> base (processed rows of weeks < T+1), lab cfg, split info."""
    at = parse_times(raw["accept_time"], year)
    if at.notna().sum() == 0:
        raise LabError("No readable accept times.")
    week0, full, rows = week_layout(at[at.notna()])
    if len(full) < MIN_FULL_WEEKS:
        raise LabError(f"Only {len(full)} full weeks; at least {MIN_FULL_WEEKS} are needed.")
    t = full[-1]
    lcfg = lab_config(cfg, week0, t, budget, sloppy_share)
    lcfg["data"]["year"] = year
    ids = ["order_id", "courier_id", "region_id", "aoi_id", "aoi_type"]
    raw = raw[raw[ids].notna().all(axis=1)]
    base = clean_frame(raw, lcfg, src_row=True)
    trimmed = False
    if len(base) > BIG_ROWS:
        base = base[base.week >= t - BIG_KEEP_WEEKS + 1].reset_index(drop=True)
        base["row_id"] = np.arange(len(base), dtype=np.int64)
        trimmed = True
    train = list(range(t - TRAIN_WEEKS, t))
    for w in train + [t]:
        if not (base.week == w).any():
            raise LabError(f"Week starting {rows[w]['start']} has no usable rows.")
    first_full = min(w for w in full if w >= (t - BIG_KEEP_WEEKS + 1 if trimmed else 0))
    split = {"week0_start": str(week0.date()), "test_week": t, "train_weeks": train,
             "stale_weeks": list(range(first_full, t)), "test_start": rows[t]["start"],
             "train_start": rows[train[0]]["start"], "first_full_week": first_full,
             "rows_file": int(len(raw)), "rows_used": int(len(base)), "trimmed_to_last_weeks": BIG_KEEP_WEEKS if trimmed else None}
    return base, lcfg, split


def cap_couriers(base, weeks, cap, seed):
    """Whole couriers (seeded order) whose training rows fit under `cap`; None = no cap needed."""
    if not cap:
        return None
    n = base.loc[base.week.isin(weeks), "courier_id"].value_counts().sort_index()
    if n.sum() <= cap:
        return None
    order = np.random.default_rng([seed, 23]).permutation(n.index.to_numpy())
    cum = n.reindex(order).cumsum().to_numpy()
    return set(order[cum <= cap].tolist())


def build_lab_feed(base, mechs, seed, lcfg):
    """Apply the selected src/degrade.py mechanisms. Labels (injected, sloppy, is_dup, early) only score
    detectors; the Guard and the models never read them."""
    feed = base.copy()
    for col in ["is_dup", "injected", "sloppy", "early"]:
        feed[col] = False
    log = []
    cs, ce = set(), set()
    if "bulk" in mechs or "dup" in mechs:
        cs = sloppy_couriers(base, seed, lcfg, lcfg["degrade"]["low_quality"]["sloppy_share"])
        feed["sloppy"] = feed.courier_id.isin(cs)
        if "bulk" in mechs:
            feed, lg = bulk_scan(feed, cs, seed, lcfg, "lab")
            log += lg
        if "dup" in mechs:
            feed, lg = duplicate_upload(feed, cs, seed, lcfg, "lab")
            log += lg
    if "early" in mechs:
        ce = early_couriers(base, seed, lcfg)
        feed, lg = early_scan(feed, ce, seed, lcfg, "lab")
        log += lg
    if "stale" in mechs:
        log.append(dict(mechanism="stale_features", rows_affected=int((feed.week >= lcfg["degrade"]["low_quality"]["start_week"]).sum())))
    return feed, log, cs, ce


# ---------------------------------------------------------------- one run

def _fit_pair(tr, te, t, lcfg, g, seed, guard, release):
    with Timer() as tm:
        if guard:
            res = apply_guard(tr, te, t, lcfg, g, seed, 1, release=release)
        else:
            X = tr[FEATURES].to_numpy(np.float32)
            y = tr.label.to_numpy()
            res = {"m50": fit(X, y, None, lcfg, seed, 1),
                   "m80": fit(X, y, None, lcfg, seed, 1, quantile=lcfg["model"]["quantile_alpha"]), "tr": tr}
    res["train_s"] = tm.s
    return res


def one_run(key, feed, lcfg, g, split, seed, guard, freeze_day, keep, release=None, stale_window=False):
    t = split["test_week"]
    full = attach_features(feed, lcfg, g if guard else None, freeze_day)
    weeks = split["stale_weeks"] if stale_window else split["train_weeks"]
    tr = full[full.week.isin(weeks)].copy()
    if keep is not None:
        tr = tr[tr.courier_id.isin(keep)].copy()
    te = full[(full.week == t) & (~full.is_dup)].copy()
    tr["w"] = 1.0
    tr["age_weeks"] = t - tr.week - 1
    res = _fit_pair(tr, te, t, lcfg, g, seed, guard, release)
    Xte = res.get("Xte", te[FEATURES].to_numpy(np.float32))
    with Timer() as tp:
        p50 = predict(res["m50"], Xte)
        p80 = res["p80_test"] if "p80_test" in res else predict(res["m80"], Xte)
    if "p80_test" in res:  # guarded P80 was predicted inside apply_guard; time one extra pass for latency
        with Timer() as tp2:
            predict(res["m80"], Xte)
        tp.s += tp2.s
    defer = res.get("defer", np.zeros(len(te), bool))
    y = te.ref_duration_min.to_numpy()
    err = np.abs(y - p50)
    tu = res["tr"]
    w = tu.w.to_numpy()
    m = dict(key=key, guard=bool(guard), mae=float(err.mean()), p90_err=float(np.quantile(err, 0.9)),
             miss_rate=float((y > p80).mean()), promise_mean=float(p80.mean()), width_mean=float((p80 - p50).mean()),
             defer_rate=float(defer.mean()), n_deferred=int(defer.sum()),
             mae_served=float(err[~defer].mean()) if (~defer).any() else None,
             n_train=int(len(tu)), eff_n=float(w.sum() ** 2 / (w ** 2).sum()),
             frac_downweighted=float((w < 0.5 * tu.get("w_rec", tu.w).to_numpy()).mean()),
             n_test=int(len(te)), train_s=float(res["train_s"]),
             predict_ms_per_pkg=float(1000 * tp.s / max(1, len(te))),
             feature_age_days=float(te.hist_age_days.mean()))
    return m, dict(res=res, te=te, p50=p50, p80=p80, defer=defer, err=err, Xte=Xte)


# ---------------------------------------------------------------- the experiment

def _mechs(opt):
    m = opt.get("mechanisms")
    if m is None:
        m = PRESETS[opt.get("preset", "sloppy")]
    return [x for x in ["bulk", "dup", "stale", "early"] if x in m]


def run_lab(base, lcfg, split, opt, progress=None, salt="guardlab"):
    """opt: preset, mechanisms (optional override), sloppy_share, seed, budget, release (courier hashes).
    -> JSON-able result (schema SCHEMA)."""
    prog = progress or (lambda step, pct, msg: None)
    t_all = time.perf_counter()
    seed = int(opt.get("seed", 0))
    budget = opt.get("budget", "quick")
    mechs = _mechs(opt)
    injected = bool(mechs)
    g = copy.deepcopy(lcfg["guard"])
    t = split["test_week"]
    timings = {}
    stale = "stale" in mechs
    freeze_day = (split["train_weeks"][0] * 7 - 1) if stale else None
    cap = BUDGETS[budget]["row_cap"]
    keep = cap_couriers(base, split["train_weeks"], cap, seed)  # the reference always uses the 4-week window
    keep_stale = cap_couriers(base, split["stale_weeks"], cap, seed) if stale else keep
    all_c = np.sort(base.courier_id.unique())
    hmap = dict(zip(courier_hash(all_c, salt), all_c.tolist()))
    release = {hmap[h] for h in opt.get("release", []) if h in hmap}

    prog("inject", 12, "Injecting defects" if injected else "No defects selected")
    with Timer() as ti:
        feed, log, cs, ce = build_lab_feed(base, mechs, seed, lcfg)
        ref = build_lab_feed(base, [], seed, lcfg)[0]
    timings["inject_s"] = ti.s
    runs, keep_out = [], {}
    if injected:
        plan = [("reference", "Reference (as uploaded, Guard off)", ref, False, None, False, keep),
                ("degraded_off", "Poisoned, Guard off", feed, False, freeze_day, stale, keep_stale),
                ("degraded_on", "Poisoned, Guard on", feed, True, freeze_day, stale, keep_stale)]
    else:
        plan = [("clean_off", "As uploaded, Guard off", ref, False, None, False, keep),
                ("clean_on", "As uploaded, Guard on", ref, True, None, False, keep)]
    for i, (key, label, f, guard, fz, sw, kp) in enumerate(plan):
        prog("train_" + key, 18 + 22 * i, f"Building features and training: {label}")
        with Timer() as tr_t:
            m, k = one_run(key, f, lcfg, g, split, seed, guard, fz, kp, release if guard else None, sw)
        m["label"] = label
        m["run_s"] = tr_t.s
        runs.append(m)
        keep_out[key] = k
    prog("score", 86, "Scoring and explaining")
    with Timer() as ts:
        out = _summarize(runs, keep_out, base, feed, log, cs, ce, mechs, opt, lcfg, split, keep, keep_stale, salt, release, g)
    timings["score_s"] = ts.s
    timings["total_s"] = time.perf_counter() - t_all
    out["timings"] = timings
    prog("done", 100, "Done")
    return out


def _verdict(runs, injected):
    r = {m["key"]: m for m in runs}
    if injected:
        ref, off, on = r["reference"]["mae"], r["degraded_off"]["mae"], r["degraded_on"]["mae"]
        gap, floor = off - ref, 0.01 * ref
        rec = (off - on) / gap if gap > floor else None
        if gap <= floor:
            v = "neutral"
            s = (f"The defect did not measurably hurt this dataset (MAE {off:.1f} vs {ref:.1f} min). "
                 f"With the Guard on, MAE is {on:.1f} min.")
        elif on > off:
            v = "red"
            s = f"The Guard made things worse here: MAE {on:.1f} min with it, {off:.1f} without (reference {ref:.1f})."
        elif rec > 1:
            v = "green"
            s = (f"The Guard recovered all of the damage and ended below the reference: MAE {off:.1f} -> {on:.1f} min "
                 f"(reference {ref:.1f}).")
        elif rec >= 0.5:
            v = "green"
            s = f"The Guard recovered {100 * rec:.0f}% of the damage: MAE {off:.1f} -> {on:.1f} min (reference {ref:.1f})."
        else:
            v = "neutral"
            s = f"The Guard recovered only {100 * rec:.0f}% of the damage: MAE {off:.1f} -> {on:.1f} min (reference {ref:.1f})."
        return {"kind": "injected", "gap_min": gap, "noise_floor_min": floor,
                "recovery_pct": None if rec is None else 100 * rec, "verdict": v, "sentence": s}
    off, on = r["clean_off"]["mae"], r["clean_on"]["mae"]
    cost, floor = on - off, 0.01 * off
    if cost < -floor:
        v, s = "green", f"On your data as uploaded the Guard lowered MAE from {off:.1f} to {on:.1f} min, by cleaning issues already in the file."
    elif cost <= floor:
        v, s = "neutral", f"Nothing much to fix: the Guard's cost on your data is {cost:+.1f} min MAE ({off:.1f} -> {on:.1f})."
    else:
        v, s = "red", f"The Guard costs {cost:+.1f} min MAE on your data as uploaded ({off:.1f} -> {on:.1f})."
    return {"kind": "clean", "cost_min": cost, "noise_floor_min": floor, "recovery_pct": None, "verdict": v, "sentence": s}


def _summarize(runs, k, base, feed, log, cs, ce, mechs, opt, lcfg, split, keep, keep_stale, salt, release, g):
    injected = bool(mechs)
    on_key = "degraded_on" if injected else "clean_on"
    off_key = "degraded_off" if injected else "clean_off"
    gk = k[on_key]
    res = gk["res"]
    tr = res["tr"]
    flags = l1_flags(tr, g)
    reasons = res["defer_reasons"]
    guard = {"n_train": int(len(tr)),
             "flags": {c: int(flags[c].sum()) for c in ["nonpos", "burst", "dup", "gps_age", "far", "any"]},
             "quarantined": int(flags["any"].sum()),
             "frac_downweighted": next(m["frac_downweighted"] for m in runs if m["key"] == on_key),
             "eff_n": next(m["eff_n"] for m in runs if m["key"] == on_key),
             "deferred": int(gk["defer"].sum()), "n_test": int(len(gk["te"])),
             "defer_reasons": {n: int(reasons[:, i].sum()) for i, n in enumerate(["hist", "gps", "area", "width"])}}
    det = None
    if injected:
        fl, inj = flags["any"].to_numpy(), tr.injected.to_numpy()
        tp, fp, fn, tn = int((fl & inj).sum()), int((fl & ~inj).sum()), int((~fl & inj).sum()), int((~fl & ~inj).sum())
        det = dict(tp=tp, fp=fp, fn=fn, tn=tn, precision=tp / (tp + fp) if tp + fp else None,
                   recall=tp / (tp + fn) if tp + fn else None, fpr=fp / (fp + tn) if fp + tn else None,
                   injected_train_rows=int(inj.sum()))
    rep = res["rep"].copy()
    rep["hash"] = courier_hash(rep.index.to_numpy(), salt)
    edges = np.round(np.linspace(0.1, 1.0, 19), 3)
    counts, _ = np.histogram(rep.rep.to_numpy(), bins=edges)
    low = rep.sort_values(["rep", "n"], ascending=[True, False]).head(10)
    lowest = [dict(courier=r.hash, n=int(r.n), flag_rate=float(r.flag_rate), z=float(r.z), rep=float(r.rep),
                   sloppy=bool(i in cs) if injected else None, early=bool(i in ce) if injected else None,
                   released=bool(i in release)) for i, r in low.iterrows()]
    reputation = {"edges": edges.tolist(), "counts": counts.astype(int).tolist(), "n_couriers": int(len(rep)),
                  "lowest": lowest, "n_sloppy": len(cs), "n_early": len(ce),
                  "sloppy_caught": int(sum(rep.loc[rep.index.isin(list(cs)), "rep"] < 0.5)) if cs else None}
    q = tr.loc[flags["any"].to_numpy()]
    fq = flags.loc[flags["any"].to_numpy()]
    why = [";".join(c for c in ["nonpos", "burst", "dup", "gps_age", "far"] if row[c]) for _, row in fq.iterrows()]
    quarantine = {"columns": ["file_line", "courier", "reasons", "note"],
                  "rows": [[int(s) + 2, h, w, "copy made by the poison dial" if d else ""]
                           for s, h, w, d in zip(q.src_row.to_numpy(), courier_hash(q.courier_id.to_numpy(), salt), why,
                                                 q.is_dup.to_numpy())]}
    inj_sum = {}
    for r in log:
        inj_sum[r["mechanism"]] = inj_sum.get(r["mechanism"], 0) + int(r["rows_affected"])
    on_m = next(m for m in runs if m["key"] == on_key)
    human = {"deferred": guard["deferred"], "sec_per_pkg_assumed": DISPATCHER_SEC,
             "dispatcher_min": guard["deferred"] * DISPATCHER_SEC / 60,
             "train_s_guard": on_m["train_s"], "predict_ms_per_pkg": on_m["predict_ms_per_pkg"],
             "n_test": guard["n_test"]}
    lc = lcfg["model"]
    settings = {"preset": opt.get("preset", "sloppy"), "mechanisms": mechs,
                "sloppy_share": float(lcfg["degrade"]["low_quality"]["sloppy_share"]) if ("bulk" in mechs or "dup" in mechs) else None,
                "seed": int(opt.get("seed", 0)), "budget": opt.get("budget", "quick"), "n_estimators": lc["n_estimators"],
                "num_leaves": lc["num_leaves"], "row_cap": BUDGETS[opt.get("budget", "quick")]["row_cap"],
                "capped": keep is not None or keep_stale is not None,
                "couriers_kept": None if keep is None else len(keep),
                "couriers_kept_stale_window": None if keep_stale is None or keep_stale is keep else len(keep_stale),
                "year": int(lcfg["data"]["year"]), "released": sorted(opt.get("release", [])),
                "freeze_after": split["train_start"] if "stale" in mechs else None,
                "ramp": {"bulk_p": [lcfg["degrade"]["low_quality"]["p_start"], lcfg["degrade"]["low_quality"]["p_max"]],
                         "dup_from_week": lcfg["degrade"]["low_quality"]["dup_start_week"],
                         "dup_prob": lcfg["degrade"]["low_quality"]["dup_prob"],
                         "early_share": lcfg["degrade"]["unseen"]["share"]}}
    return {"schema": SCHEMA, "settings": settings, "data": split, "runs": runs,
            "headline": _verdict(runs, injected), "guard": guard, "detector": det, "reputation": reputation,
            "injection": inj_sum, "explain": explain(k, off_key, on_key, cs, base, split),
            "human": human, "versions": versions(), "quarantine": quarantine}


def run_sweep(base, lcfg, split, opt, shares=(0.0, 0.2, 0.4, 0.6), progress=None):
    """Dose-response on this file: sloppy-courier share -> MAE Guard off / on (bulk scans + duplicates)."""
    prog = progress or (lambda step, pct, msg: None)
    seed = int(opt.get("seed", 0))
    g = copy.deepcopy(lcfg["guard"])
    keep = cap_couriers(base, split["train_weeks"], BUDGETS[opt.get("budget", "quick")]["row_cap"], seed)
    pts = []
    for i, sh in enumerate(shares):
        c = copy.deepcopy(lcfg)
        c["degrade"]["low_quality"]["sloppy_share"] = float(sh)
        feed = build_lab_feed(base, ["bulk", "dup"] if sh > 0 else [], seed, c)[0]
        row = {"share": float(sh)}
        for j, guard in enumerate([False, True]):
            prog("sweep", int(100 * (2 * i + j) / (2 * len(shares))), f"Sloppy share {100 * sh:.0f}%, Guard {'on' if guard else 'off'}")
            m, _ = one_run("sweep", feed, c, g, split, seed, guard, None, keep)
            row["mae_on" if guard else "mae_off"] = m["mae"]
            row["p90_on" if guard else "p90_off"] = m["p90_err"]
        pts.append(row)
    prog("done", 100, "Done")
    return {"schema": SCHEMA + "/sweep", "points": pts, "seed": seed, "budget": opt.get("budget", "quick")}


# ---------------------------------------------------------------- explain a prediction

def _contrib(mdl, x):
    c = mdl.booster_.predict(x, pred_contrib=True)
    return c[:, :-1], c[:, -1]


def explain(k, off_key, on_key, cs, base, split):
    """Five auto-chosen test packages; exact TreeSHAP contributions (pred_contrib) Guard off vs on."""
    on, off = k[on_key], k[off_key]
    te = on["te"]
    y = te.ref_duration_min.to_numpy()
    defer = on["defer"]
    n = len(te)
    if n == 0:
        return []
    rid = te.row_id.to_numpy()
    pos_off = pd.Series(np.arange(len(off["te"])), index=off["te"].row_id.to_numpy())
    picks = []

    def add(kind, label, i):
        if i is not None and i not in [p[2] for p in picks]:
            picks.append((kind, label, int(i)))

    served = np.flatnonzero(~defer)
    pool = served if len(served) else np.arange(n)
    add("typical", "A typical package", pool[np.argmin(np.abs(y[pool] - np.median(y)))])
    if cs:
        sl = np.flatnonzero(te.courier_id.isin(cs).to_numpy())
        add("sloppy", "From a courier the poison dial made sloppy", sl[np.argmax(off["p50"][pos_off.reindex(rid[sl]).to_numpy()] - on["p50"][sl])] if len(sl) else None)
    else:
        rep = on["res"]["rep"].rep
        worst = rep.idxmin()
        sl = np.flatnonzero(te.courier_id.to_numpy() == worst)
        add("low_rep", "From the courier with the lowest reputation", sl[0] if len(sl) else None)
    d = np.flatnonzero(defer)
    add("deferred", "One the Guard deferred to a dispatcher", d[np.argmax((on["p80"] - on["p50"])[d])] if len(d) else None)
    area_n = te.aoi_id.map(base.loc[base.week.isin(split["train_weeks"]), "aoi_id"].value_counts()).fillna(0).to_numpy()
    add("rare_area", "In a rarely seen area", int(np.argmin(area_n)))
    add("long", "A long delivery", int(np.argmin(np.abs(y - np.quantile(y, 0.95)))))
    Xoff = off["Xte"]
    out = []
    reason_names = ["hist", "gps", "area", "width"]
    for kind, label, i in picks:
        j = int(pos_off[rid[i]])
        c_off, b_off = _contrib(off["res"]["m50"], Xoff[j:j + 1])
        c_on, b_on = _contrib(on["res"]["m50"], on["Xte"][i:i + 1])
        r = on["res"]["defer_reasons"][i]
        out.append({"kind": kind, "label": label, "y": float(y[i]),
                    "features": [{"name": f, "off": _num(Xoff[j, fi]), "on": _num(on["Xte"][i, fi])} for fi, f in enumerate(FEATURES)],
                    "contrib_off": [float(v) for v in c_off[0]], "contrib_on": [float(v) for v in c_on[0]],
                    "base_off": float(b_off[0]), "base_on": float(b_on[0]),
                    "p50_off": float(off["p50"][j]), "p50_on": float(on["p50"][i]), "p80_off": float(off["p80"][j]),
                    "p80_on": float(on["p80"][i]), "reasons": {n_: bool(r[q]) for q, n_ in enumerate(reason_names)},
                    "decision": "defer" if defer[i] else "approve"})
    return out


def to_json(obj):
    """Strict JSON (non-finite floats -> null) so the browser's JSON.parse accepts it."""
    import json
    import math

    def clean(o):
        if isinstance(o, float):
            return o if math.isfinite(o) else None
        if isinstance(o, dict):
            return {str(k): clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return clean(float(o))
        if isinstance(o, np.bool_):
            return bool(o)
        return o
    return json.dumps(clean(obj), allow_nan=False)


def _num(v):
    v = float(v)
    return None if np.isnan(v) else v


def strip_for_publication(result):
    """Aggregates only (for docs/data/lab_cached_yantai.json): no feature values (coordinates),
    no per-row quarantine list."""
    r = copy.deepcopy(result)
    r["quarantine"] = {"columns": r["quarantine"]["columns"], "rows": [], "n": len(result["quarantine"]["rows"])}
    for e in r["explain"]:
        for f in e["features"]:
            f["off"] = f["on"] = None
    return r
