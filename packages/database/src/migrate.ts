import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";

import { assertSupportedPostgres, withTransaction } from "./pool.js";

const MIGRATION_LOCK_KEY = 8_032_416_683_782_917;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly current: readonly string[];
  readonly serverVersionNum: number;
}

interface MigrationFile {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
}

// apply checked migrations serially
export async function runMigrations(
  pool: Pool,
  migrationDirectory: string,
  options: Readonly<{
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
  }> = {},
): Promise<MigrationResult> {
  const client = await pool.connect();
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
  let lockHeld = false;

  try {
    const serverVersionNum = await assertSupportedPostgres(client);
    await configureTimeouts(client, lockTimeoutMs, statementTimeoutMs);
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    lockHeld = true;
    await bootstrapMigrationTable(client);
    const migrations = await loadMigrationFiles(migrationDirectory);
    const applied: string[] = [];
    const current: string[] = [];

    // apply files in lexical order
    for (const migration of migrations) {
      const status = await migrationStatus(client, migration);

      // retain verified migrations
      if (status === "current") {
        current.push(migration.name);
        continue;
      }

      await withTransaction(client, async () => {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
      });
      applied.push(migration.name);
    }

    return { applied, current, serverVersionNum };
  } finally {
    // release the session lock
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_KEY,
      ]);
    }

    client.release();
  }
}

// configure bounded lock and statement waits
async function configureTimeouts(
  client: PoolClient,
  lockTimeoutMs: number,
  statementTimeoutMs: number,
): Promise<void> {
  // reject unsafe timeouts
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs < 100 ||
    lockTimeoutMs > 60_000 ||
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 100 ||
    statementTimeoutMs > 300_000
  ) {
    throw new RangeError("migration timeouts must be positive bounded integers");
  }

  await client.query("SELECT set_config('lock_timeout', $1, false)", [
    `${lockTimeoutMs}ms`,
  ]);
  await client.query("SELECT set_config('statement_timeout', $1, false)", [
    `${statementTimeoutMs}ms`,
  ]);
}

// create the checksum ledger before the first file
async function bootstrapMigrationTable(client: PoolClient): Promise<void> {
  await withTransaction(client, async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
  });
}

// load ordered migration files
async function loadMigrationFiles(
  migrationDirectory: string,
): Promise<readonly MigrationFile[]> {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  const migrations: MigrationFile[] = [];

  // fail closed on an empty migration directory
  if (names.length === 0) {
    throw new Error("migration directory contains no ordered SQL files");
  }

  // checksum exact file bytes
  for (const name of names) {
    const sql = await readFile(join(migrationDirectory, name), "utf8");
    migrations.push({
      checksum: createHash("sha256").update(sql).digest("hex"),
      name,
      sql,
    });
  }

  return migrations;
}

// verify an applied checksum
async function migrationStatus(
  client: PoolClient,
  migration: MigrationFile,
): Promise<"current" | "pending"> {
  const result = await client.query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE name = $1",
    [migration.name],
  );

  // mark unapplied files pending
  if (result.rowCount === 0) {
    return "pending";
  }

  // fail closed on changed history
  if (result.rows[0]?.checksum !== migration.checksum) {
    throw new Error(`migration checksum mismatch: ${migration.name}`);
  }

  return "current";
}
