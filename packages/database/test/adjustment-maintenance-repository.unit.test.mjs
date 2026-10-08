import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRainAdjustmentShadow,
  appendTemperatureAdjustmentShadow,
  appendWindAdjustmentShadow,
  authorizeTrainingAdjustmentConfirmationChunk,
  isAdjustmentShadowBodyAdmitted,
  readTrainingAdjustmentConfirmationAvailability,
  registerApiAdjustmentShadow,
  registerRainAdjustmentShadow,
} from "../dist/index.js";
import * as database from "../dist/index.js";

const HASHES = Object.freeze({
  rain: "5c07000d56ce21824aa545ebb10405dd80ba7c35368397128aa65c4fb799dd46",
  temperature: "eb9930a1e12919d6f35feb2d402b87b336859b24f031f0e2e3d99168716dc0cd",
  wind: "965272030594b887edf45c62c805f909d148c497d57e803010b6148b25d964d0",
});

// create one recording query boundary
function queryBoundary(value) {
  const calls = [];
  return {
    calls,
    // record one parameterized repository query
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ value }], rowCount: 1 };
    },
  };
}

// create one valid registration fixture
function registration(family = "temperature") {
  return {
    artifactSha256: "a".repeat(64),
    candidateSha256: "b".repeat(64),
    cohortSha256: "c".repeat(64),
    family,
    intervalEndAt: "2029-01-01T08:00:00.000Z",
    intervalStartAt: "2028-01-01T08:00:00.000Z",
    policySha256: "d".repeat(64),
    registrationSha256: "e".repeat(64),
    reservedKeySha256: "f".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "1".repeat(64),
    targetCutoffAt: "2029-01-08T08:00:00.000Z",
    terminalAt: "2029-01-08T08:00:00.000Z",
  };
}

// create one jittered compact prediction fixture
function prediction(family = "temperature") {
  return {
    bodyByteCount: family === "wind" ? 65_536 : family === "rain" ? 12_288 : 8_192,
    dueKey: "capture/2027-12-31T18:35:00.000Z",
    inputSha256: "2".repeat(64),
    issuedAt: "2027-12-31T18:40:00.123Z",
    maxValidAt: "2028-01-01T19:00:00.000Z",
    minValidAt: "2028-01-01T08:00:00.000Z",
    predictionBodySha256: "3".repeat(64),
    predictionSchemaSha256: HASHES[family],
    predictionSha256: "4".repeat(64),
    registrationSha256: "e".repeat(64),
    rowCount: family === "wind" ? 168 : family === "rain" ? 23 : 12,
    sourceReceiptSha256: "5".repeat(64),
  };
}

// verify role-shaped registration and append calls stay closed and parameterized
test("adjustment maintenance repositories call only closed functions", async () => {
  const registrationBoundary = queryBoundary({
    inserted: true,
    registrationSha256: "e".repeat(64),
  });
  assert.deepEqual(
    await registerApiAdjustmentShadow(registrationBoundary, registration()),
    { inserted: true, registrationSha256: "e".repeat(64) },
  );
  const registrationCall = registrationBoundary.calls[0];
  assert.match(registrationCall.text, /weather_register_adjustment_shadow_v2\(\$1::jsonb\)/u);
  assert.equal(registrationCall.values.length, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(registrationCall.values[0])),
    Object.keys(registration()).sort(),
  );

  const appendBoundary = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789Z",
    inserted: true,
    predictionSha256: "4".repeat(64),
  });
  const appended = await appendTemperatureAdjustmentShadow(
    appendBoundary,
    prediction(),
  );
  assert.equal(appended.committedAt, "2026-10-08T12:34:56.789Z");
  assert.match(
    appendBoundary.calls[0].text,
    /weather_append_adjustment_temperature_shadow_v2\(\$1::jsonb\)/u,
  );
  assert.equal(appendBoundary.calls[0].values.length, 1);
  assert.doesNotMatch(appendBoundary.calls[0].text, /\b(?:INSERT|UPDATE|DELETE)\b/u);

  const rainBoundary = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789Z",
    inserted: true,
    predictionSha256: "4".repeat(64),
  });
  await appendRainAdjustmentShadow(rainBoundary, prediction("rain"));
  assert.match(rainBoundary.calls[0].text, /weather_append_adjustment_rain_shadow_v2/u);
  const windBoundary = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789Z",
    inserted: false,
    predictionSha256: "4".repeat(64),
  });
  await appendWindAdjustmentShadow(windBoundary, prediction("wind"));
  assert.match(windBoundary.calls[0].text, /weather_append_adjustment_wind_shadow_v2/u);
});

