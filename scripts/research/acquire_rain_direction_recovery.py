"""recover only missing direction responses after a verified terminal timeout."""

import argparse
import datetime as dt
import http.client
import json
import os
import time
from pathlib import Path
from urllib import error, parse

import acquire_rain_direction as previous

CONTRACT = 'rain-direction-recovery/v1'
PARENT_ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-direction-20260913-v1'
PARTIAL_PROOF = PARENT_ROOT / 'final-evidence/independent-partial-verification.json'
PARTIAL_PROOF_SHA256 = '684f5ede704e569487e48fc567785ae11ba3e327a165d9837afc3ed4c006ebab'
PARTIAL_VERIFIER = Path(__file__).resolve().parents[2] / '.omx/evidence/rain-direction-20260913/verify_partial.py'
PARTIAL_VERIFIER_SHA256 = '4c8f00b982277f4db314aabd5aa1ca400b25107c0d012a6420dac322b7bcc169'
RETENTION_MANIFEST_SHA256 = '0500e8f49649b683844bca057f2275a30888a77d813cea6abce5108b96164ab5'
RETENTION_RECEIPT_SHA256 = 'fef8fb51275ecf47cf3c3ba916cebda9f7051b1a1c9238f69d0f356e6940e434'
RETENTION_CIPHER_SHA256 = 'd4ff58530d1d63e9f41bef79594c576756a96bc8b9e741d3b5a9df8dc192fb9b'
RETENTION_RECEIPT = Path.home() / '.weather/model-evidence/rain-direction-20260913/retention-receipt.json'
PARENT_SUCCESS = 113
PARENT_ATTEMPTS = 114
PARENT_FAILURE_INDEX = 113
PARENT_FAILURE_RUN_INDEX = 108
MISSING_COUNT = 3_188
NEW_HTTP_CAP = 9_564
EXPIRY = '2026-09-14T08:00:00Z'
RETRYABLE_STATUSES = (502, 503, 504)
BACKOFFS = (5, 15)
SOURCE_FILES = ('acquire_rain_direction_recovery.py', 'acquire_rain_direction.py', 'verify_rain_direction_source.py', 'retain_moisture_research.py', 'verify_rain_direction_recovery.py')
PLAN_KEYS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'parentRoot', 'parentPartialProofSha256', 'parentRetentionManifestSha256', 'parentRetentionReceiptSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'originalManifestSha256', 'originalSourceSha256'))
PARENT_FILES = ('frozen-plan.json', 'direction-freeze.json', 'pilot-report.json', 'bulk-report.json', 'pilot-verification.json', 'retention-manifest.json', 'final-evidence/independent-partial-verification.json', 'inputs/original-manifest.json', 'inputs/original-normalized.jsonl')
NORMALIZED_FILE = 'normalized/ecmwf_single_run_wind_direction.jsonl'
LINEAGE_FILE = 'response-lineage.jsonl'


class RecoveryError(ValueError):
    """mark a terminal bounded transport recovery."""


# bind the exact immutable independent partial verdict
def partial_proof(path):
    body = Path(path).read_bytes()
    # a different verdict cannot change the missing source population
    if previous.sha256(body) != PARTIAL_PROOF_SHA256:
        raise RecoveryError('parent partial proof changed')
    proof = previous.strict_json(body)
    expected_indices = list(previous.PILOT_POSITIONS) + [index for index in range(previous.RUN_COUNT) if index not in previous.PILOT_POSITIONS][:107]
    # both successful source rows and the failed attempt are fixed
    if not isinstance(proof, dict) or proof.get('contractVersion') != 'rain-direction-partial-verification/v1' or proof.get('verdict') != 'PASS' or proof.get('acquisitionComplete') is not False or proof.get('validRawBodies') != PARENT_SUCCESS or proof.get('validPilotBodies') != 6 or proof.get('validBulkBodies') != 107 or proof.get('attemptedHttpRequests') != PARENT_ATTEMPTS or proof.get('validRunIndices') != expected_indices or proof.get('failedRequestIndex') != PARENT_FAILURE_INDEX or proof.get('failedRunIndex') != PARENT_FAILURE_RUN_INDEX or proof.get('failureType') != 'TimeoutError' or proof.get('partialVerifierSourceSha256') != PARTIAL_VERIFIER_SHA256 or proof.get('verifierSourceSha256') != previous.file_sha256(Path(previous.__file__).with_name('verify_rain_direction_source.py')):
        raise RecoveryError('parent partial proof contract changed')
    return proof


