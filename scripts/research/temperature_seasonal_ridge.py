"""Research-only smooth seasonal temperature calibration."""

from __future__ import annotations

import collections
import datetime as dt
import math
import os
from zoneinfo import ZoneInfo

# keep existing numerical runtime deterministic
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import numpy as np

ZONE = ZoneInfo("America/Los_Angeles")
UTC = dt.timezone.utc
POLICY = {
    "contractVersion": "temperature-seasonal-ridge-research/v1",
    "ridgeMeanLossPenalty": 0.01,
    "huberDeltaC": 1.5,
    "iterations": 8,
    "correctionWeight": 0.5,
    "maximumCorrectionC": 3.0,
    "physicalMinimumC": -100.0,
    "physicalMaximumC": 70.0,
    "embargoHours": 168,
    "minimumTrainingDates": 180,
    "minimumTrainingRows": 1000,
    "trainingLeads": [24, 48],
    "maximumChangedLead": 48,
    "productionEligible": False,
}


# require a finite scalar without accepting booleans
def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("expected finite numeric input")
    return float(value)


# require canonical millisecond utc instants
def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo != UTC or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        raise ValueError("expected canonical utc instant")
    return parsed


# derive only information present in the forecast and calendar
def features(row):
    local = instant(row["validAt"]).astimezone(ZONE)
    year_start = dt.date(local.year, 1, 1)
    year_days = (dt.date(local.year + 1, 1, 1) - year_start).days
    annual = 2 * math.pi * ((local.date() - year_start).days + local.hour / 24) / year_days
    daily = 2 * math.pi * local.hour / 24
    annual_basis = [math.sin(annual), math.cos(annual), math.sin(2 * annual), math.cos(2 * annual)]
    daily_basis = [math.sin(daily), math.cos(daily), math.sin(2 * daily), math.cos(2 * daily)]
    temperature = (number(row["rawTemperatureC"]) - 10) / 10
    humidity_missing = row["rawRelativeHumidityPercent"] is None
    wind_missing = row["rawWindSpeedMps"] is None
    humidity = 0.0 if humidity_missing else (number(row["rawRelativeHumidityPercent"]) - 75) / 25
    wind = 0.0 if wind_missing else (number(row["rawWindSpeedMps"]) - 2) / 3
    # capture smooth seasonal changes in the daily cycle
    interactions = [a * d for a in annual_basis[:2] for d in daily_basis[:2]]
    # allow forecast-dependent daily and seasonal bias
    temperature_interactions = [temperature * v for v in annual_basis[:2] + daily_basis[:2]]
    return np.array([1.0, *annual_basis, *daily_basis, *interactions,
                     temperature, temperature * temperature, humidity, wind,
                     float(humidity_missing), float(wind_missing),
                     *temperature_interactions, humidity * daily_basis[0],
                     humidity * daily_basis[1], wind * daily_basis[0],
                     wind * daily_basis[1]], dtype=np.float64)


# derive the beginning of one local-calendar fit month
def month_start(month):
    parsed = dt.datetime.strptime(month, "%Y-%m")
    if parsed.strftime("%Y-%m") != month:
        raise ValueError("expected canonical calendar month")
    return parsed.replace(tzinfo=ZONE).astimezone(UTC)


# choose live model state using issue time rather than target month
def reference_month(row):
    reference = instant(row["referenceAt"])
    lead = number(row["targetLeadHours"])
    elapsed = (instant(row["validAt"]) - reference).total_seconds() / 3600
    if not lead.is_integer() or not 1 <= lead <= 168 or elapsed <= 0 or math.ceil(elapsed) != lead:
        raise ValueError("live reference must agree with lead")
    return reference.astimezone(ZONE).strftime("%Y-%m")


# retain only earlier exact-lead archive labels
def training_rows(rows, month, lead):
    if lead not in POLICY["trainingLeads"]:
        raise ValueError("training requires an exact archive lead")
    cutoff = month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    selected = []
    # reject malformed archive identity before any label-based fitting
    for row in rows:
        if row["cohort"] != "fixed_lead_anchor" or row["referenceAt"] is not None:
            raise ValueError("training requires authentic archive anchors")
        # require valid fixed-anchor identities even outside the selected lead
        if isinstance(row["targetLeadHours"], bool) or row["targetLeadHours"] not in [24, 48, 72, 96, 120, 144, 168]:
            raise ValueError("invalid archive forecast lead")
        if row["targetLeadHours"] == lead and instant(row["validAt"]) < cutoff:
            selected.append(row)
    return sorted(selected, key=lambda row: row["key"])


# give each represented local date equal total fitting weight
def date_weights(rows):
    counts = collections.Counter(instant(row["validAt"]).astimezone(ZONE).date() for row in rows)
    return np.array([1 / counts[instant(row["validAt"]).astimezone(ZONE).date()] for row in rows])


# compute a stable weighted median for the simple offset control
def weighted_median(values, weights):
    order = np.argsort(values, kind="stable")
    index = np.searchsorted(np.cumsum(weights[order]), weights.sum() / 2, side="left")
    return float(values[order[min(index, len(order) - 1)]])


