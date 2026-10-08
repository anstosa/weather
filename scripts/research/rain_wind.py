"""test one matched wind-vector extension with unchanged monthly hurdle fitting."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# keep native fitting in the pinned single-thread runtime
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import rain_context as context
import rain_context_features as features
import rain_event_guard as inputs
import rain_hurdle_calibration as hurdle
import rain_ordinal as ordinal
import rain_recency as recency
import rain_recency_calibration as recent
import rain_residual as residual
import rain_search as search
import rain_trajectory as parent
import rain_trajectory_features as tendency
import rain_wind_features as wind
import rain_wind_source as direction
from rain_hurdle import copy_member
from rain_sub24 import FEATURE_NAMES
from retain_moisture_research import validate_private_root

ROOT_NAME = 'weather-moisture-research-rain-wind-20260913-v1'
DIRECTION_ROOT_NAME = 'weather-moisture-research-rain-wind-continuation-20260913-v1'
DIRECTION_NORMALIZED = 'normalized/ecmwf_single_run_wind_direction.jsonl'
PRIMARY = 'hurdleWind'
ARMS = (*recency.ARMS, 'hurdleOriginal', 'trajectoryOriginal', PRIMARY)
PARENT_PINS = {
    'trajectory-freeze.json': '2f7d1192e6416fed633482a96ac280f1d8a5ae3853d754068bb0302663906efd',
    'report.json': 'abb5a01dba8d1fe9bfba9ab74077c84185a0a9a5e4420212b187ca1ab824a0ea',
    'predictions.npz': '39add05775a4701025f43aef15fd66eec9a53d21375fdf93bd873ecfd4e80ff2',
}
POLICY = {
    **parent.POLICY,
    'contractVersion': 'rain-wind-vector-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'parentPins': PARENT_PINS,
    'featureNames': list(wind.FEATURE_NAMES),
    'windVectorFeatures': list(wind.WIND_FEATURE_NAMES),
    'windVectors': 'u=-speed*sin(direction%360);v=-speed*cos(direction%360);degrees_to_radians;float64_then_float32',
    'windWindow': 'same_initialized_run_L=8+h;uL_vL_uLminusPast3_vLminusPast3_next3MinusUL_next3MinusVL',
    'missingWind': 'retain_nan_features_including_calm_missing_direction;missing_original_run_is_error;no_row_deletion',
    'directionSource': 'qualified_3301_original_runs;new_35h_both_variables_exact_rain_leads1to34_grid_run_parity;original_rain48_unchanged;independently_verified_and_retained',
    'sourceAcquisitionLineage': '113_full_horizon_and1600_short_horizon_verified_responses_inherited_with25_parent_scheduler_violations_disclosed;1588_missing_runs_from_separate_completion_spaced_continuation;two_attempt_cap',
    'unresolvedDirection': 'nan_only_six_new_features;distinct_from_provider_null;at_most1percent_original_runs_overall_and_every_init_plus8_month;all_original_rows_retained;no_source_status_predictor',
    'unsupportedMonthly': 'unchanged_ordinal90_prediction_for_every_original_month_row',
    'selection': 'single_preregistered_six_wind_vector_primary_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_wind.py', 'rain_wind_features.py', 'rain_wind_source.py', 'acquire_rain_wind_continuation.py', 'verify_rain_wind_continuation.py', 'rain_request_spacing.py', 'acquire_rain_wind_source.py', 'verify_rain_wind_source.py', 'acquire_rain_direction_recovery.py', 'verify_rain_direction_recovery.py', 'acquire_rain_direction.py', 'verify_rain_direction_source.py', *parent.SOURCE_FILES)))


# require a completed encrypted roundtrip before inheriting private artifacts
def retained_manifest(source, receipt_path):
    receipt_path = Path(receipt_path)
    receipt = json.loads(receipt_path.read_text())
    manifest_path = source / 'retention-manifest.json'
    # bind the plaintext manifest and ciphertext to the existing retention receipt
    if receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt['manifestSha256'] != inputs.sha(manifest_path) or Path(receipt['archive']).name != receipt['archive'] or inputs.sha(receipt_path.parent / receipt['archive']) != receipt['cipherSha256']:
        raise ValueError('wind input retention is not verified')
    return json.loads(manifest_path.read_text())


# copy only safe manifest members under the new private input boundary
def copy_input(source, root, name, relative, expected, hashes):
    # reject inherited member paths that can escape either root
    if Path(name).is_absolute() or '..' in Path(name).parts or Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError('unsafe wind input manifest member')
    copy_member(source / name, root / relative, expected)
    hashes[relative] = expected


# retain the whole verified supplemental source rather than a mutable source pointer
def copy_direction_source(source, root, receipt_path, hashes):
    source = validate_private_root(source)
    # reject another source cohort or a source outside the research siblings
    if source.name != DIRECTION_ROOT_NAME or source.parent != root.parent:
        raise ValueError('unexpected wind direction source root')
    manifest = retained_manifest(source, receipt_path)
    report = json.loads((source / 'report.json').read_text())
    verified = json.loads((source / 'final-evidence/independent-verification.json').read_text())
    # incomplete acquisition cannot become a matched model input
    if (
        report.get('contractVersion') != 'rain-wind-continuation/v1'
        or report.get('status') != 'complete'
        or report.get('sourceQualified') is not True
        or report.get('uniqueRepresentedRuns') != 3301
        or type(report.get('newUnresolvedRuns')) is not int
        or not 0 <= report['newUnresolvedRuns'] <= 33
        or report.get('uniqueSuccessfulRuns') != 3301 - report['newUnresolvedRuns']
        or report.get('reusedSuccessfulRuns') != 1713
        or report.get('parentTransportPolicyConformant') is not False
        or report.get('parentSourceQualified') is not False
        or report.get('inheritedSpacingViolationCount') != 25
        or report.get('newSuccessfulRuns') != 1588 - report['newUnresolvedRuns']
        or report.get('parentHttpAttempts') != 1716
        or type(report.get('newHttpAttempts')) is not int
        or not 1588 <= report['newHttpAttempts'] <= 3176
        or report.get('totalHttpAttempts') != 1716 + report['newHttpAttempts']
        or report.get('normalizedFile') != DIRECTION_NORMALIZED
        or report.get('normalizedRows') != 158448
        or verified.get('contractVersion') != 'rain-wind-continuation-verification/v1'
        or verified.get('verdict') != 'PASS'
        or verified.get('reportSha256') != inputs.sha(source / 'report.json')
        or verified.get('freezeSha256') != inputs.sha(source / 'wind-continuation-freeze.json')
        or verified.get('normalizedSha256') != report.get('normalizedSha256')
        or verified.get('normalizedSha256') != inputs.sha(source / DIRECTION_NORMALIZED)
        or verified.get('normalizedRows') != 158448
        or verified.get('sourceQualified') is not True
        or verified.get('parentTransportPolicyConformant') is not False
        or verified.get('parentSourceQualified') is not False
        or verified.get('inheritedSpacingViolationCount') != 25
        or verified.get('uniqueRepresentedRuns') != 3301
        or verified.get('uniqueSuccessfulRuns') != report['uniqueSuccessfulRuns']
        or verified.get('newUnresolvedRuns') != report['newUnresolvedRuns']
        or verified.get('historicalAsIssuedVerified') is not False
        or verified.get('freshHoldoutVerified') is not False
        or verified.get('modelGatesEvaluated') is not False
        or verified.get('verifierSourceSha256') != inputs.sha(Path(__file__).with_name('verify_rain_wind_continuation.py'))
    ):
        raise ValueError('wind direction source is not independently complete')
    # retain every source request and receipt for independent model replay
    for name, entry in manifest['files'].items():
        copy_input(source, root, name, 'inputs/direction/' + name, entry['sha256'], hashes)
    copy_input(source, root, 'retention-manifest.json', 'inputs/direction/retention-manifest.json', inputs.sha(source / 'retention-manifest.json'), hashes)
    relative = 'inputs/direction/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))


# freeze matched parent controls and new source material before fitting
def prepare(source, root, receipt_path, direction_root, direction_receipt):
    source, root = validate_private_root(source), Path(root)
    # the new model is a separate private sibling of the frozen trajectory run
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected wind model experiment root')
    parent.validate_freeze(source)
    manifest = retained_manifest(source, receipt_path)
    # keep the exact registered parent instead of any later selected model
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('wind model parent identity changed')
    if manifest['reportSha256'] != PARENT_PINS['report.json']:
        raise ValueError('wind model parent manifest changed')
    root.mkdir(mode=0o700)
    validate_private_root(root)
    hashes = {}
    # inherit the complete unchanged input and source-schema envelope
    for name, entry in manifest['files'].items():
        if name in ('freeze.json', 'hurdle-freeze.json', 'trajectory-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/', 'trajectory-sources/')):
            copy_input(source, root, name, name, entry['sha256'], hashes)
    # preserve features and predictions as nonselectable matched controls
    for name in ('report.json', 'predictions.npz', 'features.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json'):
        expected = inputs.sha(source / name) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        copy_input(source, root, name, 'inputs/trajectory/' + name, expected, hashes)
    relative = 'inputs/trajectory/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    copy_direction_source(direction_root, root, direction_receipt, hashes)
    directory = root / 'wind-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # retain all executing producer dependencies before any model outcome
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'trajectory-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'wind-freeze.json', freeze)
    return validate_freeze(root)


# rebind unchanged lineage, new predictors and all private source bytes
def validate_freeze(root):
    parent.validate_freeze(root)
    freeze = json.loads((root / 'wind-freeze.json').read_text())
    # retain the exact preregistered feature change and original data schema
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['trajectory-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('wind model freeze changed')
    # compare both currently executing and retained source implementations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'wind-sources' / name) != expected:
            raise ValueError('wind model source changed')
    # recheck every inherited input without allowing links or path escapes
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('wind model input changed')
    return freeze


# fit the original monthly learner with only six additional issued predictors
def fit_month(root, data, x, month, controls, *, masks=None):
    # preserve legacy ninety-day masks unless maintenance supplies its explicit policy
    fit, calibration, evaluation, bounds = search.month_masks(data, month) if masks is None else masks
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(actual, hours)}
    mass = recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = recent.effective_support(actual, hours, mass)
    supported = residual.supported(counts['training'], POLICY['trainingSupport']) and residual.supported(counts['calibration'], POLICY['calibrationSupport']) and residual.supported(effective, POLICY['effectiveSupport'])
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': bool(supported), 'model': None, 'proposedRules': None, 'uniformRules': None, 'nestingSafetyFallback': None, 'calibration': None, 'reason': 'insufficient_support'}
    # retain every original ordinal control row when fitting is unsupported
    if not supported:
        return np.where(evaluation)[0], controls.copy(), state
    directory = root / 'wind-models' / month
    directory.mkdir(parents=True, mode=0o700)
    models, model_state = context.fit_ordinal(x[fit], data['actual'][fit], data['hour'][fit], directory, POLICY['featureNames'])
    pc, ac = context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, ae = context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
    rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
    fitted = hurdle.calibrate(actual, hours, raw_cal, pc, search.blended(raw_cal, ac), rules, bounds['calibrationMaximumValidHourExclusive'])
    predicted = hurdle.predict(raw, pe, search.blended(raw, ae), fitted)
    state.update({'model': model_state, 'proposedRules': proposed, 'uniformRules': rules, 'nestingSafetyFallback': fallback, 'calibration': fitted, 'reason': 'wind_vector_hurdle_calibrated'})
    return np.where(evaluation)[0], predicted, state


# adapt only the primary alias while keeping every earlier control and gate
def make_report(root, data, indices, predictions, supported, states):
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = parent.rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'wind-freeze.json'), 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None})
    return report


# construct matched features and freeze predictions before scoring the new primary
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # partial models or features remain evidence rather than permission to rerun
    if any((root / name).exists() for name in ('wind-models', 'wind-states', 'features.npz', 'report.json', 'predictions.npz')):
        raise ValueError('wind model experiment already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    original_path = root / 'inputs/context/inputs/trajectory.jsonl'
    profiles = features.load_profiles(original_path, cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as saved:
        # verify the unchanged context before joining new predictor material
        if not np.array_equal(matrices['full'], saved['x'], equal_nan=True) or any(not np.array_equal(value, saved[name]) for name, value in availability.items()):
            raise ValueError('wind original context features changed')
    source_profiles = tendency.load_profiles(original_path, cohort)
    full101, trajectory_availability = tendency.build_features(data, matrices['full'], source_profiles)
    with np.load(root / 'inputs/trajectory/features.npz', allow_pickle=False) as saved:
        # retain the previous 101 feature values and missingness exactly
        if not np.array_equal(full101, saved['x'], equal_nan=True) or any(not np.array_equal(value, saved[name]) for name, value in trajectory_availability.items()):
            raise ValueError('wind original trajectory features changed')
    source_report = json.loads((root / 'inputs/direction/report.json').read_text())
    # the source file cannot escape the copied supplemental input envelope
    if source_report['normalizedFile'] != DIRECTION_NORMALIZED or source_report['normalizedRows'] != 158448:
        raise ValueError('wind supplemental source path or row count changed')
    supplemental = root / 'inputs/direction' / DIRECTION_NORMALIZED
    joined = direction.load_profiles(supplemental, source_report['normalizedSha256'], profiles, source_profiles)
    full, wind_availability = wind.build_features(data, full101, joined)
    np.savez_compressed(root / 'features.npz', x=full, **trajectory_availability, **wind_availability)
    with np.load(root / 'inputs/trajectory/predictions.npz', allow_pickle=False) as old:
        reference_indices = old['indices']
        predictions = {name: old['amount::' + name] for name in recency.ARMS}
        predictions['hurdleOriginal'] = old['amount::hurdleOriginal']
        predictions['trajectoryOriginal'] = old['amount::' + parent.PRIMARY]
    directory = root / 'wind-states'
    directory.mkdir(mode=0o700)
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # fit every registered month without selecting favorable subsets
    for month in inputs.MONTHS:
        _, _, mask, _ = search.month_masks(data, month)
        end = offset + int(mask.sum())
        rows, predicted, state = fit_month(root, data, full, month, predictions['ordinal90'][offset:end])
        if not np.array_equal(rows, reference_indices[offset:end]):
            raise ValueError('wind month population changed')
        inputs.write_json(directory / (month + '.json'), state)
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        offset = end
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    # require the entire fixed development population before any score is accepted
    if offset != 32896 or len(np.unique(indices)) != offset or not np.array_equal(indices, reference_indices):
        raise ValueError('wind evaluation rows changed')
    predictions[PRIMARY] = np.concatenate(amounts)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, candidateSupported=supported)
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in recency.ARMS}, 'hurdleOriginal': 'hurdleOriginal', 'trajectoryOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'features.npz')
    report['originalFeaturesSha256'] = inputs.sha(root / 'inputs/trajectory/features.npz')
    report['directionSourceSha256'] = source_report['normalizedSha256']
    report['directionSourceCoverage'] = {'unresolvedRuns': source_report['newUnresolvedRuns'], 'perMonthCoverage': source_report['perMonthCoverage']}
    report['windAvailability'] = {'evaluationRows': int(wind_availability['windVectorAvailable'][indices].sum()), 'evaluationTotal': len(indices), 'featureColumns': int(full.shape[1])}
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'productionEligible': False}


# require explicit source verification and a new model root before fitting
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('source', type=Path)
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--retention-receipt', type=Path, required=True)
    preparation.add_argument('--direction-root', type=Path, required=True)
    preparation.add_argument('--direction-retention-receipt', type=Path, required=True)
    execution = commands.add_parser('run')
    execution.add_argument('root', type=Path)
    args = parser.parse_args()
    result = prepare(args.source, args.root, args.retention_receipt, args.direction_root, args.direction_retention_receipt) if args.command == 'prepare' else run(args.root)
    print(json.dumps(result), flush=True)
