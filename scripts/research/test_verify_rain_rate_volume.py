"""exercise independent rain-rate volume calibration verification helpers."""

from __future__ import annotations

import datetime as dt
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import test_verify_rain_rate_research as v1_test
import verify_rain_rate_volume as verify


# construct one minimal retained V1 OOF prediction
def row(
    *,
    key: str = "row",
    valid: str = "2025-06-01T20:00:00.000Z",
    actual: float = 0.2,
    raw: float = 0.2,
    blend: float = 0.2,
    cohort: str = "fixed_lead_anchor",
    lead: int = 12,
    supported: bool = True,
    kind: str = "native",
) -> dict:
    """return one dependency-free calibration source row."""
    return {
        "key": key,
        "cohort": cohort,
        "validAt": valid,
        "referenceAt": None,
        "targetLeadHours": lead,
        "rawPrecipitationMm": raw,
        "actualPrecipitationMm": actual,
        "modelSupported": supported,
        "recordKind": kind,
        "predictions": {
            "raw": raw,
            "zero": 0.0,
            "tweedieBlend": blend,
            "intensityGuard": verify.intensity_guard(raw, blend),
        },
    }


# refresh one root receipt hash after an intentional fixture rewrite
def rehash(directory: Path, name: str) -> None:
    """make one adversarial rewrite outer-hash consistent."""
    receipt = json.loads((directory / "receipt.json").read_text())
    receipt["files"][name] = verify.base.digest(directory / name)
    v1_test.write_json(directory / "receipt.json", receipt)


# build one complete cold-start volume continuation artifact
def build_fixture(directory: Path) -> None:
    """write one internally consistent synthetic v2 evidence directory."""
    directory.mkdir()
    baseline = directory / "baseline"
    v1_test.build_fixture(baseline)
    base_predictions = v1_test.read_jsonl(baseline / "predictions.jsonl.gz")[:1]
    v1_test.write_jsonl(baseline / "predictions.jsonl.gz", base_predictions)
    base_report = json.loads((baseline / "report.json").read_text())
    base_report["predictionRows"] = 1
    base_report["periods"]["completeMonths"]["ecmwf_to_best_match"] = (
        verify.base.summarize([])
    )
    v1_test.write_json(baseline / "report.json", base_report)
    base_receipt = json.loads((baseline / "receipt.json").read_text())
    base_receipt["predictionRows"] = 1
    base_receipt["files"]["predictions.jsonl.gz"] = verify.base.digest(
        baseline / "predictions.jsonl.gz"
    )
    base_receipt["files"]["report.json"] = verify.base.digest(
        baseline / "report.json"
    )
    v1_test.write_json(baseline / "receipt.json", base_receipt)
    base_receipt_sha = verify.base.digest(baseline / "receipt.json")
    base_verification = {
        "schemaVersion": "rain-rate-independent-verification/v1",
        "verified": True,
        "productionEligible": False,
        "accuracyQualification": False,
        "fullDeterministicRefit": True,
        "retainedReceiptSha256": base_receipt_sha,
        "inputSha256": base_receipt["files"]["input.jsonl.gz"],
        "inputRows": 1,
        "predictionRows": 1,
        "modelCount": 2,
        "periodPredictionRows": {
            "completeMonths": {"native": 1, "ecmwf_to_best_match": 0},
            "partialSeptember": {"native": 0, "ecmwf_to_best_match": 0},
        },
    }
    v1_test.write_json(
        baseline / "independent-verification.json", base_verification
    )
    original = base_predictions[0]
    identity = (
        verify.base.issue_month(original),
        original["cohort"],
        verify.base.lead_band(original),
    )
    state = verify.reconstruct_state([original], *identity)
    v1_test.write_jsonl(directory / "calibration-models.jsonl.gz", [state])
    predictions = {
        **original["predictions"],
        "volumeNeutralGuard": original["rawPrecipitationMm"],
        "volumeCalibratedGuard": original["rawPrecipitationMm"],
    }
    supported = {
        "raw": True,
        "zero": True,
        "tweedieBlend": False,
        "intensityGuard": False,
        "volumeNeutralGuard": False,
        "volumeCalibratedGuard": False,
    }
    extension = {
        **original,
        "predictions": predictions,
        "candidateSupported": supported,
        "calibrationIdentity": list(identity),
        "calibrationCutoffUtc": state["sourceCutoffUtc"],
        "calibrationReasons": {
            "volumeNeutralGuard": "base_model_unsupported",
            "volumeCalibratedGuard": "base_model_unsupported",
        },
    }
    v1_test.write_jsonl(directory / "predictions.jsonl.gz", [extension])
    report = verify.reconstruct_report([extension], 1, base_receipt_sha)
    v1_test.write_json(directory / "report.json", report)
    source_dir = directory / "sources"
    source_dir.mkdir()
    source_names = {
        "run_rain_rate_volume.py",
        "rain_rate_volume.py",
        "run_rain_rate_research.py",
        "rain_rate_model.py",
        "rain_research.py",
        "humidity_research.py",
    }
    # retain every declared synthetic source snapshot
    for name in source_names:
        (source_dir / name).write_text(f"# synthetic {name}\n")
    source_hashes = {
        name: verify.base.digest(source_dir / name) for name in source_names
    }
    baseline_hashes = dict(base_receipt["files"])
    baseline_hashes["receipt.json"] = base_receipt_sha
    baseline_hashes["independent-verification.json"] = verify.base.digest(
        baseline / "independent-verification.json"
    )
    freeze = {
        "contractVersion": "rain-rate-volume-experiment/v1",
        "productionEligible": False,
        "policy": verify.POLICY,
        "continuationGates": verify.CONTINUATION_GATES,
        "baselineFilesSha256": baseline_hashes,
        "sourceSha256": source_hashes,
        "frozenAtUtc": "2026-09-09T00:00:00+00:00",
    }
    v1_test.write_json(directory / "freeze.json", freeze)
    files = {
        name: verify.base.digest(directory / name)
        for name in (
            "freeze.json",
            "calibration-models.jsonl.gz",
            "predictions.jsonl.gz",
            "report.json",
        )
    }
    files.update(
        {f"sources/{name}": value for name, value in source_hashes.items()}
    )
    files.update(
        {f"baseline/{name}": value for name, value in baseline_hashes.items()}
    )
    receipt = {
        "contractVersion": "rain-rate-volume-receipt/v1",
        "productionEligible": False,
        "baselineRows": 1,
        "predictionRows": 1,
        "modelCount": 1,
        "files": files,
    }
    v1_test.write_json(directory / "receipt.json", receipt)


