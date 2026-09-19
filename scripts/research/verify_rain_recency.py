"""independently replay fixed recency calibration on retained rain models."""

import argparse
import hashlib
import json
import os
from pathlib import Path

# pin native reductions before importing numerical libraries
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_recency import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from rain_residual import POLICY as RESIDUAL_POLICY
from verify_rain_context import alias, availability_counts, build_features, feature_sets, load_profiles
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
    HEADS,
    THRESHOLDS,
    calibrate,
    check_booster,
    checked_rules,
    event_metrics,
    head_support,
    month_masks,
    ordinal_categories,
    ordinal_project,
    ordinal_rules,
    support,
)
from verify_rain_sub24_model import metrics, require, weights

WINDOW_DAYS = 90
HALF_LIFE_DAYS = 30
MONTHS = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'volumeRecent', 'ordinal90', 'weightedContext', 'ordinalRecentAmount', 'ordinalRecentEvents', 'ordinalRecent')
RECENT_ARMS = ('ordinalRecentAmount', 'ordinalRecentEvents', 'ordinalRecent')
CONTEXT_PINS = {
    'context-freeze.json': '3a3e88033b8ab5a4771f2c85e3a694392bb8755e207097b23d519a5be2bd7427',
    'report.json': 'cfab32d382b3de0d34ee27aa21fddec7de29fc04d6cec48ed4f3b33bb6a55aae',
    'predictions.npz': '8c04ceaf14b75f4c9b8ec35b636989aa632c9a8fe60ff9600b9016630804d426',
    'features.npz': 'eeb073a89b846295d9f46c8592b065033f564eb8b73ff50d32b92a0decaa127a',
    'retention-manifest.json': '92a6ef3719981d113f379db2c4a4075cd0e1eb0b6d34a40bc2fb50e50a647cc9',
}


# hash one retained input without trusting a manifest assertion alone
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# decay each balanced date-hour-vintage mass from the last earlier UTC date
def recent_weights(hours, stop):
    hours = np.asarray(hours)
    require(hours.ndim == 1 and len(hours) and np.issubdtype(hours.dtype, np.integer), 'invalid recency hours')
    require(type(stop) in (int, np.int64, np.int32) and stop % 24 == 0 and (hours >= stop - WINDOW_DAYS * 24).all() and (hours < stop).all(), 'recency stop or window changed')
    ages = stop // 24 - 1 - hours // 24
    mass = weights(hours) * np.exp2(-ages.astype(float) / HALF_LIFE_DAYS)
    return mass / mass.sum()


