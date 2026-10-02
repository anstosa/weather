"""verify a frozen no-label direction supplement without public requests."""

import copy
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import acquire_rain_direction as acquire


# construct a seven-run archive with the real forty-eight-lead geometry
def fixture_runs():
    return [(dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=index)).strftime('%Y-%m-%dT%H:%M') for index in range(7)]


# keep all synthetic precipitation cells stable across old and new sources
def rainfall(index):
    return [None] + [round(index + lead / 100, 2) for lead in range(1, 49)]


# create one complete one-coordinate response for a known source run
def response(run, index, null_footprint=False):
    origin = dt.datetime.strptime(run + 'Z', '%Y-%m-%dT%H:%M%z')
    times = [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(49)]
    directions = [None] + [float((index * 30 + lead) % 360) for lead in range(1, 49)]
    # a missing feature-footprint cell never becomes a zero direction
    if null_footprint:
        directions[6] = None
    return acquire.canonical_json({'latitude': 47.9, 'longitude': -122.4, 'elevation': 20., 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': acquire.UNITS, 'hourly': {'time': times, 'precipitation': rainfall(index), 'wind_direction_10m': directions}})


# isolate every no-network acquisition in a disposable synthetic root
class DirectionAcquisitionTests(unittest.TestCase):
    # freeze a small original source without reading any observation labels
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.root = base / 'weather-moisture-research-direction-test'
        self.root.mkdir(mode=0o700)
        self.source = base / 'weather-moisture-research-original-test'
        normalized = self.source / 'acquisition/normalized'
        normalized.mkdir(parents=True)
        producers = self.source / 'forecast-acquisition-sources'
        producers.mkdir()
        self.runs = fixture_runs()
        self.grids = {run: {'latitude': 47.9, 'longitude': -122.4} for run in self.runs}
        rows = []
        identities = []
        # preserve the same keyed valid-hour identity as the original archive
        for index, run in enumerate(self.runs):
            origin = dt.datetime.strptime(run + 'Z', '%Y-%m-%dT%H:%M%z')
            identities.append({'cohort': 'ecmwf_single_run_hindcast', 'status': 'success', 'key': f'ecmwf_single_run_hindcast|{run}', 'runInitializedAt': run + ':00Z', 'returnedGrid': self.grids[run]})
            # each source run has forty-eight contiguous original leads
            for lead in range(1, 49):
                rows.append({'cohort': 'ecmwf_single_run_hindcast', 'key': f'ecmwf_single_run_hindcast|{run}|lead={lead}', 'runInitializedAt': run + ':00Z', 'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'), 'targetLeadHours': lead, 'rawPrecipitationMm': rainfall(index)[lead], 'actualIssueAt': None})
        normalized_body = b''.join(acquire.canonical_json(row) for row in rows)
        (normalized / 'ecmwf_single_run_hindcast.jsonl').write_bytes(normalized_body)
        producer_hashes = {}
        # bind the old three producer dependencies to synthetic immutable bytes
        for name in acquire.ORIGINAL_PRODUCERS:
            body = f'old {name}\n'.encode()
            (producers / name).write_bytes(body)
            producer_hashes[name] = acquire.sha256(body)
        manifest = {'requestCoordinates': acquire.SITE, 'cohortFiles': {'ecmwf_single_run_hindcast': {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'sha256': acquire.sha256(normalized_body), 'successfulRuns': 7, 'rows': 336, 'bytes': len(normalized_body)}}, 'statusCounts': {'success': 7}, 'sourceSha256': producer_hashes, 'identities': identities}
        manifest_body = acquire.canonical_json(manifest)
        (self.source / 'acquisition/manifest.json').write_bytes(manifest_body)
        self.patches = [patch.object(acquire, 'ORIGINAL_ROOT', self.source), patch.object(acquire, 'ORIGINAL_MANIFEST_SHA256', acquire.sha256(manifest_body)), patch.object(acquire, 'ORIGINAL_NORMALIZED_SHA256', acquire.sha256(normalized_body)), patch.object(acquire, 'RUN_COUNT', 7), patch.object(acquire, 'PILOT_POSITIONS', (0, 1, 2, 3, 4, 6)), patch.object(acquire, 'validate_private_root', side_effect=lambda path: Path(path).resolve()), patch.object(acquire, 'utc_now', return_value=dt.datetime(2026, 9, 13, 6, tzinfo=dt.timezone.utc))]
        # isolate only mutable constants and the wall clock under test
        for active in self.patches:
            active.start()
        self.plan = {'contractVersion': acquire.CONTRACT, 'endpoint': acquire.ENDPOINT, 'site': acquire.SITE, 'runs': self.runs, 'pilotRuns': [self.runs[index] for index in acquire.PILOT_POSITIONS], 'expiresAtUtc': acquire.EXPIRY, 'maximumHttpRequests': 7, 'maximumLocationRequests': 7, 'retries': 0, 'minimumIntervalSeconds': 1, 'timeoutSeconds': 30, 'maximumResponseBytes': 2_000_000, 'originalSourceSha256': acquire.ORIGINAL_NORMALIZED_SHA256, 'originalManifestSha256': acquire.ORIGINAL_MANIFEST_SHA256}
        self.plan_path = self.root / 'plan.json'
        self.plan_path.write_bytes(acquire.canonical_json(self.plan))

    # release only synthetic temporary source and patch state
    def tearDown(self):
        # reverse patch order to restore original dependencies safely
        for active in reversed(self.patches):
            active.stop()
        self.temporary.cleanup()

    # build a frozen source snapshot without any public request
    def prepare(self):
        return acquire.prepare(self.root, self.plan_path, self.source)

    # return a distinct valid raw body for each permitted request
    def fetched(self, url, timeout, maximum):
        from urllib import parse
        run = parse.parse_qs(parse.urlsplit(url).query)['run'][0]
        return 200, {'Content-Type': 'application/json'}, response(run, self.runs.index(run))

    # pin the source set and prevent plan/cap/hash changes or replay
    def test_prepare_and_plan_fail_closed(self):
        self.assertEqual(acquire.validate_plan(self.plan)['pilotRuns'][-1], self.runs[-1])
        # any quota or source identity change invalidates the plan
        for key, changed in (('minimumIntervalSeconds', 2), ('maximumHttpRequests', 8), ('originalSourceSha256', '0' * 64), ('pilotRuns', self.runs[:6])):
            bad = copy.deepcopy(self.plan)
            bad[key] = changed
            with self.assertRaises(acquire.AcquisitionError):
                acquire.validate_plan(bad)
        frozen = self.prepare()
        self.assertIn('verify_rain_direction_source.py', frozen['sourceSha256'])
        self.assertEqual(acquire.file_sha256(self.root / 'inputs/original-normalized.jsonl'), acquire.ORIGINAL_NORMALIZED_SHA256)
        with self.assertRaises(acquire.AcquisitionError):
            self.prepare()
        with patch.object(acquire, 'utc_now', return_value=dt.datetime(2026, 9, 14, 8, tzinfo=dt.timezone.utc)), self.assertRaises(acquire.AcquisitionError):
            acquire.validate_plan(self.plan)
        # a finished request may be hashed after expiry without a new start
        with patch.object(acquire, 'utc_now', return_value=dt.datetime(2026, 9, 14, 8, tzinfo=dt.timezone.utc)):
            with self.assertRaises(acquire.AcquisitionError):
                acquire.validate_freeze(self.root)
            self.assertEqual(acquire.validate_freeze(self.root, full_inputs=True, check_expiry=False)[1]['runs'], self.runs)

    # enforce every original lead, run-hour, grid and nullable direction field
    def test_response_identity_and_nulls(self):
        run = self.runs[0]
        original = {'grid': self.grids[run], 'rain': tuple(rainfall(0)[1:])}
        summary, rain, direction = acquire.validate_response(response(run, 0, True), run, original)
        self.assertEqual(summary['directionFootprintNonNullHours'], 28)
        self.assertIsNone(direction[6])
        self.assertEqual(rain[1:], original['rain'])
        bad = json.loads(response(run, 0))
        # rain parity includes all forty-eight source leads
        for path, value in ((('hourly', 'precipitation', 48), 999.), (('hourly', 'time', 1), '2024-01-01T03:00'), (('latitude',), 48.1), (('location_id',), 1)):
            changed = copy.deepcopy(bad)
            if len(path) == 3:
                changed[path[0]][path[1]][path[2]] = value
            else:
                changed[path[0]] = value
            with self.assertRaises(acquire.AcquisitionError):
                acquire.validate_response(acquire.canonical_json(changed), run, original)

    # a missing direction in the pilot footprint permits identity but bars bulk
    def test_pilot_coverage_and_failure_retention(self):
        self.prepare()
        with patch.object(acquire, 'fetch', side_effect=lambda url, timeout, maximum: (200, {}, response(parse_run(url), self.runs.index(parse_run(url)), True))), patch.object(acquire.time, 'sleep'):
            report = acquire.run_phase(self.root, 'pilot')
        self.assertEqual(report['attemptedHttpRequests'], 6)
        self.assertFalse(report['bulkEligible'])
        self.assertEqual(len(list((self.root / 'requests').iterdir())), 6)
        with self.assertRaises(acquire.AcquisitionError):
            acquire.run_phase(self.root, 'pilot')

    # transport failure counts one start and never advances to a second run
    def test_transport_and_empty_body_are_terminal(self):
        self.prepare()
        with patch.object(acquire, 'fetch', side_effect=TimeoutError('synthetic timeout')) as fetch, patch.object(acquire.time, 'sleep'), self.assertRaises(acquire.AcquisitionError):
            acquire.run_phase(self.root, 'pilot')
        self.assertEqual(fetch.call_count, 1)
        report = json.loads((self.root / 'pilot-report.json').read_bytes())
        self.assertEqual(report['attemptedHttpRequests'], 1)
        self.assertTrue((self.root / 'requests/0000/request.json').is_file())
        self.assertEqual(json.loads((self.root / 'requests/0000/receipt.json').read_bytes())['result'], 'failed')
        self.assertFalse((self.root / 'requests/0001').exists())

    # an http failure or redirect cannot advance the immutable request index
    def test_non_200_and_redirect_are_terminal(self):
        self.prepare()
        with patch.object(acquire, 'fetch', return_value=(429, {'Retry-After': '60'}, b'{"error":"rate limited"}')) as fetch, self.assertRaises(acquire.AcquisitionError):
            acquire.run_phase(self.root, 'pilot')
        self.assertEqual(fetch.call_count, 1)
        receipt = json.loads((self.root / 'requests/0000/receipt.json').read_bytes())
        self.assertEqual(receipt['status'], 429)
        self.assertEqual((self.root / 'requests/0000/response-body.bin').read_bytes(), b'{"error":"rate limited"}')
        self.assertFalse((self.root / 'requests/0001').exists())
        with self.assertRaises(acquire.AcquisitionError):
            acquire.NoRedirect().redirect_request(None, None, 302, 'moved', {}, 'https://unexpected.example/')

    # a changed frozen source fails before opening any attempt directory
    def test_source_drift_prevents_public_start(self):
        self.prepare()
        with (self.root / 'inputs/original-normalized.jsonl').open('ab') as stream:
            stream.write(b'changed\n')
        with patch.object(acquire, 'fetch') as fetch, self.assertRaises(acquire.AcquisitionError):
            acquire.run_phase(self.root, 'pilot')
        fetch.assert_not_called()
        self.assertFalse((self.root / 'requests').exists())

    # both empty and bounded oversized bodies retain explicit failure evidence
    def test_response_body_caps(self):
        for body in (b'', b'X' * 2_000_001):
            # each one-shot case needs a fresh private synthetic root
            with self.subTest(length=len(body)), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / 'weather-moisture-research-body-test'
                root.mkdir(mode=0o700)
                plan_path = root / 'plan.json'
                plan_path.write_bytes(acquire.canonical_json(self.plan))
                acquire.prepare(root, plan_path, self.source)
                with patch.object(acquire, 'fetch', return_value=(200, {}, body)) as fetch, self.assertRaises(acquire.AcquisitionError):
                    acquire.run_phase(root, 'pilot')
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual((root / 'requests/0000/response-body.bin').stat().st_size, min(len(body), 2_000_000))
                receipt = json.loads((root / 'requests/0000/receipt.json').read_bytes())
                self.assertFalse(receipt['result'] == 'success')
                self.assertEqual(receipt['responseBytesObserved'], len(body))

    # independent pilot receipt is required before chronological normalization
    def test_pilot_bulk_and_chronological_supplement(self):
        self.prepare()
        with patch.object(acquire, 'fetch', side_effect=self.fetched), patch.object(acquire.time, 'sleep'):
            pilot = acquire.run_phase(self.root, 'pilot')
        self.assertTrue(pilot['bulkEligible'])
        verifier = Path(acquire.__file__).with_name('verify_rain_direction_source.py')
        gate = {'contractVersion': acquire.PILOT_RECEIPT_CONTRACT, 'verdict': 'PASS', 'bulkEligible': True, 'planSha256': acquire.file_sha256(self.root / 'frozen-plan.json'), 'freezeSha256': acquire.file_sha256(self.root / 'direction-freeze.json'), 'pilotReportSha256': acquire.file_sha256(self.root / 'pilot-report.json'), 'pilotRawBodySha256': acquire.pilot_raw_hashes(self.root), 'verifierSourceSha256': acquire.file_sha256(verifier), 'verifiedAtUtc': acquire.utc_stamp()}
        gate_path = self.root / 'pilot-verification.json'
        gate_path.write_bytes(acquire.canonical_json(gate))
        with patch.object(acquire, 'fetch', side_effect=self.fetched) as fetch, patch.object(acquire.time, 'sleep'):
            final = acquire.run_phase(self.root, 'bulk', gate_path)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(final['totalAttemptedHttpRequests'], 7)
        self.assertEqual(final['normalizedRows'], 336)
        self.assertEqual(final['normalizedFile'], acquire.NORMALIZED_PATH)
        rows = [json.loads(line) for line in (self.root / acquire.NORMALIZED_PATH).read_bytes().splitlines()]
        self.assertEqual(len(rows), 336)
        self.assertEqual([rows[index * 48]['runInitializedAt'] for index in range(7)], [run + ':00Z' for run in self.runs])
        self.assertEqual(rows[0]['rawWindDirectionDegrees'], 1.)
        self.assertEqual(rows[0]['cohort'], 'ecmwf_single_run_hindcast')
        self.assertEqual(rows[0]['responseReceivedAtUtc'], json.loads((self.root / 'requests/0000/receipt.json').read_bytes())['responseReceivedAtUtc'])
        self.assertEqual(rows[5 * 48]['responseSha256'], json.loads((self.root / 'requests/0006/receipt.json').read_bytes())['contentSha256'])
        self.assertEqual(rows[6 * 48]['responseSha256'], json.loads((self.root / 'requests/0005/receipt.json').read_bytes())['contentSha256'])
        with self.assertRaises(acquire.AcquisitionError):
            acquire.run_phase(self.root, 'bulk', gate_path)


# extract only the allowlisted request run from a mocked provider url
def parse_run(url):
    from urllib import parse
    return parse.parse_qs(parse.urlsplit(url).query)['run'][0]


# run only local synthetic unit tests
if __name__ == '__main__':
    unittest.main()
