"""test daily rolling calibration of fixed monthly trajectory rain models."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# limit numerical work to the pinned single-thread CPU runtime
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_context as context
import rain_context_features as features
import rain_event_guard as inputs
import rain_daily_calibration as daily
import rain_trajectory_features as tendency
import rain_trajectory as parent
from rain_hurdle import copy_member
import rain_recency as recency
import rain_search as search
from rain_sub24 import FEATURE_NAMES
from retain_moisture_research import validate_private_root

ROOT_NAME = 'weather-moisture-research-rain-daily-20260913-v1'
PRIMARY = 'hurdleDaily'
ARMS = (*recency.ARMS, 'hurdleOriginal', 'trajectoryOriginal', PRIMARY)
PARENT_PINS = {
    'trajectory-freeze.json': '2f7d1192e6416fed633482a96ac280f1d8a5ae3853d754068bb0302663906efd',
    'report.json': 'abb5a01dba8d1fe9bfba9ab74077c84185a0a9a5e4420212b187ca1ab824a0ea',
    'predictions.npz': '39add05775a4701025f43aef15fd66eec9a53d21375fdf93bd873ecfd4e80ff2',
}
POLICY = {
    **parent.POLICY,
    'contractVersion': 'rain-daily-calibration-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'treeFitPerformed': False,
    'nativeModelsFit': 0,
    'nativeModelsReused': 48,
    'parentPins': PARENT_PINS,
    'calibrationCadence': 'each_UTC_decision_date_D=(initialized+8)//24',
    'calibrationWindow': 'valid_hours_[Dminus97days,Dminus7days);same_90days_and_7day_embargo',
    'calibrationAlgorithm': 'unchanged_uniform_ordinal_events_then_nesting_safety_then_hurdle_category_calibration',
    'nativeModels': 'exact_parent_101feature_monthly_models;no_new_training_or_parameter_selection',
    'heavyRules': 'daily_uniform_calibration_of_reused_native_heads;may_change_calls_subject_to_unchanged_49_empirical_gates',
    'unsupportedDaily': 'exact_frozen_monthly_trajectory_prediction_for_that_decision_date',
    'evaluationDesign': 'prequential_development;later_same_month_labels_enter_only_after_7day_embargo;not_untouched_monthly_holdout',
    'selection': 'one_preregistered_daily_cadence_primary_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_daily.py', 'rain_daily_calibration.py', *parent.SOURCE_FILES)))


# snapshot the verified parent's input envelope without mutating its experiment
def prepare(source, root, receipt_path):
    source, root = validate_private_root(source), Path(root)
    # keep a distinct private sibling for this fixed calibration hypothesis
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected daily-calibration experiment root')
    parent.validate_freeze(source)
    receipt = json.loads(Path(receipt_path).read_text())
    manifest_path = source / 'retention-manifest.json'
    # bind copied inputs to a completed local encrypted roundtrip
    if receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt['manifestSha256'] != inputs.sha(manifest_path) or Path(receipt['archive']).name != receipt['archive'] or inputs.sha(Path(receipt_path).parent / receipt['archive']) != receipt['cipherSha256']:
        raise ValueError('trajectory retention is not verified')
    manifest = json.loads(manifest_path.read_text())
    # freeze the known prior result rather than a mutable latest-candidate pointer
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('daily-calibration parent identity changed')
    if manifest['reportSha256'] != PARENT_PINS['report.json']:
        raise ValueError('daily-calibration parent manifest changed')
    root.mkdir(mode=0o700)
    validate_private_root(root)
    hashes = {}
    # inherit only the unchanged input and source schema envelopes
    for name, entry in manifest['files'].items():
        # copy only inherited byte-bound schema envelopes
        if name in ('freeze.json', 'hurdle-freeze.json', 'trajectory-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/', 'trajectory-sources/')):
            # reject paths escaping the retained private root
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('unsafe parent manifest member')
            copy_member(source / name, root / name, entry['sha256'])
            hashes[name] = entry['sha256']
    # retain the exact previous candidate as a nonselectable matched control
    references = ['report.json', 'predictions.npz', 'features.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json']
    references += [name for name in manifest['files'] if name.startswith(('trajectory-models/', 'trajectory-states/'))]
    # reuse every byte-bound native model and its complete monthly state
    for name in references:
        expected = inputs.sha(manifest_path) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        relative = 'inputs/trajectory/' + name
        copy_member(source / name, root / relative, expected)
        hashes[relative] = expected
    relative = 'inputs/trajectory/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    directory = root / 'daily-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # retain every producer dependency before any new calibration or outcome
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'trajectory-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'daily-freeze.json', freeze)
    return validate_freeze(root)


# bind the new cadence to inherited data and current source bytes
def validate_freeze(root):
    parent.validate_freeze(root)
    freeze = json.loads((root / 'daily-freeze.json').read_text())
    # retain the pre-outcome model contract and original data schema
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['trajectory-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('daily-calibration freeze changed')
    # every source snapshot remains immutable across later research iterations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'daily-sources' / name) != expected:
            raise ValueError('daily-calibration source changed')
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('daily-calibration input changed')
    return freeze


# adapt candidate keys without changing score or gate implementations
def rename_key(value, old, new):
    # preserve scalar leaves, including selection values handled explicitly below
    if not isinstance(value, dict):
        return value
    return {(new if name == old else name): rename_key(item, old, new) for name, item in value.items()}


# adapt only the candidate key while retaining every fixed empirical gate
def make_report(root, data, indices, predictions, supported, states, day_states):
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'daily-freeze.json'), 'treeFitPerformed': False, 'nativeModelsFit': 0, 'nativeModelsReused': 48, 'dailyStates': day_states, 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None})
    return report


# load the exact already verified monthly native heads without fitting
def load_models(root, month, model_state):
    directory = root / 'inputs/trajectory/trajectory-models' / month
    # retain the exact uniform 101-feature native learner configuration
    if xgb.__version__ != POLICY['xgboostVersion'] or model_state['featureNames'] != POLICY['featureNames'] or model_state['rounds'] != 160:
        raise ValueError('daily native model configuration changed')
    models = {}
    # preserve unsupported heads as the original explicit raw fallback
    for name, head in model_state['heads'].items():
        models[name] = None
        # decode only a byte-bound supported native head
        if head['modelFile'] is not None:
            path = directory / head['modelFile']
            # verify immutable bytes before native decoding
            if inputs.sha(path) != head['sha256']:
                raise ValueError('daily native model bytes changed')
            model = xgb.Booster(model_file=path)
            # the old 95-feature loader is intentionally not used for these heads
            if model.feature_names != POLICY['featureNames'] or model.num_boosted_rounds() != 160 or json.loads(model.save_config())['learner']['objective']['name'] != head['objective']:
                raise ValueError('daily native model schema changed')
            models[name] = model
    return models


# replay rolling earlier-only calibration without changing monthly predictors
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # partial daily results cannot be erased by rerunning the experiment
    if any((root / name).exists() for name in ('daily-states', 'report.json', 'predictions.npz')):
        raise ValueError('daily calibration experiment already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as saved:
        # recompute every original context feature before any new calibration
        if not np.array_equal(matrices['full'], saved['x'], equal_nan=True) or any(not np.array_equal(value, saved[name]) for name, value in availability.items()):
            raise ValueError('daily context features changed')
    source_profiles = tendency.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    full, availability = tendency.build_features(data, matrices['full'], source_profiles)
    with np.load(root / 'inputs/trajectory/features.npz', allow_pickle=False) as saved:
        # require exact retained 101-column material and missingness
        if not np.array_equal(full, saved['x'], equal_nan=True) or any(not np.array_equal(value, saved[name]) for name, value in availability.items()):
            raise ValueError('daily trajectory features changed')
    with np.load(root / 'inputs/trajectory/predictions.npz', allow_pickle=False) as old:
        indices = old['indices']
        predictions = {name: old['amount::' + name] for name in recency.ARMS}
        predictions['hurdleOriginal'] = old['amount::hurdleOriginal']
        predictions['trajectoryOriginal'] = old['amount::' + parent.PRIMARY]
    fallback = np.full(len(full), np.nan, dtype=np.float64)
    fallback[indices] = predictions['trajectoryOriginal']
    predicted = np.full(len(full), np.nan, dtype=np.float64)
    supported = np.zeros(len(full), dtype=bool)
    visited = np.zeros(len(full), dtype=bool)
    states, day_states, expected_indices = {}, {}, []
    directory = root / 'daily-states'
    directory.mkdir(mode=0o700)
    # retain each original monthly model while allowing causal daily calibration updates
    for month in inputs.MONTHS:
        _, _, evaluation, bounds = search.month_masks(data, month)
        rows = np.where(evaluation)[0]
        expected_indices.append(rows)
        retained = json.loads((root / 'inputs/trajectory/trajectory-states' / (month + '.json')).read_text())
        # the retained fit predates every daily calibration population in its month
        if not retained['supported'] or any(retained[name] != value for name, value in bounds.items()):
            raise ValueError('daily parent training chronology changed')
        models = load_models(root, month, retained['model'])
        days = np.unique((data['initialized'][evaluation] + 8) // 24)
        needed = evaluation.copy()
        # inference reads only the union of that month's eligible source rows
        for day in days:
            calibration, daily_rows, daily_bounds = daily.day_masks(data, int(day))
            # keep every label after fitting and every forecast in its model month
            if daily_bounds['calibrationStartHour'] < bounds['trainingMaximumValidHourExclusive'] or (daily_rows & ~evaluation).any():
                raise ValueError('daily calibration overlaps fitting or another model month')
            needed |= calibration
        probability = np.full((len(full), 3), np.nan, dtype=np.float64)
        base = np.full(len(full), np.nan, dtype=np.float64)
        probability[needed], amount = context.predict_ordinal(models, full[needed], POLICY['featureNames'])
        base[needed] = search.blended(data['raw'][needed].astype(float), amount)
        dates = []
        # score no evaluation labels until all daily predictions have been frozen
        for day in days:
            _, day_mask, _ = daily.day_masks(data, int(day))
            day_rows, values, state = daily.calibrate_day(data, probability, base, int(day), fallback[day_mask])
            # each original forecast row receives exactly one daily prediction
            if visited[day_rows].any() or not np.array_equal(day_rows, np.where(day_mask)[0]):
                raise ValueError('daily evaluation population changed')
            key = state['decisionDate']
            state['modelMonth'] = month
            inputs.write_json(directory / (key + '.json'), state)
            day_states[key] = state
            dates.append(key)
            predicted[day_rows], supported[day_rows], visited[day_rows] = values, state['supported'], True
        states[month] = {**bounds, 'model': retained['model'], 'dailyDates': dates}
        print(json.dumps({'month': month, 'days': len(days), 'rows': len(rows)}), flush=True)
    # preserve every original evaluation row and reject predictions outside that population
    if len(indices) != 32896 or not np.array_equal(np.concatenate(expected_indices), indices) or not visited[indices].all() or int(visited.sum()) != len(indices) or not np.isfinite(predicted[indices]).all():
        raise ValueError('daily complete evaluation population changed')
    predictions[PRIMARY] = predicted[indices]
    report = make_report(root, data, indices, predictions, supported[indices], states, day_states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in recency.ARMS}, 'hurdleOriginal': 'hurdleOriginal', 'trajectoryOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'inputs/trajectory/features.npz')
    report['dailyCalibrationCount'] = len(day_states)
    report['supportedDailyCalibrations'] = sum(state['supported'] for state in day_states.values())
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: value for name, value in predictions.items()}, candidateSupported=supported[indices])
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