# calculate effective distinct-date mass, including wet-date mass
def effective_support(actual, hours, mass):
    actual, hours, mass = np.asarray(actual), np.asarray(hours), np.asarray(mass)
    require(actual.shape == hours.shape == mass.shape and len(actual) and np.isfinite(actual).all() and (actual >= 0).all() and np.issubdtype(hours.dtype, np.integer) and np.isfinite(mass).all() and (mass > 0).all() and np.isclose(mass.sum(), 1.), 'invalid effective recency support')
    dates, inverse = np.unique(hours // 24, return_inverse=True)
    all_mass = np.bincount(inverse, weights=mass, minlength=len(dates))
    wet_mass = np.bincount(inverse, weights=mass * (actual >= .1), minlength=len(dates))
    all_effective = float(all_mass.sum() ** 2 / (all_mass @ all_mass))
    wet_effective = 0. if not wet_mass.any() else float(wet_mass.sum() ** 2 / (wet_mass @ wet_mass))
    return {'effectiveDates': all_effective, 'effectiveWetDates': wet_effective}


# solve the bounded scalar on weighted final output rather than an intermediate head
def calibrate_recent(actual, mass, projection, policy):
    actual, mass = np.asarray(actual, dtype=float), np.asarray(mass, dtype=float)
    require(actual.ndim == 1 and actual.shape == mass.shape and len(actual) and np.isfinite(actual).all() and (actual >= 0).all() and np.isfinite(mass).all() and (mass >= 0).all() and np.isclose(mass.sum(), 1.), 'invalid weighted calibration arrays')
    target = float(mass @ actual)
    lower, upper = policy['calibrationScaleBounds']
    tolerance = policy['calibrationTolerance']['absolute'] + policy['calibrationTolerance']['relative'] * abs(target)

    # reject malformed scalar projections before bisection
    def mean(scale):
        prediction = np.asarray(projection(scale))
        require(prediction.shape == actual.shape and np.isfinite(prediction).all() and (prediction >= 0).all(), 'invalid weighted calibration projection')
        return float(mass @ prediction)

    low_mean, high_mean = mean(lower), mean(upper)
    require(low_mean <= high_mean + tolerance, 'nonmonotone weighted calibration curve')
    # preserve saturation rather than claiming an unreachable target
    if target < low_mean:
        scale, status = lower, 'saturated_low'
    elif target > high_mean:
        scale, status = upper, 'saturated_high'
    elif abs(mean(1.) - target) <= tolerance:
        scale, status = 1., 'matched'
    else:
        # bisect the final amount curve at the fixed policy count
        for _ in range(policy['calibrationIterations']):
            middle = (lower + upper) / 2
            # retain the endpoint bracket around weighted target mass
            if mean(middle) < target:
                lower = middle
            else:
                upper = middle
        scale = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
        status = 'matched' if abs(mean(scale) - target) <= tolerance else 'unmatched_numeric'
    achieved = mean(scale)
    return {'scale': scale, 'status': status, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'achievedMean': achieved, 'residual': achieved - target, 'tolerance': tolerance}


# choose the highest positive-score cutoff meeting weighted recall and safety
def ordinal_rules_recent(actual, raw, probability, hours, mass, policy):
    actual, raw, probability, hours, mass = map(np.asarray, (actual, raw, probability, hours, mass))
    require(actual.shape == raw.shape == hours.shape == mass.shape and probability.shape == (len(actual), 3), 'invalid weighted event arrays')
    limits = policy['ordinalThresholdPolicy']
    rules = []
    # preserve one independent rule per physical threshold
    for index, (threshold, name) in enumerate(zip(THRESHOLDS, HEADS)):
        observed = actual >= threshold
        baseline = event_metrics(observed, raw >= threshold, mass)
        counts = head_support(actual, hours, threshold)
        rule = {'threshold': threshold, 'head': name, 'cutoff': None, 'reason': 'insufficient_calibration_support', 'support': counts, 'raw': baseline, 'candidate': None, 'targetRecall': None}
        scores = probability[:, index]
        # unsupported positives retain raw threshold calls
        if counts['positiveHours'] >= limits['minimumCalibrationPositiveHours'][index] and counts['positiveDates'] >= limits['minimumCalibrationPositiveDates']:
            # a completely absent native head retains raw calls
            if np.isnan(scores).all():
                rule['reason'] = 'missing_model_head'
            else:
                require(np.isfinite(scores).all() and ((scores >= 0) & (scores <= 1)).all(), 'invalid weighted event scores')
                target = min(1., baseline['pod'] + limits['recallMargin'])
                rule['targetRecall'] = target
                selected = None
                # ties stay together at each descending positive threshold
                for score in np.unique(scores[observed])[::-1]:
                    candidate = event_metrics(observed, scores >= score, mass)
                    # stop at the first recall-safe cutoff
                    if candidate['pod'] + 1e-12 >= target:
                        selected = float(score)
                        rule['candidate'] = candidate
                        break
                # preserve exact far and csi tolerances
                if selected is not None and rule['candidate']['far'] <= baseline['far'] + limits['maximumFarDelta'] + 1e-12 and rule['candidate']['csi'] + 1e-12 >= baseline['csi'] + limits['minimumCsiDelta']:
                    rule.update({'cutoff': selected, 'reason': 'calibrated'})
                else:
                    rule['reason'] = 'calibration_safety_regression'
        rules.append(rule)
    return rules


# reject composite event regressions under the same recent date mass
def checked_rules_recent(actual, raw, probability, hours, proposed, mass, policy):
    categories = ordinal_categories(raw, probability, proposed)
    projected = ordinal_project(np.ones(len(raw)), categories, 1.)
    safe = True
    # compare every projected event threshold with unadjusted raw calls
    for threshold in THRESHOLDS:
        observed = actual >= threshold
        baseline = event_metrics(observed, raw >= threshold, mass)
        candidate = event_metrics(observed, projected >= threshold, mass)
        # regressions reset the complete rule set, never one tuned subset
        if not (candidate['pod'] + 1e-12 >= baseline['pod'] and candidate['far'] <= baseline['far'] + policy['ordinalThresholdPolicy']['maximumFarDelta'] + 1e-12 and candidate['csi'] + 1e-12 >= baseline['csi'] + policy['ordinalThresholdPolicy']['minimumCsiDelta']):
            safe = False
    # return the original rules when all weighted physical calls are safe
    if safe:
        return proposed, False
    return [{**rule, 'cutoff': None, 'reason': 'nesting_safety_fallback'} for rule in proposed], True


# enumerate only the five copied fixed learners and pinned context evidence
def context_members():
    members = [*CONTEXT_PINS, 'inputs/trajectory.jsonl', 'final-evidence/independent-verification-final.json']
    # preserve one monthly state and five native model files per month
    for month in MONTHS:
        members.extend((f'context-models/{month}/state.json', f'context-models/{month}/weightedContext/amount.json'))
        members.extend(f'context-models/{month}/ordinalContext/{name}' for name in ('event-0.1.json', 'event-1.0.json', 'event-2.5.json', 'amount.json'))
    return members


# bind new frozen policy to all copied previous artifacts and source bytes
def check_freeze(root, freeze, old_names):
    require(freeze['policy'] == POLICY and freeze['featureNames'] == old_names and freeze['contextFeatureNames'] == POLICY['featureNames'] and freeze['inputSchemaFreezeSha256'] == sha(root / 'freeze.json') and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'recency policy or input freeze changed')
    require(set(freeze['sourceSha256']) == set(SOURCE_FILES) and set(freeze['contextInputSha256']) == set(context_members()) | {'parent-retention-receipt.json'} and POLICY['contextPins'] == CONTEXT_PINS, 'recency producer or fixed context scope changed')
    # check every source's pre-outcome byte identity against live code
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and len(relative.parts) == 1 and '..' not in relative.parts, 'unsafe recency producer path')
        retained, live = root / 'recency-sources' / name, Path(__file__).with_name(name)
        require(retained.is_file() and live.is_file() and not retained.is_symlink() and sha(retained) == expected and sha(live) == expected, f'recency source changed: {name}')
    previous = root / 'inputs/context'
    manifest_path = previous / 'retention-manifest.json'
    require(sha(manifest_path) == CONTEXT_PINS['retention-manifest.json'], 'context retention manifest changed')
    manifest = json.loads(manifest_path.read_text())
    require(manifest['reportSha256'] == CONTEXT_PINS['report.json'] and manifest['independentEvaluationPerformed'] is False and manifest['productionEligible'] is False and manifest['productionWrites'] is False, 'context retention boundary changed')
    members = manifest['files']
    # bind every inherited file to both encrypted-manifest hashes and freeze
    for name, expected in freeze['contextInputSha256'].items():
        path = previous / name
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, f'copied context artifact changed: {name}')
        if name not in ('parent-retention-receipt.json', 'retention-manifest.json'):
            require(members[name]['sha256'] == expected and members[name]['bytes'] == path.stat().st_size, f'context retention member changed: {name}')
    require(all(freeze['contextInputSha256'][name] == expected for name, expected in CONTEXT_PINS.items()), 'context pinned hashes changed')
    receipt = json.loads((previous / 'parent-retention-receipt.json').read_text())
    require(receipt['verdict'] == 'PASS' and receipt['encryptedRoundtripVerified'] is True and receipt['manifestSha256'] == CONTEXT_PINS['retention-manifest.json'] and receipt['productionDatabaseOrServiceWrites'] is False, 'context encrypted receipt changed')
    original_freeze = json.loads((previous / 'context-freeze.json').read_text())
    require(original_freeze['featureNames'] == old_names and original_freeze['featureSets']['full'] == POLICY['featureNames'] and original_freeze['trajectorySha256'] == 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1' and original_freeze['newCandidateOutcomesRead'] is False and original_freeze['productionWrites'] is False, 'context feature/source lineage changed')
    source_manifest = json.loads((root / 'inputs/acquisition/manifest.json').read_text())
    cohort = source_manifest['cohortFiles']['ecmwf_single_run_hindcast']
    require(cohort['sha256'] == original_freeze['trajectorySha256'] and cohort['bytes'] == original_freeze['trajectoryBytes'] and cohort['rows'] == original_freeze['trajectoryRows'] and cohort['successfulRuns'] * 48 == cohort['rows'] and sha(previous / 'inputs/trajectory.jsonl') == cohort['sha256'], 'context trajectory provenance changed')
    previous_receipt = json.loads((previous / 'final-evidence/independent-verification-final.json').read_text())
    require(previous_receipt['verified'] is True and previous_receipt['nativeModelsRefit'] == 144 and previous_receipt['featuresSha256'] == CONTEXT_PINS['features.npz'] and previous_receipt['reportSha256'] == CONTEXT_PINS['report.json'] and previous_receipt['predictionsSha256'] == CONTEXT_PINS['predictions.npz'] and previous_receipt['productionEligible'] is False, 'context independent verification lineage changed')
    return cohort


# refit five existing XGBoost objectives and produce their native pre-calibration scores
def refit_models(root, data, full, names, fit, calibration, evaluation, month, saved):
    require(isinstance(names, list) and names == POLICY['featureNames'] and len(names) == 95, 'native recency feature names changed')
    directory = root / 'inputs/context/context-models' / month
    actual, hours = data['actual'][fit], data['hour'][fit]
    ordinal_state = {'featureNames': names, 'rounds': POLICY['boostRounds'], 'heads': {}}
    ordinal_saved = saved['candidates']['ordinalContext']['model']
    models = {}
    # reproduce each frozen occurrence objective, training mass and exact JSON
    for threshold, name, filename in zip(THRESHOLDS, HEADS, ('event-0.1.json', 'event-1.0.json', 'event-2.5.json')):
        counts = head_support(actual, hours, threshold)
        expected = ordinal_saved['heads'][name]
        require(expected['support'] == counts and expected['modelFile'] == filename and expected['objective'] == 'binary:logistic', f'context event support changed: {month}:{name}')
        matrix = xgb.DMatrix(full[fit], label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=names, nthread=1)
        booster = xgb.train({**POLICY['parameters'], 'objective': 'binary:logistic'}, matrix, num_boost_round=POLICY['boostRounds'])
        check_booster(booster, directory / 'ordinalContext' / filename, expected['sha256'], 'binary:logistic', POLICY['boostRounds'], names)
        models[name] = booster
        ordinal_state['heads'][name] = {'objective': 'binary:logistic', 'support': counts, 'modelFile': filename, 'sha256': expected['sha256'], 'reason': 'fitted'}
    wet = actual >= .1
    counts = head_support(actual, hours, .1)
    expected = ordinal_saved['heads']['amount']
    require(expected['support'] == counts and expected['modelFile'] == 'amount.json' and expected['objective'] == 'reg:gamma', f'context gamma support changed: {month}')
    matrix = xgb.DMatrix(full[fit][wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=names, nthread=1)
    booster = xgb.train({**POLICY['parameters'], 'objective': 'reg:gamma'}, matrix, num_boost_round=POLICY['boostRounds'])
    check_booster(booster, directory / 'ordinalContext/amount.json', expected['sha256'], 'reg:gamma', POLICY['boostRounds'], names)
    models['amount'] = booster
    ordinal_state['heads']['amount'] = {'objective': 'reg:gamma', 'support': counts, 'modelFile': 'amount.json', 'sha256': expected['sha256'], 'reason': 'fitted'}
    same_tree(ordinal_state, ordinal_saved, f'contextOrdinalModel.{month}')

    # refit the unchanged moderate-cost Tweedie head on full context features
    costs = [1., 2., 4.]
    cost = np.where(actual >= 1, costs[2], np.where(actual >= .1, costs[1], costs[0]))
    mass = weights(hours) * cost
    mass *= len(actual) / mass.sum()
    parameters = {**POLICY['parameters'], 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(full[fit], label=actual, weight=mass, feature_names=names, nthread=1)
    weighted_model = xgb.train(parameters, matrix, num_boost_round=POLICY['boostRounds'])
    weighted_saved = saved['candidates']['weightedContext']['model']
    check_booster(weighted_model, directory / 'weightedContext/amount.json', weighted_saved['modelSha256'], 'reg:tweedie', POLICY['boostRounds'], names)
    same_tree({'parameters': parameters, 'rainWeights': costs, 'modelSha256': weighted_saved['modelSha256']}, weighted_saved, f'contextWeightedModel.{month}')

    # predict only calibration and evaluation rows from independently refitted trees
    output = {}
    for population, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(full[mask], feature_names=names, nthread=1)
        probability = np.column_stack([np.clip(models[name].predict(matrix), 0, 1) for name in HEADS])
        amount = np.clip(models['amount'].predict(matrix), .1, 30).astype(float)
        weighted = np.clip(weighted_model.predict(matrix).astype(float), 0, 30)
        raw = data['raw'][mask].astype(float)
        output[population] = {'probability': probability, 'amount': amount, 'weightedBase': np.clip(.25 * raw + .75 * weighted, 0, 30)}
    return output, ordinal_state, weighted_saved


# replay one chronological month with fixed trees and only calibration-weight changes
def replay_month(root, data, full, names, old_policy, month):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(actual, hours)}
    saved = json.loads((root / 'inputs/context/context-models' / month / 'state.json').read_text())
    require(all(saved[key] == value for key, value in bounds.items()) and saved['support'] == counts and saved['candidates']['ordinalContext']['supported'] and saved['candidates']['weightedContext']['supported'], f'context chronology or support changed: {month}')
    model_outputs, ordinal_model, weighted_model = refit_models(root, data, full, names['full'], fit, calibration, evaluation, month, saved)
    probability_cal = model_outputs['calibration']['probability']
    probability_eval = model_outputs['evaluation']['probability']
    blend_cal = np.clip(.25 * raw_cal + .75 * model_outputs['calibration']['amount'], 0, 30)
    blend_eval = np.clip(.25 * raw + .75 * model_outputs['evaluation']['amount'], 0, 30)

    # reproduce original uniform ordinal reference before new recency calculations
    proposed_uniform = ordinal_rules(actual, raw_cal, probability_cal, hours, SEARCH_POLICY)
    uniform, uniform_fallback = checked_rules(actual, raw_cal, probability_cal, hours, proposed_uniform, SEARCH_POLICY)
    uniform_cal = ordinal_categories(raw_cal, probability_cal, uniform)
    uniform_eval = ordinal_categories(raw, probability_eval, uniform)
    uniform_scale = calibrate(actual, hours, lambda scale: ordinal_project(blend_cal, uniform_cal, scale), SEARCH_POLICY)
    ordinal90 = ordinal_project(blend_eval, uniform_eval, uniform_scale['scale'])
    uniform_events = score_events(actual, hours, {'ordinalContext': ordinal_project(blend_cal, uniform_cal, uniform_scale['scale'])}, SEARCH_POLICY['thresholdsMmPerHour'])['ordinalContext']
    reference_ordinal = {'supported': True, 'model': ordinal_model, 'proposedRules': proposed_uniform, 'rules': uniform, 'nestingSafetyFallback': uniform_fallback, 'calibration': uniform_scale, 'compositeCalibrationEvents': uniform_events}
    same_tree(reference_ordinal, saved['candidates']['ordinalContext'], f'contextOrdinalReference.{month}')

    # preserve the unchanged weighted-context reference at its old scalar
    weighted_cal = model_outputs['calibration']['weightedBase']
    weighted_eval = model_outputs['evaluation']['weightedBase']
    weighted_scale = calibrate(actual, hours, lambda scale: np.clip(weighted_cal * scale, 0, 30), SEARCH_POLICY)
    reference_weighted = {'supported': True, 'model': weighted_model, 'calibration': weighted_scale}
    same_tree(reference_weighted, saved['candidates']['weightedContext'], f'contextWeightedReference.{month}')
    raw_scale = calibrate(actual, hours, lambda scale: np.clip(raw_cal * scale, 0, 30), SEARCH_POLICY)
    old_fit, old_cal, old_eval, _ = old_month_masks(data, month, old_policy)
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    old_scale = old_calibrated_scale(data['actual'][old_cal], data['raw'][old_cal], data['hour'][old_cal])
    require(np.array_equal(old_eval, evaluation) and int(old_fit.sum()) > 0 and old_state['policy'] == old_policy and old_state['featureNames'] == names['base'] and np.isclose(old_scale, old_state['scales']['raw'], rtol=0, atol=1e-9), f'old rain baseline changed: {month}')
    persistence = data['persistence'][evaluation]
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(persistence), persistence, raw), 'volumeScale': raw * old_scale, 'volume90': np.clip(raw * raw_scale['scale'], 0, 30), 'ordinal90': ordinal90, 'weightedContext': np.clip(weighted_eval * weighted_scale['scale'], 0, 30)}

    # require old distinct-source support and new Kish-effective date support
    recent_mass = recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = effective_support(actual, hours, recent_mass)
    supported = all(counts['training'][key] >= minimum for key, minimum in POLICY['trainingSupport'].items()) and all(counts['calibration'][key] >= minimum for key, minimum in POLICY['calibrationSupport'].items()) and all(effective[key] >= minimum for key, minimum in POLICY['effectiveSupport'].items())
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': bool(supported), 'reason': 'recent_calibration' if supported else 'insufficient_effective_support', 'referenceOrdinal': reference_ordinal, 'referenceWeighted': reference_weighted, 'rawCalibration': raw_scale, 'recentProposedRules': None, 'recentRules': None, 'recentNestingSafetyFallback': None, 'calibrations': {}}
    # unsupported recency falls back without deleting evaluation rows
    if not supported:
        output['volumeRecent'] = output['volume90'].copy()
        output.update({name: ordinal90.copy() for name in RECENT_ARMS})
    else:
        proposed_recent = ordinal_rules_recent(actual, raw_cal, probability_cal, hours, recent_mass, POLICY)
        recent_rules, recent_fallback = checked_rules_recent(actual, raw_cal, probability_cal, hours, proposed_recent, recent_mass, POLICY)
        recent_cal = ordinal_categories(raw_cal, probability_cal, recent_rules)
        recent_eval = ordinal_categories(raw, probability_eval, recent_rules)
        state.update({'recentProposedRules': proposed_recent, 'recentRules': recent_rules, 'recentNestingSafetyFallback': recent_fallback})
        configurations = {'ordinalRecentAmount': (uniform_cal, uniform_eval, recent_mass), 'ordinalRecentEvents': (recent_cal, recent_eval, None), 'ordinalRecent': (recent_cal, recent_eval, recent_mass)}
        # keep ablations diagnostic only while applying their fixed scalar mass
        for name, (cal_categories, eval_categories, mass) in configurations.items():
            projection = lambda scale: ordinal_project(blend_cal, cal_categories, scale)
            scalar = calibrate(actual, hours, projection, SEARCH_POLICY) if mass is None else calibrate_recent(actual, mass, projection, POLICY)
            output[name] = ordinal_project(blend_eval, eval_categories, scalar['scale'])
            state['calibrations'][name] = scalar
        raw_recent = calibrate_recent(actual, recent_mass, lambda scale: np.clip(raw_cal * scale, 0, 30), POLICY)
        state['calibrations']['volumeRecent'] = raw_recent
        output['volumeRecent'] = np.clip(raw * raw_recent['scale'], 0, 30)
    same_tree(state, json.loads((root / 'recency-states' / f'{month}.json').read_text()), f'recencyState.{month}')
    return np.where(evaluation)[0], output, state


