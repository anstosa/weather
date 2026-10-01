#!/usr/bin/env bash
set -euo pipefail

# keep task toolchains outside the repository
export JAVA_HOME="${JAVA_HOME:-/home/linuxbrew/.linuxbrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/.cache/weather-android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME}}"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"

# expose user-cached emulator audio libraries when the host omits them
ANDROID_RUNTIME_LIB="${HOME}/.cache/weather-android-runtime/root/usr/lib/x86_64-linux-gnu"
if [[ -d "${ANDROID_RUNTIME_LIB}" ]]; then
  export LD_LIBRARY_PATH="${ANDROID_RUNTIME_LIB}:${ANDROID_RUNTIME_LIB}/pulseaudio${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi
