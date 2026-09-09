#!/usr/bin/env python3
"""independently verify retained rain-rate research artifacts and scores."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import math
import os
import sys
from collections.abc import Callable, Iterator
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
PERIODS = {
    "completeMonths": ("2025-01-01", "2026-08-31"),
    "partialSeptember": ("2026-09-01", "2026-09-06"),
}
THRESHOLDS = (0.1, 1.0, 2.5)
CANDIDATES = ("raw", "zero", "tweedieBlend", "intensityGuard")
RECORD_KINDS = ("native", "ecmwf_to_best_match")
PREDICTION_FIELDS = {
    "predictions",
    "recordKind",
    "modelSupported",
    "modelIdentity",
    "trainingCutoffUtc",
}
EXPECTED_GATES = {
    "minimumDates": 180,
    "minimumWetDates": 20,
    "overallMae": "strictly_better_than_raw",
    "rmseAndObservedWetMae": "no_worse_than_raw",
    "absoluteVolumeRatioError": "no_worse_than_raw",
    "allThresholdPodAndEts": "no_worse_than_raw",
    "allThresholdFar": "no_worse_than_raw",
    "missingMetrics": "fail_closed",
    "productionEligible": False,
    "interpretation": "development_screen_only_not_independent_qualification",
}


# represent fail-closed verification mismatches
class VerificationError(ValueError):
    """represent one fail-closed verification mismatch."""


# enforce one verified invariant
def require(condition: bool, message: str) -> None:
    """raise on one false verification condition."""
    # fail closed
    if not condition:
        raise VerificationError(message)


# hash exact on-disk bytes
def digest(path: Path) -> str:
    """return one file's SHA-256 without retaining its bytes."""
    value = hashlib.sha256()
    # stream bounded blocks
    with path.open("rb") as stream:
        # hash every block
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


# write one immutable strict json artifact
def write_json_exclusive(path: Path, value: Any) -> None:
    """create one JSON file without replacing existing evidence."""
    # create the validation artifact exclusively
    with path.open("x") as stream:
        json.dump(value, stream, allow_nan=False, sort_keys=True, separators=(",", ":"))
        stream.write("\n")


# read one strict json object
def load_object(path: Path) -> dict[str, Any]:
    """load one retained JSON object."""
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"{path.name} is not a JSON object")
    return value


# stream one gzip jsonl artifact
def jsonl_rows(path: Path, canonical: bool = False) -> Iterator[dict[str, Any]]:
    """yield nonblank JSON objects from one gzip JSONL file."""
    # read the retained gzip stream
    with gzip.open(path, "rt") as stream:
        # parse every retained record
        for line_number, line in enumerate(stream, 1):
            require(bool(line.strip()), f"{path.name}:{line_number}: blank row")
            value = json.loads(line)
            require(
                isinstance(value, dict),
                f"{path.name}:{line_number}: row is not an object",
            )
            # bind runner-owned canonical record bytes
            if canonical:
                expected = json.dumps(
                    value, allow_nan=False, separators=(",", ":")
                ) + "\n"
                require(line == expected, f"{path.name}:{line_number}: noncanonical row")
            yield value


# require one finite numeric scalar
def number(value: Any, label: str) -> float:
    """return one finite number without accepting booleans."""
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{label} is not a finite number",
    )
    return float(value)


# require one nonnegative rain amount
def rain_amount(value: Any, label: str) -> float:
    """return one physical nonnegative retained rain amount."""
    amount = number(value, label)
    require(amount >= 0, f"{label} is negative")
    return amount


# parse one canonical utc instant
def instant(value: Any) -> dt.datetime:
    """return one canonical millisecond UTC instant."""
    require(isinstance(value, str), "instant is not text")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    require(parsed.tzinfo == UTC and canonical == value, f"noncanonical instant: {value}")
    return parsed


# format one utc instant canonically
def format_instant(value: dt.datetime) -> str:
    """format one timezone-aware instant as millisecond UTC."""
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# validate one forecast lead
def lead_hours(row: dict[str, Any]) -> int:
    """return one integer lead from one through 168."""
    value = number(row.get("targetLeadHours"), "targetLeadHours")
    require(value.is_integer() and 1 <= value <= 168, "invalid target lead")
    return int(value)


# map one forecast to a literal lead band
def lead_band(row: dict[str, Any]) -> str:
    """return the unique declared band containing one lead."""
    lead = lead_hours(row)
    # inspect each frozen interval
    for name, minimum, maximum in LEAD_BANDS:
        # return the matching interval
        if minimum <= lead <= maximum:
            return name
    raise AssertionError("validated lead has no band")


# derive one truthful issue boundary
def issue_boundary(row: dict[str, Any]) -> dt.datetime:
    """return an explicit reference or nominal fixed-anchor issue."""
    valid = instant(row.get("validAt"))
    lead = lead_hours(row)
    reference = row.get("referenceAt")
    # preserve explicit source timing
    if reference is not None:
        parsed = instant(reference)
        elapsed = (valid - parsed).total_seconds() / 3600
        require(elapsed > 0 and math.ceil(elapsed) == lead, "reference disagrees with lead")
        return parsed
    return valid - dt.timedelta(hours=lead)