# combine all fixed monthly predictions without support-dependent sampling
def replay_all(root, data, full, names, old_policy):
    indices = []
    amounts = {name: [] for name in ARMS}
    flags = []
    states = {}
    # preserve the predeclared twelve development months in chronological order
    for month in MONTHS:
        rows, output, state = replay_month(root, data, full, names, old_policy, month)
        indices.append(rows)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        for name in ARMS:
            amounts[name].append(output[name])
    indices = np.concatenate(indices)
    require(len(indices) == POLICY['expectedEvaluationRows'] == 32896 and len(np.unique(indices)) == len(indices), 'recency evaluation rows changed')
    return indices, {name: np.concatenate(parts) for name, parts in amounts.items()}, np.concatenate(flags), states


# require old report controls to be exact retained predictions before scoring
def reference_parity(root, indices, amounts):
    mapping = {name: name for name in ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'weightedContext')}
    mapping['ordinal90'] = 'ordinalContext'
    with np.load(root / 'inputs/context/predictions.npz', allow_pickle=False) as old, np.load(root / 'predictions.npz', allow_pickle=False) as saved:
        require(np.array_equal(old['indices'], indices) and np.array_equal(saved['indices'], indices), 'recency reference rows changed')
        # compare immutable producer controls exactly and independent refits closely
        for current, previous in mapping.items():
            retained = old['amount::' + previous]
            require(np.array_equal(saved['amount::' + current], retained), f'exact recency control changed: {current}')
            require(np.allclose(amounts[current], retained, rtol=1e-8, atol=1e-9), f'independent recency control changed: {current}')
    return {'exactPredictions': True, 'exactOrdinalAndWeightedStates': True, 'arms': mapping}


