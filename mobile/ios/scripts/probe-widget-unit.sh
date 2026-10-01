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

  # bind compact log timestamps to the runner clock and exact UI anchors
  local clock_reading=""
  local clock_status=0
  clock_reading="$(date '+%s %z')" || clock_status=$?
  # stream only system widget processes into bounded public receipts
  set +e
  xcrun simctl spawn "$SIMULATOR_UDID" log show \
    --last 12m --style compact --info \
    --predicate 'process == "chronod" OR subsystem BEGINSWITH "com.apple.widgetkit" OR subsystem BEGINSWITH "com.apple.appintents"' \
    | python3 -c '
import collections, datetime, json, pathlib, re, sys

directory = pathlib.Path(sys.argv[1])
manifest = pathlib.Path(sys.argv[2])
phase = sys.argv[3]
clock_reading = sys.argv[4]
clock_status = int(sys.argv[5])
clock_match = re.fullmatch(r"(\d+) ([+-])(\d{2})(\d{2})", clock_reading)
clock_epoch = int(clock_match.group(1)) if clock_match else 0
clock_offset = clock_match.group(2) + clock_match.group(3) + clock_match.group(4) if clock_match else "invalid"
offset_minutes = (1 if clock_match and clock_match.group(2) == "+" else -1) * (
    int(clock_match.group(3)) * 60 + int(clock_match.group(4))
) if clock_match else 0
clock_valid = clock_status == 0 and bool(clock_match) and abs(offset_minutes) <= 14 * 60
zone = datetime.timezone(datetime.timedelta(minutes=offset_minutes)) if clock_valid else None

# reject absent or ambiguous public edit screenshots as window anchors
anchor_status = "not-required" if phase != "edit-to-celsius" else "missing"
selected = dismissed = requested_start = requested_end = None
if phase == "edit-to-celsius":
    try:
        # reject oversized or absent export manifests
        if not manifest.is_file() or manifest.stat().st_size > 262144:
            raise ValueError("manifest-missing-or-oversized")
        attachments = json.loads(manifest.read_text())
        names = (
            "unit-selected-celsius-screenshot",
            "unit-target-after-celsius-dismissal-screenshot",
        )
        anchors = []
        # require one selected and one dismissed screenshot
        for base in names:
            pattern = re.compile(re.escape(base) + r"_\d+_[0-9A-Fa-f-]{36}\.png")
            matches = [
                item for test in attachments for item in test.get("attachments", [])
                if pattern.fullmatch(item.get("suggestedHumanReadableName", ""))
            ]
            # reject missing or duplicate public anchors
            if len(matches) != 1:
                anchor_status = "ambiguous" if len(matches) > 1 else "missing"
                break
            # require the actual exported screenshot inside this phase
            filename = matches[0].get("exportedFileName", "")
            exported = (manifest.parent / filename).resolve()
            if not filename or pathlib.Path(filename).name != filename or exported.suffix != ".png" \
                    or not exported.is_relative_to(manifest.parent.resolve()) or not exported.is_file():
                anchor_status = "invalid"
                break
            anchors.append(float(matches[0]["timestamp"]))
        # bound the edit transaction inside the queried log range
        if len(anchors) == 2:
            selected, dismissed = anchors
            requested_start = selected - 30
            requested_end = dismissed + 60
            # require the whole requested window inside --last 12m
            anchor_status = "present" if clock_valid and 0 <= dismissed - selected <= 120 \
                and clock_epoch - 720 <= requested_start \
                and requested_end <= clock_epoch else "invalid"
    except (OSError, ValueError, KeyError, TypeError):
        anchor_status = "invalid"

timestamp = re.compile(rb"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) ")
# retain the older edit boundary even when many later records arrive
lines = collections.deque(maxlen=200)
input_lines = input_bytes = oversized_lines = 0
excluded_lines = excluded_bytes = unparsed_lines = unparsed_bytes = 0
window_lines = window_bytes = retained_lines = retained_bytes_window = 0
truncated_lines = truncated_bytes_window = 0
current_record = first_record = last_record = first_window_record = last_window_record = None
with (directory / "focused-system-widget.log").open("wb") as focused:
    # classify each source line without buffering the full log
    for line in sys.stdin.buffer:
        input_lines += 1
        input_bytes += len(line)
        payload = line.rstrip(b"\r\n")
        suffix = b"\r\n" if line.endswith(b"\r\n") else b"\n" if line.endswith(b"\n") else b""
        limit = 1000 - len(suffix)
        clipped = payload[:limit] + suffix
        oversized_lines += int(len(payload) > limit)
        lines.append((clipped, len(payload) > limit))

        # attach continuation lines to their preceding dated record
        match = timestamp.match(line)
        # parse only complete compact timestamps
        if match:
            try:
                local_time = datetime.datetime.strptime(match.group(1).decode(), "%Y-%m-%d %H:%M:%S.%f")
                current_record = local_time.replace(tzinfo=zone).timestamp() if zone else None
                first_record = current_record if first_record is None else first_record
                last_record = current_record
            except ValueError:
                current_record = None
        elif re.match(rb"^\d{4}-\d{2}-\d{2} ", line):
            current_record = None
        # count lines without a valid parent record separately
        if current_record is None:
            unparsed_lines += 1
            unparsed_bytes += len(line)
        elif anchor_status == "present" and requested_start <= current_record <= requested_end:
            window_lines += 1
            window_bytes += len(line)
            first_window_record = current_record if first_window_record is None else first_window_record
            last_window_record = current_record
            # preserve the earliest edit records before the cap fills
            if retained_bytes_window + len(line) <= 4 * 1024 * 1024:
                focused.write(line)
                retained_lines += 1
                retained_bytes_window += len(line)
            else:
                truncated_lines += 1
                truncated_bytes_window += len(line)
        else:
            excluded_lines += 1
            excluded_bytes += len(line)
