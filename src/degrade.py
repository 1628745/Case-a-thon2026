"""Degradation injectors. Each returns a modified copy and modification-log rows.

Labels written here (`injected`, `sloppy`, `is_dup`, `early`) are used ONLY to score detectors and
to describe the data; walkforward never passes them to the model or to the Guard.

Conditions: reference | stale | low_quality | combined | unseen.
stale = (a) training on all past weeks (walkforward.window_weeks) + (b) frozen history features
(walkforward.build_run_feed passes freeze_day). Here stale only adds a log entry.
"""
import hashlib
import json

import numpy as np
import pandas as pd


def _hash_ids(ids):
    return hashlib.sha256(",".join(str(i) for i in sorted(ids)).encode()).hexdigest()[:16]


def p_bulk(week, c):
    return np.minimum(c["p_max"], c["p_start"] + c["p_slope"] * (week - c["start_week"]) / c["p_span_weeks"])


def courier_order(base, seed, cfg):
    """Seeded permutation of couriers active in the warm-up weeks. Sloppy couriers are a prefix,
    so doses are nested (a larger share contains the smaller one)."""
    active = np.sort(base.loc[base.week <= cfg["splits"]["warmup"][1], "courier_id"].unique())
    return np.random.default_rng([seed, 7]).permutation(active)


def sloppy_couriers(base, seed, cfg, share):
    order = courier_order(base, seed, cfg)
    return set(order[: int(round(share * len(order)))])


def early_couriers(base, seed, cfg):
    """Disjoint from the largest sloppy draw used anywhere (dose 0.60 > default 0.20), taken from the
    end of the same permutation."""
    order = courier_order(base, seed, cfg)
    k = int(round(cfg["degrade"]["unseen"]["share"] * len(order)))
    return set(order[len(order) - k:])


def _log(cond, seed, mech, df_mask, df, params, couriers):
    wk = df.loc[df_mask, "week"].value_counts().sort_index()
    return [dict(condition=cond, seed=seed, mechanism=mech, week=int(w), rows_affected=int(n),
                 n_couriers=len(couriers), couriers_hash=_hash_ids(couriers), params=json.dumps(params))
            for w, n in wk.items()]


def bulk_scan(feed, couriers, seed, cfg, cond="low_quality"):
    """Sloppy couriers' packages in week >= start get, with prob p(week), delivery_time := that
    courier's latest delivery scan on the same delivery day (an end-of-shift bulk scan)."""
    c = cfg["degrade"]["low_quality"]
    rng = np.random.default_rng([seed, 11])
    feed = feed.copy()
    ddate = feed.delivery_time.dt.normalize()
    day_max = feed.groupby([feed.courier_id, ddate]).delivery_time.transform("max")
    elig = feed.courier_id.isin(couriers).to_numpy() & (feed.week.to_numpy() >= c["start_week"])
    u = rng.random(len(feed))
    hit = elig & (u < p_bulk(feed.week.to_numpy(), c)) & (day_max.to_numpy() > feed.delivery_time.to_numpy())
    feed.loc[hit, "delivery_time"] = day_max[hit]
    feed.loc[hit, "injected"] = True
    log = _log(cond, seed, "bulk_scan", hit, feed, {k: c[k] for k in ["p_start", "p_slope", "p_span_weeks", "p_max", "start_week"]}, couriers)
    return feed, log


def duplicate_upload(feed, couriers, seed, cfg, cond="low_quality"):
    """From dup_start_week, each sloppy-courier record is re-uploaded (same order id) with prob dup_prob."""
    c = cfg["degrade"]["low_quality"]
    rng = np.random.default_rng([seed, 13])
    elig = feed.courier_id.isin(couriers).to_numpy() & (feed.week.to_numpy() >= c["dup_start_week"]) & ~feed.is_dup.to_numpy()
    hit = elig & (rng.random(len(feed)) < c["dup_prob"])
    dups = feed[hit].copy()
    dups["is_dup"] = True
    dups["injected"] = True
    # a re-upload arrives a little later; it keeps the same scans and package id
    out = pd.concat([feed, dups]).sort_values(["accept_time", "order_id", "is_dup"], kind="stable")
    out.index = np.arange(len(out))
    log = _log(cond, seed, "duplicate_upload", hit, feed, {k: c[k] for k in ["dup_start_week", "dup_prob"]}, couriers)
    return out, log


def early_scan(feed, couriers, seed, cfg, cond="unseen"):
    """From start_week, these couriers scan 'delivered' early: delivery := accept + U(lo,hi) x true duration."""
    c = cfg["degrade"]["unseen"]
    rng = np.random.default_rng([seed, 17])
    feed = feed.copy()
    hit = feed.courier_id.isin(couriers).to_numpy() & (feed.week.to_numpy() >= c["start_week"])
    frac = rng.uniform(c["frac_low"], c["frac_high"], len(feed))
    dur = (feed.delivery_time - feed.accept_time).dt.total_seconds().to_numpy()
    new = feed.accept_time + pd.to_timedelta(np.maximum(60.0, np.round(frac * dur / 60) * 60), unit="s")
    feed.loc[hit, "delivery_time"] = new[hit]
    feed.loc[hit, "injected"] = True
    feed.loc[hit, "early"] = True
    log = _log(cond, seed, "early_scan", hit, feed, {k: c[k] for k in ["share", "start_week", "frac_low", "frac_high"]}, couriers)
    return feed, log


def build_feed(base, condition, seed, cfg, severity=None):
    feed = base.copy()
    feed["is_dup"] = False
    feed["injected"] = False
    feed["sloppy"] = False
    feed["early"] = False
    log = []
    if condition in ("stale", "combined"):
        fz = cfg["degrade"]["stale"]["freeze_data_through"]
        frozen_rows = feed.accept_time >= pd.Timestamp(fz) + pd.Timedelta(days=1)
        log += _log(condition, seed, "stale_features", frozen_rows, feed, {"freeze_data_through": fz}, [])
        log += _log(condition, seed, "stale_history", feed.week >= 0, feed, {"window": "all weeks, equal weight"}, [])
    if condition in ("low_quality", "combined"):
        share = cfg["degrade"]["low_quality"]["sloppy_share"] if severity is None else severity
        cs = sloppy_couriers(base, seed, cfg, share)
        feed["sloppy"] = feed.courier_id.isin(cs)
        feed, l1 = bulk_scan(feed, cs, seed, cfg, condition)
        feed, l2 = duplicate_upload(feed, cs, seed, cfg, condition)
        for r in l1 + l2:
            r["severity"] = share
        log += l1 + l2
    if condition == "unseen":
        ce = early_couriers(base, seed, cfg)
        feed, l3 = early_scan(feed, ce, seed, cfg)
        log += l3
    return feed, log
