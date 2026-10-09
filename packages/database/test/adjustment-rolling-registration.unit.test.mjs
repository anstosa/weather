import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// lock the additive future-only rolling registration surface
test("rolling registration migration retains finite append-only family windows", async () => {
  const migration = await readFile(resolve(
    repositoryRoot,
    "packages/database/migrations/0021_adjustment_rolling_registration.sql",
  ), "utf8");
  assert.match(migration, /CREATE TABLE adjustment_registration_schedule_v3/u);
  assert.match(migration, /CREATE TABLE adjustment_registration_horizons_v3/u);
  assert.match(migration, /CREATE TABLE adjustment_shadow_registration_windows_v3/u);
  assert.match(migration, /weather_initialize_adjustment_registration_schedule_v3/u);
  assert.match(migration, /weather_register_adjustment_shadow_v3/u);
  assert.match(migration, /adjustment_shadow_registration_slot_v3/u);
  assert.match(migration, /expected_first_date \+ 1053/u);
  assert.match(migration, /end_local_date - start_local_date <> 366/u);
  assert.match(migration, /end_local_date - start_local_date <> 334/u);
  assert.match(migration, /NEW\.interval_end_at \+ interval '7 days'/u);
  assert.match(migration, /predecessor_registration_sha256 char\(64\) UNIQUE/u);
  assert.match(migration, /adjustment_shadow_terminal_results_v2 terminal/u);
  assert.match(migration, /adjustment rolling registration family is busy/u);
  assert.match(migration, /new adjustment v2 registration is disabled/u);
  assert.match(migration, /greatest\(current_horizon\.horizon_end_at, inserted\.terminal_at\)/u);
  assert.match(migration, /adjustment-shadow-registration\/v3/u);
  assert.match(migration, /to_char\(NEW\.terminal_at[\s\S]+\|\| E'\\n'/u);
  assert.equal((migration.match(/^CREATE TRIGGER adjustment_(?:registration|shadow_registration)/gmu)
    ?? []).length, 9);
  assert.doesNotMatch(migration, /ALTER TABLE adjustment_shadow_registrations_v2/u);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE adjustment_/u);
});
