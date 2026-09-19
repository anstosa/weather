"""lock independent wind-source identity, retry and missingness checks."""

import copy
import datetime as dt
import json
import unittest

import verify_rain_wind_source as verify


# create an observation-free original forecast identity
def original():
    return {
        'run': '2024-05-07T00:00',
        'initialized': '2024-05-07T00:00:00Z',
        'grid': (47.97891, -122.44185),
        'precipitation': tuple(None if lead == 8 else lead / 10 for lead in range(1, 49)),
    }


# build one thirty-five-hour public source body from old rain only
def response(identity):
    start = verify.utc_time(identity['initialized'])
    return {
        'latitude': identity['grid'][0],
        'longitude': identity['grid'][1],
        'elevation': 28.,
        'timezone': 'GMT',
        'utc_offset_seconds': 0,
        'hourly_units': verify.original.UNITS,
        'hourly': {
            'time': [(start + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(35)],
            'precipitation': [None, *identity['precipitation'][:34]],
            'wind_direction_10m': [float(lead) for lead in range(35)],
        },
    }


# encode synthetic source bytes without calling the producer
def body(value):
    return json.dumps(value, sort_keys=True, allow_nan=False).encode()


# test forecast-only source reconstruction and strict loss of information
class RainWindSourceVerifierTests(unittest.TestCase):
    # only the pinned horizon changes from the original URL query
    def test_query_changes_only_horizon(self):
        params = verify.expected_params(original()['run'])
        baseline = verify.original.expected_params(original()['run'])
        self.assertEqual([item for item in params if item[0] != 'forecast_hours'], [item for item in baseline if item[0] != 'forecast_hours'])
        self.assertEqual([item for item in params if item[0] == 'forecast_hours'], [['forecast_hours', '35']])

    # valid thirty-five-hour response has exact rain and selected direction
    def test_short_response_and_summary(self):
        identity = original()
        parsed = verify.audit_response_35(body(response(identity)), identity)
        self.assertEqual(parsed['directionFootprintNonNullHours'], 29)
        self.assertEqual(parsed['precipitation'][8], None)
        self.assertTrue(parsed['directionFootprintComplete'])
        summary = verify.response_summary(identity, parsed)
        self.assertEqual(summary['forecastHours'], 35)
        self.assertEqual(summary['directionNullSelectedLeads'], 0)

    # grid, valid hour, units, rain, range and horizon drift are fatal
    def test_response_tamper_regressions(self):
        identity = original()
        mutations = (
            lambda value: value.update(location_id=1),
            lambda value: value.update(latitude=47.5),
            lambda value: value['hourly_units'].update(precipitation='cm'),
            lambda value: value['hourly']['time'].__setitem__(8, '2024-05-07T09:00'),
            lambda value: value['hourly']['precipitation'].__setitem__(8, 0.),
            lambda value: value['hourly']['wind_direction_10m'].__setitem__(9, 361.),
            lambda value: value['hourly']['wind_direction_10m'].append(35.),
            lambda value: value['hourly']['time'].pop(),
        )
        # isolate each mutation against its own otherwise-valid body
        for mutation in mutations:
            changed = copy.deepcopy(response(identity))
            mutation(changed)
            # no altered source can pass rain provenance
            with self.subTest(mutation=mutation), self.assertRaises((ValueError, TypeError)):
                verify.audit_response_35(body(changed), identity)

    # provider nulls, unrequested tails and unresolved transport never coalesce
    def test_distinct_direction_missingness(self):
        identity = original()
        item = response(identity)
        item['hourly']['wind_direction_10m'][7] = None
        parsed = verify.audit_response_35(body(item), identity)
        short = verify.direction_rows('newAcquired', parsed['direction'])
        self.assertEqual(short[6], (None, 'providerNull'))
        self.assertEqual(short[33], (34., 'available'))
        self.assertEqual(short[34:], [(None, 'notRequested')] * 14)
        unresolved = verify.direction_rows('transportUnresolved', None)
        self.assertEqual(unresolved, [(None, 'transportUnresolved')] * 48)
        long = verify.direction_rows('parentInherited', tuple(range(49)))
        self.assertEqual(long[-1], (48, 'available'))

    # one-percent cap applies independently to every decision month
    def test_monthly_and_global_unresolved_gate(self):
        originals = [
            {'initialized': (dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=index)).strftime('%Y-%m-%dT%H:%M:%SZ')}
            for index in range(100)
        ]
        eligible, _, _ = verify.coverage(originals, {0})
        self.assertFalse(eligible)
        eligible, _, _ = verify.coverage(originals, set())
        self.assertTrue(eligible)
        same_month = [{'initialized': '2024-01-01T00:00:00Z'} for _ in range(100)]
        eligible, _, _ = verify.coverage(same_month, {0})
        self.assertTrue(eligible)
        eligible, _, _ = verify.coverage(same_month, {0, 1})
        self.assertFalse(eligible)


