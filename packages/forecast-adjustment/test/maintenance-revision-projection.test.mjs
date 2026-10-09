import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  adjustmentRevisionLogicalKeySha256,
  adjustmentRevisionProjectionIdentity,
  ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT,
  adjustmentRainGateFeatureRowSha256,
  adjustmentRevisionProjectionSha256,
  createRainMaintenancePersistenceTarget,
  encodeAdjustmentRainGateControlProjection,
  encodeAdjustmentRainGateFeatureProjection,
  encodeAdjustmentRevisionBatchProjection,
  encodeAdjustmentRevisionProjection,
  encodeAdjustmentTemperatureNativeSourceProjection,
  encodeMaintenanceBinary64,
  parseAdjustmentRevisionBatchProjection,
  parseAdjustmentRainGateControlProjection,
  parseAdjustmentRainGateFeatureProjection,
  parseAdjustmentRevisionProjectionDocument,
  parseAdjustmentRevisionProjection,
  parseAdjustmentTemperatureNativeSourceProjection,
} from "../dist/index.js";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);

// construct one complete non-rain source lineage
function source() {
  return {
    adapterVersion: "open-meteo/v4",
    contractEpoch: "forecast/v4",
    dataset: "best_match",
    providerKey: "open-meteo",
    sourceConfigFingerprint: "open-meteo-forecast/v4",
    sourceId: "7",
    sourceKey: "open-meteo-forecast",
    sourceKind: "forecast",
    upstreamModel: "best_match",
  };
}

// construct one exact normalized weather row
function weatherRow(validAt = "2026-10-08T01:00:00.000Z") {
  return {
    apparentTemperatureC64: encodeMaintenanceBinary64(10),
    blackGlobeTemperatureC64: null,
    cloudCoverPercent64: encodeMaintenanceBinary64(50),
    contentSha256: HASH,
    pm25MicrogramsPerCubicMeter64: null,
    precipitationMm64: encodeMaintenanceBinary64(0),
    precipitationRateMmPerHour64: null,
    pressureHpa64: encodeMaintenanceBinary64(1_010),
    relativeHumidityPercent64: encodeMaintenanceBinary64(80),
    soilElectricalConductivityMicrosiemensPerCm64: null,
    soilMoisturePercent64: null,
    solarRadiationWm264: null,
    temperatureC64: encodeMaintenanceBinary64(11),
    uvIndex64: null,
    validAt,
    waterLevelM64: null,
    wetBulbGlobeTemperatureC64: null,
    windDirectionDegrees64: encodeMaintenanceBinary64(180),
    windGustMps64: encodeMaintenanceBinary64(8),
    windSpeedMps64: encodeMaintenanceBinary64(5),
  };
}

