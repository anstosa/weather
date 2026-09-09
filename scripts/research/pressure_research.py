#!/usr/bin/env python3
"""Research-only causal station-pressure calibration."""

from __future__ import annotations

import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import sys

# keep numerical fitting deterministic
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import numpy as np

import humidity_research as shared


COHORTS = shared.COHORTS
LEAD_BANDS = shared.LEAD_BANDS
CANDIDATES = ("raw", "stationOffset", "ridge")
TEMPEST_V2_STATIONS = (
    "tempest-126537",
    "tempest-168853",
    "tempest-201058",
    "tempest-203055",
    "tempest-225947",
    "tempest-38270",
    "tempest-64255",
)
TRANSFER = "ecmwf_to_best_match"
POLICY = {
    "contractVersion": "pressure-causal-research/v1",
    "targetObservationContract": "tempest-v2-absolute-station-pressure-only",
    "embargoHours": 168,
    "minimumTrainingDatesPerStation": 180,
    "minimumTrainingRowsPerStation": 1000,
    "correctionWeight": 0.5,
    "maximumResidualCorrectionHpa": 3.0,
    "ridgeMeanLossPenalty": 0.1,
    "huberDeltaHpa": 1.5,
    "iterations": 8,
    "minimumPressureHpa": 300.0,
    "maximumPressureHpa": 1100.0,
    "elevationCompatibilityToleranceM": 1.0,
    "rapidChangeThresholdHpa": 2.0,
    "completeEvaluationStartLocalDate": "2025-01-01",
    "completeEvaluationEndLocalDate": "2026-08-31",
    "partialEvaluationStartLocalDate": "2026-09-01",
    "partialEvaluationEndLocalDate": "2026-09-06",
    "bestMatchTransferStartLocalDate": "2026-04-02",
    "bestMatchTransferEndLocalDate": "2026-09-06",
    "productionEligible": False,
}


# require a Tempest-v2 absolute-pressure target station
def station_key(row):
    """validate one eligible absolute-pressure station"""
    value = row.get("stationKey")
    # reject relative-pressure and unknown providers
    if value not in TEMPEST_V2_STATIONS:
        raise ValueError("pressure target must be an eligible Tempest-v2 station")
    return value


# require one bounded absolute pressure
def pressure(value, label):
    """validate one absolute station-pressure value"""
    parsed = shared.number(value)
    # enforce broad physical station-pressure limits
    if not POLICY["minimumPressureHpa"] <= parsed <= POLICY["maximumPressureHpa"]:
        raise ValueError(f"{label} is outside physical bounds")
    return parsed


# validate one optional finite predictor
def optional_number(value):
    """return null or one finite number"""
    # preserve missing forecast predictors
    if value is None:
        return None
    return shared.number(value)


# validate fields available before the observed outcome
def forecast_identity(row):
    """validate one model-ready pressure forecast"""
    common = shared.forecast_identity(row)
    station = station_key(row)
    raw = pressure(row["rawPressureHpa"], "raw pressure")
    # validate optional covariates
    for field in (
        "rawTemperatureC",
        "rawRelativeHumidityPercent",
        "rawWindSpeedMps",
        "forecastElevationM",
        "forecastPressureChange3h",
    ):
        optional_number(row.get(field))
    return {**common, "stationKey": station, "rawPressureHpa": raw}


# validate one absolute pressure label
def actual_pressure(row):
    """return the observed Tempest-v2 station pressure"""
    station_key(row)
    return pressure(row["actualPressureHpa"], "actual pressure")


# hold one validated pressure training index
class PreparedRows:
    """store rows by isolated forecast cohort and literal lead band"""

    # retain immutable-by-convention research inputs
    def __init__(self, entries, by_cell):
        """initialize one internal pressure index"""
        self.entries = entries
        self.by_cell = by_cell


# validate the full pressure input once before monthly fits
def prepare_training_rows(rows):
    """index model-ready rows without reading pressure labels"""
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
    # preserve stable key order within every cell
    for key in by_cell:
        by_cell[key].sort(key=lambda entry: entry[0]["key"])
    return PreparedRows(entries, by_cell)


