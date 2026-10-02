"""diagnose one archive timeout with three fixed forecast-only requests."""

import argparse
import datetime as dt
import http.client
import json
import os
import time
from pathlib import Path
from urllib import parse

import acquire_rain_direction as source

ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-feasibility-20260913-v1'
PARENT = Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-recovery-20260913-v1'
QUERIES = (
    ('2024-05-07T00:00', 'precipitation,wind_direction_10m'),
    ('2024-05-07T00:00', 'wind_direction_10m'),
    ('2024-05-06T18:00', 'precipitation,wind_direction_10m'),
)
POLICY = {'contractVersion': 'rain-direction-timeout-probe/v1', 'queries': [list(item) for item in QUERIES], 'forecastHours': 35, 'maximumHttpRequests': 3, 'maximumLocationRequests': 3, 'timeoutSeconds': 90, 'maximumResponseBytes': 2000000, 'minimumIntervalSeconds': 1, 'retries': 0, 'expiresAtUtc': source.EXPIRY, 'endpoint': source.ENDPOINT, 'site': source.SITE, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False}
SOURCES = ('probe_rain_direction_timeout.py', *source.SOURCE_FILES)


# retain the original query conventions except the two diagnostic dimensions
def parameters(run, variables):
    return [(name, variables if name == 'hourly' else '35' if name == 'forecast_hours' else value) for name, value in source.request_parameters(run)]


# check only the hours actually returned rather than inventing tail forecasts
def check_body(body, run, variables, original):
    item = source.strict_json(body)
    names = {'time', *variables.split(',')}
    units = {name: source.UNITS[name] for name in names}
    # one exact original grid and utc run must own the response
    if not isinstance(item, dict) or item.get('timezone') != 'GMT' or type(item.get('utc_offset_seconds')) is not int or item['utc_offset_seconds'] != 0 or item.get('hourly_units') != units or ('location_id' in item and (type(item['location_id']) is not int or item['location_id'] != 0)):
        raise ValueError('probe identity or units changed')
    grid = {name: source.cell(item.get(name), -90 if name == 'latitude' else -180, 90 if name == 'latitude' else 180) for name in ('latitude', 'longitude')}
    # returned elevation is target metadata, not a substituted model grid
    if None in grid.values() or grid != original['grid'] or source.cell(item.get('elevation'), -1000, 10000) is None:
        raise ValueError('probe original grid changed')
    hourly = item.get('hourly')
    # thirty-five timestamps mean leads zero through thirty-four
    if not isinstance(hourly, dict) or set(hourly) != names or any(not isinstance(hourly[name], list) or len(hourly[name]) != 35 for name in names):
        raise ValueError('probe hourly schema changed')
    origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
    expected = [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(35)]
    # shifted hours cannot establish smaller-request feasibility
    if hourly['time'] != expected:
        raise ValueError('probe valid hours changed')
    directions = [source.cell(value, 0, 360) for value in hourly['wind_direction_10m']]
    matched = 0
    # direction-only isolates transport but cannot prove rain parity
    if 'precipitation' in names:
        rain = tuple(source.cell(value, 0, 2000) for value in hourly['precipitation'])
        # compare every requested old rain lead without reading observations
        if rain[1:] != original['rain'][:34]:
            raise ValueError('probe original precipitation changed')
        matched = 34
    return {'run': run, 'returnedGrid': grid, 'matchedOriginalRainLeads': matched, 'directionHours': 35, 'requiredNonNullDirectionHours': sum(value is not None for value in directions[6:35]), 'sourceTailLeadsNotRequested': list(range(35, 49)), 'modelSourceEligible': False}


# snapshot original sources and the fixed diagnostic before any public request
def prepare():
    ROOT.mkdir(mode=0o700)
    source.validate_private_root(ROOT)
    inputs = ROOT / 'inputs'
    inputs.mkdir(mode=0o700)
    old = PARENT / 'inputs/parent-root/inputs'
    # copy the exact old forecast-only evidence and producer identities
    for name in ('original-manifest.json', 'original-normalized.jsonl'):
        source.copy_new(old / name, inputs / name)
    producers = inputs / 'original-producer-sources'
    producers.mkdir(mode=0o700)
    # original producer snapshots remain read-only rather than re-executed
    for name in source.ORIGINAL_PRODUCERS:
        source.copy_new(old / 'original-producer-sources' / name, producers / name)
    directory = ROOT / 'sources'
    directory.mkdir(mode=0o700)
    # snapshot every direct executable dependency for later byte verification
    for name in SOURCES:
        source.copy_new(Path(__file__).with_name(name), directory / name)
    hashes = {str(path.relative_to(ROOT)): source.file_sha256(path) for path in ROOT.rglob('*') if path.is_file()}
    freeze = {'policy': POLICY, 'fileSha256': hashes, 'preparedAtUtc': source.utc_stamp()}
    source.write_new(ROOT / 'probe-freeze.json', source.canonical_json(freeze))
    validate()
    return freeze


