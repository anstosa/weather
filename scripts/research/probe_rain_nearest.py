"""probe land and nearest archived forecast geometry without labels."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import time
from pathlib import Path
from urllib import error, parse, request

from retain_moisture_research import validate_private_root

CONTRACT = 'rain-nearest-probe/v1'
ENDPOINT = 'https://single-runs-api.open-meteo.com/v1/forecast'
RUNS = ('2026-05-12T00:00', '2026-05-12T06:00')
CELL_SELECTIONS = ('land', 'nearest')
PAIRS = tuple((selection, run) for selection in CELL_SELECTIONS for run in RUNS)
LOCATIONS = (
    {'id': 'tempest-225947', 'latitude': 47.94215, 'longitude': -122.42542},
    {'id': 'tempest-38270', 'latitude': 47.95293, 'longitude': -122.41414},
    {'id': 'tempest-126537', 'latitude': 47.9582, 'longitude': -122.44274},
)
EXPIRY = '2026-09-13T08:00:00Z'
PLAN_KEYS = frozenset(('contractVersion', 'locations', 'runs', 'cellSelections', 'expiresAtUtc', 'maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes'))
SOURCE_FILES = ('probe_rain_nearest.py', 'retain_moisture_research.py')
VARIABLES = ('precipitation', 'wind_direction_10m')
UNITS = {'time': 'iso8601', 'precipitation': 'mm', 'wind_direction_10m': '°'}
SAFE_HEADERS = frozenset(('content-type', 'date', 'etag', 'last-modified'))


class ProbeError(ValueError):
    """mark a stopped and retained public-source probe."""


# deny urllib's otherwise automatic cross-host redirect following
class NoRedirect(request.HTTPRedirectHandler):
    # a redirect would change the frozen public endpoint
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProbeError('redirect refused')


# encode stable strict json for private manifests and receipts
def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


# parse json without accepting nonfinite constants or duplicate object keys
def strict_json(value):
    # duplicate keys could conceal changed plan or response fields
    def unique_pairs(pairs):
        result = {}
        # bind each key to exactly one value
        for key, item in pairs:
            # reject ambiguous repeated identity or measurement fields
            if key in result:
                raise ProbeError('duplicate json key')
            result[key] = item
        return result

    try:
        return json.loads(value, parse_constant=lambda item: (_ for _ in ()).throw(ProbeError('nonfinite json value')), object_pairs_hook=unique_pairs)
    except (UnicodeError, json.JSONDecodeError) as failure:
        raise ProbeError('invalid json') from failure


# hash exact bytes rather than a decoded or rewritten representation
def sha256(value):
    return hashlib.sha256(value).hexdigest()


# create a private artifact once without following or replacing a file
def write_new(path, body):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # complete the entire receipt before exposing success to the caller
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


# keep expiration meaningful in both prepare and each request gate
def utc_now():
    return dt.datetime.now(dt.timezone.utc)


# require one bounded immutable plan and its three ordered locations
def validate_plan(plan, now=None):
    now = utc_now() if now is None else now
    # do not accept silently added parameters, locations or retries
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS or plan['contractVersion'] != CONTRACT or plan['runs'] != list(RUNS) or plan['cellSelections'] != list(CELL_SELECTIONS) or type(plan['maximumHttpRequests']) is not int or plan['maximumHttpRequests'] != 4 or type(plan['maximumLocationRequests']) is not int or plan['maximumLocationRequests'] != 12 or type(plan['retries']) is not int or plan['retries'] != 0 or type(plan['minimumIntervalSeconds']) is not int or plan['minimumIntervalSeconds'] != 2 or type(plan['timeoutSeconds']) is not int or plan['timeoutSeconds'] != 30 or type(plan['maximumResponseBytes']) is not int or plan['maximumResponseBytes'] != 2_000_000:
        raise ProbeError('invalid nearest probe plan caps or schema')
    locations = plan['locations']
    # the same three sites must occur under both fixed selection policies
    if not isinstance(locations, list) or locations != list(LOCATIONS):
        raise ProbeError('invalid nearest probe locations')
    identities, coordinates = set(), set()
    # bind every ordered location to finite geographic coordinates
    for location in locations:
        # forbid additional provider inputs or unsafe identity strings
        if not isinstance(location, dict) or set(location) != {'id', 'latitude', 'longitude'} or not isinstance(location['id'], str) or not location['id'] or len(location['id']) > 48 or any(character not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for character in location['id']):
            raise ProbeError('invalid nearest probe location identity')
        latitude, longitude = location['latitude'], location['longitude']
        # reject booleans, nonfinite coordinates and impossible earth positions
        if type(latitude) not in (int, float) or type(longitude) not in (int, float) or not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            raise ProbeError('invalid nearest probe coordinates')
        pair = (float(latitude), float(longitude))
        # duplicate sites cannot establish independent spatial coverage
        if location['id'] in identities or pair in coordinates:
            raise ProbeError('duplicate nearest probe location')
        identities.add(location['id'])
        coordinates.add(pair)
    expires = plan['expiresAtUtc']
    # require an exact utc expiration, not a local or malformed date
    if expires != EXPIRY:
        raise ProbeError('invalid nearest probe expiration')
    try:
        expiration = dt.datetime.fromisoformat(expires.replace('Z', '+00:00'))
    except ValueError as failure:
        raise ProbeError('invalid nearest probe expiration') from failure
    # a stale authorization envelope cannot initiate any HTTP request
    if expiration.tzinfo != dt.timezone.utc or expiration <= now:
        raise ProbeError('nearest probe plan expired')
    return plan


# snapshot plan and producer dependencies before any network access
def prepare(root, plan_path):
    root = validate_private_root(root)
    plan_path = Path(plan_path)
    # source plan must already live inside the owned private root
    if plan_path.parent.resolve() != root or plan_path.is_symlink() or not plan_path.is_file():
        raise ProbeError('nearest probe plan is not an owned private file')
    # preparation is one-shot and never reuses a prior request directory
    if any((root / name).exists() or (root / name).is_symlink() for name in ('probe-plan.json', 'probe-sources', 'probe-freeze.json', 'requests', 'report.json')):
        raise ProbeError('nearest probe already prepared')
    source_plan = plan_path.read_bytes()
    # keep plan decoding bounded before allocating its parsed structure
    if not source_plan or len(source_plan) > 16_384:
        raise ProbeError('invalid nearest probe plan byte size')
    plan = validate_plan(strict_json(source_plan))
    write_new(root / 'probe-plan.json', source_plan)
    directory = root / 'probe-sources'
    directory.mkdir(mode=0o700)
    hashes = {}
    # freeze only this producer and the private-root authority helper
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        body = source.read_bytes()
        write_new(directory / name, body)
        hashes[name] = sha256(body)
    freeze = {'contractVersion': CONTRACT, 'endpoint': ENDPOINT, 'planSha256': sha256(source_plan), 'sourceSha256': hashes, 'preparedAtUtc': utc_now().isoformat(), 'actualIssueAt': None, 'historicalAsIssuedClaim': False, 'labelsRead': False, 'cellSelections': list(CELL_SELECTIONS), 'maximumHttpRequests': plan['maximumHttpRequests'], 'maximumLocationRequests': plan['maximumLocationRequests']}
    write_new(root / 'probe-freeze.json', canonical_json(freeze))
    return freeze


# rebind original source and frozen bytes before each planned request
def validate_freeze(root):
    root = validate_private_root(root)
    freeze = strict_json((root / 'probe-freeze.json').read_bytes())
    plan_bytes = (root / 'probe-plan.json').read_bytes()
    # reject changed request scope or source-snapshot identity
    if not isinstance(freeze, dict) or freeze.get('contractVersion') != CONTRACT or freeze.get('endpoint') != ENDPOINT or freeze.get('planSha256') != sha256(plan_bytes) or set(freeze.get('sourceSha256', {})) != set(SOURCE_FILES) or freeze.get('actualIssueAt') is not None or freeze.get('historicalAsIssuedClaim') is not False or freeze.get('labelsRead') is not False or freeze.get('maximumHttpRequests') != 4 or freeze.get('maximumLocationRequests') != 12 or freeze.get('cellSelections') != list(CELL_SELECTIONS):
        raise ProbeError('nearest probe freeze changed')
    # each dependency must match both the retained and currently executing code
    for name, expected in freeze['sourceSha256'].items():
        if sha256(Path(__file__).with_name(name).read_bytes()) != expected or sha256((root / 'probe-sources' / name).read_bytes()) != expected:
            raise ProbeError('nearest probe source changed')
    plan = validate_plan(strict_json(plan_bytes))
    return root, plan, freeze


# encode exactly one three-location public no-auth query
def request_parameters(plan, selection, run):
    # only the four frozen selection and initialization pairs are allowed
    if (selection, run) not in PAIRS:
        raise ProbeError('unplanned nearest probe selection or run')
    locations = plan['locations']
    return [
        ('latitude', ','.join(repr(float(site['latitude'])) for site in locations)),
        ('longitude', ','.join(repr(float(site['longitude'])) for site in locations)),
        ('run', run), ('models', 'ecmwf_ifs'),
        ('cell_selection', selection),
        ('hourly', ','.join(VARIABLES)), ('forecast_hours', '49'),
        ('timezone', 'GMT'), ('temperature_unit', 'celsius'),
        ('wind_speed_unit', 'ms'), ('precipitation_unit', 'mm'),
        ('timeformat', 'iso8601'),
    ]


# make one no-redirect bounded GET without any retry or credentials
def fetch(url, timeout, maximum_bytes):
    opener = request.build_opener(NoRedirect())
    outgoing = request.Request(url, method='GET', headers={'Accept': 'application/json'})
    try:
        with opener.open(outgoing, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read(maximum_bytes + 1)
    except error.HTTPError as failure:
        # retain bounded non-200 response evidence without a retry
        with failure:
            return failure.code, dict(failure.headers.items()), failure.read(maximum_bytes + 1)


# accept nullable physical cells without silently replacing absence with zero
def _cell(value, minimum, maximum):
    # source nulls are distinct from a measured zero
    if value is None:
        return None
    # reject boolean, nonfinite and out-of-domain provider values
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ProbeError('invalid nearest probe measurement')
    return float(value)


# validate one exact three-location 49-hour provider response
def validate_response(body, selection, run, locations):
    # bind response interpretation to one frozen selection mode
    if (selection, run) not in PAIRS:
        raise ProbeError('unplanned nearest probe response identity')
    response = strict_json(body)
    # a batched request must retain all three positional locations
    if not isinstance(response, list) or len(response) != len(locations):
        raise ProbeError('partial nearest probe response')
    origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
    identified = {}
    # upstream json omits location_id only for the default zero location
    for response_index, item in enumerate(response):
        location_id = item.get('location_id', 0) if isinstance(item, dict) else None
        # reject null, boolean, duplicate and out-of-budget location identities
        if type(location_id) is not int or location_id not in range(len(locations)) or location_id in identified:
            raise ProbeError('nearest probe location identity changed')
        identified[location_id] = (response_index, item)
    # all requested zero-based identities must be present exactly once
    if set(identified) != set(range(len(locations))):
        raise ProbeError('partial nearest probe location identities')
    summaries, grids, precipitation_profiles, direction_profiles, joint_profiles = [], set(), set(), set(), set()
    # attribute each returned grid by its proven provider location id
    for index, site in enumerate(locations):
        response_index, item = identified[index]
        # retained timezone and units must match the exact public query
        if item.get('timezone') != 'GMT' or type(item.get('utc_offset_seconds')) is not int or item['utc_offset_seconds'] != 0 or item.get('hourly_units') != UNITS:
            raise ProbeError('nearest probe response identity or units changed')
        grid = tuple(_cell(item.get(name), -90 if name == 'latitude' else -180 if name == 'longitude' else -math.inf, 90 if name == 'latitude' else 180 if name == 'longitude' else math.inf) for name in ('latitude', 'longitude', 'elevation'))
        # grid coordinates and target elevation must be present and finite
        if any(value is None for value in grid):
            raise ProbeError('nearest probe grid is missing')
        hourly = item.get('hourly')
        # only the requested variables and timestamp vector are in scope
        if not isinstance(hourly, dict) or set(hourly) != {'time', *VARIABLES} or any(not isinstance(hourly.get(name), list) or len(hourly[name]) != 49 for name in ('time', *VARIABLES)):
            raise ProbeError('nearest probe hourly schema changed')
        # all output times must be exactly run initialization plus lead zero to 48
        for lead, timestamp in enumerate(hourly['time']):
            if timestamp != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'):
                raise ProbeError('nearest probe run-hour identity changed')
        rain = tuple(_cell(value, 0., math.inf) for value in hourly['precipitation'])
        direction = tuple(_cell(value, 0., 360.) for value in hourly['wind_direction_10m'])
        grids.add(grid[:2])
        precipitation_profiles.add(rain)
        direction_profiles.add(direction)
        joint_profiles.add((rain, direction))
        summaries.append({'id': site['id'], 'locationId': index, 'locationIdSource': 'implicit_default_zero' if 'location_id' not in item else 'explicit', 'responseIndex': response_index, 'requestedCoordinates': {'latitude': site['latitude'], 'longitude': site['longitude']}, 'returnedGrid': {'latitude': grid[0], 'longitude': grid[1]}, 'targetElevationM': grid[2], 'nonnullPrecipitationRows': sum(value is not None for value in rain), 'nonnullWindDirectionRows': sum(value is not None for value in direction), 'nullPrecipitationRows': sum(value is None for value in rain), 'nullWindDirectionRows': sum(value is None for value in direction), 'actualIssueAt': None})
    return {'cellSelection': selection, 'run': run, 'mappingBasis': 'provider_location_id_with_implicit_default_zero', 'locations': summaries, 'uniqueReturnedGrids': len(grids), 'uniquePrecipitationProfiles': len(precipitation_profiles), 'uniqueWindDirectionProfiles': len(direction_profiles), 'uniqueJointProfiles': len(joint_profiles), 'nonnullPrecipitationRows': sum(item['nonnullPrecipitationRows'] for item in summaries), 'nonnullWindDirectionRows': sum(item['nonnullWindDirectionRows'] for item in summaries), 'actualIssueAt': None}


# retain the first failure and stop without requesting the next cycle
def run(root):
    root = validate_private_root(root)
    # a completed or partial prior attempt is never resumed or overwritten
    if any((root / name).exists() or (root / name).is_symlink() for name in ('requests', 'report.json')):
        raise ProbeError('nearest probe already attempted')
    requests = root / 'requests'
    requests.mkdir(mode=0o700)
    receipts, summaries = [], []
    attempted = 0
    plan = None
    freeze = None
    previous_start = None
    failed = None
    # request both modes at all three sites for each fixed source run
    for index, (selection, run_name) in enumerate(PAIRS):
        receipt = None
        request_state = None
        received = None
        status = None
        safe_headers = {}
        try:
            # enforce the fixed two-second spacing without extending request caps
            if previous_start is not None:
                time.sleep(max(0., plan['minimumIntervalSeconds'] - (time.monotonic() - previous_start)))
            root, current_plan, current_freeze = validate_freeze(root)
            # reject a changed frozen plan before the next network start
            if plan is None:
                plan, freeze = current_plan, current_freeze
            elif current_plan != plan or current_freeze != freeze:
                raise ProbeError('nearest probe plan changed between requests')
            parameters = request_parameters(plan, selection, run_name)
            url = ENDPOINT + '?' + parse.urlencode(parameters)
            params_sha = sha256(canonical_json(parameters))
            directory = requests / f'run-{index:02d}'
            directory.mkdir(mode=0o700)
            started = utc_now().isoformat()
            previous_start = time.monotonic()
            request_state = {'cellSelection': selection, 'run': run_name, 'requestIndex': index, 'endpoint': ENDPOINT, 'canonicalParams': parameters, 'paramsSha256': params_sha, 'urlSha256': sha256(url.encode()), 'startedAtUtc': started, 'actualIssueAt': None}
            write_new(directory / 'request.json', canonical_json(request_state))
            attempted += 1
            status, headers, body = fetch(url, plan['timeoutSeconds'], plan['maximumResponseBytes'])
            received = utc_now().isoformat()
            safe_headers = {name.lower(): str(value)[:256] for name, value in headers.items() if name.lower() in SAFE_HEADERS}
            captured = body[:plan['maximumResponseBytes']]
            complete = len(body) <= plan['maximumResponseBytes']
            # retain a bounded artifact even when the returned body is empty
            write_new(directory / 'response-body.bin', captured)
            receipt = {**request_state, 'responseReceivedAtUtc': received, 'status': int(status), 'safeHeaders': safe_headers, 'responseBytesObserved': len(body), 'responseBytesStored': len(captured), 'bodyComplete': complete, 'contentSha256': sha256(body) if complete else None, 'capturedSha256': sha256(captured), 'rawBodyFile': 'response-body.bin', 'result': 'failed', 'error': None}
            # an empty or incomplete body cannot establish source identity
            if not complete or not body:
                raise ProbeError('nearest probe response byte cap or empty body')
            # no non-200 body can be treated as partial success
            if status != 200:
                raise ProbeError(f'nearest probe http status {status}')
            summary = validate_response(body, selection, run_name, plan['locations'])
            summaries.append(summary)
            receipt['result'] = 'success'
            write_new(directory / 'receipt.json', canonical_json(receipt))
            receipts.append(receipt)
        except (OSError, ValueError, TypeError, KeyError, error.URLError) as failure:
            # retain an explicit failure receipt before stopping all later calls
            failed = {'cellSelection': selection, 'run': run_name, 'errorType': type(failure).__name__, 'error': str(failure)}
            if receipt is None:
                receipt = {**(request_state or {'cellSelection': selection, 'run': run_name, 'requestIndex': index, 'actualIssueAt': None}), 'result': 'failed', 'error': str(failure), 'status': status, 'responseReceivedAtUtc': received, 'safeHeaders': safe_headers, 'contentSha256': None, 'rawBodyFile': None}
            else:
                receipt['error'] = str(failure)
            directory = requests / f'run-{index:02d}'
            # retain pre-request failures without inventing a network start
            directory.mkdir(mode=0o700, exist_ok=True)
            write_new(directory / 'receipt.json', canonical_json(receipt))
            receipts.append(receipt)
            break
    freeze_file = root / 'probe-freeze.json'
    report = {'contractVersion': CONTRACT, 'status': 'failed' if failed else 'complete', 'endpoint': ENDPOINT, 'planSha256': freeze['planSha256'] if freeze else None, 'freezeSha256': sha256(freeze_file.read_bytes()) if freeze_file.is_file() else None, 'cellSelections': list(CELL_SELECTIONS), 'plannedHttpRequests': 4, 'plannedLocationRequests': 12, 'attemptedHttpRequests': attempted, 'attemptedLocationRequests': 3 * attempted, 'successfulHttpRequests': len(summaries), 'receipts': [{'cellSelection': item['cellSelection'], 'run': item['run'], 'result': item['result'], 'status': item['status'], 'contentSha256': item['contentSha256']} for item in receipts], 'runSummaries': summaries, 'failure': failed, 'actualIssueAt': None, 'historicalAsIssuedClaim': False, 'runReferenceClassification': 'retrospective_initialization_not_verified_actual_issue_time', 'labelsRead': False, 'modelPerformanceScored': False}
    write_new(root / 'report.json', canonical_json(report))
    # failure remains nonzero despite its retained diagnostic artifacts
    if failed:
        raise ProbeError(f"nearest probe stopped: {failed['error']}")
    return report


# require explicit private-root preparation before bounded acquisition
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--plan', type=Path, required=True)
    execution = commands.add_parser('run')
    execution.add_argument('root', type=Path)
    arguments = parser.parse_args()
    result = prepare(arguments.root, arguments.plan) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result, sort_keys=True), flush=True)
