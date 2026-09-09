#!/usr/bin/env python3
"""Synthetic real-output and tamper tests for moisture verification."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# import sibling research modules directly
sys.path.insert(0, str(Path(__file__).resolve().parent))
import humidity_research as humidity
import pressure_research as pressure
import rain_research as rain
import run_humidity_research as humidity_runner
import verify_moisture_models as verifier


# format one canonical utc instant
def utc(value: dt.datetime) -> str:
    """Return one canonical millisecond UTC timestamp."""
    return (
        value.astimezone(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# hash one test artifact
def sha(path: Path) -> str:
    """Return one exact file digest."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# write one compact aggregate report
def write_report(path: Path, value: dict) -> None:
    """Write report bytes matching the research driver convention."""
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


# write plain or compressed model-ready rows
def write_rows(path: Path, rows: list[dict], compressed: bool) -> None:
    """Write one deterministic JSONL test artifact."""
    opener = gzip.open if compressed else open
    # serialize each row exactly once
    with opener(path, "wt") as stream:
        # retain input order
        for row in rows:
            stream.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")


# compress one real model prediction file
def compress_predictions(source: Path, destination: Path) -> str:
    """Compress predictions and return the plaintext digest."""
    plain_sha = sha(source)
    # copy exact plaintext through gzip
    with (
        source.open("rb") as input_stream,
        gzip.open(destination, "wb") as output_stream,
    ):
        shutil.copyfileobj(input_stream, output_stream)
    return plain_sha


# build one humidity forecast
def humidity_row(
    key: str,
    cohort: str,
    valid: dt.datetime,
    lead: int,
    *,
    reference: bool,
) -> dict:
    """Return one valid synthetic humidity input."""
    return {
        "key": key,
        "validAt": utc(valid),
        "referenceAt": utc(valid - dt.timedelta(hours=lead)) if reference else None,
        "targetLeadHours": lead,
        "cohort": cohort,
        "rawRelativeHumidityPercent": 70.0 + lead / 20,
        "actualRelativeHumidityPercent": 74.0 + lead / 20,
        "rawTemperatureC": 10.0,
        "rawWindSpeedMps": 2.0,
    }


# build one rain forecast
def rain_row(
    key: str,
    cohort: str,
    valid: dt.datetime,
    lead: int,
    *,
    reference: dt.datetime | None,
    actual: float = 0.4,
    raw: float = 0.2,
) -> dict:
    """Return one valid synthetic rain input."""
    return {
        "key": key,
        "cohort": cohort,
        "validAt": utc(valid),
        "referenceAt": None if reference is None else utc(reference),
        "targetLeadHours": lead,
        "rawRelativeHumidityPercent": 80.0,
        "rawTemperatureC": 10.0,
        "rawWindSpeedMps": 2.0,
        "rawCloudCoverPercent": 75.0,
        "actualPrecipitationMm": actual,
        "rawPrecipitationMm": raw,
        "shiftMinus5MinutesMm": actual + 0.1,
        "gaugeMeanPrecipitationMm": actual + 0.2,
        "liquidOnly": True,
    }


# build one pressure forecast
def pressure_row(
    key: str,
    cohort: str,
    valid: dt.datetime,
    lead: int,
    *,
    reference: dt.datetime | None,
    raw: float = 1000.0,
    actual: float = 1002.0,
    forecast_change: float | None = None,
    actual_change: float | None = None,
) -> dict:
    """Return one valid synthetic station-pressure input."""
    return {
        "key": key,
        "cohort": cohort,
        "stationKey": "tempest-126537",
        "validAt": utc(valid),
        "referenceAt": None if reference is None else utc(reference),
        "targetLeadHours": lead,
        "rawPressureHpa": raw,
        "actualPressureHpa": actual,
        "rawTemperatureC": 10.0,
        "rawRelativeHumidityPercent": 75.0,
        "rawWindSpeedMps": 2.0,
        "forecastElevationM": 100.0,
        "forecastPressureChange3h": forecast_change,
        "actualPressureChange3h": actual_change,
    }


class Fixture:
    """Hold one real model output and its verification inputs."""

    # retain one generated artifact set
    def __init__(
        self,
        metric: str,
        inputs: list[Path],
        predictions: Path,
        report: Path,
        receipt: Path,
        band: str | None = None,
    ):
        """Initialize one fixture record."""
        self.metric = metric
        self.inputs = inputs
        self.predictions = predictions
        self.report = report
        self.receipt = receipt
        self.band = band


