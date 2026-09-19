"""lock one constrained wind-hurdle refit without private outcome access."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rain_monotone as replay
import xgboost as xgb


# check fixed model identity and the sole native parameter change
class RainMonotoneTests(unittest.TestCase):
    # constrain only two redundant issued-rain columns across every head
    def test_one_shape_prior_and_fixed_policy(self):
        self.assertEqual(replay.POLICY['candidates'], [replay.PRIMARY])
        self.assertEqual(replay.ARMS[-2:], ('windOriginal', replay.PRIMARY))
        self.assertEqual(len(replay.ARMS), 15)
        self.assertEqual(len(replay.CONSTRAINTS), 107)
        self.assertEqual([index for index, value in enumerate(replay.CONSTRAINTS) if value], [5, 6])
        self.assertEqual(replay.POLICY['featureNames'][5:7], ['rawRain', 'log1pRawRain'])
        self.assertEqual(replay.POLICY['monotoneHeads'], ['0.1', '1.0', '2.5', 'amount'])
        self.assertEqual({key: value for key, value in replay.FIT_PARAMETERS.items() if key != 'monotone_constraints'}, replay.parent.context.PARAMETERS)
        self.assertEqual({key: value for key, value in replay.POLICY['parameters'].items() if key != 'monotone_constraints'}, replay.parent.POLICY['parameters'])
        self.assertEqual(replay.POLICY['boostRounds'], 160)
        self.assertEqual(replay.POLICY['nativeModelsFit'], 48)
        self.assertEqual(replay.POLICY['nativeModelsReused'], 0)
        self.assertEqual(replay.POLICY['screen'], replay.parent.POLICY['screen'])
        self.assertEqual(replay.POLICY['calibrationAlgorithm'], replay.parent.POLICY['calibrationAlgorithm'])
        self.assertTrue(replay.POLICY['exploratoryOnly'])
        self.assertFalse(replay.POLICY['productionEligible'])

    # synthetic two-round fits prove live constraints and saved predictions
    def test_native_two_round_four_head_fit_and_roundtrip(self):
        raw = np.tile([0., .2, 1.5, 4.], 400).astype(np.float32)
        actual = raw.astype(np.float64)
        hours = np.arange(len(raw), dtype=np.int64) * 24
        x = np.zeros((len(raw), 107), dtype=np.float32)
        x[:, 5], x[:, 6] = raw, np.log1p(raw)
        with tempfile.TemporaryDirectory() as directory:
            models, state = replay.fit_monotone(x, actual, hours, Path(directory), replay.POLICY['featureNames'], 2)
            self.assertEqual(state['rounds'], 2)
            self.assertEqual(set(models), {'0.1', '1.0', '2.5', 'amount'})
            self.assertTrue(all(model is not None for model in models.values()))
            self.assertEqual(sum(head['modelFile'] is not None for head in state['heads'].values()), 4)
            joint = np.zeros((41, 107), dtype=np.float32)
            joint[:, 5] = np.linspace(0, 4, len(joint))
            joint[:, 6] = np.log1p(joint[:, 5])
            raw_only = joint.copy()
            raw_only[:, 6] = np.log1p(1.5)
            log_only = joint.copy()
            log_only[:, 5] = 1.5
            curves = [xgb.DMatrix(values, feature_names=replay.POLICY['featureNames'], nthread=1) for values in (joint, raw_only, log_only)]
            # test both constrained coordinates separately and on the paired curve
            for name, model in models.items():
                head = state['heads'][name]
                self.assertEqual(head['liveMonotoneConstraints'], replay.LIVE_CONSTRAINT_CONFIG)
                self.assertEqual(head['sha256'], replay.inputs.sha(Path(directory) / head['modelFile']))
                predictions = [model.predict(matrix) for matrix in curves]
                self.assertGreater(np.ptp(predictions[0]), 1e-6)
                for prediction in predictions:
                    self.assertTrue((np.diff(prediction) >= -1e-7).all())
                loaded = xgb.Booster(model_file=Path(directory) / head['modelFile'])
                np.testing.assert_allclose(loaded.predict(curves[0]), predictions[0], rtol=0, atol=1e-7)

    # preserve all matched controls and the original forty-nine gate names
    def test_report_has_fifteen_arms_and_unchanged_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # synthetic report hashes require only inert freeze placeholders
            for name in ('hurdle-freeze.json', 'trajectory-freeze.json', 'wind-freeze.json', 'monotone-freeze.json'):
                (root / name).write_text('{}')
            hours = np.arange(366) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), len(hours))
            data = {'actual': np.full(len(hours), .2), 'mean': np.full(len(hours), .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(len(hours), .8) for name in replay.ARMS}
            predictions['windOriginal'][:] = .5
            predictions[replay.PRIMARY][:] = .2
            states = {'month': {'model': {'heads': {name: {'modelFile': name} for name in ('0.1', '1.0', '2.5', 'amount')}}}}
            report = replay.make_report(root, data, np.arange(len(hours)), predictions, np.ones(len(hours), dtype=bool), states)
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['overall']), 15)
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['nativeModelsFit'], 4)
            self.assertEqual(report['nativeModelsReused'], 0)
            self.assertTrue(report['exploratoryOnly'])

    # a wrong parent or any partial output aborts before private labels load
    def test_wrong_parent_and_partial_output_are_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            root = folder / replay.ROOT_NAME
            source = folder / 'wrong-wind-parent'
            with patch.object(replay.parent, 'validate_private_root', side_effect=lambda path: Path(path)), patch.object(replay.parent, 'validate_freeze') as validator, self.assertRaises(ValueError):
                replay.prepare(source, root, folder / 'receipt.json')
            validator.assert_not_called()
            root.mkdir()
            (root / 'features.npz').touch()
            with patch.object(replay.parent, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # unsupported month retains every exact ordinal90 control value
    def test_unsupported_month_uses_original_control_without_fit(self):
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        data = {'actual': np.array([.2, 3., .3, 1.2, 999., 777.]), 'hour': np.arange(6) * 24}
        x = np.zeros((6, 107), dtype=np.float32)
        bounds = {'calibrationMaximumValidHourExclusive': 96}
        counts = {'training': replay.parent.residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': replay.parent.residual.support(data['actual'][calibration], data['hour'][calibration])}
        retained = {**bounds, 'support': counts, 'effectiveSupport': {}, 'supported': False}
        control = np.array([.8, 1.5])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'wind-states').mkdir()
            (root / 'wind-states/test.json').write_text(json.dumps(retained))
            with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, bounds)), patch.object(replay.parent.residual, 'supported', return_value=False), patch.object(replay.parent.recent, 'recent_weights', return_value=np.ones(2) / 2), patch.object(replay.parent.recent, 'effective_support', return_value={}), patch.object(replay, 'fit_monotone') as learner:
                rows, predicted, state = replay.fit_month(root, data, x, 'test', control)
            np.testing.assert_array_equal(rows, [4, 5])
            np.testing.assert_array_equal(predicted, control)
            self.assertFalse(state['supported'])
            learner.assert_not_called()


# run only local synthetic checks without a private model replay
if __name__ == '__main__':
    unittest.main()
