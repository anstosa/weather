"""verify a two-request public geometry probe without network access."""

import copy
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib import error, parse

import probe_rain_spatial as probe


# build only the exact preregistered public no-label plan
def plan():
    return {'contractVersion': probe.CONTRACT, 'locations': copy.deepcopy(list(probe.LOCATIONS)), 'runs': list(probe.RUNS), 'expiresAtUtc': probe.EXPIRY, 'maximumHttpRequests': 2, 'maximumLocationRequests': 6, 'retries': 0, 'minimumIntervalSeconds': 2, 'timeoutSeconds': 30, 'maximumResponseBytes': 2_000_000}


# synthesize three explicitly ordered complete source profiles
def response(run, missing=False):
    origin = dt.datetime.strptime(run, '%Y-%m-%dT%H:%M').replace(tzinfo=dt.timezone.utc)
    times = [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(49)]
    locations = []
    # retain distinct grids and a source null without making it dry
    for index, site in enumerate(probe.LOCATIONS):
        rain = [None if missing and lead == 1 else float(index + lead / 10) for lead in range(49)]
        locations.append({'location_id': index, 'latitude': site['latitude'] + .001, 'longitude': site['longitude'] + .001, 'elevation': 20. + index, 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': probe.UNITS, 'hourly': {'time': times, 'precipitation': rain, 'wind_direction_10m': [float((index * 90 + lead) % 360) for lead in range(49)]}})
    # official json omits the default first location's zero id
    locations[0].pop('location_id')
    return probe.canonical_json(locations)


# isolate filesystem proofs and a deterministic pre-expiry wall clock
class SpatialProbeTests(unittest.TestCase):
    # give each test a private root without calling the public endpoint
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.counter = 0
        self.new_root()
        self.private = patch.object(probe, 'validate_private_root', side_effect=lambda supplied: self.root if Path(supplied) == self.root else (_ for _ in ()).throw(ValueError('not private')))
        self.clock = patch.object(probe, 'utc_now', return_value=dt.datetime(2026, 9, 12, 12, tzinfo=dt.timezone.utc))
        self.private.start()
        self.clock.start()

    # allocate another one-shot private root for independent failure cases
    def new_root(self):
        self.root = Path(self.temporary.name) / f'weather-moisture-research-spatial-test-{self.counter}'
        self.counter += 1
        self.root.mkdir(mode=0o700)
        self.plan_path = self.root / 'plan.json'
        self.plan_path.write_bytes(probe.canonical_json(plan()))

    # restore only this test's isolated fake private directory
    def tearDown(self):
        self.clock.stop()
        self.private.stop()
        self.temporary.cleanup()

    # malformed caps, locations, runs and expiry never reach preparation
    def test_plan_schema_scope_and_expiration(self):
        original = plan()
        self.assertEqual(probe.validate_plan(original), original)
        changes = (
            {'maximumHttpRequests': 3}, {'retries': 1}, {'timeoutSeconds': 31},
            {'runs': list(probe.RUNS[::-1])}, {'locations': list(probe.LOCATIONS[::-1])},
            {'expiresAtUtc': '2026-09-13T08:00:00Z'}, {'endpoint': probe.ENDPOINT},
        )
        # every scope expansion or altered preregistration fails closed
        for change in changes:
            with self.subTest(change=change), self.assertRaises(probe.ProbeError):
                probe.validate_plan({**original, **change})
        with self.assertRaises(probe.ProbeError):
            probe.validate_plan(original, now=dt.datetime(2026, 9, 13, 7, tzinfo=dt.timezone.utc))
        with self.assertRaises(probe.ProbeError):
            probe.strict_json(b'{"runs":[],"runs":[]}')

    # retained exact bytes and current producer code must match the freeze
    def test_prepare_hash_and_no_overwrite(self):
        frozen = probe.prepare(self.root, self.plan_path)
        self.assertEqual(frozen['planSha256'], probe.sha256(self.plan_path.read_bytes()))
        self.assertEqual(set(frozen['sourceSha256']), set(probe.SOURCE_FILES))
        self.assertEqual(probe.validate_freeze(self.root)[1], plan())
        with self.assertRaises(probe.ProbeError):
            probe.prepare(self.root, self.plan_path)
        snapshot = self.root / 'probe-sources' / 'probe_rain_spatial.py'
        snapshot.write_bytes(snapshot.read_bytes() + b'changed')
        with self.assertRaises(probe.ProbeError):
            probe.validate_freeze(self.root)

    # an expired frozen plan creates only a zero-attempt failure receipt
    def test_expiry_before_first_request_retains_failure_without_transport(self):
        probe.prepare(self.root, self.plan_path)
        expired = dt.datetime(2026, 9, 13, 7, tzinfo=dt.timezone.utc)
        with patch.object(probe, 'utc_now', return_value=expired), patch.object(probe, 'fetch') as fetch, self.assertRaises(probe.ProbeError):
            probe.run(self.root)
        fetch.assert_not_called()
        report = json.loads((self.root / 'report.json').read_text())
        receipt = json.loads((self.root / 'requests/run-00/receipt.json').read_text())
        self.assertEqual(report['attemptedHttpRequests'], 0)
        self.assertEqual(report['attemptedLocationRequests'], 0)
        self.assertIsNone(receipt['status'])
        self.assertFalse((self.root / 'requests/run-00/request.json').exists())

    # two complete responses preserve bounded receipts and distinct grids
    def test_successful_two_run_probe_with_nullable_source_coverage(self):
        probe.prepare(self.root, self.plan_path)
        bodies = [response(run, missing=True) for run in probe.RUNS]
        with patch.object(probe, 'fetch', side_effect=[(200, {'Content-Type': 'application/json', 'Set-Cookie': 'secret'}, body) for body in bodies]) as fetch, patch.object(probe.time, 'sleep') as sleep:
            report = probe.run(self.root)
        self.assertEqual(fetch.call_count, 2)
        sleep.assert_called_once()
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['attemptedHttpRequests'], 2)
        self.assertEqual(report['attemptedLocationRequests'], 6)
        self.assertEqual(report['successfulHttpRequests'], 2)
        self.assertTrue(all(item['uniqueReturnedGrids'] == 3 and item['uniqueJointProfiles'] == 3 for item in report['runSummaries']))
        self.assertEqual(report['runSummaries'][0]['nonnullPrecipitationRows'], 144)
        self.assertEqual(report['runSummaries'][0]['mappingBasis'], 'provider_location_id_with_implicit_default_zero')
        self.assertEqual(report['runSummaries'][0]['locations'][0]['locationIdSource'], 'implicit_default_zero')
        receipt = json.loads((self.root / 'requests/run-00/receipt.json').read_text())
        self.assertEqual(receipt['status'], 200)
        self.assertEqual(receipt['contentSha256'], probe.sha256(bodies[0]))
        self.assertEqual(receipt['rawBodyFile'], 'response-body.bin')
        self.assertEqual(receipt['safeHeaders'], {'content-type': 'application/json'})
        requested = parse.parse_qs(parse.urlparse(fetch.call_args_list[0].args[0]).query)
        self.assertEqual(requested['run'], [probe.RUNS[0]])
        self.assertEqual(requested['hourly'], ['precipitation,wind_direction_10m'])
        self.assertEqual(requested['forecast_hours'], ['49'])
        self.assertEqual(len(requested['latitude'][0].split(',')), 3)
        with self.assertRaises(probe.ProbeError):
            probe.run(self.root)

    # a non-200 body is retained and the second request never starts
    def test_http_failure_stops_after_one_bounded_receipt(self):
        probe.prepare(self.root, self.plan_path)
        body = b'{"reason":"rate limited"}'
        with patch.object(probe, 'fetch', return_value=(429, {'Content-Type': 'application/json'}, body)) as fetch, self.assertRaises(probe.ProbeError):
            probe.run(self.root)
        self.assertEqual(fetch.call_count, 1)
        self.assertFalse((self.root / 'requests/run-01').exists())
        report = json.loads((self.root / 'report.json').read_text())
        self.assertEqual(report['attemptedHttpRequests'], 1)
        self.assertEqual(report['attemptedLocationRequests'], 3)
        self.assertEqual(report['successfulHttpRequests'], 0)
        receipt = json.loads((self.root / 'requests/run-00/receipt.json').read_text())
        self.assertEqual(receipt['status'], 429)
        self.assertEqual(receipt['contentSha256'], probe.sha256(body))
        self.assertEqual((self.root / 'requests/run-00/response-body.bin').read_bytes(), body)

    # timeout and redirect failures still count their persisted starts
    def test_transport_failures_count_one_attempt_and_block_redirect(self):
        with self.assertRaises(probe.ProbeError):
            probe.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://elsewhere.invalid')
        # run each transport failure in its own unattempted private root
        for failure in (error.URLError('timed out'), probe.ProbeError('redirect refused')):
            with self.subTest(failure=str(failure)):
                probe.prepare(self.root, self.plan_path)
                with patch.object(probe, 'fetch', side_effect=failure) as fetch, self.assertRaises(probe.ProbeError):
                    probe.run(self.root)
                self.assertEqual(fetch.call_count, 1)
                report = json.loads((self.root / 'report.json').read_text())
                receipt = json.loads((self.root / 'requests/run-00/receipt.json').read_text())
                self.assertEqual(report['attemptedHttpRequests'], 1)
                self.assertEqual(report['attemptedLocationRequests'], 3)
                self.assertIsNotNone(receipt['startedAtUtc'])
                self.assertTrue((self.root / 'requests/run-00/request.json').exists())
                self.assertFalse((self.root / 'requests/run-01').exists())
                # each subtest needs a fresh one-shot root
                self.new_root()

    # even empty or oversized bodies retain explicit bounded artifacts
    def test_empty_and_oversized_response_receipts(self):
        for body in (b'', b'x' * (2_000_001)):
            with self.subTest(length=len(body)):
                probe.prepare(self.root, self.plan_path)
                with patch.object(probe, 'fetch', return_value=(200, {}, body)) as fetch, self.assertRaises(probe.ProbeError):
                    probe.run(self.root)
                self.assertEqual(fetch.call_count, 1)
                receipt = json.loads((self.root / 'requests/run-00/receipt.json').read_text())
                saved = (self.root / 'requests/run-00/response-body.bin').read_bytes()
                self.assertEqual(len(saved), min(len(body), 2_000_000))
                self.assertEqual(receipt['responseBytesObserved'], len(body))
                self.assertEqual(receipt['responseBytesStored'], len(saved))
                self.assertEqual(receipt['capturedSha256'], probe.sha256(saved))
                self.assertEqual(receipt['bodyComplete'], len(body) <= 2_000_000)
                self.assertEqual(json.loads((self.root / 'report.json').read_text())['attemptedHttpRequests'], 1)
                self.new_root()

    # missing station identity, shifted hours, units and bad cells abort parsing
    def test_response_identity_and_measurement_guard(self):
        original = json.loads(response(probe.RUNS[0], missing=True))
        summary = probe.validate_response(probe.canonical_json(original), probe.RUNS[0], list(probe.LOCATIONS))
        self.assertEqual(summary['locations'][0]['nullPrecipitationRows'], 1)
        reordered = [original[2], original[0], original[1]]
        remapped = probe.validate_response(probe.canonical_json(reordered), probe.RUNS[0], list(probe.LOCATIONS))
        self.assertEqual([item['responseIndex'] for item in remapped['locations']], [1, 2, 0])
        self.assertEqual([item['id'] for item in remapped['locations']], [site['id'] for site in probe.LOCATIONS])
        explicit_zero = copy.deepcopy(original)
        explicit_zero[0]['location_id'] = 0
        self.assertEqual(probe.validate_response(probe.canonical_json(explicit_zero), probe.RUNS[0], list(probe.LOCATIONS))['locations'][0]['locationIdSource'], 'explicit')
        changes = (
            lambda value: value.pop(),
            lambda value: value[1].pop('location_id'),
            lambda value: value[1].update(location_id=0),
            lambda value: value[1].update(location_id=None),
            lambda value: value[1].update(location_id=True),
            lambda value: value[0]['hourly']['time'].__setitem__(1, '2026-05-12T02:00'),
            lambda value: value[0]['hourly_units'].update(wind_direction_10m='rad'),
            lambda value: value[0]['hourly']['precipitation'].__setitem__(1, -1),
            lambda value: value[0]['hourly']['wind_direction_10m'].__setitem__(1, 361),
        )
        # reject each partial or mislabeled source rather than infer missing data
        for mutation in changes:
            changed = copy.deepcopy(original)
            mutation(changed)
            with self.subTest(mutation=mutation), self.assertRaises(probe.ProbeError):
                probe.validate_response(probe.canonical_json(changed), probe.RUNS[0], list(probe.LOCATIONS))


# run only mocked public transport fixtures
if __name__ == '__main__':
    unittest.main()
