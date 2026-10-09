import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { runMigrations } from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";
import {
  ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
  adjustmentRollingLocalDateAt,
  buildAdjustmentRollingScheduleBootstrap,
  buildAdjustmentRollingWindow,
} from "../../../scripts/research/adjustment_rolling_schedule.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = resolve(repositoryRoot, "packages/database/migrations");

// hash one exact public registration identity preimage
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// build one exact public v3 registration from the shared schedule plan
function registrationV3(plan, family = "temperature", overrides = {}) {
  const value = {
    artifactSha256: "a".repeat(64),
    candidateSha256: "b".repeat(64),
    cohortSha256: "c".repeat(64),
    epochWitnessSha256: plan.epochWitnessSha256,
    family,
    intervalEndAt: plan.intervalEndAt,
    intervalStartAt: plan.intervalStartAt,
    policySha256: "d".repeat(64),
    predecessorRegistrationSha256: null,
    registrationSha256: "",
    reservedKeySha256: "e".repeat(64),
    scheduleContractSha256: plan.scheduleContractSha256,
    siteKey: "ballydidean",
    sourceSha256: "f".repeat(64),
    targetCutoffAt: plan.targetCutoffAt,
    terminalAt: plan.terminalAt,
    ...overrides,
  };
  value.registrationSha256 = sha256(`${[
    "adjustment-shadow-registration/v3",
    value.siteKey,
    value.family,
    value.candidateSha256,
    value.artifactSha256,
    value.policySha256,
    value.cohortSha256,
    value.reservedKeySha256,
    value.sourceSha256,
    value.epochWitnessSha256,
    value.scheduleContractSha256,
    value.predecessorRegistrationSha256 ?? "none",
    value.intervalStartAt,
    value.intervalEndAt,
    value.targetCutoffAt,
    value.terminalAt,
  ].join("\n")}\n`);
  return value;
}

// prove rolling registration is server-clocked, finite, append-only and slot-bound
test("rolling adjustment registration preserves future-only recurring windows", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-rolling-registration");
  const admin = createTestPool(server);
  let owner;
  let api;
  try {
    await createRuntimeRoles(admin);
    await admin.query(`
      ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
      ALTER DATABASE weather_test OWNER TO weather_owner;
      ALTER SCHEMA public OWNER TO weather_owner;
      ALTER ROLE weather_api IN DATABASE weather_test
        SET weather.adjustment_maintenance_v2_enabled = 'on';
    `);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, migrationDirectory);
    await owner.query(`
      GRANT EXECUTE ON FUNCTION weather_register_adjustment_shadow_v2(jsonb)
        TO weather_api;
      GRANT EXECUTE ON FUNCTION weather_register_adjustment_shadow_v3(jsonb)
        TO weather_api;
      GRANT EXECUTE ON FUNCTION adjustment_shadow_registration_slot_v3(text)
        TO weather_api;
    `);
    api = createTestPool(server, "weather_test", "weather_api", "api-test");

    const epochAt = "2024-01-01T08:00:00.000Z";
    const epochWitnessSha256 = "1".repeat(64);
    const bootstrap = buildAdjustmentRollingScheduleBootstrap({
      epochAt,
      epochWitnessSha256,
    });
    assert.equal(bootstrap.scheduleContractSha256, ADJUSTMENT_ROLLING_SCHEDULE_SHA256);
    const initialized = await owner.query(
      "SELECT weather_initialize_adjustment_registration_schedule_v3($1) AS receipt",
      [bootstrap],
    );
    assert.equal(initialized.rows[0].receipt.initialized, true);
    assert.equal((await owner.query(
      "SELECT weather_initialize_adjustment_registration_schedule_v3($1) AS receipt",
      [bootstrap],
    )).rows[0].receipt.initialized, false);

    const clock = (await owner.query(`SELECT to_char(
      date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value`)).rows[0].value;
    const fitMonth = adjustmentRollingLocalDateAt(clock).slice(0, 7);
    const plan = buildAdjustmentRollingWindow({
      epochAt,
      epochWitnessSha256,
      family: "temperature",
      fitMonth,
      predecessorTerminalAt: null,
      requestedAt: clock,
    });
    const registration = registrationV3(plan);
    const created = await api.query(
      "SELECT weather_register_adjustment_shadow_v3($1) AS receipt",
      [registration],
    );
    assert.deepEqual(created.rows[0].receipt, {
      inserted: true,
      registrationSha256: registration.registrationSha256,
    });
    assert.deepEqual((await api.query(
      "SELECT weather_register_adjustment_shadow_v3($1) AS receipt",
      [registration],
    )).rows[0].receipt, {
      inserted: false,
      registrationSha256: registration.registrationSha256,
    });

    const slot = (await api.query(
      "SELECT adjustment_shadow_registration_slot_v3('temperature') AS value",
    )).rows[0].value;
    assert.equal(slot.contractVersion, "adjustment-shadow-registration-slot/v3");
    assert.equal(slot.state, "busy_v3");
    assert.equal(slot.registrationSha256, registration.registrationSha256);
    assert.equal(slot.scheduleContractSha256, ADJUSTMENT_ROLLING_SCHEDULE_SHA256);
    assert.equal((await owner.query(
      "SELECT count(*)::integer AS count FROM adjustment_registration_horizons_v3",
    )).rows[0].count, 2);
    assert.equal((await owner.query(`SELECT horizon_end_at = greatest(
      (SELECT bootstrap_horizon_end_at FROM adjustment_registration_schedule_v3),
      $1::timestamptz
    ) AS exact FROM adjustment_registration_horizons_v3
      WHERE registration_sha256 = $2`, [
      registration.terminalAt,
      registration.registrationSha256,
    ])).rows[0].exact, true);

    await assert.rejects(
      // retain the active family slot until terminal reconciliation and retirement
      api.query("SELECT weather_register_adjustment_shadow_v3($1)", [{
        ...registrationV3(plan, "temperature", {
          artifactSha256: "2".repeat(64),
          candidateSha256: "3".repeat(64),
        }),
      }]),
      /family is busy/u,
    );
    await assert.rejects(
      // prohibit future-only callers from creating new unbound v2 registrations
      api.query("SELECT weather_register_adjustment_shadow_v2($1)", [{
        artifactSha256: "a".repeat(64),
        candidateSha256: "b".repeat(64),
        cohortSha256: "c".repeat(64),
        family: "wind",
        intervalEndAt: "2028-01-02T08:00:00.000Z",
        intervalStartAt: "2027-01-01T08:00:00.000Z",
        policySha256: "d".repeat(64),
        registrationSha256: "e".repeat(64),
        reservedKeySha256: "f".repeat(64),
        siteKey: "ballydidean",
        sourceSha256: "1".repeat(64),
        targetCutoffAt: "2028-01-09T08:00:00.000Z",
        terminalAt: "2028-01-09T08:00:00.000Z",
      }]),
      /new adjustment v2 registration is disabled/u,
    );
    await assert.rejects(
      // retain schedule and member history as append-only authority
      owner.query("UPDATE adjustment_registration_schedule_v3 SET singleton = singleton"),
      /immutable/u,
    );
    await assert.rejects(
      // keep raw table history unavailable to application roles
      api.query("SELECT * FROM adjustment_shadow_registration_windows_v3"),
      /permission denied/u,
    );
  } finally {
    await Promise.all([api?.end(), owner?.end(), admin.end()]);
    await stopPostgres(server);
  }
});
