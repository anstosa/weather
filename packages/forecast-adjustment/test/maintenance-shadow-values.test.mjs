import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeMaintenanceBinary64,
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowSourceProjection,
  encodeMaintenanceShadowValues,
  MAINTENANCE_SHADOW_LIMITS,
  MAINTENANCE_SHADOW_SCHEMA_SHA256,
  MAINTENANCE_SHADOW_SOURCE_LIMITS,
  MAINTENANCE_SHADOW_SOURCE_VERSION,
  MAINTENANCE_SHADOW_VALUES_VERSION,
  parseMaintenanceShadowValues,
} from "../dist/maintenance-shadow-values.js";

// construct maximal-width legal strings and explicit inactive fallbacks
function body(family, issuedAt = "9999-11-01T18:35:00.000Z") {
  const hash = "f".repeat(64);
  const sourceRows = Array.from({ length: MAINTENANCE_SHADOW_LIMITS[family].rows },
    // retain one closed raw forecast row separately from prediction values
    (_, index) => {
      const validAt = new Date(Date.parse("9999-11-01T18:35:00.000Z") + (index + 1) * 3_600_000).toISOString();
      const common = {
        validAt,
        leadHours: index + 1,
        modelLeadHours: index + 7,
        referenceAt: new Date(Date.parse(validAt) - (index + 7) * 3_600_000).toISOString(),
        receivedAt: issuedAt,
        sourceSha256: hash,
        contentSha256: createHash("sha256").update(`${family}-source-${index}`).digest("hex"),
        adapterVersion: "open-meteo/v4",
        contractEpoch: "forecast/v4",
        dataset: "best_match",
        providerKey: "open-meteo",
        sourceKey: "open-meteo-forecast",
        sourceConfigFingerprint: "open-meteo-forecast/v4",
        upstreamModel: "best_match",
        revisionCount: 0,
      };
      // include only the exact family raw metric fields
      if (family === "temperature") {
        return {
          validAt,
          leadHours: index + 1,
          modelLeadHours: index + 7,
          referenceAt: common.referenceAt,
          receivedAt: issuedAt,
          sourceSha256: hash,
          contentSha256: common.contentSha256,
          adapterVersion: "open-meteo-ecmwf-single-run/v1",
          dataset: "single_run",
          providerKey: "open-meteo",
          providerResponseSha256: hash,
          modelCycle: "50r1",
          upstreamModel: "ecmwf_ifs",
          rawTemperatureC64: encodeMaintenanceBinary64(12),
          rawRelativeHumidityPercent64: encodeMaintenanceBinary64(80),
          rawWindSpeedMps64: encodeMaintenanceBinary64(5),
          bestMatchContentSha256: hash,
          bestMatchProductRunAt: common.referenceAt,
          bestMatchSourceId: "7",
          bestMatchTemperatureC64: encodeMaintenanceBinary64(13),
        };
      }
      if (family === "wind") {
        return { ...common, windSpeedMps64: encodeMaintenanceBinary64(8), windGustMps64: encodeMaintenanceBinary64(12) };
      }
      return { ...common, precipitationMm64: encodeMaintenanceBinary64(2) };
    });
  const sourceProjection = {
    contractVersion: MAINTENANCE_SHADOW_SOURCE_VERSION,
    family,
    registrationSha256: hash,
    candidateSha256: hash,
    sourceSha256: hash,
    dueKey: "capture/9999-11-01T18:35:00.000Z",
    issuedAt,
    rowCount: sourceRows.length,
    rows: sourceRows,
  };
  // retain the exact rolling state consumed by temperature inference
  if (family === "temperature") {
    sourceProjection.recentErrorState = {
      b24C: 0.2,
      b72C: 0.1,
      cohort: "ecmwf_single_run_hindcast",
      localDates: 3,
      mad72C: 0.5,
      maximumSourceRunInitializedAt: "9999-11-01T06:00:00.000Z",
      maximumSourceValidAt: "9999-11-01T17:00:00.000Z",
      n24: 12,
      n72: 36,
      sourceKeys: ["source-1"],
      supported: true,
      targetRunInitializedAt: "9999-11-01T12:00:00.000Z",
      windowEndValidAt: "9999-11-01T17:00:00.000Z",
    };
  }
  // retain a complete closed compiled-input graph for rain
  if (family === "rain") {
    const captureHash = createHash("sha256").update("rain-current").digest("hex");
    sourceProjection.causalInputs = {
      contractVersion: "adjustment-shadow-rain-causal-inputs/v1",
      captureSet: [{ claimId: "rain-current", kind: "forecast", stationId: null,
        runInitializedAt: "9999-11-01T12:00:00.000Z", windowStart: null,
        windowEndExclusive: null, completedAt: issuedAt, bodySha256: captureHash }],
      currentRun: { runInitializedAt: "9999-11-01T12:00:00.000Z", completedAt: issuedAt,
        contentSha256: captureHash, hours: Array.from({ length: 48 }, (_, index) => ({
          leadHours: index + 1, precipitationMm64: encodeMaintenanceBinary64(2),
          temperatureC64: encodeMaintenanceBinary64(12),
          relativeHumidityPercent64: encodeMaintenanceBinary64(80),
          cloudCoverPercent64: encodeMaintenanceBinary64(50),
          pressureHpa64: encodeMaintenanceBinary64(1000),
          windSpeedMps64: encodeMaintenanceBinary64(5),
          windDirectionDegrees64: encodeMaintenanceBinary64(180),
        })) },
      priorRuns: [],
      stationHours: [],
    };
  }
  const sourceBytes = encodeMaintenanceShadowSourceProjection(sourceProjection);
  const identity = createMaintenanceShadowSourceIdentity(sourceBytes);
  const rows = Array.from({ length: MAINTENANCE_SHADOW_LIMITS[family].rows },
    // include every permitted lead without enabling a shadow
    (_, index) => {
      const common = { validAt: new Date(Date.parse("9999-11-01T18:35:00.000Z") + (index + 1) * 3_600_000).toISOString(),
        leadHours: index + 1, sourceRowSha256: identity.sourceRowSha256[index] };
      // preserve the fixed family row schema
      if (family === "temperature") {
        return { ...common, candidateTemperatureC64: encodeMaintenanceBinary64(-100),
          wouldApply: false, fallbackCode: "model_unavailable" };
      }
      // the disabled gust interval must remain null even in worst-case bodies
      if (family === "wind") {
        return { ...common, candidateSpeedMps64: encodeMaintenanceBinary64(150),
          candidateGustMps64: index >= 48 && index < 72 ? null : encodeMaintenanceBinary64(150),
          speedWouldApply: false, gustWouldApply: false };
      }
      return { ...common, occurrenceProbability64: encodeMaintenanceBinary64(1),
        positiveAmountMm64: encodeMaintenanceBinary64(30), candidatePrecipitationMm64: encodeMaintenanceBinary64(30),
        atLeast1_0Probability64: encodeMaintenanceBinary64(1), atLeast2_5Probability64: encodeMaintenanceBinary64(1),
        wouldApply: false, fallbackCode: "model_unavailable" };
    });
  const value = { contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION, family, registrationSha256: hash,
    candidateSha256: hash, sourceSha256: hash, dueKey: "capture/9999-11-01T18:35:00.000Z",
    issuedAt, sourceReceiptSha256: identity.sourceReceiptSha256,
    inputSha256: identity.inputSha256, rowCount: rows.length, rows };
  return { sourceBytes, value };
}

