"""test causal four-hour rain-profile timing shifts on consumed development data."""

import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import shutil

import numpy as np
import rain_event_guard as inputs
import rain_residual as residual
import rain_search as search
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score

ROOT_NAME = 'weather-moisture-research-rain-timing-20260913-v1'
COHORT = 'ecmwf_single_run_hindcast'
CANDIDATES = ('timingOnly', 'timingVolume90')
BASELINES = (*search.BASELINES, 'supportedVolume90')
SOURCE_FILES = tuple(dict.fromkeys(('rain_timing.py', *search.SOURCE_FILES)))
POLICY = {
    'contractVersion': 'rain-timing-development/v1',
    'candidates': list(CANDIDATES),
    'developmentMonths': list(inputs.MONTHS),
    'expectedEvaluationRows': 32896,
    'developmentDataPreviouslyConsumed': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'modelFit': False,
    'sourceCohort': COHORT,
    'sourceLeadHoursRequired': [1, 34],
    'pastObservationLeadHours': [4, 5, 6, 7],
    'decisionDelayHours': 8,
    'shiftCandidatesHours': [-3, -2, -1, 0, 1, 2, 3],
    'minimumPastWetHours': 1,
    'wetThresholdMm': .1,
    'maximumBestToZeroMaeRatio': .8,
    'minimumAbsoluteMaeImprovementMm': .02,
    'phaseTemperatureMinimumC': 2.,
    'phaseGuard': 'shifted_source_temperature_must_exceed_2C_else_exact_paired_raw',
    'predictionPrecision': 'paired_float32_promoted_to_float64',
    'timingOnly': 'shifted_profile_precipitation_without_amount_clipping_or_volume_conservation',
    'timingVolume90': 'prior_90_day_final_clipped_scalar_on_shifted_profile_with_7_day_embargo_and_exact_raw_unsupported_fallback',
    'calibrationScaleBounds': [.1, 3.],
    'calibrationDays': 90,
    'embargoDays': 7,
    'candidateSupport': residual.POLICY['candidateSupport'],
    'minimumEffectiveChangedDates': 20,
    'timingContributionMaeMargin': 1e-12,
    'supportedRawControl': 'same_alignment_mask_and_90_day_final_scalar_without_any_trajectory_shift',
    'screen': inputs.POLICY['screen'],
    'selection': 'all_44_residual_gates_plus_same_window_and_supported_timing_contribution_then_mae_name_tiebreak_else_none',
    'prospectiveEvaluation': inputs.POLICY['prospectiveEvaluation'],
}


# bind the normalized cohort to the retained acquisition manifest
def cohort_metadata(manifest):
    files = manifest.get('cohortFiles', {})
    cohort = files.get(COHORT)
    # reject a switched cohort or path escape
    if set(files) != {COHORT} or not isinstance(cohort, dict) or cohort.get('path') != 'normalized/ecmwf_single_run_hindcast.jsonl' or not isinstance(cohort.get('sha256'), str) or len(cohort['sha256']) != 64 or not isinstance(cohort.get('bytes'), int) or not isinstance(cohort.get('rows'), int) or not isinstance(cohort.get('successfulRuns'), int) or cohort['rows'] != cohort['successfulRuns'] * 48:
        raise ValueError('invalid timing source cohort metadata')
    return cohort


