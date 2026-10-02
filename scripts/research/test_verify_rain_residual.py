"""test independent residual verification helpers without private data."""

import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
import xgboost as xgb
from rain_residual import POLICY
from verify_rain_residual import (
    amount_map,
    calibrate,
    check_source_freeze,
    development_gates,
    support,
)


# isolate verifier arithmetic from private research rows
class ResidualVerificationTests(unittest.TestCase):
    # prevent duplicate vintages from manufacturing fit support
    def test_support_counts_distinct_wet_hours_and_dates(self):
        actual = np.array([0., .2, .2, 1.])
        hours = np.array([0, 1, 1, 24])
        self.assertEqual(support(actual, hours), {'rows': 4, 'dates': 2, 'hours': 3, 'wetDates': 2, 'wetHours': 2})

    # allow signed corrections while clipping final amounts
    def test_amount_map_handles_signed_residuals(self):
        raw = np.array([0., .2, 4., 30.])
        delta = np.array([1., -1., -4., 20.])
        np.testing.assert_array_equal(amount_map(raw, delta), [.5, 0, 2, 30])
        np.testing.assert_array_equal(amount_map(raw, delta, .5), [.25, 0, 1, 15])

    # reject invalid residual arrays before scoring
    def test_amount_map_rejects_nonfinite_or_misaligned_values(self):
        # reject misaligned rows
        with self.assertRaisesRegex(ValueError, 'invalid'):
            amount_map(np.array([1., 2.]), np.array([1.]))
        # reject undefined model output
        with self.assertRaisesRegex(ValueError, 'invalid'):
            amount_map(np.array([1.]), np.array([np.nan]))

    # solve the final clipped map instead of scaling an unbounded precursor
    def test_calibrate_attainable_and_unattainable_targets(self):
        hours = np.array([0, 24])
        actual = np.array([2., 4.])
        base = np.array([1., 2.])
        result = calibrate(actual, base, hours, POLICY)
        self.assertTrue(result['supported'])
        self.assertAlmostEqual(result['scale'], 2)
        self.assertAlmostEqual(result['achievedMean'], 3)
        impossible = calibrate(actual * 2, base, hours, POLICY)
        self.assertFalse(impossible['supported'])
        self.assertEqual(impossible['reason'], 'target_outside_attainable_range')

    # reject an uninformative scalar curve
    def test_calibrate_rejects_flat_curve(self):
        result = calibrate(np.array([1., 1.]), np.zeros(2), np.array([0, 24]), POLICY)
        self.assertFalse(result['supported'])
        self.assertEqual(result['reason'], 'flat_calibration_curve')

    # prove native in-memory JSON equals the producer's saved JSON bytes
    def test_native_refit_json_matches_saved_model_bytes(self):
        matrix = xgb.DMatrix(np.array([[0.], [1.], [2.]]), label=np.array([-1., 0., 1.]), feature_names=['rawRain'], nthread=1)
        booster = xgb.train({'objective': 'reg:squarederror', 'base_score': 0, 'nthread': 1}, matrix, num_boost_round=2)
        # use an isolated native JSON save
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'residual.json'
            booster.save_model(path)
            self.assertEqual(hashlib.sha256(booster.save_raw(raw_format='json')).hexdigest(), hashlib.sha256(path.read_bytes()).hexdigest())

    # reject changed retained source bytes even when a path still exists
    def test_source_freeze_rejects_copied_source_tampering(self):
        # isolate a copied source member
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'residual-sources/verify_rain_residual.py'
            source.parent.mkdir()
            live = Path(__file__).with_name('verify_rain_residual.py')
            source.write_bytes(live.read_bytes())
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            check_source_freeze(root, {'sourceSha256': {'verify_rain_residual.py': expected}}, ('verify_rain_residual.py',))
            source.write_bytes(b'changed')
            # reject one changed copied implementation
            with self.assertRaisesRegex(ValueError, 'changed'):
                check_source_freeze(root, {'sourceSha256': {'verify_rain_residual.py': expected}}, ('verify_rain_residual.py',))

    # preserve empirical event gates and candidate-specific support
    def test_development_gates_reject_detection_and_raw_fallback_illusion(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        # include all frozen event thresholds
        event = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in POLICY['thresholdsMmPerHour']}
        group = {'raw': raw, 'residualAmount': candidate}
        # provide every required season, lead and accumulation
        report = {'overall': {'raw': raw, 'residualAmount': candidate, 'volumeScale': {'mae': .95}, 'persistence': {'mae': 1.1}}, 'bySeason': {name: group for name in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {name: group for name in ('1-6', '7-12', '13-23')}, 'events': {'raw': event, 'residualAmount': {name: value.copy() for name, value in event.items()}}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1}, 'residualAmount': {'mae': .9}}} for length in (6, 12, 23)}, 'support': {'dates': 200, 'wetDates': 30}, 'invariants': {'finiteNonnegative': True}}
        self.assertEqual(len(development_gates(report, POLICY)), 44)
        self.assertTrue(all(development_gates(report, POLICY).values()))
        report['events']['residualAmount']['0.1']['pod'] = .79
        self.assertFalse(development_gates(report, POLICY)['event0.1Safety'])
        report['support']['dates'] = 0
        self.assertFalse(development_gates(report, POLICY)['candidateSupport'])


# execute synthetic-only checks
if __name__ == '__main__':
    unittest.main()
