"""lock nested-capacity experiment scope and multi-generation report aliases."""

import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_capacity as replay


# test chronology boundaries without reading historical experiment labels
class CapacityExperimentTests(unittest.TestCase):
    # capacity is selected inside fit while every other learner rule stays fixed
    def test_single_nested_capacity_policy(self):
        self.assertEqual(replay.POLICY['candidates'], ['hurdleCapacity'])
        self.assertEqual(replay.POLICY['selectionMaximumRounds'], 320)
        self.assertEqual(replay.POLICY['selectionFallbackRounds'], 160)
        self.assertEqual(replay.POLICY['innerValidationDays'], 120)
        self.assertEqual(replay.POLICY['innerEmbargoDays'], 7)
        self.assertEqual(replay.POLICY['fitHalfLifeDays'], 183)
        self.assertIsNone(replay.POLICY['boostRounds'])
        self.assertEqual(len(replay.POLICY['featureNames']), 95)
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(replay.hurdle, replay.parent.hurdle)
        self.assertTrue(set(replay.parent.SOURCE_FILES) <= set(replay.SOURCE_FILES))

    # nested report reuse cannot substitute either previous hurdle control
    def test_real_report_keeps_all_three_generations_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # supply only synthetic metadata envelopes needed by pure report builders
            for name in ('hurdle-freeze.json', 'fit-freeze.json', 'capacity-freeze.json'):
                (root / name).write_text('{}')
            size = 366
            hours = np.arange(size) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), size)
            data = {'actual': np.full(size, .2), 'mean': np.full(size, .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(size, .8) for name in replay.ARMS}
            predictions['hurdleOriginal'][:] = .5
            predictions['decayOriginal'][:] = .6
            predictions[replay.PRIMARY][:] = .2
            report = replay.make_report(root, data, np.arange(size), predictions, np.ones(size, dtype=bool), {'month': {'model': None}})
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertAlmostEqual(report['overall']['hurdleOriginal']['mae'], .3)
            self.assertAlmostEqual(report['overall']['decayOriginal']['mae'], .4)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['policy'], replay.POLICY)
            self.assertEqual(report['freezeSha256'], replay.inputs.sha(root / 'capacity-freeze.json'))
            self.assertEqual(report['nativeSelectionModelsFit'], 0)

    # partial fits cannot be erased by re-running the experiment command
    def test_existing_native_evidence_stops_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'capacity-models').mkdir()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # a support failure preserves every original prediction and skips fitting
    def test_unsupported_fallback_retains_rows(self):
        size = 6
        data = {'actual': np.ones(size), 'hour': np.arange(size) * 24}
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        control = np.array([.2, 1.1])
        with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, {'calibrationMaximumValidHourExclusive': 96})), patch.object(replay.residual, 'supported', return_value=False), patch.object(replay.capacity, 'fit') as train:
            rows, prediction, state = replay.fit_month(Path('/unused'), data, np.zeros((size, 95)), 'synthetic', control)
        np.testing.assert_array_equal(rows, [4, 5])
        np.testing.assert_array_equal(prediction, control)
        self.assertFalse(state['supported'])
        train.assert_not_called()

    # only outer-fit labels may reach the capacity-selector API
    def test_selection_cannot_receive_outer_calibration_or_evaluation_labels(self):
        source = inspect.getsource(replay.fit_month)
        self.assertIn("capacity.fit(x[fit], data['actual'][fit], data['hour'][fit]", source)
        self.assertNotIn("data['actual'][evaluation]", source)
        self.assertNotIn('early_stopping', source)


# allow a direct byte-bound regression command
if __name__ == '__main__':
    unittest.main()
