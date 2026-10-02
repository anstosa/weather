"""choose each fixed ordinal head's tree count on earlier inner validation."""

# ruff: noqa: E402

import hashlib
import os
from pathlib import Path

# bound native training threads before numerical imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_fit_decay as decay
import rain_ordinal as ordinal
from rain_sub24 import POLICY as PARENT_POLICY
from run_rain_sub24 import weights as balanced_weights

VALIDATION_DAYS = 120
EMBARGO_DAYS = 7
MAXIMUM_ROUNDS = 320
FALLBACK_ROUNDS = 160
BINARY_VALIDATION_HOURS = 10
BINARY_VALIDATION_DATES = 5
GAMMA_VALIDATION_HOURS = 20
GAMMA_VALIDATION_DATES = 5


# isolate inner labels from outer fit calibration and evaluation periods
def inner_masks(hours, stop):
    hours = np.asarray(hours)
    # keep only matured integer actual hours before a midnight cutoff
    if hours.ndim != 1 or not len(hours) or not np.issubdtype(hours.dtype, np.integer) or not isinstance(stop, (int, np.integer)) or isinstance(stop, (bool, np.bool_)) or stop % 24 or (hours >= stop).any():
        raise ValueError('invalid nested-capacity training hours')
    validation_start = stop - VALIDATION_DAYS * 24
    inner_train_stop = validation_start - EMBARGO_DAYS * 24
    training = hours < inner_train_stop
    validation = (hours >= validation_start) & (hours < stop)
    bounds = {'innerTrainingMaximumValidHourExclusive': int(inner_train_stop), 'innerValidationStartHour': int(validation_start), 'innerValidationMaximumValidHourExclusive': int(stop), 'innerEmbargoHours': EMBARGO_DAYS * 24}
    return training, validation, bounds


# select the first one-based round attaining the exact minimum validation loss
def earliest_minimum(losses):
    losses = np.asarray(losses, dtype=np.float64)
    # reject incomplete or nonfinite metric histories
    if losses.shape != (MAXIMUM_ROUNDS,) or not np.isfinite(losses).all():
        raise ValueError('invalid nested-capacity validation history')
    return int(np.argmin(losses) + 1)


# bind original full-context features and unchanged physical targets
def _training_arrays(x, actual, hours, names, stop):
    x = np.asarray(x, dtype=np.float32)
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    # reject feature or target schema drift before any native fitting
    if tuple(names) != decay.FEATURE_NAMES or x.ndim != 2 or x.shape[1] != len(decay.FEATURE_NAMES) or actual.shape != (len(x),) or hours.shape != actual.shape or not len(x) or not np.issubdtype(hours.dtype, np.integer) or np.isinf(x).any() or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid nested-capacity fit arrays')
    inner_masks(hours, stop)
    return x, actual, hours.astype(np.int64, copy=False)


# retain old support rules for inner training and prespecified validation gates
def _supported(support, objective, validation=False):
    # gamma learns only observed wet amount with stronger fit support
    if objective == 'reg:gamma':
        hours = GAMMA_VALIDATION_HOURS if validation else 100
        dates = GAMMA_VALIDATION_DATES if validation else 20
    else:
        hours = BINARY_VALIDATION_HOURS if validation else 10
        dates = BINARY_VALIDATION_DATES if validation else 3
    return support['positiveHours'] >= hours and support['positiveDates'] >= dates


# compute one rowcount-normalized date-decayed training matrix
def _matrix(x, labels, hours, cutoff):
    weight = decay.decayed_weights(hours, cutoff)
    return xgb.DMatrix(x, label=labels.astype(np.float32), weight=weight, feature_names=list(decay.FEATURE_NAMES), nthread=1)


# fit a single inner booster with the pinned native weighted metric history
def _fit_inner(x, labels, hours, validation_x, validation_labels, validation_hours, cutoff, objective, path):
    matrix = _matrix(x, labels, hours, cutoff)
    validation_weight = balanced_weights(validation_hours) * len(validation_hours)
    evaluation = xgb.DMatrix(validation_x, label=validation_labels.astype(np.float32), weight=validation_weight, feature_names=list(decay.FEATURE_NAMES), nthread=1)
    history = {}
    metric = 'gamma-deviance' if objective == 'reg:gamma' else 'logloss'
    parameters = {**decay.PARAMETERS, 'objective': objective, 'eval_metric': metric}
    booster = xgb.train(parameters, matrix, num_boost_round=MAXIMUM_ROUNDS, evals=[(evaluation, 'validation')], evals_result=history, verbose_eval=False)
    losses = [float(value) for value in history['validation'][metric]]
    selected = earliest_minimum(losses)
    booster.save_model(path)
    return selected, losses, metric, hashlib.sha256(path.read_bytes()).hexdigest()


