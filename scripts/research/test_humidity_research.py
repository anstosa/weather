#!/usr/bin/env python3
"""Test the research-only causal relative-humidity calibration."""

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

# import the sibling research module without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import humidity_research as humidity


# format one canonical utc instant
def utc_instant(value):
    """format one timezone-aware datetime"""
    return value.astimezone(humidity.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# build one deterministic model-ready humidity row
def row(
    valid_at,
    *,
    key,
    lead=24,
    cohort="fixed_lead_anchor",
    residual=8.0,
    raw=70.0,
    reference_at=None,
):
    """build one synthetic forecast and observed label"""
    return {
        "key": key,
        "validAt": utc_instant(valid_at),
        "referenceAt": (
            None if reference_at is None else utc_instant(reference_at)
        ),
        "targetLeadHours": lead,
        "cohort": cohort,
        "rawRelativeHumidityPercent": raw,
        "actualRelativeHumidityPercent": raw + residual,
        "rawTemperatureC": 10.0,
        "rawWindSpeedMps": 2.0,
    }


# create sufficient earlier support in one cohort and lead band
def training_rows(
    *, cohort="fixed_lead_anchor", lead=24, residual=8.0, prefix="training"
):
    """build two hundred dates and one thousand rows"""
    start = dt.datetime(2023, 1, 1, tzinfo=humidity.UTC)
    rows = []
    # represent each local date with five valid hours
    for day in range(200):
        for hour in range(5):
            valid_at = start + dt.timedelta(days=day, hours=hour)
            reference_at = (
                valid_at - dt.timedelta(hours=lead)
                if cohort == "legacy_v4_retrieval_snapshot"
                else None
            )
            rows.append(
                row(
                    valid_at,
                    key=f"{prefix}-{day:03d}-{hour:02d}",
                    lead=lead,
                    cohort=cohort,
                    residual=residual,
                    reference_at=reference_at,
                )
            )
    return rows


class HumidityIdentityTest(unittest.TestCase):
    """Verify issue boundaries, literal bands, and predictor isolation."""

    # use explicit reference months across local month boundaries
    def test_issue_month_uses_reference_or_explicit_nominal_boundary(self):
        """distinguish real retrieval timing from fixed-anchor nominal timing"""
        retrieval = row(
            dt.datetime(2025, 2, 1, 8, 30, tzinfo=humidity.UTC),
            key="retrieval",
            lead=1,
            cohort="legacy_v4_retrieval_snapshot",
            reference_at=dt.datetime(2025, 2, 1, 7, 30, tzinfo=humidity.UTC),
        )
        fixed = dict(retrieval, key="fixed", cohort="fixed_lead_anchor")
        fixed["referenceAt"] = None

        self.assertEqual(humidity.issue_month(retrieval), "2025-01")
        self.assertEqual(humidity.issue_month(fixed), "2025-01")
        self.assertEqual(humidity.issue_boundary(retrieval)[1], "reference_at")
        self.assertEqual(
            humidity.issue_boundary(fixed)[1], "nominal_valid_minus_lead"
        )

    # normalize acquisition precision only before model-ready parsing
    def test_source_join_canonicalizes_seconds_without_loosening_model_parser(self):
        """preserve exact UTC instants while retaining strict model input"""
        source = "2024-03-14T01:00:00Z"

        self.assertEqual(
            humidity.canonical_source_instant(source),
            "2024-03-14T01:00:00.000Z",
        )
        with self.assertRaisesRegex(ValueError, "canonical utc"):
            humidity.instant(source)

    # keep labels out of the feature path
    def test_features_ignore_observed_labels_and_handle_missing_predictors(self):
        """derive ridge features only from forecast-time values and calendar"""
        probe = row(
            dt.datetime(2025, 3, 1, 12, tzinfo=humidity.UTC), key="probe"
        )
        probe["rawTemperatureC"] = None
        probe["rawWindSpeedMps"] = None
        first = humidity.features(probe)
        poisoned = dict(probe)
        poisoned["actualRelativeHumidityPercent"] = object()
        second = humidity.features(poisoned)

        np.testing.assert_array_equal(first, second)
        self.assertTrue(np.isfinite(first).all())

    # preserve the six literal lead bands
    def test_lead_bands_do_not_interpolate_fixed_anchors(self):
        """map every boundary to exactly one preregistered band"""
        expected = {
            1: "001-012",
            12: "001-012",
            13: "013-024",
            24: "013-024",
            25: "025-048",
            48: "025-048",
            49: "049-072",
            72: "049-072",
            73: "073-120",
            120: "073-120",
            121: "121-168",
            168: "121-168",
        }
        # verify every inclusive edge directly
        for lead, band in expected.items():
            with self.subTest(lead=lead):
                self.assertEqual(
                    humidity.lead_band(
                        row(
                            dt.datetime(2025, 1, 1, tzinfo=humidity.UTC),
                            key=f"lead-{lead}",
                            lead=lead,
                        )
                    ),
                    band,
                )


class HumidityFitTest(unittest.TestCase):
    """Verify causal fitting, cold starts, and cohort isolation."""

    # exclude embargo and future labels before reading outcomes
    def test_fit_is_earlier_only_and_ignores_poisoned_future_labels(self):
        """fit identically when cutoff and future labels are unreadable"""
        rows = training_rows()
        cutoff = humidity.month_start("2025-01") - dt.timedelta(hours=168)
        at_cutoff = row(cutoff, key="at-cutoff")
        future = row(cutoff + dt.timedelta(days=10), key="future")
        at_cutoff["actualRelativeHumidityPercent"] = object()
        future["actualRelativeHumidityPercent"] = object()

        first = humidity.fit(rows, "2025-01", "fixed_lead_anchor", "013-024")
        second = humidity.fit(
            list(reversed(rows)) + [at_cutoff, future],
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )

        self.assertEqual(first, second)
        self.assertTrue(first["supported"])
        self.assertEqual(first["trainingRows"], 1000)
        self.assertEqual(first["trainingDates"], 200)
        self.assertEqual(first["trainingCutoffUtc"], "2024-12-25T08:00:00.000Z")
        self.assertLess(first["lastTrainingValidAt"], first["trainingCutoffUtc"])

    # retain all unsupported predictions as raw
    def test_cold_start_stays_raw_without_dropping_rows(self):
        """return every candidate as raw below either support threshold"""
        probe = row(
            dt.datetime(2025, 1, 15, tzinfo=humidity.UTC),
            key="cold-probe",
            lead=12,
        )
        model = humidity.fit([], "2025-01", "fixed_lead_anchor", "001-012")

        self.assertFalse(model["supported"])
        self.assertEqual(
            humidity.predict(probe, model),
            {candidate: 70.0 for candidate in humidity.CANDIDATES},
        )

    # isolate forecast cohorts before residual fitting
    def test_forecast_cohorts_fit_separately(self):
        """prevent foreign-cohort residuals from changing a fitted model"""
        fixed = training_rows(residual=8.0, prefix="fixed")
        retrieval = training_rows(
            cohort="legacy_v4_retrieval_snapshot",
            residual=-20.0,
            prefix="retrieval",
        )
        fixed_model = humidity.fit(
            fixed + retrieval,
            "2025-01",
            "fixed_lead_anchor",
            "013-024",
        )
        retrieval_model = humidity.fit(
            fixed + retrieval,
            "2025-01",
            "legacy_v4_retrieval_snapshot",
            "013-024",
        )

        self.assertEqual(fixed_model["medianOffsetPercentagePoints"], 8.0)
        self.assertEqual(retrieval_model["medianOffsetPercentagePoints"], -20.0)
        probe = row(
            dt.datetime(2025, 1, 15, tzinfo=humidity.UTC), key="wrong-cohort"
        )
        with self.assertRaisesRegex(ValueError, "cohort does not match"):
            humidity.predict(probe, retrieval_model)

    # reuse source states only through labeled transfer contracts
    def test_transfer_reuses_source_fit_without_lowering_native_floor(self):
        """keep sparse targets raw natively while applying an earlier source model"""
        ecmwf = training_rows(
            cohort="ecmwf_single_run_hindcast",
            residual=10.0,
            prefix="ecmwf",
        )
        best_match = row(
            dt.datetime(2026, 4, 15, 12, tzinfo=humidity.UTC),
            key="best-match-target",
            cohort="best_match_single_run_transfer",
        )
        native = humidity.fit(
            ecmwf + [best_match],
            "2026-04",
            "best_match_single_run_transfer",
            "013-024",
        )
        source = humidity.fit(
            ecmwf + [best_match],
            "2026-04",
            "ecmwf_single_run_hindcast",
            "013-024",
        )

        self.assertFalse(native["supported"])
        self.assertTrue(source["supported"])
        self.assertEqual(humidity.predict(best_match, native)["medianBias"], 70.0)
        self.assertEqual(
            humidity.predict_transfer(
                best_match, source, "ecmwf_to_best_match"
            )["medianBias"],
            80.0,
        )
        with self.assertRaisesRegex(ValueError, "source model does not match"):
            humidity.predict_transfer(best_match, native, "ecmwf_to_best_match")

    # retain the full frozen Best Match transfer period
    def test_best_match_transfer_runs_april_second_through_september_sixth(self):
        """avoid silently restricting transfer evidence to April"""
        def best_match_target(local_date, key):
            """build one noon local Best Match target"""
            valid_at = dt.datetime.combine(
                local_date,
                dt.time(19),
                tzinfo=humidity.UTC,
            )
            return row(
                valid_at,
                key=key,
                cohort="best_match_single_run_transfer",
            )

        self.assertIsNone(
            humidity.transfer_for_row(
                best_match_target(dt.date(2026, 4, 1), "april-first")
            )
        )
        self.assertEqual(
            humidity.transfer_for_row(
                best_match_target(dt.date(2026, 5, 15), "may")
            ),
            "ecmwf_to_best_match",
        )
        self.assertEqual(
            humidity.transfer_for_row(
                best_match_target(dt.date(2026, 9, 6), "september-sixth")
            ),
            "ecmwf_to_best_match",
        )
        self.assertIsNone(
            humidity.transfer_for_row(
                best_match_target(dt.date(2026, 9, 7), "september-seventh")
            )
        )

    # map live-v4 leads to fixed 24h or 48h states without interpolation
    def test_live_v4_cross_lead_transfer_uses_literal_anchor_state(self):
        """apply the 24h source band to short live-v4 targets explicitly"""
        fixed = training_rows(residual=6.0, prefix="fixed-transfer")
        source = humidity.fit(
            fixed, "2025-01", "fixed_lead_anchor", "013-024"
        )
        target = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=humidity.UTC),
            key="live-v4-one-hour",
            lead=1,
            cohort="legacy_v4_retrieval_snapshot",
            reference_at=dt.datetime(2025, 1, 15, 11, tzinfo=humidity.UTC),
        )

        self.assertEqual(
            humidity.transfer_source(
                target, "fixed_anchor_24h_to_legacy_v4"
            ),
            ("fixed_lead_anchor", "013-024"),
        )
        self.assertEqual(
            humidity.predict_transfer(
                target, source, "fixed_anchor_24h_to_legacy_v4"
            )["medianBias"],
            76.0,
        )
        with self.assertRaisesRegex(ValueError, "outside the fixed 48h"):
            humidity.transfer_source(
                target, "fixed_anchor_48h_to_legacy_v4"
            )


