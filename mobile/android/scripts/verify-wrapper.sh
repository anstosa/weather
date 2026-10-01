#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}/gradle/wrapper"
sha256sum --check gradle-wrapper.jar.sha256
grep -q '^distributionSha256Sum=bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01$' \
  gradle-wrapper.properties
printf 'gradle wrapper checksums passed\n'
