"""test one constrained refit of the frozen wind-vector rain hurdle."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# retain the original single-thread native execution boundary
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import rain_wind as parent
import xgboost as xgb
from rain_hurdle import copy_member
from rain_sub24 import FEATURE_NAMES

inputs = parent.inputs
search = parent.search
ROOT_NAME = 'weather-moisture-research-rain-monotone-20260913-v1'
PRIMARY = 'hurdleWindMonotoneRaw'
ARMS = (*parent.ARMS[:-1], 'windOriginal', PRIMARY)
PARENT_PINS = {
    'wind-freeze.json': 'b80c0c6b18b9c026978e1947db734cdbf5ac2b6ae3dc1ff7dce0974493c5d9b8',
    'report.json': 'f3d6c2d570b2029093b288f21e9e62ce0c896f0956b2f06ce6ada9673dfda56a',
    'predictions.npz': 'ff2f2040acd674ba3881e58b9e3337eaf393ce73f71185fd102992c9f0368f1e',
    'retention-manifest.json': '2a2739f9d72b9d9fef29c3108764dcc70a124c683f6fe28dd4232f60561440eb',
}
# constrain both deterministic representations of issued current-lead rain
CONSTRAINTS = tuple(1 if index in (5, 6) else 0 for index in range(107))
LIVE_CONSTRAINT_CONFIG = '(' + ','.join(map(str, CONSTRAINTS)) + ')'
FIT_PARAMETERS = {**parent.context.PARAMETERS, 'monotone_constraints': CONSTRAINTS}
# require the two physical rain columns at the frozen 107-feature indices
if len(parent.POLICY['featureNames']) != 107 or parent.POLICY['featureNames'][5:7] != ['rawRain', 'log1pRawRain']:
    raise ValueError('monotone rain feature positions changed')

POLICY = {
    **parent.POLICY,
    'contractVersion': 'rain-wind-monotone-exploratory/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'parentPins': PARENT_PINS,
    'parameters': {**parent.POLICY['parameters'], 'monotone_constraints': list(CONSTRAINTS)},
    'monotoneConstraints': list(CONSTRAINTS),
    'monotoneFeatureNames': ['rawRain', 'log1pRawRain'],
    'monotoneHeads': ['0.1', '1.0', '2.5', 'amount'],
    'treeFitPerformed': True,
    'nativeModelsFit': 48,
    'nativeModelsReused': 0,
    'maxBin': 'unchanged_native_default_256',
    'fitWeight': parent.POLICY['fitWeight'],
    'calibrationAlgorithm': parent.POLICY['calibrationAlgorithm'],
    'unsupportedMonthly': parent.POLICY['unsupportedMonthly'],
    'exploratoryOnly': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'selection': 'one_exploratory_raw_rain_monotone_refit_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_monotone.py', *parent.SOURCE_FILES)))


# freeze the exact failed wind experiment and its encrypted retention proof
def prepare(source, root, receipt_path):
    source, root = parent.validate_private_root(source), Path(root)
    # reject an alternate parent cohort or an output outside the private sibling
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected monotone research root')
    parent.validate_freeze(source)
    manifest = parent.retained_manifest(source, receipt_path)
    # bind all already disclosed parent results before another causal fit
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('monotone parent identity changed')
    proof = json.loads((source / 'final-evidence/independent-verification-final.json').read_text())
    # require a complete independent replay of the prior failed model
    if (manifest['reportSha256'] != PARENT_PINS['report.json'] or proof.get('verified') is not True or proof.get('all49GatesVerified') is not True or proof.get('reportSha256') != PARENT_PINS['report.json'] or proof.get('predictionsSha256') != PARENT_PINS['predictions.npz']):
        raise ValueError('monotone parent is not independently retained')
    root.mkdir(mode=0o700)
    parent.validate_private_root(root)
    hashes = {}
    # preserve the parent schema, acquisition, predictors and model-control bytes
    for name, entry in manifest['files'].items():
        if name in ('freeze.json', 'hurdle-freeze.json', 'trajectory-freeze.json', 'wind-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/', 'trajectory-sources/', 'wind-sources/', 'wind-models/', 'wind-states/')):
            parent.copy_input(source, root, name, name, entry['sha256'], hashes)
    # retain the previous forecast and scoring artifacts as explicit controls
    for name in ('report.json', 'predictions.npz', 'features.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json'):
        expected = inputs.sha(source / name) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        parent.copy_input(source, root, name, 'inputs/wind/' + name, expected, hashes)
    relative = 'inputs/wind/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    directory = root / 'monotone-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # snapshot every executing local source before the new outcome is scored
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'wind-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'monotone-freeze.json', freeze)
    return validate_freeze(root)


# bind the fixed constraint and all inherited source and model-control bytes
def validate_freeze(root):
    root = parent.validate_private_root(root)
    # no other private experiment can impersonate the monotone output
    if root.name != ROOT_NAME:
        raise ValueError('monotone root changed')
    parent.validate_freeze(root)
    freeze = json.loads((root / 'monotone-freeze.json').read_text())
    # reject any altered policy, model source or pre-outcome boundary
    if (freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['wind-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['priorOutcomesAlreadyKnown'] is not True or freeze['productionWrites'] is not False):
        raise ValueError('monotone freeze changed')
    # compare retained producer copies with currently executing local code
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'monotone-sources' / name) != expected:
            raise ValueError('monotone producer source changed')
    # prohibit path escapes and source replacements in the copied envelope
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('monotone input changed')
    return freeze


# prove each freshly trained booster used the constraint before serialization
def validate_live_model(booster, objective, names, rounds):
    configuration = json.loads(booster.save_config())
    observed = configuration['learner']['gradient_booster']['tree_train_param']['monotone_constraints']
    # saved model reloads do not preserve this training-only configuration
    if (observed != LIVE_CONSTRAINT_CONFIG or configuration['learner']['objective']['name'] != objective or booster.feature_names != list(names) or booster.num_boosted_rounds() != rounds):
        raise ValueError('native monotone training configuration changed')
    return observed


# refit the same three logistic tails and wet gamma with one shape prior
def fit_monotone(x, actual, hours, directory, names, rounds):
    x, actual, hours = np.asarray(x, dtype=np.float32), np.asarray(actual, dtype=np.float64), np.asarray(hours)
    # preserve the exact native matrix and source label contract
    if (x.ndim != 2 or x.shape[1] != 107 or list(names) != POLICY['featureNames'] or actual.shape != (len(x),) or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not len(x) or np.isinf(x).any() or not np.isfinite(actual).all() or (actual < 0).any() or type(rounds) is not int or rounds <= 0 or xgb.__version__ != POLICY['xgboostVersion'] or 'base_score' in FIT_PARAMETERS):
        raise ValueError('invalid monotone native fit inputs')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    models = {}
    state = {'featureNames': list(names), 'rounds': rounds, 'monotoneConstraints': list(CONSTRAINTS), 'heads': {}}
    # apply the identical learner change to all three event thresholds
    for threshold, name, filename in zip(parent.ordinal.THRESHOLDS, parent.ordinal.HEAD_NAMES, parent.ordinal.MODEL_FILES[:3]):
        support = parent.ordinal._support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support', 'liveMonotoneConstraints': None}
        models[name] = None
        # preserve the prior per-head minimum support without cherry-picking rows
        if support['positiveHours'] >= 10 and support['positiveDates'] >= 3:
            matrix = xgb.DMatrix(x, label=(actual >= threshold).astype(np.float32), weight=parent.context.weights(hours) * len(hours), feature_names=list(names), nthread=1)
            booster = xgb.train({**FIT_PARAMETERS, 'objective': 'binary:logistic'}, matrix, num_boost_round=rounds)
            observed = validate_live_model(booster, 'binary:logistic', names, rounds)
            path = directory / filename
            booster.save_model(path)
            head.update({'modelFile': filename, 'sha256': inputs.sha(path), 'reason': 'fitted', 'liveMonotoneConstraints': observed})
            models[name] = booster
        state['heads'][name] = head
    wet = actual >= parent.ordinal.THRESHOLDS[0]
    support = parent.ordinal._support(actual, hours, parent.ordinal.THRESHOLDS[0])
    amount = {'objective': 'reg:gamma', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support', 'liveMonotoneConstraints': None}
    models['amount'] = None
    # retain conditional gamma fitting only on its original positive-label slice
    if support['positiveHours'] >= 100 and support['positiveDates'] >= 20:
        matrix = xgb.DMatrix(x[wet], label=actual[wet], weight=parent.context.weights(hours[wet]) * int(wet.sum()), feature_names=list(names), nthread=1)
        booster = xgb.train({**FIT_PARAMETERS, 'objective': 'reg:gamma'}, matrix, num_boost_round=rounds)
        observed = validate_live_model(booster, 'reg:gamma', names, rounds)
        path = directory / parent.ordinal.MODEL_FILES[3]
        booster.save_model(path)
        amount.update({'modelFile': path.name, 'sha256': inputs.sha(path), 'reason': 'fitted', 'liveMonotoneConstraints': observed})
        models['amount'] = booster
    state['heads']['amount'] = amount
    return models, state


# preserve all monthly chronology, scores and fallback behavior around the refit
def fit_month(root, data, x, month, control):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    counts = {'training': parent.residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': parent.residual.support(actual, hours)}
    mass = parent.recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = parent.recent.effective_support(actual, hours, mass)
    supported = parent.residual.supported(counts['training'], POLICY['trainingSupport']) and parent.residual.supported(counts['calibration'], POLICY['calibrationSupport']) and parent.residual.supported(effective, POLICY['effectiveSupport'])
    inherited = root / 'wind-states' / (month + '.json')
    retained = json.loads(inherited.read_text())
    # the constrained refit cannot change parent month support or label bounds
    if any(retained[key] != value for key, value in bounds.items()) or retained['support'] != counts or retained['effectiveSupport'] != effective or retained['supported'] != bool(supported):
        raise ValueError('monotone parent monthly chronology changed')
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': bool(supported), 'model': None, 'parentStateSha256': inputs.sha(inherited), 'proposedRules': None, 'uniformRules': None, 'nestingSafetyFallback': None, 'calibration': None, 'reason': 'insufficient_support'}
    rows = np.where(evaluation)[0]
    # unsupported months retain the complete original ordinal90 forecast
    if not supported:
        return rows, control.copy(), state
    directory = root / 'monotone-models' / month
    directory.mkdir(parents=True, mode=0o700)
    models, model_state = fit_monotone(x[fit], data['actual'][fit], data['hour'][fit], directory, POLICY['featureNames'], POLICY['boostRounds'])
    # original supported months require the same wet gamma head
    if models['amount'] is None:
        raise ValueError('monotone wet amount support differs from parent')
    pc, ac = parent.context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, ae = parent.context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    proposed = parent.ordinal.calibrate_events(actual, raw_cal, pc, hours)
    rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
    fitted = parent.hurdle.calibrate(actual, hours, raw_cal, pc, search.blended(raw_cal, ac), rules, bounds['calibrationMaximumValidHourExclusive'])
    predicted = parent.hurdle.predict(raw, pe, search.blended(raw, ae), fitted)
    state.update({'model': model_state, 'proposedRules': proposed, 'uniformRules': rules, 'nestingSafetyFallback': fallback, 'calibration': fitted, 'reason': 'monotone_wind_hurdle_calibrated'})
    return rows, predicted, state


# reuse the original 49-gate screen with only the primary name changed
def make_report(root, data, indices, predictions, supported, states):
    # rename only the newly fitted primary before the frozen shared screen
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = parent.parent.rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    # count the constrained heads actually fitted, never inherited controls
    model_count = sum(sum(head['modelFile'] is not None for head in state['model']['heads'].values()) for state in states.values() if state['model'] is not None)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'monotone-freeze.json'), 'treeFitPerformed': True, 'nativeModelsFit': model_count, 'nativeModelsReused': 0, 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None, 'exploratoryOnly': True})
    return report


# refit all twelve months once before inspecting any new score
def run(root):
    root = parent.validate_private_root(root)
    validate_freeze(root)
    # partial output is retained evidence and never permission for another trial
    if any((root / name).exists() for name in ('monotone-models', 'monotone-states', 'features.npz', 'report.json', 'predictions.npz')):
        raise ValueError('monotone experiment already attempted')
    data = inputs.load_inputs(root)
    source_features = root / 'inputs/wind/features.npz'
    with np.load(source_features, allow_pickle=False) as saved:
        x = saved['x']
        wind_available = saved['windVectorAvailable']
    # preserve all original predictor rows, missing values and column order
    if x.dtype != np.dtype(np.float32) or x.shape != (len(data['actual']), 107) or np.isinf(x).any() or wind_available.shape != (len(x),) or wind_available.dtype != np.dtype(bool):
        raise ValueError('monotone frozen feature schema changed')
    copy_member(source_features, root / 'features.npz', inputs.sha(source_features))
    with np.load(root / 'inputs/wind/predictions.npz', allow_pickle=False) as old:
        reference_indices = old['indices']
        predictions = {name: old['amount::' + name] for name in parent.ARMS[:-1]}
        predictions['windOriginal'] = old['amount::' + parent.PRIMARY]
    directory = root / 'monotone-states'
    directory.mkdir(mode=0o700)
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # preserve every original evaluation row and unsupported monthly fallback
    for month in inputs.MONTHS:
        _, _, mask, _ = search.month_masks(data, month)
        end = offset + int(mask.sum())
        rows, predicted, state = fit_month(root, data, x, month, predictions['ordinal90'][offset:end])
        # prevent an altered month population or control alignment
        if not np.array_equal(rows, reference_indices[offset:end]):
            raise ValueError('monotone month population changed')
        inputs.write_json(directory / (month + '.json'), state)
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        offset = end
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    # score only the full frozen population after all model outputs exist
    if offset != 32896 or len(np.unique(indices)) != offset or not np.array_equal(indices, reference_indices):
        raise ValueError('monotone evaluation population changed')
    predictions[PRIMARY] = np.concatenate(amounts)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, candidateSupported=supported)
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in parent.ARMS[:-1]}, 'windOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'features.npz')
    report['originalFeaturesSha256'] = inputs.sha(source_features)
    source_report = json.loads((root / 'inputs/direction/report.json').read_text())
    report['directionSourceSha256'] = source_report['normalizedSha256']
    report['directionSourceCoverage'] = {'unresolvedRuns': source_report['newUnresolvedRuns'], 'perMonthCoverage': source_report['perMonthCoverage']}
    report['windAvailability'] = {'evaluationRows': int(wind_available[indices].sum()), 'evaluationTotal': len(indices), 'featureColumns': 107}
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'productionEligible': False}


# separate immutable preparation from one exploratory model replay
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