class HumidityPredictionTest(unittest.TestCase):
    """Verify correction strength and physical output safety."""

    # cap corrections and clamp physical humidity
    def test_adjustment_cap_clamp_and_half_strength_ridge(self):
        """apply the ridge multiplier before the shared twenty-point cap"""
        probe = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=humidity.UTC),
            key="prediction",
            raw=95.0,
        )
        width = len(humidity.features(probe))
        model = {
            "contractVersion": humidity.POLICY["contractVersion"],
            "month": "2025-01",
            "cohort": "fixed_lead_anchor",
            "leadBand": "013-024",
            "supported": True,
            "medianOffsetPercentagePoints": 100.0,
            "hierarchyCoefficients": [
                {
                    "level": 1,
                    "season": None,
                    "month": None,
                    "daypart": None,
                    "coefficient": -100.0,
                }
            ],
            "ridgeCoefficients": [80.0] + [0.0] * (width - 1),
        }

        predicted = humidity.predict(probe, model)
        self.assertEqual(predicted["medianBias"], 100.0)
        self.assertEqual(predicted["hierarchy"], 75.0)
        self.assertEqual(predicted["ridge"], 100.0)
        self.assertEqual(humidity.adjusted(5.0, -100.0), 0.0)


class HumidityWeightAndScoreTest(unittest.TestCase):
    """Verify repeated-forecast weights and score aggregation."""

    # balance dates, then valid hours, then repeated forecasts
    def test_balanced_weights_do_not_overweight_forecast_vintages(self):
        """give both dates equal mass despite different hour and event counts"""
        rows = [
            row(
                dt.datetime(2025, 1, 1, 8, tzinfo=humidity.UTC), key="d1-h1-a"
            ),
            row(
                dt.datetime(2025, 1, 1, 8, tzinfo=humidity.UTC), key="d1-h1-b"
            ),
            row(
                dt.datetime(2025, 1, 1, 9, tzinfo=humidity.UTC), key="d1-h2"
            ),
            row(
                dt.datetime(2025, 1, 2, 8, tzinfo=humidity.UTC), key="d2-h1"
            ),
        ]

        np.testing.assert_array_equal(
            humidity.balanced_weights(rows), np.array([0.25, 0.25, 0.5, 1.0])
        )

    # collapse repeated vintages before hierarchy support checks
    def test_repeated_forecasts_cannot_activate_a_hierarchy_child(self):
        """measure effective support from independent valid hours"""
        valid_at = dt.datetime(2025, 1, 1, 8, tzinfo=humidity.UTC)
        repeats = [
            row(valid_at, key=f"repeat-{index}") for index in range(100)
        ]
        weights = humidity.balanced_weights(repeats)

        self.assertEqual(humidity.effective_valid_hour_count(repeats, weights), 1)
        self.assertIsNone(
            humidity.fit_hierarchy_cell(
                repeats,
                0.0,
                minimum_effective_events=50,
                pseudocount=50,
            )
        )

    # score equal valid hours before equal local dates
    def test_score_uses_equal_hour_then_equal_date_primary_metrics(self):
        """separate event multiplicity from the primary score denominator"""
        records = [
            {
                "key": "d1-h1-a",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualRelativeHumidityPercent": 50.0,
                "prediction": 50.0,
            },
            {
                "key": "d1-h1-b",
                "validAt": "2025-01-01T08:00:00.000Z",
                "actualRelativeHumidityPercent": 50.0,
                "prediction": 52.0,
            },
            {
                "key": "d1-h2",
                "validAt": "2025-01-01T09:00:00.000Z",
                "actualRelativeHumidityPercent": 50.0,
                "prediction": 55.0,
            },
            {
                "key": "d2-h1",
                "validAt": "2025-01-02T08:00:00.000Z",
                "actualRelativeHumidityPercent": 50.0,
                "prediction": 49.0,
            },
        ]

        scored = humidity.score(records, ("prediction",))
        prediction = scored["predictions"]["prediction"]
        self.assertTrue(
            math.isclose(prediction["equalDateMaePercentagePoints"], 2.0)
        )
        self.assertTrue(
            math.isclose(prediction["equalDateBiasPercentagePoints"], 1.0)
        )
        self.assertTrue(
            math.isclose(prediction["equalHourMaePercentagePoints"], 7 / 3)
        )


