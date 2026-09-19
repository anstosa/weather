"""independently refit and replay the frozen rain-residual development experiment."""

import argparse
import hashlib
import json
import os
from pathlib import Path

# pin numerical libraries before native learner imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_event_guard import POLICY as PREVIOUS_POLICY
from rain_residual import POLICY as RESIDUAL_POLICY
from rain_residual import SOURCE_FILES
from verify_rain_event_guard import (
    calibrated_scale,
    load_inputs,
    month_masks,
    same_tree,
    score_accumulations,
    score_amounts,
    score_events,
    score_groups,
)
from verify_rain_event_guard import development_gates as previous_gates
from verify_rain_sub24_model import metrics, require, weights


# count independent valid hours and wet dates without vintage inflation
def support(actual, hours):
    wet = actual >= .1
    return {'rows': len(hours), 'dates': len(np.unique(hours // 24)), 'hours': len(np.unique(hours)), 'wetDates': len(np.unique(hours[wet] // 24)), 'wetHours': len(np.unique(hours[wet]))}


# reproduce the bounded nonnegative amount map
def amount_map(raw, delta, scale=1.):
    raw, delta = np.asarray(raw, dtype=float), np.asarray(delta, dtype=float)
    require(raw.shape == delta.shape and np.isfinite(raw).all() and np.isfinite(delta).all() and (raw >= 0).all(), 'invalid residual prediction arrays')
    base = np.clip(raw + .5 * delta, 0, 30)
    return np.clip(scale * base, 0, 30)


# bind each copied producer source to its pre-outcome freeze
def check_source_freeze(root, freeze, source_files):
    require(set(freeze['sourceSha256']) == set(source_files), 'residual producer source set changed')
    # inspect every producer dependency
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'unsafe residual source path')
        saved = root / 'residual-sources' / relative
        live = Path(__file__).with_name(name)
        require(saved.is_file() and live.is_file() and not saved.is_symlink(), f'missing frozen producer source: {name}')
        require(hashlib.sha256(saved.read_bytes()).hexdigest() == expected and hashlib.sha256(live.read_bytes()).hexdigest() == expected, f'frozen producer source changed: {name}')


# independently solve the bounded final clipped calibration curve
def calibrate(actual, base, hours, policy):
    actual, base, hours = np.asarray(actual, dtype=float), np.asarray(base, dtype=float), np.asarray(hours)
    require(actual.shape == base.shape == hours.shape and len(hours) and np.isfinite(actual).all() and np.isfinite(base).all() and (actual >= 0).all() and (base >= 0).all(), 'invalid residual calibration arrays')
    weight = weights(hours)
    target = float(np.dot(weight, actual))
    limits = policy['calibration']
    tolerance = limits['absoluteTolerance'] + limits['relativeTolerance'] * abs(target)
    lower, upper = limits['scaleBounds']

    # measure the achievable amount after final clipping
    def mean(scale):
        return float(np.dot(weight, np.clip(scale * base, 0, policy['maximumRainMmPerHour'])))

    low_mean, high_mean = mean(lower), mean(upper)
    record = {'supported': False, 'scale': None, 'reason': None, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'tolerance': tolerance, 'achievedMean': None}
    # reject a flat calibration response
    if high_mean - low_mean <= tolerance:
        return {**record, 'reason': 'flat_calibration_curve'}
    # reject genuinely unattainable targets
    if target < low_mean or target > high_mean:
        return {**record, 'reason': 'target_outside_attainable_range'}
    # preserve a unit scalar when already calibrated
    if abs(mean(1.) - target) <= tolerance:
        solution = 1.
    else:
        # bisect the monotone clipped response
        for _ in range(limits['iterations']):
            middle = (lower + upper) / 2
            # maintain the lower feasible bracket
            if mean(middle) < target:
                lower = middle
            # maintain the upper feasible bracket
            else:
                upper = middle
        solution = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
    achieved = mean(solution)
    # reject numerical roots outside tolerance
    if abs(achieved - target) > tolerance:
        return {**record, 'reason': 'root_residual_above_tolerance'}
    return {**record, 'supported': True, 'scale': solution, 'reason': 'calibrated', 'achievedMean': achieved}


# enforce unique-hour support rather than forecast-row support
def has_support(counts, minimum):
    return all(counts[name] >= value for name, value in minimum.items())


# refit one frozen monthly signed learner and rebuild its entire state
def replay_month(root, data, month, old_policy, feature_names, policy):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(data['actual'][calibration], data['hour'][calibration])}
    state = {'month': month, **bounds, 'support': counts, 'parameters': policy['parameters'], 'featureNames': feature_names, 'modelSha256': None, 'trainingMaximumActualHour': None, 'supported': False, 'reason': 'insufficient_training_support', 'calibration': None}
    directory = root / 'residual-models' / month
    require(directory.is_dir(), f'missing residual model state: {month}')
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    require(old_state['policy'] == old_policy and old_state['featureNames'] == feature_names and old_state['month'] == month and old_state['calibrationRows'] == int(calibration.sum()), 'inherited monthly calibration state changed')
    old_scale = calibrated_scale(data['actual'][calibration], data['raw'][calibration], data['hour'][calibration])
    require(np.isclose(old_scale, old_state['scales']['raw'], rtol=0, atol=1e-9), 'inherited raw volume scale changed')
    raw = data['raw'][evaluation].astype(float)
    recent = data['persistence'][evaluation]
    amounts = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_state['scales']['raw'], 'uncalibratedResidual': raw.copy(), 'residualAmount': raw.copy()}
    require(xgb.__version__ == policy['xgboostVersion'], 'residual native runtime changed')
    # unsupported training leaves exact raw forecasts
    if has_support(counts['training'], policy['trainingSupport']):
        # refit the same weighted signed target
        training = xgb.DMatrix(data['x'][fit], label=data['actual'][fit] - data['raw'][fit], weight=weights(data['hour'][fit]) * int(fit.sum()), feature_names=feature_names, nthread=1)
        refit = xgb.train(policy['parameters'], training, num_boost_round=policy['boostRounds'])
        path = directory / 'residual.json'
        require(path.is_file(), f'missing supported residual booster: {month}')
        native = path.read_bytes()
        native_sha = hashlib.sha256(native).hexdigest()
        require(hashlib.sha256(refit.save_raw(raw_format='json')).hexdigest() == native_sha, f'deterministic native refit changed: {month}')
        retained = xgb.Booster(model_file=path)
        config = json.loads(retained.save_config())
        require(retained.feature_names == feature_names and retained.num_boosted_rounds() == policy['boostRounds'] and config['learner']['objective']['name'] == 'reg:squarederror', f'residual native objective or schema changed: {month}')
        state['modelSha256'] = native_sha
        state['trainingMaximumActualHour'] = int(data['hour'][fit].max())
        evaluation_matrix = xgb.DMatrix(data['x'][evaluation], feature_names=feature_names, nthread=1)
        amounts['uncalibratedResidual'] = amount_map(raw, retained.predict(evaluation_matrix))
        state['reason'] = 'insufficient_calibration_support'
        # only an adequately wet prior calibration window may set the scalar
        if has_support(counts['calibration'], policy['calibrationSupport']):
            calibration_matrix = xgb.DMatrix(data['x'][calibration], feature_names=feature_names, nthread=1)
            base = amount_map(data['raw'][calibration], retained.predict(calibration_matrix))
            state['calibration'] = calibrate(data['actual'][calibration], base, data['hour'][calibration], policy)
            state['supported'] = state['calibration']['supported']
            state['reason'] = state['calibration']['reason']
            # prevent unsupported scalar states from altering primary output
            if state['supported']:
                amounts['residualAmount'] = np.clip(amounts['uncalibratedResidual'] * state['calibration']['scale'], 0, policy['maximumRainMmPerHour'])
    # a missing model must not masquerade as an unsupported scalar
    else:
        require(not (directory / 'residual.json').exists(), f'unexpected unsupported residual booster: {month}')
    saved = json.loads((directory / 'state.json').read_text())
    same_tree(state, saved, f'monthlyStates.{month}')
    return np.where(evaluation)[0], amounts, state


