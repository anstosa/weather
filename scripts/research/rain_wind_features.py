"""append same-run wind vectors to the fixed rain trajectory features."""

import math
from collections.abc import Mapping

import numpy as np
from rain_sub24 import FEATURE_NAMES as BASE_NAMES
from rain_trajectory_features import FEATURE_NAMES as TRAJECTORY_NAMES

WIND_FEATURE_NAMES = (
    'windU', 'windV',
    'windUChange3h', 'windVChange3h',
    'windUNext3hChange', 'windVNext3hChange',
)
FEATURE_NAMES = TRAJECTORY_NAMES + WIND_FEATURE_NAMES
RAW_WIND_INDEX = BASE_NAMES.index('rawWind')


# validate one complete issued wind profile without filling missing measurements
def _checked_profile(profile):
    # require both fields from the same initialized forecast run
    if not isinstance(profile, Mapping) or set(profile) != {'wind', 'direction'}:
        raise ValueError('invalid wind profile schema')
    checked = {}
    # preserve explicit nan while rejecting invalid physical measurements
    for name, maximum in (('wind', 150.), ('direction', 360.)):
        values = np.asarray(profile[name])
        # require exactly forty-eight numeric source leads
        if values.shape != (48,) or values.dtype.kind not in 'fiu':
            raise ValueError('invalid wind profile shape')
        values = values.astype(np.float64, copy=False)
        finite = np.isfinite(values)
        # reject infinities and values outside the forecast field bounds
        if np.isinf(values).any() or ((values[finite] < 0.) | (values[finite] > maximum)).any():
            raise ValueError('invalid wind measurement')
        checked[name] = values
    return checked


# compute meteorological wind-from direction as eastward and northward flow
def _components(wind, direction):
    # a missing direction stays missing even when the reported speed is calm
    if not math.isfinite(wind) or not math.isfinite(direction):
        return math.nan, math.nan
    radians = math.radians(direction % 360.)
    return -wind * math.sin(radians), -wind * math.cos(radians)


# append six same-initialization vectors and tendencies without touching labels
def build_features(data, full101, profiles):
    full101 = np.asarray(full101)
    initialized = np.asarray(data['initialized'])
    horizons = np.asarray(data['lead'])
    hours = np.asarray(data['hour'])
    # preserve exact trajectory rows, order and dtype before adding columns
    if (
        full101.ndim != 2 or full101.dtype != np.float32
        or full101.shape[1] != len(TRAJECTORY_NAMES)
        or any(values.shape != (len(full101),) for values in (initialized, horizons, hours))
        or not all(np.issubdtype(values.dtype, np.integer) for values in (initialized, horizons, hours))
        or not np.isin(horizons, np.arange(1, 24)).all()
        or np.isinf(full101).any()
        or not np.array_equal(full101[:, 0], horizons)
        or not isinstance(profiles, Mapping)
    ):
        raise ValueError('invalid wind paired feature arrays')
    vectors = np.full((len(full101), len(WIND_FEATURE_NAMES)), np.nan, dtype=np.float32)
    available = np.zeros(len(full101), dtype=bool)
    checked = {}
    # use only the forecast run already initialized for this paired row
    for index in range(len(full101)):
        init = int(initialized[index])
        lead = 8 + int(horizons[index])
        # the issued lead must target the identical valid utc hour
        if init + lead != int(hours[index]):
            raise ValueError('wind valid-hour identity mismatch')
        # never substitute a later or nearby run for an absent original run
        if init not in profiles:
            raise ValueError('missing original wind run')
        # validate each run once while retaining nullable lead values
        if init not in checked:
            checked[init] = _checked_profile(profiles[init])
        profile = checked[init]
        current_wind = profile['wind'][lead - 1]
        paired_wind = full101[index, RAW_WIND_INDEX]
        # bind the wind speed to the original paired source at float32 precision
        if not (np.isnan(current_wind) and np.isnan(paired_wind)) and np.float32(current_wind) != paired_wind:
            raise ValueError('wind current source differs from paired feature')
        # measure past, current and next lead from this one issued profile
        past = _components(profile['wind'][lead - 4], profile['direction'][lead - 4])
        current = _components(current_wind, profile['direction'][lead - 1])
        future = _components(profile['wind'][lead + 2], profile['direction'][lead + 2])
        values = (
            current[0], current[1],
            current[0] - past[0], current[1] - past[1],
            future[0] - current[0], future[1] - current[1],
        )
        # cast once after float64 trigonometry and differences
        vectors[index] = np.asarray(values, dtype=np.float32)
        available[index] = np.isfinite(values).all()
    return np.concatenate((full101, vectors), axis=1), {'windVectorAvailable': available}
