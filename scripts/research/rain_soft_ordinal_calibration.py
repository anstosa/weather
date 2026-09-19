"""calibrate a coherent four-bin rain distribution without hard event calls."""

import numpy as np
from run_rain_sub24 import weights as balanced_weights

CONTRACT = 'rain-soft-ordinal-calibration/v1'
THRESHOLDS = np.array((.1, 1., 2.5), dtype=np.float64)
GRID_OFFSETS = tuple(index / 20 for index in range(-30, 31))
PROBABILITY_EPSILON = 1e-6
LOG_MASS_FLOOR = 1e-12
MINIMUM_BIN_HOURS = 10
MINIMUM_BIN_DATES = 3
BIN_LIMITS = ((0., .1), (.1, np.nextafter(1., 0.)), (1., np.nextafter(2.5, 0.)), (2.5, 30.))


# validate complete physical outcomes and integer utc hours
def _outcomes(actual, hours):
    actual, hours = np.asarray(actual), np.asarray(hours)
    # reject coercible text, booleans, nonfinite values and misaligned rows
    if (actual.ndim != 1 or not len(actual) or actual.dtype.kind not in 'iuf' or hours.shape != actual.shape or not np.issubdtype(hours.dtype, np.integer)):
        raise ValueError('invalid soft ordinal outcomes or hours')
    actual = actual.astype(np.float64)
    # reject negative or nonfinite physical rain
    if not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid soft ordinal rain labels')
    return actual, hours.astype(np.int64, copy=False)


# validate finite native event probabilities without replacing missing heads
def _probabilities(probabilities, allow_empty=False):
    probabilities = np.asarray(probabilities)
    # require exactly the three native logistic heads
    if (probabilities.ndim != 2 or probabilities.shape[1] != 3 or (not allow_empty and not len(probabilities)) or probabilities.dtype.kind not in 'iuf'):
        raise ValueError('invalid soft ordinal probability shape or dtype')
    probabilities = probabilities.astype(np.float64)
    # reject partial missing heads or values outside probability bounds
    if not np.isfinite(probabilities).all() or (probabilities < 0).any() or (probabilities > 1).any():
        raise ValueError('invalid soft ordinal probabilities')
    return probabilities


# estimate wet-bin support amounts using the original full-fit balance
def fit_bin_means(actual_fit, hours_fit):
    actual, hours = _outcomes(actual_fit, hours_fit)
    weight = balanced_weights(hours)
    labels = np.searchsorted(THRESHOLDS, actual, side='right')
    bins = []
    # never rebalance the hour/date mass inside an observed bin
    for index, (lower, upper) in enumerate(BIN_LIMITS):
        selected = labels == index
        selected_hours = np.unique(hours[selected])
        support = {
            'index': index,
            'lowerMm': float(lower),
            'upperMmExclusive': float(THRESHOLDS[index]) if index < 3 else None,
            'rows': int(selected.sum()),
            'uniqueHours': len(selected_hours),
            'uniqueDates': len(np.unique(selected_hours // 24)),
            'weightMass': float(weight[selected].sum()),
            'supported': index == 0,
            'mean': 0. if index == 0 else None,
        }
        # require independent support for every wet amount bin
        if index and support['uniqueHours'] >= MINIMUM_BIN_HOURS and support['uniqueDates'] >= MINIMUM_BIN_DATES:
            mean = float((weight[selected] @ actual[selected]) / support['weightMass'])
            support['mean'] = float(np.clip(mean, lower, upper))
            support['supported'] = True
        bins.append(support)
    supported = all(item['supported'] for item in bins)
    return {'supported': supported, 'means': [item['mean'] for item in bins] if supported else None, 'bins': bins}


# turn three nested event tails into four nonnegative class masses
def bin_probabilities(probabilities, offset):
    probability = _probabilities(probabilities, allow_empty=True)
    # keep the calibrator on its preregistered finite grid
    if type(offset) not in (int, float) or float(offset) not in GRID_OFFSETS:
        raise ValueError('invalid soft ordinal log-odds offset')
    clipped = np.clip(probability, PROBABILITY_EPSILON, 1. - PROBABILITY_EPSILON)
    nested = np.minimum.accumulate(clipped, axis=1)
    logits = np.log(nested) - np.log1p(-nested) + float(offset)
    tails = 1. / (1. + np.exp(-logits))
    return np.column_stack((1. - tails[:, 0], tails[:, 0] - tails[:, 1], tails[:, 1] - tails[:, 2], tails[:, 2]))


# select one shared odds offset by four-class proper log loss
def calibrate(actual_cal, hours_cal, probabilities):
    actual, hours = _outcomes(actual_cal, hours_cal)
    probability = _probabilities(probabilities)
    # bind all scores to the identical calibration population
    if len(probability) != len(actual):
        raise ValueError('misaligned soft ordinal calibration probabilities')
    labels = np.searchsorted(THRESHOLDS, actual, side='right')
    weight = balanced_weights(hours)
    scores = []
    # evaluate the entire frozen grid without gating on volume or events
    for offset in GRID_OFFSETS:
        mass = bin_probabilities(probability, offset)
        scores.append(float(-(weight @ np.log(np.maximum(mass[np.arange(len(actual)), labels], LOG_MASS_FLOOR)))))
    # break exact loss ties toward zero then the smaller offset
    chosen = min(range(len(scores)), key=lambda index: (scores[index], abs(GRID_OFFSETS[index]), GRID_OFFSETS[index]))
    return {
        'contractVersion': CONTRACT,
        'selectedOffset': GRID_OFFSETS[chosen],
        'selectedIndex': chosen,
        'selectedScore': scores[chosen],
        'gridOffsets': list(GRID_OFFSETS),
        'gridScores': scores,
        'calibrationRows': len(actual),
        'calibrationDates': len(np.unique(hours // 24)),
    }


# emit only the predictive mean without reading rain outcomes
def predict(probabilities, means, state):
    means = np.asarray(means)
    # reject unsupported wet-bin means or nonphysical distribution support
    if (means.shape != (4,) or means.dtype.kind not in 'iuf'):
        raise ValueError('invalid soft ordinal bin means')
    means = means.astype(np.float64)
    # retain the dry point mass and disjoint physical wet bins
    if (not np.isfinite(means).all() or means[0] != 0. or any(not lower <= means[index] <= upper for index, (lower, upper) in enumerate(BIN_LIMITS) if index)):
        raise ValueError('invalid soft ordinal bin means')
    # require a complete frozen calibration state
    if (not isinstance(state, dict) or state.get('contractVersion') != CONTRACT or state.get('gridOffsets') != list(GRID_OFFSETS) or type(state.get('selectedIndex')) is not int or not 0 <= state['selectedIndex'] < len(GRID_OFFSETS) or state.get('selectedOffset') != GRID_OFFSETS[state['selectedIndex']]):
        raise ValueError('invalid soft ordinal calibration state')
    mass = bin_probabilities(probabilities, state['selectedOffset'])
    return np.clip(mass @ means, 0., 30.)
