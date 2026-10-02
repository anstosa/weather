"""independently verify retained wind-direction acquisition without labels or HTTP."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from itertools import pairwise
from pathlib import Path
from urllib.parse import urlencode

CONTRACT = 'rain-direction-pilot-verification/v1'
ROOT_NAME = 'weather-moisture-research-rain-direction-20260913-v1'
ORIGINAL = Path.home() / '.weather/research-work/weather-moisture-research-rain-sub24-20260909/acquisition'
MANIFEST_SHA = '0a7345de730ccd2f92e6a699b8b71f58a77f47d8c6db531d31680c7b465d34fc'
SOURCE_SHA = 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1'
SOURCE_BYTES = 83_067_945
SOURCE_ROWS = 158_448
RUNS = 3_301
PILOT = tuple((position * (RUNS - 1)) // 5 for position in range(6))
ENDPOINT = 'https://single-runs-api.open-meteo.com/v1/forecast'
COHORT = 'ecmwf_single_run_hindcast'
SITE = (47.950429954185445, -122.42797012608193)
UNITS = {'time': 'iso8601', 'precipitation': 'mm', 'wind_direction_10m': '°'}
SAFE_HEADERS = frozenset(('content-type', 'date', 'etag', 'last-modified'))
EXPIRY = '2026-09-14T08:00:00Z'
PRODUCER_SOURCES = frozenset(('acquire_rain_direction.py', 'retain_moisture_research.py', 'verify_rain_direction_source.py'))
OLD_PRODUCER_SOURCES = frozenset(('acquire_moisture_runs.py', 'acquire_rain_sub24.py', 'export_moisture_history.py'))
PLAN_FIELDS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'pilotRuns', 'expiresAtUtc', 'maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'originalSourceSha256', 'originalManifestSha256'))


# hash exact source or retained artifact bytes
def sha256(body):
    return hashlib.sha256(body).hexdigest()


# reject duplicate keys and nonfinite json constants
def strict_json(body):
    # keep each object field unambiguous
    def unique_pairs(pairs):
        result = {}
        # reject a repeated source identity or observation field
        for key, value in pairs:
            # reject duplicate json fields
            if key in result:
                raise ValueError('duplicate json key')
            result[key] = value
        return result

    return json.loads(body, object_pairs_hook=unique_pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


# encode receipt hashes deterministically
def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


# parse exact utc instants for run and receipt checks
def utc_time(value):
    instant = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    # require utc timestamps
    if instant.utcoffset() != dt.timedelta(0):
        raise ValueError('non-utc instant')
    return instant


# validate nullable numeric cells without turning null into zero
def physical_cell(value, lower, upper):
    # preserve source nulls
    if value is None:
        return None
    # reject invalid measurements
    if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
        raise ValueError('invalid physical measurement')
    return float(value)


# load byte-pinned original forecast identities only
def original_profiles():
    manifest_path = ORIGINAL / 'manifest.json'
    manifest_bytes = manifest_path.read_bytes()
    # bind original manifest bytes
    if sha256(manifest_bytes) != MANIFEST_SHA:
        raise ValueError('original acquisition manifest changed')
    manifest = strict_json(manifest_bytes)
    cohort = manifest['cohortFiles'][COHORT]
    # bind original cohort metadata
    if cohort != {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'bytes': SOURCE_BYTES, 'rows': SOURCE_ROWS, 'sha256': SOURCE_SHA, 'successfulRuns': RUNS}:
        raise ValueError('original cohort metadata changed')
    # bind original request coordinates
    if manifest['requestCoordinates'] != {'latitude': SITE[0], 'longitude': SITE[1]}:
        raise ValueError('original request location changed')
    identities = [item for item in manifest['identities'] if item.get('status') == 'success']
    # require all unique source runs
    if len(identities) != RUNS or len({item['runInitializedAt'] for item in identities}) != RUNS:
        raise ValueError('original successful run count changed')
    source_path = ORIGINAL / cohort['path']
    source_bytes = source_path.read_bytes()
    # bind normalized source bytes
    if len(source_bytes) != SOURCE_BYTES or sha256(source_bytes) != SOURCE_SHA:
        raise ValueError('original normalized forecast bytes changed')
    profiles = []
    rows = source_bytes.splitlines()
    # require complete source row count
    if len(rows) != SOURCE_ROWS:
        raise ValueError('original normalized row count changed')
    # keep all source forecasts ordered by original manifest identity
    for run_index, identity in enumerate(identities):
        initialized = identity['runInitializedAt']
        run = initialized[:16]
        # bind original run metadata
        if identity['cohort'] != COHORT or identity['key'] != f'{COHORT}|{run}' or identity['model'] != 'ecmwf_ifs':
            raise ValueError('original run identity changed')
        origin = utc_time(initialized)
        grid = identity['returnedGrid']
        # require exact grid keys
        if set(grid) != {'latitude', 'longitude'}:
            raise ValueError('original grid metadata changed')
        grid_pair = (physical_cell(grid['latitude'], -90, 90), physical_cell(grid['longitude'], -180, 180))
        precipitation = []
        # bind each one-based lead to its original run and valid hour
        for lead, line in enumerate(rows[run_index * 48:(run_index + 1) * 48], 1):
            row = strict_json(line)
            # bind each source lead
            if row['cohort'] != COHORT or row['runInitializedAt'] != initialized or row['targetLeadHours'] != lead or row['key'] != f'{COHORT}|{run}|lead={lead}' or row['validAt'] != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ') or row['actualIssueAt'] is not None:
                raise ValueError('original normalized lead identity changed')
            precipitation.append(physical_cell(row['rawPrecipitationMm'], 0, 2_000))
        profiles.append({'run': run, 'initialized': initialized, 'key': identity['key'], 'grid': grid_pair, 'precipitation': tuple(precipitation)})
    # require chronological source order
    if any(profiles[index]['run'] >= profiles[index + 1]['run'] for index in range(RUNS - 1)):
        raise ValueError('original successful runs not chronological')
    return profiles


# verify one exact one-location public forecast response against old source
def audit_response(body, original):
    response = strict_json(body)
    # require one response object
    if not isinstance(response, dict):
        raise TypeError('single-site response is not an object')
    # single-coordinate responses may omit the default zero location id
    if 'location_id' in response and (type(response['location_id']) is not int or response['location_id'] != 0):
        raise ValueError('response location id changed')
    # bind response units and timezone
    if response.get('timezone') != 'GMT' or type(response.get('utc_offset_seconds')) is not int or response['utc_offset_seconds'] != 0 or response.get('hourly_units') != UNITS:
        raise ValueError('response timezone or units changed')
    grid = (physical_cell(response.get('latitude'), -90, 90), physical_cell(response.get('longitude'), -180, 180))
    # match original grid
    if grid != original['grid'] or physical_cell(response.get('elevation'), -1_000, 10_000) is None:
        raise ValueError('response grid or target elevation changed')
    hourly = response.get('hourly')
    # require exact hourly variables
    if not isinstance(hourly, dict) or set(hourly) != {'time', 'precipitation', 'wind_direction_10m'}:
        raise ValueError('response hourly schema changed')
    # bind every forecast cell to initialization plus source lead
    for name in ('time', 'precipitation', 'wind_direction_10m'):
        # require full response horizon
        if not isinstance(hourly.get(name), list) or len(hourly[name]) != 49:
            raise ValueError('response horizon changed')
    origin = utc_time(original['initialized'])
    # bind each valid hour
    for lead, value in enumerate(hourly['time']):
        # reject shifted valid hours
        if value != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'):
            raise ValueError('response valid hour changed')
    rain = tuple(physical_cell(value, 0, 2_000) for value in hourly['precipitation'])
    direction = tuple(physical_cell(value, 0, 360) for value in hourly['wind_direction_10m'])
    # require original rain parity
    if rain[1:] != original['precipitation']:
        raise ValueError('response precipitation differs from original forecast')
    return {
        'grid': grid,
        'targetElevationM': float(response['elevation']),
        'precipitation': rain,
        'direction': direction,
        'directionNonNullHours': sum(value is not None for value in direction),
        'directionNullHours': sum(value is None for value in direction),
        'directionFootprintNonNullHours': sum(value is not None for value in direction[6:35]),
        'directionFootprintComplete': all(value is not None for value in direction[6:35]),
    }


# pin one exact original-site request without extra model variables
def expected_params(run):
    return [
        ['latitude', repr(SITE[0])],
        ['longitude', repr(SITE[1])],
        ['run', run],
        ['models', 'ecmwf_ifs'],
        ['hourly', 'precipitation,wind_direction_10m'],
        ['forecast_hours', '49'],
        ['timezone', 'GMT'],
        ['temperature_unit', 'celsius'],
        ['wind_speed_unit', 'ms'],
        ['precipitation_unit', 'mm'],
        ['timeformat', 'iso8601'],
    ]


# validate one retained request, receipt and complete raw body independently
def audit_attempt(root, attempt_index, run_index, original):
    relative = f'requests/{attempt_index:04d}/response-body.bin'
    directory = root / f'requests/{attempt_index:04d}'
    # require complete attempt artifacts
    if {path.name for path in directory.iterdir()} != {'request.json', 'response-body.bin', 'receipt.json'}:
        raise ValueError('request artifact set changed')
    request = strict_json((directory / 'request.json').read_bytes())
    receipt = strict_json((directory / 'receipt.json').read_bytes())
    body = (root / relative).read_bytes()
    phase = 'pilot' if attempt_index < len(PILOT) else 'bulk'
    # bind attempt to source run
    if request['requestIndex'] != attempt_index or receipt['requestIndex'] != attempt_index or request['runIndex'] != run_index or receipt['runIndex'] != run_index or request['run'] != original['run'] or receipt['run'] != original['run']:
        raise ValueError('request run identity changed')
    # bind pilot or bulk phase
    if request['phase'] != phase or receipt['phase'] != phase:
        raise ValueError('request phase changed')
    # bind endpoint and issue status
    if request['endpoint'] != ENDPOINT or receipt['endpoint'] != ENDPOINT or request['actualIssueAt'] is not None or receipt['actualIssueAt'] is not None:
        raise ValueError('request provenance changed')
    params = expected_params(original['run'])
    # bind canonical query parameters
    if request['canonicalParams'] != params or receipt['canonicalParams'] != params or request['paramsSha256'] != receipt['paramsSha256'] or request['paramsSha256'] != sha256(canonical_json(params)):
        raise ValueError('request parameters changed')
    url = ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])
    # bind exact request url
    if request['urlSha256'] != receipt['urlSha256'] or request['urlSha256'] != sha256(url.encode()):
        raise ValueError('request URL changed')
    started = utc_time(request['startedAtUtc'])
    received = utc_time(receipt['responseReceivedAtUtc'])
    # order request timestamps
    if started != utc_time(receipt['startedAtUtc']) or received < started:
        raise ValueError('request timing changed')
    # require complete http success
    if receipt['status'] != 200 or receipt['result'] != 'success' or receipt['error'] is not None or receipt['rawBodyFile'] != 'response-body.bin' or receipt['bodyComplete'] is not True:
        raise ValueError('request was not a complete success')
    # exclude sensitive headers
    if not isinstance(receipt['safeHeaders'], dict) or not set(receipt['safeHeaders']).issubset(SAFE_HEADERS):
        raise ValueError('unsafe response headers')
    # enforce retained body cap
    if not 0 < len(body) == receipt['responseBytesObserved'] == receipt['responseBytesStored'] <= 2_000_000:
        raise ValueError('raw response length changed')
    body_sha = sha256(body)
    # bind raw body digest
    if receipt['contentSha256'] != body_sha or receipt['capturedSha256'] != body_sha:
        raise ValueError('raw response hash changed')
    profile = audit_response(body, original)
    expected_summary = {
        'run': original['run'],
        'returnedGrid': {'latitude': profile['grid'][0], 'longitude': profile['grid'][1]},
        'targetElevationM': profile['targetElevationM'],
        'precipitationParity': True,
        'precipitationNullRows': sum(value is None for value in profile['precipitation']),
        'directionNullRows': profile['directionNullHours'],
        'directionNullSelectedLeads': sum(value is None for value in profile['direction'][1:]),
        'directionFootprintNonNullHours': profile['directionFootprintNonNullHours'],
        'directionFootprintComplete': profile['directionFootprintComplete'],
        'actualIssueAt': None,
    }
    # match source summary to body
    if receipt['summary'] != expected_summary:
        raise ValueError('request summary differs from retained raw body')
    return {
        'attemptIndex': attempt_index,
        'runIndex': run_index,
        'run': original['run'],
        'rawBodyPath': relative,
        'rawBodySha256': body_sha,
        'rawBodyBytes': len(body),
        'startedAtUtc': request['startedAtUtc'],
        'receivedAtUtc': receipt['responseReceivedAtUtc'],
        'grid': list(profile['grid']),
        'directionNonNullHours': profile['directionNonNullHours'],
        'directionNullHours': profile['directionNullHours'],
        'directionFootprintNonNullHours': profile['directionFootprintNonNullHours'],
        'directionFootprintComplete': profile['directionFootprintComplete'],
        'receiptSummary': expected_summary,
        'direction': profile['direction'],
        'precipitation': profile['precipitation'],
    }


# independently bind the source copies, complete plan and frozen producer bytes
def audit_freeze(root, originals):
    plan_bytes = (root / 'frozen-plan.json').read_bytes()
    plan = strict_json(plan_bytes)
    # bind complete plan schema
    if not isinstance(plan, dict) or set(plan) != PLAN_FIELDS or plan['contractVersion'] != 'rain-direction-acquisition/v1' or plan['endpoint'] != ENDPOINT:
        raise ValueError('direction plan schema changed')
    # bind exact run and site scope
    if plan['site'] != {'latitude': SITE[0], 'longitude': SITE[1]} or plan['runs'] != [item['run'] for item in originals] or plan['pilotRuns'] != [originals[index]['run'] for index in PILOT]:
        raise ValueError('direction plan scope changed')
    # bind deadline and old source
    if plan['expiresAtUtc'] != EXPIRY or plan['originalSourceSha256'] != SOURCE_SHA or plan['originalManifestSha256'] != MANIFEST_SHA:
        raise ValueError('direction plan source or deadline changed')
    caps = tuple(plan[name] for name in ('maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes'))
    # enforce fixed request caps
    if caps != (RUNS, RUNS, 0, 1, 30, 2_000_000) or any(type(plan[name]) is not int for name in ('maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes')):
        raise ValueError('direction request caps changed')
    freeze_bytes = (root / 'direction-freeze.json').read_bytes()
    freeze = strict_json(freeze_bytes)
    # bind frozen plan identity
    if not isinstance(freeze, dict) or freeze['contractVersion'] != plan['contractVersion'] or freeze['endpoint'] != ENDPOINT or freeze['planSha256'] != sha256(plan_bytes) or freeze['runsSha256'] != sha256(canonical_json(plan['runs'])) or freeze['pilotRuns'] != plan['pilotRuns']:
        raise ValueError('direction freeze identity changed')
    # bind old source lineage
    if freeze['originalManifestSha256'] != MANIFEST_SHA or freeze['originalNormalizedSha256'] != SOURCE_SHA or freeze['originalRoot'] != str(ORIGINAL.parent) or freeze['originalManifestPath'] != 'acquisition/manifest.json' or freeze['originalNormalizedPath'] != 'acquisition/normalized/ecmwf_single_run_hindcast.jsonl':
        raise ValueError('direction old source binding changed')
    # enforce nonproduction scope
    if freeze['maximumHttpRequests'] != RUNS or freeze['maximumLocationRequests'] != RUNS or freeze['actualIssueAt'] is not None or freeze['labelsRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('direction freeze side effect scope changed')
    # bind exact source file sets
    if set(freeze['sourceSha256']) != PRODUCER_SOURCES or set(freeze['originalProducerSha256']) != OLD_PRODUCER_SOURCES:
        raise ValueError('direction source file set changed')
    # compare all retained producer sources to executing local files
    for name, expected in freeze['sourceSha256'].items():
        # compare frozen current sources
        if sha256((root / 'sources' / name).read_bytes()) != expected or sha256(Path(__file__).with_name(name).read_bytes()) != expected:
            raise ValueError('frozen direction producer source changed')
    # compare copied original acquisition producers to pinned manifest digests
    manifest = strict_json((ORIGINAL / 'manifest.json').read_bytes())
    # compare old producer sources
    for name, expected in freeze['originalProducerSha256'].items():
        # bind each old source digest
        if manifest['sourceSha256'][name] != expected or sha256((root / 'inputs/original-producer-sources' / name).read_bytes()) != expected:
            raise ValueError('old acquisition producer source changed')
    manifest_copy = root / 'inputs/original-manifest.json'
    normalized_copy = root / 'inputs/original-normalized.jsonl'
    # bind copied source bytes
    if sha256(manifest_copy.read_bytes()) != MANIFEST_SHA or sha256(normalized_copy.read_bytes()) != SOURCE_SHA:
        raise ValueError('copied original forecast inputs changed')
    # bind copied source lengths
    if freeze['inputBytes'] != {'manifest': manifest_copy.stat().st_size, 'normalized': normalized_copy.stat().st_size}:
        raise ValueError('copied original forecast byte length changed')
    # retained copies may acquire new mtimes after archive roundtrips
    if set(freeze['inputMtimeNs']) != {'manifest', 'normalized'} or any(type(value) is not int or value <= 0 for value in freeze['inputMtimeNs'].values()):
        raise ValueError('frozen input timestamp metadata invalid')
    return plan, freeze, {'planSha256': sha256(plan_bytes), 'freezeSha256': sha256(freeze_bytes)}


# audit one completed phase report against its retained raw receipts
def audit_phase_report(root, phase, records, hashes, pilot_gate_sha=None):
    report_path = root / f'{phase}-report.json'
    report_bytes = report_path.read_bytes()
    report = strict_json(report_bytes)
    expected_count = len(PILOT) if phase == 'pilot' else RUNS - len(PILOT)
    # require complete phase
    if len(records) != expected_count or report['contractVersion'] != 'rain-direction-acquisition/v1' or report['phase'] != phase or report['status'] != 'complete' or report['failure'] is not None:
        raise ValueError('direction phase did not complete')
    # bind phase hashes
    if report['planSha256'] != hashes['planSha256'] or report['freezeSha256'] != hashes['freezeSha256'] or report['pilotVerificationSha256'] != pilot_gate_sha:
        raise ValueError('direction phase provenance changed')
    # bind phase attempt counts
    if (report['plannedHttpRequests'], report['attemptedHttpRequests'], report['successfulHttpRequests'], report['attemptedLocationRequests']) != (expected_count,) * 4:
        raise ValueError('direction phase request count changed')
    # exclude labels and model scores
    if report['actualIssueAt'] is not None or report['labelsRead'] is not False or report['modelPerformanceScored'] is not False or report['productionWrites'] is not False:
        raise ValueError('direction phase evidence scope changed')
    expected_receipts = [
        {
            'requestIndex': item['attemptIndex'],
            'runIndex': item['runIndex'],
            'run': item['run'],
            'result': 'success',
            'status': 200,
            'contentSha256': item['rawBodySha256'],
        }
        for item in records
    ]
    # rebuild reported summaries
    if report['receipts'] != expected_receipts or report['runSummaries'] != [item['receiptSummary'] for item in records]:
        raise ValueError('direction phase summaries differ from retained responses')
    expected_bulk_eligibility = all(item['directionFootprintComplete'] for item in records) if phase == 'pilot' else None
    # recompute pilot eligibility
    if report['bulkEligible'] != expected_bulk_eligibility:
        raise ValueError('pilot coverage eligibility changed')
    return {'sha256': sha256(report_bytes), 'report': report, 'bulkEligible': expected_bulk_eligibility}


# independently replay the six fixed pilot bodies before bulk authorization
def audit_pilot(root, originals, require_before_bulk):
    plan, freeze, hashes = audit_freeze(root, originals)
    # exclude postpilot artifacts
    if require_before_bulk:
        # pilot proof must precede every nonpilot source request
        if (root / 'bulk-report.json').exists() or (root / 'report.json').exists() or (root / 'normalized').exists():
            raise ValueError('pilot verification occurred after bulk')
        # require only six pilot attempts
        if {path.name for path in (root / 'requests').iterdir()} != {f'{index:04d}' for index in range(len(PILOT))}:
            raise ValueError('nonpilot source request already exists')
    records = [audit_attempt(root, index, run_index, originals[run_index]) for index, run_index in enumerate(PILOT)]
    # reconstruct spacing and deadline from durable request timestamps
    for earlier, later in pairwise(records):
        # enforce pilot start spacing
        if (utc_time(later['startedAtUtc']) - utc_time(earlier['startedAtUtc'])).total_seconds() < plan['minimumIntervalSeconds']:
            raise ValueError('pilot request start spacing changed')
    # check every pilot deadline
    for item in records:
        # reject expired pilot starts
        if utc_time(item['startedAtUtc']) >= utc_time(plan['expiresAtUtc']):
            raise ValueError('pilot request started after expiration')
    phase = audit_phase_report(root, 'pilot', records, hashes)
    return plan, freeze, hashes, records, phase


# issue a one-shot independent six-body gate receipt inside this private root
def issue_pilot(root, output):
    originals = original_profiles()
    plan, _, hashes, records, phase = audit_pilot(root, originals, True)
    output = Path(output)
    # require new private receipt
    if output.parent.resolve() != root.resolve() or output.is_symlink() or output.exists():
        raise ValueError('pilot receipt path must be a new private-root file')
    now = dt.datetime.now(dt.timezone.utc)
    # reject expired verification
    if now >= utc_time(plan['expiresAtUtc']):
        raise ValueError('pilot verification completed after expiration')
    body_hashes = {item['rawBodyPath']: item['rawBodySha256'] for item in records}
    receipt = {
        'contractVersion': CONTRACT,
        'verdict': 'PASS',
        'bulkEligible': phase['bulkEligible'],
        'planSha256': hashes['planSha256'],
        'freezeSha256': hashes['freezeSha256'],
        'pilotReportSha256': phase['sha256'],
        'pilotRawBodySha256': body_hashes,
        'verifierSourceSha256': sha256(Path(__file__).read_bytes()),
        'verifiedAtUtc': now.isoformat(),
    }
    # exclusive creation avoids replacing a prior bulk authorization
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # persist pilot proof durably
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(canonical_json(receipt))
        stream.flush()
        os.fsync(stream.fileno())
    return receipt


# bind the pilot receipt to this verifier and its six audited raw bodies
def audit_pilot_receipt(path, hashes, records, phase):
    body = Path(path).read_bytes()
    receipt = strict_json(body)
    expected_fields = {'contractVersion', 'verdict', 'bulkEligible', 'planSha256', 'freezeSha256', 'pilotReportSha256', 'pilotRawBodySha256', 'verifierSourceSha256', 'verifiedAtUtc'}
    # require exact gate schema
    if not isinstance(receipt, dict) or set(receipt) != expected_fields or receipt['contractVersion'] != CONTRACT or receipt['verdict'] != 'PASS' or receipt['bulkEligible'] is not True or phase['bulkEligible'] is not True:
        raise ValueError('pilot receipt does not authorize bulk')
    # bind gate plan and report
    if receipt['planSha256'] != hashes['planSha256'] or receipt['freezeSha256'] != hashes['freezeSha256'] or receipt['pilotReportSha256'] != phase['sha256']:
        raise ValueError('pilot receipt source hashes changed')
    # bind six raw response hashes
    if receipt['pilotRawBodySha256'] != {item['rawBodyPath']: item['rawBodySha256'] for item in records}:
        raise ValueError('pilot receipt raw body hashes changed')
    # bind unchanged verifier code
    if receipt['verifierSourceSha256'] != sha256(Path(__file__).read_bytes()):
        raise ValueError('pilot verifier source changed after gate')
    verified = utc_time(receipt['verifiedAtUtc'])
    # require causal pilot proof
    if verified < max(utc_time(item['receivedAtUtc']) for item in records):
        raise ValueError('pilot proof predates retained responses')
    return {'sha256': sha256(body), 'verifiedAtUtc': receipt['verifiedAtUtc']}


# bind every chronological supplement lead to its independently read response
def audit_normalized(root, originals, attempts, final):
    relative = 'normalized/ecmwf_single_run_wind_direction.jsonl'
    normalized = root / relative
    # bind normalized path and rows
    if final['normalizedFile'] != relative or final['normalizedRows'] != SOURCE_ROWS:
        raise ValueError('direction normalized output contract changed')
    body = normalized.read_bytes()
    # bind normalized file digest
    if final['normalizedSha256'] != sha256(body):
        raise ValueError('direction normalized hash changed')
    lines = body.splitlines()
    # require all joined rows
    if len(lines) != SOURCE_ROWS:
        raise ValueError('direction normalized row count changed')
    null_rows = 0
    # reconstruct each row from raw response in original run chronology
    for run_index, original in enumerate(originals):
        attempt = attempts[run_index]
        origin = utc_time(original['initialized'])
        # retain exactly one joined row for each one-based lead
        for lead in range(1, 49):
            row = strict_json(lines[run_index * 48 + lead - 1])
            expected = {
                'cohort': COHORT,
                'key': f'{COHORT}|{original["run"]}|lead={lead}',
                'runInitializedAt': original['initialized'],
                'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'targetLeadHours': lead,
                'rawPrecipitationMm': original['precipitation'][lead - 1],
                'rawWindDirectionDegrees': attempt['direction'][lead],
                'returnedGrid': {'latitude': attempt['grid'][0], 'longitude': attempt['grid'][1]},
                'responseSha256': attempt['rawBodySha256'],
                'responseReceivedAtUtc': attempt['receivedAtUtc'],
                'actualIssueAt': None,
            }
            # compare exact joined forecast row
            if row != expected:
                raise ValueError(f'direction normalized row changed at run {run_index} lead {lead}')
            null_rows += row['rawWindDirectionDegrees'] is None
    return {'sha256': sha256(body), 'bytes': len(body), 'rows': len(lines), 'directionNullRows': null_rows}


# verify the complete 3301-run forecast-only source supplement
def audit_full(root, pilot_receipt_path):
    originals = original_profiles()
    plan, _, hashes, pilot_records, pilot_phase = audit_pilot(root, originals, False)
    # keep gate inside private root
    if Path(pilot_receipt_path).parent.resolve() != root.resolve() or Path(pilot_receipt_path).is_symlink():
        raise ValueError('pilot gate path differs from this private root')
    gate = audit_pilot_receipt(pilot_receipt_path, hashes, pilot_records, pilot_phase)
    pilot_set = set(PILOT)
    bulk_positions = [index for index in range(RUNS) if index not in pilot_set]
    expected_order = list(PILOT) + bulk_positions
    # require exact total request set
    if {path.name for path in (root / 'requests').iterdir()} != {f'{index:04d}' for index in range(RUNS)}:
        raise ValueError('direction request set incomplete or expanded')
    bulk_records = [audit_attempt(root, attempt_index, run_index, originals[run_index]) for attempt_index, run_index in enumerate(expected_order[len(PILOT):], len(PILOT))]
    all_records = pilot_records + bulk_records
    # every attempted run must retain one unique original chronology index
    if len(all_records) != RUNS or {item['runIndex'] for item in all_records} != set(range(RUNS)):
        raise ValueError('direction original run set incomplete')
    # check all start intervals
    for earlier, later in pairwise(all_records):
        # enforce full start spacing
        if (utc_time(later['startedAtUtc']) - utc_time(earlier['startedAtUtc'])).total_seconds() < plan['minimumIntervalSeconds']:
            raise ValueError('direction start spacing changed')
    # require pilot proof before bulk
    if utc_time(bulk_records[0]['startedAtUtc']) <= utc_time(gate['verifiedAtUtc']):
        raise ValueError('bulk began before independent pilot gate')
    # check every source deadline
    for item in all_records:
        # reject expired source starts
        if utc_time(item['startedAtUtc']) >= utc_time(plan['expiresAtUtc']):
            raise ValueError('direction request began after expiration')
    bulk_phase = audit_phase_report(root, 'bulk', bulk_records, hashes, gate['sha256'])
    final_bytes = (root / 'report.json').read_bytes()
    final = strict_json(final_bytes)
    # require complete final report
    if final['contractVersion'] != 'rain-direction-acquisition/v1' or final['phase'] != 'complete' or final['status'] != 'complete' or final['failure'] is not None:
        raise ValueError('direction final report did not complete')
    # bind final phase reports
    if final['pilotReportSha256'] != pilot_phase['sha256'] or final['bulkReportSha256'] != bulk_phase['sha256'] or final['pilotVerificationSha256'] != gate['sha256'] or final['verifierSourceSha256'] != sha256(Path(__file__).read_bytes()):
        raise ValueError('direction final report source proof changed')
    # require all original requests
    if final['totalAttemptedHttpRequests'] != RUNS or final['totalAttemptedLocationRequests'] != RUNS:
        raise ValueError('direction final report total request count changed')
    additions = {'pilotReportSha256', 'bulkReportSha256', 'totalAttemptedHttpRequests', 'totalAttemptedLocationRequests', 'normalizedFile', 'normalizedRows', 'normalizedSha256', 'verifierSourceSha256'}
    inherited = {name: value for name, value in final.items() if name not in additions}
    # retain audited bulk report
    if inherited != {**bulk_phase['report'], 'phase': 'complete'}:
        raise ValueError('direction final report diverged from audited bulk phase')
    supplement = audit_normalized(root, originals, {item['runIndex']: item for item in all_records}, final)
    return {
        'contractVersion': 'rain-direction-full-verification/v1',
        'verdict': 'PASS',
        'scope': 'forecast_only_3301_original_runs_no_http_no_labels',
        'planSha256': hashes['planSha256'],
        'freezeSha256': hashes['freezeSha256'],
        'pilotReportSha256': pilot_phase['sha256'],
        'pilotReceiptSha256': gate['sha256'],
        'bulkReportSha256': bulk_phase['sha256'],
        'finalReportSha256': sha256(final_bytes),
        'normalizedSha256': supplement['sha256'],
        'normalizedBytes': supplement['bytes'],
        'normalizedRows': supplement['rows'],
        'originalManifestSha256': MANIFEST_SHA,
        'originalNormalizedSha256': SOURCE_SHA,
        'rawResponses': RUNS,
        'rawBodyHashesSha256': sha256(canonical_json({item['rawBodyPath']: item['rawBodySha256'] for item in all_records})),
        'responseBytesTotal': sum(item['rawBodyBytes'] for item in all_records),
        'directionNullRows': supplement['directionNullRows'],
        'directionFootprintIncompleteRuns': sum(not item['directionFootprintComplete'] for item in all_records),
        'uniqueReturnedGrids': len({tuple(item['grid']) for item in all_records}),
        'historicalAsIssuedVerified': False,
        'freshHoldoutVerified': False,
        'modelGatesEvaluated': False,
        'verifierSourceSha256': sha256(Path(__file__).read_bytes()),
        'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
    }


# run only local verification without ever constructing an HTTP client
def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    pilot = commands.add_parser('pilot')
    pilot.add_argument('root', type=Path)
    pilot.add_argument('--output', type=Path, required=True)
    full = commands.add_parser('full')
    full.add_argument('root', type=Path)
    full.add_argument('--pilot-receipt', type=Path, required=True)
    full.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    expected_root = Path.home() / '.weather/research-work' / ROOT_NAME
    # require exact private root
    if root != expected_root or not root.is_dir():
        raise ValueError('direction verification root changed')
    # select explicit audit phase
    if args.command == 'pilot':
        result = issue_pilot(root, args.output)
    else:
        result = audit_full(root, args.pilot_receipt)
        output = args.output
        # preserve prior full receipt
        if output.exists() or output.is_symlink():
            raise ValueError('full verification receipt already exists')
        # create the full audit receipt once without replacing prior evidence
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        # persist full proof durably
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(canonical_json(result))
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps(result, sort_keys=True), flush=True)


# expose only explicit read-only verification commands
if __name__ == '__main__':
    main()
