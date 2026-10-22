"""Median (L1) and P80 (quantile) LightGBM models with fixed settings."""
import time

import lightgbm as lgb
import numpy as np


def _params(cfg, seed, threads):
    m = cfg["model"]
    return dict(n_estimators=m["n_estimators"], learning_rate=m["learning_rate"], num_leaves=m["num_leaves"],
                min_child_samples=m["min_child_samples"], subsample=m["subsample"],
                subsample_freq=m["subsample_freq"], colsample_bytree=m["colsample_bytree"],
                random_state=seed, verbose=-1, n_jobs=threads)


def fit(X, y, w, cfg, seed, threads, quantile=None):
    p = _params(cfg, seed, threads)
    if quantile is None:
        p["objective"] = "l1"
    else:
        p["objective"], p["alpha"] = "quantile", quantile
    mdl = lgb.LGBMRegressor(**p)
    mdl.fit(X, y, sample_weight=w)
    return mdl


def predict(mdl, X):
    return mdl.predict(X, num_threads=1)


class Timer:
    def __enter__(self):
        self.t = time.perf_counter()
        return self

    def __exit__(self, *a):
        self.s = time.perf_counter() - self.t
