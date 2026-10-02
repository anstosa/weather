"""fail closed on fixed rain-development gates and independent proof lineage."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re

# keep numerical scoring deterministic
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import rain_recency as fixed_gate
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_event_guard import load_inputs, same_tree, score_accumulations, score_events, score_groups
from verify_rain_recency import candidate_screen as independent_gate
from verify_rain_search import month_masks
from verify_rain_sub24_model import metrics, require

CONTRACT = 'rain-goal-candidate/v1'
REGRESSION_CONTRACT = 'rain-goal-regression/v1'
REFERENCE_PREDICTIONS_SHA256 = '78d2c60c3115faec558e4bf1b26055ed56078281636b4914879c8c53abb5fabe'
CONTROLS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'volumeRecent', 'ordinal90', 'weightedContext')
MONTHS = [f'2025-{month:02d}' for month in range(9, 13)] + [f'2026-{month:02d}' for month in range(1, 9)]
REPO_RESEARCH = Path(__file__).resolve().parent
PRIVATE_BASE = Path.home() / '.weather/research-work'


# compute an artifact checksum from actual bytes, not a stated digest
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# bind a canonical policy digest independent of JSON whitespace
def policy_sha(policy):
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


# resolve one safe child path without following links outside its root
def child(root, relative):
    relative = Path(relative)
    require(not relative.is_absolute() and relative.parts and '..' not in relative.parts, 'unsafe goal artifact path')
    path = root / relative
    require(path.resolve().is_relative_to(root.resolve()) and not any(part.is_symlink() for part in (path, *path.parents) if part != root.parent), 'linked or escaped goal artifact')
    return path


# require one exact private experiment root instead of arbitrary filesystem input
def private_root(value):
    root = Path(value)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink() and root.parent == PRIVATE_BASE and root.resolve().parent == PRIVATE_BASE.resolve() and root.name.startswith('weather-moisture-research-rain-'), 'invalid private rain goal root')
    return root


# verify source, freeze and report identities without evaluating assertions inside them
def frozen_artifacts(candidate):
    require(candidate['contractVersion'] == CONTRACT and isinstance(candidate['primaryArm'], str) and candidate['primaryArm'] and candidate['primaryArm'] not in CONTROLS, 'invalid rain goal candidate identity')
    root = private_root(candidate['root'])
    freeze_path = child(root, candidate['freezeFile'])
    source_dir = child(root, candidate['frozenSourcesDir'])
    report_path, prediction_path = root / 'report.json', root / 'predictions.npz'
    require(freeze_path.is_file() and source_dir.is_dir() and report_path.is_file() and prediction_path.is_file(), 'missing frozen goal artifact')
    require(sha(freeze_path) == candidate['freezeSha256'] and sha(report_path) == candidate['reportSha256'] and sha(prediction_path) == candidate['predictionsSha256'], 'stale goal artifact checksum')
    freeze, report = json.loads(freeze_path.read_text()), json.loads(report_path.read_text())
    require(freeze['policy'] == report['policy'] and policy_sha(freeze['policy']) == candidate['policySha256'], 'goal policy differs from frozen policy')
    selectable = freeze['policy'].get('candidates')
    require(isinstance(selectable, (list, dict)) and candidate['primaryArm'] in selectable, 'goal primary is not a frozen selectable candidate')
    require(freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'goal freeze outcome boundary changed')
    require(report['freezeSha256'] == candidate['freezeSha256'] and report['independentEvaluationPerformed'] is False and report['productionEligible'] is False and report['productionWrites'] is False, 'goal report claims unsupported evaluation or production')
    require(report['predictionsSha256'] == candidate['predictionsSha256'], 'goal report prediction checksum changed')
    sources = freeze['sourceSha256']
    require(isinstance(sources, dict) and sources and sources == candidate['sourceSha256'], 'goal frozen source map changed')
    # compare each pre-outcome source copy with the live code used for verification
    for name, expected in sources.items():
        require(Path(name).name == name and name.endswith('.py') and len(expected) == 64, 'invalid goal source entry')
        retained, live = child(source_dir, name), REPO_RESEARCH / name
        require(retained.is_file() and live.is_file() and not live.is_symlink() and sha(retained) == expected and sha(live) == expected, f'goal source changed: {name}')
    return root, freeze, report


# require the complete original development population regardless of support flags
def expected_indices(data, old_policy):
    require(old_policy['holdoutMonths'] == MONTHS, 'goal development month set changed')
    indices = [np.where(month_masks(data, month, old_policy, SEARCH_POLICY)[2])[0] for month in MONTHS]
    result = np.concatenate(indices)
    require(len(result) == 32896 and len(np.unique(result)) == len(result), 'goal baseline development population changed')
    return result


# read all arms and require original eight controls to be bytewise unchanged
def prediction_arrays(root, candidate, indices):
    primary = candidate['primaryArm']
    support_key = candidate['supportKey']
    require(isinstance(support_key, str) and support_key and support_key != 'indices' and not support_key.startswith('amount::'), 'invalid goal support key')
    with np.load(root / 'predictions.npz', allow_pickle=False) as archive:
        keys = set(archive.files)
        require('indices' in keys and support_key in keys and np.array_equal(archive['indices'], indices), 'goal candidate rows deleted or reordered')
        arms = {name.removeprefix('amount::') for name in keys if name.startswith('amount::')}
        require(set(CONTROLS) | {primary} <= arms and keys == {'indices', support_key} | {'amount::' + name for name in arms}, 'goal prediction schema or controls changed')
        amounts = {name: archive['amount::' + name] for name in arms}
        supported = archive[support_key]
    require(supported.shape == indices.shape and supported.dtype == np.dtype(bool), 'goal candidate support flag changed')
    # fail on dropped, invalid or different-length arms before any metric can hide them
    for name, value in amounts.items():
        require(value.shape == indices.shape and np.issubdtype(value.dtype, np.number) and np.isfinite(value).all() and (value >= 0).all(), f'invalid goal prediction arm: {name}')
    reference_path = child(root, candidate['referenceControls'])
    require(candidate['referenceControlsSha256'] == REFERENCE_PREDICTIONS_SHA256 and reference_path.is_file() and sha(reference_path) == REFERENCE_PREDICTIONS_SHA256, 'goal reference controls unpinned')
    with np.load(reference_path, allow_pickle=False) as reference:
        require(np.array_equal(reference['indices'], indices), 'goal reference row population changed')
        # all eight prior forecasts must retain the fixed comparison denominator
        for name in CONTROLS:
            require(np.array_equal(amounts[name], reference['amount::' + name]), f'goal control changed: {name}')
    return amounts, supported


# recompute every reported score partition from retained labels and point forecasts
def recomputed_scores(data, old_policy, indices, amounts):
    actual, hours = data['actual'][indices], data['hour'][indices]
    result = {'overall': {name: metrics(actual, value, (value >= .1).astype(float), hours) for name, value in amounts.items()}}
    result.update(score_groups(data, indices, amounts, old_policy))
    result['events'] = score_events(actual, hours, amounts, SEARCH_POLICY['thresholdsMmPerHour'])
    result['accumulations'] = score_accumulations(data, indices, amounts)
    result['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(value).all() and (value >= 0).all() for value in amounts.values()))}
    return result


# rename only the new primary arm at the unchanged forty-nine-gate interface
def gate_view(scores, primary):
    sections = ('overall', 'bySeason', 'byLeadBand', 'events')
    view = {name: scores[name] for name in (*sections, 'accumulations', 'invariants')}
    # preserve nested metric values while replacing the candidate key
    def renamed(value):
        if isinstance(value, dict):
            return {('ordinalRecent' if key == primary else key): renamed(item) for key, item in value.items() if primary == 'ordinalRecent' or key != 'ordinalRecent'}
        if isinstance(value, list):
            return [renamed(item) for item in value]
        return value

    return renamed(view)


# derive gates twice from source scores, never trusting reported passed booleans
def recomputed_gates(report, scores, data, indices, supported, primary):
    for name, value in scores.items():
        same_tree(value, report[name], f'goalReport.{name}')
    view = gate_view(scores, primary)
    original = fixed_gate.candidate_screen(view, data, indices, supported)
    separate = independent_gate(view, data, indices, supported)
    same_tree(separate, original, 'goalFixedGateParity')
    require(len(original['gates']) == 49 and set(original['gates']) == set(report['candidateScreen']['gates']), 'goal fixed gate set changed')
    same_tree(original, report['candidateScreen'], 'goalReportedGateScreen')
    selected = primary if original['passed'] else None
    require(report['selectedCandidate'] == selected and report['developmentPassed'] is bool(original['passed']), 'goal selection differs from recomputed gates')
    return original


# bind one independent verifier proof to the exact frozen bytes and outcome flags
def independent_proof(candidate, report, root):
    proof_path = Path(candidate['independentReceipt'])
    source_path = Path(candidate['verifierSource'])
    require(proof_path.is_absolute() and proof_path.is_file() and not proof_path.is_symlink() and sha(proof_path) == candidate['independentReceiptSha256'], 'missing or stale independent replay proof')
    require(source_path.is_absolute() and source_path.parent == REPO_RESEARCH and source_path.name.startswith('verify_rain_') and source_path.suffix == '.py' and source_path.is_file() and not source_path.is_symlink() and sha(source_path) == candidate['verifierSourceSha256'], 'independent verifier source changed')
    require(source_path.name not in candidate['sourceSha256'], 'producer source cannot serve as independent verifier')
    proof = json.loads(proof_path.read_text())
    require(proof['verified'] is True and proof['all49GatesVerified'] is True and proof['developmentPredictionRows'] == 32896 and proof['freezeSha256'] == candidate['freezeSha256'] and proof['reportSha256'] == candidate['reportSha256'] and proof['predictionsSha256'] == candidate['predictionsSha256'] and proof['verifierSourceSha256'] == candidate['verifierSourceSha256'], 'independent proof does not bind goal artifacts')
    require(proof['selectedCandidate'] == report['selectedCandidate'] and proof['developmentPassed'] is report['developmentPassed'] and proof['independentEvaluationPerformed'] is False and proof['productionEligible'] is False and proof['productionWrites'] is False, 'independent proof outcome boundary changed')
    require(proof.get('privateRoot') == str(root), 'independent proof root changed')


# bind passing synthetic/regression evidence to both code bytes and captured output
def regression_proof(candidate):
    receipt_path, log_path = Path(candidate['regressionReceipt']), Path(candidate['regressionLog'])
    require(receipt_path.is_absolute() and log_path.is_absolute() and receipt_path.is_file() and log_path.is_file() and not receipt_path.is_symlink() and not log_path.is_symlink(), 'missing regression receipt or log')
    require(sha(receipt_path) == candidate['regressionReceiptSha256'] and sha(log_path) == candidate['regressionLogSha256'], 'stale regression evidence')
    receipt = json.loads(receipt_path.read_text())
    require(receipt['contractVersion'] == REGRESSION_CONTRACT and receipt['sourceSha256'] == candidate['sourceSha256'] and receipt['logSha256'] == candidate['regressionLogSha256'], 'regression receipt source or log changed')
    require(receipt['passed'] is True and receipt['exitCode'] == 0 and type(receipt['testsRun']) is int and receipt['testsRun'] > 0, 'regression check did not pass')
    command, test_source = receipt['command'], Path(receipt['testSource'])
    require(isinstance(command, list) and len(command) >= 2 and all(isinstance(part, str) and part for part in command) and Path(command[0]).is_absolute() and Path(command[0]).name in ('python', 'python3', 'python3.14') and Path(command[0]).is_file() and test_source.is_absolute() and test_source.parent == REPO_RESEARCH and test_source.name.startswith('test_rain_') and str(test_source) in command and test_source.is_file() and not test_source.is_symlink() and sha(test_source) == receipt['testSourceSha256'], 'regression command or test source changed')
    log = log_path.read_text()
    summary = re.search(r'(?m)^Ran (\d+) tests? in [^\n]+\n', log)
    require(summary is not None and int(summary.group(1)) == receipt['testsRun'] and re.search(r'(?m)^OK$', log) is not None, 'regression output lacks a matching passing test summary')


# preserve recomputed gate diagnostics even when an independent proof is missing
def evaluate(receipt_path):
    candidate = json.loads(Path(receipt_path).read_text())
    root, freeze, report = frozen_artifacts(candidate)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(freeze['featureNames'] == old_names and old_freeze['featureNames'] == old_names, 'goal paired feature lineage changed')
    indices = expected_indices(data, old_policy)
    amounts, supported = prediction_arrays(root, candidate, indices)
    scores = recomputed_scores(data, old_policy, indices, amounts)
    screen = recomputed_gates(report, scores, data, indices, supported, candidate['primaryArm'])
    errors = []
    # let a missing independent verifier remain a recorded development failure
    for name, check in (('independentProof', independent_proof), ('regressionProof', regression_proof)):
        try:
            check(candidate, report, root) if name == 'independentProof' else check(candidate)
        except (KeyError, OSError, TypeError, ValueError) as error:
            errors.append({'check': name, 'error': str(error)})
    passed = screen['passed'] and not errors
    return {'contractVersion': 'rain-goal-evaluation/v1', 'verdict': 'PASS' if passed else 'FAIL', 'primaryArm': candidate['primaryArm'], 'root': str(root), 'developmentRows': len(indices), 'gatesVerified': 49, 'passedGates': [name for name, value in screen['gates'].items() if value], 'failedGates': screen['failedGates'], 'proofErrors': errors, 'developmentPassed': bool(passed), 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'reportSha256': candidate['reportSha256'], 'predictionsSha256': candidate['predictionsSha256'], 'freezeSha256': candidate['freezeSha256']}


# accept one candidate receipt and optionally retain an exclusive evaluation artifact
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    try:
        result = evaluate(arguments.candidate)
    except Exception as error:
        result = {'contractVersion': 'rain-goal-evaluation/v1', 'verdict': 'FAIL', 'error': str(error), 'developmentPassed': False, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    # never overwrite a prior pass or failed-attempt record
    if arguments.output is not None:
        with arguments.output.open('x') as stream:
            json.dump(result, stream, sort_keys=True, allow_nan=False)
            stream.write('\n')
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    raise SystemExit(0 if result['verdict'] == 'PASS' else 1)
