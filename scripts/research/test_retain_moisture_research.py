"""Regression checks for the private moisture retention root."""

import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import retain_moisture_research as retain


# create one private disk-backed research root
def disk_root(home, name="weather-moisture-research-test"):
    weather = home / ".weather"
    weather.mkdir(mode=0o700)
    base = weather / "research-work"
    base.mkdir(mode=0o700)
    root = base / name
    root.mkdir(mode=0o700)
    return root


# lock the private root boundary without retaining evidence
class PrivateRootTests(unittest.TestCase):
    # reject evidence links before encryption or upload can expose their targets
    def test_retention_rejects_linked_evidence_members(self):
        # exercise both linked files and linked directories
        for directory_link in (False, True):
            # isolate the real approved root and external evidence
            with self.subTest(directory_link=directory_link), tempfile.TemporaryDirectory(
                prefix="weather-moisture-research-", dir="/dev/shm"
            ) as temporary, tempfile.TemporaryDirectory() as external:
                root = Path(temporary)
                evidence = Path(external) / "evidence"
                evidence.mkdir()
                (evidence / "acquisition-summary.json").write_text(json.dumps({"status": "complete"}))
                (evidence / "final-verification.json").write_text(json.dumps({"verdict": "PASS"}))
                target = Path(external) / "unrelated"
                # provide synthetic unrelated content for either link kind
                if directory_link:
                    target.mkdir()
                    (target / "private.txt").write_text("unrelated private data")
                else:
                    target.write_text("unrelated private data")
                (evidence / "linked").symlink_to(target, target_is_directory=directory_link)
                # supply the complete required experiment directory inventory
                for name in ("acquisition", "production-moisture", "targets", "pairs-production", "pairs-archive", "humidity", "predictions", "runtime-sources"):
                    (root / name).mkdir(mode=0o700)
                # forbid encryption credentials or external retention calls
                with mock.patch("sys.argv", ["retain", str(root), str(evidence)]), mock.patch.object(
                    retain.subprocess, "check_output", side_effect=AssertionError("external retention reached")
                ) as external_call:
                    with self.assertRaises(ValueError):
                        retain.main()
                    external_call.assert_not_called()

    # accept the exact private disk-backed hierarchy
    def test_accepts_private_disk_root(self):
        # isolate all test paths
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = disk_root(home)
            self.assertEqual(retain.validate_private_root(root, home=home), root.resolve())

    # preserve the existing private tmpfs hierarchy
    def test_accepts_private_tmpfs_root(self):
        # isolate the synthetic tmpfs root
        with tempfile.TemporaryDirectory(prefix="weather-moisture-research-", dir="/dev/shm") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            self.assertEqual(retain.validate_private_root(root), root.resolve())

    # reject arbitrary directories and lexical traversal
    def test_rejects_unapproved_or_traversing_roots(self):
        # isolate all test paths
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = disk_root(home)
            arbitrary = home / "weather-moisture-research-test"
            arbitrary.mkdir(mode=0o700)
            # check each disallowed location
            for candidate in (arbitrary, root.parent / "unused" / ".." / root.name):
                # assert the fail-closed boundary
                with self.assertRaises(ValueError):
                    retain.validate_private_root(candidate, home=home)

    # reject symlinked and non-private roots
    def test_rejects_symlinks_permissions_and_wrong_owner(self):
        # isolate all test paths
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = disk_root(home)
            linked = root.parent / "weather-moisture-research-linked"
            linked.symlink_to(root, target_is_directory=True)
            # reject a linked root
            with self.assertRaises(ValueError):
                retain.validate_private_root(linked, home=home)
            root.chmod(0o750)
            # reject group-readable research
            with self.assertRaises(ValueError):
                retain.validate_private_root(root, home=home)
            root.chmod(0o700)
            # reject another owner's research
            with mock.patch.object(retain.os, "getuid", return_value=os.getuid() + 1):
                with self.assertRaises(ValueError):
                    retain.validate_private_root(root, home=home)

    # reject a symlinked disk research base
    def test_rejects_symlinked_disk_base(self):
        # isolate all test paths
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            weather = home / ".weather"
            weather.mkdir(mode=0o700)
            actual = home / "actual-research-work"
            actual.mkdir(mode=0o700)
            root = actual / "weather-moisture-research-test"
            root.mkdir(mode=0o700)
            (weather / "research-work").symlink_to(actual, target_is_directory=True)
            candidate = weather / "research-work" / root.name
            # reject a linked trusted base
            with self.assertRaises(ValueError):
                retain.validate_private_root(candidate, home=home)


# execute only synthetic validation
if __name__ == "__main__":
    unittest.main()
