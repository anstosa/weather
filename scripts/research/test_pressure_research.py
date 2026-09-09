#!/usr/bin/env python3
"""Test the research-only causal station-pressure calibration."""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import humidity_research as shared
import pressure_research as pressure


# format one canonical utc instant
def utc_instant(value):
    """format one timezone-aware datetime"""
    return value.astimezone(shared.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one deterministic model-ready pressure row
def row(
    valid_at,
    *,
    key,
    station="tempest-126537",
    cohort="fixed_lead_anchor",
    lead=24,
    raw=1000.0,
    residual=5.0,
    reference_at=None,
    elevation=100.0,
    forecast_change=None,
    actual_change=None,
):
    """build one synthetic absolute-pressure forecast and label"""
    return {
        "key": key,
        "cohort": cohort,
        "stationKey": station,
        "validAt": utc_instant(valid_at),
        "referenceAt": (
            None if reference_at is None else utc_instant(reference_at)
        ),
        "targetLeadHours": lead,
        "rawPressureHpa": raw,
        "actualPressureHpa": raw + residual,
        "rawTemperatureC": 10.0,
        "rawRelativeHumidityPercent": 75.0,
        "rawWindSpeedMps": 2.0,
        "forecastElevationM": elevation,
        "forecastPressureChange3h": forecast_change,
        "actualPressureChange3h": actual_change,
    }


# create one station's sufficient earlier support
def training_rows(
    *,
    station="tempest-126537",
    cohort="fixed_lead_anchor",
    lead=24,
    residual=5.0,
    prefix="training",
    elevation=100.0,
):
    """build two hundred dates and one thousand station rows"""
    start = dt.datetime(2023, 1, 1, tzinfo=shared.UTC)
    rows = []
    # represent each date with five valid hours
    for day in range(200):
        for hour in range(5):
            valid_at = start + dt.timedelta(days=day, hours=hour)
            reference_at = (
                None
                if cohort == "fixed_lead_anchor"
                else valid_at - dt.timedelta(hours=lead)
            )
            rows.append(
                row(
                    valid_at,
                    key=f"{prefix}-{day:03d}-{hour:02d}",
                    station=station,
                    cohort=cohort,
                    lead=lead,
                    residual=residual,
                    reference_at=reference_at,
                    elevation=elevation,
                )
            )
    return rows


class PressureFitTest(unittest.TestCase):
    """Verify target eligibility, causality, isolation, and cold starts."""

    # accept only Tempest-v2 absolute station targets
    def test_rejects_relative_or_unknown_pressure_providers(self):
        """prevent raw station levels from unrelated providers entering fits"""
        invalid = row(
            dt.datetime(2025, 1, 1, tzinfo=shared.UTC),
            key="relative-provider",
            station="netatmo-nearby",
        )
        with self.assertRaisesRegex(ValueError, "Tempest-v2"):
            pressure.forecast_identity(invalid)

    # exclude cutoff and future labels before reading outcomes
    def test_fit_is_earlier_only_and_station_specific(self):
        """fit independent offsets while ignoring unreadable embargoed labels"""
        first_station = training_rows(residual=5.0, prefix="first")
        second_station = training_rows(
            station="tempest-168853", residual=-8.0, prefix="second"
        )
        cutoff = shared.month_start("2025-01") - dt.timedelta(hours=168)
        poison = row(cutoff, key="future-poison")
        poison["actualPressureHpa"] = object()

        baseline = pressure.fit(
            first_station + second_station,
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )
        repeated = pressure.fit(
            list(reversed(first_station + second_station)) + [poison],
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )

        self.assertEqual(baseline, repeated)
        self.assertEqual(
            baseline["stations"]["tempest-126537"]["offsetHpa"], 5.0
        )
        self.assertEqual(
            baseline["stations"]["tempest-168853"]["offsetHpa"], -8.0
        )
        self.assertEqual(baseline["eligibleTrainingStations"], 2)
        self.assertEqual(baseline["trainingCutoffUtc"], "2024-12-25T08:00:00.000Z")

    # keep provider cohorts separate before fitting offsets
    def test_forecast_cohorts_do_not_pool(self):
        """prevent foreign forecast residuals from changing station alignment"""
        fixed = training_rows(residual=5.0, prefix="fixed")
        ecmwf = training_rows(
            cohort="ecmwf_single_run_hindcast",
            residual=-10.0,
            prefix="ecmwf",
        )
        fixed_model = pressure.fit(
            fixed + ecmwf,
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )
        ecmwf_model = pressure.fit(
            fixed + ecmwf,
            "2025-01",
            "ecmwf_single_run_hindcast",
            "013-024",
        )

        self.assertEqual(
            fixed_model["stations"]["tempest-126537"]["offsetHpa"], 5.0
        )
        self.assertEqual(
            ecmwf_model["stations"]["tempest-126537"]["offsetHpa"], -10.0
        )

    # preserve raw values for every unsupported station row
    def test_station_cold_start_stays_raw(self):
        """require the full row and date floor separately for each station"""
        supported = training_rows(prefix="supported")
        model = pressure.fit(
            supported,
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )
        cold = row(
            dt.datetime(2025, 1, 15, tzinfo=shared.UTC),
            key="cold-station",
            station="tempest-168853",
        )

        self.assertEqual(
            pressure.predict(cold, model),
            {candidate: 1000.0 for candidate in pressure.CANDIDATES},
        )


class PressurePredictionTest(unittest.TestCase):
    """Verify residual caps and elevation-gated transfer."""

    # apply fixed half strength and cap beyond station alignment
    def test_ridge_correction_is_half_strength_and_capped_at_three_hpa(self):
        """leave the station offset uncapped and bound only pooled residuals"""
        probe = row(
            dt.datetime(2025, 1, 15, tzinfo=shared.UTC), key="cap-probe"
        )
        width = len(pressure.features(probe))
        model = {
            "contractVersion": pressure.POLICY["contractVersion"],
            "month": "2025-01",
            "cohort": "fixed_lead_anchor",
            "leadBand": "013-024",
            "stations": {
                "tempest-126537": {
                    "supported": True,
                    "offsetHpa": 20.0,
                }
            },
            "ridgeCoefficients": [20.0] + [0.0] * (width - 1),
        }

        predicted = pressure.predict(probe, model)
        self.assertEqual(predicted["raw"], 1000.0)
        self.assertEqual(predicted["stationOffset"], 1020.0)
        self.assertEqual(predicted["ridge"], 1023.0)

    # require compatible source and target forecast elevations
    def test_transfer_is_non_refit_and_fails_cold_on_elevation_mismatch(self):
        """apply ECMWF state only when the Best Match elevation is compatible"""
        ecmwf = training_rows(
            cohort="ecmwf_single_run_hindcast",
            residual=5.0,
            prefix="source",
            elevation=100.0,
        )
        model = pressure.fit(
            ecmwf,
            "2026-04",
            "ecmwf_single_run_hindcast",
            "013-024",
        )
        valid_at = dt.datetime(2026, 4, 15, 12, tzinfo=shared.UTC)
        compatible = row(
            valid_at,
            key="compatible",
            cohort="best_match_single_run_transfer",
            reference_at=valid_at - dt.timedelta(hours=24),
            elevation=100.5,
        )
        mismatch = dict(compatible, key="mismatch", forecastElevationM=110.0)

        self.assertEqual(
            pressure.predict_transfer(compatible, model)["stationOffset"], 1005.0
        )
        self.assertEqual(
            pressure.predict_transfer(mismatch, model),
            {candidate: 1000.0 for candidate in pressure.CANDIDATES},
        )


class PressureScoreTest(unittest.TestCase):
    """Verify level weighting and same-run tendency metrics."""

    # give every station equal final score mass
    def test_level_score_balances_stations_dates_hours_and_vintages(self):
        """avoid overweighting stations or hours with repeated forecasts"""
        records = [
            {
                **row(
                    dt.datetime(2025, 1, 1, 8, tzinfo=shared.UTC),
                    key="s1-h1-a",
                    raw=1000,
                    residual=0,
                ),
                "prediction": 1000.0,
            },
            {
                **row(
                    dt.datetime(2025, 1, 1, 8, tzinfo=shared.UTC),
                    key="s1-h1-b",
                    raw=1000,
                    residual=0,
                ),
                "prediction": 1002.0,
            },
            {
                **row(
                    dt.datetime(2025, 1, 1, 9, tzinfo=shared.UTC),
                    key="s1-h2",
                    raw=1000,
                    residual=0,
                ),
                "prediction": 1005.0,
            },
            {
                **row(
                    dt.datetime(2025, 1, 2, 8, tzinfo=shared.UTC),
                    key="s2-h1",
                    station="tempest-168853",
                    raw=1000,
                    residual=0,
                ),
                "prediction": 999.0,
            },
        ]

        scored = pressure.score_levels(records, ("prediction",))
        metrics = scored["predictions"]["prediction"]
        self.assertTrue(math.isclose(metrics["equalStationDateMaeHpa"], 2.0))
        self.assertTrue(math.isclose(metrics["equalStationDateBiasHpa"], 1.0))
        self.assertTrue(
            math.isclose(metrics["equalStationDateRmseHpa"], math.sqrt(7.25))
        )

    # preserve pressure changes under a constant station offset
    def test_constant_offset_leaves_three_and_six_hour_errors_unchanged(self):
        """separate level alignment from true tendency skill"""
        reference = dt.datetime(2025, 1, 1, tzinfo=shared.UTC)
        raw_values = (1000.0, 1002.0, 999.0)
        actual_values = (1000.0, 1001.0, 1000.0)
        records = []
        # build one exact same-run sequence
        for index, lead in enumerate((1, 4, 7)):
            raw_value = raw_values[index]
            actual_value = actual_values[index]
            current = row(
                reference + dt.timedelta(hours=lead),
                key=f"run-{lead}",
                cohort="ecmwf_single_run_hindcast",
                lead=lead,
                raw=raw_value,
                residual=actual_value - raw_value,
                reference_at=reference,
                forecast_change=(
                    None if index == 0 else raw_value - raw_values[index - 1]
                ),
                actual_change=(
                    None if index == 0 else actual_value - actual_values[index - 1]
                ),
            )
            current["raw"] = raw_value
            current["stationOffset"] = raw_value + 10.0
            records.append(current)

        scored = pressure.score_changes(records, ("raw", "stationOffset"))
        self.assertEqual(scored["3h"]["pairs"], 2)
        self.assertEqual(scored["6h"]["pairs"], 1)
        self.assertEqual(
            scored["3h"]["predictions"]["raw"],
            scored["3h"]["predictions"]["stationOffset"],
        )
        self.assertEqual(
            scored["6h"]["predictions"]["raw"],
            scored["6h"]["predictions"]["stationOffset"],
        )

    # balance repeated runs within station valid hours
    def test_change_score_uses_station_date_hour_forecast_weighting(self):
        """prevent repeated run pairs from dominating pressure-change evidence"""
        def pair(station, local_date, valid_at, prediction, actual):
            """build one minimal paired-change scoring row"""
            return (
                station,
                local_date,
                valid_at,
                {"prediction": 0.0},
                {"prediction": prediction},
                actual,
            )

        pairs = [
            pair("s1", "2025-01-01", 1, 1.0, 1.0),
            pair("s1", "2025-01-01", 1, 3.0, 1.0),
            pair("s1", "2025-01-01", 2, 6.0, 1.0),
            pair("s2", "2025-01-02", 3, 0.0, 1.0),
        ]

        metrics = pressure.balanced_change_metrics(pairs, "prediction")
        self.assertTrue(math.isclose(metrics["maeHpa"], 2.0))
        self.assertTrue(math.isclose(metrics["biasHpa"], 1.0))
        self.assertTrue(math.isclose(metrics["rmseHpa"], math.sqrt(7.25)))


class PressureEvaluationTest(unittest.TestCase):
    """Verify private rows and aggregate alignment labeling."""

    # keep row identities out of the aggregate report
    def test_evaluate_writes_private_rows_and_labels_alignment(self):
        """retain predictions privately without overstating offset skill"""
        training = training_rows(prefix="evaluation")
        target = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=shared.UTC),
            key="private-pressure-key",
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "pressure.jsonl"
            report = pressure.evaluate(training + [target], destination)
            private = [
                json.loads(line)
                for line in destination.read_text(encoding="utf-8").splitlines()
            ]

            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(len(private), 1)
            self.assertEqual(
                report["stationOffsetInterpretation"],
                "station_height_sensor_alignment_not_true_forecast_skill",
            )
            self.assertEqual(
                report["completeMonths"]["byCohort"]["fixed_lead_anchor"][
                    "events"
                ],
                1,
            )
            self.assertNotIn("private-pressure-key", json.dumps(report))
            self.assertIn(
                "fixed_lead_anchor:2025-01",
                report["completeMonths"]["groups"]["cohortMonth"],
            )
            self.assertIn(
                "fixed_lead_anchor:winter",
                report["completeMonths"]["groups"]["cohortSeason"],
            )

    # prepare the full pressure population once per evaluation
    def test_evaluate_reuses_one_validated_training_index(self):
        """avoid repeated full-history validation across monthly pressure fits"""
        training = training_rows(prefix="indexed")
        targets = [
            row(
                dt.datetime(2025, month, 15, 12, tzinfo=shared.UTC),
                key=f"target-{month}",
            )
            for month in (1, 2)
        ]
        original = pressure.prepare_training_rows
        calls = 0

        # count only full-history preparation calls
        def counted(rows):
            """delegate preparation while counting invocations"""
            nonlocal calls
            calls += 1
            return original(rows)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "pressure.jsonl"
            with mock.patch.object(pressure, "prepare_training_rows", counted):
                pressure.evaluate(training + targets, destination)

        self.assertEqual(calls, 1)


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
