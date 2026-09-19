"""lock daily rain calibration to earlier valid-hour labels only."""

import copy
import inspect
import unittest

import numpy as np
import rain_daily_calibration as daily


# encode target hours with a legal decision plus one-hour horizon
def rows(valid_hours):
    hours = np.asarray(valid_hours, dtype=np.int64)
    return {'initialized': hours - 9, 'lead': np.ones(len(hours), dtype=np.int64), 'hour': hours}


# create ninety earlier dates and one future decision date without real outcomes
def supported_population(decision_day=200):
    dates = np.arange(decision_day - 97, decision_day - 7, dtype=np.int64)
    calibration_hours = (dates[:, None] * 24 + np.arange(10, 16)).ravel()
    evaluation_hours = decision_day * 24 + np.array([10, 11])
    outside = np.array([(decision_day - 120) * 24 + 10])
    data = rows(np.r_[outside, calibration_hours, evaluation_hours])
    wet = np.repeat(np.arange(len(dates)) % 3 == 0, 6)
    data['actual'] = np.r_[np.nan, np.where(wet, .2, 0.), np.nan, np.nan]
    data['raw'] = np.r_[np.nan, np.where(wet, .2, 0.), .2, 0.]
    probabilities = np.full((len(data['hour']), 3), np.nan)
    base = np.r_[np.nan, np.full(len(calibration_hours) + len(evaluation_hours), .5)]
    return data, probabilities, base


# check synthetic utc geometry and causal calibration behavior
class RainDailyCalibrationTests(unittest.TestCase):
    # seven-day embargo and ninety-day window have exact half-open boundaries
    def test_day_masks_bounds_and_same_month_prequential_labels(self):
        day = 200
        start = day * 24
        lower = start - 97 * 24
        upper = start - 7 * 24
        hours = [lower - 1, lower, upper - 1, upper, (day - 10) * 24 + 10, start + 10, start + 23, start + 33]
        data = rows(hours)
        calibration, evaluation, bounds = daily.day_masks(data, day)
        np.testing.assert_array_equal(calibration, [False, True, True, False, True, False, False, False])
        np.testing.assert_array_equal(evaluation, [False, False, False, False, False, True, True, False])
        self.assertEqual(bounds['calibrationStartHour'], lower)
        self.assertEqual(bounds['calibrationMaximumValidHourExclusive'], upper)
        self.assertEqual(bounds['decisionDayStartHour'], start)
        self.assertEqual(bounds['decisionStartHour'], start)
        self.assertEqual(bounds['decisionStopHourExclusive'], start + 24)
        self.assertEqual(bounds['decisionDate'], '1970-07-20')
        self.assertEqual(tuple(inspect.signature(daily.calibrate_day).parameters), ('data', 'probabilities', 'base', 'decision_day', 'fallback_eval'))

    # selected daily support and hurdle fitting must ignore evaluation outcomes
    def test_supported_daily_fit_uses_only_calibration_labels(self):
        data, probabilities, base = supported_population()
        fallback = np.array([.75, .75], dtype=np.float64)
        rows_a, predicted_a, state_a = daily.calibrate_day(data, probabilities, base, 200, fallback)
        self.assertTrue(state_a['supported'])
        self.assertEqual(state_a['reason'], 'daily_hurdle_calibrated')
        self.assertEqual(state_a['support']['rows'], 540)
        self.assertEqual(state_a['support']['dates'], 90)
        self.assertEqual(state_a['support']['wetDates'], 30)
        self.assertGreater(state_a['effectiveSupport']['effectiveDates'], 30.)
        self.assertGreater(state_a['effectiveSupport']['effectiveWetDates'], 3.)
        self.assertEqual(state_a['calibration']['calibrationRows'], 540)
        self.assertEqual(state_a['calibration']['calibrationStopHourExclusive'], (200 - 7) * 24)
        self.assertEqual(len(state_a['proposedRules']), 3)
        self.assertEqual(len(state_a['uniformRules']), 3)
        np.testing.assert_array_equal(rows_a, [541, 542])
        self.assertTrue(np.isfinite(predicted_a).all())
        self.assertFalse(np.array_equal(predicted_a, fallback))
        changed = copy.deepcopy(data)
        changed['actual'][-2:] = [0., 30.]
        rows_b, predicted_b, state_b = daily.calibrate_day(changed, probabilities, base, 200, fallback)
        np.testing.assert_array_equal(rows_b, rows_a)
        np.testing.assert_array_equal(predicted_b, predicted_a)
        self.assertEqual(state_b, state_a)

    # thin daily windows return the frozen monthly forecast without alteration
    def test_unsupported_daily_fallback_is_exact(self):
        data = rows([100 * 24 + 10, 200 * 24 + 10])
        data['actual'] = np.array([.2, np.nan])
        data['raw'] = np.array([.2, .2])
        probabilities = np.full((2, 3), np.nan)
        base = np.full(2, np.nan)
        fallback = np.array([.123456789123], dtype=np.float64)
        selected, predicted, state = daily.calibrate_day(data, probabilities, base, 200, fallback)
        np.testing.assert_array_equal(selected, [1])
        self.assertEqual(predicted.dtype, fallback.dtype)
        self.assertEqual(predicted.tobytes(), fallback.tobytes())
        self.assertFalse(state['supported'])
        self.assertIsNone(state['calibration'])
        self.assertIsNone(state['proposedRules'])
        self.assertEqual(state['reason'], 'insufficient_calibration_support')

    # malformed day, horizon and target-hour identities never select labels
    def test_invalid_geometry_or_fallback_rejected(self):
        data = rows([200 * 24 + 10])
        data['actual'] = np.array([np.nan])
        data['raw'] = np.array([.2])
        for invalid in (200., True, np.int64(200) + .5):
            # fractional and boolean day labels cannot define a utc date
            with self.subTest(day=invalid), self.assertRaises(ValueError):
                daily.day_masks(data, invalid)
        for changed in ({**data, 'lead': np.array([0])}, {**data, 'hour': np.array([200 * 24 + 11])}, {**data, 'initialized': np.array([float(data['initialized'][0])])}):
            # invalid source geometry is never repaired by calibration
            with self.subTest(change=tuple(changed)), self.assertRaises(ValueError):
                daily.day_masks(changed, 200)
        with self.assertRaises(ValueError):
            daily.calibrate_day(data, np.full((1, 3), np.nan), np.array([np.nan]), 200, np.array([-.1]))


# permit only synthetic standalone calibration verification
if __name__ == '__main__':
    unittest.main()
