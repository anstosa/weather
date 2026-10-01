#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$IOS_ROOT/Weather.xcodeproj"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts/widget-host-probe}"
DERIVED_DATA_ROOT="$RESULTS/DerivedData"
VARIANTS_DIR="$RESULTS/variants"
CASES_DIR="$RESULTS/cases"
LOG_PID=""
PLACEMENT_METHOD=""
APP_BUNDLE_ID="farm.ballydidean.weather"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode_26.6.app/Contents/Developer}"
mkdir -p "$RESULTS"

# stop only the active Simulator log capture
cleanup() {
  # stop the current case log stream
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# preserve bounded Simulator failure diagnostics
capture_failure_diagnostics() {
  local destination="$1"
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$destination/springboard-failure.png" \
    > "$destination/springboard-failure-screenshot.log" 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_UDID" log show --last 10m --style compact \
    --predicate 'process == "SpringBoard" OR process == "WeatherWidgetExtension" OR subsystem == "farm.ballydidean.weather.widget"' \
    > "$destination/simulator-widget-diagnostics.log" 2>&1 || true
}

# stop and flush the active case log
stop_log_capture() {
  # stop only the current case stream
  if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
  LOG_PID=""
}

# record one factual raw capture manifest
write_raw_manifest() {
  local case_results="$1"
  local case_id="$2"
  local scenario="$3"
  local content_size="$4"
  local appearance="$5"
  local rendering_mode="$6"
  local provider_expected="$7"
  local compiled_selector="$8"
  local fresh_placement="$9"
  CASE_RESULTS="$case_results" \
  CASE_ID="$case_id" \
  SCENARIO="$scenario" \
  CONTENT_SIZE="$content_size" \
  APPEARANCE="$appearance" \
  RENDERING_MODE="$rendering_mode" \
  PROVIDER_EXPECTED="$provider_expected" \
  COMPILED_SELECTOR="$compiled_selector" \
  FRESH_PLACEMENT="$fresh_placement" \
  PLACEMENT_METHOD="$PLACEMENT_METHOD" \
  SOURCE_COMMIT="$SOURCE_COMMIT" \
  RUNNER_IMAGE="$RUNNER_IMAGE" \
  XCODE_VERSION="$XCODE_VERSION" \
  python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

base = Path(os.environ["CASE_RESULTS"])
identity = json.loads((base / "variant-artifact-identity.json").read_text())
expected_identity = {
    "sourceCommit": os.environ["SOURCE_COMMIT"],
    "runnerImage": os.environ["RUNNER_IMAGE"],
    "xcodeVersion": os.environ["XCODE_VERSION"],
    "fixtureScenario": os.environ["SCENARIO"],
    "compiledFixtureSelector": os.environ["COMPILED_SELECTOR"],
}
# reject a case detached from its compiled artifact
for key, expected in expected_identity.items():
    if identity.get(key) != expected:
        raise SystemExit(f"variant artifact identity mismatch for {key}")
artifacts = []
# hash every immutable case artifact before the raw manifest
for path in sorted(base.rglob("*")):
    # omit the manifest while constructing itself
    if path.is_file() and path.name != "raw-capture.json":
        artifacts.append(
            {
                "path": str(path.relative_to(base)),
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
payload = {
    "caseID": os.environ["CASE_ID"],
    "method": os.environ["PLACEMENT_METHOD"],
    "sourceCommit": os.environ["SOURCE_COMMIT"],
    "runnerImage": os.environ["RUNNER_IMAGE"],
    "xcodeVersion": os.environ["XCODE_VERSION"],
    "simulatorRuntime": "iOS 26.5",
    "simulatorName": "iPhone 17",
    "widgetFamily": "systemMedium",
    "scheme": "WeatherWidgetHostTests",
    "fixtureScenario": os.environ["SCENARIO"],
    "compiledFixtureSelector": os.environ["COMPILED_SELECTOR"],
    "variantAppBinarySHA256": identity["appBinarySHA256"],
    "variantWidgetBinarySHA256": identity["widgetBinarySHA256"],
    "freshArtifactPlacement": os.environ["FRESH_PLACEMENT"] == "1",
    "contentSize": os.environ["CONTENT_SIZE"],
    "appearance": os.environ["APPEARANCE"],
    "renderingMode": os.environ["RENDERING_MODE"],
    "visualTextPolicy": "fixed-12pt-widget-only",
    "visualTextPoints": 12,
    "voiceOverDetailPolicy": "full-fixture-summary",
    "semanticContentContainmentRequired": True,
    "providerExpected": os.environ["PROVIDER_EXPECTED"],
    "providerRan": True,
    "primaryTapRouteObserved": True,
    "visualReviewRequired": True,
    "artifacts": artifacts,
}
(base / "raw-capture.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PY
}

# compile one clean deterministic widget artifact
build_variant() {
  local scenario="$1"
  local selector="$2"
  local variant_results="$VARIANTS_DIR/$scenario"
  local derived_data="$DERIVED_DATA_ROOT/$scenario"
  local products="$derived_data/Build/Products/Debug-iphonesimulator"
  local app_binary="$products/Weather.app/Weather"
  local widget_binary="$products/Weather.app/PlugIns/WeatherWidgetExtension.appex/WeatherWidgetExtension"

  rm -rf "$variant_results" "$derived_data"
  mkdir -p "$variant_results"
  printf 'DEBUG %s\n' "$selector" > "$variant_results/compile-condition.txt"

  # build one isolated app, extension, and host-test product set
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$derived_data" \
    -parallel-testing-enabled NO \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $selector" \
    build-for-testing | tee "$variant_results/build-for-testing.log"

  # record the effective compilation setting
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$derived_data" \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $selector" \
    -showBuildSettings > "$variant_results/build-settings.log"

  # reject incomplete variant products
  if [[ ! -f "$app_binary" || ! -f "$widget_binary" ]]; then
    printf '%s\n' "compiled variant lacks app or widget binary: $scenario" > "$variant_results/blocker.txt"
    exit 78
  fi

  local app_sha
  app_sha="$(shasum -a 256 "$app_binary" | awk '{ print $1 }')"
  local widget_sha
  widget_sha="$(shasum -a 256 "$widget_binary" | awk '{ print $1 }')"
  printf '%s  %s\n%s  %s\n' \
    "$app_sha" \
    "Weather.app/Weather" \
    "$widget_sha" \
    "Weather.app/PlugIns/WeatherWidgetExtension.appex/WeatherWidgetExtension" \
    > "$variant_results/binaries.sha256"

  # bind artifact identity without uploading DerivedData
  VARIANT_IDENTITY="$variant_results/artifact-identity.json" \
  VARIANT_SCENARIO="$scenario" \
  VARIANT_SELECTOR="$selector" \
  VARIANT_APP_SHA="$app_sha" \
  VARIANT_WIDGET_SHA="$widget_sha" \
  SOURCE_COMMIT="$SOURCE_COMMIT" \
  XCODE_VERSION="$XCODE_VERSION" \
  RUNNER_IMAGE="$RUNNER_IMAGE" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

payload = {
    "sourceCommit": os.environ["SOURCE_COMMIT"],
    "runnerImage": os.environ["RUNNER_IMAGE"],
    "xcodeVersion": os.environ["XCODE_VERSION"],
    "fixtureScenario": os.environ["VARIANT_SCENARIO"],
    "compiledFixtureSelector": os.environ["VARIANT_SELECTOR"],
    "activeCompilationConditions": ["DEBUG", os.environ["VARIANT_SELECTOR"]],
    "appBinarySHA256": os.environ["VARIANT_APP_SHA"],
    "widgetBinarySHA256": os.environ["VARIANT_WIDGET_SHA"],
}
Path(os.environ["VARIANT_IDENTITY"]).write_text(
    json.dumps(payload, indent=2, sort_keys=True) + "\n"
)
PY
}

# run one already-built actual-host matrix case
run_case() {
  local case_id="$1"
  local test_method="$2"
  local scenario="$3"
  local content_size="$4"
  local appearance="$5"
  local rendering_mode="$6"
  local provider_expected="$7"
  local derived_data="$8"
  local compiled_selector="$9"
  local fresh_placement="${10}"
  local variant_identity="$VARIANTS_DIR/$scenario/artifact-identity.json"
  local case_results="$CASES_DIR/$case_id"
  local result_bundle="$case_results/WeatherWidgetHost.xcresult"
  local attachments="$case_results/attachments"
  local host_test_status
  local host_test_executed=0
  local host_test_skipped=0
  local export_status
  local provider_ready=0
  local route_ready=0

  mkdir -p "$case_results"
  cp "$variant_identity" "$case_results/variant-artifact-identity.json"

  # reset only when replacing the compiled widget artifact
  if [[ "$fresh_placement" == "1" ]]; then
    PLACEMENT_METHOD=""
    set +e
    xcrun simctl uninstall "$SIMULATOR_UDID" "$APP_BUNDLE_ID" \
      > "$case_results/artifact-uninstall.log" 2>&1
    local uninstall_status=$?
    xcrun simctl get_app_container "$SIMULATOR_UDID" "$APP_BUNDLE_ID" app \
      > "$case_results/post-uninstall-app-container.log" 2>&1
    local installed_status=$?
    set -e
    printf 'fresh_placement=1\nuninstall_status=%s\npost_uninstall_container_status=%s\n' \
      "$uninstall_status" \
      "$installed_status" \
      > "$case_results/artifact-reset-status.txt"
    # require the prior containing app and widget extension to be absent
    if [[ "$installed_status" -eq 0 ]]; then
      printf '%s\n' "prior app remained installed before $case_id" > "$case_results/blocker.txt"
      exit 78
    fi
  else
    printf 'fresh_placement=0\nuninstall_status=not-requested\npost_uninstall_container_status=not-requested\n' \
      > "$case_results/artifact-reset-status.txt"
  fi

  # set and read back the supported Simulator states
  set +e
  xcrun simctl ui "$SIMULATOR_UDID" appearance "$appearance" \
    > "$case_results/set-appearance.log" 2>&1
  local set_appearance_status=$?
  xcrun simctl ui "$SIMULATOR_UDID" content_size "$content_size" \
    > "$case_results/set-content-size.log" 2>&1
  local set_content_size_status=$?
  local actual_appearance
  actual_appearance="$(xcrun simctl ui "$SIMULATOR_UDID" appearance 2> "$case_results/get-appearance.stderr")"
  local get_appearance_status=$?
  local actual_content_size
  actual_content_size="$(xcrun simctl ui "$SIMULATOR_UDID" content_size 2> "$case_results/get-content-size.stderr")"
  local get_content_size_status=$?
  set -e
  printf 'set_appearance=%s\nset_content_size=%s\nget_appearance=%s\nget_content_size=%s\n' \
    "$set_appearance_status" \
    "$set_content_size_status" \
    "$get_appearance_status" \
    "$get_content_size_status" \
    > "$case_results/system-state-status.txt"
  printf 'appearance=%s\ncontent_size=%s\nrequested_rendering=%s\n' \
    "$actual_appearance" \
    "$actual_content_size" \
    "$rendering_mode" \
    > "$case_results/system-state.txt"

  # reject unconfirmed Simulator state transitions
  if [[ "$set_appearance_status" -ne 0 \
    || "$set_content_size_status" -ne 0 \
    || "$get_appearance_status" -ne 0 \
    || "$get_content_size_status" -ne 0 \
    || "$actual_appearance" != "$appearance" \
    || "$actual_content_size" != "$content_size" ]]; then
    capture_failure_diagnostics "$case_results"
    printf '%s\n' "Simulator visual state did not match $case_id" > "$case_results/blocker.txt"
    exit 78
  fi

  # capture this case's real provider and tap execution
  xcrun simctl spawn "$SIMULATOR_UDID" log stream \
    --style compact \
    --level info \
    --predicate 'subsystem == "farm.ballydidean.weather.widget" OR subsystem == "farm.ballydidean.weather"' \
    > "$case_results/provider-and-route.log" 2>&1 &
  LOG_PID=$!

  # execute without rebuilding the shared test products
  set +e
  xcodebuild \
    -project "$PROJECT" \
    -scheme WeatherWidgetHostTests \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
    -derivedDataPath "$derived_data" \
    -resultBundlePath "$result_bundle" \
    -only-testing:"WeatherUITests/WidgetHostUITests/$test_method" \
    -parallel-testing-enabled NO \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $compiled_selector" \
    test-without-building | tee "$case_results/widget-host-test.log"
  host_test_status=${PIPESTATUS[0]}
  set -e
  stop_log_capture
  printf '%s\n' "$host_test_status" > "$case_results/widget-host-test-status.txt"
  cat "$case_results/widget-host-test.log" >> "$RESULTS/widget-host-test.log"
  cat "$case_results/provider-and-route.log" >> "$RESULTS/provider-and-route.log"

  # reject XCTest's status-zero skip path per case
  if grep -Eq "Test Case '-\\[WeatherUITests\\.WidgetHostUITests $test_method\\]' (passed|failed)" \
    "$case_results/widget-host-test.log"; then
    host_test_executed=1
  fi
  if grep -Fq "Test Case '-[WeatherUITests.WidgetHostUITests $test_method]' skipped" \
    "$case_results/widget-host-test.log"; then
    host_test_skipped=1
  fi
  printf '%s\n' "$host_test_executed" > "$case_results/widget-host-test-executed.txt"
  printf '%s\n' "$host_test_skipped" > "$case_results/widget-host-test-skipped.txt"

  # export every hosted screenshot and hierarchy receipt
  set +e
  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$attachments" \
    > "$case_results/xcresulttool-export-attachments.log" 2>&1
  export_status=$?
  set -e
  printf '%s\n' "$export_status" > "$case_results/xcresulttool-export-attachments-status.txt"

  # bind all cases to the proven placement method
  if [[ -z "$PLACEMENT_METHOD" ]]; then
    # recognize direct conversion receipts
    if [[ -f "$attachments/manifest.json" ]] \
      && grep -Fq 'home-screen-medium-conversion-before' "$attachments/manifest.json"; then
      PLACEMENT_METHOD="xcui-home-screen-conversion"
    elif [[ -f "$attachments/manifest.json" ]] \
      && grep -Fq 'widget-gallery' "$attachments/manifest.json"; then
      PLACEMENT_METHOD="xcui-widget-gallery"
    else
      PLACEMENT_METHOD="unknown"
    fi
  fi
  printf '%s\t%s\n' "$case_id" "$PLACEMENT_METHOD" >> "$RESULTS/host-path.txt"
  printf '%s\n' "$PLACEMENT_METHOD" > "$case_results/host-path.txt"

  # require the exact scenario provider and fixed tap route
  if grep -Fq "$provider_expected" "$case_results/provider-and-route.log"; then
    provider_ready=1
  fi
  # require the fixed deep-link route
  if grep -Fq 'route=forecast source=deep-link' "$case_results/provider-and-route.log"; then
    route_ready=1
  fi
  printf '%s\n' "$provider_ready" > "$case_results/provider-ready.txt"
  printf '%s\n' "$route_ready" > "$case_results/route-ready.txt"

  # mirror the latest case status for workflow diagnostics
  printf '%s\n' "$host_test_status" > "$RESULTS/widget-host-test-status.txt"
  printf '%s\n' "$host_test_executed" > "$RESULTS/widget-host-test-executed.txt"
  printf '%s\n' "$host_test_skipped" > "$RESULTS/widget-host-test-skipped.txt"
  printf '%s\n' "$provider_ready" > "$RESULTS/provider-ready.txt"

  # reject missing execution, receipts, provider, route, or placement identity
  if [[ "$host_test_executed" -ne 1 \
    || "$host_test_skipped" -ne 0 \
    || "$host_test_status" -ne 0 \
    || "$export_status" -ne 0 \
    || "$provider_ready" -ne 1 \
    || "$route_ready" -ne 1 \
    || "$PLACEMENT_METHOD" == "unknown" ]]; then
    capture_failure_diagnostics "$case_results"
    printf '%s\n' "actual host matrix case failed: $case_id" > "$case_results/blocker.txt"
    printf '%s\n' "M0-IOS-HOST-ACCESS: actual host matrix case failed: $case_id" >&2
    exit 78
  fi

  local attachment_screenshots
  attachment_screenshots="$(find "$attachments" -type f -iname '*.png' | wc -l | tr -d ' ')"
  # require hosted and tapped visual receipts
  if [[ "$attachment_screenshots" -lt 2 ]]; then
    capture_failure_diagnostics "$case_results"
    printf '%s\n' "matrix case lacks hosted/tapped screenshots: $case_id" > "$case_results/blocker.txt"
    exit 78
  fi

  # require exact per-case geometry and route receipts
  for attachment_name in \
    "matrix-$case_id-home-screen" \
    "matrix-$case_id-widgetkit-bounds" \
    "matrix-$case_id-widget-tap-forecast-route"; do
    # reject generic screenshots substituted for the case evidence
    if ! grep -Fq "$attachment_name" "$attachments/manifest.json"; then
      capture_failure_diagnostics "$case_results"
      printf '%s\n' "matrix case lacks attachment $attachment_name" > "$case_results/blocker.txt"
      exit 78
    fi
  done
  # require the real customization selection receipt
  if [[ "$rendering_mode" == "accented" ]] \
    && ! grep -Fq 'matrix-tinted-selected' "$attachments/manifest.json"; then
    capture_failure_diagnostics "$case_results"
    printf '%s\n' "tinted matrix case lacks selected-state attachment" > "$case_results/blocker.txt"
    exit 78
  fi

  write_raw_manifest \
    "$case_results" \
    "$case_id" \
    "$scenario" \
    "$actual_content_size" \
    "$actual_appearance" \
    "$rendering_mode" \
    "$provider_expected" \
    "$compiled_selector" \
    "$fresh_placement"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$case_id" \
    "$scenario" \
    "$actual_content_size" \
    "$actual_appearance" \
    "$rendering_mode" \
    "$compiled_selector" \
    "$fresh_placement" >> "$RESULTS/matrix-status.tsv"
}

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/verify-project.py"

# select one available iOS 26.5 iPhone 17
SIMULATOR_UDID="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
payload = json.load(sys.stdin)
# inspect installed runtimes
for runtime, devices in payload["devices"].items():
    # select the pinned runtime
    if runtime.endswith("iOS-26-5"):
        # inspect available devices
        for device in devices:
            # select the pinned phone
            if device["name"] == "iPhone 17" and device.get("isAvailable", False):
                print(device["udid"])
                raise SystemExit(0)
raise SystemExit("no available iPhone 17 on iOS 26.5")
')"
printf '%s\n' "$SIMULATOR_UDID" > "$RESULTS/simulator-udid.txt"
SOURCE_COMMIT="$(git -C "$IOS_ROOT/../.." rev-parse HEAD)"
XCODE_VERSION="$(xcodebuild -version | awk 'NR == 1 { print $2 }')"
RUNNER_IMAGE="${ImageOS:-unknown}/${ImageVersion:-unknown} ${RUNNER_OS:-macOS}"
{
  xcodebuild -version
  sw_vers
  printf 'runner_image=%s\n' "$RUNNER_IMAGE"
} > "$RESULTS/toolchain.txt"

# boot the selected simulator
if ! xcrun simctl boot "$SIMULATOR_UDID" 2> "$RESULTS/simulator-boot.stderr"; then
  # accept only an already-booted simulator
  if ! grep -qi 'current state: Booted' "$RESULTS/simulator-boot.stderr"; then
    cat "$RESULTS/simulator-boot.stderr" >&2
    exit 1
  fi
fi
xcrun simctl bootstatus "$SIMULATOR_UDID" -b

# capture installed visual-control contracts
set +e
xcrun simctl help ui > "$RESULTS/simctl-ui-help.txt" 2>&1
SIMCTL_UI_HELP_STATUS=$?
xcrun xcresulttool export attachments --help \
  > "$RESULTS/xcresulttool-export-attachments-help.txt" 2>&1
XCRESULT_HELP_STATUS=$?
set -e
printf '%s\n' "$SIMCTL_UI_HELP_STATUS" > "$RESULTS/simctl-ui-help-status.txt"
printf '%s\n' "$XCRESULT_HELP_STATUS" > "$RESULTS/xcresulttool-export-attachments-help-status.txt"

# reject reused matrix or variant evidence
if [[ -e "$CASES_DIR" || -e "$VARIANTS_DIR" || -e "$DERIVED_DATA_ROOT" ]]; then
  printf '%s\n' "matrix or variant evidence already exists under $RESULTS" > "$RESULTS/blocker.txt"
  exit 78
fi
mkdir -p "$CASES_DIR" "$VARIANTS_DIR" "$DERIVED_DATA_ROOT"
: > "$RESULTS/widget-host-test.log"
: > "$RESULTS/provider-and-route.log"
: > "$RESULTS/matrix-status.tsv"
: > "$RESULTS/host-path.txt"

# compile three clean fixture artifacts from the same source
MAXIMUM_SELECTOR="WEATHER_M0_FIXTURE_MAXIMUM"
NEAR_CUTOFF_SELECTOR="WEATHER_M0_FIXTURE_NEAR_CUTOFF"
BEDTIME_SELECTOR="WEATHER_M0_FIXTURE_BEDTIME"
build_variant "maximumDensity" "$MAXIMUM_SELECTOR"
build_variant "nearCutoff" "$NEAR_CUTOFF_SELECTOR"
build_variant "bedtime" "$BEDTIME_SELECTOR"

MAXIMUM_DERIVED_DATA="$DERIVED_DATA_ROOT/maximumDensity"
NEAR_CUTOFF_DERIVED_DATA="$DERIVED_DATA_ROOT/nearCutoff"
BEDTIME_DERIVED_DATA="$DERIVED_DATA_ROOT/bedtime"

# run the minimal non-cross-product actual-host matrix
run_case \
  "01-maximum-light-large" \
  "test01MaximumLightLarge" \
  "maximumDensity" \
  "large" \
  "light" \
  "fullColor" \
  "m0-compiled-fixture selector=$MAXIMUM_SELECTOR resolved=maximumDensity groups=7 intervals=21" \
  "$MAXIMUM_DERIVED_DATA" \
  "$MAXIMUM_SELECTOR" \
  "1"
run_case \
  "02-maximum-dark-large" \
  "test02MaximumDarkLarge" \
  "maximumDensity" \
  "large" \
  "dark" \
  "fullColor" \
  "m0-compiled-fixture selector=$MAXIMUM_SELECTOR resolved=maximumDensity groups=7 intervals=21" \
  "$MAXIMUM_DERIVED_DATA" \
  "$MAXIMUM_SELECTOR" \
  "0"
run_case \
  "03-maximum-light-ax5" \
  "test03MaximumLightAX5" \
  "maximumDensity" \
  "accessibility-extra-extra-extra-large" \
  "light" \
  "fullColor" \
  "m0-compiled-fixture selector=$MAXIMUM_SELECTOR resolved=maximumDensity groups=7 intervals=21" \
  "$MAXIMUM_DERIVED_DATA" \
  "$MAXIMUM_SELECTOR" \
  "0"
run_case \
  "04-near-cutoff-light-large" \
  "test04NearCutoffLightLarge" \
  "nearCutoff" \
  "large" \
  "light" \
  "fullColor" \
  "m0-compiled-fixture selector=$NEAR_CUTOFF_SELECTOR resolved=nearCutoff groups=1 intervals=1" \
  "$NEAR_CUTOFF_DERIVED_DATA" \
  "$NEAR_CUTOFF_SELECTOR" \
  "1"
run_case \
  "05-bedtime-light-large" \
  "test05BedtimeLightLarge" \
  "bedtime" \
  "large" \
  "light" \
  "fullColor" \
  "m0-compiled-fixture selector=$BEDTIME_SELECTOR resolved=bedtime groups=0 intervals=0" \
  "$BEDTIME_DERIVED_DATA" \
  "$BEDTIME_SELECTOR" \
  "1"
run_case \
  "06-maximum-tinted-large" \
  "test06MaximumTintedLarge" \
  "maximumDensity" \
  "large" \
  "light" \
  "accented" \
  "m0-compiled-fixture selector=$MAXIMUM_SELECTOR resolved=maximumDensity groups=7 intervals=21" \
  "$MAXIMUM_DERIVED_DATA" \
  "$MAXIMUM_SELECTOR" \
  "1"

# preserve one final actual screen outside the test receipts
xcrun simctl io "$SIMULATOR_UDID" screenshot "$RESULTS/after-widget-tap.png" \
  > "$RESULTS/after-widget-tap-screenshot.log" 2>&1 || true
printf '%s\n' '1' > "$RESULTS/provider-ready.txt"
printf '%s\n' '0' > "$RESULTS/widget-host-test-status.txt"
printf '%s\n' '1' > "$RESULTS/widget-host-test-executed.txt"
printf '%s\n' '0' > "$RESULTS/widget-host-test-skipped.txt"

# hash the successful raw matrix receipts
{
  printf 'source_commit=%s\n' "$SOURCE_COMMIT"
  printf 'host_path=%s\n' "$PLACEMENT_METHOD"
  printf 'simulator_udid=%s\n' "$SIMULATOR_UDID"
  find "$VARIANTS_DIR" -type f -print0 | sort -z | xargs -0 shasum -a 256
  find "$CASES_DIR" -type f -print0 | sort -z | xargs -0 shasum -a 256
  shasum -a 256 "$RESULTS/after-widget-tap.png" "$RESULTS/provider-and-route.log"
} > "$RESULTS/capture-manifest.txt"

# accept only separately reviewed factual receipts
if [[ -n "${HOST_EVIDENCE_DIR:-}" ]]; then
  "$SCRIPT_DIR/verify-widget-host-evidence.py" "$HOST_EVIDENCE_DIR"
  echo "actual WidgetKit Home Screen matrix evidence passed"
  exit 0
fi

printf '%s\n' \
  "actual WidgetKit host matrix captured; independent clipping, text-visibility, accessibility, and tint review remains required" \
  > "$RESULTS/visual-review-required.txt"
echo "M0-IOS-HOST-ACCESS: actual host matrix ready for independent visual review; see $RESULTS" >&2
exit 78
