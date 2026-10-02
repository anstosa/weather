"""test independent pressure and earlier-cycle context verification."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from rain_context import POLICY
from rain_sub24 import FEATURE_NAMES
from verify_rain_context import (
    build_features,
    candidate_screens,
    cycle_features,
    feature_sets,
    finite_difference,
    hour,
    load_profiles,
    pressure_features,
    prior_profile,
)


# keep context tests synthetic and separate from historical labels
class RainContextVerificationTests(unittest.TestCase):
    # prove complete 77/83/89/95 feature orders without producer builder calls
    def test_feature_sets_have_explicit_extension_order(self):
        sets = feature_sets(list(FEATURE_NAMES))
        self.assertEqual(sets, POLICY['featureSets'])
        self.assertEqual({name: len(values) for name, values in sets.items()}, {'base': 77, 'pressure': 83, 'cycle': 89, 'full': 95})

    # pressure change and strict seven-hour range use one source run
    def test_pressure_features_recompute_all_six_values(self):
        pressure = np.arange(1001., 1049.)
        np.testing.assert_array_equal(pressure_features(pressure, 9), [1009., 3., 6., 6., 6., 2.])
        pressure[5] = np.nan
        result = pressure_features(pressure, 9)
        self.assertTrue(np.isnan(result[4]))
        self.assertTrue(np.isnan(result[1]))
        self.assertTrue(np.isnan(finite_difference(np.nan, 1.)))

    # older cycles must align at one valid hour, with strict centered means
    def test_cycle_features_use_only_prior_six_and_twelve_hour_runs(self):
        current = {'rain': np.zeros(48), 'temperature': np.full(48, 5.), 'pressure': np.full(48, 1000.)}
        previous6 = {name: values.copy() for name, values in current.items()}
        previous12 = {name: values.copy() for name, values in current.items()}
        current['rain'][8] = 2.0000001
        previous6['rain'][13:16] = [3., 4., 5.]
        previous12['rain'][19:22] = [5., 6., 7.]
        profiles = {100: current, 94: previous6, 88: previous12}
        result, prior6, prior12 = cycle_features(profiles, 100, 9, current['rain'][8])
        self.assertTrue(prior6 and prior12)
        self.assertEqual(result[0], 4.)
        self.assertEqual(result[1], 6.)
        self.assertEqual(result[4], 4.)
        self.assertEqual(result[5], 6.)
        self.assertAlmostEqual(result[6], (2.0000001 + 4 + 6) / 3)
        self.assertEqual(result[8], 6 - 2.0000001)
        self.assertEqual(result[11], 3.)
        self.assertEqual(prior_profile(profiles, 100, 9, 6)[0], 4.)

    # a missing prior does not become a fabricated dry forecast
    def test_missing_prior_still_counts_current_vintage(self):
        values, available6, available12 = cycle_features({}, 100, 9, 2.)
        self.assertFalse(available6 or available12)
        self.assertTrue(np.isnan(values[:6]).all())
        np.testing.assert_array_equal(values[6:], [2., 0., 0., 1., 1., 1.])

    # bind source rain and temperature to the original paired columns
    def test_build_features_matches_source_and_preserves_original_rows(self):
        base = np.zeros((1, len(FEATURE_NAMES)), dtype=np.float32)
        base[0, 0] = 1.
        base[0, FEATURE_NAMES.index('rawTemperature')] = 5.
        base[0, FEATURE_NAMES.index('rawRain')] = 2.
        current = {'rain': np.zeros(48), 'temperature': np.full(48, 5.), 'pressure': np.arange(1001., 1049.)}
        current['rain'][8] = 2.0000001
        previous6 = {'rain': np.zeros(48), 'temperature': np.full(48, 5.), 'pressure': np.full(48, 1000.)}
        previous12 = {'rain': np.zeros(48), 'temperature': np.full(48, 5.), 'pressure': np.full(48, 1000.)}
        previous6['rain'][13:16] = [3., 4., 5.]
        previous12['rain'][19:22] = [5., 6., 7.]
        data = {'x': base, 'initialized': np.array([100]), 'lead': np.array([1]), 'hour': np.array([109]), 'raw': np.array([2.], dtype=np.float32)}
        matrices, availability = build_features(data, {100: current, 94: previous6, 88: previous12}, list(FEATURE_NAMES))
        np.testing.assert_array_equal(matrices['base'], base)
        self.assertEqual(matrices['full'].shape, (1, 95))
        np.testing.assert_array_equal(matrices['full'][0, 77:83], [1009., 3., 6., 6., 6., 2.])
        self.assertEqual(matrices['full'][0, 83], 4.)
        self.assertEqual(matrices['full'][0, 84], 6.)
        self.assertEqual(matrices['full'][0, 94], 3.)
        self.assertTrue(all(mask[0] for mask in availability.values()))
        current['pressure'][5] = np.nan
        _, missing = build_features(data, {100: current, 94: previous6, 88: previous12}, list(FEATURE_NAMES))
        self.assertFalse(missing['pressureAvailable'][0])
        self.assertFalse(missing['newInformationAvailable'][0])

    # reject a source value that contradicts the frozen paired raw forecast
    def test_build_features_rejects_raw_identity_change(self):
        x = np.zeros((1, len(FEATURE_NAMES)), dtype=np.float32)
        x[0, 0] = 1.
        x[0, FEATURE_NAMES.index('rawTemperature')] = 5.
        profile = {'rain': np.ones(48), 'temperature': np.full(48, 5.), 'pressure': np.full(48, 1000.)}
        data = {'x': x, 'initialized': np.array([100]), 'lead': np.array([1]), 'hour': np.array([109]), 'raw': np.array([0.], dtype=np.float32)}
        with self.assertRaisesRegex(ValueError, 'raw differs'):
            build_features(data, {100: profile}, list(FEATURE_NAMES))

    # a feature computation must not even request the observed target key
    def test_build_features_cannot_read_poisoned_target(self):
        # fail immediately if an observed label is requested
        class ForecastOnly(dict):
            # keep target access visibly prohibited
            def __getitem__(self, key):
                if key == 'actual':
                    raise AssertionError('feature builder read target')
                return super().__getitem__(key)

        x = np.zeros((1, len(FEATURE_NAMES)), dtype=np.float32)
        x[0, 0] = 1.
        x[0, FEATURE_NAMES.index('rawTemperature')] = 5.
        profile = {'rain': np.zeros(48), 'temperature': np.full(48, 5.), 'pressure': np.full(48, 1000.)}
        data = ForecastOnly({'x': x, 'initialized': np.array([100]), 'lead': np.array([1]), 'hour': np.array([109]), 'raw': np.array([0.], dtype=np.float32)})
        matrix, _ = build_features(data, {100: profile}, list(FEATURE_NAMES))
        self.assertEqual(matrix['full'].shape, (1, 95))

    # enforce all 48 normalized leads rather than dropping malformed source rows
    def test_profile_parser_rejects_changed_lead_identity(self):
        initialized = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
        rows = [{'runInitializedAt': initialized.isoformat().replace('+00:00', 'Z'), 'targetLeadHours': lead, 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'rawPrecipitationMm': 0., 'rawTemperatureC': 5., 'rawPressureHpa': 1000.} for lead in range(1, 49)]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'trajectory.jsonl'
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            self.assertEqual(len(load_profiles(path, {'rows': 48, 'successfulRuns': 1})), 1)
            rows[7]['targetLeadHours'] = 99
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            with self.assertRaisesRegex(ValueError, 'lead identity'):
                load_profiles(path, {'rows': 48, 'successfulRuns': 1})

    # strict new-information coverage and same-family benefit are not optional
    def test_candidate_screens_add_three_gates(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        event = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in (.1, 1., 2.5)}
        names = ('weightedContext', 'ordinalContext')
        report = {'overall': {'raw': raw, 'volumeScale': {'mae': .95}, 'volume90': {'mae': .95}, 'persistence': {'mae': 1.1}, 'weightedBase': {'mae': .95}, 'ordinalBase': {'mae': .95}, **{name: candidate for name in names}}, 'bySeason': {season: {'raw': raw, **{name: candidate for name in names}} for season in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {band: {'raw': raw, **{name: candidate for name in names}} for band in ('1-6', '7-12', '13-23')}, 'events': {'raw': event, **{name: event for name in names}}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1.}, **{name: {'mae': .9} for name in names}}} for length in (6, 12, 23)}, 'invariants': {'finiteNonnegative': True}}
        data = {'actual': np.ones(400), 'hour': np.arange(400) * 24}
        indices = np.arange(400)
        flags = {name: np.ones(400, dtype=bool) for name in names}
        availability = {'newInformationAvailable': np.ones(400, dtype=bool)}
        screens, chosen = candidate_screens(report, data, indices, flags, availability)
        self.assertEqual(chosen, 'ordinalContext')
        self.assertTrue(all(value['passed'] and len(value['gates']) == 47 for value in screens.values()))
        availability['newInformationAvailable'][:21] = False
        screens, chosen = candidate_screens(report, data, indices, flags, availability)
        self.assertIsNone(chosen)
        self.assertTrue(all(not value['gates']['newInformationCoverage'] for value in screens.values()))
        availability['newInformationAvailable'][:] = True
        report['overall']['ordinalBase']['mae'] = .89
        screens, chosen = candidate_screens(report, data, indices, flags, availability)
        self.assertEqual(chosen, 'weightedContext')

    # timezone-naive and fractional source hours must not enter chronology
    def test_hour_requires_exact_timezone_aware_hour(self):
        self.assertEqual(hour('2025-01-01T00:00:00Z'), 482136)
        with self.assertRaisesRegex(ValueError, 'invalid'):
            hour('2025-01-01T00:30:00Z')
        with self.assertRaisesRegex(ValueError, 'invalid'):
            hour('2025-01-01T00:00:00')


# run synthetic-only checks
if __name__ == '__main__':
    unittest.main()
