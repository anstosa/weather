#!/usr/bin/env python3
"""fit one frozen research-only Tweedie rain-rate adjustment model."""

from __future__ import annotations

import datetime as dt
import json
import math
import os
from collections.abc import Iterable, Mapping
from typing import Any


# pin native thread pools
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
os.environ["BLIS_NUM_THREADS"] = "1"

import numpy as np

import humidity_research as shared
import rain_research as rain


# isolate the optional research learner
try:
    import xgboost as xgb
except Exception:
    xgb = None


CANDIDATES = ("raw", "zero", "tweedieBlend", "intensityGuard")
FEATURE_NAMES = (
    "rawPrecipitationMm",
    "log1pRawPrecipitationMm",
    "rawRelativeHumidityPercent",
    "rawTemperatureC",
    "rawWindSpeedMps",
    "rawCloudCoverPercent",
    "targetLeadHours",
    "annualSin",
    "annualCos",
    "dailySin",
    "dailyCos",
)
STATIC_PARAMETERS = {
    "objective": "reg:tweedie",
    "tweedie_variance_power": 1.5,
    "tree_method": "hist",
    "device": "cpu",
    "max_depth": 2,
    "eta": 0.05,
    "min_child_weight": 25,
    "lambda": 20,
    "subsample": 1,
    "colsample_bytree": 1,
    "seed": 20260908,
    "nthread": 1,
}
POLICY = {
    "contractVersion": "rain-rate-tweedie-research/v1",
    "policyVersion": "rain-rate-adjustment-policy/v1",
    "featureSchemaVersion": "rain-rate-features/v1",
    "productionEligible": False,
    "embargoHours": 168,
    "minimumTrainingDates": 180,
    "minimumTrainingHours": 1000,
    "minimumWetTrainingDates": 20,
    "minimumWetTrainingHours": 100,
    "wetThresholdMm": 0.1,
    "heavyThresholdsMm": [1.0, 2.5],
    "blendWeight": 0.5,
    "modelMeanMaximumMm": 30.0,
    "numBoostRound": 120,
    "requiredXgboostVersion": "3.4.1",
    "learnerParameters": STATIC_PARAMETERS,
    "target": "liquid-only mean rain rate over one complete reporting hour in mm/h",
    "limitation": "amount-only adjustment; it does not claim improved storm detection",
}


# require one row-shaped object
def _mapping(row: Any) -> Mapping[str, Any]:
    """require one mapping-shaped forecast row."""
    # reject non-object rows
    if not isinstance(row, Mapping):
        raise ValueError("rain-rate row must be an object")
    return row


# validate one optional finite covariate
def _optional_number(row: Mapping[str, Any], field: str) -> float:
    """return a finite optional covariate or a missing value."""
    value = row.get(field)
    # preserve genuinely missing forecast covariates
    if value is None:
        return math.nan
    return shared.number(value)


# validate forecast-time rain-rate inputs without reading a label
def _forecast(row: Any) -> tuple[Mapping[str, Any], dict[str, Any], float]:
    """validate one forecast identity and its available predictors."""
    value = _mapping(row)
    required = (
        "key",
        "cohort",
        "validAt",
        "targetLeadHours",
        "rawRelativeHumidityPercent",
        "rawPrecipitationMm",
    )
    # normalize missing forecast fields to one validation failure
    if any(field not in value for field in required):
        raise ValueError("rain-rate forecast fields are incomplete")
    identity = shared.forecast_identity(value)
    raw = rain.amount(value["rawPrecipitationMm"])
    wind = value.get("rawWindSpeedMps")
    # reject negative supplied wind speeds
    if wind is not None and shared.number(wind) < 0:
        raise ValueError("raw wind speed must be nonnegative")
    cloud = value.get("rawCloudCoverPercent")
    # reject out-of-range supplied cloud cover
    if cloud is not None and not 0 <= shared.number(cloud) <= 100:
        raise ValueError("raw cloud cover is outside physical bounds")
    return value, identity, raw


# build the frozen forecast-only feature vector
def features(row: Any) -> np.ndarray:
    """return current-forecast features without reading observed rain."""
    value, identity, raw = _forecast(row)
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
    return np.asarray(
        [
            raw,
            math.log1p(raw),
            identity["rawHumidity"],
            _optional_number(value, "rawTemperatureC"),
            _optional_number(value, "rawWindSpeedMps"),
            _optional_number(value, "rawCloudCoverPercent"),
            float(shared.lead_hours(value)),
            math.sin(annual),
            math.cos(annual),
            math.sin(daily),
            math.cos(daily),
        ],
        dtype=np.float64,
    )


