#!/usr/bin/env python3
"""Run the frozen XGBoost temperature-residual research bridge."""

from __future__ import annotations

import json
import math
import os
import sys
import warnings
from typing import Any


# pin native thread pools
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
os.environ["BLIS_NUM_THREADS"] = "1"


# isolate optional research dependencies
try:
    import numpy as np
    import scipy
    import xgboost as xgb
except Exception:
    np = None
    scipy = None
    xgb = None


CONTRACT_VERSION = "temperature-boosted-python-bridge/v1"
REQUIRED_XGBOOST_VERSION = "3.4.1"
FEATURE_NAMES = [
    "rawTemperatureC",
    "relativeHumidityPercent",
    "windSpeedMps",
    "targetLeadHours",
    "season_winter",
    "season_spring",
    "season_summer",
    "season_autumn",
    "daypart_night",
    "daypart_morning",
    "daypart_afternoon",
    "daypart_evening"
]
NULLABLE_FEATURE_INDEXES = frozenset((1, 2))
PARAMETERS = {
    "booster": "gbtree",
    "tree_method": "hist",
    "device": "cpu",
    "objective": "reg:absoluteerror",
    "eval_metric": "mae",
    "base_score": 0,
    "eta": 0.05,
    "max_depth": 3,
    "min_child_weight": 50,
    "grow_policy": "depthwise",
    "max_delta_step": 0,
    "lambda": 5,
    "alpha": 0,
    "gamma": 0,
    "subsample": 1,
    "sampling_method": "uniform",
    "colsample_bytree": 1,
    "colsample_bylevel": 1,
    "colsample_bynode": 1,
    "max_bin": 256,
    "nthread": 1,
    "seed": 20260906,
    "validate_parameters": True,
    "verbosity": 0
}
NUM_BOOST_ROUND = 200
FIT_KEYS = frozenset(
    (
        "featureNames",
        "trainingFeatures",
        "trainingResiduals",
        "trainingWeights",
        "trainingIds",
        "predictionFeatures",
        "predictionIds"
    )
)
PREDICT_KEYS = frozenset(("featureNames", "predictionFeatures", "predictionIds", "modelJson"))
FIT_REQUEST_KEY_ORDER = [
    "featureNames",
    "trainingFeatures",
    "trainingResiduals",
    "trainingWeights",
    "trainingIds",
    "predictionFeatures",
    "predictionIds"
]
FIT_RESPONSE_KEY_ORDER = ["modelJson", "configJson", "predictedResiduals", "predictionIds"]
PREDICT_REQUEST_KEY_ORDER = ["featureNames", "predictionFeatures", "predictionIds", "modelJson"]
PREDICT_RESPONSE_KEY_ORDER = ["predictedResiduals", "predictionIds"]


class BridgeInputError(Exception):
    """Represent a safe input-validation failure."""


# require the frozen runtime
def require_dependencies() -> None:
    """Require the isolated research dependency versions."""
    # reject unavailable packages
    if np is None or scipy is None or xgb is None:
        raise BridgeInputError("required research dependencies are unavailable")

    # reject an unreviewed learner version
    if xgb.__version__ != REQUIRED_XGBOOST_VERSION:
        raise BridgeInputError("unsupported xgboost version")


# parse without permissive constants
def parse_request() -> Any:
    """Parse one strict JSON request from standard input."""
    # reject non-json numeric constants
    def reject_constant(_value: str) -> None:
        raise ValueError("non-finite json number")

    # parse the complete request
    try:
        return json.loads(sys.stdin.read(), parse_constant=reject_constant)
    except (json.JSONDecodeError, UnicodeError, ValueError) as error:
        raise BridgeInputError("invalid json input") from error


# require an exact object shape
def validate_object_keys(value: Any, keys: frozenset[str], label: str) -> dict[str, Any]:
    """Validate an exact request-object schema."""
    # require an object
    if not isinstance(value, dict):
        raise BridgeInputError(f"{label} must be an object")

    # reject missing and extra fields
    if frozenset(value.keys()) != keys:
        raise BridgeInputError(f"{label} keys do not match the contract")

    return value


