"""join a retained wind-direction supplement to the original rain runs."""

import datetime as dt
import hashlib
import json
import math
import re
import struct
from collections.abc import Mapping
from pathlib import Path

import numpy as np
from rain_context_features import COHORT

HASH_PATTERN = re.compile(r'[0-9a-f]{64}\Z')
RECEIVED_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z')
HOUR_FORMAT = '%Y-%m-%dT%H:%M:%SZ'
REQUIRED_FIELDS = frozenset((
    'key', 'cohort', 'runInitializedAt', 'validAt', 'targetLeadHours',
    'rawPrecipitationMm', 'rawWindDirectionDegrees', 'responseSha256',
    'responseReceivedAtUtc', 'actualIssueAt', 'directionSourceStatus',
))


# reject duplicate keys even inside optional nested receipt fields
def _unique_pairs(pairs):
    result = {}
    # one normalized field name must identify one value only
    for key, value in pairs:
        # duplicate identity and measurement fields are ambiguous
        if key in result:
            raise ValueError('duplicate wind supplement json key')
        result[key] = value
    return result


# reject lexical and overflow nonfinite json numbers everywhere
def _finite_float(value):
    parsed = float(value)
    # exponent overflow must not hide in an optional field
    if not math.isfinite(parsed):
        raise ValueError('nonfinite wind supplement json')
    return parsed


# parse one utf8 json line without permissive python json extensions
def _strict_row(line):
    # every source line must contain one complete normalized object
    if not line.endswith(b'\n') or line == b'\n':
        raise ValueError('invalid wind supplement jsonl line')
    try:
        row = json.loads(
            line.decode('utf-8'),
            object_pairs_hook=_unique_pairs,
            parse_float=_finite_float,
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite wind supplement json')),
        )
    except (UnicodeError, json.JSONDecodeError) as failure:
        raise ValueError('invalid wind supplement json') from failure
    # arrays and scalar json cannot represent a normalized source row
    if not isinstance(row, dict) or not REQUIRED_FIELDS.issubset(row):
        raise ValueError('invalid wind supplement row schema')
    return row


