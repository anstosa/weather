"""synthetic checks for independent hurdle selection and category scaling."""

import copy
import unittest

import numpy as np
from verify_rain_hurdle import calibrate_hurdle, predict_hurdle, select_wet_rule
from verify_rain_search import ordinal_categories


# preserve fixed heavy rules while varying only the wet cutoff
def rules(wet=None, heavy=None):
    return [
        {'threshold': .1, 'head': '0.1', 'cutoff': wet, 'reason': 'uniform'},
        {'threshold': 1., 'head': '1.0', 'cutoff': heavy, 'reason': 'uniform'},
        {'threshold': 2.5, 'head': '2.5', 'cutoff': None, 'reason': 'uniform'},
    ]


class HurdleIndependentVerificationTests(unittest.TestCase):
    # optimize CSI after high categories are resolved, not the wet head alone
    def test_nested_csi_cutoff_preserves_heavy_rules(self):
        actual = np.r_[np.full(10, 1.2), np.full(10, .2), np.zeros(20)]
        hours = np.arange(40, dtype=np.int64) * 24
        raw = np.zeros(40)
        raw[:10] = .2
        raw[20:30] = .2
        scores = np.zeros((40, 3))
        scores[:10, 0] = .1
        scores[10:20, 0] = .9
        scores[20:25, 0] = .9
        scores[25:, 0] = .1
        scores[:10, 1] = .9
        uniform = rules(heavy=.5)
        before = copy.deepcopy(uniform)
        selected, record = select_wet_rule(actual, hours, raw, scores, uniform)
        self.assertEqual(selected[0]['cutoff'], .9)
        self.assertEqual(selected[1:], uniform[1:])
        self.assertEqual(uniform, before)
        self.assertEqual(record['reason'], 'optimized_nested_csi')
        self.assertAlmostEqual(record['selectedMetrics']['csi'], .8)
        np.testing.assert_array_equal(ordinal_categories(raw, scores, selected) >= 2, ordinal_categories(raw, scores, uniform) >= 2)

    # exact CSI ties prefer the larger physical wet-score cutoff
    def test_csi_tie_uses_highest_cutoff(self):
        actual = np.r_[np.full(10, 1.2), np.zeros(10)]
        hours = np.arange(20, dtype=np.int64) * 24
        raw = np.zeros(20)
        scores = np.zeros((20, 3))
        scores[:5, 0] = .1
        scores[5:10, 0] = .9
        scores[:10, 1] = .9
        selected, record = select_wet_rule(actual, hours, raw, scores, rules(heavy=.5))
        self.assertEqual(selected[0]['cutoff'], .9)
        self.assertEqual(record['selectedMetrics']['csi'], 1.)

    # unsupported positive observations retain the exact original wet rule
    def test_missing_or_rare_wet_head_is_explicit_fallback(self):
        hours = np.arange(20, dtype=np.int64) * 24
        raw = np.r_[np.full(10, .2), np.zeros(10)]
        scores = np.full((20, 3), np.nan)
        uniform = rules()
        rare, rare_record = select_wet_rule(np.r_[np.full(9, .2), np.zeros(11)], hours, raw, scores, uniform)
        self.assertEqual(rare, uniform)
        self.assertEqual(rare_record['reason'], 'insufficient_wet_support')
        missing, record = select_wet_rule(raw, hours, raw, scores, uniform)
        self.assertEqual(missing, uniform)
        self.assertEqual(record['reason'], 'missing_wet_head')

    # supported category calibration includes dry labels in its weighted target
    def test_category_scalar_includes_observed_dry_rows(self):
        actual = np.r_[np.full(25, .2), np.zeros(5)]
        hours = np.arange(30, dtype=np.int64) * 24
        raw = np.full(30, .2)
        scores = np.full((30, 3), np.nan)
        scores[:, 0] = .9
        base = np.full(30, .5)
        state = calibrate_hurdle(actual, hours, raw, scores, base, rules(wet=.5), 90 * 24)
        category = state['categories']['1']
        self.assertTrue(category['supported'])
        self.assertEqual(category['support']['observedDryRows'], 5)
        self.assertLess(category['scale'], .4)
        self.assertEqual(state['categories']['2']['scale'], state['globalCalibration']['scale'])
        self.assertEqual(state['rules'][1:], state['uniformRules'][1:])

    # clipped projection preserves exact dry zero and all three amount bands
    def test_prediction_stays_in_category_bands(self):
        actual = np.array([0., .2, 1.2, 3.])
        hours = np.array([0, 24, 48, 72], dtype=np.int64)
        raw = actual.copy()
        scores = np.full((4, 3), np.nan)
        base = np.ones(4)
        state = calibrate_hurdle(actual, hours, raw, scores, base, rules(), 90 * 24)
        predicted = predict_hurdle(raw, scores, base, state)
        self.assertEqual(predicted[0], 0.)
        self.assertTrue(.1 <= predicted[1] < 1.)
        self.assertTrue(1. <= predicted[2] < 2.5)
        self.assertTrue(2.5 <= predicted[3] <= 30.)
        np.testing.assert_array_equal(predicted >= 1., raw >= 1.)
        np.testing.assert_array_equal(predicted >= 2.5, raw >= 2.5)


if __name__ == '__main__':
    unittest.main()
