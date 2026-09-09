#!/usr/bin/env python3
"""Test the frozen Open-Meteo moisture acquisition contract."""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name("acquire_moisture_runs.py")
SPEC = importlib.util.spec_from_file_location("acquire_moisture_runs", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ACQUIRE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ACQUIRE)


# build one exact plan with configurable ranges
def valid_plan(
    ecmwf_from: str = "2024-03-14",
    ecmwf_through: str = "2024-03-14",
    best_from: str = "2026-04-02",
    best_through: str = "2026-04-02"
) -> dict[str, object]:
    """Build a compact plan under the production acquisition contract."""
    ranges = [(ecmwf_from, ecmwf_through), (best_from, best_through)]
    runs = sum(
        (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 1
        for start, end in ranges
    ) * 4
    return {
        "contractVersion": ACQUIRE.CONTRACT_VERSION,
        "endpoint": ACQUIRE.ENDPOINT,
        "cohorts": {
            "ecmwf_single_run_hindcast": {
                "model": "ecmwf_ifs",
                "from": ecmwf_from,
                "through": ecmwf_through
            },
            "best_match_single_run_transfer": {
                "model": "best_match",
                "from": best_from,
                "through": best_through
            }
        },
        "cycleHoursUtc": [0, 6, 12, 18],
        "requestedRuns": runs,
        "variables": ACQUIRE.EXPECTED_VARIABLES,
        "forecastHours": 49,
        "selectedLeads": [1, 48],
        "minimumGlobalStartSpacingMs": 300,
        "concurrency": 3,
        "maximumAttemptsPerRun": 2,
        "maximumAttempts": 4800,
        "productionWrites": False,
        "rateCaps": {"hourly": 4800, "daily": 4800}
    }


# build one exact 49-hour response
def valid_response(run: str = "2024-03-14T00:00") -> dict[str, object]:
    """Build one valid response with one retained null forecast."""
    initialized = dt.datetime.strptime(run, "%Y-%m-%dT%H:%M")
    times = [
        (initialized + dt.timedelta(hours=index)).strftime("%Y-%m-%dT%H:%M")
        for index in range(49)
    ]
    return {
        "latitude": 47.97891,
        "longitude": -122.44185,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "elevation": 28.0,
        "hourly_units": dict(ACQUIRE.EXPECTED_UNITS),
        "hourly": {
            "time": times,
            "temperature_2m": [10.0] * 49,
            "relative_humidity_2m": [80] * 49,
            "wind_speed_10m": [2.0] * 49,
            "precipitation": [None, *([0.1] * 48)],
            "surface_pressure": [1000.0] * 49,
            "cloud_cover": [90] * 49
        }
    }


# encode one strict response body
def response_bytes(response: object) -> bytes:
    """Encode a response body without non-finite values."""
    return json.dumps(response, allow_nan=False, separators=(",", ":")).encode("utf-8")


class PlanAndNormalizationTest(unittest.TestCase):
    """Verify identities, units, timestamps, leads, and null preservation."""

    # reject finite provider values outside the canonical metric domains
    def test_rejects_nonphysical_forecasts(self) -> None:
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]
        # exercise both ends of every requested metric domain
        for variable, values in (
            ("temperature_2m", (-101, 71)),
            ("relative_humidity_2m", (-1, 101)),
            ("wind_speed_10m", (-1, 151)),
            ("precipitation", (-1, 2001)),
            ("surface_pressure", (99, 1201)),
            ("cloud_cover", (-1, 101)),
        ):
            # reject each nonphysical finite value
            for value in values:
                with self.subTest(variable=variable, value=value):
                    response = valid_response(identity["run"])
                    response["hourly"][variable][1] = value
                    with self.assertRaises(ACQUIRE.AcquisitionError):
                        ACQUIRE.normalize_response(response_bytes(response), identity, plan)

    # preserve domain endpoints and explicit missing observations
    def test_accepts_forecast_boundaries_and_nulls(self) -> None:
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]
        response = valid_response(identity["run"])
        # retain each lower endpoint, upper endpoint and null
        for variable, bounds in (
            ("temperature_2m", (-100, 70)),
            ("relative_humidity_2m", (0, 100)),
            ("wind_speed_10m", (0, 150)),
            ("precipitation", (0, 2000)),
            ("surface_pressure", (100, 1200)),
            ("cloud_cover", (0, 100)),
        ):
            response["hourly"][variable][1:4] = [*bounds, None]
        rows, _ = ACQUIRE.normalize_response(response_bytes(response), identity, plan)
        self.assertEqual(len(rows), 48)
        self.assertEqual(rows[0]["rawPrecipitationMm"], 0)
        self.assertEqual(rows[1]["rawPrecipitationMm"], 2000)
        self.assertIsNone(rows[2]["rawPrecipitationMm"])

    # verify the full frozen identity count
    def test_builds_all_4260_frozen_identities(self) -> None:
        """Retain all ECMWF and Best Match cycles independently."""
        plan = valid_plan("2024-03-14", "2026-09-06", "2026-04-02", "2026-09-06")
        self.assertEqual(plan["requestedRuns"], 4260)
        identities = ACQUIRE.build_identities(plan)
        self.assertEqual(len(identities), 4260)
        self.assertEqual(identities[0]["key"], "ecmwf_single_run_hindcast|2024-03-14T00:00")
        self.assertEqual(identities[-1]["key"], "best_match_single_run_transfer|2026-09-06T18:00")
        self.assertEqual(len({identity["key"] for identity in identities}), 4260)

    # verify exact lead normalization
    def test_normalizes_leads_one_through_48_with_provenance(self) -> None:
        """Map a valid 49-hour response to 48 retrospective rows."""
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]
        rows, metadata = ACQUIRE.normalize_response(
            response_bytes(valid_response(identity["run"])), identity, plan
        )
        self.assertEqual(len(rows), 48)
        self.assertEqual(rows[0]["targetLeadHours"], 1)
        self.assertEqual(rows[-1]["targetLeadHours"], 48)
        self.assertEqual(rows[0]["referenceAt"], identity["runInitializedAt"])
        self.assertEqual(rows[0]["actualIssueAt"], None)
        self.assertEqual(rows[0]["runReferenceClassification"], ACQUIRE.ROW_CLASSIFICATION)
        self.assertEqual(rows[0]["rawPrecipitationMm"], 0.1)
        self.assertEqual(rows[0]["forecastElevationM"], 28.0)
        self.assertEqual(metadata["returnedGrid"], {"latitude": 47.97891, "longitude": -122.44185})
        self.assertEqual(metadata["normalizedRows"], 48)

    # reject malformed or incomplete structures
    def test_rejects_malformed_missing_and_nonfinite_responses(self) -> None:
        """Reject malformed JSON, missing variables, and non-finite cells."""
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]
        cases: list[bytes] = [b"not-json", b"[]"]
        missing = valid_response(identity["run"])
        del missing["hourly"]["surface_pressure"]
        cases.append(response_bytes(missing))
        nonfinite = valid_response(identity["run"])
        nonfinite["hourly"]["temperature_2m"][4] = float("inf")
        cases.append(json.dumps(nonfinite).encode("utf-8"))

        # reject every malformed case
        for body in cases:
            with self.subTest(body=body[:20]):
                with self.assertRaises(ACQUIRE.AcquisitionError):
                    ACQUIRE.normalize_response(body, identity, plan)

    # reject alternate units
    def test_rejects_unit_drift(self) -> None:
        """Reject responses whose requested measurement units changed."""
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]
        response = valid_response(identity["run"])
        response["hourly_units"]["wind_speed_10m"] = "km/h"

        with self.assertRaisesRegex(ACQUIRE.AcquisitionError, "units"):
            ACQUIRE.normalize_response(response_bytes(response), identity, plan)

    # reject shifted and gapped timestamps
    def test_rejects_timestamp_shift_and_gap(self) -> None:
        """Reject valid-looking arrays not anchored to the requested run."""
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]

        for index in (0, 17):
            response = valid_response(identity["run"])
            response["hourly"]["time"][index] = "2024-03-20T00:00"

            with self.subTest(index=index):
                with self.assertRaisesRegex(ACQUIRE.AcquisitionError, "timestamps"):
                    ACQUIRE.normalize_response(response_bytes(response), identity, plan)

        short = valid_response(identity["run"])

        # shorten every parallel array consistently
        for key in short["hourly"]:
            short["hourly"][key] = short["hourly"][key][:-1]

        with self.assertRaisesRegex(ACQUIRE.AcquisitionError, "49 timestamps"):
            ACQUIRE.normalize_response(response_bytes(short), identity, plan)


