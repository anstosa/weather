#!/usr/bin/env python3
"""Focused public-configuration evidence regression tests."""

import argparse
import datetime
import importlib.util
import io
import json
import struct
import tempfile
import unittest
import zlib
from contextlib import redirect_stdout
from pathlib import Path

MODULE = Path(__file__).with_name("verify-widget-configuration-phase.py")
SPEC = importlib.util.spec_from_file_location("widget_configuration_phase", MODULE)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)
PROJECT_SPEC = importlib.util.spec_from_file_location(
    "mobile_project_verifier", Path(__file__).with_name("verify-project.py")
)
PROJECT_VERIFIER = importlib.util.module_from_spec(PROJECT_SPEC)
PROJECT_SPEC.loader.exec_module(PROJECT_VERIFIER)
UUID = "00000000-0000-0000-0000-000000000001"
BASE = 1700000000
KIND = "farm.ballydidean.weather.forecast"


# encode one genuine one-pixel RGBA PNG without external dependencies
def tiny_png():
    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    return (
        VERIFIER.PNG_SIGNATURE
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00"))
        + chunk(b"IEND", b"")
    )


# construct one exact exported query and phase-local timeline
def evidence(directory, *, listing="0:fahrenheit,1:celsius", count=2,
             status="complete", timeline="timeline", timeline_time=25,
             anchor_time=20, log_summary=None, entry_units=None,
             entry_pid=1, target_page="2/2", target_frame="26.00,88.00,350.00,191.00",
             utc_offset="+0000", reopen_time=29, reopen_unit="celsius"):
    summary = (
        f"widget-config epoch=1 observedAtMs={(BASE + 30) * 1000} "
        f"status={status} total={count} matchCount={count} kind={KIND} "
        f"family=systemMedium entries={listing}"
    )
    if log_summary is None:
        log_summary = summary
    (directory / "typed.txt").write_text(summary)
    (directory / "selected.png").write_bytes(tiny_png())
    (directory / "observed.png").write_bytes(tiny_png())
    (directory / "target.txt").write_text(f"page={target_page} frame={target_frame}")
    (directory / "reopened.txt").write_text(f"reopened-native-unit={reopen_unit} switch=1")
    (directory / "utc-offset.txt").write_text(utc_offset + "\n")
    items = [
        {
            "suggestedHumanReadableName": f"unit-celsius-typed-widget-info_0_{UUID}.txt",
            "exportedFileName": "typed.txt",
            "timestamp": BASE + 30,
        },
        {
            "suggestedHumanReadableName": f"unit-selected-celsius-screenshot_0_{UUID}.png",
            "exportedFileName": "selected.png",
            "timestamp": BASE + anchor_time,
        },
        {
            "suggestedHumanReadableName": f"unit-celsius-visible-spoken-screenshot_0_{UUID}.png",
            "exportedFileName": "observed.png",
            "timestamp": BASE + 28,
        },
        {
            "suggestedHumanReadableName": f"unit-celsius-target_0_{UUID}.txt",
            "exportedFileName": "target.txt",
            "timestamp": BASE + 27,
        },
        {
            "suggestedHumanReadableName": f"unit-celsius-stored-unit_0_{UUID}.txt",
            "exportedFileName": "reopened.txt",
            "timestamp": BASE + reopen_time,
        },
    ]
    (directory / "manifest.json").write_text(json.dumps([{"attachments": items}]))

    # match compact-log timestamps to the exported query clock
    def line(second, message, process="Weather", category="route", pid=1):
        stamp = datetime.datetime.fromtimestamp(
            BASE + second, datetime.timezone.utc
        ).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        subsystem = "farm.ballydidean.weather.widget" if process == "WeatherWidgetExtension" else "farm.ballydidean.weather"
        return f"{stamp} Df {process}[{pid}:1] [{subsystem}:{category}] {message}"

    # retain all declared entry records
    entries = entry_units if entry_units is not None else [
        tuple(part.split(":")) for part in listing.split(",")
    ]
    callbacks = [] if timeline is None else [
        line(timeline_time, f"v4-provider-input stage={timeline} unit=celsius", "WeatherWidgetExtension", "timeline")
    ]
    log_lines = [
        *callbacks,
        line(30, f"widget-info {log_summary}"),
        *(
            line(31, f"widget-info widget-config-entry epoch=1 index={index} "
                 f"kind={KIND} family=systemMedium unit={unit}", pid=entry_pid)
            for index, unit in entries
        ),
    ]
    (directory / "provider.log").write_text("\n".join(log_lines) + "\n")
    return argparse.Namespace(
        log=str(directory / "provider.log"),
        manifest=str(directory / "manifest.json"),
        stage="unit-celsius-typed-widget-info",
        target_stage="unit-celsius",
        target_out=None,
        baseline_target=None,
        utc_offset=str(directory / "utc-offset.txt"),
        observation="unit-celsius-visible-spoken-screenshot",
        reopened="unit-celsius-stored-unit",
        reopen_order="before",
        unit="celsius",
        anchor="unit-selected-celsius-screenshot",
        order="after",
    )