# select inner capacity then refit one final booster on every outer-fit row
def fit(x, actual, hours, directory, names, stop):
    x, actual, hours = _training_arrays(x, actual, hours, names, stop)
    # retain fixed learner settings and the reviewed native runtime
    if xgb.__version__ != PARENT_POLICY['xgboostVersion'] or 'base_score' in decay.PARAMETERS:
        raise ValueError('unexpected nested-capacity native configuration')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    inner_train, inner_validation, bounds = inner_masks(hours, stop)
    models = {}
    state = {'featureNames': list(decay.FEATURE_NAMES), 'rounds': None, 'selectionMaximumRounds': MAXIMUM_ROUNDS, 'fallbackRounds': FALLBACK_ROUNDS, 'heads': {}, 'trainingRows': int(len(hours)), 'trainingMinimumActualHour': int(hours.min()), 'trainingMaximumActualHour': int(hours.max()), 'trainingMaximumValidHourExclusive': int(stop), 'innerBounds': bounds, 'innerTrainingRows': int(inner_train.sum()), 'innerValidationRows': int(inner_validation.sum()), 'trainingWeight': {'policy': 'equal_date_hour_vintage_then_fixed_exponential_date_decay', 'halfLifeDays': decay.HALF_LIFE_DAYS}}
    specifications = tuple((threshold, name, filename, 'binary:logistic') for threshold, name, filename in zip(ordinal.THRESHOLDS, ordinal.HEAD_NAMES, ordinal.MODEL_FILES[:3])) + ((ordinal.THRESHOLDS[0], 'amount', ordinal.MODEL_FILES[3], 'reg:gamma'),)
    # fit exactly the four original objective heads without a capacity grid
    for threshold, name, filename, objective in specifications:
        outer_support = ordinal._support(actual, hours, threshold)
        train_support = ordinal._support(actual[inner_train], hours[inner_train], threshold)
        validation_support = ordinal._support(actual[inner_validation], hours[inner_validation], threshold)
        head = {'objective': objective, 'support': outer_support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support' if objective == 'reg:gamma' else 'insufficient_positive_support', 'selectedRound': None, 'selectionReason': 'unsupported_outer_fit', 'innerTrainingSupport': train_support, 'innerValidationSupport': validation_support, 'innerModelFile': None, 'innerSha256': None, 'validationMetric': None, 'validationLossByRound': None, 'innerBounds': bounds}
        models[name] = None
        # unavailable outer support preserves the original raw-head fallback
        if not _supported(outer_support, objective):
            state['heads'][name] = head
            continue
        selected = FALLBACK_ROUNDS
        head['selectionReason'] = 'insufficient_inner_training_support' if not _supported(train_support, objective) else 'insufficient_inner_validation_support'
        # run the one fixed inner history only when both support gates pass
        if _supported(train_support, objective) and _supported(validation_support, objective, validation=True):
            selected_train = inner_train & (actual >= threshold) if objective == 'reg:gamma' else inner_train
            selected_validation = inner_validation & (actual >= threshold) if objective == 'reg:gamma' else inner_validation
            labels_train = actual[selected_train] if objective == 'reg:gamma' else (actual[selected_train] >= threshold).astype(np.float64)
            labels_validation = actual[selected_validation] if objective == 'reg:gamma' else (actual[selected_validation] >= threshold).astype(np.float64)
            inner_path = directory / f'inner-{filename}'
            selected, losses, metric, digest = _fit_inner(x[selected_train], labels_train, hours[selected_train], x[selected_validation], labels_validation, hours[selected_validation], bounds['innerTrainingMaximumValidHourExclusive'], objective, inner_path)
            head.update({'selectionReason': 'earliest_minimum_inner_validation', 'innerModelFile': inner_path.name, 'innerSha256': digest, 'validationMetric': metric, 'validationLossByRound': losses})
        selected_outer = actual >= threshold if objective == 'reg:gamma' else np.ones(len(actual), dtype=bool)
        labels_outer = actual[selected_outer] if objective == 'reg:gamma' else (actual[selected_outer] >= threshold).astype(np.float64)
        matrix = _matrix(x[selected_outer], labels_outer, hours[selected_outer], stop)
        booster = xgb.train({**decay.PARAMETERS, 'objective': objective}, matrix, num_boost_round=selected)
        path = directory / filename
        booster.save_model(path)
        head.update({'modelFile': filename, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'reason': 'fitted', 'selectedRound': selected})
        models[name] = booster
        state['heads'][name] = head
    return models, state
