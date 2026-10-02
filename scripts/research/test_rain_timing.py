"""lock causal trajectory shifts and fixed timing-family screening on synthetic data."""

import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from rain_timing import CANDIDATES, POLICY, candidate_screens, choose_shift, cohort_metadata, load_profiles, run_shifts, shifted_rows, validate_paired_profiles
from test_rain_event_guard import safe_report


# construct one source profile without reading the retained research archive
def profile(rain=None, temperature=None):
    return (np.zeros(48) if rain is None else np.asarray(rain, dtype=float), np.full(48, 10.) if temperature is None else np.asarray(temperature, dtype=float))


# exercise frozen timing helpers without historical outcome material
class RainTimingTests(unittest.TestCase):
    # earliest and latest past comparisons use source leads one and ten only
    def test_shift_bounds_and_decision_cutoff(self):
        early = np.zeros(48)
        early[:4] = [1., 2., 3., 4.]
        self.assertEqual(choose_shift(early, np.array([1., 2., 3., 4.]))['delta'], -3)
        late = np.zeros(48)
        late[6:10] = [1., 2., 3., 4.]
        self.assertEqual(choose_shift(late, np.array([1., 2., 3., 4.]))['delta'], 3)
        first = np.zeros(50)
        first[4:8] = [1., 2., 3., 4.]
        observations = {'first_hour': np.array(0), 'target': first}
        data = {'initialized': np.array([0])}
        original = run_shifts(data, {0: profile(late)}, observations)
        first[8:] = 99.
        self.assertEqual(original, run_shifts(data, {0: profile(late)}, observations))

    # a complete dry past is supported, unlike any missing observed or source hour
    def test_dry_and_missing_support_are_distinct(self):
        rain = np.zeros(48)
        self.assertEqual(choose_shift(rain, np.zeros(4)), {'delta': 0, 'alignmentSupport': True, 'reason': 'recent_dry'})
        self.assertEqual(choose_shift(rain, np.array([np.nan, 0., 0., 0.]))['reason'], 'missing_past')
        rain[33] = np.nan
        self.assertEqual(choose_shift(rain, np.ones(4))['reason'], 'missing_source')
        self.assertFalse(choose_shift(rain, np.ones(4))['alignmentSupport'])

    # equal errors prefer zero shift before any nonzero direction
    def test_ties_and_material_improvement_guards(self):
        self.assertEqual(choose_shift(np.ones(48), np.full(4, 2.))['reason'], 'no_material_improvement')
        ratio = np.zeros(48)
        ratio[6:10] = .2
        self.assertEqual(choose_shift(ratio, np.ones(4))['reason'], 'no_material_improvement')
        absolute = np.full(48, .085)
        absolute[6:10] = .1
        self.assertEqual(choose_shift(absolute, np.full(4, .1))['reason'], 'no_material_improvement')
        good = np.zeros(48)
        good[6:10] = [1., 2., 3., 4.]
        self.assertEqual(choose_shift(good, np.array([1., 2., 3., 4.]))['reason'], 'shifted')

    # source cohort metadata and all forty-eight profile identities are byte-bound
    def test_source_manifest_hash_and_profile_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'trajectory.jsonl'
            initialized = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
            rows = []
            # emit one normalized synthetic run in strict lead order
            for lead in range(1, 49):
                rows.append({'runInitializedAt': '2025-01-01T00:00:00Z', 'targetLeadHours': lead, 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'rawPrecipitationMm': .1 * lead, 'rawTemperatureC': 10.})
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            cohort = {'path': 'normalized/ecmwf_single_run_hindcast.jsonl', 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'rows': 48, 'successfulRuns': 1}
            self.assertEqual(cohort_metadata({'cohortFiles': {'ecmwf_single_run_hindcast': cohort}}), cohort)
            self.assertEqual(len(load_profiles(path, cohort)), 1)
            with self.assertRaises(ValueError):
                load_profiles(path, {**cohort, 'sha256': '0' * 64})
            with self.assertRaises(ValueError):
                cohort_metadata({'cohortFiles': {'ecmwf_single_run_hindcast': {**cohort, 'path': '../other'}}})

    # unshifted profile precision must exactly match the paired feature scalar
    def test_raw_profile_identity_and_noop_precision(self):
        rain = np.zeros(48)
        rain[8] = .123456789
        data = {'initialized': np.array([0]), 'lead': np.array([1]), 'raw': np.array([np.float32(rain[8])])}
        profiles = {0: profile(rain)}
        validate_paired_profiles(data, profiles)
        choices = {0: {'delta': 0, 'alignmentSupport': True, 'reason': 'no_material_improvement'}}
        result, support, phase, effective = shifted_rows(data, np.array([0]), profiles, choices)
        np.testing.assert_array_equal(result, data['raw'].astype(float))
        self.assertTrue(support[0])
        self.assertFalse(phase[0])
        self.assertFalse(effective[0])
        with self.assertRaises(ValueError):
            validate_paired_profiles({**data, 'raw': np.array([.9], dtype=np.float32)}, profiles)

    # cold shifted source keeps exact paired raw and aligned-run support
    def test_phase_fallback_and_effective_change(self):
        rain = np.zeros(48)
        rain[8:10] = [.1, .2]
        rain[11:13] = [1.00000001, 2.00000001]
        temperature = np.full(48, 10.)
        temperature[11] = 2.
        data = {'initialized': np.array([0, 0]), 'lead': np.array([1, 2]), 'raw': np.array([.1, .2], dtype=np.float32)}
        profiles = {0: profile(rain, temperature)}
        validate_paired_profiles(data, profiles)
        choices = {0: {'delta': 3, 'alignmentSupport': True, 'reason': 'shifted'}}
        result, support, phase, effective = shifted_rows(data, np.array([0, 1]), profiles, choices)
        np.testing.assert_array_equal(result, [float(np.float32(.1)), float(np.float32(2.00000001))])
        np.testing.assert_array_equal(support, [True, True])
        np.testing.assert_array_equal(phase, [True, False])
        np.testing.assert_array_equal(effective, [False, True])

    # the same-window scalar includes unsupported exact-raw rows in its final map
    def test_timing_scalar_uses_final_projection(self):
        from rain_search import calibrate
        actual = np.array([2., 2.])
        hours = np.array([0, 24])
        raw = np.array([1., 2.])
        shifted = np.array([1., 8.])
        support = np.array([True, False])
        result = calibrate(actual, hours, lambda scale: np.where(support, np.clip(shifted * scale, 0, 30), raw))
        self.assertAlmostEqual(result['scale'], 2.)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(POLICY['calibrationScaleBounds'], [.1, 3.])

    # all old measured gates plus same-window and mechanism controls remain mandatory
    def test_screen_requires_effective_timing_contribution(self):
        report = safe_report()
        # adapt safe synthetic arm metrics to the two fixed timing candidates
        for name in CANDIDATES:
            report['overall'][name] = copy.deepcopy(report['overall']['eventGuard'])
            report['events'][name] = copy.deepcopy(report['events']['eventGuard'])
            for values in report['bySeason'].values():
                values[name] = copy.deepcopy(values['eventGuard'])
            for values in report['byLeadBand'].values():
                values[name] = copy.deepcopy(values['eventGuard'])
            for values in report['accumulations'].values():
                values['candidates'][name] = copy.deepcopy(values['candidates']['eventGuard'])
        report['overall']['volume90'] = {**report['overall']['raw'], 'mae': .9}
        report['overall']['supportedVolume90'] = {**report['overall']['raw'], 'mae': .9}
        report['invariants'] = {'finiteNonnegative': True}
        report['mechanismSupport'] = {'rows': 20, 'hours': 20, 'dates': 20, 'wetDates': 20, 'wetHours': 20}
        data = {'actual': np.ones(365), 'hour': np.arange(365) * 24}
        indices = np.arange(365)
        flags = {name: np.ones(365, dtype=bool) for name in CANDIDATES}
        screens, selected = candidate_screens(report, data, indices, flags)
        self.assertTrue(all(screen['passed'] for screen in screens.values()))
        self.assertEqual(selected, 'timingOnly')
        self.assertEqual(len(screens['timingOnly']['gates']), 46)
        report['mechanismSupport']['dates'] = 19
        screens, selected = candidate_screens(report, data, indices, flags)
        self.assertFalse(screens['timingOnly']['gates']['timingContribution'])
        self.assertIsNone(selected)
        report['mechanismSupport']['dates'] = 20
        report['overall']['timingOnly']['mae'] = .9
        screens, selected = candidate_screens(report, data, indices, flags)
        self.assertFalse(screens['timingOnly']['gates']['timingContribution'])
        self.assertEqual(selected, 'timingVolume90')
        report['overall']['timingOnly']['mae'] = .8
        report['overall']['supportedVolume90']['mae'] = .8
        screens, selected = candidate_screens(report, data, indices, flags)
        self.assertFalse(screens['timingOnly']['gates']['timingContribution'])
        self.assertIsNone(selected)


# permit direct synthetic validation without private source access
if __name__ == '__main__':
    unittest.main()
