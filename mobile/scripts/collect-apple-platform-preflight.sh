#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
evidence_dir=${MOBILE_M0_EVIDENCE_DIR:-${TMPDIR:-/tmp}/weather-mobile-m0/apple-platform}
status_file="${evidence_dir}/command-status.tsv"

mkdir -p "${evidence_dir}"
: >"${status_file}"

# capture a command without hiding later evidence
capture_command() {
  local label=$1
  shift
  local output_path="${evidence_dir}/${label}.txt"
  local status=0

  set +e
  "$@" >"${output_path}" 2>&1
  status=$?
  set -e

  printf '%s\t%s\n' "${label}" "${status}" >>"${status_file}"
  printf '=== %s (exit %s) ===\n' "${label}" "${status}"
  cat "${output_path}"
}

# read a captured command status
captured_status() {
  local label=$1

  awk -F '\t' -v label="${label}" '$1 == label { status = $2 } END { print status }' "${status_file}"
}

# record safe runner identity
{
  printf 'repository=%s\n' "${GITHUB_REPOSITORY:-local}"
  printf 'sha=%s\n' "${GITHUB_SHA:-$(git -C "${repo_root}" rev-parse HEAD)}"
  printf 'run_id=%s\n' "${GITHUB_RUN_ID:-local}"
  printf 'image_os=%s\n' "${ImageOS:-unknown}"
  printf 'image_version=%s\n' "${ImageVersion:-unknown}"
  printf 'developer_dir=%s\n' "${DEVELOPER_DIR:-unset}"
} >"${evidence_dir}/runner.txt"

capture_command uname uname -a
capture_command architecture uname -m
capture_command macos-version sw_vers
capture_command selected-developer-directory xcode-select -p
capture_command xcodebuild-version xcodebuild -version
capture_command simulator-sdk-version xcrun --sdk iphonesimulator --show-sdk-version
capture_command simulator-runtimes xcrun simctl list runtimes --json
capture_command simulator-devices xcrun simctl list devices available --json
capture_command xcdebug-find xcrun --find xcdebug

# capture non-gating visual-control contracts
capture_command simctl-ui-help xcrun simctl help ui
capture_command xcresulttool-export-attachments-help xcrun xcresulttool export attachments --help

# inspect only the documented top-level help surface
if [[ "$(captured_status xcdebug-find)" == "0" ]]; then
  capture_command xcdebug-help xcrun xcdebug --help
else
  printf 'xcdebug was not found in the selected developer directory.\n' >"${evidence_dir}/xcdebug-help.txt"
  printf 'xcdebug-help\t127\n' >>"${status_file}"
fi

# select a pinned-runtime iPhone without private simulator APIs
python3 - "${evidence_dir}/simulator-devices.txt" "${evidence_dir}/selected-simulator.json" "${evidence_dir}/selected-simulator-udid.txt" <<'PY'
import json
import sys

devices_path, selection_path, udid_path = sys.argv[1:]
with open(devices_path, encoding="utf-8") as source:
    payload = json.load(source)

matches = []

# inspect installed runtime groups
for runtime, devices in payload.get("devices", {}).items():
    # keep the pinned iOS runtime only
    if not runtime.endswith("iOS-26-5"):
        continue

    # inspect available iPhones
    for device in devices:
        # exclude unavailable and non-iPhone devices
        if not device.get("isAvailable", False) or not device.get("name", "").startswith("iPhone"):
            continue
        matches.append((device.get("name") != "iPhone 17", device.get("name", ""), runtime, device))

matches.sort(key=lambda item: item[:2])
selection = None

# select the preferred pinned-runtime device
if matches:
    _, _, runtime, device = matches[0]
    selection = {
        "name": device["name"],
        "runtime": runtime,
        "state": device.get("state"),
        "udid": device["udid"],
    }

with open(selection_path, "w", encoding="utf-8") as destination:
    json.dump(selection, destination, indent=2, sort_keys=True)
    destination.write("\n")

# publish the selected identifier when available
if selection is not None:
    with open(udid_path, "w", encoding="utf-8") as destination:
        destination.write(f"{selection['udid']}\n")
