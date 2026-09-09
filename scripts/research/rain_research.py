"""Frozen research-only rainfall occurrence and positive-amount calibration."""

import collections
import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import humidity_research as shared
import numpy as np

CANDIDATES = ('raw', 'zero', 'volumeScale', 'hurdle')
COVARIATE_BOUNDS = {'rawTemperatureC': (-100, 70), 'rawWindSpeedMps': (0, 150), 'rawCloudCoverPercent': (0, 100)}
POLICY = {
    'contractVersion': 'rain-causal-research/v1', 'productionEligible': False,
    'minimumTrainingDates': 180, 'minimumTrainingRows': 1000, 'embargoHours': 168,
    'minimumWetTrainingDates': 20, 'minimumWetTrainingRows': 100,
    'wetThresholdMm': 0.1, 'heavyThresholdsMm': [1.0, 2.5],
    'volumeScaleBounds': [0.5, 1.5], 'volumeRatioPower': 0.5,
    'hurdleBlendWeight': 0.5, 'positiveAmountMaximumMm': 30,
    'ridgePenalty': 0.1, 'iterations': 12,
    'completeEvaluationStartLocalDate': '2025-01-01',
    'completeEvaluationEndLocalDate': '2026-08-31',
    'partialEvaluationEndLocalDate': '2026-09-06',
    'target': 'liquid-only Tempest network complete backward reporting-hour sum',
    'candidateSelection': 'none_all_frozen_candidates_reported',
}


# reject malformed rain while preserving legitimate dry hours
def amount(value):
    result = shared.number(value)
    # use a broad physical accumulation range
    if not 0 <= result <= 500:
        raise ValueError('invalid rain amount')
    return result


# validate all forecast-time rain inputs without reading observed targets
def forecast(row):
    identity = shared.forecast_identity(row)
    raw = amount(row['rawPrecipitationMm'])
    # validate optional covariates against canonical weather domains
    for field, (minimum, maximum) in COVARIATE_BOUNDS.items():
        value = row.get(field)
        # preserve genuine provider missingness
        if value is None:
            continue
        number = shared.number(value)
        # reject nonphysical supplied covariates
        if not minimum <= number <= maximum:
            raise ValueError(f'{field} is outside its physical bounds')
    return identity, raw


# validate the shared chronological identity and complete rain target contract
def validate(row):
    identity, _raw = forecast(row)
    amount(row['actualPrecipitationMm'])
    # admit only the frozen liquid-only target population
    if row.get('liquidOnly') is not True:
        raise ValueError('rain target must be liquid-only')
    # validate optional sensitivity targets without changing the primary target
    for field in ('shiftMinus5MinutesMm', 'gaugeMeanPrecipitationMm'):
        # preserve absent alternative targets
        if row.get(field) is not None:
            amount(row[field])
    return identity


# build forecast-only occurrence and amount predictors
def features(row):
    identity, raw = forecast(row)
    local = identity['validAt'].astimezone(shared.ZONE)
    annual = 2 * math.pi * ((local.date() - dt.date(local.year, 1, 1)).days + local.hour / 24) / (dt.date(local.year + 1, 1, 1) - dt.date(local.year, 1, 1)).days
    daily = 2 * math.pi * local.hour / 24
    rain = math.log1p(raw)
    humidity = (identity['rawHumidity'] - 75) / 25
    temp = row.get('rawTemperatureC')
    cloud = row.get('rawCloudCoverPercent')
    wind = row.get('rawWindSpeedMps')
    result = np.array([1, rain, rain * rain, float(rain > 0), humidity, humidity * rain, 0 if temp is None else (temp - 10) / 10, 0 if cloud is None else cloud / 100, 0 if wind is None else wind / 5, math.sin(annual), math.cos(annual), math.sin(daily), math.cos(daily), float(temp is None), float(cloud is None), float(wind is None)], dtype=float)
    # forbid nonfinite learner inputs
    if not np.isfinite(result).all():
        raise ValueError('nonfinite rain feature vector')
    return result


