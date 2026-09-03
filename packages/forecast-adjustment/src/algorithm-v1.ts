import {
  FORECAST_ADJUSTMENT_METRIC_POLICIES_V1,
  FORECAST_OBSERVATION_EXCLUSION_REASON_CODES,
  FORECAST_OBSERVATION_PROVIDER_FAMILIES,
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
  PROVIDER_BALANCED_LOSO_CONTRACT_V1,
  forecastLeadBandFor,
  type ForecastAdjustmentCoefficient,
  type ForecastAdjustmentMetric,
  type ForecastAdjustmentMetricPolicy,
  type ForecastAdjustmentTrainingEnvelope,
  type ForecastLeadBandKey,
  type ForecastObservationProviderFamily,
  type ForecastObservationStationKey,
  type ForecastReferenceKind,
  type ForecastTrainingCohort,
} from "@weather/domain";

import {
  localCalendarFeaturesFor,
  meteorologicalSeasonForMonth,
  type LocalCalendarFeatures,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
  type RuntimeCalendarFingerprint,
} from "./calendar.js";

// freeze the literal algorithm identity
export const FORECAST_ADJUSTMENT_ALGORITHM_VERSION =
  "robust-hierarchical-median/v1" as const;

// freeze spatial math constants
export const EARTH_RADIUS_METERS = 6_371_008.8 as const;
export const SPATIAL_SCALE_METERS = 2_000 as const;
export const MINIMUM_NETWORK_STATIONS = 3 as const;
export const NEAREST_ELIGIBLE_STATION_COUNT = 3 as const;
export const MINIMUM_DIRECTION_RESULTANT = 0.25 as const;
export const MINIMUM_DIRECTION_WIND_SPEED_MPS = 1 as const;

// freeze hierarchy count and prior constants
export const FORECAST_ADJUSTMENT_HIERARCHY = {
  monthDaypart: { level: 3, minimumEffectiveEvents: 50, pseudocount: 50 },
  root: { level: 1, minimumEffectiveEvents: 200, pseudocount: 200 },
  seasonDaypart: { level: 2, minimumEffectiveEvents: 100, pseudocount: 100 },
} as const;

const EXPORT_ROW_KEYS = [
  "adapter_contracts",
  "collision_count",
  "content_hashes",
  "contract_epoch",
  "dataset",
  "exclusion_reason_codes",
  "ingestion_run_ids",
  "physical_station_key",
  "provider_family",
  "record_kind",
  "received_at",
  "reference_at",
  "reference_kind",
  "relative_humidity_percent",
  "site_key",
  "source_config_fingerprints",
  "source_keys",
  "target_lead_hours",
  "temperature_c",
  "upstream_model",
  "valid_at",
  "wind_direction_degrees",
  "wind_gust_mps",
  "wind_speed_mps",
] as const;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const STATION_KEYS = new Set<ForecastObservationStationKey>([
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
]);
const PROVIDER_FAMILIES = new Set<ForecastObservationProviderFamily>(
  FORECAST_OBSERVATION_PROVIDER_FAMILIES,
);
const STATION_EXCLUSION_REASONS = new Set<string>(
  FORECAST_OBSERVATION_EXCLUSION_REASON_CODES,
);
const POPULATED_STATION_REJECTION_REASONS = new Set<string>([
  "metric_ineligible",
  "quality_flag_rejected",
  "quality_status_rejected",
  "source_interval_out_of_range",
  "source_superseded",
  "station_coverage_insufficient",
]);
const FORECAST_EXPORT_IDENTITIES = {
  fixed_lead_anchor: {
    adapterContract: "previous-runs-hourly/v1",
    adapterVersion: "open-meteo-previous-runs/v1",
    contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
    dataset: "previous_runs",
    sourceConfigFingerprint:
      "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
    sourceKey: "open-meteo-previous-runs-v1",
    upstreamModel: "best_match",
  },
  legacy_v4_retrieval_snapshot: {
    adapterContract: "forecast-daily/v4",
    adapterVersion: "open-meteo-forecast-daily/v4",
    contractEpoch:
      "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
    dataset: "forecast",
    sourceConfigFingerprint:
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    sourceKey: "open-meteo-forecast-v4",
    upstreamModel: "best_match",
  },
} as const;

// hold the five sanitized model metrics
export interface SanitizedTrainingMetrics {
  readonly relativeHumidityPercent: number | null;
  readonly temperatureC: number | null;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

// describe shared sanitized export evidence
interface SanitizedTrainingExportRowBase {
  readonly adapterContracts: readonly string[];
  readonly collisionCount: 0;
  readonly contentHashes: readonly string[];
  readonly contractEpoch: string;
  readonly exclusionReasonCodes: readonly string[];
  readonly ingestionRunIds: readonly string[];
  readonly metrics: SanitizedTrainingMetrics;
  readonly receivedAt: string | null;
  readonly siteKey: "ballydidean";
  readonly sourceConfigFingerprints: readonly string[];
  readonly sourceKeys: readonly string[];
  readonly validAt: string;
}

// describe one sanitized station-hour row
export interface SanitizedStationHourRow
  extends SanitizedTrainingExportRowBase {
  readonly dataset: null;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly recordKind: "station_hour";
  readonly referenceAt: null;
  readonly referenceKind: null;
  readonly targetLeadHours: null;
  readonly upstreamModel: null;
}

// describe one sanitized forecast row
export interface SanitizedForecastRow extends SanitizedTrainingExportRowBase {
  readonly adapterVersion: string;
  readonly dataset: string;
  readonly physicalStationKey: null;
  readonly providerFamily: null;
  readonly recordKind:
    | "fixed_lead_anchor"
    | "legacy_v4_retrieval_snapshot";
  readonly referenceAt: string | null;
  readonly referenceKind: ForecastReferenceKind;
  readonly targetLeadHours: number;
  readonly upstreamModel: string;
}

// unite the sanitized training row types
export type SanitizedTrainingExportRow =
  | SanitizedForecastRow
  | SanitizedStationHourRow;

// describe one source observation before hourly selection
export interface StationObservationSample {
  readonly metric: ForecastAdjustmentMetric;
  readonly observedAt: string;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly sourceKey: string;
  readonly stableId: string;
  readonly value: number;
}

// describe one spatial station contribution
export interface SpatialStationValue {
  readonly nearestRank: number;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly unnormalizedSpatialWeight: number;
  readonly value: number;
}

// pair one station direction with its simultaneous wind speed
export interface DirectionSpatialStationValue extends SpatialStationValue {
  readonly pairedWindSpeedMps: number | null;
}

// report one network target
export interface NetworkActual {
  readonly normalizedWeights: readonly {
    readonly normalizedWeight: number;
    readonly physicalStationKey: ForecastObservationStationKey;
  }[];
  readonly stationCount: number;
  readonly value: number;
}

// identify one forecast candidate before jitter deduplication
export interface ForecastAtomicCandidate {
  readonly cohort: ForecastTrainingCohort;
  readonly continuousLeadHours: number;
  readonly metric: ForecastAdjustmentMetric;
  readonly referenceAt: string | null;
  readonly referenceKind: ForecastReferenceKind;
  readonly stableId: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// describe one equally weighted network residual
export interface WeightedResidualObservation {
  readonly referenceAt: string | null;
  readonly residual: number;
  readonly stableId: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
  readonly weight: number;
}

// add local hierarchy features to one residual
export interface HierarchyResidualObservation
  extends WeightedResidualObservation {
  readonly daypart: LocalDaypart;
  readonly month: number;
  readonly season: LocalMeteorologicalSeason;
}

// describe one raw fitted cell before artifact projection
export interface FittedCoefficientCell {
  readonly coefficient: number;
  readonly effectiveEventCount: number;
  readonly rawCoefficient: number;
}

// describe one station-level paired score
export interface StationPairedLoss {
  readonly adjustedLoss: number;
  readonly eventCount: number;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly rawLoss: number;
}

// describe equal-provider aggregate loss
export interface ProviderBalancedLoss {
  readonly adjustedLoss: number;
  readonly eventCount: number;
  readonly providerFamilies: readonly ForecastObservationProviderFamily[];
  readonly rawLoss: number;
  readonly skill: number;
}

// describe LOSO scoreability evidence
export interface LosoStationCoverage {
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly remainingNetworkScoreEvents: number;
  readonly scoreMatches: number;
  readonly trainingMatches: number;
}

// describe one fold's frozen development decision
export interface ProviderBalancedLosoFoldAssessment {
  readonly bootstrapLowerBound: number;
  readonly improvementFraction: number;
  readonly nonnegativeStationFraction: number;
  readonly passed: boolean;
  readonly providerFamilyCount: number;
  readonly scoreableStationCount: number;
}

// describe core fail-raw application input
export interface CoreAdjustmentApplicationInput {
  readonly calendarFingerprintMatches: boolean;
  readonly coefficient: number | null;
  readonly enabled: boolean;
  readonly envelope: { readonly maximum: number; readonly minimum: number } | null;
  readonly identityMatches: boolean;
  readonly metric: ForecastAdjustmentMetric;
  readonly rawForecastValue: number;
  readonly rawWindSpeedMps: number | null;
  readonly rootAvailable: boolean;
}

// report core adjustment or fail-raw
export interface CoreAdjustmentApplicationResult {
  readonly adjustedValue: number;
  readonly applied: boolean;
  readonly reason:
    | "adjusted"
    | "calendar_fingerprint_mismatch"
    | "coefficient_missing"
    | "disabled_metric_band"
    | "forecast_identity_mismatch"
    | "raw_direction_calm"
    | "raw_value_invalid"
    | "raw_value_ood"
    | "root_missing";
}

// require an object without accepting prototypes as evidence
function requireObject(value: unknown, label: string): Record<string, unknown> {
  // reject arrays and null
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one exact key set
function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();

  // reject missing or extra sanitized fields
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new RangeError(`${label} fields do not match the v1 export schema`);
  }
}

// require a canonical UTC instant
function requireUtcInstant(value: unknown, label: string): string {
  // reject offsets, invalid dates, and nonstrings
  if (
    typeof value !== "string" ||
    !UTC_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RangeError(`${label} must be a canonical UTC instant`);
  }

  return new Date(value).toISOString();
}

// require one bounded finite metric value
function requireNullableMetric(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumExclusive: boolean,
  label: string,
): number | null {
  // retain explicit missing metrics
  if (value === null) {
    return null;
  }

  // reject invalid canonical values
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    (maximumExclusive ? value >= maximum : value > maximum)
  ) {
    throw new RangeError(`${label} is outside its canonical range`);
  }

