"""independently replay retained short-horizon wind source without HTTP or labels."""

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode

import verify_rain_direction_recovery as old
import verify_rain_direction_source as original

CONTRACT = 'rain-wind-source-verification/v1'
ROOT_NAME = 'weather-moisture-research-rain-wind-source-20260913-v1'
WIND_ROOT_NAME = 'weather-moisture-research-rain-wind-20260913-v1'
PARENT_MANIFEST_SHA = '69589836b0626a397bd094ac2a79e72ff094db78d3dafe271c18abab312961fa'
PARENT_RECEIPT_SHA = 'b46f7ce22f54166f7760edf8dcb9a9f83cd44fa4baa75a9cec16bfb8f6ee7554'
PARENT_PROOF_SHA = '2b92db86f4939cd822f7dc9e0a04aaccf8836067dd4e4382ead71eb6f57b019e'
KNOWN_TIMEOUT = b'Unexpected error while streaming data: timeoutReached'
MISSING_COUNT = 3188
REUSED_COUNT = 113
PARENT_ATTEMPTS = 115
MAX_ATTEMPTS = 6376
EXPIRY = '2026-09-14T08:00:00Z'
NORMALIZED_PATH = 'normalized/ecmwf_single_run_wind_direction.jsonl'
LINEAGE_PATH = 'response-lineage.jsonl'
RETRYABLE = (502, 503, 504)


# hash exact retained bytes in bounded blocks
def file_sha256(path):
    digest = hashlib.sha256()
    # stream retained source bytes without a large allocation
    with Path(path).open('rb') as stream:
        # preserve byte identity without loading the old source
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


# require exact canonical utc provenance
def utc_time(value):
    stamp = old.prior.utc_time(value)
    # aliases are not request receipt timestamps
    if stamp.tzinfo is None or stamp.utcoffset() != dt.timedelta(0):
        raise ValueError('non-utc time')
    return stamp


# derive the fixed 35-hour public forecast query
def expected_params(run):
    params = original.expected_params(run)
    # only horizon shortening is permitted in the new query
    for pair in params:
        # pin forecast_hours and preserve every other old parameter
        if pair[0] == 'forecast_hours':
            pair[1] = '35'
    return params