# prove independent calibration arithmetic and source selection
class VolumeVerificationHelperTests(unittest.TestCase):
    # preserve all raw forecast event categories
    def test_intensity_guard_matches_threshold_contract(self):
        """project scaled rates without changing provider categories."""
        self.assertEqual(verify.intensity_guard(0, 3), 0)
        self.assertLess(verify.intensity_guard(0.05, 3), 0.1)
        self.assertEqual(verify.intensity_guard(0.2, 0), 0.1)
        self.assertLess(verify.intensity_guard(1.2, 9), 2.5)
        self.assertEqual(verify.intensity_guard(3, 0), 2.5)
        self.assertEqual(verify.intensity_guard(3, 999), 500)

    # exercise neutral, endpoint, interior, flat, and unattainable decisions
    def test_scale_solver_decision_boundaries(self):
        """reproduce the fixed bounded scale solve independently."""
        neutral = verify.solve_scale([row(actual=0.2, raw=0.2, blend=0.2)])
        self.assertTrue(neutral["supported"])
        self.assertEqual(neutral["scale"], 1.0)
        lower = verify.solve_scale([row(actual=0.1, raw=0.2, blend=0.2)])
        self.assertTrue(lower["supported"])
        self.assertEqual(lower["scale"], 0.5)
        interior = verify.solve_scale([row(actual=1.4, raw=1.2, blend=0.8)])
        self.assertTrue(interior["supported"])
        self.assertAlmostEqual(interior["scale"], 1.75)
        outside = verify.solve_scale([row(actual=0.5, raw=0.2, blend=0.2)])
        self.assertFalse(outside["supported"])
        self.assertEqual(outside["reason"], "target_outside_attainable_range")
        flat = verify.solve_scale([row(actual=0, raw=0, blend=9)])
        self.assertFalse(flat["supported"])
        self.assertEqual(flat["reason"], "flat_volume_curve")

    # select only native supported in-window same-cell V1 predictions
    def test_calibration_selection_is_causal_and_source_bound(self):
        """exclude future, transfer, unsupported, and foreign-cell rows."""
        eligible = row(key="eligible", valid="2025-06-01T20:00:00.000Z")
        values = [
            eligible,
            row(key="future", valid="2026-01-01T00:00:00.000Z"),
            row(key="transfer", kind="ecmwf_to_best_match"),
            row(key="unsupported", supported=False),
            row(key="pre-oof", valid="2024-12-31T23:00:00.000Z"),
            row(key="cohort", cohort="ecmwf_single_run_hindcast"),
            row(key="band", lead=24),
        ]
        selected, start, cutoff = verify.calibration_rows(
            values, "2026-01", "fixed_lead_anchor", "001-012"
        )
        self.assertEqual(
            [value["key"] for value in selected], ["pre-oof", "eligible"]
        )
        self.assertEqual(start, cutoff - dt.timedelta(days=365))
        self.assertEqual(cutoff, dt.datetime(2025, 12, 25, 8, tzinfo=dt.timezone.utc))

    # count distinct supported dates and hours at every frozen minimum
    def test_calibration_support_uses_dates_and_hours(self):
        """apply all four independent support floors."""
        values = []
        # construct 60 dates and at least 500 unique hours
        for day in range(60):
            # retain nine distinct supported hours per date
            for hour in range(9):
                valid = dt.datetime(
                    2025, 1, 1, 8, tzinfo=dt.timezone.utc
                ) + dt.timedelta(days=day, hours=hour)
                actual = 0.2 if day < 10 and hour < 5 else 0.0
                values.append(
                    row(
                        key=f"{day}-{hour}",
                        valid=valid.isoformat(timespec="milliseconds").replace(
                            "+00:00", "Z"
                        ),
                        actual=actual,
                    )
                )
        support = verify.calibration_support(values)
        self.assertEqual(support["trainingDates"], 60)
        self.assertEqual(support["trainingHours"], 540)
        self.assertEqual(support["wetTrainingDates"], 10)
        self.assertEqual(support["wetTrainingHours"], 50)
        self.assertTrue(support["supported"])

    # preserve global weights rather than renormalizing each raw category
    def test_raw_category_volume_uses_global_weight_mass(self):
        """attribute observed and predicted means by raw category."""
        first = row(key="zero", actual=1.0, raw=0, blend=0)
        second = row(
            key="wet",
            valid="2025-06-02T20:00:00.000Z",
            actual=3.0,
            raw=0.2,
            blend=0.2,
        )
        # extend rows to the new six-arm candidate population
        for value in (first, second):
            value["predictions"].update(
                volumeNeutralGuard=value["predictions"]["intensityGuard"],
                volumeCalibratedGuard=value["predictions"]["intensityGuard"],
            )
        result = verify.raw_category_volume([first, second])
        self.assertEqual(result["zero"]["weightMass"], 0.5)
        self.assertEqual(result["zero"]["observedMeanContributionMmPerHour"], 0.5)
        self.assertEqual(result["zero"]["observedVolumeShare"], 0.25)
        self.assertEqual(result["wet"]["observedMeanContributionMmPerHour"], 1.5)
        self.assertEqual(result["trace"]["rows"], 0)

    # prove complete directory verification and exclusive evidence output
    def test_complete_fixture_verifies_exclusively(self):
        """accept one complete cold-start continuation exactly once."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            output = Path(temporary) / "verification.json"
            build_fixture(directory)
            result = verify.verify_directory(directory, output)
            self.assertTrue(result["verified"])
            self.assertFalse(result["accuracyQualification"])
            self.assertFalse(result["deploymentQualification"])
            with self.assertRaisesRegex(verify.base.VerificationError, "already exists"):
                verify.verify_directory(directory, output)

    # reject changed calibration arithmetic even under a forged outer receipt
    def test_calibration_state_tampering_fails(self):
        """reject one changed source audit after receipt rehashing."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            states = v1_test.read_jsonl(directory / "calibration-models.jsonl.gz")
            states[0]["sourceRows"] = 1
            v1_test.write_jsonl(directory / "calibration-models.jsonl.gz", states)
            rehash(directory, "calibration-models.jsonl.gz")
            with self.assertRaisesRegex(
                verify.base.VerificationError, "sourceRows"
            ):
                verify.verify_directory(
                    directory, Path(temporary) / "verification.json"
                )

    # reject copied targets independently from exact root hashes
    def test_prediction_target_tampering_fails(self):
        """reject changed baseline truth after receipt rehashing."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            predictions = v1_test.read_jsonl(directory / "predictions.jsonl.gz")
            predictions[0]["actualPrecipitationMm"] = 99.0
            v1_test.write_jsonl(directory / "predictions.jsonl.gz", predictions)
            rehash(directory, "predictions.jsonl.gz")
            with self.assertRaisesRegex(verify.base.VerificationError, "volume input"):
                verify.verify_directory(
                    directory, Path(temporary) / "verification.json"
                )


# run synthetic tests only
if __name__ == "__main__":
    unittest.main()
