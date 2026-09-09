#!/usr/bin/env python3
"""test the frozen research-only Tweedie rain-rate adjustment model."""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
import sys
import unittest

import numpy as np


# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rain_rate_model as model


# build one deterministic forecast and observed rain-rate row
def row(
    valid_at: dt.datetime,
    *,
    key: str,
    cohort: str = "ecmwf_single_run_hindcast",
    lead: int = 12,
    raw: float = 0.4,
    actual: object = 0.2,
) -> dict[str, object]:
    """build one model-ready synthetic rain row."""
    return {
        "key": key,
        "cohort": cohort,
        "validAt": model.shared.format_instant(valid_at),
        "referenceAt": model.shared.format_instant(
            valid_at - dt.timedelta(hours=lead)
        ),
        "targetLeadHours": lead,
        "rawRelativeHumidityPercent": 80.0,
        "rawTemperatureC": 10.0,
        "rawWindSpeedMps": 2.0,
        "rawCloudCoverPercent": 75.0,
        "rawPrecipitationMm": raw,
        "actualPrecipitationMm": actual,
        "liquidOnly": True,
    }


# create supported earlier history with distinct dates and hours
def training_rows() -> list[dict[str, object]]:
    """build two hundred local dates and twelve hundred valid hours."""
    start = dt.datetime(2023, 1, 1, 12, tzinfo=model.shared.UTC)
    result: list[dict[str, object]] = []
    # represent each local date with six independent valid hours
    for day in range(200):
        # retain varied but deterministic within-date intensity
        for hour in range(6):
            raw = 0.0 if hour == 0 else (hour + day % 3) / 10
            actual = (
                0.0
                if hour == 0
                else max(0.1, raw * 0.75 + (day % 5) / 100)
            )
            valid_at = start + dt.timedelta(days=day, hours=hour)
            result.append(
                row(
                    valid_at,
                    key=f"train-{day:03d}-{hour}",
                    raw=raw,
                    actual=actual,
                )
            )
    return result


class RainRateFitTest(unittest.TestCase):
    """verify support, chronology, isolation, weighting, and replay."""

    baseline_rows: list[dict[str, object]]
    baseline_model: dict[str, object]
    contaminated_model: dict[str, object]
    repeated_model: dict[str, object]

    # run three bounded real fits in the isolated runtime
    @classmethod
    def setUpClass(cls) -> None:
        """fit baseline, isolation, and repeated-vintage states once."""
        cls.baseline_rows = training_rows()
        cls.baseline_model = model.fit(
            cls.baseline_rows,
            "2025-01",
            "ecmwf_single_run_hindcast",
            "001-012",
        )
        cutoff = model.shared.month_start("2025-01") - dt.timedelta(hours=168)
        at_cutoff = row(cutoff, key="at-cutoff", actual=object())
        future = row(cutoff + dt.timedelta(days=1), key="future", actual=object())
        foreign = row(
            dt.datetime(2023, 1, 1, 12, tzinfo=model.shared.UTC),
            key="foreign",
            cohort="best_match_single_run_transfer",
            actual=object(),
        )
        cls.contaminated_model = model.fit(
            list(reversed(cls.baseline_rows)) + [at_cutoff, future, foreign],
            "2025-01",
            "ecmwf_single_run_hindcast",
            "001-012",
        )
        repeated = []
        # duplicate every vintage without adding independent valid hours
        for original in cls.baseline_rows:
            repeated.append(original)
            repeated.append({**original, "key": f"repeat-{original['key']}"})
        cls.repeated_model = model.fit(
            repeated,
            "2025-01",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

    # fit the complete frozen learner and retain portable state
    def test_supported_fit_has_causal_support_and_json_model(self) -> None:
        """record independent support, causal cutoff, and native model bytes."""
        state = self.baseline_model

        self.assertTrue(state["supported"])
        self.assertEqual(state["trainingRows"], 1200)
        self.assertEqual(state["trainingDates"], 200)
        self.assertEqual(state["trainingHours"], 1200)
        self.assertEqual(state["wetTrainingDates"], 200)
        self.assertEqual(state["wetTrainingHours"], 1000)
        self.assertEqual(state["trainingWeightSum"], 1200.0)
        self.assertEqual(state["effectiveTrainingHours"], 1200.0)
        self.assertLess(state["latestTrainingValidAt"], state["trainingCutoffUtc"])
        self.assertEqual(state["xgboostVersion"], "3.4.1")
        self.assertIsInstance(state["modelJson"], str)
        self.assertGreater(len(state["modelJson"]), 1000)
        json.dumps(state, allow_nan=False)

    # exclude cutoff, future, and foreign labels before reading them
    def test_fit_is_causal_and_cohort_isolated(self) -> None:
        """produce the identical fit despite poisoned unavailable labels."""
        self.assertEqual(self.contaminated_model, self.baseline_model)

    # keep repeated vintages from manufacturing effective support
    def test_repeated_forecasts_preserve_hour_weight_support(self) -> None:
        """split hour mass while retaining the same independent support."""
        self.assertEqual(self.repeated_model["trainingRows"], 2400)
        self.assertEqual(self.repeated_model["trainingHours"], 1200)
        self.assertEqual(
            self.repeated_model["effectiveTrainingHours"],
            self.baseline_model["effectiveTrainingHours"],
        )
        self.assertEqual(self.repeated_model["trainingWeightSum"], 1200.0)
        self.assertEqual(
            self.repeated_model["baseScore"], self.baseline_model["baseScore"]
        )

    # replay a serialized native model without refitting
    def test_xgboost_serialized_model_reload_replays_predictions(self) -> None:
        """preserve supported predictions through strict JSON round-trip."""
        probe = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=model.shared.UTC),
            key="replay-probe",
            raw=0.8,
            actual=object(),
        )
        expected = model.predict_many([probe], self.baseline_model)
        restored = json.loads(json.dumps(self.baseline_model, allow_nan=False))

        self.assertEqual(model.predict_many([probe], restored), expected)


