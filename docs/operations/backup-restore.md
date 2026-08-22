# Encrypted backup and disposable restore verification

Weather backup streams a PostgreSQL custom-format dump directly into `age`,
publishes the encrypted artifact and adjacent SHA-256 checksum as a cleaned-up
pair, synchronizes their durable directory entries, and sets both files to mode
`0600`. It never writes a plaintext dump. The ignored
`deploy/config/backup.env` contains a public recipient, not a private identity.

## Create a backup

```bash
deploy/scripts/backup.sh \
  --recipient "$AGE_RECIPIENT" \
  --output-dir /var/lib/weather/backups
```

The default destination is `/var/lib/weather/backups`. A successful run leaves
only `weather-*.dump.age` and matching `.sha256` files. Interrupted partial or
half-published pairs are removed. Copy encrypted artifacts off-host under an
operator-reviewed retention policy.

## Verify a restore

Keep the age identity outside the repository and run:

```bash
deploy/scripts/restore.sh verify \
  /var/lib/weather/backups/weather-<timestamp>-<nonce>.dump.age \
  --identity /secure/operator/weather-backup-key.txt
```

Verification checks the ciphertext checksum, decrypts directly into
`pg_restore`, creates a unique `weather_verify_*` database, and validates the
PostgreSQL 15+ floor, exact migration checksums, runtime role restrictions,
table counts, and representative row hashes. It drops the candidate on success
and failure. `--retain` is only for an explicitly reviewed diagnostic session;
the printed candidate name must later be dropped by the operator.

## Authority boundary

The API and ingestion roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE` and never
receive restore authority. The root-owned operator wrapper is the only boundary
allowed to use the database administrator for unique candidate creation and
deletion. `restore.sh replace` and `restore.sh cutover` are rejected. Live
replacement requires a future separately approved staged-cutover plan.

## Fault checks

In disposable local Compose only:

1. verify a known-good backup;
2. corrupt a copy of its checksum and prove verification fails before database
   creation;
3. corrupt a ciphertext copy and prove decryption/restore fails while the live
   `weather` database remains unchanged;
4. confirm no `weather_verify_*` database remains after either failure; and
5. confirm no plaintext dump or `.partial` artifact remains.

These procedures are local/staging checks. They do not perform a production
restore or grant permission to mutate production data.