// construct each closed database revision class
function projections() {
  const actual = {
    contractVersion: "adjustment-revision-projection/v1",
    family: "shared",
    logicalKey: {
      productRunAt: "2026-10-08T00:00:00.000Z",
      sourceId: "7",
      sourceKind: "forecast",
      validAt: "2026-10-08T01:00:00.000Z",
    },
    logicalReceivedAt: "2026-10-08T00:05:00.000Z",
    projectionKind: "actual_best_match",
    rows: [weatherRow()],
    source: source(),
    storedContentSha256: HASH,
  };
  const target = structuredClone(actual);
  target.logicalKey.productRunAt = null;
  target.logicalKey.sourceKind = "physical_sensor";
  target.projectionKind = "target_revision";
  target.source.sourceKind = "physical_sensor";
  target.source.upstreamModel = null;
  const anchor = {
    ...structuredClone(actual),
    logicalKey: {
      contentSha256: null,
      leadHours: 24,
      providerResponseSha256: null,
      runInitializedAt: null,
      siteId: null,
      sourceId: "7",
      sourceType: "forecast_anchor",
      validAt: "2026-10-08T01:00:00.000Z",
    },
    projectionKind: "native_source",
    rows: [{
      apparentTemperatureC64: encodeMaintenanceBinary64(10),
      cloudCoverPercent64: encodeMaintenanceBinary64(50),
      contentSha256: HASH,
      leadHours: 24,
      precipitationMm64: encodeMaintenanceBinary64(0),
      pressureHpa64: encodeMaintenanceBinary64(1_010),
      relativeHumidityPercent64: encodeMaintenanceBinary64(80),
      temperatureC64: encodeMaintenanceBinary64(11),
      validAt: "2026-10-08T01:00:00.000Z",
      windDirectionDegrees64: encodeMaintenanceBinary64(180),
      windGustMps64: encodeMaintenanceBinary64(8),
      windSpeedMps64: encodeMaintenanceBinary64(5),
    }],
  };
  const temperature = {
    ...structuredClone(actual),
    family: "temperature",
    logicalKey: {
      contentSha256: HASH,
      leadHours: null,
      providerResponseSha256: SECOND_HASH,
      runInitializedAt: "2026-10-08T00:00:00.000Z",
      siteId: "3",
      sourceId: null,
      sourceType: "ecmwf_temperature_run",
      validAt: null,
    },
    projectionKind: "native_source",
    rows: Array.from({ length: 18 }, (_, index) => ({
      bestMatchContentSha256: index < 6 ? null : SECOND_HASH,
      bestMatchProductRunAt: index < 6 ? null : "2026-10-08T00:00:00.000Z",
      bestMatchSourceId: index < 6 ? null : "7",
      bestMatchTemperatureC64: index < 6 ? null : encodeMaintenanceBinary64(10),
      contentSha256: createHash("sha256").update(`temperature-${index}`).digest("hex"),
      modelCycle: "50r1",
      modelLeadHours: index + 1,
      rawRelativeHumidityPercent64: encodeMaintenanceBinary64(80),
      rawTemperatureC64: encodeMaintenanceBinary64(11),
      rawWindSpeedMps64: encodeMaintenanceBinary64(5),
      validAt: new Date(Date.parse("2026-10-08T01:00:00.000Z") + index * 3_600_000).toISOString(),
    })),
    source: { ...source(), adapterVersion: "open-meteo-ecmwf-single-run/v1",
      contractEpoch: "temperature-canary/v1", dataset: "single_run", upstreamModel: "ecmwf_ifs" },
  };
  const rain = {
    contractVersion: "adjustment-revision-projection/v1",
    family: "rain",
    logicalKey: {
      inputSha256: HASH,
      modelSha256: SECOND_HASH,
      runInitializedAt: "2026-10-08T00:00:00.000Z",
    },
    logicalReceivedAt: "2026-10-08T00:05:00.000Z",
    projectionKind: "rain_gate_input",
    rows: Array.from({ length: 23 }, (_, index) => ({
      applied: index % 2 === 0,
      correctedPrecipitationMm64: encodeMaintenanceBinary64(1),
      modelLeadHours: index + 1,
      rawPrecipitationMm64: encodeMaintenanceBinary64(2),
      reasonCode: "candidate_applied",
      validAt: new Date(Date.parse("2026-10-08T01:00:00.000Z") + index * 3_600_000).toISOString(),
    })),
    source: Object.fromEntries(Object.keys(source()).map((key) => [key, null])),
    storedContentSha256: HASH,
  };
  return [actual, target, anchor, temperature, rain];
}

test("all revision classes round-trip as exact canonical bytes and one whole-body identity", () => {
  // verify every frozen projection class independently
  for (const projection of projections()) {
    const bytes = encodeAdjustmentRevisionProjection(projection);
    assert.deepEqual(parseAdjustmentRevisionProjection(bytes), projection);
    assert.equal(adjustmentRevisionProjectionIdentity(bytes), adjustmentRevisionProjectionSha256(bytes));
    assert.equal(adjustmentRevisionProjectionIdentity(bytes),
      createHash("sha256").update(bytes).digest("hex"));
    assert.ok(bytes.length <= (projection.family === "temperature" ? 64 : 128) * 1_024);
    assert.match(adjustmentRevisionLogicalKeySha256(
      projection.projectionKind,
      projection.logicalKey,
    ), /^[a-f0-9]{64}$/u);
  }
});

