import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { XweatherUsageBudget } from "../scripts/xweather-usage-budget.mjs";

// create one isolated persistent budget
async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "weather-xweather-budget-"));
  const path = join(directory, "usage.json");
  let now = Date.parse("2026-08-28T12:00:00Z");
  const create = () => new XweatherUsageBudget({
    dailyLimit: options.dailyLimit ?? 3,
    monthlyLimit: options.monthlyLimit ?? 5,
    now: () => now,
    path,
  });
  return {
    create,
    path,
    remove: async () => await rm(directory, { force: true, recursive: true }),
    setNow: (value) => {
      now = Date.parse(value);
    },
  };
}

test("Xweather usage survives process recreation", async () => {
  const fixture = await createFixture();

  try {
    fixture.create().reserve(2);
    const recreated = fixture.create();
    assert.deepEqual(recreated.snapshot(), {
      day: "2026-08-28",
      dailyLimit: 3,
      dayUnits: 2,
      month: "2026-08",
      monthlyLimit: 5,
      monthUnits: 2,
    });
    assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
      day: "2026-08-28",
      dayUnits: 2,
      month: "2026-08",
      monthUnits: 2,
    });
  } finally {
    await fixture.remove();
  }
});

test("Xweather usage enforces daily and monthly ceilings", async () => {
  const fixture = await createFixture();

  try {
    const budget = fixture.create();
    budget.reserve(3);
    assert.throws(() => budget.reserve(1), { code: "xweather_budget_exhausted" });
    fixture.setNow("2026-08-29T00:00:00Z");
    budget.reserve(2);
    assert.throws(() => budget.reserve(1), { code: "xweather_budget_exhausted" });
  } finally {
    await fixture.remove();
  }
});

test("Xweather usage resets both ceilings in a new month", async () => {
  const fixture = await createFixture();

  try {
    const budget = fixture.create();
    budget.reserve(3);
    fixture.setNow("2026-09-01T00:00:00Z");
    budget.reserve(1);
    assert.equal(budget.snapshot().dayUnits, 1);
    assert.equal(budget.snapshot().monthUnits, 1);
  } finally {
    await fixture.remove();
  }
});
