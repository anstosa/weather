"""lock causal pressure and prior-cycle features using synthetic profiles only."""

import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import rain_context_features as context
from rain_sub24 import FEATURE_NAMES


# build one complete forecast-only profile with source lead as pressure offset
def profile(rain=None, temperature=None, pressure=None):
    return {
        'rain': np.zeros(48, dtype=np.float64) if rain is None else np.asarray(rain, dtype=np.float64),
        'temperature': np.full(48, 10., dtype=np.float64) if temperature is None else np.asarray(temperature, dtype=np.float64),
        'pressure': 1000. + np.arange(1, 49, dtype=np.float64) if pressure is None else np.asarray(pressure, dtype=np.float64),
    }


# contain a valid base feature vector but no accessible outcomes
def paired(initialized, horizons, rains, temperatures=None):
    initialized = np.asarray(initialized, dtype=np.int64)
    horizons = np.asarray(horizons, dtype=np.int64)
    rains = np.asarray(rains, dtype=np.float32)
    temperatures = np.full(len(rains), 10., dtype=np.float32) if temperatures is None else np.asarray(temperatures, dtype=np.float32)
    x = np.zeros((len(rains), len(FEATURE_NAMES)), dtype=np.float32)
    x[:, 0] = horizons
    x[:, FEATURE_NAMES.index('rawRain')] = rains
    x[:, FEATURE_NAMES.index('rawTemperature')] = temperatures
    return {'x': x, 'initialized': initialized, 'lead': horizons, 'hour': initialized + 8 + horizons, 'raw': rains}


# reject any attempted read of historical target columns
class PoisonMapping(dict):
    # make label access fail even if a caller adds a new fallback branch
    def __getitem__(self, key):
        # only forecast identities and original features are permitted
        if key in ('actual', 'mean', 'persistence'):
            raise AssertionError('context helper accessed a target')
        return super().__getitem__(key)


