"""lock bounded wind-source continuation without new public requests."""

import copy
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import acquire_rain_direction as old
import acquire_rain_wind_continuation as continuation
import acquire_rain_wind_source as wind


# build original keys without any outcome or prediction fields
def scope():
    runs = [(dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(hours=6 * index)).strftime('%Y-%m-%dT%H:%M') for index in range(old.RUN_COUNT)]
    selected = {index: {} for index in range(continuation.INHERITED)}
    return runs, selected, continuation.build_plan(runs, selected)


# supply one valid source body for either approved horizon
def response(run, hours):
    origin = dt.datetime.strptime(run + 'Z', '%Y-%m-%dT%H:%M%z')
    rain = [None] + [round(lead / 100, 2) for lead in range(1, hours)]
    direction = [None] + [float(lead) for lead in range(1, hours)]
    body = old.canonical_json({'latitude': 47.9, 'longitude': -122.4, 'elevation': 20., 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': old.UNITS, 'hourly': {'time': [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(hours)], 'precipitation': rain, 'wind_direction_10m': direction}})
    original = {'grid': {'latitude': 47.9, 'longitude': -122.4}, 'rain': tuple(round(lead / 100, 2) for lead in range(1, 49))}
    return body, original


# use only synthetic local bodies and fake request receipts
class ContinuationTests(unittest.TestCase):
    # create a temporary output root without a network client
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    # remove only this test's temporary artifacts
    def tearDown(self):
        self.temporary.cleanup()

    # exact original complement and lower new cap reject scope drift
    def test_plan_scope_and_expiry(self):
        runs, selected, plan = scope()
        now = dt.datetime(2026, 9, 13, 7, tzinfo=dt.timezone.utc)
        self.assertEqual(continuation.validate_plan(plan, runs, selected, now=now), plan)
        for key, value in (('maximumNewHttpRequests', 3177), ('maximumAttemptsPerRun', 3), ('minimumIntervalSeconds', 0), ('retryBackoffSeconds', [0]), ('forecastHours', 49), ('inheritedRunIndices', []), ('missingRunIndices', []), ('interruptedProofSha256', '0' * 64)):
            changed = copy.deepcopy(plan)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(continuation.ContinuationError):
                continuation.validate_plan(changed, runs, selected, now=now)
        with self.assertRaises(continuation.ContinuationError):
            continuation.validate_plan(plan, runs, selected, now=dt.datetime(2026, 9, 14, 8, tzinfo=dt.timezone.utc))

    # old full, interrupted short, new short and unknown each have honest lineage
    def test_normalized_explicit_inherited_lineage(self):
        runs = ['2024-05-07T00:00', '2024-05-07T06:00', '2024-05-07T12:00', '2024-05-07T18:00']
        origins = ('parentInherited', 'interruptedInherited', 'newAcquired', 'transportUnresolved')
        selected, originals = {}, {}
        for index, (run, origin) in enumerate(zip(runs, origins)):
            body, original = response(run, 49 if index == 0 else 35)
            if index == 1:
                changed = json.loads(body)
                changed['hourly']['wind_direction_10m'][7] = None
                body = old.canonical_json(changed)
            if index == 3:
                body = wind.KNOWN_TIMEOUT_BODY
            relative = f'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/requests/{index:04d}' if index == 0 else f'inputs/interrupted-source/requests/{index:04d}' if index == 1 else f'requests/{index:04d}'
            directory = self.root / relative
            directory.mkdir(mode=0o700, parents=True)
            (directory / 'response-body.bin').write_bytes(body)
            summary = old.validate_response(body, run, original)[0] if index == 0 else wind.validate_response(body, run, original)[0] if index in (1, 2) else None
            receipt = {'result': 'success' if index < 3 else 'transportUnresolved', 'status': 200, 'contentSha256': old.sha256(body), 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'summary': summary}
            (directory / 'receipt.json').write_bytes(old.canonical_json(receipt))
            selected[index] = {'origin': origin, 'attemptIndex': index, 'rawBodyFile': relative + '/response-body.bin', 'bodySha256': old.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc']}
            originals[run] = original
        continuation.normalize_all(self.root, {'runs': runs}, originals, selected)
        rows = [json.loads(line) for line in (self.root / continuation.NORMALIZED_FILE).read_bytes().splitlines()]
        lineage = [json.loads(line) for line in (self.root / continuation.LINEAGE_FILE).read_bytes().splitlines()]
        self.assertEqual(len(rows), 192)
        self.assertEqual([item['origin'] for item in lineage], list(origins))
        self.assertEqual([item['directionLeadCount'] for item in lineage], [48, 34, 34, 0])
        self.assertTrue(lineage[1]['rawBodyFile'].startswith('inputs/interrupted-source/requests/'))
        self.assertEqual([rows[index]['directionSourceStatus'] for index in (0, 48, 81, 82, 96, 144)], ['available', 'available', 'available', 'notRequested', 'available', 'transportUnresolved'])
        self.assertEqual(rows[54]['directionSourceStatus'], 'providerNull')
        self.assertEqual(rows[82]['rawPrecipitationMm'], originals[runs[1]]['rain'][34])
        self.assertIsNone(rows[144]['rawWindDirectionDegrees'])

    # a retry is scheduled by the completion-based helper, not the old start clock
    def test_run_composes_attempt_and_spacing(self):
        run = '2024-05-07T00:00'
        plan = {'runs': [run], 'missingRunIndices': [0]}
        freeze = {'planSha256': 'synthetic'}
        (self.root / 'wind-continuation-freeze.json').write_bytes(b'freeze\n')
        first = {'result': 'retryableFailure', 'status': 503, 'errorType': 'RetryableHttpStatus', 'error': 'HTTP 503', 'contentSha256': None, 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'retryScheduled': True, 'retryable': True}
        second = {'result': 'success', 'status': 200, 'errorType': None, 'error': None, 'contentSha256': 'a' * 64, 'responseReceivedAtUtc': '2026-09-13T07:00:16Z', 'retryScheduled': False, 'retryable': False}
        calls = []

        # fake the spacing surface without a wall sleep
        class FakeSpacing:
            def wait(self):
                calls.append('wait')

            def mark_completed(self, retry=False):
                calls.append(('completed', retry))

        # synthetic phase data cannot touch the retained production archive
        def frozen(_root, full=False, check_expiry=True):
            return (self.root, plan, freeze, [run], {run: response(run, 35)[1]}, {}) if full else (self.root, plan, freeze)

        with patch.object(old, 'validate_private_root', side_effect=lambda value: value), patch.object(continuation, 'ROOT', self.root), patch.object(continuation, 'validate_freeze', side_effect=frozen), patch.object(continuation, 'RequestSpacing', return_value=FakeSpacing()), patch.object(wind, 'attempt_once', side_effect=(first, second)) as attempt, patch.object(continuation, 'normalize_all', return_value={'normalizedFile': continuation.NORMALIZED_FILE}) as normalized, patch.object(old, 'RUN_COUNT', 1), patch.object(continuation, 'MISSING', 1):
            report = continuation.run(self.root)
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(calls, ['wait', ('completed', True), 'wait', ('completed', False)])
        self.assertEqual((report['status'], report['sourceQualified'], report['newHttpAttempts']), ('complete', True, 2))
        self.assertEqual((report['parentTransportPolicyConformant'], report['inheritedSpacingViolationCount']), (False, 25))
        self.assertEqual(normalized.call_count, 1)

    # an exact second timeout exceeding a fixed monthly cap stops new calls
    def test_early_source_cap_stops_requests(self):
        run = '2024-02-01T00:00'
        plan = {'runs': [run], 'missingRunIndices': [0]}
        freeze = {'planSha256': 'synthetic'}
        (self.root / 'wind-continuation-freeze.json').write_bytes(b'freeze\n')
        first = {'result': 'retryableFailure', 'status': 200, 'errorType': 'KnownStreamingTimeout', 'error': 'known streaming timeout', 'contentSha256': wind.KNOWN_TIMEOUT_SHA256, 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'retryScheduled': True, 'retryable': True}
        second = {**first, 'result': 'transportUnresolved', 'retryScheduled': False}

        # no actual source data or network client participates in this loop
        def frozen(_root, full=False, check_expiry=True):
            return (self.root, plan, freeze, [run], {run: response(run, 35)[1]}, {}) if full else (self.root, plan, freeze)

        with patch.object(old, 'validate_private_root', side_effect=lambda value: value), patch.object(continuation, 'ROOT', self.root), patch.object(continuation, 'validate_freeze', side_effect=frozen), patch.object(continuation, 'RequestSpacing') as spacing, patch.object(wind, 'attempt_once', side_effect=(first, second)) as attempt, self.assertRaises(continuation.ContinuationError):
            continuation.run(self.root)
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(spacing.return_value.mark_completed.call_count, 2)
        report = json.loads((self.root / 'report.json').read_bytes())
        self.assertEqual((report['status'], report['sourceQualified'], report['newHttpAttempts']), ('failed', False, 2))
        self.assertEqual(report['failure']['errorType'], 'SourceCoverageExceeded')
        self.assertFalse((self.root / continuation.NORMALIZED_FILE).exists())


    # fatal 429 never consumes a second attempt or claims complete source
    def test_fatal_status_stops_without_retry(self):
        run = '2024-05-07T00:00'
        plan = {'runs': [run], 'missingRunIndices': [0]}
        freeze = {'planSha256': 'synthetic'}
        (self.root / 'wind-continuation-freeze.json').write_bytes(b'freeze\n')
        fatal = {'result': 'failed', 'status': 429, 'errorType': 'FatalHttpStatus', 'error': 'HTTP 429', 'contentSha256': None, 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'retryScheduled': False, 'retryable': False}

        # fake only the reviewed phase boundary, never the network response
        def frozen(_root, full=False, check_expiry=True):
            return (self.root, plan, freeze, [run], {run: response(run, 35)[1]}, {}) if full else (self.root, plan, freeze)

        with patch.object(old, 'validate_private_root', side_effect=lambda value: value), patch.object(continuation, 'ROOT', self.root), patch.object(continuation, 'validate_freeze', side_effect=frozen), patch.object(continuation, 'RequestSpacing') as spacing, patch.object(wind, 'attempt_once', return_value=fatal) as attempt, self.assertRaises(continuation.ContinuationError):
            continuation.run(self.root)
        self.assertEqual(attempt.call_count, 1)
        self.assertEqual(spacing.return_value.mark_completed.call_count, 1)
        report = json.loads((self.root / 'report.json').read_bytes())
        self.assertEqual((report['status'], report['newHttpAttempts'], report['failure']['status']), ('failed', 1, 429))
        self.assertFalse(report['sourceQualified'])


# run only local no-network continuation tests
if __name__ == '__main__':
    unittest.main()
