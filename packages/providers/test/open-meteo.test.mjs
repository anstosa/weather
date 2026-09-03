import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ProviderFailure,
  OPEN_METEO_PREVIOUS_RUNS_ADAPTER_VERSION,
  OPEN_METEO_PREVIOUS_RUNS_CONTRACT_EPOCH,
  OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES,
  OPEN_METEO_PREVIOUS_RUNS_WIND_GUST_INTERVAL,
  buildOpenMeteoAirQualityForecastRequest,
  buildOpenMeteoArchiveRequest,
  buildOpenMeteoCurrentRequest,
  buildOpenMeteoForecastRequest,
  buildOpenMeteoPreviousRunsRequest,
  createOpenMeteoCurrentOperation,
  createOpenMeteoForecastOperation,
  createOpenMeteoHistoricalOperation,
  createOpenMeteoPreviousRunsOperation,
  fetchJsonWithRetry,
  fetchOpenMeteoCurrent,
  fetchOpenMeteoForecast,
  fetchOpenMeteoPreviousRuns,
  normalizeArchivePayload,
  normalizeCurrentPayload,
  normalizeForecastPayload,
  normalizeOpenMeteoPreviousRunsPayload,
  openMeteoCapabilities,
  openMeteoPreviousRunsCapabilities,
  openMeteoPreviousRunsWeightedApiCallCost,
  parseOpenMeteoCompatibilityOrigin,
  providerRequestBudgetMilliseconds,
} from "../dist/index.js";

const location = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  sourceId: "source-current",
  timezone: "America/Los_Angeles",
};
const receivedAt = "2026-08-22T05:00:00.000Z";
const previousRunsLocation = {
  latitude: location.latitude,
  longitude: location.longitude,
  sourceConfigFingerprint: "a".repeat(64),
  sourceId: "source-previous-runs",
};
const previousRunsRequest = {
  contractEpoch: OPEN_METEO_PREVIOUS_RUNS_CONTRACT_EPOCH,
  endDate: "2026-08-01",
  locations: [previousRunsLocation],
  startDate: "2026-08-01",
};
const previousRunsBaseVariables = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "cloud_cover",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "surface_pressure",
];

