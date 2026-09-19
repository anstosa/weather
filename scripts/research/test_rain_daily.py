"""lock daily calibration lineage, native reuse and fixed gate reporting."""

import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
import rain_daily as replay


# test the distinct cadence hypothesis without opening development outcomes
class DailyExperimentTests(unittest.TestCase):
    # the source models and empirical acceptance rules remain unchanged
    def test_one_candidate_without_new_training(self):
        self.assertEqual(replay.POLICY['candidates'], ['hurdleDaily'])
        self.assertEqual(replay.POLICY['nativeModelsFit'], 0)
        self.assertEqual(replay.POLICY['nativeModelsReused'], 48)
        self.assertFalse(replay.POLICY['treeFitPerformed'])
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(replay.POLICY['featureNames'], replay.parent.POLICY['featureNames'])
        self.assertEqual(replay.POLICY['calibrationSupport'], replay.parent.POLICY['calibrationSupport'])
        self.assertEqual(replay.daily.CALIBRATION_DAYS, 90)
        self.assertEqual(replay.daily.EMBARGO_DAYS, 7)
        self.assertIn('prequential', replay.POLICY['evaluationDesign'])

    # nested aliases must retain both older model controls and all 49 checks
    def test_report_keeps_original_trajectory_and_hurdle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # use only the synthetic hash envelopes needed for score construction
            for name in ('hurdle-freeze.json', 'trajectory-freeze.json', 'daily-freeze.json'):
                (root / name).write_text('{}')
            size = 366
            hours = np.arange(size) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), size)
            data = {'actual': np.full(size, .2), 'mean': np.full(size, .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(size, .8) for name in replay.ARMS}
            predictions['hurdleOriginal'][:] = .5
            predictions['trajectoryOriginal'][:] = .6
            predictions[replay.PRIMARY][:] = .2
            report = replay.make_report(root, data, np.arange(size), predictions, np.ones(size, dtype=bool), {'month': {'model': None}}, {})
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertAlmostEqual(report['overall']['hurdleOriginal']['mae'], .3)
            self.assertAlmostEqual(report['overall']['trajectoryOriginal']['mae'], .4)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['nativeModelsFit'], 0)
            self.assertEqual(report['policy'], replay.POLICY)

    # interrupted daily states cannot be overwritten on the next invocation
    def test_partial_daily_results_stop_before_data_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'daily-states').mkdir()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # the fixed 101-column models require a distinct schema-aware loader
    def test_native_loader_rejects_schema_drift(self):
        model = Mock()
        model.feature_names = replay.POLICY['featureNames']
        model.num_boosted_rounds.return_value = 160
        model.save_config.return_value = '{"learner":{"objective":{"name":"binary:logistic"}}}'
        state = {'featureNames': replay.POLICY['featureNames'], 'rounds': 160, 'heads': {'0.1': {'modelFile': 'event.json', 'sha256': 'fixed', 'objective': 'binary:logistic'}, 'amount': {'modelFile': None}}}
        with patch.object(replay.inputs, 'sha', return_value='fixed'), patch.object(replay.xgb, 'Booster', return_value=model):
            loaded = replay.load_models(Path('/unused'), 'month', state)
            self.assertIs(loaded['0.1'], model)
            self.assertIsNone(loaded['amount'])
            model.feature_names = model.feature_names[:95]
            with self.assertRaises(ValueError):
                replay.load_models(Path('/unused'), 'month', state)

    # the runner contains inference and earlier-only calibration but no native fit
    def test_runner_cannot_train_new_boosters(self):
        source = inspect.getsource(replay.run)
        self.assertNotIn('xgb.train', source)
        self.assertNotIn('fit_ordinal', source)
        self.assertIn('daily.calibrate_day', source)
        self.assertIn("search.blended(data['raw'][needed].astype(float), amount)", source)


# permit direct byte-bound regression evidence
if __name__ == '__main__':
    unittest.main()
