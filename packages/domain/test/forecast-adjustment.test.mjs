import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1,
  FORECAST_ADJUSTMENT_CONTRACT_VERSIONS,
  FORECAST_ADJUSTMENT_METRICS,
  FORECAST_ADJUSTMENT_METRIC_POLICIES_V1,
  FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES,
  FORECAST_ADJUSTMENT_REASON_CODES,
  FORECAST_OBSERVATION_MANIFEST_V1,
  FORECAST_OBSERVATION_EXCLUDED_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATION_KEYS,
  FORECAST_OBSERVATION_STATIONS,
  PROVIDER_BALANCED_LOSO_CONTRACT_V1,
  canTransitionForecastAdjustmentLifecycle,
  canonicalizeJson,
  createForecastAdjustmentFailRawDecision,
  createForecastNetworkEventIdentity,
  forecastLeadBandFor,
  forecastNetworkEventKey,
  validateForecastAdjustmentRegistry,
  validateForecastAdjustmentActiveDecision,
  validateForecastAdjustmentRuntimeBundleLinks,
  validateMetricValue,
  validatePromotableForecastAdjustmentEvidence,
} from "../dist/index.js";

const frozenObservationHashes = {
  aggregation_contract_sha256:
    "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
  coordinate_manifest_sha256:
    "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
  metric_eligibility_sha256:
    "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
  source_lineage_sha256:
    "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
  spatial_weights_sha256:
    "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
  station_manifest_sha256:
    "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
};

const aggregationProjectionExcludedKeys = new Set([
  "earthRadiusMeters",
  "eligibleMetrics",
  "excludedSourceLineages",
  "site",
  "sourceLineages",
  "spatialFormula",
  "spatialNormalizationOrder",
  "spatialScaleMeters",
  "stations",
]);

