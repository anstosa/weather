#!/usr/bin/env python3
"""Test the research-only ECMWF winner extensions."""

from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest

import numpy as np

# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import temperature_seasonal_ridge as base
import temperature_shortlead_models as short
import temperature_winner_extensions as winner


# format one canonical utc instant
def utc_instant(value):
    return value.astimezone(base.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one normalized ECMWF row
def forecast_row(
    initialized_at,
    lead,
    *,
    key,
    cohort=winner.ECMWF_ONLY,
    horizon=None,
    raw=10.0,
    actual=11.6,
    cycle="49r1",
    incumbent_supported=True,
    unscaled=2.0,
):
    valid_at = initialized_at + dt.timedelta(hours=lead)
    incumbent = None
    cutoff = None
    # attach one honest historical incumbent prediction
    if incumbent_supported:
        incumbent = short._adjust(base.number(raw), unscaled)
        cutoff = utc_instant(initialized_at - dt.timedelta(days=10))
    # preserve raw display during incumbent cold starts
    elif raw is not None:
        incumbent = raw
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
        "incumbentSupported": incumbent_supported,
        "incumbentTemperatureC": incumbent,
        "incumbentUnscaledCorrectionC": unscaled if incumbent_supported else None,
        "incumbentTrainingCutoffUtc": cutoff,
    }


# build one valid raw-residual state
def rolling_state(initialized_at, *, supported=True):
    end = initialized_at - dt.timedelta(hours=7)
    n24 = 24 if supported else 5
    n72 = 72 if supported else 23
    return {
        "cohort": winner.ECMWF_ONLY,
        "targetRunInitializedAt": utc_instant(initialized_at),
        "windowEndValidAt": utc_instant(end),
        "supported": supported,
        "b24C": 1.0 if supported else None,
        "b72C": 0.75 if supported else None,
        "mad72C": 0.25 if supported else None,
        "n24": n24,
        "n72": n72,
        "localDates": 4 if supported else 1,
        "sourceKeys": [f"state-{index:02d}" for index in range(n72)],
        "maximumSourceValidAt": utc_instant(end),
        "maximumSourceRunInitializedAt": utc_instant(
            initialized_at - dt.timedelta(hours=8)
        ),
    }


# attach same-run trajectories to normalized rows
def attach_trajectories(rows):
    trajectories = winner.build_trajectories(rows, winner.ECMWF_ONLY)
    # attach each frozen receipt by key
    for row in rows:
        # skip foreign rows excluded by construction
        if row.get("cohort") == winner.ECMWF_ONLY:
            row["trajectory"] = trajectories[row["key"]]
    return rows


# build a supported fitted-model shell
def model_for(row, *, trajectory_supported=True, strength_supported=True):
    initialized_at = base.instant(row["runInitializedAt"])
    cutoff = utc_instant(initialized_at - dt.timedelta(days=30))
    direct = [0.0] * 44
    adaptive = [0.0] * 58
    direct[0] = 4.0
    adaptive[0] = -4.0
    bands = {}
    # construct both fixed strength bands
    for band in winner.HORIZON_BANDS:
        bands[band] = {
            "supported": strength_supported,
            "alpha": 0.8 if strength_supported else 0.5,
            "gridCosts": [],
            "trainingRows": 1200 if strength_supported else 0,
            "trainingDates": 200 if strength_supported else 0,
            "firstTrainingValidAt": None,
            "lastTrainingValidAt": None,
            "trainingKeys": [],
            "trainingCutoffUtc": cutoff,
        }
    return {
        "contractVersion": winner.POLICY["contractVersion"],
        "month": base.instant(row["validAt"])
        .astimezone(base.ZONE)
        .strftime("%Y-%m"),
        "cohort": winner.ECMWF_ONLY,
        "scope": "initialization_first12",
        "trajectorySupported": trajectory_supported,
        "trajectoryDirectCoefficients": direct if trajectory_supported else None,
        "trajectoryAdaptiveCoefficients": (
            adaptive if trajectory_supported else None
        ),
        "trajectoryTrainingRows": 1200 if trajectory_supported else 0,
        "trajectoryTrainingDates": 200 if trajectory_supported else 0,
        "trajectoryFirstTrainingValidAt": None,
        "trajectoryLastTrainingValidAt": None,
        "trajectoryTrainingKeys": [],
        "trainingCutoffUtc": cutoff,
        "strengthBands": bands,
    }


