"""derive forecast-only pressure and prior-cycle rain context."""

import hashlib
import json
from pathlib import Path

import numpy as np
from rain_sub24 import FEATURE_NAMES, hour_number

COHORT = 'ecmwf_single_run_hindcast'
ORIGINAL_SHA256 = 'f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1'
PRESSURE_NAMES = (
    'forecastPressureHpa', 'pressureChange3h', 'pressureChange6h',
    'pressureNext6hChange', 'pressureRange7h', 'pressureSinceDecision',
)
CYCLE_NAMES = (
    'prior6Rain', 'prior12Rain', 'revision6Rain', 'revision12Rain',
    'prior6Mean3h', 'prior12Mean3h', 'vintageRainMean', 'vintageRainStd',
    'vintageRainRange', 'vintageWetFraction', 'vintageHeavyFraction', 'vintageCount',
)
FEATURE_SETS = {
    'base': tuple(FEATURE_NAMES),
    'pressure': tuple(FEATURE_NAMES) + PRESSURE_NAMES,
    'cycle': tuple(FEATURE_NAMES) + CYCLE_NAMES,
    'full': tuple(FEATURE_NAMES) + PRESSURE_NAMES + CYCLE_NAMES,
}


# bind one retained cohort to the original forecast acquisition identity
def cohort_metadata(manifest):
    files = manifest.get('cohortFiles', {})
    cohort = files.get(COHORT)
    # reject cohort switches, path changes and invented aggregate lengths
    if set(files) != {COHORT} or not isinstance(cohort, dict) or cohort.get('path') != 'normalized/ecmwf_single_run_hindcast.jsonl' or cohort.get('sha256') != ORIGINAL_SHA256 or type(cohort.get('bytes')) is not int or cohort['bytes'] <= 0 or type(cohort.get('rows')) is not int or type(cohort.get('successfulRuns')) is not int or cohort['successfulRuns'] <= 0 or cohort['rows'] != 48 * cohort['successfulRuns']:
        raise ValueError('invalid context forecast cohort metadata')
    return cohort


# decode a nullable normalized physical forecast measurement
def _measurement(row, name, minimum, maximum):
    value = row[name]
    # retain source nulls as missing features rather than dry or zero pressure
    if value is None:
        return np.nan
    # reject booleans, infinities and out-of-domain forecast values
    if type(value) not in (int, float) or not np.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError('invalid normalized context measurement')
    return float(value)


# parse the byte-bound original forty-eight-lead trajectories once
def load_profiles(path, cohort):
    path = Path(path)
    # rebind the caller's manifest metadata before opening source profiles
    if cohort.get('sha256') != ORIGINAL_SHA256 or cohort.get('path') != 'normalized/ecmwf_single_run_hindcast.jsonl' or cohort.get('rows') != 48 * cohort.get('successfulRuns', -1) or path.stat().st_size != cohort.get('bytes') or hashlib.sha256(path.read_bytes()).hexdigest() != ORIGINAL_SHA256:
        raise ValueError('context source hash or row metadata changed')
    profiles = {}
    rows = 0
    with path.open() as stream:
        block = []
        # require contiguous complete initialized runs
        for line in stream:
            row = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            block.append(row)
            rows += 1
            # materialize one source profile at a time
            if len(block) == 48:
                init = hour_number(block[0]['runInitializedAt'])
                # reject duplicate or mixed initialization and lead identities
                if init in profiles or any(item['runInitializedAt'] != block[0]['runInitializedAt'] or item['targetLeadHours'] != lead or hour_number(item['validAt']) != init + lead or ('cohort' in item and item['cohort'] != COHORT) for lead, item in enumerate(block, 1)):
                    raise ValueError('invalid context profile identity')
                profiles[init] = {
                    'rain': np.array([_measurement(item, 'rawPrecipitationMm', 0, 2000) for item in block], dtype=np.float64),
                    'temperature': np.array([_measurement(item, 'rawTemperatureC', -100, 70) for item in block], dtype=np.float64),
                    'pressure': np.array([_measurement(item, 'rawPressureHpa', 100, 1200) for item in block], dtype=np.float64),
                }
                block = []
        # preserve manifest run and row counts exactly
        if block or rows != cohort['rows'] or len(profiles) != cohort['successfulRuns']:
            raise ValueError('incomplete context forecast profiles')
    return profiles


# fetch a one-based source lead without treating missing pressure as zero
def _lead(values, lead):
    # all requested context leads must exist inside the source horizon
    if lead < 1 or lead > len(values):
        raise ValueError('context source lead outside profile')
    return float(values[lead - 1])