# require the isolated frozen learner runtime
def _require_xgboost() -> None:
    """require the reviewed XGBoost version only for supported models."""
    # reject missing or unreviewed learners
    if xgb is None or xgb.__version__ != POLICY["requiredXgboostVersion"]:
        raise ValueError("XGBoost 3.4.1 research runtime is required")


# validate fit-cell selectors before inspecting rows
def _fit_cell(month: Any, cohort: Any, band: Any) -> tuple[str, str, str, dt.datetime]:
    """validate and return one frozen monthly cohort-band cell."""
    cutoff = shared.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    # reject undeclared forecast sources
    if cohort not in shared.COHORTS:
        raise ValueError("unsupported forecast cohort")
    bands = {item[0] for item in shared.LEAD_BANDS}
    # reject nonliteral lead bands
    if band not in bands:
        raise ValueError("unsupported lead band")
    return month, cohort, band, cutoff


# validate all identities and select only causally eligible labels
def _training_rows(
    rows: Iterable[Any], month: Any, cohort: Any, band: Any
) -> tuple[list[Mapping[str, Any]], dt.datetime]:
    """select unique, same-cell rows strictly before the embargo cutoff."""
    _month, selected_cohort, selected_band, cutoff = _fit_cell(
        month, cohort, band
    )
    selected: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    # validate global forecast identities before label selection
    for candidate in rows:
        row, identity, _raw = _forecast(candidate)
        key = identity["key"]
        # reject ambiguous fit identities globally
        if key in seen:
            raise ValueError("duplicate forecast key")
        seen.add(key)
        # isolate cohort, literal band, and earlier valid time before labels
        if (
            identity["cohort"] == selected_cohort
            and identity["leadBand"] == selected_band
            and identity["validAt"] < cutoff
        ):
            # reject known nonliquid training targets only after causal selection
            if row.get("liquidOnly", True) is not True:
                raise ValueError("rain-rate training target must be liquid-only")
            # normalize a missing selected label to one validation failure
            if "actualPrecipitationMm" not in row:
                raise ValueError("rain-rate training label is missing")
            rain.amount(row["actualPrecipitationMm"])
            selected.append(row)
    return selected, cutoff


