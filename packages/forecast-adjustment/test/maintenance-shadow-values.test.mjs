import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeMaintenanceBinary64,
  createMaintenanceShadowPredictionMetadata,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowValues,
  MAINTENANCE_SHADOW_LIMITS,
  MAINTENANCE_SHADOW_SCHEMA_SHA256,
  MAINTENANCE_SHADOW_VALUES_VERSION,
  parseMaintenanceShadowValues,
} from "../dist/maintenance-shadow-values.js";

// construct maximal-width legal strings and explicit inactive fallbacks
function body(family) {
  const hash = "f".repeat(64);
  const rows = Array.from({ length: MAINTENANCE_SHADOW_LIMITS[family].rows },
    // include every permitted lead without enabling a shadow
    (_, index) => {
      const common = { validAt: new Date(Date.parse("9999-11-01T18:35:00.000Z") + (index + 1) * 3_600_000).toISOString(),
        leadHours: index + 1, sourceRowSha256: hash };
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
  return { contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION, family, registrationSha256: hash,
    candidateSha256: hash, dueKey: "capture/9999-11-01T18:35:00.000Z", issuedAt: "9999-11-01T18:35:00.000Z",
    sourceReceiptSha256: hash, inputSha256: hash, rowCount: rows.length, rows };
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
  // prove each full family independently
  for (const family of Object.keys(MAINTENANCE_SHADOW_LIMITS)) {
    const value = body(family);
    const bytes = encodeMaintenanceShadowValues(value);
    assert.ok(bytes.length <= MAINTENANCE_SHADOW_LIMITS[family].bytes);
    assert.deepEqual(parseMaintenanceShadowValues(bytes), value);
    assert.match(MAINTENANCE_SHADOW_SCHEMA_SHA256[family], /^[a-f0-9]{64}$/u);
    dailyMaximum += 4 * MAINTENANCE_SHADOW_LIMITS[family].bytes;
  }
  assert.equal(dailyMaximum, 336 * 1_024);
});

// parsing cannot normalize an alternate body into an acknowledged identity
test("shadow parsing rejects duplicate keys, alternate ordering, numeric fields and bad utf8", () => {
  const value = body("temperature");
  const bytes = encodeMaintenanceShadowValues(value);
  const duplicate = bytes.toString().replace('"family":"temperature"', '"family":"temperature","family":"temperature"');
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(duplicate)));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(JSON.stringify(value))));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from(JSON.stringify({ family: value.family, ...value }) + "\n")));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.from([0xc0, 0x80])));
  assert.throws(() => parseMaintenanceShadowValues(Buffer.alloc(65_537)));
  value.rows[0].candidateTemperatureC64 = 12;
  assert.throws(() => encodeMaintenanceShadowValues(value));
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
    const value = body("temperature");
    mutate(value);
    assert.throws(() => encodeMaintenanceShadowValues(value));
  }
});

// the disabled gust pair and absent direction cannot be introduced by a body
test("wind shadows cannot enable gust49–72 or include direction", () => {
  const value = body("wind");
  value.rows[48].candidateGustMps64 = encodeMaintenanceBinary64(5);
  assert.throws(() => encodeMaintenanceShadowValues(value));
  value.rows[48].candidateGustMps64 = null;
  value.rows[48].gustWouldApply = true;
  assert.throws(() => encodeMaintenanceShadowValues(value));
  value.rows[48].gustWouldApply = false;
  value.rows[0].candidateDirectionDegrees64 = encodeMaintenanceBinary64(90);
  assert.throws(() => encodeMaintenanceShadowValues(value));
});

// retain all native heads before outcomes rather than reconstructing them later
test("rain shadows require all three finite threshold probabilities before valid time", () => {
  const value = body("rain");
  // probability nesting is a qualification gate, not an evidence-omission filter
  value.rows[0].occurrenceProbability64 = encodeMaintenanceBinary64(.2);
  value.rows[0].atLeast1_0Probability64 = encodeMaintenanceBinary64(.4);
  value.rows[0].atLeast2_5Probability64 = encodeMaintenanceBinary64(.3);
  assert.equal(parseMaintenanceShadowValues(encodeMaintenanceShadowValues(value)).rows[0].atLeast1_0Probability64,
    encodeMaintenanceBinary64(.4));
  delete value.rows[0].atLeast2_5Probability64;
  assert.throws(() => encodeMaintenanceShadowValues(value));
});

// compact database rows never carry candidate or observation values
test("shadow metadata binds exact staged bytes and an independent jittered issue clock", () => {
  const value = body("temperature");
  value.issuedAt = "9999-11-01T18:37:09.123Z";
  const bytes = encodeMaintenanceShadowValues(value);
  const metadata = createMaintenanceShadowPredictionMetadata(bytes);
  assert.equal(metadata.issuedAt, value.issuedAt);
  assert.equal(metadata.dueKey, value.dueKey);
  assert.equal(metadata.predictionBodySha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(metadata.predictionSchemaSha256, MAINTENANCE_SHADOW_SCHEMA_SHA256.temperature);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 2_048);
  assert.deepEqual(Object.keys(metadata), ["bodyByteCount", "dueKey", "inputSha256", "issuedAt", "maxValidAt",
    "minValidAt", "predictionBodySha256", "predictionSchemaSha256", "predictionSha256",
    "registrationSha256", "rowCount", "sourceReceiptSha256"]);
  const joined = ["adjustment-shadow-prediction/v2", metadata.registrationSha256, metadata.dueKey,
    value.issuedAt, metadata.minValidAt, metadata.maxValidAt, metadata.sourceReceiptSha256, metadata.inputSha256,
    metadata.predictionBodySha256, metadata.predictionSchemaSha256, "12", String(bytes.length)].join("\n");
  assert.equal(metadata.predictionSha256, createHash("sha256").update(joined).digest("hex"));
  value.rows[0].candidateTemperatureC64 = encodeMaintenanceBinary64(-99);
  const revised = createMaintenanceShadowPredictionMetadata(encodeMaintenanceShadowValues(value));
  assert.notEqual(revised.predictionSha256, metadata.predictionSha256);
});
