import {
  createDatabasePool,
  loadDatabaseConfiguration,
} from "@weather/database";

const configuration = await loadDatabaseConfiguration();
const pool = createDatabasePool(configuration);
const maximumAgeSeconds = Number.parseInt(
  process.env.WEATHER_WORKER_HEARTBEAT_MAX_AGE_SECONDS ?? "1900",
  10,
);

try {
  // require one recent worker heartbeat
  const result = await pool.query(
    `SELECT EXTRACT(EPOCH FROM clock_timestamp() - MAX(last_loop_at)) AS age_seconds
     FROM worker_heartbeats`,
  );
  const ageSeconds = Number(result.rows[0]?.age_seconds);

  // reject missing or stale progress
  if (!Number.isFinite(ageSeconds) || ageSeconds > maximumAgeSeconds) {
    process.exitCode = 1;
  }
} finally {
  // close pooled sessions
  await pool.end();
}