  return value;
}

// require one sorted unique string array
function requireStringArray(
  value: unknown,
  label: string,
  options: {
    readonly hashOnly?: boolean;
    readonly order?: "lexical" | "numeric" | "source_aligned";
  } = {},
): readonly string[] {
  // reject nonarrays or malformed members
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        (options.hashOnly === true && !HASH_PATTERN.test(item)),
    )
  ) {
    throw new RangeError(`${label} must be a string array`);
  }

  const strings = value as string[];
  const expected =
    options.order === "numeric"
      ? [...strings].sort((left, right) => {
          const leftBigInt = BigInt(left);
          const rightBigInt = BigInt(right);
          return leftBigInt < rightBigInt ? -1 : leftBigInt > rightBigInt ? 1 : 0;
        })
      : [...strings].sort();

  // reject unstable ordering or duplicates
  if (
    (options.order !== "source_aligned" &&
      JSON.stringify(strings) !== JSON.stringify(expected)) ||
    new Set(strings).size !== strings.length
  ) {
    throw new RangeError(`${label} must be sorted and unique`);
  }

  return strings;
}

// bind one source lineage to its accepted event-time interval
function stationLineageAcceptsValidAt(
  lineage: (typeof FORECAST_OBSERVATION_SOURCE_LINEAGES)[number],
  validAt: string,
): boolean {
  const validAtMilliseconds = Date.parse(validAt);
  const startMilliseconds =
    lineage.acceptedStartInclusive === null
      ? null
      : Date.parse(lineage.acceptedStartInclusive);
  const endMilliseconds =
    lineage.acceptedEndExclusive === null
      ? null
      : Date.parse(lineage.acceptedEndExclusive);
  return (
    (startMilliseconds === null || validAtMilliseconds >= startMilliseconds) &&
    (endMilliseconds === null || validAtMilliseconds < endMilliseconds)
  );
}

// bind each retained lineage to its literal QC exception contract
function stationLineageQualityContractIsExact(
  lineage: (typeof FORECAST_OBSERVATION_SOURCE_LINEAGES)[number],
): boolean {
  // permit only the discarded Tempest UV flag
  if (lineage.adapterContract === "tempest-observations/v2") {
    return (
      lineage.qualityRule.statusRule === "absent" &&
      JSON.stringify(lineage.qualityRule.allowedFlags) ===
        JSON.stringify(["uv_index_out_of_range"])
    );
  }

  // permit the sole Weather Underground status exception
  if (lineage.adapterContract === "wunderground-pws-history/v1") {
    return (
      lineage.qualityRule.statusRule === "absent_or_provider_qc_1" &&
      lineage.qualityRule.allowedFlags.length === 0
    );
  }

  return (
    lineage.qualityRule.statusRule === "absent" &&
    lineage.qualityRule.allowedFlags.length === 0
  );
}

