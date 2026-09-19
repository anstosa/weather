"""synthetic checks for independent fixed-fit rain replay."""

import unittest

import numpy as np
from verify_rain_fit_recency import (
    ARMS,
    HALF_LIFE_DAYS,
    effective_dates,
    fit_weights,
    weight_state,
)


class IndependentDecayedFitTests(unittest.TestCase):
    # preserve equal date, hour and vintage mass before the fixed decay
    def test_date_hour_vintage_mass_and_half_life(self):
        hours = np.array([0, 0, 1, 24, 24, 48], dtype=np.int64)
        mass = fit_weights(hours, 72)
        self.assertAlmostEqual(mass.sum(), len(hours))
        self.assertAlmostEqual(mass[0], mass[1])
        self.assertAlmostEqual(mass[0] + mass[1], mass[2])
        self.assertAlmostEqual(
            (mass[0] + mass[1] + mass[2]) / (mass[3] + mass[4]),
            np.exp2(-1 / HALF_LIFE_DAYS),
            places=12,
        )
        self.assertAlmostEqual(
            (mass[0] + mass[1] + mass[2]) / mass[5],
            np.exp2(-2 / HALF_LIFE_DAYS),
            places=12,
        )
        long_hours = np.array([0, 183 * 24], dtype=np.int64)
        self.assertAlmostEqual(
            fit_weights(long_hours, 184 * 24)[0] / fit_weights(long_hours, 184 * 24)[1],
            0.5,
        )

    # rebalance the wet gamma subset instead of slicing all-label mass
    def test_gamma_mass_has_own_normalization(self):
        actual = np.array([0.0, 0.2, 0.0, 0.3, 0.1, 0.0])
        hours = np.array([0, 0, 24, 48, 48, 72], dtype=np.int64)
        state = weight_state(actual, hours, 96)
        wet = actual >= 0.1
        wet_mass = fit_weights(hours[wet], 96)
        self.assertEqual(state["rows"], 6)
        self.assertEqual(state["wetRows"], 3)
        self.assertAlmostEqual(state["weightSum"], 6.0)
        self.assertAlmostEqual(state["wetWeightSum"], 3.0)
        self.assertAlmostEqual(
            state["wetEffectiveDates"], effective_dates(hours[wet], wet_mass)
        )
        self.assertNotAlmostEqual(
            fit_weights(hours, 96)[wet].sum(), state["wetWeightSum"]
        )
        self.assertEqual(state["halfLifeDays"], 183)
        self.assertEqual(state["oldestDateAgeDays"], 3)
        self.assertEqual(state["newestDateAgeDays"], 0)

    # fail closed on future hours and malformed exclusive cutoffs
    def test_invalid_fit_chronology_rejected(self):
        for hours, stop in (
            (np.array([0, 24]), 24),
            (np.array([0]), 25),
            (np.array([], dtype=np.int64), 24),
            (np.array([0.0]), 24),
        ):
            with (
                self.subTest(hours=hours.tolist(), stop=stop),
                self.assertRaises(ValueError),
            ):
                fit_weights(hours, stop)

    # preserve one new selectable arm and all older comparison forecasts
    def test_all_original_controls_retained(self):
        self.assertEqual(len(ARMS), 13)
        self.assertEqual(ARMS[-2:], ("hurdleOriginal", "hurdleDecay"))
        self.assertIn("ordinal90", ARMS)
        self.assertIn("volumeRecent", ARMS)


if __name__ == "__main__":
    unittest.main()
