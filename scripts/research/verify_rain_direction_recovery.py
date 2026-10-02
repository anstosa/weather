"""independently audit recovered rain-direction responses without HTTP or labels."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from itertools import pairwise
from pathlib import Path
from urllib.parse import urlencode

import verify_rain_direction_source as prior

CONTRACT = 'rain-direction-recovery-verification/v1'
ACQUISITION_CONTRACT = 'rain-direction-recovery/v1'
ROOT_NAME = 'weather-moisture-research-rain-direction-recovery-20260913-v1'
WIND_ROOT_NAME = 'weather-moisture-research-rain-wind-20260913-v1'
PARENT_PROOF_SHA = '684f5ede704e569487e48fc567785ae11ba3e327a165d9837afc3ed4c006ebab'
PARTIAL_VERIFIER_SHA = '4c8f00b982277f4db314aabd5aa1ca400b25107c0d012a6420dac322b7bcc169'
PARENT_RETENTION_MANIFEST_SHA = '0500e8f49649b683844bca057f2275a30888a77d813cea6abce5108b96164ab5'
PARENT_RETENTION_RECEIPT_SHA = 'fef8fb51275ecf47cf3c3ba916cebda9f7051b1a1c9238f69d0f356e6940e434'
PARENT_ATTEMPTS = 114
PARENT_SUCCESSES = 113
FAILED_PARENT_ATTEMPT = 113
FAILED_PARENT_RUN = 108
MAX_NEW_ATTEMPTS = 9_564
MAX_ATTEMPTS_PER_RUN = 3
RETRY_STATUSES = (502, 503, 504)
RETRY_BACKOFF = (5, 15)
EXPIRY = '2026-09-14T08:00:00Z'
NORMALIZED_PATH = 'normalized/ecmwf_single_run_wind_direction.jsonl'
LINEAGE_PATH = 'response-lineage.jsonl'
SOURCE_NAMES = frozenset(('acquire_rain_direction_recovery.py', 'acquire_rain_direction.py', 'verify_rain_direction_source.py', 'retain_moisture_research.py', 'verify_rain_direction_recovery.py', 'verify_partial.py'))
PLAN_FIELDS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'parentRoot', 'parentPartialProofSha256', 'parentRetentionManifestSha256', 'parentRetentionReceiptSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'originalManifestSha256', 'originalSourceSha256'))


# hash exact retained bytes without materializing large source copies
def file_sha256(path):
    digest = hashlib.sha256()
    # consume the original eighty-three-megabyte source in bounded blocks
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


# parse v2 artifacts without duplicate fields or nonfinite numeric extensions
def strict_json(body):
    # no receipt key may mask another value
    def unique_pairs(pairs):
        result = {}
        # inspect every nested object member
        for key, value in pairs:
            # repeated fields make source lineage ambiguous
            if key in result:
                raise ValueError('duplicate recovery json key')
            result[key] = value
        return result

    # overflow exponents are nonfinite even without a NaN token
    def finite_float(value):
        parsed = float(value)
        # reject inf from otherwise valid exponent syntax
        if not math.isfinite(parsed):
            raise ValueError('nonfinite recovery json')
        return parsed

    return json.loads(body, object_pairs_hook=unique_pairs, parse_float=finite_float, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite recovery json')))


# reparse the original copied source rather than trusting mtime metadata
def original_profiles(parent):
    source_root = parent / 'inputs'
    manifest_path = source_root / 'original-manifest.json'
    normalized_path = source_root / 'original-normalized.jsonl'
    # both copied old inputs must match the immutable original cohort hashes
    if file_sha256(manifest_path) != prior.MANIFEST_SHA or file_sha256(normalized_path) != prior.SOURCE_SHA or normalized_path.stat().st_size != prior.SOURCE_BYTES:
        raise ValueError('copied original source bytes changed')
    manifest = prior.strict_json(manifest_path.read_bytes())
    cohort = manifest['cohortFiles'][prior.COHORT]
    # bind original cohort, site and all successful run identities
    if cohort != {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'bytes': prior.SOURCE_BYTES, 'rows': prior.SOURCE_ROWS, 'sha256': prior.SOURCE_SHA, 'successfulRuns': prior.RUNS} or manifest['requestCoordinates'] != {'latitude': prior.SITE[0], 'longitude': prior.SITE[1]}:
        raise ValueError('copied original manifest changed')
    identities = [item for item in manifest['identities'] if item.get('status') == 'success']
    # require every old successful run exactly once
    if len(identities) != prior.RUNS or len({item['runInitializedAt'] for item in identities}) != prior.RUNS:
        raise ValueError('copied original run count changed')
    profiles = []
    rows = 0
    with normalized_path.open('rb') as stream:
        # reconstruct every complete old forty-eight-lead forecast run
        for identity in identities:
            initialized = identity['runInitializedAt']
            run = initialized[:16]
            origin = prior.utc_time(initialized)
            grid = identity['returnedGrid']
            # old source key and returned grid must match the frozen manifest
            if identity['cohort'] != prior.COHORT or identity['key'] != f'{prior.COHORT}|{run}' or identity['model'] != 'ecmwf_ifs' or set(grid) != {'latitude', 'longitude'}:
                raise ValueError('copied original run identity changed')
            grid_pair = (prior.physical_cell(grid['latitude'], -90, 90), prior.physical_cell(grid['longitude'], -180, 180))
            rain = []
            # use one original lead for each target valid hour
            for lead in range(1, 49):
                line = stream.readline()
                # reject a missing, partial or non-jsonl source lead
                if not line.endswith(b'\n'):
                    raise ValueError('copied original source row incomplete')
                row = prior.strict_json(line)
                # bind the exact old key, initialization and valid hour
                if row['cohort'] != prior.COHORT or row['runInitializedAt'] != initialized or type(row['targetLeadHours']) is not int or row['targetLeadHours'] != lead or row['key'] != f'{prior.COHORT}|{run}|lead={lead}' or row['validAt'] != (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ') or row['actualIssueAt'] is not None:
                    raise ValueError('copied original lead identity changed')
                rain.append(prior.physical_cell(row['rawPrecipitationMm'], 0, 2_000))
                rows += 1
            profiles.append({'run': run, 'initialized': initialized, 'key': identity['key'], 'grid': grid_pair, 'precipitation': tuple(rain)})
        # a complete original cohort has no trailing rows or partial tail
        if stream.read(1) or rows != prior.SOURCE_ROWS:
            raise ValueError('copied original source row count changed')
    # preserve manifest order rather than sorting a different forecast cohort
    if any(left['run'] >= right['run'] for left, right in pairwise(profiles)):
        raise ValueError('copied original runs reordered')
    return profiles


# bind the copied V1 plan, freeze, sources and pilot authorization by bytes
def audit_parent_freeze(parent, originals):
    plan_body = (parent / 'frozen-plan.json').read_bytes()
    freeze_body = (parent / 'direction-freeze.json').read_bytes()
    plan = strict_json(plan_body)
    freeze = strict_json(freeze_body)
    # preserve the original exact request scope and old source lineage
    if set(plan) != prior.PLAN_FIELDS or plan['contractVersion'] != 'rain-direction-acquisition/v1' or plan['endpoint'] != prior.ENDPOINT or plan['site'] != {'latitude': prior.SITE[0], 'longitude': prior.SITE[1]} or plan['runs'] != [item['run'] for item in originals] or plan['pilotRuns'] != [originals[index]['run'] for index in prior.PILOT] or plan['expiresAtUtc'] != EXPIRY or plan['originalManifestSha256'] != prior.MANIFEST_SHA or plan['originalSourceSha256'] != prior.SOURCE_SHA:
        raise ValueError('copied parent plan changed')
    caps = tuple(plan[name] for name in ('maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes'))
    # original one-shot request limits must remain unchanged
    if caps != (prior.RUNS, prior.RUNS, 0, 1, 30, 2_000_000) or any(type(plan[name]) is not int for name in ('maximumHttpRequests', 'maximumLocationRequests', 'retries', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes')):
        raise ValueError('copied parent request caps changed')
    # no mtime equality is used after a byte-identical copy or encryption cycle
    if freeze['contractVersion'] != plan['contractVersion'] or freeze['planSha256'] != prior.sha256(plan_body) or freeze['runsSha256'] != prior.sha256(prior.canonical_json(plan['runs'])) or freeze['pilotRuns'] != plan['pilotRuns'] or freeze['originalManifestSha256'] != prior.MANIFEST_SHA or freeze['originalNormalizedSha256'] != prior.SOURCE_SHA or freeze['originalRoot'] != str(prior.ORIGINAL.parent) or freeze['maximumHttpRequests'] != prior.RUNS or freeze['maximumLocationRequests'] != prior.RUNS or freeze['actualIssueAt'] is not None or freeze['labelsRead'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('copied parent freeze changed')
    # retained parent producers and original dependency snapshots must be exact
    if set(freeze['sourceSha256']) != prior.PRODUCER_SOURCES or set(freeze['originalProducerSha256']) != prior.OLD_PRODUCER_SOURCES:
        raise ValueError('copied parent source list changed')
    # compare every frozen V1 producer to the separately executed verifier file
    for name, expected in freeze['sourceSha256'].items():
        # the copied producer must match its parent freeze digest
        if file_sha256(parent / 'sources' / name) != expected or file_sha256(Path(__file__).with_name(name)) != expected:
            raise ValueError('copied parent producer changed')
    # bind each copied original producer to the old manifest
    manifest = prior.strict_json((parent / 'inputs/original-manifest.json').read_bytes())
    for name, expected in freeze['originalProducerSha256'].items():
        # no old acquisition dependency can change inside the copy
        if manifest['sourceSha256'][name] != expected or file_sha256(parent / 'inputs/original-producer-sources' / name) != expected:
            raise ValueError('copied original producer changed')
    # only structural historical mtime metadata is retained, never compared
    if freeze['inputBytes'] != {'manifest': (parent / 'inputs/original-manifest.json').stat().st_size, 'normalized': (parent / 'inputs/original-normalized.jsonl').stat().st_size} or set(freeze['inputMtimeNs']) != {'manifest', 'normalized'} or any(type(value) is not int or value <= 0 for value in freeze['inputMtimeNs'].values()):
        raise ValueError('copied parent input metadata invalid')
    return {'planSha256': prior.sha256(plan_body), 'freezeSha256': prior.sha256(freeze_body)}


# reconstruct V1's terminal timeout and its one hundred thirteen valid bodies
def audit_parent(parent, proof_path, originals):
    hashes = audit_parent_freeze(parent, originals)
    proof_body = Path(proof_path).read_bytes()
    proof = prior.strict_json(proof_body)
    # the inherited partial proof must be the separately retained exact receipt
    if prior.sha256(proof_body) != PARENT_PROOF_SHA or proof['contractVersion'] != 'rain-direction-partial-verification/v1' or proof['verdict'] != 'PASS' or proof['acquisitionComplete'] is not False or proof['pilotVerified'] is not True or proof['pilotBulkEligible'] is not True or proof['validRawBodies'] != PARENT_SUCCESSES or proof['validPilotBodies'] != len(prior.PILOT) or proof['validBulkBodies'] != PARENT_SUCCESSES - len(prior.PILOT) or proof['attemptedHttpRequests'] != PARENT_ATTEMPTS or proof['attemptedLocationRequests'] != PARENT_ATTEMPTS or proof['failedRequestIndex'] != FAILED_PARENT_ATTEMPT or proof['failedRunIndex'] != FAILED_PARENT_RUN or proof['failureType'] != 'TimeoutError' or proof['partialVerifierSourceSha256'] != PARTIAL_VERIFIER_SHA or any(proof[name] is not False for name in ('historicalAsIssuedVerified', 'freshHoldoutVerified', 'modelGatesEvaluated', 'productionEligible')):
        raise ValueError('copied partial proof changed')
    pilot_records = [prior.audit_attempt(parent, index, run_index, originals[run_index]) for index, run_index in enumerate(prior.PILOT)]
    pilot_phase = prior.audit_phase_report(parent, 'pilot', pilot_records, hashes)
    gate_body = (parent / 'pilot-verification.json').read_bytes()
    gate = prior.audit_pilot_receipt(parent / 'pilot-verification.json', hashes, pilot_records, pilot_phase)
    bulk_indices = [index for index in range(prior.RUNS) if index not in set(prior.PILOT)]
    bulk_records = [prior.audit_attempt(parent, attempt, run_index, originals[run_index]) for attempt, run_index in enumerate(bulk_indices[:107], len(prior.PILOT))]
    records = pilot_records + bulk_records
    failed_directory = parent / f'requests/{FAILED_PARENT_ATTEMPT:04d}'
    # the old terminal timeout has no raw body or inferred forecast values
    if {item.name for item in failed_directory.iterdir()} != {'request.json', 'receipt.json'}:
        raise ValueError('copied parent timeout artifacts changed')
    failed_request = prior.strict_json((failed_directory / 'request.json').read_bytes())
    failed_receipt = prior.strict_json((failed_directory / 'receipt.json').read_bytes())
    original = originals[FAILED_PARENT_RUN]
    params = prior.expected_params(original['run'])
    expected_request = {'actualIssueAt': None, 'canonicalParams': params, 'endpoint': prior.ENDPOINT, 'paramsSha256': prior.sha256(prior.canonical_json(params)), 'phase': 'bulk', 'requestIndex': FAILED_PARENT_ATTEMPT, 'run': original['run'], 'runIndex': FAILED_PARENT_RUN, 'startedAtUtc': failed_request['startedAtUtc'], 'urlSha256': prior.sha256((prior.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])).encode())}
    # bind the failed attempt to its original run and frozen public query
    if failed_request != expected_request or failed_receipt != {**expected_request, 'contentSha256': None, 'error': 'The read operation timed out', 'rawBodyFile': None, 'responseReceivedAtUtc': None, 'result': 'failed', 'safeHeaders': {}, 'status': None, 'summary': None}:
        raise ValueError('copied parent timeout receipt changed')
    # stop exactly after the first failure, with no normalized complete source
    if {item.name for item in (parent / 'requests').iterdir()} != {f'{index:04d}' for index in range(PARENT_ATTEMPTS)} or (parent / 'report.json').exists() or (parent / 'normalized').exists():
        raise ValueError('copied parent source scope changed')
    starts = [prior.utc_time(item['startedAtUtc']) for item in records] + [prior.utc_time(failed_request['startedAtUtc'])]
    # uphold spacing, pilot-before-bulk gate and old deadline
    if any((later - earlier).total_seconds() < 1 for earlier, later in pairwise(starts)) or starts[len(prior.PILOT)] <= prior.utc_time(gate['verifiedAtUtc']) or starts[-1] >= prior.utc_time(EXPIRY):
        raise ValueError('copied parent request timing changed')
    bulk_body = (parent / 'bulk-report.json').read_bytes()
    bulk = prior.strict_json(bulk_body)
    expected_receipts = [{'requestIndex': item['attemptIndex'], 'runIndex': item['runIndex'], 'run': item['run'], 'result': 'success', 'status': 200, 'contentSha256': item['rawBodySha256']} for item in bulk_records]
    expected_receipts.append({'requestIndex': FAILED_PARENT_ATTEMPT, 'runIndex': FAILED_PARENT_RUN, 'run': original['run'], 'result': 'failed', 'status': None, 'contentSha256': None})
    # failed V1 phase cannot be silently reported as a complete acquisition
    if bulk['contractVersion'] != 'rain-direction-acquisition/v1' or bulk['phase'] != 'bulk' or bulk['status'] != 'failed' or bulk['failure'] != {'error': failed_receipt['error'], 'errorType': 'TimeoutError', 'phase': 'bulk', 'requestIndex': FAILED_PARENT_ATTEMPT, 'run': original['run'], 'runIndex': FAILED_PARENT_RUN} or bulk['planSha256'] != hashes['planSha256'] or bulk['freezeSha256'] != hashes['freezeSha256'] or bulk['pilotVerificationSha256'] != gate['sha256'] or bulk['plannedHttpRequests'] != prior.RUNS - len(prior.PILOT) or bulk['attemptedHttpRequests'] != PARENT_ATTEMPTS - len(prior.PILOT) or bulk['attemptedLocationRequests'] != PARENT_ATTEMPTS - len(prior.PILOT) or bulk['successfulHttpRequests'] != PARENT_SUCCESSES - len(prior.PILOT) or bulk['receipts'] != expected_receipts or bulk['runSummaries'] != [item['receiptSummary'] for item in bulk_records] or bulk['bulkEligible'] is not None or bulk['actualIssueAt'] is not None or bulk['labelsRead'] is not False or bulk['modelPerformanceScored'] is not False or bulk['productionWrites'] is not False:
        raise ValueError('copied terminal bulk report changed')
    body_hashes = {item['rawBodyPath']: item['rawBodySha256'] for item in records}
    # recompute every deterministic partial-proof field from copied raw bodies
    if proof['planSha256'] != hashes['planSha256'] or proof['freezeSha256'] != hashes['freezeSha256'] or proof['pilotReportSha256'] != pilot_phase['sha256'] or proof['pilotReceiptSha256'] != prior.sha256(gate_body) or proof['bulkReportSha256'] != prior.sha256(bulk_body) or proof['verifierSourceSha256'] != prior.sha256(Path(prior.__file__).read_bytes()) or proof['validRunIndices'] != [item['runIndex'] for item in records] or proof['failedRun'] != original['run'] or proof['rawBodyHashesSha256'] != prior.sha256(prior.canonical_json(body_hashes)) or proof['retainedRawBytes'] != sum(item['rawBodyBytes'] for item in records) or proof['directionFootprintCompleteValidRuns'] != sum(item['directionFootprintComplete'] for item in records):
        raise ValueError('copied partial proof differs from response bytes')
    return records, {'proofSha256': prior.sha256(proof_body), 'parentPlanSha256': hashes['planSha256'], 'parentFreezeSha256': hashes['freezeSha256'], 'parentBulkReportSha256': prior.sha256(bulk_body), 'parentRawBodyHashesSha256': proof['rawBodyHashesSha256'], 'inheritedAttempts': PARENT_ATTEMPTS}


# compare retained parent copies to their original encrypted manifest entries
def audit_manifest_files(parent, manifest, relatives):
    # every copied input must be named in the parent retention manifest
    for relative in relatives:
        metadata = manifest['files'][relative]
        path = parent / relative
        # bytes, not copied mtimes, are the reusable parent authority
        if path.stat().st_size != metadata['bytes'] or file_sha256(path) != metadata['sha256']:
            raise ValueError('copied retained parent file changed')


# independently validate the complete new-request plan before or after freeze
def validate_plan(plan, originals, inherited):
    missing = [index for index in range(prior.RUNS) if index not in {item['runIndex'] for item in inherited}]
    # the recovery may only request the original runs with no inherited body
    if not isinstance(plan, dict) or set(plan) != PLAN_FIELDS or plan['contractVersion'] != ACQUISITION_CONTRACT or plan['endpoint'] != prior.ENDPOINT or plan['site'] != {'latitude': prior.SITE[0], 'longitude': prior.SITE[1]} or plan['runs'] != [item['run'] for item in originals] or plan['inheritedRunIndices'] != sorted(item['runIndex'] for item in inherited) or plan['missingRunIndices'] != missing or len(missing) != prior.RUNS - PARENT_SUCCESSES or FAILED_PARENT_RUN not in missing or plan['parentRoot'] != str(Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-20260913-v1') or plan['parentPartialProofSha256'] != PARENT_PROOF_SHA or plan['parentRetentionManifestSha256'] != PARENT_RETENTION_MANIFEST_SHA or plan['parentRetentionReceiptSha256'] != PARENT_RETENTION_RECEIPT_SHA or plan['expiresAtUtc'] != EXPIRY or plan['originalManifestSha256'] != prior.MANIFEST_SHA or plan['originalSourceSha256'] != prior.SOURCE_SHA:
        raise ValueError('recovery plan source or missing population changed')
    caps = tuple(plan[name] for name in ('maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes'))
    # exact three-attempt transport budget leaves no unlimited retry path
    if caps != (MAX_NEW_ATTEMPTS, MAX_NEW_ATTEMPTS, MAX_ATTEMPTS_PER_RUN, 1, 90, 2_000_000) or any(type(plan[name]) is not int for name in ('maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes')) or plan['retryableHttpStatuses'] != list(RETRY_STATUSES) or plan['retryBackoffSeconds'] != list(RETRY_BACKOFF):
        raise ValueError('recovery request or retry caps changed')
    return missing


# bind the V2 plan, frozen sources and retained V1 encryption proof by content
def audit_freeze(root, originals, inherited, parent_info):
    plan_body = (root / 'frozen-plan.json').read_bytes()
    freeze_body = (root / 'recovery-freeze.json').read_bytes()
    plan = strict_json(plan_body)
    freeze = strict_json(freeze_body)
    validate_plan(plan, originals, inherited)
    receipt_path = root / 'inputs/parent-retention-receipt.json'
    manifest_path = root / 'inputs/parent-root/retention-manifest.json'
    # verify the prior encrypted retention receipt and manifest exact bytes
    if file_sha256(receipt_path) != PARENT_RETENTION_RECEIPT_SHA or file_sha256(manifest_path) != PARENT_RETENTION_MANIFEST_SHA:
        raise ValueError('parent retention proof changed')
    retention = strict_json(receipt_path.read_bytes())
    manifest = strict_json(manifest_path.read_bytes())
    # byte-pinned retention must have completed a local encrypted roundtrip
    if retention['contractVersion'] != 'rain-direction-partial-retention/v1' or retention['verdict'] != 'PASS' or retention['manifestSha256'] != PARENT_RETENTION_MANIFEST_SHA or retention['encryptedRoundtripVerified'] is not True or retention['productionDatabaseOrServiceWrites'] is not False or retention['remoteCopyPerformed'] is not False or manifest['acquisitionComplete'] is not False or manifest['modelGatesEvaluated'] is not False or manifest['productionEligible'] is not False:
        raise ValueError('parent retention completion changed')
    copied_parent = root / 'inputs/parent-root'
    required_parent = ('frozen-plan.json', 'direction-freeze.json', 'pilot-report.json', 'bulk-report.json', 'pilot-verification.json', 'final-evidence/independent-partial-verification.json', 'inputs/original-manifest.json', 'inputs/original-normalized.jsonl', *(f'inputs/original-producer-sources/{name}' for name in prior.OLD_PRODUCER_SOURCES), *(f'sources/{name}' for name in prior.PRODUCER_SOURCES))
    # each copied parent identity must appear unchanged in its old archive manifest
    audit_manifest_files(copied_parent, manifest, required_parent)
    # freeze binds exact plan, parent, old source and all reviewed code bytes
    if freeze['contractVersion'] != ACQUISITION_CONTRACT or freeze['planSha256'] != prior.sha256(plan_body) or freeze['parentPartialProofSha256'] != PARENT_PROOF_SHA or freeze['parentRetentionManifestSha256'] != PARENT_RETENTION_MANIFEST_SHA or freeze['parentRetentionReceiptSha256'] != PARENT_RETENTION_RECEIPT_SHA or freeze['parentPlanSha256'] != parent_info['parentPlanSha256'] or freeze['parentFreezeSha256'] != parent_info['parentFreezeSha256'] or freeze['parentBulkReportSha256'] != parent_info['parentBulkReportSha256'] or freeze['parentRawBodyHashesSha256'] != parent_info['parentRawBodyHashesSha256'] or freeze['originalManifestSha256'] != prior.MANIFEST_SHA or freeze['originalSourceSha256'] != prior.SOURCE_SHA or freeze['originalSourceBytes'] != prior.SOURCE_BYTES or type(freeze['originalSourceMtimeNs']) is not int or freeze['originalSourceMtimeNs'] <= 0 or freeze['inheritedRawBodies'] != PARENT_SUCCESSES or freeze['missingRuns'] != prior.RUNS - PARENT_SUCCESSES or freeze['maximumNewHttpRequests'] != MAX_NEW_ATTEMPTS or freeze['actualIssueAt'] is not None or freeze['labelsRead'] is not False or freeze['productionWrites'] is not False or set(freeze['sourceSha256']) != SOURCE_NAMES:
        raise ValueError('recovery freeze lineage changed')
    # copied code must match the executing verifier and producer dependencies
    for name, expected in freeze['sourceSha256'].items():
        copied = root / 'sources' / name
        # the partial source is only frozen, while current code is executable
        current = None if name == 'verify_partial.py' else Path(__file__).with_name(name)
        if file_sha256(copied) != expected or (current is not None and file_sha256(current) != expected) or (name == 'verify_partial.py' and expected != PARTIAL_VERIFIER_SHA):
            raise ValueError('recovery source bytes changed')
    return plan, {'planSha256': prior.sha256(plan_body), 'freezeSha256': prior.sha256(freeze_body), 'parentRetentionManifestSha256': PARENT_RETENTION_MANIFEST_SHA, 'parentRetentionReceiptSha256': PARENT_RETENTION_RECEIPT_SHA}


# reconstruct the complete V1-style response summary from an audited raw body
def response_summary(original, profile):
    return {
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


# audit one new request, including every retained failure and body byte
def audit_new_attempt(root, attempt_index, run_index, attempt_in_run, original):
    # one requested run receives only bounded integer attempt ordinals
    if type(attempt_index) is not int or type(run_index) is not int or type(attempt_in_run) is not int or not 1 <= attempt_in_run <= MAX_ATTEMPTS_PER_RUN:
        raise ValueError('invalid recovery attempt ordinal')
    directory = root / f'requests/{attempt_index:04d}'
    request = strict_json((directory / 'request.json').read_bytes())
    receipt = strict_json((directory / 'receipt.json').read_bytes())
    params = prior.expected_params(original['run'])
    url = prior.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])
    expected_request = {
        'contractVersion': ACQUISITION_CONTRACT,
        'requestIndex': attempt_index,
        'runIndex': run_index,
        'run': original['run'],
        'attemptInRun': attempt_in_run,
        'endpoint': prior.ENDPOINT,
        'canonicalParams': params,
        'paramsSha256': prior.sha256(prior.canonical_json(params)),
        'urlSha256': prior.sha256(url.encode()),
        'startedAtUtc': request['startedAtUtc'],
        'actualIssueAt': None,
    }
    receipt_fields = {'responseReceivedAtUtc', 'finishedAtUtc', 'status', 'safeHeaders', 'responseBytesObserved', 'responseBytesStored', 'bodyComplete', 'contentSha256', 'capturedSha256', 'rawBodyFile', 'result', 'errorType', 'error', 'summary', 'retryable', 'retryScheduled', 'backoffSeconds'}
    # request and receipt may not invent a new endpoint or hide provenance
    if request != expected_request or not isinstance(receipt, dict) or set(receipt) != set(request) | receipt_fields or any(receipt[name] != value for name, value in request.items()):
        raise ValueError('recovery attempt request or receipt identity changed')
    started = prior.utc_time(request['startedAtUtc'])
    finished = prior.utc_time(receipt['finishedAtUtc'])
    # bound one HTTP start by the fixed deadline and its recorded completion
    if started >= prior.utc_time(EXPIRY) or finished < started:
        raise ValueError('recovery attempt timing changed')
    received = receipt['responseReceivedAtUtc']
    # an HTTP response timestamp must follow its start and precede completion
    if received is not None and not started <= prior.utc_time(received) <= finished:
        raise ValueError('recovery response timing changed')
    # response headers are a bounded allowlist rather than source credentials
    if not isinstance(receipt['safeHeaders'], dict) or not set(receipt['safeHeaders']).issubset(prior.SAFE_HEADERS) or any(not isinstance(value, str) or len(value) > 256 for value in receipt['safeHeaders'].values()):
        raise ValueError('recovery response headers changed')
    status = receipt['status']
    # status is one integer HTTP result or absent for a transport failure
    if status is not None and (type(status) is not int or status < 100 or status > 599):
        raise ValueError('invalid recovery http status')
    body_name = receipt['rawBodyFile']
    expected_files = {'request.json', 'receipt.json'} | ({'response-body.bin'} if body_name is not None else set())
    # a missing or extra raw body cannot be inferred from receipt fields
    if {item.name for item in directory.iterdir()} != expected_files or body_name not in (None, 'response-body.bin'):
        raise ValueError('recovery body artifact set changed')
    observed, stored = receipt['responseBytesObserved'], receipt['responseBytesStored']
    # forbid booleans, negative lengths and bytes beyond the fixed cap
    if type(observed) is not int or type(stored) is not int or observed < 0 or stored < 0 or stored > 2_000_000:
        raise ValueError('recovery body byte counts changed')
    body, body_sha, profile = None, None, None
    # verify every retained body against its complete or truncated digest
    if body_name is not None:
        body = (directory / body_name).read_bytes()
        body_sha = prior.sha256(body)
        complete = status is not None and observed <= 2_000_000
        # a truncated response retains exactly the first two million bytes
        if len(body) != stored or stored != min(observed, 2_000_000) or observed > 2_000_001 or receipt['bodyComplete'] is not complete or receipt['capturedSha256'] != body_sha or receipt['contentSha256'] != (body_sha if complete else None) or (status is not None and received is None):
            raise ValueError('recovery response body digest or length changed')
    else:
        # a transport exception has no status, headers, body or response time
        if observed != 0 or stored != 0 or receipt['bodyComplete'] is not None or receipt['contentSha256'] is not None or receipt['capturedSha256'] is not None or received is not None or status is not None or receipt['safeHeaders'] != {}:
            raise ValueError('recovery transport failure invented a response')
    # an incomplete read may retain partial bytes without an HTTP status
    if (status is not None and body is None) or (status is None and body is not None and (receipt['errorType'] != 'IncompleteRead' or received is not None or receipt['safeHeaders'] != {})):
        raise ValueError('recovery transport and body disagree')
    retryable = False
    expected_error_type, expected_error = None, None
    # a full valid 200 body is the only acceptable selected success
    if status == 200 and body and receipt['bodyComplete'] is True:
        try:
            profile = prior.audit_response(body, original)
        except (ValueError, TypeError, KeyError):
            # schema, grid or rain-parity failure is always terminal
            if receipt['result'] != 'failed' or receipt['retryable'] is not False or receipt['retryScheduled'] is not False or receipt['backoffSeconds'] != 0 or receipt['summary'] is not None or not isinstance(receipt['errorType'], str) or not isinstance(receipt['error'], str) or not receipt['error']:
                raise ValueError('recovery invalid response retried')
        else:
            # all 49 hours and exact old precipitation must match the receipt
            if receipt['result'] != 'success' or receipt['summary'] != response_summary(original, profile) or receipt['errorType'] is not None or receipt['error'] is not None or receipt['retryable'] is not False or receipt['retryScheduled'] is not False or receipt['backoffSeconds'] != 0:
                raise ValueError('recovery successful response changed')
    else:
        # explicit gateway statuses retry even with empty or oversized bodies
        if status in RETRY_STATUSES:
            retryable = True
            expected_error_type, expected_error = 'RetryableHttpStatus', f'HTTP {status}'
        elif status is None:
            # only the producer's explicit transport exception classes retry
            retryable = receipt['errorType'] in {'TimeoutError', 'URLError', 'IncompleteRead', 'RemoteDisconnected'}
            expected_error_type = receipt['errorType']
            expected_error = receipt['error']
            # an unknown transport exception is terminal and still descriptive
            if not isinstance(expected_error_type, str) or not isinstance(expected_error, str) or not expected_error:
                raise ValueError('recovery transport exception not recorded')
        elif body is not None and (not body or receipt['bodyComplete'] is False):
            expected_error_type, expected_error = 'ResponseBodyError', 'empty or oversized response'
        elif status is not None:
            expected_error_type, expected_error = 'FatalHttpStatus', f'HTTP {status}'
        # no failed attempt may carry a successful forecast summary
        if receipt['summary'] is not None or receipt['errorType'] != expected_error_type or receipt['error'] != expected_error:
            raise ValueError('recovery failure classification changed')
    # a failed run gets only the two preregistered retry backoffs
    if profile is None and retryable and attempt_in_run < MAX_ATTEMPTS_PER_RUN:
        expected_result, scheduled, backoff = 'retryableFailure', True, RETRY_BACKOFF[attempt_in_run - 1]
    elif profile is None:
        expected_result, scheduled, backoff = 'failed', False, 0
    else:
        expected_result, scheduled, backoff = 'success', False, 0
    # reject a retry of 429, bad parity, bad schema or exhausted third attempt
    if receipt['result'] != expected_result or receipt['retryable'] is not retryable or receipt['retryScheduled'] is not scheduled or receipt['backoffSeconds'] != backoff:
        raise ValueError('recovery retry policy changed')
    return {
        'requestIndex': attempt_index,
        'runIndex': run_index,
        'run': original['run'],
        'attemptInRun': attempt_in_run,
        'startedAtUtc': request['startedAtUtc'],
        'finishedAtUtc': receipt['finishedAtUtc'],
        'result': receipt['result'],
        'status': status,
        'errorType': receipt['errorType'],
        'responseSha256': receipt['contentSha256'],
        'responseReceivedAtUtc': received,
        'retryScheduled': scheduled,
        'backoffSeconds': backoff,
        'rawBodyFile': f'requests/{attempt_index:04d}/response-body.bin' if body is not None else None,
        'rawBodyBytes': stored,
        'profile': profile,
    }


# require only missing original runs in order with legal bounded retries
def validate_attempt_sequence(records, missing_run_indices):
    # at least one new attempt is required for each inherited gap
    if len(records) < len(missing_run_indices) or len(records) > MAX_NEW_ATTEMPTS:
        raise ValueError('recovery attempt count outside fixed population')
    position = 0
    previous = None
    successful = {}
    # resolve one missing original run before moving to the next
    for run_index in missing_run_indices:
        # no prior run may consume this run's one selected success
        for ordinal in range(1, MAX_ATTEMPTS_PER_RUN + 1):
            # a missing attempted file cannot become an inferred success
            if position >= len(records):
                raise ValueError('recovery missing run response')
            record = records[position]
            started = prior.utc_time(record['startedAtUtc'])
            # bind global request indices and at least one second between starts
            if record['requestIndex'] != position or record['runIndex'] != run_index or record['attemptInRun'] != ordinal or (previous is not None and (started - prior.utc_time(previous['startedAtUtc'])).total_seconds() < 1):
                raise ValueError('recovery attempt order or spacing changed')
            # a retry must wait after the preceding attempt has ended
            if previous is not None and previous['runIndex'] == run_index and (started - prior.utc_time(previous['finishedAtUtc'])).total_seconds() < previous['backoffSeconds']:
                raise ValueError('recovery retry backoff changed')
            previous = record
            position += 1
            # a unique 200 response closes this original run
            if record['result'] == 'success':
                successful[run_index] = record
                break
            # a forbidden or exhausted failure cannot authorize another run
            if record['result'] != 'retryableFailure' or not record['retryScheduled'] or ordinal == MAX_ATTEMPTS_PER_RUN:
                raise ValueError('recovery terminal failure presented as complete')
        # a third failed attempt never silently advances the missing run list
        if run_index not in successful:
            raise ValueError('recovery retry budget exhausted')
    # no extra request may follow the last selected successful response
    if position != len(records) or len(successful) != len(missing_run_indices):
        raise ValueError('recovery extra attempt or missing success')
    return successful


# stream exact normalized and lineage rows against selected retained bodies
def audit_outputs(root, originals, selected, report):
    normalized_path = root / NORMALIZED_PATH
    lineage_path = root / LINEAGE_PATH
    # complete output paths and reported row counts cannot be swapped
    if report['normalizedFile'] != NORMALIZED_PATH or report['normalizedRows'] != len(originals) * 48 or report['responseLineageFile'] != LINEAGE_PATH or report['responseLineageRows'] != len(originals):
        raise ValueError('recovery output contract changed')
    null_directions = 0
    with normalized_path.open('rb') as normalized, lineage_path.open('rb') as lineage:
        # original chronological order is independent of request attempt order
        for run_index, original in enumerate(originals):
            chosen = selected[run_index]
            profile = chosen['profile']
            expected_lineage = {
                'originalRunIndex': run_index,
                'run': original['run'],
                'origin': chosen['origin'],
                'sourceAttemptIndex': chosen['attemptIndex'],
                'rawBodyFile': chosen['rawBodyFile'],
                'responseSha256': chosen['bodySha256'],
                'responseReceivedAtUtc': chosen['responseReceivedAtUtc'],
            }
            # exact canonical row bytes bind lineage to the selected response
            if lineage.readline() != prior.canonical_json(expected_lineage):
                raise ValueError(f'recovery response lineage changed at run {run_index}')
            origin = prior.utc_time(original['initialized'])
            # every one-based target lead inherits old rain and new direction
            for lead in range(1, 49):
                expected = {
                    'cohort': prior.COHORT,
                    'key': f'{prior.COHORT}|{original["run"]}|lead={lead}',
                    'runInitializedAt': original['initialized'],
                    'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'targetLeadHours': lead,
                    'rawPrecipitationMm': original['precipitation'][lead - 1],
                    'rawWindDirectionDegrees': profile['direction'][lead],
                    'returnedGrid': {'latitude': profile['grid'][0], 'longitude': profile['grid'][1]},
                    'responseSha256': chosen['bodySha256'],
                    'responseReceivedAtUtc': chosen['responseReceivedAtUtc'],
                    'actualIssueAt': None,
                }
                # canonical byte equality also rejects boolean or rounded leads
                if normalized.readline() != prior.canonical_json(expected):
                    raise ValueError(f'recovery normalized row changed at run {run_index} lead {lead}')
                null_directions += expected['rawWindDirectionDegrees'] is None
        # no extra normalized or lineage record may follow the old cohort
        if normalized.read(1) or lineage.read(1):
            raise ValueError('recovery normalized or lineage tail changed')
    normalized_sha = file_sha256(normalized_path)
    lineage_sha = file_sha256(lineage_path)
    # final report must bind exact reconstructed file bytes
    if report['normalizedSha256'] != normalized_sha or report['responseLineageSha256'] != lineage_sha:
        raise ValueError('recovery output hashes changed')
    return {'normalizedSha256': normalized_sha, 'normalizedRows': len(originals) * 48, 'responseLineageSha256': lineage_sha, 'responseLineageRows': len(originals), 'directionNullRows': null_directions}


# independently replay inherited and newly acquired sources into one verdict
def _audit_root(root):
    parent = root / 'inputs/parent-root'
    originals = original_profiles(parent)
    inherited, parent_info = audit_parent(parent, parent / 'final-evidence/independent-partial-verification.json', originals)
    plan, freeze_hashes = audit_freeze(root, originals, inherited, parent_info)
    report_path = root / 'report.json'
    report_body = report_path.read_bytes()
    report = strict_json(report_body)
    # a terminal failure is retained evidence, never a complete model source
    if report['contractVersion'] != ACQUISITION_CONTRACT or report['status'] != 'complete' or report['failure'] is not None:
        raise ValueError('recovery did not complete')
    requests = root / 'requests'
    names = {item.name for item in requests.iterdir()}
    count = len(names)
    # all and only contiguous new attempts must fit the frozen budget
    if count < len(plan['missingRunIndices']) or count > MAX_NEW_ATTEMPTS or names != {f'{index:04d}' for index in range(count)}:
        raise ValueError('recovery request set incomplete or expanded')
    records = []
    # independently validate each new request against its old source run
    for index in range(count):
        request = strict_json((requests / f'{index:04d}/request.json').read_bytes())
        run_index = request['runIndex']
        ordinal = request['attemptInRun']
        # avoid indexing an arbitrary or boolean run from untrusted request data
        if type(run_index) is not int or not 0 <= run_index < prior.RUNS:
            raise ValueError('recovery request run index invalid')
        records.append(audit_new_attempt(root, index, run_index, ordinal, originals[run_index]))
    new_selected = validate_attempt_sequence(records, plan['missingRunIndices'])
    selected = {}
    # old selected responses remain under the copied parent, never refetched
    for item in inherited:
        path = parent / item['rawBodyPath']
        profile = prior.audit_response(path.read_bytes(), originals[item['runIndex']])
        selected[item['runIndex']] = {'origin': 'parentInherited', 'attemptIndex': item['attemptIndex'], 'rawBodyFile': 'inputs/parent-root/' + item['rawBodyPath'], 'bodySha256': item['rawBodySha256'], 'responseReceivedAtUtc': item['receivedAtUtc'], 'profile': profile}
    # each previously missing run contributes exactly one audited new success
    for run_index, item in new_selected.items():
        # a newly acquired raw body cannot replace an inherited body
        if run_index in selected:
            raise ValueError('recovery selected duplicate original run')
        selected[run_index] = {'origin': 'newAcquired', 'attemptIndex': item['requestIndex'], 'rawBodyFile': item['rawBodyFile'], 'bodySha256': item['responseSha256'], 'responseReceivedAtUtc': item['responseReceivedAtUtc'], 'profile': item['profile']}
    # complete source selection means one body for every old run exactly once
    if set(selected) != set(range(prior.RUNS)):
        raise ValueError('recovery selected source set incomplete')
    expected_outcomes = [{name: item[name] for name in ('requestIndex', 'runIndex', 'run', 'attemptInRun', 'result', 'status', 'errorType', 'responseSha256')} for item in records]
    # bind terminal report counters, parent failure and nonproduction flags
    if report['planSha256'] != freeze_hashes['planSha256'] or report['freezeSha256'] != freeze_hashes['freezeSha256'] or report['parentPartialProofSha256'] != PARENT_PROOF_SHA or report['parentRetentionManifestSha256'] != PARENT_RETENTION_MANIFEST_SHA or report['parentRetentionReceiptSha256'] != PARENT_RETENTION_RECEIPT_SHA or report['parentHttpAttempts'] != PARENT_ATTEMPTS or report['newHttpAttempts'] != count or report['totalHttpAttempts'] != PARENT_ATTEMPTS + count or report['attemptedLocationRequests'] != count or report['maximumNewHttpRequests'] != MAX_NEW_ATTEMPTS or report['uniqueSuccessfulRuns'] != prior.RUNS or report['reusedSuccessfulRuns'] != PARENT_SUCCESSES or report['newSuccessfulRuns'] != prior.RUNS - PARENT_SUCCESSES or report['retryableFailuresBeforeSuccessOrStop'] != sum(item['result'] == 'retryableFailure' for item in records) or report['parentFailedAttemptIndex'] != FAILED_PARENT_ATTEMPT or report['parentFailedRunIndex'] != FAILED_PARENT_RUN or report['plannedMissingRuns'] != prior.RUNS - PARENT_SUCCESSES or report['runOutcomes'] != expected_outcomes or report['actualIssueAt'] is not None or report['labelsRead'] is not False or report['modelGatesEvaluated'] is not False or report['productionWrites'] is not False:
        raise ValueError('recovery terminal report changed')
    output = audit_outputs(root, originals, selected, report)
    return {
        'contractVersion': CONTRACT,
        'verdict': 'PASS',
        'scope': 'forecast_only_3301_original_runs_no_http_no_labels',
        'planSha256': freeze_hashes['planSha256'],
        'freezeSha256': freeze_hashes['freezeSha256'],
        'reportSha256': prior.sha256(report_body),
        'normalizedSha256': output['normalizedSha256'],
        'normalizedRows': output['normalizedRows'],
        'responseLineageSha256': output['responseLineageSha256'],
        'responseLineageRows': output['responseLineageRows'],
        'originalManifestSha256': prior.MANIFEST_SHA,
        'originalNormalizedSha256': prior.SOURCE_SHA,
        'parentPartialProofSha256': PARENT_PROOF_SHA,
        'parentRetentionManifestSha256': PARENT_RETENTION_MANIFEST_SHA,
        'parentRetentionReceiptSha256': PARENT_RETENTION_RECEIPT_SHA,
        'inheritedParentAttempts': PARENT_ATTEMPTS,
        'reusedSuccess': PARENT_SUCCESSES,
        'totalNewAttempts': count,
        'uniqueSuccessfulRuns': prior.RUNS,
        'directionNullRows': output['directionNullRows'],
        'historicalAsIssuedVerified': False,
        'freshHoldoutVerified': False,
        'modelGatesEvaluated': False,
        'productionEligible': False,
        'verifierSourceSha256': file_sha256(__file__),
        'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
    }


# restrict authoritative acquisition verification to its frozen private root
def audit_full(root):
    root = Path(root).resolve()
    expected = Path.home() / '.weather/research-work' / ROOT_NAME
    # another directory cannot replace the acquisition's root-owned verdict
    if root != expected or not root.is_dir():
        raise ValueError('recovery verification root changed')
    return _audit_root(root)


# re-audit a byte-copied source only inside the fixed wind model input path
def audit_snapshot(root):
    root = Path(root).resolve()
    expected = Path.home() / '.weather/research-work' / WIND_ROOT_NAME / 'inputs/direction'
    # model replay must use its own retained source copy, not a live alias
    if root != expected or not root.is_dir():
        raise ValueError('wind direction snapshot path changed')
    return _audit_root(root)


# write one nonreplaceable full verification receipt outside the private source
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    receipt = audit_full(args.root)
    output = args.output
    # no previous independent verdict may be replaced after a replay
    if output.exists() or output.is_symlink():
        raise ValueError('recovery verification receipt already exists')
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # expose the complete proof only after all source checks pass
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(prior.canonical_json(receipt))
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps(receipt, sort_keys=True), flush=True)


# run only local file verification without a network client
if __name__ == '__main__':
    main()
