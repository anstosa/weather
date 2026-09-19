"""exercise independent direction-source checks with synthetic retained bytes."""

import copy
import datetime as dt
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

import acquire_rain_direction as acquire
import verify_rain_direction_source as verify
from test_acquire_rain_direction import DirectionAcquisitionTests, rainfall


# create one complete forecast-only synthetic identity
def original():
    return {
        'run': '2026-05-12T00:00',
        'initialized': '2026-05-12T00:00:00Z',
        'key': 'ecmwf_single_run_hindcast|2026-05-12T00:00',
        'grid': (47.97891, -122.44185),
        'precipitation': tuple(None if lead == 8 else float(lead / 10) for lead in range(1, 49)),
    }


# build one valid public single-coordinate response
def response(identity, direction=None):
    origin = verify.utc_time(identity['initialized'])
    values = [float(lead) for lead in range(49)] if direction is None else direction
    return {
        'latitude': identity['grid'][0],
        'longitude': identity['grid'][1],
        'elevation': 28.,
        'timezone': 'GMT',
        'utc_offset_seconds': 0,
        'hourly_units': verify.UNITS,
        'hourly': {
            'time': [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(49)],
            'precipitation': [None, *identity['precipitation']],
            'wind_direction_10m': values,
        },
    }


# retain a synthetic request and its byte-bound receipt
def attempt(root, identity, raw):
    directory = root / 'requests/0000'
    directory.mkdir(parents=True)
    params = verify.expected_params(identity['run'])
    started = '2026-09-13T06:00:00+00:00'
    base = {
        'phase': 'pilot',
        'requestIndex': 0,
        'runIndex': 0,
        'run': identity['run'],
        'endpoint': verify.ENDPOINT,
        'canonicalParams': params,
        'paramsSha256': verify.sha256(verify.canonical_json(params)),
        'urlSha256': verify.sha256((verify.ENDPOINT + '?' + urlencode([tuple(pair) for pair in params])).encode()),
        'startedAtUtc': started,
        'actualIssueAt': None,
    }
    receipt = {
        **base,
        'responseReceivedAtUtc': '2026-09-13T06:00:01+00:00',
        'status': 200,
        'safeHeaders': {'content-type': 'application/json'},
        'responseBytesObserved': len(raw),
        'responseBytesStored': len(raw),
        'bodyComplete': True,
        'contentSha256': verify.sha256(raw),
        'capturedSha256': verify.sha256(raw),
        'rawBodyFile': 'response-body.bin',
        'result': 'success',
        'error': None,
        'summary': {
            'run': identity['run'],
            'returnedGrid': {'latitude': identity['grid'][0], 'longitude': identity['grid'][1]},
            'targetElevationM': 28.,
            'precipitationParity': True,
            'precipitationNullRows': 2,
            'directionNullRows': 0,
            'directionNullSelectedLeads': 0,
            'directionFootprintNonNullHours': 29,
            'directionFootprintComplete': True,
            'actualIssueAt': None,
        },
    }
    (directory / 'request.json').write_bytes(verify.canonical_json(base))
    (directory / 'receipt.json').write_bytes(verify.canonical_json(receipt))
    (directory / 'response-body.bin').write_bytes(raw)
    return directory


