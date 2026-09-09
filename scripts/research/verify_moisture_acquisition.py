#!/usr/bin/env python3
"""Independently verify the frozen moisture archive acquisition."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import itertools
import json
import math
import os
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any
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
    "cloud_cover",
]
EXPECTED_UNITS = {
    "time": "iso8601",
    "temperature_2m": "°C",
    "relative_humidity_2m": "%",
    "wind_speed_10m": "m/s",
    "precipitation": "mm",
    "surface_pressure": "hPa",
    "cloud_cover": "%",
}
COHORT_MODELS = {
    "ecmwf_single_run_hindcast": "ecmwf_ifs",
    "best_match_single_run_transfer": "best_match",
}
# independently mirror canonical metric domains without trusting the producer
VARIABLE_BOUNDS = {
    "temperature_2m": (-100, 70),
    "relative_humidity_2m": (0, 100),
    "wind_speed_10m": (0, 150),
    "precipitation": (0, 2000),
    "surface_pressure": (100, 1200),
    "cloud_cover": (0, 100),
}
FROZEN_COHORT_RANGES = {
    "ecmwf_single_run_hindcast": ("2024-03-14", "2026-09-06"),
    "best_match_single_run_transfer": ("2026-04-02", "2026-09-06"),
}
FROZEN_REQUESTED_RUNS = 4260
ROW_CLASSIFICATION = "retrospective_model_run_initialization_not_observed_issue_time"
NORMALIZED_FIELDS = {
    "key",
    "cohort",
    "validAt",
    "referenceAt",
    "runInitializedAt",
    "actualIssueAt",
    "runReferenceClassification",
    "targetLeadHours",
    "rawTemperatureC",
    "rawRelativeHumidityPercent",
    "rawWindSpeedMps",
    "rawPrecipitationMm",
    "rawPressureHpa",
    "rawCloudCoverPercent",
    "forecastElevationM",
}
VALUE_FIELDS = {
    "temperature_2m": "rawTemperatureC",
    "relative_humidity_2m": "rawRelativeHumidityPercent",
    "wind_speed_10m": "rawWindSpeedMps",
    "precipitation": "rawPrecipitationMm",
    "surface_pressure": "rawPressureHpa",
    "cloud_cover": "rawCloudCoverPercent",
}


class VerificationError(Exception):
    """Represent a closed verification failure."""


# encode deterministic json
def canonical_json(value: Any) -> str:
    """Encode strict canonical JSON."""
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


# hash exact bytes
def sha256_bytes(value: bytes) -> str:
    """Return one lowercase SHA-256 digest."""
    return hashlib.sha256(value).hexdigest()


# hash one regular file
def file_sha256(path: Path) -> str:
    """Hash one file without retaining it in memory."""
    require_file(path, "hash input")

    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


# require one ordinary file
def require_file(path: Path, label: str) -> Path:
    """Reject absent files and terminal symlinks."""
    if path.is_symlink() or not path.is_file():
        raise VerificationError(f"{label} is missing or not a regular file: {path}")

    return path


# parse one strict json file
def read_json(path: Path, label: str) -> Any:
    """Read strict UTF-8 JSON from one regular file."""
    require_file(path, label)

    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite number")
            ),
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise VerificationError(f"invalid {label}: {path}") from error


# require one object
def require_object(value: Any, label: str) -> dict[str, Any]:
    """Require a JSON object."""
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be an object")

    return value


# require one strict integer
def require_integer(value: Any, label: str) -> int:
    """Require a non-boolean integer."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise VerificationError(f"{label} must be an integer")

    return value


# require one finite number
def finite(value: Any, label: str) -> float | int:
    """Require a finite non-boolean number."""
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise VerificationError(f"{label} must be finite")

    return value


# preserve finite numbers or null
def finite_or_null(value: Any, label: str) -> float | int | None:
    """Require a finite number or explicit null."""
    if value is None:
        return None

    return finite(value, label)


# parse an exact calendar date
def parse_date(value: Any, label: str) -> dt.date:
    """Parse a canonical ISO calendar date."""
    if not isinstance(value, str):
        raise VerificationError(f"{label} must be an ISO date")

    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise VerificationError(f"{label} must be an ISO date") from error

    if parsed.isoformat() != value:
        raise VerificationError(f"{label} must be a canonical ISO date")

    return parsed