# measure the worst of all four prespecified seasonal volume errors
def seasonal_deviation(report, name):
    values = [report['bySeason'].get(season, {}).get(name, {}).get('volumeRatio') for season in ('DJF', 'MAM', 'JJA', 'SON')]
    return max(abs(value - 1) for value in values) if all(value is not None and np.isfinite(value) for value in values) else float('inf')


# apply all old raw-safety gates plus the five prespecified recency added-value gates
def candidate_screen(report, data, indices, flags):
    actual, hours = data['actual'][indices], data['hour'][indices]
    counts = support(actual[flags], hours[flags])
    view = alias(report, 'ordinalRecent')
    view['support'] = counts
    view['invariants'] = report['invariants']
    gates = residual_gates(view, RESIDUAL_POLICY)
    require(len(gates) == 44 and POLICY['comparisonTolerance'] == 1e-12, 'recency inherited gate contract changed')
    primary, original = report['overall']['ordinalRecent'], report['overall']['ordinal90']
    margin = POLICY['comparisonTolerance']
    gates['beatsSameWindowVolumeScale'] = primary['mae'] <= report['overall']['volume90']['mae']
    gates['beatsRecentVolumeScale'] = primary['mae'] <= report['overall']['volumeRecent']['mae']
    gates['beatsUnchangedOrdinal'] = primary['mae'] < original['mae'] - margin
    gates['seasonalBalanceImproves'] = seasonal_deviation(report, 'ordinalRecent') < seasonal_deviation(report, 'ordinal90') - margin
    heavy = primary['heavyMae'] is not None and original['heavyMae'] is not None and primary['heavyMae'] <= original['heavyMae'] + margin
    # retain both heavy-event definitions, not just mean or wet-hour amount
    for threshold in ('1.0', '2.5'):
        candidate = report['events']['ordinalRecent'][threshold]
        baseline = report['events']['ordinal90'][threshold]
        complete = all(value is not None for value in (*[candidate[key] for key in ('pod', 'csi', 'far')], *[baseline[key] for key in ('pod', 'csi', 'far')]))
        heavy = heavy and complete and candidate['pod'] + margin >= baseline['pod'] and candidate['csi'] + margin >= baseline['csi'] - .01 and candidate['far'] <= baseline['far'] + .05 + margin
    gates['heavySkillRetained'] = bool(heavy)
    require(len(gates) == 49, 'recency gate count changed')
    return {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [name for name, passed in gates.items() if not passed]}