# replay all predeclared consumed months without selecting a favorable subset
def replay_all(root, data, old_policy, feature_names, policy):
    months = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
    require(policy['developmentMonths'] == months and old_policy['holdoutMonths'] == months, 'residual development boundary changed')
    indices, flags, states = [], [], {}
    output = {name: [] for name in ('raw', 'zero', 'persistence', 'volumeScale', 'uncalibratedResidual', 'residualAmount')}
    # inspect every monthly model state
    for month in months:
        selected, amounts, state = replay_month(root, data, month, old_policy, feature_names, policy)
        indices.append(selected)
        flags.append(np.full(len(selected), state['supported'], dtype=bool))
        states[month] = state
        # retain all controls and the diagnostic arm
        for name, values in output.items():
            values.append(amounts[name])
    return np.concatenate(indices), np.concatenate(flags), {name: np.concatenate(values) for name, values in output.items()}, states


# translate only the candidate key for the unchanged empirical gate suite
def gate_alias(value):
    # preserve every nested report field
    if isinstance(value, dict):
        return {('eventGuard' if key == 'residualAmount' else key): gate_alias(item) for key, item in value.items()}
    # retain list values without mutation
    if isinstance(value, list):
        return [gate_alias(item) for item in value]
    return value


# retain forty-two empirical gates and replace two pointwise invariants
def development_gates(report, policy):
    require(policy['screen'] == PREVIOUS_POLICY['screen'] and policy['thresholdsMmPerHour'] == PREVIOUS_POLICY['thresholdsMmPerHour'] and policy['empiricalSafetyGatesUnchanged'] is True, 'empirical screen changed')
    require(set(policy['replacedStructuralGates']) == {'rawHeavyAmountsUnchanged', 'rawWetCallsPreserved'} and set(policy['replacementStructuralGates']) == {'finiteNonnegative', 'candidateSupport'}, 'structural gate replacement changed')
    compatible = gate_alias(report)
    compatible['invariants'] = {'rawHeavyAmountsUnchanged': False, 'rawWetCallsPreserved': False}
    gates = previous_gates(compatible, PREVIOUS_POLICY)
    # exclude guarantees this learner does not make
    for name in policy['replacedStructuralGates']:
        require(name in gates, f'missing replaced structural gate: {name}')
        gates.pop(name)
    gates['finiteNonnegative'] = report['invariants']['finiteNonnegative']
    gates['candidateSupport'] = report['support']['dates'] >= policy['candidateSupport']['dates'] and report['support']['wetDates'] >= policy['candidateSupport']['wetDates']
    require(len(gates) == 44, 'residual development gate count changed')
    return gates


