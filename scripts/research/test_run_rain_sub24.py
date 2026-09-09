"""lock chronological fitting, rain-volume constraints and hourly scoring."""

import unittest

import numpy as np
from rain_sub24 import FEATURE_NAMES, POLICY, hour_number
from run_rain_sub24 import (
    accumulations,
    bootstrap,
    fit_booster,
    month_masks,
    predictions,
    score,
    select_candidate,
    validate_dataset,
    validate_observation_support,
    volume_scale,
    weights,
)


# test the full statistical contract using synthetic arrays only
class ModelTests(unittest.TestCase):
    # duplicate forecasts must not dominate a valid hour or calendar date
    def test_date_hour_balanced_weights(self):
        hours = np.array([0, 0, 1, 24])
        np.testing.assert_allclose(weights(hours), [.125, .125, .25, .5])
        self.assertAlmostEqual(weights(hours).sum(), 1)

    # preserve rain amount and precision rather than rewarding only dry predictions
    def test_scores_include_volume_wet_error_and_detection(self):
        actual = np.array([0., 0., 1., 2.])
        hours = np.arange(4)
        result = score(actual, np.zeros(4), np.zeros(4), hours)
        self.assertEqual(result['volumeRatio'], 0)
        self.assertEqual(result['wetMae'], 1.5)
        self.assertEqual(result['csi'], 0)
        self.assertEqual(result['brier'], .5)
        self.assertEqual(result['mae'], .75)

    # train and calibration labels must mature before every evaluation decision
    def test_causal_monthly_windows_and_holdout_embargo(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.arange(start - 100 * 24, start + 50)
        data = {'hour': hours, 'initialized': hours - 20}
        fit, calibration, evaluation, state = month_masks(data, '2025-09')
        self.assertLess(hours[fit].max(), hours[calibration].min() - 7 * 24)
        self.assertLess(hours[calibration].max(), start - 7 * 24)
        self.assertGreaterEqual((data['initialized'][evaluation] + 8).min(), start)
        _, _, development, _ = month_masks(data, '2025-08')
        self.assertLess(hours[development].max(), start - 7 * 24)
        self.assertEqual(state['decisionStartHour'], start)

    # model wet occurrence can recover storms even when the raw forecast is zero
    def test_hurdle_can_create_missed_rain(self):
        values, probability = predictions(np.array([0., .2]), np.array([.8, .01]), np.array([1., 1.]), np.array([.8, .01]), np.array([np.nan, 0.]))
        self.assertAlmostEqual(values['hurdle-p0.25-raw0'][0], .8)
        self.assertEqual(values['hurdle-p0.25-raw0'][1], 0)
        self.assertEqual(probability['hurdle-p0.25-raw0'][0], .8)
        self.assertEqual(values['persistence'][0], 0)

    # calibration remains bounded and does not divide by a dry prediction sum
    def test_scale_bounds(self):
        self.assertEqual(volume_scale(np.ones(4), np.ones(4) * .01, np.arange(4)), 2)
        self.assertEqual(volume_scale(np.zeros(4), np.ones(4), np.arange(4)), .5)
        self.assertEqual(volume_scale(np.ones(4), np.zeros(4), np.arange(4)), 1)

    # missing lead hours cannot masquerade as a complete first-day accumulation
    def test_accumulations_require_complete_same_run_prefixes(self):
        actual = np.ones(23)
        results = accumulations(actual, {'raw': actual * 2}, np.zeros(23), np.arange(1, 24))
        self.assertEqual(results['23']['runs'], 1)
        self.assertEqual(results['23']['candidates']['raw']['mae'], 23)
        incomplete = accumulations(actual[:-1], {'raw': actual[:-1]}, np.zeros(22), np.arange(1, 23))
        self.assertEqual(incomplete['23']['runs'], 0)

    # balance accumulation endpoints equally across utc dates
    def test_accumulations_balance_unequal_endpoint_counts_per_date(self):
        initialized = np.repeat([-14, -13, 10], 6)
        lead = np.tile(np.arange(1, 7), 3)
        actual = np.ones(18)
        predicted = actual.copy()
        predicted[12:] = 2
        result = accumulations(actual, {'raw': predicted}, initialized, lead)['6']['candidates']['raw']
        self.assertEqual(result['mae'], 3)
        self.assertEqual(result['volumeRatio'], 1.5)

    # selection cannot promote a dry-biased nominal mae winner
    def test_development_selection_requires_balanced_rain(self):
        raw = {'mae': 1., 'volumeRatio': 1., 'wetMae': 1., 'csi': .5, 'far': .4}
        too_dry = {**raw, 'mae': .1, 'volumeRatio': .2}
        good = {**raw, 'mae': .8}
        self.assertEqual(select_candidate({'raw': raw, 'volumeScale': raw, 'persistence': raw, 'zero': too_dry, 'hurdle': good}), 'hurdle')
        self.assertIsNone(select_candidate({'raw': raw, 'volumeScale': raw, 'persistence': raw, 'hurdle': too_dry}))

    # paired date blocks preserve an identical prediction's exact zero uncertainty
    def test_bootstrap_identity(self):
        hours = np.arange(24 * 20)
        actual = np.where(hours % 8 == 0, 1., 0.)
        result = bootstrap(actual, actual, actual, hours)
        self.assertEqual(result['lower95'], 0)
        self.assertEqual(result['upper95'], 0)

    # same-width feature reordering cannot silently train mislabeled columns
    def test_dataset_feature_order_is_bound(self):
        hour = np.array([100, 101])
        lead = np.array([1, 2])
        x = np.zeros((2, len(FEATURE_NAMES)), dtype=np.float32)
        x[:, 0] = lead
        x[:, FEATURE_NAMES.index('rawTemperature')] = 10
        data = {'x': x, 'actual': np.zeros(2), 'mean': np.zeros(2), 'raw': np.zeros(2), 'hour': hour, 'initialized': np.array([91, 91]), 'lead': lead, 'support': np.ones(2) * 3, 'actual_temperature': np.ones(2) * 10, 'persistence': np.zeros(2)}
        pairing = {'featureNames': list(FEATURE_NAMES)}
        validate_dataset(data, pairing)
        pairing['featureNames'][0], pairing['featureNames'][1] = pairing['featureNames'][1], pairing['featureNames'][0]
        with self.assertRaisesRegex(ValueError, 'feature names'):
            validate_dataset(data, pairing)
        pairing['featureNames'] = list(FEATURE_NAMES)
        data['hour'][1] += 1
        with self.assertRaisesRegex(ValueError, 'lead identity'):
            validate_dataset(data, pairing)

    # enforce the frozen forecast phase and target gauge floors
    def test_dataset_rejects_cold_forecasts_and_sparse_targets(self):
        hour = np.array([100])
        lead = np.array([1])
        x = np.zeros((1, len(FEATURE_NAMES)), dtype=np.float32)
        x[:, 0] = lead
        x[:, FEATURE_NAMES.index('rawTemperature')] = 10
        data = {'x': x, 'actual': np.zeros(1), 'mean': np.zeros(1), 'raw': np.zeros(1), 'hour': hour, 'initialized': np.array([91]), 'lead': lead, 'support': np.array([3]), 'actual_temperature': np.ones(1) * 10, 'persistence': np.zeros(1)}
        pairing = {'featureNames': list(FEATURE_NAMES)}
        # reject the exact lower phase boundary
        cold = {**data, 'x': x.copy()}
        cold['x'][:, FEATURE_NAMES.index('rawTemperature')] = POLICY['rainForecastTemperatureMinimumC']
        with self.assertRaisesRegex(ValueError, 'temperature'):
            validate_dataset(cold, pairing)
        # reject fewer than the frozen complete-gauge floor
        sparse = {**data, 'support': np.array([POLICY['minimumCompleteGauges'] - 1])}
        with self.assertRaisesRegex(ValueError, 'gauge'):
            validate_dataset(sparse, pairing)

    # rederive nearest-station support from the retained rain matrix
    def test_observation_support_requires_a_nearest_gauge(self):
        data = {'hour': np.array([100]), 'actual': np.array([0.2]), 'mean': np.array([0.3]), 'actual_temperature': np.array([8.]), 'support': np.array([3])}
        rain = np.full((1, len(POLICY['stationIds'])), np.nan)
        rain[0, 3:6] = 0.2
        observations = {'rain': rain, 'temperature': np.array([8.]), 'target': np.array([0.2]), 'mean': np.array([0.3]), 'support': np.array([3]), 'weights': np.ones(len(POLICY['stationIds'])), 'first_hour': np.array(100)}
        receipt = {'catalog': [{'stationId': station, 'distanceMeters': index} for index, station in enumerate(POLICY['stationIds'])]}
        with self.assertRaisesRegex(ValueError, 'nearest'):
            validate_observation_support(data, observations, receipt)
        # retain three gauges while adding nearest-station participation
        observations['rain'][0, 3] = np.nan
        observations['rain'][0, 0] = 0.2
        validate_observation_support(data, observations, receipt)

    # a model cannot unlock holdout by losing to a simple baseline
    def test_selection_rejects_persistence_regression(self):
        raw = {'mae': 1., 'volumeRatio': 1., 'wetMae': 1., 'csi': .5, 'far': .4}
        self.assertIsNone(select_candidate({'raw': raw, 'volumeScale': raw, 'persistence': {**raw, 'mae': .7}, 'hurdle': {**raw, 'mae': .8}}))

    # exercise all three actual learner objectives in the pinned runtime
    def test_real_synthetic_learners(self):
        rng = np.random.default_rng(7)
        x = rng.normal(size=(250, len(FEATURE_NAMES))).astype(np.float32)
        actual = (x[:, 0] > 0).astype(float)
        hours = np.arange(250)
        for objective in ('binary:logistic', 'reg:gamma', 'reg:tweedie'):
            labels = actual + .2 if objective == 'reg:gamma' else actual
            model = fit_booster(x, labels, hours, objective)
            self.assertEqual(model.num_features(), len(FEATURE_NAMES))
            self.assertEqual(model.num_boosted_rounds(), POLICY['boostRounds'])


# importing test fixtures never reads the production corpus
if __name__ == '__main__':
    unittest.main()