# select only embargoed earlier labels for one cohort-band model
def training_rows(rows, month, selected_cohort, selected_band):
    """select causal station-pressure training rows"""
    # require a declared cohort
    if selected_cohort not in COHORTS:
        raise ValueError("unsupported forecast cohort")
    # require a literal band
    if selected_band not in {band[0] for band in LEAD_BANDS}:
        raise ValueError("unsupported lead band")
    cutoff = shared.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    selected = []
    prepared = rows if isinstance(rows, PreparedRows) else prepare_training_rows(rows)
    entries = prepared.by_cell.get((selected_cohort, selected_band), ())
    # filter the indexed cell before reading labels
    for identity, row in entries:
        # isolate cohort, band, and earlier valid labels
        if identity["validAt"] < cutoff:
            actual_pressure(row)
            optional_number(row.get("actualPressureChange3h"))
            selected.append(row)
    return sorted(selected, key=lambda row: row["key"])


# balance hours and dates inside one station
def station_date_weights(rows):
    """give every station-date equal mass within its station"""
    hours_by_date = collections.defaultdict(set)
    events_by_hour = collections.Counter()
    # count station-local date and valid-hour support
    for row in rows:
        identity = forecast_identity(row)
        local_date = shared.calendar(row)["localDate"]
        hour = (identity["stationKey"], identity["validAt"])
        hours_by_date[(identity["stationKey"], local_date)].add(hour)
        events_by_hour[hour] += 1
    weights = []
    # split each station-date across hours and forecasts
    for row in rows:
        identity = forecast_identity(row)
        local_date = shared.calendar(row)["localDate"]
        date_key = (identity["stationKey"], local_date)
        hour = (identity["stationKey"], identity["validAt"])
        weights.append(1 / (len(hours_by_date[date_key]) * events_by_hour[hour]))
    return np.asarray(weights, dtype=np.float64)


# balance every station after its internal date weighting
def equal_station_date_weights(rows):
    """give each represented station equal total pooled fitting mass"""
    by_station = collections.Counter(station_key(row) for row in rows)
    base = station_date_weights(rows)
    station_totals = collections.defaultdict(float)
    # sum internal date mass by station
    for row, weight in zip(rows, base, strict=True):
        station_totals[station_key(row)] += float(weight)
    result = []
    # normalize every station to total mass one
    for row, weight in zip(rows, base, strict=True):
        station = station_key(row)
        result.append(float(weight) / station_totals[station])
    # guard the nonempty counter use
    if rows and len(by_station) != len(station_totals):
        raise AssertionError("station weighting lost a station")
    return np.asarray(result, dtype=np.float64)


# derive smooth forecast-time pressure predictors
def features(row):
    """build the frozen pooled residual feature vector"""
    identity = forecast_identity(row)
    local = identity["validAt"].astimezone(shared.ZONE)
    year_start = dt.date(local.year, 1, 1)
    year_days = (dt.date(local.year + 1, 1, 1) - year_start).days
    annual = (
        2
        * math.pi
        * ((local.date() - year_start).days + local.hour / 24)
        / year_days
    )
    daily = 2 * math.pi * local.hour / 24
    raw_pressure = (identity["rawPressureHpa"] - 1000) / 20
    temperature_value = optional_number(row.get("rawTemperatureC"))
    humidity_value = optional_number(row.get("rawRelativeHumidityPercent"))
    tendency_value = optional_number(row.get("forecastPressureChange3h"))
    temperature = 0.0 if temperature_value is None else (temperature_value - 10) / 10
    humidity = 0.0 if humidity_value is None else (humidity_value - 75) / 25
    tendency = 0.0 if tendency_value is None else tendency_value / 3
    result = np.asarray(
        [
            1.0,
            math.sin(annual),
            math.cos(annual),
            math.sin(2 * annual),
            math.cos(2 * annual),
            math.sin(daily),
            math.cos(daily),
            math.sin(2 * daily),
            math.cos(2 * daily),
            raw_pressure,
            raw_pressure * raw_pressure,
            temperature,
            humidity,
            tendency,
            float(temperature_value is None),
            float(humidity_value is None),
            float(tendency_value is None),
            raw_pressure * math.sin(daily),
            raw_pressure * math.cos(daily),
            tendency * math.sin(daily),
            tendency * math.cos(daily),
        ],
        dtype=np.float64,
    )
    # reject unstable feature material
    if not np.isfinite(result).all():
        raise ValueError("non-finite pressure feature vector")
    return result