PY

probe_status=0

# require the pinned runner architecture
if [[ "$(cat "${evidence_dir}/architecture.txt")" != "arm64" ]]; then
  printf 'Expected ARM64 macos-26 runner.\n' >&2
  probe_status=1
fi

# require the pinned Xcode version
if ! grep -qx 'Xcode 26\.6' "${evidence_dir}/xcodebuild-version.txt"; then
  printf 'Expected Xcode 26.6.\n' >&2
  probe_status=1
fi

# require the pinned Simulator SDK
if [[ "$(cat "${evidence_dir}/simulator-sdk-version.txt")" != "26.5" ]]; then
  printf 'Expected iOS Simulator SDK 26.5.\n' >&2
  probe_status=1
fi

# boot the selected public Simulator device
if [[ -s "${evidence_dir}/selected-simulator-udid.txt" ]]; then
  simulator_udid=$(cat "${evidence_dir}/selected-simulator-udid.txt")
  capture_command simulator-boot xcrun simctl boot "${simulator_udid}"
  capture_command simulator-boot-status xcrun simctl bootstatus "${simulator_udid}" -b
  capture_command simulator-open open -a Simulator --args -CurrentDeviceUDID "${simulator_udid}"
  sleep 3
  capture_command simulator-screenshot xcrun simctl io "${simulator_udid}" screenshot "${evidence_dir}/simulator-springboard-unconfigured.png"

  # require a booted Simulator and screenshot capability
  if [[ "$(captured_status simulator-boot-status)" != "0" || ! -s "${evidence_dir}/simulator-springboard-unconfigured.png" ]]; then
    printf 'Pinned Simulator boot or screenshot failed.\n' >&2
    probe_status=1
  fi
else
  printf 'No available iPhone on the pinned iOS 26.5 runtime.\n' >&2
  probe_status=1
fi

python3 - "${evidence_dir}" "${probe_status}" <<'PY'
import json
import os
import pathlib
import sys

evidence_dir = pathlib.Path(sys.argv[1])
probe_status = int(sys.argv[2])
statuses = {}

# load command outcomes
for line in (evidence_dir / "command-status.tsv").read_text(encoding="utf-8").splitlines():
    label, status = line.split("\t", 1)
    statuses[label] = int(status)

selection = None
selection_path = evidence_dir / "selected-simulator.json"

# retain the public Simulator selection
if selection_path.exists():
    selection = json.loads(selection_path.read_text(encoding="utf-8"))

receipt = {
    "blocker": "M0-IOS-HOST-ACCESS",
    "commandStatuses": statuses,
    "hostProofEstablished": False,
    "hostProofReason": (
        "The screenshot proves only that the pinned Simulator and SpringBoard booted. "
        "No widget was placed, rendered, refreshed, or tapped."
    ),
    "image": {
        "os": os.environ.get("ImageOS", "unknown"),
        "version": os.environ.get("ImageVersion", "unknown"),
    },
    "probePassed": probe_status == 0,
    "repository": os.environ.get("GITHUB_REPOSITORY", "local"),
    "runId": os.environ.get("GITHUB_RUN_ID", "local"),
    "selectedSimulator": selection,
    "sha": os.environ.get("GITHUB_SHA"),
    "xcode": "26.6",
    "simulatorSdk": "26.5",
}

(evidence_dir / "receipt.json").write_text(
    json.dumps(receipt, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

checksum_file=$(mktemp "${TMPDIR:-/tmp}/weather-mobile-checksums.XXXXXX")

# hash the complete bounded receipt
(
  cd "${evidence_dir}"
  find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort >"${checksum_file}"
)
mv "${checksum_file}" "${evidence_dir}/SHA256SUMS.txt"

cat "${evidence_dir}/receipt.json"

# fail only when the pinned public platform probe is unavailable
if [[ "${probe_status}" != "0" ]]; then
  exit "${probe_status}"
fi

printf '::warning title=M0 iOS host access remains open::The probe booted Simulator only; it did not place or verify the widget on SpringBoard.\n'
