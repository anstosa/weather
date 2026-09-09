"""lock exact rain windows and causal feature timing before fitting."""

import copy
import datetime as dt
import unittest

import numpy as np
from build_rain_sub24 import FIRST_HOUR, hourly_window, insert
from rain_sub24 import (
    FEATURE_NAMES,
    POLICY,
    STATIONS,
    features,
    hour_number,
    network_summary,
)


# use fixed synthetic profiles with no provider requests
def profile(initialized):
    return [{'runInitializedAt': dt.datetime.fromtimestamp(initialized * 3600, dt.timezone.utc).isoformat(), 'validAt': dt.datetime.fromtimestamp((initialized + lead) * 3600, dt.timezone.utc).isoformat(), 'targetLeadHours': lead, 'rawPrecipitationMm': lead / 100, 'rawTemperatureC': 10, 'rawRelativeHumidityPercent': 90, 'rawWindSpeedMps': 3, 'rawCloudCoverPercent': 80} for lead in range(1, 49)]


# verify measurement and horizon contracts using small deterministic arrays
class Sub24Tests(unittest.TestCase):
    # sum measured amounts rather than extrapolated minute rain rates
    def test_exact_reporting_hour(self):
        rain, minutes, seen = np.full(180, 0.1), np.ones(180, dtype=int), np.ones(180, dtype=bool)
        self.assertAlmostEqual(hourly_window(rain, minutes, seen, 120)[0], 6)
        seen[90] = False
        self.assertIsNone(hourly_window(rain, minutes, seen, 120))

    # five-minute intervals remain exact and no endpoint is invented
    def test_five_minute_and_lagged_windows(self):
        rain, minutes, seen = np.ones(180), np.zeros(180, dtype=int), np.zeros(180, dtype=bool)
        minutes[::5], seen[::5] = 5, True
        self.assertEqual(hourly_window(rain, minutes, seen, 123), (12, 3))
        minutes[120] = 3
        self.assertIsNone(hourly_window(rain, minutes, seen, 123))

    # targets and future observations cannot alter forecast-time features
    def test_future_observations_do_not_change_features(self):
        initialized = hour_number('2025-01-01T00:00:00Z')
        first = initialized - 48
        rain = np.arange(120 * 12, dtype=float).reshape(120, 12) / 100
        temperature = np.full(120, 10.)
        weights = np.ones(12)
        original = features(profile(initialized), initialized, 23, rain, temperature, first, weights)
        rain[56:] = 999
        temperature[56:] = -50
        changed = features(profile(initialized), initialized, 23, rain, temperature, first, weights)
        np.testing.assert_equal(original, changed)
        self.assertEqual(len(original), len(FEATURE_NAMES))
        self.assertEqual(original[5], .31)
        rain[55] = 0
        self.assertFalse(np.array_equal(original, features(profile(initialized), initialized, 23, rain, temperature, first, weights)))

    # initialized lead nine is operational horizon one after simulated publication
    def test_horizon_mapping_and_source_identity(self):
        initialized = hour_number('2025-01-01T00:00:00Z')
        inputs = (np.zeros((100, 12)), np.ones(100) * 10, initialized - 48, np.ones(12))
        result = features(profile(initialized), initialized, 1, *inputs)
        self.assertAlmostEqual(result[5], .09)
        with self.assertRaises(ValueError):
            features(profile(initialized), initialized, 24, *inputs)
        changed = copy.deepcopy(profile(initialized))
        changed[8]['targetLeadHours'] = 1
        with self.assertRaises(ValueError):
            features(changed, initialized, 1, *inputs)

    # missing gauges remain missing and never increase dry-station support
    def test_missing_network_support_is_not_dry(self):
        result = network_summary(np.full(12, np.nan), np.ones(12))
        self.assertTrue(np.isnan(result[0]))
        self.assertEqual(result[3], 0)
        self.assertEqual(len(set(STATIONS)), 12)
        self.assertEqual(POLICY['decisionDelayHours'], 8)

    # retained monthly overlaps must agree before any aggregation
    def test_duplicate_interval_conflict(self):
        arrays = {'rain': np.full((12, 120), np.nan), 'temperature': np.full((12, 120), np.nan), 'minutes': np.zeros((12, 120), dtype=int), 'seen': np.zeros((12, 120), dtype=bool)}
        at = dt.datetime.fromtimestamp(FIRST_HOUR * 3600, dt.timezone.utc).isoformat()
        insert(arrays, 0, at, .1, 1, 10, True)
        insert(arrays, 0, at, .1, 1, 10, True)
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            insert(arrays, 0, at, .2, 1, 10, True)


# run synthetic checks without reading outcome data
if __name__ == '__main__':
    unittest.main()