retained_bytes = sum(len(payload) for payload, _ in lines)
retained_oversized = sum(int(oversized) for _, oversized in lines)
clock_aligned = bool(clock_valid and last_record is not None and abs(last_record - clock_epoch) <= 180)
(directory / "public-system-widget.log").write_bytes(b"".join(payload for payload, _ in lines))
(directory / "system-log-cap-status.txt").write_text(
    f"input_line_count={input_lines}\nretained_line_count={len(lines)}\n"
    f"dropped_line_count={input_lines - len(lines)}\n"
    f"oversized_line_count={oversized_lines}\n"
    f"truncated_line_count={input_lines - len(lines) + retained_oversized}\n"
    f"input_byte_count={input_bytes}\nretained_byte_count={retained_bytes}\n"
    f"truncated_byte_count={input_bytes - retained_bytes}\n"
    f"truncated={int(input_lines > len(lines) or input_bytes > retained_bytes)}\n"
)
(directory / "focused-system-widget-status.txt").write_text(
    f"anchor_status={anchor_status}\nclock_source=runner-date\nclock_command_status={clock_status}\n"
    f"runner_epoch={clock_epoch}\nrunner_offset={clock_offset}\n"
    f"first_source_record_epoch={first_record or 0}\nlast_source_record_epoch={last_record or 0}\n"
    f"clock_aligned={int(clock_aligned)}\n"
    f"last_source_clock_delta_seconds={(last_record - clock_epoch) if last_record is not None else 0}\n"
    f"selected_anchor_epoch={selected or 0}\ndismissed_anchor_epoch={dismissed or 0}\n"
    f"requested_start_epoch={requested_start or 0}\nrequested_end_epoch={requested_end or 0}\n"
    f"observed_first_epoch={first_window_record or 0}\nobserved_last_epoch={last_window_record or 0}\n"
    f"source_line_count={input_lines}\nsource_byte_count={input_bytes}\n"
    f"window_line_count={window_lines}\nwindow_byte_count={window_bytes}\n"
    f"retained_line_count={retained_lines}\nretained_byte_count={retained_bytes_window}\n"
    f"truncated_line_count={truncated_lines}\ntruncated_byte_count={truncated_bytes_window}\n"
    f"excluded_line_count={excluded_lines}\nexcluded_byte_count={excluded_bytes}\n"
    f"unparsed_line_count={unparsed_lines}\nunparsed_byte_count={unparsed_bytes}\n"
    f"truncated={int(truncated_lines > 0)}\n"
)
# fail incomplete diagnostic evidence without changing XCTest
if phase == "edit-to-celsius" and (
    anchor_status != "present" or not clock_aligned or window_lines == 0 or truncated_lines > 0
):
    raise SystemExit(1)
' "$directory" "$ATTACHMENTS/$phase/manifest.json" "$phase" "$clock_reading" "$clock_status"
  local log_statuses=("${PIPESTATUS[@]}")
  set -e
  # record source and cap failures independently of the input counts
  if ! printf 'system_log_source_status=%s\nsystem_log_cap_status=%s\nclock_command_status=%s\n' \
    "${log_statuses[0]}" "${log_statuses[1]}" "$clock_status" \
    > "$directory/system-log-status.txt"; then
    outcome=1
  fi
  # preserve a failed collection without changing XCTest's verdict
  if [[ "${log_statuses[0]}" -ne 0 || "${log_statuses[1]}" -ne 0 || "$clock_status" -ne 0 ]]; then
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
    r"matchCount=\d+ kind=\S+ family=\S+ entries=\S+"
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
date +%z > "$RESULTS/edit-to-celsius-utc-offset.txt"
start_log_capture "$RESULTS/edit-to-celsius-provider.log"
run_unit_test "test07TemperatureUnitEditToCelsius" "edit-to-celsius"
stop_log_capture

