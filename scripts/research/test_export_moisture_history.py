"""Regression checks for the separate read-only research boundary."""

import datetime as dt
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import export_moisture_history as export


# construct only the fixed source allowlist
def inventory():
    return {"sources": [{"id": index + 1, "source_key": key, "source_config_fingerprint": "a" * 64} for index, key in enumerate(sorted(export.STATION_KEYS | export.FORECAST_KEYS))]}


# create one private disk-backed export root
def disk_root(home, name="weather-moisture-research-export"):
    weather = home / ".weather"
    weather.mkdir(mode=0o700)
    base = weather / "research-work"
    base.mkdir(mode=0o700)
    root = base / name
    root.mkdir(mode=0o700)
    return root


# lock range, identity, field and transaction boundaries
class ExportBoundaryTests(unittest.TestCase):
    # accept only owned private roots in the two supported bases
    def test_private_root_accepts_disk_and_tmpfs(self):
        # isolate the disk-backed root
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = disk_root(home)
            self.assertEqual(export.validate_private_root(root, home=home), root.resolve())
        # isolate the tmpfs root
        with tempfile.TemporaryDirectory(prefix="weather-moisture-research-", dir="/dev/shm") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            self.assertEqual(export.validate_private_root(root), root.resolve())

    # reject location, mode, owner, symlink and traversal bypasses
    def test_private_root_rejects_boundary_bypasses(self):
        # isolate all test paths
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = disk_root(home)
            outside = home / "weather-moisture-research-export"
            outside.mkdir(mode=0o700)
            linked = root.parent / "weather-moisture-research-linked"
            linked.symlink_to(root, target_is_directory=True)
            candidates = (outside, linked, root.parent / "unused" / ".." / root.name)
            # check each disallowed path
            for candidate in candidates:
                # assert the fail-closed boundary
                with self.assertRaises(ValueError):
                    export.validate_private_root(candidate, home=home)
            root.chmod(0o750)
            # reject group-readable research
            with self.assertRaises(ValueError):
                export.validate_private_root(root, home=home)
            root.chmod(0o700)
            # reject another owner's research
            with mock.patch.object(export.os, "getuid", return_value=os.getuid() + 1):
                with self.assertRaises(ValueError):
                    export.validate_private_root(root, home=home)

    # retain every calendar date exactly once
    def test_windows_are_complete_and_contiguous(self):
        windows = list(export.windows())
        self.assertEqual(len(windows), 33)
        self.assertEqual(windows[0][0], dt.date(2024, 1, 1))
        self.assertEqual(windows[-1][1], dt.date(2026, 9, 7))
        self.assertEqual(sum((end - start).days for start, end in windows), 980)
        self.assertTrue(all(left[1] == right[0] for left, right in zip(windows, windows[1:])))

    # reject unknown or malformed catalog material
    def test_source_validation(self):
        sources = inventory()
        self.assertEqual(len(export.selected_sources(sources)), 9)
        duplicated = inventory()
        duplicated["sources"].append(duplicated["sources"][0].copy())
        # close owned resources after use
        with self.assertRaises(ValueError):
            export.selected_sources(duplicated)
        sources["sources"][0]["id"] = True
        # close owned resources after use
        with self.assertRaises(ValueError):
            export.selected_sources(sources)
        sources = inventory()
        sources["sources"].pop()
        # close owned resources after use
        with self.assertRaises(ValueError):
            export.selected_sources(sources)

    # enforce readonly and bounded indexed reads
    def test_queries_have_readonly_and_cap_guards(self):
        sources = export.selected_sources(inventory())
        # process each selected item
        for kind in ("stations", "anchors", "live"):
            sql = export.query(sources, dt.date(2024, 1, 1), dt.date(2024, 2, 1), kind)
            self.assertIn("REPEATABLE READ READ ONLY", sql)
            self.assertIn("statement_timeout = '120s'", sql)
            self.assertIn("lock_timeout = '3s'", sql)
            self.assertIn("w.source_id=s.id", sql)
            self.assertIn("w.valid_at >= TIMESTAMPTZ", sql)
            self.assertIn("w.valid_at < TIMESTAMPTZ", sql)
            self.assertIn("LIMIT 400001", sql)
            self.assertNotRegex(sql, r"\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|TRUNCATE)\b")
            self.assertNotIn("device_serial", sql)
            self.assertNotIn("property_sensors", sql)

    # preserve the observed interval lookback and DST-aware endpoints
    def test_station_buffer_and_dst(self):
        sources = export.selected_sources(inventory())
        winter = export.query(sources, dt.date(2024, 1, 1), dt.date(2024, 2, 1), "stations")
        summer = export.query(sources, dt.date(2026, 9, 1), dt.date(2026, 9, 7), "stations")
        self.assertIn("2024-01-01T06:55:00+00:00", winter)
        self.assertIn("2026-09-01T05:55:00+00:00", summer)
        self.assertIn("2026-09-07T07:00:00+00:00", summer)
        self.assertIn("report_interval_minutes", summer)
        self.assertIn("quality_flags", summer)

    # retain honest reference types for archive anchors
    def test_anchor_reference_remains_null(self):
        sql = export.query(export.selected_sources(inventory()), dt.date(2024, 1, 1), dt.date(2024, 2, 1), "anchors")
        self.assertIn("NULL::timestamptz AS product_run_at", sql)
        self.assertIn("w.lead_hours", sql)
        self.assertIn("w.contract_epoch", sql)
        self.assertIn("w.adapter_version", sql)

    # reject wider or arbitrary user-supplied intervals
    def test_unplanned_ranges_are_rejected(self):
        # process each selected item
        for start, end in ((dt.date(2019, 1, 1), dt.date(2026, 9, 7)), (dt.date(2024, 1, 2), dt.date(2024, 2, 1))):
            # close owned resources after use
            with self.assertRaises(ValueError):
                export.query(export.selected_sources(inventory()), start, end, "stations")


# execute only synthetic validation
if __name__ == "__main__":
    unittest.main()
