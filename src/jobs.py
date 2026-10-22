"""Write results/jobs.csv: one row per (family, run). run_id is a hash of the run's content, so a
spec shared by two families (e.g. reference window 4 in main and shelf_life) is run once.

python -m src.jobs [--final] [--tune]
"""
import argparse
import hashlib
import json
import os

import pandas as pd

from src.common import ROOT, load_config

DEV = (4, 21)
HELD = (22, 25)
CONDS = ["reference", "stale", "low_quality", "combined"]


def spec_id(s):
    key = {k: s.get(k) for k in ["condition", "guard", "seed", "window", "severity", "control", "weeks", "guard_cfg"]}
    return hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:10]


def job(family, condition, guard, seed, weeks, window=4, severity=None, control=None, guard_cfg=None):
    s = dict(family=family, condition=condition, guard=bool(guard), seed=seed, window=window, severity=severity,
             control=control, weeks=f"{weeks[0]}-{weeks[1]}", guard_cfg=json.dumps(guard_cfg) if guard_cfg else "")
    s["run_id"] = spec_id(s)
    return s


def grid_pass1(cfg):
    J = []
    for c in CONDS:
        for g in (0, 1):
            for s in cfg["seeds"]:
                J.append(job("main", c, g, s, DEV))
    for w in [1, 2, 4, 8, 16, "all"]:
        for c in ["reference", "low_quality"]:
            J.append(job("shelf_life", c, 0, 0, DEV, window=w))
    for sev in [0.0, 0.15, 0.35, 0.60]:
        for g in (0, 1):
            J.append(job("dose", "low_quality", g, 0, DEV, severity=sev))
    J.append(job("controls", "low_quality", 0, 0, DEV, control="oracle"))
    J.append(job("controls", "low_quality", 0, 0, DEV, control="random"))
    J.append(job("controls", "reference", 0, 0, DEV, control="frozen_model"))
    J.append(job("controls", "reference", 0, 0, DEV, control="frozen_features"))
    return J


def tune_grid(cfg, configs):
    J = []
    for name, gc in configs:
        for c in ["reference", "low_quality", "combined"]:
            j = job("tune", c, 1, 0, DEV, guard_cfg=gc)
            j["tune_name"] = name
            J.append(j)
    return J


def final_grid(cfg, guard_cfg=None):
    J = []
    for c in CONDS + ["unseen"]:
        for g in (0, 1):
            for s in cfg["seeds"]:
                J.append(job("final", c, g, s, HELD, guard_cfg=guard_cfg if g else None))
    return J


def write(J, name="jobs.csv"):
    df = pd.DataFrame(J)
    path = os.path.join(ROOT, "results", name)
    if os.path.exists(path):
        old = pd.read_csv(path, dtype=str, keep_default_na=False)
        df = pd.concat([old, df.astype(str)]).drop_duplicates(["family", "run_id"], keep="last")
    df.to_csv(path, index=False)
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--final", action="store_true")
    a = ap.parse_args()
    cfg = load_config()
    J = final_grid(cfg) if a.final else grid_pass1(cfg)
    df = write(J)
    print(df.groupby("family").run_id.nunique().to_dict(), "unique runs:", df.run_id.nunique())


if __name__ == "__main__":
    main()