// parse one exact sanitized export row
export function parseSanitizedTrainingExportRow(
  value: unknown,
): SanitizedTrainingExportRow {
  const row = requireObject(value, "training export row");
  requireExactKeys(row, EXPORT_ROW_KEYS, "training export row");

  // bind the only supported site
  if (row.site_key !== "ballydidean") {
    throw new RangeError("training export row has the wrong site");
  }

  // reject any detected source collision
  if (row.collision_count !== 0) {
    throw new RangeError("training export row contains a source collision");
  }

  const sourceKeys = requireStringArray(row.source_keys, "source_keys");
  const sourceConfigFingerprints = requireStringArray(
    row.source_config_fingerprints,
    "source_config_fingerprints",
    { hashOnly: true, order: "source_aligned" },
  );
  const adapterContracts = requireStringArray(
    row.adapter_contracts,
    "adapter_contracts",
    { order: "source_aligned" },
  );

  // require aligned source provenance
  if (
    sourceKeys.length !== sourceConfigFingerprints.length ||
    sourceKeys.length !== adapterContracts.length
  ) {
    throw new RangeError("training export source provenance is misaligned");
  }

  const receivedAt =
    row.received_at === null
      ? null
      : requireUtcInstant(row.received_at, "received_at");
  const common = {
    adapterContracts,
    collisionCount: 0 as const,
    contentHashes: requireStringArray(row.content_hashes, "content_hashes", {
      hashOnly: true,
    }),
    contractEpoch:
      typeof row.contract_epoch === "string" ? row.contract_epoch : "",
    exclusionReasonCodes: requireStringArray(
      row.exclusion_reason_codes,
      "exclusion_reason_codes",
    ),
    ingestionRunIds: requireStringArray(row.ingestion_run_ids, "ingestion_run_ids", {
      order: "numeric",
    }),
    metrics: {
      relativeHumidityPercent: requireNullableMetric(
        row.relative_humidity_percent,
        0,
        100,
        false,
        "relative_humidity_percent",
      ),
      temperatureC: requireNullableMetric(
        row.temperature_c,
        -100,
        70,
        false,
        "temperature_c",
      ),
      windDirectionDegrees: requireNullableMetric(
        row.wind_direction_degrees,
        0,
        360,
        true,
        "wind_direction_degrees",
      ),
      windGustMps: requireNullableMetric(
        row.wind_gust_mps,
        0,
        150,
        false,
        "wind_gust_mps",
      ),
      windSpeedMps: requireNullableMetric(
        row.wind_speed_mps,
        0,
        150,
        false,
        "wind_speed_mps",
      ),
    },
    receivedAt,
    siteKey: "ballydidean" as const,
    sourceConfigFingerprints,
    sourceKeys,
    validAt: requireUtcInstant(row.valid_at, "valid_at"),
  };

  // reject an empty contract epoch
  if (common.contractEpoch.length === 0) {
    throw new RangeError("contract_epoch must be nonempty");
  }

  // parse the station-hour shape
  if (row.record_kind === "station_hour") {
    // require literal station-only fields
    if (
      typeof row.physical_station_key !== "string" ||
      !STATION_KEYS.has(row.physical_station_key as ForecastObservationStationKey) ||
      typeof row.provider_family !== "string" ||
      !PROVIDER_FAMILIES.has(
        row.provider_family as ForecastObservationProviderFamily,
      ) ||
      row.reference_at !== null ||
      row.reference_kind !== null ||
      row.target_lead_hours !== null ||
      row.dataset !== null ||
      row.upstream_model !== null ||
      common.contractEpoch !== "physical-station-hourly/v1"
    ) {
      throw new RangeError("station-hour export identity is invalid");
    }

    const station = FORECAST_OBSERVATION_STATIONS.find(
      (candidate) => candidate.key === row.physical_station_key,
    );
    const metricValues = Object.values(common.metrics);
    const metricsPresent = metricValues.some((metric) => metric !== null);
    const hasBoundSourceEvidence = sourceKeys.length > 0;

    // reject unknown diagnostic reason codes
    if (
      common.exclusionReasonCodes.some(
        (reason) => !STATION_EXCLUSION_REASONS.has(reason),
      )
    ) {
      throw new RangeError("station-hour exclusion reason is invalid");
    }

    // require explicit whole-station gap diagnostics in both directions
    if (
      (!metricsPresent) !==
      common.exclusionReasonCodes.includes("station_coverage_insufficient")
    ) {
      throw new RangeError("station-hour gap diagnostics are invalid");
    }

    // reject populated direction or gust values carrying exclusion labels
    if (
      (common.metrics.windDirectionDegrees !== null &&
        common.exclusionReasonCodes.includes("station_direction_calm")) ||
      (common.metrics.windGustMps !== null &&
        common.exclusionReasonCodes.includes(
          "station_gust_coverage_incomplete",
        ))
    ) {
      throw new RangeError("station-hour metric exclusion is inconsistent");
    }

    // require nonempty retained evidence for every populated station hour
    if (metricsPresent && !hasBoundSourceEvidence) {
      throw new RangeError("populated station hour lacks bound source evidence");
    }

    // keep rejected QC, interval, supersession, and gaps out of model input
    if (
      metricsPresent &&
      common.exclusionReasonCodes.some((reason) =>
        POPULATED_STATION_REJECTION_REASONS.has(reason),
      )
    ) {
      throw new RangeError("populated station hour carries a rejected lineage");
    }

    // bind station provider and every contributing source lineage
    if (
      station === undefined ||
      station.providerFamily !== row.provider_family ||
      sourceKeys.some((sourceKey, index) => {
        const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
          (candidate) =>
            candidate.sourceKey === sourceKey &&
            candidate.physicalStationKey === row.physical_station_key,
        );
        return (
          lineage === undefined ||
          lineage.checkedFingerprint !== sourceConfigFingerprints[index] ||
          lineage.adapterContract !== adapterContracts[index] ||
          !stationLineageQualityContractIsExact(lineage) ||
          !stationLineageAcceptsValidAt(lineage, common.validAt)
        );
      })
    ) {
      throw new RangeError("station-hour source lineage is invalid");
    }

    return {
      ...common,
      dataset: null,
      physicalStationKey:
        row.physical_station_key as ForecastObservationStationKey,
      providerFamily: row.provider_family as ForecastObservationProviderFamily,
      recordKind: "station_hour",
      referenceAt: null,
      referenceKind: null,
      targetLeadHours: null,
      upstreamModel: null,
    };
  }

  // require a supported forecast record kind
  if (
    row.record_kind !== "fixed_lead_anchor" &&
    row.record_kind !== "legacy_v4_retrieval_snapshot"
  ) {
    throw new RangeError("training export record_kind is unsupported");
  }

  // require literal forecast-only fields
  if (
    row.physical_station_key !== null ||
    row.provider_family !== null ||
    typeof row.dataset !== "string" ||
    row.dataset.length === 0 ||
    typeof row.upstream_model !== "string" ||
    row.upstream_model.length === 0 ||
    !Number.isInteger(row.target_lead_hours) ||
    (row.reference_kind !== "fixed_lead_anchor" &&
      row.reference_kind !== "retrieval_snapshot")
  ) {
    throw new RangeError("forecast export identity is invalid");
  }

  const targetLeadHours = row.target_lead_hours as number;
  forecastLeadBandFor(targetLeadHours);
  const referenceAt =
    row.reference_at === null
      ? null
      : requireUtcInstant(row.reference_at, "reference_at");

  // bind reference shape to forecast cohort
  if (
    (row.record_kind === "fixed_lead_anchor" &&
      (row.reference_kind !== "fixed_lead_anchor" || referenceAt !== null)) ||
    (row.record_kind === "legacy_v4_retrieval_snapshot" &&
      (row.reference_kind !== "retrieval_snapshot" || referenceAt === null))
  ) {
    throw new RangeError("forecast reference identity is invalid");
  }

  const hasMetrics = Object.values(common.metrics).some((metric) => metric !== null);
  const forecastIdentity = FORECAST_EXPORT_IDENTITIES[row.record_kind];

  // bind exact cohort identity and populated evidence
  if (
    sourceKeys.length !== 1 ||
    common.receivedAt === null ||
    common.ingestionRunIds.length === 0 ||
    common.contentHashes.length !== 1 ||
    !hasMetrics ||
    sourceKeys[0] !== forecastIdentity.sourceKey ||
    sourceConfigFingerprints[0] !== forecastIdentity.sourceConfigFingerprint ||
    adapterContracts[0] !== forecastIdentity.adapterContract ||
    common.contractEpoch !== forecastIdentity.contractEpoch ||
    row.dataset !== forecastIdentity.dataset ||
    row.upstream_model !== forecastIdentity.upstreamModel ||
    (row.record_kind === "fixed_lead_anchor" &&
      ![24, 48, 72, 96, 120, 144, 168].includes(targetLeadHours))
  ) {
    throw new RangeError("forecast cohort evidence is invalid");
  }

  // verify retrieval lead without clamping
  if (referenceAt !== null) {
    const continuousLeadHours =
      (Date.parse(common.validAt) - Date.parse(referenceAt)) / 3_600_000;

    // reject future references and projected-lead drift
    if (
      continuousLeadHours < 0 ||
      Math.ceil(continuousLeadHours) !== targetLeadHours
    ) {
      throw new RangeError("forecast retrieval lead is invalid");
    }
  }

  return {
    ...common,
    adapterVersion: forecastIdentity.adapterVersion,
    dataset: row.dataset,
    physicalStationKey: null,
    providerFamily: null,
    recordKind: row.record_kind,
    referenceAt,
    referenceKind: row.reference_kind,
    targetLeadHours,
    upstreamModel: row.upstream_model,
  };
}

// convert degrees to radians
function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

// compute the frozen-radius Haversine distance
export function haversineDistanceMeters(
  first: { readonly latitude: number; readonly longitude: number },
  second: { readonly latitude: number; readonly longitude: number },
): number {
  // reject invalid coordinates
  if (
    !Number.isFinite(first.latitude) ||
    !Number.isFinite(first.longitude) ||
    !Number.isFinite(second.latitude) ||
    !Number.isFinite(second.longitude) ||
    Math.abs(first.latitude) > 90 ||
    Math.abs(second.latitude) > 90 ||
    Math.abs(first.longitude) > 180 ||
    Math.abs(second.longitude) > 180
  ) {
    throw new RangeError("coordinates must be finite latitude/longitude pairs");
  }

  const latitudeDelta = degreesToRadians(second.latitude - first.latitude);
  const longitudeDelta = degreesToRadians(second.longitude - first.longitude);
  const firstLatitude = degreesToRadians(first.latitude);
  const secondLatitude = degreesToRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  const centralAngle =
    2 *
    Math.atan2(
      Math.sqrt(boundedHaversine),
      Math.sqrt(1 - boundedHaversine),
    );
  return EARTH_RADIUS_METERS * centralAngle;
}

