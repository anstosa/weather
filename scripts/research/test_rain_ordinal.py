"""lock ordinal rain heads, causal calibration and amount bands on synthetic data."""

import hashlib
import inspect
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from rain_ordinal import THRESHOLDS, calibrate_events, event_categories, fit_models, predict, project_amount
from rain_sub24 import FEATURE_NAMES, POLICY


# use only generated hours, features and labels
class RainOrdinalTests(unittest.TestCase):
    # calibration signatures cannot accept development evaluation labels
    def test_calibration_boundary_has_no_evaluation_input(self):
        self.assertEqual(tuple(inspect.signature(calibrate_events).parameters), ('actual', 'raw', 'probabilities', 'hours'))
        self.assertEqual(tuple(inspect.signature(event_categories).parameters), ('raw', 'probabilities', 'rules'))
        self.assertEqual(tuple(inspect.signature(project_amount).parameters), ('base', 'categories', 'scale'))

    # rare events and unavailable heads retain raw threshold calls
    def test_rare_threshold_and_missing_head_fall_back_to_raw(self):
        hours = np.r_[np.arange(12), np.arange(24, 36)]
        actual = np.where(hours % 24 < 6, .2, 0.)
        raw = np.where(hours < 3, 3., 0.)
        probabilities = np.full((24, 3), np.nan)
        rules = calibrate_events(actual, raw, probabilities, hours)
        self.assertEqual([rule['reason'] for rule in rules], ['missing_model_head', 'insufficient_calibration_support', 'insufficient_calibration_support'])
        self.assertTrue(all(rule['cutoff'] is None for rule in rules))
        np.testing.assert_array_equal(event_categories(raw, probabilities, rules), np.where(raw >= 2.5, 3, 0))

    # duplicated vintages and tied positive scores must select one balanced cutoff
    def test_weighted_recall_selects_largest_tied_cutoff(self):
        positive_hours = np.r_[np.arange(10), np.arange(24, 34)]
        negative_hours = np.r_[np.arange(10, 20), np.arange(34, 44)]
        hours = np.r_[positive_hours, negative_hours, 0]
        actual = np.r_[np.full(20, .2), np.zeros(20), .2]
        raw = np.zeros(len(hours))
        raw[[0, 1, -1]] = .2
        probability = np.full((len(hours), 3), np.nan)
        probability[:, 0] = 0.
        probability[[0, -1], 0] = .9
        probability[[1, 2], 0] = .8
        rules = calibrate_events(actual, raw, probability, hours)
        self.assertEqual(rules[0]['reason'], 'calibrated')
        self.assertEqual(rules[0]['cutoff'], .8)
        self.assertAlmostEqual(rules[0]['raw']['pod'], .1)
        self.assertAlmostEqual(rules[0]['targetRecall'], .15)
        self.assertAlmostEqual(rules[0]['candidate']['pod'], .15)

    # a recall gain cannot override false-alarm or skill regressions
    def test_calibration_rejects_unsafe_cutoff(self):
        hours = np.arange(48, dtype=np.int64)
        actual = np.where(hours % 2 == 0, .2, 0.)
        raw = actual.copy()
        probability = np.full((len(hours), 3), np.nan)
        probability[:, 0] = 1.
        rule = calibrate_events(actual, raw, probability, hours)[0]
        self.assertIsNone(rule['cutoff'])
        self.assertEqual(rule['reason'], 'calibration_safety_regression')
        self.assertGreater(rule['candidate']['far'], rule['raw']['far'] + .05)

    # independently calibrated heads need not be monotone in probability
    def test_highest_called_category_enforces_nesting(self):
        raw = np.array([0., 0., 0., 3.])
        probability = np.array([[.1, .1, .9], [.9, .1, .1], [.1, .9, .1], [.1, .1, .1]])
        rules = [{'threshold': threshold, 'cutoff': .5} for threshold in THRESHOLDS]
        np.testing.assert_array_equal(event_categories(raw, probability, rules), [3, 1, 2, 0])
        rules[2]['cutoff'] = None
        np.testing.assert_array_equal(event_categories(raw, probability, rules), [0, 1, 2, 3])

    # dry zero and open upper category bounds remain exact after scaling
    def test_projection_uses_disjoint_physical_bands(self):
        base = np.array([30., 0., 30., 0., 30., 0., 30.])
        category = np.array([0, 1, 1, 2, 2, 3, 3])
        projected = project_amount(base, category, 3.)
        np.testing.assert_array_equal(projected, [0., .1, np.nextafter(1., 0.), 1., np.nextafter(2.5, 0.), 2.5, 30.])
        self.assertEqual(projected.dtype, np.float64)

    # malformed inputs cannot be hidden by clipping or fallback
    def test_invalid_arrays_are_rejected(self):
        with self.assertRaises(ValueError):
            project_amount(np.array([np.nan]), np.array([0]), 1.)
        with self.assertRaises(ValueError):
            project_amount(np.array([1.]), np.array([4]), 1.)
        with self.assertRaises(ValueError):
            calibrate_events(np.array([.2]), np.array([0.]), np.ones((1, 2)), np.array([0]))
        with self.assertRaises(ValueError):
            event_categories(np.array([0.]), np.ones((1, 3)) * np.nan, [{'threshold': .1, 'cutoff': .5}, {'threshold': 1., 'cutoff': None}, {'threshold': 2.5, 'cutoff': None}])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(ValueError, 'automatic base scores'):
            fit_models(np.zeros((1, len(FEATURE_NAMES))), np.array([.2]), np.array([0]), Path(temporary), {'base_score': 0}, 2)

    # native objectives, feature schema, round count and hashes are persisted
    def test_native_heads_and_missing_models(self):
        hours = np.arange(150, dtype=np.int64) // 6 * 24 + np.arange(150) % 6
        actual = np.tile([0., .2, 1.2, 3., .5], 30)
        x = np.zeros((len(actual), len(FEATURE_NAMES)), dtype=np.float32)
        x[:, FEATURE_NAMES.index('rawRain')] = actual
        parameters = {**POLICY['treeParameters'], 'seed': 20260913}
        with tempfile.TemporaryDirectory() as temporary:
            models, state = fit_models(x, actual, hours, Path(temporary), parameters, 2)
            self.assertEqual(list(models), ['0.1', '1.0', '2.5', 'amount'])
            self.assertTrue(all(model is not None for model in models.values()))
            self.assertEqual(state['heads']['amount']['support']['positiveHours'], 120)
            # load each saved native config rather than trusting labels alone
            for name, expected in (('0.1', 'binary:logistic'), ('1.0', 'binary:logistic'), ('2.5', 'binary:logistic'), ('amount', 'reg:gamma')):
                head = state['heads'][name]
                model = models[name]
                self.assertEqual(json.loads(model.save_config())['learner']['objective']['name'], expected)
                self.assertEqual(model.num_boosted_rounds(), 2)
                self.assertEqual(model.feature_names, list(FEATURE_NAMES))
                self.assertEqual(head['sha256'], hashlib.sha256((Path(temporary) / head['modelFile']).read_bytes()).hexdigest())
            probabilities, amount = predict(models, x[:4])
            self.assertEqual(probabilities.shape, (4, 3))
            self.assertTrue(np.isfinite(probabilities).all())
            self.assertTrue(((probabilities >= 0) & (probabilities <= 1)).all())
            self.assertTrue(((amount >= .1) & (amount <= 30)).all())

            # support floors omit only unavailable heads and mark their predictions
            limited_actual = np.full(20, .2)
            limited_hours = np.arange(20) // 5 * 24 + np.arange(20) % 5
            limited_models, limited_state = fit_models(x[:20], limited_actual, limited_hours, Path(temporary) / 'limited', parameters, 2)
            self.assertIsNotNone(limited_models['0.1'])
            self.assertIsNone(limited_models['1.0'])
            self.assertIsNone(limited_models['2.5'])
            self.assertIsNone(limited_models['amount'])
            self.assertEqual(limited_state['heads']['amount']['reason'], 'insufficient_wet_support')
            limited_probabilities, limited_amount = predict(limited_models, x[:3])
            self.assertTrue(np.isfinite(limited_probabilities[:, 0]).all())
            self.assertTrue(np.isnan(limited_probabilities[:, 1:]).all())
            self.assertTrue(np.isnan(limited_amount).all())


# keep the native test runnable without private archives
if __name__ == '__main__':
    unittest.main()
