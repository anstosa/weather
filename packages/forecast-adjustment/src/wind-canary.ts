import {
  FORECAST_ADJUSTMENT_CONTRACT_VERSIONS,
  FORECAST_LEAD_BANDS,
  FORECAST_ADJUSTMENT_METRIC_POLICIES_V1,
  FORECAST_ADJUSTMENT_WIND_CANARY_METRICS,
  type ForecastAdjustmentCoefficient,
  type ForecastAdjustmentForecastIdentity,
  type ForecastAdjustmentMetricBand,
  type ForecastAdjustmentTrainingEnvelope,
  type ForecastAdjustmentTrainingProvenance,
  type ForecastAdjustmentWindCanaryAuthorizationV1,
  type ForecastAdjustmentWindCanaryBridgeScore,
  type ForecastAdjustmentWindCanaryCandidateV1,
  type ForecastAdjustmentWindCanaryRegistryV1,
  type ForecastAdjustmentWindCanaryRuntimeBundleV1,
  type ForecastAdjustmentWindCanaryTrainingIdentity,
  type ForecastAdjustmentWindCanaryTransferReportV1,
  canonicalizeJson,
  type JsonValue,
} from "@weather/domain";

import {
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  canonicalObjectSha256,
  canonicalSha256,
  deepFreeze,
  metricBandKey,
  sortEnabledMetricBands,
} from "./candidate.js";

// freeze the previous-runs lineage used for canary fitting
export const FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1 = {
  adapterVersion: "open-meteo-previous-runs/v1",
  cohort: "fixed_lead_anchor",
  contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
  dataset: "previous_runs",
  referenceKind: "fixed_lead_anchor",
  sourceConfigFingerprint:
    "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
  sourceKey: "open-meteo-previous-runs-v1",
  upstreamModel: "best_match",
} as const satisfies ForecastAdjustmentWindCanaryTrainingIdentity;

// cap one canary activation window
export const FORECAST_ADJUSTMENT_WIND_CANARY_MAXIMUM_DURATION_MS =
  14 * 24 * 60 * 60 * 1_000;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_KEYS = [
  "algorithmContractVersion",
  "artifactKind",
  "candidateArtifactSha256",
  "coefficientPayloadSha256",
  "coefficients",
  "contractVersion",
  "enabledMetricBands",
  "exportManifestSha256",
  "finalTrainingCutoff",
  "runtimeFingerprint",
  "servedForecastIdentity",
  "siteKey",
  "timezone",
  "trainingEnvelopes",
  "trainingForecastIdentity",
  "trainingProvenance",
] as const;
const TRANSFER_REPORT_KEYS = [
  "artifactKind",
  "bridgeEndExclusive",
  "bridgeEvaluations",
  "bridgeStartInclusive",
  "candidateArtifactSha256",
  "contractVersion",
  "enabledMetricBands",
  "passed",
  "servedForecastIdentity",
  "trainingForecastIdentity",
  "transferReportSha256",
] as const;
const AUTHORIZATION_KEYS = [
  "activatedAt",
  "artifactKind",
  "authorizationReason",
  "authorizationSha256",
  "authorized",
  "authorizedAt",
  "authorizedBy",
  "candidateArtifactSha256",
  "contractVersion",
  "enabledMetricBands",
  "expiresAt",
  "transferReportSha256",
] as const;
const BUNDLE_KEYS = [
  "artifactKind",
  "authorization",
  "bundleSha256",
  "candidate",
  "contractVersion",
  "siteKey",
  "timezone",
  "transferReport",
] as const;
const REGISTRY_KEYS = ["activeBundle", "contractVersion"] as const;
const REGISTRY_ACTIVE_KEYS = [
  "authorizationSha256",
  "bundleSha256",
  "candidateArtifactSha256",
  "path",
  "transferReportSha256",
] as const;
const METRIC_BAND_KEYS = ["leadBand", "metric"] as const;
const COEFFICIENT_KEYS = [
  "coefficient",
  "daypart",
  "effectiveEventCount",
  "leadBand",
  "level",
  "metric",
  "month",
  "season",
] as const;
const TRAINING_ENVELOPE_KEYS = [
  "leadBand",
  "maximum",
  "metric",
  "minimum",
] as const;
const RUNTIME_FINGERPRINT_KEYS = ["icuVersion", "tzdataVersion"] as const;
const BRIDGE_EVALUATION_KEYS = ["metricBand", "network"] as const;
const BRIDGE_SCORE_KEYS = [
  "adjustedLoss",
  "eventCount",
  "rawLoss",
  "skill",
] as const;