# fit one frozen robust ridge model without validation feedback
def fit(rows, month, lead):
    selected = training_rows(rows, month, lead)
    dates = {instant(row["validAt"]).astimezone(ZONE).date() for row in selected}
    if len(selected) < POLICY["minimumTrainingRows"] or len(dates) < POLICY["minimumTrainingDates"]:
        raise ValueError("insufficient earlier training support")
    matrix = np.stack([features(row) for row in selected])
    residuals = np.array([number(row["actualTemperatureC"]) - number(row["rawTemperatureC"]) for row in selected])
    weights = date_weights(selected)
    penalty = np.eye(matrix.shape[1]) * POLICY["ridgeMeanLossPenalty"] * weights.sum()
    penalty[0, 0] = 0
    coefficients = np.zeros(matrix.shape[1])
    # use a fixed iteration count rather than score-based early stopping
    for _ in range(POLICY["iterations"]):
        errors = residuals - matrix @ coefficients
        robust = np.minimum(1.0, POLICY["huberDeltaC"] / np.maximum(np.abs(errors), 1e-12))
        effective = weights * robust
        coefficients = np.linalg.solve(matrix.T @ (matrix * effective[:, None]) + penalty,
                                       matrix.T @ (effective * residuals))
    if not np.isfinite(coefficients).all():
        raise ValueError("non-finite fitted coefficients")
    return {"month": month, "lead": lead, "coefficients": coefficients.tolist(),
            "medianOffsetC": weighted_median(residuals, weights), "trainingRows": len(selected),
            "trainingDates": len(dates), "firstTrainingValidAt": min(row["validAt"] for row in selected),
            "lastTrainingValidAt": max(row["validAt"] for row in selected),
            "trainingCutoffUtc": (month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "trainingKeys": [row["key"] for row in selected]}


# apply the single preregistered conservative correction
def correction(value):
    return max(-POLICY["maximumCorrectionC"], min(POLICY["maximumCorrectionC"],
               POLICY["correctionWeight"] * number(value)))


# change only near-term predictions and preserve the accepted longer-term comparator
def predict(row, models, prior_prediction, *, median_control=False):
    lead = number(row["targetLeadHours"])
    if not lead.is_integer() or not 1 <= lead <= 168:
        raise ValueError("unsupported forecast lead")
    if lead > POLICY["maximumChangedLead"]:
        return number(prior_prediction)
    raw = number(row["rawTemperatureC"])
    blend = max(0.0, (lead - 24) / 24)
    values = []
    # keep short-lead transfer explicit rather than synthesizing training examples
    for training_lead in POLICY["trainingLeads"]:
        model = models[training_lead]
        if model["lead"] != training_lead:
            raise ValueError("model lead does not match its slot")
        values.append(number(model["medianOffsetC"]) if median_control else
                      float(features(row) @ np.asarray(model["coefficients"])))
    return max(POLICY["physicalMinimumC"], min(POLICY["physicalMaximumC"],
               raw + correction((1 - blend) * values[0] + blend * values[1])))


# score every supplied prediction on the same date-balanced population
def score(records, prediction_fields):
    if not records:
        return None
    seen = set()
    actual_by_hour = {}
    grouped = collections.defaultdict(lambda: collections.defaultdict(list))
    # require canonical unique identities before computing any denominator
    for row in records:
        if row["key"] in seen:
            raise ValueError("duplicate score key")
        seen.add(row["key"])
        actual = number(row["actualTemperatureC"])
        # reject contradictory labels for the shared physical target
        if row["validAt"] in actual_by_hour and actual_by_hour[row["validAt"]] != actual:
            raise ValueError("conflicting actual for shared valid hour")
        actual_by_hour[row["validAt"]] = actual
        local_date = instant(row["validAt"]).astimezone(ZONE).date().isoformat()
        grouped[local_date][row["validAt"]].append(row)
    result = {"events": len(records), "dates": len(grouped),
              "validHours": sum(len(hours) for hours in grouped.values()), "predictions": {}}
    # reuse identical event, valid-hour and date weights for every comparator
    for field in prediction_fields:
        daily = []
        daily_large = []
        daily_squared = []
        event_errors = []
        hourly = []
        # avoid overweighting dates with additional forecast vintages
        for hours in grouped.values():
            day_errors, day_large, day_squared = [], [], []
            # average repeated forecasts before averaging local dates
            for events in hours.values():
                errors = [abs(number(row[field]) - number(row["actualTemperatureC"])) for row in events]
                event_errors.extend(errors)
                day_errors.append(float(np.mean(errors)))
                day_large.append(float(np.mean([value > 2 for value in errors])))
                day_squared.append(float(np.mean(np.square(errors))))
            hourly.extend(day_errors)
            daily.append(float(np.mean(day_errors)))
            daily_large.append(float(np.mean(day_large)))
            daily_squared.append(float(np.mean(day_squared)))
        result["predictions"][field] = {"equalDateMaeC": float(np.mean(daily)),
            "equalHourMaeC": float(np.mean(hourly)), "eventMaeC": float(np.mean(event_errors)),
            "equalDateRmseC": math.sqrt(float(np.mean(daily_squared))),
            "equalDateFractionAbove2C": float(np.mean(daily_large))}
    return result
