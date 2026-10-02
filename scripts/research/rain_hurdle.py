"""test a fixed wet-cutoff and category-amount recalibrator on consumed data."""

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
import rain_context as context
import rain_context_features as features
import rain_event_guard as inputs
import rain_hurdle_calibration as hurdle
import rain_ordinal as ordinal
import rain_recency as recency
import rain_search as search
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score

ROOT_NAME = 'weather-moisture-research-rain-hurdle-20260913-v1'
PRIMARY = 'hurdleCategory'
ARMS = (*recency.ARMS, PRIMARY)
PREVIOUS_PINS = {
    'recency-freeze.json': '262faaa7f2190ba6de6a2a4324681ebfd3228ca07cc7890a010080b78193d6bb',
    'report.json': '115298848c368e5b632a17cf58892f2cd0d061eae1a314f0de41955d1e226a5e',
    'predictions.npz': '78d2c60c3115faec558e4bf1b26055ed56078281636b4914879c8c53abb5fabe',
    'retention-manifest.json': '8248d73a7251d1d9c07cc8af872c7d7d35bb38f8f57a6c05835c60f4dea8825c',
}
POLICY = {
    **recency.POLICY,
    'contractVersion': 'rain-hurdle-category-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'previousPins': PREVIOUS_PINS,
    'wetCutoff': 'maximize_uniform_weighted_final_nested_csi_subject_raw_pod_and_raw_far_plus_0.05;highest_cutoff_tie;old_wet_rule_fallback',
    'heavyRules': 'exact_original_uniform_ordinal90_rules_at_1_and_2.5',
    'categoryAmounts': 'recent_weighted_observed_mean_in_forecast_category_including_dry_labels;bounded_final_projection_scalar_per_category;no_later_global_rescale',
    'categorySupport': {'wetHours': 20, 'wetDates': 5},
    'categoryFallback': 'global_recent_scalar_on_new_nested_categories',
    'primaryCalibration': 'uniform_nested_wet_csi_cutoff_and_recent_predicted_category_amount_scalars',
    'ablations': {},
    'unsupportedRecency': 'exact_ordinal90_primary_no_rows_deleted',
    'selection': 'one_primary_all49_unchanged_recency_gates_else_none',
    'ablationRole': 'all_previous_arms_unchanged_nonselectable_controls',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_hurdle.py', 'rain_hurdle_calibration.py', *recency.SOURCE_FILES)))


# copy only byte-bound regular files from an already retained experiment
def copy_member(source, destination, expected):
    # reject links before reading any source material
    if any(path.is_symlink() for path in (source, *source.parents)) or not source.is_file() or inputs.sha(source) != expected:
        raise ValueError('invalid retained hurdle input')
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o600)
    # detect copying races and altered destination bytes
    if inputs.sha(source) != expected or inputs.sha(destination) != expected:
        raise ValueError('hurdle input changed during copying')


# freeze the next hypothesis and all previous controls before new outcomes
def prepare(source, root, receipt):
    source = validate_private_root(source)
    root = Path(root)
    previous = validate_private_root(source.parent / recency.ROOT_NAME)
    # keep the new experiment outside every previous private root
    if root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected hurdle destination')
    recency.validate_freeze(previous)
    retained_path = Path.home() / '.weather/model-evidence/rain-recency-20260913/retention-receipt.json'
    retained = json.loads(retained_path.read_text())
    # bind inputs to the completed encrypted roundtrip rather than mutable names
    if retained.get('verdict') != 'PASS' or retained.get('encryptedRoundtripVerified') is not True or retained['manifestSha256'] != PREVIOUS_PINS['retention-manifest.json'] or Path(retained['archive']).name != retained['archive'] or inputs.sha(retained_path.parent / retained['archive']) != retained['cipherSha256']:
        raise ValueError('recency retention changed')
    # bind all previously disclosed outcomes and the retained member list
    for name, expected in PREVIOUS_PINS.items():
        if inputs.sha(previous / name) != expected:
            raise ValueError('hurdle prior reference changed')
    members = json.loads((previous / 'retention-manifest.json').read_text())['files']
    old = json.loads((previous / 'recency-freeze.json').read_text())
    inputs.prepare(source, root, receipt)
    hashes = {}
    # retain the already verified fixed native context heads and their inputs
    for name, expected in old['contextInputSha256'].items():
        relative = 'inputs/context/' + name
        if members[relative]['sha256'] != expected:
            raise ValueError('hurdle context member differs from retention')
        copy_member(previous / relative, root / relative, expected)
        hashes[relative] = expected
    # keep prior forecasts, calibration states and verification as explicit controls
    references = [*PREVIOUS_PINS, 'final-evidence/independent-verification-v2.json']
    references += [f'recency-states/{month}.json' for month in inputs.MONTHS]
    for name in references:
        expected = PREVIOUS_PINS[name] if name in PREVIOUS_PINS else members[name]['sha256']
        relative = 'inputs/recency/' + name
        copy_member(previous / name, root / relative, expected)
        hashes[relative] = expected
    copy_member(retained_path, root / 'inputs/recency/parent-retention-receipt.json', inputs.sha(retained_path))
    hashes['inputs/recency/parent-retention-receipt.json'] = inputs.sha(retained_path)
    directory = root / 'hurdle-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # snapshot all producer dependencies before this candidate has predictions
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'hurdle-freeze.json', freeze)
    return validate_freeze(root)