class HumidityEvaluationTest(unittest.TestCase):
    """Verify frozen windows and private row-level evidence."""

    # retain row predictions privately and report all arms without selection
    def test_evaluate_separates_complete_and_partial_windows(self):
        """write private rows while exposing aggregate coverage only"""
        training = training_rows()
        complete = row(
            dt.datetime(2025, 1, 15, 12, tzinfo=humidity.UTC),
            key="complete-secret-key",
        )
        partial = row(
            dt.datetime(2026, 9, 3, 12, tzinfo=humidity.UTC),
            key="partial-secret-key",
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "predictions.jsonl"
            report = humidity.evaluate(training + [complete, partial], destination)
            private_rows = [
                json.loads(line)
                for line in destination.read_text(encoding="utf-8").splitlines()
            ]

            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(len(private_rows), 2)
            self.assertEqual(
                report["completeMonths"]["byCohort"]["fixed_lead_anchor"][
                    "events"
                ],
                1,
            )
            self.assertEqual(
                report["partialSeptember"]["byCohort"]["fixed_lead_anchor"][
                    "events"
                ],
                1,
            )
            self.assertEqual(
                report["candidateSelection"], "none_preregistered_all_reported"
            )
            serialized = json.dumps(report, sort_keys=True)
            self.assertNotIn("complete-secret-key", serialized)
            self.assertNotIn("partial-secret-key", serialized)
            self.assertEqual(
                set(
                    report["completeMonths"]["byCohort"][
                        "fixed_lead_anchor"
                    ]["predictions"]
                ),
                set(humidity.CANDIDATES),
            )
            self.assertIn(
                "fixed_lead_anchor:2025-01",
                report["completeMonths"]["groups"]["cohortMonth"],
            )
            self.assertIn(
                "fixed_lead_anchor:winter",
                report["completeMonths"]["groups"]["cohortSeason"],
            )

    # prepare the full training population only once per evaluation
    def test_evaluate_reuses_one_validated_training_index(self):
        """avoid repeated full-history validation across monthly fits"""
        training = training_rows()
        targets = [
            row(
                dt.datetime(2025, month, 15, 12, tzinfo=humidity.UTC),
                key=f"target-{month}",
            )
            for month in (1, 2)
        ]
        original = humidity.prepare_training_rows
        calls = 0

        # count only full-history preparation calls
        def counted(rows):
            """delegate preparation while counting invocations"""
            nonlocal calls
            calls += 1
            return original(rows)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "predictions.jsonl"
            with mock.patch.object(humidity, "prepare_training_rows", counted):
                humidity.evaluate(training + targets, destination)

        self.assertEqual(calls, 1)

        # refuse to overwrite private row evidence
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "predictions.jsonl"
            destination.write_text("existing", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                humidity.evaluate(training + targets[:1], destination)


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
