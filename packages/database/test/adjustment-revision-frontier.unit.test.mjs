import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// lock the bounded server-assigned revision frontier contract
test("adjustment revision frontier assigns immutable staged ordinals", async () => {
  const migration = await readFile(resolve(
    repositoryRoot,
    "packages/database/migrations/0020_adjustment_revision_frontier.sql",
  ), "utf8");
  assert.doesNotMatch(migration, /requires an empty hot prediction table/u);
  assert.match(migration, /revision_contract_epoch smallint/u);
  assert.match(migration, /revision_contract_epoch IS DISTINCT FROM 1/u);
  assert.match(migration, /CREATE SEQUENCE adjustment_revision_ordinal_v1/u);
  assert.match(migration, /CREATE TABLE adjustment_revision_frontier_v1/u);
  assert.match(migration, /nextval\('adjustment_revision_ordinal_v1'\)/u);
  assert.match(migration, /adjustment-revision-commit-receipt\/v1/u);
  assert.match(migration, /adjustment-revision-frontier\/v1/u);
  assert.match(migration, /projectionKind', 'shadow_prediction'/u);
  assert.match(migration, /prediction\.source_receipt_sha256/u);
  assert.match(migration, /prediction\.input_sha256/u);
  assert.match(migration, /stageReceiptSha256/u);
  assert.match(migration, /predecessor_frontier_sha256/u);
  assert.match(migration, /weather_append_adjustment_shadow_v4/u);
  assert.match(migration, /adjustment_revision_frontier_v1\(\)/u);
  assert.match(migration, /archiveCommittedAt/u);
  assert.match(migration, /weather_bind_weather_record_revisions_v1/u);
  assert.match(migration, /weather_bind_forecast_anchor_revisions_v1/u);
  assert.match(migration, /weather_bind_rain_gate_revision_v1/u);
  assert.match(migration, /weather_bind_ecmwf_temperature_revision_v1/u);
  assert.match(migration, /adjustment_revision_serving_snapshot_v1/u);
  assert.doesNotMatch(migration, /CREATE TABLE adjustment_revision_commits/u);
  assert.match(migration, /legacy rows as permanently unqualified/u);
  assert.doesNotMatch(migration, /TRUNCATE adjustment|DROP TABLE/u);
});