// reject aliases, wrong families, clock drift, limits, and malformed receipts
test("adjustment maintenance repositories reject unclosed metadata", async () => {
  const boundary = queryBoundary({ inserted: true, registrationSha256: "e".repeat(64) });
  await assert.rejects(
    registerApiAdjustmentShadow(boundary, { ...registration(), extra: true }),
    /closed object/u,
  );
  await assert.rejects(
    registerRainAdjustmentShadow(boundary, registration("temperature")),
    /family/u,
  );
  await assert.rejects(
    appendTemperatureAdjustmentShadow(boundary, {
      ...prediction(),
      issuedAt: "2027-12-31T18:40:00.123+00:00",
    }),
    /canonical UTC milliseconds/u,
  );
  await assert.rejects(
    appendTemperatureAdjustmentShadow(boundary, {
      ...prediction(),
      issuedAt: "2028-01-01T07:00:00.001Z",
    }),
    /due window/u,
  );
  await assert.rejects(
    appendTemperatureAdjustmentShadow(boundary, { ...prediction(), rowCount: 13 }),
    /row count/u,
  );
  await assert.rejects(
    appendTemperatureAdjustmentShadow(boundary, {
      ...prediction(),
      predictionSchemaSha256: HASHES.rain,
    }),
    /schema/u,
  );
  const malformed = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789123Z",
    inserted: true,
    predictionSha256: "4".repeat(64),
  });
  await assert.rejects(
    appendTemperatureAdjustmentShadow(malformed, prediction()),
    /canonical UTC milliseconds/u,
  );
  assert.equal(boundary.calls.length, 0);
});

// verify scalar body admission remains exact and non-enumerating
test("adjustment body admission returns only one boolean", async () => {
  const boundary = {
    calls: [],
    // return one scalar admission row
    async query(text, values) {
      this.calls.push({ text, values });
      return { rows: [{ admitted: true }], rowCount: 1 };
    },
  };
  assert.equal(await isAdjustmentShadowBodyAdmitted(
    boundary,
    "e".repeat(64),
    "capture/2027-12-31T18:35:00.000Z",
    "3".repeat(64),
    8_192,
  ), true);
  assert.match(boundary.calls[0].text, /adjustment_shadow_body_admission_v2/u);
  assert.deepEqual(boundary.calls[0].values, [
    "e".repeat(64),
    "capture/2027-12-31T18:35:00.000Z",
    "3".repeat(64),
    8_192,
  ]);
});

// verify training reads accept only bounded value-free documents
test("adjustment training repositories validate availability and chunk authorization", async () => {
  const availability = {
    contractVersion: "adjustment-confirmation-availability/v2",
    expectedKeySetSha256: "f".repeat(64),
    family: "temperature",
    finalizedMetadataRootSha256: "6".repeat(64),
    finalizedPredictionCount: 0,
    finalizedThroughAt: null,
    hotPredictionCount: 1,
    hotPredictions: [{
      dueKey: "capture/2027-12-31T18:35:00.000Z",
      maxValidAt: "2028-01-01T19:00:00.000Z",
      minValidAt: "2028-01-01T08:00:00.000Z",
      predictionSha256: "4".repeat(64),
      rowCount: 12,
    }],
    hotSetRootSha256: "7".repeat(64),
    intervalEndAt: "2029-01-01T08:00:00.000Z",
    intervalStartAt: "2028-01-01T08:00:00.000Z",
    metadataGeneration: 0,
    missingExpectedDueKeys: null,
    missingExpectedDueKeysStatus: "requires_anchored_cold_reconstruction",
    registrationSha256: "e".repeat(64),
    targetCutoffAt: "2029-01-08T08:00:00.000Z",
  };
  const availabilityBoundary = queryBoundary(availability);
  assert.deepEqual(
    await readTrainingAdjustmentConfirmationAvailability(
      availabilityBoundary,
      "e".repeat(64),
    ),
    availability,
  );
  assert.match(availabilityBoundary.calls[0].text, /adjustment_confirmation_availability_v2/u);

  const authorization = {
    accessSha256: "8".repeat(64),
    chunkCount: 27,
    chunkIndex: 0,
    contractVersion: "adjustment-confirmation-export-authorization/v2",
    eligiblePredictionSetSha256: "9".repeat(64),
    expectedKeySetSha256: "f".repeat(64),
    family: "temperature",
    fromLocalDate: "2028-01-01",
    metadataRootSha256: "a".repeat(64),
    registrationSha256: "e".repeat(64),
    revisionCatalogWatermarkSha256: "b".repeat(64),
    targetComparatorSnapshotRootSha256: "c".repeat(64),
    targetCutoffAt: "2029-01-08T08:00:00.000Z",
    toLocalDateExclusive: "2028-01-15",
  };
  const authorizationBoundary = queryBoundary(authorization);
  assert.deepEqual(await authorizeTrainingAdjustmentConfirmationChunk(
    authorizationBoundary,
    "e".repeat(64),
    "8".repeat(64),
    0,
  ), authorization);
  assert.match(authorizationBoundary.calls[0].text, /adjustment_confirmation_export_v2/u);
  assert.deepEqual(authorizationBoundary.calls[0].values, [
    "e".repeat(64),
    "8".repeat(64),
    0,
  ]);

  const disclosed = queryBoundary({ ...availability, candidateValue: 1 });
  await assert.rejects(
    readTrainingAdjustmentConfirmationAvailability(disclosed, "e".repeat(64)),
    /closed object/u,
  );
  assert.equal("finalizeAdjustmentShadowMetadata" in database, false);
  assert.equal("recordAdjustmentConfirmationAccess" in database, false);
});