# count local dates for one station population
def local_date_count(rows):
    """count represented local dates"""
    return len({shared.calendar(row)["localDate"] for row in rows})


# determine one station's independent support floor
def station_supported(rows):
    """require both station-local row and date floors"""
    return (
        len(rows) >= POLICY["minimumTrainingRowsPerStation"]
        and local_date_count(rows) >= POLICY["minimumTrainingDatesPerStation"]
    )


# derive one compatible source forecast elevation
def fitted_elevation(rows):
    """return one stable source elevation or null"""
    values = [
        optional_number(row.get("forecastElevationM"))
        for row in rows
        if row.get("forecastElevationM") is not None
    ]
    # require complete elevation evidence
    if len(values) != len(rows) or not values:
        return None
    # reject internally inconsistent source elevations
    if max(values) - min(values) > POLICY["elevationCompatibilityToleranceM"]:
        return None
    return float(np.mean(values))


# fit one fixed-iteration Huber ridge residual vector
def fit_ridge(rows, station_offsets):
    """fit pooled residuals only after station-offset removal"""
    matrix = np.stack([features(row) for row in rows])
    residuals = np.asarray(
        [
            actual_pressure(row)
            - forecast_identity(row)["rawPressureHpa"]
            - station_offsets[station_key(row)]
            for row in rows
        ],
        dtype=np.float64,
    )
    weights = equal_station_date_weights(rows)
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
            POLICY["huberDeltaHpa"] / np.maximum(np.abs(errors), 1e-12),
        )
        effective = weights * robust
        coefficients = np.linalg.solve(
            matrix.T @ (matrix * effective[:, None]) + penalty,
            matrix.T @ (effective * residuals),
        )
    # reject unstable fits
    if not np.isfinite(coefficients).all():
        raise ValueError("non-finite fitted pressure coefficients")
    return coefficients.tolist()


# fit station offsets and pooled offset-removed residuals
def fit(rows, month, selected_cohort, selected_band):
    """fit one monthly cohort-band pressure state"""
    selected = training_rows(rows, month, selected_cohort, selected_band)
    by_station = collections.defaultdict(list)
    # isolate station levels before any pooling
    for row in selected:
        by_station[station_key(row)].append(row)
    stations = {}
    eligible = []
    # fit every station against its own support floor
    for station in sorted(by_station):
        station_rows = by_station[station]
        supported = station_supported(station_rows)
        offset = None
        # fit an earlier-only station alignment offset
        if supported:
            weights = station_date_weights(station_rows)
            residuals = [
                actual_pressure(row) - forecast_identity(row)["rawPressureHpa"]
                for row in station_rows
            ]
            offset = shared.weighted_median(residuals, weights)
            eligible.extend(station_rows)
        stations[station] = {
            "supported": supported,
            "trainingRows": len(station_rows),
            "trainingDates": local_date_count(station_rows),
            "offsetHpa": offset,
        }
    station_offsets = {
        station: value["offsetHpa"]
        for station, value in stations.items()
        if value["supported"]
    }
    cutoff = shared.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    model = {
        "contractVersion": POLICY["contractVersion"],
        "month": month,
        "cohort": selected_cohort,
        "leadBand": selected_band,
        "trainingCutoffUtc": shared.format_instant(cutoff),
        "stations": stations,
        "eligibleTrainingRows": len(eligible),
        "eligibleTrainingStations": len(station_offsets),
        "forecastElevationM": fitted_elevation(eligible),
        "ridgeCoefficients": None,
    }
    # preserve station cold starts when no station clears the floor
    if not eligible:
        return model
    model["ridgeCoefficients"] = fit_ridge(eligible, station_offsets)
    return model


# apply one station model without target refitting
def predict_from_model(row, model):
    """predict raw, station-aligned, and pooled-ridge pressure"""
    identity = forecast_identity(row)
    raw = identity["rawPressureHpa"]
    result = {candidate: raw for candidate in CANDIDATES}
    station = model["stations"].get(identity["stationKey"])
    # preserve raw for an unsupported target station
    if station is None or not station["supported"]:
        return result
    offset_prediction = raw + shared.number(station["offsetHpa"])
    result["stationOffset"] = offset_prediction
    residual = float(
        features(row) @ np.asarray(model["ridgeCoefficients"], dtype=np.float64)
    )
    residual_correction = max(
        -POLICY["maximumResidualCorrectionHpa"],
        min(
            POLICY["maximumResidualCorrectionHpa"],
            POLICY["correctionWeight"] * residual,
        ),
    )
    result["ridge"] = offset_prediction + residual_correction
    return result


