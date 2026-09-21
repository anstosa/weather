#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-persistence}"
DERIVED_DATA="$RESULTS/DerivedData"
APP_BUNDLE_ID="farm.ballydidean.weather"
SELECTOR="WEATHER_V4_PERSISTENCE_PROBE"
SIMULATOR_UDID=""
LOG_PID=""

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"
export WEATHER_RUN_WIDGET_HOST_TEST=1

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
    # require extension-container cleanup
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

# run one actual SpringBoard persistence phase
run_phase() {
  local method="$1"
  local phase="$2"
  local result_bundle="$RESULTS/$phase/WeatherPersistence.xcresult"
  local attachments="$RESULTS/$phase/attachments"
  local test_log="$RESULTS/$phase/test.log"
  local provider_log="$RESULTS/$phase/provider.log"

  mkdir -p "$RESULTS/$phase"
  : > "$provider_log"
  xcrun simctl spawn "$SIMULATOR_UDID" log stream \
    --style compact \
    --level info \
    --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
    > "$provider_log" 2>&1 &
  LOG_PID=$!

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
  local test_status=${PIPESTATUS[0]}
  set -e
  # flush the phase-local process receipts
  kill "$LOG_PID" 2>/dev/null || true
  wait "$LOG_PID" 2>/dev/null || true
  LOG_PID=""
  printf '%s\n' "$test_status" > "$RESULTS/$phase/test-status.txt"

  mkdir -p "$attachments"
  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$attachments" \
    > "$RESULTS/$phase/export-attachments.log" 2>&1

  # reject skipped or attachment-only phases
  if [[ "$test_status" -ne 0 ]] || ! grep -Eq "$method.*passed" "$test_log"; then
    xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/$phase/failure.png" \
      >/dev/null 2>&1 || true
    echo "iOS extension persistence phase failed: $phase" >&2
    exit 78
  fi
}

# extract one public receipt field
receipt_field() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | tr ' ' '\n' | sed -n "s/^${key}=//p" | tail -1
}

# reject reused evidence before preflight creates its directory
if [[ -e "$RESULTS" ]]; then
  echo "widget persistence probe results already exist: $RESULTS" >&2
  exit 78
fi

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# resolve only the pinned device and runtime
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
  "Weather Persistence Probe $$" \
  "$DEVICE_TYPE_IDENTIFIER" \
  "$RUNTIME_IDENTIFIER")"
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
xcrun simctl ui "$SIMULATOR_UDID" appearance light
xcrun simctl ui "$SIMULATOR_UDID" content_size large

{
  xcodebuild -version
  xcrun --sdk iphonesimulator --show-sdk-version
  printf 'device_type=%s\n' "$DEVICE_TYPE_IDENTIFIER"
  printf 'runtime=%s\n' "$RUNTIME_IDENTIFIER"
  printf 'source_commit=%s\n' "$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
} > "$RESULTS/toolchain.txt"

# prove concurrent provider requests share one persisted transition
mkdir -p "$RESULTS/concurrency"
set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme Weather \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULTS/concurrency/WeatherPersistenceConcurrency.xcresult" \
  -only-testing:"WeatherTests/WeatherWidgetPersistenceProbeConcurrencyTests/testConcurrentFahrenheitThenCelsiusTransitionsWriteOnce" \
  -parallel-testing-enabled NO \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $SELECTOR" \
  test | tee "$RESULTS/concurrency/test.log"
CONCURRENCY_STATUS=${PIPESTATUS[0]}
set -e
printf '%s\n' "$CONCURRENCY_STATUS" > "$RESULTS/concurrency/test-status.txt"
# reject skips and failed concurrent execution
if [[ "$CONCURRENCY_STATUS" -ne 0 ]] \
  || ! grep -Eq 'testConcurrentFahrenheitThenCelsiusTransitionsWriteOnce.*passed' \
    "$RESULTS/concurrency/test.log"; then
  echo "iOS persistence concurrency regression failed" >&2
  exit 78
fi

# compile one probe artifact shared by both process phases
xcodebuild \
  -project "$PROJECT" \
  -scheme WeatherWidgetHostTests \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -parallel-testing-enabled NO \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $SELECTOR" \
  build-for-testing | tee "$RESULTS/build-for-testing.log"

# require a genuinely empty extension container before seeding
xcrun simctl uninstall "$SIMULATOR_UDID" "$APP_BUNDLE_ID" \
  > "$RESULTS/pre-test-uninstall.log" 2>&1 || true
run_phase "test15PersistenceSeedAndFailBeforeRestart" "before-restart"

# terminate every extension process without replacing the installed artifact
xcrun simctl shutdown "$SIMULATOR_UDID"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf 'simulator-rebooted-between-persistence-phases=1\n' > "$RESULTS/restart-receipt.txt"
run_phase "test16PersistenceFailureSurvivesExtensionRestart" "after-restart"

BEFORE_LOG="$RESULTS/before-restart/provider.log"
AFTER_LOG="$RESULTS/after-restart/provider.log"

# require exactly one seed and one failed production-controller refresh
if [[ "$(grep -Fc 'persistence-probe phase=fahrenheit action=seed-success' "$BEFORE_LOG")" != "1" ]] \
  || [[ "$(grep -Fc 'persistence-probe phase=celsius action=write-offline' "$BEFORE_LOG")" != "1" ]]; then
  echo "persistence probe did not perform exactly one seed and failure write" >&2
  exit 78
fi
# require phase B to read without manufacturing any state
if ! grep -Fq 'persistence-probe phase=celsius action=read-offline' "$AFTER_LOG" \
  || grep -Eq 'action=(seed-success|write-offline)' "$AFTER_LOG"; then
  echo "persistence restart phase did not remain read-only" >&2
  exit 78
