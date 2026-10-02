"""synthetic checks for independent inner-capacity selection."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import xgboost as xgb
from verify_rain_capacity import (
    ARMS,
    POLICY,
    earliest_minimum,
    fit_inner,
    head_supported,
    inner_masks,
)


class IndependentCapacityTests(unittest.TestCase):
    # isolate 120 validation days behind a seven-day inner embargo
    def test_inner_masks_exclude_embargo_and_future(self):
        stop = 200 * 24
        hours = np.array([0, 72 * 24, 73 * 24, 79 * 24, 80 * 24, stop - 1])
        training, validation, bounds = inner_masks(hours, stop)
        np.testing.assert_array_equal(
            training, [True, True, False, False, False, False]
        )
        np.testing.assert_array_equal(
            validation, [False, False, False, False, True, True]
        )
        self.assertEqual(bounds["innerTrainingMaximumValidHourExclusive"], 73 * 24)
        self.assertEqual(bounds["innerValidationStartHour"], 80 * 24)
        self.assertEqual(bounds["innerValidationMaximumValidHourExclusive"], stop)
        self.assertEqual(bounds["innerEmbargoHours"], 7 * 24)

    # choose the earliest exact minimum rather than a later tied round
    def test_earliest_minimum_and_history_length(self):
        loss = np.full(320, 2.0)
        loss[6] = 0.5
        loss[50] = 0.5
        self.assertEqual(earliest_minimum(loss), 7)
        with self.assertRaises(ValueError):
            earliest_minimum(loss[:-1])
        loss[0] = np.nan
        with self.assertRaises(ValueError):
            earliest_minimum(loss)

    # apply separate binary and gamma inner validation floors
    def test_head_support_rules(self):
        self.assertTrue(
            head_supported({"positiveHours": 10, "positiveDates": 3}, "binary:logistic")
        )
        self.assertFalse(
            head_supported(
                {"positiveHours": 10, "positiveDates": 3},
                "binary:logistic",
                validation=True,
            )
        )
        self.assertTrue(
            head_supported(
                {"positiveHours": 10, "positiveDates": 5},
                "binary:logistic",
                validation=True,
            )
        )
        self.assertFalse(
            head_supported({"positiveHours": 99, "positiveDates": 20}, "reg:gamma")
        )
        self.assertTrue(
            head_supported(
                {"positiveHours": 20, "positiveDates": 5}, "reg:gamma", validation=True
            )
        )

    # retain all thirteen controls while selecting only the new primary
    def test_previous_controls_are_retained(self):
        self.assertEqual(len(ARMS), 14)
        self.assertEqual(
            ARMS[-3:], ("hurdleOriginal", "decayOriginal", "hurdleCapacity")
        )
        self.assertIn("volumeRecent", ARMS)
        self.assertIn("ordinal90", ARMS)

    # replay native metric histories against both pinned objectives
    def test_native_inner_metric_and_saved_booster(self):
        names = POLICY["featureNames"]
        training_hours = np.arange(8, dtype=np.int64) * 24
        validation_hours = np.arange(11, 17, dtype=np.int64) * 24
        training_x = np.zeros((8, len(names)), dtype=np.float32)
        validation_x = np.zeros((6, len(names)), dtype=np.float32)
        training_x[:, 0] = np.arange(8)
        validation_x[:, 0] = np.arange(6)
        cases = (
            (
                "binary:logistic",
                "0.1",
                "event-0.1.json",
                np.array([0.0, 1.0] * 4),
                np.array([0.0, 1.0] * 3),
                "logloss",
            ),
            (
                "reg:gamma",
                "amount",
                "amount.json",
                np.array([0.2, 1.0] * 4),
                np.array([0.2, 1.0] * 3),
                "gamma-deviance",
            ),
        )
        native_train = xgb.train
        # save the exact booster returned to the verifier
        for objective, name, filename, train_labels, valid_labels, metric in cases:
            with (
                self.subTest(objective=objective),
                tempfile.TemporaryDirectory() as temporary,
            ):
                directory = Path(temporary) / "capacity-models" / "synthetic"
                directory.mkdir(parents=True)

                # mirror immutable native artifact capture
                def save_train(*args, **kwargs):
                    booster = native_train(*args, **kwargs)
                    booster.save_model(directory / f"inner-{filename}")
                    return booster

                with patch("verify_rain_capacity.xgb.train", side_effect=save_train):
                    selected, losses, observed_metric, digest = fit_inner(
                        Path(temporary),
                        "synthetic",
                        name,
                        filename,
                        objective,
                        training_x,
                        train_labels,
                        training_hours,
                        validation_x,
                        valid_labels,
                        validation_hours,
                        10 * 24,
                        names,
                    )
                self.assertEqual(observed_metric, metric)
                self.assertEqual(selected, int(np.argmin(losses) + 1))
                self.assertEqual(len(losses), 320)
                self.assertTrue(np.isfinite(losses).all())
                self.assertEqual(len(digest), 64)


if __name__ == "__main__":
    unittest.main()
