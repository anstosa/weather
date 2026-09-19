"""synthetic contracts for independent fixed rain recency replay."""

import copy
from pathlib import Path
import tempfile
import unittest

import numpy as np
from rain_search import POLICY
from test_rain_event_guard import safe_report
from verify_rain_recency import (
    ARMS,
    calibrate_recent,
    candidate_screen,
    checked_rules_recent,
    effective_support,
    ordinal_rules_recent,
    recent_weights,
    reference_parity,
    refit_models,
)


# extend the old synthetic safety fixture with all frozen recency controls
def safe_recency_screen():
    original = safe_report()

    # keep the old raw and scaling fixtures while adding named new arms
    def expand(value):
        if not isinstance(value, dict):
            return value
        result = {name: expand(item) for name, item in value.items() if name != 'eventGuard'}
        if 'eventGuard' in value:
            result.update({name: copy.deepcopy(value['eventGuard']) for name in ARMS if name not in result})
        return result

    report = expand(original)
    report['overall']['volume90']['mae'] = .85
    report['overall']['volumeRecent']['mae'] = .85
    report['overall']['ordinal90']['mae'] = .85
    report['bySeason']['DJF']['ordinal90']['volumeRatio'] = 1.3
    report['invariants'] = {'finiteNonnegative': True}
    data = {'actual': np.ones(366), 'hour': np.arange(366) * 24}
    return report, data, np.arange(366), np.ones(366, dtype=bool)