# retain one synthetic request and byte-bound attempt receipt
def attempt(root, index, identity, ordinal, started, status, raw, result, error_type=None, error=None):
    from pathlib import Path
    from urllib.parse import urlencode
    directory = Path(root) / f'requests/{index:04d}'
    directory.mkdir(parents=True)
    params = verify.expected_params(identity['run'])
    request = {
        'contractVersion': 'rain-wind-source/v1',
        'requestIndex': index,
        'runIndex': 0,
        'run': identity['run'],
        'attemptInRun': ordinal,
        'endpoint': verify.original.ENDPOINT,
        'canonicalParams': params,
        'paramsSha256': verify.original.sha256(verify.original.canonical_json(params)),
        'urlSha256': verify.original.sha256((verify.original.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])).encode()),
        'startedAtUtc': started,
        'actualIssueAt': None,
    }
    finished = (verify.utc_time(started) + dt.timedelta(seconds=1)).isoformat().replace('+00:00', 'Z')
    parsed = verify.audit_response_35(raw, identity) if result == 'success' else None
    retry = error_type in ('TimeoutError', 'URLError', 'IncompleteRead', 'RemoteDisconnected', 'RetryableHttpStatus', 'KnownStreamingTimeout')
    receipt = {
        **request,
        'responseReceivedAtUtc': finished if status is not None else None,
        'finishedAtUtc': finished,
        'status': status,
        'safeHeaders': {'content-type': 'application/json'} if status is not None else {},
        'responseBytesObserved': len(raw) if raw is not None else 0,
        'responseBytesStored': len(raw) if raw is not None else 0,
        'bodyComplete': status is not None if raw is not None else None,
        'contentSha256': verify.original.sha256(raw) if raw is not None and status is not None else None,
        'capturedSha256': verify.original.sha256(raw) if raw is not None else None,
        'rawBodyFile': 'response-body.bin' if raw is not None else None,
        'result': result,
        'errorType': error_type,
        'error': error,
        'summary': verify.response_summary(identity, parsed) if parsed is not None else None,
        'retryable': retry,
        'retryScheduled': result == 'retryableFailure',
        'backoffSeconds': 15 if result == 'retryableFailure' else 0,
    }
    (directory / 'request.json').write_bytes(verify.original.canonical_json(request))
    (directory / 'receipt.json').write_bytes(verify.original.canonical_json(receipt))
    # even a zero-byte HTTP body remains an explicit response artifact
    if raw is not None:
        (directory / 'response-body.bin').write_bytes(raw)
    return directory


