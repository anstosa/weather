import {
  createEvidenceRedundancyAttestation,
  canonicalSha256,
  createDevelopmentReport,
  evaluateDevelopmentLosoFold,
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  createForecastAdjustmentCandidate,
  createForecastAdjustmentEvaluationReport,
  createForecastAdjustmentPreregistration,
  createForecastAdjustmentQualificationReceipt,
  runtimeCalendarFingerprint,
  withGuardedHoldoutAccess,
} from "../dist/index.js";

// build one repeated hexadecimal fixture hash
const hash = (character) => character.repeat(64);

// build one canonical retained snapshot fixture
export function createSnapshotFixture() {
  return { contractVersion: "forecast-training-evidence-fixture/v1", fixture: true };
}

// build one immutable passing development report
export function createDevelopmentFixture() {
  const stationScores = [
    ["ambient-maxweather", "ambient"],
    ["ballydidean-ecowitt", "ecowitt"],
    ["netatmo-nearby", "netatmo"],
    ["tempest-126537", "tempest"],
    ["tempest-168853", "tempest"],
  ].map(([physicalStationKey, providerFamily]) => ({
    adjustedLoss: 9,
    eventCount: 100,
    physicalStationKey,
    pointSkill: 0.1,
    providerFamily,
    rawLoss: 10,
    remainingNetworkScoreEvents: 100,
    scoreMatches: 100,
    trainingMatches: 500,
  }));
  return createDevelopmentReport({
    enabledMetricBands: [{ leadBand: "001-024", metric: "temperatureC" }],
    folds: [1, 2, 3, 4, 5].map((fold) =>
      evaluateDevelopmentLosoFold({
        auxiliaryModelSha256s: ["1", "2", "3", "4", "5"].map((value) =>
          hash(value),
        ),
        bootstrapLowerBound: 0.01,
        fold,
        materialHarmSliceKeys: [],
        metricBand: { leadBand: "001-024", metric: "temperatureC" },
        stationScores,
      }),
    ),
  });
}

// build one valid immutable fitted candidate
export function createCandidateFixture() {
  const developmentReport = createDevelopmentFixture();
  const snapshotManifest = createSnapshotFixture();
  return createForecastAdjustmentCandidate({
    coefficients: [
      {
        coefficient: 2,
        daypart: null,
        effectiveEventCount: 200,
        leadBand: "001-024",
        level: 1,
        metric: "temperatureC",
        month: null,
        season: null,
      },
    ],
    developmentReportSha256: developmentReport.developmentReportSha256,
    enabledMetricBands: [
      { leadBand: "001-024", metric: "temperatureC" },
    ],
    evaluationEpochId: "epoch-2026-01",
    exportManifestSha256: canonicalSha256(snapshotManifest),
    finalTrainingCutoff: "2026-01-01T07:59:59.999Z",
    forecastIdentity: FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    runtimeFingerprint: runtimeCalendarFingerprint(),
    trainingEnvelopes: [
      {
        leadBand: "001-024",
        maximum: 20,
        metric: "temperatureC",
        minimum: -2,
      },
    ],
    trainingProvenance: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  });
}

