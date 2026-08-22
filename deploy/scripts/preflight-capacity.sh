#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print preflight usage
usage() {
  cat <<'EOF'
Usage: preflight-capacity.sh [--sample-seconds SECONDS] [--json OUTPUT]

Samples idle host capacity and writes raw values, thresholds, and pass/fail
results. The production gate uses the default 900-second interval.
EOF
}

sample_seconds=900
json_path=

# parse capacity options
while (($# > 0)); do
  case "$1" in
    --sample-seconds)
      (($# >= 2)) || die "--sample-seconds requires a value"
      sample_seconds=$2
      shift 2
      ;;
    --json)
      (($# >= 2)) || die "--json requires a value"
      json_path=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$sample_seconds" =~ ^[0-9]+$ && "$sample_seconds" -ge 1 ]] ||
  die "sample seconds must be a positive integer"
[[ -n "$json_path" && "$json_path" == /* ]] || die "--json requires an absolute output path"
require_command docker
require_command node
require_command sync

architecture=$(uname -m)
docker_architecture=$(docker info --format '{{.Architecture}}')
cpus=$(nproc)
minimum_memory_bytes=999999999999
swap_start_in=$(awk '$1 == "pswpin" {print $2}' /proc/vmstat)
swap_start_out=$(awk '$1 == "pswpout" {print $2}' /proc/vmstat)
page_size=$(getconf PAGESIZE)
start_epoch=$(date +%s)
end_epoch=$((start_epoch + sample_seconds))

# sample minimum available memory
while (( $(date +%s) < end_epoch )); do
  available_kib=$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)

  # retain the minimum sample
  if (( available_kib * 1024 < minimum_memory_bytes )); then
    minimum_memory_bytes=$((available_kib * 1024))
  fi
  sleep 1
done

load15=$(awk '{print $3}' /proc/loadavg)
swap_end_in=$(awk '$1 == "pswpin" {print $2}' /proc/vmstat)
swap_end_out=$(awk '$1 == "pswpout" {print $2}' /proc/vmstat)
swap_bytes_per_minute=$((
  ((swap_end_in - swap_start_in) + (swap_end_out - swap_start_out)) *
  page_size * 60 / sample_seconds
))
postgres_dir=/var/lib/weather/postgres
database_bytes=0

# measure existing Weather data only
if [[ -d "$postgres_dir" ]]; then
  database_bytes=$(du -sb "$postgres_dir" | awk '{print $1}')
fi

var_lib_free_bytes=$(df -B1 --output=avail /var/lib | tail -n 1 | tr -d ' ')
database_required_bytes=$((3 * database_bytes + 5 * 1024 * 1024 * 1024))
minimum_var_lib_bytes=$((10 * 1024 * 1024 * 1024))

# retain the larger storage gate
if (( database_required_bytes > minimum_var_lib_bytes )); then
  minimum_var_lib_bytes=$database_required_bytes
fi

docker_root=$(docker info --format '{{.DockerRootDir}}')
docker_free_bytes=$(df -B1 --output=avail "$docker_root" | tail -n 1 | tr -d ' ')
var_lib_inode_free_percent=$((100 - $(df -Pi --output=ipcent /var/lib | tail -n 1 | tr -dc '0-9')))
docker_inode_free_percent=$((100 - $(df -Pi --output=ipcent "$docker_root" | tail -n 1 | tr -dc '0-9')))
load_limit=$(awk -v cpus="$cpus" 'BEGIN { printf "%.3f", cpus * 0.50 }')

architecture_pass=false
cpu_pass=false
load_pass=false
memory_pass=false
swap_pass=false
var_lib_pass=false
docker_pass=false
inode_pass=false
[[ "$architecture" == aarch64 && "$docker_architecture" == aarch64 ]] && architecture_pass=true
(( cpus >= 4 )) && cpu_pass=true
awk -v actual="$load15" -v limit="$load_limit" 'BEGIN { exit !(actual <= limit) }' && load_pass=true
(( minimum_memory_bytes >= 1792 * 1024 * 1024 )) && memory_pass=true
(( swap_bytes_per_minute <= 1024 * 1024 )) && swap_pass=true
(( var_lib_free_bytes >= minimum_var_lib_bytes )) && var_lib_pass=true
(( docker_free_bytes >= 4 * 1024 * 1024 * 1024 )) && docker_pass=true
(( var_lib_inode_free_percent >= 10 && docker_inode_free_percent >= 10 )) && inode_pass=true
overall_pass=false

# combine every numeric gate
if [[ "$architecture_pass" == true && "$cpu_pass" == true && "$load_pass" == true &&
  "$memory_pass" == true && "$swap_pass" == true && "$var_lib_pass" == true &&
  "$docker_pass" == true && "$inode_pass" == true ]]; then
  overall_pass=true
fi

temporary=$(mktemp "${json_path}.XXXXXX")
latest_temporary=

# remove interrupted evidence
cleanup() {
  rm -f "$temporary" "$latest_temporary"
}
trap cleanup EXIT

ARCHITECTURE=$architecture \
DOCKER_ARCHITECTURE=$docker_architecture \
CPUS=$cpus \
LOAD15=$load15 \
LOAD_LIMIT=$load_limit \
MINIMUM_MEMORY_BYTES=$minimum_memory_bytes \
SWAP_BYTES_PER_MINUTE=$swap_bytes_per_minute \
DATABASE_BYTES=$database_bytes \
VAR_LIB_FREE_BYTES=$var_lib_free_bytes \
MINIMUM_VAR_LIB_BYTES=$minimum_var_lib_bytes \
DOCKER_ROOT=$docker_root \
DOCKER_FREE_BYTES=$docker_free_bytes \
VAR_LIB_INODE_FREE_PERCENT=$var_lib_inode_free_percent \
DOCKER_INODE_FREE_PERCENT=$docker_inode_free_percent \
SAMPLE_SECONDS=$sample_seconds \
OVERALL_PASS=$overall_pass \
node --input-type=module >"$temporary" <<'NODE'
const number = (name) => Number(process.env[name]);
const pass = (name) => process.env[name] === "true";

console.log(JSON.stringify({
  capturedAt: new Date().toISOString(),
  sampleSeconds: number("SAMPLE_SECONDS"),
  pass: pass("OVERALL_PASS"),
  architecture: {
    host: process.env.ARCHITECTURE,
    docker: process.env.DOCKER_ARCHITECTURE,
    expected: "aarch64",
  },
  cpu: { actual: number("CPUS"), minimum: 4 },
  load15: { actual: number("LOAD15"), maximum: number("LOAD_LIMIT") },
  memoryAvailableBytes: {
    minimumObserved: number("MINIMUM_MEMORY_BYTES"),
    minimumRequired: 1792 * 1024 * 1024,
  },
  swapBytesPerMinute: {
    actual: number("SWAP_BYTES_PER_MINUTE"),
    maximum: 1024 * 1024,
  },
  varLib: {
    databaseBytes: number("DATABASE_BYTES"),
    freeBytes: number("VAR_LIB_FREE_BYTES"),
    minimumFreeBytes: number("MINIMUM_VAR_LIB_BYTES"),
    inodeFreePercent: number("VAR_LIB_INODE_FREE_PERCENT"),
  },
  docker: {
    root: process.env.DOCKER_ROOT,
    freeBytes: number("DOCKER_FREE_BYTES"),
    minimumFreeBytes: 4 * 1024 * 1024 * 1024,
    inodeFreePercent: number("DOCKER_INODE_FREE_PERCENT"),
  },
}));
NODE

chmod 600 "$temporary"
sync -f "$temporary"
mv "$temporary" "$json_path"

# publish only a full passing production sample as the activation gate
if [[ "$overall_pass" == true && "$sample_seconds" -ge 900 ]]; then
  latest=/var/lib/weather/preflight-latest.json
  mkdir -p "$(dirname "$latest")"

  # retain the requested timestamped evidence separately
  if [[ "$json_path" != "$latest" ]]; then
    latest_temporary=$(mktemp "${latest}.XXXXXX")
    cp "$json_path" "$latest_temporary"
    chmod 600 "$latest_temporary"
    sync -f "$latest_temporary"
    mv "$latest_temporary" "$latest"
  fi

  sync -f "$(dirname "$latest")"
fi

sync -f "$(dirname "$json_path")"
trap - EXIT
printf 'Capacity evidence: %s pass=%s\n' "$json_path" "$overall_pass"
[[ "$overall_pass" == true ]]
