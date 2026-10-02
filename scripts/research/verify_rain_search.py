"""independently refit and replay the frozen rain development search."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# pin native reduction threads before loading numerical libraries
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_search import POLICY, SOURCE_FILES
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
from verify_rain_sub24_model import metrics, require, weights

ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'ordinalAmount', 'weightedModerate', 'weightedStrong')
THRESHOLDS = (.1, 1., 2.5)
HEADS = ('0.1', '1.0', '2.5')
HEAD_FILES = ('event-0.1.json', 'event-1.0.json', 'event-2.5.json')


# derive the search chronology independently of the model runner
def month_masks(data, month, old_policy, policy):
    beginning = dt.datetime.fromisoformat(month + '-01T00:00:00+00:00')
    following = (beginning.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    first, stop = int(beginning.timestamp() // 3600), int(following.timestamp() // 3600)
    calibration_stop = first - policy['embargoDays'] * 24
    calibration_start = calibration_stop - policy['calibrationDays'] * 24
    fit_stop = calibration_start - policy['embargoDays'] * 24
    training_start = int(dt.datetime.fromisoformat(old_policy['trainingStartUtc'].replace('Z', '+00:00')).timestamp() // 3600)
    fit = (data['hour'] >= training_start) & (data['hour'] < fit_stop)
    calibration = (data['hour'] >= calibration_start) & (data['hour'] < calibration_stop)
    decision = data['initialized'] + old_policy['decisionDelayHours']
    evaluation = (decision >= first) & (decision < stop)
    bounds = {'month': month, 'trainingMaximumValidHourExclusive': fit_stop, 'calibrationStartHour': calibration_start, 'calibrationMaximumValidHourExclusive': calibration_stop, 'decisionStartHour': first, 'decisionStopHourExclusive': stop}
    return fit, calibration, evaluation, bounds


# count distinct valid hours and dates without vintage inflation
def support(actual, hours):
    wet = actual >= .1
    return {'rows': len(hours), 'dates': len(np.unique(hours // 24)), 'hours': len(np.unique(hours)), 'wetDates': len(np.unique(hours[wet] // 24)), 'wetHours': len(np.unique(hours[wet]))}


# apply all frozen support minima on distinct-source counts
def has_support(counts, minimum):
    return all(counts[name] >= value for name, value in minimum.items())


# verify every current and copied producer dependency against the pre-outcome freeze
def source_freeze(root, freeze):
    require(set(freeze['sourceSha256']) == set(SOURCE_FILES), 'search source set changed')
    # inspect both retained and live implementation bytes
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts and len(relative.parts) == 1, 'unsafe search source name')
        saved, live = root / 'search-sources' / relative, Path(__file__).with_name(name)
        require(saved.is_file() and live.is_file() and not saved.is_symlink(), f'missing frozen search source: {name}')
        require(hashlib.sha256(saved.read_bytes()).hexdigest() == expected and hashlib.sha256(live.read_bytes()).hexdigest() == expected, f'search source changed: {name}')


# solve a monotone, clipped final-output mean with explicit saturated endpoints
def calibrate(actual, hours, projection, policy=POLICY):
    actual, hours = np.asarray(actual, dtype=float), np.asarray(hours)
    require(actual.ndim == 1 and actual.shape == hours.shape and len(actual) and np.isfinite(actual).all() and (actual >= 0).all(), 'invalid search calibration target')
    weight = weights(hours)
    target = float(weight @ actual)
    lower, upper = policy['calibrationScaleBounds']
    tolerance = policy['calibrationTolerance']['absolute'] + policy['calibrationTolerance']['relative'] * abs(target)

    # reject malformed projections before they enter the scalar search
    def mean(scale):
        predicted = np.asarray(projection(scale))
        require(predicted.shape == actual.shape and np.isfinite(predicted).all() and (predicted >= 0).all(), 'invalid search calibration projection')
        return float(weight @ predicted)

    low_mean, high_mean = mean(lower), mean(upper)
    require(low_mean <= high_mean + tolerance, 'nonmonotone search calibration curve')
    # return the nearest reachable endpoint without claiming exact calibration
    if target < low_mean:
        solution, status = lower, 'saturated_low'
    elif target > high_mean:
        solution, status = upper, 'saturated_high'
    elif abs(mean(1.) - target) <= tolerance:
        solution, status = 1., 'matched'
    else:
        # retain a bracketed solution on the projected amount curve
        for _ in range(policy['calibrationIterations']):
            middle = (lower + upper) / 2
            if mean(middle) < target:
                lower = middle
            else:
                upper = middle
        solution = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
        status = 'matched' if abs(mean(solution) - target) <= tolerance else 'unmatched_numeric'
    achieved = mean(solution)
    return {'scale': solution, 'status': status, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'achievedMean': achieved, 'residual': achieved - target, 'tolerance': tolerance}


# count positive hours and dates for one ordered event definition
def head_support(actual, hours, threshold):
    positive = actual >= threshold
    unique = np.unique(hours[positive])
    return {'rows': len(actual), 'positiveRows': int(positive.sum()), 'positiveHours': len(unique), 'positiveDates': len(np.unique(unique // 24))}


# calculate calibration-only event skill without borrowing evaluation outcomes
def event_metrics(observed, called, weight):
    hit = float(weight @ (observed & called))
    miss = float(weight @ (observed & ~called))
    false = float(weight @ (~observed & called))
    return {'pod': 0. if hit + miss == 0 else hit / (hit + miss), 'far': 0. if hit + false == 0 else false / (hit + false), 'csi': 0. if hit + miss + false == 0 else hit / (hit + miss + false)}


# independently select largest prior-label cutoffs that meet each recall target
def ordinal_rules(actual, raw, probability, hours, policy=POLICY):
    require(probability.shape == (len(actual), 3) and raw.shape == actual.shape == hours.shape, 'invalid ordinal calibration population')
    limits = policy['ordinalThresholdPolicy']
    mass = weights(hours)
    rules = []
    # preserve one independent decision per physical event threshold
    for index, (threshold, name) in enumerate(zip(THRESHOLDS, HEADS)):
        observed = actual >= threshold
        raw_event = event_metrics(observed, raw >= threshold, mass)
        counts = head_support(actual, hours, threshold)
        rule = {'threshold': threshold, 'head': name, 'cutoff': None, 'reason': 'insufficient_calibration_support', 'support': counts, 'raw': raw_event, 'candidate': None, 'targetRecall': None}
        scores = probability[:, index]
        # use raw calls if prior positive support is inadequate
        if counts['positiveHours'] >= limits['minimumCalibrationPositiveHours'][index] and counts['positiveDates'] >= limits['minimumCalibrationPositiveDates']:
            # a missing native head must be explicit rather than inferred dry
            if np.isnan(scores).all():
                rule['reason'] = 'missing_model_head'
            else:
                require(np.isfinite(scores).all() and ((0 <= scores) & (scores <= 1)).all(), 'invalid ordinal probability')
                target = min(1., raw_event['pod'] + limits['recallMargin'])
                rule['targetRecall'] = target
                cutoff = None
                # positive-score ties are kept together at each candidate threshold
                for score in np.unique(scores[observed])[::-1]:
                    candidate = event_metrics(observed, scores >= score, mass)
                    if candidate['pod'] + 1e-12 >= target:
                        cutoff = float(score)
                        rule['candidate'] = candidate
                        break
                # keep precision and event skill within the frozen tolerances
                if cutoff is not None and rule['candidate']['far'] <= raw_event['far'] + limits['maximumFarDelta'] + 1e-12 and rule['candidate']['csi'] + 1e-12 >= raw_event['csi'] + limits['minimumCsiDelta']:
                    rule.update({'cutoff': cutoff, 'reason': 'calibrated'})
                else:
                    rule['reason'] = 'calibration_safety_regression'
        rules.append(rule)
    return rules


# resolve nonnested heads by their highest forecast event category
def ordinal_categories(raw, probability, rules):
    require(probability.shape == (len(raw), 3) and len(rules) == 3 and np.isfinite(raw).all() and (raw >= 0).all(), 'invalid ordinal event arrays')
    category = np.zeros(len(raw), dtype=np.int8)
    # update ordered categories with calibrated calls or raw fallback
    for index, (threshold, rule) in enumerate(zip(THRESHOLDS, rules)):
        require(rule['threshold'] == threshold, 'ordinal threshold order changed')
        cutoff = rule['cutoff']
        if cutoff is None:
            called = raw >= threshold
        else:
            scores = probability[:, index]
            require(np.isfinite(scores).all() and ((0 <= scores) & (scores <= 1)).all(), 'invalid ordinal event probabilities')
            called = scores >= cutoff
        category[called] = index + 1
    return category


# enforce exact dry zero and disjoint event amount intervals
def ordinal_project(base, categories, scale):
    require(base.ndim == 1 and categories.shape == base.shape and np.isfinite(base).all() and (base >= 0).all() and np.isfinite(scale) and scale > 0, 'invalid ordinal projection')
    result = np.zeros(len(base), dtype=float)
    # clip scaled base within each highest called amount band
    for category, lower, upper in ((1, .1, np.nextafter(1., 0.)), (2, 1., np.nextafter(2.5, 0.)), (3, 2.5, 30.)):
        selected = categories == category
        result[selected] = np.clip(scale * base[selected], lower, upper)
    require(np.isin(categories, (0, 1, 2, 3)).all(), 'unknown ordinal category')
    return result


# reject unsafe nested event calls before final amount calibration
def checked_rules(actual, raw, probability, hours, proposed, policy=POLICY):
    categories = ordinal_categories(raw, probability, proposed)
    projected = ordinal_project(np.ones(len(raw)), categories, 1.)
    candidate = score_events(actual, hours, {'candidate': projected}, policy['thresholdsMmPerHour'])['candidate']
    baseline = score_events(actual, hours, {'raw': raw}, policy['thresholdsMmPerHour'])['raw']
    safe = all((candidate[key]['pod'] or 0.) + 1e-12 >= (baseline[key]['pod'] or 0.) and (candidate[key]['far'] or 0.) <= (baseline[key]['far'] or 0.) + policy['ordinalThresholdPolicy']['maximumFarDelta'] + 1e-12 and (candidate[key]['csi'] or 0.) + 1e-12 >= (baseline[key]['csi'] or 0.) + policy['ordinalThresholdPolicy']['minimumCsiDelta'] for key in baseline)
    # restore raw threshold calls wholesale rather than selecting safe heads post hoc
    if not safe:
        return [{**rule, 'cutoff': None, 'reason': 'nesting_safety_fallback'} for rule in proposed], True
    return proposed, False


# prove a refitted native booster matches the retained model bytes and schema
def check_booster(booster, path, sha, objective, rounds, feature_names):
    require(path.is_file() and not path.is_symlink(), f'missing native rain model: {path.name}')
    calculated = hashlib.sha256(path.read_bytes()).hexdigest()
    require(calculated == sha and hashlib.sha256(booster.save_raw(raw_format='json')).hexdigest() == sha, f'deterministic rain model refit changed: {path}')
    config = json.loads(booster.save_config())
    require(booster.feature_names == feature_names and booster.num_boosted_rounds() == rounds and config['learner']['objective']['name'] == objective, f'native rain model objective or schema changed: {path}')


# refit one cost-weighted direct amount model and score its earlier calibration
def refit_weighted(root, data, fit, calibration, evaluation, month, name, policy, feature_names):
    costs = policy['candidates'][name]['rainWeights']
    target, hours = data['actual'][fit], data['hour'][fit]
    cost = np.where(target >= 1, costs[2], np.where(target >= .1, costs[1], costs[0]))
    mass = weights(hours) * cost
    mass *= len(target) / mass.sum()
    parameters = {**policy['parameters'], 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(data['x'][fit], label=target, weight=mass, feature_names=feature_names, nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=policy['boostRounds'])
    path = root / 'search-models' / month / name / 'amount.json'
    model_sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    check_booster(booster, path, model_sha, 'reg:tweedie', policy['boostRounds'], feature_names)
    outputs = {}
    # independently predict both chronological populations
    for label, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(data['x'][mask], feature_names=feature_names, nthread=1)
        learned = np.clip(booster.predict(matrix).astype(float), 0, policy['maximumRainMmPerHour'])
        outputs[label] = np.clip(policy['rawBlend'] * data['raw'][mask] + (1 - policy['rawBlend']) * learned, 0, policy['maximumRainMmPerHour'])
    scalar = calibrate(data['actual'][calibration], data['hour'][calibration], lambda scale: np.clip(outputs['calibration'] * scale, 0, 30), policy)
    predicted = np.clip(outputs['evaluation'] * scalar['scale'], 0, 30)
    state = {'supported': True, 'model': {'parameters': parameters, 'rainWeights': costs, 'modelSha256': model_sha}, 'calibration': scalar}
    return predicted, state


# refit the three binary heads plus the wet-only gamma amount head
def refit_ordinal(root, data, fit, calibration, evaluation, month, policy, feature_names):
    directory = root / 'search-models' / month / 'ordinalAmount'
    actual, hours, features = data['actual'][fit], data['hour'][fit], data['x'][fit]
    models = {}
    state = {'featureNames': feature_names, 'rounds': policy['boostRounds'], 'heads': {}}
    # retain explicit raw fallback for thresholds without training support
    for threshold, name, filename in zip(THRESHOLDS, HEADS, HEAD_FILES):
        counts = head_support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': counts, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        if counts['positiveHours'] >= 10 and counts['positiveDates'] >= 3:
            matrix = xgb.DMatrix(features, label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=feature_names, nthread=1)
            booster = xgb.train({**policy['parameters'], 'objective': 'binary:logistic'}, matrix, num_boost_round=policy['boostRounds'])
            path = directory / filename
            sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            check_booster(booster, path, sha, 'binary:logistic', policy['boostRounds'], feature_names)
            head.update({'modelFile': filename, 'sha256': sha, 'reason': 'fitted'})
            models[name] = booster
        else:
            require(not (directory / filename).exists(), f'unexpected unsupported ordinal head: {month}:{name}')
        state['heads'][name] = head
    wet = actual >= THRESHOLDS[0]
    counts = head_support(actual, hours, THRESHOLDS[0])
    amount = {'objective': 'reg:gamma', 'support': counts, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support'}
    models['amount'] = None
    # never fit gamma on zeros or substitute nonexistent wet labels
    if counts['positiveHours'] >= 100 and counts['positiveDates'] >= 20:
        matrix = xgb.DMatrix(features[wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=feature_names, nthread=1)
        booster = xgb.train({**policy['parameters'], 'objective': 'reg:gamma'}, matrix, num_boost_round=policy['boostRounds'])
        path = directory / 'amount.json'
        sha = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        check_booster(booster, path, sha, 'reg:gamma', policy['boostRounds'], feature_names)
        amount.update({'modelFile': 'amount.json', 'sha256': sha, 'reason': 'fitted'})
        models['amount'] = booster
    else:
        require(not (directory / 'amount.json').exists(), f'unexpected unsupported ordinal amount: {month}')
    state['heads']['amount'] = amount

    # predict native probabilities and conditional amounts without using labels
    def forecast(mask):
        rows = int(mask.sum())
        probability = np.full((rows, 3), np.nan, dtype=float)
        wet_amount = np.full(rows, np.nan, dtype=float)
        if rows:
            matrix = xgb.DMatrix(data['x'][mask], feature_names=feature_names, nthread=1)
            for index, name in enumerate(HEADS):
                if models[name] is not None:
                    probability[:, index] = np.clip(models[name].predict(matrix), 0, 1)
            if models['amount'] is not None:
                wet_amount[:] = np.clip(models['amount'].predict(matrix), .1, 30)
        return probability, wet_amount

    probability_cal, amount_cal = forecast(calibration)
    probability_eval, amount_eval = forecast(evaluation)
    raw_cal, raw_eval = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    require(np.isfinite(amount_cal).all() and np.isfinite(amount_eval).all(), 'ordinal amount model missing on supported month')
    proposed = ordinal_rules(data['actual'][calibration], raw_cal, probability_cal, data['hour'][calibration], policy)
    rules, nesting_fallback = checked_rules(data['actual'][calibration], raw_cal, probability_cal, data['hour'][calibration], proposed, policy)
    categories_cal = ordinal_categories(raw_cal, probability_cal, rules)
    categories_eval = ordinal_categories(raw_eval, probability_eval, rules)
    base_cal = np.clip(policy['rawBlend'] * raw_cal + (1 - policy['rawBlend']) * amount_cal, 0, 30)
    base_eval = np.clip(policy['rawBlend'] * raw_eval + (1 - policy['rawBlend']) * amount_eval, 0, 30)
    scalar = calibrate(data['actual'][calibration], data['hour'][calibration], lambda scale: ordinal_project(base_cal, categories_cal, scale), policy)
    calibrated = ordinal_project(base_cal, categories_cal, scalar['scale'])
    prediction = ordinal_project(base_eval, categories_eval, scalar['scale'])
    events = score_events(data['actual'][calibration], data['hour'][calibration], {'ordinalAmount': calibrated}, policy['thresholdsMmPerHour'])['ordinalAmount']
    result = {'supported': True, 'model': state, 'proposedRules': proposed, 'rules': rules, 'nestingSafetyFallback': nesting_fallback, 'calibration': scalar, 'compositeCalibrationEvents': events}
    return prediction, result


# reproduce one monthly state without calling producer transformations
def replay_month(root, data, month, old_policy, policy, feature_names):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, policy)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(data['actual'][calibration], data['hour'][calibration])}
    old_fit, old_calibration, old_eval, old_bounds = old_month_masks(data, month, old_policy)
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    # confirm the inherited scalar came from the original 45-day window
    require(old_state['policy'] == old_policy and old_state['featureNames'] == feature_names and old_state['month'] == month and old_state['calibrationRows'] == int(old_calibration.sum()), f'inherited month state changed: {month}')
    require(np.array_equal(old_eval, evaluation) and old_bounds['calibrationStartHour'] != bounds['calibrationStartHour'] and int(old_fit.sum()) > 0, f'old and new monthly windows conflated: {month}')
    old_scale = old_calibrated_scale(data['actual'][old_calibration], data['raw'][old_calibration], data['hour'][old_calibration])
    require(np.isclose(old_scale, old_state['scales']['raw'], rtol=0, atol=1e-9), f'inherited raw baseline scalar changed: {month}')
    raw, recent = data['raw'][evaluation].astype(float), data['persistence'][evaluation]
    outputs = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_scale}
    raw_cal = data['raw'][calibration].astype(float)
    raw_scalar = calibrate(data['actual'][calibration], data['hour'][calibration], lambda scale: np.clip(scale * raw_cal, 0, 30), policy)
    outputs['volume90'] = np.clip(raw * raw_scalar['scale'], 0, 30)
    state = {**bounds, 'support': counts, 'rawCalibration': raw_scalar, 'candidates': {}}
    available = has_support(counts['training'], policy['trainingSupport']) and has_support(counts['calibration'], policy['calibrationSupport'])
    directory = root / 'search-models' / month
    require(directory.is_dir() and (directory / 'state.json').is_file(), f'missing search month state: {month}')
    require(xgb.__version__ == policy['xgboostVersion'], 'search native runtime changed')
    # unsupported months must stay exact raw for all three arms
    if not available:
        for name in policy['candidates']:
            outputs[name] = raw.copy()
            state['candidates'][name] = {'supported': False, 'reason': 'insufficient_training_or_calibration_support'}
            require(not (directory / name).exists(), f'unexpected unsupported search model: {month}:{name}')
    else:
        for name in ('weightedModerate', 'weightedStrong'):
            outputs[name], state['candidates'][name] = refit_weighted(root, data, fit, calibration, evaluation, month, name, policy, feature_names)
        outputs['ordinalAmount'], state['candidates']['ordinalAmount'] = refit_ordinal(root, data, fit, calibration, evaluation, month, policy, feature_names)
    same_tree(state, json.loads((directory / 'state.json').read_text()), f'monthlyStates.{month}')
    return np.where(evaluation)[0], outputs, state


# concatenate every predetermined monthly replay without favorable filtering
def replay_all(root, data, old_policy, policy, feature_names):
    months = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
    require(policy['developmentMonths'] == months and old_policy['holdoutMonths'] == months, 'search development window changed')
    indices = []
    outputs = {name: [] for name in ARMS}
    flags = {name: [] for name in policy['candidates']}
    states = {}
    # rebuild all 12 chronological states before examining aggregate metrics
    for month in months:
        rows, predictions, state = replay_month(root, data, month, old_policy, policy, feature_names)
        indices.append(rows)
        states[month] = state
        for name in ARMS:
            outputs[name].append(predictions[name])
        for name in policy['candidates']:
            flags[name].append(np.full(len(rows), state['candidates'][name]['supported'], dtype=bool))
    return np.concatenate(indices), {name: np.concatenate(parts) for name, parts in outputs.items()}, {name: np.concatenate(parts) for name, parts in flags.items()}, states


# rename one candidate only for the preexisting independent 44-gate evaluator
def alias(value, name):
    if isinstance(value, dict):
        return {('residualAmount' if key == name else key): alias(item, name) for key, item in value.items()}
    if isinstance(value, list):
        return [alias(item, name) for item in value]
    return value


# enforce all 44 inherited gates plus the new same-window baseline
def candidate_screens(report, data, indices, flags, policy=POLICY):
    require(policy['screen'] == RESIDUAL_POLICY['screen'] and policy['candidateSupport'] == RESIDUAL_POLICY['candidateSupport'], 'search empirical gates changed')
    actual, hours = data['actual'][indices], data['hour'][indices]
    screens = {}
    # calculate support and every gate separately for each candidate
    for name in policy['candidates']:
        selected = flags[name]
        counts = support(actual[selected], hours[selected])
        view = alias(report, name)
        view['support'] = counts
        view['invariants'] = {'finiteNonnegative': report['invariants']['finiteNonnegative']}
        gates = residual_gates(view, RESIDUAL_POLICY)
        require(len(gates) == 44, 'inherited rain gate count changed')
        gates['beatsSameWindowVolumeScale'] = report['overall'][name]['mae'] <= report['overall']['volume90']['mae']
        require(len(gates) == 45, 'rain search gate count changed')
        screens[name] = {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [key for key, passed in gates.items() if not passed]}
    passing = [name for name, result in screens.items() if result['passed']]
    chosen = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, chosen


# recompute the complete aggregate report from verified native forecasts
def expected_report(root, freeze, data, old_policy, indices, outputs, flags, states):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'search-freeze.json').read_bytes()).hexdigest(), 'overall': {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in outputs.items()}, 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report.update(score_groups(data, indices, outputs, old_policy))
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in outputs.items()}
    report['events'] = score_events(actual, hours, outputs, freeze['policy']['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, outputs)
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in outputs.values()))}
    report['candidateScreens'], report['selectedCandidate'] = candidate_screens(report, data, indices, flags, freeze['policy'])
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# verify frozen data, independent full refits and every reported result
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, feature_names, data = load_inputs(root)
    freeze = json.loads((root / 'search-freeze.json').read_text())
    require(freeze['policy'] == POLICY and freeze['featureNames'] == feature_names and freeze['inputSchemaFreezeSha256'] == hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest() and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'search experiment freeze changed')
    require(old_freeze['featureNames'] == feature_names and set(POLICY['candidates']) == {'ordinalAmount', 'weightedModerate', 'weightedStrong'} and POLICY['candidates']['weightedModerate']['rainWeights'] == [1., 2., 4.] and POLICY['candidates']['weightedStrong']['rainWeights'] == [1., 3., 6.], 'search candidate scope changed')
    require(POLICY['calibrationDays'] == 90 and POLICY['embargoDays'] == 7 and POLICY['calibrationScaleBounds'] == [.1, 3.] and POLICY['rawBlend'] == .25 and POLICY['boostRounds'] == 160 and POLICY['ordinalThresholdPolicy']['minimumTrainingPositiveHours'] == 10 and POLICY['ordinalThresholdPolicy']['minimumTrainingPositiveDates'] == 3 and POLICY['ordinalThresholdPolicy']['minimumAmountWetHours'] == 100 and POLICY['ordinalThresholdPolicy']['minimumAmountWetDates'] == 20 and POLICY['ordinalThresholdPolicy']['minimumCalibrationPositiveHours'] == [10, 5, 3], 'search timing or learner scope changed')
    source_freeze(root, freeze)
    indices, outputs, flags, states = replay_all(root, data, old_policy, freeze['policy'], feature_names)
    # reject changed prediction keys, rows, support flags or physical amounts
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices'} | {f'amount::{name}' for name in ARMS} | {f'supported::{name}' for name in flags}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices), 'search prediction population changed')
    for name, expected in outputs.items():
        retained = archive[f'amount::{name}']
        require(retained.shape == expected.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, expected, rtol=1e-8, atol=1e-9), f'search prediction replay changed: {name}')
    for name, expected in flags.items():
        retained = archive[f'supported::{name}']
        require(retained.dtype == np.dtype(bool) and np.array_equal(retained, expected), f'search supported population changed: {name}')
    report_path = root / 'report.json'
    expected = expected_report(root, freeze, data, old_policy, indices, outputs, flags, states)
    same_tree(expected, json.loads(report_path.read_text()))
    heads = sum(sum(head['sha256'] is not None for head in state['candidates']['ordinalAmount'].get('model', {}).get('heads', {}).values()) for state in states.values())
    weighted = sum(sum(state['candidates'][name].get('model') is not None for name in ('weightedModerate', 'weightedStrong')) for state in states.values())
    receipt = {'contractVersion': 'rain-search-independent-verification/v1', 'verified': True, 'monthlyStatesVerified': len(states), 'nativeOrdinalHeadsRefit': heads, 'nativeWeightedModelsRefit': weighted, 'developmentPredictionRows': len(indices), 'all45GatesPerCandidateVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # keep verifier output separate from immutable producer artifacts
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# require an explicit private search root and separate evidence path
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
