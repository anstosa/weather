"""lock the matched wind-vector model before any development outcome."""

import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rain_wind as replay


# test the one new predictor hypothesis without opening observed outcomes
class WindExperimentTests(unittest.TestCase):
    # preserve the learner while adding exactly six predictors
    def test_one_wind_primary_and_unchanged_monthly_learner(self):
        self.assertEqual(replay.POLICY['candidates'], ['hurdleWind'])
        self.assertEqual(replay.POLICY['boostRounds'], 160)
        self.assertEqual(replay.POLICY['nativeModelsFit'], 48)
        self.assertEqual(replay.POLICY['nativeModelsReused'], 0)
        self.assertEqual(len(replay.POLICY['featureNames']), 107)
        self.assertEqual(replay.POLICY['featureNames'][:101], replay.parent.POLICY['featureNames'])
        self.assertEqual(len(replay.POLICY['windVectorFeatures']), 6)
        self.assertEqual(replay.POLICY['calibrationAlgorithm'], replay.parent.POLICY['calibrationAlgorithm'])
        self.assertEqual(replay.POLICY['fitWeight'], replay.parent.POLICY['fitWeight'])
        self.assertEqual(replay.POLICY['trainingSupport'], replay.parent.POLICY['trainingSupport'])
        self.assertEqual(replay.POLICY['calibrationSupport'], replay.parent.POLICY['calibrationSupport'])
        self.assertEqual(replay.POLICY['effectiveSupport'], replay.parent.POLICY['effectiveSupport'])
        self.assertNotIn('calibrationCadence', replay.POLICY)
        self.assertNotIn('fitHalfLifeDays', replay.POLICY)
        self.assertFalse(replay.POLICY['productionEligible'])
        self.assertEqual(replay.hurdle, replay.parent.hurdle)

    # keep every diagnostic control through the nested primary aliases
    def test_real_report_keeps_controls_and_all49_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # provide only synthetic metadata required for report hashes
            for name in ('hurdle-freeze.json', 'trajectory-freeze.json', 'wind-freeze.json'):
                (root / name).write_text('{}')
            size = 366
            hours = np.arange(size) * 24 + 488016
            leads = np.resize(np.array([1, 7, 13]), size)
            data = {'actual': np.full(size, .2), 'mean': np.full(size, .2), 'hour': hours, 'initialized': hours - 8 - leads, 'lead': leads}
            predictions = {name: np.full(size, .8) for name in replay.ARMS}
            predictions['hurdleOriginal'][:] = .5
            predictions['trajectoryOriginal'][:] = .6
            predictions[replay.PRIMARY][:] = .2
            report = replay.make_report(root, data, np.arange(size), predictions, np.ones(size, dtype=bool), {'month': {'model': None}})
            self.assertEqual(report['overall'][replay.PRIMARY]['mae'], 0.)
            self.assertAlmostEqual(report['overall']['hurdleOriginal']['mae'], .3)
            self.assertAlmostEqual(report['overall']['trajectoryOriginal']['mae'], .4)
            self.assertAlmostEqual(report['overall']['ordinalRecent']['mae'], .6)
            self.assertNotIn(replay.parent.PRIMARY, report['overall'])
            self.assertEqual(len(report['candidateScreen']['gates']), 49)
            self.assertEqual(report['policy'], replay.POLICY)
            self.assertEqual(report['freezeSha256'], replay.inputs.sha(root / 'wind-freeze.json'))

    # retain partial artifacts rather than silently repeating an experiment
    def test_partial_features_stop_before_loading_outcomes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'features.npz').touch()
            with patch.object(replay, 'validate_private_root', return_value=root), patch.object(replay, 'validate_freeze'), patch.object(replay.inputs, 'load_inputs') as loader, self.assertRaises(ValueError):
                replay.run(root)
            loader.assert_not_called()

    # unsupported months preserve the original ordinal forecasts and row identities
    def test_unsupported_month_retains_original_ordinal(self):
        size = 6
        data = {'actual': np.ones(size), 'hour': np.arange(size) * 24}
        fit = np.array([True, True, False, False, False, False])
        calibration = np.array([False, False, True, True, False, False])
        evaluation = np.array([False, False, False, False, True, True])
        control = np.array([.2, 1.1])
        with patch.object(replay.search, 'month_masks', return_value=(fit, calibration, evaluation, {'calibrationMaximumValidHourExclusive': 96})), patch.object(replay.residual, 'supported', return_value=False), patch.object(replay.context, 'fit_ordinal') as train:
            rows, predicted, state = replay.fit_month(Path('/unused'), data, np.zeros((size, 107)), 'synthetic', control)
        np.testing.assert_array_equal(rows, [4, 5])
        np.testing.assert_array_equal(predicted, control)
        self.assertFalse(state['supported'])
        train.assert_not_called()

    # native fitting receives only the unchanged historical fit population
    def test_fit_never_reads_evaluation_targets(self):
        source = inspect.getsource(replay.fit_month)
        self.assertIn("context.fit_ordinal(x[fit], data['actual'][fit], data['hour'][fit]", source)
        self.assertNotIn("data['actual'][evaluation]", source)
        self.assertNotIn('daily', source)
        self.assertNotIn('decay', source)

    # inherited source members may not escape the new private input directory
    def test_source_copy_rejects_path_traversal(self):
        with patch.object(replay, 'copy_member') as copy:
            for source_name, destination in (('../outside', 'inside'), ('inside', '../outside'), ('/absolute', 'inside'), ('inside', '/absolute')):
                with self.subTest(source=source_name, destination=destination), self.assertRaises(ValueError):
                    replay.copy_input(Path('/source'), Path('/root'), source_name, destination, 'unused', {})
            copy.assert_not_called()

    # require the full source verifier's actual receipt field names and counts
    def test_direction_copy_requires_full_hash_bound_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / replay.DIRECTION_ROOT_NAME
            (source / 'final-evidence').mkdir(parents=True)
            root = base / replay.ROOT_NAME
            report = {'contractVersion': 'rain-wind-continuation/v1', 'status': 'complete', 'uniqueSuccessfulRuns': 3301, 'uniqueRepresentedRuns': 3301, 'newUnresolvedRuns': 0, 'sourceQualified': True, 'parentTransportPolicyConformant': False, 'parentSourceQualified': False, 'inheritedSpacingViolationCount': 25, 'reusedSuccessfulRuns': 1713, 'newSuccessfulRuns': 1588, 'parentHttpAttempts': 1716, 'newHttpAttempts': 1589, 'totalHttpAttempts': 3305, 'normalizedFile': replay.DIRECTION_NORMALIZED, 'normalizedRows': 158448, 'normalizedSha256': Path(replay.DIRECTION_NORMALIZED).name}
            (source / 'report.json').write_text(json.dumps(report))
            verified = {'contractVersion': 'rain-wind-continuation-verification/v1', 'verdict': 'PASS', 'reportSha256': 'report.json', 'freezeSha256': 'wind-continuation-freeze.json', 'normalizedSha256': Path(replay.DIRECTION_NORMALIZED).name, 'normalizedRows': 158448, 'uniqueSuccessfulRuns': 3301, 'uniqueRepresentedRuns': 3301, 'newUnresolvedRuns': 0, 'sourceQualified': True, 'parentTransportPolicyConformant': False, 'parentSourceQualified': False, 'inheritedSpacingViolationCount': 25, 'historicalAsIssuedVerified': False, 'freshHoldoutVerified': False, 'modelGatesEvaluated': False, 'verifierSourceSha256': 'verify_rain_wind_continuation.py'}
            proof = source / 'final-evidence/independent-verification.json'
            proof.write_text(json.dumps(verified))
            with patch.object(replay, 'validate_private_root', side_effect=Path), patch.object(replay, 'retained_manifest', return_value={'files': {}}), patch.object(replay.inputs, 'sha', side_effect=lambda path: Path(path).name), patch.object(replay, 'copy_input'), patch.object(replay, 'copy_member'):
                replay.copy_direction_source(source, root, base / 'receipt.json', {})
                # a pilot-style or stale alias cannot substitute for full proof
                for key, value in (('contractVersion', 'rain-direction-pilot-verification/v1'), ('reportSha256', 'wrong'), ('uniqueSuccessfulRuns', 6), ('freshHoldoutVerified', True), ('normalizedSha256', 'changed'), ('sourceQualified', False), ('newUnresolvedRuns', 1), ('parentTransportPolicyConformant', True), ('inheritedSpacingViolationCount', 0)):
                    altered = {**verified, key: value}
                    proof.write_text(json.dumps(altered))
                    with self.subTest(field=key), self.assertRaises(ValueError):
                        replay.copy_direction_source(source, root, base / 'receipt.json', {})


# run the direct byte-bound regression suite without private datasets
if __name__ == '__main__':
    unittest.main()
