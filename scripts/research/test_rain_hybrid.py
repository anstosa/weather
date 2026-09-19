"""lock severity routing, training-only seasonality and hybrid selection."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rain_hybrid as hybrid
import rain_search as search
from rain_sub24 import FEATURE_NAMES, hour_number
from test_rain_event_guard import safe_report


# create supported synthetic seasons with different raw baseline biases
def seasonal_example():
    winter = hour_number('2025-01-01T00:00:00Z') + np.arange(30) * 24
    spring = hour_number('2025-04-01T00:00:00Z') + np.arange(30) * 24
    return np.full(60, 2.), np.r_[np.full(30, 4.), np.ones(30)], np.r_[winter, spring]


# translate the old safe screen into the one fixed hybrid primary
def safe_hybrid():
    original = json.loads(json.dumps(safe_report()).replace('eventGuard', hybrid.PRIMARY))
    original['support'] = {'dates': 300, 'wetDates': 100}
    original['mechanismSupport'] = {'dates': 20}
    original['invariants'] = {'finiteNonnegative': True}
    # keep all comparison arms deliberately worse than the synthetic primary
    for name in ('volume90', 'rawSeasonal', 'weightedSeasonal', 'hybrid90'):
        original['overall'][name] = {**original['overall']['raw'], 'mae': .9}
    return original


# exercise new mechanisms without historical fitting or outcome access
class RainHybridTests(unittest.TestCase):
    # season identity uses valid-time utc calendar including year boundaries
    def test_calendar_seasons(self):
        dates = ['2025-12-31', '2026-01-01', '2026-03-01', '2026-06-01', '2026-09-01']
        hours = np.array([hour_number(date + 'T00:00:00Z') for date in dates])
        np.testing.assert_array_equal(hybrid.seasons(hours), ['DJF', 'DJF', 'MAM', 'JJA', 'SON'])

    # seasonal factors shrink log baseline bias and preserve explicit unsupported seasons
    def test_seasonal_ratio_shrinkage_and_fallback(self):
        actual, raw, hours = seasonal_example()
        state = hybrid.seasonal_state(actual, raw, hours)
        self.assertAlmostEqual(state['globalRatio'], .8)
        self.assertAlmostEqual(state['seasons']['DJF']['factor'], (.5 / .8) ** (1 / 3))
        self.assertAlmostEqual(state['seasons']['MAM']['factor'], (2. / .8) ** (1 / 3))
        self.assertEqual(state['seasons']['JJA']['factor'], 1.)
        self.assertEqual(state['seasons']['JJA']['reason'], 'insufficient_season_support')
        self.assertEqual(state['trainingMaximumActualHour'], int(hours.max()))

    # duplicate forecast vintages cannot add seasonal support or calibration mass
    def test_seasonal_statistics_ignore_duplicate_vintages(self):
        actual, raw, hours = seasonal_example()
        first = hybrid.seasonal_state(actual, raw, hours)
        duplicate = hybrid.seasonal_state(np.repeat(actual, 2), np.repeat(raw, 2), np.repeat(hours, 2))
        self.assertAlmostEqual(first['globalRatio'], duplicate['globalRatio'])
        self.assertEqual(first['seasons']['DJF']['support']['dates'], duplicate['seasons']['DJF']['support']['dates'])
        self.assertAlmostEqual(first['seasons']['DJF']['factor'], duplicate['seasons']['DJF']['factor'])

    # unavailable global rain cannot manufacture a seasonal correction
    def test_unidentified_and_invalid_seasonal_inputs(self):
        for actual, raw, hours in ((np.array([]), np.array([]), np.array([], dtype=int)), (np.ones(3), np.zeros(3), np.arange(3))):
            state = hybrid.seasonal_state(actual, raw, hours)
            self.assertIsNone(state['globalRatio'])
            self.assertTrue(all(value['factor'] == 1. for value in state['seasons'].values()))
        for actual, raw, hours in (([np.nan], [1.], [0]), ([1.], [-1.], [0]), ([1.], [1.], [.5])):
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                hybrid.seasonal_state(np.array(actual), np.array(raw), np.array(hours))

    # later calibration and evaluation labels cannot alter the seasonal estimator
    def test_season_estimation_excludes_later_labels(self):
        actual, raw, hours = seasonal_example()
        start = hour_number('2025-09-01T00:00:00Z')
        data = {'hour': np.r_[hours, start - 10 * 24, start + 10], 'initialized': np.r_[hours, start - 10 * 24, start + 10] - 9}
        fit, _, _, _ = search.month_masks(data, '2025-09')
        targets = np.r_[actual, 1., 1.]
        baseline = np.r_[raw, 1., 1.]
        state = hybrid.seasonal_state(targets[fit], baseline[fit], data['hour'][fit])
        targets[~fit] = 999.
        self.assertEqual(state, hybrid.seasonal_state(targets[fit], baseline[fit], data['hour'][fit]))

    # ordinal wet calls do not control ordinary amounts or observed-severity routing
    def test_severity_uses_only_high_forecast_heads(self):
        raw = np.zeros(4)
        probabilities = np.array([[.9, .1, .1], [.1, .9, .1], [.1, .1, .9], [.1, .1, .1]])
        rules = [{'threshold': threshold, 'cutoff': .5} for threshold in (.1, 1., 2.5)]
        np.testing.assert_array_equal(hybrid.severity_categories(raw, probabilities, rules), [0, 2, 3, 0])

    # heavy nested safety falls back as a pair without changing the unused wet rule
    def test_heavy_nested_safety_fallback(self):
        actual, raw = np.array([1.5, 0.]), np.array([1.5, 0.])
        probabilities = np.array([[.1, .9, .1], [.1, .9, .1]])
        rules = [{'threshold': threshold, 'cutoff': .5, 'reason': 'calibrated'} for threshold in (.1, 1., 2.5)]
        before = copy.deepcopy(rules)
        applied, fallback = hybrid.heavy_rules(actual, raw, probabilities, np.arange(2), rules)
        self.assertTrue(fallback)
        self.assertEqual(applied[0], before[0])
        self.assertIsNone(applied[1]['cutoff'])
        self.assertIsNone(applied[2]['cutoff'])
        self.assertEqual(before, rules)

    # seasonal and scalar changes cannot move a forecast across heavy categories
    def test_projection_preserves_bands_but_not_a_wet_floor(self):
        base = np.array([0., .01, 9., .01, 99., .01, 99.])
        categories = np.array([0, 0, 0, 2, 2, 3, 3])
        result = hybrid.project_amount(base, categories, np.full(7, 2.), 3.)
        np.testing.assert_array_equal(result, [0., .06, np.nextafter(1., 0.), 1., np.nextafter(2.5, 0.), 2.5, 30.])
        with self.assertRaises(ValueError):
            hybrid.project_amount(np.array([np.nan]), np.array([0]), np.ones(1), 1.)
        with self.assertRaises(ValueError):
            hybrid.project_amount(np.ones(1), np.array([1]), np.ones(1), 1.)

    # the heavy branch changes only forecasts routed by the event heads
    def test_routed_amount_uses_separate_raw_anchored_heavy_head(self):
        output = hybrid.routed_base(np.array([2., 2.]), np.array([.2, .2]), np.array([4., 4.]), np.array([0, 2]))
        np.testing.assert_array_equal(output, [.2, 3.])

    # final category floors can make the earlier target explicitly unattainable
    def test_final_projection_calibration_retains_saturation(self):
        result = search.calibrate(np.zeros(3), np.arange(3), lambda scale: hybrid.project_amount(np.ones(3), np.full(3, 2), np.ones(3), scale))
        self.assertEqual(result['status'], 'saturated_low')
        self.assertEqual(result['achievedMean'], 1.)

    # positive heavy-only training has its own support and native objective
    def test_heavy_head_support_and_native_fit(self):
        hours = np.repeat(np.arange(10) * 24, 6) + np.tile(np.arange(6), 10)
        data = {'actual': np.linspace(1., 3., 60), 'hour': hours, 'x': np.zeros((60, len(FEATURE_NAMES)), dtype=np.float32)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            absent, state = hybrid.fit_heavy(data, np.arange(60) < 49, root)
            self.assertIsNone(absent)
            self.assertFalse((root / 'heavy.json').exists())
            model, state = hybrid.fit_heavy(data, np.ones(60, dtype=bool), root)
            self.assertEqual(state['reason'], 'fitted')
            self.assertEqual(model.num_boosted_rounds(), 160)
            self.assertEqual(json.loads(model.save_config())['learner']['objective']['name'], 'reg:gamma')

    # unsupported global training preserves all primary and ablation rows as raw
    def test_unsupported_month_retains_raw(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 110 * 24, start - 10 * 24, start + 10])
        data = {'hour': hours, 'initialized': hours - 9, 'actual': np.ones(3), 'raw': np.full(3, .2), 'persistence': np.full(3, np.nan)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / 'inputs/sub24-models/2025-09'
            old.mkdir(parents=True)
            (old / 'state.json').write_text(json.dumps({'scales': {'raw': 1.}}))
            rows, output, state, routed = hybrid.fit_month(root, data, '2025-09')
            np.testing.assert_array_equal(rows, [2])
            np.testing.assert_array_equal(output[hybrid.PRIMARY], [.2])
            self.assertFalse(state['supported'])
            self.assertFalse(routed.any())

    # unchanged safety gates and added-value controls must all pass
    def test_primary_requires_all_47_gates_and_both_ablations(self):
        report = safe_hybrid()
        self.assertEqual(len(hybrid.primary_gates(report)), 47)
        self.assertTrue(all(hybrid.primary_gates(report).values()))
        report['overall']['weightedSeasonal']['mae'] = .8
        self.assertFalse(hybrid.primary_gates(report)['hybridAddedValue'])
        report['overall']['weightedSeasonal']['mae'] = .9
        report['mechanismSupport']['dates'] = 19
        self.assertFalse(hybrid.primary_gates(report)['hybridAddedValue'])
        report['mechanismSupport']['dates'] = 20
        report['events'][hybrid.PRIMARY]['1.0']['pod'] = .1
        self.assertFalse(hybrid.primary_gates(report)['event1.0Safety'])
        self.assertFalse(hybrid.POLICY['productionEligible'])


# separate synthetic discovery from explicit historical execution
if __name__ == '__main__':
    unittest.main()
