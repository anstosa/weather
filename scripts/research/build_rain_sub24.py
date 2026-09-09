"""build a twelve-gauge hourly corpus and strictly causal first-day features."""

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
from build_moisture_targets import (
    numeric,
    production_manifest,
    public_tempest_station_catalog,
    public_tempest_station_catalog_receipt,
    quality_ok,
    weighted_median,
)
from export_moisture_history import validate_private_root
from rain_sub24 import (
    FEATURE_NAMES,
    POLICY,
    STATIONS,
    features,
    hour_number,
    validate_freeze,
)

FIRST_HOUR = hour_number('2024-03-13T00:00:00Z')
LAST_HOUR_EXCLUSIVE = hour_number('2026-09-03T00:00:00Z')


# bind compressed input bytes before parsing them
def checked_bytes(path, expected):
    data = path.read_bytes()
    # stop on any retained member drift
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'input checksum mismatch: {path.name}')
    return data


# write canonical small receipts without nonfinite values
def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':')) + '\n')


# assemble physical identities with the same inverse-distance weights as production
def station_catalog(root):
    resolved = json.loads((root / 'station-discovery/resolved.json').read_text())
    rows = {int(row['key'].split('-')[1]): row for row in public_tempest_station_catalog()}
    # keep the seven-gauge production-export cohort aligned with rain policy
    if set(rows) != set(STATIONS[:7]):
        raise ValueError('seven-gauge public Tempest policy changed')
    # add only the five prespecified distinct rain gauges
    for row in resolved:
        station_id = row['locationId']
        if station_id not in STATIONS or station_id in rows:
            continue
        latitude, longitude = math_radians(row['latitude']), math_radians(row['longitude'])
        site_latitude, site_longitude = math_radians(47.950429954185445), math_radians(-122.42797012608193)
        distance = 6371000 * 2 * np.arcsin(np.sqrt(np.sin((latitude - site_latitude) / 2) ** 2 + np.cos(latitude) * np.cos(site_latitude) * np.sin((longitude - site_longitude) / 2) ** 2))
        rows[station_id] = {'key': f'tempest-{station_id}', 'latitude': row['latitude'], 'longitude': row['longitude'], 'distanceMeters': float(distance), 'unnormalizedSpatialWeight': float(1 / (1 + (distance / 2000) ** 2))}
    # never count missing identities as configured stations
    if set(rows) != set(STATIONS):
        raise ValueError('twelve unique station identities are required')
    catalog = []
    # freeze one uniform physical rain-gauge catalog instead of merging unlike manifests
    for station_id in STATIONS:
        row = rows[station_id]
        if not numeric(row['latitude'], -90, 90) or not numeric(row['longitude'], -180, 180) or not numeric(row['distanceMeters'], 0, 5000) or not numeric(row['unnormalizedSpatialWeight'], .001, 1):
            raise ValueError('invalid local rain-gauge coordinates or weight')
        catalog.append({'stationId': station_id, 'key': f'tempest-{station_id}', 'providerFamily': 'tempest', 'sourceKind': 'physical_sensor', 'measurement': 'reported_interval_precipitation_mm', 'latitude': row['latitude'], 'longitude': row['longitude'], 'distanceMeters': row['distanceMeters'], 'unnormalizedSpatialWeight': row['unnormalizedSpatialWeight']})
    return catalog


# convert public coordinates for the local distance formula
def math_radians(value):
    return float(value) * np.pi / 180