# require the fixed feature order
def validate_feature_names(value: Any) -> None:
    """Validate the frozen ordered feature schema."""
    # reject alternate feature sets or ordering
    if value != FEATURE_NAMES:
        raise BridgeInputError("featureNames do not match the frozen schema")


# identify json numbers without booleans
def is_json_number(value: Any) -> bool:
    """Return whether a value is a finite JSON-number candidate."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# validate a dense feature matrix
def validate_feature_matrix(value: Any, label: str) -> Any:
    """Validate and convert a feature matrix to float32."""
    # require a row list
    if not isinstance(value, list):
        raise BridgeInputError(f"{label} must be an array")

    converted: list[list[float]] = []

    # validate every row without echoing values
    for row in value:
        # require the exact matrix width
        if not isinstance(row, list) or len(row) != len(FEATURE_NAMES):
            raise BridgeInputError(f"{label} rows must match the feature schema")

        converted_row: list[float] = []

        # validate every feature cell
        for index, cell in enumerate(row):
            # map only allowed missing features
            if cell is None:
                # reject missing required features
                if index not in NULLABLE_FEATURE_INDEXES:
                    raise BridgeInputError(f"{label} contains a disallowed null")

                converted_row.append(math.nan)
                continue

            # reject non-numeric cells
            if not is_json_number(cell) or not math.isfinite(float(cell)):
                raise BridgeInputError(f"{label} contains a non-finite or non-numeric value")

            converted_row.append(float(cell))

        converted.append(converted_row)

    # suppress safe overflow diagnostics before explicit rejection
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        matrix = np.asarray(converted, dtype=np.float32)

    # preserve the shape of an empty matrix
    if not converted:
        matrix = np.empty((0, len(FEATURE_NAMES)), dtype=np.float32)

    # reject float32 overflow while preserving missing values
    if np.isinf(matrix).any():
        raise BridgeInputError(f"{label} contains a value outside float32 range")

    return matrix


# validate a finite numeric vector
def validate_vector(value: Any, label: str, *, positive: bool = False) -> Any:
    """Validate and convert a finite numeric vector to float32."""
    # require a value list
    if not isinstance(value, list):
        raise BridgeInputError(f"{label} must be an array")

    converted: list[float] = []

    # validate every vector value
    for cell in value:
        # reject non-numeric and non-finite values
        if not is_json_number(cell) or not math.isfinite(float(cell)):
            raise BridgeInputError(f"{label} contains a non-finite or non-numeric value")

        number = float(cell)

        # require positive training weights
        if positive and number <= 0:
            raise BridgeInputError(f"{label} must contain only positive values")

        converted.append(number)

    # suppress safe overflow diagnostics before explicit rejection
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        vector = np.asarray(converted, dtype=np.float32)

    # reject float32 overflow
    if np.isinf(vector).any():
        raise BridgeInputError(f"{label} contains a value outside float32 range")

    # reject positive weights lost during float32 conversion
    if positive and (vector <= 0).any():
        raise BridgeInputError(f"{label} contains a value outside positive float32 range")

    return vector


# validate row identifiers
def validate_ids(value: Any, label: str, expected_length: int) -> list[str]:
    """Validate ordered, unique, nonempty row identifiers."""
    # require an identifier list
    if not isinstance(value, list):
        raise BridgeInputError(f"{label} must be an array")

    # require one identifier per row
    if len(value) != expected_length:
        raise BridgeInputError(f"{label} length must match its feature rows")

    # reject non-string and empty identifiers
    if any(not isinstance(identifier, str) or len(identifier) == 0 for identifier in value):
        raise BridgeInputError(f"{label} must contain nonempty strings")

    # reject ambiguous identifier reuse
    if len(set(value)) != len(value):
        raise BridgeInputError(f"{label} must contain unique strings")

    return value


# build a schema-bound xgboost matrix
def create_dmatrix(features: Any, *, labels: Any = None, weights: Any = None) -> Any:
    """Create a deterministic, schema-bound XGBoost matrix."""
    return xgb.DMatrix(
        features,
        label=labels,
        weight=weights,
        feature_names=FEATURE_NAMES,
        nthread=1
    )


# validate finite model predictions
def prediction_list(predictions: Any) -> list[float]:
    """Convert model predictions to finite Python floats."""
    # reject invalid learner output
    if not np.isfinite(predictions).all():
        raise BridgeInputError("model produced a non-finite prediction")

    return predictions.astype(float).tolist()


# validate the resolved native learner
def validate_booster(booster: Any, *, allow_normalized_tree_method: bool = False) -> str:
    """Validate the trained or loaded native learner configuration."""
    # require the fixed feature schema
    if booster.feature_names != FEATURE_NAMES or booster.num_features() != len(FEATURE_NAMES):
        raise BridgeInputError("modelJson feature schema does not match the frozen schema")

    # require the fixed boosting length
    if booster.num_boosted_rounds() != NUM_BOOST_ROUND:
        raise BridgeInputError("model boosting rounds do not match the frozen learner")

    config_json = booster.save_config()

    # parse xgboost's resolved configuration
    try:
        config = json.loads(config_json)
        learner = config["learner"]
        generic_parameters = learner["generic_param"]
        gradient_booster = learner["gradient_booster"]
        tree_parameters = gradient_booster["gbtree_train_param"]
        objective = learner["objective"]
        base_score_text = learner["learner_model_param"]["base_score"]
        base_score = float(base_score_text.strip("[]"))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise BridgeInputError("model configuration is not compatible with the frozen learner") from error

    expected_tree_methods = ("hist", "auto") if allow_normalized_tree_method else ("hist",)

    # require the resolved cpu histogram learner
    if (
        generic_parameters["device"] != "cpu"
        or gradient_booster["name"] != "gbtree"
        or tree_parameters["tree_method"] not in expected_tree_methods
        or tree_parameters["updater"] != "grow_quantile_histmaker"
    ):
        raise BridgeInputError("model execution mode does not match the frozen learner")

    # require the frozen objective and intercept
    if objective["name"] != "reg:absoluteerror" or base_score != 0.0:
        raise BridgeInputError("model objective does not match the frozen learner")

    return config_json


# train the fixed learner
def fit_model(request: Any) -> dict[str, Any]:
    """Fit the frozen learner and predict the requested rows."""
    payload = validate_object_keys(request, FIT_KEYS, "fit request")
    validate_feature_names(payload["featureNames"])
    training_features = validate_feature_matrix(payload["trainingFeatures"], "trainingFeatures")
    training_residuals = validate_vector(payload["trainingResiduals"], "trainingResiduals")
    training_weights = validate_vector(payload["trainingWeights"], "trainingWeights", positive=True)
    prediction_features = validate_feature_matrix(payload["predictionFeatures"], "predictionFeatures")
    validate_ids(payload["trainingIds"], "trainingIds", training_features.shape[0])
    prediction_ids = validate_ids(payload["predictionIds"], "predictionIds", prediction_features.shape[0])

    # require training data
    if training_features.shape[0] == 0:
        raise BridgeInputError("trainingFeatures must not be empty")

    # require aligned training arrays
    if not (
        training_features.shape[0]
        == training_residuals.shape[0]
        == training_weights.shape[0]
    ):
        raise BridgeInputError("training arrays must have equal lengths")

    training_matrix = create_dmatrix(
        training_features,
        labels=training_residuals,
        weights=training_weights
    )
    booster = xgb.train(PARAMETERS, training_matrix, num_boost_round=NUM_BOOST_ROUND)
    config_json = validate_booster(booster)
    model_json = booster.save_raw(raw_format="json").decode("utf-8")

    # avoid undefined empty-matrix prediction behavior
    if prediction_features.shape[0] == 0:
        predictions: list[float] = []
    else:
        prediction_matrix = create_dmatrix(prediction_features)
        predictions = prediction_list(booster.predict(prediction_matrix))

    return {
        "modelJson": model_json,
        "configJson": config_json,
        "predictedResiduals": predictions,
        "predictionIds": prediction_ids
    }


# load and verify a native model
def load_model(model_json: Any) -> Any:
    """Load a native XGBoost JSON model with the frozen schema."""
    # require an in-memory native model string
    if not isinstance(model_json, str) or not model_json:
        raise BridgeInputError("modelJson must be a non-empty string")

    booster = xgb.Booster()

    # translate native parser failures safely
    try:
        booster.load_model(bytearray(model_json, "utf-8"))
    except Exception as error:
        raise BridgeInputError("modelJson is not a loadable native model") from error

    validate_booster(booster, allow_normalized_tree_method=True)

    return booster


# predict from an existing model
def predict_model(request: Any) -> dict[str, Any]:
    """Load a frozen-schema model and predict requested rows."""
    payload = validate_object_keys(request, PREDICT_KEYS, "predict request")
    validate_feature_names(payload["featureNames"])
    prediction_features = validate_feature_matrix(payload["predictionFeatures"], "predictionFeatures")
    prediction_ids = validate_ids(payload["predictionIds"], "predictionIds", prediction_features.shape[0])
    booster = load_model(payload["modelJson"])

    # avoid undefined empty-matrix prediction behavior
    if prediction_features.shape[0] == 0:
        predictions: list[float] = []
    else:
        prediction_matrix = create_dmatrix(prediction_features)
        predictions = prediction_list(booster.predict(prediction_matrix))

    return {"predictedResiduals": predictions, "predictionIds": prediction_ids}


# describe the frozen bridge
def describe_bridge() -> dict[str, Any]:
    """Describe the stable bridge contract and runtime packages."""
    return {
        "contractVersion": CONTRACT_VERSION,
        "featureNames": FEATURE_NAMES,
        "interface": {
            "fitRequestKeys": FIT_REQUEST_KEY_ORDER,
            "fitResponseKeys": FIT_RESPONSE_KEY_ORDER,
            "predictRequestKeys": PREDICT_REQUEST_KEY_ORDER,
            "predictResponseKeys": PREDICT_RESPONSE_KEY_ORDER,
            "identifiers": "ordered unique nonempty strings aligned with rows and echoed unchanged"
        },
        "learner": {
            "parameters": PARAMETERS,
            "numBoostRound": NUM_BOOST_ROUND
        },
        "packageVersions": {
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "xgboost": xgb.__version__
        }
    }


# emit one complete json response
def emit_response(response: dict[str, Any]) -> None:
    """Write one strict JSON response after complete serialization."""
    serialized = json.dumps(response, allow_nan=False, separators=(",", ":"))
    sys.stdout.write(f"{serialized}\n")


# route the strict command surface
def main() -> int:
    """Run one bridge command with safe errors and atomic stdout."""
    # validate dependencies before handling commands
    try:
        require_dependencies()

        # describe the frozen learner
        if sys.argv[1:] == ["--describe"]:
            response = describe_bridge()
        # replay a supplied native model
        elif sys.argv[1:] == ["--predict"]:
            response = predict_model(parse_request())
        # fit the frozen learner
        elif not sys.argv[1:]:
            response = fit_model(parse_request())
        else:
            raise BridgeInputError("unsupported command arguments")

        emit_response(response)
        return 0
    except BridgeInputError as error:
        sys.stderr.write(f"error: {error}\n")
        return 2
    except Exception:
        sys.stderr.write("error: bridge execution failed\n")
        return 2


# execute only as a command
if __name__ == "__main__":
    raise SystemExit(main())
