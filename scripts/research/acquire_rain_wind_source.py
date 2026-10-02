"""retain a bounded 35-hour direction source for original rain runs."""

import argparse
import datetime as dt
import http.client
import json
import os
import time
from pathlib import Path
from urllib import error, parse

import acquire_rain_direction as old
import acquire_rain_direction_recovery as recovery

CONTRACT = 'rain-wind-source/v1'
PARENT_ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-recovery-20260913-v1'
RETENTION_RECEIPT = Path.home() / '.weather/model-evidence/rain-direction-recovery-20260913/retention-receipt.json'
RETENTION_MANIFEST_SHA256 = '69589836b0626a397bd094ac2a79e72ff094db78d3dafe271c18abab312961fa'
RETENTION_RECEIPT_SHA256 = 'b46f7ce22f54166f7760edf8dcb9a9f83cd44fa4baa75a9cec16bfb8f6ee7554'
FAILURE_PROOF_SHA256 = '2b92db86f4939cd822f7dc9e0a04aaccf8836067dd4e4382ead71eb6f57b019e'
KNOWN_TIMEOUT_BODY = b'Unexpected error while streaming data: timeoutReached'
KNOWN_TIMEOUT_SHA256 = 'e7c158d76552f47cf860364a400bb4186e1a781f4e2110dacf671e57a0735128'
PARENT_HTTP_ATTEMPTS = 115
INHERITED = 113
MISSING = 3188
NEW_HTTP_CAP = 6376
FORECAST_HOURS = 35
EXPIRY = '2026-09-14T08:00:00Z'
RETRYABLE_STATUSES = (502, 503, 504)
BACKOFF = 15
SOURCE_FILES = ('acquire_rain_wind_source.py', 'verify_rain_wind_source.py', 'acquire_rain_direction.py', 'acquire_rain_direction_recovery.py', 'verify_rain_direction_recovery.py', 'verify_rain_direction_source.py', 'retain_moisture_research.py')
PLAN_KEYS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'previousRecoveryRoot', 'previousFailureProofSha256', 'previousRetentionManifestSha256', 'previousRetentionReceiptSha256', 'originalManifestSha256', 'originalSourceSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'forecastHours', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator', 'knownTimeoutBodySha256'))
NORMALIZED_FILE = 'normalized/ecmwf_single_run_wind_direction.jsonl'
LINEAGE_FILE = 'response-lineage.jsonl'


class WindSourceError(ValueError):
    """mark a failed bounded wind source acquisition."""


# fix the shorter forecast request while preserving original query order
def request_parameters(run):
    params = old.request_parameters(run)
    # change only the fixed forecast horizon
    return [(name, str(FORECAST_HOURS) if name == 'forecast_hours' else value) for name, value in params]


# check 35 chronological hours against immutable original precipitation
def validate_response(body, run, original):
    item = old.strict_json(body)
    # require one exact model point and unit set
    if not isinstance(item, dict) or ('location_id' in item and (type(item['location_id']) is not int or item['location_id'] != 0)) or item.get('timezone') != 'GMT' or type(item.get('utc_offset_seconds')) is not int or item['utc_offset_seconds'] != 0 or item.get('hourly_units') != old.UNITS:
        raise WindSourceError('wind response identity or units changed')
    grid = {name: old.cell(item.get(name), -90 if name == 'latitude' else -180, 90 if name == 'latitude' else 180) for name in ('latitude', 'longitude')}
    elevation = old.cell(item.get('elevation'), -1_000., 10_000.)
    # reject shifted grid or impossible target metadata
    if None in grid.values() or elevation is None or grid != original['grid']:
        raise WindSourceError('wind response grid parity changed')
    hourly = item.get('hourly')
    # no partial or extra hourly field is accepted
    if not isinstance(hourly, dict) or set(hourly) != {'time', 'precipitation', 'wind_direction_10m'} or any(not isinstance(hourly.get(name), list) or len(hourly[name]) != FORECAST_HOURS for name in ('time', 'precipitation', 'wind_direction_10m')):
        raise WindSourceError('wind response hourly schema changed')
    origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
    # every returned valid hour must match its run and lead
    for lead, timestamp in enumerate(hourly['time']):
        if timestamp != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'):
            raise WindSourceError('wind response run-hour identity changed')
    rain = tuple(old.cell(value, 0., 2_000.) for value in hourly['precipitation'])
    direction = tuple(old.cell(value, 0., 360.) for value in hourly['wind_direction_10m'])
    # the 34 returned forecast rain leads must match the original source
    if rain[1:] != original['rain'][:FORECAST_HOURS - 1]:
        raise WindSourceError('wind response precipitation parity changed')
    footprint = sum(value is not None for value in direction[6:35])
    summary = {'run': run, 'returnedGrid': grid, 'targetElevationM': elevation, 'precipitationParity': True, 'precipitationNullRows': sum(value is None for value in rain), 'directionNullRows': sum(value is None for value in direction), 'directionNullSelectedLeads': sum(value is None for value in direction[1:]), 'directionFootprintNonNullHours': footprint, 'directionFootprintComplete': footprint == 29, 'forecastHours': FORECAST_HOURS, 'actualIssueAt': None}
    return summary, rain, direction


# verify the independently failed previous attempt and retained archive
def audit_previous(parent, receipt_path, snapshot=False):
    parent = Path(parent) if snapshot else old.validate_private_root(parent)
    # reject a different failed recovery or copied user receipt
    if (not snapshot and (parent != PARENT_ROOT or Path(receipt_path).resolve() != RETENTION_RECEIPT)) or (snapshot and (parent.name != 'previous-recovery' or Path(receipt_path) != parent.parent / 'previous-retention-receipt.json')):
        raise WindSourceError('previous recovery path changed')
    receipt_body = Path(receipt_path).read_bytes()
    receipt = old.strict_json(receipt_body)
    manifest_path = parent / 'retention-manifest.json'
    manifest = old.strict_json(manifest_path.read_bytes())
    # pin the independently verified encrypted archive and failure
    if old.sha256(receipt_body) != RETENTION_RECEIPT_SHA256 or old.file_sha256(manifest_path) != RETENTION_MANIFEST_SHA256 or not isinstance(receipt, dict) or receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt.get('manifestSha256') != RETENTION_MANIFEST_SHA256 or receipt.get('failureVerificationSha256') != FAILURE_PROOF_SHA256 or not isinstance(manifest, dict) or manifest.get('failureVerificationSha256') != FAILURE_PROOF_SHA256 or manifest.get('lifetimeHttpAttempts') != PARENT_HTTP_ATTEMPTS:
        raise WindSourceError('previous recovery retention changed')
    entries = manifest.get('files')
    # all and only retained parent files are copied into this protocol
    if not isinstance(entries, dict) or {path.relative_to(parent).as_posix() for path in parent.rglob('*') if path.is_file() or path.is_symlink()} != set(entries) | {'retention-manifest.json'} | (set() if snapshot else {'retention-filelist.bin'}):
        raise WindSourceError('previous recovery file set changed')
    for name, expected in entries.items():
        path = parent / name
        # reject unsafe names, links and changed original evidence
        if not isinstance(name, str) or Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.is_file() or not isinstance(expected, dict) or path.stat().st_size != expected.get('bytes') or old.file_sha256(path) != expected.get('sha256'):
            raise WindSourceError('previous recovery retained file changed: ' + str(name))
    proof_path = parent / 'final-evidence/independent-failure-verification.json'
    proof = old.strict_json(proof_path.read_bytes())
    previous_report = old.strict_json((parent / 'report.json').read_bytes())
    body = (parent / 'requests/0000/response-body.bin').read_bytes()
    previous_receipt = old.strict_json((parent / 'requests/0000/receipt.json').read_bytes())
    # a 200 text timeout is transport evidence, never a provider null
    if old.sha256(proof_path.read_bytes()) != FAILURE_PROOF_SHA256 or proof.get('verdict') != 'PASS' or proof.get('acquisitionComplete') is not False or proof.get('failedBodySha256') != KNOWN_TIMEOUT_SHA256 or proof.get('failedBodyBytes') != len(KNOWN_TIMEOUT_BODY) or proof.get('lifetimeHttpAttempts') != PARENT_HTTP_ATTEMPTS or previous_report.get('status') != 'failed' or previous_report.get('newHttpAttempts') != 1 or body != KNOWN_TIMEOUT_BODY or previous_receipt.get('status') != 200 or previous_receipt.get('contentSha256') != KNOWN_TIMEOUT_SHA256:
        raise WindSourceError('previous recovery failure evidence changed')
    v1 = parent / 'inputs/parent-root'
    partial = recovery.partial_proof(v1 / 'final-evidence/independent-partial-verification.json')
    runs, originals = recovery.originals_from(v1)
    selected = recovery.audit_parent(v1, partial, runs, originals)
    # preserve the exact 113 old successful bodies, not the V2 failure
    if len(selected) != INHERITED or sorted(selected) != sorted(partial['validRunIndices']):
        raise WindSourceError('previous recovery inherited set changed')
    return runs, originals, selected