# load only old forecast inputs and reconstruct exact source parity
def originals_from(parent):
    manifest, runs, grids = previous.original_manifest(parent / 'inputs/original-manifest.json')
    rain = previous.original_profiles(parent / 'inputs/original-normalized.jsonl', manifest, runs)
    return runs, {run: {'grid': grids[run], 'rain': rain[run]} for run in runs}


# require one immutable success body or the single known failed request
def parent_attempt(parent, index, run_index, run, original, successful):
    directory = parent / f'requests/{index:04d}'
    # no source response is inferred for the timed-out parent request
    expected_files = {'request.json', 'receipt.json', 'response-body.bin'} if successful else {'request.json', 'receipt.json'}
    if not directory.is_dir() or directory.is_symlink() or {path.name for path in directory.iterdir()} != expected_files:
        raise RecoveryError('parent request artifact set changed')
    request = previous.strict_json((directory / 'request.json').read_bytes())
    receipt = previous.strict_json((directory / 'receipt.json').read_bytes())
    params = [list(pair) for pair in previous.request_parameters(run)]
    # match the exact old request index, original run and public query
    if request.get('requestIndex') != index or request.get('runIndex') != run_index or request.get('run') != run or request.get('canonicalParams') != params or request.get('endpoint') != previous.ENDPOINT or request.get('actualIssueAt') is not None or receipt.get('requestIndex') != index or receipt.get('runIndex') != run_index or receipt.get('run') != run or receipt.get('actualIssueAt') is not None:
        raise RecoveryError('parent request identity changed')
    # preserve an explicit terminal timeout rather than manufacturing rain
    if not successful:
        if receipt.get('result') != 'failed' or receipt.get('status') is not None or receipt.get('contentSha256') is not None or receipt.get('rawBodyFile') is not None or receipt.get('error') != 'The read operation timed out':
            raise RecoveryError('parent timeout evidence changed')
        return None
    body = (directory / 'response-body.bin').read_bytes()
    summary, _, _ = previous.validate_response(body, run, original)
    # only independently audited complete successful bodies are inherited
    if receipt.get('result') != 'success' or receipt.get('status') != 200 or receipt.get('bodyComplete') is not True or receipt.get('contentSha256') != previous.sha256(body) or receipt.get('summary') != summary or receipt.get('responseBytesStored') != len(body):
        raise RecoveryError('parent successful response changed')
    return {'runIndex': run_index, 'run': run, 'attemptIndex': index, 'bodySha256': previous.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{index:04d}/response-body.bin'}


# independently rejoin all parent success bodies and their single failure
def audit_parent(parent, proof, runs, originals):
    parent = Path(parent)
    # neither the old root nor its copied snapshot may claim completion
    if (parent / 'report.json').exists() or (parent / 'normalized').exists():
        raise RecoveryError('parent acquisition is not terminal partial')
    # the encrypted-roundtrip manifest binds every copied parent source byte
    if previous.file_sha256(parent / 'retention-manifest.json') != RETENTION_MANIFEST_SHA256:
        raise RecoveryError('parent retention manifest changed')
    retention = previous.strict_json((parent / 'retention-manifest.json').read_bytes())
    entries = retention.get('files') if isinstance(retention, dict) else None
    if not isinstance(retention, dict) or retention.get('contractVersion') != 'rain-direction-partial-private-retention/v1' or retention.get('acquisitionComplete') is not False or not isinstance(entries, dict):
        raise RecoveryError('parent retention scope changed')
    selected_files = [name for name in PARENT_FILES if name != 'retention-manifest.json']
    selected_files += [f'inputs/original-producer-sources/{name}' for name in previous.ORIGINAL_PRODUCERS]
    selected_files += [f'sources/{name}' for name in previous.SOURCE_FILES]
    # inherited attempts include one terminal request with no raw body
    for index in range(PARENT_ATTEMPTS):
        selected_files.extend(f'requests/{index:04d}/{name}' for name in (('request.json', 'receipt.json', 'response-body.bin') if index < PARENT_SUCCESS else ('request.json', 'receipt.json')))
    # no file can silently drift from the retained independent archive
    for name in selected_files:
        path = parent / name
        expected = entries.get(name)
        if path.is_symlink() or not path.is_file() or not isinstance(expected, dict) or expected.get('bytes') != path.stat().st_size or expected.get('sha256') != previous.file_sha256(path):
            raise RecoveryError('parent retained file changed: ' + name)
    expected_hashes = {'frozen-plan.json': proof['planSha256'], 'direction-freeze.json': proof['freezeSha256'], 'pilot-report.json': proof['pilotReportSha256'], 'pilot-verification.json': proof['pilotReceiptSha256'], 'bulk-report.json': proof['bulkReportSha256']}
    # every parent report and freeze must match the independent verdict
    for name, expected in expected_hashes.items():
        if previous.file_sha256(parent / name) != expected:
            raise RecoveryError('parent report or freeze changed')
    parent_plan = previous.strict_json((parent / 'frozen-plan.json').read_bytes())
    parent_freeze = previous.strict_json((parent / 'direction-freeze.json').read_bytes())
    # bind the inherited run population to the original old-source list
    if parent_plan.get('runs') != runs or parent_freeze.get('sourceSha256', {}).get('acquire_rain_direction.py') != previous.file_sha256(previous.__file__) or parent_freeze.get('sourceSha256', {}).get('verify_rain_direction_source.py') != proof['verifierSourceSha256']:
        raise RecoveryError('parent source binding changed')
    # no post-failure request or missing inherited success is admitted
    if {path.name for path in (parent / 'requests').iterdir()} != {f'{index:04d}' for index in range(PARENT_ATTEMPTS)}:
        raise RecoveryError('parent request set changed')
    selected = {}
    body_hashes = {}
    # reuse each successful response exactly once, never refetching it
    for index, run_index in enumerate(proof['validRunIndices']):
        run = runs[run_index]
        item = parent_attempt(parent, index, run_index, run, originals[run], True)
        selected[run_index] = item
        body_hashes[item['rawBodyFile']] = item['bodySha256']
    # the 114th attempt is retained as a failure, not a valid response
    parent_attempt(parent, PARENT_FAILURE_INDEX, PARENT_FAILURE_RUN_INDEX, runs[PARENT_FAILURE_RUN_INDEX], originals[runs[PARENT_FAILURE_RUN_INDEX]], False)
    if previous.sha256(previous.canonical_json(body_hashes)) != proof['rawBodyHashesSha256'] or len(selected) != PARENT_SUCCESS:
        raise RecoveryError('parent successful raw body hashes changed')
    return selected


# reject scope expansion, an altered retry budget or a different parent
def validate_plan(plan, runs, proof, retention_manifest_sha, retention_receipt_sha, now=None):
    now = previous.utc_now() if now is None else now
    inherited = sorted(proof['validRunIndices'])
    missing = [index for index in range(previous.RUN_COUNT) if index not in set(inherited)]
    # the fixed missing set contains the parent timed-out run
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS or plan['contractVersion'] != CONTRACT or plan['endpoint'] != previous.ENDPOINT or plan['site'] != previous.SITE or plan['runs'] != runs or plan['inheritedRunIndices'] != inherited or plan['missingRunIndices'] != missing or plan['parentRoot'] != str(PARENT_ROOT) or plan['parentPartialProofSha256'] != PARTIAL_PROOF_SHA256 or plan['parentRetentionManifestSha256'] != retention_manifest_sha or plan['parentRetentionReceiptSha256'] != retention_receipt_sha or plan['expiresAtUtc'] != EXPIRY or type(plan['maximumNewHttpRequests']) is not int or plan['maximumNewHttpRequests'] != NEW_HTTP_CAP or type(plan['maximumLocationRequests']) is not int or plan['maximumLocationRequests'] != NEW_HTTP_CAP or type(plan['maximumAttemptsPerRun']) is not int or plan['maximumAttemptsPerRun'] != 3 or type(plan['minimumIntervalSeconds']) is not int or plan['minimumIntervalSeconds'] != 1 or type(plan['timeoutSeconds']) is not int or plan['timeoutSeconds'] != 90 or type(plan['maximumResponseBytes']) is not int or plan['maximumResponseBytes'] != 2_000_000 or plan['retryableHttpStatuses'] != list(RETRYABLE_STATUSES) or plan['retryBackoffSeconds'] != list(BACKOFFS) or plan['originalManifestSha256'] != previous.ORIGINAL_MANIFEST_SHA256 or plan['originalSourceSha256'] != previous.ORIGINAL_NORMALIZED_SHA256 or len(missing) != MISSING_COUNT or PARENT_FAILURE_RUN_INDEX not in missing:
        raise RecoveryError('invalid bounded recovery plan')
    # no new request may start at or beyond the old frozen deadline
    if now >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise RecoveryError('recovery plan expired')
    return plan


# copy one relative parent artifact into an exclusive private snapshot
def snapshot_file(parent, root, relative):
    source = parent / relative
    destination = root / 'inputs/parent-root' / relative
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # a linked source could escape the reviewed parent tree
    if source.is_symlink() or not source.is_file():
        raise RecoveryError('parent source artifact is missing or linked')
    previous.copy_new(source, destination)
    if previous.file_sha256(source) != previous.file_sha256(destination):
        raise RecoveryError('parent source changed during snapshot')


# freeze the reviewed parent partial source and this separate recovery policy
def prepare(root, plan_path, parent_root, parent_retention_receipt):
    root = previous.validate_private_root(root)
    parent_root = previous.validate_private_root(parent_root)
    plan_path = Path(plan_path)
    receipt_path = Path(parent_retention_receipt)
    # root-owned plan and exact failed parent are mandatory boundaries
    if parent_root != PARENT_ROOT or receipt_path.resolve() != RETENTION_RECEIPT or plan_path.parent.resolve() != root or plan_path.is_symlink() or not plan_path.is_file() or receipt_path.is_symlink() or not receipt_path.is_file():
        raise RecoveryError('invalid recovery preparation source')
    if any((root / name).exists() or (root / name).is_symlink() for name in ('inputs', 'sources', 'frozen-plan.json', 'recovery-freeze.json', 'requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise RecoveryError('recovery already prepared')
    # independent verifier must be finalized before expensive immutable copies
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        if source.is_symlink() or not source.is_file():
            raise RecoveryError('recovery source is not finalized: ' + name)
    proof = partial_proof(PARTIAL_PROOF)
    # copied parent retention receipt must bind its manifest and completion
    retention_body = receipt_path.read_bytes()
    retention = previous.strict_json(retention_body)
    manifest_sha = retention.get('manifestSha256') if isinstance(retention, dict) else None
    if manifest_sha != RETENTION_MANIFEST_SHA256 or previous.sha256(retention_body) != RETENTION_RECEIPT_SHA256 or retention.get('verdict') != 'PASS' or retention.get('encryptedRoundtripVerified') is not True or retention.get('cipherSha256') != RETENTION_CIPHER_SHA256 or retention.get('archive') != RETENTION_MANIFEST_SHA256 + '.rain-direction.tar.gz.age' or previous.file_sha256(parent_root / 'retention-manifest.json') != RETENTION_MANIFEST_SHA256:
        raise RecoveryError('parent retention receipt is not complete')
    runs, originals = originals_from(parent_root)
    selected = audit_parent(parent_root, proof, runs, originals)
    plan_body = plan_path.read_bytes()
    if not plan_body or len(plan_body) > 300_000:
        raise RecoveryError('invalid recovery plan bytes')
    validate_plan(previous.strict_json(plan_body), runs, proof, manifest_sha, previous.sha256(retention_body))
    inputs = root / 'inputs'
    inputs.mkdir(mode=0o700)
    previous.copy_new(receipt_path, inputs / 'parent-retention-receipt.json')
    # copy the old manifest, forecast-only archive and partial source records
    for relative in PARENT_FILES:
        snapshot_file(parent_root, root, relative)
    for name in previous.ORIGINAL_PRODUCERS:
        snapshot_file(parent_root, root, f'inputs/original-producer-sources/{name}')
    for index in range(PARENT_ATTEMPTS):
        for name in (('request.json', 'receipt.json', 'response-body.bin') if index < PARENT_SUCCESS else ('request.json', 'receipt.json')):
            snapshot_file(parent_root, root, f'requests/{index:04d}/{name}')
    for name in previous.SOURCE_FILES:
        snapshot_file(parent_root, root, f'sources/{name}')
    # retain the independent partial verifier next to the copied verdict
    if previous.file_sha256(PARTIAL_VERIFIER) != PARTIAL_VERIFIER_SHA256:
        raise RecoveryError('partial verifier source changed')
    sources = root / 'sources'
    sources.mkdir(mode=0o700)
    previous.copy_new(PARTIAL_VERIFIER, sources / 'verify_partial.py')
    source_hashes = {'verify_partial.py': PARTIAL_VERIFIER_SHA256}
    # snapshot all directly imported or independent recovery code before HTTP
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        body = source.read_bytes()
        previous.write_new(sources / name, body)
        source_hashes[name] = previous.sha256(body)
    # a changed copy cannot inherit a success or enlarge the missing set
    copied_parent = root / 'inputs/parent-root'
    copied_proof = partial_proof(copied_parent / 'final-evidence/independent-partial-verification.json')
    copied_runs, copied_originals = originals_from(copied_parent)
    if copied_runs != runs or audit_parent(copied_parent, copied_proof, copied_runs, copied_originals) != selected:
        raise RecoveryError('parent snapshot changed during preparation')
    previous.write_new(root / 'frozen-plan.json', plan_body)
    freeze = {'contractVersion': CONTRACT, 'planSha256': previous.sha256(plan_body), 'parentPartialProofSha256': PARTIAL_PROOF_SHA256, 'parentRetentionManifestSha256': manifest_sha, 'parentRetentionReceiptSha256': previous.sha256(retention_body), 'sourceSha256': source_hashes, 'parentPlanSha256': proof['planSha256'], 'parentFreezeSha256': proof['freezeSha256'], 'parentBulkReportSha256': proof['bulkReportSha256'], 'parentRawBodyHashesSha256': proof['rawBodyHashesSha256'], 'originalManifestSha256': previous.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': previous.ORIGINAL_NORMALIZED_SHA256, 'originalSourceBytes': (copied_parent / 'inputs/original-normalized.jsonl').stat().st_size, 'originalSourceMtimeNs': (copied_parent / 'inputs/original-normalized.jsonl').stat().st_mtime_ns, 'inheritedRawBodies': PARENT_SUCCESS, 'missingRuns': MISSING_COUNT, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'preparedAtUtc': previous.utc_stamp(), 'actualIssueAt': None, 'labelsRead': False, 'productionWrites': False}
    previous.write_new(root / 'recovery-freeze.json', previous.canonical_json(freeze))
    return freeze


# check small frozen sources before each GET and large input bytes per phase
def validate_freeze(root, full=False, check_expiry=True):
    root = previous.validate_private_root(root)
    freeze = previous.strict_json((root / 'recovery-freeze.json').read_bytes())
    plan_body = (root / 'frozen-plan.json').read_bytes()
    # policy and parent lineage must remain the original immutable freeze
    if freeze.get('contractVersion') != CONTRACT or freeze.get('planSha256') != previous.sha256(plan_body) or freeze.get('parentPartialProofSha256') != PARTIAL_PROOF_SHA256 or freeze.get('originalManifestSha256') != previous.ORIGINAL_MANIFEST_SHA256 or freeze.get('originalSourceSha256') != previous.ORIGINAL_NORMALIZED_SHA256 or freeze.get('inheritedRawBodies') != PARENT_SUCCESS or freeze.get('missingRuns') != MISSING_COUNT or freeze.get('maximumNewHttpRequests') != NEW_HTTP_CAP or freeze.get('actualIssueAt') is not None or freeze.get('labelsRead') is not False or freeze.get('productionWrites') is not False or set(freeze.get('sourceSha256', {})) != set(SOURCE_FILES) | {'verify_partial.py'}:
        raise RecoveryError('recovery freeze changed')
    for name, expected in freeze['sourceSha256'].items():
        # imported producer and independent verifier bytes cannot drift
        source = PARTIAL_VERIFIER if name == 'verify_partial.py' else Path(__file__).with_name(name)
        if previous.file_sha256(source) != expected or previous.file_sha256(root / 'sources' / name) != expected:
            raise RecoveryError('recovery source changed')
    original = root / 'inputs/parent-root/inputs/original-normalized.jsonl'
    # metadata detects ordinary source mutation without hashing 83 MB per GET
    if original.stat().st_size != freeze['originalSourceBytes'] or original.stat().st_mtime_ns != freeze['originalSourceMtimeNs']:
        raise RecoveryError('recovery original source metadata changed')
    if previous.file_sha256(root / 'inputs/parent-retention-receipt.json') != freeze['parentRetentionReceiptSha256'] or previous.file_sha256(root / 'inputs/parent-root/retention-manifest.json') != freeze['parentRetentionManifestSha256'] or previous.file_sha256(root / 'inputs/parent-root/final-evidence/independent-partial-verification.json') != PARTIAL_PROOF_SHA256:
        raise RecoveryError('recovery parent proof changed')
    plan = previous.strict_json(plan_body)
    if full:
        # recompute all old-source rows and inherited raw response identities
        runs, originals = originals_from(root / 'inputs/parent-root')
        proof = partial_proof(root / 'inputs/parent-root/final-evidence/independent-partial-verification.json')
        selected = audit_parent(root / 'inputs/parent-root', proof, runs, originals)
        checked = previous.utc_now() if check_expiry else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        validate_plan(plan, runs, proof, freeze['parentRetentionManifestSha256'], freeze['parentRetentionReceiptSha256'], now=checked)
        return root, plan, freeze, runs, originals, selected
    # expiry is tested both before and after every optional delay
    if check_expiry and previous.utc_now() >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise RecoveryError('recovery plan expired')
    return root, plan, freeze


# retain one bounded new HTTP start before any network operation
def attempt_once(root, plan, index, run_index, run, original, attempt_in_run):
    directory = root / f'requests/{index:04d}'
    directory.mkdir(mode=0o700)
    params = previous.request_parameters(run)
    url = previous.ENDPOINT + '?' + parse.urlencode(params)
    started = previous.utc_stamp()
    request_state = {'contractVersion': CONTRACT, 'requestIndex': index, 'runIndex': run_index, 'run': run, 'attemptInRun': attempt_in_run, 'endpoint': previous.ENDPOINT, 'canonicalParams': params, 'paramsSha256': previous.sha256(previous.canonical_json(params)), 'urlSha256': previous.sha256(url.encode()), 'startedAtUtc': started, 'actualIssueAt': None}
    previous.write_new(directory / 'request.json', previous.canonical_json(request_state))
    status, received, headers, body, problem = None, None, {}, None, None
    # the old no-redirect public transport performs exactly one GET
    try:
        status, headers, body = previous.fetch(url, plan['timeoutSeconds'], plan['maximumResponseBytes'])
        received = previous.utc_stamp()
    except (OSError, ValueError, http.client.HTTPException) as failure:
        problem = failure
        # incomplete reads may carry a bounded partial body worth retaining
        if isinstance(failure, http.client.IncompleteRead) and isinstance(failure.partial, bytes):
            body = failure.partial[:plan['maximumResponseBytes'] + 1]
    finished = previous.utc_stamp()
    safe_headers = {name.lower(): str(value)[:256] for name, value in headers.items() if name.lower() in previous.SAFE_HEADERS}
    captured, complete = None, None
    # retain even an empty or truncated HTTP body before deciding retryability
    if body is not None:
        captured = body[:plan['maximumResponseBytes']]
        complete = problem is None and len(body) <= plan['maximumResponseBytes']
        previous.write_new(directory / 'response-body.bin', captured)
    receipt = {**request_state, 'responseReceivedAtUtc': received, 'finishedAtUtc': finished, 'status': status, 'safeHeaders': safe_headers, 'responseBytesObserved': len(body) if body is not None else 0, 'responseBytesStored': len(captured) if captured is not None else 0, 'bodyComplete': complete, 'contentSha256': previous.sha256(body) if body is not None and complete else None, 'capturedSha256': previous.sha256(captured) if captured is not None else None, 'rawBodyFile': 'response-body.bin' if body is not None else None, 'result': 'failed', 'errorType': type(problem).__name__ if problem is not None else None, 'error': str(problem) if problem is not None else None, 'summary': None, 'retryable': False, 'retryScheduled': False, 'backoffSeconds': 0}
    # only explicit transport errors are eligible for a bounded retry
    if problem is not None:
        receipt['retryable'] = isinstance(problem, (TimeoutError, error.URLError, http.client.IncompleteRead, http.client.RemoteDisconnected))
    elif status in RETRYABLE_STATUSES:
        receipt['retryable'] = True
        receipt['errorType'] = 'RetryableHttpStatus'
        receipt['error'] = f'HTTP {status}'
    elif not complete or not body:
        receipt['errorType'] = 'ResponseBodyError'
        receipt['error'] = 'empty or oversized response'
    elif status != 200:
        receipt['errorType'] = 'FatalHttpStatus'
        receipt['error'] = f'HTTP {status}'
    else:
        try:
            summary, _, _ = previous.validate_response(body, run, original)
            receipt.update({'result': 'success', 'summary': summary})
        except (ValueError, TypeError, KeyError) as failure:
            # response identity, precipitation or grid failures never retry
            receipt['errorType'] = type(failure).__name__
            receipt['error'] = str(failure)
    # two fixed backoffs permit at most three new starts for this missing run
    if receipt['retryable'] and attempt_in_run < 3:
        receipt.update({'result': 'retryableFailure', 'retryScheduled': True, 'backoffSeconds': BACKOFFS[attempt_in_run - 1]})
    previous.write_new(directory / 'receipt.json', previous.canonical_json(receipt))
    return receipt


# publish one complete output file without replacing an existing artifact
def publish_file(temporary, destination):
    # an exclusive hardlink exposes only the fully flushed temporary bytes
    if destination.exists() or destination.is_symlink():
        raise RecoveryError('recovery output already exists')
    os.link(temporary, destination)
    temporary.unlink()


# replay selected old and new source bodies into chronological forecast rows
def normalize_all(root, plan, originals, selected):
    directory = root / 'normalized'
    directory.mkdir(mode=0o700)
    normalized = root / NORMALIZED_FILE
    lineage = root / LINEAGE_FILE
    normalized_temporary = directory / '.direction.partial'
    lineage_temporary = root / '.response-lineage.partial'
    first = os.open(normalized_temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    second = os.open(lineage_temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(first, 'wb') as rows, os.fdopen(second, 'wb') as lineage_rows:
            # every original valid hour appears exactly once in its old order
            for run_index, run in enumerate(plan['runs']):
                source = selected[run_index]
                body_path = root / source['rawBodyFile']
                body = body_path.read_bytes()
                summary, rain, direction = previous.validate_response(body, run, originals[run])
                receipt = previous.strict_json((body_path.parent / 'receipt.json').read_bytes())
                # the chosen success must bind this precise retained raw body
                if previous.sha256(body) != source['bodySha256'] or receipt.get('result') != 'success' or receipt.get('contentSha256') != source['bodySha256'] or receipt.get('responseReceivedAtUtc') != source['responseReceivedAtUtc'] or receipt.get('summary') != summary:
                    raise RecoveryError('recovery selected raw response changed')
                origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
                line = {'originalRunIndex': run_index, 'run': run, 'origin': source['origin'], 'sourceAttemptIndex': source['attemptIndex'], 'rawBodyFile': source['rawBodyFile'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc']}
                lineage_rows.write(previous.canonical_json(line))
                # keep original rain and explicit nullable wind directions
                for lead in range(1, previous.LEADS + 1):
                    row = {'cohort': 'ecmwf_single_run_hindcast', 'key': f'ecmwf_single_run_hindcast|{run}|lead={lead}', 'runInitializedAt': run + ':00Z', 'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': rain[lead], 'rawWindDirectionDegrees': direction[lead], 'returnedGrid': summary['returnedGrid'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'actualIssueAt': None}
                    rows.write(previous.canonical_json(row))
            rows.flush()
            os.fsync(rows.fileno())
            lineage_rows.flush()
            os.fsync(lineage_rows.fileno())
        publish_file(normalized_temporary, normalized)
        publish_file(lineage_temporary, lineage)
    except (OSError, ValueError, TypeError, KeyError):
        # incomplete temporary outputs never become a complete source report
        normalized_temporary.unlink(missing_ok=True)
        lineage_temporary.unlink(missing_ok=True)
        raise
    return {'normalizedFile': NORMALIZED_FILE, 'normalizedRows': previous.RUN_COUNT * previous.LEADS, 'normalizedSha256': previous.file_sha256(normalized), 'responseLineageFile': LINEAGE_FILE, 'responseLineageRows': previous.RUN_COUNT, 'responseLineageSha256': previous.file_sha256(lineage)}


# execute one terminal recovery without replaying a completed old response
def run(root):
    root = previous.validate_private_root(root)
    # no partially started or completed recovery can be resumed implicitly
    if any((root / name).exists() or (root / name).is_symlink() for name in ('requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise RecoveryError('recovery already attempted')
    root, plan, freeze, runs, originals, inherited = validate_freeze(root, full=True)
    requests = root / 'requests'
    requests.mkdir(mode=0o700)
    selected = {run_index: {**item, 'origin': 'parentInherited', 'rawBodyFile': 'inputs/parent-root/' + item['rawBodyFile']} for run_index, item in inherited.items()}
    attempted, new_successes, retry_failures = 0, 0, 0
    failure = None
    last_start = None
    retry_not_before = None
    outcomes = []
    # only the 3188 missing original run indices receive new HTTP starts
    for run_index in plan['missingRunIndices']:
        run = runs[run_index]
        # a run receives at most three separately retained new attempts
        for attempt_in_run in range(1, 4):
            try:
                validate_freeze(root, full=False)
                # global spacing and fixed retry backoff both constrain starts
                delay = max(0., plan['minimumIntervalSeconds'] - (time.monotonic() - last_start)) if last_start is not None else 0.
                if retry_not_before is not None:
                    delay = max(delay, retry_not_before - time.monotonic())
                if delay > 0:
                    time.sleep(delay)
                validate_freeze(root, full=False)
                # the global cap counts every new HTTP start, including retries
                if attempted >= NEW_HTTP_CAP:
                    raise RecoveryError('recovery HTTP cap exhausted')
                last_start = time.monotonic()
                index = attempted
                receipt = attempt_once(root, plan, index, run_index, run, originals[run], attempt_in_run)
                outcomes.append({'requestIndex': index, 'runIndex': run_index, 'run': run, 'attemptInRun': attempt_in_run, 'result': receipt['result'], 'status': receipt['status'], 'errorType': receipt['errorType'], 'responseSha256': receipt['contentSha256']})
                attempted += 1
                retry_not_before = None
                # a successful body becomes the unique selected response
                if receipt['result'] == 'success':
                    new_successes += 1
                    selected[run_index] = {'runIndex': run_index, 'run': run, 'attemptIndex': attempted - 1, 'bodySha256': receipt['contentSha256'], 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{attempted - 1:04d}/response-body.bin', 'origin': 'newAcquired'}
                    break
                # only explicit retryable classes may consume another attempt
                if receipt['retryScheduled']:
                    retry_failures += 1
                    retry_not_before = time.monotonic() + receipt['backoffSeconds']
                    continue
                failure = {'runIndex': run_index, 'run': run, 'requestIndex': attempted - 1, 'attemptInRun': attempt_in_run, 'errorType': receipt['errorType'], 'error': receipt['error'], 'status': receipt['status'], 'retryExhausted': receipt['retryable'] and attempt_in_run == 3}
                break
            except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
                # source drift, expiry or filesystem failure cannot start another GET
                if (requests / f'{attempted:04d}/request.json').is_file():
                    attempted += 1
                failure = {'runIndex': run_index, 'run': run, 'requestIndex': attempted - 1 if attempted else None, 'attemptInRun': attempt_in_run, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
                break
        # one fatal or exhausted run stops the complete batch immediately
        if failure is not None:
            break
    outputs = None
    # source and selected-body replay precede any complete status
    if failure is None:
        try:
            validate_freeze(root, full=True, check_expiry=False)
            if len(selected) != previous.RUN_COUNT or new_successes != MISSING_COUNT:
                raise RecoveryError('recovery selected source set incomplete')
            outputs = normalize_all(root, plan, originals, selected)
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
            failure = {'runIndex': None, 'run': None, 'requestIndex': None, 'attemptInRun': None, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
    report = {'contractVersion': CONTRACT, 'status': 'failed' if failure else 'complete', 'planSha256': freeze['planSha256'], 'freezeSha256': previous.file_sha256(root / 'recovery-freeze.json'), 'parentPartialProofSha256': PARTIAL_PROOF_SHA256, 'parentRetentionManifestSha256': freeze['parentRetentionManifestSha256'], 'parentRetentionReceiptSha256': freeze['parentRetentionReceiptSha256'], 'parentHttpAttempts': PARENT_ATTEMPTS, 'newHttpAttempts': attempted, 'totalHttpAttempts': PARENT_ATTEMPTS + attempted, 'attemptedLocationRequests': attempted, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'uniqueSuccessfulRuns': len(selected), 'reusedSuccessfulRuns': PARENT_SUCCESS, 'newSuccessfulRuns': new_successes, 'retryableFailuresBeforeSuccessOrStop': retry_failures, 'parentFailedAttemptIndex': PARENT_FAILURE_INDEX, 'parentFailedRunIndex': PARENT_FAILURE_RUN_INDEX, 'plannedMissingRuns': MISSING_COUNT, 'runOutcomes': outcomes, 'failure': failure, 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False, **(outputs or {})}
    # both a complete run and the first terminal failure receive one report
    previous.write_new(root / 'report.json', previous.canonical_json(report))
    if failure:
        raise RecoveryError(f"recovery stopped: {failure['error']}")
    return report


# separate source freezing from the one-shot HTTP execution command
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
