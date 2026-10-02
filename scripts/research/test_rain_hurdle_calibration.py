"""lock nested wet CSI and per-category recent amounts on synthetic rows."""

import inspect
import json
import unittest

import numpy as np
import rain_ordinal as ordinal
import rain_recency_calibration as recent
from rain_hurdle_calibration import calibrate, predict


# retain exact legacy high-event rules in every synthetic hypothesis
def rules(wet_cutoff=None, heavy_cutoff=None):
    return [
        {'threshold': .1, 'head': '0.1', 'cutoff': wet_cutoff, 'reason': 'uniform'},
        {'threshold': 1., 'head': '1.0', 'cutoff': heavy_cutoff, 'reason': 'uniform'},
        {'threshold': 2.5, 'head': '2.5', 'cutoff': None, 'reason': 'uniform'},
    ]


# only the earlier calibration call may accept observed labels
class RainHurdleCalibrationTests(unittest.TestCase):
    # prediction has no outcome or valid-hour argument
    def test_causal_boundary(self):
        self.assertEqual(tuple(inspect.signature(calibrate).parameters), ('actual', 'hours', 'raw', 'probabilities', 'base', 'uniform_rules', 'stop'))
        self.assertEqual(tuple(inspect.signature(predict).parameters), ('raw', 'probabilities', 'base', 'state'))

    # the optimum must score final nested wet calls rather than isolated low-head calls
    def test_nested_csi_selection_and_heavy_rule_identity(self):
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
        base = np.ones(40)
        legacy = rules(heavy_cutoff=.5)
        state = calibrate(actual, hours, raw, scores, base, legacy, 90 * 24)
        self.assertEqual(json.loads(json.dumps(state, allow_nan=False))['contractVersion'], state['contractVersion'])
        self.assertEqual(state['rules'][0]['cutoff'], .9)
        self.assertEqual(state['wetSelection']['reason'], 'optimized_nested_csi')
        self.assertEqual(state['rules'][1:], legacy[1:])
        self.assertAlmostEqual(state['wetSelection']['selectedMetrics']['csi'], .8)
        current_categories = ordinal.event_categories(raw, scores, state['rules'])
        old_heavy_categories = ordinal.event_categories(raw, scores, legacy)
        np.testing.assert_array_equal(current_categories >= 2, old_heavy_categories >= 2)
        np.testing.assert_array_equal(current_categories >= 3, old_heavy_categories >= 3)
        output = predict(raw, scores, base, state)
        self.assertEqual(output.dtype, np.float64)
        self.assertTrue(np.isfinite(output).all())
        self.assertTrue((output >= 0).all())

    # identical final nested event scores select the numerically highest cutoff
    def test_highest_cutoff_breaks_csi_ties(self):
        actual = np.r_[np.full(10, 1.2), np.zeros(10)]
        hours = np.arange(20, dtype=np.int64) * 24
        raw = np.zeros(20)
        scores = np.zeros((20, 3))
        scores[:5, 0] = .1
        scores[5:10, 0] = .9
        scores[:10, 1] = .9
        state = calibrate(actual, hours, raw, scores, np.ones(20), rules(heavy_cutoff=.5), 90 * 24)
        self.assertEqual(state['rules'][0]['cutoff'], .9)
        self.assertEqual(state['wetSelection']['selectedMetrics']['csi'], 1.)

    # rare, missing and infeasible wet heads explicitly preserve the old cutoff
    def test_old_wet_rule_fallback_reasons(self):
        hours = np.arange(20, dtype=np.int64) * 24
        raw = np.r_[np.full(10, .2), np.zeros(10)]
        actual = raw.copy()
        scores = np.full((20, 3), np.nan)
        legacy = rules(wet_cutoff=None)
        rare = calibrate(np.r_[np.full(9, .2), np.zeros(11)], hours, raw, scores, np.ones(20), legacy, 90 * 24)
        self.assertEqual(rare['wetSelection']['reason'], 'insufficient_wet_support')
        self.assertEqual(rare['rules'], legacy)
        missing = calibrate(actual, hours, raw, scores, np.ones(20), legacy, 90 * 24)
        self.assertEqual(missing['wetSelection']['reason'], 'missing_wet_head')
        self.assertEqual(missing['rules'], legacy)
        scores[:, 0] = .9
        infeasible = calibrate(actual, hours, raw, scores, np.ones(20), legacy, 90 * 24)
        self.assertEqual(infeasible['wetSelection']['reason'], 'no_feasible_new_cutoff')
        self.assertEqual(infeasible['rules'][0]['cutoff'], None)

    # supported category scalar includes its observed dry labels in the mean
    def test_category_recent_scalar_includes_dry_labels(self):
        actual = np.r_[np.full(25, .2), np.zeros(5)]
        hours = np.arange(30, dtype=np.int64) * 24
        raw = np.full(30, .2)
        scores = np.full((30, 3), np.nan)
        scores[:, 0] = .9
        base = np.full(30, .5)
        state = calibrate(actual, hours, raw, scores, base, rules(wet_cutoff=.5), 90 * 24)
        category = state['categories']['1']
        self.assertTrue(category['supported'])
        self.assertEqual(category['support']['observedWetHours'], 25)
        self.assertEqual(category['support']['observedDryRows'], 5)
        weight = recent.recent_weights(hours, 90 * 24)
        expected = float(weight @ actual) / .5
        self.assertAlmostEqual(category['scale'], expected)
        self.assertLess(category['scale'], .4)
        self.assertEqual(state['categories']['2']['scale'], state['globalCalibration']['scale'])

    # category saturation remains explicit and prediction stays inside its band
    def test_final_category_bound_and_saturation(self):
        actual = np.full(25, 2.)
        hours = np.arange(25, dtype=np.int64) * 24
        raw = np.full(25, .2)
        scores = np.full((25, 3), np.nan)
        scores[:, 0] = .9
        base = np.full(25, .1)
        state = calibrate(actual, hours, raw, scores, base, rules(wet_cutoff=.5), 90 * 24)
        self.assertEqual(state['categories']['1']['calibration']['status'], 'saturated_high')
        self.assertEqual(state['categories']['1']['scale'], 3.)
        output = predict(raw, scores, base, state)
        self.assertTrue(((output >= .1) & (output < 1.)).all())
        self.assertAlmostEqual(float(output.mean()), .3)

    # malformed labels, head scores and frozen state cannot be masked by clipping
    def test_invalid_calibration_and_prediction_inputs(self):
        actual = np.array([.2, 0.])
        hours = np.array([0, 24])
        raw = np.array([.2, 0.])
        scores = np.full((2, 3), np.nan)
        scores[:, 0] = .9
        base = np.ones(2)
        with self.assertRaises(ValueError):
            calibrate(actual, hours, raw, np.array([[.9, np.nan, np.nan], [np.nan, np.nan, np.nan]]), base, rules(), 90 * 24)
        with self.assertRaises(ValueError):
            calibrate(actual, hours, raw, scores, np.array([np.nan, 1.]), rules(), 90 * 24)
        state = calibrate(actual, hours, raw, scores, base, rules(), 90 * 24)
        state['categories']['1']['scale'] = 4.
        with self.assertRaises(ValueError):
            predict(raw, scores, base, state)
        with self.assertRaises(ValueError):
            predict(raw, scores[:, :2], base, state)


# run synthetic tests without a private research archive
if __name__ == '__main__':
    unittest.main()