class ConfigurationPhaseTests(unittest.TestCase):
    # reject target helpers stranded in the unrelated deep-link class
    def test_widget_target_helpers_have_host_class_scope(self):
        header = "final class WeatherDeepLinkUITests: XCTestCase {\n"
        host = "final class WidgetHostUITests: XCTestCase {\n"
        methods = "private func observedTarget(\nprivate func assertObservedTarget(\n"
        PROJECT_VERIFIER.verify_widget_host_method_scope(header + "}\n" + host + methods)
        with self.assertRaises(SystemExit):
            PROJECT_VERIFIER.verify_widget_host_method_scope(header + methods + "}\n" + host)

    # accept mixed and duplicate typed observations only as corroboration
    def test_mixed_and_duplicate_are_valid(self):
        # exercise opposite and duplicate units
        for listing in ("0:fahrenheit,1:celsius", "0:celsius,1:celsius"):
            with self.subTest(listing=listing), tempfile.TemporaryDirectory() as root:
                args = evidence(Path(root), listing=listing)
                with redirect_stdout(io.StringIO()):
                    VERIFIER.verify(args)

    # reject every incomplete, stale, or unsupported public result
    def test_invalid_public_results(self):
        cases = (
            {"status": "missing"},
            {"status": "overflow"},
            {"listing": "0:fahrenheit,1:nil"},
            {"listing": "0:fahrenheit"},
            {"listing": "0:fahrenheit,0:celsius"},
            {"count": 9, "listing": "0:celsius"},
            {"count": 1, "listing": "0:fahrenheit"},
            {"log_summary": "widget-config epoch=2 observedAtMs=1700000030000 status=complete total=2 matchCount=2 kind=" + KIND + " family=systemMedium entries=0:fahrenheit,1:celsius"},
            {"entry_units": [("0", "fahrenheit")]},
            {"entry_pid": 2},
            {"utc_offset": "+0100"},
            {"reopen_unit": "fahrenheit"},
            {"reopen_time": 27},
            {"anchor_time": 40},
        )
        # reject each independent public listing mutation
        for change in cases:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                args = evidence(Path(root), **change)
                with self.assertRaises(ValueError):
                    VERIFIER.verify(args)

    # keep provider callbacks diagnostic even when absent or late
    def test_provider_callbacks_are_diagnostic(self):
        # exercise missing, non-timeline, pre-edit, and post-render callbacks
        for change in (
            {"timeline": None},
            {"timeline": "placeholder"},
            {"timeline": "snapshot"},
            {"timeline_time": 10},
            {"timeline_time": 29},
        ):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                args = evidence(Path(root), **change)
                output = io.StringIO()
                with redirect_stdout(output):
                    VERIFIER.verify(args)
                self.assertIn("provider_diagnostic=", output.getvalue())

    # preserve the post-reboot Celsius-before-Fahrenheit boundary
    def test_restart_celsius_precedes_return_edit(self):
        with tempfile.TemporaryDirectory() as root:
            args = evidence(Path(root), timeline_time=25, anchor_time=40)
            args.order = "before"
            with redirect_stdout(io.StringIO()):
                VERIFIER.verify(args)
        with tempfile.TemporaryDirectory() as root:
            args = evidence(Path(root), timeline_time=45, anchor_time=20)
            args.order = "before"
            with self.assertRaises(ValueError):
                VERIFIER.verify(args)

    # require real exported PNG bytes for both selected and rendered anchors
    def test_png_integrity(self):
        for name, content in (
            ("selected.png", b""),
            ("selected.png", b"not a PNG"),
            ("selected.png", tiny_png()[:-6]),
            ("observed.png", b""),
            ("observed.png", b"not a PNG"),
        ):
            with self.subTest(name=name, content=content[:8]), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                args = evidence(directory)
                (directory / name).write_bytes(content)
                with self.assertRaises(ValueError):
                    VERIFIER.verify(args)

    # accept the persistence probe's deliberate post-query native reread
    def test_reopened_state_after_query(self):
        with tempfile.TemporaryDirectory() as root:
            args = evidence(Path(root), reopen_time=31)
            args.reopen_order = "after"
            with redirect_stdout(io.StringIO()):
                VERIFIER.verify(args)

    # reject an equal frame on a different current Home Screen page
    def test_page_mismatch_with_same_geometry(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            args = evidence(directory, target_page="3/3")
            baseline = directory / "before-target.txt"
            baseline.write_text("page=2/2 frame=26.00,88.00,350.00,191.00\n")
            args.baseline_target = str(baseline)
            with self.assertRaises(ValueError):
                VERIFIER.verify(args)

    # reject a changed post-reboot host position on the same page
    def test_restart_frame_mismatch(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            args = evidence(directory, target_frame="26.00,101.00,350.00,191.00")
            baseline = directory / "before-target.txt"
            baseline.write_text("page=2/2 frame=26.00,88.00,350.00,191.00\n")
            args.baseline_target = str(baseline)
            with self.assertRaises(ValueError):
                VERIFIER.verify(args)


# run focused regressions directly from the repository wrapper
if __name__ == "__main__":
    unittest.main()
