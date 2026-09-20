#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts}"
DERIVED_DATA="$RESULTS/DerivedData"
RESULT_BUNDLE="$RESULTS/Weather.xcresult"
TEST_ATTACHMENTS="$RESULTS/test-attachments"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"
rm -rf "$DERIVED_DATA" "$RESULT_BUNDLE" "$TEST_ATTACHMENTS"
rm -f "$RESULTS/debug-build-passed.txt"
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

# boot the selected simulator
if ! xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  # accept only an already-booted simulator
  if ! grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
    cat "$RESULTS/simulator-boot.stderr" >&2
    exit 1
  fi
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"

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

# run credential-free Simulator tests with normal local signing
set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  test | tee "$RESULTS/test.log"
TEST_STATUS=${PIPESTATUS[0]}

# export success and failure attachments without replacing the test verdict
xcrun xcresulttool export attachments \
  --path "$RESULT_BUNDLE" \
  --output-path "$TEST_ATTACHMENTS" \
  > "$RESULTS/test-attachments-export.log" 2>&1
TEST_ATTACHMENTS_STATUS=$?
set -e
printf '%s\n' "$TEST_STATUS" > "$RESULTS/test-status.txt"
printf '%s\n' "$TEST_ATTACHMENTS_STATUS" > "$RESULTS/test-attachments-export-status.txt"

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
  build analyze | tee "$RESULTS/release-build-analyze.log"

"$SCRIPT_DIR/verify-release-artifacts.sh" "$DERIVED_DATA" "$RESULTS/release-receipts"

echo "iOS M0 build/test/scan passed; actual Home Screen evidence remains a separate gate"
