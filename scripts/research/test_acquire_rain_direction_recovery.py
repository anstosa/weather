"""lock bounded missing-run recovery without making public requests."""

import copy
import datetime as dt
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib import error

import acquire_rain_direction as previous
import acquire_rain_direction_recovery as recovery


# build the exact original-index population without source observations
def scope():
    runs = [(dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(hours=6 * index)).strftime('%Y-%m-%dT%H:%M') for index in range(previous.RUN_COUNT)]
    inherited = sorted(list(previous.PILOT_POSITIONS) + [index for index in range(previous.RUN_COUNT) if index not in previous.PILOT_POSITIONS][:107])
    missing = [index for index in range(previous.RUN_COUNT) if index not in set(inherited)]
    proof = {'validRunIndices': list(previous.PILOT_POSITIONS) + [index for index in range(previous.RUN_COUNT) if index not in previous.PILOT_POSITIONS][:107]}
    plan = {'contractVersion': recovery.CONTRACT, 'endpoint': previous.ENDPOINT, 'site': previous.SITE, 'runs': runs, 'inheritedRunIndices': inherited, 'missingRunIndices': missing, 'parentRoot': str(recovery.PARENT_ROOT), 'parentPartialProofSha256': recovery.PARTIAL_PROOF_SHA256, 'parentRetentionManifestSha256': recovery.RETENTION_MANIFEST_SHA256, 'parentRetentionReceiptSha256': recovery.RETENTION_RECEIPT_SHA256, 'expiresAtUtc': recovery.EXPIRY, 'maximumNewHttpRequests': 9564, 'maximumLocationRequests': 9564, 'maximumAttemptsPerRun': 3, 'minimumIntervalSeconds': 1, 'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000, 'retryableHttpStatuses': [502, 503, 504], 'retryBackoffSeconds': [5, 15], 'originalManifestSha256': previous.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': previous.ORIGINAL_NORMALIZED_SHA256}
    return runs, proof, plan


