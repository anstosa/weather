"""lock the fixed-model recency experiment and its strengthened decision boundary."""

import copy
import inspect
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
import rain_recency as replay
import rain_recency_calibration as recent
import rain_search as search
import rain_ordinal as ordinal
from rain_sub24 import hour_number
from test_rain_event_guard import safe_report


# construct supported synthetic metrics without opening historical outcomes
def safe_recency():
    # expand the old safe fixture into unchanged controls and nonselectable ablations
    def expand(value):
        # preserve scalar leaves verbatim
        if not isinstance(value, dict):
            return value
        result = {name: expand(item) for name, item in value.items() if name != 'eventGuard'}
        # duplicate only synthetic candidate metric leaves
        if 'eventGuard' in value:
            result.update({name: copy.deepcopy(value['eventGuard']) for name in replay.ARMS if name not in result})
        return result

    report = expand(safe_report())
    report['overall']['volume90']['mae'] = .85
    report['overall']['volumeRecent']['mae'] = .85
    report['overall']['ordinal90']['mae'] = .85
    report['bySeason']['DJF']['ordinal90']['volumeRatio'] = 1.3
    report['invariants'] = {'finiteNonnegative': True}
    data = {'actual': np.ones(366), 'hour': np.arange(366) * 24}
    return report, data, np.arange(366), np.ones(366, dtype=bool)