// load a committed provider fixture
async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/open-meteo/${name}`, import.meta.url), "utf8"),
  );
}

// create an unambiguous UTC archive payload
async function utcArchiveFixture(start, hours) {
  const payload = await fixture("archive-fall-back.json");
  const startMilliseconds = Date.parse(start);

  // create one continuous UTC series
  const times = Array.from({ length: hours }, (_unused, index) =>
    new Date(startMilliseconds + index * 3_600_000).toISOString().slice(0, 16),
  );
  // repeat complete metric samples
  const repeat = (values) =>
    Array.from({ length: hours }, (_unused, index) => values[index % values.length]);

  payload.hourly = {
    apparent_temperature: repeat(payload.hourly.apparent_temperature),
    cloud_cover: repeat(payload.hourly.cloud_cover),
    precipitation: repeat(payload.hourly.precipitation),
    relative_humidity_2m: repeat(payload.hourly.relative_humidity_2m),
    surface_pressure: repeat(payload.hourly.surface_pressure),
    temperature_2m: repeat(payload.hourly.temperature_2m),
    time: times,
    wind_direction_10m: repeat(payload.hourly.wind_direction_10m),
    wind_gusts_10m: repeat(payload.hourly.wind_gusts_10m),
    wind_speed_10m: repeat(payload.hourly.wind_speed_10m),
  };
  payload.timezone = "UTC";
  payload.timezone_abbreviation = "UTC";
  payload.utc_offset_seconds = 0;
  return payload;
}

// expand a compact Previous Runs fixture to exact hourly coverage
async function previousRunsFixture(start, hours) {
  const payload = await fixture("previous-runs.json");
  const startMilliseconds = Date.parse(start);
  payload.hourly.time = Array.from(
    { length: hours },
    // retain one UTC provider wall-time per hour
    (_unused, index) =>
      new Date(startMilliseconds + index * 3_600_000).toISOString().slice(0, 16),
  );

  // align all 63 metric arrays to the expanded time axis
  for (const variable of OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES) {
    const values = payload.hourly[variable];
    payload.hourly[variable] = Array.from(
      { length: hours },
      // repeat only the compact synthetic samples
      (_unused, index) => values[index % values.length],
    );
  }

  return payload;
}

// set every fixed-lead metric to one value
function setPreviousRunsLead(payload, dayOffset, value) {
  // update all nine contract variables
  for (const baseVariable of previousRunsBaseVariables) {
    payload.hourly[`${baseVariable}_previous_day${dayOffset}`] = Array(
      payload.hourly.time.length,
    ).fill(value);
  }
}

// prove modern current request parameters
test("U-OM-01 current URL uses modern variables and explicit controls", () => {
  const plan = buildOpenMeteoCurrentRequest(location);
  assert.equal(plan.url.origin + plan.url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.match(plan.url.searchParams.get("current"), /temperature_2m/u);
  assert.equal(plan.url.searchParams.get("hourly"), null);
  assert.equal(plan.url.searchParams.get("temperature_unit"), "celsius");
  assert.equal(plan.url.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(plan.url.searchParams.get("precipitation_unit"), "mm");
  assert.equal(plan.url.searchParams.get("timezone"), location.timezone);
});

// prove archive request parameters
test("U-OM-02 archive URL uses inclusive dates and hourly variables", () => {
  const plan = buildOpenMeteoArchiveRequest({
    ...location,
    endDate: "2026-08-03",
    startDate: "2026-08-01",
  });
  assert.equal(
    plan.url.origin + plan.url.pathname,
    "https://archive-api.open-meteo.com/v1/archive",
  );
  assert.match(plan.url.searchParams.get("hourly"), /surface_pressure/u);
  assert.equal(plan.url.searchParams.get("start_date"), "2026-08-01");
  assert.equal(plan.url.searchParams.get("end_date"), "2026-08-04");
  assert.equal(plan.url.searchParams.get("timezone"), "UTC");
});

// prove the exact Previous Runs request contract
test("U-PR-01 and U-PR-02 Previous Runs URL freezes all fixed-lead fields", () => {
  const input = {
    ...previousRunsRequest,
    endDate: "2026-08-14",
    locations: [
      previousRunsLocation,
      {
        latitude: 48.1,
        longitude: -122.7,
        sourceConfigFingerprint: "b".repeat(64),
        sourceId: "source-previous-runs-two",
      },
    ],
  };
  const plan = buildOpenMeteoPreviousRunsRequest(input);
  const fields = plan.url.searchParams.get("hourly").split(",");
  const expectedFields = previousRunsBaseVariables.flatMap(
    // expand all seven fixed offsets
    (variable) => Array.from(
      { length: 7 },
      // retain official day suffixes one through seven
      (_unused, index) => `${variable}_previous_day${index + 1}`,
    ),
  );

  assert.equal(
    plan.url.origin + plan.url.pathname,
    "https://previous-runs-api.open-meteo.com/v1/forecast",
  );
  assert.equal(plan.adapterVersion, "open-meteo-previous-runs/v1");
  assert.equal(plan.capability, "historical");
  assert.equal(plan.sourceKind, "forecast");
  assert.deepEqual(openMeteoPreviousRunsCapabilities(), ["historical"]);
  assert.equal(plan.url.searchParams.get("latitude"), "47.950429954185445,48.1");
  assert.equal(plan.url.searchParams.get("longitude"), "-122.42797012608193,-122.7");
  assert.equal(plan.url.searchParams.get("models"), "best_match");
  assert.equal(plan.url.searchParams.get("temperature_unit"), "celsius");
  assert.equal(plan.url.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(plan.url.searchParams.get("precipitation_unit"), "mm");
  assert.equal(plan.url.searchParams.get("timezone"), "UTC");
  assert.equal(plan.url.searchParams.get("start_date"), "2026-08-01");
  assert.equal(plan.url.searchParams.get("end_date"), "2026-08-14");
  assert.equal(fields.length, 63);
  assert.equal(new Set(fields).size, 63);
  assert.deepEqual(new Set(fields), new Set(expectedFields));
  assert.ok(fields.every(
    // exclude unsuffixed and unsupported fields
    (field) => /_previous_day[1-7]$/u.test(field),
  ));
  assert.ok(fields.every(
    // exclude UV and particulate products
    (field) => !/uv_index|pm2_5|previous_day0|previous_day8/u.test(field),
  ));
  assert.deepEqual(OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES, fields);
  assert.equal(openMeteoPreviousRunsWeightedApiCallCost(2, 14), 12.6);
  assert.equal(openMeteoPreviousRunsWeightedApiCallCost(11, 14), 69.3);
  assert.equal(openMeteoPreviousRunsWeightedApiCallCost(2, 1), 0.9);

  assert.throws(
    () => buildOpenMeteoPreviousRunsRequest({ ...input, endDate: "2026-08-15" }),
    /14-day inclusive range/u,
  );
  assert.throws(
    () => buildOpenMeteoPreviousRunsRequest({ ...input, startDate: "2026-08-15" }),
    /ordered/u,
  );
  assert.throws(
    () => buildOpenMeteoPreviousRunsRequest({ ...input, locations: [] }),
    /between 1 and 100/u,
  );
  assert.throws(
    () =>
      buildOpenMeteoPreviousRunsRequest({
        ...input,
        locations: Array.from(
          { length: 101 },
          // create bounded unique positional identities
          (_unused, index) => ({
            ...previousRunsLocation,
            sourceId: `source-previous-runs-${index}`,
          }),
        ),
      }),
    /between 1 and 100/u,
  );
  assert.throws(
    () =>
      buildOpenMeteoPreviousRunsRequest({
        ...input,
        locations: [previousRunsLocation, previousRunsLocation],
      }),
    /sourceId values must be unique/u,
  );
});

// prove maximum fixed-anchor cardinality and truthful provenance
test("U-PR-03 U-PR-04 and U-PR-09 full chunk emits fixed anchors only", async () => {
  const payload = await previousRunsFixture("2026-08-01T00:00:00.000Z", 336);
  const input = {
    ...previousRunsRequest,
    endDate: "2026-08-14",
  };
  const records = normalizeOpenMeteoPreviousRunsPayload(
    payload,
    input,
    receivedAt,
  );
  const identities = new Set(
    records.map(
      // project the storage identity
      (record) => `${record.sourceId}|${record.validAt}|${record.leadHours}`,
    ),
  );

  assert.equal(records.length, 2_352);
  assert.equal(identities.size, 2_352);

  // inspect every emitted anchor contract
  for (const record of records) {
    assert.equal(record.adapterVersion, OPEN_METEO_PREVIOUS_RUNS_ADAPTER_VERSION);
    assert.equal(record.contractEpoch, OPEN_METEO_PREVIOUS_RUNS_CONTRACT_EPOCH);
    assert.equal(record.contractVersion, "forecast-anchor-record/v1");
    assert.equal(record.dataset, "previous_runs");
    assert.equal(record.upstreamModel, "best_match");
    assert.equal(record.metadata.model, "best_match");
    assert.equal(record.metadata.provider.dataset, "previous_runs");
    assert.equal(record.metadata.upstreamTimezone, "UTC");
    assert.equal(record.sourceKind, "forecast");
    assert.equal(record.sourceConfigFingerprint, "a".repeat(64));
    assert.equal(record.receivedAt, receivedAt);
    assert.ok([24, 48, 72, 96, 120, 144, 168].includes(record.leadHours));

    // exclude every exact-run or synthetic-reference claim
    for (const field of [
      "productRunAt",
      "referenceAt",
      "runAt",
      "modelRunAt",
      "initializedAt",
    ]) {
      assert.equal(field in record, false);
    }
  }

  // require equal fixed-lead coverage
  for (const leadHours of [24, 48, 72, 96, 120, 144, 168]) {
    assert.equal(
      records.filter(
        // count one exact lead
        (record) => record.leadHours === leadHours,
      ).length,
      336,
    );
  }
});

// prove sparse higher leads and zero values remain distinguishable
test("U-PR-05 sparse Previous Runs anchors omit only all-nine-null rows", async () => {
  const payload = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);

  // clear every fixed lead first
  for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
    setPreviousRunsLead(payload, dayOffset, null);
  }

  payload.hourly.temperature_2m_previous_day2[0] = 0;
  payload.hourly.precipitation_previous_day3[0] = 0;
  const body = JSON.stringify(payload);
  const batch = await fetchOpenMeteoPreviousRuns(previousRunsRequest, {
    fetch: async () => new Response(body, { status: 200 }),
    now: () => new Date(receivedAt),
  });
  const temperature = batch.records.find(
    // select the zero-temperature anchor
    (record) => record.leadHours === 48,
  );
  const precipitation = batch.records.find(
    // select the zero-precipitation anchor
    (record) => record.leadHours === 72,
  );

  assert.equal(batch.records.length, 2);
  assert.equal(temperature.metrics.temperatureC, 0);
  assert.equal(temperature.metrics.relativeHumidityPercent, null);
  assert.equal(precipitation.metrics.precipitationMm, 0);
  assert.equal(precipitation.metrics.precipitationRateMmPerHour, null);
  assert.equal(batch.providerCursor, null);
  assert.equal(
    batch.checksum,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.deepEqual(batch.responseMetadata.anchor_counts_by_lead, {
    24: { null: 24, populated: 0, requested: 24 },
    48: { null: 23, populated: 1, requested: 24 },
    72: { null: 23, populated: 1, requested: 24 },
    96: { null: 24, populated: 0, requested: 24 },
    120: { null: 24, populated: 0, requested: 24 },
    144: { null: 24, populated: 0, requested: 24 },
    168: { null: 24, populated: 0, requested: 24 },
  });
  assert.equal(batch.responseMetadata.requested_anchor_count, 168);
  assert.equal(batch.responseMetadata.populated_anchor_count, 2);
  assert.equal(batch.responseMetadata.null_anchor_count, 166);
  assert.equal(batch.responseMetadata.selected_field_count, 63);
  assert.equal(batch.responseMetadata.requested_location_count, 1);
  assert.equal(batch.responseMetadata.location_response_count, 1);
  assert.equal(batch.responseMetadata.upstream_http_response_count, 1);
  assert.equal(batch.responseMetadata.weighted_api_call_cost, 0.45);
  assert.equal(
    batch.responseMetadata.data_modification,
    "normalized_to_canonical_fixed_lead_anchors",
  );
  assert.equal(
    batch.responseMetadata.wind_gust_interval,
    OPEN_METEO_PREVIOUS_RUNS_WIND_GUST_INTERVAL,
  );
  const serializedBatch = JSON.stringify(batch);

  // exclude synthetic exact-run fields across the complete provider batch
  for (const field of [
    "productRunAt",
    "referenceAt",
    "runAt",
    "modelRunAt",
    "initializedAt",
  ]) {
    assert.equal(serializedBatch.includes(field), false);
  }
});

// prove multi-coordinate responses bind by request position
test("Previous Runs multi-location arrays preserve positional identities", async () => {
  const first = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);
  const second = structuredClone(first);
  second.latitude = 48.095;
  second.longitude = -122.705;
  second.location_id = 1;
  second.hourly.temperature_2m_previous_day1[0] = 25;
  const input = {
    ...previousRunsRequest,
    locations: [
      previousRunsLocation,
      {
        latitude: 48.1,
        longitude: -122.7,
        sourceConfigFingerprint: "b".repeat(64),
        sourceId: "source-previous-runs-two",
      },
    ],
  };
  const body = JSON.stringify([first, second]);
  const operation = createOpenMeteoPreviousRunsOperation(
    "http://provider-stub:8080",
  );
  const requests = [];
  const batch = await operation(input, {
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(body, { status: 200 });
    },
    now: () => new Date(receivedAt),
  });
  const firstAnchor = batch.records.find(
    // select position-zero day-one output
    (record) => record.sourceId === previousRunsLocation.sourceId && record.leadHours === 24,
  );
  const secondAnchor = batch.records.find(
    // select position-one day-one output
    (record) => record.sourceId === "source-previous-runs-two" && record.leadHours === 24,
  );

  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).pathname, "/v1/forecast");
  assert.equal(firstAnchor.metadata.provider.grid_cell, "47.941,-122.438");
  assert.equal(secondAnchor.metadata.provider.grid_cell, "48.095,-122.705");
  assert.equal(firstAnchor.metrics.temperatureC, 10.1);
  assert.equal(secondAnchor.metrics.temperatureC, 25);
  assert.equal(firstAnchor.sourceConfigFingerprint, "a".repeat(64));
  assert.equal(secondAnchor.sourceConfigFingerprint, "b".repeat(64));
  assert.equal(batch.responseMetadata.weighted_api_call_cost, 0.9);
  assert.equal(batch.responseMetadata.location_response_count, 2);

  assert.throws(
    () => normalizeOpenMeteoPreviousRunsPayload([first], input, receivedAt),
    /response count/u,
  );
  assert.throws(
    () => normalizeOpenMeteoPreviousRunsPayload(first, input, receivedAt),
    /must be an array/u,
  );
  const wrongPosition = structuredClone(second);
  wrongPosition.location_id = 3;
  assert.throws(
    () => normalizeOpenMeteoPreviousRunsPayload([first, wrongPosition], input, receivedAt),
    /location_id/u,
  );

  const emptyFirst = structuredClone(first);

  // clear only the first positional response
  for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
    setPreviousRunsLead(emptyFirst, dayOffset, null);
  }

  const secondOnly = normalizeOpenMeteoPreviousRunsPayload(
    [emptyFirst, second],
    input,
    receivedAt,
  );
  assert.ok(secondOnly.every(
    // retain output only from the populated position
    (record) => record.sourceId === "source-previous-runs-two",
  ));
});

// prove malformed Previous Runs shapes fail closed
test("U-PR-06 Previous Runs rejects time array unit and envelope drift", async () => {
  const cases = [
    {
      name: "duplicate time",
      // duplicate the sole valid hour
      mutate(payload) {
        payload.hourly.time[1] = payload.hourly.time[0];
      },
    },
    {
      name: "reversed time",
      // reverse two otherwise valid hours
      mutate(payload) {
        [payload.hourly.time[0], payload.hourly.time[1]] =
          [payload.hourly.time[1], payload.hourly.time[0]];
      },
    },
    {
      name: "rollover time",
      // inject an impossible date
      mutate(payload) {
        payload.hourly.time[0] = "2026-08-32T00:00";
      },
    },
    {
      name: "missing array",
      // remove one required suffix
      mutate(payload) {
        delete payload.hourly.temperature_2m_previous_day1;
      },
    },
    {
      name: "non-array",
      // replace one positional array
      mutate(payload) {
        payload.hourly.temperature_2m_previous_day1 = 10;
      },
    },
    {
      name: "short array",
      // break time-axis alignment
      mutate(payload) {
        payload.hourly.temperature_2m_previous_day1 = [];
      },
    },
    {
      name: "missing metric unit",
      // remove one required unit
      mutate(payload) {
        delete payload.hourly_units.temperature_2m_previous_day1;
      },
    },
    {
      name: "wrong metric unit",
      // change one canonical unit
      mutate(payload) {
        payload.hourly_units.temperature_2m_previous_day1 = "°F";
      },
    },
    {
      name: "wrong time unit",
      // change the time encoding contract
      mutate(payload) {
        payload.hourly_units.time = "unixtime";
      },
    },
    {
      name: "renamed suffix",
      // replace a required day with an unsupported day
      mutate(payload) {
        payload.hourly.temperature_2m_previous_day0 =
          payload.hourly.temperature_2m_previous_day1;
        delete payload.hourly.temperature_2m_previous_day1;
      },
    },
    {
      name: "extra invalid suffix",
      // add an unrequested eighth lead
      mutate(payload) {
        payload.hourly.temperature_2m_previous_day8 =
          payload.hourly.temperature_2m_previous_day1;
        payload.hourly_units.temperature_2m_previous_day8 = "°C";
      },
    },
    {
      name: "nonzero UTC offset",
      // contradict the UTC request contract
      mutate(payload) {
        payload.utc_offset_seconds = 3_600;
      },
    },
    {
      name: "non-UTC timezone",
      // contradict the UTC request label
      mutate(payload) {
        payload.timezone = "America/Los_Angeles";
      },
    },
  ];

  // execute every one-fact mutation independently
  for (const invalidCase of cases) {
    const payload = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);
    invalidCase.mutate(payload);
    assert.throws(
      () => normalizeOpenMeteoPreviousRunsPayload(payload, previousRunsRequest, receivedAt),
      (error) =>
        error instanceof ProviderFailure &&
        error.ingestionError.classification === "invalid_payload",
      invalidCase.name,
    );
  }

  const missingHour = await previousRunsFixture(
    "2026-08-01T00:00:00.000Z",
    24,
  );
  missingHour.hourly.time.splice(10, 1);

  // delete the same provider hour from every metric array
  for (const variable of OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES) {
    missingHour.hourly[variable].splice(10, 1);
  }

  assert.throws(
    () =>
      normalizeOpenMeteoPreviousRunsPayload(
        missingHour,
        previousRunsRequest,
        receivedAt,
      ),
    /every requested hour/u,
  );

  const emptyTime = await previousRunsFixture(
    "2026-08-01T00:00:00.000Z",
    24,
  );
  emptyTime.hourly.time = [];

  // keep all provider arrays aligned to the empty time axis
  for (const variable of OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES) {
    emptyTime.hourly[variable] = [];
  }

  assert.throws(
    () =>
      normalizeOpenMeteoPreviousRunsPayload(
        emptyTime,
        previousRunsRequest,
        receivedAt,
      ),
    /every requested hour/u,
  );

  const empty = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);

  // clear every returned anchor
  for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
    setPreviousRunsLead(empty, dayOffset, null);
  }

  assert.throws(
    () => normalizeOpenMeteoPreviousRunsPayload(empty, previousRunsRequest, receivedAt),
    /no populated anchors/u,
  );
});

// prove Previous Runs retains bounded HTTP retry and checksum controls
test("U-PR-07 Previous Runs operation retries 429 with one physical request contract", async () => {
  const payload = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);
  const body = JSON.stringify(payload);
  const requests = [];
  const delays = [];
  let attempt = 0;
  const operation = createOpenMeteoPreviousRunsOperation(
    "http://provider-stub:8080",
  );
  const batch = await operation(previousRunsRequest, {
    fetch: async (url, init) => {
      attempt += 1;
      requests.push({ headers: init.headers, url: String(url) });

      // rate limit only the first physical attempt
      if (attempt === 1) {
        return new Response('{"reason":"slow down"}', {
          headers: { "retry-after": "1" },
          status: 429,
        });
      }

      return new Response(body, { status: 200 });
    },
    now: () => new Date(receivedAt),
    random: () => 0,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(batch.attempts, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(requests[0].url, requests[1].url);
  assert.deepEqual(requests[0].headers, { accept: "application/json" });
  assert.equal(
    batch.checksum,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(batch.responseMetadata.upstream_http_response_count, 1);
  assert.equal(batch.responseMetadata.weighted_api_call_cost, 0.45);
});

// prove transient provider failures use bounded exponential retry
test("U-PR-07 Previous Runs operation retries 503 with the same request", async () => {
  const payload = await previousRunsFixture("2026-08-01T00:00:00.000Z", 24);
  const body = JSON.stringify(payload);
  const requests = [];
  const delays = [];
  let attempt = 0;
  const operation = createOpenMeteoPreviousRunsOperation(
    "http://provider-stub:8080",
  );
  const batch = await operation(previousRunsRequest, {
    fetch: async (url, init) => {
      attempt += 1;
      requests.push({ headers: init.headers, url: String(url) });

      // fail only the first physical attempt
      if (attempt === 1) {
        return new Response('{"reason":"temporary outage"}', { status: 503 });
      }

      return new Response(body, { status: 200 });
    },
    now: () => new Date(receivedAt),
    random: () => 0,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(batch.attempts, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.deepEqual(requests[0].headers, { accept: "application/json" });
  assert.deepEqual(requests[1].headers, { accept: "application/json" });
  assert.equal(
    batch.checksum,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(batch.responseMetadata.upstream_http_response_count, 1);
  assert.equal(batch.responseMetadata.weighted_api_call_cost, 0.45);
});

// prove operation-level JSON and body limits cannot be bypassed
test("U-PR-07 Previous Runs operation rejects invalid JSON and oversized bodies", async () => {
  const operation = createOpenMeteoPreviousRunsOperation(
    "http://provider-stub:8080",
  );

  await assert.rejects(
    operation(previousRunsRequest, {
      fetch: async () => new Response("{"),
      maxAttempts: 1,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "invalid_json",
  );
  await assert.rejects(
    operation(previousRunsRequest, {
      fetch: async () => new Response('{"oversized":true}'),
      maxAttempts: 1,
      maxBodyBytes: 4,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_response_too_large",
  );
});

// lock exact v4 paired request contracts
test("hourly forecast uses ten weather days and the complete air-quality horizon", () => {
  const weatherPlan = buildOpenMeteoForecastRequest(location);
  const airQualityPlan = buildOpenMeteoAirQualityForecastRequest(location);

  assert.deepEqual(
    {
      adapterVersion: weatherPlan.adapterVersion,
      capability: weatherPlan.capability,
      originAndPath: weatherPlan.url.origin + weatherPlan.url.pathname,
      parameters: Object.fromEntries(weatherPlan.url.searchParams),
      sourceKind: weatherPlan.sourceKind,
    },
    {
      adapterVersion: "open-meteo-forecast-daily/v4",
      capability: "forecast",
      originAndPath: "https://api.open-meteo.com/v1/forecast",
      parameters: {
        forecast_days: "10",
        hourly:
          "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure,uv_index",
        latitude: "47.950429954185445",
        longitude: "-122.42797012608193",
        precipitation_unit: "mm",
        temperature_unit: "celsius",
        timezone: "America/Los_Angeles",
        wind_speed_unit: "ms",
      },
      sourceKind: "forecast",
    },
  );
  assert.deepEqual(
    {
      adapterVersion: airQualityPlan.adapterVersion,
      capability: airQualityPlan.capability,
      originAndPath: airQualityPlan.url.origin + airQualityPlan.url.pathname,
      parameters: Object.fromEntries(airQualityPlan.url.searchParams),
      sourceKind: airQualityPlan.sourceKind,
    },
    {
      adapterVersion: "open-meteo-forecast-daily/v4",
      capability: "forecast",
      originAndPath: "https://air-quality-api.open-meteo.com/v1/air-quality",
      parameters: {
        forecast_days: "7",
        hourly: "pm2_5",
        latitude: "47.950429954185445",
        longitude: "-122.42797012608193",
        timezone: "America/Los_Angeles",
      },
      sourceKind: "forecast",
    },
  );
});

// prove current normalization and provenance
test("U-OM-03 current fixture normalizes to model_current", async () => {
  const record = normalizeCurrentPayload(
    await fixture("current.json"),
    location.sourceId,
    receivedAt,
  );
  assert.equal(record.sourceKind, "model_current");
  assert.equal(record.validAt, "2026-08-22T05:00:00.000Z");
  assert.equal(record.metrics.precipitationMm, 0);
  assert.equal(record.metadata.upstreamTimezone, "America/Los_Angeles");
  assert.equal(record.metadata.model, "best_match");
  assert.deepEqual(record.metadata.provider, {
    dataset: "forecast",
    elevation_m: 32,
    grid_cell: "47.941,-122.438",
  });
});

// collapse Open-Meteo's duplicate north direction
test("Open-Meteo wind direction 360 normalizes to zero", async () => {
  const payload = await fixture("current.json");
  payload.current.wind_direction_10m = 360;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.metrics.windDirectionDegrees, 0);
});

// preserve exact hourly coverage across DST changes
test("archive operations query UTC and filter exact local calendar days", async () => {
  const operation = createOpenMeteoHistoricalOperation("http://provider-stub:8080");
  const spring = await operation(
    { ...location, endDate: "2019-03-10", startDate: "2019-03-10" },
    {
      fetch: async () =>
        new Response(JSON.stringify(await utcArchiveFixture("2019-03-10T00:00:00Z", 48))),
      now: () => new Date(receivedAt),
    },
  );
  const fall = await operation(
    { ...location, endDate: "2019-11-03", startDate: "2019-11-03" },
    {
      fetch: async () =>
        new Response(JSON.stringify(await utcArchiveFixture("2019-11-03T00:00:00Z", 48))),
      now: () => new Date(receivedAt),
    },
  );

  assert.equal(spring.records.length, 23);
  assert.equal(spring.records[0].validAt, "2019-03-10T08:00:00.000Z");
  assert.equal(spring.records.at(-1).validAt, "2019-03-11T06:00:00.000Z");
  assert.equal(fall.records.length, 25);
  assert.equal(fall.records[0].validAt, "2019-11-03T07:00:00.000Z");
  assert.equal(fall.records.at(-1).validAt, "2019-11-04T07:00:00.000Z");
});

// prove the first repeated hour follows the provider offset
test("current fall-back time honors the daylight offset", async () => {
  const payload = await fixture("current.json");
  payload.current.time = "2026-11-01T01:30";
  payload.utc_offset_seconds = -25_200;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.validAt, "2026-11-01T08:30:00.000Z");
});

// prove the second repeated hour follows the provider offset
test("current fall-back time honors the standard offset", async () => {
  const payload = await fixture("current.json");
  payload.current.time = "2026-11-01T01:30";
  payload.utc_offset_seconds = -28_800;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.validAt, "2026-11-01T09:30:00.000Z");
});

// prove archive normalization across repeated DST time
test("U-OM-04 archive fixture normalizes distinct reanalysis instants", async () => {
  const records = normalizeArchivePayload(
    await fixture("archive-fall-back.json"),
    "source-archive",
    receivedAt,
  );
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record.validAt),
    [
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
    ],
  );
  assert.equal(records[0].sourceKind, "reanalysis");
  assert.equal(records[1].metrics.precipitationMm, null);
});

// lock the complete normalized v4 fixture
test("hourly forecast normalization retains product identity", async () => {
  const weather = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const records = normalizeForecastPayload(
    weather,
    airQuality,
    "source-forecast",
    receivedAt,
  );

  assert.deepEqual(records, [
    {
      metadata: {
        device: null,
        model: "best_match",
        provider: {
          dataset: "forecast",
          elevation_m: 32,
          grid_cell: "47.941,-122.438",
        },
        quality: null,
        upstreamTimezone: "GMT",
      },
      metrics: {
        apparentTemperatureC: 11.7,
        blackGlobeTemperatureC: null,
        cloudCoverPercent: 72,
        pm25MicrogramsPerCubicMeter: 5,
        precipitationMm: 0.1,
        precipitationRateMmPerHour: 0.1,
        pressureHpa: 1018.1,
        relativeHumidityPercent: 83,
        soilElectricalConductivityMicrosiemensPerCm: null,
        soilMoisturePercent: null,
        solarRadiationWm2: null,
        temperatureC: 12.1,
        uvIndex: 0.2,
        waterLevelM: null,
        windDirectionDegrees: 180,
        windGustMps: 3.1,
        windSpeedMps: 1.8,
        wetBulbGlobeTemperatureC: null,
      },
      productRunAt: receivedAt,
      receivedAt,
      sourceId: "source-forecast",
      sourceKind: "forecast",
      validAt: "2026-08-22T05:00:00.000Z",
    },
    {
      metadata: {
        device: null,
        model: "best_match",
        provider: {
          dataset: "forecast",
          elevation_m: 32,
          grid_cell: "47.941,-122.438",
        },
        quality: null,
        upstreamTimezone: "GMT",
      },
      metrics: {
        apparentTemperatureC: 12.4,
        blackGlobeTemperatureC: null,
        cloudCoverPercent: 68,
        pm25MicrogramsPerCubicMeter: 8,
        precipitationMm: 0.2,
        precipitationRateMmPerHour: 0.2,
        pressureHpa: 1018.3,
        relativeHumidityPercent: 80,
        soilElectricalConductivityMicrosiemensPerCm: null,
        soilMoisturePercent: null,
        solarRadiationWm2: null,
        temperatureC: 12.8,
        uvIndex: 0.5,
        waterLevelM: null,
        windDirectionDegrees: 185,
        windGustMps: 3.6,
        windSpeedMps: 2.1,
        wetBulbGlobeTemperatureC: null,
      },
      productRunAt: receivedAt,
      receivedAt,
      sourceId: "source-forecast",
      sourceKind: "forecast",
      validAt: "2026-08-22T06:00:00.000Z",
    },
    {
      metadata: {
        device: null,
        model: "best_match",
        provider: {
          dataset: "forecast",
          elevation_m: 32,
          grid_cell: "47.941,-122.438",
        },
        quality: null,
        upstreamTimezone: "GMT",
      },
      metrics: {
        apparentTemperatureC: 13.1,
        blackGlobeTemperatureC: null,
        cloudCoverPercent: 61,
        pm25MicrogramsPerCubicMeter: 12,
        precipitationMm: 0.3,
        precipitationRateMmPerHour: 0.3,
        pressureHpa: 1018.5,
        relativeHumidityPercent: 77,
        soilElectricalConductivityMicrosiemensPerCm: null,
        soilMoisturePercent: null,
        solarRadiationWm2: null,
        temperatureC: 13.4,
        uvIndex: 0.9,
        waterLevelM: null,
        windDirectionDegrees: 190,
        windGustMps: 4.2,
        windSpeedMps: 2.4,
        wetBulbGlobeTemperatureC: null,
      },
      productRunAt: receivedAt,
      receivedAt,
      sourceId: "source-forecast",
      sourceKind: "forecast",
      validAt: "2026-08-22T07:00:00.000Z",
    },
  ]);
});

// prove paired requests run together and retain combined provenance
test("forecast fetch combines weather and air-quality products", async () => {
  const weather = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const responseChecksums = [];
  const injectedFetch = async (url) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    requests.push(String(url));
    const payload = new URL(url).pathname === "/v1/air-quality"
      ? airQuality
      : weather;
    const body = JSON.stringify(payload);
    responseChecksums.push(
      createHash("sha256").update(body).digest("hex"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(body, { status: 200 });
  };
  const batch = await fetchOpenMeteoForecast(location, {
    fetch: injectedFetch,
    now: () => new Date(receivedAt),
  });
  const checksum = createHash("sha256");

  // retain request-order checksum boundaries
  for (const responseChecksum of responseChecksums) {
    checksum.update(`${responseChecksum}\n`);
  }

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    // retain one request per v4 product
    requests.map((request) => new URL(request).pathname).sort(),
    ["/v1/air-quality", "/v1/forecast"],
  );
  assert.equal(batch.attempts, 2);
  assert.equal(batch.checksum, checksum.digest("hex"));
  assert.equal(batch.records.length, 3);
  assert.deepEqual(batch.responseMetadata, {
    air_quality_generation_ms: 0.08,
    air_quality_http_status: 200,
    http_status: 200,
    upstream_response_count: 2,
    weather_generation_ms: 0.12,
  });
});

// prove malformed and mismatched arrays fail closed
test("U-OM-05 invalid and mismatched payloads are classified invalid_payload", async () => {
  const payload = await fixture("archive-fall-back.json");
  payload.hourly.temperature_2m = payload.hourly.temperature_2m.slice(1);
  assert.throws(
    () => normalizeArchivePayload(payload, "source-archive", receivedAt),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "invalid_payload",
  );
  assert.throws(
    () => normalizeCurrentPayload({}, location.sourceId, receivedAt),
    ProviderFailure,
  );
});

// prove timeout abort behavior
test("U-OM-07 configured timeout aborts the provider request", async () => {
  let aborted = false;
  const pendingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      // observe the abort signal
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: pendingFetch,
      maxAttempts: 1,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "retryable",
  );
  assert.equal(aborted, true);
});

// prove the request deadline covers response consumption
test("provider timeout cancels a stalled response body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    // retain an incomplete JSON body
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
    // observe reader cancellation
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () => new Response(body, { status: 200 }),
      maxAttempts: 1,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_unavailable",
  );
  assert.equal(cancelled, true);
});

// prove cleanup cannot extend the response deadline
test("provider timeout does not await stalled stream cancellation", async () => {
  let cancelCalled = false;
  const body = new ReadableStream({
    // retain an incomplete body
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    // simulate a cleanup implementation that never settles
    cancel() {
      cancelCalled = true;
      return new Promise(() => {});
    },
  });
  const outcome = await Promise.race([
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () => new Response(body, { status: 200 }),
      maxAttempts: 1,
      timeoutMs: 5,
    }).catch((error) => error),
    new Promise((resolve) => {
      setTimeout(() => resolve("still-pending"), 100);
    }),
  ]);

  assert.notEqual(outcome, "still-pending");
  assert.equal(cancelCalled, true);
});

// prove declared oversize bodies are cancelled before reads
test("provider cancels an honestly declared oversized body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    // retain a body that should never be read
    start() {},
    // observe pre-read cancellation
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () =>
        new Response(body, {
          headers: { "content-length": "100" },
          status: 200,
        }),
      maxAttempts: 1,
      maxBodyBytes: 8,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_response_too_large",
  );
  assert.equal(cancelled, true);
});

// prove response bodies cannot exceed the configured byte ceiling
test("provider rejects oversized response bodies before parsing", async () => {
  // enforce the stream limit for both success and error responses
  for (const status of [200, 400]) {
    await assert.rejects(
      fetchJsonWithRetry(new URL("https://example.test/weather"), {
        fetch: async () =>
          new Response('{"payload":"too-large"}', {
            headers: { "content-length": "1" },
            status,
          }),
        maxAttempts: 1,
        maxBodyBytes: 8,
      }),
      (error) =>
        error instanceof ProviderFailure &&
        error.ingestionError.classification === "invalid_payload" &&
        error.ingestionError.code === "provider_response_too_large",
    );
  }
});

// prove the durable run budget covers every bounded retry phase
test("provider request budget includes attempts and maximum retry delays", () => {
  assert.equal(
    providerRequestBudgetMilliseconds({ maxAttempts: 3, timeoutMs: 10_000 }),
    90_000,
  );
});

// stop before a retry delay that would cross the absolute run deadline
test("provider retry sleep respects the persisted run deadline", async () => {
  let sleeps = 0;

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      clock: () => 0,
      deadlineAt: "1970-01-01T00:00:01.000Z",
      fetch: async () =>
        new Response('{"reason":"slow down"}', {
          headers: { "retry-after": "30" },
          status: 429,
        }),
      sleep: async () => {
        sleeps += 1;
      },
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_deadline_exceeded",
  );
  assert.equal(sleeps, 0);
});

// prove bounded retry and no secret headers
test("U-OM-08 429 retries once with deterministic delay", async () => {
  const delays = [];
  const requests = [];
  let attempt = 0;
  const current = await fixture("current.json");
  const injectedFetch = async (url, init) => {
    attempt += 1;
    requests.push({ init, url: String(url) });

    // rate limit the first request
    if (attempt === 1) {
      return new Response('{"error":true,"reason":"slow down"}', {
        headers: { "retry-after": "1" },
        status: 429,
      });
    }

    return new Response(JSON.stringify(current), { status: 200 });
  };
  const batch = await fetchOpenMeteoCurrent(location, {
    fetch: injectedFetch,
    now: () => new Date(receivedAt),
    random: () => 0,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  assert.equal(batch.attempts, 2);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(requests[0].init.headers, { accept: "application/json" });
});

// prove permanent failures do not retry
test("U-OM-09 4xx and invalid JSON do not retry", async () => {
  let attempts = 0;
  const rejectedFetch = async () => {
    attempts += 1;
    return new Response('{"error":true,"reason":"bad input"}', { status: 400 });
  };
  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: rejectedFetch,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "permanent",
  );
  assert.equal(attempts, 1);
});

// prove persisted provider reasons never retain credential-shaped values
test("provider response reasons are bounded and redacted", async () => {
  const reason = [
    "api_key=provider-secret",
    "api key: spaced-provider-secret",
    "Authorization: Basic authorization-secret",
    "Bearer bearer-secret",
    "postgresql://worker:database-secret@database/weather",
    'token="alpha-secret,beta-secret"',
    "password=gamma-secret;delta-secret",
  ].join(" ");

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () =>
        new Response(JSON.stringify({ error: true, reason }), { status: 400 }),
      maxAttempts: 1,
    }),
    (error) => {
      // inspect the persistence-facing diagnosis
      if (!(error instanceof ProviderFailure)) {
        return false;
      }

      assert.match(error.ingestionError.message, /\[redacted\]/u);
      assert.doesNotMatch(error.ingestionError.message, /provider-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /spaced-provider-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /authorization-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /bearer-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /database-secret/u);
      assert.doesNotMatch(
        error.ingestionError.message,
        /alpha-secret|beta-secret|gamma-secret|delta-secret/u,
      );
      assert.ok(error.ingestionError.message.length <= 512);
      return true;
    },
  );
});

// prove capability boundary stays narrow
test("U-OM-10 capability report is exact", () => {
  assert.deepEqual(openMeteoCapabilities(), ["current", "historical", "forecast"]);
});

// prove executable operations and safe endpoint selection
test("Open-Meteo operations default official and allow a safe compatibility origin", async () => {
  const current = await fixture("current.json");
  const archive = await fixture("archive-fall-back.json");
  const forecast = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const requests = [];
  const currentOperation = createOpenMeteoCurrentOperation();
  const forecastOperation = createOpenMeteoForecastOperation(
    "http://provider-stub:8080",
  );
  const historicalOperation = createOpenMeteoHistoricalOperation(
    "http://provider-stub:8080",
  );
  await currentOperation(location, {
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify(current), { status: 200 });
    },
    now: () => new Date(receivedAt),
  });
  await historicalOperation(
    { ...location, endDate: "2026-11-01", startDate: "2026-11-01" },
    {
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify(archive), { status: 200 });
      },
      now: () => new Date(receivedAt),
    },
  );
  await forecastOperation(location, {
    fetch: async (url) => {
      requests.push(String(url));
      const payload = new URL(url).pathname === "/v1/air-quality"
        ? airQuality
        : forecast;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    now: () => new Date(receivedAt),
  });

  assert.equal(new URL(requests[0]).origin, "https://api.open-meteo.com");
  assert.equal(
    new URL(requests[1]).origin + new URL(requests[1]).pathname,
    "http://provider-stub:8080/v1/archive",
  );
  assert.deepEqual(
    requests.slice(2).map((request) => new URL(request).pathname).sort(),
    ["/v1/air-quality", "/v1/forecast"],
  );
  assert.ok(
    requests.slice(2).every(
      (request) => new URL(request).origin === "http://provider-stub:8080",
    ),
  );
});

// reject unsafe compatibility origins
test("compatibility origin is credential-free and origin-only", () => {
  assert.equal(parseOpenMeteoCompatibilityOrigin(undefined), null);
  assert.equal(
    parseOpenMeteoCompatibilityOrigin("http://provider-stub:8080"),
    "http://provider-stub:8080",
  );

  // reject credentials paths queries fragments and non-http schemes
  for (const value of [
    "http://user:secret@provider-stub:8080",
    "http://provider-stub:8080/path",
    "http://provider-stub:8080?token=secret",
    "http://provider-stub:8080#fragment",
    "file:///tmp/provider",
  ]) {
    assert.throws(
      () => parseOpenMeteoCompatibilityOrigin(value),
      /credential-free HTTP origin/u,
    );
  }
});
