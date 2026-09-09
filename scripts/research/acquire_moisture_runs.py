#!/usr/bin/env python3
"""Acquire frozen Open-Meteo single-run inputs for moisture research."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Any, Iterable
from urllib.parse import urlencode


CONTRACT_VERSION = "moisture-shortlead-acquisition/v1"
ENDPOINT = "https://single-runs-api.open-meteo.com/v1/forecast"
ENDPOINT_HOST = "single-runs-api.open-meteo.com"
DEFAULT_RESOLVE_ADDRESS = "5.9.98.184"
SITE_LATITUDE = "47.950429954185445"
SITE_LONGITUDE = "-122.42797012608193"
EXPECTED_VARIABLES = [
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "precipitation",
    "surface_pressure",
    "cloud_cover"
]
EXPECTED_UNITS = {
    "time": "iso8601",
    "temperature_2m": "°C",
    "relative_humidity_2m": "%",
    "wind_speed_10m": "m/s",
    "precipitation": "mm",
    "surface_pressure": "hPa",
    "cloud_cover": "%"
}
COHORT_MODELS = {
    "ecmwf_single_run_hindcast": "ecmwf_ifs",
    "best_match_single_run_transfer": "best_match"
}
# mirror the canonical weather-record metric domains at the provider boundary
VARIABLE_BOUNDS = {
    "temperature_2m": (-100, 70),
    "relative_humidity_2m": (0, 100),
    "wind_speed_10m": (0, 150),
    "precipitation": (0, 2000),
    "surface_pressure": (100, 1200),
    "cloud_cover": (0, 100),
}
ROW_CLASSIFICATION = "retrospective_model_run_initialization_not_observed_issue_time"
RETRYABLE_HTTP_STATUSES = frozenset(range(500, 600))
NO_RETRY_HTTP_STATUSES = frozenset((400, 404, 429))
MAX_RESPONSE_BYTES = 5 * 1024 * 1024


class AcquisitionError(Exception):
    """Represent a safe acquisition contract failure."""


# encode canonical json lines
def canonical_json(value: Any) -> str:
    """Encode deterministic compact JSON without non-finite values."""
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True
    )


# hash exact bytes
def sha256_bytes(value: bytes) -> str:
    """Return the lowercase SHA-256 identity of bytes."""
    return hashlib.sha256(value).hexdigest()


# write one private atomic file
def atomic_write(path: Path, value: bytes, mode: int = 0o600) -> None:
    """Write private bytes atomically without following an existing target."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.partial")

    # reject stale temporary collisions
    if temporary.exists():
        raise AcquisitionError(f"temporary output already exists: {temporary}")

    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)

    # complete and sync the temporary file
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    os.replace(temporary, path)


# write one canonical json object
def write_json(path: Path, value: Any) -> None:
    """Write one canonical private JSON object."""
    atomic_write(path, (canonical_json(value) + "\n").encode("utf-8"))


# parse one strict json file
def read_json(path: Path) -> Any:
    """Decode one UTF-8 JSON file without permissive constants."""
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite number"))
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise AcquisitionError(f"invalid json file: {path}") from error


# require an ordinary object
def require_object(value: Any, label: str) -> dict[str, Any]:
    """Require a JSON object."""
    if not isinstance(value, dict):
        raise AcquisitionError(f"{label} must be an object")

    return value


