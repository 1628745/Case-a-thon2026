"""Audit a raw LaDe delivery file: format, coverage, observed (pre-existing) issues.

python -m src.audit [--city cq|yt]   -> results/audit.json (cq) or results/audit_yt.json
"""
import argparse
import hashlib
import json
import os

import numpy as np
import pandas as pd

from src.common import ROOT, haversine_km, load_config, parse_times, week_of


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def audit(path, cfg):
    raw = pd.read_csv(path)
    out = {"file": os.path.relpath(path, ROOT), "bytes": os.path.getsize(path), "sha256": sha256(path)}
    out.update(audit_frame(raw, cfg))
    return out


def audit_frame(raw, cfg):
    """Format, coverage and observed issues of a raw frame (no file I/O). `ds` and delivery GPS
    columns are optional."""
    d = cfg["data"]
    out = {"rows_raw": int(len(raw)), "columns": list(raw.columns)}
    out["time_format_examples"] = raw["accept_time"].head(3).tolist()
    out["time_string_lengths"] = {str(k): int(v) for k, v in raw["accept_time"].astype(str).str.len().value_counts().items()}
    at = parse_times(raw["accept_time"], d["year"])
    dt = parse_times(raw["delivery_time"], d["year"])
    gt = parse_times(raw["accept_gps_time"], d["year"])
    out["unparseable_accept"] = int(at.isna().sum())
    out["unparseable_delivery"] = int(dt.isna().sum())
    # ds column = accept date as MMDD?
    ds_from_accept = at.dt.month * 100 + at.dt.day
    if "ds" in raw:
        out["ds_matches_accept_date_share"] = float((ds_from_accept == raw["ds"]).mean())
    out["date_range_accept"] = [str(at.min()), str(at.max())]
    out["date_range_delivery"] = [str(dt.min()), str(dt.max())]
    dur = (dt - at).dt.total_seconds() / 60
    wk = week_of(at, d["week0_start"])
    out["rows_per_week"] = {int(k): int(v) for k, v in wk.value_counts().sort_index().items()}
    in_span = wk.between(0, d["n_weeks"] - 1)
    out["rows_outside_weeks_0_25"] = int((~in_span).sum())
    out["weeks_present"] = sorted(int(k) for k in wk[in_span].dropna().unique())
    out["duration_min_quantiles"] = {str(q): float(dur.quantile(q)) for q in [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]}
    gps_age = (at - gt).dt.total_seconds() / 60
    df = pd.DataFrame({"courier": raw["courier_id"], "dmin": dt.dt.floor("min"), "day": at.dt.normalize()})
    burst_size = df.groupby(["courier", "dmin"])["day"].transform("size")
    dist = haversine_km(raw["accept_gps_lng"], raw["accept_gps_lat"], raw["lng"], raw["lat"])
    issues = {
        "duration_le_0": int((dur <= 0).sum()),
        "duration_gt_12h": int((dur > 720).sum()),
        "duration_gt_24h": int((dur > 1440).sum()),
        "same_minute_burst_ge5_rows": int((burst_size >= 5).sum()),
        "missing_accept_gps": int(raw[["accept_gps_lng", "accept_gps_lat"]].isna().any(axis=1).sum()),
        "missing_delivery_gps": (int(raw[["delivery_gps_lng", "delivery_gps_lat"]].isna().any(axis=1).sum())
                                 if {"delivery_gps_lng", "delivery_gps_lat"} <= set(raw.columns) else None),
        "gps_fix_age_gt_30min": int((gps_age > 30).sum()),
        "gps_fix_age_negative": int((gps_age < 0).sum()),
        "gps_fix_age_quantiles_min": {str(q): float(gps_age.quantile(q)) for q in [0.5, 0.9, 0.99, 0.999]},
        "courier_to_stop_gt_30km": int((dist > 30).sum()),
        "duplicate_order_id": int(raw["order_id"].duplicated().sum()),
    }
    out["observed_issues"] = issues
    out["n_couriers"] = int(raw["courier_id"].nunique())
    out["n_aoi"] = int(raw["aoi_id"].nunique())
    out["n_regions"] = int(raw["region_id"].nunique())
    out["aoi_type_share"] = {int(k): round(float(v), 5) for k, v in raw["aoi_type"].value_counts(normalize=True).items()}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="cq", choices=["cq", "yt"])
    a = ap.parse_args()
    cfg = load_config()
    res = audit(os.path.join(ROOT, cfg["data"][f"raw_{a.city}"]), cfg)
    os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
    name = "audit.json" if a.city == "cq" else "audit_yt.json"
    with open(os.path.join(ROOT, "results", name), "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps({k: res[k] for k in ["rows_raw", "unparseable_accept", "ds_matches_accept_date_share",
                                           "date_range_accept", "rows_outside_weeks_0_25", "weeks_present"]}))
    print("rows/week", res["rows_per_week"])
    print("issues", res["observed_issues"])
    print("dur q", res["duration_min_quantiles"])


if __name__ == "__main__":
    main()