// hash canonical UTF-8 without a trailing LF
function hashObservationProjection(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

// derive disjoint provenance projections from the domain manifest
function observationHashProjections() {
  return {
    aggregation_contract_sha256: Object.fromEntries(
      Object.entries(FORECAST_OBSERVATION_MANIFEST_V1).filter(
        // exclude separately hashed manifest dimensions
        ([key]) => !aggregationProjectionExcludedKeys.has(key),
      ),
    ),
    coordinate_manifest_sha256: {
      site: FORECAST_OBSERVATION_MANIFEST_V1.site,
      stations: FORECAST_OBSERVATION_MANIFEST_V1.stations.map(
        // retain only coordinate identity
        ({ key, latitude, longitude }) => ({ key, latitude, longitude }),
      ),
    },
    metric_eligibility_sha256: FORECAST_OBSERVATION_MANIFEST_V1.eligibleMetrics,
    source_lineage_sha256: {
      accepted: FORECAST_OBSERVATION_MANIFEST_V1.sourceLineages,
      excluded: FORECAST_OBSERVATION_MANIFEST_V1.excludedSourceLineages,
    },
    spatial_weights_sha256: {
      earthRadiusMeters: FORECAST_OBSERVATION_MANIFEST_V1.earthRadiusMeters,
      spatialFormula: FORECAST_OBSERVATION_MANIFEST_V1.spatialFormula,
      spatialNormalizationOrder:
        FORECAST_OBSERVATION_MANIFEST_V1.spatialNormalizationOrder,
      spatialScaleMeters: FORECAST_OBSERVATION_MANIFEST_V1.spatialScaleMeters,
      stations: FORECAST_OBSERVATION_MANIFEST_V1.stations.map(
        // retain only spatial identity
        ({ distanceMeters, key, nearestRank, unnormalizedSpatialWeight }) => ({
          distanceMeters,
          key,
          nearestRank,
          unnormalizedSpatialWeight,
        }),
      ),
    },
    station_manifest_sha256: FORECAST_OBSERVATION_MANIFEST_V1.stations,
  };
}

// read one uniquely bound SQL manifest digest
function migrationManifestHash(source, fieldName) {
  const matches = [
    ...source.matchAll(
      new RegExp(
        `'([a-f0-9]{64})'::char\\(64\\)\\s+AS ${fieldName}\\b`,
        "gu",
      ),
    ),
  ];
  assert.equal(matches.length, 1, `${fieldName} must have one SQL binding`);
  return matches[0][1];
}

// read one uniquely bound package manifest digest
function packageManifestHash(source, fieldName) {
  const matches = [
    ...source.matchAll(
      new RegExp(`\\b${fieldName}:\\s*"([a-f0-9]{64})"`, "gu"),
    ),
  ];
  assert.equal(matches.length, 1, `${fieldName} must have one package binding`);
  return matches[0][1];
}

const hashes = {
  aggregation: "0".repeat(64),
  bundle: "1".repeat(64),
  candidate: "2".repeat(64),
  coefficients: "3".repeat(64),
  coordinates: "4".repeat(64),
  development: "5".repeat(64),
  evaluation: "6".repeat(64),
  exportManifest: "7".repeat(64),
  marker: "8".repeat(64),
  metricEligibility: "9".repeat(64),
  preregistration: "a".repeat(64),
  qualification: "b".repeat(64),
  redundancy: "c".repeat(64),
  sourceFingerprint: "d".repeat(64),
  sourceLineage: "e".repeat(64),
  spatialWeight: "f".repeat(64),
  stationManifest: "0a".repeat(32),
};

const trainingProvenance = {
  aggregationContractSha256: hashes.aggregation,
  coordinateManifestSha256: hashes.coordinates,
  metricEligibilitySha256: hashes.metricEligibility,
  observationSourceLineageSha256: hashes.sourceLineage,
  observationStationManifestSha256: hashes.stationManifest,
  spatialWeightSha256: hashes.spatialWeight,
};

const enabledMetricBands = [
  { leadBand: "001-024", metric: "temperatureC" },
];

// build one internally linked evidence triple
function createEvidenceTriple() {
  const candidate = {
    algorithmContractVersion: "robust-hierarchical-median/v1",
    candidateArtifactSha256: hashes.candidate,
    coefficientPayloadSha256: hashes.coefficients,
    coefficients: [
      {
        coefficient: 1,
        daypart: null,
        effectiveEventCount: 200,
        leadBand: "001-024",
        level: 1,
        metric: "temperatureC",
        month: null,
        season: null,
      },
    ],
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.candidate,
    developmentReportSha256: hashes.development,
    enabledMetricBands,
    evaluationEpochId: "epoch-2026-09",
    exportManifestSha256: hashes.exportManifest,
    finalTrainingCutoff: "2026-01-07T08:00:00.000Z",
    forecastIdentity: {
      adapterVersion: "open-meteo-forecast/v4",
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch: "forecast-daily/v4:source-fingerprint",
      dataset: "forecast",
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: hashes.sourceFingerprint,
      sourceKey: "open-meteo-forecast-v4",
      upstreamModel: "best_match",
    },
    metricPolicies: FORECAST_ADJUSTMENT_METRIC_POLICIES_V1,
    runtimeFingerprint: { icuVersion: "76.1", tzdataVersion: "2025b" },
    siteKey: "ballydidean",
    timezone: "America/Los_Angeles",
    trainingEnvelopes: [
      {
        leadBand: "001-024",
        maximum: 20,
        metric: "temperatureC",
        minimum: -2,
      },
    ],
    trainingProvenance,
  };
  const pairedScore = {
    adjustedLoss: 0.9,
    bootstrapLowerBound: 0.01,
    bootstrapUpperBound: 0.2,
    eventCount: 500,
    rawLoss: 1,
    skill: 0.1,
  };
  // build every minimum required slice
  const criticalSlices = [
    { key: "nearest-three", kind: "nearest_three" },
    { key: "ambient", kind: "provider_family" },
    { key: "ecowitt", kind: "provider_family" },
    { key: "tempest", kind: "provider_family" },
    { key: "winter-night", kind: "season_daypart" },
    { key: "ambient-maxweather", kind: "station" },
    { key: "ambient-merlin", kind: "station" },
    { key: "ballydidean-ecowitt", kind: "station" },
    { key: "tempest-38270", kind: "station" },
    { key: "tempest-64255", kind: "station" },
  ].map((slice) => ({ ...pairedScore, ...slice }));
  const evaluationReport = {
    candidateArtifactSha256: hashes.candidate,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.evaluationReport,
    enabledMetricBands,
    evaluationEpochId: "epoch-2026-09",
    evaluationReportSha256: hashes.evaluation,
    holdoutAccessMarkerSha256: hashes.marker,
    holdoutEndExclusive: "2026-02-07T08:00:00.000Z",
    holdoutEndLocalDate: "2026-02-06",
    holdoutStartInclusive: "2026-01-08T08:00:00.000Z",
    holdoutStartLocalDate: "2026-01-08",
    metricBandEvaluations: [
      {
        criticalSlices,
        ecowittCompleteLocalDates: 30,
        ecowittMetricBandMatches: 100,
        ecowittMetricMatches: 500,
        ecowittTargetSite: pairedScore,
        evaluatedSeasonDaypartKeys: ["winter-night"],
        metricBand: enabledMetricBands[0],
        network: pairedScore,
        providerBalanced: pairedScore,
        scoreableStationKeys: [
          "ambient-maxweather",
          "ambient-merlin",
          "ballydidean-ecowitt",
          "tempest-38270",
          "tempest-64255",
        ],
      },
    ],
    preregistrationSha256: hashes.preregistration,
    trainingProvenance,
  };
  const qualificationReceipt = {
    candidateArtifactSha256: hashes.candidate,
    contractVersion:
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.qualificationReceipt,
    enabledMetricBands,
    evaluationEpochId: "epoch-2026-09",
    evaluationReportSha256: hashes.evaluation,
    evidenceRedundancy: {
      attestationSha256: hashes.redundancy,
      status: "restorable_encrypted_backup",
      verified: true,
    },
    // record every required gate
    gates: FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES.map((name) => ({
      metricBand: enabledMetricBands[0],
      name,
      passed: true,
      reasonCode: null,
    })),
    holdoutAccessMarkerSha256: hashes.marker,
    lifecycleState: "qualified",
    passed: true,
    preregistrationSha256: hashes.preregistration,
    qualificationReceiptSha256: hashes.qualification,
    trainingProvenance,
  };

  return { candidate, evaluationReport, qualificationReceipt };
}

// verify exact physical-station and metric population
test("U-MOS-01 and U-MOS-03 freeze eleven compatible physical stations", () => {
  assert.equal(FORECAST_OBSERVATION_STATION_KEYS.length, 11);
  assert.deepEqual(
    FORECAST_OBSERVATION_STATION_KEYS,
    [...FORECAST_OBSERVATION_STATION_KEYS].sort(),
  );
  assert.deepEqual(
    FORECAST_OBSERVATION_STATIONS.map((station) => station.key),
    FORECAST_OBSERVATION_STATION_KEYS,
  );

  // inspect every physical station
  for (const station of FORECAST_OBSERVATION_STATIONS) {
    assert.deepEqual(station.eligibleMetrics, FORECAST_ADJUSTMENT_METRICS);
    assert.ok(station.unnormalizedSpatialWeight > 0);
  }

  assert.equal(
    FORECAST_OBSERVATION_STATION_KEYS.includes("purpleair-samara"),
    false,
  );
  assert.equal(FORECAST_ADJUSTMENT_METRICS.includes("apparentTemperatureC"), false);
  assert.equal(FORECAST_ADJUSTMENT_METRICS.includes("pressureHpa"), false);
});

// verify exact cutovers, fingerprints, and quality rules
test("U-MOS-02 freezes source lineages and MaxWeather boundary ownership", () => {
  assert.equal(FORECAST_OBSERVATION_SOURCE_LINEAGES.length, 12);

  // inspect every checked source
  for (const source of FORECAST_OBSERVATION_SOURCE_LINEAGES) {
    assert.match(source.checkedFingerprint, /^[a-f0-9]{64}$/u);
  }

  const ambient = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    (source) => source.sourceKey === "ambient-maxweather-observations-v1",
  );
  const wunderground = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    (source) => source.sourceKey === "wunderground-maxweather-history-v1",
  );
  const tempest = FORECAST_OBSERVATION_SOURCE_LINEAGES.filter(
    (source) => source.adapterContract === "tempest-observations/v2",
  );

  assert.equal(ambient?.acceptedStartInclusive, "2026-08-24T00:00:00Z");
  assert.equal(wunderground?.acceptedEndExclusive, "2026-08-24T00:00:00Z");
  assert.equal(wunderground?.qualityRule.statusRule, "absent_or_provider_qc_1");
  assert.equal(tempest.length, 7);
  assert.equal(FORECAST_OBSERVATION_EXCLUDED_SOURCE_LINEAGES.length, 7);

  // inspect every Tempest supersession
  for (const source of tempest) {
    assert.deepEqual(source.qualityRule.allowedFlags, ["uv_index_out_of_range"]);
    assert.deepEqual(source.supersededSourceKeys, [
      source.sourceKey.replace(/-v2$/u, "-v1"),
    ]);
  }

  // inspect every empty Tempest v1 interval
  for (const source of FORECAST_OBSERVATION_EXCLUDED_SOURCE_LINEAGES) {
    assert.deepEqual(source.acceptedIntervals, []);
    assert.equal(source.reasonCode, "source_superseded");
    assert.equal(source.successorSourceKey, source.sourceKey.replace(/-v1$/u, "-v2"));
  }
});

