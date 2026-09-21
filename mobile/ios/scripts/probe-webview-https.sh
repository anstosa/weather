#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/webview-https}"
DERIVED_DATA="$RESULTS/DerivedData"
RESULT_BUNDLE="$RESULTS/WeatherHTTPS.xcresult"
ATTACHMENTS="$RESULTS/attachments"
ATTACHMENT_MANIFEST="$ATTACHMENTS/manifest.json"
SIMULATOR_UDID=""
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"
export WEATHER_RUN_HTTPS_FIXTURE_TEST=1

# delete only this probe's disposable simulator and log process
cleanup() {
  local status=$?
  trap - EXIT TERM
  # stop only this probe's bounded log stream
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
  # delete only the simulator created by this probe
  if [[ -n "$SIMULATOR_UDID" ]]; then
    xcrun simctl shutdown "$SIMULATOR_UDID" >/dev/null 2>&1 || true
    # fail the probe when the disposable trust container survives
    if xcrun simctl delete "$SIMULATOR_UDID" >/dev/null 2>&1; then
      printf 'disposable_simulator_deleted=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
    else
      printf 'disposable_simulator_delete_failed=%s\n' "$SIMULATOR_UDID" \
        > "$RESULTS/simulator-cleanup.txt"
      status=78
    fi
  fi
  exit "$status"
}
trap cleanup EXIT TERM

# require the shared wrapper's exact public inputs
for variable in \
  WEATHER_HTTPS_FIXTURE_CA_PEM \
  WEATHER_HTTPS_FIXTURE_IOS_ORIGIN \
  WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN \
  WEATHER_HTTPS_FIXTURE_USERNAME \
  WEATHER_HTTPS_FIXTURE_PASSWORD; do
  # reject an incomplete fixture process
  if [[ -z "${!variable:-}" ]]; then
    echo "missing shared HTTPS fixture variable: $variable" >&2
    exit 78
  fi
done
if [[ ! -f "$WEATHER_HTTPS_FIXTURE_CA_PEM" ]]; then
  echo "shared HTTPS fixture CA is not a file" >&2
  exit 78
fi
if [[ "$WEATHER_HTTPS_FIXTURE_IOS_ORIGIN" != "https://127.0.0.1:18443" ]] \
  || [[ "$WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN" != "https://127.0.0.1:18444" ]]; then
  echo "shared HTTPS fixture origins do not match the frozen iOS contract" >&2
  exit 78
fi

# reject reused journey evidence before preflight creates its own directory
if [[ -e "$RESULTS" ]]; then
  echo "HTTPS fixture probe results already exist: $RESULTS" >&2
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
  "Weather HTTPS Fixture $$" \
  "$DEVICE_TYPE_IDENTIFIER" \
  "$RUNTIME_IDENTIFIER")"
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b

# archive the installed keychain interface and trust only the positive CA
xcrun simctl help keychain > "$RESULTS/simctl-keychain-help.txt"
xcrun simctl keychain "$SIMULATOR_UDID" add-root-cert "$WEATHER_HTTPS_FIXTURE_CA_PEM"
shasum -a 256 "$WEATHER_HTTPS_FIXTURE_CA_PEM" > "$RESULTS/trusted-ca.sha256"
{
  xcodebuild -version
  xcrun --sdk iphonesimulator --show-sdk-version
  printf 'device_type=%s\n' "$DEVICE_TYPE_IDENTIFIER"
  printf 'runtime=%s\n' "$RUNTIME_IDENTIFIER"
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
} > "$RESULTS/toolchain.txt"

# capture bounded native TLS and navigation failures
: > "$RESULTS/webview-lifecycle.log"
xcrun simctl spawn "$SIMULATOR_UDID" log stream \
  --style compact \
  --level info \
  --predicate 'subsystem == "farm.ballydidean.weather"' \
  > "$RESULTS/webview-lifecycle.log" 2>&1 &
LOG_PID=$!

set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:WeatherUITests/WeatherDeepLinkUITests/testHTTPSFixtureJourneys \
  -parallel-testing-enabled NO \
  test | tee "$RESULTS/webview-https-test.log"
TEST_STATUS=${PIPESTATUS[0]}
set -e
printf '%s\n' "$TEST_STATUS" > "$RESULTS/webview-https-status.txt"

# export journey screenshots and hierarchies without replacing the verdict
mkdir -p "$ATTACHMENTS"
xcrun xcresulttool export attachments \
  --path "$RESULT_BUNDLE" \
  --output-path "$ATTACHMENTS" \
  > "$RESULTS/export-attachments.log" 2>&1

# flush the native log before receipt checks
if kill -0 "$LOG_PID" 2>/dev/null; then
  kill "$LOG_PID" 2>/dev/null || true
  wait "$LOG_PID" 2>/dev/null || true
fi
LOG_PID=""

# require executed journeys and the default WebKit certificate failure
if [[ "$TEST_STATUS" -ne 0 ]] \
  || ! grep -Eq 'testHTTPSFixtureJourneys.*passed' "$RESULTS/webview-https-test.log" \
  || ! grep -Fq 'https-fixture-load path=/admin' "$RESULTS/webview-lifecycle.log" \
  || ! grep -Eq 'https-fixture-load path=/$' "$RESULTS/webview-lifecycle.log" \
  || ! grep -Fq 'did-finish path=/logs' "$RESULTS/webview-lifecycle.log" \
  || ! grep -Fq 'did-finish path=/trends' "$RESULTS/webview-lifecycle.log" \
  || ! grep -Fq 'provisional-fail domain=NSURLErrorDomain code=-1202' "$RESULTS/webview-lifecycle.log" \
  || ! grep -Fq 'https-fixture-authenticated-celsius-screenshot' "$ATTACHMENT_MANIFEST" \
  || ! grep -Fq 'https-fixture-authenticated-celsius-webview-hierarchy' "$ATTACHMENT_MANIFEST" \
  || ! grep -Fq 'https-fixture-untrusted-retry-screenshot' "$ATTACHMENT_MANIFEST" \
  || ! grep -Fq 'https-fixture-untrusted-retry-webview-hierarchy' "$ATTACHMENT_MANIFEST"; then
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/failure.png" >/dev/null 2>&1 || true
  echo "real iOS HTTPS WebView journeys failed; see $RESULTS" >&2
  exit 78
fi

find "$ATTACHMENTS" -type f -print0 | sort -z | xargs -0 shasum -a 256 \
  > "$RESULTS/attachments.sha256"
shasum -a 256 \
  "$RESULTS/webview-https-test.log" \
  "$RESULTS/webview-lifecycle.log" \
  "$RESULTS/attachments.sha256" \
  > "$RESULTS/evidence.sha256"
printf 'source_commit=%s\nwebview_https_journeys=passed\ntrusted_tls=passed\nuntrusted_tls_rejected=passed\n' \
  "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)" \
  > "$RESULTS/webview-https-passed.txt"
echo "iOS real HTTPS WebView journeys passed: $RESULTS"