class TemperatureTrajectoryTest(unittest.TestCase):
    """Verify same-run trajectory construction and feature math."""

    # build a complete run with one raw-temperature function
    @staticmethod
    def run_rows(initialized_at, temperature, *, prefix="run"):
        rows = []
        # cover every normalized archive lead
        for lead in range(1, 19):
            rows.append(
                forecast_row(
                    initialized_at,
                    lead,
                    key=f"{prefix}-{lead:02d}",
                    raw=temperature(lead),
                )
            )
        return rows

    # verify boundary directions and linear trajectory scaling
    def test_linear_boundaries_use_fixed_forward_and_backward_stencils(self):
        initialized_at = dt.datetime(2025, 1, 1, tzinfo=base.UTC)
        rows = self.run_rows(initialized_at, lambda lead: 2.0 * lead)
        trajectories = winner.build_trajectories(rows, winner.ECMWF_ONLY)

        np.testing.assert_allclose(
            trajectories["run-01"]["features9"],
            [2 / 3, 2 / 3, 0, -1, 2, 1, 1, 1, 4 / 7],
        )
        np.testing.assert_allclose(
            trajectories["run-18"]["features9"],
            [2 / 3, 2 / 3, 0, 1, 2, 0, 0, -1, 4 / 7],
        )
        self.assertEqual(
            trajectories["run-01"]["sourceKeys"],
            ["run-01", "run-02", "run-03", "run-04", "run-07"],
        )
        self.assertEqual(
            trajectories["run-18"]["sourceKeys"],
            ["run-12", "run-15", "run-16", "run-17", "run-18"],
        )

    # verify quadratic curvature and centered-window statistics
    def test_quadratic_center_uses_known_derivatives_and_window_statistics(self):
        initialized_at = dt.datetime(2025, 1, 1, tzinfo=base.UTC)
        rows = self.run_rows(initialized_at, lambda lead: float(lead * lead))
        trajectories = winner.build_trajectories(rows, winner.ECMWF_ONLY)
        features = trajectories["run-09"]["features9"]

        np.testing.assert_allclose(
            features,
            [17 / 3, 5, 2, -4 / 3, 36, 0, 0, 0, 1],
        )
        self.assertAlmostEqual(trajectories["run-01"]["features9"][2], 2)
        self.assertAlmostEqual(trajectories["run-18"]["features9"][2], 2)

    # isolate runs, providers, ordering, outcomes, and missing source slots
    def test_sources_are_isolated_and_missing_slots_never_substitute(self):
        first_init = dt.datetime(2025, 1, 1, tzinfo=base.UTC)
        second_init = first_init + dt.timedelta(hours=6)
        first = self.run_rows(first_init, lambda lead: float(lead), prefix="first")
        second = self.run_rows(
            second_init, lambda lead: float(1000 + lead), prefix="second"
        )
        baseline = winner.build_trajectories(first, winner.ECMWF_ONLY)
        poisoned = copy.deepcopy(first + second)
        # outcomes must never participate in feature construction
        for row in poisoned:
            row["actualTemperatureC"] = object()
        foreign = {"cohort": short.COHORTS[1], "runInitializedAt": object()}
        comparison = winner.build_trajectories(
            list(reversed(poisoned)) + [foreign], winner.ECMWF_ONLY
        )

        self.assertEqual(comparison["first-01"], baseline["first-01"])
        missing = [row for row in first if row["modelLeadHours"] != 7]
        receipt = winner.build_trajectories(missing + second, winner.ECMWF_ONLY)[
            "first-01"
        ]
        self.assertFalse(receipt["supported"])
        self.assertIsNone(receipt["features9"])
        self.assertNotIn("second-07", receipt["sourceKeys"])

    # reject contradictory run slots, cycles, and invalid temperatures
    def test_build_rejects_duplicate_slots_cycle_drift_and_nonfinite_raw(self):
        initialized_at = dt.datetime(2025, 1, 1, tzinfo=base.UTC)
        rows = self.run_rows(initialized_at, float)
        duplicate = dict(rows[0], key="other-key")
        with self.assertRaisesRegex(ValueError, "duplicate forecast run and lead"):
            winner.build_trajectories(rows + [duplicate], winner.ECMWF_ONLY)

        changed_cycle = dict(rows[-1], modelCycle="50r1")
        with self.assertRaisesRegex(ValueError, "model cycle"):
            winner.build_trajectories(rows[:-1] + [changed_cycle], winner.ECMWF_ONLY)

        missing = copy.deepcopy(rows)
        missing[1]["rawTemperatureC"] = None
        receipt = winner.build_trajectories(missing, winner.ECMWF_ONLY)["run-01"]
        self.assertFalse(receipt["supported"])
        invalid = copy.deepcopy(rows)
        invalid[1]["rawTemperatureC"] = True
        with self.assertRaisesRegex(ValueError, "finite numeric"):
            winner.build_trajectories(invalid, winner.ECMWF_ONLY)

    # reject truncated supported trajectory receipts
    def test_trajectory_features_require_the_complete_frozen_stencil(self):
        initialized_at = dt.datetime(2025, 1, 1, tzinfo=base.UTC)
        rows = attach_trajectories(
            self.run_rows(initialized_at, float)
        )
        row = rows[0]
        row["trajectory"]["sourceKeys"] = row["trajectory"]["sourceKeys"][:-1]

        with self.assertRaisesRegex(ValueError, "source keys"):
            winner.trajectory_features(row)