# independently decode one 35-hour raw response against the pinned rain source
def audit_response_35(body, profile):
    response = old.strict_json(body)
    # one location only, with default-zero location id semantics
    if not isinstance(response, dict) or ('location_id' in response and (type(response['location_id']) is not int or response['location_id'] != 0)):
        raise ValueError('short response location id changed')
    # require exact time and physical unit schema
    if response.get('timezone') != 'GMT' or type(response.get('utc_offset_seconds')) is not int or response['utc_offset_seconds'] != 0 or response.get('hourly_units') != original.UNITS:
        raise ValueError('short response timezone or units changed')
    grid = (original.physical_cell(response.get('latitude'), -90, 90), original.physical_cell(response.get('longitude'), -180, 180))
    elevation = original.physical_cell(response.get('elevation'), -1000, 10000)
    # reject grid drift and absent elevation
    if grid != profile['grid'] or elevation is None:
        raise ValueError('short response grid changed')
    hourly = response.get('hourly')
    # retain all three requested arrays and no injected variables
    if not isinstance(hourly, dict) or set(hourly) != {'time', 'precipitation', 'wind_direction_10m'} or any(not isinstance(hourly.get(name), list) or len(hourly[name]) != 35 for name in hourly):
        raise ValueError('short response horizon or fields changed')
    start = utc_time(profile['initialized'])
    # do not infer a changed initialization or shifted source lead
    for lead, value in enumerate(hourly['time']):
        # require exact old run plus lead hours
        if value != (start + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'):
            raise ValueError('short response valid hour changed')
    rain = tuple(original.physical_cell(value, 0, 2000) for value in hourly['precipitation'])
    direction = tuple(original.physical_cell(value, 0, 360) for value in hourly['wind_direction_10m'])
    # only 34 requested positive leads can be compared to old rain
    if rain[1:] != profile['precipitation'][:34]:
        raise ValueError('short response rain parity changed')
    return {
        'grid': grid,
        'targetElevationM': elevation,
        'precipitation': rain,
        'direction': direction,
        'directionFootprintNonNullHours': sum(value is not None for value in direction[6:35]),
        'directionFootprintComplete': all(value is not None for value in direction[6:35]),
    }


# independently reconstruct the exact short-response summary
def response_summary(profile, parsed):
    return {
        'run': profile['run'],
        'returnedGrid': {'latitude': parsed['grid'][0], 'longitude': parsed['grid'][1]},
        'targetElevationM': parsed['targetElevationM'],
        'precipitationParity': True,
        'precipitationNullRows': sum(value is None for value in parsed['precipitation']),
        'directionNullRows': sum(value is None for value in parsed['direction']),
        'directionNullSelectedLeads': sum(value is None for value in parsed['direction'][1:]),
        'directionFootprintNonNullHours': parsed['directionFootprintNonNullHours'],
        'directionFootprintComplete': parsed['directionFootprintComplete'],
        'actualIssueAt': None,
        'forecastHours': 35,
    }


# derive source statuses without treating transport or tail as provider null
def direction_rows(origin, direction):
    values = []
    # retain every original positive lead including unrequested tails
    for lead in range(1, 49):
        # a terminal known timeout has no direction at any lead
        if origin == 'transportUnresolved':
            values.append((None, 'transportUnresolved'))
        elif origin == 'newAcquired' and lead > 34:
            # the request did not ask for this lead
            values.append((None, 'notRequested'))
        else:
            value = direction[lead]
            values.append((value, 'available' if value is not None else 'providerNull'))
    return values


# qualify bounded unknown runs independently of labels and model outcomes
def coverage(originals, unresolved):
    counts, failures = {}, {}
    # each decision month derives only from run initialization plus eight hours
    for run_index, profile in enumerate(originals):
        start = utc_time(profile['initialized']) + dt.timedelta(hours=8)
        month = start.strftime('%Y-%m')
        counts[month] = counts.get(month, 0) + 1
        failures[month] = failures.get(month, 0) + (run_index in unresolved)
    # neither global nor per-month cap may exceed one percent
    eligible = 100 * len(unresolved) <= len(originals) and all(100 * failures[month] <= count for month, count in counts.items())
    return eligible, counts, failures


# re-audit both failed source generations and their encrypted copy boundary
def audit_previous(root):
    previous = root / 'inputs/previous-recovery'
    manifest_path = previous / 'retention-manifest.json'
    receipt_path = root / 'inputs/previous-retention-receipt.json'
    proof_path = previous / 'final-evidence/independent-failure-verification.json'
    # retain exact prior archive and independent terminal-failure proof bytes
    if file_sha256(manifest_path) != PARENT_MANIFEST_SHA or file_sha256(receipt_path) != PARENT_RECEIPT_SHA or file_sha256(proof_path) != PARENT_PROOF_SHA:
        raise ValueError('previous failed source lineage changed')
    manifest = old.strict_json(manifest_path.read_bytes())
    retention = old.strict_json(receipt_path.read_bytes())
    proof = old.strict_json(proof_path.read_bytes())
    # a prior failed acquisition cannot be represented as a complete one
    if manifest['contractVersion'] != 'rain-direction-recovery-private-retention/v1' or manifest['acquisitionComplete'] is not False or manifest['acquisitionStatus'] != 'failed' or manifest['uniqueSuccessfulRuns'] != REUSED_COUNT or manifest['lifetimeHttpAttempts'] != PARENT_ATTEMPTS or manifest['failureVerificationSha256'] != PARENT_PROOF_SHA or manifest['modelGatesEvaluated'] is not False or manifest['productionEligible'] is not False:
        raise ValueError('previous failed retention scope changed')
    # require encrypted local roundtrip receipt with no external publication
    if retention['contractVersion'] != 'rain-direction-recovery-retention/v1' or retention['verdict'] != 'PASS' or retention['manifestSha256'] != PARENT_MANIFEST_SHA or retention['failureVerificationSha256'] != PARENT_PROOF_SHA or retention['encryptedRoundtripVerified'] is not True or retention['uniqueSuccessfulRuns'] != REUSED_COUNT or retention['lifetimeHttpAttempts'] != PARENT_ATTEMPTS or retention['productionDatabaseOrServiceWrites'] is not False or retention['remoteCopyPerformed'] is not False:
        raise ValueError('previous retention receipt changed')
    listed = manifest['files']
    # copied private archive must contain exactly its declared files
    actual = {path.relative_to(previous).as_posix() for path in previous.rglob('*') if path.is_file()}
    # copied archive admits only manifest-listed regular files
    if actual != set(listed) | {'retention-manifest.json'} or any(path.is_symlink() for path in previous.rglob('*')):
        raise ValueError('previous retained file set changed')
    # every archived body, source, proof and request must match encrypted manifest
    for relative, metadata in listed.items():
        path = previous / relative
        # prevent linked files from escaping the frozen archive
        if path.is_symlink() or not path.is_file() or path.stat().st_size != metadata['bytes'] or file_sha256(path) != metadata['sha256']:
            raise ValueError('previous retained file changed: ' + relative)
    parent = previous / 'inputs/parent-root'
    originals = old.original_profiles(parent)
    inherited, parent_info = old.audit_parent(parent, parent / 'final-evidence/independent-partial-verification.json', originals)
    _, hashes = old.audit_freeze(previous, originals, inherited, parent_info)
    failed = old.audit_new_attempt(previous, 0, 108, 1, originals[108])
    report_path = previous / 'report.json'
    report = old.strict_json(report_path.read_bytes())
    # the only V2 attempt is exact known upstream body, never a direction response
    if {path.name for path in (previous / 'requests').iterdir()} != {'0000'} or file_sha256(previous / 'requests/0000/response-body.bin') != original.sha256(KNOWN_TIMEOUT) or (previous / 'requests/0000/response-body.bin').read_bytes() != KNOWN_TIMEOUT or failed['status'] != 200 or failed['result'] != 'failed' or failed['runIndex'] != 108 or failed['profile'] is not None:
        raise ValueError('previous terminal upstream timeout changed')
    # bind prior producer report, plan and freeze to the independent failure proof
    if report['contractVersion'] != old.ACQUISITION_CONTRACT or report['status'] != 'failed' or report['uniqueSuccessfulRuns'] != REUSED_COUNT or report['newHttpAttempts'] != 1 or report['totalHttpAttempts'] != PARENT_ATTEMPTS or report['reusedSuccessfulRuns'] != REUSED_COUNT or report['newSuccessfulRuns'] != 0 or report['labelsRead'] is not False or report['modelGatesEvaluated'] is not False or report['productionWrites'] is not False or report['failure']['requestIndex'] != 0 or report['failure']['runIndex'] != 108 or report['failure']['errorType'] != 'AcquisitionError' or report['failure']['status'] != 200:
        raise ValueError('previous failed report changed')
    # one byte-pinned proof must describe the same preserved failure
    if proof['contractVersion'] != 'rain-direction-recovery-failure-verification/v1' or proof['verdict'] != 'PASS' or proof['acquisitionComplete'] is not False or proof['failedBodySha256'] != original.sha256(KNOWN_TIMEOUT) or proof['failedBodyBytes'] != len(KNOWN_TIMEOUT) or proof['failedHttpStatus'] != 200 or proof['failedOriginalRunIndex'] != 108 or proof['parentSuccessfulRawBodies'] != REUSED_COUNT or proof['uniqueSuccessfulRuns'] != REUSED_COUNT or proof['lifetimeHttpAttempts'] != PARENT_ATTEMPTS or proof['reportSha256'] != file_sha256(report_path) or proof['freezeSha256'] != hashes['freezeSha256'] or proof['planSha256'] != hashes['planSha256'] or any(proof[key] is not False for key in ('historicalAsIssuedVerified', 'freshHoldoutVerified', 'modelGatesEvaluated', 'productionEligible')):
        raise ValueError('previous failure proof changed')
    return originals, inherited, {'previousReportSha256': proof['reportSha256'], 'previousFreezeSha256': hashes['freezeSha256'], 'previousFailureProofSha256': PARENT_PROOF_SHA, 'previousRetentionManifestSha256': PARENT_MANIFEST_SHA, 'previousRetentionReceiptSha256': PARENT_RECEIPT_SHA}


# bind the new frozen scope without trusting the producer's policy checks
def audit_freeze(root, originals, inherited, previous_hashes):
    plan_path = root / 'frozen-plan.json'
    freeze_path = root / 'wind-source-freeze.json'
    plan_body = plan_path.read_bytes()
    freeze_body = freeze_path.read_bytes()
    plan = old.strict_json(plan_body)
    freeze = old.strict_json(freeze_body)
    inherited_indices = sorted(item['runIndex'] for item in inherited)
    missing_indices = [index for index in range(original.RUNS) if index not in set(inherited_indices)]
    expected_plan_fields = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'previousRecoveryRoot', 'previousFailureProofSha256', 'previousRetentionManifestSha256', 'previousRetentionReceiptSha256', 'originalManifestSha256', 'originalSourceSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'forecastHours', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator', 'knownTimeoutBodySha256'))
    # every original source run and only the inherited complement is in scope
    if not isinstance(plan, dict) or set(plan) != expected_plan_fields or plan['contractVersion'] != 'rain-wind-source/v1' or plan['endpoint'] != original.ENDPOINT or plan['site'] != {'latitude': original.SITE[0], 'longitude': original.SITE[1]} or plan['runs'] != [item['run'] for item in originals] or plan['inheritedRunIndices'] != inherited_indices or plan['missingRunIndices'] != missing_indices or len(inherited_indices) != REUSED_COUNT or len(missing_indices) != MISSING_COUNT:
        raise ValueError('wind source plan population changed')
    # exact response deadline, physical query and bounded retry budget
    if plan['expiresAtUtc'] != EXPIRY or plan['forecastHours'] != 35 or plan['maximumNewHttpRequests'] != MAX_ATTEMPTS or plan['maximumLocationRequests'] != MAX_ATTEMPTS or plan['maximumAttemptsPerRun'] != 2 or plan['minimumIntervalSeconds'] != 1 or plan['timeoutSeconds'] != 90 or plan['maximumResponseBytes'] != 2_000_000 or plan['retryableHttpStatuses'] != list(RETRYABLE) or plan['retryBackoffSeconds'] != [15] or plan['unresolvedFractionNumerator'] != 1 or plan['unresolvedFractionDenominator'] != 100 or any(type(plan[key]) is not int for key in ('forecastHours', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator')):
        raise ValueError('wind source plan limits changed')
    # previous failed source, old rain and exact timeout bytes stay byte-pinned
    if plan['previousRecoveryRoot'] != str(Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-recovery-20260913-v1') or plan['previousFailureProofSha256'] != PARENT_PROOF_SHA or plan['previousRetentionManifestSha256'] != PARENT_MANIFEST_SHA or plan['previousRetentionReceiptSha256'] != PARENT_RECEIPT_SHA or plan['originalManifestSha256'] != original.MANIFEST_SHA or plan['originalSourceSha256'] != original.SOURCE_SHA or plan['knownTimeoutBodySha256'] != original.sha256(KNOWN_TIMEOUT):
        raise ValueError('wind source plan lineage changed')
    expected_sources = frozenset(('acquire_rain_wind_source.py', 'verify_rain_wind_source.py', 'acquire_rain_direction.py', 'acquire_rain_direction_recovery.py', 'verify_rain_direction_recovery.py', 'verify_rain_direction_source.py', 'retain_moisture_research.py'))
    expected_freeze_fields = frozenset(('contractVersion', 'planSha256', 'previousFailureProofSha256', 'previousRetentionManifestSha256', 'previousRetentionReceiptSha256', 'sourceSha256', 'originalManifestSha256', 'originalSourceSha256', 'originalSourceBytes', 'originalSourceMtimeNs', 'inheritedRawBodies', 'missingRuns', 'maximumNewHttpRequests', 'forecastHours', 'preparedAtUtc', 'actualIssueAt', 'labelsRead', 'modelGatesEvaluated', 'productionWrites'))
    # frozen review must bind current verifier and producer source bytes
    if set(freeze) != expected_freeze_fields or freeze['contractVersion'] != plan['contractVersion'] or freeze['planSha256'] != original.sha256(plan_body) or freeze['previousFailureProofSha256'] != PARENT_PROOF_SHA or freeze['previousRetentionManifestSha256'] != PARENT_MANIFEST_SHA or freeze['previousRetentionReceiptSha256'] != PARENT_RECEIPT_SHA or freeze['originalManifestSha256'] != original.MANIFEST_SHA or freeze['originalSourceSha256'] != original.SOURCE_SHA or freeze['originalSourceBytes'] != original.SOURCE_BYTES or type(freeze['originalSourceMtimeNs']) is not int or freeze['originalSourceMtimeNs'] <= 0 or freeze['inheritedRawBodies'] != REUSED_COUNT or freeze['missingRuns'] != MISSING_COUNT or freeze['maximumNewHttpRequests'] != MAX_ATTEMPTS or freeze['forecastHours'] != 35 or set(freeze['sourceSha256']) != expected_sources:
        raise ValueError('wind source freeze contract changed')
    # preparation must precede the fixed public-query deadline
    if utc_time(freeze['preparedAtUtc']) >= utc_time(EXPIRY):
        raise ValueError('wind source prepared after expiry')
    # no labels, model gates or production authority belongs to acquisition
    if freeze['actualIssueAt'] is not None or freeze['labelsRead'] is not False or freeze['modelGatesEvaluated'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('wind source freeze scope changed')
    # source file hashes must match both frozen copy and locally executing code
    for name, expected in freeze['sourceSha256'].items():
        copied = root / 'sources' / name
        current = Path(__file__).with_name(name)
        # copied scripts cannot change after preparation
        if file_sha256(copied) != expected or file_sha256(current) != expected:
            raise ValueError('wind source frozen code changed: ' + name)
    # copied V2 result must still be exactly the prior failed source
    if previous_hashes['previousFailureProofSha256'] != freeze['previousFailureProofSha256'] or file_sha256(root / 'inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl') != original.SOURCE_SHA:
        raise ValueError('wind source old normalized bytes changed')
    return plan, {'planSha256': original.sha256(plan_body), 'freezeSha256': original.sha256(freeze_body)}


# audit one retained new HTTP attempt without invoking acquisition code
def audit_attempt(root, index, run_index, ordinal, identity):
    directory = root / f'requests/{index:04d}'
    request = old.strict_json((directory / 'request.json').read_bytes())
    receipt = old.strict_json((directory / 'receipt.json').read_bytes())
    params = expected_params(identity['run'])
    url = original.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])
    expected_request = {
        'contractVersion': 'rain-wind-source/v1',
        'requestIndex': index,
        'runIndex': run_index,
        'run': identity['run'],
        'attemptInRun': ordinal,
        'endpoint': original.ENDPOINT,
        'canonicalParams': params,
        'paramsSha256': original.sha256(original.canonical_json(params)),
        'urlSha256': original.sha256(url.encode()),
        'startedAtUtc': request['startedAtUtc'],
        'actualIssueAt': None,
    }
    receipt_fields = {'responseReceivedAtUtc', 'finishedAtUtc', 'status', 'safeHeaders', 'responseBytesObserved', 'responseBytesStored', 'bodyComplete', 'contentSha256', 'capturedSha256', 'rawBodyFile', 'result', 'errorType', 'error', 'summary', 'retryable', 'retryScheduled', 'backoffSeconds'}
    # request and receipt must bind the same exact public query and source run
    if request != expected_request or set(receipt) != set(request) | receipt_fields or any(receipt[key] != value for key, value in request.items()):
        raise ValueError('wind attempt request identity changed')
    started = utc_time(request['startedAtUtc'])
    finished = utc_time(receipt['finishedAtUtc'])
    received = receipt['responseReceivedAtUtc']
    # every request starts before deadline and has nonnegative receipt timing
    if started >= utc_time(EXPIRY) or finished < started or (received is not None and not started <= utc_time(received) <= finished):
        raise ValueError('wind attempt timing changed')
    status = receipt['status']
    # malformed or boolean http codes cannot represent a provider response
    if status is not None and (type(status) is not int or not 100 <= status <= 599):
        raise ValueError('wind attempt status changed')
    headers = receipt['safeHeaders']
    # only bounded public response headers are retained
    if not isinstance(headers, dict) or not set(headers).issubset(original.SAFE_HEADERS) or any(not isinstance(value, str) or len(value) > 256 for value in headers.values()):
        raise ValueError('wind attempt headers changed')
    body_name = receipt['rawBodyFile']
    expected_names = {'request.json', 'receipt.json'} | ({'response-body.bin'} if body_name is not None else set())
    # a missing, extra or linked response artifact is not a raw source
    if body_name not in (None, 'response-body.bin') or {path.name for path in directory.iterdir()} != expected_names or any(path.is_symlink() for path in directory.iterdir()):
        raise ValueError('wind attempt artifact set changed')
    observed = receipt['responseBytesObserved']
    stored = receipt['responseBytesStored']
    # enforce the exact two-megabyte retained response budget
    if type(observed) is not int or type(stored) is not int or not 0 <= stored <= 2_000_000 or not stored <= observed <= 2_000_001:
        raise ValueError('wind attempt body size changed')
    body, digest = None, None
    # bind retained raw bytes to receipt length, completion and hashes
    if body_name is not None:
        body = (directory / body_name).read_bytes()
        digest = original.sha256(body)
        complete = status is not None and observed <= 2_000_000
        # a truncated or partial body never obtains a complete-content hash
        if len(body) != stored or stored != min(observed, 2_000_000) or receipt['bodyComplete'] is not complete or receipt['capturedSha256'] != digest or receipt['contentSha256'] != (digest if complete else None):
            raise ValueError('wind attempt raw body hash changed')
    else:
        # transport without bytes cannot fabricate an HTTP result
        if stored != 0 or observed != 0 or receipt['bodyComplete'] is not None or receipt['contentSha256'] is not None or receipt['capturedSha256'] is not None:
            raise ValueError('wind attempt absent body invented')
    # a complete HTTP return has a received timestamp and a retained body
    if (status is not None and (body is None or received is None)) or (status is None and (received is not None or headers)):
        raise ValueError('wind attempt response provenance changed')
    # only incomplete-read transport can carry bounded partial body bytes
    if status is None and body is not None and receipt['errorType'] != 'IncompleteRead':
        raise ValueError('wind attempt partial body provenance changed')
    parsed = None
    known_timeout = status == 200 and body == KNOWN_TIMEOUT and receipt['bodyComplete'] is True
    retryable = False
    error_type, error = None, None
    # a transport exception has only explicit allowed retry classes
    if status is None:
        error_type, error = receipt['errorType'], receipt['error']
        # every failed transport records a nonempty diagnosed error
        if not isinstance(error_type, str) or not isinstance(error, str) or not error:
            raise ValueError('wind attempt transport error absent')
        retryable = error_type in {'TimeoutError', 'URLError', 'IncompleteRead', 'RemoteDisconnected'}
    elif status in RETRYABLE:
        retryable = True
        error_type, error = 'RetryableHttpStatus', f'HTTP {status}'
    elif known_timeout:
        retryable = True
        error_type, error = 'KnownStreamingTimeout', 'known streaming timeout'
    elif body is None or body == b'' or receipt['bodyComplete'] is not True:
        error_type, error = 'ResponseBodyError', 'empty or oversized response'
    elif status != 200:
        error_type, error = 'FatalHttpStatus', f'HTTP {status}'
    else:
        # only a valid 35-hour, rain-identical response can be selected
        try:
            parsed = audit_response_35(body, identity)
        except (ValueError, TypeError, KeyError):
            # schema, grid and rain mismatch must terminate without retry
            if not isinstance(receipt['errorType'], str) or not isinstance(receipt['error'], str) or not receipt['error']:
                raise ValueError('wind attempt invalid response diagnosis absent')
            error_type, error = receipt['errorType'], receipt['error']
    # reported summary and errors must agree with independently parsed bytes
    if receipt['summary'] != (response_summary(identity, parsed) if parsed is not None else None) or receipt['retryable'] is not retryable or receipt['errorType'] != error_type or receipt['error'] != error:
        raise ValueError('wind attempt classification changed')
    # first recognized transient retries once; second known timeout is explicit unknown
    expected_result = 'success' if parsed is not None else ('retryableFailure' if retryable and ordinal == 1 else ('transportUnresolved' if known_timeout and ordinal == 2 else 'failed'))
    scheduled = expected_result == 'retryableFailure'
    # a failed second transport/gateway cannot silently become unresolved
    if receipt['result'] != expected_result or receipt['retryScheduled'] is not scheduled or receipt['backoffSeconds'] != (15 if scheduled else 0):
        raise ValueError('wind attempt retry disposition changed')
    return {
        'requestIndex': index,
        'runIndex': run_index,
        'run': identity['run'],
        'attemptInRun': ordinal,
        'startedAtUtc': request['startedAtUtc'],
        'finishedAtUtc': receipt['finishedAtUtc'],
        'status': status,
        'result': expected_result,
        'errorType': error_type,
        'responseSha256': receipt['contentSha256'],
        'responseReceivedAtUtc': received,
        'rawBodyFile': f'requests/{index:04d}/response-body.bin' if body is not None else None,
        'parsed': parsed,
    }


# require chronological one-or-two-attempt resolution of every missing run
def validate_sequence(records, missing):
    selected, unresolved = {}, {}
    position, preceding = 0, None
    # every original gap receives one bounded disposition in original order
    for run_index in missing:
        # a legal first attempt may be followed by only its retry
        for ordinal in (1, 2):
            # missing attempt cannot be interpreted as an unresolved run
            if position >= len(records):
                raise ValueError('wind source attempt missing')
            item = records[position]
            started = utc_time(item['startedAtUtc'])
            # enforce contiguous attempt indices and at least one second between starts
            if item['requestIndex'] != position or item['runIndex'] != run_index or item['attemptInRun'] != ordinal or (preceding is not None and (started - utc_time(preceding['startedAtUtc'])).total_seconds() < 1):
                raise ValueError('wind source attempt order changed')
            # a retry waits fifteen seconds after the previous attempt finishes
            if ordinal == 2 and (preceding is None or preceding['runIndex'] != run_index or (started - utc_time(preceding['finishedAtUtc'])).total_seconds() < 15):
                raise ValueError('wind source retry backoff changed')
            preceding = item
            position += 1
            # only a complete 200 body or exact twice-failed known timeout closes a run
            if item['result'] == 'success':
                selected[run_index] = item
                break
            # only the second known timeout yields explicit unknown direction
            if item['result'] == 'transportUnresolved' and ordinal == 2:
                unresolved[run_index] = item
                break
            # no terminal failure can be skipped for the next original run
            if item['result'] != 'retryableFailure' or ordinal != 1:
                raise ValueError('wind source terminal attempt presented as complete')
        # two attempts without selected success or declared unknown are invalid
        if run_index not in selected and run_index not in unresolved:
            raise ValueError('wind source run disposition absent')
    # no request may follow a complete original population
    if position != len(records) or len(selected) + len(unresolved) != len(missing):
        raise ValueError('wind source extra or missing attempt')
    return selected, unresolved


# join only byte-verified prior responses and bounded new dispositions
def selected_sources(root, originals, inherited, new_selected, unresolved):
    selected = {}
    parent = root / 'inputs/previous-recovery/inputs/parent-root'
    # retain each old successful 49-hour body under its old attempt identity
    for item in inherited:
        run_index = item['runIndex']
        body = (parent / item['rawBodyPath']).read_bytes()
        parsed = original.audit_response(body, originals[run_index])
        selected[run_index] = {
            'origin': 'parentInherited',
            'attemptIndex': item['attemptIndex'],
            'rawBodyFile': 'inputs/previous-recovery/inputs/parent-root/' + item['rawBodyPath'],
            'responseSha256': original.sha256(body),
            'responseReceivedAtUtc': item['receivedAtUtc'],
            'grid': parsed['grid'],
            'direction': parsed['direction'],
            'directionLeadCount': 48,
        }
    # each newly acquired body supplies only the 34 requested positive leads
    for run_index, item in new_selected.items():
        # no new response may replace one inherited original run
        if run_index in selected or item['parsed'] is None or item['responseSha256'] is None:
            raise ValueError('wind source selected body invalid')
        selected[run_index] = {
            'origin': 'newAcquired',
            'attemptIndex': item['requestIndex'],
            'rawBodyFile': item['rawBodyFile'],
            'responseSha256': item['responseSha256'],
            'responseReceivedAtUtc': item['responseReceivedAtUtc'],
            'grid': item['parsed']['grid'],
            'direction': item['parsed']['direction'],
            'directionLeadCount': 34,
        }
    # a second exact upstream timeout carries no wind measurement at any lead
    for run_index, item in unresolved.items():
        # exact known timeout is required before a run becomes unknown
        if run_index in selected or item['result'] != 'transportUnresolved' or item['responseSha256'] != original.sha256(KNOWN_TIMEOUT):
            raise ValueError('wind source unresolved disposition invalid')
        selected[run_index] = {
            'origin': 'transportUnresolved',
            'attemptIndex': item['requestIndex'],
            'rawBodyFile': item['rawBodyFile'],
            'responseSha256': item['responseSha256'],
            'responseReceivedAtUtc': item['responseReceivedAtUtc'],
            'grid': originals[run_index]['grid'],
            'direction': None,
            'directionLeadCount': 0,
        }
    # every old run must have one source, including explicit unknown transport
    if set(selected) != set(range(original.RUNS)):
        raise ValueError('wind source selected run population incomplete')
    return selected


# stream exact old-rain/new-direction rows and run-level lineage bytes
def audit_outputs(root, originals, selected, report):
    normalized_path = root / NORMALIZED_PATH
    lineage_path = root / LINEAGE_PATH
    # do not accept a renamed source or a reduced row population
    if report['normalizedFile'] != NORMALIZED_PATH or report['normalizedRows'] != original.SOURCE_ROWS or report['responseLineageFile'] != LINEAGE_PATH or report['responseLineageRows'] != original.RUNS:
        raise ValueError('wind source output contract changed')
    statuses = {'available': 0, 'providerNull': 0, 'notRequested': 0, 'transportUnresolved': 0}
    # stream normalized and lineage bytes in old run order
    with normalized_path.open('rb') as normalized, lineage_path.open('rb') as lineage:
        # original archive chronology determines every output block
        for run_index, identity in enumerate(originals):
            source = selected[run_index]
            expected_lineage = {
                'originalRunIndex': run_index,
                'run': identity['run'],
                'origin': source['origin'],
                'sourceAttemptIndex': source['attemptIndex'],
                'rawBodyFile': source['rawBodyFile'],
                'responseSha256': source['responseSha256'],
                'responseReceivedAtUtc': source['responseReceivedAtUtc'],
                'directionLeadCount': source['directionLeadCount'],
            }
            # exact canonical bytes prevent duplicate or reordered lineage records
            if lineage.readline() != original.canonical_json(expected_lineage):
                raise ValueError(f'wind source lineage changed at run {run_index}')
            start = utc_time(identity['initialized'])
            values = direction_rows(source['origin'], source['direction'])
            # old rain remains authoritative on all forty-eight future leads
            for lead, (direction, status) in enumerate(values, 1):
                expected = {
                    'cohort': original.COHORT,
                    'key': f'{original.COHORT}|{identity["run"]}|lead={lead}',
                    'runInitializedAt': identity['initialized'],
                    'validAt': (start + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'targetLeadHours': lead,
                    'rawPrecipitationMm': identity['precipitation'][lead - 1],
                    'rawWindDirectionDegrees': direction,
                    'directionSourceStatus': status,
                    'returnedGrid': {'latitude': source['grid'][0], 'longitude': source['grid'][1]},
                    'responseSha256': source['responseSha256'],
                    'responseReceivedAtUtc': source['responseReceivedAtUtc'],
                    'actualIssueAt': None,
                }
                # no missing forecast lead can be dropped or filled with zero
                if normalized.readline() != original.canonical_json(expected):
                    raise ValueError(f'wind source normalized lead changed at run {run_index} lead {lead}')
                statuses[status] += 1
        # no extra normalized or lineage record follows the old run cohort
        if normalized.read(1) or lineage.read(1):
            raise ValueError('wind source output extra tail')
    normalized_sha = file_sha256(normalized_path)
    lineage_sha = file_sha256(lineage_path)
    # report hashes must match actual complete source files
    if report['normalizedSha256'] != normalized_sha or report['responseLineageSha256'] != lineage_sha:
        raise ValueError('wind source output hash changed')
    return {'normalizedSha256': normalized_sha, 'normalizedRows': original.SOURCE_ROWS, 'responseLineageSha256': lineage_sha, 'responseLineageRows': original.RUNS, 'directionStatusRows': statuses}


# replay the full source and every retained request into one receipt
def _audit_root(root):
    originals, inherited, previous_hashes = audit_previous(root)
    plan, freeze_hashes = audit_freeze(root, originals, inherited, previous_hashes)
    report_path = root / 'report.json'
    report_body = report_path.read_bytes()
    report = old.strict_json(report_body)
    expected_report_fields = frozenset(('contractVersion', 'status', 'sourceQualified', 'planSha256', 'freezeSha256', 'previousFailureProofSha256', 'previousRetentionManifestSha256', 'previousRetentionReceiptSha256', 'parentHttpAttempts', 'newHttpAttempts', 'totalHttpAttempts', 'attemptedLocationRequests', 'maximumNewHttpRequests', 'uniqueRepresentedRuns', 'uniqueSuccessfulRuns', 'reusedSuccessfulRuns', 'newSuccessfulRuns', 'newUnresolvedRuns', 'retryableFailuresBeforeSuccessOrStop', 'plannedMissingRuns', 'runOutcomes', 'perMonthCoverage', 'failure', 'actualIssueAt', 'labelsRead', 'modelGatesEvaluated', 'productionWrites', 'normalizedFile', 'normalizedRows', 'normalizedSha256', 'responseLineageFile', 'responseLineageRows', 'responseLineageSha256'))
    # no failed acquisition or over-cap source qualifies for model input
    if set(report) != expected_report_fields or report['contractVersion'] != plan['contractVersion'] or report['status'] != 'complete' or report['failure'] is not None or report['sourceQualified'] is not True:
        raise ValueError('wind source acquisition did not complete')
    requests = root / 'requests'
    names = {path.name for path in requests.iterdir()}
    count = len(names)
    # all HTTP starts, including retries, are contiguous and within budget
    if count < MISSING_COUNT or count > MAX_ATTEMPTS or names != {f'{index:04d}' for index in range(count)}:
        raise ValueError('wind source request set changed')
    records = []
    # inspect each request's reported run only after checking integer bounds
    for index in range(count):
        request = old.strict_json((requests / f'{index:04d}/request.json').read_bytes())
        run_index = request['runIndex']
        ordinal = request['attemptInRun']
        # avoid an arbitrary or boolean original index from untrusted json
        if type(run_index) is not int or not 0 <= run_index < original.RUNS or type(ordinal) is not int or ordinal not in (1, 2):
            raise ValueError('wind source request run index changed')
        records.append(audit_attempt(root, index, run_index, ordinal, originals[run_index]))
    new_selected, unresolved = validate_sequence(records, plan['missingRunIndices'])
    eligible, month_counts, month_failures = coverage(originals, unresolved)
    # fixed one-percent source-unknown caps are prerequisites, not model gates
    if not eligible:
        raise ValueError('wind source unresolved run cap exceeded')
    selected = selected_sources(root, originals, inherited, new_selected, unresolved)
    expected_months = {month: {'totalRuns': total, 'unresolvedRuns': month_failures[month], 'qualified': 100 * month_failures[month] <= total} for month, total in month_counts.items()}
    expected_outcomes = [{name: item[name] for name in ('requestIndex', 'runIndex', 'run', 'attemptInRun', 'result', 'status', 'errorType', 'responseSha256')} for item in records]
    # report counters must reconstruct from the exact request/response population
    if report['planSha256'] != freeze_hashes['planSha256'] or report['freezeSha256'] != freeze_hashes['freezeSha256'] or report['previousFailureProofSha256'] != PARENT_PROOF_SHA or report['previousRetentionManifestSha256'] != PARENT_MANIFEST_SHA or report['previousRetentionReceiptSha256'] != PARENT_RECEIPT_SHA or report['parentHttpAttempts'] != PARENT_ATTEMPTS or report['newHttpAttempts'] != count or report['totalHttpAttempts'] != PARENT_ATTEMPTS + count or report['attemptedLocationRequests'] != count or report['maximumNewHttpRequests'] != MAX_ATTEMPTS or report['uniqueRepresentedRuns'] != original.RUNS or report['uniqueSuccessfulRuns'] != original.RUNS - len(unresolved) or report['reusedSuccessfulRuns'] != REUSED_COUNT or report['newSuccessfulRuns'] != len(new_selected) or report['newUnresolvedRuns'] != len(unresolved) or report['retryableFailuresBeforeSuccessOrStop'] != sum(item['result'] == 'retryableFailure' for item in records) or report['plannedMissingRuns'] != MISSING_COUNT or report['runOutcomes'] != expected_outcomes or report['perMonthCoverage'] != expected_months:
        raise ValueError('wind source report counts changed')
    # acquisition is forecast-only and never scores a candidate model
    if report['actualIssueAt'] is not None or report['labelsRead'] is not False or report['modelGatesEvaluated'] is not False or report['productionWrites'] is not False:
        raise ValueError('wind source report side-effect scope changed')
    output = audit_outputs(root, originals, selected, report)
    return {
        'contractVersion': CONTRACT,
        'verdict': 'PASS',
        'scope': 'forecast_only_original_3301_runs_no_http_no_labels',
        'sourceQualified': True,
        'planSha256': freeze_hashes['planSha256'],
        'freezeSha256': freeze_hashes['freezeSha256'],
        'reportSha256': original.sha256(report_body),
        'normalizedSha256': output['normalizedSha256'],
        'normalizedRows': output['normalizedRows'],
        'responseLineageSha256': output['responseLineageSha256'],
        'responseLineageRows': output['responseLineageRows'],
        'originalManifestSha256': original.MANIFEST_SHA,
        'originalNormalizedSha256': original.SOURCE_SHA,
        'previousFailureProofSha256': PARENT_PROOF_SHA,
        'previousRetentionManifestSha256': PARENT_MANIFEST_SHA,
        'previousRetentionReceiptSha256': PARENT_RECEIPT_SHA,
        'parentHttpAttempts': PARENT_ATTEMPTS,
        'newHttpAttempts': count,
        'totalHttpAttempts': PARENT_ATTEMPTS + count,
        'uniqueRepresentedRuns': original.RUNS,
        'uniqueSuccessfulRuns': original.RUNS - len(unresolved),
        'reusedSuccessfulRuns': REUSED_COUNT,
        'newSuccessfulRuns': len(new_selected),
        'newUnresolvedRuns': len(unresolved),
        'perMonthCoverage': expected_months,
        'directionStatusRows': output['directionStatusRows'],
        'historicalAsIssuedVerified': False,
        'freshHoldoutVerified': False,
        'modelGatesEvaluated': False,
        'productionEligible': False,
        'verifierSourceSha256': file_sha256(__file__),
        'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
    }


# restrict acquisition verification to its exact private research root
def audit_full(root):
    root = Path(root).resolve()
    expected = Path.home() / '.weather/research-work' / ROOT_NAME
    # a copied tree cannot impersonate the authoritative acquired source
    if root != expected or not root.is_dir():
        raise ValueError('wind source verification root changed')
    return _audit_root(root)


# re-audit one copied source only inside the fixed wind-model input path
def audit_snapshot(root):
    root = Path(root).resolve()
    expected = Path.home() / '.weather/research-work' / WIND_ROOT_NAME / 'inputs/direction'
    # no arbitrary directory can authorize model source provenance
    if root != expected or not root.is_dir():
        raise ValueError('wind source snapshot path changed')
    return _audit_root(root)


# issue one nonreplaceable local independent source receipt
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    receipt = audit_full(arguments.root)
    output = arguments.output
    # no earlier verdict may be silently overwritten by a later replay
    if output.exists() or output.is_symlink():
        raise ValueError('wind source verifier receipt already exists')
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = output.open('xb')
    # write exactly one canonical complete receipt
    with descriptor as stream:
        stream.write(original.canonical_json(receipt))
    print(json.dumps(receipt, sort_keys=True))


# route a direct invocation through the read-only verifier CLI
if __name__ == '__main__':
    main()
