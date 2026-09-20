#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/scripts/android-env.sh"
printf '%s\n' '--- java ---'
java -version 2>&1
printf '%s\n' '--- gradle ---'
"${ROOT}/gradlew" -p "${ROOT}" --version
printf '%s\n' '--- android packages ---'
sdkmanager --list_installed | grep -E '(^  Path|build-tools;36\.0\.0|emulator |platform-tools |platforms;android-36 |platforms;android-37\.0 |system-images;android-36;default;x86_64)'
printf '%s\n' '--- emulator ---'
emulator -version 2>&1 | head -5
printf '%s\n' '--- adb ---'
adb version