// verify literal spatial constants and nearest-three identities
test("U-MOS-07 freezes Haversine and positive distance weighting inputs", () => {
  assert.equal(FORECAST_OBSERVATION_MANIFEST_V1.earthRadiusMeters, 6_371_008.8);
  assert.equal(FORECAST_OBSERVATION_MANIFEST_V1.spatialScaleMeters, 2_000);
  assert.equal(FORECAST_OBSERVATION_MANIFEST_V1.minimumEligibleStations, 3);
  assert.equal(FORECAST_OBSERVATION_MANIFEST_V1.nearestEligibleStationCount, 3);
  assert.deepEqual(
    FORECAST_OBSERVATION_STATIONS
      .filter((station) => station.nearestRank <= 3)
      .map((station) => station.key)
      .sort(),
    ["ambient-merlin", "ballydidean-ecowitt", "tempest-64255"],
  );
  assert.equal(
    FORECAST_OBSERVATION_STATIONS.find(
      (station) => station.key === "ballydidean-ecowitt",
    )?.unnormalizedSpatialWeight,
    1,
  );
});

// verify independent logical projections and every frozen consumer
test("U-MOS-14 derives canonical observation provenance hashes", () => {
  const computedHashes = Object.fromEntries(
    Object.entries(observationHashProjections()).map(
      // hash every disjoint projection
      ([fieldName, projection]) => [fieldName, hashObservationProjection(projection)],
    ),
  );
  assert.deepEqual(computedHashes, frozenObservationHashes);

  const migrationSource = readFileSync(
    new URL(
      "../../database/migrations/0010_forecast_training_export.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const packageSource = readFileSync(
    new URL("../../../deploy/scripts/forecast-training-package.mjs", import.meta.url),
    "utf8",
  );
  const migrationHashes = Object.fromEntries(
    Object.keys(frozenObservationHashes).map(
      // inspect every SQL digest binding
      (fieldName) => [fieldName, migrationManifestHash(migrationSource, fieldName)],
    ),
  );
  const packageHashes = Object.fromEntries(
    Object.keys(frozenObservationHashes).map(
      // inspect every package digest binding
      (fieldName) => [fieldName, packageManifestHash(packageSource, fieldName)],
    ),
  );

  assert.deepEqual(migrationHashes, computedHashes);
  assert.deepEqual(packageHashes, computedHashes);
});

// verify exhaustive lead-band membership
test("U-MOS-13 maps exactly the integer leads 1 through 168", () => {
  // inspect every eligible lead
  for (let lead = 1; lead <= 168; lead += 1) {
    assert.match(forecastLeadBandFor(lead), /^\d{3}-\d{3}$/u);
  }

  assert.equal(forecastLeadBandFor(1), "001-024");
  assert.equal(forecastLeadBandFor(24), "001-024");
  assert.equal(forecastLeadBandFor(25), "025-048");
  assert.equal(forecastLeadBandFor(168), "145-168");
  assert.throws(() => forecastLeadBandFor(0), /between 1 and 168/u);
  assert.throws(() => forecastLeadBandFor(169), /between 1 and 168/u);
  assert.throws(() => forecastLeadBandFor(1.5), /integer/u);
});

// verify cohort-aware equal-event identity
test("U-MOS-10 and U-MOS-11 network identity keeps cohorts disjoint", () => {
  const anchor = createForecastNetworkEventIdentity({
    cohort: "fixed_lead_anchor",
    metric: "temperatureC",
    referenceKind: "fixed_lead_anchor",
    targetLeadHours: 24,
    validAt: "2026-08-23T04:00:00.000Z",
  });
  const retrieval = createForecastNetworkEventIdentity({
    cohort: "legacy_v4_retrieval_snapshot",
    metric: "temperatureC",
    referenceKind: "retrieval_snapshot",
    targetLeadHours: 24,
    validAt: "2026-08-23T04:00:00.000Z",
  });

  assert.notEqual(forecastNetworkEventKey(anchor), forecastNetworkEventKey(retrieval));
  assert.throws(
    () =>
      createForecastNetworkEventIdentity({
        ...anchor,
        cohort: "legacy_v4_retrieval_snapshot",
      }),
    /do not match/u,
  );
});

// verify development-only LOSO and strict target-site gates
test("U-MOD-10 and U-MOD-22 freeze provider-balanced and Ecowitt thresholds", () => {
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.developmentOnly, true);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationTrainingMatches, 500);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationScoreMatches, 100);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumRemainingNetworkScoreEvents, 100);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumScoreableStationsPerFold, 5);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumProviderFamiliesPerFold, 3);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumImprovementFraction, 0.02);
  assert.equal(PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumNonnegativeStationFraction, 0.8);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.minimumCompleteLocalDates, 30);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.minimumMetricMatches, 500);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.minimumMetricBandMatches, 100);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.minimumImprovementFraction, 0.02);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.minimumPointSkillExclusive, 0);
  assert.equal(ECOWITT_TARGET_SITE_QUALIFICATION_CONTRACT_V1.bootstrapLowerBoundExclusive, 0);
});

