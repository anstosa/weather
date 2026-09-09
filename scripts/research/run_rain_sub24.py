"""fit occurrence and amount models with frozen monthly first-day evaluation."""

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# pin native threads before loading numerical libraries
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
from build_rain_sub24 import write_json
from export_moisture_history import validate_private_root
from rain_sub24 import FEATURE_NAMES, POLICY, hour_number, validate_freeze

BASELINES = ('raw', 'zero', 'volumeScale', 'persistence')


# give each valid hour equal mass within each calendar date
def weights(hours):
    hours = np.asarray(hours, dtype=np.int64)
    # retain explicit empty support
    if not len(hours):
        return np.empty(0)
    unique, inverse, counts = np.unique(hours, return_inverse=True, return_counts=True)
    dates, date_inverse, day_counts = np.unique(unique // 24, return_inverse=True, return_counts=True)
    return 1 / (counts[inverse] * day_counts[date_inverse[inverse]] * len(dates))


# preserve unsupported conditional metrics as null
def conditional_mae(actual, prediction, hours, selected):
    if not selected.any():
        return None
    return float(weights(hours[selected]) @ np.abs(prediction[selected] - actual[selected]))


# report intensity, amount conservation and detection together
def score(actual, prediction, probability, hours):
    w = weights(hours)
    actual, prediction = np.asarray(actual), np.asarray(prediction)
    # reject invalid predictions before any aggregate can conceal them
    if not len(actual) or not np.isfinite(prediction).all() or (prediction < 0).any() or not np.isfinite(probability).all() or (probability < 0).any() or (probability > 1).any():
        raise ValueError('invalid or empty rain predictions')
    wet, predicted_wet = actual >= .1, prediction >= .1
    hit, miss, false = (float(w @ values) for values in (wet & predicted_wet, wet & ~predicted_wet, ~wet & predicted_wet))
    difference = prediction - actual
    observed = float(w @ actual)
    return {'rows': len(actual), 'dates': len(np.unique(hours // 24)), 'uniqueHours': len(np.unique(hours)), 'wetDates': len(np.unique(hours[wet] // 24)), 'heavyHours': len(np.unique(hours[actual >= 1])), 'mae': float(w @ np.abs(difference)), 'rmse': float(np.sqrt(w @ difference ** 2)), 'bias': float(w @ difference), 'volumeRatio': None if observed <= 0 else float(w @ prediction) / observed, 'wetMae': conditional_mae(actual, prediction, hours, wet), 'heavyMae': conditional_mae(actual, prediction, hours, actual >= 1), 'csi': 0 if hit + miss + false == 0 else hit / (hit + miss + false), 'far': 0 if hit + false == 0 else false / (hit + false), 'pod': 0 if hit + miss == 0 else hit / (hit + miss), 'brier': float(w @ (probability - wet) ** 2)}


# use fixed shallow cpu trees and the exact reviewed research runtime
def fit_booster(x, actual, hour, objective):
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected xgboost research version')
    parameters = {**POLICY['treeParameters'], 'objective': objective}
    if objective == 'reg:tweedie':
        parameters['tweedie_variance_power'] = 1.5
    matrix = xgb.DMatrix(x, label=actual, weight=weights(hour) * len(hour), feature_names=list(FEATURE_NAMES), nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=POLICY['boostRounds'])
    validate_booster(booster, objective)
    return booster


# validate loaded model names, objective and tree count before replay

def validate_booster(booster, objective):
    config = json.loads(booster.save_config())
    if booster.feature_names != list(FEATURE_NAMES) or booster.num_features() != len(FEATURE_NAMES) or booster.num_boosted_rounds() != POLICY['boostRounds'] or config['learner']['objective']['name'] != objective:
        raise ValueError('rain booster schema or objective changed')


# bind all array identities and the feature order before reading development outcomes

def validate_dataset(data, pairing):
    required = {'x', 'actual', 'mean', 'raw', 'hour', 'initialized', 'lead', 'support', 'actual_temperature', 'persistence'}
    if set(data) != required or pairing['featureNames'] != list(FEATURE_NAMES):
        raise ValueError('paired feature names or arrays changed')
    size = len(data['actual'])
    if data['x'].shape != (size, len(FEATURE_NAMES)) or any(data[name].shape != (size,) for name in required - {'x'}):
        raise ValueError('paired array shape mismatch')
    if any(not np.isfinite(data[name]).all() for name in ('actual', 'mean', 'raw', 'hour', 'initialized', 'lead', 'support')) or np.isinf(data['x']).any():
        raise ValueError('nonfinite paired targets or identities')
    if (data['actual'] < 0).any() or (data['raw'] < 0).any() or not np.isin(data['lead'], POLICY['horizonsHours']).all() or not np.array_equal(data['hour'], data['initialized'] + 8 + data['lead']):
        raise ValueError('invalid paired lead identity or rain amount')
    if not np.array_equal(data['x'][:, 0], data['lead']) or not np.array_equal(data['x'][:, FEATURE_NAMES.index('rawRain')], data['raw']):
        raise ValueError('feature order does not match forecast identity')
    raw_temperature = data['x'][:, FEATURE_NAMES.index('rawTemperature')]
    # enforce the forecast-time liquid phase gate
    if not np.all(raw_temperature > POLICY['rainForecastTemperatureMinimumC']):
        raise ValueError('paired raw temperature violates the frozen rain phase gate')
    # enforce the minimum complete target-gauge floor
    if not np.all(data['support'] >= POLICY['minimumCompleteGauges']):
        raise ValueError('paired target has insufficient complete gauge support')


# rederive target support from the source-bound hourly observation matrix
def validate_observation_support(data, observations, receipt):
    required = {'rain', 'temperature', 'target', 'mean', 'support', 'weights', 'first_hour'}
    # bind the complete observation archive schema
    if set(observations) != required:
        raise ValueError('hourly observation array schema changed')
    catalog = receipt.get('catalog')
    # bind rain columns to the frozen station order
    if not isinstance(catalog, list) or [row.get('stationId') for row in catalog] != POLICY['stationIds']:
        raise ValueError('hourly observation station order changed')
    rain = observations['rain']
    rows = len(observations['target'])
    # require one consistent hourly observation matrix
    if rain.shape != (rows, len(catalog)) or any(observations[name].shape != (rows,) for name in ('temperature', 'target', 'mean', 'support')) or observations['weights'].shape != (len(catalog),) or observations['first_hour'].shape != ():
        raise ValueError('hourly observation array shape changed')
    first_hour = int(observations['first_hour'])
    indices = data['hour'] - first_hour
    # forbid fractional or out-of-envelope target identities
    if not np.issubdtype(indices.dtype, np.integer) or (indices < 0).any() or (indices >= rows).any():
        raise ValueError('paired target hour is outside the observation archive')
    indices = indices.astype(np.int64, copy=False)
    # bind paired target values to their retained hourly source
    if not np.array_equal(observations['target'][indices], data['actual']) or not np.array_equal(observations['mean'][indices], data['mean']) or not np.array_equal(observations['temperature'][indices], data['actual_temperature'], equal_nan=True):
        raise ValueError('paired target values differ from hourly observations')
    valid = np.isfinite(rain[indices])
    support = valid.sum(axis=1)
    # bind the persisted support counts to independently counted gauges
    if not np.array_equal(observations['support'][indices], support) or not np.array_equal(data['support'], support):
        raise ValueError('paired target gauge support differs from hourly observations')
    distances = np.asarray([row.get('distanceMeters') for row in catalog], dtype=float)
    # reject malformed geometry before selecting the nearest stations
    if not np.isfinite(distances).all():
        raise ValueError('hourly observation station distance is invalid')
    nearest = np.argsort(distances)[:POLICY['minimumCompleteGauges']]
    # rederive both frozen target-support predicates
    if (support < POLICY['minimumCompleteGauges']).any() or not valid[:, nearest].any(axis=1).all():
        raise ValueError('paired target lacks required complete or nearest gauge support')


# freeze a fixed-scale correction using only the preceding calibration period
def volume_scale(actual, predicted, hours):
    w = weights(hours)
    denominator = float(w @ predicted)
    return 1. if denominator <= 1e-12 else float(np.clip(float(w @ actual) / denominator, *POLICY['amountScaleBounds']))


# materialize the same prespecified candidate grid for calibration and evaluation
def predictions(raw, probability, positive, tweedie, persistence):
    values = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.maximum(0, np.nan_to_num(persistence, nan=0))}
    # a missing nowcast baseline falls back to raw rather than claiming dry certainty
    values['persistence'][~np.isfinite(persistence)] = raw[~np.isfinite(persistence)]
    probabilities = {name: (value >= .1).astype(float) for name, value in values.items()}
    for threshold in POLICY['probabilityThresholds']:
        hurdle = np.where(probability >= threshold, probability * positive, 0)
        for blend in POLICY['rawBlendWeights']:
            name = f'hurdle-p{threshold:g}-raw{blend:g}'
            values[name] = (1 - blend) * hurdle + blend * raw
            probabilities[name] = (1 - blend) * probability + blend * (raw >= .1)
    for blend in POLICY['rawBlendWeights']:
        name = f'tweedie-raw{blend:g}'
        values[name] = (1 - blend) * tweedie + blend * raw
        probabilities[name] = (1 - blend) * probability + blend * (raw >= .1)
    return values, probabilities


# bind monthly train/calibration/test windows with a seven-day label embargo
def month_masks(data, month):
    start = hour_number(month + '-01T00:00:00Z')
    date = dt.datetime.fromtimestamp(start * 3600, dt.timezone.utc)
    following = (date.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    stop = int(following.timestamp() // 3600)
    cutoff = start - POLICY['embargoDays'] * 24
    calibration_start = cutoff - POLICY['calibrationDays'] * 24
    fit_stop = calibration_start - POLICY['embargoDays'] * 24
    fit = (data['hour'] >= hour_number(POLICY['trainingStartUtc'])) & (data['hour'] < fit_stop)
    calibration = (data['hour'] >= calibration_start) & (data['hour'] < cutoff)
    decision = data['initialized'] + POLICY['decisionDelayHours']
    evaluation = (decision >= start) & (decision < stop)
    # development outcomes must mature before the locked holdout boundary
    if month in POLICY['developmentMonths']:
        evaluation &= data['hour'] < hour_number('2025-09-01T00:00:00Z') - POLICY['embargoDays'] * 24
    return fit, calibration, evaluation, {'month': month, 'trainingMaximumValidHourExclusive': fit_stop, 'calibrationStartHour': calibration_start, 'calibrationMaximumValidHourExclusive': cutoff, 'decisionStartHour': start, 'decisionStopHourExclusive': stop}


# fit one causally isolated monthly occurrence/amount state

def fit_month(data, month, destination):
    fit, calibration, evaluation, state = month_masks(data, month)
    # require enough actual wet support for both stages and calibration
    if fit.sum() < 1000 or calibration.sum() < 200 or (data['actual'][fit] >= .1).sum() < 100 or not evaluation.any():
        raise ValueError('insufficient monthly model support')
    hour, actual, matrix = data['hour'][fit], data['actual'][fit], data['x'][fit]
    occurrence = fit_booster(matrix, (actual >= .1).astype(float), hour, 'binary:logistic')
    wet = actual >= .1
    positive = fit_booster(matrix[wet], actual[wet], hour[wet], 'reg:gamma')
    tweedie = fit_booster(matrix, actual, hour, 'reg:tweedie')
    directory = destination / month
    directory.mkdir(mode=0o700)
    boosters = {'occurrence': occurrence, 'positive': positive, 'tweedie': tweedie}
    hashes = {}
    # retain exact native models for independent reload/replay
    for name, booster in boosters.items():
        path = directory / f'{name}.json'
        booster.save_model(path)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        reloaded = xgb.Booster(model_file=path)
        validate_booster(reloaded, {'occurrence': 'binary:logistic', 'positive': 'reg:gamma', 'tweedie': 'reg:tweedie'}[name])
    material = {}
    for name, selected in (('calibration', calibration), ('evaluation', evaluation)):
        x = xgb.DMatrix(data['x'][selected], feature_names=list(FEATURE_NAMES), nthread=1)
        probability = np.clip(occurrence.predict(x), 0, 1)
        amount = np.clip(positive.predict(x), .1, POLICY['predictionMaximumMm'])
        mean = np.clip(tweedie.predict(x), 0, POLICY['predictionMaximumMm'])
        raw = data['raw'][selected]
        values, probabilities = predictions(raw, probability, amount, mean, data['persistence'][selected])
        # persistence uses the same target median at the latest causal hour
        material[name] = (values, probabilities)
    calibration_values = material['calibration'][0]
    scales = {name: volume_scale(data['actual'][calibration], value, data['hour'][calibration]) for name, value in calibration_values.items() if name not in ('zero', 'persistence')}
    output, probabilities = material['evaluation']
    output['volumeScale'] = output['raw'] * scales['raw']
    probabilities['volumeScale'] = (output['volumeScale'] >= .1).astype(float)
    # apply only earlier calibration scales and preserve raw/zero/persistence comparators
    for name in list(output):
        if name not in BASELINES:
            output[name] = np.clip(output[name] * scales[name], 0, POLICY['predictionMaximumMm'])
    state.update({'trainingRows': int(fit.sum()), 'trainingDates': len(np.unique(hour // 24)), 'trainingMaximumActualHour': int(hour.max()), 'calibrationRows': int(calibration.sum()), 'evaluationRows': int(evaluation.sum()), 'scales': scales, 'modelHashes': hashes, 'featureNames': FEATURE_NAMES, 'policy': POLICY})
    write_json(directory / 'state.json', state)
    return np.where(evaluation)[0], output, probabilities


# keep date-balanced candidate results in an immutable prediction archive

def run_period(data, months, destination, selected_candidate=None):
    all_indices, values, probabilities = [], collections.defaultdict(list), collections.defaultdict(list)
    for month in months:
        indices, output, chances = fit_month(data, month, destination)
        all_indices.extend(indices.tolist())
        for name in output:
            if selected_candidate is None or name in (*BASELINES, selected_candidate):
                values[name].append(output[name])
                probabilities[name].append(chances[name])
        print(json.dumps({'stage': 'monthly_fit_complete', 'month': month, 'rows': len(indices)}), flush=True)
    return np.asarray(all_indices), {name: np.concatenate(parts) for name, parts in values.items()}, {name: np.concatenate(parts) for name, parts in probabilities.items()}


# select from development only without favoring dry-hour error at the expense of rainfall

def select_candidate(metrics):
    raw = metrics['raw']
    eligible = [name for name, value in metrics.items() if name not in BASELINES and value['volumeRatio'] is not None and .8 <= value['volumeRatio'] <= 1.2 and value['wetMae'] <= raw['wetMae'] * 1.05 and value['csi'] >= raw['csi'] - .02 and value['far'] <= raw['far'] + .1 and value['mae'] < raw['mae'] and all(value['mae'] <= metrics[baseline]['mae'] for baseline in ('volumeScale', 'persistence'))]
    # leave holdout unconsumed when development supplies no viable candidate
    if not eligible:
        return None
    return min(eligible, key=lambda name: (metrics[name]['mae'], name))


# summarize complete same-initialization prefix accumulations without bridging gaps

def accumulations(actual, predictions_by_name, initialized, lead):
    groups = collections.defaultdict(dict)
    for index, (run, horizon) in enumerate(zip(initialized, lead, strict=True)):
        if int(horizon) in groups[int(run)]:
            raise ValueError('duplicate run horizon in accumulation')
        groups[int(run)][int(horizon)] = index
    result = {}
    for length in (6, 12, 23):
        windows = [[group[horizon] for horizon in range(1, length + 1)] for group in groups.values() if all(horizon in group for horizon in range(1, length + 1))]
        # incomplete profiles are unsupported rather than silently summed
        if not windows:
            result[str(length)] = {'runs': 0}
            continue
        index = np.asarray(windows)
        observed = actual[index].sum(axis=1)
        endpoint_hours = initialized[index[:, -1]] + POLICY['decisionDelayHours'] + lead[index[:, -1]]
        endpoint_weights = weights(endpoint_hours)
        # weight complete windows by their target-hour endpoint date and hour
        result[str(length)] = {'runs': len(windows), 'candidates': {name: {'mae': float(endpoint_weights @ np.abs(value[index].sum(axis=1) - observed)), 'volumeRatio': None if endpoint_weights @ observed == 0 else float(endpoint_weights @ value[index].sum(axis=1) / (endpoint_weights @ observed))} for name, value in predictions_by_name.items()}}
    return result


# estimate paired uncertainty with fixed non-circular seven-calendar-day blocks

def bootstrap(actual, predicted, raw, hours):
    unique_dates = np.arange(int((hours // 24).min()), int((hours // 24).max()) + 1)
    losses = np.full(len(unique_dates), np.nan)
    for index, day in enumerate(unique_dates):
        selected = hours // 24 == day
        if selected.any():
            losses[index] = weights(hours[selected]) @ (np.abs(predicted[selected] - actual[selected]) - np.abs(raw[selected] - actual[selected]))
    rng = np.random.default_rng(20260909)
    samples = []
    for _ in range(2000):
        starts = rng.integers(0, max(1, len(losses) - 6), size=int(np.ceil(len(losses) / 7)))
        indices = (starts[:, None] + np.arange(7)[None, :]).reshape(-1)[:len(losses)]
        indices = indices[indices < len(losses)]
        samples.append(float(np.nanmean(losses[indices])))
    return {'replicates': 2000, 'blockCalendarDays': 7, 'lower95': float(np.quantile(samples, .025)), 'upper95': float(np.quantile(samples, .975)), 'pairedMeanMaeDelta': float(np.nanmean(losses))}


# apply fixed qualification gates and keep simulated availability separate from live approval

def qualification(report, selected):
    raw, candidate = report['overall']['raw'], report['overall'][selected]
    gates = {'maeImprovesAtLeastFivePercent': candidate['mae'] <= raw['mae'] * .95, 'beatsSimpleVolumeCalibration': candidate['mae'] <= report['overall']['volumeScale']['mae'], 'beatsPersistence': candidate['mae'] <= report['overall']['persistence']['mae'], 'volumeWithinTwentyPercent': .8 <= candidate['volumeRatio'] <= 1.2, 'wetIntensityNoWorse': candidate['wetMae'] <= raw['wetMae'], 'heavyIntensityNoWorseThanFivePercent': candidate['heavyMae'] is not None and raw['heavyMae'] is not None and candidate['heavyMae'] <= raw['heavyMae'] * 1.05, 'detectionPreserved': candidate['csi'] >= raw['csi'] - .01, 'falseAlarmRatioBounded': candidate['far'] <= raw['far'] + .05, 'brierImproves': candidate['brier'] < raw['brier'], 'wetAndHeavySupport': candidate['wetDates'] >= 100 and candidate['heavyHours'] >= 50, 'pairedMaeConfidenceImproves': report['bootstrap']['upper95'] < 0}
    for band, metrics in report['byLeadBand'].items():
        gates[f'leadBand{band}NoHarm'] = metrics[selected]['mae'] <= metrics['raw']['mae'] * 1.05
    for season, metrics in report['bySeason'].items():
        gates[f'season{season}NoHarm'] = metrics[selected]['mae'] <= metrics['raw']['mae'] * 1.1
    for length, accumulation in report['accumulations'].items():
        gates[f'accumulation{length}NoWorse'] = accumulation['runs'] > 0 and accumulation['candidates'][selected]['mae'] <= accumulation['candidates']['raw']['mae']
    return {'researchQualityPassed': all(gates.values()), 'gates': gates, 'productionEligible': False, 'liveBlocker': 'simulated_archive_availability_and_direct_station_history_require_live_source_and_asof_validation_before_any_runtime_activation'}


# fit development first and unlock only the selected candidate's fixed holdout evaluation

def run(root, evidence):
    root = validate_private_root(root)
    validate_freeze(root)
    pairing = json.loads((root / 'sub24-dataset/pairing-receipt.json').read_text())
    path = root / 'sub24-dataset/paired.npz'
    if pairing['policy'] != POLICY or hashlib.sha256(path.read_bytes()).hexdigest() != pairing['pairedSha256']:
        raise ValueError('paired data or frozen model policy changed')
    with np.load(path) as archive:
        data = {name: archive[name] for name in archive.files}
    validate_dataset(data, pairing)
    observation_receipt_bytes = (root / 'sub24-dataset/observation-receipt.json').read_bytes()
    # bind the paired receipt to its retained hourly source receipt
    if hashlib.sha256(observation_receipt_bytes).hexdigest() != pairing['observationReceiptSha256']:
        raise ValueError('paired observation receipt lineage changed')
    observation_receipt = json.loads(observation_receipt_bytes)
    observation_path = root / 'sub24-dataset/observations.npz'
    # bind the hourly arrays before rederiving target support
    if hashlib.sha256(observation_path.read_bytes()).hexdigest() != observation_receipt['observationsSha256']:
        raise ValueError('hourly observation artifact changed')
    with np.load(observation_path) as archive:
        observations = {name: archive[name] for name in archive.files}
    validate_observation_support(data, observations, observation_receipt)
    destination = root / 'sub24-models'
    destination.mkdir(mode=0o700)
    development_indices, development_predictions, development_probability = run_period(data, POLICY['developmentMonths'], destination)
    development = {name: score(data['actual'][development_indices], value, development_probability[name], data['hour'][development_indices]) for name, value in development_predictions.items()}
    selected = select_candidate(development)
    selection = {'contractVersion': 'rain-sub24-development-selection/v1', 'selectedCandidate': selected, 'metrics': development, 'policy': POLICY, 'pairingSha256': pairing['pairedSha256'], 'holdoutConsumed': False}
    write_json(evidence / 'development-selection.json', selection)
    write_json(destination / 'development-selection.json', selection)
    np.savez_compressed(destination / 'development-predictions.npz', indices=development_indices, **{f'amount::{name}': value for name, value in development_predictions.items()}, **{f'probability::{name}': value for name, value in development_probability.items()})
    if selected is None:
        return {'researchQualityPassed': False, 'reason': 'no_development_candidate_passed_safety_gates', 'holdoutConsumed': False}
    selection_hash = hashlib.sha256((destination / 'development-selection.json').read_bytes()).hexdigest()
    indices, predictions_by_name, probability = run_period(data, POLICY['holdoutMonths'], destination, selected)
    actual, hours = data['actual'][indices], data['hour'][indices]
    overall = {name: score(actual, value, probability[name], hours) for name, value in predictions_by_name.items()}
    report = {'contractVersion': 'rain-sub24-holdout-report/v1', 'selectedCandidate': selected, 'selectionSha256': selection_hash, 'policy': POLICY, 'overall': overall, 'byLeadBand': {}, 'bySeason': {}, 'byLeadHour': {}, 'byMonth': {}, 'byArchiveEra': {}, 'observedPhaseSensitivity': {}}
    months = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).month for hour in hours])
    seasons = np.array([('DJF' if month in (12, 1, 2) else 'MAM' if month in (3, 4, 5) else 'JJA' if month in (6, 7, 8) else 'SON') for month in months])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    for field, group in (('byLeadBand', bands), ('bySeason', seasons), ('byLeadHour', data['lead'][indices]), ('byMonth', np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).strftime('%Y-%m') for hour in hours]))):
        for key in np.unique(group):
            chosen = group == key
            report[field][str(key)] = {name: score(actual[chosen], value[chosen], probability[name][chosen], hours[chosen]) for name, value in predictions_by_name.items()}
    # report archive-era transfer and observed phase only as diagnostics
    era = np.where(data['initialized'][indices] < hour_number(POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    phase = np.where(data['actual_temperature'][indices] > 2, 'observed_above_2C', 'observed_cold_or_unknown')
    for field, group in (('byArchiveEra', era), ('observedPhaseSensitivity', phase)):
        for key in np.unique(group):
            chosen = group == key
            report[field][str(key)] = {name: score(actual[chosen], value[chosen], probability[name][chosen], hours[chosen]) for name, value in predictions_by_name.items()}
    report['accumulations'] = accumulations(actual, predictions_by_name, data['initialized'][indices], data['lead'][indices])
    report['bootstrap'] = bootstrap(actual, predictions_by_name[selected], predictions_by_name['raw'], hours)
    report['qualification'] = qualification(report, selected)
    validate_freeze(root)
    np.savez_compressed(destination / 'holdout-predictions.npz', indices=indices, **{f'amount::{name}': value for name, value in predictions_by_name.items()}, **{f'probability::{name}': value for name, value in probability.items()})
    write_json(destination / 'holdout-report.json', report)
    write_json(evidence / 'holdout-report.json', report)
    return report['qualification']


# never fit while merely importing synthetic test helpers
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.root, args.evidence)), flush=True)