# enumerate inclusive dates
def inclusive_dates(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    """Yield every calendar date in one range."""
    current = start

    # retain every planned date
    while current <= end:
        yield current
        current += dt.timedelta(days=1)


# validate the frozen plan
def load_plan(path: Path) -> dict[str, Any]:
    """Validate the immutable 4260-run acquisition plan."""
    plan = require_object(read_json(path, "acquisition plan"), "acquisition plan")

    # bind the source contract
    if (
        plan.get("contractVersion") != CONTRACT_VERSION
        or plan.get("endpoint") != ENDPOINT
    ):
        raise VerificationError("plan contract or endpoint changed")

    # bind response shape
    if (
        plan.get("variables") != EXPECTED_VARIABLES
        or plan.get("forecastHours") != 49
        or plan.get("selectedLeads") != [1, 48]
    ):
        raise VerificationError("plan forecast shape changed")

    # bind cycle coverage
    if plan.get("cycleHoursUtc") != [0, 6, 12, 18]:
        raise VerificationError("plan cycles changed")

    # bind bounded request controls
    if (
        plan.get("concurrency") != 3
        or require_integer(
            plan.get("minimumGlobalStartSpacingMs"), "minimumGlobalStartSpacingMs"
        )
        < 300
    ):
        raise VerificationError("plan concurrency or spacing changed")

    # bind attempt limits
    if plan.get("maximumAttemptsPerRun") != 2 or plan.get("maximumAttempts") != 4800:
        raise VerificationError("plan attempt limits changed")

    # bind rolling limits
    if plan.get("rateCaps") != {"hourly": 4800, "daily": 4800}:
        raise VerificationError("plan rolling limits changed")

    # preserve read-only scope
    if plan.get("productionWrites") is not False:
        raise VerificationError("plan permits production writes")

    cohorts = require_object(plan.get("cohorts"), "plan cohorts")

    # bind cohort identity
    if set(cohorts) != set(COHORT_MODELS):
        raise VerificationError("plan cohorts changed")

    calculated = 0

    # validate each frozen range
    for cohort, model in COHORT_MODELS.items():
        definition = require_object(cohorts.get(cohort), cohort)
        expected_from, expected_through = FROZEN_COHORT_RANGES[cohort]

        # bind model and dates
        if definition.get("model") != model or (
            definition.get("from"),
            definition.get("through"),
        ) != (expected_from, expected_through):
            raise VerificationError(f"{cohort} model or date range changed")

        start = parse_date(definition["from"], f"{cohort}.from")
        end = parse_date(definition["through"], f"{cohort}.through")

        # reject reversed ranges
        if end < start:
            raise VerificationError(f"{cohort} date range is reversed")

        calculated += ((end - start).days + 1) * len(plan["cycleHoursUtc"])

    requested = require_integer(plan.get("requestedRuns"), "requestedRuns")

    # bind all frozen identities
    if requested != calculated or requested != FROZEN_REQUESTED_RUNS:
        raise VerificationError("plan requested-run count changed")

    return plan


# build immutable identities
def build_identities(plan: dict[str, Any]) -> list[dict[str, str]]:
    """Build every cohort, model, date, and cycle identity."""
    identities = []

    # isolate cohorts deterministically
    for cohort, model in COHORT_MODELS.items():
        definition = plan["cohorts"][cohort]
        start = parse_date(definition["from"], f"{cohort}.from")
        end = parse_date(definition["through"], f"{cohort}.through")

        # retain every date
        for day in inclusive_dates(start, end):
            # retain every cycle
            for hour in plan["cycleHoursUtc"]:
                run = f"{day.isoformat()}T{hour:02d}:00"
                key = f"{cohort}|{run}"
                identities.append(
                    {
                        "key": key,
                        "cohort": cohort,
                        "model": model,
                        "run": run,
                        "runInitializedAt": f"{run}:00Z",
                        "slug": hashlib.sha256(key.encode()).hexdigest()[:24],
                    }
                )

    # close identity generation
    if len(identities) != plan["requestedRuns"] or len(
        {item["key"] for item in identities}
    ) != len(identities):
        raise VerificationError("generated acquisition identities do not close")

    return identities


# build one exact request url
def request_url(plan: dict[str, Any], identity: dict[str, str]) -> str:
    """Build the frozen public request URL."""
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
        ("timeformat", "iso8601"),
    ]
    return f"{plan['endpoint']}?{urlencode(query)}"


# parse one request timestamp
def parse_aware_instant(value: Any, label: str) -> dt.datetime:
    """Parse one timezone-aware instant as UTC."""
    if not isinstance(value, str):
        raise VerificationError(f"{label} must be a timestamp")

    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise VerificationError(f"{label} must be a timestamp") from error

    # require explicit timezone
    if parsed.tzinfo is None:
        raise VerificationError(f"{label} must be timezone aware")

    return parsed.astimezone(dt.timezone.utc)


# parse one response hour
def parse_response_hour(value: Any, label: str) -> dt.datetime:
    """Parse one exact Open-Meteo UTC hour."""
    if not isinstance(value, str):
        raise VerificationError(f"{label} must be an hourly timestamp")

    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as error:
        raise VerificationError(f"{label} must be an hourly timestamp") from error


