import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  bootstrapSiteConfiguration,
  parseSiteConfiguration,
  runMigrations,
} from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const siteConfigurationPath = join(repositoryRoot, "config/sites/ballydidean.json");

// prove location drift rejects atomically
test(
  "source location drift rejects without partially updating the site",
  { timeout: 300_000 },
  async () => {
    const server = await startPostgres(17, "config-material");
    const pool = createTestPool(server);

    try {
      await createRuntimeRoles(pool);
      await runMigrations(pool, migrationDirectory);
      const raw = JSON.parse(await readFile(siteConfigurationPath, "utf8"));
      const baseline = parseSiteConfiguration(raw);
      await bootstrapSiteConfiguration(pool, baseline);
      const expected = await materialSnapshot(pool);
      const changes = [
        { latitude: raw.site.latitude + 0.01 },
        { longitude: raw.site.longitude - 0.01 },
        { timezone: "UTC" },
      ];

      // reject each location component independently
      for (const change of changes) {
        const changed = parseSiteConfiguration({
          ...raw,
          site: { ...raw.site, ...change },
        });
        await assert.rejects(
          () => bootstrapSiteConfiguration(pool, changed),
          /changed material configuration/u,
        );
        assert.deepEqual(await materialSnapshot(pool), expected);
      }
    } finally {
      await pool.end();
      await stopPostgres(server);
    }
  },
);

// snapshot location and source identity
async function materialSnapshot(pool) {
  const site = await pool.query(
    "SELECT latitude::text, longitude::text, timezone FROM sites WHERE slug = 'ballydidean'",
  );
  const sources = await pool.query(
    "SELECT source_key, source_config_fingerprint FROM sources ORDER BY source_key",
  );

  return { site: site.rows, sources: sources.rows };
}
