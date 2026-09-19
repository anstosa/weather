"""lock same-run forecast tendencies without historical outcome access."""

import datetime as dt
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rain_context_features as context
import rain_trajectory_features as trajectory
from rain_sub24 import FEATURE_NAMES as BASE_NAMES


# construct three valid issued trajectories with distinct lead slopes
def profile():
    leads = np.arange(1, 49, dtype=np.float64)
    return {'humidity': 10. + leads, 'cloud': 2. * leads, 'wind': .5 * leads}


# bind a paired full-context matrix without making outcomes available
def paired(initialized, horizons, profiles):
    initialized = np.asarray(initialized, dtype=np.int64)
    horizons = np.asarray(horizons, dtype=np.int64)
    x = np.zeros((len(horizons), len(context.FEATURE_SETS['full'])), dtype=np.float32)
    x[:, 0] = horizons
    # reproduce original source covariates at float32 storage precision
    for index, (init, horizon) in enumerate(zip(initialized, horizons)):
        current = profiles.get(int(init))
        # missing source runs cannot provide original covariate identities
        if current is None:
            continue
        lead = 8 + int(horizon)
        # preserve nullable values in the original base feature slots
        for name, paired_name in (('humidity', 'rawHumidity'), ('cloud', 'rawCloud'), ('wind', 'rawWind')):
            x[index, BASE_NAMES.index(paired_name)] = np.float32(current[name][lead - 1])
    data = {'initialized': initialized, 'lead': horizons, 'hour': initialized + 8 + horizons}
    return data, x


# fail if construction ever reads a target or future observation column
class PoisonMapping(dict):
    # permit only the three forecast identity arrays
    def __getitem__(self, key):
        # outcome names never belong in trajectory feature construction
        if key in ('actual', 'mean', 'persistence'):
            raise AssertionError('trajectory helper read an outcome')
        return super().__getitem__(key)