# force an extension-process restart without reading private state
xcrun simctl shutdown "$SIMULATOR_UDID"
xcrun simctl boot "$SIMULATOR_UDID"
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
printf 'simulator-rebooted-between-unit-phases=1\n' > "$RESULTS/restart-receipt.txt"

# prove the persisted Celsius configuration survives before restoring Fahrenheit
date +%z > "$RESULTS/restart-and-return-fahrenheit-utc-offset.txt"
start_log_capture "$RESULTS/restart-and-return-fahrenheit-provider.log"
run_unit_test "test08TemperatureUnitPersistsAfterExtensionRestart" "restart-and-return-fahrenheit"
stop_log_capture

# reconcile one fresh public listing with the exact phase-local provider stream
require_configuration_stage() {
  local phase_log="$1"
  local phase="$2"
  local stage="$3"
  local unit="$4"
  shift 4
  python3 "$SCRIPT_DIR/verify-widget-configuration-phase.py" \
    --log "$phase_log" --manifest "$ATTACHMENTS/$phase/manifest.json" \
    --utc-offset "$RESULTS/$phase-utc-offset.txt" \
    --stage "$stage" --unit "$unit" "$@"
}

cat "$RESULTS/edit-to-celsius-provider.log" \
  "$RESULTS/restart-and-return-fahrenheit-provider.log" > "$RESULTS/widget-unit.log"

# bind each accepted listing to its own provider phase and edit boundary
if ! require_configuration_stage "$RESULTS/edit-to-celsius-provider.log" edit-to-celsius \
    unit-initial-fahrenheit-typed-widget-info fahrenheit \
    --target-stage unit-initial-fahrenheit --target-out "$RESULTS/target-initial.txt" \
    --observation unit-initial-fahrenheit-visible-spoken-screenshot \
    --reopened unit-initial-fahrenheit-stored-unit \
  || ! require_configuration_stage "$RESULTS/edit-to-celsius-provider.log" edit-to-celsius \
    unit-celsius-typed-widget-info celsius \
    --target-stage unit-celsius --target-out "$RESULTS/target-celsius.txt" \
    --baseline-target "$RESULTS/target-initial.txt" \
    --observation unit-celsius-visible-spoken-screenshot \
    --reopened unit-celsius-stored-unit \
    --anchor unit-selected-celsius-screenshot --order after \
  || ! require_configuration_stage "$RESULTS/restart-and-return-fahrenheit-provider.log" restart-and-return-fahrenheit \
    unit-celsius-after-restart-typed-widget-info celsius \
    --target-stage unit-celsius-after-restart --target-out "$RESULTS/target-after-restart.txt" \
    --baseline-target "$RESULTS/target-celsius.txt" \
    --observation unit-celsius-after-restart-visible-spoken-screenshot \
    --reopened unit-celsius-after-restart-stored-unit \
    --anchor unit-selected-fahrenheit-screenshot --order before \
  || ! require_configuration_stage "$RESULTS/restart-and-return-fahrenheit-provider.log" restart-and-return-fahrenheit \
    unit-final-fahrenheit-typed-widget-info fahrenheit \
    --target-stage unit-final-fahrenheit --baseline-target "$RESULTS/target-after-restart.txt" \
    --observation unit-final-fahrenheit-visible-spoken-screenshot \
    --reopened unit-final-fahrenheit-stored-unit \
    --anchor unit-selected-fahrenheit-screenshot --order after; then
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/failure.png" >/dev/null 2>&1 || true
  echo "iOS product temperature-unit probe failed; see $RESULTS" >&2
  exit 78
fi

# require every typed and visible/spoken stage attachment
for receipt in \
  'unit-initial-fahrenheit-typed-widget-info' \
  'unit-initial-fahrenheit-visible-spoken' \
  'unit-initial-fahrenheit-stored-unit' \
  'unit-initial-fahrenheit-target' \
  'unit-celsius-typed-widget-info' \
  'unit-celsius-visible-spoken' \
  'unit-celsius-stored-unit' \
  'unit-celsius-target' \
  'unit-celsius-after-restart-typed-widget-info' \
  'unit-celsius-after-restart-visible-spoken' \
  'unit-celsius-after-restart-stored-unit' \
  'unit-celsius-after-restart-target' \
  'unit-final-fahrenheit-typed-widget-info' \
  'unit-final-fahrenheit-visible-spoken' \
  'unit-final-fahrenheit-stored-unit' \
  'unit-final-fahrenheit-target'; do
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
  "$RESULTS/edit-to-celsius-utc-offset.txt" \
  "$RESULTS/restart-and-return-fahrenheit-utc-offset.txt" \
  "$RESULTS/target-initial.txt" \
  "$RESULTS/target-celsius.txt" \
  "$RESULTS/target-after-restart.txt" \
  "$RESULTS/attachments.sha256" \
  > "$RESULTS/evidence.sha256"
echo "iOS product temperature-unit AppIntent probe passed: $RESULTS"
