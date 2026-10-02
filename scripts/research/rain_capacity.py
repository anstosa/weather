"""select per-head capacity inside training before unchanged hurdle calibration."""

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
import rain_nested_capacity as capacity
import rain_fit_recency as parent
from rain_hurdle import copy_member
import rain_hurdle_calibration as hurdle
import rain_ordinal as ordinal
import rain_recency as recency
import rain_recency_calibration as recent
import rain_residual as residual
import rain_search as search
from rain_sub24 import FEATURE_NAMES
from retain_moisture_research import validate_private_root

ROOT_NAME = 'weather-moisture-research-rain-capacity-20260913-v1'
PRIMARY = 'hurdleCapacity'
ARMS = (*recency.ARMS, 'hurdleOriginal', 'decayOriginal', PRIMARY)
PARENT_PINS = {
    'fit-freeze.json': '461afc54f989e8851fb7511cf00a71e0f1d5af220d5942fb45680f809e777b8a',
    'report.json': 'f1b8716bd9b69e6a7e93e8a49dbdf1c2f2882f5c226482e4cdb2d8c49f2af1c6',
    'predictions.npz': 'bbe710cc8a2489ee5a003e5239980fc9ff5c5b1fa02293d02cfdf62c53856373',
}
POLICY = {
    **parent.POLICY,
    'contractVersion': 'rain-nested-capacity-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'treeFitPerformed': True,
    'nativeModelsFit': 48,
    'nativeModelsReused': 0,
    'parentPins': PARENT_PINS,
    'fitHalfLifeDays': 183,
    'boostRounds': None,
    'selectionMaximumRounds': 320,
    'selectionFallbackRounds': 160,
    'innerValidationDays': 120,
    'innerEmbargoDays': 7,
    'selectionMetrics': {'events': 'native_3.4.1_logloss', 'amount': 'native_3.4.1_gamma-deviance_float32_epsilon'},
    'selectionWeights': 'uniform_equal_date_hour_vintage;gamma_rebalanced_within_observed_wet_validation_rows',
    'selectionSupport': {'eventPositiveHours': 10, 'eventPositiveDates': 5, 'gammaWetHours': 20, 'gammaWetDates': 5},
    'selectedRound': 'earliest_exact_minimum_of_all_320_inner_validation_scores;unsupported_160;full_outer_fit_refit_at_selected_round_count',
    'fitWeight': 'equal_date_hour_vintage_times_2_power_minus_age_UTC_dates_over_183;age_from_last_date_before_exclusive_fit_stop;normalize_to_original_training_row_count;gamma_weights_rebalanced_within_wet_subset',
    'fitWindow': 'unchanged_all_outer_fit_rows;capacity_selection_only_inner_training_and_embargoed_last120day_validation;no_outer_calibration_or_evaluation_labels',
    'heavyRules': 'uniform_calibrated_new_native_heads_then_preserved_within_hurdle_calibration;may_differ_from_prior_model_subject_unchanged_49_empirical_gates',
    'calibrationAlgorithm': 'exact_previous_hurdle_helper_applied_to_new_native_scores',
    'selection': 'single_preregistered_nested_capacity_primary_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_capacity.py', 'rain_nested_capacity.py', *parent.SOURCE_FILES)))


# snapshot the verified parent's input envelope without mutating its experiment
def prepare(source, root, receipt_path):
    source, root = validate_private_root(source), Path(root)
    # keep a distinct private sibling for the inner-capacity hypothesis
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected nested-capacity experiment root')
    parent.validate_freeze(source)
    receipt = json.loads(Path(receipt_path).read_text())
    manifest_path = source / 'retention-manifest.json'
    # bind copied inputs to a completed local encrypted roundtrip
    if receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt['manifestSha256'] != inputs.sha(manifest_path) or Path(receipt['archive']).name != receipt['archive'] or inputs.sha(Path(receipt_path).parent / receipt['archive']) != receipt['cipherSha256']:
        raise ValueError('training-decay retention is not verified')
    manifest = json.loads(manifest_path.read_text())
    # freeze the known prior result rather than a mutable latest-candidate pointer
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('nested-capacity parent identity changed')
    if manifest['reportSha256'] != PARENT_PINS['report.json']:
        raise ValueError('nested-capacity parent manifest changed')
    root.mkdir(mode=0o700)
    validate_private_root(root)
    hashes = {}
    # inherit only the unchanged input and source schema envelopes
    for name, entry in manifest['files'].items():
        if name in ('freeze.json', 'hurdle-freeze.json', 'fit-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/', 'fit-sources/')):
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('unsafe parent manifest member')
            copy_member(source / name, root / name, entry['sha256'])
            hashes[name] = entry['sha256']
    # retain the exact previous candidate as a nonselectable matched control
    for name in ('report.json', 'predictions.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json'):
        expected = inputs.sha(manifest_path) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        relative = 'inputs/fit-recency/' + name
        copy_member(source / name, root / relative, expected)
        hashes[relative] = expected
    relative = 'inputs/fit-recency/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    directory = root / 'capacity-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # retain every producer dependency before any new native fit or outcome
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'fit-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'capacity-freeze.json', freeze)
    return validate_freeze(root)


