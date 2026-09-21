#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/scripts/android-env.sh"
ADB="${ANDROID_HOME}/platform-tools/adb"
APP_APK="${ROOT}/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="${ROOT}/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
PACKAGE="farm.ballydidean.weather.debug"
TEST_PACKAGE="farm.ballydidean.weather.debug.test"
EVIDENCE_RUN_ID="${WEATHER_EVIDENCE_RUN_ID:-run-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
EVIDENCE="${ROOT}/host-evidence/${EVIDENCE_RUN_ID}"
mkdir -p "${EVIDENCE}"
RESULT=0

# restore ordinary emulator presentation on every exit
# invoked by the exit trap
# shellcheck disable=SC2329
restore_presentation() {
  "${ADB}" shell settings put system font_scale 1.0 >/dev/null 2>&1 || true
  "${ADB}" shell cmd uimode night no >/dev/null 2>&1 || true
  "${ADB}" shell wm user-rotation free >/dev/null 2>&1 || true
  "${ADB}" shell wm fixed-to-user-rotation default >/dev/null 2>&1 || true
}

# require runner success and the exact executed test count
run_instrumentation() {
  local label="$1"
  local expected_count="$2"
  shift 2
  local output="${EVIDENCE}/instrumentation-${label}.txt"
  local status
  set +e
  "${ADB}" shell am instrument -w "$@" 2>&1 | tee "${output}"
  status="${PIPESTATUS[0]}"
  set -e
  # reject transport or instrumentation terminal failures
  if [[ "${status}" != "0" ]] || grep -E -q \
    'FAILURES|INSTRUMENTATION_FAILED|Process crashed|shortMsg=|Exception' "${output}"; then
    return 1
  fi
  # require the exact expected completion receipt
  if ! grep -E -q "^OK \(${expected_count} tests?\)$" "${output}"; then
    printf 'instrumentation %s did not report exactly %s successful test(s)\n' "${label}" "${expected_count}" >&2
    return 1
  fi
}

trap restore_presentation EXIT

# require exactly one ready device
if [[ "$(${ADB} devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }')" != "1" ]]; then
  printf 'capture requires exactly one ready Android emulator/device\n' >&2
  exit 1
fi

"${ROOT}/gradlew" -p "${ROOT}" --no-daemon :app:assembleDebug :app:assembleDebugAndroidTest
"${ADB}" install -r "${APP_APK}"
"${ADB}" install -r "${TEST_APK}"
"${ADB}" shell pm clear "${PACKAGE}" >/dev/null

# prove snapshot and failed-attempt files survive process restart
PERSISTENCE_RECEIPT="${EVIDENCE}/persistence-restart.txt"
{
  "${ADB}" shell am broadcast -W -f 0x20 \
    -n "${PACKAGE}/farm.ballydidean.weather.debug.FixtureControlReceiver" \
    -a 'farm.ballydidean.weather.debug.SEED_PERSISTENCE'
  "${ADB}" shell am force-stop "${PACKAGE}"
  "${ADB}" shell am broadcast -W -f 0x20 \
    -n "${PACKAGE}/farm.ballydidean.weather.debug.FixtureControlReceiver" \
    -a 'farm.ballydidean.weather.debug.VERIFY_PERSISTENCE'
} | tee "${PERSISTENCE_RECEIPT}"
if ! grep -q 'result=-1, data="seeded"' "${PERSISTENCE_RECEIPT}" || \
  ! grep -q 'result=-1, data="restart-ok"' "${PERSISTENCE_RECEIPT}"; then
  printf 'snapshot and failed-attempt state did not survive process restart\n' >&2
  RESULT=1
fi

# run genuine appwidgethost checks at normal font scale
"${ADB}" shell settings put system font_scale 1.0
"${ADB}" shell cmd uimode night no >/dev/null
run_instrumentation normal 17 \
  -e class 'farm.ballydidean.weather.WidgetHostInstrumentationTest,farm.ballydidean.weather.WidgetStorageInstrumentationTest' \
  "${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner" || RESULT=1

# run every fixture and the clipping oracle at large text
"${ADB}" shell settings put system font_scale 1.3
"${ADB}" shell am force-stop "${PACKAGE}"
run_instrumentation large 17 \
  -e class 'farm.ballydidean.weather.WidgetHostInstrumentationTest,farm.ballydidean.weather.WidgetStorageInstrumentationTest' \
  "${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner" || RESULT=1

