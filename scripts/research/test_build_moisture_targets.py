"""Regression checks for private rain and pressure measurement alignment."""

import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import build_moisture_targets as target


EXPECTED_TEMPEST_POLICY = {
    'tempest-126537': (47.9582, -122.44274, 1398.67236054504, 0.6715596083191008),
    'tempest-168853': (47.95498, -122.44074, 1077.20962495532, 0.775136628203077),
    'tempest-201058': (47.96244, -122.43369, 1401.73955268213, 0.670592564378282),
    'tempest-203055': (47.96505, -122.4241, 1651.02362971156, 0.5947178033706937),
    'tempest-225947': (47.94215, -122.42542, 940.077920837135, 0.8190433312327082),
    'tempest-38270': (47.95293, -122.41414, 1066.83643435427, 0.7784918311659549),
    'tempest-64255': (47.95008, -122.43982, 883.385696754924, 0.8367552632922316),
}


# construct one synthetic interval without a provider response
def row(at, interval=1, amount=0.2, pressure=1000):
    return {'_time': at, 'id': int(at.timestamp()), 'report_interval_minutes': interval, 'precipitation_mm': amount, 'pressure_hpa': pressure, 'quality_status': None, 'quality_flags': None}


# lock interval support, physical station references and network gates
class TargetTests(unittest.TestCase):
    # bind the exact public Tempest geometry used by the research target
    def test_public_tempest_policy_matches_versioned_catalog(self):
        catalog = {row['key']: row for row in target.public_tempest_station_catalog()}
        self.assertEqual(set(catalog), set(EXPECTED_TEMPEST_POLICY))
        # compare every policy field that affects target construction
        for key, expected in EXPECTED_TEMPEST_POLICY.items():
            row = catalog[key]
            self.assertEqual((row['latitude'], row['longitude'], row['distanceMeters'], row['unnormalizedSpatialWeight']), expected)
            self.assertEqual(row['providerFamily'], 'tempest')

    # reject policy drift and isolate callers from shared mutable metadata
    def test_public_tempest_policy_rejects_mismatch_and_mutation(self):
        catalog = target.public_tempest_station_catalog()
        catalog[0]['unnormalizedSpatialWeight'] = 0
        self.assertEqual({row['key']: row['unnormalizedSpatialWeight'] for row in target.public_tempest_station_catalog()}, {key: values[3] for key, values in EXPECTED_TEMPEST_POLICY.items()})
        changed = list(target._PUBLIC_TEMPEST_STATION_ROWS)
        changed[0] = (*changed[0][:-1], 0.5)
        # simulate an unreviewed source edit without updating its semantic binding
        with mock.patch.object(target, '_PUBLIC_TEMPEST_STATION_ROWS', tuple(changed)):
            with self.assertRaisesRegex(ValueError, 'catalog policy hash'):
                target.public_tempest_station_catalog()

    # reject a self-consistent manifest that rebinds a frozen production source
    def test_production_manifest_binding(self):
        from test_export_moisture_history import inventory
        sources = target.selected_sources(inventory())
        members = [{'file': f'{start}-{kind}.jsonl.gz', 'transaction': {'readOnly': 'on', 'isolation': 'repeatable read', 'from': str(start), 'toExclusive': str(end), 'kind': kind}} for start, end in target.windows() for kind in ('stations', 'anchors', 'live')]
        manifest = {'contractVersion': 'moisture-production-research-export/v1', 'productionWrites': False, 'sources': sources, 'members': members}
        # close owned resources after use
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'evidence'
            evidence.mkdir()
            (evidence / 'coverage-inventory.json').write_text(json.dumps(inventory()))
            data = json.dumps(manifest)
            (root / 'manifest.json').write_text(data)
            (evidence / 'production-extraction-summary.json').write_text(data)
            self.assertEqual(target.production_manifest(root, evidence), manifest)
            manifest['sources'][0]['source_config_fingerprint'] = 'b' * 64
            data = json.dumps(manifest)
            (root / 'manifest.json').write_text(data)
            (evidence / 'production-extraction-summary.json').write_text(data)
            # close owned resources after use
            with self.assertRaises(ValueError):
                target.production_manifest(root, evidence)

    # preserve all dates and the net daylight-saving hour difference
    def test_full_calendar(self):
        windows = list(target.windows())
        hours = sum((dt.datetime.combine(end, dt.time(), target.ZONE).astimezone(target.UTC) - dt.datetime.combine(start, dt.time(), target.ZONE).astimezone(target.UTC)).total_seconds() / 3600 for start, end in windows)
        self.assertEqual(len(windows), 33)
        self.assertEqual(hours, 23519)
        self.assertEqual(sum((end - start).days for start, end in windows), 980)

    # tile a full hour without counting overlapping records twice
    def test_mixed_intervals_are_exact_partition(self):
        end = dt.datetime(2025, 1, 1, 12, tzinfo=dt.timezone.utc)
        rows = [row(end - dt.timedelta(minutes=i)) for i in range(60)][::-1]
        rows[-1] = row(end, 5, 1)
        times = [item['_time'] for item in rows]
        result = target.rain_window(rows, times, dict(zip(times, rows)), end)
        self.assertAlmostEqual(result['amountMm'], 12)
        self.assertEqual(result['intervalCount'], 56)
        self.assertEqual(result['endLagSeconds'], 0)

    # never invent missing rainfall or prorate an overhanging interval
    def test_gaps_and_overhangs_fail_closed(self):
        end = dt.datetime(2025, 1, 1, 12, tzinfo=dt.timezone.utc)
        rows = [row(end - dt.timedelta(minutes=i)) for i in range(60)][::-1]
        times = [item['_time'] for item in rows]
        indexed = dict(zip(times, rows))
        indexed.pop(end - dt.timedelta(minutes=20))
        self.assertIsNone(target.rain_window(rows, times, indexed, end))
        indexed = dict(zip(times, rows))
        indexed[times[0]] = row(times[0], 5)
        self.assertIsNone(target.rain_window(rows, times, indexed, end))

    # bound endpoint lag and reject larger report intervals
    def test_lag_and_interval_limits(self):
        end = dt.datetime(2025, 1, 1, 12, tzinfo=dt.timezone.utc)
        rows = [row(end - dt.timedelta(minutes=i)) for i in range(60)][::-1]
        times = [item['_time'] for item in rows]
        indexed = dict(zip(times, rows))
        self.assertEqual(target.rain_window(rows, times, indexed, end + dt.timedelta(minutes=5))['endLagSeconds'], 300)
        self.assertIsNone(target.rain_window(rows, times, indexed, end + dt.timedelta(minutes=6)))
        indexed[end] = row(end, 10)
        self.assertIsNone(target.rain_window(rows, times, indexed, end))

    # use earlier equal-distance pressure and an exclusive upper boundary
    def test_nearest_pressure_ties_and_qc(self):
        end = dt.datetime(2025, 1, 1, 12, tzinfo=dt.timezone.utc)
        rows = [row(end - dt.timedelta(minutes=2), pressure=999), row(end + dt.timedelta(minutes=2), pressure=1001)]
        self.assertEqual(target.nearest(rows, [item['_time'] for item in rows], end, 'pressure_hpa', 300, 1100)['pressure_hpa'], 999)
        rows[0]['quality_flags'] = ['bad_pressure']
        self.assertEqual(target.nearest(rows, [item['_time'] for item in rows], end, 'pressure_hpa', 300, 1100)['pressure_hpa'], 1001)
        rows = [row(end + dt.timedelta(minutes=5))]
        self.assertIsNone(target.nearest(rows, [rows[0]['_time']], end, 'pressure_hpa', 300, 1100))

    # reject malformed flags rather than interpreting object keys as flags
    def test_quality_flag_shape(self):
        value = row(dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc))
        # process each selected item
        for flags in ({}, {"uv_index_out_of_range": True}, "uv_index_out_of_range", [True]):
            value["quality_flags"] = flags
            self.assertFalse(target.quality_ok(value))
        value["quality_flags"] = ["uv_index_out_of_range"]
        self.assertTrue(target.quality_ok(value))

    # require three gauges including one declared near gauge
    def test_network_support(self):
        catalog = {key: {'unnormalizedSpatialWeight': 1} for key in ('a', 'b', 'c', 'd')}
        gauges = {key: {'amountMm': value, 'endLagSeconds': 0} for key, value in zip(('a', 'b', 'c'), (0, 1, 10))}
        self.assertEqual(target.network_rain(gauges, catalog, {'a'})['actualPrecipitationMm'], 1)
        self.assertIsNone(target.network_rain(gauges, catalog, {'d'}))
        gauges.pop('a')
        self.assertIsNone(target.network_rain(gauges, catalog, {'b'}))


# run only synthetic targets
if __name__ == '__main__':
    unittest.main()
