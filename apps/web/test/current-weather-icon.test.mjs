import assert from "node:assert/strict";
import test from "node:test";

import {
  currentWeatherIcon,
  eveningSunTimes,
  NOW_ICON_STORAGE_KEY,
  renderWeatherDashboard,
  WeatherDashboardController,
} from "../dist/index.js";

const site = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  timezone: "America/Los_Angeles",
};
const daytime = new Date("2026-09-23T20:00:00Z");
const nighttime = new Date("2026-09-24T06:00:00Z");

// isolate the existing current metric and source-priority contract
function reading(cloudCoverPercent, precipitationRateMmPerHour = 0, windSpeedMps = 0) {
  return {
    freshness: { status: "fresh" },
    metrics: { cloudCoverPercent, precipitationRateMmPerHour, windSpeedMps },
    provenance: { providerKey: "open-meteo", sourceKind: "model_current" },
  };
}

// retain the approved day, night, rain and wind mapping at exact boundaries
test("current weather icons share the widget condition thresholds", () => {
  const cases = [
    [24.99, 0, daytime, "01-sunny", "02-sunny-wind", "Sunny"],
    [25, 0, daytime, "03-partly-cloudy", "04-partly-cloudy-wind", "Partly cloudy"],
    [74.99, 0, daytime, "03-partly-cloudy", "04-partly-cloudy-wind", "Partly cloudy"],
    [75, 0, daytime, "05-cloudy", "06-cloudy-wind", "Cloudy"],
    [null, 0.01, daytime, "07-light-rain", "08-light-rain-wind", "Light rain"],
    [0, 2.499, daytime, "07-light-rain", "08-light-rain-wind", "Light rain"],
    [0, 2.5, daytime, "09-heavy-rain", "10-heavy-rain-wind", "Heavy rain"],
    [0, 0, nighttime, "13-clear-night", "14-clear-night-wind", "Clear night"],
    [50, 0, nighttime, "15-partly-cloudy-night", "16-partly-cloudy-night-wind", "Partly cloudy night"],
    [100, 0, nighttime, "05-cloudy", "06-cloudy-wind", "Cloudy"],
    [null, 1, nighttime, "07-light-rain", "08-light-rain-wind", "Light rain"],
    [null, 3, nighttime, "09-heavy-rain", "10-heavy-rain-wind", "Heavy rain"],
  ];
  // check both sides of the twenty-mile-per-hour wind boundary
  for (const [cloud, rain, now, calmName, windyName, label] of cases) {
    assert.deepEqual(currentWeatherIcon({ current: [reading(cloud, rain, 8.9407)], selectedSite: site }, now), {
      name: calmName,
      label,
    });
    assert.deepEqual(currentWeatherIcon({ current: [reading(cloud, rain, 8.9408)], selectedSite: site }, now), {
      name: windyName,
      label: `${label}, high wind`,
    });
  }
});

// avoid presenting fair weather while current rain or required model cloud data is missing
test("current weather icons preserve unavailable conditions", () => {
  // retain a placeholder through loading and incomplete source responses
  for (const current of [[], [reading(0, null)], [reading(null)], [reading(null, null)]]) {
    assert.deepEqual(currentWeatherIcon({ current, selectedSite: null }, daytime), {
      name: "12-unavailable",
      label: "Conditions unavailable",
    });
  }
});

// mirror homepage sensor priority without sourcing clouds from a physical sensor
test("current weather icons use local rain and wind with model cloud fallback", () => {
  const model = reading(80, 0, 1);
  const sensor = {
    ...reading(0, 3, 10),
    provenance: { providerKey: "ecowitt-local", sourceKind: "physical_sensor" },
  };
  assert.equal(currentWeatherIcon({ current: [model, sensor], selectedSite: site }, daytime).name, "10-heavy-rain-wind");
  const drySensor = { ...sensor, metrics: { ...sensor.metrics, precipitationRateMmPerHour: 0 } };
  assert.equal(currentWeatherIcon({ current: [model, drySensor], selectedSite: site }, daytime).name, "06-cloudy-wind");
  assert.equal(currentWeatherIcon({ current: [drySensor], selectedSite: site }, daytime).name, "12-unavailable");
  const staleSensor = { ...sensor, freshness: { status: "stale" } };
  assert.equal(currentWeatherIcon({ current: [staleSensor, model], selectedSite: site }, daytime).name, "05-cloudy");
});

