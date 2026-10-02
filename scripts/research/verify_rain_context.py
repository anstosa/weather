"""independently reconstruct source-derived rain-context features and replay models."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# pin native reductions before importing numerical libraries
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_context import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from rain_residual import POLICY as RESIDUAL_POLICY
from verify_rain_event_guard import (
    calibrated_scale as old_calibrated_scale,
    load_inputs,
    month_masks as old_month_masks,
    same_tree,
    score_accumulations,
    score_events,
    score_groups,
)
from verify_rain_residual import development_gates as residual_gates
from verify_rain_search import (
    calibrate,
    check_booster,
    checked_rules,
    head_support,
    month_masks,
    ordinal_categories,
    ordinal_project,
    ordinal_rules,
    support,
)
from verify_rain_sub24_model import metrics, require, weights

COHORT = 'ecmwf_single_run_hindcast'
PRESSURE_NAMES = ('forecastPressureHpa', 'pressureChange3h', 'pressureChange6h', 'pressureNext6hChange', 'pressureRange7h', 'pressureSinceDecision')
CYCLE_NAMES = ('prior6Rain', 'prior12Rain', 'revision6Rain', 'revision12Rain', 'prior6Mean3h', 'prior12Mean3h', 'vintageRainMean', 'vintageRainStd', 'vintageRainRange', 'vintageWetFraction', 'vintageHeavyFraction', 'vintageCount')
LEARNERS = {'weightedBase': ('weighted_tweedie', 'base'), 'weightedPressure': ('weighted_tweedie', 'pressure'), 'weightedCycles': ('weighted_tweedie', 'cycle'), 'weightedContext': ('weighted_tweedie', 'full'), 'ordinalBase': ('ordinal_gamma', 'base'), 'ordinalContext': ('ordinal_gamma', 'full')}
CANDIDATES = {'weightedContext': 'weightedBase', 'ordinalContext': 'ordinalBase'}
ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', *LEARNERS)
THRESHOLDS = (.1, 1., 2.5)
HEADS = ('0.1', '1.0', '2.5')
HEAD_FILES = ('event-0.1.json', 'event-1.0.json', 'event-2.5.json')
PREVIOUS_SEARCH = 'weather-moisture-research-rain-search-20260913-v1'


# parse only timezone-aware, whole-hour source identities
def hour(value):
    instant = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(instant.tzinfo is not None and instant.timestamp() % 3600 == 0, 'invalid context source hour')
    return int(instant.timestamp() // 3600)


# bind the complete normalized cohort to the source manifest and freeze
def check_freeze(root, freeze, feature_names):
    require(freeze['policy'] == POLICY and freeze['featureNames'] == feature_names and freeze['inputSchemaFreezeSha256'] == hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest() and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'context freeze changed')
    require(set(freeze['sourceSha256']) == set(SOURCE_FILES), 'context producer source set changed')
    # compare every producer dependency to its retained pre-outcome bytes
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts and len(relative.parts) == 1, 'unsafe context source path')
        saved, live = root / 'context-sources' / name, Path(__file__).with_name(name)
        require(saved.is_file() and live.is_file() and not saved.is_symlink(), f'missing context producer source: {name}')
        require(hashlib.sha256(saved.read_bytes()).hexdigest() == expected and hashlib.sha256(live.read_bytes()).hexdigest() == expected, f'context producer source changed: {name}')
    manifest_bytes = (root / 'inputs/acquisition/manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require(hashlib.sha256(manifest_bytes).hexdigest() == freeze['sourceManifestSha256'], 'context source manifest changed')
    cohorts = manifest.get('cohortFiles')
    require(isinstance(cohorts, dict) and set(cohorts) == {COHORT}, 'context source cohort changed')
    cohort = cohorts[COHORT]
    require(cohort['path'] == 'normalized/ecmwf_single_run_hindcast.jsonl' and cohort['sha256'] == POLICY['sourceTrajectorySha256'] == 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1' and cohort['rows'] == cohort['successfulRuns'] * 48 and cohort['successfulRuns'] > 0 and cohort['bytes'] > 0, 'context source cohort metadata changed')
    path = root / 'inputs/trajectory.jsonl'
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == cohort['bytes'] == freeze['trajectoryBytes'] and cohort['rows'] == freeze['trajectoryRows'], 'context trajectory size changed')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == cohort['sha256'] == freeze['trajectorySha256'], 'context trajectory hash changed')
    return cohort


# independently parse normalized 48-lead forecasts including unused pressure
def load_profiles(path, cohort):
    profiles = {}
    block = []
    rows = 0
    # preserve complete source-run boundaries and exact lead order
    with path.open() as stream:
        for line in stream:
            record = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            block.append(record)
            rows += 1
            if len(block) == 48:
                initialized = hour(block[0]['runInitializedAt'])
                require(initialized not in profiles, 'duplicate context source run')
                fields = {'rain': np.empty(48), 'temperature': np.empty(48), 'pressure': np.empty(48)}
                # bind every source target time to its initialized lead
                for lead, item in enumerate(block, 1):
                    require(item['runInitializedAt'] == block[0]['runInitializedAt'] and item['targetLeadHours'] == lead and hour(item['validAt']) == initialized + lead and item.get('cohort', COHORT) == COHORT, 'context source lead identity changed')
                    for name, source_key in (('rain', 'rawPrecipitationMm'), ('temperature', 'rawTemperatureC'), ('pressure', 'rawPressureHpa')):
                        value = item[source_key]
                        require(value is None or (type(value) in (int, float) and np.isfinite(value)), 'invalid normalized context measurement')
                        fields[name][lead - 1] = np.nan if value is None else value
                require(all(not np.isinf(values).any() for values in fields.values()) and ((0 <= fields['rain'][np.isfinite(fields['rain'])]) & (fields['rain'][np.isfinite(fields['rain'])] <= 2000)).all() and ((-100 <= fields['temperature'][np.isfinite(fields['temperature'])]) & (fields['temperature'][np.isfinite(fields['temperature'])] <= 70)).all() and ((100 <= fields['pressure'][np.isfinite(fields['pressure'])]) & (fields['pressure'][np.isfinite(fields['pressure'])] <= 1200)).all(), 'nonphysical context source forecast')
                profiles[initialized] = fields
                block = []
    require(not block and rows == cohort['rows'] and len(profiles) == cohort['successfulRuns'], 'context profile count changed')
    return profiles


# use strict finite inputs for a physical pressure difference
def finite_difference(first, second):
    return first - second if np.isfinite(first) and np.isfinite(second) else np.nan


# compute six pressure tendencies from one known initialized profile
def pressure_features(pressure, lead):
    current = pressure[lead - 1]
    earlier3, earlier6 = pressure[lead - 4], pressure[lead - 7]
    later6, decision_prior = pressure[lead + 5], pressure[6]
    window = pressure[lead - 4:lead + 3]
    local_range = float(np.max(window) - np.min(window)) if np.isfinite(window).all() else np.nan
    return np.array([current, finite_difference(current, earlier3), finite_difference(current, earlier6), finite_difference(later6, current), local_range, finite_difference(current, decision_prior)], dtype=float)


# read aligned predecessor forecasts but never following cycles
def prior_profile(profiles, initialized, lead, gap):
    previous = profiles.get(initialized - gap)
    # an absent or nonfinite predecessor contributes no false dry forecast
    if previous is None or not np.isfinite(previous['rain'][lead + gap - 1]):
        return np.nan, np.nan, False
    target = previous['rain'][lead + gap - 1]
    window = previous['rain'][lead + gap - 2:lead + gap + 1]
    mean = float(np.mean(window)) if len(window) == 3 and np.isfinite(window).all() else np.nan
    return float(target), mean, True


# combine current and older forecast vintages at the same valid hour
def cycle_features(profiles, initialized, lead, current):
    prior6, mean6, available6 = prior_profile(profiles, initialized, lead, 6)
    prior12, mean12, available12 = prior_profile(profiles, initialized, lead, 12)
    vintages = np.array([current, prior6, prior12])
    finite = vintages[np.isfinite(vintages)]
    require(len(finite) >= 1, 'paired current rain unexpectedly missing')
    values = np.array([prior6, prior12, finite_difference(current, prior6), finite_difference(current, prior12), mean6, mean12, float(np.mean(finite)), float(np.std(finite, ddof=0)), float(np.max(finite) - np.min(finite)), float(np.mean(finite >= .1)), float(np.mean(finite >= 1)), float(len(finite))])
    return values, available6, available12


# independently derive all four feature matrices on the unchanged paired rows
def build_features(data, profiles, old_names):
    original = data['x']
    size = len(original)
    require(original.shape == (size, len(old_names)) and original.dtype == np.dtype(np.float32) and np.array_equal(original[:, 0], data['lead']) and np.array_equal(original[:, old_names.index('rawRain')], data['raw']), 'paired context feature schema changed')
    pressure = np.full((size, len(PRESSURE_NAMES)), np.nan, dtype=np.float32)
    cycles = np.full((size, len(CYCLE_NAMES)), np.nan, dtype=np.float32)
    availability = {name: np.zeros(size, dtype=bool) for name in ('pressureAvailable', 'prior6Available', 'prior12Available', 'newInformationAvailable')}
    raw_temp_index = old_names.index('rawTemperature')
    # derive only source-time covariates with no target or future-cycle reference
    for row in range(size):
        initialized, lead = int(data['initialized'][row]), 8 + int(data['lead'][row])
        profile = profiles.get(initialized)
        require(profile is not None and 9 <= lead <= 31 and initialized + lead == int(data['hour'][row]) and np.isfinite(profile['rain'][lead - 1]) and np.float32(profile['rain'][lead - 1]) == np.float32(data['raw'][row]), 'paired context raw differs from source')
        require(np.isfinite(profile['temperature'][lead - 1]) and np.float32(profile['temperature'][lead - 1]) == np.float32(original[row, raw_temp_index]), 'paired context temperature differs from source')
        pressure[row] = pressure_features(profile['pressure'], lead)
        cycles[row], prior6, prior12 = cycle_features(profiles, initialized, lead, float(profile['rain'][lead - 1]))
        availability['pressureAvailable'][row] = bool(np.isfinite(pressure[row]).all())
        availability['prior6Available'][row] = prior6
        availability['prior12Available'][row] = prior12
        availability['newInformationAvailable'][row] = bool(availability['pressureAvailable'][row] and (prior6 or prior12))
    matrices = {'base': original, 'pressure': np.column_stack((original, pressure)).astype(np.float32), 'cycle': np.column_stack((original, cycles)).astype(np.float32), 'full': np.column_stack((original, pressure, cycles)).astype(np.float32)}
    require(all(matrix.shape == (size, len(old_names) + (0 if name == 'base' else 6 if name == 'pressure' else 12 if name == 'cycle' else 18)) and not np.isinf(matrix).any() for name, matrix in matrices.items()), 'context feature matrix shape changed')
    return matrices, availability


# derive complete feature order without importing the producer feature helper
def feature_sets(old_names):
    names = tuple(old_names)
    return {'base': list(names), 'pressure': list((*names, *PRESSURE_NAMES)), 'cycle': list((*names, *CYCLE_NAMES)), 'full': list((*names, *PRESSURE_NAMES, *CYCLE_NAMES))}


# refit one weighted amount model on an independently reconstructed feature set
def refit_weighted(root, data, x, names, fit, calibration, evaluation, month, arm):
    actual, hours = data['actual'][fit], data['hour'][fit]
    costs = POLICY['rainWeights']
    cost = np.where(actual >= 1, costs[2], np.where(actual >= .1, costs[1], costs[0]))
    mass = weights(hours) * cost
    mass *= len(actual) / mass.sum()
    parameters = {**POLICY['parameters'], 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(x[fit], label=actual, weight=mass, feature_names=names, nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=POLICY['boostRounds'])
    path = root / 'context-models' / month / arm / 'amount.json'
    sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, sha, 'reg:tweedie', POLICY['boostRounds'], names)
    outputs = {}
    # score earlier calibration and current evaluation without future labels
    for population, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(x[mask], feature_names=names, nthread=1)
        learned = np.clip(booster.predict(matrix).astype(float), 0, 30)
        outputs[population] = np.clip(POLICY['rawBlend'] * data['raw'][mask] + (1 - POLICY['rawBlend']) * learned, 0, 30)
    actual_cal, hour_cal = data['actual'][calibration], data['hour'][calibration]
    scalar = calibrate(actual_cal, hour_cal, lambda scale: np.clip(outputs['calibration'] * scale, 0, 30), SEARCH_POLICY)
    predicted = np.clip(outputs['evaluation'] * scalar['scale'], 0, 30)
    state = {'supported': True, 'model': {'parameters': parameters, 'rainWeights': costs, 'modelSha256': sha}, 'calibration': scalar}
    return predicted, state


# refit all four ordinal heads with the candidate feature name order
def refit_ordinal(root, data, x, names, fit, calibration, evaluation, month, arm):
    actual, hours = data['actual'][fit], data['hour'][fit]
    directory = root / 'context-models' / month / arm
    models = {}
    state = {'featureNames': names, 'rounds': POLICY['boostRounds'], 'heads': {}}
    # preserve explicit raw fallback for rare unsupported event heads
    for threshold, name, filename in zip(THRESHOLDS, HEADS, HEAD_FILES):
        counts = head_support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': counts, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        if counts['positiveHours'] >= 10 and counts['positiveDates'] >= 3:
            matrix = xgb.DMatrix(x[fit], label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=names, nthread=1)
            booster = xgb.train({**POLICY['parameters'], 'objective': 'binary:logistic'}, matrix, num_boost_round=POLICY['boostRounds'])
            path = directory / filename
            sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            check_booster(booster, path, sha, 'binary:logistic', POLICY['boostRounds'], names)
            head.update({'modelFile': filename, 'sha256': sha, 'reason': 'fitted'})
            models[name] = booster
        else:
            require(not (directory / filename).exists(), f'unexpected unsupported context event head: {month}:{arm}:{name}')
        state['heads'][name] = head
    wet = actual >= .1
    counts = head_support(actual, hours, .1)
    require(counts['positiveHours'] >= 100 and counts['positiveDates'] >= 20, 'supported context month lacks wet amount support')
    matrix = xgb.DMatrix(x[fit][wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=names, nthread=1)
    booster = xgb.train({**POLICY['parameters'], 'objective': 'reg:gamma'}, matrix, num_boost_round=POLICY['boostRounds'])
    path = directory / 'amount.json'
    sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, sha, 'reg:gamma', POLICY['boostRounds'], names)
    state['heads']['amount'] = {'objective': 'reg:gamma', 'support': counts, 'modelFile': 'amount.json', 'sha256': sha, 'reason': 'fitted'}
    models['amount'] = booster

    # emit native probabilities and conditional wet amounts on both later windows
    def predict(mask):
        matrix = xgb.DMatrix(x[mask], feature_names=names, nthread=1)
        probability = np.full((int(mask.sum()), 3), np.nan)
        for index, name in enumerate(HEADS):
            if models[name] is not None:
                probability[:, index] = np.clip(models[name].predict(matrix), 0, 1)
        amount = np.clip(models['amount'].predict(matrix), .1, 30).astype(float)
        return probability, amount

    pc, ac = predict(calibration)
    pe, ae = predict(evaluation)
    raw_cal, raw_eval = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    actual_cal, hour_cal = data['actual'][calibration], data['hour'][calibration]
    proposed = ordinal_rules(actual_cal, raw_cal, pc, hour_cal, SEARCH_POLICY)
    rules, fallback = checked_rules(actual_cal, raw_cal, pc, hour_cal, proposed, SEARCH_POLICY)
    cc, ce = ordinal_categories(raw_cal, pc, rules), ordinal_categories(raw_eval, pe, rules)
    base_cal = np.clip(POLICY['rawBlend'] * raw_cal + (1 - POLICY['rawBlend']) * ac, 0, 30)
    base_eval = np.clip(POLICY['rawBlend'] * raw_eval + (1 - POLICY['rawBlend']) * ae, 0, 30)
    scalar = calibrate(actual_cal, hour_cal, lambda scale: ordinal_project(base_cal, cc, scale), SEARCH_POLICY)
    predicted = ordinal_project(base_eval, ce, scalar['scale'])
    calibrated = ordinal_project(base_cal, cc, scalar['scale'])
    events = score_events(actual_cal, hour_cal, {arm: calibrated}, SEARCH_POLICY['thresholdsMmPerHour'])[arm]
    record = {'supported': True, 'model': state, 'proposedRules': proposed, 'rules': rules, 'nestingSafetyFallback': fallback, 'calibration': scalar, 'compositeCalibrationEvents': events}
    return predicted, record


# replay each declared learner without using runner fit or prediction functions
def replay_month(root, data, matrices, names, old_policy, month):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(data['actual'][calibration], data['hour'][calibration])}
    raw = data['raw'][evaluation].astype(float)
    old_fit, old_cal, old_eval, _ = old_month_masks(data, month, old_policy)
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    old_scale = old_calibrated_scale(data['actual'][old_cal], data['raw'][old_cal], data['hour'][old_cal])
    require(np.array_equal(old_eval, evaluation) and int(old_fit.sum()) > 0 and old_state['policy'] == old_policy and old_state['featureNames'] == names['base'] and old_state['month'] == month and old_state['calibrationRows'] == int(old_cal.sum()) and np.isclose(old_scale, old_state['scales']['raw'], rtol=0, atol=1e-9), f'old context baseline changed: {month}')
    recent = data['persistence'][evaluation]
    raw_cal = data['raw'][calibration].astype(float)
    raw_scalar = calibrate(data['actual'][calibration], data['hour'][calibration], lambda scale: np.clip(raw_cal * scale, 0, 30), SEARCH_POLICY)
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_scale, 'volume90': np.clip(raw * raw_scalar['scale'], 0, 30)}
    state = {**bounds, 'support': counts, 'rawCalibration': raw_scalar, 'candidates': {}}
    available = all(counts['training'][key] >= minimum for key, minimum in POLICY['trainingSupport'].items()) and all(counts['calibration'][key] >= minimum for key, minimum in POLICY['calibrationSupport'].items())
    directory = root / 'context-models' / month
    require(directory.is_dir() and (directory / 'state.json').is_file() and xgb.__version__ == POLICY['xgboostVersion'], f'missing context model state or runtime changed: {month}')
    # preserve all unsupported rows as exact raw for each learner
    for arm, (family, kind) in LEARNERS.items():
        if not available:
            output[arm] = raw.copy()
            state['candidates'][arm] = {'supported': False, 'reason': 'insufficient_training_or_calibration_support'}
            require(not (directory / arm).exists(), f'unexpected unsupported context learner: {month}:{arm}')
        elif family == 'weighted_tweedie':
            output[arm], state['candidates'][arm] = refit_weighted(root, data, matrices[kind], names[kind], fit, calibration, evaluation, month, arm)
        else:
            output[arm], state['candidates'][arm] = refit_ordinal(root, data, matrices[kind], names[kind], fit, calibration, evaluation, month, arm)
    same_tree(state, json.loads((directory / 'state.json').read_text()), f'monthlyStates.{month}')
    return np.where(evaluation)[0], output, state


# concatenate all predetermined months without support-based row filtering
def replay_all(root, data, matrices, names, old_policy):
    months = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
    require(POLICY['developmentMonths'] == months and old_policy['holdoutMonths'] == months, 'context development window changed')
    indices = []
    amounts = {name: [] for name in ARMS}
    flags = {name: [] for name in LEARNERS}
    states = {}
    # independently fit each declared learner in every consumed month
    for month in months:
        rows, predicted, state = replay_month(root, data, matrices, names, old_policy, month)
        indices.append(rows)
        states[month] = state
        for name in ARMS:
            amounts[name].append(predicted[name])
        for name in LEARNERS:
            flags[name].append(np.full(len(rows), state['candidates'][name]['supported'], dtype=bool))
    indices = np.concatenate(indices)
    require(len(indices) == POLICY['expectedEvaluationRows'] == 32896 and len(np.unique(indices)) == len(indices), 'context evaluation population changed')
    return indices, {name: np.concatenate(parts) for name, parts in amounts.items()}, {name: np.concatenate(parts) for name, parts in flags.items()}, states


# count source-input coverage without using observed rain outcomes
def availability_counts(hours, available):
    output = {}
    # preserve all four availability definitions on each identical subset
    for name, mask in available.items():
        output[name] = {'rows': int(mask.sum()), 'hours': int(len(np.unique(hours[mask]))), 'dates': int(len(np.unique(hours[mask] // 24))), 'rowFraction': float(mask.mean()) if len(mask) else 0.}
    return output


# bind original baseline model states and exact predictions to known prior bytes
def reference_parity(root, indices, amounts, states):
    pinned = POLICY['referenceParity']['files']
    require(pinned == {'report.json': '015fdcb747747ff9852f8b72f7be7a19dcf41b46963d2bb69b51e028355e55f4', 'predictions.npz': '599daccfb51e9b7f514c9c4f6bf5d001f2fdff438b9a316e7bce466092edf30a'}, 'context baseline reference checksums changed')
    report_path, prediction_path = root / 'inputs/reference-search-report.json', root / 'inputs/reference-search-predictions.npz'
    require(hashlib.sha256(report_path.read_bytes()).hexdigest() == pinned['report.json'] and hashlib.sha256(prediction_path.read_bytes()).hexdigest() == pinned['predictions.npz'], 'context reference artifact changed')
    old = json.loads(report_path.read_text())
    require(old['independentEvaluationPerformed'] is False and old['productionEligible'] is False and old['freezeSha256'] == '7d5f5553644fc1580b41e712ac293e38fa79341494a8b40b54f67bcd10b3532f', 'context reference policy lineage changed')
    mapping = {'weightedBase': 'weightedModerate', 'ordinalBase': 'ordinalAmount'}
    require(POLICY['referenceParity']['arms'] == mapping, 'context baseline reference mapping changed')
    with np.load(prediction_path, allow_pickle=False) as previous_archive, np.load(root / 'predictions.npz', allow_pickle=False) as current_archive:
        require(np.array_equal(previous_archive['indices'], indices) and np.array_equal(current_archive['indices'], indices), 'context baseline evaluation population changed')
        # compare persisted baseline predictions exactly, then separately check the refit
        for current, previous in mapping.items():
            retained = current_archive[f'amount::{current}']
            require(np.array_equal(previous_archive[f'amount::{previous}'], retained), f'context exact base prediction parity changed: {current}')
            require(np.allclose(amounts[current], retained, rtol=1e-8, atol=1e-9), f'context independent base prediction parity changed: {current}')
            for month, state in states.items():
                saved = json.loads((root / 'context-models' / month / 'state.json').read_text())
                require(saved['candidates'][current] == old['monthlyStates'][month]['candidates'][previous], f'context exact base model state parity changed: {month}:{current}')
                same_tree(state['candidates'][current], saved['candidates'][current], f'contextRefit.{month}.{current}')
    return {'exactNativeModelStates': True, 'exactPredictions': True, 'arms': mapping}


# rename the candidate only at the inherited independent 44-gate boundary
def alias(value, candidate):
    if isinstance(value, dict):
        return {('residualAmount' if key == candidate else key): alias(item, candidate) for key, item in value.items()}
    if isinstance(value, list):
        return [alias(item, candidate) for item in value]
    return value


# enforce empirical safety, same-family value and new-information support
def candidate_screens(report, data, indices, flags, availability):
    require(POLICY['screen'] == RESIDUAL_POLICY['screen'] and POLICY['candidateSupport'] == RESIDUAL_POLICY['candidateSupport'] and POLICY['candidates'] == CANDIDATES, 'context gate contract changed')
    actual, hours = data['actual'][indices], data['hour'][indices]
    new_information = availability['newInformationAvailable'][indices]
    new_dates = len(np.unique(hours[new_information] // 24))
    screens = {}
    # screen only the two full-feature candidates, never the ablations
    for candidate, baseline in CANDIDATES.items():
        counts = support(actual[flags[candidate]], hours[flags[candidate]])
        view = alias(report, candidate)
        view['support'] = counts
        view['invariants'] = {'finiteNonnegative': report['invariants']['finiteNonnegative']}
        gates = residual_gates(view, RESIDUAL_POLICY)
        require(len(gates) == 44, 'inherited context gate count changed')
        gates['beatsSameWindowVolumeScale'] = report['overall'][candidate]['mae'] <= report['overall']['volume90']['mae']
        gates['beatsSameFamilyBase'] = report['overall'][candidate]['mae'] < report['overall'][baseline]['mae'] - POLICY['ablationMaeMargin']
        gates['newInformationCoverage'] = float(new_information.mean()) >= POLICY['newInformationSupport']['minimumRowFraction'] and new_dates >= POLICY['newInformationSupport']['minimumDates']
        require(len(gates) == 47, 'context gate count changed')
        screens[candidate] = {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [key for key, passed in gates.items() if not passed]}
    passing = [name for name in CANDIDATES if screens[name]['passed']]
    chosen = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, chosen


# score all identical rows and every predeclared reporting partition
def expected_report(root, freeze, data, old_policy, profiles, indices, amounts, flags, states, availability, parity):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'context-freeze.json').read_bytes()).hexdigest(), 'overall': {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}, 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report.update(score_groups(data, indices, amounts, old_policy))
    report['featureAvailability'] = {'overall': availability_counts(hours, {name: values[indices] for name, values in availability.items()})}
    # reproduce coverage independently for all month, season, lead and archive groups
    from verify_rain_event_guard import report_groups
    for field, labels in report_groups(data, indices, old_policy).items():
        report['featureAvailability'][field] = {str(key): availability_counts(hours[labels == key], {name: values[indices][labels == key] for name, values in availability.items()}) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}
    report['events'] = score_events(actual, hours, amounts, SEARCH_POLICY['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, amounts)
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in amounts.values()))}
    report['candidateScreens'], report['selectedCandidate'] = candidate_screens(report, data, indices, flags, availability)
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    report['referenceParity'] = parity
    report['featuresSha256'] = hashlib.sha256((root / 'features.npz').read_bytes()).hexdigest()
    report['featureProfileRuns'] = len(profiles)
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# verify all new inputs, full refits and selected development result
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    freeze = json.loads((root / 'context-freeze.json').read_text())
    require(old_freeze['featureNames'] == old_names and POLICY['learners'] == {name: {'family': family, 'features': kind} for name, (family, kind) in LEARNERS.items()} and POLICY['candidates'] == CANDIDATES and POLICY['expectedEvaluationRows'] == 32896 and POLICY['rainWeights'] == [1., 2., 4.] and POLICY['rawBlend'] == .25, 'context learner scope changed')
    require(POLICY['calibrationDays'] == SEARCH_POLICY['calibrationDays'] == 90 and POLICY['embargoDays'] == SEARCH_POLICY['embargoDays'] == 7 and POLICY['calibrationScaleBounds'] == SEARCH_POLICY['calibrationScaleBounds'] == [.1, 3.] and POLICY['newInformationSupport'] == {'minimumRowFraction': .95, 'minimumDates': 300} and POLICY['ablationMaeMargin'] == 1e-12 and POLICY['sourceAvailability'] == 'simulated_initialization_plus_8h_not_verified_historical_receipts', 'context scientific boundary changed')
    names = feature_sets(old_names)
    require(POLICY['featureSets'] == freeze['featureSets'] == names and len(old_names) == 77 and len(names['pressure']) == 83 and len(names['cycle']) == 89 and len(names['full']) == 95, 'context feature schema changed')
    cohort = check_freeze(root, freeze, old_names)
    profiles = load_profiles(root / 'inputs/trajectory.jsonl', cohort)
    matrices, availability = build_features(data, profiles, old_names)
    with np.load(root / 'features.npz', allow_pickle=False) as material:
        feature_archive = {name: material[name] for name in material.files}
    require(set(feature_archive) == {'x', *availability} and feature_archive['x'].shape == matrices['full'].shape and feature_archive['x'].dtype == np.dtype(np.float32) and np.array_equal(feature_archive['x'], matrices['full'], equal_nan=True), 'context full feature matrix changed')
    for name, expected in availability.items():
        require(feature_archive[name].dtype == np.dtype(bool) and np.array_equal(feature_archive[name], expected), f'context feature availability changed: {name}')
    indices, amounts, flags, states = replay_all(root, data, matrices, names, old_policy)
    parity = reference_parity(root, indices, amounts, states)
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices'} | {f'amount::{name}' for name in ARMS} | {f'supported::{name}' for name in flags}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices), 'context prediction population changed')
    for name, expected in amounts.items():
        retained = archive[f'amount::{name}']
        require(retained.shape == expected.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, expected, rtol=1e-8, atol=1e-9), f'context prediction replay changed: {name}')
    for name, expected in flags.items():
        retained = archive[f'supported::{name}']
        require(retained.dtype == np.dtype(bool) and np.array_equal(retained, expected), f'context candidate support changed: {name}')
    report_path = root / 'report.json'
    expected = expected_report(root, freeze, data, old_policy, profiles, indices, amounts, flags, states, availability, parity)
    same_tree(expected, json.loads(report_path.read_text()))
    native = sum(sum((record['model']['modelSha256'] is not None) if name.startswith('weighted') else sum(head['sha256'] is not None for head in record['model']['heads'].values()) for name, record in state['candidates'].items() if record['supported']) for state in states.values())
    receipt = {'contractVersion': 'rain-context-independent-verification/v1', 'verified': True, 'sourceProfilesVerified': len(profiles), 'featureRowsVerified': len(data['actual']), 'featureColumnsVerified': len(names['full']), 'monthlyStatesVerified': len(states), 'nativeModelsRefit': native, 'developmentPredictionRows': len(indices), 'all47GatesPerCandidateVerified': True, 'referenceParityVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'featuresSha256': expected['featuresSha256'], 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # keep verification evidence separate from immutable producer output
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# accept only an explicit private experiment root and evidence path
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
