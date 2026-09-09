"""causal first-day rain features and prespecified research policy."""

import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

# pin native numerical pools before importing the learner
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np

STATIONS = (64255, 225947, 38270, 168853, 126537, 201058, 203055, 66270, 34768, 88159, 126197, 27140)
POLICY = {
    'contractVersion': 'rain-sub24-model-research/v1',
    'forecastSource': 'ecmwf_single_run_hindcast',
    'productionEligible': False,
    'decisionDelayHours': 8,
    'observationDelayHours': 1,
    'availabilityEvidence': 'simulated_conservative_delays_not_historical_receipt_times',
    'horizonsHours': list(range(1, 24)),
    'trainingStartUtc': '2024-03-14T00:00:00Z',
    'developmentMonths': [f'2025-{month:02d}' for month in range(3, 9)],
    'holdoutMonths': [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)],
    'embargoDays': 7,
    'calibrationDays': 45,
    'refit': 'fixed_monthly_expanding_window_only_previously_matured_labels',
    'holdout': 'prequential_no_hyperparameter_or_candidate_changes_after_development_selection',
    'stationIds': list(STATIONS),
    'minimumCompleteGauges': 3,
    'maximumGaugeEndpointLagMinutes': 5,
    'rainForecastTemperatureMinimumC': 2,
    'phaseGate': 'raw_target_hour_temperature_above_2C_available_at_decision_no_observed_outcome_filter',
    'minimumContributingStationHours': 48,
    'minimumContributingStationDates': 7,
    'minimumSupportedTargetDates': 730,
    'humidityUsage': 'raw_forecast_covariate_only_no_humidity_adjustment_model',
    'wetThresholdMm': 0.1,
    'heavyThresholdMm': 1,
    'probabilityThresholds': [0, 0.15, 0.25, 0.35, 0.5],
    'rawBlendWeights': [0, 0.25, 0.5],
    'amountScaleBounds': [0.5, 2],
    'predictionMaximumMm': 30,
    'xgboostVersion': '3.4.1',
    'archiveEraCutoverUtc': '2026-05-12T06:00:00Z',
    'tweedieRole': 'alternative_point_amount_head_with_separate_wet_occurrence_probability_not_a_hurdle_prediction',
    'developmentRequiredBaselineMae': ['raw', 'volumeScale', 'persistence'],
    'persistenceBaseline': 'same_spatial_weighted_median_target_at_decision_minus_one_hour_with_raw_fallback_only_when_missing',
    'treeParameters': {'tree_method': 'hist', 'device': 'cpu', 'max_depth': 3, 'eta': 0.04, 'min_child_weight': 25, 'lambda': 20, 'subsample': 1, 'colsample_bytree': 1, 'seed': 20260909, 'nthread': 1},
    'boostRounds': 160,
    'selection': 'development_only_minimum_date_balanced_mae_among_volume_wet_and_detection_safe_candidates',
    'qualification': {
        'minimumRawMaeImprovementPercent': 5, 'maximumVolumeRatioDeviation': 0.2,
        'maximumWetMaeRatio': 1, 'maximumHeavyMaeRatio': 1.05,
        'minimumCsiDelta': -0.01, 'maximumFalseAlarmRatioDelta': 0.05,
        'maximumLeadBandMaeRatio': 1.05, 'maximumSeasonMaeRatio': 1.10,
        'minimumHoldoutWetDates': 100, 'minimumHoldoutHeavyHours': 50,
        'pairedDateBlockUpperMaeDeltaBelowZero': True,
        'requiredCompleteRunAccumulationsHours': [6, 12, 23],
    },
    'humidityPressureAdjustmentModels': False,
}
BASE_FEATURES = (
    'horizon', 'annualSin', 'annualCos', 'dailySin', 'dailyCos',
    'rawRain', 'log1pRawRain', 'rawMean3h', 'rawMax7h', 'rawNext6h', 'rawFirst24h',
    'rawTemperature', 'rawHumidity', 'rawWind', 'rawCloud',
    'observedTemperatureLag1', 'latestObservedMinusRawRain',
)
FEATURE_NAMES = BASE_FEATURES + tuple(f'network{metric}Lag{lag}' for lag in (1, 2, 3, 6, 12, 24) for metric in ('Mean', 'WetFraction', 'Maximum', 'Support')) + tuple(f'station{station}RainLag{lag}' for lag in (1, 3, 6) for station in STATIONS)


