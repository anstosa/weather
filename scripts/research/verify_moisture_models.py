#!/usr/bin/env python3
"""Independently verify retained moisture-model predictions and aggregates."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
ZONE = ZoneInfo("America/Los_Angeles")
COHORTS = (
    "ecmwf_single_run_hindcast",
    "best_match_single_run_transfer",
    "fixed_lead_anchor",
    "legacy_v4_retrieval_snapshot",
)
LEAD_BANDS = (
    ("001-012", 1, 12),
    ("013-024", 13, 24),
    ("025-048", 25, 48),
    ("049-072", 49, 72),
    ("073-120", 73, 120),
    ("121-168", 121, 168),
)
SEASONS = {
    1: "winter",
    2: "winter",
    3: "spring",
    4: "spring",
    5: "spring",
    6: "summer",
    7: "summer",
    8: "summer",
    9: "autumn",
    10: "autumn",
    11: "autumn",
    12: "winter",
}
HUMIDITY_CANDIDATES = ("raw", "medianBias", "hierarchy", "ridge")
HUMIDITY_TRANSFERS = (
    "ecmwf_to_best_match",
    "fixed_anchor_24h_to_legacy_v4",
    "fixed_anchor_48h_to_legacy_v4",
)
RAIN_CANDIDATES = ("raw", "zero", "volumeScale", "hurdle")
PRESSURE_CANDIDATES = ("raw", "stationOffset", "ridge")


class VerificationError(ValueError):
    """Represent one fail-closed verification mismatch."""


# enforce one verified invariant
def require(condition: bool, message: str) -> None:
    """Raise on one false verification condition."""
    # fail closed
    if not condition:
        raise VerificationError(message)


# hash one exact retained file
def file_sha256(path: Path) -> str:
    """Return the SHA-256 of exact on-disk bytes."""
    digest = hashlib.sha256()
    # stream large private artifacts
    with path.open("rb") as stream:
        # hash bounded blocks
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


# read plain or gzip json lines
def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], str]:
    """Load JSONL and hash its uncompressed byte stream."""
    rows: list[dict[str, Any]] = []
    digest = hashlib.sha256()
    # detect compression by content
    with path.open("rb") as probe:
        compressed = probe.read(2) == b"\x1f\x8b"
    opener = gzip.open if compressed else open
    # preserve exact plaintext line bytes
    with opener(path, "rb") as stream:
        # parse each retained record
        for line_number, line in enumerate(stream, 1):
            digest.update(line)
            # reject blank records
            require(bool(line.strip()), f"{path}:{line_number}: blank JSONL row")
            value = json.loads(line)
            require(
                isinstance(value, dict),
                f"{path}:{line_number}: JSONL row is not an object",
            )
            rows.append(value)
    return rows, digest.hexdigest()


# require one finite scalar
def number(value: Any, label: str) -> float:
    """Return one finite numeric value without accepting booleans."""
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{label} is not a finite number",
    )
    return float(value)


# parse one canonical utc instant
def instant(value: Any) -> dt.datetime:
    """Return one canonical millisecond UTC instant."""
    require(isinstance(value, str), "instant is not text")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    require(
        parsed.tzinfo == UTC and canonical == value, f"noncanonical instant: {value}"
    )
    return parsed


# format one canonical utc instant
def format_instant(value: dt.datetime) -> str:
    """Format one timezone-aware instant as millisecond UTC."""
    return (
        value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


# validate one lead
def lead_hours(row: dict[str, Any]) -> int:
    """Return one integer forecast lead from one through 168."""
    lead = number(row.get("targetLeadHours"), "targetLeadHours")
    require(lead.is_integer() and 1 <= lead <= 168, "invalid target lead")
    return int(lead)


# map a lead to its frozen band
def lead_band(row: dict[str, Any]) -> str:
    """Return one literal inclusive lead band."""
    lead = lead_hours(row)
    # select the unique band
    for name, minimum, maximum in LEAD_BANDS:
        # return a matching band
        if minimum <= lead <= maximum:
            return name
    raise AssertionError("validated lead has no band")


# derive one truthful issue boundary
def issue_boundary(row: dict[str, Any]) -> tuple[dt.datetime, str]:
    """Return the explicit retrieval or nominal fixed-anchor issue."""
    valid = instant(row.get("validAt"))
    lead = lead_hours(row)
    reference = row.get("referenceAt")
    # preserve explicit retrieval timing
    if reference is not None:
        parsed = instant(reference)
        elapsed = (valid - parsed).total_seconds() / 3600
        require(
            elapsed > 0 and math.ceil(elapsed) == lead, "reference disagrees with lead"
        )
        return parsed, "reference_at"
    return valid - dt.timedelta(hours=lead), "nominal_valid_minus_lead"


# derive one local issue month
def issue_month(row: dict[str, Any]) -> str:
    """Return the local-calendar issue month."""
    return issue_boundary(row)[0].astimezone(ZONE).strftime("%Y-%m")


# derive one local month start
def month_start(month: str) -> dt.datetime:
    """Return one canonical local-calendar month start in UTC."""
    parsed = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=ZONE)
    require(parsed.strftime("%Y-%m") == month, "noncanonical issue month")
    return parsed.astimezone(UTC)


# derive local date and season
def calendar(row: dict[str, Any]) -> tuple[str, str]:
    """Return one local date and season."""
    local = instant(row.get("validAt")).astimezone(ZONE)
    return local.date().isoformat(), SEASONS[local.month]


# compare nested aggregate material
def compare(actual: Any, expected: Any, label: str = "root") -> None:
    """Require equal nested values with strict floating tolerance."""
    # compare mappings recursively
    if isinstance(actual, dict) and isinstance(expected, dict):
        require(set(actual) == set(expected), f"{label}: keys differ")
        # compare every key
        for key in actual:
            compare(actual[key], expected[key], f"{label}.{key}")
        return
    # compare sequences recursively
    if isinstance(actual, list) and isinstance(expected, list):
        require(len(actual) == len(expected), f"{label}: list length differs")
        # compare every item
        for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
            compare(left, right, f"{label}[{index}]")
        return
    # compare numeric results closely
    if (
        isinstance(actual, (int, float))
        and not isinstance(actual, bool)
        and isinstance(expected, (int, float))
        and not isinstance(expected, bool)
    ):
        require(
            math.isclose(float(actual), float(expected), rel_tol=1e-10, abs_tol=2e-10),
            f"{label}: {actual!r} != {expected!r}",
        )
        return
    require(
        type(actual) is type(expected) and actual == expected, f"{label}: values differ"
    )


# average a nonempty population
def mean(values: list[float]) -> float:
    """Return the arithmetic mean of a nonempty list."""
    require(bool(values), "cannot average an empty population")
    return sum(values) / len(values)


# derive date-hour balance weights
def balanced_weights(rows: list[dict[str, Any]]) -> list[float]:
    """Give dates equal mass, then hours, then repeated forecasts."""
    dates: dict[str, set[str]] = collections.defaultdict(set)
    hours: collections.Counter[str] = collections.Counter()
    # count represented dates and hours
    for row in rows:
        local_date, _ = calendar(row)
        dates[local_date].add(row["validAt"])
        hours[row["validAt"]] += 1
    date_count = len(dates)
    return [
        1 / (date_count * len(dates[calendar(row)[0]]) * hours[row["validAt"]])
        for row in rows
    ]


# hash and bind all receipt artifacts
def verify_receipt(
    metric: str,
    input_paths: list[Path],
    input_rows: list[list[dict[str, Any]]],
    predictions_path: Path,
    predictions_plain_sha: str,
    prediction_count: int,
    report_path: Path,
    receipt: dict[str, Any],
) -> dict[str, str]:
    """Verify exact input, prediction, report, and source identities."""
    require(
        receipt.get("productionEligible") is False, "receipt is production eligible"
    )
    require(
        sum(map(len, input_rows)) == receipt.get("inputRows"), "input row count differs"
    )
    input_hashes = {path.name: file_sha256(path) for path in input_paths}
    # verify a multi-input receipt
    if "inputFiles" in receipt:
        declared = receipt["inputFiles"]
        require(isinstance(declared, dict), "inputFiles is not a mapping")
        require(set(declared) == set(input_hashes), "input file identities differ")
        compare(input_hashes, declared, "receipt.inputFiles")
        # bind runner before-and-after snapshots
        if "inputHashesBefore" in receipt:
            compare(
                input_hashes, receipt["inputHashesBefore"], "receipt.inputHashesBefore"
            )
        # bind runner after snapshots
        if "inputHashesAfter" in receipt:
            compare(
                input_hashes, receipt["inputHashesAfter"], "receipt.inputHashesAfter"
            )
    # verify a single-input receipt
    else:
        require(len(input_paths) == 1, "single input receipt used with multiple files")
        require(
            receipt.get("inputFile") == input_paths[0].name, "input filename differs"
        )
        require(
            receipt.get("inputSha256") == input_hashes[input_paths[0].name],
            "input hash differs",
        )
    require(
        receipt.get("predictionsSha256") == predictions_plain_sha,
        "plaintext prediction hash differs",
    )
    # verify an optional prediction count
    if "predictionRows" in receipt:
        require(
            receipt["predictionRows"] == prediction_count,
            "prediction row count differs",
        )
    prediction_raw_sha = file_sha256(predictions_path)
    # verify compressed bytes when declared
    if receipt.get("compressedPredictionsSha256") is not None:
        require(
            receipt["compressedPredictionsSha256"] == prediction_raw_sha,
            "compressed prediction hash differs",
        )
    # bind plaintext storage when no compressed hash exists
    elif "compressedPredictionsSha256" in receipt:
        require(
            prediction_raw_sha == predictions_plain_sha,
            "plaintext prediction file differs",
        )
    # verify a declared prediction filename
    if "predictionsFile" in receipt:
        require(
            receipt["predictionsFile"] == predictions_path.name,
            "prediction filename differs",
        )
    report_sha = file_sha256(report_path)
    declared_report = receipt.get("reportSha256", receipt.get("aggregateReportSha256"))
    require(declared_report == report_sha, "aggregate report hash differs")
    # bind the runner report filename
    if "reportFile" in receipt:
        require(receipt["reportFile"] == report_path.name, "report filename differs")
    source_hashes: dict[str, str] = {}
    model_source = Path(__file__).with_name(f"{metric}_research.py")
    # verify one standard model source
    if "modelSourceSha256" in receipt:
        actual = file_sha256(model_source)
        require(receipt["modelSourceSha256"] == actual, "model source hash differs")
        source_hashes[str(model_source)] = actual
    shared_source = Path(__file__).with_name("humidity_research.py")
    # verify one standard shared source
    if "sharedSourceSha256" in receipt:
        actual = file_sha256(shared_source)
        require(receipt["sharedSourceSha256"] == actual, "shared source hash differs")
        source_hashes[str(shared_source)] = actual
    mapped_sources = receipt.get("sourceHashes", receipt.get("sourceHashesBefore"))
    after_sources = receipt.get("sourceHashesAfter")
    # bind before and after maps
    if after_sources is not None:
        require(mapped_sources == after_sources, "source hashes changed during fitting")
    # verify every mapped source path
    if mapped_sources is not None:
        require(
            isinstance(mapped_sources, dict) and mapped_sources,
            "source hash map is empty",
        )
        # resolve and hash each source
        for name, expected in mapped_sources.items():
            source_path = Path(name)
            # resolve portable basename receipts
            if not source_path.exists():
                source_path = Path(__file__).with_name(source_path.name)
            require(source_path.exists(), f"source does not exist: {name}")
            actual = file_sha256(source_path)
            require(actual == expected, f"source hash differs: {name}")
            source_hashes[str(source_path)] = actual
    require(bool(source_hashes), "receipt has no verified source hashes")
    return {
        "predictionsPlainSha256": predictions_plain_sha,
        "predictionsFileSha256": prediction_raw_sha,
        "reportSha256": report_sha,
        **{f"source:{key}": value for key, value in source_hashes.items()},
    }


# index and validate all model-ready inputs
def index_inputs(rows_by_file: list[list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """Return a globally unique forecast-key input index."""
    indexed: dict[str, dict[str, Any]] = {}
    # validate every source file
    for rows in rows_by_file:
        # validate every model-ready row
        for row in rows:
            key = row.get("key")
            require(
                isinstance(key, str) and key and key not in indexed,
                "duplicate input key",
            )
            cohort = row.get("cohort")
            require(cohort in COHORTS, f"unsupported cohort: {cohort}")
            instant(row.get("validAt"))
            lead_band(row)
            issue_boundary(row)
            indexed[key] = row
    return indexed


# choose all frozen evaluation inputs
def scored_inputs(
    indexed: dict[str, dict[str, Any]], policy: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Return input rows inside the declared evaluation epoch."""
    start = policy["completeEvaluationStartLocalDate"]
    end = policy["partialEvaluationEndLocalDate"]
    return {
        key: row for key, row in indexed.items() if start <= calendar(row)[0] <= end
    }