# require a strict integer
def require_integer(value: Any, label: str) -> int:
    """Require an integer that is not a boolean."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise AcquisitionError(f"{label} must be an integer")

    return value


# parse a frozen date
def parse_date(value: Any, label: str) -> dt.date:
    """Parse an exact ISO calendar date."""
    if not isinstance(value, str):
        raise AcquisitionError(f"{label} must be an ISO date")

    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise AcquisitionError(f"{label} must be an ISO date") from error

    if parsed.isoformat() != value:
        raise AcquisitionError(f"{label} must be a canonical ISO date")

    return parsed


# enumerate inclusive calendar dates
def inclusive_dates(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    """Yield every date in an inclusive range."""
    current = start

    # retain all requested dates
    while current <= end:
        yield current
        current += dt.timedelta(days=1)


# validate the frozen acquisition plan
def load_plan(path: Path) -> dict[str, Any]:
    """Load and validate the complete acquisition plan."""
    plan = require_object(read_json(path), "plan")

    # bind the public archive contract
    if plan.get("contractVersion") != CONTRACT_VERSION or plan.get("endpoint") != ENDPOINT:
        raise AcquisitionError("plan contract or endpoint does not match")

    # bind the forecast shape
    if plan.get("variables") != EXPECTED_VARIABLES:
        raise AcquisitionError("plan variables do not match")

    if plan.get("forecastHours") != 49 or plan.get("selectedLeads") != [1, 48]:
        raise AcquisitionError("plan forecast horizon does not match")

    if plan.get("cycleHoursUtc") != [0, 6, 12, 18]:
        raise AcquisitionError("plan cycles do not match")

    # bind bounded concurrency and cadence
    if plan.get("concurrency") != 3 or require_integer(
        plan.get("minimumGlobalStartSpacingMs"), "minimumGlobalStartSpacingMs"
    ) < 300:
        raise AcquisitionError("plan concurrency or start spacing does not match")

    if plan.get("maximumAttemptsPerRun") != 2 or plan.get("maximumAttempts") != 4800:
        raise AcquisitionError("plan attempt limits do not match")

    # bind both total and rolling budgets
    rate_caps = require_object(plan.get("rateCaps"), "rateCaps")
    if rate_caps != {"hourly": 4800, "daily": 4800}:
        raise AcquisitionError("plan rolling rate caps do not match")

    # forbid production mutation semantics
    if plan.get("productionWrites") is not False:
        raise AcquisitionError("plan must forbid production writes")

    cohorts = require_object(plan.get("cohorts"), "cohorts")

    # bind exact independent cohorts
    if list(cohorts) != list(COHORT_MODELS):
        raise AcquisitionError("plan cohorts do not match")

    calculated_runs = 0

    # validate every declared date range
    for cohort, model in COHORT_MODELS.items():
        definition = require_object(cohorts.get(cohort), cohort)

        if definition.get("model") != model:
            raise AcquisitionError(f"{cohort} model does not match")

        start = parse_date(definition.get("from"), f"{cohort}.from")
        end = parse_date(definition.get("through"), f"{cohort}.through")

        if end < start:
            raise AcquisitionError(f"{cohort} date range is reversed")

        calculated_runs += ((end - start).days + 1) * len(plan["cycleHoursUtc"])

    # bind every requested identity
    if require_integer(plan.get("requestedRuns"), "requestedRuns") != calculated_runs:
        raise AcquisitionError("requestedRuns does not match cohort ranges")

    return plan


# build all immutable request identities
def build_identities(plan: dict[str, Any]) -> list[dict[str, str]]:
    """Build every cohort, model, date, and cycle identity."""
    identities: list[dict[str, str]] = []

    # keep cohorts separate and deterministic
    for cohort, model in COHORT_MODELS.items():
        definition = plan["cohorts"][cohort]
        start = parse_date(definition["from"], f"{cohort}.from")
        end = parse_date(definition["through"], f"{cohort}.through")

        # retain every requested calendar date
        for date in inclusive_dates(start, end):
            # retain every requested UTC model cycle
            for hour in plan["cycleHoursUtc"]:
                run = f"{date.isoformat()}T{hour:02d}:00"
                key = f"{cohort}|{run}"
                identities.append(
                    {
                        "key": key,
                        "cohort": cohort,
                        "model": model,
                        "run": run,
                        "runInitializedAt": f"{run}:00Z",
                        "slug": hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
                    }
                )

    if len(identities) != plan["requestedRuns"]:
        raise AcquisitionError("identity count does not match the plan")

    return identities


# build one stable public query
def request_url(plan: dict[str, Any], identity: dict[str, str]) -> str:
    """Build one exact Single Runs API URL."""
    query = [
        ("latitude", SITE_LATITUDE),
        ("longitude", SITE_LONGITUDE),
        ("run", identity["run"]),
        ("models", identity["model"]),
        ("hourly", ",".join(plan["variables"])),
        ("forecast_hours", str(plan["forecastHours"])),
        ("timezone", "GMT"),
        ("temperature_unit", "celsius"),
        ("wind_speed_unit", "ms"),
        ("precipitation_unit", "mm"),
        ("timeformat", "iso8601")
    ]
    return f"{plan['endpoint']}?{urlencode(query)}"


# require a finite number or null
def finite_or_null(value: Any, label: str) -> float | int | None:
    """Validate a forecast cell without replacing missing data."""
    if value is None:
        return None

    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise AcquisitionError(f"{label} must be a finite number or null")

    if not math.isfinite(float(value)):
        raise AcquisitionError(f"{label} must be a finite number or null")

    return value


# parse one exact UTC hour
def parse_hour(value: Any, label: str) -> dt.datetime:
    """Parse an Open-Meteo UTC hourly timestamp."""
    if not isinstance(value, str):
        raise AcquisitionError(f"{label} must be an hourly timestamp")

    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M").replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise AcquisitionError(f"{label} must be an hourly timestamp") from error

    return parsed


# normalize one successful response
def normalize_response(
    body: bytes,
    identity: dict[str, str],
    plan: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Validate one exact 49-hour response and retain leads one through 48."""
    if len(body) == 0 or len(body) > MAX_RESPONSE_BYTES:
        raise AcquisitionError("response byte length is outside the bound")

    try:
        response = json.loads(
            body,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite number"))
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise AcquisitionError("response is not strict JSON") from error

    response = require_object(response, "response")
    hourly_units = require_object(response.get("hourly_units"), "hourly_units")

    if hourly_units != EXPECTED_UNITS:
        raise AcquisitionError("response units do not match")

    # require an unshifted UTC response
    if response.get("utc_offset_seconds") != 0 or response.get("timezone") != "GMT":
        raise AcquisitionError("response timezone does not match GMT")

    returned_latitude = finite_or_null(response.get("latitude"), "latitude")
    returned_longitude = finite_or_null(response.get("longitude"), "longitude")
    elevation = finite_or_null(response.get("elevation"), "elevation")

    if returned_latitude is None or returned_longitude is None or elevation is None:
        raise AcquisitionError("response grid and elevation must be finite")

    hourly = require_object(response.get("hourly"), "hourly")
    expected_hourly_keys = frozenset(("time", *plan["variables"]))

    if frozenset(hourly) != expected_hourly_keys:
        raise AcquisitionError("response hourly keys do not match")

    times = hourly.get("time")

    if not isinstance(times, list) or len(times) != plan["forecastHours"]:
        raise AcquisitionError("response must contain exactly 49 timestamps")

    initialized_at = dt.datetime.fromisoformat(identity["runInitializedAt"].replace("Z", "+00:00"))
    parsed_times: list[dt.datetime] = []

    # verify every timestamp against the requested initialization
    for index, value in enumerate(times):
        parsed = parse_hour(value, f"hourly.time[{index}]")

        if parsed != initialized_at + dt.timedelta(hours=index):
            raise AcquisitionError("response timestamps are missing, shifted, or non-consecutive")

        parsed_times.append(parsed)

    values_by_variable: dict[str, list[float | int | None]] = {}
    null_counts: dict[str, int] = {}

    # validate every requested variable independently
    for variable in plan["variables"]:
        values = hourly.get(variable)

        if not isinstance(values, list) or len(values) != plan["forecastHours"]:
            raise AcquisitionError(f"{variable} must contain exactly 49 values")

        validated: list[float | int | None] = []

        minimum, maximum = VARIABLE_BOUNDS[variable]
        # retain missing data while rejecting physically invalid forecast cells
        for index, value in enumerate(values):
            cell = finite_or_null(value, f"{variable}[{index}]")
            # fail the response rather than clipping or silently dropping values
            if cell is not None and not minimum <= cell <= maximum:
                raise AcquisitionError(f"{variable}[{index}] is outside its physical domain")
            validated.append(cell)

        values_by_variable[variable] = validated
        null_counts[variable] = sum(value is None for value in validated[1:49])

    rows: list[dict[str, Any]] = []

    # retain leads one through 48 only
    for lead in range(1, 49):
        rows.append(
            {
                "key": f"{identity['key']}|lead={lead}",
                "cohort": identity["cohort"],
                "validAt": parsed_times[lead].isoformat().replace("+00:00", "Z"),
                "referenceAt": identity["runInitializedAt"],
                "runInitializedAt": identity["runInitializedAt"],
                "actualIssueAt": None,
                "runReferenceClassification": ROW_CLASSIFICATION,
                "targetLeadHours": lead,
                "rawTemperatureC": values_by_variable["temperature_2m"][lead],
                "rawRelativeHumidityPercent": values_by_variable["relative_humidity_2m"][lead],
                "rawWindSpeedMps": values_by_variable["wind_speed_10m"][lead],
                "rawPrecipitationMm": values_by_variable["precipitation"][lead],
                "rawPressureHpa": values_by_variable["surface_pressure"][lead],
                "rawCloudCoverPercent": values_by_variable["cloud_cover"][lead],
                "forecastElevationM": elevation
            }
        )

    metadata = {
        "returnedGrid": {
            "latitude": returned_latitude,
            "longitude": returned_longitude
        },
        "forecastElevationM": elevation,
        "units": hourly_units,
        "validHourInitializationDifference": {
            "minimumHours": 0,
            "maximumHours": 48,
            "consecutive": True
        },
        "selectedLeadHours": {"minimum": 1, "maximum": 48},
        "normalizedRows": len(rows),
        "nullCountsSelectedLeads": null_counts,
        "actualIssueAt": None,
        "runReferenceClassification": ROW_CLASSIFICATION
    }
    return rows, metadata


# inspect immutable attempt artifacts
def attempt_records(run_root: Path) -> list[dict[str, Any]]:
    """Read and verify every persisted attempt for one run."""
    attempts_root = run_root / "attempts"

    if not attempts_root.exists():
        return []

    records: list[dict[str, Any]] = []

    # verify every numbered attempt directory
    for expected_index, attempt_root in enumerate(sorted(attempts_root.iterdir()), start=1):
        if not attempt_root.is_dir() or attempt_root.name != f"{expected_index:02d}":
            raise AcquisitionError(f"unexpected attempt path: {attempt_root}")

        request = require_object(read_json(attempt_root / "request.json"), "attempt request")

        if request.get("attempt") != expected_index:
            raise AcquisitionError(f"attempt index mismatch: {attempt_root}")

        result_path = attempt_root / "result.json"

        # retain interrupted attempts as consumed starts
        if not result_path.exists():
            records.append({"request": request, "result": None, "attemptRoot": attempt_root})
            continue

        result = require_object(read_json(result_path), "attempt result")
        body_path = attempt_root / "body.bin"

        if not body_path.is_file():
            raise AcquisitionError(f"attempt body is missing: {attempt_root}")

        body = body_path.read_bytes()

        if result.get("responseBytes") != len(body) or result.get("responseSha256") != sha256_bytes(body):
            raise AcquisitionError(f"attempt body hash mismatch: {attempt_root}")

        records.append({"request": request, "result": result, "attemptRoot": attempt_root})

    return records


# verify one completed success
def verified_success(run_root: Path, identity: dict[str, str]) -> dict[str, Any] | None:
    """Verify and return one exact completed success receipt."""
    receipt_path = run_root / "run-result.json"

    if not receipt_path.exists():
        return None

    receipt = require_object(read_json(receipt_path), "run result")

    if receipt.get("key") != identity["key"]:
        raise AcquisitionError(f"run result identity mismatch: {run_root}")

    if receipt.get("status") != "success":
        return receipt

    response_path = run_root / str(receipt.get("responsePath"))
    normalized_path = run_root / str(receipt.get("normalizedPath"))

    if not response_path.is_file() or not normalized_path.is_file():
        raise AcquisitionError(f"completed response artifacts are missing: {run_root}")

    response = response_path.read_bytes()
    normalized = normalized_path.read_bytes()

    if receipt.get("responseBytes") != len(response) or receipt.get("responseSha256") != sha256_bytes(response):
        raise AcquisitionError(f"completed response hash mismatch: {run_root}")

    if receipt.get("normalizedBytes") != len(normalized) or receipt.get("normalizedSha256") != sha256_bytes(normalized):
        raise AcquisitionError(f"completed normalization hash mismatch: {run_root}")

    lines = normalized.splitlines()

    if len(lines) != 48:
        raise AcquisitionError(f"completed normalization row count mismatch: {run_root}")

    # revalidate every retained normalized row
    for line in lines:
        require_object(json.loads(line), "normalized row")

    return receipt


class AttemptController:
    """Serialize global starts and enforce total and rolling budgets."""

    # initialize from durable attempt starts
    def __init__(
        self,
        plan: dict[str, Any],
        prior_starts: list[dt.datetime],
        stop_event: threading.Event
    ) -> None:
        """Initialize the thread-safe request-start gate."""
        self._spacing_seconds = plan["minimumGlobalStartSpacingMs"] / 1000
        self._maximum_attempts = plan["maximumAttempts"]
        self._hourly_cap = plan["rateCaps"]["hourly"]
        self._daily_cap = plan["rateCaps"]["daily"]
        self._starts = sorted(prior_starts)
        self._last_monotonic: float | None = None
        self._last_wall = self._starts[-1] if self._starts else None
        self._lock = threading.Lock()
        self._stop_event = stop_event

    # expose the durable attempt count
    @property
    def total_attempts(self) -> int:
        """Return the number of starts reserved so far."""
        with self._lock:
            return len(self._starts)

    # reserve and persist one request start
    def reserve(self, attempt_root: Path, request: dict[str, Any]) -> dt.datetime:
        """Reserve one request under spacing and rolling-budget limits."""
        with self._lock:
            if self._stop_event.is_set():
                raise AcquisitionError("acquisition stopped")

            now_monotonic = time.monotonic()
            delays: list[float] = []

            # enforce spacing against the prior process start
            if self._last_monotonic is not None:
                delays.append(self._spacing_seconds - (now_monotonic - self._last_monotonic))

            # enforce spacing across process resumes
            if self._last_wall is not None:
                wall_elapsed = (
                    dt.datetime.now(dt.timezone.utc) - self._last_wall
                ).total_seconds()
                delays.append(self._spacing_seconds - wall_elapsed)

            delay = max(delays, default=0)

            if delay > 0:
                time.sleep(delay)

            now = dt.datetime.now(dt.timezone.utc)
            hour_ago = now - dt.timedelta(hours=1)
            day_ago = now - dt.timedelta(days=1)
            hourly = sum(start > hour_ago for start in self._starts)
            daily = sum(start > day_ago for start in self._starts)

            # stop rather than wait through a rolling cap
            if (
                len(self._starts) >= self._maximum_attempts
                or hourly >= self._hourly_cap
                or daily >= self._daily_cap
            ):
                self._stop_event.set()
                raise AcquisitionError("request budget exhausted")

            started_at = dt.datetime.now(dt.timezone.utc)
            request = {
                **request,
                "startedAtUtc": started_at.isoformat(),
                "minimumGlobalStartSpacingMs": round(self._spacing_seconds * 1000)
            }
            attempt_root.mkdir(mode=0o700, parents=True, exist_ok=False)
            write_json(attempt_root / "request.json", request)
            self._starts.append(started_at)
            self._last_monotonic = time.monotonic()
            self._last_wall = started_at
            return started_at


class ProgressReporter:
    """Persist bounded aggregate progress without row-level data."""

    # initialize aggregate counters
    def __init__(
        self,
        evidence_path: Path,
        private_path: Path,
        requested: int,
        initial_receipts: list[dict[str, Any]],
        controller: AttemptController
    ) -> None:
        """Initialize progress from verified terminal receipts."""
        self._evidence_path = evidence_path
        self._private_path = private_path
        self._requested = requested
        self._controller = controller
        self._lock = threading.Lock()
        self._finished = len(initial_receipts)
        self._success = sum(receipt.get("status") == "success" for receipt in initial_receipts)
        self._gaps = self._finished - self._success

    # write aggregate progress
    def _write_locked(self, state: str) -> None:
        """Write one aggregate progress checkpoint."""
        report = {
            "contractVersion": CONTRACT_VERSION,
            "recordedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "state": state,
            "requestedRuns": self._requested,
            "finishedRuns": self._finished,
            "successfulRuns": self._success,
            "terminalGaps": self._gaps,
            "pendingRuns": self._requested - self._finished,
            "attemptsStarted": self._controller.total_attempts,
            "containsRowData": False
        }
        write_json(self._evidence_path, report)
        write_json(self._private_path, report)

    # count one newly terminal identity
    def terminal(self, receipt: dict[str, Any]) -> None:
        """Record one terminal run and checkpoint at most every 100 runs."""
        with self._lock:
            self._finished += 1

            if receipt.get("status") == "success":
                self._success += 1
            else:
                self._gaps += 1

            # bound checkpoint distance to 100 terminal runs
            if self._finished % 100 == 0:
                self._write_locked("running")

    # force a current checkpoint
    def write(self, state: str) -> None:
        """Write current aggregate progress regardless of interval."""
        with self._lock:
            self._write_locked(state)


# load and validate all prior starts
def prior_attempt_starts(acquisition_root: Path, identities: list[dict[str, str]]) -> list[dt.datetime]:
    """Validate persisted attempt artifacts and collect their start times."""
    starts: list[dt.datetime] = []

    # retain all attempts across every requested identity
    for identity in identities:
        run_root = acquisition_root / "runs" / identity["cohort"] / identity["slug"]

        for record in attempt_records(run_root):
            request = record["request"]

            if request.get("key") != identity["key"]:
                raise AcquisitionError(f"attempt identity mismatch: {run_root}")

            try:
                started_at = dt.datetime.fromisoformat(str(request["startedAtUtc"]))
            except (KeyError, ValueError) as error:
                raise AcquisitionError(f"attempt start is invalid: {run_root}") from error

            if started_at.tzinfo is None:
                raise AcquisitionError(f"attempt start is not timezone aware: {run_root}")

            starts.append(started_at.astimezone(dt.timezone.utc))

    return starts


# classify a completed curl attempt
def attempt_outcome(result: dict[str, Any] | None) -> str:
    """Classify one attempt as successful, retryable, or terminal."""
    if result is None or result.get("transportReturnCode") != 0:
        return "retryable_transport"

    status = result.get("httpStatus")

    if status == 200:
        return "response"

    if status == 429:
        return "rate_limited"

    if status in RETRYABLE_HTTP_STATUSES:
        return "retryable_http"

    return "terminal_http"


# persist one terminal gap receipt
def write_gap(
    run_root: Path,
    identity: dict[str, str],
    reason: str,
    attempts: list[dict[str, Any]]
) -> dict[str, Any]:
    """Persist one terminal gap without discarding its identity."""
    receipt = {
        "key": identity["key"],
        "cohort": identity["cohort"],
        "model": identity["model"],
        "runInitializedAt": identity["runInitializedAt"],
        "status": "gap",
        "gapReason": reason,
        "attemptCount": len(attempts),
        "httpStatuses": [
            record["result"].get("httpStatus") if record["result"] is not None else None
            for record in attempts
        ],
        "actualIssueAt": None,
        "runReferenceClassification": ROW_CLASSIFICATION
    }
    write_json(run_root / "run-result.json", receipt)
    return receipt


# persist one validated successful run
def write_success(
    run_root: Path,
    identity: dict[str, str],
    attempt: dict[str, Any],
    rows: list[dict[str, Any]],
    metadata: dict[str, Any],
    attempts: list[dict[str, Any]]
) -> dict[str, Any]:
    """Persist normalized rows and an exact-hash success receipt."""
    normalized = b"".join((canonical_json(row) + "\n").encode("utf-8") for row in rows)
    normalized_path = run_root / "normalized.jsonl"
    atomic_write(normalized_path, normalized)
    attempt_root = attempt["attemptRoot"]
    response_path = attempt_root / "body.bin"
    response = response_path.read_bytes()
    receipt = {
        "key": identity["key"],
        "cohort": identity["cohort"],
        "model": identity["model"],
        "runInitializedAt": identity["runInitializedAt"],
        "status": "success",
        "attemptCount": len(attempts),
        "httpStatuses": [
            record["result"].get("httpStatus") if record["result"] is not None else None
            for record in attempts
        ],
        "responsePath": str(response_path.relative_to(run_root)),
        "responseBytes": len(response),
        "responseSha256": sha256_bytes(response),
        "normalizedPath": normalized_path.name,
        "normalizedBytes": len(normalized),
        "normalizedSha256": sha256_bytes(normalized),
        **metadata
    }
    write_json(run_root / "run-result.json", receipt)
    return receipt


# execute one public curl request
def curl_attempt(
    curl_path: str,
    resolve_address: str,
    url: str,
    attempt_root: Path
) -> dict[str, Any]:
    """Execute one bounded HTTPS request with standard hostname validation."""
    partial_body = attempt_root / "body.partial"
    body_path = attempt_root / "body.bin"
    command = [
        curl_path,
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--connect-timeout",
        "15",
        "--max-time",
        "120",
        "--max-filesize",
        str(MAX_RESPONSE_BYTES),
        "--resolve",
        f"{ENDPOINT_HOST}:443:{resolve_address}",
        "--output",
        str(partial_body),
        "--write-out",
        "%{http_code}",
        url
    ]
    completed = subprocess.run(command, capture_output=True, check=False)
    body = partial_body.read_bytes() if partial_body.exists() else b""

    if len(body) > MAX_RESPONSE_BYTES:
        raise AcquisitionError("curl response exceeded the byte limit")

    atomic_write(body_path, body)
    partial_body.unlink(missing_ok=True)
    status_text = completed.stdout.decode("ascii", errors="ignore").strip()
    http_status = int(status_text) if status_text.isdigit() and len(status_text) == 3 else None
    result = {
        "completedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "transportReturnCode": completed.returncode,
        "httpStatus": http_status,
        "responseBytes": len(body),
        "responseSha256": sha256_bytes(body),
        "stderrBytes": len(completed.stderr),
        "standardTlsHostnameValidation": True,
        "resolvedAddress": resolve_address
    }
    write_json(attempt_root / "result.json", result)
    return result


# complete or resume one run identity
def acquire_identity(
    identity: dict[str, str],
    plan: dict[str, Any],
    acquisition_root: Path,
    curl_path: str,
    resolve_address: str,
    controller: AttemptController,
    stop_event: threading.Event
) -> tuple[dict[str, Any], bool]:
    """Acquire one identity with bounded transport and server retries."""
    run_root = acquisition_root / "runs" / identity["cohort"] / identity["slug"]
    run_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    existing = verified_success(run_root, identity)

    if existing is not None:
        return existing, False

    attempts = attempt_records(run_root)

    # resume a completed response before any new request
    if attempts and attempt_outcome(attempts[-1]["result"]) == "response":
        attempt = attempts[-1]

        try:
            rows, metadata = normalize_response(
                (attempt["attemptRoot"] / "body.bin").read_bytes(), identity, plan
            )
        except AcquisitionError:
            return write_gap(run_root, identity, "invalid_response", attempts), True

        return write_success(run_root, identity, attempt, rows, metadata, attempts), True

    # preserve a prior terminal response after interruption
    if attempts:
        prior_outcome = attempt_outcome(attempts[-1]["result"])

        if prior_outcome == "rate_limited":
            stop_event.set()
            return write_gap(run_root, identity, "http_429_rate_limited", attempts), True

        if prior_outcome == "terminal_http":
            status = attempts[-1]["result"].get("httpStatus")
            return write_gap(run_root, identity, f"http_{status}", attempts), True

    # use only the frozen attempt allowance
    while len(attempts) < plan["maximumAttemptsPerRun"]:
        if stop_event.is_set():
            raise AcquisitionError("acquisition stopped")

        attempt_index = len(attempts) + 1
        attempt_root = run_root / "attempts" / f"{attempt_index:02d}"
        url = request_url(plan, identity)
        controller.reserve(
            attempt_root,
            {
                "key": identity["key"],
                "cohort": identity["cohort"],
                "model": identity["model"],
                "runInitializedAt": identity["runInitializedAt"],
                "attempt": attempt_index,
                "url": url
            }
        )
        curl_attempt(curl_path, resolve_address, url, attempt_root)
        attempts = attempt_records(run_root)
        outcome = attempt_outcome(attempts[-1]["result"])

        # normalize only a complete 200 response
        if outcome == "response":
            try:
                rows, metadata = normalize_response(
                    (attempts[-1]["attemptRoot"] / "body.bin").read_bytes(), identity, plan
                )
            except AcquisitionError:
                return write_gap(run_root, identity, "invalid_response", attempts), True

            return write_success(
                run_root, identity, attempts[-1], rows, metadata, attempts
            ), True

        # stop globally on provider rate limiting
        if outcome == "rate_limited":
            stop_event.set()
            return write_gap(run_root, identity, "http_429_rate_limited", attempts), True

        # retain non-retryable client and other responses
        if outcome == "terminal_http":
            status = attempts[-1]["result"].get("httpStatus")
            return write_gap(run_root, identity, f"http_{status}", attempts), True

        # allow only one retry for transport and 5xx failures
        if outcome not in ("retryable_transport", "retryable_http"):
            raise AcquisitionError("unexpected attempt outcome")

    final_outcome = attempt_outcome(attempts[-1]["result"])
    reason = "transport_failure" if final_outcome == "retryable_transport" else "http_5xx"
    return write_gap(run_root, identity, reason, attempts), True


# build deterministic cohort outputs and manifest
def finalize(
    plan_path: Path,
    plan: dict[str, Any],
    identities: list[dict[str, str]],
    acquisition_root: Path,
    script_sha256: str,
    controller: AttemptController
) -> dict[str, Any]:
    """Verify all identities and assemble deterministic cohort JSONL files."""
    normalized_root = acquisition_root / "normalized"
    normalized_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipts: list[dict[str, Any]] = []
    cohort_files: dict[str, dict[str, Any]] = {}

    # verify every requested identity before aggregation
    for identity in identities:
        run_root = acquisition_root / "runs" / identity["cohort"] / identity["slug"]
        receipt = verified_success(run_root, identity)

        if receipt is None:
            receipt = {
                "key": identity["key"],
                "cohort": identity["cohort"],
                "model": identity["model"],
                "runInitializedAt": identity["runInitializedAt"],
                "status": "pending",
                "attemptCount": len(attempt_records(run_root)),
                "actualIssueAt": None,
                "runReferenceClassification": ROW_CLASSIFICATION
            }

        receipts.append(receipt)

    # keep cohort row streams physically separate
    for cohort in COHORT_MODELS:
        output_path = normalized_root / f"{cohort}.jsonl"
        temporary = output_path.with_name(f".{output_path.name}.{os.getpid()}.partial")
        digest = hashlib.sha256()
        byte_count = 0
        row_count = 0
        success_count = 0

        with temporary.open("xb") as output:
            # concatenate successes in requested identity order
            for identity, receipt in zip(identities, receipts, strict=True):
                if identity["cohort"] != cohort or receipt["status"] != "success":
                    continue

                run_root = acquisition_root / "runs" / cohort / identity["slug"]
                normalized = (run_root / receipt["normalizedPath"]).read_bytes()
                output.write(normalized)
                digest.update(normalized)
                byte_count += len(normalized)
                row_count += 48
                success_count += 1

            output.flush()
            os.fsync(output.fileno())

        os.replace(temporary, output_path)
        cohort_files[cohort] = {
            "path": str(output_path.relative_to(acquisition_root)),
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
            "rows": row_count,
            "successfulRuns": success_count
        }

    status_counts: dict[str, int] = {}
    gap_counts: dict[str, int] = {}
    null_counts = {cohort: {variable: 0 for variable in EXPECTED_VARIABLES} for cohort in COHORT_MODELS}

    # summarize statuses and nulls without hiding any identity
    for receipt in receipts:
        status = str(receipt["status"])
        status_counts[status] = status_counts.get(status, 0) + 1

        if status == "gap":
            reason = str(receipt.get("gapReason"))
            gap_counts[reason] = gap_counts.get(reason, 0) + 1

        if status == "success":
            for variable, count in receipt["nullCountsSelectedLeads"].items():
                null_counts[receipt["cohort"]][variable] += count

    manifest = {
        "contractVersion": CONTRACT_VERSION,
        "completedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "plan": {
            "path": str(plan_path),
            "bytes": plan_path.stat().st_size,
            "sha256": sha256_bytes(plan_path.read_bytes())
        },
        "acquisitionScriptSha256": script_sha256,
        "endpoint": plan["endpoint"],
        "requestCoordinates": {
            "latitude": float(SITE_LATITUDE),
            "longitude": float(SITE_LONGITUDE)
        },
        "requestedRuns": len(identities),
        "attemptsStarted": controller.total_attempts,
        "statusCounts": status_counts,
        "gapCounts": gap_counts,
        "nullCountsSelectedLeads": null_counts,
        "cohortFiles": cohort_files,
        "identities": receipts,
        "actualIssueTimeKnown": False,
        "runReferenceClassification": ROW_CLASSIFICATION,
        "productionWrites": False,
        "modelFit": False
    }
    write_json(acquisition_root / "manifest.json", manifest)
    return manifest