# represent one complete original-parity public forecast body
def source_response(run):
    origin = dt.datetime.strptime(run + 'Z', '%Y-%m-%dT%H:%M%z')
    time = [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(49)]
    rain = [None] + [round(lead / 100, 2) for lead in range(1, 49)]
    wind = [None] + [float(lead) for lead in range(1, 49)]
    body = previous.canonical_json({'latitude': 47.9, 'longitude': -122.4, 'elevation': 20., 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': previous.UNITS, 'hourly': {'time': time, 'precipitation': rain, 'wind_direction_10m': wind}})
    return body, {'grid': {'latitude': 47.9, 'longitude': -122.4}, 'rain': tuple(rain[1:])}


# validate only synthetic attempts, never the live recovery root
class RecoveryTests(unittest.TestCase):
    # make a private destination for one bounded request record
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'requests').mkdir(mode=0o700)
        self.runs, self.proof, self.plan = scope()
        self.run = self.runs[108]
        self.body, self.original = source_response(self.run)

    # remove only this test's source-free temporary directory
    def tearDown(self):
        self.temporary.cleanup()

    # prohibit added runs, larger retry budgets or a later deadline
    def test_exact_missing_plan_scope_and_expiry(self):
        now = dt.datetime(2026, 9, 13, 6, tzinfo=dt.timezone.utc)
        self.assertEqual(recovery.validate_plan(self.plan, self.runs, self.proof, recovery.RETENTION_MANIFEST_SHA256, recovery.RETENTION_RECEIPT_SHA256, now=now), self.plan)
        for key, value in (('maximumNewHttpRequests', 9565), ('maximumAttemptsPerRun', 4), ('timeoutSeconds', 91), ('minimumIntervalSeconds', 0), ('retryableHttpStatuses', [429, 502, 503, 504]), ('retryBackoffSeconds', [0, 0]), ('inheritedRunIndices', self.proof['validRunIndices']), ('missingRunIndices', self.plan['missingRunIndices'][1:]), ('parentRetentionReceiptSha256', '0' * 64)):
            changed = copy.deepcopy(self.plan)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(recovery.RecoveryError):
                recovery.validate_plan(changed, self.runs, self.proof, recovery.RETENTION_MANIFEST_SHA256, recovery.RETENTION_RECEIPT_SHA256, now=now)
        with self.assertRaises(recovery.RecoveryError):
            recovery.validate_plan(self.plan, self.runs, self.proof, recovery.RETENTION_MANIFEST_SHA256, recovery.RETENTION_RECEIPT_SHA256, now=dt.datetime(2026, 9, 14, 8, tzinfo=dt.timezone.utc))

    # retry only transport classes with a durable ended time and fixed backoff
    def test_transport_retries_and_partial_body(self):
        cases = ((TimeoutError('timeout'), 1, 5, None), (error.URLError('unavailable'), 2, 15, None), (http.client.IncompleteRead(b'partial'), 1, 5, b'partial'), (http.client.RemoteDisconnected('closed'), 3, 0, None))
        for index, (problem, attempt_in_run, backoff, partial) in enumerate(cases):
            with self.subTest(problem=type(problem).__name__), patch.object(previous, 'fetch', side_effect=problem) as fetch:
                receipt = recovery.attempt_once(self.root, self.plan, index, 108, self.run, self.original, attempt_in_run)
            self.assertEqual(fetch.call_count, 1)
            self.assertTrue(receipt['retryable'])
            self.assertEqual(receipt['retryScheduled'], attempt_in_run < 3)
            self.assertEqual(receipt['backoffSeconds'], backoff)
            self.assertEqual(receipt['status'], None)
            self.assertIsNone(receipt['responseReceivedAtUtc'])
            self.assertTrue(receipt['finishedAtUtc'].endswith('Z'))
            self.assertTrue((self.root / f'requests/{index:04d}/request.json').is_file())
            self.assertEqual((self.root / f'requests/{index:04d}/receipt.json').is_file(), True)
            raw = self.root / f'requests/{index:04d}/response-body.bin'
            self.assertEqual(raw.read_bytes() if raw.exists() else None, partial)

    # 502/503/504 retry even with an empty error body, but 429 never does
    def test_http_retry_statuses_and_fatal_parity(self):
        for index, status in enumerate((502, 503, 504, 429)):
            with patch.object(previous, 'fetch', return_value=(status, {}, b'')):
                receipt = recovery.attempt_once(self.root, self.plan, index, 108, self.run, self.original, 1)
            self.assertEqual(receipt['retryable'], status in (502, 503, 504))
            self.assertEqual(receipt['retryScheduled'], status in (502, 503, 504))
            self.assertEqual((self.root / f'requests/{index:04d}/response-body.bin').read_bytes(), b'')
        wrong = json.loads(self.body)
        wrong['hourly']['precipitation'][48] = 999.
        with patch.object(previous, 'fetch', return_value=(200, {}, previous.canonical_json(wrong))):
            receipt = recovery.attempt_once(self.root, self.plan, 4, 108, self.run, self.original, 1)
        self.assertEqual(receipt['result'], 'failed')
        self.assertFalse(receipt['retryable'])
        self.assertIn('parity', receipt['error'])

    # a successful original forecast response is one selected run, not one retry
    def test_success_receipt_and_exact_query(self):
        with patch.object(previous, 'fetch', return_value=(200, {'Content-Type': 'application/json'}, self.body)) as fetch:
            receipt = recovery.attempt_once(self.root, self.plan, 0, 108, self.run, self.original, 1)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.args[1:], (90, 2_000_000))
        self.assertEqual(receipt['result'], 'success')
        self.assertEqual(receipt['contentSha256'], previous.sha256(self.body))
        self.assertFalse(receipt['retryable'])
        self.assertEqual(receipt['summary']['directionFootprintNonNullHours'], 29)
        with self.assertRaises(FileExistsError):
            recovery.attempt_once(self.root, self.plan, 0, 108, self.run, self.original, 1)

    # chronological output preserves source lineage and nullable direction
    def test_normalized_lineage_from_parent_and_new_responses(self):
        other = self.runs[109]
        second_body, second_original = source_response(other)
        selected = {}
        # one inherited and one newly acquired body are distinct provenance
        for index, (run, body, origin, original) in enumerate(((self.run, self.body, 'parentInherited', self.original), (other, second_body, 'newAcquired', second_original))):
            relative = f'inputs/parent-root/requests/{index:04d}' if index == 0 else f'requests/{index:04d}'
            directory = self.root / relative
            directory.mkdir(mode=0o700, parents=True)
            (directory / 'response-body.bin').write_bytes(body)
            summary, _, _ = previous.validate_response(body, run, original)
            receipt = {'result': 'success', 'contentSha256': previous.sha256(body), 'responseReceivedAtUtc': '2026-09-13T06:00:00Z', 'summary': summary}
            (directory / 'receipt.json').write_bytes(previous.canonical_json(receipt))
            selected[index] = {'origin': origin, 'attemptIndex': index, 'rawBodyFile': relative + '/response-body.bin', 'bodySha256': previous.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc']}
        output = recovery.normalize_all(self.root, {'runs': [self.run, other]}, {self.run: self.original, other: second_original}, selected)
        self.assertEqual(output['responseLineageRows'], previous.RUN_COUNT)
        rows = [json.loads(line) for line in (self.root / recovery.NORMALIZED_FILE).read_bytes().splitlines()]
        lineage = [json.loads(line) for line in (self.root / recovery.LINEAGE_FILE).read_bytes().splitlines()]
        self.assertEqual(len(rows), 96)
        self.assertEqual([item['origin'] for item in lineage], ['parentInherited', 'newAcquired'])
        self.assertEqual(rows[0]['rawWindDirectionDegrees'], 1.)
        self.assertEqual(rows[48]['runInitializedAt'], other + ':00Z')
        with self.assertRaises(FileExistsError):
            recovery.normalize_all(self.root, {'runs': [self.run, other]}, {self.run: self.original, other: second_original}, selected)

    # one missing run consumes a recorded retry before a unique selected body
    def test_run_loop_counts_attempts_separately_from_unique_runs(self):
        private_base = Path.home() / '.weather/research-work'
        with tempfile.TemporaryDirectory(prefix='weather-moisture-research-recovery-test-', dir=private_base) as temporary:
            root = Path(temporary)
            (root / 'recovery-freeze.json').write_bytes(b'freeze\n')
            plan = {**self.plan, 'missingRunIndices': [108]}
            freeze = {'planSha256': 'synthetic-plan', 'parentRetentionManifestSha256': recovery.RETENTION_MANIFEST_SHA256, 'parentRetentionReceiptSha256': recovery.RETENTION_RECEIPT_SHA256}
            inherited = {index: {'runIndex': index, 'run': run, 'attemptIndex': index, 'bodySha256': 'a' * 64, 'responseReceivedAtUtc': '2026-09-13T06:00:00Z', 'rawBodyFile': f'requests/{index:04d}/response-body.bin'} for index, run in enumerate(self.runs) if index != 108}
            # preflight is synthetic, so no archived source or public URL is read
            def frozen(_root, full=False, check_expiry=True):
                return (root, plan, freeze, self.runs, {self.run: self.original}, inherited) if full else (root, plan, freeze)

            retry = {'result': 'retryableFailure', 'status': None, 'errorType': 'TimeoutError', 'error': 'timeout', 'contentSha256': None, 'retryScheduled': True, 'retryable': True, 'backoffSeconds': 5}
            success = {'result': 'success', 'status': 200, 'errorType': None, 'error': None, 'contentSha256': 'b' * 64, 'responseReceivedAtUtc': '2026-09-13T06:00:10Z', 'retryScheduled': False, 'retryable': False, 'backoffSeconds': 0}
            with patch.object(recovery, 'validate_freeze', side_effect=frozen), patch.object(recovery, 'attempt_once', side_effect=(retry, success)) as attempted, patch.object(recovery, 'normalize_all', return_value={'normalizedFile': recovery.NORMALIZED_FILE}) as normalized, patch.object(recovery, 'MISSING_COUNT', 1), patch.object(recovery.time, 'sleep') as slept:
                report = recovery.run(root)
            self.assertEqual(attempted.call_count, 2)
            self.assertEqual(report['newHttpAttempts'], 2)
            self.assertEqual(report['newSuccessfulRuns'], 1)
            self.assertEqual(report['uniqueSuccessfulRuns'], previous.RUN_COUNT)
            self.assertEqual(report['totalHttpAttempts'], recovery.PARENT_ATTEMPTS + 2)
            self.assertEqual(report['retryableFailuresBeforeSuccessOrStop'], 1)
            self.assertEqual(normalized.call_count, 1)
            self.assertGreaterEqual(slept.call_args.args[0], 4.9)
            self.assertEqual(json.loads((root / 'report.json').read_bytes())['status'], 'complete')


# run only the local no-network synthetic suite
if __name__ == '__main__':
    unittest.main()
