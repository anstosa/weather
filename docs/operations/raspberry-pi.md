# Raspberry Pi operations

This runbook describes the isolated Weather deployment for the ARM64 host
`blueberry`. It adapts the health-gated release pattern used by the neighboring
application without sharing that application's paths, identities, networks,
credentials, connector, unit, or lifecycle. Repository verification is
deliberately static and does not perform a production deployment.

## Isolation contract

- Compose project: `weather`
- release root: `/opt/weather/current`
- durable data: `/var/lib/weather/postgres` and `/var/lib/weather/xweather/usage.json`
- encrypted rolling backup: local `deploy/backups/weather-nightly.dump.age`
- application UID/GID: `10002:10002`
- SSH account: `weather-ssh`
- systemd unit: `weather-compose.service`
- public origin after the private gates: `https://weather.ballydidean.farm`

The production Compose file publishes no host ports. `edge`, `web_api`, and
`data` are internal. Only the worker joins `provider_egress`, only the web edge
joins `map_egress`, and only cloudflared joins `tunnel_egress`. The Weather
connector token is not interchangeable with any other connector token.
The service-level `mem_limit` values are authoritative on ordinary Compose;
do not run a host policy that widens those limits after container creation.

## Provisioning

1. Create `/opt/weather`, `/var/lib/weather/postgres`, `/var/lib/weather/xweather`,
   and `/var/lib/weather/backups` without touching neighboring application paths.
2. Provision the PostgreSQL directory for the pinned image's `999:999` user,
   provision the Xweather directory for `10002:10002`, and make
   `/opt/weather/current` root-owned after release extraction.
3. Copy `deploy/.env.example` to ignored `deploy/.env`. Set the server and web
   repositories, the pinned PostgreSQL tag, and the pinned cloudflared tag used
   as staging inputs. Staging replaces all four with exact Linux ARM64
   `name@sha256:<digest>` references; `WEATHER_RELEASE` remains a label only.
   Staging also records a digest and compatibility version for Compose,
   lifecycle scripts, and the runtime ACL contract. Stage, activate, recover,
   and rollback fail closed on an incompatible control-plane version or digest.
   Control-plane version 6 allowlists only the exact installed version 5
   production digest as its predecessor. All other cross-version or
   cross-digest handoffs are unsupported. Do not rewrite release metadata or
   use wildcard handoffs: every mutating lifecycle action rejects any other
   mismatch before changing images, containers, the database, or release state.
4. Generate separate long random administrator, owner, API, and ingestion
   passwords. The administrator and owner values must differ. Install the four
   `weather_postgres_*` sources for `999:999`; the administrator source is
   mounted only into PostgreSQL. Install matching owner, API, and ingestion
   application copies as `weather_migration_owner_password`,
   `weather_api_password`, and `weather_worker_ingest_password` for
   `10002:10002`. Install `weather_tempest_api_key`,
   `weather_xweather_client_id`, and `weather_xweather_client_secret` for
   `10002:10002`, and the tunnel token for `65532:65532`. Every source must be
   mode `0400`; Compose file secrets cannot repair host ownership or modes.
5. Copy `deploy/config/backup.env.example` to ignored `backup.env` and set only
   the public age recipient matching the local identity. The nightly pull stores
   only ciphertext in the repository's ignored `deploy/backups/` directory.
6. Install root-owned scripts as `/usr/local/bin/weather-ssh-dispatch` and
   `/usr/local/sbin/weather-remote-ops`; validate the sudoers rule with
   `visudo -cf deploy/sudoers/weather-ops`.
7. Configure an Ed25519 key in `weather-ssh`'s `authorized_keys` with the forced
   command `/usr/local/bin/weather-ssh-dispatch`, no agent/port/X11 forwarding,
   and no PTY. Configure `sshd` with `PermitRootLogin no`,
   `PasswordAuthentication no`, and a `Match User weather-ssh` block.
8. Install and enable the root-owned `weather-compose.service`. It has no
   dependency on another application unit.

## Optional capacity diagnostics

The direct deployment path does not require a capacity sample. Run the retained
diagnostic manually when investigating host pressure:

```bash
sudo /opt/weather/current/deploy/scripts/preflight-capacity.sh \
  --sample-seconds 900 \
  --json /var/lib/weather/preflight-$(date -u +%Y%m%dT%H%M%SZ).json
```

The gate requires `aarch64`, at least four CPUs, 15-minute load no greater than
`0.50 * CPUs`, minimum available memory of 1,792 MiB, swap traffic no greater
than 1 MiB/minute, at least 10 GiB and `3 * database bytes + 5 GiB` free under
`/var/lib`, at least 4 GiB free in Docker's data root, and at least 10% free
inodes. A failed diagnostic does not authorize pruning Docker or changing
neighboring services.

## Database read-latency recovery

