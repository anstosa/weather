import { canonicalizeJson, type JsonValue } from "./provenance.js";
import {
  type CanonicalWeatherMetrics,
  type WeatherRecordMetadata,
  validateCanonicalWeatherMetrics,
  validateUtcInstant,
  validateWeatherRecordMetadata,
} from "./weather-record.js";

// freeze the anchor record schema
export const FORECAST_ANCHOR_RECORD_CONTRACT_VERSION =
  "forecast-anchor-record/v1" as const;

// freeze the supported Previous Runs leads
export const FIXED_FORECAST_LEAD_HOURS = [
  24,
  48,
  72,
  96,
  120,
  144,
  168,
] as const;

// name one supported fixed lead
export type FixedForecastLeadHours = (typeof FIXED_FORECAST_LEAD_HOURS)[number];

// describe a validated Previous Runs anchor
export interface NormalizedForecastAnchorRecord {
  readonly adapterVersion: string;
  readonly contractEpoch: string;
  readonly contractVersion: typeof FORECAST_ANCHOR_RECORD_CONTRACT_VERSION;
  readonly dataset: "previous_runs";
  readonly leadHours: FixedForecastLeadHours;
  readonly metadata: WeatherRecordMetadata;
  readonly metrics: CanonicalWeatherMetrics;
  readonly receivedAt: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly sourceKind: "forecast";
  readonly upstreamModel: "best_match";
  readonly validAt: string;
}

// accept only fields that cannot claim a run instant
export interface NormalizedForecastAnchorRecordInput {
  readonly adapterVersion: string;
  readonly contractEpoch: string;
  readonly dataset: "previous_runs";
  readonly leadHours: FixedForecastLeadHours;
  readonly metadata: WeatherRecordMetadata;
  readonly metrics: CanonicalWeatherMetrics;
  readonly receivedAt: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly upstreamModel: "best_match";
  readonly validAt: string;
}

// freeze accepted anchor input fields
const FORECAST_ANCHOR_INPUT_KEYS = new Set([
  "adapterVersion",
  "contractEpoch",
  "dataset",
  "leadHours",
  "metadata",
  "metrics",
  "receivedAt",
  "sourceConfigFingerprint",
  "sourceId",
  "upstreamModel",
  "validAt",
]);

// create a truthful fixed-lead anchor
export function createNormalizedForecastAnchorRecord(
  input: NormalizedForecastAnchorRecordInput,
): NormalizedForecastAnchorRecord {
  // reject exact-run and unknown claims
  if (Object.keys(input).some((key) => !FORECAST_ANCHOR_INPUT_KEYS.has(key))) {
    throw new RangeError(
      "forecast anchor input contains an unrecognized or exact-run field",
    );
  }

  // require Previous Runs identity
  if (input.dataset !== "previous_runs") {
    throw new RangeError("forecast anchors require dataset previous_runs");
  }

  // require Best Match identity
  if (input.upstreamModel !== "best_match") {
    throw new RangeError("forecast anchors require upstream model best_match");
  }

  const leadHours = parseFixedForecastLeadHours(input.leadHours);
  const adapterVersion = validateBoundedIdentity(
    input.adapterVersion,
    "adapterVersion",
  );
  const contractEpoch = validateBoundedIdentity(
    input.contractEpoch,
    "contractEpoch",
  );
  const sourceId = validateBoundedIdentity(input.sourceId, "sourceId");
  const metadata = validateWeatherRecordMetadata(input.metadata);

  // require one consistent model identity
  if (metadata.model !== input.upstreamModel) {
    throw new RangeError("metadata.model must match upstreamModel");
  }

  // require one consistent dataset identity
  if (metadata.provider?.dataset !== input.dataset) {
    throw new RangeError("metadata.provider.dataset must match dataset");
  }

  return {
    adapterVersion,
    contractEpoch,
    contractVersion: FORECAST_ANCHOR_RECORD_CONTRACT_VERSION,
    dataset: "previous_runs",
    leadHours,
    metadata,
    metrics: validateCanonicalWeatherMetrics(input.metrics),
    receivedAt: validateUtcInstant(input.receivedAt, "receivedAt"),
    sourceConfigFingerprint: validateSha256Hex(
      input.sourceConfigFingerprint,
      "sourceConfigFingerprint",
    ),
    sourceId,
    sourceKind: "forecast",
    upstreamModel: "best_match",
    validAt: validateUtcInstant(input.validAt, "validAt"),
  };
}

// parse one exact fixed lead
export function parseFixedForecastLeadHours(
  value: number,
): FixedForecastLeadHours {
  // reject non-anchor leads
  if (
    !FIXED_FORECAST_LEAD_HOURS.some(
      (leadHours) => leadHours === value,
    )
  ) {
    throw new RangeError("leadHours must be one of 24, 48, 72, 96, 120, 144, 168");
  }

  return value as FixedForecastLeadHours;
}

// build stable anchor storage identity
export function forecastAnchorRecordIdentity(
  record: Pick<
    NormalizedForecastAnchorRecord,
    "leadHours" | "sourceId" | "validAt"
  >,
): string {
  return canonicalizeJson({
    leadHours: record.leadHours,
    sourceId: record.sourceId,
    validAt: record.validAt,
  });
}

// serialize revision-bearing anchor content
export function forecastAnchorRecordContent(
  record: NormalizedForecastAnchorRecord,
): string {
  return canonicalizeJson({
    adapterVersion: record.adapterVersion,
    contractEpoch: record.contractEpoch,
    contractVersion: record.contractVersion,
    dataset: record.dataset,
    leadHours: record.leadHours,
    metadata: record.metadata,
    metrics: record.metrics,
    sourceConfigFingerprint: record.sourceConfigFingerprint,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    upstreamModel: record.upstreamModel,
    validAt: record.validAt,
  } as unknown as JsonValue);
}

// validate a lowercase SHA-256 identity
export function validateSha256Hex(value: string, fieldName: string): string {
  // require the exact digest representation
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${fieldName} must be a lowercase SHA-256 hex digest`);
  }

  return value;
}

// validate bounded provenance identity
function validateBoundedIdentity(value: string, fieldName: string): string {
  // reject empty or oversized identity
  if (value.trim().length === 0 || value.length > 128) {
    throw new RangeError(`${fieldName} must be non-empty and at most 128 chars`);
  }

  return value;
}
