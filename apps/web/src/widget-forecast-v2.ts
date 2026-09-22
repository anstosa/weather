import {
  forecastMetricValue,
  parseForecastRecordsResponse,
  type ForecastAdjustmentRuntimeStatus,
  type WeatherRecord,
} from "./index.js";
import {
  projectWidgetForecast,
  WIDGET_FORECAST_MAX_BYTES,
  type WidgetForecastField,
  type WidgetForecastHour,
  type WidgetForecastSnapshot,
  type WidgetForecastSource,
  type WidgetForecastStatus,
} from "./widget-forecast.js";

export const WIDGET_FORECAST_V2_SCHEMA_VERSION = "weather-widget/v2" as const;

const ADJUSTMENT_MAX_AGE_MS = 90 * 60_000;
const METRIC_MAXIMUMS = {
  cloudCoverPercent: 100,
  windSpeedMps: 150,
} as const;

type SupplementalMetric = keyof typeof METRIC_MAXIMUMS;

export interface WidgetForecastV2Hour extends WidgetForecastHour {
  readonly cloudCoverPercent: WidgetForecastField;
  readonly windSpeedMps: WidgetForecastField;
}

export interface WidgetForecastV2Snapshot extends Omit<WidgetForecastSnapshot, "hours" | "schemaVersion"> {
  readonly hours: readonly WidgetForecastV2Hour[];
  readonly schemaVersion: typeof WIDGET_FORECAST_V2_SCHEMA_VERSION;
}

// extend the stable v1 snapshot with two closed condition fields
export function projectWidgetForecastV2(
  value: unknown,
  receivedAtValue: string,
): WidgetForecastV2Snapshot {
  const base = projectWidgetForecast(value, receivedAtValue);
  const parsed = parseForecastRecordsResponse(value);
  const records = indexRecords(parsed.data);
  const hours = base.hours.map(
    // preserve every v1 field while adding the matching condition row
    (hour) => {
      const record = records.get(hour.start) ?? null;
      return {
        ...hour,
        cloudCoverPercent: projectSupplementalField(
          record,
          "cloudCoverPercent",
          base.generatedAt,
          parsed.adjustmentRuntime,
        ),
        windSpeedMps: projectSupplementalField(
          record,
          "windSpeedMps",
          base.generatedAt,
          parsed.adjustmentRuntime,
        ),
      };
    },
  );
  const snapshot: WidgetForecastV2Snapshot = {
    ...base,
    hours,
    schemaVersion: WIDGET_FORECAST_V2_SCHEMA_VERSION,
    status: summarizeStatus(hours),
  };

  // retain the shared public response ceiling
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > WIDGET_FORECAST_MAX_BYTES) {
    throw new RangeError("Widget forecast v2 exceeds 128 KiB");
  }

  return snapshot;
}

// index rows already validated by the v1 projector
function indexRecords(records: readonly WeatherRecord[]): ReadonlyMap<string, WeatherRecord> {
  const indexed = new Map<string, WeatherRecord>();

  // bind offset timestamps to the canonical v1 hour keys
  for (const record of records) {
    indexed.set(new Date(record.validAt).toISOString(), record);
  }

  return indexed;
}

// project one raw or generic-adjusted condition metric
function projectSupplementalField(
  record: WeatherRecord | null,
  metric: SupplementalMetric,
  generatedAt: string,
  runtime: ForecastAdjustmentRuntimeStatus,
): WidgetForecastField {
  // preserve a missing grid row without inventing conditions
  if (record === null) {
    return unavailableField();
  }

  const raw = record.metrics[metric];

  // preserve a missing provider value explicitly
  if (raw === null) {
    return unavailableField();
  }

  // reject physical violations at the public boundary
  if (!validMetricValue(metric, raw)) {
    throw new RangeError(`Widget forecast v2 contains invalid ${metric}`);
  }

  const source = recordSource(record.productRunAt, record.receivedAt, generatedAt);
  const adjusted = metric === "windSpeedMps" &&
    record.adjustment?.state === "active" &&
    record.adjustment.appliedMetrics.includes("windSpeedMps");

  // keep cloud and unadjusted wind tied to raw provenance
  if (!adjusted) {
    return rawField(raw, source, "raw_forecast");
  }

  const deadline = boundedDeadline(
    Date.parse(generatedAt) + ADJUSTMENT_MAX_AGE_MS,
    runtime.expiresAt,
  );

  // demote corrections without a trustworthy expiry
  if (deadline === null) {
    return rawField(raw, source, "deadline_unavailable");
  }

  // demote corrections expired at snapshot generation
  if (Date.parse(deadline) <= Date.parse(generatedAt)) {
    return rawField(raw, source, "deadline_expired");
  }

  const selected = forecastMetricValue(record, metric, true);

  // reject invalid adjusted wind rather than synthesizing a fallback
  if (!validMetricValue(metric, selected)) {
    throw new RangeError(`Widget forecast v2 contains invalid selected ${metric}`);
  }

  return {
    mode: "adjusted",
    raw,
    rawSource: source,
    reason: "generic_adjustment",
    selected,
    selectedSource: source,
    selectedUntil: deadline,
  };
}