// follow farm daylight rather than viewer timezone or stale observation timestamps
test("current weather icons change exactly at sunrise and sunset", () => {
  const state = { current: [reading(0)], selectedSite: site };
  const sun = eveningSunTimes(site, daytime);
  assert.ok(sun.sunrise);
  assert.ok(sun.sunset);
  assert.equal(currentWeatherIcon(state, new Date(sun.sunrise.getTime() - 1)).name, "13-clear-night");
  assert.equal(currentWeatherIcon(state, sun.sunrise).name, "01-sunny");
  assert.equal(currentWeatherIcon(state, new Date(sun.sunset.getTime() - 1)).name, "01-sunny");
  assert.equal(currentWeatherIcon(state, sun.sunset).name, "13-clear-night");
});

// emulate device storage without sharing state between test cases
function iconStorage(value = null) {
  const values = new Map([[NOW_ICON_STORAGE_KEY, value]]);
  return {
    // expose only explicitly persisted keys
    getItem(key) {
      return values.get(key) ?? null;
    },
    // retain exact serialized values for privacy assertions
    setItem(key, stored) {
      values.set(key, stored);
    },
  };
}

// isolate navigation from unrelated page content and record fixture requirements
function nowMarkup(state) {
  return renderWeatherDashboard(state, "settings").match(/<a class="section-nav-home"[\s\S]*?<\/a>/u)?.[0];
}

// distinguish pending conditions from a completed unavailable response
test("cold Now artwork is a skeleton until loading settles", () => {
  const state = new WeatherDashboardController({ storage: null }).state;
  const loading = nowMarkup(state);
  assert.match(loading, /section-nav-weather-skeleton skeleton-line/u);
  assert.match(loading, /role="img" aria-label="Loading current weather" aria-busy="true"/u);
  assert.doesNotMatch(loading, /12-unavailable|<img/u);
  const unavailable = nowMarkup({ ...state, loading: false });
  assert.match(unavailable, /12-unavailable\.svg/u);
  assert.doesNotMatch(unavailable, /skeleton|aria-busy/u);
});

// restore artwork before initialization without fetching weather for local settings
test("recent Now cache survives a new controller and strips unrelated fields", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  const cache = { rain: 0, cloud: 50, windy: true, cachedAt: Date.now() - 1_000 };
  const storage = iconStorage(JSON.stringify({ ...cache, privateSensor: "not-restored", name: "not-an-asset-path" }));
  const controller = new WeatherDashboardController({
    storage,
    view: "settings",
    // fail if restoring artwork widens the local-only route contract
    fetcher: async () => assert.fail("settings must not fetch weather for its icon"),
  });
  assert.deepEqual(controller.state.cachedNowIcon, cache);
  assert.deepEqual(controller.state.current, []);
  assert.match(nowMarkup(controller.state), /04-partly-cloudy-wind\.svg/u);
  assert.doesNotMatch(nowMarkup(controller.state), /skeleton|12-unavailable/u);
  await controller.initialize();
  assert.equal(controller.state.loading, false);
  assert.match(nowMarkup(controller.state), /04-partly-cloudy-wind\.svg/u);
});

// ignore malformed storage rather than presenting invented or indefinitely stale weather
test("Now cache rejects corrupt, expired, future and incomplete entries", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  const valid = { rain: 0, cloud: 20, windy: false, cachedAt: Date.now() };
  const invalid = [
    "not-json", "null", "[]", "1", '"sunny"', "{}",
    JSON.stringify({ ...valid, cachedAt: Date.now() - 30 * 60_000 }),
    JSON.stringify({ ...valid, cachedAt: Date.now() + 1 }),
    JSON.stringify({ ...valid, cachedAt: "today" }),
    JSON.stringify({ ...valid, rain: -1 }),
    JSON.stringify({ ...valid, rain: null }),
    JSON.stringify({ ...valid, rain: "0" }),
    JSON.stringify({ ...valid, cloud: null }),
    JSON.stringify({ ...valid, cloud: -1 }),
    JSON.stringify({ ...valid, cloud: 101 }),
    JSON.stringify({ ...valid, cloud: "20" }),
    JSON.stringify({ ...valid, cloud: undefined }),
    JSON.stringify({ ...valid, windy: 0 }),
  ];
  // require every rejected cache to follow the cold-loading contract
  for (const stored of invalid) {
    const controller = new WeatherDashboardController({ storage: iconStorage(stored) });
    assert.equal(controller.state.cachedNowIcon, null, stored);
    assert.match(nowMarkup(controller.state), /section-nav-weather-skeleton/u, stored);
  }
});

