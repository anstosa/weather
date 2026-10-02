"""retain one bounded wind-direction supplement for original rain runs."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import time
from pathlib import Path
from urllib import error, parse, request

from retain_moisture_research import validate_private_root

CONTRACT = 'rain-direction-acquisition/v1'
PILOT_RECEIPT_CONTRACT = 'rain-direction-pilot-verification/v1'
ENDPOINT = 'https://single-runs-api.open-meteo.com/v1/forecast'
ORIGINAL_ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-sub24-20260909'
ORIGINAL_MANIFEST = 'acquisition/manifest.json'
ORIGINAL_NORMALIZED = 'acquisition/normalized/ecmwf_single_run_hindcast.jsonl'
ORIGINAL_MANIFEST_SHA256 = '0a7345de730ccd2f92e6a699b8b71f58a77f47d8c6db531d31680c7b465d34fc'
ORIGINAL_NORMALIZED_SHA256 = 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1'
SOURCE_FILES = ('acquire_rain_direction.py', 'retain_moisture_research.py', 'verify_rain_direction_source.py')
ORIGINAL_PRODUCERS = ('acquire_moisture_runs.py', 'acquire_rain_sub24.py', 'export_moisture_history.py')
SITE = {'latitude': 47.950429954185445, 'longitude': -122.42797012608193}
RUN_COUNT = 3301
LEADS = 48
PILOT_POSITIONS = (0, 660, 1320, 1980, 2640, 3300)
EXPIRY = '2026-09-14T08:00:00Z'
PLAN_KEYS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'pilotRuns', 'expiresAtUtc', 'maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'originalSourceSha256', 'originalManifestSha256'))
PILOT_RECEIPT_KEYS = frozenset(('contractVersion', 'verdict', 'bulkEligible', 'planSha256', 'freezeSha256', 'pilotReportSha256', 'pilotRawBodySha256', 'verifierSourceSha256', 'verifiedAtUtc'))
UNITS = {'time': 'iso8601', 'precipitation': 'mm', 'wind_direction_10m': '°'}
SAFE_HEADERS = frozenset(('content-type', 'date', 'etag', 'last-modified'))
NORMALIZED_PATH = 'normalized/ecmwf_single_run_wind_direction.jsonl'


class AcquisitionError(ValueError):
    """mark a stopped supplemental acquisition without retry authority."""


# prohibit urllib from following a redirect away from the frozen endpoint
class NoRedirect(request.HTTPRedirectHandler):
    # a changed destination is not the planned public source
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AcquisitionError('redirect refused')


# encode only deterministic finite json into durable receipts
def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


# reject duplicate fields and nonfinite json constants at source boundaries
def strict_json(value):
    # one key must never hide an earlier provenance or measurement value
    def unique_pairs(pairs):
        result = {}
        # reject every duplicate object member
        for key, item in pairs:
            # duplicate source keys are ambiguous rather than last-wins
            if key in result:
                raise AcquisitionError('duplicate json key')
            result[key] = item
        return result

    try:
        return json.loads(value, object_pairs_hook=unique_pairs, parse_constant=lambda item: (_ for _ in ()).throw(AcquisitionError('nonfinite json value')))
    except (UnicodeError, json.JSONDecodeError) as failure:
        raise AcquisitionError('invalid json') from failure


# hash exact bytes, including original newline and number representations
def sha256(value):
    return hashlib.sha256(value).hexdigest()


# avoid an eighty-three-megabyte in-memory source copy
def file_sha256(path):
    digest = hashlib.sha256()
    # consume only bounded file chunks
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


# persist one private artifact without replacing existing evidence
def write_new(path, body):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # flush a complete request or receipt before reporting a start
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


# snapshot a source file once under an exclusive private destination
def copy_new(source, destination):
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # copy bounded chunks without overwriting a prior frozen input
    with Path(source).open('rb') as incoming, os.fdopen(descriptor, 'wb') as outgoing:
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        outgoing.flush()
        os.fsync(outgoing.fileno())


# use an explicit utc clock for expiry and audit timestamps
def utc_now():
    return dt.datetime.now(dt.timezone.utc)


# serialize one unambiguous utc timestamp for every artifact
def utc_stamp():
    return utc_now().isoformat().replace('+00:00', 'Z')


# require one finite value or preserve an explicit source null
def cell(value, minimum, maximum):
    # a missing forecast remains missing, never a manufactured zero
    if value is None:
        return None
    # reject booleans and nonphysical forecast amounts or directions
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise AcquisitionError('invalid forecast cell')
    return float(value)


# bind the exact original manifest and successful run-specific grids
def original_manifest(path):
    body = Path(path).read_bytes()
    # the historical source manifest is an immutable non-label input
    if sha256(body) != ORIGINAL_MANIFEST_SHA256:
        raise AcquisitionError('original manifest hash changed')
    manifest = strict_json(body)
    # require an object before resolving any immutable cohort member
    if not isinstance(manifest, dict) or not isinstance(manifest.get('cohortFiles'), dict):
        raise AcquisitionError('original manifest contract changed')
    cohort = manifest['cohortFiles'].get('ecmwf_single_run_hindcast')
    # reject changed cohort, source path, site or successful-run shape
    if manifest.get('requestCoordinates') != SITE or not isinstance(cohort, dict) or cohort.get('path') != 'normalized/ecmwf_single_run_hindcast.jsonl' or cohort.get('sha256') != ORIGINAL_NORMALIZED_SHA256 or cohort.get('successfulRuns') != RUN_COUNT or cohort.get('rows') != RUN_COUNT * LEADS or manifest.get('statusCounts', {}).get('success') != RUN_COUNT:
        raise AcquisitionError('original manifest contract changed')
    producer_hashes = manifest.get('sourceSha256')
    # retain all three exact original acquisition producer identities
    if not isinstance(producer_hashes, dict) or set(producer_hashes) != set(ORIGINAL_PRODUCERS):
        raise AcquisitionError('original producer list changed')
    success = [item for item in manifest['identities'] if item.get('cohort') == 'ecmwf_single_run_hindcast' and item.get('status') == 'success']
    # bind each successful initialization and returned grid once
    if len(success) != RUN_COUNT:
        raise AcquisitionError('original successful-run count changed')
    runs, grids = [], {}
    # no failed or other-cohort run enters this supplement
    for item in success:
        run = item['runInitializedAt'].removesuffix(':00Z')
        grid = item.get('returnedGrid')
        # original per-run grid is the parity target, not target elevation
        if item.get('key') != f'ecmwf_single_run_hindcast|{run}' or not isinstance(grid, dict) or set(grid) != {'latitude', 'longitude'} or any(cell(grid[name], -90 if name == 'latitude' else -180, 90 if name == 'latitude' else 180) is None for name in grid) or run in grids:
            raise AcquisitionError('original run grid identity changed')
        runs.append(run)
        grids[run] = {'latitude': float(grid['latitude']), 'longitude': float(grid['longitude'])}
    # successful runs must remain complete chronological distinct keys
    if runs != sorted(set(runs)):
        raise AcquisitionError('original run ordering changed')
    return manifest, runs, grids


# bind every normalized original lead without touching observation labels
def original_profiles(path, manifest, runs):
    expected = manifest['cohortFiles']['ecmwf_single_run_hindcast']
    digest = hashlib.sha256()
    profiles = {}
    current, rainfall = None, []
    rows = 0
    with Path(path).open('rb') as stream:
        # read only the original forecast-only normalized cohort
        for line in stream:
            digest.update(line)
            item = strict_json(line)
            lead = len(rainfall) + 1
            # require a new contiguous original source run at lead one
            if not rainfall:
                current = item['runInitializedAt'].removesuffix(':00Z')
                # prohibit an extra, missing or reordered run block
                if len(profiles) >= len(runs) or current != runs[len(profiles)]:
                    raise AcquisitionError('original normalized run order changed')
            origin = dt.datetime.strptime(current, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
            valid = (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ')
            # every old source lead and valid hour must match its manifest key
            if item.get('cohort') != 'ecmwf_single_run_hindcast' or item.get('key') != f'ecmwf_single_run_hindcast|{current}|lead={lead}' or item.get('runInitializedAt') != current + ':00Z' or item.get('targetLeadHours') != lead or item.get('validAt') != valid or item.get('actualIssueAt') is not None:
                raise AcquisitionError('original normalized lead identity changed')
            rainfall.append(cell(item.get('rawPrecipitationMm'), 0., 2_000.))
            rows += 1
            # retain exactly forty-eight reference precipitation values
            if len(rainfall) == LEADS:
                profiles[current] = tuple(rainfall)
                rainfall = []
    # verify the complete byte and row identity before any request
    if rainfall or rows != expected['rows'] or rows != RUN_COUNT * LEADS or len(profiles) != RUN_COUNT or digest.hexdigest() != ORIGINAL_NORMALIZED_SHA256 or Path(path).stat().st_size != expected['bytes']:
        raise AcquisitionError('original normalized archive changed')
    return profiles


# accept only a complete chronological root-owned acquisition plan
def validate_plan(plan, expected_runs=None, now=None):
    now = utc_now() if now is None else now
    # exact caps and source pins forbid scope expansion or replay
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS or plan['contractVersion'] != CONTRACT or plan['endpoint'] != ENDPOINT or plan['site'] != SITE or plan['expiresAtUtc'] != EXPIRY or plan['originalSourceSha256'] != ORIGINAL_NORMALIZED_SHA256 or plan['originalManifestSha256'] != ORIGINAL_MANIFEST_SHA256 or type(plan['maximumHttpRequests']) is not int or plan['maximumHttpRequests'] != RUN_COUNT or type(plan['maximumLocationRequests']) is not int or plan['maximumLocationRequests'] != RUN_COUNT or type(plan['retries']) is not int or plan['retries'] != 0 or type(plan['minimumIntervalSeconds']) is not int or plan['minimumIntervalSeconds'] != 1 or type(plan['timeoutSeconds']) is not int or plan['timeoutSeconds'] != 30 or type(plan['maximumResponseBytes']) is not int or plan['maximumResponseBytes'] != 2_000_000:
        raise AcquisitionError('invalid direction acquisition plan')
    runs = plan['runs']
    # plan identities must be exact successful original run keys
    if not isinstance(runs, list) or len(runs) != RUN_COUNT or any(not isinstance(run, str) for run in runs) or runs != sorted(set(runs)) or (expected_runs is not None and runs != expected_runs):
        raise AcquisitionError('invalid direction acquisition run scope')
    pilot = [runs[position] for position in PILOT_POSITIONS]
    # six chronologically spread, distinct pilots are fixed before data
    if plan['pilotRuns'] != pilot or len(set(pilot)) != len(pilot):
        raise AcquisitionError('invalid direction pilot scope')
    # no request can start after the one fixed utc deadline
    if now >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise AcquisitionError('direction acquisition plan expired')
    return plan


# freeze copied source bytes, producer dependencies and complete run order
def prepare(root, plan_path, source_root):
    root = validate_private_root(root)
    plan_path = Path(plan_path)
    source_root = validate_private_root(source_root)
    # original input path and root-owned plan are immutable boundaries
    if source_root != ORIGINAL_ROOT or plan_path.parent.resolve() != root or plan_path.is_symlink() or not plan_path.is_file():
        raise AcquisitionError('invalid direction source or plan path')
    # no preparation output may replace existing attempts or snapshots
    if any((root / name).exists() or (root / name).is_symlink() for name in ('frozen-plan.json', 'direction-freeze.json', 'inputs', 'sources', 'requests', 'pilot-report.json', 'bulk-report.json', 'report.json', 'normalized')):
        raise AcquisitionError('direction acquisition already prepared')
    manifest_path = source_root / ORIGINAL_MANIFEST
    normalized_path = source_root / ORIGINAL_NORMALIZED
    manifest, runs, _ = original_manifest(manifest_path)
    # verify original producer bytes before copying the immutable inputs
    for name, expected in manifest['sourceSha256'].items():
        # a copied original dependency cannot drift from the old manifest
        if file_sha256(source_root / 'forecast-acquisition-sources' / name) != expected:
            raise AcquisitionError('original producer dependency changed')
    original_profiles(normalized_path, manifest, runs)
    plan_bytes = plan_path.read_bytes()
    # bound the complete 3301-key plan before strict parsing
    if not plan_bytes or len(plan_bytes) > 250_000:
        raise AcquisitionError('invalid direction plan byte size')
    plan = validate_plan(strict_json(plan_bytes), runs)
    inputs = root / 'inputs'
    inputs.mkdir(mode=0o700)
    producer_dir = inputs / 'original-producer-sources'
    producer_dir.mkdir(mode=0o700)
    copy_new(manifest_path, inputs / 'original-manifest.json')
    copy_new(normalized_path, inputs / 'original-normalized.jsonl')
    # retain each reviewed original producer without importing it
    for name in ORIGINAL_PRODUCERS:
        copy_new(source_root / 'forecast-acquisition-sources' / name, producer_dir / name)
    # copied source bytes must still match the original provenance contract
    if file_sha256(inputs / 'original-manifest.json') != ORIGINAL_MANIFEST_SHA256 or file_sha256(inputs / 'original-normalized.jsonl') != ORIGINAL_NORMALIZED_SHA256 or any(file_sha256(producer_dir / name) != manifest['sourceSha256'][name] for name in ORIGINAL_PRODUCERS):
        raise AcquisitionError('direction input snapshot changed')
    write_new(root / 'frozen-plan.json', plan_bytes)
    sources = root / 'sources'
    sources.mkdir(mode=0o700)
    hashes = {}
    # freeze this producer and its private-root validation dependency
    for name in SOURCE_FILES:
        body = Path(__file__).with_name(name).read_bytes()
        write_new(sources / name, body)
        hashes[name] = sha256(body)
    freeze = {'contractVersion': CONTRACT, 'endpoint': ENDPOINT, 'planSha256': sha256(plan_bytes), 'runsSha256': sha256(canonical_json(runs)), 'pilotRuns': plan['pilotRuns'], 'sourceSha256': hashes, 'originalProducerSha256': manifest['sourceSha256'], 'originalManifestSha256': ORIGINAL_MANIFEST_SHA256, 'originalNormalizedSha256': ORIGINAL_NORMALIZED_SHA256, 'originalManifestPath': ORIGINAL_MANIFEST, 'originalNormalizedPath': ORIGINAL_NORMALIZED, 'originalRoot': str(source_root), 'inputBytes': {'manifest': (inputs / 'original-manifest.json').stat().st_size, 'normalized': (inputs / 'original-normalized.jsonl').stat().st_size}, 'inputMtimeNs': {'manifest': (inputs / 'original-manifest.json').stat().st_mtime_ns, 'normalized': (inputs / 'original-normalized.jsonl').stat().st_mtime_ns}, 'maximumHttpRequests': RUN_COUNT, 'maximumLocationRequests': RUN_COUNT, 'preparedAtUtc': utc_stamp(), 'actualIssueAt': None, 'labelsRead': False, 'productionWrites': False}
    write_new(root / 'direction-freeze.json', canonical_json(freeze))
    return freeze


# check small frozen files every request and large source bytes per phase
def validate_freeze(root, full_inputs=False, check_expiry=True):
    root = validate_private_root(root)
    freeze = strict_json((root / 'direction-freeze.json').read_bytes())
    plan_bytes = (root / 'frozen-plan.json').read_bytes()
    # bind the complete plan and original source path to this run
    if not isinstance(freeze, dict) or freeze.get('contractVersion') != CONTRACT or freeze.get('endpoint') != ENDPOINT or freeze.get('planSha256') != sha256(plan_bytes) or freeze.get('originalManifestSha256') != ORIGINAL_MANIFEST_SHA256 or freeze.get('originalNormalizedSha256') != ORIGINAL_NORMALIZED_SHA256 or freeze.get('originalManifestPath') != ORIGINAL_MANIFEST or freeze.get('originalNormalizedPath') != ORIGINAL_NORMALIZED or freeze.get('originalRoot') != str(ORIGINAL_ROOT) or freeze.get('maximumHttpRequests') != RUN_COUNT or freeze.get('maximumLocationRequests') != RUN_COUNT or freeze.get('actualIssueAt') is not None or freeze.get('labelsRead') is not False or freeze.get('productionWrites') is not False or set(freeze.get('sourceSha256', {})) != set(SOURCE_FILES) or set(freeze.get('originalProducerSha256', {})) != set(ORIGINAL_PRODUCERS):
        raise AcquisitionError('direction source freeze changed')
    # current and retained producer bytes must match their frozen digests
    for name, expected in freeze['sourceSha256'].items():
        if file_sha256(Path(__file__).with_name(name)) != expected or file_sha256(root / 'sources' / name) != expected:
            raise AcquisitionError('direction producer changed')
    # old acquisition dependencies remain pinned without importing old code
    for name, expected in freeze['originalProducerSha256'].items():
        if file_sha256(root / 'inputs/original-producer-sources' / name) != expected:
            raise AcquisitionError('original direction dependency changed')
    for key, filename in (('manifest', 'original-manifest.json'), ('normalized', 'original-normalized.jsonl')):
        path = root / 'inputs' / filename
        # cheap metadata guard runs per request; full hash runs at phase edges
        if path.stat().st_size != freeze['inputBytes'][key] or path.stat().st_mtime_ns != freeze['inputMtimeNs'][key]:
            raise AcquisitionError('direction source input metadata changed')
    # only a phase boundary rehashes the eighty-three-megabyte source
    if full_inputs and (file_sha256(root / 'inputs/original-manifest.json') != ORIGINAL_MANIFEST_SHA256 or file_sha256(root / 'inputs/original-normalized.jsonl') != ORIGINAL_NORMALIZED_SHA256):
        raise AcquisitionError('direction source input bytes changed')
    plan = strict_json(plan_bytes)
    # current plan hash binds all 3301 keys; parse scope at phase boundaries
    if full_inputs:
        # plan scope persists after the last authorized request start
        checked_at = utc_now() if check_expiry else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        validate_plan(plan, now=checked_at)
        if freeze['runsSha256'] != sha256(canonical_json(plan['runs'])) or freeze['pilotRuns'] != plan['pilotRuns']:
            raise AcquisitionError('direction frozen run list changed')
    # the fixed deadline is checked before every individual network start
    if check_expiry and utc_now() >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise AcquisitionError('direction acquisition plan expired')
    return root, plan, freeze


# request only two forecast fields at the original land-selected site
def request_parameters(run):
    return [('latitude', repr(SITE['latitude'])), ('longitude', repr(SITE['longitude'])), ('run', run), ('models', 'ecmwf_ifs'), ('hourly', 'precipitation,wind_direction_10m'), ('forecast_hours', '49'), ('timezone', 'GMT'), ('temperature_unit', 'celsius'), ('wind_speed_unit', 'ms'), ('precipitation_unit', 'mm'), ('timeformat', 'iso8601')]


# make one no-redirect bounded public GET with no credential or retry path
def fetch(url, timeout, maximum_bytes):
    opener = request.build_opener(NoRedirect())
    outgoing = request.Request(url, method='GET', headers={'Accept': 'application/json'})
    try:
        with opener.open(outgoing, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read(maximum_bytes + 1)
    except error.HTTPError as failure:
        # retain a bounded non-200 response without trying another URL
        with failure:
            return failure.code, dict(failure.headers.items()), failure.read(maximum_bytes + 1)


# require full source identity and exact precipitation/grid parity
def validate_response(body, run, original):
    item = strict_json(body)
    # one requested coordinate must yield exactly one response object
    if not isinstance(item, dict) or ('location_id' in item and (type(item['location_id']) is not int or item['location_id'] != 0)) or item.get('timezone') != 'GMT' or type(item.get('utc_offset_seconds')) is not int or item['utc_offset_seconds'] != 0 or item.get('hourly_units') != UNITS:
        raise AcquisitionError('direction response identity or units changed')
    grid = {name: cell(item.get(name), -90 if name == 'latitude' else -180, 90 if name == 'latitude' else 180) for name in ('latitude', 'longitude')}
    elevation = cell(item.get('elevation'), -1_000., 10_000.)
    # grid parity is per original run; elevation remains target metadata
    if None in grid.values() or elevation is None or grid != original['grid']:
        raise AcquisitionError('direction response grid parity changed')
    hourly = item.get('hourly')
    # require all forty-nine timestamps and both exact requested variables
    if not isinstance(hourly, dict) or set(hourly) != {'time', 'precipitation', 'wind_direction_10m'} or any(not isinstance(hourly.get(name), list) or len(hourly[name]) != LEADS + 1 for name in ('time', 'precipitation', 'wind_direction_10m')):
        raise AcquisitionError('direction response hourly schema changed')
    origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
    # no shifted or missing valid hour may enter the supplement
    for lead, timestamp in enumerate(hourly['time']):
        if timestamp != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'):
            raise AcquisitionError('direction response run-hour identity changed')
    rain = tuple(cell(value, 0., 2_000.) for value in hourly['precipitation'])
    direction = tuple(cell(value, 0., 360.) for value in hourly['wind_direction_10m'])
    # each of the old forty-eight forecast leads must match exactly
    if rain[1:] != original['rain']:
        raise AcquisitionError('direction response precipitation parity changed')
    footprint = sum(value is not None for value in direction[6:35])
    summary = {'run': run, 'returnedGrid': grid, 'targetElevationM': elevation, 'precipitationParity': True, 'precipitationNullRows': sum(value is None for value in rain), 'directionNullRows': sum(value is None for value in direction), 'directionNullSelectedLeads': sum(value is None for value in direction[1:]), 'directionFootprintNonNullHours': footprint, 'directionFootprintComplete': footprint == 29, 'actualIssueAt': None}
    return summary, rain, direction


# report exact pilot sources without treating null direction as zero
def pilot_raw_hashes(root):
    result = {}
    # all six pilot request bodies are explicit gate inputs
    for index in range(len(PILOT_POSITIONS)):
        name = f'requests/{index:04d}/response-body.bin'
        result[name] = file_sha256(root / name)
    return result


# require an independent verifier before any bulk request starts
def verify_pilot_gate(root, receipt_path, plan, freeze, originals):
    receipt_path = Path(receipt_path)
    # receipt must be written inside the same owned private root
    if receipt_path.parent.resolve() != root or receipt_path.is_symlink() or not receipt_path.is_file():
        raise AcquisitionError('invalid pilot verification receipt path')
    receipt = strict_json(receipt_path.read_bytes())
    verifier = Path(__file__).with_name('verify_rain_direction_source.py')
    # no self-attested pilot result authorizes the full call set
    if not isinstance(receipt, dict) or set(receipt) != PILOT_RECEIPT_KEYS or receipt['contractVersion'] != PILOT_RECEIPT_CONTRACT or receipt['verdict'] != 'PASS' or receipt['bulkEligible'] is not True or receipt['planSha256'] != freeze['planSha256'] or receipt['freezeSha256'] != file_sha256(root / 'direction-freeze.json') or receipt['pilotReportSha256'] != file_sha256(root / 'pilot-report.json') or receipt['pilotRawBodySha256'] != pilot_raw_hashes(root) or not verifier.is_file() or receipt['verifierSourceSha256'] != file_sha256(verifier):
        raise AcquisitionError('pilot verification did not authorize bulk')
    # independent proof must follow the retained pilot responses in utc
    try:
        verified = dt.datetime.fromisoformat(receipt['verifiedAtUtc'].replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError) as problem:
        raise AcquisitionError('invalid pilot verification time') from problem
    # reject stale, future-dated or non-utc pilot authorization
    if verified.utcoffset() != dt.timedelta(0) or verified > utc_now() or verified >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise AcquisitionError('invalid pilot verification time')
    pilot_report = strict_json((root / 'pilot-report.json').read_bytes())
    # pilot must have six successful immutable one-shot request receipts
    if pilot_report.get('status') != 'complete' or pilot_report.get('attemptedHttpRequests') != len(PILOT_POSITIONS) or pilot_report.get('bulkEligible') is not True:
        raise AcquisitionError('pilot report did not establish bulk eligibility')
    # verify footprint eligibility against each retained raw response again
    for index, run in enumerate(plan['pilotRuns']):
        request_state = strict_json((root / f'requests/{index:04d}/request.json').read_bytes())
        result = strict_json((root / f'requests/{index:04d}/receipt.json').read_bytes())
        body = (root / f'requests/{index:04d}/response-body.bin').read_bytes()
        summary, _, _ = validate_response(body, run, originals[run])
        # reject incorrect run/index mapping or a sparse feature footprint
        if request_state.get('run') != run or request_state.get('requestIndex') != index or result.get('result') != 'success' or result.get('contentSha256') != sha256(body) or not summary['directionFootprintComplete']:
            raise AcquisitionError('pilot source footprint is incomplete')
        # a verification receipt cannot predate its own raw response
        received = dt.datetime.fromisoformat(result['responseReceivedAtUtc'].replace('Z', '+00:00'))
        if verified < received:
            raise AcquisitionError('pilot proof predates retained response')
    return receipt


# collect one phase with durable one-shot receipts and no fallback source
def run_phase(root, phase, gate_path=None):
    root = validate_private_root(root)
    # pilot and bulk each receive one terminal report, never a retry
    if phase not in ('pilot', 'bulk') or (root / f'{phase}-report.json').exists() or (root / 'report.json').exists():
        raise AcquisitionError('direction phase already attempted')
    requests = root / 'requests'
    # bulk requires a finished pilot and no preexisting bulk request
    if phase == 'pilot' and requests.exists() or phase == 'bulk' and (not requests.is_dir() or not (root / 'pilot-report.json').is_file() or any((requests / f'{index:04d}').exists() for index in range(len(PILOT_POSITIONS), RUN_COUNT))):
        raise AcquisitionError('direction phase request state changed')
    root, plan, freeze = validate_freeze(root, full_inputs=False)
    manifest, runs, grids = original_manifest(root / 'inputs/original-manifest.json')
    rainfall = original_profiles(root / 'inputs/original-normalized.jsonl', manifest, runs)
    # copied source runs must equal the frozen full list before any call
    if runs != plan['runs']:
        raise AcquisitionError('direction plan does not match old source runs')
    originals = {run: {'grid': grids[run], 'rain': rainfall[run]} for run in runs}
    gate = None
    # a separately reviewed six-body pilot result gates the bulk phase
    if phase == 'bulk':
        gate = verify_pilot_gate(root, gate_path, plan, freeze, originals)
    else:
        # source and scope preflight must finish before opening attempts
        requests.mkdir(mode=0o700)
    pilot_set = set(plan['pilotRuns'])
    assignments = [(position, plan['runs'][position]) for position in PILOT_POSITIONS] if phase == 'pilot' else [(position, run) for position, run in enumerate(plan['runs']) if run not in pilot_set]
    first_index = 0 if phase == 'pilot' else len(PILOT_POSITIONS)
    attempted, receipts, summaries, failure = 0, [], [], None
    previous_start = None
    # retain the global one-second start spacing across the phase boundary
    if phase == 'bulk':
        previous = strict_json((requests / '0005/request.json').read_bytes())['startedAtUtc']
        previous_start = dt.datetime.fromisoformat(previous)
    # stop forever at the first transport, parity or expiry failure
    for offset, (run_index, run) in enumerate(assignments):
        index = first_index + offset
        receipt = None
        request_state = None
        status = None
        received = None
        safe_headers = {}
        try:
            # no source-changing file or expired plan can initiate another GET
            validate_freeze(root, full_inputs=False)
            # honor the prior start in either monotonic or retained utc time
            if previous_start is not None:
                elapsed = time.monotonic() - previous_start if isinstance(previous_start, float) else (utc_now() - previous_start).total_seconds()
                time.sleep(max(0., plan['minimumIntervalSeconds'] - elapsed))
            validate_freeze(root, full_inputs=False)
            parameters = request_parameters(run)
            url = ENDPOINT + '?' + parse.urlencode(parameters)
            directory = requests / f'{index:04d}'
            directory.mkdir(mode=0o700)
            started = utc_stamp()
            previous_start = time.monotonic()
            request_state = {'phase': phase, 'requestIndex': index, 'runIndex': run_index, 'run': run, 'endpoint': ENDPOINT, 'canonicalParams': parameters, 'paramsSha256': sha256(canonical_json(parameters)), 'urlSha256': sha256(url.encode()), 'startedAtUtc': started, 'actualIssueAt': None}
            write_new(directory / 'request.json', canonical_json(request_state))
            attempted += 1
            status, headers, body = fetch(url, plan['timeoutSeconds'], plan['maximumResponseBytes'])
            received = utc_stamp()
            safe_headers = {name.lower(): str(value)[:256] for name, value in headers.items() if name.lower() in SAFE_HEADERS}
            captured = body[:plan['maximumResponseBytes']]
            complete = len(body) <= plan['maximumResponseBytes']
            # retain a bounded body, including explicit zero-byte failures
            write_new(directory / 'response-body.bin', captured)
            receipt = {**request_state, 'responseReceivedAtUtc': received, 'status': int(status), 'safeHeaders': safe_headers, 'responseBytesObserved': len(body), 'responseBytesStored': len(captured), 'bodyComplete': complete, 'contentSha256': sha256(body) if complete else None, 'capturedSha256': sha256(captured), 'rawBodyFile': 'response-body.bin', 'result': 'failed', 'error': None, 'summary': None}
            # no truncated, empty or non-200 response can enter the supplement
            if not complete or not body or status != 200:
                raise AcquisitionError('direction response empty, oversized or non-200')
            summary, _, _ = validate_response(body, run, originals[run])
            receipt.update({'result': 'success', 'summary': summary})
            write_new(directory / 'receipt.json', canonical_json(receipt))
            receipts.append(receipt)
            summaries.append(summary)
        except (OSError, ValueError, TypeError, KeyError, error.URLError) as problem:
            # preserve the first failure and never request the next run
            failure = {'phase': phase, 'requestIndex': index, 'runIndex': run_index, 'run': run, 'errorType': type(problem).__name__, 'error': str(problem)}
            if receipt is None:
                receipt = {**(request_state or {'phase': phase, 'requestIndex': index, 'runIndex': run_index, 'run': run, 'actualIssueAt': None}), 'result': 'failed', 'error': str(problem), 'status': status, 'responseReceivedAtUtc': received, 'safeHeaders': safe_headers, 'contentSha256': None, 'rawBodyFile': None, 'summary': None}
            else:
                receipt['error'] = str(problem)
            directory = requests / f'{index:04d}'
            directory.mkdir(mode=0o700, exist_ok=True)
            write_new(directory / 'receipt.json', canonical_json(receipt))
            receipts.append(receipt)
            break
    # final source replay and normalization must finish before success is reported
    if not failure:
        try:
            # completion may occur after expiry if every GET started before it
            validate_freeze(root, full_inputs=True, check_expiry=False)
            # a complete bulk writes the forecast-only supplement once
            if phase == 'bulk':
                normalize_all(root, plan, originals)
        except (OSError, ValueError, TypeError, KeyError) as problem:
            failure = {'phase': phase, 'requestIndex': None, 'runIndex': None, 'run': None, 'errorType': type(problem).__name__, 'error': str(problem)}
    report = {'contractVersion': CONTRACT, 'phase': phase, 'status': 'failed' if failure else 'complete', 'planSha256': freeze['planSha256'], 'freezeSha256': file_sha256(root / 'direction-freeze.json'), 'pilotVerificationSha256': file_sha256(gate_path) if gate else None, 'plannedHttpRequests': len(assignments), 'attemptedHttpRequests': attempted, 'successfulHttpRequests': len(summaries), 'attemptedLocationRequests': attempted, 'receipts': [{'requestIndex': item['requestIndex'], 'runIndex': item['runIndex'], 'run': item['run'], 'result': item['result'], 'status': item['status'], 'contentSha256': item['contentSha256']} for item in receipts], 'runSummaries': summaries, 'bulkEligible': all(item['directionFootprintComplete'] for item in summaries) if phase == 'pilot' and not failure else None, 'failure': failure, 'actualIssueAt': None, 'labelsRead': False, 'modelPerformanceScored': False, 'productionWrites': False}
    # even a failure is a terminal immutable phase artifact
    write_new(root / f'{phase}-report.json', canonical_json(report))
    # stop with nonzero status after retaining all available evidence
    if failure:
        raise AcquisitionError(f"direction {phase} stopped: {failure['error']}")
    # only a completed bulk may publish a final source manifest
    if phase == 'bulk':
        normalized = root / NORMALIZED_PATH
        final = {**report, 'phase': 'complete', 'pilotReportSha256': file_sha256(root / 'pilot-report.json'), 'bulkReportSha256': file_sha256(root / 'bulk-report.json'), 'totalAttemptedHttpRequests': len(PILOT_POSITIONS) + attempted, 'totalAttemptedLocationRequests': len(PILOT_POSITIONS) + attempted, 'normalizedFile': NORMALIZED_PATH, 'normalizedRows': RUN_COUNT * LEADS, 'normalizedSha256': file_sha256(normalized), 'verifierSourceSha256': gate['verifierSourceSha256']}
        write_new(root / 'report.json', canonical_json(final))
        return final
    return report


# write forecast-only lead rows only after every request has succeeded
def normalize_all(root, plan, originals):
    directory = root / 'normalized'
    directory.mkdir(mode=0o700)
    destination = root / NORMALIZED_PATH
    # never overwrite or merge the original precipitation archive
    if destination.exists() or destination.is_symlink():
        raise AcquisitionError('direction normalized supplement already exists')
    temporary = directory / '.ecmwf_single_run_wind_direction.partial'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    pilot_set = set(plan['pilotRuns'])
    request_indices = {run: index for index, run in enumerate(plan['pilotRuns'])}
    next_bulk_index = len(PILOT_POSITIONS)
    # the saved request order differs from the required chronological row order
    for run in plan['runs']:
        if run not in pilot_set:
            request_indices[run] = next_bulk_index
            next_bulk_index += 1
    try:
        with os.fdopen(descriptor, 'wb') as output:
            # produce one exact forty-eight-lead block for every original run
            for run_index, run in enumerate(plan['runs']):
                index = request_indices[run]
                request_state = strict_json((root / f'requests/{index:04d}/request.json').read_bytes())
                receipt = strict_json((root / f'requests/{index:04d}/receipt.json').read_bytes())
                body = (root / f'requests/{index:04d}/response-body.bin').read_bytes()
                summary, rain, direction = validate_response(body, run, originals[run])
                # bind every saved request to its original chronology and body
                if request_state.get('runIndex') != run_index or request_state.get('run') != run or receipt.get('result') != 'success' or receipt.get('contentSha256') != sha256(body) or receipt.get('summary') != summary:
                    raise AcquisitionError('direction saved request identity changed')
                origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
                # preserve original lead order and nullable direction values
                for lead in range(1, LEADS + 1):
                    row = {'cohort': 'ecmwf_single_run_hindcast', 'key': f'ecmwf_single_run_hindcast|{run}|lead={lead}', 'runInitializedAt': run + ':00Z', 'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': rain[lead], 'rawWindDirectionDegrees': direction[lead], 'returnedGrid': summary['returnedGrid'], 'responseSha256': sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'actualIssueAt': None}
                    output.write(canonical_json(row))
            output.flush()
            os.fsync(output.fileno())
        # an exclusive link publishes only the fully fsynced source file
        os.link(temporary, destination)
        temporary.unlink()
    except (OSError, ValueError, TypeError, KeyError):
        # a failed final replay never exposes a partial normalized archive
        temporary.unlink(missing_ok=True)
        raise


# retain one-shot pilot and independently gated bulk as separate commands
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--plan', type=Path, required=True)
    preparation.add_argument('--source', type=Path, required=True)
    pilot = commands.add_parser('pilot')
    pilot.add_argument('root', type=Path)
    bulk = commands.add_parser('bulk')
    bulk.add_argument('root', type=Path)
    bulk.add_argument('--pilot-receipt', type=Path, required=True)
    arguments = parser.parse_args()
    result = prepare(arguments.root, arguments.plan, arguments.source) if arguments.command == 'prepare' else run_phase(arguments.root, 'pilot' if arguments.command == 'pilot' else 'bulk', getattr(arguments, 'pilot_receipt', None))
    print(json.dumps(result, sort_keys=True), flush=True)