# accept utc-aware timestamps only
def hour_number(value):
    instant = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    # never treat local or fractional hours as forecast identity
    if instant.tzinfo is None or instant.timestamp() % 3600:
        raise ValueError('expected timezone-aware exact hour')
    return int(instant.timestamp() // 3600)


# reduce only available station data without turning missing gauges dry
def network_summary(values, weights):
    valid = np.isfinite(values)
    # expose absent support as missing rather than false zero
    if not valid.any():
        return [math.nan, math.nan, math.nan, 0]
    selected = values[valid]
    spatial = weights[valid]
    return [float(np.average(selected, weights=spatial)), float(np.average(selected >= .1, weights=spatial)), float(selected.max()), int(valid.sum())]


# construct forecast-time features from fixed lagged observations only
def features(profile, initialized_hour, horizon, station_rain, network_temperature, observation_first_hour, weights):
    # restrict outputs to the actual first-day product horizon
    if horizon not in POLICY['horizonsHours'] or len(profile) != 48 or len(weights) != len(STATIONS):
        raise ValueError('unexpected sub24 feature scope')
    decision = initialized_hour + POLICY['decisionDelayHours']
    valid_hour = decision + horizon
    original_lead = POLICY['decisionDelayHours'] + horizon
    current = profile[original_lead - 1]
    # require the original source lead rather than interpreting initialization as issue time
    if current['targetLeadHours'] != original_lead or hour_number(current['validAt']) != valid_hour:
        raise ValueError('forecast initialization or lead mismatch')
    instant = dt.datetime.fromtimestamp(valid_hour * 3600, dt.timezone.utc)
    year_start = dt.datetime(instant.year, 1, 1, tzinfo=dt.timezone.utc)
    year_end = dt.datetime(instant.year + 1, 1, 1, tzinfo=dt.timezone.utc)
    annual = 2 * math.pi * (instant - year_start).total_seconds() / (year_end - year_start).total_seconds()
    daily = 2 * math.pi * instant.hour / 24
    rain = np.array([math.nan if row['rawPrecipitationMm'] is None else row['rawPrecipitationMm'] for row in profile])
    raw = rain[original_lead - 1]
    latest_index = decision - POLICY['observationDelayHours'] - observation_first_hour
    latest_values = station_rain[latest_index] if 0 <= latest_index < len(station_rain) else np.full(len(STATIONS), np.nan)
    latest_mean = network_summary(latest_values, weights)[0]
    observed_temperature = float(network_temperature[latest_index]) if 0 <= latest_index < len(network_temperature) else math.nan
    covariates = [math.nan if current.get(key) is None else float(current[key]) for key in ('rawTemperatureC', 'rawRelativeHumidityPercent', 'rawWindSpeedMps', 'rawCloudCoverPercent')]
    result = [horizon, math.sin(annual), math.cos(annual), math.sin(daily), math.cos(daily), raw, math.log1p(raw), float(np.mean(rain[original_lead - 2:original_lead + 1])), float(np.max(rain[original_lead - 4:original_lead + 3])), float(np.sum(rain[original_lead - 1:original_lead + 5])), float(np.sum(rain[8:32])), *covariates, observed_temperature, latest_mean - rain[6]]
    # use strict lagged support independent of target-hour observations
    for lag in (1, 2, 3, 6, 12, 24):
        index = decision - lag - observation_first_hour
        values = station_rain[index] if 0 <= index < len(station_rain) else np.full(len(STATIONS), np.nan)
        result.extend(network_summary(values, weights))
    # retain spatial structure while preserving absent station values
    for lag in (1, 3, 6):
        index = decision - lag - observation_first_hour
        result.extend(station_rain[index] if 0 <= index < len(station_rain) else np.full(len(STATIONS), np.nan))
    vector = np.asarray(result, dtype=np.float32)
    # forbid schema drift and infinities while preserving missing covariates
    if len(vector) != len(FEATURE_NAMES) or np.isinf(vector).any():
        raise ValueError('invalid sub24 feature vector')
    return vector


# reject policy or source edits after the prespecified outcome boundary
def validate_freeze(root):
    frozen = json.loads((root / 'model-evaluation-freeze.json').read_text())
    if frozen['policy'] != POLICY or frozen['featureNames'] != list(FEATURE_NAMES):
        raise ValueError('frozen rain model policy or feature schema changed')
    expected_files = {'rain_sub24.py', 'build_rain_sub24.py', 'run_rain_sub24.py', 'build_moisture_targets.py', 'export_moisture_history.py', 'verify_rain_sub24_forecasts.py', 'verify_rain_sub24_stations.py'}
    if set(frozen['sourceSha256']) != expected_files:
        raise ValueError('frozen rain model source set changed')
    for name, expected in frozen['sourceSha256'].items():
        live = Path(__file__).with_name(name).read_bytes()
        retained = (root / 'sub24-model-sources' / name).read_bytes()
        if hashlib.sha256(live).hexdigest() != expected or live != retained:
            raise ValueError('frozen rain model source bytes changed')
    return frozen
