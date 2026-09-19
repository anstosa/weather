"""independently audit completed wind source after a nonconformant parent stop."""

import argparse
import datetime as dt
import json
from collections import Counter
from pathlib import Path

import verify_rain_wind_source as previous

CONTRACT = 'rain-wind-continuation-verification/v1'
ROOT_NAME = 'weather-moisture-research-rain-wind-continuation-20260913-v1'
WIND_ROOT_NAME = 'weather-moisture-research-rain-wind-20260913-v1'
PARENT_MANIFEST_SHA = '6dd53e94293b228d541c000957a276eb1b81e696b8d503b79c8fbe188830424b'
PARENT_RECEIPT_SHA = 'a341a5f3f07f03d150f686aad14e0ca4a2ec0201d1a4bf5d722f24a612a3f244'
PARENT_PROOF_SHA = '73447f71365d5deafa3c1688f526ea3e79218722ca8da6d81b59715689539129'
PARENT_VERIFIER_SHA = '0e6f9bdecc3fd39be1bcf88ba77a6335879a830ae872008d608ed2b78db838cf'
PARENT_ATTEMPTS = 1716
PARENT_NEW_ATTEMPTS = 1601
PARENT_NEW_SUCCESSES = 1600
PARENT_REUSED_SUCCESSES = 113
PARENT_REPRESENTED = 1713
PARENT_SHORT_INTERVALS = 25
MISSING_COUNT = 1588
NEW_HTTP_CAP = 3176
NORMALIZED_PATH = 'normalized/ecmwf_single_run_wind_direction.jsonl'
LINEAGE_PATH = 'response-lineage.jsonl'


