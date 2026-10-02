"""synthetic checks for independent prequential daily rain replay."""

import unittest

import numpy as np
from verify_rain_daily import day_masks, replay_day


# build paired rows without a historical private archive
def paired_rows():
    hours = np.array(
        [103 * 24 - 1, 103 * 24, 150 * 24, 193 * 24 - 1, 193 * 24, 200 * 24 + 1],
        dtype=np.int64,
    )
    initialized = hours - 9
    return {
        "initialized": initialized,
        "lead": np.ones(len(hours), dtype=np.int64),
        "hour": hours,
        "actual": np.array([0.0, 0.2, 0.3, 0.4, 0.0, 1.0]),
        "raw": np.array([0.0, 0.2, 0.3, 0.4, 0.0, 0.5]),
    }


class IndependentDailyTests(unittest.TestCase):
    # apply exact ninety-day lookback and seven-day embargo boundaries
    def test_half_open_daily_masks(self):
        data = paired_rows()
        calibration, evaluation, bounds = day_masks(data, 200)
        np.testing.assert_array_equal(
            calibration, [False, True, True, True, False, False]
        )
        np.testing.assert_array_equal(
            evaluation, [False, False, False, False, False, True]
        )
        self.assertEqual(bounds["calibrationStartHour"], 103 * 24)
        self.assertEqual(bounds["calibrationMaximumValidHourExclusive"], 193 * 24)
        self.assertEqual(bounds["decisionStartHour"], 200 * 24)
        self.assertEqual(bounds["decisionStopHourExclusive"], 201 * 24)

    # reject malformed paired geometry before selecting any daily labels
    def test_invalid_geometry_rejected(self):
        data = paired_rows()
        data["hour"][0] += 1
        with self.assertRaises(ValueError):
            day_masks(data, 200)

    # later dates may use newly matured labels but never the current decision day
    def test_prequential_window_moves_one_day_at_a_time(self):
        data = paired_rows()
        _, current, first = day_masks(data, 200)
        later_calibration, later, second = day_masks(data, 201)
        self.assertEqual(
            second["calibrationStartHour"] - first["calibrationStartHour"], 24
        )
        self.assertEqual(
            second["calibrationMaximumValidHourExclusive"]
            - first["calibrationMaximumValidHourExclusive"],
            24,
        )
        self.assertTrue(later_calibration[4])
        self.assertFalse(later_calibration[5])
        self.assertTrue(current[5])
        self.assertFalse(later[5])

    # unsupported daily calibration preserves the exact monthly fallback
    def test_unsupported_day_retains_original_amount(self):
        data = paired_rows()
        probability = np.full((len(data["hour"]), 3), np.nan)
        base = data["raw"].copy()
        policy = {
            "calibrationSupport": {"dates": 60, "hours": 500},
            "effectiveSupport": {"effectiveDates": 30, "effectiveWetDates": 3},
        }
        rows, predicted, state = replay_day(
            data, probability, base, 200, np.array([0.75]), policy
        )
        np.testing.assert_array_equal(rows, [5])
        np.testing.assert_array_equal(predicted, [0.75])
        self.assertFalse(state["supported"])
        self.assertEqual(state["reason"], "insufficient_calibration_support")

    # later decision-day targets may not enter the calibration result
    def test_future_evaluation_target_is_not_read(self):
        data = paired_rows()
        probability = np.full((len(data["hour"]), 3), np.nan)
        base = data["raw"].copy()
        policy = {
            "calibrationSupport": {
                "dates": 1,
                "hours": 1,
                "wetDates": 1,
                "wetHours": 1,
            },
            "effectiveSupport": {"effectiveDates": 1, "effectiveWetDates": 1},
        }
        first = replay_day(data, probability, base, 200, np.array([0.75]), policy)
        data["actual"][5] = np.nan
        second = replay_day(data, probability, base, 200, np.array([0.75]), policy)
        np.testing.assert_array_equal(first[1], second[1])
        self.assertEqual(first[2], second[2])


if __name__ == "__main__":
    unittest.main()