class MoistureVerifierTest(unittest.TestCase):
    """Verify real research outputs and independent tamper detection."""

    # create one isolated artifact root
    def setUp(self):
        """Create one temporary research directory."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    # remove all private synthetic artifacts
    def tearDown(self):
        """Remove the temporary research directory."""
        self.temporary.cleanup()

    # create real humidity output across every cohort and transfer
    def humidity_fixture(self) -> Fixture:
        """Generate one multi-input humidity evaluation."""
        base = dt.datetime(2026, 5, 10, 12, tzinfo=dt.timezone.utc)
        rows = [
            humidity_row(
                "rh-ecmwf", "ecmwf_single_run_hindcast", base, 6, reference=True
            ),
            humidity_row(
                "rh-best",
                "best_match_single_run_transfer",
                base + dt.timedelta(days=1),
                6,
                reference=True,
            ),
            humidity_row(
                "rh-fixed",
                "fixed_lead_anchor",
                base + dt.timedelta(days=2),
                18,
                reference=False,
            ),
            humidity_row(
                "rh-legacy-short",
                "legacy_v4_retrieval_snapshot",
                base + dt.timedelta(days=3),
                6,
                reference=True,
            ),
            humidity_row(
                "rh-legacy-long",
                "legacy_v4_retrieval_snapshot",
                base + dt.timedelta(days=4),
                30,
                reference=True,
            ),
            humidity_row(
                "rh-partial",
                "ecmwf_single_run_hindcast",
                dt.datetime(2026, 9, 2, 12, tzinfo=dt.timezone.utc),
                6,
                reference=True,
            ),
        ]
        by_cohort = {
            cohort: [row for row in rows if row["cohort"] == cohort]
            for cohort in verifier.COHORTS
        }
        inputs = [self.root / f"{cohort}.jsonl" for cohort in verifier.COHORTS]
        # preserve the runner's four plaintext inputs
        for path, cohort in zip(inputs, verifier.COHORTS, strict=True):
            write_rows(path, by_cohort[cohort], compressed=False)
        predictions = self.root / "humidity-predictions.jsonl"
        report = self.root / "humidity-report.json"
        receipt = self.root / "humidity-receipt.json"
        production_manifest = self.root / "production-manifest.json"
        pairing_manifest = self.root / "pairing-manifest.json"
        plan = self.root / "plan.json"
        production_manifest.write_text(
            json.dumps({"inputFiles": {path.name: sha(path) for path in inputs[:2]}})
        )
        pairing_manifest.write_text(
            json.dumps({"inputFiles": {path.name: sha(path) for path in inputs[2:]}})
        )
        plan.write_text("{}\n")
        humidity_runner.run(
            [
                "--inputs",
                *map(str, inputs),
                "--predictions",
                str(predictions),
                "--report",
                str(report),
                "--receipt",
                str(receipt),
                "--production-manifest",
                str(production_manifest),
                "--plan",
                str(plan),
                "--pairing-manifest",
                str(pairing_manifest),
            ]
        )
        return Fixture("humidity", inputs, predictions, report, receipt)

    # create real rain output across all cohorts and an accumulation
    def rain_fixture(self) -> Fixture:
        """Generate one compressed-input rain evaluation."""
        reference = dt.datetime(2026, 5, 10, 6, tzinfo=dt.timezone.utc)
        rows = [
            rain_row(
                f"rain-ecmwf-{lead}",
                "ecmwf_single_run_hindcast",
                reference + dt.timedelta(hours=lead),
                lead,
                reference=reference,
                actual=0.2 * lead,
                raw=0.1 * lead,
            )
            for lead in (1, 2, 3)
        ]
        rows.extend(
            [
                rain_row(
                    "rain-best",
                    "best_match_single_run_transfer",
                    reference + dt.timedelta(days=1, hours=6),
                    6,
                    reference=reference + dt.timedelta(days=1),
                    actual=1.2,
                    raw=0.5,
                ),
                rain_row(
                    "rain-fixed",
                    "fixed_lead_anchor",
                    reference + dt.timedelta(days=2, hours=18),
                    18,
                    reference=None,
                ),
                rain_row(
                    "rain-legacy",
                    "legacy_v4_retrieval_snapshot",
                    reference + dt.timedelta(days=3, hours=30),
                    30,
                    reference=reference + dt.timedelta(days=3),
                ),
                rain_row(
                    "rain-partial",
                    "fixed_lead_anchor",
                    dt.datetime(2026, 9, 2, 12, tzinfo=dt.timezone.utc),
                    18,
                    reference=None,
                ),
            ]
        )
        input_path = self.root / "rain-input.jsonl.gz"
        write_rows(input_path, rows, compressed=True)
        plain_predictions = self.root / "rain-predictions.jsonl"
        report_value = rain.evaluate(rows, plain_predictions)
        predictions = self.root / "rain-predictions.jsonl.gz"
        predictions_sha = compress_predictions(plain_predictions, predictions)
        report = self.root / "rain-report.json"
        write_report(report, report_value)
        receipt_value = {
            "metric": "rain",
            "inputRows": len(rows),
            "inputFile": input_path.name,
            "inputSha256": sha(input_path),
            "reportSha256": sha(report),
            "predictionsFile": predictions.name,
            "predictionsSha256": predictions_sha,
            "compressedPredictionsSha256": sha(predictions),
            "modelSourceSha256": sha(Path(rain.__file__)),
            "sharedSourceSha256": sha(Path(humidity.__file__)),
            "productionEligible": False,
        }
        receipt = self.root / "rain-receipt.json"
        receipt.write_text(json.dumps(receipt_value))
        return Fixture("rain", [input_path], predictions, report, receipt)

    # create real pressure output across cohorts and same-run changes
    def pressure_fixture(self) -> Fixture:
        """Generate one plain-input pressure evaluation."""
        reference = dt.datetime(2026, 5, 10, 6, tzinfo=dt.timezone.utc)
        rows = [
            pressure_row(
                "pressure-ecmwf-3",
                "ecmwf_single_run_hindcast",
                reference + dt.timedelta(hours=3),
                3,
                reference=reference,
                raw=999.0,
                actual=1000.0,
            ),
            pressure_row(
                "pressure-ecmwf-6",
                "ecmwf_single_run_hindcast",
                reference + dt.timedelta(hours=6),
                6,
                reference=reference,
                raw=1000.0,
                actual=1003.0,
                forecast_change=1.0,
                actual_change=3.0,
            ),
            pressure_row(
                "pressure-best",
                "best_match_single_run_transfer",
                reference + dt.timedelta(days=1, hours=6),
                6,
                reference=reference + dt.timedelta(days=1),
            ),
            pressure_row(
                "pressure-fixed",
                "fixed_lead_anchor",
                reference + dt.timedelta(days=2, hours=6),
                6,
                reference=None,
            ),
            pressure_row(
                "pressure-legacy",
                "legacy_v4_retrieval_snapshot",
                reference + dt.timedelta(days=3, hours=6),
                6,
                reference=reference + dt.timedelta(days=3),
            ),
            pressure_row(
                "pressure-partial",
                "fixed_lead_anchor",
                dt.datetime(2026, 9, 2, 12, tzinfo=dt.timezone.utc),
                6,
                reference=None,
            ),
        ]
        input_path = self.root / "pressure-input.jsonl"
        write_rows(input_path, rows, compressed=False)
        plain_predictions = self.root / "pressure-predictions.jsonl"
        report_value = pressure.evaluate(rows, plain_predictions)
        predictions = self.root / "pressure-predictions.jsonl.gz"
        predictions_sha = compress_predictions(plain_predictions, predictions)
        report = self.root / "pressure-report.json"
        write_report(report, report_value)
        receipt_value = {
            "metric": "pressure",
            "inputRows": len(rows),
            "inputFile": input_path.name,
            "inputSha256": sha(input_path),
            "reportSha256": sha(report),
            "predictionsFile": predictions.name,
            "predictionsSha256": predictions_sha,
            "compressedPredictionsSha256": sha(predictions),
            "modelSourceSha256": sha(Path(pressure.__file__)),
            "sharedSourceSha256": sha(Path(humidity.__file__)),
            "productionEligible": False,
        }
        receipt = self.root / "pressure-receipt.json"
        receipt.write_text(json.dumps(receipt_value))
        return Fixture(
            "pressure", [input_path], predictions, report, receipt, "001-012"
        )

    # update prediction hashes after intentional mutation
    def update_prediction_receipt(self, fixture: Fixture) -> None:
        """Rebind receipt hashes so semantic checks face the tamper."""
        _, plain_sha = verifier.load_jsonl(fixture.predictions)
        receipt = json.loads(fixture.receipt.read_text())
        receipt["predictionsSha256"] = plain_sha
        receipt["compressedPredictionsSha256"] = sha(fixture.predictions)
        fixture.receipt.write_text(json.dumps(receipt))

    # run all generated real model outputs
    def test_real_outputs_verify_all_metrics_and_populations(self):
        """Accept real outputs across cohorts, transfers, and gzip modes."""
        fixtures = [
            self.humidity_fixture(),
            self.rain_fixture(),
            self.pressure_fixture(),
        ]
        # verify each independent metric path
        for fixture in fixtures:
            with self.subTest(metric=fixture.metric):
                result = verifier.verify_files(
                    fixture.metric,
                    fixture.inputs,
                    fixture.predictions,
                    fixture.report,
                    fixture.receipt,
                    band=fixture.band,
                )
                self.assertEqual(result["verdict"], "PASS")
                self.assertGreater(result["predictions"]["nativeRows"], 0)
        humidity_result = verifier.verify_files(
            fixtures[0].metric,
            fixtures[0].inputs,
            fixtures[0].predictions,
            fixtures[0].report,
            fixtures[0].receipt,
        )
        self.assertEqual(humidity_result["predictions"]["transferRows"], 3)

    # reject fallback tampering despite updated artifact hashes
    def test_rejects_prediction_tampering_after_receipt_rehash(self):
        """Detect unsupported rain prediction changes semantically."""
        fixture = self.rain_fixture()
        rows, _ = verifier.load_jsonl(fixture.predictions)
        rows[0]["predictions"]["hurdle"] += 1.0
        write_rows(fixture.predictions, rows, compressed=True)
        self.update_prediction_receipt(fixture)
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
            )

    # reject aggregate tampering despite updated report hash
    def test_rejects_report_tampering_after_receipt_rehash(self):
        """Detect altered humidity group metrics independently."""
        fixture = self.humidity_fixture()
        report = json.loads(fixture.report.read_text())
        report["completeMonths"]["byCohort"]["fixed_lead_anchor"]["predictions"]["raw"][
            "equalDateMaePercentagePoints"
        ] += 0.5
        write_report(fixture.report, report)
        receipt = json.loads(fixture.receipt.read_text())
        receipt["aggregateReportSha256"] = sha(fixture.report)
        fixture.receipt.write_text(json.dumps(receipt))
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
            )

    # reject chronology tampering despite updated prediction hashes
    def test_rejects_chronology_tampering_after_receipt_rehash(self):
        """Detect altered pressure training cutoffs before scoring."""
        fixture = self.pressure_fixture()
        rows, _ = verifier.load_jsonl(fixture.predictions)
        rows[0]["trainingCutoffUtc"] = "2026-05-01T07:00:00.000Z"
        write_rows(fixture.predictions, rows, compressed=True)
        self.update_prediction_receipt(fixture)
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
                band=fixture.band,
            )

    # reject input identity tampering despite updated input hash
    def test_rejects_input_tampering_after_receipt_rehash(self):
        """Detect a changed source label against retained predictions."""
        fixture = self.pressure_fixture()
        rows, _ = verifier.load_jsonl(fixture.inputs[0])
        rows[0]["actualPressureHpa"] += 1.0
        write_rows(fixture.inputs[0], rows, compressed=False)
        receipt = json.loads(fixture.receipt.read_text())
        receipt["inputSha256"] = sha(fixture.inputs[0])
        fixture.receipt.write_text(json.dumps(receipt))
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
                band=fixture.band,
            )

    # reject source identity drift immediately
    def test_rejects_source_hash_mismatch(self):
        """Require the exact model source recorded by the driver."""
        fixture = self.rain_fixture()
        receipt = json.loads(fixture.receipt.read_text())
        receipt["modelSourceSha256"] = "0" * 64
        fixture.receipt.write_text(json.dumps(receipt))
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
            )

    # reject inconsistent runner input snapshots
    def test_rejects_runner_manifest_hash_mismatch(self):
        """Bind runner inputFiles and before-and-after hash manifests."""
        fixture = self.humidity_fixture()
        receipt = json.loads(fixture.receipt.read_text())
        name = fixture.inputs[0].name
        receipt["inputHashesBefore"][name] = "0" * 64
        fixture.receipt.write_text(json.dumps(receipt))
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_files(
                fixture.metric,
                fixture.inputs,
                fixture.predictions,
                fixture.report,
                fixture.receipt,
            )

    # require a failing process and no false pass receipt
    def test_cli_exits_nonzero_without_output_on_mismatch(self):
        """Fail closed at the standalone command boundary."""
        fixture = self.pressure_fixture()
        receipt = json.loads(fixture.receipt.read_text())
        receipt["reportSha256"] = "0" * 64
        fixture.receipt.write_text(json.dumps(receipt))
        output = self.root / "verification.json"
        command = [
            sys.executable,
            str(Path(verifier.__file__)),
            fixture.metric,
            "--inputs",
            *map(str, fixture.inputs),
            "--predictions",
            str(fixture.predictions),
            "--report",
            str(fixture.report),
            "--receipt",
            str(fixture.receipt),
            "--output",
            str(output),
            "--band",
            fixture.band,
        ]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(output.exists())


# run this verifier suite directly
if __name__ == "__main__":
    unittest.main()