# retain original provenance before opening any new development outcomes
def prepare(source, root, retention_receipt):
    source, root = validate_private_root(source), Path(root)
    # require one fixed new private research identity
    if root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected timing research destination')
    inputs.prepare(source, root, retention_receipt)
    manifest = json.loads((root / 'inputs/acquisition/manifest.json').read_text())
    cohort = cohort_metadata(manifest)
    original = source / 'acquisition' / cohort['path']
    trajectory = root / 'inputs/trajectory.jsonl'
    # bind the original source before and after its private copy
    if original.stat().st_size != cohort['bytes'] or inputs.sha(original) != cohort['sha256']:
        raise ValueError('original forecast trajectory differs from manifest')
    shutil.copyfile(original, trajectory)
    if trajectory.stat().st_size != cohort['bytes'] or inputs.sha(trajectory) != cohort['sha256']:
        raise ValueError('copied forecast trajectory differs from manifest')
    directory = root / 'timing-sources'
    directory.mkdir(mode=0o700)
    hashes = {}
    # freeze every producer dependency used by the timing replay
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, directory / name)
        hashes[name] = inputs.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'sourceSha256': hashes, 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'trajectorySha256': cohort['sha256'], 'trajectoryBytes': cohort['bytes'], 'trajectoryRows': cohort['rows'], 'sourceManifestSha256': inputs.sha(root / 'inputs/acquisition/manifest.json'), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'timing-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# recheck policy, sources and exact private profile bytes before any replay
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'timing-freeze.json').read_text())
    cohort = cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    trajectory = root / 'inputs/trajectory.jsonl'
    # reject source or profile replacement after freeze
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['sourceManifestSha256'] != inputs.sha(root / 'inputs/acquisition/manifest.json') or any(freeze[key] != cohort[other] for key, other in (('trajectorySha256', 'sha256'), ('trajectoryBytes', 'bytes'), ('trajectoryRows', 'rows'))) or trajectory.stat().st_size != cohort['bytes'] or inputs.sha(trajectory) != cohort['sha256']:
        raise ValueError('timing freeze or trajectory changed')
    # bind both running and retained implementation bytes
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'timing-sources' / name) != expected:
            raise ValueError('timing implementation changed after freeze')
    return freeze


# stream each 48-lead run exactly once into compact forecast-only profiles
def load_profiles(path, cohort):
    profiles = {}
    rows = 0
    # require the declared aggregate byte identity before parsing
    if path.stat().st_size != cohort['bytes'] or inputs.sha(path) != cohort['sha256']:
        raise ValueError('timing trajectory hash changed')
    with path.open() as stream:
        block = []
        # preserve source order and exact run boundaries
        for line in stream:
            row = json.loads(line)
            block.append(row)
            rows += 1
            # parse only complete source profiles
            if len(block) == 48:
                init = hour_number(block[0]['runInitializedAt'])
                # reject mixed runs or malformed source lead identities
                if init in profiles or any(item['runInitializedAt'] != block[0]['runInitializedAt'] or item['targetLeadHours'] != index or hour_number(item['validAt']) != init + index for index, item in enumerate(block, 1)):
                    raise ValueError('invalid timing profile identity')
                rain = np.array([np.nan if item['rawPrecipitationMm'] is None else item['rawPrecipitationMm'] for item in block], dtype=np.float64)
                temperature = np.array([np.nan if item['rawTemperatureC'] is None else item['rawTemperatureC'] for item in block], dtype=np.float64)
                # normalization permits missing values, not negative rain or infinities
                if np.isinf(rain).any() or np.isinf(temperature).any() or (rain[np.isfinite(rain)] < 0).any():
                    raise ValueError('invalid timing profile measurements')
                profiles[init] = (rain, temperature)
                block = []
        # a partial tail cannot be treated as an absent run
        if block or rows != cohort['rows'] or len(profiles) != cohort['successfulRuns']:
            raise ValueError('timing trajectory row count changed')
    return profiles


