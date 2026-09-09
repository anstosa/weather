"""Synthetic forecast-identity checks for moisture research pairing."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import build_moisture_pairs as pairs


# provide only a synthetic production forecast record
def row(reference, rain=0.2, pressure=1000, identity=1):
    return {'valid_at': '2025-01-02T12:00:00+00:00', 'product_run_at': reference, 'lead_hours': 24, 'elevation_m': 28, 'source_config_fingerprint': 'a' * 64, 'content_hash': str(identity), 'id': identity, 'temperature_c': 10, 'relative_humidity_percent': 80, 'wind_speed_mps': 2, 'precipitation_mm': rain, 'pressure_hpa': pressure, 'cloud_cover_percent': 90, 'quality_status': None, 'quality_flags': None}


# preserve truthful archive references and per-metric jitter support
class PairTests(unittest.TestCase):
    # bind normalized material to the exact successful acquisition receipt
    def test_acquisition_manifest_binding(self):
        manifest = {'contractVersion': 'moisture-shortlead-acquisition/v1', 'productionWrites': False, 'modelFit': False, 'actualIssueTimeKnown': False, 'cohortFiles': {'ecmwf_single_run_hindcast': {}, 'best_match_single_run_transfer': {}}}
        # close owned resources after use
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {'requestedRuns': 4260, 'endpoint': 'https://single-runs-api.open-meteo.com/v1/forecast'}
            plan_data = json.dumps(plan).encode()
            (root / 'acquisition-plan.json').write_bytes(plan_data)
            (root / 'acquisition-code-freeze.json').write_text(json.dumps({'script': {'sha256': 'a' * 64}, 'plan': {'requestedRuns': 4260}}))
            manifest.update(plan={'sha256': hashlib.sha256(plan_data).hexdigest()}, acquisitionScriptSha256='a' * 64, requestedRuns=4260, endpoint=plan['endpoint'])
            data = json.dumps(manifest).encode()
            (root / 'manifest.json').write_bytes(data)
            receipt = {'status': 'complete', 'manifestSha256': hashlib.sha256(data).hexdigest()}
            self.assertEqual(pairs.acquisition_manifest(root, receipt, root), manifest)
            # close owned resources after use
            with self.assertRaises(ValueError):
                pairs.acquisition_manifest(root, {**receipt, 'status': 'stopped'}, root)
            (root / 'acquisition-plan.json').write_bytes(plan_data + b' ')
            with self.assertRaises(ValueError):
                pairs.acquisition_manifest(root, receipt, root)
            (root / 'acquisition-plan.json').write_bytes(plan_data)
            (root / 'manifest.json').write_bytes(data + b' ')
            # close owned resources after use
            with self.assertRaises(ValueError):
                pairs.acquisition_manifest(root, receipt, root)

    # match second-precision archive timestamps to millisecond target keys
    def test_archive_timestamp_canonicalization(self):
        source = {'key': 'unchanged-source-identity', 'validAt': '2024-03-14T01:00:00Z', 'referenceAt': '2024-03-14T00:00:00Z', 'runInitializedAt': '2024-03-14T00:00:00Z', 'actualIssueAt': None}
        result = pairs.archive_forecast(source)
        self.assertEqual(result['validAt'], '2024-03-14T01:00:00.000Z')
        self.assertEqual(result['referenceAt'], '2024-03-14T00:00:00.000Z')
        self.assertEqual(result['runInitializedAt'], result['referenceAt'])
        self.assertEqual(result['key'], source['key'])
        self.assertIsNone(result['actualIssueAt'])
        self.assertNotEqual(source['validAt'], result['validAt'])

    # anchors must never claim reconstructed initialization timestamps
    def test_anchor_reference(self):
        result, _ = pairs.production_forecast(row(None), 'anchors')
        self.assertIsNone(result['referenceAt'])
        self.assertEqual(result['targetLeadHours'], 24)
        self.assertEqual(result['referenceKind'], 'fixed_lead_anchor')

    # choose the closest literal lead independently of target availability
    def test_jitter_selection_and_metric_missingness(self):
        first = row('2025-01-01T12:01:00+00:00', rain=None, identity=1)
        second = row('2025-01-01T12:10:00+00:00', pressure=1001, identity=2)
        self.assertEqual(pairs.select_production([second, first], 'live', 'rawPressureHpa')[0]['rawPressureHpa'], 1000)
        self.assertEqual(pairs.select_production([second, first], 'live', 'rawPrecipitationMm')[0]['rawPrecipitationMm'], 0.2)

    # reject absent references and nonfuture retrieval forecasts
    def test_invalid_live_reference(self):
        self.assertIsNone(pairs.production_forecast(row(None), 'live'))
        self.assertIsNone(pairs.production_forecast(row('2025-01-02T12:00:00+00:00'), 'live'))
        self.assertIsNone(pairs.production_forecast(row('2025-01-02T13:00:00+00:00'), 'live'))


# run synthetic pairing tests only
if __name__ == '__main__':
    unittest.main()
