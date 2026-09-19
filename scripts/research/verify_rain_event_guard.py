"""independently replay the consumed-season rain event-guard experiment."""

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# keep native numerical replay deterministic
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from rain_event_guard import POLICY as RUNNER_POLICY
from rain_event_guard import SOURCE_FILES
from verify_rain_sub24_model import (
    accumulation_metrics,
    metrics,
    require,
    validate_dataset_support,
    weights,
)


# reject changed bytes and unsafe manifest paths
def check_hashes(root, manifest):
    require(isinstance(manifest, dict) and manifest, 'empty evidence hash manifest')
    # bind every declared member
    for name, expected in manifest.items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts and relative.parts, 'unsafe evidence hash path')
        path = root / relative
        require(path.is_file() and not path.is_symlink(), f'missing evidence file: {name}')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f'evidence checksum changed: {name}')


# bind every copied member to the verified encrypted parent archive
def check_retention_chain(inputs, frozen_hashes):
    manifest_path = inputs / 'retention-members.json'
    manifest = json.loads(manifest_path.read_text())
    receipt = json.loads((inputs / 'parent-retention-receipt.json').read_text())
    members = manifest['files']
    require(receipt.get('verdict') == 'PASS' and receipt.get('encryptedRoundtripVerified') is True and receipt.get('remoteCipherChecksumVerified') is True and receipt.get('productionEligible') is False and receipt.get('productionDatabaseOrServiceWrites') is False, 'parent archive retention receipt changed')
    require(receipt['manifestSha256'] == hashlib.sha256(manifest_path.read_bytes()).hexdigest() and receipt['verifiedFiles'] == len(members) + 1, 'parent archive manifest verification changed')
    require(manifest['modelReportSha256'] == frozen_hashes['sub24-models/holdout-report.json'] and manifest['productionEligible'] is False and manifest['productionDatabaseOrServiceWrites'] is False, 'parent archive report or safety boundary changed')
    # bind each copied artifact to its retained member
    for name, expected in frozen_hashes.items():
        # exclude the manifest and external receipt
        if name in ('retention-members.json', 'parent-retention-receipt.json'):
            continue
        require(name in members and members[name]['sha256'] == expected and members[name]['bytes'] == (inputs / name).stat().st_size, f'copied input differs from retained archive: {name}')


# reproduce the old bounded earlier-only volume scale
def calibrated_scale(actual, predicted, hours):
    denominator = float(weights(hours) @ predicted)
    # preserve the old zero-denominator fallback
    if denominator <= 1e-12:
        return 1.0
    return float(np.clip(float(weights(hours) @ actual) / denominator, .5, 2))


# independently constrain raw-wet event and heavy amounts
def event_guard(raw, calibrated):
    raw, calibrated = np.asarray(raw, dtype=float), np.asarray(calibrated, dtype=float)
    require(raw.shape == calibrated.shape and np.isfinite(raw).all() and np.isfinite(calibrated).all() and (raw >= 0).all() and (calibrated >= 0).all(), 'invalid event guard predictions')
    result = np.array(calibrated, copy=True)
    heavy = raw >= 1
    wet = (raw >= .1) & ~heavy
    result[heavy] = raw[heavy]
    result[wet] = np.maximum(.1, result[wet])
    return result


# compare complete JSON trees without silently skipping report fields
def same_tree(expected, reported, path='report'):
    # recurse through exact object keys
    if isinstance(expected, dict):
        require(isinstance(reported, dict) and set(expected) == set(reported), f'{path} keys changed')
        # inspect every nested field
        for key, value in expected.items():
            same_tree(value, reported[key], f'{path}.{key}')
    # retain list order and length
    elif isinstance(expected, list):
        require(isinstance(reported, list) and len(expected) == len(reported), f'{path} list changed')
        # inspect every list value
        for index, value in enumerate(expected):
            same_tree(value, reported[index], f'{path}[{index}]')
    # compare report floats within native reduction tolerance
    elif isinstance(expected, float):
        require(isinstance(reported, (int, float)) and np.isfinite(reported) and np.isclose(expected, reported, rtol=1e-9, atol=1e-10), f'{path} value changed')
    # require exact scalar types and values
    else:
        require(expected == reported and type(expected) is type(reported), f'{path} value changed')