# bind the exact nested selection policy to inherited data and source bytes
def validate_freeze(root):
    parent.validate_freeze(root)
    freeze = json.loads((root / 'capacity-freeze.json').read_text())
    # retain the pre-outcome model contract and original data schema
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['fit-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('nested-capacity freeze changed')
    # every source snapshot remains immutable across later research iterations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'capacity-sources' / name) != expected:
            raise ValueError('nested-capacity source changed')
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('nested-capacity input changed')
    return freeze


# select tree counts inside fit before the unchanged hurdle calibration
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
    directory = root / 'capacity-models' / month
    directory.mkdir(parents=True, mode=0o700)
    models, model_state = capacity.fit(x[fit], data['actual'][fit], data['hour'][fit], directory, POLICY['featureNames'], bounds['trainingMaximumValidHourExclusive'])
    pc, ac = context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, ae = context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
    rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
    fitted = hurdle.calibrate(actual, hours, raw_cal, pc, search.blended(raw_cal, ac), rules, bounds['calibrationMaximumValidHourExclusive'])
    predicted = hurdle.predict(raw, pe, search.blended(raw, ae), fitted)
    state.update({'model': model_state, 'proposedRules': proposed, 'uniformRules': rules, 'nestingSafetyFallback': fallback, 'calibration': fitted, 'reason': 'nested_capacity_hurdle_calibrated'})
    return np.where(evaluation)[0], predicted, state


# reuse the unchanged complete score and gate machinery through a collision-free alias
def make_report(root, data, indices, predictions, supported, states):
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = parent.rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'capacity-freeze.json'), 'treeFitPerformed': True, 'nativeModelsFit': sum(sum(head['modelFile'] is not None for head in state['model']['heads'].values()) for state in states.values() if state['model'] is not None), 'nativeModelsReused': 0, 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None})
    report['nativeSelectionModelsFit'] = sum(sum(head['innerModelFile'] is not None for head in state['model']['heads'].values()) for state in states.values() if state['model'] is not None)
    return report


# train and evaluate one prespecified model without selecting favorable months
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # retain all partial or unsuccessful fits instead of overwriting them
    if any((root / name).exists() for name in ('capacity-models', 'capacity-states', 'report.json', 'predictions.npz')):
        raise ValueError('nested-capacity experiment already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as saved:
        # require exact original 95-feature material before fitting new trees
        if not np.array_equal(matrices['full'], saved['x'], equal_nan=True) or any(not np.array_equal(values, saved[name]) for name, values in availability.items()):
            raise ValueError('nested-capacity features changed')
    with np.load(root / 'inputs/fit-recency/predictions.npz', allow_pickle=False) as old:
        reference_indices = old['indices']
        predictions = {name: old['amount::' + name] for name in recency.ARMS}
        predictions['hurdleOriginal'] = old['amount::hurdleOriginal']
        predictions['decayOriginal'] = old['amount::' + parent.PRIMARY]
    directory = root / 'capacity-states'
    directory.mkdir(mode=0o700)
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # keep every original decision month and every unsupported fallback row
    for month in inputs.MONTHS:
        _, _, mask, _ = search.month_masks(data, month)
        end = offset + int(mask.sum())
        rows, predicted, state = fit_month(root, data, matrices['full'], month, predictions['ordinal90'][offset:end])
        if not np.array_equal(rows, reference_indices[offset:end]):
            raise ValueError('nested-capacity month population changed')
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
        raise ValueError('nested-capacity evaluation rows changed')
    predictions[PRIMARY] = np.concatenate(amounts)
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in recency.ARMS}, 'hurdleOriginal': 'hurdleOriginal', 'decayOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'inputs/context/features.npz')
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
