import { createHash } from "node:crypto";

import {
  FORECAST_ADJUSTMENT_CONTRACT_VERSIONS,
  FORECAST_ADJUSTMENT_METRIC_POLICIES_V1,
  FORECAST_OBSERVATION_MANIFEST_V1,
  type ForecastAdjustmentCandidateV1,
  type ForecastAdjustmentCoefficient,
  type ForecastAdjustmentForecastIdentity,
  type ForecastAdjustmentMetricBand,
  type ForecastAdjustmentTrainingEnvelope,
  type ForecastAdjustmentTrainingProvenance,
  canonicalizeJson,
  type JsonValue,
} from "@weather/domain";

// freeze the only eligible served forecast identity
export const FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1 = {
  adapterVersion: "open-meteo-forecast-daily/v4",
  cohort: "legacy_v4_retrieval_snapshot",
  contractEpoch:
    "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
  dataset: "forecast",
  referenceKind: "retrieval_snapshot",
  sourceConfigFingerprint:
    "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
  sourceKey: "open-meteo-forecast-v4",
  upstreamModel: "best_match",
} as const satisfies ForecastAdjustmentForecastIdentity;

// freeze hashes of the canonical observation manifest projections
export const FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1 = {
  aggregationContractSha256:
    "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
  coordinateManifestSha256:
    "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
  metricEligibilitySha256:
    "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
  observationSourceLineageSha256:
    "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
  observationStationManifestSha256:
    "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
  spatialWeightSha256:
    "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
} as const satisfies ForecastAdjustmentTrainingProvenance;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_INPUT_KEYS = new Set([
  "coefficients",
  "developmentReportSha256",
  "enabledMetricBands",
  "evaluationEpochId",
  "exportManifestSha256",
  "finalTrainingCutoff",
  "forecastIdentity",
  "runtimeFingerprint",
  "trainingEnvelopes",
  "trainingProvenance",
]);
const CANDIDATE_KEYS = new Set([
  "algorithmContractVersion",
  "candidateArtifactSha256",
  "coefficientPayloadSha256",
  "coefficients",
  "contractVersion",
  "developmentReportSha256",
  "enabledMetricBands",
  "evaluationEpochId",
  "exportManifestSha256",
  "finalTrainingCutoff",
  "forecastIdentity",
  "metricPolicies",
  "runtimeFingerprint",
  "siteKey",
  "timezone",
  "trainingEnvelopes",
  "trainingProvenance",
]);

// describe pre-holdout fitted material
export interface ForecastAdjustmentCandidateInputV1 {
  readonly coefficients: readonly ForecastAdjustmentCoefficient[];
  readonly developmentReportSha256: string;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly evaluationEpochId: string;
  readonly exportManifestSha256: string;
  readonly finalTrainingCutoff: string;
  readonly forecastIdentity: ForecastAdjustmentForecastIdentity;
  readonly runtimeFingerprint: {
    readonly icuVersion: string;
    readonly tzdataVersion: string;
  };
  readonly trainingEnvelopes: readonly ForecastAdjustmentTrainingEnvelope[];
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// bind the immutable holdout designation
export interface ForecastAdjustmentPreregistrationV1 {
  readonly algorithmImplementationSha256: string;
  readonly bootstrapContractVersion: "moving-block-bootstrap/v1";
  readonly candidateArtifactSha256: string;
  readonly coefficientPayloadSha256: string;
  readonly contractVersion: "forecast-adjustment-preregistration/v1";
  readonly criticalSliceContractVersion: "forecast-critical-slices/v1";
  readonly developmentReportSha256: string;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly enabledMetricBandsSha256: string;
  readonly evaluationEpochId: string;
  readonly holdoutEndExclusive: string;
  readonly holdoutEndLocalDate: string;
  readonly holdoutStartInclusive: string;
  readonly holdoutStartLocalDate: string;
  readonly preregistrationSha256: string;
  readonly snapshotManifestSha256: string;
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// canonicalize one immutable object with LF termination
export function canonicalJsonBytes(value: JsonValue): string {
  return `${canonicalizeJson(value)}\n`;
}

// hash canonical object bytes
export function canonicalSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

// hash one object while omitting only its own hash field
export function canonicalObjectSha256(
  value: Readonly<Record<string, unknown>>,
  ownHashField: string,
): string {
  const material = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== ownHashField),
  );

