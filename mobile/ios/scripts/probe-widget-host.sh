#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-host-probe}"
DERIVED_DATA="$RESULTS/DerivedData"
RESULT_BUNDLE="$RESULTS/WeatherWidgetHost.xcresult"
XCODE_APP="/Applications/Xcode_26.6.app"
XCDEBUG="$XCODE_APP/Contents/Developer/usr/bin/xcdebug"
LOG_PID=""
XCDEBUG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-$XCODE_APP/Contents/Developer}"
mkdir -p "$RESULTS"

# stop only capture processes started here
cleanup() {
  # stop the Simulator log stream
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
  fi
  # stop the requested debugging session
  if [[ -n "$XCDEBUG_PID" ]] && kill -0 "$XCDEBUG_PID" 2>/dev/null; then
    kill "$XCDEBUG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# capture the installed command contract
if [[ ! -x "$XCDEBUG" ]]; then
  printf '%s\n' "xcdebug is not installed at $XCDEBUG" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: xcdebug is unavailable" >&2
  exit 78
fi
set +e
"$XCDEBUG" --help > "$RESULTS/xcdebug-help.txt" 2>&1
HELP_STATUS=$?
set -e
printf '%s\n' "$HELP_STATUS" > "$RESULTS/xcdebug-help-status.txt"

# require the documented scheme run controls
for contract in '--scheme' '--destination' '--build' '--environment'; do
  if ! grep -q -- "$contract" "$RESULTS/xcdebug-help.txt"; then
    printf '%s\n' "xcdebug help lacks $contract" > "$RESULTS/blocker.txt"
    echo "M0-IOS-HOST-ACCESS: installed xcdebug cannot run the widget scheme" >&2
    exit 78
  fi
done

# select one available iOS 26.5 iPhone 17
SIMULATOR_UDID="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
payload = json.load(sys.stdin)
for runtime, devices in payload["devices"].items():
    if runtime.endswith("iOS-26-5"):
        for device in devices:
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

# record real provider and tap execution
xcrun simctl spawn "$SIMULATOR_UDID" log stream \
  --style compact \
  --level info \
  --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
  > "$RESULTS/provider-and-route.log" 2>&1 &
LOG_PID=$!

# open the checked-in project for xcdebug
set +e
open -a "$XCODE_APP" "$PROJECT" > "$RESULTS/xcode-open.log" 2>&1
OPEN_STATUS=$?
set -e
printf '%s\n' "$OPEN_STATUS" > "$RESULTS/xcode-open-status.txt"
if [[ "$OPEN_STATUS" -ne 0 ]]; then
  printf '%s\n' "Xcode could not open the checked-in project" > "$RESULTS/blocker.txt"
  exit 78
fi
sleep 20

# perform Xcode's documented scheme Run action
set +e
"$XCDEBUG" \
  -s WeatherWidget-Maximum \
  -x "$XCODE_APP" \
  -w Weather \
  -d "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -B \
  -b \
  -e '_XCWidgetKind=farm.ballydidean.weather.forecast' \
  -e '_XCWidgetFamily=medium' \
  -e 'WEATHER_WIDGET_FIXTURE=maximumDensity' \
  > "$RESULTS/xcdebug-run.log" 2>&1 &
XCDEBUG_PID=$!
set -e
printf '%s\n' "$XCDEBUG_PID" > "$RESULTS/xcdebug-run-pid.txt"

# wait for the actual timeline provider
PROVIDER_READY=0
for _ in $(seq 1 90); do
  if grep -q 'fixture=maximumDensity groups=7 intervals=21' "$RESULTS/provider-and-route.log"; then
    PROVIDER_READY=1
    break
  fi
  # record an early command exit without racing provider startup
  if [[ -n "$XCDEBUG_PID" ]] && ! kill -0 "$XCDEBUG_PID" 2>/dev/null; then
    set +e
    wait "$XCDEBUG_PID"
    XCDEBUG_STATUS=$?
    set -e
    printf '%s\n' "$XCDEBUG_STATUS" > "$RESULTS/xcdebug-run-status.txt"
    XCDEBUG_PID=""
    # stop only on an actual launch error
    if [[ "$XCDEBUG_STATUS" -ne 0 ]]; then
      break
    fi
  fi
  sleep 1
done
printf '%s\n' "$PROVIDER_READY" > "$RESULTS/provider-ready.txt"

# fail closed when the extension never runs
if [[ "$PROVIDER_READY" -ne 1 ]]; then
  printf '%s\n' "xcdebug did not produce maximum-density WidgetKit provider evidence" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: widget provider did not run; see $RESULTS" >&2
  exit 78
fi

# capture SpringBoard before the tap test
xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/springboard-before-tap.png"

# inspect and tap the placed widget through public XCUIAutomation
python3 - <<'PY' "$RESULT_BUNDLE"
from pathlib import Path
import sys
path = Path(sys.argv[1])
if path.exists():
    raise SystemExit(f"result bundle already exists: {path}")
PY
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

# capture the containing app after the widget tap
xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/after-widget-tap.png"
sleep 3

# require the actual host/tap test and route trace
if [[ "$HOST_TEST_STATUS" -ne 0 ]]; then
  printf '%s\n' "public XCUI host/tap test failed" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: placed widget could not be inspected/tapped; see $RESULTS" >&2
  exit 78
fi
if ! grep -q 'route=forecast source=deep-link' "$RESULTS/provider-and-route.log"; then
  printf '%s\n' "widget tap did not emit the fixed forecast route" > "$RESULTS/blocker.txt"
  echo "M0-IOS-HOST-ACCESS: widget tap route trace is missing; see $RESULTS" >&2
  exit 78
fi

{
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
  printf 'scheme=%s\n' 'WeatherWidget-Maximum'
  printf 'fixture=%s\n' 'maximumDensity'
  printf 'simulator_udid=%s\n' "$SIMULATOR_UDID"
  printf 'provider_ready=%s\n' "$PROVIDER_READY"
  printf 'host_test_status=%s\n' "$HOST_TEST_STATUS"
  shasum -a 256 "$RESULTS/springboard-before-tap.png" "$RESULTS/after-widget-tap.png" "$RESULTS/provider-and-route.log"
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
