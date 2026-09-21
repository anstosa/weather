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
SIMULATOR_UDID=""
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

# stop only this probe's active log stream
stop_log_capture() {
  # flush the bounded provider receipt
  if [[ -n "$LOG_PID" ]]; then
    # terminate only the active log process
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
    LOG_PID=""
  fi
}

# remove only the disposable simulator created by this probe
cleanup() {
  local status=$?
  trap - EXIT
  stop_log_capture
  # retain both phase-local streams even when XCTest fails early
  cat "$RESULTS"/*-provider.log > "$RESULTS/widget-unit.log" 2>/dev/null || true
  # delete only the recorded created device
  if [[ -n "$SIMULATOR_UDID" ]]; then
    xcrun simctl shutdown "$SIMULATOR_UDID" >/dev/null 2>&1 || true
    # record deletion while preserving any earlier test failure
    if xcrun simctl delete "$SIMULATOR_UDID" >/dev/null 2>&1; then
      printf 'disposable_simulator_deleted=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
    else
      printf 'disposable_simulator_delete_failed=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
      # fail a successful probe with a surviving container
      if [[ "$status" -eq 0 ]]; then
        status=78
      fi
    fi
  fi
  exit "$status"
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
  mkdir -p "$ATTACHMENTS/$phase"
  # export failed-test AX before enforcing the test verdict
  set +e
  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$ATTACHMENTS/$phase" \
    > "$RESULTS/$phase-export-attachments.log" 2>&1
  local export_status=$?
  set -e
  printf '%s\n' "$export_status" > "$RESULTS/$phase-export-attachments-status.txt"
  # reject status-zero skips and missing execution
  if [[ "$status" -ne 0 ]] || ! grep -Eq "$method.*passed" "$test_log"; then
    echo "iOS product temperature-unit phase failed: $phase" >&2
    exit 78
  fi
  # reject missing attachments after a passing test
  if [[ "$export_status" -ne 0 ]]; then
    echo "iOS product temperature-unit attachment export failed: $phase" >&2
    exit 78
  fi
}

# start one log stream for the currently booted simulator
start_log_capture() {
  local phase_log="$1"
  xcrun simctl spawn "$SIMULATOR_UDID" log stream \
    --style compact \
    --level info \
    --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
    > "$phase_log" 2>&1 &
  LOG_PID=$!
}

# reject reused evidence before preflight creates its own directory
if [[ -e "$RESULTS" ]]; then
  echo "widget unit probe results already exist: $RESULTS" >&2
  exit 78
fi

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# resolve only the pinned iPhone 17 and iOS 26.5 identifiers
DEVICE_TYPE_IDENTIFIER="$(xcrun simctl list devicetypes --json | python3 -c '
import json, sys
for device in json.load(sys.stdin)["devicetypes"]:
    if device["name"] == "iPhone 17":
        print(device["identifier"])
        raise SystemExit(0)
raise SystemExit("iPhone 17 device type unavailable")
')"
RUNTIME_IDENTIFIER="$(xcrun simctl list runtimes --json | python3 -c '
import json, sys
for runtime in json.load(sys.stdin)["runtimes"]:
    if runtime["identifier"].endswith("iOS-26-5") and runtime.get("isAvailable", False):
        print(runtime["identifier"])
        raise SystemExit(0)
raise SystemExit("iOS 26.5 runtime unavailable")
')"
SIMULATOR_UDID="$(xcrun simctl create \
  "Weather Unit Probe $$" \
  "$DEVICE_TYPE_IDENTIFIER" \
  "$RUNTIME_IDENTIFIER")"
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"
xcrun simctl boot "$SIMULATOR_UDID"
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
start_log_capture "$RESULTS/edit-to-celsius-provider.log"
run_unit_test "test07TemperatureUnitEditToCelsius" "edit-to-celsius"
stop_log_capture

# force an extension-process restart without reading private state
xcrun simctl shutdown "$SIMULATOR_UDID"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf 'simulator-rebooted-between-unit-phases=1\n' > "$RESULTS/restart-receipt.txt"

# prove the persisted Celsius configuration survives before restoring Fahrenheit
start_log_capture "$RESULTS/restart-and-return-fahrenheit-provider.log"
run_unit_test "test08TemperatureUnitPersistsAfterExtensionRestart" "restart-and-return-fahrenheit"
stop_log_capture

# require one exact current typed summary from a phase-local provider stream
require_unique_summary() {
  local phase_log="$1"
  local unit="$2"
  grep -Eq "widget-info widget-config epoch=[1-9][0-9]* observedAtMs=[1-9][0-9]* status=unique total=[1-9][0-9]* matchCount=1 kind=farm[.]ballydidean[.]weather[.]forecast family=systemMedium unit=${unit}$" "$phase_log"
}

cat "$RESULTS/edit-to-celsius-provider.log" \
  "$RESULTS/restart-and-return-fahrenheit-provider.log" > "$RESULTS/widget-unit.log"

# bind typed and provider values to the two actual execution phases
if ! require_unique_summary "$RESULTS/edit-to-celsius-provider.log" fahrenheit \
  || ! require_unique_summary "$RESULTS/edit-to-celsius-provider.log" celsius \
  || ! require_unique_summary "$RESULTS/restart-and-return-fahrenheit-provider.log" celsius \
  || ! require_unique_summary "$RESULTS/restart-and-return-fahrenheit-provider.log" fahrenheit \
  || ! grep -Fq 'configuration-unit unit=celsius' "$RESULTS/edit-to-celsius-provider.log" \
  || ! grep -Fq 'configuration-unit unit=fahrenheit' "$RESULTS/edit-to-celsius-provider.log" \
  || ! grep -Fq 'configuration-unit unit=celsius' "$RESULTS/restart-and-return-fahrenheit-provider.log" \
  || ! grep -Fq 'configuration-unit unit=fahrenheit' "$RESULTS/restart-and-return-fahrenheit-provider.log"; then
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
shasum -a 256 "$RESULTS/widget-unit.log" \
  "$RESULTS/edit-to-celsius-provider.log" \
  "$RESULTS/restart-and-return-fahrenheit-provider.log" \
  "$RESULTS/attachments.sha256" \
  > "$RESULTS/evidence.sha256"
echo "iOS product temperature-unit AppIntent probe passed: $RESULTS"