# solve a fixed-penalty weighted linear system
def ridge(matrix, target, weights):
    # reject nonfinite linear-system material
    if not np.isfinite(matrix).all() or not np.isfinite(target).all() or not np.isfinite(weights).all():
        raise ValueError('nonfinite rain fit material')
    penalty = np.eye(matrix.shape[1]) * POLICY['ridgePenalty']
    penalty[0, 0] = 1e-8
    result = np.linalg.solve(matrix.T @ (weights[:, None] * matrix) + penalty, matrix.T @ (weights * target))
    # reject unstable fitted coefficients
    if not np.isfinite(result).all():
        raise ValueError('nonfinite rain fit coefficients')
    return result


# fit only one source and literal lead band before the monthly embargo
def fit(rows, month, cohort, band):
    cutoff = shared.month_start(month) - dt.timedelta(hours=POLICY['embargoHours'])
    training = [row for row in rows if row['cohort'] == cohort and shared.lead_band(row) == band and shared.instant(row['validAt']) < cutoff]
    # validate only causally selected labels and their forecast covariates
    for row in training:
        validate(row)
    dates = {shared.calendar(row)['localDate'] for row in training}
    model = {'supported': False, 'hurdleSupported': False, 'trainingRows': len(training), 'trainingDates': len(dates), 'trainingCutoffUtc': shared.format_instant(cutoff), 'cohort': cohort, 'leadBand': band, 'month': month}
    # retain raw behavior for every unsupported scoring row
    if len(dates) < POLICY['minimumTrainingDates'] or len(training) < POLICY['minimumTrainingRows']:
        return model
    weights = shared.balanced_weights(training)
    weights = weights / weights.sum()
    actual = np.array([row['actualPrecipitationMm'] for row in training])
    raw = np.array([row['rawPrecipitationMm'] for row in training])
    raw_total = float(weights @ raw)
    scale = 1 if raw_total <= 1e-9 else float(np.clip((float(weights @ actual) / raw_total) ** POLICY['volumeRatioPower'], *POLICY['volumeScaleBounds']))
    model.update(supported=True, scale=scale)
    wet = actual >= POLICY['wetThresholdMm']
    wet_dates = {shared.calendar(row)['localDate'] for row, selected in zip(training, wet) if selected}
    model.update(wetTrainingRows=int(wet.sum()), wetTrainingDates=len(wet_dates))
    # do not fit a positive-amount model from sparse wet events
    if wet.sum() < POLICY['minimumWetTrainingRows'] or len(wet_dates) < POLICY['minimumWetTrainingDates']:
        return model
    matrix = np.stack([features(row) for row in training])
    beta = np.zeros(matrix.shape[1])
    probability = float(np.clip(weights @ wet, 1e-4, 1 - 1e-4))
    beta[0] = math.log(probability / (1 - probability))
    # fit the fixed-count regularized logistic occurrence model
    for _ in range(POLICY['iterations']):
        linear = np.clip(matrix @ beta, -20, 20)
        probability = 1 / (1 + np.exp(-linear))
        variance = np.maximum(probability * (1 - probability), 1e-5)
        working = linear + (wet - probability) / variance
        beta = ridge(matrix, working, weights * variance)
    wet_weights = weights[wet] / weights[wet].sum()
    log_amount = np.log(actual[wet])
    positive = ridge(matrix[wet], log_amount, wet_weights)
    residual = np.clip(log_amount - matrix[wet] @ positive, -5, 5)
    smearing = float(wet_weights @ np.exp(residual))
    # fail closed before persisting any nonfinite model state
    if not np.isfinite(np.concatenate((beta, positive, [smearing]))).all():
        raise ValueError('nonfinite rain fit state')
    model.update(hurdleSupported=True, occurrence=beta.tolist(), positive=positive.tolist(), smearing=smearing)
    return model


