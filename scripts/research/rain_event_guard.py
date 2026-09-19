"""screen one frozen rain-event guard on explicitly consumed development data."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil

# bound the existing numerical runtime
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, month_masks, score, validate_dataset, validate_observation_support

MONTHS = tuple([f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)])
ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'calibratedTweedie', 'eventGuard')
POLICY = {
    'contractVersion': 'rain-event-guard-development/v1',
    'candidate': 'eventGuard',
    'developmentMonths': list(MONTHS),
    'developmentDataPreviouslyConsumed': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'modelFit': 'reuse_exact_frozen_monthly_tweedie_boosters_no_refit',
    'formula': 'clip((0.5*clip(tweedie,0,30)+0.5*raw)*earlier_blend_scale,0,30); raw>=1:raw; 0.1<=raw<1:max(0.1,blend); raw<0.1:blend',
    'calibration': 'retain_original_45_day_blend_scale_and_seven_day_embargo_no_post_guard_scaling',
    'probability': 'deterministic_point_event_indicator_not_calibrated_probability',
    'thresholdsMmPerHour': [0.1, 1.0, 2.5],
    'prospectiveEvaluation': {
        'earliestDecisionUtc': '2026-10-01T00:00:00Z',
        'status': 'not_started_not_scheduled',
        'requires': ['development_pass', 'separate_frozen_prospective_protocol', 'same_source_current_era', 'actual_forecast_and_station_receipt_times', 'causal_feature_and_label_maturity_validation'],
        'calendarAloneDoesNotQualify': True,
    },
    'screen': {
        'minimumMaeImprovement': 0.05,
        'maximumWetMaeRatio': 1.0,
        'maximumHeavyMaeRatio': 1.05,
        'minimumPodDelta': 0.0,
        'minimumCsiDelta': -0.01,
        'maximumFarDelta': 0.05,
        'volumeRatioBounds': [0.8, 1.2],
        'minimumDates': 300,
        'minimumWetDates': 100,
        'minimumHeavyHours': 50,
        'minimumSeasonDates': 60,
        'minimumSeasonWetDates': 10,
        'maximumLeadMaeRatio': 1.05,
        'maximumSeasonMaeRatio': 1.10,
    },
}
SOURCE_FILES = ('rain_event_guard.py', 'rain_sub24.py', 'run_rain_sub24.py', 'build_rain_sub24.py', 'build_moisture_targets.py', 'export_moisture_history.py', 'retain_moisture_research.py')


# bind exact bytes rather than mutable filenames
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# reject overwrites and nonfinite reports
def write_json(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')


# freeze metadata and native models before computing new outcomes
def prepare(source, destination, retention_receipt):
    source = validate_private_root(source)
    # require a new private output inside the approved research base
    if destination.parent != source.parent or not destination.name.startswith('weather-moisture-research-'):
        raise ValueError('new experiment must use a sibling private research root')
    destination.mkdir(mode=0o700)
    validate_private_root(destination)
    inputs = destination / 'inputs'
    inputs.mkdir(mode=0o700)
    names = [f'sub24-dataset/{name}' for name in ('paired.npz', 'pairing-receipt.json', 'observations.npz', 'observation-receipt.json')]
    names += ['model-evaluation-freeze.json', 'acquisition/manifest.json', 'station-acquisition/manifest.json', 'sub24-models/holdout-report.json', 'retention-members.json']
    names += [f'final-evidence/{name}-independent-verification.json' for name in ('forecast', 'station', 'model')]
    # retain each original booster and its earlier-only calibration state
    for month in MONTHS:
        names += [f'sub24-models/{month}/{name}' for name in ('tweedie.json', 'state.json')]
    # include the exact original source archive alongside the new source freeze
    parent_freeze = json.loads((source / 'model-evaluation-freeze.json').read_text())
    names += [f'sub24-model-sources/{name}' for name in parent_freeze['sourceSha256']]
    retained = json.loads(retention_receipt.read_text())
    members = json.loads((source / 'retention-members.json').read_text())['files']
    # bind this input subset to the independently verified original archive
    if retained.get('verdict') != 'PASS' or retained.get('encryptedRoundtripVerified') is not True or retained.get('remoteCipherChecksumVerified') is not True or retained['manifestSha256'] != sha(source / 'retention-members.json'):
        raise ValueError('original archive retention is not verified')
    hashes = {}
    # copy only explicit nonlinked input members
    for name in names:
        path = source / name
        # refuse symlinks anywhere below the private input root
        if any(part.is_symlink() for part in (path, *path.parents) if part != source.parent):
            raise ValueError('linked research input')
        output = inputs / name
        output.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        shutil.copyfile(path, output)
        output.chmod(0o600)
        hashes[name] = sha(output)
        # fail on source changes during snapshotting
        if hashes[name] != sha(path):
            raise ValueError('research source changed during copying')
        # every copied original artifact must match its encrypted archive member
        if name != 'retention-members.json' and hashes[name] != members[name]['sha256']:
            raise ValueError('input differs from original retained archive')
    shutil.copyfile(retention_receipt, inputs / 'parent-retention-receipt.json')
    hashes['parent-retention-receipt.json'] = sha(inputs / 'parent-retention-receipt.json')
    sources = destination / 'sources'
    sources.mkdir(mode=0o700)
    source_hashes = {}
    # freeze new runtime dependencies separately from the old experiment
    for name in SOURCE_FILES:
        original = Path(__file__).with_name(name)
        shutil.copyfile(original, sources / name)
        source_hashes[name] = sha(original)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'inputSha256': hashes, 'sourceSha256': source_hashes, 'parentPairedSha256': hashes['sub24-dataset/paired.npz'], 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    write_json(destination / 'freeze.json', freeze)
    validate_freeze(destination)
    return freeze


# fail closed on input, implementation or policy changes
def validate_freeze(root):
    root = validate_private_root(root)
    freeze = json.loads((root / 'freeze.json').read_text())
    # bind the single declared candidate and research-only boundary
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or set(freeze['sourceSha256']) != set(SOURCE_FILES):
        raise ValueError('event guard policy or source set changed')
    # bind both running and retained source bytes
    for name, expected in freeze['sourceSha256'].items():
        if sha(Path(__file__).with_name(name)) != expected or sha(root / 'sources' / name) != expected:
            raise ValueError('event guard implementation changed after freeze')
    # bind every frozen private input
    for name, expected in freeze['inputSha256'].items():
        if sha(root / 'inputs' / name) != expected:
            raise ValueError('event guard input changed after freeze')
    return freeze


# revalidate inherited targets, identities and causal persistence
def load_inputs(root):
    validate_freeze(root)
    inputs = root / 'inputs'
    pairing = json.loads((inputs / 'sub24-dataset/pairing-receipt.json').read_text())
    receipt = json.loads((inputs / 'sub24-dataset/observation-receipt.json').read_text())
    parent = json.loads((inputs / 'model-evaluation-freeze.json').read_text())
    # bind the original source freeze without invoking obsolete running sources
    for name, expected in parent['sourceSha256'].items():
        if sha(inputs / 'sub24-model-sources' / name) != expected:
            raise ValueError('original frozen source changed')
    # retain verified forecast, station and model lineage
    for name, manifest in (('forecast', 'acquisition/manifest.json'), ('station', 'station-acquisition/manifest.json')):
        verified = json.loads((inputs / f'final-evidence/{name}-independent-verification.json').read_text())
        if verified.get('verified') is not True or verified['manifestSha256'] != sha(inputs / manifest):
            raise ValueError('original acquisition verification changed')
    verified_model = json.loads((inputs / 'final-evidence/model-independent-verification.json').read_text())
    # require retained independent replay rather than treating fitting as verification
    if verified_model.get('verified') is not True or verified_model['reportSha256'] != sha(inputs / 'sub24-models/holdout-report.json'):
        raise ValueError('original model verification changed')
    # require the same source cohort, feature schema and byte-bound target archives
    if pairing['policy'] != PARENT_POLICY or parent['policy'] != PARENT_POLICY or pairing['pairedSha256'] != sha(inputs / 'sub24-dataset/paired.npz') or pairing['observationReceiptSha256'] != sha(inputs / 'sub24-dataset/observation-receipt.json') or receipt['observationsSha256'] != sha(inputs / 'sub24-dataset/observations.npz') or pairing['forecastManifestSha256'] != sha(inputs / 'acquisition/manifest.json'):
        raise ValueError('original paired lineage changed')
    with np.load(inputs / 'sub24-dataset/paired.npz', allow_pickle=False) as archive:
        data = {name: archive[name] for name in archive.files}
    validate_dataset(data, pairing)
    with np.load(inputs / 'sub24-dataset/observations.npz', allow_pickle=False) as archive:
        observations = {name: archive[name] for name in archive.files}
    validate_observation_support(data, observations, receipt)
    lag = data['initialized'] + 7 - int(observations['first_hour'])
    expected = np.full(len(lag), np.nan)
    available = (lag >= 0) & (lag < len(observations['target']))
    expected[available] = observations['target'][lag[available]]
    # preserve exactly the same earlier-hour network statistic
    if not np.array_equal(expected, data['persistence'], equal_nan=True):
        raise ValueError('causal persistence target changed')
    return data


# preserve raw heavy amounts and raw wet calls while permitting new wet calls
def guard(raw, calibrated):
    raw, calibrated = np.asarray(raw, dtype=float), np.asarray(calibrated, dtype=float)
    # reject invalid inference before applying safety constraints
    if raw.shape != calibrated.shape or not np.isfinite(raw).all() or not np.isfinite(calibrated).all() or (raw < 0).any() or (calibrated < 0).any():
        raise ValueError('invalid event guard predictions')
    return np.where(raw >= 1, raw, np.where(raw >= .1, np.maximum(.1, calibrated), calibrated))


# use unique-date/hour weights for event diagnostics at every frozen threshold
def event_scores(actual, predicted, hours):
    from run_rain_sub24 import weights
    w = weights(hours)
    result = {}
    # report heavy detection separately from wet-hour intensity
    for threshold in POLICY['thresholdsMmPerHour']:
        observed, called = actual >= threshold, predicted >= threshold
        hit = float(w @ (observed & called))
        miss = float(w @ (observed & ~called))
        false = float(w @ (~observed & called))
        result[str(threshold)] = {'pod': None if hit + miss == 0 else hit / (hit + miss), 'csi': None if hit + miss + false == 0 else hit / (hit + miss + false), 'far': None if hit + false == 0 else false / (hit + false), 'observedHours': len(np.unique(hours[observed]))}
    return result


# evaluate one fixed candidate without selecting favorable slices or controls
def development_gates(report):
    limits = POLICY['screen']
    raw, candidate = report['overall']['raw'], report['overall']['eventGuard']
    low, high = limits['volumeRatioBounds']
    gates = {
        'maeImprovesFivePercent': candidate['mae'] <= raw['mae'] * (1 - limits['minimumMaeImprovement']),
        'beatsVolumeScale': candidate['mae'] <= report['overall']['volumeScale']['mae'],
        'beatsPersistence': candidate['mae'] <= report['overall']['persistence']['mae'],
        'rmseNoWorse': candidate['rmse'] <= raw['rmse'],
        'wetIntensityNoWorse': candidate['wetMae'] is not None and raw['wetMae'] is not None and candidate['wetMae'] <= raw['wetMae'] * limits['maximumWetMaeRatio'],
        'heavyIntensityBounded': candidate['heavyMae'] is not None and raw['heavyMae'] is not None and candidate['heavyMae'] <= raw['heavyMae'] * limits['maximumHeavyMaeRatio'],
        'annualVolumeBalanced': candidate['volumeRatio'] is not None and low <= candidate['volumeRatio'] <= high,
        'overallSupport': candidate['dates'] >= limits['minimumDates'] and candidate['wetDates'] >= limits['minimumWetDates'] and candidate['heavyHours'] >= limits['minimumHeavyHours'],
        'allSeasonsPresent': set(report['bySeason']) == {'DJF', 'MAM', 'JJA', 'SON'},
        'allLeadBandsPresent': set(report['byLeadBand']) == {'1-6', '7-12', '13-23'},
        'rawHeavyAmountsUnchanged': report['invariants']['rawHeavyAmountsUnchanged'],
        'rawWetCallsPreserved': report['invariants']['rawWetCallsPreserved'],
    }
    # require detection safety across wet and heavy thresholds
    for threshold in POLICY['thresholdsMmPerHour']:
        key = str(threshold)
        baseline, selected = report['events']['raw'][key], report['events']['eventGuard'][key]
        supported = all(baseline[name] is not None and selected[name] is not None for name in ('pod', 'csi', 'far'))
        gates[f'event{key}Safety'] = supported and selected['pod'] >= baseline['pod'] + limits['minimumPodDelta'] - 1e-12 and selected['csi'] >= baseline['csi'] + limits['minimumCsiDelta'] and selected['far'] <= baseline['far'] + limits['maximumFarDelta']
    # apply the same wet/heavy/detection checks within each supported season
    for season, values in report['bySeason'].items():
        base, selected = values['raw'], values['eventGuard']
        gates[f'season{season}Support'] = selected['dates'] >= limits['minimumSeasonDates'] and selected['wetDates'] >= limits['minimumSeasonWetDates'] and selected['heavyHours'] >= 5
        gates[f'season{season}Volume'] = selected['volumeRatio'] is not None and low <= selected['volumeRatio'] <= high
        gates[f'season{season}Mae'] = selected['mae'] <= base['mae'] * limits['maximumSeasonMaeRatio']
        gates[f'season{season}WetHeavy'] = selected['wetMae'] is not None and base['wetMae'] is not None and selected['heavyMae'] is not None and base['heavyMae'] is not None and selected['wetMae'] <= base['wetMae'] and selected['heavyMae'] <= base['heavyMae'] * limits['maximumHeavyMaeRatio']
        gates[f'season{season}Detection'] = selected['pod'] >= base['pod'] - 1e-12 and selected['csi'] >= base['csi'] + limits['minimumCsiDelta'] and selected['far'] <= base['far'] + limits['maximumFarDelta']
    # retain all first-day lead bands regardless of outcome
    for band, values in report['byLeadBand'].items():
        gates[f'lead{band}Mae'] = values['eventGuard']['mae'] <= values['raw']['mae'] * limits['maximumLeadMaeRatio']
        gates[f'lead{band}Support'] = values['eventGuard']['wetDates'] >= 20 and values['eventGuard']['heavyHours'] >= 5
    # require complete same-run accumulations and corrected endpoint weighting
    for length in (6, 12, 23):
        result = report['accumulations'].get(str(length), {})
        gates[f'accumulation{length}Mae'] = result.get('runs', 0) > 0 and result['candidates']['eventGuard']['mae'] <= result['candidates']['raw']['mae']
    return gates


# materialize native monthly predictions without training or changing old models
def replay_month(root, data, month):
    directory = root / 'inputs/sub24-models' / month
    state = json.loads((directory / 'state.json').read_text())
    fit, calibration, evaluation, bounds = month_masks(data, month)
    # bind original chronology and native model bytes before replay
    if xgb.__version__ != PARENT_POLICY['xgboostVersion'] or state['policy'] != PARENT_POLICY or state['featureNames'] != list(FEATURE_NAMES) or any(state[key] != value for key, value in bounds.items()) or state['modelHashes']['tweedie'] != sha(directory / 'tweedie.json') or state['trainingMaximumActualHour'] != int(data['hour'][fit].max()) or state['trainingRows'] != int(fit.sum()) or state['calibrationRows'] != int(calibration.sum()) or state['evaluationRows'] != int(evaluation.sum()):
        raise ValueError('monthly frozen model identity or chronology changed')
    booster = xgb.Booster(model_file=directory / 'tweedie.json')
    config = json.loads(booster.save_config())
    # require the same trained amount head and feature schema
    if booster.feature_names != list(FEATURE_NAMES) or booster.num_boosted_rounds() != PARENT_POLICY['boostRounds'] or config['learner']['objective']['name'] != 'reg:tweedie':
        raise ValueError('native Tweedie contract changed')
    matrix = xgb.DMatrix(data['x'][evaluation], feature_names=list(FEATURE_NAMES), nthread=1)
    tweedie = np.clip(booster.predict(matrix), 0, 30)
    raw = data['raw'][evaluation]
    calibrated = np.clip((.5 * tweedie + .5 * raw) * state['scales']['tweedie-raw0.5'], 0, 30)
    persistence = data['persistence'][evaluation]
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(persistence), persistence, raw), 'volumeScale': raw * state['scales']['raw'], 'calibratedTweedie': calibrated, 'eventGuard': guard(raw, calibrated)}
    return np.where(evaluation)[0], output


# summarize a single seasonal development replay without opening future data
def run(root):
    root = validate_private_root(root)
    # never replace a completed or interrupted replay
    if (root / 'report.json').exists() or (root / 'predictions.npz').exists():
        raise ValueError('event guard replay already exists')
    data = load_inputs(root)
    indices, predictions = [], {name: [] for name in ARMS}
    # run exactly the months recorded before outcome inspection
    for month in MONTHS:
        rows, output = replay_month(root, data, month)
        indices.append(rows)
        for name in ARMS:
            predictions[name].append(output[name])
        print(json.dumps({'stage': 'native_replay', 'month': month, 'rows': len(rows)}), flush=True)
    indices = np.concatenate(indices)
    predictions = {name: np.concatenate(parts) for name, parts in predictions.items()}
    actual, hours = data['actual'][indices], data['hour'][indices]

    # share identical scoring populations across the fixed arms
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': sha(root / 'freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'byLeadBand': {}, 'bySeason': {}, 'byMonth': {}, 'byArchiveEra': {}, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    month_numbers = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).month for hour in hours])
    seasons = np.array([('DJF' if month in (12, 1, 2) else 'MAM' if month in (3, 4, 5) else 'JJA' if month in (6, 7, 8) else 'SON') for month in month_numbers])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    months = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).strftime('%Y-%m') for hour in hours])
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # retain every season, month, lead group and model-era diagnostic
    for field, groups in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', months), ('byArchiveEra', era)):
        for key in np.unique(groups):
            report[field][str(key)] = summarize(groups == key)
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    raw, candidate = predictions['raw'], predictions['eventGuard']
    report['invariants'] = {'rawHeavyAmountsUnchanged': bool(np.array_equal(candidate[raw >= 1], raw[raw >= 1])), 'rawWetCallsPreserved': bool(np.all(candidate[raw >= .1] >= .1)), 'rawDryCallsAdded': int(np.sum((raw < .1) & (candidate >= .1))), 'rawDryObservedWetCallsAdded': int(np.sum((raw < .1) & (candidate >= .1) & (actual >= .1)))}
    report['developmentGates'] = development_gates(report)
    report['developmentPassed'] = all(report['developmentGates'].values())
    report['decision'] = 'eligible_for_separate_prospective_protocol_not_qualified' if report['developmentPassed'] else 'rejected_development_no_retuning_or_prospective_unlock'
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{f'amount::{name}': values for name, values in predictions.items()})
    report['predictionsSha256'] = sha(root / 'predictions.npz')
    write_json(root / 'report.json', report)
    return {'developmentPassed': report['developmentPassed'], 'failedGates': [name for name, passed in report['developmentGates'].items() if not passed], 'productionEligible': False, 'independentEvaluationPerformed': False}


# require explicit preparation or execution rather than import-time work
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_command = commands.add_parser('prepare')
    prepare_command.add_argument('source', type=Path)
    prepare_command.add_argument('destination', type=Path)
    prepare_command.add_argument('--retention-receipt', type=Path, required=True)
    run_command = commands.add_parser('run')
    run_command.add_argument('root', type=Path)
    args = parser.parse_args()
    result = prepare(args.source, args.destination, args.retention_receipt) if args.command == 'prepare' else run(args.root)
    print(json.dumps(result), flush=True)
