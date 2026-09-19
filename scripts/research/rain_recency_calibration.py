"""calibrate fixed ordinal rain heads with prior-date recency weights."""

import numpy as np
import rain_ordinal as ordinal
from run_rain_sub24 import weights as balanced_weights

WINDOW_DAYS = 90
HALF_LIFE_DAYS = 30
SCALE_BOUNDS = (.1, 3.)
SCALE_ITERATIONS = 64
ABSOLUTE_TOLERANCE = 1e-10
RELATIVE_TOLERANCE = 1e-8
MINIMUM_POSITIVE_HOURS = (10, 5, 3)


# validate one normalized positive date-hour-vintage weight vector
def _validated_weight(weight, size):
    weight = np.asarray(weight, dtype=np.float64)
    # reject partial, negative or unnormalized calibration mass
    if weight.shape != (size,) or not size or not np.isfinite(weight).all() or (weight <= 0).any() or not np.isclose(float(weight.sum()), 1., rtol=1e-8, atol=1e-12):
        raise ValueError('invalid recency calibration weights')
    return weight


# retain equal date/hour/vintage balance before a fixed thirty-day decay
def recent_weights(hours, stop):
    hours = np.asarray(hours)
    # require one complete earlier ninety-day date envelope
    if hours.ndim != 1 or not len(hours) or not np.issubdtype(hours.dtype, np.integer) or type(stop) not in (int, np.int64, np.int32) or stop % 24 or (hours < stop - WINDOW_DAYS * 24).any() or (hours >= stop).any():
        raise ValueError('invalid recency calibration hours or stop')
    age_dates = stop // 24 - 1 - hours // 24
    decay = np.exp2(-age_dates.astype(np.float64) / HALF_LIFE_DAYS)
    weight = balanced_weights(hours) * decay
    weight /= weight.sum()
    return _validated_weight(weight, len(hours))