# derive normalized response material
def normalized_from_response(
    body: bytes, identity: dict[str, str], plan: dict[str, Any]
) -> tuple[bytes, dict[str, Any]]:
    """Independently reconstruct every selected response row."""
    try:
        response = json.loads(
            body,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite number")
            ),
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise VerificationError("successful response is not strict JSON") from error

    response = require_object(response, "successful response")
    units = require_object(response.get("hourly_units"), "response units")

    # bind units and timezone
    if (
        units != EXPECTED_UNITS
        or response.get("utc_offset_seconds") != 0
        or response.get("timezone") != "GMT"
    ):
        raise VerificationError("successful response units or timezone changed")

    latitude = finite(response.get("latitude"), "response latitude")
    longitude = finite(response.get("longitude"), "response longitude")
    elevation = finite(response.get("elevation"), "response elevation")
    hourly = require_object(response.get("hourly"), "response hourly")

    # bind all hourly arrays
    if set(hourly) != {"time", *EXPECTED_VARIABLES}:
        raise VerificationError("successful response hourly keys changed")

    times = hourly.get("time")

    # require full response horizon
    if not isinstance(times, list) or len(times) != plan["forecastHours"]:
        raise VerificationError("successful response timestamp count changed")

    initialized = parse_aware_instant(
        identity["runInitializedAt"], "run initialization"
    )
    parsed_times = []

    # bind consecutive response timestamps
    for index, value in enumerate(times):
        parsed = parse_response_hour(value, f"hourly.time[{index}]")

        # reject shifted response hours
        if parsed != initialized + dt.timedelta(hours=index):
            raise VerificationError("successful response timestamps shifted")

        parsed_times.append(parsed)

    values_by_variable = {}
    null_counts = {}

    # validate every variable array
    for variable in EXPECTED_VARIABLES:
        values = hourly.get(variable)

        # bind parallel array length
        if not isinstance(values, list) or len(values) != plan["forecastHours"]:
            raise VerificationError(f"successful response {variable} count changed")

        validated = []

        minimum, maximum = VARIABLE_BOUNDS[variable]
        # independently reject nonphysical material while preserving explicit nulls
        for index, value in enumerate(values):
            cell = finite_or_null(value, f"{variable}[{index}]")
            # prevent invalid values from receiving a successful verification receipt
            if cell is not None and not minimum <= cell <= maximum:
                raise VerificationError(f"{variable}[{index}] is outside its physical domain")
            validated.append(cell)

        values_by_variable[variable] = validated
        null_counts[variable] = sum(value is None for value in validated[1:49])

    rows = []

    # reconstruct retained leads
    for lead in range(1, 49):
        row = {
            "key": f"{identity['key']}|lead={lead}",
            "cohort": identity["cohort"],
            "validAt": parsed_times[lead].isoformat().replace("+00:00", "Z"),
            "referenceAt": identity["runInitializedAt"],
            "runInitializedAt": identity["runInitializedAt"],
            "actualIssueAt": None,
            "runReferenceClassification": ROW_CLASSIFICATION,
            "targetLeadHours": lead,
            "rawTemperatureC": values_by_variable["temperature_2m"][lead],
            "rawRelativeHumidityPercent": values_by_variable["relative_humidity_2m"][
                lead
            ],
            "rawWindSpeedMps": values_by_variable["wind_speed_10m"][lead],
            "rawPrecipitationMm": values_by_variable["precipitation"][lead],
            "rawPressureHpa": values_by_variable["surface_pressure"][lead],
            "rawCloudCoverPercent": values_by_variable["cloud_cover"][lead],
            "forecastElevationM": elevation,
        }

        # preserve the fixed schema
        if set(row) != NORMALIZED_FIELDS:
            raise VerificationError("internal normalized schema changed")

        rows.append(row)

    normalized = b"".join((canonical_json(row) + "\n").encode("utf-8") for row in rows)
    metadata = {
        "returnedGrid": {"latitude": latitude, "longitude": longitude},
        "forecastElevationM": elevation,
        "units": units,
        "validHourInitializationDifference": {
            "minimumHours": 0,
            "maximumHours": 48,
            "consecutive": True,
        },
        "selectedLeadHours": {"minimum": 1, "maximum": 48},
        "normalizedRows": 48,
        "nullCountsSelectedLeads": null_counts,
        "actualIssueAt": None,
        "runReferenceClassification": ROW_CLASSIFICATION,
    }
    return normalized, metadata


# resolve one contained file
def contained_file(root: Path, relative: Any, label: str) -> Path:
    """Resolve a relative regular file inside one root."""
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise VerificationError(f"{label} path is not relative")

    candidate = root / relative

    # reject terminal symlinks before resolution
    if candidate.is_symlink():
        raise VerificationError(f"{label} path is a symlink")

    try:
        root_resolved = root.resolve(strict=True)
        path = candidate.resolve(strict=True)
    except OSError as error:
        raise VerificationError(f"{label} path is missing") from error

    # prevent root escape
    if not path.is_relative_to(root_resolved):
        raise VerificationError(f"{label} path escapes its root")

    require_file(path, label)
    return path


