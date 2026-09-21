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

# retain bounded public system and exact unit-build diagnostics on failure
collect_unit_failure_diagnostics() {
  local phase="$1"
  local directory="$RESULTS/$phase-failure-diagnostics"
  local app="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/Weather.app"
  local extension="$app/PlugIns/WeatherWidgetExtension.appex"
  local outcome=0
  # reject a missing diagnostic destination without changing XCTest's verdict
  if ! mkdir -p "$directory"; then
    return 1
  fi

  # stream only system widget processes into a capped public log
  set +e
  xcrun simctl spawn "$SIMULATOR_UDID" log show \
    --last 12m --style compact --info \
    --predicate 'process == "chronod" OR subsystem BEGINSWITH "com.apple.widgetkit" OR subsystem BEGINSWITH "com.apple.appintents"' \
    | python3 -c '
import collections, pathlib, sys
# account for every source line before retaining a bounded tail
lines = collections.deque(maxlen=200)
input_lines = input_bytes = oversized_lines = 0
for line in sys.stdin.buffer:
    input_lines += 1
    input_bytes += len(line)
    payload = line.rstrip(b"\r\n")
    suffix = b"\r\n" if line.endswith(b"\r\n") else b"\n" if line.endswith(b"\n") else b""
    limit = 1000 - len(suffix)
    clipped = payload[:limit] + suffix
    oversized_lines += int(len(payload) > limit)
    lines.append((clipped, len(payload) > limit))
retained_bytes = sum(len(payload) for payload, _ in lines)
retained_oversized = sum(int(oversized) for _, oversized in lines)
pathlib.Path(sys.argv[1]).write_bytes(b"".join(payload for payload, _ in lines))
pathlib.Path(sys.argv[2]).write_text(
    f"input_line_count={input_lines}\nretained_line_count={len(lines)}\n"
    f"dropped_line_count={input_lines - len(lines)}\n"
    f"oversized_line_count={oversized_lines}\n"
    f"truncated_line_count={input_lines - len(lines) + retained_oversized}\n"
    f"input_byte_count={input_bytes}\nretained_byte_count={retained_bytes}\n"
    f"truncated_byte_count={input_bytes - retained_bytes}\n"
    f"truncated={int(input_lines > len(lines) or input_bytes > retained_bytes)}\n"
)
' "$directory/public-system-widget.log" "$directory/system-log-cap-status.txt"
  local log_statuses=("${PIPESTATUS[@]}")
  set -e
  # record source and cap failures independently of the input counts
  if ! printf 'system_log_source_status=%s\nsystem_log_cap_status=%s\n' \
    "${log_statuses[0]}" "${log_statuses[1]}" \
    > "$directory/system-log-status.txt"; then
    outcome=1
  fi
  # preserve a failed collection without changing XCTest's verdict
  if [[ "${log_statuses[0]}" -ne 0 || "${log_statuses[1]}" -ne 0 ]]; then
    outcome=1
  fi

  # copy only exact extracted public metadata from the unit-built bundles
  for label in app extension; do
    local bundle="$app"
    local executable="Weather"
    # select the embedded extension rather than a generic prior build
    if [[ "$label" == "extension" ]]; then
      bundle="$extension"
      executable="WeatherWidgetExtension"
    fi
    local target="$directory/$label"
    mkdir -p "$target"
    local metadata="$bundle/Metadata.appintents"
    local files=("$bundle/Info.plist" "$metadata/version.json" "$metadata/extract.actionsdata")
    local metadata_status=0
    # reject missing or oversized extracted metadata
    for source in "${files[@]}"; do
      if [[ ! -f "$source" || "$(wc -c < "$source" 2>/dev/null || printf 65537)" -gt 65536 ]]; then
        metadata_status=1
        continue
      fi
      cp "$source" "$target/$(basename "$source")" || metadata_status=1
    done
    # bind copied metadata to the exact built executable
    if [[ -f "$bundle/$executable" ]]; then
      shasum -a 256 "$bundle/$executable" > "$target/executable.sha256" || metadata_status=1
    else
      metadata_status=1
    fi
    # retain a readable property-list receipt when available
    if [[ -f "$bundle/Info.plist" ]]; then
      plutil -p "$bundle/Info.plist" > "$target/info-plist.txt" 2>&1 || metadata_status=1
    fi
    find "$target" -maxdepth 1 -type f ! -name '*.sha256' -print0 \
      | sort -z | xargs -0 shasum -a 256 > "$target/metadata.sha256" || metadata_status=1
    # treat an unwritable metadata receipt as its own collection failure
    if ! printf 'metadata_status=%s\n' "$metadata_status" > "$target/status.txt"; then
      outcome=1
    fi
    # keep collection errors separate from the original failed phase
    if [[ "$metadata_status" -ne 0 ]]; then
      outcome=1
    fi
  done

  # retain the last public typed summary and its bounded matching entries
  python3 - "$RESULTS/$phase-provider.log" "$directory" \
    "$ATTACHMENTS/$phase/manifest.json" "$phase" <<'PY' || outcome=1
from pathlib import Path
import json
import re
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
manifest = Path(sys.argv[3])
phase = sys.argv[4]
lines = source.read_text(errors="replace").splitlines() if source.is_file() else []
summary_indexes = [index for index, line in enumerate(lines) if "widget-info widget-config epoch=" in line]
last_index = summary_indexes[-1] if summary_indexes else -1
latest = lines[last_index][:1000] if last_index >= 0 else ""
summary_pattern = re.compile(
    r"widget-config epoch=\d+ observedAtMs=\d+ status=\S+ total=\d+ "
    r"matchCount=\d+ kind=\S+ family=\S+ unit=\S+"
)
log_summary_match = re.search(r"\b(" + summary_pattern.pattern + r")$", latest)
log_summary = log_summary_match.group(1) if log_summary_match else ""
epoch_match = re.search(r"\bepoch=(\d+)\b", log_summary)
count_match = re.search(r"\bmatchCount=(\d+)\b", log_summary)
epoch = epoch_match.group(1) if epoch_match else ""
count = int(count_match.group(1)) if count_match else -1
# bind entry detail to the final query instance, even after epoch reset
entries = [line[:1000] for line in lines[last_index + 1:] if f"widget-info widget-config-entry epoch={epoch} " in line] if epoch else []
(destination / "last-typed-summary-and-entries.log").write_text("\n".join([latest, *entries[-8:]]) + "\n")
attachments = json.loads(manifest.read_text()) if manifest.is_file() else []
receipt_name = re.compile(r"unit-failure-fresh-typed-observation_\d+_[0-9A-Fa-f-]{36}\.txt")
receipt_candidates = [
    attachment for test in attachments for attachment in test.get("attachments", [])
    if receipt_name.fullmatch(attachment.get("suggestedHumanReadableName", ""))
]
attachment_summary = ""
attachment_present = False
# read only one exact exported text attachment within the phase directory
if len(receipt_candidates) == 1:
    filename = receipt_candidates[0].get("exportedFileName", "")
    attachment_dir = manifest.parent.resolve()
    candidate = (attachment_dir / filename).resolve()
    if filename and Path(filename).name == filename and candidate.suffix == ".txt" \
            and candidate.is_relative_to(attachment_dir) \
            and candidate.is_file():
        attachment_present = True
        # read one extra byte to reject an oversized exported text receipt
        with candidate.open("rb") as content:
            payload = content.read(1001)
        if len(payload) <= 1000:
            attachment_summary = payload.decode("utf-8", errors="replace").strip()
attachment_valid = bool(summary_pattern.fullmatch(attachment_summary))
correlated = attachment_valid and attachment_summary == log_summary
complete = 0 <= count <= 8 and len(entries) == count and (phase != "edit-to-celsius" or correlated)
(destination / "typed-detail-status.txt").write_text(
    f"last_summary_present={int(bool(latest))}\nmatching_count={count}\n"
    f"captured_entry_count={len(entries[-8:])}\nentry_detail_complete={int(complete)}\n"
    f"attachment_present={int(attachment_present)}\n"
    f"attachment_summary_valid={int(attachment_valid)}\nlog_correlation={int(correlated)}\n"
)
if not complete:
    raise SystemExit(1)
PY
  # surface collection receipt failures without replacing the test verdict
  if ! printf 'diagnostic_collection_status=%s\n' "$outcome" > "$directory/collection-status.txt"; then
    return 1
  fi
  return "$outcome"
}

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
    local diagnostic_status=0
    # finish the phase log before reading public diagnostic receipts
    stop_log_capture
    collect_unit_failure_diagnostics "$phase" || diagnostic_status=$?
    printf 'failure_diagnostic_status=%s\n' "$diagnostic_status" \
      > "$RESULTS/$phase-failure-diagnostic-status.txt"
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
