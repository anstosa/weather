"""lock wind-vector feature provenance without reading rain outcomes."""

import math
import unittest

import numpy as np
import rain_wind_features as wind_features


# construct one complete synthetic wind-speed and direction profile
def profile(speed=10., direction=90.):
    return {
        'wind': np.full(48, speed, dtype=np.float64),
        'direction': np.full(48, direction, dtype=np.float64),
    }


# bind trajectory rows to source wind at the original float32 precision
def paired(initialized, horizons, profiles):
    initialized = np.asarray(initialized, dtype=np.int64)
    horizons = np.asarray(horizons, dtype=np.int64)
    full101 = np.zeros((len(horizons), 101), dtype=np.float32)
    full101[:, 0] = horizons
    # copy only the already issued current-run wind speed into its base slot
    for index, (init, horizon) in enumerate(zip(initialized, horizons)):
        source = profiles.get(int(init))
        # leave an absent run unfilled for fail-closed tests
        if source is not None:
            full101[index, wind_features.RAW_WIND_INDEX] = np.float32(source['wind'][8 + int(horizon) - 1])
    data = {'initialized': initialized, 'lead': horizons, 'hour': initialized + 8 + horizons}
    return data, full101


# reject any outcome read by the feature-only helper
class PoisonMapping(dict):
    # permit only forecast identity arrays
    def __getitem__(self, key):
        # targets and observation controls are not wind features
        if key in ('actual', 'mean', 'persistence'):
            raise AssertionError('wind helper read an outcome')
        return super().__getitem__(key)