  return canonicalSha256(material as JsonValue);
}

// create a deterministic immutable fitted candidate
export function createForecastAdjustmentCandidate(
  input: ForecastAdjustmentCandidateInputV1,
): ForecastAdjustmentCandidateV1 {
  rejectUnknownKeys(input, CANDIDATE_INPUT_KEYS, "candidate input");
  validateHash(input.developmentReportSha256, "developmentReportSha256");
  validateHash(input.exportManifestSha256, "exportManifestSha256");
  validateText(input.evaluationEpochId, "evaluationEpochId");
  validateCanonicalCandidateProvenance(
    input.forecastIdentity,
    input.trainingProvenance,
  );

  // reject holdout-era contamination
  rejectForbiddenCandidateFields(input);
  const enabledMetricBands = sortEnabledMetricBands(input.enabledMetricBands);
  const coefficients = sortCoefficients(input.coefficients);
  const trainingEnvelopes = sortTrainingEnvelopes(input.trainingEnvelopes);
  const coefficientPayloadSha256 = canonicalSha256(
    coefficients as unknown as JsonValue,
  );
  const unsignedCandidate = {
    algorithmContractVersion: "robust-hierarchical-median/v1" as const,
    coefficientPayloadSha256,
    coefficients,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.candidate,
    developmentReportSha256: input.developmentReportSha256,
    enabledMetricBands,
    evaluationEpochId: input.evaluationEpochId,
    exportManifestSha256: input.exportManifestSha256,
    finalTrainingCutoff: input.finalTrainingCutoff,
    forecastIdentity: cloneJson(input.forecastIdentity),
    metricPolicies: cloneJson(FORECAST_ADJUSTMENT_METRIC_POLICIES_V1),
    runtimeFingerprint: cloneJson(input.runtimeFingerprint),
    siteKey: "ballydidean" as const,
    timezone: "America/Los_Angeles" as const,
    trainingEnvelopes,
    trainingProvenance: cloneJson(input.trainingProvenance),
  };
  const candidateArtifactSha256 = canonicalSha256(
    unsignedCandidate as unknown as JsonValue,
  );

  return deepFreeze({
    ...unsignedCandidate,
    candidateArtifactSha256,
  }) as ForecastAdjustmentCandidateV1;
}

// verify immutable candidate bytes and hashes
export function verifyForecastAdjustmentCandidate(
  candidate: ForecastAdjustmentCandidateV1,
): void {
  rejectUnknownKeys(candidate, CANDIDATE_KEYS, "candidate");
  const candidateHash = canonicalObjectSha256(
    candidate as unknown as Readonly<Record<string, unknown>>,
    "candidateArtifactSha256",
  );

  // reject candidate substitution
  if (candidateHash !== candidate.candidateArtifactSha256) {
    throw new RangeError("candidate artifact SHA-256 mismatch");
  }

  const coefficientHash = canonicalSha256(
    candidate.coefficients as unknown as JsonValue,
  );

  // reject fitted-payload substitution
  if (coefficientHash !== candidate.coefficientPayloadSha256) {
    throw new RangeError("candidate coefficient payload SHA-256 mismatch");
  }

  validateCanonicalCandidateProvenance(
    candidate.forecastIdentity,
    candidate.trainingProvenance,
  );

  // require the exact deterministic enabled order
  if (
    canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) !==
    canonicalizeJson(
      sortEnabledMetricBands(candidate.enabledMetricBands) as unknown as JsonValue,
    )
  ) {
    throw new RangeError("candidate enabled metric-band set is not canonical");
  }

  rejectForbiddenCandidateFields(candidate);
}

// bind candidate lineage to the frozen domain observation contract
function validateCanonicalCandidateProvenance(
  identity: ForecastAdjustmentForecastIdentity,
  provenance: ForecastAdjustmentTrainingProvenance,
): void {
  // require the domain manifest consumed by the projection hashes
  if (
    FORECAST_OBSERVATION_MANIFEST_V1.aggregationContractVersion !==
      "physical-station-network/v1" ||
    FORECAST_OBSERVATION_MANIFEST_V1.site.key !== "ballydidean" ||
    FORECAST_OBSERVATION_MANIFEST_V1.site.timezone !== "America/Los_Angeles"
  ) {
    throw new RangeError("canonical observation manifest identity is invalid");
  }

  // reject a rehashed candidate with a parallel forecast lineage
  if (
    canonicalizeJson(identity as unknown as JsonValue) !==
    canonicalizeJson(
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1 as unknown as JsonValue,
    )
  ) {
    throw new RangeError("candidate forecast identity is not canonical");
  }

  // reject a rehashed candidate with parallel observation provenance
  if (
    canonicalizeJson(provenance as unknown as JsonValue) !==
    canonicalizeJson(
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1 as unknown as JsonValue,
    )
  ) {
    throw new RangeError("candidate training provenance is not canonical");
  }
}