# derive one local issue month
def issue_month(row: dict[str, Any]) -> str:
    """return the issue boundary's local calendar month."""
    return issue_boundary(row).astimezone(ZONE).strftime("%Y-%m")


# derive one local month start
def month_start(month: str) -> dt.datetime:
    """return one local calendar month start in UTC."""
    require(isinstance(month, str), "issue month is not text")
    parsed = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=ZONE)
    require(parsed.strftime("%Y-%m") == month, "noncanonical issue month")
    return parsed.astimezone(UTC)


# derive one local date and season
def calendar(row: dict[str, Any]) -> tuple[str, str]:
    """return one forecast's local date and season."""
    local = instant(row.get("validAt")).astimezone(ZONE)
    return local.date().isoformat(), SEASONS[local.month]


# compare complete nested retained material
def compare(actual: Any, expected: Any, label: str = "root") -> None:
    """require recursive equality with strict floating tolerance."""
    # compare every mapping key and value
    if isinstance(actual, dict) and isinstance(expected, dict):
        require(set(actual) == set(expected), f"{label}: keys differ")
        # compare each retained mapping value
        for key in actual:
            compare(actual[key], expected[key], f"{label}.{key}")
        return
    # compare every sequence item
    if isinstance(actual, list) and isinstance(expected, list):
        require(len(actual) == len(expected), f"{label}: list length differs")
        # compare each retained list value
        for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
            compare(left, right, f"{label}[{index}]")
        return
    # compare numeric values closely
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
    require(type(actual) is type(expected) and actual == expected, f"{label}: values differ")


# derive equal-date equal-hour row weights
def balanced_weights(rows: list[dict[str, Any]]) -> list[float]:
    """give dates equal mass, then hours, then repeated vintages."""
    dates: dict[str, set[str]] = collections.defaultdict(set)
    hours: collections.Counter[str] = collections.Counter()
    # count every represented date and hour
    for row in rows:
        local_date, _ = calendar(row)
        dates[local_date].add(row["validAt"])
        hours[row["validAt"]] += 1
    date_count = len(dates)
    # compute every normalized row weight
    return [
        1 / (date_count * len(dates[calendar(row)[0]]) * hours[row["validAt"]])
        for row in rows
    ]


# reconstruct all point-rate and event metrics
def score(
    rows: list[dict[str, Any]],
    actual_field: str = "actualPrecipitationMm",
    candidates: tuple[str, ...] = CANDIDATES,
) -> dict[str, Any]:
    """score all frozen candidates on one identical population."""
    result: dict[str, Any] = {
        "rows": len(rows),
        "hours": len({row["validAt"] for row in rows}),
        "dates": len({calendar(row)[0] for row in rows}),
        "supportedRows": sum(bool(row["modelSupported"]) for row in rows),
        "wetDates": 0,
        "candidates": {},
    }
    has_candidate_support = any("candidateSupported" in row for row in rows)
    # keep candidate-specific support out of unchanged v1 summaries
    if has_candidate_support:
        result["supportByCandidate"] = {}
    # preserve empty populations explicitly
    if not rows:
        return result
    actual = [rain_amount(row.get(actual_field), actual_field) for row in rows]
    wet = [value >= THRESHOLDS[0] for value in actual]
    wet_rows = [row for row, selected in zip(rows, wet, strict=True) if selected]
    result["wetDates"] = len({calendar(row)[0] for row in wet_rows})
    # reconstruct support on each candidate's identical supported subset
    if has_candidate_support:
        for candidate in candidates:
            supported = [
                row
                for row in rows
                if isinstance(row.get("candidateSupported"), dict)
                and row["candidateSupported"].get(candidate) is True
            ]
            supported_wet = [
                row
                for row in supported
                if rain_amount(row.get(actual_field), actual_field) >= THRESHOLDS[0]
            ]
            result["supportByCandidate"][candidate] = {
                "rows": len(supported),
                "hours": len({row["validAt"] for row in supported}),
                "dates": len({calendar(row)[0] for row in supported}),
                "wetDates": len({calendar(row)[0] for row in supported_wet}),
            }
    weights = balanced_weights(rows)
    wet_weights = balanced_weights(wet_rows) if wet_rows else None
    observed = sum(weight * value for weight, value in zip(weights, actual, strict=True))
    # score each candidate without changing the population
    for candidate in candidates:
        predicted = [rain_amount(row["predictions"].get(candidate), candidate) for row in rows]
        errors = [value - target for value, target in zip(predicted, actual, strict=True)]
        metrics: dict[str, Any] = {
            "maeMmPerHour": sum(
                weight * abs(error) for weight, error in zip(weights, errors, strict=True)
            ),
            "rmseMmPerHour": math.sqrt(
                sum(
                    weight * error * error
                    for weight, error in zip(weights, errors, strict=True)
                )
            ),
            "biasMmPerHour": sum(
                weight * error for weight, error in zip(weights, errors, strict=True)
            ),
            "volumeRatio": None
            if observed == 0
            else sum(
                weight * value
                for weight, value in zip(weights, predicted, strict=True)
            )
            / observed,
            "observedWetMaeMmPerHour": None,
            "thresholds": {},
        }
        # compute wet-only magnitude on its own balanced population
        if wet_weights is not None:
            wet_errors = [
                abs(error)
                for error, selected in zip(errors, wet, strict=True)
                if selected
            ]
            metrics["observedWetMaeMmPerHour"] = sum(
                weight * error
                for weight, error in zip(wet_weights, wet_errors, strict=True)
            )
        # reconstruct every frozen event threshold
        for threshold in THRESHOLDS:
            events = [value >= threshold for value in actual]
            forecasts = [value >= threshold for value in predicted]
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
                "eventHours": len(
                    {
                        row["validAt"]
                        for row, selected in zip(rows, events, strict=True)
                        if selected
                    }
                ),
            }
        result["candidates"][candidate] = metrics
    return result


