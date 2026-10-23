"""SYNTHETIC LaDe-shaped delivery sample for the lab page (no LaDe rows are used or copied).

python scripts/make_sample.py  -> docs/data/lab_sample.csv

Every value is drawn from the generator below: couriers with their own speed and home areas,
weekday/hour volume patterns, durations that depend on hour, distance, area and the courier's load,
and a heavy right tail. The `city` column says SYNTHETIC. A handful of the issue types L1 checks for
(non-positive durations, far GPS fixes, late GPS fixes) are planted so the audit has something to show.
"""
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "lab_sample.csv")
COLUMNS = ["order_id", "region_id", "city", "courier_id", "lng", "lat", "aoi_id", "aoi_type", "accept_time",
           "accept_gps_time", "accept_gps_lng", "accept_gps_lat", "delivery_time", "delivery_gps_time",
           "delivery_gps_lng", "delivery_gps_lat", "ds"]
AOI_TYPES = [1, 14, 7, 0, 4, 2, 3, 12]
AOI_TYPE_P = [0.52, 0.36, 0.04, 0.025, 0.02, 0.015, 0.01, 0.01]


def make_raw(n_couriers=45, n_weeks=8, per_day=10.0, n_aoi=360, seed=0, start="2022-05-01"):
    rng = np.random.default_rng(seed)
    t0 = pd.Timestamp(start)
    # areas: centre, type, slowness
    n_region = 5
    reg_c = np.c_[rng.uniform(120.9, 121.1, n_region), rng.uniform(31.1, 31.3, n_region)]
    a_reg = rng.integers(n_region, size=n_aoi)
    a_xy = reg_c[a_reg] + rng.normal(0, 0.03, (n_aoi, 2))
    a_type = rng.choice(AOI_TYPES, size=n_aoi, p=AOI_TYPE_P)
    a_slow = rng.lognormal(0, 0.35, n_aoi) * np.where(np.isin(a_type, [7, 12]), 1.6, 1.0)
    # couriers: home region, a set of areas, speed, activity
    c_reg = rng.integers(n_region, size=n_couriers)
    c_speed = rng.lognormal(0, 0.3, n_couriers)
    c_rate = per_day * rng.uniform(0.6, 1.4, n_couriers)
    c_ids = np.sort(rng.choice(np.arange(100, 9999), n_couriers, replace=False))
    c_aois = [rng.choice(np.flatnonzero(a_reg == c_reg[c]) if (a_reg == c_reg[c]).sum() >= 8 else np.arange(n_aoi),
                         size=12, replace=True) for c in range(n_couriers)]
    dow_f = np.array([0.75, 1.05, 1.0, 1.0, 1.05, 1.1, 0.9])  # Sunday..Saturday (week0 is a Sunday)
    rows = []
    for d in range(7 * n_weeks):
        day = t0 + pd.Timedelta(days=d)
        trend = 1 + 0.15 * np.sin(d / 9.0)
        for c in range(n_couriers):
            if rng.random() < 0.08:  # day off
                continue
            k = rng.poisson(c_rate[c] * dow_f[d % 7] * trend)
            if k == 0:
                continue
            hours = np.clip(rng.normal(9.5, 2.2, k), 7, 19.5)
            acc_min = np.sort((hours * 60).astype(int))
            aoi = rng.choice(c_aois[c], size=k)
            for j in range(k):
                rows.append((d, day, c, int(aoi[j]), int(acc_min[j]), j))
    df = pd.DataFrame(rows, columns=["d", "day", "c", "aoi", "acc_min", "j"])
    n = len(df)
    aoi = df.aoi.to_numpy()
    c = df.c.to_numpy()
    stop = a_xy[aoi] + rng.normal(0, 0.004, (n, 2))
    gps = stop + rng.normal(0, 0.02, (n, 2))  # where the courier was at acceptance
    dist = np.hypot((gps[:, 0] - stop[:, 0]) * 95, (gps[:, 1] - stop[:, 1]) * 111)
    load = df.groupby(["d", "c"]).j.transform("size").to_numpy()
    hour = df.acc_min.to_numpy() / 60
    mu = (np.log(170) + 0.25 * np.log1p(dist) + 0.35 * np.log(c_speed[c]) + 0.5 * np.log(a_slow[aoi])
          + 0.02 * (load - 10) - 0.05 * (hour - 9.5))
    dur = np.exp(mu + rng.normal(0, 0.55, n))
    tail = rng.random(n) < 0.03  # next-day or later deliveries
    dur[tail] += rng.uniform(600, 2400, tail.sum())
    dur = np.clip(np.round(dur), 3, 4000)
    acc = df.day + pd.to_timedelta(df.acc_min, unit="min")
    gps_lag = np.where(rng.random(n) < 0.9, 0, rng.integers(1, 20, n))
    # planted observed issues
    nonpos = rng.random(n) < 0.0015
    dur[nonpos] = 0
    late_fix = rng.random(n) < 0.002
    gps_lag[late_fix] = rng.integers(40, 180, late_fix.sum())
    far = rng.random(n) < 0.002
    gps[far] += rng.choice([-1, 1], (far.sum(), 2)) * rng.uniform(0.35, 0.6, (far.sum(), 2))
    dlv = acc + pd.to_timedelta(dur, unit="min")
    fmt = "%m-%d %H:%M:%S"
    out = pd.DataFrame({
        "order_id": rng.choice(np.arange(1_000_000, 9_999_999), n, replace=False),
        "region_id": a_reg[aoi] + 1, "city": "SYNTHETIC", "courier_id": c_ids[c],
        "lng": stop[:, 0].round(5), "lat": stop[:, 1].round(5), "aoi_id": aoi, "aoi_type": a_type[aoi],
        "accept_time": acc.dt.strftime(fmt),
        "accept_gps_time": (acc - pd.to_timedelta(gps_lag, unit="min")).dt.strftime(fmt),
        "accept_gps_lng": gps[:, 0].round(5), "accept_gps_lat": gps[:, 1].round(5),
        "delivery_time": dlv.dt.strftime(fmt), "delivery_gps_time": dlv.dt.strftime(fmt),
        "delivery_gps_lng": (stop[:, 0] + rng.normal(0, 0.0005, n)).round(5),
        "delivery_gps_lat": (stop[:, 1] + rng.normal(0, 0.0005, n)).round(5),
        "ds": (acc.dt.month * 100 + acc.dt.day).astype(int),
    })
    return out[COLUMNS]


def main():
    df = make_raw()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    df.to_csv(OUT, index=False)
    print(f"wrote {os.path.relpath(OUT, ROOT)}: {len(df)} rows, {os.path.getsize(OUT) / 1e6:.2f} MB (SYNTHETIC)")


if __name__ == "__main__":
    main()
