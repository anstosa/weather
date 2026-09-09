#!/usr/bin/env python3
"""Test the isolated XGBoost temperature-residual research bridge."""

from __future__ import annotations

import json
import math
from pathlib import Path
import subprocess
import sys
import unittest


BRIDGE = Path(__file__).with_name("temperature_boosted.py")
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
EXPECTED_PARAMETERS = {
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


# run the bridge in the external runtime
def run_bridge(
    payload: object | None = None,
    *arguments: str,
    raw_input: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Run one isolated bridge process and capture its complete streams."""
    # serialize ordinary requests strictly
    if raw_input is None:
        raw_input = "" if payload is None else json.dumps(payload, allow_nan=False)

    return subprocess.run(
        [sys.executable, str(BRIDGE), *arguments],
        input=raw_input,
        capture_output=True,
        check=False,
        text=True
    )


# decode one successful response
def successful_json(process: subprocess.CompletedProcess[str]) -> dict[str, object]:
    """Assert bridge success and decode its single JSON response."""
    # surface complete diagnostics on failure
    if process.returncode != 0:
        raise AssertionError(f"bridge failed: {process.stderr}")

    if process.stderr:
        raise AssertionError(f"bridge wrote stderr: {process.stderr}")

    return json.loads(process.stdout)


# build one valid feature row
def feature_row(
    raw_temperature: float,
    humidity: float | None,
    wind_speed: float | None,
    lead_hours: float,
    season: int,
    daypart: int
) -> list[float | None]:
    """Build one feature row under the frozen one-hot schema."""
    seasons = [0.0, 0.0, 0.0, 0.0]
    dayparts = [0.0, 0.0, 0.0, 0.0]
    seasons[season] = 1.0
    dayparts[daypart] = 1.0
    return [raw_temperature, humidity, wind_speed, lead_hours, *seasons, *dayparts]


# assemble a valid fit request
def fit_request(
    training_features: list[list[float | None]],
    training_residuals: list[float],
    prediction_features: list[list[float | None]]
) -> dict[str, object]:
    """Build one exact-schema fit request."""
    # align deterministic training identifiers
    training_ids = [f"train-{index}" for index in range(len(training_features))]

    # align deterministic prediction identifiers
    prediction_ids = [f"predict-{index}" for index in range(len(prediction_features))]

    return {
        "featureNames": FEATURE_NAMES,
        "trainingFeatures": training_features,
        "trainingResiduals": training_residuals,
        "trainingWeights": [1.0] * len(training_features),
        "trainingIds": training_ids,
        "predictionFeatures": prediction_features,
        "predictionIds": prediction_ids
    }


class TemperatureBoostedContractTest(unittest.TestCase):
    """Verify the command contract and strict input policy."""

    # verify stable describe metadata
    def test_describe_reports_frozen_contract(self) -> None:
        """Report only stable contract, learner, and package metadata."""
        description = successful_json(run_bridge(None, "--describe"))

        self.assertEqual(
            set(description),
            {"contractVersion", "featureNames", "interface", "learner", "packageVersions"}
        )
        self.assertEqual(
            description["contractVersion"],
            "temperature-boosted-python-bridge/v1"
        )
        self.assertEqual(description["featureNames"], FEATURE_NAMES)
        self.assertEqual(
            description["learner"],
            {"parameters": EXPECTED_PARAMETERS, "numBoostRound": 200}
        )
        self.assertEqual(
            description["interface"],
            {
                "fitRequestKeys": [
                    "featureNames",
                    "trainingFeatures",
                    "trainingResiduals",
                    "trainingWeights",
                    "trainingIds",
                    "predictionFeatures",
                    "predictionIds"
                ],
                "fitResponseKeys": [
                    "modelJson",
                    "configJson",
                    "predictedResiduals",
                    "predictionIds"
                ],
                "predictRequestKeys": [
                    "featureNames",
                    "predictionFeatures",
                    "predictionIds",
                    "modelJson"
                ],
                "predictResponseKeys": ["predictedResiduals", "predictionIds"],
                "identifiers": (
                    "ordered unique nonempty strings aligned with rows and echoed unchanged"
                )
            }
        )
        self.assertEqual(
            description["packageVersions"],
            {"numpy": "2.5.3", "scipy": "1.18.1", "xgboost": "3.4.1"}
        )

    # reject malformed requests without disclosure
    def test_rejects_invalid_fit_inputs_without_partial_stdout(self) -> None:
        """Reject extra fields, invalid cells, and misaligned training vectors."""
        rows = [feature_row(10.0, 70.0, 3.0, 24.0, 0, 0)]
        valid = fit_request(rows, [1.0], rows)
        cases: list[tuple[str, str]] = []

        extra = dict(valid)
        extra["scoreLabels"] = [987654.321]
        cases.append(("extra field", json.dumps(extra)))

        wrong_names = dict(valid)
        wrong_names["featureNames"] = list(reversed(FEATURE_NAMES))
        cases.append(("feature order", json.dumps(wrong_names)))

        wrong_null = fit_request(
            [feature_row(10.0, 70.0, 3.0, 24.0, 0, 0)],
            [1.0],
            rows
        )
        wrong_null["trainingFeatures"][0][0] = None
        cases.append(("null policy", json.dumps(wrong_null)))

        nonpositive = fit_request(rows, [1.0], rows)
        nonpositive["trainingWeights"] = [0.0]
        cases.append(("positive weights", json.dumps(nonpositive)))

        underflow_weight = fit_request(rows, [1.0], rows)
        underflow_weight["trainingWeights"] = [1e-300]
        cases.append(("float32 positive weights", json.dumps(underflow_weight)))

        misaligned = fit_request(rows, [1.0, 2.0], rows)
        cases.append(("aligned arrays", json.dumps(misaligned)))

        duplicate_ids = fit_request(rows * 2, [1.0, 1.0], rows)
        duplicate_ids["trainingIds"] = ["same", "same"]
        cases.append(("unique ids", json.dumps(duplicate_ids)))

        wrong_id_count = fit_request(rows, [1.0], rows)
        wrong_id_count["predictionIds"] = []
        cases.append(("aligned ids", json.dumps(wrong_id_count)))

        empty = fit_request([], [], rows)
        cases.append(("nonempty training", json.dumps(empty)))

        cases.append(("nonfinite json", '{"raw":NaN,"sentinel":987654.321}'))

        # verify every static invalid case
        for label, raw_input in cases:
            with self.subTest(label=label):
                process = run_bridge(raw_input=raw_input)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(process.stdout, "")
                self.assertTrue(process.stderr.startswith("error: "))
                self.assertNotIn("987654.321", process.stderr)


class TemperatureBoostedModelTest(unittest.TestCase):
    """Verify deterministic training, learning, and native replay."""

    interaction_predictions = [
        feature_row(5.0, 45.0, 2.0, 12.0, 0, 0),
        feature_row(5.0, 85.0, 2.0, 12.0, 0, 0),
        feature_row(25.0, 45.0, 2.0, 12.0, 0, 0),
        feature_row(25.0, 85.0, 2.0, 12.0, 0, 0)
    ]
    first_interaction_result: dict[str, object]
    second_interaction_result: dict[str, object]
    constant_result: dict[str, object]

    # perform only three bounded fits
    @classmethod
    def setUpClass(cls) -> None:
        """Fit two deterministic interaction models and one constant model."""
        interaction_rows: list[list[float | None]] = []
        interaction_residuals: list[float] = []

        # create four supported interaction groups
        for index in range(240):
            hot = index % 4 >= 2
            humid = index % 2 == 1
            raw_temperature = (22.0 if hot else 8.0) + index / 1000.0
            humidity = (82.0 if humid else 48.0) + (index % 7) / 100.0
            interaction_rows.append(
                feature_row(
                    raw_temperature,
                    humidity,
                    1.0 + (index % 13) / 10.0,
                    6.0 + index / 10.0,
                    index % 4,
                    (index // 4) % 4
                )
            )
            interaction_residuals.append(3.0 if hot and humid else -1.0)

        interaction_request = fit_request(
            interaction_rows,
            interaction_residuals,
            cls.interaction_predictions
        )
        cls.first_interaction_result = successful_json(run_bridge(interaction_request))
        cls.second_interaction_result = successful_json(run_bridge(interaction_request))

        constant_rows: list[list[float | None]] = []

        # create unique rows with nullable weather inputs
        for index in range(220):
            humidity = None if index % 11 == 0 else 40.0 + index % 50
            wind_speed = None if index % 17 == 0 else 0.5 + (index % 20) / 4.0
            constant_rows.append(
                feature_row(
                    -5.0 + index / 8.0,
                    humidity,
                    wind_speed,
                    1.0 + index / 3.0,
                    index % 4,
                    (index // 4) % 4
                )
            )

        constant_request = fit_request(
            constant_rows,
            [2.75] * len(constant_rows),
            []
        )
        cls.constant_result = successful_json(run_bridge(constant_request))

    # verify exact deterministic artifacts
    def test_two_fits_are_byte_deterministic(self) -> None:
        """Produce identical native models, configs, and predictions."""
        self.assertEqual(self.first_interaction_result, self.second_interaction_result)
        self.assertEqual(
            set(self.first_interaction_result),
            {"modelJson", "configJson", "predictedResiduals", "predictionIds"}
        )
        self.assertEqual(
            self.first_interaction_result["predictionIds"],
            ["predict-0", "predict-1", "predict-2", "predict-3"]
        )
        json.loads(self.first_interaction_result["modelJson"])
        json.loads(self.first_interaction_result["configJson"])

    # verify a supported nonlinear interaction
    def test_learns_nontrivial_temperature_humidity_interaction(self) -> None:
        """Learn a conjunction that independent fixed corrections cannot express."""
        predictions = self.first_interaction_result["predictedResiduals"]
        self.assertEqual(len(predictions), 4)
        self.assertGreater(predictions[3], predictions[0] + 2.0)
        self.assertGreater(predictions[3], predictions[1] + 2.0)
        self.assertGreater(predictions[3], predictions[2] + 2.0)

    # verify a simple residual baseline
    def test_learns_constant_residual_on_unique_rows(self) -> None:
        """Learn a constant residual from more than two hundred unique rows."""
        self.assertEqual(self.constant_result["predictedResiduals"], [])
        self.assertEqual(self.constant_result["predictionIds"], [])
        prediction_rows = [
            feature_row(-5.0, None, None, 1.0, 0, 0),
            feature_row(8.625, 49.0, 2.75, 37.333, 1, 3),
            feature_row(22.375, 59.0, 5.25, 74.0, 3, 2)
        ]
        replay_request = {
            "featureNames": FEATURE_NAMES,
            "predictionFeatures": prediction_rows,
            "predictionIds": ["constant-first", "constant-middle", "constant-last"],
            "modelJson": self.constant_result["modelJson"]
        }
        predictions = successful_json(run_bridge(replay_request, "--predict"))["predictedResiduals"]

        # verify every representative prediction
        for prediction in predictions:
            self.assertTrue(math.isclose(prediction, 2.75, abs_tol=0.15))

    # verify native model replay and empty predictions
    def test_native_json_reload_reproduces_predictions(self) -> None:
        """Reload the native model and reproduce predictions without fitting."""
        model_json = self.first_interaction_result["modelJson"]
        replay_ids = ["replay-0", "replay-1", "replay-2", "replay-3"]
        replay_request = {
            "featureNames": FEATURE_NAMES,
            "predictionFeatures": self.interaction_predictions,
            "predictionIds": replay_ids,
            "modelJson": model_json
        }
        replay = successful_json(run_bridge(replay_request, "--predict"))
        self.assertEqual(
            replay,
            {
                "predictedResiduals": self.first_interaction_result["predictedResiduals"],
                "predictionIds": replay_ids
            }
        )

        empty_request = {
            "featureNames": FEATURE_NAMES,
            "predictionFeatures": [],
            "predictionIds": [],
            "modelJson": model_json
        }
        self.assertEqual(
            successful_json(run_bridge(empty_request, "--predict")),
            {"predictedResiduals": [], "predictionIds": []}
        )

    # reject malformed and schema-mismatched models
    def test_rejects_invalid_native_models_without_partial_stdout(self) -> None:
        """Reject malformed and alternate-schema native model JSON."""
        malformed_request = {
            "featureNames": FEATURE_NAMES,
            "predictionFeatures": self.interaction_predictions,
            "predictionIds": ["malformed-0", "malformed-1", "malformed-2", "malformed-3"],
            "modelJson": '{"sentinel":987654.321}'
        }
        malformed = run_bridge(malformed_request, "--predict")
        self.assertNotEqual(malformed.returncode, 0)
        self.assertEqual(malformed.stdout, "")
        self.assertNotIn("987654.321", malformed.stderr)

        mismatched_document = json.loads(self.first_interaction_result["modelJson"])
        mismatched_document["learner"]["feature_names"][0] = "alternateTemperature"
        mismatched_request = {
            "featureNames": FEATURE_NAMES,
            "predictionFeatures": self.interaction_predictions,
            "predictionIds": ["mismatched-0", "mismatched-1", "mismatched-2", "mismatched-3"],
            "modelJson": json.dumps(mismatched_document, separators=(",", ":"))
        }
        mismatched = run_bridge(mismatched_request, "--predict")
        self.assertNotEqual(mismatched.returncode, 0)
        self.assertEqual(mismatched.stdout, "")
        self.assertIn("feature schema", mismatched.stderr)


# run the standard-library suite
if __name__ == "__main__":
    unittest.main()
