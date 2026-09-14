"""generate synthetic native parity vectors from retained private research tools.

regeneration requires the private frozen wind workspace, its locally retained
rain_*.py research sources in scripts/research, and the pinned XGBoost 3.4.1
runtime; those research sources are intentionally absent from a release checkout.
"""

import hashlib
import json
import math
import os
import datetime as dt
from pathlib import Path


# pin the native parity runtime to the frozen single-thread configuration
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_hurdle_calibration as hurdle
import rain_sub24 as base_features
import rain_context_features as context_features
import rain_trajectory_features as trajectory_features
import rain_wind_features as wind_features


ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-wind-20260913-v1'
DESTINATION = Path(__file__).resolve().parents[2] / 'packages/forecast-adjustment/test/rain-hurdle-wind-parity.json'
FEATURE_DESTINATION = Path(__file__).resolve().parents[2] / 'packages/forecast-adjustment/test/rain-hurdle-wind-feature-parity.json'
EXPECTED_STATE_SHA256 = 'b0e1b7e520affd787ab73d8da7e2797765e803fe822ffe1837d856dd0a5e58a2'
STATION_COORDINATES = (
    (64255, 47.95008, -122.43982), (225947, 47.94215, -122.42542),
    (38270, 47.95293, -122.41414), (168853, 47.95498, -122.44074),
    (126537, 47.9582, -122.44274), (201058, 47.96244, -122.43369),
    (203055, 47.96505, -122.4241), (66270, 47.93134, -122.42912),
    (34768, 47.91752, -122.41112), (88159, 47.91563, -122.41845),
    (126197, 47.91413, -122.41471), (27140, 47.98707, -122.46295),
)


# make plausible but entirely invented forecast and gauge predictors
def synthetic_features():
    x = np.full((40, 107), np.nan, dtype=np.float32)
    rain_values = (0, .05, .1, .2, .5, 1, 2, 5, 10, 20)
    # synthesize all trained lead and rain ranges
    for index in range(len(x)):
        rain = rain_values[index % len(rain_values)]
        x[index, :17] = [index % 23 + 1, .1, .9, .2, .8, rain, np.log1p(rain), rain, rain * 1.5, rain * 4, rain * 10, 12, 90, 3, 85, 11, rain]
        # fill each causal network lag independently
        for lag in range(6):
            start = 17 + 4 * lag
            x[index, start:start + 4] = [rain if index % 3 else 0, 1 if rain >= .1 else 0, rain, 11]
        x[index, 41:77] = rain if index % 3 else 0
        x[index, 77:83] = [1010, -.3, -.6, .4, 1, -1]
        x[index, 83:95] = [rain, rain, rain / 2, rain / 3, rain, rain, rain, .1, rain, 1, 1, 3]
        x[index, 95:101] = [1, 2, 3, 4, 5, 6]
        x[index, 101:107] = [.1, .2, .3, .4, .5, .6]
        # exercise native missing branches without using any real station records
        if index >= 10 and index % 4 == 0:
            x[index, 41:77] = np.nan
        # exercise absent prior forecast cycles
        if index >= 10 and index % 5 == 0:
            x[index, 83:95] = np.nan
        # exercise absent wind vectors
        if index >= 10 and index % 6 == 0:
            x[index, 101:107] = np.nan
    return x


# compare all four unchanged model heads through the native postprocessor
def export():
    state_bytes = (ROOT / 'wind-states/2026-08.json').read_bytes()
    # require the pinned native runtime and month state
    if hashlib.sha256(state_bytes).hexdigest() != EXPECTED_STATE_SHA256 or xgb.__version__ != '3.4.1':
        raise ValueError('native parity source changed')
    state = json.loads(state_bytes)
    features = synthetic_features()
    matrix = xgb.DMatrix(features, feature_names=state['model']['featureNames'], nthread=1)
    native = {}
    # replay every trained head from the retained source model
    for name in ('0.1', '1.0', '2.5', 'amount'):
        head = state['model']['heads'][name]
        path = ROOT / 'wind-models/2026-08' / head['modelFile']
        # reject altered native source bytes
        if hashlib.sha256(path.read_bytes()).hexdigest() != head['sha256']:
            raise ValueError(f'native model head changed: {name}')
        booster = xgb.Booster()
        booster.load_model(str(path))
        native[name] = booster.predict(matrix).astype(float)
    probabilities = np.array([native[name] for name in ('0.1', '1.0', '2.5')]).T
    raw = features[:, 5].astype(float)
    base = np.clip(.25 * raw + .75 * np.clip(native['amount'], .1, 30), 0, 30)
    expected = hurdle.predict(raw, probabilities, base, state['calibration'])
    fixture = {
        'contractVersion': 'rain-hurdle-wind-native-parity/v1',
        'modelMonth': '2026-08',
        'features': [[None if np.isnan(value) else float(value) for value in row] for row in features],
        'nativeFinal': expected.tolist(),
    }
    DESTINATION.write_text(json.dumps(fixture, separators=(',', ':'), allow_nan=False) + '\n')
    print(json.dumps({'rows': len(features), 'nonzero': int(np.count_nonzero(expected)), 'fixture': str(DESTINATION)}, sort_keys=True))


