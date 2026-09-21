#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
RUNTIME_DIR=""
SERVER_PID=""

# report one command-line failure
usage() {
  printf 'usage: %s --evidence-dir ABSOLUTE_PATH -- command [args...]\n' "$0" >&2
  exit 64
}

# stop the server and remove private runtime material
# shellcheck disable=SC2329
cleanup() {
  local cleanup_status=0

  # request an orderly receipt-producing shutdown
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" || cleanup_status=$?
  fi

  # remove only this wrapper-created private directory
  if [[ -n "${RUNTIME_DIR}" ]] && [[ "${RUNTIME_DIR}" == "${TMPDIR:-/tmp}"/weather-native-https.* ]]; then
    rm -rf -- "${RUNTIME_DIR}"
  fi

  return "${cleanup_status}"
}

# stop on interrupts without running a child command afterward
# shellcheck disable=SC2329
handle_signal() {
  exit 130
}

EVIDENCE_DIR=""

# parse the one supported wrapper option
if [[ "${1:-}" == "--evidence-dir" ]] && [[ -n "${2:-}" ]]; then
  EVIDENCE_DIR=$2
  shift 2
# reject unknown wrapper options
else
  usage
fi

# require an explicit child command
if [[ "${1:-}" != "--" ]]; then
  usage
fi
shift
if [[ "$#" -eq 0 ]]; then
  usage
fi

# require an absolute evidence boundary outside the checkout
if [[ "${EVIDENCE_DIR}" != /* ]]; then
  printf 'fixture evidence directory must be absolute\n' >&2
  exit 64
fi
EVIDENCE_DIR=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${EVIDENCE_DIR}")
if [[ "${EVIDENCE_DIR}" == "${REPOSITORY_ROOT}" ]] || [[ "${EVIDENCE_DIR}" == "${REPOSITORY_ROOT}/"* ]]; then
  printf 'fixture evidence directory must be outside the repository\n' >&2
  exit 64
fi

# create one empty public evidence boundary
umask 077
if [[ -e "${EVIDENCE_DIR}" ]]; then
  # reject links files reused outputs and mixed evidence
  if [[ ! -d "${EVIDENCE_DIR}" ]] || [[ -L "${EVIDENCE_DIR}" ]] || [[ -n "$(find "${EVIDENCE_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    printf 'fixture evidence directory must be a new or empty real directory\n' >&2
    exit 64
  fi
# create one new evidence directory
else
  mkdir -p "${EVIDENCE_DIR}"
fi
chmod 0700 "${EVIDENCE_DIR}"

# create private certificate material outside Git and retained artifacts
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/weather-native-https.XXXXXXXX")
chmod 0700 "${RUNTIME_DIR}"
trap cleanup EXIT
trap handle_signal INT TERM HUP

# launch the fixture without copying private server output into evidence
python3 "${SCRIPT_DIR}/native_https_fixture.py" \
  --runtime-dir "${RUNTIME_DIR}" \
  --evidence-dir "${EVIDENCE_DIR}" \
  >"${RUNTIME_DIR}/server.stdout" \
  2>"${RUNTIME_DIR}/server.stderr" &
SERVER_PID=$!

# wait a bounded interval for certificate-verified server readiness
for _attempt in $(seq 1 120); do
  if [[ -s "${RUNTIME_DIR}/ready.json" ]] && [[ -s "${RUNTIME_DIR}/environment.sh" ]]; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    wait "${SERVER_PID}" || true
    cat "${RUNTIME_DIR}/server.stderr" >&2
    printf 'native HTTPS fixture exited before readiness\n' >&2
    exit 1
  fi
  sleep 0.25
done
if [[ ! -s "${RUNTIME_DIR}/ready.json" ]] || [[ ! -s "${RUNTIME_DIR}/environment.sh" ]]; then
  printf 'native HTTPS fixture readiness timed out\n' >&2
  exit 1
fi

# export the bounded fixture contract into the child process
# shellcheck source=/dev/null
source "${RUNTIME_DIR}/environment.sh"
set +e
"$@"
CHILD_STATUS=$?
set -e

# stop the fixture before exposing terminal sanitized receipts
kill -TERM "${SERVER_PID}" 2>/dev/null || true
set +e
wait "${SERVER_PID}"
SERVER_STATUS=$?
set -e
SERVER_PID=""
if [[ "${SERVER_STATUS}" -ne 0 ]]; then
  cat "${RUNTIME_DIR}/server.stderr" >&2
  printf 'native HTTPS fixture shutdown failed\n' >&2
  exit "${SERVER_STATUS}"
fi

# remove private material before writing the retained boundary receipt
rm -rf -- "${RUNTIME_DIR}"
RUNTIME_DIR=""
cat >"${EVIDENCE_DIR}/lifecycle.json" <<'JSON'
{
  "privateKeysArchived": false,
  "receiptVersion": 1,
  "runtimeRemoved": true,
  "untrustedCaArchived": false
}
JSON
chmod 0644 "${EVIDENCE_DIR}/lifecycle.json"

# require a successful child to prove the complete browser journey
if [[ "${CHILD_STATUS}" -eq 0 ]]; then
  python3 "${SCRIPT_DIR}/verify_native_https_fixture_evidence.py" "${EVIDENCE_DIR}"
fi

exit "${CHILD_STATUS}"