# select a past-only run shift, including supported no-change decisions
def choose_shift(rain, past):
    rain, past = np.asarray(rain, dtype=np.float64), np.asarray(past, dtype=np.float64)
    # missing profile or observed past leaves no alignment support
    if rain.shape != (48,) or past.shape != (4,) or not np.isfinite(rain[:34]).all() or (rain[:34] < 0).any() or not np.isfinite(past).all() or (past < 0).any():
        return {'delta': 0, 'alignmentSupport': False, 'reason': 'missing_past' if past.shape != (4,) or not np.isfinite(past).all() or (past < 0).any() else 'missing_source'}
    # dry recent observations cannot justify a timing correction
    if not (past >= .1).any():
        return {'delta': 0, 'alignmentSupport': True, 'reason': 'recent_dry'}
    errors = {}
    # compare only source leads one through ten with observations available at decision
    for delta in range(-3, 4):
        errors[delta] = float(np.mean(np.abs(past - rain[np.arange(4, 8) + delta - 1])))
    best = min(errors, key=lambda delta: (errors[delta], abs(delta), delta))
    zero_error, best_error = errors[0], errors[best]
    # require both relative and absolute material improvement over zero shift
    if best != 0 and best_error <= .8 * zero_error and zero_error - best_error >= .02:
        return {'delta': best, 'alignmentSupport': True, 'reason': 'shifted'}
    return {'delta': 0, 'alignmentSupport': True, 'reason': 'no_material_improvement'}


# bind every paired raw value to its exact unshifted source lead
def validate_paired_profiles(data, profiles):
    # reject any absent run or source lead mismatch before scoring
    for initialized, horizon, raw in zip(data['initialized'], data['lead'], data['raw']):
        profile = profiles.get(int(initialized))
        lead = 8 + int(horizon)
        # compare in the feature builder's float32 representation
        if profile is None or not 1 <= lead <= 31 or not np.isfinite(profile[0][lead - 1]) or np.float32(profile[0][lead - 1]) != np.float32(raw):
            raise ValueError('paired raw forecast differs from source trajectory')


# choose all paired run alignments from observation hours four through seven
def run_shifts(data, profiles, observations):
    first = int(observations['first_hour'])
    target = observations['target']
    choices = {}
    # cache one causal decision per initialized run, never per future target
    for initialized in np.unique(data['initialized']):
        init = int(initialized)
        indices = init + np.arange(4, 8) - first
        past = target[indices] if (indices >= 0).all() and (indices < len(target)).all() else np.full(4, np.nan)
        choices[init] = choose_shift(profiles[init][0], past)
    return choices


# apply the source-time shift with a second forecast-time liquid phase gate
def shifted_rows(data, rows, profiles, choices):
    result = data['raw'][rows].astype(np.float64).copy()
    supported = np.zeros(len(rows), dtype=bool)
    phase_fallback = np.zeros(len(rows), dtype=bool)
    effective = np.zeros(len(rows), dtype=bool)
    # retain exact paired raw on unsupported alignment or cold shifted source hour
    for position, row in enumerate(rows):
        init = int(data['initialized'][row])
        choice = choices[init]
        rain, temperature = profiles[init]
        lead = 8 + int(data['lead'][row])
        supported[position] = choice['alignmentSupport']
        # unsupported runs retain raw without applying any amount correction
        if not choice['alignmentSupport'] or choice['delta'] == 0:
            continue
        shifted_lead = lead + choice['delta']
        # a missing or solid-phase source point cannot replace liquid target rain
        if not np.isfinite(temperature[shifted_lead - 1]) or temperature[shifted_lead - 1] <= 2.:
            phase_fallback[position] = choice['delta'] != 0
            continue
        result[position] = float(np.float32(rain[shifted_lead - 1]))
        effective[position] = np.float32(result[position]) != np.float32(data['raw'][row])
    return result, supported, phase_fallback, effective


# translate a candidate key only at the unchanged empirical gate boundary
def rename_candidate(value, candidate):
    # preserve scalar values while recursively adapting report sections
    if not isinstance(value, dict):
        return value
    return {('residualAmount' if key == candidate else key): rename_candidate(item, candidate) for key, item in value.items()}