# verify copied bytes and the original population before probing
def validate():
    source.validate_private_root(ROOT)
    freeze = source.strict_json((ROOT / 'probe-freeze.json').read_bytes())
    # no changed policy or source dependency may authorize another request
    if freeze['policy'] != POLICY:
        raise ValueError('probe policy changed')
    for name, expected in freeze['fileSha256'].items():
        # all frozen input and source files retain their exact original bytes
        if source.file_sha256(ROOT / name) != expected:
            raise ValueError('probe input changed')
    for name in SOURCES:
        # currently imported code must match the frozen copy too
        if source.file_sha256(Path(__file__).with_name(name)) != freeze['fileSha256']['sources/' + name]:
            raise ValueError('probe executing source changed')
    manifest, runs, grids = source.original_manifest(ROOT / 'inputs/original-manifest.json')
    rain = source.original_profiles(ROOT / 'inputs/original-normalized.jsonl', manifest, runs)
    originals = {run: {'rain': rain[run], 'grid': grids[run]} for run in runs}
    # original producer hashes bind the archive without running acquisition code
    for name, expected in manifest['sourceSha256'].items():
        if source.file_sha256(ROOT / 'inputs/original-producer-sources' / name) != expected:
            raise ValueError('probe old producer changed')
    return originals


# make only the fixed requests and retain failures as diagnostic outcomes
def run():
    originals = validate()
    requests = ROOT / 'requests'
    requests.mkdir(mode=0o700)
    receipts = []
    # sequential start order is fixed regardless of returned forecast values
    for index, (initialized, variables) in enumerate(QUERIES):
        # waiting after completion conservatively enforces minimum start spacing
        if index:
            time.sleep(POLICY['minimumIntervalSeconds'])
        # expiry and executing bytes are checked before every public operation
        if source.utc_now() >= dt.datetime.fromisoformat(source.EXPIRY.replace('Z', '+00:00')):
            raise ValueError('probe expired')
        validate()
        directory = requests / f'{index:04d}'
        directory.mkdir(mode=0o700)
        params = parameters(initialized, variables)
        url = source.ENDPOINT + '?' + parse.urlencode(params)
        request = {'requestIndex': index, 'run': initialized, 'params': params, 'startedAtUtc': source.utc_stamp(), 'urlSha256': source.sha256(url.encode())}
        source.write_new(directory / 'request.json', source.canonical_json(request))
        status, body, headers, error, summary = None, None, {}, None, None
        # one bounded no-redirect request never retries within this diagnostic
        try:
            status, headers, body = source.fetch(url, 90, 2000000)
        except (OSError, ValueError, http.client.HTTPException) as problem:
            error = type(problem).__name__ + ': ' + str(problem)
            # retain partial transport bytes without treating them as forecast data
            if isinstance(problem, http.client.IncompleteRead):
                body = problem.partial[:2000001]
        received = source.utc_stamp()
        # preserve every bounded response before any schema interpretation
        if body is not None:
            source.write_new(directory / 'response-body.bin', body[:2000000])
        # only a bounded successful body can establish forecast feasibility
        if status == 200 and body is not None and len(body) <= 2000000:
            try:
                summary = check_body(body, initialized, variables, originals[initialized])
            except (ValueError, TypeError, KeyError) as problem:
                error = type(problem).__name__ + ': ' + str(problem)
        receipt = {**request, 'receivedAtUtc': received, 'status': status, 'bodyBytes': len(body) if body is not None else 0, 'capturedSha256': source.sha256(body[:2000000]) if body is not None else None, 'safeHeaders': {key.lower(): str(value)[:256] for key, value in headers.items() if key.lower() in source.SAFE_HEADERS}, 'summary': summary, 'error': error}
        source.write_new(directory / 'receipt.json', source.canonical_json(receipt))
        receipts.append(receipt)
        # a provider quota refusal ends all remaining diagnostic requests
        if status == 429:
            break
    validate()
    report = {'policy': POLICY, 'freezeSha256': source.file_sha256(ROOT / 'probe-freeze.json'), 'attemptedHttpRequests': len(receipts), 'attemptedLocationRequests': len(receipts), 'receipts': receipts, 'completeModelSource': False}
    source.write_new(ROOT / 'report.json', source.canonical_json(report))
    return report


# separate source freezing from the explicit bounded network phase
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('prepare', 'run'))
    args = parser.parse_args()
    print(json.dumps(prepare() if args.command == 'prepare' else run(), sort_keys=True), flush=True)
