#!/usr/bin/env python3
"""Focused public-configuration evidence regression tests."""

import argparse
import datetime
import importlib.util
import io
import json
import os
import subprocess
import struct
import tempfile
import textwrap
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


# install bounded fake apple command-line tools for lifecycle execution
def install_semantic_mock_cli(directory):
    binary = directory / "bin"
    state = directory / "state"
    binary.mkdir()
    state.mkdir()
    xcrun = binary / "xcrun"
    xcrun.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env bash
            set -euo pipefail

            # emulate only the simctl lifecycle used by the semantic probe
            if [[ "$1" == "simctl" ]]; then
              command="$2"
              # create one deterministic owned identifier
              if [[ "$command" == "create" ]]; then
                counter="$(cat "$MOCK_STATE/counter" 2>/dev/null || printf '0')"
                counter=$((counter + 1))
                printf '%s\n' "$counter" > "$MOCK_STATE/counter"
                udid="owned-$counter"
                case_id="${3#Weather Semantic Host }"
                case_id="${case_id% *}"
                printf '%s\t%s\n' "$udid" "$case_id" >> "$MOCK_STATE/devices.tsv"
                printf 'create:%s:%s\n' "$udid" "$case_id" >> "$MOCK_LOG"
                printf '%s\n' "$udid"
                exit 0
              fi
              # emit bounded provider and route receipts until stopped
              if [[ "$command" == "spawn" ]]; then
                udid="$3"
                case_id="$(awk -F '\t' -v id="$udid" '$1 == id { print $2 }' "$MOCK_STATE/devices.tsv")"
                printf 'spawn:%s\n' "$udid" >> "$MOCK_LOG"
                printf 'expected-%s\nroute=forecast source=deep-link\n' "$case_id"
                : > "$MOCK_STATE/provider-$udid.ready"
                exec sleep 3600
              fi
              # record every exact deletion attempt
              if [[ "$command" == "delete" ]]; then
                printf 'delete:%s\n' "$3" >> "$MOCK_LOG"
                # fail only when requested by the regression
                if [[ "${MOCK_DELETE_FAIL_ALWAYS:-0}" == 1 ]]; then
                  exit 1
                fi
                exit 0
              fi
              printf '%s:%s\n' "$command" "${3:-}" >> "$MOCK_LOG"
              exit 0
            fi

            # export the three existing per-case attachment receipts
            if [[ "$1" == "xcresulttool" ]]; then
              output=""
              # locate the requested attachment directory
              while [[ "$#" -gt 0 ]]; do
                case "$1" in
                  --output-path)
                    output="$2"
                    shift 2
                    ;;
                  *)
                    shift
                    ;;
                esac
              done
              case_id="$(basename "$(dirname "$output")")"
              mkdir -p "$output"
              printf '["matrix-%s-home-screen","matrix-%s-widgetkit-bounds","matrix-%s-widget-tap-forecast-route"]\n' \
                "$case_id" "$case_id" "$case_id" > "$output/manifest.json"
              exit 0
            fi
            exit 1
            """
        )
    )
    xcrun.chmod(0o700)
    xcodebuild = binary / "xcodebuild"
    xcodebuild.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env bash
            set -euo pipefail
            method=""
            # select the exact requested XCTest method
            for argument in "$@"; do
              case "$argument" in
                -only-testing:*) method="${argument##*/}" ;;
              esac
            done
            # return one executed-test marker or a build marker
            if [[ -n "$method" ]]; then
              current="$(cat "$MOCK_STATE/counter")"
              # wait for the fake provider stream to publish its receipt
              for attempt in {1..100}; do
                # stop after the current case receipt is visible
                if [[ -e "$MOCK_STATE/provider-owned-$current.ready" ]]; then
                  break
                fi
                sleep 0.01
              done
              # reject a mock run that never started its provider stream
              if [[ ! -e "$MOCK_STATE/provider-owned-$current.ready" ]]; then
                exit 2
              fi
              printf '%s passed\n' "$method"
              # fail the requested xctest after emitting normal output
              if [[ "$method" == "${MOCK_XCODEBUILD_FAIL_METHOD:-}" ]]; then
                exit 1
              fi
            else
              printf 'build passed\n'
            fi
            """
        )
    )
    xcodebuild.chmod(0o700)
    return binary, state


