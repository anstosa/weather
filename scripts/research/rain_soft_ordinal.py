"""test one probability-bin mean using unchanged frozen wind predictors."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# retain deterministic single-thread native inference
for _name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[_name] = '1'

import numpy as np
import rain_soft_ordinal_calibration as soft
import rain_wind as parent
import xgboost as xgb
from rain_hurdle import copy_member
from rain_sub24 import FEATURE_NAMES

inputs = parent.inputs
search = parent.search
ROOT_NAME = 'weather-moisture-research-rain-soft-ordinal-20260913-v1'
PRIMARY = 'softOrdinalWind'
ARMS = (*parent.ARMS[:-1], 'windOriginal', PRIMARY)
PARENT_PINS = {
    'wind-freeze.json': 'b80c0c6b18b9c026978e1947db734cdbf5ac2b6ae3dc1ff7dce0974493c5d9b8',
    'report.json': 'f3d6c2d570b2029093b288f21e9e62ce0c896f0956b2f06ce6ada9673dfda56a',
    'predictions.npz': 'ff2f2040acd674ba3881e58b9e3337eaf393ce73f71185fd102992c9f0368f1e',
}
# retain the shared screen and source contract without obsolete amount rules
UNUSED_PARENT_POLICY_KEYS = ('rawBlend', 'calibrationScaleBounds', 'calibrationIterations', 'calibrationTolerance', 'unattainableCalibration', 'ordinalThresholdPolicy', 'ordinalNestingSafety', 'primaryCalibration', 'wetCutoff', 'heavyRules', 'categoryAmounts', 'categorySupport', 'categoryFallback')
POLICY = {
    **{key: value for key, value in parent.POLICY.items() if key not in UNUSED_PARENT_POLICY_KEYS},
    'contractVersion': 'rain-soft-ordinal-development/v1',
    'primary': PRIMARY,
    'candidates': [PRIMARY],
    'arms': list(ARMS),
    'parentPins': PARENT_PINS,
    'treeFitPerformed': False,
    'nativeModelsFit': 0,
    'nativeModelsReused': 36,
    'nativeModelsUnused': 12,
    'nativeModels': 'exact_frozen_wind_binary_heads;gamma_retained_but_unused;no_refitting',
    'binFit': 'original_fit_date_hour_vintage_weights_restricted_and_renormalized_inside_actual_bins',
    'binMinimumSupport': {'uniqueHours': 10, 'uniqueDates': 3},
    'binMeans': 'm0=0;m1_clipped_[.1,nextafter1];m2_[1,nextafter2.5];m3_[2.5,30];fit_labels_not_preclipped',
    'probabilityProjection': 'clip_1e-6_to_1minus1e-6_then_cumulative_min_across_three_tail_thresholds',
    'calibrationAlgorithm': 'one_common_logit_offset_k_over20_k=-30..30_by_full_cal_balanced_categorical_NLL;log_floor1e-12;exact_ties_abs_offset_then_offset',
    'calibrationWeights': 'uniform_equal_valid_date_hour_vintage;no_decay',
    'recencyUsedOnlyForEffectiveSupport': True,
    'fitWeight': 'inherited_binary_heads_equal_date_hour_vintage;fit_bin_means_restrict_same_full_fit_mass;no_gamma_prediction',
    'probability': 'coherent_three_tail_four_bin_distribution;screen_events_still_threshold_the_point_mean',
    'prediction': 'four_bin_probability_weighted_fit_bin_means;clip0to30;no_hard_category_floor_raw_blend_or_volume_scalar',
    'unsupportedMonthly': 'exact_ordinal90_if_old_support_or_any_wet_bin_support_or_any_probability_head_is_missing',
    'selection': 'one_preregistered_probability_bin_mean_primary_all49_fixed_gates_else_none',
}
SOURCE_FILES = tuple(dict.fromkeys(('rain_soft_ordinal.py', 'rain_soft_ordinal_calibration.py', *parent.SOURCE_FILES)))


# freeze the exact completed wind experiment before any new model outcome
def prepare(source, root, receipt_path):
    source, root = parent.validate_private_root(source), Path(root)
    # no other parent or output cohort may supply a convenient replacement
    if source.name != parent.ROOT_NAME or root.name != ROOT_NAME or root.parent != source.parent:
        raise ValueError('unexpected soft ordinal root')
    parent.validate_freeze(source)
    manifest = parent.retained_manifest(source, receipt_path)
    # bind every inherited outcome to the independently retained failed model
    for name, expected in PARENT_PINS.items():
        if inputs.sha(source / name) != expected:
            raise ValueError('soft ordinal parent identity changed')
    proof = json.loads((source / 'final-evidence/independent-verification-final.json').read_text())
    # prior failure must have a complete independent replay before inheritance
    if manifest['reportSha256'] != PARENT_PINS['report.json'] or proof.get('verified') is not True or proof.get('all49GatesVerified') is not True or proof.get('reportSha256') != PARENT_PINS['report.json'] or proof.get('predictionsSha256') != PARENT_PINS['predictions.npz']:
        raise ValueError('soft ordinal parent not independently retained')
    root.mkdir(mode=0o700)
    parent.validate_private_root(root)
    hashes = {}
    # preserve the inherited schema, source envelope and every native head byte
    for name, entry in manifest['files'].items():
        if name in ('freeze.json', 'hurdle-freeze.json', 'trajectory-freeze.json', 'wind-freeze.json') or name.startswith(('inputs/', 'sources/', 'hurdle-sources/', 'trajectory-sources/', 'wind-sources/', 'wind-models/', 'wind-states/')):
            parent.copy_input(source, root, name, name, entry['sha256'], hashes)
    # retain matched predictions and verified features as explicit parent inputs
    for name in ('report.json', 'predictions.npz', 'features.npz', 'retention-manifest.json', 'final-evidence/independent-verification-final.json'):
        expected = inputs.sha(source / name) if name == 'retention-manifest.json' else manifest['files'][name]['sha256']
        parent.copy_input(source, root, name, 'inputs/wind/' + name, expected, hashes)
    relative = 'inputs/wind/parent-retention-receipt.json'
    copy_member(Path(receipt_path), root / relative, inputs.sha(Path(receipt_path)))
    hashes[relative] = inputs.sha(Path(receipt_path))
    directory = root / 'soft-ordinal-sources'
    directory.mkdir(mode=0o700)
    sources = {}
    # snapshot executing code before scoring this new probability transformation
    for name in SOURCE_FILES:
        path = Path(__file__).with_name(name)
        sources[name] = inputs.sha(path)
        copy_member(path, directory / name, sources[name])
    freeze = {'policy': POLICY, 'featureNames': list(FEATURE_NAMES), 'contextFeatureNames': POLICY['featureNames'], 'inputSchemaFreezeSha256': inputs.sha(root / 'freeze.json'), 'parentFreezeSha256': inputs.sha(root / 'wind-freeze.json'), 'inputSha256': hashes, 'sourceSha256': sources, 'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'newCandidateOutcomesRead': False, 'priorOutcomesAlreadyKnown': True, 'productionWrites': False}
    inputs.write_json(root / 'soft-ordinal-freeze.json', freeze)
    return validate_freeze(root)


# bind the new transformation and all inherited source and learner bytes
def validate_freeze(root):
    parent.validate_freeze(root)
    freeze = json.loads((root / 'soft-ordinal-freeze.json').read_text())
    # fixed columns, chronology and candidate identity cannot drift after outcomes
    if freeze['policy'] != POLICY or freeze['featureNames'] != list(FEATURE_NAMES) or freeze['contextFeatureNames'] != POLICY['featureNames'] or freeze['inputSchemaFreezeSha256'] != inputs.sha(root / 'freeze.json') or freeze['parentFreezeSha256'] != PARENT_PINS['wind-freeze.json'] or set(freeze['sourceSha256']) != set(SOURCE_FILES) or freeze['newCandidateOutcomesRead'] is not False or freeze['priorOutcomesAlreadyKnown'] is not True or freeze['productionWrites'] is not False:
        raise ValueError('soft ordinal freeze changed')
    # compare both retained and currently executing source implementations
    for name, expected in freeze['sourceSha256'].items():
        if inputs.sha(Path(__file__).with_name(name)) != expected or inputs.sha(root / 'soft-ordinal-sources' / name) != expected:
            raise ValueError('soft ordinal source changed')
    # no copied feature, source, model or prior prediction may be substituted
    for name, expected in freeze['inputSha256'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or any(part.is_symlink() for part in (path, *path.parents)) or inputs.sha(path) != expected:
            raise ValueError('soft ordinal input changed')
    return freeze


# decode only frozen probability heads while leaving the gamma model unused
def load_models(root, month, model_state):
    # use the pinned native runtime and exact feature order
    if xgb.__version__ != POLICY['xgboostVersion'] or model_state['featureNames'] != POLICY['featureNames'] or model_state['rounds'] != 160:
        raise ValueError('soft ordinal native schema changed')
    models = {}
    # all three tails use the exact same earlier fitted wind feature matrix
    for name in parent.ordinal.HEAD_NAMES:
        head = model_state['heads'][name]
        models[name] = None
        # an absent native head triggers one whole-month fallback in the caller
        if head['modelFile'] is not None:
            path = root / 'wind-models' / month / head['modelFile']
            # refuse a changed file before native decoding
            if inputs.sha(path) != head['sha256'] or head['objective'] != 'binary:logistic':
                raise ValueError('soft ordinal native head bytes changed')
            model = xgb.Booster(model_file=path)
            # the inherited automatic-intercept binary model stays unmodified
            if model.feature_names != POLICY['featureNames'] or model.num_boosted_rounds() != 160 or json.loads(model.save_config())['learner']['objective']['name'] != 'binary:logistic':
                raise ValueError('soft ordinal native head configuration changed')
            models[name] = model
    return models


# estimate bin means on fit labels and one offset on earlier calibration labels
def fit_month(root, data, x, month, control):
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    actual, hours = data['actual'][calibration], data['hour'][calibration]
    counts = {'training': parent.residual.support(data['actual'][fit], data['hour'][fit]), 'calibration': parent.residual.support(actual, hours)}
    effective = parent.recent.effective_support(actual, hours, parent.recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive']))
    supported = parent.residual.supported(counts['training'], POLICY['trainingSupport']) and parent.residual.supported(counts['calibration'], POLICY['calibrationSupport']) and parent.residual.supported(effective, POLICY['effectiveSupport'])
    inherited = root / 'wind-states' / (month + '.json')
    retained = json.loads(inherited.read_text())
    # reused training may not cross a different fit or calibration boundary
    if any(retained[key] != value for key, value in bounds.items()) or retained['support'] != counts or retained['effectiveSupport'] != effective or retained['supported'] != supported:
        raise ValueError('soft ordinal parent monthly chronology changed')
    state = {**bounds, 'support': counts, 'effectiveSupport': effective, 'supported': False, 'model': retained['model'], 'inheritedStateSha256': inputs.sha(inherited), 'binFit': None, 'calibration': None, 'reason': 'insufficient_support'}
    rows = np.where(evaluation)[0]
    # original insufficient support keeps every unchanged ordinal control row
    if not supported:
        return rows, control.copy(), state
    fitted_bins = soft.fit_bin_means(data['actual'][fit], data['hour'][fit])
    state['binFit'] = fitted_bins
    # unsupported amount bins retain the complete original ordinal month
    if not fitted_bins['supported']:
        state['reason'] = 'insufficient_bin_support'
        return rows, control.copy(), state
    models = load_models(root, month, retained['model'])
    # no partially defined probability distribution is used for prediction
    if any(model is None for model in models.values()):
        state['reason'] = 'missing_probability_head'
        return rows, control.copy(), state
    pc, _ = parent.context.predict_ordinal(models, x[calibration], POLICY['featureNames'])
    pe, _ = parent.context.predict_ordinal(models, x[evaluation], POLICY['featureNames'])
    calibrated = soft.calibrate(actual, hours, pc)
    predicted = soft.predict(pe, fitted_bins['means'], calibrated)
    state.update({'supported': True, 'calibration': calibrated, 'reason': 'soft_ordinal_calibrated'})
    return rows, predicted, state


# preserve all fixed gates and controls while relabeling only the new primary
def make_report(root, data, indices, predictions, supported, states):
    aliased = {parent.PRIMARY if name == PRIMARY else name: values for name, values in predictions.items()}
    report = parent.parent.rename_key(parent.make_report(root, data, indices, aliased, supported, states), parent.PRIMARY, PRIMARY)
    report.update({'contractVersion': POLICY['contractVersion'], 'policy': POLICY, 'freezeSha256': inputs.sha(root / 'soft-ordinal-freeze.json'), 'treeFitPerformed': False, 'nativeModelsFit': 0, 'nativeModelsReused': 36, 'nativeModelsUnused': 12, 'selectedCandidate': PRIMARY if report['candidateScreen']['passed'] else None})
    return report


# reuse verified predictors and emit all forecasts before evaluating outcomes
def run(root):
    root = parent.validate_private_root(root)
    # the one-shot output belongs to this registered sibling only
    if root.name != ROOT_NAME:
        raise ValueError('soft ordinal output root changed')
    validate_freeze(root)
    # partial evidence never authorizes another attempt
    if any((root / name).exists() for name in ('soft-ordinal-states', 'features.npz', 'report.json', 'predictions.npz')):
        raise ValueError('soft ordinal experiment already attempted')
    data = inputs.load_inputs(root)
    source_features = root / 'inputs/wind/features.npz'
    with np.load(source_features, allow_pickle=False) as saved:
        x = saved['x']
        wind_available = saved['windVectorAvailable']
    # preserve all old feature rows and explicit missing wind values
    if x.dtype != np.dtype(np.float32) or x.shape != (len(data['actual']), 107) or np.isinf(x).any() or wind_available.shape != (len(x),) or wind_available.dtype != np.dtype(bool):
        raise ValueError('soft ordinal frozen feature schema changed')
    copy_member(source_features, root / 'features.npz', inputs.sha(source_features))
    with np.load(root / 'inputs/wind/predictions.npz', allow_pickle=False) as old:
        reference_indices = old['indices']
        predictions = {name: old['amount::' + name] for name in parent.ARMS[:-1]}
        predictions['windOriginal'] = old['amount::' + parent.PRIMARY]
    directory = root / 'soft-ordinal-states'
    directory.mkdir(mode=0o700)
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # transform all twelve months without selecting favorable subsets or trials
    for month in inputs.MONTHS:
        _, _, mask, _ = search.month_masks(data, month)
        end = offset + int(mask.sum())
        rows, predicted, state = fit_month(root, data, x, month, predictions['ordinal90'][offset:end])
        # no month can reorder or omit an original forecast
        if not np.array_equal(rows, reference_indices[offset:end]):
            raise ValueError('soft ordinal month population changed')
        inputs.write_json(directory / (month + '.json'), state)
        states[month] = state
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state['supported'], dtype=bool))
        offset = end
        print(json.dumps({'month': month, 'rows': len(rows), 'supported': state['supported']}), flush=True)
    indices, supported = np.concatenate(indices), np.concatenate(flags)
    # all fixed development rows must precede the first aggregate score
    if offset != 32896 or len(np.unique(indices)) != offset or not np.array_equal(indices, reference_indices):
        raise ValueError('soft ordinal evaluation rows changed')
    predictions[PRIMARY] = np.concatenate(amounts)
    validate_freeze(root)
    np.savez_compressed(root / 'predictions.npz', indices=indices, **{'amount::' + name: values for name, values in predictions.items()}, candidateSupported=supported)
    report = make_report(root, data, indices, predictions, supported, states)
    report['referenceParity'] = {'exactPredictions': True, 'arms': {**{name: name for name in parent.ARMS[:-1]}, 'windOriginal': parent.PRIMARY}}
    report['featuresSha256'] = inputs.sha(root / 'features.npz')
    report['originalFeaturesSha256'] = inputs.sha(source_features)
    source_report = json.loads((root / 'inputs/direction/report.json').read_text())
    report['directionSourceSha256'] = source_report['normalizedSha256']
    report['directionSourceCoverage'] = {'unresolvedRuns': source_report['newUnresolvedRuns'], 'perMonthCoverage': source_report['perMonthCoverage']}
    report['windAvailability'] = {'evaluationRows': int(wind_available[indices].sum()), 'evaluationTotal': len(indices), 'featureColumns': 107}
    report['predictionsSha256'] = inputs.sha(root / 'predictions.npz')
    inputs.write_json(root / 'report.json', report)
    return {'selectedCandidate': report['selectedCandidate'], 'candidateScreen': report['candidateScreen'], 'productionEligible': False}


# separate immutable preparation from one causal development replay
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
    args = parser.parse_args()
    result = prepare(args.source, args.root, args.retention_receipt) if args.command == 'prepare' else run(args.root)
    print(json.dumps(result), flush=True)