# verify the old source bodies despite the parent's failed rate contract
def audit_interrupted_parent(root):
    parent = root / 'inputs/interrupted-source'
    manifest_path = parent / 'retention-manifest.json'
    receipt_path = root / 'inputs/interrupted-retention-receipt.json'
    proof_path = parent / 'final-evidence/independent-interrupted-verification.json'
    # inherited evidence must come from one exact encrypted interrupted archive
    if parent.is_symlink() or manifest_path.is_symlink() or receipt_path.is_symlink() or proof_path.is_symlink() or previous.file_sha256(manifest_path) != PARENT_MANIFEST_SHA or previous.file_sha256(receipt_path) != PARENT_RECEIPT_SHA or previous.file_sha256(proof_path) != PARENT_PROOF_SHA or previous.file_sha256(parent / 'final-evidence/verify-interrupted.py') != PARENT_VERIFIER_SHA:
        raise ValueError('interrupted source retention binding changed')
    manifest = previous.old.strict_json(manifest_path.read_bytes())
    receipt = previous.old.strict_json(receipt_path.read_bytes())
    proof = previous.old.strict_json(proof_path.read_bytes())
    # prior acquisition remains incomplete and nonconformant, never retroactive PASS
    if manifest['contractVersion'] != 'rain-wind-source-private-retention/v1' or manifest['acquisitionComplete'] is not False or manifest['transportPolicyConformant'] is not False or manifest['sourceQualified'] is not False or manifest['dataIntegrityVerified'] is not True or manifest['newAttemptsVerified'] != PARENT_NEW_ATTEMPTS or manifest['newSuccessfulRunsVerified'] != PARENT_NEW_SUCCESSES or manifest['uniqueRepresentedRuns'] != PARENT_REPRESENTED or manifest['interruptedProofSha256'] != PARENT_PROOF_SHA:
        raise ValueError('interrupted source archive status changed')
    # local encrypted roundtrip never grants an old failed source model eligibility
    if receipt['contractVersion'] != 'rain-wind-source-retention/v1' or receipt['verdict'] != 'PASS' or receipt['manifestSha256'] != PARENT_MANIFEST_SHA or receipt['interruptedProofSha256'] != PARENT_PROOF_SHA or receipt['encryptedRoundtripVerified'] is not True or receipt['acquisitionComplete'] is not False or receipt['transportPolicyConformant'] is not False or receipt['sourceQualified'] is not False or receipt['remoteCopyPerformed'] is not False or receipt['productionDatabaseOrServiceWrites'] is not False:
        raise ValueError('interrupted source retention receipt changed')
    entries = manifest['files']
    actual = {path.relative_to(parent).as_posix() for path in parent.rglob('*') if path.is_file()}
    # copied tree must have exactly its manifest-listed files and no links
    if actual != set(entries) | {'retention-manifest.json'} or any(path.is_symlink() for path in parent.rglob('*')):
        raise ValueError('interrupted source retained file set changed')
    # rehash every copied body, request, report and frozen source artifact
    for relative, expected in entries.items():
        path = parent / relative
        # a bad archive member cannot escape or replace a retained response
        if Path(relative).is_absolute() or '..' in Path(relative).parts or not path.is_file() or path.stat().st_size != expected['bytes'] or previous.file_sha256(path) != expected['sha256']:
            raise ValueError('interrupted source retained file changed: ' + relative)
    originals, inherited, older = previous.audit_previous(parent)
    plan, hashes = previous.audit_freeze(parent, originals, inherited, older)
    requests = parent / 'requests'
    names = {path.name for path in requests.iterdir()}
    # retain all 1601 old attempts without claiming completed V3 source output
    if names != {f'{index:04d}' for index in range(PARENT_NEW_ATTEMPTS)} or any((parent / name).exists() for name in ('report.json', 'normalized', LINEAGE_PATH)):
        raise ValueError('interrupted source request or output set changed')
    records = []
    raw_hashes = {}
    absent = []
    # independently validate all old short bodies and the bodyless retry
    for index in range(PARENT_NEW_ATTEMPTS):
        request = previous.old.strict_json((requests / f'{index:04d}/request.json').read_bytes())
        run_index = request['runIndex']
        ordinal = request['attemptInRun']
        # only an original run and one of two planned attempt ordinals is valid
        if type(run_index) is not int or not 0 <= run_index < previous.original.RUNS or type(ordinal) is not int or ordinal not in (1, 2):
            raise ValueError('interrupted source attempt identity changed')
        record = previous.audit_attempt(parent, index, run_index, ordinal, originals[run_index])
        records.append(record)
        # a transport exception has no raw source value to inherit
        if record['rawBodyFile'] is None:
            absent.append(index)
        else:
            raw_hashes[record['rawBodyFile']] = previous.file_sha256(parent / record['rawBodyFile'])
    successful = {}
    position = 0
    # preserve the old ordered successful prefix but do not waive its timing defects
    for run_index in plan['missingRunIndices']:
        # unattempted original runs remain genuinely missing for the continuation
        if position == len(records):
            break
        first = records[position]
        # no old response can borrow another original run identity
        if first['requestIndex'] != position or first['runIndex'] != run_index or first['attemptInRun'] != 1:
            raise ValueError('interrupted source ordered prefix changed')
        position += 1
        chosen = first
        # the sole retryable old transport error must be followed by its retry
        if first['result'] == 'retryableFailure':
            # an uncompleted retry is not a successful inherited body
            if position == len(records):
                raise ValueError('interrupted source dangling retry')
            chosen = records[position]
            # old retry still has the fixed fifteen-second completion backoff
            if chosen['requestIndex'] != position or chosen['runIndex'] != run_index or chosen['attemptInRun'] != 2 or (previous.utc_time(chosen['startedAtUtc']) - previous.utc_time(first['finishedAtUtc'])).total_seconds() < 15:
                raise ValueError('interrupted source retry changed')
            position += 1
        # only complete 35-hour, old-rain-identical bodies are inherited
        if chosen['result'] != 'success' or chosen['parsed'] is None or chosen['responseSha256'] is None:
            raise ValueError('interrupted source failed run inherited')
        successful[run_index] = chosen
    # all prior attempted responses are accounted for without adding absent runs
    if position != len(records) or list(successful) != plan['missingRunIndices'][:len(successful)] or len(successful) != PARENT_NEW_SUCCESSES:
        raise ValueError('interrupted source successful prefix changed')
    short = []
    # reconstruct every violation from recorded UTC start instants
    for index in range(1, len(records)):
        delta = (previous.utc_time(records[index]['startedAtUtc']) - previous.utc_time(records[index - 1]['startedAtUtc'])).total_seconds()
        # under-one-second starts remain failed policy evidence
        if delta < 1:
            short.append({'previousRequestIndex': index - 1, 'requestIndex': index, 'seconds': delta})
    outcomes = Counter(item['result'] for item in records)
    # source body integrity coexists with exactly 25 rejected scheduler intervals
    if outcomes != {'success': PARENT_NEW_SUCCESSES, 'retryableFailure': 1} or len(short) != PARENT_SHORT_INTERVALS or absent != [1099] or short != proof['shortStartIntervals'] or proof['transportPolicyConformant'] is not False or proof['acquisitionComplete'] is not False or proof['sourceQualified'] is not False or proof['dataIntegrityVerified'] is not True:
        raise ValueError('interrupted source violations changed')
    # the old independent proof binds each revalidated body and run index
    if proof['planSha256'] != hashes['planSha256'] or proof['freezeSha256'] != hashes['freezeSha256'] or proof['frozenSourceSha256'] != previous.old.strict_json((parent / 'wind-source-freeze.json').read_bytes())['sourceSha256'] or proof['rawBodySha256'] != raw_hashes or proof['validNewRunIndices'] != list(successful) or proof['attemptWithoutBodyIndices'] != absent or proof['representedRunsVerified'] != PARENT_REPRESENTED or proof['remainingOriginalRuns'] != MISSING_COUNT or proof['interruptedVerifierSourceSha256'] != PARENT_VERIFIER_SHA or proof['modelGatesEvaluated'] is not False:
        raise ValueError('interrupted source independent proof changed')
    # the union of old full and interrupted short responses is exactly 1713 runs
    if len(inherited) != PARENT_REUSED_SUCCESSES or len(successful) != PARENT_NEW_SUCCESSES or {item['runIndex'] for item in inherited} & set(successful) or len(inherited) + len(successful) != PARENT_REPRESENTED:
        raise ValueError('interrupted source inherited run union changed')
    return originals, inherited, successful, {'parentPlanSha256': hashes['planSha256'], 'parentFreezeSha256': hashes['freezeSha256'], 'parentProofSha256': PARENT_PROOF_SHA, 'parentManifestSha256': PARENT_MANIFEST_SHA, 'parentReceiptSha256': PARENT_RECEIPT_SHA, 'parentShortStartIntervals': short, 'parentLastFinishedAtUtc': records[-1]['finishedAtUtc'], 'parentTransportPolicyConformant': False, 'parentSourceQualified': False}


