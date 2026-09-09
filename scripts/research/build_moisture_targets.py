"""Build private rain and station-pressure targets without changing production."""

import argparse
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

from export_moisture_history import ZONE, STATION_KEYS, selected_sources, windows

UTC = dt.timezone.utc

# freeze the public Tempest geometry copied from the versioned domain catalog
PUBLIC_TEMPEST_STATION_CATALOG_CONTRACT_VERSION = 'rain-research-tempest-station-catalog/v1'
PUBLIC_TEMPEST_STATION_CATALOG_SOURCE = 'packages/domain/src/forecast-adjustment.ts#FORECAST_OBSERVATION_STATIONS'
_PUBLIC_TEMPEST_STATION_ROWS = (
    ('tempest-126537', 47.9582, -122.44274, 1398.67236054504, 0.6715596083191008),
    ('tempest-168853', 47.95498, -122.44074, 1077.20962495532, 0.775136628203077),
    ('tempest-201058', 47.96244, -122.43369, 1401.73955268213, 0.670592564378282),
    ('tempest-203055', 47.96505, -122.4241, 1651.02362971156, 0.5947178033706937),
    ('tempest-225947', 47.94215, -122.42542, 940.077920837135, 0.8190433312327082),
    ('tempest-38270', 47.95293, -122.41414, 1066.83643435427, 0.7784918311659549),
    ('tempest-64255', 47.95008, -122.43982, 883.385696754924, 0.8367552632922316),
)
# bind semantic policy independently of formatting
PUBLIC_TEMPEST_STATION_CATALOG_SHA256 = 'b85cd26dfe03b2ee915ab88ff04cd583cea55a0084d1ebe876ae5772f599a045'


