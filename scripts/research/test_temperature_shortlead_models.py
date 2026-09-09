#!/usr/bin/env python3
"""Test the research-only provider-specific short-lead temperature models."""

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
import temperature_seasonal_ridge as base
import temperature_shortlead_models as shortlead


# format one canonical millisecond utc instant
def utc_instant(value: dt.datetime) -> str:
    return value.astimezone(base.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one normalized forecast row with an attached outcome
def forecast_row(
    initialized_at: dt.datetime,
    lead: int,
    *,
    key: str,
    cohort: str = shortlead.COHORTS[0],
    horizon: int | None = None,
    raw: float | None = 10.0,
    actual: object = 12.0,
    cycle: str = "49r1",
) -> dict[str, object]:
    valid_at = initialized_at + dt.timedelta(hours=lead)
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
    }


# build one internally consistent rolling state
def rolling_state(
    initialized_at: dt.datetime,
    *,
    cohort: str = shortlead.COHORTS[0],
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
    }


# build one supported or cold-start model shell
def model_for(
    row: dict[str, object],
    *,
    scope: str = "initialization_first12",
    supported: bool = True,
    direct_intercept: float = 2.0,
    adaptive_intercept: float = 2.0,
) -> dict[str, object]:
    direct = [0.0] * 35
    adaptive = [0.0] * 49
    direct[0] = direct_intercept
    adaptive[0] = adaptive_intercept
    initialized_at = base.instant(row["runInitializedAt"])
    return {
        "contractVersion": shortlead.POLICY["contractVersion"],
        "month": base.instant(row["validAt"])
        .astimezone(base.ZONE)
        .strftime("%Y-%m"),
        "cohort": row["cohort"],
        "scope": scope,
        "supported": supported,
        "directCoefficients": direct if supported else None,
        "adaptiveCoefficients": adaptive if supported else None,
        "medianOffsetC": 2.0 if supported else None,
        "trainingRows": 1000 if supported else 0,
        "trainingDates": 100 if supported else 0,
        "firstTrainingValidAt": None,
        "lastTrainingValidAt": None,
        "trainingCutoffUtc": utc_instant(initialized_at - dt.timedelta(days=10)),
        "trainingKeys": [],
    }