// encoded magnitudes do not change the fixed binary64 width
test("shadow binary64 preserves signed zero and rejects nonfinite or decimal aliases", () => {
  assert.equal(encodeMaintenanceBinary64(1), "3ff0000000000000");
  assert.ok(Object.is(decodeMaintenanceBinary64(encodeMaintenanceBinary64(-0)), -0));
  // reject every forbidden numeric representation
  for (const value of [NaN, Infinity, -Infinity, "1.0"]) {
    assert.throws(() => encodeMaintenanceBinary64(value));
  }
  // exponent, uppercase, infinity and nan are not wire values
  for (const value of ["1e0", "3FF0000000000000", "7ff0000000000000", "7ff8000000000000"]) {
    assert.throws(() => decodeMaintenanceBinary64(value));
  }
});

// legal maximal strings fit without compression or empirical-size credit
test("all three maximal shadow bodies stay within their frozen byte and row ceilings", () => {
  let dailyMaximum = 0;
  let combinedCycleMaximum = 0;
  // prove each full family independently
  for (const family of Object.keys(MAINTENANCE_SHADOW_LIMITS)) {
    const { value, sourceBytes } = body(family);
    const bytes = encodeMaintenanceShadowValues(value, sourceBytes);
    assert.ok(bytes.length <= MAINTENANCE_SHADOW_LIMITS[family].bytes);
    assert.deepEqual(parseMaintenanceShadowValues(bytes), value);
    assert.match(MAINTENANCE_SHADOW_SCHEMA_SHA256[family], /^[a-f0-9]{64}$/u);
    dailyMaximum += 4 * MAINTENANCE_SHADOW_LIMITS[family].bytes;
    combinedCycleMaximum += MAINTENANCE_SHADOW_LIMITS[family].bytes +
      MAINTENANCE_SHADOW_SOURCE_LIMITS[family].bytes;
  }
  assert.equal(dailyMaximum, 336 * 1_024);
  assert.ok(combinedCycleMaximum <= 4_832 * 1_024);
});