# verify integration using generated inputs and in-memory native substitutes
class RainRecencyTests(unittest.TestCase):
    # no model fitting, half-life search or additional selectable candidate is allowed
    def test_fixed_protocol_and_no_train_call(self):
        self.assertEqual(replay.POLICY['halfLifeDays'], 30)
        self.assertEqual(recent.HALF_LIFE_DAYS, 30)
        self.assertEqual(replay.POLICY['calibrationDays'], recent.WINDOW_DAYS)
        self.assertEqual(replay.POLICY['candidates'], ['ordinalRecent'])
        self.assertFalse(replay.POLICY['treeFitPerformed'])
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(len(replay.ARMS), 11)
        self.assertEqual(len(replay.POLICY['featureNames']), 95)
        self.assertNotIn('xgb.train(', inspect.getsource(replay))
        self.assertEqual(sum(name.endswith('.json') and '/ordinalContext/' in name or '/weightedContext/' in name for name in replay.context_members()), 60)

    # every old gate and each added comparison must pass
    def test_complete_49_gate_screen(self):
        result = replay.candidate_screen(*safe_recency())
        self.assertEqual(len(result['gates']), 49)
        self.assertTrue(result['passed'])

    # a faster baseline or unchanged ordinal must prevent nominal improvement claims
    def test_both_scaling_controls_and_old_model_are_required(self):
        # fail each new average-error comparison independently
        for name, gate in (('volume90', 'beatsSameWindowVolumeScale'), ('volumeRecent', 'beatsRecentVolumeScale'), ('ordinal90', 'beatsUnchangedOrdinal')):
            args = safe_recency()
            args[0]['overall'][name]['mae'] = .7
            result = replay.candidate_screen(*args)
            self.assertFalse(result['gates'][gate])
            self.assertFalse(result['passed'])

    # reducing ordinary error cannot conceal lost heavy-event detection or intensity
    def test_heavy_skill_cannot_regress(self):
        args = safe_recency()
        args[0]['events'][replay.PRIMARY]['1.0']['pod'] = .69
        self.assertFalse(replay.candidate_screen(*args)['gates']['heavySkillRetained'])
        args = safe_recency()
        args[0]['events'][replay.PRIMARY]['2.5']['pod'] = None
        self.assertFalse(replay.candidate_screen(*args)['gates']['heavySkillRetained'])
        args = safe_recency()
        args[0]['overall'][replay.PRIMARY]['heavyMae'] = 2.01
        self.assertFalse(replay.candidate_screen(*args)['gates']['heavySkillRetained'])

    # the worst season cannot be hidden by averaging seasonal ratios
    def test_seasonal_improvement_and_missing_season(self):
        args = safe_recency()
        args[0]['bySeason']['MAM'][replay.PRIMARY]['volumeRatio'] = .69
        self.assertFalse(replay.candidate_screen(*args)['gates']['seasonalBalanceImproves'])
        args[0]['bySeason'].pop('JJA')
        result = replay.candidate_screen(*args)
        self.assertFalse(result['gates']['allSeasonsPresent'])
        self.assertFalse(result['gates']['seasonalBalanceImproves'])

    # unsupported recency cannot qualify through otherwise safe reference forecasts
    def test_support_required_and_report_not_mutated(self):
        args = safe_recency()
        original = copy.deepcopy(args[0])
        args[3][:] = False
        result = replay.candidate_screen(*args)
        self.assertFalse(result['gates']['candidateSupport'])
        self.assertFalse(result['passed'])
        self.assertEqual(args[0], original)

    # loading rejects changed native bytes before passing them to xgboost
    def test_native_model_hash_rejected_before_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'amount.json'
            path.write_text('{}')
            with patch.object(replay.xgb, 'Booster') as loader, self.assertRaises(ValueError):
                replay.load_booster(path, '0' * 64, 'reg:gamma')
            loader.assert_not_called()

    # scalar recency alone cannot change the preserved ordinal event calls
    def test_scalar_only_ordinal_categories_remain_fixed(self):
        raw = np.array([0., .2, 1.2, 3.])
        probability = np.full((4, 3), np.nan)
        rules = [{'threshold': threshold, 'cutoff': None} for threshold in (.1, 1., 2.5)]
        categories = ordinal.event_categories(raw, probability, rules)
        # every bounded scalar preserves the original category boundaries
        for scale in (.1, 1., 3.):
            projected = ordinal.project_amount(np.ones(4), categories, scale)
            np.testing.assert_array_equal(ordinal.event_categories(projected, probability, rules), categories)

    # complete old forecast population and exact reference arrays must match
    def test_reference_parity_checks_every_control(self):
        mapping = {name: name for name in (*search.BASELINES, 'weightedContext')}
        mapping['ordinal90'] = 'ordinalContext'
        predictions = {name: np.array([.25]) for name in mapping}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'inputs/context').mkdir(parents=True)
            np.savez(root / 'inputs/context/predictions.npz', indices=np.array([4]), **{'amount::' + name: np.array([.25]) for name in mapping.values()})
            self.assertTrue(replay.reference_parity(root, np.array([4]), predictions)['exactPredictions'])
            predictions['ordinal90'][0] = .3
            with self.assertRaises(ValueError):
                replay.reference_parity(root, np.array([4]), predictions)

    # insufficient effective mass keeps raw controls and ordinal predictions intact
    def test_unsupported_month_keeps_reference_and_all_rows(self):
        start = hour_number('2025-09-01T00:00:00Z')
        hours = np.array([start - 110 * 24, start - 10 * 24, start + 10])
        data = {'hour': hours, 'initialized': hours - 9, 'actual': np.full(3, .2), 'raw': np.full(3, .2), 'persistence': np.full(3, np.nan)}
        fit, cal, evaluation, bounds = search.month_masks(data, '2025-09')
        counts = {'training': replay.residual.support(data['actual'][fit], hours[fit]), 'calibration': replay.residual.support(data['actual'][cal], hours[cal])}
        pc, ac = np.full((1, 3), np.nan), np.ones(1)
        model = {'heads': {name: {'modelFile': name + '.json', 'sha256': 'x', 'objective': 'reg:gamma' if name == 'amount' else 'binary:logistic'} for name in ('0.1', '1.0', '2.5', 'amount')}}
        ordinal90, original, *_ = replay.uniform_ordinal(data['actual'][cal], hours[cal], data['raw'][cal], data['raw'][evaluation], pc, ac, pc, ac, model)
        weighted_model = {'modelSha256': 'x'}
        base = search.blended(data['raw'][cal], np.ones(1))
        scalar = search.calibrate(data['actual'][cal], hours[cal], lambda value: np.clip(base * value, 0, 30))
        previous = {**bounds, 'support': counts, 'candidates': {'ordinalContext': original, 'weightedContext': {'supported': True, 'model': weighted_model, 'calibration': scalar}}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'inputs/context/context-models/2025-09'
            old.mkdir(parents=True)
            (old / 'state.json').write_text(json.dumps(previous))
            original_root = root / 'inputs/sub24-models/2025-09'
            original_root.mkdir(parents=True)
            (original_root / 'state.json').write_text(json.dumps({'scales': {'raw': 1.}}))
            native = Mock()
            native.predict.return_value = np.ones(1)
            with patch.object(replay, 'load_booster', return_value=native), patch.object(replay.context, 'predict_ordinal', return_value=(pc, ac)):
                rows, output, state = replay.calibrate_month(data, np.zeros((3, 95), dtype=np.float32), root, '2025-09')
            np.testing.assert_array_equal(rows, [2])
            self.assertFalse(state['supported'])
            np.testing.assert_array_equal(output['volumeRecent'], output['volume90'])
            # every unsupported candidate and ablation reuses the unchanged ordinal control
            for name in replay.RECENT_ARMS:
                np.testing.assert_array_equal(output[name], ordinal90)

    # partial output must never be overwritten by a rerun
    def test_repeat_run_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'recency-states').mkdir()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), self.assertRaises(ValueError):
                replay.run(root)


# keep unit discovery isolated from private historical research
if __name__ == '__main__':
    unittest.main()
