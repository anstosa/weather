#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version_name="${REQUESTED_VERSION_NAME:-}"

# bind tag builds to the exact android version without overriding a request
if [[ "${GITHUB_REF_TYPE:-}" == tag ]]; then
  # reject unrelated web or ios release tags
  if [[ "${GITHUB_REF_NAME:-}" != android-v* ]]; then
    printf 'Android releases require an android-vVERSION tag\n' >&2
    exit 1
  fi
  tag_version="${GITHUB_REF_NAME#android-v}"
  # never silently replace an explicit version with a tag version
  if [[ -n "${version_name}" && "${version_name}" != "${tag_version}" ]]; then
    printf 'requested version does not match the Android tag\n' >&2
    exit 1
  fi
  version_name="${tag_version}"
fi

# keep version names single-line and safe for gradle and artifact identities
if [[ ! "${version_name}" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]]; then
  printf 'version must use MAJOR.MINOR[.PATCH][-SUFFIX]\n' >&2
  exit 1
fi

# stop before writing any key when release credentials are incomplete
for required in ANDROID_UPLOAD_KEYSTORE_BASE64 ANDROID_UPLOAD_KEYSTORE_PASSWORD \
  ANDROID_UPLOAD_KEY_ALIAS ANDROID_UPLOAD_KEY_PASSWORD PLAY_SERVICE_ACCOUNT_JSON; do
  # report only the missing secret name
  if [[ -z "${!required:-}" ]]; then
    printf 'Missing GitHub Actions secret: %s\n' "${required}" >&2
    exit 1
  fi
done

# validate the service-account structure without printing private content
node --input-type=module <<'JS'
// reject malformed service-account credentials without echoing their values
try {
  const account = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
  // require the fields used by the google play upload action
  if (account.type !== "service_account" ||
    typeof account.client_email !== "string" || !account.client_email.trim() ||
    typeof account.private_key !== "string" || !account.private_key.trim()) {
    throw new Error("invalid account");
  }
} catch {
  process.stderr.write("PLAY_SERVICE_ACCOUNT_JSON must contain a service-account key\n");
  process.exit(1);
}
JS

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
version_code="$("${ROOT}/scripts/android-version-code.sh")"
signing_directory="${RUNNER_TEMP}/weather-android-signing"
key_file="${signing_directory}/upload.jks"
account_file="${signing_directory}/play-service-account.json"

# refuse to reuse a preexisting credential directory
mkdir -m 700 "${signing_directory}"
# remove only the newly created credentials if preparation fails
trap 'rm -f "${key_file}" "${account_file}"; rmdir "${signing_directory}"' ERR
printf '%s' "${ANDROID_UPLOAD_KEYSTORE_BASE64}" | base64 --decode >"${key_file}"
test -s "${key_file}"
chmod 600 "${key_file}"
printf '%s' "${PLAY_SERVICE_ACCOUNT_JSON}" >"${account_file}"
chmod 600 "${account_file}"
printf 'ANDROID_UPLOAD_KEYSTORE_FILE=%s\n' "${key_file}" >>"${GITHUB_ENV}"
printf 'PLAY_SERVICE_ACCOUNT_FILE=%s\n' "${account_file}" >>"${GITHUB_ENV}"
printf 'code=%s\nname=%s\n' "${version_code}" "${version_name}" >>"${GITHUB_OUTPUT}"
