#!/usr/bin/env python3
"""Test independent verification of frozen moisture acquisition artifacts."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

SCRIPT = Path(__file__).with_name("verify_moisture_acquisition.py")
SPEC = importlib.util.spec_from_file_location("verify_moisture_acquisition", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
verifier = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verifier
SPEC.loader.exec_module(verifier)


COMPACT_RANGES = {
    "ecmwf_single_run_hindcast": ("2024-03-14", "2024-03-14"),
    "best_match_single_run_transfer": ("2026-04-02", "2026-04-02"),
}


# encode canonical fixture json
def canonical(value: object) -> str:
    """Encode one deterministic fixture object."""
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


# write one private fixture object
def write_json(path: Path, value: object) -> None:
    """Write one canonical fixture object."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(value) + "\n", encoding="utf-8")


# hash fixture bytes
def file_hash(path: Path) -> str:
    """Hash one fixture file."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# build a compact frozen plan
def plan() -> dict[str, object]:
    """Build two one-day cohorts with all frozen controls."""
    return {
        "contractVersion": verifier.CONTRACT_VERSION,
        "endpoint": verifier.ENDPOINT,
        "cohorts": {
            "ecmwf_single_run_hindcast": {
                "model": "ecmwf_ifs",
                "from": "2024-03-14",
                "through": "2024-03-14",
            },
            "best_match_single_run_transfer": {
                "model": "best_match",
                "from": "2026-04-02",
                "through": "2026-04-02",
            },
        },
        "cycleHoursUtc": [0, 6, 12, 18],
        "requestedRuns": 8,
        "variables": list(verifier.EXPECTED_VARIABLES),
        "forecastHours": 49,
        "selectedLeads": [1, 48],
        "minimumGlobalStartSpacingMs": 300,
        "concurrency": 3,
        "maximumAttemptsPerRun": 2,
        "maximumAttempts": 4800,
        "productionWrites": False,
        "rateCaps": {"hourly": 4800, "daily": 4800},
    }


# build one complete archive response
def response(identity: dict[str, str], humidity: int) -> dict[str, object]:
    """Build one exact 49-hour response."""
    initialized = dt.datetime.fromisoformat(
        identity["runInitializedAt"].replace("Z", "+00:00")
    )
    times = [
        (initialized + dt.timedelta(hours=lead)).strftime("%Y-%m-%dT%H:%M")
        for lead in range(49)
    ]
    return {
        "latitude": 47.97891,
        "longitude": -122.44185,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "elevation": 28.0,
        "hourly_units": dict(verifier.EXPECTED_UNITS),
        "hourly": {
            "time": times,
            "temperature_2m": [10.0] * 49,
            "relative_humidity_2m": [humidity] * 49,
            "wind_speed_10m": [2.0] * 49,
            "precipitation": [0.1] * 49,
            "surface_pressure": [1000.0] * 49,
            "cloud_cover": [90] * 49,
        },
    }


# build expected normalized rows
def normalized_rows(identity: dict[str, str], humidity: int) -> list[dict[str, object]]:
    """Build exact selected-lead material."""
    initialized = dt.datetime.fromisoformat(
        identity["runInitializedAt"].replace("Z", "+00:00")
    )
    rows = []

    # retain every selected lead
    for lead in range(1, 49):
        rows.append(
            {
                "key": f"{identity['key']}|lead={lead}",
                "cohort": identity["cohort"],
                "validAt": (initialized + dt.timedelta(hours=lead))
                .isoformat()
                .replace("+00:00", "Z"),
                "referenceAt": identity["runInitializedAt"],
                "runInitializedAt": identity["runInitializedAt"],
                "actualIssueAt": None,
                "runReferenceClassification": verifier.ROW_CLASSIFICATION,
                "targetLeadHours": lead,
                "rawTemperatureC": 10.0,
                "rawRelativeHumidityPercent": humidity,
                "rawWindSpeedMps": 2.0,
                "rawPrecipitationMm": 0.1,
                "rawPressureHpa": 1000.0,
                "rawCloudCoverPercent": 90,
                "forecastElevationM": 28.0,
            }
        )

    return rows


# create one compact complete acquisition
def acquisition_fixture(private_root: Path, evidence: Path) -> dict[str, object]:
    """Create success and gap artifacts with dynamic totals."""
    frozen_plan = plan()
    plan_path = evidence / "acquisition-plan.json"
    write_json(plan_path, frozen_plan)
    plan_sha = file_hash(plan_path)
    repository = Path(verifier.__file__).resolve().parents[2]
    script_path = repository / "scripts/research/acquire_moisture_runs.py"
    test_path = repository / "scripts/research/test_acquire_moisture_runs.py"
    script_sha = file_hash(script_path)
    frozen_source = private_root / "runtime-sources/frozen-acquisition"
    frozen_source.mkdir(parents=True, exist_ok=True)
    (frozen_source / "acquire_moisture_runs.py").write_bytes(script_path.read_bytes())
    (frozen_source / "test_acquire_moisture_runs.py").write_bytes(
        test_path.read_bytes()
    )
    write_json(
        evidence / "acquisition-code-freeze.json",
        {
            "script": {
                "path": "scripts/research/acquire_moisture_runs.py",
                "sha256": script_sha,
            },
            "test": {
                "path": "scripts/research/test_acquire_moisture_runs.py",
                "sha256": file_hash(test_path),
            },
            "plan": {"sha256": plan_sha, "requestedRuns": 8},
        },
    )
    acquisition = private_root / "acquisition"
    write_json(
        acquisition / "contract.json",
        {
            "contractVersion": verifier.CONTRACT_VERSION,
            "planSha256": plan_sha,
            "scriptSha256": script_sha,
            "requestedRuns": 8,
            "resolve": {
                "host": verifier.ENDPOINT_HOST,
                "address": "5.9.98.184",
                "standardTlsHostnameValidation": True,
            },
        },
    )
    identities = verifier.build_identities(frozen_plan)
    receipts = []
    cohort_parts: dict[str, list[bytes]] = {
        cohort: [] for cohort in verifier.COHORT_MODELS
    }
    started = dt.datetime(2026, 9, 9, 16, 0, tzinfo=dt.timezone.utc)

    # materialize every declared run
    for index, identity in enumerate(identities):
        run_root = acquisition / "runs" / identity["cohort"] / identity["slug"]
        attempt = run_root / "attempts/01"
        query = [
            ("latitude", verifier.SITE_LATITUDE),
            ("longitude", verifier.SITE_LONGITUDE),
            ("run", identity["run"]),
            ("models", identity["model"]),
            ("hourly", ",".join(verifier.EXPECTED_VARIABLES)),
            ("forecast_hours", "49"),
            ("timezone", "GMT"),
            ("temperature_unit", "celsius"),
            ("wind_speed_unit", "ms"),
            ("precipitation_unit", "mm"),
            ("timeformat", "iso8601"),
        ]
        write_json(
            attempt / "request.json",
            {
                "key": identity["key"],
                "cohort": identity["cohort"],
                "model": identity["model"],
                "runInitializedAt": identity["runInitializedAt"],
                "attempt": 1,
                "startedAtUtc": (
                    started + dt.timedelta(milliseconds=400 * index)
                ).isoformat(),
                "minimumGlobalStartSpacingMs": 300,
                "url": f"{verifier.ENDPOINT}?{urlencode(query)}",
            },
        )
        is_gap = index == 2
        body = (
            b'{"reason":"not found"}'
            if is_gap
            else (canonical(response(identity, 70 + index)) + "\n").encode()
        )
        (attempt / "body.bin").write_bytes(body)
        write_json(
            attempt / "result.json",
            {
                "transportReturnCode": 0,
                "httpStatus": 404 if is_gap else 200,
                "responseBytes": len(body),
                "responseSha256": hashlib.sha256(body).hexdigest(),
                "standardTlsHostnameValidation": True,
                "resolvedAddress": "5.9.98.184",
            },
        )

        # retain one honest terminal gap
        if is_gap:
            receipt = {
                "key": identity["key"],
                "cohort": identity["cohort"],
                "model": identity["model"],
                "runInitializedAt": identity["runInitializedAt"],
                "status": "gap",
                "gapReason": "http_404",
                "attemptCount": 1,
                "httpStatuses": [404],
                "actualIssueAt": None,
                "runReferenceClassification": verifier.ROW_CLASSIFICATION,
            }
        else:
            rows = normalized_rows(identity, 70 + index)
            normalized = b"".join((canonical(row) + "\n").encode() for row in rows)
            (run_root / "normalized.jsonl").write_bytes(normalized)
            cohort_parts[identity["cohort"]].append(normalized)
            receipt = {
                "key": identity["key"],
                "cohort": identity["cohort"],
                "model": identity["model"],
                "runInitializedAt": identity["runInitializedAt"],
                "status": "success",
                "attemptCount": 1,
                "httpStatuses": [200],
                "responsePath": "attempts/01/body.bin",
                "responseBytes": len(body),
                "responseSha256": hashlib.sha256(body).hexdigest(),
                "normalizedPath": "normalized.jsonl",
                "normalizedBytes": len(normalized),
                "normalizedSha256": hashlib.sha256(normalized).hexdigest(),
                "returnedGrid": {"latitude": 47.97891, "longitude": -122.44185},
                "forecastElevationM": 28.0,
                "units": dict(verifier.EXPECTED_UNITS),
                "validHourInitializationDifference": {
                    "minimumHours": 0,
                    "maximumHours": 48,
                    "consecutive": True,
                },
                "selectedLeadHours": {"minimum": 1, "maximum": 48},
                "normalizedRows": 48,
                "nullCountsSelectedLeads": {
                    variable: 0 for variable in verifier.EXPECTED_VARIABLES
                },
                "actualIssueAt": None,
                "runReferenceClassification": verifier.ROW_CLASSIFICATION,
            }

        write_json(run_root / "run-result.json", receipt)
        receipts.append(receipt)

    cohort_files = {}

    # assemble exact cohort members
    for cohort, parts in cohort_parts.items():
        data = b"".join(parts)
        path = acquisition / "normalized" / f"{cohort}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        cohort_files[cohort] = {
            "path": f"normalized/{cohort}.jsonl",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rows": len(data.splitlines()),
            "successfulRuns": len(parts),
        }

    manifest = {
        "contractVersion": verifier.CONTRACT_VERSION,
        "plan": {
            "path": str(plan_path),
            "bytes": plan_path.stat().st_size,
            "sha256": plan_sha,
        },
        "acquisitionScriptSha256": script_sha,
        "endpoint": verifier.ENDPOINT,
        "requestCoordinates": {
            "latitude": float(verifier.SITE_LATITUDE),
            "longitude": float(verifier.SITE_LONGITUDE),
        },
        "requestedRuns": 8,
        "attemptsStarted": 8,
        "statusCounts": {"success": 7, "gap": 1},
        "gapCounts": {"http_404": 1},
        "nullCountsSelectedLeads": {
            cohort: {variable: 0 for variable in verifier.EXPECTED_VARIABLES}
            for cohort in verifier.COHORT_MODELS
        },
        "cohortFiles": cohort_files,
        "identities": receipts,
        "actualIssueTimeKnown": False,
        "runReferenceClassification": verifier.ROW_CLASSIFICATION,
        "productionWrites": False,
        "modelFit": False,
    }
    write_json(acquisition / "manifest.json", manifest)
    progress = {
        "contractVersion": verifier.CONTRACT_VERSION,
        "state": "complete",
        "requestedRuns": 8,
        "finishedRuns": 8,
        "successfulRuns": 7,
        "terminalGaps": 1,
        "pendingRuns": 0,
        "attemptsStarted": 8,
        "containsRowData": False,
    }
    write_json(acquisition / "progress.json", progress)
    write_json(evidence / "acquisition-progress.json", progress)
    return manifest


class VerificationTest(unittest.TestCase):
    """Verify dynamic acquisition closure and fail-closed reuse."""

    # independently reject finite values outside physical metric domains
    def test_rejects_nonphysical_response_values(self) -> None:
        frozen_plan = plan()
        identity = {
            "key": "ecmwf_single_run_hindcast|2024-03-14T00:00",
            "cohort": "ecmwf_single_run_hindcast",
            "runInitializedAt": "2024-03-14T00:00:00Z",
        }
        # exercise both endpoints of every independently checked domain
        for variable, values in (
            ("temperature_2m", (-101, 71)),
            ("relative_humidity_2m", (-1, 101)),
            ("wind_speed_10m", (-1, 151)),
            ("precipitation", (-1, 2001)),
            ("surface_pressure", (99, 1201)),
            ("cloud_cover", (-1, 101)),
        ):
            # require rejection before reconstruction produces retained rows
            for value in values:
                with self.subTest(variable=variable, value=value):
                    body = response(identity, 80)
                    body["hourly"][variable][1] = value
                    with self.assertRaises(verifier.VerificationError):
                        verifier.normalized_from_response(canonical(body).encode(), identity, frozen_plan)

    # retain independently reconstructed domain endpoints and explicit nulls
    def test_accepts_response_boundaries_and_nulls(self) -> None:
        frozen_plan = plan()
        identity = {
            "key": "ecmwf_single_run_hindcast|2024-03-14T00:00",
            "cohort": "ecmwf_single_run_hindcast",
            "runInitializedAt": "2024-03-14T00:00:00Z",
        }
        body = response(identity, 80)
        # preserve each physical endpoint and missing value
        for variable, bounds in (
            ("temperature_2m", (-100, 70)),
            ("relative_humidity_2m", (0, 100)),
            ("wind_speed_10m", (0, 150)),
            ("precipitation", (0, 2000)),
            ("surface_pressure", (100, 1200)),
            ("cloud_cover", (0, 100)),
        ):
            body["hourly"][variable][1:4] = [*bounds, None]
        data, _ = verifier.normalized_from_response(canonical(body).encode(), identity, frozen_plan)
        # read the independently reconstructed public schema
        rows = [json.loads(line) for line in data.splitlines()]
        self.assertEqual(len(rows), 48)
        self.assertEqual(rows[0]["rawPrecipitationMm"], 0)
        self.assertEqual(rows[1]["rawPrecipitationMm"], 2000)
        self.assertIsNone(rows[2]["rawPrecipitationMm"])

    # verify success and exact reuse
    def test_verifies_dynamic_outcomes_and_reuses_exact_evidence(self) -> None:
        """Derive current success, gap, and attempt totals."""
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(verifier, "FROZEN_REQUESTED_RUNS", 8),
            mock.patch.object(verifier, "FROZEN_COHORT_RANGES", COMPACT_RANGES),
        ):
            base = Path(directory)
            private_root = base / "private"
            evidence = base / "evidence"
            manifest = acquisition_fixture(private_root, evidence)
            first = verifier.verify(private_root, evidence)
            second = verifier.verify(private_root, evidence)
            self.assertEqual(first, second)
            self.assertEqual(first["statusCounts"], {"success": 7, "gap": 1})
            self.assertEqual(first["verdict"], "PASS")
            verification = json.loads(
                (evidence / "acquisition-verification.json").read_text()
            )
            self.assertEqual(verification["verdict"], "PASS")
            self.assertEqual(first["gapCounts"], {"http_404": 1})
            self.assertEqual(first["attemptsStarted"], 8)
            self.assertEqual(
                first["manifestSha256"],
                file_hash(private_root / "acquisition/manifest.json"),
            )
            self.assertEqual(
                first["cohortFiles"],
                {
                    cohort: {
                        **member,
                        "absolutePath": str(
                            (private_root / "acquisition" / member["path"]).resolve()
                        ),
                        "hashVerified": True,
                        "rowCountVerified": True,
                    }
                    for cohort, member in manifest["cohortFiles"].items()
                },
            )

    # reject changed normalized data
    def test_rejects_changed_member_and_existing_evidence(self) -> None:
        """Fail when source or prior evidence bytes change."""
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(verifier, "FROZEN_REQUESTED_RUNS", 8),
            mock.patch.object(verifier, "FROZEN_COHORT_RANGES", COMPACT_RANGES),
        ):
            base = Path(directory)
            private_root = base / "private"
            evidence = base / "evidence"
            acquisition_fixture(private_root, evidence)
            verifier.verify(private_root, evidence)
            summary_path = evidence / "acquisition-summary.json"
            summary = json.loads(summary_path.read_text())
            summary["attemptsStarted"] = 9
            write_json(summary_path, summary)

            with self.assertRaisesRegex(
                verifier.VerificationError, "existing verification output changed"
            ):
                verifier.verify(private_root, evidence)

            summary["attemptsStarted"] = 8
            write_json(summary_path, summary)
            member = (
                private_root / "acquisition/normalized/ecmwf_single_run_hindcast.jsonl"
            )
            member.write_bytes(member.read_bytes() + b"{}\n")

            with self.assertRaisesRegex(verifier.VerificationError, "cohort member"):
                verifier.verify(private_root, evidence)

    # reject partial attempt state
    def test_rejects_partial_attempt_artifacts(self) -> None:
        """Fail closed when a completed manifest references an unfinished attempt."""
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(verifier, "FROZEN_REQUESTED_RUNS", 8),
            mock.patch.object(verifier, "FROZEN_COHORT_RANGES", COMPACT_RANGES),
        ):
            base = Path(directory)
            private_root = base / "private"
            evidence = base / "evidence"
            acquisition_fixture(private_root, evidence)
            identity = verifier.build_identities(plan())[0]
            result = (
                private_root
                / "acquisition/runs"
                / identity["cohort"]
                / identity["slug"]
                / "attempts/01/result.json"
            )
            result.unlink()

            with self.assertRaisesRegex(verifier.VerificationError, "attempt result"):
                verifier.verify(private_root, evidence)

    # reject violated global spacing
    def test_rejects_recomputed_rate_violation(self) -> None:
        """Derive cadence from current attempt timestamps."""
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(verifier, "FROZEN_REQUESTED_RUNS", 8),
            mock.patch.object(verifier, "FROZEN_COHORT_RANGES", COMPACT_RANGES),
        ):
            base = Path(directory)
            private_root = base / "private"
            evidence = base / "evidence"
            acquisition_fixture(private_root, evidence)
            identities = verifier.build_identities(plan())
            first_request = (
                private_root
                / "acquisition/runs"
                / identities[0]["cohort"]
                / identities[0]["slug"]
                / "attempts/01/request.json"
            )
            second_request = (
                private_root
                / "acquisition/runs"
                / identities[1]["cohort"]
                / identities[1]["slug"]
                / "attempts/01/request.json"
            )
            first = json.loads(first_request.read_text())
            second = json.loads(second_request.read_text())
            second["startedAtUtc"] = (
                dt.datetime.fromisoformat(first["startedAtUtc"])
                + dt.timedelta(milliseconds=100)
            ).isoformat()
            write_json(second_request, second)

            with self.assertRaisesRegex(verifier.VerificationError, "start spacing"):
                verifier.verify(private_root, evidence)


# run through unittest only
if __name__ == "__main__":
    unittest.main()