# test only synthetic trajectories and source fixtures
class RainTrajectoryFeaturesTests(unittest.TestCase):
    # boundary source leads use only the already issued current run
    def test_feature_order_boundary_leads_and_preissued_future(self):
        current = profile()
        data, full95 = paired([100, 100], [1, 23], {100: current})
        future_run = {name: np.full(48, 99. if name != 'wind' else 50.) for name in current}
        extended, availability = trajectory.build_features(data, full95, {100: current, 106: future_run})
        self.assertEqual(len(trajectory.FEATURE_NAMES), 101)
        self.assertEqual(trajectory.FEATURE_NAMES[:95], context.FEATURE_SETS['full'])
        self.assertEqual(trajectory.FEATURE_NAMES[95:], trajectory.TENDENCY_NAMES)
        self.assertEqual(extended.dtype, np.float32)
        self.assertEqual(extended.shape, (2, 101))
        self.assertEqual(extended[:, :95].tobytes(), full95.tobytes())
        np.testing.assert_array_equal(extended[:, 95:], [[3., 3., 6., 6., 1.5, 1.5]] * 2)
        np.testing.assert_array_equal(availability['tendencyAvailable'], [True, True])
        self.assertEqual(availability['tendencyAvailable'].dtype, bool)

    # one missing lead invalidates only its difference and whole-row support
    def test_missing_lead_and_missing_current_run_remain_nan(self):
        current = profile()
        current['humidity'][5] = np.nan  # source L-3 for horizon one
        data, full95 = paired([100, 200], [1, 1], {100: current})
        extended, availability = trajectory.build_features(data, full95, {100: current, 206: profile()})
        self.assertTrue(np.isnan(extended[0, 95]))
        np.testing.assert_array_equal(extended[0, 96:], [3., 6., 6., 1.5, 1.5])
        self.assertTrue(np.isnan(extended[1, 95:]).all())
        np.testing.assert_array_equal(availability['tendencyAvailable'], [False, False])
        self.assertEqual(extended[:, :95].tobytes(), full95.tobytes())

    # current missing source and paired values agree only when both are nan
    def test_current_null_and_float32_source_identity(self):
        current = profile()
        current['humidity'][8] = np.nan
        data, full95 = paired([100], [1], {100: current})
        extended, availability = trajectory.build_features(data, full95, {100: current})
        self.assertTrue(np.isnan(extended[0, 95:97]).all())
        self.assertFalse(availability['tendencyAvailable'][0])
        full95[0, BASE_NAMES.index('rawHumidity')] = 20.
        with self.assertRaises(ValueError):
            trajectory.build_features(data, full95, {100: current})
        current['humidity'][8] = 19.123456789
        full95[0, BASE_NAMES.index('rawHumidity')] = np.float32(19.123456789)
        trajectory.build_features(data, full95, {100: current})

    # malformed source shapes, ranges and paired hour identities fail closed
    def test_invalid_source_or_paired_schema(self):
        current = profile()
        data, full95 = paired([100], [1], {100: current})
        bad = [
            ({**data, 'hour': np.array([110])}, full95, {100: current}),
            ({**data, 'lead': np.array([24])}, full95, {100: current}),
            (data, full95[:, :-1], {100: current}),
            (data, full95.astype(np.float64), {100: current}),
            (data, full95, {100: {**current, 'wind': current['wind'][:-1]}}),
            (data, full95, {100: {**current, 'cloud': np.full(48, 101.)}}),
            (data, full95, {100: {**current, 'humidity': np.full(48, np.inf)}}),
        ]
        # reject each independent violation without reading an outcome
        for altered_data, altered_x, altered_profiles in bad:
            with self.subTest(shape=altered_x.shape, hour=altered_data['hour']), self.assertRaises(ValueError):
                trajectory.build_features(altered_data, altered_x, altered_profiles)
        mismatched = full95.copy()
        mismatched[0, BASE_NAMES.index('rawCloud')] += 1.
        with self.assertRaises(ValueError):
            trajectory.build_features(data, mismatched, {100: current})

    # evaluation labels and contemporaneous observations are never accessed
    def test_no_label_read(self):
        current = profile()
        data, full95 = paired([100], [1], {100: current})
        guarded = PoisonMapping(data)
        guarded.update({'actual': object(), 'mean': object(), 'persistence': object()})
        trajectory.build_features(guarded, full95, {100: current})

    # original source hash, lead identities and physical ranges stay pinned
    def test_load_profiles_source_hash_identity_and_ranges(self):
        initialized = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
        rows = []
        # create exactly one complete source run with all original fields
        for lead in range(1, 49):
            rows.append({'cohort': context.COHORT, 'runInitializedAt': '2025-01-01T00:00:00Z', 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'targetLeadHours': lead, 'rawPrecipitationMm': .1, 'rawTemperatureC': 10., 'rawPressureHpa': 1000., 'rawRelativeHumidityPercent': 50. + lead / 10, 'rawCloudCoverPercent': 30., 'rawWindSpeedMps': 2.})

        # derive a synthetic pinned hash without changing production constants
        def write(path):
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            return {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size, 'rows': 48, 'successfulRuns': 1}

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'trajectory.jsonl'
            cohort = write(path)
            with patch.object(context, 'ORIGINAL_SHA256', cohort['sha256']):
                profiles = trajectory.load_profiles(path, cohort)
                self.assertEqual(len(profiles), 1)
                np.testing.assert_allclose(next(iter(profiles.values()))['humidity'][:2], [50.1, 50.2])
                with self.assertRaises(ValueError):
                    trajectory.load_profiles(path, {**cohort, 'sha256': '0' * 64})
            rows[0]['rawCloudCoverPercent'] = 101.
            changed = write(path)
            with patch.object(context, 'ORIGINAL_SHA256', changed['sha256']), self.assertRaises(ValueError):
                trajectory.load_profiles(path, changed)
            rows[0]['rawCloudCoverPercent'] = 30.
            rows[0]['rawWindSpeedMps'] = None
            changed = write(path)
            with patch.object(context, 'ORIGINAL_SHA256', changed['sha256']):
                self.assertTrue(np.isnan(next(iter(trajectory.load_profiles(path, changed).values()))['wind'][0]))
            del rows[0]['rawWindSpeedMps']
            changed = write(path)
            with patch.object(context, 'ORIGINAL_SHA256', changed['sha256']), self.assertRaises(ValueError):
                trajectory.load_profiles(path, changed)
            rows[0]['rawWindSpeedMps'] = 2.
            rows[0]['targetLeadHours'] = 2
            changed = write(path)
            with patch.object(context, 'ORIGINAL_SHA256', changed['sha256']), self.assertRaises(ValueError):
                trajectory.load_profiles(path, changed)


# permit only standalone synthetic source validation
if __name__ == '__main__':
    unittest.main()