# reconstruct contiguous same-reference totals
def accumulations(
    rows: list[dict[str, Any]], candidates: tuple[str, ...] = CANDIDATES
) -> dict[str, Any]:
    """score genuine three through twenty-four-hour accumulations."""
    groups: dict[tuple[str, str], dict[dt.datetime, dict[str, Any]]] = (
        collections.defaultdict(dict)
    )
    # index only explicit same-run rows
    for row in rows:
        reference = row.get("referenceAt")
        # exclude nominal fixed anchors
        if reference is not None:
            at = instant(row["validAt"])
            group = groups[(row["cohort"], reference)]
            require(at not in group, "duplicate same-reference accumulation hour")
            group[at] = row
    result: dict[str, Any] = {}
    # reconstruct each frozen accumulation length
    for hours in (3, 6, 12, 24):
        totals: list[dict[str, Any]] = []
        # process every distinct model run
        for group in groups.values():
            # test every retained ending hour
            for at, row in group.items():
                pieces = [
                    group.get(at - dt.timedelta(hours=offset))
                    for offset in range(hours)
                ]
                # reject incomplete windows
                if any(piece is None for piece in pieces):
                    continue
                present = [piece for piece in pieces if piece is not None]
                totals.append(
                    {
                        "cohort": row["cohort"],
                        "validAt": row["validAt"],
                        "actualPrecipitationMm": sum(
                            piece["actualPrecipitationMm"] for piece in present
                        ),
                        "predictions": {
                            candidate: sum(
                                piece["predictions"][candidate] for piece in present
                            )
                            for candidate in candidates
                        },
                    }
                )
        summary: dict[str, Any] = {
            "rows": len(totals),
            "dates": len({calendar(row)[0] for row in totals}),
            "candidates": {},
        }
        # score only complete represented windows
        if totals:
            weights = balanced_weights(totals)
            actual = [row["actualPrecipitationMm"] for row in totals]
            observed = sum(
                weight * value for weight, value in zip(weights, actual, strict=True)
            )
            # score every candidate total
            for candidate in candidates:
                predicted = [row["predictions"][candidate] for row in totals]
                summary["candidates"][candidate] = {
                    "maeMm": sum(
                        weight * abs(value - target)
                        for weight, value, target in zip(
                            weights, predicted, actual, strict=True
                        )
                    ),
                    "biasMm": sum(
                        weight * (value - target)
                        for weight, value, target in zip(
                            weights, predicted, actual, strict=True
                        )
                    ),
                    "volumeRatio": None
                    if observed == 0
                    else sum(
                        weight * value
                        for weight, value in zip(weights, predicted, strict=True)
                    )
                    / observed,
                }
        result[str(hours)] = summary
    return result


# compare one finite development metric directionally
def no_worse(candidate: Any, baseline: Any, direction: int = 1) -> bool:
    """fail closed for missing, nonnumeric, or nonfinite gate values."""
    # reject missing or boolean values
    if (
        candidate is None
        or baseline is None
        or isinstance(candidate, bool)
        or isinstance(baseline, bool)
        or not isinstance(candidate, (int, float))
        or not isinstance(baseline, (int, float))
    ):
        return False
    # reject nonfinite values
    if not math.isfinite(candidate) or not math.isfinite(baseline):
        return False
    return direction * candidate <= direction * baseline


