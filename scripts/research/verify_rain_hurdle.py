"""independently refit fixed trees and replay the frozen hurdle experiment."""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path

# pin deterministic native reductions before numerical imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
from rain_hurdle import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_context import build_features, feature_sets, load_profiles
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_recency import (
    CONTEXT_PINS,
    MONTHS,
    calibrate_recent,
    effective_support,
    recent_weights,
    refit_models,
    sha,
)
from verify_rain_search import calibrate, checked_rules, month_masks, ordinal_categories, ordinal_project, ordinal_rules, support
from verify_rain_sub24_model import require, weights
from verify_rain_sub24_model import metrics
import evaluate_rain_goal as goal

PRIMARY = 'hurdleCategory'
ARMS = (*goal.CONTROLS, 'ordinalRecentAmount', 'ordinalRecentEvents', 'ordinalRecent', PRIMARY)
PREVIOUS_PINS = {
    'recency-freeze.json': '262faaa7f2190ba6de6a2a4324681ebfd3228ca07cc7890a010080b78193d6bb',
    'report.json': '115298848c368e5b632a17cf58892f2cd0d061eae1a314f0de41955d1e226a5e',
    'predictions.npz': '78d2c60c3115faec558e4bf1b26055ed56078281636b4914879c8c53abb5fabe',
    'retention-manifest.json': '8248d73a7251d1d9c07cc8af872c7d7d35bb38f8f57a6c05835c60f4dea8825c',
}
THRESHOLDS = (.1, 1., 2.5)
SCALE_BOUNDS = [.1, 3.]


# calculate uniform wet skill after highest-category resolution
def wet_metrics(actual, raw, probability, rules, mass):
    category = ordinal_categories(raw, probability, rules)
    observed, called = actual >= .1, category >= 1
    hit = float(mass @ (observed & called))
    miss = float(mass @ (observed & ~called))
    false = float(mass @ (~observed & called))
    return {'pod': 0. if hit + miss == 0 else hit / (hit + miss), 'far': 0. if hit + false == 0 else false / (hit + false), 'csi': 0. if hit + miss + false == 0 else hit / (hit + miss + false)}


