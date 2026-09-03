import {
  type NormalizedForecastAnchorRecord,
  validateSha256Hex,
} from "./forecast-anchor-record.js";
import { canonicalizeJson, type JsonValue } from "./provenance.js";
import {
  type CanonicalWeatherMetrics,
  type MetricName,
  validateCanonicalWeatherMetrics,
  validateMetricValue,
  validateUtcInstant,
} from "./weather-record.js";

// freeze adjustment contract versions
export const FORECAST_ADJUSTMENT_CONTRACT_VERSIONS = {
  candidate: "forecast-adjustment-candidate/v2",
  decision: "forecast-adjustment-decision/v1",
  evaluationReport: "forecast-adjustment-evaluation-report/v2",
  networkEvent: "forecast-network-event/v1",
  observationManifest: "forecast-observation-station-manifest/v1",
  qualificationReceipt: "forecast-adjustment-qualification-receipt/v2",
  registry: "forecast-adjustment-registry/v1",
  runtimeBundle: "forecast-adjustment-runtime-bundle/v2",
  trainingRow: "forecast-training-row/v1",
  windCanaryAuthorization: "forecast-adjustment-wind-canary-authorization/v1",
  windCanaryCandidate: "forecast-adjustment-wind-canary-candidate/v1",
  windCanaryRegistry: "forecast-adjustment-wind-canary-registry/v1",
  windCanaryRuntimeBundle: "forecast-adjustment-wind-canary-runtime-bundle/v1",
  windCanaryTransferReport: "forecast-adjustment-wind-canary-transfer-report/v1",
} as const;

// freeze the only adjustable v1 metrics
export const FORECAST_ADJUSTMENT_METRICS = [
  "relativeHumidityPercent",
  "temperatureC",
  "windDirectionDegrees",
  "windGustMps",
  "windSpeedMps",
] as const satisfies readonly MetricName[];

// name one adjustable metric
export type ForecastAdjustmentMetric =
  (typeof FORECAST_ADJUSTMENT_METRICS)[number];

// freeze the canary-only metric allowlist
export const FORECAST_ADJUSTMENT_WIND_CANARY_METRICS = [
  "windDirectionDegrees",
  "windGustMps",
  "windSpeedMps",
] as const satisfies readonly ForecastAdjustmentMetric[];

// name one canary-only metric
export type ForecastAdjustmentWindCanaryMetric =
  (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number];

// freeze lexically sortable lead-band keys
export const FORECAST_LEAD_BANDS = [
  { key: "001-024", maximumHours: 24, minimumHours: 1 },
  { key: "025-048", maximumHours: 48, minimumHours: 25 },
  { key: "049-072", maximumHours: 72, minimumHours: 49 },
  { key: "073-096", maximumHours: 96, minimumHours: 73 },
  { key: "097-120", maximumHours: 120, minimumHours: 97 },
  { key: "121-144", maximumHours: 144, minimumHours: 121 },
  { key: "145-168", maximumHours: 168, minimumHours: 145 },
] as const;

// name one frozen lead band
export type ForecastLeadBandKey = (typeof FORECAST_LEAD_BANDS)[number]["key"];

// freeze v1 training cohorts
export const FORECAST_TRAINING_COHORTS = [
  "fixed_lead_anchor",
  "legacy_v4_retrieval_snapshot",
] as const;

// name one v1 training cohort
export type ForecastTrainingCohort = (typeof FORECAST_TRAINING_COHORTS)[number];

// freeze truthful reference kinds
export const FORECAST_REFERENCE_KINDS = [
  "fixed_lead_anchor",
  "retrieval_snapshot",
] as const;

// name one truthful reference kind
export type ForecastReferenceKind = (typeof FORECAST_REFERENCE_KINDS)[number];

// describe a fixed-anchor training row
export interface FixedLeadAnchorTrainingRow {
  readonly adapterVersion: string;
  readonly cohort: "fixed_lead_anchor";
  readonly contractEpoch: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.trainingRow;
  readonly continuousLeadHours: number;
  readonly dataset: "previous_runs";
  readonly metrics: CanonicalWeatherMetrics;
  readonly referenceKind: "fixed_lead_anchor";
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly targetLeadHours: number;
  readonly upstreamModel: "best_match";
  readonly validAt: string;
}

// describe one eligible retrieval snapshot
export interface LegacyV4RetrievalSnapshotTrainingRow {
  readonly adapterVersion: string;
  readonly cohort: "legacy_v4_retrieval_snapshot";
  readonly contractEpoch: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.trainingRow;
  readonly continuousLeadHours: number;
  readonly dataset: string;
  readonly metrics: CanonicalWeatherMetrics;
  readonly referenceAt: string;
  readonly referenceKind: "retrieval_snapshot";
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly stableRecordId: string;
  readonly targetLeadHours: number;
  readonly upstreamModel: string;
  readonly validAt: string;
}

// accept explicit v4 retrieval provenance
export interface LegacyV4RetrievalSnapshotTrainingRowInput {
  readonly adapterVersion: string;
  readonly contractEpoch: string;
  readonly dataset: string;
  readonly metrics: CanonicalWeatherMetrics;
  readonly referenceAt: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly stableRecordId: string;
  readonly upstreamModel: string;
  readonly validAt: string;
}

// freeze accepted retrieval snapshot fields
const RETRIEVAL_SNAPSHOT_INPUT_KEYS = new Set([
  "adapterVersion",
  "contractEpoch",
  "dataset",
  "metrics",
  "referenceAt",
  "sourceConfigFingerprint",
  "sourceId",
  "stableRecordId",
  "upstreamModel",
  "validAt",
]);

// unite disjoint v1 forecast cohorts
export type ForecastTrainingRow =
  | FixedLeadAnchorTrainingRow
  | LegacyV4RetrievalSnapshotTrainingRow;

// project a fixed anchor without inventing a reference instant
export function createFixedLeadAnchorTrainingRow(
  record: NormalizedForecastAnchorRecord,
): FixedLeadAnchorTrainingRow {
  return {
    adapterVersion: record.adapterVersion,
    cohort: "fixed_lead_anchor",
    contractEpoch: record.contractEpoch,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.trainingRow,
    continuousLeadHours: record.leadHours,
    dataset: record.dataset,
    metrics: validateCanonicalWeatherMetrics(record.metrics),
    referenceKind: "fixed_lead_anchor",
    sourceConfigFingerprint: validateSha256Hex(
      record.sourceConfigFingerprint,
      "sourceConfigFingerprint",
    ),
    sourceId: validateBoundedText(record.sourceId, "sourceId"),
    targetLeadHours: record.leadHours,
    upstreamModel: record.upstreamModel,
    validAt: validateUtcInstant(record.validAt, "validAt"),
  };
}

// project an eligible legacy v4 retrieval snapshot
export function createLegacyV4RetrievalSnapshotTrainingRow(
  input: LegacyV4RetrievalSnapshotTrainingRowInput,
): LegacyV4RetrievalSnapshotTrainingRow | null {
  // reject fixed-anchor and unknown claims
  if (Object.keys(input).some((key) => !RETRIEVAL_SNAPSHOT_INPUT_KEYS.has(key))) {
    throw new RangeError("retrieval snapshot input contains an unrecognized field");
  }

  const validAt = validateUtcInstant(input.validAt, "validAt");
  const referenceAt = validateUtcInstant(input.referenceAt, "referenceAt");
  const validAtMilliseconds = Date.parse(validAt);
  const referenceAtMilliseconds = Date.parse(referenceAt);

  // reject impossible future references
  if (referenceAtMilliseconds > validAtMilliseconds) {
    throw new RangeError("referenceAt must not be after validAt");
  }

  const continuousLeadHours =
    (validAtMilliseconds - referenceAtMilliseconds) / 3_600_000;
  const targetLeadHours = Math.ceil(continuousLeadHours);

  // exclude current, past, and unsupported leads
  if (targetLeadHours < 1 || targetLeadHours > 168) {
    return null;
  }

  return {
    adapterVersion: validateBoundedText(input.adapterVersion, "adapterVersion"),
    cohort: "legacy_v4_retrieval_snapshot",
    contractEpoch: validateBoundedText(input.contractEpoch, "contractEpoch"),
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.trainingRow,
    continuousLeadHours,
    dataset: validateBoundedText(input.dataset, "dataset"),
    metrics: validateCanonicalWeatherMetrics(input.metrics),
    referenceAt,
    referenceKind: "retrieval_snapshot",
    sourceConfigFingerprint: validateSha256Hex(
      input.sourceConfigFingerprint,
      "sourceConfigFingerprint",
    ),
    sourceId: validateBoundedText(input.sourceId, "sourceId"),
    stableRecordId: validateBoundedText(input.stableRecordId, "stableRecordId"),
    targetLeadHours,
    upstreamModel: validateBoundedText(input.upstreamModel, "upstreamModel"),
    validAt,
  };
}

// map one eligible target lead to its frozen band
export function forecastLeadBandFor(
  targetLeadHours: number,
): ForecastLeadBandKey {
  // require an integer application lead
  if (!Number.isInteger(targetLeadHours)) {
    throw new RangeError("targetLeadHours must be an integer");
  }

  // locate the one inclusive band
  for (const band of FORECAST_LEAD_BANDS) {
    // return the matching band
    if (
      targetLeadHours >= band.minimumHours &&
      targetLeadHours <= band.maximumHours
    ) {
      return band.key;
    }
  }

  throw new RangeError("targetLeadHours must be between 1 and 168");
}

// freeze provider-family balancing order
export const FORECAST_OBSERVATION_PROVIDER_FAMILIES = [
  "ambient",
  "ecowitt",
  "netatmo",
  "tempest",
] as const;

// name one observation provider family
export type ForecastObservationProviderFamily =
  (typeof FORECAST_OBSERVATION_PROVIDER_FAMILIES)[number];

// describe literal source quality handling
export interface ForecastObservationQualityRule {
  readonly allowedFlags: readonly string[];
  readonly statusRule: "absent" | "absent_or_provider_qc_1";
}

// describe one accepted source interval
export interface ForecastObservationSourceLineage {
  readonly acceptedEndExclusive: string | null;
  readonly acceptedStartInclusive: string | null;
  readonly adapterContract: string;
  readonly checkedFingerprint: string;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly qualityRule: ForecastObservationQualityRule;
  readonly sourceKey: string;
  readonly supersededSourceKeys: readonly string[];
}

// describe one source with an intentionally empty accepted interval
export interface ForecastObservationExcludedSourceLineage {
  readonly acceptedIntervals: readonly [];
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly reasonCode: "source_superseded";
  readonly sourceKey: string;
  readonly successorSourceKey: string;
}

// describe one frozen physical station
export interface ForecastObservationStation {
  readonly acceptedSourceKeys: readonly string[];
  readonly distanceMeters: number;
  readonly eligibleMetrics: readonly ForecastAdjustmentMetric[];
  readonly key: ForecastObservationStationKey;
  readonly latitude: number;
  readonly longitude: number;
  readonly nearestRank: number;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly unnormalizedSpatialWeight: number;
}