# validate prediction identity and populations
def validate_predictions(
    metric: str,
    predictions: list[dict[str, Any]],
    inputs: dict[str, dict[str, Any]],
    expected_native: dict[str, dict[str, Any]],
    policy: dict[str, Any],
    band: str | None,
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Bind predictions to inputs and preserve native and transfer populations."""
    native: list[dict[str, Any]] = []
    transfers: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    native_keys: set[str] = set()
    transfer_keys: set[tuple[str, str]] = set()
    candidates = {
        "humidity": HUMIDITY_CANDIDATES,
        "rain": RAIN_CANDIDATES,
        "pressure": PRESSURE_CANDIDATES,
    }[metric]
    # validate every retained prediction
    for prediction in predictions:
        key = prediction.get("key")
        source = inputs.get(key)
        require(source is not None, f"prediction has no input: {key}")
        kind = prediction.get("recordKind")
        require(kind in {"native", "transfer"}, f"invalid prediction kind: {kind}")
        require(
            prediction.get("validAt") == source.get("validAt"),
            f"validAt differs: {key}",
        )
        require(
            prediction.get("referenceAt") == source.get("referenceAt"),
            f"referenceAt differs: {key}",
        )
        expected_boundary, expected_boundary_kind = issue_boundary(source)
        expected_month = expected_boundary.astimezone(ZONE).strftime("%Y-%m")
        require(
            prediction.get("issueMonth", expected_month) == expected_month,
            f"issue month differs: {key}",
        )
        # verify humidity's explicit boundary receipt
        if metric == "humidity":
            require(
                prediction.get("issueBoundary") == format_instant(expected_boundary),
                f"issue boundary differs: {key}",
            )
            require(
                prediction.get("issueBoundaryKind") == expected_boundary_kind,
                f"issue kind differs: {key}",
            )
        cutoff = format_instant(
            month_start(expected_month) - dt.timedelta(hours=policy["embargoHours"])
        )
        require(
            prediction.get("trainingCutoffUtc") == cutoff,
            f"training cutoff differs: {key}",
        )
        values = prediction.get("predictions")
        require(isinstance(values, dict), f"prediction values missing: {key}")
        expected_fields = set(candidates) | (
            {"wetProbability"} if metric == "rain" else set()
        )
        require(set(values) == expected_fields, f"prediction candidates differ: {key}")
        # validate every prediction scalar
        for name, value in values.items():
            number(value, f"{key}.{name}")
        source_band = lead_band(source)
        # enforce an optional pressure partition
        if band is not None:
            require(source_band == band, f"row lies outside pressure band: {key}")
        # validate metric labels and raw predictions
        if metric == "humidity":
            actual_field = "actualRelativeHumidityPercent"
            raw_field = "rawRelativeHumidityPercent"
        elif metric == "rain":
            actual_field = "actualPrecipitationMm"
            raw_field = "rawPrecipitationMm"
        else:
            actual_field = "actualPressureHpa"
            raw_field = "rawPressureHpa"
            require(
                prediction.get("stationKey") == source.get("stationKey"),
                f"station differs: {key}",
            )
        require(
            number(prediction.get(actual_field), actual_field)
            == number(source.get(actual_field), actual_field),
            f"actual differs: {key}",
        )
        require(
            number(values["raw"], "raw prediction")
            == number(source.get(raw_field), raw_field),
            f"raw differs: {key}",
        )
        # require the full rain input identity
        if metric == "rain":
            # compare every source field retained by rain
            for name, value in source.items():
                require(
                    prediction.get(name) == value,
                    f"rain input field differs: {key}.{name}",
                )
            require(values["zero"] == 0, f"zero baseline differs: {key}")
            require(
                0 <= values["wetProbability"] <= 1, f"wet probability is invalid: {key}"
            )
            require(
                all(values[name] >= 0 for name in RAIN_CANDIDATES),
                f"negative rain prediction: {key}",
            )
        # retain exactly one native row per input key
        if kind == "native":
            require(key not in native_keys, f"duplicate native prediction: {key}")
            require(
                prediction.get("cohort") == source.get("cohort"),
                f"native cohort differs: {key}",
            )
            require(
                prediction.get("leadBand", source_band) == source_band,
                f"native band differs: {key}",
            )
            native_keys.add(key)
            native.append(prediction)
        # retain transfers separately
        else:
            label = prediction.get("transfer")
            require(isinstance(label, str), f"transfer label missing: {key}")
            pair = (label, key)
            require(
                pair not in transfer_keys,
                f"duplicate transfer prediction: {label}/{key}",
            )
            transfer_keys.add(pair)
            transfers[label].append(prediction)
    require(native_keys == set(expected_native), "native prediction population differs")
    expected_transfers = expected_transfer_keys(metric, expected_native, policy)
    require(
        set(transfers) == {key for key, values in expected_transfers.items() if values},
        "transfer labels differ",
    )
    # compare every transfer key population
    for label, keys in expected_transfers.items():
        require(
            {row["key"] for row in transfers.get(label, [])} == keys,
            f"transfer population differs: {label}",
        )
    return native, transfers


# derive expected non-refit transfers
def expected_transfer_keys(
    metric: str,
    rows: dict[str, dict[str, Any]],
    policy: dict[str, Any],
) -> dict[str, set[str]]:
    """Return exact transfer keys without pooling target cohorts."""
    result: dict[str, set[str]] = collections.defaultdict(set)
    # rain transfers every Best Match score row
    if metric == "rain":
        result["ecmwf_to_best_match"] = {
            key
            for key, row in rows.items()
            if row["cohort"] == "best_match_single_run_transfer"
        }
        return result
    # derive bounded humidity and pressure transfers
    for key, row in rows.items():
        cohort = row["cohort"]
        lead = lead_hours(row)
        local_date, _ = calendar(row)
        # select Best Match transfer rows
        if (
            cohort == "best_match_single_run_transfer"
            and lead <= 48
            and policy["bestMatchTransferStartLocalDate"]
            <= local_date
            <= policy["bestMatchTransferEndLocalDate"]
        ):
            result["ecmwf_to_best_match"].add(key)
        # select only humidity's cross-lead transfer rows
        if metric == "humidity" and cohort == "legacy_v4_retrieval_snapshot":
            # use the fixed 24-hour source
            if lead <= 24:
                result["fixed_anchor_24h_to_legacy_v4"].add(key)
            # use the fixed 48-hour source
            elif lead <= 48:
                result["fixed_anchor_48h_to_legacy_v4"].add(key)
    # retain humidity's explicit empty transfer contracts
    if metric == "humidity":
        # add every declared transfer key
        for label in HUMIDITY_TRANSFERS:
            result.setdefault(label, set())
    return result


# map one transfer to its source cell
def transfer_source(
    metric: str, prediction: dict[str, Any], source: dict[str, Any]
) -> tuple[str, str]:
    """Return the declared source cohort and band for one transfer."""
    label = prediction["transfer"]
    target_band = lead_band(source)
    # map ECMWF to Best Match
    if label == "ecmwf_to_best_match":
        expected = ("ecmwf_single_run_hindcast", target_band)
    # map short live-v4 leads to fixed 24 hours
    elif metric == "humidity" and label == "fixed_anchor_24h_to_legacy_v4":
        expected = ("fixed_lead_anchor", "013-024")
    # map longer live-v4 leads to fixed 48 hours
    elif metric == "humidity" and label == "fixed_anchor_48h_to_legacy_v4":
        expected = ("fixed_lead_anchor", "025-048")
    else:
        raise VerificationError(f"unsupported transfer: {label}")
    # verify humidity's explicit source and target fields
    if metric == "humidity":
        require(
            prediction.get("sourceCohort") == expected[0],
            "transfer source cohort differs",
        )
        require(
            prediction.get("sourceLeadBand") == expected[1],
            "transfer source band differs",
        )
        require(
            prediction.get("targetCohort") == source["cohort"],
            "transfer target cohort differs",
        )
        require(
            prediction.get("targetLeadBand") == target_band,
            "transfer target band differs",
        )
        require(
            "cohort" not in prediction and "leadBand" not in prediction,
            "transfer contains native fields",
        )
    # verify pressure's explicit source and target fields
    if metric == "pressure":
        require(
            prediction.get("sourceCohort") == expected[0],
            "transfer source cohort differs",
        )
        require(
            prediction.get("targetCohort") == source["cohort"],
            "transfer target cohort differs",
        )
        require(prediction.get("leadBand") == target_band, "transfer band differs")
    return expected


# produce one required model-cell set
def required_model_cells(
    metric: str,
    native: list[dict[str, Any]],
    transfers: dict[str, list[dict[str, Any]]],
    inputs: dict[str, dict[str, Any]],
) -> set[tuple[str, str, str]]:
    """Return exact native and transfer source support cells."""
    cells = {
        (
            row.get("issueMonth", issue_month(inputs[row["key"]])),
            row["cohort"],
            lead_band(inputs[row["key"]]),
        )
        for row in native
    }
    # include every transfer source model
    for rows in transfers.values():
        # map each transfer independently
        for row in rows:
            source = inputs[row["key"]]
            source_cohort, source_band = transfer_source(metric, row, source)
            cells.add(
                (
                    row.get("issueMonth", issue_month(source)),
                    source_cohort,
                    source_band,
                )
            )
    return cells


# independently verify humidity supports
def verify_humidity_support(
    report: dict[str, Any],
    inputs: dict[str, dict[str, Any]],
    required_cells: set[tuple[str, str, str]],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Recompute every humidity support cell from input labels."""
    policy = report["policy"]
    result: dict[tuple[str, str, str], dict[str, Any]] = {}
    # verify every reported model
    for model in report["modelSupport"]:
        key = (model["issueMonth"], model["cohort"], model["leadBand"])
        require(key not in result, f"duplicate humidity model: {key}")
        cutoff = month_start(key[0]) - dt.timedelta(hours=policy["embargoHours"])
        selected = [
            row
            for row in inputs.values()
            if row["cohort"] == key[1]
            and lead_band(row) == key[2]
            and instant(row["validAt"]) < cutoff
        ]
        dates = {calendar(row)[0] for row in selected}
        supported = (
            len(selected) >= policy["minimumTrainingRows"]
            and len(dates) >= policy["minimumTrainingDates"]
        )
        expected = {
            "issueMonth": key[0],
            "cohort": key[1],
            "leadBand": key[2],
            "supported": supported,
            "trainingRows": len(selected),
            "trainingDates": len(dates),
            "trainingCutoffUtc": format_instant(cutoff),
        }
        compare(model, expected, f"humidity.modelSupport.{key}")
        result[key] = model
    require(set(result) == required_cells, "humidity model support cells differ")
    return result


# independently verify rain supports
def verify_rain_support(
    report: dict[str, Any],
    inputs: dict[str, dict[str, Any]],
    required_cells: set[tuple[str, str, str]],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Recompute rainfall support, wet support, and scaling states."""
    policy = report["policy"]
    result: dict[tuple[str, str, str], dict[str, Any]] = {}
    # verify every reported model
    for model in report["modelSupport"]:
        key = (model["month"], model["cohort"], model["leadBand"])
        require(key not in result, f"duplicate rain model: {key}")
        cutoff = month_start(key[0]) - dt.timedelta(hours=policy["embargoHours"])
        selected = [
            row
            for row in inputs.values()
            if row["cohort"] == key[1]
            and lead_band(row) == key[2]
            and instant(row["validAt"]) < cutoff
        ]
        dates = {calendar(row)[0] for row in selected}
        supported = (
            len(selected) >= policy["minimumTrainingRows"]
            and len(dates) >= policy["minimumTrainingDates"]
        )
        expected = {
            "month": key[0],
            "cohort": key[1],
            "leadBand": key[2],
            "supported": supported,
            "hurdleSupported": False,
            "trainingRows": len(selected),
            "trainingDates": len(dates),
            "trainingCutoffUtc": format_instant(cutoff),
        }
        # derive supported volume scaling
        if supported:
            weights = balanced_weights(selected)
            raw_total = sum(
                weight * number(row["rawPrecipitationMm"], "raw rain")
                for row, weight in zip(selected, weights, strict=True)
            )
            actual_total = sum(
                weight * number(row["actualPrecipitationMm"], "actual rain")
                for row, weight in zip(selected, weights, strict=True)
            )
            ratio = (
                1
                if raw_total <= 1e-9
                else (actual_total / raw_total) ** policy["volumeRatioPower"]
            )
            scale = min(
                policy["volumeScaleBounds"][1],
                max(policy["volumeScaleBounds"][0], ratio),
            )
            wet = [
                row
                for row in selected
                if number(row["actualPrecipitationMm"], "actual rain")
                >= policy["wetThresholdMm"]
            ]
            wet_dates = {calendar(row)[0] for row in wet}
            hurdle = (
                len(wet) >= policy["minimumWetTrainingRows"]
                and len(wet_dates) >= policy["minimumWetTrainingDates"]
            )
            expected.update(
                scale=scale,
                wetTrainingRows=len(wet),
                wetTrainingDates=len(wet_dates),
                hurdleSupported=hurdle,
            )
            # retain but do not reconstruct fitted smearing
            if hurdle:
                require("smearing" in model, f"rain smearing missing: {key}")
                number(model["smearing"], "rain smearing")
                expected["smearing"] = model["smearing"]
        compare(model, expected, f"rain.modelSupport.{key}")
        result[key] = model
    require(set(result) == required_cells, "rain model support cells differ")
    return result


# compute a stable weighted median
def weighted_median(values: list[float], weights: list[float]) -> float:
    """Return the stable lower weighted median."""
    ordered = sorted(
        enumerate(zip(values, weights, strict=True)),
        key=lambda item: (item[1][0], item[0]),
    )
    half = sum(weights) / 2
    cumulative = 0.0
    # select the first crossing
    for _, (value, weight) in ordered:
        cumulative += weight
        # return the lower crossing
        if cumulative >= half:
            return value
    raise AssertionError("nonempty weights did not cross their midpoint")


# derive pressure station-date weights
def station_date_weights(rows: list[dict[str, Any]]) -> list[float]:
    """Give each station-date equal internal mass."""
    hours_by_date: dict[tuple[str, str], set[tuple[str, str]]] = (
        collections.defaultdict(set)
    )
    events_by_hour: collections.Counter[tuple[str, str]] = collections.Counter()
    # count station-local support
    for row in rows:
        station = row["stationKey"]
        local_date, _ = calendar(row)
        hour = (station, row["validAt"])
        hours_by_date[(station, local_date)].add(hour)
        events_by_hour[hour] += 1
    return [
        1
        / (
            len(hours_by_date[(row["stationKey"], calendar(row)[0])])
            * events_by_hour[(row["stationKey"], row["validAt"])]
        )
        for row in rows
    ]


# independently verify pressure supports
def verify_pressure_support(
    report: dict[str, Any],
    inputs: dict[str, dict[str, Any]],
    required_cells: set[tuple[str, str, str]],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Recompute station support, offsets, and elevation compatibility."""
    policy = report["policy"]
    result: dict[tuple[str, str, str], dict[str, Any]] = {}
    # verify every reported model
    for model in report["modelSupport"]:
        key = (model["issueMonth"], model["cohort"], model["leadBand"])
        require(key not in result, f"duplicate pressure model: {key}")
        cutoff = month_start(key[0]) - dt.timedelta(hours=policy["embargoHours"])
        selected = sorted(
            [
                row
                for row in inputs.values()
                if row["cohort"] == key[1]
                and lead_band(row) == key[2]
                and instant(row["validAt"]) < cutoff
            ],
            key=lambda row: row["key"],
        )
        by_station: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        # isolate each target station
        for row in selected:
            by_station[row["stationKey"]].append(row)
        stations: dict[str, dict[str, Any]] = {}
        eligible: list[dict[str, Any]] = []
        # verify each station state
        for station, station_rows in sorted(by_station.items()):
            dates = {calendar(row)[0] for row in station_rows}
            supported = (
                len(station_rows) >= policy["minimumTrainingRowsPerStation"]
                and len(dates) >= policy["minimumTrainingDatesPerStation"]
            )
            offset = None
            # fit the earlier-only station offset
            if supported:
                weights = station_date_weights(station_rows)
                residuals = [
                    number(row["actualPressureHpa"], "actual pressure")
                    - number(row["rawPressureHpa"], "raw pressure")
                    for row in station_rows
                ]
                offset = weighted_median(residuals, weights)
                eligible.extend(station_rows)
            stations[station] = {
                "supported": supported,
                "trainingRows": len(station_rows),
                "trainingDates": len(dates),
                "offsetHpa": offset,
            }
        elevations = [row.get("forecastElevationM") for row in eligible]
        elevation = None
        # require complete stable elevation evidence
        if elevations and all(value is not None for value in elevations):
            parsed = [number(value, "forecast elevation") for value in elevations]
            # average compatible elevations
            if max(parsed) - min(parsed) <= policy["elevationCompatibilityToleranceM"]:
                elevation = mean(parsed)
        expected = {
            "issueMonth": key[0],
            "cohort": key[1],
            "leadBand": key[2],
            "trainingCutoffUtc": format_instant(cutoff),
            "eligibleTrainingRows": len(eligible),
            "eligibleTrainingStations": sum(
                value["supported"] for value in stations.values()
            ),
            "forecastElevationM": elevation,
            "stations": stations,
        }
        compare(model, expected, f"pressure.modelSupport.{key}")
        result[key] = model
    require(set(result) == required_cells, "pressure model support cells differ")
    return result


# validate support flags and cold fallbacks
def verify_prediction_support(
    metric: str,
    predictions: list[dict[str, Any]],
    inputs: dict[str, dict[str, Any]],
    support: dict[tuple[str, str, str], dict[str, Any]],
    report: dict[str, Any],
) -> None:
    """Bind row support flags and require conservative raw fallbacks."""
    # verify every prediction against its source state
    for prediction in predictions:
        source = inputs[prediction["key"]]
        kind = prediction["recordKind"]
        # select native support
        if kind == "native":
            source_cohort = source["cohort"]
            source_band = lead_band(source)
        # select transfer support
        else:
            source_cohort, source_band = transfer_source(metric, prediction, source)
        model = support[
            (
                prediction.get("issueMonth", issue_month(source)),
                source_cohort,
                source_band,
            )
        ]
        values = prediction["predictions"]
        raw = values["raw"]
        # validate humidity support and fallback
        if metric == "humidity":
            expected = bool(model["supported"])
            require(
                prediction.get("modelSupported") is expected,
                "humidity support flag differs",
            )
            # preserve unsupported rows as raw
            if not expected:
                require(
                    all(values[name] == raw for name in HUMIDITY_CANDIDATES),
                    "humidity cold fallback differs",
                )
            require(
                all(0 <= values[name] <= 100 for name in HUMIDITY_CANDIDATES),
                "humidity prediction is unphysical",
            )
        # validate rain support and fallback
        elif metric == "rain":
            require(
                prediction.get("modelSupported") is bool(model["supported"]),
                "rain volume support differs",
            )
            require(
                prediction.get("hurdleSupported") is bool(model["hurdleSupported"]),
                "rain hurdle support differs",
            )
            # preserve unsupported volume rows
            if not model["supported"]:
                require(
                    values["volumeScale"] == raw, "rain volume cold fallback differs"
                )
            # preserve unsupported hurdle rows
            if not model["hurdleSupported"]:
                require(values["hurdle"] == raw, "rain hurdle cold fallback differs")
                require(
                    values["wetProbability"]
                    == float(raw >= report["policy"]["wetThresholdMm"]),
                    "rain occurrence cold fallback differs",
                )
        # validate pressure station and elevation support
        else:
            station = model["stations"].get(source["stationKey"])
            station_supported = bool(station and station["supported"])
            compatible = True
            # bind native station support
            if kind == "native":
                require(
                    prediction.get("stationSupported") is station_supported,
                    "pressure station support differs",
                )
            # bind transfer support and elevation gate
            else:
                model_elevation = model.get("forecastElevationM")
                target_elevation = source.get("forecastElevationM")
                compatible = (
                    model_elevation is not None
                    and target_elevation is not None
                    and abs(
                        number(model_elevation, "model elevation")
                        - number(target_elevation, "target elevation")
                    )
                    <= report["policy"]["elevationCompatibilityToleranceM"]
                )
                require(
                    prediction.get("sourceStationSupported") is station_supported,
                    "pressure source support differs",
                )
                require(
                    prediction.get("elevationCompatible") is compatible,
                    "pressure elevation flag differs",
                )
            # preserve unsupported or incompatible rows
            if not station_supported or not compatible:
                require(
                    all(values[name] == raw for name in PRESSURE_CANDIDATES),
                    "pressure cold fallback differs",
                )
            # reconstruct the supported station baseline and residual cap
            else:
                offset = number(station["offsetHpa"], "station offset")
                require(
                    math.isclose(values["stationOffset"], raw + offset, abs_tol=1e-10),
                    "pressure offset prediction differs",
                )
                require(
                    abs(values["ridge"] - values["stationOffset"])
                    <= report["policy"]["maximumResidualCorrectionHpa"] + 1e-10,
                    "pressure residual cap differs",
                )


# score humidity at date and hour balance
def score_humidity(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Recompute humidity metrics without model scoring code."""
    # preserve empty populations
    if not rows:
        return None
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = collections.defaultdict(
        lambda: collections.defaultdict(list)
    )
    actual_by_hour: dict[str, float] = {}
    seen: set[str] = set()
    # group unique predictions by local date and valid hour
    for row in rows:
        key = row["key"]
        require(key not in seen, "duplicate humidity score key")
        seen.add(key)
        actual = number(row["actualRelativeHumidityPercent"], "actual humidity")
        valid = row["validAt"]
        require(
            valid not in actual_by_hour or actual_by_hour[valid] == actual,
            "humidity actual conflicts within hour",
        )
        actual_by_hour[valid] = actual
        grouped[calendar(row)[0]][valid].append(row)
    result = {
        "events": len(rows),
        "dates": len(grouped),
        "validHours": sum(len(hours) for hours in grouped.values()),
        "predictions": {},
    }
    # score every candidate identically
    for candidate in HUMIDITY_CANDIDATES:
        daily_absolute: list[float] = []
        daily_bias: list[float] = []
        daily_large: list[float] = []
        hourly_absolute: list[float] = []
        hourly_bias: list[float] = []
        # average every date
        for hours in grouped.values():
            date_absolute: list[float] = []
            date_bias: list[float] = []
            date_large: list[float] = []
            # average repeated forecasts within hours
            for events in hours.values():
                errors = [
                    number(row["predictions"][candidate], candidate)
                    - number(row["actualRelativeHumidityPercent"], "actual humidity")
                    for row in events
                ]
                absolute = mean([abs(error) for error in errors])
                bias = mean(errors)
                date_absolute.append(absolute)
                date_bias.append(bias)
                date_large.append(mean([float(abs(error) > 10) for error in errors]))
                hourly_absolute.append(absolute)
                hourly_bias.append(bias)
            daily_absolute.append(mean(date_absolute))
            daily_bias.append(mean(date_bias))
            daily_large.append(mean(date_large))
        result["predictions"][candidate] = {
            "equalDateMaePercentagePoints": mean(daily_absolute),
            "equalDateBiasPercentagePoints": mean(daily_bias),
            "equalHourMaePercentagePoints": mean(hourly_absolute),
            "equalHourBiasPercentagePoints": mean(hourly_bias),
            "equalDateFractionAbove10PercentagePoints": mean(daily_large),
        }
    return result


# group humidity score populations
def humidity_groups(
    rows: list[dict[str, Any]], transfer: bool = False
) -> dict[str, Any]:
    """Recompute every reported humidity group."""
    dimensions: dict[str, dict[str, list[dict[str, Any]]]] = {
        name: collections.defaultdict(list)
        for name in (
            "cohort",
            "cohortLeadBand",
            "cohortMonth",
            "cohortSeason",
            "month",
            "season",
            "leadBand",
            "localDate",
        )
    }
    # attach each row to every dimension
    for row in rows:
        local_date, season = calendar(row)
        cohort = row["targetCohort"] if transfer else row["cohort"]
        band = row["targetLeadBand"] if transfer else row["leadBand"]
        values = {
            "cohort": cohort,
            "cohortLeadBand": f"{cohort}:{band}",
            "cohortMonth": f"{cohort}:{local_date[:7]}",
            "cohortSeason": f"{cohort}:{season}",
            "month": local_date[:7],
            "season": season,
            "leadBand": band,
            "localDate": local_date,
        }
        # append every group membership
        for dimension, key in values.items():
            dimensions[dimension][key].append(row)
    return {
        dimension: {key: score_humidity(grouped[key]) for key in sorted(grouped)}
        for dimension, grouped in dimensions.items()
    }


# verify every humidity aggregate
def verify_humidity_scores(
    report: dict[str, Any],
    native: list[dict[str, Any]],
    transfers: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Recompute all native and transfer humidity report cells."""
    policy = report["policy"]
    complete_end = policy["completeEvaluationEndLocalDate"]
    partial_start = policy["partialEvaluationStartLocalDate"]
    populations = {
        "completeMonths": [row for row in native if calendar(row)[0] <= complete_end],
        "partialSeptember": [
            row for row in native if calendar(row)[0] >= partial_start
        ],
    }
    counts: dict[str, Any] = {}
    # verify both native epochs
    for name, rows in populations.items():
        grouped: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        # preserve cohort denominators
        for row in rows:
            grouped[row["cohort"]].append(row)
        expected = {key: score_humidity(grouped[key]) for key in sorted(grouped)}
        compare(expected, report[name]["byCohort"], f"humidity.{name}.byCohort")
        compare(
            humidity_groups(rows), report[name]["groups"], f"humidity.{name}.groups"
        )
        counts[name] = {key: len(value) for key, value in sorted(grouped.items())}
    require(
        set(report["transfers"]) == set(HUMIDITY_TRANSFERS),
        "humidity report transfer labels differ",
    )
    # verify every transfer separately
    for label in HUMIDITY_TRANSFERS:
        rows = transfers.get(label, [])
        epochs = {
            "completeMonths": [row for row in rows if calendar(row)[0] <= complete_end],
            "partialSeptember": [
                row for row in rows if calendar(row)[0] >= partial_start
            ],
        }
        # verify both transfer epochs
        for name, selected in epochs.items():
            compare(
                score_humidity(selected),
                report["transfers"][label][name]["overall"],
                f"humidity.transfers.{label}.{name}.overall",
            )
            compare(
                humidity_groups(selected, transfer=True),
                report["transfers"][label][name]["groups"],
                f"humidity.transfers.{label}.{name}.groups",
            )
        counts[f"transfer:{label}"] = len(rows)
    return counts


# average values by hour and date
def rain_balanced_mean(rows: list[dict[str, Any]], values: list[float]) -> float | None:
    """Return a rain mean balanced across valid hours and dates."""
    # preserve empty paired populations
    if not rows:
        return None
    by_hour: dict[str, list[float]] = collections.defaultdict(list)
    # average repeated forecasts in each hour
    for row, value in zip(rows, values, strict=True):
        by_hour[row["validAt"]].append(float(value))
    by_date: dict[str, list[float]] = collections.defaultdict(list)
    # give each hour one date contribution
    for valid_at, items in by_hour.items():
        by_date[instant(valid_at).astimezone(ZONE).date().isoformat()].append(
            mean(items)
        )
    return mean([mean(items) for items in by_date.values()])


# score rainfall amounts and occurrence
def score_rain(
    rows: list[dict[str, Any]],
    policy: dict[str, Any],
    actual_field: str = "actualPrecipitationMm",
) -> dict[str, Any]:
    """Recompute every paired hourly rainfall metric."""
    # preserve explicit empty populations
    if not rows:
        return {"rows": 0, "dates": 0, "candidates": {}}
    weights = balanced_weights(rows)
    actual = [number(row[actual_field], actual_field) for row in rows]
    wet = [value >= policy["wetThresholdMm"] for value in actual]
    result: dict[str, Any] = {
        "rows": len(rows),
        "hours": len({row["validAt"] for row in rows}),
        "dates": len({calendar(row)[0] for row in rows}),
        "wetRows": sum(wet),
        "wetDates": len(
            {
                calendar(row)[0]
                for row, selected in zip(rows, wet, strict=True)
                if selected
            }
        ),
        "candidates": {},
        "volumeSupportedRows": sum(bool(row.get("modelSupported")) for row in rows),
        "hurdleSupportedRows": sum(bool(row.get("hurdleSupported")) for row in rows),
        "hurdleSupportedDates": len(
            {calendar(row)[0] for row in rows if row.get("hurdleSupported")}
        ),
    }
    # score every candidate on one denominator
    for candidate in RAIN_CANDIDATES:
        predictions = [number(row["predictions"][candidate], candidate) for row in rows]
        errors = [
            prediction - observed
            for prediction, observed in zip(predictions, actual, strict=True)
        ]
        observed_volume = sum(
            weight * value for weight, value in zip(weights, actual, strict=True)
        )
        predicted_volume = sum(
            weight * value for weight, value in zip(weights, predictions, strict=True)
        )
        wet_rows = [row for row, selected in zip(rows, wet, strict=True) if selected]
        wet_errors = [
            abs(error) for error, selected in zip(errors, wet, strict=True) if selected
        ]
        metrics: dict[str, Any] = {
            "maeMm": sum(
                weight * abs(error)
                for weight, error in zip(weights, errors, strict=True)
            ),
            "rmseMm": math.sqrt(
                sum(
                    weight * error * error
                    for weight, error in zip(weights, errors, strict=True)
                )
            ),
            "biasMm": sum(
                weight * error for weight, error in zip(weights, errors, strict=True)
            ),
            "volumeRatio": None
            if observed_volume == 0
            else predicted_volume / observed_volume,
            "observedWetMaeMm": rain_balanced_mean(wet_rows, wet_errors),
            "thresholds": {},
        }
        # score all declared thresholds
        for threshold in [policy["wetThresholdMm"], *policy["heavyThresholdsMm"]]:
            events = [value >= threshold for value in actual]
            forecasts = [value >= threshold for value in predictions]
            hit = sum(
                weight
                for weight, event, forecast in zip(
                    weights, events, forecasts, strict=True
                )
                if event and forecast
            )
            miss = sum(
                weight
                for weight, event, forecast in zip(
                    weights, events, forecasts, strict=True
                )
                if event and not forecast
            )
            false_alarm = sum(
                weight
                for weight, event, forecast in zip(
                    weights, events, forecasts, strict=True
                )
                if not event and forecast
            )
            random_hit = (hit + miss) * (hit + false_alarm)
            denominator = hit + miss + false_alarm - random_hit
            metrics["thresholds"][str(threshold)] = {
                "POD": None if hit + miss == 0 else hit / (hit + miss),
                "FAR": None
                if hit + false_alarm == 0
                else false_alarm / (hit + false_alarm),
                "ETS": None if denominator == 0 else (hit - random_hit) / denominator,
                "frequencyBias": None
                if hit + miss == 0
                else (hit + false_alarm) / (hit + miss),
                "eventRows": sum(events),
            }
        probabilities = [
            row["predictions"]["wetProbability"]
            if candidate == "hurdle"
            else float(prediction >= policy["wetThresholdMm"])
            for row, prediction in zip(rows, predictions, strict=True)
        ]
        squares = [
            (probability - float(observed)) ** 2
            for probability, observed in zip(probabilities, wet, strict=True)
        ]
        supported = [bool(row.get("hurdleSupported")) for row in rows]
        metrics["wetBrier"] = sum(
            weight * value for weight, value in zip(weights, squares, strict=True)
        )
        metrics["brierReference"] = (
            "fitted_occurrence_probability_with_raw_indicator_cold_fallback"
            if candidate == "hurdle"
            else "deterministic_amount_event_indicator_not_provider_pop"
        )
        metrics["hurdleSupportedPairedWetBrier"] = rain_balanced_mean(
            [row for row, selected in zip(rows, supported, strict=True) if selected],
            [
                value
                for value, selected in zip(squares, supported, strict=True)
                if selected
            ],
        )
        result["candidates"][candidate] = metrics
    return result


# score contiguous same-run accumulations
def rain_accumulations(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Recompute genuine three through twenty-four-hour rain totals."""
    runs: dict[tuple[str, str], dict[dt.datetime, dict[str, Any]]] = (
        collections.defaultdict(dict)
    )
    # index only explicit model runs
    for row in rows:
        # exclude nominal fixed anchors
        if row.get("referenceAt") is not None:
            runs[(row["cohort"], row["referenceAt"])][instant(row["validAt"])] = row
    groups: dict[int, list[dict[str, Any]]] = {hours: [] for hours in (3, 6, 12, 24)}
    # inspect each run independently
    for run in runs.values():
        # inspect each possible ending hour
        for end, row in run.items():
            # inspect each frozen accumulation length
            for hours, windows in groups.items():
                pieces = [
                    run.get(end - dt.timedelta(hours=offset)) for offset in range(hours)
                ]
                # require complete contiguous coverage
                if any(piece is None for piece in pieces):
                    continue
                present = [piece for piece in pieces if piece is not None]
                total = dict(row)
                total["actualPrecipitationMm"] = sum(
                    piece["actualPrecipitationMm"] for piece in present
                )
                total["predictions"] = {
                    candidate: sum(piece["predictions"][candidate] for piece in present)
                    for candidate in RAIN_CANDIDATES
                }
                windows.append(total)
    result: dict[str, Any] = {}
    # score each accumulation population
    for hours, selected in groups.items():
        metrics: dict[str, Any] = {
            "rows": len(selected),
            "dates": len({calendar(row)[0] for row in selected}),
            "candidates": {},
        }
        # score only represented windows
        if selected:
            weights = balanced_weights(selected)
            actual = [row["actualPrecipitationMm"] for row in selected]
            # score every candidate amount
            for candidate in RAIN_CANDIDATES:
                values = [row["predictions"][candidate] for row in selected]
                observed = sum(
                    weight * value
                    for weight, value in zip(weights, actual, strict=True)
                )
                predicted = sum(
                    weight * value
                    for weight, value in zip(weights, values, strict=True)
                )
                metrics["candidates"][candidate] = {
                    "maeMm": sum(
                        weight * abs(value - target)
                        for weight, value, target in zip(
                            weights, values, actual, strict=True
                        )
                    ),
                    "biasMm": sum(
                        weight * (value - target)
                        for weight, value, target in zip(
                            weights, values, actual, strict=True
                        )
                    ),
                    "volumeRatio": None if observed == 0 else predicted / observed,
                }
        result[str(hours)] = metrics
    return result


# summarize distinct rainfall cohorts
def summarize_rain(
    rows: list[dict[str, Any]], policy: dict[str, Any]
) -> dict[str, Any]:
    """Recompute every cohort, group, sensitivity, and accumulation."""
    result: dict[str, Any] = {}
    # preserve all declared cohorts including empty cells
    for cohort in COHORTS:
        selected = [row for row in rows if row["cohort"] == cohort]
        summary: dict[str, Any] = {
            "overall": score_rain(selected, policy),
            "byLeadBand": {},
            "byMonth": {},
            "bySeason": {},
            "accumulations": rain_accumulations(selected),
        }
        # construct every reported group dimension
        for name, key_function in (
            ("byLeadBand", lead_band),
            ("byMonth", lambda row: calendar(row)[0][:7]),
            ("bySeason", lambda row: calendar(row)[1]),
        ):
            grouped: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
            # attach every selected row
            for row in selected:
                grouped[key_function(row)].append(row)
            summary[name] = {
                key: score_rain(value, policy) for key, value in sorted(grouped.items())
            }
        shifted = [
            row for row in selected if row.get("shiftMinus5MinutesMm") is not None
        ]
        network_mean = [
            row for row in selected if row.get("gaugeMeanPrecipitationMm") is not None
        ]
        summary["alignmentSensitivity"] = {
            "unchangedPrimaryPredictions": True,
            "pairedPrimary": score_rain(shifted, policy),
            "shiftMinus5Minutes": score_rain(shifted, policy, "shiftMinus5MinutesMm"),
        }
        summary["networkMeanSensitivity"] = {
            "unchangedPrimaryPredictions": True,
            "pairedPrimary": score_rain(network_mean, policy),
            "weightedMeanTarget": score_rain(
                network_mean, policy, "gaugeMeanPrecipitationMm"
            ),
        }
        result[cohort] = summary
    return result


# verify every rain aggregate
def verify_rain_scores(
    report: dict[str, Any],
    native: list[dict[str, Any]],
    transfers: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Recompute all native and transfer rainfall report sections."""
    policy = report["policy"]
    complete_end = policy["completeEvaluationEndLocalDate"]
    complete = [row for row in native if calendar(row)[0] <= complete_end]
    partial = [row for row in native if calendar(row)[0] > complete_end]
    transfer_rows = transfers.get("ecmwf_to_best_match", [])
    transfer_complete = [
        row for row in transfer_rows if calendar(row)[0] <= complete_end
    ]
    transfer_partial = [row for row in transfer_rows if calendar(row)[0] > complete_end]
    expected = {
        "completeMonths": summarize_rain(complete, policy),
        "partialSeptember": summarize_rain(partial, policy),
        "transferCompleteMonths": summarize_rain(transfer_complete, policy),
        "transferPartialSeptember": summarize_rain(transfer_partial, policy),
    }
    # compare every complete report section
    for name, value in expected.items():
        compare(value, report[name], f"rain.{name}")
    return {
        "completeMonths": len(complete),
        "partialSeptember": len(partial),
        "transfer:ecmwf_to_best_match": len(transfer_rows),
    }


# score pressure levels
def score_pressure(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Recompute equal-station, date, and hour pressure scores."""
    # preserve empty transfer populations
    if not rows:
        return None
    grouped: dict[str, dict[str, dict[str, list[dict[str, Any]]]]] = (
        collections.defaultdict(
            lambda: collections.defaultdict(lambda: collections.defaultdict(list))
        )
    )
    seen: set[str] = set()
    actual_by_hour: dict[tuple[str, str], float] = {}
    # group each unique station forecast
    for row in rows:
        key = row["key"]
        require(key not in seen, "duplicate pressure score key")
        seen.add(key)
        station_hour = (row["stationKey"], row["validAt"])
        actual = number(row["actualPressureHpa"], "actual pressure")
        require(
            station_hour not in actual_by_hour
            or actual_by_hour[station_hour] == actual,
            "pressure actual conflicts within station hour",
        )
        actual_by_hour[station_hour] = actual
        grouped[row["stationKey"]][calendar(row)[0]][row["validAt"]].append(row)
    result: dict[str, Any] = {
        "events": len(rows),
        "stations": len(grouped),
        "dates": sum(len(dates) for dates in grouped.values()),
        "validHours": sum(
            len(hours) for dates in grouped.values() for hours in dates.values()
        ),
        "predictions": {},
    }
    # score every pressure candidate
    for candidate in PRESSURE_CANDIDATES:
        station_mae: list[float] = []
        station_bias: list[float] = []
        station_mse: list[float] = []
        # average each station
        for dates in grouped.values():
            date_mae: list[float] = []
            date_bias: list[float] = []
            date_mse: list[float] = []
            # average each station-date
            for hours in dates.values():
                hour_mae: list[float] = []
                hour_bias: list[float] = []
                hour_mse: list[float] = []
                # average repeated forecasts by hour
                for events in hours.values():
                    errors = [
                        row["predictions"][candidate] - row["actualPressureHpa"]
                        for row in events
                    ]
                    hour_mae.append(mean([abs(error) for error in errors]))
                    hour_bias.append(mean(errors))
                    hour_mse.append(mean([error * error for error in errors]))
                date_mae.append(mean(hour_mae))
                date_bias.append(mean(hour_bias))
                date_mse.append(mean(hour_mse))
            station_mae.append(mean(date_mae))
            station_bias.append(mean(date_bias))
            station_mse.append(mean(date_mse))
        result["predictions"][candidate] = {
            "equalStationDateMaeHpa": mean(station_mae),
            "equalStationDateBiasHpa": mean(station_bias),
            "equalStationDateRmseHpa": math.sqrt(mean(station_mse)),
        }
    baseline = result["predictions"]["stationOffset"]["equalStationDateMaeHpa"]
    # attach offset-relative deltas
    for metrics in result["predictions"].values():
        metrics["deltaMaeVsStationOffsetHpa"] = (
            metrics["equalStationDateMaeHpa"] - baseline
        )
    return result


# group pressure level populations
def pressure_groups(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Recompute all pressure level dimensions."""
    dimensions: dict[str, dict[str, list[dict[str, Any]]]] = {
        name: collections.defaultdict(list)
        for name in (
            "cohort",
            "cohortLeadBand",
            "cohortMonth",
            "cohortSeason",
            "month",
            "season",
            "leadBand",
            "station",
        )
    }
    # attach each row to every dimension
    for row in rows:
        local_date, season = calendar(row)
        cohort = row.get("cohort", row.get("targetCohort"))
        band = row["leadBand"]
        values = {
            "cohort": cohort,
            "cohortLeadBand": f"{cohort}:{band}",
            "cohortMonth": f"{cohort}:{local_date[:7]}",
            "cohortSeason": f"{cohort}:{season}",
            "month": local_date[:7],
            "season": season,
            "leadBand": band,
            "station": row["stationKey"],
        }
        # append every group membership
        for dimension, key in values.items():
            dimensions[dimension][key].append(row)
    return {
        dimension: {key: score_pressure(grouped[key]) for key in sorted(grouped)}
        for dimension, grouped in dimensions.items()
    }


# classify a signed pressure change
def sign(value: float) -> int:
    """Return minus one, zero, or plus one."""
    # classify falling pressure
    if value < 0:
        return -1
    # classify rising pressure
    if value > 0:
        return 1
    return 0


# score pressure change pairs
def pressure_change_metrics(
    pairs: list[tuple[str, str, str, dict[str, Any], dict[str, Any], float]],
    candidate: str,
) -> dict[str, float] | None:
    """Recompute balanced same-run change metrics."""
    # preserve empty pairs
    if not pairs:
        return None
    grouped: dict[str, dict[str, dict[str, list[tuple[float, float]]]]] = (
        collections.defaultdict(
            lambda: collections.defaultdict(lambda: collections.defaultdict(list))
        )
    )
    # group changes by station, date, and hour
    for station, local_date, valid_at, earlier, current, actual in pairs:
        predicted = (
            current["predictions"][candidate] - earlier["predictions"][candidate]
        )
        grouped[station][local_date][valid_at].append((predicted, actual))
    station_mae: list[float] = []
    station_bias: list[float] = []
    station_mse: list[float] = []
    station_sign: list[float] = []
    # average every station
    for dates in grouped.values():
        date_mae: list[float] = []
        date_bias: list[float] = []
        date_mse: list[float] = []
        date_sign: list[float] = []
        # average every station-date
        for hours in dates.values():
            hour_mae: list[float] = []
            hour_bias: list[float] = []
            hour_mse: list[float] = []
            hour_sign: list[float] = []
            # average every valid hour
            for events in hours.values():
                errors = [predicted - actual for predicted, actual in events]
                hour_mae.append(mean([abs(error) for error in errors]))
                hour_bias.append(mean(errors))
                hour_mse.append(mean([error * error for error in errors]))
                hour_sign.append(
                    mean(
                        [
                            float(sign(predicted) == sign(actual))
                            for predicted, actual in events
                        ]
                    )
                )
            date_mae.append(mean(hour_mae))
            date_bias.append(mean(hour_bias))
            date_mse.append(mean(hour_mse))
            date_sign.append(mean(hour_sign))
        station_mae.append(mean(date_mae))
        station_bias.append(mean(date_bias))
        station_mse.append(mean(date_mse))
        station_sign.append(mean(date_sign))
    return {
        "maeHpa": mean(station_mae),
        "biasHpa": mean(station_bias),
        "rmseHpa": math.sqrt(mean(station_mse)),
        "signAccuracy": mean(station_sign),
    }


# score pressure changes at frozen horizons
def score_pressure_changes(
    rows: list[dict[str, Any]],
    inputs: dict[str, dict[str, Any]],
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Recompute same-run three and six-hour pressure changes."""
    indexed: dict[tuple[str, str, str, dt.datetime], dict[str, Any]] = {}
    # index explicit same-run records
    for row in rows:
        source = inputs[row["key"]]
        reference = source.get("referenceAt")
        # exclude nominal fixed anchors
        if reference is None:
            continue
        key = (
            source["cohort"],
            source["stationKey"],
            reference,
            instant(source["validAt"]),
        )
        require(key not in indexed, "duplicate same-run pressure row")
        indexed[key] = row
    result: dict[str, Any] = {}
    # score both frozen horizons
    for horizon in (3, 6):
        pairs: list[tuple[str, str, str, dict[str, Any], dict[str, Any], float]] = []
        # pair exact earlier hours
        for key, current in sorted(indexed.items()):
            cohort, station, reference, valid = key
            earlier = indexed.get(
                (cohort, station, reference, valid - dt.timedelta(hours=horizon))
            )
            # skip missing exact pairs
            if earlier is None:
                continue
            actual = current["actualPressureHpa"] - earlier["actualPressureHpa"]
            # validate supplied three-hour tendencies
            if horizon == 3:
                source = inputs[current["key"]]
                earlier_source = inputs[earlier["key"]]
                supplied_forecast = source.get("forecastPressureChange3h")
                supplied_actual = source.get("actualPressureChange3h")
                # bind a supplied forecast tendency
                if supplied_forecast is not None:
                    require(
                        math.isclose(
                            number(supplied_forecast, "forecast tendency"),
                            source["rawPressureHpa"] - earlier_source["rawPressureHpa"],
                            abs_tol=1e-6,
                        ),
                        "forecast tendency conflicts with levels",
                    )
                # bind a supplied actual tendency
                if supplied_actual is not None:
                    require(
                        math.isclose(
                            number(supplied_actual, "actual tendency"),
                            actual,
                            abs_tol=1e-6,
                        ),
                        "actual tendency conflicts with levels",
                    )
            pairs.append(
                (
                    station,
                    calendar(current)[0],
                    current["validAt"],
                    earlier,
                    current,
                    actual,
                )
            )
        rapid = [
            pair for pair in pairs if abs(pair[5]) >= policy["rapidChangeThresholdHpa"]
        ]
        horizon_result: dict[str, Any] = {
            "pairs": len(pairs),
            "stations": len({pair[0] for pair in pairs}),
            "stationDates": len({(pair[0], pair[1]) for pair in pairs}),
            "validHours": len({(pair[0], pair[2]) for pair in pairs}),
            "predictions": {},
        }
        # score every candidate
        for candidate in PRESSURE_CANDIDATES:
            metrics = pressure_change_metrics(pairs, candidate)
            rapid_metrics = pressure_change_metrics(rapid, candidate)
            # preserve named null metrics
            if metrics is None:
                metrics = {
                    "maeHpa": None,
                    "biasHpa": None,
                    "rmseHpa": None,
                    "signAccuracy": None,
                }
            metrics["rapidChangePairs"] = len(rapid)
            metrics["rapidChangeMaeHpa"] = (
                None if rapid_metrics is None else rapid_metrics["maeHpa"]
            )
            metrics["rapidChangeSignAccuracy"] = (
                None if rapid_metrics is None else rapid_metrics["signAccuracy"]
            )
            horizon_result["predictions"][candidate] = metrics
        result[f"{horizon}h"] = horizon_result
    return result


# verify every pressure aggregate
def verify_pressure_scores(
    report: dict[str, Any],
    native: list[dict[str, Any]],
    transfers: dict[str, list[dict[str, Any]]],
    inputs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Recompute all pressure levels, groups, and same-run changes."""
    policy = report["policy"]
    complete_end = policy["completeEvaluationEndLocalDate"]
    partial_start = policy["partialEvaluationStartLocalDate"]
    populations = {
        "completeMonths": [row for row in native if calendar(row)[0] <= complete_end],
        "partialSeptember": [
            row for row in native if calendar(row)[0] >= partial_start
        ],
    }
    counts: dict[str, Any] = {}
    # verify both native epochs
    for name, rows in populations.items():
        grouped: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        # keep native cohorts separate
        for row in rows:
            grouped[row["cohort"]].append(row)
        compare(
            {key: score_pressure(value) for key, value in sorted(grouped.items())},
            report[name]["byCohort"],
            f"pressure.{name}.byCohort",
        )
        compare(
            pressure_groups(rows), report[name]["groups"], f"pressure.{name}.groups"
        )
        compare(
            {
                key: score_pressure_changes(value, inputs, policy)
                for key, value in sorted(grouped.items())
            },
            report[name]["sameRunChangesByCohort"],
            f"pressure.{name}.sameRunChangesByCohort",
        )
        counts[name] = {key: len(value) for key, value in sorted(grouped.items())}
    require(
        report["transfer"]["label"] == "ecmwf_to_best_match",
        "pressure transfer label differs",
    )
    transfer_rows = transfers.get("ecmwf_to_best_match", [])
    transfer_populations = {
        "completeMonths": [
            row for row in transfer_rows if calendar(row)[0] <= complete_end
        ],
        "partialSeptember": [
            row for row in transfer_rows if calendar(row)[0] >= partial_start
        ],
    }
    # verify both transfer epochs
    for name, rows in transfer_populations.items():
        compare(
            score_pressure(rows),
            report["transfer"][name]["overall"],
            f"pressure.transfer.{name}.overall",
        )
        compare(
            pressure_groups(rows),
            report["transfer"][name]["groups"],
            f"pressure.transfer.{name}.groups",
        )
        compare(
            score_pressure_changes(rows, inputs, policy),
            report["transfer"][name]["sameRunChanges"],
            f"pressure.transfer.{name}.sameRunChanges",
        )
    counts["transfer:ecmwf_to_best_match"] = len(transfer_rows)
    return counts


# run one complete independent verification
def verify_files(
    metric: str,
    input_paths: list[Path],
    predictions_path: Path,
    report_path: Path,
    receipt_path: Path,
    output_path: Path | None = None,
    band: str | None = None,
) -> dict[str, Any]:
    """Verify one moisture metric and optionally write a public receipt."""
    require(metric in {"humidity", "rain", "pressure"}, "unsupported metric")
    require(bool(input_paths), "at least one input is required")
    # limit pressure partition selection to one literal band
    if band is not None:
        require(metric == "pressure", "--band is only valid for pressure")
        require(band in {value[0] for value in LEAD_BANDS}, "invalid pressure band")
    input_rows = [load_jsonl(path)[0] for path in input_paths]
    predictions, predictions_plain_sha = load_jsonl(predictions_path)
    report = json.loads(report_path.read_text())
    receipt = json.loads(receipt_path.read_text())
    require(
        report.get("policy", {}).get("productionEligible") is False,
        "report is production eligible",
    )
    hashes = verify_receipt(
        metric,
        input_paths,
        input_rows,
        predictions_path,
        predictions_plain_sha,
        len(predictions),
        report_path,
        receipt,
    )
    indexed = index_inputs(input_rows)
    expected_native = scored_inputs(indexed, report["policy"])
    native, transfers = validate_predictions(
        metric, predictions, indexed, expected_native, report["policy"], band
    )
    cells = required_model_cells(metric, native, transfers, indexed)
    # verify metric-specific support and aggregates
    if metric == "humidity":
        support = verify_humidity_support(report, indexed, cells)
        verify_prediction_support(metric, predictions, indexed, support, report)
        populations = verify_humidity_scores(report, native, transfers)
    elif metric == "rain":
        support = verify_rain_support(report, indexed, cells)
        verify_prediction_support(metric, predictions, indexed, support, report)
        populations = verify_rain_scores(report, native, transfers)
    else:
        support = verify_pressure_support(report, indexed, cells)
        verify_prediction_support(metric, predictions, indexed, support, report)
        populations = verify_pressure_scores(report, native, transfers, indexed)
    result = {
        "contractVersion": "moisture-model-independent-verification/v1",
        "verifiedAtUtc": dt.datetime.now(UTC).isoformat(),
        "metric": metric,
        "band": band,
        "verdict": "PASS",
        "inputFiles": [
            {"name": path.name, "rows": len(rows), "sha256": file_sha256(path)}
            for path, rows in zip(input_paths, input_rows, strict=True)
        ],
        "predictions": {
            "name": predictions_path.name,
            "rows": len(predictions),
            "nativeRows": len(native),
            "transferRows": sum(map(len, transfers.values())),
            "sha256": predictions_plain_sha,
            "fileSha256": file_sha256(predictions_path),
        },
        "report": {"name": report_path.name, "sha256": file_sha256(report_path)},
        "verifiedHashes": hashes,
        "modelSupportCells": len(support),
        "populations": populations,
        "checks": {
            "exactArtifactHashes": True,
            "exactInputPredictionIdentity": True,
            "exactNativeAndTransferPopulations": True,
            "chronologyAndEmbargo": True,
            "trainingSupportAndColdFallbacks": True,
            "allReportedScoresAndGroups": True,
        },
        "productionEligible": False,
        "containsPrivateRows": False,
    }
    # write only a passing receipt
    if output_path is not None:
        output_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


# parse and run the standalone verifier
def main() -> None:
    """Run one strict moisture-verification CLI request."""
    parser = argparse.ArgumentParser()
    parser.add_argument("metric", choices=("humidity", "rain", "pressure"))
    parser.add_argument("--inputs", nargs="+", required=True, type=Path)
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--band", choices=tuple(value[0] for value in LEAD_BANDS))
    args = parser.parse_args()
    result = verify_files(
        args.metric,
        args.inputs,
        args.predictions,
        args.report,
        args.receipt,
        args.output,
        args.band,
    )
    print(
        json.dumps(
            {
                "metric": result["metric"],
                "band": result["band"],
                "verdict": result["verdict"],
                "predictionRows": result["predictions"]["rows"],
            },
            separators=(",", ":"),
        )
    )


# imports never start verification
if __name__ == "__main__":
    main()
