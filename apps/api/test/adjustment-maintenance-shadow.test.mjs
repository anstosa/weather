import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildTemperatureMaintenanceSourceProjection,
  captureApiTemperatureMaintenanceShadow,
  createAdjustmentMaintenanceInternalServer,
  publishAdmittedAdjustmentRevision,
  publishAdmittedAdjustmentRevisionBatch,
  stageAdjustmentRevision,
} from "../dist/index.js";
import { buildRainFixedGaugeTargetProjection } from "../../worker/dist/rain-fixed-gauge-target.js";
import { RAIN_COLLECTION_STATIONS } from "../../../packages/domain/dist/index.js";
import {
  adjustmentRevisionLogicalKeySha256,
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  createMaintenanceShadowServingAuthority,
  encodeAdjustmentRevisionBatchProjection,
  encodeAdjustmentRevisionProjection,
  encodeMaintenanceBinary64,
  decodeMaintenanceBinary64,
  parseMaintenanceShadowComparator,
  parseMaintenanceShadowSourceProjection,
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
} from "../../../packages/forecast-adjustment/dist/index.js";

const dueKey = "capture/2026-09-14T00:35:00.000Z";
const issuedAt = "2026-09-14T00:35:00.000Z";
const captureEpoch = Object.freeze({
  epochAt: "2000-01-01T00:00:00.000Z",
  witnessSha256: "3".repeat(64),
});

// hash one exact test value
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

// construct one complete immutable Tempest body for a fixed gauge target hour
function fixedGaugeCapture(station) {
  const start = Date.parse("2026-09-14T05:59:00.000Z");
  const obs = [];
  // preserve each minute required by the backward hourly tiling recipe
  for (let minute = 1; minute <= 65; minute += 1) {
    obs.push([(start + minute * 60_000) / 1000, 0, 1, 2, 180, 3, 1000, 12, 80,
      0, 0, 0, 0.01, 0, 0, 0, 2.7, 1, 0, 0, 0, 0]);
  }
  const body = Buffer.from(JSON.stringify({
    device_id: station.deviceId,
    obs,
    status: { status_code: 0 },
    type: "obs_st",
  }));
  return {
    body,
    bodySha256: hash(body),
    claimId: `target-${station.locationId}`,
    completedAt: "2026-09-14T07:10:00.000Z",
    kind: "station",
    runInitializedAt: null,
    stationId: station.locationId,
    windowEndExclusive: "2026-09-14T07:05:00.000Z",
    windowStart: "2026-09-14T05:59:00.000Z",
  };
}

// build one genuine twelve-gauge target body through the production codec
function fixedGaugeTargetProjection() {
  const built = buildRainFixedGaugeTargetProjection({
    captures: RAIN_COLLECTION_STATIONS.map(fixedGaugeCapture),
    sources: RAIN_COLLECTION_STATIONS.map((station, index) => ({
      sourceId: String(1_000 + index),
      stationId: station.locationId,
    })),
    targetCutoffAt: "2026-09-14T07:10:00.000Z",
    validAt: "2026-09-14T07:00:00.000Z",
  });
  assert.equal(built.state, "complete");
  return built.bytes;
}

// build one exact current Best Match database revision projection
function revisionProjection() {
  return encodeAdjustmentRevisionProjection({
    contractVersion: "adjustment-revision-projection/v1",
    family: "shared",
    logicalKey: {
      productRunAt: "2026-09-14T00:00:00.000Z",
      sourceId: "7",
      sourceKind: "forecast",
      validAt: "2026-09-14T01:00:00.000Z",
    },
    logicalReceivedAt: "2026-09-14T00:10:00.000Z",
    projectionKind: "actual_best_match",
    rows: [{
      apparentTemperatureC64: encodeMaintenanceBinary64(10),
      blackGlobeTemperatureC64: null,
      cloudCoverPercent64: encodeMaintenanceBinary64(50),
      contentSha256: hash("revision-content"),
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
      validAt: "2026-09-14T01:00:00.000Z",
      waterLevelM64: null,
      wetBulbGlobeTemperatureC64: null,
      windDirectionDegrees64: encodeMaintenanceBinary64(180),
      windGustMps64: encodeMaintenanceBinary64(8),
      windSpeedMps64: encodeMaintenanceBinary64(5),
    }],
    source: {
      adapterVersion: "open-meteo/v1",
      contractEpoch: "weather-record/v4",
      dataset: "best_match",
      providerKey: "open-meteo",
      sourceConfigFingerprint: "fingerprint-v1",
      sourceId: "7",
      sourceKey: "forecast-ballydidean",
      sourceKind: "forecast",
      upstreamModel: "best_match",
    },
    storedContentSha256: hash("revision-content"),
  });
}

