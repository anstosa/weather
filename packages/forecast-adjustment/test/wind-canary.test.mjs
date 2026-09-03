import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1,
  applyForecastAdjustment,
  canonicalJsonBytes,
  canonicalObjectSha256,
  canonicalSha256,
  createForecastAdjustmentWindCanaryAuthorization,
  createForecastAdjustmentWindCanaryCandidate,
  createForecastAdjustmentWindCanaryRuntimeBundle,
  createForecastAdjustmentWindCanaryRuntimeLoaderForRoot,
  createForecastAdjustmentWindCanaryTransferReport,
  forecastAdjustmentWindCanaryIsActiveAt,
  forecastAdjustmentWindCanaryIsKilled,
  runtimeCalendarFingerprint,
  verifyForecastAdjustmentWindCanaryCandidate,
  verifyForecastAdjustmentWindCanaryRuntimeBundle,
  verifyForecastAdjustmentWindCanaryTransferReport,
} from "../dist/index.js";

const enabledMetricBands = [
  { leadBand: "001-024", metric: "windGustMps" },
  { leadBand: "001-024", metric: "windSpeedMps" },
];

// build one valid speed-and-gust candidate
function createCandidate() {
  return createForecastAdjustmentWindCanaryCandidate({
    coefficients: enabledMetricBands.map((pair) => ({
      coefficient: pair.metric === "windSpeedMps" ? 2 : 3,
      daypart: null,
      effectiveEventCount: 250,
      leadBand: pair.leadBand,
      level: 1,
      metric: pair.metric,
      month: null,
      season: null,
    })),
    enabledMetricBands,
    exportManifestSha256: "a".repeat(64),
    finalTrainingCutoff: "2026-08-31T23:59:59.999Z",
    runtimeFingerprint: runtimeCalendarFingerprint(),
    servedForecastIdentity: FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    trainingEnvelopes: enabledMetricBands.map((pair) => ({
      leadBand: pair.leadBand,
      maximum: 20,
      metric: pair.metric,
      minimum: 0,
    })),
    trainingForecastIdentity:
      FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1,
    trainingProvenance:
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  });
}

// build one positive thirty-event bridge report
function createReport(candidate = createCandidate()) {
  return createForecastAdjustmentWindCanaryTransferReport({
    bridgeEndExclusive: "2026-09-03T06:00:00.000Z",
    bridgeEvaluations: candidate.enabledMetricBands.map((metricBand) => ({
      metricBand,
      network: {
        adjustedLoss: 8,
        eventCount: 30,
        rawLoss: 10,
        skill: 0.2,
      },
    })),
    bridgeStartInclusive: "2026-09-01T07:00:00.000Z",
    candidate,
  });
}

// build one explicitly authorized bundle
function createBundle() {
  const candidate = createCandidate();
  const transferReport = createReport(candidate);
  const authorization = createForecastAdjustmentWindCanaryAuthorization({
    activatedAt: "2026-09-03T07:00:00.000Z",
    authorizationReason: "operator-approved wind-only production canary",
    authorizedAt: "2026-09-03T06:55:00.000Z",
    authorizedBy: "ansel",
    candidate,
    expiresAt: "2026-09-10T07:00:00.000Z",
    transferReport,
  });
  return createForecastAdjustmentWindCanaryRuntimeBundle({
    authorization,
    candidate,
    transferReport,
  });
}

// build one complete canonical raw forecast
function rawMetrics() {
  return {
    apparentTemperatureC: 19,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: 25,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: 0,
    precipitationRateMmPerHour: null,
    pressureHpa: 1010,
    relativeHumidityPercent: 77,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: 18,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: 240,
    windGustMps: 8,
    windSpeedMps: 5,
  };
}

// build one exact served forecast provenance record
function rawProvenance() {
  return {
    ...FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    referenceAt: "2026-09-03T07:30:00.000Z",
    targetLeadHours: 24,
    validAt: "2026-09-04T07:00:00.000Z",
  };
}

