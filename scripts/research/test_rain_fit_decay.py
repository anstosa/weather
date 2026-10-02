"""lock all-history date-decayed ordinal fitting using synthetic rows."""

import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_fit_decay as decay


# emit deterministic model bytes without a historical native fit
class FakeBooster:
    # preserve one distinct synthetic head identity
    def __init__(self, number):
        self.number = number

    # make model SHA metadata verifiable without a native booster
    def save_model(self, path):
        Path(path).write_bytes(f'synthetic-model-{self.number}'.encode())


# validate only generated forecast features and observed fit labels
class RainFitDecayTests(unittest.TestCase):
    # a date 183 days older receives exactly half the per-date mass
    def test_half_life_and_duplicate_vintage_balance(self):
        stop = 184 * 24
        pair = decay.decayed_weights(np.array([0, 183 * 24]), stop)
        self.assertAlmostEqual(pair[0] / pair[1], .5)
        self.assertAlmostEqual(float(pair.sum()), 2.)
        hours = np.array([0, 0, 1, 183 * 24])
        weighted = decay.decayed_weights(hours, stop)
        np.testing.assert_allclose(weighted, [1. / 3, 1. / 3, 2. / 3, 8. / 3])
        self.assertAlmostEqual(float(weighted.sum()), len(hours))

    # no ninety-day rolling cutoff may silently discard mature older examples
    def test_no_rolling_window_and_future_hours_rejected(self):
        stop = 2100 * 24
        hours = np.array([0, stop - 1], dtype=np.int64)
        weighted = decay.decayed_weights(hours, stop)
        self.assertEqual(len(weighted), 2)
        self.assertTrue((weighted > 0).all())
        for values, cutoff in ((np.array([stop]), stop), (np.array([stop + 1]), stop), (np.array([0]), stop + 1), (np.array([1.]), stop), (np.array([], dtype=int), stop)):
            with self.subTest(values=values, cutoff=cutoff), self.assertRaises(ValueError):
                decay.decayed_weights(values, cutoff)

    # native objectives, gamma weight renormalization and frozen names stay exact
    def test_all_four_native_heads_and_gamma_weights(self):
        hours = np.arange(150, dtype=np.int64) // 5 * 24 + np.arange(150) % 5
        actual = np.tile([0., .2, 1.2, 3., .5], 30)
        x = np.zeros((len(actual), len(decay.FEATURE_NAMES)), dtype=np.float32)
        captured = []

        # collect real DMatrix labels and weights without actually growing trees
        def fake_train(parameters, matrix, num_boost_round):
            captured.append({'parameters': dict(parameters), 'labels': matrix.get_label().copy(), 'weights': matrix.get_weight().copy(), 'names': matrix.feature_names, 'rounds': num_boost_round})
            return FakeBooster(len(captured))

        with tempfile.TemporaryDirectory() as temporary, patch.object(decay.xgb, 'train', side_effect=fake_train):
            models, state = decay.fit(x, actual, hours, Path(temporary), decay.FEATURE_NAMES, 31 * 24)
            self.assertEqual(list(models), ['0.1', '1.0', '2.5', 'amount'])
            self.assertTrue(all(model is not None for model in models.values()))
            self.assertEqual([item['parameters']['objective'] for item in captured], ['binary:logistic'] * 3 + ['reg:gamma'])
            # all source rows remain in each binary fit with rowcount-normalized mass
            for item in captured[:3]:
                self.assertEqual(item['rounds'], 160)
                self.assertEqual(item['names'], list(decay.FEATURE_NAMES))
                self.assertNotIn('base_score', item['parameters'])
                self.assertAlmostEqual(float(item['weights'].sum()), len(actual), places=4)
                self.assertEqual(len(item['labels']), len(actual))
            gamma = captured[3]
            self.assertEqual(len(gamma['labels']), 120)
            self.assertTrue((gamma['labels'] >= .1 - 1e-6).all())
            self.assertAlmostEqual(float(gamma['weights'].sum()), 120, places=4)
            np.testing.assert_allclose(gamma['weights'], decay.decayed_weights(hours[actual >= .1], 31 * 24), rtol=1e-6)
            self.assertEqual(state['featureNames'], list(decay.FEATURE_NAMES))
            self.assertEqual(state['rounds'], 160)
            self.assertEqual(state['trainingRows'], 150)
            self.assertEqual(state['trainingMaximumActualHour'], int(hours.max()))
            self.assertEqual(state['trainingMaximumValidHourExclusive'], 31 * 24)
            self.assertEqual(state['trainingWeight']['halfLifeDays'], 183)
            self.assertGreater(state['trainingWeight']['effectiveDates'], 0)
            self.assertEqual(state['heads']['amount']['support']['positiveHours'], 120)
            # saved native head files and recorded hashes must match exactly
            for name in models:
                head = state['heads'][name]
                path = Path(temporary) / head['modelFile']
                self.assertEqual(head['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())

    # unsupported rare heads retain None and never manufacture model files
    def test_rare_head_fallback_and_schema_rejection(self):
        actual = np.full(20, .2)
        hours = np.arange(20, dtype=np.int64) // 5 * 24 + np.arange(20) % 5
        x = np.zeros((20, len(decay.FEATURE_NAMES)), dtype=np.float32)

        # the one supported wet head writes only its own synthetic model
        def fake_train(parameters, matrix, num_boost_round):
            self.assertEqual(parameters['objective'], 'binary:logistic')
            return FakeBooster(1)

        with tempfile.TemporaryDirectory() as temporary, patch.object(decay.xgb, 'train', side_effect=fake_train):
            models, state = decay.fit(x, actual, hours, Path(temporary), decay.FEATURE_NAMES, 5 * 24)
            self.assertIsNotNone(models['0.1'])
            self.assertTrue(all(models[name] is None for name in ('1.0', '2.5', 'amount')))
            self.assertEqual(state['heads']['amount']['reason'], 'insufficient_wet_support')
            self.assertEqual(sorted(path.name for path in Path(temporary).iterdir()), ['event-0.1.json'])
            with self.assertRaises(ValueError):
                decay.fit(x, actual, hours, Path(temporary), decay.FEATURE_NAMES[:-1], 5 * 24)
            with self.assertRaises(ValueError):
                decay.fit(x, actual, np.full(20, 5 * 24), Path(temporary), decay.FEATURE_NAMES, 5 * 24)


# keep all training tests independent of private research outcomes
if __name__ == '__main__':
    unittest.main()
