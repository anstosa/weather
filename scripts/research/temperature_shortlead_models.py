"""Research-only provider-specific short-lead temperature models."""

from __future__ import annotations

import collections
import datetime as dt
import math
import statistics

import numpy as np

import temperature_seasonal_ridge as base


COHORTS = (
    "ecmwf_single_run_hindcast",
    "best_match_single_run_transfer",
)
SCOPES = {
    "initialization_first12": {
        "minimumModelLead": 1,
        "maximumModelLead": 12,
        "horizonOffsetHours": 0,
    },
    "assumed_delay6_next12": {
        "minimumModelLead": 7,
        "maximumModelLead": 18,
        "horizonOffsetHours": 6,
    },
}
ARMS = ("direct_mos", "lagged_bias", "adaptive_mos", "median_control")
POLICY = {
    "contractVersion": "temperature-shortlead-models-research/v1",
    "sourceMinimumLead": 7,
    "sourceMaximumLead": 18,
    "sourceDelayHours": 7,
    "shortWindowHours": 24,
    "longWindowHours": 72,
    "minimumShortWindowRows": 6,
    "minimumLongWindowRows": 24,
    "minimumStateLocalDates": 2,
    "signedMedianClipC": 6.0,
    "madCapC": 6.0,
    "embargoHours": 168,
    "minimumTrainingDates": 60,
    "minimumTrainingRows": 1000,
    "ridgeMeanLossPenalty": 0.01,
    "huberDeltaC": 1.5,
    "iterations": 8,
    "correctionWeight": 0.5,
    "maximumCorrectionC": 3.0,
    "physicalMinimumC": -100.0,
    "physicalMaximumC": 70.0,
    "productionEligible": False,
}


# require one declared provider cohort
def _cohort(value):
    # reject undeclared providers
    if value not in COHORTS:
        raise ValueError("unsupported forecast cohort")
    return value


# require one declared horizon scope
def _scope(value):
    # reject undeclared horizons
    if value not in SCOPES:
        raise ValueError("unsupported short-lead scope")
    return SCOPES[value]


# require an integer without accepting booleans
def _integer(value, label):
    parsed = base.number(value)
    # reject fractional values
    if not parsed.is_integer():
        raise ValueError(f"{label} must be an integer")
    return int(parsed)


