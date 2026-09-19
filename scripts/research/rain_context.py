"""test new pressure and prior-cycle predictors on consumed rain development data."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil

# limit native numerical parallelism
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_event_guard as inputs
import rain_ordinal as ordinal
import rain_residual as residual
import rain_search as search
import rain_context_features as features
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score, weights

ROOT_NAME = 'weather-moisture-research-rain-context-20260913-v1'
LEARNERS = {
    'weightedBase': {'family': 'weighted_tweedie', 'features': 'base'},
    'weightedPressure': {'family': 'weighted_tweedie', 'features': 'pressure'},
    'weightedCycles': {'family': 'weighted_tweedie', 'features': 'cycle'},
    'weightedContext': {'family': 'weighted_tweedie', 'features': 'full'},
    'ordinalBase': {'family': 'ordinal_gamma', 'features': 'base'},
    'ordinalContext': {'family': 'ordinal_gamma', 'features': 'full'},
}
CANDIDATES = {'weightedContext': 'weightedBase', 'ordinalContext': 'ordinalBase'}
REFERENCE_ARMS = {'weightedBase': 'weightedModerate', 'ordinalBase': 'ordinalAmount'}
REFERENCE_FILES = {
    'report.json': '015fdcb747747ff9852f8b72f7be7a19dcf41b46963d2bb69b51e028355e55f4',
    'predictions.npz': '599daccfb51e9b7f514c9c4f6bf5d001f2fdff438b9a316e7bce466092edf30a',
}
BASELINES = search.BASELINES
PARAMETERS = search.PARAMETERS
POLICY = {
    **search.POLICY,
    'contractVersion': 'rain-context-development/v1',
    'candidates': CANDIDATES,
    'learners': LEARNERS,
    'expectedEvaluationRows': 32896,
    'rainWeights': [1., 2., 4.],
    'sourceCohort': features.COHORT,
    'sourceTrajectorySha256': features.ORIGINAL_SHA256,
    'featureSets': {name: list(values) for name, values in features.FEATURE_SETS.items()},
    'pressureFeatures': 'pL,pL-pLminus3,pL-pLminus6,pLplus6-pL,range_Lplusminus3,pL-p7;L=8+h',
    'priorCycles': 'only_Iminus6_and_Iminus12_same_valid_hour;older_source_lead=L+age;never_Iplus6',
    'cycleFeatures': 'prior6,prior12,revisions_current_minus_prior,prior_centered3h_means,available_rain_mean_std_ddof0_range_wet0.1_heavy1_fractions_count',
    'featurePrecision': 'forecast_source_float64_derived_then_float32;original77_unchanged',
    'missingFeatures': 'nan_individuals_strict_complete_pressure_windows_and_prior3h_means;aggregates_finite_current_and_priors;no_row_deletion',
    'sourceAvailability': 'simulated_initialization_plus_8h_not_verified_historical_receipts',
    'newInformationSupport': {'minimumRowFraction': .95, 'minimumDates': 300},
    'ablationMaeMargin': 1e-12,
    'selection': 'two_full_context_candidates_only_all44_original_gates_plus_volume90_strict_same_family_base_mae_and_new_information_support_then_mae_name_tiebreak_else_none',
    'referenceParity': {'files': REFERENCE_FILES, 'arms': REFERENCE_ARMS, 'requirement': 'exact_original_baseline_native_model_states_and_predictions_before_scoring'},
    'controlRole': 'base_and_single_feature_group_ablations_not_selectable_after_outcomes',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_context.py', 'rain_context_features.py', *search.SOURCE_FILES)))


# bind original acquisition and new feature policy before opening outcomes
def prepare(source, root, receipt):
    source, root = validate_private_root(source), Path(root)
    # retain one unambiguous sibling experiment identity
    if root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected context research destination')
    inputs.prepare(source, root, receipt)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    original, trajectory = source / 'acquisition' / cohort['path'], root / 'inputs/trajectory.jsonl'
    # verify both ends of the source-only private copy
    if original.stat().st_size != cohort['bytes'] or inputs.sha(original) != cohort['sha256']:
        raise ValueError('original context profile differs from manifest')
    shutil.copyfile(original, trajectory)
    if trajectory.stat().st_size != cohort['bytes'] or inputs.sha(trajectory) != cohort['sha256']:
        raise ValueError('copied context profile differs from manifest')
    reference = source.parent / 'weather-moisture-research-rain-search-20260913-v1'
    search.validate_freeze(reference)
    # retain previously known controls before opening any new outcomes
    for name, expected in REFERENCE_FILES.items():
        original_reference = reference / name
        if inputs.sha(original_reference) != expected:
            raise ValueError('reference search artifact changed')
        shutil.copyfile(original_reference, root / 'inputs' / ('reference-search-' + name))
    directory = root / 'context-sources'
    directory.mkdir(mode=0o700)
    hashes = {}
    # preserve new and inherited producer bytes without editing old experiments
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, directory / name)
        hashes[name] = inputs.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'featureSets': POLICY['featureSets'], 'sourceSha256': hashes, 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'trajectorySha256': cohort['sha256'], 'trajectoryBytes': cohort['bytes'], 'trajectoryRows': cohort['rows'], 'sourceManifestSha256': inputs.sha(root / 'inputs/acquisition/manifest.json'), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'context-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# reject changed policy, features, original acquisition or implementation
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'context-freeze.json').read_text())
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    trajectory = root / 'inputs/trajectory.jsonl'
    # enforce the complete predeclared experiment and exact source identity
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['featureSets'] != POLICY['featureSets'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['sourceManifestSha256'] != inputs.sha(root / 'inputs/acquisition/manifest.json') or any(freeze[key] != cohort[other] for key, other in (('trajectorySha256', 'sha256'), ('trajectoryBytes', 'bytes'), ('trajectoryRows', 'rows'))) or trajectory.stat().st_size != cohort['bytes'] or inputs.sha(trajectory) != cohort['sha256']:
        raise ValueError('context freeze or trajectory changed')
    # pin the previously known controls independently of any new model outcome
    for name, expected in REFERENCE_FILES.items():
        if inputs.sha(root / 'inputs' / ('reference-search-' + name)) != expected:
            raise ValueError('retained context reference changed')
    # compare retained and live producer dependencies
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'context-sources' / name) != expected:
            raise ValueError('context implementation changed after freeze')
    return freeze



# fit each direct amount arm independently with its prespecified label costs
def fit_weighted(data, x, names, fit, calibration, evaluation, directory):
    parameters = {**PARAMETERS, 'objective': 'reg:tweedie', 'tweedie_variance_power': 1.5}
    matrix = xgb.DMatrix(x[fit], label=data['actual'][fit], weight=search.cost_weights(data['actual'][fit], data['hour'][fit], POLICY['rainWeights']), feature_names=list(names), nthread=1)
    booster = xgb.train(parameters, matrix, num_boost_round=POLICY['boostRounds'])
    path = directory / 'amount.json'
    booster.save_model(path)
    output = {}
    # preserve the exact calibration and evaluation prediction populations
    for name, mask in (('calibration', calibration), ('evaluation', evaluation)):
        matrix = xgb.DMatrix(x[mask], feature_names=list(names), nthread=1)
        output[name] = search.blended(data['raw'][mask].astype(float), np.clip(booster.predict(matrix).astype(float), 0, 30))
    return output, {'parameters': parameters, 'rainWeights': POLICY['rainWeights'], 'modelSha256': inputs.sha(path)}


# fit four fixed native objectives without borrowing evaluation labels
def fit_ordinal(x, actual, hours, directory, names):
    x, actual, hours = np.asarray(x, dtype=np.float32), np.asarray(actual, dtype=np.float64), np.asarray(hours)
    # reject malformed feature matrices before native fitting
    if x.ndim != 2 or x.shape[1] != len(names) or np.isinf(x).any() or actual.shape != (len(x),) or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not len(x) or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid context ordinal training arrays')
    # require the reviewed native research runtime
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected ordinal learner runtime')
    # keep logistic and gamma intercepts on native automatic initialization
    if 'base_score' in PARAMETERS:
        raise ValueError('ordinal heads require automatic base scores')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    models = {}
    state = {'featureNames': list(names), 'rounds': POLICY['boostRounds'], 'heads': {}}
    # fit occurrence heads at all three physical thresholds
    for threshold, name, filename in zip(ordinal.THRESHOLDS, ordinal.HEAD_NAMES, ordinal.MODEL_FILES[:3]):
        support = ordinal._support(actual, hours, threshold)
        head = {'objective': 'binary:logistic', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_positive_support'}
        models[name] = None
        # preserve unsupported rare events as explicit raw fallback heads
        if support['positiveHours'] >= 10 and support['positiveDates'] >= 3:
            matrix = xgb.DMatrix(x, label=(actual >= threshold).astype(np.float32), weight=weights(hours) * len(hours), feature_names=list(names), nthread=1)
            booster = xgb.train({**PARAMETERS, 'objective': 'binary:logistic'}, matrix, num_boost_round=POLICY['boostRounds'])
            path = directory / filename
            booster.save_model(path)
            head.update({'modelFile': filename, 'sha256': inputs.sha(path), 'reason': 'fitted'})
            models[name] = booster
        state['heads'][name] = head
    wet = actual >= ordinal.THRESHOLDS[0]
    support = ordinal._support(actual, hours, ordinal.THRESHOLDS[0])
    amount = {'objective': 'reg:gamma', 'support': support, 'modelFile': None, 'sha256': None, 'reason': 'insufficient_wet_support'}
    models['amount'] = None
    # train conditional amount only where its positive gamma label exists
    if support['positiveHours'] >= 100 and support['positiveDates'] >= 20:
        matrix = xgb.DMatrix(x[wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=list(names), nthread=1)
        booster = xgb.train({**PARAMETERS, 'objective': 'reg:gamma'}, matrix, num_boost_round=POLICY['boostRounds'])
        path = directory / ordinal.MODEL_FILES[3]
        booster.save_model(path)
        amount.update({'modelFile': ordinal.MODEL_FILES[3], 'sha256': inputs.sha(path), 'reason': 'fitted'})
        models['amount'] = booster
    state['heads']['amount'] = amount
    return models, state


# predict event probabilities and wet-only amount without target labels
def predict_ordinal(models, x, names):
    x = np.asarray(x, dtype=np.float32)
    # bind all forecast features to the frozen order
    if x.ndim != 2 or x.shape[1] != len(names) or np.isinf(x).any():
        raise ValueError('invalid ordinal forecast features')
    probabilities = np.full((len(x), len(ordinal.THRESHOLDS)), np.nan, dtype=np.float64)
    amount = np.full(len(x), np.nan, dtype=np.float64)
    # empty forecast batches require no native call
    if not len(x):
        return probabilities, amount
    matrix = xgb.DMatrix(x, feature_names=list(names), nthread=1)
    # leave absent event heads marked for raw fallback
    for index, name in enumerate(ordinal.HEAD_NAMES):
        booster = models.get(name)
        # clip native numerical roundoff at probability limits
        if booster is not None:
            probabilities[:, index] = np.clip(booster.predict(matrix), 0, 1)
    # leave an unsupported conditional amount explicitly missing
    if models.get('amount') is not None:
        amount[:] = np.clip(models['amount'].predict(matrix), ordinal.THRESHOLDS[0], 30)
    return probabilities, amount


# fit unchanged learners on each predeclared input set without model retuning
def fit_month(root, data, matrices, month):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(data['actual'][calibration], data['hour'][calibration])}
    raw, actual, hours = data['raw'][evaluation].astype(float), data['actual'][calibration], data['hour'][calibration]
    recent = data['persistence'][evaluation]
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_state['scales']['raw']}
    raw_cal = data['raw'][calibration].astype(float)
    raw_scale = search.calibrate(actual, hours, lambda scale: np.clip(scale * raw_cal, 0, 30))
    output['volume90'] = np.clip(raw * raw_scale['scale'], 0, 30)
    state = {**bounds, 'support': counts, 'rawCalibration': raw_scale, 'candidates': {}}
    available = residual.supported(counts['training'], POLICY['trainingSupport']) and residual.supported(counts['calibration'], POLICY['calibrationSupport'])
    directory = root / 'context-models' / month
    directory.mkdir(parents=True, mode=0o700)
    # enforce the native runtime on fallback and supported paths alike
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected context native runtime')
    # retain complete monthly populations for every declared learner
    for name, specification in LEARNERS.items():
        if not available:
            output[name] = raw.copy()
            state['candidates'][name] = {'supported': False, 'reason': 'insufficient_training_or_calibration_support'}
            continue
        destination = directory / name
        destination.mkdir(mode=0o700)
        kind = specification['features']
        x, names = matrices[kind], features.FEATURE_SETS[kind]
        # fit identical cost-sensitive amount objectives across the input ablations
        if specification['family'] == 'weighted_tweedie':
            estimates, model_state = fit_weighted(data, x, names, fit, calibration, evaluation, destination)
            scalar = search.calibrate(actual, hours, lambda scale: np.clip(estimates['calibration'] * scale, 0, 30))
            output[name] = np.clip(estimates['evaluation'] * scalar['scale'], 0, 30)
            state['candidates'][name] = {'supported': True, 'model': model_state, 'calibration': scalar}
            continue
        models, model_state = fit_ordinal(x[fit], data['actual'][fit], data['hour'][fit], destination, names)
        # inherited training support must also support the wet gamma head
        if models['amount'] is None:
            raise ValueError('inconsistent context ordinal amount support')
        pc, ac = predict_ordinal(models, x[calibration], names)
        pe, ae = predict_ordinal(models, x[evaluation], names)
        proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
        rules, fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
        cc, ce = ordinal.event_categories(raw_cal, pc, rules), ordinal.event_categories(raw, pe, rules)
        base_cal = search.blended(raw_cal, ac)
        scalar = search.calibrate(actual, hours, lambda scale: ordinal.project_amount(base_cal, cc, scale))
        output[name] = ordinal.project_amount(search.blended(raw, ae), ce, scalar['scale'])
        state['candidates'][name] = {'supported': True, 'model': model_state, 'proposedRules': proposed, 'rules': rules, 'nestingSafetyFallback': fallback, 'calibration': scalar, 'compositeCalibrationEvents': inputs.event_scores(actual, ordinal.project_amount(base_cal, cc, scalar['scale']), hours)}
    inputs.write_json(directory / 'state.json', state)
    return np.where(evaluation)[0], output, state


# screen all arms independently and select only a complete gate-passer
def candidate_screens(report, data, indices, flags, availability):
    screens = {}
    # never choose a favorable subset of seasons or candidate-supported rows
    for name in CANDIDATES:
        supported = flags[name]
        counts = residual.support(data['actual'][indices][supported], data['hour'][indices][supported])
        view = search.rename_candidate(report, name)
        view['support'] = counts
        view['invariants'] = {'finiteNonnegative': report['invariants']['finiteNonnegative']}
        gates = residual.development_gates(view)
        gates['beatsSameWindowVolumeScale'] = report['overall'][name]['mae'] <= report['overall']['volume90']['mae']
        gates['beatsSameFamilyBase'] = report['overall'][name]['mae'] < report['overall'][CANDIDATES[name]]['mae'] - POLICY['ablationMaeMargin']
        supplied = availability['newInformationAvailable'][indices]
        dates = len(np.unique(data['hour'][indices][supplied] // 24))
        gates['newInformationCoverage'] = float(supplied.mean()) >= POLICY['newInformationSupport']['minimumRowFraction'] and dates >= POLICY['newInformationSupport']['minimumDates']
        screens[name] = {'support': counts, 'gates': gates, 'passed': all(gates.values()), 'failedGates': [key for key, value in gates.items() if not value]}
    passing = [name for name in CANDIDATES if screens[name]['passed']]
    selected = min(passing, key=lambda name: (report['overall'][name]['mae'], name)) if passing else None
    return screens, selected


# summarize new input coverage independently of observed rain labels
def availability_counts(hours, availability):
    return {name: {'rows': int(values.sum()), 'hours': int(len(np.unique(hours[values]))), 'dates': int(len(np.unique(hours[values] // 24))), 'rowFraction': float(values.mean()) if len(values) else 0.} for name, values in availability.items()}


# retain complete scores for every predeclared candidate and control
def make_report(root, data, indices, predictions, flags, states, availability):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # preserve equal date-hour-vintage weights for each metric population
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'context-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    seasons = np.array([('DJF' if date.month in (12, 1, 2) else 'MAM' if date.month in (3, 4, 5) else 'JJA' if date.month in (6, 7, 8) else 'SON') for date in dates])
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # keep each complete reporting partition regardless of outcome
    for field, labels in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {}
        for key in np.unique(labels):
            report[field][str(key)] = summarize(labels == key)
    report['featureAvailability'] = {'overall': availability_counts(hours, {name: values[indices] for name, values in availability.items()})}
    # expose missing new inputs on every reporting partition without dropping rows
    for field, labels in (('byLeadBand', bands), ('bySeason', seasons), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report['featureAvailability'][field] = {str(key): availability_counts(hours[labels == key], {name: values[indices][labels == key] for name, values in availability.items()}) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['candidateScreens'], report['selectedCandidate'] = candidate_screens(report, data, indices, flags, availability)
    report['developmentPassed'] = report['selectedCandidate'] is not None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'no_candidate_selected_all_failures_retained'
    return report


# prove unchanged control learners reproduce retained predictions before scoring
def reference_parity(root, indices, amounts, states):
    previous = json.loads((root / 'inputs/reference-search-report.json').read_text())
    with np.load(root / 'inputs/reference-search-predictions.npz', allow_pickle=False) as archive:
        # every control must retain the exact original row and prediction identity
        if not np.array_equal(indices, archive['indices']):
            raise ValueError('reference evaluation rows changed')
        for current, prior in REFERENCE_ARMS.items():
            if not np.array_equal(amounts[current], archive['amount::' + prior]):
                raise ValueError('context base predictions differ from prior search')
            # compare full training and calibration metadata including native model hashes
            for month, state in states.items():
                if state['candidates'][current] != previous['monthlyStates'][month]['candidates'][prior]:
                    raise ValueError('context base native model or calibration differs from prior search')
    return {'exactNativeModelStates': True, 'exactPredictions': True, 'arms': REFERENCE_ARMS}


# execute the full frozen matrix once rather than retrying individual failures
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # never overwrite an existing context artifact
    if any((root / name).exists() for name in ('context-models', 'report.json', 'predictions.npz', 'features.npz')):
        raise ValueError('context replay already exists')
    data = inputs.load_inputs(root)
    cohort = features.cohort_metadata(json.loads((root / 'inputs/acquisition/manifest.json').read_text()))
    profiles = features.load_profiles(root / 'inputs/trajectory.jsonl', cohort)
    matrices, availability = features.build_features(data, profiles)
    np.savez_compressed(root / 'features.npz', x=matrices['full'], **availability)
    indices, states = [], {}
    amounts = {name: [] for name in (*BASELINES, *LEARNERS)}
    flags = {name: [] for name in LEARNERS}
    # fit every prespecified month before comparing candidates
    for month in POLICY['developmentMonths']:
        rows, output, state = fit_month(root, data, matrices, month)
        indices.append(rows)
        states[month] = state
        for name in amounts:
            amounts[name].append(output[name])
        for name in flags:
            flags[name].append(np.full(len(rows), state['candidates'][name]['supported'], dtype=bool))
        print(json.dumps({'month': month, 'rows': len(rows), 'trainedCandidates': [name for name in LEARNERS if state['candidates'][name]['supported']]}), flush=True)
    indices = np.concatenate(indices)
    amounts = {name: np.concatenate(parts) for name, parts in amounts.items()}
    flags = {name: np.concatenate(parts) for name, parts in flags.items()}
    # reject changed evaluation populations before any selection
    if len(indices) != POLICY['expectedEvaluationRows'] or len(np.unique(indices)) != len(indices):
        raise ValueError('context evaluation population changed')
    parity = reference_parity(root, indices, amounts, states)
    report = make_report(root, data, indices, amounts, flags, states, availability)
    report['referenceParity'] = parity
    report['featuresSha256'] = inputs.sha(root / 'features.npz')
    report['featureProfileRuns'] = len(profiles)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{f'amount::{name}': value for name, value in amounts.items()}, **{f'supported::{name}': value for name, value in flags.items()})
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreens': report['candidateScreens'], 'productionEligible': False, 'independentEvaluationPerformed': False}


# run only an explicit preparation or context-input experiment command
if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest='command', required=True)
    preparation = subcommands.add_parser('prepare')
    preparation.add_argument('source', type=Path)
    preparation.add_argument('root', type=Path)
    preparation.add_argument('--retention-receipt', type=Path, required=True)
    execution = subcommands.add_parser('run')
    execution.add_argument('root', type=Path)
    arguments = parser.parse_args()
    result = prepare(arguments.source, arguments.root, arguments.retention_receipt) if arguments.command == 'prepare' else run(arguments.root)
    print(json.dumps(result), flush=True)