# require an exact utc hour rather than flooring fractional issue times
def _initialized_hour(value):
    # canonical seconds and utc suffix prevent timezone aliases
    if type(value) is not str:
        raise ValueError('invalid wind run initialization')
    try:
        instant = dt.datetime.strptime(value, HOUR_FORMAT).replace(tzinfo=dt.timezone.utc)
    except ValueError as failure:
        raise ValueError('invalid wind run initialization') from failure
    # reject permissive strptime padding and nonzero minutes or seconds
    if instant.strftime(HOUR_FORMAT) != value or instant.minute or instant.second:
        raise ValueError('invalid wind run initialization')
    return instant, int(instant.timestamp() // 3600)


# require an unambiguous received utc instant while preserving its text
def _received_utc(value):
    # only the producer's canonical zulu timestamp is valid
    if not isinstance(value, str) or RECEIVED_PATTERN.fullmatch(value) is None:
        raise ValueError('invalid wind response receipt time')
    try:
        dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as failure:
        raise ValueError('invalid wind response receipt time') from failure
    return value


# validate the immutable original rain and wind trajectories for one run
def _original_run(initialized, original_context_profiles, original_trajectory_profiles):
    context = original_context_profiles[initialized]
    trajectory = original_trajectory_profiles[initialized]
    # the original source loaders must supply exactly shaped forecast arrays
    if not isinstance(context, Mapping) or not isinstance(trajectory, Mapping) or 'rain' not in context or 'wind' not in trajectory:
        raise ValueError('invalid original wind source profile')
    rain, wind = np.asarray(context['rain']), np.asarray(trajectory['wind'])
    # retain the old float64 values, including explicit missing leads
    if rain.shape != (48,) or wind.shape != (48,) or rain.dtype != np.float64 or wind.dtype != np.float64:
        raise ValueError('invalid original wind source array')
    finite_rain, finite_wind = np.isfinite(rain), np.isfinite(wind)
    # reject infinities or values the original normalized source cannot contain
    if np.isinf(rain).any() or np.isinf(wind).any() or ((rain[finite_rain] < 0.) | (rain[finite_rain] > 2000.)).any() or ((wind[finite_wind] < 0.) | (wind[finite_wind] > 150.)).any():
        raise ValueError('invalid original wind source measurement')
    return rain, wind


# decode one nullable normalized measurement without coercion or clipping
def _measurement(value, maximum):
    # json null remains nan, never a zero forecast
    if value is None:
        return math.nan
    # booleans, strings and out-of-range numbers are not measurements
    if type(value) not in (int, float) or not math.isfinite(value) or not 0. <= value <= maximum:
        raise ValueError('invalid wind supplement measurement')
    return float(value)


# distinguish missing transport, provider nulls and unrequested tail leads
def _direction_statuses(block):
    statuses = [row['directionSourceStatus'] for row in block]
    observed = {'available', 'providerNull'}
    full = all(status in observed for status in statuses)
    short = all(status in observed for status in statuses[:34]) and statuses[34:] == ['notRequested'] * 14
    unresolved = statuses == ['transportUnresolved'] * 48
    # each original run must use one complete declared provenance pattern
    if not (full or short or unresolved):
        raise ValueError('invalid wind direction source status pattern')
    # missingness provenance cannot manufacture a numeric direction or zero
    for row, status in zip(block, statuses, strict=True):
        if (row['rawWindDirectionDegrees'] is not None) != (status == 'available'):
            raise ValueError('wind direction value disagrees with source status')


# bind a complete sorted direction supplement to byte-pinned original runs
def load_profiles(path, expected_sha256, original_context_profiles, original_trajectory_profiles):
    # the caller must supply a frozen content hash and matching original run sets
    if (
        not isinstance(expected_sha256, str) or HASH_PATTERN.fullmatch(expected_sha256) is None
        or not isinstance(original_context_profiles, Mapping)
        or not isinstance(original_trajectory_profiles, Mapping)
        or not original_context_profiles
        or set(original_context_profiles) != set(original_trajectory_profiles)
        or any(type(key) is not int for key in original_context_profiles)
    ):
        raise ValueError('invalid wind supplement source binding')
    profiles = {}
    digest = hashlib.sha256()
    block = []
    previous_initialized = None
    with Path(path).open('rb') as stream:
        # hash the exact consumed bytes while retaining contiguous run blocks
        for line in stream:
            digest.update(line)
            block.append(_strict_row(line))
            # a completed block must represent exactly forty-eight ordered leads
            if len(block) == 48:
                initialized_at = block[0]['runInitializedAt']
                initialized_dt, initialized = _initialized_hour(initialized_at)
                # forbid extra, missing, duplicate or reordered original runs
                if (
                    initialized not in original_context_profiles
                    or initialized in profiles
                    or (previous_initialized is not None and initialized <= previous_initialized)
                ):
                    raise ValueError('invalid wind supplement run order or identity')
                old_rain, old_wind = _original_run(initialized, original_context_profiles, original_trajectory_profiles)
                response_sha = block[0]['responseSha256']
                received = _received_utc(block[0]['responseReceivedAtUtc'])
                # every lead in one response must have the same raw-body identity
                if not isinstance(response_sha, str) or HASH_PATTERN.fullmatch(response_sha) is None:
                    raise ValueError('invalid wind response sha256')
                _direction_statuses(block)
                directions = np.empty(48, dtype=np.float64)
                # require original key, exact utc target, receipt and rain parity
                for lead, row in enumerate(block, 1):
                    expected_key = f'{COHORT}|{initialized_at[:16]}|lead={lead}'
                    expected_valid = (initialized_dt + dt.timedelta(hours=lead)).strftime(HOUR_FORMAT)
                    # no row may borrow another run, lead or response receipt
                    if (
                        row['cohort'] != COHORT or row['key'] != expected_key
                        or row['runInitializedAt'] != initialized_at
                        or type(row['targetLeadHours']) is not int or row['targetLeadHours'] != lead
                        or row['validAt'] != expected_valid
                        or row['responseSha256'] != response_sha
                        or row['responseReceivedAtUtc'] != received
                        or row['actualIssueAt'] is not None
                    ):
                        raise ValueError('invalid wind supplement lead identity')
                    new_rain = _measurement(row['rawPrecipitationMm'], 2000.)
                    original_rain = old_rain[lead - 1]
                    # source nulls and finite rain values must match the original exactly
                    if not (math.isnan(new_rain) and math.isnan(original_rain)) and struct.pack('>d', new_rain) != struct.pack('>d', original_rain):
                        raise ValueError('wind supplement rain differs from original')
                    directions[lead - 1] = _measurement(row['rawWindDirectionDegrees'], 360.)
                profiles[initialized] = {'wind': old_wind, 'direction': directions}
                previous_initialized = initialized
                block = []
    # no partial tail, skipped original run or mutated source bytes may survive
    if block or set(profiles) != set(original_context_profiles) or digest.hexdigest() != expected_sha256:
        raise ValueError('wind supplement source hash or coverage changed')
    return profiles
