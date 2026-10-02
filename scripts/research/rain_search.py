"""run a frozen multi-family development search without reopening a holdout."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil

# limit native numerical parallelism
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_event_guard as inputs
import rain_ordinal as ordinal
import rain_residual as residual
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score, weights

CANDIDATES = {
    'ordinalAmount': {'family': 'ordinal_gamma'},
    'weightedModerate': {'family': 'weighted_tweedie', 'rainWeights': [1., 2., 4.]},
    'weightedStrong': {'family': 'weighted_tweedie', 'rainWeights': [1., 3., 6.]},
}
BASELINES = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90')
PARAMETERS = {**PARENT_POLICY['treeParameters'], 'seed': 20260913}
POLICY = {
    'contractVersion': 'rain-development-search/v1',
    'candidates': CANDIDATES,
    'developmentMonths': list(inputs.MONTHS),
    'developmentDataPreviouslyConsumed': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'parameters': PARAMETERS,
    'boostRounds': 160,
    'rawBlend': .25,
    'maximumRainMmPerHour': 30.,
    'calibrationDays': 90,
    'embargoDays': 7,
    'calibrationScaleBounds': [.1, 3.],
    'calibrationIterations': 64,
    'calibrationTolerance': {'absolute': 1e-10, 'relative': 1e-8},
    'unattainableCalibration': 'nearest_bounded_endpoint_applied_and_explicitly_reported_not_claimed_matched',
    'trainingSupport': residual.POLICY['trainingSupport'],
    'calibrationSupport': {'dates': 60, 'hours': 500, 'wetDates': 5, 'wetHours': 20},
    'candidateSupport': residual.POLICY['candidateSupport'],
    'thresholdsMmPerHour': inputs.POLICY['thresholdsMmPerHour'],
    'screen': inputs.POLICY['screen'],
    'selection': 'all_44_residual_gates_plus_same_window_baseline_then_mae_name_tiebreak_else_none',
    'ordinalThresholdPolicy': {'recallMargin': .05, 'maximumFarDelta': .05, 'minimumCsiDelta': -.01, 'minimumCalibrationPositiveHours': [10, 5, 3], 'minimumCalibrationPositiveDates': 2, 'minimumTrainingPositiveHours': 10, 'minimumTrainingPositiveDates': 3, 'minimumAmountWetHours': 100, 'minimumAmountWetDates': 20, 'missingSupport': 'raw_event_at_that_threshold', 'missingAmount': 'reject_inconsistent_training_support'},
    'ordinalNestingSafety': 'check_composite_pod_at_least_raw_far_plus_0.05_csi_minus_0.01_else_all_raw_rules_null_metrics_zero',
    'prospectiveEvaluation': inputs.POLICY['prospectiveEvaluation'],
    'probability': 'deterministic_point_events_for_screen_not_a_probability_calibration_claim',
    'xgboostVersion': PARENT_POLICY['xgboostVersion'],
}
SOURCE_FILES = ('rain_search.py', 'rain_ordinal.py', *residual.SOURCE_FILES)


# reuse verified source acquisition while freezing a separate search policy
def prepare(source, root, receipt):
    inputs.prepare(source, root, receipt)
    directory = root / 'search-sources'
    directory.mkdir(mode=0o700)
    hashes = {}
    # preserve exact new and inherited runtime source bytes
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, directory / name)
        hashes[name] = inputs.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'sourceSha256': hashes, 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'search-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# reject policy or input changes after the search is opened
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'search-freeze.json').read_text())
    # bind the full predeclared candidate set
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or set(freeze['sourceSha256']) != set(SOURCE_FILES):
        raise ValueError('rain search freeze changed')
    # bind current and retained implementations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'search-sources' / name) != expected:
            raise ValueError('rain search implementation changed after freeze')
    return freeze


# isolate training, ninety-day calibration and target-month decisions
def month_masks(data, month):
    start = hour_number(month + '-01T00:00:00Z')
    date = dt.datetime.fromtimestamp(start * 3600, dt.timezone.utc)
    stop = int(((date.replace(day=28) + dt.timedelta(days=4)).replace(day=1)).timestamp() // 3600)
    calibration_stop = start - 7 * 24
    calibration_start = calibration_stop - 90 * 24
    fit_stop = calibration_start - 7 * 24
    fit = (data['hour'] >= hour_number(PARENT_POLICY['trainingStartUtc'])) & (data['hour'] < fit_stop)
    calibration = (data['hour'] >= calibration_start) & (data['hour'] < calibration_stop)
    decision = data['initialized'] + PARENT_POLICY['decisionDelayHours']
    evaluation = (decision >= start) & (decision < stop)
    return fit, calibration, evaluation, {'month': month, 'trainingMaximumValidHourExclusive': fit_stop, 'calibrationStartHour': calibration_start, 'calibrationMaximumValidHourExclusive': calibration_stop, 'decisionStartHour': start, 'decisionStopHourExclusive': stop}


# emphasize observed rain without changing total regularization weight
def cost_weights(actual, hours, costs):
    cost = np.where(actual >= 1, costs[2], np.where(actual >= .1, costs[1], costs[0]))
    value = weights(hours) * cost
    return value * len(actual) / value.sum()


# select a bounded scalar on the final amount map rather than before projection
def calibrate(actual, hours, projection):
    actual, hours = np.asarray(actual, dtype=float), np.asarray(hours)
    # reject empty or invalid calibration populations
    if actual.ndim != 1 or not len(actual) or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid search calibration population')
    weight = weights(hours)
    target = float(weight @ actual)
    lower, upper = POLICY['calibrationScaleBounds']
    tolerance = 1e-10 + 1e-8 * abs(target)

    # retain an explicit final-output calibration curve
    def mean(scale):
        predicted = projection(scale)
        # reject invalid final-output projections
        if predicted.shape != actual.shape or not np.isfinite(predicted).all() or (predicted < 0).any():
            raise ValueError('invalid search calibration projection')
        return float(weight @ predicted)

    low_mean, high_mean = mean(lower), mean(upper)
    # select a reported endpoint when exact matching is impossible
    if target < low_mean:
        scale, status = lower, 'saturated_low'
    elif target > high_mean:
        scale, status = upper, 'saturated_high'
    elif abs(mean(1.) - target) <= tolerance:
        scale, status = 1., 'matched'
    else:
        # bisect only a bracketed monotone response
        for _ in range(POLICY['calibrationIterations']):
            midpoint = (lower + upper) / 2
            # retain the bracket containing the target mean
            if mean(midpoint) < target:
                lower = midpoint
            else:
                upper = midpoint
        scale = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
        status = 'matched' if abs(mean(scale) - target) <= tolerance else 'unmatched_numeric'
    achieved = mean(scale)
    return {'scale': scale, 'status': status, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'achievedMean': achieved, 'residual': achieved - target, 'tolerance': tolerance}


# construct physical amount predictions with fixed raw anchoring
def blended(raw, learned):
    return np.clip(.25 * raw + .75 * learned, 0, 30)


# validate the actual nested calls rather than only separate classifier heads
def checked_rules(actual, raw, probabilities, hours, rules):
    categories = ordinal.event_categories(raw, probabilities, rules)
    projected = ordinal.project_amount(np.ones(len(raw)), categories, 1.)
    proposed = inputs.event_scores(actual, projected, hours)
    baseline = inputs.event_scores(actual, raw, hours)
    safe = all((proposed[key]['pod'] or 0.) + 1e-12 >= (baseline[key]['pod'] or 0.) and (proposed[key]['far'] or 0.) <= (baseline[key]['far'] or 0.) + .05 + 1e-12 and (proposed[key]['csi'] or 0.) + 1e-12 >= (baseline[key]['csi'] or 0.) - .01 for key in baseline)
    # use one deterministic full raw-call fallback instead of tuning head subsets
    if not safe:
        return [{**rule, 'cutoff': None, 'reason': 'nesting_safety_fallback'} for rule in rules], True
    return rules, False


# fit each direct amount arm independently with its prespecified label costs
def fit_weighted(data, fit, calibration, evaluation, directory, costs):
    parameters = {**PARAMETERS, 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(data['x'][fit], label=data['actual'][fit], weight=cost_weights(data['actual'][fit], data['hour'][fit], costs), feature_names=list(FEATURE_NAMES), nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=POLICY['boostRounds'])
    path = directory / 'amount.json'
    booster.save_model(path)
    output = {}
    # preserve the exact calibration and evaluation prediction populations
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(data['x'][mask], feature_names=list(FEATURE_NAMES), nthread=1)
        output[name] = blended(data['raw'][mask].astype(float), np.clip(booster.predict(matrix).astype(float), 0, 30))
    return output, {'parameters': parameters, 'rainWeights': costs, 'modelSha256': inputs.sha(path)}


# run one chronological month with every candidate on the same rows
def fit_month(root, data, month):
    fit, calibration, evaluation, bounds = month_masks(data, month)
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(data['actual'][calibration], data['hour'][calibration])}
    raw, actual, hours = data['raw'][evaluation].astype(float), data['actual'][calibration], data['hour'][calibration]
    recent = data['persistence'][evaluation]
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_state['scales']['raw']}
    # keep a same-window stronger baseline alongside the unchanged old control
    raw_cal = data['raw'][calibration].astype(float)
    raw_scale = calibrate(actual, hours, lambda scale: np.clip(scale * raw_cal, 0, 30))
    output['volume90'] = np.clip(raw * raw_scale['scale'], 0, 30)
    state = {**bounds, 'support': counts, 'rawCalibration': raw_scale, 'candidates': {}}
    available = residual.supported(counts['training'], POLICY['trainingSupport']) and residual.supported(counts['calibration'], POLICY['calibrationSupport'])
    directory = root / 'search-models' / month
    directory.mkdir(parents=True, mode=0o700)
    # reject native runtime changes even on raw-fallback months
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected rain search runtime')
    # retain unsupported monthly rows without manufacturing predictions
    if not available:
        for name in CANDIDATES:
            output[name] = raw.copy()
            state['candidates'][name] = {'supported': False, 'reason': 'insufficient_training_or_calibration_support'}
    else:
        # fit the two cost-sensitive amount heads without searching weights
        for name, specification in CANDIDATES.items():
            if specification['family'] != 'weighted_tweedie':
                continue
            destination = directory / name
            destination.mkdir(mode=0o700)
            estimates, model_state = fit_weighted(data, fit, calibration, evaluation, destination, specification['rainWeights'])
            scalar = calibrate(actual, hours, lambda scale: np.clip(estimates['calibration'] * scale, 0, 30))
            output[name] = np.clip(estimates['evaluation'] * scalar['scale'], 0, 30)
            state['candidates'][name] = {'supported': True, 'model': model_state, 'calibration': scalar}
        destination = directory / 'ordinalAmount'
        destination.mkdir(mode=0o700)
        models, model_state = ordinal.fit_models(data['x'][fit], data['actual'][fit], data['hour'][fit], destination, PARAMETERS, POLICY['boostRounds'])
        # global wet-support requirements must also support the gamma head
        if models['amount'] is None:
            raise ValueError('ordinal amount support disagrees with global training support')
        probabilities_cal, amount_cal = ordinal.predict(models, data['x'][calibration])
        probabilities_eval, amount_eval = ordinal.predict(models, data['x'][evaluation])
        proposed_rules = ordinal.calibrate_events(actual, raw_cal, probabilities_cal, hours)
        rules, nesting_fallback = checked_rules(actual, raw_cal, probabilities_cal, hours, proposed_rules)
        categories_cal = ordinal.event_categories(raw_cal, probabilities_cal, rules)
        categories_eval = ordinal.event_categories(raw, probabilities_eval, rules)
        base_cal = blended(raw_cal, amount_cal)
        scalar = calibrate(actual, hours, lambda scale: ordinal.project_amount(base_cal, categories_cal, scale))
        output['ordinalAmount'] = ordinal.project_amount(blended(raw, amount_eval), categories_eval, scalar['scale'])
        state['candidates']['ordinalAmount'] = {'supported': True, 'model': model_state, 'proposedRules': proposed_rules, 'rules': rules, 'nestingSafetyFallback': nesting_fallback, 'calibration': scalar, 'compositeCalibrationEvents': inputs.event_scores(actual, ordinal.project_amount(base_cal, categories_cal, scalar['scale']), hours)}
    inputs.write_json(directory / 'state.json', state)
    return np.where(evaluation)[0], output, state


# translate a candidate name only at the frozen empirical-screen boundary
def rename_candidate(value, candidate):
    if not isinstance(value, dict):
        return value
    return {('residualAmount' if key == candidate else key): rename_candidate(item, candidate) for key, item in value.items()}


# screen all arms independently and select only a complete gate-passer
def candidate_screens(report, data, indices, flags):
    screens = {}
    # never choose a favorable subset of seasons or candidate-supported rows
    for name in CANDIDATES:
        supported = flags[name]
        counts = residual.support(data['actual'][indices][supported], data['hour'][indices][supported])
        view = rename_candidate(report, name)
        view['support'] = counts
        view['invariants'] = {'finiteNonnegative': report['invariants']['finiteNonnegative']}
        gates = residual.development_gates(view)
        gates['beatsSameWindowVolumeScale'] = report['overall'][name]['mae'] <= report['overall']['volume90']['mae']
        screens[name] = {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [key for key, value in gates.items() if not value]}
    passing = [name for name in CANDIDATES if screens[name]['passed']]
    selected = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, selected


# retain complete scores for every predeclared candidate and control
def make_report(root, data, indices, predictions, flags, states):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # preserve equal date-hour-vintage weights for each metric population
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'search-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in dates])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # keep each complete reporting partition regardless of outcome
    for field, labels in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {}
        for key in np.unique(labels):
            report[field][str(key)] = summarize(labels == key)
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['candidateScreens'], report['selectedCandidate'] = candidate_screens(report, data, indices, flags)
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    return report


# execute the full frozen matrix once rather than retrying individual failures
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # never overwrite an existing search artifact
    if any((root / name).exists() for name in ('search-models', 'report.json', 'predictions.npz')):
        raise ValueError('search replay already exists')
    data = inputs.load_inputs(root)
    indices, states = [], {}
    amounts = {name: [] for name in (*BASELINES, *CANDIDATES)}
    flags = {name: [] for name in CANDIDATES}
    # fit every prespecified month before comparing candidates
    for month in POLICY['developmentMonths']:
        rows, output, state = fit_month(root, data, month)
        indices.append(rows)
        states[month] = state
        for name in amounts:
            amounts[name].append(output[name])
        for name in flags:
            flags[name].append(np.full(len(rows), state['candidates'][name]['supported'], dtype=bool))
        print(json.dumps({'month': month, 'rows': len(rows), 'trainedCandidates': [name for name in CANDIDATES if state['candidates'][name]['supported']]}), flush=True)
    indices = np.concatenate(indices)
    amounts = {name: np.concatenate(parts) for name, parts in amounts.items()}
    flags = {name: np.concatenate(parts) for name, parts in flags.items()}
    report = make_report(root, data, indices, amounts, flags, states)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{f'amount::{name}': value for name, value in amounts.items()}, **{f'supported::{name}': value for name, value in flags.items()})
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreens': report['candidateScreens'], 'productionEligible': False, 'independentEvaluationPerformed': False}


# run only an explicit preparation or model-search command
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest='command', required=True)
    preparation = subcommands.add_parser('prepare')
    preparation.add_argument('source', type=Path)
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--retention-receipt', type=Path, required=True)
    execution = subcommands.add_parser('run')
    execution.add_argument('root', type=Path)
    arguments = parser.parse_args()
    result = prepare(arguments.source, arguments.root, arguments.retention_receipt) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result), flush=True)
