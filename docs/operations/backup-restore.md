# Encrypted local backup and disposable restore verification

Weather backup streams a PostgreSQL custom-format dump directly into `age`,
publishes the encrypted artifact and adjacent SHA-256 checksum as a cleaned-up
pair, synchronizes their durable directory entries, and sets both files to mode
`0600`. It never writes a plaintext dump. The ignored
`deploy/config/backup.env` contains a public recipient, not a private identity.

## Pull the production backup locally

```bash
npm run remote:backup:pull
```

The forced-command SSH boundary runs `backup-stream.sh`, which sends only the
age ciphertext on stdout. The local pull writes a temporary ciphertext under
the gitignored `deploy/backups/` directory, fully decrypts it, validates its
PostgreSQL archive table of contents without a plaintext file, and atomically
publishes these rolling files only after verification:

```text
deploy/backups/weather-nightly.dump.age
deploy/backups/weather-nightly.dump.age.sha256
```

The private age identity defaults to
`~/.config/weather/backup-age-key.txt` and remains outside Git. The public
recipient remains in the server's ignored `deploy/config/backup.env`.

## Nightly timer

Install and enable the local user timer:

```bash
install -Dm644 deploy/systemd/weather-backup-local.service \
  "$HOME/.config/systemd/user/weather-backup-local.service"
install -Dm644 deploy/systemd/weather-backup-local.timer \
  "$HOME/.config/systemd/user/weather-backup-local.timer"
systemctl --user daemon-reload
systemctl --user enable --now weather-backup-local.timer
```

The timer runs at 02:30 in the host timezone and is persistent across downtime.
`pull-backup.sh` restores the deployment SSH agent from
`~/.ssh/agent/weather.env` for unattended execution.

Backup, verification restore, and status use `WEATHER_DATABASE_NAME` from the
selected deployment environment.

## Verify a restore

Keep the age identity outside the repository and run:

```bash
deploy/scripts/restore.sh verify \
  deploy/backups/weather-nightly.dump.age \
  --identity "$HOME/.config/weather/backup-age-key.txt"
```

Verification checks the ciphertext checksum, decrypts directly into
`pg_restore`, creates a unique database derived from the configured name,
reapplies the versioned runtime ACL contract, and validates the PostgreSQL 15+
floor, exact migration checksums, effective API/ingestion grants and denials,
table counts, and representative row hashes. It drops the candidate on success
and failure. `--retain` is only for an explicitly reviewed diagnostic session;
the printed candidate name must later be dropped by the operator.

## Authority boundary

The API and ingestion roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE` and never
receive restore authority. The root-owned operator wrapper is the only boundary
allowed to use the database administrator's PostgreSQL-only credential for
unique candidate creation and deletion. That credential is distinct from the
`weather_owner` credential. `restore.sh replace` and `restore.sh cutover` are rejected. Live
replacement requires a future separately approved staged-cutover plan.

## Fault checks

In disposable local Compose only:

1. verify a known-good backup;
2. corrupt a copy of its checksum and prove verification fails before database
   creation;
3. corrupt a ciphertext copy and prove decryption/restore fails while the live
   configured database remains unchanged;
4. confirm no disposable verification database remains after either failure; and
5. confirm no plaintext dump or `.partial` artifact remains.

These procedures are local/staging checks. They do not perform a production
restore or grant permission to mutate production data.