# score unchanged evaluation weights and every complete original reporting group
def expected_report(root, freeze, data, old_policy, profiles, indices, amounts, flags, states, availability, parity):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': sha(root / 'recency-freeze.json'), 'overall': {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}, 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'treeFitPerformed': False, 'nativeModelsReused': 60}
    report.update(score_groups(data, indices, amounts, old_policy))
    report['featureAvailability'] = {'overall': availability_counts(hours, {name: values[indices] for name, values in availability.items()})}
    from verify_rain_event_guard import report_groups
    # retain source-availability diagnostics on all prespecified group partitions
    for field, labels in report_groups(data, indices, old_policy).items():
        report['featureAvailability'][field] = {str(key): availability_counts(hours[labels == key], {name: values[indices][labels == key] for name, values in availability.items()}) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}
    report['events'] = score_events(actual, hours, amounts, SEARCH_POLICY['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, amounts)
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in amounts.values()))}
    report['candidateScreen'] = candidate_screen(report, data, indices, flags)
    report['selectedCandidate'] = 'ordinalRecent' if report['candidateScreen']['passed'] else None
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    report['referenceParity'] = parity
    report['featuresSha256'] = sha(root / 'inputs/context/features.npz')
    report['featureProfileRuns'] = len(profiles)
    report['predictionsSha256'] = sha(root / 'predictions.npz')
    return report