// create one immutable preregistration before holdout access
export function createForecastAdjustmentPreregistration(input: {
  readonly algorithmImplementationSha256: string;
  readonly candidate: ForecastAdjustmentCandidateV1;
  readonly holdoutEndExclusive: string;
  readonly holdoutEndLocalDate: string;
  readonly holdoutStartInclusive: string;
  readonly holdoutStartLocalDate: string;
  readonly snapshotManifestSha256: string;
}): ForecastAdjustmentPreregistrationV1 {
  verifyForecastAdjustmentCandidate(input.candidate);
  validateHash(
    input.algorithmImplementationSha256,
    "algorithmImplementationSha256",
  );
  validateHash(input.snapshotManifestSha256, "snapshotManifestSha256");

  // bind the preregistration to the fitted snapshot
  if (input.snapshotManifestSha256 !== input.candidate.exportManifestSha256) {
    throw new RangeError("preregistration snapshot does not match candidate");
  }
  const enabledMetricBandsSha256 = canonicalSha256(
    input.candidate.enabledMetricBands as unknown as JsonValue,
  );
  const unsigned = {
    algorithmImplementationSha256: input.algorithmImplementationSha256,
    bootstrapContractVersion: "moving-block-bootstrap/v1" as const,
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    coefficientPayloadSha256: input.candidate.coefficientPayloadSha256,
    contractVersion: "forecast-adjustment-preregistration/v1" as const,
    criticalSliceContractVersion: "forecast-critical-slices/v1" as const,
    developmentReportSha256: input.candidate.developmentReportSha256,
    enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
    enabledMetricBandsSha256,
    evaluationEpochId: input.candidate.evaluationEpochId,
    holdoutEndExclusive: input.holdoutEndExclusive,
    holdoutEndLocalDate: input.holdoutEndLocalDate,
    holdoutStartInclusive: input.holdoutStartInclusive,
    holdoutStartLocalDate: input.holdoutStartLocalDate,
    snapshotManifestSha256: input.snapshotManifestSha256,
    trainingProvenance: cloneJson(input.candidate.trainingProvenance),
  };
  const preregistrationSha256 = canonicalSha256(unsigned as unknown as JsonValue);

  return deepFreeze({
    ...unsigned,
    preregistrationSha256,
  }) as ForecastAdjustmentPreregistrationV1;
}

// verify preregistration links without holdout access
export function verifyForecastAdjustmentPreregistration(
  preregistration: ForecastAdjustmentPreregistrationV1,
  candidate: ForecastAdjustmentCandidateV1,
): void {
  verifyForecastAdjustmentCandidate(candidate);
  rejectUnknownKeys(
    preregistration,
    new Set([
      "algorithmImplementationSha256",
      "bootstrapContractVersion",
      "candidateArtifactSha256",
      "coefficientPayloadSha256",
      "contractVersion",
      "criticalSliceContractVersion",
      "developmentReportSha256",
      "enabledMetricBands",
      "enabledMetricBandsSha256",
      "evaluationEpochId",
      "holdoutEndExclusive",
      "holdoutEndLocalDate",
      "holdoutStartInclusive",
      "holdoutStartLocalDate",
      "preregistrationSha256",
      "snapshotManifestSha256",
      "trainingProvenance",
    ]),
    "preregistration",
  );

  // reject canonical preregistration substitution
  if (
    canonicalObjectSha256(
      preregistration as unknown as Readonly<Record<string, unknown>>,
      "preregistrationSha256",
    ) !== preregistration.preregistrationSha256
  ) {
    throw new RangeError("preregistration SHA-256 mismatch");
  }

  // require unchanged fitted evidence
  if (
    preregistration.candidateArtifactSha256 !== candidate.candidateArtifactSha256 ||
    preregistration.coefficientPayloadSha256 !== candidate.coefficientPayloadSha256 ||
    preregistration.developmentReportSha256 !== candidate.developmentReportSha256 ||
    preregistration.evaluationEpochId !== candidate.evaluationEpochId ||
    preregistration.snapshotManifestSha256 !== candidate.exportManifestSha256 ||
    preregistration.enabledMetricBandsSha256 !==
      canonicalSha256(candidate.enabledMetricBands as unknown as JsonValue) ||
    canonicalizeJson(preregistration.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) ||
    canonicalizeJson(preregistration.trainingProvenance as unknown as JsonValue) !==
      canonicalizeJson(candidate.trainingProvenance as unknown as JsonValue)
  ) {
    throw new RangeError("preregistration candidate cross-link mismatch");
  }
}