# verify only synthetic source and paired forecast identities
class RainContextFeaturesTests(unittest.TestCase):
    # fixed feature-set order preserves the entire original base vector
    def test_feature_sets_and_boundary_leads(self):
        current = profile()
        current['rain'][8] = .5
        current['rain'][30] = .25
        old6 = profile()
        old12 = profile()
        old6['rain'][14] = 1.
        old6['rain'][36] = 1.5
        old12['rain'][20] = 2.
        old12['rain'][42] = 2.5
        data = paired([100, 100], [1, 23], [.5, .25])
        matrices, available = context.build_features(data, {100: current, 94: old6, 88: old12})
        self.assertEqual([len(names) for names in context.FEATURE_SETS.values()], [77, 83, 89, 95])
        self.assertEqual(context.FEATURE_SETS['full'][:77], tuple(FEATURE_NAMES))
        np.testing.assert_array_equal(matrices['base'], data['x'])
        # p[L] is one-based, with a complete seven-lead local range
        np.testing.assert_array_equal(matrices['pressure'][0, 77:], [1009., 3., 6., 6., 6., 2.])
        np.testing.assert_array_equal(matrices['pressure'][1, 77:], [1031., 3., 6., 6., 6., 24.])
        cycle = matrices['cycle'][:, 77:]
        np.testing.assert_array_equal(cycle[:, :4], [[1., 2., -.5, -1.5], [1.5, 2.5, -1.25, -2.25]])
        np.testing.assert_allclose(cycle[:, 4:6], [[1. / 3, 2. / 3], [.5, 2.5 / 3]])
        self.assertAlmostEqual(float(cycle[0, 6]), (3.5 / 3), places=6)
        self.assertAlmostEqual(float(cycle[0, 7]), float(np.std([.5, 1., 2.])), places=6)
        np.testing.assert_allclose(cycle[:, 8:], [[1.5, 1., 2. / 3, 3.], [2.25, 1., 2. / 3, 3.]])
        self.assertTrue(all(values.dtype == np.float32 for values in matrices.values()))
        self.assertTrue(all(values.dtype == bool and values.all() for values in available.values()))

    # missing older cycles remain nan while current-only vintage statistics survive
    def test_missing_and_future_cycles_do_not_supply_prior_information(self):
        current = profile()
        current['rain'][8] = .2
        future = profile()
        future['rain'][2] = 99.
        data = paired([100], [1], [.2])
        matrices, available = context.build_features(data, {100: current, 106: future})
        cycle = matrices['cycle'][0, 77:]
        self.assertTrue(np.isnan(cycle[:6]).all())
        np.testing.assert_allclose(cycle[6:], [.2, 0., 0., 1., 0., 1.])
        self.assertTrue(available['pressureAvailable'][0])
        self.assertFalse(available['prior6Available'][0])
        self.assertFalse(available['prior12Available'][0])
        self.assertFalse(available['newInformationAvailable'][0])

    # prior source lead is current lead plus the exact initialization lag
    def test_prior_rain_requires_same_valid_hour_and_mean_support(self):
        current, prior = profile(), profile()
        current['rain'][8] = .5
        prior['rain'][14] = 2.
        prior['rain'][13] = np.nan
        data = paired([100], [1], [.5])
        matrices, available = context.build_features(data, {100: current, 94: prior})
        cycle = matrices['cycle'][0, 77:]
        self.assertEqual(cycle[0], 2.)
        self.assertEqual(cycle[2], -1.5)
        self.assertTrue(np.isnan(cycle[4]))
        self.assertTrue(available['prior6Available'][0])
        self.assertFalse(available['prior12Available'][0])
        self.assertTrue(available['newInformationAvailable'][0])

    # any missing pressure member invalidates complete-window availability
    def test_pressure_windows_retain_partial_information(self):
        current = profile()
        current['rain'][8] = .1
        current['pressure'][11] = np.nan
        data = paired([100], [1], [.1])
        matrices, available = context.build_features(data, {100: current})
        pressure = matrices['pressure'][0, 77:]
        np.testing.assert_array_equal(pressure[[0, 1, 2, 3, 5]], [1009., 3., 6., 6., 2.])
        self.assertTrue(np.isnan(pressure[4]))
        self.assertFalse(available['pressureAvailable'][0])
        self.assertFalse(available['newInformationAvailable'][0])

    # paired raw amount, temperature and valid-hour identities are immutable
    def test_current_profile_identity_validation(self):
        current = profile()
        current['rain'][8] = .123456789
        data = paired([100], [1], [np.float32(.123456789)])
        context.build_features(data, {100: current})
        # each independent identity mismatch must fail before feature output
        for altered in ({**data, 'raw': np.array([.3], dtype=np.float32)}, {**data, 'hour': np.array([110])}, {**data, 'x': data['x'].copy()}):
            if altered['x'] is not data['x']:
                altered['x'][0, FEATURE_NAMES.index('rawTemperature')] = 12.
            with self.subTest(altered=tuple(altered)), self.assertRaises(ValueError):
                context.build_features(altered, {100: current})

    # no target, mean or persistence column may enter feature construction
    def test_poisoned_outcomes_are_never_read(self):
        current = profile()
        current['rain'][8] = .2
        data = PoisonMapping(paired([100], [1], [.2]))
        data.update({'actual': object(), 'mean': object(), 'persistence': object()})
        context.build_features(data, {100: current})

    # synthetic normalized profile bytes are checked before row parsing
    def test_manifest_hash_and_source_identity(self):
        initialized = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
        rows = []
        # construct the strict original forty-eight-lead row shape
        for lead in range(1, 49):
            rows.append({'cohort': context.COHORT, 'runInitializedAt': '2025-01-01T00:00:00Z', 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'targetLeadHours': lead, 'rawPrecipitationMm': .1, 'rawTemperatureC': 10., 'rawPressureHpa': 1000.})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'trajectory.jsonl'
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            cohort = {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'sha256': digest, 'bytes': path.stat().st_size, 'rows': 48, 'successfulRuns': 1}
            with patch.object(context, 'ORIGINAL_SHA256', digest):
                self.assertEqual(context.cohort_metadata({'cohortFiles': {context.COHORT: cohort}}), cohort)
                self.assertEqual(len(context.load_profiles(path, cohort)), 1)
                with self.assertRaises(ValueError):
                    context.cohort_metadata({'cohortFiles': {context.COHORT: {**cohort, 'rows': 47}}})
                with self.assertRaises(ValueError):
                    context.load_profiles(path, {**cohort, 'sha256': '0' * 64})
                rows[0]['targetLeadHours'] = 2
                path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
                changed = {**cohort, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
                with patch.object(context, 'ORIGINAL_SHA256', changed['sha256']), self.assertRaises(ValueError):
                    context.load_profiles(path, changed)


# permit only synthetic standalone validation
if __name__ == '__main__':
    unittest.main()
