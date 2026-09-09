#!/usr/bin/env python3
"""fit frozen out-of-sample rain-rate volume calibrations."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from collections.abc import Iterable, Mapping
from typing import Any

import humidity_research as shared
import rain_rate_model as base


CANDIDATES = (
    *base.CANDIDATES,
    "volumeNeutralGuard",
    "volumeCalibratedGuard",
)
VOLUME_CANDIDATES = CANDIDATES[-2:]
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

_STATE_FIELDS = frozenset(
    {
        "contractVersion",
        "baseVersion",
        "productionEligible",
        "primaryCandidate",
        "diagnosticCandidate",
        "month",
        "issueMonth",
        "cohort",
        "leadBand",
        "baseModelIdentity",
        "sourceWindowDays",
        "embargoHours",
        "minimumCalibrationDates",
        "minimumCalibrationHours",
        "minimumObservedWetDates",
        "minimumObservedWetHours",
        "wetThresholdMm",
        "scaleBounds",
        "bisectionIterations",
        "rootAbsoluteToleranceMmPerHour",
        "rootRelativeTolerance",
        "maximumRateMmPerHour",
        "sourceWindowStartUtc",
        "sourceCutoffUtc",
        "sourceRows",
        "sourceKeyCount",
        "sourceKeySha256",
        "sourceDates",
        "sourceHours",
        "sourceWetRows",
        "sourceWetDates",
        "sourceWetHours",
        "sourceWeightSum",
        "effectiveSourceHours",
        "latestSourceValidAt",
        "sourceModelMonths",
        "sourceRawMean",
        "sourceActualMean",
        "sourceTweedieBlendMean",
        "sourceUnitScaleMean",
        "supportEligible",
        "arms",
    }
)
_ARM_FIELDS = frozenset(
    {
        "supported",
        "reason",
        "scale",
        "targetMean",
        "achievedMean",
        "lowerMean",
        "upperMean",
        "residual",
    }
)
_UNSUPPORTED_REASONS = frozenset(
    {
        "insufficient_support",
        "flat_volume_curve",
        "target_outside_attainable_range",
        "numerical_failure",
    }
)


# bind the exact frozen v1 dependency contract
def _require_base_contract() -> None:
    """require the reviewed v1 rain-rate prediction interface."""
    # reject a changed base model or candidate order
    if (
        base.POLICY.get("contractVersion") != POLICY["baseVersion"]
        or tuple(base.CANDIDATES)
        != ("raw", "zero", "tweedieBlend", "intensityGuard")
    ):
        raise ValueError("base rain-rate model contract changed")


# require one row-shaped object
def _mapping(row: Any) -> Mapping[str, Any]:
    """require one mapping-shaped retained prediction row."""
    # reject non-object rows
    if not isinstance(row, Mapping):
        raise ValueError("rain-rate volume row must be an object")
    return row


# require one finite scalar without booleans
def _number(value: Any, name: str) -> float:
    """require one finite numeric state value."""
    # reject booleans and nonfinite scalars
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be finite")
    return float(value)


# require one nonnegative integer
def _count(value: Any, name: str) -> int:
    """require one nonnegative integer state count."""
    # reject booleans, fractions, and negative counts
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


# validate one forecast identity without reading an observed label
def _identity(row: Any) -> tuple[Mapping[str, Any], dict[str, Any]]:
    """validate one retained forecast identity without reading truth."""
    value = _mapping(row)
    # validate only the identity columns needed by retained prediction replay
    try:
        key = value.get("key")
        # require one stable independent target key
        if not isinstance(key, str) or not key:
            raise ValueError("forecast key must be a nonempty string")
        identity = {
            "key": key,
            "cohort": shared.cohort(value),
            "validAt": shared.instant(value["validAt"]),
            "leadBand": shared.lead_band(value),
        }
        issue_at, boundary_kind = shared.issue_boundary(value)
        identity.update(
            issueAt=issue_at,
            issueBoundaryKind=boundary_kind,
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid rain-rate volume forecast identity") from error
    return value, identity


# validate one monthly native calibration cell
def _fit_cell(
    month: Any, cohort: Any, band: Any
) -> tuple[str, str, str, dt.datetime, dt.datetime]:
    """validate one monthly cohort-band calibration cell."""
    # require one declared native cohort
    if cohort not in shared.COHORTS:
        raise ValueError("unsupported forecast cohort")
    # require one literal lead band
    if band not in {item[0] for item in shared.LEAD_BANDS}:
        raise ValueError("unsupported lead band")
    # bind the source window to the target month
    try:
        month_start = shared.month_start(month)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid calibration issue month") from error
    cutoff = month_start - dt.timedelta(hours=POLICY["embargoHours"])
    start = cutoff - dt.timedelta(days=POLICY["sourceWindowDays"])
    return month, cohort, band, start, cutoff


# validate retained v1 controls and native model provenance
def _base_record(
    row: Mapping[str, Any], identity: Mapping[str, Any]
) -> tuple[float, dict[str, float], bool, str]:
    """validate one native v1 prediction without reading observed truth."""
    # require only native retained predictions
    if row.get("recordKind") != "native":
        raise ValueError("rain-rate volume calibration requires native predictions")
    model_supported = row.get("modelSupported")
    # require an explicit base support flag
    if not isinstance(model_supported, bool):
        raise ValueError("base rain-rate support flag is invalid")
    issue_month = shared.issue_month(row)
    expected_identity = [
        issue_month,
        identity["cohort"],
        identity["leadBand"],
    ]
    # bind the retained row to its own native base state
    if row.get("modelIdentity") != expected_identity:
        raise ValueError("base rain-rate model identity is invalid")
    # bind the source model cutoff to its own issue month
    try:
        cutoff = shared.instant(row.get("trainingCutoffUtc"))
    except (TypeError, ValueError) as error:
        raise ValueError("base rain-rate training cutoff is invalid") from error
    expected_cutoff = shared.month_start(issue_month) - dt.timedelta(
        hours=POLICY["embargoHours"]
    )
    # reject shifted or in-sample source model boundaries
    if cutoff != expected_cutoff or cutoff >= identity["issueAt"]:
        raise ValueError("base rain-rate prediction is not out of sample")
    # validate all four frozen base predictions
    try:
        raw = base.rain.amount(row["rawPrecipitationMm"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("base raw rain rate is invalid") from error
    predictions = row.get("predictions")
    # reject missing, incomplete, or extended base candidate sets
    if not isinstance(predictions, Mapping) or set(predictions) != set(
        base.CANDIDATES
    ):
        raise ValueError("base rain-rate prediction candidates are invalid")
    values: dict[str, float] = {}
    # validate each retained amount independently
    for candidate in base.CANDIDATES:
        try:
            values[candidate] = base.rain.amount(predictions[candidate])
        except (TypeError, ValueError) as error:
            raise ValueError("base rain-rate prediction is invalid") from error
    # preserve both controls exactly
    if values["raw"] != raw or values["zero"] != 0.0:
        raise ValueError("base rain-rate controls changed")
    expected_guard = base.intensity_guard(raw, values["tweedieBlend"])
    # bind the retained guard to the frozen v1 projection
    if values["intensityGuard"] != expected_guard:
        raise ValueError("base rain-rate intensity guard changed")
    # require exact raw fallbacks from unsupported base states
    if not model_supported and any(
        values[candidate] != raw for candidate in base.CANDIDATES[2:]
    ):
        raise ValueError("unsupported base rain-rate prediction changed")
    return raw, values, model_supported, issue_month


# project one scaled v1 blend through the frozen intensity guard
def _project(raw: float, blend: float, scale: float) -> float:
    """scale one v1 blend and preserve the raw intensity category."""
    scaled = min(POLICY["maximumRateMmPerHour"], scale * blend)
    return base.intensity_guard(raw, scaled)


# compute one stable normalized weighted mean
def _mean(weights: list[float], values: Iterable[float]) -> float:
    """compute one deterministic balanced weighted mean."""
    return math.fsum(
        weight * value for weight, value in zip(weights, values, strict=True)
    )


# hash one stable source-key population
def _key_digest(keys: Iterable[str]) -> str:
    """hash one sorted source-key population."""
    encoded = json.dumps(
        sorted(keys), ensure_ascii=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


# select only native earlier out-of-sample v1 rows
def _source_rows(
    rows: Iterable[Any],
    month: Any,
    cohort: Any,
    band: Any,
) -> tuple[list[dict[str, Any]], dt.datetime, dt.datetime]:
    """select and validate one causal native calibration population."""
    _month, selected_cohort, selected_band, start, cutoff = _fit_cell(
        month, cohort, band
    )
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    actual_by_hour: dict[dt.datetime, float] = {}
    # isolate forecast-time cells before reading retained labels
    for candidate in rows:
        row, identity = _identity(candidate)
        eligible = (
            identity["cohort"] == selected_cohort
            and identity["leadBand"] == selected_band
            and start <= identity["validAt"] < cutoff
            and row.get("recordKind") == "native"
            and row.get("modelSupported") is True
        )
        # leave unavailable, foreign, transfer, and unsupported labels unread
        if not eligible:
            continue
        key = identity["key"]
        # require independent source prediction identities
        if key in seen:
            raise ValueError("duplicate calibration source key")
        seen.add(key)
        raw, predictions, _supported, source_month = _base_record(row, identity)
        # require liquid-only source truth only after causal selection
        if row.get("liquidOnly") is not True:
            raise ValueError("calibration source target must be liquid-only")
        try:
            actual = base.rain.amount(row["actualPrecipitationMm"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("calibration source target is invalid") from error
        previous = actual_by_hour.get(identity["validAt"])
        # reject contradictory truth for repeated forecasts of one hour
        if previous is not None and previous != actual:
            raise ValueError("contradictory calibration labels for one valid hour")
        actual_by_hour[identity["validAt"]] = actual
        selected.append(
            {
                "key": key,
                "cohort": identity["cohort"],
                "leadBand": identity["leadBand"],
                "validAt": shared.format_instant(identity["validAt"]),
                "actual": actual,
                "raw": raw,
                "tweedieBlend": predictions["tweedieBlend"],
                "sourceModelMonth": source_month,
            }
        )
    # remove input-order effects from balancing and root arithmetic
    selected.sort(key=lambda item: (item["validAt"], item["key"]))
    return selected, start, cutoff


# count independent dates, hours, and wet truth support
def _support(rows: list[dict[str, Any]]) -> dict[str, int]:
    """count balanced calibration support dimensions."""
    dates: set[str] = set()
    hours: set[dt.datetime] = set()
    wet_dates: set[str] = set()
    wet_hours: set[dt.datetime] = set()
    wet_rows = 0
    # collapse forecast vintages only for independent support counts
    for row in rows:
        valid_at = shared.instant(row["validAt"])
        local_date = valid_at.astimezone(shared.ZONE).date().isoformat()
        dates.add(local_date)
        hours.add(valid_at)
        # count observed-wet support at the frozen threshold
        if row["actual"] >= POLICY["wetThresholdMm"]:
            wet_rows += 1
            wet_dates.add(local_date)
            wet_hours.add(valid_at)
    return {
        "sourceRows": len(rows),
        "sourceDates": len(dates),
        "sourceHours": len(hours),
        "sourceWetRows": wet_rows,
        "sourceWetDates": len(wet_dates),
        "sourceWetHours": len(wet_hours),
    }


# derive the frozen support decision
def _support_eligible(support: Mapping[str, int]) -> bool:
    """apply every frozen calibration support floor."""
    return (
        support["sourceDates"] >= POLICY["minimumCalibrationDates"]
        and support["sourceHours"] >= POLICY["minimumCalibrationHours"]
        and support["sourceWetDates"] >= POLICY["minimumObservedWetDates"]
        and support["sourceWetHours"] >= POLICY["minimumObservedWetHours"]
    )


# compute the frozen root tolerance for one target mean
def _tolerance(target: float) -> float:
    """return the absolute-plus-relative volume root tolerance."""
    return POLICY["rootAbsoluteToleranceMmPerHour"] + POLICY[
        "rootRelativeTolerance"
    ] * abs(target)


# construct one exact raw-fallback arm
def _fallback_arm(
    reason: str,
    target: float | None,
    raw_mean: float | None,
    lower_mean: float | None,
    upper_mean: float | None,
) -> dict[str, Any]:
    """return one unsupported arm with exact raw achieved volume."""
    residual = (
        None if target is None or raw_mean is None else raw_mean - target
    )
    return {
        "supported": False,
        "reason": reason,
        "scale": None,
        "targetMean": target,
        "achievedMean": raw_mean,
        "lowerMean": lower_mean,
        "upperMean": upper_mean,
        "residual": residual,
    }


# solve one fixed monotone projected-volume root
def _solve_arm(
    curve: Any,
    target: float | None,
    raw_mean: float | None,
    lower_mean: float | None,
    upper_mean: float | None,
    support_eligible: bool,
) -> dict[str, Any]:
    """solve one frozen bisection root or return exact raw fallback."""
    # preserve raw below any support floor
    if not support_eligible:
        return _fallback_arm(
            "insufficient_support", target, raw_mean, lower_mean, upper_mean
        )
    if (
        target is None
        or raw_mean is None
        or lower_mean is None
        or upper_mean is None
    ):
        raise AssertionError("eligible calibration support is empty")
    tolerance = _tolerance(target)
    # reject an unidentifiable projected-volume curve
    if upper_mean - lower_mean <= tolerance:
        return _fallback_arm(
            "flat_volume_curve", target, raw_mean, lower_mean, upper_mean
        )
    # require the target to lie strictly inside the attainable bracket
    if target < lower_mean or target > upper_mean:
        return _fallback_arm(
            "target_outside_attainable_range",
            target,
            raw_mean,
            lower_mean,
            upper_mean,
        )
    unit_mean = curve(1.0)
    # prefer the neutral scale whenever it already solves the target
    if abs(unit_mean - target) <= tolerance:
        return {
            "supported": True,
            "reason": "supported",
            "scale": 1.0,
            "targetMean": target,
            "achievedMean": unit_mean,
            "lowerMean": lower_mean,
            "upperMean": upper_mean,
            "residual": unit_mean - target,
        }
    lower_scale, upper_scale = POLICY["scaleBounds"]
    # preserve exact attainable-bound roots
    if target == lower_mean:
        return {
            "supported": True,
            "reason": "supported",
            "scale": lower_scale,
            "targetMean": target,
            "achievedMean": lower_mean,
            "lowerMean": lower_mean,
            "upperMean": upper_mean,
            "residual": 0.0,
        }
    # preserve exact attainable-bound roots
    if target == upper_mean:
        return {
            "supported": True,
            "reason": "supported",
            "scale": upper_scale,
            "targetMean": target,
            "achievedMean": upper_mean,
            "lowerMean": lower_mean,
            "upperMean": upper_mean,
            "residual": 0.0,
        }
    lower_value = lower_mean
    upper_value = upper_mean
    # apply exactly the frozen number of monotone bisection steps
    for _ in range(POLICY["bisectionIterations"]):
        midpoint = (lower_scale + upper_scale) / 2.0
        midpoint_value = curve(midpoint)
        # retain the lower or upper target bracket deterministically
        if midpoint_value < target:
            lower_scale, lower_value = midpoint, midpoint_value
        else:
            upper_scale, upper_value = midpoint, midpoint_value
    scale, achieved = min(
        ((lower_scale, lower_value), (upper_scale, upper_value)),
        key=lambda item: (
            abs(item[1] - target),
            abs(item[0] - 1.0),
            item[0],
        ),
    )
    residual = achieved - target
    # fail back to raw rather than retaining an approximate endpoint
    if abs(residual) > tolerance:
        return _fallback_arm(
            "numerical_failure", target, raw_mean, lower_mean, upper_mean
        )
    return {
        "supported": True,
        "reason": "supported",
        "scale": scale,
        "targetMean": target,
        "achievedMean": achieved,
        "lowerMean": lower_mean,
        "upperMean": upper_mean,
        "residual": residual,
    }


# fit both preregistered volume targets from retained v1 predictions
def fit(
    rows: Iterable[Any], month: Any, cohort: Any, band: Any
) -> dict[str, Any]:
    """fit two frozen native rain-rate volume calibration arms."""
    _require_base_contract()
    # require an iterable population rather than text or one object
    if isinstance(rows, (str, bytes, Mapping)):
        raise ValueError("rain-rate volume fit rows must be iterable")
    try:
        selected, start, cutoff = _source_rows(rows, month, cohort, band)
    except TypeError as error:
        raise ValueError("rain-rate volume fit rows must be iterable") from error
    support = _support(selected)
    eligible = _support_eligible(support)
    latest = max(
        (shared.instant(row["validAt"]) for row in selected), default=None
    )
    source_months = sorted({row["sourceModelMonth"] for row in selected})
    source_keys = [row["key"] for row in selected]
    weights_array = (
        shared.balanced_weights(selected)
        if selected
        else []
    )
    weight_sum = (
        math.fsum(float(weight) for weight in weights_array)
        if selected
        else 0.0
    )
    # normalize equal date, hour, and vintage mass
    if selected and (not math.isfinite(weight_sum) or weight_sum <= 0):
        raise ValueError("calibration source weights are invalid")
    weights = (
        [float(weight) / weight_sum for weight in weights_array]
        if selected
        else []
    )
    effective_hours = (
        float(shared.effective_valid_hour_count(selected, weights_array))
        if selected
        else 0.0
    )
    raw_mean = (
        _mean(weights, (row["raw"] for row in selected))
        if selected
        else None
    )
    actual_mean = (
        _mean(weights, (row["actual"] for row in selected))
        if selected
        else None
    )
    blend_mean = (
        _mean(weights, (row["tweedieBlend"] for row in selected))
        if selected
        else None
    )

    # define the frozen projected-volume equation
    def curve(scale: float) -> float:
        """evaluate the balanced guarded v1 blend at one scale."""
        return _mean(
            weights,
            (
                _project(row["raw"], row["tweedieBlend"], scale)
                for row in selected
            ),
        )

    lower_mean = curve(POLICY["scaleBounds"][0]) if selected else None
    upper_mean = curve(POLICY["scaleBounds"][1]) if selected else None
    unit_mean = curve(1.0) if selected else None
    arms = {
        "volumeNeutralGuard": _solve_arm(
            curve,
            raw_mean,
            raw_mean,
            lower_mean,
            upper_mean,
            eligible,
        ),
        "volumeCalibratedGuard": _solve_arm(
            curve,
            actual_mean,
            raw_mean,
            lower_mean,
            upper_mean,
            eligible,
        ),
    }
    state: dict[str, Any] = {
        "contractVersion": POLICY["contractVersion"],
        "baseVersion": POLICY["baseVersion"],
        "productionEligible": POLICY["productionEligible"],
        "primaryCandidate": POLICY["primaryCandidate"],
        "diagnosticCandidate": POLICY["diagnosticCandidate"],
        "month": month,
        "issueMonth": month,
        "cohort": cohort,
        "leadBand": band,
        "baseModelIdentity": [month, cohort, band],
        "sourceWindowDays": POLICY["sourceWindowDays"],
        "embargoHours": POLICY["embargoHours"],
        "minimumCalibrationDates": POLICY["minimumCalibrationDates"],
        "minimumCalibrationHours": POLICY["minimumCalibrationHours"],
        "minimumObservedWetDates": POLICY["minimumObservedWetDates"],
        "minimumObservedWetHours": POLICY["minimumObservedWetHours"],
        "wetThresholdMm": POLICY["wetThresholdMm"],
        "scaleBounds": list(POLICY["scaleBounds"]),
        "bisectionIterations": POLICY["bisectionIterations"],
        "rootAbsoluteToleranceMmPerHour": POLICY[
            "rootAbsoluteToleranceMmPerHour"
        ],
        "rootRelativeTolerance": POLICY["rootRelativeTolerance"],
        "maximumRateMmPerHour": POLICY["maximumRateMmPerHour"],
        "sourceWindowStartUtc": shared.format_instant(start),
        "sourceCutoffUtc": shared.format_instant(cutoff),
        **support,
        "sourceKeyCount": len(source_keys),
        "sourceKeySha256": _key_digest(source_keys),
        "sourceWeightSum": weight_sum,
        "effectiveSourceHours": effective_hours,
        "latestSourceValidAt": (
            None if latest is None else shared.format_instant(latest)
        ),
        "sourceModelMonths": source_months,
        "sourceRawMean": raw_mean,
        "sourceActualMean": actual_mean,
        "sourceTweedieBlendMean": blend_mean,
        "sourceUnitScaleMean": unit_mean,
        "supportEligible": eligible,
        "arms": arms,
    }
    # prove strict json portability and internal replay validity
    json.dumps(state, allow_nan=False, separators=(",", ":"))
    _model_state(state)
    return state


# validate one portable calibration state before prediction
def _model_state(model: Any) -> Mapping[str, Any]:
    """require one compatible internally consistent calibration state."""
    _require_base_contract()
    # reject non-object or silently extended states
    if not isinstance(model, Mapping) or set(model) != _STATE_FIELDS:
        raise ValueError("rain-rate volume model state is invalid")
    fixed = {
        "contractVersion": POLICY["contractVersion"],
        "baseVersion": POLICY["baseVersion"],
        "productionEligible": POLICY["productionEligible"],
        "primaryCandidate": POLICY["primaryCandidate"],
        "diagnosticCandidate": POLICY["diagnosticCandidate"],
        "sourceWindowDays": POLICY["sourceWindowDays"],
        "embargoHours": POLICY["embargoHours"],
        "minimumCalibrationDates": POLICY["minimumCalibrationDates"],
        "minimumCalibrationHours": POLICY["minimumCalibrationHours"],
        "minimumObservedWetDates": POLICY["minimumObservedWetDates"],
        "minimumObservedWetHours": POLICY["minimumObservedWetHours"],
        "wetThresholdMm": POLICY["wetThresholdMm"],
        "scaleBounds": POLICY["scaleBounds"],
        "bisectionIterations": POLICY["bisectionIterations"],
        "rootAbsoluteToleranceMmPerHour": POLICY[
            "rootAbsoluteToleranceMmPerHour"
        ],
        "rootRelativeTolerance": POLICY["rootRelativeTolerance"],
        "maximumRateMmPerHour": POLICY["maximumRateMmPerHour"],
    }
    # bind every persisted policy value literally
    if any(model.get(name) != value for name, value in fixed.items()):
        raise ValueError("rain-rate volume model policy changed")
    # reject conflicting issue month aliases
    if model.get("month") != model.get("issueMonth"):
        raise ValueError("rain-rate volume issue month is inconsistent")
    try:
        _month, cohort, band, start, cutoff = _fit_cell(
            model.get("issueMonth"), model.get("cohort"), model.get("leadBand")
        )
        stored_start = shared.instant(model.get("sourceWindowStartUtc"))
        stored_cutoff = shared.instant(model.get("sourceCutoffUtc"))
    except (TypeError, ValueError) as error:
        raise ValueError("rain-rate volume source window is invalid") from error
    # bind the source window to the exact embargo and duration
    if stored_start != start or stored_cutoff != cutoff:
        raise ValueError("rain-rate volume source window changed")
    expected_identity = [model["issueMonth"], cohort, band]
    # bind inference to the native target base model
    if model.get("baseModelIdentity") != expected_identity:
        raise ValueError("rain-rate volume base model identity changed")
    count_names = (
        "sourceRows",
        "sourceKeyCount",
        "sourceDates",
        "sourceHours",
        "sourceWetRows",
        "sourceWetDates",
        "sourceWetHours",
    )
    counts = {name: _count(model.get(name), name) for name in count_names}
    # require unique source keys and nested independent support
    if not (
        counts["sourceKeyCount"] == counts["sourceRows"]
        and counts["sourceRows"] >= counts["sourceHours"] >= counts["sourceDates"]
        and counts["sourceWetRows"]
        >= counts["sourceWetHours"]
        >= counts["sourceWetDates"]
        and counts["sourceWetRows"] <= counts["sourceRows"]
        and counts["sourceWetHours"] <= counts["sourceHours"]
        and counts["sourceWetDates"] <= counts["sourceDates"]
    ):
        raise ValueError("rain-rate volume support counts are inconsistent")
    # require empty and nonempty support dimensions to agree
    if (counts["sourceRows"] == 0) != (counts["sourceHours"] == 0) or (
        counts["sourceHours"] == 0
    ) != (counts["sourceDates"] == 0):
        raise ValueError("rain-rate volume empty support is inconsistent")
    expected_support = _support_eligible(counts)
    # bind the frozen support flag to all four floors
    if model.get("supportEligible") is not expected_support:
        raise ValueError("rain-rate volume support decision changed")
    digest = model.get("sourceKeySha256")
    # require one canonical sha256 audit digest
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise ValueError("rain-rate volume source digest is invalid")
    # bind the known empty source digest exactly
    if counts["sourceRows"] == 0 and digest != _key_digest([]):
        raise ValueError("empty rain-rate volume source digest changed")
    weight_sum = _number(model.get("sourceWeightSum"), "sourceWeightSum")
    effective = _number(
        model.get("effectiveSourceHours"), "effectiveSourceHours"
    )
    # validate balanced weight and kish support audits
    if (
        not math.isclose(
            weight_sum, float(counts["sourceDates"]), abs_tol=1e-9
        )
        or effective < 0
        or effective > counts["sourceHours"] + 1e-9
        or (counts["sourceRows"] > 0 and effective <= 0)
    ):
        raise ValueError("rain-rate volume weight support is invalid")
    latest_text = model.get("latestSourceValidAt")
    model_months = model.get("sourceModelMonths")
    # require stable canonical source-model month audits
    if (
        not isinstance(model_months, list)
        or any(not isinstance(value, str) for value in model_months)
        or model_months != sorted(set(model_months))
    ):
        raise ValueError("rain-rate volume source model months are invalid")
    # validate each audited source month
    for source_month in model_months:
        try:
            source_month_start = shared.month_start(source_month)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "rain-rate volume source model month is invalid"
            ) from error
        # reject model months that cannot precede the source cutoff
        if source_month_start >= cutoff:
            raise ValueError("rain-rate volume source model month is not causal")
    # require no latest instant or model month for an empty source
    if counts["sourceRows"] == 0:
        if latest_text is not None or model_months:
            raise ValueError("empty rain-rate volume source audit changed")
    else:
        # require one causal latest selected source instant
        try:
            latest = shared.instant(latest_text)
        except (TypeError, ValueError) as error:
            raise ValueError("latest rain-rate volume source is invalid") from error
        if not start <= latest < cutoff or not model_months:
            raise ValueError("latest rain-rate volume source is outside its window")
    mean_names = (
        "sourceRawMean",
        "sourceActualMean",
        "sourceTweedieBlendMean",
        "sourceUnitScaleMean",
    )
    means: dict[str, float | None] = {}
    # require absent means only for an empty source
    for name in mean_names:
        value = model.get(name)
        if counts["sourceRows"] == 0:
            if value is not None:
                raise ValueError("empty rain-rate volume means changed")
            means[name] = None
        else:
            numeric = _number(value, name)
            if not 0 <= numeric <= POLICY["maximumRateMmPerHour"]:
                raise ValueError("rain-rate volume source mean is invalid")
            means[name] = numeric
    arms = model.get("arms")
    # require exactly the two preregistered calibration arms
    if not isinstance(arms, Mapping) or set(arms) != set(VOLUME_CANDIDATES):
        raise ValueError("rain-rate volume arms are invalid")
    targets = {
        "volumeNeutralGuard": means["sourceRawMean"],
        "volumeCalibratedGuard": means["sourceActualMean"],
    }
    reference_lower: float | None = None
    reference_upper: float | None = None
    # validate each arm without selecting between their outcomes
    for candidate in VOLUME_CANDIDATES:
        arm = arms[candidate]
        if not isinstance(arm, Mapping) or set(arm) != _ARM_FIELDS:
            raise ValueError("rain-rate volume arm state is invalid")
        if not isinstance(arm.get("supported"), bool):
            raise ValueError("rain-rate volume arm support is invalid")
        target = arm.get("targetMean")
        achieved = arm.get("achievedMean")
        lower = arm.get("lowerMean")
        upper = arm.get("upperMean")
        residual = arm.get("residual")
        # preserve entirely absent arm arithmetic for an empty source
        if counts["sourceRows"] == 0:
            if any(
                value is not None
                for value in (target, achieved, lower, upper, residual)
            ):
                raise ValueError("empty rain-rate volume arm means changed")
        else:
            target = _number(target, "targetMean")
            achieved = _number(achieved, "achievedMean")
            lower = _number(lower, "lowerMean")
            upper = _number(upper, "upperMean")
            residual = _number(residual, "residual")
            if (
                target != targets[candidate]
                or lower > upper
                or not math.isclose(
                    residual, achieved - target, rel_tol=0.0, abs_tol=1e-12
                )
            ):
                raise ValueError("rain-rate volume arm arithmetic changed")
            if candidate == VOLUME_CANDIDATES[0]:
                reference_lower, reference_upper = lower, upper
            elif lower != reference_lower or upper != reference_upper:
                raise ValueError("rain-rate volume arm brackets differ")
        reason = arm.get("reason")
        scale = arm.get("scale")
        # validate supported root material
        if arm["supported"]:
            numeric_scale = _number(scale, "scale")
            tolerance = _tolerance(float(target))
            if (
                not expected_support
                or reason != "supported"
                or float(upper) - float(lower) <= tolerance
                or float(target) < float(lower)
                or float(target) > float(upper)
                or not POLICY["scaleBounds"][0]
                <= numeric_scale
                <= POLICY["scaleBounds"][1]
                or abs(float(residual)) > tolerance
            ):
                raise ValueError("rain-rate volume supported arm is invalid")
        else:
            # validate exact raw fallback state
            if (
                scale is not None
                or reason not in _UNSUPPORTED_REASONS
                or (
                    counts["sourceRows"] > 0
                    and achieved != means["sourceRawMean"]
                )
                or (reason == "insufficient_support") is not (not expected_support)
            ):
                raise ValueError("rain-rate volume fallback arm is invalid")
            # bind supported-population fallback reasons to their arithmetic
            if counts["sourceRows"] > 0 and expected_support:
                tolerance = _tolerance(float(target))
                flat = float(upper) - float(lower) <= tolerance
                outside = float(target) < float(lower) or float(target) > float(upper)
                if (
                    (reason == "flat_volume_curve" and not flat)
                    or (
                        reason == "target_outside_attainable_range"
                        and (flat or not outside)
                    )
                    or (
                        reason == "numerical_failure"
                        and (flat or outside)
                    )
                ):
                    raise ValueError("rain-rate volume fallback reason changed")
    unit_mean = means["sourceUnitScaleMean"]
    # bind the unit-scale audit to the common attainable interval
    if (
        unit_mean is not None
        and reference_lower is not None
        and not reference_lower <= unit_mean <= float(reference_upper)
    ):
        raise ValueError("rain-rate volume unit-scale mean is invalid")
    return model


# bind one current native v1 prediction to its calibration state
def _prediction_record(
    row: Any, state: Mapping[str, Any]
) -> tuple[Mapping[str, Any], dict[str, Any], float, dict[str, float], bool]:
    """validate one current base prediction without reading truth fields."""
    value, identity = _identity(row)
    raw, predictions, supported, _source_month = _base_record(value, identity)
    # bind cohort, literal band, and issue month natively
    if (
        identity["cohort"] != state["cohort"]
        or identity["leadBand"] != state["leadBand"]
        or shared.issue_month(value) != state["issueMonth"]
        or value.get("modelIdentity") != state["baseModelIdentity"]
    ):
        raise ValueError("forecast does not match rain-rate volume model")
    return value, identity, raw, predictions, supported


# expose per-arm applicability for reporting
def calibration_support(row: Any, model: Any) -> dict[str, bool]:
    """return current-row applicability for both frozen volume arms."""
    state = _model_state(model)
    _value, _identity_value, _raw, _predictions, base_supported = (
        _prediction_record(row, state)
    )
    return {
        candidate: bool(base_supported and state["arms"][candidate]["supported"])
        for candidate in VOLUME_CANDIDATES
    }


# apply both frozen factors to current supplied v1 predictions
def predict_many(rows: Iterable[Any], model: Any) -> list[dict[str, float]]:
    """replay six rain-rate arms without reading observed labels."""
    state = _model_state(model)
    # require an iterable population rather than text or one object
    if isinstance(rows, (str, bytes, Mapping)):
        raise ValueError("rain-rate volume prediction rows must be iterable")
    try:
        prepared = [_prediction_record(row, state) for row in rows]
    except TypeError as error:
        raise ValueError("rain-rate volume prediction rows must be iterable") from error
    seen: set[str] = set()
    # require independent target prediction identities
    for _row, identity, _raw, _predictions, _supported in prepared:
        if identity["key"] in seen:
            raise ValueError("duplicate rain-rate volume target key")
        seen.add(identity["key"])
    result: list[dict[str, float]] = []
    # copy base predictions and append each applicable frozen arm
    for _row, _identity_value, raw, predictions, base_supported in prepared:
        values = {candidate: predictions[candidate] for candidate in base.CANDIDATES}
        # apply each arm independently without outcome-based selection
        for candidate in VOLUME_CANDIDATES:
            arm = state["arms"][candidate]
            values[candidate] = (
                _project(raw, predictions["tweedieBlend"], arm["scale"])
                if base_supported and arm["supported"]
                else raw
            )
        result.append(values)
    return result
