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
3. Copy `deploy/.env.example` to ignored `deploy/.env` and replace the example
   release with an immutable `YYYY.MM.DD-N` tag.
4. Generate separate long random values from a trusted password generator into
   the four extensionless files named by `deploy/secrets/.gitignore`. Set the
   database files to `0400` for the operator and the tunnel token to `0400` for
   UID/GID `65532` at its final mounted source.
5. Copy `deploy/config/backup.env.example` to ignored `backup.env` and set only
   a public age recipient and retention policy.
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

Stage validates the exact Compose render and ARM64 manifests, pulls without
changing running services, and on upgrades creates and drops only a unique
compatibility database. It migrates the clone and runs the previous server
image's read/provider-stub probes. The first release records that compatibility
as not applicable.

Activate requires the pre-provisioned Weather connector token, creates an
encrypted pre-migration backup, runs forward-only checked migrations, starts
the project with Compose health gates, and records the release last. The public
hostname route remains a separate, leader-authorized post-activation operation.

After a 15-minute ingestion soak, require at least 512 MiB available memory,
load no greater than `0.75 * CPUs`, no OOM/restart/limit breach, swap no greater
than 1 MiB/minute, and an unchanged neighboring-application baseline.

## Rollback and recovery

```bash
deploy/scripts/ssh-run.sh rollback
deploy/scripts/ssh-run.sh recover
sudo systemctl restart weather-compose.service
```

Rollback changes only Weather image configuration; it never reverses a
forward-compatible migration automatically. Failed initial activation removes
only Weather containers and networks while preserving `/var/lib/weather`.
Recovery reapplies the recorded Weather release after Docker or host restart.

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
