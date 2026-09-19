"""test one severity-routed rain hybrid with causal seasonal calibration."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil

# bind numerical reductions before native runtime imports
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import xgboost as xgb
import rain_event_guard as inputs
import rain_ordinal as ordinal
import rain_residual as residual
import rain_search as search
from rain_sub24 import FEATURE_NAMES, POLICY as PARENT_POLICY, hour_number
from retain_moisture_research import validate_private_root
from run_rain_sub24 import accumulations, score, weights

PRIMARY = 'hybridSeasonal'
ARMS = (*search.BASELINES, 'rawSeasonal', 'weightedModerate90', 'weightedSeasonal', 'ordinalReference', 'hybrid90', PRIMARY)
SEASONS = ('DJF', 'MAM', 'JJA', 'SON')
POLICY = {
    'contractVersion': 'rain-severity-hybrid-development/v1',
    'primary': PRIMARY,
    'developmentMonths': list(inputs.MONTHS),
    'expectedEvaluationRows': 32896,
    'developmentDataPreviouslyConsumed': True,
    'independentEvaluationPerformed': False,
    'productionEligible': False,
    'parameters': search.PARAMETERS,
    'boostRounds': 160,
    'ordinaryWeights': [1., 2., 4.],
    'ordinaryRawBlend': .25,
    'heavyRawBlend': .5,
    'heavyTrainingThreshold': 1.,
    'heavyTrainingSupport': {'hours': 50, 'dates': 10},
    'heavyObjective': 'reg:gamma',
    'routing': 'forecast_only_ordinal_1_and_2.5_calls_highest_category_with_heavy_composite_safety',
    'amountBands': 'ordinary_[0,1)_heavy_[1,2.5)_extreme_[2.5,30]',
    'trainingSupport': search.POLICY['trainingSupport'],
    'calibrationSupport': search.POLICY['calibrationSupport'],
    'candidateSupport': search.POLICY['candidateSupport'],
    'seasonSupport': {'dates': 30, 'wetDates': 10, 'heavyHours': 5},
    'seasonShrinkDates': 60,
    'seasonFactorBounds': [.5, 2.],
    'seasonRatioBounds': [.1, 3.],
    'seasonEstimator': 'training_only_raw_observed_volume_ratio_relative_to_global_log_shrinkage_no_learned_fit_residuals',
    'seasonFallback': 'unit_relative_multiplier_when_unsupported',
    'calibrationDays': 90,
    'embargoDays': 7,
    'calibrationScaleBounds': [.1, 3.],
    'calibration': 'earlier_90_day_scalar_on_final_season_scaled_category_projection_explicit_saturation',
    'screen': inputs.POLICY['screen'],
    'minimumHeavyRouteDates': 20,
    'ablationMaeMargin': 1e-12,
    'selection': 'one_primary_all_44_residual_gates_plus_volume90_matched_raw_seasonal_and_hybrid_added_value_else_none',
    'ablations': ['hybrid90', 'weightedSeasonal'],
    'ablationRole': 'support_matched_controls_must_lose_mae_to_primary_no_posthoc_candidate_selection',
    'prospectiveEvaluation': inputs.POLICY['prospectiveEvaluation'],
    'xgboostVersion': PARENT_POLICY['xgboostVersion'],
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_hybrid.py', *search.SOURCE_FILES)))


# preserve inherited acquisition identities and freeze the new single hypothesis
def prepare(source, root, receipt):
    inputs.prepare(source, root, receipt)
    directory = root / 'hybrid-sources'
    directory.mkdir(mode=0o700)
    hashes = {}
    # retain every exact producer dependency before new outcomes
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        shutil.copyfile(path, directory / name)
        hashes[name] = inputs.sha(path)
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'sourceSha256': hashes, 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'hybrid-freeze.json', freeze)
    validate_freeze(root)
    return freeze


# reject policy or implementation changes after opening development outcomes
def validate_freeze(root):
    inputs.validate_freeze(root)
    freeze = json.loads((root / 'hybrid-freeze.json').read_text())
    # bind the complete source schema and single-candidate policy
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json'):
        raise ValueError('hybrid freeze changed')
    # compare both retained and running source bytes
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'hybrid-sources' / name) != expected:
            raise ValueError('hybrid implementation changed after freeze')
    return freeze


# derive season from known valid-time calendar only
def seasons(hours):
    return np.array([SEASONS[((dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc).month % 12) // 3)] for hour in hours], dtype='U3')


# estimate baseline seasonal bias without learned-model in-sample residuals
def seasonal_state(actual, raw, hours):
    actual, raw, hours = np.asarray(actual, dtype=float), np.asarray(raw, dtype=float), np.asarray(hours)
    # reject malformed training-only populations
    if actual.ndim != 1 or actual.shape != raw.shape or actual.shape != hours.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or not np.isfinite(raw).all() or (actual < 0).any() or (raw < 0).any():
        raise ValueError('invalid seasonal training arrays')
    w = weights(hours)
    observed, predicted = float(w @ actual), float(w @ raw)
    global_ratio = float(np.clip(observed / predicted, .1, 3.)) if observed > 0 and predicted > 0 else None
    state = {'trainingMaximumActualHour': int(hours.max()) if len(hours) else None, 'globalObservedMean': observed, 'globalRawMean': predicted, 'globalRatio': global_ratio, 'seasons': {}}
    labels = seasons(hours)
    # retain support and explicit fallback for every calendar season
    for name in SEASONS:
        selected = labels == name
        counts = residual.support(actual[selected], hours[selected])
        counts['heavyHours'] = int(len(np.unique(hours[selected & (actual >= 1)])))
        entry = {'support': counts, 'factor': 1., 'ratio': None, 'shrinkWeight': 0., 'reason': 'insufficient_season_support'}
        # never infer a relative correction from an unidentified global ratio
        if global_ratio is None:
            entry['reason'] = 'unidentified_global_ratio'
        elif residual.supported(counts, POLICY['seasonSupport']):
            sw = weights(hours[selected])
            numerator, denominator = float(sw @ actual[selected]), float(sw @ raw[selected])
            # missing baseline rain cannot identify a seasonal multiplicative bias
            if numerator > 0 and denominator > 0:
                ratio = float(np.clip(numerator / denominator, .1, 3.))
                alpha = counts['dates'] / (counts['dates'] + POLICY['seasonShrinkDates'])
                factor = float(np.clip(np.exp(alpha * np.log(ratio / global_ratio)), .5, 2.))
                entry.update({'factor': factor, 'ratio': ratio, 'shrinkWeight': alpha, 'reason': 'estimated'})
            else:
                entry['reason'] = 'unidentified_season_ratio'
        state['seasons'][name] = entry
    return state


# apply the frozen calendar multiplier without evaluation observations
def seasonal_factors(hours, state):
    return np.array([state['seasons'][name]['factor'] for name in seasons(hours)], dtype=float)


# enforce the high-threshold hierarchy without borrowing observed severity
def severity_categories(raw, probabilities, rules):
    categories = ordinal.event_categories(raw, probabilities, rules)
    return np.where(categories >= 2, categories, 0).astype(np.int8)


# keep ordinary amounts flexible while preventing cross-category intensity drift
def project_amount(base, categories, factors, scale):
    base, factors, categories = np.asarray(base, dtype=float), np.asarray(factors, dtype=float), np.asarray(categories)
    # reject malformed inputs before clipping can hide them
    if base.ndim != 1 or base.shape != factors.shape or base.shape != categories.shape or not np.isfinite(base).all() or not np.isfinite(factors).all() or (base < 0).any() or (factors <= 0).any() or not np.issubdtype(categories.dtype, np.integer) or not np.isin(categories, (0, 2, 3)).all() or not np.isfinite(scale) or scale <= 0:
        raise ValueError('invalid hybrid projection arrays')
    scaled = base * factors * scale
    output = np.zeros(len(base), dtype=float)
    # preserve ordered event categories after seasonal and scalar correction
    for category, lower, upper in ((0, 0., np.nextafter(1., 0.)), (2, 1., np.nextafter(2.5, 0.)), (3, 2.5, 30.)):
        selected = categories == category
        output[selected] = np.clip(scaled[selected], lower, upper)
    return output


# check the nested heavy calls separately from the unused wet classifier
def heavy_rules(actual, raw, probabilities, hours, proposed):
    categories = severity_categories(raw, probabilities, proposed)
    projected = project_amount(np.ones(len(raw)), categories, np.ones(len(raw)), 1.)
    events, baseline = inputs.event_scores(actual, projected, hours), inputs.event_scores(actual, raw, hours)
    safe = all((events[key]['pod'] or 0.) + 1e-12 >= (baseline[key]['pod'] or 0.) and (events[key]['far'] or 0.) <= (baseline[key]['far'] or 0.) + .05 + 1e-12 and (events[key]['csi'] or 0.) + 1e-12 >= (baseline[key]['csi'] or 0.) - .01 for key in ('1.0', '2.5'))
    # fall back as one prespecified pair rather than search head subsets
    if not safe:
        return [{**rule, 'cutoff': None, 'reason': 'heavy_nesting_safety_fallback'} if rule['threshold'] >= 1 else dict(rule) for rule in proposed], True
    return proposed, False


# fit a separate positive intensity model on earlier observed heavy hours
def fit_heavy(data, fit, directory):
    selected = fit & (data['actual'] >= 1)
    counts = {'rows': int(selected.sum()), 'hours': int(len(np.unique(data['hour'][selected]))), 'dates': int(len(np.unique(data['hour'][selected] // 24)))}
    state = {'support': counts, 'modelSha256': None, 'reason': 'insufficient_heavy_training_support'}
    # preserve unsupported heavy branches without inventing a model
    if not residual.supported(counts, POLICY['heavyTrainingSupport']):
        return None, state
    matrix = xgb.DMatrix(data['x'][selected], label=data['actual'][selected], weight=weights(data['hour'][selected]) * int(selected.sum()), feature_names=list(FEATURE_NAMES), nthread=1)
    model = xgb.train({**search.PARAMETERS, 'objective': 'reg:gamma'}, matrix, num_boost_round=160)
    path = directory / 'heavy.json'
    model.save_model(path)
    state.update({'modelSha256': inputs.sha(path), 'reason': 'fitted'})
    return model, state


# combine ordinary and heavy amount heads using forecast-only severity
def routed_base(raw, ordinary, heavy, categories):
    heavy_base = np.clip(.5 * raw + .5 * heavy, 0, 30)
    return np.where(categories >= 2, heavy_base, ordinary)


# fit one chronological month with primary, matched controls and ablations
def fit_month(root, data, month):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    counts = {'training': residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': residual.support(data['actual'][calibration], data['hour'][calibration])}
    raw_cal, raw = data['raw'][calibration].astype(float), data['raw'][evaluation].astype(float)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    season = seasonal_state(data['actual'][fit], data['raw'][fit], data['hour'][fit])
    fc, fe = seasonal_factors(hours, season), seasonal_factors(data['hour'][evaluation], season)
    raw_scale = search.calibrate(actual, hours, lambda scale: np.clip(raw_cal * scale, 0, 30))
    raw_seasonal = search.calibrate(actual, hours, lambda scale: np.clip(raw_cal * fc * scale, 0, 30))
    old_state = json.loads((root / 'inputs/sub24-models' / month / 'state.json').read_text())
    recent = data['persistence'][evaluation]
    output = {'raw': raw, 'zero': np.zeros_like(raw), 'persistence': np.where(np.isfinite(recent), recent, raw), 'volumeScale': raw * old_state['scales']['raw'], 'volume90': np.clip(raw * raw_scale['scale'], 0, 30), 'rawSeasonal': np.clip(raw * fe * raw_seasonal['scale'], 0, 30)}
    heavy_route = np.zeros(len(raw), dtype=bool)
    state = {**bounds, 'support': counts, 'seasonalState': season, 'rawCalibration': raw_scale, 'rawSeasonalCalibration': raw_seasonal, 'supported': False, 'reason': 'insufficient_training_or_calibration_support', 'models': {}, 'calibrations': {}}
    directory = root / 'hybrid-models' / month
    directory.mkdir(parents=True, mode=0o700)
    # enforce the pinned native runtime before any fitted or fallback path
    if xgb.__version__ != POLICY['xgboostVersion']:
        raise ValueError('unexpected hybrid native runtime')
    # retain every evaluation row when native components lack support
    if not residual.supported(counts['training'], POLICY['trainingSupport']) or not residual.supported(counts['calibration'], POLICY['calibrationSupport']):
        output.update({name: raw.copy() for name in ARMS if name not in output})
    else:
        moderate_dir, ordinal_dir = directory / 'moderate', directory / 'ordinal'
        moderate_dir.mkdir(mode=0o700)
        ordinal_dir.mkdir(mode=0o700)
        ordinary, state['models']['moderate'] = search.fit_weighted(data, fit, calibration, evaluation, moderate_dir, [1., 2., 4.])
        models, state['models']['ordinal'] = ordinal.fit_models(data['x'][fit], data['actual'][fit], data['hour'][fit], ordinal_dir, search.PARAMETERS, 160)
        # the inherited global support must support the reference wet-amount head
        if models['amount'] is None:
            raise ValueError('inconsistent ordinal amount support')
        pc, ac = ordinal.predict(models, data['x'][calibration])
        pe, ae = ordinal.predict(models, data['x'][evaluation])
        proposed = ordinal.calibrate_events(actual, raw_cal, pc, hours)
        reference_rules, reference_fallback = search.checked_rules(actual, raw_cal, pc, hours, proposed)
        rules, fallback = heavy_rules(actual, raw_cal, pc, hours, proposed)
        cc, ce = severity_categories(raw_cal, pc, rules), severity_categories(raw, pe, rules)
        state.update({'proposedRules': proposed, 'referenceRules': reference_rules, 'referenceNestingFallback': reference_fallback, 'heavyRules': rules, 'heavyNestingFallback': fallback})
        reference_cc, reference_ce = ordinal.event_categories(raw_cal, pc, reference_rules), ordinal.event_categories(raw, pe, reference_rules)
        reference_scale = search.calibrate(actual, hours, lambda scale: ordinal.project_amount(search.blended(raw_cal, ac), reference_cc, scale))
        output['ordinalReference'] = ordinal.project_amount(search.blended(raw, ae), reference_ce, reference_scale['scale'])
        moderate_scale = search.calibrate(actual, hours, lambda scale: np.clip(ordinary['calibration'] * scale, 0, 30))
        seasonal_scale = search.calibrate(actual, hours, lambda scale: np.clip(ordinary['calibration'] * fc * scale, 0, 30))
        output['weightedModerate90'] = np.clip(ordinary['evaluation'] * moderate_scale['scale'], 0, 30)
        output['weightedSeasonal'] = np.clip(ordinary['evaluation'] * fe * seasonal_scale['scale'], 0, 30)
        state['calibrations'].update({'ordinalReference': reference_scale, 'weightedModerate90': moderate_scale, 'weightedSeasonal': seasonal_scale})
        heavy, state['models']['heavy'] = fit_heavy(data, fit, directory)
        state['reason'] = 'insufficient_heavy_training_support'
        # raw fallback remains visible when the new heavy branch cannot be fitted
        if heavy is None:
            output.update({'hybrid90': raw.copy(), PRIMARY: raw.copy(), 'weightedSeasonal': raw.copy()})
        else:
            hc = np.clip(heavy.predict(xgb.DMatrix(data['x'][calibration], feature_names=list(FEATURE_NAMES), nthread=1)).astype(float), 1, 30)
            he = np.clip(heavy.predict(xgb.DMatrix(data['x'][evaluation], feature_names=list(FEATURE_NAMES), nthread=1)).astype(float), 1, 30)
            bc, be = routed_base(raw_cal, ordinary['calibration'], hc, cc), routed_base(raw, ordinary['evaluation'], he, ce)
            heavy_route = (ce >= 2) & (be != ordinary['evaluation'])
            # isolate seasonality with an otherwise identical unseasonal hybrid
            for name, cal_factors, eval_factors in (('hybrid90', np.ones(len(fc)), np.ones(len(fe))), (PRIMARY, fc, fe)):
                scalar = search.calibrate(actual, hours, lambda scale: project_amount(bc, cc, cal_factors, scale))
                output[name] = project_amount(be, ce, eval_factors, scalar['scale'])
                state['calibrations'][name] = scalar
            state.update({'supported': True, 'reason': 'fitted_and_calibrated', 'calibrationHeavyCalls': int((cc >= 2).sum()), 'evaluationHeavyCalls': int((ce >= 2).sum())})
    state['evaluationEffectiveHeavyRows'] = int(heavy_route.sum())
    inputs.write_json(directory / 'state.json', state)
    return np.where(evaluation)[0], output, state, heavy_route


# preserve the old empirical evaluator without changing the primary identity
def primary_gates(report):
    view = search.rename_candidate(report, PRIMARY)
    gates = residual.development_gates(view)
    gates['beatsSameWindowVolumeScale'] = report['overall'][PRIMARY]['mae'] <= report['overall']['volume90']['mae']
    gates['beatsMatchedSeasonalRaw'] = report['overall'][PRIMARY]['mae'] <= report['overall']['rawSeasonal']['mae']
    gates['hybridAddedValue'] = report['mechanismSupport']['dates'] >= POLICY['minimumHeavyRouteDates'] and all(report['overall'][PRIMARY]['mae'] < report['overall'][name]['mae'] - POLICY['ablationMaeMargin'] for name in POLICY['ablations'])
    return gates


# retain every control and partition rather than select favorable subgroups
def make_report(root, data, indices, predictions, supported, heavy_route, states):
    actual, hours = data['actual'][indices], data['hour'][indices]

    # use the unchanged date-hour-vintage metric weighting
    def summarize(mask, target=actual):
        return {name: score(target[mask], values[mask], (values[mask] >= .1).astype(float), hours[mask]) for name, values in predictions.items()}

    report = {'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'hybrid-freeze.json'), 'overall': summarize(np.ones(len(indices), dtype=bool)), 'monthlyStates': states, 'support': residual.support(actual[supported], hours[supported]), 'independentEvaluationPerformed': False, 'productionEligible': False, 'productionWrites': False}
    report['mechanismSupport'] = residual.support(actual[heavy_route], hours[heavy_route])
    dates = [dt.datetime.fromtimestamp(int(hour) * 3600, dt.timezone.utc) for hour in hours]
    bands = np.where(data['lead'][indices] <= 6, '1-6', np.where(data['lead'][indices] <= 12, '7-12', '13-23'))
    era = np.where(data['initialized'][indices] < hour_number(PARENT_POLICY['archiveEraCutoverUtc']), 'before_50r1_cutover', 'from_50r1_cutover')
    # retain all fixed source-era, season, lead and month partitions
    for field, labels in (('bySeason', seasons(hours)), ('byLeadBand', bands), ('byMonth', np.array([date.strftime('%Y-%m') for date in dates])), ('byArchiveEra', era)):
        report[field] = {str(key): summarize(labels == key) for key in np.unique(labels)}
    report['meanTargetSensitivity'] = summarize(np.ones(len(indices), dtype=bool), data['mean'][indices])
    report['events'] = {name: inputs.event_scores(actual, values, hours) for name, values in predictions.items()}
    report['accumulations'] = accumulations(actual, predictions, data['initialized'][indices], data['lead'][indices])
    report['invariants'] = {'finiteNonnegative': bool(all(np.isfinite(values).all() and (values >= 0).all() for values in predictions.values()))}
    report['gates'] = primary_gates(report)
    report['failedGates'] = [name for name, passed in report['gates'].items() if not passed]
    report['developmentPassed'] = all(report['gates'].values())
    report['selectedCandidate'] = PRIMARY if report['developmentPassed'] else None
    report['decision'] = 'prospective_hypothesis_only_not_qualified' if report['developmentPassed'] else 'reject_primary_no_posthoc_ablation_promotion'
    report['ablationDeltas'] = {name: {metric: report['overall'][PRIMARY][metric] - report['overall'][name][metric] for metric in ('mae', 'wetMae', 'heavyMae', 'volumeRatio')} for name in POLICY['ablations']}
    return report


# execute the frozen primary once without adapting to development outcomes
def run(root):
    root = validate_private_root(root)
    validate_freeze(root)
    # preserve partial and completed runs instead of overwriting evidence
    if any((root / name).exists() for name in ('hybrid-models', 'predictions.npz', 'report.json')):
        raise ValueError('hybrid replay already exists')
    data = inputs.load_inputs(root)
    indices, supported, heavy_route, states = [], [], [], {}
    predictions = {name: [] for name in ARMS}
    # finish all fixed monthly refits before reading aggregate performance
    for month in POLICY['developmentMonths']:
        rows, output, state, routed = fit_month(root, data, month)
        indices.append(rows)
        supported.append(np.full(len(rows), state['supported'], dtype=bool))
        heavy_route.append(routed)
        states[month] = state
        # keep primary and every control on the same forecast rows
        for name in ARMS:
            predictions[name].append(output[name])
        print(json.dumps({'month': month, 'rows': len(rows), 'hybridSupported': state['supported']}), flush=True)
    indices, supported, heavy_route = np.concatenate(indices), np.concatenate(supported), np.concatenate(heavy_route)
    # forbid missing evaluation rows or repeated month membership
    if len(indices) != POLICY['expectedEvaluationRows'] or len(np.unique(indices)) != len(indices):
        raise ValueError('hybrid evaluation population changed')
    predictions = {name: np.concatenate(parts) for name, parts in predictions.items()}
    report = make_report(root, data, indices, predictions, supported, heavy_route, states)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, supported=supported, heavyRoute=heavy_route, **{f'amount::{name}': value for name, value in predictions.items()})
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'failedGates': report['failedGates'], 'productionEligible': False, 'independentEvaluationPerformed': False}


# permit only explicit preparation or development replay
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
    print(json.dumps(prepare(arguments.source, arguments.root, arguments.retention_receipt) if arguments.command == 'prepare' else run(arguments.root)), flush=True)
