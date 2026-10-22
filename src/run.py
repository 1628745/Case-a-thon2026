"""Run jobs from results/jobs.csv in parallel; resumable (finished runs are skipped).

python -m src.run --all [--family F] [--workers N]
Outputs results/runs/<run_id>/{weekly,detector,importance,probe,chain,modlog}.parquet + done.json;
progress in results/runs/_progress.json; errors in results/runs/<run_id>/error.txt.
"""
import argparse
import json
import os
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed

import pandas as pd

from src.common import ROOT, load_config, n_threads, n_workers

RUNS = os.path.join(ROOT, "results", "runs")
_BASE = {}


def parse_spec(r):
    w = r["window"]
    s = dict(run_id=r["run_id"], family=r["family"], condition=r["condition"], guard=r["guard"] in (True, "True"),
             seed=int(r["seed"]), window="all" if w == "all" else int(float(w)),
             severity=None if r["severity"] in ("", "None", None) or pd.isna(r["severity"]) else float(r["severity"]),
             control=None if r["control"] in ("", "None", None) or pd.isna(r["control"]) else r["control"])
    lo, hi = map(int, str(r["weeks"]).split("-"))
    s["weeks"] = list(range(lo, hi + 1))
    gc = r.get("guard_cfg", "")
    s["guard_cfg"] = json.loads(gc) if isinstance(gc, str) and gc.strip() else None
    s["tag"] = r.get("tag", "") or ""
    return s


def _init(threads):
    from src.common import load_config as lc
    cfg = lc()
    _BASE["cfg"] = cfg
    _BASE["base"] = pd.read_parquet(os.path.join(ROOT, cfg["data"]["processed_dir"], "cq.parquet"))
    _BASE["threads"] = threads


def _one(spec):
    from src.walkforward import run
    d = os.path.join(RUNS, spec["run_id"])
    os.makedirs(d, exist_ok=True)
    t = time.time()
    try:
        out = run(spec, _BASE["base"], _BASE["cfg"], threads=_BASE["threads"], diag=True)
        for k, v in out.items():
            v.to_parquet(os.path.join(d, f"{k}.parquet"), index=False)
        with open(os.path.join(d, "done.json"), "w") as f:
            json.dump(dict(spec=spec, seconds=time.time() - t), f)
        if os.path.exists(os.path.join(d, "error.txt")):
            os.remove(os.path.join(d, "error.txt"))
        return spec["run_id"], True, time.time() - t
    except Exception:
        with open(os.path.join(d, "error.txt"), "w") as f:
            f.write(traceback.format_exc())
        return spec["run_id"], False, time.time() - t


def cost(s):
    c = 3.0 if (s["condition"] in ("stale", "combined") or s["window"] == "all") else 1.0
    if isinstance(s["window"], int) and s["window"] >= 8:
        c = 2.0
    return c * (1.6 if s["guard"] else 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--family", default=None)
    ap.add_argument("--workers", type=int, default=None)
    a = ap.parse_args()
    jobs = pd.read_csv(os.path.join(ROOT, "results", "jobs.csv"), dtype=str, keep_default_na=False)
    if a.family:
        jobs = jobs[jobs.family.isin(a.family.split(","))]
    specs = {}
    for _, r in jobs.iterrows():
        specs.setdefault(r["run_id"], parse_spec(r))
    todo = [s for rid, s in specs.items() if not os.path.exists(os.path.join(RUNS, rid, "done.json"))]
    todo.sort(key=cost, reverse=True)
    workers = a.workers or n_workers()
    threads = n_threads(workers)
    os.makedirs(RUNS, exist_ok=True)
    total, done0 = len(specs), len(specs) - len(todo)
    print(f"{total} runs, {done0} already done, {len(todo)} to do; workers={workers} threads={threads}", flush=True)
    prog = os.path.join(RUNS, "_progress.json")
    ok_n, fail = 0, []
    t0 = time.time()
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(threads,)) as ex:
        futs = {ex.submit(_one, s): s for s in todo}
        for f in as_completed(futs):
            rid, ok, sec = f.result()
            s = futs[f]
            ok_n += ok
            if not ok:
                fail.append(rid)
            el = time.time() - t0
            print(f"{'ok ' if ok else 'ERR'} {rid} {s['family']}/{s['condition']}/g{int(s['guard'])}/s{s['seed']}/w{s['window']}/"
                  f"{s['severity']}/{s['control']} {sec:.0f}s  [{done0 + ok_n}/{total}] elapsed {el / 60:.1f}m", flush=True)
            with open(prog, "w") as fp:
                json.dump(dict(total=total, done=done0 + ok_n, failed=fail, elapsed_min=el / 60,
                               updated=time.strftime("%Y-%m-%d %H:%M:%S")), fp)
    print(f"finished: {ok_n} ok, {len(fail)} failed", flush=True)


if __name__ == "__main__":
    main()
