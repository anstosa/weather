"""synthetic fail-closed contracts for the fixed rain development goal."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import evaluate_rain_goal as goal
from test_verify_rain_recency import safe_recency_screen


# write one canonical JSON artifact for synthetic provenance checks
def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, allow_nan=False) + '\n')


# build source-frozen synthetic metadata without opening historical outcomes
def frozen_fixture(directory):
    base = Path(directory)
    root = base / 'weather-moisture-research-rain-synthetic'
    root.mkdir()
    source_dir = root / 'goal-sources'
    source_dir.mkdir()
    repo = base / 'research'
    repo.mkdir()
    for path in (source_dir / 'rain_candidate.py', repo / 'rain_candidate.py'):
        path.write_text('POLICY = {}\n')
    source_hash = goal.sha(repo / 'rain_candidate.py')
    policy = {'contractVersion': 'synthetic-rain-goal/v1', 'candidates': ['newHurdle']}
    freeze = {'policy': policy, 'sourceSha256': {'rain_candidate.py': source_hash}, 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    write_json(root / 'candidate-freeze.json', freeze)
    np.savez(root / 'predictions.npz', indices=np.array([0]), **{'amount::raw': np.array([0.])})
    freeze_hash, prediction_hash = goal.sha(root / 'candidate-freeze.json'), goal.sha(root / 'predictions.npz')
    report = {'policy': policy, 'freezeSha256': freeze_hash, 'predictionsSha256': prediction_hash, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    write_json(root / 'report.json', report)
    candidate = {'contractVersion': goal.CONTRACT, 'root': str(root), 'primaryArm': 'newHurdle', 'supportKey': 'supported::newHurdle', 'freezeFile': 'candidate-freeze.json', 'frozenSourcesDir': 'goal-sources', 'freezeSha256': freeze_hash, 'policySha256': goal.policy_sha(policy), 'sourceSha256': freeze['sourceSha256'], 'reportSha256': goal.sha(root / 'report.json'), 'predictionsSha256': prediction_hash}
    return root, repo, report, candidate


# replace only a synthetic candidate's key at the fixed-gate boundary
def named_screen():
    report, data, indices, flags = safe_recency_screen()

    # avoid sharing the old primary name with the new candidate
    def rename(value):
        if isinstance(value, dict):
            return {('newHurdle' if name == 'ordinalRecent' else name): rename(item) for name, item in value.items()}
        if isinstance(value, list):
            return [rename(item) for item in value]
        return value

    scores = rename(report)
    expected = goal.fixed_gate.candidate_screen(goal.gate_view(scores, 'newHurdle'), data, indices, flags)
    scores['candidateScreen'] = expected
    scores['selectedCandidate'] = 'newHurdle'
    scores['developmentPassed'] = True
    return scores, data, indices, flags


class RainGoalEvaluationTests(unittest.TestCase):
    # freeze and live source bytes must match the candidate receipt exactly
    def test_rejects_stale_report_and_changed_source(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(goal, 'PRIVATE_BASE', Path(directory)):
            root, repo, _, candidate = frozen_fixture(directory)
            with patch.object(goal, 'REPO_RESEARCH', repo):
                self.assertEqual(goal.frozen_artifacts(candidate)[0], root)
                stale = {**candidate, 'reportSha256': '0' * 64}
                with self.assertRaises(ValueError):
                    goal.frozen_artifacts(stale)
                diagnostic = {**candidate, 'primaryArm': 'nonselectableDiagnostic'}
                with self.assertRaises(ValueError):
                    goal.frozen_artifacts(diagnostic)
                (repo / 'rain_candidate.py').write_text('POLICY = {"changed": True}\n')
                with self.assertRaises(ValueError):
                    goal.frozen_artifacts(candidate)

    # old ordinalRecent diagnostic cannot overwrite a new primary at either insertion order
    def test_gate_alias_discards_old_ordinal_recent_without_dropping_its_scores(self):
        report, data, indices, flags = named_screen()

        # inject a deliberately failing old diagnostic around every candidate metric leaf
        def with_old(value, old_first):
            if not isinstance(value, dict):
                return value
            result = {name: with_old(item, old_first) for name, item in value.items()}
            if 'newHurdle' in result:
                old = copy.deepcopy(result['newHurdle'])
                if 'mae' in old:
                    old['mae'] = 99.
                if '1.0' in old:
                    old['1.0']['pod'] = 0.
                result = ({'ordinalRecent': old, **result} if old_first else {**result, 'ordinalRecent': old})
            return result

        for old_first in (True, False):
            with self.subTest(old_first=old_first):
                scores = with_old(report, old_first)
                view = goal.gate_view(scores, 'newHurdle')
                self.assertEqual(view['overall']['ordinalRecent']['mae'], report['overall']['newHurdle']['mae'])
                self.assertTrue(goal.fixed_gate.candidate_screen(view, data, indices, flags)['passed'])
                self.assertIn('ordinalRecent', scores['overall'])

    # all forty-nine old-and-new gates are recomputed from score trees
    def test_recomputes_fixed_gates_and_rejects_reported_regression_lie(self):
        report, data, indices, flags = named_screen()
        scores = {name: copy.deepcopy(report[name]) for name in ('overall', 'bySeason', 'byLeadBand', 'events', 'accumulations', 'invariants')}
        screen = goal.recomputed_gates(report, scores, data, indices, flags, 'newHurdle')
        self.assertEqual(len(screen['gates']), 49)
        self.assertTrue(screen['passed'])
        report['candidateScreen']['gates']['heavySkillRetained'] = False
        with self.assertRaises(ValueError):
            goal.recomputed_gates(report, scores, data, indices, flags, 'newHurdle')

    # actual heavy-event loss remains a failed gate when reported honestly
    def test_heavy_regression_blocks_goal(self):
        report, data, indices, flags = named_screen()
        report['events']['newHurdle']['1.0']['pod'] = .69
        scores = {name: copy.deepcopy(report[name]) for name in ('overall', 'bySeason', 'byLeadBand', 'events', 'accumulations', 'invariants')}
        screen = goal.fixed_gate.candidate_screen(goal.gate_view(scores, 'newHurdle'), data, indices, flags)
        report['candidateScreen'] = screen
        report['selectedCandidate'] = None
        report['developmentPassed'] = False
        rebuilt = goal.recomputed_gates(report, scores, data, indices, flags, 'newHurdle')
        self.assertFalse(rebuilt['passed'])
        self.assertIn('heavySkillRetained', rebuilt['failedGates'])

    # missing verifier evidence cannot be replaced with producer success flags
    def test_independent_proof_missing_stale_and_current(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / 'research'
            repo.mkdir()
            source = repo / 'verify_rain_candidate.py'
            source.write_text('VERIFIED = True\n')
            proof_path = base / 'proof.json'
            root = base / 'weather-moisture-research-rain-synthetic'
            report = {'selectedCandidate': 'newHurdle', 'developmentPassed': True}
            candidate = {'independentReceipt': str(proof_path), 'independentReceiptSha256': '0' * 64, 'verifierSource': str(source), 'verifierSourceSha256': goal.sha(source), 'sourceSha256': {'rain_candidate.py': '1' * 64}, 'freezeSha256': '2' * 64, 'reportSha256': '3' * 64, 'predictionsSha256': '4' * 64}
            with patch.object(goal, 'REPO_RESEARCH', repo):
                with self.assertRaises(ValueError):
                    goal.independent_proof(candidate, report, root)
                proof = {'verified': True, 'all49GatesVerified': True, 'developmentPredictionRows': 32896, 'freezeSha256': candidate['freezeSha256'], 'reportSha256': candidate['reportSha256'], 'predictionsSha256': candidate['predictionsSha256'], 'verifierSourceSha256': candidate['verifierSourceSha256'], 'selectedCandidate': 'newHurdle', 'developmentPassed': True, 'privateRoot': str(root), 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
                write_json(proof_path, proof)
                with self.assertRaises(ValueError):
                    goal.independent_proof(candidate, report, root)
                candidate['independentReceiptSha256'] = goal.sha(proof_path)
                goal.independent_proof(candidate, report, root)
                source.write_text('VERIFIED = False\n')
                with self.assertRaises(ValueError):
                    goal.independent_proof(candidate, report, root)

    # regression evidence requires a passing command, source bytes and matching log
    def test_regression_proof_rejects_missing_or_failed_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / 'research'
            repo.mkdir()
            test_source = repo / 'test_rain_candidate.py'
            test_source.write_text('def test_one(): pass\n')
            log_path, receipt_path = base / 'tests.log', base / 'tests.json'
            candidate = {'regressionReceipt': str(receipt_path), 'regressionReceiptSha256': '0' * 64, 'regressionLog': str(log_path), 'regressionLogSha256': '0' * 64, 'sourceSha256': {'rain_candidate.py': '1' * 64}}
            with patch.object(goal, 'REPO_RESEARCH', repo):
                with self.assertRaises(ValueError):
                    goal.regression_proof(candidate)
                log_path.write_text('Ran 1 test in 0.001s\n\nOK\n')
                candidate['regressionLogSha256'] = goal.sha(log_path)
                receipt = {'contractVersion': goal.REGRESSION_CONTRACT, 'sourceSha256': candidate['sourceSha256'], 'logSha256': candidate['regressionLogSha256'], 'passed': True, 'exitCode': 0, 'testsRun': 1, 'command': ['/usr/bin/python3', str(test_source)], 'testSource': str(test_source), 'testSourceSha256': goal.sha(test_source)}
                write_json(receipt_path, receipt)
                candidate['regressionReceiptSha256'] = goal.sha(receipt_path)
                goal.regression_proof(candidate)
                receipt['exitCode'] = 1
                write_json(receipt_path, receipt)
                candidate['regressionReceiptSha256'] = goal.sha(receipt_path)
                with self.assertRaises(ValueError):
                    goal.regression_proof(candidate)

    # exact original population is required before inspecting any candidate score
    def test_candidate_rows_cannot_be_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            np.savez(root / 'predictions.npz', indices=np.array([2]), supported=np.array([True]), **{'amount::raw': np.array([0.])})
            candidate = {'primaryArm': 'newHurdle', 'supportKey': 'supported', 'referenceControls': 'reference.npz', 'referenceControlsSha256': goal.REFERENCE_PREDICTIONS_SHA256}
            with self.assertRaises(ValueError):
                goal.prediction_arrays(root, candidate, np.array([2, 3]))

    # a computed gate result remains visible while absent proof blocks completion
    def test_evaluate_reports_gates_before_missing_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate_path = Path(directory) / 'candidate.json'
            write_json(candidate_path, {'primaryArm': 'newHurdle', 'reportSha256': '1' * 64, 'predictionsSha256': '2' * 64, 'freezeSha256': '3' * 64})
            report, data, indices, flags = named_screen()
            screen = {'gates': {'example': True}, 'passed': True, 'failedGates': []}
            frozen = {'featureNames': ['x']}
            with patch.object(goal, 'frozen_artifacts', return_value=(Path(directory), frozen, report)), patch.object(goal, 'load_inputs', return_value=({'featureNames': ['x']}, {}, ['x'], data)), patch.object(goal, 'expected_indices', return_value=indices), patch.object(goal, 'prediction_arrays', return_value=({}, flags)), patch.object(goal, 'recomputed_scores', return_value={}), patch.object(goal, 'recomputed_gates', return_value=screen), patch.object(goal, 'independent_proof', side_effect=ValueError('proof missing')), patch.object(goal, 'regression_proof'):
                result = goal.evaluate(candidate_path)
            self.assertEqual(result['verdict'], 'FAIL')
            self.assertEqual(result['passedGates'], ['example'])
            self.assertEqual(result['proofErrors'][0]['check'], 'independentProof')


if __name__ == '__main__':
    unittest.main()
