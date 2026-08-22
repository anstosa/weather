# Raspberry Pi operations

This runbook describes the isolated Weather deployment for the ARM64 host
`blueberry`. It adapts the health-gated release pattern used by the neighboring
application without sharing that application's paths, identities, networks,
credentials, connector, unit, or lifecycle. Repository verification is
deliberately static and does not perform a production deployment.

## Isolation contract

- Compose project: `weather`
- release root: `/opt/weather/current`
- durable data: `/var/lib/weather/postgres`
- encrypted backups: `/var/lib/weather/backups`
- application UID/GID: `10002:10002`
- SSH account: `weather-ssh`
- systemd unit: `weather-compose.service`
- public origin after the private gates: `https://weather.santosa.family`

The production Compose file publishes no host ports. `edge`, `web_api`, and
`data` are internal. Only the worker joins `provider_egress`; only cloudflared
joins `tunnel_egress`. The Weather connector token is not interchangeable with
any other connector token.

## Provisioning

1. Create `/opt/weather`, `/var/lib/weather/postgres`, and
   `/var/lib/weather/backups` without touching neighboring application paths.
2. Provision the PostgreSQL directory for the pinned image's `999:999` user and
   make `/opt/weather/current` root-owned after release extraction.
3. Copy `deploy/.env.example` to ignored `deploy/.env`. Set the server and web
   repositories, the pinned PostgreSQL tag, and the pinned cloudflared tag used
   as staging inputs. Staging replaces all four with exact Linux ARM64
   `name@sha256:<digest>` references; `WEATHER_RELEASE` remains a label only.
   Staging also records a digest and compatibility version for Compose,
   lifecycle scripts, and the runtime ACL contract. Stage, activate, recover,
   and rollback fail closed on an incompatible control-plane version or digest.
   This release allowlists no cross-version or cross-digest control-plane
   handoff. Any control-plane change is therefore unsupported until the already
   installed version contains an explicit versioned allowlist for that exact
   source and target. Do not rewrite release metadata or use wildcard handoffs:
   every mutating lifecycle action rejects the mismatch before changing images,
   containers, the database, or release state.
4. Generate separate long random administrator, owner, API, and ingestion
   passwords. The administrator and owner values must differ. Install the four
   `weather_postgres_*` sources for `999:999`; the administrator source is
   mounted only into PostgreSQL. Install matching owner, API, and ingestion
   application copies as `weather_migration_owner_password`,
   `weather_api_password`, and `weather_worker_ingest_password` for
   `10002:10002`. Install the tunnel token for `65532:65532`. Every source must
   be mode `0400`; Compose file secrets cannot repair host ownership or modes.
5. Copy `deploy/config/backup.env.example` to ignored `backup.env` and set only
   a public age recipient. Enforce off-host retention outside this repository.
6. Install root-owned scripts as `/usr/local/bin/weather-ssh-dispatch` and
   `/usr/local/sbin/weather-remote-ops`; validate the sudoers rule with
   `visudo -cf deploy/sudoers/weather-ops`.
7. Configure an Ed25519 key in `weather-ssh`'s `authorized_keys` with the forced
   command `/usr/local/bin/weather-ssh-dispatch`, no agent/port/X11 forwarding,
   and no PTY. Configure `sshd` with `PermitRootLogin no`,
   `PasswordAuthentication no`, and a `Match User weather-ssh` block.
8. Install and enable the root-owned `weather-compose.service`. It has no
   dependency on another application unit.

## Capacity and coexistence gate

Before production mutation, prove the Weather identifiers are unused, capture
the neighboring application's health/restart/config baseline, and run:

```bash
sudo /opt/weather/current/deploy/scripts/preflight-capacity.sh \
  --sample-seconds 900 \
  --json /var/lib/weather/preflight-$(date -u +%Y%m%dT%H%M%SZ).json
```

The gate requires `aarch64`, at least four CPUs, 15-minute load no greater than
`0.50 * CPUs`, minimum available memory of 1,792 MiB, swap traffic no greater
than 1 MiB/minute, at least 10 GiB and `3 * database bytes + 5 GiB` free under
`/var/lib`, at least 4 GiB free in Docker's data root, and at least 10% free
inodes. A failure blocks Weather; it does not authorize pruning Docker, changing
other services, or weakening limits.