# identify distinct valid hours and local dates
def _support(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    """count independent valid hours, wet hours, and local dates."""
    dates: set[str] = set()
    hours: set[dt.datetime] = set()
    wet_dates: set[str] = set()
    wet_hours: set[dt.datetime] = set()
    wet_rows = 0
    # count selected rows and collapse repeated forecast vintages
    for row in rows:
        valid_at = shared.instant(row["validAt"])
        local_date = valid_at.astimezone(shared.ZONE).date().isoformat()
        actual = rain.amount(row["actualPrecipitationMm"])
        dates.add(local_date)
        hours.add(valid_at)
        # count an observed-wet hour once regardless of vintages
        if actual >= POLICY["wetThresholdMm"]:
            wet_rows += 1
            wet_dates.add(local_date)
            wet_hours.add(valid_at)
    return {
        "trainingRows": len(rows),
        "trainingDates": len(dates),
        "trainingHours": len(hours),
        "wetTrainingRows": wet_rows,
        "wetTrainingDates": len(wet_dates),
        "wetTrainingHours": len(wet_hours),
    }


# preserve equal date and hour mass while splitting repeated vintages
def _training_weights(rows: list[Mapping[str, Any]], training_hours: int) -> np.ndarray:
    """scale balanced weights to the number of distinct valid hours."""
    weights = shared.balanced_weights(rows).astype(np.float64, copy=False)
    total = float(weights.sum())
    # reject impossible nonpositive balancing mass
    if total <= 0 or not math.isfinite(total):
        raise ValueError("training weights are invalid")
    return weights * (training_hours / total)


# create one feature-name-bound native matrix
def _dmatrix(
    matrix: np.ndarray,
    *,
    labels: np.ndarray | None = None,
    weights: np.ndarray | None = None,
) -> Any:
    """create one deterministic XGBoost matrix."""
    return xgb.DMatrix(
        matrix,
        label=labels,
        weight=weights,
        feature_names=list(FEATURE_NAMES),
        nthread=1,
    )


# validate one loaded learner against the frozen model contract
def _validate_booster(
    booster: Any,
    model: Mapping[str, Any],
    *,
    allow_normalized_training_parameters: bool = False,
) -> None:
    """reject serialized learners outside the reviewed schema and objective."""
    # require the exact feature order and boosting length
    if (
        booster.feature_names != list(FEATURE_NAMES)
        or booster.num_features() != len(FEATURE_NAMES)
        or booster.num_boosted_rounds() != POLICY["numBoostRound"]
    ):
        raise ValueError("rain-rate model feature schema or rounds do not match")
    # parse the learner-owned resolved configuration
    try:
        config = json.loads(booster.save_config())
        learner = config["learner"]
        objective = learner["objective"]
        generic = learner["generic_param"]
        gradient = learner["gradient_booster"]
        trees = gradient["gbtree_train_param"]
        tree_parameters = gradient["tree_train_param"]
        base_score = float(
            learner["learner_model_param"]["base_score"].strip("[]")
        )
        variance_power = float(
            objective["tweedie_regression_param"]["tweedie_variance_power"]
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("rain-rate model configuration is invalid") from error
    normalized_training_parameters = (
        generic["nthread"] == "0"
        and generic["seed"] == "0"
        and int(tree_parameters["max_depth"]) == 6
        and math.isclose(float(tree_parameters["eta"]), 0.3, rel_tol=1e-6)
        and math.isclose(
            float(tree_parameters["min_child_weight"]), 1.0, rel_tol=1e-6
        )
        and math.isclose(float(tree_parameters["lambda"]), 1.0, rel_tol=1e-6)
    )
    frozen_training_parameters = (
        generic["nthread"] == str(STATIC_PARAMETERS["nthread"])
        and generic["seed"] == str(STATIC_PARAMETERS["seed"])
        and int(tree_parameters["max_depth"]) == STATIC_PARAMETERS["max_depth"]
        and math.isclose(
            float(tree_parameters["eta"]), STATIC_PARAMETERS["eta"], rel_tol=1e-6
        )
        and math.isclose(
            float(tree_parameters["min_child_weight"]),
            STATIC_PARAMETERS["min_child_weight"],
            rel_tol=1e-6,
        )
        and math.isclose(
            float(tree_parameters["lambda"]),
            STATIC_PARAMETERS["lambda"],
            rel_tol=1e-6,
        )
    )
    accepted_training_parameters = frozen_training_parameters or (
        allow_normalized_training_parameters and normalized_training_parameters
    )
    # require the frozen cpu histogram Tweedie learner
    if (
        objective["name"] != STATIC_PARAMETERS["objective"]
        or variance_power != STATIC_PARAMETERS["tweedie_variance_power"]
        or generic["device"] != STATIC_PARAMETERS["device"]
        or gradient["name"] != "gbtree"
        or trees["tree_method"] not in ("hist", "auto")
        or trees["updater"] != "grow_quantile_histmaker"
        or not accepted_training_parameters
        or not math.isclose(
            float(tree_parameters["subsample"]),
            STATIC_PARAMETERS["subsample"],
            rel_tol=1e-6,
        )
        or not math.isclose(
            float(tree_parameters["colsample_bytree"]),
            STATIC_PARAMETERS["colsample_bytree"],
            rel_tol=1e-6,
        )
        or not math.isclose(base_score, float(model["baseScore"]), rel_tol=1e-6)
    ):
        raise ValueError("rain-rate model learner does not match the frozen policy")


# load the complete native model string
def _load_booster(model: Mapping[str, Any]) -> Any:
    """load and validate one serialized supported model."""
    _require_xgboost()
    model_json = model.get("modelJson")
    # reject missing serialized model material
    if not isinstance(model_json, str) or not model_json:
        raise ValueError("supported rain-rate model is missing modelJson")
    booster = xgb.Booster()
    # translate native parser failures to a stable validation error
    try:
        booster.load_model(bytearray(model_json, "utf-8"))
    except Exception as error:
        raise ValueError("rain-rate modelJson is not loadable") from error
    _validate_booster(
        booster, model, allow_normalized_training_parameters=True
    )
    return booster


# fit one source-bound causal Tweedie model
def fit(rows: Iterable[Any], month: Any, cohort: Any, band: Any) -> dict[str, Any]:
    """fit the frozen rain-rate learner or return an explicit raw fallback."""
    # require an iterable population rather than text or an object
    if isinstance(rows, (str, bytes, Mapping)):
        raise ValueError("rain-rate fit rows must be an iterable of objects")
    try:
        selected, cutoff = _training_rows(rows, month, cohort, band)
    except TypeError as error:
        raise ValueError("rain-rate fit rows must be iterable") from error
    support = _support(selected)
    latest = max(
        (shared.instant(row["validAt"]) for row in selected), default=None
    )
    supported = (
        support["trainingDates"] >= POLICY["minimumTrainingDates"]
        and support["trainingHours"] >= POLICY["minimumTrainingHours"]
        and support["wetTrainingDates"] >= POLICY["minimumWetTrainingDates"]
        and support["wetTrainingHours"] >= POLICY["minimumWetTrainingHours"]
    )
    weights = (
        _training_weights(selected, support["trainingHours"])
        if selected
        else np.asarray([], dtype=np.float64)
    )
    effective_hours = (
        float(shared.effective_valid_hour_count(selected, weights))
        if selected
        else 0.0
    )
    model: dict[str, Any] = {
        "contractVersion": POLICY["contractVersion"],
        "policyVersion": POLICY["policyVersion"],
        "featureSchemaVersion": POLICY["featureSchemaVersion"],
        "featureNames": list(FEATURE_NAMES),
        "month": month,
        "issueMonth": month,
        "cohort": cohort,
        "leadBand": band,
        "supported": supported,
        **support,
        "effectiveTrainingHours": effective_hours,
        "trainingWeightSum": float(weights.sum()),
        "trainingCutoffUtc": shared.format_instant(cutoff),
        "latestTrainingValidAt": (
            None if latest is None else shared.format_instant(latest)
        ),
        "baseScore": None,
        "xgboostVersion": None,
        "learnerParameters": None,
        "numBoostRound": POLICY["numBoostRound"],
        "modelJson": None,
    }
    # preserve exact raw fallbacks below every support floor
    if not supported:
        return model
    _require_xgboost()
    actual = np.asarray(
        [rain.amount(row["actualPrecipitationMm"]) for row in selected],
        dtype=np.float64,
    )
    matrix = np.stack([features(row) for row in selected])
    base_score = max(1e-6, float(weights @ actual / weights.sum()))
    parameters = {**STATIC_PARAMETERS, "base_score": base_score}
    booster = xgb.train(
        parameters,
        _dmatrix(matrix, labels=actual, weights=weights),
        num_boost_round=POLICY["numBoostRound"],
    )
    model.update(
        baseScore=base_score,
        xgboostVersion=xgb.__version__,
        learnerParameters=parameters,
        modelJson=booster.save_raw(raw_format="json").decode("utf-8"),
    )
    _validate_booster(booster, model)
    # prove strict json serialization before releasing the state
    json.dumps(model, allow_nan=False, separators=(",", ":"))
    return model


# validate the portable state before any prediction
def _model_state(model: Any) -> Mapping[str, Any]:
    """require one compatible, internally consistent model state."""
    # reject non-object model states
    if not isinstance(model, Mapping):
        raise ValueError("rain-rate model must be an object")
    # bind all versioned schema fields
    if (
        model.get("contractVersion") != POLICY["contractVersion"]
        or model.get("policyVersion") != POLICY["policyVersion"]
        or model.get("featureSchemaVersion") != POLICY["featureSchemaVersion"]
        or model.get("featureNames") != list(FEATURE_NAMES)
        or model.get("numBoostRound") != POLICY["numBoostRound"]
    ):
        raise ValueError("rain-rate model contract does not match")
    # require explicit model support state
    if not isinstance(model.get("supported"), bool):
        raise ValueError("rain-rate model support flag is invalid")
    # reject conflicting issue-month aliases
    if model.get("month") != model.get("issueMonth"):
        raise ValueError("rain-rate model issue month is inconsistent")
    # derive and bind the exact causal cutoff from the model month
    try:
        expected_cutoff = shared.month_start(model.get("issueMonth")) - dt.timedelta(
            hours=POLICY["embargoHours"]
        )
        cutoff = shared.instant(model.get("trainingCutoffUtc"))
    except (TypeError, ValueError) as error:
        raise ValueError("rain-rate model cutoff is invalid") from error
    # reject a cutoff shifted from the frozen embargo
    if cutoff != expected_cutoff:
        raise ValueError("rain-rate model cutoff does not match its issue month")
    count_names = (
        "trainingRows",
        "trainingDates",
        "trainingHours",
        "wetTrainingRows",
        "wetTrainingDates",
        "wetTrainingHours",
    )
    counts: dict[str, int] = {}
    # require nonnegative integer support counts
    for name in count_names:
        value = model.get(name)
        # reject missing, boolean, fractional, or negative support
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("rain-rate model support counts are invalid")
        counts[name] = value
    # require nested row, hour, and date support relationships
    if not (
        counts["trainingRows"] >= counts["trainingHours"] >= counts["trainingDates"]
        and counts["wetTrainingRows"]
        >= counts["wetTrainingHours"]
        >= counts["wetTrainingDates"]
        and counts["wetTrainingRows"] <= counts["trainingRows"]
        and counts["wetTrainingHours"] <= counts["trainingHours"]
        and counts["wetTrainingDates"] <= counts["trainingDates"]
    ):
        raise ValueError("rain-rate model support counts are inconsistent")
    # require empty and nonempty support dimensions to agree
    if (counts["trainingRows"] == 0) != (counts["trainingHours"] == 0) or (
        counts["trainingHours"] == 0
    ) != (counts["trainingDates"] == 0):
        raise ValueError("rain-rate model empty support counts are inconsistent")
    expected_support = (
        counts["trainingDates"] >= POLICY["minimumTrainingDates"]
        and counts["trainingHours"] >= POLICY["minimumTrainingHours"]
        and counts["wetTrainingDates"] >= POLICY["minimumWetTrainingDates"]
        and counts["wetTrainingHours"] >= POLICY["minimumWetTrainingHours"]
    )
    # bind the support flag to all frozen floors
    if model["supported"] != expected_support:
        raise ValueError("rain-rate model support flag does not match its counts")
    effective = model.get("effectiveTrainingHours")
    weight_sum = model.get("trainingWeightSum")
    # require finite weight metadata bounded by independent hours
    if (
        isinstance(effective, bool)
        or not isinstance(effective, (int, float))
        or not math.isfinite(effective)
        or effective < 0
        or effective > counts["trainingHours"] + 1e-9
        or (counts["trainingHours"] > 0 and effective <= 0)
        or isinstance(weight_sum, bool)
        or not isinstance(weight_sum, (int, float))
        or not math.isfinite(weight_sum)
        or not math.isclose(
            float(weight_sum), float(counts["trainingHours"]), abs_tol=1e-9
        )
    ):
        raise ValueError("rain-rate model weight support is invalid")
    latest_text = model.get("latestTrainingValidAt")
    # require no latest instant for an empty state
    if counts["trainingRows"] == 0:
        if latest_text is not None:
            raise ValueError("empty rain-rate model has a latest training instant")
    else:
        # require every nonempty state to prove its latest causal label
        try:
            latest = shared.instant(latest_text)
        except (TypeError, ValueError) as error:
            raise ValueError("rain-rate model latest training instant is invalid") from error
        # enforce the strict embargo boundary
        if latest >= cutoff:
            raise ValueError("rain-rate model latest training instant is not causal")
    # validate supported native material against its dynamic base score
    if model["supported"]:
        base_score = model.get("baseScore")
        expected_parameters = {**STATIC_PARAMETERS, "base_score": base_score}
        # require the complete frozen learner metadata
        if (
            isinstance(base_score, bool)
            or not isinstance(base_score, (int, float))
            or not math.isfinite(base_score)
            or base_score < 1e-6
            or model.get("xgboostVersion") != POLICY["requiredXgboostVersion"]
            or model.get("learnerParameters") != expected_parameters
            or not isinstance(model.get("modelJson"), str)
            or not model.get("modelJson")
        ):
            raise ValueError("supported rain-rate model material is invalid")
    else:
        # reject learner material attached to a raw-fallback state
        if any(
            model.get(name) is not None
            for name in (
                "baseScore",
                "xgboostVersion",
                "learnerParameters",
                "modelJson",
            )
        ):
            raise ValueError("unsupported rain-rate model contains learner material")
    return model


# bind one scoring row natively or through the sole frozen transfer
def _bind(row: Mapping[str, Any], identity: Mapping[str, Any], model: Mapping[str, Any], transfer: bool) -> None:
    """bind source, literal band, and issue month before prediction."""
    issue_month = shared.issue_month(row)
    # require the explicit same-band ECMWF transfer
    if transfer:
        if (
            identity["cohort"] != "best_match_single_run_transfer"
            or model.get("cohort") != "ecmwf_single_run_hindcast"
            or model.get("leadBand") != identity["leadBand"]
            or model.get("issueMonth") != issue_month
        ):
            raise ValueError("invalid rain-rate ECMWF to Best Match transfer")
        return
    # bind every native state literally
    if model.get("cohort") != identity["cohort"]:
        raise ValueError("forecast cohort does not match rain-rate model")
    # bind the literal lead band
    if model.get("leadBand") != identity["leadBand"]:
        raise ValueError("forecast lead band does not match rain-rate model")
    # bind the issue calendar month
    if model.get("issueMonth") != issue_month:
        raise ValueError("forecast issue month does not match rain-rate model")


# project one blend into the raw amount category
def intensity_guard(raw: Any, blend: Any) -> float:
    """keep wet and heavy threshold categories identical to raw rain."""
    raw_amount = rain.amount(raw)
    blend_amount = rain.amount(blend)
    # preserve exactly dry raw forecasts
    if raw_amount == 0:
        return 0.0
    # retain the dry-but-nonzero category
    if raw_amount < POLICY["wetThresholdMm"]:
        return min(
            max(0.0, blend_amount),
            math.nextafter(POLICY["wetThresholdMm"], -math.inf),
        )
    # retain the ordinary wet category
    if raw_amount < POLICY["heavyThresholdsMm"][0]:
        return min(
            max(POLICY["wetThresholdMm"], blend_amount),
            math.nextafter(POLICY["heavyThresholdsMm"][0], -math.inf),
        )
    # retain the first heavy category
    if raw_amount < POLICY["heavyThresholdsMm"][1]:
        return min(
            max(POLICY["heavyThresholdsMm"][0], blend_amount),
            math.nextafter(POLICY["heavyThresholdsMm"][1], -math.inf),
        )
    return min(500.0, max(POLICY["heavyThresholdsMm"][1], blend_amount))


# predict every frozen candidate from one exact model state
def predict_many(
    rows: Iterable[Any], model: Any, transfer: bool = False
) -> list[dict[str, float]]:
    """predict ordered rain-rate candidates without reading observed labels."""
    state = _model_state(model)
    # reject truthy nonboolean transfer switches
    if not isinstance(transfer, bool):
        raise ValueError("rain-rate transfer flag must be boolean")
    # require an iterable population rather than text or an object
    if isinstance(rows, (str, bytes, Mapping)):
        raise ValueError("rain-rate prediction rows must be iterable")
    try:
        prepared = [_forecast(row) for row in rows]
    except TypeError as error:
        raise ValueError("rain-rate prediction rows must be iterable") from error
    # bind every row before loading or applying the learner
    for row, identity, _raw in prepared:
        _bind(row, identity, state, transfer)
    # preserve ordered exact raw fallbacks for unsupported states
    if not state["supported"]:
        return [
            {
                "raw": raw,
                "zero": 0.0,
                "tweedieBlend": raw,
                "intensityGuard": raw,
            }
            for _row, _identity, raw in prepared
        ]
    # avoid native empty-matrix behavior
    if not prepared:
        return []
    booster = _load_booster(state)
    matrix = np.stack([features(row) for row, _identity, _raw in prepared])
    means = booster.predict(_dmatrix(matrix))
    # reject invalid learner output before constructing partial results
    if not np.isfinite(means).all():
        raise ValueError("rain-rate model produced non-finite predictions")
    predictions: list[dict[str, float]] = []
    # blend and threshold-project every ordered row
    for (_row, _identity, raw), predicted in zip(prepared, means, strict=True):
        model_mean = min(
            POLICY["modelMeanMaximumMm"], max(0.0, float(predicted))
        )
        blend = (1 - POLICY["blendWeight"]) * raw + POLICY["blendWeight"] * model_mean
        predictions.append(
            {
                "raw": raw,
                "zero": 0.0,
                "tweedieBlend": blend,
                "intensityGuard": intensity_guard(raw, blend),
            }
        )
    return predictions
