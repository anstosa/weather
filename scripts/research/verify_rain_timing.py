"""independently replay source-bound rain timing shifts and development gates."""

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

# bind numerical reductions to one thread
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
from rain_timing import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_event_guard import (
    calibrated_scale as old_calibrated_scale,
    load_inputs,
    month_masks as old_month_masks,
    same_tree,
    score_accumulations,
    score_events,
    score_groups,
)
from verify_rain_search import calibrate, candidate_screens as base_screens, month_masks, support
from verify_rain_sub24_model import metrics, require

ARMS = ('raw', 'zero', 'persistence', 'volumeScale', 'volume90', 'supportedVolume90', 'timingOnly', 'timingVolume90')
COHORT = 'ecmwf_single_run_hindcast'


# parse exact source-hour identities without using producer profile construction
def hour(value):
    instant = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(instant.tzinfo is not None and instant.timestamp() % 3600 == 0, 'invalid timing source hour')
    return int(instant.timestamp() // 3600)


# prove every producer source and copied trajectory still matches the source freeze
def check_freeze(root, freeze, feature_names):
    require(freeze['policy'] == POLICY and freeze['featureNames'] == feature_names and freeze['newCandidateOutcomesRead'] is False and freeze['priorOutcomesAlreadyKnown'] is True and freeze['productionWrites'] is False, 'timing policy freeze changed')
    require(freeze['inputSchemaFreezeSha256'] == hashlib.sha256((root / 'freeze.json').read_bytes()).hexdigest(), 'timing input-schema freeze changed')
    require(set(freeze['sourceSha256']) == set(SOURCE_FILES), 'timing producer source set changed')
    # reject changed copied or live producer dependencies
    for name, expected in freeze['sourceSha256'].items():
        relative = Path(name)
        require(not relative.is_absolute() and '..' not in relative.parts and len(relative.parts) == 1, 'unsafe timing source path')
        saved, live = root / 'timing-sources' / name, Path(__file__).with_name(name)
        require(saved.is_file() and live.is_file() and not saved.is_symlink(), f'missing timing source: {name}')
        require(hashlib.sha256(saved.read_bytes()).hexdigest() == expected and hashlib.sha256(live.read_bytes()).hexdigest() == expected, f'timing producer source changed: {name}')
    manifest_bytes = (root / 'inputs/acquisition/manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require(hashlib.sha256(manifest_bytes).hexdigest() == freeze['sourceManifestSha256'], 'timing acquisition manifest changed')
    cohorts = manifest.get('cohortFiles')
    require(isinstance(cohorts, dict) and set(cohorts) == {COHORT}, 'timing source cohort changed')
    cohort = cohorts[COHORT]
    require(cohort['path'] == 'normalized/ecmwf_single_run_hindcast.jsonl' and cohort['rows'] == cohort['successfulRuns'] * 48 and cohort['bytes'] > 0 and cohort['successfulRuns'] > 0, 'timing source cohort metadata changed')
    trajectory = root / 'inputs/trajectory.jsonl'
    require(trajectory.is_file() and not trajectory.is_symlink() and trajectory.stat().st_size == cohort['bytes'] == freeze['trajectoryBytes'] and cohort['rows'] == freeze['trajectoryRows'], 'timing source trajectory size or row count changed')
    digest = hashlib.sha256(trajectory.read_bytes()).hexdigest()
    require(digest == cohort['sha256'] == freeze['trajectorySha256'], 'timing source trajectory hash changed')
    return cohort


# reconstruct all 48-hour source profiles from manifest-bound normalized rows
def load_profiles(path, cohort):
    profiles = {}
    rows = 0
    block = []
    # preserve run order and reject even a trailing partial run
    with path.open() as stream:
        for line in stream:
            item = json.loads(line)
            block.append(item)
            rows += 1
            if len(block) == 48:
                initialized = hour(block[0]['runInitializedAt'])
                require(initialized not in profiles, 'duplicate timing source run')
                rain = np.empty(48, dtype=float)
                temperature = np.empty(48, dtype=float)
                # verify every lead within the exact initialized run
                for index, row in enumerate(block, 1):
                    require(row['runInitializedAt'] == block[0]['runInitializedAt'] and row['targetLeadHours'] == index and hour(row['validAt']) == initialized + index, 'timing source lead identity changed')
                    rain[index - 1] = np.nan if row['rawPrecipitationMm'] is None else row['rawPrecipitationMm']
                    temperature[index - 1] = np.nan if row['rawTemperatureC'] is None else row['rawTemperatureC']
                require(not np.isinf(rain).any() and not np.isinf(temperature).any() and (rain[np.isfinite(rain)] >= 0).all(), 'nonphysical timing source forecast')
                profiles[initialized] = (rain, temperature)
                block = []
    require(not block and rows == cohort['rows'] and len(profiles) == cohort['successfulRuns'], 'timing source profile count changed')
    return profiles


# independently compare the four causal observed hours with seven fixed shifts
def choose_shift(rain, past):
    rain, past = np.asarray(rain, dtype=float), np.asarray(past, dtype=float)
    # preserve the observed-past reason precedence on unsupported data
    if rain.shape != (48,) or past.shape != (4,) or not np.isfinite(rain[:34]).all() or (rain[:34] < 0).any() or not np.isfinite(past).all() or (past < 0).any():
        reason = 'missing_past' if past.shape != (4,) or not np.isfinite(past).all() or (past < 0).any() else 'missing_source'
        return {'delta': 0, 'alignmentSupport': False, 'reason': reason}
    # an entirely dry observed past has support but no timing evidence
    if not (past >= .1).any():
        return {'delta': 0, 'alignmentSupport': True, 'reason': 'recent_dry'}
    errors = {}
    # use only source leads one through ten to score observed hours four through seven
    for delta in range(-3, 4):
        forecast = rain[np.arange(4, 8) + delta - 1]
        errors[delta] = float(np.mean(np.abs(past - forecast)))
    best = min(errors, key=lambda delta: (errors[delta], abs(delta), delta))
    # require both prespecified relative and absolute improvement
    if best != 0 and errors[best] <= .8 * errors[0] and errors[0] - errors[best] >= .02:
        return {'delta': best, 'alignmentSupport': True, 'reason': 'shifted'}
    return {'delta': 0, 'alignmentSupport': True, 'reason': 'no_material_improvement'}


# bind every paired raw and liquid-phase feature to its original source lead
def paired_source(data, profiles, feature_names):
    raw_temperature = data['x'][:, feature_names.index('rawTemperature')]
    # inspect each original first-day forecast row before shifting anything
    for position, (initialized, horizon, raw) in enumerate(zip(data['initialized'], data['lead'], data['raw'], strict=True)):
        profile = profiles.get(int(initialized))
        lead = 8 + int(horizon)
        require(profile is not None and 1 <= lead <= 31 and np.isfinite(profile[0][lead - 1]) and np.float32(profile[0][lead - 1]) == np.float32(raw), 'paired raw forecast differs from timing trajectory')
        require(np.isfinite(profile[1][lead - 1]) and np.float32(profile[1][lead - 1]) == np.float32(raw_temperature[position]), 'paired forecast temperature differs from timing trajectory')


# choose one causal decision for each paired initialized run
def choices_for_runs(data, profiles, observations):
    first = int(observations['first_hour'])
    target = observations['target']
    choices = {}
    # never use a target hour later than decision minus one
    for initialized in np.unique(data['initialized']):
        init = int(initialized)
        indices = init + np.arange(4, 8) - first
        past = target[indices] if (indices >= 0).all() and (indices < len(target)).all() else np.full(4, np.nan)
        require(init + 7 < init + POLICY['decisionDelayHours'], 'timing alignment borrowed future outcomes')
        choices[init] = choose_shift(profiles[init][0], past)
    return choices


# apply each run shift only when the shifted forecast remains liquid phase
def shifted_rows(data, rows, profiles, choices):
    result = data['raw'][rows].astype(float).copy()
    supported = np.zeros(len(rows), dtype=bool)
    phase_fallback = np.zeros(len(rows), dtype=bool)
    effective = np.zeros(len(rows), dtype=bool)
    # retain exact raw on missing past/source or cold shifted target hours
    for position, row in enumerate(rows):
        init = int(data['initialized'][row])
        choice = choices[init]
        rain, temperature = profiles[init]
        lead = 8 + int(data['lead'][row])
        supported[position] = choice['alignmentSupport']
        if not choice['alignmentSupport'] or choice['delta'] == 0:
            continue
        shifted = lead + choice['delta']
        if not np.isfinite(temperature[shifted - 1]) or temperature[shifted - 1] <= POLICY['phaseTemperatureMinimumC']:
            phase_fallback[position] = choice['delta'] != 0
            continue
        result[position] = float(np.float32(rain[shifted - 1]))
        effective[position] = np.float32(result[position]) != np.float32(data['raw'][row])
    require(np.isfinite(result).all() and (result >= 0).all(), 'nonphysical shifted rain forecast')
    return result, supported, phase_fallback, effective


# require the timing mechanism to beat same-support and all-row controls
def timing_screens(report, data, indices, flags):
    screens, _ = base_screens(report, data, indices, flags, POLICY)
    # append one mechanism-specific empirical gate to each unchanged 45-gate set
    for name in POLICY['candidates']:
        gates = screens[name]['gates']
        require(len(gates) == 45, 'inherited timing gate count changed')
        margin = POLICY['timingContributionMaeMargin']
        gates['timingContribution'] = report['mechanismSupport']['dates'] >= POLICY['minimumEffectiveChangedDates'] and report['overall'][name]['mae'] < report['overall']['volume90']['mae'] - margin and report['overall'][name]['mae'] < report['overall']['supportedVolume90']['mae'] - margin
        screens[name]['passed'] = all(gates.values())
        screens[name]['failedGates'] = [key for key, passed in gates.items() if not passed]
        require(len(gates) == 46, 'timing gate count changed')
    passing = [name for name in POLICY['candidates'] if screens[name]['passed']]
    selected = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, selected


# replay both timing arms and all five controls with prior-only monthly scalars
def replay(root, data, old_policy, feature_names, profiles, choices):
    indices = []
    outputs = {name: [] for name in ARMS}
    flags = {name: [] for name in POLICY['candidates']}
    states = {}
    effective_parts = []
    phase_by_run = collections.Counter()
    # retain each target month's fixed historical window
    for month in POLICY['developmentMonths']:
        _, calibration, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
        cal_rows, eval_rows = np.where(calibration)[0], np.where(evaluation)[0]
        raw_cal, raw_eval = data['raw'][cal_rows].astype(float), data['raw'][eval_rows].astype(float)
        shifted_cal, supported_cal, _, _ = shifted_rows(data, cal_rows, profiles, choices)
        shifted_eval, supported_eval, phase_eval, effective_eval = shifted_rows(data, eval_rows, profiles, choices)
        actual_cal, hour_cal = data['actual'][cal_rows], data['hour'][cal_rows]
        raw_scalar = calibrate(actual_cal, hour_cal, lambda scale: np.clip(raw_cal * scale, 0, 30), SEARCH_POLICY)
        supported_raw_scalar = calibrate(actual_cal, hour_cal, lambda scale: np.where(supported_cal, np.clip(raw_cal * scale, 0, 30), raw_cal), SEARCH_POLICY)
        timing_scalar = calibrate(actual_cal, hour_cal, lambda scale: np.where(supported_cal, np.clip(shifted_cal * scale, 0, 30), raw_cal), SEARCH_POLICY)
        _, old_cal, old_eval, _ = old_month_masks(data, month, old_policy)
        require(np.array_equal(old_eval, evaluation), f'timing old evaluation population changed: {month}')
        old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
        old_scalar = old_calibrated_scale(data['actual'][old_cal], data['raw'][old_cal], data['hour'][old_cal])
        require(old_state['policy'] == old_policy and old_state['featureNames'] == feature_names and old_state['calibrationRows'] == int(old_cal.sum()) and np.isclose(old_scalar, old_state['scales']['raw'], atol=1e-9, rtol=0), f'inherited timing raw scalar changed: {month}')
        persistence = data['persistence'][eval_rows]
        predicted = {'raw': raw_eval, 'zero': np.zeros_like(raw_eval), 'persistence': np.where(np.isfinite(persistence), persistence, raw_eval), 'volumeScale': raw_eval * old_scalar, 'volume90': np.clip(raw_eval * raw_scalar['scale'], 0, 30), 'supportedVolume90': np.where(supported_eval, np.clip(raw_eval * supported_raw_scalar['scale'], 0, 30), raw_eval), 'timingOnly': shifted_eval, 'timingVolume90': np.where(supported_eval, np.clip(shifted_eval * timing_scalar['scale'], 0, 30), raw_eval)}
        reasons = collections.Counter(choices[int(init)]['reason'] for init in np.unique(data['initialized'][eval_rows]))
        state = {**bounds, 'calibrationRows': len(cal_rows), 'evaluationRows': len(eval_rows), 'rawCalibration': raw_scalar, 'supportedRawCalibration': supported_raw_scalar, 'timingCalibration': timing_scalar, 'calibrationAlignedRows': int(supported_cal.sum()), 'evaluationAlignedRows': int(supported_eval.sum()), 'evaluationPhaseFallbackRows': int(phase_eval.sum()), 'evaluationEffectiveRows': int(effective_eval.sum()), 'evaluationEffectiveDates': int(len(np.unique(data['hour'][eval_rows][effective_eval] // 24))), 'reasonCounts': dict(reasons)}
        saved = json.loads((root / 'timing-models' / month / 'state.json').read_text())
        same_tree(state, saved, f'monthlyStates.{month}')
        indices.append(eval_rows)
        states[month] = state
        # preserve all control and candidate row populations
        for name in ARMS:
            outputs[name].append(predicted[name])
        for name in POLICY['candidates']:
            flags[name].append(supported_eval.copy())
        effective_parts.append(effective_eval)
        for init in data['initialized'][eval_rows][phase_eval]:
            phase_by_run[int(init)] += 1
    return np.concatenate(indices), {name: np.concatenate(parts) for name, parts in outputs.items()}, {name: np.concatenate(parts) for name, parts in flags.items()}, np.concatenate(effective_parts), states, phase_by_run


# compare the complete sorted per-run timing audit with causal recomputation
def check_shift_audit(path, choices, phase_by_run):
    require(path.is_file() and not path.is_symlink(), 'missing timing shift audit')
    expected = [{'initializedHour': init, **choice, 'phaseFallbackRows': phase_by_run[init]} for init, choice in sorted(choices.items())]
    with path.open() as stream:
        observed = [json.loads(line) for line in stream]
    same_tree(expected, observed, 'shiftAudit')
    return hashlib.sha256(path.read_bytes()).hexdigest()


# recompute every event, amount, group, accumulation and gate field
def expected_report(root, freeze, data, old_policy, indices, outputs, flags, effective, choices, states, audit_sha):
    actual, hours = data['actual'][indices], data['hour'][indices]
    report = {'contractVersion': freeze['policy']['contractVersion'], 'policy': freeze['policy'], 'freezeSha256': hashlib.sha256((root / 'timing-freeze.json').read_bytes()).hexdigest(), 'trajectorySha256': freeze['trajectorySha256'], 'shiftAuditSha256': audit_sha, 'overall': {name: metrics(actual, predicted, (predicted >= .1).astype(float), hours) for name, predicted in outputs.items()}, 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report['mechanismSupport'] = support(actual[effective], hours[effective])
    report['nonzeroChosenRuns'] = int(len({int(init) for init in data['initialized'][indices] if choices[int(init)]['delta'] != 0}))
    report['effectiveChangedRuns'] = int(len(np.unique(data['initialized'][indices][effective])))
    report.update(score_groups(data, indices, outputs, old_policy))
    report['meanTargetSensitivity'] = {name: metrics(data['mean'][indices], predicted, (predicted >= .1).astype(float), hours) for name, predicted in outputs.items()}
    report['events'] = score_events(actual, hours, outputs, SEARCH_POLICY['thresholdsMmPerHour'])
    report['accumulations'] = score_accumulations(data, indices, outputs)
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(predicted).all() and (predicted >= 0).all() for predicted in outputs.values()))}
    report['candidateScreens'], report['selectedCandidate'] = timing_screens(report, data, indices, flags)
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    report['predictionsSha256'] = hashlib.sha256((root / 'predictions.npz').read_bytes()).hexdigest()
    return report


# verify source lineage, per-run shifts and every retained development result
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, feature_names, data = load_inputs(root)
    freeze = json.loads((root / 'timing-freeze.json').read_text())
    require(old_freeze['featureNames'] == feature_names and POLICY['candidates'] == ['timingOnly', 'timingVolume90'] and POLICY['decisionDelayHours'] == old_policy['decisionDelayHours'] == 8 and POLICY['pastObservationLeadHours'] == [4, 5, 6, 7] and POLICY['shiftCandidatesHours'] == [-3, -2, -1, 0, 1, 2, 3] and POLICY['sourceLeadHoursRequired'] == [1, 34] and POLICY['calibrationDays'] == SEARCH_POLICY['calibrationDays'] == 90 and POLICY['embargoDays'] == SEARCH_POLICY['embargoDays'] == 7 and POLICY['calibrationScaleBounds'] == SEARCH_POLICY['calibrationScaleBounds'] == [.1, 3.], 'timing frozen scientific scope changed')
    require(POLICY['minimumPastWetHours'] == 1 and POLICY['wetThresholdMm'] == .1 and POLICY['maximumBestToZeroMaeRatio'] == .8 and POLICY['minimumAbsoluteMaeImprovementMm'] == .02 and POLICY['phaseTemperatureMinimumC'] == 2. and POLICY['predictionPrecision'] == 'paired_float32_promoted_to_float64' and POLICY['screen'] == SEARCH_POLICY['screen'] and POLICY['candidateSupport'] == SEARCH_POLICY['candidateSupport'] and POLICY['minimumEffectiveChangedDates'] == 20 and POLICY['timingContributionMaeMargin'] == 1e-12, 'timing event or screen policy changed')
    cohort = check_freeze(root, freeze, feature_names)
    profiles = load_profiles(root / 'inputs/trajectory.jsonl', cohort)
    paired_source(data, profiles, feature_names)
    with np.load(root / 'inputs/sub24-dataset/observations.npz', allow_pickle=False) as archive:
        observations = {'target': archive['target'], 'first_hour': archive['first_hour']}
    choices = choices_for_runs(data, profiles, observations)
    indices, outputs, flags, effective, states, phase_by_run = replay(root, data, old_policy, feature_names, profiles, choices)
    require(len(indices) == POLICY['expectedEvaluationRows'] == 32896 and len(np.unique(indices)) == len(indices), 'timing evaluation row count or uniqueness changed')
    audit_sha = check_shift_audit(root / 'shift-audit.jsonl', choices, phase_by_run)
    # reject missing, extra or reordered prediction archive arrays
    with np.load(root / 'predictions.npz', allow_pickle=False) as material:
        archive = {name: material[name] for name in material.files}
    expected_keys = {'indices', 'effectiveShift'} | {f'amount::{name}' for name in ARMS} | {f'supported::{name}' for name in flags}
    require(set(archive) == expected_keys and np.array_equal(archive['indices'], indices) and archive['effectiveShift'].dtype == np.dtype(bool) and np.array_equal(archive['effectiveShift'], effective), 'timing prediction population or effective shifts changed')
    for name, expected in outputs.items():
        retained = archive[f'amount::{name}']
        require(retained.shape == expected.shape and np.isfinite(retained).all() and (retained >= 0).all() and np.allclose(retained, expected, rtol=1e-8, atol=1e-9), f'timing prediction replay changed: {name}')
    for name, expected in flags.items():
        retained = archive[f'supported::{name}']
        require(retained.dtype == np.dtype(bool) and np.array_equal(retained, expected), f'timing support flags changed: {name}')
    report_path = root / 'report.json'
    expected = expected_report(root, freeze, data, old_policy, indices, outputs, flags, effective, choices, states, audit_sha)
    same_tree(expected, json.loads(report_path.read_text()))
    receipt = {'contractVersion': 'rain-timing-independent-verification/v1', 'verified': True, 'sourceProfilesVerified': len(profiles), 'pairedRunsAudited': len(choices), 'monthlyStatesVerified': len(states), 'developmentPredictionRows': len(indices), 'supportedPredictionRows': int(flags['timingOnly'].sum()), 'effectiveChangedRows': int(effective.sum()), 'all46GatesPerCandidateVerified': True, 'selectedCandidate': expected['selectedCandidate'], 'developmentPassed': expected['developmentPassed'], 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False, 'freezeSha256': expected['freezeSha256'], 'trajectorySha256': freeze['trajectorySha256'], 'shiftAuditSha256': audit_sha, 'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'predictionsSha256': expected['predictionsSha256']}
    # create verification evidence outside producer artifacts
    with evidence.open('x') as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
    return receipt


# require an explicit private root and separate evidence path
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.root, arguments.evidence), allow_nan=False))