# predict natively from an exact cohort-band state
def predict(row, model):
    """apply one matching native pressure model"""
    identity = forecast_identity(row)
    # require the frozen contract
    if model["contractVersion"] != POLICY["contractVersion"]:
        raise ValueError("pressure model contract does not match")
    # bind the issue month
    if model["month"] != shared.issue_month(row):
        raise ValueError("forecast issue month does not match model")
    # bind the cohort
    if model["cohort"] != identity["cohort"]:
        raise ValueError("forecast cohort does not match model")
    # bind the literal band
    if model["leadBand"] != identity["leadBand"]:
        raise ValueError("forecast lead band does not match model")
    return predict_from_model(row, model)


# test transfer elevation compatibility without imputing either side
def elevation_compatible(row, model):
    """return whether source and target forecast elevations agree"""
    target = optional_number(row.get("forecastElevationM"))
    source = model.get("forecastElevationM")
    # fail cold when either elevation is missing
    if target is None or source is None:
        return False
    return abs(target - shared.number(source)) <= POLICY[
        "elevationCompatibilityToleranceM"
    ]


# apply an ECMWF state to the bounded Best Match period without refitting
def predict_transfer(row, model):
    """run the single preregistered pressure transfer"""
    identity = forecast_identity(row)
    local_date = shared.calendar(row)["localDate"]
    # require the bounded transfer population
    if (
        identity["cohort"] != "best_match_single_run_transfer"
        or identity["leadBand"] not in {"001-012", "013-024", "025-048"}
        or not POLICY["bestMatchTransferStartLocalDate"]
        <= local_date
        <= POLICY["bestMatchTransferEndLocalDate"]
    ):
        raise ValueError("row is outside the pressure transfer population")
    # require the exact source model
    if (
        model["contractVersion"] != POLICY["contractVersion"]
        or model["month"] != shared.issue_month(row)
        or model["cohort"] != "ecmwf_single_run_hindcast"
        or model["leadBand"] != identity["leadBand"]
    ):
        raise ValueError("pressure transfer source model does not match")
    # preserve raw when forecast elevations are incompatible
    if not elevation_compatible(row, model):
        return {candidate: identity["rawPressureHpa"] for candidate in CANDIDATES}
    return predict_from_model(row, model)