test("revision parser rejects extension fields, aliases and incomplete geometry", () => {
  const [actual, , , temperature, rain] = projections();
  assert.throws(() => encodeAdjustmentRevisionProjection({ ...actual, privateValue: 1 }));
  assert.throws(() => encodeAdjustmentRevisionProjection({ ...actual,
    rows: [{ ...actual.rows[0], temperatureC64: "3FF0000000000000" }] }));
  assert.throws(() => encodeAdjustmentRevisionProjection({ ...temperature,
    rows: temperature.rows.slice(0, 17) }));
  assert.throws(() => encodeAdjustmentRevisionProjection({ ...rain,
    rows: rain.rows.map((row, index) => ({ ...row,
      validAt: index === 1 ? row.validAt.replace("02:00", "03:00") : row.validAt })) }));
  const canonical = encodeAdjustmentRevisionProjection(actual);
  assert.throws(() => parseAdjustmentRevisionProjection(Buffer.from(` ${canonical.toString()}`)));
});

test("temperature native v2 freezes the source-decision recent-error state", () => {
  const [, , , temperature] = projections();
  const recentErrorState = {
    b24C: 0.2,
    b72C: 0.1,
    cohort: "ecmwf_single_run_hindcast",
    localDates: 3,
    mad72C: 0.5,
    maximumSourceRunInitializedAt: "2026-10-07T12:00:00.000Z",
    maximumSourceValidAt: "2026-10-07T17:00:00.000Z",
    n24: 6,
    n72: 24,
    sourceKeys: Array.from({ length: 24 }, (_, index) =>
      `2026-10-07T00:00:00.000Z/${new Date(Date.parse("2026-10-07T00:00:00.000Z") +
        index * 3_600_000).toISOString()}`),
    supported: true,
    targetRunInitializedAt: temperature.logicalKey.runInitializedAt,
    windowEndValidAt: "2026-10-07T17:00:00.000Z",
  };
  const projection = {
    ...temperature,
    contractVersion: "adjustment-temperature-native-source-projection/v2",
    recentErrorState,
    recentErrorStateSha256: createHash("sha256")
      .update(JSON.stringify(recentErrorState)).digest("hex"),
  };
  const bytes = encodeAdjustmentTemperatureNativeSourceProjection(projection);
  assert.deepEqual(parseAdjustmentTemperatureNativeSourceProjection(bytes), projection);
  assert.deepEqual(parseAdjustmentRevisionProjectionDocument(bytes), projection);
  assert.throws(() => encodeAdjustmentTemperatureNativeSourceProjection({
    ...projection,
    recentErrorStateSha256: HASH,
  }));
  assert.throws(() => encodeAdjustmentTemperatureNativeSourceProjection({
    ...projection,
    rows: projection.rows.map((row, index) => index === 6
      ? { ...row, bestMatchSourceId: null }
      : row),
  }));
});

test("grouped weather v2 retains up to 168 rows without weakening v1", () => {
  const [actual] = projections();
  const grouped = {
    ...actual,
    contractVersion: "adjustment-revision-batch-projection/v2",
    family: "wind",
    rows: Array.from({ length: 168 }, (_unused, index) => ({
      ...weatherRow(new Date(
        Date.parse("2026-10-08T01:00:00.000Z") + index * 3_600_000,
      ).toISOString()),
      contentSha256: createHash("sha256").update(`weather-${index}`).digest("hex"),
    })),
    storedContentSha256: createHash("sha256").update("weather-0").digest("hex"),
  };
  const bytes = encodeAdjustmentRevisionBatchProjection(grouped);
  assert.deepEqual(parseAdjustmentRevisionBatchProjection(bytes), grouped);
  assert.deepEqual(parseAdjustmentRevisionProjectionDocument(bytes), grouped);
  assert.throws(() => parseAdjustmentRevisionProjection(bytes));
  assert.throws(() => encodeAdjustmentRevisionBatchProjection({
    ...grouped,
    rows: grouped.rows.slice(0, 167).map(
      // create one missing hour in otherwise ordered grouped rows
      (row, index) => index === 2 ? { ...row, validAt: grouped.rows[3].validAt } : row,
    ),
  }), /ordered/u);
  assert.throws(() => encodeAdjustmentRevisionBatchProjection({
    ...grouped,
    rows: [...grouped.rows, grouped.rows.at(-1)],
  }), /geometry/u);
});

