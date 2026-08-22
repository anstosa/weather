import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import {
  toPoolConfiguration,
  type DatabaseConfiguration,
} from "./config.js";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

// create the bounded application pool
export function createDatabasePool(configuration: DatabaseConfiguration): Pool {
  return new Pool(toPoolConfiguration(configuration));
}

// reject unsupported PostgreSQL servers
export async function assertSupportedPostgres(
  queryable: Queryable,
): Promise<number> {
  const result = await queryable.query<{ server_version_num: string }>(
    "SELECT current_setting('server_version_num') AS server_version_num",
  );
  const version = Number(result.rows[0]?.server_version_num);

  // enforce the NULLS NOT DISTINCT floor
  if (!Number.isSafeInteger(version) || version < 150_000) {
    throw new Error(
      `PostgreSQL 15 or newer is required; server_version_num=${String(version)}`,
    );
  }

  return version;
}

// execute an atomic operation
export async function withTransaction<T>(
  client: PoolClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");

  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
