#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/scripts/android-env.sh"

: "${WEATHER_HTTPS_FIXTURE_CA_PEM:?missing trusted fixture ca}"
: "${WEATHER_HTTPS_FIXTURE_ANDROID_ORIGIN:?missing trusted android fixture origin}"
: "${WEATHER_HTTPS_FIXTURE_ANDROID_UNTRUSTED_ORIGIN:?missing untrusted android fixture origin}"
: "${WEATHER_HTTPS_FIXTURE_USERNAME:?missing fixture username}"
: "${WEATHER_HTTPS_FIXTURE_PASSWORD:?missing fixture password}"

EVIDENCE_DIR="${1:?usage: run-hosted-shell-process-tests.sh EVIDENCE_DIR DEVICE_SERIAL}"
DEVICE_SERIAL="${2:?usage: run-hosted-shell-process-tests.sh EVIDENCE_DIR DEVICE_SERIAL}"
ADB="${ANDROID_HOME}/platform-tools/adb"
APP_APK="${ROOT}/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="${ROOT}/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
RUNNER="farm.ballydidean.weather.debug.test/androidx.test.runner.AndroidJUnitRunner"
TEST_METHOD="farm.ballydidean.weather.HostedShellProcessPersistenceInstrumentationTest#cookieAndLogoutStateSurviveExternalProcessRestart"
GENERATED_RES="$(mktemp -d "${TMPDIR:-/tmp}/weather-android-process-fixture-res.XXXXXX")"
mkdir -p "${EVIDENCE_DIR}" "${GENERATED_RES}/raw" "${GENERATED_RES}/xml"

# remove ephemeral trust material on every exit
cleanup() {
  python3 - "${GENERATED_RES}" <<'PY'
import pathlib
import shutil
import sys

path = pathlib.Path(sys.argv[1])

# delete only the script-owned temporary directory
if path.name.startswith("weather-android-process-fixture-res."):
    shutil.rmtree(path, ignore_errors=True)
PY
}
trap cleanup EXIT

# require one ready explicit device
if [[ "$("${ADB}" -s "${DEVICE_SERIAL}" get-state 2>/dev/null)" != "device" ]]; then
  printf 'android process-persistence device is not ready: %s\n' "${DEVICE_SERIAL}" >&2
  exit 1
fi

cp "${WEATHER_HTTPS_FIXTURE_CA_PEM}" "${GENERATED_RES}/raw/native_fixture_ca.pem"
cat >"${GENERATED_RES}/xml/network_security_config.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">10.0.2.2</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/native_fixture_ca" />
        </trust-anchors>
    </domain-config>
</network-security-config>
XML

export GRADLE_USER_HOME="${GRADLE_USER_HOME:-${HOME}/.gradle}"
"${ROOT}/gradlew" -p "${ROOT}" --no-daemon \
  -PweatherFixtureResDir="${GENERATED_RES}" \
  :app:assembleDebug :app:assembleDebugAndroidTest \
  2>&1 | tee "${EVIDENCE_DIR}/gradle-build.txt"
"${ADB}" -s "${DEVICE_SERIAL}" install -r "${APP_APK}" | tee "${EVIDENCE_DIR}/install-app.txt"
"${ADB}" -s "${DEVICE_SERIAL}" install -r "${TEST_APK}" | tee "${EVIDENCE_DIR}/install-test.txt"
"${ADB}" -s "${DEVICE_SERIAL}" shell pm clear farm.ballydidean.weather.debug >/dev/null

# run one externally isolated instrumentation phase
run_phase() {
  local phase="$1"
  local output="${EVIDENCE_DIR}/instrumentation-${phase}.txt"
  "${ADB}" -s "${DEVICE_SERIAL}" shell am instrument -w \
    -e class "${TEST_METHOD}" \
    -e processPersistencePhase "${phase}" \
    -e fixtureOrigin "${WEATHER_HTTPS_FIXTURE_ANDROID_ORIGIN}" \
    -e untrustedFixtureOrigin "${WEATHER_HTTPS_FIXTURE_ANDROID_UNTRUSTED_ORIGIN}" \
    -e fixtureUsername "${WEATHER_HTTPS_FIXTURE_USERNAME}" \
    -e fixturePassword "${WEATHER_HTTPS_FIXTURE_PASSWORD}" \
    "${RUNNER}" 2>&1 | tee "${output}"
  # require one successful phase with no skipped substitute
  if ! grep -q '^OK (1 test)$' "${output}"; then
    printf 'android process-persistence phase failed: %s\n' "${phase}" >&2
    return 1
  fi
}

run_phase seed
"${ADB}" -s "${DEVICE_SERIAL}" shell am force-stop farm.ballydidean.weather.debug
run_phase verify-and-logout
"${ADB}" -s "${DEVICE_SERIAL}" shell am force-stop farm.ballydidean.weather.debug
run_phase verify-logged-out
"${ADB}" -s "${DEVICE_SERIAL}" shell am force-stop farm.ballydidean.weather.debug

cat >"${EVIDENCE_DIR}/summary.json" <<JSON
{
  "deviceSerial": "${DEVICE_SERIAL}",
  "externalForceStops": 3,
  "phasesPassed": 3,
  "processPersistenceVerified": true
}
JSON
sha256sum "${APP_APK}" "${TEST_APK}" >"${EVIDENCE_DIR}/apk-sha256.txt"
printf 'android hosted-shell process persistence passed\n'
