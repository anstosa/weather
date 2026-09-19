"""lock the next rain hypothesis and unchanged development decision boundary."""

import copy
import inspect
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_hurdle as replay
import rain_recency as recency
from test_rain_recency import safe_recency


# create synthetic metrics without opening retained development outcomes
def safe_hurdle():
    report, data, indices, supported = safe_recency()

    # append the new metric at each candidate-bearing node
    def expand(value):
        # retain scalar leaves verbatim
        if not isinstance(value, dict):
            return value
        result = {name: expand(item) for name, item in value.items()}
        # retain the old candidate as a distinct nonselectable control
        if recency.PRIMARY in result:
            result[replay.PRIMARY] = copy.deepcopy(result[recency.PRIMARY])
        return result

    return expand(report), data, indices, supported


# verify integration and fail-closed boundaries independently of numerical fits
class HurdleExperimentTests(unittest.TestCase):
    # the next experiment cannot silently turn into a model or gate search
    def test_frozen_policy(self):
        self.assertEqual(replay.POLICY['candidates'], ['hurdleCategory'])
        self.assertEqual(replay.POLICY['categorySupport'], {'wetHours': 20, 'wetDates': 5})
        self.assertEqual(len(replay.POLICY['featureNames']), 95)
        self.assertEqual(replay.POLICY['expectedEvaluationRows'], 32896)
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertNotIn('xgb.train(', inspect.getsource(replay))
        self.assertTrue(set(recency.SOURCE_FILES) <= set(replay.SOURCE_FILES))

    # candidate aliasing retains all 49 gates without changing input reports
    def test_all_49_gates_and_nonmutation(self):
        report, data, indices, supported = safe_hurdle()
        original = copy.deepcopy(report)
        result = recency.candidate_screen(replay.screen_view(report), data, indices, supported)
        self.assertEqual(len(result['gates']), 49)
        self.assertTrue(result['passed'])
        self.assertEqual(report, original)

    # passing controls must not conceal a failing primary
    def test_primary_not_previous_arm_is_screened(self):
        report, data, indices, supported = safe_hurdle()
        report['overall'][replay.PRIMARY]['mae'] = 100.
        result = recency.candidate_screen(replay.screen_view(report), data, indices, supported)
        self.assertFalse(result['passed'])
        self.assertFalse(result['gates']['beatsRecentVolumeScale'])

    # wet and heavy skill remain separate nonnegotiable checks
    def test_wet_season_and_heavy_regression_rejected(self):
        report, data, indices, supported = safe_hurdle()
        report['bySeason']['SON'][replay.PRIMARY]['pod'] = 0.
        report['events'][replay.PRIMARY]['1.0']['pod'] = 0.
        result = recency.candidate_screen(replay.screen_view(report), data, indices, supported)
        self.assertFalse(result['gates']['seasonSONDetection'])
        self.assertFalse(result['gates']['heavySkillRetained'])

    # copied inputs cannot follow links or accept stale byte hashes
    def test_copy_rejects_stale_hash_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'input'
            source.write_text('retained')
            with self.assertRaises(ValueError):
                replay.copy_member(source, root / 'bad-copy', '0' * 64)
            link = root / 'linked'
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                replay.copy_member(link, root / 'linked-copy', replay.inputs.sha(source))
            replay.copy_member(source, root / 'good-copy', replay.inputs.sha(source))
            self.assertEqual((root / 'good-copy').read_bytes(), source.read_bytes())

    # an existing output never disappears through an automatic rerun
    def test_run_refuses_existing_evidence_before_loading_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'report.json').write_text('{}')
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # model inference receives features and raw forecasts but never labels
    def test_native_inference_has_no_outcome_argument(self):
        self.assertNotIn("data['actual']", inspect.getsource(replay.native_inputs))
        self.assertEqual(tuple(inspect.signature(replay.hurdle.predict).parameters), ('raw', 'probabilities', 'base', 'state'))


# support direct narrow regression execution
if __name__ == '__main__':
    unittest.main()
