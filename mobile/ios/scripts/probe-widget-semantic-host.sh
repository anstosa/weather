#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-semantic-host}"
APP_BUNDLE_ID="farm.ballydidean.weather"
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

# stop only the current bounded provider log
cleanup() {
  # flush one active semantic case
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# compile and host one decoded frozen fixture
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

  mkdir -p "$case_results"
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
  cleanup
  LOG_PID=""
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
}

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# select the pinned runtime and device
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

# reject reused semantic-host evidence
if [[ -e "$RESULTS/cases" || -e "$RESULTS/DerivedData" ]]; then
  echo "semantic host evidence already exists under $RESULTS" >&2
  exit 78
fi
mkdir -p "$RESULTS/cases" "$RESULTS/DerivedData"
: > "$RESULTS/cases.tsv"
: > "$RESULTS/semantic-host.log"

# boot and pin normal visual state for semantic evidence
if ! xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  # accept only an already-booted simulator
  if ! grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
    exit 1
  fi
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
xcrun simctl ui "$SIMULATOR_UDID" appearance light
xcrun simctl ui "$SIMULATOR_UDID" content_size large
{
  xcodebuild -version
  xcrun --sdk iphonesimulator --show-sdk-version
  printf 'simulator_udid=%s\n' "$SIMULATOR_UDID"
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
