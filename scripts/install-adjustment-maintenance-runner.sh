#!/usr/bin/env bash

set -euo pipefail

readonly ADJUSTMENT_RUNNER_NODE="${HOME}/n/bin/node"
readonly ADJUSTMENT_RUNNER_INSTALL_ROOT="${HOME}/.local/lib/weather-adjustment-maintenance"
readonly ADJUSTMENT_RUNNER_UNIT_ROOT="${HOME}/.config/systemd/user"
readonly ADJUSTMENT_RUNNER_SSH_CONFIG="${HOME}/weather/deploy/config/ssh_config"
readonly -a ADJUSTMENT_RUNNER_FILES=(
  "deploy/scripts/adjustment-evidence-store.mjs"
  "scripts/research/adjustment_archive_job.mjs"
  "scripts/research/adjustment_cycle_pages.mjs"
  "scripts/research/adjustment_maintenance_state.mjs"
  "scripts/research/adjustment_plaintext_archive.mjs"
  "scripts/research/adjustment_private_directory.mjs"
  "scripts/systemd/user/weather-adjustment-archive.service"
)

# print one reviewed source manifest
adjustment_runner_manifest_lines() {
  local source_root="$1"
  local source_real
  source_real="$(readlink -f -- "${source_root}")"

  # require a literal owner-controlled checkout root
  if [[ ! -d "${source_root}" || -L "${source_root}" || "${source_real}" != "${source_root}" ||
    "$(stat -c '%u' -- "${source_root}")" != "$(id -u)" ]]; then
    printf '%s\n' "source root is invalid" >&2
    return 1
  fi

  local relative
  # hash only the closed public-code allowlist
  for relative in "${ADJUSTMENT_RUNNER_FILES[@]}"; do
    local path="${source_root}/${relative}"
    local resolved
    resolved="$(readlink -f -- "${path}")"
    # prohibit missing, linked, foreign or writable reviewed members
    if [[ ! -f "${path}" || -L "${path}" || "${resolved}" != "${path}" ||
      "$(stat -c '%u' -- "${path}")" != "$(id -u)" ||
      $((8#$(stat -c '%a' -- "${path}") & 8#022)) -ne 0 ]]; then
      printf 'reviewed source member is not a regular owner file: %s\n' "${relative}" >&2
      return 1
    fi
    printf '%s  %s\n' "$(sha256sum -- "${path}" | cut -d' ' -f1)" "${relative}"
  done
}

# print the closed source manifest identity
adjustment_runner_manifest_digest() {
  local source_root="$1"
  adjustment_runner_manifest_lines "${source_root}" | sha256sum | cut -d' ' -f1
}

# bind every reviewed member to one literal source commit
require_source_commit() {
  local source_root="$1"
  local source_commit="$2"
  # require one full sha-1 commit matching the checkout head
  if [[ ! "${source_commit}" =~ ^[a-f0-9]{40}$ ||
    "$(/usr/bin/git -C "${source_root}" rev-parse --verify HEAD)" != "${source_commit}" ||
    "$(/usr/bin/git -C "${source_root}" rev-parse --verify "${source_commit}^{commit}")" != \
      "${source_commit}" ]]; then
    printf '%s\n' "source commit identity is invalid" >&2
    return 1
  fi
  local relative
  # compare every installed byte to the immutable commit object
  for relative in "${ADJUSTMENT_RUNNER_FILES[@]}"; do
    local committed_sha256
    if ! committed_sha256="$(/usr/bin/git -C "${source_root}" show \
      "${source_commit}:${relative}" | sha256sum | cut -d' ' -f1)"; then
      printf 'source commit member is unavailable: %s\n' "${relative}" >&2
      return 1
    fi
    # reject dirty, untracked or substituted checkout members
    if [[ "${committed_sha256}" != \
      "$(sha256sum -- "${source_root}/${relative}" | cut -d' ' -f1)" ]]; then
      printf 'source commit member differs: %s\n' "${relative}" >&2
      return 1
    fi
  done
}

# require one literal owner-controlled directory
adjustment_require_controlled_directory() {
  local path="$1"
  local privacy="$2"
  local mode
  # reject missing, linked, foreign or path-drifted directories
  if [[ ! -d "${path}" || -L "${path}" || "$(readlink -f -- "${path}")" != "${path}" ||
    "$(stat -c '%u' -- "${path}")" != "$(id -u)" ]]; then
    printf 'controlled directory is invalid: %s\n' "${path}" >&2
    return 1
  fi
  mode="$(stat -c '%a' -- "${path}")"
  # require exact privacy for dedicated roots and no external writes elsewhere
  if [[ "${privacy}" == "private" ]]; then
    if [[ "${mode}" != "700" ]]; then
      printf 'private directory mode is invalid: %s\n' "${path}" >&2
      return 1
    fi
  elif (( (8#${mode} & 8#022) != 0 )); then
    printf 'controlled directory is externally writable: %s\n' "${path}" >&2
    return 1
  fi
}

# require every production ancestor below home to reject broad parent drift
require_install_ancestors() {
  local target
  # validate both the release parent and user-unit root chains
  for target in "$1" "$2"; do
    # prohibit targets outside the fixed current-user home
    if [[ "${target}" != "${HOME}"/* ]]; then
      printf 'install ancestor is outside home: %s\n' "${target}" >&2
      return 1
    fi
    local current="${HOME}"
    local suffix="${target#"${HOME}"/}"
    local segment
    local -a segments=()
    IFS='/' read -r -a segments <<<"${suffix}"
    # inspect every literal ancestor without repairing permissions
    for segment in "${segments[@]}"; do
      current="${current}/${segment}"
      adjustment_require_controlled_directory "${current}" "controlled"
    done
  done
}

# expose one no-op copy verification fault hook
runner_after_copy() {
  :
}

# expose one no-op unit installation fault hook
runner_before_unit_install() {
  :
}

# atomically install the unit from one frozen release
install_runner_unit() {
  local source="$1"
  local destination="$2"
  local temporary="${destination}.incoming-$$"
  runner_before_unit_install "${source}" "${destination}" || return $?
  install -m 0600 -- "${source}" "${temporary}" || return $?
  mv -Tf -- "${temporary}" "${destination}" || return $?
}

# require the pinned runtime and closed job readiness
require_runtime_readiness() {
  local source_root="$1"
  # require exact local executables and fixed ssh configuration
  if [[ ! -x "${ADJUSTMENT_RUNNER_NODE}" ||
    "$("${ADJUSTMENT_RUNNER_NODE}" --version)" != "v24.16.0" ||
    ! -x /usr/bin/ssh || ! -x /usr/bin/flock ||
    ! -f "${ADJUSTMENT_RUNNER_SSH_CONFIG}" || -L "${ADJUSTMENT_RUNNER_SSH_CONFIG}" ]]; then
    printf '%s\n' "adjustment archive runtime readiness is unproven" >&2
    return 1
  fi
  # let the runner prove physical, count and remote readiness without initialization
  "${ADJUSTMENT_RUNNER_NODE}" \
    "${source_root}/scripts/research/adjustment_archive_job.mjs" --readiness >/dev/null
}

# reload only the current user's unit definitions
reload_user_systemd() {
  /usr/bin/systemctl --user daemon-reload
}

# install one immutable disabled runner release
install_adjustment_maintenance_runner() {
  local source_root="$1"
  local source_commit="$2"
  local expected_manifest_sha256="$3"
  local install_root="$4"
  local unit_root="$5"
  local source_manifest_sha256

  # reject caller-selected identities outside lowercase sha-256
  if [[ ! "${expected_manifest_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
    printf '%s\n' "expected source manifest is invalid" >&2
    return 1
  fi
  require_source_commit "${source_root}" "${source_commit}"
  source_manifest_sha256="$(adjustment_runner_manifest_digest "${source_root}")"
  # stop source drift before any installation mutation
  if [[ "${source_manifest_sha256}" != "${expected_manifest_sha256}" ]]; then
    printf '%s\n' "source manifest differs" >&2
    return 1
  fi
  require_runtime_readiness "${source_root}"

  local releases_root="${install_root}/releases"
  local release_root="${releases_root}/${source_commit}"
  local incoming_root="${releases_root}/.incoming-${source_commit}-$$"
  local unit_file="${unit_root}/weather-adjustment-archive.service"
  local current_link="${install_root}/current"
  local current_temporary="${install_root}/.current-$$"
  local transaction_root="${install_root}/.transaction-$$"
  local install_parent
  install_parent="$(dirname -- "${install_root}")"

  umask 0077
  require_install_ancestors "${install_parent}" "${unit_root}"
  adjustment_require_controlled_directory "${install_parent}" "controlled"
  adjustment_require_controlled_directory "${unit_root}" "controlled"
  # create only a missing dedicated root under its already proven parent
  if [[ ! -e "${install_root}" ]]; then
    mkdir -m 0700 -- "${install_root}"
  fi
  adjustment_require_controlled_directory "${install_root}" "private"
  # create only a missing dedicated releases child without permission repair
  if [[ ! -e "${releases_root}" ]]; then
    mkdir -m 0700 -- "${releases_root}"
  fi
  adjustment_require_controlled_directory "${releases_root}" "private"
  # reject replacement of a non-link release pointer
  if [[ -e "${current_link}" && ! -L "${current_link}" ]]; then
    printf '%s\n' "current release pointer is invalid" >&2
    return 1
  fi

  local release_created="false"
  # publish only when the immutable release is absent
  if [[ ! -e "${release_root}" && ! -L "${release_root}" ]]; then
    mkdir -m 0700 -- "${incoming_root}"
    local relative
    # copy every verified member into a regular-file-only layout
    for relative in "${ADJUSTMENT_RUNNER_FILES[@]}"; do
      mkdir -p -- "${incoming_root}/$(dirname -- "${relative}")"
      install -m 0400 -- "${source_root}/${relative}" "${incoming_root}/${relative}"
      runner_after_copy "${relative}" "${incoming_root}" "${source_root}"
    done
    # reject any source race by hashing only the copied frozen bytes
    if [[ "$(adjustment_runner_manifest_digest "${incoming_root}")" != \
      "${expected_manifest_sha256}" ]]; then
      chmod -R u+w -- "${incoming_root}"
      rm -rf -- "${incoming_root}"
      printf '%s\n' "copied release manifest differs" >&2
      return 1
    fi
    adjustment_runner_manifest_lines "${incoming_root}" >"${incoming_root}/MANIFEST.sha256"
    chmod 0400 -- "${incoming_root}/MANIFEST.sha256"
    # freeze every release directory after all files exist
    while IFS= read -r directory; do
      chmod 0500 -- "${directory}"
    done < <(find "${incoming_root}" -type d -print)
    mv -- "${incoming_root}" "${release_root}"
    release_created="true"
  else
    adjustment_require_controlled_directory "${release_root}" "controlled"
    # reuse only the exact immutable release bytes
    if [[ "$(adjustment_runner_manifest_digest "${release_root}")" != \
      "${expected_manifest_sha256}" ]]; then
      printf '%s\n' "installed release manifest differs" >&2
      return 1
    fi
  fi

  mkdir -m 0700 -- "${transaction_root}"
  local previous_current="absent"
  # retain one validated prior release pointer
  if [[ -L "${current_link}" ]]; then
    previous_current="$(readlink -- "${current_link}")"
    if [[ ! "${previous_current}" =~ ^releases/[a-f0-9]{40}$ ]]; then
      printf '%s\n' "current release target is invalid" >&2
      rm -rf -- "${transaction_root}"
      # remove only the unpublished release created by this transaction
      if [[ "${release_created}" == "true" ]]; then
        chmod -R u+w -- "${release_root}"
        rm -rf -- "${release_root}"
      fi
      return 1
    fi
  fi
  local previous_unit="absent"
  # retain one private regular unit for rollback
  if [[ -e "${unit_file}" || -L "${unit_file}" ]]; then
    if [[ ! -f "${unit_file}" || -L "${unit_file}" ||
      "$(stat -c '%u:%a' -- "${unit_file}")" != "$(id -u):600" ]]; then
      printf '%s\n' "existing archive unit is invalid" >&2
      rm -rf -- "${transaction_root}"
      # remove only the unpublished release created by this transaction
      if [[ "${release_created}" == "true" ]]; then
        chmod -R u+w -- "${release_root}"
        rm -rf -- "${release_root}"
      fi
      return 1
    fi
    cp -- "${unit_file}" "${transaction_root}/previous-unit"
    chmod 0600 -- "${transaction_root}/previous-unit"
    previous_unit="present"
  fi

  local activation_status=0
  # activate the pointer and unit as one rollback-capable transaction
  if ln -s -- "releases/${source_commit}" "${current_temporary}" &&
    mv -Tf -- "${current_temporary}" "${current_link}" &&
    install_runner_unit \
      "${release_root}/scripts/systemd/user/weather-adjustment-archive.service" \
      "${unit_file}" &&
    reload_user_systemd \
      "${source_root}" "${expected_manifest_sha256}" "${install_root}" \
      "${release_root}" "${unit_file}" "${unit_root}"; then
    activation_status=0
  else
    activation_status=$?
  fi

  # restore both activation files after any install or reload failure
  if [[ "${activation_status}" -ne 0 ]]; then
    rm -f -- "${current_temporary}" "${unit_file}.incoming-$$"
    if [[ "${previous_current}" == "absent" ]]; then
      rm -f -- "${current_link}"
    else
      ln -s -- "${previous_current}" "${current_temporary}"
      mv -Tf -- "${current_temporary}" "${current_link}"
    fi
    if [[ "${previous_unit}" == "absent" ]]; then
      rm -f -- "${unit_file}"
    else
      install -m 0600 -- "${transaction_root}/previous-unit" "${unit_file}"
    fi
    reload_user_systemd \
      "${source_root}" "${expected_manifest_sha256}" "${install_root}" \
      "${release_root}" "${unit_file}" "${unit_root}" >/dev/null 2>&1 || true
    rm -rf -- "${transaction_root}"
    # remove only the release created and rolled back by this transaction
    if [[ "${release_created}" == "true" ]]; then
      chmod -R u+w -- "${release_root}"
      rm -rf -- "${release_root}"
    fi
    return "${activation_status}"
  fi
  rm -rf -- "${transaction_root}"
}

# execute only the fixed production install surface
main() {
  # accept exactly one reviewed source commit identity
  if [[ "$#" -ne 1 ]]; then
    printf 'usage: %s SOURCE_COMMIT\n' "$0" >&2
    return 2
  fi
  local source_root
  source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  require_source_commit "${source_root}" "$1"
  local manifest_sha256
  manifest_sha256="$(adjustment_runner_manifest_digest "${source_root}")"
  install_adjustment_maintenance_runner \
    "${source_root}" "$1" "${manifest_sha256}" "${ADJUSTMENT_RUNNER_INSTALL_ROOT}" \
    "${ADJUSTMENT_RUNNER_UNIT_ROOT}"
}

# avoid execution when regression tests source this file
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
