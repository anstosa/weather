#!/usr/bin/env bash
set -euo pipefail

# retain ferry fyi's utc year/day/hour/minute version-code scheme
version_code="$(date -u +%y%j%H%M)"

# reject malformed dates before decimal arithmetic
if [[ ! "${version_code}" =~ ^[0-9]{9}$ ]]; then
  printf 'could not derive a valid Android version code\n' >&2
  exit 1
fi
version_code_number="$((10#${version_code}))"

# stay within google play's positive version-code range
if (( version_code_number <= 0 || version_code_number > 2100000000 )); then
  printf 'derived Android version code is outside the Play range\n' >&2
  exit 1
fi

printf '%s\n' "${version_code_number}"
