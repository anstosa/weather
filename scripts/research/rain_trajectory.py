"""test one forecast-tendency extension with unchanged uniform hurdle fitting."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# limit numerical work to the pinned single-thread CPU runtime
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import rain_context as context
import rain_context_features as features
import rain_event_guard as inputs
import rain_trajectory_features as tendency
import rain_hurdle as parent
import rain_hurdle_calibration as hurdle
import rain_ordinal as ordinal
import rain_recency as recency
import rain_recency_calibration as recent
import rain_residual as residual
import rain_search as search
from rain_sub24 import FEATURE_NAMES
from retain_moisture_research import validate_private_root

ROOT_NAME = 'weather-moisture-research-rain-trajectory-20260913-v1'
PRIMARY = 'hurdleTrajectory'
ARMS = (*recency.ARMS, 'hurdleOriginal', PRIMARY)
PARENT_PINS = {
    'hurdle-freeze.json': 'a4d25b08fbc9b19303d8193ef8e53ad2a86207d36ed491ea5d2ee6717d3ef7e1',
    'report.json': '34d46077d62b8f9eca69f57578a73e50ad5a685e10deba6ff7fe1645e4d266d2',
    'predictions.npz': 'a9dbc08b3499857213acfc2c67670ad110a5b3200b0ed48c54faaba9a03b93a9',
}
POLICY = {
    **parent.POLICY,
    'contractVersion': 'rain-trajectory-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'treeFitPerformed': True,
    'nativeModelsFit': 48,
    'nativeModelsReused': 0,
    'parentPins': PARENT_PINS,
    'boostRounds': 160,
    'featureNames': list(tendency.FEATURE_NAMES),
    'tendencyFeatures': list(tendency.TENDENCY_NAMES),
    'tendencyWindow': 'same_initialized_run_L=8+h;each_RH_cloud_wind_L_minus_Lminus3_and_Lplus3_minus_L',
    'missingTendencies': 'retain_nan_features_without_row_deletion_or_substituting_another_run',
    'fitWeight': 'uniform_equal_date_hour_vintage_normalized_to_fitted_row_count;gamma_rebalanced_within_observed_wet_subset',
    'fitWindow': 'all_original_fit_rows_no_rolling_cutoff_no_capacity_or_early_stopping_search',
    'heavyRules': 'uniform_calibrated_new_native_heads_then_preserved_within_hurdle_calibration;may_differ_from_prior_model_subject_unchanged_49_empirical_gates',
    'calibrationAlgorithm': 'exact_previous_hurdle_helper_applied_to_new_native_scores',
    'selection': 'single_preregistered_six_tendency_primary_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_trajectory.py', 'rain_trajectory_features.py', *parent.SOURCE_FILES)))


# snapshot the verified parent's input envelope without mutating its experiment
def prepare(source, root, receipt_path):
    source, root = validate_private_root(source), Path(root)
    # keep a distinct private sibling for this fixed training hypothesis
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected forecast-tendency experiment root')
    parent.validate_freeze(source)
    receipt = json.loads(Path(receipt_path).read_text())
    manifest_path = source / 'retention-manifest.json'
    # bind copied inputs to a completed local encrypted roundtrip
    if receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt['manifestSha256'] != inputs.sha(manifest_path) or Path(receipt['archive']).name != receipt['archive'] or inputs.sha(Path(receipt_path).parent / receipt['archive']) != receipt['cipherSha256']:
        raise ValueError('hurdle retention is not verified')
    manifest = json.loads(manifest_path.read_text())
    # freeze the known prior result rather than a mutable latest-candidate pointer
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('forecast-tendency parent identity changed')
    if manifest['reportSha256'] != PARENT_PINS['report.json']:
        raise ValueError('forecast-tendency parent manifest changed')
    root.mkdir(mode=0o700)
    validate_private_root(root)
    hashes = {}
    # inherit only the unchanged input and source schema envelopes
    for name, entry in manifest['files'].items():
        if name in ('freeze.json', 'hurdle-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/')):
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('unsafe parent manifest member')
            parent.copy_member(source / name, root / name, entry['sha256'])
            hashes[name] = entry['sha256']
    # retain the exact previous candidate as a nonselectable matched control
    for name in ('report.json', 'predictions.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json'):
        expected = inputs.sha(manifest_path) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        relative = 'inputs/hurdle/' + name
        parent.copy_member(source / name, root / relative, expected)
        hashes[relative] = expected
    relative = 'inputs/hurdle/parent-retention-receipt.json'
    parent.copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    directory = root / 'trajectory-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # retain every producer dependency before any new native fit or outcome
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        parent.copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'hurdle-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'trajectory-freeze.json', freeze)
    return validate_freeze(root)


# bind the exact new feature policy to inherited data and current source bytes
def validate_freeze(root):
    parent.validate_freeze(root)
    freeze = json.loads((root / 'trajectory-freeze.json').read_text())
    # retain the pre-outcome model contract and original data schema
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['hurdle-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('forecast-tendency freeze changed')
    # every source snapshot remains immutable across later research iterations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'trajectory-sources' / name) != expected:
            raise ValueError('forecast-tendency source changed')
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('forecast-tendency input changed')
    return freeze


# fit the original uniform learner on six additional causal forecast tendencies
def fit_month(root, data, x, month, controls):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(actual, hours)}
    mass = recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = recent.effective_support(actual, hours, mass)
    supported = residual.supported(counts['training'], POLICY['trainingSupport']) and residual.supported(counts['calibration'], POLICY['calibrationSupport']) and residual.supported(effective, POLICY['effectiveSupport'])
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': bool(supported), 'model': None, 'proposedRules': None, 'uniformRules': None, 'nestingSafetyFallback': None, 'calibration': None, 'reason': 'insufficient_support'}
    # unsupported cells preserve their complete unchanged ordinal forecasts
    if not supported:
        return np.where(evaluation)[0], controls.copy(), state
    directory = root / 'trajectory-models' / month
    directory.mkdir(parents=True, mode=0o700)
    models, model_state = context.fit_ordinal(x[fit], data['actual'][fit], data['hour'][fit], directory, POLICY['featureNames'])
    pc, ac = context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, ae = context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
    rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
    fitted = hurdle.calibrate(actual, hours, raw_cal, pc, search.blended(raw_cal, ac), rules, bounds['calibrationMaximumValidHourExclusive'])
    predicted = hurdle.predict(raw, pe, search.blended(raw, ae), fitted)
    state.update({'model': model_state, 'proposedRules': proposed, 'uniformRules': rules, 'nestingSafetyFallback': fallback, 'calibration': fitted, 'reason': 'trajectory_hurdle_calibrated'})
    return np.where(evaluation)[0], predicted, state


# adapt candidate keys without changing score or gate implementations
def rename_key(value, old, new):
    # preserve scalar leaves, including selection values handled explicitly below
    if not isinstance(value, dict):
        return value
    return {(new if name == old else name): rename_key(item, old, new) for name, item in value.items()}


# reuse the unchanged complete score and gate machinery through a collision-free alias
def make_report(root, data, indices, predictions, supported, states):
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'trajectory-freeze.json'), 'treeFitPerformed': True, 'nativeModelsFit': sum(sum(head['modelFile'] is not None for head in state['model']['heads'].values()) for state in states.values() if state['model'] is not None), 'nativeModelsReused': 0, 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None})
    return report


# train and evaluate one prespecified model without selecting favorable months
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # retain all partial or unsuccessful fits instead of overwriting them
    if any((root / name).exists() for name in ('trajectory-models', 'trajectory-states', 'features.npz', 'report.json', 'predictions.npz')):
        raise ValueError('forecast-tendency experiment already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as saved:
        # require exact original 95-feature material before fitting new trees
        if not np.array_equal(matrices['full'], saved['x'], equal_nan=True) or any(not np.array_equal(values, saved[name]) for name, values in availability.items()):
            raise ValueError('forecast-tendency features changed')
    trajectory_profiles = tendency.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    full, tendency_availability = tendency.build_features(data, matrices['full'], trajectory_profiles)
    np.savez_compressed(root / 'features.npz', x=full, **tendency_availability)
    with np.load(root / 'inputs/hurdle/predictions.npz', allow_pickle=False) as old:
        reference_indices = old['indices']
        predictions = {name: old['amount::' + name] for name in recency.ARMS}
        predictions['hurdleOriginal'] = old['amount::' + parent.PRIMARY]
    directory = root / 'trajectory-states'
    directory.mkdir(mode=0o700)
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # keep every original decision month and every unsupported fallback row
    for month in inputs.MONTHS:
        _, _, mask, _ = search.month_masks(data, month)
        end = offset + int(mask.sum())
        rows, predicted, state = fit_month(root, data, full, month, predictions['ordinal90'][offset:end])
        if not np.array_equal(rows, reference_indices[offset:end]):
            raise ValueError('forecast-tendency month population changed')
        inputs.write_json(directory / (month + '.json'), state)
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        offset = end
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    # reject any change to the complete retained evaluation population
    if offset != 32896 or len(np.unique(indices)) != offset or not np.array_equal(indices, reference_indices):
        raise ValueError('forecast-tendency evaluation rows changed')
    predictions[PRIMARY] = np.concatenate(amounts)
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in recency.ARMS}, 'hurdleOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'features.npz')
    report['originalFeaturesSha256'] = inputs.sha(root / 'inputs/context/features.npz')
    report['tendencyAvailability'] = {'evaluationRows': int(tendency_availability['tendencyAvailable'][indices].sum()), 'evaluationTotal': int(len(indices)), 'featureColumns': int(full.shape[1])}
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, candidateSupported=supported)
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'productionEligible': False}


# require explicit preparation and execution in a new private experiment root
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