# test attempt classification from retained bytes rather than report booleans
class RainWindSourceAttemptTests(unittest.TestCase):
    # each synthetic source attempt owns a disposable local directory
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.identity = original()

    # valid HTTP response and raw hash select exactly the original run
    def test_one_complete_short_response(self):
        raw = body(response(self.identity))
        directory = attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', 200, raw, 'success')
        checked = verify.audit_attempt(self.root, 0, 0, 1, self.identity)
        self.assertEqual(checked['responseSha256'], verify.original.sha256(raw))
        self.assertEqual(verify.validate_sequence([checked], [0])[0][0]['result'], 'success')
        (directory / 'response-body.bin').write_bytes(raw + b' ')
        # receipt SHA binds the exact retained HTTP body bytes
        with self.assertRaises(ValueError):
            verify.audit_attempt(self.root, 0, 0, 1, self.identity)

    # exact known timeout requires a retry and only second may become unknown
    def test_two_exact_timeout_bodies_become_transport_unresolved(self):
        attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', 200, verify.KNOWN_TIMEOUT, 'retryableFailure', 'KnownStreamingTimeout', 'known streaming timeout')
        attempt(self.root, 1, self.identity, 2, '2026-09-13T07:00:16Z', 200, verify.KNOWN_TIMEOUT, 'transportUnresolved', 'KnownStreamingTimeout', 'known streaming timeout')
        records = [verify.audit_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        selected, unresolved = verify.validate_sequence(records, [0])
        self.assertEqual(selected, {})
        self.assertEqual(set(unresolved), {0})
        self.assertEqual(verify.direction_rows('transportUnresolved', None), [(None, 'transportUnresolved')] * 48)

    # gateway retry may recover but a second gateway cannot count as unknown
    def test_gateway_then_success_or_fatal_second(self):
        attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', 503, b'', 'retryableFailure', 'RetryableHttpStatus', 'HTTP 503')
        raw = body(response(self.identity))
        directory = attempt(self.root, 1, self.identity, 2, '2026-09-13T07:00:16Z', 200, raw, 'success')
        records = [verify.audit_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        self.assertEqual(set(verify.validate_sequence(records, [0])[0]), {0})
        receipt = json.loads((directory / 'receipt.json').read_text())
        receipt.update(result='transportUnresolved', errorType='KnownStreamingTimeout', error='known streaming timeout', retryable=True)
        (directory / 'receipt.json').write_bytes(verify.original.canonical_json(receipt))
        # a valid HTTP body cannot be reclassified as transport-unknown
        with self.assertRaises(ValueError):
            verify.audit_attempt(self.root, 1, 0, 2, self.identity)

    # 429 and a second transport failure never authorize further source runs
    def test_terminal_failures_do_not_advance(self):
        directory = attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', 429, b'rate limit', 'failed', 'FatalHttpStatus', 'HTTP 429')
        checked = verify.audit_attempt(self.root, 0, 0, 1, self.identity)
        # a rate limit cannot authorize the next original run
        with self.assertRaises(ValueError):
            verify.validate_sequence([checked], [0])
        import shutil
        # clear the prior terminal fixture before testing a distinct transport path
        shutil.rmtree(directory)
        attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', None, None, 'retryableFailure', 'TimeoutError', 'timed out')
        attempt(self.root, 1, self.identity, 2, '2026-09-13T07:00:16Z', None, None, 'failed', 'TimeoutError', 'timed out')
        records = [verify.audit_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        # a second transport error remains terminal
        with self.assertRaises(ValueError):
            verify.validate_sequence(records, [0])

    # no retry may start before the fixed backoff expires
    def test_retry_backoff_regression(self):
        attempt(self.root, 0, self.identity, 1, '2026-09-13T07:00:00Z', 200, verify.KNOWN_TIMEOUT, 'retryableFailure', 'KnownStreamingTimeout', 'known streaming timeout')
        attempt(self.root, 1, self.identity, 2, '2026-09-13T07:00:14Z', 200, verify.KNOWN_TIMEOUT, 'transportUnresolved', 'KnownStreamingTimeout', 'known streaming timeout')
        records = [verify.audit_attempt(self.root, index, 0, index + 1, self.identity) for index in range(2)]
        with self.assertRaises(ValueError):
            verify.validate_sequence(records, [0])


# test the independent forty-eight-row output reconstruction
class RainWindSourceOutputTests(unittest.TestCase):
    # build only synthetic old rain and a single selected short response
    def setUp(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.identity = original()
        self.parsed = verify.audit_response_35(body(response(self.identity)), self.identity)
        self.selected = {0: {
            'origin': 'newAcquired',
            'attemptIndex': 3,
            'rawBodyFile': 'requests/0003/response-body.bin',
            'responseSha256': 'a' * 64,
            'responseReceivedAtUtc': '2026-09-13T07:00:01Z',
            'grid': self.parsed['grid'],
            'direction': self.parsed['direction'],
            'directionLeadCount': 34,
        }}
        self.patches = (patch.object(verify.original, 'RUNS', 1), patch.object(verify.original, 'SOURCE_ROWS', 48))
        # isolate fixed corpus counts while keeping the real output algorithm
        for setting in self.patches:
            setting.start()
            self.addCleanup(setting.stop)
        (self.root / 'normalized').mkdir()

    # write expected canonical output without a producer calculation call
    def write_output(self):
        source = self.selected[0]
        lineage = {
            'originalRunIndex': 0,
            'run': self.identity['run'],
            'origin': source['origin'],
            'sourceAttemptIndex': source['attemptIndex'],
            'rawBodyFile': source['rawBodyFile'],
            'responseSha256': source['responseSha256'],
            'responseReceivedAtUtc': source['responseReceivedAtUtc'],
            'directionLeadCount': source['directionLeadCount'],
        }
        (self.root / verify.LINEAGE_PATH).write_bytes(verify.original.canonical_json(lineage))
        lines = []
        start = verify.utc_time(self.identity['initialized'])
        # bind old rain on all leads while new direction stops at lead thirty-four
        for lead, (value, status) in enumerate(verify.direction_rows(source['origin'], source['direction']), 1):
            lines.append(verify.original.canonical_json({
                'cohort': verify.original.COHORT,
                'key': f'{verify.original.COHORT}|{self.identity["run"]}|lead={lead}',
                'runInitializedAt': self.identity['initialized'],
                'validAt': (start + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'targetLeadHours': lead,
                'rawPrecipitationMm': self.identity['precipitation'][lead - 1],
                'rawWindDirectionDegrees': value,
                'directionSourceStatus': status,
                'returnedGrid': {'latitude': source['grid'][0], 'longitude': source['grid'][1]},
                'responseSha256': source['responseSha256'],
                'responseReceivedAtUtc': source['responseReceivedAtUtc'],
                'actualIssueAt': None,
            }))
        normalized = self.root / verify.NORMALIZED_PATH
        normalized.write_bytes(b''.join(lines))
        return {
            'normalizedFile': verify.NORMALIZED_PATH,
            'normalizedRows': 48,
            'normalizedSha256': verify.file_sha256(normalized),
            'responseLineageFile': verify.LINEAGE_PATH,
            'responseLineageRows': 1,
            'responseLineageSha256': verify.file_sha256(self.root / verify.LINEAGE_PATH),
        }

    # exact normalization preserves old rain and labels each unknown cause
    def test_short_output_and_status_counts(self):
        report = self.write_output()
        result = verify.audit_outputs(self.root, [self.identity], self.selected, report)
        self.assertEqual(result['directionStatusRows'], {'available': 34, 'providerNull': 0, 'notRequested': 14, 'transportUnresolved': 0})

    # tail substitution, old rain edit and lineage substitution all fail closed
    def test_output_tamper_regressions(self):
        report = self.write_output()
        path = self.root / verify.NORMALIZED_PATH
        original_bytes = path.read_bytes()
        row = json.loads(original_bytes.splitlines()[34])
        row['directionSourceStatus'] = 'providerNull'
        changed = original_bytes.splitlines(keepends=True)
        changed[34] = verify.original.canonical_json(row)
        path.write_bytes(b''.join(changed))
        # a false provider-null tail cannot match unrequested provenance
        with self.assertRaises(ValueError):
            verify.audit_outputs(self.root, [self.identity], self.selected, report)
        path.write_bytes(original_bytes)
        line = self.root / verify.LINEAGE_PATH
        line.write_bytes(line.read_bytes().replace(b'newAcquired', b'parentInherited'))
        # changing origin without raw-body lineage fails independently
        with self.assertRaises(ValueError):
            verify.audit_outputs(self.root, [self.identity], self.selected, report)


# verify producer-retained synthetic receipts using the independent parser
class RainWindProducerReceiptCompatibilityTests(unittest.TestCase):
    # keep the acquisition transport entirely mocked and local
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'requests').mkdir()
        self.identity = original()
        self.producer_original = {
            'grid': {'latitude': self.identity['grid'][0], 'longitude': self.identity['grid'][1]},
            'rain': self.identity['precipitation'],
        }

    # execute one producer attempt without a network transport
    def acquire(self, index, ordinal, started, status, raw):
        from unittest.mock import patch

        import acquire_rain_wind_source as producer
        received = (verify.utc_time(started) + dt.timedelta(seconds=1)).isoformat().replace('+00:00', 'Z')
        finished = (verify.utc_time(started) + dt.timedelta(seconds=2)).isoformat().replace('+00:00', 'Z')
        # only mocked public transport and clock supply producer input
        with patch.object(producer.old, 'fetch', return_value=(status, {'content-type': 'application/json'}, raw)), patch.object(producer.old, 'utc_stamp', side_effect=(started, received, finished)):
            receipt = producer.attempt_once(self.root, {'timeoutSeconds': 90, 'maximumResponseBytes': 2_000_000}, index, 0, self.identity['run'], self.producer_original, ordinal)
        return receipt, verify.audit_attempt(self.root, index, 0, ordinal, self.identity)

    # a producer-generated 35h raw receipt must independently match old rain
    def test_producer_normal_response_replayed(self):
        receipt, checked = self.acquire(0, 1, '2026-09-13T07:00:00Z', 200, body(response(self.identity)))
        self.assertEqual(receipt['result'], checked['result'])
        self.assertEqual(checked['result'], 'success')
        self.assertEqual(checked['parsed']['directionFootprintNonNullHours'], 29)

    # one gateway transient then 35h response keeps fixed fifteen-second retry
    def test_producer_retry_then_success_replayed(self):
        first, first_checked = self.acquire(0, 1, '2026-09-13T07:00:00Z', 503, b'')
        second, second_checked = self.acquire(1, 2, '2026-09-13T07:00:18Z', 200, body(response(self.identity)))
        self.assertEqual(first['result'], 'retryableFailure')
        self.assertEqual(second['result'], 'success')
        selected, unresolved = verify.validate_sequence([first_checked, second_checked], [0])
        self.assertEqual(set(selected), {0})
        self.assertEqual(unresolved, {})

    # only the second exact retained timeout becomes explicit unknown source
    def test_producer_twice_known_timeout_replayed(self):
        first, first_checked = self.acquire(0, 1, '2026-09-13T07:00:00Z', 200, verify.KNOWN_TIMEOUT)
        second, second_checked = self.acquire(1, 2, '2026-09-13T07:00:18Z', 200, verify.KNOWN_TIMEOUT)
        self.assertEqual(first['result'], 'retryableFailure')
        self.assertEqual(second['result'], 'transportUnresolved')
        selected, unresolved = verify.validate_sequence([first_checked, second_checked], [0])
        self.assertEqual(selected, {})
        self.assertEqual(set(unresolved), {0})


# test the complete producer-normalized source against independent reconstruction
class RainWindNormalizationCompatibilityTests(unittest.TestCase):
    # create three original runs without any observation or model outcome
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.identities = []
        start = verify.utc_time(original()['initialized'])
        # preserve three distinct original forecast cycles
        for index in range(3):
            identity = copy.deepcopy(original())
            instant = start + dt.timedelta(hours=6 * index)
            identity['run'] = instant.strftime('%Y-%m-%dT%H:%M')
            identity['initialized'] = instant.strftime('%Y-%m-%dT%H:%M:%SZ')
            self.identities.append(identity)

    # retain a selected body with the minimal source receipt used by normalization
    def retain(self, index, raw, summary, result):
        directory = self.root / f'requests/{index:04d}'
        directory.mkdir(parents=True)
        (directory / 'response-body.bin').write_bytes(raw)
        receipt = {
            'result': result,
            'status': 200,
            'contentSha256': verify.original.sha256(raw),
            'responseReceivedAtUtc': '2026-09-13T07:00:01Z',
            'summary': summary,
        }
        (directory / 'receipt.json').write_bytes(verify.original.canonical_json(receipt))
        return {
            'origin': 'transportUnresolved' if result == 'transportUnresolved' else 'newAcquired',
            'attemptIndex': index,
            'rawBodyFile': f'requests/{index:04d}/response-body.bin',
            'bodySha256': verify.original.sha256(raw),
            'responseReceivedAtUtc': '2026-09-13T07:00:01Z',
        }

    # full inherited, short new and exact timeout each retain different provenance
    def test_three_source_patterns_replayed(self):
        from unittest.mock import patch

        import acquire_rain_wind_source as producer
        old_identity, short_identity, unknown_identity = self.identities
        old_response = response(old_identity)
        origin = verify.utc_time(old_identity['initialized'])
        # the inherited old request includes every positive lead through forty-eight
        for lead in range(35, 49):
            old_response['hourly']['time'].append((origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M'))
            old_response['hourly']['precipitation'].append(old_identity['precipitation'][lead - 1])
            old_response['hourly']['wind_direction_10m'].append(float(lead))
        old_raw = body(old_response)
        originals = {identity['run']: {'grid': {'latitude': identity['grid'][0], 'longitude': identity['grid'][1]}, 'rain': identity['precipitation']} for identity in self.identities}
        old_summary, _, _ = producer.old.validate_response(old_raw, old_identity['run'], originals[old_identity['run']])
        old_source = self.retain(0, old_raw, old_summary, 'success')
        old_source['origin'] = 'parentInherited'
        short_response = response(short_identity)
        short_response['hourly']['wind_direction_10m'][7] = None
        short_raw = body(short_response)
        short_summary, _, _ = producer.validate_response(short_raw, short_identity['run'], originals[short_identity['run']])
        new_source = self.retain(1, short_raw, short_summary, 'success')
        unknown_source = self.retain(2, verify.KNOWN_TIMEOUT, None, 'transportUnresolved')
        selected = {0: old_source, 1: new_source, 2: unknown_source}
        # inspect producer output only through independently recomputed source rows
        with patch.object(producer.old, 'RUN_COUNT', 3), patch.object(producer.old, 'LEADS', 48), patch.object(verify.original, 'RUNS', 3), patch.object(verify.original, 'SOURCE_ROWS', 144):
            report = producer.normalize_all(self.root, {'runs': [identity['run'] for identity in self.identities]}, originals, selected)
            parsed_old = verify.original.audit_response(old_raw, old_identity)
            parsed_short = verify.audit_response_35(short_raw, short_identity)
            independently_selected = {
                0: {'origin': 'parentInherited', 'attemptIndex': 0, 'rawBodyFile': old_source['rawBodyFile'], 'responseSha256': old_source['bodySha256'], 'responseReceivedAtUtc': old_source['responseReceivedAtUtc'], 'grid': parsed_old['grid'], 'direction': parsed_old['direction'], 'directionLeadCount': 48},
                1: {'origin': 'newAcquired', 'attemptIndex': 1, 'rawBodyFile': new_source['rawBodyFile'], 'responseSha256': new_source['bodySha256'], 'responseReceivedAtUtc': new_source['responseReceivedAtUtc'], 'grid': parsed_short['grid'], 'direction': parsed_short['direction'], 'directionLeadCount': 34},
                2: {'origin': 'transportUnresolved', 'attemptIndex': 2, 'rawBodyFile': unknown_source['rawBodyFile'], 'responseSha256': unknown_source['bodySha256'], 'responseReceivedAtUtc': unknown_source['responseReceivedAtUtc'], 'grid': unknown_identity['grid'], 'direction': None, 'directionLeadCount': 0},
            }
            checked = verify.audit_outputs(self.root, self.identities, independently_selected, report)
        self.assertEqual(checked['directionStatusRows'], {'available': 81, 'providerNull': 1, 'notRequested': 14, 'transportUnresolved': 48})


# run the complete synthetic suite under a direct script invocation
if __name__ == '__main__':
    unittest.main()
