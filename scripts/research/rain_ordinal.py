"""fit ordered rain-event heads and project a conditional wet amount."""

import hashlib
import os
from pathlib import Path

# bound native numerical threads before importing their runtimes
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_sub24 import FEATURE_NAMES, POLICY
from run_rain_sub24 import weights

THRESHOLDS = (0.1, 1.0, 2.5)
HEAD_NAMES = ('0.1', '1.0', '2.5')
MODEL_FILES = ('event-0.1.json', 'event-1.0.json', 'event-2.5.json', 'amount.json')
MINIMUM_CALIBRATION_HOURS = (10, 5, 3)


# validate one aligned training slice before native fitting
def _training_arrays(x, actual, hours):
    x = np.asarray(x, dtype=np.float32)
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    # reject malformed and nonphysical fit data
    if x.ndim != 2 or x.shape[1] != len(FEATURE_NAMES) or actual.shape != (len(x),) or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not len(x) or np.isinf(x).any() or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid ordinal training arrays')
    return x, actual, hours.astype(np.int64, copy=False)


# count observed events by valid hour and utc date
def _support(actual, hours, threshold):
    selected = actual >= threshold
    positive_hours = np.unique(hours[selected])
    return {'rows': int(len(actual)), 'positiveRows': int(selected.sum()), 'positiveHours': int(len(positive_hours)), 'positiveDates': int(len(np.unique(positive_hours // 24)))}


# fit four fixed native objectives without borrowing evaluation labels
def fit_models(x, actual, hours, directory, parameters, rounds):
    x, actual, hours = _training_arrays(x, actual, hours)
    # require the reviewed native research runtime
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected ordinal learner runtime')
    # keep logistic and gamma intercepts on native automatic initialization
    if 'base_score' in parameters:
        raise ValueError('ordinal heads require automatic base scores')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    models = {}
    state = {'featureNames': list(FEATURE_NAMES), 'rounds': int(rounds), 'heads': {}}
    # fit occurrence heads at all three physical thresholds
    for threshold, name, filename in zip(THRESHOLDS, HEAD_NAMES, MODEL_FILES[:3]):
        support = _support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        # preserve unsupported rare events as explicit raw fallback heads
        if support['positiveHours'] >= 10 and support['positiveDates'] >= 3:
            matrix = xgb.DMatrix(x, label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=list(FEATURE_NAMES), nthread=1)
            booster = xgb.train({**parameters, 'objective': 'binary:logistic'}, matrix, num_boost_round=rounds)
            path = directory / filename
            booster.save_model(path)
            head.update({'modelFile': filename, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'reason': 'fitted'})
            models[name] = booster
        state['heads'][name] = head
    wet = actual >= THRESHOLDS[0]
    support = _support(actual, hours, THRESHOLDS[0])
    amount = {'objective': 'reg:gamma', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support'}
    models['amount'] = None
    # train conditional amount only where its positive gamma label exists
    if support['positiveHours'] >= 100 and support['positiveDates'] >= 20:
        matrix = xgb.DMatrix(x[wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=list(FEATURE_NAMES), nthread=1)
        booster = xgb.train({**parameters, 'objective': 'reg:gamma'}, matrix, num_boost_round=rounds)
        path = directory / MODEL_FILES[3]
        booster.save_model(path)
        amount.update({'modelFile': MODEL_FILES[3], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'reason': 'fitted'})
        models['amount'] = booster
    state['heads']['amount'] = amount
    return models, state


# predict event probabilities and wet-only amount without target labels
def predict(models, x):
    x = np.asarray(x, dtype=np.float32)
    # bind all forecast features to the frozen order
    if x.ndim != 2 or x.shape[1] != len(FEATURE_NAMES) or np.isinf(x).any():
        raise ValueError('invalid ordinal forecast features')
    probabilities = np.full((len(x), len(THRESHOLDS)), np.nan, dtype=np.float64)
    amount = np.full(len(x), np.nan, dtype=np.float64)
    # empty forecast batches require no native call
    if not len(x):
        return probabilities, amount
    matrix = xgb.DMatrix(x, feature_names=list(FEATURE_NAMES), nthread=1)
    # leave absent event heads marked for raw fallback
    for index, name in enumerate(HEAD_NAMES):
        booster = models.get(name)
        # clip native numerical roundoff at probability limits
        if booster is not None:
            probabilities[:, index] = np.clip(booster.predict(matrix), 0, 1)
    # leave an unsupported conditional amount explicitly missing
    if models.get('amount') is not None:
        amount[:] = np.clip(models['amount'].predict(matrix), THRESHOLDS[0], 30)
    return probabilities, amount


# compute date-hour balanced event accuracy on one calibration slice
def _metrics(observed, called, weight):
    hit = float(weight @ (observed & called))
    miss = float(weight @ (observed & ~called))
    false = float(weight @ (~observed & called))
    return {'pod': 0. if hit + miss == 0 else hit / (hit + miss), 'far': 0. if hit + false == 0 else false / (hit + false), 'csi': 0. if hit + miss + false == 0 else hit / (hit + miss + false)}


# calibrate highest recall-safe cutoffs on prior labels only
def calibrate_events(actual, raw, probabilities, hours):
    actual = np.asarray(actual, dtype=np.float64)
    raw = np.asarray(raw, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    hours = np.asarray(hours)
    # enforce aligned calibration-only inputs
    if actual.ndim != 1 or raw.shape != actual.shape or probabilities.shape != (len(actual), len(THRESHOLDS)) or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or not np.isfinite(raw).all() or (actual < 0).any() or (raw < 0).any():
        raise ValueError('invalid ordinal calibration arrays')
    weight = weights(hours)
    rules = []
    # calibrate each event definition independently before nesting calls
    for index, (threshold, name, minimum_hours) in enumerate(zip(THRESHOLDS, HEAD_NAMES, MINIMUM_CALIBRATION_HOURS)):
        support = _support(actual, hours, threshold)
        observed = actual >= threshold
        raw_metrics = _metrics(observed, raw >= threshold, weight)
        rule = {'threshold': threshold, 'head': name, 'cutoff': None, 'reason': 'insufficient_calibration_support', 'support': support, 'raw': raw_metrics, 'candidate': None, 'targetRecall': None}
        scores = probabilities[:, index]
        # support and missing heads fail closed to raw event calls
        if support['positiveHours'] >= minimum_hours and support['positiveDates'] >= 2:
            # a completely missing head is a supported raw fallback
            if np.isnan(scores).all():
                rule['reason'] = 'missing_model_head'
            else:
                # partial or out-of-range probabilities indicate a broken head
                if not np.isfinite(scores).all() or (scores < 0).any() or (scores > 1).any():
                    raise ValueError('invalid ordinal calibration probabilities')
                target = min(1., raw_metrics['pod'] + .05)
                rule['targetRecall'] = target
                cutoff = None
                # descending unique positive scores give the largest recall-safe cutoff, including ties
                for score in np.unique(scores[observed])[::-1]:
                    candidate = _metrics(observed, scores >= score, weight)
                    # stop at the first cutoff that meets raw recall plus five points
                    if candidate['pod'] + 1e-12 >= target:
                        cutoff = float(score)
                        rule['candidate'] = candidate
                        break
                # measured precision and skill guard against recall-only calibration
                if cutoff is not None and rule['candidate']['far'] <= raw_metrics['far'] + .05 + 1e-12 and rule['candidate']['csi'] + 1e-12 >= raw_metrics['csi'] - .01:
                    rule.update({'cutoff': cutoff, 'reason': 'calibrated'})
                else:
                    rule['reason'] = 'calibration_safety_regression'
        rules.append(rule)
    return rules


# choose the highest called event so output categories are nested
def event_categories(raw, probabilities, rules):
    raw = np.asarray(raw, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    # require one cutoff rule per ordered physical threshold
    if raw.ndim != 1 or probabilities.shape != (len(raw), len(THRESHOLDS)) or len(rules) != len(THRESHOLDS) or not np.isfinite(raw).all() or (raw < 0).any() or any(rule['threshold'] != threshold for rule, threshold in zip(rules, THRESHOLDS)):
        raise ValueError('invalid ordinal event inputs')
    category = np.zeros(len(raw), dtype=np.int8)
    # highest matching category resolves independently calibrated nonnesting heads
    for index, (threshold, rule) in enumerate(zip(THRESHOLDS, rules)):
        cutoff = rule['cutoff']
        # raw fallback ignores the unavailable probability column
        if cutoff is None:
            called = raw >= threshold
        else:
            scores = probabilities[:, index]
            # do not silently treat a broken supported head as dry
            if not np.isfinite(scores).all() or (scores < 0).any() or (scores > 1).any():
                raise ValueError('invalid ordinal event probabilities')
            called = scores >= cutoff
        category[called] = index + 1
    return category


# force each projected amount into its called event category
def project_amount(base, categories, scale):
    base = np.asarray(base, dtype=np.float64)
    categories = np.asarray(categories)
    # reject invalid model amounts instead of masking them with category clips
    if base.ndim != 1 or categories.shape != base.shape or not np.isfinite(base).all() or (base < 0).any() or not np.issubdtype(categories.dtype, np.integer) or not np.isin(categories, (0, 1, 2, 3)).all() or not np.isfinite(scale) or scale <= 0:
        raise ValueError('invalid ordinal amount projection inputs')
    result = np.zeros(len(base), dtype=np.float64)
    scaled = base * float(scale)
    # preserve an exact dry zero and disjoint amount bands
    for category, lower, upper in ((1, .1, np.nextafter(1., 0.)), (2, 1., np.nextafter(2.5, 0.)), (3, 2.5, 30.)):
        selected = categories == category
        result[selected] = np.clip(scaled[selected], lower, upper)
    return result
