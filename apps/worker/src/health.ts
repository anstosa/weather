import { pathToFileURL } from "node:url";

import {
  assertSupportedPostgres,
  createDatabasePool,
  verifyMigrationReadiness,
} from "@weather/database";

import { loadWorkerConfiguration } from "./config.js";
import { boundedWorkerError } from "./errors.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface WorkerHealth {
  readonly lastLoopAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly live: boolean;
  readonly ready: boolean;
  readonly stale: boolean;
}

// verify the worker database contract
export async function assertWorkerDatabaseReadiness(
  pool: DatabasePool,
  migrationDirectory: string,
): Promise<void> {
  await assertSupportedPostgres(pool);
  await verifyMigrationReadiness(pool, migrationDirectory);
}

// derive allowlisted worker health
export function workerHealth(
  now: Date,
  state: Readonly<{
    lastLoopAt: string | null;
    lastSuccessAt: string | null;
    ready: boolean;
  }>,
  staleAfterMs = 30 * 60 * 1_000,
): WorkerHealth {
  const lastLoop = state.lastLoopAt === null ? null : Date.parse(state.lastLoopAt);
  const heartbeatAge = lastLoop === null ? Number.NaN : now.getTime() - lastLoop;
  const stale =
    !Number.isFinite(heartbeatAge) ||
    heartbeatAge < 0 ||
    heartbeatAge > staleAfterMs;

  return {
    lastLoopAt: state.lastLoopAt,
    lastSuccessAt: state.lastSuccessAt,
    live: true,
    ready: state.ready && !stale,
    stale,
  };
}

// read durable heartbeat health
export async function readWorkerHealth(
  pool: DatabasePool,
  instance: string,
  now = new Date(),
): Promise<WorkerHealth> {
  const result = await pool.query<{
    last_loop_at: Date;
    last_success_at: Date | null;
  }>(
    `
      SELECT last_loop_at, last_success_at
      FROM worker_heartbeats
      WHERE worker_instance = $1
    `,
    [instance],
  );
  const row = result.rows[0];

  return workerHealth(now, {
    lastLoopAt: row?.last_loop_at.toISOString() ?? null,
    lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
    ready: row !== undefined,
  });
}

// run the one-shot container health command
export async function runWorkerHealthCheck(): Promise<0 | 1> {
  const configuration = await loadWorkerConfiguration();
  const pool = createDatabasePool(configuration.database);

  try {
    await assertWorkerDatabaseReadiness(
      pool,
      configuration.migrationDirectory,
    );
    const health = await readWorkerHealth(pool, configuration.instance);
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return health.ready ? 0 : 1;
  } finally {
    await pool.end();
  }
}

// run only from the built health entrypoint
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runWorkerHealthCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${boundedWorkerError(error)}\n`);
      process.exitCode = 1;
    });
}