// project one allowlisted source clock pair
function recordSource(
  runAt: string | null,
  receivedAt: string,
  generatedAt: string,
): WidgetForecastSource {
  const canonicalRunAt = runAt === null
    ? null
    : canonicalInstant(runAt, "source.runAt");
  const canonicalReceivedAt = canonicalInstant(receivedAt, "source.receivedAt");

  // reject impossible source ordering
  if (
    Date.parse(canonicalReceivedAt) > Date.parse(generatedAt) ||
    (canonicalRunAt !== null && Date.parse(canonicalRunAt) > Date.parse(canonicalReceivedAt))
  ) {
    throw new RangeError("Widget forecast v2 source timestamps are out of order");
  }

  return { runAt: canonicalRunAt, receivedAt: canonicalReceivedAt };
}

// normalize one explicit-zone instant
function canonicalInstant(value: string, field: string): string {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d{1,3})?(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(value);

  // reject local, normalized, and malformed timestamps
  if (match?.groups === undefined || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`Widget forecast v2 ${field} is invalid`);
  }

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const zone = match.groups.zone!;
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const monthLength = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;

  // reject every calendar and zone overflow
  if (
    day < 1 ||
    day > monthLength ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new RangeError(`Widget forecast v2 ${field} is invalid`);
  }

  return new Date(value).toISOString();
}

// cap one generic correction deadline at snapshot age
function boundedDeadline(maximum: number, value: string | null): string | null {
  // fail raw when the runtime expiry is absent
  if (value === null) {
    return null;
  }

  try {
    const canonical = canonicalInstant(value, "adjustment deadline");
    return new Date(Math.min(maximum, Date.parse(canonical))).toISOString();
  } catch {
    // fail raw on a malformed runtime expiry
    return null;
  }
}

// enforce one supplemental metric's physical range
function validMetricValue(metric: SupplementalMetric, value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= METRIC_MAXIMUMS[metric];
}

// create one raw field with matching captured provenance
function rawField(
  raw: number,
  source: WidgetForecastSource,
  reason: "deadline_expired" | "deadline_unavailable" | "raw_forecast",
): WidgetForecastField {
  return {
    mode: "raw",
    raw,
    rawSource: source,
    reason,
    selected: raw,
    selectedSource: null,
    selectedUntil: null,
  };
}

// create one explicitly unavailable field
function unavailableField(): WidgetForecastField {
  return {
    mode: "unavailable",
    raw: null,
    rawSource: null,
    reason: "missing",
    selected: null,
    selectedSource: null,
    selectedUntil: null,
  };
}

// summarize all four v2 field families
function summarizeStatus(hours: readonly WidgetForecastV2Hour[]): WidgetForecastStatus {
  const modes = new Set<WidgetForecastField["mode"]>();

  // include every field that the v2 native decoder consumes
  for (const hour of hours) {
    modes.add(hour.temperatureC.mode);
    modes.add(hour.rainMmPerHour.mode);
    modes.add(hour.cloudCoverPercent.mode);
    modes.add(hour.windSpeedMps.mode);
  }

  // preserve one honest mode only when every field agrees
  if (modes.size === 1) {
    return [...modes][0]!;
  }

  return "mixed";
}
