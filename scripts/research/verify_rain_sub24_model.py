"""independently replay native rain models and verify reported holdout losses."""

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path

# avoid runtime-dependent native thread pooling
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb


# report a precise bounded verifier failure
def require(value, message):
    if not value:
        raise ValueError(message)


# reconstruct equal-date equal-hour forecast weighting independently
def weights(hours):
    per_hour = collections.Counter(map(int, hours))
    per_date = collections.Counter(hour // 24 for hour in per_hour)
    return np.array([1 / (len(per_date) * per_date[int(hour) // 24] * per_hour[int(hour)]) for hour in hours])


# compute all scalar rain metrics directly from retained predictions
def metrics(actual, predicted, probability, hours):
    w = weights(hours)
    error = predicted - actual
    wet, called = actual >= .1, predicted >= .1
    hit = float(w[wet & called].sum())
    miss = float(w[wet & ~called].sum())
    false = float(w[~wet & called].sum())
    output = {'rows': len(actual), 'dates': len(set(map(int, hours // 24))), 'uniqueHours': len(set(map(int, hours))), 'wetDates': len(set(map(int, hours[wet] // 24))), 'heavyHours': len(set(map(int, hours[actual >= 1]))), 'mae': float(np.sum(w * np.abs(error))), 'rmse': float(np.sqrt(np.sum(w * error ** 2))), 'bias': float(np.sum(w * error)), 'volumeRatio': None if np.sum(w * actual) <= 0 else float(np.sum(w * predicted) / np.sum(w * actual)), 'csi': 0 if hit + miss + false == 0 else hit / (hit + miss + false), 'far': 0 if hit + false == 0 else false / (hit + false), 'pod': 0 if hit + miss == 0 else hit / (hit + miss), 'brier': float(np.sum(w * (probability - wet) ** 2))}
    for name, mask in (('wetMae', wet), ('heavyMae', actual >= 1)):
        output[name] = None if not mask.any() else float(np.sum(weights(hours[mask]) * np.abs(error[mask])))
    return output


# compare numeric reports without forgiving missing keys or altered support counts
def same(expected, reported):
    require(set(expected) == set(reported), 'reported metric keys changed')
    for key, value in expected.items():
        if value is None:
            require(reported[key] is None, f'unsupported metric changed: {key}')
        else:
            require(reported[key] is not None and np.isclose(value, reported[key], rtol=1e-9, atol=1e-10), f'metric mismatch: {key}')


# preserve rowwise reduction and apply equal date-hour endpoint mass
def accumulation_metrics(actual_windows, predicted_windows, endpoint_hours):
    observed = actual_windows.sum(axis=1)
    predicted = predicted_windows.sum(axis=1)
    weight = weights(endpoint_hours)
    return {'mae': float(weight @ np.abs(predicted - observed)), 'volumeRatio': None if weight @ observed == 0 else float(weight @ predicted / (weight @ observed))}


# independently rederive paired target support from hourly observations
def validate_dataset_support(data, observations, receipt, policy, feature_names):
    required = {'rain', 'temperature', 'target', 'mean', 'support', 'weights', 'first_hour'}
    require(set(observations) == required, 'hourly observation array schema changed')
    catalog = receipt.get('catalog')
    require(isinstance(catalog, list) and [row.get('stationId') for row in catalog] == policy['stationIds'], 'hourly observation station order changed')
    rain = observations['rain']
    rows = len(observations['target'])
    require(rain.shape == (rows, len(catalog)), 'hourly rain matrix shape changed')
    # bind all parallel observation arrays
    for name in ('temperature', 'target', 'mean', 'support'):
        require(observations[name].shape == (rows,), f'hourly {name} shape changed')
    require(observations['weights'].shape == (len(catalog),) and observations['first_hour'].shape == (), 'hourly observation metadata shape changed')
    raw_temperature = data['x'][:, feature_names.index('rawTemperature')]
    require(np.all(raw_temperature > policy['rainForecastTemperatureMinimumC']), 'paired raw temperature violates the rain phase gate')
    require(np.all(data['support'] >= policy['minimumCompleteGauges']), 'paired complete gauge support is insufficient')
    indices = data['hour'] - int(observations['first_hour'])
    require(np.issubdtype(indices.dtype, np.integer) and np.all(indices >= 0) and np.all(indices < rows), 'paired target hour is outside hourly observations')
    indices = indices.astype(np.int64, copy=False)
    require(np.array_equal(observations['target'][indices], data['actual']), 'paired median target differs from hourly observations')
    require(np.array_equal(observations['mean'][indices], data['mean']), 'paired mean target differs from hourly observations')
    require(np.array_equal(observations['temperature'][indices], data['actual_temperature'], equal_nan=True), 'paired target temperature differs from hourly observations')
    valid = np.isfinite(rain[indices])
    support = valid.sum(axis=1)
    require(np.array_equal(observations['support'][indices], support) and np.array_equal(data['support'], support), 'paired gauge counts differ from hourly observations')
    distances = np.asarray([row.get('distanceMeters') for row in catalog], dtype=float)
    require(np.isfinite(distances).all(), 'hourly station distance is invalid')
    nearest = np.argsort(distances)[:policy['minimumCompleteGauges']]
    require(np.all(support >= policy['minimumCompleteGauges']) and valid[:, nearest].any(axis=1).all(), 'paired target lacks complete or nearest gauge support')


# independently apply a named frozen point head and its separate probability output
def candidate(name, raw, probability, positive, tweedie):
    match = re.fullmatch(r'hurdle-p([\d.]+)-raw([\d.]+)', name)
    if match:
        threshold, blend = map(float, match.groups())
        point = np.where(probability >= threshold, probability * positive, 0)
    else:
        match = re.fullmatch(r'tweedie-raw([\d.]+)', name)
        require(match is not None, 'unknown rain point-head candidate')
        blend = float(match.group(1))
        point = tweedie
    return (1 - blend) * point + blend * raw, (1 - blend) * probability + blend * (raw >= .1)


# require one exact reloadable model state without calling the fitting implementation
def load_models(directory, state, feature_names, rounds):
    result = {}
    for name, objective in (('occurrence', 'binary:logistic'), ('positive', 'reg:gamma'), ('tweedie', 'reg:tweedie')):
        path = directory / f'{name}.json'
        require(hashlib.sha256(path.read_bytes()).hexdigest() == state['modelHashes'][name], 'native rain model checksum changed')
        model = xgb.Booster(model_file=path)
        require(model.feature_names == feature_names and model.num_boosted_rounds() == rounds and json.loads(model.save_config())['learner']['objective']['name'] == objective, 'native rain model schema changed')
        result[name] = model
    return result


# predict all native heads while preserving the producer's reviewed output bounds
def predict_heads(models, x, feature_names):
    matrix = xgb.DMatrix(x, feature_names=feature_names, nthread=1)
    return np.clip(models['occurrence'].predict(matrix), 0, 1), np.clip(models['positive'].predict(matrix), .1, 30), np.clip(models['tweedie'].predict(matrix), 0, 30)


# verify every monthly forecast against earlier-only calibration and stored native models
def replay(data, archive, months, directory, policy, feature_names, selected_names):
    all_indices = []
    expected_amounts = collections.defaultdict(list)
    expected_probabilities = collections.defaultdict(list)
    for month in months:
        start = dt.datetime.fromisoformat(month + '-01T00:00:00+00:00')
        following = (start.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        start_hour, stop_hour = int(start.timestamp() // 3600), int(following.timestamp() // 3600)
        fit_stop = start_hour - 59 * 24
        calibration_start, calibration_stop = start_hour - 52 * 24, start_hour - 7 * 24
        fit = data['hour'] < fit_stop
        calibration = (data['hour'] >= calibration_start) & (data['hour'] < calibration_stop)
        decision = data['initialized'] + 8
        evaluation = (decision >= start_hour) & (decision < stop_hour)
        if month in policy['developmentMonths']:
            evaluation &= data['hour'] < int(dt.datetime(2025, 8, 25, tzinfo=dt.timezone.utc).timestamp() // 3600)
        state = json.loads((directory / month / 'state.json').read_text())
        require(state['policy'] == policy and state['featureNames'] == feature_names, 'monthly policy changed')
        require(state['trainingMaximumValidHourExclusive'] == fit_stop and state['calibrationMaximumValidHourExclusive'] == calibration_stop and state['calibrationStartHour'] == calibration_start, 'monthly chronology changed')
        require(state['trainingRows'] == int(fit.sum()) and state['trainingMaximumActualHour'] == int(data['hour'][fit].max()) and state['calibrationRows'] == int(calibration.sum()) and state['evaluationRows'] == int(evaluation.sum()), 'monthly training or evaluation support changed')
        models = load_models(directory / month, state, feature_names, policy['boostRounds'])
        cal_heads = predict_heads(models, data['x'][calibration], feature_names)
        eval_heads = predict_heads(models, data['x'][evaluation], feature_names)
        cal_raw, raw = data['raw'][calibration], data['raw'][evaluation]
        cal_weights = weights(data['hour'][calibration])
        for name in selected_names:
            if name == 'zero':
                point, probability = np.zeros_like(raw), np.zeros_like(raw)
            elif name == 'raw':
                point, probability = raw, (raw >= .1).astype(float)
            elif name == 'persistence':
                recent = data['persistence'][evaluation]
                point = np.maximum(0, np.nan_to_num(recent, nan=0))
                point[~np.isfinite(recent)] = raw[~np.isfinite(recent)]
                probability = (point >= .1).astype(float)
            else:
                if name == 'volumeScale':
                    cal_point, point = cal_raw, raw
                    probability = None
                    scale_key = 'raw'
                else:
                    cal_point, _ = candidate(name, cal_raw, *cal_heads)
                    point, probability = candidate(name, raw, *eval_heads)
                    scale_key = name
                denominator = float(cal_weights @ cal_point)
                scale = 1. if denominator <= 1e-12 else float(np.clip(float(cal_weights @ data['actual'][calibration]) / denominator, .5, 2))
                require(abs(scale - state['scales'][scale_key]) < 1e-9, 'earlier-only calibration scale changed')
                point = point * scale if name == 'volumeScale' else np.clip(point * scale, 0, 30)
                if probability is None:
                    probability = (point >= .1).astype(float)
            expected_amounts[name].append(point)
            expected_probabilities[name].append(probability)
        all_indices.extend(np.where(evaluation)[0].tolist())
    require(np.array_equal(archive['indices'], all_indices), 'retained prediction population changed')
    for name in selected_names:
        expected_point = np.concatenate(expected_amounts[name])
        expected_probability = np.concatenate(expected_probabilities[name])
        require(np.allclose(archive[f'amount::{name}'], expected_point, rtol=1e-8, atol=1e-9), 'native point prediction replay mismatch')
        require(np.allclose(archive[f'probability::{name}'], expected_probability, rtol=1e-8, atol=1e-9), 'native probability prediction replay mismatch')
    return np.asarray(all_indices)


# verify retained metrics, selection and interval confidence independently of the runner

def verify(root, evidence):
    freeze = json.loads((root / 'model-evaluation-freeze.json').read_text())
    policy, names = freeze['policy'], freeze['featureNames']
    require(xgb.__version__ == policy['xgboostVersion'], 'independent replay runtime changed')
    path = root / 'sub24-dataset/paired.npz'
    pairing = json.loads((root / 'sub24-dataset/pairing-receipt.json').read_text())
    require(hashlib.sha256(path.read_bytes()).hexdigest() == pairing['pairedSha256'] and pairing['policy'] == policy and pairing['featureNames'] == names, 'independent paired corpus binding failed')
    with np.load(path) as material:
        data = {name: material[name] for name in material.files}
    # independently bind persistence to the same earlier network target rather than a different statistic
    observation_receipt_bytes = (root / 'sub24-dataset/observation-receipt.json').read_bytes()
    require(hashlib.sha256(observation_receipt_bytes).hexdigest() == pairing['observationReceiptSha256'], 'observation receipt lineage changed')
    observation_receipt = json.loads(observation_receipt_bytes)
    observation_path = root / 'sub24-dataset/observations.npz'
    require(hashlib.sha256(observation_path.read_bytes()).hexdigest() == observation_receipt['observationsSha256'], 'hourly observation artifact changed')
    with np.load(observation_path) as observations:
        validate_dataset_support(data, observations, observation_receipt, policy, names)
        lag = data['initialized'] + 7 - int(observations['first_hour'])
        expected = np.full(len(lag), np.nan)
        available = (lag >= 0) & (lag < len(observations['target']))
        expected[available] = observations['target'][lag[available]]
        require(np.array_equal(expected, data['persistence'], equal_nan=True), 'persistence baseline is not the exact causal target statistic')
    directory = root / 'sub24-models'
    selection_bytes = (directory / 'development-selection.json').read_bytes()
    selection = json.loads(selection_bytes)
    selected = selection['selectedCandidate']
    require(selected is not None, 'no development-qualified model exists')
    report = json.loads((directory / 'holdout-report.json').read_text())
    require(report['selectionSha256'] == hashlib.sha256(selection_bytes).hexdigest() and report['selectedCandidate'] == selected and report['policy'] == policy, 'holdout selection provenance changed')
    with np.load(directory / 'development-predictions.npz') as material:
        development = {name: material[name] for name in material.files}
    development_names = sorted(key.split('::', 1)[1] for key in development if key.startswith('amount::'))
    indices = replay(data, development, policy['developmentMonths'], directory, policy, names, development_names)
    independent_development = {}
    for name in development_names:
        calculated = metrics(data['actual'][indices], development[f'amount::{name}'], development[f'probability::{name}'], data['hour'][indices])
        same(calculated, selection['metrics'][name])
        independent_development[name] = calculated
    raw = independent_development['raw']
    eligible = [name for name, value in independent_development.items() if name not in ('raw', 'zero', 'volumeScale', 'persistence') and value['volumeRatio'] is not None and .8 <= value['volumeRatio'] <= 1.2 and value['wetMae'] <= raw['wetMae'] * 1.05 and value['csi'] >= raw['csi'] - .02 and value['far'] <= raw['far'] + .1 and value['mae'] < raw['mae'] and all(value['mae'] <= independent_development[baseline]['mae'] for baseline in ('volumeScale', 'persistence'))]
    require(eligible and selected == min(eligible, key=lambda name: (independent_development[name]['mae'], name)), 'development-only candidate selection changed')
    with np.load(directory / 'holdout-predictions.npz') as material:
        holdout = {name: material[name] for name in material.files}
    comparison_names = ['raw', 'zero', 'volumeScale', 'persistence', selected]
    indices = replay(data, holdout, policy['holdoutMonths'], directory, policy, names, comparison_names)
    actual, hours = data['actual'][indices], data['hour'][indices]
    for name in comparison_names:
        same(metrics(actual, holdout[f'amount::{name}'], holdout[f'probability::{name}'], hours), report['overall'][name])
    groups = {'byLeadBand': np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23')), 'byLeadHour': data['lead'][indices], 'byMonth': np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).strftime('%Y-%m') for hour in hours])}
    month_numbers = np.array([dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).month for hour in hours])
    groups['bySeason'] = np.array([('DJF' if month in (12, 1, 2) else 'MAM' if month in (3, 4, 5) else 'JJA' if month in (6, 7, 8) else 'SON') for month in month_numbers])
    for field, group in groups.items():
        require(set(report[field]) == set(map(str, np.unique(group))), 'reported slice population changed')
        for key in np.unique(group):
            mask = group == key
            for name in comparison_names:
                same(metrics(actual[mask], holdout[f'amount::{name}'][mask], holdout[f'probability::{name}'][mask], hours[mask]), report[field][str(key)][name])
    calendar = np.arange((hours // 24).min(), (hours // 24).max() + 1)
    daily_losses = []
    for day in calendar:
        mask = hours // 24 == day
        daily_losses.append(np.nan if not mask.any() else float(weights(hours[mask]) @ (np.abs(holdout[f'amount::{selected}'][mask] - actual[mask]) - np.abs(holdout['amount::raw'][mask] - actual[mask]))))
    daily_losses = np.asarray(daily_losses)
    rng = np.random.default_rng(20260909)
    starts = rng.integers(0, len(calendar) - 6, size=(2000, int(np.ceil(len(calendar) / 7))))
    block_indices = (starts[:, :, None] + np.arange(7)).reshape(2000, -1)[:, :len(calendar)]
    sampled = np.nanmean(daily_losses[block_indices], axis=1)
    same({'replicates': 2000, 'blockCalendarDays': 7, 'lower95': float(np.quantile(sampled, .025)), 'upper95': float(np.quantile(sampled, .975)), 'pairedMeanMaeDelta': float(np.nanmean(daily_losses))}, report['bootstrap'])
    # rebuild every complete same-initialization accumulation independently
    run_groups = collections.defaultdict(dict)
    for index, (initialized, lead) in enumerate(zip(data['initialized'][indices], data['lead'][indices], strict=True)):
        require(int(lead) not in run_groups[int(initialized)], 'duplicate retained run horizon')
        run_groups[int(initialized)][int(lead)] = index
    for length in (6, 12, 23):
        windows = [[group[lead] for lead in range(1, length + 1)] for group in run_groups.values() if set(range(1, length + 1)) <= set(group)]
        reported = report['accumulations'][str(length)]
        require(len(windows) == reported['runs'], 'accumulation support mismatch')
        if not windows:
            continue
        window_indices = np.asarray(windows)
        endpoint_hours = hours[window_indices[:, -1]]
        for name in comparison_names:
            same(accumulation_metrics(actual[window_indices], holdout[f'amount::{name}'][window_indices], endpoint_hours), reported['candidates'][name])
    # rederive all promotion gates rather than trusting a producer's passed flag
    raw, winner = report['overall']['raw'], report['overall'][selected]
    gates = {'maeImprovesAtLeastFivePercent': winner['mae'] <= raw['mae'] * .95, 'beatsSimpleVolumeCalibration': winner['mae'] <= report['overall']['volumeScale']['mae'], 'beatsPersistence': winner['mae'] <= report['overall']['persistence']['mae'], 'volumeWithinTwentyPercent': .8 <= winner['volumeRatio'] <= 1.2, 'wetIntensityNoWorse': winner['wetMae'] <= raw['wetMae'], 'heavyIntensityNoWorseThanFivePercent': winner['heavyMae'] is not None and raw['heavyMae'] is not None and winner['heavyMae'] <= raw['heavyMae'] * 1.05, 'detectionPreserved': winner['csi'] >= raw['csi'] - .01, 'falseAlarmRatioBounded': winner['far'] <= raw['far'] + .05, 'brierImproves': winner['brier'] < raw['brier'], 'wetAndHeavySupport': winner['wetDates'] >= 100 and winner['heavyHours'] >= 50, 'pairedMaeConfidenceImproves': report['bootstrap']['upper95'] < 0}
    for band, values in report['byLeadBand'].items():
        gates[f'leadBand{band}NoHarm'] = values[selected]['mae'] <= values['raw']['mae'] * 1.05
    for season, values in report['bySeason'].items():
        gates[f'season{season}NoHarm'] = values[selected]['mae'] <= values['raw']['mae'] * 1.1
    for length, values in report['accumulations'].items():
        gates[f'accumulation{length}NoWorse'] = values['runs'] > 0 and values['candidates'][selected]['mae'] <= values['candidates']['raw']['mae']
    require(gates == report['qualification']['gates'] and all(gates.values()) == report['qualification']['researchQualityPassed'] and report['qualification']['productionEligible'] is False, 'independent qualification decision mismatch')
    result = {'contractVersion': 'rain-sub24-model-independent-verification/v1', 'verified': True, 'selectedCandidate': selected, 'developmentPredictionRows': len(development['indices']), 'holdoutPredictionRows': len(indices), 'nativeModelStatesReplayed': 18, 'nativeBoostersReplayed': 54, 'scalarAndLeadSeasonMonthMetricsVerified': True, 'pairedDateBootstrapVerified': True, 'completeRunAccumulationsVerified': True, 'qualificationGatesVerified': True, 'researchQualityPassed': report['qualification']['researchQualityPassed'], 'productionEligible': False, 'productionWrites': False, 'reportSha256': hashlib.sha256((directory / 'holdout-report.json').read_bytes()).hexdigest()}
    (evidence / 'model-independent-verification.json').write_text(json.dumps(result, allow_nan=False, sort_keys=True) + '\n')
    return result


# read only retained models and predictions with no production side effects
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
