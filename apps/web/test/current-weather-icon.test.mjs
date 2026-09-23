import assert from "node:assert/strict";
import test from "node:test";

import { currentWeatherIcon, eveningSunTimes } from "../dist/index.js";

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
