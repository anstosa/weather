"""exercise an independent constrained refit before historical outcomes."""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import rain_monotone as producer
import verify_rain_monotone as verify


# make all four native objectives supported across older fitted dates
def fitted_examples():
    hours = np.asarray([day * 24 + hour for day in range(30) for hour in range(5)], dtype=np.int64)
    actual = np.tile(np.asarray([0., .2, .5, 1.5, 3.]), 30)
    generator = np.random.default_rng(20260913)
    features = generator.normal(size=(len(hours), 107)).astype(np.float32)
    features[:, 5] = actual.astype(np.float32)
    features[:, 6] = np.log1p(actual).astype(np.float32)
    return features, actual, hours


# compare only synthetic local fits with the independent implementation
class MonotoneReplayTests(unittest.TestCase):
    # precisely two original rain columns have a positive shape constraint
    def test_fixed_feature_constraint_and_arm_surface(self):
        self.assertEqual(len(verify.CONSTRAINTS), 107)
        self.assertEqual([index for index, value in enumerate(verify.CONSTRAINTS) if value], [5, 6])
        self.assertEqual(producer.POLICY["monotoneConstraints"], list(verify.CONSTRAINTS))
        self.assertEqual(producer.POLICY["parameters"], {**producer.parent.POLICY["parameters"], "monotone_constraints": list(verify.CONSTRAINTS)})
        self.assertEqual((len(verify.ARMS), verify.ARMS[-2:]), (15, ("windOriginal", verify.PRIMARY)))

    # all four independent live fits must reproduce frozen native bytes
    def test_four_head_live_refit_matches_producer_bytes(self):
        features, actual, hours = fitted_examples()
        names = verify.POLICY["featureNames"]
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "monotone-models" / "2026-01"
            produced, produced_state = producer.fit_monotone(features, actual, hours, directory, names, 2)
            # two rounds keep the same native fitting contract but bound synthetic runtime
            with patch.object(verify, "ROUNDS", 2):
                replayed, replayed_state = verify.refit_heads(root, features, names, actual, hours, "2026-01")
            self.assertEqual(replayed_state, produced_state)
            self.assertEqual(set(replayed), {"0.1", "1.0", "2.5", "amount"})
            # all four native objectives retain the same live shape prior
            for name in replayed:
                self.assertIsNotNone(replayed[name])
                self.assertEqual(replayed_state["heads"][name]["liveMonotoneConstraints"], verify.LIVE_CONSTRAINT_CONFIG)
                self.assertEqual(replayed[name].save_raw(raw_format="json"), produced[name].save_raw(raw_format="json"))

    # changed serialized bytes cannot be accepted by an identical live refit
    def test_native_model_tamper_fails_closed(self):
        features, actual, hours = fitted_examples()
        names = verify.POLICY["featureNames"]
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "monotone-models" / "2026-01"
            producer.fit_monotone(features, actual, hours, directory, names, 2)
            path = directory / "event-0.1.json"
            path.write_bytes(path.read_bytes() + b" ")
            # SHA comparison precedes accepting any reported native state
            with patch.object(verify, "ROUNDS", 2), self.assertRaises(ValueError):
                verify.refit_heads(root, features, names, actual, hours, "2026-01")

    # a no-constraint trainer cannot satisfy the live configuration proof
    def test_unconstrained_live_fit_is_rejected(self):
        features, actual, hours = fitted_examples()
        names = verify.POLICY["featureNames"]
        original_train = verify.xgb.train

        # remove just the changed learner parameter from one synthetic native fit
        def unconstrained(parameters, matrix, num_boost_round):
            return original_train({key: value for key, value in parameters.items() if key != "monotone_constraints"}, matrix, num_boost_round=num_boost_round)

        with TemporaryDirectory() as temporary, patch.object(verify, "ROUNDS", 2), patch.object(verify.xgb, "train", side_effect=unconstrained), self.assertRaisesRegex(ValueError, "constraint not applied"):
            verify.refit_heads(Path(temporary), features, names, actual, hours, "2026-01")

    # replay never reads evaluation labels while reconstructing a month
    def test_month_replay_uses_only_earlier_outcomes(self):
        features, actual_fit, hours_fit = fitted_examples()
        actual_cal, hours_cal = actual_fit.copy(), hours_fit + 1000
        size = len(actual_fit) + len(actual_cal) + 2
        data = {
            "actual": np.concatenate((actual_fit, actual_cal, [np.nan, np.nan])),
            "hour": np.concatenate((hours_fit, hours_cal, [2000, 2001])),
            "raw": np.zeros(size),
        }
        masks = [np.zeros(size, dtype=bool) for _ in range(3)]
        masks[0][:len(actual_fit)] = True
        masks[1][len(actual_fit):-2] = True
        masks[2][-2:] = True
        bounds = {"month": "2026-01", "calibrationMaximumValidHourExclusive": 1800}
        counts = {"training": verify.support(actual_fit, hours_fit), "calibration": verify.support(actual_cal, hours_cal)}
        mass = verify.recent_weights(hours_cal, bounds["calibrationMaximumValidHourExclusive"])
        effective = verify.effective_support(actual_cal, hours_cal, mass)
        old_state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": True}
        model_state = {"featureNames": verify.POLICY["featureNames"], "rounds": 2, "monotoneConstraints": list(verify.CONSTRAINTS), "heads": {}}
        proposed, rules, calibration_state = [{"cutoff": .2}], [{"cutoff": .2}], {"scale": 1.}
        state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": True, "model": model_state, "proposedRules": proposed, "uniformRules": rules, "nestingSafetyFallback": False, "calibration": calibration_state, "reason": "monotone_wind_hurdle_calibrated"}
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "wind-states").mkdir()
            (root / "monotone-states").mkdir()
            parent_path = root / "wind-states/2026-01.json"
            parent_path.write_text(json.dumps(old_state))
            state["parentStateSha256"] = verify.sha(parent_path)
            (root / "monotone-states/2026-01.json").write_text(json.dumps(state))
            matrix = np.zeros((size, 107), dtype=np.float32)
            matrix[:len(features)] = features
            controls = np.array([.3, .5])
            permissive = {**verify.POLICY, "trainingSupport": {}, "calibrationSupport": {}, "effectiveSupport": {}}
            models = {name: object() for name in ("0.1", "1.0", "2.5", "amount")}
            probabilities = np.tile([.4, .2, .05], (len(actual_cal), 1))
            outcomes = [(probabilities, np.ones(len(actual_cal))), (probabilities[:2], np.ones(2))]
            # isolate native outputs while keeping actual fit/cal calculations real
            with patch.object(verify, "POLICY", permissive), patch.object(verify, "month_masks", return_value=(*masks, bounds)), patch.object(verify, "refit_heads", return_value=(models, model_state)), patch.object(verify, "native_predict", side_effect=outcomes), patch.object(verify.wind, "ordinal_rules", return_value=proposed), patch.object(verify.wind, "checked_rules", return_value=(rules, False)), patch.object(verify.wind, "calibrate_hurdle", return_value=calibration_state), patch.object(verify.wind, "predict_hurdle", return_value=controls):
                rows, predicted, observed = verify.replay_month(root, data, matrix, verify.POLICY["featureNames"], {}, "2026-01", controls)
            np.testing.assert_array_equal(rows, [size - 2, size - 1])
            np.testing.assert_array_equal(predicted, controls)
            self.assertEqual(observed, state)

    # report construction retains all baseline aliases and only one primary
    def test_fifteen_arm_report_and_unchanged_gate_count(self):
        data = {"hour": np.array([24, 25]), "mean": np.array([.2, 1.]), "actual": np.array([.2, 1.])}
        indices = np.array([0, 1])
        amounts = {name: np.array([.2, 1.]) for name in verify.ARMS}
        flags = np.ones(2, dtype=bool)
        source = {"normalizedSha256": "a" * 64, "newUnresolvedRuns": 0, "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 0, "qualified": True}}}
        availability = {"windVectorAvailable": np.array([True, False])}
        screen = {"gates": {f"gate{index}": True for index in range(49)}, "passed": False}
        # isolate metric plumbing but assert the complete report schema
        with TemporaryDirectory() as temporary, patch.object(verify.goal, "recomputed_scores", return_value={"overall": {}}), patch.object(verify.goal, "gate_view", return_value={}), patch.object(verify.goal, "independent_gate", return_value=screen), patch.object(verify, "metrics", return_value={}), patch.object(verify, "sha", return_value="b" * 64):
            report = verify.expected_report(Path(temporary), data, {}, indices, amounts, flags, {}, availability, source)
        self.assertEqual(report["referenceParity"]["arms"]["windOriginal"], verify.wind.PRIMARY)
        self.assertEqual((report["nativeModelsFit"], report["nativeModelsReused"]), (0, 0))
        self.assertTrue(report["exploratoryOnly"])
        self.assertEqual(len(report["candidateScreen"]["gates"]), 49)
        self.assertIsNone(report["selectedCandidate"])


# run only synthetic local replay tests without historical fitting
if __name__ == "__main__":
    unittest.main()
