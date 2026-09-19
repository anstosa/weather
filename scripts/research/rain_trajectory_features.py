"""extend fixed rain context with same-run moisture trajectory tendencies."""

import hashlib
import json
from pathlib import Path

import numpy as np
import rain_context_features as context
from rain_sub24 import FEATURE_NAMES as BASE_NAMES
from rain_sub24 import hour_number

COHORT = context.COHORT
ORIGINAL_SHA256 = context.ORIGINAL_SHA256
TENDENCY_NAMES = (
    'relativeHumidityChange3h', 'relativeHumidityNext3hChange',
    'cloudCoverChange3h', 'cloudCoverNext3hChange',
    'windSpeedChange3h', 'windSpeedNext3hChange',
)
FEATURE_NAMES = context.FEATURE_SETS['full'] + TENDENCY_NAMES
SOURCE_FIELDS = (
    ('humidity', 'rawRelativeHumidityPercent', 'rawHumidity', 0., 100.),
    ('cloud', 'rawCloudCoverPercent', 'rawCloud', 0., 100.),
    ('wind', 'rawWindSpeedMps', 'rawWind', 0., 150.),
)


# reuse the pinned original-source hash and complete-run identity validation
def load_profiles(path, cohort):
    path = Path(path)
    validated_runs = set(context.load_profiles(path, cohort))
    profiles = {}
    digest = hashlib.sha256()
    rows = 0
    block = []
    with path.open('rb') as stream:
        # parse only the three additional issued forecast fields
        for line in stream:
            digest.update(line)
            block.append(json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))))
            rows += 1
            # retain the source's exact contiguous forty-eight-lead blocks
            if len(block) == 48:
                initialized = hour_number(block[0]['runInitializedAt'])
                # the independently validated source must contain this run
                if initialized not in validated_runs or initialized in profiles:
                    raise ValueError('invalid trajectory source run')
                # each issued lead must retain all three nullable source fields
                if any(field not in item for item in block for _, field, _, _, _ in SOURCE_FIELDS):
                    raise ValueError('missing trajectory source field')
                profiles[initialized] = {
                    name: np.array([context._measurement(item, field, minimum, maximum) for item in block], dtype=np.float64)
                    for name, field, _, minimum, maximum in SOURCE_FIELDS
                }
                block = []
    # prohibit source mutation between provenance validation and extraction
    if block or rows != cohort['rows'] or set(profiles) != validated_runs or digest.hexdigest() != context.ORIGINAL_SHA256:
        raise ValueError('trajectory source identity changed')
    return profiles


# reject malformed externally supplied profiles without discarding source nulls
def _checked_profile(profile):
    # require exactly the three same-run forecast trajectories
    if not isinstance(profile, dict) or set(profile) != {field[0] for field in SOURCE_FIELDS}:
        raise ValueError('invalid trajectory profile schema')
    checked = {}
    # bind all forty-eight source leads and their physical bounds
    for name, _, _, minimum, maximum in SOURCE_FIELDS:
        values = np.asarray(profile[name])
        # reject nonnumeric and out-of-domain source measurements
        if values.shape != (48,) or values.dtype.kind not in 'fiu':
            raise ValueError('invalid trajectory profile shape')
        values = values.astype(np.float64, copy=False)
        finite = np.isfinite(values)
        # preserve only explicit nan as missing data
        if np.isinf(values).any() or ((values[finite] < minimum) | (values[finite] > maximum)).any():
            raise ValueError('invalid trajectory measurement')
        checked[name] = values
    return checked


# add six differences from one issued forty-eight-lead profile only
def build_features(data, full95, profiles):
    full95 = np.asarray(full95)
    initialized = np.asarray(data['initialized'])
    horizons = np.asarray(data['lead'])
    hours = np.asarray(data['hour'])
    # keep the incoming context matrix byte-identical and aligned to paired rows
    if full95.ndim != 2 or full95.dtype != np.float32 or full95.shape[1] != len(context.FEATURE_SETS['full']) or any(values.shape != (len(full95),) for values in (initialized, horizons, hours)) or not all(np.issubdtype(values.dtype, np.integer) for values in (initialized, horizons, hours)) or not np.isin(horizons, np.arange(1, 24)).all() or np.isinf(full95).any() or not np.array_equal(full95[:, 0], horizons):
        raise ValueError('invalid trajectory paired feature arrays')
    tendencies = np.full((len(full95), len(TENDENCY_NAMES)), np.nan, dtype=np.float32)
    available = np.zeros(len(full95), dtype=bool)
    checked = {}
    # use only the forecast run already initialized for this paired row
    for index in range(len(full95)):
        init = int(initialized[index])
        lead = 8 + int(horizons[index])
        # the source lead must target the identical valid utc hour
        if init + lead != int(hours[index]):
            raise ValueError('trajectory valid-hour identity mismatch')
        profile = profiles.get(init)
        # absent original run leaves all six tendencies missing
        if profile is None:
            continue
        # validate each current profile once even when it supplies many rows
        if init not in checked:
            checked[init] = _checked_profile(profile)
        profile = checked[init]
        values = []
        # compute both three-hour differences at source float64 precision
        for name, _, paired_name, _, _ in SOURCE_FIELDS:
            source = profile[name]
            current = source[lead - 1]
            paired = full95[index, BASE_NAMES.index(paired_name)]
            # reject a paired forecast that differs at original float32 precision
            if not (np.isnan(current) and np.isnan(paired)) and np.float32(current) != paired:
                raise ValueError('trajectory current source differs from paired feature')
            values.extend((current - source[lead - 4], source[lead + 2] - current))
        tendencies[index] = np.asarray(values, dtype=np.float32)
        available[index] = np.isfinite(values).all()
    extended = np.concatenate((full95, tendencies), axis=1)
    return extended, {'tendencyAvailable': available}
