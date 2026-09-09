"""Research-only residual corrections around the frozen seasonal temperature model."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np

import temperature_seasonal_ridge as base
import temperature_shortlead_models as short


COHORTS = short.COHORTS
SCOPES = short.SCOPES
ARMS = ("residual_static", "residual_adaptive", "conservative_blend")
POLICY = {
    "contractVersion": "temperature-residual-stack-research/v1",
    "residualBasis": "priorSeasonal",
    "embargoHours": 168,
    "minimumTrainingDates": 60,
    "minimumTrainingRows": 1000,
    "ridgeMeanLossPenalty": 0.1,
    "huberDeltaC": 1.5,
    "iterations": 8,
    "correctionWeight": 0.5,
    "maximumCorrectionC": 1.5,
    "maximumBlendWeight": 0.5,
    "physicalMinimumC": -100.0,
    "physicalMaximumC": 70.0,
    "productionEligible": False,
}


# validate one supported or explicitly absent prior prediction
def _prior_provenance(row):
    supported = row.get("priorSupported")
    # require explicit support
    if not isinstance(supported, bool):
        raise ValueError("prior support flag must be boolean")
    prediction = row.get("priorTemperatureC")
    cutoff_value = row.get("priorTrainingCutoffUtc")
    # preserve explicit absence
    if not supported:
        # reject disguised raw fallbacks
        if prediction is not None or cutoff_value is not None:
            raise ValueError("unsupported prior must have null provenance")
        return False, None, None
    prediction = base.number(prediction)
    cutoff = base.instant(cutoff_value)
    run_initialized_at = base.instant(row["runInitializedAt"])
    # prevent baseline leakage
    if cutoff >= run_initialized_at:
        raise ValueError("prior cutoff must strictly precede initialization")
    return True, prediction, cutoff


# validate one supported or explicitly absent challenger prediction
def _challenger_provenance(row):
    supported = row.get("challengerSupported")
    # require explicit support
    if not isinstance(supported, bool):
        raise ValueError("challenger support flag must be boolean")
    prediction = row.get("challengerTemperatureC")
    cutoff_value = row.get("challengerTrainingCutoffUtc")
    # preserve explicit absence
    if not supported:
        # reject disguised fallback values
        if prediction is not None or cutoff_value is not None:
            raise ValueError("unsupported challenger must have null provenance")
        return False, None, None
    prediction = base.number(prediction)
    cutoff = base.instant(cutoff_value)
    run_initialized_at = base.instant(row["runInitializedAt"])
    # prevent challenger leakage
    if cutoff >= run_initialized_at:
        raise ValueError("challenger cutoff must strictly precede initialization")
    return True, prediction, cutoff


# validate one rolling state built from prior-model residuals
def _prior_state(row):
    state, *statistics = short._validated_state(row)
    # reject raw-residual state substitution
    if state.get("residualBasis") != POLICY["residualBasis"]:
        raise ValueError("state residual basis must be prior seasonal")
    return state, *statistics


# build causal recent-error states around earlier-only prior predictions
def build_prior_states(forecasts, targets, cohort):
    selected_cohort = short._cohort(cohort)
    copies = []
    # replace raw values before shared source selection
    for row in forecasts:
        # preserve provider isolation
        if row.get("cohort") != selected_cohort:
            copies.append(row)
            continue
        supported, prediction, _ = _prior_provenance(row)
        copied = dict(row)
        copied["rawTemperatureC"] = prediction if supported else None
        copies.append(copied)
    states = short.build_states(copies, targets, selected_cohort)
    # mark the residual basis for downstream validation
    for state in states.values():
        state["residualBasis"] = POLICY["residualBasis"]
    return states


# derive the frozen ten-term residual schema
def static_features(row):
    supported, prior, _ = _prior_provenance(row)
    # require a usable baseline
    if not supported:
        raise ValueError("static features require a supported prior")
    raw = base.number(row["rawTemperatureC"])
    horizon = short._integer(row["operationalHorizonHours"], "operational horizon")
    # restrict the residual window
    if not 1 <= horizon <= 12:
        raise ValueError("operational horizon is outside the residual window")
    run_initialized_at = base.instant(row["runInitializedAt"])
    valid_local = base.instant(row["validAt"]).astimezone(base.ZONE)
    cycle = row.get("modelCycle")
    # require model-era identity
    if not isinstance(cycle, str) or not cycle:
        raise ValueError("model cycle must be a nonempty string")
    horizon_scaled = horizon / 12
    cycle_angle = 2 * math.pi * run_initialized_at.hour / 24
    local_angle = 2 * math.pi * valid_local.hour / 24
    prior_delta = (prior - raw) / 3
    result = np.asarray(
        [
            1.0,
            horizon_scaled,
            horizon_scaled * horizon_scaled,
            math.sin(cycle_angle),
            math.cos(cycle_angle),
            math.sin(local_angle),
            math.cos(local_angle),
            prior_delta,
            prior_delta * horizon_scaled,
            float(cycle == "50r1"),
        ],
        dtype=np.float64,
    )
    # enforce the frozen schema
    if len(result) != 10 or not np.isfinite(result).all():
        raise ValueError("non-finite residual feature vector")
    return result


# append the shared fourteen-term prior-error state schema
def adaptive_features(row):
    static = static_features(row)
    _prior_state(row)
    additions = short.adaptive_features(row)[35:]
    result = np.concatenate((static, additions))
    # enforce the frozen schema
    if len(result) != 24 or not np.isfinite(result).all():
        raise ValueError("non-finite adaptive residual feature vector")
    return result


# select rows with causal prior predictions from the shared population
def _residual_rows(rows, month, cohort, scope):
    selected = []
    # filter only after shared provider and scope selection
    for row in short.training_rows(rows, month, cohort, scope):
        supported, _, _ = _prior_provenance(row)
        # exclude explicit prior cold starts
        if not supported:
            continue
        _prior_state(row)
        selected.append(row)
    return selected


# select the subset with causal challenger predictions
def _blend_rows(rows):
    selected = []
    # keep the residual denominator fixed before challenger filtering
    for row in rows:
        supported, _, _ = _challenger_provenance(row)
        # exclude explicit challenger cold starts
        if not supported:
            continue
        selected.append(row)
    return selected


# count represented local dates
def _date_count(rows):
    return len(
        {
            base.instant(row["validAt"]).astimezone(base.ZONE).date()
            for row in rows
        }
    )


# determine whether one fitting population clears both support gates
def _supported(rows):
    return (
        len(rows) >= POLICY["minimumTrainingRows"]
        and _date_count(rows) >= POLICY["minimumTrainingDates"]
    )


# fit one robust ridge vector with every coefficient penalized
def _fit_coefficients(matrix, residuals, weights):
    penalty = (
        np.eye(matrix.shape[1], dtype=np.float64)
        * POLICY["ridgeMeanLossPenalty"]
        * weights.sum()
    )
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
        raise ValueError("non-finite fitted residual coefficients")
    return coefficients.tolist()


# fit one bounded robust blend weight
def _fit_blend_alpha(rows, residuals, weights):
    x = np.asarray(
        [
            base.number(row["challengerTemperatureC"])
            - base.number(row["priorTemperatureC"])
            for row in rows
        ],
        dtype=np.float64,
    )
    alpha = 0.0
    # run the fixed robust updates
    for _ in range(POLICY["iterations"]):
        errors = residuals - alpha * x
        robust = np.minimum(
            1.0,
            POLICY["huberDeltaC"] / np.maximum(np.abs(errors), 1e-12),
        )
        effective = weights * robust
        numerator = float(np.sum(effective * x * residuals))
        denominator = float(
            np.sum(effective * x * x)
            + POLICY["ridgeMeanLossPenalty"] * np.sum(weights)
        )
        alpha = max(
            0.0,
            min(POLICY["maximumBlendWeight"], numerator / denominator),
        )
    # reject unstable fits
    if not math.isfinite(alpha):
        raise ValueError("non-finite fitted blend weight")
    return alpha


# build one audit receipt for a fitting population
def _training_receipt(rows, prefix):
    return {
        f"{prefix}TrainingRows": len(rows),
        f"{prefix}TrainingDates": _date_count(rows),
        f"{prefix}FirstTrainingValidAt": min(
            (row["validAt"] for row in rows), default=None
        ),
        f"{prefix}LastTrainingValidAt": max(
            (row["validAt"] for row in rows), default=None
        ),
        f"{prefix}TrainingKeys": [row["key"] for row in rows],
    }


# fit residual and blend arms from frozen causal populations
def fit(rows, month, cohort, scope):
    selected_cohort = short._cohort(cohort)
    short._scope(scope)
    cutoff = base.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    residual_rows = _residual_rows(rows, month, selected_cohort, scope)
    blend_rows = _blend_rows(residual_rows)
    residual_supported = _supported(residual_rows)
    blend_supported = _supported(blend_rows)
    model = {
        "contractVersion": POLICY["contractVersion"],
        "month": month,
        "cohort": selected_cohort,
        "scope": scope,
        "residualSupported": residual_supported,
        "staticCoefficients": None,
        "adaptiveCoefficients": None,
        "residualTrainingCutoffUtc": short._format_instant(cutoff),
        **_training_receipt(residual_rows, "residual"),
        "blendSupported": blend_supported,
        "blendAlpha": None,
        "blendTrainingCutoffUtc": short._format_instant(cutoff),
        **_training_receipt(blend_rows, "blend"),
    }
    # fit residual arms after support
    if residual_supported:
        residual_weights = short.event_weights(residual_rows)
        residuals = np.asarray(
            [
                base.number(row["actualTemperatureC"])
                - base.number(row["priorTemperatureC"])
                for row in residual_rows
            ],
            dtype=np.float64,
        )
        model["staticCoefficients"] = _fit_coefficients(
            np.stack([static_features(row) for row in residual_rows]),
            residuals,
            residual_weights,
        )
        model["adaptiveCoefficients"] = _fit_coefficients(
            np.stack([adaptive_features(row) for row in residual_rows]),
            residuals,
            residual_weights,
        )
    # fit the independently supported blend
    if blend_supported:
        blend_weights = short.event_weights(blend_rows)
        blend_residuals = np.asarray(
            [
                base.number(row["actualTemperatureC"])
                - base.number(row["priorTemperatureC"])
                for row in blend_rows
            ],
            dtype=np.float64,
        )
        model["blendAlpha"] = _fit_blend_alpha(
            blend_rows, blend_residuals, blend_weights
        )
    return model


# validate model identity and cutoff provenance
def _validated_model(row, model):
    # require serialized model state
    if not isinstance(model, dict):
        raise ValueError("residual model must be an object")
    # reject contract drift
    if model.get("contractVersion") != POLICY["contractVersion"]:
        raise ValueError("residual model contract does not match")
    cohort = short._cohort(model.get("cohort"))
    scope = model.get("scope")
    short._scope(scope)
    # enforce provider identity
    if row.get("cohort") != cohort:
        raise ValueError("forecast cohort does not match residual model")
    _, run_initialized_at, valid_at, _, _ = short._scope_identity(row, scope)
    # enforce target-month selection
    if valid_at.astimezone(base.ZONE).strftime("%Y-%m") != model.get("month"):
        raise ValueError("forecast target month does not match residual model")
    residual_cutoff = base.instant(model["residualTrainingCutoffUtc"])
    blend_cutoff = base.instant(model["blendTrainingCutoffUtc"])
    # prevent fitting leakage
    if residual_cutoff >= run_initialized_at or blend_cutoff >= run_initialized_at:
        raise ValueError("model cutoff must strictly precede initialization")
    # require explicit arm support
    if not isinstance(model.get("residualSupported"), bool):
        raise ValueError("residual support flag must be boolean")
    # require explicit blend support
    if not isinstance(model.get("blendSupported"), bool):
        raise ValueError("blend support flag must be boolean")


# require one finite coefficient vector of the frozen width
def _coefficients(model, field, width):
    values = model.get(field)
    # enforce vector width
    if not isinstance(values, list) or len(values) != width:
        raise ValueError("residual coefficients do not match feature schema")
    converted = np.asarray(
        [base.number(value) for value in values], dtype=np.float64
    )
    # reject non-finite models
    if not np.isfinite(converted).all():
        raise ValueError("residual coefficients must be finite")
    return converted


# apply one half-strength bounded residual correction
def _adjust(prior, residual):
    correction = max(
        -POLICY["maximumCorrectionC"],
        min(
            POLICY["maximumCorrectionC"],
            POLICY["correctionWeight"] * base.number(residual),
        ),
    )
    return max(
        POLICY["physicalMinimumC"],
        min(POLICY["physicalMaximumC"], prior + correction),
    )


# apply one residual-stack arm inside its declared window
def predict(row, model, prior_prediction, arm):
    horizon = short._integer(row["operationalHorizonHours"], "operational horizon")
    # preserve accepted outer horizons
    if not 1 <= horizon <= 12:
        return prior_prediction
    # require a frozen arm
    if arm not in ARMS:
        raise ValueError("unsupported residual-stack arm")
    _validated_model(row, model)
    prior_supported, prior, _ = _prior_provenance(row)
    # preserve explicit baseline cold starts
    if not prior_supported:
        return prior_prediction
    supplied_prior = base.number(prior_prediction)
    # bind the supplied baseline to its provenance
    if supplied_prior != prior:
        raise ValueError("prior prediction does not match row provenance")
    # apply the conservative blend
    if arm == "conservative_blend":
        # preserve model cold starts before target inputs
        if not model["blendSupported"]:
            return prior_prediction
        challenger_supported, challenger, _ = _challenger_provenance(row)
        # preserve challenger cold starts
        if not challenger_supported:
            return prior_prediction
        alpha = base.number(model.get("blendAlpha"))
        # enforce the frozen blend bound
        if not 0 <= alpha <= POLICY["maximumBlendWeight"]:
            raise ValueError("blend weight is outside its bound")
        return max(
            POLICY["physicalMinimumC"],
            min(
                POLICY["physicalMaximumC"],
                prior + alpha * (challenger - prior),
            ),
        )
    # preserve residual cold starts
    if not model["residualSupported"]:
        return prior_prediction
    # apply the adaptive residual fit
    if arm == "residual_adaptive":
        state, *_ = _prior_state(row)
        # fall back exactly to static residual prediction
        if not state["supported"]:
            coefficients = _coefficients(model, "staticCoefficients", 10)
            return _adjust(prior, static_features(row) @ coefficients)
        coefficients = _coefficients(model, "adaptiveCoefficients", 24)
        return _adjust(prior, adaptive_features(row) @ coefficients)
    coefficients = _coefficients(model, "staticCoefficients", 10)
    return _adjust(prior, static_features(row) @ coefficients)
