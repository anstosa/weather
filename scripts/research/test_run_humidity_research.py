#!/usr/bin/env python3
"""Test the bounded all-source humidity research runner."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# import sibling research modules without package side effects
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_humidity_research as runner


# hash one test artifact
def sha256(path):
    """return one file sha256"""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# format one canonical utc instant
def instant(value):
    """format one timezone-aware datetime"""
    return (
        value.astimezone(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# build one cold-start model-ready row
def humidity_row(index):
    """return one deterministic synthetic humidity row"""
    valid_at = dt.datetime(2025, 1, 15, index, tzinfo=dt.timezone.utc)
    return {
        "key": f"synthetic-{index}",
        "validAt": instant(valid_at),
        "referenceAt": None,
        "targetLeadHours": index + 1,
        "cohort": "fixed_lead_anchor",
        "rawRelativeHumidityPercent": 60.0 + index,
        "actualRelativeHumidityPercent": 65.0 + index,
        "rawTemperatureC": 10.0,
        "rawWindSpeedMps": 2.0,
    }


# write four separately attested input files
def write_fixture(root):
    """create one complete synthetic runner fixture"""
    inputs = []
    # represent both production and archive sources
    for index, name in enumerate(
        (
            "production-fixed.jsonl",
            "production-live.jsonl",
            "archive-ecmwf-paired-v2.jsonl",
            "archive-best-match-paired-v2.jsonl",
        )
    ):
        path = root / name
        path.write_text(json.dumps(humidity_row(index)) + "\n")
        inputs.append(path)
    production = root / "production-manifest.json"
    production.write_text(
        json.dumps({"inputFiles": {path.name: sha256(path) for path in inputs[:2]}})
        + "\n"
    )
    plan = root / "plan.json"
    plan.write_text('{"researchOnly":true}\n')
    pairing = root / "pairing-manifest.json"
    pairing.write_text(
        json.dumps(
            {
                "files": [
                    {"path": str(path), "sha256": sha256(path)} for path in inputs[2:]
                ]
            }
        )
        + "\n"
    )
    return inputs, production, plan, pairing


# assemble one runner command
def arguments(root, inputs, production, plan, pairing):
    """return one complete synthetic cli argument list"""
    return [
        "--inputs",
        *(str(path) for path in inputs),
        "--predictions",
        str(root / "predictions.jsonl"),
        "--report",
        str(root / "report.json"),
        "--receipt",
        str(root / "receipt.json"),
        "--production-manifest",
        str(production),
        "--plan",
        str(plan),
        "--pairing-manifest",
        str(pairing),
    ]


class HumidityRunnerTest(unittest.TestCase):
    """Verify bounded inputs, source freezes, and output receipts."""

    # run the immutable model and bind every artifact
    def test_writes_plaintext_fit_outputs_and_compatible_receipt(self):
        """publish report and receipt only after a successful fit"""
        # isolate all synthetic artifacts
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, production, plan, pairing = write_fixture(root)

            receipt = runner.run(arguments(root, inputs, production, plan, pairing))

            predictions = root / "predictions.jsonl"
            report = root / "report.json"
            persisted = json.loads((root / "receipt.json").read_text())
            self.assertEqual(receipt, persisted)
            self.assertEqual(receipt["inputRows"], 4)
            self.assertEqual(receipt["predictionRows"], 4)
            self.assertEqual(
                receipt["inputFiles"],
                {path.name: sha256(path) for path in inputs},
            )
            self.assertEqual(receipt["inputHashesBefore"], receipt["inputHashesAfter"])
            self.assertEqual(receipt["predictionsSha256"], sha256(predictions))
            self.assertIsNone(receipt["compressedPredictionsSha256"])
            self.assertEqual(receipt["reportSha256"], sha256(report))
            self.assertEqual(receipt["aggregateReportSha256"], sha256(report))
            self.assertEqual(
                receipt["modelSourceSha256"],
                sha256(Path(runner.humidity_research.__file__)),
            )
            self.assertEqual(
                receipt["sourceHashesBefore"], receipt["sourceHashesAfter"]
            )
            self.assertFalse(receipt["productionEligible"])
            self.assertEqual(receipt["predictionStorage"], "plaintext")

    # reject one input that does not match its frozen evidence
    def test_rejects_input_hash_mismatch_before_outputs(self):
        """fail closed when an attested input changes"""
        # isolate the mismatched input
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, production, plan, pairing = write_fixture(root)
            inputs[0].write_text("{}\n")

            with self.assertRaisesRegex(ValueError, "input hash does not match"):
                runner.run(arguments(root, inputs, production, plan, pairing))

            self.assertFalse((root / "predictions.jsonl").exists())
            self.assertFalse((root / "report.json").exists())
            self.assertFalse((root / "receipt.json").exists())

    # detect a source mutation after model evaluation
    def test_rejects_source_change_without_complete_receipt(self):
        """leave no receipt when a frozen source changes during fitting"""
        # isolate the mutable synthetic model source
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, production, plan, pairing = write_fixture(root)
            model = root / "humidity_research.py"
            model.write_text("before\n")

            # mutate only after creating model-like predictions
            def changed_source(_rows, prediction_path):
                Path(prediction_path).write_text("{}\n")
                model.write_text("after\n")
                return {"contractVersion": "synthetic"}

            with (
                mock.patch.object(runner.humidity_research, "__file__", str(model)),
                mock.patch.object(
                    runner.humidity_research, "evaluate", side_effect=changed_source
                ),
                self.assertRaisesRegex(ValueError, "source changed"),
            ):
                runner.run(arguments(root, inputs, production, plan, pairing))

            self.assertTrue((root / "predictions.jsonl").exists())
            self.assertFalse((root / "report.json").exists())
            self.assertFalse((root / "receipt.json").exists())

    # refuse every pre-existing output before evaluation
    def test_rejects_output_collision_without_modifying_it(self):
        """never overwrite predictions, report, or receipt paths"""
        # check every independently colliding output
        for output_name in ("predictions.jsonl", "report.json", "receipt.json"):
            with (
                self.subTest(output=output_name),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                inputs, production, plan, pairing = write_fixture(root)
                collision = root / output_name
                collision.write_text("keep\n")

                with self.assertRaisesRegex(FileExistsError, "output exists"):
                    runner.run(arguments(root, inputs, production, plan, pairing))

                self.assertEqual(collision.read_text(), "keep\n")
                # keep non-colliding outputs absent
                for candidate in (
                    root / "predictions.jsonl",
                    root / "report.json",
                    root / "receipt.json",
                ):
                    if candidate != collision:
                        self.assertFalse(candidate.exists())

    # require all four named inputs to exist and carry evidence
    def test_rejects_missing_or_unattested_inputs(self):
        """reject absent files and inputs without a frozen hash"""
        # check absence before reading rows
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, production, plan, pairing = write_fixture(root)
            inputs[0].unlink()
            with self.assertRaisesRegex(ValueError, "input is not a regular file"):
                runner.run(arguments(root, inputs, production, plan, pairing))

        # check missing evidence independently
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, production, plan, pairing = write_fixture(root)
            production.write_text("{}\n")
            with self.assertRaisesRegex(ValueError, "input hash is not attested"):
                runner.run(arguments(root, inputs, production, plan, pairing))


# execute only synthetic runner validation
if __name__ == "__main__":
    unittest.main()
