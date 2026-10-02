"""lock fixed recent-date rain calibration using synthetic rows only."""

import inspect
import unittest

import numpy as np
from rain_recency_calibration import calibrate, calibrate_events, checked_rules, effective_support, recent_weights
from run_rain_sub24 import weights as balanced_weights
from rain_search import calibrate as uniform_calibrate


# exercise only synthetic earlier calibration arrays
class RainRecencyCalibrationTests(unittest.TestCase):
    # no helper accepts later evaluation outcomes or candidate scores
    def test_calibration_signatures_exclude_evaluation(self):
        self.assertEqual(tuple(inspect.signature(recent_weights).parameters), ('hours', 'stop'))
        self.assertEqual(tuple(inspect.signature(effective_support).parameters), ('actual', 'hours', 'weight'))
        self.assertEqual(tuple(inspect.signature(calibrate).parameters), ('actual', 'hours', 'projection', 'weight'))
        self.assertEqual(tuple(inspect.signature(calibrate_events).parameters), ('actual', 'raw', 'probabilities', 'hours', 'weight'))
        self.assertEqual(tuple(inspect.signature(checked_rules).parameters), ('actual', 'raw', 'probabilities', 'hours', 'rules', 'weight'))

    # a date thirty days older has exactly half the mass before normalization
    def test_thirty_day_half_life_and_duplicate_vintage_balance(self):
        stop = 60 * 24
        pair = recent_weights(np.array([29 * 24, 59 * 24]), stop)
        self.assertAlmostEqual(pair[0] / pair[1], .5)
        hours = np.array([29 * 24, 29 * 24, 29 * 24 + 1, 59 * 24])
        weighted = recent_weights(hours, stop)
        np.testing.assert_allclose(weighted, [1. / 12, 1. / 12, 1. / 6, 2. / 3])
        self.assertAlmostEqual(float(weighted.sum()), 1.)

    # inclusive oldest hour and exclusive stop preserve exactly ninety prior days
    def test_exact_window_bounds_and_invalid_weights(self):
        stop = 90 * 24
        self.assertEqual(len(recent_weights(np.array([0, stop - 1]), stop)), 2)
        # reject hours outside the fixed prior window or with invalid types
        for hours, cutoff in ((np.array([-1]), stop), (np.array([stop]), stop), (np.array([0]), stop + 1), (np.array([], dtype=int), stop), (np.array([1.]), stop)):
            with self.subTest(hours=hours, cutoff=cutoff), self.assertRaises(ValueError):
                recent_weights(hours, cutoff)
        # require strictly positive normalized date-hour-vintage mass
        for weight in (np.array([0., 1.]), np.array([np.nan, 1.]), np.array([.2, .2]), np.array([-.1, 1.1])):
            with self.subTest(weight=weight), self.assertRaises(ValueError):
                effective_support(np.array([.2, 0.]), np.array([0, 24]), weight)

    # Kish effective counts use date mass, not forecast rows or raw wet-day count
    def test_effective_date_and_wet_date_support(self):
        support = effective_support(np.array([.2, .2, .2, 0.]), np.array([0, 0, 24, 48]), np.array([.4, .4, .1, .1]))
        self.assertAlmostEqual(support['effectiveDates'], 1. / (.8 ** 2 + .1 ** 2 + .1 ** 2))
        self.assertAlmostEqual(support['effectiveWetDates'], 1. / ((.8 / .9) ** 2 + (.1 / .9) ** 2))
        dry = effective_support(np.zeros(2), np.array([0, 24]), np.array([.5, .5]))
        self.assertEqual(dry['effectiveWetDates'], 0.)

    # weighted bisection keeps the exact original scalar result and statuses
    def test_scalar_root_endpoints_saturation_and_uniform_parity(self):
        hours = np.array([0, 24], dtype=int)
        weight = np.array([.5, .5])
        base = np.ones(2)

        # use the same clipped final amount map for both scalar solvers
        def projection(scale):
            return np.clip(base * scale, 0, 30)

        # retain search-calibrator parity at exact roots and unit preference
        for target in (.5, 1., 2.):
            actual = np.full(2, target)
            result = calibrate(actual, hours, projection, weight)
            self.assertAlmostEqual(result['scale'], target)
            self.assertEqual(result, uniform_calibrate(actual, hours, projection))
        low = calibrate(np.zeros(2), hours, lambda scale: base * scale, weight)
        high = calibrate(np.full(2, 4.), hours, lambda scale: base * scale, weight)
        self.assertEqual((low['scale'], low['status']), (.1, 'saturated_low'))
        self.assertEqual((high['scale'], high['status']), (3., 'saturated_high'))
        # unequal recency weights must alter the target mean, not merely reporting
        recent = calibrate(np.array([0., 2.]), hours, lambda scale: base * scale, np.array([.25, .75]))
        self.assertAlmostEqual(recent['scale'], 1.5)

    # the fixed recall margin can change one cutoff when older evidence is downweighted
    def test_weighted_event_cutoff_and_missing_head_fallback(self):
        positive = np.array([0, 87 * 24, 87 * 24 + 1, 87 * 24 + 2, 88 * 24, 88 * 24 + 1, 88 * 24 + 2, 89 * 24, 89 * 24 + 1, 89 * 24 + 2])
        negative = np.array([1, 87 * 24 + 3, 88 * 24 + 3, 89 * 24 + 3])
        hours = np.r_[positive, negative]
        actual = np.r_[np.full(len(positive), .2), np.zeros(len(negative))]
        raw = np.zeros(len(hours))
        probability = np.full((len(hours), 3), np.nan)
        probability[:, 0] = 0.
        probability[0, 0] = .9
        probability[1:len(positive), 0] = .8
        recent = calibrate_events(actual, raw, probability, hours, recent_weights(hours, 90 * 24))
        uniform = calibrate_events(actual, raw, probability, hours, balanced_weights(hours))
        self.assertEqual(recent[0]['cutoff'], .8)
        self.assertEqual(uniform[0]['cutoff'], .9)
        self.assertEqual(recent[0]['reason'], 'calibrated')
        probability[:, 0] = np.nan
        fallback = calibrate_events(actual, raw, probability, hours, recent_weights(hours, 90 * 24))
        self.assertEqual(fallback[0]['reason'], 'missing_model_head')
        self.assertIsNone(fallback[0]['cutoff'])
        self.assertEqual(fallback[1]['reason'], 'insufficient_calibration_support')

    # a nonnested highest category cannot bypass the composite false-alarm gate
    def test_nested_safety_resets_all_cutoffs(self):
        actual = np.zeros(4)
        raw = np.zeros(4)
        hours = np.arange(4)
        probabilities = np.ones((4, 3))
        rules = [{'threshold': threshold, 'cutoff': .5, 'reason': 'calibrated'} for threshold in (.1, 1., 2.5)]
        checked, fallback = checked_rules(actual, raw, probabilities, hours, rules, np.full(4, .25))
        self.assertTrue(fallback)
        self.assertTrue(all(rule['cutoff'] is None and rule['reason'] == 'nesting_safety_fallback' for rule in checked))
        self.assertTrue(all(rule['cutoff'] == .5 for rule in rules))
        safe, fallback = checked_rules(actual, raw, probabilities, hours, [{**rule, 'cutoff': None} for rule in rules], np.full(4, .25))
        self.assertFalse(fallback)
        self.assertTrue(all(rule['cutoff'] is None for rule in safe))


# permit synthetic standalone verification without private research archives
if __name__ == '__main__':
    unittest.main()