class ResumeAndBudgetTest(unittest.TestCase):
    """Verify exact-hash resume and bounded attempt accounting."""

    # build one successful persisted run
    def persist_success(
        self,
        root: Path,
        identity: dict[str, str],
        plan: dict[str, object]
    ) -> dict[str, object]:
        """Persist one success through the production artifact functions."""
        run_root = root / "runs" / identity["cohort"] / identity["slug"]
        attempt_root = run_root / "attempts" / "01"
        attempt_root.mkdir(mode=0o700, parents=True)
        body = response_bytes(valid_response(identity["run"]))
        ACQUIRE.write_json(
            attempt_root / "request.json",
            {
                "key": identity["key"],
                "attempt": 1,
                "startedAtUtc": "2026-09-08T00:00:00+00:00"
            }
        )
        ACQUIRE.atomic_write(attempt_root / "body.bin", body)
        result = {
            "transportReturnCode": 0,
            "httpStatus": 200,
            "responseBytes": len(body),
            "responseSha256": ACQUIRE.sha256_bytes(body)
        }
        ACQUIRE.write_json(attempt_root / "result.json", result)
        attempts = ACQUIRE.attempt_records(run_root)
        rows, metadata = ACQUIRE.normalize_response(body, identity, plan)
        return ACQUIRE.write_success(run_root, identity, attempts[-1], rows, metadata, attempts)

    # verify exact hash checking on resume
    def test_resume_accepts_exact_files_and_rejects_changed_bytes(self) -> None:
        """Resume only completed files matching their immutable receipt hashes."""
        plan = valid_plan()
        identity = ACQUIRE.build_identities(plan)[0]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.persist_success(root, identity, plan)
            run_root = root / "runs" / identity["cohort"] / identity["slug"]
            self.assertEqual(ACQUIRE.verified_success(run_root, identity)["status"], "success")
            normalized_path = run_root / "normalized.jsonl"
            normalized_path.write_bytes(normalized_path.read_bytes() + b"{}\n")

            with self.assertRaisesRegex(ACQUIRE.AcquisitionError, "hash mismatch"):
                ACQUIRE.verified_success(run_root, identity)

    # verify total and rolling budgets
    def test_budget_rejects_total_hourly_and_daily_caps(self) -> None:
        """Stop before creating an attempt outside any frozen request cap."""
        plan = valid_plan()
        now = dt.datetime.now(dt.timezone.utc)

        for label, starts, limits in (
            ("total", [now - dt.timedelta(days=2)] * 4800, (4800, 5000, 5000)),
            ("hourly", [now - dt.timedelta(minutes=1)] * 4800, (5000, 4800, 5000)),
            ("daily", [now - dt.timedelta(hours=2)] * 4800, (5000, 5000, 4800))
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                plan["maximumAttempts"], plan["rateCaps"]["hourly"], plan["rateCaps"]["daily"] = limits
                stop = threading.Event()
                controller = ACQUIRE.AttemptController(plan, starts, stop)
                attempt_root = Path(directory) / "01"

                with self.assertRaisesRegex(ACQUIRE.AcquisitionError, "budget exhausted"):
                    controller.reserve(attempt_root, {"attempt": 1})

                self.assertTrue(stop.is_set())
                self.assertFalse(attempt_root.exists())

    # verify the retry policy classifications
    def test_retry_policy_is_transport_and_5xx_only(self) -> None:
        """Retry only transport and server failures and stop on 429."""
        self.assertEqual(ACQUIRE.attempt_outcome(None), "retryable_transport")
        self.assertEqual(
            ACQUIRE.attempt_outcome({"transportReturnCode": 7, "httpStatus": None}),
            "retryable_transport"
        )
        self.assertEqual(
            ACQUIRE.attempt_outcome({"transportReturnCode": 0, "httpStatus": 503}),
            "retryable_http"
        )
        self.assertEqual(
            ACQUIRE.attempt_outcome({"transportReturnCode": 0, "httpStatus": 400}),
            "terminal_http"
        )
        self.assertEqual(
            ACQUIRE.attempt_outcome({"transportReturnCode": 0, "httpStatus": 404}),
            "terminal_http"
        )
        self.assertEqual(
            ACQUIRE.attempt_outcome({"transportReturnCode": 0, "httpStatus": 429}),
            "rate_limited"
        )


# run through unittest only
if __name__ == "__main__":
    unittest.main()
