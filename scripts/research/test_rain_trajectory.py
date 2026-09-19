"""lock the single forecast-tendency hypothesis before development scoring."""

import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_trajectory as replay


# preserve the matched original learner and all fixed evaluation gates
class TrajectoryExperimentTests(unittest.TestCase):
    # six predictors are the only change to the original hurdle learner
    def test_single_uniform_trajectory_policy(self):
        self.assertEqual(replay.POLICY['candidates'], ['hurdleTrajectory'])
        self.assertEqual(replay.POLICY['boostRounds'], 160)
        self.assertEqual(len(replay.POLICY['featureNames']), 101)
        self.assertEqual(len(replay.POLICY['tendencyFeatures']), 6)
        self.assertEqual(replay.POLICY['featureNames'][:95], replay.parent.POLICY['featureNames'])
        self.assertNotIn('fitHalfLifeDays', replay.POLICY)
        self.assertNotIn('selectionMaximumRounds', replay.POLICY)
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(replay.hurdle, replay.parent.hurdle)
        self.assertTrue(set(replay.parent.SOURCE_FILES) <= set(replay.SOURCE_FILES))

    # report aliases must not overwrite any original diagnostic or matched control
    def test_real_report_preserves_controls_and_all49_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # provide synthetic metadata without opening real outcomes
            for name in ('hurdle-freeze.json', 'trajectory-freeze.json'):
                (root / name).write_text('{}')
            size = 366
            hours = np.arange(size) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), size)
            data = {'actual': np.full(size, .2), 'mean': np.full(size, .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(size, .8) for name in replay.ARMS}
            predictions['hurdleOriginal'][:] = .5
            predictions[replay.PRIMARY][:] = .2
            report = replay.make_report(root, data, np.arange(size), predictions, np.ones(size, dtype=bool), {'month': {'model': None}})
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertAlmostEqual(report['overall']['hurdleOriginal']['mae'], .3)
            self.assertAlmostEqual(report['overall']['ordinalRecent']['mae'], .6)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['policy'], replay.POLICY)
            self.assertEqual(report['freezeSha256'], replay.inputs.sha(root / 'trajectory-freeze.json'))

    # partial new feature material is evidence rather than permission to rerun
    def test_existing_feature_artifact_stops_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'features.npz').touch()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # unsupported months preserve the complete original ordinal forecast
    def test_unsupported_fallback_retains_rows(self):
        size = 6
        data = {'actual': np.ones(size), 'hour': np.arange(size) * 24}
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        control = np.array([.2, 1.1])
        with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, {'calibrationMaximumValidHourExclusive': 96})), patch.object(replay.residual, 'supported', return_value=False), patch.object(replay.context, 'fit_ordinal') as train:
            rows, prediction, state = replay.fit_month(Path('/unused'), data, np.zeros((size, 101)), 'synthetic', control)
        np.testing.assert_array_equal(rows, [4, 5])
        np.testing.assert_array_equal(prediction, control)
        self.assertFalse(state['supported'])
        train.assert_not_called()

    # native fitting receives no calibration or evaluation labels
    def test_fit_boundary_remains_original(self):
        source = inspect.getsource(replay.fit_month)
        self.assertIn("context.fit_ordinal(x[fit], data['actual'][fit], data['hour'][fit]", source)
        self.assertNotIn("data['actual'][evaluation]", source)
        self.assertNotIn('decay.fit', source)
        self.assertNotIn('capacity.fit', source)


# support a direct byte-bound regression command
if __name__ == '__main__':
    unittest.main()