// freeze physical station keys in lexical order
export const FORECAST_OBSERVATION_STATION_KEYS = [
  "ambient-maxweather",
  "ambient-merlin",
  "ballydidean-ecowitt",
  "netatmo-nearby",
  "tempest-126537",
  "tempest-168853",
  "tempest-201058",
  "tempest-203055",
  "tempest-225947",
  "tempest-38270",
  "tempest-64255",
] as const;

// name one physical station
export type ForecastObservationStationKey =
  (typeof FORECAST_OBSERVATION_STATION_KEYS)[number];

// freeze ordinary quality handling
const ABSENT_QUALITY: ForecastObservationQualityRule = {
  allowedFlags: [],
  statusRule: "absent",
};
// freeze the sole accepted Tempest flag
const TEMPEST_QUALITY: ForecastObservationQualityRule = {
  allowedFlags: ["uv_index_out_of_range"],
  statusRule: "absent",
};
// freeze Weather Underground status handling
const WUNDERGROUND_QUALITY: ForecastObservationQualityRule = {
  allowedFlags: [],
  statusRule: "absent_or_provider_qc_1",
};

// freeze exact accepted source lineages
export const FORECAST_OBSERVATION_SOURCE_LINEAGES = [
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2026-08-24T00:00:00Z",
    adapterContract: "ambient-device-data/v1",
    checkedFingerprint:
      "7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4",
    physicalStationKey: "ambient-maxweather",
    qualityRule: ABSENT_QUALITY,
    sourceKey: "ambient-maxweather-observations-v1",
    supersededSourceKeys: [],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2021-01-01T00:00:00Z",
    adapterContract: "ambient-device-data/v1",
    checkedFingerprint:
      "c3829701bfc25a050022dc3965569d3a87376e8a43b5fdcb7621533f1ae3c65d",
    physicalStationKey: "ambient-merlin",
    qualityRule: ABSENT_QUALITY,
    sourceKey: "ambient-merlin-observations-v1",
    supersededSourceKeys: [],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: null,
    adapterContract: "ecowitt-local-live/v1",
    checkedFingerprint:
      "0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d",
    physicalStationKey: "ballydidean-ecowitt",
    qualityRule: ABSENT_QUALITY,
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    supersededSourceKeys: [],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2022-06-21T00:00:00Z",
    adapterContract: "netatmo-public-measures/v1",
    checkedFingerprint:
      "5495917dd2465a32d9878e73c68781a229b432901cdc4867875726351efbdbbc",
    physicalStationKey: "netatmo-nearby",
    qualityRule: ABSENT_QUALITY,
    sourceKey: "netatmo-nearby-observations-v1",
    supersededSourceKeys: [],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2023-12-17T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "34dafbd6584c93d55ed4d3d43dc7e74a0876165d4ddfc921413f7b826dff7ab7",
    physicalStationKey: "tempest-126537",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-126537-observations-v2",
    supersededSourceKeys: ["tempest-126537-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2025-01-22T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "1c7a402337a44a5441775246cbc02da7994599dad6ab83dc04b248303facfea5",
    physicalStationKey: "tempest-168853",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-168853-observations-v2",
    supersededSourceKeys: ["tempest-168853-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2025-12-22T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "a61cce798cddf682da9608dc245659fc7734a6d5304068939d3115ae7d81a50e",
    physicalStationKey: "tempest-201058",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-201058-observations-v2",
    supersededSourceKeys: ["tempest-201058-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2025-12-25T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "9ead4c5359a6a9640f334be91397180aa62b90b0f0ce813b9ff26fe84537acc4",
    physicalStationKey: "tempest-203055",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-203055-observations-v2",
    supersededSourceKeys: ["tempest-203055-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2026-07-14T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "b4dd6105d9a56a7c5d0dc4063f830e1cf28d693222a8de15536dd83d3a6178c4",
    physicalStationKey: "tempest-225947",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-225947-observations-v2",
    supersededSourceKeys: ["tempest-225947-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2021-01-04T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "ce162067aced4ab3522fb83145a21e608ff24dec189097726188e96fd6cca52f",
    physicalStationKey: "tempest-38270",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-38270-observations-v2",
    supersededSourceKeys: ["tempest-38270-observations-v1"],
  },
  {
    acceptedEndExclusive: null,
    acceptedStartInclusive: "2021-12-10T00:00:00Z",
    adapterContract: "tempest-observations/v2",
    checkedFingerprint:
      "8eb488a358375fc3526347d9ef6c9f23080095a22ea874a42ec400b0317d868a",
    physicalStationKey: "tempest-64255",
    qualityRule: TEMPEST_QUALITY,
    sourceKey: "tempest-64255-observations-v2",
    supersededSourceKeys: ["tempest-64255-observations-v1"],
  },
  {
    acceptedEndExclusive: "2026-08-24T00:00:00Z",
    acceptedStartInclusive: "2024-11-29T00:00:00Z",
    adapterContract: "wunderground-pws-history/v1",
    checkedFingerprint:
      "52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c",
    physicalStationKey: "ambient-maxweather",
    qualityRule: WUNDERGROUND_QUALITY,
    sourceKey: "wunderground-maxweather-history-v1",
    supersededSourceKeys: [],
  },
] as const satisfies readonly ForecastObservationSourceLineage[];

// freeze Tempest v1 empty source intervals
export const FORECAST_OBSERVATION_EXCLUDED_SOURCE_LINEAGES = [
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-126537",
    reasonCode: "source_superseded",
    sourceKey: "tempest-126537-observations-v1",
    successorSourceKey: "tempest-126537-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-168853",
    reasonCode: "source_superseded",
    sourceKey: "tempest-168853-observations-v1",
    successorSourceKey: "tempest-168853-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-201058",
    reasonCode: "source_superseded",
    sourceKey: "tempest-201058-observations-v1",
    successorSourceKey: "tempest-201058-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-203055",
    reasonCode: "source_superseded",
    sourceKey: "tempest-203055-observations-v1",
    successorSourceKey: "tempest-203055-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-225947",
    reasonCode: "source_superseded",
    sourceKey: "tempest-225947-observations-v1",
    successorSourceKey: "tempest-225947-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-38270",
    reasonCode: "source_superseded",
    sourceKey: "tempest-38270-observations-v1",
    successorSourceKey: "tempest-38270-observations-v2",
  },
  {
    acceptedIntervals: [],
    physicalStationKey: "tempest-64255",
    reasonCode: "source_superseded",
    sourceKey: "tempest-64255-observations-v1",
    successorSourceKey: "tempest-64255-observations-v2",
  },
] as const satisfies readonly ForecastObservationExcludedSourceLineage[];

// freeze bounded station-row exclusions
export const FORECAST_OBSERVATION_EXCLUSION_REASON_CODES = [
  "metric_ineligible",
  "metric_missing",
  "quality_flag_rejected",
  "quality_status_rejected",
  "source_interval_out_of_range",
  "source_superseded",
  "station_coverage_insufficient",
  "station_direction_calm",
  "station_gust_coverage_incomplete",
] as const;

// name one station-row exclusion
export type ForecastObservationExclusionReasonCode =
  (typeof FORECAST_OBSERVATION_EXCLUSION_REASON_CODES)[number];

// freeze exact station coordinates and spatial weights
export const FORECAST_OBSERVATION_STATIONS = [
  {
    acceptedSourceKeys: [
      "ambient-maxweather-observations-v1",
      "wunderground-maxweather-history-v1",
    ],
    distanceMeters: 1183.45263477189,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "ambient-maxweather",
    latitude: 47.9438,
    longitude: -122.4404,
    nearestRank: 7,
    providerFamily: "ambient",
    unnormalizedSpatialWeight: 0.740663912119109,
  },
  {
    acceptedSourceKeys: ["ambient-merlin-observations-v1"],
    distanceMeters: 910.894120029186,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "ambient-merlin",
    latitude: 47.9551126,
    longitude: -122.4179341,
    nearestRank: 3,
    providerFamily: "ambient",
    unnormalizedSpatialWeight: 0.828203973166963,
  },
  {
    acceptedSourceKeys: ["ecowitt-88f15505d89f-local-live-v1"],
    distanceMeters: 0,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "ballydidean-ecowitt",
    latitude: 47.950429954185445,
    longitude: -122.42797012608193,
    nearestRank: 1,
    providerFamily: "ecowitt",
    unnormalizedSpatialWeight: 1,
  },
  {
    acceptedSourceKeys: ["netatmo-nearby-observations-v1"],
    distanceMeters: 1875.65238057652,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "netatmo-nearby",
    latitude: 47.964228,
    longitude: -122.442459,
    nearestRank: 11,
    providerFamily: "netatmo",
    unnormalizedSpatialWeight: 0.5320513129347486,
  },
  {
    acceptedSourceKeys: ["tempest-126537-observations-v2"],
    distanceMeters: 1398.67236054504,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-126537",
    latitude: 47.9582,
    longitude: -122.44274,
    nearestRank: 8,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.6715596083191008,
  },
  {
    acceptedSourceKeys: ["tempest-168853-observations-v2"],
    distanceMeters: 1077.20962495532,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-168853",
    latitude: 47.95498,
    longitude: -122.44074,
    nearestRank: 6,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.775136628203077,
  },
  {
    acceptedSourceKeys: ["tempest-201058-observations-v2"],
    distanceMeters: 1401.73955268213,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-201058",
    latitude: 47.96244,
    longitude: -122.43369,
    nearestRank: 9,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.670592564378282,
  },
  {
    acceptedSourceKeys: ["tempest-203055-observations-v2"],
    distanceMeters: 1651.02362971156,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-203055",
    latitude: 47.96505,
    longitude: -122.4241,
    nearestRank: 10,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.5947178033706937,
  },
  {
    acceptedSourceKeys: ["tempest-225947-observations-v2"],
    distanceMeters: 940.077920837135,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-225947",
    latitude: 47.94215,
    longitude: -122.42542,
    nearestRank: 4,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.8190433312327082,
  },
  {
    acceptedSourceKeys: ["tempest-38270-observations-v2"],
    distanceMeters: 1066.83643435427,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-38270",
    latitude: 47.95293,
    longitude: -122.41414,
    nearestRank: 5,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.7784918311659549,
  },
  {
    acceptedSourceKeys: ["tempest-64255-observations-v2"],
    distanceMeters: 883.385696754924,
    eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
    key: "tempest-64255",
    latitude: 47.95008,
    longitude: -122.43982,
    nearestRank: 2,
    providerFamily: "tempest",
    unnormalizedSpatialWeight: 0.8367552632922316,
  },
] as const satisfies readonly ForecastObservationStation[];

// freeze complete observation aggregation semantics
export const FORECAST_OBSERVATION_MANIFEST_V1 = {
  aggregationContractVersion: "physical-station-network/v1",
  collisionPolicy: "reject",
  contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.observationManifest,
  directionAggregation: "spatially_weighted_vector_mean",
  directionMinimumResultantVector: 0.25,
  directionMinimumWindSpeedMps: 1,
  earthRadiusMeters: 6_371_008.8,
  eligibleMetrics: FORECAST_ADJUSTMENT_METRICS,
  gustMaximumGapMinutes: 10,
  gustWindowEndInclusiveMinutes: 0,
  gustWindowStartExclusiveMinutes: -60,
  gapPolicy: "missing",
  instantWindowEndExclusiveMinutes: 5,
  instantWindowStartInclusiveMinutes: -5,
  minimumEligibleStations: 3,
  nearestEligibleStationCount: 3,
  networkEventWeight: 1,
  preAggregationIdentity: "physicalStationKey,validAt,metric",
  requiresNearestEligibleStation: true,
  scalarAggregation: "deterministic_spatially_weighted_median",
  site: {
    key: "ballydidean",
    latitude: 47.950429954185445,
    longitude: -122.42797012608193,
    timezone: "America/Los_Angeles",
  },
  excludedSourceLineages: FORECAST_OBSERVATION_EXCLUDED_SOURCE_LINEAGES,
  sourceLineages: FORECAST_OBSERVATION_SOURCE_LINEAGES,
  spatialFormula: "1/(1+(distanceMeters/2000)^2)",
  spatialNormalizationOrder: "physical_station_key_lexicographic",
  spatialScaleMeters: 2_000,
  stations: FORECAST_OBSERVATION_STATIONS,
} as const;

// freeze provider-balanced LOSO thresholds
export const PROVIDER_BALANCED_LOSO_CONTRACT_V1 = {
  bootstrapContractVersion: "moving-block-bootstrap/v1",
  bootstrapLowerBoundExclusive: 0,
  contractVersion: "provider-balanced-loso/v1",
  developmentOnly: true,
  familyAggregation: "equal_station_then_equal_family",
  minimumImprovementFraction: 0.02,
  minimumNonnegativeStationFraction: 0.8,
  minimumProviderFamiliesPerFold: 3,
  minimumRemainingNetworkScoreEvents: 100,
  minimumScoreableStationsPerFold: 5,
  minimumStationScoreMatches: 100,
  minimumStationTrainingMatches: 500,
  materialHarmMinimumEvents: 100,
  noMaterialHarm: true,
  providerFamilies: FORECAST_OBSERVATION_PROVIDER_FAMILIES,
} as const;

// identify one forecast network event
export interface ForecastNetworkEventIdentity {
  readonly cohort: ForecastTrainingCohort;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.networkEvent;
  readonly leadBand: ForecastLeadBandKey;
  readonly metric: ForecastAdjustmentMetric;
  readonly referenceKind: ForecastReferenceKind;
  readonly siteKey: "ballydidean";
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// create one equal-weight network event identity
export function createForecastNetworkEventIdentity(
  input: Omit<ForecastNetworkEventIdentity, "contractVersion" | "leadBand" | "siteKey">,
): ForecastNetworkEventIdentity {
  validateCohortReferencePair(input.cohort, input.referenceKind);
  validateForecastAdjustmentMetric(input.metric);

  return {
    cohort: input.cohort,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.networkEvent,
    leadBand: forecastLeadBandFor(input.targetLeadHours),
    metric: input.metric,
    referenceKind: input.referenceKind,
    siteKey: "ballydidean",
    targetLeadHours: input.targetLeadHours,
    validAt: validateUtcInstant(input.validAt, "validAt"),
  };
}

// serialize one network event identity
export function forecastNetworkEventKey(
  identity: ForecastNetworkEventIdentity,
): string {
  return canonicalizeJson(identity as unknown as JsonValue);
}

// bind immutable training provenance hashes
export interface ForecastAdjustmentTrainingProvenance {
  readonly aggregationContractSha256: string;
  readonly coordinateManifestSha256: string;
  readonly metricEligibilitySha256: string;
  readonly observationSourceLineageSha256: string;
  readonly observationStationManifestSha256: string;
  readonly spatialWeightSha256: string;
}

// identify one enabled metric-band pair
export interface ForecastAdjustmentMetricBand {
  readonly leadBand: ForecastLeadBandKey;
  readonly metric: ForecastAdjustmentMetric;
}

// describe exact served forecast identity
export interface ForecastAdjustmentForecastIdentity {
  readonly adapterVersion: string;
  readonly cohort: "legacy_v4_retrieval_snapshot";
  readonly contractEpoch: string;
  readonly dataset: string;
  readonly referenceKind: "retrieval_snapshot";
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly upstreamModel: string;
}

// describe one fitted hierarchy coefficient
export interface ForecastAdjustmentCoefficient {
  readonly coefficient: number;
  readonly daypart: "afternoon" | "evening" | "morning" | "night" | null;
  readonly effectiveEventCount: number;
  readonly leadBand: ForecastLeadBandKey;
  readonly level: 1 | 2 | 3;
  readonly metric: ForecastAdjustmentMetric;
  readonly month: number | null;
  readonly season: "autumn" | "spring" | "summer" | "winter" | null;
}

// describe one non-direction training envelope
export interface ForecastAdjustmentTrainingEnvelope {
  readonly leadBand: ForecastLeadBandKey;
  readonly maximum: number;
  readonly metric: Exclude<ForecastAdjustmentMetric, "windDirectionDegrees">;
  readonly minimum: number;
}

// describe metric correction and final-value limits
export interface ForecastAdjustmentMetricPolicy {
  readonly correctionMaximum: number;
  readonly correctionMinimum: number;
  readonly finalMaximum: number;
  readonly finalMaximumExclusive: boolean;
  readonly finalMinimum: number;
  readonly metric: ForecastAdjustmentMetric;
  readonly wrapsFinalValue: boolean;
}

// freeze correction and final-value limits
export const FORECAST_ADJUSTMENT_METRIC_POLICIES_V1 = [
  {
    correctionMaximum: 20,
    correctionMinimum: -20,
    finalMaximum: 100,
    finalMaximumExclusive: false,
    finalMinimum: 0,
    metric: "relativeHumidityPercent",
    wrapsFinalValue: false,
  },
  {
    correctionMaximum: 5,
    correctionMinimum: -5,
    finalMaximum: 70,
    finalMaximumExclusive: false,
    finalMinimum: -100,
    metric: "temperatureC",
    wrapsFinalValue: false,
  },
  {
    correctionMaximum: 45,
    correctionMinimum: -45,
    finalMaximum: 360,
    finalMaximumExclusive: true,
    finalMinimum: 0,
    metric: "windDirectionDegrees",
    wrapsFinalValue: true,
  },
  {
    correctionMaximum: 12,
    correctionMinimum: -12,
    finalMaximum: 150,
    finalMaximumExclusive: false,
    finalMinimum: 0,
    metric: "windGustMps",
    wrapsFinalValue: false,
  },
  {
    correctionMaximum: 8,
    correctionMinimum: -8,
    finalMaximum: 150,
    finalMaximumExclusive: false,
    finalMinimum: 0,
    metric: "windSpeedMps",
    wrapsFinalValue: false,
  },
] as const satisfies readonly ForecastAdjustmentMetricPolicy[];

// define the immutable fitted candidate schema
export interface ForecastAdjustmentCandidateV2 {
  readonly algorithmContractVersion: "robust-hierarchical-median/v1";
  readonly candidateArtifactSha256: string;
  readonly coefficientPayloadSha256: string;
  readonly coefficients: readonly ForecastAdjustmentCoefficient[];
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.candidate;
  readonly developmentReportSha256: string;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly evaluationEpochId: string;
  readonly exportManifestSha256: string;
  readonly finalTrainingCutoff: string;
  readonly forecastIdentity: ForecastAdjustmentForecastIdentity;
  readonly metricPolicies: readonly ForecastAdjustmentMetricPolicy[];
  readonly runtimeFingerprint: {
    readonly icuVersion: string;
    readonly tzdataVersion: string;
  };
  readonly siteKey: "ballydidean";
  readonly timezone: "America/Los_Angeles";
  readonly trainingEnvelopes: readonly ForecastAdjustmentTrainingEnvelope[];
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// report one paired aggregate score
export interface ForecastAdjustmentPairedScore {
  readonly adjustedLoss: number;
  readonly bootstrapLowerBound: number;
  readonly bootstrapUpperBound: number;
  readonly eventCount: number;
  readonly rawLoss: number;
  readonly skill: number;
}

// freeze the one nearest-three aggregate identity
export const FORECAST_NEAREST_THREE_SLICE_KEY = "nearest-three" as const;

// freeze exact season-daypart identities
export const FORECAST_SEASON_DAYPART_KEYS = [
  "autumn-afternoon",
  "autumn-evening",
  "autumn-morning",
  "autumn-night",
  "spring-afternoon",
  "spring-evening",
  "spring-morning",
  "spring-night",
  "summer-afternoon",
  "summer-evening",
  "summer-morning",
  "summer-night",
  "winter-afternoon",
  "winter-evening",
  "winter-morning",
  "winter-night",
] as const;

// name one exact season-daypart identity
export type ForecastSeasonDaypartKey =
  (typeof FORECAST_SEASON_DAYPART_KEYS)[number];

// report one typed critical score slice
export type ForecastAdjustmentCriticalSliceScore =
  ForecastAdjustmentPairedScore &
    (
      | {
          readonly key: typeof FORECAST_NEAREST_THREE_SLICE_KEY;
          readonly kind: "nearest_three";
        }
      | {
          readonly key: ForecastObservationProviderFamily;
          readonly kind: "provider_family";
        }
      | {
          readonly key: ForecastSeasonDaypartKey;
          readonly kind: "season_daypart";
        }
      | {
          readonly key: ForecastObservationStationKey;
          readonly kind: "station";
        }
    );

// report one enabled pair's immutable holdout result
export interface ForecastAdjustmentMetricBandEvaluation {
  readonly criticalSlices: readonly ForecastAdjustmentCriticalSliceScore[];
  readonly evaluatedSeasonDaypartKeys: readonly ForecastSeasonDaypartKey[];
  readonly metricBand: ForecastAdjustmentMetricBand;
  readonly network: ForecastAdjustmentPairedScore;
  readonly providerBalanced: ForecastAdjustmentPairedScore;
  readonly scoreableStationKeys: readonly ForecastObservationStationKey[];
}

// define the immutable evaluation report schema
export interface ForecastAdjustmentEvaluationReportV2 {
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.evaluationReport;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly evaluationEpochId: string;
  readonly evaluationReportSha256: string;
  readonly holdoutAccessMarkerSha256: string;
  readonly holdoutEndExclusive: string;
  readonly holdoutEndLocalDate: string;
  readonly holdoutStartInclusive: string;
  readonly holdoutStartLocalDate: string;
  readonly metricBandEvaluations: readonly ForecastAdjustmentMetricBandEvaluation[];
  readonly preregistrationSha256: string;
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// record one explicit qualification gate
export interface ForecastAdjustmentQualificationGate {
  readonly metricBand: ForecastAdjustmentMetricBand;
  readonly name: ForecastAdjustmentQualificationGateName;
  readonly passed: boolean;
  readonly reasonCode: ForecastAdjustmentReasonCode | null;
}

// freeze every required per-pair qualification gate
export const FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES = [
  "pooled_network_improvement",
  "bootstrap_lower_bound",
  "development_fold_skill",
  "critical_slice_no_harm",
  "coefficient_coverage_and_caps",
  "locked_holdout",
  "production_identity",
] as const;

// name one required qualification gate
export type ForecastAdjustmentQualificationGateName =
  (typeof FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES)[number];

// attest durable evidence redundancy
export interface ForecastAdjustmentEvidenceRedundancy {
  readonly attestationSha256: string;
  readonly status: "independent_content_addressed_copy" | "restorable_encrypted_backup";
  readonly verified: boolean;
}

// define the immutable qualification receipt schema
export interface ForecastAdjustmentQualificationReceiptV2 {
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.qualificationReceipt;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly evaluationEpochId: string;
  readonly evaluationReportSha256: string;
  readonly evidenceRedundancy: ForecastAdjustmentEvidenceRedundancy;
  readonly gates: readonly ForecastAdjustmentQualificationGate[];
  readonly holdoutAccessMarkerSha256: string;
  readonly lifecycleState: "qualified" | "rejected";
  readonly passed: boolean;
  readonly preregistrationSha256: string;
  readonly qualificationReceiptSha256: string;
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// unite the immutable evidence triple
export interface ForecastAdjustmentEvidenceTripleV2 {
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly evaluationReport: ForecastAdjustmentEvaluationReportV2;
  readonly qualificationReceipt: ForecastAdjustmentQualificationReceiptV2;
}

// identify one active immutable runtime bundle
export interface ForecastAdjustmentRegistryActiveBundleV1 {
  readonly bundleSha256: string;
  readonly candidateArtifactSha256: string;
  readonly evaluationReportSha256: string;
  readonly path: string;
  readonly qualificationReceiptSha256: string;
}

// define the reviewed registry schema
export interface ForecastAdjustmentRegistryV1 {
  readonly activeBundle: ForecastAdjustmentRegistryActiveBundleV1 | null;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.registry;
}

// define the sanitized runtime bundle schema
export interface ForecastAdjustmentRuntimeBundleV2
  extends ForecastAdjustmentEvidenceTripleV2 {
  readonly bundleSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.runtimeBundle;
  readonly siteKey: "ballydidean";
  readonly timezone: "America/Los_Angeles";
}

// describe the fixed-lead source used only for canary fitting
export interface ForecastAdjustmentWindCanaryTrainingIdentity {
  readonly adapterVersion: string;
  readonly cohort: "fixed_lead_anchor";
  readonly contractEpoch: string;
  readonly dataset: "previous_runs";
  readonly referenceKind: "fixed_lead_anchor";
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly upstreamModel: "best_match";
}

// define one separately versioned transfer-canary candidate
export interface ForecastAdjustmentWindCanaryCandidateV1 {
  readonly algorithmContractVersion: "robust-hierarchical-median/v1";
  readonly artifactKind: "wind_transfer_canary_candidate";
  readonly candidateArtifactSha256: string;
  readonly coefficientPayloadSha256: string;
  readonly coefficients: readonly ForecastAdjustmentCoefficient[];
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryCandidate;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly exportManifestSha256: string;
  readonly finalTrainingCutoff: string;
  readonly runtimeFingerprint: {
    readonly icuVersion: string;
    readonly tzdataVersion: string;
  };
  readonly servedForecastIdentity: ForecastAdjustmentForecastIdentity;
  readonly siteKey: "ballydidean";
  readonly timezone: "America/Los_Angeles";
  readonly trainingEnvelopes: readonly ForecastAdjustmentTrainingEnvelope[];
  readonly trainingForecastIdentity: ForecastAdjustmentWindCanaryTrainingIdentity;
  readonly trainingProvenance: ForecastAdjustmentTrainingProvenance;
}

// report one live-v4 bridge score
export interface ForecastAdjustmentWindCanaryBridgeScore {
  readonly adjustedLoss: number;
  readonly eventCount: number;
  readonly rawLoss: number;
  readonly skill: number;
}

// report one live-v4 bridge metric-band result
export interface ForecastAdjustmentWindCanaryBridgeEvaluation {
  readonly metricBand: ForecastAdjustmentMetricBand;
  readonly network: ForecastAdjustmentWindCanaryBridgeScore;
}

// define immutable cross-cohort transfer evidence
export interface ForecastAdjustmentWindCanaryTransferReportV1 {
  readonly artifactKind: "wind_transfer_canary_transfer_report";
  readonly bridgeEndExclusive: string;
  readonly bridgeEvaluations: readonly ForecastAdjustmentWindCanaryBridgeEvaluation[];
  readonly bridgeStartInclusive: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryTransferReport;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly passed: true;
  readonly servedForecastIdentity: ForecastAdjustmentForecastIdentity;
  readonly trainingForecastIdentity: ForecastAdjustmentWindCanaryTrainingIdentity;
  readonly transferReportSha256: string;
}

// record one explicit short-lived operator authorization
export interface ForecastAdjustmentWindCanaryAuthorizationV1 {
  readonly activatedAt: string;
  readonly artifactKind: "wind_transfer_canary_authorization";
  readonly authorizationReason: string;
  readonly authorizationSha256: string;
  readonly authorized: true;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryAuthorization;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly expiresAt: string;
  readonly transferReportSha256: string;
}

// define the isolated canary runtime bundle
export interface ForecastAdjustmentWindCanaryRuntimeBundleV1 {
  readonly artifactKind: "wind_transfer_canary_runtime_bundle";
  readonly authorization: ForecastAdjustmentWindCanaryAuthorizationV1;
  readonly bundleSha256: string;
  readonly candidate: ForecastAdjustmentWindCanaryCandidateV1;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRuntimeBundle;
  readonly siteKey: "ballydidean";
  readonly timezone: "America/Los_Angeles";
  readonly transferReport: ForecastAdjustmentWindCanaryTransferReportV1;
}

// identify one separately selected canary bundle
export interface ForecastAdjustmentWindCanaryRegistryActiveBundleV1 {
  readonly authorizationSha256: string;
  readonly bundleSha256: string;
  readonly candidateArtifactSha256: string;
  readonly path: string;
  readonly transferReportSha256: string;
}

// define the isolated canary registry
export interface ForecastAdjustmentWindCanaryRegistryV1 {
  readonly activeBundle: ForecastAdjustmentWindCanaryRegistryActiveBundleV1 | null;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRegistry;
}

// freeze lifecycle states
export const FORECAST_ADJUSTMENT_LIFECYCLE_STATES = [
  "insufficient_data",
  "candidate",
  "qualified",
  "active",
  "rejected",
  "retired",
] as const;

// name one lifecycle state
export type ForecastAdjustmentLifecycleState =
  (typeof FORECAST_ADJUSTMENT_LIFECYCLE_STATES)[number];

// freeze bounded fail-raw reasons
export const FORECAST_ADJUSTMENT_REASON_CODES = [
  "adjustment_error",
  "bundle_invalid",
  "bundle_missing",
  "canary_expired",
  "canary_killed",
  "coefficient_missing",
  "cross_link_mismatch",
  "direction_calm",
  "evidence_redundancy_missing",
  "hash_mismatch",
  "identity_mismatch",
  "insufficient_data",
  "metric_not_enabled",
  "metric_out_of_bounds",
  "qualification_failed",
  "registry_inactive",
  "registry_invalid",
  "runtime_fingerprint_mismatch",
  "training_envelope_mismatch",
  "unsupported_lead",
  "wrong_cohort",
] as const;

// name one bounded reason code
export type ForecastAdjustmentReasonCode =
  (typeof FORECAST_ADJUSTMENT_REASON_CODES)[number];

// define a fail-raw decision
export interface ForecastAdjustmentFailRawDecision {
  readonly adjustedMetrics: Readonly<Partial<Record<ForecastAdjustmentMetric, never>>>;
  readonly appliedMetrics: readonly [];
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision;
  readonly reasonCode: ForecastAdjustmentReasonCode;
  readonly state: "disabled" | "not_applicable";
}

// describe the exact raw forecast row that was adjusted
export interface ForecastAdjustmentRawForecastProvenance {
  readonly adapterVersion: string;
  readonly cohort: "legacy_v4_retrieval_snapshot";
  readonly contractEpoch: string;
  readonly dataset: string;
  readonly referenceAt: string;
  readonly referenceKind: "retrieval_snapshot";
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly targetLeadHours: number;
  readonly upstreamModel: string;
  readonly validAt: string;
}

// define an active adjustment decision
export interface ForecastAdjustmentActiveDecision {
  readonly adjustedMetrics: Readonly<Partial<Record<ForecastAdjustmentMetric, number>>>;
  readonly algorithmContractVersion: "robust-hierarchical-median/v1";
  readonly appliedMetrics: readonly ForecastAdjustmentMetric[];
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision;
  readonly evaluationReportSha256: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly qualificationReceiptSha256: string;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly reasonCode: null;
  readonly state: "active";
}

// define an active wind-transfer canary decision
export interface ForecastAdjustmentWindCanaryActiveDecision {
  readonly activationKind: "wind_transfer_canary";
  readonly adjustedMetrics: Readonly<Partial<Record<ForecastAdjustmentWindCanaryMetric, number>>>;
  readonly algorithmContractVersion: "robust-hierarchical-median/v1";
  readonly appliedMetrics: readonly ForecastAdjustmentWindCanaryMetric[];
  readonly authorizationSha256: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision;
  readonly leadBand: ForecastLeadBandKey;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly reasonCode: null;
  readonly state: "active";
  readonly transferReportSha256: string;
}

// unite active and fail-raw decisions
export type ForecastAdjustmentDecision =
  | ForecastAdjustmentActiveDecision
  | ForecastAdjustmentWindCanaryActiveDecision
  | ForecastAdjustmentFailRawDecision;

// freeze fitted candidate fields
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
// freeze evaluation report fields
const EVALUATION_REPORT_KEYS = new Set([
  "candidateArtifactSha256",
  "contractVersion",
  "enabledMetricBands",
  "evaluationEpochId",
  "evaluationReportSha256",
  "holdoutAccessMarkerSha256",
  "holdoutEndExclusive",
  "holdoutEndLocalDate",
  "holdoutStartInclusive",
  "holdoutStartLocalDate",
  "metricBandEvaluations",
  "preregistrationSha256",
  "trainingProvenance",
]);
// freeze qualification receipt fields
const QUALIFICATION_RECEIPT_KEYS = new Set([
  "candidateArtifactSha256",
  "contractVersion",
  "enabledMetricBands",
  "evaluationEpochId",
  "evaluationReportSha256",
  "evidenceRedundancy",
  "gates",
  "holdoutAccessMarkerSha256",
  "lifecycleState",
  "passed",
  "preregistrationSha256",
  "qualificationReceiptSha256",
  "trainingProvenance",
]);
// freeze registry fields
const REGISTRY_KEYS = new Set(["activeBundle", "contractVersion"]);
// freeze active registry fields
const REGISTRY_ACTIVE_BUNDLE_KEYS = new Set([
  "bundleSha256",
  "candidateArtifactSha256",
  "evaluationReportSha256",
  "path",
  "qualificationReceiptSha256",
]);
// freeze runtime bundle fields
const RUNTIME_BUNDLE_KEYS = new Set([
  "bundleSha256",
  "candidate",
  "contractVersion",
  "evaluationReport",
  "qualificationReceipt",
  "siteKey",
  "timezone",
]);
// freeze metric-band fields
const METRIC_BAND_KEYS = new Set(["leadBand", "metric"]);
// freeze forecast identity fields
const FORECAST_IDENTITY_KEYS = new Set([
  "adapterVersion",
  "cohort",
  "contractEpoch",
  "dataset",
  "referenceKind",
  "sourceConfigFingerprint",
  "sourceKey",
  "upstreamModel",
]);
// freeze runtime fingerprint fields
const RUNTIME_FINGERPRINT_KEYS = new Set(["icuVersion", "tzdataVersion"]);
// freeze coefficient fields
const COEFFICIENT_KEYS = new Set([
  "coefficient",
  "daypart",
  "effectiveEventCount",
  "leadBand",
  "level",
  "metric",
  "month",
  "season",
]);
// freeze training envelope fields
const TRAINING_ENVELOPE_KEYS = new Set([
  "leadBand",
  "maximum",
  "metric",
  "minimum",
]);
// freeze metric policy fields
const METRIC_POLICY_KEYS = new Set([
  "correctionMaximum",
  "correctionMinimum",
  "finalMaximum",
  "finalMaximumExclusive",
  "finalMinimum",
  "metric",
  "wrapsFinalValue",
]);
// freeze paired score fields
const PAIRED_SCORE_KEYS = new Set([
  "adjustedLoss",
  "bootstrapLowerBound",
  "bootstrapUpperBound",
  "eventCount",
  "rawLoss",
  "skill",
]);
// freeze critical slice score fields
const CRITICAL_SLICE_SCORE_KEYS = new Set([
  ...PAIRED_SCORE_KEYS,
  "key",
  "kind",
]);
// freeze metric-band evaluation fields
const METRIC_BAND_EVALUATION_KEYS = new Set([
  "criticalSlices",
  "evaluatedSeasonDaypartKeys",
  "metricBand",
  "network",
  "providerBalanced",
  "scoreableStationKeys",
]);
// freeze qualification gate fields
const QUALIFICATION_GATE_KEYS = new Set([
  "metricBand",
  "name",
  "passed",
  "reasonCode",
]);
// freeze evidence redundancy fields
const EVIDENCE_REDUNDANCY_KEYS = new Set([
  "attestationSha256",
  "status",
  "verified",
]);
// freeze active decision fields
const ACTIVE_DECISION_KEYS = new Set([
  "adjustedMetrics",
  "algorithmContractVersion",
  "appliedMetrics",
  "candidateArtifactSha256",
  "contractVersion",
  "evaluationReportSha256",
  "leadBand",
  "qualificationReceiptSha256",
  "rawForecastProvenance",
  "reasonCode",
  "state",
]);
// freeze canary decision fields
const WIND_CANARY_ACTIVE_DECISION_KEYS = new Set([
  "activationKind",
  "adjustedMetrics",
  "algorithmContractVersion",
  "appliedMetrics",
  "authorizationSha256",
  "candidateArtifactSha256",
  "contractVersion",
  "leadBand",
  "rawForecastProvenance",
  "reasonCode",
  "state",
  "transferReportSha256",
]);
// freeze raw forecast provenance fields
const RAW_FORECAST_PROVENANCE_KEYS = new Set([
  "adapterVersion",
  "cohort",
  "contractEpoch",
  "dataset",
  "referenceAt",
  "referenceKind",
  "sourceConfigFingerprint",
  "sourceKey",
  "targetLeadHours",
  "upstreamModel",
  "validAt",
]);
// freeze training provenance fields
const TRAINING_PROVENANCE_KEYS = new Set([
  "aggregationContractSha256",
  "coordinateManifestSha256",
  "metricEligibilitySha256",
  "observationSourceLineageSha256",
  "observationStationManifestSha256",
  "spatialWeightSha256",
]);

// create an unchanged-raw decision
export function createForecastAdjustmentFailRawDecision(
  state: "disabled" | "not_applicable",
  reasonCode: ForecastAdjustmentReasonCode,
): ForecastAdjustmentFailRawDecision {
  parseForecastAdjustmentReasonCode(reasonCode);

  return {
    adjustedMetrics: {},
    appliedMetrics: [],
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision,
    reasonCode,
    state,
  };
}

// validate one active adjustment response decision
export function validateForecastAdjustmentActiveDecision(
  decision: ForecastAdjustmentActiveDecision,
): void {
  rejectUnknownKeys(decision, ACTIVE_DECISION_KEYS, "active adjustment decision");

  // require exact active response identity
  if (
    decision.contractVersion !== FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision ||
    decision.algorithmContractVersion !== "robust-hierarchical-median/v1" ||
    decision.state !== "active" ||
    decision.reasonCode !== null
  ) {
    throw new RangeError("active adjustment decision identity mismatch");
  }

  validateSha256Hex(decision.candidateArtifactSha256, "candidateArtifactSha256");
  validateSha256Hex(decision.evaluationReportSha256, "evaluationReportSha256");
  validateSha256Hex(
    decision.qualificationReceiptSha256,
    "qualificationReceiptSha256",
  );
  validateRawForecastProvenance(decision.rawForecastProvenance);
  const expectedLeadBand = forecastLeadBandFor(
    decision.rawForecastProvenance.targetLeadHours,
  );

  // require the reported band to match raw provenance
  if (decision.leadBand !== expectedLeadBand) {
    throw new RangeError("active adjustment lead band does not match raw provenance");
  }

  // require at least one unique applied metric
  if (
    decision.appliedMetrics.length === 0 ||
    new Set(decision.appliedMetrics).size !== decision.appliedMetrics.length
  ) {
    throw new RangeError("active adjustment requires unique applied metrics");
  }

  const adjustedMetricKeys = Object.keys(decision.adjustedMetrics);

  // require adjusted values for exactly the applied metrics
  if (
    adjustedMetricKeys.length !== decision.appliedMetrics.length ||
    decision.appliedMetrics.some((metric) => !(metric in decision.adjustedMetrics))
  ) {
    throw new RangeError("adjusted metrics must match applied metrics exactly");
  }

  // validate every adjusted metric value
  for (const metric of decision.appliedMetrics) {
    validateForecastAdjustmentMetric(metric);
    const value = decision.adjustedMetrics[metric];

    // reject missing or impossible derived values
    if (value === undefined) {
      throw new RangeError(`adjusted metric is missing: ${metric}`);
    }

    validateMetricValue(metric, value);
  }
}

// validate one active canary response decision
export function validateForecastAdjustmentWindCanaryActiveDecision(
  decision: ForecastAdjustmentWindCanaryActiveDecision,
): void {
  rejectUnknownKeys(
    decision,
    WIND_CANARY_ACTIVE_DECISION_KEYS,
    "active wind canary decision",
  );

  // require the exact canary response identity
  if (
    decision.activationKind !== "wind_transfer_canary" ||
    decision.contractVersion !== FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.decision ||
    decision.algorithmContractVersion !== "robust-hierarchical-median/v1" ||
    decision.state !== "active" ||
    decision.reasonCode !== null
  ) {
    throw new RangeError("active wind canary decision identity mismatch");
  }

  validateSha256Hex(decision.authorizationSha256, "authorizationSha256");
  validateSha256Hex(decision.candidateArtifactSha256, "candidateArtifactSha256");
  validateSha256Hex(decision.transferReportSha256, "transferReportSha256");
  validateRawForecastProvenance(decision.rawForecastProvenance);
  const expectedLeadBand = forecastLeadBandFor(
    decision.rawForecastProvenance.targetLeadHours,
  );

  // require the reported band to match raw provenance
  if (decision.leadBand !== expectedLeadBand) {
    throw new RangeError("active wind canary lead band does not match raw provenance");
  }

  const adjustedMetricKeys = Object.keys(decision.adjustedMetrics);

  // require at least one unique allowlisted metric
  if (
    decision.appliedMetrics.length === 0 ||
    new Set(decision.appliedMetrics).size !== decision.appliedMetrics.length ||
    decision.appliedMetrics.some(
      (metric) => !FORECAST_ADJUSTMENT_WIND_CANARY_METRICS.includes(metric),
    ) ||
    adjustedMetricKeys.length !== decision.appliedMetrics.length ||
    decision.appliedMetrics.some((metric) => !(metric in decision.adjustedMetrics))
  ) {
    throw new RangeError("active wind canary metrics are invalid");
  }

  // validate every derived wind value
  for (const metric of decision.appliedMetrics) {
    const value = decision.adjustedMetrics[metric];

    // reject missing derived values
    if (value === undefined) {
      throw new RangeError(`adjusted canary metric is missing: ${metric}`);
    }

    validateMetricValue(metric, value);
  }
}

// parse one stable reason code
export function parseForecastAdjustmentReasonCode(
  value: string,
): ForecastAdjustmentReasonCode {
  // reject unbounded diagnostics
  if (!FORECAST_ADJUSTMENT_REASON_CODES.some((reason) => reason === value)) {
    throw new RangeError(`unsupported forecast adjustment reason code: ${value}`);
  }

  return value as ForecastAdjustmentReasonCode;
}

// enforce explicit lifecycle transitions
export function canTransitionForecastAdjustmentLifecycle(
  from: ForecastAdjustmentLifecycleState,
  to: ForecastAdjustmentLifecycleState,
): boolean {
  const allowed: Readonly<Record<ForecastAdjustmentLifecycleState, readonly ForecastAdjustmentLifecycleState[]>> = {
    active: ["retired"],
    candidate: ["qualified", "rejected"],
    insufficient_data: ["candidate"],
    qualified: ["active", "rejected"],
    rejected: [],
    retired: [],
  };

  return allowed[from].some((state) => state === to);
}

// validate a promotable candidate/report/receipt triple
export function validatePromotableForecastAdjustmentEvidence(
  evidence: ForecastAdjustmentEvidenceTripleV2,
): void {
  const { candidate, evaluationReport, qualificationReceipt } = evidence;
  validateCandidateContract(candidate);
  validateEvaluationReportContract(evaluationReport);
  validateQualificationReceiptContract(qualificationReceipt);

  // require candidate-report linkage
  if (
    evaluationReport.candidateArtifactSha256 !== candidate.candidateArtifactSha256
  ) {
    throw new RangeError("evaluation report candidate cross-link mismatch");
  }

  // require receipt-evidence linkage
  if (
    qualificationReceipt.candidateArtifactSha256 !==
      candidate.candidateArtifactSha256 ||
    qualificationReceipt.evaluationReportSha256 !==
      evaluationReport.evaluationReportSha256 ||
    qualificationReceipt.preregistrationSha256 !==
      evaluationReport.preregistrationSha256 ||
    qualificationReceipt.holdoutAccessMarkerSha256 !==
      evaluationReport.holdoutAccessMarkerSha256
  ) {
    throw new RangeError("qualification receipt evidence cross-link mismatch");
  }

  // require one immutable evaluation epoch
  if (
    candidate.evaluationEpochId !== evaluationReport.evaluationEpochId ||
    candidate.evaluationEpochId !== qualificationReceipt.evaluationEpochId
  ) {
    throw new RangeError("evaluation epoch cross-link mismatch");
  }

  // require fitting to precede locked holdout access
  if (
    Date.parse(candidate.finalTrainingCutoff) >=
    Date.parse(evaluationReport.holdoutStartInclusive)
  ) {
    throw new RangeError("candidate training cutoff must precede holdout");
  }

  // require identical enabled sets
  if (
    canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(
        evaluationReport.enabledMetricBands as unknown as JsonValue,
      ) ||
    canonicalizeJson(candidate.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(
        qualificationReceipt.enabledMetricBands as unknown as JsonValue,
      )
  ) {
    throw new RangeError("enabled metric-band cross-link mismatch");
  }

  // require identical training provenance
  if (
    canonicalizeJson(candidate.trainingProvenance as unknown as JsonValue) !==
      canonicalizeJson(
        evaluationReport.trainingProvenance as unknown as JsonValue,
      ) ||
    canonicalizeJson(candidate.trainingProvenance as unknown as JsonValue) !==
      canonicalizeJson(
        qualificationReceipt.trainingProvenance as unknown as JsonValue,
      )
  ) {
    throw new RangeError("training provenance cross-link mismatch");
  }

  // require a passing qualified receipt
  if (
    qualificationReceipt.passed !== true ||
    qualificationReceipt.lifecycleState !== "qualified" ||
    qualificationReceipt.gates.some((gate) => gate.passed !== true)
  ) {
    throw new RangeError("qualification receipt is not passing");
  }

  // require durable evidence redundancy
  if (qualificationReceipt.evidenceRedundancy.verified !== true) {
    throw new RangeError("qualification evidence redundancy is not verified");
  }
}

// validate a reviewed registry contract
export function validateForecastAdjustmentRegistry(
  registry: ForecastAdjustmentRegistryV1,
): void {
  rejectUnknownKeys(registry, REGISTRY_KEYS, "forecast adjustment registry");

  // require exact registry version
  if (registry.contractVersion !== FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.registry) {
    throw new RangeError("unsupported forecast adjustment registry contract");
  }

  // allow the initial inactive registry
  if (registry.activeBundle === null) {
    return;
  }

  const active = registry.activeBundle;
  rejectUnknownKeys(
    active,
    REGISTRY_ACTIVE_BUNDLE_KEYS,
    "forecast adjustment registry active bundle",
  );
  validateSha256Hex(active.bundleSha256, "activeBundle.bundleSha256");
  validateSha256Hex(
    active.candidateArtifactSha256,
    "activeBundle.candidateArtifactSha256",
  );
  validateSha256Hex(
    active.evaluationReportSha256,
    "activeBundle.evaluationReportSha256",
  );
  validateSha256Hex(
    active.qualificationReceiptSha256,
    "activeBundle.qualificationReceiptSha256",
  );

  // require exact content-addressed relative path
  if (active.path !== `bundles/sha256-${active.bundleSha256}.json`) {
    throw new RangeError("active bundle path must match its SHA-256 identity");
  }
}

// validate registry, bundle, and evidence links without computing hashes
export function validateForecastAdjustmentRuntimeBundleLinks(
  registry: ForecastAdjustmentRegistryV1,
  bundle: ForecastAdjustmentRuntimeBundleV2,
): void {
  validateForecastAdjustmentRegistry(registry);
  rejectUnknownKeys(bundle, RUNTIME_BUNDLE_KEYS, "forecast adjustment runtime bundle");

  // require an active selection
  if (registry.activeBundle === null) {
    throw new RangeError("registry has no active bundle");
  }

  // require exact bundle schema
  if (
    bundle.contractVersion !==
    FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.runtimeBundle
  ) {
    throw new RangeError("unsupported forecast adjustment runtime bundle");
  }

  validateSha256Hex(bundle.bundleSha256, "bundleSha256");
  validatePromotableForecastAdjustmentEvidence(bundle);
  const active = registry.activeBundle;

  // require registry-to-bundle linkage
  if (
    active.bundleSha256 !== bundle.bundleSha256 ||
    active.candidateArtifactSha256 !==
      bundle.candidate.candidateArtifactSha256 ||
    active.evaluationReportSha256 !==
      bundle.evaluationReport.evaluationReportSha256 ||
    active.qualificationReceiptSha256 !==
      bundle.qualificationReceipt.qualificationReceiptSha256
  ) {
    throw new RangeError("registry runtime bundle cross-link mismatch");
  }

  // require one site identity
  if (
    bundle.siteKey !== bundle.candidate.siteKey ||
    bundle.timezone !== bundle.candidate.timezone
  ) {
    throw new RangeError("runtime bundle site identity mismatch");
  }
}

// validate candidate fields whose values are immutable identities
function validateCandidateContract(candidate: ForecastAdjustmentCandidateV2): void {
  rejectUnknownKeys(candidate, CANDIDATE_KEYS, "forecast adjustment candidate");

  // require exact candidate version
  if (
    candidate.contractVersion !== FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.candidate
  ) {
    throw new RangeError("unsupported forecast adjustment candidate contract");
  }

  // require the frozen algorithm and site identity
  if (
    candidate.algorithmContractVersion !== "robust-hierarchical-median/v1" ||
    candidate.siteKey !== "ballydidean" ||
    candidate.timezone !== "America/Los_Angeles"
  ) {
    throw new RangeError("candidate algorithm or site identity mismatch");
  }

  // require the only v1 served cohort
  if (
    candidate.forecastIdentity.cohort !==
      "legacy_v4_retrieval_snapshot" ||
    candidate.forecastIdentity.referenceKind !== "retrieval_snapshot"
  ) {
    throw new RangeError("candidate forecast cohort identity mismatch");
  }

  rejectUnknownKeys(
    candidate.forecastIdentity,
    FORECAST_IDENTITY_KEYS,
    "candidate forecast identity",
  );
  rejectUnknownKeys(
    candidate.runtimeFingerprint,
    RUNTIME_FINGERPRINT_KEYS,
    "candidate runtime fingerprint",
  );

  validateSha256Hex(candidate.candidateArtifactSha256, "candidateArtifactSha256");
  validateSha256Hex(candidate.coefficientPayloadSha256, "coefficientPayloadSha256");
  validateSha256Hex(candidate.developmentReportSha256, "developmentReportSha256");
  validateSha256Hex(candidate.exportManifestSha256, "exportManifestSha256");
  validateSha256Hex(
    candidate.forecastIdentity.sourceConfigFingerprint,
    "forecastIdentity.sourceConfigFingerprint",
  );
  validateTrainingProvenanceHashes(candidate.trainingProvenance);
  validateEnabledMetricBands(candidate.enabledMetricBands);
  validateUtcInstant(candidate.finalTrainingCutoff, "finalTrainingCutoff");
  validateBoundedText(candidate.evaluationEpochId, "evaluationEpochId");
  validateBoundedText(candidate.forecastIdentity.adapterVersion, "adapterVersion");
  validateBoundedText(candidate.forecastIdentity.contractEpoch, "contractEpoch");
  validateBoundedText(candidate.forecastIdentity.dataset, "dataset");
  validateBoundedText(candidate.forecastIdentity.sourceKey, "sourceKey");
  validateBoundedText(candidate.forecastIdentity.upstreamModel, "upstreamModel");
  validateBoundedText(candidate.runtimeFingerprint.icuVersion, "icuVersion");
  validateBoundedText(candidate.runtimeFingerprint.tzdataVersion, "tzdataVersion");

  // require the exact frozen metric policies
  if (
    canonicalizeJson(candidate.metricPolicies as unknown as JsonValue) !==
    canonicalizeJson(
      FORECAST_ADJUSTMENT_METRIC_POLICIES_V1 as unknown as JsonValue,
    )
  ) {
    throw new RangeError("candidate metric policies do not match v1");
  }

  // require exact nested metric policy schemas
  for (const policy of candidate.metricPolicies) {
    rejectUnknownKeys(policy, METRIC_POLICY_KEYS, "candidate metric policy");
  }

  validateCandidateCoefficientCoverage(candidate);
  validateCandidateTrainingEnvelopeCoverage(candidate);
}

// validate immutable evaluation report identities
function validateEvaluationReportContract(
  report: ForecastAdjustmentEvaluationReportV2,
): void {
  rejectUnknownKeys(
    report,
    EVALUATION_REPORT_KEYS,
    "forecast adjustment evaluation report",
  );

  // require exact report version
  if (
    report.contractVersion !==
    FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.evaluationReport
  ) {
    throw new RangeError("unsupported forecast adjustment evaluation report");
  }

  validateSha256Hex(report.candidateArtifactSha256, "candidateArtifactSha256");
  validateSha256Hex(report.evaluationReportSha256, "evaluationReportSha256");
  validateSha256Hex(
    report.holdoutAccessMarkerSha256,
    "holdoutAccessMarkerSha256",
  );
  validateSha256Hex(report.preregistrationSha256, "preregistrationSha256");
  validateTrainingProvenanceHashes(report.trainingProvenance);
  validateEnabledMetricBands(report.enabledMetricBands);
  validateBoundedText(report.evaluationEpochId, "evaluationEpochId");
  validateHoldoutBounds(report);

  // require one evaluation for every enabled pair
  if (report.metricBandEvaluations.length !== report.enabledMetricBands.length) {
    throw new RangeError("evaluation coverage must match the enabled metric-band set");
  }

  // validate exact ordered evaluation coverage
  for (const [index, evaluation] of report.metricBandEvaluations.entries()) {
    rejectUnknownKeys(
      evaluation,
      METRIC_BAND_EVALUATION_KEYS,
      "metric-band evaluation",
    );
    validateMetricBand(evaluation.metricBand);
    const enabledPair = report.enabledMetricBands[index];

    // require the matching enabled pair at this position
    if (
      enabledPair === undefined ||
      metricBandKey(evaluation.metricBand) !== metricBandKey(enabledPair)
    ) {
      throw new RangeError("metric-band evaluation order or coverage mismatch");
    }

    validatePairedScore(evaluation.network, "network score");
    validatePairedScore(evaluation.providerBalanced, "provider-balanced score");
    // require promotable network and provider-balanced thresholds
    if (
      evaluation.network.skill < 0.02 ||
      evaluation.network.bootstrapLowerBound <= 0 ||
      isMaterialHarm(evaluation.providerBalanced)
    ) {
      throw new RangeError("metric-band evaluation does not meet promotable thresholds");
    }

    // validate every reported critical slice
    for (const slice of evaluation.criticalSlices) {
      rejectUnknownKeys(
        slice,
        CRITICAL_SLICE_SCORE_KEYS,
        "critical slice score",
      );
      validateBoundedText(slice.key, "criticalSlice.key");
      validateCriticalSliceKind(slice.kind);
      validatePairedScore(
        slice,
        "critical slice score",
        CRITICAL_SLICE_SCORE_KEYS,
      );

      // reject any material-harm slice with enough events
      if (slice.eventCount >= 100 && isMaterialHarm(slice)) {
        throw new RangeError("critical slice has material harm");
      }
    }

    validateCriticalSliceCoverage(
      evaluation.criticalSlices,
      evaluation.scoreableStationKeys,
      evaluation.evaluatedSeasonDaypartKeys,
    );
  }
}

// validate immutable qualification receipt identities
function validateQualificationReceiptContract(
  receipt: ForecastAdjustmentQualificationReceiptV2,
): void {
  rejectUnknownKeys(
    receipt,
    QUALIFICATION_RECEIPT_KEYS,
    "forecast adjustment qualification receipt",
  );

  // require exact receipt version
  if (
    receipt.contractVersion !==
    FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.qualificationReceipt
  ) {
    throw new RangeError("unsupported forecast adjustment qualification receipt");
  }

  validateSha256Hex(receipt.candidateArtifactSha256, "candidateArtifactSha256");
  validateSha256Hex(receipt.evaluationReportSha256, "evaluationReportSha256");
  validateSha256Hex(
    receipt.evidenceRedundancy.attestationSha256,
    "evidenceRedundancy.attestationSha256",
  );
  validateSha256Hex(
    receipt.holdoutAccessMarkerSha256,
    "holdoutAccessMarkerSha256",
  );
  validateSha256Hex(receipt.preregistrationSha256, "preregistrationSha256");
  validateSha256Hex(
    receipt.qualificationReceiptSha256,
    "qualificationReceiptSha256",
  );
  validateTrainingProvenanceHashes(receipt.trainingProvenance);
  validateEnabledMetricBands(receipt.enabledMetricBands);
  validateBoundedText(receipt.evaluationEpochId, "evaluationEpochId");
  rejectUnknownKeys(
    receipt.evidenceRedundancy,
    EVIDENCE_REDUNDANCY_KEYS,
    "qualification evidence redundancy",
  );

  // require one known redundancy proof
  if (
    receipt.evidenceRedundancy.status !==
      "independent_content_addressed_copy" &&
    receipt.evidenceRedundancy.status !== "restorable_encrypted_backup"
  ) {
    throw new RangeError("unsupported qualification evidence redundancy status");
  }

  const requiredGateCount =
    receipt.enabledMetricBands.length *
    FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES.length;

  // require every per-pair qualification gate exactly once
  if (receipt.gates.length !== requiredGateCount) {
    throw new RangeError("qualification receipt gate cardinality mismatch");
  }

  // require deterministic pair-major gate coverage
  for (const [index, gate] of receipt.gates.entries()) {
    rejectUnknownKeys(gate, QUALIFICATION_GATE_KEYS, "qualification gate");
    validateMetricBand(gate.metricBand);
    const pairIndex = Math.floor(
      index / FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES.length,
    );
    const gateIndex =
      index % FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES.length;
    const expectedPair = receipt.enabledMetricBands[pairIndex];
    const expectedGateName = FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES[gateIndex];

    // require the exact enabled pair and gate name
    if (
      expectedPair === undefined ||
      expectedGateName === undefined ||
      metricBandKey(gate.metricBand) !== metricBandKey(expectedPair) ||
      gate.name !== expectedGateName
    ) {
      throw new RangeError("qualification receipt gate coverage mismatch");
    }

    // require no failure reason on a passing gate
    if (gate.passed && gate.reasonCode !== null) {
      throw new RangeError("passing qualification gate must not have a reason code");
    }

    // require one stable reason on a failed gate
    if (!gate.passed && gate.reasonCode === null) {
      throw new RangeError("failed qualification gate requires a reason code");
    }

    // validate any present reason
    if (gate.reasonCode !== null) {
      parseForecastAdjustmentReasonCode(gate.reasonCode);
    }
  }

  const allGatesPass = receipt.gates.every((gate) => gate.passed);

  // require receipt state to agree with all gates
  if (
    receipt.passed !== allGatesPass ||
    (receipt.passed && receipt.lifecycleState !== "qualified") ||
    (!receipt.passed && receipt.lifecycleState !== "rejected")
  ) {
    throw new RangeError("qualification receipt state does not match its gates");
  }
}

// validate exact candidate coefficient coverage and caps
function validateCandidateCoefficientCoverage(
  candidate: ForecastAdjustmentCandidateV2,
): void {
  const enabledKeys = new Set(candidate.enabledMetricBands.map(metricBandKey));
  const rootCounts = new Map<string, number>();
  const cellKeys = new Set<string>();

  // initialize every required root
  for (const key of enabledKeys) {
    rootCounts.set(key, 0);
  }

  // validate every fitted coefficient
  for (const coefficient of candidate.coefficients) {
    rejectUnknownKeys(coefficient, COEFFICIENT_KEYS, "candidate coefficient");
    validateMetricBand({
      leadBand: coefficient.leadBand,
      metric: coefficient.metric,
    });
    const pairKey = metricBandKey(coefficient);

    // reject coefficients outside the enabled set
    if (!enabledKeys.has(pairKey)) {
      throw new RangeError("candidate coefficient is outside the enabled set");
    }

    // require finite coefficient evidence
    if (
      !Number.isFinite(coefficient.coefficient) ||
      !Number.isFinite(coefficient.effectiveEventCount) ||
      coefficient.effectiveEventCount < 0
    ) {
      throw new RangeError("candidate coefficient values must be finite and nonnegative");
    }

    const policy = FORECAST_ADJUSTMENT_METRIC_POLICIES_V1.find(
      (candidatePolicy) => candidatePolicy.metric === coefficient.metric,
    );

    // require the metric policy and cap
    if (
      policy === undefined ||
      coefficient.coefficient < policy.correctionMinimum ||
      coefficient.coefficient > policy.correctionMaximum
    ) {
      throw new RangeError("candidate coefficient exceeds its metric cap");
    }

    validateCoefficientHierarchy(coefficient);
    const cellKey = canonicalizeJson({
      daypart: coefficient.daypart,
      leadBand: coefficient.leadBand,
      level: coefficient.level,
      metric: coefficient.metric,
      month: coefficient.month,
      season: coefficient.season,
    });

    // reject duplicate fitted cells
    if (cellKeys.has(cellKey)) {
      throw new RangeError("candidate contains a duplicate coefficient cell");
    }

    cellKeys.add(cellKey);

    // count exact enabled roots
    if (coefficient.level === 1) {
      rootCounts.set(pairKey, (rootCounts.get(pairKey) ?? 0) + 1);
    }
  }

  // require exactly one root for every enabled pair
  for (const [key, count] of rootCounts) {
    // reject missing or duplicate roots
    if (count !== 1) {
      throw new RangeError(`enabled metric-band requires exactly one root: ${key}`);
    }
  }
}

// validate one hierarchy coefficient cell
function validateCoefficientHierarchy(
  coefficient: ForecastAdjustmentCoefficient,
): void {
  // validate the root cell
  if (coefficient.level === 1) {
    // require root-only fields and count
    if (
      coefficient.daypart !== null ||
      coefficient.month !== null ||
      coefficient.season !== null ||
      coefficient.effectiveEventCount < 200
    ) {
      throw new RangeError("level-1 coefficient shape or count is invalid");
    }

    return;
  }

  // validate the season-daypart cell
  if (coefficient.level === 2) {
    // require season-daypart fields and count
    if (
      coefficient.daypart === null ||
      coefficient.month !== null ||
      coefficient.season === null ||
      coefficient.effectiveEventCount < 100
    ) {
      throw new RangeError("level-2 coefficient shape or count is invalid");
    }

    validateDaypart(coefficient.daypart);
    validateSeason(coefficient.season);
    return;
  }

  // validate the month-daypart cell
  if (coefficient.level === 3) {
    // require month-daypart fields and count
    if (
      coefficient.daypart === null ||
      coefficient.season !== null ||
      !Number.isInteger(coefficient.month) ||
      coefficient.month === null ||
      coefficient.month < 1 ||
      coefficient.month > 12 ||
      coefficient.effectiveEventCount < 50
    ) {
      throw new RangeError("level-3 coefficient shape or count is invalid");
    }

    validateDaypart(coefficient.daypart);
    return;
  }

  throw new RangeError("unsupported candidate coefficient level");
}

// validate exact scalar training-envelope coverage
function validateCandidateTrainingEnvelopeCoverage(
  candidate: ForecastAdjustmentCandidateV2,
): void {
  const enabledScalarKeys = new Set(
    candidate.enabledMetricBands
      .filter((pair) => pair.metric !== "windDirectionDegrees")
      .map(metricBandKey),
  );
  const envelopeKeys = new Set<string>();

  // validate every training envelope
  for (const envelope of candidate.trainingEnvelopes) {
    rejectUnknownKeys(envelope, TRAINING_ENVELOPE_KEYS, "training envelope");
    validateMetricBand({ leadBand: envelope.leadBand, metric: envelope.metric });
    const key = metricBandKey(envelope);

    // reject direction, disabled, duplicate, or malformed envelopes
    if (
      !enabledScalarKeys.has(key) ||
      envelopeKeys.has(key) ||
      !Number.isFinite(envelope.minimum) ||
      !Number.isFinite(envelope.maximum) ||
      envelope.minimum > envelope.maximum
    ) {
      throw new RangeError("candidate training envelope coverage is invalid");
    }

    validateMetricValue(envelope.metric, envelope.minimum);
    validateMetricValue(envelope.metric, envelope.maximum);
    envelopeKeys.add(key);
  }

  // require every enabled scalar envelope exactly once
  if (
    envelopeKeys.size !== enabledScalarKeys.size ||
    [...enabledScalarKeys].some((key) => !envelopeKeys.has(key))
  ) {
    throw new RangeError("enabled scalar metric-band requires one training envelope");
  }
}

// validate one paired aggregate score
function validatePairedScore(
  score: ForecastAdjustmentPairedScore,
  fieldName: string,
  allowedKeys: ReadonlySet<string> = PAIRED_SCORE_KEYS,
): void {
  rejectUnknownKeys(score, allowedKeys, fieldName);

  // require finite nonnegative losses and positive events
  if (
    !Number.isFinite(score.rawLoss) ||
    score.rawLoss < 0 ||
    !Number.isFinite(score.adjustedLoss) ||
    score.adjustedLoss < 0 ||
    !Number.isFinite(score.bootstrapLowerBound) ||
    !Number.isFinite(score.bootstrapUpperBound) ||
    score.bootstrapLowerBound > score.bootstrapUpperBound ||
    !Number.isFinite(score.skill) ||
    !Number.isSafeInteger(score.eventCount) ||
    score.eventCount < 1
  ) {
    throw new RangeError(`${fieldName} contains invalid values`);
  }

  // apply the literal zero-loss skill rule
  const expectedSkill =
    score.rawLoss === 0
      ? score.adjustedLoss === 0
        ? 0
        : -1
      : (score.rawLoss - score.adjustedLoss) / score.rawLoss;

  // require the literal zero-loss and skill formula
  if (Math.abs(score.skill - expectedSkill) > Number.EPSILON * 8) {
    throw new RangeError(`${fieldName} skill does not match paired losses`);
  }
}

// detect the frozen material-harm condition
function isMaterialHarm(score: ForecastAdjustmentPairedScore): boolean {
  return score.skill <= -0.02 && score.bootstrapUpperBound < 0;
}

// validate one exact metric-band pair
function validateMetricBand(pair: ForecastAdjustmentMetricBand): void {
  rejectUnknownKeys(pair, METRIC_BAND_KEYS, "forecast adjustment metric-band");
  validateForecastAdjustmentMetric(pair.metric);

  // require one exact lead-band key
  if (!FORECAST_LEAD_BANDS.some((band) => band.key === pair.leadBand)) {
    throw new RangeError(`unsupported forecast lead band: ${pair.leadBand}`);
  }
}

// build one stable metric-band key
function metricBandKey(pair: ForecastAdjustmentMetricBand): string {
  return `${pair.metric}:${pair.leadBand}`;
}

// validate holdout local and UTC bounds
function validateHoldoutBounds(
  report: ForecastAdjustmentEvaluationReportV2,
): void {
  const startInclusive = Date.parse(
    validateUtcInstant(report.holdoutStartInclusive, "holdoutStartInclusive"),
  );
  const endExclusive = Date.parse(
    validateUtcInstant(report.holdoutEndExclusive, "holdoutEndExclusive"),
  );
  const startLocalDate = parseLocalDate(
    report.holdoutStartLocalDate,
    "holdoutStartLocalDate",
  );
  const endLocalDate = parseLocalDate(
    report.holdoutEndLocalDate,
    "holdoutEndLocalDate",
  );

  // require increasing instants and exactly 30 local labels
  if (
    startInclusive >= endExclusive ||
    (endLocalDate - startLocalDate) / 86_400_000 !== 29
  ) {
    throw new RangeError("holdout bounds must be increasing and span 30 local dates");
  }
}

// parse one exact Gregorian local date
function parseLocalDate(value: string, fieldName: string): number {
  // require an exact date shape
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new RangeError(`${fieldName} must be an exact local date`);
  }

  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);

  // reject calendar rollovers and invalid dates
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${fieldName} must be a valid local date`);
  }

  return milliseconds;
}

// validate one critical slice kind
function validateCriticalSliceKind(
  kind: ForecastAdjustmentCriticalSliceScore["kind"],
): void {
  // reject unknown slice dimensions
  if (
    kind !== "nearest_three" &&
    kind !== "provider_family" &&
    kind !== "season_daypart" &&
    kind !== "station"
  ) {
    throw new RangeError(`unsupported critical slice kind: ${kind}`);
  }
}

// validate minimum required holdout slice coverage
function validateCriticalSliceCoverage(
  slices: readonly ForecastAdjustmentCriticalSliceScore[],
  scoreableStationKeys: readonly ForecastObservationStationKey[],
  evaluatedSeasonDaypartKeys: readonly ForecastSeasonDaypartKey[],
): void {
  validateScoreableStationKeys(scoreableStationKeys);
  validateEvaluatedSeasonDaypartKeys(evaluatedSeasonDaypartKeys);
  const providerFamilies = new Set<ForecastObservationProviderFamily>();

  // derive exact provider families from scoreable stations
  for (const stationKey of scoreableStationKeys) {
    const station = FORECAST_OBSERVATION_STATIONS.find(
      (candidate) => candidate.key === stationKey,
    );

    // require every station to resolve to the frozen manifest
    if (station === undefined) {
      throw new RangeError(`unknown scoreable station: ${stationKey}`);
    }

    providerFamilies.add(station.providerFamily);
  }

  const sortedProviderFamilies = [...providerFamilies].sort();

  // require the frozen provider-diversity threshold
  if (sortedProviderFamilies.length < 3) {
    throw new RangeError("scoreable stations must span at least three providers");
  }

  // build the exact canonical slice order
  const expectedSlices: ReadonlyArray<
    Readonly<{ key: string; kind: ForecastAdjustmentCriticalSliceScore["kind"] }>
  > = [
    { key: FORECAST_NEAREST_THREE_SLICE_KEY, kind: "nearest_three" },
    ...sortedProviderFamilies.map((key) => ({ key, kind: "provider_family" as const })),
    ...evaluatedSeasonDaypartKeys.map((key) => ({
      key,
      kind: "season_daypart" as const,
    })),
    ...scoreableStationKeys.map((key) => ({ key, kind: "station" as const })),
  ];

  // require exact critical-slice cardinality
  if (slices.length !== expectedSlices.length) {
    throw new RangeError("critical slice coverage cardinality mismatch");
  }

  // require the exact bound slice identities in canonical order
  for (const [index, slice] of slices.entries()) {
    const expected = expectedSlices[index];

    // reject substitutes, duplicates, or underpowered slices
    if (
      expected === undefined ||
      slice.kind !== expected.kind ||
      slice.key !== expected.key ||
      slice.eventCount < 100
    ) {
      throw new RangeError("critical slice identity or coverage mismatch");
    }
  }
}

// validate the bound scoreable station set
function validateScoreableStationKeys(
  stationKeys: readonly ForecastObservationStationKey[],
): void {
  // require the frozen minimum and maximum station counts
  if (stationKeys.length < 5 || stationKeys.length > 11) {
    throw new RangeError("scoreable station set must contain between 5 and 11 stations");
  }

  let previousKey: string | null = null;

  // require exact frozen stations in lexical order
  for (const stationKey of stationKeys) {
    // reject unknown, duplicate, or disordered stations
    if (
      !FORECAST_OBSERVATION_STATION_KEYS.some((key) => key === stationKey) ||
      (previousKey !== null && stationKey <= previousKey)
    ) {
      throw new RangeError("scoreable station set contains an invalid identity");
    }

    previousKey = stationKey;
  }
}

// validate the bound season-daypart set
function validateEvaluatedSeasonDaypartKeys(
  keys: readonly ForecastSeasonDaypartKey[],
): void {
  // require at least one evaluated calendar slice
  if (keys.length < 1 || keys.length > FORECAST_SEASON_DAYPART_KEYS.length) {
    throw new RangeError("evaluated season-daypart set has invalid cardinality");
  }

  let previousKey: string | null = null;

  // require exact calendar identities in lexical order
  for (const key of keys) {
    // reject unknown, duplicate, or disordered calendar identities
    if (
      !FORECAST_SEASON_DAYPART_KEYS.some((candidate) => candidate === key) ||
      (previousKey !== null && key <= previousKey)
    ) {
      throw new RangeError("evaluated season-daypart set contains an invalid identity");
    }

    previousKey = key;
  }
}

// validate one nonnegative integer count
function validateNonnegativeInteger(value: number, fieldName: string): void {
  // reject fractional or negative counts
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a nonnegative integer`);
  }
}

// validate bounded active raw forecast provenance
function validateRawForecastProvenance(
  provenance: ForecastAdjustmentRawForecastProvenance,
): void {
  rejectUnknownKeys(
    provenance,
    RAW_FORECAST_PROVENANCE_KEYS,
    "raw forecast provenance",
  );

  // require the served v4 retrieval cohort
  if (
    provenance.cohort !== "legacy_v4_retrieval_snapshot" ||
    provenance.referenceKind !== "retrieval_snapshot"
  ) {
    throw new RangeError("raw forecast provenance cohort mismatch");
  }

  validateBoundedText(provenance.adapterVersion, "adapterVersion");
  validateBoundedText(provenance.contractEpoch, "contractEpoch");
  validateBoundedText(provenance.dataset, "dataset");
  validateBoundedText(provenance.sourceKey, "sourceKey");
  validateBoundedText(provenance.upstreamModel, "upstreamModel");
  validateSha256Hex(
    provenance.sourceConfigFingerprint,
    "sourceConfigFingerprint",
  );
  const validAt = Date.parse(validateUtcInstant(provenance.validAt, "validAt"));
  const referenceAt = Date.parse(
    validateUtcInstant(provenance.referenceAt, "referenceAt"),
  );
  const targetLeadHours = Math.ceil((validAt - referenceAt) / 3_600_000);

  // require exact supported lead derivation
  if (
    referenceAt > validAt ||
    targetLeadHours < 1 ||
    targetLeadHours > 168 ||
    provenance.targetLeadHours !== targetLeadHours
  ) {
    throw new RangeError("raw forecast provenance lead identity mismatch");
  }
}

// validate one local daypart
function validateDaypart(
  value: ForecastAdjustmentCoefficient["daypart"],
): void {
  // reject unknown dayparts
  if (
    value !== "afternoon" &&
    value !== "evening" &&
    value !== "morning" &&
    value !== "night"
  ) {
    throw new RangeError(`unsupported coefficient daypart: ${String(value)}`);
  }
}

// validate one local season
function validateSeason(value: ForecastAdjustmentCoefficient["season"]): void {
  // reject unknown seasons
  if (
    value !== "autumn" &&
    value !== "spring" &&
    value !== "summer" &&
    value !== "winter"
  ) {
    throw new RangeError(`unsupported coefficient season: ${String(value)}`);
  }
}

// validate all embedded training provenance digests
function validateTrainingProvenanceHashes(
  provenance: ForecastAdjustmentTrainingProvenance,
): void {
  rejectUnknownKeys(
    provenance,
    TRAINING_PROVENANCE_KEYS,
    "forecast adjustment training provenance",
  );

  // validate each named hash
  for (const [fieldName, value] of Object.entries(provenance)) {
    validateSha256Hex(value, `trainingProvenance.${fieldName}`);
  }
}

// require a unique lexical enabled set
function validateEnabledMetricBands(
  enabledMetricBands: readonly ForecastAdjustmentMetricBand[],
): void {
  // require at least one preselected pair
  if (enabledMetricBands.length === 0 || enabledMetricBands.length > 35) {
    throw new RangeError("enabled metric-band set must contain between 1 and 35 pairs");
  }

  let previousKey: string | null = null;

  // verify every pair in lexical order
  for (const pair of enabledMetricBands) {
    validateMetricBand(pair);

    const key = `${pair.metric}:${pair.leadBand}`;

    // reject duplicates or disorder
    if (previousKey !== null && key <= previousKey) {
      throw new RangeError("enabled metric-band set must be unique and lexically sorted");
    }

    previousKey = key;
  }
}

// validate one adjustable metric
function validateForecastAdjustmentMetric(
  metric: MetricName,
): asserts metric is ForecastAdjustmentMetric {
  // reject every schema-level ineligible metric
  if (!FORECAST_ADJUSTMENT_METRICS.some((candidate) => candidate === metric)) {
    throw new RangeError(`metric is not adjustable in v1: ${metric}`);
  }
}

// require the only two truthful cohort/reference pairings
function validateCohortReferencePair(
  cohort: ForecastTrainingCohort,
  referenceKind: ForecastReferenceKind,
): void {
  // accept fixed anchors only with fixed-anchor reference semantics
  if (cohort === "fixed_lead_anchor" && referenceKind === "fixed_lead_anchor") {
    return;
  }

  // accept legacy v4 only with retrieval semantics
  if (
    cohort === "legacy_v4_retrieval_snapshot" &&
    referenceKind === "retrieval_snapshot"
  ) {
    return;
  }

  throw new RangeError("forecast cohort and reference kind do not match");
}

// validate bounded nonempty contract text
function validateBoundedText(value: string, fieldName: string): string {
  // reject missing or oversized values
  if (value.trim().length === 0 || value.length > 128) {
    throw new RangeError(`${fieldName} must be non-empty and at most 128 chars`);
  }

  return value;
}

// reject schema extension across immutable evidence boundaries
function rejectUnknownKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
  fieldName: string,
): void {
  const keys = Object.keys(value);

  // reject missing or unversioned fields
  if (
    keys.length !== allowedKeys.size ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    throw new RangeError(`${fieldName} does not match its exact schema`);
  }
}