// recompute daylight from cached metrics and expire them at the exact age boundary
test("cached Now artwork follows sunset and the thirty-minute expiration", (context) => {
  const sunset = eveningSunTimes(site, daytime).sunset.getTime();
  const cachedAt = sunset - 5 * 60_000;
  context.mock.timers.enable({ apis: ["Date"], now: cachedAt });
  const storage = iconStorage(JSON.stringify({ rain: 0, cloud: 0, windy: false, cachedAt }));
  const controller = new WeatherDashboardController({ storage });
  assert.match(nowMarkup(controller.state), /01-sunny\.svg/u);
  context.mock.timers.setTime(sunset);
  assert.match(nowMarkup(controller.state), /13-clear-night\.svg/u);
  context.mock.timers.setTime(cachedAt + 30 * 60_000 - 1);
  assert.match(nowMarkup(controller.state), /13-clear-night\.svg/u);
  context.mock.timers.setTime(cachedAt + 30 * 60_000);
  assert.match(nowMarkup(controller.state), /section-nav-weather-skeleton/u);
  assert.match(nowMarkup({ ...controller.state, loading: false }), /12-unavailable\.svg/u);
});

// keep fresh observations ahead of a restored icon throughout a repeat read
test("live current observations replace cached artwork even while refreshing", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  const controller = new WeatherDashboardController({
    storage: iconStorage(JSON.stringify({ rain: 0, cloud: 0, windy: false, cachedAt: Date.now() })),
  });
  const html = nowMarkup({ ...controller.state, current: [reading(80, 3)] });
  assert.match(html, /09-heavy-rain\.svg/u);
  assert.doesNotMatch(html, /01-sunny|skeleton/u);
});

// persist only artwork inputs after real current reads and clear authoritative unknowns
test("successful current reads replace or clear Now cache without storing records", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  const storage = iconStorage();
  let records = [{ ...reading(null, 3, 10), privateSensor: "never-persist" }];
  let failure = false;
  const controller = new WeatherDashboardController({
    storage,
    view: "map",
    // keep the map fixture narrow while controlling current read outcomes
    fetcher: async (url) => {
      // simulate a transient weather outage without changing layout reads
      if (String(url).endsWith("/current") && failure) {
        return Response.json({ error: "temporarily unavailable" }, { status: 503 });
      }
      return Response.json({
        data: String(url).endsWith("/current") ? records : [],
        site: controller.state.selectedSite,
      });
    },
  });
  await controller.initialize();
  const expected = { rain: 3, cloud: null, windy: true, cachedAt: Date.now() };
  assert.equal(controller.state.error, null);
  assert.deepEqual(JSON.parse(storage.getItem(NOW_ICON_STORAGE_KEY)), expected);
  assert.deepEqual(controller.state.cachedNowIcon, expected);
  const restored = new WeatherDashboardController({ storage, view: "settings" });
  assert.match(nowMarkup(restored.state), /10-heavy-rain-wind\.svg/u);

  failure = true;
  await controller.loadCurrent();
  assert.match(controller.state.error, /503/u);
  assert.deepEqual(JSON.parse(storage.getItem(NOW_ICON_STORAGE_KEY)), expected);
  assert.match(nowMarkup(controller.state), /10-heavy-rain-wind\.svg/u);

  failure = false;
  // invalidate both empty and partially missing authoritative conditions
  for (const unavailable of [[], [reading(null)]]) {
    records = unavailable;
    await controller.loadCurrent();
    assert.equal(controller.state.error, null);
    assert.equal(controller.state.cachedNowIcon, null);
    assert.equal(storage.getItem(NOW_ICON_STORAGE_KEY), "null");
    assert.match(nowMarkup(controller.state), /12-unavailable\.svg/u);
    assert.doesNotMatch(nowMarkup(controller.state), /skeleton/u);
  }
});

