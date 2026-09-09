"""Regression checks for the assembled twelve-gauge station catalog."""

import json
import os
from pathlib import Path
import tempfile
import unittest

import build_rain_sub24 as builder
from rain_sub24 import STATIONS
from test_build_moisture_targets import EXPECTED_TEMPEST_POLICY


# lock catalog assembly to explicit source policy and bounded discovery input
class StationCatalogTests(unittest.TestCase):
    # build without the ignored historical catalog or repository working directory
    def test_catalog_is_stable_without_ignored_evidence(self):
        # close owned resources after use
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            discovery = root / 'station-discovery'
            discovery.mkdir()
            rows = [{'locationId': station, 'latitude': 47.950429954185445, 'longitude': -122.42797012608193} for station in STATIONS[7:]]
            (discovery / 'resolved.json').write_text(json.dumps(rows))
            previous = Path.cwd()
            # prove catalog assembly has no repository-relative fallback
            try:
                os.chdir(root)
                catalog = builder.station_catalog(root)
            finally:
                os.chdir(previous)
        self.assertEqual([row['stationId'] for row in catalog], list(STATIONS))
        frozen = {row['key']: row for row in catalog[:7]}
        self.assertEqual({key: row['unnormalizedSpatialWeight'] for key, row in frozen.items()}, {key: values[3] for key, values in EXPECTED_TEMPEST_POLICY.items()})


# run only synthetic catalog checks
if __name__ == '__main__':
    unittest.main()
