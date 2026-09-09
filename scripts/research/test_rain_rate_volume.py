#!/usr/bin/env python3
"""test frozen out-of-sample rain-rate volume calibrations."""

from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest


# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import rain_rate_volume as model


# build one retained native v1 prediction row
def row(
    valid_at: dt.datetime,
    *,
    key: str,
    cohort: str = "ecmwf_single_run_hindcast",
    lead: int = 12,
    raw: float = 0.3,
    blend: float = 0.2,
    actual: object = 0.25,
    supported: bool = True,
    record_kind: str = "native",
) -> dict[str, object]:
    """build one retained v1 prediction and provenance row."""
    reference_at = valid_at - dt.timedelta(hours=lead)
    issue_month = reference_at.astimezone(model.shared.ZONE).strftime("%Y-%m")
    band = model.shared.lead_band(
        {
            "targetLeadHours": lead,
        }
    )
    predictions = {
        "raw": raw,
        "zero": 0.0,
        "tweedieBlend": blend if supported else raw,
        "intensityGuard": (
            model.base.intensity_guard(raw, blend) if supported else raw
        ),
    }
    return {
        "key": key,
        "cohort": cohort,
        "validAt": model.shared.format_instant(valid_at),
        "referenceAt": model.shared.format_instant(reference_at),
        "targetLeadHours": lead,
        "rawPrecipitationMm": raw,
        "actualPrecipitationMm": actual,
        "liquidOnly": True,
        "predictions": predictions,
        "recordKind": record_kind,
        "modelSupported": supported,
        "modelIdentity": [issue_month, cohort, band],
        "trainingCutoffUtc": model.shared.format_instant(
            model.shared.month_start(issue_month)
            - dt.timedelta(hours=model.POLICY["embargoHours"])
        ),
    }


# build exactly sixty dates and five hundred forty independent hours
def source_rows(
    *,
    raw: float = 0.3,
    blend: float = 0.2,
    actual: float = 0.25,
) -> list[dict[str, object]]:
    """build one adequately supported causal calibration population."""
    start = dt.datetime(2025, 3, 1, 12, tzinfo=model.shared.UTC)
    result: list[dict[str, object]] = []
    # represent each local date with nine independent hours
    for day in range(60):
        # keep every hour in one literal lead band
        for hour in range(9):
            valid_at = start + dt.timedelta(days=day, hours=hour)
            result.append(
                row(
                    valid_at,
                    key=f"source-{day:02d}-{hour}",
                    raw=raw,
                    blend=blend,
                    actual=actual,
                )
            )
    return result


# build one current row for the target february state
def current_row(
    *,
    key: str = "current",
    raw: float = 0.3,
    blend: float = 0.2,
    supported: bool = True,
    cohort: str = "ecmwf_single_run_hindcast",
    lead: int = 12,
) -> dict[str, object]:
    """build one target-month retained base prediction."""
    return row(
        dt.datetime(2026, 2, 20, 20, tzinfo=model.shared.UTC),
        key=key,
        cohort=cohort,
        lead=lead,
        raw=raw,
        blend=blend,
        actual={"must": "remain unread"},
        supported=supported,
    )