# construct current-pressure changes from complete source windows
def _pressure_features(pressure, lead):
    current = _lead(pressure, lead)
    before3, before6 = _lead(pressure, lead - 3), _lead(pressure, lead - 6)
    after6, decision = _lead(pressure, lead + 6), _lead(pressure, 7)
    window = pressure[lead - 4:lead + 3]
    # a partial seven-hour window has no meaningful physical range
    spread = float(np.max(window) - np.min(window)) if np.isfinite(window).all() else np.nan
    return np.array((current, current - before3, current - before6, after6 - current, spread, current - decision), dtype=np.float64)


# combine current and exact older initialized forecasts at one valid hour
def _cycle_features(initialized, lead, current_rain, profiles):
    previous = []
    means = []
    # use only exact earlier six- and twelve-hour initialized runs
    for lag in (6, 12):
        old_init = initialized - lag
        older = profiles.get(old_init)
        older_lead = lead + lag
        # exclude absent, future or misaligned older cycles
        if older is None or old_init + 8 > initialized + 8 or old_init + older_lead != initialized + lead:
            previous.append(np.nan)
            means.append(np.nan)
            continue
        rain = older['rain']
        previous.append(_lead(rain, older_lead))
        neighborhood = rain[older_lead - 2:older_lead + 1]
        # require all three neighboring older leads for a local mean
        means.append(float(np.mean(neighborhood)) if np.isfinite(neighborhood).all() else np.nan)
    vintages = np.array((current_rain, *previous), dtype=np.float64)
    available = vintages[np.isfinite(vintages)]
    # the verified current forecast always contributes one vintage
    if not len(available):
        raise ValueError('missing current context rain vintage')
    features = np.array((previous[0], previous[1], current_rain - previous[0], current_rain - previous[1], means[0], means[1], float(np.mean(available)), float(np.std(available)), float(np.max(available) - np.min(available)), float(np.mean(available >= .1)), float(np.mean(available >= 1.)), float(len(available))), dtype=np.float64)
    return features, np.isfinite(previous[0]), np.isfinite(previous[1])


# extend only decision-time forecast inputs without reading paired labels
def build_features(data, profiles):
    x = np.asarray(data['x'], dtype=np.float32)
    initialized = np.asarray(data['initialized'])
    horizons = np.asarray(data['lead'])
    hours = np.asarray(data['hour'])
    raw = np.asarray(data['raw'], dtype=np.float32)
    # bind base schema, forecast identities and finite raw amounts
    if x.ndim != 2 or x.shape[1] != len(FEATURE_NAMES) or any(values.shape != (len(x),) for values in (initialized, horizons, hours, raw)) or not all(np.issubdtype(values.dtype, np.integer) for values in (initialized, horizons, hours)) or not np.isin(horizons, np.arange(1, 24)).all() or np.isinf(x).any() or not np.isfinite(raw).all() or (raw < 0).any() or not np.array_equal(x[:, 0], horizons) or not np.array_equal(x[:, FEATURE_NAMES.index('rawRain')], raw):
        raise ValueError('invalid context paired forecast arrays')
    pressure = np.full((len(x), len(PRESSURE_NAMES)), np.nan, dtype=np.float32)
    cycle = np.full((len(x), len(CYCLE_NAMES)), np.nan, dtype=np.float32)
    pressure_available = np.zeros(len(x), dtype=bool)
    prior6_available = np.zeros(len(x), dtype=bool)
    prior12_available = np.zeros(len(x), dtype=bool)
    # materialize each row from current and only strictly earlier run profiles
    for index in range(len(x)):
        init, lead = int(initialized[index]), 8 + int(horizons[index])
        current = profiles.get(init)
        # bind the target valid hour and required current source run
        if current is None or init + lead != int(hours[index]) or any(current[name].shape != (48,) for name in ('rain', 'temperature', 'pressure')):
            raise ValueError('context current profile identity mismatch')
        source_rain = _lead(current['rain'], lead)
        source_temperature = _lead(current['temperature'], lead)
        # compare the exact paired float32 representation of current forecasts
        if not np.isfinite(source_rain) or not np.isfinite(source_temperature) or np.float32(source_rain) != raw[index] or np.float32(source_temperature) != x[index, FEATURE_NAMES.index('rawTemperature')]:
            raise ValueError('context raw amount or temperature differs from source')
        pressure_row = _pressure_features(current['pressure'], lead)
        cycle_row, prior6, prior12 = _cycle_features(init, lead, source_rain, profiles)
        pressure[index] = pressure_row.astype(np.float32)
        cycle[index] = cycle_row.astype(np.float32)
        pressure_available[index] = np.isfinite(pressure_row).all()
        prior6_available[index] = prior6
        prior12_available[index] = prior12
    matrices = {'base': x.copy(), 'pressure': np.concatenate((x, pressure), axis=1), 'cycle': np.concatenate((x, cycle), axis=1), 'full': np.concatenate((x, pressure, cycle), axis=1)}
    availability = {'pressureAvailable': pressure_available, 'prior6Available': prior6_available, 'prior12Available': prior12_available, 'newInformationAvailable': pressure_available & (prior6_available | prior12_available)}
    return matrices, availability
