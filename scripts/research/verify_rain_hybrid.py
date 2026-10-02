"""independently refit and replay one frozen rain-severity hybrid."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# pin native numerical threads before learner imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_hybrid import POLICY, SOURCE_FILES
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

PRIMARY = 'hybridSeasonal'
ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'rawSeasonal', 'weightedModerate90', 'weightedSeasonal', 'ordinalReference', 'hybrid90', PRIMARY)
SEASONS = ('DJF', 'MAM', 'JJA', 'SON')
THRESHOLDS = (.1, 1., 2.5)
HEADS = ('0.1', '1.0', '2.5')
HEAD_FILES = ('event-0.1.json', 'event-1.0.json', 'event-2.5.json')


# verify the exact producer source bytes retained before this experiment
def source_freeze(root, freeze, feature_names):
    require(freeze['policy'] == POLICY and freeze['featureNames'] == feature_names and freeze['inputSchemaFreezeSha256'] == hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest() and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'hybrid freeze changed')
    require(set(freeze['sourceSha256']) == set(SOURCE_FILES), 'hybrid producer source set changed')
    # compare both private snapshots and live source dependencies
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts and len(relative.parts) == 1, 'unsafe hybrid producer source')
        saved, live = root / 'hybrid-sources' / name, Path(__file__).with_name(name)
        require(saved.is_file() and live.is_file() and not saved.is_symlink(), f'missing hybrid source: {name}')
        require(hashlib.sha256(saved.read_bytes()).hexdigest() == expected and hashlib.sha256(live.read_bytes()).hexdigest() == expected, f'hybrid source changed: {name}')


# identify the valid-hour calendar season without target outcomes
def season_labels(hours):
    labels = []
    # preserve calendar mapping for december through february
    for valid in hours:
        month = dt.datetime.fromtimestamp(int(valid) * 3600, dt.timezone.utc).month
        labels.append(SEASONS[(month % 12) // 3])
    return np.asarray(labels)


# independently estimate shrunken seasonal ratios on training rows alone
def seasonal_state(actual, raw, hours, policy=POLICY):
    actual, raw, hours = np.asarray(actual, dtype=float), np.asarray(raw, dtype=float), np.asarray(hours)
    require(actual.ndim == 1 and actual.shape == raw.shape == hours.shape and np.issubdtype(hours.dtype, np.integer) and np.isfinite(actual).all() and np.isfinite(raw).all() and (actual >= 0).all() and (raw >= 0).all(), 'invalid hybrid seasonal training arrays')
    mass = weights(hours)
    observed, predicted = float(mass @ actual), float(mass @ raw)
    global_ratio = float(np.clip(observed / predicted, *policy['seasonRatioBounds'])) if observed > 0 and predicted > 0 else None
    state = {'trainingMaximumActualHour': int(hours.max()) if len(hours) else None, 'globalObservedMean': observed, 'globalRawMean': predicted, 'globalRatio': global_ratio, 'seasons': {}}
    labels = season_labels(hours)
    # require local support before fitting a relative seasonal multiplier
    for name in SEASONS:
        chosen = labels == name
        counts = support(actual[chosen], hours[chosen])
        counts['heavyHours'] = int(len(np.unique(hours[chosen & (actual >= 1)])))
        record = {'support': counts, 'factor': 1., 'ratio': None, 'shrinkWeight': 0., 'reason': 'insufficient_season_support'}
        if global_ratio is None:
            record['reason'] = 'unidentified_global_ratio'
        elif all(counts[key] >= minimum for key, minimum in policy['seasonSupport'].items()):
            local_mass = weights(hours[chosen])
            numerator, denominator = float(local_mass @ actual[chosen]), float(local_mass @ raw[chosen])
            if numerator > 0 and denominator > 0:
                ratio = float(np.clip(numerator / denominator, *policy['seasonRatioBounds']))
                shrink = counts['dates'] / (counts['dates'] + policy['seasonShrinkDates'])
                factor = float(np.clip(np.exp(shrink * np.log(ratio / global_ratio)), *policy['seasonFactorBounds']))
                record.update({'factor': factor, 'ratio': ratio, 'shrinkWeight': shrink, 'reason': 'estimated'})
            else:
                record['reason'] = 'unidentified_season_ratio'
        state['seasons'][name] = record
    return state


# apply frozen training-only seasonal factors to any later valid hours
def factors(hours, state):
    return np.asarray([state['seasons'][name]['factor'] for name in season_labels(hours)], dtype=float)


# remove the unused wet category from heavy-severity routing
def heavy_categories(raw, probabilities, rules):
    categories = ordinal_categories(raw, probabilities, rules)
    return np.where(categories >= 2, categories, 0).astype(np.int8)


# independently project ordinary, heavy and extreme amount intervals
def project(base, categories, seasonal, scalar):
    base, categories, seasonal = np.asarray(base, dtype=float), np.asarray(categories), np.asarray(seasonal, dtype=float)
    require(base.ndim == 1 and base.shape == categories.shape == seasonal.shape and np.isfinite(base).all() and np.isfinite(seasonal).all() and (base >= 0).all() and (seasonal > 0).all() and np.issubdtype(categories.dtype, np.integer) and np.isin(categories, (0, 2, 3)).all() and np.isfinite(scalar) and scalar > 0, 'invalid hybrid projected amount')
    output = np.zeros(len(base), dtype=float)
    scaled = base * seasonal * scalar
    # keep each severity class physically disjoint after calibration
    for category, lower, upper in ((0, 0., np.nextafter(1., 0.)), (2, 1., np.nextafter(2.5, 0.)), (3, 2.5, 30.)):
        selected = categories == category
        output[selected] = np.clip(scaled[selected], lower, upper)
    return output


# enforce composite heavy-threshold safety on prior calibration labels
def heavy_rules(actual, raw, probabilities, hours, proposed):
    categories = heavy_categories(raw, probabilities, proposed)
    projected = project(np.ones(len(raw)), categories, np.ones(len(raw)), 1.)
    candidate = score_events(actual, hours, {'hybrid': projected}, SEARCH_POLICY['thresholdsMmPerHour'])['hybrid']
    baseline = score_events(actual, hours, {'raw': raw}, SEARCH_POLICY['thresholdsMmPerHour'])['raw']
    safe = all((candidate[key]['pod'] or 0.) + 1e-12 >= (baseline[key]['pod'] or 0.) and (candidate[key]['far'] or 0.) <= (baseline[key]['far'] or 0.) + .05 + 1e-12 and (candidate[key]['csi'] or 0.) + 1e-12 >= (baseline[key]['csi'] or 0.) - .01 for key in ('1.0', '2.5'))
    # reset both heavy cutoffs rather than select a favorable subset
    if not safe:
        return [{**rule, 'cutoff': None, 'reason': 'heavy_nesting_safety_fallback'} if rule['threshold'] >= 1 else dict(rule) for rule in proposed], True
    return proposed, False


# fit the date-balanced moderate Tweedie model and match its native JSON
def refit_moderate(root, data, fit, calibration, evaluation, month, feature_names, policy=POLICY):
    target, hours = data['actual'][fit], data['hour'][fit]
    costs = policy['ordinaryWeights']
    cost = np.where(target >= 1, costs[2], np.where(target >= .1, costs[1], costs[0]))
    mass = weights(hours) * cost
    mass *= len(target) / mass.sum()
    parameters = {**policy['parameters'], 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(data['x'][fit], label=target, weight=mass, feature_names=feature_names, nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=policy['boostRounds'])
    path = root / 'hybrid-models' / month / 'moderate/amount.json'
    sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, sha, 'reg:tweedie', policy['boostRounds'], feature_names)
    forecasts = {}
    # compare both prior calibration and current evaluation predictions
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(data['x'][mask], feature_names=feature_names, nthread=1)
        learned = np.clip(booster.predict(matrix).astype(float), 0, 30)
        forecasts[name] = np.clip(policy['ordinaryRawBlend'] * data['raw'][mask] + (1 - policy['ordinaryRawBlend']) * learned, 0, 30)
    state = {'parameters': parameters, 'rainWeights': costs, 'modelSha256': sha}
    return forecasts, state


# refit every original classifier and wet-only reference amount head
def refit_ordinal(root, data, fit, calibration, evaluation, month, feature_names, policy=POLICY):
    directory = root / 'hybrid-models' / month / 'ordinal'
    actual, hours = data['actual'][fit], data['hour'][fit]
    models = {}
    state = {'featureNames': feature_names, 'rounds': policy['boostRounds'], 'heads': {}}
    # retain raw fallback on any missing high-threshold native head
    for threshold, name, filename in zip(THRESHOLDS, HEADS, HEAD_FILES):
        counts = head_support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': counts, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        if counts['positiveHours'] >= 10 and counts['positiveDates'] >= 3:
            matrix = xgb.DMatrix(data['x'][fit], label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=feature_names, nthread=1)
            booster = xgb.train({**policy['parameters'], 'objective': 'binary:logistic'}, matrix, num_boost_round=policy['boostRounds'])
            path = directory / filename
            sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            check_booster(booster, path, sha, 'binary:logistic', policy['boostRounds'], feature_names)
            head.update({'modelFile': filename, 'sha256': sha, 'reason': 'fitted'})
            models[name] = booster
        else:
            require(not (directory / filename).exists(), f'unexpected unsupported hybrid classifier: {month}:{name}')
        state['heads'][name] = head
    wet = actual >= .1
    counts = head_support(actual, hours, .1)
    amount = {'objective': 'reg:gamma', 'support': counts, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support'}
    require(counts['positiveHours'] >= 100 and counts['positiveDates'] >= 20, 'supported hybrid month lacks wet gamma support')
    matrix = xgb.DMatrix(data['x'][fit][wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=feature_names, nthread=1)
    booster = xgb.train({**policy['parameters'], 'objective': 'reg:gamma'}, matrix, num_boost_round=policy['boostRounds'])
    path = directory / 'amount.json'
    sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, sha, 'reg:gamma', policy['boostRounds'], feature_names)
    amount.update({'modelFile': 'amount.json', 'sha256': sha, 'reason': 'fitted'})
    models['amount'] = booster
    state['heads']['amount'] = amount

    # calculate every head on both later partitions without labels
    def predict(mask):
        matrix = xgb.DMatrix(data['x'][mask], feature_names=feature_names, nthread=1)
        probabilities = np.full((int(mask.sum()), 3), np.nan)
        for index, name in enumerate(HEADS):
            if models[name] is not None:
                probabilities[:, index] = np.clip(models[name].predict(matrix), 0, 1)
        positive = np.clip(models['amount'].predict(matrix), .1, 30).astype(float)
        return probabilities, positive

    probability_cal, amount_cal = predict(calibration)
    probability_eval, amount_eval = predict(evaluation)
    return (probability_cal, amount_cal), (probability_eval, amount_eval), state


# fit a separate positive gamma objective on historical heavy target hours
def refit_heavy(root, data, fit, calibration, evaluation, month, feature_names, policy=POLICY):
    selected = fit & (data['actual'] >= policy['heavyTrainingThreshold'])
    count = int(selected.sum())
    hours = data['hour'][selected]
    counts = {'rows': count, 'hours': int(len(np.unique(hours))), 'dates': int(len(np.unique(hours // 24)))}
    state = {'support': counts, 'modelSha256': None, 'reason': 'insufficient_heavy_training_support'}
    path = root / 'hybrid-models' / month / 'heavy.json'
    # reject an unsupported native file rather than treating it as inert
    if not all(counts[key] >= minimum for key, minimum in policy['heavyTrainingSupport'].items()):
        require(not path.exists(), f'unexpected unsupported heavy model: {month}')
        return None, state
    matrix = xgb.DMatrix(data['x'][selected], label=data['actual'][selected], weight=weights(hours) * count, feature_names=feature_names, nthread=1)
    booster = xgb.train({**policy['parameters'], 'objective': 'reg:gamma'}, matrix, num_boost_round=policy['boostRounds'])
    sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, sha, 'reg:gamma', policy['boostRounds'], feature_names)
    estimates = {}
    # compare prior and target-month heavy estimates from the same model
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(data['x'][mask], feature_names=feature_names, nthread=1)
        estimates[name] = np.clip(booster.predict(matrix).astype(float), 1, 30)
    state.update({'modelSha256': sha, 'reason': 'fitted'})
    return estimates, state


# combine the ordinary and heavy estimates using forecast-only categories
def routed_base(raw, ordinary, heavy, categories):
    heavy_base = np.clip(.5 * raw + .5 * heavy, 0, 30)
    return np.where(categories >= 2, heavy_base, ordinary)


# replay one fixed month with all matched controls and refitted native heads
def replay_month(root, data, month, old_policy, feature_names, policy=POLICY):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(data['actual'][calibration], data['hour'][calibration])}
    raw_cal, raw_eval = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    actual_cal, hour_cal = data['actual'][calibration], data['hour'][calibration]
    seasonal = seasonal_state(data['actual'][fit], data['raw'][fit], data['hour'][fit], policy)
    fc, fe = factors(hour_cal, seasonal), factors(data['hour'][evaluation], seasonal)
    raw_scalar = calibrate(actual_cal, hour_cal, lambda scale: np.clip(raw_cal * scale, 0, 30), SEARCH_POLICY)
    raw_seasonal_scalar = calibrate(actual_cal, hour_cal, lambda scale: np.clip(raw_cal * fc * scale, 0, 30), SEARCH_POLICY)
    old_fit, old_cal, old_eval, _ = old_month_masks(data, month, old_policy)
    require(np.array_equal(old_eval, evaluation) and int(old_fit.sum()) > 0, f'inherited hybrid evaluation window changed: {month}')
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    old_scalar = old_calibrated_scale(data['actual'][old_cal], data['raw'][old_cal], data['hour'][old_cal])
    require(old_state['policy'] == old_policy and old_state['featureNames'] == feature_names and old_state['month'] == month and old_state['calibrationRows'] == int(old_cal.sum()) and np.isclose(old_scalar, old_state['scales']['raw'], rtol=0, atol=1e-9), f'inherited hybrid raw scale changed: {month}')
    persistence = data['persistence'][evaluation]
    output = {'raw': raw_eval, 'zero': np.zeros_like(raw_eval), 'persistence': np.where(np.isfinite(persistence), persistence, raw_eval), 'volumeScale': raw_eval * old_scalar, 'volume90': np.clip(raw_eval * raw_scalar['scale'], 0, 30), 'rawSeasonal': np.clip(raw_eval * fe * raw_seasonal_scalar['scale'], 0, 30)}
    routed = np.zeros(len(raw_eval), dtype=bool)
    state = {**bounds, 'support': counts, 'seasonalState': seasonal, 'rawCalibration': raw_scalar, 'rawSeasonalCalibration': raw_seasonal_scalar, 'supported': False, 'reason': 'insufficient_training_or_calibration_support', 'models': {}, 'calibrations': {}}
    directory = root / 'hybrid-models' / month
    require(directory.is_dir() and (directory / 'state.json').is_file(), f'missing hybrid monthly state: {month}')
    require(xgb.__version__ == policy['xgboostVersion'], 'hybrid native runtime changed')
    # unsupported global training or calibration makes every learned arm raw
    available = all(counts['training'][key] >= value for key, value in policy['trainingSupport'].items()) and all(counts['calibration'][key] >= value for key, value in policy['calibrationSupport'].items())
    if not available:
        output.update({name: raw_eval.copy() for name in ARMS if name not in output})
        require(not any((directory / name).exists() for name in ('moderate', 'ordinal', 'heavy.json')), f'unexpected unsupported hybrid model: {month}')
    else:
        ordinary, state['models']['moderate'] = refit_moderate(root, data, fit, calibration, evaluation, month, feature_names, policy)
        (pc, ac), (pe, ae), state['models']['ordinal'] = refit_ordinal(root, data, fit, calibration, evaluation, month, feature_names, policy)
        proposed = ordinal_rules(actual_cal, raw_cal, pc, hour_cal, SEARCH_POLICY)
        reference_rules, reference_fallback = checked_rules(actual_cal, raw_cal, pc, hour_cal, proposed, SEARCH_POLICY)
        rules, fallback = heavy_rules(actual_cal, raw_cal, pc, hour_cal, proposed)
        cc, ce = heavy_categories(raw_cal, pc, rules), heavy_categories(raw_eval, pe, rules)
        state.update({'proposedRules': proposed, 'referenceRules': reference_rules, 'referenceNestingFallback': reference_fallback, 'heavyRules': rules, 'heavyNestingFallback': fallback})
        reference_cc, reference_ce = ordinal_categories(raw_cal, pc, reference_rules), ordinal_categories(raw_eval, pe, reference_rules)
        reference_cal = calibrate(actual_cal, hour_cal, lambda scale: ordinal_project(np.clip(.25 * raw_cal + .75 * ac, 0, 30), reference_cc, scale), SEARCH_POLICY)
        output['ordinalReference'] = ordinal_project(np.clip(.25 * raw_eval + .75 * ae, 0, 30), reference_ce, reference_cal['scale'])
        moderate_cal = calibrate(actual_cal, hour_cal, lambda scale: np.clip(ordinary['calibration'] * scale, 0, 30), SEARCH_POLICY)
        seasonal_cal = calibrate(actual_cal, hour_cal, lambda scale: np.clip(ordinary['calibration'] * fc * scale, 0, 30), SEARCH_POLICY)
        output['weightedModerate90'] = np.clip(ordinary['evaluation'] * moderate_cal['scale'], 0, 30)
        output['weightedSeasonal'] = np.clip(ordinary['evaluation'] * fe * seasonal_cal['scale'], 0, 30)
        state['calibrations'].update({'ordinalReference': reference_cal, 'weightedModerate90': moderate_cal, 'weightedSeasonal': seasonal_cal})
        heavy, state['models']['heavy'] = refit_heavy(root, data, fit, calibration, evaluation, month, feature_names, policy)
        state['reason'] = 'insufficient_heavy_training_support'
        # support-match the seasonal ablation when the new heavy head is absent
        if heavy is None:
            output.update({'hybrid90': raw_eval.copy(), PRIMARY: raw_eval.copy(), 'weightedSeasonal': raw_eval.copy()})
        else:
            base_cal = routed_base(raw_cal, ordinary['calibration'], heavy['calibration'], cc)
            base_eval = routed_base(raw_eval, ordinary['evaluation'], heavy['evaluation'], ce)
            routed = (ce >= 2) & (base_eval != ordinary['evaluation'])
            # calibrate primary and no-season ablation on their own final bands
            for name, cal_factors, eval_factors in (('hybrid90', np.ones(len(fc)), np.ones(len(fe))), (PRIMARY, fc, fe)):
                scalar = calibrate(actual_cal, hour_cal, lambda scale: project(base_cal, cc, cal_factors, scale), SEARCH_POLICY)
                output[name] = project(base_eval, ce, eval_factors, scalar['scale'])
                state['calibrations'][name] = scalar
            state.update({'supported': True, 'reason': 'fitted_and_calibrated', 'calibrationHeavyCalls': int((cc >= 2).sum()), 'evaluationHeavyCalls': int((ce >= 2).sum())})
    state['evaluationEffectiveHeavyRows'] = int(routed.sum())
    same_tree(state, json.loads((directory / 'state.json').read_text()), f'monthlyStates.{month}')
    return np.where(evaluation)[0], output, state, routed


# replay all fixed consumed months without promoting ablations
def replay_all(root, data, old_policy, feature_names):
    months = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
    require(POLICY['developmentMonths'] == months and old_policy['holdoutMonths'] == months, 'hybrid development months changed')
    indices = []
    amounts = {name: [] for name in ARMS}
    supported, heavy_route, states = [], [], {}
    # reconstruct every declared month and same-row baseline
    for month in months:
        rows, predictions, state, routed = replay_month(root, data, month, old_policy, feature_names)
        indices.append(rows)
        supported.append(np.full(len(rows), state['supported'], dtype=bool))
        heavy_route.append(routed)
        states[month] = state
        for name in ARMS:
            amounts[name].append(predictions[name])
    indices, supported, heavy_route = np.concatenate(indices), np.concatenate(supported), np.concatenate(heavy_route)
    require(len(indices) == POLICY['expectedEvaluationRows'] == 32896 and len(np.unique(indices)) == len(indices), 'hybrid evaluation population changed')
    return indices, {name: np.concatenate(parts) for name, parts in amounts.items()}, supported, heavy_route, states


# enforce the unchanged 44 gates plus matched controls and mechanism value
def primary_gates(report):
    require(POLICY['screen'] == RESIDUAL_POLICY['screen'] and POLICY['candidateSupport'] == RESIDUAL_POLICY['candidateSupport'] and POLICY['primary'] == PRIMARY and POLICY['ablations'] == ['hybrid90', 'weightedSeasonal'], 'hybrid gate contract changed')
    # rename only the fixed primary key at the existing independent evaluator
    def alias(value):
        if isinstance(value, dict):
            return {('residualAmount' if key == PRIMARY else key): alias(item) for key, item in value.items()}
        if isinstance(value, list):
            return [alias(item) for item in value]
        return value

    inherited = residual_gates(alias(report), RESIDUAL_POLICY)
    require(len(inherited) == 44, 'inherited hybrid gate count changed')
    inherited['beatsSameWindowVolumeScale'] = report['overall'][PRIMARY]['mae'] <= report['overall']['volume90']['mae']
    inherited['beatsMatchedSeasonalRaw'] = report['overall'][PRIMARY]['mae'] <= report['overall']['rawSeasonal']['mae']
    inherited['hybridAddedValue'] = report['mechanismSupport']['dates'] >= POLICY['minimumHeavyRouteDates'] and all(report['overall'][PRIMARY]['mae'] < report['overall'][name]['mae'] - POLICY['ablationMaeMargin'] for name in POLICY['ablations'])
    require(len(inherited) == 47, 'hybrid gate count changed')
    return inherited


# recompute all partitions, event thresholds, gates and ablation deltas
def expected_report(root, freeze, data, old_policy, indices, amounts, supported, routed, states):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'hybrid-freeze.json').read_bytes()).hexdigest(), 'overall': {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}, 'monthlyStates': states, 'support': support(actual[supported], hours[supported]), 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report['mechanismSupport'] = support(actual[routed], hours[routed])
    report.update(score_groups(data, indices, amounts, old_policy))
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}
    report['events'] = score_events(actual, hours, amounts, SEARCH_POLICY['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, amounts)
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in amounts.values()))}
    report['gates'] = primary_gates(report)
    report['failedGates'] = [name for name, passed in report['gates'].items() if not passed]
    report['developmentPassed'] = all(report['gates'].values())
    report['selectedCandidate'] = PRIMARY if report['developmentPassed'] else None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'reject_primary_no_posthoc_ablation_promotion'
    report['ablationDeltas'] = {name: {metric: report['overall'][PRIMARY][metric] - report['overall'][name][metric] for metric in ('mae', 'wetMae', 'heavyMae', 'volumeRatio')} for name in POLICY['ablations']}
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# refit native boosters then compare the full retained result byte lineage
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, feature_names, data = load_inputs(root)
    freeze = json.loads((root / 'hybrid-freeze.json').read_text())
    require(old_freeze['featureNames'] == feature_names and POLICY['primary'] == PRIMARY and POLICY['ordinaryWeights'] == [1., 2., 4.] and POLICY['ordinaryRawBlend'] == .25 and POLICY['heavyRawBlend'] == .5 and POLICY['heavyTrainingThreshold'] == 1. and POLICY['heavyTrainingSupport'] == {'hours': 50, 'dates': 10} and POLICY['heavyObjective'] == 'reg:gamma', 'hybrid model scope changed')
    require(POLICY['calibrationDays'] == SEARCH_POLICY['calibrationDays'] == 90 and POLICY['embargoDays'] == SEARCH_POLICY['embargoDays'] == 7 and POLICY['calibrationScaleBounds'] == SEARCH_POLICY['calibrationScaleBounds'] == [.1, 3.] and POLICY['seasonSupport'] == {'dates': 30, 'wetDates': 10, 'heavyHours': 5} and POLICY['seasonShrinkDates'] == 60 and POLICY['seasonFactorBounds'] == [.5, 2.] and POLICY['seasonRatioBounds'] == [.1, 3.] and POLICY['minimumHeavyRouteDates'] == 20 and POLICY['ablationMaeMargin'] == 1e-12, 'hybrid seasonal or safety policy changed')
    source_freeze(root, freeze, feature_names)
    indices, amounts, supported, routed, states = replay_all(root, data, old_policy, feature_names)
    # compare all eight controls and the primary on the exact month rows
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices', 'supported', 'heavyRoute'} | {f'amount::{name}' for name in ARMS}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices) and archive['supported'].dtype == np.dtype(bool) and np.array_equal(archive['supported'], supported) and archive['heavyRoute'].dtype == np.dtype(bool) and np.array_equal(archive['heavyRoute'], routed), 'hybrid prediction population or support changed')
    for name, expected in amounts.items():
        retained = archive[f'amount::{name}']
        require(retained.shape == expected.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, expected, rtol=1e-8, atol=1e-9), f'hybrid prediction replay changed: {name}')
    report_path = root / 'report.json'
    expected = expected_report(root, freeze, data, old_policy, indices, amounts, supported, routed, states)
    same_tree(expected, json.loads(report_path.read_text()))
    models = sum(int(state['models'].get('moderate') is not None) + sum(head['sha256'] is not None for head in state['models'].get('ordinal', {}).get('heads', {}).values()) + int(state['models'].get('heavy', {}).get('modelSha256') is not None) for state in states.values())
    receipt = {'contractVersion': 'rain-hybrid-independent-verification/v1', 'verified': True, 'monthlyStatesVerified': len(states), 'nativeModelsRefit': models, 'developmentPredictionRows': len(indices), 'supportedPredictionRows': int(supported.sum()), 'effectiveHeavyRouteRows': int(routed.sum()), 'all47GatesVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # keep independent receipt outside frozen producer output
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# require explicit private experiment and evidence paths
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