# validate frozen context features, fixed learners, all predictions and full report
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    freeze = json.loads((root / 'recency-freeze.json').read_text())
    require(old_freeze['featureNames'] == old_names and POLICY['arms'] == list(ARMS) and POLICY['candidates'] == ['ordinalRecent'] and POLICY['expectedEvaluationRows'] == 32896 and POLICY['nativeModelsReused'] == 60 and POLICY['treeFitPerformed'] is False and POLICY['halfLifeDays'] == HALF_LIFE_DAYS and POLICY['effectiveSupport'] == {'effectiveDates': 30., 'effectiveWetDates': 3.} and POLICY['calibrationDays'] == WINDOW_DAYS and POLICY['embargoDays'] == 7 and POLICY['sourceAvailability'] == 'simulated_initialization_plus_8h_and_observation_minus_1h_not_verified_historical_receipts', 'recency scientific policy changed')
    names = feature_sets(old_names)
    require(names['full'] == POLICY['featureNames'] and len(names['full']) == 95 and xgb.__version__ == POLICY['xgboostVersion'], 'recency feature or native runtime changed')
    cohort = check_freeze(root, freeze, old_names)
    profiles = load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = build_features(data, profiles, old_names)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    require(set(archive) == {'x', *availability} and archive['x'].shape == matrices['full'].shape and archive['x'].dtype == np.dtype(np.float32) and np.array_equal(archive['x'], matrices['full'], equal_nan=True), 'recency full95 context features changed')
    for name, expected in availability.items():
        require(archive[name].dtype == np.dtype(bool) and np.array_equal(archive[name], expected), f'recency source availability changed: {name}')
    indices, amounts, flags, states = replay_all(root, data, matrices['full'], names, old_policy)
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        saved = {name: material[name] for name in material.files}
    require(set(saved) == {'indices', 'recentSupported'} | {'amount::' + name for name in ARMS} and np.array_equal(saved['indices'], indices) and saved['recentSupported'].dtype == np.dtype(bool) and np.array_equal(saved['recentSupported'], flags), 'recency prediction rows or flags changed')
    # compare all controls, ablations and primary predictions on identical rows
    for name, predicted in amounts.items():
        retained = saved['amount::' + name]
        require(retained.shape == predicted.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, predicted, rtol=1e-8, atol=1e-9), f'recency prediction replay changed: {name}')
    parity = reference_parity(root, indices, amounts)
    expected = expected_report(root, freeze, data, old_policy, profiles, indices, amounts, flags, states, availability, parity)
    report_path = root / 'report.json'
    same_tree(expected, json.loads(report_path.read_text()))
    receipt = {'contractVersion': 'rain-recency-independent-verification/v1', 'verified': True, 'sourceProfilesVerified': len(profiles), 'featureRowsVerified': len(data['actual']), 'featureColumnsVerified': len(names['full']), 'monthlyStatesVerified': len(states), 'nativeModelsRefit': 5 * len(states), 'developmentPredictionRows': len(indices), 'all49GatesVerified': True, 'referenceParityVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'featuresSha256': expected['featuresSha256'], 'reportSha256': sha(report_path), 'predictionsSha256': expected['predictionsSha256']}
    # store verifier evidence separately from the immutable producer output
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# require an explicit private experiment root and one new receipt path
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
