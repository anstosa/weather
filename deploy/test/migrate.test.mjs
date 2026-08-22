import assert from "node:assert/strict";
import test from "node:test";

import { migrateAndBootstrap } from "../scripts/migrate.mjs";

// create ordered entrypoint doubles
function createDependencies(events, records) {
  return {
    // retain stable bootstrap identities
    async bootstrapSiteConfiguration(pool, configuration) {
      events.push(["bootstrap", pool.name, configuration.site.key]);
      const existing = records.get(configuration.site.key);

      // reuse the configured site identity
      if (existing !== undefined) {
        return existing;
      }

      const created = {
        providerId: "provider-id",
        siteId: "site-id",
        sourceIds: ["current-source-id", "archive-source-id"],
        stationId: "station-id",
      };
      records.set(configuration.site.key, created);
      return created;
    },
    // load the requested configuration
    async loadSiteConfiguration(path) {
      events.push(["load-site", path]);
      return { site: { key: "ballydidean" } };
    },
    // apply migrations before configuration loading
    async runMigrations(pool, directory) {
      events.push(["migrate", pool.name, directory]);
      return { applied: ["0001_initial_weather.sql"], current: [], serverVersionNum: 170_010 };
    },
  };
}

// create one disposable pool double
function createPool(name, events) {
  return {
    name,
    // record pool cleanup
    async end() {
      events.push(["end", name]);
    },
  };
}

// verify migration-first bootstrap ordering
test("migration entrypoint bootstraps the configured site after migrations", async () => {
  const events = [];
  const dependencies = createDependencies(events, new Map());
  const result = await migrateAndBootstrap(
    createPool("owner", events),
    "/migrations",
    "/config/ballydidean.json",
    dependencies,
  );

  assert.deepEqual(events, [
    ["migrate", "owner", "/migrations"],
    ["load-site", "/config/ballydidean.json"],
    ["bootstrap", "owner", "ballydidean"],
    ["end", "owner"],
  ]);
  assert.equal(result.bootstrap.siteId, "site-id");
  assert.deepEqual(result.migrations.applied, ["0001_initial_weather.sql"]);
});

// verify the composed entrypoint can be rerun
test("migration entrypoint preserves bootstrap identities across reruns", async () => {
  const events = [];
  const records = new Map();
  const dependencies = createDependencies(events, records);
  const first = await migrateAndBootstrap(
    createPool("first-owner", events),
    "/migrations",
    "/config/ballydidean.json",
    dependencies,
  );
  const second = await migrateAndBootstrap(
    createPool("second-owner", events),
    "/migrations",
    "/config/ballydidean.json",
    dependencies,
  );

  assert.deepEqual(second.bootstrap, first.bootstrap);
  assert.equal(records.size, 1);
  assert.equal(events.filter(([event]) => event === "bootstrap").length, 2);
});

// verify failures still close the owner pool
test("migration entrypoint does not bootstrap after a migration failure", async () => {
  const events = [];
  const pool = createPool("owner", events);
  const dependencies = {
    // reject unexpected bootstrap calls
    async bootstrapSiteConfiguration() {
      assert.fail("bootstrap must not run");
    },
    // reject unexpected configuration loads
    async loadSiteConfiguration() {
      assert.fail("site configuration must not load");
    },
    // fail the migration step
    async runMigrations() {
      events.push(["migrate", "owner", "/migrations"]);
      throw new Error("migration failed");
    },
  };

  await assert.rejects(
    () => migrateAndBootstrap(pool, "/migrations", "/config/ballydidean.json", dependencies),
    /migration failed/u,
  );
  assert.deepEqual(events, [
    ["migrate", "owner", "/migrations"],
    ["end", "owner"],
  ]);
});