// verify lifecycle and bounded fail-raw vocabulary
test("U-MOD-13 lifecycle never auto-activates and fail-raw stays empty", () => {
  assert.equal(canTransitionForecastAdjustmentLifecycle("candidate", "qualified"), true);
  assert.equal(canTransitionForecastAdjustmentLifecycle("qualified", "active"), true);
  assert.equal(canTransitionForecastAdjustmentLifecycle("candidate", "active"), false);
  assert.equal(canTransitionForecastAdjustmentLifecycle("active", "retired"), true);
  assert.equal(canTransitionForecastAdjustmentLifecycle("retired", "active"), false);
  assert.equal(new Set(FORECAST_ADJUSTMENT_REASON_CODES).size, FORECAST_ADJUSTMENT_REASON_CODES.length);

  const disabled = createForecastAdjustmentFailRawDecision(
    "disabled",
    "registry_inactive",
  );
  assert.deepEqual(disabled.adjustedMetrics, {});
  assert.deepEqual(disabled.appliedMetrics, []);
  assert.equal(disabled.state, "disabled");
});

// verify separate immutable evidence cross-links
test("U-MOD-16 validates exact candidate, report, and receipt links", () => {
  const evidence = createEvidenceTriple();
  assert.doesNotThrow(() => validatePromotableForecastAdjustmentEvidence(evidence));
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        candidate: {
          ...evidence.candidate,
          evaluationReportSha256: hashes.evaluation,
        },
      }),
    /candidate does not match its exact schema/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          candidateArtifactSha256: "f".repeat(64),
        },
      }),
    /candidate cross-link/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        qualificationReceipt: {
          ...evidence.qualificationReceipt,
          evidenceRedundancy: {
            ...evidence.qualificationReceipt.evidenceRedundancy,
            verified: false,
          },
        },
      }),
    /redundancy/u,
  );
});

