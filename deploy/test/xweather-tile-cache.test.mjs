import assert from "node:assert/strict";
import test from "node:test";

import { XweatherTileMemoryCache } from "../scripts/xweather-tile-cache.mjs";

const historyTile = {
  column: 164,
  layer: "radar",
  phase: "history",
  row: 357,
  validTime: "20260827120000",
  zoom: 10,
};
const forecastTile = { ...historyTile, phase: "forecast" };
const historyFrame = {
  height: 420,
  kind: "frame",
  latitude: 47.95043,
  layer: "radar",
  longitude: -122.42797,
  phase: "history",
  validTime: "20260827120000",
  width: 640,
  zoom: 10,
};

// create one observable provider-backed cache
function createCache(maximumBytes = 1024) {
  let loads = 0;
  let now = 0;
  const cache = new XweatherTileMemoryCache({
    forecastFreshnessMs: 60 * 60 * 1_000,
    loadTile: async (tile) => {
      loads += 1;
      return { body: Buffer.from(`${tile.phase}-${tile.layer}-${String(loads)}`) };
    },
    maximumBytes,
    now: () => now,
  });
  return {
    cache,
    loadCount: () => loads,
    setNow: (value) => {
      now = value;
    },
  };
}

test("historical Xweather tiles remain immutable in memory", async () => {
  const fixture = createCache();
  const first = await fixture.cache.get(historyTile);
  fixture.setNow(365 * 24 * 60 * 60 * 1_000);
  const second = await fixture.cache.get(historyTile);

  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "hit");
  assert.equal(fixture.loadCount(), 1);
  assert.deepEqual(second.body, first.body);
});

test("static Xweather frames use their complete viewport identity", async () => {
  const fixture = createCache();
  await fixture.cache.get(historyFrame);
  await fixture.cache.get({ ...historyFrame, width: 641 });
  await fixture.cache.get(historyFrame);

  assert.equal(fixture.loadCount(), 2);
});

test("forecast Xweather tiles refresh only after one hour", async () => {
  const fixture = createCache();
  const first = await fixture.cache.get(forecastTile);
  fixture.setNow(60 * 60 * 1_000 - 1);
  const fresh = await fixture.cache.get(forecastTile);
  fixture.setNow(60 * 60 * 1_000);
  const refreshed = await fixture.cache.get(forecastTile);

  assert.equal(first.cacheStatus, "miss");
  assert.equal(fresh.cacheStatus, "hit");
  assert.equal(refreshed.cacheStatus, "miss");
  assert.equal(fixture.loadCount(), 2);
  assert.notDeepEqual(refreshed.body, first.body);
});

test("concurrent Xweather misses share one provider request", async () => {
  let releaseLoad;
  let loads = 0;
  const loadGate = new Promise(
    // expose one provider request gate
    (resolve) => {
      releaseLoad = resolve;
    },
  );
  const cache = new XweatherTileMemoryCache({
    forecastFreshnessMs: 60 * 60 * 1_000,
    loadTile: async () => {
      loads += 1;
      await loadGate;
      return { body: Buffer.from("shared") };
    },
    maximumBytes: 1024,
  });
  const first = cache.get(forecastTile);
  const second = cache.get(forecastTile);
  releaseLoad();
  await Promise.all([first, second]);

  assert.equal(loads, 1);
});

test("Xweather memory cache evicts least-recently-used bodies", async () => {
  const fixture = createCache(30);
  await fixture.cache.get(historyTile);
  await fixture.cache.get({ ...historyTile, column: 165 });
  await fixture.cache.get(historyTile);
  await fixture.cache.get({ ...historyTile, column: 166 });
  const beforeReload = fixture.loadCount();
  await fixture.cache.get({ ...historyTile, column: 165 });

  assert.equal(fixture.loadCount(), beforeReload + 1);
  assert.ok(fixture.cache.stats().storedBytes <= 30);
});

test("Xweather memory cache evicts forecast tiles before historical tiles", async () => {
  const fixture = createCache(30);
  await fixture.cache.get(historyTile);
  await fixture.cache.get(forecastTile);
  await fixture.cache.get({ ...forecastTile, column: 165 });
  const beforeHistoryHit = fixture.loadCount();
  await fixture.cache.get(historyTile);
  await fixture.cache.get(forecastTile);

  assert.equal(fixture.loadCount(), beforeHistoryHit + 1);
});
