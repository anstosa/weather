"""lock chronological inner capacity selection on synthetic fit rows only."""

import hashlib
import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import xgboost as xgb
import rain_nested_capacity as nested


# write one identifiable fake booster without growing native trees
class FakeBooster:
    # retain the fixed synthetic call order for model hashes
    def __init__(self, number):
        self.number = number

    # allow inner and final saved-model identity checks
    def save_model(self, path):
        Path(path).write_bytes(f'nested-{self.number}'.encode())


# construct complete repeated wet and heavy events on consecutive dates
def population(first_date, dates):
    hours = first_date * 24 + np.arange(dates * 5, dtype=np.int64) // 5 * 24 + np.arange(dates * 5) % 5
    actual = np.tile([0., .2, 1.2, 3., .5], dates)
    return hours, actual


# synthetic-only tests never request earlier private candidate outcomes
class RainNestedCapacityTests(unittest.TestCase):
    # the outer fit cutoff excludes inner validation's seven-day embargo
    def test_inner_split_boundaries_and_no_evaluation_argument(self):
        stop = 200 * 24
        start = stop - 120 * 24
        train_end = start - 7 * 24
        hours = np.array([train_end - 1, train_end, start - 1, start, stop - 1])
        fit, validation, bounds = nested.inner_masks(hours, stop)
        np.testing.assert_array_equal(fit, [True, False, False, False, False])
        np.testing.assert_array_equal(validation, [False, False, False, True, True])
        self.assertEqual(bounds['innerEmbargoHours'], 168)
        self.assertEqual(bounds['innerValidationStartHour'], start)
        self.assertEqual(tuple(inspect.signature(nested.fit).parameters), ('x', 'actual', 'hours', 'directory', 'names', 'stop'))
        with self.assertRaises(ValueError):
            nested.inner_masks(np.array([stop]), stop)
        with self.assertRaises(ValueError):
            nested.inner_masks(hours, stop + 1)

    # equal minimal losses select the earliest one-based tree count
    def test_earliest_exact_minimum_and_invalid_histories(self):
        loss = np.ones(320)
        loss[12] = .5
        loss[19] = .5
        self.assertEqual(nested.earliest_minimum(loss), 13)
        for invalid in (loss[:-1], np.where(np.arange(320) == 0, np.nan, loss)):
            with self.subTest(invalid=invalid.shape), self.assertRaises(ValueError):
                nested.earliest_minimum(invalid)

    # inner support gates differ only by the prespecified validation floor
    def test_head_support_boundaries(self):
        self.assertTrue(nested._supported({'positiveHours': 10, 'positiveDates': 3}, 'binary:logistic'))
        self.assertFalse(nested._supported({'positiveHours': 10, 'positiveDates': 4}, 'binary:logistic', validation=True))
        self.assertTrue(nested._supported({'positiveHours': 10, 'positiveDates': 5}, 'binary:logistic', validation=True))
        self.assertTrue(nested._supported({'positiveHours': 100, 'positiveDates': 20}, 'reg:gamma'))
        self.assertFalse(nested._supported({'positiveHours': 19, 'positiveDates': 5}, 'reg:gamma', validation=True))
        self.assertTrue(nested._supported({'positiveHours': 20, 'positiveDates': 5}, 'reg:gamma', validation=True))

    # insufficient inner training refits all outer rows at exactly 160 rounds
    def test_inner_support_fallback_keeps_outer_fit_rows(self):
        stop = 200 * 24
        hours, actual = population(150, 30)
        x = np.zeros((len(actual), len(nested.decay.FEATURE_NAMES)), dtype=np.float32)
        calls = []

        # capture final native row and weight totals without an inner booster
        def fake_train(parameters, matrix, num_boost_round, **kwargs):
            calls.append((parameters['objective'], matrix.num_row(), float(matrix.get_weight().sum()), num_boost_round, kwargs))
            return FakeBooster(len(calls))

        with tempfile.TemporaryDirectory() as temporary, patch.object(nested.xgb, 'train', side_effect=fake_train):
            models, state = nested.fit(x, actual, hours, Path(temporary), nested.decay.FEATURE_NAMES, stop)
            self.assertTrue(all(model is not None for model in models.values()))
            self.assertEqual(len(calls), 4)
            self.assertEqual([call[3] for call in calls], [160] * 4)
            self.assertEqual([call[1] for call in calls], [150, 150, 150, 120])
            self.assertAlmostEqual(calls[-1][2], 120, places=4)
            self.assertTrue(all(head['selectionReason'] == 'insufficient_inner_training_support' for head in state['heads'].values()))
            self.assertTrue(all(head['innerModelFile'] is None for head in state['heads'].values()))

    # supported inner histories select one round and refit the entire outer fit
    def test_inner_history_then_outer_refit_with_selected_round(self):
        early_hours, early_actual = population(0, 30)
        recent_hours, recent_actual = population(140, 30)
        hours = np.r_[early_hours, recent_hours]
        actual = np.r_[early_actual, recent_actual]
        x = np.zeros((len(actual), len(nested.decay.FEATURE_NAMES)), dtype=np.float32)
        calls = []

        # fill one complete pinned native metric history per inner fit
        def fake_train(parameters, matrix, num_boost_round, **kwargs):
            calls.append((parameters['objective'], matrix.num_row(), num_boost_round, kwargs))
            # only inner fits pass native weighted validation metadata
            if 'evals_result' in kwargs:
                history = np.ones(320)
                history[12] = .1
                history[19] = .1
                metric = 'gamma-deviance' if parameters['objective'] == 'reg:gamma' else 'logloss'
                self.assertEqual(parameters['eval_metric'], metric)
                kwargs['evals_result']['validation'] = {metric: list(history)}
                self.assertEqual(num_boost_round, 320)
                self.assertNotIn('custom_metric', kwargs)
            else:
                self.assertEqual(num_boost_round, 13)
                self.assertNotIn('eval_metric', parameters)
            return FakeBooster(len(calls))

        with tempfile.TemporaryDirectory() as temporary, patch.object(nested.xgb, 'train', side_effect=fake_train):
            models, state = nested.fit(x, actual, hours, Path(temporary), nested.decay.FEATURE_NAMES, 200 * 24)
            self.assertTrue(all(model is not None for model in models.values()))
            self.assertEqual(len(calls), 8)
            self.assertEqual([call[2] for call in calls], [320, 13] * 4)
            self.assertEqual(state['innerTrainingRows'], 150)
            self.assertEqual(state['innerValidationRows'], 150)
            self.assertEqual(state['trainingRows'], 300)
            self.assertIsNone(state['rounds'])
            self.assertEqual(state['selectionMaximumRounds'], 320)
            self.assertEqual(state['fallbackRounds'], 160)
            # record full inner and final model identity for every objective
            for head in state['heads'].values():
                self.assertEqual(head['selectedRound'], 13)
                self.assertEqual(len(head['validationLossByRound']), 320)
                self.assertEqual(head['validationMetric'], 'gamma-deviance' if head['objective'] == 'reg:gamma' else 'logloss')
                self.assertEqual(head['selectionReason'], 'earliest_minimum_inner_validation')
                self.assertEqual(head['sha256'], hashlib.sha256((Path(temporary) / head['modelFile']).read_bytes()).hexdigest())
                self.assertEqual(head['innerSha256'], hashlib.sha256((Path(temporary) / head['innerModelFile']).read_bytes()).hexdigest())

    # native two-round selection must preserve weighted metrics and model replay
    def test_native_weighted_metric_histories(self):
        width = len(nested.decay.FEATURE_NAMES)
        train_hours = np.array([0, 24, 24, 48, 72, 72, 96, 120], dtype=np.int64)
        validation_hours = np.array([264, 264, 288, 312, 336, 336], dtype=np.int64)
        train_x = np.zeros((len(train_hours), width), dtype=np.float32)
        validation_x = np.zeros((len(validation_hours), width), dtype=np.float32)
        train_x[:, 0] = np.arange(len(train_hours), dtype=np.float32)
        validation_x[:, 0] = np.arange(len(validation_hours), dtype=np.float32)
        cases = (
            ('binary:logistic', np.array([0., 1., 0., 1., 0., 1., 0., 1.]), np.array([0., 1., 0., 1., 0., 1.]), 'logloss'),
            ('reg:gamma', np.array([.2, 1., .5, 2., .3, 3., .7, 1.5]), np.array([.2, 1., .5, 2., .3, 3.]), 'gamma-deviance'),
        )
        with tempfile.TemporaryDirectory() as temporary, patch.object(nested, 'MAXIMUM_ROUNDS', 2):
            # test both native objectives through the production inner helper
            for objective, train_labels, validation_labels, metric in cases:
                with self.subTest(objective=objective):
                    path = Path(temporary) / f'{objective.replace(":", "-")}.json'
                    selected, losses, name, digest = nested._fit_inner(train_x, train_labels, train_hours, validation_x, validation_labels, validation_hours, 10 * 24, objective, path)
                    self.assertEqual(name, metric)
                    self.assertEqual(len(losses), 2)
                    self.assertTrue(np.isfinite(losses).all())
                    self.assertEqual(selected, int(np.argmin(losses) + 1))
                    self.assertGreaterEqual(selected, 1)
                    self.assertLessEqual(selected, 2)
                    self.assertEqual(digest, hashlib.sha256(path.read_bytes()).hexdigest())
                    booster = xgb.Booster(model_file=path)
                    weight = nested.balanced_weights(validation_hours) * len(validation_hours)
                    matrix = xgb.DMatrix(validation_x, label=validation_labels, weight=weight, feature_names=list(nested.decay.FEATURE_NAMES), nthread=1)
                    prediction = booster.predict(matrix)
                    self.assertEqual(prediction.shape, validation_labels.shape)
                    self.assertTrue(np.isfinite(prediction).all())
                    # replay the final native weighted metric from the saved booster
                    native_metric = float(booster.eval_set([(matrix, 'validation')], iteration=1).split(f'{metric}:')[1])
                    self.assertAlmostEqual(native_metric, losses[-1], places=6)
                    # binary predictions stay probabilistic and gamma means positive
                    if objective == 'binary:logistic':
                        self.assertTrue(((prediction >= 0) & (prediction <= 1)).all())
                        weighted_loss = -np.average(validation_labels * np.log(prediction) + (1. - validation_labels) * np.log1p(-prediction), weights=weight)
                    else:
                        self.assertTrue((prediction > 0).all())
                        weighted_loss = 2. * np.average(np.log(prediction / validation_labels) + validation_labels / prediction - 1., weights=weight)
                    self.assertAlmostEqual(weighted_loss, losses[-1], places=5)


# run the synthetic validation suite without private archived outcomes
if __name__ == '__main__':
    unittest.main()