# count Kish-effective date mass, including conditional wet-date mass
def effective_support(actual, hours, weight):
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    weight = _validated_weight(weight, len(actual))
    # require aligned physical outcomes and integer valid hours
    if actual.ndim != 1 or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid recency support arrays')
    _, dates = np.unique(hours // 24, return_inverse=True)
    mass = np.bincount(dates, weights=weight)
    wet = actual >= .1
    wet_dates = np.unique(hours[wet] // 24)
    # no observed wet dates supply zero rather than a fictitious Kish count
    if not len(wet_dates):
        wet_effective = 0.
    else:
        _, wet_inverse = np.unique(hours[wet] // 24, return_inverse=True)
        wet_mass = np.bincount(wet_inverse, weights=weight[wet])
        normalized = wet_mass / wet_mass.sum()
        wet_effective = float(1. / np.dot(normalized, normalized))
    return {'effectiveDates': float(1. / np.dot(mass, mass)), 'effectiveWetDates': wet_effective}


# solve the unchanged clipped scalar calibration curve under explicit weights
def calibrate(actual, hours, projection, weight):
    actual = np.asarray(actual, dtype=np.float64)
    hours = np.asarray(hours)
    weight = _validated_weight(weight, len(actual))
    # require one aligned nonnegative calibration population
    if actual.ndim != 1 or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid recency scalar calibration population')
    target = float(weight @ actual)
    lower, upper = SCALE_BOUNDS
    tolerance = ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * abs(target)

    # evaluate the final amount map rather than an unconstrained precursor
    def mean(scale):
        prediction = np.asarray(projection(scale), dtype=np.float64)
        # reject invalid projections before a weighted aggregate can hide them
        if prediction.shape != actual.shape or not np.isfinite(prediction).all() or (prediction < 0).any():
            raise ValueError('invalid recency scalar projection')
        return float(weight @ prediction)

    low_mean, high_mean = mean(lower), mean(upper)
    # retain the same nearest bounded endpoint when a target is unattainable
    if target < low_mean:
        scale, status = lower, 'saturated_low'
    elif target > high_mean:
        scale, status = upper, 'saturated_high'
    elif abs(mean(1.) - target) <= tolerance:
        scale, status = 1., 'matched'
    else:
        # bisect one monotone final-amount response for sixty-four iterations
        for _ in range(SCALE_ITERATIONS):
            midpoint = (lower + upper) / 2
            # retain the side whose attainable mean still brackets the target
            if mean(midpoint) < target:
                lower = midpoint
            else:
                upper = midpoint
        scale = min((lower, upper), key=lambda value: (abs(mean(value) - target), abs(value - 1), value))
        status = 'matched' if abs(mean(scale) - target) <= tolerance else 'unmatched_numeric'
    achieved = mean(scale)
    return {'scale': scale, 'status': status, 'targetMean': target, 'lowerMean': low_mean, 'upperMean': high_mean, 'achievedMean': achieved, 'residual': achieved - target, 'tolerance': tolerance}


# report weighted detection, false-alarm rate and critical success index
def _metrics(observed, called, weight, null_missing=False):
    hit = float(weight @ (observed & called))
    miss = float(weight @ (observed & ~called))
    false = float(weight @ (~observed & called))
    missing = None if null_missing else 0.
    return {'pod': missing if hit + miss == 0 else hit / (hit + miss), 'far': missing if hit + false == 0 else false / (hit + false), 'csi': missing if hit + miss + false == 0 else hit / (hit + miss + false)}


# calibrate each fixed event head on weighted earlier outcomes only
def calibrate_events(actual, raw, probabilities, hours, weight):
    actual = np.asarray(actual, dtype=np.float64)
    raw = np.asarray(raw, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    hours = np.asarray(hours)
    weight = _validated_weight(weight, len(actual))
    # bind aligned nonnegative labels, raw forecasts and score columns
    if actual.ndim != 1 or raw.shape != actual.shape or hours.shape != actual.shape or probabilities.shape != (len(actual), len(ordinal.THRESHOLDS)) or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or not np.isfinite(raw).all() or (actual < 0).any() or (raw < 0).any():
        raise ValueError('invalid recency event calibration arrays')
    rules = []
    # keep physical event thresholds and support minima unchanged
    for index, (threshold, name, minimum_hours) in enumerate(zip(ordinal.THRESHOLDS, ordinal.HEAD_NAMES, MINIMUM_POSITIVE_HOURS)):
        observed = actual >= threshold
        positive_hours = np.unique(hours[observed])
        support = {'rows': int(len(actual)), 'positiveRows': int(observed.sum()), 'positiveHours': int(len(positive_hours)), 'positiveDates': int(len(np.unique(positive_hours // 24)))}
        raw_metrics = _metrics(observed, raw >= threshold, weight)
        rule = {'threshold': threshold, 'head': name, 'cutoff': None, 'reason': 'insufficient_calibration_support', 'support': support, 'raw': raw_metrics, 'candidate': None, 'targetRecall': None}
        scores = probabilities[:, index]
        # unsupported event populations retain the raw call at this threshold
        if support['positiveHours'] >= minimum_hours and support['positiveDates'] >= 2:
            # a wholly missing head is a supported raw fallback
            if np.isnan(scores).all():
                rule['reason'] = 'missing_model_head'
            else:
                # partial, infinite or out-of-range scores indicate broken inference
                if not np.isfinite(scores).all() or (scores < 0).any() or (scores > 1).any():
                    raise ValueError('invalid recency event probabilities')
                target = min(1., raw_metrics['pod'] + .05)
                rule['targetRecall'] = target
                cutoff = None
                # the first descending tied positive score is the largest recall-safe cutoff
                for score in np.unique(scores[observed])[::-1]:
                    candidate = _metrics(observed, scores >= score, weight)
                    # stop only after meeting the weighted recall margin
                    if candidate['pod'] + 1e-12 >= target:
                        cutoff = float(score)
                        rule['candidate'] = candidate
                        break
                # preserve full-calibration precision and skill safeguards
                if cutoff is not None and rule['candidate']['far'] <= raw_metrics['far'] + .05 + 1e-12 and rule['candidate']['csi'] + 1e-12 >= raw_metrics['csi'] - .01:
                    rule.update({'cutoff': cutoff, 'reason': 'calibrated'})
                else:
                    rule['reason'] = 'calibration_safety_regression'
        rules.append(rule)
    return rules


# reset all heads if their combined category calls violate any raw event guard
def checked_rules(actual, raw, probabilities, hours, rules, weight):
    actual = np.asarray(actual, dtype=np.float64)
    raw = np.asarray(raw, dtype=np.float64)
    hours = np.asarray(hours)
    weight = _validated_weight(weight, len(actual))
    # reject malformed outcomes before an event fallback can conceal them
    if actual.ndim != 1 or raw.shape != actual.shape or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer) or not np.isfinite(actual).all() or not np.isfinite(raw).all() or (actual < 0).any() or (raw < 0).any():
        raise ValueError('invalid recency nested-event arrays')
    categories = ordinal.event_categories(raw, probabilities, rules)
    proposed_amount = ordinal.project_amount(np.ones(len(raw)), categories, 1.)
    safe = True
    # evaluate actual nested calls at every fixed physical threshold
    for threshold in ordinal.THRESHOLDS:
        observed = actual >= threshold
        baseline = _metrics(observed, raw >= threshold, weight, null_missing=True)
        proposed = _metrics(observed, proposed_amount >= threshold, weight, null_missing=True)
        # retain the original composite null-to-zero comparison semantics
        if (proposed['pod'] or 0.) + 1e-12 < (baseline['pod'] or 0.) or (proposed['far'] or 0.) > (baseline['far'] or 0.) + .05 + 1e-12 or (proposed['csi'] or 0.) + 1e-12 < (baseline['csi'] or 0.) - .01:
            safe = False
    # reject all head cutoffs rather than selecting favorable subsets
    if not safe:
        return [{**rule, 'cutoff': None, 'reason': 'nesting_safety_fallback'} for rule in rules], True
    return rules, False