fi
if grep -Fq 'action=invalid-state' "$BEFORE_LOG" "$AFTER_LOG"; then
  echo "persistence probe observed missing or corrupt extension state" >&2
  exit 78
fi

BEFORE_LINE="$(grep -F 'persistence-probe phase=celsius action=write-offline' "$BEFORE_LOG" | tail -1)"
AFTER_LINE="$(grep -F 'persistence-probe phase=celsius action=read-offline' "$AFTER_LOG" | tail -1)"
BEFORE_SNAPSHOT="$(receipt_field "$BEFORE_LINE" snapshot-id)"
AFTER_SNAPSHOT="$(receipt_field "$AFTER_LINE" snapshot-id)"
BEFORE_ATTEMPT="$(receipt_field "$BEFORE_LINE" attempted-at)"
AFTER_ATTEMPT="$(receipt_field "$AFTER_LINE" attempted-at)"
BEFORE_OUTCOME="$(receipt_field "$BEFORE_LINE" outcome)"
AFTER_OUTCOME="$(receipt_field "$AFTER_LINE" outcome)"
BEFORE_PID="$(receipt_field "$BEFORE_LINE" pid)"
AFTER_PID="$(receipt_field "$AFTER_LINE" pid)"

# require exact persisted identities across process death
if [[ -z "$BEFORE_SNAPSHOT" || "$BEFORE_SNAPSHOT" == "missing" ]] \
  || [[ "$BEFORE_SNAPSHOT" != "$AFTER_SNAPSHOT" ]] \
  || [[ -z "$BEFORE_ATTEMPT" || "$BEFORE_ATTEMPT" == "missing" ]] \
  || [[ "$BEFORE_ATTEMPT" != "$AFTER_ATTEMPT" ]] \
  || [[ "$BEFORE_OUTCOME" != "offline" || "$AFTER_OUTCOME" != "offline" ]] \
  || [[ -z "$BEFORE_PID" || "$BEFORE_PID" == "$AFTER_PID" ]]; then
  echo "persistence identity changed or extension process did not restart" >&2
  exit 78
fi

# require the same public WidgetInfo identity before and after restart
BEFORE_WIDGET_IDS="$(
  grep -oE 'widget-info widget-id=[^ ]+ unit=celsius' "$BEFORE_LOG" \
    | sed -E 's/.*widget-id=([^ ]+) unit=.*/\1/' \
    | sort -u
)"
AFTER_WIDGET_IDS="$(
  grep -oE 'widget-info widget-id=[^ ]+ unit=celsius' "$AFTER_LOG" \
    | sed -E 's/.*widget-id=([^ ]+) unit=.*/\1/' \
    | sort -u
)"
BEFORE_WIDGET_ID_COUNT="$(printf '%s\n' "$BEFORE_WIDGET_IDS" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
AFTER_WIDGET_ID_COUNT="$(printf '%s\n' "$AFTER_WIDGET_IDS" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
if [[ "$BEFORE_WIDGET_ID_COUNT" != "1" ]] \
  || [[ "$AFTER_WIDGET_ID_COUNT" != "1" ]] \
  || [[ "$BEFORE_WIDGET_IDS" != "$AFTER_WIDGET_IDS" ]]; then
  echo "typed WidgetInfo identity did not survive the extension restart" >&2
  exit 78
fi

# require genuine before-and-after rendered host evidence
for receipt in \
  persistence-seeded-success-screenshot \
  persistence-before-restart-offline-visible-spoken-screenshot \
  persistence-before-restart-offline-visible-spoken-hierarchy \
  persistence-before-restart-widget-info; do
  # reject incomplete phase-A evidence
  if ! grep -Fq "$receipt" "$RESULTS/before-restart/attachments/manifest.json"; then
    echo "persistence phase A lacks $receipt" >&2
    exit 78
  fi
done
for receipt in \
  persistence-after-restart-offline-visible-spoken-screenshot \
  persistence-after-restart-offline-visible-spoken-hierarchy \
  persistence-after-restart-widget-info; do
  # reject incomplete phase-B evidence
  if ! grep -Fq "$receipt" "$RESULTS/after-restart/attachments/manifest.json"; then
    echo "persistence phase B lacks $receipt" >&2
    exit 78
  fi
done

cat > "$RESULTS/persistence-receipt.txt" <<EOF
source_commit=$(git -C "$IOS_ROOT/../.." rev-parse HEAD)
snapshot_identifier=$BEFORE_SNAPSHOT
failure_attempted_at=$BEFORE_ATTEMPT
failure_outcome=$BEFORE_OUTCOME
before_extension_pid=$BEFORE_PID
after_extension_pid=$AFTER_PID
widget_id=$BEFORE_WIDGET_IDS
phase_b_state_source=read-only
EOF
cat > "$RESULTS/persistence-probe-passed.txt" <<EOF
extension_owned_store=passed
matching_success_required=passed
failed_attempt_process_restart=passed
visible_spoken_offline_weather=passed
EOF
find "$RESULTS/before-restart/attachments" "$RESULTS/after-restart/attachments" \
  -type f -print0 | sort -z | xargs -0 shasum -a 256 > "$RESULTS/attachments.sha256"
shasum -a 256 \
  "$BEFORE_LOG" \
  "$AFTER_LOG" \
  "$RESULTS/restart-receipt.txt" \
  "$RESULTS/concurrency/test-status.txt" \
  "$RESULTS/persistence-receipt.txt" \
  "$RESULTS/persistence-probe-passed.txt" \
  "$RESULTS/attachments.sha256" \
  > "$RESULTS/evidence.sha256"

echo "iOS extension persistence process-restart probe passed: $RESULTS"