// build one preregistered candidate and durable access marker
export async function createHoldoutFixture(directory) {
  const candidate = createCandidateFixture();
  const preregistration = createForecastAdjustmentPreregistration({
    algorithmImplementationSha256: hash("a"),
    candidate,
    holdoutEndExclusive: "2026-02-07T08:00:00.000Z",
    holdoutEndLocalDate: "2026-02-06",
    holdoutStartInclusive: "2026-01-08T08:00:00.000Z",
    holdoutStartLocalDate: "2026-01-08",
    snapshotManifestSha256: candidate.exportManifestSha256,
  });
  const lineage = {
    aggregationContractVersion: "physical-station-network/v1",
    cohort: "legacy_v4_retrieval_snapshot",
    contractEpoch: candidate.forecastIdentity.contractEpoch,
    dataset: candidate.forecastIdentity.dataset,
    forecastSourceConfigFingerprint:
      candidate.forecastIdentity.sourceConfigFingerprint,
    forecastSourceKey: candidate.forecastIdentity.sourceKey,
    metricEligibilitySha256:
      candidate.trainingProvenance.metricEligibilitySha256,
    observationSourceLineageSha256:
      candidate.trainingProvenance.observationSourceLineageSha256,
    observationStationManifestSha256:
      candidate.trainingProvenance.observationStationManifestSha256,
    referenceKind: "retrieval_snapshot",
    siteKey: "ballydidean",
    spatialWeightSha256: candidate.trainingProvenance.spatialWeightSha256,
    upstreamModel: candidate.forecastIdentity.upstreamModel,
  };
  let marker;
  await withGuardedHoldoutAccess(
    {
      candidate,
      directory,
      lineage,
      now: () => "2026-02-08T00:00:00.000Z",
      preregistration,
    },
    async (durableMarker) => {
      marker = durableMarker;
    },
  );
  return { candidate, lineage, marker, preregistration };
}

// build one passing report and receipt triple
export async function createQualifiedFixture(directory) {
  const { candidate, marker, preregistration } =
    await createHoldoutFixture(directory);
  const passingScore = {
    adjustedLoss: 9,
    bootstrapLowerBound: 0.01,
    bootstrapUpperBound: 0.2,
    eventCount: 100,
    rawLoss: 10,
    skill: 0.1,
  };
  const stationKeys = [
    "ambient-maxweather",
    "ballydidean-ecowitt",
    "netatmo-nearby",
    "tempest-126537",
    "tempest-168853",
  ];
  const slices = [
    { ...passingScore, key: "nearest-three", kind: "nearest_three" },
    { ...passingScore, key: "ambient", kind: "provider_family" },
    { ...passingScore, key: "ecowitt", kind: "provider_family" },
    { ...passingScore, key: "netatmo", kind: "provider_family" },
    { ...passingScore, key: "tempest", kind: "provider_family" },
    { ...passingScore, key: "winter-night", kind: "season_daypart" },
    ...stationKeys.map((key) => ({
      ...passingScore,
      key,
      kind: "station",
    })),
  ];
  const evaluationReport = createForecastAdjustmentEvaluationReport({
    candidate,
    holdoutAccessMarker: marker,
    metricBandEvaluations: [
      {
        criticalSlices: slices,
        ecowittCompleteLocalDates: 30,
        ecowittMetricBandMatches: 100,
        ecowittMetricMatches: 500,
        ecowittTargetSite: passingScore,
        evaluatedSeasonDaypartKeys: ["winter-night"],
        metricBand: candidate.enabledMetricBands[0],
        network: passingScore,
        providerBalanced: passingScore,
        scoreableStationKeys: stationKeys,
      },
    ],
    preregistration,
  });
  const attestation = createEvidenceRedundancyAttestation({
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationReportSha256: evaluationReport.evaluationReportSha256,
    status: "independent_content_addressed_copy",
    verifiedAtUtc: "2026-02-08T01:00:00.000Z",
  });
  const qualificationReceipt = createForecastAdjustmentQualificationReceipt({
    candidate,
    contextByMetricBand: {
      "temperatureC:001-024": {
        coefficientCoverageAndCapsPassed: true,
        criticalSlicesPassed: true,
        developmentFoldSkillPassed: true,
        productionIdentityPassed: true,
      },
    },
    evaluationReport,
    evidenceRedundancy: {
      attestationSha256: attestation.attestationSha256,
      status: attestation.status,
      verified: true,
    },
  });
  return {
    attestation,
    candidate,
    developmentReport: createDevelopmentFixture(),
    evaluationReport,
    holdoutAccessMarker: marker,
    preregistration,
    qualificationReceipt,
    snapshotManifest: createSnapshotFixture(),
  };
}