# capture the same fixture under the dark resource set
"${ADB}" shell settings put system font_scale 1.0
"${ADB}" shell cmd uimode night yes >/dev/null
"${ADB}" shell am force-stop "${PACKAGE}"
run_instrumentation dark-portrait 1 \
  -e class 'farm.ballydidean.weather.WidgetHostInstrumentationTest#testMaximumPortrait' \
  "${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner" || RESULT=1

# retrieve instrumentation screenshots before launcher placement
"${ADB}" pull "/sdcard/Android/data/${PACKAGE}/cache/widget-host-evidence" "${EVIDENCE}/custom-host" >/dev/null || RESULT=1

# request large-text placement through the installed normal launcher
"${ADB}" shell settings put system font_scale 1.3
"${ADB}" shell cmd uimode night no >/dev/null
BEFORE_LAUNCHER_WIDGETS="$("${ADB}" shell dumpsys appwidget | grep -c \
  'provider=ProviderId{.*farm.ballydidean.weather.debug/farm.ballydidean.weather.widget.WeatherWidgetProvider' || true)"
"${ADB}" shell am start -n "${PACKAGE}/farm.ballydidean.weather.debug.PinWidgetActivity" >/dev/null
sleep 1
"${ADB}" shell uiautomator dump /sdcard/weather-pin-window.xml >/dev/null
WINDOW_XML="$(mktemp)"
"${ADB}" pull /sdcard/weather-pin-window.xml "${WINDOW_XML}" >/dev/null
BUTTON_COORDS="$(python3 - "${WINDOW_XML}" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

# locate the launcher's explicit add action
root = ET.parse(sys.argv[1]).getroot()
for node in root.iter("node"):
    label = (node.attrib.get("text") or node.attrib.get("content-desc") or "").strip().lower()
    if label in {"add", "add to home screen", "add automatically"}:
        match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
        if match:
            left, top, right, bottom = map(int, match.groups())
            print((left + right) // 2, (top + bottom) // 2)
            break
PY
)"
# require an actual launcher acceptance control
if [[ -z "${BUTTON_COORDS}" ]]; then
  printf 'normal launcher pin confirmation was not automatable; inspect %s\n' "${WINDOW_XML}" >&2
  RESULT=1
else
  read -r BUTTON_X BUTTON_Y <<<"${BUTTON_COORDS}"
  "${ADB}" shell input tap "${BUTTON_X}" "${BUTTON_Y}"
  sleep 2
  "${ADB}" shell input keyevent KEYCODE_HOME
  sleep 1
  # apply deterministic debug data after real launcher placement
  "${ADB}" shell am broadcast \
    -n "${PACKAGE}/farm.ballydidean.weather.debug.FixtureControlReceiver" \
    -a 'farm.ballydidean.weather.debug.SET_FIXTURE' \
    --es variant MAXIMUM >/dev/null
  sleep 1
  "${ADB}" shell dumpsys appwidget >"${EVIDENCE}/large-launcher-appwidget.txt"
  AFTER_LAUNCHER_WIDGETS="$(grep -c \
    'provider=ProviderId{.*farm.ballydidean.weather.debug/farm.ballydidean.weather.widget.WeatherWidgetProvider' \
    "${EVIDENCE}/large-launcher-appwidget.txt" || true)"
  # require one newly launcher-hosted provider instance
  if (( AFTER_LAUNCHER_WIDGETS <= BEFORE_LAUNCHER_WIDGETS )); then
    printf 'normal launcher did not add a new Weather provider instance\n' >&2
    RESULT=1
  fi
  LAUNCHER_VISIBLE=0
  # search bounded launcher pages for the rendered credit
  for _ in 0 1 2; do
    "${ADB}" shell uiautomator dump /sdcard/weather-launcher-window.xml >/dev/null
    "${ADB}" pull /sdcard/weather-launcher-window.xml "${EVIDENCE}/large-launcher-window.xml" >/dev/null
    # capture only the page that exposes the real widget text
    if grep -q 'text="Open-Meteo"' "${EVIDENCE}/large-launcher-window.xml" && \
      grep -q 'text="CC BY 4.0"' "${EVIDENCE}/large-launcher-window.xml"; then
      "${ADB}" exec-out screencap -p >"${EVIDENCE}/large-launcher-4x1.png"
      LAUNCHER_VISIBLE=1
      break
    fi
    "${ADB}" shell input swipe 900 1100 100 1100 300
    sleep 1
  done
  # reject off-screen provider records without visible launcher proof
  if [[ "${LAUNCHER_VISIBLE}" != "1" ]]; then
    printf 'normal launcher provider was not visibly rendered on a bounded home page\n' >&2
    RESULT=1
  fi
fi

printf 'host evidence: %s\n' "${EVIDENCE}"
exit "${RESULT}"
