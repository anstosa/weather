"""exercise independent initialization, units, scope and interval checks."""

import json
import unittest

from test_acquire_moisture_runs import response_bytes, valid_response
from verify_rain_sub24_forecasts import population, reconstruct


# use synthetic raw provider shapes without contacting the provider
class VerificationTests(unittest.TestCase):
    # enumerate two full years independently of acquisition helpers
    def test_independent_population(self):
        rows = population()
        self.assertEqual(len(rows), 3604)
        self.assertEqual(len({row['key'] for row in rows}), 3604)
        self.assertEqual(rows[-1]['run'], '2026-08-31T18:00')

    # hourly rain at source index nine maps to decision-plus-one
    def test_independent_reconstruction(self):
        body = valid_response()
        body['hourly']['precipitation'][9] = 1.25
        rows, nulls = reconstruct(response_bytes(body), population()[0])
        self.assertEqual(len(rows), 48)
        self.assertEqual(rows[8]['rawPrecipitationMm'], 1.25)
        self.assertEqual(rows[8]['validAt'], '2024-03-14T09:00:00Z')
        self.assertEqual(nulls['precipitation'], 0)
        self.assertIsNone(rows[8]['actualIssueAt'])

    # reject shifted timestamps rather than accepting plausible rainfall values
    def test_rejects_shifted_intervals(self):
        body = valid_response()
        body['hourly']['time'][9] = '2024-03-14T08:00'
        with self.assertRaisesRegex(ValueError, 'timestamp shift'):
            reconstruct(response_bytes(body), population()[0])

    # reject malformed numbers and changed units independently
    def test_rejects_invalid_values(self):
        body = valid_response()
        body['hourly']['precipitation'][1] = float('nan')
        with self.assertRaisesRegex(ValueError, 'nonfinite'):
            reconstruct(json.dumps(body).encode(), population()[0])
        body = valid_response()
        body['hourly_units']['precipitation'] = 'inch'
        with self.assertRaisesRegex(ValueError, 'units'):
            reconstruct(response_bytes(body), population()[0])


# execute only local fixtures
if __name__ == '__main__':
    unittest.main()
