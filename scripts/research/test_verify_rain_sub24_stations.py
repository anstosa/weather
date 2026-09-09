"""verify physical station lineage and reported rain interval reconstruction."""

import copy
import json
import unittest

from verify_rain_sub24_stations import verify_batch

# construct an independently readable one-minute provider response

def fixture():
    station = {'locationId': 66270, 'deviceId': 123, 'serial': 'synthetic', 'timezone': 'America/Los_Angeles'}
    observation = [1710288000, 0, 0, 0, 0, 3, 1000, 10, 90, 0, 0, 0, .2, 0, 0, 0, 2.7, 1, 0, 0, 0, 0]
    raw = {'type': 'obs_st', 'device_id': 123, 'status': {'status_code': 0}, 'obs': [observation]}
    row = {'validAt': '2024-03-13T00:00:00.000Z', 'receivedAt': '2026-09-09T00:00:00.000Z', 'sourceId': 'research-tempest-66270', 'sourceKind': 'physical_sensor', 'productRunAt': None, 'metadata': {'provider': {'device_id': 123, 'location_id': 66270, 'report_interval_minutes': 1}, 'device': {'serial': 'synthetic'}, 'upstreamTimezone': 'America/Los_Angeles'}, 'metrics': {'precipitationMm': .2, 'precipitationRateMmPerHour': 12, 'temperatureC': 10}}
    return station, raw, {'records': [row]}


# reject believable normalized values that differ from retained original bytes
class StationVerificationTests(unittest.TestCase):
    # preserve exact accumulated amounts and derived hourly rate
    def test_raw_interval_reconstruction(self):
        station, raw, batch = fixture()
        self.assertEqual(verify_batch(batch, json.dumps(raw).encode(), station, '2024-03-13'), 1)

    # a second physical device cannot count as the selected gauge
    def test_rejects_device_substitution(self):
        station, raw, batch = fixture()
        batch['records'][0]['metadata']['provider']['device_id'] = 124
        with self.assertRaisesRegex(ValueError, 'physical rain gauge'):
            verify_batch(batch, json.dumps(raw).encode(), station, '2024-03-13')

    # changing retained interval rain is detected even when it is physically plausible
    def test_rejects_amount_mutation(self):
        station, raw, batch = fixture()
        batch['records'][0]['metrics']['precipitationMm'] = .3
        with self.assertRaisesRegex(ValueError, 'normalization changed'):
            verify_batch(batch, json.dumps(raw).encode(), station, '2024-03-13')

    # duplicated endpoints and wrong dates cannot increase station coverage
    def test_rejects_duplicate_and_out_of_window(self):
        station, raw, batch = fixture()
        batch['records'].append(copy.deepcopy(batch['records'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate or out-of-day'):
            verify_batch(batch, json.dumps(raw).encode(), station, '2024-03-13')
        station, raw, batch = fixture()
        with self.assertRaisesRegex(ValueError, 'duplicate or out-of-day'):
            verify_batch(batch, json.dumps(raw).encode(), station, '2024-03-14')


# execute synthetic fixtures without provider traffic
if __name__ == '__main__':
    unittest.main()
