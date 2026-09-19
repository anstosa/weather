"""fit one signed rain-residual learner on explicitly consumed development data."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil

# bound the existing numerical runtime
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_event_guard as previous
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, month_masks, score, weights

MONTHS = previous.MONTHS
ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'uncalibratedResidual', 'residualAmount')
PARAMETERS = {**PARENT_POLICY['treeParameters'], 'objective': 'reg:squarederror', 'base_score': 0, 'seed': 20260913}
POLICY = {
    'contractVersion': 'rain-residual-development/v1',
    'candidate': 'residualAmount',
    'developmentMonths': list(MONTHS),
    'developmentDataPreviouslyConsumed': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'objective': 'signed_actual_minus_raw_squared_error',
    'parameters': PARAMETERS,
    'boostRounds': 160,
    'fitWeight': 'equal_date_hour_vintage_scaled_to_training_row_count',
    'formula': 'base=clip(raw+0.5*residual,0,30); candidate=clip(scale*base,0,30); no_raw_event_floors',
    'residualWeight': 0.5,
    'maximumRainMmPerHour': 30.,
    'calibration': {'scaleBounds': [.5, 2.], 'iterations': 64, 'absoluteTolerance': 1e-10, 'relativeTolerance': 1e-8, 'unsupported': 'exact_raw_forecast_no_rows_excluded'},
    'trainingSupport': {'dates': 180, 'hours': 1000, 'wetDates': 20, 'wetHours': 100},
    'calibrationSupport': {'dates': 20, 'hours': 300, 'wetDates': 5, 'wetHours': 20},
    'candidateSupport': {'dates': 180, 'wetDates': 20},
    'thresholdsMmPerHour': previous.POLICY['thresholdsMmPerHour'],
    'screen': previous.POLICY['screen'],
    'replacedStructuralGates': ['rawHeavyAmountsUnchanged', 'rawWetCallsPreserved'],
    'replacementStructuralGates': ['finiteNonnegative', 'candidateSupport'],
    'empiricalSafetyGatesUnchanged': True,
    'prospectiveEvaluation': previous.POLICY['prospectiveEvaluation'],
    'probability': 'deterministic_point_event_indicator_not_calibrated_probability',
    'xgboostVersion': PARENT_POLICY['xgboostVersion'],
}
SOURCE_FILES = ('rain_residual.py', *previous.SOURCE_FILES)


# snapshot inherited inputs without running or replacing the previous experiment
def prepare(source, root, retention_receipt):
    previous.prepare(source, root, retention_receipt)
    destination = root / 'residual-sources'
    destination.mkdir(mode=0o700)
    hashes = {}
    # freeze this new learner separately from the reused input-schema contract
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, destination / name)
        hashes[name] = previous.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'sourceSha256': hashes, 'inputSchemaFreezeSha256': previous.sha(root / 'freeze.json'), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    previous.write_json(root / 'experiment-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# bind new model policy and unchanged inherited input material
def validate_freeze(root):
    previous.validate_freeze(root)
    freeze = json.loads((root / 'experiment-freeze.json').read_text())
    # reject an altered model contract or input-schema identity
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['inputSchemaFreezeSha256'] != previous.sha(root / 'freeze.json') or set(freeze['sourceSha256']) != set(SOURCE_FILES):
        raise ValueError('residual experiment freeze changed')
    # bind both running and retained new source bytes
    for name, expected in freeze['sourceSha256'].items():
        if previous.sha(Path(__file__).with_name(name)) != expected or previous.sha(root / 'residual-sources' / name) != expected:
            raise ValueError('residual implementation changed after freeze')
    return freeze


# count real support rather than overlapping forecast rows
def support(actual, hours):
    wet = actual >= .1
    return {'rows': len(hours), 'dates': len(np.unique(hours // 24)), 'hours': len(np.unique(hours)), 'wetDates': len(np.unique(hours[wet] // 24)), 'wetHours': len(np.unique(hours[wet]))}


# keep unsupported monthly cells explicit
def supported(counts, minimum):
    return all(counts[name] >= value for name, value in minimum.items())


# correct the raw amount without a probability multiplier or raw event floor
def residual_base(raw, delta):
    raw, delta = np.asarray(raw, dtype=float), np.asarray(delta, dtype=float)
    # reject invalid predictions before any clipping can conceal them
    if raw.shape != delta.shape or not np.isfinite(raw).all() or not np.isfinite(delta).all() or (raw < 0).any():
        raise ValueError('invalid raw or signed rain residual')
    return np.clip(raw + POLICY['residualWeight'] * delta, 0, POLICY['maximumRainMmPerHour'])


# solve the final clipped calibration curve using only earlier labels
def calibrate(actual, base, hours):
    actual, base = np.asarray(actual, dtype=float), np.asarray(base, dtype=float)
    # require complete aligned nonnegative calibration data
    if actual.shape != base.shape or actual.shape != hours.shape or not len(hours) or not np.isfinite(actual).all() or not np.isfinite(base).all() or (actual < 0).any() or (base < 0).any():
        raise ValueError('invalid residual calibration arrays')
    weight = weights(hours)
    target = float(weight @ actual)
    policy = POLICY['calibration']
    tolerance = policy['absoluteTolerance'] + policy['relativeTolerance'] * abs(target)
    lower, upper = policy['scaleBounds']

    # project before measuring the attainable balanced mean
    def mean(scale):
        return float(weight @ np.clip(base * scale, 0, POLICY['maximumRainMmPerHour']))

    low_mean, high_mean = mean(lower), mean(upper)
    result = {'supported': False, 'scale': None, 'reason': None, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'tolerance': tolerance, 'achievedMean': None}
    # flat curves contain no information for a volume adjustment
    if high_mean - low_mean <= tolerance:
        return {**result, 'reason': 'flat_calibration_curve'}
    # out-of-range targets cannot be rescued by numerical tolerance
    if target < low_mean or target > high_mean:
        return {**result, 'reason': 'target_outside_attainable_range'}
    # preserve a sufficient unit scale without unnecessary correction
    if abs(mean(1.) - target) <= tolerance:
        scale = 1.
    else:
        # bracket one monotone root without reading evaluation outcomes
        for _ in range(policy['iterations']):
            midpoint = (lower + upper) / 2
            if mean(midpoint) < target:
                lower = midpoint
            else:
                upper = midpoint
        scale = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
    achieved = mean(scale)
    # fail closed when the frozen numerical solve is inadequate
    if abs(achieved - target) > tolerance:
        return {**result, 'reason': 'root_residual_above_tolerance'}
    return {**result, 'supported': True, 'scale': scale, 'reason': 'calibrated', 'achievedMean': achieved}


# fit exactly one monthly signed residual head with no hyperparameter search
def fit_month(root, data, month):
    fit, calibration, evaluation, bounds = month_masks(data, month)
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(data['actual'][calibration], data['hour'][calibration])}
    directory = root / 'residual-models' / month
    directory.mkdir(parents=True, mode=0o700)
    state = {**bounds, 'support': counts, 'parameters': PARAMETERS, 'featureNames': list(FEATURE_NAMES), 'modelSha256': None, 'trainingMaximumActualHour': None, 'supported': False, 'reason': 'insufficient_training_support', 'calibration': None}
    raw = data['raw'][evaluation].astype(float)
    recent = data['persistence'][evaluation]
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_state['scales']['raw'], 'uncalibratedResidual': raw.copy(), 'residualAmount': raw.copy()}
    # require the frozen native runtime even when a monthly state falls back
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected residual learner runtime')
    # unsupported models preserve every evaluation row with exact raw values
    if supported(counts['training'], POLICY['trainingSupport']):
        training = xgb.DMatrix(data['x'][fit], label=data['actual'][fit] - data['raw'][fit], weight=weights(data['hour'][fit]) * int(fit.sum()), feature_names=list(FEATURE_NAMES), nthread=1)
        booster = xgb.train(PARAMETERS, training, num_boost_round=POLICY['boostRounds'])
        model_path = directory / 'residual.json'
        booster.save_model(model_path)
        state['modelSha256'] = previous.sha(model_path)
        state['trainingMaximumActualHour'] = int(data['hour'][fit].max())
        evaluation_matrix = xgb.DMatrix(data['x'][evaluation], feature_names=list(FEATURE_NAMES), nthread=1)
        output['uncalibratedResidual'] = residual_base(raw, booster.predict(evaluation_matrix))
        state['reason'] = 'insufficient_calibration_support'
        # no calibration labels are borrowed from development evaluation
        if supported(counts['calibration'], POLICY['calibrationSupport']):
            calibration_matrix = xgb.DMatrix(data['x'][calibration], feature_names=list(FEATURE_NAMES), nthread=1)
            base = residual_base(data['raw'][calibration], booster.predict(calibration_matrix))
            state['calibration'] = calibrate(data['actual'][calibration], base, data['hour'][calibration])
            state['supported'] = state['calibration']['supported']
            state['reason'] = state['calibration']['reason']
            # apply the earlier scalar only when its full feasibility test passes
            if state['supported']:
                output['residualAmount'] = np.clip(output['uncalibratedResidual'] * state['calibration']['scale'], 0, POLICY['maximumRainMmPerHour'])
    previous.write_json(directory / 'state.json', state)
    return np.where(evaluation)[0], output, state


# adapt the candidate key to the unchanged frozen performance-screen interface
def screen_alias(value):
    # preserve scalar values and policy lists without altering their contents
    if not isinstance(value, dict):
        return value
    return {('eventGuard' if key == 'residualAmount' else key): screen_alias(item) for key, item in value.items()}


# replace only algorithm-specific guarantees while retaining empirical safety
def development_gates(report):
    compatible = screen_alias(report)
    compatible['invariants'] = {'rawHeavyAmountsUnchanged': False, 'rawWetCallsPreserved': False}
    gates = previous.development_gates(compatible)
    # raw-amount locks are not requirements of this new learner
    for name in POLICY['replacedStructuralGates']:
        gates.pop(name)
    gates['finiteNonnegative'] = report['invariants']['finiteNonnegative']
    gates['candidateSupport'] = report['support']['dates'] >= POLICY['candidateSupport']['dates'] and report['support']['wetDates'] >= POLICY['candidateSupport']['wetDates']
    return gates


# score a fixed replay without selecting favorable models or dates
def build_report(root, data, indices, predictions, candidate_supported, states):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # score identical rows for every arm and target sensitivity
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': previous.sha(root / 'experiment-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    calendar = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in calendar])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # keep season, source-era, lead and month partitions regardless of outcomes
    for field, groups in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in calendar])), ('byArchiveEra', era)):
        report[field] = {}
        for key in np.unique(groups):
            report[field][str(key)] = summarize(groups == key)
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: previous.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['support'] = support(actual[candidate_supported], hours[candidate_supported])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['developmentGates'] = development_gates(report)
    report['developmentPassed'] = all(report['developmentGates'].values())
    report['decision'] = 'eligible_for_separate_prospective_protocol_not_qualified' if report['developmentPassed'] else 'rejected_development_no_retuning_or_prospective_unlock'
    return report


# run the new monthly learner once against the frozen consumed development year
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # interrupted fits remain evidence instead of being silently replaced
    if (root / 'residual-models').exists() or (root / 'report.json').exists() or (root / 'predictions.npz').exists():
        raise ValueError('residual replay already exists')
    data = previous.load_inputs(root)
    indices, flags, states = [], [], {}
    predictions = {name: [] for name in ARMS}
    # evaluate the one predeclared model in each chronological month
    for month in MONTHS:
        rows, output, state = fit_month(root, data, month)
        indices.append(rows)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        # retain all controls and diagnostics without selecting among them
        for name in ARMS:
            predictions[name].append(output[name])
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported'], 'reason': state['reason']}), flush=True)
    indices, candidate_supported = np.concatenate(indices), np.concatenate(flags)
    predictions = {name: np.concatenate(parts) for name, parts in predictions.items()}
    report = build_report(root, data, indices, predictions, candidate_supported, states)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, supported=candidate_supported, **{f'amount::{name}': values for name, values in predictions.items()})
    report['predictionsSha256'] = previous.sha(root / 'predictions.npz')
    previous.write_json(root / 'report.json', report)
    return {'developmentPassed': report['developmentPassed'], 'failedGates': [name for name, passed in report['developmentGates'].items() if not passed], 'support': report['support'], 'productionEligible': False, 'independentEvaluationPerformed': False}


# require explicit preparation or execution instead of import-time computation
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('source', type=Path)
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--retention-receipt', type=Path, required=True)
    execution = commands.add_parser('run')
    execution.add_argument('root', type=Path)
    args = parser.parse_args()
    result = prepare(args.source, args.root, args.retention_receipt) if args.command == 'prepare' else run(args.root)
    print(json.dumps(result), flush=True)
