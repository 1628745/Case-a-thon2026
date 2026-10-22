import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.common import load_config  # noqa: E402


@pytest.fixture(scope="session")
def cfg():
    return load_config()


def make_feed(n_days=70, n_couriers=12, n_aoi=8, per_day=6, seed=0):
    """Small synthetic feed in the processed schema."""
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2022-05-01")
    rows = []
    oid = 0
    for d in range(n_days):
        for c in range(n_couriers):
            for _ in range(per_day):
                acc = start + pd.Timedelta(days=d, minutes=int(rng.integers(8 * 60, 18 * 60)))
                dur = float(rng.integers(5, 600))
                rows.append(dict(order_id=oid, courier_id=c, aoi_id=int(rng.integers(n_aoi)), region_id=1,
                                 aoi_type=int(rng.integers(3)), lng=106.5, lat=29.5, dist_km=1.0, gps_age_min=0.0,
                                 accept_time=acc, delivery_time=acc + pd.Timedelta(minutes=dur)))
                oid += 1
    df = pd.DataFrame(rows).sort_values(["accept_time", "order_id"]).reset_index(drop=True)
    df["day"] = ((df.accept_time.dt.normalize() - start).dt.days).astype(np.int32)
    df["week"] = (df.day // 7).astype(np.int32)
    df["hour"] = df.accept_time.dt.hour
    df["minute_of_day"] = df.hour * 60 + df.accept_time.dt.minute
    df["dow"] = df.accept_time.dt.dayofweek
    df["row_id"] = np.arange(len(df))
    df["ref_duration_min"] = (df.delivery_time - df.accept_time).dt.total_seconds() / 60
    return df


@pytest.fixture
def feed():
    return make_feed()
