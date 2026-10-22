"""Leakage rules (PLAN section 3)."""
import numpy as np
import pandas as pd

from src.prep import FEATURES, add_dynamic_features

FORBIDDEN = ("delivery", "duration", "injected", "dup", "sloppy", "early")


def test_feature_list_has_no_outcome_or_label_columns():
    for f in FEATURES:
        assert not any(b in f for b in FORBIDDEN), f


def test_own_label_never_changes_own_features(feed, cfg):
    base = add_dynamic_features(feed, cfg)
    for r in [5, 300, 2000]:
        f2 = feed.copy()
        f2.loc[r, "delivery_time"] = f2.loc[r, "delivery_time"] + pd.Timedelta(hours=9)
        new = add_dynamic_features(f2, cfg)
        pd.testing.assert_series_equal(base.loc[r], new.loc[r], check_names=False)


def test_history_uses_only_packages_delivered_before_the_day(feed, cfg):
    """Changing every delivery scan that happens on/after day D0 must not change history
    features of any row accepted on day <= D0."""
    base = add_dynamic_features(feed, cfg)
    d0 = 30
    start = pd.Timestamp("2022-05-01")
    late = feed.delivery_time >= start + pd.Timedelta(days=d0)
    f2 = feed.copy()
    f2.loc[late, "delivery_time"] = f2.loc[late, "delivery_time"] + pd.Timedelta(hours=7)
    new = add_dynamic_features(f2, cfg)
    early_rows = feed.day <= d0
    for c in ["courier_hist_mean", "area_hist_mean"]:
        np.testing.assert_allclose(base.loc[early_rows, c], new.loc[early_rows, c], equal_nan=True)


def test_history_window_is_strictly_prior_days(feed, cfg):
    """A row's history mean equals a brute-force mean over prior 14 days, delivered before its day."""
    feats = add_dynamic_features(feed, cfg)
    start = pd.Timestamp("2022-05-01")
    for r in [1500, 3000, 4500]:
        row = feed.loc[r]
        dstart = start + pd.Timedelta(days=int(row.day))
        m = (feed.courier_id == row.courier_id) & (feed.day >= row.day - 14) & (feed.day <= row.day - 1) \
            & (feed.delivery_time < dstart)
        exp = feed.loc[m, "ref_duration_min"].mean()
        assert np.isclose(feats.loc[r, "courier_hist_mean"], exp), (r, feats.loc[r, "courier_hist_mean"], exp)


def test_open_workload_brute_force(feed, cfg):
    feats = add_dynamic_features(feed, cfg)
    for r in [10, 777, 3333]:
        row = feed.loc[r]
        m = (feed.courier_id == row.courier_id) & (feed.day == row.day) & (feed.accept_time < row.accept_time) \
            & (feed.delivery_time > row.accept_time)
        assert feats.loc[r, "open_workload"] == m.sum()


def test_rows_mode_matches_self_mode(feed, cfg):
    a = add_dynamic_features(feed, cfg)
    b = add_dynamic_features(feed, cfg, rows=feed)
    pd.testing.assert_frame_equal(a[sorted(a.columns)], b[sorted(b.columns)])


def test_frozen_features_do_not_change_after_freeze(feed, cfg):
    fz = 20
    a = add_dynamic_features(feed, cfg, freeze_day=fz)
    f2 = feed.copy()
    late = f2.day > fz
    f2.loc[late, "delivery_time"] += pd.Timedelta(hours=5)
    b = add_dynamic_features(f2, cfg, freeze_day=fz)
    np.testing.assert_allclose(a.courier_hist_mean, b.courier_hist_mean, equal_nan=True)
    assert a.loc[feed.day == 40, "hist_age_days"].eq(40 - fz).all()


def test_test_week_never_in_training_window(cfg):
    from src.walkforward import window_weeks
    for cond in ["reference", "stale", "low_quality", "combined", "unseen"]:
        for w in [1, 2, 4, 8, 16, "all"]:
            for ctrl in [None, "frozen_model"]:
                for t in range(4, 26):
                    wk = window_weeks(dict(condition=cond, window=w, control=ctrl), t, cfg)
                    assert t not in wk and max(wk) < t and len(wk) > 0