// verify adversarial nested evidence rejection
test("U-MOD-12, U-MOD-16, and U-MOD-22 reject incomplete nested evidence", () => {
  const evidence = createEvidenceTriple();

  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        candidate: {
          ...evidence.candidate,
          coefficients: [],
        },
      }),
    /exactly one root/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        candidate: {
          ...evidence.candidate,
          trainingEnvelopes: [],
        },
      }),
    /requires one training envelope/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [],
        },
      }),
    /evaluation coverage/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [
            {
              ...evidence.evaluationReport.metricBandEvaluations[0],
              network: {
                ...evidence.evaluationReport.metricBandEvaluations[0].network,
                invented: true,
              },
            },
          ],
        },
      }),
    /network score does not match its exact schema/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [
            {
              ...evidence.evaluationReport.metricBandEvaluations[0],
              criticalSlices: [],
            },
          ],
        },
      }),
    /critical slice coverage cardinality mismatch/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          holdoutStartLocalDate: "2026-02-30",
        },
      }),
    /valid local date/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          holdoutEndExclusive: "2026-01-01T00:00:00.000Z",
        },
      }),
    /increasing/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [
            {
              ...evidence.evaluationReport.metricBandEvaluations[0],
              ecowittCompleteLocalDates: 29,
            },
          ],
        },
      }),
    /promotable thresholds/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        qualificationReceipt: {
          ...evidence.qualificationReceipt,
          gates: evidence.qualificationReceipt.gates.slice(0, -1),
        },
      }),
    /gate cardinality/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        qualificationReceipt: {
          ...evidence.qualificationReceipt,
          passed: false,
        },
      }),
    /state does not match/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        candidate: {
          ...evidence.candidate,
          enabledMetricBands: [],
        },
      }),
    /between 1 and 35/u,
  );
});

