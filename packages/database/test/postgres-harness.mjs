import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { Pool } from "pg";

const executeFile = promisify(execFile);

// start a disposable PostgreSQL container
export async function startPostgres(major, label) {
  const name = `weather-${label}-${process.pid}-${randomBytes(4).toString("hex")}`;
  await executeFile(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--env",
      "POSTGRES_PASSWORD=postgres-test",
      "--env",
      "POSTGRES_DB=weather_test",
      "--publish",
      "127.0.0.1::5432",
      `postgres:${major}-bookworm`,
    ],
    { timeout: 180_000 },
  );

  try {
    const { stdout } = await executeFile(
      "docker",
      [
        "inspect",
        "--format",
        '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
        name,
      ],
      { timeout: 10_000 },
    );
    const server = {
      host: "127.0.0.1",
      name,
      password: "postgres-test",
      port: Number(stdout.trim()),
      user: "postgres",
    };
    await waitForPostgres(server);
    return server;
  } catch (error) {
    await stopPostgres({ name });
    throw error;
  }
}

// stop a disposable container
export async function stopPostgres(server) {
  await executeFile("docker", ["rm", "--force", server.name], {
    timeout: 30_000,
  }).catch(() => undefined);
}

// create a configured pool
export function createTestPool(
  server,
  database = "weather_test",
  user = server.user,
  password = server.password,
) {
  return new Pool({
    application_name: "weather-integration-test",
    database,
    host: server.host,
    max: 8,
    password,
    port: server.port,
    statement_timeout: 30_000,
    user,
  });
}

// create runtime roles before grants execute
export async function createRuntimeRoles(pool) {
  await pool.query(`
    CREATE ROLE weather_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE weather_api
      LOGIN PASSWORD 'api-test'
      NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE weather_ingest
      LOGIN PASSWORD 'ingest-test'
      NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE weather_training_export
      LOGIN PASSWORD 'training-export-test'
      NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ALTER ROLE weather_training_export SET default_transaction_read_only = on;
  `);
}

// wait for server readiness
async function waitForPostgres(server) {
  let lastError;

  // retry bounded startup
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const pool = createTestPool(server);

    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error("PostgreSQL container did not become ready", {
    cause: lastError,
  });
}
