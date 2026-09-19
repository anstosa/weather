"""continue only missing wind-source runs after a retained interrupted acquisition."""

import argparse
import datetime as dt
import http.client
import json
import os
from pathlib import Path

import acquire_rain_direction as old
import acquire_rain_wind_source as wind
from rain_request_spacing import RequestSpacing

CONTRACT = 'rain-wind-continuation/v1'
ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-wind-continuation-20260913-v1'
PARENT_ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-wind-source-20260913-v1'
RETENTION_RECEIPT = Path.home() / '.weather/model-evidence/rain-wind-source-20260913/retention-receipt.json'
RETENTION_MANIFEST_SHA256 = '6dd53e94293b228d541c000957a276eb1b81e696b8d503b79c8fbe188830424b'
RETENTION_RECEIPT_SHA256 = 'a341a5f3f07f03d150f686aad14e0ca4a2ec0201d1a4bf5d722f24a612a3f244'
INTERRUPTED_PROOF_SHA256 = '73447f71365d5deafa3c1688f526ea3e79218722ca8da6d81b59715689539129'
PARENT_HTTP_ATTEMPTS = 1716
PARENT_V3_ATTEMPTS = 1601
INHERITED_FULL = 113
INHERITED_SHORT = 1600
INHERITED = INHERITED_FULL + INHERITED_SHORT
MISSING = 1588
NEW_HTTP_CAP = 3176
SPACING_VIOLATIONS = 25
EXPIRY = wind.EXPIRY
SOURCE_FILES = ('acquire_rain_wind_continuation.py', 'verify_rain_wind_continuation.py', 'rain_request_spacing.py', 'acquire_rain_wind_source.py', 'acquire_rain_direction.py', 'acquire_rain_direction_recovery.py', 'verify_rain_direction_recovery.py', 'verify_rain_direction_source.py', 'verify_rain_wind_source.py', 'retain_moisture_research.py')
PLAN_KEYS = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'interruptedSourceRoot', 'interruptedProofSha256', 'interruptedRetentionManifestSha256', 'interruptedRetentionReceiptSha256', 'originalManifestSha256', 'originalSourceSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'forecastHours', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator', 'knownTimeoutBodySha256'))
NORMALIZED_FILE = wind.NORMALIZED_FILE
LINEAGE_FILE = wind.LINEAGE_FILE


class ContinuationError(ValueError):
    """mark a terminal bounded wind-source continuation."""


# construct one exact root-owned plan without reading labels or predictions
def build_plan(runs, selected):
    inherited = sorted(selected)
    missing = [index for index in range(old.RUN_COUNT) if index not in selected]
    return {'contractVersion': CONTRACT, 'endpoint': old.ENDPOINT, 'site': old.SITE, 'runs': runs, 'inheritedRunIndices': inherited, 'missingRunIndices': missing, 'interruptedSourceRoot': str(PARENT_ROOT), 'interruptedProofSha256': INTERRUPTED_PROOF_SHA256, 'interruptedRetentionManifestSha256': RETENTION_MANIFEST_SHA256, 'interruptedRetentionReceiptSha256': RETENTION_RECEIPT_SHA256, 'originalManifestSha256': old.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': old.ORIGINAL_NORMALIZED_SHA256, 'expiresAtUtc': EXPIRY, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'maximumLocationRequests': NEW_HTTP_CAP, 'maximumAttemptsPerRun': 2, 'minimumIntervalSeconds': 1, 'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000, 'retryableHttpStatuses': list(wind.RETRYABLE_STATUSES), 'retryBackoffSeconds': [wind.BACKOFF], 'forecastHours': wind.FORECAST_HOURS, 'unresolvedFractionNumerator': 1, 'unresolvedFractionDenominator': 100, 'knownTimeoutBodySha256': wind.KNOWN_TIMEOUT_SHA256}


