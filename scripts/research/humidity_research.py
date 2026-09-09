#!/usr/bin/env python3
"""Research-only causal relative-humidity calibration."""

from __future__ import annotations

import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

# keep numerical fitting deterministic
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import numpy as np


ZONE = ZoneInfo("America/Los_Angeles")
UTC = dt.timezone.utc
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
CANDIDATES = ("raw", "medianBias", "hierarchy", "ridge")
TRANSFERS = (
    "ecmwf_to_best_match",
    "fixed_anchor_24h_to_legacy_v4",
    "fixed_anchor_48h_to_legacy_v4",
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
POLICY = {
    "contractVersion": "humidity-causal-research/v1",
    "embargoHours": 168,
    "minimumTrainingDates": 180,
    "minimumTrainingRows": 1000,
    "correctionWeight": 0.5,
    "maximumCorrectionPercentagePoints": 20.0,
    "physicalMinimumPercent": 0.0,
    "physicalMaximumPercent": 100.0,
    "ridgeMeanLossPenalty": 0.1,
    "huberDeltaPercentagePoints": 10.0,
    "iterations": 8,
    "hierarchy": {
        "root": {"minimumEffectiveEvents": 200, "pseudocount": 200},
        "seasonDaypart": {"minimumEffectiveEvents": 100, "pseudocount": 100},
        "monthDaypart": {"minimumEffectiveEvents": 50, "pseudocount": 50},
    },
    "completeEvaluationStartLocalDate": "2025-01-01",
    "completeEvaluationEndLocalDate": "2026-08-31",
    "partialEvaluationStartLocalDate": "2026-09-01",
    "partialEvaluationEndLocalDate": "2026-09-06",
    "bestMatchTransferStartLocalDate": "2026-04-02",
    "bestMatchTransferEndLocalDate": "2026-09-06",
    "productionEligible": False,
}


# require a finite scalar without accepting booleans
def number(value):
    """require a finite numeric input"""
    # reject booleans and nonfinite values
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError("expected finite numeric input")
    return float(value)


# require a canonical millisecond utc instant
def instant(value):
    """parse one canonical utc instant"""
    # reject nontext values
    if not isinstance(value, str):
        raise ValueError("expected canonical utc instant")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # reject offsets and alternate precision
    if parsed.tzinfo != UTC or canonical != value:
        raise ValueError("expected canonical utc instant")
    return parsed


# format one canonical millisecond utc instant
def format_instant(value):
    """format one utc datetime"""
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# canonicalize a source instant before the strict model boundary
def canonical_source_instant(value):
    """normalize one UTC source instant to model-ready milliseconds"""
    # reject nontext source values
    if not isinstance(value, str):
        raise ValueError("source instant must be text")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    # reject offsets before normalization
    if parsed.tzinfo != UTC:
        raise ValueError("source instant must be UTC")
    return format_instant(parsed)


# require one supported integer lead
def lead_hours(row):
    """validate one forecast lead"""
    lead = number(row["targetLeadHours"])
    # require the archived range
    if not lead.is_integer() or not 1 <= lead <= 168:
        raise ValueError("target lead must be an integer from 1 through 168")
    return int(lead)


# select one frozen lead band without interpolation
def lead_band(row):
    """map one forecast to its literal lead band"""
    lead = lead_hours(row)
    # select the unique inclusive interval
    for key, minimum, maximum in LEAD_BANDS:
        # return the literal band
        if minimum <= lead <= maximum:
            return key
    raise AssertionError("validated lead did not match a band")


# require one declared forecast cohort
def cohort(row):
    """validate one forecast cohort"""
    value = row.get("cohort")
    # reject undeclared cohorts
    if value not in COHORTS:
        raise ValueError("unsupported forecast cohort")
    return value


# derive the forecast issue boundary without inventing availability
def issue_boundary(row):
    """return the explicit or nominal issue boundary"""
    valid_at = instant(row["validAt"])
    lead = lead_hours(row)
    reference_value = row.get("referenceAt")
    # preserve truthful retrieval-reference timing
    if reference_value is not None:
        reference_at = instant(reference_value)
        elapsed = (valid_at - reference_at).total_seconds() / 3600
        # bind reference timing to lead
        if elapsed <= 0 or math.ceil(elapsed) != lead:
            raise ValueError("reference must agree with target lead")
        return reference_at, "reference_at"
    return valid_at - dt.timedelta(hours=lead), "nominal_valid_minus_lead"


# derive one local issue-calendar model month
def issue_month(row):
    """select model state from the issue boundary"""
    boundary, _ = issue_boundary(row)
    return boundary.astimezone(ZONE).strftime("%Y-%m")


# derive the beginning of one local-calendar fit month
def month_start(month):
    """parse one canonical model month"""
    # reject nontext values
    if not isinstance(month, str):
        raise ValueError("expected canonical calendar month")
    parsed = dt.datetime.strptime(month, "%Y-%m")
    # reject alternate spellings
    if parsed.strftime("%Y-%m") != month:
        raise ValueError("expected canonical calendar month")
    return parsed.replace(tzinfo=ZONE).astimezone(UTC)


# derive frozen local calendar cells
def calendar(row):
    """return local date, month, season, and six-hour daypart"""
    local = instant(row["validAt"]).astimezone(ZONE)
    # map midnight through dawn
    if local.hour < 6:
        daypart = "night"
    # map morning hours
    elif local.hour < 12:
        daypart = "morning"
    # map afternoon hours
    elif local.hour < 18:
        daypart = "afternoon"
    # map evening hours
    else:
        daypart = "evening"
    return {
        "localDate": local.date().isoformat(),
        "month": local.month,
        "season": SEASONS[local.month],
        "daypart": daypart,
    }


# validate one model-ready forecast row without reading its label
def forecast_identity(row):
    """validate fields available before the observed outcome"""
    key = row.get("key")
    # require stable identity
    if not isinstance(key, str) or not key:
        raise ValueError("forecast key must be a nonempty string")
    selected_cohort = cohort(row)
    valid_at = instant(row["validAt"])
    band = lead_band(row)
    issue_at, boundary_kind = issue_boundary(row)
    raw_humidity = number(row["rawRelativeHumidityPercent"])
    # enforce physical humidity bounds
    if not 0 <= raw_humidity <= 100:
        raise ValueError("raw relative humidity is outside physical bounds")
    # validate optional ridge predictors
    for field in ("rawTemperatureC", "rawWindSpeedMps"):
        value = row.get(field)
        # validate supplied values
        if value is not None:
            number(value)
    return {
        "key": key,
        "cohort": selected_cohort,
        "validAt": valid_at,
        "leadBand": band,
        "issueAt": issue_at,
        "issueBoundaryKind": boundary_kind,
        "rawHumidity": raw_humidity,
    }


# require one physical observed humidity label
def actual_humidity(row):
    """validate the observed relative humidity"""
    actual = number(row["actualRelativeHumidityPercent"])
    # enforce physical humidity bounds
    if not 0 <= actual <= 100:
        raise ValueError("actual relative humidity is outside physical bounds")
    return actual


# hold one validated forecast-time training index
class PreparedRows:
    """store validated rows by isolated cohort and literal lead band"""

    # retain immutable-by-convention research inputs
    def __init__(self, entries, by_cell):
        """initialize one internal training index"""
        self.entries = entries
        self.by_cell = by_cell


# validate the full input once before repeated monthly fits
def prepare_training_rows(rows):
    """index model-ready rows without reading observed labels"""
    entries = []
    by_cell = collections.defaultdict(list)
    seen = set()
    # validate every forecast-time identity once
    for row in rows:
        identity = forecast_identity(row)
        # reject duplicate identities globally
        if identity["key"] in seen:
            raise ValueError("duplicate forecast key")
        seen.add(identity["key"])
        entries.append((identity, row))
        by_cell[(identity["cohort"], identity["leadBand"])].append(
            (identity, row)
        )
    # preserve stable key order inside every cell
    for key in by_cell:
        by_cell[key].sort(key=lambda entry: entry[0]["key"])
    return PreparedRows(entries, by_cell)


# select only embargoed earlier labels for one model cell
def training_rows(rows, month, selected_cohort, selected_band):
    """select one cohort-band's causally earlier fitting rows"""
    # require a declared cohort
    if selected_cohort not in COHORTS:
        raise ValueError("unsupported forecast cohort")
    # require a literal band
    if selected_band not in {band[0] for band in LEAD_BANDS}:
        raise ValueError("unsupported lead band")
    cutoff = month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    selected = []
    prepared = rows if isinstance(rows, PreparedRows) else prepare_training_rows(rows)
    entries = prepared.by_cell.get((selected_cohort, selected_band), ())
    # filter the indexed cell before reading labels
    for identity, row in entries:
        # isolate cohort, literal band, and earlier valid labels
        if identity["validAt"] < cutoff:
            actual_humidity(row)
            selected.append(row)
    return selected


# balance forecasts within hours and hours within local dates
def balanced_weights(rows):
    """give every represented valid hour and local date equal fitting mass"""
    hours_by_date = collections.defaultdict(set)
    events_by_hour = collections.Counter()
    # count unique valid hours within each local date
    for row in rows:
        valid_at = instant(row["validAt"])
        local_date = valid_at.astimezone(ZONE).date()
        hours_by_date[local_date].add(valid_at)
        events_by_hour[valid_at] += 1
    result = []
    # split date mass equally across hours then forecasts
    for row in rows:
        valid_at = instant(row["validAt"])
        local_date = valid_at.astimezone(ZONE).date()
        result.append(
            1 / (len(hours_by_date[local_date]) * events_by_hour[valid_at])
        )
    return np.asarray(result, dtype=np.float64)


# compute one deterministic weighted median
def weighted_median(values, weights):
    """return a stable lower weighted median"""
    values_array = np.asarray(values, dtype=np.float64)
    weights_array = np.asarray(weights, dtype=np.float64)
    # reject malformed estimator inputs
    if (
        len(values_array) == 0
        or values_array.shape != weights_array.shape
        or not np.isfinite(values_array).all()
        or not np.isfinite(weights_array).all()
        or np.any(weights_array <= 0)
    ):
        raise ValueError("weighted median requires finite values and positive weights")
    order = np.argsort(values_array, kind="stable")
    index = np.searchsorted(
        np.cumsum(weights_array[order]), weights_array.sum() / 2, side="left"
    )
    return float(values_array[order[min(index, len(order) - 1)]])


# compute Kish effective support
def effective_count(weights):
    """return the scale-invariant effective event count"""
    values = np.asarray(weights, dtype=np.float64)
    # preserve empty support
    if len(values) == 0:
        return 0.0
    return float(values.sum() ** 2 / np.square(values).sum())


# compute Kish support after collapsing repeated forecast vintages
def effective_valid_hour_count(rows, weights):
    """measure independent valid-hour support under date balancing"""
    if len(rows) != len(weights):
        raise ValueError("rows and weights must have equal length")
    hourly_weights = collections.defaultdict(float)
    # aggregate every repeated forecast to its shared valid hour
    for row, weight in zip(rows, weights, strict=True):
        hourly_weights[instant(row["validAt"])] += float(weight)
    return effective_count(list(hourly_weights.values()))


# derive only smooth forecast-time humidity predictors
def features(row):
    """build the frozen ridge feature vector"""
    identity = forecast_identity(row)
    local = identity["validAt"].astimezone(ZONE)
    year_start = dt.date(local.year, 1, 1)
    year_days = (dt.date(local.year + 1, 1, 1) - year_start).days
    annual = (
        2
        * math.pi
        * ((local.date() - year_start).days + local.hour / 24)
        / year_days
    )
    daily = 2 * math.pi * local.hour / 24
    annual_basis = [
        math.sin(annual),
        math.cos(annual),
        math.sin(2 * annual),
        math.cos(2 * annual),
    ]
    daily_basis = [
        math.sin(daily),
        math.cos(daily),
        math.sin(2 * daily),
        math.cos(2 * daily),
    ]
    raw_humidity = (identity["rawHumidity"] - 75) / 25
    temperature_missing = row.get("rawTemperatureC") is None
    wind_missing = row.get("rawWindSpeedMps") is None
    temperature = (
        0.0 if temperature_missing else (number(row["rawTemperatureC"]) - 10) / 10
    )
    wind = 0.0 if wind_missing else (number(row["rawWindSpeedMps"]) - 2) / 3
    interactions = [a * d for a in annual_basis[:2] for d in daily_basis[:2]]
    result = np.asarray(
        [
            1.0,
            *annual_basis,
            *daily_basis,
            *interactions,
            raw_humidity,
            raw_humidity * raw_humidity,
            temperature,
            wind,
            float(temperature_missing),
            float(wind_missing),
            raw_humidity * daily_basis[0],
            raw_humidity * daily_basis[1],
            temperature * daily_basis[0],
            temperature * daily_basis[1],
            wind * daily_basis[0],
            wind * daily_basis[1],
        ],
        dtype=np.float64,
    )
    # reject unstable feature material
    if not np.isfinite(result).all():
        raise ValueError("non-finite humidity feature vector")
    return result


# fit one shrunk robust hierarchy cell
def fit_hierarchy_cell(rows, parent, minimum_effective_events, pseudocount):
    """fit a weighted median residual around one parent"""
    weights = balanced_weights(rows)
    support = effective_valid_hour_count(rows, weights)
    # inherit below the support floor
    if support < minimum_effective_events:
        return None
    residuals = np.asarray(
        [
            actual_humidity(row)
            - number(row["rawRelativeHumidityPercent"])
            for row in rows
        ],
        dtype=np.float64,
    )
    raw = weighted_median(residuals, weights)
    alpha = support / (support + pseudocount)
    coefficient = max(
        -POLICY["maximumCorrectionPercentagePoints"],
        min(
            POLICY["maximumCorrectionPercentagePoints"],
            parent + alpha * (raw - parent),
        ),
    )
    return {
        "coefficient": coefficient,
        "effectiveEvents": support,
        "rawCoefficient": raw,
    }


# fit the frozen root, season/daypart, and month/daypart hierarchy
def fit_hierarchy(rows):
    """fit one existing-style robust residual hierarchy"""
    hierarchy = POLICY["hierarchy"]
    root = fit_hierarchy_cell(
        rows,
        0.0,
        hierarchy["root"]["minimumEffectiveEvents"],
        hierarchy["root"]["pseudocount"],
    )
    # preserve an unsupported root
    if root is None:
        return None
    coefficients = [
        {
            "level": 1,
            "season": None,
            "month": None,
            "daypart": None,
            **root,
        }
    ]
    season_groups = collections.defaultdict(list)
    month_groups = collections.defaultdict(list)
    # group by the frozen local calendar
    for row in rows:
        cell = calendar(row)
        season_groups[(cell["season"], cell["daypart"])].append(row)
        month_groups[(cell["month"], cell["daypart"])].append(row)
    season_coefficients = {}
    # fit deterministic season/daypart children
    for key in sorted(season_groups):
        cell = fit_hierarchy_cell(
            season_groups[key],
            root["coefficient"],
            hierarchy["seasonDaypart"]["minimumEffectiveEvents"],
            hierarchy["seasonDaypart"]["pseudocount"],
        )
        # emit only supported children
        if cell is not None:
            season_coefficients[key] = cell["coefficient"]
            coefficients.append(
                {
                    "level": 2,
                    "season": key[0],
                    "month": None,
                    "daypart": key[1],
                    **cell,
                }
            )
    # fit deterministic month/daypart children
    for key in sorted(month_groups):
        parent = season_coefficients.get(
            (SEASONS[key[0]], key[1]), root["coefficient"]
        )
        cell = fit_hierarchy_cell(
            month_groups[key],
            parent,
            hierarchy["monthDaypart"]["minimumEffectiveEvents"],
            hierarchy["monthDaypart"]["pseudocount"],
        )
        # emit only supported children
        if cell is not None:
            coefficients.append(
                {
                    "level": 3,
                    "season": None,
                    "month": key[0],
                    "daypart": key[1],
                    **cell,
                }
            )
    return coefficients


# fit one fixed-iteration Huber ridge vector
def fit_ridge(rows, weights):
    """fit the smooth residual challenger"""
    matrix = np.stack([features(row) for row in rows])
    residuals = np.asarray(
        [
            actual_humidity(row)
            - number(row["rawRelativeHumidityPercent"])
            for row in rows
        ],
        dtype=np.float64,
    )
    penalty = (
        np.eye(matrix.shape[1], dtype=np.float64)
        * POLICY["ridgeMeanLossPenalty"]
        * weights.sum()
    )
    penalty[0, 0] = 0
    coefficients = np.zeros(matrix.shape[1], dtype=np.float64)
    # run the preregistered robust updates
    for _ in range(POLICY["iterations"]):
        errors = residuals - matrix @ coefficients
        robust = np.minimum(
            1.0,
            POLICY["huberDeltaPercentagePoints"]
            / np.maximum(np.abs(errors), 1e-12),
        )
        effective = weights * robust
        coefficients = np.linalg.solve(
            matrix.T @ (matrix * effective[:, None]) + penalty,
            matrix.T @ (effective * residuals),
        )
    # reject unstable fits
    if not np.isfinite(coefficients).all():
        raise ValueError("non-finite fitted humidity coefficients")
    return coefficients.tolist()


# fit one frozen monthly cohort-band model without score feedback
def fit(rows, month, selected_cohort, selected_band):
    """fit all preregistered humidity candidates"""
    selected = training_rows(rows, month, selected_cohort, selected_band)
    dates = {calendar(row)["localDate"] for row in selected}
    supported = (
        len(selected) >= POLICY["minimumTrainingRows"]
        and len(dates) >= POLICY["minimumTrainingDates"]
    )
    cutoff = month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    model = {
        "contractVersion": POLICY["contractVersion"],
        "month": month,
        "cohort": selected_cohort,
        "leadBand": selected_band,
        "supported": supported,
        "trainingRows": len(selected),
        "trainingDates": len(dates),
        "trainingCutoffUtc": format_instant(cutoff),
        "firstTrainingValidAt": min(
            (row["validAt"] for row in selected), default=None
        ),
        "lastTrainingValidAt": max(
            (row["validAt"] for row in selected), default=None
        ),
        "medianOffsetPercentagePoints": None,
        "hierarchyCoefficients": None,
        "ridgeCoefficients": None,
    }
    # preserve raw predictions through unsupported cold starts
    if not supported:
        return model
    weights = balanced_weights(selected)
    residuals = np.asarray(
        [
            actual_humidity(row)
            - number(row["rawRelativeHumidityPercent"])
            for row in selected
        ],
        dtype=np.float64,
    )
    model["medianOffsetPercentagePoints"] = weighted_median(residuals, weights)
    model["hierarchyCoefficients"] = fit_hierarchy(selected)
    model["ridgeCoefficients"] = fit_ridge(selected, weights)
    # require a supported hierarchy root
    if model["hierarchyCoefficients"] is None:
        raise ValueError("supported population did not fit a hierarchy root")
    return model


# select the deepest matching hierarchy correction
def hierarchy_correction(row, coefficients):
    """select month, season, or root correction"""
    cell = calendar(row)
    root = next(item for item in coefficients if item["level"] == 1)
    season = next(
        (
            item
            for item in coefficients
            if item["level"] == 2
            and item["season"] == cell["season"]
            and item["daypart"] == cell["daypart"]
        ),
        None,
    )
    month = next(
        (
            item
            for item in coefficients
            if item["level"] == 3
            and item["month"] == cell["month"]
            and item["daypart"] == cell["daypart"]
        ),
        None,
    )
    return number(
        (month or season or root)["coefficient"]
    )


# apply one capped correction and physical humidity clamp
def adjusted(raw, correction):
    """apply a bounded humidity correction"""
    bounded = max(
        -POLICY["maximumCorrectionPercentagePoints"],
        min(POLICY["maximumCorrectionPercentagePoints"], number(correction)),
    )
    return max(
        POLICY["physicalMinimumPercent"],
        min(POLICY["physicalMaximumPercent"], number(raw) + bounded),
    )


# predict all frozen candidates from one exact model cell
def predict_from_model(row, model):
    """apply one already-validated model state"""
    identity = forecast_identity(row)
    raw = identity["rawHumidity"]
    result = {candidate: raw for candidate in CANDIDATES}
    # preserve every cold-start row as raw
    if not model["supported"]:
        return result
    result["medianBias"] = adjusted(
        raw, model["medianOffsetPercentagePoints"]
    )
    result["hierarchy"] = adjusted(
        raw, hierarchy_correction(row, model["hierarchyCoefficients"])
    )
    ridge_residual = float(
        features(row) @ np.asarray(model["ridgeCoefficients"], dtype=np.float64)
    )
    result["ridge"] = adjusted(
        raw, POLICY["correctionWeight"] * ridge_residual
    )
    return result


# predict natively from one exact cohort-band model
def predict(row, model):
    """predict raw, median, hierarchy, and ridge humidity"""
    identity = forecast_identity(row)
    # require the frozen contract
    if model["contractVersion"] != POLICY["contractVersion"]:
        raise ValueError("humidity model contract does not match")
    # bind the issue month
    if model["month"] != issue_month(row):
        raise ValueError("forecast issue month does not match model")
    # bind the forecast cohort
    if model["cohort"] != identity["cohort"]:
        raise ValueError("forecast cohort does not match model")
    # bind the literal band
    if model["leadBand"] != identity["leadBand"]:
        raise ValueError("forecast lead band does not match model")
    return predict_from_model(row, model)


# define the source model for one preregistered transfer row
def transfer_source(row, transfer):
    """return one labeled non-refit source cohort and band"""
    identity = forecast_identity(row)
    local_date = calendar(row)["localDate"]
    # map the bounded same-band transfer
    if transfer == "ecmwf_to_best_match":
        # enforce its target population
        if (
            identity["cohort"] != "best_match_single_run_transfer"
            or not POLICY["bestMatchTransferStartLocalDate"]
            <= local_date
            <= POLICY["bestMatchTransferEndLocalDate"]
            or lead_hours(row) > 48
        ):
            raise ValueError("row is outside the ECMWF to Best Match transfer")
        return "ecmwf_single_run_hindcast", identity["leadBand"]
    # map one-through-twenty-four hours
    if transfer == "fixed_anchor_24h_to_legacy_v4":
        # enforce its target population
        if (
            identity["cohort"] != "legacy_v4_retrieval_snapshot"
            or not 1 <= lead_hours(row) <= 24
        ):
            raise ValueError("row is outside the fixed 24h to live-v4 transfer")
        return "fixed_lead_anchor", "013-024"
    # map twenty-five-through-forty-eight hours
    if transfer == "fixed_anchor_48h_to_legacy_v4":
        # enforce its target population
        if (
            identity["cohort"] != "legacy_v4_retrieval_snapshot"
            or not 25 <= lead_hours(row) <= 48
        ):
            raise ValueError("row is outside the fixed 48h to live-v4 transfer")
        return "fixed_lead_anchor", "025-048"
    raise ValueError("unsupported humidity transfer")


# apply a source model without refitting on the target cohort
def predict_transfer(row, model, transfer):
    """predict one explicitly labeled cross-cohort transfer"""
    source_cohort, source_band = transfer_source(row, transfer)
    # require the frozen contract
    if model["contractVersion"] != POLICY["contractVersion"]:
        raise ValueError("humidity model contract does not match")
    # bind the issue month
    if model["month"] != issue_month(row):
        raise ValueError("forecast issue month does not match transfer model")
    # bind the declared source state
    if model["cohort"] != source_cohort or model["leadBand"] != source_band:
        raise ValueError("transfer source model does not match")
    return predict_from_model(row, model)


# score one fixed record population with equal-hour then equal-date weight
def score(records, prediction_fields=CANDIDATES):
    """score humidity predictions under the frozen primary denominator"""
    # preserve empty populations
    if not records:
        return None
    seen = set()
    actual_by_hour = {}
    grouped = collections.defaultdict(lambda: collections.defaultdict(list))
    # validate identities and shared physical labels
    for row in records:
        key = row.get("key")
        # require unique durable identities
        if not isinstance(key, str) or not key or key in seen:
            raise ValueError("duplicate or invalid score key")
        seen.add(key)
        valid_at = format_instant(instant(row["validAt"]))
        actual = actual_humidity(row)
        # reject contradictory shared labels
        if valid_at in actual_by_hour and actual_by_hour[valid_at] != actual:
            raise ValueError("conflicting actual for shared valid hour")
        actual_by_hour[valid_at] = actual
        local_date = calendar(row)["localDate"]
        grouped[local_date][valid_at].append(row)
    result = {
        "events": len(records),
        "dates": len(grouped),
        "validHours": sum(len(hours) for hours in grouped.values()),
        "predictions": {},
    }
    # reuse identical event, hour, and date populations
    for field in prediction_fields:
        daily_absolute = []
        daily_bias = []
        daily_large = []
        hourly_absolute = []
        hourly_bias = []
        # average repeated forecasts before local dates
        for hours in grouped.values():
            day_absolute = []
            day_bias = []
            day_large = []
            # average each shared valid hour first
            for events in hours.values():
                errors = [
                    number(row[field]) - actual_humidity(row) for row in events
                ]
                hour_absolute = float(np.mean(np.abs(errors)))
                hour_bias = float(np.mean(errors))
                day_absolute.append(hour_absolute)
                day_bias.append(hour_bias)
                day_large.append(float(np.mean(np.abs(errors) > 10)))
                hourly_absolute.append(hour_absolute)
                hourly_bias.append(hour_bias)
            daily_absolute.append(float(np.mean(day_absolute)))
            daily_bias.append(float(np.mean(day_bias)))
            daily_large.append(float(np.mean(day_large)))
        result["predictions"][field] = {
            "equalDateMaePercentagePoints": float(np.mean(daily_absolute)),
            "equalDateBiasPercentagePoints": float(np.mean(daily_bias)),
            "equalHourMaePercentagePoints": float(np.mean(hourly_absolute)),
            "equalHourBiasPercentagePoints": float(np.mean(hourly_bias)),
            "equalDateFractionAbove10PercentagePoints": float(
                np.mean(daily_large)
            ),
        }
    return result


# group scored rows into the requested aggregate dimensions
def grouped_scores(records):
    """return month, season, lead-band, and local-date summaries"""
    dimensions = {
        "cohort": collections.defaultdict(list),
        "cohortLeadBand": collections.defaultdict(list),
        "cohortMonth": collections.defaultdict(list),
        "cohortSeason": collections.defaultdict(list),
        "month": collections.defaultdict(list),
        "season": collections.defaultdict(list),
        "leadBand": collections.defaultdict(list),
        "localDate": collections.defaultdict(list),
    }
    # attach every row to each frozen aggregate dimension
    for row in records:
        cell = calendar(row)
        dimensions["cohort"][cohort(row)].append(row)
        dimensions["cohortLeadBand"][
            f"{cohort(row)}:{lead_band(row)}"
        ].append(row)
        dimensions["cohortMonth"][
            f"{cohort(row)}:{cell['localDate'][:7]}"
        ].append(row)
        dimensions["cohortSeason"][
            f"{cohort(row)}:{cell['season']}"
        ].append(row)
        dimensions["month"][cell["localDate"][:7]].append(row)
        dimensions["season"][cell["season"]].append(row)
        dimensions["leadBand"][lead_band(row)].append(row)
        dimensions["localDate"][cell["localDate"]].append(row)
    # score groups without row details
    return {
        dimension: {
            key: score(grouped[key]) for key in sorted(grouped)
        }
        for dimension, grouped in dimensions.items()
    }


# create one private file without overwriting prior predictions
def write_private_predictions(path, records):
    """write row-level predictions with owner-only permissions"""
    destination = Path(path)
    # require an explicit private destination
    if not destination.is_absolute():
        raise ValueError("private prediction path must be absolute")
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    # stream canonical json lines into the exclusive file
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        for record in records:
            output.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            output.write("\n")


# select a preregistered transfer for one target row
def transfer_for_row(row):
    """return the applicable non-refit transfer label or null"""
    identity = forecast_identity(row)
    local_date = calendar(row)["localDate"]
    # select the bounded Best Match transfer
    if (
        identity["cohort"] == "best_match_single_run_transfer"
        and POLICY["bestMatchTransferStartLocalDate"]
        <= local_date
        <= POLICY["bestMatchTransferEndLocalDate"]
        and lead_hours(row) <= 48
    ):
        return "ecmwf_to_best_match"
    # select the fixed twenty-four-hour state
    if (
        identity["cohort"] == "legacy_v4_retrieval_snapshot"
        and lead_hours(row) <= 24
    ):
        return "fixed_anchor_24h_to_legacy_v4"
    # select the fixed forty-eight-hour state
    if (
        identity["cohort"] == "legacy_v4_retrieval_snapshot"
        and lead_hours(row) <= 48
    ):
        return "fixed_anchor_48h_to_legacy_v4"
    return None


# stream private native and transfer prediction receipts
def private_prediction_records(predictions, transfer_predictions, models):
    """yield row-level evidence without retaining a duplicate list"""
    # emit native predictions first
    for row in predictions:
        model_key = (issue_month(row), cohort(row), lead_band(row))
        model = models[model_key]
        boundary, boundary_kind = issue_boundary(row)
        yield {
            "recordKind": "native",
            "key": row["key"],
            "validAt": row["validAt"],
            "referenceAt": row.get("referenceAt"),
            "issueBoundary": format_instant(boundary),
            "issueBoundaryKind": boundary_kind,
            "issueMonth": model_key[0],
            "cohort": model_key[1],
            "leadBand": model_key[2],
            "actualRelativeHumidityPercent": actual_humidity(row),
            "predictions": {candidate: row[candidate] for candidate in CANDIDATES},
            "modelSupported": model["supported"],
            "trainingCutoffUtc": model["trainingCutoffUtc"],
        }
    # emit explicitly labeled transfers second
    for transfer in TRANSFERS:
        for row in transfer_predictions[transfer]:
            source_cohort, source_band = transfer_source(row, transfer)
            source_key = (issue_month(row), source_cohort, source_band)
            source_model = models[source_key]
            boundary, boundary_kind = issue_boundary(row)
            yield {
                "recordKind": "transfer",
                "transfer": transfer,
                "sourceCohort": source_cohort,
                "sourceLeadBand": source_band,
                "targetCohort": cohort(row),
                "targetLeadBand": lead_band(row),
                "key": row["key"],
                "validAt": row["validAt"],
                "referenceAt": row.get("referenceAt"),
                "issueBoundary": format_instant(boundary),
                "issueBoundaryKind": boundary_kind,
                "issueMonth": source_key[0],
                "actualRelativeHumidityPercent": actual_humidity(row),
                "predictions": {
                    candidate: row[candidate] for candidate in CANDIDATES
                },
                "modelSupported": source_model["supported"],
                "trainingCutoffUtc": source_model["trainingCutoffUtc"],
            }


# run the frozen research evaluation without model selection
def evaluate(rows, private_predictions_path):
    """fit monthly models, retain private rows, and return aggregates"""
    prepared = prepare_training_rows(rows)
    score_rows = []
    # select only the frozen complete and partial evaluation dates
    for identity, row in prepared.entries:
        local_date = calendar(row)["localDate"]
        # retain only the frozen score epoch
        if (
            POLICY["completeEvaluationStartLocalDate"]
            <= local_date
            <= POLICY["partialEvaluationEndLocalDate"]
        ):
            actual_humidity(row)
            score_rows.append(row)
    models = {}
    # fit each required issue-month, cohort, and literal lead-band cell once
    for row in score_rows:
        key = (issue_month(row), cohort(row), lead_band(row))
        # fit each native cell once
        if key not in models:
            models[key] = fit(prepared, *key)
        transfer = transfer_for_row(row)
        # fit the declared source state without target-cohort pooling
        if transfer is not None:
            source_cohort, source_band = transfer_source(row, transfer)
            source_key = (issue_month(row), source_cohort, source_band)
            # fit each transfer source once
            if source_key not in models:
                models[source_key] = fit(prepared, *source_key)
    predictions = []
    transfer_predictions = {transfer: [] for transfer in TRANSFERS}
    # predict every score row including unsupported cold starts
    for row in score_rows:
        model_key = (issue_month(row), cohort(row), lead_band(row))
        model = models[model_key]
        values = predict(row, model)
        scored = {**row, **values}
        predictions.append(scored)
        transfer = transfer_for_row(row)
        # score transfers in a separate denominator
        if transfer is not None:
            source_cohort, source_band = transfer_source(row, transfer)
            source_key = (issue_month(row), source_cohort, source_band)
            source_model = models[source_key]
            transfer_values = predict_transfer(row, source_model, transfer)
            transfer_scored = {**row, **transfer_values}
            transfer_predictions[transfer].append(transfer_scored)
    write_private_predictions(
        private_predictions_path,
        private_prediction_records(predictions, transfer_predictions, models),
    )
    complete = [
        row
        for row in predictions
        if calendar(row)["localDate"]
        <= POLICY["completeEvaluationEndLocalDate"]
    ]
    partial = [
        row
        for row in predictions
        if calendar(row)["localDate"]
        >= POLICY["partialEvaluationStartLocalDate"]
    ]
    complete_by_cohort = collections.defaultdict(list)
    partial_by_cohort = collections.defaultdict(list)
    # keep native score claims cohort-specific
    for row in complete:
        complete_by_cohort[cohort(row)].append(row)
    # keep partial score claims cohort-specific
    for row in partial:
        partial_by_cohort[cohort(row)].append(row)
    model_summary = []
    # expose support receipts without private row identities
    for key in sorted(models):
        model = models[key]
        model_summary.append(
            {
                "issueMonth": key[0],
                "cohort": key[1],
                "leadBand": key[2],
                "supported": model["supported"],
                "trainingRows": model["trainingRows"],
                "trainingDates": model["trainingDates"],
                "trainingCutoffUtc": model["trainingCutoffUtc"],
            }
        )
    return {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "candidateSelection": "none_preregistered_all_reported",
        "modelSupport": model_summary,
        "completeMonths": {
            "period": [
                POLICY["completeEvaluationStartLocalDate"],
                POLICY["completeEvaluationEndLocalDate"],
            ],
            "byCohort": {
                key: score(complete_by_cohort[key])
                for key in sorted(complete_by_cohort)
            },
            "groups": grouped_scores(complete),
        },
        "partialSeptember": {
            "period": [
                POLICY["partialEvaluationStartLocalDate"],
                POLICY["partialEvaluationEndLocalDate"],
            ],
            "byCohort": {
                key: score(partial_by_cohort[key])
                for key in sorted(partial_by_cohort)
            },
            "groups": grouped_scores(partial),
        },
        "transfers": {
            transfer: {
                "sourceFitReusedWithoutRefit": True,
                "completeMonths": {
                    "overall": score(
                        [
                            row
                            for row in transfer_predictions[transfer]
                            if calendar(row)["localDate"]
                            <= POLICY["completeEvaluationEndLocalDate"]
                        ]
                    ),
                    "groups": grouped_scores(
                        [
                            row
                            for row in transfer_predictions[transfer]
                            if calendar(row)["localDate"]
                            <= POLICY["completeEvaluationEndLocalDate"]
                        ]
                    ),
                },
                "partialSeptember": {
                    "overall": score(
                        [
                            row
                            for row in transfer_predictions[transfer]
                            if calendar(row)["localDate"]
                            >= POLICY["partialEvaluationStartLocalDate"]
                        ]
                    ),
                    "groups": grouped_scores(
                        [
                            row
                            for row in transfer_predictions[transfer]
                            if calendar(row)["localDate"]
                            >= POLICY["partialEvaluationStartLocalDate"]
                        ]
                    ),
                },
            }
            for transfer in TRANSFERS
        },
    }


# run one strict json request for the parent research driver
def main():
    """read model-ready rows and emit aggregate json"""
    request = json.load(sys.stdin)
    # require the exact request shape
    if not isinstance(request, dict) or set(request) != {
        "rows",
        "privatePredictionsPath",
    }:
        raise ValueError("request keys do not match humidity research contract")
    # require row objects inside one list
    if not isinstance(request["rows"], list):
        raise ValueError("rows must be a list")
    report = evaluate(request["rows"], request["privatePredictionsPath"])
    json.dump(report, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


# keep import side effects disabled
if __name__ == "__main__":
    main()