# require exact run scope, response bounds and month tolerance
def validate_plan(plan, runs, selected, now=None):
    now = old.utc_now() if now is None else now
    inherited = sorted(selected)
    missing = [index for index in range(old.RUN_COUNT) if index not in selected]
    # every authority, cap and original run index is exact
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS or plan['contractVersion'] != CONTRACT or plan['endpoint'] != old.ENDPOINT or plan['site'] != old.SITE or plan['runs'] != runs or plan['inheritedRunIndices'] != inherited or plan['missingRunIndices'] != missing or plan['previousRecoveryRoot'] != str(PARENT_ROOT) or plan['previousFailureProofSha256'] != FAILURE_PROOF_SHA256 or plan['previousRetentionManifestSha256'] != RETENTION_MANIFEST_SHA256 or plan['previousRetentionReceiptSha256'] != RETENTION_RECEIPT_SHA256 or plan['originalManifestSha256'] != old.ORIGINAL_MANIFEST_SHA256 or plan['originalSourceSha256'] != old.ORIGINAL_NORMALIZED_SHA256 or plan['expiresAtUtc'] != EXPIRY or type(plan['maximumNewHttpRequests']) is not int or plan['maximumNewHttpRequests'] != NEW_HTTP_CAP or type(plan['maximumLocationRequests']) is not int or plan['maximumLocationRequests'] != NEW_HTTP_CAP or type(plan['maximumAttemptsPerRun']) is not int or plan['maximumAttemptsPerRun'] != 2 or type(plan['minimumIntervalSeconds']) is not int or plan['minimumIntervalSeconds'] != 1 or type(plan['timeoutSeconds']) is not int or plan['timeoutSeconds'] != 90 or type(plan['maximumResponseBytes']) is not int or plan['maximumResponseBytes'] != 2_000_000 or plan['retryableHttpStatuses'] != list(RETRYABLE_STATUSES) or plan['retryBackoffSeconds'] != [BACKOFF] or type(plan['forecastHours']) is not int or plan['forecastHours'] != FORECAST_HOURS or type(plan['unresolvedFractionNumerator']) is not int or plan['unresolvedFractionNumerator'] != 1 or type(plan['unresolvedFractionDenominator']) is not int or plan['unresolvedFractionDenominator'] != 100 or plan['knownTimeoutBodySha256'] != KNOWN_TIMEOUT_SHA256 or len(missing) != MISSING or len(inherited) != INHERITED:
        raise WindSourceError('invalid bounded wind source plan')
    # no request may start at or after the frozen deadline
    if now >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise WindSourceError('wind source plan expired')
    return plan


# copy the independently retained V2 tree into an exclusive input snapshot
def snapshot_previous(parent, root, receipt_path):
    manifest = old.strict_json((parent / 'retention-manifest.json').read_bytes())
    target = root / 'inputs/previous-recovery'
    target.mkdir(mode=0o700, parents=True)
    # every prior file remains addressable at the same relative path
    for name in sorted(manifest['files']):
        source = parent / name
        destination = target / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        old.copy_new(source, destination)
        if old.file_sha256(destination) != manifest['files'][name]['sha256']:
            raise WindSourceError('previous recovery changed during snapshot')
    old.copy_new(parent / 'retention-manifest.json', target / 'retention-manifest.json')
    old.copy_new(receipt_path, root / 'inputs/previous-retention-receipt.json')
    # a copied failure never silently becomes a usable successful source
    return audit_previous(target, root / 'inputs/previous-retention-receipt.json', snapshot=True)