// accept fitted wind-only canary material
export interface ForecastAdjustmentWindCanaryCandidateInputV1 {
  readonly coefficients: readonly ForecastAdjustmentCoefficient[];
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly exportManifestSha256: string;
  readonly finalTrainingCutoff: string;
  readonly runtimeFingerprint: {
    readonly icuVersion: string;
    readonly tzdataVersion: string;
  };
  readonly servedForecastIdentity: ForecastAdjustmentForecastIdentity;
  readonly trainingEnvelopes: readonly ForecastAdjustmentTrainingEnvelope[];
  readonly trainingForecastIdentity: ForecastAdjustmentWindCanaryTrainingIdentity;
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// create one immutable wind-only transfer candidate
export function createForecastAdjustmentWindCanaryCandidate(
  input: ForecastAdjustmentWindCanaryCandidateInputV1,
): ForecastAdjustmentWindCanaryCandidateV1 {
  validateHash(input.exportManifestSha256, "exportManifestSha256");
  validateUtcInstant(input.finalTrainingCutoff, "finalTrainingCutoff");
  validateCanonicalLineage(
    input.trainingForecastIdentity,
    input.servedForecastIdentity,
    input.trainingProvenance,
  );
  const enabledMetricBands = sortEnabledMetricBands(input.enabledMetricBands);
  const coefficients = sortCoefficients(input.coefficients);
  const trainingEnvelopes = sortTrainingEnvelopes(input.trainingEnvelopes);
  const unsigned = {
    algorithmContractVersion: "robust-hierarchical-median/v1" as const,
    artifactKind: "wind_transfer_canary_candidate" as const,
    coefficientPayloadSha256: canonicalSha256(coefficients as unknown as JsonValue),
    coefficients,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryCandidate,
    enabledMetricBands,
    exportManifestSha256: input.exportManifestSha256,
    finalTrainingCutoff: input.finalTrainingCutoff,
    runtimeFingerprint: cloneJson(input.runtimeFingerprint),
    servedForecastIdentity: cloneJson(input.servedForecastIdentity),
    siteKey: "ballydidean" as const,
    timezone: "America/Los_Angeles" as const,
    trainingEnvelopes,
    trainingForecastIdentity: cloneJson(input.trainingForecastIdentity),
    trainingProvenance: cloneJson(input.trainingProvenance),
  };
  const candidate = deepFreeze({
    ...unsigned,
    candidateArtifactSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentWindCanaryCandidateV1;
  verifyForecastAdjustmentWindCanaryCandidate(candidate);
  return candidate;
}

// reject candidate substitution and non-wind fitted material
export function verifyForecastAdjustmentWindCanaryCandidate(
  candidate: ForecastAdjustmentWindCanaryCandidateV1,
): void {
  requireExactKeys(candidate, CANDIDATE_KEYS, "wind canary candidate");

  // require the separate canary contract
  if (
    candidate.artifactKind !== "wind_transfer_canary_candidate" ||
    candidate.contractVersion !==
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryCandidate ||
    candidate.algorithmContractVersion !== "robust-hierarchical-median/v1" ||
    candidate.siteKey !== "ballydidean" ||
    candidate.timezone !== "America/Los_Angeles"
  ) {
    throw new RangeError("wind canary candidate identity mismatch");
  }

  validateHash(candidate.candidateArtifactSha256, "candidateArtifactSha256");
  validateHash(candidate.coefficientPayloadSha256, "coefficientPayloadSha256");
  validateHash(candidate.exportManifestSha256, "exportManifestSha256");
  validateUtcInstant(candidate.finalTrainingCutoff, "finalTrainingCutoff");
  validateText(candidate.runtimeFingerprint.icuVersion, "icuVersion");
  validateText(candidate.runtimeFingerprint.tzdataVersion, "tzdataVersion");
  requireExactKeys(
    candidate.runtimeFingerprint,
    RUNTIME_FINGERPRINT_KEYS,
    "wind canary runtime fingerprint",
  );

  // reject any rehashed candidate mutation
  if (
    canonicalObjectSha256(
      candidate as unknown as Readonly<Record<string, unknown>>,
      "candidateArtifactSha256",
    ) !== candidate.candidateArtifactSha256 ||
    canonicalSha256(candidate.coefficients as unknown as JsonValue) !==
      candidate.coefficientPayloadSha256
  ) {
    throw new RangeError("wind canary candidate SHA-256 mismatch");
  }

  validateCanonicalLineage(
    candidate.trainingForecastIdentity,
    candidate.servedForecastIdentity,
    candidate.trainingProvenance,
  );
  validateWindCandidateMaterial(candidate);
}

// create immutable bridge evidence for the fitted candidate
export function createForecastAdjustmentWindCanaryTransferReport(input: {
  readonly bridgeEndExclusive: string;
  readonly bridgeEvaluations: readonly {
    readonly metricBand: ForecastAdjustmentMetricBand;
    readonly network: ForecastAdjustmentWindCanaryBridgeScore;
  }[];
  readonly bridgeStartInclusive: string;
  readonly candidate: ForecastAdjustmentWindCanaryCandidateV1;
}): ForecastAdjustmentWindCanaryTransferReportV1 {
  verifyForecastAdjustmentWindCanaryCandidate(input.candidate);
  const bridgeEvaluations = [...input.bridgeEvaluations]
    .map(cloneJson)
    .sort((left, right) =>
      metricBandKey(left.metricBand).localeCompare(metricBandKey(right.metricBand)),
    );
  const unsigned = {
    artifactKind: "wind_transfer_canary_transfer_report" as const,
    bridgeEndExclusive: validateUtcInstant(
      input.bridgeEndExclusive,
      "bridgeEndExclusive",
    ),
    bridgeEvaluations,
    bridgeStartInclusive: validateUtcInstant(
      input.bridgeStartInclusive,
      "bridgeStartInclusive",
    ),
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    contractVersion:
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryTransferReport,
    enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
    passed: true as const,
    servedForecastIdentity: cloneJson(input.candidate.servedForecastIdentity),
    trainingForecastIdentity: cloneJson(input.candidate.trainingForecastIdentity),
  };
  const report = deepFreeze({
    ...unsigned,
    transferReportSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentWindCanaryTransferReportV1;
  verifyForecastAdjustmentWindCanaryTransferReport(report, input.candidate);
  return report;
}

// reject transfer evidence substitution or nonpositive bridge skill
export function verifyForecastAdjustmentWindCanaryTransferReport(
  report: ForecastAdjustmentWindCanaryTransferReportV1,
  candidate: ForecastAdjustmentWindCanaryCandidateV1,
): void {
  verifyForecastAdjustmentWindCanaryCandidate(candidate);
  requireExactKeys(report, TRANSFER_REPORT_KEYS, "wind canary transfer report");

  // require the separate passing report identity
  if (
    report.artifactKind !== "wind_transfer_canary_transfer_report" ||
    report.contractVersion !==
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryTransferReport ||
    report.passed !== true ||
    report.candidateArtifactSha256 !== candidate.candidateArtifactSha256
  ) {
    throw new RangeError("wind canary transfer report identity mismatch");
  }

  validateHash(report.transferReportSha256, "transferReportSha256");
  const bridgeStart = Date.parse(
    validateUtcInstant(report.bridgeStartInclusive, "bridgeStartInclusive"),
  );
  const bridgeEnd = Date.parse(
    validateUtcInstant(report.bridgeEndExclusive, "bridgeEndExclusive"),
  );

  // require a nonempty ordered bridge window
  if (
    bridgeStart >= bridgeEnd ||
    Date.parse(candidate.finalTrainingCutoff) >= bridgeStart
  ) {
    throw new RangeError("wind canary bridge window is invalid");
  }

  // require exact candidate linkage and complete pair coverage
  if (
    canonicalizeJson(report.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) ||
    canonicalizeJson(report.trainingForecastIdentity as unknown as JsonValue) !==
      canonicalizeJson(candidate.trainingForecastIdentity as unknown as JsonValue) ||
    canonicalizeJson(report.servedForecastIdentity as unknown as JsonValue) !==
      canonicalizeJson(candidate.servedForecastIdentity as unknown as JsonValue) ||
    canonicalizeJson(
      report.bridgeEvaluations.map((evaluation) => evaluation.metricBand) as unknown as JsonValue,
    ) !== canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue)
  ) {
    throw new RangeError("wind canary transfer report cross-link mismatch");
  }

  // require positive finite live-v4 evidence for every enabled pair
  for (const evaluation of report.bridgeEvaluations) {
    requireExactKeys(
      evaluation,
      BRIDGE_EVALUATION_KEYS,
      "wind canary bridge evaluation",
    );
    requireExactKeys(
      evaluation.metricBand,
      METRIC_BAND_KEYS,
      "wind canary bridge metric band",
    );
    requireExactKeys(
      evaluation.network,
      BRIDGE_SCORE_KEYS,
      "wind canary bridge score",
    );
    validateBridgeScore(evaluation.network);
  }

  // reject any fully rehashed report mutation
  if (
    canonicalObjectSha256(
      report as unknown as Readonly<Record<string, unknown>>,
      "transferReportSha256",
    ) !== report.transferReportSha256
  ) {
    throw new RangeError("wind canary transfer report SHA-256 mismatch");
  }
}

// create one explicit bounded operator authorization
export function createForecastAdjustmentWindCanaryAuthorization(input: {
  readonly activatedAt: string;
  readonly authorizationReason: string;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly candidate: ForecastAdjustmentWindCanaryCandidateV1;
  readonly expiresAt: string;
  readonly transferReport: ForecastAdjustmentWindCanaryTransferReportV1;
}): ForecastAdjustmentWindCanaryAuthorizationV1 {
  verifyForecastAdjustmentWindCanaryTransferReport(
    input.transferReport,
    input.candidate,
  );
  const unsigned = {
    activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
    artifactKind: "wind_transfer_canary_authorization" as const,
    authorizationReason: validateText(
      input.authorizationReason,
      "authorizationReason",
    ),
    authorized: true as const,
    authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
    authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    contractVersion:
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryAuthorization,
    enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
    expiresAt: validateUtcInstant(input.expiresAt, "expiresAt"),
    transferReportSha256: input.transferReport.transferReportSha256,
  };
  const authorization = deepFreeze({
    ...unsigned,
    authorizationSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentWindCanaryAuthorizationV1;
  verifyForecastAdjustmentWindCanaryAuthorization(
    authorization,
    input.candidate,
    input.transferReport,
  );
  return authorization;
}

// verify exact operator authorization links and duration
export function verifyForecastAdjustmentWindCanaryAuthorization(
  authorization: ForecastAdjustmentWindCanaryAuthorizationV1,
  candidate: ForecastAdjustmentWindCanaryCandidateV1,
  report: ForecastAdjustmentWindCanaryTransferReportV1,
): void {
  verifyForecastAdjustmentWindCanaryCandidate(candidate);
  verifyForecastAdjustmentWindCanaryTransferReport(report, candidate);
  requireExactKeys(authorization, AUTHORIZATION_KEYS, "wind canary authorization");

  // require one explicit immutable authorization
  if (
    authorization.artifactKind !== "wind_transfer_canary_authorization" ||
    authorization.contractVersion !==
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryAuthorization ||
    authorization.authorized !== true ||
    authorization.candidateArtifactSha256 !== candidate.candidateArtifactSha256 ||
    authorization.transferReportSha256 !== report.transferReportSha256 ||
    canonicalizeJson(authorization.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue)
  ) {
    throw new RangeError("wind canary authorization cross-link mismatch");
  }

  validateHash(authorization.authorizationSha256, "authorizationSha256");
  validateText(authorization.authorizationReason, "authorizationReason");
  validateText(authorization.authorizedBy, "authorizedBy");
  const authorizedAt = Date.parse(
    validateUtcInstant(authorization.authorizedAt, "authorizedAt"),
  );
  const activatedAt = Date.parse(
    validateUtcInstant(authorization.activatedAt, "activatedAt"),
  );
  const expiresAt = Date.parse(
    validateUtcInstant(authorization.expiresAt, "expiresAt"),
  );

  // require one forward-only activation no longer than fourteen days
  if (
    authorizedAt < Date.parse(report.bridgeEndExclusive) ||
    activatedAt < authorizedAt ||
    expiresAt <= activatedAt ||
    expiresAt - activatedAt > FORECAST_ADJUSTMENT_WIND_CANARY_MAXIMUM_DURATION_MS
  ) {
    throw new RangeError("wind canary authorization window is invalid");
  }

  // reject any fully rehashed authorization mutation
  if (
    canonicalObjectSha256(
      authorization as unknown as Readonly<Record<string, unknown>>,
      "authorizationSha256",
    ) !== authorization.authorizationSha256
  ) {
    throw new RangeError("wind canary authorization SHA-256 mismatch");
  }
}

// package separately reviewed canary artifacts
export function createForecastAdjustmentWindCanaryRuntimeBundle(input: {
  readonly authorization: ForecastAdjustmentWindCanaryAuthorizationV1;
  readonly candidate: ForecastAdjustmentWindCanaryCandidateV1;
  readonly transferReport: ForecastAdjustmentWindCanaryTransferReportV1;
}): ForecastAdjustmentWindCanaryRuntimeBundleV1 {
  verifyForecastAdjustmentWindCanaryCandidate(input.candidate);
  verifyForecastAdjustmentWindCanaryTransferReport(
    input.transferReport,
    input.candidate,
  );
  verifyForecastAdjustmentWindCanaryAuthorization(
    input.authorization,
    input.candidate,
    input.transferReport,
  );
  const unsigned = {
    artifactKind: "wind_transfer_canary_runtime_bundle" as const,
    authorization: cloneJson(input.authorization),
    candidate: cloneJson(input.candidate),
    contractVersion:
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRuntimeBundle,
    siteKey: "ballydidean" as const,
    timezone: "America/Los_Angeles" as const,
    transferReport: cloneJson(input.transferReport),
  };
  const bundle = deepFreeze({
    ...unsigned,
    bundleSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentWindCanaryRuntimeBundleV1;
  verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
  return bundle;
}

// verify every nested canary artifact and content hash
export function verifyForecastAdjustmentWindCanaryRuntimeBundle(
  bundle: ForecastAdjustmentWindCanaryRuntimeBundleV1,
): void {
  requireExactKeys(bundle, BUNDLE_KEYS, "wind canary runtime bundle");

  // require the isolated runtime identity
  if (
    bundle.artifactKind !== "wind_transfer_canary_runtime_bundle" ||
    bundle.contractVersion !==
      FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRuntimeBundle ||
    bundle.siteKey !== "ballydidean" ||
    bundle.timezone !== "America/Los_Angeles"
  ) {
    throw new RangeError("wind canary runtime bundle identity mismatch");
  }

  validateHash(bundle.bundleSha256, "bundleSha256");
  verifyForecastAdjustmentWindCanaryCandidate(bundle.candidate);
  verifyForecastAdjustmentWindCanaryTransferReport(
    bundle.transferReport,
    bundle.candidate,
  );
  verifyForecastAdjustmentWindCanaryAuthorization(
    bundle.authorization,
    bundle.candidate,
    bundle.transferReport,
  );

  // reject outer bundle substitution
  if (
    canonicalObjectSha256(
      bundle as unknown as Readonly<Record<string, unknown>>,
      "bundleSha256",
    ) !== bundle.bundleSha256
  ) {
    throw new RangeError("wind canary runtime bundle SHA-256 mismatch");
  }
}

// validate a separately selected canary bundle
export function validateForecastAdjustmentWindCanaryRegistry(
  registry: ForecastAdjustmentWindCanaryRegistryV1,
): void {
  requireExactKeys(registry, REGISTRY_KEYS, "wind canary registry");

  // require the isolated registry contract
  if (
    registry.contractVersion !==
    FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRegistry
  ) {
    throw new RangeError("unsupported wind canary registry contract");
  }

  // permit a reviewed inactive canary registry
  if (registry.activeBundle === null) {
    return;
  }

  const active = registry.activeBundle;
  requireExactKeys(active, REGISTRY_ACTIVE_KEYS, "wind canary active bundle");
  validateHash(active.authorizationSha256, "activeBundle.authorizationSha256");
  validateHash(active.bundleSha256, "activeBundle.bundleSha256");
  validateHash(
    active.candidateArtifactSha256,
    "activeBundle.candidateArtifactSha256",
  );
  validateHash(active.transferReportSha256, "activeBundle.transferReportSha256");

  // require one exact content-addressed relative path
  if (
    active.path !== `wind-canary-bundles/sha256-${active.bundleSha256}.json`
  ) {
    throw new RangeError("wind canary registry path is invalid");
  }
}

// validate a separately selected canary bundle
export function validateForecastAdjustmentWindCanaryRuntimeBundleLinks(
  registry: ForecastAdjustmentWindCanaryRegistryV1,
  bundle: ForecastAdjustmentWindCanaryRuntimeBundleV1,
): void {
  validateForecastAdjustmentWindCanaryRegistry(registry);
  verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);

  // require an active registry selection
  if (registry.activeBundle === null) {
    throw new RangeError("wind canary registry has no active bundle");
  }

  const active = registry.activeBundle;

  // require exact registry-to-bundle cross-links
  if (
    active.bundleSha256 !== bundle.bundleSha256 ||
    active.authorizationSha256 !== bundle.authorization.authorizationSha256 ||
    active.candidateArtifactSha256 !==
      bundle.candidate.candidateArtifactSha256 ||
    active.transferReportSha256 !== bundle.transferReport.transferReportSha256
  ) {
    throw new RangeError("wind canary registry cross-link mismatch");
  }
}

// report whether the current instant is inside the authorized window
export function forecastAdjustmentWindCanaryIsActiveAt(
  bundle: ForecastAdjustmentWindCanaryRuntimeBundleV1,
  now: string,
): boolean {
  verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
  const instant = Date.parse(validateUtcInstant(now, "now"));
  return (
    instant >= Date.parse(bundle.authorization.activatedAt) &&
    instant < Date.parse(bundle.authorization.expiresAt)
  );
}

// interpret only the literal one-way disable value
export function forecastAdjustmentWindCanaryIsKilled(
  environmentValue: string | undefined,
): boolean {
  return environmentValue === "1";
}

// validate exact canonical source and station lineage
function validateCanonicalLineage(
  trainingIdentity: ForecastAdjustmentWindCanaryTrainingIdentity,
  servedIdentity: ForecastAdjustmentForecastIdentity,
  trainingProvenance: ForecastAdjustmentTrainingProvenance,
): void {
  // reject parallel rehashed source identities
  if (
    canonicalizeJson(trainingIdentity as unknown as JsonValue) !==
      canonicalizeJson(
        FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1 as unknown as JsonValue,
      ) ||
    canonicalizeJson(servedIdentity as unknown as JsonValue) !==
      canonicalizeJson(
        FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1 as unknown as JsonValue,
      ) ||
    canonicalizeJson(trainingProvenance as unknown as JsonValue) !==
      canonicalizeJson(
        FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1 as unknown as JsonValue,
      )
  ) {
    throw new RangeError("wind canary lineage is not canonical");
  }
}

// validate the closed wind-only candidate material
function validateWindCandidateMaterial(
  candidate: ForecastAdjustmentWindCanaryCandidateV1,
): void {
  const sortedBands = sortEnabledMetricBands(candidate.enabledMetricBands);
  const enabledKeys = new Set(sortedBands.map(metricBandKey));

  // require exact enabled pair schemas
  for (const pair of candidate.enabledMetricBands) {
    requireExactKeys(pair, METRIC_BAND_KEYS, "wind canary metric band");
  }

  // require nonempty canonical unique wind-only enabled pairs
  if (
    sortedBands.length === 0 ||
    enabledKeys.size !== sortedBands.length ||
    canonicalizeJson(sortedBands as unknown as JsonValue) !==
      canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) ||
    sortedBands.some(
      (pair) =>
        !isWindCanaryMetric(pair.metric) ||
        !FORECAST_LEAD_BANDS.some((band) => band.key === pair.leadBand),
    )
  ) {
    throw new RangeError("wind canary enabled set is invalid");
  }

  const rootCounts = new Map([...enabledKeys].map((key) => [key, 0]));
  const coefficientCells = new Set<string>();

  // reject non-wind, disabled, malformed, or out-of-cap coefficients
  for (const coefficient of candidate.coefficients) {
    requireExactKeys(coefficient, COEFFICIENT_KEYS, "wind canary coefficient");
    const key = metricBandKey(coefficient);
    const policy = FORECAST_ADJUSTMENT_METRIC_POLICIES_V1.find(
      (item) => item.metric === coefficient.metric,
    );

    // require one enabled wind coefficient cell
    if (
      !isWindCanaryMetric(coefficient.metric) ||
      !enabledKeys.has(key) ||
      policy === undefined ||
      !Number.isFinite(coefficient.coefficient) ||
      !Number.isFinite(coefficient.effectiveEventCount) ||
      coefficient.effectiveEventCount < 0 ||
      coefficient.coefficient < policy.correctionMinimum ||
      coefficient.coefficient > policy.correctionMaximum
    ) {
      throw new RangeError("wind canary coefficient is invalid");
    }

    validateCoefficientShape(coefficient);
    const cell = canonicalizeJson({
      daypart: coefficient.daypart,
      leadBand: coefficient.leadBand,
      level: coefficient.level,
      metric: coefficient.metric,
      month: coefficient.month,
      season: coefficient.season,
    });

    // reject duplicate fitted hierarchy cells
    if (coefficientCells.has(cell)) {
      throw new RangeError("wind canary contains a duplicate coefficient cell");
    }

    coefficientCells.add(cell);

    // count required root cells
    if (coefficient.level === 1) {
      rootCounts.set(key, (rootCounts.get(key) ?? 0) + 1);
    }
  }

  // require one fitted root for every enabled pair
  if ([...rootCounts.values()].some((count) => count !== 1)) {
    throw new RangeError("wind canary enabled pair lacks one root coefficient");
  }

  const expectedEnvelopes = sortedBands
    .filter((pair) => pair.metric !== "windDirectionDegrees")
    .map(metricBandKey);
  const actualEnvelopes = candidate.trainingEnvelopes.map(metricBandKey);

  // require exact scalar envelope schemas
  for (const envelope of candidate.trainingEnvelopes) {
    requireExactKeys(
      envelope,
      TRAINING_ENVELOPE_KEYS,
      "wind canary training envelope",
    );
  }

  // require exact scalar envelope coverage without direction envelopes
  if (
    canonicalizeJson(actualEnvelopes) !== canonicalizeJson(expectedEnvelopes) ||
    canonicalizeJson(candidate.coefficients as unknown as JsonValue) !==
      canonicalizeJson(sortCoefficients(candidate.coefficients) as unknown as JsonValue) ||
    canonicalizeJson(candidate.trainingEnvelopes as unknown as JsonValue) !==
      canonicalizeJson(
        sortTrainingEnvelopes(candidate.trainingEnvelopes) as unknown as JsonValue,
      ) ||
    candidate.trainingEnvelopes.some(
      (envelope) =>
        !Number.isFinite(envelope.minimum) ||
        !Number.isFinite(envelope.maximum) ||
        envelope.minimum > envelope.maximum,
    )
  ) {
    throw new RangeError("wind canary training envelopes are invalid");
  }
}

// narrow one adjustable metric to the canary allowlist
function isWindCanaryMetric(
  metric: ForecastAdjustmentMetricBand["metric"],
): metric is (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number] {
  return (
    metric === "windDirectionDegrees" ||
    metric === "windGustMps" ||
    metric === "windSpeedMps"
  );
}

// validate one fitted hierarchy cell
function validateCoefficientShape(coefficient: ForecastAdjustmentCoefficient): void {
  // require the root shape
  if (coefficient.level === 1) {
    if (
      coefficient.daypart !== null ||
      coefficient.month !== null ||
      coefficient.season !== null ||
      coefficient.effectiveEventCount < 200
    ) {
      throw new RangeError("wind canary root coefficient is invalid");
    }

    return;
  }

  // require one valid refined shape
  if (
    (coefficient.level !== 2 && coefficient.level !== 3) ||
    coefficient.daypart === null ||
    !["afternoon", "evening", "morning", "night"].includes(
      coefficient.daypart,
    ) ||
    (coefficient.level === 2 &&
      (coefficient.month !== null ||
        coefficient.season === null ||
        !["autumn", "spring", "summer", "winter"].includes(
          coefficient.season,
        ) ||
        coefficient.effectiveEventCount < 100)) ||
    (coefficient.level === 3 &&
      (coefficient.season !== null ||
        coefficient.month === null ||
        !Number.isInteger(coefficient.month) ||
        coefficient.month < 1 ||
        coefficient.month > 12 ||
        coefficient.effectiveEventCount < 50))
  ) {
    throw new RangeError("wind canary refined coefficient is invalid");
  }
}

// validate one immutable positive bridge score
function validateBridgeScore(score: ForecastAdjustmentWindCanaryBridgeScore): void {
  const values = [
    score.adjustedLoss,
    score.eventCount,
    score.rawLoss,
    score.skill,
  ];
  const derivedSkill =
    score.rawLoss === 0
      ? score.adjustedLoss === 0
        ? 0
        : Number.NEGATIVE_INFINITY
      : (score.rawLoss - score.adjustedLoss) / score.rawLoss;

  // require literal positive transfer evidence
  if (
    values.some((value) => !Number.isFinite(value)) ||
    !Number.isSafeInteger(score.eventCount) ||
    score.eventCount < 30 ||
    score.adjustedLoss < 0 ||
    score.rawLoss <= 0 ||
    score.skill <= 0 ||
    Math.abs(derivedSkill - score.skill) > Number.EPSILON * 16
  ) {
    throw new RangeError("wind canary bridge score is not positive finite evidence");
  }
}

// sort fitted cells deterministically
function sortCoefficients(
  coefficients: readonly ForecastAdjustmentCoefficient[],
): readonly ForecastAdjustmentCoefficient[] {
  return [...coefficients].map(cloneJson).sort((left, right) =>
    metricBandKey(left).localeCompare(metricBandKey(right)) ||
    left.level - right.level ||
    (left.season ?? "").localeCompare(right.season ?? "") ||
    (left.month ?? 0) - (right.month ?? 0) ||
    (left.daypart ?? "").localeCompare(right.daypart ?? ""),
  );
}

// sort scalar envelopes deterministically
function sortTrainingEnvelopes(
  envelopes: readonly ForecastAdjustmentTrainingEnvelope[],
): readonly ForecastAdjustmentTrainingEnvelope[] {
  return [...envelopes].map(cloneJson).sort((left, right) =>
    metricBandKey(left).localeCompare(metricBandKey(right)),
  );
}

// require one exact closed object schema
function requireExactKeys(
  value: object,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();

  // reject missing or added fields
  if (canonicalizeJson(actual) !== canonicalizeJson([...expected].sort())) {
    throw new RangeError(`${description} has unexpected fields`);
  }
}

// validate one lowercase content hash
function validateHash(value: string, description: string): string {
  // reject malformed immutable identities
  if (!HASH_PATTERN.test(value)) {
    throw new RangeError(`${description} must be a SHA-256 hex value`);
  }

  return value;
}

// validate one bounded nonempty label
function validateText(value: string, description: string): string {
  // reject empty or unbounded operator material
  if (
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 256 ||
    /[\r\n]|:\/\/|\b(?:credential|password|private[-_ ]?key|secret|token)\b/iu.test(
      value,
    )
  ) {
    throw new RangeError(`${description} must be bounded nonempty text`);
  }

  return value;
}

// validate one canonical UTC instant
function validateUtcInstant(value: string, description: string): string {
  const milliseconds = Date.parse(value);

  // require exact millisecond UTC serialization
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${description} must be a canonical UTC instant`);
  }

  return value;
}

// clone canonical JSON without aliases
function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as T;
}