class RainRateVolumeFitTest(unittest.TestCase):
    """verify roots, support, chronology, weighting, and fallbacks."""

    rows: list[dict[str, object]]
    state: dict[str, object]

    # fit one bounded synthetic baseline once
    @classmethod
    def setUpClass(cls) -> None:
        """fit one adequately supported deterministic calibration."""
        cls.rows = source_rows()
        cls.state = model.fit(
            cls.rows,
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

    # solve both weighted volume equations without score selection
    def test_weighted_monotone_roots_reach_both_frozen_targets(self) -> None:
        """recover exact neutral and observed-volume synthetic roots."""
        state = self.state
        neutral = state["arms"]["volumeNeutralGuard"]
        calibrated = state["arms"]["volumeCalibratedGuard"]

        self.assertEqual(state["contractVersion"], "rain-rate-volume-research/v1")
        self.assertEqual(state["baseVersion"], "rain-rate-tweedie-research/v1")
        self.assertFalse(state["productionEligible"])
        self.assertEqual(state["primaryCandidate"], "volumeCalibratedGuard")
        self.assertTrue(state["supportEligible"])
        self.assertEqual(state["sourceRows"], 540)
        self.assertEqual(state["sourceDates"], 60)
        self.assertEqual(state["sourceHours"], 540)
        self.assertEqual(state["sourceWetDates"], 60)
        self.assertEqual(state["sourceWetHours"], 540)
        self.assertEqual(state["sourceKeyCount"], 540)
        self.assertEqual(len(state["sourceKeySha256"]), 64)
        self.assertEqual(state["sourceWeightSum"], 60.0)
        self.assertAlmostEqual(state["effectiveSourceHours"], 540.0)
        self.assertTrue(neutral["supported"])
        self.assertTrue(calibrated["supported"])
        self.assertAlmostEqual(neutral["scale"], 1.5, places=12)
        self.assertAlmostEqual(calibrated["scale"], 1.25, places=12)
        self.assertLessEqual(
            abs(neutral["residual"]),
            model.POLICY["rootAbsoluteToleranceMmPerHour"]
            + model.POLICY["rootRelativeTolerance"] * neutral["targetMean"],
        )
        self.assertLessEqual(
            abs(calibrated["residual"]),
            model.POLICY["rootAbsoluteToleranceMmPerHour"]
            + model.POLICY["rootRelativeTolerance"] * calibrated["targetMean"],
        )
        json.dumps(state, allow_nan=False)

    # fail closed when the projected curve is unidentifiable
    def test_flat_projected_curve_returns_exact_raw_for_both_arms(self) -> None:
        """reject a supported plateau instead of inventing a scale."""
        state = model.fit(
            source_rows(raw=0.1, blend=0.0, actual=0.2),
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

        self.assertTrue(state["supportEligible"])
        # require both fixed targets to expose the same flat failure
        for candidate in model.VOLUME_CANDIDATES:
            with self.subTest(candidate=candidate):
                arm = state["arms"][candidate]
                self.assertFalse(arm["supported"])
                self.assertEqual(arm["reason"], "flat_volume_curve")
                self.assertIsNone(arm["scale"])
                self.assertEqual(arm["achievedMean"], state["sourceRawMean"])

    # preserve independent per-arm support at an unattainable observed target
    def test_unattainable_target_falls_back_without_disabling_other_arm(self) -> None:
        """keep the neutral root while calibrated volume falls back raw."""
        state = model.fit(
            source_rows(raw=0.3, blend=0.2, actual=0.8),
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )
        neutral = state["arms"]["volumeNeutralGuard"]
        calibrated = state["arms"]["volumeCalibratedGuard"]

        self.assertTrue(neutral["supported"])
        self.assertFalse(calibrated["supported"])
        self.assertEqual(
            calibrated["reason"], "target_outside_attainable_range"
        )
        self.assertIsNone(calibrated["scale"])
        self.assertEqual(calibrated["achievedMean"], state["sourceRawMean"])
        values = model.predict_many([current_row()], state)[0]
        self.assertAlmostEqual(values["volumeNeutralGuard"], 0.3)
        self.assertEqual(values["volumeCalibratedGuard"], values["raw"])

    # exclude unavailable or foreign labels before inspecting retained outcomes
    def test_ineligible_label_poisoning_is_inert(self) -> None:
        """retain the identical fit when ineligible labels are unreadable."""
        cutoff = model.shared.month_start("2026-02") - dt.timedelta(hours=168)
        future = row(cutoff, key="future", actual={"poison": True})
        future["predictions"] = {"poison": True}
        foreign = row(
            dt.datetime(2025, 3, 1, 12, tzinfo=model.shared.UTC),
            key="foreign",
            cohort="best_match_single_run_transfer",
            actual={"poison": True},
        )
        foreign["predictions"] = {"poison": True}
        transfer = row(
            dt.datetime(2025, 3, 1, 13, tzinfo=model.shared.UTC),
            key="transfer",
            actual={"poison": True},
            record_kind="ecmwf_to_best_match",
        )
        transfer["predictions"] = {"poison": True}
        unsupported = row(
            dt.datetime(2025, 3, 1, 14, tzinfo=model.shared.UTC),
            key="unsupported",
            actual={"poison": True},
            supported=False,
        )
        unsupported["predictions"] = {"poison": True}

        contaminated = model.fit(
            list(reversed(self.rows))
            + [future, foreign, transfer, unsupported],
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

        self.assertEqual(contaminated, self.state)

    # reject ambiguous selected keys and contradictory same-hour truth
    def test_selected_duplicates_and_contradictory_hour_labels_fail(self) -> None:
        """require unique source keys and one truth per valid hour."""
        duplicate = copy.deepcopy(self.rows[0])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            model.fit(
                self.rows + [duplicate],
                "2026-02",
                "ecmwf_single_run_hindcast",
                "001-012",
            )

        contradiction = copy.deepcopy(self.rows[0])
        contradiction["key"] = "contradictory-vintage"
        contradiction["actualPrecipitationMm"] = 0.75
        with self.assertRaisesRegex(ValueError, "contradictory"):
            model.fit(
                self.rows + [contradiction],
                "2026-02",
                "ecmwf_single_run_hindcast",
                "001-012",
            )

    # split hour weight across repeated forecast vintages
    def test_repeated_vintages_do_not_manufacture_support_or_shift_roots(self) -> None:
        """preserve independent-hour support and balanced volume targets."""
        repeated: list[dict[str, object]] = []
        # duplicate every forecast identity with a distinct source key
        for original in self.rows:
            repeated.append(original)
            clone = copy.deepcopy(original)
            clone["key"] = f"repeat-{original['key']}"
            repeated.append(clone)
        state = model.fit(
            repeated,
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

        self.assertEqual(state["sourceRows"], 1080)
        self.assertEqual(state["sourceHours"], self.state["sourceHours"])
        self.assertEqual(state["sourceDates"], self.state["sourceDates"])
        self.assertEqual(
            state["effectiveSourceHours"], self.state["effectiveSourceHours"]
        )
        self.assertEqual(state["sourceWeightSum"], self.state["sourceWeightSum"])
        self.assertEqual(state["sourceRawMean"], self.state["sourceRawMean"])
        self.assertEqual(state["sourceActualMean"], self.state["sourceActualMean"])
        self.assertEqual(state["arms"], self.state["arms"])

    # preserve caller-owned input objects throughout fitting
    def test_fit_does_not_mutate_source_rows(self) -> None:
        """leave every retained source input byte-equivalent by value."""
        supplied = copy.deepcopy(self.rows)
        expected = copy.deepcopy(supplied)

        model.fit(
            supplied,
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

        self.assertEqual(supplied, expected)

    # reject forged native model identities and in-sample base states
    def test_source_base_identity_and_cutoff_are_bound(self) -> None:
        """reject nonnative or in-sample selected v1 source predictions."""
        bad_identity = copy.deepcopy(self.rows[0])
        bad_identity["modelIdentity"] = [
            "2025-03",
            "best_match_single_run_transfer",
            "001-012",
        ]
        with self.assertRaisesRegex(ValueError, "identity"):
            model.fit(
                [bad_identity],
                "2026-02",
                "ecmwf_single_run_hindcast",
                "001-012",
            )

        bad_cutoff = copy.deepcopy(self.rows[0])
        bad_cutoff["trainingCutoffUtc"] = bad_cutoff["referenceAt"]
        with self.assertRaisesRegex(ValueError, "out of sample"):
            model.fit(
                [bad_cutoff],
                "2026-02",
                "ecmwf_single_run_hindcast",
                "001-012",
            )


class RainRateVolumePredictionTest(unittest.TestCase):
    """verify label-free native replay and category preservation."""

    state: dict[str, object]

    # fit one supported state for prediction checks
    @classmethod
    def setUpClass(cls) -> None:
        """fit one deterministic replay state."""
        cls.state = model.fit(
            source_rows(),
            "2026-02",
            "ecmwf_single_run_hindcast",
            "001-012",
        )

    # copy all four base arms and preserve every raw category
    def test_zero_and_all_threshold_categories_are_preserved(self) -> None:
        """retain zero, trace, wet, and both heavy classifications."""
        raw_values = (0.0, 0.05, 0.1, 0.9, 1.0, 2.0, 2.5, 500.0)
        rows = [
            current_row(
                key=f"threshold-{index}",
                raw=raw,
                blend=min(500.0, max(0.01, raw * 0.75)),
            )
            for index, raw in enumerate(raw_values)
        ]
        values = model.predict_many(rows, self.state)

        # validate inherited values and all guarded categories
        for supplied, predicted in zip(rows, values, strict=True):
            raw = supplied["predictions"]["raw"]
            for candidate in model.base.CANDIDATES:
                self.assertEqual(
                    predicted[candidate], supplied["predictions"][candidate]
                )
            for candidate in model.VOLUME_CANDIDATES:
                self.assertEqual(predicted[candidate] == 0.0, raw == 0.0)
                for threshold in (0.1, 1.0, 2.5):
                    self.assertEqual(
                        predicted[candidate] >= threshold,
                        raw >= threshold,
                    )

    # keep unsupported current base rows raw only for new arms
    def test_current_base_cold_start_disables_both_calibrations(self) -> None:
        """preserve exact raw new arms when the current v1 cell is unsupported."""
        supplied = current_row(raw=0.37, blend=0.2, supported=False)
        predicted = model.predict_many([supplied], self.state)[0]

        self.assertEqual(
            model.calibration_support(supplied, self.state),
            {
                "volumeNeutralGuard": False,
                "volumeCalibratedGuard": False,
            },
        )
        self.assertEqual(predicted["volumeNeutralGuard"], 0.37)
        self.assertEqual(predicted["volumeCalibratedGuard"], 0.37)

    # avoid reading any observed fields during support or prediction
    def test_prediction_is_label_free_and_input_is_immutable(self) -> None:
        """ignore poisoned outcome fields and preserve caller objects."""
        supplied = current_row()
        supplied["actualPrecipitationMm"] = {"not": "numeric"}
        supplied["liquidOnly"] = {"not": "boolean"}
        supplied["observation"] = {"not": "available"}
        expected = copy.deepcopy(supplied)

        support = model.calibration_support(supplied, self.state)
        predicted = model.predict_many([supplied], self.state)

        self.assertEqual(
            support,
            {
                "volumeNeutralGuard": True,
                "volumeCalibratedGuard": True,
            },
        )
        self.assertEqual(supplied, expected)
        self.assertEqual(len(predicted), 1)

    # disallow transfer, foreign cohort, band, and issue-month replay
    def test_prediction_binds_native_target_identity_without_transfer(self) -> None:
        """accept only the same native month, cohort, and literal band."""
        transfer = current_row()
        transfer["recordKind"] = "ecmwf_to_best_match"
        with self.assertRaisesRegex(ValueError, "native"):
            model.predict_many([transfer], self.state)

        foreign = current_row(
            cohort="best_match_single_run_transfer",
            key="foreign-current",
        )
        with self.assertRaisesRegex(ValueError, "does not match"):
            model.predict_many([foreign], self.state)

        other_band = current_row(lead=13, key="band-current")
        with self.assertRaisesRegex(ValueError, "does not match"):
            model.predict_many([other_band], self.state)

        other_month = row(
            dt.datetime(2026, 3, 20, 20, tzinfo=model.shared.UTC),
            key="march-current",
            actual={"must": "remain unread"},
        )
        with self.assertRaisesRegex(ValueError, "does not match"):
            model.predict_many([other_month], self.state)

    # reject duplicate target forecast keys
    def test_prediction_requires_unique_target_keys(self) -> None:
        """reject ambiguous repeated target identities."""
        supplied = current_row()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            model.predict_many([supplied, copy.deepcopy(supplied)], self.state)

    # replay strict json state and reject changed policy or arithmetic
    def test_serialized_replay_and_state_tamper_rejection(self) -> None:
        """preserve json replay while failing closed on state mutations."""
        supplied = current_row()
        restored = json.loads(json.dumps(self.state, allow_nan=False))

        self.assertEqual(
            model.predict_many([supplied], restored),
            model.predict_many([supplied], self.state),
        )
        tampered = []
        changed_bounds = copy.deepcopy(restored)
        changed_bounds["scaleBounds"] = [0.25, 2.0]
        tampered.append(changed_bounds)
        changed_cutoff = copy.deepcopy(restored)
        changed_cutoff["sourceCutoffUtc"] = "2026-01-24T08:00:00.000Z"
        tampered.append(changed_cutoff)
        changed_support = copy.deepcopy(restored)
        changed_support["sourceHours"] = 499
        tampered.append(changed_support)
        changed_identity = copy.deepcopy(restored)
        changed_identity["baseModelIdentity"][1] = "best_match_single_run_transfer"
        tampered.append(changed_identity)
        changed_residual = copy.deepcopy(restored)
        changed_residual["arms"]["volumeNeutralGuard"]["residual"] = 1.0
        tampered.append(changed_residual)
        changed_reason = copy.deepcopy(restored)
        changed_reason["arms"]["volumeNeutralGuard"]["supported"] = False
        changed_reason["arms"]["volumeNeutralGuard"]["reason"] = (
            "flat_volume_curve"
        )
        changed_reason["arms"]["volumeNeutralGuard"]["scale"] = None
        changed_reason["arms"]["volumeNeutralGuard"]["achievedMean"] = (
            changed_reason["sourceRawMean"]
        )
        changed_reason["arms"]["volumeNeutralGuard"]["residual"] = 0.0
        tampered.append(changed_reason)
        # reject every independently corrupted state
        for index, state in enumerate(tampered):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    model.predict_many([supplied], state)


# run only bounded synthetic calibrations
if __name__ == "__main__":
    unittest.main()