# score levels with equal station, date, hour, and forecast mass
def score_levels(records, prediction_fields=CANDIDATES):
    """score absolute pressure levels under the frozen denominator"""
    # preserve empty populations
    if not records:
        return None
    seen = set()
    grouped = collections.defaultdict(
        lambda: collections.defaultdict(lambda: collections.defaultdict(list))
    )
    actual_by_station_hour = {}
    # validate identities and shared station-hour labels
    for row in records:
        identity = forecast_identity(row)
        # reject duplicate identities
        if identity["key"] in seen:
            raise ValueError("duplicate score key")
        seen.add(identity["key"])
        actual = actual_pressure(row)
        station_hour = (identity["stationKey"], identity["validAt"])
        # reject contradictory station-hour labels
        if (
            station_hour in actual_by_station_hour
            and actual_by_station_hour[station_hour] != actual
        ):
            raise ValueError("conflicting actual for shared station hour")
        actual_by_station_hour[station_hour] = actual
        local_date = shared.calendar(row)["localDate"]
        grouped[identity["stationKey"]][local_date][identity["validAt"]].append(
            row
        )
    result = {
        "events": len(records),
        "stations": len(grouped),
        "dates": len(
            {
                (station, local_date)
                for station, dates in grouped.items()
                for local_date in dates
            }
        ),
        "validHours": sum(
            len(hours) for dates in grouped.values() for hours in dates.values()
        ),
        "predictions": {},
    }
    # score every candidate on the identical population
    for field in prediction_fields:
        station_mae = []
        station_bias = []
        station_mse = []
        # give each station equal final weight
        for dates in grouped.values():
            date_mae = []
            date_bias = []
            date_mse = []
            # give each station-date equal weight
            for hours in dates.values():
                hour_mae = []
                hour_bias = []
                hour_mse = []
                # average repeated forecasts within valid hours
                for events in hours.values():
                    errors = np.asarray(
                        [
                            shared.number(row[field]) - actual_pressure(row)
                            for row in events
                        ],
                        dtype=np.float64,
                    )
                    hour_mae.append(float(np.mean(np.abs(errors))))
                    hour_bias.append(float(np.mean(errors)))
                    hour_mse.append(float(np.mean(np.square(errors))))
                date_mae.append(float(np.mean(hour_mae)))
                date_bias.append(float(np.mean(hour_bias)))
                date_mse.append(float(np.mean(hour_mse)))
            station_mae.append(float(np.mean(date_mae)))
            station_bias.append(float(np.mean(date_bias)))
            station_mse.append(float(np.mean(date_mse)))
        result["predictions"][field] = {
            "equalStationDateMaeHpa": float(np.mean(station_mae)),
            "equalStationDateBiasHpa": float(np.mean(station_bias)),
            "equalStationDateRmseHpa": math.sqrt(float(np.mean(station_mse))),
        }
    baseline = result["predictions"].get("stationOffset")
    # report every candidate against the alignment baseline
    if baseline is not None:
        for metrics in result["predictions"].values():
            metrics["deltaMaeVsStationOffsetHpa"] = (
                metrics["equalStationDateMaeHpa"]
                - baseline["equalStationDateMaeHpa"]
            )
    return result


# summarize level scores by requested dimensions
def grouped_level_scores(records):
    """return month, season, band, and station level summaries"""
    dimensions = {
        "cohort": collections.defaultdict(list),
        "cohortLeadBand": collections.defaultdict(list),
        "cohortMonth": collections.defaultdict(list),
        "cohortSeason": collections.defaultdict(list),
        "month": collections.defaultdict(list),
        "season": collections.defaultdict(list),
        "leadBand": collections.defaultdict(list),
        "station": collections.defaultdict(list),
    }
    # attach each row to every aggregate dimension
    for row in records:
        cell = shared.calendar(row)
        dimensions["cohort"][shared.cohort(row)].append(row)
        dimensions["cohortLeadBand"][
            f"{shared.cohort(row)}:{shared.lead_band(row)}"
        ].append(row)
        dimensions["cohortMonth"][
            f"{shared.cohort(row)}:{cell['localDate'][:7]}"
        ].append(row)
        dimensions["cohortSeason"][
            f"{shared.cohort(row)}:{cell['season']}"
        ].append(row)
        dimensions["month"][cell["localDate"][:7]].append(row)
        dimensions["season"][cell["season"]].append(row)
        dimensions["leadBand"][shared.lead_band(row)].append(row)
        dimensions["station"][station_key(row)].append(row)
    # score groups without row identities
    return {
        dimension: {key: score_levels(group[key]) for key in sorted(group)}
        for dimension, group in dimensions.items()
    }


# classify one signed pressure change
def sign(value):
    """return minus one, zero, or plus one"""
    # classify falling pressure
    if value < 0:
        return -1
    # classify rising pressure
    if value > 0:
        return 1
    return 0