// parsing cannot normalize an alternate body into an acknowledged identity
test("shadow parsing rejects duplicate keys, alternate ordering, numeric fields and bad utf8", () => {
  const { value, sourceBytes } = body("temperature");
  const bytes = encodeMaintenanceShadowValues(value, sourceBytes);
  const duplicate = bytes.toString().replace('"family":"temperature"', '"family":"temperature","family":"temperature"');
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(duplicate)));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(JSON.stringify(value))));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(JSON.stringify({ family: value.family, ...value }) + "\n")));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from([0xc0, 0x80])));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.alloc(65_537)));
  value.rows[0].candidateTemperatureC64 = 12;
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
});

// metadata admission must not acquire a late or missing prediction
test("shadow bodies reject missing leads, clock normalization, late issue and row mutation", () => {
  // isolate each closed-boundary violation
  for (const mutate of [
    // remove one required lead
    (value) => { value.rows.pop(); },
    // duplicate a lead
    (value) => { value.rows[1].leadHours = 1; },
    // preserve explicit late prediction failure
    (value) => { value.rows[0].validAt = value.issuedAt; },
    // reject alternate timestamp representation
    (value) => { value.issuedAt = "9999-11-01T18:35:00Z"; },
    // reject unknown row fields
    (value) => { value.rows[0].target = 12; },
    // distinguish fallback from successful model application
    (value) => { value.rows[0].wouldApply = true; },
  ]) {
    const { value, sourceBytes } = body("temperature");
    mutate(value);
    assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
  }
});

// the disabled gust pair and absent direction cannot be introduced by a body
test("wind shadows cannot enable gust49–72 or include direction", () => {
  const { value, sourceBytes } = body("wind");
  value.rows[48].candidateGustMps64 = encodeMaintenanceBinary64(5);
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
  value.rows[48].candidateGustMps64 = null;
  value.rows[48].gustWouldApply = true;
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
  value.rows[48].gustWouldApply = false;
  value.rows[0].candidateDirectionDegrees64 = encodeMaintenanceBinary64(90);
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
});

