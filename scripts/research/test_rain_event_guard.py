"""lock the next rain experiment's event safety and rejection boundaries."""

import copy
import unittest

import numpy as np
from rain_event_guard import MONTHS, POLICY, development_gates, event_scores, guard


# supply a fully supported synthetic screen without historical outcomes
def safe_report():
    raw = {'mae': 1., 'rmse': 2., 'wetMae': 1., 'heavyMae': 2., 'volumeRatio': 1., 'dates': 366, 'wetDates': 110, 'heavyHours': 100, 'pod': .7, 'csi': .4, 'far': .3}
    candidate = {**raw, 'mae': .8, 'rmse': 1.8}
    values = {'raw': raw, 'eventGuard': candidate, 'volumeScale': {**raw, 'mae': .9}, 'persistence': raw}
    events = {str(threshold): {'pod': .7, 'csi': .4, 'far': .3, 'observedHours': 100} for threshold in POLICY['thresholdsMmPerHour']}
    return {
        'overall': copy.deepcopy(values),
        'bySeason': {season: copy.deepcopy(values) for season in ('DJF', 'MAM', 'JJA', 'SON')},
        'byLeadBand': {band: copy.deepcopy(values) for band in ('1-6', '7-12', '13-23')},
        'events': {'raw': copy.deepcopy(events), 'eventGuard': copy.deepcopy(events)},
        'accumulations': {str(length): {'runs': 100, 'candidates': {'raw': {'mae': 2.}, 'eventGuard': {'mae': 1.}}} for length in (6, 12, 23)},
        'invariants': {'rawHeavyAmountsUnchanged': True, 'rawWetCallsPreserved': True},
    }


# test postprocessing and every previously missed failure class
class RainEventGuardTests(unittest.TestCase):
    # raw-heavy intensities remain exact rather than merely above a category floor
    def test_guard_preserves_heavy_amounts(self):
        raw = np.array([1., 2.5, 5., 31.])
        np.testing.assert_array_equal(guard(raw, np.array([0., 9., .2, 30.])), raw)

    # raw wet calls cannot disappear while missed wet calls remain possible
    def test_guard_wet_boundaries_and_new_events(self):
        raw = np.array([0., .09, .1, .99, 1.])
        result = guard(raw, np.array([.2, 0., 0., 2., 0.]))
        np.testing.assert_array_equal(result, [.2, 0., .1, 2., 1.])
        self.assertTrue(np.all(result[raw >= .1] >= .1))

    # inference rejects malformed or nonphysical input instead of concealing it
    def test_guard_rejects_invalid_input(self):
        for raw, candidate in (([1.], [np.nan]), ([np.inf], [1.]), ([-1.], [1.]), ([1.], [-1.]), ([1., 2.], [1.])):
            with self.subTest(raw=raw, candidate=candidate), self.assertRaises(ValueError):
                guard(raw, candidate)

    # events have explicit null support rather than invented zero errors
    def test_events_missing_support(self):
        values = event_scores(np.array([0., 0.]), np.array([0., 0.]), np.array([0, 1]))
        self.assertIsNone(values['0.1']['pod'])
        self.assertIsNone(values['1.0']['far'])
        self.assertEqual(values['2.5']['observedHours'], 0)

    # repeated forecast vintages split an hour's event weight
    def test_event_weights_balance_duplicate_vintages(self):
        values = event_scores(np.array([1., 1., 1.]), np.array([1., 1., 0.]), np.array([0, 0, 24]))
        self.assertAlmostEqual(values['0.1']['pod'], .5)

    # a fully supported safe candidate can pass development without qualifying production
    def test_safe_development_is_not_production_qualification(self):
        self.assertTrue(all(development_gates(safe_report()).values()))
        self.assertFalse(POLICY['productionEligible'])
        self.assertFalse(POLICY['independentEvaluationPerformed'])
        self.assertTrue(POLICY['developmentDataPreviouslyConsumed'])
        self.assertEqual(MONTHS[0], '2025-09')
        self.assertEqual(MONTHS[-1], '2026-08')

    # the old heavy-rain failure must stop selection before any prospective test
    def test_heavy_intensity_regression_rejected(self):
        report = safe_report()
        report['overall']['eventGuard']['heavyMae'] = 2.11
        self.assertFalse(development_gates(report)['heavyIntensityBounded'])

    # a better csi cannot conceal loss of rain detection probability
    def test_detection_loss_rejected_despite_better_csi(self):
        report = safe_report()
        report['events']['eventGuard']['0.1'].update(pod=.69, csi=.6)
        self.assertFalse(development_gates(report)['event0.1Safety'])

    # balanced annual volume cannot conceal winter and spring bias
    def test_seasonal_volume_and_support_are_required(self):
        report = safe_report()
        report['bySeason']['DJF']['eventGuard']['volumeRatio'] = 1.44
        report['bySeason']['JJA']['eventGuard']['wetDates'] = 9
        gates = development_gates(report)
        self.assertFalse(gates['seasonDJFVolume'])
        self.assertFalse(gates['seasonJJASupport'])

    # a dry-hour mae win cannot excuse losing to simple earlier-only scaling
    def test_simple_baseline_win_required(self):
        report = safe_report()
        report['overall']['volumeScale']['mae'] = .7
        self.assertFalse(development_gates(report)['beatsVolumeScale'])

    # absent heavy events and missing seasons fail closed
    def test_missing_evidence_rejected(self):
        report = safe_report()
        report['events']['eventGuard']['2.5']['pod'] = None
        report['bySeason'].pop('DJF')
        report['accumulations']['23'] = {'runs': 0}
        gates = development_gates(report)
        self.assertFalse(gates['event2.5Safety'])
        self.assertFalse(gates['allSeasonsPresent'])
        self.assertFalse(gates['accumulation23Mae'])


# keep tests independent of private research inputs
if __name__ == '__main__':
    unittest.main()