# resolve one contained directory
def contained_directory(root: Path, relative: Path, label: str) -> Path:
    """Resolve a non-symlink directory inside one root."""
    candidate = root / relative

    # reject absent or linked directories
    if candidate.is_symlink() or not candidate.is_dir():
        raise VerificationError(f"{label} is missing or linked")

    root_resolved = root.resolve(strict=True)
    path = candidate.resolve(strict=True)

    # prevent directory escape
    if not path.is_relative_to(root_resolved):
        raise VerificationError(f"{label} escapes its root")

    return path


# classify one persisted attempt
def attempt_outcome(result: dict[str, Any]) -> str:
    """Classify one completed request attempt."""
    transport = require_integer(
        result.get("transportReturnCode"), "transport return code"
    )
    status = result.get("httpStatus")

    # validate nullable status
    if status is not None:
        require_integer(status, "http status")

    # classify transport failure first
    if transport != 0:
        return "transport"

    # classify successful transport statuses
    if status == 200:
        return "response"

    # preserve rate-limit identity
    if status == 429:
        return "rate_limited"

    # preserve retryable server errors
    if isinstance(status, int) and 500 <= status <= 599:
        return "http_5xx"

    return "terminal_http"


# validate terminal attempt history
def validate_attempt_closure(
    receipt: dict[str, Any], attempts: list[dict[str, Any]], plan: dict[str, Any]
) -> None:
    """Bind retries and terminal status to the frozen policy."""
    outcomes = [attempt_outcome(attempt["result"]) for attempt in attempts]

    # bind receipt counts
    if (
        receipt.get("attemptCount") != len(attempts)
        or not 1 <= len(attempts) <= plan["maximumAttemptsPerRun"]
    ):
        raise VerificationError("attempt count does not close")

    statuses = [attempt["result"].get("httpStatus") for attempt in attempts]

    # bind receipt status sequence
    if receipt.get("httpStatuses") != statuses:
        raise VerificationError("attempt status sequence does not close")

    # require retryable predecessors
    for outcome in outcomes[:-1]:
        if outcome not in {"transport", "http_5xx"}:
            raise VerificationError("attempt retry policy changed")

    status = receipt.get("status")

    # bind successful termination
    if status == "success":
        if outcomes[-1] != "response":
            raise VerificationError("successful receipt lacks a successful response")

        return

    # reject unknown terminal states
    if status != "gap":
        raise VerificationError("manifest contains a nonterminal run")

    reason = receipt.get("gapReason")
    final = outcomes[-1]

    # bind terminal response reasons
    if reason == "invalid_response" and final == "response":
        return

    # bind provider rate limits
    if reason == "http_429_rate_limited" and final == "rate_limited":
        return

    # bind exhausted transport retry
    if (
        reason == "transport_failure"
        and final == "transport"
        and len(attempts) == plan["maximumAttemptsPerRun"]
    ):
        return

    # bind exhausted server retry
    if (
        reason == "http_5xx"
        and final == "http_5xx"
        and len(attempts) == plan["maximumAttemptsPerRun"]
    ):
        return

    # bind terminal http status
    if final == "terminal_http" and reason == f"http_{statuses[-1]}":
        return

    raise VerificationError("gap reason does not close against attempts")


# compute a maximum rolling count
def maximum_rolling(starts: list[dt.datetime], duration: dt.timedelta) -> int:
    """Count starts in the largest right-closed rolling window."""
    window: collections.deque[dt.datetime] = collections.deque()
    maximum = 0

    # slide across sorted starts
    for current in sorted(starts):
        # discard excluded boundary starts
        while window and current - window[0] >= duration:
            window.popleft()

        window.append(current)
        maximum = max(maximum, len(window))

    return maximum