The historical archive dominates `weather_records`, so PostgreSQL's default
table-wide maintenance thresholds can leave the smaller live-source datasets
with stale planner statistics and poor visibility-map coverage. Check
`pg_stat_user_tables`, `pg_stat_progress_vacuum`, and the affected query's
`EXPLAIN (ANALYZE, BUFFERS)` before changing query timeouts or adding indexes.

Run this bounded online maintenance from an authorized host administrator shell.
The separate `-c` arguments keep `VACUUM` outside a transaction. Cost throttling,
disabled truncation, and disabled parallel vacuum limit interference with the
live stack; do not substitute `VACUUM FULL`.

```bash
sudo docker exec -u postgres weather-postgres-1 psql -X \
  -v ON_ERROR_STOP=1 -d weather \
  -c "SET lock_timeout='5s'; SET statement_timeout='30min'; SET vacuum_cost_delay='2ms'; SET vacuum_cost_limit=200; SET maintenance_work_mem='64MB';" \
  -c "VACUUM (ANALYZE, VERBOSE, TRUNCATE FALSE, PARALLEL 0) public.weather_records;"
```

After maintenance completes, the production table uses these persistent,
table-local overrides rather than widening global resource limits:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public.weather_records SET (
  autovacuum_vacuum_scale_factor = 0.001,
  autovacuum_vacuum_insert_scale_factor = 0.001,
  autovacuum_analyze_scale_factor = 0.001
);
COMMIT;
```

At roughly 11.7 million rows, these retain the default base thresholds while
making maintenance eligible after approximately 12,000 changed rows instead of
more than a million. Verify the overrides after restoring a database, and watch
maintenance duration, application latency, and query heap fetches for 48–72 hours.
These are workload-specific starting values, not a universal PostgreSQL preset.
To return to inherited defaults, use the same short lock timeout with
`ALTER TABLE public.weather_records RESET (autovacuum_vacuum_scale_factor,
autovacuum_vacuum_insert_scale_factor, autovacuum_analyze_scale_factor)`.

See PostgreSQL 17's [vacuuming guidance](https://www.postgresql.org/docs/17/routine-vacuuming.html)
and [online VACUUM options](https://www.postgresql.org/docs/17/sql-vacuum.html).

## Direct deployment

Use the key-based client wrapper:

```bash
deploy/scripts/ssh-run.sh status
deploy/scripts/ssh-run.sh yolo 2026.08.25-1
deploy/scripts/ssh-run.sh status
```

The equivalent repository commands are:

```bash
npm run remote:status
npm run remote:deploy -- 2026.08.25-1
npm run remote:tunnel:check
npm run remote:tempest:backfill
npm run remote:public-stations:backfill
npm run remote:backup:pull
```

The SSH-backed commands require a loaded agent containing the deployment key.
The HTTPS tunnel check and test URL commands do not require SSH access.
The Tempest backfill command imports every active configured station through
yesterday, resumes only exact successful chunks, and stores its private report
under `/var/lib/weather` on the server.

## Xweather map budget

The forecast map requests one 256×168 single-layer static image per provider
frame, which Xweather counts as one raster map unit. The browser permanently
caches historical frames, retains forecast frames for one hour, and warms only
the seven frames nearest the selected time for the selected layer. The server
coalesces concurrent misses, retains historical frames for its process lifetime,
and refreshes forecast frames on demand after one hour. There is no scheduled
all-layer refresh and no public manual refresh operation.

The server reserves every provider miss in
`/var/lib/weather/xweather/usage.json` before issuing it. The persisted ceiling
is 300 map units per UTC day and 10,000 per UTC month, leaving at least 5,000 of
Xweather's shared 15,000-access free tier for other account activity. The ledger
survives deploys and container restarts. When enabling the ledger after earlier
account use, seed its current `monthUnits` and `dayUnits` from the Xweather
dashboard before starting the web service; never reset it to recover capacity.

The non-secret remote host and tunnel origin are recorded in
`config/runtime-targets.json`. `npm run test:urls` prefers that tunnel;
`npm run test:urls:local` is the explicit loopback override.

`yolo` resolves and records all four exact ARM64 manifest digests, validates the
Compose render, pulls images, applies checked forward migrations, starts the
Weather stack with Compose health gates, and records release state last. It does
not require capacity evidence, create a compatibility database, or create a
deployment-time backup. The nightly local encrypted backup is the recovery copy.

## Legacy staged diagnostics

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
the recorded runtime against that retained schema authorization. The public
hostname route remains a separate, leader-authorized post-activation operation.

## Nightly local backup

The local user timer runs `deploy/scripts/pull-backup.sh` at 02:30. It requests
an age-encrypted PostgreSQL custom dump through the forced-command Weather SSH
account, verifies complete decryption and `pg_restore --list` locally, and then
atomically replaces the gitignored rolling backup and checksum. No plaintext
database dump is written on either host.

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

For the separate read-only production snapshot, model-evidence, activation,
and restart-only rollback boundaries, see
[`forecast adjustment operations and governance`](forecast-adjustment.md).
