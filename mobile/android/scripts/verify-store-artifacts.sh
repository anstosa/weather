#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=mobile/android/scripts/android-env.sh
source "${ROOT}/scripts/android-env.sh"
APK="${1:-${ROOT}/app/build/outputs/apk/release/app-release.apk}"
AAB="${2:-${ROOT}/app/build/outputs/bundle/release/app-release.aab}"
: "${VERSION_CODE:?VERSION_CODE is required}"
: "${VERSION_NAME:?VERSION_NAME is required}"
: "${ANDROID_UPLOAD_KEYSTORE_FILE:?upload key is required}"
: "${ANDROID_UPLOAD_KEYSTORE_PASSWORD:?upload key password is required}"
: "${ANDROID_UPLOAD_KEY_ALIAS:?upload alias is required}"

# verify the production code and network isolation on the same release variant
"${ROOT}/scripts/verify-release-artifact.sh" "${APK}"
ANALYZER="${ANDROID_HOME}/cmdline-tools/latest/bin/apkanalyzer"
test "$("${ANALYZER}" manifest application-id "${APK}")" = farm.ballydidean.weather
test "$("${ANALYZER}" manifest version-code "${APK}")" = "${VERSION_CODE}"
test "$("${ANALYZER}" manifest version-name "${APK}")" = "${VERSION_NAME}"
test "$("${ANALYZER}" manifest debuggable "${APK}")" = false

# reject unsigned or corrupted installable artifacts
"${ANDROID_HOME}/build-tools/36.0.0/apksigner" verify "${APK}"
# trust only the supplied upload key and require all bundle entries to verify
jarsigner -verify -strict \
  -keystore "${ANDROID_UPLOAD_KEYSTORE_FILE}" \
  -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD \
  "${AAB}" "${ANDROID_UPLOAD_KEY_ALIAS}"
sha256sum "${APK}" "${AAB}"
printf 'signed Weather release artifacts verified\n'
