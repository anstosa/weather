import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ProviderFailure,
  buildTempestObservationRequest,
  createTempestObservationOperation,
  normalizeTempestObservationPayload,
  resolveTempestStation,
} from "../dist/index.js";

const credential = "test-api-key";
const request = {
  apiKey: credential,
  deviceId: 470937,
  endExclusive: "2026-08-20T02:00:00.000Z",
  locationId: 203055,
  serial: "ST-00198967",
  sourceId: "source-tempest",
  start: "2026-08-20T00:00:00.000Z",
  timezone: "America/Los_Angeles",
};
const receivedAt = "2026-08-22T21:00:00.000Z";

// load one checked Tempest fixture
async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/tempest/${name}`, import.meta.url), "utf8"),
  );
}

// prove the inclusive provider boundary stays half-open internally
test("Tempest request uses an inclusive end one second before the window", () => {
  const plan = buildTempestObservationRequest(request);

  assert.equal(plan.sourceKind, "physical_sensor");
  assert.equal(plan.adapterVersion, "tempest-observations-minute/v1");
  assert.equal(plan.url.searchParams.get("time_start"), "1787184000");
  assert.equal(plan.url.searchParams.get("time_end"), "1787191199");
  assert.equal(plan.url.searchParams.get("api_key"), credential);
  assert.throws(
    () =>
      buildTempestObservationRequest({
        ...request,
        endExclusive: "2026-08-26T00:00:00.000Z",
      }),
    /at most one day/u,
  );
});

// normalize every distinct provider observation
test("Tempest obs_st rows preserve one-minute resolution", async () => {
  const records = normalizeTempestObservationPayload(
    await fixture("observations.json"),
    request,
    receivedAt,
  );

  assert.equal(records.length, 3);
  assert.equal(records[0].sourceKind, "physical_sensor");
  assert.equal(records[0].validAt, "2026-08-20T00:00:00.000Z");
  assert.equal(records[0].metrics.temperatureC, 24.5);
  assert.equal(records[0].metrics.precipitationMm, 0.2);
  assert.equal(records[0].metrics.precipitationRateMmPerHour, 12);
  assert.equal(records[0].metrics.windDirectionDegrees, 0);
  assert.equal(records[0].metrics.solarRadiationWm2, 193);
  assert.equal(records[0].metrics.uvIndex, 1.54);
  assert.deepEqual(records[0].metadata.device, {
    model: "Tempest",
    serial: "ST-00198967",
    vendor: "WeatherFlow",
  });
  assert.equal(records[0].metadata.provider.illuminance_lux, 23157);
  assert.equal(records[1].validAt, "2026-08-20T00:01:00.000Z");
  assert.equal(records[2].validAt, "2026-08-20T01:00:00.000Z");
  assert.equal(
    records[1].metadata.quality.sampling,
    "every_distinct_provider_observation",
  );

  // collapse only exact duplicate timestamps
  const duplicate = await fixture("observations.json");
  duplicate.obs.push([...duplicate.obs[1]]);
  assert.equal(
    normalizeTempestObservationPayload(duplicate, request, receivedAt).length,
    3,
  );

  // retain rows with impossible UV readings
  const invalidUv = await fixture("observations.json");
  invalidUv.obs[0][10] = 20.01;
  const invalidUvRecords = normalizeTempestObservationPayload(
    invalidUv,
    request,
    receivedAt,
  );
  assert.equal(invalidUvRecords[0].metrics.uvIndex, null);
  assert.deepEqual(invalidUvRecords[0].metadata.quality.flags, [
    "uv_index_out_of_range",
  ]);
});

// resolve only the ST weather device
test("Tempest location resolution ignores the HB hub", async () => {
  const payload = await fixture("location.json");
  const station = await resolveTempestStation(
    { apiKey: credential, locationId: 203055 },
    {
      // inspect the public endpoint headers
      fetch: async (_input, initialization) => {
        const headers = new Headers(initialization.headers);
        assert.equal(headers.get("origin"), "https://tempestwx.com");
        assert.match(headers.get("user-agent"), /Firefox\/128/u);
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    },
  );

  assert.deepEqual(station, {
    deviceId: 470937,
    displayName: "Quade Rd",
    latitude: 47.96505,
    locationId: 203055,
    longitude: -122.4241,
    serial: "ST-00198967",
    timezone: "America/Los_Angeles",
  });
});

// execute the credential-bound operation
test("Tempest operation returns bounded batch metadata", async () => {
  const payload = await fixture("observations.json");
  const operation = createTempestObservationOperation(credential);
  const batch = await operation(request, {
    fetch: async () => new Response(JSON.stringify(payload), { status: 200 }),
    now: () => new Date(receivedAt),
  });

  assert.equal(batch.records.length, 3);
  assert.equal(batch.responseMetadata.raw_observation_count, 3);
  assert.equal(batch.responseMetadata.minute_record_count, 3);
  assert.deepEqual(batch.providerCursor, {
    valid_at: "2026-08-20T01:00:00.000Z",
  });

  // execute the no-data operation
  const gap = await fixture("observations.json");
  gap.obs = null;
  const emptyBatch = await operation(request, {
    fetch: async () => new Response(JSON.stringify(gap), { status: 200 }),
    now: () => new Date(receivedAt),
  });
  assert.deepEqual(emptyBatch.records, []);
  assert.equal(emptyBatch.responseMetadata.raw_observation_count, 0);
  assert.equal(emptyBatch.responseMetadata.minute_record_count, 0);
  assert.equal(emptyBatch.providerCursor, null);
});

// reject provider-level and shape failures
test("Tempest payload validation fails closed", async () => {
  const rejected = await fixture("observations.json");
  rejected.status.status_code = 4;
  assert.throws(
    () => normalizeTempestObservationPayload(rejected, request, receivedAt),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_request_rejected",
  );

  const malformed = await fixture("observations.json");
  malformed.obs[0] = malformed.obs[0].slice(0, 10);
  assert.throws(
    () => normalizeTempestObservationPayload(malformed, request, receivedAt),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "invalid_payload",
  );
});

// accept legitimate observation gaps
test("Tempest payload validation accepts an empty successful range", async () => {
  const empty = await fixture("observations.json");
  empty.obs = [];
  assert.deepEqual(
    normalizeTempestObservationPayload(empty, request, receivedAt),
    [],
  );

  const nullGap = await fixture("observations.json");
  nullGap.obs = null;
  assert.deepEqual(
    normalizeTempestObservationPayload(nullGap, request, receivedAt),
    [],
  );
});