# insert one physical interval without overwriting inconsistent duplicate observations
def insert(arrays, station, at, amount, minutes, temperature, accepted):
    time = dt.datetime.fromisoformat(at.replace('Z', '+00:00'))
    # reject naive and subminute observations instead of rounding their windows
    if time.tzinfo is None or time.timestamp() % 60:
        raise ValueError('station interval endpoint is not an exact utc minute')
    index = int(time.timestamp() // 60) - FIRST_HOUR * 60
    # retain only the frozen complete observation envelope
    if not 0 <= index < arrays['rain'].shape[1]:
        return
    values = (
        float(amount) if accepted and numeric(amount, 0, 500) else np.nan,
        int(minutes) if accepted and numeric(minutes, 1, 5) and minutes == int(minutes) else 0,
        float(temperature) if accepted and numeric(temperature, -80, 60) else np.nan,
    )
    # monthly export overlaps must describe identical physical measurements
    if arrays['seen'][station, index]:
        old = (arrays['rain'][station, index], arrays['minutes'][station, index], arrays['temperature'][station, index])
        if not np.allclose(old, values, equal_nan=True, rtol=0, atol=0):
            raise ValueError('conflicting station interval duplicate')
        return
    arrays['seen'][station, index] = True
    arrays['rain'][station, index], arrays['minutes'][station, index], arrays['temperature'][station, index] = values


# tile exact backward reporting intervals without interpolating or filling gaps
def hourly_window(rain, minutes, seen, target):
    recent = [index for index in range(target, max(-1, target - 6), -1) if seen[index]]
    # require a real recent endpoint
    if not recent:
        return None
    end = recent[0]
    start, wanted, total = end - 60, end, 0.0
    # reject an envelope without a full prior hour
    if start < 0:
        return None
    while wanted > start:
        interval = int(minutes[wanted])
        # reject missing, invalid or overlapping intervals
        if not seen[wanted] or interval <= 0 or not np.isfinite(rain[wanted]) or wanted - interval < start:
            return None
        total += float(rain[wanted])
        wanted -= interval
    return total, target - end


# build all station hours once from source-bound minute intervals
def observations(root, evidence, old_root):
    validate_freeze(root)
    catalog = station_catalog(root)
    count = (LAST_HOUR_EXCLUSIVE - FIRST_HOUR) * 60
    shape = (len(STATIONS), count)
    arrays = {'rain': np.full(shape, np.nan), 'temperature': np.full(shape, np.nan), 'minutes': np.zeros(shape, dtype=np.int8), 'seen': np.zeros(shape, dtype=bool)}
    old_evidence = Path('.omx/evidence/rain-humidity-pressure-recovery-20260908')
    manifest = production_manifest(old_root / 'production-moisture', old_evidence)
    source_by_key = {row['source_key']: row for row in manifest['sources']}
    sources = []
    # reuse all exact seven-gauge monthly exports within the new envelope
    for member in manifest['members']:
        if member['transaction']['kind'] != 'stations' or not '2024-03' <= member['file'][:7] <= '2026-09':
            continue
        path = old_root / 'production-moisture' / member['file']
        checked_bytes(path, member['sha256'])
        sources.append({'kind': 'production', 'file': str(path), 'sha256': member['sha256']})
        records = 0
        with gzip.open(path, 'rt') as stream:
            # preserve every manifest-bound source row before range filtering
            for line in stream:
                row = json.loads(line)
                source = source_by_key[row['source_key']]
                if row['source_id'] != source['id'] or row['source_config_fingerprint'] != source['source_config_fingerprint'] or row['adapter_contract'] != 'tempest-observations/v2':
                    raise ValueError('production station identity changed')
                station = STATIONS.index(int(row['station_key'].split('-')[1]))
                insert(arrays, station, row['valid_at'], row['precipitation_mm'], row['report_interval_minutes'], row['temperature_c'], quality_ok(row))
                records += 1
        if records != member['rows']:
            raise ValueError('production row count changed')
    new_root = root / 'station-acquisition'
    new_manifest_bytes = (new_root / 'manifest.json').read_bytes()
    independently_verified = json.loads((evidence / 'station-independent-verification.json').read_text())
    if independently_verified.get('verified') is not True or independently_verified['manifestSha256'] != hashlib.sha256(new_manifest_bytes).hexdigest():
        raise ValueError('independent station verification is required')
    new = json.loads(new_manifest_bytes)
    # data acquisition completion is required before building targets
    if new['contractVersion'] != 'rain-sub24-station-acquisition/v1' or new['complete'] is not True or new['requestedDays'] != 4520 or len(new['receipts']) != 4520:
        raise ValueError('station acquisition is incomplete')
    day_seen = set()
    # load each exact new station day independently of its rain amount
    for receipt in new['receipts']:
        key = (receipt['stationId'], receipt['date'])
        if key in day_seen or receipt['stationId'] not in STATIONS[7:]:
            raise ValueError('unexpected station day identity')
        day_seen.add(key)
        if receipt['status'] == 'gap':
            continue
        if receipt['status'] != 'success':
            raise ValueError('unknown station result status')
        path = new_root / 'days' / f"{receipt['stationId']}-{receipt['date']}" / 'normalized.json.gz'
        compressed = checked_bytes(path, receipt['normalizedSha256'])
        batch = json.loads(gzip.decompress(compressed))
        sources.append({'kind': 'public_station', 'file': str(path), 'sha256': receipt['normalizedSha256']})
        if len(batch['records']) != receipt['rows']:
            raise ValueError('new station row count changed')
        station = STATIONS.index(receipt['stationId'])
        for row in batch['records']:
            quality = row['metadata']['quality']
            accepted = quality.get('status') is None and set(quality.get('flags', [])) <= {'uv_index_out_of_range'}
            if row['metadata']['provider']['location_id'] != receipt['stationId'] or row['sourceId'] != f"research-tempest-{receipt['stationId']}":
                raise ValueError('new station physical identity changed')
            insert(arrays, station, row['validAt'], row['metrics']['precipitationMm'], row['metadata']['provider']['report_interval_minutes'], row['metrics']['temperatureC'], accepted)
    hours = LAST_HOUR_EXCLUSIVE - FIRST_HOUR
    rain = np.full((hours, len(STATIONS)), np.nan)
    temperature = np.full_like(rain, np.nan)
    lags = collections.Counter()
    # aggregate each gauge independently before network reduction
    for station in range(len(STATIONS)):
        for hour in range(hours):
            index = hour * 60
            window = hourly_window(arrays['rain'][station], arrays['minutes'][station], arrays['seen'][station], index)
            if window is not None:
                rain[hour, station] = window[0]
                lags[window[1]] += 1
            recent = arrays['temperature'][station, max(0, index - 5):index + 1]
            finite = recent[np.isfinite(recent)]
            if len(finite):
                temperature[hour, station] = finite[-1]
    weights = np.array([row['unnormalizedSpatialWeight'] for row in catalog])
    nearest = np.argsort([row['distanceMeters'] for row in catalog])[:3]
    target = np.full(hours, np.nan)
    target_mean = np.full(hours, np.nan)
    target_temperature = np.full(hours, np.nan)
    support = np.isfinite(rain).sum(axis=1)
    # require local support and use a robust spatial-median rain target
    for hour in range(hours):
        for values, output in ((temperature, target_temperature), (rain, target)):
            valid = np.isfinite(values[hour])
            if valid.sum() >= POLICY['minimumCompleteGauges'] and valid[nearest].any():
                output[hour] = weighted_median([(values[hour, index], weights[index], STATIONS[index]) for index in np.where(valid)[0]])
        valid = np.isfinite(rain[hour])
        if np.isfinite(target[hour]):
            target_mean[hour] = np.average(rain[hour, valid], weights=weights[valid])
    destination = root / 'sub24-dataset'
    destination.mkdir(mode=0o700, exist_ok=True)
    np.savez_compressed(destination / 'observations.npz', rain=rain, temperature=target_temperature, target=target, mean=target_mean, support=support, weights=weights, first_hour=FIRST_HOUR)
    station_coverage = []
    # distinguish configured station count from usable historical support
    for index, station in enumerate(STATIONS):
        supported = np.where(np.isfinite(rain[:, index]))[0]
        station_coverage.append({'stationId': station, 'completeHours': len(supported), 'datesWithCompleteHours': len(set((supported // 24).tolist())), 'firstCompleteUtc': None if not len(supported) else dt.datetime.fromtimestamp((FIRST_HOUR + int(supported[0])) * 3600, dt.timezone.utc).isoformat(), 'lastCompleteUtc': None if not len(supported) else dt.datetime.fromtimestamp((FIRST_HOUR + int(supported[-1])) * 3600, dt.timezone.utc).isoformat()})
    supported_dates = len(set((np.where(np.isfinite(target))[0] // 24).tolist()))
    # enforce actual historical contribution rather than counting catalog entries alone
    if supported_dates < POLICY['minimumSupportedTargetDates'] or any(row['completeHours'] < POLICY['minimumContributingStationHours'] or row['datesWithCompleteHours'] < POLICY['minimumContributingStationDates'] for row in station_coverage):
        write_json(evidence / 'station-coverage-blocker.json', {'stationCoverage': station_coverage, 'supportedTargetDates': supported_dates})
        raise ValueError('required two-year twelve-contributing-station coverage is not met')
    receipt = {'contractVersion': 'rain-sub24-observations/v1', 'supportedTargetDates': supported_dates, 'observationsSha256': hashlib.sha256((destination / 'observations.npz').read_bytes()).hexdigest(), 'poolSemantics': 'twelve historically contributing gauges with variable per-hour support; not twelve simultaneous gauges for two years', 'catalogPolicy': public_tempest_station_catalog_receipt(), 'catalog': catalog, 'stationCoverage': station_coverage, 'supportHistogram': dict(collections.Counter(map(int, support))), 'gaugeEndpointLagMinutes': dict(lags), 'hours': hours, 'supportedRainHours': int(np.isfinite(target).sum()), 'liquidRainHours': int((np.isfinite(target) & (target_temperature > 2)).sum()), 'sources': sources, 'productionWrites': False}
    write_json(destination / 'observation-receipt.json', receipt)
    write_json(evidence / 'station-hourly-coverage.json', {key: value for key, value in receipt.items() if key != 'sources'})
    return destination


# pair true initialized profiles with twelve-gauge truth and causal lag features
def dataset(root, evidence):
    validate_freeze(root)
    destination = root / 'sub24-dataset'
    observation_receipt = json.loads((destination / 'observation-receipt.json').read_text())
    checked_bytes(destination / 'observations.npz', observation_receipt['observationsSha256'])
    with np.load(destination / 'observations.npz') as archive:
        observations = {key: archive[key] for key in archive.files}
    acquisition = root / 'acquisition'
    verified = json.loads((evidence / 'forecast-independent-verification.json').read_text())
    manifest_bytes = (acquisition / 'manifest.json').read_bytes()
    if verified.get('verified') is not True or verified['manifestSha256'] != hashlib.sha256(manifest_bytes).hexdigest():
        raise ValueError('independent forecast verification is required')
    manifest = json.loads(manifest_bytes)
    cohort = manifest['cohortFiles']['ecmwf_single_run_hindcast']
    path = acquisition / cohort['path']
    checked_bytes(path, cohort['sha256'])
    matrices, actual, raw, hours, initialized, leads, support, means, temperatures, persistence = [], [], [], [], [], [], [], [], [], []
    missing = collections.Counter()
    # retain one exact initialization profile at a time
    with path.open() as stream:
        profile = []
        for line in stream:
            profile.append(json.loads(line))
            if len(profile) < 48:
                continue
            first = profile[0]
            init = hour_number(first['runInitializedAt'])
            if any(row['runInitializedAt'] != first['runInitializedAt'] or row['targetLeadHours'] != index + 1 for index, row in enumerate(profile)):
                raise ValueError('forecast profile identity mismatch')
            for horizon in POLICY['horizonsHours']:
                valid = init + POLICY['decisionDelayHours'] + horizon
                index = valid - FIRST_HOUR
                if not 0 <= index < len(observations['target']) or not np.isfinite(observations['target'][index]):
                    missing['unsupported_target'] += 1
                    continue
                raw_temperature = profile[POLICY['decisionDelayHours'] + horizon - 1]['rawTemperatureC']
                # restrict rain-only application with a predictor known at decision time
                if raw_temperature is None or not raw_temperature > POLICY['rainForecastTemperatureMinimumC']:
                    missing['cold_or_unknown_forecast_phase'] += 1
                    continue
                vector = features(profile, init, horizon, observations['rain'], observations['temperature'], FIRST_HOUR, observations['weights'])
                if not np.isfinite(vector[5]):
                    missing['missing_raw_rain'] += 1
                    continue
                # persist the identical target statistic at the latest causal observation hour
                lag_index = init + POLICY['decisionDelayHours'] - POLICY['observationDelayHours'] - FIRST_HOUR
                persistence.append(observations['target'][lag_index] if 0 <= lag_index < len(observations['target']) else np.nan)
                matrices.append(vector)
                actual.append(observations['target'][index])
                means.append(observations['mean'][index])
                temperatures.append(observations['temperature'][index])
                raw.append(vector[5])
                hours.append(valid)
                initialized.append(init)
                leads.append(horizon)
                support.append(observations['support'][index])
            profile = []
        if profile:
            raise ValueError('truncated forecast profile')
    # verify usable forecast dates rather than merely the requested archive envelope
    initialized_dates = len({value // 24 for value in initialized})
    if initialized_dates < 730:
        raise ValueError('fewer than two years of usable initialized rain forecasts')
    np.savez_compressed(destination / 'paired.npz', x=np.asarray(matrices), actual=np.asarray(actual), mean=np.asarray(means), raw=np.asarray(raw), hour=np.asarray(hours), initialized=np.asarray(initialized), lead=np.asarray(leads), support=np.asarray(support), actual_temperature=np.asarray(temperatures), persistence=np.asarray(persistence))
    receipt = {'contractVersion': 'rain-sub24-paired/v1', 'policy': POLICY, 'featureNames': FEATURE_NAMES, 'rows': len(actual), 'usableInitializationDates': initialized_dates, 'uniqueValidHours': len(set(hours)), 'missing': dict(missing), 'forecastManifestSha256': verified['manifestSha256'], 'observationReceiptSha256': hashlib.sha256((destination / 'observation-receipt.json').read_bytes()).hexdigest(), 'pairedSha256': hashlib.sha256((destination / 'paired.npz').read_bytes()).hexdigest(), 'productionWrites': False, 'modelFit': False}
    write_json(destination / 'pairing-receipt.json', receipt)
    write_json(evidence / 'pairing-summary.json', receipt)


# build private targets and features only after acquisition completes
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('old_root', type=Path)
    arguments = parser.parse_args()
    private = validate_private_root(arguments.root)
    observations(private, arguments.evidence, validate_private_root(arguments.old_root))
    dataset(private, arguments.evidence)
