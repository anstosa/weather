#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-host-probe}"
DERIVED_DATA="$RESULTS/DerivedData"
RESULT_BUNDLE="$RESULTS/WeatherWidgetHost.xcresult"
ATTACHMENTS="$RESULTS/attachments"
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"
mkdir -p "$RESULTS"

# stop only the log capture started here
cleanup() {
  # stop the Simulator log stream
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# preserve bounded Simulator failure diagnostics
capture_failure_diagnostics() {
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/springboard-failure.png" \
    > "$RESULTS/springboard-failure-screenshot.log" 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_UDID" log show --last 10m --style compact \
    --predicate 'process == "SpringBoard" OR process == "WeatherWidgetExtension" OR subsystem == "farm.ballydidean.weather.widget"' \
    > "$RESULTS/simulator-widget-diagnostics.log" 2>&1 || true
}

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# select one available iOS 26.5 iPhone 17
SIMULATOR_UDID="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
payload = json.load(sys.stdin)
# inspect installed runtimes
for runtime, devices in payload["devices"].items():
    # select the pinned runtime
    if runtime.endswith("iOS-26-5"):
        # inspect available devices
        for device in devices:
            # select the pinned phone
            if device["name"] == "iPhone 17" and device.get("isAvailable", False):
                print(device["udid"])
                raise SystemExit(0)
raise SystemExit("no available iPhone 17 on iOS 26.5")
')"
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"

# boot the selected simulator
if ! xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  # accept only an already-booted simulator
  if ! grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
    cat "$RESULTS/simulator-boot.stderr" >&2
    exit 78
  fi
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b

# capture installed visual-control contracts without gating the host attempt
set +e
xcrun simctl help ui > "$RESULTS/simctl-ui-help.txt" 2>&1
SIMCTL_UI_HELP_STATUS=$?
xcrun xcresulttool export attachments --help \
  > "$RESULTS/xcresulttool-export-attachments-help.txt" 2>&1
XCRESULT_HELP_STATUS=$?
set -e
printf '%s\n' "$SIMCTL_UI_HELP_STATUS" > "$RESULTS/simctl-ui-help-status.txt"
printf '%s\n' "$XCRESULT_HELP_STATUS" > "$RESULTS/xcresulttool-export-attachments-help-status.txt"

# reject reused result bundles
if [[ -e "$RESULT_BUNDLE" ]]; then
  printf '%s\n' "result bundle already exists: $RESULT_BUNDLE" > "$RESULTS/blocker.txt"
  exit 78
fi

# record real provider and tap execution
xcrun simctl spawn "$SIMULATOR_UDID" log stream \
  --style compact \
  --level info \
  --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
  > "$RESULTS/provider-and-route.log" 2>&1 &
LOG_PID=$!

# add, inspect, and tap the real widget through public XCUIAutomation
set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme WeatherWidgetHostTests \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:WeatherUITests/WidgetHostUITests/testPlacedWidgetOpensForecast \
  test | tee "$RESULTS/widget-host-test.log"
HOST_TEST_STATUS=${PIPESTATUS[0]}
set -e
printf '%s\n' "$HOST_TEST_STATUS" > "$RESULTS/widget-host-test-status.txt"

# preserve the final hosted state
xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/after-widget-tap.png" \
  > "$RESULTS/after-widget-tap-screenshot.log" 2>&1 || true

# export all XCTest screenshots and hierarchy receipts
set +e
xcrun xcresulttool export attachments \
  --path "$RESULT_BUNDLE" \
  --output-path "$ATTACHMENTS" \
  > "$RESULTS/xcresulttool-export-attachments.log" 2>&1
XCRESULT_EXPORT_STATUS=$?
set -e
printf '%s\n' "$XCRESULT_EXPORT_STATUS" > "$RESULTS/xcresulttool-export-attachments-status.txt"

# flush the bounded provider trace
if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
  kill "$LOG_PID" 2>/dev/null || true
  wait "$LOG_PID" 2>/dev/null || true
  LOG_PID=""
fi

# record provider execution independently of the UI verdict
PROVIDER_READY=0
# require the exact fixture trace
if grep -q 'fixture=maximumDensity groups=7 intervals=21' "$RESULTS/provider-and-route.log"; then
  PROVIDER_READY=1
fi
printf '%s\n' "$PROVIDER_READY" > "$RESULTS/provider-ready.txt"

# require the public gallery/host/tap test
if [[ "$HOST_TEST_STATUS" -ne 0 ]]; then
  capture_failure_diagnostics
  printf '%s\n' "public XCUI widget gallery/host/tap test failed" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: public widget gallery path failed; see $RESULTS" >&2
  exit 78
fi
# require exported XCTest receipts
if [[ "$XCRESULT_EXPORT_STATUS" -ne 0 ]]; then
  capture_failure_diagnostics
  printf '%s\n' "XCTest host receipts could not be exported" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: XCTest receipt export failed; see $RESULTS" >&2
  exit 78
fi
# require real provider execution
if [[ "$PROVIDER_READY" -ne 1 ]]; then
  capture_failure_diagnostics
  printf '%s\n' "hosted widget did not emit maximum-density provider evidence" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: widget provider evidence is missing; see $RESULTS" >&2
  exit 78
fi
# require the fixed widget route
if ! grep -q 'route=forecast source=deep-link' "$RESULTS/provider-and-route.log"; then
  capture_failure_diagnostics
  printf '%s\n' "widget tap did not emit the fixed forecast route" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: widget tap route trace is missing; see $RESULTS" >&2
  exit 78
fi
ATTACHMENT_SCREENSHOTS="$(find "$ATTACHMENTS" -type f -iname '*.png' | wc -l | tr -d ' ')"
# require both hosted and tapped visual receipts
if [[ "$ATTACHMENT_SCREENSHOTS" -lt 2 ]]; then
  capture_failure_diagnostics
  printf '%s\n' "exported XCTest receipts lack hosted/tapped screenshots" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: hosted/tapped attachments are missing; see $RESULTS" >&2
  exit 78
fi

# hash the successful real-host receipts
{
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
  printf 'host_path=%s\n' 'public-xcui-widget-gallery'
  printf 'fixture=%s\n' 'maximumDensity'
  printf 'simulator_udid=%s\n' "$SIMULATOR_UDID"
  printf 'provider_ready=%s\n' "$PROVIDER_READY"
  printf 'host_test_status=%s\n' "$HOST_TEST_STATUS"
  find "$ATTACHMENTS" -type f -print0 | sort -z | xargs -0 shasum -a 256
  shasum -a 256 "$RESULTS/after-widget-tap.png" "$RESULTS/provider-and-route.log"
} > "$RESULTS/capture-manifest.txt"

# require reviewed visual receipts before declaring M0
if [[ -n "${HOST_EVIDENCE_DIR:-}" ]]; then
  "$SCRIPT_DIR/verify-widget-host-evidence.py" "$HOST_EVIDENCE_DIR"
  echo "actual WidgetKit Home Screen/provider/render/tap evidence passed"
  exit 0
fi

printf '%s\n' \
  "actual maximum-density host/provider/tap capture succeeded; clipping, appearance, accessibility-size, near-cutoff, and bedtime receipts still require review" \
  > "$RESULTS/visual-review-required.txt"
echo "M0-IOS-HOST-ACCESS: actual host capture ready for visual/full-matrix review; see $RESULTS" >&2
exit 78