# express a synthetic hour in the source's exact UTC identity format
def hour_string(hour):
    return dt.datetime.fromtimestamp(hour * 3600, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# construct a smooth invented forty-eight-lead forecast run
def synthetic_run(initialized, scale=1):
    hours = []
    # produce each invented one-based source lead
    for lead in range(1, 49):
        amount = scale * (.05 * (lead % 7) + (.7 if lead % 11 == 0 else 0))
        hours.append({
            'leadHours': lead, 'precipitationMm': amount,
            'temperatureC': 12 + math.sin(lead / 4),
            'relativeHumidityPercent': 80 + math.sin(lead / 5) * 10,
            'cloudCoverPercent': 70 + math.cos(lead / 4) * 10,
            'pressureHpa': 1010 + math.sin(lead / 5) * 2,
            'windSpeedMps': 4 + math.cos(lead / 3),
            'windDirectionDegrees': (180 + lead * 3) % 360,
        })
    return {'runInitializedAt': hour_string(initialized), 'completedAt': hour_string(initialized + 7), 'hours': hours}


# match the frozen physical distance weight without importing private data
def synthetic_weights():
    site_lat, site_lon = map(math.radians, (47.950429954185445, -122.42797012608193))
    result = []
    # derive public physical weights without private observations
    for _, latitude, longitude in STATION_COORDINATES:
        latitude, longitude = map(math.radians, (latitude, longitude))
        distance = 6371000 * 2 * math.asin(math.sqrt(
            math.sin((latitude - site_lat) / 2) ** 2 +
            math.cos(latitude) * math.cos(site_lat) * math.sin((longitude - site_lon) / 2) ** 2
        ))
        result.append(1 / (1 + (distance / 2000) ** 2))
    return np.asarray(result)


# replay the archived feature builders on invented runs and station hours only
def export_feature_parity():
    initialized = base_features.hour_number('2026-09-13T00:00:00Z')
    decision, first = initialized + 8, initialized - 24
    current = synthetic_run(initialized)
    prior6, prior12 = synthetic_run(initialized - 6, .9), synthetic_run(initialized - 12, .8)
    rain = np.full((33, 12), np.nan)
    temperature = np.full(33, np.nan)
    station_rows = []
    # populate only earlier synthetic station hours
    for lag in (1, 2, 3, 6, 12, 24):
        hour = decision - lag
        rain[hour - first, :] = .2 + lag * .01
        temperature[hour - first] = 11
        # retain all twelve fixed physical gauge identities
        for station_id, _, _ in STATION_COORDINATES:
            station_rows.append({
                'hourAt': hour_string(hour), 'receivedAt': hour_string(decision),
                'stationId': station_id, 'precipitationMm': .2 + lag * .01,
                'temperatureC': 11,
            })
    profile = [{
        'targetLeadHours': row['leadHours'],
        'validAt': hour_string(initialized + row['leadHours']),
        'rawPrecipitationMm': row['precipitationMm'],
        'rawTemperatureC': row['temperatureC'],
        'rawRelativeHumidityPercent': row['relativeHumidityPercent'],
        'rawWindSpeedMps': row['windSpeedMps'],
        'rawCloudCoverPercent': row['cloudCoverPercent'],
    } for row in current['hours']]
    leads = (1, 6, 23)
    x = np.vstack([
        base_features.features(profile, initialized, lead, rain, temperature, first, synthetic_weights())
        for lead in leads
    ])
    data = {
        'x': x, 'initialized': np.asarray([initialized] * len(leads)),
        'lead': np.asarray(leads), 'hour': np.asarray([decision + lead for lead in leads]),
        'raw': np.asarray([current['hours'][8 + lead - 1]['precipitationMm'] for lead in leads], dtype=np.float32),
    }
    profiles = {}
    # bind current and two earlier forecast profiles
    for run in (current, prior6, prior12):
        key = base_features.hour_number(run['runInitializedAt'])
        profiles[key] = {
            name: np.asarray([hour[field] for hour in run['hours']])
            for name, field in (('rain', 'precipitationMm'), ('temperature', 'temperatureC'), ('pressure', 'pressureHpa'))
        }
    full95 = context_features.build_features(data, profiles)[0]['full']
    trajectory = {initialized: {
        name: np.asarray([hour[field] for hour in current['hours']])
        for name, field in (('humidity', 'relativeHumidityPercent'), ('cloud', 'cloudCoverPercent'), ('wind', 'windSpeedMps'))
    }}
    full101 = trajectory_features.build_features(data, full95, trajectory)[0]
    vector = {initialized: {
        'wind': np.asarray([hour['windSpeedMps'] for hour in current['hours']]),
        'direction': np.asarray([hour['windDirectionDegrees'] for hour in current['hours']]),
    }}
    full107 = wind_features.build_features(data, full101, vector)[0]
    fixture = {
        'contractVersion': 'rain-hurdle-wind-synthetic-feature-parity/v1',
        'currentRun': current, 'priorRuns': [prior6, prior12],
        'stationHours': station_rows, 'leads': leads,
        'nativeFeatures': [[None if np.isnan(value) else float(value) for value in row] for row in full107],
    }
    FEATURE_DESTINATION.write_text(json.dumps(fixture, separators=(',', ':'), allow_nan=False) + '\n')
    print(json.dumps({'featureRows': len(full107), 'featureColumns': full107.shape[1], 'fixture': str(FEATURE_DESTINATION)}, sort_keys=True))


# run only for an explicit operator parity regeneration
if __name__ == '__main__':
    export()
    export_feature_parity()
