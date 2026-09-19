"""exercise recovery source audits with synthetic forecast-only receipts."""

import copy
import datetime as dt
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

import acquire_rain_direction_recovery as producer
import verify_rain_direction_recovery as verify


# build one old forecast run without any observation target
def original():
    return {
        'run': '2026-05-12T00:00',
        'initialized': '2026-05-12T00:00:00Z',
        'key': 'ecmwf_single_run_hindcast|2026-05-12T00:00',
        'grid': (47.97891, -122.44185),
        'precipitation': tuple(None if lead == 8 else lead / 10 for lead in range(1, 49)),
    }


# produce a full 49-hour public response matching the old rain profile
def response(identity):
    origin = verify.prior.utc_time(identity['initialized'])
    return {
        'latitude': identity['grid'][0],
        'longitude': identity['grid'][1],
        'elevation': 28.,
        'timezone': 'GMT',
        'utc_offset_seconds': 0,
        'hourly_units': verify.prior.UNITS,
        'hourly': {
            'time': [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(49)],
            'precipitation': [None, *identity['precipitation']],
            'wind_direction_10m': [float(lead) for lead in range(49)],
        },
    }


# write one synthetic request, receipt and optional raw body
def attempt(root, index, identity, started, status, body, error_type=None, error=None, retry=False, backoff=0):
    directory = root / f'requests/{index:04d}'
    directory.mkdir(parents=True)
    params = verify.prior.expected_params(identity['run'])
    url = verify.prior.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])
    request = {
        'contractVersion': verify.ACQUISITION_CONTRACT,
        'requestIndex': index,
        'runIndex': 0,
        'run': identity['run'],
        'attemptInRun': index + 1,
        'endpoint': verify.prior.ENDPOINT,
        'canonicalParams': params,
        'paramsSha256': verify.prior.sha256(verify.prior.canonical_json(params)),
        'urlSha256': verify.prior.sha256(url.encode()),
        'startedAtUtc': started,
        'actualIssueAt': None,
    }
    received = (verify.prior.utc_time(started) + dt.timedelta(seconds=1)).isoformat().replace('+00:00', 'Z') if status is not None else None
    finished = (verify.prior.utc_time(started) + dt.timedelta(seconds=1)).isoformat().replace('+00:00', 'Z')
    profile = verify.prior.audit_response(body, identity) if status == 200 and error_type is None else None
    result = 'success' if profile is not None else ('retryableFailure' if retry else 'failed')
    receipt = {
        **request,
        'responseReceivedAtUtc': received,
        'finishedAtUtc': finished,
        'status': status,
        'safeHeaders': {'content-type': 'application/json'} if status is not None else {},
        'responseBytesObserved': len(body) if body is not None else 0,
        'responseBytesStored': len(body) if body is not None else 0,
        'bodyComplete': status is not None if body is not None else None,
        'contentSha256': verify.prior.sha256(body) if body is not None and status is not None else None,
        'capturedSha256': verify.prior.sha256(body) if body is not None else None,
        'rawBodyFile': 'response-body.bin' if body is not None else None,
        'result': result,
        'errorType': error_type,
        'error': error,
        'summary': verify.response_summary(identity, profile) if profile is not None else None,
        'retryable': retry,
        'retryScheduled': retry,
        'backoffSeconds': backoff,
    }
    (directory / 'request.json').write_bytes(verify.prior.canonical_json(request))
    (directory / 'receipt.json').write_bytes(verify.prior.canonical_json(receipt))
    # even an empty HTTP body remains an explicit retained artifact
    if body is not None:
        (directory / 'response-body.bin').write_bytes(body)
    return directory


# reconstruct one selected response into exact model-source files
def outputs(root, identity, selected):
    normalized = root / verify.NORMALIZED_PATH
    normalized.parent.mkdir(parents=True)
    lineage = root / verify.LINEAGE_PATH
    profile = selected['profile']
    line = {
        'originalRunIndex': 0,
        'run': identity['run'],
        'origin': selected['origin'],
        'sourceAttemptIndex': selected['attemptIndex'],
        'rawBodyFile': selected['rawBodyFile'],
        'responseSha256': selected['bodySha256'],
        'responseReceivedAtUtc': selected['responseReceivedAtUtc'],
    }
    lineage.write_bytes(verify.prior.canonical_json(line))
    origin = verify.prior.utc_time(identity['initialized'])
    rows = []
    # reproduce all one-based normalized forecast-only rows
    for lead in range(1, 49):
        rows.append({
            'cohort': verify.prior.COHORT,
            'key': f'{verify.prior.COHORT}|{identity["run"]}|lead={lead}',
            'runInitializedAt': identity['initialized'],
            'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'targetLeadHours': lead,
            'rawPrecipitationMm': identity['precipitation'][lead - 1],
            'rawWindDirectionDegrees': profile['direction'][lead],
            'returnedGrid': {'latitude': profile['grid'][0], 'longitude': profile['grid'][1]},
            'responseSha256': selected['bodySha256'],
            'responseReceivedAtUtc': selected['responseReceivedAtUtc'],
            'actualIssueAt': None,
        })
    normalized.write_bytes(b''.join(verify.prior.canonical_json(row) for row in rows))
    return {
        'normalizedFile': verify.NORMALIZED_PATH,
        'normalizedRows': 48,
        'normalizedSha256': verify.file_sha256(normalized),
        'responseLineageFile': verify.LINEAGE_PATH,
        'responseLineageRows': 1,
        'responseLineageSha256': verify.file_sha256(lineage),
    }


