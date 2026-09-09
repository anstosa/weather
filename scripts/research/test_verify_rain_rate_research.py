"""exercise independent rain-rate artifact verification and tamper rejection."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import verify_rain_rate_research as verify

POLICY = {
    "contractVersion": "rain-rate-tweedie-research/v1",
    "policyVersion": "rain-rate-adjustment-policy/v1",
    "featureSchemaVersion": "rain-rate-features/v1",
    "productionEligible": False,
    "embargoHours": 168,
    "minimumTrainingDates": 180,
    "minimumTrainingHours": 1000,
    "minimumWetTrainingDates": 20,
    "minimumWetTrainingHours": 100,
    "wetThresholdMm": 0.1,
    "heavyThresholdsMm": [1.0, 2.5],
    "blendWeight": 0.5,
    "modelMeanMaximumMm": 30.0,
    "numBoostRound": 120,
    "requiredXgboostVersion": "3.4.1",
    "learnerParameters": {"objective": "reg:tweedie"},
    "target": "synthetic complete-hour rain rate",
    "limitation": "synthetic test only",
}
CUTOFF = "2024-12-25T08:00:00.000Z"


# write canonical gzip json lines
def write_jsonl(path: Path, rows: list[dict]) -> None:
    """write one small canonical synthetic JSONL artifact."""
    # create the compressed fixture
    with gzip.open(path, "wt", compresslevel=1) as stream:
        # retain every fixture row
        for row in rows:
            stream.write(json.dumps(row, allow_nan=False, separators=(",", ":")) + "\n")


# read gzip json lines for mutation
def read_jsonl(path: Path) -> list[dict]:
    """read one small synthetic JSONL artifact."""
    # load the fixture rows
    with gzip.open(path, "rt") as stream:
        return [json.loads(line) for line in stream]


# write strict json fixture material
def write_json(path: Path, value: dict) -> None:
    """replace one mutable synthetic JSON fixture."""
    path.write_text(
        json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )


# construct one unsupported synthetic state
def state(cohort: str) -> dict:
    """return one zero-support frozen model state."""
    return {
        "contractVersion": POLICY["contractVersion"],
        "policyVersion": POLICY["policyVersion"],
        "featureSchemaVersion": POLICY["featureSchemaVersion"],
        "featureNames": ["synthetic"],
        "month": "2025-01",
        "issueMonth": "2025-01",
        "cohort": cohort,
        "leadBand": "001-012",
        "supported": False,
        "trainingRows": 0,
        "trainingDates": 0,
        "trainingHours": 0,
        "wetTrainingRows": 0,
        "wetTrainingDates": 0,
        "wetTrainingHours": 0,
        "effectiveTrainingHours": 0.0,
        "trainingWeightSum": 0.0,
        "trainingCutoffUtc": CUTOFF,
        "latestTrainingValidAt": None,
        "baseScore": None,
        "xgboostVersion": None,
        "learnerParameters": None,
        "numBoostRound": POLICY["numBoostRound"],
        "modelJson": None,
    }


# render one dependency-free replay snapshot
def model_source() -> str:
    """return a small frozen model module for replay and refit tests."""
    return f'''"""provide a synthetic frozen rain model."""

CANDIDATES = {verify.CANDIDATES!r}
POLICY = {POLICY!r}


# reconstruct one unsupported synthetic state
def fit(rows, month, cohort, band):
    """return one deterministic unsupported state."""
    # reject unexpected selected labels
    if list(rows):
        raise ValueError("synthetic refit unexpectedly selected rows")
    return {{
        "contractVersion": POLICY["contractVersion"],
        "policyVersion": POLICY["policyVersion"],
        "featureSchemaVersion": POLICY["featureSchemaVersion"],
        "featureNames": ["synthetic"],
        "month": month,
        "issueMonth": month,
        "cohort": cohort,
        "leadBand": band,
        "supported": False,
        "trainingRows": 0,
        "trainingDates": 0,
        "trainingHours": 0,
        "wetTrainingRows": 0,
        "wetTrainingDates": 0,
        "wetTrainingHours": 0,
        "effectiveTrainingHours": 0.0,
        "trainingWeightSum": 0.0,
        "trainingCutoffUtc": {CUTOFF!r},
        "latestTrainingValidAt": None,
        "baseScore": None,
        "xgboostVersion": None,
        "learnerParameters": None,
        "numBoostRound": POLICY["numBoostRound"],
        "modelJson": None,
    }}


# replay exact raw fallbacks
def predict_many(rows, model, transfer=False):
    """return ordered unsupported predictions."""
    result = []
    # reproduce every row
    for row in rows:
        raw = row["rawPrecipitationMm"]
        result.append({{
            "raw": raw,
            "zero": 0.0,
            "tweedieBlend": raw,
            "intensityGuard": raw,
        }})
    return result
'''


# construct the minimal scoring projection
def scoring_row(input_row: dict, kind: str) -> dict:
    """return one minimal verifier scoring row."""
    raw = input_row["rawPrecipitationMm"]
    return {
        "key": input_row["key"],
        "cohort": input_row["cohort"],
        "validAt": input_row["validAt"],
        "referenceAt": input_row["referenceAt"],
        "targetLeadHours": input_row["targetLeadHours"],
        "actualPrecipitationMm": input_row["actualPrecipitationMm"],
        "shiftMinus5MinutesMm": input_row["shiftMinus5MinutesMm"],
        "gaugeMeanPrecipitationMm": input_row["gaugeMeanPrecipitationMm"],
        "modelSupported": False,
        "predictions": {
            "raw": raw,
            "zero": 0.0,
            "tweedieBlend": raw,
            "intensityGuard": raw,
        },
        "recordKind": kind,
    }


# construct a complete retained synthetic output
def build_fixture(directory: Path) -> None:
    """write one internally consistent retained research directory."""
    directory.mkdir()
    sources = directory / "sources"
    sources.mkdir()
    input_row = {
        "key": "best-match|synthetic",
        "cohort": "best_match_single_run_transfer",
        "validAt": "2025-01-15T20:00:00.000Z",
        "referenceAt": "2025-01-15T08:00:00.000Z",
        "targetLeadHours": 12,
        "rawRelativeHumidityPercent": 80.0,
        "rawTemperatureC": 8.0,
        "rawWindSpeedMps": 2.0,
        "rawCloudCoverPercent": 90.0,
        "rawPrecipitationMm": 0.4,
        "actualPrecipitationMm": 0.2,
        "shiftMinus5MinutesMm": 0.25,
        "gaugeMeanPrecipitationMm": 0.3,
        "liquidOnly": True,
    }
    write_jsonl(directory / "input.jsonl.gz", [input_row])
    states = [
        state("best_match_single_run_transfer"),
        state("ecmwf_single_run_hindcast"),
    ]
    write_jsonl(directory / "models.jsonl.gz", states)
    predictions = []
    minimal = []
    # build both native and explicit transfer rows
    for kind, model_cohort in (
        ("native", "best_match_single_run_transfer"),
        ("ecmwf_to_best_match", "ecmwf_single_run_hindcast"),
    ):
        score_value = scoring_row(input_row, kind)
        minimal.append(score_value)
        predictions.append(
            {
                **input_row,
                "predictions": score_value["predictions"],
                "recordKind": kind,
                "modelSupported": False,
                "modelIdentity": ["2025-01", model_cohort, "001-012"],
                "trainingCutoffUtc": CUTOFF,
            }
        )
    write_jsonl(directory / "predictions.jsonl.gz", predictions)
    report = {
        "policy": POLICY,
        "gates": verify.EXPECTED_GATES,
        "units": "mean rain rate over complete reporting hour, mm/h; not instantaneous rain rate",
        "candidateSelection": "two_frozen_challengers_no_retuning_prior_period_already_consumed",
        "productionEligible": False,
        "periods": {
            "completeMonths": {
                "native": verify.summarize([minimal[0]]),
                "ecmwf_to_best_match": verify.summarize([minimal[1]]),
            },
            "partialSeptember": {
                "native": verify.summarize([]),
                "ecmwf_to_best_match": verify.summarize([]),
            },
        },
        "modelCount": 2,
        "inputRows": 1,
        "predictionRows": 2,
    }
    write_json(directory / "report.json", report)
    source_values = {
        "run_rain_rate_research.py": "# synthetic frozen runner\n",
        "rain_rate_model.py": model_source(),
        "humidity_research.py": "# synthetic frozen shared source\n",
        "rain_research.py": "# synthetic frozen rain source\n",
    }
    # retain every declared source snapshot
    for name, value in source_values.items():
        (sources / name).write_text(value)
    source_hashes = {
        name: verify.digest(sources / name) for name in source_values
    }
    freeze = {
        "policy": POLICY,
        "gates": verify.EXPECTED_GATES,
        "inputSha256": verify.digest(directory / "input.jsonl.gz"),
        "sourceSha256": source_hashes,
        "frozenAtUtc": "2026-09-08T00:00:00+00:00",
        "productionEligible": False,
    }
    write_json(directory / "freeze.json", freeze)
    names = (
        "input.jsonl.gz",
        "models.jsonl.gz",
        "predictions.jsonl.gz",
        "report.json",
        "freeze.json",
    )
    receipt = {
        "productionEligible": False,
        "inputRows": 1,
        "predictionRows": 2,
        "files": {name: verify.digest(directory / name) for name in names},
    }
    receipt["files"].update(
        {f"sources/{name}": value for name, value in source_hashes.items()}
    )
    write_json(directory / "receipt.json", receipt)


# update one receipt hash after an adversarial rewrite
def rehash(directory: Path, name: str) -> None:
    """make one tamper internally hash-consistent with the outer receipt."""
    receipt = json.loads((directory / "receipt.json").read_text())
    receipt["files"][name] = verify.digest(directory / name)
    write_json(directory / "receipt.json", receipt)


# exercise complete validation and independent failure boundaries
class ArtifactVerificationTests(unittest.TestCase):
    # lock the original v1 summary bytes before extending candidate support
    def test_v1_default_summary_is_byte_stable(self):
        """preserve exact v1 output when candidate support is absent."""
        input_row = {
            "key": "best-match|stable",
            "cohort": "best_match_single_run_transfer",
            "validAt": "2025-01-15T20:00:00.000Z",
            "referenceAt": "2025-01-15T08:00:00.000Z",
            "targetLeadHours": 12,
            "actualPrecipitationMm": 0.2,
            "shiftMinus5MinutesMm": 0.25,
            "gaugeMeanPrecipitationMm": 0.3,
            "modelSupported": False,
            "predictions": {
                "raw": 0.4,
                "zero": 0.0,
                "tweedieBlend": 0.4,
                "intensityGuard": 0.4,
            },
            "recordKind": "native",
        }
        summary = verify.summarize([input_row])
        encoded = json.dumps(
            summary, allow_nan=False, sort_keys=True, separators=(",", ":")
        ).encode()
        self.assertEqual(
            hashlib.sha256(encoded).hexdigest(),
            "4f805d2f3df331a2daf860bde0975cef2bfbe020c0abf44eeb263340ab9035a7",
        )
        self.assertEqual(summary, verify.summarize([input_row], verify.CANDIDATES))
        self.assertNotIn("supportByCandidate", summary["best_match_single_run_transfer"]["overall"])

    # prove support is counted separately for each candidate and target
    def test_candidate_specific_support_controls_screen(self):
        """use candidate-supported dates and wet dates for the new screen."""
        rows = []
        # build the minimum overall date population
        for day in range(180):
            valid = dt.datetime(2025, 1, 1, 20, tzinfo=dt.timezone.utc) + dt.timedelta(
                days=day
            )
            actual = 0.2 if day < 20 else 0.0
            rows.append(
                {
                    "key": f"row-{day}",
                    "cohort": "fixed_lead_anchor",
                    "validAt": valid.isoformat(timespec="milliseconds").replace(
                        "+00:00", "Z"
                    ),
                    "referenceAt": None,
                    "targetLeadHours": 12,
                    "actualPrecipitationMm": actual,
                    "alternativeMm": 0.2,
                    "modelSupported": True,
                    "candidateSupported": {
                        "raw": True,
                        "zero": True,
                        "tweedieBlend": day != 179,
                        "intensityGuard": True,
                    },
                    "predictions": {
                        "raw": actual + 0.1,
                        "zero": 0.0,
                        "tweedieBlend": actual,
                        "intensityGuard": actual,
                    },
                    "recordKind": "native",
                }
            )
        primary = verify.score(rows)
        alternative = verify.score(rows, "alternativeMm")
        self.assertEqual(
            primary["supportByCandidate"]["tweedieBlend"],
            {"rows": 179, "hours": 179, "dates": 179, "wetDates": 20},
        )
        self.assertEqual(
            alternative["supportByCandidate"]["tweedieBlend"]["wetDates"], 179
        )
        screened = verify.screen(primary)
        self.assertFalse(screened["tweedieBlend"]["checks"]["support"])
        self.assertTrue(screened["intensityGuard"]["checks"]["support"])

    # prove the full replay and refit path creates evidence once
    def test_complete_fixture_replays_and_refits_exclusively(self):
        """accept one complete fixture and reject evidence replacement."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            output = Path(temporary) / "verified.json"
            build_fixture(directory)
            result = verify.verify_directory(directory, output, refit=True)
            self.assertTrue(result["verified"])
            self.assertTrue(result["fullDeterministicRefit"])
            self.assertFalse(result["accuracyQualification"])
            with self.assertRaisesRegex(verify.VerificationError, "already exists"):
                verify.verify_directory(directory, output, refit=True)

    # reject exact file tampering before parsing it
    def test_receipt_bound_file_tampering_fails(self):
        """reject changed bytes under an unchanged retained receipt."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            with (directory / "report.json").open("a") as stream:
                stream.write(" ")
            with self.assertRaisesRegex(verify.VerificationError, "hash differs"):
                verify.verify_directory(directory, Path(temporary) / "result.json")

    # reject an input rewrite even when the outer receipt is forged
    def test_frozen_input_sha_tampering_fails(self):
        """reject input bytes that no longer match the pre-fit freeze."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            rows = read_jsonl(directory / "input.jsonl.gz")
            rows[0]["actualPrecipitationMm"] = 9.0
            write_jsonl(directory / "input.jsonl.gz", rows)
            rehash(directory, "input.jsonl.gz")
            with self.assertRaisesRegex(verify.VerificationError, "frozen input"):
                verify.verify_directory(directory, Path(temporary) / "result.json")

    # reject a dropped transfer row under forged hashes
    def test_scoring_population_tampering_fails(self):
        """reject missing native or explicit transfer scoring keys."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            rows = read_jsonl(directory / "predictions.jsonl.gz")
            write_jsonl(directory / "predictions.jsonl.gz", rows[:1])
            rehash(directory, "predictions.jsonl.gz")
            with self.assertRaisesRegex(verify.VerificationError, "population differs"):
                verify.verify_directory(directory, Path(temporary) / "result.json")

    # reject copied forecast-field tampering under forged hashes
    def test_forecast_binding_tampering_fails(self):
        """reject predictions whose embedded frozen forecast changed."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            rows = read_jsonl(directory / "predictions.jsonl.gz")
            rows[0]["rawTemperatureC"] = 99.0
            write_jsonl(directory / "predictions.jsonl.gz", rows)
            rehash(directory, "predictions.jsonl.gz")
            with self.assertRaisesRegex(verify.VerificationError, "prediction input"):
                verify.verify_directory(directory, Path(temporary) / "result.json")

    # reject model support chronology tampering under forged hashes
    def test_model_support_tampering_fails(self):
        """reject serialized support counts not derivable from inputs."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            rows = read_jsonl(directory / "models.jsonl.gz")
            rows[0]["trainingRows"] = 1
            write_jsonl(directory / "models.jsonl.gz", rows)
            rehash(directory, "models.jsonl.gz")
            with self.assertRaisesRegex(verify.VerificationError, "trainingRows differs"):
                verify.verify_directory(directory, Path(temporary) / "result.json")

    # reject a reconstructed score tamper under forged hashes
    def test_report_metric_tampering_fails(self):
        """reject aggregate metrics that differ from retained rows."""
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "retained"
            build_fixture(directory)
            report = json.loads((directory / "report.json").read_text())
            metrics = report["periods"]["completeMonths"]["native"][
                "best_match_single_run_transfer"
            ]["overall"]["candidates"]["raw"]
            metrics["maeMmPerHour"] += 0.1
            write_json(directory / "report.json", report)
            rehash(directory, "report.json")
            with self.assertRaisesRegex(verify.VerificationError, "maeMmPerHour"):
                verify.verify_directory(directory, Path(temporary) / "result.json")


# run synthetic tests only
if __name__ == "__main__":
    unittest.main()
