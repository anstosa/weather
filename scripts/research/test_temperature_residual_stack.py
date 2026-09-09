#!/usr/bin/env python3
"""Test the research-only seasonal residual-stack experiment."""

from __future__ import annotations

import copy
import datetime as dt
import json
import math
from pathlib import Path
import sys
import unittest

import numpy as np

# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import temperature_residual_stack as residual
import temperature_seasonal_ridge as base
import temperature_shortlead_models as short


# format one canonical millisecond utc instant
def utc_instant(value: dt.datetime) -> str:
    return value.astimezone(base.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one normalized residual-training row
def forecast_row(
    initialized_at: dt.datetime,
    lead: int,
    *,
    key: str,
    cohort: str = residual.COHORTS[0],
    horizon: int | None = None,
    raw: float | None = 10.0,
    actual: object = 13.0,
    prior_supported: bool = True,
    prior: float | None = 11.0,
    challenger_supported: bool = True,
    challenger: float | None = 13.0,
    cycle: str = "49r1",
) -> dict[str, object]:
    valid_at = initialized_at + dt.timedelta(hours=lead)
    prior_cutoff = initialized_at - dt.timedelta(days=10)
    challenger_cutoff = initialized_at - dt.timedelta(days=9)
    return {
        "key": key,
        "cohort": cohort,
        "runInitializedAt": utc_instant(initialized_at),
        "validAt": utc_instant(valid_at),
        "modelLeadHours": lead,
        "operationalHorizonHours": lead if horizon is None else horizon,
        "rawTemperatureC": raw,
        "rawRelativeHumidityPercent": 75.0,
        "rawWindSpeedMps": 2.0,
        "modelCycle": cycle,
        "actualTemperatureC": actual,
        "priorSupported": prior_supported,
        "priorTemperatureC": prior if prior_supported else None,
        "priorTrainingCutoffUtc": (
            utc_instant(prior_cutoff) if prior_supported else None
        ),
        "challengerSupported": challenger_supported,
        "challengerTemperatureC": challenger if challenger_supported else None,
        "challengerTrainingCutoffUtc": (
            utc_instant(challenger_cutoff) if challenger_supported else None
        ),
    }


# build one prior-residual state
def rolling_state(
    initialized_at: dt.datetime,
    *,
    cohort: str = residual.COHORTS[0],
    supported: bool = True,
    b24: float = 2.0,
    b72: float = 1.5,
) -> dict[str, object]:
    end = initialized_at - dt.timedelta(hours=7)
    n24 = 24 if supported else 5
    n72 = 72 if supported else 23
    return {
        "cohort": cohort,
        "targetRunInitializedAt": utc_instant(initialized_at),
        "windowEndValidAt": utc_instant(end),
        "supported": supported,
        "b24C": b24 if supported else None,
        "b72C": b72 if supported else None,
        "mad72C": 0.5 if supported else None,
        "n24": n24,
        "n72": n72,
        "localDates": 4 if supported else 1,
        "sourceKeys": [f"source-{index:02d}" for index in range(n72)],
        "maximumSourceValidAt": utc_instant(end),
        "maximumSourceRunInitializedAt": utc_instant(
            initialized_at - dt.timedelta(hours=8)
        ),
        "residualBasis": residual.POLICY["residualBasis"],
    }


# build one supported or cold-start model shell
def model_for(
    row: dict[str, object],
    *,
    scope: str = "initialization_first12",
    residual_supported: bool = True,
    blend_supported: bool = True,
    static_intercept: float = 2.0,
    adaptive_intercept: float = 2.0,
    alpha: float | None = 0.25,
) -> dict[str, object]:
    static = [0.0] * 10
    adaptive = [0.0] * 24
    static[0] = static_intercept
    adaptive[0] = adaptive_intercept
    initialized_at = base.instant(row["runInitializedAt"])
    cutoff = utc_instant(initialized_at - dt.timedelta(days=30))
    return {
        "contractVersion": residual.POLICY["contractVersion"],
        "month": base.instant(row["validAt"])
        .astimezone(base.ZONE)
        .strftime("%Y-%m"),
        "cohort": row["cohort"],
        "scope": scope,
        "residualSupported": residual_supported,
        "staticCoefficients": static if residual_supported else None,
        "adaptiveCoefficients": adaptive if residual_supported else None,
        "residualTrainingCutoffUtc": cutoff,
        "residualTrainingRows": 1000 if residual_supported else 0,
        "residualTrainingDates": 100 if residual_supported else 0,
        "residualFirstTrainingValidAt": None,
        "residualLastTrainingValidAt": None,
        "residualTrainingKeys": [],
        "blendSupported": blend_supported,
        "blendAlpha": alpha if blend_supported else None,
        "blendTrainingCutoffUtc": cutoff,
        "blendTrainingRows": 1000 if blend_supported else 0,
        "blendTrainingDates": 100 if blend_supported else 0,
        "blendFirstTrainingValidAt": None,
        "blendLastTrainingValidAt": None,
        "blendTrainingKeys": [],
    }


class TemperaturePriorStateTest(unittest.TestCase):
    """Verify causal state construction around prior predictions."""

    # calculate state errors against the prior rather than raw
    def test_build_prior_states_uses_prior_residuals_and_marks_basis(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        forecasts = [forecast_row(initialized_at, 1, key="target")]
        targets: list[dict[str, object]] = []

        # fill the complete causal window
        for age in range(72):
            valid_at = boundary - dt.timedelta(hours=age)
            forecasts.append(
                forecast_row(
                    valid_at - dt.timedelta(hours=7),
                    7,
                    key=f"source-{age:02d}",
                    raw=0.0,
                    prior=10.0,
                )
            )
            targets.append(
                {"validAt": utc_instant(valid_at), "actualTemperatureC": 12.0}
            )

        state = residual.build_prior_states(
            forecasts, targets, residual.COHORTS[0]
        )[utc_instant(initialized_at)]

        self.assertTrue(state["supported"])
        self.assertEqual(state["b24C"], 2.0)
        self.assertEqual(state["b72C"], 2.0)
        self.assertEqual(state["residualBasis"], "priorSeasonal")

    # preserve source selection when the latest prior is unavailable
    def test_build_prior_states_does_not_replace_missing_selected_prior(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        older = forecast_row(
            boundary - dt.timedelta(hours=8),
            8,
            key="older-supported",
            prior=9.0,
        )
        newer = forecast_row(
            boundary - dt.timedelta(hours=7),
            7,
            key="newer-unsupported",
            prior_supported=False,
        )

        state = residual.build_prior_states(
            [forecast_row(initialized_at, 1, key="target"), older, newer],
            [{"validAt": utc_instant(boundary), "actualTemperatureC": 12.0}],
            residual.COHORTS[0],
        )[utc_instant(initialized_at)]

        self.assertEqual(state["n72"], 0)
        self.assertEqual(state["sourceKeys"], [])

    # reject future-trained prior predictions before state construction
    def test_build_prior_states_rejects_malicious_future_prior(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 7, key="future-prior")
        row["priorTrainingCutoffUtc"] = row["runInitializedAt"]

        with self.assertRaisesRegex(ValueError, "prior cutoff"):
            residual.build_prior_states([row], [], residual.COHORTS[0])


class TemperatureResidualFeatureTest(unittest.TestCase):
    """Verify the frozen static and adaptive feature schemas."""

    # preserve exact feature order and prior-only state terms
    def test_features_match_frozen_schema_and_ignore_labels(self) -> None:
        initialized_at = dt.datetime(2025, 5, 4, 6, tzinfo=base.UTC)
        row = forecast_row(
            initialized_at,
            6,
            key="feature-row",
            raw=10.0,
            prior=13.0,
            cycle="50r1",
        )
        row["state"] = rolling_state(initialized_at)

        expected_static = np.asarray(
            [
                1.0,
                0.5,
                0.25,
                1.0,
                math.cos(math.pi / 2),
                math.sin(2 * math.pi * 5 / 24),
                math.cos(2 * math.pi * 5 / 24),
                1.0,
                0.5,
                1.0,
            ]
        )
        np.testing.assert_allclose(residual.static_features(row), expected_static)
        self.assertEqual(len(residual.adaptive_features(row)), 24)
        np.testing.assert_array_equal(
            residual.adaptive_features(row)[10:],
            short.adaptive_features(row)[35:],
        )

        poisoned = copy.deepcopy(row)
        poisoned["actualTemperatureC"] = object()
        np.testing.assert_array_equal(
            residual.adaptive_features(poisoned), residual.adaptive_features(row)
        )

    # reject raw-error state substitutions
    def test_adaptive_features_require_prior_residual_state(self) -> None:
        initialized_at = dt.datetime(2025, 5, 4, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="wrong-state")
        row["state"] = rolling_state(initialized_at)
        del row["state"]["residualBasis"]

        with self.assertRaisesRegex(ValueError, "residual basis"):
            residual.adaptive_features(row)


class TemperatureResidualFitTest(unittest.TestCase):
    """Verify causal selection, fitting, and independent arm support."""

    # generate one thousand synthetic earlier training events
    @staticmethod
    def synthetic_rows() -> list[dict[str, object]]:
        start = dt.datetime(2024, 1, 1, tzinfo=base.UTC)
        rows = []

        # represent one hundred dates with ten valid hours each
        for day in range(100):
            initialized_at = start + dt.timedelta(days=day)

            # vary leads while preserving the initialization scope
            for lead in range(1, 11):
                row = forecast_row(
                    initialized_at,
                    lead,
                    key=f"training-{day:03d}-{lead:02d}",
                )
                row["state"] = rolling_state(initialized_at)
                rows.append(row)

        return rows

    # fit deterministic residual vectors and a bounded blend
    def test_fit_is_deterministic_bounded_and_ignores_future_labels(self) -> None:
        rows = self.synthetic_rows()
        first = residual.fit(
            rows,
            "2025-01",
            residual.COHORTS[0],
            "initialization_first12",
        )
        future = forecast_row(
            dt.datetime(2026, 1, 1, tzinfo=base.UTC),
            1,
            key="future-poison",
            raw=1e100,
            actual=object(),
        )
        second = residual.fit(
            list(reversed(rows)) + [future],
            "2025-01",
            residual.COHORTS[0],
            "initialization_first12",
        )

        self.assertEqual(first, second)
        self.assertTrue(first["residualSupported"])
        self.assertTrue(first["blendSupported"])
        self.assertEqual(len(first["staticCoefficients"]), 10)
        self.assertEqual(len(first["adaptiveCoefficients"]), 24)
        self.assertTrue(0 <= first["blendAlpha"] <= 0.5)
        self.assertEqual(first["residualTrainingRows"], 1000)
        self.assertEqual(first["blendTrainingRows"], 1000)
        self.assertNotIn("future-poison", first["residualTrainingKeys"])
        json.dumps(first, allow_nan=False, sort_keys=True)

    # isolate providers and scopes before fitting labels
    def test_fit_ignores_foreign_provider_and_other_scope_rows(self) -> None:
        rows = self.synthetic_rows()
        baseline = residual.fit(
            rows,
            "2025-01",
            residual.COHORTS[0],
            "initialization_first12",
        )
        foreign = forecast_row(
            dt.datetime(2024, 1, 1, tzinfo=base.UTC),
            1,
            key="foreign-poison",
            cohort=residual.COHORTS[1],
            actual=object(),
        )
        foreign["runInitializedAt"] = "not-an-instant"
        delayed = forecast_row(
            dt.datetime(2024, 1, 1, tzinfo=base.UTC),
            18,
            key="delayed-poison",
            horizon=12,
            actual=object(),
        )
        comparison = residual.fit(
            rows + [foreign, delayed],
            "2025-01",
            residual.COHORTS[0],
            "initialization_first12",
        )

        self.assertEqual(comparison, baseline)

    # preserve residual support when the challenger lacks enough rows
    def test_fit_tracks_residual_and_blend_support_separately(self) -> None:
        rows = self.synthetic_rows()

        # remove one challenger while preserving residual support
        rows[0]["challengerSupported"] = False
        rows[0]["challengerTemperatureC"] = None
        rows[0]["challengerTrainingCutoffUtc"] = None
        model = residual.fit(
            rows,
            "2025-01",
            residual.COHORTS[0],
            "initialization_first12",
        )

        self.assertTrue(model["residualSupported"])
        self.assertFalse(model["blendSupported"])
        self.assertEqual(model["residualTrainingRows"], 1000)
        self.assertEqual(model["blendTrainingRows"], 999)
        self.assertIsNone(model["blendAlpha"])

    # reject selected rows with future-trained component predictions
    def test_fit_rejects_future_prior_and_challenger_cutoffs(self) -> None:
        row = self.synthetic_rows()[0]
        row["priorTrainingCutoffUtc"] = row["runInitializedAt"]

        with self.assertRaisesRegex(ValueError, "prior cutoff"):
            residual.fit(
                [row],
                "2025-01",
                residual.COHORTS[0],
                "initialization_first12",
            )

        row = self.synthetic_rows()[0]
        row["challengerTrainingCutoffUtc"] = row["runInitializedAt"]
        with self.assertRaisesRegex(ValueError, "challenger cutoff"):
            residual.fit(
                [row],
                "2025-01",
                residual.COHORTS[0],
                "initialization_first12",
            )


class TemperatureResidualPredictionTest(unittest.TestCase):
    """Verify exact fallbacks, caps, and causal identities."""

    # return the prior before validating anything outside the window
    def test_outside_window_returns_prior_before_other_validation(self) -> None:
        sentinel = object()

        # exercise adjacent and long accepted horizons
        for horizon in (0, 13, 49, 168):
            with self.subTest(horizon=horizon):
                self.assertIs(
                    residual.predict(
                        {"operationalHorizonHours": horizon},
                        None,
                        sentinel,
                        arm="not-an-arm",
                    ),
                    sentinel,
                )

    # preserve baseline and arm cold starts exactly
    def test_unsupported_components_return_exact_prior(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="cold-start")
        row["state"] = rolling_state(initialized_at)
        residual_cold = model_for(row, residual_supported=False)
        blend_cold = model_for(row, blend_supported=False)

        self.assertEqual(
            residual.predict(row, residual_cold, 11.0, "residual_static"),
            11.0,
        )
        self.assertEqual(
            residual.predict(row, blend_cold, 11.0, "conservative_blend"),
            11.0,
        )
        unused_challenger = dict(
            row, challengerTrainingCutoffUtc=row["runInitializedAt"]
        )
        unused_challenger["state"] = row["state"]
        self.assertEqual(
            residual.predict(
                unused_challenger,
                blend_cold,
                11.0,
                "conservative_blend",
            ),
            11.0,
        )

        absent = forecast_row(
            initialized_at,
            1,
            key="prior-absent",
            prior_supported=False,
        )
        absent["state"] = rolling_state(initialized_at, supported=False)
        sentinel = object()
        self.assertIs(
            residual.predict(
                absent,
                model_for(absent),
                sentinel,
                "residual_static",
            ),
            sentinel,
        )

    # apply half strength and the one-and-a-half-degree cap
    def test_residual_predictions_apply_frozen_cap(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="cap")
        row["state"] = rolling_state(initialized_at)
        positive = model_for(row, static_intercept=100.0)
        negative = model_for(row, adaptive_intercept=-100.0)

        self.assertEqual(
            residual.predict(row, positive, 11.0, "residual_static"), 12.5
        )
        self.assertEqual(
            residual.predict(row, negative, 11.0, "residual_adaptive"), 9.5
        )

    # fall back from unsupported adaptive state to static prediction
    def test_unsupported_state_returns_exact_static_prediction(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="state-cold")
        row["state"] = rolling_state(initialized_at, supported=False)
        model = model_for(
            row, static_intercept=1.25, adaptive_intercept=-5.0
        )

        self.assertEqual(
            residual.predict(row, model, 11.0, "residual_adaptive"),
            residual.predict(row, model, 11.0, "residual_static"),
        )

    # enforce causal prior and challenger provenance at prediction time
    def test_prediction_rejects_future_component_cutoffs(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="future-components")
        row["state"] = rolling_state(initialized_at)
        model = model_for(row)
        future_prior = dict(row, priorTrainingCutoffUtc=row["runInitializedAt"])
        future_prior["state"] = row["state"]

        with self.assertRaisesRegex(ValueError, "prior cutoff"):
            residual.predict(future_prior, model, 11.0, "residual_static")

        future_challenger = dict(
            row, challengerTrainingCutoffUtc=row["runInitializedAt"]
        )
        future_challenger["state"] = row["state"]
        with self.assertRaisesRegex(ValueError, "challenger cutoff"):
            residual.predict(
                future_challenger, model, 11.0, "conservative_blend"
            )

    # require model identity and bind the supplied prior value
    def test_prediction_rejects_identity_and_prior_mismatches(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="identity")
        row["state"] = rolling_state(initialized_at)
        model = model_for(row)

        with self.assertRaisesRegex(ValueError, "prior prediction"):
            residual.predict(row, model, 12.0, "residual_static")

        foreign = dict(model, cohort=residual.COHORTS[1])
        with self.assertRaisesRegex(ValueError, "cohort"):
            residual.predict(row, foreign, 11.0, "residual_static")

        delayed = dict(model, scope="assumed_delay6_next12")
        with self.assertRaisesRegex(ValueError, "scope"):
            residual.predict(row, delayed, 11.0, "residual_static")

    # apply only bounded supported challenger interpolation
    def test_blend_prediction_enforces_support_and_bounds(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="blend")
        row["state"] = rolling_state(initialized_at)

        self.assertEqual(
            residual.predict(
                row, model_for(row, alpha=0.25), 11.0, "conservative_blend"
            ),
            11.5,
        )
        with self.assertRaisesRegex(ValueError, "blend weight"):
            residual.predict(
                row, model_for(row, alpha=0.75), 11.0, "conservative_blend"
            )

        row["challengerSupported"] = False
        row["challengerTemperatureC"] = None
        row["challengerTrainingCutoffUtc"] = None
        self.assertEqual(
            residual.predict(
                row, model_for(row), 11.0, "conservative_blend"
            ),
            11.0,
        )


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