// verify critical slices bind exact frozen identity sets
test("U-MOD-16 critical slices reject every invented or substituted identity", () => {
  const evidence = createEvidenceTriple();
  assert.doesNotThrow(() => validatePromotableForecastAdjustmentEvidence(evidence));
  const mutations = [
    { inventedKey: "invented-nearest", kind: "nearest_three" },
    { inventedKey: "invented-provider", kind: "provider_family" },
    { inventedKey: "invented-season", kind: "season_daypart" },
    { inventedKey: "invented-station", kind: "station" },
  ];

  // reject every invented slice identity
  for (const mutation of mutations) {
    const criticalSlices =
      evidence.evaluationReport.metricBandEvaluations[0].criticalSlices.map(
        (slice) =>
          slice.kind === mutation.kind
            ? { ...slice, key: mutation.inventedKey }
            : slice,
      );

    assert.throws(
      () =>
        validatePromotableForecastAdjustmentEvidence({
          ...evidence,
          evaluationReport: {
            ...evidence.evaluationReport,
            metricBandEvaluations: [
              {
                ...evidence.evaluationReport.metricBandEvaluations[0],
                criticalSlices,
              },
            ],
          },
        }),
      /critical slice identity or coverage mismatch/u,
    );
  }

  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [
            {
              ...evidence.evaluationReport.metricBandEvaluations[0],
              scoreableStationKeys: [
                "ambient-maxweather",
                "ambient-merlin",
                "ballydidean-ecowitt",
                "tempest-225947",
                "tempest-38270",
              ],
            },
          ],
        },
      }),
    /critical slice identity or coverage mismatch/u,
  );
  assert.throws(
    () =>
      validatePromotableForecastAdjustmentEvidence({
        ...evidence,
        evaluationReport: {
          ...evidence.evaluationReport,
          metricBandEvaluations: [
            {
              ...evidence.evaluationReport.metricBandEvaluations[0],
              evaluatedSeasonDaypartKeys: ["winter-evening"],
            },
          ],
        },
      }),
    /critical slice identity or coverage mismatch/u,
  );
});