# run all unchanged measured gates and the stronger same-window volume control
def candidate_screens(report, data, indices, flags):
    screens = {}
    # keep complete score populations while measuring actual supported dates
    for name in CANDIDATES:
        selected = flags[name]
        support = residual.support(data['actual'][indices][selected], data['hour'][indices][selected])
        view = rename_candidate(report, name)
        view['support'] = support
        view['invariants'] = {'finiteNonnegative': report['invariants']['finiteNonnegative']}
        gates = residual.development_gates(view)
        gates['beatsSameWindowVolumeScale'] = report['overall'][name]['mae'] <= report['overall']['volume90']['mae']
        gates['timingContribution'] = report['mechanismSupport']['dates'] >= POLICY['minimumEffectiveChangedDates'] and report['overall'][name]['mae'] < report['overall']['volume90']['mae'] - POLICY['timingContributionMaeMargin'] and report['overall'][name]['mae'] < report['overall']['supportedVolume90']['mae'] - POLICY['timingContributionMaeMargin']
        screens[name] = {'support': support, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [key for key, passed in gates.items() if not passed]}
    passing = [name for name in CANDIDATES if screens[name]['passed']]
    selected = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, selected


# score all forecasts, partitions and event thresholds on identical rows
def make_report(root, data, indices, predictions, flags, effective, choices, states, audit_sha):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # preserve equal date-hour-vintage metric populations
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'timing-freeze.json'), 'trajectorySha256': inputs.sha(root / 'inputs/trajectory.jsonl'), 'shiftAuditSha256': audit_sha, 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report['mechanismSupport'] = residual.support(actual[effective], hours[effective])
    report['nonzeroChosenRuns'] = int(len({int(init) for init in data['initialized'][indices] if choices[int(init)]['delta'] != 0}))
    report['effectiveChangedRuns'] = int(len(np.unique(data['initialized'][indices][effective])))
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in dates])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # keep every declared season, month, source era and lead band
    for field, groups in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {}
        for key in np.unique(groups):
            report[field][str(key)] = summarize(groups == key)
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['candidateScreens'], report['selectedCandidate'] = candidate_screens(report, data, indices, flags)
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    return report


