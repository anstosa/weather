"""exercise independent continuation timing and lineage without HTTP or labels."""

import datetime as dt
import unittest
from unittest.mock import patch

import verify_rain_wind_continuation as verify


# represent one retained successful attempt without a live network call
def record(index, run_index, ordinal, started, finished, result='success'):
    return {
        'requestIndex': index,
        'runIndex': run_index,
        'attemptInRun': ordinal,
        'startedAtUtc': started,
        'finishedAtUtc': finished,
        'result': result,
        'parsed': {} if result == 'success' else None,
        'responseSha256': 'a' * 64 if result == 'success' else None,
    }


# verify only the new fixed response-completion cadence
class ContinuationSpacingTests(unittest.TestCase):
    # one second after the prior receipt passes even if parent had failed cadence
    def test_completion_based_spacing_passes(self):
        records = [
            record(0, 1710, 1, '2026-09-13T08:00:00Z', '2026-09-13T08:00:03Z'),
            record(1, 1711, 1, '2026-09-13T08:00:04.050000Z', '2026-09-13T08:00:05Z'),
        ]
        selected, unresolved = verify.validate_new_sequence(records, [1710, 1711], '2026-09-13T07:39:12.045428Z')
        self.assertEqual(set(selected), {1710, 1711})
        self.assertEqual(unresolved, {})

    # starts separated by one second can still violate the receipt-completion rule
    def test_old_start_based_scheduler_is_rejected(self):
        records = [
            record(0, 1710, 1, '2026-09-13T08:00:00Z', '2026-09-13T08:00:03Z'),
            record(1, 1711, 1, '2026-09-13T08:00:01.050000Z', '2026-09-13T08:00:05Z'),
        ]
        # independent new scheduler rejects the old loop-start failure mode
        with self.assertRaises(ValueError):
            verify.validate_new_sequence(records, [1710, 1711], '2026-09-13T07:39:12.045428Z')

    # the first new start must also follow the last interrupted parent receipt
    def test_first_new_request_after_parent_finish(self):
        records = [record(0, 1710, 1, '2026-09-13T08:00:00Z', '2026-09-13T08:00:02Z')]
        with self.assertRaises(ValueError):
            verify.validate_new_sequence(records, [1710], '2026-09-13T07:59:59.500000Z')

    # a retry retains both fifteen-second completion backoff and one-second minimum
    def test_retried_run_requires_fifteen_seconds_after_completion(self):
        records = [
            record(0, 1710, 1, '2026-09-13T08:00:00Z', '2026-09-13T08:00:02Z', 'retryableFailure'),
            record(1, 1710, 2, '2026-09-13T08:00:17.050000Z', '2026-09-13T08:00:18Z'),
        ]
        selected, _ = verify.validate_new_sequence(records, [1710], '2026-09-13T07:39:12Z')
        self.assertEqual(set(selected), {1710})
        records[1]['startedAtUtc'] = '2026-09-13T08:00:16.950000Z'
        # a fourteen-point-nine-five-second retry cannot pass
        with self.assertRaises(ValueError):
            verify.validate_new_sequence(records, [1710], '2026-09-13T07:39:12Z')

    # replay exact V3-format producer receipts under V4 completed-response timing
    def test_producer_attempts_replay_retry_success_and_known_timeout(self):
        import tempfile
        from pathlib import Path

        import acquire_rain_direction as old
        import acquire_rain_wind_source as wind
        from test_acquire_rain_wind_continuation import response

        runs = ('2024-05-07T00:00', '2024-05-07T06:00')
        valid, first = response(runs[0], 35)
        _, second = response(runs[1], 35)
        profiles = [{'run': run, 'initialized': run + ':00Z', 'grid': (47.9, -122.4), 'precipitation': original['rain']} for run, original in zip(runs, (first, second))]
        starts = ('2026-09-13T08:00:00Z', '2026-09-13T08:00:17Z', '2026-09-13T08:00:19Z', '2026-09-13T08:00:35Z')
        stamps = []
        # each mocked public call has start, response and durable completion
        for start in starts:
            moment = dt.datetime.fromisoformat(start.replace('Z', '+00:00'))
            stamps.extend((start, (moment + dt.timedelta(milliseconds=200)).isoformat().replace('+00:00', 'Z'), (moment + dt.timedelta(seconds=1)).isoformat().replace('+00:00', 'Z')))
        fetches = ((503, {}, b''), (200, {}, valid), (200, {}, wind.KNOWN_TIMEOUT_BODY), (200, {}, wind.KNOWN_TIMEOUT_BODY))
        with tempfile.TemporaryDirectory() as temporary, patch.object(old, 'fetch', side_effect=fetches), patch.object(old, 'utc_stamp', side_effect=stamps):
            root = Path(temporary)
            (root / 'requests').mkdir()
            plan = {'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000}
            # no network call enters the synthetic producer attempt writer
            for index, (run_index, ordinal) in enumerate(((0, 1), (0, 2), (1, 1), (1, 2))):
                wind.attempt_once(root, plan, index, run_index, runs[run_index], (first, first, second, second)[index], ordinal)
            records = [verify.previous.audit_attempt(root, index, run_index, ordinal, profiles[run_index]) for index, (run_index, ordinal) in enumerate(((0, 1), (0, 2), (1, 1), (1, 2)))]
            selected, unresolved = verify.validate_new_sequence(records, [0, 1], '2026-09-13T07:59:58Z')
            self.assertEqual((set(selected), set(unresolved)), ({0}, {1}))
            self.assertEqual([item['result'] for item in records], ['retryableFailure', 'success', 'retryableFailure', 'transportUnresolved'])
            # one changed retained timeout body cannot be selected as unknown
            (root / 'requests/0003/response-body.bin').write_bytes(b'not the known timeout')
            with self.assertRaises(ValueError):
                verify.previous.audit_attempt(root, 3, 1, 2, profiles[1])


# retain source missingness cause without using observations
class ContinuationLineageTests(unittest.TestCase):
    # interrupted inherited 35h tail differs from old full 49h source
    def test_all_four_origins_are_distinct(self):
        full = tuple(range(49))
        short = tuple(range(35))
        self.assertEqual(verify.direction_rows('parentInherited', full)[-1], (48, 'available'))
        self.assertEqual(verify.direction_rows('interruptedInherited', short)[34:], [(None, 'notRequested')] * 14)
        self.assertEqual(verify.direction_rows('newAcquired', short)[34:], [(None, 'notRequested')] * 14)
        self.assertEqual(verify.direction_rows('transportUnresolved', None), [(None, 'transportUnresolved')] * 48)

    # provider null stays distinct from absent requested tail and transport
    def test_provider_null_only_within_requested_leads(self):
        short = [float(index) for index in range(35)]
        short[7] = None
        rows = verify.direction_rows('interruptedInherited', short)
        self.assertEqual(rows[6], (None, 'providerNull'))
        self.assertEqual(rows[34], (None, 'notRequested'))
        self.assertEqual(sum(status == 'providerNull' for _, status in rows), 1)

    # independent output checker rejects changed inherited provenance bytes
    def test_interrupted_lineage_cannot_be_rewritten_as_new(self):
        import tempfile
        from pathlib import Path
        identity = {'run': '2025-07-27T18:00', 'initialized': '2025-07-27T18:00:00Z', 'grid': (47.97891, -122.44185), 'precipitation': tuple(float(index) / 10 for index in range(1, 49))}
        source = {'origin': 'interruptedInherited', 'attemptIndex': 1600, 'rawBodyFile': 'inputs/interrupted-source/requests/1600/response-body.bin', 'responseSha256': 'a' * 64, 'responseReceivedAtUtc': '2026-09-13T07:39:12Z', 'direction': tuple(float(index) for index in range(35)), 'grid': identity['grid'], 'directionLeadCount': 34}
        with tempfile.TemporaryDirectory() as temporary, patch.object(verify.previous.original, 'RUNS', 1), patch.object(verify.previous.original, 'SOURCE_ROWS', 48):
            root = Path(temporary)
            (root / 'normalized').mkdir()
            lineage = {'originalRunIndex': 0, 'run': identity['run'], 'origin': source['origin'], 'sourceAttemptIndex': source['attemptIndex'], 'rawBodyFile': source['rawBodyFile'], 'responseSha256': source['responseSha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'directionLeadCount': 34}
            (root / verify.LINEAGE_PATH).write_bytes(verify.previous.original.canonical_json(lineage))
            start = verify.previous.utc_time(identity['initialized'])
            rows = []
            # old rain and unrequested tail survive all 48 output leads
            for lead, (wind, status) in enumerate(verify.direction_rows(source['origin'], source['direction']), 1):
                rows.append(verify.previous.original.canonical_json({'cohort': verify.previous.original.COHORT, 'key': f'{verify.previous.original.COHORT}|{identity["run"]}|lead={lead}', 'runInitializedAt': identity['initialized'], 'validAt': (start + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': identity['precipitation'][lead - 1], 'rawWindDirectionDegrees': wind, 'directionSourceStatus': status, 'returnedGrid': {'latitude': source['grid'][0], 'longitude': source['grid'][1]}, 'responseSha256': source['responseSha256'], 'responseReceivedAtUtc': source['responseReceivedAtUtc'], 'actualIssueAt': None}))
            normalized = root / verify.NORMALIZED_PATH
            normalized.write_bytes(b''.join(rows))
            report = {'normalizedFile': verify.NORMALIZED_PATH, 'normalizedRows': 48, 'normalizedSha256': verify.previous.file_sha256(normalized), 'responseLineageFile': verify.LINEAGE_PATH, 'responseLineageRows': 1, 'responseLineageSha256': verify.previous.file_sha256(root / verify.LINEAGE_PATH)}
            result = verify.audit_outputs(root, [identity], {0: source}, report)
            self.assertEqual(result['directionStatusRows']['notRequested'], 14)
            lineage['origin'] = 'newAcquired'
            (root / verify.LINEAGE_PATH).write_bytes(verify.previous.original.canonical_json(lineage))
            # the old failed-parent origin remains visible in final lineage
            with self.assertRaises(ValueError):
                verify.audit_outputs(root, [identity], {0: source}, report)

    # compare independent row replay to four producer-generated source origins
    def test_producer_rows_match_independent_four_origin_replay(self):
        import json
        import tempfile
        from pathlib import Path

        import acquire_rain_direction as old
        import acquire_rain_wind_continuation as producer
        import acquire_rain_wind_source as wind
        from test_acquire_rain_wind_continuation import response

        runs = ['2024-05-07T00:00', '2024-05-07T06:00', '2024-05-07T12:00', '2024-05-07T18:00']
        origins = ('parentInherited', 'interruptedInherited', 'newAcquired', 'transportUnresolved')
        producer_originals = {}
        producer_selected = {}
        verified_originals = []
        verified_selected = {}
        with tempfile.TemporaryDirectory() as temporary, patch.object(old, 'RUN_COUNT', 4), patch.object(verify.previous.original, 'RUNS', 4), patch.object(verify.previous.original, 'SOURCE_ROWS', 192):
            root = Path(temporary)
            # normalize a full, two short and one exact transport-unknown body
            for index, (run, origin) in enumerate(zip(runs, origins)):
                body, producer_original = response(run, 49 if index == 0 else 35)
                # represent one provider null without deleting its forecast row
                if index == 1:
                    changed = json.loads(body)
                    changed['hourly']['wind_direction_10m'][7] = None
                    body = old.canonical_json(changed)
                # only the fourth response is a known upstream timeout
                if index == 3:
                    body = wind.KNOWN_TIMEOUT_BODY
                base = 'inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root/requests' if index == 0 else 'inputs/interrupted-source/requests' if index == 1 else 'requests'
                relative = f'{base}/{index:04d}/response-body.bin'
                path = root / relative
                path.parent.mkdir(parents=True)
                path.write_bytes(body)
                summary = old.validate_response(body, run, producer_original)[0] if index == 0 else wind.validate_response(body, run, producer_original)[0] if index in (1, 2) else None
                receipt = {'result': 'success' if index < 3 else 'transportUnresolved', 'status': 200, 'contentSha256': old.sha256(body), 'responseReceivedAtUtc': '2026-09-13T07:00:00Z', 'summary': summary}
                (path.parent / 'receipt.json').write_bytes(old.canonical_json(receipt))
                producer_originals[run] = producer_original
                producer_selected[index] = {'origin': origin, 'attemptIndex': index, 'rawBodyFile': relative, 'bodySha256': old.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc']}
                verified = {'run': run, 'initialized': run + ':00Z', 'grid': tuple(producer_original['grid'][name] for name in ('latitude', 'longitude')), 'precipitation': producer_original['rain']}
                verified_originals.append(verified)
                parsed = verify.previous.original.audit_response(body, verified) if index == 0 else verify.previous.audit_response_35(body, verified) if index in (1, 2) else None
                verified_selected[index] = {'origin': origin, 'attemptIndex': index, 'rawBodyFile': relative, 'responseSha256': old.sha256(body), 'responseReceivedAtUtc': receipt['responseReceivedAtUtc'], 'direction': parsed['direction'] if parsed else None, 'grid': parsed['grid'] if parsed else verified['grid'], 'directionLeadCount': 48 if index == 0 else 34 if index < 3 else 0}
            report = producer.normalize_all(root, {'runs': runs}, producer_originals, producer_selected)
            replay = verify.audit_outputs(root, verified_originals, verified_selected, report)
            self.assertEqual(replay['normalizedRows'], 192)
            self.assertEqual(replay['responseLineageRows'], 4)
            self.assertEqual(replay['directionStatusRows']['transportUnresolved'], 48)
            self.assertEqual(replay['directionStatusRows']['notRequested'], 28)
            # altered status bytes cannot pass because source causes differ
            rows = (root / verify.NORMALIZED_PATH).read_bytes()
            (root / verify.NORMALIZED_PATH).write_bytes(rows.replace(b'"notRequested"', b'"providerNull"', 1))
            with self.assertRaises(ValueError):
                verify.audit_outputs(root, verified_originals, verified_selected, report)


# reject report-only promotion of previously nonconformant source evidence
class ContinuationReportTests(unittest.TestCase):
    # one synthetic report must preserve the old failure and current source cap
    def test_report_reconstruction_rejects_parent_status_and_count_tamper(self):
        import json
        import tempfile
        from contextlib import ExitStack
        from pathlib import Path

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'requests/0000').mkdir(parents=True)
            (root / 'requests/0000/request.json').write_text(json.dumps({'runIndex': 0, 'attemptInRun': 1}))
            (root / 'normalized').mkdir()
            (root / verify.NORMALIZED_PATH).write_bytes(b'normalized\n')
            (root / verify.LINEAGE_PATH).write_bytes(b'lineage\n')
            (root / 'frozen-plan.json').write_bytes(b'{}\n')
            (root / 'wind-continuation-freeze.json').write_bytes(b'{}\n')
            item = {**record(0, 0, 1, '2026-09-13T08:00:00Z', '2026-09-13T08:00:01Z'), 'run': '2024-05-07T00:00', 'status': 200, 'errorType': None, 'responseReceivedAtUtc': '2026-09-13T08:00:00Z', 'rawBodyFile': 'requests/0000/response-body.bin'}
            month = {'2024-05': {'totalRuns': 1, 'unresolvedRuns': 0, 'qualified': True}}
            report = {
                'contractVersion': 'rain-wind-continuation/v1', 'status': 'complete', 'sourceQualified': True,
                'planSha256': 'p', 'freezeSha256': 'f', 'interruptedProofSha256': verify.PARENT_PROOF_SHA,
                'interruptedRetentionManifestSha256': verify.PARENT_MANIFEST_SHA,
                'interruptedRetentionReceiptSha256': verify.PARENT_RECEIPT_SHA,
                'parentHttpAttempts': 0, 'parentSourceQualified': False,
                'parentTransportPolicyConformant': False, 'inheritedSpacingViolationCount': 25,
                'newHttpAttempts': 1, 'totalHttpAttempts': 1, 'attemptedLocationRequests': 1,
                'maximumNewHttpRequests': verify.NEW_HTTP_CAP, 'uniqueRepresentedRuns': 1,
                'uniqueSuccessfulRuns': 1, 'reusedSuccessfulRuns': 0, 'reusedFullResponses': 0,
                'reusedShortResponses': 0, 'newSuccessfulRuns': 1, 'newUnresolvedRuns': 0,
                'retryableFailuresBeforeSuccessOrStop': 0, 'plannedMissingRuns': 1,
                'runOutcomes': [{'requestIndex': 0, 'runIndex': 0, 'run': item['run'], 'attemptInRun': 1, 'result': 'success', 'status': 200, 'errorType': None, 'responseSha256': 'a' * 64}],
                'perMonthCoverage': month, 'failure': None, 'actualIssueAt': None,
                'labelsRead': False, 'modelGatesEvaluated': False, 'productionWrites': False,
                'normalizedFile': verify.NORMALIZED_PATH, 'normalizedRows': 48,
                'normalizedSha256': verify.previous.file_sha256(root / verify.NORMALIZED_PATH),
                'responseLineageFile': verify.LINEAGE_PATH, 'responseLineageRows': 1,
                'responseLineageSha256': verify.previous.file_sha256(root / verify.LINEAGE_PATH),
            }
            parent = {'parentLastFinishedAtUtc': '2026-09-13T07:00:00Z'}
            output = {'normalizedSha256': report['normalizedSha256'], 'normalizedRows': 48, 'responseLineageSha256': report['responseLineageSha256'], 'responseLineageRows': 1, 'directionStatusRows': {'available': 48}}
            mocks = (patch.object(verify, 'audit_interrupted_parent', return_value=([{}], [], {}, parent)), patch.object(verify, 'audit_freeze', return_value=({'missingRunIndices': [0]}, {'planSha256': 'p', 'freezeSha256': 'f'})), patch.object(verify.previous, 'audit_attempt', return_value=item), patch.object(verify, 'validate_new_sequence', return_value=({0: item}, {})), patch.object(verify.previous, 'coverage', return_value=(True, {'2024-05': 1}, {'2024-05': 0})), patch.object(verify, 'selected_sources', return_value={0: {}}), patch.object(verify, 'audit_outputs', return_value=output), patch.object(verify.previous.original, 'RUNS', 1), patch.object(verify.previous.original, 'SOURCE_ROWS', 48), patch.object(verify, 'PARENT_ATTEMPTS', 0), patch.object(verify, 'PARENT_REPRESENTED', 0), patch.object(verify, 'PARENT_REUSED_SUCCESSES', 0), patch.object(verify, 'PARENT_NEW_SUCCESSES', 0), patch.object(verify, 'MISSING_COUNT', 1))
            # mocked older audits isolate the final strict report comparator
            with ExitStack() as stack:
                # isolate inherited source auditing without weakening report checks
                for context in mocks:
                    stack.enter_context(context)
                (root / 'report.json').write_text(json.dumps(report))
                self.assertEqual(verify.audit_root(root)['verdict'], 'PASS')
                # inherited policy failure cannot be erased in a terminal report
                for key, value in (('parentTransportPolicyConformant', True), ('parentSourceQualified', True), ('inheritedSpacingViolationCount', 0), ('newHttpAttempts', 0), ('modelGatesEvaluated', True)):
                    changed = {**report, key: value}
                    (root / 'report.json').write_text(json.dumps(changed))
                    with self.subTest(key=key), self.assertRaises(ValueError):
                        verify.audit_root(root)


# run synthetic tests without public API access
if __name__ == '__main__':
    unittest.main()