# reconstruct exact monthly masks without using producer calculations
def month_masks(data, month, old_policy):
    start = dt.datetime.fromisoformat(month + '-01T00:00:00+00:00')
    following = (start.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    begin, end = int(start.timestamp() // 3600), int(following.timestamp() // 3600)
    fit_stop, calibration_begin, calibration_end = begin - 59 * 24, begin - 52 * 24, begin - 7 * 24
    training_begin = int(dt.datetime.fromisoformat(old_policy['trainingStartUtc'].replace('Z', '+00:00')).timestamp() // 3600)
    fit = (data['hour'] >= training_begin) & (data['hour'] < fit_stop)
    calibration = (data['hour'] >= calibration_begin) & (data['hour'] < calibration_end)
    evaluation = (data['initialized'] + 8 >= begin) & (data['initialized'] + 8 < end)
    chronology = {'trainingMaximumValidHourExclusive': fit_stop, 'calibrationStartHour': calibration_begin, 'calibrationMaximumValidHourExclusive': calibration_end, 'decisionStartHour': begin, 'decisionStopHourExclusive': end}
    return fit, calibration, evaluation, chronology


# replay only the retained native Tweedie head and exact old monthly scales
def replay_month(data, month, directory, old_policy, feature_names):
    fit, calibration, evaluation, chronology = month_masks(data, month, old_policy)
    state = json.loads((directory / 'state.json').read_text())
    require(state['policy'] == old_policy and state['featureNames'] == feature_names and state['month'] == month, 'retained monthly model policy changed')
    # verify each frozen chronology bound
    for name, expected in chronology.items():
        require(state[name] == expected, f'retained monthly chronology changed: {name}')
    require(state['trainingRows'] == int(fit.sum()) and state['trainingDates'] == len(np.unique(data['hour'][fit] // 24)) and state['trainingMaximumActualHour'] == int(data['hour'][fit].max()) and state['calibrationRows'] == int(calibration.sum()) and state['evaluationRows'] == int(evaluation.sum()), 'retained monthly support changed')
    path = directory / 'tweedie.json'
    require(hashlib.sha256(path.read_bytes()).hexdigest() == state['modelHashes']['tweedie'], 'retained Tweedie model hash changed')
    booster = xgb.Booster(model_file=path)
    config = json.loads(booster.save_config())
    require(booster.feature_names == feature_names and booster.num_boosted_rounds() == old_policy['boostRounds'] and config['learner']['objective']['name'] == 'reg:tweedie', 'retained Tweedie model schema changed')
    require(xgb.__version__ == old_policy['xgboostVersion'], 'native XGBoost runtime changed')
    forecast = {}
    # replay calibration before evaluation
    for name, selected in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(data['x'][selected], feature_names=feature_names, nthread=1)
        forecast[name] = np.clip(booster.predict(matrix), 0, old_policy['predictionMaximumMm'])
    cal_raw, cal_tweedie = data['raw'][calibration], forecast['calibration']
    cal_actual, cal_hour = data['actual'][calibration], data['hour'][calibration]
    raw_scale = calibrated_scale(cal_actual, cal_raw, cal_hour)
    blend_scale = calibrated_scale(cal_actual, .5 * cal_raw + .5 * cal_tweedie, cal_hour)
    require(np.isclose(raw_scale, state['scales']['raw'], rtol=0, atol=1e-9), 'raw calibration scale changed')
    require(np.isclose(blend_scale, state['scales']['tweedie-raw0.5'], rtol=0, atol=1e-9), 'Tweedie calibration scale changed')
    raw = data['raw'][evaluation]
    blended = np.clip((.5 * raw + .5 * forecast['evaluation']) * blend_scale, 0, old_policy['predictionMaximumMm'])
    recent = data['persistence'][evaluation]
    persistence = np.where(np.isfinite(recent), np.maximum(0, recent), raw)
    amounts = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': persistence, 'volumeScale': raw * raw_scale, 'calibratedTweedie': blended, 'eventGuard': event_guard(raw, blended)}
    return np.where(evaluation)[0], amounts


# bind copied source, paired labels and source-verification receipts
def load_inputs(root):
    freeze = json.loads((root / 'freeze.json').read_text())
    require(freeze['policy'] == RUNNER_POLICY and set(freeze['sourceSha256']) == set(SOURCE_FILES) and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'new experiment policy or freeze boundary changed')
    inputs = root / 'inputs'
    check_hashes(inputs, freeze['inputSha256'])
    check_retention_chain(inputs, freeze['inputSha256'])
    check_hashes(root / 'sources', freeze['sourceSha256'])
    check_hashes(Path(__file__).parent, freeze['sourceSha256'])
    pairing = json.loads((inputs / 'sub24-dataset/pairing-receipt.json').read_text())
    old_freeze = json.loads((inputs / 'model-evaluation-freeze.json').read_text())
    old_policy = old_freeze['policy']
    feature_names = old_freeze['featureNames']
    require(pairing['policy'] == old_policy and pairing['featureNames'] == feature_names and freeze['featureNames'] == feature_names, 'paired feature policy lineage changed')
    check_hashes(inputs / 'sub24-model-sources', old_freeze['sourceSha256'])
    pair_path = inputs / 'sub24-dataset/paired.npz'
    require(freeze['parentPairedSha256'] == freeze['inputSha256']['sub24-dataset/paired.npz'], 'parent dataset freeze checksum changed')
    require(hashlib.sha256(pair_path.read_bytes()).hexdigest() == pairing['pairedSha256'], 'paired dataset receipt checksum changed')
    # avoid pickle-backed array payloads
    with np.load(pair_path, allow_pickle=False) as material:
        data = {name: material[name] for name in material.files}
    required = {'x', 'actual', 'mean', 'raw', 'hour', 'initialized', 'lead', 'support', 'actual_temperature', 'persistence'}
    require(set(data) == required, 'paired dataset schema changed')
    size = len(data['actual'])
    require(data['x'].shape == (size, len(feature_names)) and all(data[name].shape == (size,) for name in required - {'x'}), 'paired array alignment changed')
    require(np.isfinite(data['actual']).all() and np.isfinite(data['raw']).all() and np.isfinite(data['hour']).all() and (data['actual'] >= 0).all() and (data['raw'] >= 0).all(), 'paired amount or hour changed')
    require(np.array_equal(data['hour'], data['initialized'] + 8 + data['lead']) and np.array_equal(data['x'][:, feature_names.index('rawRain')], data['raw']), 'paired forecast lead identity changed')
    observation_receipt_bytes = (inputs / 'sub24-dataset/observation-receipt.json').read_bytes()
    require(hashlib.sha256(observation_receipt_bytes).hexdigest() == pairing['observationReceiptSha256'], 'observation receipt lineage changed')
    observation_receipt = json.loads(observation_receipt_bytes)
    observations_path = inputs / 'sub24-dataset/observations.npz'
    require(hashlib.sha256(observations_path.read_bytes()).hexdigest() == observation_receipt['observationsSha256'], 'hourly observation checksum changed')
    # bind observation arrays to paired labels
    with np.load(observations_path, allow_pickle=False) as material:
        observations = {name: material[name] for name in material.files}
    validate_dataset_support(data, observations, observation_receipt, old_policy, feature_names)
    lag = data['initialized'] + 7 - int(observations['first_hour'])
    expected = np.full(len(lag), np.nan)
    available = (lag >= 0) & (lag < len(observations['target']))
    expected[available] = observations['target'][lag[available]]
    require(np.array_equal(expected, data['persistence'], equal_nan=True), 'persistence no longer uses the causal network target')
    manifest = (inputs / 'acquisition/manifest.json').read_bytes()
    forecast_receipt = json.loads((inputs / 'final-evidence/forecast-independent-verification.json').read_text())
    station_receipt = json.loads((inputs / 'final-evidence/station-independent-verification.json').read_text())
    model_receipt = json.loads((inputs / 'final-evidence/model-independent-verification.json').read_text())
    station_manifest = (inputs / 'station-acquisition/manifest.json').read_bytes()
    report = (inputs / 'sub24-models/holdout-report.json').read_bytes()
    require(forecast_receipt['verified'] is True and station_receipt['verified'] is True and model_receipt['verified'] is True and hashlib.sha256(manifest).hexdigest() == pairing['forecastManifestSha256'] == forecast_receipt['manifestSha256'] and hashlib.sha256(station_manifest).hexdigest() == station_receipt['manifestSha256'] and hashlib.sha256(report).hexdigest() == model_receipt['reportSha256'], 'forecast, station or model source verification changed')
    return freeze, old_policy, feature_names, data


# verify all twelve consumed monthly states without opening a future outcome
def replay_all(root, freeze, old_policy, feature_names, data):
    months = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
    require(freeze['policy']['developmentMonths'] == months and old_policy['holdoutMonths'] == months, 'development month boundary changed')
    indices = []
    amounts = collections.defaultdict(list)
    # visit only consumed development months
    for month in months:
        selected, forecast = replay_month(data, month, root / 'inputs/sub24-models' / month, old_policy, feature_names)
        indices.extend(selected.tolist())
        # retain every declared comparator
        for name, value in forecast.items():
            amounts[name].append(value)
    return np.asarray(indices), {name: np.concatenate(parts) for name, parts in amounts.items()}, len(months)


# score amount and threshold events with the independent legacy metric reducer
def score_amounts(data, indices, amounts):
    actual, hours = data['actual'][indices], data['hour'][indices]
    require(len(indices) and len(set(map(len, amounts.values()))) == 1 and len(next(iter(amounts.values()))) == len(indices), 'prediction population changed')
    return {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}


# rederive all chronology-compatible report partitions
def report_groups(data, indices, old_policy):
    hours = data['hour'][indices]
    months = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).month for hour in hours])
    season = np.array(['DJF' if month in (12, 1, 2) else 'MAM' if month in (3, 4, 5) else 'JJA' if month in (6, 7, 8) else 'SON' for month in months])
    month_labels = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).strftime('%Y-%m') for hour in hours])
    lead = data['lead'][indices]
    cutover = int(dt.datetime.fromisoformat(old_policy['archiveEraCutoverUtc'].replace('Z', '+00:00')).timestamp() // 3600)
    era = np.where(data['initialized'][indices] < cutover, 'before_50r1_cutover', 'from_50r1_cutover')
    return {'byLeadBand': np.where(lead <= 6, '1-6', np.where(lead <= 12, '7-12', '13-23')), 'bySeason': season, 'byMonth': month_labels, 'byArchiveEra': era}


# independently score each fixed group on identical candidate rows
def score_groups(data, indices, amounts, old_policy):
    actual, hours = data['actual'][indices], data['hour'][indices]
    output = {}
    # preserve each full report partition
    for field, labels in report_groups(data, indices, old_policy).items():
        output[field] = {}
        # score each observed group separately
        for label in np.unique(labels):
            selected = labels == label
            output[field][str(label)] = {name: metrics(actual[selected], prediction[selected], (prediction[selected] >= .1).astype(float), hours[selected]) for name, prediction in amounts.items()}
    return output


# refuse gapped or mixed-initialization accumulation windows
def score_accumulations(data, indices, amounts):
    groups = collections.defaultdict(dict)
    # reconstruct same-run horizon maps
    for position, (initialized, lead) in enumerate(zip(data['initialized'][indices], data['lead'][indices], strict=True)):
        run = groups[int(initialized)]
        require(int(lead) not in run, 'duplicate run horizon in accumulation')
        run[int(lead)] = position
    actual, hours = data['actual'][indices], data['hour'][indices]
    output = {}
    # score only complete prefix lengths
    for length in (6, 12, 23):
        windows = [[run[lead] for lead in range(1, length + 1)] for run in groups.values() if all(lead in run for lead in range(1, length + 1))]
        # reject unsupported windows without inventing sums
        if not windows:
            output[str(length)] = {'runs': 0}
            continue
        chosen = np.asarray(windows)
        endpoint = hours[chosen[:, -1]]
        output[str(length)] = {'runs': len(windows), 'candidates': {name: accumulation_metrics(actual[chosen], predicted[chosen], endpoint) for name, predicted in amounts.items()}}
    return output


# report independently weighted event decisions at all frozen thresholds
def score_events(actual, hours, amounts, thresholds):
    weight = weights(hours)
    output = {}
    # give every candidate identical threshold scoring
    for name, predicted in amounts.items():
        scores = {}
        # preserve wet and both heavy categories
        for threshold in thresholds:
            observed, called = actual >= threshold, predicted >= threshold
            hit = float(weight[observed & called].sum())
            miss = float(weight[observed & ~called].sum())
            false = float(weight[~observed & called].sum())
            scores[str(threshold)] = {'pod': None if hit + miss == 0 else hit / (hit + miss), 'csi': None if hit + miss + false == 0 else hit / (hit + miss + false), 'far': None if hit + false == 0 else false / (hit + false), 'observedHours': len(np.unique(hours[observed]))}
        output[name] = scores
    return output


# derive guard invariants from every stored forecast, not aggregate scores
def guard_invariants(actual, raw, guarded):
    new_calls = (raw < .1) & (guarded >= .1)
    return {'rawHeavyAmountsUnchanged': bool(np.array_equal(guarded[raw >= 1], raw[raw >= 1])), 'rawWetCallsPreserved': bool(np.all(guarded[raw >= .1] >= .1)), 'rawDryCallsAdded': int(new_calls.sum()), 'rawDryObservedWetCallsAdded': int((new_calls & (actual >= .1)).sum())}


# independently enforce the frozen development-only screen
def development_gates(report, policy):
    limits = policy['screen']
    baseline, chosen = report['overall']['raw'], report['overall']['eventGuard']
    low, high = limits['volumeRatioBounds']
    gates = {
        'maeImprovesFivePercent': chosen['mae'] <= baseline['mae'] * (1 - limits['minimumMaeImprovement']),
        'beatsVolumeScale': chosen['mae'] <= report['overall']['volumeScale']['mae'],
        'beatsPersistence': chosen['mae'] <= report['overall']['persistence']['mae'],
        'rmseNoWorse': chosen['rmse'] <= baseline['rmse'],
        'wetIntensityNoWorse': chosen['wetMae'] is not None and baseline['wetMae'] is not None and chosen['wetMae'] <= baseline['wetMae'] * limits['maximumWetMaeRatio'],
        'heavyIntensityBounded': chosen['heavyMae'] is not None and baseline['heavyMae'] is not None and chosen['heavyMae'] <= baseline['heavyMae'] * limits['maximumHeavyMaeRatio'],
        'annualVolumeBalanced': chosen['volumeRatio'] is not None and low <= chosen['volumeRatio'] <= high,
        'overallSupport': chosen['dates'] >= limits['minimumDates'] and chosen['wetDates'] >= limits['minimumWetDates'] and chosen['heavyHours'] >= limits['minimumHeavyHours'],
        'allSeasonsPresent': set(report['bySeason']) == {'DJF', 'MAM', 'JJA', 'SON'},
        'allLeadBandsPresent': set(report['byLeadBand']) == {'1-6', '7-12', '13-23'},
        'rawHeavyAmountsUnchanged': report['invariants']['rawHeavyAmountsUnchanged'],
        'rawWetCallsPreserved': report['invariants']['rawWetCallsPreserved'],
    }
    # enforce all prespecified event thresholds
    for threshold in policy['thresholdsMmPerHour']:
        key = str(threshold)
        raw, selected = report['events']['raw'][key], report['events']['eventGuard'][key]
        supported = all(raw[name] is not None and selected[name] is not None for name in ('pod', 'csi', 'far'))
        gates[f'event{key}Safety'] = supported and selected['pod'] >= raw['pod'] + limits['minimumPodDelta'] - 1e-12 and selected['csi'] >= raw['csi'] + limits['minimumCsiDelta'] and selected['far'] <= raw['far'] + limits['maximumFarDelta']
    # require season-level amount and detection safety
    for season, values in report['bySeason'].items():
        raw, selected = values['raw'], values['eventGuard']
        gates[f'season{season}Support'] = selected['dates'] >= limits['minimumSeasonDates'] and selected['wetDates'] >= limits['minimumSeasonWetDates'] and selected['heavyHours'] >= 5
        gates[f'season{season}Volume'] = selected['volumeRatio'] is not None and low <= selected['volumeRatio'] <= high
        gates[f'season{season}Mae'] = selected['mae'] <= raw['mae'] * limits['maximumSeasonMaeRatio']
        gates[f'season{season}WetHeavy'] = selected['wetMae'] is not None and raw['wetMae'] is not None and selected['heavyMae'] is not None and raw['heavyMae'] is not None and selected['wetMae'] <= raw['wetMae'] and selected['heavyMae'] <= raw['heavyMae'] * limits['maximumHeavyMaeRatio']
        gates[f'season{season}Detection'] = selected['pod'] >= raw['pod'] - 1e-12 and selected['csi'] >= raw['csi'] + limits['minimumCsiDelta'] and selected['far'] <= raw['far'] + limits['maximumFarDelta']
    # require every first-day lead band
    for band, values in report['byLeadBand'].items():
        gates[f'lead{band}Mae'] = values['eventGuard']['mae'] <= values['raw']['mae'] * limits['maximumLeadMaeRatio']
        gates[f'lead{band}Support'] = values['eventGuard']['wetDates'] >= 20 and values['eventGuard']['heavyHours'] >= 5
    # require complete same-run accumulations
    for length in (6, 12, 23):
        result = report['accumulations'].get(str(length), {})
        gates[f'accumulation{length}Mae'] = result.get('runs', 0) > 0 and result['candidates']['eventGuard']['mae'] <= result['candidates']['raw']['mae']
    return gates


# rederive every report field from native models and source-bound target arrays
def expected_report(root, freeze, old_policy, data, indices, amounts):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest(), 'overall': score_amounts(data, indices, amounts), 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report.update(score_groups(data, indices, amounts, old_policy))
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in amounts.items()}
    report['events'] = score_events(actual, hours, amounts, freeze['policy']['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, amounts)
    report['invariants'] = guard_invariants(actual, amounts['raw'], amounts['eventGuard'])
    report['developmentGates'] = development_gates(report, freeze['policy'])
    report['developmentPassed'] = all(report['developmentGates'].values())
    report['decision'] = 'eligible_for_separate_prospective_protocol_not_qualified' if report['developmentPassed'] else 'rejected_development_no_retuning_or_prospective_unlock'
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# verify the immutable replay archive before issuing an aggregate receipt
def verify(root, evidence):
    freeze, old_policy, feature_names, data = load_inputs(root)
    indices, amounts, states = replay_all(root, freeze, old_policy, feature_names, data)
    # read the retained row archive without pickle
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices'} | {f'amount::{name}' for name in amounts}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices), 'retained prediction population changed')
    # replay each named arm against retained rows
    for name, predicted in amounts.items():
        stored = archive[f'amount::{name}']
        require(stored.shape == predicted.shape and np.isfinite(stored).all() and (stored >= 0).all() and np.allclose(stored, predicted, rtol=1e-8, atol=1e-9), f'native replay mismatch: {name}')
    expected = expected_report(root, freeze, old_policy, data, indices, amounts)
    report_path = root / 'report.json'
    reported = json.loads(report_path.read_text())
    same_tree(expected, reported)
    receipt = {'contractVersion': 'rain-event-guard-independent-verification/v1', 'verified': True, 'nativeModelStatesReplayed': states, 'developmentPredictionRows': len(indices), 'scalarSeasonLeadEventAndAccumulationMetricsVerified': True, 'developmentGatesVerified': True, 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # keep verification separate from immutable experiment outputs
    with Path(evidence).open('x') as stream:
        json.dump(receipt, stream, allow_nan=False, sort_keys=True)
        stream.write('\n')
    return receipt


# run only on an explicit private experiment root
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