# run one fixed timing family after a separately reviewed freeze
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # interrupted or completed runs are evidence, never overwrite targets
    if any((root / name).exists() for name in ('timing-models', 'shift-audit.jsonl', 'predictions.npz', 'report.json')):
        raise ValueError('timing replay already exists')
    data = inputs.load_inputs(root)
    manifest = json.loads((root / 'inputs/acquisition/manifest.json').read_text())
    profiles = load_profiles(root / 'inputs/trajectory.jsonl', cohort_metadata(manifest))
    validate_paired_profiles(data, profiles)
    with np.load(root / 'inputs/sub24-dataset/observations.npz', allow_pickle=False) as archive:
        observations = {'target': archive['target'], 'first_hour': archive['first_hour']}
    choices = run_shifts(data, profiles, observations)
    indices, states = [], {}
    amounts = {name: [] for name in (*BASELINES, *CANDIDATES)}
    flags = {name: [] for name in CANDIDATES}
    effective_parts = []
    phase_by_run = collections.Counter()
    directory = root / 'timing-models'
    directory.mkdir(mode=0o700)
    # score all predeclared months and preserve each final scalar state
    for month in POLICY['developmentMonths']:
        _, calibration, evaluation, bounds = search.month_masks(data, month)
        cal_rows, eval_rows = np.where(calibration)[0], np.where(evaluation)[0]
        raw_cal, raw_eval = data['raw'][cal_rows].astype(float), data['raw'][eval_rows].astype(float)
        actual_cal, hour_cal = data['actual'][cal_rows], data['hour'][cal_rows]
        shifted_cal, supported_cal, _, _ = shifted_rows(data, cal_rows, profiles, choices)
        shifted_eval, supported_eval, phase_eval, effective_eval = shifted_rows(data, eval_rows, profiles, choices)
        # baseline ninety-day scalar retains the search experiment contract
        raw_scalar = search.calibrate(actual_cal, hour_cal, lambda scale: np.clip(raw_cal * scale, 0, 30))
        supported_raw_scalar = search.calibrate(actual_cal, hour_cal, lambda scale: np.where(supported_cal, np.clip(raw_cal * scale, 0, 30), raw_cal))
        timing_scalar = search.calibrate(actual_cal, hour_cal, lambda scale: np.where(supported_cal, np.clip(shifted_cal * scale, 0, 30), raw_cal))
        previous = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
        persistence = data['persistence'][eval_rows]
        output = {'raw': raw_eval, 'zero': np.zeros_like(raw_eval), 'persistence': np.where(np.isfinite(persistence), persistence, raw_eval), 'volumeScale': raw_eval * previous['scales']['raw'], 'volume90': np.clip(raw_eval * raw_scalar['scale'], 0, 30), 'supportedVolume90': np.where(supported_eval, np.clip(raw_eval * supported_raw_scalar['scale'], 0, 30), raw_eval), 'timingOnly': shifted_eval, 'timingVolume90': np.where(supported_eval, np.clip(shifted_eval * timing_scalar['scale'], 0, 30), raw_eval)}
        state = {**bounds, 'calibrationRows': int(len(cal_rows)), 'evaluationRows': int(len(eval_rows)), 'rawCalibration': raw_scalar, 'supportedRawCalibration': supported_raw_scalar, 'timingCalibration': timing_scalar, 'calibrationAlignedRows': int(supported_cal.sum()), 'evaluationAlignedRows': int(supported_eval.sum()), 'evaluationPhaseFallbackRows': int(phase_eval.sum()), 'evaluationEffectiveRows': int(effective_eval.sum()), 'evaluationEffectiveDates': int(len(np.unique(data['hour'][eval_rows][effective_eval] // 24))), 'reasonCounts': dict(collections.Counter(choices[int(init)]['reason'] for init in np.unique(data['initialized'][eval_rows])))}
        month_directory = directory / month
        month_directory.mkdir(mode=0o700)
        inputs.write_json(month_directory / 'state.json', state)
        indices.append(eval_rows)
        states[month] = state
        # retain full-row controls and aligned-run candidate support separately
        for name in amounts:
            amounts[name].append(output[name])
        for name in flags:
            flags[name].append(supported_eval.copy())
        effective_parts.append(effective_eval)
        # count shifted-source phase fallbacks only on evaluated rows
        for init in data['initialized'][eval_rows][phase_eval]:
            phase_by_run[int(init)] += 1
        print(json.dumps({'month': month, 'rows': len(eval_rows), 'alignedRows': int(supported_eval.sum()), 'phaseFallbackRows': int(phase_eval.sum())}), flush=True)
    audit = root / 'shift-audit.jsonl'
    # retain one forecast-time decision per paired run without past target values
    with audit.open('x') as stream:
        for init, choice in sorted(choices.items()):
            stream.write(json.dumps({'initializedHour': init, **choice, 'phaseFallbackRows': phase_by_run[init]}, sort_keys=True, allow_nan=False) + '\n')
    indices = np.concatenate(indices)
    # require the unchanged complete development population before screening
    if len(indices) != POLICY['expectedEvaluationRows'] or len(np.unique(indices)) != len(indices):
        raise ValueError('timing evaluation population changed')
    amounts = {name: np.concatenate(parts) for name, parts in amounts.items()}
    flags = {name: np.concatenate(parts) for name, parts in flags.items()}
    effective = np.concatenate(effective_parts)
    report = make_report(root, data, indices, amounts, flags, effective, choices, states, inputs.sha(audit))
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, effectiveShift=effective, **{f'amount::{name}': value for name, value in amounts.items()}, **{f'supported::{name}': value for name, value in flags.items()})
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreens': report['candidateScreens'], 'productionEligible': False, 'independentEvaluationPerformed': False}


# permit only explicit preparation or consumed-development replay
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('source', type=Path)
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--retention-receipt', type=Path, required=True)
    execution = commands.add_parser('run')
    execution.add_argument('root', type=Path)
    arguments = parser.parse_args()
    result = prepare(arguments.source, arguments.root, arguments.retention_receipt) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result), flush=True)