# enumerate every native wet score while preserving both original heavy rules
def select_wet_rule(actual, hours, raw, probability, uniform):
    mass = weights(hours)
    observed = actual >= .1
    positive_hours = np.unique(hours[observed])
    counts = {'positiveHours': int(len(positive_hours)), 'positiveDates': int(len(np.unique(positive_hours // 24)))}
    raw_rules = [{'threshold': threshold, 'cutoff': None} for threshold in THRESHOLDS]
    raw_skill = wet_metrics(actual, raw, probability, raw_rules, mass)
    original = copy.deepcopy(uniform)
    old_skill = wet_metrics(actual, raw, probability, original, mass)
    choice = {'support': counts, 'rawMetrics': raw_skill, 'oldNestedMetrics': old_skill, 'candidateScores': 0, 'feasibleScores': 0, 'selectedMetrics': old_skill, 'selectedCutoff': original[0]['cutoff'], 'reason': 'old_wet_rule_fallback'}
    scores = probability[:, 0]
    # retain old wet calls when positives do not support a new threshold
    if counts['positiveHours'] < 10 or counts['positiveDates'] < 2:
        choice['reason'] = 'insufficient_wet_support'
        return original, choice
    # a wholly missing wet head cannot define calibrated calls
    if np.isnan(scores).all():
        choice['reason'] = 'missing_wet_head'
        return original, choice
    require(np.isfinite(scores).all() and ((scores >= 0) & (scores <= 1)).all(), 'invalid hurdle wet scores')
    selected_rules, selected_skill = original, old_skill
    selected_cutoff = original[0]['cutoff']
    old_safe = old_skill['pod'] + 1e-12 >= raw_skill['pod'] and old_skill['far'] <= raw_skill['far'] + .05 + 1e-12
    best = (old_skill['csi'], float('-inf') if selected_cutoff is None else float(selected_cutoff)) if old_safe else None
    unique = np.unique(scores)
    choice['candidateScores'] = int(len(unique))
    # compare final nested wet calls at each distinct native cutoff
    for score in unique:
        rules = copy.deepcopy(original)
        rules[0]['cutoff'] = float(score)
        skill = wet_metrics(actual, raw, probability, rules, mass)
        # raw POD and FAR constraints precede any CSI ranking
        if skill['pod'] + 1e-12 < raw_skill['pod'] or skill['far'] > raw_skill['far'] + .05 + 1e-12:
            continue
        choice['feasibleScores'] += 1
        rank = (skill['csi'], float(score))
        # exact CSI ties prefer the largest cutoff
        if best is None or rank > best:
            best, selected_rules, selected_skill, selected_cutoff = rank, rules, skill, float(score)
    # distinguish no feasible new cutoff from an already superior old rule
    if best is None or selected_rules is original:
        choice['reason'] = 'no_feasible_new_cutoff' if choice['feasibleScores'] == 0 else 'old_wet_rule_best'
    else:
        choice['reason'] = 'optimized_nested_csi'
    choice.update({'selectedMetrics': selected_skill, 'selectedCutoff': selected_cutoff})
    return selected_rules, choice


# fit the global recent amount scale and supported within-category alternatives
def calibrate_hurdle(actual, hours, raw, probability, base, uniform, stop):
    require(actual.shape == hours.shape == raw.shape == base.shape and probability.shape == (len(actual), 3) and np.isfinite(actual).all() and (actual >= 0).all() and np.isfinite(raw).all() and (raw >= 0).all() and np.isfinite(base).all() and (base >= 0).all(), 'invalid hurdle calibration inputs')
    mass = recent_weights(hours, stop)
    rules, choice = select_wet_rule(actual, hours, raw, probability, uniform)
    categories = ordinal_categories(raw, probability, rules)
    global_scalar = calibrate_recent(actual, mass, lambda scale: ordinal_project(base, categories, scale), POLICY)
    category_states = {}
    # use all observed labels, including dry ones, inside each forecast category
    for category in (1, 2, 3):
        selected = categories == category
        wet = selected & (actual >= .1)
        wet_hours = np.unique(hours[wet])
        counts = {'rows': int(selected.sum()), 'predictedHours': int(len(np.unique(hours[selected]))), 'predictedDates': int(len(np.unique(hours[selected] // 24))), 'observedWetRows': int(wet.sum()), 'observedWetHours': int(len(wet_hours)), 'observedWetDates': int(len(np.unique(wet_hours // 24))), 'observedDryRows': int((selected & (actual < .1)).sum())}
        record = {'support': counts, 'supported': False, 'reason': 'global_recent_fallback_insufficient_wet_support', 'calibration': None, 'scale': global_scalar['scale']}
        # only prior category wet support allows a separate scale
        if counts['observedWetHours'] >= 20 and counts['observedWetDates'] >= 5:
            normalized = mass[selected] / float(mass[selected].sum())
            scalar = calibrate_recent(actual[selected], normalized, lambda scale: ordinal_project(base[selected], categories[selected], scale), POLICY)
            record.update({'supported': True, 'reason': 'category_recent_calibrated', 'calibration': scalar, 'scale': scalar['scale']})
        category_states[str(category)] = record
    wet = actual >= .1
    wet_hours = np.unique(hours[wet])
    counts = {'rows': int(len(actual)), 'dates': int(len(np.unique(hours // 24))), 'observedWetRows': int(wet.sum()), 'observedWetHours': int(len(wet_hours)), 'observedWetDates': int(len(np.unique(wet_hours // 24))), **effective_support(actual, hours, mass)}
    return {'contractVersion': 'rain-hurdle-calibration/v1', 'uniformRules': copy.deepcopy(uniform), 'rules': rules, 'wetSelection': choice, 'calibrationSupport': counts, 'globalCalibration': global_scalar, 'categories': category_states, 'scaleBounds': SCALE_BOUNDS, 'calibrationStopHourExclusive': int(stop), 'calibrationRows': int(len(actual)), 'productionEligible': False}


# apply only frozen class rules and scales to later forecast rows
def predict_hurdle(raw, probability, base, state):
    categories = ordinal_categories(raw, probability, state['rules'])
    predicted = np.zeros(len(raw), dtype=float)
    # keep exact dry zero and disjoint wet, moderate and heavy bands
    for category in (1, 2, 3):
        selected = categories == category
        predicted[selected] = ordinal_project(base[selected], categories[selected], state['categories'][str(category)]['scale'])
    return predicted


# verify every pre-outcome source and copied prior model artifact byte
def check_freeze(root, freeze, old_names):
    require(freeze['policy'] == POLICY and freeze['featureNames'] == old_names and freeze['contextFeatureNames'] == POLICY['featureNames'] and freeze['inputSchemaFreezeSha256'] == sha(root / 'freeze.json') and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'hurdle source freeze changed')
    require(POLICY['candidates'] == [PRIMARY] and POLICY['arms'] == list(ARMS) and POLICY['previousPins'] == PREVIOUS_PINS and set(freeze['sourceSha256']) == set(SOURCE_FILES), 'hurdle frozen candidate or source scope changed')
    # require every live producer dependency to equal its saved pre-outcome copy
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and len(relative.parts) == 1 and '..' not in relative.parts and name.endswith('.py'), 'unsafe hurdle source name')
        live, retained = Path(__file__).with_name(name), root / 'hurdle-sources' / name
        require(live.is_file() and retained.is_file() and not live.is_symlink() and not retained.is_symlink() and sha(live) == expected and sha(retained) == expected, f'hurdle source changed: {name}')
    # bind all inherited context models, old scores, lineage receipts and observations
    for name, expected in freeze['inputSha256'].items():
        relative = Path(name)
        path = root / relative
        require(not relative.is_absolute() and '..' not in relative.parts and path.is_file() and not path.is_symlink() and sha(path) == expected, f'hurdle copied input changed: {name}')
    require(all(freeze['inputSha256']['inputs/recency/' + name] == expected for name, expected in PREVIOUS_PINS.items()), 'hurdle previous outcome pins changed')
    recency_freeze = json.loads((root / 'inputs/recency/recency-freeze.json').read_text())
    require(recency_freeze['policy']['expectedEvaluationRows'] == 32896 and recency_freeze['newCandidateOutcomesRead'] is False and recency_freeze['productionWrites'] is False, 'hurdle recency policy lineage changed')
    require(all(freeze['inputSha256']['inputs/context/' + name] == expected for name, expected in recency_freeze['contextInputSha256'].items()), 'hurdle fixed context input lineage changed')
    prior_report = json.loads((root / 'inputs/recency/report.json').read_text())
    require(prior_report['freezeSha256'] == PREVIOUS_PINS['recency-freeze.json'] and prior_report['predictionsSha256'] == PREVIOUS_PINS['predictions.npz'] and prior_report['productionEligible'] is False, 'hurdle prior report changed')
    prior_receipt = json.loads((root / 'inputs/recency/final-evidence/independent-verification-v2.json').read_text())
    require(prior_receipt['verified'] is True and prior_receipt['nativeModelsRefit'] == 60 and prior_receipt['reportSha256'] == PREVIOUS_PINS['report.json'] and prior_receipt['predictionsSha256'] == PREVIOUS_PINS['predictions.npz'] and prior_receipt['productionEligible'] is False, 'hurdle prior independent refit changed')
    source_manifest = json.loads((root / 'inputs/acquisition/manifest.json').read_text())
    cohort = source_manifest['cohortFiles']['ecmwf_single_run_hindcast']
    require(cohort['sha256'] == 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1' and cohort['rows'] == cohort['successfulRuns'] * 48 and sha(root / 'inputs/context/inputs/trajectory.jsonl') == cohort['sha256'], 'hurdle source profile lineage changed')
    return cohort, prior_report


# reconstruct the original uniform event rules and native conditional amounts
def uniform_reference(root, data, full, names, month, fit, calibration, evaluation, previous):
    context_state = json.loads((root / 'inputs/context/context-models' / month / 'state.json').read_text())
    batches, ordinal_model, weighted_model = refit_models(root, data, full, names, fit, calibration, evaluation, month, context_state)
    same_tree(ordinal_model, previous['referenceOrdinal']['model'], f'hurdleNativeOrdinal.{month}')
    same_tree(weighted_model, previous['referenceWeighted']['model'], f'hurdleNativeWeighted.{month}')
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    raw_cal, raw_eval = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    pc, pe = batches['calibration']['probability'], batches['evaluation']['probability']
    ac, ae = batches['calibration']['amount'], batches['evaluation']['amount']
    proposed = ordinal_rules(actual, raw_cal, pc, hours, SEARCH_POLICY)
    rules, fallback = checked_rules(actual, raw_cal, pc, hours, proposed, SEARCH_POLICY)
    same_tree(proposed, previous['referenceOrdinal']['proposedRules'], f'hurdleUniformProposed.{month}')
    same_tree(rules, previous['referenceOrdinal']['rules'], f'hurdleUniformRules.{month}')
    require(fallback is previous['referenceOrdinal']['nestingSafetyFallback'], f'hurdle nesting safety changed: {month}')
    cc, ce = ordinal_categories(raw_cal, pc, rules), ordinal_categories(raw_eval, pe, rules)
    bc, be = np.clip(.25 * raw_cal + .75 * ac, 0, 30), np.clip(.25 * raw_eval + .75 * ae, 0, 30)
    scalar = calibrate(actual, hours, lambda scale: ordinal_project(bc, cc, scale), SEARCH_POLICY)
    same_tree(scalar, previous['referenceOrdinal']['calibration'], f'hurdleUniformScalar.{month}')
    original = ordinal_project(be, ce, scalar['scale'])
    return {'calibration': {'raw': raw_cal, 'probability': pc, 'base': bc}, 'evaluation': {'raw': raw_eval, 'probability': pe, 'base': be}}, rules, original


# replay one new month using only earlier labels and refitted frozen native heads
def replay_month(root, data, full, names, old_policy, month):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
    previous = json.loads((root / 'inputs/recency/recency-states' / f'{month}.json').read_text())
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    counts = {'training': support(data['actual'][fit], data['hour'][fit]), 'calibration': support(actual, hours)}
    require(all(previous[key] == value for key, value in bounds.items()) and previous['support'] == counts, f'hurdle prior chronology changed: {month}')
    mass = recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
    effective = effective_support(actual, hours, mass)
    same_tree(effective, previous['effectiveSupport'], f'hurdlePriorEffective.{month}')
    supported = all(counts['training'][key] >= value for key, value in POLICY['trainingSupport'].items()) and all(counts['calibration'][key] >= value for key, value in POLICY['calibrationSupport'].items()) and all(effective[key] >= value for key, value in POLICY['effectiveSupport'].items())
    require(supported is previous['supported'], f'hurdle prior support changed: {month}')
    batches, uniform, ordinal90 = uniform_reference(root, data, full, names, month, fit, calibration, evaluation, previous)
    state = {**bounds, 'supported': bool(supported), 'support': counts, 'effectiveSupport': effective, 'calibration': None, 'reason': 'insufficient_effective_support'}
    # unsupported recent calibration must leave the full original ordinal forecast
    if not supported:
        predicted = ordinal90.copy()
    else:
        cal, future = batches['calibration'], batches['evaluation']
        fitted = calibrate_hurdle(actual, hours, cal['raw'], cal['probability'], cal['base'], uniform, bounds['calibrationMaximumValidHourExclusive'])
        predicted = predict_hurdle(future['raw'], future['probability'], future['base'], fitted)
        state.update({'calibration': fitted, 'reason': 'category_calibrated'})
    # a new low-event threshold may never alter old heavy categories
    require(np.array_equal(predicted >= 1., ordinal90 >= 1.) and np.array_equal(predicted >= 2.5, ordinal90 >= 2.5), f'hurdle heavy calls changed: {month}')
    same_tree(state, json.loads((root / 'hurdle-states' / f'{month}.json').read_text()), f'hurdleState.{month}')
    return np.where(evaluation)[0], predicted, ordinal90, state


# retain every old arm exactly and append only the new categorical prediction
def replay_all(root, data, full, names, old_policy):
    with np.load(root / 'inputs/recency/predictions.npz', allow_pickle=False) as archive:
        prior_indices = archive['indices']
        prior = {name: archive['amount::' + name] for name in ARMS[:-1]}
        old_supported = archive['recentSupported']
    require(set(prior) == set(ARMS[:-1]) and len(prior_indices) == 32896, 'hurdle prior prediction schema changed')
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # refit five retained native heads for each fixed calendar month
    for month in MONTHS:
        rows, predicted, ordinal90, state = replay_month(root, data, full, names, old_policy, month)
        end = offset + len(rows)
        require(np.array_equal(prior_indices[offset:end], rows) and np.array_equal(old_supported[offset:end], np.full(len(rows), state['supported'], dtype=bool)) and np.allclose(prior['ordinal90'][offset:end], ordinal90, rtol=1e-8, atol=1e-9), f'hurdle prior predictions changed: {month}')
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        states[month] = state
        offset = end
    indices = np.concatenate(indices)
    require(offset == len(prior_indices) and np.array_equal(prior_indices, indices) and len(indices) == POLICY['expectedEvaluationRows'] == 32896 and len(np.unique(indices)) == len(indices), 'hurdle development population changed')
    return indices, {**prior, PRIMARY: np.concatenate(amounts)}, np.concatenate(flags), states


# build the full development report from independently reconstructed predictions
def expected_report(root, data, old_policy, indices, amounts, flags, states):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    actual, hours = data['actual'][indices], data['hour'][indices]
    screen = goal.fixed_gate.candidate_screen(goal.gate_view(scores, PRIMARY), data, indices, flags)
    separate = goal.independent_gate(goal.gate_view(scores, PRIMARY), data, indices, flags)
    same_tree(separate, screen, 'hurdleIndependentGate')
    require(len(screen['gates']) == 49, 'hurdle fixed gate count changed')
    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': sha(root / 'hurdle-freeze.json'), **scores, 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'treeFitPerformed': False, 'nativeModelsReused': 60, 'meanTargetSensitivity': {name: metrics(data['mean'][indices], value, (value >= .1).astype(float), hours) for name, value in amounts.items()}, 'candidateScreen': screen, 'selectedCandidate': PRIMARY if screen['passed'] else None, 'developmentPassed': bool(screen['passed']), 'decision': 'prospective_hypothesis_only_not_qualified' if screen['passed'] else 'no_candidate_selected_all_failures_retained', 'referenceParity': {'exactPredictions': True, 'arms': list(ARMS[:-1])}, 'featuresSha256': sha(root / 'inputs/context/features.npz'), 'predictionsSha256': sha(root / 'predictions.npz')}
    return report


# bind all frozen inputs, refit exact native bytes and rescore forty-nine gates
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    freeze = json.loads((root / 'hurdle-freeze.json').read_text())
    require(old_freeze['featureNames'] == old_names and POLICY['treeFitPerformed'] is False and POLICY['nativeModelsReused'] == 60 and POLICY['categorySupport'] == {'wetHours': 20, 'wetDates': 5} and POLICY['heavyRules'] == 'exact_original_uniform_ordinal90_rules_at_1_and_2.5', 'hurdle scientific policy changed')
    names = feature_sets(old_names)
    require(names['full'] == POLICY['featureNames'] and len(names['full']) == 95, 'hurdle full context schema changed')
    cohort, _ = check_freeze(root, freeze, old_names)
    profiles = load_profiles(root / 'inputs/context/inputs/trajectory.jsonl', cohort)
    matrices, availability = build_features(data, profiles, old_names)
    with np.load(root / 'inputs/context/features.npz', allow_pickle=False) as archive:
        require(set(archive.files) == {'x', *availability} and np.array_equal(archive['x'], matrices['full'], equal_nan=True), 'hurdle full context matrix changed')
        # preserve source-only availability with no label-conditioned filtering
        for name, expected in availability.items():
            require(np.array_equal(archive[name], expected), f'hurdle feature availability changed: {name}')
    indices, amounts, flags, states = replay_all(root, data, matrices['full'], names['full'], old_policy)
    with np.load(root / 'predictions.npz', allow_pickle=False) as archive:
        require(set(archive.files) == {'indices', 'candidateSupported'} | {'amount::' + name for name in ARMS} and np.array_equal(archive['indices'], indices) and archive['candidateSupported'].dtype == np.dtype(bool) and np.array_equal(archive['candidateSupported'], flags), 'hurdle prediction population or support changed')
        # old controls remain bitwise identical; new arm matches independent replay
        for name, predicted in amounts.items():
            retained = archive['amount::' + name]
            require(retained.shape == predicted.shape and np.isfinite(retained).all() and (retained >= 0).all(), f'hurdle malformed predictions: {name}')
            require((np.allclose(retained, predicted, rtol=1e-8, atol=1e-9) if name == PRIMARY else np.array_equal(retained, predicted)), f'hurdle prediction replay changed: {name}')
    expected = expected_report(root, data, old_policy, indices, amounts, flags, states)
    report_path = root / 'report.json'
    reported = json.loads(report_path.read_text())
    goal.recomputed_gates(reported, {name: expected[name] for name in ('overall', 'byLeadBand', 'bySeason', 'byMonth', 'byArchiveEra', 'events', 'accumulations', 'invariants')}, data, indices, flags, PRIMARY)
    same_tree(expected, reported, 'hurdleReport')
    receipt = {'contractVersion': 'rain-hurdle-independent-verification/v1', 'verified': True, 'privateRoot': str(root), 'verifierSourceSha256': sha(__file__), 'sourceProfilesVerified': len(profiles), 'featureRowsVerified': len(data['actual']), 'featureColumnsVerified': len(names['full']), 'monthlyStatesVerified': len(states), 'nativeModelsRefit': 5 * len(states), 'developmentPredictionRows': len(indices), 'all49GatesVerified': True, 'referenceParityVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'reportSha256': sha(report_path), 'predictionsSha256': expected['predictionsSha256']}
    # write independent evidence outside the frozen producer root
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# require an explicit source root and exclusive verifier output
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