// compute one positive frozen spatial weight
export function unnormalizedSpatialWeight(distanceMeters: number): number {
  // reject negative and nonfinite distances
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new RangeError("distanceMeters must be finite and nonnegative");
  }

  return 1 / (1 + (distanceMeters / SPATIAL_SCALE_METERS) ** 2);
}

// wrap an angle into the signed half-open circle
export function wrap180(value: number): number {
  // reject undefined angular arithmetic
  if (!Number.isFinite(value)) {
    throw new RangeError("angle must be finite");
  }

  const wrapped = (((value + 180) % 360) + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

// wrap an angle into the unsigned half-open circle
export function wrap360(value: number): number {
  // reject undefined angular arithmetic
  if (!Number.isFinite(value)) {
    throw new RangeError("angle must be finite");
  }

  const wrapped = ((value % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

// retain direction only when its paired station wind is non-calm
export function eligibleStationDirection(
  directionDegrees: number | null,
  windSpeedMps: number | null,
): number | null {
  // retain missing direction or wind as missing
  if (directionDegrees === null || windSpeedMps === null) {
    return null;
  }

  // reject invalid station wind values
  if (
    !Number.isFinite(directionDegrees) ||
    directionDegrees < 0 ||
    directionDegrees >= 360 ||
    !Number.isFinite(windSpeedMps) ||
    windSpeedMps < 0
  ) {
    throw new RangeError("station direction or paired wind speed is invalid");
  }

  return windSpeedMps < MINIMUM_DIRECTION_WIND_SPEED_MPS
    ? null
    : directionDegrees;
}

// construct one scalar or circular residual under calm exclusion
export function forecastResidual(input: {
  readonly actualValue: number;
  readonly metric: ForecastAdjustmentMetric;
  readonly rawForecastValue: number;
  readonly rawWindSpeedMps: number | null;
}): number | null {
  // reject nonfinite metric values
  if (!Number.isFinite(input.actualValue) || !Number.isFinite(input.rawForecastValue)) {
    throw new RangeError("forecast residual values must be finite");
  }

  // exclude direction when the as-issued forecast is calm
  if (
    input.metric === "windDirectionDegrees" &&
    (input.rawWindSpeedMps === null ||
      !Number.isFinite(input.rawWindSpeedMps) ||
      input.rawWindSpeedMps < MINIMUM_DIRECTION_WIND_SPEED_MPS)
  ) {
    return null;
  }

  return input.metric === "windDirectionDegrees"
    ? wrap180(input.actualValue - input.rawForecastValue)
    : input.actualValue - input.rawForecastValue;
}

// reject duplicate physical-station lineage identities
export function deduplicateStationLineageSamples(
  samples: readonly StationObservationSample[],
): readonly StationObservationSample[] {
  const identities = new Set<string>();
  const sorted = [...samples].sort((left, right) =>
    left.physicalStationKey.localeCompare(right.physicalStationKey) ||
    left.observedAt.localeCompare(right.observedAt) ||
    left.metric.localeCompare(right.metric) ||
    left.stableId.localeCompare(right.stableId),
  );

  // inspect every physical observation identity
  for (const sample of sorted) {
    requireUtcInstant(sample.observedAt, "observedAt");

    // reject nonfinite source values
    if (!Number.isFinite(sample.value)) {
      throw new RangeError("station sample value must be finite");
    }

    const identity = [
      sample.physicalStationKey,
      sample.observedAt,
      sample.metric,
    ].join("\u0000");

    // reject source-lineage collisions
    if (identities.has(identity)) {
      throw new RangeError("station sample contains a source-lineage collision");
    }

    identities.add(identity);
  }

  return sorted;
}

// select the closest instant sample in the half-open ten-minute window
export function selectClosestInstantSample(
  samples: readonly StationObservationSample[],
  validAt: string,
): StationObservationSample | null {
  const targetMilliseconds = Date.parse(requireUtcInstant(validAt, "validAt"));
  const unique = deduplicateStationLineageSamples(samples);
  const stationKeys = new Set(unique.map((sample) => sample.physicalStationKey));
  const metrics = new Set(unique.map((sample) => sample.metric));

  // require one physical station and one instant metric per invocation
  if (stationKeys.size > 1 || metrics.size > 1) {
    throw new RangeError("instant selection requires one station and metric");
  }

  const eligible = unique
    .filter((sample) => {
      const sampleMilliseconds = Date.parse(sample.observedAt);
      return (
        sampleMilliseconds >= targetMilliseconds - 5 * 60_000 &&
        sampleMilliseconds < targetMilliseconds + 5 * 60_000
      );
    })
    .sort((left, right) => {
      const leftMilliseconds = Date.parse(left.observedAt);
      const rightMilliseconds = Date.parse(right.observedAt);
      return (
        Math.abs(leftMilliseconds - targetMilliseconds) -
          Math.abs(rightMilliseconds - targetMilliseconds) ||
        leftMilliseconds - rightMilliseconds ||
        left.stableId.localeCompare(right.stableId)
      );
    });

  return eligible[0] ?? null;
}

// select one covered preceding-hour gust maximum
export function selectCoveredPrecedingHourGust(
  samples: readonly StationObservationSample[],
  validAt: string,
): number | null {
  const targetMilliseconds = Date.parse(requireUtcInstant(validAt, "validAt"));
  const startMilliseconds = targetMilliseconds - 60 * 60_000;
  const unique = deduplicateStationLineageSamples(samples);
  const stationKeys = new Set(unique.map((sample) => sample.physicalStationKey));

  // require one physical station per gust window
  if (stationKeys.size > 1) {
    throw new RangeError("gust selection requires one physical station");
  }

  const eligible = unique
    .filter((sample) => {
      const sampleMilliseconds = Date.parse(sample.observedAt);
      return (
        sample.metric === "windGustMps" &&
        sampleMilliseconds > startMilliseconds &&
        sampleMilliseconds <= targetMilliseconds
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
        left.stableId.localeCompare(right.stableId),
    );
  const first = eligible[0];
  const last = eligible.at(-1);

  // require samples near both interval boundaries
  if (
    first === undefined ||
    last === undefined ||
    Date.parse(first.observedAt) - startMilliseconds > 10 * 60_000 ||
    targetMilliseconds - Date.parse(last.observedAt) > 10 * 60_000
  ) {
    return null;
  }

  // reject any internal gap above ten minutes
  for (let index = 1; index < eligible.length; index += 1) {
    const previous = eligible[index - 1];
    const current = eligible[index];

    // retain the compiler-proven pair
    if (
      previous === undefined ||
      current === undefined ||
      Date.parse(current.observedAt) - Date.parse(previous.observedAt) >
        10 * 60_000
    ) {
      return null;
    }
  }

  return Math.max(...eligible.map((sample) => sample.value));
}

// normalize station weights in lexical key order
function normalizeSpatialValues(
  stations: readonly SpatialStationValue[],
): readonly (SpatialStationValue & { readonly normalizedWeight: number })[] {
  const identities = new Set<ForecastObservationStationKey>();
  const sorted = [...stations].sort((left, right) =>
    left.physicalStationKey.localeCompare(right.physicalStationKey),
  );
  let totalWeight = 0;

  // validate and sum left to right
  for (const station of sorted) {
    // reject duplicate, invalid, or nonpositive station values
    if (
      identities.has(station.physicalStationKey) ||
      !Number.isInteger(station.nearestRank) ||
      station.nearestRank < 1 ||
      !Number.isFinite(station.value) ||
      !Number.isFinite(station.unnormalizedSpatialWeight) ||
      station.unnormalizedSpatialWeight <= 0
    ) {
      throw new RangeError("spatial station values are invalid or duplicated");
    }

    identities.add(station.physicalStationKey);
    totalWeight += station.unnormalizedSpatialWeight;
  }

  return sorted.map((station) => ({
    ...station,
    normalizedWeight: station.unnormalizedSpatialWeight / totalWeight,
  }));
}

// enforce the minimum station and nearest-three target gate
function networkCoveragePasses(
  stations: readonly SpatialStationValue[],
): boolean {
  return (
    stations.length >= MINIMUM_NETWORK_STATIONS &&
    stations.some(
      (station) => station.nearestRank <= NEAREST_ELIGIBLE_STATION_COUNT,
    )
  );
}

// compute the deterministic spatial scalar network actual
export function scalarNetworkActual(
  stations: readonly SpatialStationValue[],
): NetworkActual | null {
  // return missing when physical coverage fails
  if (!networkCoveragePasses(stations)) {
    return null;
  }

  const normalized = normalizeSpatialValues(stations);
  const value = deterministicWeightedMedian(
    normalized.map((station) => ({
      stableId: station.physicalStationKey,
      value: station.value,
      weight: station.normalizedWeight,
    })),
  );

  return {
    normalizedWeights: normalized.map((station) => ({
      normalizedWeight: station.normalizedWeight,
      physicalStationKey: station.physicalStationKey,
    })),
    stationCount: normalized.length,
    value,
  };
}

// compute the deterministic spatial vector network actual
export function directionNetworkActual(
  stations: readonly DirectionSpatialStationValue[],
): NetworkActual | null {
  // validate collisions even when a duplicate station is calm
  normalizeSpatialValues(stations);
  const eligible = stations.filter(
    (station) =>
      eligibleStationDirection(station.value, station.pairedWindSpeedMps) !== null,
  );

  // return missing when physical coverage fails
  if (!networkCoveragePasses(eligible)) {
    return null;
  }

  const normalized = normalizeSpatialValues(eligible);
  let east = 0;
  let north = 0;

  // sum normalized vectors in station-key order
  for (const station of normalized) {
    // reject directions outside the canonical circle
    if (station.value < 0 || station.value >= 360) {
      throw new RangeError("station direction must be in [0,360)");
    }

    const radians = degreesToRadians(station.value);
    east += station.normalizedWeight * Math.sin(radians);
    north += station.normalizedWeight * Math.cos(radians);
  }

  const resultant = Math.hypot(east, north);

  // reject opposed or indeterminate direction targets
  if (resultant < MINIMUM_DIRECTION_RESULTANT) {
    return null;
  }

  return {
    normalizedWeights: normalized.map((station) => ({
      normalizedWeight: station.normalizedWeight,
      physicalStationKey: station.physicalStationKey,
    })),
    stationCount: normalized.length,
    value: wrap360((Math.atan2(east, north) * 180) / Math.PI),
  };
}

// choose one forecast row per atomic jitter key
export function compareForecastAtomicCandidatePriority(
  left: ForecastAtomicCandidate,
  right: ForecastAtomicCandidate,
): number {
  const leftDistance = Math.abs(
    left.continuousLeadHours - left.targetLeadHours,
  );
  const rightDistance = Math.abs(
    right.continuousLeadHours - right.targetLeadHours,
  );
  const leftReference = left.referenceAt ?? "";
  const rightReference = right.referenceAt ?? "";
  return (
    leftDistance - rightDistance ||
    leftReference.localeCompare(rightReference) ||
    left.stableId.localeCompare(right.stableId)
  );
}

// choose one forecast row per atomic jitter key
export function deduplicateForecastAtomicCandidates(
  candidates: readonly ForecastAtomicCandidate[],
): readonly ForecastAtomicCandidate[] {
  const selected = new Map<string, ForecastAtomicCandidate>();

  // compare every projected forecast row
  for (const candidate of candidates) {
    requireUtcInstant(candidate.validAt, "validAt");
    forecastLeadBandFor(candidate.targetLeadHours);
    const referenceAt =
      candidate.referenceAt === null
        ? null
        : requireUtcInstant(candidate.referenceAt, "referenceAt");
    const derivedContinuousLead =
      referenceAt === null
        ? candidate.targetLeadHours
        : (Date.parse(candidate.validAt) - Date.parse(referenceAt)) / 3_600_000;

    // reject inconsistent cohort/reference claims
    if (
      (candidate.cohort === "fixed_lead_anchor" &&
        (candidate.referenceKind !== "fixed_lead_anchor" ||
          referenceAt !== null ||
          candidate.continuousLeadHours !== candidate.targetLeadHours)) ||
      (candidate.cohort === "legacy_v4_retrieval_snapshot" &&
        (candidate.referenceKind !== "retrieval_snapshot" ||
          referenceAt === null ||
          derivedContinuousLead < 0 ||
          Math.ceil(derivedContinuousLead) !== candidate.targetLeadHours)) ||
      !Number.isFinite(candidate.continuousLeadHours) ||
      Math.abs(derivedContinuousLead - candidate.continuousLeadHours) > 1e-12
    ) {
      throw new RangeError("forecast atomic candidate provenance is invalid");
    }

    const key = [
      candidate.validAt,
      candidate.metric,
      candidate.referenceKind,
      candidate.targetLeadHours,
    ].join("\u0000");
    const current = selected.get(key);

    // retain the first candidate for this key
    if (current === undefined) {
      selected.set(key, candidate);
      continue;
    }

    // replace only under the literal jitter tie order
    if (compareForecastAtomicCandidatePriority(candidate, current) < 0) {
      selected.set(key, candidate);
    }
  }

  return [...selected.values()].sort((left, right) =>
    left.validAt.localeCompare(right.validAt) ||
    left.metric.localeCompare(right.metric) ||
    left.referenceKind.localeCompare(right.referenceKind) ||
    left.targetLeadHours - right.targetLeadHours ||
    left.stableId.localeCompare(right.stableId),
  );
}

// assign one unit model weight to every unique network event
export function assignUnitNetworkEventWeights<T extends {
  readonly cohort: ForecastTrainingCohort;
  readonly leadBand: ForecastLeadBandKey;
  readonly metric: ForecastAdjustmentMetric;
  readonly referenceKind: ForecastReferenceKind;
  readonly targetLeadHours: number;
  readonly validAt: string;
}>(events: readonly T[]): readonly (T & { readonly weight: 1 })[] {
  const identities = new Set<string>();

  return events.map((event) => {
    const expectedLeadBand = forecastLeadBandFor(event.targetLeadHours);

    // bind the event to its exact lead and truthful cohort
    if (
      expectedLeadBand !== event.leadBand ||
      (event.cohort === "fixed_lead_anchor" &&
        event.referenceKind !== "fixed_lead_anchor") ||
      (event.cohort === "legacy_v4_retrieval_snapshot" &&
        event.referenceKind !== "retrieval_snapshot")
    ) {
      throw new RangeError("network event lead or cohort identity is invalid");
    }

    const identity = [
      event.validAt,
      event.metric,
      event.cohort,
      event.referenceKind,
      event.leadBand,
      event.targetLeadHours,
    ].join("\u0000");

    // reject duplicate model-count units
    if (identities.has(identity)) {
      throw new RangeError("network event appears more than once");
    }

    identities.add(identity);
    return { ...event, weight: 1 as const };
  });
}

// sort weighted residuals into their canonical addition order
function sortWeightedResiduals(
  observations: readonly WeightedResidualObservation[],
): readonly WeightedResidualObservation[] {
  return [...observations].sort((left, right) =>
    left.residual - right.residual ||
    left.validAt.localeCompare(right.validAt) ||
    left.targetLeadHours - right.targetLeadHours ||
    (left.referenceAt ?? "").localeCompare(right.referenceAt ?? "") ||
    left.stableId.localeCompare(right.stableId),
  );
}

// validate one weighted residual collection
function validateWeightedResiduals(
  observations: readonly WeightedResidualObservation[],
): void {
  // require at least one positive-weight event
  if (observations.length === 0) {
    throw new RangeError("weighted residual observations must not be empty");
  }

  let positiveWeightCount = 0;

  // validate every residual and weight
  for (const observation of observations) {
    requireUtcInstant(observation.validAt, "validAt");

    // reject nonfinite residuals and negative weights
    if (
      !Number.isFinite(observation.residual) ||
      !Number.isFinite(observation.weight) ||
      observation.weight < 0 ||
      !Number.isInteger(observation.targetLeadHours)
    ) {
      throw new RangeError("weighted residual observation is invalid");
    }

    // count strictly positive model mass
    if (observation.weight > 0) {
      positiveWeightCount += 1;
    }
  }

  // reject a zero-mass cell
  if (positiveWeightCount === 0) {
    throw new RangeError("weighted residual observations require positive weight");
  }
}

// compute a stable weighted median with the exact equality tie rule
export function deterministicWeightedMedian(
  observations: readonly {
    readonly stableId: string;
    readonly value: number;
    readonly weight: number;
  }[],
): number {
  // reject empty estimator input
  if (observations.length === 0) {
    throw new RangeError("weighted median observations must not be empty");
  }

  const sorted = [...observations].sort(
    (left, right) =>
      left.value - right.value || left.stableId.localeCompare(right.stableId),
  );
  const distinct: { value: number; weight: number }[] = [];
  let totalWeight = 0;

  // accumulate equal values left to right
  for (const observation of sorted) {
    // reject invalid weights and values
    if (
      !Number.isFinite(observation.value) ||
      !Number.isFinite(observation.weight) ||
      observation.weight < 0
    ) {
      throw new RangeError("weighted median observation is invalid");
    }

    totalWeight += observation.weight;
    const last = distinct.at(-1);

    // combine one exact distinct value
    if (last !== undefined && last.value === observation.value) {
      last.weight += observation.weight;
    } else {
      distinct.push({ value: observation.value, weight: observation.weight });
    }
  }

  // reject a zero-mass estimator
  if (!(totalWeight > 0)) {
    throw new RangeError("weighted median requires positive total weight");
  }

  let cumulativeWeight = 0;

  // locate the first strict half-weight crossing
  for (let index = 0; index < distinct.length; index += 1) {
    const current = distinct[index];

    // retain compiler-proven entries
    if (current === undefined) {
      throw new Error("weighted median distinct-value indexing failed");
    }

    cumulativeWeight += current.weight;

    // return the first strict crossing
    if (cumulativeWeight > totalWeight / 2) {
      return current.value;
    }

    // average the exact half-weight tie with the next greater value
    if (cumulativeWeight === totalWeight / 2) {
      const next = distinct[index + 1];
      return next === undefined ? current.value : (current.value + next.value) / 2;
    }
  }

  const last = distinct.at(-1);

  // retain the guaranteed positive-mass result
  if (last === undefined) {
    throw new Error("weighted median produced no result");
  }

  return last.value;
}

// compute the deterministic weighted circular median
export function deterministicWeightedCircularMedian(
  observations: readonly {
    readonly stableId: string;
    readonly value: number;
    readonly weight: number;
  }[],
): number {
  // reject empty estimator input
  if (observations.length === 0) {
    throw new RangeError("circular median observations must not be empty");
  }

  const normalized = observations.map((observation) => {
    // reject invalid angular observations
    if (
      !Number.isFinite(observation.value) ||
      !Number.isFinite(observation.weight) ||
      observation.weight < 0
    ) {
      throw new RangeError("circular median observation is invalid");
    }

    return { ...observation, value: wrap180(observation.value) };
  });
  const candidates = [...new Set(normalized.map((observation) => observation.value))]
    .sort((left, right) => left - right);
  let bestCandidate: number | null = null;
  let bestObjective = Number.POSITIVE_INFINITY;

  // score every unique observed residual angle
  for (const candidate of candidates) {
    let objective = 0;

    // sum angular deviations in stable input order
    for (const observation of [...normalized].sort((left, right) =>
      left.value - right.value || left.stableId.localeCompare(right.stableId),
    )) {
      objective += observation.weight * Math.abs(wrap180(observation.value - candidate));
    }

    // apply objective, absolute-angle, then signed-angle ties
    if (
      objective < bestObjective ||
      (objective === bestObjective &&
        (bestCandidate === null ||
          Math.abs(candidate) < Math.abs(bestCandidate) ||
          (Math.abs(candidate) === Math.abs(bestCandidate) &&
            candidate < bestCandidate)))
    ) {
      bestCandidate = candidate;
      bestObjective = objective;
    }
  }

  // reject zero-mass collections
  if (
    bestCandidate === null ||
    !normalized.some((observation) => observation.weight > 0)
  ) {
    throw new RangeError("circular median requires positive total weight");
  }

  return bestCandidate;
}

// compute effective distinct-event count by validAt
export function kishEffectiveEventCount(
  observations: readonly WeightedResidualObservation[],
): number {
  validateWeightedResiduals(observations);
  const eventWeights = new Map<string, number>();
  const eventOrder = [...observations].sort((left, right) =>
    left.validAt.localeCompare(right.validAt) ||
    left.targetLeadHours - right.targetLeadHours ||
    left.stableId.localeCompare(right.stableId),
  );

  // sum each event's atomic weights in target/stable order
  for (const observation of eventOrder) {
    eventWeights.set(
      observation.validAt,
      (eventWeights.get(observation.validAt) ?? 0) + observation.weight,
    );
  }

  let sum = 0;
  let squaredSum = 0;

  // sum events in validAt insertion order
  for (const weight of eventWeights.values()) {
    sum += weight;
    squaredSum += weight ** 2;
  }

  return sum ** 2 / squaredSum;
}

// cap one coefficient after shrinkage
function capCoefficient(
  coefficient: number,
  policy: ForecastAdjustmentMetricPolicy,
): number {
  return Math.min(
    policy.correctionMaximum,
    Math.max(policy.correctionMinimum, coefficient),
  );
}

// retrieve the frozen metric policy
export function metricPolicyFor(
  metric: ForecastAdjustmentMetric,
): ForecastAdjustmentMetricPolicy {
  const policy = FORECAST_ADJUSTMENT_METRIC_POLICIES_V1.find(
    (candidate) => candidate.metric === metric,
  );

  // reject unsupported metrics
  if (policy === undefined) {
    throw new RangeError(`unsupported adjustment metric: ${metric}`);
  }

  return policy;
}

// derive one inclusive non-direction training envelope
export function createTrainingEnvelope(
  metric: Exclude<ForecastAdjustmentMetric, "windDirectionDegrees">,
  leadBand: ForecastLeadBandKey,
  rawForecastValues: readonly number[],
): ForecastAdjustmentTrainingEnvelope {
  // reject empty training support
  if (rawForecastValues.length === 0) {
    throw new RangeError("training envelope requires raw forecast values");
  }

  const policy = metricPolicyFor(metric);

  // reject noncanonical training values
  if (
    rawForecastValues.some(
      (value) =>
        !Number.isFinite(value) ||
        value < policy.finalMinimum ||
        value > policy.finalMaximum,
    )
  ) {
    throw new RangeError("training envelope values are outside canonical bounds");
  }

  return {
    leadBand,
    maximum: Math.max(...rawForecastValues),
    metric,
    minimum: Math.min(...rawForecastValues),
  };
}

// fit one robust hierarchy cell with its literal prior
export function fitCoefficientCell(
  observations: readonly WeightedResidualObservation[],
  input: {
    readonly direction: boolean;
    readonly minimumEffectiveEvents: number;
    readonly parentCoefficient: number;
    readonly policy: ForecastAdjustmentMetricPolicy;
    readonly pseudocount: number;
  },
): FittedCoefficientCell | null {
  validateWeightedResiduals(observations);
  const effectiveEventCount = kishEffectiveEventCount(observations);

  // inherit the parent below the frozen count threshold
  if (effectiveEventCount < input.minimumEffectiveEvents) {
    return null;
  }

  const sorted = sortWeightedResiduals(observations);
  const estimatorRows = sorted.map((observation) => ({
    stableId: [
      observation.validAt,
      observation.targetLeadHours,
      observation.referenceAt ?? "",
      observation.stableId,
    ].join("\u0000"),
    value: observation.residual,
    weight: observation.weight,
  }));
  const rawCoefficient = input.direction
    ? deterministicWeightedCircularMedian(estimatorRows)
    : deterministicWeightedMedian(estimatorRows);
  const alpha = effectiveEventCount / (effectiveEventCount + input.pseudocount);
  const shrunk = input.direction
    ? wrap180(
        input.parentCoefficient +
          alpha * wrap180(rawCoefficient - input.parentCoefficient),
      )
    : input.parentCoefficient +
      alpha * (rawCoefficient - input.parentCoefficient);
  const coefficient = capCoefficient(shrunk, input.policy);

  return { coefficient, effectiveEventCount, rawCoefficient };
}

// attach pinned local calendar features to one residual
export function withLocalHierarchyFeatures(
  observation: WeightedResidualObservation,
): HierarchyResidualObservation {
  const calendar = localCalendarFeaturesFor(observation.validAt);
  return {
    ...observation,
    daypart: calendar.daypart,
    month: calendar.month,
    season: calendar.season,
  };
}

// group hierarchy samples under one stable composite key
function groupHierarchySamples(
  observations: readonly HierarchyResidualObservation[],
  keyFor: (observation: HierarchyResidualObservation) => string,
): ReadonlyMap<string, readonly HierarchyResidualObservation[]> {
  const groups = new Map<string, HierarchyResidualObservation[]>();

  // collect rows without changing their canonical values
  for (const observation of observations) {
    const key = keyFor(observation);
    const current = groups.get(key) ?? [];
    current.push(observation);
    groups.set(key, current);
  }

  return groups;
}

// fit one metric-band's literal three-level hierarchy
export function fitRobustHierarchy(
  metric: ForecastAdjustmentMetric,
  leadBand: ForecastLeadBandKey,
  observations: readonly HierarchyResidualObservation[],
): readonly ForecastAdjustmentCoefficient[] {
  // leave empty cells without coefficients
  if (observations.length === 0) {
    return [];
  }

  const policy = metricPolicyFor(metric);
  const direction = metric === "windDirectionDegrees";
  const root = fitCoefficientCell(observations, {
    direction,
    minimumEffectiveEvents:
      FORECAST_ADJUSTMENT_HIERARCHY.root.minimumEffectiveEvents,
    parentCoefficient: 0,
    policy,
    pseudocount: FORECAST_ADJUSTMENT_HIERARCHY.root.pseudocount,
  });

  // leave unsupported metric-bands without coefficients
  if (root === null) {
    return [];
  }

  const coefficients: ForecastAdjustmentCoefficient[] = [
    {
      coefficient: root.coefficient,
      daypart: null,
      effectiveEventCount: root.effectiveEventCount,
      leadBand,
      level: 1,
      metric,
      month: null,
      season: null,
    },
  ];
  const seasonGroups = groupHierarchySamples(
    observations,
    (observation) => `${observation.season}\u0000${observation.daypart}`,
  );
  const seasonCoefficients = new Map<string, number>();

  // fit observed season/daypart cells in lexical key order
  for (const key of [...seasonGroups.keys()].sort()) {
    const rows = seasonGroups.get(key);

    // retain the compiler-proven group
    if (rows === undefined) {
      throw new Error("season hierarchy group disappeared");
    }

    const cell = fitCoefficientCell(rows, {
      direction,
      minimumEffectiveEvents:
        FORECAST_ADJUSTMENT_HIERARCHY.seasonDaypart.minimumEffectiveEvents,
      parentCoefficient: root.coefficient,
      policy,
      pseudocount: FORECAST_ADJUSTMENT_HIERARCHY.seasonDaypart.pseudocount,
    });

    // inherit without emitting when below threshold
    if (cell === null) {
      continue;
    }

    const [season, daypart] = key.split("\u0000") as [
      LocalMeteorologicalSeason,
      LocalDaypart,
    ];
    seasonCoefficients.set(key, cell.coefficient);
    coefficients.push({
      coefficient: cell.coefficient,
      daypart,
      effectiveEventCount: cell.effectiveEventCount,
      leadBand,
      level: 2,
      metric,
      month: null,
      season,
    });
  }

  const monthGroups = groupHierarchySamples(
    observations,
    (observation) => `${String(observation.month).padStart(2, "0")}\u0000${observation.daypart}`,
  );

  // fit observed month/daypart cells in lexical key order
  for (const key of [...monthGroups.keys()].sort()) {
    const rows = monthGroups.get(key);

    // retain the compiler-proven group
    if (rows === undefined) {
      throw new Error("month hierarchy group disappeared");
    }

    const [monthText, daypart] = key.split("\u0000") as [string, LocalDaypart];
    const month = Number(monthText);
    const season = meteorologicalSeasonForMonth(month);
    const parentCoefficient =
      seasonCoefficients.get(`${season}\u0000${daypart}`) ?? root.coefficient;
    const cell = fitCoefficientCell(rows, {
      direction,
      minimumEffectiveEvents:
        FORECAST_ADJUSTMENT_HIERARCHY.monthDaypart.minimumEffectiveEvents,
      parentCoefficient,
      policy,
      pseudocount: FORECAST_ADJUSTMENT_HIERARCHY.monthDaypart.pseudocount,
    });

    // inherit without emitting when below threshold
    if (cell === null) {
      continue;
    }

    coefficients.push({
      coefficient: cell.coefficient,
      daypart,
      effectiveEventCount: cell.effectiveEventCount,
      leadBand,
      level: 3,
      metric,
      month,
      season: null,
    });
  }

  return coefficients;
}

// select the deepest matching coefficient for one local event
export function selectHierarchyCoefficient(
  coefficients: readonly ForecastAdjustmentCoefficient[],
  metric: ForecastAdjustmentMetric,
  leadBand: ForecastLeadBandKey,
  calendar: Pick<LocalCalendarFeatures, "daypart" | "month" | "season">,
): number | null {
  const matching = coefficients.filter(
    (coefficient) =>
      coefficient.metric === metric && coefficient.leadBand === leadBand,
  );
  const root = matching.find((coefficient) => coefficient.level === 1);

  // fail raw without one exact root
  if (root === undefined) {
    return null;
  }

  const season = matching.find(
    (coefficient) =>
      coefficient.level === 2 &&
      coefficient.season === calendar.season &&
      coefficient.daypart === calendar.daypart,
  );
  const month = matching.find(
    (coefficient) =>
      coefficient.level === 3 &&
      coefficient.month === calendar.month &&
      coefficient.daypart === calendar.daypart,
  );
  return month?.coefficient ?? season?.coefficient ?? root.coefficient;
}

// compute literal paired skill including zero-loss cases
export function corePairedSkill(rawLoss: number, adjustedLoss: number): number {
  // reject invalid losses
  if (
    !Number.isFinite(rawLoss) ||
    !Number.isFinite(adjustedLoss) ||
    rawLoss < 0 ||
    adjustedLoss < 0
  ) {
    throw new RangeError("paired losses must be finite and nonnegative");
  }

  // preserve the no-demonstrated-gain zero case
  if (rawLoss === 0 && adjustedLoss === 0) {
    return 0;
  }

  // freeze the harmed zero-baseline case
  if (rawLoss === 0) {
    return -1;
  }

  return (rawLoss - adjustedLoss) / rawLoss;
}

// pool station losses with equal station then equal family weight
export function providerBalancedPairedLoss(
  stationLosses: readonly StationPairedLoss[],
): ProviderBalancedLoss {
  // reject empty LOSO evidence
  if (stationLosses.length === 0) {
    throw new RangeError("provider-balanced loss requires station scores");
  }

  const stationKeys = new Set<ForecastObservationStationKey>();
  const families = new Map<
    ForecastObservationProviderFamily,
    { adjusted: number[]; raw: number[] }
  >();
  let eventCount = 0;

  // accumulate station means once per physical identity
  for (const station of [...stationLosses].sort((left, right) =>
    left.physicalStationKey.localeCompare(right.physicalStationKey),
  )) {
    // reject duplicate or malformed station scores
    if (
      stationKeys.has(station.physicalStationKey) ||
      !Number.isInteger(station.eventCount) ||
      station.eventCount <= 0 ||
      station.rawLoss < 0 ||
      station.adjustedLoss < 0 ||
      !Number.isFinite(station.rawLoss) ||
      !Number.isFinite(station.adjustedLoss)
    ) {
      throw new RangeError("provider-balanced station score is invalid");
    }

    stationKeys.add(station.physicalStationKey);
    eventCount += station.eventCount;
    const family = families.get(station.providerFamily) ?? {
      adjusted: [],
      raw: [],
    };
    family.adjusted.push(station.adjustedLoss);
    family.raw.push(station.rawLoss);
    families.set(station.providerFamily, family);
  }

  const familyKeys = [...families.keys()].sort();
  let rawLoss = 0;
  let adjustedLoss = 0;

  // average stations then families in lexical family order
  for (const familyKey of familyKeys) {
    const family = families.get(familyKey);

    // retain compiler-proven family evidence
    if (family === undefined) {
      throw new Error("provider family disappeared during aggregation");
    }

    rawLoss += family.raw.reduce((sum, value) => sum + value, 0) / family.raw.length;
    adjustedLoss +=
      family.adjusted.reduce((sum, value) => sum + value, 0) /
      family.adjusted.length;
  }

  rawLoss /= familyKeys.length;
  adjustedLoss /= familyKeys.length;
  return {
    adjustedLoss,
    eventCount,
    providerFamilies: familyKeys,
    rawLoss,
    skill: corePairedSkill(rawLoss, adjustedLoss),
  };
}

// retain only stations meeting literal LOSO coverage thresholds
export function scoreableLosoStations(
  coverage: readonly LosoStationCoverage[],
): readonly LosoStationCoverage[] {
  const keys = coverage.map((station) => station.physicalStationKey);

  // reject duplicated station coverage evidence
  if (new Set(keys).size !== keys.length) {
    throw new RangeError("LOSO station coverage contains a duplicate");
  }

  return [...coverage]
    .filter(
      (station) =>
        station.trainingMatches >=
          PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationTrainingMatches &&
        station.scoreMatches >=
          PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationScoreMatches &&
        station.remainingNetworkScoreEvents >=
          PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumRemainingNetworkScoreEvents,
    )
    .sort((left, right) =>
      left.physicalStationKey.localeCompare(right.physicalStationKey),
    );
}

// detect the frozen material-harm rule
export function isMaterialHarm(input: {
  readonly bootstrapUpperBound: number;
  readonly eventCount: number;
  readonly skill: number;
}): boolean {
  return (
    input.eventCount >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.materialHarmMinimumEvents &&
    input.skill <= -0.02 &&
    input.bootstrapUpperBound < 0
  );
}

// assess one development fold against frozen LOSO thresholds
export function assessProviderBalancedLosoFold(input: {
  readonly bootstrapLowerBound: number;
  readonly coverage: readonly LosoStationCoverage[];
  readonly providerBalancedSkill: number;
  readonly stationSkills: readonly {
    readonly physicalStationKey: ForecastObservationStationKey;
    readonly skill: number;
  }[];
  readonly materialHarmDetected: boolean;
}): ProviderBalancedLosoFoldAssessment {
  const scoreable = scoreableLosoStations(input.coverage);
  const scoreableKeys = new Set(
    scoreable.map((station) => station.physicalStationKey),
  );
  const providerFamilyCount = new Set(
    scoreable.map((station) => station.providerFamily),
  ).size;
  const skillKeys = input.stationSkills.map((score) => score.physicalStationKey);

  // reject duplicated or nonfinite station skill evidence
  if (
    new Set(skillKeys).size !== skillKeys.length ||
    input.stationSkills.some((score) => !Number.isFinite(score.skill))
  ) {
    throw new RangeError("LOSO station skills are invalid or duplicated");
  }

  const relevantSkills = input.stationSkills.filter((score) =>
    scoreableKeys.has(score.physicalStationKey),
  );
  const nonnegativeStationFraction =
    relevantSkills.length === 0
      ? 0
      : relevantSkills.filter((score) => score.skill >= 0).length /
        relevantSkills.length;
  const passed =
    scoreable.length >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumScoreableStationsPerFold &&
    providerFamilyCount >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumProviderFamiliesPerFold &&
    relevantSkills.length === scoreable.length &&
    input.providerBalancedSkill >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumImprovementFraction &&
    input.bootstrapLowerBound >
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.bootstrapLowerBoundExclusive &&
    nonnegativeStationFraction >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumNonnegativeStationFraction &&
    !input.materialHarmDetected;

  return {
    bootstrapLowerBound: input.bootstrapLowerBound,
    improvementFraction: input.providerBalancedSkill,
    nonnegativeStationFraction,
    passed,
    providerFamilyCount,
    scoreableStationCount: scoreable.length,
  };
}

// validate one raw value against its frozen policy
function rawValueIsCanonical(
  metric: ForecastAdjustmentMetric,
  rawValue: number,
): boolean {
  const policy = metricPolicyFor(metric);
  return (
    Number.isFinite(rawValue) &&
    rawValue >= policy.finalMinimum &&
    (policy.finalMaximumExclusive
      ? rawValue < policy.finalMaximum
      : rawValue <= policy.finalMaximum)
  );
}

// apply one cap-constrained correction without identity decisions
export function applyCappedCorrection(
  metric: ForecastAdjustmentMetric,
  rawForecastValue: number,
  coefficient: number,
): number {
  const policy = metricPolicyFor(metric);

  // reject nonfinite arithmetic inputs
  if (!Number.isFinite(rawForecastValue) || !Number.isFinite(coefficient)) {
    throw new RangeError("correction inputs must be finite");
  }

  const cappedCoefficient = capCoefficient(coefficient, policy);

  // wrap direction into its final circle
  if (metric === "windDirectionDegrees") {
    return wrap360(rawForecastValue + cappedCoefficient);
  }

  return Math.min(
    policy.finalMaximum,
    Math.max(policy.finalMinimum, rawForecastValue + cappedCoefficient),
  );
}

// apply one metric or return the exact raw value on any frozen guard
export function applyCoreAdjustment(
  input: CoreAdjustmentApplicationInput,
): CoreAdjustmentApplicationResult {
  const failRaw = (
    reason: Exclude<CoreAdjustmentApplicationResult["reason"], "adjusted">,
  ): CoreAdjustmentApplicationResult => ({
    adjustedValue: input.rawForecastValue,
    applied: false,
    reason,
  });

  // require exact production forecast identity
  if (!input.identityMatches) {
    return failRaw("forecast_identity_mismatch");
  }

  // require the pinned runtime calendar
  if (!input.calendarFingerprintMatches) {
    return failRaw("calendar_fingerprint_mismatch");
  }

  // reject disabled metric-band pairs
  if (!input.enabled) {
    return failRaw("disabled_metric_band");
  }

  // require one fitted root
  if (!input.rootAvailable) {
    return failRaw("root_missing");
  }

  // require a selected hierarchy coefficient
  if (input.coefficient === null || !Number.isFinite(input.coefficient)) {
    return failRaw("coefficient_missing");
  }

  // reject invalid raw provider values
  if (!rawValueIsCanonical(input.metric, input.rawForecastValue)) {
    return failRaw("raw_value_invalid");
  }

  // require application-time wind for direction only
  if (
    input.metric === "windDirectionDegrees" &&
    (input.rawWindSpeedMps === null ||
      !Number.isFinite(input.rawWindSpeedMps) ||
      input.rawWindSpeedMps < MINIMUM_DIRECTION_WIND_SPEED_MPS)
  ) {
    return failRaw("raw_direction_calm");
  }

  // enforce inclusive scalar training envelopes
  if (
    input.metric !== "windDirectionDegrees" &&
    (input.envelope === null ||
      !Number.isFinite(input.envelope.minimum) ||
      !Number.isFinite(input.envelope.maximum) ||
      input.envelope.minimum > input.envelope.maximum ||
      input.rawForecastValue < input.envelope.minimum ||
      input.rawForecastValue > input.envelope.maximum)
  ) {
    return failRaw("raw_value_ood");
  }

  return {
    adjustedValue: applyCappedCorrection(
      input.metric,
      input.rawForecastValue,
      input.coefficient,
    ),
    applied: true,
    reason: "adjusted",
  };
}

// compare exact artifact and runtime calendar identities
export function calendarFingerprintEquals(
  expected: RuntimeCalendarFingerprint,
  actual: RuntimeCalendarFingerprint,
): boolean {
  return (
    expected.icuVersion === actual.icuVersion &&
    expected.tzdataVersion === actual.tzdataVersion
  );
}