# enforce new completion-based spacing while retaining old violations as history
def validate_new_sequence(records, missing, parent_finished_at):
    # original missing-run order and bounded two-attempt dispositions still apply
    selected, unresolved = previous.validate_sequence(records, missing)
    preceding_finish = previous.utc_time(parent_finished_at)
    # every new request begins at least one second after the prior completed receipt
    for item in records:
        started = previous.utc_time(item['startedAtUtc'])
        # a monotonic loop-start estimate cannot replace observed UTC receipt timing
        if (started - preceding_finish).total_seconds() < 1:
            raise ValueError('new continuation request began before completed-response spacing')
        preceding_finish = previous.utc_time(item['finishedAtUtc'])
    return selected, unresolved


# keep all four provenance origins distinct in the forty-eight old-rain leads
def direction_rows(origin, directions):
    output = []
    # never invent wind direction beyond a thirty-five-hour public response
    for lead in range(1, 49):
        # exact upstream timeout contains no provider forecast at any lead
        if origin == 'transportUnresolved':
            output.append((None, 'transportUnresolved'))
        elif origin in ('interruptedInherited', 'newAcquired') and lead > 34:
            # V3 and V4 short requests did not ask for tail leads
            output.append((None, 'notRequested'))
        else:
            value = directions[lead]
            output.append((value, 'providerNull' if value is None else 'available'))
    return output


