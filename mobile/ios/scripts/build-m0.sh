#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts}"
DERIVED_DATA="$RESULTS/DerivedData"
RESULT_BUNDLE="$RESULTS/Weather.xcresult"
TEST_ATTACHMENTS="$RESULTS/test-attachments"
SIMULATOR_UDID=""
SIMULATOR_BOOT_OWNED=0
SIMULATOR_ALREADY_BOOTED=0
TEST_APP_LIFECYCLE_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

# flush diagnostics and release only this script's simulator boot
cleanup() {
  local status=$?
  trap - EXIT
  # stop a stream left active by an earlier failure
  if [[ -n "$TEST_APP_LIFECYCLE_PID" ]]; then
    # terminate only this script's log process
    kill "$TEST_APP_LIFECYCLE_PID" 2>/dev/null || true
    wait "$TEST_APP_LIFECYCLE_PID" 2>/dev/null || true
  fi
  # shut down only a simulator this script booted
  if [[ "$SIMULATOR_BOOT_OWNED" == 1 ]]; then
    # record the exact owned shutdown outcome
    if xcrun simctl shutdown "$SIMULATOR_UDID" > "$RESULTS/simulator-shutdown.log" 2>&1; then
      printf 'self_booted_simulator_shutdown=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
      cat "$RESULTS/simulator-cleanup.txt"
    else
      printf 'self_booted_simulator_shutdown_failed=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
      cat "$RESULTS/simulator-cleanup.txt"
      # retain an earlier failure instead of replacing it
      if [[ "$status" -eq 0 ]]; then
        status=78
      fi
    fi
  # preserve an already-booted simulator owned elsewhere
  elif [[ "$SIMULATOR_ALREADY_BOOTED" == 1 ]]; then
    printf 'preexisting_booted_simulator_preserved=%s\n' "$SIMULATOR_UDID" \
      > "$RESULTS/simulator-cleanup.txt"
    cat "$RESULTS/simulator-cleanup.txt"
  fi
  exit "$status"
}
trap cleanup EXIT

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"
rm -rf "$DERIVED_DATA" "$RESULT_BUNDLE" "$TEST_ATTACHMENTS"
rm -f "$RESULTS/debug-build-passed.txt" "$RESULTS/release-validation-passed.txt"
mkdir -p "$RESULTS"

# record actual project targets and shared schemes
xcodebuild -project "$PROJECT" -list -json > "$RESULTS/project-list.json"

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

# compile the app and embedded widget without publisher signing
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build | tee "$RESULTS/debug-build.log"
printf 'source_commit=%s\ndebug_build=passed\n' \
  "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)" \
  > "$RESULTS/debug-build-passed.txt"

# boot only after the generic Debug artifact exists
if xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  SIMULATOR_BOOT_OWNED=1
# preserve a simulator already booted before this script
elif grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
  SIMULATOR_ALREADY_BOOTED=1
else
  cat "$RESULTS/simulator-boot.stderr" >&2
  exit 1
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"

# stream diagnostics before tests can stop the Simulator
set +e
: > "$RESULTS/test-app-lifecycle.log"
xcrun simctl spawn "$SIMULATOR_UDID" log stream \
  --style compact \
  --level debug \
  --predicate 'subsystem == "farm.ballydidean.weather"' \
  > "$RESULTS/test-app-lifecycle.log" 2>&1 &
TEST_APP_LIFECYCLE_PID=$!
kill -0 "$TEST_APP_LIFECYCLE_PID" 2>/dev/null
TEST_APP_LIFECYCLE_START_STATUS=$?

# run credential-free Simulator tests with normal local signing
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -parallel-testing-enabled NO \
  test | tee "$RESULTS/test.log"
TEST_STATUS=${PIPESTATUS[0]}

# export success and failure attachments without replacing the test verdict
xcrun xcresulttool export attachments \
  --path "$RESULT_BUNDLE" \
  --output-path "$TEST_ATTACHMENTS" \
  > "$RESULTS/test-attachments-export.log" 2>&1
TEST_ATTACHMENTS_STATUS=$?
# stop only the bounded lifecycle stream
if kill -0 "$TEST_APP_LIFECYCLE_PID" 2>/dev/null; then
  kill "$TEST_APP_LIFECYCLE_PID" 2>/dev/null
  wait "$TEST_APP_LIFECYCLE_PID"
  TEST_APP_LIFECYCLE_PROCESS_STATUS=$?
  TEST_APP_LIFECYCLE_STATUS=0
else
  wait "$TEST_APP_LIFECYCLE_PID"
  TEST_APP_LIFECYCLE_PROCESS_STATUS=$?
  TEST_APP_LIFECYCLE_STATUS=$TEST_APP_LIFECYCLE_PROCESS_STATUS
fi
TEST_APP_LIFECYCLE_PID=""
set -e
printf '%s\n' "$TEST_STATUS" > "$RESULTS/test-status.txt"
printf '%s\n' "$TEST_ATTACHMENTS_STATUS" > "$RESULTS/test-attachments-export-status.txt"
printf '%s\n' "$TEST_APP_LIFECYCLE_START_STATUS" > "$RESULTS/test-app-lifecycle-start-status.txt"
printf '%s\n' "$TEST_APP_LIFECYCLE_PROCESS_STATUS" > "$RESULTS/test-app-lifecycle-process-status.txt"
printf '%s\n' "$TEST_APP_LIFECYCLE_STATUS" > "$RESULTS/test-app-lifecycle-status.txt"

# stop after preserving a failed test result
if [[ "$TEST_STATUS" -ne 0 ]]; then
  echo "iOS Simulator tests failed; see $RESULTS/test.log and $RESULT_BUNDLE" >&2
  exit "$TEST_STATUS"
fi

# compile and analyze the unsigned Release configuration
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build analyze 2>&1 | tee "$RESULTS/release-build-analyze.log"

"$SCRIPT_DIR/verify-release-artifacts.sh" "$DERIVED_DATA" "$RESULTS/release-receipts"
printf 'source_commit=%s\nrelease_build_analyze=passed\nrelease_artifact_isolation=passed\n' \
  "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)" \
  > "$RESULTS/release-validation-passed.txt"

echo "iOS M0 build/test/scan passed; actual Home Screen evidence remains a separate gate"