class TemperatureWinnerFitTest(unittest.TestCase):
    """Verify augmented fitting and temporal strength calibration."""

    # generate two thousand four hundred scoped events across two hundred dates
    @staticmethod
    def synthetic_rows():
        start = dt.datetime(2024, 1, 1, tzinfo=base.UTC)
        scoped = []
        # represent enough dates for both independent horizon bands
        for day in range(200):
            initialized_at = start + dt.timedelta(days=day)
            run = []
            # provide the complete same-run trajectory source grid
            for lead in range(1, 19):
                raw = 8.0 + day / 100 + lead / 10
                row = forecast_row(
                    initialized_at,
                    lead,
                    key=f"training-{day:03d}-{lead:02d}",
                    raw=raw,
                    actual=raw + 1.6,
                    unscaled=2.0,
                )
                row["state"] = rolling_state(initialized_at)
                run.append(row)
            attach_trajectories(run)
            scoped.extend(run[:12])
        return scoped

    # fit deterministic augmented widths and select the true grid strength
    def test_fit_is_deterministic_weighted_and_future_label_immune(self):
        rows = self.synthetic_rows()
        first = winner.fit(
            rows,
            "2025-01",
            winner.ECMWF_ONLY,
            "initialization_first12",
        )
        future = forecast_row(
            dt.datetime(2026, 1, 1, tzinfo=base.UTC),
            1,
            key="future-poison",
            actual=object(),
        )
        second = winner.fit(
            list(reversed(rows)) + [future],
            "2025-01",
            winner.ECMWF_ONLY,
            "initialization_first12",
        )

        self.assertEqual(first, second)
        self.assertTrue(first["trajectorySupported"])
        self.assertEqual(len(first["trajectoryDirectCoefficients"]), 44)
        self.assertEqual(len(first["trajectoryAdaptiveCoefficients"]), 58)
        self.assertEqual(first["trajectoryTrainingRows"], 2400)
        # both bands independently see twelve hundred events and two hundred dates
        for band in winner.HORIZON_BANDS:
            self.assertTrue(first["strengthBands"][band]["supported"])
            self.assertEqual(first["strengthBands"][band]["alpha"], 0.8)
            self.assertEqual(first["strengthBands"][band]["trainingRows"], 1200)
            self.assertGreaterEqual(first["strengthBands"][band]["trainingDates"], 200)
            self.assertEqual(len(first["strengthBands"][band]["gridCosts"]), 5)
        self.assertNotIn("future-poison", first["trajectoryTrainingKeys"])
        json.dumps(first, sort_keys=True, allow_nan=False)

    # preserve trajectory support independently from incumbent support
    def test_fit_tracks_independent_support_and_threshold_fallback(self):
        rows = self.synthetic_rows()
        # remove all incumbent support from the first band only
        for row in rows:
            # isolate the first six operational hours
            if row["operationalHorizonHours"] <= 6:
                row["incumbentSupported"] = False
                row["incumbentTemperatureC"] = row["rawTemperatureC"]
                row["incumbentUnscaledCorrectionC"] = None
                row["incumbentTrainingCutoffUtc"] = None
        model = winner.fit(
            rows,
            "2025-01",
            winner.ECMWF_ONLY,
            "initialization_first12",
        )

        self.assertTrue(model["trajectorySupported"])
        self.assertFalse(model["strengthBands"]["1-6"]["supported"])
        self.assertEqual(model["strengthBands"]["1-6"]["alpha"], 0.5)
        self.assertEqual(model["strengthBands"]["1-6"]["gridCosts"], [])
        self.assertTrue(model["strengthBands"]["7-12"]["supported"])

    # reject selected rows carrying future-trained incumbent provenance
    def test_fit_rejects_future_incumbent_provenance(self):
        rows = self.synthetic_rows()
        rows[0]["incumbentTrainingCutoffUtc"] = rows[0]["runInitializedAt"]

        with self.assertRaisesRegex(ValueError, "incumbent cutoff"):
            winner.fit(
                rows,
                "2025-01",
                winner.ECMWF_ONLY,
                "initialization_first12",
            )