# format one canonical utc instant
def _format_instant(value):
    return value.astimezone(base.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


# validate one normalized provider forecast identity
def _forecast_identity(row):
    key = row.get("key")
    # require durable identity
    if not isinstance(key, str) or not key:
        raise ValueError("forecast key must be a nonempty string")
    run_initialized_at = base.instant(row["runInitializedAt"])
    valid_at = base.instant(row["validAt"])
    model_lead = _integer(row["modelLeadHours"], "model lead")
    # restrict acquired leads
    if not 1 <= model_lead <= 18:
        raise ValueError("model lead is outside the archived range")
    elapsed = (valid_at - run_initialized_at).total_seconds() / 3600
    # bind timestamps to lead
    if elapsed != model_lead:
        raise ValueError("model lead does not match forecast timestamps")
    return key, run_initialized_at, valid_at, model_lead


# validate one row against its declared scope
def _scope_identity(row, scope):
    definition = _scope(scope)
    key, run_initialized_at, valid_at, model_lead = _forecast_identity(row)
    # enforce scope membership
    if not definition["minimumModelLead"] <= model_lead <= definition["maximumModelLead"]:
        raise ValueError("model lead does not belong to model scope")
    horizon = _integer(row["operationalHorizonHours"], "operational horizon")
    # bind operational semantics
    if horizon != model_lead - definition["horizonOffsetHours"] or not 1 <= horizon <= 12:
        raise ValueError("operational horizon does not match model lead and scope")
    return key, run_initialized_at, valid_at, model_lead, horizon


# build a deterministic median with a symmetric cap
def _clipped_median(values):
    return max(
        -POLICY["signedMedianClipC"],
        min(POLICY["signedMedianClipC"], float(statistics.median(values))),
    )


# compute one finite observed forecast error
def _residual(actual, raw):
    return base.number(base.number(actual) - base.number(raw))


# normalize targets without consulting labels during source selection
def _target_index(targets):
    indexed = {}
    # index without reading outcomes
    for row in targets:
        valid_at = base.instant(row["validAt"])
        key = _format_instant(valid_at)
        # reject contradictory labels
        if key in indexed and indexed[key].get("actualTemperatureC") != row.get(
            "actualTemperatureC"
        ):
            raise ValueError("conflicting actual for shared valid hour")
        indexed[key] = row
    return indexed


# summarize one causally available rolling-error window
def _state_for_initialization(
    run_initialized_at, candidates_by_valid_at, targets, cohort
):
    end = run_initialized_at - dt.timedelta(hours=POLICY["sourceDelayHours"])
    selected = []
    # walk exact causal slots
    for age in range(POLICY["longWindowHours"]):
        valid_at = end - dt.timedelta(hours=age)
        candidates = candidates_by_valid_at.get(valid_at, ())
        # filter on forecast-time identity
        eligible = [candidate for candidate in candidates if candidate[0] < run_initialized_at]
        # skip uncovered hours
        if not eligible:
            continue
        source = max(eligible, key=lambda candidate: (candidate[0], candidate[1]["key"]))
        target = targets.get(_format_instant(valid_at))
        # skip unavailable forecast or outcome cells
        if (
            target is None
            or target.get("actualTemperatureC") is None
            or source[1].get("rawTemperatureC") is None
        ):
            continue
        error = _residual(
            target["actualTemperatureC"], source[1]["rawTemperatureC"]
        )
        selected.append((valid_at, source[0], source[1]["key"], error))
    short_start = end - dt.timedelta(hours=POLICY["shortWindowHours"] - 1)
    # isolate the short subset
    short = [item for item in selected if item[0] >= short_start]
    # count represented target dates
    local_dates = {
        item[0].astimezone(base.ZONE).date().isoformat() for item in selected
    }
    short_supported = len(short) >= POLICY["minimumShortWindowRows"]
    long_supported = len(selected) >= POLICY["minimumLongWindowRows"]
    dates_supported = len(local_dates) >= POLICY["minimumStateLocalDates"]
    # cap signed short bias
    b24 = _clipped_median([item[3] for item in short]) if short_supported else None
    # retain the raw center for dispersion
    raw_b72 = (
        float(statistics.median(item[3] for item in selected))
        if long_supported
        else None
    )
    b72 = (
        max(-POLICY["signedMedianClipC"], min(POLICY["signedMedianClipC"], raw_b72))
        if long_supported
        else None
    )
    mad72 = None
    # cap long-window dispersion
    if long_supported:
        mad72 = min(
            POLICY["madCapC"],
            float(statistics.median(abs(item[3] - raw_b72) for item in selected)),
        )
    return {
        "cohort": cohort,
        "targetRunInitializedAt": _format_instant(run_initialized_at),
        "windowEndValidAt": _format_instant(end),
        "supported": short_supported and long_supported and dates_supported,
        "b24C": b24,
        "b72C": b72,
        "mad72C": mad72,
        "n24": len(short),
        "n72": len(selected),
        "localDates": len(local_dates),
        "sourceKeys": [item[2] for item in sorted(selected)],
        "maximumSourceValidAt": (
            _format_instant(max(item[0] for item in selected)) if selected else None
        ),
        "maximumSourceRunInitializedAt": (
            _format_instant(max(item[1] for item in selected)) if selected else None
        ),
    }


# freeze same-provider error state at every archived initialization
def build_states(forecast_rows, targets, cohort):
    selected_cohort = _cohort(cohort)
    normalized = []
    seen = set()
    # validate same-provider identities first
    for row in forecast_rows:
        # isolate foreign providers
        if row.get("cohort") != selected_cohort:
            continue
        key, run_initialized_at, valid_at, model_lead = _forecast_identity(row)
        # reject duplicated events
        if key in seen:
            raise ValueError("duplicate forecast key")
        seen.add(key)
        normalized.append((run_initialized_at, valid_at, model_lead, row))
    candidates_by_valid_at = collections.defaultdict(list)
    initializations = set()
    # index eligible state sources
    for run_initialized_at, valid_at, model_lead, row in normalized:
        initializations.add(run_initialized_at)
        # admit only preregistered source leads
        if POLICY["sourceMinimumLead"] <= model_lead <= POLICY["sourceMaximumLead"]:
            candidates_by_valid_at[valid_at].append((run_initialized_at, row))
    indexed_targets = _target_index(targets)
    states = {}
    # freeze one state per initialization
    for run_initialized_at in sorted(initializations):
        states[_format_instant(run_initialized_at)] = _state_for_initialization(
            run_initialized_at,
            candidates_by_valid_at,
            indexed_targets,
            selected_cohort,
        )
    return states


# add lead, cycle, and model-era terms to the frozen seasonal predictors
def static_features(row):
    static = base.features(row)
    lead = _integer(row["modelLeadHours"], "model lead")
    # restrict acquired leads
    if not 1 <= lead <= 18:
        raise ValueError("model lead is outside the archived range")
    run_initialized_at = base.instant(row["runInitializedAt"])
    cycle = row.get("modelCycle")
    # require model-era identity
    if not isinstance(cycle, str) or not cycle:
        raise ValueError("model cycle must be a nonempty string")
    lead_scaled = lead / 18
    local = base.instant(row["validAt"]).astimezone(base.ZONE)
    daily = 2 * math.pi * local.hour / 24
    cycle_angle = 2 * math.pi * run_initialized_at.hour / 24
    additions = np.array(
        [
            lead_scaled,
            lead_scaled * lead_scaled,
            lead_scaled * math.sin(daily),
            lead_scaled * math.cos(daily),
            lead_scaled * static[13],
            math.sin(cycle_angle),
            math.cos(cycle_angle),
            float(cycle == "50r1"),
        ],
        dtype=np.float64,
    )
    result = np.concatenate((static, additions))
    # enforce the frozen schema
    if len(result) != 35 or not np.isfinite(result).all():
        raise ValueError("non-finite static feature vector")
    return result


# validate one frozen rolling-error state
def _validated_state(row):
    state = row.get("state")
    # require an attached state
    if not isinstance(state, dict):
        raise ValueError("row requires a rolling-error state")
    # preserve provider isolation
    if state.get("cohort") != row.get("cohort"):
        raise ValueError("state cohort does not match forecast row")
    run_initialized_at = base.instant(row["runInitializedAt"])
    # bind state to initialization
    if base.instant(state["targetRunInitializedAt"]) != run_initialized_at:
        raise ValueError("state initialization does not match forecast row")
    expected_end = run_initialized_at - dt.timedelta(hours=POLICY["sourceDelayHours"])
    # enforce hour-end lag
    if base.instant(state["windowEndValidAt"]) != expected_end:
        raise ValueError("state window does not end at the causal boundary")
    n24 = _integer(state["n24"], "state n24")
    n72 = _integer(state["n72"], "state n72")
    local_dates = _integer(state["localDates"], "state local dates")
    # bound short support
    if not 0 <= n24 <= POLICY["shortWindowHours"]:
        raise ValueError("state n24 is outside its window")
    # bound long support
    if not n24 <= n72 <= POLICY["longWindowHours"]:
        raise ValueError("state n72 is outside its window")
    # bound represented dates
    if not 0 <= local_dates <= n72:
        raise ValueError("state local-date count is invalid")
    source_keys = state.get("sourceKeys")
    # bind audit keys to hours
    if (
        not isinstance(source_keys, list)
        or len(source_keys) != n72
        or any(not isinstance(key, str) or not key for key in source_keys)
        or len(set(source_keys)) != len(source_keys)
    ):
        raise ValueError("state source keys do not match selected hours")
    maximum_valid_at = state.get("maximumSourceValidAt")
    maximum_run_at = state.get("maximumSourceRunInitializedAt")
    # require empty-state receipts
    if n72 == 0:
        # reject fabricated maxima
        if maximum_valid_at is not None or maximum_run_at is not None:
            raise ValueError("empty state cannot have source maxima")
    # validate populated receipts
    else:
        # enforce observation boundary
        if base.instant(maximum_valid_at) > expected_end:
            raise ValueError("state contains an unavailable source observation")
        # enforce prior initialization
        if base.instant(maximum_run_at) >= run_initialized_at:
            raise ValueError("state contains a non-prior forecast initialization")
    short_supported = n24 >= POLICY["minimumShortWindowRows"]
    long_supported = n72 >= POLICY["minimumLongWindowRows"]
    dates_supported = local_dates >= POLICY["minimumStateLocalDates"]
    expected_supported = short_supported and long_supported and dates_supported
    # recompute support gate
    if not isinstance(state.get("supported"), bool) or state["supported"] != expected_supported:
        raise ValueError("state support flag does not match its counts")
    b24 = state.get("b24C")
    b72 = state.get("b72C")
    mad72 = state.get("mad72C")
    # validate short statistics
    if short_supported:
        b24 = base.number(b24)
        # enforce signed cap
        if abs(b24) > POLICY["signedMedianClipC"]:
            raise ValueError("state short-window median exceeds its cap")
    # reject stray short statistics
    elif b24 is not None:
        raise ValueError("unsupported short window must have a null median")
    # validate long statistics
    if long_supported:
        b72 = base.number(b72)
        mad72 = base.number(mad72)
        # enforce statistic caps
        if abs(b72) > POLICY["signedMedianClipC"] or not 0 <= mad72 <= POLICY["madCapC"]:
            raise ValueError("state long-window statistics exceed their caps")
    # reject stray long statistics
    elif b72 is not None or mad72 is not None:
        raise ValueError("unsupported long window must have null statistics")
    return state, b24, b72, mad72, n24, n72


# append causally frozen recent-error terms
def adaptive_features(row):
    static = static_features(row)
    horizon = _integer(row["operationalHorizonHours"], "operational horizon")
    # restrict adaptive horizon
    if not 1 <= horizon <= 12:
        raise ValueError("operational horizon is outside the adaptive window")
    state, b24, b72, mad72, n24, n72 = _validated_state(row)
    short_value = 0.0 if b24 is None else b24
    long_value = 0.0 if b72 is None else b72
    difference = 0.0 if b24 is None or b72 is None else b24 - b72
    signed = [short_value / 3, long_value / 3, difference / 3]
    additions = np.array(
        [
            *signed,
            0.0 if mad72 is None else mad72 / 3,
            n24 / POLICY["shortWindowHours"],
            n72 / POLICY["longWindowHours"],
            float(b24 is None),
            float(b72 is None),
            *(value * math.exp(-horizon / 6) for value in signed),
            *(value * math.exp(-horizon / 18) for value in signed),
        ],
        dtype=np.float64,
    )
    result = np.concatenate((static, additions))
    # enforce the frozen schema
    if len(result) != 49 or not np.isfinite(result).all():
        raise ValueError("non-finite adaptive feature vector")
    return result


# select causally eligible rows for one provider, scope, and target month
def training_rows(rows, month, cohort, scope):
    selected_cohort = _cohort(cohort)
    definition = _scope(scope)
    cutoff = base.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    eligible = []
    seen = set()
    # validate provider rows before outcomes
    for row in rows:
        # isolate foreign providers
        if row.get("cohort") != selected_cohort:
            continue
        key, _, valid_at, model_lead = _forecast_identity(row)
        # reject duplicated events
        if key in seen:
            raise ValueError("duplicate training key")
        seen.add(key)
        # isolate the declared lead scope
        if not definition["minimumModelLead"] <= model_lead <= definition["maximumModelLead"]:
            continue
        _scope_identity(row, scope)
        # drop unavailable forecast-target pairs
        if (
            row.get("actualTemperatureC") is None
            or row.get("rawTemperatureC") is None
        ):
            continue
        # enforce outcome availability lag
        if valid_at + dt.timedelta(hours=POLICY["sourceDelayHours"]) <= cutoff:
            eligible.append(row)
    return sorted(eligible, key=lambda row: row["key"])


# give dates, valid hours, and repeated events their declared nested weights
def event_weights(rows):
    grouped = collections.defaultdict(lambda: collections.Counter())
    # count events within hours and dates
    for row in rows:
        valid_at = base.instant(row["validAt"])
        local_date = valid_at.astimezone(base.ZONE).date()
        grouped[local_date][_format_instant(valid_at)] += 1
    weights = []
    # assign nested reciprocal weights
    for row in rows:
        valid_at = base.instant(row["validAt"])
        local_date = valid_at.astimezone(base.ZONE).date()
        valid_key = _format_instant(valid_at)
        weights.append(
            1 / (len(grouped[local_date]) * grouped[local_date][valid_key])
        )
    return np.asarray(weights, dtype=np.float64)


# fit one fixed robust ridge coefficient vector
def _fit_coefficients(matrix, residuals, weights):
    penalty = (
        np.eye(matrix.shape[1], dtype=np.float64)
        * POLICY["ridgeMeanLossPenalty"]
        * weights.sum()
    )
    penalty[0, 0] = 0
    coefficients = np.zeros(matrix.shape[1], dtype=np.float64)
    # run the fixed robust updates
    for _ in range(POLICY["iterations"]):
        errors = residuals - matrix @ coefficients
        robust = np.minimum(
            1.0,
            POLICY["huberDeltaC"] / np.maximum(np.abs(errors), 1e-12),
        )
        effective = weights * robust
        coefficients = np.linalg.solve(
            matrix.T @ (matrix * effective[:, None]) + penalty,
            matrix.T @ (effective * residuals),
        )
    # reject unstable fits
    if not np.isfinite(coefficients).all():
        raise ValueError("non-finite fitted coefficients")
    return coefficients.tolist()


# fit direct and adaptive models from the same frozen training population
def fit(rows, month, cohort, scope):
    selected = training_rows(rows, month, cohort, scope)
    # count unique target dates
    dates = {
        base.instant(row["validAt"]).astimezone(base.ZONE).date().isoformat()
        for row in selected
    }
    cutoff = base.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    supported = (
        len(selected) >= POLICY["minimumTrainingRows"]
        and len(dates) >= POLICY["minimumTrainingDates"]
    )
    weights = event_weights(selected)
    # construct direct residual labels
    residuals = np.asarray(
        [
            _residual(row["actualTemperatureC"], row["rawTemperatureC"])
            for row in selected
        ],
        dtype=np.float64,
    )
    # fit the no-model offset control
    median_offset = (
        base.weighted_median(residuals, weights) if len(selected) else None
    )
    model = {
        "contractVersion": POLICY["contractVersion"],
        "month": month,
        "cohort": _cohort(cohort),
        "scope": scope,
        "supported": supported,
        "directCoefficients": None,
        "adaptiveCoefficients": None,
        "medianOffsetC": median_offset,
        "trainingRows": len(selected),
        "trainingDates": len(dates),
        "firstTrainingValidAt": min(
            (row["validAt"] for row in selected), default=None
        ),
        "lastTrainingValidAt": max(
            (row["validAt"] for row in selected), default=None
        ),
        "trainingCutoffUtc": _format_instant(cutoff),
        "trainingKeys": [row["key"] for row in selected],
    }
    # preserve raw cold start
    if not supported:
        return model
    # fit both preregistered schemas
    static_matrix = np.stack([static_features(row) for row in selected])
    adaptive_matrix = np.stack([adaptive_features(row) for row in selected])
    model["directCoefficients"] = _fit_coefficients(
        static_matrix, residuals, weights
    )
    model["adaptiveCoefficients"] = _fit_coefficients(
        adaptive_matrix, residuals, weights
    )
    return model


# validate model identity before applying a learned correction
def _validated_model(row, model):
    # require serialized model state
    if not isinstance(model, dict):
        raise ValueError("short-lead model must be an object")
    # reject contract drift
    if model.get("contractVersion") != POLICY["contractVersion"]:
        raise ValueError("short-lead model contract does not match")
    cohort = _cohort(model.get("cohort"))
    scope = model.get("scope")
    _scope(scope)
    # enforce provider identity
    if row.get("cohort") != cohort:
        raise ValueError("forecast cohort does not match model")
    _, run_initialized_at, valid_at, _, _ = _scope_identity(row, scope)
    # enforce target-month selection
    if valid_at.astimezone(base.ZONE).strftime("%Y-%m") != model.get("month"):
        raise ValueError("forecast target month does not match model")
    cutoff = base.instant(model["trainingCutoffUtc"])
    # prevent training leakage
    if cutoff >= run_initialized_at:
        raise ValueError("model cutoff must strictly precede initialization")
    # require explicit cold start
    if not isinstance(model.get("supported"), bool):
        raise ValueError("model support flag must be boolean")
    return scope, run_initialized_at


# require one finite coefficient vector of the frozen width
def _coefficients(model, field, width):
    values = model.get(field)
    # enforce vector width
    if not isinstance(values, list) or len(values) != width:
        raise ValueError("model coefficients do not match feature schema")
    converted = np.asarray([base.number(value) for value in values], dtype=np.float64)
    # reject non-finite models
    if not np.isfinite(converted).all():
        raise ValueError("model coefficients must be finite")
    return converted


# apply the fixed half-strength bounded correction
def _adjust(raw, residual):
    correction = max(
        -POLICY["maximumCorrectionC"],
        min(
            POLICY["maximumCorrectionC"],
            POLICY["correctionWeight"] * base.number(residual),
        ),
    )
    return max(
        POLICY["physicalMinimumC"],
        min(POLICY["physicalMaximumC"], raw + correction),
    )


# apply one frozen experiment arm inside its declared first-twelve-hour window
def predict(row, model, prior_prediction, arm):
    horizon = _integer(row["operationalHorizonHours"], "operational horizon")
    # preserve accepted outer horizons
    if not 1 <= horizon <= 12:
        return prior_prediction
    # require a frozen arm
    if arm not in ARMS:
        raise ValueError("unsupported short-lead model arm")
    _validated_model(row, model)
    raw = base.number(row["rawTemperatureC"])
    # preserve shared cold start
    if not model["supported"]:
        return raw
    # apply the no-fit lagged control
    if arm == "lagged_bias":
        state, b24, _, _, _, _ = _validated_state(row)
        # preserve unsupported state
        if not state["supported"]:
            return raw
        return _adjust(raw, b24 * math.exp(-horizon / 12))
    # apply the adaptive fit
    if arm == "adaptive_mos":
        state, _, _, _, _, _ = _validated_state(row)
        # fall back exactly to direct mos
        if not state["supported"]:
            direct_coefficients = _coefficients(
                model, "directCoefficients", 35
            )
            direct_prediction = _adjust(
                raw, static_features(row) @ direct_coefficients
            )
            return direct_prediction
        adaptive_coefficients = _coefficients(
            model, "adaptiveCoefficients", 49
        )
        return _adjust(raw, adaptive_features(row) @ adaptive_coefficients)
    # apply the direct fit
    if arm == "direct_mos":
        direct_coefficients = _coefficients(model, "directCoefficients", 35)
        return _adjust(raw, static_features(row) @ direct_coefficients)
    return _adjust(raw, base.number(model["medianOffsetC"]))


# score shared predictions with the frozen date-hour-event denominator
def score(records, prediction_fields):
    return base.score(records, prediction_fields)