// build one grouped two-hour Best Match body
function revisionBatchProjection() {
  const first = JSON.parse(revisionProjection().toString("utf8"));
  return encodeAdjustmentRevisionBatchProjection({
    ...first,
    contractVersion: "adjustment-revision-batch-projection/v2",
    family: "wind",
    rows: [first.rows[0], {
      ...first.rows[0],
      contentSha256: hash("revision-content-2"),
      validAt: "2026-09-14T02:00:00.000Z",
    }],
  });
}

// build one canonical pre-month state for the private staging route
function rainControlStateBytes() {
  return encodeRainMaintenanceControlState(createRainMaintenanceControlState({
    calibrationEndAt: "2026-08-25T00:00:00.000Z",
    calibrationStartAt: "2026-05-27T00:00:00.000Z",
    contractVersion: "rain-maintenance-control-state/v1",
    epochWitnessSha256: captureEpoch.witnessSha256,
    generatedAt: "2026-08-26T00:00:00.000Z",
    legacyCalibrationStartAt: "2026-07-11T00:00:00.000Z",
    legacyRawScale: 1.1,
    modelMonth: "2026-09",
    ordinalArtifactSha256: "4".repeat(64),
    recentFallbackReason: "recent_calibration",
    recentRawScale: 1.2,
    recentSupported: true,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
    sameWindowRawScale: 1.15,
    scheduleContractSha256: "5".repeat(64),
    sourceMemberRootSha256: "6".repeat(64),
    sourceReceiptRootSha256: "7".repeat(64),
    support: {
      calibrationDates: 90, calibrationHours: 2_000, calibrationRows: 2_000,
      calibrationWetDates: 20, calibrationWetHours: 200,
      effectiveDates64: "404e000000000000", effectiveWetDates64: "4008000000000000",
      legacyCalibrationRows: 500, legacyTrainingRows: 2_000, legacyTrainingWetRows: 200,
      trainingDates: 200, trainingHours: 4_000, trainingRows: 4_000,
      trainingWetDates: 30, trainingWetHours: 300,
    },
    trainingMaximumValidAt: "2026-05-19T23:00:00.000Z",
  }));
}

