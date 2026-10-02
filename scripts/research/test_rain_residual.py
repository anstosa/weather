"""lock signed rain correction, causal calibration and unchanged safety gates."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from rain_residual import POLICY, calibrate, development_gates, fit_month, residual_base, screen_alias, support
from rain_sub24 import hour_number
from test_rain_event_guard import safe_report


# adapt the existing safe synthetic report without relaxing empirical gates
def residual_report():
    report = json.loads(json.dumps(safe_report()).replace('eventGuard', 'residualAmount'))
    report['invariants'] = {'finiteNonnegative': True}
    report['support'] = {'dates': 300, 'wetDates': 100}
    return report


# exercise the new learner boundary without historical outcome data
class RainResidualTests(unittest.TestCase):
    # heavy false alarms and missed rain are both allowed to change
    def test_signed_correction_can_lower_heavy_and_add_missing_rain(self):
        raw = np.array([5., 0., .2])
        np.testing.assert_allclose(residual_base(raw, np.array([-8., .6, -1.])), [1., .3, 0.])
        np.testing.assert_array_equal(raw, [5., 0., .2])

    # the physical bound applies before and after calibration
    def test_correction_clips_nonphysical_amounts(self):
        np.testing.assert_array_equal(residual_base(np.array([0., 20.]), np.array([-100., 100.])), [0., 30.])

    # clipping cannot conceal invalid model outputs
    def test_invalid_predictions_fail(self):
        for raw, delta in (([1.], [np.nan]), ([-1.], [0.]), ([1.], [np.inf]), ([1., 2.], [1.])):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                residual_base(raw, delta)

    # simple monotone roots include exact endpoints and unit preference
    def test_calibration_solves_scalar_without_clamping_unattainable_targets(self):
        hours = np.arange(4)
        for target in (.5, .7, 1., 2.):
            result = calibrate(np.full(4, target), np.ones(4), hours)
            self.assertTrue(result['supported'])
            self.assertAlmostEqual(result['scale'], target)
            self.assertAlmostEqual(result['achievedMean'], target)

    # final clipping changes the curve relative to an unbounded mean ratio
    def test_calibration_uses_final_clipped_curve(self):
        result = calibrate(np.array([20., 20.]), np.array([30., 10.]), np.array([0, 1]))
        self.assertEqual(result['scale'], 1.)
        self.assertEqual(result['upperMean'], 25.)

    # a tolerance-sized infeasibility still falls back instead of being rescued
    def test_calibration_rejects_strict_outside_and_flat_targets(self):
        outside = calibrate(np.array([.5 - 1e-12]), np.array([1.]), np.array([0]))
        self.assertFalse(outside['supported'])
        self.assertEqual(outside['reason'], 'target_outside_attainable_range')
        flat = calibrate(np.zeros(2), np.zeros(2), np.arange(2))
        self.assertEqual(flat['reason'], 'flat_calibration_curve')

    # repeated vintages share the weight of their one valid hour
    def test_calibration_and_support_ignore_vintage_duplication(self):
        actual, hours = np.array([0., 0., 2.]), np.array([0, 0, 24])
        self.assertEqual(calibrate(actual, np.ones(3), hours)['scale'], 1.)
        self.assertEqual(support(actual, hours), {'rows': 3, 'hours': 2, 'dates': 2, 'wetDates': 1, 'wetHours': 1})

    # unsupported monthly training retains all rows and writes no booster
    def test_unsupported_training_is_exact_raw(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 100 * 24, start - 10 * 24, start + 10])
        data = {'hour': hours, 'initialized': hours - 9, 'raw': np.array([.2, .2, .2]), 'actual': np.ones(3), 'persistence': np.full(3, np.nan)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / 'inputs/sub24-models/2025-09'
            parent.mkdir(parents=True)
            (parent / 'state.json').write_text(json.dumps({'scales': {'raw': 1.}}))
            indices, output, state = fit_month(root, data, '2025-09')
            np.testing.assert_array_equal(indices, [2])
            np.testing.assert_array_equal(output['residualAmount'], [.2])
            self.assertFalse(state['supported'])
            self.assertIsNone(state['modelSha256'])
            self.assertFalse((root / 'residual-models/2025-09/residual.json').exists())

    # model-specific locks are replaced without weakening measured heavy safety
    def test_measured_heavy_and_detection_regressions_still_fail(self):
        report = residual_report()
        self.assertTrue(all(development_gates(report).values()))
        report['overall']['residualAmount']['heavyMae'] = 2.2
        report['events']['residualAmount']['0.1']['pod'] = .6
        gates = development_gates(report)
        self.assertFalse(gates['heavyIntensityBounded'])
        self.assertFalse(gates['event0.1Safety'])
        self.assertNotIn('rawHeavyAmountsUnchanged', gates)
        self.assertNotIn('rawWetCallsPreserved', gates)

    # raw fallback coverage cannot falsely qualify an unsupported model
    def test_supported_date_floor_is_enforced(self):
        report = residual_report()
        report['support']['dates'] = 179
        self.assertFalse(development_gates(report)['candidateSupport'])
        report['support'] = {'dates': 300, 'wetDates': 19}
        self.assertFalse(development_gates(report)['candidateSupport'])

    # compatibility adaptation never mutates the original experiment report
    def test_screen_alias_preserves_input(self):
        report = residual_report()
        before = copy.deepcopy(report)
        adapted = screen_alias(report)
        self.assertIn('eventGuard', adapted['overall'])
        self.assertEqual(report, before)
        self.assertFalse(POLICY['productionEligible'])
        self.assertTrue(POLICY['developmentDataPreviouslyConsumed'])


# keep test imports free of private-data fitting
if __name__ == '__main__':
    unittest.main()
