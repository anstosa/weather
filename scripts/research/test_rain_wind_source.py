"""lock strict direction-source joins against synthetic original runs."""

import copy
import datetime as dt
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rain_wind_source as source


# derive the exact original normalized key from a source run and lead
def key(initialized_at, lead):
    return f'{source.COHORT}|{initialized_at[:16]}|lead={lead}'


# construct two complete original runs with one real source null
def fixture():
    starts = (
        dt.datetime(2024, 3, 14, 0, tzinfo=dt.timezone.utc),
        dt.datetime(2024, 3, 14, 6, tzinfo=dt.timezone.utc),
    )
    context, trajectory, rows = {}, {}, []
    # retain separate rain, wind and direction source representations
    for run_index, start in enumerate(starts):
        initialized = int(start.timestamp() // 3600)
        rain = np.array([lead / 10 + run_index for lead in range(1, 49)], dtype=np.float64)
        wind = np.array([lead / 20 + run_index for lead in range(1, 49)], dtype=np.float64)
        # preserve an old missing rain lead as json null
        if run_index == 0:
            rain[8] = np.nan
        context[initialized] = {'rain': rain}
        trajectory[initialized] = {'wind': wind}
        start_text = start.strftime(source.HOUR_FORMAT)
        # bind each new source lead to the exact old key, valid hour and rain
        for lead in range(1, 49):
            direction = None if run_index == 0 and lead == 9 else float((lead * 7) % 360)
            rows.append({
                'key': key(start_text, lead),
                'cohort': source.COHORT,
                'runInitializedAt': start_text,
                'validAt': (start + dt.timedelta(hours=lead)).strftime(source.HOUR_FORMAT),
                'targetLeadHours': lead,
                'rawPrecipitationMm': float(rain[lead - 1]) if np.isfinite(rain[lead - 1]) else None,
                'rawWindDirectionDegrees': direction,
                'directionSourceStatus': 'available' if direction is not None else 'providerNull',
                'responseSha256': ('a' if run_index == 0 else 'b') * 64,
                'responseReceivedAtUtc': ('2026-09-13T07:01:02.123456Z' if run_index == 0 else '2026-09-13T07:01:04Z'),
                'actualIssueAt': None,
                'returnedGrid': {'latitude': 47.97891, 'longitude': -122.44185},
            })
    rows[-1]['rawWindDirectionDegrees'] = 360.
    return context, trajectory, rows


# write the exact bytes passed to a hash-bound normalized loader
def write_rows(path, rows):
    body = ''.join(json.dumps(row, sort_keys=True, allow_nan=False) + '\n' for row in rows).encode()
    path.write_bytes(body)
    return hashlib.sha256(body).hexdigest()


# exercise source integrity, chronology, receipts, nulls and exact joins
class RainWindSourceTests(unittest.TestCase):
    # isolate each synthetic jsonl artifact from real retained source bytes
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'direction.jsonl'
        self.context, self.trajectory, self.rows = fixture()

    # dispatch changed source bytes with their own hash to test semantics
    def reject_rows(self, rows):
        digest = write_rows(self.path, rows)
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, digest, self.context, self.trajectory)

    # thirty-five-hour retrieval preserves every row without inventing its tail
    def test_unrequested_tail_and_unresolved_transport_remain_distinct(self):
        rows = copy.deepcopy(self.rows)
        # only the fourteen unrequested tail leads lose their direction values
        for row in rows[34:48]:
            row['rawWindDirectionDegrees'] = None
            row['directionSourceStatus'] = 'notRequested'
        # a separately qualified unresolved run is explicitly unknown at every lead
        for row in rows[48:]:
            row['rawWindDirectionDegrees'] = None
            row['directionSourceStatus'] = 'transportUnresolved'
        digest = write_rows(self.path, rows)
        result = source.load_profiles(self.path, digest, self.context, self.trajectory)
        first, second = sorted(result)
        self.assertTrue(np.isnan(result[first]['direction'][34:]).all())
        self.assertTrue(np.isnan(result[second]['direction']).all())
        self.assertEqual(len(result), 2)
        # unresolved transport is never a zero direction or mixed provider-null run
        for index, field, value in ((48, 'rawWindDirectionDegrees', 0.), (48, 'directionSourceStatus', 'providerNull'), (0, 'directionSourceStatus', 'notRequested')):
            altered = copy.deepcopy(rows)
            altered[index][field] = value
            with self.subTest(field=field, value=value):
                self.reject_rows(altered)

    # all original runs and nullable direction fields survive the exact join
    def test_complete_original_join_and_nulls(self):
        digest = write_rows(self.path, self.rows)
        profiles = source.load_profiles(self.path, digest, self.context, self.trajectory)
        self.assertEqual(set(profiles), set(self.context))
        first, second = sorted(profiles)
        self.assertIs(profiles[first]['wind'], self.trajectory[first]['wind'])
        self.assertTrue(np.isnan(profiles[first]['direction'][8]))
        self.assertEqual(profiles[second]['direction'][-1], 360.)
        self.assertEqual(profiles[first]['direction'].dtype, np.float64)
        self.assertEqual(profiles[first]['direction'].shape, (48,))

    # missing, extra, duplicate and out-of-order runs must not be substituted
    def test_run_coverage_order_and_complete_blocks(self):
        start = self.rows[:48]
        finish = self.rows[48:]
        variants = [start, finish + start, start + finish + start, self.rows[:-1], self.rows[:47] + self.rows[48:]]
        # reject each coverage or chronology failure under its own content hash
        for index, rows in enumerate(variants):
            with self.subTest(variant=index):
                self.reject_rows(rows)
        unknown = copy.deepcopy(finish)
        # an inserted run not in the original fixed cohort is extra data
        for row in unknown:
            row['runInitializedAt'] = '2024-03-14T12:00:00Z'
        self.reject_rows(self.rows + unknown)

    # source hash and matching original profile maps are required separately
    def test_exact_bytes_hash_and_original_run_maps(self):
        digest = write_rows(self.path, self.rows)
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, '0' * 64, self.context, self.trajectory)
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, digest.upper(), self.context, self.trajectory)
        first = min(self.context)
        reduced = {first: self.trajectory[first]}
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, digest, self.context, reduced)
        malformed = {**self.trajectory, first: {'wind': self.trajectory[first]['wind'][:-1]}}
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, digest, self.context, malformed)

    # cohort, key, lead, utc target and actual issue status are immutable joins
    def test_per_lead_identity_rejects_aliases(self):
        changes = [
            ('cohort', 'other'),
            ('key', 'other|lead=1'),
            ('targetLeadHours', True),
            ('targetLeadHours', 2),
            ('validAt', '2024-03-14T01:00:30Z'),
            ('validAt', '2024-03-14T01:00:00+00:00'),
            ('runInitializedAt', '2024-03-14T00:30:00Z'),
            ('actualIssueAt', '2024-03-14T00:00:00Z'),
        ]
        # mutate one row while retaining the other ninety-five valid leads
        for field, value in changes:
            rows = copy.deepcopy(self.rows)
            rows[0][field] = value
            with self.subTest(field=field, value=value):
                self.reject_rows(rows)

    # one missing or changed rain value breaks exact original-source parity
    def test_rain_parity_including_source_nulls(self):
        variants = [(0, 9.), (8, 0.), (1, None), (1, True)]
        # reject number/null substitutions independently
        for index, value in variants:
            rows = copy.deepcopy(self.rows)
            rows[index]['rawPrecipitationMm'] = value
            with self.subTest(index=index, value=value):
                self.reject_rows(rows)
        first = min(self.context)
        self.context[first]['rain'][0] = 0.
        rows = copy.deepcopy(self.rows)
        rows[0]['rawPrecipitationMm'] = -0.
        self.reject_rows(rows)

    # a run's response body sha and receipt time must bind every lead
    def test_same_response_sha_and_received_time_for_each_run(self):
        changes = [
            (0, 'responseSha256', 'bad'),
            (1, 'responseSha256', 'c' * 64),
            (0, 'responseReceivedAtUtc', '2026-09-13T00:00:00+00:00'),
            (1, 'responseReceivedAtUtc', '2026-09-13T07:01:05Z'),
        ]
        # reject a bad first receipt or any per-lead receipt drift
        for index, field, value in changes:
            rows = copy.deepcopy(self.rows)
            rows[index][field] = value
            with self.subTest(index=index, field=field):
                self.reject_rows(rows)

    # valid direction includes zero and three-sixty but not overrange values
    def test_direction_null_range_and_type(self):
        changes = [-1, 360.001, float('inf'), '90', True]
        # serialize infinities only as raw json in the separate parser test
        for value in changes:
            rows = copy.deepcopy(self.rows)
            rows[0]['rawWindDirectionDegrees'] = value
            with self.subTest(value=value):
                if value == float('inf'):
                    with self.assertRaises(ValueError):
                        write_rows(self.path, rows)
                else:
                    self.reject_rows(rows)

    # duplicate keys and nonfinite json are invalid even in optional fields
    def test_duplicate_keys_and_nonfinite_json_rejected(self):
        normal = [json.dumps(row, sort_keys=True) + '\n' for row in self.rows]
        altered = normal.copy()
        altered[0] = altered[0].rstrip('\n')[:-1] + ',"cohort":"other"}\n'
        body = ''.join(altered).encode()
        self.path.write_bytes(body)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            source.load_profiles(self.path, hashlib.sha256(body).hexdigest(), self.context, self.trajectory)
        altered = normal.copy()
        altered[0] = altered[0].rstrip('\n')[:-1] + ',"extra":{"x":1,"x":2}}\n'
        body = ''.join(altered).encode()
        self.path.write_bytes(body)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            source.load_profiles(self.path, hashlib.sha256(body).hexdigest(), self.context, self.trajectory)
        # exponent overflow is invalid despite being lexical json number syntax
        altered[0] = normal[0].rstrip('\n')[:-1] + ',"extra":1e999}\n'
        body = ''.join(altered).encode()
        self.path.write_bytes(body)
        with self.assertRaisesRegex(ValueError, 'nonfinite'):
            source.load_profiles(self.path, hashlib.sha256(body).hexdigest(), self.context, self.trajectory)
        altered[0] = normal[0].rstrip('\n')[:-1] + ',"extra":NaN}\n'
        body = ''.join(altered).encode()
        self.path.write_bytes(body)
        with self.assertRaisesRegex(ValueError, 'nonfinite'):
            source.load_profiles(self.path, hashlib.sha256(body).hexdigest(), self.context, self.trajectory)

    # no missing required field or partial line may pass a valid content hash
    def test_missing_field_and_partial_line_rejected(self):
        rows = copy.deepcopy(self.rows)
        del rows[0]['rawWindDirectionDegrees']
        self.reject_rows(rows)
        body = ''.join(json.dumps(row) + '\n' for row in self.rows).encode()[:-1]
        self.path.write_bytes(body)
        with self.assertRaises(ValueError):
            source.load_profiles(self.path, hashlib.sha256(body).hexdigest(), self.context, self.trajectory)


# run only synthetic source-join tests without opening real private data
if __name__ == '__main__':
    unittest.main()
