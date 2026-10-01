#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/scripts/android-env.sh"
APK="${1:-${ROOT}/app/build/outputs/apk/release/app-release-unsigned.apk}"

# require the unsigned release output
if [[ ! -f "${APK}" ]]; then
  printf 'missing release apk: %s\n' "${APK}" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
STRINGS_FILE="$(mktemp)"
# remove only the private temporary extraction
trap 'rm -rf "${TEMP_DIR}"; rm -f "${STRINGS_FILE}"' EXIT
unzip -q "${APK}" -d "${TEMP_DIR}"
find "${TEMP_DIR}" -type f -exec strings {} + >"${STRINGS_FILE}"

# reject debug-only classes and fixture controls
if grep -E -q \
  'FixtureHostActivity|DebugWidgetFixtures|FixtureVariant|PinWidgetActivity|SET_FIXTURE|SEED_PERSISTENCE|VERIFY_PERSISTENCE|127\.0\.0\.1|10\.0\.2\.2|localhost|Weather Native Fixture (Trusted Root|Untrusted Root)|Weather Native HTTPS Fixture|native_fixture_ca|fixtureOrigin|untrustedFixtureOrigin|fixtureUsername|fixturePassword|addJavascriptInterface|onReceivedSslError.*proceed|setWebContentsDebuggingEnabled' \
  "${STRINGS_FILE}"; then
  printf 'release artifact contains a forbidden debug origin, fixture control, bridge, or tls bypass\n' >&2
  exit 1
fi

# require the fixed cookiefree widget endpoint in release code
if ! grep -F -q \
  'https://weather.ballydidean.farm/api/v3/sites/ballydidean/widget-forecast' \
  "${STRINGS_FILE}"; then
  printf 'release artifact is missing the fixed widget endpoint\n' >&2
  exit 1
fi

# reject common embedded credential forms
if grep -E -q \
  'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}|aws_secret_access_key' \
  "${STRINGS_FILE}"; then
  printf 'release artifact contains a credential-shaped value\n' >&2
  exit 1
fi

MANIFEST="$("${ANDROID_HOME}"/cmdline-tools/latest/bin/apkanalyzer manifest print "${APK}")"
# retain the explicit cleartext denial
if ! grep -q 'usesCleartextTraffic="false"' <<<"${MANIFEST}"; then
  printf 'release manifest does not explicitly deny cleartext traffic\n' >&2
  exit 1
fi

# keep debug host components and protected fixture permissions out of release
if grep -E -q 'FixtureHostActivity|FixtureControlReceiver|PinWidgetActivity|BIND_APPWIDGET' <<<"${MANIFEST}"; then
  printf 'release manifest contains debug widget-host capabilities\n' >&2
  exit 1
fi

# retain only the canonical weather origin
ORIGIN="$("${ANDROID_HOME}"/cmdline-tools/latest/bin/apkanalyzer resources value \
  --config default --type string --name canonical_weather_origin "${APK}")"
if [[ "${ORIGIN}" != 'https://weather.ballydidean.farm' ]]; then
  printf 'release artifact is missing the canonical Weather origin\n' >&2
  exit 1
fi

sha256sum "${APK}"
printf 'release isolation scan passed\n'
