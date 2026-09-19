"""lock the single training-weight change and inherited gate/report boundary."""

import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_fit_recency as replay


# test the experiment boundary without historical source material
class FitRecencyExperimentTests(unittest.TestCase):
    # no capacity search or implicit calibration change is permitted
    def test_fixed_half_year_training_only_policy(self):
        self.assertEqual(replay.POLICY['fitHalfLifeDays'], 183)
        self.assertEqual(replay.decay.HALF_LIFE_DAYS, 183)
        self.assertEqual(replay.POLICY['candidates'], ['hurdleDecay'])
        self.assertEqual(replay.POLICY['boostRounds'], 160)
        self.assertEqual(replay.POLICY['parameters'], replay.search.PARAMETERS)
        self.assertEqual(len(replay.POLICY['featureNames']), 95)
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(replay.hurdle, replay.parent.hurdle)
        self.assertTrue(set(replay.parent.SOURCE_FILES) <= set(replay.SOURCE_FILES))

    # the score adapter must retain new and original hurdle forecasts separately
    def test_report_alias_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fit-freeze.json').write_text('{}')
            predictions = {'raw': np.zeros(2), 'hurdleOriginal': np.ones(2), replay.PRIMARY: np.full(2, 2.)}
            parent_report = {'overall': {replay.parent.PRIMARY: {'mae': .2}, 'hurdleOriginal': {'mae': .3}}, 'candidateScreen': {'passed': True}, 'selectedCandidate': replay.parent.PRIMARY, 'policy': replay.parent.POLICY}
            with patch.object(replay.parent, 'make_report', return_value=parent_report) as score:
                report = replay.make_report(root, {}, np.arange(2), predictions, np.ones(2, dtype=bool), {'month': {'model': None}})
            sent = score.call_args.args[3]
            np.testing.assert_array_equal(sent[replay.parent.PRIMARY], predictions[replay.PRIMARY])
            np.testing.assert_array_equal(sent['hurdleOriginal'], predictions['hurdleOriginal'])
            self.assertNotIn(replay.PRIMARY, sent)
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], .2)
            self.assertEqual(report['overall']['hurdleOriginal']['mae'], .3)
            self.assertEqual(report['policy'], replay.POLICY)
            self.assertEqual(report['selectedCandidate'], replay.PRIMARY)
            self.assertEqual(report['freezeSha256'], replay.inputs.sha(root / 'fit-freeze.json'))
            self.assertTrue(report['treeFitPerformed'])
            self.assertEqual(parent_report['selectedCandidate'], replay.parent.PRIMARY)

    # failed experiments remain terminal evidence instead of mutable retries
    def test_existing_fits_rejected_before_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fit-models').mkdir()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # unsupported calibration does not train or delete fallback forecasts
    def test_unsupported_month_keeps_complete_original_predictions(self):
        size = 6
        data = {'actual': np.ones(size), 'hour': np.arange(size) * 24}
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        bounds = {'calibrationMaximumValidHourExclusive': 96}
        control = np.array([.2, 1.1])
        with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, bounds)), patch.object(replay.residual, 'supported', return_value=False), patch.object(replay.decay, 'fit') as train:
            rows, predicted, state = replay.fit_month(Path('/unused'), data, np.zeros((size, 95)), 'synthetic', control)
        np.testing.assert_array_equal(rows, [4, 5])
        np.testing.assert_array_equal(predicted, control)
        self.assertFalse(state['supported'])
        train.assert_not_called()
        self.assertFalse(np.shares_memory(predicted, control))

    # calibration labels and training labels are drawn from separate earlier masks
    def test_no_evaluation_labels_reach_model_or_calibration(self):
        source = inspect.getsource(replay.fit_month)
        self.assertIn("data['actual'][fit]", source)
        self.assertIn("data['actual'][calibration]", source)
        self.assertNotIn("data['actual'][evaluation]", source)
        self.assertNotIn('early_stopping', source)
        self.assertNotIn('xgb.train', source)


# permit direct regression commands in the evaluator proof contract
if __name__ == '__main__':
    unittest.main()
