"""exercise independent rain-search verification without private outcomes."""

import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
import xgboost as xgb
from rain_search import POLICY
from verify_rain_search import (
    calibrate,
    candidate_screens,
    check_booster,
    checked_rules,
    head_support,
    month_masks,
    ordinal_categories,
    ordinal_project,
    ordinal_rules,
    source_freeze,
    support,
)


# exercise only synthetic verifiable boundaries
class RainSearchVerificationTests(unittest.TestCase):
    # count valid hours instead of duplicate forecast vintages
    def test_support_uses_distinct_dates_and_hours(self):
        actual = np.array([0., .2, .2, 2.5])
        hours = np.array([0, 1, 1, 24])
        self.assertEqual(support(actual, hours), {'rows': 4, 'dates': 2, 'hours': 3, 'wetDates': 2, 'wetHours': 2})
        self.assertEqual(head_support(actual, hours, 1.), {'rows': 4, 'positiveRows': 1, 'positiveHours': 1, 'positiveDates': 1})

    # separate ninety-day calibration from the two seven-day gaps
    def test_chronology_has_two_embargoes(self):
        start = 1767225600 // 3600  # 2026-01-01T00:00:00Z
        data = {'hour': np.array([start - 104 * 24 - 1, start - 104 * 24, start - 97 * 24, start - 7 * 24]), 'initialized': np.array([start - 8, start - 8, start - 8, start - 8])}
        old = {'trainingStartUtc': '2024-01-01T00:00:00Z', 'decisionDelayHours': 8}
        fit, calibration, evaluation, bounds = month_masks(data, '2026-01', old, POLICY)
        np.testing.assert_array_equal(fit, [True, False, False, False])
        np.testing.assert_array_equal(calibration, [False, False, True, False])
        np.testing.assert_array_equal(evaluation, [True, True, True, True])
        self.assertEqual(bounds['trainingMaximumValidHourExclusive'], start - 104 * 24)
        self.assertEqual(bounds['calibrationStartHour'], start - 97 * 24)
        self.assertEqual(bounds['calibrationMaximumValidHourExclusive'], start - 7 * 24)

    # retain an exact root when reachable and explicit saturation otherwise
    def test_scalar_calibration_reports_saturation(self):
        hours = np.array([0, 24])
        actual = np.array([1., 2.])
        base = np.array([.5, 1.])
        matched = calibrate(actual, hours, lambda value: base * value)
        self.assertEqual(matched['status'], 'matched')
        self.assertAlmostEqual(matched['scale'], 2.)
        high = calibrate(actual * 10, hours, lambda value: base * value)
        self.assertEqual(high['status'], 'saturated_high')
        self.assertEqual(high['scale'], 3.)
        low = calibrate(np.zeros(2), hours, lambda value: np.maximum(.1, base * value))
        self.assertEqual(low['status'], 'saturated_low')
        self.assertEqual(low['scale'], .1)

    # refuse empty, misaligned or nonphysical calibration projections
    def test_scalar_rejects_invalid_arrays(self):
        with self.assertRaisesRegex(ValueError, 'invalid'):
            calibrate(np.array([]), np.array([], dtype=int), lambda value: np.array([]))
        with self.assertRaisesRegex(ValueError, 'invalid'):
            calibrate(np.array([1.]), np.array([0]), lambda value: np.array([-1.]))

    # keep tied classifier scores together at the largest recall-safe cutoff
    def test_ordinal_rules_preserve_tied_score_recall(self):
        actual = np.array([.2, .2, 0., 0., .2, 0., .2, 0., .2, 0.])
        raw = np.array([.2, 0., 0., 0., .2, 0., 0., 0., 0., 0.])
        hours = np.arange(10, dtype=np.int64) * 24
        scores = np.full((10, 3), np.nan)
        scores[:, 0] = [.9, .8, .1, .1, .8, .1, .8, .1, .8, .1]
        custom = {**POLICY, 'ordinalThresholdPolicy': {**POLICY['ordinalThresholdPolicy'], 'minimumCalibrationPositiveHours': [5, 5, 5]}}
        result = ordinal_rules(actual, raw, scores, hours, custom)
        self.assertEqual(result[0]['cutoff'], .8)
        self.assertEqual(result[0]['reason'], 'calibrated')
        self.assertIsNone(result[1]['cutoff'])

    # verify nonnested heads trigger a wholesale raw-call fallback
    def test_nesting_safety_falls_back_to_raw(self):
        actual = np.array([1., 0., 0., 0.])
        raw = np.array([1., 0., 0., 0.])
        hours = np.arange(4, dtype=np.int64) * 24
        scores = np.array([[.9, .8, np.nan], [.8, .9, np.nan], [.7, .8, np.nan], [.6, .7, np.nan]])
        rules = [{'threshold': threshold, 'cutoff': cutoff, 'reason': 'calibrated'} for threshold, cutoff in zip((.1, 1., 2.5), (.9, .7, None))]
        result, fallback = checked_rules(actual, raw, scores, hours, rules)
        self.assertTrue(fallback)
        self.assertTrue(all(rule['cutoff'] is None and rule['reason'] == 'nesting_safety_fallback' for rule in result))
        np.testing.assert_array_equal(ordinal_categories(raw, scores, result), [2, 0, 0, 0])

    # preserve exact zeros and physical category thresholds
    def test_ordinal_projection_respects_bands(self):
        base = np.array([5., .01, 5., .01, 5., .01, 5.])
        categories = np.array([0, 1, 1, 2, 2, 3, 3])
        projected = ordinal_project(base, categories, 1.)
        self.assertEqual(projected[0], 0.)
        self.assertEqual(projected[1], .1)
        self.assertLess(projected[2], 1.)
        self.assertEqual(projected[3], 1.)
        self.assertLess(projected[4], 2.5)
        self.assertEqual(projected[5], 2.5)
        self.assertEqual(projected[6], 5.)

    # bind native refits to byte-identical JSON and the named objective
    def test_native_model_checksum_and_objective(self):
        matrix = xgb.DMatrix(np.array([[0.], [1.], [2.]], dtype=np.float32), label=np.array([0., 1., 2.]), feature_names=['rain'], nthread=1)
        booster = xgb.train({'objective': 'reg:squarederror', 'nthread': 1}, matrix, num_boost_round=2)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'amount.json'
            booster.save_model(path)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            check_booster(booster, path, digest, 'reg:squarederror', 2, ['rain'])
            with self.assertRaisesRegex(ValueError, 'objective'):
                check_booster(booster, path, digest, 'reg:gamma', 2, ['rain'])

    # refuse a freeze that omits even one declared producer source
    def test_source_freeze_rejects_missing_source_set(self):
        with self.assertRaisesRegex(ValueError, 'source set'):
            source_freeze(Path('/nonexistent'), {'sourceSha256': {}})

    # require the extra same-window baseline beyond the inherited 44 gates
    def test_candidate_screens_select_only_full_gate_passers(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        event = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in POLICY['thresholdsMmPerHour']}
        names = POLICY['candidates']
        metrics_by_arm = {'raw': raw, 'persistence': {'mae': 1.1}, 'volumeScale': {'mae': .95}, 'volume90': {'mae': .95}, **{name: candidate for name in names}}
        report = {'overall': metrics_by_arm, 'bySeason': {season: {'raw': raw, **{name: candidate for name in names}} for season in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {band: {'raw': raw, **{name: candidate for name in names}} for band in ('1-6', '7-12', '13-23')}, 'events': {'raw': event, **{name: event for name in names}}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1.}, **{name: {'mae': .9} for name in names}}} for length in (6, 12, 23)}, 'invariants': {'finiteNonnegative': True}}
        days = np.arange(200, dtype=np.int64) * 24
        data = {'actual': np.ones(200), 'hour': days}
        flags = {name: np.ones(200, dtype=bool) for name in names}
        screens, selected = candidate_screens(report, data, np.arange(200), flags)
        self.assertEqual(selected, 'ordinalAmount')
        self.assertTrue(all(result['passed'] and len(result['gates']) == 45 for result in screens.values()))
        report['overall']['volume90'] = {'mae': .8}
        screens, selected = candidate_screens(report, data, np.arange(200), flags)
        self.assertIsNone(selected)
        self.assertTrue(all(not result['gates']['beatsSameWindowVolumeScale'] for result in screens.values()))


# keep tests separate from private historical material
if __name__ == '__main__':
    unittest.main()
