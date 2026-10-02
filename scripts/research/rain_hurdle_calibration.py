"""calibrate nested rain occurrence and category amounts on earlier labels."""

import copy

import numpy as np
import rain_ordinal as ordinal
import rain_recency_calibration as recent
from run_rain_sub24 import weights as balanced_weights

CONTRACT = 'rain-hurdle-calibration/v1'
MINIMUM_WET_HOURS = 10
MINIMUM_WET_DATES = 2
MINIMUM_CATEGORY_WET_HOURS = 20
MINIMUM_CATEGORY_WET_DATES = 5
TOLERANCE = 1e-12


# validate one aligned earlier-only calibration population
def _calibration_arrays(actual, hours, raw, probabilities, base):
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    raw = np.asarray(raw, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    base = np.asarray(base, dtype=np.float64)
    # reject nonphysical labels, forecasts or predictor geometry
    if actual.ndim != 1 or hours.shape != actual.shape or raw.shape != actual.shape or base.shape != actual.shape or probabilities.shape != (len(actual), len(ordinal.THRESHOLDS)) or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or not np.isfinite(raw).all() or not np.isfinite(base).all() or (actual < 0).any() or (raw < 0).any() or (base < 0).any():
        raise ValueError('invalid hurdle calibration arrays')
    # missing heads are all-nan; a partial or out-of-range head is broken
    for column in probabilities.T:
        if not np.isnan(column).all() and (not np.isfinite(column).all() or (column < 0).any() or (column > 1).any()):
            raise ValueError('invalid hurdle calibration probabilities')
    return actual, hours, raw, probabilities, base


# score final nested wet calls with uniform date-hour-vintage mass
def _wet_metrics(actual, raw, probabilities, rules, weight):
    categories = ordinal.event_categories(raw, probabilities, rules)
    observed, called = actual >= .1, categories >= 1
    hit = float(weight @ (observed & called))
    miss = float(weight @ (observed & ~called))
    false = float(weight @ (~observed & called))
    return {'pod': 0. if hit + miss == 0 else hit / (hit + miss), 'far': 0. if hit + false == 0 else false / (hit + false), 'csi': 0. if hit + miss + false == 0 else hit / (hit + miss + false)}


# choose one wet cutoff by the CSI of final nested calls, not isolated head calls
def _select_wet_rule(actual, hours, raw, probabilities, uniform_rules):
    weight = balanced_weights(hours)
    observed = actual >= .1
    positive_hours = np.unique(hours[observed])
    support = {'positiveHours': int(len(positive_hours)), 'positiveDates': int(len(np.unique(positive_hours // 24)))}
    raw_rules = [{'threshold': threshold, 'cutoff': None} for threshold in ordinal.THRESHOLDS]
    raw_metrics = _wet_metrics(actual, raw, probabilities, raw_rules, weight)
    old_rules = copy.deepcopy(uniform_rules)
    old_metrics = _wet_metrics(actual, raw, probabilities, old_rules, weight)
    selection = {'support': support, 'rawMetrics': raw_metrics, 'oldNestedMetrics': old_metrics, 'candidateScores': 0, 'feasibleScores': 0, 'selectedMetrics': old_metrics, 'selectedCutoff': old_rules[0]['cutoff'], 'reason': 'old_wet_rule_fallback'}
    scores = probabilities[:, 0]
    # require the unchanged wet-event support and a complete native head
    if support['positiveHours'] < MINIMUM_WET_HOURS or support['positiveDates'] < MINIMUM_WET_DATES:
        selection['reason'] = 'insufficient_wet_support'
        return old_rules, selection
    # retain the old cutoff when the entire wet probability head is missing
    if np.isnan(scores).all():
        selection['reason'] = 'missing_wet_head'
        return old_rules, selection
    best_rules, best_metrics = old_rules, old_metrics
    best_cutoff = old_rules[0]['cutoff']
    best_feasible = old_metrics['pod'] + TOLERANCE >= raw_metrics['pod'] and old_metrics['far'] <= raw_metrics['far'] + .05 + TOLERANCE
    # candidate ranking includes the original wet rule as an explicit fallback
    best_rank = (old_metrics['csi'], float('-inf') if best_cutoff is None else float(best_cutoff)) if best_feasible else None
    unique_scores = np.unique(scores)
    selection['candidateScores'] = int(len(unique_scores))
    # only calibrated wet cutoffs may vary; both heavy rules remain byte-equivalent
    for score in unique_scores:
        rules = copy.deepcopy(old_rules)
        rules[0]['cutoff'] = float(score)
        metrics = _wet_metrics(actual, raw, probabilities, rules, weight)
        # enforce raw recall and false-alarm safety on final nested calls
        if metrics['pod'] + TOLERANCE < raw_metrics['pod'] or metrics['far'] > raw_metrics['far'] + .05 + TOLERANCE:
            continue
        selection['feasibleScores'] += 1
        rank = (metrics['csi'], float(score))
        # prefer highest cutoff for exact CSI ties
        if best_rank is None or rank > best_rank:
            best_rank, best_rules, best_metrics, best_cutoff = rank, rules, metrics, float(score)
    # no feasible new score leaves the original uniform wet rule intact
    if best_rank is None or best_rules is old_rules:
        selection['reason'] = 'no_feasible_new_cutoff' if selection['feasibleScores'] == 0 else 'old_wet_rule_best'
    else:
        selection['reason'] = 'optimized_nested_csi'
    selection.update({'selectedMetrics': best_metrics, 'selectedCutoff': best_cutoff})
    return best_rules, selection


# fit the fixed global and eligible per-category recent amount scalars
def calibrate(actual, hours, raw, probabilities, base, uniform_rules, stop):
    actual, hours, raw, probabilities, base = _calibration_arrays(actual, hours, raw, probabilities, base)
    # bind exactly three ordered ordinal event rules
    if not isinstance(uniform_rules, (list, tuple)) or len(uniform_rules) != len(ordinal.THRESHOLDS):
        raise ValueError('invalid uniform hurdle event rules')
    # preserve only finite physical cutoffs or explicit raw fallbacks
    for rule, threshold in zip(uniform_rules, ordinal.THRESHOLDS):
        cutoff = rule.get('cutoff') if isinstance(rule, dict) else None
        if not isinstance(rule, dict) or rule.get('threshold') != threshold or 'cutoff' not in rule or (cutoff is not None and (not isinstance(cutoff, (int, float, np.integer, np.floating)) or not np.isfinite(cutoff) or cutoff < 0 or cutoff > 1)):
            raise ValueError('invalid uniform hurdle event rule')
    weight = recent.recent_weights(hours, stop)
    rules, selection = _select_wet_rule(actual, hours, raw, probabilities, uniform_rules)
    categories = ordinal.event_categories(raw, probabilities, rules)
    global_scalar = recent.calibrate(actual, hours, lambda scale: ordinal.project_amount(base, categories, scale), weight)
    category_states = {}
    # calibrate each forecast wet category using all its observed labels
    for category in (1, 2, 3):
        selected = categories == category
        wet = selected & (actual >= .1)
        wet_hours = np.unique(hours[wet])
        support = {'rows': int(selected.sum()), 'predictedHours': int(len(np.unique(hours[selected]))), 'predictedDates': int(len(np.unique(hours[selected] // 24))), 'observedWetRows': int(wet.sum()), 'observedWetHours': int(len(wet_hours)), 'observedWetDates': int(len(np.unique(wet_hours // 24))), 'observedDryRows': int((selected & (actual < .1)).sum())}
        state = {'support': support, 'supported': False, 'reason': 'global_recent_fallback_insufficient_wet_support', 'calibration': None, 'scale': global_scalar['scale']}
        # require independent observed wet support inside this predicted class
        if support['observedWetHours'] >= MINIMUM_CATEGORY_WET_HOURS and support['observedWetDates'] >= MINIMUM_CATEGORY_WET_DATES:
            category_weight = weight[selected] / float(weight[selected].sum())
            scalar = recent.calibrate(actual[selected], hours[selected], lambda scale: ordinal.project_amount(base[selected], categories[selected], scale), category_weight)
            state.update({'supported': True, 'reason': 'category_recent_calibrated', 'calibration': scalar, 'scale': scalar['scale']})
        category_states[str(category)] = state
    observed_wet = actual >= .1
    wet_hours = np.unique(hours[observed_wet])
    support = {'rows': int(len(actual)), 'dates': int(len(np.unique(hours // 24))), 'observedWetRows': int(observed_wet.sum()), 'observedWetHours': int(len(wet_hours)), 'observedWetDates': int(len(np.unique(wet_hours // 24))), **recent.effective_support(actual, hours, weight)}
    return {'contractVersion': CONTRACT, 'uniformRules': copy.deepcopy(uniform_rules), 'rules': rules, 'wetSelection': selection, 'calibrationSupport': support, 'globalCalibration': global_scalar, 'categories': category_states, 'scaleBounds': list(recent.SCALE_BOUNDS), 'calibrationStopHourExclusive': int(stop), 'calibrationRows': int(len(actual)), 'productionEligible': False}


# apply only frozen rule and category scalars without reading outcomes
def predict(raw, probabilities, base, state):
    raw = np.asarray(raw, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    base = np.asarray(base, dtype=np.float64)
    # reject invalid forecast inputs and unrecognized calibration contracts
    if raw.ndim != 1 or base.shape != raw.shape or probabilities.shape != (len(raw), len(ordinal.THRESHOLDS)) or not np.isfinite(raw).all() or not np.isfinite(base).all() or (raw < 0).any() or (base < 0).any() or not isinstance(state, dict) or state.get('contractVersion') != CONTRACT or state.get('scaleBounds') != list(recent.SCALE_BOUNDS):
        raise ValueError('invalid hurdle prediction input or state')
    # reject malformed scores even where a rule falls back to raw
    for column in probabilities.T:
        if not np.isnan(column).all() and (not np.isfinite(column).all() or (column < 0).any() or (column > 1).any()):
            raise ValueError('invalid hurdle prediction probabilities')
    # require complete, finite, bounded category scales before projection
    if not isinstance(state.get('rules'), list) or not isinstance(state.get('uniformRules'), list) or len(state['rules']) != 3 or len(state['uniformRules']) != 3 or state['rules'][1:] != state['uniformRules'][1:] or not isinstance(state.get('categories'), dict) or set(state['categories']) != {'1', '2', '3'}:
        raise ValueError('invalid hurdle frozen rule structure')
    # bound every category scale before any class-specific amount projection
    if any(not isinstance(state['categories'][str(category)], dict) or type(state['categories'][str(category)].get('scale')) not in (int, float) or not np.isfinite(state['categories'][str(category)]['scale']) or not recent.SCALE_BOUNDS[0] <= state['categories'][str(category)]['scale'] <= recent.SCALE_BOUNDS[1] for category in (1, 2, 3)):
        raise ValueError('invalid hurdle category scales')
    categories = ordinal.event_categories(raw, probabilities, state['rules'])
    result = np.zeros(len(raw), dtype=np.float64)
    # category zero remains exact zero without a post-category global rescale
    for category in (1, 2, 3):
        selected = categories == category
        result[selected] = ordinal.project_amount(base[selected], categories[selected], state['categories'][str(category)]['scale'])
    return result
