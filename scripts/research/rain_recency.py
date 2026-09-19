"""test one recent-weighted calibration rule without retraining rain learners."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil

# pin native numerical threads before runtime imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_context as context
import rain_context_features as features
import rain_event_guard as inputs
import rain_ordinal as ordinal
import rain_recency_calibration as recent
import rain_residual as residual
import rain_search as search
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score

ROOT_NAME = 'weather-moisture-research-rain-recency-20260913-v1'
CONTEXT_ROOT_NAME = 'weather-moisture-research-rain-context-20260913-v1'
PRIMARY = 'ordinalRecent'
RECENT_ARMS = ('ordinalRecentAmount', 'ordinalRecentEvents', PRIMARY)
ARMS = (*search.BASELINES, 'volumeRecent', 'ordinal90', 'weightedContext', *RECENT_ARMS)
CONTEXT_PINS = {
    'context-freeze.json': '3a3e88033b8ab5a4771f2c85e3a694392bb8755e207097b23d519a5be2bd7427',
    'report.json': 'cfab32d382b3de0d34ee27aa21fddec7de29fc04d6cec48ed4f3b33bb6a55aae',
    'predictions.npz': '8c04ceaf14b75f4c9b8ec35b636989aa632c9a8fe60ff9600b9016630804d426',
    'features.npz': 'eeb073a89b846295d9f46c8592b065033f564eb8b73ff50d32b92a0decaa127a',
    'retention-manifest.json': '92a6ef3719981d113f379db2c4a4075cd0e1eb0b6d34a40bc2fb50e50a647cc9',
}
POLICY = {
    **search.POLICY,
    'contractVersion': 'rain-recency-calibration-development/v1',
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'expectedEvaluationRows': 32896,
    'featureNames': list(features.FEATURE_SETS['full']),
    'treeFitPerformed': False,
    'nativeModelsReused': 60,
    'contextPins': CONTEXT_PINS,
    'halfLifeDays': 30,
    'recencyWeight': 'equal_date_hour_vintage_times_2_power_minus_age_days_over_30_then_normalized;age_from_last_utc_calibration_date',
    'effectiveSupport': {'effectiveDates': 30., 'effectiveWetDates': 3.},
    'effectiveSupportDefinition': 'kish_squared_sum_over_sum_squared_of_per_date_mass;wet_mass_only_actual_ge_0.1',
    'unsupportedRecency': 'exact_ordinal90_for_primary_and_ablations;volume90_for_recent_raw;no_rows_deleted',
    'primaryCalibration': 'recent_weighted_event_cutoffs_composite_safety_and_final_amount_scalar',
    'ablations': {'ordinalRecentAmount': 'uniform_event_rules_recent_amount_scalar', 'ordinalRecentEvents': 'recent_event_rules_uniform_amount_scalar'},
    'ablationRole': 'diagnostic_only_not_selectable',
    'evaluationWeight': 'unchanged_equal_date_hour_vintage_no_recency_weighting_of_scores',
    'seasonalImprovement': 'strictly_lower_maximum_absolute_volume_ratio_minus_one_over_all_four_seasons_than_ordinal90',
    'heavySkillRetention': 'heavy_mae_no_worse_than_ordinal90;at_1_and_2.5_pod_no_lower_csi_at_least_reference_minus_0.01_far_at_most_reference_plus_0.05',
    'comparisonTolerance': 1e-12,
    'selection': 'single_primary_all44_original_gates_plus_volume90_recent_raw_scale_same_ordinal_mae_seasonal_balance_and_heavy_skill_retention;49_gates_else_none',
    'sourceAvailability': 'simulated_initialization_plus_8h_and_observation_minus_1h_not_verified_historical_receipts',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_recency.py', 'rain_recency_calibration.py', *context.SOURCE_FILES)))


# enumerate only the fixed models and verified artifacts this replay needs
def context_members():
    names = [*CONTEXT_PINS, 'inputs/trajectory.jsonl', 'final-evidence/independent-verification-final.json']
    # retain original monthly metadata and five native boosters per month
    for month in inputs.MONTHS:
        names.append(f'context-models/{month}/state.json')
        names.append(f'context-models/{month}/weightedContext/amount.json')
        names.extend(f'context-models/{month}/ordinalContext/{name}' for name in ordinal.MODEL_FILES)
    return names


# bind the previous encrypted archive before copying fixed native learners
def prepare(source, root, retention_receipt):
    source, root = validate_private_root(source), Path(root)
    previous = validate_private_root(source.parent / CONTEXT_ROOT_NAME)
    # reject alternate output identities and accidental mutation of prior research
    if root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected recency research destination')
    context.validate_freeze(previous)
    receipt_path = Path.home() / '.weather/model-evidence/rain-context-20260913/retention-receipt.json'
    receipt = json.loads(receipt_path.read_text())
    # pin previous native models to the already roundtrip-verified encrypted archive
    if receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt['manifestSha256'] != CONTEXT_PINS['retention-manifest.json'] or Path(receipt['archive']).name != receipt['archive'] or inputs.sha(receipt_path.parent / receipt['archive']) != receipt['cipherSha256']:
        raise ValueError('context encrypted retention changed')
    for name, expected in CONTEXT_PINS.items():
        if inputs.sha(previous / name) != expected:
            raise ValueError('context reference artifact changed')
    members = json.loads((previous / 'retention-manifest.json').read_text())['files']
    inputs.prepare(source, root, retention_receipt)
    destination = root / 'inputs/context'
    destination.mkdir(mode=0o700)
    hashes = {}
    # copy only explicitly retained nonlinked context artifacts
    for name in context_members():
        path = previous / name
        if any(part.is_symlink() for part in (path, *path.parents) if part != previous.parent):
            raise ValueError('linked context input')
        expected = CONTEXT_PINS[name] if name == 'retention-manifest.json' else members[name]['sha256']
        output = destination / name
        output.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        shutil.copyfile(path, output)
        output.chmod(0o600)
        if inputs.sha(path) != expected or inputs.sha(output) != expected:
            raise ValueError('copied context input differs from retained archive')
        hashes[name] = expected
    shutil.copyfile(receipt_path, destination / 'parent-retention-receipt.json')
    hashes['parent-retention-receipt.json'] = inputs.sha(destination / 'parent-retention-receipt.json')
    directory = root / 'recency-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # preserve every new and inherited runtime dependency before new outcomes
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, directory / name)
        sources[name] = inputs.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'contextInputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'recency-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# fail closed on any changed model, input, policy or implementation
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'recency-freeze.json').read_text())
    # bind the new policy and inherited input schema
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or set(freeze['sourceSha256']) != set(SOURCE_FILES) or set(freeze['contextInputSha256']) != set(context_members()) | {'parent-retention-receipt.json'}:
        raise ValueError('recency freeze changed')
    destination = root / 'inputs/context'
    # reject changed copied context inputs, including original native model bytes
    for name, expected in freeze['contextInputSha256'].items():
        if inputs.sha(destination / name) != expected:
            raise ValueError('frozen recency context input changed')
    for name, expected in CONTEXT_PINS.items():
        if freeze['contextInputSha256'][name] != expected:
            raise ValueError('recency context reference identity changed')
    # bind live and retained producer source bytes
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'recency-sources' / name) != expected:
            raise ValueError('recency implementation changed after freeze')
    return freeze



# load one exact retained native booster without fitting or modifying it
def load_booster(path, expected, objective):
    # validate byte identity before native decoding
    if inputs.sha(path) != expected or xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('recency native model or runtime changed')
    model = xgb.Booster(model_file=path)
    # retain the original ninety-five-feature objectives and tree count
    if model.feature_names != POLICY['featureNames'] or model.num_boosted_rounds() != 160 or json.loads(model.save_config())['learner']['objective']['name'] != objective:
        raise ValueError('recency native model schema changed')
    return model


# reconstruct the unchanged ordinal calibration as an exact reference control
def uniform_ordinal(actual, hours, raw_cal, raw, pc, ac, pe, ae, model_state):
    proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
    rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
    cc, ce = ordinal.event_categories(raw_cal, pc, rules), ordinal.event_categories(raw, pe, rules)
    bc, be = search.blended(raw_cal, ac), search.blended(raw, ae)
    scalar = search.calibrate(actual, hours, lambda scale: ordinal.project_amount(bc, cc, scale))
    predicted = ordinal.project_amount(be, ce, scalar['scale'])
    state = {'supported': True, 'model': model_state, 'proposedRules': proposed, 'rules': rules, 'nestingSafetyFallback': fallback, 'calibration': scalar, 'compositeCalibrationEvents': inputs.event_scores(actual, ordinal.project_amount(bc, cc, scalar['scale']), hours)}
    return predicted, state, bc, be, cc, ce


# change only calibration weights while retaining all native predictions
def calibrate_month(data, x, root, month):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(actual, hours)}
    previous = json.loads((root / 'inputs/context/context-models' / month / 'state.json').read_text())
    reference = previous['candidates']['ordinalContext']
    weighted_reference = previous['candidates']['weightedContext']
    # fixed context source must remain supported on the original chronology
    if not reference['supported'] or not weighted_reference['supported'] or any(previous[key] != value for key, value in bounds.items()) or previous['support'] != counts:
        raise ValueError('fixed context support or chronology changed')
    directory = root / 'inputs/context/context-models' / month
    models = {}
    # reuse all four independently verified ordinal heads without a training call
    for name, head in reference['model']['heads'].items():
        if head['modelFile'] is None:
            raise ValueError('fixed context event model missing')
        models[name] = load_booster(directory / 'ordinalContext' / head['modelFile'], head['sha256'], head['objective'])
    pc, ac = context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, ae = context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    ordinal90, original, bc, be, cc, ce = uniform_ordinal(actual, hours, raw_cal, raw, pc, ac, pe, ae, reference['model'])
    # exact calibration-state parity precedes any new outcome calculation
    if original != reference:
        raise ValueError('uniform ordinal control differs from retained context state')
    weighted_model = weighted_reference['model']
    booster = load_booster(directory / 'weightedContext/amount.json', weighted_model['modelSha256'], 'reg:tweedie')
    weighted = {}
    # reproduce the unchanged amount control on both later populations
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(x[mask], feature_names=POLICY['featureNames'], nthread=1)
        weighted[name] = search.blended(data['raw'][mask].astype(float), np.clip(booster.predict(matrix).astype(float), 0, 30))
    weighted_scale = search.calibrate(actual, hours, lambda scale: np.clip(weighted['calibration'] * scale, 0, 30))
    weighted_state = {'supported': True, 'model': weighted_model, 'calibration': weighted_scale}
    if weighted_state != weighted_reference:
        raise ValueError('uniform weighted control differs from retained context state')
    raw_scale = search.calibrate(actual, hours, lambda scale: np.clip(raw_cal * scale, 0, 30))
    old = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    persistence = data['persistence'][evaluation]
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(persistence), persistence, raw), 'volumeScale': raw * old['scales']['raw'], 'volume90': np.clip(raw * raw_scale['scale'], 0, 30), 'ordinal90': ordinal90, 'weightedContext': np.clip(weighted['evaluation'] * weighted_scale['scale'], 0, 30)}
    weight = recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = recent.effective_support(actual, hours, weight)
    supported = residual.supported(counts['training'], POLICY['trainingSupport']) and residual.supported(counts['calibration'], POLICY['calibrationSupport']) and residual.supported(effective, POLICY['effectiveSupport'])
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': bool(supported), 'reason': 'recent_calibration' if supported else 'insufficient_effective_support', 'referenceOrdinal': original, 'referenceWeighted': weighted_state, 'rawCalibration': raw_scale, 'recentProposedRules': None, 'recentRules': None, 'recentNestingSafetyFallback': None, 'calibrations': {}}
    # effective support failures retain complete unchanged reference predictions
    if not supported:
        output['volumeRecent'] = output['volume90'].copy()
        output.update({name: ordinal90.copy() for name in RECENT_ARMS})
    else:
        proposed = recent.calibrate_events(actual, raw_cal, pc, hours, weight)
        rules, fallback = recent.checked_rules(actual, raw_cal, pc, hours, proposed, weight)
        rc, re = ordinal.event_categories(raw_cal, pc, rules), ordinal.event_categories(raw, pe, rules)
        state.update({'recentProposedRules': proposed, 'recentRules': rules, 'recentNestingSafetyFallback': fallback})
        configurations = {
            'ordinalRecentAmount': (cc, ce, weight),
            'ordinalRecentEvents': (rc, re, None),
            PRIMARY: (rc, re, weight),
        }
        # retain attribution ablations without adding selectable candidates
        for name, (cal_categories, eval_categories, mass) in configurations.items():
            # scalar-only ablation keeps the original uniform event calls
            projection = lambda scale: ordinal.project_amount(bc, cal_categories, scale)
            scalar = search.calibrate(actual, hours, projection) if mass is None else recent.calibrate(actual, hours, projection, mass)
            output[name] = ordinal.project_amount(be, eval_categories, scalar['scale'])
            state['calibrations'][name] = scalar
        recent_raw = recent.calibrate(actual, hours, lambda scale: np.clip(raw_cal * scale, 0, 30), weight)
        state['calibrations']['volumeRecent'] = recent_raw
        output['volumeRecent'] = np.clip(raw * recent_raw['scale'], 0, 30)
    return np.where(evaluation)[0], output, state



# measure the worst seasonal volume error without choosing favorable seasons
def seasonal_deviation(report, name):
    values = [report.get('bySeason', {}).get(season, {}).get(name, {}).get('volumeRatio') for season in ('DJF', 'MAM', 'JJA', 'SON')]
    return max(abs(value - 1) for value in values) if all(value is not None and np.isfinite(value) for value in values) else float('inf')


# retain both the original raw safety screen and the gained heavy-event skill
def candidate_screen(report, data, indices, supported):
    counts = residual.support(data['actual'][indices][supported], data['hour'][indices][supported])
    view = search.rename_candidate(report, PRIMARY)
    view['support'] = counts
    view['invariants'] = report['invariants']
    gates = residual.development_gates(view)
    primary, reference = report['overall'][PRIMARY], report['overall']['ordinal90']
    margin = POLICY['comparisonTolerance']
    gates['beatsSameWindowVolumeScale'] = primary['mae'] <= report['overall']['volume90']['mae']
    gates['beatsRecentVolumeScale'] = primary['mae'] <= report['overall']['volumeRecent']['mae']
    gates['beatsUnchangedOrdinal'] = primary['mae'] < reference['mae'] - margin
    gates['seasonalBalanceImproves'] = seasonal_deviation(report, PRIMARY) < seasonal_deviation(report, 'ordinal90') - margin
    heavy = primary['heavyMae'] is not None and reference['heavyMae'] is not None and primary['heavyMae'] <= reference['heavyMae'] + margin
    # preserve gained detection at both heavy thresholds instead of only mean amount
    for threshold in ('1.0', '2.5'):
        candidate, control = report['events'][PRIMARY][threshold], report['events']['ordinal90'][threshold]
        complete = all(value is not None for value in (*[candidate[key] for key in ('pod', 'csi', 'far')], *[control[key] for key in ('pod', 'csi', 'far')]))
        heavy = heavy and complete and candidate['pod'] + margin >= control['pod'] and candidate['csi'] + margin >= control['csi'] - .01 and candidate['far'] <= control['far'] + .05 + margin
    gates['heavySkillRetained'] = bool(heavy)
    return {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [name for name, passed in gates.items() if not passed]}


# score the complete population with unchanged nonrecency evaluation weights
def make_report(root, data, indices, predictions, supported, states, availability):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # preserve equal date-hour-vintage weights in every comparison
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'recency-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'treeFitPerformed': False, 'nativeModelsReused': POLICY['nativeModelsReused']}
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in dates])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    report['featureAvailability'] = {'overall': context.availability_counts(hours, {name: values[indices] for name, values in availability.items()})}
    # keep all original reporting partitions without outcome-dependent exclusions
    for field, labels in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {}
        for key in np.unique(labels):
            report[field][str(key)] = summarize(labels == key)
        report['featureAvailability'][field] = {str(key): context.availability_counts(hours[labels == key], {name: values[indices][labels == key] for name, values in availability.items()}) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['candidateScreen'] = candidate_screen(report, data, indices, supported)
    report['selectedCandidate'] = PRIMARY if report['candidateScreen']['passed'] else None
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    return report


# require exact old forecast identity before computing new aggregate outcomes
def reference_parity(root, indices, predictions):
    mapping = {name: name for name in (*search.BASELINES, 'weightedContext')}
    mapping['ordinal90'] = 'ordinalContext'
    with np.load(root / 'inputs/context/predictions.npz', allow_pickle=False) as archive:
        # preserve the entire previous evaluation row set and all unchanged controls
        if not np.array_equal(indices, archive['indices']):
            raise ValueError('recency reference row identity changed')
        for current, previous in mapping.items():
            if not np.array_equal(predictions[current], archive['amount::' + previous]):
                raise ValueError('recency unchanged control prediction differs')
    return {'exactPredictions': True, 'exactOrdinalAndWeightedStates': True, 'arms': mapping}


# apply one frozen calibration change to fixed historical native models
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # preserve partial and completed runs instead of overwriting failures
    if any((root / name).exists() for name in ('recency-states', 'report.json', 'predictions.npz')):
        raise ValueError('recency replay already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as archive:
        # changing calibration cannot silently change any original forecast input
        if set(archive.files) != {'x', *availability} or not np.array_equal(matrices['full'], archive['x'], equal_nan=True) or any(not np.array_equal(values, archive[name]) for name, values in availability.items()):
            raise ValueError('recency features differ from fixed context inputs')
    x = matrices['full']
    indices, flags, states = [], [], {}
    amounts = {name: [] for name in ARMS}
    directory = root / 'recency-states'
    directory.mkdir(mode=0o700)
    # keep every predeclared month and every fallback forecast row
    for month in inputs.MONTHS:
        rows, output, state = calibrate_month(data, x, root, month)
        inputs.write_json(directory / (month + '.json'), state)
        indices.append(rows)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        for name in ARMS:
            amounts[name].append(output[name])
        print(json.dumps({'month': month, 'rows': len(rows), 'recentCalibrationSupported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    predictions = {name: np.concatenate(parts) for name, parts in amounts.items()}
    # refuse a changed population before looking at model-selection metrics
    if len(indices) != POLICY['expectedEvaluationRows'] or len(np.unique(indices)) != len(indices):
        raise ValueError('recency evaluation population changed')
    parity = reference_parity(root, indices, predictions)
    report = make_report(root, data, indices, predictions, supported, states, availability)
    report['referenceParity'] = parity
    report['featuresSha256'] = inputs.sha(root / 'inputs/context/features.npz')
    report['featureProfileRuns'] = len(profiles)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, recentSupported=supported)
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'independentEvaluationPerformed': False, 'productionEligible': False}


# accept only explicit preparation and single replay commands
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
    arguments = parser.parse_args()
    result = prepare(arguments.source, arguments.root, arguments.retention_receipt) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result), flush=True)