# reconstruct the declared retrospective screen
def screen(
    summary: dict[str, Any], candidates: tuple[str, ...] = CANDIDATES
) -> dict[str, Any]:
    """evaluate development gates without making an accuracy claim."""
    result: dict[str, Any] = {}
    # never qualify an empty population
    if not summary["candidates"]:
        return result
    raw = summary["candidates"]["raw"]
    # screen both declared challengers
    for candidate_name in candidates[2:]:
        candidate = summary["candidates"][candidate_name]
        support = summary.get("supportByCandidate", {}).get(candidate_name)
        checks = {
            "support": (
                support["dates"] >= EXPECTED_GATES["minimumDates"]
                and support["wetDates"] >= EXPECTED_GATES["minimumWetDates"]
                if support is not None
                else summary["dates"] >= EXPECTED_GATES["minimumDates"]
                and summary["wetDates"] >= EXPECTED_GATES["minimumWetDates"]
                and summary["supportedRows"] > 0
            ),
            "mae": candidate["maeMmPerHour"] < raw["maeMmPerHour"],
            "rmse": no_worse(candidate["rmseMmPerHour"], raw["rmseMmPerHour"]),
            "wetMae": no_worse(
                candidate["observedWetMaeMmPerHour"],
                raw["observedWetMaeMmPerHour"],
            ),
            "volume": no_worse(
                None
                if candidate["volumeRatio"] is None
                else abs(candidate["volumeRatio"] - 1),
                None if raw["volumeRatio"] is None else abs(raw["volumeRatio"] - 1),
            ),
        }
        # require every threshold metric
        for threshold in THRESHOLDS:
            # require each frozen direction
            for metric, direction in (("POD", -1), ("ETS", -1), ("FAR", 1)):
                checks[f"{threshold}:{metric}"] = no_worse(
                    candidate["thresholds"][str(threshold)][metric],
                    raw["thresholds"][str(threshold)][metric],
                    direction,
                )
        result[candidate_name] = {
            "passesDevelopmentScreen": all(checks.values()),
            "checks": checks,
        }
    return result


# reconstruct every cohort diagnostic
def summarize(
    rows: list[dict[str, Any]], candidates: tuple[str, ...] = CANDIDATES
) -> dict[str, Any]:
    """recompute every cohort, grouping, screen, total, and sensitivity."""
    result: dict[str, Any] = {}
    # preserve all declared cohorts including empty cells
    for cohort in COHORTS:
        selected = [row for row in rows if row["cohort"] == cohort]
        overall = score(selected, candidates=candidates)
        summary: dict[str, Any] = {
            "overall": overall,
            "developmentScreen": screen(overall, candidates),
            "accumulations": accumulations(selected, candidates),
        }
        dimensions: tuple[tuple[str, Callable[[dict[str, Any]], str]], ...] = (
            ("byLeadBand", lead_band),
            ("byMonth", lambda row: calendar(row)[0][:7]),
            ("bySeason", lambda row: calendar(row)[1]),
        )
        # rebuild each diagnostic grouping
        for field, key_function in dimensions:
            groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
            # attach each selected row once
            for row in selected:
                groups[key_function(row)].append(row)
            summary[field] = {
                key: score(group_rows, candidates=candidates)
                for key, group_rows in sorted(groups.items())
            }
        summary["leadBandDevelopmentScreens"] = {
            key: screen(value, candidates)
            for key, value in summary["byLeadBand"].items()
        }
        sensitivities = (
            ("alignmentSensitivity", "shiftMinus5MinutesMm"),
            ("networkMeanSensitivity", "gaugeMeanPrecipitationMm"),
        )
        # change only the sensitivity target
        for name, target in sensitivities:
            paired = [row for row in selected if row.get(target) is not None]
            summary[name] = {
                "unchangedPrimaryPredictions": True,
                "primary": score(paired, candidates=candidates),
                "alternative": score(paired, target, candidates),
            }
        result[cohort] = summary
    return result


# validate exact retained artifact hashes
def verify_receipt(
    directory: Path,
    receipt: dict[str, Any],
    freeze: dict[str, Any],
) -> dict[str, str]:
    """bind all declared files, snapshots, and the frozen input identity."""
    files = receipt.get("files")
    require(isinstance(files, dict), "receipt files are missing")
    source_hashes = freeze.get("sourceSha256")
    require(isinstance(source_hashes, dict), "freeze source hashes are missing")
    expected_files = {
        "input.jsonl.gz",
        "models.jsonl.gz",
        "predictions.jsonl.gz",
        "report.json",
        "freeze.json",
        *(f"sources/{name}" for name in source_hashes),
    }
    require(set(files) == expected_files, "receipt file population differs")
    actual: dict[str, str] = {}
    # bind every exact retained artifact
    for name in sorted(expected_files):
        path = directory / name
        require(path.is_file(), f"missing retained file: {name}")
        actual[name] = digest(path)
        require(actual[name] == files[name], f"retained hash differs: {name}")
    require(
        actual["input.jsonl.gz"] == freeze.get("inputSha256"),
        "retained input differs from frozen input SHA-256",
    )
    require(receipt.get("productionEligible") is False, "receipt is production eligible")
    require(freeze.get("productionEligible") is False, "freeze is production eligible")
    # bind every source basename to both manifests
    for name, expected in source_hashes.items():
        require(
            actual[f"sources/{name}"] == expected,
            f"frozen source hash differs: {name}",
        )
    return actual


