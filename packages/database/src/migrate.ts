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

export interface MigrationReadiness {
  readonly version: string;
}

export interface MigrationReadinessAuthorization {
  readonly historySha256: string;
  readonly release: string;
}

export interface MigrationReadinessOptions {
  readonly authorization?: MigrationReadinessAuthorization | null;
  readonly release?: string;
}

interface MigrationFile {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
}

interface AppliedMigration {
  readonly checksum: string;
  readonly name: string;
}

const MIGRATION_AUTHORIZATION_RELEASE =
  "WEATHER_MIGRATION_AUTHORIZATION_RELEASE";
const MIGRATION_AUTHORIZATION_HISTORY_SHA256 =
  "WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256";
const RELEASE_PATTERN = /^\d{4}\.\d{2}\.\d{2}-[1-9]\d?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
    const appliedCount = (
      await validateMigrationHistory(client, migrations)
    ).length;
    const applied: string[] = [];
    const current: string[] = [];

    // apply files in lexical order
    for (const [index, migration] of migrations.entries()) {
      // retain the verified prefix
      if (index < appliedCount) {
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

// verify the complete ledger without mutation
export async function verifyMigrationReadiness(
  pool: Pool,
  migrationDirectory: string,
  options: MigrationReadinessOptions = {},
): Promise<MigrationReadiness> {
  const migrations = await loadMigrationFiles(migrationDirectory);
  const authorization = options.authorization ?? null;
  const applied = await validateMigrationHistory(
    pool,
    migrations,
    authorization !== null,
  );
  const appliedCount = Math.min(applied.length, migrations.length);

  // bind compatibility to one running release
  if (
    authorization !== null &&
    (options.release === undefined || authorization.release !== options.release)
  ) {
    throw new Error("migration authorization release mismatch");
  }

  // authorize only the exact complete ledger
  if (
    applied.length > migrations.length &&
    (authorization === null ||
      authorization.historySha256 !== migrationHistorySha256(applied))
  ) {
    throw new Error(
      authorization === null
        ? "migration history diverges from ordered artifacts"
        : "migration authorization history mismatch",
    );
  }

  // require every shipped artifact
  if (appliedCount !== migrations.length) {
    throw new Error("database has pending migration artifacts");
  }

  const version = migrations.at(-1)?.name;

  // preserve the non-empty artifact invariant
  if (version === undefined) {
    throw new Error("migration directory contains no ordered SQL files");
  }

  return { version };
}

// parse bounded immutable runtime authorization
export function readMigrationReadinessAuthorization(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MigrationReadinessAuthorization | null {
  const release = environment[MIGRATION_AUTHORIZATION_RELEASE];
  const historySha256 = environment[MIGRATION_AUTHORIZATION_HISTORY_SHA256];

  // treat an explicitly empty compose contract as absent
  if (
    (release === undefined || release.length === 0) &&
    (historySha256 === undefined || historySha256.length === 0)
  ) {
    return null;
  }

  // reject partial authorization material
  if (
    release === undefined ||
    release.length === 0 ||
    historySha256 === undefined ||
    historySha256.length === 0
  ) {
    throw new Error("migration authorization must be complete");
  }

  // restrict authorization to immutable deployment releases
  if (!RELEASE_PATTERN.test(release)) {
    throw new Error("migration authorization release is invalid");
  }

  // require one canonical ledger digest
  if (!SHA256_PATTERN.test(historySha256)) {
    throw new Error("migration authorization history SHA-256 is invalid");
  }

  return { historySha256, release };
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

// validate the complete applied prefix
async function validateMigrationHistory(
  client: Pick<Pool | PoolClient, "query">,
  migrations: readonly MigrationFile[],
  allowTrailingApplied = false,
): Promise<readonly AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  );

  // require applied history to remain an exact prefix
  for (const [index, applied] of result.rows.entries()) {
    const artifact = migrations[index];

    // allow only authorized compatibility history
    if (artifact === undefined && allowTrailingApplied) {
      continue;
    }

    // reject deleted or retroactively inserted files
    if (artifact === undefined || artifact.name !== applied.name) {
      throw new Error("migration history diverges from ordered artifacts");
    }

    // fail closed on changed history
    if (applied.checksum !== artifact.checksum) {
      throw new Error(`migration checksum mismatch: ${artifact.name}`);
    }
  }

  return result.rows;
}

// hash one canonical ordered applied ledger
function migrationHistorySha256(
  migrations: readonly AppliedMigration[],
): string {
  const hash = createHash("sha256");

  // retain exact row boundaries
  for (const migration of migrations) {
    hash.update(`${migration.name}:${migration.checksum}\n`);
  }

  return hash.digest("hex");
}
