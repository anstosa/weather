import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { MAINTENANCE_SHADOW_SCHEMA_SHA256 } from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

// bind database admission to the built public wire schemas
test("migration 0019 admits only the built maintenance shadow schemas", async () => {
  const migration = await readFile(
    resolve(repositoryRoot, "packages/database/migrations/0019_adjustment_maintenance_recurring.sql"),
    "utf8",
  );
  const repository = await readFile(
    resolve(repositoryRoot, "packages/database/src/adjustment-maintenance.ts"),
    "utf8",
  );
  // require every public family hash in the closed database case
  for (const family of ["temperature", "wind", "rain"]) {
    assert.match(
      migration,
      new RegExp(`WHEN '${family}' THEN '${MAINTENANCE_SHADOW_SCHEMA_SHA256[family]}'`, "u"),
    );
    assert.match(repository, new RegExp(MAINTENANCE_SHADOW_SCHEMA_SHA256[family], "u"));
  }
  assert.doesNotMatch(
    migration,
    /2577ce921eab3018311b17dd8f14b26927d30c92e605d7fa42fef22c0b5f6342/u,
  );
});
