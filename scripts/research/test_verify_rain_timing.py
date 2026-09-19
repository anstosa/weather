"""check the independent timing verifier on synthetic source profiles."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from rain_timing import POLICY
from verify_rain_timing import (
    check_shift_audit,
    choose_shift,
    hour,
    load_profiles,
    paired_source,
    shifted_rows,
    timing_screens,
)


# keep all tests independent of private historical targets
class RainTimingVerificationTests(unittest.TestCase):
    # prefer the unique material improvement among seven fixed shifts
    def test_choose_shift_uses_only_four_past_hours(self):
        forecast = np.zeros(48)
        forecast[[4, 6]] = 1.
        result = choose_shift(forecast, np.array([1., 0., 1., 0.]))
        self.assertEqual(result, {'delta': 1, 'alignmentSupport': True, 'reason': 'shifted'})

    # keep dry, missing-source and missing-past states separate
    def test_choose_shift_support_and_fallback_reasons(self):
        forecast = np.zeros(48)
        self.assertEqual(choose_shift(forecast, np.zeros(4))['reason'], 'recent_dry')
        self.assertTrue(choose_shift(forecast, np.zeros(4))['alignmentSupport'])
        self.assertEqual(choose_shift(forecast, np.array([np.nan, 0., 0., 0.]))['reason'], 'missing_past')
        forecast[20] = np.nan
        self.assertEqual(choose_shift(forecast, np.array([1., 0., 0., 0.]))['reason'], 'missing_source')

    # preserve exact paired raw for zero shifts and cold phase fallbacks
    def test_shifted_rows_tracks_effective_and_phase_fallback(self):
        rain = np.zeros(48)
        temperature = np.full(48, 4.)
        rain[8], rain[9], rain[10] = 0., 1., 2.
        temperature[10] = 1.
        data = {'raw': np.array([0., 1.]), 'initialized': np.array([0, 0]), 'lead': np.array([1, 2])}
        profiles = {0: (rain, temperature)}
        shifted, supported, phase, effective = shifted_rows(data, np.array([0, 1]), profiles, {0: {'delta': 1, 'alignmentSupport': True}})
        np.testing.assert_array_equal(shifted, [1., 1.])
        np.testing.assert_array_equal(supported, [True, True])
        np.testing.assert_array_equal(phase, [False, True])
        np.testing.assert_array_equal(effective, [True, False])
        original, _, _, effective = shifted_rows(data, np.array([0, 1]), profiles, {0: {'delta': 0, 'alignmentSupport': True}})
        np.testing.assert_array_equal(original, data['raw'])
        self.assertFalse(effective.any())

    # only a float32-visible source change may count as effective
    def test_effective_shift_uses_paired_precision(self):
        rain = np.zeros(48)
        rain[8], rain[9] = 1., 1.00000001
        data = {'raw': np.array([1.]), 'initialized': np.array([0]), 'lead': np.array([1])}
        shifted, supported, phase, effective = shifted_rows(data, np.array([0]), {0: (rain, np.full(48, 5.))}, {0: {'delta': 1, 'alignmentSupport': True}})
        np.testing.assert_array_equal(shifted, [1.])
        self.assertTrue(supported[0])
        self.assertFalse(phase[0])
        self.assertFalse(effective[0])

    # verify paired forecast rain and temperature against source lead identity
    def test_paired_source_checks_both_forecast_fields(self):
        rain = np.zeros(48)
        temperature = np.full(48, 5.)
        rain[8] = .3
        data = {'initialized': np.array([0]), 'lead': np.array([1]), 'raw': np.array([np.float32(.3)]), 'x': np.array([[np.float32(5.)]])}
        paired_source(data, {0: (rain, temperature)}, ['rawTemperature'])
        temperature[8] = 4.
        with self.assertRaisesRegex(ValueError, 'temperature'):
            paired_source(data, {0: (rain, temperature)}, ['rawTemperature'])

    # reject shuffled or missing source leads within every normalized run
    def test_profiles_require_all_48_source_leads(self):
        initialized = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
        rows = [{'runInitializedAt': initialized.isoformat().replace('+00:00', 'Z'), 'targetLeadHours': lead, 'validAt': (initialized + dt.timedelta(hours=lead)).isoformat().replace('+00:00', 'Z'), 'rawPrecipitationMm': 0., 'rawTemperatureC': 5.} for lead in range(1, 49)]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'trajectory.jsonl'
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            profiles = load_profiles(path, {'rows': 48, 'successfulRuns': 1})
            self.assertEqual(len(profiles), 1)
            rows[5]['targetLeadHours'] = 99
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            with self.assertRaisesRegex(ValueError, 'lead identity'):
                load_profiles(path, {'rows': 48, 'successfulRuns': 1})

    # audit must include every paired run and its evaluated phase fallbacks
    def test_shift_audit_rejects_changed_decision(self):
        choices = {0: {'delta': 1, 'alignmentSupport': True, 'reason': 'shifted'}, 24: {'delta': 0, 'alignmentSupport': True, 'reason': 'recent_dry'}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'shift-audit.jsonl'
            rows = [{'initializedHour': init, **choice, 'phaseFallbackRows': int(init == 0)} for init, choice in sorted(choices.items())]
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            self.assertEqual(len(check_shift_audit(path, choices, {0: 1, 24: 0})), 64)
            rows[0]['delta'] = 2
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            with self.assertRaisesRegex(ValueError, 'shiftAudit'):
                check_shift_audit(path, choices, {0: 1, 24: 0})

    # require a genuine trajectory contribution beyond both scalar controls
    def test_timing_screens_append_mechanism_gate(self):
        raw = {'mae': 1., 'rmse': 1., 'wetMae': 1., 'heavyMae': 1., 'volumeRatio': 1., 'dates': 365, 'wetDates': 120, 'heavyHours': 60, 'pod': .8, 'csi': .4, 'far': .2}
        candidate = {**raw, 'mae': .9, 'rmse': .9, 'wetMae': .9, 'heavyMae': 1.04}
        event = {str(threshold): {'pod': .8, 'csi': .4, 'far': .2} for threshold in (.1, 1., 2.5)}
        names = POLICY['candidates']
        report = {'overall': {'raw': raw, 'persistence': {'mae': 1.1}, 'volumeScale': {'mae': .95}, 'volume90': {'mae': .95}, 'supportedVolume90': {'mae': .96}, **{name: candidate for name in names}}, 'bySeason': {season: {'raw': raw, **{name: candidate for name in names}} for season in ('DJF', 'MAM', 'JJA', 'SON')}, 'byLeadBand': {band: {'raw': raw, **{name: candidate for name in names}} for band in ('1-6', '7-12', '13-23')}, 'events': {'raw': event, **{name: event for name in names}}, 'accumulations': {str(length): {'runs': 1, 'candidates': {'raw': {'mae': 1.}, **{name: {'mae': .9} for name in names}}} for length in (6, 12, 23)}, 'invariants': {'finiteNonnegative': True}, 'mechanismSupport': {'dates': 20}}
        data = {'actual': np.ones(200), 'hour': np.arange(200) * 24}
        flags = {name: np.ones(200, dtype=bool) for name in names}
        screens, selected = timing_screens(report, data, np.arange(200), flags)
        self.assertEqual(selected, 'timingOnly')
        self.assertTrue(all(result['passed'] and len(result['gates']) == 46 for result in screens.values()))
        report['mechanismSupport']['dates'] = 19
        screens, selected = timing_screens(report, data, np.arange(200), flags)
        self.assertIsNone(selected)
        self.assertTrue(all(not result['gates']['timingContribution'] for result in screens.values()))
        report['mechanismSupport']['dates'] = 20
        report['overall']['supportedVolume90']['mae'] = .89
        screens, selected = timing_screens(report, data, np.arange(200), flags)
        self.assertIsNone(selected)

    # distinguish an exact utc source hour from an ambiguous local time
    def test_hour_requires_utc_aware_exact_hour(self):
        self.assertEqual(hour('2025-01-01T00:00:00Z'), 482136)
        with self.assertRaisesRegex(ValueError, 'invalid'):
            hour('2025-01-01T00:30:00Z')
        with self.assertRaisesRegex(ValueError, 'invalid'):
            hour('2025-01-01T00:00:00')


# run synthetic-only verifier checks
if __name__ == '__main__':
    unittest.main()