# score one paired-change population with station/date/hour balance
def balanced_change_metrics(pairs, field):
    """score paired changes with the same hierarchy as pressure levels"""
    # preserve empty paired populations
    if not pairs:
        return None
    grouped = collections.defaultdict(
        lambda: collections.defaultdict(lambda: collections.defaultdict(list))
    )
    # group repeated runs within shared station valid hours
    for station, local_date, valid_at, earlier, current, actual_change in pairs:
        predicted_change = shared.number(current[field]) - shared.number(
            earlier[field]
        )
        grouped[station][local_date][valid_at].append(
            (predicted_change, actual_change)
        )
    station_mae = []
    station_bias = []
    station_mse = []
    station_sign = []
    # give every represented station equal weight
    for dates in grouped.values():
        date_mae = []
        date_bias = []
        date_mse = []
        date_sign = []
        # give every represented station-date equal weight
        for hours in dates.values():
            hour_mae = []
            hour_bias = []
            hour_mse = []
            hour_sign = []
            # give every represented valid hour equal weight
            for events in hours.values():
                errors = np.asarray(
                    [prediction - actual for prediction, actual in events],
                    dtype=np.float64,
                )
                hour_mae.append(float(np.mean(np.abs(errors))))
                hour_bias.append(float(np.mean(errors)))
                hour_mse.append(float(np.mean(np.square(errors))))
                hour_sign.append(
                    float(
                        np.mean(
                            [
                                sign(prediction) == sign(actual)
                                for prediction, actual in events
                            ]
                        )
                    )
                )
            date_mae.append(float(np.mean(hour_mae)))
            date_bias.append(float(np.mean(hour_bias)))
            date_mse.append(float(np.mean(hour_mse)))
            date_sign.append(float(np.mean(hour_sign)))
        station_mae.append(float(np.mean(date_mae)))
        station_bias.append(float(np.mean(date_bias)))
        station_mse.append(float(np.mean(date_mse)))
        station_sign.append(float(np.mean(date_sign)))
    return {
        "maeHpa": float(np.mean(station_mae)),
        "biasHpa": float(np.mean(station_bias)),
        "rmseHpa": math.sqrt(float(np.mean(station_mse))),
        "signAccuracy": float(np.mean(station_sign)),
    }


# score paired same-run three-hour and six-hour changes
def score_changes(records, prediction_fields=CANDIDATES):
    """score changes derived from paired forecast levels in one run"""
    indexed = {}
    # index only rows with truthful same-run references
    for row in records:
        identity = forecast_identity(row)
        reference = row.get("referenceAt")
        # exclude nominal fixed anchors from same-run claims
        if reference is None:
            continue
        reference_at = shared.instant(reference)
        key = (
            identity["cohort"],
            identity["stationKey"],
            reference_at,
            identity["validAt"],
        )
        # reject duplicate run-station-hours
        if key in indexed:
            raise ValueError("duplicate same-run pressure row")
        indexed[key] = row
    result = {}
    # score the two frozen tendency horizons
    for horizon in (3, 6):
        pairs = []
        # pair only exact earlier valid hours in the same run
        for key, current in sorted(indexed.items()):
            cohort_value, station, reference_at, valid_at = key
            earlier = indexed.get(
                (
                    cohort_value,
                    station,
                    reference_at,
                    valid_at - dt.timedelta(hours=horizon),
                )
            )
            # skip uncovered pairs
            if earlier is None:
                continue
            actual_change = actual_pressure(current) - actual_pressure(earlier)
            # validate supplied three-hour tendencies when available
            if horizon == 3:
                supplied_forecast = optional_number(
                    current.get("forecastPressureChange3h")
                )
                supplied_actual = optional_number(current.get("actualPressureChange3h"))
                raw_change = forecast_identity(current)["rawPressureHpa"] - forecast_identity(
                    earlier
                )["rawPressureHpa"]
                if supplied_forecast is not None and not math.isclose(
                    supplied_forecast, raw_change, abs_tol=1e-6
                ):
                    raise ValueError("forecast three-hour tendency conflicts with levels")
                if supplied_actual is not None and not math.isclose(
                    supplied_actual, actual_change, abs_tol=1e-6
                ):
                    raise ValueError("actual three-hour tendency conflicts with levels")
            pairs.append(
                (
                    station,
                    shared.calendar(current)["localDate"],
                    valid_at,
                    earlier,
                    current,
                    actual_change,
                )
            )
        horizon_result = {
            "pairs": len(pairs),
            "stations": len({pair[0] for pair in pairs}),
            "stationDates": len({(pair[0], pair[1]) for pair in pairs}),
            "validHours": len({(pair[0], pair[2]) for pair in pairs}),
            "predictions": {},
        }
        rapid_pairs = [
            pair
            for pair in pairs
            if abs(pair[5]) >= POLICY["rapidChangeThresholdHpa"]
        ]
        # score each candidate on identical paired runs
        for field in prediction_fields:
            metrics = balanced_change_metrics(pairs, field)
            rapid_metrics = balanced_change_metrics(rapid_pairs, field)
            # preserve null metric names without pairs
            if metrics is None:
                metrics = {
                    "maeHpa": None,
                    "biasHpa": None,
                    "rmseHpa": None,
                    "signAccuracy": None,
                }
            metrics["rapidChangePairs"] = len(rapid_pairs)
            metrics["rapidChangeMaeHpa"] = (
                None if rapid_metrics is None else rapid_metrics["maeHpa"]
            )
            metrics["rapidChangeSignAccuracy"] = (
                None if rapid_metrics is None else rapid_metrics["signAccuracy"]
            )
            horizon_result["predictions"][field] = metrics
        result[f"{horizon}h"] = horizon_result
    return result