# build run-level sources from V1 full, V3 short and V4 current raw bodies
def selected_sources(root, originals, inherited_full, inherited_short, new_selected, unresolved):
    selected = {}
    older = root / 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root'
    parent = root / 'inputs/interrupted-source'
    # V1 responses preserve all forty-eight forecast direction leads
    for item in inherited_full:
        run_index = item['runIndex']
        body = (older / item['rawBodyPath']).read_bytes()
        parsed = previous.original.audit_response(body, originals[run_index])
        selected[run_index] = {
            'origin': 'parentInherited',
            'attemptIndex': item['attemptIndex'],
            'rawBodyFile': 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/' + item['rawBodyPath'],
            'responseSha256': previous.original.sha256(body),
            'responseReceivedAtUtc': item['receivedAtUtc'],
            'direction': parsed['direction'],
            'grid': parsed['grid'],
            'directionLeadCount': 48,
        }
    # V3 short responses remain identified as nonconformant-parent inheritance
    for run_index, item in inherited_short.items():
        body = (parent / item['rawBodyFile']).read_bytes()
        parsed = previous.audit_response_35(body, originals[run_index])
        # no inherited short response may overlap an older complete V1 body
        if run_index in selected or item['responseSha256'] != previous.original.sha256(body):
            raise ValueError('interrupted inherited source changed')
        selected[run_index] = {
            'origin': 'interruptedInherited',
            'attemptIndex': item['requestIndex'],
            'rawBodyFile': 'inputs/interrupted-source/' + item['rawBodyFile'],
            'responseSha256': item['responseSha256'],
            'responseReceivedAtUtc': item['responseReceivedAtUtc'],
            'direction': parsed['direction'],
            'grid': parsed['grid'],
            'directionLeadCount': 34,
        }
    # current V4 public responses supply at most thirty-four positive leads
    for run_index, item in new_selected.items():
        # no new body may replace a previously verified old run
        if run_index in selected or item['parsed'] is None:
            raise ValueError('continuation selected duplicate run')
        selected[run_index] = {
            'origin': 'newAcquired',
            'attemptIndex': item['requestIndex'],
            'rawBodyFile': item['rawBodyFile'],
            'responseSha256': item['responseSha256'],
            'responseReceivedAtUtc': item['responseReceivedAtUtc'],
            'direction': item['parsed']['direction'],
            'grid': item['parsed']['grid'],
            'directionLeadCount': 34,
        }
    # only exact second known timeout bodies can become explicit unknown direction
    for run_index, item in unresolved.items():
        # unknown transport never borrows direction from adjacent runs
        if run_index in selected or item['responseSha256'] != previous.original.sha256(previous.KNOWN_TIMEOUT):
            raise ValueError('continuation unresolved source changed')
        selected[run_index] = {
            'origin': 'transportUnresolved',
            'attemptIndex': item['requestIndex'],
            'rawBodyFile': item['rawBodyFile'],
            'responseSha256': item['responseSha256'],
            'responseReceivedAtUtc': item['responseReceivedAtUtc'],
            'direction': None,
            'grid': originals[run_index]['grid'],
            'directionLeadCount': 0,
        }
    # every old run contributes exactly one source disposition
    if set(selected) != set(range(previous.original.RUNS)):
        raise ValueError('continuation source run population incomplete')
    return selected


# independently stream normalized old rain and explicit source status bytes
def audit_outputs(root, originals, selected, report):
    normalized = root / NORMALIZED_PATH
    lineage = root / LINEAGE_PATH
    # complete forecast source still has 3301 times forty-eight original rows
    if report['normalizedFile'] != NORMALIZED_PATH or report['normalizedRows'] != previous.original.SOURCE_ROWS or report['responseLineageFile'] != LINEAGE_PATH or report['responseLineageRows'] != previous.original.RUNS:
        raise ValueError('continuation output shape changed')
    statuses = {'available': 0, 'providerNull': 0, 'notRequested': 0, 'transportUnresolved': 0}
    with normalized.open('rb') as source_rows, lineage.open('rb') as lineage_rows:
        # preserve old source run chronology regardless of new request order
        for run_index, original in enumerate(originals):
            source = selected[run_index]
            expected_lineage = {
                'originalRunIndex': run_index,
                'run': original['run'],
                'origin': source['origin'],
                'sourceAttemptIndex': source['attemptIndex'],
                'rawBodyFile': source['rawBodyFile'],
                'responseSha256': source['responseSha256'],
                'responseReceivedAtUtc': source['responseReceivedAtUtc'],
                'directionLeadCount': source['directionLeadCount'],
            }
            # exact canonical lineage preserves the old failed-policy origin
            if lineage_rows.readline() != previous.original.canonical_json(expected_lineage):
                raise ValueError(f'continuation lineage changed at run {run_index}')
            origin = previous.utc_time(original['initialized'])
            # old rain remains authoritative even where direction was not requested
            for lead, (wind, status) in enumerate(direction_rows(source['origin'], source['direction']), 1):
                expected = {
                    'cohort': previous.original.COHORT,
                    'key': f'{previous.original.COHORT}|{original["run"]}|lead={lead}',
                    'runInitializedAt': original['initialized'],
                    'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'targetLeadHours': lead,
                    'rawPrecipitationMm': original['precipitation'][lead - 1],
                    'rawWindDirectionDegrees': wind,
                    'directionSourceStatus': status,
                    'returnedGrid': {'latitude': source['grid'][0], 'longitude': source['grid'][1]},
                    'responseSha256': source['responseSha256'],
                    'responseReceivedAtUtc': source['responseReceivedAtUtc'],
                    'actualIssueAt': None,
                }
                # exact row bytes reject zero filling, time drift and missing leads
                if source_rows.readline() != previous.original.canonical_json(expected):
                    raise ValueError(f'continuation normalized row changed at run {run_index} lead {lead}')
                statuses[status] += 1
        # no extra normalized or lineage row follows the original cohort
        if source_rows.read(1) or lineage_rows.read(1):
            raise ValueError('continuation output trailing rows changed')
    normalized_sha = previous.file_sha256(normalized)
    lineage_sha = previous.file_sha256(lineage)
    # report hashes must match independently reconstructed output bytes
    if report['normalizedSha256'] != normalized_sha or report['responseLineageSha256'] != lineage_sha:
        raise ValueError('continuation output hashes changed')
    return {'normalizedSha256': normalized_sha, 'normalizedRows': previous.original.SOURCE_ROWS, 'responseLineageSha256': lineage_sha, 'responseLineageRows': previous.original.RUNS, 'directionStatusRows': statuses}


