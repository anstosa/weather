"""independently verify the retained rain forecast corpus without acquisition imports."""

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import stat
from itertools import pairwise
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

COHORT = 'ecmwf_single_run_hindcast'
CONTRACT = 'rain-sub24-acquisition/v1'
CLASSIFICATION = 'retrospective_model_run_initialization_not_observed_issue_time'
VARIABLES = ('temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'precipitation', 'surface_pressure', 'cloud_cover')
FIELDS = ('rawTemperatureC', 'rawRelativeHumidityPercent', 'rawWindSpeedMps', 'rawPrecipitationMm', 'rawPressureHpa', 'rawCloudCoverPercent')
UNITS = dict(zip(('time', *VARIABLES), ('iso8601', '°C', '%', 'm/s', 'mm', 'hPa', '%'), strict=True))


# reject any violated independent invariant with a bounded explanation
def require(condition, message):
    if not condition:
        raise ValueError(message)


# hash exact retained bytes
def sha(data):
    return hashlib.sha256(data).hexdigest()


# use canonical producer-compatible encoding without importing the producer
def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


# independently reconstruct the exact requested calendar
def population():
    rows = []
    start = dt.datetime(2024, 3, 14, tzinfo=dt.timezone.utc)
    for day in range(901):
        for cycle in (0, 6, 12, 18):
            initialized = start + dt.timedelta(days=day, hours=cycle)
            run = initialized.strftime('%Y-%m-%dT%H:00')
            key = f'{COHORT}|{run}'
            rows.append({'key': key, 'cohort': COHORT, 'model': 'ecmwf_ifs', 'run': run, 'runInitializedAt': run + ':00Z', 'slug': sha(key.encode())[:24]})
    return rows


# reject private-tree links and bind every byte before and after verification
def tree_hash(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        metadata = path.lstat()
        require(not stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == os.getuid() and not metadata.st_mode & 0o077, 'non-private or linked acquisition member')
        require(stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode), 'unexpected acquisition filesystem type')
        if path.is_file():
            require(metadata.st_nlink == 1, 'hardlinked acquisition member')
            digest.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()


# rebuild raw forecast normalization from independent timestamp and field rules
def reconstruct(body, identity):
    data = json.loads(body)
    require(data['hourly_units'] == UNITS and data['timezone'] == 'GMT' and data['utc_offset_seconds'] == 0, 'forecast units or timezone changed')
    hourly = data['hourly']
    require(set(hourly) == {'time', *VARIABLES} and all(len(hourly[key]) == 49 for key in hourly), 'forecast array scope changed')
    initialized = dt.datetime.fromisoformat(identity['runInitializedAt'].replace('Z', '+00:00'))
    for lead, time in enumerate(hourly['time']):
        require(time == (initialized + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'), 'forecast timestamp shift')
    for variable in VARIABLES:
        for value in hourly[variable]:
            require(value is None or (type(value) in (int, float) and math.isfinite(value)), 'nonfinite forecast value')
    require(all(value is None or 0 <= value <= 500 for value in hourly['precipitation']), 'invalid precipitation amount')
    rows = []
    for lead in range(1, 49):
        row = {'key': identity['key'] + f'|lead={lead}', 'cohort': COHORT, 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'referenceAt': identity['runInitializedAt'], 'runInitializedAt': identity['runInitializedAt'], 'actualIssueAt': None, 'runReferenceClassification': CLASSIFICATION, 'targetLeadHours': lead, 'forecastElevationM': data['elevation']}
        row.update({field: hourly[variable][lead] for field, variable in zip(FIELDS, VARIABLES, strict=True)})
        rows.append(row)
    return rows, {variable: sum(value is None for value in hourly[variable][1:]) for variable in VARIABLES}


# verify all identities, requests, responses and normalized bytes before modeling
def verify(root, evidence):
    before = tree_hash(root)
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    contract = json.loads((root / 'contract.json').read_text())
    plan = contract['plan']
    require(manifest['contractVersion'] == contract['contractVersion'] == CONTRACT, 'wrong rain contract')
    require(plan['requestedRuns'] == 3604 and plan['maximumAttempts'] == 3800 and plan['rateCaps'] == {'hourly': 3800, 'daily': 3800} and plan['minimumGlobalStartSpacingMs'] == 1000, 'wrong acquisition scope or budget')
    require(plan['variables'] == list(VARIABLES) and plan['selectedLeads'] == [1, 48] and plan['forecastHours'] == 49, 'wrong forecast variable or horizon scope')
    require(manifest['productionWrites'] is False and manifest['modelFit'] is False and manifest['actualIssueTimeKnown'] is False, 'invalid publication claims')
    require(set(manifest['cohortFiles']) == {COHORT} and set(manifest['nullCountsSelectedLeads']) == {COHORT}, 'mixed forecast cohorts')
    require(sha((evidence / 'acquisition-plan.json').read_bytes()) == manifest['plan']['sha256'], 'plan hash changed')
    for name, expected in contract['sourceSha256'].items():
        require(sha((root.parent / 'forecast-acquisition-sources' / name).read_bytes()) == expected, 'frozen acquisition source hash changed')
    require({path.name for path in (root / 'runs').iterdir()} == {COHORT}, 'unknown forecast cohort directory')
    identities = population()
    require({path.name for path in (root / 'runs' / COHORT).iterdir()} == {row['slug'] for row in identities}, 'missing or unknown forecast identity')
    require(len(manifest['identities']) == len(identities), 'manifest identity count changed')
    statuses, gaps, nulls, months, cycles = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    starts, successful_dates = [], set()
    combined = hashlib.sha256()
    total_bytes = 0
    for identity, declared in zip(identities, manifest['identities'], strict=True):
        run_root = root / 'runs' / COHORT / identity['slug']
        receipt = json.loads((run_root / 'run-result.json').read_text())
        require(receipt == declared and receipt['status'] in ('success', 'gap'), 'unknown or inconsistent terminal status')
        require(all(receipt[field] == identity[field] for field in ('key', 'cohort', 'model', 'runInitializedAt')), 'receipt identity mismatch')
        require(receipt['actualIssueAt'] is None and receipt['runReferenceClassification'] == CLASSIFICATION, 'invented issue-time evidence')
        attempts = sorted((run_root / 'attempts').iterdir())
        require([path.name for path in attempts] in (['01'], ['01', '02']) and receipt['attemptCount'] == len(attempts), 'invalid attempt count')
        statuses_seen, last_result, last_body = [], None, None
        for index, attempt in enumerate(attempts, start=1):
            require({path.name for path in attempt.iterdir()} == {'request.json', 'result.json', 'body.bin'}, 'unknown attempt material')
            request = json.loads((attempt / 'request.json').read_text())
            result = json.loads((attempt / 'result.json').read_text())
            body = (attempt / 'body.bin').read_bytes()
            require(request['key'] == identity['key'] and request['attempt'] == index and request['minimumGlobalStartSpacingMs'] == 1000, 'request identity or pacing changed')
            url = urlsplit(request['url'])
            require(url.scheme == 'https' and url.netloc == 'single-runs-api.open-meteo.com' and url.path == '/v1/forecast', 'unexpected request endpoint')
            expected_query = {'latitude': '47.950429954185445', 'longitude': '-122.42797012608193', 'run': identity['run'], 'models': 'ecmwf_ifs', 'hourly': ','.join(VARIABLES), 'forecast_hours': '49', 'timezone': 'GMT', 'temperature_unit': 'celsius', 'wind_speed_unit': 'ms', 'precipitation_unit': 'mm', 'timeformat': 'iso8601'}
            require(parse_qs(url.query) == {key: [value] for key, value in expected_query.items()}, 'request parameters changed')
            require(result['responseSha256'] == sha(body) and result['responseBytes'] == len(body) and result['standardTlsHostnameValidation'] is True, 'response bytes or tls evidence changed')
            started = dt.datetime.fromisoformat(request['startedAtUtc'])
            require(started.tzinfo is not None and dt.datetime.fromisoformat(result['completedAtUtc']) >= started, 'invalid request chronology')
            starts.append(started.timestamp())
            if index == 2:
                require(last_result['transportReturnCode'] != 0 or last_result['httpStatus'] in range(500, 600), 'retry after a nonretryable response')
            statuses_seen.append(result['httpStatus'])
            last_result, last_body = result, body
        require(receipt['httpStatuses'] == statuses_seen, 'receipt attempt statuses changed')
        statuses[receipt['status']] += 1
        cycles[identity['run'][11:13] + ':' + receipt['status']] += 1
        if receipt['status'] == 'gap':
            reason = receipt['gapReason']
            require(reason in ('transport_failure', 'http_5xx', 'invalid_response') or reason == f"http_{last_result['httpStatus']}", 'gap reason inconsistent with attempts')
            if reason.startswith('http_') and reason != 'http_5xx':
                require(last_result['httpStatus'] != 200, 'successful http response mislabeled as missing')
            gaps[reason] += 1
            continue
        require(last_result['httpStatus'] == 200 and last_result['transportReturnCode'] == 0, 'success without successful response')
        expected_rows, null_count = reconstruct(last_body, identity)
        normalized = (run_root / 'normalized.jsonl').read_bytes()
        expected_normalized = b''.join((canonical(row) + '\n').encode() for row in expected_rows)
        require(normalized == expected_normalized and receipt['normalizedSha256'] == sha(normalized) and receipt['normalizedBytes'] == len(normalized), 'independent forecast reconstruction mismatch')
        require(receipt['responseSha256'] == sha(last_body) and receipt['nullCountsSelectedLeads'] == null_count, 'success receipt reconstruction mismatch')
        combined.update(normalized)
        total_bytes += len(normalized)
        nulls.update(null_count)
        successful_dates.add(identity['run'][:10])
        months[identity['run'][:7]] += 1
    starts.sort()
    require(len(starts) <= 3800 and len(starts) == manifest['attemptsStarted'], 'global attempt cap or count mismatch')
    require(all(later - earlier >= .999 for earlier, later in pairwise(starts)), 'global request starts violated one-second pacing')
    cohort = manifest['cohortFiles'][COHORT]
    require(cohort['rows'] == statuses['success'] * 48 and cohort['bytes'] == total_bytes and cohort['sha256'] == combined.hexdigest(), 'aggregate forecast metadata mismatch')
    require(sha((root / cohort['path']).read_bytes()) == combined.hexdigest(), 'aggregate forecast file changed')
    require(manifest['statusCounts'] == dict(statuses) and manifest['gapCounts'] == dict(gaps) and manifest['nullCountsSelectedLeads'][COHORT] == dict(nulls), 'aggregate status or null accounting changed')
    require(len(successful_dates) >= 730 and min(successful_dates) <= '2024-08-31' and max(successful_dates) >= '2026-08-31', 'less than two years of actual initialized forecasts')
    after = tree_hash(root)
    require(before == after, 'acquisition changed during independent verification')
    result = {'contractVersion': 'rain-sub24-forecast-independent-verification/v1', 'verified': True, 'manifestSha256': sha(manifest_bytes), 'treeSha256': after, 'requestedRuns': len(identities), 'attempts': len(starts), 'statusCounts': dict(statuses), 'gapCounts': dict(gaps), 'successfulInitializationDates': len(successful_dates), 'firstInitializationDate': min(successful_dates), 'lastInitializationDate': max(successful_dates), 'byMonth': dict(sorted(months.items())), 'byCycle': dict(cycles), 'normalizedRows': cohort['rows'], 'actualIssueTimeKnown': False, 'progressContractNote': 'shared progress counter retains its older contract name and is not qualification evidence', 'productionWrites': False}
    (evidence / 'forecast-independent-verification.json').write_text(canonical(result) + '\n')
    return result


# verify stable local inputs without contacting any provider
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    print(canonical(verify(args.root / 'acquisition', args.evidence)))
