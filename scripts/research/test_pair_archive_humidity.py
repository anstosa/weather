#!/usr/bin/env python3
"""Test verified humidity pairing for archive acquisition cohorts."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_ROOT))
SCRIPT = SCRIPT_ROOT / "pair_archive_humidity.py"
SPEC = importlib.util.spec_from_file_location("pair_archive_humidity", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
pairing = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pairing
SPEC.loader.exec_module(pairing)


# write compact json lines
def write_lines(path: Path, rows: list[dict[str, object]]) -> None:
    """Write deterministic fixture rows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n"
            for row in rows
        )
    )


# hash fixture bytes
def file_hash(path: Path) -> str:
    """Hash one fixture path."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# create verified pairing inputs
def pairing_fixture(root: Path, evidence: Path) -> dict[str, object]:
    """Create two normalized cohorts and hourly observations."""
    cohorts = {}

    # create each isolated cohort
    for index, cohort in enumerate(pairing.COHORTS):
        rows = [
            {
                "key": f"{cohort}|one",
                "cohort": cohort,
                "validAt": "2025-01-02T01:00:00Z",
                "referenceAt": "2025-01-02T00:00:00Z",
                "runInitializedAt": "2025-01-02T00:00:00Z",
                "actualIssueAt": None,
                "targetLeadHours": 1,
                "rawRelativeHumidityPercent": 80 + index,
                "rawTemperatureC": 10.0,
                "rawWindSpeedMps": 2.0,
            },
            {
                "key": f"{cohort}|two",
                "cohort": cohort,
                "validAt": "2025-01-02T02:00:00+00:00",
                "referenceAt": "2025-01-02T00:00:00+00:00",
                "runInitializedAt": "2025-01-02T00:00:00+00:00",
                "actualIssueAt": None,
                "targetLeadHours": 2,
                "rawRelativeHumidityPercent": None if index == 0 else 82,
                "rawTemperatureC": 11.0,
                "rawWindSpeedMps": 2.5,
            },
        ]
        path = root / "acquisition/normalized" / f"{cohort}.jsonl"
        write_lines(path, rows)
        cohorts[cohort] = {
            "path": f"normalized/{cohort}.jsonl",
            "absolutePath": str(path.resolve()),
            "bytes": path.stat().st_size,
            "sha256": file_hash(path),
            "rows": 2,
            "successfulRuns": 1,
            "hashVerified": True,
            "rowCountVerified": True,
        }

    write_lines(
        root / "humidity/network.jsonl",
        [
            {
                "validAt": "2025-01-02T01:00:00.000Z",
                "actualRelativeHumidityPercent": 70,
            },
            {"validAt": "2025-01-02T02:00:00Z", "actualRelativeHumidityPercent": None},
        ],
    )
    return {"status": "complete", "manifestSha256": "a" * 64, "cohortFiles": cohorts}


class PairingTest(unittest.TestCase):
    """Verify canonical joins, dynamic gaps, and safe reuse."""

    # pair canonical equivalent timestamps
    def test_pairs_verified_inputs_with_dynamic_missingness(self) -> None:
        """Join equal UTC instants without hardcoded row totals."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "private"
            evidence = Path(directory) / "evidence"
            summary = pairing_fixture(root, evidence)

            with mock.patch.object(pairing.verifier, "verify", return_value=summary):
                first = pairing.pair(root, evidence)
                second = pairing.pair(root, evidence)

            self.assertEqual(first, second)
            ecmwf = first["sources"]["ecmwf_single_run_hindcast"]
            best = first["sources"]["best_match_single_run_transfer"]
            self.assertEqual(
                ecmwf["counts"],
                {
                    "inputRows": 2,
                    "eligibleRows": 1,
                    "forecastHumidityNull": 1,
                    "targetMissing": 0,
                    "targetHumidityNull": 0,
                    "outOfScopeLead": 0,
                    "duplicateKeys": 0,
                },
            )
            self.assertEqual(best["counts"]["eligibleRows"], 1)
            self.assertEqual(best["counts"]["targetHumidityNull"], 1)
            self.assertEqual(
                set(first["inputFiles"]),
                {
                    "ecmwf_single_run_hindcast-paired-v2.jsonl",
                    "best_match_single_run_transfer-paired-v2.jsonl",
                },
            )
            paired = json.loads(
                (root / "humidity/ecmwf_single_run_hindcast-paired-v2.jsonl")
                .read_text()
                .splitlines()[0]
            )
            self.assertEqual(paired["validAt"], "2025-01-02T01:00:00.000Z")
            self.assertEqual(paired["referenceAt"], "2025-01-02T00:00:00.000Z")

    # reject equivalent duplicate target instants
    def test_rejects_duplicate_canonical_network_hour(self) -> None:
        """Fail when timestamp spelling hides a duplicate target."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "private"
            evidence = Path(directory) / "evidence"
            summary = pairing_fixture(root, evidence)
            network = root / "humidity/network.jsonl"
            with network.open("a", encoding="utf-8") as stream:
                stream.write(
                    '{"validAt":"2025-01-02T01:00:00Z","actualRelativeHumidityPercent":71}\n'
                )

            with (
                mock.patch.object(pairing.verifier, "verify", return_value=summary),
                self.assertRaisesRegex(
                    pairing.PairingError, "duplicate network target hour"
                ),
            ):
                pairing.pair(root, evidence)

    # reject altered reusable output
    def test_rejects_changed_or_partial_outputs(self) -> None:
        """Never overwrite changed or incomplete prior outputs."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "private"
            evidence = Path(directory) / "evidence"
            summary = pairing_fixture(root, evidence)

            with mock.patch.object(pairing.verifier, "verify", return_value=summary):
                pairing.pair(root, evidence)
                output = root / "humidity/ecmwf_single_run_hindcast-paired-v2.jsonl"
                output.write_bytes(output.read_bytes() + b"{}\n")

                with self.assertRaisesRegex(
                    pairing.PairingError, "existing pairing output changed"
                ):
                    pairing.pair(root, evidence)

            (root / "humidity/shortlead-pairing-manifest-v2.json").unlink()

            with (
                mock.patch.object(pairing.verifier, "verify", return_value=summary),
                self.assertRaisesRegex(
                    pairing.PairingError, "partial pairing output set"
                ),
            ):
                pairing.pair(root, evidence)


# run through unittest only
if __name__ == "__main__":
    unittest.main()