class RainRateValidationTest(unittest.TestCase):
    """verify strict inputs and conservative unsupported behavior."""

    # reject duplicate fit identities even when one is outside the fit cell
    def test_fit_rejects_duplicate_keys(self) -> None:
        """reject ambiguous global keys before fitting."""
        first = row(
            dt.datetime(2023, 1, 1, 12, tzinfo=model.shared.UTC), key="same"
        )
        second = row(
            dt.datetime(2026, 1, 1, 12, tzinfo=model.shared.UTC), key="same"
        )

        with self.assertRaisesRegex(ValueError, "duplicate"):
            model.fit(
                [first, second],
                "2025-01",
                "ecmwf_single_run_hindcast",
                "001-012",
            )

    # reject malformed physical amounts and forecast covariates
    def test_rejects_malformed_nonfinite_and_nonliquid_rows(self) -> None:
        """fail closed on invalid raw inputs before a cold fallback."""
        base = row(
            dt.datetime(2023, 1, 1, 12, tzinfo=model.shared.UTC), key="base"
        )
        cases = [
            {**base, "key": "negative", "rawPrecipitationMm": -0.1},
            {**base, "key": "nan-raw", "rawPrecipitationMm": math.nan},
            {**base, "key": "nan-actual", "actualPrecipitationMm": math.nan},
            {**base, "key": "nan-humidity", "rawRelativeHumidityPercent": math.nan},
            {**base, "key": "nan-temperature", "rawTemperatureC": math.nan},
            {**base, "key": "negative-wind", "rawWindSpeedMps": -1.0},
            {**base, "key": "cloud", "rawCloudCoverPercent": 101.0},
            {**base, "key": "mixed", "liquidOnly": False},
        ]
        # check every malformed input separately
        for candidate in cases:
            with self.subTest(key=candidate["key"]):
                with self.assertRaises(ValueError):
                    model.fit(
                        [candidate],
                        "2025-01",
                        "ecmwf_single_run_hindcast",
                        "001-012",
                    )

    # ignore observed labels in forecast feature and prediction paths
    def test_inference_is_label_free_and_preserves_missing_covariates(self) -> None:
        """use current forecast inputs and native missing-value markers only."""
        probe = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=model.shared.UTC),
            key="label-free",
            actual=object(),
        )
        probe["rawTemperatureC"] = None
        probe["rawWindSpeedMps"] = None
        probe["rawCloudCoverPercent"] = None
        probe["liquidOnly"] = object()
        first = model.features(probe)
        poisoned = {**probe, "actualPrecipitationMm": {"unreadable": True}}
        second = model.features(poisoned)

        np.testing.assert_equal(first, second)
        self.assertTrue(np.isnan(first[3:6]).all())
        state = model.fit(
            [], "2025-01", "ecmwf_single_run_hindcast", "001-012"
        )
        self.assertEqual(model.predict_many([poisoned], state)[0]["raw"], 0.4)

    # return exact raw values for every unsupported adjustment candidate
    def test_cold_start_is_exact_raw_fallback_with_strict_raw_validation(self) -> None:
        """keep unsupported output conservative without accepting invalid rain."""
        state = model.fit(
            [], "2025-01", "ecmwf_single_run_hindcast", "001-012"
        )
        probe = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=model.shared.UTC),
            key="cold",
            raw=0.37,
            actual=object(),
        )

        self.assertEqual(
            model.predict_many([probe], state),
            [
                {
                    "raw": 0.37,
                    "zero": 0.0,
                    "tweedieBlend": 0.37,
                    "intensityGuard": 0.37,
                }
            ],
        )
        with self.assertRaises(ValueError):
            model.predict_many([{**probe, "rawPrecipitationMm": math.nan}], state)

    # reject tampered causal support metadata before fallback inference
    def test_model_state_rejects_noncausal_or_inconsistent_support(self) -> None:
        """fail closed when persisted cutoff or support counts are altered."""
        state = model.fit(
            [], "2025-01", "ecmwf_single_run_hindcast", "001-012"
        )
        probe = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=model.shared.UTC),
            key="tamper-probe",
            actual=object(),
        )

        with self.assertRaisesRegex(ValueError, "cutoff"):
            model.predict_many(
                [probe],
                {**state, "trainingCutoffUtc": "2024-12-25T09:00:00.000Z"},
            )
        with self.assertRaisesRegex(ValueError, "support"):
            model.predict_many([probe], {**state, "trainingHours": 1000})

    # bind native source, literal lead band, and issue month
    def test_native_and_transfer_source_month_binding(self) -> None:
        """allow only same-month same-band ECMWF to Best Match transfer."""
        native = model.fit(
            [], "2025-01", "ecmwf_single_run_hindcast", "001-012"
        )
        at = dt.datetime(2025, 1, 15, 12, tzinfo=model.shared.UTC)
        ecmwf = row(at, key="native")
        best_match = row(
            at,
            key="transfer",
            cohort="best_match_single_run_transfer",
        )

        self.assertEqual(model.predict_many([ecmwf], native)[0]["raw"], 0.4)
        self.assertEqual(
            model.predict_many([best_match], native, transfer=True)[0]["raw"],
            0.4,
        )
        with self.assertRaisesRegex(ValueError, "cohort"):
            model.predict_many([best_match], native)
        with self.assertRaisesRegex(ValueError, "issue month"):
            model.predict_many(
                [row(dt.datetime(2025, 2, 15, 12, tzinfo=model.shared.UTC), key="feb")],
                native,
            )
        with self.assertRaisesRegex(ValueError, "transfer"):
            model.predict_many([ecmwf], native, transfer=True)


class RainRateGuardTest(unittest.TestCase):
    """verify raw detection categories remain unchanged."""

    # project blends at every frozen threshold endpoint
    def test_guard_threshold_endpoints(self) -> None:
        """keep zero, wet, and both heavy classifications identical to raw."""
        self.assertEqual(model.intensity_guard(0.0, 10.0), 0.0)
        self.assertEqual(
            model.intensity_guard(0.05, 10.0), math.nextafter(0.1, -math.inf)
        )
        self.assertEqual(model.intensity_guard(0.1, 0.0), 0.1)
        self.assertEqual(
            model.intensity_guard(0.9, 10.0), math.nextafter(1.0, -math.inf)
        )
        self.assertEqual(model.intensity_guard(1.0, 0.0), 1.0)
        self.assertEqual(
            model.intensity_guard(2.0, 10.0), math.nextafter(2.5, -math.inf)
        )
        self.assertEqual(model.intensity_guard(2.5, 0.0), 2.5)
        self.assertEqual(model.intensity_guard(500.0, 500.0), 500.0)


# run only bounded synthetic fits
if __name__ == "__main__":
    unittest.main()