# return a verified copy so callers cannot mutate shared station policy
def public_tempest_station_catalog():
    catalog = []
    # project immutable source rows into receipt-ready station metadata
    for key, latitude, longitude, distance, weight in _PUBLIC_TEMPEST_STATION_ROWS:
        catalog.append({'key': key, 'providerFamily': 'tempest', 'latitude': latitude, 'longitude': longitude, 'distanceMeters': distance, 'unnormalizedSpatialWeight': weight})
    policy = {'contractVersion': PUBLIC_TEMPEST_STATION_CATALOG_CONTRACT_VERSION, 'stations': catalog}
    encoded = json.dumps(policy, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()
    # reject unbound source edits before using geometry or weights
    if hashlib.sha256(encoded).hexdigest() != PUBLIC_TEMPEST_STATION_CATALOG_SHA256:
        raise ValueError('public Tempest station catalog policy hash changed')
    return catalog


# describe the catalog policy recorded by forward target builds
def public_tempest_station_catalog_receipt():
    catalog = public_tempest_station_catalog()
    return {'contractVersion': PUBLIC_TEMPEST_STATION_CATALOG_CONTRACT_VERSION, 'sourceCatalog': PUBLIC_TEMPEST_STATION_CATALOG_SOURCE, 'sha256': PUBLIC_TEMPEST_STATION_CATALOG_SHA256, 'stationKeys': [row['key'] for row in catalog]}


# normalize retained postgres and api timestamps
def instant(value):
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    # reject unspecified timezones
    if result.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return result.astimezone(UTC)


# use the model harness canonical precision
def iso(value):
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# preserve missing values and reject nonphysical numeric material
def numeric(value, minimum, maximum):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and minimum <= value <= maximum


# accept only the documented irrelevant uv flag
def quality_ok(row):
    flags = row["quality_flags"]
    return row["quality_status"] is None and (flags is None or (isinstance(flags, list) and all(isinstance(flag, str) for flag in flags) and set(flags) <= {"uv_index_out_of_range"}))


# select the deterministic spatial weighted median
def weighted_median(values):
    ordered = sorted(values, key=lambda item: (item[0], item[2]))
    total = sum(item[1] for item in ordered)
    cumulative = 0
    # split at the first half-mass boundary
    for value, weight, _ in ordered:
        cumulative += weight
        # preserve the lower value at an exact tie
        if cumulative >= total / 2:
            return value
    raise ValueError("empty weighted median")


# choose the closest valid observation with an earlier tie break
def nearest(rows, times, target, field, minimum, maximum):
    start = bisect.bisect_left(times, target - dt.timedelta(minutes=5))
    end = bisect.bisect_left(times, target + dt.timedelta(minutes=5))
    candidates = [row for row in rows[start:end] if quality_ok(row) and numeric(row[field], minimum, maximum)]
    # preserve missing station support
    if not candidates:
        return None
    return min(candidates, key=lambda row: (abs((row['_time'] - target).total_seconds()), row['_time'], row['id']))


# tile exactly sixty minutes using reported backward intervals without prorating
def rain_window(rows, times, by_end, target):
    position = bisect.bisect_right(times, target) - 1
    # require a recent actual interval endpoint
    if position < 0 or target - times[position] > dt.timedelta(minutes=5):
        return None
    end = times[position]
    wanted = end
    start = end - dt.timedelta(hours=1)
    total = 0.0
    count = 0
    # walk exact nonoverlapping intervals backward from the retained endpoint
    while wanted > start:
        row = by_end.get(wanted)
        # reject a missing, flagged or malformed interval rather than filling it
        if row is None or not quality_ok(row) or not numeric(row['report_interval_minutes'], 1, 5) or not numeric(row['precipitation_mm'], 0, 500):
            return None
        next_end = wanted - dt.timedelta(minutes=row['report_interval_minutes'])
        # reject overhangs rather than inventing a fraction of interval rain
        if next_end < start:
            return None
        total += row['precipitation_mm']
        count += 1
        wanted = next_end
    return {'amountMm': total, 'endLagSeconds': (target - end).total_seconds(), 'intervalCount': count}


# require the fixed spatial network gate on complete gauge windows
def network_rain(gauges, catalog, nearby):
    # do not turn sparse gauges into a network label
    if len(gauges) < 3 or not set(gauges) & nearby:
        return None
    values = [(value['amountMm'], catalog[key]['unnormalizedSpatialWeight'], key) for key, value in gauges.items()]
    return {'actualPrecipitationMm': weighted_median(values), 'gaugeMeanPrecipitationMm': sum(value * weight for value, weight, _ in values) / sum(weight for _, weight, _ in values), 'stationCount': len(values), 'maximumEndpointLagSeconds': max(value['endLagSeconds'] for value in gauges.values())}


# read only manifest-bound source rows from a bounded monthly member
def read_member(root, member, identities):
    path = root / member['file']
    # verify original compressed content before parsing
    if hashlib.sha256(path.read_bytes()).hexdigest() != member['sha256']:
        raise ValueError('export member hash changed')
    count = 0
    # retain every row from this bounded member
    with gzip.open(path, 'rt') as stream:
        # process each selected item
        for line in stream:
            row = json.loads(line)
            source = identities[row['source_key']]
            # reject mismatched identities despite receipt verification
            if row['source_id'] != source['id'] or row['source_config_fingerprint'] != source['source_config_fingerprint']:
                raise ValueError('source identity mismatch')
            count += 1
            yield row
    # bind parsed count to the successful readonly transaction
    if count != member['rows']:
        raise ValueError('member row count changed')


# bind the research export to the independent frozen source catalog and calendar
def production_manifest(root, evidence):
    data = (root / 'manifest.json').read_bytes()
    # require the separately retained terminal extraction receipt
    if data != (evidence / 'production-extraction-summary.json').read_bytes():
        raise ValueError('production export differs from its terminal receipt')
    manifest = json.loads(data)
    sources = selected_sources(json.loads((evidence / 'coverage-inventory.json').read_text()))
    expected = {f'{start}-{kind}.jsonl.gz': (str(start), str(end), kind) for start, end in windows() for kind in ('stations', 'anchors', 'live')}
    # reject changed source identities or widened extraction scope
    if manifest.get('contractVersion') != 'moisture-production-research-export/v1' or manifest.get('productionWrites') is not False or manifest.get('sources') != sources or len(manifest.get('members', [])) != len(expected):
        raise ValueError('invalid production export contract')
    seen = set()
    # validate each successful readonly monthly transaction
    for member in manifest['members']:
        name = member['file']
        # check the next guarded case
        if name in seen or name not in expected:
            raise ValueError('unexpected production member')
        seen.add(name)
        start, end, kind = expected[name]
        transaction = member['transaction']
        # check the next guarded case
        if transaction.get('readOnly') != 'on' or transaction.get('isolation') != 'repeatable read' or (transaction.get('from'), transaction.get('toExclusive'), transaction.get('kind')) != (start, end, kind):
            raise ValueError('invalid production transaction scope')
    return manifest


# build targets for all frozen dates from each completed monthly extraction
def build(root, evidence):
    production = root / 'production-moisture'
    manifest = production_manifest(production, evidence)
    identities = {row['source_key']: row for row in selected_sources(json.loads((evidence / 'coverage-inventory.json').read_text()))}
    catalog = {row['key']: row for row in public_tempest_station_catalog()}
    nearby = set(sorted(catalog, key=lambda key: catalog[key]['distanceMeters'])[:3])
    members = {member['file']: member for member in manifest['members']}
    # require complete extraction rather than silently scoring a prefix
    if len(members) != 99:
        raise ValueError('all 99 production members are required')
    destination = root / 'targets'
    destination.mkdir(mode=0o700)
    counts = {'stationCatalogPolicy': public_tempest_station_catalog_receipt(), 'months': {}, 'pressureByStation': collections.Counter(), 'rainEndpointLagSeconds': collections.Counter(), 'totalHours': 0, 'rainHours': 0, 'rainLiquidHours': 0, 'rainColdHours': 0, 'rainMissingTemperatureHours': 0, 'rainShiftHours': 0, 'pressureRows': 0}
    # write private target material with exclusive creation
    with (destination / 'rain.jsonl').open('x') as rain_output, (destination / 'pressure.jsonl').open('x') as pressure_output:
        # process the full frozen calendar without outcome selection
        for start, end in windows():
            member = members[f'{start}-stations.jsonl.gz']
            station_rows = collections.defaultdict(list)
            seen = {}
            # require the exact observation contract and reject conflicting duplicate timestamps
            for row in read_member(production, member, identities):
                # check the next guarded case
                if row['source_key'] not in STATION_KEYS or row['adapter_contract'] != 'tempest-observations/v2':
                    raise ValueError('ineligible observation contract')
                row['_time'] = instant(row['valid_at'])
                identity = (row['station_key'], row['_time'])
                # reject collisions instead of choosing by measured value
                if identity in seen:
                    raise ValueError('duplicate observation endpoint')
                seen[identity] = row['content_hash']
                station_rows[row['station_key']].append(row)
            arrays = {}
            # index each gauge independently
            for station, rows in station_rows.items():
                rows.sort(key=lambda row: (row['_time'], row['id']))
                arrays[station] = (rows, [row['_time'] for row in rows], {row['_time']: row for row in rows})
            hour = dt.datetime.combine(start, dt.time(), ZONE).astimezone(UTC)
            stop = dt.datetime.combine(end, dt.time(), ZONE).astimezone(UTC)
            month_counts = {'hours': 0, 'rain': 0, 'pressure': 0, 'rainLiquid': 0, 'pressureByStation': collections.Counter()}
            # retain all utc hours including local dst transitions
            while hour < stop:
                primary = {}
                shifted = {}
                temperatures = []
                # measure station support before applying a network gate
                for station, (rows, times, by_end) in arrays.items():
                    pressure = nearest(rows, times, hour, 'pressure_hpa', 300, 1100)
                    # preserve independent absolute station pressure
                    if pressure is not None:
                        pressure_output.write(json.dumps({'validAt': iso(hour), 'stationKey': station, 'actualPressureHpa': pressure['pressure_hpa'], 'observationAt': iso(pressure['_time']), 'sourceConfigFingerprint': pressure['source_config_fingerprint']}, separators=(',', ':')) + '\n')
                        counts['pressureRows'] += 1
                        counts['pressureByStation'][station] += 1
                        month_counts['pressure'] += 1
                        month_counts['pressureByStation'][station] += 1
                    rain = rain_window(rows, times, by_end, hour)
                    rain_shift = rain_window(rows, times, by_end, hour - dt.timedelta(minutes=5))
                    # retain only fully covered intervals
                    if rain is not None:
                        primary[station] = rain
                        temperature = nearest(rows, times, hour, 'temperature_c', -80, 60)
                        # require observed temperature for the liquid-only label
                        if temperature is not None:
                            temperatures.append((temperature['temperature_c'], catalog[station]['unnormalizedSpatialWeight'], station))
                    # hold shift sensitivity separate from the primary target
                    if rain_shift is not None:
                        shifted[station] = rain_shift
                target = network_rain(primary, catalog, nearby)
                shifted_target = network_rain(shifted, catalog, nearby)
                counts['totalHours'] += 1
                month_counts['hours'] += 1
                # preserve missing network labels in aggregate coverage
                if target is not None:
                    temp = weighted_median(temperatures) if len(temperatures) >= 3 else None
                    target.update({'validAt': iso(hour), 'actualTemperatureC': temp, 'liquidOnly': temp is not None and temp > 2, 'shiftMinus5MinutesMm': None if shifted_target is None else shifted_target['actualPrecipitationMm'], 'gaugeWindows': primary})
                    rain_output.write(json.dumps(target, separators=(',', ':')) + '\n')
                    counts['rainHours'] += 1
                    month_counts['rain'] += 1
                    counts['rainLiquidHours'] += target['liquidOnly']
                    counts['rainColdHours'] += temp is not None and temp <= 2
                    counts['rainMissingTemperatureHours'] += temp is None
                    counts['rainShiftHours'] += shifted_target is not None
                    counts['rainEndpointLagSeconds'][str(target['maximumEndpointLagSeconds'])] += 1
                    month_counts['rainLiquid'] += target['liquidOnly']
                hour += dt.timedelta(hours=1)
            counts['months'][str(start)[:7]] = month_counts
            print(json.dumps({'month': str(start)[:7], **month_counts}), flush=True)
    # prove the entire frozen calendar including its dst offset change
    if counts['totalHours'] != 23519 or len(counts['months']) != 33:
        raise ValueError('incomplete target calendar')
    (evidence / 'moisture-target-summary.json').write_text(json.dumps(counts, indent=2) + '\n')
    return counts


# expose only the explicit private build entry point
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('private_root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    build(args.private_root.resolve(strict=True), args.evidence)


# avoid reads on import
if __name__ == '__main__':
    main()