// publish one isolated canary runtime tree
async function writeRuntimeTree(root, bundle) {
  const directory = join(root, "ballydidean", "wind-canary-bundles");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `sha256-${bundle.bundleSha256}.json`),
    canonicalJsonBytes(bundle),
  );
  await writeFile(
    join(root, "ballydidean-wind-canary.json"),
    canonicalJsonBytes({
      activeBundle: {
        authorizationSha256: bundle.authorization.authorizationSha256,
        bundleSha256: bundle.bundleSha256,
        candidateArtifactSha256: bundle.candidate.candidateArtifactSha256,
        path: `wind-canary-bundles/sha256-${bundle.bundleSha256}.json`,
        transferReportSha256: bundle.transferReport.transferReportSha256,
      },
      contractVersion: "forecast-adjustment-wind-canary-registry/v1",
    }),
  );
}

test("wind canary keeps temperature, humidity, and direction raw", () => {
  const bundle = createBundle();
  const decision = applyForecastAdjustment(
    { bundle, reasonCode: null, state: "active" },
    {
      evaluatedAt: "2026-09-03T08:00:00.000Z",
      metrics: rawMetrics(),
      rawForecastProvenance: rawProvenance(),
    },
  );
  assert.equal(decision.state, "active");
  assert.equal(decision.activationKind, "wind_transfer_canary");
  assert.deepEqual(decision.appliedMetrics, ["windGustMps", "windSpeedMps"]);
  assert.deepEqual(decision.adjustedMetrics, {
    windGustMps: 11,
    windSpeedMps: 7,
  });
  assert.equal("temperatureC" in decision.adjustedMetrics, false);
  assert.equal("relativeHumidityPercent" in decision.adjustedMetrics, false);
  assert.equal("windDirectionDegrees" in decision.adjustedMetrics, false);
  assert.equal("qualificationReceiptSha256" in decision, false);
});

test("wind canary rejects rehashed non-wind candidate material", () => {
  const original = createCandidate();
  const injectedBand = { leadBand: "001-024", metric: "temperatureC" };
  const coefficients = [
    ...original.coefficients,
    {
      coefficient: 1,
      daypart: null,
      effectiveEventCount: 250,
      leadBand: "001-024",
      level: 1,
      metric: "temperatureC",
      month: null,
      season: null,
    },
  ];
  const candidate = {
    ...original,
    coefficientPayloadSha256: canonicalSha256(coefficients),
    coefficients,
    enabledMetricBands: [...original.enabledMetricBands, injectedBand],
    trainingEnvelopes: [
      ...original.trainingEnvelopes,
      { ...injectedBand, maximum: 40, minimum: -10 },
    ],
  };
  candidate.candidateArtifactSha256 = canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  assert.throws(
    () => verifyForecastAdjustmentWindCanaryCandidate(candidate),
    /wind canary enabled set is invalid/u,
  );
});

test("wind canary rejects a rehashed parallel training identity", () => {
  const original = createCandidate();
  const candidate = {
    ...original,
    trainingForecastIdentity: {
      ...original.trainingForecastIdentity,
      sourceKey: "parallel-previous-runs",
    },
  };
  candidate.candidateArtifactSha256 = canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  assert.throws(
    () => verifyForecastAdjustmentWindCanaryCandidate(candidate),
    /lineage is not canonical/u,
  );
});

test("wind canary requires thirty bridge events per enabled band", () => {
  const candidate = createCandidate();
  const original = createReport(candidate);
  const bridgeEvaluations = original.bridgeEvaluations.map((evaluation, index) =>
    index === 0
      ? { ...evaluation, network: { ...evaluation.network, eventCount: 29 } }
      : evaluation,
  );
  const report = { ...original, bridgeEvaluations };
  report.transferReportSha256 = canonicalObjectSha256(
    report,
    "transferReportSha256",
  );
  assert.throws(
    () => verifyForecastAdjustmentWindCanaryTransferReport(report, candidate),
    /bridge score is not positive finite evidence/u,
  );
});