# prevent source retries, body switches and report joins from passing silently
class RainDirectionRecoveryVerifierTests(unittest.TestCase):
    # each test owns only a disposable synthetic receipt tree
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.identity = original()

    # a transient gateway error may retry after five seconds then select 200
    def test_transient_http_then_success_with_backoff(self):
        attempt(self.root, 0, self.identity, '2026-09-13T07:00:00Z', 503, b'', 'RetryableHttpStatus', 'HTTP 503', True, 5)
        raw = verify.prior.canonical_json(response(self.identity))
        attempt(self.root, 1, self.identity, '2026-09-13T07:00:06Z', 200, raw)
        first = verify.audit_new_attempt(self.root, 0, 0, 1, self.identity)
        second = verify.audit_new_attempt(self.root, 1, 0, 2, self.identity)
        selected = verify.validate_attempt_sequence([first, second], [0])
        self.assertEqual(selected[0]['responseSha256'], verify.prior.sha256(raw))
        self.assertEqual(first['backoffSeconds'], 5)
        changed = copy.deepcopy(second)
        changed['startedAtUtc'] = '2026-09-13T07:00:05Z'
        # one second early fails the post-finish backoff
        with self.assertRaisesRegex(ValueError, 'backoff'):
            verify.validate_attempt_sequence([first, changed], [0])

    # producer receipts and independent verifier agree on retry and success
    def test_producer_to_verifier_transient_integration(self):
        (self.root / 'requests').mkdir()
        old = {'grid': {'latitude': self.identity['grid'][0], 'longitude': self.identity['grid'][1]}, 'rain': self.identity['precipitation']}
        raw = verify.prior.canonical_json(response(self.identity))
        stamps = ['2026-09-13T07:00:00Z', '2026-09-13T07:00:01Z', '2026-09-13T07:00:01Z', '2026-09-13T07:00:06Z', '2026-09-13T07:00:07Z', '2026-09-13T07:00:07Z']
        plan = {'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000}
        # no network call is made; only the producer's local receipt path runs
        with patch.object(producer.previous, 'fetch', side_effect=[(503, {}, b''), (200, {}, raw)]), patch.object(producer.previous, 'utc_stamp', side_effect=stamps):
            producer.attempt_once(self.root, plan, 0, 0, self.identity['run'], old, 1)
            producer.attempt_once(self.root, plan, 1, 0, self.identity['run'], old, 2)
        records = [verify.audit_new_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        self.assertEqual(len(verify.validate_attempt_sequence(records, [0])), 1)

    # producer partial-body transport evidence remains unselected and retryable
    def test_producer_to_verifier_incomplete_read_integration(self):
        (self.root / 'requests').mkdir()
        old = {'grid': {'latitude': self.identity['grid'][0], 'longitude': self.identity['grid'][1]}, 'rain': self.identity['precipitation']}
        plan = {'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000}
        # an injected incomplete read exercises exact saved partial bytes only
        with patch.object(producer.previous, 'fetch', side_effect=http.client.IncompleteRead(b'partial', 1)), patch.object(producer.previous, 'utc_stamp', side_effect=['2026-09-13T07:00:00Z', '2026-09-13T07:00:01Z']):
            producer.attempt_once(self.root, plan, 0, 0, self.identity['run'], old, 1)
        record = verify.audit_new_attempt(self.root, 0, 0, 1, self.identity)
        self.assertEqual(record['result'], 'retryableFailure')
        self.assertIsNone(record['profile'])

    # incomplete transport data can be retained but never selected as a run
    def test_incomplete_read_partial_body_then_success(self):
        attempt(self.root, 0, self.identity, '2026-09-13T07:00:00Z', None, b'partial', 'IncompleteRead', '7 bytes read', True, 5)
        raw = verify.prior.canonical_json(response(self.identity))
        attempt(self.root, 1, self.identity, '2026-09-13T07:00:06Z', 200, raw)
        records = [verify.audit_new_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        self.assertFalse(records[0]['profile'])
        self.assertEqual(len(verify.validate_attempt_sequence(records, [0])), 1)

    # 429 and bad rain parity are terminal, never paths to a later success
    def test_forbidden_429_and_parity_retries(self):
        attempt(self.root, 0, self.identity, '2026-09-13T07:00:00Z', 429, b'{"error":"quota"}', 'FatalHttpStatus', 'HTTP 429')
        raw = verify.prior.canonical_json(response(self.identity))
        attempt(self.root, 1, self.identity, '2026-09-13T07:00:06Z', 200, raw)
        records = [verify.audit_new_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        # a terminal quota response cannot be followed by another GET
        with self.assertRaises(ValueError):
            verify.validate_attempt_sequence(records, [0])
        receipt_path = self.root / 'requests/0000/receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt.update({'result': 'retryableFailure', 'retryable': True, 'retryScheduled': True, 'backoffSeconds': 5})
        receipt_path.write_bytes(verify.prior.canonical_json(receipt))
        with self.assertRaises(ValueError):
            verify.audit_new_attempt(self.root, 0, 0, 1, self.identity)
        altered = response(self.identity)
        altered['hourly']['precipitation'][8] = 0.
        parity_body = verify.prior.canonical_json(altered)
        # a complete but wrong 200 body may only be terminal
        with tempfile.TemporaryDirectory() as temporary:
            other = Path(temporary)
            attempt(other, 0, self.identity, '2026-09-13T07:00:00Z', 200, parity_body, 'AcquisitionError', 'direction response precipitation parity changed')
            first = verify.audit_new_attempt(other, 0, 0, 1, self.identity)
            self.assertEqual(first['result'], 'failed')

    # only exact original run order and one selected response may complete
    def test_extra_or_missing_attempts_rejected(self):
        raw = verify.prior.canonical_json(response(self.identity))
        attempt(self.root, 0, self.identity, '2026-09-13T07:00:00Z', 200, raw)
        record = verify.audit_new_attempt(self.root, 0, 0, 1, self.identity)
        self.assertEqual(len(verify.validate_attempt_sequence([record], [0])), 1)
        # missing second run and extra second request both fail population checks
        with self.assertRaises(ValueError):
            verify.validate_attempt_sequence([record], [0, 1])
        with self.assertRaises(ValueError):
            verify.validate_attempt_sequence([record, record], [0])

    # canonical model source joins must detect lineage and normalized tamper
    def test_lineage_and_normalized_source_tamper(self):
        raw = verify.prior.canonical_json(response(self.identity))
        attempt(self.root, 0, self.identity, '2026-09-13T07:00:00Z', 200, raw)
        record = verify.audit_new_attempt(self.root, 0, 0, 1, self.identity)
        selected = {0: {'origin': 'newAcquired', 'attemptIndex': 0, 'rawBodyFile': record['rawBodyFile'], 'bodySha256': record['responseSha256'], 'responseReceivedAtUtc': record['responseReceivedAtUtc'], 'profile': record['profile']}}
        report = outputs(self.root, self.identity, selected[0])
        self.assertEqual(verify.audit_outputs(self.root, [self.identity], selected, report)['normalizedRows'], 48)
        lineage = self.root / verify.LINEAGE_PATH
        original_lineage = lineage.read_bytes()
        lineage.write_bytes(original_lineage.replace(b'newAcquired', b'parentInherited'))
        # a forged origin cannot reuse a valid response digest
        with self.assertRaises(ValueError):
            verify.audit_outputs(self.root, [self.identity], selected, report)
        lineage.write_bytes(original_lineage)
        normalized = self.root / verify.NORMALIZED_PATH
        lines = normalized.read_bytes().splitlines(keepends=True)
        lines[8] = lines[8].replace(b'"rawWindDirectionDegrees":9.0', b'"rawWindDirectionDegrees":0.0')
        normalized.write_bytes(b''.join(lines))
        # one altered direction lead invalidates the whole normalized source
        with self.assertRaises(ValueError):
            verify.audit_outputs(self.root, [self.identity], selected, report)

    # byte-identical copied inputs pass without timestamp equivalence
    def test_retained_input_copy_uses_bytes_not_mtime(self):
        parent = self.root / 'parent'
        parent.mkdir()
        original_file = parent / 'original.json'
        original_file.write_bytes(b'{"forecast":1}\n')
        manifest = {'files': {'original.json': {'bytes': original_file.stat().st_size, 'sha256': verify.file_sha256(original_file)}}}
        original_file.touch()
        verify.audit_manifest_files(parent, manifest, ('original.json',))
        original_file.write_bytes(b'{"forecast":2}\n')
        # same byte length with a different mtime is not sufficient proof
        with self.assertRaises(ValueError):
            verify.audit_manifest_files(parent, manifest, ('original.json',))

    # copied model source path and full acquisition path stay separate
    def test_snapshot_path_is_exact(self):
        with self.assertRaisesRegex(ValueError, 'snapshot path'):
            verify.audit_snapshot(self.root)
        with self.assertRaisesRegex(ValueError, 'root changed'):
            verify.audit_full(self.root)


# run only synthetic forecast receipts without network or private source reads
if __name__ == '__main__':
    unittest.main()