# bind every retained V3 byte while preserving its failed policy status
def audit_interrupted(parent, receipt_path, snapshot=False):
    parent = Path(parent) if snapshot else old.validate_private_root(parent)
    receipt_path = Path(receipt_path)
    # only the original stopped source or its fixed copy can be consumed
    if (not snapshot and (parent != PARENT_ROOT or receipt_path.resolve() != RETENTION_RECEIPT)) or (snapshot and (parent.name != 'interrupted-source' or receipt_path != parent.parent / 'interrupted-retention-receipt.json')):
        raise ContinuationError('interrupted source path changed')
    manifest_path = parent / 'retention-manifest.json'
    proof_path = parent / 'final-evidence/independent-interrupted-verification.json'
    manifest = old.strict_json(manifest_path.read_bytes())
    receipt = old.strict_json(receipt_path.read_bytes())
    proof = old.strict_json(proof_path.read_bytes())
    # the independently audited interruption and encrypted archive remain failed
    if old.file_sha256(manifest_path) != RETENTION_MANIFEST_SHA256 or old.file_sha256(receipt_path) != RETENTION_RECEIPT_SHA256 or old.file_sha256(proof_path) != INTERRUPTED_PROOF_SHA256 or not isinstance(manifest, dict) or manifest.get('contractVersion') != 'rain-wind-source-private-retention/v1' or manifest.get('dataIntegrityVerified') is not True or manifest.get('acquisitionComplete') is not False or manifest.get('transportPolicyConformant') is not False or manifest.get('sourceQualified') is not False or manifest.get('interruptedProofSha256') != INTERRUPTED_PROOF_SHA256 or not isinstance(receipt, dict) or receipt.get('verdict') != 'PASS' or receipt.get('encryptedRoundtripVerified') is not True or receipt.get('manifestSha256') != RETENTION_MANIFEST_SHA256 or receipt.get('interruptedProofSha256') != INTERRUPTED_PROOF_SHA256 or receipt.get('transportPolicyConformant') is not False or not isinstance(proof, dict) or proof.get('verdict') != 'PASS_INTERRUPTED_EVIDENCE_ONLY' or proof.get('dataIntegrityVerified') is not True or proof.get('acquisitionComplete') is not False or proof.get('transportPolicyConformant') is not False or proof.get('sourceQualified') is not False or proof.get('newAttemptsVerified') != PARENT_V3_ATTEMPTS or proof.get('newSuccessfulRunsVerified') != INHERITED_SHORT or proof.get('inheritedSuccessfulRunsVerified') != INHERITED_FULL or proof.get('shortStartIntervalCount') != SPACING_VIOLATIONS or proof.get('representedRunsVerified') != INHERITED or proof.get('remainingOriginalRuns') != MISSING:
        raise ContinuationError('interrupted source proof changed')
    entries = manifest.get('files')
    actual = {path.relative_to(parent).as_posix() for path in parent.rglob('*') if path.is_file() or path.is_symlink()}
    # the unlisted retention filelist belongs only to the original disk root
    expected = set(entries) | {'retention-manifest.json'} | (set() if snapshot else {'retention-filelist.bin'}) if isinstance(entries, dict) else None
    if actual != expected:
        raise ContinuationError('interrupted source file set changed')
    for name, metadata in entries.items():
        path = parent / name
        # do not trust linked, extra, missing or byte-changed parent files
        if not isinstance(name, str) or Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.is_file() or not isinstance(metadata, dict) or path.stat().st_size != metadata.get('bytes') or old.file_sha256(path) != metadata.get('sha256'):
            raise ContinuationError('interrupted source file changed: ' + str(name))
    v2 = parent / 'inputs/previous-recovery'
    runs, originals, inherited = wind.audit_previous(v2, parent / 'inputs/previous-retention-receipt.json', snapshot=True)
    selected = {index: {**item, 'origin': 'parentInherited', 'rawBodyFile': 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/' + item['rawBodyFile']} for index, item in inherited.items()}
    valid_new = proof.get('validNewRunIndices')
    if not isinstance(valid_new, list) or len(valid_new) != INHERITED_SHORT or len(set(valid_new)) != INHERITED_SHORT or set(valid_new) & set(selected):
        raise ContinuationError('interrupted source selected scope changed')
    successful = []
    raw_hashes = {}
    # reuse only complete old 35-hour bodies whose rain matches the source
    for attempt_index in range(PARENT_V3_ATTEMPTS):
        request = old.strict_json((parent / f'requests/{attempt_index:04d}/request.json').read_bytes())
        prior_receipt = old.strict_json((parent / f'requests/{attempt_index:04d}/receipt.json').read_bytes())
        index = request.get('runIndex')
        if type(index) is not int or not 0 <= index < old.RUN_COUNT or request.get('requestIndex') != attempt_index or request.get('run') != runs[index] or prior_receipt.get('requestIndex') != attempt_index or prior_receipt.get('runIndex') != index or prior_receipt.get('run') != runs[index]:
            raise ContinuationError('interrupted request identity changed')
        relative = f'requests/{attempt_index:04d}/response-body.bin'
        # one interrupted transport attempt had no body and is not selected
        if prior_receipt.get('result') != 'success':
            if prior_receipt.get('result') != 'retryableFailure' or prior_receipt.get('rawBodyFile') is not None:
                raise ContinuationError('interrupted failed attempt changed')
            continue
        body = (parent / relative).read_bytes()
        summary, _, _ = wind.validate_response(body, runs[index], originals[runs[index]])
        digest = old.sha256(body)
        if prior_receipt.get('status') != 200 or prior_receipt.get('bodyComplete') is not True or prior_receipt.get('contentSha256') != digest or prior_receipt.get('summary') != summary or index in selected:
            raise ContinuationError('interrupted success changed')
        raw_hashes[relative] = digest
        successful.append(index)
        selected[index] = {'runIndex': index, 'run': runs[index], 'attemptIndex': attempt_index, 'bodySha256': digest, 'responseReceivedAtUtc': prior_receipt['responseReceivedAtUtc'], 'rawBodyFile': 'inputs/interrupted-source/' + relative, 'origin': 'interruptedInherited'}
    # do not convert the 25 prior scheduling violations into policy compliance
    if successful != valid_new or len(selected) != INHERITED or raw_hashes != proof.get('rawBodySha256') or old.sha256(old.canonical_json(raw_hashes)) != proof.get('rawBodyHashesSha256'):
        raise ContinuationError('interrupted selected raw bodies changed')
    return runs, originals, selected

# require only the old original run complement and fixed policy caps
def validate_plan(plan, runs, selected, now=None):
    now = old.utc_now() if now is None else now
    expected = build_plan(runs, selected)
    # exact key set blocks an undisclosed scope or policy extension
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS or plan != expected or len(selected) != INHERITED or len(expected['missingRunIndices']) != MISSING or any(type(plan[key]) is not int for key in ('maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'forecastHours', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator')):
        raise ContinuationError('invalid wind continuation plan')
    # a frozen deadline cannot be moved by a later receipt
    if now >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise ContinuationError('wind continuation plan expired')
    return plan


# copy only manifest-bound prior files into the private V4 snapshot
def snapshot_interrupted(parent, root, receipt_path):
    manifest = old.strict_json((parent / 'retention-manifest.json').read_bytes())
    target = root / 'inputs/interrupted-source'
    target.mkdir(mode=0o700, parents=True)
    # each source body retains its original run and request path
    for name, metadata in sorted(manifest['files'].items()):
        destination = target / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        old.copy_new(parent / name, destination)
        if old.file_sha256(destination) != metadata['sha256']:
            raise ContinuationError('interrupted source changed during snapshot')
    old.copy_new(parent / 'retention-manifest.json', target / 'retention-manifest.json')
    old.copy_new(receipt_path, root / 'inputs/interrupted-retention-receipt.json')
    # source selection must agree before and after the copy
    return audit_interrupted(target, root / 'inputs/interrupted-retention-receipt.json', snapshot=True)


# freeze a separate V4 envelope without rewriting the failed V3 source
def prepare(root, plan_path, parent_root, parent_retention_receipt):
    root = old.validate_private_root(root)
    parent_root = old.validate_private_root(parent_root)
    # only the fixed continuation root may receive a new source snapshot
    if root != ROOT:
        raise ContinuationError('continuation root changed')
    plan_path = Path(plan_path)
    receipt_path = Path(parent_retention_receipt)
    # never prepare from a different root, receipt or mutable outside plan
    if parent_root != PARENT_ROOT or receipt_path.resolve() != RETENTION_RECEIPT or plan_path.parent.resolve() != root or plan_path.is_symlink() or not plan_path.is_file() or receipt_path.is_symlink() or not receipt_path.is_file():
        raise ContinuationError('invalid continuation preparation path')
    if any((root / name).exists() or (root / name).is_symlink() for name in ('inputs', 'sources', 'frozen-plan.json', 'wind-continuation-freeze.json', 'requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise ContinuationError('continuation already prepared')
    # both the independent V4 verifier and executing helper must be final
    for name in SOURCE_FILES:
        source = Path(__file__).with_name(name)
        if source.is_symlink() or not source.is_file():
            raise ContinuationError('continuation source not finalized: ' + name)
    runs, originals, selected = audit_interrupted(parent_root, receipt_path)
    plan_body = plan_path.read_bytes()
    if not plan_body or len(plan_body) > 300_000:
        raise ContinuationError('invalid continuation plan bytes')
    validate_plan(old.strict_json(plan_body), runs, selected)
    copied_runs, copied_originals, copied_selected = snapshot_interrupted(parent_root, root, receipt_path)
    if copied_runs != runs or copied_originals != originals or copied_selected != selected:
        raise ContinuationError('continuation source snapshot changed')
    sources = root / 'sources'
    sources.mkdir(mode=0o700)
    hashes = {}
    # no executing producer, parser, scheduler or verifier may drift later
    for name in SOURCE_FILES:
        body = Path(__file__).with_name(name).read_bytes()
        old.write_new(sources / name, body)
        hashes[name] = old.sha256(body)
    old.write_new(root / 'frozen-plan.json', plan_body)
    original_path = root / 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl'
    freeze = {'contractVersion': CONTRACT, 'planSha256': old.sha256(plan_body), 'interruptedProofSha256': INTERRUPTED_PROOF_SHA256, 'interruptedRetentionManifestSha256': RETENTION_MANIFEST_SHA256, 'interruptedRetentionReceiptSha256': RETENTION_RECEIPT_SHA256, 'sourceSha256': hashes, 'originalManifestSha256': old.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': old.ORIGINAL_NORMALIZED_SHA256, 'originalSourceBytes': original_path.stat().st_size, 'originalSourceMtimeNs': original_path.stat().st_mtime_ns, 'inheritedFullResponses': INHERITED_FULL, 'inheritedShortResponses': INHERITED_SHORT, 'missingRuns': MISSING, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'parentHttpAttempts': PARENT_HTTP_ATTEMPTS, 'parentTransportPolicyConformant': False, 'inheritedSpacingViolationCount': SPACING_VIOLATIONS, 'parentSourceQualified': False, 'preparedAtUtc': old.utc_stamp(), 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False}
    old.write_new(root / 'wind-continuation-freeze.json', old.canonical_json(freeze))
    return freeze


# recheck small frozen boundaries per GET and full source at phase edges
def validate_freeze(root, full=False, check_expiry=True):
    root = old.validate_private_root(root)
    # never execute from a moved or substituted private root
    if root != ROOT:
        raise ContinuationError('continuation root changed')
    freeze = old.strict_json((root / 'wind-continuation-freeze.json').read_bytes())
    plan_body = (root / 'frozen-plan.json').read_bytes()
    # the previous nonconforming source remains visibly nonconforming
    if not isinstance(freeze, dict) or freeze.get('contractVersion') != CONTRACT or freeze.get('planSha256') != old.sha256(plan_body) or freeze.get('interruptedProofSha256') != INTERRUPTED_PROOF_SHA256 or freeze.get('interruptedRetentionManifestSha256') != RETENTION_MANIFEST_SHA256 or freeze.get('interruptedRetentionReceiptSha256') != RETENTION_RECEIPT_SHA256 or freeze.get('inheritedFullResponses') != INHERITED_FULL or freeze.get('inheritedShortResponses') != INHERITED_SHORT or freeze.get('missingRuns') != MISSING or freeze.get('maximumNewHttpRequests') != NEW_HTTP_CAP or freeze.get('parentHttpAttempts') != PARENT_HTTP_ATTEMPTS or freeze.get('parentTransportPolicyConformant') is not False or freeze.get('inheritedSpacingViolationCount') != SPACING_VIOLATIONS or freeze.get('parentSourceQualified') is not False or freeze.get('actualIssueAt') is not None or freeze.get('labelsRead') is not False or freeze.get('modelGatesEvaluated') is not False or freeze.get('productionWrites') is not False or set(freeze.get('sourceSha256', {})) != set(SOURCE_FILES):
        raise ContinuationError('wind continuation freeze changed')
    for name, expected in freeze['sourceSha256'].items():
        # local and copied executing code must match the freeze
        if old.file_sha256(Path(__file__).with_name(name)) != expected or old.file_sha256(root / 'sources' / name) != expected:
            raise ContinuationError('wind continuation code changed')
    original_path = root / 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl'
    if original_path.stat().st_size != freeze['originalSourceBytes'] or original_path.stat().st_mtime_ns != freeze['originalSourceMtimeNs']:
        raise ContinuationError('wind continuation original metadata changed')
    if old.file_sha256(root / 'inputs/interrupted-retention-receipt.json') != RETENTION_RECEIPT_SHA256 or old.file_sha256(root / 'inputs/interrupted-source/retention-manifest.json') != RETENTION_MANIFEST_SHA256 or old.file_sha256(root / 'inputs/interrupted-source/final-evidence/independent-interrupted-verification.json') != INTERRUPTED_PROOF_SHA256:
        raise ContinuationError('wind continuation parent proof changed')
    plan = old.strict_json(plan_body)
    # full phase revalidates all old rain and every selected body
    if full:
        runs, originals, selected = audit_interrupted(root / 'inputs/interrupted-source', root / 'inputs/interrupted-retention-receipt.json', snapshot=True)
        checked = old.utc_now() if check_expiry else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        validate_plan(plan, runs, selected, now=checked)
        return root, plan, freeze, runs, originals, selected
    if check_expiry and old.utc_now() >= dt.datetime.fromisoformat(EXPIRY.replace('Z', '+00:00')):
        raise ContinuationError('wind continuation plan expired')
    return root, plan, freeze

# emit one truthful V4 lineage and old-rain/new-direction normalized cohort
def normalize_all(root, plan, originals, selected):
    directory = root / 'normalized'
    directory.mkdir(mode=0o700)
    normalized = root / NORMALIZED_FILE
    lineage = root / LINEAGE_FILE
    partial_rows = directory / '.direction.partial'
    partial_lineage = root / '.response-lineage.partial'
    first = os.open(partial_rows, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    second = os.open(partial_lineage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(first, 'wb') as rows, os.fdopen(second, 'wb') as lineage_rows:
            # original manifest order fixes every output run and lead
            for run_index, run in enumerate(plan['runs']):
                source = selected[run_index]
                body_path = root / source['rawBodyFile']
                body = body_path.read_bytes()
                receipt = old.strict_json((body_path.parent / 'receipt.json').read_bytes())
                origin_type = source['origin']
                # only the original V1 responses supply all forty-eight directions
                if origin_type == 'parentInherited':
                    summary, _, direction = old.validate_response(body, run, originals[run])
                    lead_count = old.LEADS
                    expected_result = 'success'
                elif origin_type in ('interruptedInherited', 'newAcquired'):
                    # V3 and V4 short responses share the frozen 35-hour validator
                    summary, _, direction = wind.validate_response(body, run, originals[run])
                    lead_count = wind.FORECAST_HOURS - 1
                    expected_result = 'success'
                else:
                    # a second exact timeout is transport unknown, not provider null
                    if origin_type != 'transportUnresolved' or body != wind.KNOWN_TIMEOUT_BODY:
                        raise ContinuationError('unresolved continuation body changed')
                    summary, direction = {'returnedGrid': originals[run]['grid']}, (None,) * wind.FORECAST_HOURS
                    lead_count = 0
                    expected_result = 'transportUnresolved'
                # every chosen body must match its retained response receipt
                if old.sha256(body) != source['bodySha256'] or receipt.get('result') != expected_result or receipt.get('status') != 200 or receipt.get('contentSha256') != source['bodySha256'] or receipt.get('responseReceivedAtUtc') != source['responseReceivedAtUtc'] or (expected_result == 'success' and receipt.get('summary') != summary):
                    raise ContinuationError('selected continuation response changed')
                line = {'originalRunIndex': run_index, 'run': run, 'origin': origin_type, 'sourceAttemptIndex': source['attemptIndex'], 'rawBodyFile': source['rawBodyFile'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'directionLeadCount': lead_count}
                lineage_rows.write(old.canonical_json(line))
                initialized = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
                # each old rain lead survives even when direction was not requested
                for lead in range(1, old.LEADS + 1):
                    direction_value = direction[lead] if lead <= lead_count else None
                    status = 'transportUnresolved' if origin_type == 'transportUnresolved' else ('notRequested' if lead > lead_count else ('providerNull' if direction_value is None else 'available'))
                    row = {'cohort': 'ecmwf_single_run_hindcast', 'key': f'ecmwf_single_run_hindcast|{run}|lead={lead}', 'runInitializedAt': run + ':00Z', 'validAt': (initialized + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': originals[run]['rain'][lead - 1], 'rawWindDirectionDegrees': direction_value, 'directionSourceStatus': status, 'returnedGrid': summary['returnedGrid'], 'responseSha256': source['bodySha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'actualIssueAt': None}
                    rows.write(old.canonical_json(row))
            rows.flush()
            os.fsync(rows.fileno())
            lineage_rows.flush()
            os.fsync(lineage_rows.fileno())
        wind.publish_file(partial_rows, normalized)
        wind.publish_file(partial_lineage, lineage)
    except (OSError, ValueError, TypeError, KeyError):
        # temporary partial output never establishes source completion
        partial_rows.unlink(missing_ok=True)
        partial_lineage.unlink(missing_ok=True)
        raise
    return {'normalizedFile': NORMALIZED_FILE, 'normalizedRows': old.RUN_COUNT * old.LEADS, 'normalizedSha256': old.file_sha256(normalized), 'responseLineageFile': LINEAGE_FILE, 'responseLineageRows': old.RUN_COUNT, 'responseLineageSha256': old.file_sha256(lineage)}


# run only the remaining original keys under a new, corrected request policy
def run(root):
    root = old.validate_private_root(root)
    # the one-shot request ledger belongs to one exact prepared root
    if root != ROOT:
        raise ContinuationError('continuation root changed')
    # one V4 root has one terminal attempt sequence only
    if any((root / name).exists() or (root / name).is_symlink() for name in ('requests', 'report.json', 'normalized', LINEAGE_FILE)):
        raise ContinuationError('continuation already attempted')
    root, plan, freeze, runs, originals, selected = validate_freeze(root, full=True)
    requests = root / 'requests'
    requests.mkdir(mode=0o700)
    spacing = RequestSpacing()
    attempted, new_successes, retry_failures = 0, 0, 0
    unresolved = set()
    outcomes = []
    failure = None
    # only the 1588 unrepresented old run indices receive V4 requests
    for run_index in plan['missingRunIndices']:
        run_name = runs[run_index]
        # every missing run has at most two retained new starts
        for ordinal in (1, 2):
            try:
                validate_freeze(root)
                spacing.wait()
                validate_freeze(root)
                # source and HTTP caps are checked after any waiting
                if attempted >= NEW_HTTP_CAP:
                    raise ContinuationError('wind continuation HTTP cap exhausted')
                request_index = attempted
                receipt = wind.attempt_once(root, plan, request_index, run_index, run_name, originals[run_name], ordinal)
                # the durable receipt completion, not pre-request work, anchors spacing
                spacing.mark_completed(retry=receipt['retryScheduled'])
                outcomes.append({'requestIndex': request_index, 'runIndex': run_index, 'run': run_name, 'attemptInRun': ordinal, 'result': receipt['result'], 'status': receipt['status'], 'errorType': receipt['errorType'], 'responseSha256': receipt['contentSha256']})
                attempted += 1
                # one valid 35-hour response is selected exactly once
                if receipt['result'] == 'success':
                    new_successes += 1
                    selected[run_index] = {'runIndex': run_index, 'run': run_name, 'attemptIndex': request_index, 'bodySha256': receipt['contentSha256'], 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{request_index:04d}/response-body.bin', 'origin': 'newAcquired'}
                    break
                # only a second exact known timeout may be unknown
                if receipt['result'] == 'transportUnresolved':
                    unresolved.add(run_index)
                    selected[run_index] = {'runIndex': run_index, 'run': run_name, 'attemptIndex': request_index, 'bodySha256': receipt['contentSha256'], 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'rawBodyFile': f'requests/{request_index:04d}/response-body.bin', 'origin': 'transportUnresolved'}
                    _, within_tolerance = wind.month_coverage(runs, unresolved)
                    # fixed full-population denominators make a breached cap terminal
                    if not within_tolerance:
                        failure = {'runIndex': run_index, 'run': run_name, 'requestIndex': request_index, 'attemptInRun': ordinal, 'errorType': 'SourceCoverageExceeded', 'error': 'wind continuation unresolved fraction exceeded', 'status': 200, 'retryExhausted': False}
                    break
                if receipt['retryScheduled']:
                    retry_failures += 1
                    continue
                failure = {'runIndex': run_index, 'run': run_name, 'requestIndex': request_index, 'attemptInRun': ordinal, 'errorType': receipt['errorType'], 'error': receipt['error'], 'status': receipt['status'], 'retryExhausted': receipt['retryable'] and ordinal == 2}
                break
            except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
                # expiry, source drift and storage failure forbid another GET
                if (requests / f'{attempted:04d}/request.json').is_file():
                    attempted += 1
                failure = {'runIndex': run_index, 'run': run_name, 'requestIndex': attempted - 1 if attempted else None, 'attemptInRun': ordinal, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
                break
        if failure is not None:
            break
    coverage, qualified = wind.month_coverage(runs, unresolved)
    outputs = None
    # final publication requires every original run and every fixed source cap
    if failure is None:
        try:
            validate_freeze(root, full=True, check_expiry=False)
            if len(selected) != old.RUN_COUNT or new_successes + len(unresolved) != MISSING:
                raise ContinuationError('wind continuation selected set incomplete')
            if not qualified:
                raise ContinuationError('wind continuation unresolved fraction exceeded')
            outputs = normalize_all(root, plan, originals, selected)
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as problem:
            failure = {'runIndex': None, 'run': None, 'requestIndex': None, 'attemptInRun': None, 'errorType': type(problem).__name__, 'error': str(problem), 'status': None, 'retryExhausted': False}
    report = {'contractVersion': CONTRACT, 'status': 'failed' if failure else 'complete', 'sourceQualified': failure is None and qualified, 'planSha256': freeze['planSha256'], 'freezeSha256': old.file_sha256(root / 'wind-continuation-freeze.json'), 'interruptedProofSha256': INTERRUPTED_PROOF_SHA256, 'interruptedRetentionManifestSha256': RETENTION_MANIFEST_SHA256, 'interruptedRetentionReceiptSha256': RETENTION_RECEIPT_SHA256, 'parentHttpAttempts': PARENT_HTTP_ATTEMPTS, 'parentSourceQualified': False, 'parentTransportPolicyConformant': False, 'inheritedSpacingViolationCount': SPACING_VIOLATIONS, 'newHttpAttempts': attempted, 'totalHttpAttempts': PARENT_HTTP_ATTEMPTS + attempted, 'attemptedLocationRequests': attempted, 'maximumNewHttpRequests': NEW_HTTP_CAP, 'uniqueRepresentedRuns': len(selected), 'uniqueSuccessfulRuns': len(selected) - len(unresolved), 'reusedSuccessfulRuns': INHERITED, 'reusedFullResponses': INHERITED_FULL, 'reusedShortResponses': INHERITED_SHORT, 'newSuccessfulRuns': new_successes, 'newUnresolvedRuns': len(unresolved), 'retryableFailuresBeforeSuccessOrStop': retry_failures, 'plannedMissingRuns': MISSING, 'runOutcomes': outcomes, 'perMonthCoverage': coverage, 'failure': failure, 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False, **(outputs or {})}
    # failed and complete runs each retain one immutable terminal report
    old.write_new(root / 'report.json', old.canonical_json(report))
    if failure:
        raise ContinuationError(f"wind continuation stopped: {failure['error']}")
    return report


# keep source freezing separate from one-shot public acquisition
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
