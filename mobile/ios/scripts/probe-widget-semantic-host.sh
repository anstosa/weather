#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-semantic-host}"
APP_BUNDLE_ID="farm.ballydidean.weather"
DEVICE_TYPE_IDENTIFIER=""
RUNTIME_IDENTIFIER=""
SIMULATOR_UDID=""
ACTIVE_CASE_ID=""
SIMULATOR_DELETE_FAILED=0
TERMINATION_REQUESTED=0
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

# stop only the current bounded provider log
stop_log_capture() {
  # flush one active semantic case
  if [[ -n "$LOG_PID" ]]; then
    # terminate only the active log process
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
    LOG_PID=""
  fi
}

# delete only the active simulator created for one semantic case
delete_active_simulator() {
  local context="$1"
  local case_results="$RESULTS/cases/$ACTIVE_CASE_ID"

  stop_log_capture
  # reject cleanup without a complete ownership record
  if [[ -z "$SIMULATOR_UDID" || -z "$ACTIVE_CASE_ID" ]]; then
    echo "semantic simulator cleanup lacks an active owned case" >&2
    return 1
  fi

  xcrun simctl shutdown "$SIMULATOR_UDID" \
    > "$case_results/simulator-shutdown-$context.log" 2>&1 || true
  # clear ownership only after deleting the exact created device
  if xcrun simctl delete "$SIMULATOR_UDID" \
      > "$case_results/simulator-delete-$context.log" 2>&1; then
    # fail closed when the successful deletion receipt cannot be written
    if ! printf 'disposable_simulator_deleted=%s\ncleanup_context=%s\n' \
        "$SIMULATOR_UDID" "$context" >> "$case_results/simulator-cleanup.txt"; then
      SIMULATOR_DELETE_FAILED=1
      return 1
    fi
    SIMULATOR_UDID=""
    ACTIVE_CASE_ID=""
    return 0
  fi

  printf 'disposable_simulator_delete_failed=%s\ncleanup_context=%s\n' \
    "$SIMULATOR_UDID" "$context" >> "$case_results/simulator-cleanup.txt" || true
  SIMULATOR_DELETE_FAILED=1
  return 1
}

# flush logs and delete only the active owned case simulator
cleanup() {
  local status=$?
  trap - EXIT TERM
  stop_log_capture
  # preserve signal cancellation even between child commands
  if [[ "$TERMINATION_REQUESTED" == 1 ]]; then
    status=143
  fi
  # remove only a case device whose ownership is still active
  if [[ -n "$SIMULATOR_UDID" && -n "$ACTIVE_CASE_ID" ]]; then
    # fail closed when the exact owned device survives cleanup
    if ! delete_active_simulator "trap"; then
      status=78
    fi
  fi
  # retain a prior deletion failure even when trap cleanup later succeeds
  if [[ "$SIMULATOR_DELETE_FAILED" == 1 ]]; then
    status=78
  fi
  exit "$status"
}

# convert termination into fail-closed exit cleanup
handle_term() {
  TERMINATION_REQUESTED=1
  cleanup
}
trap cleanup EXIT
trap handle_term TERM