// retain all native heads before outcomes rather than reconstructing them later
test("rain shadows require all three finite threshold probabilities before valid time", () => {
  const { value, sourceBytes } = body("rain");
  // probability nesting is a qualification gate, not an evidence-omission filter
  value.rows[0].occurrenceProbability64 = encodeMaintenanceBinary64(.2);
  value.rows[0].atLeast1_0Probability64 = encodeMaintenanceBinary64(.4);
  value.rows[0].atLeast2_5Probability64 = encodeMaintenanceBinary64(.3);
  assert.equal(parseMaintenanceShadowValues(encodeMaintenanceShadowValues(value, sourceBytes)).rows[0].atLeast1_0Probability64,
    encodeMaintenanceBinary64(.4));
  delete value.rows[0].atLeast2_5Probability64;
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes));
});

// compact database rows never carry candidate or observation values
test("shadow metadata binds exact staged bytes and an independent jittered issue clock", () => {
  const { value, sourceBytes } = body("temperature", "9999-11-01T18:37:09.123Z");
  const bytes = encodeMaintenanceShadowValues(value, sourceBytes);
  const metadata = createMaintenanceShadowPredictionMetadata(bytes, sourceBytes);
  assert.equal(metadata.issuedAt, value.issuedAt);
  assert.equal(metadata.dueKey, value.dueKey);
  assert.equal(metadata.predictionBodySha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(metadata.predictionSchemaSha256, MAINTENANCE_SHADOW_SCHEMA_SHA256.temperature);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 2_048);
  assert.deepEqual(Object.keys(metadata), ["bodyByteCount", "candidateSha256", "dueKey", "inputSha256", "issuedAt", "maxValidAt",
    "minValidAt", "predictionBodySha256", "predictionSchemaSha256", "predictionSha256",
    "registrationSha256", "rowCount", "sourceReceiptSha256", "sourceSha256"]);
  const joined = ["adjustment-shadow-prediction/v3", metadata.registrationSha256, metadata.candidateSha256,
    metadata.sourceSha256, metadata.dueKey,
    value.issuedAt, metadata.minValidAt, metadata.maxValidAt, metadata.sourceReceiptSha256, metadata.inputSha256,
    metadata.predictionBodySha256, metadata.predictionSchemaSha256, "12", String(bytes.length)].join("\n");
  assert.equal(metadata.predictionSha256, createHash("sha256").update(joined).digest("hex"));
  value.rows[0].candidateTemperatureC64 = encodeMaintenanceBinary64(-99);
  const revised = createMaintenanceShadowPredictionMetadata(encodeMaintenanceShadowValues(value, sourceBytes), sourceBytes);
  assert.notEqual(revised.predictionSha256, metadata.predictionSha256);
});

// source identities cannot be supplied independently from closed raw rows
test("shadow source projection binds candidate, source, geometry and closed raw rows", () => {
  const { value, sourceBytes } = body("temperature");
  const source = JSON.parse(sourceBytes);
  source.rows[0].rawTemperatureC64 = encodeMaintenanceBinary64(13);
  const revisedSource = encodeMaintenanceShadowSourceProjection(source);
  assert.throws(() => encodeMaintenanceShadowValues(value, revisedSource), /binding|header/u);
  value.sourceSha256 = "a".repeat(64);
  assert.throws(() => encodeMaintenanceShadowValues(value, sourceBytes), /header/u);
  source.rows[0].privateToken = "not allowed";
  assert.throws(() => encodeMaintenanceShadowSourceProjection(source), /fields/u);
});

// comparator identity must remain causal and native-addressable
test("temperature shadow source requires exact comparator source and run clocks", () => {
  for (const mutate of [
    // reject an absent source identity
    (row) => { row.bestMatchSourceId = null; },
    // reject a noncanonical database identity
    (row) => { row.bestMatchSourceId = "07"; },
    // reject an upstream initialization after the source decision
    (row, source) => { row.bestMatchProductRunAt = source.rows[0].validAt; },
  ]) {
    const { sourceBytes } = body("temperature");
    const source = JSON.parse(sourceBytes);
    mutate(source.rows[0], source);
    assert.throws(() => encodeMaintenanceShadowSourceProjection(source));
  }
});