# execute only the semantic lifecycle prefix against fake tools
def run_semantic_mock(directory, body, **overrides):
    source = Path(__file__).with_name("probe-widget-semantic-host.sh").read_text()
    prefix = source.partition('\n"$SCRIPT_DIR/preflight.sh"')[0]
    binary, state = install_semantic_mock_cli(directory)
    results = directory / "results"
    log = directory / "operations.log"
    runner = directory / "runner.sh"
    runner.write_text(
        prefix
        + "\nmkdir -p \"$RESULTS/cases\" \"$RESULTS/DerivedData\"\n"
        + ": > \"$RESULTS/cases.tsv\"\n: > \"$RESULTS/semantic-host.log\"\n"
        + 'DEVICE_TYPE_IDENTIFIER="mock-device"\nRUNTIME_IDENTIFIER="mock-runtime"\n'
        + body
        + "\n"
    )
    runner.chmod(0o700)
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{binary}:{environment['PATH']}",
            "RESULTS": str(results),
            "MOCK_LOG": str(log),
            "MOCK_STATE": str(state),
        }
    )
    environment.update(overrides)
    result = subprocess.run(
        ["bash", str(runner)],
        cwd=directory,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    operations = log.read_text().splitlines() if log.exists() else []
    return result, operations


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
    # create distinct devices and delete each before creating the next
    def test_semantic_probe_executes_isolated_case_lifecycles(self):
        with tempfile.TemporaryDirectory() as root:
            result, operations = run_semantic_mock(
                Path(root),
                'run_case "case-a" "fixture-a" "SELECTOR_A" "testA" "expected-case-a"\n'
                'run_case "case-b" "fixture-b" "SELECTOR_B" "testB" "expected-case-b"',
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        # compare the exact create and delete identities
        creates = [entry for entry in operations if entry.startswith("create:")]
        deletes = [entry for entry in operations if entry.startswith("delete:")]
        self.assertEqual(creates, ["create:owned-1:case-a", "create:owned-2:case-b"])
        self.assertEqual(deletes, ["delete:owned-1", "delete:owned-2"])
        self.assertLess(operations.index("delete:owned-1"), operations.index(creates[1]))

    # delete the active owned device when xctest fails
    def test_semantic_probe_executes_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            result, operations = run_semantic_mock(
                Path(root),
                'run_case "case-fail" "fixture" "SELECTOR" "testFail" "expected-case-fail"',
                MOCK_XCODEBUILD_FAIL_METHOD="testFail",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("create:owned-1:case-fail", operations)
        self.assertEqual(operations.count("delete:owned-1"), 1)

    # propagate deletion failure after both normal and exit cleanup attempts
    def test_semantic_probe_executes_fail_closed_deletion(self):
        with tempfile.TemporaryDirectory() as root:
            result, operations = run_semantic_mock(
                Path(root),
                'run_case "case-delete" "fixture" "SELECTOR" "testDelete" "expected-case-delete"',
                MOCK_DELETE_FAIL_ALWAYS="1",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(operations.count("delete:owned-1"), 2)

    # keep term cancellation nonzero while deleting only the active owned id
    def test_semantic_probe_executes_nonzero_term_cleanup(self):
        body = textwrap.dedent(
            """\
            ACTIVE_CASE_ID="case-term"
            SIMULATOR_UDID="owned-term"
            mkdir -p "$RESULTS/cases/$ACTIVE_CASE_ID"
            kill -TERM $$
            """
        )
        with tempfile.TemporaryDirectory() as root:
            result, operations = run_semantic_mock(Path(root), body)
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertEqual(operations.count("delete:owned-term"), 1)

    # require six distinct per-case simulator lifecycles
    def test_semantic_probe_owns_six_unique_case_simulators(self):
        source = Path(__file__).with_name("probe-widget-semantic-host.sh").read_text()
        PROJECT_VERIFIER.verify_semantic_probe_lifecycle(source)
        duplicate = source.replace(
            'run_case "10-fall-back"', 'run_case "09-adjusted-standard"', 1
        )
        with self.assertRaises(SystemExit):
            PROJECT_VERIFIER.verify_semantic_probe_lifecycle(duplicate)

    # require exit and signal cleanup after a failed semantic case
    def test_semantic_probe_cleans_up_failed_cases(self):
        source = Path(__file__).with_name("probe-widget-semantic-host.sh").read_text()
        without_trap = source.replace("trap handle_term TERM", "trap - TERM", 1)
        with self.assertRaises(SystemExit):
            PROJECT_VERIFIER.verify_semantic_probe_lifecycle(without_trap)

    # reject any return to a borrowed simulator destination
    def test_semantic_probe_rejects_borrowed_devices(self):
        source = Path(__file__).with_name("probe-widget-semantic-host.sh").read_text()
        borrowed = source.replace(
            "list devicetypes --json", "list devices available --json", 1
        )
        with self.assertRaises(SystemExit):
            PROJECT_VERIFIER.verify_semantic_probe_lifecycle(borrowed)

    # reject cleanup that swallows a simulator deletion failure
    def test_semantic_probe_rejects_cleanup_contract_regression(self):
        source = Path(__file__).with_name("probe-widget-semantic-host.sh").read_text()
        swallowed = source.replace("SIMULATOR_DELETE_FAILED=1", "SIMULATOR_DELETE_FAILED=0")
        with self.assertRaises(SystemExit):
            PROJECT_VERIFIER.verify_semantic_probe_lifecycle(swallowed)

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