## Stage and activate

Use the key-based client wrapper:

```bash
deploy/scripts/ssh-run.sh status
deploy/scripts/ssh-run.sh stage 2026.08.22-1
deploy/scripts/ssh-run.sh activate 2026.08.22-1
deploy/scripts/ssh-run.sh status
```

Stage requires a passing 15-minute capacity result from the prior hour, resolves
and records all four exact ARM64 manifest digests, validates the complete Compose
render, and pulls without changing running services. On upgrades it creates and
drops only a unique compatibility database, applies the candidate's trailing
migrations, runs the previous API image's `/api/v1/health`, `/api/v1/sites`,
`/current`, and `/history` reads, and runs one previous worker loop against a
credential-free deterministic provider stub. The existing release must match
the installed control plane before these checks. When staging adds migration
history, the same previous API and worker images must first reject the candidate
ledger without the exact authorization, so a binary that ignores the
authorization contract cannot be staged for rollback. Code-only upgrades keep
exact ordinary readiness and do not require a rejection probe. Only after every
applicable rejection and real previous-image check passes, staging publishes a
no-replace private authorization bound to that previous release and the exact
ordered candidate migration ledger. The first release records compatibility as
not applicable.

Activate requires the pre-provisioned Weather connector token, creates an
encrypted pre-migration backup, runs forward-only checked migrations, starts
the project with Compose health gates, and records the release last. It validates
the existing release against the installed control plane and validates its
rollback authorization before backup or migration. Activation records the
target schema release before the first migration, so a partial migration fails
closed into authorized recovery or operator restore of the encrypted backup.
After a migration-free rollback, every activation except the exact retained
schema release is rejected before capacity checks, backup, Compose, migration,
or state mutation while the runtime trails that schema. Use `recover` to restore
the recorded runtime against that retained schema authorization. The public hostname route remains a
separate, leader-authorized post-activation operation.

After a 15-minute ingestion soak, require at least 512 MiB available memory,
load no greater than `0.75 * CPUs`, no OOM/restart/limit breach, swap no greater
than 1 MiB/minute, and an unchanged neighboring-application baseline.

## Rollback and recovery

```bash
deploy/scripts/ssh-run.sh rollback
deploy/scripts/ssh-run.sh recover
sudo systemctl restart weather-compose.service
```

Rollback applies the previous four immutable Weather images with `--no-deps`; it
never runs backup or migration and never reverses a forward-compatible migration.
Ordinary API and worker readiness rejects every trailing migration. Rollback and
recovery inject the staged release-specific ledger authorization only when an
older proven-compatible image set must run against the retained newer schema;
forward activation clears it, and runtime database roles cannot alter it.
Failed initial activation removes only Weather containers and networks while
preserving `/var/lib/weather`. Cleanup is armed as soon as the first PostgreSQL
service starts, including backup, migration, and health failures. Recovery
reapplies the recorded exact image set after Docker or host restart.

PostgreSQL startup reconciles the mounted administrator secret on both empty and
retained data directories before opening a network listener. Recovery, rollback,
and activation force-recreate only the PostgreSQL container before starting the
runtime images; the data directory is retained. Its health gate authenticates as
`postgres` with the administrator secret rather than relying on `pg_isready`.
To rotate that secret, atomically replace
`deploy/secrets/weather_postgres_admin_password` with another `999:999`, mode
`0400` value that differs from the owner password, then run `recover` through the
normal root-owned operator path. Do not use a plain container restart: recreating
the container is required to pick up an atomically replaced file-secret inode.
Any reconciliation or authenticated-health failure stops recovery before the API,
worker, web, or connector is restarted.

`status` reports connector state, the latest ingestion run, overdue running
work, the latest chunk outcome, and bounded failure classification/code evidence
without printing persisted error messages.

## Local verification

Create local disposable secrets from the examples, then run:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/compose.yaml -f deploy/compose.local.yaml up -d --build --wait
curl --fail http://127.0.0.1:3000/
docker compose --env-file deploy/.env.example \
  -f deploy/compose.yaml -f deploy/compose.local.yaml down --volumes
```

The local web test URL is <http://127.0.0.1:3000/>. Local database/web bindings
remain on loopback and the local override replaces the real connector command.