# prove the verifier rejects altered source identities and retained bytes
class DirectionVerifierTests(unittest.TestCase):
    # fixed quantiles select six deterministic distinct successful runs
    def test_pilot_positions(self):
        self.assertEqual(verify.PILOT, (0, 660, 1320, 1980, 2640, 3300))
        self.assertEqual(len(set(verify.PILOT)), 6)

    # source nulls remain null and the feature footprint is explicit
    def test_response_parity_and_nullable_direction(self):
        identity = original()
        raw = verify.canonical_json(response(identity))
        checked = verify.audit_response(raw, identity)
        self.assertEqual(checked['directionFootprintNonNullHours'], 29)
        self.assertTrue(checked['directionFootprintComplete'])
        self.assertEqual(checked['precipitation'][8], None)
        changed = response(identity)
        changed['hourly']['wind_direction_10m'][5] = None
        self.assertTrue(verify.audit_response(verify.canonical_json(changed), identity)['directionFootprintComplete'])
        changed['hourly']['wind_direction_10m'][6] = None
        self.assertFalse(verify.audit_response(verify.canonical_json(changed), identity)['directionFootprintComplete'])

    # grid, time, units, precipitation and direction bounds fail closed
    def test_response_tamper_regressions(self):
        identity = original()
        mutations = (
            lambda item: item.update(latitude=47.5),
            lambda item: item['hourly']['time'].__setitem__(8, '2026-05-12T09:00'),
            lambda item: item['hourly_units'].update(precipitation='cm'),
            lambda item: item['hourly']['precipitation'].__setitem__(8, 0.),
            lambda item: item['hourly']['wind_direction_10m'].__setitem__(7, 361.),
            lambda item: item.update(location_id=1),
        )
        # isolate each mutation from the valid response baseline
        for mutation in mutations:
            changed = copy.deepcopy(response(identity))
            mutation(changed)
            # reject each changed raw response
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                verify.audit_response(verify.canonical_json(changed), identity)
        # reject ambiguous duplicate fields
        with self.assertRaises(ValueError):
            verify.strict_json(b'{"latitude":1,"latitude":2}')

    # body, URL, status and run indexes cannot be silently rebased
    def test_attempt_tamper_regressions(self):
        identity = original()
        raw = verify.canonical_json(response(identity))
        # isolate raw body tamper
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = attempt(root, identity, raw)
            checked = verify.audit_attempt(root, 0, 0, identity)
            self.assertEqual(checked['rawBodySha256'], verify.sha256(raw))
            (directory / 'response-body.bin').write_bytes(raw + b' ')
            # reject changed response bytes
            with self.assertRaises(ValueError):
                verify.audit_attempt(root, 0, 0, identity)
        # isolate run index tamper
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = attempt(root, identity, raw)
            receipt = json.loads((directory / 'receipt.json').read_text())
            receipt['runIndex'] = 1
            (directory / 'receipt.json').write_bytes(verify.canonical_json(receipt))
            # reject incorrect run index
            with self.assertRaises(ValueError):
                verify.audit_attempt(root, 0, 0, identity)

    # gate proof binds six raw hashes and the exact verifier source
    def test_pilot_gate_receipt_tamper(self):
        records = [
            {
                'rawBodyPath': f'requests/{index:04d}/response-body.bin',
                'rawBodySha256': verify.sha256(str(index).encode()),
                'receivedAtUtc': '2026-09-13T06:00:01+00:00',
            }
            for index in range(6)
        ]
        hashes = {'planSha256': 'plan', 'freezeSha256': 'freeze'}
        phase = {'sha256': 'pilot-report', 'bulkEligible': True}
        receipt = {
            'contractVersion': verify.CONTRACT,
            'verdict': 'PASS',
            'bulkEligible': True,
            'planSha256': 'plan',
            'freezeSha256': 'freeze',
            'pilotReportSha256': 'pilot-report',
            'pilotRawBodySha256': {item['rawBodyPath']: item['rawBodySha256'] for item in records},
            'verifierSourceSha256': verify.sha256(Path(verify.__file__).read_bytes()),
            'verifiedAtUtc': '2026-09-13T06:00:02+00:00',
        }
        # isolate gate receipt mutations
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'pilot-verification.json'
            path.write_bytes(verify.canonical_json(receipt))
            self.assertEqual(verify.audit_pilot_receipt(path, hashes, records, phase)['sha256'], verify.sha256(path.read_bytes()))
            # each changed proof field must fail the bulk gate
            for name, value in (('verifierSourceSha256', 'stale'), ('bulkEligible', False), ('pilotReportSha256', 'stale'), ('pilotRawBodySha256', {})):
                altered = {**receipt, name: value}
                path.write_bytes(verify.canonical_json(altered))
                # reject stale gate evidence
                with self.subTest(name=name), self.assertRaises(ValueError):
                    verify.audit_pilot_receipt(path, hashes, records, phase)

    # identity PASS can coexist with a no-data bulk stop
    def test_pilot_receipt_preserves_not_eligible(self):
        record = {
            'rawBodyPath': 'requests/0000/response-body.bin',
            'rawBodySha256': 'body',
            'directionFootprintComplete': False,
        }
        fake = (
            {'expiresAtUtc': '9999-01-01T00:00:00Z'},
            {},
            {'planSha256': 'plan', 'freezeSha256': 'freeze'},
            [record],
            {'bulkEligible': False, 'sha256': 'report'},
        )
        # isolate no-data pilot gate
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'pilot-verification.json'
            # mock only the pilot audit
            with patch.object(verify, 'original_profiles', return_value=[]), patch.object(verify, 'audit_pilot', return_value=fake):
                result = verify.issue_pilot(root, output)
            self.assertEqual(result['verdict'], 'PASS')
            self.assertIs(result['bulkEligible'], False)
            # reject receipt overwrite
            with patch.object(verify, 'original_profiles', return_value=[]), patch.object(verify, 'audit_pilot', return_value=fake), self.assertRaises(ValueError):
                verify.issue_pilot(root, output)

    # the pilot report cannot invent complete feature-footprint coverage
    def test_phase_report_coverage_tamper(self):
        records = [
            {
                'attemptIndex': index,
                'runIndex': index,
                'run': f'2026-05-12T{index:02d}:00',
                'rawBodySha256': f'body-{index}',
                'receiptSummary': {'directionFootprintComplete': index != 5},
                'directionFootprintComplete': index != 5,
            }
            for index in range(6)
        ]
        receipts = [
            {'requestIndex': item['attemptIndex'], 'runIndex': item['runIndex'], 'run': item['run'], 'result': 'success', 'status': 200, 'contentSha256': item['rawBodySha256']}
            for item in records
        ]
        report = {
            'contractVersion': 'rain-direction-acquisition/v1',
            'phase': 'pilot',
            'status': 'complete',
            'failure': None,
            'planSha256': 'plan',
            'freezeSha256': 'freeze',
            'pilotVerificationSha256': None,
            'plannedHttpRequests': 6,
            'attemptedHttpRequests': 6,
            'successfulHttpRequests': 6,
            'attemptedLocationRequests': 6,
            'actualIssueAt': None,
            'labelsRead': False,
            'modelPerformanceScored': False,
            'productionWrites': False,
            'receipts': receipts,
            'runSummaries': [item['receiptSummary'] for item in records],
            'bulkEligible': False,
        }
        # isolate phase report mutations
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'pilot-report.json'
            path.write_bytes(verify.canonical_json(report))
            self.assertFalse(verify.audit_phase_report(root, 'pilot', records, {'planSha256': 'plan', 'freezeSha256': 'freeze'})['bulkEligible'])
            report['bulkEligible'] = True
            path.write_bytes(verify.canonical_json(report))
            # reject false eligibility
            with self.assertRaises(ValueError):
                verify.audit_phase_report(root, 'pilot', records, {'planSha256': 'plan', 'freezeSha256': 'freeze'})

    # offline source copies may change mtime while exact bytes remain pinned
    def test_frozen_input_mtime_is_not_authority(self):
        # isolate copied source metadata
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'direction'
            original_root = base / 'original'
            old_acquisition = original_root / 'acquisition'
            old_acquisition.mkdir(parents=True)
            (root / 'inputs/original-producer-sources').mkdir(parents=True)
            (root / 'sources').mkdir()
            normalized_bytes = b'forecast\n'
            normalized_sha = verify.sha256(normalized_bytes)
            (root / 'inputs/original-normalized.jsonl').write_bytes(normalized_bytes)
            old_hashes = {}
            # snapshot only the three existing old producer bytes
            for name in verify.OLD_PRODUCER_SOURCES:
                body = name.encode()
                old_hashes[name] = verify.sha256(body)
                (root / 'inputs/original-producer-sources' / name).write_bytes(body)
            manifest_bytes = verify.canonical_json({'sourceSha256': old_hashes})
            manifest_sha = verify.sha256(manifest_bytes)
            (old_acquisition / 'manifest.json').write_bytes(manifest_bytes)
            (root / 'inputs/original-manifest.json').write_bytes(manifest_bytes)
            source_hashes = {}
            # producer copies must match their current checked code
            for name in verify.PRODUCER_SOURCES:
                body = Path(verify.__file__).with_name(name).read_bytes()
                source_hashes[name] = verify.sha256(body)
                (root / 'sources' / name).write_bytes(body)
            plan = {
                'contractVersion': 'rain-direction-acquisition/v1',
                'endpoint': verify.ENDPOINT,
                'site': {'latitude': verify.SITE[0], 'longitude': verify.SITE[1]},
                'runs': ['2026-05-12T00:00'],
                'pilotRuns': ['2026-05-12T00:00'],
                'expiresAtUtc': verify.EXPIRY,
                'maximumHttpRequests': 1,
                'maximumLocationRequests': 1,
                'retries': 0,
                'minimumIntervalSeconds': 1,
                'timeoutSeconds': 30,
                'maximumResponseBytes': 2_000_000,
                'originalSourceSha256': normalized_sha,
                'originalManifestSha256': manifest_sha,
            }
            plan_bytes = verify.canonical_json(plan)
            (root / 'frozen-plan.json').write_bytes(plan_bytes)
            manifest_copy = root / 'inputs/original-manifest.json'
            normalized_copy = root / 'inputs/original-normalized.jsonl'
            freeze = {
                'contractVersion': plan['contractVersion'],
                'endpoint': verify.ENDPOINT,
                'planSha256': verify.sha256(plan_bytes),
                'runsSha256': verify.sha256(verify.canonical_json(plan['runs'])),
                'pilotRuns': plan['pilotRuns'],
                'originalManifestSha256': manifest_sha,
                'originalNormalizedSha256': normalized_sha,
                'originalRoot': str(original_root),
                'originalManifestPath': 'acquisition/manifest.json',
                'originalNormalizedPath': 'acquisition/normalized/ecmwf_single_run_hindcast.jsonl',
                'maximumHttpRequests': 1,
                'maximumLocationRequests': 1,
                'actualIssueAt': None,
                'labelsRead': False,
                'productionWrites': False,
                'sourceSha256': source_hashes,
                'originalProducerSha256': old_hashes,
                'inputBytes': {'manifest': len(manifest_bytes), 'normalized': len(normalized_bytes)},
                'inputMtimeNs': {'manifest': manifest_copy.stat().st_mtime_ns, 'normalized': normalized_copy.stat().st_mtime_ns},
            }
            (root / 'direction-freeze.json').write_bytes(verify.canonical_json(freeze))
            # change only the copy's mtime, not its content
            os.utime(normalized_copy, ns=(normalized_copy.stat().st_atime_ns, normalized_copy.stat().st_mtime_ns + 1_000_000_000))
            # patch only synthetic source hashes
            with patch.object(verify, 'ORIGINAL', old_acquisition), patch.object(verify, 'MANIFEST_SHA', manifest_sha), patch.object(verify, 'SOURCE_SHA', normalized_sha), patch.object(verify, 'RUNS', 1), patch.object(verify, 'PILOT', (0,)):
                verify.audit_freeze(root, [{'run': '2026-05-12T00:00'}])
                normalized_copy.write_bytes(b'forecasx\n')
                # reject changed source bytes
                with self.assertRaises(ValueError):
                    verify.audit_freeze(root, [{'run': '2026-05-12T00:00'}])

    # chronological rows bind raw wind, old rain and per-run body provenance
    def test_normalized_join_tamper(self):
        identity = original()
        direction = tuple(float(lead) for lead in range(49))
        attempt_record = {
            'direction': direction,
            'grid': list(identity['grid']),
            'rawBodySha256': 'body-sha',
            'receivedAtUtc': '2026-09-13T06:00:01+00:00',
        }
        origin = verify.utc_time(identity['initialized'])
        rows = []
        # create one exact 48-lead supplement block
        for lead in range(1, 49):
            rows.append({
                'cohort': verify.COHORT,
                'key': f'{verify.COHORT}|{identity["run"]}|lead={lead}',
                'runInitializedAt': identity['initialized'],
                'validAt': (origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'targetLeadHours': lead,
                'rawPrecipitationMm': identity['precipitation'][lead - 1],
                'rawWindDirectionDegrees': direction[lead],
                'returnedGrid': {'latitude': identity['grid'][0], 'longitude': identity['grid'][1]},
                'responseSha256': 'body-sha',
                'responseReceivedAtUtc': attempt_record['receivedAtUtc'],
                'actualIssueAt': None,
            })
        # isolate one chronological block
        with tempfile.TemporaryDirectory() as temporary, patch.object(verify, 'SOURCE_ROWS', 48):
            root = Path(temporary)
            directory = root / 'normalized'
            directory.mkdir()
            path = directory / 'ecmwf_single_run_wind_direction.jsonl'
            body = b''.join(verify.canonical_json(item) for item in rows)
            path.write_bytes(body)
            final = {'normalizedFile': 'normalized/ecmwf_single_run_wind_direction.jsonl', 'normalizedRows': 48, 'normalizedSha256': verify.sha256(body)}
            self.assertEqual(verify.audit_normalized(root, [identity], {0: attempt_record}, final)['rows'], 48)
            rows[7]['responseSha256'] = 'changed'
            changed = b''.join(verify.canonical_json(item) for item in rows)
            path.write_bytes(changed)
            final['normalizedSha256'] = verify.sha256(changed)
            # reject row provenance tamper
            with self.assertRaises(ValueError):
                verify.audit_normalized(root, [identity], {0: attempt_record}, final)

    # mocked producer artifacts must satisfy the independent pilot and full contracts
    def test_synthetic_seven_run_artifact_integration(self):
        fixture = DirectionAcquisitionTests('test_prepare_and_plan_fail_closed')
        fixture.setUp()
        # release mocked producer resources after the artifact replay
        try:
            fixture.prepare()
            # all acquisition transport remains mocked by the producer fixture
            with patch.object(acquire, 'fetch', side_effect=fixture.fetched), patch.object(acquire.time, 'sleep'):
                acquire.run_phase(fixture.root, 'pilot')
            originals = [
                {
                    'run': run,
                    'initialized': run + ':00Z',
                    'key': f'{verify.COHORT}|{run}',
                    'grid': (fixture.grids[run]['latitude'], fixture.grids[run]['longitude']),
                    'precipitation': tuple(rainfall(index)[1:]),
                }
                for index, run in enumerate(fixture.runs)
            ]
            real_freeze_audit = verify.audit_freeze

            # mocked fixed producer clock cannot demonstrate real one-second spacing
            def synthetic_freeze_audit(root, profiles):
                plan, freeze, hashes = real_freeze_audit(root, profiles)
                return {**plan, 'minimumIntervalSeconds': 0}, freeze, hashes

            # reduce only fixed corpus sizes and audit the real retained artifact schema
            with patch.object(verify, 'ORIGINAL', fixture.source / 'acquisition'), patch.object(verify, 'MANIFEST_SHA', acquire.ORIGINAL_MANIFEST_SHA256), patch.object(verify, 'SOURCE_SHA', acquire.ORIGINAL_NORMALIZED_SHA256), patch.object(verify, 'RUNS', 7), patch.object(verify, 'SOURCE_ROWS', 336), patch.object(verify, 'PILOT', (0, 1, 2, 3, 4, 6)), patch.object(verify, 'original_profiles', return_value=originals), patch.object(verify, 'audit_freeze', side_effect=synthetic_freeze_audit):
                gate_path = fixture.root / 'pilot-verification.json'
                # keep receipt issuance inside the synthetic acquisition window
                with patch.object(verify.dt, 'datetime', wraps=dt.datetime) as clock:
                    clock.now.return_value = verify.utc_time(verify.EXPIRY)
                    # expiration must still fail before a receipt can be written
                    with self.assertRaisesRegex(ValueError, 'pilot verification completed after expiration'):
                        verify.issue_pilot(fixture.root, gate_path)
                    self.assertFalse(gate_path.exists())
                    clock.now.return_value = acquire.utc_now() + dt.timedelta(seconds=1)
                    gate = verify.issue_pilot(fixture.root, gate_path)
                self.assertTrue(gate['bulkEligible'])
                # bulk follows its synthetic receipt without depending on the real date
                later = verify.utc_time(gate['verifiedAtUtc']) + dt.timedelta(seconds=10)
                # exercise the retained bulk contract under mocked transport
                with patch.object(acquire, 'utc_now', return_value=later), patch.object(acquire, 'fetch', side_effect=fixture.fetched), patch.object(acquire.time, 'sleep'):
                    acquire.run_phase(fixture.root, 'bulk', gate_path)
                full = verify.audit_full(fixture.root, gate_path)
                self.assertEqual((full['verdict'], full['rawResponses'], full['normalizedRows']), ('PASS', 7, 336))
        finally:
            fixture.tearDown()


# run only local synthetic fixtures
if __name__ == '__main__':
    unittest.main()