# validate and index the frozen original inputs
def load_inputs(path: Path) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str], list[dict[str, Any]]]]:
    """load unique model-ready inputs and chronology cells once."""
    indexed: dict[str, dict[str, Any]] = {}
    cells: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    targets: dict[str, dict[str, Any]] = {}
    # validate every original input row
    for row in jsonl_rows(path):
        key = row.get("key")
        require(isinstance(key, str) and bool(key), "input key is missing")
        require(key not in indexed, f"duplicate input key: {key}")
        require(not (set(row) & PREDICTION_FIELDS), f"input contains prediction fields: {key}")
        cohort = row.get("cohort")
        require(cohort in COHORTS, f"unsupported input cohort: {cohort}")
        instant(row.get("validAt"))
        issue_boundary(row)
        band = lead_band(row)
        rain_amount(row.get("rawPrecipitationMm"), "rawPrecipitationMm")
        rain_amount(row.get("actualPrecipitationMm"), "actualPrecipitationMm")
        require(row.get("liquidOnly") is True, f"non-liquid input target: {key}")
        target_values = {
            field: row.get(field)
            for field in (
                "actualPrecipitationMm",
                "shiftMinus5MinutesMm",
                "gaugeMeanPrecipitationMm",
            )
        }
        previous = targets.setdefault(row["validAt"], target_values)
        compare(target_values, previous, f"input targets.{row['validAt']}")
        # validate every supplied alternative target
        for field in ("shiftMinus5MinutesMm", "gaugeMeanPrecipitationMm"):
            # preserve absent alternatives
            if row.get(field) is not None:
                rain_amount(row[field], field)
        indexed[key] = row
        cells[(cohort, band)].append(row)
    return indexed, cells


# identify one serialized model state
def state_identity(state: dict[str, Any]) -> tuple[str, str, str]:
    """return one state's issue month, source cohort, and lead band."""
    month = state.get("issueMonth")
    cohort = state.get("cohort")
    band = state.get("leadBand")
    require(isinstance(month, str), "model issueMonth is missing")
    month_start(month)
    require(cohort in COHORTS, "model cohort is invalid")
    require(band in {value[0] for value in LEAD_BANDS}, "model leadBand is invalid")
    return month, cohort, band


# load unique serialized model states
def load_models(path: Path) -> dict[tuple[str, str, str], dict[str, Any]]:
    """load each replayable model state under its declared identity."""
    result: dict[tuple[str, str, str], dict[str, Any]] = {}
    # retain each distinct serialized state
    for state in jsonl_rows(path, canonical=True):
        identity = state_identity(state)
        require(identity not in result, f"duplicate model state: {identity}")
        require(isinstance(state.get("supported"), bool), "model support flag is invalid")
        result[identity] = state
    return result


# reconstruct one chronology cell's independent support counts
def chronology_counts(
    rows: list[dict[str, Any]], cutoff: dt.datetime
) -> tuple[dict[str, int], list[dict[str, Any]]]:
    """count causally available rows, dates, hours, and wet support."""
    selected: list[dict[str, Any]] = []
    # select only labels strictly before the embargo cutoff
    for row in rows:
        # keep chronology strict
        if instant(row["validAt"]) < cutoff:
            selected.append(row)
    wet = [row for row in selected if row["actualPrecipitationMm"] >= THRESHOLDS[0]]
    return {
        "trainingRows": len(selected),
        "trainingDates": len({calendar(row)[0] for row in selected}),
        "trainingHours": len({row["validAt"] for row in selected}),
        "wetTrainingRows": len(wet),
        "wetTrainingDates": len({calendar(row)[0] for row in wet}),
        "wetTrainingHours": len({row["validAt"] for row in wet}),
    }, selected


# compute date-balanced effective valid-hour support
def effective_training_hours(rows: list[dict[str, Any]]) -> float:
    """return Kish support after collapsing repeated forecast vintages."""
    # preserve empty support
    if not rows:
        return 0.0
    weights = balanced_weights(rows)
    training_hours = len({row["validAt"] for row in rows})
    scaled = [weight * training_hours for weight in weights]
    hourly: dict[str, float] = collections.defaultdict(float)
    # collapse row weights to valid hours
    for row, weight in zip(rows, scaled, strict=True):
        hourly[row["validAt"]] += weight
    values = list(hourly.values())
    return sum(values) ** 2 / sum(value * value for value in values)


