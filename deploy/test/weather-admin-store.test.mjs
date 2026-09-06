import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_SESSION_TTL_SECONDS,
  WeatherAdminStore,
} from "../scripts/weather-admin-store.mjs";

// create one isolated persistent admin store
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "weather-admin-"));
  t.after(
    // remove isolated test state
    async () => await rm(root, { force: true, recursive: true }),
  );
  const bootstrapTokenPath = join(root, "bootstrap-token");
  await writeFile(bootstrapTokenPath, "test-bootstrap-token-with-32-bytes-minimum\n", {
    mode: 0o600,
  });
  return {
    authPath: join(root, "auth.json"),
    bootstrapTokenPath,
    center: { latitude: 47.95043, longitude: -122.42797 },
    layoutPath: join(root, "layout.json"),
  };
}

// hash the requested password and issue revocable browser sessions
test("admin bootstrap creates one non-reversible credential and bounded sessions", async (t) => {
  const options = await fixture(t);
  let now = Date.parse("2026-09-05T12:00:00.000Z");
  const store = new WeatherAdminStore({ ...options, now: () => now });

  assert.deepEqual(await store.bootstrap("wrong-token-that-is-long-enough-to-test", "P@ssword-test"), {
    status: "unauthorized",
  });
  assert.deepEqual(await store.bootstrap("test-bootstrap-token-with-32-bytes-minimum", "P@ssword-test"), {
    status: "configured",
  });
  const session = await store.startSession("admin", "P@ssword-test");
  assert.equal(await store.startSession("admin", "wrong-password"), null);
  assert.equal(await store.startSession("operator", "P@ssword-test"), null);
  assert.equal(typeof session?.token, "string");
  assert.equal(session?.maximumAgeSeconds, ADMIN_SESSION_TTL_SECONDS);
  assert.equal(store.authenticateSession(session?.token), true);
  assert.equal(store.authenticateSession("not-a-session"), false);
  now += ADMIN_SESSION_TTL_SECONDS * 1_000 + 1;
  assert.equal(store.authenticateSession(session?.token), false);
  const revocable = await store.startSession("admin", "P@ssword-test");
  assert.equal(store.authenticateSession(revocable?.token), true);
  store.revokeSession(revocable?.token);
  assert.equal(store.authenticateSession(revocable?.token), false);
  assert.deepEqual(await store.bootstrap("test-bootstrap-token-with-32-bytes-minimum", "replacement-password"), {
    status: "already_configured",
  });
  assert.doesNotMatch(await readFile(options.authPath, "utf8"), /P@ssword-test/u);
});

// persist bounded names and property positions atomically
test("property layout updates one stable sensor entry", async (t) => {
  const options = await fixture(t);
  const store = new WeatherAdminStore(options);
  const first = await store.upsertSensor("soil-1", {
    displayName: "Orchard soil",
    icon: "temperature",
    latitude: 47.9505,
    longitude: -122.4281,
  });
  await store.upsertSensor("weather-array", {
    displayName: "Barn weather array",
    icon: "wind",
    latitude: 47.9507,
    longitude: -122.4278,
  });

  assert.equal(first.sensorKey, "soil-1");
  assert.equal(first.icon, "temperature");
  assert.deepEqual(
    (await store.readLayout()).map((entry) => entry.sensorKey),
    ["soil-1", "weather-array"],
  );
  await assert.rejects(
    store.upsertSensor("../escape", {
      displayName: "Invalid",
      icon: "temperature",
      latitude: 47.9505,
      longitude: -122.4281,
    }),
    /sensor key/u,
  );
  await assert.rejects(
    store.upsertSensor("soil-2", {
      displayName: "Too far away",
      icon: "temperature",
      latitude: 48.5,
      longitude: -122.4281,
    }),
    /property map bounds/u,
  );
  await assert.rejects(
    store.upsertSensor("soil-2", {
      displayName: "Invalid icon",
      icon: "thermometer",
      latitude: 47.9505,
      longitude: -122.4281,
    }),
    /sensor icon/u,
  );
});

// keep pre-icon layout files readable during the live upgrade
test("property layout defaults legacy sensor icons safely", async (t) => {
  const options = await fixture(t);
  await writeFile(options.layoutPath, JSON.stringify({
    sensors: [{
      displayName: "Legacy soil",
      latitude: 47.9505,
      longitude: -122.4281,
      sensorKey: "soil-1",
      updatedAt: "2026-08-22T04:59:00.000Z",
    }],
    version: 1,
  }));
  const store = new WeatherAdminStore(options);
  assert.equal((await store.readLayout())[0]?.icon, null);
});