# compile and host one decoded frozen fixture on one owned simulator
run_case() {
  local case_id="$1"
  local fixture="$2"
  local selector="$3"
  local method="$4"
  local expected="$5"
  local case_results="$RESULTS/cases/$case_id"
  local derived_data="$RESULTS/DerivedData/$fixture"
  local result_bundle="$case_results/WeatherSemanticHost.xcresult"
  local attachments="$case_results/attachments"
  local owned_udid=""

  mkdir -p "$case_results"
  # reject overlapping case ownership
  if [[ -n "$SIMULATOR_UDID" || -n "$ACTIVE_CASE_ID" ]]; then
    echo "semantic simulator ownership overlaps case: $case_id" >&2
    exit 78
  fi

  ACTIVE_CASE_ID="$case_id"
  SIMULATOR_UDID="$(xcrun simctl create \
    "Weather Semantic Host ${case_id} $$" \
    "$DEVICE_TYPE_IDENTIFIER" \
    "$RUNTIME_IDENTIFIER")"
  owned_udid="$SIMULATOR_UDID"
  printf '%s\n' "$SIMULATOR_UDID" > "$case_results/simulator-udid.txt"
  printf 'case=%s\ndevice_type=%s\nruntime=%s\n' \
    "$case_id" "$DEVICE_TYPE_IDENTIFIER" "$RUNTIME_IDENTIFIER" \
    > "$case_results/simulator-ownership.txt"
  xcrun simctl boot "$SIMULATOR_UDID" \
    > "$case_results/simulator-boot.log" 2>&1
  xcrun simctl bootstatus "$SIMULATOR_UDID" -b \
    > "$case_results/simulator-bootstatus.log" 2>&1
  xcrun simctl ui "$SIMULATOR_UDID" appearance light
  xcrun simctl ui "$SIMULATOR_UDID" content_size large
  printf 'appearance=light\ncontent_size=large\n' \
    > "$case_results/simulator-visual-settings.txt"

  # build one isolated compile-time fixture artifact
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$derived_data" \
    -parallel-testing-enabled NO \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $selector" \
    build-for-testing | tee "$case_results/build-for-testing.log"

  # require a fresh public placement for the new artifact
  xcrun simctl uninstall "$SIMULATOR_UDID" "$APP_BUNDLE_ID" \
    > "$case_results/pre-test-uninstall.log" 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_UDID" log stream \
    --style compact \
    --level info \
    --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
    > "$case_results/provider-and-route.log" 2>&1 &
  LOG_PID=$!

  set +e
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$derived_data" \
    -resultBundlePath "$result_bundle" \
    -only-testing:"WeatherUITests/WidgetHostUITests/$method" \
    -parallel-testing-enabled NO \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $selector" \
    test-without-building | tee "$case_results/test.log"
  local test_status=${PIPESTATUS[0]}
  set -e
  stop_log_capture
  printf '%s\n' "$test_status" > "$case_results/test-status.txt"

  mkdir -p "$attachments"
  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$attachments" \
    > "$case_results/export-attachments.log" 2>&1

  # require executed host assertions, decoded provider receipt, and fixed tap route
  if [[ "$test_status" -ne 0 ]] \
    || ! grep -Eq "$method.*passed" "$case_results/test.log" \
    || ! grep -Fq "$expected" "$case_results/provider-and-route.log" \
    || ! grep -Fq 'route=forecast source=deep-link' "$case_results/provider-and-route.log"; then
    xcrun simctl io "$SIMULATOR_UDID" screenshot "$case_results/failure.png" \
      >/dev/null 2>&1 || true
    echo "semantic WidgetKit host case failed: $case_id" >&2
    exit 78
  fi

  # require rendered, bounds, and primary-route attachments
  for receipt in \
    "matrix-$case_id-home-screen" \
    "matrix-$case_id-widgetkit-bounds" \
    "matrix-$case_id-widget-tap-forecast-route"; do
    # reject a provider-only result without host evidence
    if ! grep -Fq "$receipt" "$attachments/manifest.json"; then
      echo "semantic WidgetKit host case lacks $receipt" >&2
      exit 78
    fi
  done
  printf '%s\t%s\t%s\n' "$case_id" "$fixture" "$selector" >> "$RESULTS/cases.tsv"
  printf '%s\tpassed\t%s\n' "$case_id" "$expected" >> "$RESULTS/semantic-host.log"

  # require deletion before the next semantic case can start
  if ! delete_active_simulator "case"; then
    echo "semantic simulator deletion failed: $case_id" >&2
    exit 78
  fi
  # validate the exact per-case ownership and deletion receipts
  if [[ "$(cat "$case_results/simulator-udid.txt")" != "$owned_udid" ]] \
    || ! grep -Fxq "disposable_simulator_deleted=$owned_udid" \
      "$case_results/simulator-cleanup.txt" \
    || grep -Fq 'disposable_simulator_delete_failed=' \
      "$case_results/simulator-cleanup.txt"; then
    echo "semantic simulator deletion receipt failed: $case_id" >&2
    exit 78
  fi
}

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# reject reused semantic-host evidence
if [[ -e "$RESULTS/cases" || -e "$RESULTS/DerivedData" ]]; then
  echo "semantic host evidence already exists under $RESULTS" >&2
  exit 78
