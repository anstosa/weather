#!/usr/bin/env python3
"""Test the research-only smooth seasonal temperature calibration."""

from __future__ import annotations

import copy
import datetime as dt
import math
from pathlib import Path
import sys
import unittest

import numpy as np

# import the sibling research module without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import temperature_seasonal_ridge as ridge


# format one canonical millisecond utc instant
def utc_instant(value: dt.datetime) -> str:
    """Format a timezone-aware datetime under the module's strict UTC contract."""
    return value.astimezone(ridge.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one authentic fixed-lead archive row
def anchor_row(
    valid_at: dt.datetime,
    *,
    lead: object = 24,
    residual: float = 2.5,
    key: str,
) -> dict[str, object]:
    """Build one deterministic training row with a known raw-plus-bias label."""
    raw_temperature = 10.0
    return {
        "key": key,
        "cohort": "fixed_lead_anchor",
        "referenceAt": None,
        "validAt": utc_instant(valid_at),
        "targetLeadHours": lead,
        "rawTemperatureC": raw_temperature,
        "rawRelativeHumidityPercent": 75.0,
        "rawWindSpeedMps": 2.0,
        "actualTemperatureC": raw_temperature + residual,
    }


# build one supported fitted-model shell
def model_for(lead: int, *, offset: float) -> dict[str, object]:
    """Build the smallest valid model needed for prediction-policy tests."""
    probe = anchor_row(
        dt.datetime(2025, 1, 1, tzinfo=ridge.UTC), key=f"probe-{lead}"
    )
    return {
        "lead": lead,
        "coefficients": [0.0] * len(ridge.features(probe)),
        "medianOffsetC": offset,
    }


class TemperatureSeasonalRidgeFeatureTest(unittest.TestCase):
    """Verify predictor isolation, missing-value handling, and month identity."""

    # exclude labels from feature construction
    def test_features_ignore_actual_labels_and_keep_missing_predictors_finite(self) -> None:
        """Use only forecast-time fields and explicit finite missing indicators."""
        row = anchor_row(
            dt.datetime(2025, 3, 8, 18, tzinfo=ridge.UTC), key="feature-row"
        )
        row["rawRelativeHumidityPercent"] = None
        row["rawWindSpeedMps"] = None
        first = ridge.features(row)

        poisoned = dict(row)
        poisoned["actualTemperatureC"] = object()
        poisoned["targetTemperatureC"] = float("nan")
        second = ridge.features(poisoned)

        np.testing.assert_array_equal(first, second)
        self.assertTrue(np.isfinite(first).all())
        self.assertEqual(first[17:19].tolist(), [1.0, 1.0])

    # select model state from the issue month
    def test_reference_month_uses_reference_not_valid_month(self) -> None:
        """Keep a cross-month one-hour forecast in its local reference month."""
        row = {
            "referenceAt": "2025-02-01T07:30:00.000Z",
            "validAt": "2025-02-01T08:30:00.000Z",
            "targetLeadHours": 1,
        }

        self.assertEqual(ridge.reference_month(row), "2025-01")

        malformed = dict(row)
        malformed["targetLeadHours"] = 2
        with self.assertRaisesRegex(ValueError, "reference must agree"):
            ridge.reference_month(malformed)

        invalid_leads = (0, 169, 1.5, True)

        # reject every malformed live lead identity
        for lead in invalid_leads:
            with self.subTest(lead=lead):
                invalid = dict(row)
                invalid["targetLeadHours"] = lead
                with self.assertRaises(ValueError):
                    ridge.reference_month(invalid)

    # preserve local calendar semantics across leap and offset changes
    def test_calendar_features_cover_leap_day_and_dst_offsets(self) -> None:
        """Use the leap-year denominator and zone-aware local month boundaries."""
        leap = anchor_row(
            dt.datetime(2024, 2, 29, 20, tzinfo=ridge.UTC), key="leap-day"
        )
        leap_features = ridge.features(leap)
        annual_angle = 2 * math.pi * (59 + 12 / 24) / 366

        self.assertTrue(math.isclose(leap_features[1], math.sin(annual_angle)))
        self.assertTrue(math.isclose(leap_features[2], math.cos(annual_angle)))
        self.assertEqual(
            ridge.month_start("2024-03"),
            dt.datetime(2024, 3, 1, 8, tzinfo=ridge.UTC),
        )
        self.assertEqual(
            ridge.month_start("2024-04"),
            dt.datetime(2024, 4, 1, 7, tzinfo=ridge.UTC),
        )

        repeated_hour_rows = [
            anchor_row(
                dt.datetime(2025, 11, 2, 8, tzinfo=ridge.UTC), key="first-one-am"
            ),
            anchor_row(
                dt.datetime(2025, 11, 2, 9, tzinfo=ridge.UTC), key="second-one-am"
            ),
            anchor_row(
                dt.datetime(2025, 11, 3, 8, tzinfo=ridge.UTC), key="next-date"
            ),
        ]
        np.testing.assert_array_equal(
            ridge.date_weights(repeated_hour_rows), np.array([0.5, 0.5, 1.0])
        )

    # require exact calendar-month spelling
    def test_month_start_rejects_noncanonical_months(self) -> None:
        """Reject alternate spellings and impossible calendar months."""
        invalid_months = ("2025-1", "2025-01-01", "2025-13")

        # exercise parseable aliases and invalid dates
        for month in invalid_months:
            with self.subTest(month=month):
                with self.assertRaises(ValueError):
                    ridge.month_start(month)


class TemperatureSeasonalRidgeFitTest(unittest.TestCase):
    """Verify causal monthly fitting and deterministic constant-bias learning."""

    # generate sufficient all-earlier synthetic support
    @staticmethod
    def synthetic_rows() -> list[dict[str, object]]:
        """Create two hundred dates and one thousand exact-lead archive rows."""
        start = dt.datetime(2024, 1, 1, tzinfo=ridge.UTC)
        rows: list[dict[str, object]] = []

        # represent every training date with five forecast-valid hours
        for day in range(200):
            # preserve equal within-date support
            for hour in range(5):
                valid_at = start + dt.timedelta(days=day, hours=hour)
                rows.append(
                    anchor_row(valid_at, key=f"training-{day:03d}-{hour:02d}")
                )

        return rows

    # exclude cutoff and future labels before fitting
    def test_fit_is_deterministic_and_excludes_cutoff_and_future_poison_labels(self) -> None:
        """Recover a constant bias without observing embargoed poison labels."""
        rows = self.synthetic_rows()
        cutoff = ridge.month_start("2025-01") - dt.timedelta(
            hours=ridge.POLICY["embargoHours"]
        )
        at_cutoff = anchor_row(cutoff, key="poison-at-cutoff", residual=1e100)
        future = anchor_row(
            cutoff + dt.timedelta(days=400), key="poison-future", residual=-1e100
        )

        first = ridge.fit(rows, "2025-01", 24)
        second = ridge.fit(list(reversed(rows)) + [at_cutoff, future], "2025-01", 24)

        matrix = np.stack([ridge.features(row) for row in rows])
        self.assertLess(np.linalg.matrix_rank(matrix), matrix.shape[1])
        self.assertEqual(first, second)
        self.assertEqual(first["trainingRows"], 1000)
        self.assertEqual(first["trainingDates"], 200)
        self.assertNotIn("poison-at-cutoff", first["trainingKeys"])
        self.assertNotIn("poison-future", first["trainingKeys"])
        self.assertEqual(first["trainingCutoffUtc"], "2024-12-25T08:00:00.000Z")

        probe = anchor_row(
            dt.datetime(2025, 2, 1, 12, tzinfo=ridge.UTC), key="prediction-probe"
        )
        fitted_offset = float(
            ridge.features(probe) @ np.asarray(first["coefficients"])
        )
        self.assertTrue(math.isclose(fitted_offset, 2.5, abs_tol=1e-10))

        lead_48 = copy.deepcopy(first)
        lead_48["lead"] = 48
        prediction = ridge.predict(probe, {24: first, 48: lead_48}, 999.0)
        self.assertTrue(math.isclose(prediction, 11.25, abs_tol=1e-10))

    # reject unsupported fitting leads and malformed row leads
    def test_training_rejects_unsupported_and_malformed_leads(self) -> None:
        """Fail closed rather than silently dropping invalid lead identities."""
        with self.assertRaisesRegex(ValueError, "exact archive lead"):
            ridge.training_rows([], "2025-01", 12)

        malformed = anchor_row(
            dt.datetime(2024, 1, 1, tzinfo=ridge.UTC),
            lead=None,
            key="malformed-lead",
        )
        with self.assertRaisesRegex(ValueError, "forecast lead"):
            ridge.training_rows([malformed], "2025-01", 24)


class TemperatureSeasonalRidgePredictionTest(unittest.TestCase):
    """Verify conservative correction and unchanged accepted long leads."""

    # apply the fixed half-strength bounded correction
    def test_correction_uses_fixed_half_strength_and_three_degree_clamp(self) -> None:
        """Apply the preregistered multiplier before symmetric clamping."""
        self.assertEqual(ridge.correction(4.0), 2.0)
        self.assertEqual(ridge.correction(-4.0), -2.0)
        self.assertEqual(ridge.correction(100.0), 3.0)
        self.assertEqual(ridge.correction(-100.0), -3.0)

        models = {24: model_for(24, offset=2.0), 48: model_for(48, offset=8.0)}
        row = anchor_row(
            dt.datetime(2025, 7, 1, 12, tzinfo=ridge.UTC), key="clamp-probe"
        )
        self.assertEqual(
            ridge.predict(row, models, 777.0, median_control=True), 11.0
        )
        row["targetLeadHours"] = 48
        self.assertEqual(
            ridge.predict(row, models, 777.0, median_control=True), 13.0
        )

    # clamp adjusted values to physical bounds
    def test_prediction_respects_physical_temperature_bounds(self) -> None:
        """Prevent bounded corrections from exceeding plausible output limits."""
        positive = {24: model_for(24, offset=100.0), 48: model_for(48, offset=100.0)}
        negative = {
            24: model_for(24, offset=-100.0),
            48: model_for(48, offset=-100.0),
        }
        hot = anchor_row(
            dt.datetime(2025, 7, 1, 12, tzinfo=ridge.UTC), key="hot-bound"
        )
        hot["rawTemperatureC"] = 69.0
        cold = dict(hot)
        cold["rawTemperatureC"] = -99.0

        self.assertEqual(
            ridge.predict(hot, positive, 0.0, median_control=True), 70.0
        )
        self.assertEqual(
            ridge.predict(cold, negative, 0.0, median_control=True), -100.0
        )

    # preserve longer-lead accepted predictions exactly
    def test_more_than_48_hours_is_exact_prior_passthrough(self) -> None:
        """Return the prior prediction before touching unavailable predictors or models."""
        for lead in (49, 72, 168):
            with self.subTest(lead=lead):
                self.assertEqual(
                    ridge.predict({"targetLeadHours": lead}, {}, -7.125), -7.125
                )

    # reject nonintegral and out-of-range prediction leads
    def test_predict_rejects_unsupported_and_malformed_leads(self) -> None:
        """Accept only integral leads from one through one hundred sixty-eight."""
        cases = (0, 169, 24.5, True, "24", float("nan"))

        # exercise every invalid scalar shape
        for lead in cases:
            with self.subTest(lead=lead):
                with self.assertRaises(ValueError):
                    ridge.predict({"targetLeadHours": lead}, {}, 0.0)

    # exclude labels from the prediction path
    def test_predictions_ignore_actual_and_target_labels(self) -> None:
        """Produce identical predictions despite arbitrary unavailable labels."""
        models = {24: model_for(24, offset=2.0), 48: model_for(48, offset=4.0)}
        row = anchor_row(
            dt.datetime(2025, 5, 1, 16, tzinfo=ridge.UTC), key="label-probe"
        )
        baseline = ridge.predict(row, models, 999.0, median_control=True)

        poisoned = dict(row)
        poisoned["actualTemperatureC"] = object()
        poisoned["targetTemperatureC"] = float("nan")
        self.assertEqual(
            ridge.predict(poisoned, models, 999.0, median_control=True), baseline
        )


class TemperatureSeasonalRidgeScoreTest(unittest.TestCase):
    """Verify the frozen equal-hour-then-equal-date score denominator."""

    # distinguish event, equal-hour, and equal-date arithmetic
    def test_score_balances_repeated_events_by_hour_then_local_date(self) -> None:
        """Average vintages within hours and hours within dates before final scoring."""
        records = [
            {
                "key": "date-one-hour-one-a",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 0.0,
            },
            {
                "key": "date-one-hour-one-b",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 2.0,
            },
            {
                "key": "date-one-hour-two",
                "validAt": "2025-01-01T09:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 5.0,
            },
            {
                "key": "date-two-hour-one",
                "validAt": "2025-01-02T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 1.0,
            },
        ]

        scored = ridge.score(records, ["prediction"])
        self.assertIsNotNone(scored)
        assert scored is not None
        self.assertEqual(scored["events"], 4)
        self.assertEqual(scored["dates"], 2)
        self.assertEqual(scored["validHours"], 3)

        prediction = scored["predictions"]["prediction"]
        self.assertTrue(math.isclose(prediction["equalDateMaeC"], 2.0))
        self.assertTrue(math.isclose(prediction["equalHourMaeC"], 7 / 3))
        self.assertTrue(math.isclose(prediction["eventMaeC"], 2.0))
        self.assertTrue(math.isclose(prediction["equalDateRmseC"], math.sqrt(7.25)))
        self.assertTrue(math.isclose(prediction["equalDateFractionAbove2C"], 0.25))

    # reject duplicate identities and preserve empty semantics
    def test_score_rejects_duplicate_keys_and_returns_null_for_empty_input(self) -> None:
        """Refuse denominator duplication and represent no population as null."""
        self.assertIsNone(ridge.score([], ["prediction"]))
        duplicate = {
            "key": "duplicate",
            "validAt": "2025-01-01T08:00:00.000Z",
            "actualTemperatureC": 0.0,
            "prediction": 0.0,
        }
        with self.assertRaisesRegex(ValueError, "duplicate score key"):
            ridge.score([duplicate, dict(duplicate)], ["prediction"])

    # reject contradictory labels for a shared physical hour
    def test_score_rejects_conflicting_actuals_at_the_same_valid_hour(self) -> None:
        """Require repeated forecast vintages to share one observed target."""
        first = {
            "key": "first-vintage",
            "validAt": "2025-01-01T08:00:00.000Z",
            "actualTemperatureC": 0.0,
            "prediction": 0.0,
        }
        second = dict(first)
        second["key"] = "second-vintage"
        second["actualTemperatureC"] = 1.0

        with self.assertRaisesRegex(ValueError, "conflicting actual"):
            ridge.score([first, second], ["prediction"])


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
