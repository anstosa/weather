#!/usr/bin/env python3
"""independently verify retained rain-rate volume calibration evidence."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

import verify_rain_rate_research as base

CANDIDATES = (*base.CANDIDATES, "volumeNeutralGuard", "volumeCalibratedGuard")
NEW_CANDIDATES = CANDIDATES[-2:]
POLICY = {
    "contractVersion": "rain-rate-volume-research/v1",
    "baseVersion": "rain-rate-tweedie-research/v1",
    "productionEligible": False,
    "primaryCandidate": "volumeCalibratedGuard",
    "diagnosticCandidate": "volumeNeutralGuard",
    "sourceWindowDays": 365,
    "embargoHours": 168,
    "minimumCalibrationDates": 60,
    "minimumCalibrationHours": 500,
    "minimumObservedWetDates": 10,
    "minimumObservedWetHours": 50,
    "wetThresholdMm": 0.1,
    "scaleBounds": [0.5, 2.0],
    "bisectionIterations": 64,
    "rootAbsoluteToleranceMmPerHour": 1e-10,
    "rootRelativeTolerance": 1e-8,
    "maximumRateMmPerHour": 500.0,
    "candidateSelection": "none_both_frozen_arms_reported",
    "dryMissCompensationCaveat": (
        "the observed-volume target can inflate raw-positive hours to offset "
        "raw-zero misses that the guard cannot repair"
    ),
}
CONTINUATION_GATES = {
    "minimumMaeImprovementVsRaw": 0.02,
    "absoluteVolumeErrorVsV1Guard": "strictly_smaller",
    "existingDevelopmentGates": "all_required_unchanged",
    "candidateSupport": (
        "at_least_180_supported_dates_and_20_supported_wet_dates"
    ),
    "primaryCandidate": "volumeCalibratedGuard",
    "diagnosticCandidate": "volumeNeutralGuard",
    "betweenArmSelection": "none",
    "accuracyQualification": False,
}
MINIMUM_DATES = POLICY["minimumCalibrationDates"]
MINIMUM_HOURS = POLICY["minimumCalibrationHours"]
MINIMUM_WET_DATES = POLICY["minimumObservedWetDates"]
MINIMUM_WET_HOURS = POLICY["minimumObservedWetHours"]
LOOKBACK_DAYS = POLICY["sourceWindowDays"]
MINIMUM_SCALE, MAXIMUM_SCALE = POLICY["scaleBounds"]
MAXIMUM_RATE = POLICY["maximumRateMmPerHour"]
BISECTION_STEPS = POLICY["bisectionIterations"]
VOLUME_TOLERANCE_ABSOLUTE = POLICY["rootAbsoluteToleranceMmPerHour"]
VOLUME_TOLERANCE_RELATIVE = POLICY["rootRelativeTolerance"]
RAW_CATEGORIES = (
    "zero",
    "trace",
    "wet",
    "heavy1",
    "heavy2",
)


# describe one independently reconstructed calibration arm
def _arm_result(
    supported: bool,
    reason: str,
    scale: float | None,
    target: float | None,
    achieved: float | None,
    lower: float | None,
    upper: float | None,
) -> dict[str, Any]:
    """return one strict independent calibration arm."""
    return {
        "supported": supported,
        "reason": reason,
        "scale": scale,
        "targetMean": target,
        "achievedMean": achieved,
        "lowerMean": lower,
        "upperMean": upper,
        "residual": None if target is None or achieved is None else achieved - target,
    }


# project one finite intensity into the provider's raw event category
def intensity_guard(raw: Any, blend: Any) -> float:
    """independently reproduce the frozen threshold-preserving projection."""
    raw_amount = base.rain_amount(raw, "raw")
    blend_amount = min(MAXIMUM_RATE, base.rain_amount(blend, "blend"))
    # preserve provider zeros exactly
    if raw_amount == 0:
        return 0.0
    # keep trace predictions below the wet threshold
    if raw_amount < base.THRESHOLDS[0]:
        return min(
            blend_amount,
            math.nextafter(base.THRESHOLDS[0], -math.inf),
        )
    # keep ordinary wet predictions below the first heavy threshold
    if raw_amount < base.THRESHOLDS[1]:
        return min(
            max(base.THRESHOLDS[0], blend_amount),
            math.nextafter(base.THRESHOLDS[1], -math.inf),
        )
    # keep first-tier heavy predictions below the second threshold
    if raw_amount < base.THRESHOLDS[2]:
        return min(
            max(base.THRESHOLDS[1], blend_amount),
            math.nextafter(base.THRESHOLDS[2], -math.inf),
        )
    return max(base.THRESHOLDS[2], blend_amount)


# reconstruct the scale-dependent projected mean
def projected_values(rows: list[dict[str, Any]], scale: float) -> list[float]:
    """return threshold-projected scaled V1 Tweedie predictions."""
    base.number(scale, "scale")
    # apply the same bounded candidate to every source row
    return [
        intensity_guard(
            row["rawPrecipitationMm"],
            min(MAXIMUM_RATE, scale * row["predictions"]["tweedieBlend"]),
        )
        for row in rows
    ]


# normalize the frozen equal-date equal-hour row weights
def normalized_weights(rows: list[dict[str, Any]]) -> list[float]:
    """return normalized date-hour-vintage weights."""
    weights = base.balanced_weights(rows)
    total = sum(weights)
    base.require(total > 0 and math.isfinite(total), "calibration weights are invalid")
    return [value / total for value in weights]


# average one candidate under frozen calibration weights
def weighted_mean(weights: list[float], values: list[float]) -> float:
    """return one finite weighted population mean."""
    base.require(len(weights) == len(values), "weighted mean population differs")
    return math.fsum(
        weight * value for weight, value in zip(weights, values, strict=True)
    )


# solve one bounded monotone volume calibration independently
def solve_arm(
    rows: list[dict[str, Any]], target_field: str, support_eligible: bool
) -> dict[str, Any]:
    """fit one bounded scale or return its exact raw fallback state."""
    # preserve entirely absent arithmetic for an empty source
    if not rows:
        return _arm_result(
            False, "insufficient_support", None, None, None, None, None
        )
    weights = normalized_weights(rows)
    raw = [base.rain_amount(row["rawPrecipitationMm"], "raw") for row in rows]
    target_values = [
        base.rain_amount(row[target_field], target_field) for row in rows
    ]
    raw_mean = weighted_mean(weights, raw)
    target_mean = weighted_mean(weights, target_values)
    tolerance = VOLUME_TOLERANCE_ABSOLUTE + VOLUME_TOLERANCE_RELATIVE * abs(
        target_mean
    )

    # evaluate each required decision boundary once
    def mean_at(scale: float) -> float:
        """return projected mean at one bounded scale."""
        return weighted_mean(weights, projected_values(rows, scale))

    low_mean = mean_at(MINIMUM_SCALE)
    high_mean = mean_at(MAXIMUM_SCALE)
    # preserve raw below any support floor
    if not support_eligible:
        return _arm_result(
            False,
            "insufficient_support",
            None,
            target_mean,
            raw_mean,
            low_mean,
            high_mean,
        )
    # reject an unidentifiable flat projected response
    if high_mean - low_mean <= tolerance:
        return _arm_result(
            False,
            "flat_volume_curve",
            None,
            target_mean,
            raw_mean,
            low_mean,
            high_mean,
        )
    # reject a target outside the attainable projected interval
    if target_mean < low_mean or target_mean > high_mean:
        return _arm_result(
            False,
            "target_outside_attainable_range",
            None,
            target_mean,
            raw_mean,
            low_mean,
            high_mean,
        )
    neutral_mean = mean_at(1.0)
    # preserve an already balanced neutral scale
    if abs(neutral_mean - target_mean) <= tolerance:
        return _arm_result(
            True,
            "supported",
            1.0,
            target_mean,
            neutral_mean,
            low_mean,
            high_mean,
        )
    # retain exact attainable endpoints
    if target_mean == low_mean:
        return _arm_result(
            True,
            "supported",
            MINIMUM_SCALE,
            target_mean,
            low_mean,
            low_mean,
            high_mean,
        )
    # retain exact attainable endpoints
    if target_mean == high_mean:
        return _arm_result(
            True,
            "supported",
            MAXIMUM_SCALE,
            target_mean,
            high_mean,
            low_mean,
            high_mean,
        )
    low = MINIMUM_SCALE
    high = MAXIMUM_SCALE
    low_value = low_mean
    high_value = high_mean
    # run the declared fixed-iteration monotone bisection
    for _step in range(BISECTION_STEPS):
        middle = (low + high) / 2
        middle_mean = mean_at(middle)
        # move the lower bound below the target
        if middle_mean < target_mean:
            low = middle
            low_value = middle_mean
        else:
            high = middle
            high_value = middle_mean
    scale, prediction_mean = min(
        ((low, low_value), (high, high_value)),
        key=lambda value: (
            abs(value[1] - target_mean),
            abs(value[0] - 1.0),
            value[0],
        ),
    )
    # reject numerical solutions outside the declared tolerance
    if abs(prediction_mean - target_mean) > tolerance:
        return _arm_result(
            False,
            "numerical_failure",
            None,
            target_mean,
            raw_mean,
            low_mean,
            high_mean,
        )
    return _arm_result(
        True,
        "supported",
        scale,
        target_mean,
        prediction_mean,
        low_mean,
        high_mean,
    )


# solve the observed-volume arm for focused unit tests
def solve_scale(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """return one supported observed-volume scale solution."""
    return solve_arm(rows, "actualPrecipitationMm", True)


# classify one raw provider rate into the frozen threshold category
def raw_category(raw: Any) -> str:
    """return one mutually exclusive raw-rate category."""
    value = base.rain_amount(raw, "raw")
    # preserve exact zero separately from trace rain
    if value == 0:
        return "zero"
    # separate nonzero subthreshold trace rain
    if value < base.THRESHOLDS[0]:
        return "trace"
    # separate ordinary wet rates
    if value < base.THRESHOLDS[1]:
        return "wet"
    # separate the first heavy tier
    if value < base.THRESHOLDS[2]:
        return "heavy1"
    return "heavy2"


# expose globally weighted volume contribution by raw event category
def raw_category_volume(
    rows: list[dict[str, Any]], candidates: tuple[str, ...] = CANDIDATES
) -> dict[str, Any]:
    """reconstruct non-renormalized raw-category volume contributions."""
    result: dict[str, Any] = {}
    weights = normalized_weights(rows) if rows else []
    actual = [
        base.rain_amount(row["actualPrecipitationMm"], "actual") for row in rows
    ]
    observed = weighted_mean(weights, actual) if rows else 0.0
    # retain every category including empty categories
    for category in RAW_CATEGORIES:
        selected = [
            index
            for index, row in enumerate(rows)
            if raw_category(row["rawPrecipitationMm"]) == category
        ]
        observed_contribution = sum(weights[index] * actual[index] for index in selected)
        predictions: dict[str, float] = {}
        # retain globally weighted candidate contributions
        for candidate in candidates:
            predictions[candidate] = sum(
                weights[index]
                * base.rain_amount(rows[index]["predictions"][candidate], candidate)
                for index in selected
            )
        result[category] = {
            "rows": len(selected),
            "hours": len({rows[index]["validAt"] for index in selected}),
            "weightMass": sum(weights[index] for index in selected),
            "observedMeanContributionMmPerHour": observed_contribution,
            "observedVolumeShare": (
                None if observed == 0 else observed_contribution / observed
            ),
            "predictedMeanContributionMmPerHour": predictions,
        }
    return result


# apply stronger continuation gates without relaxing the original screen
def continuation_screen(summary: dict[str, Any]) -> dict[str, Any]:
    """reconstruct both preregistered continuation screens."""
    result: dict[str, Any] = {}
    # preserve empty score populations explicitly
    if not summary["candidates"]:
        return result
    existing = base.screen(summary, CANDIDATES)
    raw = summary["candidates"]["raw"]
    guard = summary["candidates"]["intensityGuard"]
    # screen both arms without selecting between them
    for candidate_name in NEW_CANDIDATES:
        candidate = summary["candidates"][candidate_name]
        candidate_ratio = candidate["volumeRatio"]
        guard_ratio = guard["volumeRatio"]
        checks = {
            "existingDevelopmentScreen": existing[candidate_name][
                "passesDevelopmentScreen"
            ],
            "minimumTwoPercentMaeGainVsRaw": candidate["maeMmPerHour"]
            <= (1 - CONTINUATION_GATES["minimumMaeImprovementVsRaw"])
            * raw["maeMmPerHour"],
            "volumeErrorStrictlyBelowV1Guard": candidate_ratio is not None
            and guard_ratio is not None
            and abs(candidate_ratio - 1) < abs(guard_ratio - 1),
        }
        result[candidate_name] = {
            "passesContinuationScreen": all(checks.values()),
            "checks": checks,
        }
    return result


# count each retained per-arm fallback or application reason
def fallback_counts(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """return stable reason counts for both new candidates."""
    result: dict[str, dict[str, int]] = {}
    # count each arm independently
    for candidate in NEW_CANDIDATES:
        counts = collections.Counter(
            row["calibrationReasons"][candidate] for row in rows
        )
        result[candidate] = dict(sorted(counts.items()))
    return result


# group source support and fallback reasons without changing populations
def support_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """reconstruct overall, lead-band, and valid-month reason counts."""
    result: dict[str, Any] = {"overall": fallback_counts(rows)}
    dimensions = (
        ("byLeadBand", base.lead_band),
        ("byMonth", lambda row: base.calendar(row)[0][:7]),
    )
    # reproduce each declared reason-count grouping
    for field, key_function in dimensions:
        groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        # attach each row to one group
        for row in rows:
            groups[key_function(row)].append(row)
        result[field] = {
            key: fallback_counts(group_rows)
            for key, group_rows in sorted(groups.items())
        }
    return result


# reconstruct the complete native-only six-arm report
def reconstruct_report(
    rows: list[dict[str, Any]], model_count: int, baseline_receipt_sha: str
) -> dict[str, Any]:
    """return all scores, screens, categories, sensitivities, and fallbacks."""
    result: dict[str, Any] = {
        "contractVersion": "rain-rate-volume-report/v1",
        "productionEligible": False,
        "accuracyQualification": False,
        "policy": POLICY,
        "baseGates": base.EXPECTED_GATES,
        "continuationGates": CONTINUATION_GATES,
        "baselineReceiptSha256": baseline_receipt_sha,
        "predictionRows": len(rows),
        "modelCount": model_count,
        "interpretation": (
            "post_v1_selection_consumed_development_data_no_retuning_no_transfer_claim"
        ),
        "periods": {},
    }
    # reconstruct both nonoverlapping retained evaluation periods
    for period, (start, end) in base.PERIODS.items():
        selected = [
            row for row in rows if start <= base.calendar(row)[0] <= end
        ]
        summaries = base.summarize(selected, CANDIDATES)
        detail: dict[str, Any] = {
            "native": summaries,
            "continuationScreens": {},
            "rawCategoryVolume": {},
            "supportAndFallbacks": {},
        }
        # retain cohort isolation throughout every diagnostic
        for cohort in base.COHORTS:
            cohort_rows = [row for row in selected if row["cohort"] == cohort]
            summary = summaries[cohort]
            detail["continuationScreens"][cohort] = {
                "overall": continuation_screen(summary["overall"]),
                "byLeadBand": {
                    key: continuation_screen(value)
                    for key, value in summary["byLeadBand"].items()
                },
            }
            detail["rawCategoryVolume"][cohort] = raw_category_volume(cohort_rows)
            detail["supportAndFallbacks"][cohort] = support_report(cohort_rows)
        result["periods"][period] = detail
    return result


# select source-bound supported native V1 out-of-fold rows
def calibration_rows(
    rows: list[dict[str, Any]], month: str, cohort: str, band: str
) -> tuple[list[dict[str, Any]], dt.datetime, dt.datetime]:
    """select one causal trailing-year native V1 calibration population."""
    cutoff = base.month_start(month) - dt.timedelta(hours=168)
    start = cutoff - dt.timedelta(days=LOOKBACK_DAYS)
    selected: list[dict[str, Any]] = []
    # filter only pre-existing native supported OOF predictions
    for row in rows:
        valid = base.instant(row.get("validAt"))
        # retain only the exact source cell and causal window
        if (
            row.get("recordKind") == "native"
            and row.get("modelSupported") is True
            and row.get("cohort") == cohort
            and base.lead_band(row) == band
            and start <= valid < cutoff
        ):
            selected.append(row)
    # remove input-order effects from reconstructed arithmetic
    selected.sort(key=lambda row: (row["validAt"], row["key"]))
    return selected, start, cutoff


# reconstruct independent support dimensions for one selected source cell
def calibration_support(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """count calibration dates, hours, wet dates, and wet hours."""
    wet = [
        row
        for row in rows
        if base.rain_amount(row["actualPrecipitationMm"], "actual")
        >= base.THRESHOLDS[0]
    ]
    result = {
        "trainingRows": len(rows),
        "trainingDates": len({base.calendar(row)[0] for row in rows}),
        "trainingHours": len({row["validAt"] for row in rows}),
        "wetTrainingRows": len(wet),
        "wetTrainingDates": len({base.calendar(row)[0] for row in wet}),
        "wetTrainingHours": len({row["validAt"] for row in wet}),
    }
    result["supported"] = (
        result["trainingDates"] >= MINIMUM_DATES
        and result["trainingHours"] >= MINIMUM_HOURS
        and result["wetTrainingDates"] >= MINIMUM_WET_DATES
        and result["wetTrainingHours"] >= MINIMUM_WET_HOURS
    )
    return result


# hash one sorted source-key population independently
def source_key_digest(rows: list[dict[str, Any]]) -> str:
    """return the canonical source-key population SHA-256."""
    keys = sorted(row["key"] for row in rows)
    encoded = json.dumps(keys, ensure_ascii=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


# reproduce the source model's unnormalized date-hour-vintage weights
def source_weights(rows: list[dict[str, Any]]) -> list[float]:
    """give each represented local date one unit of source mass."""
    hours_by_date: dict[str, set[str]] = collections.defaultdict(set)
    rows_by_hour: collections.Counter[str] = collections.Counter()
    # count distinct hours and repeated vintages
    for row in rows:
        local_date = base.calendar(row)[0]
        hours_by_date[local_date].add(row["validAt"])
        rows_by_hour[row["validAt"]] += 1
    # split date mass across hours and repeated vintages
    return [
        1
        / (
            len(hours_by_date[base.calendar(row)[0]])
            * rows_by_hour[row["validAt"]]
        )
        for row in rows
    ]


# reconstruct Kish support after collapsing repeated forecast vintages
def effective_source_hours(rows: list[dict[str, Any]], weights: list[float]) -> float:
    """return source effective valid-hour support."""
    # preserve empty support explicitly
    if not rows:
        return 0.0
    hourly: dict[str, float] = collections.defaultdict(float)
    # collapse row weights to their valid hour
    for row, weight in zip(rows, weights, strict=True):
        hourly[row["validAt"]] += weight
    values = list(hourly.values())
    total = sum(values)
    return total * total / sum(value * value for value in values)


# reconstruct one complete monthly calibration state independently
def reconstruct_state(
    rows: list[dict[str, Any]], month: str, cohort: str, band: str
) -> dict[str, Any]:
    """return all causal source audits, means, roots, and fallback states."""
    selected, start, cutoff = calibration_rows(rows, month, cohort, band)
    support = calibration_support(selected)
    eligible = bool(support.pop("supported"))
    weights = source_weights(selected)
    weight_sum = math.fsum(weights)
    normalized = [weight / weight_sum for weight in weights] if selected else []

    # average one selected source field under normalized source weights
    def mean(field: str) -> float | None:
        """return one source-weighted retained prediction mean."""
        # preserve absent empty-source means
        if not selected:
            return None
        values = [
            base.rain_amount(row[field], field)
            if field != "tweedieBlend"
            else base.rain_amount(row["predictions"][field], field)
            for row in selected
        ]
        return weighted_mean(normalized, values)

    raw_mean = mean("rawPrecipitationMm")
    actual_mean = mean("actualPrecipitationMm")
    blend_mean = mean("tweedieBlend")
    unit_mean = (
        weighted_mean(normalized, projected_values(selected, 1.0))
        if selected
        else None
    )
    neutral = solve_arm(selected, "rawPrecipitationMm", eligible)
    calibrated = solve_arm(selected, "actualPrecipitationMm", eligible)
    latest = max(
        (base.instant(row["validAt"]) for row in selected), default=None
    )
    source_months = sorted({row["modelIdentity"][0] for row in selected})
    return {
        "contractVersion": POLICY["contractVersion"],
        "baseVersion": POLICY["baseVersion"],
        "productionEligible": False,
        "primaryCandidate": POLICY["primaryCandidate"],
        "diagnosticCandidate": POLICY["diagnosticCandidate"],
        "month": month,
        "issueMonth": month,
        "cohort": cohort,
        "leadBand": band,
        "baseModelIdentity": [month, cohort, band],
        "sourceWindowDays": LOOKBACK_DAYS,
        "embargoHours": POLICY["embargoHours"],
        "minimumCalibrationDates": MINIMUM_DATES,
        "minimumCalibrationHours": MINIMUM_HOURS,
        "minimumObservedWetDates": MINIMUM_WET_DATES,
        "minimumObservedWetHours": MINIMUM_WET_HOURS,
        "wetThresholdMm": POLICY["wetThresholdMm"],
        "scaleBounds": POLICY["scaleBounds"],
        "bisectionIterations": BISECTION_STEPS,
        "rootAbsoluteToleranceMmPerHour": VOLUME_TOLERANCE_ABSOLUTE,
        "rootRelativeTolerance": VOLUME_TOLERANCE_RELATIVE,
        "maximumRateMmPerHour": MAXIMUM_RATE,
        "sourceWindowStartUtc": base.format_instant(start),
        "sourceCutoffUtc": base.format_instant(cutoff),
        "sourceRows": support["trainingRows"],
        "sourceDates": support["trainingDates"],
        "sourceHours": support["trainingHours"],
        "sourceWetRows": support["wetTrainingRows"],
        "sourceWetDates": support["wetTrainingDates"],
        "sourceWetHours": support["wetTrainingHours"],
        "sourceKeyCount": len(selected),
        "sourceKeySha256": source_key_digest(selected),
        "sourceWeightSum": weight_sum,
        "effectiveSourceHours": effective_source_hours(selected, weights),
        "latestSourceValidAt": (
            None if latest is None else base.format_instant(latest)
        ),
        "sourceModelMonths": source_months,
        "sourceRawMean": raw_mean,
        "sourceActualMean": actual_mean,
        "sourceTweedieBlendMean": blend_mean,
        "sourceUnitScaleMean": unit_mean,
        "supportEligible": eligible,
        "arms": {
            "volumeNeutralGuard": neutral,
            "volumeCalibratedGuard": calibrated,
        },
    }


# validate exact root file hashes and frozen snapshot populations
def verify_receipt(
    directory: Path,
    receipt: dict[str, Any],
    freeze: dict[str, Any],
) -> dict[str, str]:
    """bind every extension, source, and baseline snapshot byte."""
    files = receipt.get("files")
    source_hashes = freeze.get("sourceSha256")
    baseline_hashes = freeze.get("baselineFilesSha256")
    base.require(isinstance(files, dict), "volume receipt files are missing")
    base.require(isinstance(source_hashes, dict), "volume source hashes are missing")
    base.require(
        isinstance(baseline_hashes, dict), "volume baseline hashes are missing"
    )
    expected = {
        "freeze.json",
        "calibration-models.jsonl.gz",
        "predictions.jsonl.gz",
        "report.json",
        *(f"sources/{name}" for name in source_hashes),
        *(f"baseline/{name}" for name in baseline_hashes),
    }
    base.require(set(files) == expected, "volume receipt file population differs")
    actual: dict[str, str] = {}
    # validate every receipt-bound relative regular file
    for name in sorted(expected):
        relative = Path(name)
        path = directory / relative
        base.require(
            not relative.is_absolute() and ".." not in relative.parts,
            f"invalid retained path: {name}",
        )
        base.require(path.is_file() and not path.is_symlink(), f"missing file: {name}")
        base.require(
            directory in path.resolve().parents, f"retained path escapes output: {name}"
        )
        actual[name] = base.digest(path)
        base.require(actual[name] == files[name], f"retained hash differs: {name}")
    # bind nested source and baseline hash namespaces
    for name, expected_hash in source_hashes.items():
        base.require(
            actual[f"sources/{name}"] == expected_hash,
            f"source freeze differs: {name}",
        )
    # bind every copied baseline byte to its pre-copy identity
    for name, expected_hash in baseline_hashes.items():
        base.require(
            actual[f"baseline/{name}"] == expected_hash,
            f"baseline freeze differs: {name}",
        )
    base.require(
        receipt.get("contractVersion") == "rain-rate-volume-receipt/v1",
        "volume receipt contract differs",
    )
    base.require(receipt.get("productionEligible") is False, "receipt is eligible")
    return actual


# validate the retained original v1 proof and population binding
def verify_baseline(directory: Path) -> tuple[list[dict[str, Any]], str]:
    """bind the copied full-refit v1 proof to every original artifact."""
    receipt_path = directory / "receipt.json"
    receipt = base.load_object(receipt_path)
    freeze = base.load_object(directory / "freeze.json")
    report = base.load_object(directory / "report.json")
    verification = base.load_object(directory / "independent-verification.json")
    hashes = base.verify_receipt(directory, receipt, freeze)
    receipt_sha = base.digest(receipt_path)
    base.require(
        verification.get("schemaVersion") == "rain-rate-independent-verification/v1"
        and verification.get("verified") is True
        and verification.get("fullDeterministicRefit") is True
        and verification.get("productionEligible") is False
        and verification.get("accuracyQualification") is False,
        "baseline full-refit proof is invalid",
    )
    base.require(
        verification.get("retainedReceiptSha256") == receipt_sha,
        "baseline proof receipt hash differs",
    )
    base.require(
        verification.get("inputSha256") == hashes["input.jsonl.gz"],
        "baseline proof input hash differs",
    )
    # bind all duplicated population counts across the original proof
    for field in ("inputRows", "predictionRows"):
        base.require(
            verification.get(field) == receipt.get(field) == report.get(field),
            f"baseline {field} differs",
        )
    base.require(
        verification.get("modelCount") == report.get("modelCount"),
        "baseline model count differs",
    )
    period_counts = verification.get("periodPredictionRows")
    base.require(isinstance(period_counts, dict), "baseline period counts are missing")
    counted_predictions = 0
    # reject transfer evidence and bind the complete period partition
    for period in base.PERIODS:
        counts = period_counts.get(period)
        base.require(isinstance(counts, dict), f"baseline period is missing: {period}")
        base.require(
            counts.get("ecmwf_to_best_match") == 0,
            "baseline contains transfer prediction proof",
        )
        native_count = counts.get("native")
        base.require(
            isinstance(native_count, int) and not isinstance(native_count, bool),
            f"baseline native period count is invalid: {period}",
        )
        counted_predictions += native_count
    base.require(
        counted_predictions == verification["predictionRows"],
        "baseline proof period population differs",
    )
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    # validate every exact v1 scoring row used by the continuation
    for row in base.jsonl_rows(directory / "predictions.jsonl.gz", canonical=True):
        key = row.get("key")
        base.require(isinstance(key, str) and key and key not in seen, "duplicate base key")
        seen.add(key)
        base.require(row.get("recordKind") == "native", "baseline row is not native")
        base.require(row.get("liquidOnly") is True, "baseline target is not liquid-only")
        local_date = base.calendar(row)[0]
        base.require(
            base.PERIODS["completeMonths"][0]
            <= local_date
            <= base.PERIODS["partialSeptember"][1],
            "baseline prediction lies outside the retained evaluation period",
        )
        month = base.issue_month(row)
        identity = [month, row.get("cohort"), base.lead_band(row)]
        base.require(row.get("modelIdentity") == identity, "baseline model identity differs")
        cutoff = base.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
        base.require(
            row.get("trainingCutoffUtc") == base.format_instant(cutoff),
            "baseline training cutoff differs",
        )
        base.require(isinstance(row.get("modelSupported"), bool), "base support is invalid")
        raw = base.rain_amount(row.get("rawPrecipitationMm"), "base raw")
        base.rain_amount(row.get("actualPrecipitationMm"), "base actual")
        predictions = row.get("predictions")
        base.require(
            isinstance(predictions, dict)
            and set(predictions) == set(base.CANDIDATES),
            "baseline prediction candidates differ",
        )
        # validate all original prediction controls and fallbacks
        for candidate, value in predictions.items():
            base.rain_amount(value, f"baseline prediction.{candidate}")
        base.require(predictions["raw"] == raw, "baseline raw control changed")
        base.require(predictions["zero"] == 0, "baseline zero control changed")
        base.require(
            predictions["intensityGuard"]
            == intensity_guard(raw, predictions["tweedieBlend"]),
            "baseline intensity guard changed",
        )
        # require exact raw learned fallbacks when the original model was unsupported
        if not row["modelSupported"]:
            for candidate in base.CANDIDATES[2:]:
                base.require(
                    predictions[candidate] == raw,
                    "baseline unsupported prediction is not raw",
                )
        rows.append(row)
    base.require(len(rows) == receipt["predictionRows"], "baseline row count differs")
    return rows, receipt_sha


# load and independently reproduce every retained calibration state
def load_states(
    path: Path, baseline_rows: list[dict[str, Any]]
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """return unique states after causal selection and arithmetic replay."""
    partitions: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    expected: set[tuple[str, str, str]] = set()
    # derive every target identity and source partition from baseline rows
    for row in baseline_rows:
        band = base.lead_band(row)
        partitions[(row["cohort"], band)].append(row)
        expected.add((base.issue_month(row), row["cohort"], band))
    states: dict[tuple[str, str, str], dict[str, Any]] = {}
    # compare every saved state with an independent reconstruction
    for state in base.jsonl_rows(path, canonical=True):
        identity = (
            state.get("issueMonth"),
            state.get("cohort"),
            state.get("leadBand"),
        )
        base.require(identity in expected, f"unexpected calibration state: {identity}")
        base.require(identity not in states, f"duplicate calibration state: {identity}")
        month, cohort, band = identity
        reconstructed = reconstruct_state(
            partitions[(cohort, band)], month, cohort, band
        )
        base.compare(state, reconstructed, f"calibration-state.{month}.{cohort}.{band}")
        states[identity] = state
    base.require(set(states) == expected, "calibration state population differs")
    return states


# load and independently reproduce all six retained predictions
def load_predictions(
    path: Path,
    baseline_rows: list[dict[str, Any]],
    states: dict[tuple[str, str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    """bind unchanged v1 rows and replay both volume arms."""
    originals = {row["key"]: row for row in baseline_rows}
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    extension_fields = {
        "candidateSupported",
        "calibrationIdentity",
        "calibrationCutoffUtc",
        "calibrationReasons",
    }
    # validate every retained six-arm prediction
    for row in base.jsonl_rows(path, canonical=True):
        key = row.get("key")
        base.require(isinstance(key, str) and key in originals, "unknown prediction key")
        base.require(key not in seen, f"duplicate volume prediction: {key}")
        original = originals[key]
        identity = (base.issue_month(original), original["cohort"], base.lead_band(original))
        state = states[identity]
        # require every nonprediction baseline field to remain byte-equivalent
        retained_base = {
            name: value
            for name, value in row.items()
            if name != "predictions" and name not in extension_fields
        }
        original_base = {
            name: value for name, value in original.items() if name != "predictions"
        }
        base.compare(retained_base, original_base, f"volume input.{key}")
        predictions = row.get("predictions")
        base.require(
            isinstance(predictions, dict) and set(predictions) == set(CANDIDATES),
            "volume prediction candidates differ",
        )
        # bind all four original arms without rerunning XGBoost
        for candidate in base.CANDIDATES:
            base.compare(
                predictions[candidate],
                original["predictions"][candidate],
                f"volume base prediction.{key}.{candidate}",
            )
        candidate_supported = row.get("candidateSupported")
        base.require(
            isinstance(candidate_supported, dict)
            and set(candidate_supported) == set(CANDIDATES)
            and all(type(value) is bool for value in candidate_supported.values()),
            "candidate support mapping differs",
        )
        expected_support = {
            "raw": True,
            "zero": True,
            "tweedieBlend": original["modelSupported"],
            "intensityGuard": original["modelSupported"],
            **{
                candidate: bool(
                    original["modelSupported"]
                    and state["arms"][candidate]["supported"]
                )
                for candidate in NEW_CANDIDATES
            },
        }
        base.require(candidate_supported == expected_support, "candidate support differs")
        base.require(
            row.get("calibrationIdentity") == list(identity),
            "calibration identity differs",
        )
        base.require(
            row.get("calibrationCutoffUtc") == state["sourceCutoffUtc"],
            "calibration cutoff differs",
        )
        reasons = row.get("calibrationReasons")
        base.require(
            isinstance(reasons, dict) and set(reasons) == set(NEW_CANDIDATES),
            "calibration reasons differ",
        )
        raw = base.rain_amount(original["rawPrecipitationMm"], "raw")
        # replay each new arm and its applicability reason independently
        for candidate in NEW_CANDIDATES:
            arm = state["arms"][candidate]
            supported = expected_support[candidate]
            expected_value = (
                intensity_guard(
                    raw,
                    min(
                        MAXIMUM_RATE,
                        arm["scale"] * original["predictions"]["tweedieBlend"],
                    ),
                )
                if supported
                else raw
            )
            base.compare(
                predictions[candidate], expected_value, f"volume prediction.{key}.{candidate}"
            )
            expected_reason = (
                "base_model_unsupported"
                if not original["modelSupported"]
                else "applied"
                if supported
                else arm["reason"]
            )
            base.require(reasons[candidate] == expected_reason, "calibration reason differs")
            # preserve raw category and exact unsupported fallback
            if not supported:
                base.require(predictions[candidate] == raw, "volume fallback is not exact raw")
            if raw == 0:
                base.require(predictions[candidate] == 0, "volume arm changed raw zero")
            for threshold in base.THRESHOLDS:
                base.require(
                    (predictions[candidate] >= threshold) == (raw >= threshold),
                    f"volume arm changed raw category: {threshold}",
                )
        result.append(row)
        seen.add(key)
    base.require(seen == set(originals), "volume prediction population differs")
    return result


# create one exclusive independent receipt
def verify_directory(directory: Path, output: Path) -> dict[str, Any]:
    """verify one retained volume continuation directory."""
    directory = directory.resolve()
    output = output.resolve()
    base.require(directory.is_dir(), "retained output directory does not exist")
    base.require(not output.exists(), "validation output already exists")
    receipt_path = directory / "receipt.json"
    receipt = base.load_object(receipt_path)
    freeze = base.load_object(directory / "freeze.json")
    report = base.load_object(directory / "report.json")
    hashes = verify_receipt(directory, receipt, freeze)
    base.require(
        set(freeze)
        == {
            "contractVersion",
            "productionEligible",
            "policy",
            "continuationGates",
            "baselineFilesSha256",
            "sourceSha256",
            "frozenAtUtc",
        },
        "volume freeze fields differ",
    )
    base.require(
        freeze.get("contractVersion") == "rain-rate-volume-experiment/v1",
        "volume experiment contract differs",
    )
    base.require(freeze.get("productionEligible") is False, "freeze is eligible")
    base.compare(freeze.get("policy"), POLICY, "volume policy")
    base.compare(
        freeze.get("continuationGates"),
        CONTINUATION_GATES,
        "continuation gates",
    )
    expected_sources = {
        "run_rain_rate_volume.py",
        "rain_rate_volume.py",
        "run_rain_rate_research.py",
        "rain_rate_model.py",
        "rain_research.py",
        "humidity_research.py",
    }
    base.require(
        set(freeze["sourceSha256"]) == expected_sources,
        "volume source population differs",
    )
    frozen_at = freeze.get("frozenAtUtc")
    base.require(isinstance(frozen_at, str), "volume freeze instant is missing")
    try:
        parsed_frozen_at = dt.datetime.fromisoformat(frozen_at)
    except ValueError as error:
        raise base.VerificationError("volume freeze instant is invalid") from error
    base.require(
        parsed_frozen_at.tzinfo is not None
        and parsed_frozen_at.utcoffset() == dt.timedelta(0),
        "volume freeze instant is not UTC",
    )
    baseline_dir = directory / "baseline"
    baseline_rows, baseline_receipt_sha = verify_baseline(baseline_dir)
    baseline_receipt = base.load_object(baseline_dir / "receipt.json")
    expected_baseline_hashes = dict(baseline_receipt["files"])
    expected_baseline_hashes["receipt.json"] = baseline_receipt_sha
    expected_baseline_hashes["independent-verification.json"] = base.digest(
        baseline_dir / "independent-verification.json"
    )
    base.require(
        freeze["baselineFilesSha256"] == expected_baseline_hashes,
        "baseline copied file population differs",
    )
    base.require(
        hashes["baseline/receipt.json"] == baseline_receipt_sha,
        "baseline receipt root binding differs",
    )
    states = load_states(directory / "calibration-models.jsonl.gz", baseline_rows)
    predictions = load_predictions(
        directory / "predictions.jsonl.gz", baseline_rows, states
    )
    base.require(
        receipt.get("baselineRows") == len(baseline_rows),
        "volume receipt baseline count differs",
    )
    base.require(
        receipt.get("predictionRows") == len(predictions),
        "volume receipt prediction count differs",
    )
    base.require(
        receipt.get("modelCount") == len(states),
        "volume receipt model count differs",
    )
    expected_report = reconstruct_report(
        predictions, len(states), baseline_receipt_sha
    )
    base.compare(report, expected_report, "volume report")
    result = {
        "schemaVersion": "rain-rate-volume-independent-verification/v1",
        "verified": True,
        "productionEligible": False,
        "accuracyQualification": False,
        "deploymentQualification": False,
        "interpretation": (
            "artifact_integrity_causal_calibration_and_development_screen_reproduction_only"
        ),
        "retainedReceiptSha256": base.digest(receipt_path),
        "baselineReceiptSha256": baseline_receipt_sha,
        "baselinePredictionRows": len(baseline_rows),
        "predictionRows": len(predictions),
        "modelCount": len(states),
        "checks": [
            "exact_extension_source_and_baseline_hashes",
            "original_v1_full_refit_proof_and_population_binding",
            "native_only_identical_baseline_prediction_population",
            "causal_trailing_year_source_selection_and_support",
            "source_key_cutoff_model_month_weight_and_mean_audits",
            "independent_bounded_scale_and_raw_fallback_reproduction",
            "unchanged_v1_predictions_and_model_identities",
            "all_six_prediction_arms_support_reasons_and_guard_categories",
            "all_period_cohort_rate_event_accumulation_and_sensitivity_metrics",
            "candidate_specific_development_and_continuation_screens",
            "globally_weighted_raw_category_volume_contributions",
            "support_and_fallback_reason_counts",
        ],
    }
    base.write_json_exclusive(output, result)
    return result


# parse the strict command line
def main() -> None:
    """verify one directory and print its new receipt."""
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    result = verify_directory(args.output_dir, args.output)
    print(json.dumps(result, allow_nan=False, sort_keys=True), flush=True)


# run only for direct invocation
if __name__ == "__main__":
    main()
