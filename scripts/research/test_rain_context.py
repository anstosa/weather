"""lock new-input attribution, reference parity and unchanged native learners."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_context as context
import rain_ordinal as ordinal
import rain_search as search
from rain_sub24 import FEATURE_NAMES, hour_number
from test_rain_event_guard import safe_report


# construct safe synthetic metrics without opening historical outcomes
def safe_context():
    original = safe_report()

    # duplicate metric leaves for every predeclared learner
    def expand(value):
        # copy scalar metric values unchanged
        if not isinstance(value, dict):
            return value
        result = {key: expand(item) for key, item in value.items() if key != 'eventGuard'}
        # expand only synthetic candidate metric leaves
        if 'eventGuard' in value:
            result.update({name: copy.deepcopy(value['eventGuard']) for name in context.LEARNERS})
        return result

    report = expand(original)
    report['overall']['volume90'] = {**report['overall']['volumeScale'], 'mae': .85}
    report['overall']['weightedBase']['mae'] = .85
    report['overall']['ordinalBase']['mae'] = .85
    report['invariants'] = {'finiteNonnegative': True}
    data = {'actual': np.ones(366), 'hour': np.arange(366) * 24}
    return report, data, np.arange(366), {name: np.ones(366, dtype=bool) for name in context.LEARNERS}, {'newInformationAvailable': np.ones(366, dtype=bool)}


# exercise policy boundaries before any native historical model fit
class RainContextTests(unittest.TestCase):
    # only the two full-input learners can qualify
    def test_fixed_policy_and_input_only_ablations(self):
        self.assertEqual(context.CANDIDATES, {'weightedContext': 'weightedBase', 'ordinalContext': 'ordinalBase'})
        self.assertEqual(len(context.LEARNERS), 6)
        self.assertEqual(context.POLICY['parameters'], search.PARAMETERS)
        self.assertEqual(context.POLICY['rainWeights'], [1., 2., 4.])
        self.assertEqual(context.POLICY['boostRounds'], 160)
        self.assertEqual([len(context.POLICY['featureSets'][name]) for name in ('base', 'pressure', 'cycle', 'full')], [77, 83, 89, 95])
        self.assertFalse(context.POLICY['productionEligible'])
        self.assertFalse(context.POLICY['independentEvaluationPerformed'])

    # passing all metrics and demonstrating added input value permits a hypothesis
    def test_all_47_gates_and_stable_selection(self):
        arguments = safe_context()
        screens, selected = context.candidate_screens(*arguments)
        self.assertEqual(selected, 'ordinalContext')
        self.assertTrue(all(item['passed'] for item in screens.values()))
        self.assertTrue(all(len(item['gates']) == 47 for item in screens.values()))
        arguments[0]['events']['ordinalContext']['1.0']['pod'] = .1
        self.assertEqual(context.candidate_screens(*arguments)[1], 'weightedContext')

    # even a perfect single-group ablation is not a selectable candidate
    def test_better_control_is_not_promoted(self):
        arguments = safe_context()
        arguments[0]['overall']['weightedPressure']['mae'] = 0.
        arguments[0]['overall']['volume90']['mae'] = .7
        screens, selected = context.candidate_screens(*arguments)
        self.assertIsNone(selected)
        self.assertEqual(set(screens), set(context.CANDIDATES))
        self.assertTrue(all('beatsSameWindowVolumeScale' in item['failedGates'] for item in screens.values()))

    # reproducing old performance does not show benefit from new information
    def test_same_family_strict_improvement_required(self):
        arguments = safe_context()
        report = arguments[0]
        report['overall']['weightedBase']['mae'] = report['overall']['weightedContext']['mae']
        screens, selected = context.candidate_screens(*arguments)
        self.assertFalse(screens['weightedContext']['gates']['beatsSameFamilyBase'])
        self.assertEqual(selected, 'ordinalContext')

    # lack of new input coverage cannot masquerade as a tested information gain
    def test_new_information_dates_and_row_fraction(self):
        arguments = safe_context()
        arguments[4]['newInformationAvailable'][:19] = False
        self.assertIsNone(context.candidate_screens(*arguments)[1])
        arguments = safe_context()
        arguments[1]['hour'] = np.zeros(366, dtype=int)
        screens, _ = context.candidate_screens(*arguments)
        self.assertTrue(all(not item['gates']['newInformationCoverage'] for item in screens.values()))

    # native model support remains separate from feature missingness
    def test_model_support_and_report_immutability(self):
        arguments = safe_context()
        before = copy.deepcopy(arguments[0])
        arguments[3]['ordinalContext'][:] = False
        screens, selected = context.candidate_screens(*arguments)
        self.assertFalse(screens['ordinalContext']['gates']['candidateSupport'])
        self.assertEqual(selected, 'weightedContext')
        self.assertEqual(arguments[0], before)

    # a model-free month retains all exact raw forecasts
    def test_unsupported_month_preserves_every_arm(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 110 * 24, start - 10 * 24, start + 10])
        data = {'hour': hours, 'initialized': hours - 9, 'actual': np.ones(3), 'raw': np.full(3, .2), 'persistence': np.full(3, np.nan)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'inputs/sub24-models/2025-09'
            old.mkdir(parents=True)
            (old / 'state.json').write_text(json.dumps({'scales': {'raw': 1.}}))
            rows, outputs, state = context.fit_month(root, data, {}, '2025-09')
            np.testing.assert_array_equal(rows, [2])
            # no absent feature matrix is accessed on unsupported fallback paths
            for name in context.LEARNERS:
                np.testing.assert_array_equal(outputs[name], [.2])
                self.assertFalse(state['candidates'][name]['supported'])

    # duplicate forecast vintages do not inflate coverage hours or dates
    def test_availability_counts(self):
        result = context.availability_counts(np.array([0, 0, 24, 25]), {'new': np.array([1, 1, 0, 1], dtype=bool)})
        self.assertEqual(result['new'], {'rows': 3, 'hours': 2, 'dates': 2, 'rowFraction': .75})

    # generic input width preserves the old weighted native model byte for byte
    def test_weighted_base_native_parity(self):
        x = np.random.default_rng(42).normal(size=(160, 77)).astype(np.float32)
        data = {'x': x, 'actual': np.arange(160) % 7 / 5., 'raw': np.full(160, .3), 'hour': np.arange(160)}
        fit, calibration, evaluation = np.arange(160) < 100, (np.arange(160) >= 100) & (np.arange(160) < 130), np.arange(160) >= 130
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            old.mkdir()
            new.mkdir()
            before, bs = search.fit_weighted(data, fit, calibration, evaluation, old, [1., 2., 4.])
            after, ns = context.fit_weighted(data, x, FEATURE_NAMES, fit, calibration, evaluation, new)
            self.assertEqual(bs, ns)
            # predictions must match on both later populations
            for name in before:
                np.testing.assert_array_equal(before[name], after[name])

    # generic ordinal width preserves old native heads and forecast projections
    def test_ordinal_base_native_parity(self):
        x = np.random.default_rng(41).normal(size=(600, 77)).astype(np.float32)
        actual, hours = (np.arange(600) % 9 / 2.).astype(np.float64), np.arange(600)
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            models, old_state = ordinal.fit_models(x, actual, hours, old, search.PARAMETERS, 160)
            learned, new_state = context.fit_ordinal(x, actual, hours, new, FEATURE_NAMES)
            self.assertEqual(old_state, new_state)
            op, oa = ordinal.predict(models, x[-20:])
            np_, na = context.predict_ordinal(learned, x[-20:], FEATURE_NAMES)
            np.testing.assert_array_equal(op, np_)
            np.testing.assert_array_equal(oa, na)

    # retained historical control checks fail before any aggregate candidate scoring
    def test_reference_parity_rejects_changed_state_or_prediction(self):
        states = {'2025-09': {'candidates': {name: {'supported': True} for name in context.REFERENCE_ARMS}}}
        prior = {'monthlyStates': {'2025-09': {'candidates': {name: {'supported': True} for name in context.REFERENCE_ARMS.values()}}}}
        amounts = {name: np.array([.2]) for name in context.REFERENCE_ARMS}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'inputs').mkdir()
            (root / 'inputs/reference-search-report.json').write_text(json.dumps(prior))
            np.savez(root / 'inputs/reference-search-predictions.npz', indices=np.array([1]), **{'amount::' + name: np.array([.2]) for name in context.REFERENCE_ARMS.values()})
            self.assertTrue(context.reference_parity(root, np.array([1]), amounts, states)['exactPredictions'])
            amounts['weightedBase'][0] = .21
            with self.assertRaises(ValueError):
                context.reference_parity(root, np.array([1]), amounts, states)
            amounts['weightedBase'][0] = .2
            states['2025-09']['candidates']['ordinalBase']['supported'] = False
            with self.assertRaises(ValueError):
                context.reference_parity(root, np.array([1]), amounts, states)

    # completed or partial research roots cannot be overwritten by a repeat run
    def test_existing_output_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'features.npz').touch()
            with patch.object(context, 'validate_private_root', return_value=root), patch.object(context, 'validate_freeze'), self.assertRaises(ValueError):
                context.run(root)


# run only generated regression fixtures during discovery
if __name__ == '__main__':
    unittest.main()
