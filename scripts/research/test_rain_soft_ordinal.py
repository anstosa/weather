"""lock one probability-bin mean experiment before reading its outcomes."""

import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rain_soft_ordinal as replay


# preserve the fixed experiment and its causal input boundaries
class SoftOrdinalExperimentTests(unittest.TestCase):
    # replace only the amount decision without retraining or changing features
    def test_single_primary_reuses_frozen_wind_heads(self):
        self.assertEqual(replay.POLICY['candidates'], ['softOrdinalWind'])
        self.assertEqual(len(replay.ARMS), 15)
        self.assertEqual(replay.ARMS[-2:], ('windOriginal', 'softOrdinalWind'))
        self.assertEqual(replay.POLICY['featureNames'], replay.parent.POLICY['featureNames'])
        self.assertEqual(len(replay.POLICY['featureNames']), 107)
        self.assertEqual(replay.POLICY['nativeModelsFit'], 0)
        self.assertEqual(replay.POLICY['nativeModelsReused'], 36)
        self.assertEqual(replay.POLICY['nativeModelsUnused'], 12)
        self.assertFalse(replay.POLICY['treeFitPerformed'])
        self.assertEqual(replay.POLICY['trainingSupport'], replay.parent.POLICY['trainingSupport'])
        self.assertEqual(replay.POLICY['calibrationSupport'], replay.parent.POLICY['calibrationSupport'])
        self.assertFalse(replay.POLICY['productionEligible'])

    # preserve all controls and gates through the primary report aliases
    def test_report_has_fifteen_arms_and_unchanged49_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # synthetic reports require only frozen metadata placeholders
            for name in ('hurdle-freeze.json', 'trajectory-freeze.json', 'wind-freeze.json', 'soft-ordinal-freeze.json'):
                (root / name).write_text('{}')
            hours = np.arange(366) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), len(hours))
            data = {'actual': np.full(len(hours), .2), 'mean': np.full(len(hours), .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(len(hours), .8) for name in replay.ARMS}
            predictions['windOriginal'][:] = .5
            predictions[replay.PRIMARY][:] = .2
            report = replay.make_report(root, data, np.arange(len(hours)), predictions, np.ones(len(hours), dtype=bool), {'month': {'model': None}})
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertAlmostEqual(report['overall']['windOriginal']['mae'], .3)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['overall']), 15)
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['nativeModelsFit'], 0)
            self.assertEqual(report['nativeModelsReused'], 36)
            self.assertEqual(report['nativeModelsUnused'], 12)

    # partial experiment evidence forbids another output attempt
    def test_partial_output_stops_before_loading_private_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / replay.ROOT_NAME
            root.mkdir()
            (root / 'features.npz').touch()
            with patch.object(replay.parent, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # bin fitting and calibration cannot borrow evaluation targets
    def test_month_slices_and_original_ordinal_fallback(self):
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        data = {'actual': np.array([.2, 3., .3, 1.2, 999., 777.]), 'hour': np.arange(6) * 24}
        x = np.zeros((6, 107), dtype=np.float32)
        bounds = {'calibrationMaximumValidHourExclusive': 96}
        counts = {'training': replay.parent.residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': replay.parent.residual.support(data['actual'][calibration], data['hour'][calibration])}
        retained = {**bounds, 'support': counts, 'effectiveSupport': {}, 'supported': True, 'model': {'heads': {}}}
        control = np.array([.8, 1.5])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'wind-states').mkdir()
            (root / 'wind-states/test.json').write_text(json.dumps(retained))
            with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, bounds)), patch.object(replay.parent.residual, 'supported', return_value=True), patch.object(replay.parent.recent, 'effective_support', return_value={}), patch.object(replay.soft, 'fit_bin_means', return_value={'supported': False, 'means': None, 'bins': []}) as bin_fit, patch.object(replay, 'load_models') as loader:
                rows, predicted, state = replay.fit_month(root, data, x, 'test', control)
            np.testing.assert_array_equal(rows, [4, 5])
            np.testing.assert_array_equal(predicted, control)
            np.testing.assert_array_equal(bin_fit.call_args.args[0], [.2, 3.])
            self.assertEqual(state['reason'], 'insufficient_bin_support')
            self.assertFalse(state['supported'])
            loader.assert_not_called()
            # only the two earlier calibration labels select the common offset
            with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, bounds)), patch.object(replay.parent.residual, 'supported', return_value=True), patch.object(replay.parent.recent, 'effective_support', return_value={}), patch.object(replay.soft, 'fit_bin_means', return_value={'supported': True, 'means': [0., .2, 1.5, 3.], 'bins': []}), patch.object(replay, 'load_models', return_value={'wet': object()}), patch.object(replay.parent.context, 'predict_ordinal', return_value=(np.full((2, 3), .5), np.full(2, np.nan))), patch.object(replay.soft, 'calibrate', return_value={'selectedOffset': 0.}) as calibrate, patch.object(replay.soft, 'predict', return_value=np.array([.25, .75])):
                _, predicted, state = replay.fit_month(root, data, x, 'test', control)
            np.testing.assert_array_equal(calibrate.call_args.args[0], [.3, 1.2])
            np.testing.assert_array_equal(predicted, [.25, .75])
            self.assertTrue(state['supported'])

    # source code must not retrain heads or read evaluation labels while calibrating
    def test_no_native_fit_or_evaluation_target_access(self):
        source = inspect.getsource(replay.fit_month)
        self.assertNotIn("data['actual'][evaluation]", source)
        self.assertNotIn('xgb.train', source)
        self.assertIn("soft.fit_bin_means(data['actual'][fit], data['hour'][fit])", source)
        self.assertNotIn("'amount'", inspect.getsource(replay.load_models))


# run direct evidence without private model inputs
if __name__ == '__main__':
    unittest.main()