# pin the continuation population, failed parent status and reviewed code bytes
def audit_freeze(root, originals, inherited_full, inherited_short, parent_info):
    plan_path = root / 'frozen-plan.json'
    freeze_path = root / 'wind-continuation-freeze.json'
    plan_body = plan_path.read_bytes()
    freeze_body = freeze_path.read_bytes()
    plan = previous.old.strict_json(plan_body)
    freeze = previous.old.strict_json(freeze_body)
    inherited = {item['runIndex'] for item in inherited_full} | set(inherited_short)
    missing = [index for index in range(previous.original.RUNS) if index not in inherited]
    expected_plan_fields = frozenset(('contractVersion', 'endpoint', 'site', 'runs', 'inheritedRunIndices', 'missingRunIndices', 'interruptedSourceRoot', 'interruptedProofSha256', 'interruptedRetentionManifestSha256', 'interruptedRetentionReceiptSha256', 'originalManifestSha256', 'originalSourceSha256', 'expiresAtUtc', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'retryableHttpStatuses', 'retryBackoffSeconds', 'forecastHours', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator', 'knownTimeoutBodySha256'))
    # only the remaining original runs may receive new 35-hour requests
    if not isinstance(plan, dict) or set(plan) != expected_plan_fields or plan['contractVersion'] != 'rain-wind-continuation/v1' or plan['endpoint'] != previous.original.ENDPOINT or plan['site'] != {'latitude': previous.original.SITE[0], 'longitude': previous.original.SITE[1]} or plan['runs'] != [item['run'] for item in originals] or plan['inheritedRunIndices'] != sorted(inherited) or plan['missingRunIndices'] != missing or len(inherited) != PARENT_REPRESENTED or len(missing) != MISSING_COUNT:
        raise ValueError('continuation frozen run population changed')
    # exact original source and stopped-parent receipts remain separate identities
    if plan['interruptedSourceRoot'] != str(Path.home() / '.weather/research-work/weather-moisture-research-rain-wind-source-20260913-v1') or plan['interruptedProofSha256'] != PARENT_PROOF_SHA or plan['interruptedRetentionManifestSha256'] != PARENT_MANIFEST_SHA or plan['interruptedRetentionReceiptSha256'] != PARENT_RECEIPT_SHA or plan['originalManifestSha256'] != previous.original.MANIFEST_SHA or plan['originalSourceSha256'] != previous.original.SOURCE_SHA or plan['knownTimeoutBodySha256'] != previous.original.sha256(previous.KNOWN_TIMEOUT):
        raise ValueError('continuation frozen parent lineage changed')
    # fixed one-second completion delay and bounded retry budget are preregistered
    if plan['expiresAtUtc'] != previous.EXPIRY or plan['forecastHours'] != 35 or plan['maximumNewHttpRequests'] != NEW_HTTP_CAP or plan['maximumLocationRequests'] != NEW_HTTP_CAP or plan['maximumAttemptsPerRun'] != 2 or plan['minimumIntervalSeconds'] != 1 or plan['timeoutSeconds'] != 90 or plan['maximumResponseBytes'] != 2_000_000 or plan['retryableHttpStatuses'] != list(previous.RETRYABLE) or plan['retryBackoffSeconds'] != [15] or plan['unresolvedFractionNumerator'] != 1 or plan['unresolvedFractionDenominator'] != 100 or any(type(plan[key]) is not int for key in ('forecastHours', 'maximumNewHttpRequests', 'maximumLocationRequests', 'maximumAttemptsPerRun', 'minimumIntervalSeconds', 'timeoutSeconds', 'maximumResponseBytes', 'unresolvedFractionNumerator', 'unresolvedFractionDenominator')):
        raise ValueError('continuation request or coverage limits changed')
    expected_source_names = frozenset(('acquire_rain_wind_continuation.py', 'verify_rain_wind_continuation.py', 'rain_request_spacing.py', 'acquire_rain_wind_source.py', 'acquire_rain_direction.py', 'acquire_rain_direction_recovery.py', 'verify_rain_direction_recovery.py', 'verify_rain_direction_source.py', 'verify_rain_wind_source.py', 'retain_moisture_research.py'))
    expected_freeze_fields = frozenset(('contractVersion', 'planSha256', 'interruptedProofSha256', 'interruptedRetentionManifestSha256', 'interruptedRetentionReceiptSha256', 'sourceSha256', 'originalManifestSha256', 'originalSourceSha256', 'originalSourceBytes', 'originalSourceMtimeNs', 'inheritedFullResponses', 'inheritedShortResponses', 'missingRuns', 'maximumNewHttpRequests', 'parentHttpAttempts', 'parentTransportPolicyConformant', 'inheritedSpacingViolationCount', 'parentSourceQualified', 'preparedAtUtc', 'actualIssueAt', 'labelsRead', 'modelGatesEvaluated', 'productionWrites'))
    # freeze must explicitly retain the parent's failure rather than laundering it
    if set(freeze) != expected_freeze_fields or freeze['contractVersion'] != plan['contractVersion'] or freeze['planSha256'] != previous.original.sha256(plan_body) or freeze['interruptedProofSha256'] != PARENT_PROOF_SHA or freeze['interruptedRetentionManifestSha256'] != PARENT_MANIFEST_SHA or freeze['interruptedRetentionReceiptSha256'] != PARENT_RECEIPT_SHA or freeze['originalManifestSha256'] != previous.original.MANIFEST_SHA or freeze['originalSourceSha256'] != previous.original.SOURCE_SHA or freeze['originalSourceBytes'] != previous.original.SOURCE_BYTES or type(freeze['originalSourceMtimeNs']) is not int or freeze['originalSourceMtimeNs'] <= 0 or freeze['inheritedFullResponses'] != PARENT_REUSED_SUCCESSES or freeze['inheritedShortResponses'] != PARENT_NEW_SUCCESSES or freeze['missingRuns'] != MISSING_COUNT or freeze['maximumNewHttpRequests'] != NEW_HTTP_CAP or freeze['parentHttpAttempts'] != PARENT_ATTEMPTS or freeze['parentTransportPolicyConformant'] is not False or freeze['inheritedSpacingViolationCount'] != PARENT_SHORT_INTERVALS or freeze['parentSourceQualified'] is not False or set(freeze['sourceSha256']) != expected_source_names:
        raise ValueError('continuation freeze contract changed')
    # continuation preparation cannot exceed the original public-query deadline
    if previous.utc_time(freeze['preparedAtUtc']) >= previous.utc_time(previous.EXPIRY):
        raise ValueError('continuation prepared after expiry')
    # no observation label or production outcome enters the acquisition boundary
    if freeze['actualIssueAt'] is not None or freeze['labelsRead'] is not False or freeze['modelGatesEvaluated'] is not False or freeze['productionWrites'] is not False:
        raise ValueError('continuation freeze side-effect scope changed')
    # reviewed producer, spacing helper and independent verifier must remain unchanged
    for name, expected in freeze['sourceSha256'].items():
        current = Path(__file__).with_name(name)
        copied = root / 'sources' / name
        # source bytes bind the actual code, not a mutable source-file pointer
        if current.is_symlink() or copied.is_symlink() or previous.file_sha256(current) != expected or previous.file_sha256(copied) != expected:
            raise ValueError('continuation source code changed: ' + name)
    # original eighty-three-megabyte rain source remains independently pinned
    if previous.file_sha256(root / 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/inputs/original-normalized.jsonl') != previous.original.SOURCE_SHA or parent_info['parentProofSha256'] != freeze['interruptedProofSha256']:
        raise ValueError('continuation original rain or parent proof changed')
    return plan, {'planSha256': previous.original.sha256(plan_body), 'freezeSha256': previous.original.sha256(freeze_body)}


# rederive one terminal source report from every retained old and new request
def audit_root(root):
    fixed_files = ('frozen-plan.json', 'wind-continuation-freeze.json', 'report.json', NORMALIZED_PATH, LINEAGE_PATH)
    # submitted outputs and reports must be regular files inside this root
    if any((root / name).is_symlink() or not (root / name).is_file() for name in fixed_files) or (root / 'requests').is_symlink():
        raise ValueError('continuation terminal artifact path changed')
    originals, inherited_full, inherited_short, parent_info = audit_interrupted_parent(root)
    plan, hashes = audit_freeze(root, originals, inherited_full, inherited_short, parent_info)
    report_path = root / 'report.json'
    report = previous.old.strict_json(report_path.read_bytes())
    requests = root / 'requests'
    names = {path.name for path in requests.iterdir()}
    count = len(names)
    # attempts must be contiguous and never exceed the frozen new-request cap
    if not count or count > NEW_HTTP_CAP or names != {f'{index:04d}' for index in range(count)} or any(path.is_symlink() or not path.is_dir() for path in requests.iterdir()):
        raise ValueError('continuation new attempt population changed')
    records = []
    # independently parse every raw body, error and retained response receipt
    for index in range(count):
        request = previous.old.strict_json((requests / f'{index:04d}/request.json').read_bytes())
        run_index = request['runIndex']
        ordinal = request['attemptInRun']
        # only fixed original missing runs and one of two attempts are possible
        if type(run_index) is not int or run_index not in plan['missingRunIndices'] or type(ordinal) is not int or ordinal not in (1, 2):
            raise ValueError('continuation request identity changed')
        records.append(previous.audit_attempt(root, index, run_index, ordinal, originals[run_index]))
    new_selected, unresolved = validate_new_sequence(records, plan['missingRunIndices'], parent_info['parentLastFinishedAtUtc'])
    eligible, monthly_totals, monthly_unknown = previous.coverage(originals, unresolved)
    # the global and each decision-month unresolved cap must independently pass
    if not eligible:
        raise ValueError('continuation source coverage failed')
    monthly = {month: {'totalRuns': total, 'unresolvedRuns': monthly_unknown[month], 'qualified': 100 * monthly_unknown[month] <= total} for month, total in monthly_totals.items()}
    selected = selected_sources(root, originals, inherited_full, inherited_short, new_selected, unresolved)
    outcomes = [{'requestIndex': item['requestIndex'], 'runIndex': item['runIndex'], 'run': item['run'], 'attemptInRun': item['attemptInRun'], 'result': item['result'], 'status': item['status'], 'errorType': item['errorType'], 'responseSha256': item['responseSha256']} for item in records]
    expected = {
        'contractVersion': 'rain-wind-continuation/v1', 'status': 'complete', 'sourceQualified': True,
        'planSha256': hashes['planSha256'], 'freezeSha256': hashes['freezeSha256'],
        'interruptedProofSha256': PARENT_PROOF_SHA, 'interruptedRetentionManifestSha256': PARENT_MANIFEST_SHA,
        'interruptedRetentionReceiptSha256': PARENT_RECEIPT_SHA, 'parentHttpAttempts': PARENT_ATTEMPTS,
        'parentSourceQualified': False, 'parentTransportPolicyConformant': False,
        'inheritedSpacingViolationCount': PARENT_SHORT_INTERVALS, 'newHttpAttempts': count,
        'totalHttpAttempts': PARENT_ATTEMPTS + count, 'attemptedLocationRequests': count,
        'maximumNewHttpRequests': NEW_HTTP_CAP, 'uniqueRepresentedRuns': previous.original.RUNS,
        'uniqueSuccessfulRuns': previous.original.RUNS - len(unresolved), 'reusedSuccessfulRuns': PARENT_REPRESENTED,
        'reusedFullResponses': PARENT_REUSED_SUCCESSES, 'reusedShortResponses': PARENT_NEW_SUCCESSES,
        'newSuccessfulRuns': len(new_selected), 'newUnresolvedRuns': len(unresolved),
        'retryableFailuresBeforeSuccessOrStop': sum(item['result'] == 'retryableFailure' for item in records),
        'plannedMissingRuns': MISSING_COUNT, 'runOutcomes': outcomes, 'perMonthCoverage': monthly,
        'failure': None, 'actualIssueAt': None, 'labelsRead': False, 'modelGatesEvaluated': False,
        'productionWrites': False,
    }
    outputs = {'normalizedFile': NORMALIZED_PATH, 'normalizedRows': previous.original.SOURCE_ROWS,
               'normalizedSha256': previous.file_sha256(root / NORMALIZED_PATH),
               'responseLineageFile': LINEAGE_PATH, 'responseLineageRows': previous.original.RUNS,
               'responseLineageSha256': previous.file_sha256(root / LINEAGE_PATH)}
    # all producer counters, source statuses and side-effect claims must match
    if report != expected | outputs:
        raise ValueError('continuation terminal report changed')
    output_info = audit_outputs(root, originals, selected, report)
    return {
        'contractVersion': CONTRACT, 'verdict': 'PASS', 'reportSha256': previous.file_sha256(report_path),
        'freezeSha256': hashes['freezeSha256'], 'planSha256': hashes['planSha256'],
        'normalizedSha256': output_info['normalizedSha256'], 'normalizedRows': output_info['normalizedRows'],
        'responseLineageSha256': output_info['responseLineageSha256'], 'responseLineageRows': output_info['responseLineageRows'],
        'uniqueRepresentedRuns': previous.original.RUNS, 'uniqueSuccessfulRuns': previous.original.RUNS - len(unresolved),
        'inheritedFullResponses': PARENT_REUSED_SUCCESSES, 'inheritedShortResponses': PARENT_NEW_SUCCESSES,
        'newSuccessfulRuns': len(new_selected), 'newUnresolvedRuns': len(unresolved),
        'parentHttpAttempts': PARENT_ATTEMPTS, 'newHttpAttempts': count, 'totalHttpAttempts': PARENT_ATTEMPTS + count,
        'parentSourceQualified': False, 'parentTransportPolicyConformant': False,
        'inheritedSpacingViolationCount': PARENT_SHORT_INTERVALS, 'sourceQualified': True,
        'directionStatusRows': output_info['directionStatusRows'], 'historicalAsIssuedVerified': False,
        'freshHoldoutVerified': False, 'modelGatesEvaluated': False, 'productionEligible': False,
        'verifierSourceSha256': previous.file_sha256(__file__),
        'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
    }


# accept only the exact private acquisition root
def audit_full(root):
    root = Path(root).absolute()
    expected = Path.home() / '.weather/research-work' / ROOT_NAME
    # a similarly named copied root cannot impersonate the acquisition
    if root != expected or root.is_symlink() or root.resolve() != expected:
        raise ValueError('continuation verification root changed')
    return audit_root(root)


# independently recheck one exact later model-input snapshot
def audit_snapshot(root):
    root = Path(root).absolute()
    expected = Path.home() / '.weather/research-work' / WIND_ROOT_NAME / 'inputs/direction'
    # only the wind model's declared source copy is eligible
    if root != expected or root.is_symlink() or root.resolve() != expected:
        raise ValueError('continuation model snapshot path changed')
    return audit_root(root)


# write only a separate private verification receipt after complete replay
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    receipt = audit_full(arguments.root)
    # one-shot receipt does not modify retained producer evidence
    with arguments.output.open('x', encoding='utf-8') as stream:
        json.dump(receipt, stream, sort_keys=True, indent=2)
        stream.write('\n')
    print(json.dumps(receipt, sort_keys=True), flush=True)
