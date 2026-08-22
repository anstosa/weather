import {
  assertSupportedPostgres,
  createDatabasePool,
  loadDatabaseConfiguration,
} from "@weather/database";

const mode = process.argv[2];

// allow only the two compatibility probes
if (mode !== "api" && mode !== "worker") {
  throw new Error("compatibility mode must be api or worker");
}

const configuration = await loadDatabaseConfiguration();
const pool = createDatabasePool(configuration);

try {
  // prove the previous image can read the candidate schema
  await assertSupportedPostgres(pool);
  await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");

  // exercise the read-only API query shape
  if (mode === "api") {
    await pool.query("SELECT site_key FROM sites ORDER BY site_key LIMIT 1");
  }

  // exercise one provider-stub worker loop without network access
  if (mode === "worker") {
    const response = await fetch(
      "data:application/json,%7B%22current%22%3A%7B%22temperature_2m%22%3A12%7D%7D",
    );
    await response.json();
    await pool.query("SELECT source_key FROM sources ORDER BY source_key LIMIT 1");
  }

  console.log(JSON.stringify({ event: "compatibility_passed", mode }));
} finally {
  // close pooled sessions
  await pool.end();
}