# verify state chronology and support independently
def verify_models(
    models: dict[tuple[str, str, str], dict[str, Any]],
    expected_identities: set[tuple[str, str, str]],
    cells: dict[tuple[str, str], list[dict[str, Any]]],
    policy: dict[str, Any],
) -> None:
    """bind exact model cells to original labels and frozen support gates."""
    require(set(models) == expected_identities, "serialized model identity population differs")
    embargo = number(policy.get("embargoHours"), "policy.embargoHours")
    require(embargo.is_integer() and embargo >= 0, "invalid embargo hours")
    support_fields = {
        "trainingDates": "minimumTrainingDates",
        "trainingHours": "minimumTrainingHours",
        "wetTrainingDates": "minimumWetTrainingDates",
        "wetTrainingHours": "minimumWetTrainingHours",
    }
    # verify every model cell independently
    for identity, state in models.items():
        month, cohort, band = identity
        cutoff = month_start(month) - dt.timedelta(hours=int(embargo))
        require(
            state.get("trainingCutoffUtc") == format_instant(cutoff),
            f"model cutoff differs: {identity}",
        )
        counts, selected = chronology_counts(cells.get((cohort, band), []), cutoff)
        # bind every available serialized support count
        for state_field, count in counts.items():
            require(state.get(state_field) == count, f"model {state_field} differs: {identity}")
        expected_supported = True
        # apply every frozen support minimum
        for count_field, policy_field in support_fields.items():
            minimum = number(policy.get(policy_field), f"policy.{policy_field}")
            require(minimum.is_integer() and minimum >= 0, f"invalid {policy_field}")
            expected_supported = expected_supported and counts[count_field] >= int(minimum)
        require(
            state["supported"] is expected_supported,
            f"model support decision differs: {identity}",
        )
        latest = max((instant(row["validAt"]) for row in selected), default=None)
        require(
            state.get("latestTrainingValidAt")
            == (None if latest is None else format_instant(latest)),
            f"model latest training instant differs: {identity}",
        )
        require(
            math.isclose(
                number(state.get("trainingWeightSum"), "trainingWeightSum"),
                counts["trainingHours"],
                abs_tol=1e-9,
            ),
            f"model training weight sum differs: {identity}",
        )
        require(
            math.isclose(
                number(state.get("effectiveTrainingHours"), "effectiveTrainingHours"),
                effective_training_hours(selected),
                rel_tol=1e-10,
                abs_tol=1e-9,
            ),
            f"model effective training hours differ: {identity}",
        )
        require(state.get("month") == month, f"model month alias differs: {identity}")
        require(
            state.get("contractVersion") == policy.get("contractVersion")
            and state.get("policyVersion") == policy.get("policyVersion")
            and state.get("featureSchemaVersion") == policy.get("featureSchemaVersion"),
            f"model schema binding differs: {identity}",
        )