fi
mkdir -p "$RESULTS/cases" "$RESULTS/DerivedData"
: > "$RESULTS/cases.tsv"
: > "$RESULTS/semantic-host.log"

# resolve the pinned type and runtime once without borrowing a device
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

{
  xcodebuild -version
  xcrun --sdk iphonesimulator --show-sdk-version
  printf 'device_type=%s\n' "$DEVICE_TYPE_IDENTIFIER"
  printf 'runtime=%s\n' "$RUNTIME_IDENTIFIER"
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
} > "$RESULTS/toolchain.txt"

# exercise all six frozen shared semantic fixtures through the production decoder/view
run_case "09-adjusted-standard" "adjusted-standard" "WEATHER_V4_FIXTURE_ADJUSTED" \
  "test09AdjustedStandardSemanticHost" \
  "v4-decoded-fixture name=adjusted-standard schema=weather-widget/v1 groups=7 status=adjusted stale=false unit=fahrenheit"
run_case "10-fall-back" "fall-back-25" "WEATHER_V4_FIXTURE_FALL_BACK" \
  "test10FallBackSemanticHost" \
  "v4-decoded-fixture name=fall-back-25 schema=weather-widget/v1 groups=7 status=raw stale=false unit=fahrenheit"
run_case "11-midnight-race" "midnight-race" "WEATHER_V4_FIXTURE_MIDNIGHT" \
  "test11MidnightRaceSemanticHost" \
  "v4-decoded-fixture name=midnight-race schema=weather-widget/v1 groups=0 status=unavailable stale=false unit=fahrenheit"
run_case "12-missing-raw-at-expiry" "missing-raw-at-expiry" "WEATHER_V4_FIXTURE_MIXED" \
  "test12MissingRawSemanticHost" \
  "v4-decoded-fixture name=missing-raw-at-expiry schema=weather-widget/v1 groups=6 status=mixed stale=false unit=celsius"
run_case "13-spring-forward" "spring-forward-23" "WEATHER_V4_FIXTURE_SPRING" \
  "test13SpringForwardSemanticHost" \
  "v4-decoded-fixture name=spring-forward-23 schema=weather-widget/v1 groups=7 status=raw stale=false unit=celsius"
run_case "14-stale-old-source" "stale-old-source" "WEATHER_V4_FIXTURE_STALE" \
  "test14StaleOldSourceSemanticHost" \
  "v4-decoded-fixture name=stale-old-source schema=weather-widget/v1 groups=7 status=raw stale=true unit=fahrenheit"

# preserve facts while leaving pixel judgment to the independent gate
printf '%s\n' \
  "semantic host assertions passed; independent clipping, contrast, and text-visibility review remains required" \
  > "$RESULTS/visual-review-required.txt"
printf 'source_commit=%s\nsemantic_host_cases=6\nsemantic_host_assertions=passed\n' \
  "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)" \
  > "$RESULTS/semantic-host-passed.txt"
find "$RESULTS/cases" -type f -print0 | sort -z | xargs -0 shasum -a 256 \
  > "$RESULTS/evidence.sha256"
shasum -a 256 "$RESULTS/cases.tsv" "$RESULTS/semantic-host.log" \
  "$RESULTS/semantic-host-passed.txt" "$RESULTS/visual-review-required.txt" \
  >> "$RESULTS/evidence.sha256"
echo "iOS shared semantic WidgetKit host assertions passed: $RESULTS"