# preserve conservative output and expose the occurrence probability separately
def predict(row, model):
    raw = amount(row['rawPrecipitationMm'])
    result = {'raw': raw, 'zero': 0.0, 'volumeScale': raw, 'hurdle': raw, 'wetProbability': float(raw >= POLICY['wetThresholdMm'])}
    # apply only an adequately supported training-volume baseline
    if model['supported']:
        result['volumeScale'] = raw * model['scale']
    # reuse one frozen occurrence and positive-amount fit
    if model['hurdleSupported']:
        vector = features(row)
        probability = 1 / (1 + math.exp(-float(np.clip(vector @ model['occurrence'], -20, 20))))
        positive = min(POLICY['positiveAmountMaximumMm'], math.exp(float(np.clip(vector @ model['positive'], -10, 5))) * model['smearing'])
        result['hurdle'] = (1 - POLICY['hurdleBlendWeight']) * raw + POLICY['hurdleBlendWeight'] * probability * positive
        result['wetProbability'] = probability
    return result


# reuse only the literal-band earlier ECMWF state for explicit Best Match transfer
def predict_transfer(row, model):
    # reject silently changed model sources, lead bands or issue months
    if row['cohort'] != 'best_match_single_run_transfer' or model['cohort'] != 'ecmwf_single_run_hindcast' or model['leadBand'] != shared.lead_band(row) or model['month'] != shared.issue_month(row):
        raise ValueError('invalid rainfall transfer source state')
    return predict(row, model)


# average repeated forecasts by hour and then equally by local date
def balanced_mean(rows, values):
    by_hour = collections.defaultdict(list)
    # group only already selected comparable events
    for row, value in zip(rows, values):
        by_hour[row['validAt']].append(float(value))
    by_date = collections.defaultdict(list)
    # retain each available valid hour once per date
    for at, items in by_hour.items():
        by_date[shared.instant(at).astimezone(shared.ZONE).date().isoformat()].append(sum(items) / len(items))
    return None if not by_date else float(np.mean([np.mean(items) for items in by_date.values()]))


# score paired rain amounts without letting dry hours decide the winner alone
def score(rows, actual_field='actualPrecipitationMm'):
    # retain an explicit empty population
    if not rows:
        return {'rows': 0, 'dates': 0, 'candidates': {}}
    actual = np.array([row[actual_field] for row in rows])
    weights = shared.balanced_weights(rows)
    weights /= weights.sum()
    wet = actual >= POLICY['wetThresholdMm']
    report = {'rows': len(rows), 'hours': len({row['validAt'] for row in rows}), 'dates': len({shared.calendar(row)['localDate'] for row in rows}), 'wetRows': int(wet.sum()), 'wetDates': len({shared.calendar(row)['localDate'] for row, value in zip(rows, wet) if value}), 'candidates': {}, 'volumeSupportedRows': sum(bool(row.get('modelSupported')) for row in rows), 'hurdleSupportedRows': sum(bool(row.get('hurdleSupported')) for row in rows), 'hurdleSupportedDates': len({shared.calendar(row)['localDate'] for row in rows if row.get('hurdleSupported')})}
    # report every frozen candidate on exactly the same events
    for candidate in CANDIDATES:
        prediction = np.array([row['predictions'][candidate] for row in rows])
        errors = prediction - actual
        observed = float(weights @ actual)
        predicted = float(weights @ prediction)
        metrics = {'maeMm': float(weights @ np.abs(errors)), 'rmseMm': math.sqrt(float(weights @ errors ** 2)), 'biasMm': float(weights @ errors), 'volumeRatio': None if observed == 0 else predicted / observed, 'observedWetMaeMm': balanced_mean([row for row, selected in zip(rows, wet) if selected], np.abs(errors[wet])), 'thresholds': {}}
        # retain wet and heavy-rain detection on unchanged amount thresholds
        for threshold in [POLICY['wetThresholdMm'], *POLICY['heavyThresholdsMm']]:
            event = actual >= threshold
            forecast = prediction >= threshold
            hit = float(weights @ (event & forecast))
            miss = float(weights @ (event & ~forecast))
            false_alarm = float(weights @ (~event & forecast))
            random_hit = (hit + miss) * (hit + false_alarm)
            denom = hit + miss + false_alarm - random_hit
            metrics['thresholds'][str(threshold)] = {'POD': None if hit + miss == 0 else hit / (hit + miss), 'FAR': None if hit + false_alarm == 0 else false_alarm / (hit + false_alarm), 'ETS': None if denom == 0 else (hit - random_hit) / denom, 'frequencyBias': None if hit + miss == 0 else (hit + false_alarm) / (hit + miss), 'eventRows': int(event.sum())}
        probability = np.array([row['predictions']['wetProbability'] for row in rows]) if candidate == 'hurdle' else (prediction >= POLICY['wetThresholdMm']).astype(float)
        metrics['wetBrier'] = float(weights @ (probability - wet) ** 2)
        metrics['brierReference'] = 'fitted_occurrence_probability_with_raw_indicator_cold_fallback' if candidate == 'hurdle' else 'deterministic_amount_event_indicator_not_provider_pop'
        supported = np.array([bool(row.get('hurdleSupported')) for row in rows])
        metrics['hurdleSupportedPairedWetBrier'] = balanced_mean([row for row, selected in zip(rows, supported) if selected], ((probability - wet) ** 2)[supported])
        report['candidates'][candidate] = metrics
    return report