class TemperatureWinnerPredictionTest(unittest.TestCase):
    """Verify exact fallbacks, identities, and bounded predictions."""

    # build one prediction-ready row and receipt
    @staticmethod
    def ready_row(*, lead=1, state_supported=True, unscaled=2.0, raw=10.0):
        initialized_at = dt.datetime(2025, 1, 10, tzinfo=base.UTC)
        rows = []
        # build the complete same-run trajectory grid
        for source_lead in range(1, 19):
            rows.append(
                forecast_row(
                    initialized_at,
                    source_lead,
                    key=f"ready-{source_lead:02d}",
                    raw=raw + source_lead / 10,
                    unscaled=unscaled,
                )
            )
        attach_trajectories(rows)
        row = rows[lead - 1]
        row["state"] = rolling_state(initialized_at, supported=state_supported)
        return row

    # preserve outer horizons and foreign providers before other validation
    def test_outer_horizons_and_foreign_provider_are_exact_passthroughs(self):
        sentinel = object()
        # exercise both adjacent and long outer horizons
        for horizon in (0, 13, 49, 168):
            with self.subTest(horizon=horizon):
                self.assertIs(
                    winner.predict(
                        {"operationalHorizonHours": horizon},
                        None,
                        sentinel,
                        "not-an-arm",
                    ),
                    sentinel,
                )
        self.assertIs(
            winner.predict(
                {"cohort": short.COHORTS[1]},
                None,
                sentinel,
                "not-an-arm",
            ),
            sentinel,
        )

    # apply direct or adaptive trajectory schemas from raw
    def test_trajectory_uses_state_specific_schema_and_fixed_cap(self):
        direct_row = self.ready_row(state_supported=False)
        adaptive_row = self.ready_row(state_supported=True)

        self.assertEqual(
            winner.predict(
                direct_row,
                model_for(direct_row),
                direct_row["incumbentTemperatureC"],
                "trajectory",
            ),
            direct_row["rawTemperatureC"] + 2,
        )
        self.assertEqual(
            winner.predict(
                adaptive_row,
                model_for(adaptive_row),
                adaptive_row["incumbentTemperatureC"],
                "trajectory",
            ),
            adaptive_row["rawTemperatureC"] - 2,
        )

    # use the current row correction with its learned horizon strength
    def test_strength_uses_current_unscaled_correction_and_caps_output(self):
        row = self.ready_row(unscaled=4.0)
        model = model_for(row)

        self.assertEqual(
            winner.predict(
                row,
                model,
                row["incumbentTemperatureC"],
                "learned_strength",
            ),
            row["rawTemperatureC"] + 3,
        )

    # preserve all unsupported model, trajectory, and incumbent cases exactly
    def test_unsupported_components_return_exact_incumbent(self):
        row = self.ready_row()
        sentinel = row["incumbentTemperatureC"]
        malformed_trajectory = dict(row, trajectory=object())
        self.assertIs(
            winner.predict(
                malformed_trajectory,
                model_for(row, trajectory_supported=False),
                sentinel,
                "trajectory",
            ),
            sentinel,
        )
        unsupported_trajectory = copy.deepcopy(row)
        unsupported_trajectory["trajectory"]["supported"] = False
        unsupported_trajectory["trajectory"]["features9"] = None
        self.assertIs(
            winner.predict(
                unsupported_trajectory,
                model_for(row),
                sentinel,
                "trajectory",
            ),
            sentinel,
        )
        self.assertIs(
            winner.predict(
                row,
                model_for(row, strength_supported=False),
                sentinel,
                "learned_strength",
            ),
            sentinel,
        )
        cold = copy.deepcopy(row)
        cold["incumbentSupported"] = False
        cold["incumbentTemperatureC"] = cold["rawTemperatureC"]
        cold["incumbentUnscaledCorrectionC"] = None
        cold["incumbentTrainingCutoffUtc"] = None
        cold_sentinel = object()
        self.assertIs(
            winner.predict(cold, model_for(cold), cold_sentinel, "trajectory"),
            cold_sentinel,
        )

    # reject future model and incumbent provenance plus identity mismatches
    def test_prediction_rejects_future_provenance_and_identity_drift(self):
        row = self.ready_row()
        model = model_for(row)
        future_incumbent = dict(
            row, incumbentTrainingCutoffUtc=row["runInitializedAt"]
        )
        with self.assertRaisesRegex(ValueError, "incumbent cutoff"):
            winner.predict(
                future_incumbent,
                model,
                row["incumbentTemperatureC"],
                "learned_strength",
            )

        future_model = copy.deepcopy(model)
        future_model["trainingCutoffUtc"] = row["runInitializedAt"]
        with self.assertRaisesRegex(ValueError, "model cutoff"):
            winner.predict(
                row,
                future_model,
                row["incumbentTemperatureC"],
                "trajectory",
            )

        with self.assertRaisesRegex(ValueError, "row provenance"):
            winner.predict(row, model, 999.0, "trajectory")


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
