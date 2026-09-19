"""exercise the independent hybrid verifier without historical outcomes."""

import datetime as dt
import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
from rain_hybrid import POLICY
from verify_rain_hybrid import (
    factors,
    heavy_categories,
    heavy_rules,
    primary_gates,
    project,
    refit_heavy,
    routed_base,
    season_labels,
    seasonal_state,
    source_freeze,
)


# isolate verifier arithmetic from the private development corpus
class RainHybridVerificationTests(unittest.TestCase):
    # check december and january share a winter label
    def test_season_labels_use_valid_utc_calendar(self):
        hours = np.array([int(dt.datetime(2025, month, 1, tzinfo=dt.timezone.utc).timestamp() // 3600) for month in (1, 4, 7, 10, 12)])
        np.testing.assert_array_equal(season_labels(hours), ['DJF', 'MAM', 'JJA', 'SON', 'DJF'])

    # shrink prior-only season ratios toward their global baseline
    def test_seasonal_state_uses_supported_training_ratios(self):
        winter = np.array([int((dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=day)).timestamp() // 3600) for day in range(40)])
        spring = np.array([int((dt.datetime(2025, 4, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=day)).timestamp() // 3600) for day in range(40)])
        hours = np.concatenate((winter, spring))
        actual = np.r_[np.full(40, 2.), np.full(40, 1.)]
        raw = np.ones(80)
        state = seasonal_state(actual, raw, hours)
        self.assertAlmostEqual(state['globalRatio'], 1.5)
        self.assertEqual(state['seasons']['DJF']['reason'], 'estimated')
        self.assertEqual(state['seasons']['MAM']['reason'], 'estimated')
        self.assertEqual(state['seasons']['JJA']['reason'], 'insufficient_season_support')
        self.assertAlmostEqual(state['seasons']['DJF']['shrinkWeight'], .4)
        self.assertAlmostEqual(state['seasons']['DJF']['factor'], np.exp(.4 * np.log(2 / 1.5)))
        self.assertAlmostEqual(factors(hours, state)[0], state['seasons']['DJF']['factor'])

    # reject nonphysical or misaligned training arrays before scalar estimates
    def test_seasonal_state_rejects_invalid_inputs(self):
        with self.assertRaisesRegex(ValueError, 'invalid'):
            seasonal_state(np.array([1.]), np.array([-1.]), np.array([0]))
        with self.assertRaisesRegex(ValueError, 'invalid'):
            seasonal_state(np.array([1.]), np.array([1., 2.]), np.array([0]))

    # preserve disjoint heavy and extreme amount intervals after season scaling
    def test_projection_preserves_severity_bands(self):
        base = np.array([5., .01, .01, 5., .01, 5.])
        category = np.array([0, 0, 2, 2, 3, 3])
        result = project(base, category, np.ones(6), 1.)
        self.assertLess(result[0], 1.)
        self.assertEqual(result[1], .01)
        self.assertEqual(result[2], 1.)
        self.assertLess(result[3], 2.5)
        self.assertEqual(result[4], 2.5)
        self.assertEqual(result[5], 5.)
        with self.assertRaisesRegex(ValueError, 'invalid'):
            project(base, np.array([0, 1, 2, 2, 3, 3]), np.ones(6), 1.)

    # ignore the unused wet head when creating heavy routing categories
    def test_heavy_categories_ignore_wet_head(self):
        raw = np.array([0., 1., 2.5])
        probabilities = np.full((3, 3), np.nan)
        rules = [{'threshold': threshold, 'cutoff': None} for threshold in (.1, 1., 2.5)]
        np.testing.assert_array_equal(heavy_categories(raw, probabilities, rules), [0, 2, 3])

    # reject jointly unsafe heavy calls even when each cutoff exists
    def test_heavy_rules_fall_back_together(self):
        actual, raw = np.array([1., 0., 0., 0.]), np.array([1., 0., 0., 0.])
        probabilities = np.array([[np.nan, .8, np.nan], [np.nan, .9, np.nan], [np.nan, .8, np.nan], [np.nan, .7, np.nan]])
        hours = np.arange(4, dtype=np.int64) * 24
        proposed = [{'threshold': threshold, 'cutoff': cutoff, 'reason': 'calibrated'} for threshold, cutoff in zip((.1, 1., 2.5), (None, .7, None))]
        rules, fallback = heavy_rules(actual, raw, probabilities, hours, proposed)
        self.assertTrue(fallback)
        self.assertEqual(rules[0]['reason'], 'calibrated')
        self.assertTrue(all(rule['cutoff'] is None and rule['reason'] == 'heavy_nesting_safety_fallback' for rule in rules[1:]))

    # use the heavy amount only for forecast-called heavy categories
    def test_routed_base_uses_heavy_blend_only_on_heavy_calls(self):
        raw = np.array([0., 2., 4.])
        ordinary = np.array([.3, .4, .5])
        heavy = np.array([1., 4., 6.])
        np.testing.assert_array_equal(routed_base(raw, ordinary, heavy, np.array([0, 2, 3])), [.3, 3., 5.])

    # a missing heavy head cannot silently use a fitted reference model
    def test_heavy_head_requires_distinct_positive_support(self):
        data = {'actual': np.array([1., 1., 0., 0.]), 'hour': np.array([0, 0, 24, 48]), 'x': np.zeros((4, 77), dtype=np.float32)}
        with tempfile.TemporaryDirectory() as temporary:
            model, state = refit_heavy(Path(temporary), data, np.ones(4, dtype=bool), np.zeros(4, dtype=bool), np.zeros(4, dtype=bool), '2025-09', ['x'] * 77)
            self.assertIsNone(model)
            self.assertEqual(state['reason'], 'insufficient_heavy_training_support')
            self.assertEqual(state['support']['hours'], 1)

    # require both matched controls and two ablations to lose decisively
    def test_primary_gates_enforce_hybrid_added_value(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        event = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in (.1, 1., 2.5)}
        report = {'overall': {'raw': raw, 'hybridSeasonal': candidate, 'volumeScale': {'mae': .95}, 'volume90': {'mae': .95}, 'rawSeasonal': {'mae': .95}, 'weightedSeasonal': {'mae': .95}, 'hybrid90': {'mae': .95}, 'persistence': {'mae': 1.1}}, 'bySeason': {name: {'raw': raw, 'hybridSeasonal': candidate} for name in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {name: {'raw': raw, 'hybridSeasonal': candidate} for name in ('1-6', '7-12', '13-23')}, 'events': {'raw': event, 'hybridSeasonal': event}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1.}, 'hybridSeasonal': {'mae': .9}}} for length in (6, 12, 23)}, 'invariants': {'finiteNonnegative': True}, 'support': {'dates': 200, 'wetDates': 30}, 'mechanismSupport': {'dates': 20}}
        gates = primary_gates(report)
        self.assertEqual(len(gates), 47)
        self.assertTrue(all(gates.values()))
        report['mechanismSupport']['dates'] = 19
        self.assertFalse(primary_gates(report)['hybridAddedValue'])
        report['mechanismSupport']['dates'] = 20
        report['overall']['weightedSeasonal']['mae'] = .9
        self.assertFalse(primary_gates(report)['hybridAddedValue'])

    # a missing producer dependency must invalidate the source freeze
    def test_source_freeze_rejects_missing_dependency_set(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'freeze.json').write_text('{}')
            frozen_hash = hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, 'source set'):
                source_freeze(root, {'policy': POLICY, 'featureNames': [], 'inputSchemaFreezeSha256': frozen_hash, 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False, 'sourceSha256': {}}, [])


# run synthetic-only checks
if __name__ == '__main__':
    unittest.main()