# score genuine same-initialization contiguous accumulation windows
def accumulation(rows):
    groups = collections.defaultdict(dict)
    # fixed-lead anchors do not claim a model-initialization trajectory
    for row in rows:
        # check the next guarded case
        if row.get('referenceAt') is not None:
            groups[(row['cohort'], row['referenceAt'])][shared.instant(row['validAt'])] = row
    accumulations = {hours: [] for hours in (3, 6, 12, 24)}
    # require all component hours rather than bridging missing rain targets
    for group in groups.values():
        # process each selected item
        for end, row in group.items():
            # process each selected item
            for hours, events in accumulations.items():
                pieces = [group.get(end - dt.timedelta(hours=offset)) for offset in range(hours)]
                # preserve missing accumulation support
                if any(piece is None for piece in pieces):
                    continue
                total = dict(row)
                total['actualPrecipitationMm'] = sum(piece['actualPrecipitationMm'] for piece in pieces)
                total['predictions'] = {candidate: sum(piece['predictions'][candidate] for piece in pieces) for candidate in CANDIDATES}
                events.append(total)
    result = {}
    # report accumulation-specific amount metrics without hourly occurrence thresholds
    for hours, events in accumulations.items():
        metrics = {'rows': len(events), 'dates': len({shared.calendar(row)['localDate'] for row in events}), 'candidates': {}}
        # retain explicit unsupported horizons
        if events:
            weights = shared.balanced_weights(events)
            weights /= weights.sum()
            actual = np.array([row['actualPrecipitationMm'] for row in events])
            # process each selected item
            for candidate in CANDIDATES:
                values = np.array([row['predictions'][candidate] for row in events])
                metrics['candidates'][candidate] = {'maeMm': float(weights @ np.abs(values - actual)), 'biasMm': float(weights @ (values - actual)), 'volumeRatio': None if weights @ actual == 0 else float(weights @ values / (weights @ actual))}
        result[str(hours)] = metrics
    return result


# keep native cohorts and retrospective transfer evidence separate
def summarize(rows):
    result = {}
    # never pool different forecast source histories in a winner denominator
    for cohort in shared.COHORTS:
        selected = [row for row in rows if row['cohort'] == cohort]
        result[cohort] = {'overall': score(selected), 'byLeadBand': {}, 'byMonth': {}, 'bySeason': {}, 'accumulations': accumulation(selected)}
        # preserve frozen lead, season and month cells including sparse populations
        for field, key_function in [('byLeadBand', shared.lead_band), ('byMonth', lambda row: shared.calendar(row)['localDate'][:7]), ('bySeason', lambda row: shared.calendar(row)['season'])]:
            grouped = collections.defaultdict(list)
            # process each selected item
            for row in selected:
                grouped[key_function(row)].append(row)
            result[cohort][field] = {key: score(value) for key, value in sorted(grouped.items())}
        shifted = [row for row in selected if row.get('shiftMinus5MinutesMm') is not None]
        mean_target = [row for row in selected if row.get('gaugeMeanPrecipitationMm') is not None]
        result[cohort]['alignmentSensitivity'] = {'unchangedPrimaryPredictions': True, 'pairedPrimary': score(shifted), 'shiftMinus5Minutes': score(shifted, 'shiftMinus5MinutesMm')}
        result[cohort]['networkMeanSensitivity'] = {'unchangedPrimaryPredictions': True, 'pairedPrimary': score(mean_target), 'weightedMeanTarget': score(mean_target, 'gaugeMeanPrecipitationMm')}
    return result