# rebuild the complete aggregate report from retained source arrays
def expected_report(root, freeze, data, old_policy, indices, flags, amounts, states):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'experiment-freeze.json').read_bytes()).hexdigest(), 'overall': score_amounts(data, indices, amounts), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report.update(score_groups(data, indices, amounts, old_policy))
    # score each unchanged arm against the mean-gauge sensitivity target
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}
    report['events'] = score_events(actual, hours, amounts, freeze['policy']['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, amounts)
    report['support'] = support(actual[flags], hours[flags])
    # reject any nonfinite or negative named arm
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in amounts.values()))}
    report['developmentGates'] = development_gates(report, freeze['policy'])
    report['developmentPassed'] = all(report['developmentGates'].values())
    report['decision'] = 'eligible_for_separate_prospective_protocol_not_qualified' if report['developmentPassed'] else 'rejected_development_no_retuning_or_prospective_unlock'
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# verify frozen inputs, refit native models and compare every reported result
def verify(root, evidence):
    old_freeze, old_policy, feature_names, data = load_inputs(root)
    freeze = json.loads((root / 'experiment-freeze.json').read_text())
    require(freeze['policy'] == RESIDUAL_POLICY and freeze['featureNames'] == feature_names and freeze['inputSchemaFreezeSha256'] == hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest() and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'residual experiment freeze changed')
    require(old_freeze['featureNames'] == feature_names, 'inherited feature schema changed')
    check_source_freeze(root, freeze, SOURCE_FILES)
    indices, flags, amounts, states = replay_all(root, data, old_policy, feature_names, freeze['policy'])
    # compare retained rows without loading pickle payloads
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices', 'supported'} | {f'amount::{name}' for name in amounts}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices) and archive['supported'].dtype == np.dtype(bool) and np.array_equal(archive['supported'], flags), 'residual prediction support or population changed')
    # compare every native amount prediction
    for name, expected in amounts.items():
        retained = archive[f'amount::{name}']
        require(retained.shape == expected.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, expected, rtol=1e-8, atol=1e-9), f'residual prediction replay changed: {name}')
    expected = expected_report(root, freeze, data, old_policy, indices, flags, amounts, states)
    report_path = root / 'report.json'
    same_tree(expected, json.loads(report_path.read_text()))
    # summarize refitted state counts without exposing row material
    receipt = {'contractVersion': 'rain-residual-independent-verification/v1', 'verified': True, 'nativeStatesRefit': sum(state['modelSha256'] is not None for state in states.values()), 'monthlyStatesVerified': len(states), 'developmentPredictionRows': len(indices), 'supportedPredictionRows': int(flags.sum()), 'metricsEventsAccumulationsGatesVerified': True, 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # keep verification separate from immutable producer artifacts
    with Path(evidence).open('x') as stream:
        json.dump(receipt, stream, allow_nan=False, sort_keys=True)
        stream.write('\n')
    return receipt


# run only on an explicit private experiment root
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
