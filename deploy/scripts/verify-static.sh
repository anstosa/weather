#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

command -v docker >/dev/null
command -v node >/dev/null
command -v shellcheck >/dev/null

# validate shell syntax before semantic checks
for script in deploy/postgres/*.sh deploy/scripts/*.sh; do
  bash -n "$script"
done
shellcheck -x -P deploy/scripts deploy/postgres/*.sh deploy/scripts/*.sh

# validate JavaScript and repository text contracts
for script in deploy/scripts/*.mjs deploy/test/*.mjs; do
  node --check "$script"
done
node scripts/lint.mjs Dockerfile deploy .github/workflows docs/operations

# render production and local models without starting services
docker compose --project-name weather --env-file deploy/.env.example \
  --file deploy/compose.yaml --file deploy/compose.verify.yaml config --quiet
docker compose --project-name weather --env-file deploy/.env.example \
  --file deploy/compose.yaml --file deploy/compose.local.yaml config --quiet
node --test deploy/test/*.test.mjs

# verify the unit against local executable paths
if command -v systemd-analyze >/dev/null; then
  unit=$(mktemp --suffix=.service)
  trap 'rm -f "$unit"' EXIT
  sed \
    -e "s#/opt/weather/current#$repo_root#g" \
    -e "s#/usr/bin/docker#$(command -v docker)#g" \
    deploy/systemd/weather-compose.service >"$unit"
  systemd-analyze verify "$unit"
  rm -f "$unit"
  trap - EXIT
fi

deploy/scripts/backup.sh --help >/dev/null
deploy/scripts/restore.sh --help >/dev/null
deploy/scripts/update.sh --help >/dev/null
deploy/scripts/ssh-run.sh --help >/dev/null
deploy/scripts/preflight-capacity.sh --help >/dev/null

echo "static deployment checks passed; no production, SSH, tunnel, or credentialed action ran"