# write an exclusive private file
def write_temporary(path: Path, value: bytes) -> Path:
    """Write and sync one exclusive temporary output."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)

    # reject stale temporary output
    if temporary.exists():
        raise VerificationError(f"temporary verification output exists: {temporary}")

    descriptor = os.open(temporary, flags, 0o600)

    # sync complete temporary bytes
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    return temporary


# install an output set without overwrite
def install_outputs(outputs: dict[Path, bytes]) -> None:
    """Install a small exact output set with collision rollback."""
    temporaries = {
        path: write_temporary(path, value) for path, value in outputs.items()
    }
    installed = []

    # link every output exclusively
    try:
        for path, temporary in temporaries.items():
            os.link(temporary, path)
            installed.append(path)
    except FileExistsError as error:
        # remove only owned links
        for path in installed:
            path.unlink()

        raise VerificationError("verification output appeared concurrently") from error
    finally:
        # remove all owned temporaries
        for temporary in temporaries.values():
            temporary.unlink(missing_ok=True)


# parse one prior verification timestamp
def existing_timestamp(summary: dict[str, Any], verification: dict[str, Any]) -> str:
    """Require matching timezone-aware verification timestamps."""
    value = summary.get("verifiedAtUtc")

    # bind both evidence files
    if value != verification.get("verifiedAtUtc"):
        raise VerificationError("existing verification output changed")

    parse_aware_instant(value, "verifiedAtUtc")
    return value


# verify or create deterministic evidence outputs
def preserve_outputs(
    evidence: Path, summary: dict[str, Any], verification: dict[str, Any]
) -> dict[str, Any]:
    """Reuse exact evidence or install a complete new pair."""
    summary_path = evidence / "acquisition-summary.json"
    verification_path = evidence / "acquisition-verification.json"
    present = (summary_path.exists(), verification_path.exists())

    # reject an incomplete evidence pair
    if present[0] != present[1]:
        raise VerificationError("partial verification output set exists")

    # independently reverify exact prior output
    if all(present):
        prior_summary = require_object(
            read_json(summary_path, "acquisition summary"), "acquisition summary"
        )
        prior_verification = require_object(
            read_json(verification_path, "acquisition verification"),
            "acquisition verification",
        )
        timestamp = existing_timestamp(prior_summary, prior_verification)
        expected_summary = {**summary, "verifiedAtUtc": timestamp}
        expected_verification = {**verification, "verifiedAtUtc": timestamp}

        # reject changed or stale evidence
        if (
            prior_summary != expected_summary
            or prior_verification != expected_verification
        ):
            raise VerificationError("existing verification output changed")

        return prior_summary

    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    outputs = {
        summary_path: (json.dumps(summary, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
        verification_path: (
            json.dumps(verification, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8"),
    }
    install_outputs(outputs)
    return summary


# verify the complete acquisition
def verify(private_root: Path, evidence: Path) -> dict[str, Any]:
    """Verify all frozen identities and write bounded aggregate evidence."""
    private_root = private_root.resolve(strict=True)
    evidence = evidence.resolve(strict=True)
    acquisition = contained_directory(
        private_root, Path("acquisition"), "acquisition root"
    )
    plan_path = evidence / "acquisition-plan.json"
    freeze_path = evidence / "acquisition-code-freeze.json"
    plan = load_plan(plan_path)
    identities = build_identities(plan)
    freeze = require_object(
        read_json(freeze_path, "acquisition code freeze"), "acquisition code freeze"
    )
    freeze_script = require_object(freeze.get("script"), "frozen script descriptor")
    freeze_test = require_object(freeze.get("test"), "frozen test descriptor")
    freeze_plan = require_object(freeze.get("plan"), "frozen plan descriptor")
    source_root = contained_directory(
        private_root,
        Path("runtime-sources/frozen-acquisition"),
        "frozen acquisition source root",
    )

    # bind declared repository source names
    if (
        freeze_script.get("path") != "scripts/research/acquire_moisture_runs.py"
        or freeze_test.get("path") != "scripts/research/test_acquire_moisture_runs.py"
    ):
        raise VerificationError("acquisition source freeze paths changed")

    frozen_script = contained_file(
        source_root, "acquire_moisture_runs.py", "frozen acquisition script"
    )
    frozen_test = contained_file(
        source_root, "test_acquire_moisture_runs.py", "frozen acquisition test"
    )
    plan_sha = file_sha256(plan_path)
    script_sha = file_sha256(frozen_script)

    # bind frozen source and plan bytes
    if (
        freeze_script.get("sha256") != script_sha
        or freeze_test.get("sha256") != file_sha256(frozen_test)
        or freeze_plan.get("sha256") != plan_sha
        or freeze_plan.get("requestedRuns") != FROZEN_REQUESTED_RUNS
    ):
        raise VerificationError("acquisition source freeze changed")

    contract = require_object(
        read_json(acquisition / "contract.json", "acquisition contract"),
        "acquisition contract",
    )
    expected_contract = {
        "contractVersion": CONTRACT_VERSION,
        "planSha256": plan_sha,
        "scriptSha256": script_sha,
        "requestedRuns": FROZEN_REQUESTED_RUNS,
        "resolve": {
            "host": ENDPOINT_HOST,
            "address": DEFAULT_RESOLVE_ADDRESS,
            "standardTlsHostnameValidation": True,
        },
    }

    # bind acquisition runtime contract
    if contract != expected_contract:
        raise VerificationError("acquisition contract changed")

    manifest_path = acquisition / "manifest.json"
    manifest_bytes = require_file(manifest_path, "acquisition manifest").read_bytes()

    try:
        manifest = require_object(
            json.loads(
                manifest_bytes,
                parse_constant=lambda _value: (_ for _ in ()).throw(
                    ValueError("non-finite number")
                ),
            ),
            "acquisition manifest",
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise VerificationError("invalid acquisition manifest") from error

    manifest_plan = require_object(manifest.get("plan"), "manifest plan descriptor")

    # bind manifest boundary
    if (
        manifest.get("contractVersion") != CONTRACT_VERSION
        or manifest.get("endpoint") != ENDPOINT
        or manifest.get("requestedRuns") != FROZEN_REQUESTED_RUNS
        or manifest.get("productionWrites") is not False
        or manifest.get("modelFit") is not False
        or manifest.get("actualIssueTimeKnown") is not False
        or manifest.get("runReferenceClassification") != ROW_CLASSIFICATION
    ):
        raise VerificationError("acquisition manifest boundary changed")

    # bind plan and source provenance
    if (
        manifest_plan.get("path") != str(plan_path.resolve())
        or manifest_plan.get("sha256") != plan_sha
        or manifest_plan.get("bytes") != plan_path.stat().st_size
        or manifest.get("acquisitionScriptSha256") != script_sha
    ):
        raise VerificationError("acquisition manifest provenance changed")

    expected_coordinates = {
        "latitude": float(SITE_LATITUDE),
        "longitude": float(SITE_LONGITUDE),
    }

    # bind request coordinates
    if manifest.get("requestCoordinates") != expected_coordinates:
        raise VerificationError("acquisition request coordinates changed")

    receipts = manifest.get("identities")

    # bind receipt cardinality
    if not isinstance(receipts, list) or len(receipts) != FROZEN_REQUESTED_RUNS:
        raise VerificationError("acquisition manifest identity count changed")

    status_counts: collections.Counter[str] = collections.Counter()
    gap_counts: collections.Counter[str] = collections.Counter()
    by_cycle: collections.Counter[tuple[str, str, str | None, str]] = (
        collections.Counter()
    )
    aggregate_nulls = {
        cohort: collections.Counter({variable: 0 for variable in EXPECTED_VARIABLES})
        for cohort in COHORT_MODELS
    }
    attempts_started = 0
    starts = []
    normalized_parts: dict[str, list[Path]] = {cohort: [] for cohort in COHORT_MODELS}

    # verify every frozen identity
    for receipt_value, identity in zip(receipts, identities, strict=True):
        receipt = require_object(receipt_value, "run receipt")
        identity_fields = {
            "key": identity["key"],
            "cohort": identity["cohort"],
            "model": identity["model"],
            "runInitializedAt": identity["runInitializedAt"],
        }

        # bind receipt identity
        if any(receipt.get(key) != value for key, value in identity_fields.items()):
            raise VerificationError("run receipt identity changed")

        run_root = contained_directory(
            acquisition,
            Path("runs") / identity["cohort"] / identity["slug"],
            "run root",
        )
        persisted = require_object(
            read_json(run_root / "run-result.json", "run result"), "run result"
        )

        # bind member receipt
        if persisted != receipt:
            raise VerificationError("run receipt differs from manifest")

        attempts_root = run_root / "attempts"

        # require one attempt directory
        if attempts_root.is_symlink() or not attempts_root.is_dir():
            raise VerificationError("attempt root is missing")

        attempt_paths = sorted(attempts_root.iterdir())
        attempts = []

        # verify every attempt member
        for index, attempt_root in enumerate(attempt_paths, start=1):
            if (
                attempt_root.is_symlink()
                or not attempt_root.is_dir()
                or attempt_root.name != f"{index:02d}"
            ):
                raise VerificationError("attempt directory sequence changed")

            request = require_object(
                read_json(attempt_root / "request.json", "attempt request"),
                "attempt request",
            )
            result = require_object(
                read_json(attempt_root / "result.json", "attempt result"),
                "attempt result",
            )
            body_path = require_file(attempt_root / "body.bin", "attempt body")
            body_sha = file_sha256(body_path)

            # bind request identity and url
            if (
                request.get("key") != identity["key"]
                or request.get("cohort") != identity["cohort"]
                or request.get("model") != identity["model"]
                or request.get("runInitializedAt") != identity["runInitializedAt"]
                or request.get("attempt") != index
                or request.get("url") != request_url(plan, identity)
                or request.get("minimumGlobalStartSpacingMs")
                != plan["minimumGlobalStartSpacingMs"]
            ):
                raise VerificationError("attempt request identity changed")

            # bind body receipt and tls route
            if (
                result.get("responseBytes") != body_path.stat().st_size
                or result.get("responseSha256") != body_sha
                or result.get("standardTlsHostnameValidation") is not True
                or result.get("resolvedAddress") != contract["resolve"]["address"]
            ):
                raise VerificationError("attempt result or body hash changed")

            attempt_outcome(result)
            starts.append(
                parse_aware_instant(request.get("startedAtUtc"), "attempt start")
            )
            attempts.append(
                {"request": request, "result": result, "bodyPath": body_path}
            )

        validate_attempt_closure(receipt, attempts, plan)
        attempts_started += len(attempts)
        status = receipt["status"]
        status_counts[status] += 1
        reason = receipt.get("gapReason") if status == "gap" else None
        by_cycle[(identity["cohort"], status, reason, identity["run"][11:13])] += 1

        # verify gap response invalidity
        if status == "gap":
            gap_counts[str(reason)] += 1

            # require truly invalid successful bodies
            if reason == "invalid_response":
                try:
                    normalized_from_response(
                        attempts[-1]["bodyPath"].read_bytes(), identity, plan
                    )
                except VerificationError:
                    pass
                else:
                    raise VerificationError(
                        "invalid-response gap contains a valid response"
                    )

            # forbid success-only paths
            if "normalizedPath" in receipt or "responsePath" in receipt:
                raise VerificationError("gap receipt contains success paths")

            continue

        response_path = contained_file(
            run_root, receipt.get("responsePath"), "successful response"
        )
        normalized_path = contained_file(
            run_root, receipt.get("normalizedPath"), "normalized run"
        )

        # bind exact generated paths
        if (
            response_path != attempts[-1]["bodyPath"].resolve()
            or normalized_path != (run_root / "normalized.jsonl").resolve()
        ):
            raise VerificationError("successful artifact path changed")

        response_bytes = response_path.read_bytes()
        normalized_bytes = normalized_path.read_bytes()

        # bind response and normalized hashes
        if (
            receipt.get("responseBytes") != len(response_bytes)
            or receipt.get("responseSha256") != sha256_bytes(response_bytes)
            or receipt.get("normalizedBytes") != len(normalized_bytes)
            or receipt.get("normalizedSha256") != sha256_bytes(normalized_bytes)
        ):
            raise VerificationError("successful artifact hash changed")

        expected_normalized, metadata = normalized_from_response(
            response_bytes, identity, plan
        )

        # bind normalization to response
        if normalized_bytes != expected_normalized:
            raise VerificationError("normalized rows differ from successful response")

        # bind generated receipt metadata
        if any(receipt.get(key) != value for key, value in metadata.items()):
            raise VerificationError("normalized receipt metadata changed")

        # aggregate exact null counts
        for variable, count in metadata["nullCountsSelectedLeads"].items():
            aggregate_nulls[identity["cohort"]][variable] += count

        normalized_parts[identity["cohort"]].append(normalized_path)

    # close outcome counters dynamically
    if (
        dict(status_counts) != manifest.get("statusCounts")
        or dict(gap_counts) != manifest.get("gapCounts")
        or sum(status_counts.values()) != FROZEN_REQUESTED_RUNS
        or set(status_counts) - {"success", "gap"}
    ):
        raise VerificationError("manifest outcome counts do not close")

    # close attempt counters dynamically
    if (
        attempts_started != manifest.get("attemptsStarted")
        or attempts_started > plan["maximumAttempts"]
    ):
        raise VerificationError("manifest attempt count does not close")

    expected_nulls = {
        cohort: dict(counts) for cohort, counts in aggregate_nulls.items()
    }

    # close null counters dynamically
    if manifest.get("nullCountsSelectedLeads") != expected_nulls:
        raise VerificationError("manifest null counts do not close")

    cohort_files = require_object(manifest.get("cohortFiles"), "cohort files")

    # bind exact cohort members
    if set(cohort_files) != set(COHORT_MODELS):
        raise VerificationError("cohort member set changed")

    verified_cohorts = {}

    # verify every aggregated member
    for cohort, parts in normalized_parts.items():
        info = require_object(cohort_files.get(cohort), f"{cohort} member")
        expected_relative = f"normalized/{cohort}.jsonl"

        # bind exact member path
        if info.get("path") != expected_relative:
            raise VerificationError("cohort member path changed")

        member_path = contained_file(acquisition, info["path"], "cohort member")
        digest = hashlib.sha256()
        expected_bytes = 0
        expected_rows = 0

        with member_path.open("rb") as member:
            # bind concatenation order and bytes
            for part_path in parts:
                part = part_path.read_bytes()
                actual = member.read(len(part))

                # reject reordered or changed content
                if actual != part:
                    raise VerificationError("cohort member concatenation changed")

                digest.update(part)
                expected_bytes += len(part)
                expected_rows += len(part.splitlines())

            # reject trailing member bytes
            if member.read(1):
                raise VerificationError("cohort member has trailing content")

        # close member receipt
        if (
            info.get("bytes") != expected_bytes
            or info.get("rows") != expected_rows
            or info.get("successfulRuns") != len(parts)
            or info.get("sha256") != digest.hexdigest()
            or file_sha256(member_path) != digest.hexdigest()
        ):
            raise VerificationError("cohort member receipt does not close")

        verified_cohorts[cohort] = {
            **info,
            "absolutePath": str(member_path),
            "hashVerified": True,
            "rowCountVerified": True,
        }

    starts.sort()
    # compare adjacent request starts without duplicating the timestamp list
    spacings = [
        (right - left).total_seconds() for left, right in itertools.pairwise(starts)
    ]
    minimum_spacing = min(spacings) if spacings else None
    hourly_maximum = maximum_rolling(starts, dt.timedelta(hours=1))
    daily_maximum = maximum_rolling(starts, dt.timedelta(days=1))

    # enforce global cadence
    if (
        minimum_spacing is not None
        and minimum_spacing + 1e-9 < plan["minimumGlobalStartSpacingMs"] / 1000
    ):
        raise VerificationError("attempt start spacing violated")

    # enforce rolling limits
    if (
        hourly_maximum > plan["rateCaps"]["hourly"]
        or daily_maximum > plan["rateCaps"]["daily"]
    ):
        raise VerificationError("attempt rolling rate limit violated")

    progress_paths = [
        acquisition / "progress.json",
        evidence / "acquisition-progress.json",
    ]

    # verify both progress receipts
    for progress_path in progress_paths:
        progress = require_object(
            read_json(progress_path, "acquisition progress"), "acquisition progress"
        )
        expected_progress = {
            "contractVersion": CONTRACT_VERSION,
            "state": "complete",
            "requestedRuns": FROZEN_REQUESTED_RUNS,
            "finishedRuns": FROZEN_REQUESTED_RUNS,
            "successfulRuns": status_counts["success"],
            "terminalGaps": status_counts["gap"],
            "pendingRuns": 0,
            "attemptsStarted": attempts_started,
            "containsRowData": False,
        }

        # compare stable progress fields
        if any(progress.get(key) != value for key, value in expected_progress.items()):
            raise VerificationError("acquisition progress does not close")

    verified_at = dt.datetime.now(dt.timezone.utc).isoformat()
    by_cycle_rows = [
        {
            "cohort": key[0],
            "status": key[1],
            "gapReason": key[2],
            "cycleUtc": key[3],
            "runs": count,
        }
        for key, count in sorted(
            by_cycle.items(),
            key=lambda item: tuple("" if value is None else value for value in item[0]),
        )
    ]
    summary = {
        "contractVersion": CONTRACT_VERSION,
        "verifiedAtUtc": verified_at,
        "verdict": "PASS",
        "status": "complete",
        "manifestPath": str(manifest_path.resolve()),
        "manifestSha256": sha256_bytes(manifest_bytes),
        "requestedRuns": FROZEN_REQUESTED_RUNS,
        "attemptsStarted": attempts_started,
        "statusCounts": dict(status_counts),
        "gapCounts": dict(gap_counts),
        "cohortFiles": verified_cohorts,
        "nullCountsSelectedLeads": expected_nulls,
        "minimumGlobalStartSpacingSeconds": minimum_spacing,
        "maximumStartsWithinRunHour": hourly_maximum,
        "maximumStartsWithinRunDay": daily_maximum,
        "allAttemptBodiesHashVerified": True,
        "allRunReceiptsMatchManifest": True,
        "allResponsesReconstructed": True,
        "allNormalizedRowsSchemaAndLeadVerified": True,
        "allCohortFilesBoundToPerRunHashes": True,
        "actualIssueTimeKnown": False,
        "runReferenceClassification": ROW_CLASSIFICATION,
        "productionWrites": False,
        "modelFit": False,
        "containsRowData": False,
        "byCohortStatusCycle": by_cycle_rows,
    }
    verification_keys = [
        "contractVersion",
        "verifiedAtUtc",
        "verdict",
        "status",
        "manifestSha256",
        "requestedRuns",
        "attemptsStarted",
        "statusCounts",
        "gapCounts",
        "cohortFiles",
        "minimumGlobalStartSpacingSeconds",
        "maximumStartsWithinRunHour",
        "maximumStartsWithinRunDay",
        "allAttemptBodiesHashVerified",
        "allRunReceiptsMatchManifest",
        "allResponsesReconstructed",
        "allNormalizedRowsSchemaAndLeadVerified",
        "allCohortFilesBoundToPerRunHashes",
        "productionWrites",
        "modelFit",
    ]
    verification = {key: summary[key] for key in verification_keys}
    return preserve_outputs(evidence, summary, verification)


# parse two positional roots
def parse_arguments() -> argparse.Namespace:
    """Parse the private root and evidence root."""
    parser = argparse.ArgumentParser()
    parser.add_argument("private_root", type=Path)
    parser.add_argument("evidence", type=Path)
    return parser.parse_args()


# expose one closed cli boundary
def main() -> int:
    """Verify without disclosing row data or tracebacks."""
    args = parse_arguments()

    try:
        summary = verify(args.private_root, args.evidence)
    except (OSError, VerificationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(canonical_json(summary))
    return 0


# avoid reads on import
if __name__ == "__main__":
    raise SystemExit(main())
