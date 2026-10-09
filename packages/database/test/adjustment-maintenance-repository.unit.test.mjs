import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRainAdjustmentShadow,
  appendTemperatureAdjustmentShadow,
  appendWindAdjustmentShadow,
  authorizeTrainingAdjustmentConfirmationChunk,
  isAdjustmentShadowBodyAdmitted,
  readAdjustmentShadowRevisionAdmission,
  readAdjustmentShadowRegistrationSlot,
  readTrainingAdjustmentConfirmationAvailability,
  registerApiAdjustmentShadow,
  registerRainAdjustmentShadow,
} from "../dist/index.js";
import * as database from "../dist/index.js";

const HASHES = Object.freeze({
  rain: "c7ae2f750f13970137b1b2d885f7cce81b8ecbc2720635c6716f005bc04a5e25",
  temperature: "4255feacfd464adf2cbbf1139ecdf30d9d00b847775c556407367ad1449d9e63",
  wind: "3f573c3e49ed3b97636674b0630e49508cf80533ff8edc8f31f6f0411f70d902",
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

// create one future-only rolling registration fixture
function rollingRegistration(family = "temperature") {
  return {
    ...registration(family),
    epochWitnessSha256: "2".repeat(64),
    predecessorRegistrationSha256: null,
    scheduleContractSha256: "3".repeat(64),
  };
}

// create one jittered compact prediction fixture
function prediction(family = "temperature") {
  return {
    bodyByteCount: family === "wind" ? 65_536 : family === "rain" ? 12_288 : 8_192,
    candidateSha256: "b".repeat(64),
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
    sourceSha256: "1".repeat(64),
    stageReceiptSha256: "6".repeat(64),
  };
}

// create one authoritative revision receipt fixture
function revisionReceipt(overrides = {}) {
  return {
    archiveCommitOrdinal: "1",
    archiveCommittedAt: "2026-10-07T03:01:00.000Z",
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "7".repeat(64),
    predecessorFrontierSha256: "8".repeat(64),
    projectionIdentitySha256: "5".repeat(64),
    projectionKind: "shadow_prediction",
    projectionSha256: "2".repeat(64),
    receiptSha256: "9".repeat(64),
    stageReceiptSha256: "6".repeat(64),
    ...overrides,
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
  const rollingBoundary = queryBoundary({
    inserted: true,
    registrationSha256: "e".repeat(64),
  });
  await registerApiAdjustmentShadow(rollingBoundary, rollingRegistration());
  assert.match(rollingBoundary.calls[0].text,
    /weather_register_adjustment_shadow_v3\(\$1::jsonb\)/u);
  assert.deepEqual(
    Object.keys(JSON.parse(rollingBoundary.calls[0].values[0])),
    Object.keys(rollingRegistration()).sort(),
  );

  const appendBoundary = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789Z",
    inserted: true,
    predictionSha256: "4".repeat(64),
    revisionReceipt: revisionReceipt(),
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
    revisionReceipt: revisionReceipt(),
  });
  await appendRainAdjustmentShadow(rainBoundary, prediction("rain"));
  assert.match(rainBoundary.calls[0].text, /weather_append_adjustment_rain_shadow_v2/u);
  const windBoundary = queryBoundary({
    committedAt: "2026-10-08T12:34:56.789Z",
    inserted: false,
    predictionSha256: "4".repeat(64),
    revisionReceipt: revisionReceipt(),
  });
  await appendWindAdjustmentShadow(windBoundary, prediction("wind"));
  assert.match(windBoundary.calls[0].text, /weather_append_adjustment_wind_shadow_v2/u);
});

test("registration slot reads stay closed and family-bound", async () => {
  const value = {
    contractVersion: "adjustment-shadow-registration-slot/v3",
    epochWitnessSha256: "1".repeat(64),
    family: "temperature",
    horizonEndAt: "2029-03-01T08:00:00.000Z",
    registrationSha256: null,
    scheduleContractSha256: "2".repeat(64),
    state: "free",
    terminalAt: null,
  };
  const boundary = queryBoundary(value);
  assert.deepEqual(await readAdjustmentShadowRegistrationSlot(boundary, "temperature"), value);
  assert.match(boundary.calls[0].text,
    /adjustment_shadow_registration_slot_v3\(\$1::text\)/u);
  await assert.rejects(
    readAdjustmentShadowRegistrationSlot(queryBoundary({
      ...value,
      registrationSha256: "3".repeat(64),
    }), "temperature"),
    /free slot differs/u,
  );
});

// reject aliases, wrong families, clock drift, limits, and malformed receipts
test("adjustment maintenance repositories reject unclosed metadata", async () => {
  const boundary = queryBoundary({ inserted: true, registrationSha256: "e".repeat(64) });
  await assert.rejects(
    registerApiAdjustmentShadow(boundary, { ...registration(), extra: true }),
    /closed object/u,
  );
  await assert.rejects(
    registerApiAdjustmentShadow(boundary, {
      ...registration(),
      epochWitnessSha256: "2".repeat(64),
    }),
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
    appendTemperatureAdjustmentShadow(boundary, { ...prediction(), rowCount: 11 }),
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
    revisionReceipt: revisionReceipt(),
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

// verify revision admission returns only the persisted closed receipt
test("adjustment revision admission returns one exact persisted receipt", async () => {
  const boundary = queryBoundary(revisionReceipt());
  assert.deepEqual(await readAdjustmentShadowRevisionAdmission(
    boundary,
    "e".repeat(64),
    "capture/2027-12-31T18:35:00.000Z",
    "3".repeat(64),
    8_192,
  ), revisionReceipt());
  assert.match(boundary.calls[0].text, /adjustment_shadow_revision_admission_v1/u);
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
