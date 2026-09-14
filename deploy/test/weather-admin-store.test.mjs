import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// persist every independent switch combination without weakening invalid state
test("forecast adjustment switches retain all eight combinations and fail closed on corruption", async (t) => {
  const options = await fixture(t);
  const store = new WeatherAdminStore(options);
  const path = join(dirname(options.layoutPath), "forecast-adjustment-settings.json");

  assert.deepEqual(await store.readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
  assert.deepEqual(await store.bootstrap(
    "test-bootstrap-token-with-32-bytes-minimum", "P@ssword-test",
  ), { status: "configured" });
  assert.deepEqual(await store.readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: true, wind: true, rain: true },
    error: null,
  });

  // exercise every independent three-bit selection
  for (let mask = 0; mask < 8; mask += 1) {
    const settings = {
      version: 1,
      temperature: Boolean(mask & 1),
      wind: Boolean(mask & 2),
      rain: Boolean(mask & 4),
    };
    assert.deepEqual(await store.writeAdjustmentSettings(settings), settings);
    assert.deepEqual((await store.readAdjustmentSettingsStatus()).settings, settings);
    assert.deepEqual((await new WeatherAdminStore(options).readAdjustmentSettingsStatus()).settings, settings);
  }

  await assert.rejects(
    store.writeAdjustmentSettings({ version: 1, temperature: true, wind: false, rain: "false" }),
    /settings are invalid/u,
  );
  await assert.rejects(
    store.writeAdjustmentSettings({ version: 1, temperature: true, wind: false, rain: false, extra: true }),
    /settings are invalid/u,
  );
  await assert.rejects(
    store.writeAdjustmentSettings({ version: 2, temperature: true, wind: false, rain: false }),
    /settings are invalid/u,
  );
  assert.deepEqual((await store.readAdjustmentSettingsStatus()).settings, {
    version: 1,
    temperature: true,
    wind: true,
    rain: true,
  });

  // a lost saved file must not silently reactivate all adjustments
  await unlink(path);
  assert.deepEqual(await store.readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
  assert.deepEqual(await new WeatherAdminStore(options).readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });

  await writeFile(path, "{broken json\n");
  assert.deepEqual(await store.readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
  assert.deepEqual(await store.writeAdjustmentSettings({
    version: 1,
    temperature: true,
    wind: false,
    rain: false,
  }), { version: 1, temperature: true, wind: false, rain: false });
  assert.equal((await store.readAdjustmentSettingsStatus()).error, null);

  // keep damaged marker reads off until an authenticated rewrite repairs it
  await writeFile(`${path}.initialized`, "damaged marker\n");
  assert.deepEqual(await new WeatherAdminStore(options).readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
  const recovered = { version: 1, temperature: false, wind: true, rain: false };
  assert.deepEqual(await store.writeAdjustmentSettings(recovered), recovered);
  assert.deepEqual((await new WeatherAdminStore(options).readAdjustmentSettingsStatus()).settings, recovered);

  // losing the whole web volume cannot become a new enabled first run
  await Promise.all([
    unlink(path),
    unlink(`${path}.initialized`),
    unlink(options.authPath),
  ]);
  assert.deepEqual(await new WeatherAdminStore(options).readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
  assert.deepEqual(await store.readAdjustmentSettingsStatus(), {
    settings: { version: 1, temperature: false, wind: false, rain: false },
    error: "adjustment_settings_unavailable",
  });
});

// prevent a first-read default from overwriting a simultaneous admin choice
test("first-run adjustment initialization preserves a concurrent admin write", async (t) => {
  const options = await fixture(t);
  const store = new WeatherAdminStore(options);
  const chosen = { version: 1, temperature: false, wind: true, rain: false };
  await store.bootstrap("test-bootstrap-token-with-32-bytes-minimum", "P@ssword-test");

  await Promise.all([
    store.readAdjustmentSettingsStatus(),
    store.writeAdjustmentSettings(chosen),
  ]);
  assert.deepEqual((await new WeatherAdminStore(options).readAdjustmentSettingsStatus()).settings, chosen);
});
