"""apply unchanged rain hurdle calibration at each utc decision date."""

import datetime as dt

import numpy as np
import rain_hurdle_calibration as hurdle
import rain_ordinal as ordinal
import rain_recency_calibration as recent
import rain_residual as residual
import rain_search as search
import rain_trajectory as parent

CALIBRATION_DAYS = 90
EMBARGO_DAYS = 7
HOURS_PER_DAY = 24


# isolate one decision date and its earlier matured valid-hour window
def day_masks(data, decision_day):
    initialized = np.asarray(data['initialized'])
    horizons = np.asarray(data['lead'])
    hours = np.asarray(data['hour'])
    # reject malformed utc-hour geometry before selecting any labels
    if not isinstance(decision_day, (int, np.integer)) or isinstance(decision_day, (bool, np.bool_)) or initialized.ndim != 1 or horizons.shape != initialized.shape or hours.shape != initialized.shape or not all(np.issubdtype(values.dtype, np.integer) for values in (initialized, horizons, hours)) or not np.isin(horizons, np.arange(1, 24)).all() or not np.array_equal(hours, initialized + 8 + horizons):
        raise ValueError('invalid daily rain decision geometry')
    start = int(decision_day) * HOURS_PER_DAY
    stop = start + HOURS_PER_DAY
    calibration_stop = start - EMBARGO_DAYS * HOURS_PER_DAY
    calibration_start = calibration_stop - CALIBRATION_DAYS * HOURS_PER_DAY
    decision = initialized + 8
    calibration = (hours >= calibration_start) & (hours < calibration_stop)
    evaluation = (decision >= start) & (decision < stop)
    # keep utc dates explicit in a machine-readable half-open bound record
    bounds = {'decisionDate': dt.datetime.fromtimestamp(start * 3600, dt.timezone.utc).date().isoformat(), 'decisionDayStartHour': start, 'calibrationStartHour': calibration_start, 'calibrationMaximumValidHourExclusive': calibration_stop, 'decisionStartHour': start, 'decisionStopHourExclusive': stop}
    return calibration, evaluation, bounds


# fit daily rules on earlier labels and predict only the selected decision day
def calibrate_day(data, probabilities, base, decision_day, fallback_eval):
    calibration, evaluation, bounds = day_masks(data, decision_day)
    rows = np.flatnonzero(evaluation)
    fallback = np.asarray(fallback_eval)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    base = np.asarray(base, dtype=np.float64)
    # require aligned inference arrays but ignore irrelevant outside-window nan
    if probabilities.shape != (len(evaluation), 3) or base.shape != evaluation.shape or fallback.shape != (len(rows),) or fallback.dtype.kind not in 'fiu' or not np.isfinite(fallback).all() or (fallback < 0).any():
        raise ValueError('invalid daily rain forecast arrays')
    actual = np.asarray(data['actual'][calibration], dtype=np.float64)
    hours = np.asarray(data['hour'][calibration])
    # calibration support never includes the evaluation date's targets
    if not np.isfinite(actual).all() or (actual < 0).any():
        raise ValueError('invalid daily rain calibration labels')
    support = residual.support(actual, hours)
    effective = {'effectiveDates': 0., 'effectiveWetDates': 0.}
    # weigh only a nonempty previously matured calibration population
    if len(hours):
        weight = recent.recent_weights(hours, bounds['calibrationMaximumValidHourExclusive'])
        effective = recent.effective_support(actual, hours, weight)
    supported = residual.supported(support, parent.POLICY['calibrationSupport']) and residual.supported(effective, parent.POLICY['effectiveSupport'])
    state = {**bounds, 'supported': bool(supported), 'proposedRules': None, 'uniformRules': None, 'nestingSafetyFallback': None, 'calibration': None, 'reason': 'insufficient_calibration_support', 'support': support, 'effectiveSupport': effective}
    # preserve the exact frozen monthly amount when daily support is too thin
    if not supported or not len(rows):
        # distinguish an absent target date from unsupported daily calibration
        if not len(rows):
            state['reason'] = 'no_evaluation_rows'
            state['supported'] = False
        return rows, fallback.copy(), state
    raw_cal = np.asarray(data['raw'][calibration], dtype=np.float64)
    raw_eval = np.asarray(data['raw'][evaluation], dtype=np.float64)
    probabilities_cal = probabilities[calibration]
    probabilities_eval = probabilities[evaluation]
    base_cal = base[calibration]
    base_eval = base[evaluation]
    proposed = ordinal.calibrate_events(actual, raw_cal, probabilities_cal, hours)
    rules, nesting_fallback = search.checked_rules(actual, raw_cal, probabilities_cal, hours, proposed)
    fitted = hurdle.calibrate(actual, hours, raw_cal, probabilities_cal, base_cal, rules, bounds['calibrationMaximumValidHourExclusive'])
    predicted = hurdle.predict(raw_eval, probabilities_eval, base_eval, fitted)
    state.update({'proposedRules': proposed, 'uniformRules': rules, 'nestingSafetyFallback': nesting_fallback, 'calibration': fitted, 'reason': 'daily_hurdle_calibrated'})
    return rows, predicted, state
