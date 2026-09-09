"""check independent rain scoring and named-head replay without outcome data."""

import unittest

import numpy as np
from verify_rain_sub24_model import (
    accumulation_metrics,
    candidate,
    metrics,
    same,
    validate_dataset_support,
    weights,
)


# verify arithmetic independently of the fitting module
class ModelVerificationTests(unittest.TestCase):
    # preserve rowwise sums while balancing unequal endpoint counts by utc date
    def test_accumulation_reduction_order_and_endpoint_weights(self):
        actual = np.ones((3, 6), dtype=np.float64)
        predicted = actual.astype(np.float32)
        predicted[2] = 2
        result = accumulation_metrics(actual, predicted, np.array([0, 1, 24]))
        self.assertEqual(result['volumeRatio'], 1.5)
        self.assertEqual(result['mae'], 3)

    # repeated forecasts do not alter the date/hour mass
    def test_independent_weights(self):
        np.testing.assert_allclose(weights(np.array([0, 0, 1, 24])), [.125, .125, .25, .5])

    # reconstruct hand-calculated event counts and conserved amount
    def test_independent_rain_metrics(self):
        actual, predicted = np.array([0., 1., 1., 0.]), np.array([0., 1., 0., 1.])
        result = metrics(actual, predicted, predicted, np.arange(4))
        self.assertEqual(result['mae'], .5)
        self.assertEqual(result['volumeRatio'], 1)
        self.assertEqual(result['csi'], 1 / 3)
        self.assertEqual(result['far'], .5)
        self.assertEqual(result['wetMae'], .5)

    # gate occurrence before any calibrated amount scaling
    def test_independent_hurdle_replay(self):
        point, probability = candidate('hurdle-p0.25-raw0.25', np.array([0., .2]), np.array([.8, .1]), np.array([1., 2.]), np.zeros(2))
        np.testing.assert_allclose(point, [.6, .05])
        np.testing.assert_allclose(probability, [.6, .325])

    # refuse changed metric identities rather than comparing their shared subset
    def test_rejects_report_mutation(self):
        with self.assertRaisesRegex(ValueError, 'keys changed'):
            same({'mae': .2}, {'rmse': .2})
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            same({'mae': .2}, {'mae': .1})

    # independently rederive complete and nearest gauge support
    def test_dataset_support_uses_hourly_rain_matrix(self):
        names = ['rawTemperature']
        policy = {'rainForecastTemperatureMinimumC': 2, 'minimumCompleteGauges': 3, 'stationIds': [10, 11, 12, 13, 14, 15]}
        data = {'x': np.array([[10.]]), 'hour': np.array([100]), 'actual': np.array([0.2]), 'mean': np.array([0.3]), 'actual_temperature': np.array([8.]), 'support': np.array([3])}
        rain = np.array([[0.2, np.nan, np.nan, np.nan, 0.2, 0.2]])
        observations = {'rain': rain, 'temperature': np.array([8.]), 'target': np.array([0.2]), 'mean': np.array([0.3]), 'support': np.array([3]), 'weights': np.ones(6), 'first_hour': np.array(100)}
        receipt = {'catalog': [{'stationId': station, 'distanceMeters': index} for index, station in enumerate(policy['stationIds'])]}
        validate_dataset_support(data, observations, receipt, policy, names)
        # reject the same total support without a nearest-three station
        observations['rain'][0, 0] = np.nan
        observations['rain'][0, 3] = 0.2
        with self.assertRaisesRegex(ValueError, 'nearest'):
            validate_dataset_support(data, observations, receipt, policy, names)


# execute deterministic private-free fixtures only
if __name__ == '__main__':
    unittest.main()