// create one canonical self-hashed revision stage receipt
function revisionStageReceipt(projection) {
  const identity = hash(projection);
  const projectionKind = JSON.parse(Buffer.from(projection).toString("utf8")).projectionKind;
  const unsigned = {
    contractVersion: "adjustment-revision-stage-receipt/v1",
    durable: true,
    durableAt: "2026-09-14T00:11:00.000Z",
    projectionIdentitySha256: identity,
    projectionKind,
    projectionSha256: identity,
  };
  return { ...unsigned, stageReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
}

// create one canonical self-hashed revision publish receipt
function revisionPublishReceipt(revisionReceipt) {
  const unsigned = {
    committed: true,
    committedAt: "2026-09-14T00:13:00.000Z",
    contractVersion: "adjustment-revision-publish-receipt/v1",
    projectionIdentitySha256: revisionReceipt.projectionIdentitySha256,
    projectionKind: revisionReceipt.projectionKind,
    projectionSha256: revisionReceipt.projectionSha256,
    revisionReceiptSha256: revisionReceipt.receiptSha256,
  };
  return { ...unsigned, publishReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
}

// create one canonical grouped publish checkpoint
function revisionBatchPublishReceipt(revisionReceipts) {
  const first = revisionReceipts[0];
  const unsigned = {
    committed: true,
    committedAt: "2026-09-14T00:13:00.000Z",
    contractVersion: "adjustment-revision-batch-publish-receipt/v2",
    projectionIdentitySha256: first.projectionIdentitySha256,
    projectionKind: first.projectionKind,
    projectionSha256: first.projectionSha256,
    revisionReceiptSha256s: revisionReceipts.map(
      // preserve exact database receipt order
      (receipt) => receipt.receiptSha256,
    ),
  };
  return { ...unsigned, publishReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
}

// build one frozen registration accepted by the repository boundary
function registration() {
  return {
    artifactSha256: "1".repeat(64),
    candidateSha256: "2".repeat(64),
    cohortSha256: "3".repeat(64),
    family: "temperature",
    intervalEndAt: "2026-10-01T00:00:00.000Z",
    intervalStartAt: "2026-09-01T00:00:00.000Z",
    policySha256: "4".repeat(64),
    registrationSha256: "5".repeat(64),
    reservedKeySha256: "6".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "7".repeat(64),
    targetCutoffAt: "2026-10-08T00:00:00.000Z",
    terminalAt: "2026-10-09T00:00:00.000Z",
  };
}

// bind one root-installed action, bundle and receipt to the registration
function installedCandidate(value = registration()) {
  return {
    action: { candidateGraphSha256: "a".repeat(64), candidateSha256: value.candidateSha256 },
    bundle: { bundleSha256: value.artifactSha256 },
    catalogSha256: "b".repeat(64),
    family: value.family,
    receipt: { actionSha256: "c".repeat(64), bundleSha256: value.artifactSha256,
      candidateGraphSha256: "a".repeat(64), candidateSha256: value.candidateSha256,
      contractVersion: "adjustment-installed-candidate-receipt/v1",
      controlPlaneSha256: "d".repeat(64), deployedCommit: "1".repeat(40),
      deployedImageDigest: `sha256:${"e".repeat(64)}`, deployedRelease: "2026.09.14-1",
      deployedSettingsSha256: "f".repeat(64), fencingToken: "1",
      installedAt: "2026-09-13T23:55:00.000Z",
      registrationSha256: value.registrationSha256, sourceSha256: value.sourceSha256 },
    registration: value,
  };
}

// retain exact storage content and first-receipt identities
function forecastRows(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    adapterVersion: "open-meteo/v1",
    contentHash: hash(`raw-${String(index)}`),
    contractEpoch: "weather-record/v4",
    firstReceivedAt: "2026-09-14T00:10:00.000Z",
    productRunAt: "2026-09-14T00:00:00.000Z",
    providerKey: "open-meteo",
    providerMetadata: { dataset: "best_match" },
    revisionCount: 0,
    sourceConfigFingerprint: "fingerprint-v1",
    sourceKey: "forecast-ballydidean",
    sourceId: "7",
    temperatureC: 12 + index,
    upstreamModel: "best_match",
    validAt: new Date(Date.parse("2026-09-14T01:00:00.000Z") + index * 3_600_000).toISOString(),
  }));
}

// retain one complete private ECMWF run with exact hour content hashes
function temperatureSidecar(count = 12) {
  return {
    hours: Array.from({ length: count }, (_, index) => ({
      contentHash: hash(`ecmwf-${String(index)}`),
      modelLeadHours: index + 7,
      rawRelativeHumidityPercent: 70,
      rawTemperatureC: 11 + index,
      rawWindSpeedMps: 4,
      validAt: new Date(Date.parse("2026-09-14T01:00:00.000Z") + index * 3_600_000).toISOString(),
    })),
    run: {
      adapterVersion: "open-meteo-ecmwf-single-run/v1",
      firstReceivedAt: "2026-09-14T00:10:00.000Z",
      id: "1",
      modelCycle: "50r1",
      providerResponseSha256: hash("ecmwf-response"),
      recentErrorState: {
        b24C: 0.2,
        b72C: 0.1,
        cohort: "ecmwf_single_run_hindcast",
        localDates: 3,
        mad72C: 0.5,
        maximumSourceRunInitializedAt: "2026-09-13T12:00:00.000Z",
        maximumSourceValidAt: "2026-09-13T23:00:00.000Z",
        n24: 12,
        n72: 36,
        sourceKeys: ["source-1"],
        supported: true,
        targetRunInitializedAt: "2026-09-13T18:00:00.000Z",
        windowEndValidAt: "2026-09-13T23:00:00.000Z",
      },
      runInitializedAt: "2026-09-13T18:00:00.000Z",
      stateReason: "supported",
      stateStatus: "supported",
      upstreamModel: "ecmwf_ifs",
    },
  };
}

// preserve one explicit root-selected raw incumbent authority
function temperatureIncumbentRuntime() {
  const receipt = Buffer.from(`${JSON.stringify({
    activeBundle: null,
    contractVersion: "forecast-adjustment-temperature-canary-registry/v2",
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  })}\n`);
  return {
    bundle: null,
    comparatorAuthority: createMaintenanceShadowServingAuthority({
      artifactBytes: null,
      artifactIdentitySha256: null,
      authorityKind: "policy_raw",
      family: "temperature",
      receiptBytes: receipt,
    }),
    reasonCode: "policy_raw",
    state: "disabled",
  };
}

