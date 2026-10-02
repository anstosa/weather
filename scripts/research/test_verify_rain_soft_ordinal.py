"""exercise independent soft-ordinal bin and calibration replay."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import rain_soft_ordinal_calibration as producer
import verify_rain_soft_ordinal as verify


# construct all wet bins across dates with unequal vintage occupancy
def fitted_examples():
    actual, hours = [], []
    # the first wet bin intentionally has a different within-bin date mixture
    for date in range(3):
        for hour in range(10):
            stamp = date * 24 + hour
            actual.extend((0., 1.2, 4.))
            hours.extend((stamp, stamp, stamp))
            # sparse vintages must retain the original full-population weight
            if date == 0 or hour == 0:
                actual.append(.2 if date == 0 else .8)
                hours.append(stamp)
    return np.asarray(actual, dtype=np.float64), np.asarray(hours, dtype=np.int64)


# compare independent calculations only on synthetic, observation-free fixtures
class SoftOrdinalMathTests(unittest.TestCase):
    # dry zero and original mass restricted within wet bins match exact schema
    def test_bin_means_and_missing_bin(self):
        actual, hours = fitted_examples()
        expected = producer.fit_bin_means(actual, hours)
        observed = verify.bin_means(actual, hours)
        self.assertEqual(observed, expected)
        self.assertEqual(observed["bins"][1]["uniqueHours"], 12)
        self.assertEqual(observed["means"][0], 0.)
        # removing one wet bin rejects the entire candidate month
        changed = actual.copy()
        changed[changed >= 2.5] = 0.
        self.assertFalse(verify.bin_means(changed, hours)["supported"])

    # exact thresholds belong to the higher class before fitting
    def test_threshold_membership_and_uncapped_labels(self):
        actual = np.repeat([0., .1, 1., 2.5, 40.], 12)
        hours = np.tile(np.arange(12, dtype=np.int64) * 24, 5)
        result = verify.bin_means(actual, hours)
        self.assertEqual([item["rows"] for item in result["bins"]], [12, 12, 12, 24])
        np.testing.assert_allclose(result["means"], [0., .1, 1., 21.25])

    # incoherent tails become nested before the common odds offset
    def test_nested_four_class_mass(self):
        probabilities = np.asarray([[.2, .8, .3], [0., 1., 1.], [1., 0., 0.]])
        for offset in (-1.5, 0., 1.5):
            observed = verify.class_mass(probabilities, offset)
            expected = producer.bin_probabilities(probabilities, offset)
            np.testing.assert_allclose(observed, expected, atol=1e-15)
            np.testing.assert_allclose(observed.sum(axis=1), 1., atol=1e-15)
            self.assertTrue((observed >= 0).all())

    # full-grid categorical loss and exact tie ordering remain preregistered
    def test_calibration_grid_and_mean_prediction(self):
        actual, hours = fitted_examples()
        probability = np.tile([.4, .2, .05], (len(actual), 1))
        observed = verify.calibrate(actual, hours, probability)
        expected = producer.calibrate(actual, hours, probability)
        self.assertEqual(observed["selectedIndex"], expected["selectedIndex"])
        self.assertEqual(observed["gridOffsets"], expected["gridOffsets"])
        np.testing.assert_allclose(observed["gridScores"], expected["gridScores"], rtol=0, atol=1e-14)
        means = verify.bin_means(actual, hours)["means"]
        np.testing.assert_allclose(verify.predict(probability, means, observed), producer.predict(probability, means, expected), rtol=0, atol=1e-14)

    # malformed probabilities cannot be converted into a usable distribution
    def test_bad_probability_or_bin_state_fails(self):
        actual, hours = fitted_examples()
        with self.assertRaises(ValueError):
            verify.class_mass(np.array([[np.nan, .2, .1]]), 0.)
        with self.assertRaises(ValueError):
            verify.class_mass(np.array([[1.1, .2, .1]]), 0.)
        state = verify.calibrate(actual, hours, np.tile([.4, .2, .1], (len(actual), 1)))
        with self.assertRaises(ValueError):
            verify.predict(np.array([[.4, .2, .1]]), [0., .2, 1.2, np.nan], state)

    # a supported month reads fit/cal labels but not evaluation outcomes
    def test_month_replay_uses_retained_heads_and_frozen_controls(self):
        import json

        fit_actual, fit_hours = fitted_examples()
        cal_actual, cal_hours = fitted_examples()
        cal_hours = cal_hours + 1000
        n_fit, n_cal = len(fit_actual), len(cal_actual)
        count = n_fit + n_cal + 2
        actual = np.concatenate((fit_actual, cal_actual, [np.nan, np.nan]))
        hours = np.concatenate((fit_hours, cal_hours, [2000, 2001]))
        masks = [np.zeros(count, dtype=bool) for _ in range(3)]
        masks[0][:n_fit] = True
        masks[1][n_fit:n_fit + n_cal] = True
        masks[2][-2:] = True
        bounds = {"month": "2026-01", "calibrationMaximumValidHourExclusive": 1200}
        counts = {"training": verify.support(fit_actual, fit_hours), "calibration": verify.support(cal_actual, cal_hours)}
        mass = verify.recent_weights(cal_hours, bounds["calibrationMaximumValidHourExclusive"])
        effective = verify.effective_support(cal_actual, cal_hours, mass)
        model_state = {"featureNames": verify.POLICY["featureNames"], "heads": {}}
        old_state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": True, "model": model_state}
        fit_bins = verify.bin_means(fit_actual, fit_hours)
        pc = np.tile([.4, .2, .05], (n_cal, 1))
        pe = np.asarray([[.2, .1, .02], [.6, .4, .1]])
        calibration = verify.calibrate(cal_actual, cal_hours, pc)
        state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": True, "model": model_state, "binFit": fit_bins, "calibration": calibration, "reason": "soft_ordinal_calibrated"}
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "wind-states").mkdir()
            (root / "soft-ordinal-states").mkdir()
            old_path = root / "wind-states/2026-01.json"
            old_path.write_text(json.dumps(old_state))
            state["inheritedStateSha256"] = verify.sha(old_path)
            (root / "soft-ordinal-states/2026-01.json").write_text(json.dumps(state))
            full = np.zeros((count, 107), dtype=np.float32)
            data = {"actual": actual, "hour": hours}
            models = {name: object() for name in ("0.1", "1.0", "2.5")}
            models["amount"] = None
            permissive = {**verify.POLICY, "trainingSupport": {}, "calibrationSupport": {}, "effectiveSupport": {}}
            # isolate native outputs while exercising real bin/calibration math
            with patch.object(verify, "POLICY", permissive), patch.object(verify, "month_masks", return_value=(*masks, bounds)), patch.object(verify.wind, "refit_heads", return_value=(models, model_state)), patch.object(verify, "native_tails", side_effect=(pc, pe)):
                rows, predicted, observed_state = verify.replay_month(root, data, full, verify.POLICY["featureNames"], {}, "2026-01", np.array([.3, .5]))
            np.testing.assert_array_equal(rows, [count - 2, count - 1])
            np.testing.assert_allclose(predicted, verify.predict(pe, fit_bins["means"], calibration))
            self.assertEqual(observed_state["reason"], "soft_ordinal_calibrated")
            # one absent heavy tail leaves both decision rows at exact ordinal90
            missing = {**models, "2.5": None}
            fallback = {**state, "supported": False, "calibration": None, "reason": "missing_probability_head"}
            (root / "soft-ordinal-states/2026-01.json").write_text(json.dumps(fallback))
            old_ordinal = np.array([.3, .5])
            with patch.object(verify, "POLICY", permissive), patch.object(verify, "month_masks", return_value=(*masks, bounds)), patch.object(verify.wind, "refit_heads", return_value=(missing, model_state)), patch.object(verify, "native_tails", side_effect=AssertionError("missing head must not score")):
                _, fallback_prediction, fallback_state = verify.replay_month(root, data, full, verify.POLICY["featureNames"], {}, "2026-01", old_ordinal)
            np.testing.assert_array_equal(fallback_prediction, old_ordinal)
            self.assertEqual(fallback_state["reason"], "missing_probability_head")

    # the gamma head is retained but never queried for the new forecast
    def test_native_probability_inference_ignores_gamma(self):
        names = verify.POLICY["featureNames"]
        features = np.zeros((2, 107), dtype=np.float32)

        # each event stub only supplies its own frozen probability score
        class Event:
            def __init__(self, value):
                self.value = value

            def predict(self, matrix):
                return np.full(2, self.value)

        # any gamma call indicates unintended inherited amount blending
        class Gamma:
            def predict(self, matrix):
                raise AssertionError("gamma head should be unused")

        models = {"0.1": Event(.2), "1.0": Event(.1), "2.5": Event(.05), "amount": Gamma()}
        with patch.object(verify.xgb, "DMatrix", return_value=object()) as matrix:
            observed = verify.native_tails(models, features, names)
        matrix.assert_called_once()
        np.testing.assert_array_equal(observed, np.tile([.2, .1, .05], (2, 1)))

    # the new report retains all fifteen arms and only the fixed primary gate
    def test_fifteen_arm_report_and_recomputed_gate_shape(self):
        count = 2
        data = {"hour": np.array([24, 25]), "mean": np.array([.2, 1.]), "actual": np.array([.2, 1.])}
        indices = np.array([0, 1])
        amounts = {name: np.array([.2, 1.]) for name in verify.ARMS}
        flags = np.ones(count, dtype=bool)
        source = {"normalizedSha256": "a" * 64, "newUnresolvedRuns": 0, "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 0, "qualified": True}}}
        availability = {"windVectorAvailable": np.array([True, False])}
        screen = {"gates": {f"gate{index}": True for index in range(49)}, "passed": False}
        # isolate score plumbing while checking all report-only source fields
        with TemporaryDirectory() as temporary, patch.object(verify.goal, "recomputed_scores", return_value={"overall": {}}), patch.object(verify.goal, "gate_view", return_value={}), patch.object(verify.goal, "independent_gate", return_value=screen), patch.object(verify, "metrics", return_value={}), patch.object(verify, "sha", return_value="b" * 64):
            report = verify.expected_report(Path(temporary), data, {}, indices, amounts, flags, {}, availability, source)
        self.assertEqual(len(verify.ARMS), 15)
        self.assertEqual(report["referenceParity"]["arms"]["windOriginal"], verify.wind.PRIMARY)
        self.assertEqual(report["nativeModelsFit"], 0)
        self.assertEqual((report["nativeModelsReused"], report["nativeModelsUnused"]), (36, 12))
        self.assertEqual(report["directionSourceCoverage"]["perMonthCoverage"], source["perMonthCoverage"])
        self.assertEqual(len(report["candidateScreen"]["gates"]), 49)
        self.assertIsNone(report["selectedCandidate"])


# run only local synthetic mathematical checks
if __name__ == "__main__":
    unittest.main()
