import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// lock the immutable recurring-registration and lead-halo migration surface
test("adjustment maintenance recurring migration binds raw source and terminal retirement", async () => {
  const migration = await readFile(resolve(
    repositoryRoot,
    "packages/database/migrations/0019_adjustment_maintenance_recurring.sql",
  ), "utf8");
  assert.match(migration, /requires an empty hot prediction table/u);
  assert.match(migration, /candidate_sha256 char\(64\) NOT NULL/u);
  assert.match(migration, /source_sha256 char\(64\) NOT NULL/u);
  assert.match(migration, /max_valid_at - min_valid_at = \(row_count - 1\) \* interval '1 hour'/u);
  assert.match(migration, /NEW\.max_valid_at < registration\.interval_start_at/u);
  assert.match(migration, /NEW\.min_valid_at >= registration\.interval_end_at/u);
  assert.match(migration, /adjustment-shadow-source-receipt\/v1/u);
  assert.match(migration, /adjustment-shadow-prediction\/v3/u);
  assert.match(migration, /CREATE TABLE adjustment_shadow_terminal_results_v2/u);
  assert.match(migration, /family text NOT NULL UNIQUE/u);
  assert.match(migration, /terminal_member_sha256/u);
  assert.match(migration, /weather\.adjustment_terminal_member_root_sha256/u);
  assert.match(migration, /registration\.reserved_key_sha256/u);
  assert.match(migration, /access\.access_sha256/u);
  assert.match(migration, /action_disposition/u);
  assert.match(migration, /promotion_failed_compensated/u);
  assert.match(migration, /operator_off_compensated/u);
  assert.match(migration, /record_terminal_result/u);
  assert.match(migration, /retire_terminal/u);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE adjustment_shadow/u);
  assert.equal((migration.match(/^CREATE TRIGGER adjustment_shadow_terminal_results_v2_/gmu) ?? []).length, 3);
});