test("rain feature v2 retains exact pre-fit 23x107 binary64 inputs", () => {
  const runInitializedAt = "2026-10-08T00:00:00.000Z";
  const value = {
    contractVersion: "adjustment-rain-gate-feature-projection/v2",
    family: "rain",
    logicalKey: {
      inputSha256: HASH,
      modelSha256: SECOND_HASH,
      runInitializedAt,
    },
    logicalReceivedAt: "2026-10-08T08:05:00.000Z",
    projectionKind: "rain_gate_input",
    rows: Array.from({ length: 23 }, (_unused, index) => ({
      features64: Array.from({ length: 107 }, (_feature, featureIndex) =>
        featureIndex === 17 ? null : encodeMaintenanceBinary64(index + featureIndex / 100)),
      modelLeadHours: index + 9,
      rawPrecipitationMm64: encodeMaintenanceBinary64(0.5),
      rawTargetHourTemperatureC64: encodeMaintenanceBinary64(10),
      validAt: new Date(Date.parse(runInitializedAt) + (index + 9) * 3_600_000).toISOString(),
    })),
    source: {
      adapterVersion: "rain-hurdle-wind-features/v1",
      contractEpoch: "rain-prospective-capture/v1",
      dataset: "ecmwf_ifs",
      providerKey: "open-meteo-single-runs",
      sourceConfigFingerprint: ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT,
      sourceId: "forecast-claim-1",
      sourceKey: "rain-prospective-forecast",
      sourceKind: "forecast",
      upstreamModel: "ecmwf_ifs",
    },
    storedContentSha256: createHash("sha256").update("stored-rain-jsonb").digest("hex"),
  };
  const bytes = encodeAdjustmentRainGateFeatureProjection(value);
  assert.deepEqual(parseAdjustmentRainGateFeatureProjection(bytes), value);
  assert.deepEqual(parseAdjustmentRevisionProjectionDocument(bytes), value);
  assert.equal(adjustmentRevisionProjectionIdentity(bytes),
    createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => encodeAdjustmentRainGateFeatureProjection({
    ...value,
    rows: value.rows.map((row, index) => index === 0
      ? { ...row, features64: row.features64.slice(0, 106) }
      : row),
  }), /row/u);
  assert.throws(() => encodeAdjustmentRainGateFeatureProjection({
    ...value,
    source: { ...value.source, sourceConfigFingerprint: HASH },
  }), /source/u);
  assert.throws(() => parseAdjustmentRevisionProjection(bytes));
});