# reject source, policy and material changes after preregistration
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'hurdle-freeze.json').read_text())
    # retain the exact 95-column feature schema and single primary
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('hurdle freeze changed')
    # compare each copied dependency against its frozen byte identity
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'hurdle-sources' / name) != expected:
            raise ValueError('hurdle producer changed after freeze')
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if '..' in Path(name).parts or Path(name).is_absolute() or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('hurdle input changed after freeze')
    return freeze


# reuse the original heavy-event rules and native wet-amount head
def native_inputs(root, data, x, month, calibration, evaluation, reference):
    directory = root / 'inputs/context/context-models' / month / 'ordinalContext'
    models = {}
    # load only retained boosters with exact objective and feature identities
    for name, head in reference['model']['heads'].items():
        models[name] = recency.load_booster(directory / head['modelFile'], head['sha256'], head['objective'])
    output = {}
    # exclude actual outcomes from every inference call
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        probability, amount = context.predict_ordinal(models, x[mask], POLICY['featureNames'])
        output[name] = {'raw': data['raw'][mask].astype(float), 'probabilities': probability, 'base': search.blended(data['raw'][mask].astype(float), amount)}
    return output


# calibrate the new hypothesis solely on earlier embargoed observations
def calibrate_month(root, data, x, month):
    rows, output, previous = recency.calibrate_month(data, x, root, month)
    retained = json.loads((root / 'inputs/recency/recency-states' / (month + '.json')).read_text())
    # require exact unchanged calibration states before new fitting
    if previous != retained:
        raise ValueError('hurdle original recency state changed')
    _, calibration, evaluation, bounds = search.month_masks(data, month)
    state = {**bounds, 'supported': previous['supported'], 'support': previous['support'], 'effectiveSupport': previous['effectiveSupport'], 'calibration': None, 'reason': 'insufficient_effective_support'}
    # preserve all rows when recent calibration lacks effective support
    if not state['supported']:
        output[PRIMARY] = output['ordinal90'].copy()
    else:
        batches = native_inputs(root, data, x, month, calibration, evaluation, previous['referenceOrdinal'])
        cal, future = batches['calibration'], batches['evaluation']
        fitted = hurdle.calibrate(data['actual'][calibration], data['hour'][calibration], cal['raw'], cal['probabilities'], cal['base'], previous['referenceOrdinal']['rules'], bounds['calibrationMaximumValidHourExclusive'])
        output[PRIMARY] = hurdle.predict(future['raw'], future['probabilities'], future['base'], fitted)
        state.update({'calibration': fitted, 'reason': 'category_calibrated'})
        # a wet-only cutoff and within-band scaling cannot change either heavy call
        if any(not np.array_equal(output[PRIMARY] >= threshold, output['ordinal90'] >= threshold) for threshold in (1., 2.5)):
            raise ValueError('hurdle heavy calls changed')
    return rows, output, state


# map only the new candidate into the unchanged 49-gate interface
def screen_view(value):
    # retain scalar policy and metric leaves without mutation
    if not isinstance(value, dict):
        return value
    output = {name: screen_view(item) for name, item in value.items() if name != recency.PRIMARY}
    # replace the old primary metric only where the new candidate exists
    if PRIMARY in output:
        output[recency.PRIMARY] = output.pop(PRIMARY)
    return output


# retain every original score population and every earlier control
def make_report(root, data, indices, predictions, supported, states):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # apply unchanged equal-date/hour/vintage evaluation mass
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'hurdle-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'treeFitPerformed': False, 'nativeModelsReused': 60}
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in dates])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # retain all seasons, lead bands, months and archive eras
    for field, labels in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {str(key): summarize(labels == key) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['candidateScreen'] = recency.candidate_screen(screen_view(report), data, indices, supported)
    report['selectedCandidate'] = PRIMARY if report['candidateScreen']['passed'] else None
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    return report


# run exactly one frozen candidate and preserve every failed result
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # refuse reruns that could erase partial or unfavorable evidence
    if any((root / name).exists() for name in ('hurdle-states', 'report.json', 'predictions.npz')):
        raise ValueError('hurdle experiment already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as saved:
        # verify unchanged inputs before applying any new calibration
        if not np.array_equal(matrices['full'], saved['x'], equal_nan=True) or any(not np.array_equal(values, saved[name]) for name, values in availability.items()):
            raise ValueError('hurdle context features changed')
    directory = root / 'hurdle-states'
    directory.mkdir(mode=0o700)
    indices, flags, states = [], [], {}
    amounts = {name: [] for name in ARMS}
    # preserve the complete predeclared chronological evaluation population
    for month in inputs.MONTHS:
        rows, output, state = calibrate_month(root, data, matrices['full'], month)
        inputs.write_json(directory / (month + '.json'), state)
        indices.append(rows)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        for name in ARMS:
            amounts[name].append(output[name])
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    predictions = {name: np.concatenate(parts) for name, parts in amounts.items()}
    with np.load(root / 'inputs/recency/predictions.npz', allow_pickle=False) as old:
        # require exact old forecasts and row identity before scoring
        if len(indices) != 32896 or len(np.unique(indices)) != len(indices) or not np.array_equal(indices, old['indices']) or any(not np.array_equal(predictions[name], old['amount::' + name]) for name in recency.ARMS):
            raise ValueError('hurdle control parity changed')
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': list(recency.ARMS)}
    report['featuresSha256'] = inputs.sha(root / 'inputs/context/features.npz')
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, candidateSupported=supported)
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'productionEligible': False}


# require explicit preparation and execution against a private root
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