# freeze reviewed sources before any new HTTP starts
def prepare(root, plan_path, parent_root, parent_retention_receipt):
    root = old.validate_private_root(root)
    parent_root = old.validate_private_root(parent_root)
    plan_path = Path(plan_path)
    receipt_path = Path(parent_retention_receipt)
    # root-owned plan and exact retained previous evidence are mandatory
    if parent_root != PARENT_ROOT or receipt_path.resolve() != RETENTION_RECEIPT or plan_path.parent.resolve() != root or plan_path.is_symlink() or not plan_path.is_file() or receipt_path.is_symlink() or not receipt_path.is_file():
        raise WindSourceError('invalid wind source preparation path')
    if any((root / name).exists() or (root / name).is_symlink() for name in ('inputs', 'sources', 'frozen-plan.json', 'wind-source-freeze.json', 'requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise WindSourceError('wind source already prepared')
    # independent verifier and all imported producer bytes must exist
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        if source.is_symlink() or not source.is_file():
            raise WindSourceError('wind source not finalized: ' + name)
    runs, originals, selected = audit_previous(parent_root, receipt_path)
    plan_body = plan_path.read_bytes()
    if not plan_body or len(plan_body) > 300_000:
        raise WindSourceError('invalid wind source plan bytes')
    validate_plan(old.strict_json(plan_body), runs, selected)
    copied_runs, copied_originals, copied_selected = snapshot_previous(parent_root, root, receipt_path)
    # source snapshots must preserve the selected original run population
    if copied_runs != runs or copied_selected != selected or copied_originals != originals:
        raise WindSourceError('wind source snapshot changed')
    sources = root / 'sources'
    sources.mkdir(mode=0o700)
    source_hashes = {}
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        body = source.read_bytes()
        old.write_new(sources / name, body)
        source_hashes[name] = old.sha256(body)
    old.write_new(root / 'frozen-plan.json', plan_body)
    original_path = root / 'inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl'
    freeze = {'contractVersion': CONTRACT, 'planSha256': old.sha256(plan_body), 'previousFailureProofSha256': FAILURE_PROOF_SHA256, 'previousRetentionManifestSha256': RETENTION_MANIFEST_SHA256, 'previousRetentionReceiptSha256': RETENTION_RECEIPT_SHA256, 'sourceSha256': source_hashes, 'originalManifestSha256': old.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': old.ORIGINAL_NORMALIZED_SHA256, 'originalSourceBytes': original_path.stat().st_size, 'originalSourceMtimeNs': original_path.stat().st_mtime_ns, 'inheritedRawBodies': INHERITED, 'missingRuns': MISSING, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'forecastHours': FORECAST_HOURS, 'preparedAtUtc': old.utc_stamp(), 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False}
    old.write_new(root / 'wind-source-freeze.json', old.canonical_json(freeze))
    return freeze

# recheck policy and frozen bytes before each bounded request
def validate_freeze(root, full=False, check_expiry=True):
    root = old.validate_private_root(root)
    freeze = old.strict_json((root / 'wind-source-freeze.json').read_bytes())
    plan_body = (root / 'frozen-plan.json').read_bytes()
    # no code or source boundary may drift after preparation
    if not isinstance(freeze, dict) or freeze.get('contractVersion') != CONTRACT or freeze.get('planSha256') != old.sha256(plan_body) or freeze.get('previousFailureProofSha256') != FAILURE_PROOF_SHA256 or freeze.get('previousRetentionManifestSha256') != RETENTION_MANIFEST_SHA256 or freeze.get('previousRetentionReceiptSha256') != RETENTION_RECEIPT_SHA256 or freeze.get('originalManifestSha256') != old.ORIGINAL_MANIFEST_SHA256 or freeze.get('originalSourceSha256') != old.ORIGINAL_NORMALIZED_SHA256 or freeze.get('inheritedRawBodies') != INHERITED or freeze.get('missingRuns') != MISSING or freeze.get('maximumNewHttpRequests') != NEW_HTTP_CAP or freeze.get('forecastHours') != FORECAST_HOURS or freeze.get('actualIssueAt') is not None or freeze.get('labelsRead') is not False or freeze.get('modelGatesEvaluated') is not False or freeze.get('productionWrites') is not False or set(freeze.get('sourceSha256', {})) != set(SOURCE_FILES):
        raise WindSourceError('wind source freeze changed')
    for name, expected in freeze['sourceSha256'].items():
        # current importer and copied source must match original review
        source = Path(__file__).with_name(name)
        if old.file_sha256(source) != expected or old.file_sha256(root / 'sources' / name) != expected:
            raise WindSourceError('wind source code changed')
    original_path = root / 'inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl'
    if original_path.stat().st_size != freeze['originalSourceBytes'] or original_path.stat().st_mtime_ns != freeze['originalSourceMtimeNs']:
        raise WindSourceError('wind original source metadata changed')
    if old.file_sha256(root / 'inputs/previous-retention-receipt.json') != RETENTION_RECEIPT_SHA256 or old.file_sha256(root / 'inputs/previous-recovery/retention-manifest.json') != RETENTION_MANIFEST_SHA256 or old.file_sha256(root / 'inputs/previous-recovery/final-evidence/independent-failure-verification.json') != FAILURE_PROOF_SHA256:
        raise WindSourceError('wind previous source proof changed')
    plan = old.strict_json(plan_body)
    # full phase gate replays all 3301 original rain profiles and 113 bodies
    if full:
        parent = root / 'inputs/previous-recovery'
        runs, originals, selected = audit_previous(parent, root / 'inputs/previous-retention-receipt.json', snapshot=True)
        checked = old.utc_now() if check_expiry else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        validate_plan(plan, runs, selected, now=checked)
        return root, plan, freeze, runs, originals, selected
    # short phase gate still enforces the absolute stop time
    if check_expiry and old.utc_now() >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise WindSourceError('wind source plan expired')
    return root, plan, freeze


# make one fully retained request and classify the exact timeout signature
def attempt_once(root, plan, index, run_index, run, original, attempt_in_run):
    directory = root / f'requests/{index:04d}'
    directory.mkdir(mode=0o700)
    params = request_parameters(run)
    url = old.ENDPOINT + '?' + parse.urlencode(params)
    started = old.utc_stamp()
    request_state = {'contractVersion': CONTRACT, 'requestIndex': index, 'runIndex': run_index, 'run': run, 'attemptInRun': attempt_in_run, 'endpoint': old.ENDPOINT, 'canonicalParams': params, 'paramsSha256': old.sha256(old.canonical_json(params)), 'urlSha256': old.sha256(url.encode()), 'startedAtUtc': started, 'actualIssueAt': None}
    old.write_new(directory / 'request.json', old.canonical_json(request_state))
    status, received, headers, body, problem = None, None, {}, None, None
    # each invocation is exactly one no-redirect public GET
    try:
        status, headers, body = old.fetch(url, plan['timeoutSeconds'], plan['maximumResponseBytes'])
        received = old.utc_stamp()
    except (OSError, ValueError, http.client.HTTPException) as failure:
        problem = failure
        # incomplete reads retain their bounded partial bytes
        if isinstance(failure, http.client.IncompleteRead) and isinstance(failure.partial, bytes):
            body = failure.partial[:plan['maximumResponseBytes'] + 1]
    finished = old.utc_stamp()
    safe_headers = {name.lower(): str(value)[:256] for name, value in headers.items() if name.lower() in old.SAFE_HEADERS}
    captured, complete = None, None
    # retain every available response body before classification
    if body is not None:
        captured = body[:plan['maximumResponseBytes']]
        complete = problem is None and len(body) <= plan['maximumResponseBytes']
        old.write_new(directory / 'response-body.bin', captured)
    receipt = {**request_state, 'responseReceivedAtUtc': received, 'finishedAtUtc': finished, 'status': status, 'safeHeaders': safe_headers, 'responseBytesObserved': len(body) if body is not None else 0, 'responseBytesStored': len(captured) if captured is not None else 0, 'bodyComplete': complete, 'contentSha256': old.sha256(body) if body is not None and complete else None, 'capturedSha256': old.sha256(captured) if captured is not None else None, 'rawBodyFile': 'response-body.bin' if body is not None else None, 'result': 'failed', 'errorType': type(problem).__name__ if problem is not None else None, 'error': str(problem) if problem is not None else None, 'summary': None, 'retryable': False, 'retryScheduled': False, 'backoffSeconds': 0}
    known_timeout = status == 200 and complete is True and body == KNOWN_TIMEOUT_BODY and old.sha256(body) == KNOWN_TIMEOUT_SHA256
    # retry only explicit transport classes or three retryable statuses
    if problem is not None:
        receipt['retryable'] = isinstance(problem, (TimeoutError, error.URLError, http.client.IncompleteRead, http.client.RemoteDisconnected))
    elif status in RETRYABLE_STATUSES:
        receipt.update({'retryable': True, 'errorType': 'RetryableHttpStatus', 'error': f'HTTP {status}'})
    elif known_timeout:
        receipt.update({'retryable': True, 'errorType': 'KnownStreamingTimeout', 'error': 'known streaming timeout'})
    elif not complete or not body:
        receipt.update({'errorType': 'ResponseBodyError', 'error': 'empty or oversized response'})
    elif status != 200:
        receipt.update({'errorType': 'FatalHttpStatus', 'error': f'HTTP {status}'})
    else:
        try:
            summary, _, _ = validate_response(body, run, original)
            receipt.update({'result': 'success', 'summary': summary})
        except (ValueError, TypeError, KeyError) as failure:
            # grid, rain and schema mismatches terminate immediately
            receipt.update({'errorType': type(failure).__name__, 'error': str(failure)})
    # only a second exact known timeout can become unresolved
    if receipt['retryable'] and attempt_in_run == 1:
        receipt.update({'result': 'retryableFailure', 'retryScheduled': True, 'backoffSeconds': BACKOFF})
    elif known_timeout and attempt_in_run == 2:
        receipt['result'] = 'transportUnresolved'
    old.write_new(directory / 'receipt.json', old.canonical_json(receipt))
    return receipt

# compute strict integer source coverage in every decision month
def month_coverage(runs, unresolved):
    coverage = {}
    # month identity uses initialization plus the eight-hour decision offset
    for index, run in enumerate(runs):
        decision = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc) + dt.timedelta(hours=8)
        key = decision.strftime('%Y-%m')
        bucket = coverage.setdefault(key, {'totalRuns': 0, 'unresolvedRuns': 0})
        bucket['totalRuns'] += 1
        bucket['unresolvedRuns'] += index in unresolved
    # integer comparison avoids tolerance rounding at the threshold
    for bucket in coverage.values():
        bucket['qualified'] = 100 * bucket['unresolvedRuns'] <= bucket['totalRuns']
    qualified = 100 * len(unresolved) <= len(runs) and all(bucket['qualified'] for bucket in coverage.values())
    return coverage, qualified


# expose only flushed complete output files
def publish_file(temporary, destination):
    # exclusive link avoids replacing an earlier artifact
    if destination.exists() or destination.is_symlink():
        raise WindSourceError('wind source output already exists')
    os.link(temporary, destination)
    temporary.unlink()


# replay selected response bodies into old-order 48-lead rows
def normalize_all(root, plan, originals, selected):
    directory = root / 'normalized'
    directory.mkdir(mode=0o700)
    normalized = root / NORMALIZED_FILE
    lineage = root / LINEAGE_FILE
    temporary_rows = directory / '.direction.partial'
    temporary_lineage = root / '.response-lineage.partial'
    first = os.open(temporary_rows, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    second = os.open(temporary_lineage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(first, 'wb') as rows, os.fdopen(second, 'wb') as lineage_rows:
            # every original run has exactly one selected source disposition
            for run_index, run in enumerate(plan['runs']):
                source = selected[run_index]
                body_path = root / source['rawBodyFile']
                body = body_path.read_bytes()
                receipt = old.strict_json((body_path.parent / 'receipt.json').read_bytes())
                origin_type = source['origin']
                # inherited 49-hour bodies retain all 48 direction leads
                if origin_type == 'parentInherited':
                    summary, _, direction = old.validate_response(body, run, originals[run])
                    lead_count = old.LEADS
                    expected_result = 'success'
                elif origin_type == 'newAcquired':
                    summary, _, direction = validate_response(body, run, originals[run])
                    lead_count = FORECAST_HOURS - 1
                    expected_result = 'success'
                else:
                    # an exact second timeout carries no forecast measurements
                    if origin_type != 'transportUnresolved' or body != KNOWN_TIMEOUT_BODY:
                        raise WindSourceError('unresolved source body changed')
                    summary, direction = {'returnedGrid': originals[run]['grid']}, (None,) * FORECAST_HOURS
                    lead_count = 0
                    expected_result = 'transportUnresolved'
                # the selected receipt must bind its exact raw body and summary
                if old.sha256(body) != source['bodySha256'] or receipt.get('result') != expected_result or receipt.get('status') != 200 or receipt.get('contentSha256') != source['bodySha256'] or receipt.get('responseReceivedAtUtc') != source['responseReceivedAtUtc'] or (expected_result == 'success' and receipt.get('summary') != summary):
                    raise WindSourceError('selected wind response changed')
                line = {'originalRunIndex': run_index, 'run': run, 'origin': origin_type, 'sourceAttemptIndex': source['attemptIndex'], 'rawBodyFile': source['rawBodyFile'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'directionLeadCount': lead_count}
                lineage_rows.write(old.canonical_json(line))
                origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
                # rain always comes from the original 48-lead reference source
                for lead in range(1, old.LEADS + 1):
                    value = direction[lead] if lead <= lead_count else None
                    status = 'transportUnresolved' if origin_type == 'transportUnresolved' else ('notRequested' if lead > lead_count else ('providerNull' if value is None else 'available'))
                    row = {'cohort': 'ecmwf_single_run_hindcast', 'key': f'ecmwf_single_run_hindcast|{run}|lead={lead}', 'runInitializedAt': run + ':00Z', 'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': originals[run]['rain'][lead - 1], 'rawWindDirectionDegrees': value, 'directionSourceStatus': status, 'returnedGrid': summary['returnedGrid'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'actualIssueAt': None}
                    rows.write(old.canonical_json(row))
            rows.flush()
            os.fsync(rows.fileno())
            lineage_rows.flush()
            os.fsync(lineage_rows.fileno())
        publish_file(temporary_rows, normalized)
        publish_file(temporary_lineage, lineage)
    except (OSError, ValueError, TypeError, KeyError):
        # partial temporary rows never become an authoritative output
        temporary_rows.unlink(missing_ok=True)
        temporary_lineage.unlink(missing_ok=True)
        raise
    return {'normalizedFile': NORMALIZED_FILE, 'normalizedRows': old.RUN_COUNT * old.LEADS, 'normalizedSha256': old.file_sha256(normalized), 'responseLineageFile': LINEAGE_FILE, 'responseLineageRows': old.RUN_COUNT, 'responseLineageSha256': old.file_sha256(lineage)}


# execute one terminal source acquisition without refetching inherited runs
def run(root):
    root = old.validate_private_root(root)
    # no prior attempts can be implicitly resumed or overwritten
    if any((root / name).exists() or (root / name).is_symlink() for name in ('requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise WindSourceError('wind source already attempted')
    root, plan, freeze, runs, originals, inherited = validate_freeze(root, full=True)
    requests = root / 'requests'
    requests.mkdir(mode=0o700)
    selected = {index: {**item, 'origin': 'parentInherited', 'rawBodyFile': 'inputs/previous-recovery/inputs/parent-root/' + item['rawBodyFile']} for index, item in inherited.items()}
    attempted, new_successes, retry_failures = 0, 0, 0
    unresolved = set()
    outcomes = []
    failure = None
    last_start = None
    retry_not_before = None
    # only 3188 missing original run indices receive new GET starts
    for run_index in plan['missingRunIndices']:
        run = runs[run_index]
        # each missing run has at most two retained attempts
        for attempt_in_run in (1, 2):
            try:
                validate_freeze(root)
                # enforce one-second global spacing and fixed retry delay
                delay = max(0., plan['minimumIntervalSeconds'] - (time.monotonic() - last_start)) if last_start is not None else 0.
                if retry_not_before is not None:
                    delay = max(delay, retry_not_before - time.monotonic())
                if delay > 0:
                    time.sleep(delay)
                validate_freeze(root)
                # the cap counts starts, including retries and failures
                if attempted >= NEW_HTTP_CAP:
                    raise WindSourceError('wind source HTTP cap exhausted')
                last_start = time.monotonic()
                index = attempted
                receipt = attempt_once(root, plan, index, run_index, run, originals[run], attempt_in_run)
                outcomes.append({'requestIndex': index, 'runIndex': run_index, 'run': run, 'attemptInRun': attempt_in_run, 'result': receipt['result'], 'status': receipt['status'], 'errorType': receipt['errorType'], 'responseSha256': receipt['contentSha256']})
                attempted += 1
                retry_not_before = None
                # a successful body becomes the selected forecast response
                if receipt['result'] == 'success':
                    new_successes += 1
                    selected[run_index] = {'runIndex': run_index, 'run': run, 'attemptIndex': index, 'bodySha256': receipt['contentSha256'], 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{index:04d}/response-body.bin', 'origin': 'newAcquired'}
                    break
                # only the second exact known timeout is qualified missingness
                if receipt['result'] == 'transportUnresolved':
                    unresolved.add(run_index)
                    selected[run_index] = {'runIndex': run_index, 'run': run, 'attemptIndex': index, 'bodySha256': receipt['contentSha256'], 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{index:04d}/response-body.bin', 'origin': 'transportUnresolved'}
                    # fixed full-population denominators make an exceeded cap irreversible
                    _, within_tolerance = month_coverage(runs, unresolved)
                    if not within_tolerance:
                        failure = {'runIndex': run_index, 'run': run, 'requestIndex': index, 'attemptInRun': attempt_in_run, 'errorType': 'SourceCoverageExceeded', 'error': 'wind source unresolved fraction exceeded', 'status': 200, 'retryExhausted': False}
                    break
                if receipt['retryScheduled']:
                    retry_failures += 1
                    retry_not_before = time.monotonic() + receipt['backoffSeconds']
                    continue
                failure = {'runIndex': run_index, 'run': run, 'requestIndex': index, 'attemptInRun': attempt_in_run, 'errorType': receipt['errorType'], 'error': receipt['error'], 'status': receipt['status'], 'retryExhausted': receipt['retryable'] and attempt_in_run == 2}
                break
            except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
                # expiry, source drift or storage failure stops further GETs
                if (requests / f'{attempted:04d}/request.json').is_file():
                    attempted += 1
                failure = {'runIndex': run_index, 'run': run, 'requestIndex': attempted - 1 if attempted else None, 'attemptInRun': attempt_in_run, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
                break
        if failure is not None:
            break
    coverage, qualified = month_coverage(runs, unresolved)
    outputs = None
    # no normalized supplement is published until all runs are represented
    if failure is None:
        try:
            validate_freeze(root, full=True, check_expiry=False)
            if len(selected) != old.RUN_COUNT or new_successes + len(unresolved) != MISSING:
                raise WindSourceError('wind source selected set incomplete')
            if not qualified:
                raise WindSourceError('wind source unresolved fraction exceeded')
            outputs = normalize_all(root, plan, originals, selected)
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
            failure = {'runIndex': None, 'run': None, 'requestIndex': None, 'attemptInRun': None, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
    report = {'contractVersion': CONTRACT, 'status': 'failed' if failure else 'complete', 'sourceQualified': failure is None and qualified, 'planSha256': freeze['planSha256'], 'freezeSha256': old.file_sha256(root / 'wind-source-freeze.json'), 'previousFailureProofSha256': FAILURE_PROOF_SHA256, 'previousRetentionManifestSha256': RETENTION_MANIFEST_SHA256, 'previousRetentionReceiptSha256': RETENTION_RECEIPT_SHA256, 'parentHttpAttempts': PARENT_HTTP_ATTEMPTS, 'newHttpAttempts': attempted, 'totalHttpAttempts': PARENT_HTTP_ATTEMPTS + attempted, 'attemptedLocationRequests': attempted, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'uniqueRepresentedRuns': len(selected), 'uniqueSuccessfulRuns': len(selected) - len(unresolved), 'reusedSuccessfulRuns': INHERITED, 'newSuccessfulRuns': new_successes, 'newUnresolvedRuns': len(unresolved), 'retryableFailuresBeforeSuccessOrStop': retry_failures, 'plannedMissingRuns': MISSING, 'runOutcomes': outcomes, 'perMonthCoverage': coverage, 'failure': failure, 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False, **(outputs or {})}
    # a fatal result still receives a terminal evidence report
    old.write_new(root / 'report.json', old.canonical_json(report))
    if failure:
        raise WindSourceError(f"wind source stopped: {failure['error']}")
    return report


# separate evidence freezing from the one-shot network execution
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--plan', type=Path, required=True)
    preparation.add_argument('--parent-root', type=Path, required=True)
    preparation.add_argument('--parent-retention-receipt', type=Path, required=True)
    execution = commands.add_parser('run')
    execution.add_argument('root', type=Path)
    arguments = parser.parse_args()
    result = prepare(arguments.root, arguments.plan, arguments.parent_root, arguments.parent_retention_receipt) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result, sort_keys=True), flush=True)