# run the complete frozen acquisition
def acquire(args: argparse.Namespace) -> int:
    """Run or resume the complete bounded acquisition."""
    plan_path = args.plan.resolve()
    private_root = args.private_root.resolve()
    evidence_root = args.evidence_root.resolve()
    plan = load_plan(plan_path)
    identities = build_identities(plan)
    script_path = Path(__file__).resolve()
    script_sha256 = sha256_bytes(script_path.read_bytes())
    acquisition_root = private_root / "acquisition"
    acquisition_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    contract_path = acquisition_root / "contract.json"
    contract = {
        "contractVersion": CONTRACT_VERSION,
        "planSha256": sha256_bytes(plan_path.read_bytes()),
        "scriptSha256": script_sha256,
        "requestedRuns": len(identities),
        "resolve": {
            "host": ENDPOINT_HOST,
            "address": args.resolve_address,
            "standardTlsHostnameValidation": True
        }
    }

    # fail closed on changed code or plan during resume
    if contract_path.exists():
        if read_json(contract_path) != contract:
            raise AcquisitionError("existing acquisition contract does not match")
    else:
        write_json(contract_path, contract)

    starts = prior_attempt_starts(acquisition_root, identities)
    stop_event = threading.Event()
    controller = AttemptController(plan, starts, stop_event)
    existing_receipts: list[dict[str, Any]] = []
    pending: list[dict[str, str]] = []

    # verify completed responses before deciding what to resume
    for identity in identities:
        run_root = acquisition_root / "runs" / identity["cohort"] / identity["slug"]
        receipt = verified_success(run_root, identity)

        if receipt is None:
            pending.append(identity)
        else:
            existing_receipts.append(receipt)

    progress = ProgressReporter(
        evidence_root / "acquisition-progress.json",
        acquisition_root / "progress.json",
        len(identities),
        existing_receipts,
        controller
    )
    progress.write("running")
    failures: list[str] = []

    # bound concurrent public requests to the frozen worker count
    with concurrent.futures.ThreadPoolExecutor(max_workers=plan["concurrency"]) as executor:
        in_flight: dict[concurrent.futures.Future[tuple[dict[str, Any], bool]], dict[str, str]] = {}
        pending_iterator = iter(pending)
        exhausted = False

        # continue until all scheduled identities finish or a global stop occurs
        while in_flight or not exhausted:
            # fill only the bounded worker window
            while not exhausted and not stop_event.is_set() and len(in_flight) < plan["concurrency"]:
                try:
                    identity = next(pending_iterator)
                except StopIteration:
                    exhausted = True
                    break

                future = executor.submit(
                    acquire_identity,
                    identity,
                    plan,
                    acquisition_root,
                    args.curl,
                    args.resolve_address,
                    controller,
                    stop_event
                )
                in_flight[future] = identity

            if not in_flight:
                break

            done, _pending_futures = concurrent.futures.wait(
                in_flight,
                return_when=concurrent.futures.FIRST_COMPLETED
            )

            # account for every completed worker
            for future in done:
                identity = in_flight.pop(future)

                try:
                    receipt, newly_terminal = future.result()
                except AcquisitionError as error:
                    failures.append(f"{identity['key']}: {error}")

                    if str(error) in ("request budget exhausted", "acquisition stopped"):
                        stop_event.set()
                except Exception as error:
                    failures.append(f"{identity['key']}: unexpected {type(error).__name__}")
                    stop_event.set()
                else:
                    if newly_terminal:
                        progress.terminal(receipt)

    manifest = finalize(
        plan_path,
        plan,
        identities,
        acquisition_root,
        script_sha256,
        controller
    )
    complete = manifest["statusCounts"].get("pending", 0) == 0
    progress.write("complete" if complete else "stopped")
    summary = {
        "status": "complete" if complete else "stopped",
        "requestedRuns": manifest["requestedRuns"],
        "attemptsStarted": manifest["attemptsStarted"],
        "statusCounts": manifest["statusCounts"],
        "gapCounts": manifest["gapCounts"],
        "manifestSha256": sha256_bytes((acquisition_root / "manifest.json").read_bytes()),
        "failureCount": len(failures)
    }
    print(canonical_json(summary))

    if failures:
        print(f"error: {failures[0]}", file=sys.stderr)

    return 0 if complete and not failures else 1


# parse the narrow command interface
def parse_arguments() -> argparse.Namespace:
    """Parse exact acquisition paths and the pinned resolver address."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--private-root", required=True, type=Path)
    parser.add_argument("--evidence-root", required=True, type=Path)
    parser.add_argument("--curl", default="/usr/bin/curl")
    parser.add_argument("--resolve-address", default=DEFAULT_RESOLVE_ADDRESS)
    return parser.parse_args()


# expose one safe command boundary
def main() -> int:
    """Run the acquisition without traceback or response disclosure."""
    try:
        return acquire(parse_arguments())
    except AcquisitionError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


# run only as a command
if __name__ == "__main__":
    raise SystemExit(main())