// sort the exact enabled set and reject duplicates
export function sortEnabledMetricBands(
  pairs: readonly ForecastAdjustmentMetricBand[],
): readonly ForecastAdjustmentMetricBand[] {
  const sorted = pairs
    .map((pair) => cloneJson(pair))
    .sort((left, right) => compareText(metricBandKey(left), metricBandKey(right)));

  // reject duplicate enabled pairs
  if (new Set(sorted.map(metricBandKey)).size !== sorted.length) {
    throw new RangeError("enabled metric-band set contains a duplicate");
  }

  return sorted;
}

// identify one metric-band pair
export function metricBandKey(pair: ForecastAdjustmentMetricBand): string {
  return `${pair.metric}:${pair.leadBand}`;
}

// sort coefficient cells deterministically
function sortCoefficients(
  coefficients: readonly ForecastAdjustmentCoefficient[],
): readonly ForecastAdjustmentCoefficient[] {
  return coefficients.map((coefficient) => cloneJson(coefficient)).sort((left, right) => {
    const leftKey = canonicalizeJson(left as unknown as JsonValue);
    const rightKey = canonicalizeJson(right as unknown as JsonValue);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

// sort training envelopes deterministically
function sortTrainingEnvelopes(
  envelopes: readonly ForecastAdjustmentTrainingEnvelope[],
): readonly ForecastAdjustmentTrainingEnvelope[] {
  return envelopes
    .map((envelope) => cloneJson(envelope))
    .sort((left, right) => compareText(metricBandKey(left), metricBandKey(right)));
}

// reject post-fit and raw evidence fields recursively
function rejectForbiddenCandidateFields(value: unknown): void {
  const forbidden = /^(?:actual|adjustedLoss|evaluationReport|holdout|qualification|rawLoss|receipt)$/iu;
  visitObject(value, (key) => {
    // reject later evidence embedded anywhere
    if (forbidden.test(key)) {
      throw new RangeError(`candidate contains forbidden post-fit field: ${key}`);
    }
  });
}

// visit every object key
function visitObject(value: unknown, visit: (key: string) => void): void {
  // ignore primitives
  if (value === null || typeof value !== "object") {
    return;
  }

  // descend arrays
  if (Array.isArray(value)) {
    for (const item of value) {
      visitObject(item, visit);
    }
    return;
  }

  // inspect plain objects
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    visitObject(child, visit);
  }
}

// clone only JSON-safe values
function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as T;
}

// freeze a complete object graph
export function deepFreeze<T>(value: T): T {
  // stop at primitives or prior freezes
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  // freeze every nested member
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

// reject runtime fields outside one closed schema
function rejectUnknownKeys(
  value: object,
  allowed: ReadonlySet<string>,
  description: string,
): void {
  // inspect all enumerable fields
  for (const key of Object.keys(value)) {
    // reject schema drift
    if (!allowed.has(key)) {
      throw new RangeError(`${description} contains an unexpected field: ${key}`);
    }
  }
}

// validate a SHA-256 identity
function validateHash(value: string, fieldName: string): void {
  // require lowercase hexadecimal
  if (!HASH_PATTERN.test(value)) {
    throw new RangeError(`${fieldName} must be a SHA-256 hex value`);
  }
}

// validate bounded nonempty text
function validateText(value: string, fieldName: string): void {
  // reject empty or unbounded identities
  if (value.trim().length === 0 || value.length > 256) {
    throw new RangeError(`${fieldName} must be bounded nonempty text`);
  }
}

// compare text by code unit
function compareText(left: string, right: string): number {
  // order lower values first
  if (left < right) {
    return -1;
  }

  // order higher values last
  if (left > right) {
    return 1;
  }

  return 0;
}
