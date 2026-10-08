import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// lock the exact value-free migration and acl surface
test("adjustment maintenance v2 declares only the closed metadata graph", async () => {
  const migration = await readFile(
    resolve(repositoryRoot, "packages/database/migrations/0018_adjustment_maintenance_v2.sql"),
    "utf8",
  );
  const acl = await readFile(
    resolve(repositoryRoot, "deploy/postgres/runtime-acl-v2.sql"),
    "utf8",
  );
  const tableNames = [...migration.matchAll(/^CREATE TABLE ([a-z0-9_]+) \(/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(tableNames, [
    "adjustment_shadow_registrations_v2",
    "adjustment_shadow_predictions_v2",
    "adjustment_confirmation_accesses_v2",
  ]);
  const functionNames = [...migration.matchAll(/^CREATE FUNCTION ([a-z0-9_]+)/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(functionNames, [
    "weather_guard_adjustment_shadow_registration_v2",
    "weather_guard_adjustment_shadow_prediction_v2",
    "weather_guard_adjustment_confirmation_access_v2",
    "weather_reject_adjustment_maintenance_mutation",
    "weather_register_adjustment_shadow_v2",
    "weather_append_adjustment_wind_shadow_v2",
    "weather_append_adjustment_temperature_shadow_v2",
    "weather_append_adjustment_rain_shadow_v2",
    "adjustment_shadow_body_admission_v2",
    "weather_finalize_adjustment_shadow_metadata_v2",
    "weather_record_adjustment_confirmation_access_v2",
    "adjustment_confirmation_availability_v2",
    "adjustment_confirmation_export_v2",
  ]);
  assert.equal((migration.match(/^SECURITY DEFINER$/gmu) ?? []).length, 9);
  assert.equal((migration.match(/^CREATE TRIGGER /gmu) ?? []).length, 9);
  assert.match(migration, /octet_length\(convert_to\(argument::text, 'UTF8'\)\) > 2048/u);
  assert.match(migration, /temperature'[\s\S]+NEW\.row_count > 12 OR NEW\.body_byte_count > 8192/u);
  assert.match(migration, /wind'[\s\S]+NEW\.row_count > 168 OR NEW\.body_byte_count > 65536/u);
  assert.match(migration, /rain'[\s\S]+NEW\.row_count > 23 OR NEW\.body_byte_count > 12288/u);
  assert.match(migration, /due_at > NEW\.issued_at[\s\S]+NEW\.issued_at > due_at \+ interval '12 hours'/u);
  assert.match(migration, /'missingExpectedDueKeys', NULL/u);
  assert.match(migration, /'requires_anchored_cold_reconstruction'/u);
  const predictionTable = migration.slice(
    migration.indexOf("CREATE TABLE adjustment_shadow_predictions_v2"),
    migration.indexOf("CREATE TABLE adjustment_confirmation_accesses_v2"),
  );
  assert.doesNotMatch(predictionTable, /\b(jsonb|numeric|real|double precision)\b/u);
  assert.doesNotMatch(predictionTable, /\b(value|outcome|target|comparator)\b/u);
  assert.match(acl, /present_object_count = 0/u);
  assert.match(acl, /present_object_count <> 16 OR exact_object_count <> 16/u);
  assert.match(acl, /adjustment maintenance v2 schema is incomplete/u);
  assert.match(acl, /weather_append_adjustment_rain_shadow_v2\(jsonb\)[\s\S]+TO weather_ingest/u);
  assert.match(acl, /adjustment_confirmation_availability_v2\(text\)[\s\S]+TO weather_training_export/u);
});