// preserve restored artwork through a failed first fetch without pretending it is fresh data
test("a failed initial current read retains only unexpired cached artwork", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  const cache = { rain: 1, cloud: null, windy: false, cachedAt: Date.now() };
  const controller = new WeatherDashboardController({
    storage: iconStorage(JSON.stringify(cache)),
    view: "map",
    // fail before any live current observations arrive
    fetcher: async () => Response.json({ error: "unavailable" }, { status: 503 }),
  });
  await controller.initialize();
  assert.deepEqual(controller.state.current, []);
  assert.equal(controller.state.loading, false);
  assert.match(nowMarkup(controller.state), /07-light-rain\.svg/u);
  context.mock.timers.setTime(cache.cachedAt + 30 * 60_000);
  assert.match(nowMarkup(controller.state), /12-unavailable\.svg/u);
});

// accept authoritative current updates even when another page endpoint fails
test("current responses replace or clear the cache despite a sibling request failure", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: daytime });
  // cover new weather and both forms of authoritative unavailable conditions
  for (const records of [[reading(null, 3)], [], [reading(null)]]) {
    const storage = iconStorage(JSON.stringify({ rain: 0, cloud: 0, windy: false, cachedAt: Date.now() }));
    const controller = new WeatherDashboardController({
      storage,
      view: "map",
      // fail only the sibling layout request
      fetcher: async (url) => String(url).endsWith("/current")
        ? Response.json({ data: records, site: controller.state.selectedSite })
        : Response.json({ error: "layout unavailable" }, { status: 503 }),
    });
    await controller.initialize();
    const hasRain = records[0]?.metrics.precipitationRateMmPerHour > 0;
    assert.equal(controller.state.loading, false);
    assert.match(controller.state.error, /503/u);
    assert.deepEqual(controller.state.current, records);
    assert.deepEqual(JSON.parse(storage.getItem(NOW_ICON_STORAGE_KEY)), hasRain
      ? { rain: 3, cloud: null, windy: false, cachedAt: Date.now() }
      : null);
    assert.match(nowMarkup(controller.state), hasRain ? /09-heavy-rain\.svg/u : /12-unavailable\.svg/u);
  }
});

// keep loading semantics tied to the outstanding current response after a fast sibling error
test("a fast sibling failure cannot settle a pending cold Now icon", async () => {
  let releaseCurrent;
  const pendingCurrent = new Promise(
    // control the current response independently of the layout failure
    (resolve) => { releaseCurrent = resolve; },
  );
  const controller = new WeatherDashboardController({
    storage: null,
    view: "map",
    // return the layout failure before any current data is available
    fetcher: async (url) => String(url).endsWith("/current")
      ? pendingCurrent
      : Response.json({ error: "layout unavailable" }, { status: 503 }),
  });
  const initialization = controller.initialize();
  // drain response parsing and the batch rejection while current remains pending
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.loading, true);
  assert.match(nowMarkup(controller.state), /section-nav-weather-skeleton/u);
  assert.doesNotMatch(nowMarkup(controller.state), /12-unavailable/u);
  releaseCurrent(Response.json({ data: [reading(100)], site: controller.state.selectedSite }));
  await initialization;
  assert.equal(controller.state.loading, false);
  assert.match(controller.state.error, /503/u);
  assert.match(nowMarkup(controller.state), /05-cloudy\.svg/u);
});

// tolerate private browsing and full storage without breaking weather initialization
test("Now cache storage failures leave working in-memory artwork", async () => {
  const controller = new WeatherDashboardController({
    view: "map",
    storage: {
      // emulate a browser that denies storage reads
      getItem() { throw new Error("storage blocked"); },
      // emulate a browser that denies storage writes
      setItem() { throw new Error("storage blocked"); },
    },
    // return valid overcast conditions without requiring daylight fixtures
    fetcher: async (url) => Response.json({
      data: String(url).endsWith("/current") ? [reading(100)] : [],
      site: controller.state.selectedSite,
    }),
  });
  assert.equal(controller.state.cachedNowIcon, null);
  await controller.initialize();
  assert.equal(controller.state.error, null);
  assert.equal(controller.state.cachedNowIcon.cloud, 100);
  assert.match(nowMarkup(controller.state), /05-cloudy\.svg/u);
});
