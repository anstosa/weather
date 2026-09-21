#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/scripts/android-env.sh"

: "${WEATHER_HTTPS_FIXTURE_CA_PEM:?missing trusted fixture ca}"
: "${WEATHER_HTTPS_FIXTURE_ANDROID_ORIGIN:?missing trusted android fixture origin}"
: "${WEATHER_HTTPS_FIXTURE_ANDROID_UNTRUSTED_ORIGIN:?missing untrusted android fixture origin}"
: "${WEATHER_HTTPS_FIXTURE_USERNAME:?missing fixture username}"
: "${WEATHER_HTTPS_FIXTURE_PASSWORD:?missing fixture password}"

EVIDENCE_DIR="${1:?usage: run-hosted-shell-tests.sh EVIDENCE_DIR}"
GENERATED_RES="$(mktemp -d "${TMPDIR:-/tmp}/weather-android-fixture-res.XXXXXX")"
mkdir -p "${EVIDENCE_DIR}" "${GENERATED_RES}/raw" "${GENERATED_RES}/xml"

# remove ephemeral trust material on every exit
cleanup() {
  python3 - "${GENERATED_RES}" <<'PY'
import pathlib
import shutil
import sys

path = pathlib.Path(sys.argv[1])

# delete only the script-owned temporary directory
if path.name.startswith("weather-android-fixture-res."):
    shutil.rmtree(path, ignore_errors=True)
PY
}
trap cleanup EXIT

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
set +e
"${ROOT}/gradlew" -p "${ROOT}" --no-daemon \
  -PweatherFixtureResDir="${GENERATED_RES}" \
  -Pandroid.testInstrumentationRunnerArguments.fixtureOrigin="${WEATHER_HTTPS_FIXTURE_ANDROID_ORIGIN}" \
  -Pandroid.testInstrumentationRunnerArguments.untrustedFixtureOrigin="${WEATHER_HTTPS_FIXTURE_ANDROID_UNTRUSTED_ORIGIN}" \
  -Pandroid.testInstrumentationRunnerArguments.fixtureUsername="${WEATHER_HTTPS_FIXTURE_USERNAME}" \
  -Pandroid.testInstrumentationRunnerArguments.fixturePassword="${WEATHER_HTTPS_FIXTURE_PASSWORD}" \
  -Pandroid.testInstrumentationRunnerArguments.notAnnotation='farm.ballydidean.weather.ExternalProcessPersistenceTest' \
  :app:widgetPhoneDebugAndroidTest 2>&1 | tee "${EVIDENCE_DIR}/gradle-managed-device.txt"
STATUS="${PIPESTATUS[0]}"
set -e

RESULT_XML="${ROOT}/app/build/outputs/androidTest-results/managedDevice/debug/widgetPhone/TEST-widgetPhone.xml"
# retain the exact structured receipt
if [[ -f "${RESULT_XML}" ]]; then
  cp "${RESULT_XML}" "${EVIDENCE_DIR}/TEST-widgetPhone.xml"
fi
exit "${STATUS}"
