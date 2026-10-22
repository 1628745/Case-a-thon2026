import numpy as np
import pandas as pd

from src.degrade import build_feed, early_couriers, p_bulk, sloppy_couriers
from tests.conftest import make_feed


def _base():
    return make_feed(n_days=182, n_couriers=40, n_aoi=10, per_day=8, seed=1)


def test_reference_untouched(cfg):
    b = _base()
    f, log = build_feed(b, "reference", 0, cfg)
    assert len(f) == len(b) and not f.injected.any() and (f.delivery_time == b.delivery_time).all()


def test_dose_schedule_matches(cfg):
    c = cfg["degrade"]["low_quality"]
    assert np.isclose(p_bulk(4, c), 0.10) and np.isclose(p_bulk(21, c), 0.90) and np.isclose(p_bulk(25, c), 0.90)
    assert np.isclose(p_bulk(12.5, c), 0.10 + 0.8 * 8.5 / 17)


def test_bulk_scan_rate_and_mechanism(cfg):
    b = _base()
    f, log = build_feed(b, "low_quality", 0, cfg)
    orig = f[~f.is_dup]
    c = cfg["degrade"]["low_quality"]
    sl = orig[orig.sloppy]
    # nobody but sloppy couriers is touched, and nothing before week 4
    assert not orig[~orig.sloppy].injected.any()
    assert not orig[orig.week < 4].injected.any()
    # bulk-scanned rows equal that courier-day's maximum delivery time
    m = sl.injected
    dmax = sl.groupby([sl.courier_id, sl.delivery_time.dt.normalize()]).delivery_time.transform("max")
    assert (sl.loc[m, "delivery_time"] == dmax[m]).all()
    # realised rate per week tracks p(w) (rows already at the max cannot be modified, so slightly below)
    for w in [6, 14, 20]:
        s = sl[sl.week == w]
        rate = s.injected.mean()
        assert p_bulk(w, c) * 0.75 < rate <= p_bulk(w, c) + 0.05, (w, rate)
    # labels only ever get longer
    ref = b.set_index("order_id").delivery_time
    assert (orig.set_index("order_id").delivery_time >= ref.loc[orig.order_id].values).all()


def test_duplicates_rate_and_ids(cfg):
    b = _base()
    f, _ = build_feed(b, "low_quality", 0, cfg)
    d = f[f.is_dup]
    assert d.week.min() >= 10 and d.sloppy.all() and d.injected.all()
    assert set(d.order_id) <= set(b.order_id)
    elig = f[(~f.is_dup) & f.sloppy & (f.week >= 10)]
    assert abs(len(d) / len(elig) - 0.8) < 0.05


def test_share_and_nesting(cfg):
    b = _base()
    s15, s35 = sloppy_couriers(b, 0, cfg, 0.15), sloppy_couriers(b, 0, cfg, 0.35)
    n = b[b.week <= 3].courier_id.nunique()
    assert len(s15) == round(0.15 * n) and s15 <= s35
    assert not (early_couriers(b, 0, cfg) & sloppy_couriers(b, 0, cfg, 0.60))
    assert sloppy_couriers(b, 0, cfg, 0.2) != sloppy_couriers(b, 1, cfg, 0.2)


def test_early_scan(cfg):
    b = _base()
    f, log = build_feed(b, "unseen", 0, cfg)
    e = f[f.early]
    assert e.week.min() >= 18
    ratio = ((e.delivery_time - e.accept_time) / (b.loc[e.index, "delivery_time"] - b.loc[e.index, "accept_time"]))
    assert ratio.between(0.3, 0.75).mean() > 0.95
    assert {r["mechanism"] for r in log} == {"early_scan"}


def test_modlog_rows(cfg):
    b = _base()
    f, log = build_feed(b, "combined", 0, cfg)
    mech = {r["mechanism"] for r in log}
    assert mech == {"stale_features", "stale_history", "bulk_scan", "duplicate_upload"}
    bulk = sum(r["rows_affected"] for r in log if r["mechanism"] == "bulk_scan")
    assert bulk == int((f.injected & ~f.is_dup).sum())
    assert all(len(r["couriers_hash"]) == 16 for r in log)