# select the bounded transfer target
def is_transfer_row(row):
    """return whether one row belongs to bounded Best Match transfer scoring"""
    identity = forecast_identity(row)
    local_date = shared.calendar(row)["localDate"]
    return (
        identity["cohort"] == "best_match_single_run_transfer"
        and identity["leadBand"] in {"001-012", "013-024", "025-048"}
        and POLICY["bestMatchTransferStartLocalDate"]
        <= local_date
        <= POLICY["bestMatchTransferEndLocalDate"]
    )


# write one exclusive owner-only prediction file
def write_private_predictions(path, records):
    """write private row-level pressure evidence"""
    shared.write_private_predictions(Path(path), records)


# stream private native and transfer pressure receipts
def private_prediction_records(native_predictions, transfer_predictions, models):
    """yield row-level evidence without a duplicate in-memory list"""
    # emit every native prediction first
    for row in native_predictions:
        native_key = (
            shared.issue_month(row),
            shared.cohort(row),
            shared.lead_band(row),
        )
        model = models[native_key]
        station = model["stations"].get(station_key(row))
        yield {
            "recordKind": "native",
            "key": row["key"],
            "stationKey": station_key(row),
            "validAt": row["validAt"],
            "referenceAt": row.get("referenceAt"),
            "issueMonth": native_key[0],
            "cohort": native_key[1],
            "leadBand": native_key[2],
            "actualPressureHpa": actual_pressure(row),
            "predictions": {candidate: row[candidate] for candidate in CANDIDATES},
            "stationSupported": bool(station and station["supported"]),
            "trainingCutoffUtc": model["trainingCutoffUtc"],
        }
    # emit the single labeled transfer second
    for row in transfer_predictions:
        source_key = (
            shared.issue_month(row),
            "ecmwf_single_run_hindcast",
            shared.lead_band(row),
        )
        source_model = models[source_key]
        source_station = source_model["stations"].get(station_key(row))
        yield {
            "recordKind": "transfer",
            "transfer": TRANSFER,
            "key": row["key"],
            "stationKey": station_key(row),
            "validAt": row["validAt"],
            "referenceAt": row.get("referenceAt"),
            "issueMonth": source_key[0],
            "sourceCohort": source_key[1],
            "targetCohort": shared.cohort(row),
            "leadBand": source_key[2],
            "actualPressureHpa": actual_pressure(row),
            "predictions": {candidate: row[candidate] for candidate in CANDIDATES},
            "sourceStationSupported": bool(
                source_station and source_station["supported"]
            ),
            "elevationCompatible": elevation_compatible(row, source_model),
            "trainingCutoffUtc": source_model["trainingCutoffUtc"],
        }


