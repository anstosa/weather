"""lock 35-hour wind source bounds without public requests."""

import copy
import datetime as dt
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib import error

import acquire_rain_direction as old
import acquire_rain_wind_source as wind


# create a complete original-key plan without source observations
def scope():
    runs = [(dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(hours=6 * index)).strftime('%Y-%m-%dT%H:%M') for index in range(old.RUN_COUNT)]
    indices = sorted(list(old.PILOT_POSITIONS) + [index for index in range(old.RUN_COUNT) if index not in old.PILOT_POSITIONS][:107])
    selected = {index: {} for index in indices}
    missing = [index for index in range(old.RUN_COUNT) if index not in selected]
    plan = {'contractVersion': wind.CONTRACT, 'endpoint': old.ENDPOINT, 'site': old.SITE, 'runs': runs, 'inheritedRunIndices': indices, 'missingRunIndices': missing, 'previousRecoveryRoot': str(wind.PARENT_ROOT), 'previousFailureProofSha256': wind.FAILURE_PROOF_SHA256, 'previousRetentionManifestSha256': wind.RETENTION_MANIFEST_SHA256, 'previousRetentionReceiptSha256': wind.RETENTION_RECEIPT_SHA256, 'originalManifestSha256': old.ORIGINAL_MANIFEST_SHA256, 'originalSourceSha256': old.ORIGINAL_NORMALIZED_SHA256, 'expiresAtUtc': wind.EXPIRY, 'maximumNewHttpRequests': 6376, 'maximumLocationRequests': 6376, 'maximumAttemptsPerRun': 2, 'minimumIntervalSeconds': 1, 'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000, 'retryableHttpStatuses': [502, 503, 504], 'retryBackoffSeconds': [15], 'forecastHours': 35, 'unresolvedFractionNumerator': 1, 'unresolvedFractionDenominator': 100, 'knownTimeoutBodySha256': wind.KNOWN_TIMEOUT_SHA256}
    return runs, selected, plan


# construct one valid short response against old 48-hour rain
def response(run, hours=35):
    origin = dt.datetime.strptime(run + 'Z', '%Y-%m-%dT%H:%M%z')
    rain = [None] + [round(lead / 100, 2) for lead in range(1, hours)]
    direction = [None] + [float(lead) for lead in range(1, hours)]
    body = old.canonical_json({'latitude': 47.9, 'longitude': -122.4, 'elevation': 20., 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': old.UNITS, 'hourly': {'time': [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(hours)], 'precipitation': rain, 'wind_direction_10m': direction}})
    original = {'grid': {'latitude': 47.9, 'longitude': -122.4}, 'rain': tuple(round(lead / 100, 2) for lead in range(1, 49))}
    return body, original


# exercise only synthetic responses and private temporary receipts
class WindSourceTests(unittest.TestCase):
    # give each test an isolated request directory
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'requests').mkdir(mode=0o700)
        self.runs, self.selected, self.plan = scope()
        self.run = self.runs[108]
        self.body, self.original = response(self.run)

    # remove only this synthetic temporary directory
    def tearDown(self):
        self.temporary.cleanup()

    # reject any increased request budget or altered source population
    def test_exact_plan_and_expiry(self):
        now = dt.datetime(2026, 9, 13, 7, tzinfo=dt.timezone.utc)
        self.assertEqual(wind.validate_plan(self.plan, self.runs, self.selected, now=now), self.plan)
        for key, value in (('maximumNewHttpRequests', 6377), ('maximumAttemptsPerRun', 3), ('forecastHours', 49), ('retryBackoffSeconds', [0]), ('retryableHttpStatuses', [429, 502, 503, 504]), ('inheritedRunIndices', []), ('missingRunIndices', self.plan['missingRunIndices'][1:]), ('unresolvedFractionNumerator', 2), ('knownTimeoutBodySha256', '0' * 64)):
            changed = copy.deepcopy(self.plan)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(wind.WindSourceError):
                wind.validate_plan(changed, self.runs, self.selected, now=now)
        with self.assertRaises(wind.WindSourceError):
            wind.validate_plan(self.plan, self.runs, self.selected, now=dt.datetime(2026, 9, 14, 8, tzinfo=dt.timezone.utc))

    # accept exactly 34 old-rain leads and the requested direction horizon
    def test_short_response_parity_and_schema(self):
        summary, rain, direction = wind.validate_response(self.body, self.run, self.original)
        self.assertEqual((summary['forecastHours'], len(rain), len(direction)), (35, 35, 35))
        self.assertTrue(summary['directionFootprintComplete'])
        for change in ('rain', 'timestamp', 'grid', 'direction', 'length'):
            item = json.loads(self.body)
            if change == 'rain':
                item['hourly']['precipitation'][34] = 999.
            elif change == 'timestamp':
                item['hourly']['time'][34] = self.run
            elif change == 'grid':
                item['latitude'] = 48.
            elif change == 'direction':
                item['hourly']['wind_direction_10m'][7] = 361.
            else:
                item['hourly']['wind_direction_10m'].append(None)
            with self.subTest(change=change), self.assertRaises(ValueError):
                wind.validate_response(old.canonical_json(item), self.run, self.original)
        # the 35th old rain lead is outside the new query and is not compared
        changed = {**self.original, 'rain': (*self.original['rain'][:34], 999., *self.original['rain'][35:])}
        wind.validate_response(self.body, self.run, changed)

    # the exact text timeout retries once then becomes transport unresolved
    def test_known_timeout_and_retry_classification(self):
        with patch.object(old, 'fetch', return_value=(200, {}, wind.KNOWN_TIMEOUT_BODY)) as fetch:
            first = wind.attempt_once(self.root, self.plan, 0, 108, self.run, self.original, 1)
            second = wind.attempt_once(self.root, self.plan, 1, 108, self.run, self.original, 2)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual((first['result'], first['retryScheduled'], first['backoffSeconds']), ('retryableFailure', True, 15))
        self.assertEqual((second['result'], second['retryScheduled'], second['contentSha256']), ('transportUnresolved', False, wind.KNOWN_TIMEOUT_SHA256))
        self.assertEqual((self.root / 'requests/0001/response-body.bin').read_bytes(), wind.KNOWN_TIMEOUT_BODY)
        self.assertTrue(second['finishedAtUtc'].endswith('Z'))

    # transport and 502 retry only once while 429 and bad rain fail closed
    def test_transport_http_and_parity(self):
        for index, failure in enumerate((TimeoutError('timeout'), error.URLError('missing'), http.client.IncompleteRead(b'partial'), http.client.RemoteDisconnected('closed'))):
            with self.subTest(failure=type(failure).__name__), patch.object(old, 'fetch', side_effect=failure):
                receipt = wind.attempt_once(self.root, self.plan, index, 108, self.run, self.original, 1)
            self.assertEqual((receipt['result'], receipt['retryScheduled']), ('retryableFailure', True))
        with patch.object(old, 'fetch', return_value=(503, {}, b'')):
            receipt = wind.attempt_once(self.root, self.plan, 4, 108, self.run, self.original, 2)
        self.assertEqual((receipt['result'], receipt['retryable'], receipt['retryScheduled']), ('failed', True, False))
        with patch.object(old, 'fetch', return_value=(429, {}, b'')):
            receipt = wind.attempt_once(self.root, self.plan, 5, 108, self.run, self.original, 1)
        self.assertEqual((receipt['result'], receipt['retryable']), ('failed', False))
        wrong = json.loads(self.body)
        wrong['hourly']['precipitation'][34] = 999.
        with patch.object(old, 'fetch', return_value=(200, {}, old.canonical_json(wrong))):
            receipt = wind.attempt_once(self.root, self.plan, 6, 108, self.run, self.original, 1)
        self.assertEqual((receipt['result'], receipt['retryable']), ('failed', False))

    # require global and per-decision-month coverage without rounding
    def test_month_coverage(self):
        runs = [f'2024-01-{day:02d}T00:00' for day in range(1, 32)] + [f'2024-02-{day:02d}T00:00' for day in range(1, 30)]
        coverage, qualified = wind.month_coverage(runs, set())
        self.assertTrue(qualified)
        self.assertEqual(coverage['2024-02']['totalRuns'], 29)
        coverage, qualified = wind.month_coverage(runs, {31})
        self.assertFalse(qualified)
        self.assertEqual(coverage['2024-02']['unresolvedRuns'], 1)

    # normalize inherited, acquired and transport-unresolved rows distinctly
    def test_normalized_status_and_lineage(self):
        runs = self.runs[108:111]
        originals = {}
        selected = {}
        for index, origin in enumerate(('parentInherited', 'newAcquired', 'transportUnresolved')):
            run = runs[index]
            body, original = response(run, 49 if index == 0 else 35)
            if index == 2:
                body = wind.KNOWN_TIMEOUT_BODY
            relative = f'inputs/previous-recovery/inputs/parent-root/requests/{index:04d}' if index == 0 else f'requests/{index:04d}'
            directory = self.root / relative
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            (directory / 'response-body.bin').write_bytes(body)
            summary = old.validate_response(body, run, original)[0] if index == 0 else wind.validate_response(body, run, original)[0] if index == 1 else None
            receipt = {'result': 'success' if index < 2 else 'transportUnresolved', 'status': 200, 'contentSha256': old.sha256(body), 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'summary': summary}
            (directory / 'receipt.json').write_bytes(old.canonical_json(receipt))
            selected[index] = {'origin': origin, 'attemptIndex': index, 'rawBodyFile': relative + '/response-body.bin', 'bodySha256': old.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc']}
            originals[run] = original
        wind.normalize_all(self.root, {'runs': runs}, originals, selected)
        rows = [json.loads(line) for line in (self.root / wind.NORMALIZED_FILE).read_bytes().splitlines()]
        lineage = [json.loads(line) for line in (self.root / wind.LINEAGE_FILE).read_bytes().splitlines()]
        self.assertEqual(len(rows), 144)
        self.assertEqual([line['directionLeadCount'] for line in lineage], [48, 34, 0])
        self.assertEqual([rows[index]['directionSourceStatus'] for index in (0, 48, 81, 82, 96)], ['available', 'available', 'available', 'notRequested', 'transportUnresolved'])
        self.assertEqual(rows[82]['rawPrecipitationMm'], originals[runs[1]]['rain'][34])
        self.assertIsNone(rows[96]['rawWindDirectionDegrees'])


    # stop after an irreversible monthly cap breach without further GETs
    def test_run_stops_on_fixed_population_quality_cap(self):
        run = '2024-02-01T00:00'
        plan = {'runs': [run], 'missingRunIndices': [0], 'minimumIntervalSeconds': 1}
        freeze = {'planSha256': 'synthetic'}
        (self.root / 'requests').rmdir()
        (self.root / 'wind-source-freeze.json').write_bytes(b'freeze\n')
        first = {'result': 'retryableFailure', 'status': 200, 'errorType': 'KnownStreamingTimeout', 'error': 'known streaming timeout', 'contentSha256': wind.KNOWN_TIMEOUT_SHA256, 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'retryScheduled': True, 'retryable': True, 'backoffSeconds': 15}
        second = {**first, 'result': 'transportUnresolved', 'retryScheduled': False, 'backoffSeconds': 0}
        # this synthetic phase never reads a real source or starts a network request
        def frozen(_root, full=False, check_expiry=True):
            return (self.root, plan, freeze, [run], {run: self.original}, {}) if full else (self.root, plan, freeze)

        with patch.object(old, 'validate_private_root', side_effect=lambda value: value), patch.object(wind, 'validate_freeze', side_effect=frozen), patch.object(wind, 'attempt_once', side_effect=(first, second)) as attempt, patch.object(wind.time, 'sleep'), self.assertRaises(wind.WindSourceError):
            wind.run(self.root)
        self.assertEqual(attempt.call_count, 2)
        report = json.loads((self.root / 'report.json').read_bytes())
        self.assertEqual((report['status'], report['sourceQualified'], report['newHttpAttempts']), ('failed', False, 2))
        self.assertEqual(report['failure']['errorType'], 'SourceCoverageExceeded')
        self.assertFalse((self.root / wind.NORMALIZED_FILE).exists())


# run only the local synthetic no-network suite
if __name__ == '__main__':
    unittest.main()
