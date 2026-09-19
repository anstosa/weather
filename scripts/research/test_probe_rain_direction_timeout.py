"""lock the three-query diagnostic without contacting the public provider."""

import copy
import datetime as dt
import unittest

import probe_rain_direction_timeout as probe


# build one exact thirty-five-hour source response from synthetic forecasts
def fixture(variables='precipitation,wind_direction_10m'):
    run = probe.QUERIES[0][0]
    origin = dt.datetime.fromisoformat(run).replace(tzinfo=dt.timezone.utc)
    hourly = {'time': [(origin + dt.timedelta(hours=lead)).strftime('%Y-%m-%dT%H:%M') for lead in range(35)], 'wind_direction_10m': [180.] * 35}
    # include the rain control only when this exact query requests it
    if 'precipitation' in variables:
        hourly['precipitation'] = [None] + [0.1] * 34
    body = {'latitude': 47.9, 'longitude': -122.4, 'elevation': 28., 'timezone': 'GMT', 'utc_offset_seconds': 0, 'hourly_units': {name: probe.source.UNITS[name] for name in hourly}, 'hourly': hourly}
    original = {'grid': {'latitude': 47.9, 'longitude': -122.4}, 'rain': (0.1,) * 48}
    return run, body, original


# reject invented evidence while preserving explicit missing directions
class TimeoutProbeTests(unittest.TestCase):
    # exact scope changes only requested duration and variable isolation
    def test_fixed_scope(self):
        self.assertEqual(len(probe.QUERIES), 3)
        self.assertEqual(probe.POLICY['maximumHttpRequests'], 3)
        self.assertEqual(probe.POLICY['retries'], 0)
        self.assertEqual(dict(probe.parameters(*probe.QUERIES[0]))['forecast_hours'], '35')
        self.assertEqual(dict(probe.parameters(*probe.QUERIES[1]))['hourly'], 'wind_direction_10m')
        self.assertFalse(probe.POLICY['modelGatesEvaluated'])

    # both-variable responses prove only the thirty-four requested rain leads
    def test_partial_horizon_parity(self):
        run, body, original = fixture()
        checked = probe.check_body(probe.source.canonical_json(body), run, probe.QUERIES[0][1], original)
        self.assertEqual(checked['matchedOriginalRainLeads'], 34)
        self.assertEqual(checked['requiredNonNullDirectionHours'], 29)
        self.assertEqual(checked['sourceTailLeadsNotRequested'], list(range(35, 49)))
        self.assertFalse(checked['modelSourceEligible'])

    # direction-only cannot claim that original precipitation was compared
    def test_direction_only_missing_value(self):
        run, body, original = fixture('wind_direction_10m')
        body['hourly']['wind_direction_10m'][10] = None
        checked = probe.check_body(probe.source.canonical_json(body), run, 'wind_direction_10m', original)
        self.assertEqual(checked['matchedOriginalRainLeads'], 0)
        self.assertEqual(checked['requiredNonNullDirectionHours'], 28)

    # invalid streaming responses, changed grid or changed rain never pass
    def test_response_drift_and_timeout_rejected(self):
        run, body, original = fixture()
        with self.assertRaises(ValueError):
            probe.check_body(b'Unexpected error while streaming data: timeoutReached', run, probe.QUERIES[0][1], original)
        # independently mutate each source identity and value boundary
        for kind in ('grid', 'rain', 'time', 'direction', 'length', 'units'):
            changed = copy.deepcopy(body)
            # each single-field mutation must invalidate the diagnostic response
            if kind == 'grid':
                changed['latitude'] = 47.8
            elif kind == 'rain':
                changed['hourly']['precipitation'][34] = 0.2
            elif kind == 'time':
                changed['hourly']['time'][1] = changed['hourly']['time'][0]
            elif kind == 'direction':
                changed['hourly']['wind_direction_10m'][0] = 361
            elif kind == 'length':
                changed['hourly']['wind_direction_10m'].append(180)
            else:
                changed['hourly_units']['wind_direction_10m'] = 'radians'
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                probe.check_body(probe.source.canonical_json(changed), run, probe.QUERIES[0][1], original)


# run only source-free local regression fixtures
if __name__ == '__main__':
    unittest.main()