# fit fixed monthly states and write exact inactive private predictions
def evaluate(rows, private_predictions_path):
    seen = set()
    partitions = collections.defaultdict(list)
    # validate once and retain source and lead partitions for bounded fit work
    for row in rows:
        validate(row)
        # check the next guarded case
        if row['key'] in seen:
            raise ValueError('duplicate model-ready key')
        seen.add(row['key'])
        partitions[(row['cohort'], shared.lead_band(row))].append(row)
    scored = [row for row in rows if POLICY['completeEvaluationStartLocalDate'] <= shared.calendar(row)['localDate'] <= POLICY['partialEvaluationEndLocalDate']]
    keys = {(shared.issue_month(row), row['cohort'], shared.lead_band(row)) for row in scored}
    transfer_keys = {(shared.issue_month(row), 'ecmwf_single_run_hindcast', shared.lead_band(row)) for row in scored if row['cohort'] == 'best_match_single_run_transfer'}
    models = {}
    # derive each monthly state from source-only earlier observations
    for month, cohort, band in sorted(keys | transfer_keys):
        models[(month, cohort, band)] = fit(partitions[(cohort, band)], month, cohort, band)
    native = []
    transfer = []
    path = Path(private_predictions_path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    # retain every scoring prediction before summarization
    with os.fdopen(descriptor, 'w') as output:
        # process each selected item
        for row in scored:
            month = shared.issue_month(row)
            model = models[(month, row['cohort'], shared.lead_band(row))]
            prediction = {**row, 'predictions': predict(row, model), 'recordKind': 'native', 'modelSupported': model['supported'], 'hurdleSupported': model['hurdleSupported'], 'trainingCutoffUtc': model['trainingCutoffUtc']}
            native.append(prediction)
            output.write(json.dumps(prediction, allow_nan=False, separators=(',', ':')) + '\n')
            # reuse the matching literal-band ECMWF state without refitting on Best Match
            if row['cohort'] == 'best_match_single_run_transfer':
                source = models[(month, 'ecmwf_single_run_hindcast', shared.lead_band(row))]
                prediction = {**row, 'predictions': predict_transfer(row, source), 'recordKind': 'transfer', 'transfer': 'ecmwf_to_best_match', 'modelSupported': source['supported'], 'hurdleSupported': source['hurdleSupported'], 'trainingCutoffUtc': source['trainingCutoffUtc']}
                transfer.append(prediction)
                output.write(json.dumps(prediction, allow_nan=False, separators=(',', ':')) + '\n')
    complete = [row for row in native if shared.calendar(row)['localDate'] <= POLICY['completeEvaluationEndLocalDate']]
    partial = [row for row in native if shared.calendar(row)['localDate'] > POLICY['completeEvaluationEndLocalDate']]
    return {'policy': POLICY, 'modelSupport': [{key: value for key, value in model.items() if key not in ('occurrence', 'positive')} for model in models.values()], 'completeMonths': summarize(complete), 'partialSeptember': summarize(partial), 'transferCompleteMonths': summarize([row for row in transfer if shared.calendar(row)['localDate'] <= POLICY['completeEvaluationEndLocalDate']]), 'transferPartialSeptember': summarize([row for row in transfer if shared.calendar(row)['localDate'] > POLICY['completeEvaluationEndLocalDate']])}


# accept one explicit private model-ready request
def main():
    request = json.load(sys.stdin)
    # check the next guarded case
    if set(request) != {'rows', 'privatePredictionsPath'}:
        raise ValueError('invalid rain research request')
    json.dump(evaluate(request['rows'], request['privatePredictionsPath']), sys.stdout, allow_nan=False, separators=(',', ':'), sort_keys=True)
    sys.stdout.write('\n')


# imports never start experiments
if __name__ == '__main__':
    main()