class RainRecencyVerificationTests(unittest.TestCase):
    # prove a repeated vintage never receives extra date or hour mass
    def test_recent_weights_balance_dates_hours_and_vintages(self):
        hours = np.array([0, 0, 1, 24, 24, 25], dtype=np.int64)
        mass = recent_weights(hours, 48)
        expected_old = 2 ** (-1 / 30) / (1 + 2 ** (-1 / 30))
        self.assertAlmostEqual(mass[:3].sum(), expected_old)
        self.assertAlmostEqual(mass[3:].sum(), 1 - expected_old)
        self.assertAlmostEqual(mass[0], mass[1])
        self.assertAlmostEqual(mass[0] + mass[1], mass[2])
        self.assertAlmostEqual(mass[3] + mass[4], mass[5])

    # bind age to the last calibration date, not the evaluation date
    def test_recent_weights_reject_following_dates(self):
        with self.assertRaises(ValueError):
            recent_weights(np.array([24], dtype=np.int64), 24)
        with self.assertRaises(ValueError):
            recent_weights(np.array([0], dtype=np.int64), 91 * 24)

    # count wet Kish mass on wet dates, not merely positive rows
    def test_effective_support_uses_distinct_date_mass(self):
        actual = np.array([0., 1., 0., 0.])
        hours = np.array([0, 1, 24, 25], dtype=np.int64)
        mass = np.array([.25, .25, .25, .25])
        found = effective_support(actual, hours, mass)
        self.assertAlmostEqual(found['effectiveDates'], 2.)
        self.assertAlmostEqual(found['effectiveWetDates'], 1.)
        self.assertEqual(effective_support(np.zeros(4), hours, mass)['effectiveWetDates'], 0.)

    # calibrate the clipped final amount rather than an unclipped ratio
    def test_weighted_scalar_solves_final_amount_curve(self):
        actual = np.array([2., 2.])
        mass = np.array([.75, .25])
        base = np.array([1., 1.])
        result = calibrate_recent(actual, mass, lambda scale: np.clip(base * scale, 0, 30), POLICY)
        self.assertEqual(result['status'], 'matched')
        self.assertAlmostEqual(result['scale'], 2., places=6)
        self.assertAlmostEqual(result['achievedMean'], result['targetMean'], places=6)

    # report saturation when the target exceeds the bounded amount curve
    def test_weighted_scalar_retains_saturated_endpoint(self):
        actual = np.array([20., 20.])
        mass = np.array([.5, .5])
        result = calibrate_recent(actual, mass, lambda scale: np.full(2, scale), POLICY)
        self.assertEqual(result['scale'], 3.)
        self.assertEqual(result['status'], 'saturated_high')

    # preserve physical event ordering and full fallback when nested calls regress
    def test_weighted_nested_safety_reverts_every_head(self):
        actual = np.array([0., 0., 2.5, 2.5])
        raw = np.array([0., 0., 2.5, 2.5])
        scores = np.full((4, 3), .9)
        hours = np.array([0, 24, 48, 72], dtype=np.int64)
        mass = np.full(4, .25)
        rules = [{'threshold': threshold, 'cutoff': .8, 'reason': 'calibrated'} for threshold in (.1, 1., 2.5)]
        applied, fallback = checked_rules_recent(actual, raw, scores, hours, rules, mass, POLICY)
        self.assertTrue(fallback)
        self.assertTrue(all(rule['cutoff'] is None for rule in applied))
        self.assertTrue(all(rule['reason'] == 'nesting_safety_fallback' for rule in applied))

    # a head with insufficient positive support must retain raw event calls
    def test_weighted_event_rules_keep_support_fallback(self):
        actual = np.array([0., 3.])
        raw = np.array([0., 3.])
        scores = np.full((2, 3), .5)
        hours = np.array([0, 24], dtype=np.int64)
        mass = np.array([.5, .5])
        rules = ordinal_rules_recent(actual, raw, scores, hours, mass, POLICY)
        self.assertEqual(len(rules), 3)
        self.assertTrue(all(rule['cutoff'] is None for rule in rules))
        self.assertTrue(all(rule['reason'] == 'insufficient_calibration_support' for rule in rules))

    # verify 44 inherited plus five added gates with no historical outcomes
    def test_primary_gate_suite_requires_all_forty_nine(self):
        report, data, indices, flags = safe_recency_screen()
        before = copy.deepcopy(report)
        screen = candidate_screen(report, data, indices, flags)
        self.assertEqual(len(screen['gates']), 49)
        self.assertTrue(screen['passed'])
        self.assertEqual(report, before)
        report['events']['ordinalRecent']['1.0']['pod'] = .69
        self.assertFalse(candidate_screen(report, data, indices, flags)['gates']['heavySkillRetained'])

    # an incomplete season partition cannot satisfy the fixed 49-gate contract
    def test_missing_season_fails_closed(self):
        report, data, indices, flags = safe_recency_screen()
        report['bySeason'].pop('JJA')
        with self.assertRaises(ValueError):
            candidate_screen(report, data, indices, flags)

    # require every fixed original control to match the copied native report arrays
    def test_reference_controls_require_exact_prediction_identity(self):
        mapping = {name: name for name in ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'weightedContext')}
        mapping['ordinal90'] = 'ordinalContext'
        amounts = {name: np.array([.25], dtype=float) for name in mapping}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'inputs/context').mkdir(parents=True)
            previous = {'amount::' + old: np.array([.25], dtype=float) for old in mapping.values()}
            current = {'amount::' + name: np.array([.25], dtype=float) for name in mapping}
            np.savez(root / 'inputs/context/predictions.npz', indices=np.array([4]), **previous)
            np.savez(root / 'predictions.npz', indices=np.array([4]), **current)
            self.assertTrue(reference_parity(root, np.array([4]), amounts)['exactPredictions'])
            current['amount::ordinal90'] = np.array([.26])
            np.savez(root / 'predictions.npz', indices=np.array([4]), **current)
            with self.assertRaises(ValueError):
                reference_parity(root, np.array([4]), amounts)

    # native replay rejects the feature-set mapping before creating a DMatrix
    def test_native_refit_requires_exact_ninety_five_name_list(self):
        with self.assertRaisesRegex(ValueError, 'native recency feature names changed'):
            refit_models(None, None, None, {'full': ['x'] * 95}, None, None, None, '2025-09', None)


if __name__ == '__main__':
    unittest.main()
