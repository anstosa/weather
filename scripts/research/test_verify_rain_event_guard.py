"""test independent event-guard replay with synthetic arrays only."""

import datetime as dt
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from rain_event_guard import POLICY
from verify_rain_event_guard import (
    calibrated_scale,
    check_hashes,
    check_retention_chain,
    development_gates,
    event_guard,
    month_masks,
    same_tree,
    score_events,
)


# keep tests independent of private rain outcomes
class EventGuardVerificationTests(unittest.TestCase):
    # preserve raw event calls and heavy amounts while rescuing raw-dry hours
    def test_guard_preserves_wet_and_heavy_raw_predictions(self):
        raw = np.array([0, .05, .1, .5, 1, 2], dtype=float)
        calibrated = np.array([1, .2, 0, .05, .01, 5], dtype=float)
        np.testing.assert_array_equal(event_guard(raw, calibrated), [1, .2, .1, .1, 1, 2])
        np.testing.assert_array_equal(raw, [0, .05, .1, .5, 1, 2])

    # reject array alignment errors before comparing scored rows
    def test_guard_rejects_shape_mismatch(self):
        # require a failing shape precondition
        with self.assertRaisesRegex(ValueError, 'invalid'):
            event_guard(np.array([0, 1]), np.array([0]))

    # weight unique dates and hours instead of repeated forecast vintages
    def test_calibration_balances_valid_hours(self):
        hours = np.array([0, 0, 1, 24])
        actual = np.array([0, 0, 2, 2], dtype=float)
        predicted = np.ones(4)
        self.assertEqual(calibrated_scale(actual, predicted, hours), 1.5)
        self.assertEqual(calibrated_scale(actual, np.zeros(4), hours), 1)

    # bind monthly fit and calibration to matured target times
    def test_month_masks_keep_two_seven_day_gaps(self):
        begin = int(dt.datetime(2025, 9, 1, tzinfo=dt.timezone.utc).timestamp() // 3600)
        data = {'hour': np.array([begin - 60 * 24, begin - 59 * 24, begin - 52 * 24, begin - 7 * 24]), 'initialized': np.array([begin - 8, begin - 8, begin - 8, begin - 8])}
        fit, calibration, evaluation, chronology = month_masks(data, '2025-09', {'trainingStartUtc': '2024-03-14T00:00:00Z'})
        np.testing.assert_array_equal(fit, [True, False, False, False])
        np.testing.assert_array_equal(calibration, [False, False, True, False])
        np.testing.assert_array_equal(evaluation, [True, True, True, True])
        self.assertEqual(chronology['trainingMaximumValidHourExclusive'], begin - 59 * 24)
        self.assertEqual(chronology['calibrationMaximumValidHourExclusive'], begin - 7 * 24)

    # fail closed on changed or escaped evidence members
    def test_hash_manifest_rejects_corruption_and_escape(self):
        # isolate changed bytes from repository files
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'member.bin'
            path.write_bytes(b'original')
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            check_hashes(root, {'member.bin': expected})
            path.write_bytes(b'changed')
            # reject modified content
            with self.assertRaisesRegex(ValueError, 'checksum'):
                check_hashes(root, {'member.bin': expected})
            # reject path traversal
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                check_hashes(root, {'../member.bin': expected})

    # reject omissions and numeric tampering in aggregate reports
    def test_recursive_report_comparison_rejects_mutation(self):
        same_tree({'a': {'loss': .1, 'passed': False}}, {'a': {'loss': .1, 'passed': False}})
        # reject changed field names
        with self.assertRaisesRegex(ValueError, 'keys changed'):
            same_tree({'a': {'loss': .1}}, {'a': {'other': .1}})
        # reject changed field values
        with self.assertRaisesRegex(ValueError, 'value changed'):
            same_tree({'a': {'loss': .1}}, {'a': {'loss': .2}})

    # refuse an archive receipt that cannot bind copied evidence members
    def test_retention_chain_rejects_mutated_receipt(self):
        # build a synthetic archive subset
        with tempfile.TemporaryDirectory() as temporary:
            inputs = Path(temporary)
            report_path = inputs / 'sub24-models/holdout-report.json'
            report_path.parent.mkdir()
            report_path.write_bytes(b'report')
            report_sha = hashlib.sha256(report_path.read_bytes()).hexdigest()
            members = {'contractVersion': 'test', 'files': {'sub24-models/holdout-report.json': {'sha256': report_sha, 'bytes': 6}}, 'modelReportSha256': report_sha, 'productionEligible': False, 'productionDatabaseOrServiceWrites': False}
            manifest_path = inputs / 'retention-members.json'
            manifest_path.write_text(json.dumps(members))
            receipt_path = inputs / 'parent-retention-receipt.json'
            receipt = {'verdict': 'PASS', 'encryptedRoundtripVerified': True, 'remoteCipherChecksumVerified': True, 'productionEligible': False, 'productionDatabaseOrServiceWrites': False, 'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(), 'verifiedFiles': 2}
            receipt_path.write_text(json.dumps(receipt))
            frozen = {'sub24-models/holdout-report.json': report_sha, 'retention-members.json': hashlib.sha256(manifest_path.read_bytes()).hexdigest(), 'parent-retention-receipt.json': hashlib.sha256(receipt_path.read_bytes()).hexdigest()}
            check_retention_chain(inputs, frozen)
            receipt['remoteCipherChecksumVerified'] = False
            receipt_path.write_text(json.dumps(receipt))
            # reject lost remote checksum evidence
            with self.assertRaisesRegex(ValueError, 'retention'):
                check_retention_chain(inputs, frozen)

    # preserve explicit wet and heavy detection diagnostics at all thresholds
    def test_event_scores_rederive_threshold_calls(self):
        actual = np.array([0, .2, 1.5, 3.])
        raw = np.array([0, 0, 1.5, 1.])
        guarded = np.array([0, .2, 1.5, 3.])
        scores = score_events(actual, np.arange(4), {'raw': raw, 'eventGuard': guarded}, [.1, 1., 2.5])
        self.assertEqual(scores['raw']['0.1']['pod'], 2 / 3)
        self.assertEqual(scores['eventGuard']['0.1']['pod'], 1)
        self.assertEqual(scores['raw']['2.5']['pod'], 0)
        self.assertEqual(scores['eventGuard']['2.5']['pod'], 1)

    # ensure a dry-hour MAE gain cannot bypass intensity or detection safety
    def test_development_gate_rejects_wet_harm_and_missed_events(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        # build complete threshold support
        events = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in POLICY['thresholdsMmPerHour']}
        season = {'raw': raw, 'eventGuard': candidate}
        # share safe synthetic seasons and leads
        report = {'overall': {'raw': raw, 'eventGuard': candidate, 'volumeScale': {'mae': .95}, 'persistence': {'mae': 1.1}}, 'bySeason': {key: season for key in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {key: season for key in ('1-6', '7-12', '13-23')}, 'events': {'raw': events, 'eventGuard': {key: value.copy() for key, value in events.items()}}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1}, 'eventGuard': {'mae': .9}}} for length in (6, 12, 23)}, 'invariants': {'rawHeavyAmountsUnchanged': True, 'rawWetCallsPreserved': True}}
        self.assertTrue(all(development_gates(report, POLICY).values()))
        report['overall']['eventGuard']['wetMae'] = 1.01
        self.assertFalse(development_gates(report, POLICY)['wetIntensityNoWorse'])
        report['events']['eventGuard']['0.1']['pod'] = .79
        self.assertFalse(development_gates(report, POLICY)['event0.1Safety'])


# run without private source availability
if __name__ == '__main__':
    unittest.main()