// verify active decisions carry bounded raw provenance and algorithm identity
test("U-MOD-13 active decisions expose exact algorithm and raw forecast provenance", () => {
  const decision = {
    adjustedMetrics: { temperatureC: 10 },
    algorithmContractVersion: "robust-hierarchical-median/v1",
    appliedMetrics: ["temperatureC"],
    candidateArtifactSha256: hashes.candidate,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision,
    evaluationReportSha256: hashes.evaluation,
    leadBand: "001-024",
    qualificationReceiptSha256: hashes.qualification,
    rawForecastProvenance: {
      adapterVersion: "open-meteo-forecast/v4",
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch: "forecast-daily/v4:source-fingerprint",
      dataset: "forecast",
      referenceAt: "2026-08-22T04:00:00.000Z",
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: hashes.sourceFingerprint,
      sourceKey: "open-meteo-forecast-v4",
      targetLeadHours: 24,
      upstreamModel: "best_match",
      validAt: "2026-08-23T04:00:00.000Z",
    },
    reasonCode: null,
    state: "active",
  };

  assert.doesNotThrow(() => validateForecastAdjustmentActiveDecision(decision));
  assert.equal(decision.algorithmContractVersion, "robust-hierarchical-median/v1");
  assert.equal(decision.rawForecastProvenance.referenceKind, "retrieval_snapshot");
  assert.throws(
    () =>
      validateForecastAdjustmentActiveDecision({
        ...decision,
        rawForecastProvenance: {
          ...decision.rawForecastProvenance,
          referenceAt: "2026-08-24T04:00:00.000Z",
        },
      }),
    /lead identity mismatch/u,
  );
  assert.throws(
    () =>
      validateForecastAdjustmentActiveDecision({
        ...decision,
        algorithmContractVersion: "invented/v2",
      }),
    /identity mismatch/u,
  );
});

// verify inactive and exact active registry contracts
test("U-BND-03 registry and runtime bundle links are exact and fail closed", () => {
  const inactive = {
    activeBundle: null,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.registry,
  };
  const evidence = createEvidenceTriple();
  const registry = {
    activeBundle: {
      bundleSha256: hashes.bundle,
      candidateArtifactSha256: hashes.candidate,
      evaluationReportSha256: hashes.evaluation,
      path: `bundles/sha256-${hashes.bundle}.json`,
      qualificationReceiptSha256: hashes.qualification,
    },
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.registry,
  };
  const bundle = {
    ...evidence,
    bundleSha256: hashes.bundle,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.runtimeBundle,
    siteKey: "ballydidean",
    timezone: "America/Los_Angeles",
  };

  assert.doesNotThrow(() => validateForecastAdjustmentRegistry(inactive));
  assert.doesNotThrow(() => validateForecastAdjustmentRuntimeBundleLinks(registry, bundle));
  assert.throws(
    () =>
      validateForecastAdjustmentRegistry({
        ...registry,
        activeBundle: { ...registry.activeBundle, path: "../bundle.json" },
      }),
    /path/u,
  );
  assert.throws(
    () =>
      validateForecastAdjustmentRuntimeBundleLinks(registry, {
        ...bundle,
        qualificationReceipt: {
          ...bundle.qualificationReceipt,
          qualificationReceiptSha256: "f".repeat(64),
        },
      }),
    /cross-link/u,
  );
});

// verify reusable canonical metric bounds
test("U-MOD-14 canonical metric bounds are reusable at adjustment boundaries", () => {
  assert.doesNotThrow(() => validateMetricValue("temperatureC", 70));
  assert.doesNotThrow(() => validateMetricValue("windDirectionDegrees", 359.999));
  assert.throws(
    () => validateMetricValue("temperatureC", 70.01),
    /between -100 and 70/u,
  );
  assert.throws(
    () => validateMetricValue("windDirectionDegrees", 360),
    /less than 360/u,
  );
});
