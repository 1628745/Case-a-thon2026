"""Run the lab experiment natively (src + .venv): parity numbers for the browser and the cached fallback.

python scripts/lab_native.py [--data sample|yt|cq|PATH] [--preset sloppy] [--share 0.2] [--seed 0]
                             [--budget quick] [--cached]
  -> logs/lab/native_<data>_<preset>.json (full result, git-ignored)
  --cached also writes docs/data/lab_cached_yantai.json (aggregates only, see src/lab.strip_for_publication)
"""
import argparse
import json
import os
import secrets
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from src import lab  # noqa: E402
from src.common import config_hash, load_config  # noqa: E402

DATA = {"sample": "docs/data/lab_sample.csv", "yt": "data/raw/delivery_yt.csv", "cq": "data/raw/delivery_cq.csv"}


def run(path, preset, share, seed, budget, salt):
    cfg = load_config()
    t = time.perf_counter()
    raw = lab.read_lab_csv(path)
    audit = lab.lab_audit(raw, cfg, cfg["data"]["year"])
    t_audit = time.perf_counter() - t
    if not audit["ok"]:
        raise SystemExit("audit refused: " + " ".join(audit["problems"]))
    base, lcfg, split = lab.prepare(raw, cfg, cfg["data"]["year"], budget, share)
    t_prep = time.perf_counter() - t - t_audit
    res = lab.run_lab(base, lcfg, split, {"preset": preset, "sloppy_share": share, "seed": seed, "budget": budget}, salt=salt)
    res["timings"].update(audit_s=t_audit, prepare_s=t_prep, end_to_end_s=time.perf_counter() - t)
    res["config"] = {"config_hash": config_hash(cfg), "guard_hash": config_hash(cfg["guard"]), "guard": cfg["guard"]}
    res["audit"] = audit
    res["source"] = "native"
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="sample")
    ap.add_argument("--preset", default="sloppy", choices=list(lab.PRESETS))
    ap.add_argument("--share", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--budget", default="quick", choices=list(lab.BUDGETS))
    ap.add_argument("--cached", action="store_true")
    a = ap.parse_args()
    path = os.path.join(ROOT, DATA.get(a.data, a.data))
    salt = secrets.token_hex(8)  # never stored: published hashes can't be reversed
    res = run(path, a.preset, a.share, a.seed, a.budget, salt)
    os.makedirs(os.path.join(ROOT, "logs", "lab"), exist_ok=True)
    name = a.data if a.data in DATA else "file"
    out = os.path.join(ROOT, "logs", "lab", f"native_{name}_{a.preset}.json")
    with open(out, "w") as f:
        json.dump(json.loads(lab.to_json(res)), f, indent=1)
    for m in res["runs"]:
        print(f"{m['key']:13s} MAE {m['mae']:7.2f}  P90 {m['p90_err']:7.1f}  miss {m['miss_rate']:.3f}  "
              f"promise {m['promise_mean']:6.1f}  defer {m['defer_rate']:.3f}  n_train {m['n_train']:6d}  train {m['train_s']:.2f}s")
    print(res["headline"]["sentence"])
    print("timings", {k: round(v, 2) for k, v in res["timings"].items()})
    if a.cached:
        pub = lab.strip_for_publication(res)
        pub["source"] = "cached"
        pub["audit"] = {k: res["audit"][k] for k in ["rows", "n_full_weeks", "week0_start", "weeks", "observed_issues",
                                                     "n_couriers", "n_aoi", "n_regions", "date_range_accept", "plan"]}
        pub["data_name"] = "LaDe Yantai (delivery_yt.csv)"
        cp = os.path.join(ROOT, "docs", "data", "lab_cached_yantai.json")
        with open(cp, "w") as f:
            json.dump(json.loads(lab.to_json(pub)), f, indent=1)
        print("wrote", os.path.relpath(cp, ROOT))
    print("wrote", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()
