"""lock one probability-weighted ordinal amount calibration on synthetic data."""

import inspect
import json
import unittest
from unittest.mock import patch

import numpy as np
import rain_soft_ordinal_calibration as soft
from run_rain_sub24 import weights as balanced_weights


# provide every wet bin across three dates without outcome leakage
def supported_fit():
    actual, hours = [], []
    # vary bin-one occupancy while retaining the full date-hour population
    for date in range(3):
        for hour in range(10):
            stamp = date * 24 + hour
            for value in (0., 1.2, 4.):
                actual.append(value)
                hours.append(stamp)
            # preserve sparse later-date bin-one vintages
            if date == 0 or hour == 0:
                actual.append(.2 if date == 0 else .8)
                hours.append(stamp)
    return np.asarray(actual), np.asarray(hours, dtype=np.int64)


# keep the helper's numerical and causal contracts isolated from native fitting
class RainSoftOrdinalCalibrationTests(unittest.TestCase):
    # fit-bin means use full-population weights, not rebalanced bin weights
    def test_full_population_weighted_bin_means_and_support(self):
        actual, hours = supported_fit()
        state = soft.fit_bin_means(actual, hours)
        self.assertTrue(state['supported'])
        self.assertEqual(len(state['bins']), 4)
        self.assertEqual(state['bins'][1]['uniqueHours'], 12)
        self.assertEqual(state['bins'][1]['uniqueDates'], 3)
        selected = (actual >= .1) & (actual < 1.)
        full_weight = balanced_weights(hours)
        expected = full_weight[selected] @ actual[selected] / full_weight[selected].sum()
        rebalanced = balanced_weights(hours[selected]) @ actual[selected]
        self.assertAlmostEqual(state['means'][1], expected)
        self.assertGreater(abs(expected - rebalanced), .05)
        self.assertEqual(state['means'][0], 0.)
        self.assertAlmostEqual(state['means'][2], 1.2)
        self.assertAlmostEqual(state['means'][3], 4.)
        self.assertEqual(json.loads(json.dumps(state, allow_nan=False)), state)

    # exact physical thresholds enter the higher bin
    def test_thresholds_and_uncapped_fit_labels(self):
        actual = np.repeat([0., .1, 1., 2.5, 40.], 12)
        hours = np.tile(np.arange(12, dtype=np.int64) * 24, 5)
        state = soft.fit_bin_means(actual, hours)
        self.assertTrue(state['supported'])
        self.assertEqual([item['rows'] for item in state['bins']], [12, 12, 12, 24])
        self.assertEqual([item['upperMmExclusive'] for item in state['bins']], [.1, 1., 2.5, None])
        self.assertEqual(soft.BIN_LIMITS[1][1], np.nextafter(1., 0.))
        self.assertEqual(soft.BIN_LIMITS[2][1], np.nextafter(2.5, 0.))
        np.testing.assert_allclose(state['means'], [0., .1, 1., 21.25])

    # sparse wet-bin support forces a whole-month fallback by the runner
    def test_missing_wet_bin_is_explicitly_unsupported(self):
        actual, hours = supported_fit()
        actual[actual >= 2.5] = 0.
        state = soft.fit_bin_means(actual, hours)
        self.assertFalse(state['supported'])
        self.assertIsNone(state['means'])
        self.assertEqual(state['bins'][3]['uniqueHours'], 0)
        self.assertIsNone(state['bins'][3]['mean'])

    # cumulative projection and common odds shift preserve a valid distribution
    def test_nested_masses_and_probability_boundaries(self):
        probabilities = np.array([[.2, .8, .3], [0., 1., 1.], [1., 0., 0.]])
        for offset in (-1.5, 0., 1.5):
            masses = soft.bin_probabilities(probabilities, offset)
            self.assertTrue(np.isfinite(masses).all())
            self.assertTrue((masses >= 0).all())
            np.testing.assert_allclose(masses.sum(axis=1), 1., atol=1e-15)
            self.assertAlmostEqual(masses[0, 1], 0.)
            self.assertAlmostEqual(masses[1, 2], 0.)
            self.assertLess(masses[1, 3], 5e-6)
            self.assertAlmostEqual(masses[2, 2], 0.)
            self.assertLess(masses[2, 3], 5e-6)

    # select one categorical proper-score optimum from the frozen grid
    def test_calibration_grid_and_json_audit(self):
        actual = np.zeros(12)
        hours = np.arange(12, dtype=np.int64) * 24
        probabilities = np.tile([.5, .25, .125], (12, 1))
        state = soft.calibrate(actual, hours, probabilities)
        self.assertEqual(state['contractVersion'], soft.CONTRACT)
        self.assertEqual(state['selectedOffset'], -1.5)
        self.assertEqual(state['gridOffsets'], list(soft.GRID_OFFSETS))
        self.assertEqual(len(state['gridScores']), 61)
        self.assertEqual(state['selectedScore'], min(state['gridScores']))
        self.assertEqual(state['calibrationRows'], 12)
        self.assertEqual(state['calibrationDates'], 12)
        self.assertEqual(json.loads(json.dumps(state, allow_nan=False)), state)

    # exact score ties prefer smallest absolute shift and then smaller shift
    def test_calibration_tie_breaks(self):
        actual = np.zeros(3)
        hours = np.array([0, 24, 48], dtype=np.int64)
        probability = np.full((3, 3), .5)
        constant = np.full((3, 4), .25)
        with patch.object(soft, 'bin_probabilities', return_value=constant):
            state = soft.calibrate(actual, hours, probability)
        self.assertEqual(state['selectedOffset'], 0.)

        # make adjacent equal-distance offsets strictly better than all others
        def masses(_, offset):
            first = .8 if abs(offset) == .05 else .5
            return np.tile([first, (1. - first) / 3, (1. - first) / 3, (1. - first) / 3], (3, 1))

        with patch.object(soft, 'bin_probabilities', side_effect=masses):
            state = soft.calibrate(actual, hours, probability)
        self.assertEqual(state['selectedOffset'], -.05)

    # soft expected amount does not impose a wet-category minimum
    def test_predict_is_label_free_and_has_no_hard_floor(self):
        self.assertEqual(tuple(inspect.signature(soft.predict).parameters), ('probabilities', 'means', 'state'))
        actual = np.array([0., .2, 1.2, 4.])
        hours = np.arange(4, dtype=np.int64) * 24
        state = soft.calibrate(actual, hours, np.tile([.2, .1, .05], (4, 1)))
        prediction = soft.predict(np.array([[.02, .01, .005]]), [0., .2, 1.2, 3.], state)
        self.assertEqual(prediction.dtype, np.float64)
        self.assertEqual(prediction.shape, (1,))
        self.assertGreater(prediction[0], 0.)
        self.assertLess(prediction[0], .1)
        expected = soft.bin_probabilities(np.array([[.02, .01, .005]]), state['selectedOffset']) @ np.array([0., .2, 1.2, 3.])
        np.testing.assert_allclose(prediction, expected)

    # reject invalid labels, hours, probabilities and frozen states
    def test_invalid_inputs_fail_closed(self):
        actual, hours = supported_fit()
        bad_actual = actual.copy()
        bad_actual[0] = np.nan
        with self.assertRaises(ValueError):
            soft.fit_bin_means(bad_actual, hours)
        with self.assertRaises(ValueError):
            soft.fit_bin_means(actual, hours.astype(float))
        with self.assertRaises(ValueError):
            soft.fit_bin_means(np.array([-1.]), np.array([0]))
        with self.assertRaises(ValueError):
            soft.fit_bin_means(np.array(['1.']), np.array([0]))
        with self.assertRaises(ValueError):
            soft.calibrate(np.array([0.]), np.array([0]), np.array([[np.nan, .2, .1]]))
        with self.assertRaises(ValueError):
            soft.calibrate(np.array([0.]), np.array([0]), np.array([[1.1, .2, .1]]))
        with self.assertRaises(ValueError):
            soft.calibrate(np.array([0.]), np.array([0]), np.empty((0, 3)))
        with self.assertRaises(ValueError):
            soft.calibrate(np.array([0.]), np.array([0]), np.array([[.2, .1]]))
        with self.assertRaises(ValueError):
            soft.bin_probabilities(np.array([[.2, .1, .05]]), .025)
        state = soft.calibrate(np.array([0.]), np.array([0]), np.array([[.2, .1, .05]]))
        with self.assertRaises(ValueError):
            soft.predict(np.array([[.2, .1, .05]]), [0., .2, 1.2, np.nan], state)
        with self.assertRaises(ValueError):
            soft.predict(np.array([[.2, .1, .05]]), [0., .2, 1.2, 3.], {**state, 'contractVersion': 'wrong'})


if __name__ == '__main__':
    unittest.main()
