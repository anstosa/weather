"""fit fixed full-context ordinal rain heads with all-history date decay."""

# ruff: noqa: E402

import hashlib
import os
from pathlib import Path

# keep native research fitting on one numerical thread
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_context_features as context_features
import rain_ordinal as ordinal
import rain_search as search
from rain_sub24 import POLICY as PARENT_POLICY
from run_rain_sub24 import weights as balanced_weights

HALF_LIFE_DAYS = 183
ROUNDS = 160
PARAMETERS = search.PARAMETERS
FEATURE_NAMES = context_features.FEATURE_SETS['full']


# retain every earlier training hour under fixed date-balanced decay
def decayed_weights(hours, stop):
    hours = np.asarray(hours)
    # require an exact utc-day training cutoff and only matured integer hours
    if hours.ndim != 1 or not len(hours) or not np.issubdtype(hours.dtype, np.integer) or not isinstance(stop, (int, np.integer)) or isinstance(stop, (bool, np.bool_)) or stop % 24 or (hours >= stop).any():
        raise ValueError('invalid decayed rain training hours or cutoff')
    age = stop // 24 - 1 - hours // 24
    decay = np.exp2(-age.astype(np.float64) / HALF_LIFE_DAYS)
    weight = balanced_weights(hours) * decay
    weight *= len(hours) / float(weight.sum())
    # forbid zero or nonfinite training contribution from any retained row
    if not np.isfinite(weight).all() or (weight <= 0).any() or not np.isclose(float(weight.sum()), len(hours), rtol=1e-12, atol=1e-10):
        raise ValueError('invalid decayed rain training weight')
    return weight.astype(np.float64, copy=False)


# count effective independent dates from normalized date-level weight mass
def _effective_dates(hours, weight):
    _, inverse = np.unique(hours // 24, return_inverse=True)
    mass = np.bincount(inverse, weights=weight)
    mass /= mass.sum()
    return float(1. / np.dot(mass, mass))


# bind the frozen full-context source matrix and observed fit labels
def _training_arrays(x, actual, hours, names, stop):
    x = np.asarray(x, dtype=np.float32)
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    # reject schema drift, malformed targets and late actual hours
    if tuple(names) != FEATURE_NAMES or x.ndim != 2 or x.shape[1] != len(FEATURE_NAMES) or actual.shape != (len(x),) or hours.shape != actual.shape or not len(x) or not np.issubdtype(hours.dtype, np.integer) or np.isinf(x).any() or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid decayed rain training arrays')
    hours = hours.astype(np.int64, copy=False)
    decayed_weights(hours, stop)
    return x, actual, hours


# fit the same four native objectives on unchanged rows and feature order
def fit(x, actual, hours, directory, names, stop):
    x, actual, hours = _training_arrays(x, actual, hours, names, stop)
    # require the same reviewed native runtime and automatic objective intercepts
    if xgb.__version__ != PARENT_POLICY['xgboostVersion'] or 'base_score' in PARAMETERS:
        raise ValueError('unexpected decayed rain native configuration')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    weight = decayed_weights(hours, stop)
    wet = actual >= ordinal.THRESHOLDS[0]
    wet_weight = decayed_weights(hours[wet], stop) if wet.any() else np.empty(0, dtype=np.float64)
    models = {}
    state = {
        'featureNames': list(FEATURE_NAMES),
        'rounds': ROUNDS,
        'heads': {},
        'trainingRows': int(len(hours)),
        'trainingMinimumActualHour': int(hours.min()),
        'trainingMaximumActualHour': int(hours.max()),
        'trainingMaximumValidHourExclusive': int(stop),
        'trainingWeight': {
            'policy': 'equal_date_hour_vintage_then_fixed_exponential_date_decay',
            'halfLifeDays': HALF_LIFE_DAYS,
            'normalization': 'sum_equals_fitted_row_count_per_head',
            'rows': int(len(hours)),
            'weightSum': float(weight.sum()),
            'effectiveDates': _effective_dates(hours, weight),
            'oldestDateAgeDays': int(stop // 24 - 1 - (hours.min() // 24)),
            'newestDateAgeDays': int(stop // 24 - 1 - (hours.max() // 24)),
            'wetRows': int(wet.sum()),
            'wetWeightSum': float(wet_weight.sum()),
            'wetEffectiveDates': _effective_dates(hours[wet], wet_weight) if wet.any() else 0.,
        },
    }
    # preserve the original positive-hour/date support gates for each binary head
    for threshold, name, filename in zip(ordinal.THRESHOLDS, ordinal.HEAD_NAMES, ordinal.MODEL_FILES[:3]):
        support = ordinal._support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        # an unsupported threshold has no native model and keeps raw fallback
        if support['positiveHours'] >= 10 and support['positiveDates'] >= 3:
            matrix = xgb.DMatrix(x, label=(actual >= threshold).astype(np.float32), weight=weight, feature_names=list(FEATURE_NAMES), nthread=1)
            booster = xgb.train({**PARAMETERS, 'objective': 'binary:logistic'}, matrix, num_boost_round=ROUNDS)
            path = directory / filename
            booster.save_model(path)
            head.update({'modelFile': filename, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'reason': 'fitted'})
            models[name] = booster
        state['heads'][name] = head
    support = ordinal._support(actual, hours, ordinal.THRESHOLDS[0])
    amount = {'objective': 'reg:gamma', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support'}
    models['amount'] = None
    # conditional gamma trains on positive labels with separately normalized decay
    if support['positiveHours'] >= 100 and support['positiveDates'] >= 20:
        matrix = xgb.DMatrix(x[wet], label=actual[wet], weight=wet_weight, feature_names=list(FEATURE_NAMES), nthread=1)
        booster = xgb.train({**PARAMETERS, 'objective': 'reg:gamma'}, matrix, num_boost_round=ROUNDS)
        path = directory / ordinal.MODEL_FILES[3]
        booster.save_model(path)
        amount.update({'modelFile': ordinal.MODEL_FILES[3], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'reason': 'fitted'})
        models['amount'] = booster
    state['heads']['amount'] = amount
    return models, state