# run frozen native and transfer pressure evaluations
def evaluate(rows, private_predictions_path):
    """fit monthly states and return aggregate pressure evidence"""
    prepared = prepare_training_rows(rows)
    score_rows = []
    # select only the frozen evaluation epoch
    for identity, row in prepared.entries:
        local_date = shared.calendar(row)["localDate"]
        # retain complete months and separate September partial
        if (
            POLICY["completeEvaluationStartLocalDate"]
            <= local_date
            <= POLICY["partialEvaluationEndLocalDate"]
        ):
            actual_pressure(row)
            score_rows.append(row)
    models = {}
    # fit each required native and transfer source state once
    for row in score_rows:
        native_key = (
            shared.issue_month(row),
            shared.cohort(row),
            shared.lead_band(row),
        )
        # fit each native state once
        if native_key not in models:
            models[native_key] = fit(prepared, *native_key)
        # add exact ECMWF source state for transfer targets
        if is_transfer_row(row):
            source_key = (
                shared.issue_month(row),
                "ecmwf_single_run_hindcast",
                shared.lead_band(row),
            )
            if source_key not in models:
                models[source_key] = fit(prepared, *source_key)
    native_predictions = []
    transfer_predictions = []
    # retain every native score row including station cold starts
    for row in score_rows:
        native_key = (
            shared.issue_month(row),
            shared.cohort(row),
            shared.lead_band(row),
        )
        model = models[native_key]
        values = predict(row, model)
        native_predictions.append({**row, **values})
        # score the elevation-gated transfer separately
        if is_transfer_row(row):
            source_key = (
                shared.issue_month(row),
                "ecmwf_single_run_hindcast",
                shared.lead_band(row),
            )
            source_model = models[source_key]
            transfer_values = predict_transfer(row, source_model)
            transfer_predictions.append({**row, **transfer_values})
    write_private_predictions(
        private_predictions_path,
        private_prediction_records(native_predictions, transfer_predictions, models),
    )
    complete = [
        row
        for row in native_predictions
        if shared.calendar(row)["localDate"]
        <= POLICY["completeEvaluationEndLocalDate"]
    ]
    partial = [
        row
        for row in native_predictions
        if shared.calendar(row)["localDate"]
        >= POLICY["partialEvaluationStartLocalDate"]
    ]
    complete_by_cohort = collections.defaultdict(list)
    partial_by_cohort = collections.defaultdict(list)
    # keep complete native claims cohort-specific
    for row in complete:
        complete_by_cohort[shared.cohort(row)].append(row)
    # keep partial native claims cohort-specific
    for row in partial:
        partial_by_cohort[shared.cohort(row)].append(row)
    transfer_complete = [
        row
        for row in transfer_predictions
        if shared.calendar(row)["localDate"]
        <= POLICY["completeEvaluationEndLocalDate"]
    ]
    transfer_partial = [
        row
        for row in transfer_predictions
        if shared.calendar(row)["localDate"]
        >= POLICY["partialEvaluationStartLocalDate"]
    ]
    model_support = []
    # expose station support without training row identities
    for key in sorted(models):
        model = models[key]
        model_support.append(
            {
                "issueMonth": key[0],
                "cohort": key[1],
                "leadBand": key[2],
                "trainingCutoffUtc": model["trainingCutoffUtc"],
                "eligibleTrainingRows": model["eligibleTrainingRows"],
                "eligibleTrainingStations": model["eligibleTrainingStations"],
                "forecastElevationM": model["forecastElevationM"],
                "stations": model["stations"],
            }
        )
    return {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "candidateSelection": "none_preregistered_all_reported",
        "stationOffsetInterpretation": (
            "station_height_sensor_alignment_not_true_forecast_skill"
        ),
        "modelSupport": model_support,
        "completeMonths": {
            "byCohort": {
                key: score_levels(complete_by_cohort[key])
                for key in sorted(complete_by_cohort)
            },
            "groups": grouped_level_scores(complete),
            "sameRunChangesByCohort": {
                key: score_changes(complete_by_cohort[key])
                for key in sorted(complete_by_cohort)
            },
        },
        "partialSeptember": {
            "byCohort": {
                key: score_levels(partial_by_cohort[key])
                for key in sorted(partial_by_cohort)
            },
            "groups": grouped_level_scores(partial),
            "sameRunChangesByCohort": {
                key: score_changes(partial_by_cohort[key])
                for key in sorted(partial_by_cohort)
            },
        },
        "transfer": {
            "label": TRANSFER,
            "sourceFitReusedWithoutRefit": True,
            "elevationRequired": True,
            "completeMonths": {
                "overall": score_levels(transfer_complete),
                "groups": grouped_level_scores(transfer_complete),
                "sameRunChanges": score_changes(transfer_complete),
            },
            "partialSeptember": {
                "overall": score_levels(transfer_partial),
                "groups": grouped_level_scores(transfer_partial),
                "sameRunChanges": score_changes(transfer_partial),
            },
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
        raise ValueError("request keys do not match pressure research contract")
    # require one row list
    if not isinstance(request["rows"], list):
        raise ValueError("rows must be a list")
    report = evaluate(request["rows"], request["privatePredictionsPath"])
    json.dump(report, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


# keep import side effects disabled
if __name__ == "__main__":
    main()