test("rain control v3 binds durable monthly state, incumbent and causal persistence", () => {
  const runInitializedAt = "2026-10-08T00:00:00.000Z";
  const logicalKey = {
    inputSha256: HASH,
    modelSha256: SECOND_HASH,
    runInitializedAt,
  };
  const persistenceTarget = createRainMaintenancePersistenceTarget({
    decisionAt: "2026-10-08T08:00:00.000Z",
    rows: [64255, 225947, 38270, 168853, 126537, 201058,
      203055, 66270, 34768, 88159, 126197, 27140].map((stationId, index) => ({
    captureMembers: [{
      bodySha256: createHash("sha256").update(`capture-${index}`).digest("hex"),
      claimId: `station-${stationId}`,
      completedAt: "2026-10-08T07:05:00.000Z",
    }],
    precipitationMm: 0.75,
    receivedAt: "2026-10-08T07:05:00.000Z",
    stationId,
      })),
  });
  const rows = Array.from({ length: 23 }, (_unused, index) => {
    const source = {
      features64: Array.from({ length: 107 }, (_feature, featureIndex) =>
        featureIndex === 17 ? null : encodeMaintenanceBinary64(featureIndex === 5 ? 0.5 : index)),
      modelLeadHours: index + 9,
      rawPrecipitationMm64: encodeMaintenanceBinary64(0.5),
      rawTargetHourTemperatureC64: encodeMaintenanceBinary64(10),
      validAt: new Date(Date.parse(runInitializedAt) + (index + 9) * 3_600_000).toISOString(),
    };
    return {
      ...source,
      incumbentArtifactIdentitySha256: HASH,
      incumbentPrediction64: encodeMaintenanceBinary64(0.6),
      incumbentProbability: {
        atLeast0_1: encodeMaintenanceBinary64(0.7),
        atLeast1_0: encodeMaintenanceBinary64(0.2),
        atLeast2_5: encodeMaintenanceBinary64(0.1),
      },
      incumbentReceiptMemberSha256: SECOND_HASH,
      nativeSourceProbability: {
        atLeast0_1: encodeMaintenanceBinary64(1),
        atLeast1_0: encodeMaintenanceBinary64(0),
        atLeast2_5: encodeMaintenanceBinary64(0),
      },
      persistencePrediction64: encodeMaintenanceBinary64(0.75),
      persistenceReason: "causal_target",
      persistenceTargetMemberSha256: persistenceTarget.targetMemberSha256,
      recentVolumeScalePrediction64: encodeMaintenanceBinary64(0.8),
      sameWindowVolumeScalePrediction64: encodeMaintenanceBinary64(0.7),
      sourceRowSha256: adjustmentRainGateFeatureRowSha256(logicalKey, source),
      unchangedOrdinalPrediction64: encodeMaintenanceBinary64(0.6),
      volumeScalePrediction64: encodeMaintenanceBinary64(0.625),
    };
  });
  const value = {
    contractVersion: "adjustment-rain-gate-control-projection/v3",
    family: "rain",
    logicalKey,
    logicalReceivedAt: "2026-10-08T08:05:00.000Z",
    ordinalArtifactSha256: "c".repeat(64),
    persistenceTarget,
    projectionKind: "rain_gate_input",
    rows,
    source: {
      adapterVersion: "rain-hurdle-wind-features/v1",
      contractEpoch: "rain-prospective-capture/v1",
      dataset: "ecmwf_ifs",
      providerKey: "open-meteo-single-runs",
      sourceConfigFingerprint: ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT,
      sourceId: "forecast-claim-1",
      sourceKey: "rain-prospective-forecast",
      sourceKind: "forecast",
      upstreamModel: "ecmwf_ifs",
    },
    stateSha256: "d".repeat(64),
    stateStageReceiptSha256: "e".repeat(64),
    storedContentSha256: "f".repeat(64),
  };
  const bytes = encodeAdjustmentRainGateControlProjection(value);
  assert.ok(bytes.length <= 128 * 1_024);
  assert.deepEqual(parseAdjustmentRainGateControlProjection(bytes), value);
  assert.deepEqual(parseAdjustmentRevisionProjectionDocument(bytes), value);
  assert.equal(adjustmentRevisionProjectionIdentity(bytes),
    createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => encodeAdjustmentRainGateControlProjection({
    ...value,
    rows: value.rows.map((row, index) => index === 0
      ? { ...row, nativeSourceProbability: {
          ...row.nativeSourceProbability,
          atLeast1_0: encodeMaintenanceBinary64(1),
        } }
      : row),
  }), /native source probability/u);
  assert.throws(() => encodeAdjustmentRainGateControlProjection({
    ...value,
    rows: value.rows.map((row, index) => index === 1
      ? { ...row, incumbentReceiptMemberSha256: HASH }
      : row),
  }), /authority differs/u);
});