// create one deterministic archive relay and event log
function archive(events, failAt = null) {
  let fixedGaugeTargetGap = null;
  return {
    async recordGap(input) {
      events.push(`gap:${input.reason}`);
    },
    async recordRainControlStateGap(input) {
      events.push(["gap-control-state", input]);
    },
    async recordRainFixedGaugeTargetGap(input) {
      const unsigned = {
        contractVersion: "adjustment-rain-fixed-gauge-target-gap/v1",
        gapAt: "2026-09-14T01:00:01.000Z",
        logicalHourAt: input.logicalHourAt,
        logicalKeySha256: input.logicalKeySha256,
        qualificationDisposition: "forever_unqualified",
        reason: input.reason,
      };
      fixedGaugeTargetGap = {
        ...unsigned,
        gapSha256: hash(`${JSON.stringify(unsigned)}\n`),
      };
      events.push(["gap-fixed-gauge-target", input]);
      return fixedGaugeTargetGap;
    },
    async readRainFixedGaugeTargetGap() {
      return fixedGaugeTargetGap === null
        ? {
            contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1",
            state: "absent",
          }
        : {
            contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1",
            gap: fixedGaugeTargetGap,
            state: "present",
          };
    },
    async stage(input) {
      events.push("stage");
      // expose exact raw projection evidence to the assertion
      events.push({
        comparator: parseMaintenanceShadowComparator(input.comparator),
        source: parseMaintenanceShadowSourceProjection(input.sourceProjection),
      });
      if (failAt === "stage") throw new Error("crash before fsync");
      const unsigned = {
        contractVersion: "adjustment-shadow-stage-receipt/v2",
        durable: true,
        durableAt: "2026-09-14T00:36:00.000Z",
        dueKey: input.metadata.dueKey,
        predictionBodySha256: input.metadata.predictionBodySha256,
        registrationSha256: input.metadata.registrationSha256,
        sourceProjectionSha256: input.sourceProjectionSha256,
        comparatorSha256: hash(input.comparator),
      };
      return { ...unsigned, stageReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
    },
    async stageRainControlState(state) {
      events.push(["stage-control-state", Buffer.from(state)]);
      const unsigned = {
        contractVersion: "adjustment-rain-control-state-stage-receipt/v1",
        durable: true,
        durableAt: "2026-09-14T00:36:00.000Z",
        stateSha256: hash(state),
      };
      return { ...unsigned, stageReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
    },
    async publish(input) {
      events.push("publish");
      if (failAt === "publish") throw new Error("crash before publish");
      assert.equal(input.predictionCommittedAt, "2026-09-14T00:36:30.000Z");
      const unsigned = {
        committed: true,
        committedAt: "2026-09-14T00:37:00.000Z",
        contractVersion: "adjustment-shadow-publish-receipt/v2",
        predictionSha256: input.metadata.predictionSha256,
        comparatorSha256: hash(input.comparator),
      };
      return { ...unsigned, publishReceiptSha256: hash(`${JSON.stringify(unsigned)}\n`) };
    },
  };
}

// emulate the closed registration, append and admission functions
function database(events, { admitted = true, appendFails = false, revisionMismatch = false } = {}) {
  let revisionReceipt = null;
  return {
    async query(sql, values) {
      // return one exact value-free rolling family slot
      if (sql.includes("adjustment_shadow_registration_slot_v3")) {
        const family = values[0];
        return { rows: [{ value: {
          contractVersion: "adjustment-shadow-registration-slot/v3",
          epochWitnessSha256: "d".repeat(64),
          family,
          horizonEndAt: "2028-08-26T07:00:00.000Z",
          registrationSha256: null,
          scheduleContractSha256: "e".repeat(64),
          state: "free",
          terminalAt: null,
        } }] };
      }
      if (sql.includes("weather_register_adjustment_shadow_v2")) {
        events.push("register");
        return { rows: [{ value: { inserted: false, registrationSha256: registration().registrationSha256 } }] };
      }
      if (sql.includes("weather_append_adjustment_temperature_shadow_v2")) {
        events.push("append");
        if (appendFails) throw new Error("database unavailable");
        const compact = JSON.parse(values[0]);
        revisionReceipt = {
          archiveCommitOrdinal: "1",
          archiveCommittedAt: "2026-09-14T00:36:30.000Z",
          contractVersion: "adjustment-revision-commit-receipt/v1",
          frontierSha256: "a".repeat(64),
          predecessorFrontierSha256: "b".repeat(64),
          projectionIdentitySha256: compact.sourceReceiptSha256,
          projectionKind: "shadow_prediction",
          projectionSha256: compact.inputSha256,
          receiptSha256: "c".repeat(64),
          stageReceiptSha256: compact.stageReceiptSha256,
        };
        return { rows: [{ value: {
          committedAt: "2026-09-14T00:36:30.000Z",
          inserted: true,
          predictionSha256: compact.predictionSha256,
          revisionReceipt,
        } }] };
      }
      if (sql.includes("adjustment_shadow_body_admission_v2")) {
        events.push("admission");
        return { rows: [{ admitted }] };
      }
      if (sql.includes("adjustment_shadow_revision_admission_v1")) {
        events.push("revision-admission");
        return { rows: [{ value: revisionMismatch
          ? { ...revisionReceipt, archiveCommitOrdinal: "2" }
          : revisionReceipt }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// evaluate without provider calls using only the retained source projection
async function temperatureCandidate(source) {
  return source.rows.map((row) => ({
    candidateTemperatureC: 10,
    fallbackCode: "none",
    validAt: row.validAt,
    wouldApply: true,
  }));
}

test("shadow capture stages raw bytes before append, admits, then publishes", async () => {
  const events = [];
  const result = await captureApiTemperatureMaintenanceShadow({
    bestMatchRows: forecastRows(),
    candidate: installedCandidate(),
    captureEpoch,
    dueKey,
    evaluate: temperatureCandidate,
    issuedAt,
    incumbentRuntime: temperatureIncumbentRuntime(),
    queryable: database(events),
    relay: archive(events),
    sidecar: temperatureSidecar(),
  });
  assert.equal(result.status, "published");
  assert.deepEqual(events.filter((event) => typeof event === "string"), [
    "stage", "register", "append", "admission", "revision-admission", "publish",
  ]);
  const source = events.find((event) => typeof event === "object");
  assert.equal(source.source.rows[0].contentSha256, temperatureSidecar().hours[0].contentHash);
  assert.equal(source.source.rows[0].bestMatchContentSha256, forecastRows()[0].contentHash);
  assert.equal(source.source.rows[0].bestMatchProductRunAt, forecastRows()[0].productRunAt);
  assert.equal(source.source.rows[0].bestMatchSourceId, forecastRows()[0].sourceId);
  assert.equal(source.source.rows[0].receivedAt, temperatureSidecar().run.firstReceivedAt);
  assert.equal(source.source.rows[0].modelLeadHours, 7);
  assert.equal(source.comparator.servingAuthority.authorityKind, "policy_raw");
  assert.equal(decodeMaintenanceBinary64(source.comparator.rows[0].incumbentTemperatureC64), 12);
});

test("shadow failures remain categorical gaps and never bypass ordering", async () => {
  for (const scenario of [
    { expected: ["stage", "gap:archive_stage_failed"], relayFailure: "stage" },
    { appendFails: true, expected: ["stage", "register", "append", "gap:database_append_failed"] },
    { admitted: false, expected: ["stage", "register", "append", "admission", "gap:database_admission_failed"] },
    { revisionMismatch: true, expected: ["stage", "register", "append", "admission", "revision-admission", "gap:database_admission_failed"] },
    { expected: ["stage", "register", "append", "admission", "revision-admission", "publish", "gap:archive_publish_failed"], relayFailure: "publish" },
  ]) {
    const events = [];
    const result = await captureApiTemperatureMaintenanceShadow({
      bestMatchRows: forecastRows(),
      candidate: installedCandidate(),
      captureEpoch,
      dueKey,
      evaluate: temperatureCandidate,
      issuedAt,
      incumbentRuntime: temperatureIncumbentRuntime(),
      queryable: database(events, scenario),
      relay: archive(events, scenario.relayFailure),
      sidecar: temperatureSidecar(),
    });
    assert.equal(result.status, "gap");
    assert.deepEqual(events.filter((event) => typeof event === "string"), scenario.expected);
  }
});

test("candidate, source geometry and immutable proof mismatches fail closed", async () => {
  const source = buildTemperatureMaintenanceSourceProjection({
    bestMatchRows: forecastRows(),
    dueKey,
    issuedAt,
    incumbentRuntime: temperatureIncumbentRuntime(),
    registration: registration(),
    sidecar: temperatureSidecar(),
  });
  assert.equal(parseMaintenanceShadowSourceProjection(source).rows.length, 12);
  assert.throws(() => buildTemperatureMaintenanceSourceProjection({
    bestMatchRows: forecastRows(11),
    dueKey,
    issuedAt,
    registration: registration(),
    sidecar: temperatureSidecar(),
  }), /incomplete/u);

  const events = [];
  const result = await captureApiTemperatureMaintenanceShadow({
    bestMatchRows: forecastRows(),
    candidate: { ...installedCandidate(), catalogSha256: "not-a-hash" },
    captureEpoch,
    dueKey,
    evaluate: temperatureCandidate,
    issuedAt,
    queryable: database(events),
    relay: archive(events),
    sidecar: temperatureSidecar(),
  });
  assert.deepEqual(result, { reason: "candidate_unavailable", status: "gap" });
  assert.deepEqual(events, ["gap:candidate_unavailable"]);
});

test("maintenance server exposes only exact private mutation and schedule paths", async (context) => {
  const captures = [];
  const relayEvents = [];
  const server = createAdjustmentMaintenanceInternalServer({
    captureEpoch,
    async capture(request) { captures.push(request); },
    queryable: database([]),
    relay: archive(relayEvents),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const publicResponse = await fetch(`${origin}/api/weather?shadow=1`);
  assert.equal(publicResponse.status, 404);
  const queryResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/shadow/stage?x=1`,
    { method: "POST" },
  );
  assert.equal(queryResponse.status, 404);
  const captureResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/shadow/capture`,
    {
      body: JSON.stringify({ dueKey, issuedAt }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(captureResponse.status, 202);
  assert.deepEqual(captures, [{ dueKey, issuedAt }]);
  const scheduleResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/schedule-slots`,
  );
  assert.equal(scheduleResponse.status, 200);
  const slots = await scheduleResponse.json();
  assert.deepEqual(slots.map((slot) => slot.family), ["temperature", "wind", "rain"]);
  assert.ok(slots.every((slot) => slot.state === "free"));
  const schedulePost = await fetch(
    `${origin}/internal/adjustment-maintenance/schedule-slots`,
    { method: "POST" },
  );
  assert.equal(schedulePost.status, 404);
  const stateBytes = rainControlStateBytes();
  const stateResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/rain-control-state/stage`,
    {
      body: JSON.stringify({ stateBase64: stateBytes.toString("base64") }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(stateResponse.status, 200);
  const stateReceipt = await stateResponse.json();
  assert.equal(stateReceipt.stateSha256, hash(stateBytes));
  const stateGap = {
    reason: "projection_stage_failed",
    stageReceiptSha256: stateReceipt.stageReceiptSha256,
    stateSha256: stateReceipt.stateSha256,
  };
  const gapResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/rain-control-state/gap`,
    {
      body: JSON.stringify(stateGap),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(gapResponse.status, 200);
  const fixedTargetGap = {
    logicalHourAt: "2026-09-14T01:00:00.000Z",
    logicalKeySha256: hash("rain-target-logical-key"),
    reason: "target_source_oversized",
  };
  const fixedTargetGapResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/rain-fixed-gauge-target/gap`,
    {
      body: JSON.stringify(fixedTargetGap),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(fixedTargetGapResponse.status, 200);
  const fixedTargetReceipt = await fixedTargetGapResponse.json();
  assert.equal(fixedTargetReceipt.qualificationDisposition, "forever_unqualified");
  const fixedTargetStatusResponse = await fetch(
    `${origin}/internal/adjustment-maintenance/rain-fixed-gauge-target/gap/status`,
    {
      body: JSON.stringify({
        logicalHourAt: fixedTargetGap.logicalHourAt,
        logicalKeySha256: fixedTargetGap.logicalKeySha256,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(fixedTargetStatusResponse.status, 200);
  assert.equal((await fixedTargetStatusResponse.json()).state, "present");
  assert.deepEqual(relayEvents, [
    ["stage-control-state", stateBytes],
    ["gap-control-state", stateGap],
    ["gap-fixed-gauge-target", fixedTargetGap],
  ]);
});

test("maintenance server preserves private revision spool backpressure", async (context) => {
  const relay = {
    // simulate the web archive's explicit two-slot capacity refusal
    async stageRevision() {
      const error = new Error("full");
      error.code = "adjustment_revision_spool_refused";
      throw error;
    },
  };
  const server = createAdjustmentMaintenanceInternalServer({
    captureEpoch,
    async capture() {},
    queryable: database([]),
    relay,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/internal/adjustment-maintenance/revision/stage`,
    {
      body: JSON.stringify({ projectionBase64: revisionProjection().toString("base64") }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "revision_spool_full" });
});

test("database revisions stage exact bytes and publish only the admitted persisted receipt", async () => {
  const projection = revisionProjection();
  const stageReceipt = revisionStageReceipt(projection);
  const revisionReceipt = {
    archiveCommitOrdinal: "9",
    archiveCommittedAt: "2026-09-14T00:12:00.000Z",
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: hash("frontier"),
    predecessorFrontierSha256: hash("predecessor"),
    projectionIdentitySha256: stageReceipt.projectionIdentitySha256,
    projectionKind: "actual_best_match",
    projectionSha256: stageReceipt.projectionSha256,
    receiptSha256: hash("database-receipt"),
    stageReceiptSha256: stageReceipt.stageReceiptSha256,
  };
  const events = [];
  const relay = {
    async publishRevision(input) {
      events.push(["publish", input]);
      return revisionPublishReceipt(input.revisionReceipt);
    },
    async stageRevision(value) {
      events.push(["stage", Buffer.from(value)]);
      return stageReceipt;
    },
  };
  const queryable = {
    async query(sql, values) {
      assert.match(sql, /adjustment_weather_revision_admission_v1/u);
      assert.deepEqual(JSON.parse(values[0]), {
        productRunAt: "2026-09-14T00:00:00.000Z",
        sourceId: "7",
        sourceKind: "forecast",
        storedContentSha256: hash("revision-content"),
        validAt: "2026-09-14T01:00:00.000Z",
      });
      events.push(["admit", values]);
      return { rows: [{ value: revisionReceipt }] };
    },
  };
  assert.deepEqual(await stageAdjustmentRevision(relay, projection), stageReceipt);
  const published = await publishAdmittedAdjustmentRevision(
    queryable,
    relay,
    projection,
    stageReceipt,
    revisionReceipt,
  );
  assert.deepEqual(published, revisionPublishReceipt(revisionReceipt));
  assert.deepEqual(events.map(([kind]) => kind), ["stage", "admit", "publish"]);

  // refuse a caller receipt that differs from the api-authenticated database row
  await assert.rejects(() => publishAdmittedAdjustmentRevision(
    queryable,
    relay,
    projection,
    stageReceipt,
    { ...revisionReceipt, archiveCommitOrdinal: "10" },
  ));
});

test("grouped weather publication admits every ordered row receipt before one archive ack", async () => {
  const projection = revisionBatchProjection();
  const stageReceipt = revisionStageReceipt(projection);
  const firstFrontier = hash("batch-frontier-1");
  const revisionReceipts = [
    {
      archiveCommitOrdinal: "20",
      frontierSha256: firstFrontier,
      predecessorFrontierSha256: hash("batch-predecessor"),
      receiptSha256: hash("batch-receipt-1"),
    },
    {
      archiveCommitOrdinal: "21",
      frontierSha256: hash("batch-frontier-2"),
      predecessorFrontierSha256: firstFrontier,
      receiptSha256: hash("batch-receipt-2"),
    },
  ].map((receipt) => ({
    ...receipt,
    archiveCommittedAt: "2026-09-14T00:12:00.000Z",
    contractVersion: "adjustment-revision-commit-receipt/v1",
    projectionIdentitySha256: stageReceipt.projectionIdentitySha256,
    projectionKind: "actual_best_match",
    projectionSha256: stageReceipt.projectionSha256,
    stageReceiptSha256: stageReceipt.stageReceiptSha256,
  }));
  const admissions = [];
  const queryable = {
    async query(sql, values) {
      assert.match(sql, /adjustment_weather_revision_admission_v1/u);
      const key = JSON.parse(values[0]);
      admissions.push(key);
      return { rows: [{ value: revisionReceipts[admissions.length - 1] }] };
    },
  };
  const relay = {
    async publishRevisionBatch(input) {
      assert.deepEqual(input.revisionReceipts, revisionReceipts);
      return revisionBatchPublishReceipt(input.revisionReceipts);
    },
  };
  assert.deepEqual(await publishAdmittedAdjustmentRevisionBatch(
    queryable,
    relay,
    projection,
    stageReceipt,
    revisionReceipts,
  ), revisionBatchPublishReceipt(revisionReceipts));
  assert.deepEqual(admissions.map((key) => key.validAt), [
    "2026-09-14T01:00:00.000Z",
    "2026-09-14T02:00:00.000Z",
  ]);

  const marked = [];
  const archivedGaps = [];
  const failureQueryable = {
    // admit both pointers, then retain every row-specific permanent marker
    async query(sql, values) {
      if (/adjustment_weather_revision_admission_v1/u.test(sql)) {
        const key = JSON.parse(values[0]);
        const index = key.validAt.endsWith("01:00:00.000Z") ? 0 : 1;
        return { rows: [{ value: revisionReceipts[index] }] };
      }
      assert.match(sql, /weather_mark_adjustment_revision_gap_v1/u);
      const key = JSON.parse(values[1]);
      const gap = JSON.parse(values[2]);
      marked.push(gap);
      return { rows: [{ value: {
        contractVersion: "adjustment-revision-gap-marker/v1",
        ...gap,
        storedContentSha256: key.storedContentSha256,
      } }] };
    },
  };
  const failureRelay = {
    // force one terminal publication disposition after database admission
    async publishRevisionBatch() { throw new Error("publish failed"); },
    async recordRevisionGap(gap) { archivedGaps.push(gap); },
  };
  await assert.rejects(() => publishAdmittedAdjustmentRevisionBatch(
    failureQueryable,
    failureRelay,
    projection,
    stageReceipt,
    revisionReceipts,
  ), /publish failed/u);
  assert.equal(marked.length, 2);
  assert.equal(archivedGaps.length, 1);
  assert.equal(archivedGaps[0].logicalKeySha256,
    adjustmentRevisionLogicalKeySha256("actual_best_match", {
      productRunAt: "2026-09-14T00:00:00.000Z",
      sourceId: "7",
      sourceKind: "forecast",
      validAt: "2026-09-14T01:00:00.000Z",
    }));
});

test("fixed-gauge target publication admits all twelve dedicated physical rows", async () => {
  const projection = fixedGaugeTargetProjection();
  const parsed = JSON.parse(projection.toString("utf8"));
  const stageReceipt = revisionStageReceipt(projection);
  const revisionReceipts = [];
  let predecessorFrontierSha256 = hash("fixed-gauge-predecessor");
  // issue one direct global-frontier receipt per fixed station row
  for (let index = 0; index < 12; index += 1) {
    const frontierSha256 = hash(`fixed-gauge-frontier-${index}`);
    revisionReceipts.push({
      archiveCommitOrdinal: String(100 + index),
      archiveCommittedAt: new Date(Date.parse("2026-09-14T07:11:00.000Z") +
        index * 1_000).toISOString(),
      contractVersion: "adjustment-revision-commit-receipt/v1",
      frontierSha256,
      predecessorFrontierSha256,
      projectionIdentitySha256: stageReceipt.projectionIdentitySha256,
      projectionKind: "target_revision",
      projectionSha256: stageReceipt.projectionSha256,
      receiptSha256: hash(`fixed-gauge-receipt-${index}`),
      stageReceiptSha256: stageReceipt.stageReceiptSha256,
    });
    predecessorFrontierSha256 = frontierSha256;
  }
  const admissions = [];
  const queryable = {
    async query(sql, values) {
      assert.match(sql, /adjustment_weather_revision_admission_v1/u);
      admissions.push(JSON.parse(values[0]));
      return { rows: [{ value: revisionReceipts[admissions.length - 1] }] };
    },
  };
  const relay = {
    async publishRevisionBatch(input) {
      return revisionBatchPublishReceipt(input.revisionReceipts);
    },
  };
  assert.deepEqual(await publishAdmittedAdjustmentRevisionBatch(
    queryable,
    relay,
    projection,
    stageReceipt,
    revisionReceipts,
  ), revisionBatchPublishReceipt(revisionReceipts));
  assert.equal(admissions.length, 12);
  assert.deepEqual(admissions.map((key) => key.sourceId),
    parsed.rows.map((row) => row.normalizedRecord.sourceId));
  assert.ok(admissions.every((key) => key.productRunAt === null &&
    key.sourceKind === "physical_sensor" && key.validAt === parsed.validAt));
  assert.deepEqual(admissions.map((key) => key.storedContentSha256),
    parsed.rows.map((row) => row.storedContentSha256));
});
