#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-unit-probe}"
DERIVED_DATA="$RESULTS/DerivedData"
ATTACHMENTS="$RESULTS/attachments"
APP_BUNDLE_ID="farm.ballydidean.weather"
SELECTOR="WEATHER_M0_FIXTURE_MAXIMUM"
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

# stop only this probe's active log stream
cleanup() {
  # flush the bounded provider receipt
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# run one bounded product-unit host phase
run_unit_test() {
  local method="$1"
  local phase="$2"
  local result_bundle="$RESULTS/$phase.xcresult"
  local test_log="$RESULTS/$phase-test.log"

  set +e
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$DERIVED_DATA" \
    -resultBundlePath "$result_bundle" \
    -only-testing:"WeatherUITests/WidgetHostUITests/$method" \
    -parallel-testing-enabled NO \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $SELECTOR" \
    test-without-building | tee "$test_log"
  local status=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$status" > "$RESULTS/$phase-status.txt"
  # reject status-zero skips and missing execution
  if [[ "$status" -ne 0 ]] || ! grep -Eq "$method.*passed" "$test_log"; then
    echo "iOS product temperature-unit phase failed: $phase" >&2
    exit 78
  fi
  mkdir -p "$ATTACHMENTS/$phase"
  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$ATTACHMENTS/$phase" \
    > "$RESULTS/$phase-export-attachments.log" 2>&1
}

# start one log stream for the currently booted simulator
start_log_capture() {
  xcrun simctl spawn "$SIMULATOR_UDID" log stream \
    --style compact \
    --level info \
    --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
    >> "$RESULTS/widget-unit.log" 2>&1 &
  LOG_PID=$!
}

# reject reused evidence before preflight creates its own directory
if [[ -e "$RESULTS" ]]; then
  echo "widget unit probe results already exist: $RESULTS" >&2
  exit 78
fi

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# select the pinned simulator runtime and device
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

# boot only the selected simulator
if ! xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  # accept only an already-booted simulator
  if ! grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
    cat "$RESULTS/simulator-boot.stderr" >&2
    exit 1
  fi
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b

{
  xcodebuild -version
  xcrun simctl list runtimes
  printf 'simulator_udid=%s\n' "$SIMULATOR_UDID"
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
} > "$RESULTS/toolchain.txt"

# compile one deterministic content artifact with the product unit intent
xcodebuild \
  -project "$PROJECT" \
  -scheme WeatherWidgetHostTests \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -parallel-testing-enabled NO \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $SELECTOR" \
  build-for-testing | tee "$RESULTS/build-for-testing.log"

# require a newly placed configuration owned by this probe
xcrun simctl uninstall "$SIMULATOR_UDID" "$APP_BUNDLE_ID" \
  > "$RESULTS/pre-test-uninstall.log" 2>&1 || true

# capture the public F-to-C edit and provider delivery
: > "$RESULTS/widget-unit.log"
start_log_capture
run_unit_test "test07TemperatureUnitEditToCelsius" "edit-to-celsius"
cleanup
LOG_PID=""

# force an extension-process restart without reading private state
xcrun simctl shutdown "$SIMULATOR_UDID"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf 'simulator-rebooted-between-unit-phases=1\n' > "$RESULTS/restart-receipt.txt"

# prove the persisted Celsius configuration survives before restoring Fahrenheit
start_log_capture
run_unit_test "test08TemperatureUnitPersistsAfterExtensionRestart" "restart-and-return-fahrenheit"
cleanup
LOG_PID=""

# require executed public edit, provider delivery, and both roundtrip values
WIDGET_IDS="$(grep -oE 'widget-id=[^ ]+' "$RESULTS/widget-unit.log" || true)"
WIDGET_ID_COUNT="$(printf '%s\n' "$WIDGET_IDS" | sed '/^$/d' | sort -u | wc -l | tr -d '[:space:]')"
if [[ "$WIDGET_ID_COUNT" != "1" ]] \
  || ! grep -Fq 'configuration-unit unit=celsius' "$RESULTS/widget-unit.log" \
  || ! grep -Fq 'configuration-unit unit=fahrenheit' "$RESULTS/widget-unit.log" \
  || ! grep -Fq 'widget-info widget-id=' "$RESULTS/widget-unit.log" \
  || ! grep -Fq 'unit=celsius' "$RESULTS/widget-unit.log" \
  || ! grep -Fq 'unit=fahrenheit' "$RESULTS/widget-unit.log"; then
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/failure.png" >/dev/null 2>&1 || true
  echo "iOS product temperature-unit probe failed; see $RESULTS" >&2
  exit 78
fi

# require every typed and visible/spoken stage attachment
for receipt in \
  'unit-initial-fahrenheit-typed-widget-info' \
  'unit-initial-fahrenheit-visible-spoken' \
  'unit-celsius-typed-widget-info' \
  'unit-celsius-visible-spoken' \
  'unit-celsius-after-restart-typed-widget-info' \
  'unit-celsius-after-restart-visible-spoken' \
  'unit-final-fahrenheit-typed-widget-info' \
  'unit-final-fahrenheit-visible-spoken'; do
  # reject a green test without its required public evidence
  if ! grep -RFq "$receipt" "$ATTACHMENTS"/*/manifest.json; then
    echo "iOS product temperature-unit probe lacks $receipt" >&2
    exit 78
  fi
done

find "$ATTACHMENTS" -type f -print0 | sort -z | xargs -0 shasum -a 256 \
  > "$RESULTS/attachments.sha256"
shasum -a 256 "$RESULTS/widget-unit.log" "$RESULTS/attachments.sha256" \
  > "$RESULTS/evidence.sha256"
echo "iOS product temperature-unit AppIntent probe passed: $RESULTS"