test("wind canary authorization rejects windows longer than fourteen days", () => {
  const candidate = createCandidate();
  const transferReport = createReport(candidate);
  assert.throws(
    () =>
      createForecastAdjustmentWindCanaryAuthorization({
        activatedAt: "2026-09-03T07:00:00.000Z",
        authorizationReason: "operator-approved wind-only production canary",
        authorizedAt: "2026-09-03T06:55:00.000Z",
        authorizedBy: "ansel",
        candidate,
        expiresAt: "2026-09-17T07:00:00.001Z",
        transferReport,
      }),
    /authorization window is invalid/u,
  );
});

test("wind canary rejects a fully rehashed extended authorization", () => {
  const original = createBundle();
  const authorization = {
    ...original.authorization,
    expiresAt: "2026-09-17T07:00:00.001Z",
  };
  authorization.authorizationSha256 = canonicalObjectSha256(
    authorization,
    "authorizationSha256",
  );
  const bundle = { ...original, authorization };
  bundle.bundleSha256 = canonicalObjectSha256(bundle, "bundleSha256");
  assert.throws(
    () => verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle),
    /authorization window is invalid/u,
  );
});

test("wind canary runtime expires at the exclusive deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-wind-canary-expiry-"));
  const bundle = createBundle();
  await writeRuntimeTree(root, bundle);
  assert.equal(
    forecastAdjustmentWindCanaryIsActiveAt(
      bundle,
      "2026-09-10T06:59:59.999Z",
    ),
    true,
  );
  assert.equal(
    forecastAdjustmentWindCanaryIsActiveAt(
      bundle,
      "2026-09-10T07:00:00.000Z",
    ),
    false,
  );
  assert.deepEqual(
    await createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(root, {
      now: () => "2026-09-10T07:00:00.000Z",
    }).load(),
    { bundle: null, reasonCode: "canary_expired", state: "disabled" },
  );
  assert.deepEqual(
    applyForecastAdjustment(
      { bundle, reasonCode: null, state: "active" },
      {
        evaluatedAt: "2026-09-10T07:00:00.000Z",
        metrics: rawMetrics(),
        rawForecastProvenance: rawProvenance(),
      },
    ),
    {
      adjustedMetrics: {},
      appliedMetrics: [],
      contractVersion: "forecast-adjustment-decision/v1",
      reasonCode: "canary_expired",
      state: "disabled",
    },
  );
});

test("wind canary kill switch only disables and fails raw", async () => {
  assert.equal(forecastAdjustmentWindCanaryIsKilled("1"), true);
  assert.equal(forecastAdjustmentWindCanaryIsKilled("0"), false);
  assert.equal(forecastAdjustmentWindCanaryIsKilled(undefined), false);
  const runtime = await createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(
    "/does/not/need/to/exist",
    { environmentKillSwitch: "1" },
  ).load();
  assert.deepEqual(runtime, {
    bundle: null,
    reasonCode: "canary_killed",
    state: "disabled",
  });
  assert.deepEqual(
    applyForecastAdjustment(runtime, {
      metrics: rawMetrics(),
      rawForecastProvenance: rawProvenance(),
    }),
    {
      adjustedMetrics: {},
      appliedMetrics: [],
      contractVersion: "forecast-adjustment-decision/v1",
      reasonCode: "canary_killed",
      state: "disabled",
    },
  );
});

test("committed wind canary loads only speed and gust", async () => {
  const root = resolve(
    import.meta.dirname,
    "../../../config/forecast-adjustments",
  );
  const registry = JSON.parse(
    await readFile(join(root, "ballydidean-wind-canary.json"), "utf8"),
  );
  const bundle = JSON.parse(
    await readFile(
      join(root, "ballydidean", registry.activeBundle.path),
      "utf8",
    ),
  );
  const runtime = await createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(
    root,
    { now: () => bundle.authorization.activatedAt },
  ).load();
  assert.equal(runtime.state, "active");
  assert.deepEqual(
    [...new Set(runtime.bundle.candidate.enabledMetricBands.map(
      // retain the deployed metric allowlist
      (pair) => pair.metric,
    ))].sort(),
    ["windGustMps", "windSpeedMps"],
  );
});