# validate one retained prediction's output contracts
def validate_prediction(
    input_row: dict[str, Any],
    row: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    """bind forecast fields, controls, fallback, and intensity categories."""
    base = {key: value for key, value in row.items() if key not in PREDICTION_FIELDS}
    compare(base, input_row, f"prediction input.{input_row['key']}")
    predictions = row.get("predictions")
    require(isinstance(predictions, dict), "prediction candidates are missing")
    require(set(predictions) == set(CANDIDATES), "prediction candidate keys differ")
    raw = rain_amount(input_row["rawPrecipitationMm"], "raw prediction")
    # validate all physical candidate values
    for candidate, value in predictions.items():
        rain_amount(value, f"prediction.{candidate}")
    require(predictions["raw"] == raw, "raw control changed")
    require(predictions["zero"] == 0, "zero control changed")
    require(row.get("modelSupported") is state["supported"], "prediction support differs")
    # require exact raw fallback when unsupported
    if not state["supported"]:
        # check both learned candidates
        for candidate in CANDIDATES[2:]:
            require(predictions[candidate] == raw, "unsupported prediction is not exact raw")
    guard = predictions["intensityGuard"]
    # preserve exactly dry provider forecasts
    if raw == 0:
        require(guard == 0, "intensity guard changed an exactly dry forecast")
    # preserve every declared event category
    for threshold in THRESHOLDS:
        require(
            (guard >= threshold) == (raw >= threshold),
            f"intensity guard changed the {threshold} category",
        )
    return {
        "key": input_row["key"],
        "cohort": input_row["cohort"],
        "validAt": input_row["validAt"],
        "referenceAt": input_row.get("referenceAt"),
        "targetLeadHours": input_row["targetLeadHours"],
        "actualPrecipitationMm": input_row["actualPrecipitationMm"],
        "shiftMinus5MinutesMm": input_row.get("shiftMinus5MinutesMm"),
        "gaugeMeanPrecipitationMm": input_row.get("gaugeMeanPrecipitationMm"),
        "modelSupported": row["modelSupported"],
        "predictions": predictions,
        "recordKind": row["recordKind"],
    }


# validate exact prediction key populations and identities
def load_predictions(
    path: Path,
    inputs: dict[str, dict[str, Any]],
    models: dict[tuple[str, str, str], dict[str, Any]],
    policy: dict[str, Any],
) -> tuple[
    dict[str, list[dict[str, Any]]],
    dict[tuple[str, tuple[str, str, str]], list[dict[str, Any]]],
    dict[tuple[str, str], dict[str, Any]],
    set[tuple[str, str, str]],
]:
    """load validated minimal scoring rows and replay groups."""
    expected: set[tuple[str, str]] = set()
    expected_models: set[tuple[str, str, str]] = set()
    # derive exact scoring keys from original local dates
    for key, row in inputs.items():
        local_date, _ = calendar(row)
        # select only the declared evaluation span
        if PERIODS["completeMonths"][0] <= local_date <= PERIODS["partialSeptember"][1]:
            month = issue_month(row)
            band = lead_band(row)
            expected.add(("native", key))
            expected_models.add((month, row["cohort"], band))
            # add only the explicit best-match transfer
            if row["cohort"] == "best_match_single_run_transfer":
                expected.add(("ecmwf_to_best_match", key))
                expected_models.add((month, "ecmwf_single_run_hindcast", band))
    seen: set[tuple[str, str]] = set()
    scoring: dict[str, list[dict[str, Any]]] = {kind: [] for kind in RECORD_KINDS}
    replay: dict[tuple[str, tuple[str, str, str]], list[dict[str, Any]]] = (
        collections.defaultdict(list)
    )
    retained: dict[tuple[str, str], dict[str, Any]] = {}
    embargo = int(number(policy.get("embargoHours"), "policy.embargoHours"))
    # validate every retained prediction row
    for row in jsonl_rows(path, canonical=True):
        key = row.get("key")
        kind = row.get("recordKind")
        require(kind in RECORD_KINDS, f"invalid prediction record kind: {kind}")
        require(isinstance(key, str) and key in inputs, f"unknown prediction key: {key}")
        population_key = (kind, key)
        require(population_key not in seen, f"duplicate prediction row: {population_key}")
        require(population_key in expected, f"unexpected prediction row: {population_key}")
        source = inputs[key]
        month = issue_month(source)
        band = lead_band(source)
        model_cohort = source["cohort"]
        # bind the explicit transfer source
        if kind == "ecmwf_to_best_match":
            require(
                source["cohort"] == "best_match_single_run_transfer",
                "transfer applied outside best match",
            )
            model_cohort = "ecmwf_single_run_hindcast"
        identity = (month, model_cohort, band)
        require(identity in models, f"prediction model is missing: {identity}")
        require(row.get("modelIdentity") == list(identity), "prediction model identity differs")
        cutoff = month_start(month) - dt.timedelta(hours=embargo)
        require(
            row.get("trainingCutoffUtc") == format_instant(cutoff),
            "prediction cutoff differs",
        )
        minimal = validate_prediction(source, row, models[identity])
        scoring[kind].append(minimal)
        replay[(kind, identity)].append(source)
        retained[population_key] = row["predictions"]
        seen.add(population_key)
    require(seen == expected, "prediction scoring key population differs")
    return scoring, replay, retained, expected_models


# load the source-bound frozen model module
def load_frozen_model(directory: Path, policy: dict[str, Any]) -> Any:
    """import the hashed rain model snapshot for prediction replay."""
    source_dir = directory / "sources"
    path = source_dir / "rain_rate_model.py"
    require(path.is_file(), "frozen rain_rate_model.py is missing")
    module_name = f"verified_rain_rate_model_{digest(path)[:16]}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    require(spec is not None and spec.loader is not None, "cannot load frozen rain model")
    module = importlib.util.module_from_spec(spec)
    original_path = list(sys.path)
    # prefer only hashed snapshot dependencies
    sys.path.insert(0, str(source_dir))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = original_path
    require(tuple(module.CANDIDATES) == CANDIDATES, "frozen model candidates differ")
    compare(module.POLICY, policy, "frozen model policy")
    # bind imported local dependencies to snapshots when present
    for dependency in (getattr(module, "shared", None), getattr(module, "rain", None)):
        # inspect declared local dependencies only
        if dependency is not None and getattr(dependency, "__file__", None) is not None:
            require(
                Path(dependency.__file__).resolve().parent == source_dir.resolve(),
                "frozen model imported an unfrozen local dependency",
            )
    return module


# replay every frozen model prediction
def verify_replay(
    model: Any,
    replay: dict[tuple[str, tuple[str, str, str]], list[dict[str, Any]]],
    models: dict[tuple[str, str, str], dict[str, Any]],
    retained: dict[tuple[str, str], dict[str, Any]],
) -> None:
    """require frozen model inference to reproduce every retained candidate."""
    # replay each model cell without copying its original rows
    for (kind, identity), rows in sorted(replay.items()):
        predicted = model.predict_many(
            rows,
            models[identity],
            transfer=kind == "ecmwf_to_best_match",
        )
        require(len(predicted) == len(rows), f"replay length differs: {kind} {identity}")
        # compare every prediction under its stable key
        for row, value in zip(rows, predicted, strict=True):
            compare(value, retained[(kind, row["key"])], f"replay.{kind}.{row['key']}")


# refit every model cell from independently selected labels
def verify_refits(
    model: Any,
    models: dict[tuple[str, str, str], dict[str, Any]],
    cells: dict[tuple[str, str], list[dict[str, Any]]],
    policy: dict[str, Any],
) -> None:
    """refit each frozen cell and compare complete serialized model material."""
    embargo = int(number(policy.get("embargoHours"), "policy.embargoHours"))
    # refit each exact monthly source-band state
    for identity, retained_state in sorted(models.items()):
        month, cohort, band = identity
        cutoff = month_start(month) - dt.timedelta(hours=embargo)
        selected: list[dict[str, Any]] = []
        # preserve original input order while selecting chronology
        for row in cells.get((cohort, band), []):
            # retain only labels strictly before cutoff
            if instant(row["validAt"]) < cutoff:
                selected.append(row)
        fitted = model.fit(selected, month, cohort, band)
        compare(fitted, retained_state, f"refit.{month}.{cohort}.{band}")


# reconstruct the complete reported scoring tree
def verify_report(
    report: dict[str, Any],
    scoring: dict[str, list[dict[str, Any]]],
    input_count: int,
    prediction_count: int,
    model_count: int,
    policy: dict[str, Any],
) -> dict[str, dict[str, int]]:
    """compare every period, branch, cohort, grouping, and metric."""
    require(report.get("productionEligible") is False, "report is production eligible")
    require(report.get("candidateSelection") == "two_frozen_challengers_no_retuning_prior_period_already_consumed", "candidate selection disclosure differs")
    require(report.get("units") == "mean rain rate over complete reporting hour, mm/h; not instantaneous rain rate", "rain-rate units differ")
    require(report.get("gates") == EXPECTED_GATES, "development gates differ")
    compare(report.get("policy"), policy, "report policy")
    require(report.get("inputRows") == input_count, "report input row count differs")
    require(report.get("predictionRows") == prediction_count, "report prediction row count differs")
    require(report.get("modelCount") == model_count, "report model count differs")
    require(set(report.get("periods", {})) == set(PERIODS), "report period keys differ")
    counts: dict[str, dict[str, int]] = {}
    # verify both nonoverlapping evaluation periods
    for period, (start, end) in PERIODS.items():
        counts[period] = {}
        require(set(report["periods"][period]) == set(RECORD_KINDS), f"{period} record kinds differ")
        # keep native and transfer evidence separate
        for kind in RECORD_KINDS:
            selected = [
                row for row in scoring[kind] if start <= calendar(row)[0] <= end
            ]
            compare(
                summarize(selected),
                report["periods"][period][kind],
                f"report.periods.{period}.{kind}",
            )
            counts[period][kind] = len(selected)
    return counts


# run one complete independent verification
def verify_directory(
    directory: Path,
    output: Path,
    replay_model: bool = True,
    refit: bool = False,
) -> dict[str, Any]:
    """verify one retained rain-rate output and create its validation receipt."""
    directory = directory.resolve()
    output = output.resolve()
    require(directory.is_dir(), "retained output directory does not exist")
    require(not output.exists(), "validation output already exists")
    receipt_path = directory / "receipt.json"
    freeze_path = directory / "freeze.json"
    report_path = directory / "report.json"
    receipt = load_object(receipt_path)
    freeze = load_object(freeze_path)
    report = load_object(report_path)
    hashes = verify_receipt(directory, receipt, freeze)
    require(freeze.get("gates") == EXPECTED_GATES, "frozen development gates differ")
    policy = freeze.get("policy")
    require(isinstance(policy, dict), "frozen policy is missing")
    require(policy.get("productionEligible") is False, "model policy is production eligible")
    inputs, cells = load_inputs(directory / "input.jsonl.gz")
    models = load_models(directory / "models.jsonl.gz")
    scoring, replay, retained, expected_models = load_predictions(
        directory / "predictions.jsonl.gz", inputs, models, policy
    )
    verify_models(models, expected_models, cells, policy)
    model = None
    # load replay code only when inference or refit is requested
    if replay_model or refit:
        model = load_frozen_model(directory, policy)
    # replay every saved-state prediction
    if replay_model:
        verify_replay(model, replay, models, retained)
    # reproduce every serialized learner when requested
    if refit:
        verify_refits(model, models, cells, policy)
    prediction_count = sum(len(rows) for rows in scoring.values())
    require(receipt.get("inputRows") == len(inputs), "receipt input row count differs")
    require(receipt.get("predictionRows") == prediction_count, "receipt prediction row count differs")
    counts = verify_report(
        report,
        scoring,
        len(inputs),
        prediction_count,
        len(models),
        policy,
    )
    result = {
        "schemaVersion": "rain-rate-independent-verification/v1",
        "verified": True,
        "productionEligible": False,
        "accuracyQualification": False,
        "fullDeterministicRefit": refit,
        "interpretation": "artifact_integrity_and_development_screen_reproduction_only",
        "retainedReceiptSha256": digest(receipt_path),
        "inputSha256": hashes["input.jsonl.gz"],
        "inputRows": len(inputs),
        "predictionRows": prediction_count,
        "modelCount": len(models),
        "periodPredictionRows": counts,
        "checks": [
            "exact_file_and_source_hashes",
            "frozen_input_sha256",
            "exact_scoring_key_populations",
            "native_and_ecmwf_to_best_match_separation",
            "forecast_input_identity",
            "model_chronology_and_support",
            "prediction_controls_fallback_and_guard_categories",
            "all_rate_event_accumulation_sensitivity_metrics",
            "overall_and_lead_band_development_screens_fail_closed",
            *(["frozen_model_prediction_replay"] if replay_model else []),
            *(["deterministic_full_model_refit"] if refit else []),
        ],
    }
    write_json_exclusive(output, result)
    return result


# parse the strict command line
def main() -> None:
    """verify one directory and print its new receipt."""
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--refit", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    result = verify_directory(args.output_dir, args.output, refit=args.refit)
    print(json.dumps(result, allow_nan=False, sort_keys=True), flush=True)


# run only for direct invocation
if __name__ == "__main__":
    main()
