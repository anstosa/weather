#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS="${RESULTS:-$IOS_ROOT/.artifacts}"
EXPECTED_DEVELOPER_DIR="/Applications/Xcode_26.6.app/Contents/Developer"

mkdir -p "$RESULTS"

# select the reviewed Xcode installation
if [[ "${DEVELOPER_DIR:-}" != "$EXPECTED_DEVELOPER_DIR" ]]; then
  echo "DEVELOPER_DIR must be $EXPECTED_DEVELOPER_DIR" >&2
  exit 1
fi

# require every Apple command-line tool
for tool in xcodebuild xcrun plutil strings shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 1
  fi
done

XCODE_VERSION="$(xcodebuild -version)"
SIMULATOR_SDK="$(xcrun --sdk iphonesimulator --show-sdk-version)"
RUNTIMES_JSON="$(xcrun simctl list runtimes --json)"
DEVICES_JSON="$(xcrun simctl list devices available --json)"

# pin the reviewed Xcode release
if ! grep -q '^Xcode 26\.6$' <<<"$XCODE_VERSION"; then
  echo "expected Xcode 26.6, received: $XCODE_VERSION" >&2
  exit 1
fi

# pin the reviewed Simulator SDK
if [[ "$SIMULATOR_SDK" != "26.5" ]]; then
  echo "expected iOS Simulator SDK 26.5, received: $SIMULATOR_SDK" >&2
  exit 1
fi

# require the reviewed runtime and device
if ! grep -q 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' <<<"$RUNTIMES_JSON"; then
  echo "iOS 26.5 Simulator runtime is unavailable" >&2
  exit 1
fi
if ! grep -q 'iPhone 17' <<<"$DEVICES_JSON"; then
  echo "an iPhone 17 Simulator is unavailable" >&2
  exit 1
fi

{
  printf 'runner_image=%s\n' "${ImageOS:-unknown}"
  printf 'runner_image_version=%s\n' "${ImageVersion:-unknown}"
  printf 'developer_dir=%s\n' "$DEVELOPER_DIR"
  printf '%s\n' "$XCODE_VERSION"
  printf 'simulator_sdk=%s\n' "$SIMULATOR_SDK"
  printf 'machine=%s\n' "$(uname -m)"
  printf '%s\n' "$RUNTIMES_JSON"
  printf '%s\n' "$DEVICES_JSON"
} > "$RESULTS/toolchain.txt"

echo "iOS toolchain preflight passed; evidence: $RESULTS/toolchain.txt"
