"""docs/py/guardlab (the browser copy) vs src on a small synthetic file: same code, same outputs."""
import importlib
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.join(ROOT, "docs", "py"))
import build_lab  # noqa: E402
from make_sample import make_raw  # noqa: E402
from src import lab as src_lab  # noqa: E402

guardlab_lab = importlib.import_module("guardlab.lab")


@pytest.fixture(scope="module")
def raw():
    return make_raw(n_couriers=14, n_weeks=7, per_day=6.0, n_aoi=60, seed=3)


@pytest.fixture(scope="module")
def browser_cfg():
    with open(os.path.join(ROOT, "docs", "py", "lab_config.json")) as f:
        return json.load(f)


def test_generated_files_are_current():
    for fn, text in build_lab.expected_files().items():
        with open(os.path.join(ROOT, "docs", "py", "guardlab", fn)) as f:
            assert f.read() == text, f"docs/py/guardlab/{fn} is stale: run python scripts/build_lab.py"


def test_lab_config_matches_yaml(cfg, browser_cfg):
    assert browser_cfg["config"] == cfg
    assert browser_cfg["guard_hash"] == build_lab.config_hash(cfg["guard"])
    assert sorted(browser_cfg["py_files"]) == sorted(build_lab.expected_files())


def test_guardlab_does_not_import_src():
    for fn in build_lab.expected_files():
        with open(os.path.join(ROOT, "docs", "py", "guardlab", fn)) as f:
            code = "\n".join(ln for ln in f.read().splitlines() if not ln.startswith("#"))
        assert "from src." not in code and "from src import" not in code and "import src" not in code, fn
    assert guardlab_lab.attach_features.__module__ == "guardlab.walkforward"


def _norm(r):
    r = json.loads(json.dumps(r))
    r.pop("timings")
    for m in r["runs"]:
        for k in ("train_s", "run_s", "predict_ms_per_pkg"):
            m.pop(k)
    for k in ("train_s_guard", "predict_ms_per_pkg"):
        r["human"].pop(k)
    return r


@pytest.mark.parametrize("preset", ["sloppy", "clean", "sloppy_stale", "unseen"])
def test_same_result(raw, cfg, browser_cfg, preset):
    out = []
    for mod, c in [(src_lab, cfg), (guardlab_lab, browser_cfg["config"])]:
        rd = mod.read_lab_csv(_csv(raw))
        a = mod.lab_audit(rd, c, 2022)
        assert a["ok"], a["problems"]
        base, lcfg, split = mod.prepare(rd, c, 2022)
        out.append((a, _norm(mod.run_lab(base, lcfg, split, {"preset": preset, "seed": 1}))))
    assert out[0][0] == out[1][0]
    assert out[0][1] == out[1][1]
    r = out[0][1]
    assert r["schema"] == src_lab.SCHEMA
    keys = [m["key"] for m in r["runs"]]
    assert keys == (["clean_off", "clean_on"] if preset == "clean" else ["reference", "degraded_off", "degraded_on"])
    if preset != "clean":
        assert r["detector"] is not None and r["injection"]


def test_injection_and_guard_pieces_match(raw, cfg, browser_cfg):
    """Features, L1 flags, weights and injected rows agree piece by piece."""
    import guardlab.guard as gg
    import guardlab.walkforward as gw
    from src import guard as sg
    from src import walkforward as sw
    res = []
    for mod, c, guard, wf in [(src_lab, cfg, sg, sw), (guardlab_lab, browser_cfg["config"], gg, gw)]:
        base, lcfg, split = mod.prepare(mod.read_lab_csv(_csv(raw)), c, 2022)
        feed, log, cs, ce = mod.build_lab_feed(base, ["bulk", "dup", "early"], 0, lcfg)
        full = wf.attach_features(feed, lcfg, lcfg["guard"], None)
        tr = full[full.week.isin(split["train_weeks"])].copy()
        tr["age_weeks"] = split["test_week"] - tr.week - 1
        fl = guard.l1_flags(tr, lcfg["guard"])
        w, rep, rec = guard.training_weights(tr, split["test_week"], fl["any"].to_numpy(), lcfg["guard"])
        res.append((full, fl, w, rep, sorted(cs), sorted(ce), log))
    a, b = res
    pd.testing.assert_frame_equal(a[0], b[0])
    pd.testing.assert_frame_equal(a[1], b[1])
    np.testing.assert_array_equal(a[2], b[2])
    pd.testing.assert_frame_equal(a[3], b[3])
    assert a[4:] == b[4:]
    assert a[0].injected.any() and a[0].is_dup.any() and a[0].early.any()


def test_release_sets_reputation_to_one(raw, cfg):
    base, lcfg, split = src_lab.prepare(src_lab.read_lab_csv(_csv(raw)), cfg, 2022)
    r0 = src_lab.run_lab(base, lcfg, split, {"preset": "sloppy", "seed": 0})
    worst = r0["reputation"]["lowest"][0]
    assert worst["rep"] < 1
    r1 = src_lab.run_lab(base, lcfg, split, {"preset": "sloppy", "seed": 0, "release": [worst["courier"]]})
    rel = [c for c in r1["reputation"]["lowest"] if c["courier"] == worst["courier"]]
    assert not rel or rel[0]["rep"] == 1.0
    assert r1["settings"]["released"] == [worst["courier"]]
    # flags still apply: quarantine count unchanged
    assert r1["guard"]["quarantined"] == r0["guard"]["quarantined"]


def test_bad_files_are_refused(raw, cfg):
    with pytest.raises(src_lab.LabError, match="Missing column"):
        src_lab.read_lab_csv(_csv(raw.drop(columns=["courier_id"])))
    short = raw[pd.to_datetime("2022-" + raw.accept_time, format="%Y-%m-%d %H:%M:%S") < "2022-05-29"]
    a = src_lab.lab_audit(src_lab.read_lab_csv(_csv(short)), cfg, 2022)
    assert not a["ok"] and "full week" in a["problems"][0]
    bad = raw.assign(accept_time="2022/05/01 08:00")
    with pytest.raises(src_lab.LabError, match="MM-DD"):
        src_lab.lab_audit(src_lab.read_lab_csv(_csv(bad)), cfg, 2022)


def test_publication_strip_has_no_coordinates(raw, cfg):
    base, lcfg, split = src_lab.prepare(src_lab.read_lab_csv(_csv(raw)), cfg, 2022)
    r = src_lab.strip_for_publication(src_lab.run_lab(base, lcfg, split, {"preset": "sloppy"}))
    assert r["quarantine"]["rows"] == []
    assert all(f["off"] is None and f["on"] is None for e in r["explain"] for f in e["features"])


def _csv(df):
    import io
    return io.StringIO(df.to_csv(index=False))


def test_verdict_red_when_guard_hurts_under_noise_floor():
    runs = [{"key": "reference", "mae": 50.0}, {"key": "degraded_off", "mae": 50.2}, {"key": "degraded_on", "mae": 56.0}]
    assert src_lab._verdict(runs, True)["verdict"] == "red"
    runs[2]["mae"] = 50.1
    assert src_lab._verdict(runs, True)["verdict"] == "neutral"