class TemperatureShortleadStateTest(unittest.TestCase):
    """Verify causal state construction and provider isolation."""

    # build a fully supported state from exact eligible slots
    def test_build_states_uses_latest_prior_source_through_exact_boundary(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        rows = [forecast_row(initialized_at, 1, key="target-run")]
        targets: list[dict[str, object]] = []

        # fill all seventy-two consecutive causal slots
        for age in range(72):
            valid_at = boundary - dt.timedelta(hours=age)
            source_init = valid_at - dt.timedelta(hours=7)
            rows.append(
                forecast_row(source_init, 7, key=f"selected-{age:02d}", raw=10.0)
            )
            targets.append(
                {"validAt": utc_instant(valid_at), "actualTemperatureC": 12.0}
            )

        # add an older losing vintage whose unusable predictor must not be read
        losing_init = boundary - dt.timedelta(hours=12)
        rows.append(
            forecast_row(
                losing_init,
                12,
                key="losing-older-vintage",
                raw=None,
            )
        )

        # add a source and outcome just after the seven-hour information boundary
        after_boundary = boundary + dt.timedelta(hours=1)
        rows.append(
            forecast_row(
                after_boundary - dt.timedelta(hours=7),
                7,
                key="after-boundary",
                raw=10.0,
            )
        )
        targets.append(
            {
                "validAt": utc_instant(after_boundary),
                "actualTemperatureC": 1e100,
            }
        )

        states = shortlead.build_states(rows, targets, shortlead.COHORTS[0])
        state = states[utc_instant(initialized_at)]

        self.assertTrue(state["supported"])
        self.assertEqual(state["n24"], 24)
        self.assertEqual(state["n72"], 72)
        self.assertEqual(state["b24C"], 2.0)
        self.assertEqual(state["b72C"], 2.0)
        self.assertEqual(state["mad72C"], 0.0)
        self.assertEqual(state["maximumSourceValidAt"], utc_instant(boundary))
        self.assertIn("selected-00", state["sourceKeys"])
        self.assertNotIn("losing-older-vintage", state["sourceKeys"])
        self.assertNotIn("after-boundary", state["sourceKeys"])

    # isolate state from future labels and foreign providers
    def test_build_states_ignores_future_labels_and_foreign_provider_rows(self) -> None:
        initialized_at = dt.datetime(2025, 2, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        rows = [forecast_row(initialized_at, 1, key="target-run")]
        targets = []

        # provide enough earlier source hours for supported state
        for age in range(72):
            valid_at = boundary - dt.timedelta(hours=age)
            rows.append(
                forecast_row(
                    valid_at - dt.timedelta(hours=7),
                    7,
                    key=f"source-{age:02d}",
                )
            )
            targets.append(
                {"validAt": utc_instant(valid_at), "actualTemperatureC": 12.0}
            )

        baseline = shortlead.build_states(rows, targets, shortlead.COHORTS[0])[
            utc_instant(initialized_at)
        ]
        changed_targets = copy.deepcopy(targets)
        changed_targets.append(
            {
                "validAt": utc_instant(boundary + dt.timedelta(hours=1)),
                "actualTemperatureC": -1e100,
            }
        )
        foreign = forecast_row(
            initialized_at,
            1,
            key="foreign-malformed-row",
            cohort=shortlead.COHORTS[1],
        )
        foreign["runInitializedAt"] = "not-an-instant"
        comparison = shortlead.build_states(
            rows + [foreign], changed_targets, shortlead.COHORTS[0]
        )[utc_instant(initialized_at)]

        self.assertEqual(comparison, baseline)

    # detect source duplication before reading any outcomes
    def test_build_states_rejects_duplicate_forecast_keys_before_errors(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 7, key="duplicate", raw=None)

        with self.assertRaisesRegex(ValueError, "duplicate forecast key"):
            shortlead.build_states(
                [row, dict(row)],
                [{"validAt": row["validAt"], "actualTemperatureC": object()}],
                shortlead.COHORTS[0],
            )

    # skip a selected null forecast without falling back to an older vintage
    def test_build_states_does_not_switch_vintages_after_selecting_null_raw(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        rows = [
            forecast_row(initialized_at, 1, key="target-run"),
            forecast_row(
                boundary - dt.timedelta(hours=8),
                8,
                key="older-finite",
                raw=9.0,
            ),
            forecast_row(
                boundary - dt.timedelta(hours=7),
                7,
                key="newer-null",
                raw=None,
            ),
        ]
        targets = [
            {"validAt": utc_instant(boundary), "actualTemperatureC": 12.0}
        ]

        state = shortlead.build_states(rows, targets, shortlead.COHORTS[0])[
            utc_instant(initialized_at)
        ]

        self.assertEqual(state["n72"], 0)
        self.assertEqual(state["sourceKeys"], [])
        self.assertIsNone(state["b72C"])

    # center dispersion on the raw median before clipping its exported bias
    def test_build_states_clips_extreme_median_after_mad_centering(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 12, tzinfo=base.UTC)
        boundary = initialized_at - dt.timedelta(hours=7)
        rows = [forecast_row(initialized_at, 1, key="target-run")]
        targets = []

        # create a raw median of twenty with zero raw-centered mad
        for age in range(72):
            valid_at = boundary - dt.timedelta(hours=age)
            error = 20.0 if age < 40 else 0.0
            rows.append(
                forecast_row(
                    valid_at - dt.timedelta(hours=7),
                    7,
                    key=f"extreme-{age:02d}",
                    raw=10.0,
                )
            )
            targets.append(
                {
                    "validAt": utc_instant(valid_at),
                    "actualTemperatureC": 10.0 + error,
                }
            )

        state = shortlead.build_states(rows, targets, shortlead.COHORTS[0])[
            utc_instant(initialized_at)
        ]

        self.assertEqual(state["b24C"], 6.0)
        self.assertEqual(state["b72C"], 6.0)
        self.assertEqual(state["mad72C"], 0.0)


class TemperatureShortleadFeatureTest(unittest.TestCase):
    """Verify the frozen static and adaptive feature schemas."""

    # preserve the exact feature counts and predictor-only behavior
    def test_features_are_finite_and_ignore_current_labels(self) -> None:
        initialized_at = dt.datetime(2025, 5, 4, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 7, key="feature-row")
        row["state"] = rolling_state(initialized_at)
        static = shortlead.static_features(row)
        adaptive = shortlead.adaptive_features(row)

        poisoned = copy.deepcopy(row)
        poisoned["actualTemperatureC"] = object()
        poisoned["targetTemperatureC"] = float("nan")

        self.assertEqual(len(static), 35)
        self.assertEqual(len(adaptive), 49)
        self.assertTrue(np.isfinite(static).all())
        self.assertTrue(np.isfinite(adaptive).all())
        np.testing.assert_array_equal(static, shortlead.static_features(poisoned))
        np.testing.assert_array_equal(adaptive, shortlead.adaptive_features(poisoned))
        self.assertEqual(static[-1], 0.0)

        era50 = dict(row)
        era50["modelCycle"] = "50r1"
        self.assertEqual(shortlead.static_features(era50)[-1], 1.0)

    # use model lead for static terms and operational horizon for state decay
    def test_scope_horizons_keep_static_lead_and_decay_horizon_distinct(self) -> None:
        initialized_at = dt.datetime(2025, 5, 4, 6, tzinfo=base.UTC)
        initialization = forecast_row(
            initialized_at, 7, key="initialization", horizon=7
        )
        delayed = forecast_row(initialized_at, 7, key="delayed", horizon=1)
        initialization["state"] = rolling_state(initialized_at)
        delayed["state"] = rolling_state(initialized_at)

        np.testing.assert_array_equal(
            shortlead.static_features(initialization),
            shortlead.static_features(delayed),
        )
        self.assertFalse(
            np.array_equal(
                shortlead.adaptive_features(initialization),
                shortlead.adaptive_features(delayed),
            )
        )


class TemperatureShortleadFitTest(unittest.TestCase):
    """Verify causal selection, weighting, cold starts, and deterministic fitting."""

    # generate one thousand synthetic earlier training events
    @staticmethod
    def synthetic_rows() -> list[dict[str, object]]:
        start = dt.datetime(2024, 1, 1, tzinfo=base.UTC)
        rows = []

        # represent one hundred dates with ten forecast-valid hours each
        for day in range(100):
            initialized_at = start + dt.timedelta(days=day)

            # vary exact leads while preserving the initialization scope
            for lead in range(1, 11):
                row = forecast_row(
                    initialized_at,
                    lead,
                    key=f"training-{day:03d}-{lead:02d}",
                )
                row["state"] = rolling_state(initialized_at)
                rows.append(row)

        return rows

    # select only the exact provider, scope, and causal cutoff population
    def test_training_rows_enforces_scopes_nulls_cutoff_and_sorted_keys(self) -> None:
        cutoff = base.month_start("2025-01") - dt.timedelta(hours=168)
        included_valid = cutoff - dt.timedelta(hours=7)
        included = forecast_row(
            included_valid - dt.timedelta(hours=1),
            1,
            key="z-included-at-boundary",
        )
        earlier = forecast_row(
            included_valid - dt.timedelta(days=1, hours=2),
            2,
            key="a-earlier",
        )
        excluded_after = forecast_row(
            included_valid,
            1,
            key="after-boundary",
        )
        null_actual = dict(earlier, key="null-actual", actualTemperatureC=None)
        null_raw = dict(earlier, key="null-raw", rawTemperatureC=None)
        foreign = dict(earlier, key="foreign", cohort=shortlead.COHORTS[1])

        selected = shortlead.training_rows(
            [included, earlier, excluded_after, null_actual, null_raw, foreign],
            "2025-01",
            shortlead.COHORTS[0],
            "initialization_first12",
        )

        self.assertEqual(
            [row["key"] for row in selected],
            ["a-earlier", "z-included-at-boundary"],
        )

        delayed = forecast_row(
            included_valid - dt.timedelta(hours=7),
            7,
            key="delayed-boundary",
            horizon=1,
        )
        self.assertEqual(
            shortlead.training_rows(
                [delayed],
                "2025-01",
                shortlead.COHORTS[0],
                "assumed_delay6_next12",
            ),
            [delayed],
        )

    # reject duplicate identities before consulting poison labels
    def test_training_rows_rejects_duplicates_before_outcome_use(self) -> None:
        initialized_at = dt.datetime(2026, 1, 1, tzinfo=base.UTC)
        future = forecast_row(
            initialized_at,
            1,
            key="duplicate-future",
            actual=object(),
        )

        with self.assertRaisesRegex(ValueError, "duplicate training key"):
            shortlead.training_rows(
                [future, dict(future)],
                "2025-01",
                shortlead.COHORTS[0],
                "initialization_first12",
            )

    # implement nested equal-date equal-hour equal-event weights
    def test_event_weights_balance_each_denominator_level(self) -> None:
        first = dt.datetime(2024, 1, 1, tzinfo=base.UTC)
        rows = [
            forecast_row(first, 1, key="date-one-hour-one-a"),
            forecast_row(first, 1, key="date-one-hour-one-b"),
            forecast_row(first, 2, key="date-one-hour-two"),
            forecast_row(first + dt.timedelta(days=1), 1, key="date-two"),
        ]

        np.testing.assert_array_equal(
            shortlead.event_weights(rows), np.array([0.25, 0.25, 0.5, 1.0])
        )

    # fit byte-identical direct and adaptive models on synthetic rows
    def test_fit_is_deterministic_and_excludes_future_label_mutation(self) -> None:
        rows = self.synthetic_rows()
        first = shortlead.fit(
            rows,
            "2025-01",
            shortlead.COHORTS[0],
            "initialization_first12",
        )
        future = forecast_row(
            dt.datetime(2026, 1, 1, tzinfo=base.UTC),
            1,
            key="future-poison",
            raw=1e100,
            actual=-1e100,
        )
        second = shortlead.fit(
            list(reversed(rows)) + [future],
            "2025-01",
            shortlead.COHORTS[0],
            "initialization_first12",
        )

        self.assertEqual(first, second)
        self.assertTrue(first["supported"])
        self.assertEqual(first["trainingRows"], 1000)
        self.assertGreaterEqual(first["trainingDates"], 60)
        self.assertEqual(len(first["directCoefficients"]), 35)
        self.assertEqual(len(first["adaptiveCoefficients"]), 49)
        self.assertEqual(first["medianOffsetC"], 2.0)
        self.assertEqual(first["trainingCutoffUtc"], "2024-12-25T08:00:00.000Z")
        self.assertNotIn("future-poison", first["trainingKeys"])
        json.dumps(first, allow_nan=False, sort_keys=True)

    # return explicit raw cold-start state below either support threshold
    def test_fit_returns_serializable_cold_start_without_coefficients(self) -> None:
        rows = self.synthetic_rows()[:999]
        model = shortlead.fit(
            rows,
            "2025-01",
            shortlead.COHORTS[0],
            "initialization_first12",
        )

        self.assertFalse(model["supported"])
        self.assertIsNone(model["directCoefficients"])
        self.assertIsNone(model["adaptiveCoefficients"])
        self.assertEqual(model["trainingRows"], 999)
        json.dumps(model, allow_nan=False, sort_keys=True)


class TemperatureShortleadPredictionTest(unittest.TestCase):
    """Verify composition, ablation arms, and fail-closed identities."""

    # preserve the prior exactly outside one through twelve hours
    def test_outside_window_returns_prior_before_other_validation(self) -> None:
        sentinel = object()

        # exercise both adjacent and long accepted forecast horizons
        for horizon in (0, 13, 49, 168):
            with self.subTest(horizon=horizon):
                self.assertIs(
                    shortlead.predict(
                        {"operationalHorizonHours": horizon},
                        None,
                        sentinel,
                        arm="not-an-arm",
                    ),
                    sentinel,
                )

    # force every arm to raw during model cold start
    def test_model_cold_start_returns_raw_for_every_arm(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="cold-start")
        model = model_for(row, supported=False)

        # verify learned arms and the median control share the gate
        for arm in shortlead.ARMS:
            with self.subTest(arm=arm):
                self.assertEqual(
                    shortlead.predict(row, model, 999.0, arm=arm), 10.0
                )

    # apply fixed shrinkage and three-degree caps across all controls
    def test_predictions_apply_frozen_shrinkage_caps_and_lag_decay(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="prediction")
        row["state"] = rolling_state(initialized_at, b24=6.0)
        model = model_for(
            row, direct_intercept=100.0, adaptive_intercept=-100.0
        )
        model["medianOffsetC"] = 100.0

        self.assertEqual(
            shortlead.predict(row, model, 999.0, arm="direct_mos"), 13.0
        )
        self.assertEqual(
            shortlead.predict(row, model, 999.0, arm="adaptive_mos"), 7.0
        )
        self.assertEqual(
            shortlead.predict(row, model, 999.0, arm="median_control"), 13.0
        )
        expected_lagged = 10.0 + 3.0 * math.exp(-1 / 12)
        self.assertTrue(
            math.isclose(
                shortlead.predict(row, model, 999.0, arm="lagged_bias"),
                expected_lagged,
            )
        )

    # fall back from unsupported adaptive state exactly to direct mos
    def test_unsupported_state_makes_adaptive_prediction_equal_direct(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="unsupported-state")
        row["state"] = rolling_state(initialized_at, supported=False)
        model = model_for(row, direct_intercept=2.75, adaptive_intercept=-2.75)

        direct = shortlead.predict(row, model, 999.0, arm="direct_mos")
        adaptive = shortlead.predict(row, model, 999.0, arm="adaptive_mos")

        self.assertEqual(adaptive, direct)
        self.assertEqual(
            shortlead.predict(row, model, 999.0, arm="lagged_bias"), 10.0
        )

    # exclude current outcomes from every pure prediction path
    def test_predictions_ignore_current_actual_labels(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="label-isolation")
        row["state"] = rolling_state(initialized_at)
        model = model_for(row)

        # verify all arms under arbitrary unavailable labels
        for arm in shortlead.ARMS:
            with self.subTest(arm=arm):
                baseline = shortlead.predict(row, model, 999.0, arm=arm)
                poisoned = copy.deepcopy(row)
                poisoned["actualTemperatureC"] = object()
                poisoned["targetTemperatureC"] = float("nan")
                self.assertEqual(
                    shortlead.predict(poisoned, model, 999.0, arm=arm),
                    baseline,
                )

    # reject provider scope cutoff and state-source mismatches
    def test_prediction_validates_model_and_state_causal_identity(self) -> None:
        initialized_at = dt.datetime(2025, 1, 10, 6, tzinfo=base.UTC)
        row = forecast_row(initialized_at, 1, key="identity")
        row["state"] = rolling_state(initialized_at)
        model = model_for(row)

        foreign_model = dict(model, cohort=shortlead.COHORTS[1])
        with self.assertRaisesRegex(ValueError, "cohort"):
            shortlead.predict(row, foreign_model, 0.0, arm="direct_mos")

        delayed_model = dict(model, scope="assumed_delay6_next12")
        with self.assertRaisesRegex(ValueError, "scope"):
            shortlead.predict(row, delayed_model, 0.0, arm="direct_mos")

        leaking_model = dict(model, trainingCutoffUtc=row["runInitializedAt"])
        with self.assertRaisesRegex(ValueError, "strictly precede"):
            shortlead.predict(row, leaking_model, 0.0, arm="direct_mos")

        leaking_state_row = copy.deepcopy(row)
        leaking_state_row["state"]["maximumSourceValidAt"] = utc_instant(
            initialized_at - dt.timedelta(hours=6)
        )
        with self.assertRaisesRegex(ValueError, "unavailable source"):
            shortlead.predict(
                leaking_state_row, model, 0.0, arm="adaptive_mos"
            )


class TemperatureShortleadScoreTest(unittest.TestCase):
    """Verify the unchanged deterministic scoring schema."""

    # preserve the frozen equal-date equal-hour equal-event metrics
    def test_score_delegates_to_frozen_schema_and_rejects_duplicates(self) -> None:
        records = [
            {
                "key": "first",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 0.0,
            },
            {
                "key": "second",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 2.0,
            },
            {
                "key": "third",
                "validAt": "2025-01-02T08:00:00.000Z",
                "actualTemperatureC": 0.0,
                "prediction": 1.0,
            },
        ]

        self.assertEqual(
            shortlead.score(records, ["prediction"]),
            base.score(records, ["prediction"]),
        )
        with self.assertRaisesRegex(ValueError, "duplicate score key"):
            shortlead.score([records[0], dict(records[0])], ["prediction"])


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
