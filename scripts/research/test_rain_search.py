"""lock the fixed rain-search matrix, chronology, scalar bounds and selection."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rain_search as search
from rain_sub24 import hour_number
from test_rain_event_guard import safe_report


# populate every arm with an otherwise safe synthetic screen
def safe_search():
    original = safe_report()

    # expand the one old candidate without changing its metric values
    def expand(value):
        if not isinstance(value, dict):
            return value
        result = {key: expand(item) for key, item in value.items() if key != 'eventGuard'}
        # duplicate only the synthetic candidate leaves
        if 'eventGuard' in value:
            result.update({name: copy.deepcopy(value['eventGuard']) for name in search.CANDIDATES})
        return result

    report = expand(original)
    report['overall']['volume90'] = {**report['overall']['volumeScale'], 'mae': .85}
    report['invariants'] = {'finiteNonnegative': True}
    data = {'actual': np.ones(366), 'hour': np.arange(366) * 24}
    return report, data, np.arange(366), {name: np.ones(366, dtype=bool) for name in search.CANDIDATES}


# validate changes before any new development outcomes are opened
class RainSearchTests(unittest.TestCase):
    # ninety-day calibration is separated by two seven-day gaps
    def test_month_boundaries_are_disjoint_and_earlier_only(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 104 * 24 - 1, start - 104 * 24, start - 97 * 24, start - 7 * 24 - 1, start - 7 * 24, start + 1])
        data = {'hour': hours, 'initialized': hours - 9}
        fit, calibration, evaluation, bounds = search.month_masks(data, '2025-09')
        np.testing.assert_array_equal(fit, [1, 0, 0, 0, 0, 0])
        np.testing.assert_array_equal(calibration, [0, 0, 1, 1, 0, 0])
        np.testing.assert_array_equal(evaluation, [0, 0, 0, 0, 0, 1])
        self.assertEqual(bounds['decisionStopHourExclusive'], hour_number('2025-10-01T00:00:00Z'))

    # label costs preserve total native regularization weight
    def test_costs_balance_duplicate_hours_and_normalize(self):
        value = search.cost_weights(np.array([0., 0., .2, 2.]), np.array([0, 0, 24, 48]), [1., 2., 4.])
        np.testing.assert_allclose(value, np.array([.5, .5, 2., 4.]) * 4 / 7)
        self.assertAlmostEqual(value.sum(), 4.)

    # all supported roots include exact endpoints and a preferred unit scale
    def test_scalar_roots_and_unit_preference(self):
        for target in (.1, .4, 1., 3.):
            with self.subTest(target=target):
                result = search.calibrate(np.full(3, target), np.arange(3), lambda scale: np.full(3, scale))
                self.assertEqual(result['status'], 'matched')
                self.assertAlmostEqual(result['scale'], target)

    # unattainable targets are explicitly saturated rather than falsely matched
    def test_scalar_saturation_records_residual(self):
        for target, scale, status in ((0., .1, 'saturated_low'), (4., 3., 'saturated_high')):
            result = search.calibrate(np.array([target]), np.array([0]), lambda value: np.array([value]))
            self.assertEqual((result['scale'], result['status']), (scale, status))
            self.assertAlmostEqual(result['residual'], scale - target)

    # the solver operates after nonlinear physical clipping
    def test_final_output_curve_and_duplicate_weights(self):
        result = search.calibrate(np.array([20., 20.]), np.arange(2), lambda scale: np.clip(scale * np.array([30., 10.]), 0, 30))
        self.assertEqual(result['scale'], 1.)
        self.assertEqual(result['upperMean'], 30.)
        duplicate = search.calibrate(np.array([0., 0., 2.]), np.array([0, 0, 24]), lambda scale: np.full(3, scale))
        self.assertEqual(duplicate['scale'], 1.)

    # invalid or empty populations cannot produce a misleading calibration state
    def test_invalid_scalar_inputs_fail(self):
        for actual, hours in (([], []), ([np.nan], [0]), ([-1.], [0]), ([1., 2.], [0]), ([1.], [.5])):
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                search.calibrate(np.array(actual), np.array(hours), lambda scale: np.ones(len(actual)))
        with self.assertRaises(ValueError):
            search.calibrate(np.ones(1), np.array([0]), lambda scale: np.array([np.nan]))

    # raw anchoring and physical bounds are fixed for all new amount arms
    def test_blend_is_fixed(self):
        np.testing.assert_allclose(search.blended(np.array([4., 100.]), np.array([0., 100.])), [1., 30.])

    # a higher-threshold false call must not bypass the final wet-event safeguard
    def test_nesting_safety_checks_final_calls_and_falls_back_all_heads(self):
        actual, raw = np.array([.2, 1.2, 0.]), np.array([.2, 1.2, 0.])
        probabilities = np.array([[.9, .1, .1], [.9, .9, .1], [.1, .9, .1]])
        rules = [{'threshold': threshold, 'cutoff': .5, 'reason': 'calibrated'} for threshold in (.1, 1., 2.5)]
        before = copy.deepcopy(rules)
        applied, fallback = search.checked_rules(actual, raw, probabilities, np.arange(3), rules)
        self.assertTrue(fallback)
        self.assertTrue(all(rule['cutoff'] is None for rule in applied))
        self.assertEqual(rules, before)
        probabilities[2, 1] = .1
        applied, fallback = search.checked_rules(actual, raw, probabilities, np.arange(3), rules)
        self.assertFalse(fallback)
        self.assertEqual(applied, rules)

    # unsupported model months retain exact raw rows for every candidate
    def test_unsupported_month_is_raw(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 110 * 24, start - 10 * 24, start + 10])
        data = {'hour': hours, 'initialized': hours - 9, 'actual': np.ones(3), 'raw': np.full(3, .2), 'persistence': np.full(3, np.nan)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / 'inputs/sub24-models/2025-09'
            old.mkdir(parents=True)
            (old / 'state.json').write_text(json.dumps({'scales': {'raw': 1.}}))
            indices, output, state = search.fit_month(root, data, '2025-09')
            np.testing.assert_array_equal(indices, [2])
            # every candidate is retained even without a trained model
            for name in search.CANDIDATES:
                np.testing.assert_array_equal(output[name], [.2])
                self.assertFalse(state['candidates'][name]['supported'])

    # tie-breaking never selects a failed candidate
    def test_selection_requires_every_gate_and_has_stable_ties(self):
        report, data, indices, flags = safe_search()
        screens, selected = search.candidate_screens(report, data, indices, flags)
        self.assertEqual(selected, 'ordinalAmount')
        self.assertTrue(all(item['passed'] for item in screens.values()))
        self.assertTrue(all(len(item['gates']) == 45 for item in screens.values()))
        report['events']['ordinalAmount']['1.0']['pod'] = .1
        screens, selected = search.candidate_screens(report, data, indices, flags)
        self.assertEqual(selected, 'weightedModerate')
        self.assertFalse(screens['ordinalAmount']['passed'])

    # the same-window baseline strengthens rather than replaces the old screen
    def test_all_fail_returns_none(self):
        report, data, indices, flags = safe_search()
        report['overall']['volume90']['mae'] = .7
        screens, selected = search.candidate_screens(report, data, indices, flags)
        self.assertIsNone(selected)
        self.assertTrue(all(item['failedGates'] == ['beatsSameWindowVolumeScale'] for item in screens.values()))

    # fallback coverage cannot qualify a nominally good model
    def test_supported_population_is_required_and_input_is_not_mutated(self):
        report, data, indices, flags = safe_search()
        before = copy.deepcopy(report)
        flags['ordinalAmount'][:] = False
        screens, selected = search.candidate_screens(report, data, indices, flags)
        self.assertFalse(screens['ordinalAmount']['gates']['candidateSupport'])
        self.assertEqual(selected, 'weightedModerate')
        self.assertEqual(before, report)
        self.assertFalse(search.POLICY['productionEligible'])
        self.assertTrue(search.POLICY['developmentDataPreviouslyConsumed'])


# keep synthetic discovery separate from historical research execution
if __name__ == '__main__':
    unittest.main()
