import numpy as np
import pandas as pd

from src.degrade import build_feed
from src.guard import apply_guard, courier_reputation, l1_flags
from src.walkforward import merged_guard_cfg
from src.prep import add_dynamic_features
from tests.conftest import make_feed

LABELS = ["injected", "sloppy", "is_dup", "early", "grp_sloppy", "grp_early"]


def _setup(cfg, t=12):
    b = make_feed(n_days=120, n_couriers=30, n_aoi=6, per_day=10, seed=2)
    f, _ = build_feed(b, "low_quality", 0, cfg)
    f["grp_sloppy"], f["grp_early"] = f.sloppy, False
    f = pd.concat([f.drop(columns=["day"]).assign(day=f.day), add_dynamic_features(f, cfg)], axis=1)
    f["label"] = (f.delivery_time - f.accept_time).dt.total_seconds() / 60
    tr = f[f.week.between(t - 4, t - 1)].copy()
    tr["age_weeks"] = t - tr.week - 1
    te = f[(f.week == t) & ~f.is_dup].copy()
    return tr, te, t


def test_guard_ignores_injection_labels(cfg):
    g = merged_guard_cfg(cfg, {})
    tr, te, t = _setup(cfg)
    a = apply_guard(tr, te, t, cfg, g, 0, 2)
    rng = np.random.default_rng(0)
    tr2, te2 = tr.copy(), te.copy()
    for c in LABELS:
        tr2[c] = rng.permutation(tr2[c].to_numpy())
        te2[c] = rng.permutation(te2[c].to_numpy())
    b = apply_guard(tr2, te2, t, cfg, g, 0, 2)
    np.testing.assert_allclose(a["tr"].w, b["tr"].w)
    np.testing.assert_allclose(a["p80_test"], b["p80_test"])
    assert (a["defer"] == b["defer"]).all()


def test_l1_flags_duplicates_and_bursts(cfg):
    g = merged_guard_cfg(cfg, {})
    tr, te, t = _setup(cfg)
    fl = l1_flags(tr, g)
    # every duplicate copy is flagged, no first copy is flagged as duplicate
    assert fl.dup[tr.is_dup.to_numpy()].all() and not fl.dup[~tr.is_dup.to_numpy()].any()
    # bursts: >= 5 distinct packages with one courier-minute
    first = tr[~fl.dup.to_numpy()]
    n = first.groupby([first.courier_id, first.delivery_time.dt.floor("min")]).order_id.transform("size")
    assert (fl.burst[first.index] == (n >= 5)).all()


def test_reputation_bounds_and_shrinkage(cfg):
    g = merged_guard_cfg(cfg, {})
    tr, te, t = _setup(cfg)
    rep = courier_reputation(tr, l1_flags(tr, g)["any"].to_numpy(), g)
    assert rep.rep.between(0.1, 1.0).all()
    # sloppy couriers (truth used only to score) get lower reputation on average
    sl = tr.groupby("courier_id").sloppy.first()
    assert rep.rep[sl[sl].index].mean() < rep.rep[sl[~sl].index].mean()


def test_courier_cap(cfg):
    g = merged_guard_cfg(cfg, {})
    tr, te, t = _setup(cfg)
    out = apply_guard(tr, te, t, cfg, g, 0, 2)
    tot = out["tr"].groupby("courier_id").w.sum()
    assert tot.max() <= 2.0 * tot.median() * 1.0001 + 1e-9 or tot.max() <= tot.median() * 2.01