# exercise issued vectors, boundaries, nulls and fail-closed identities
class RainWindFeaturesTests(unittest.TestCase):
    # cardinal meteorological directions give eastward and northward flow
    def test_cardinal_vectors_and_three_sixty_equals_zero(self):
        directions = [0., 90., 180., 270., 360.]
        profiles = {100 + 100 * index: profile(direction=direction) for index, direction in enumerate(directions)}
        data, full101 = paired(list(profiles), [1] * len(profiles), profiles)
        extended, availability = wind_features.build_features(data, full101, profiles)
        self.assertEqual(extended.shape, (5, 107))
        self.assertEqual(extended.dtype, np.float32)
        self.assertEqual(extended[:, :101].tobytes(), full101.tobytes())
        self.assertEqual(wind_features.FEATURE_NAMES[:101], wind_features.TRAJECTORY_NAMES)
        self.assertEqual(wind_features.FEATURE_NAMES[101:], wind_features.WIND_FEATURE_NAMES)
        np.testing.assert_allclose(extended[:, 101:103], [[0., -10.], [-10., 0.], [0., 10.], [10., 0.], [0., -10.]], atol=1e-6)
        np.testing.assert_allclose(extended[:, 103:], 0., atol=1e-6)
        self.assertEqual(extended[0, 101:103].tobytes(), extended[4, 101:103].tobytes())
        np.testing.assert_array_equal(availability['windVectorAvailable'], [True] * 5)
        self.assertEqual(availability['windVectorAvailable'].dtype, bool)

    # source indices L-3, L and L+3 remain inside the same original run
    def test_directional_tendencies_boundary_leads_and_no_future_run(self):
        current = profile()
        current['direction'][5] = 0.
        current['direction'][11] = 180.
        current['direction'][27] = 0.
        current['direction'][33] = 180.
        profiles = {100: current, 106: profile(speed=100., direction=270.)}
        data, full101 = paired([100, 100], [1, 23], profiles)
        extended, availability = wind_features.build_features(data, full101, profiles)
        np.testing.assert_allclose(extended[:, 101:], [[-10., 0., -10., 10., 10., 10.]] * 2, atol=1e-6)
        np.testing.assert_array_equal(availability['windVectorAvailable'], [True, True])
        self.assertEqual(extended[:, :101].tobytes(), full101.tobytes())
        self.assertEqual(len(extended), len(data['lead']))

    # a single missing input invalidates only dependent vectors and support
    def test_missing_speed_direction_and_calm_direction_stay_nan(self):
        source = profile(speed=0., direction=90.)
        source['direction'][8] = np.nan
        source['wind'][9] = np.nan
        source['direction'][13] = np.nan
        profiles = {100: source}
        data, full101 = paired([100, 100, 100], [1, 2, 3], profiles)
        extended, availability = wind_features.build_features(data, full101, profiles)
        self.assertTrue(np.isnan(extended[0, 101:]).all())
        self.assertTrue(np.isnan(extended[1, 101:]).all())
        self.assertTrue(np.isnan(extended[2, 105:]).all())
        np.testing.assert_array_equal(availability['windVectorAvailable'], [False, False, False])
        self.assertEqual(extended[:, :101].tobytes(), full101.tobytes())

    # missing neighboring leads do not contaminate the observed current vector
    def test_missing_past_and_next_leads_propagate_to_tendencies(self):
        source = profile()
        source['direction'][5] = np.nan
        source['wind'][11] = np.nan
        data, full101 = paired([100], [1], {100: source})
        extended, availability = wind_features.build_features(data, full101, {100: source})
        np.testing.assert_allclose(extended[0, 101:103], [-10., 0.], atol=1e-6)
        self.assertTrue(np.isnan(extended[0, 103:]).all())
        np.testing.assert_array_equal(availability['windVectorAvailable'], [False])

    # trigonometry and differences must use source float64 until final storage
    def test_float64_math_cast_once_and_float32_speed_identity(self):
        source = profile(speed=116.09363332734594, direction=157.99623831073885)
        profiles = {100: source}
        data, full101 = paired([100], [1], profiles)
        extended, availability = wind_features.build_features(data, full101, profiles)
        expected_u = np.float32(-source['wind'][8] * math.sin(math.radians(source['direction'][8] % 360.)))
        premature_u = np.float32(-float(np.float32(source['wind'][8])) * math.sin(math.radians(float(np.float32(source['direction'][8])) % 360.)))
        self.assertEqual(extended[0, 101], expected_u)
        self.assertNotEqual(extended[0, 101], premature_u)
        np.testing.assert_array_equal(availability['windVectorAvailable'], [True])
        mismatched = full101.copy()
        mismatched[0, wind_features.RAW_WIND_INDEX] += 1.
        with self.assertRaises(ValueError):
            wind_features.build_features(data, mismatched, profiles)

    # absent original run may not borrow a later initialized profile
    def test_missing_original_run_and_hour_identity_fail_closed(self):
        current = profile()
        data, full101 = paired([100], [1], {100: current})
        with self.assertRaisesRegex(ValueError, 'missing original wind run'):
            wind_features.build_features(data, full101, {106: profile()})
        with self.assertRaisesRegex(ValueError, 'valid-hour identity'):
            wind_features.build_features({**data, 'hour': np.array([110])}, full101, {100: current})
        guarded = PoisonMapping(data)
        guarded.update({'actual': object(), 'mean': object(), 'persistence': object()})
        wind_features.build_features(guarded, full101, {100: current})

    # wrong matrix, lead and profile schema must not become silent row drops
    def test_invalid_matrix_lead_and_profile_values_rejected(self):
        current = profile()
        data, full101 = paired([100], [1], {100: current})
        bad_matrices = [full101[:, :-1], full101.astype(np.float64), np.array([[np.inf] * 101], dtype=np.float32)]
        # reject each malformed matrix before accessing forecast values
        for matrix in bad_matrices:
            with self.subTest(matrix=matrix.shape, dtype=matrix.dtype), self.assertRaises(ValueError):
                wind_features.build_features(data, matrix, {100: current})
        bad_horizons = [{**data, 'lead': np.array([24])}, {**data, 'lead': np.array([1.])}]
        # accept only integer paired leads one through twenty-three
        for altered in bad_horizons:
            with self.subTest(lead=altered['lead']), self.assertRaises(ValueError):
                wind_features.build_features(altered, full101, {100: current})
        malformed = [
            {'wind': current['wind'][:-1], 'direction': current['direction']},
            {'wind': current['wind'], 'direction': np.full(48, 361.)},
            {'wind': current['wind'], 'direction': np.full(48, -1.)},
            {'wind': np.full(48, 151.), 'direction': current['direction']},
            {'wind': np.full(48, -1.), 'direction': current['direction']},
            {'wind': current['wind'], 'direction': np.full(48, np.inf)},
            {'wind': np.full(48, np.inf), 'direction': current['direction']},
            {'wind': current['wind'], 'direction': np.full(48, '90')},
            {'wind': current['wind']},
        ]
        # reject bad source measurements rather than clipping or imputing
        for index, source in enumerate(malformed):
            with self.subTest(profile=index), self.assertRaises(ValueError):
                wind_features.build_features(data, full101, {100: source})
        missing_current = profile()
        missing_current['wind'][8] = np.nan
        with self.assertRaises(ValueError):
            wind_features.build_features(data, full101, {100: missing_current})


# run synthetic feature tests without source or outcome access
if __name__ == '__main__':
    unittest.main()
