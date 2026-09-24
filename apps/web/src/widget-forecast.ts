import {
  eveningSunTimes,
  forecastMetricValue,
  fromSiteWallClock,
  parseForecastRecordsResponse,
  toSiteWallClock,
  type WeatherRecord,
} from "./index.js";

export const WIDGET_FORECAST_SCHEMA_VERSION = "weather-widget/v1" as const;
export const WIDGET_FORECAST_MAX_BYTES = 128 * 1_024;

export const WIDGET_FORECAST_SITE = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  name: "Ballydidean",
  slug: "ballydidean",
  timezone: "America/Los_Angeles",
} as const;
const HOUR_MS = 3_600_000;
const ADJUSTMENT_MAX_AGE_MS = 90 * 60_000;
const RAIN_DECISION_MAX_AGE_MS = 12 * HOUR_MS;

export type WidgetForecastMode = "adjusted" | "raw" | "unavailable";
export type WidgetForecastReason =
  | "deadline_expired"
  | "deadline_unavailable"
  | "generic_adjustment"
  | "independent_adjustment"
  | "missing"
  | "rain_adjustment"
  | "raw_forecast";
export type WidgetForecastStatus = WidgetForecastMode | "mixed";

export interface WidgetForecastSource {
  readonly runAt: string | null;
  readonly receivedAt: string;
}

export interface WidgetForecastField {
  readonly mode: WidgetForecastMode;
  readonly raw: number | null;
  readonly rawSource: WidgetForecastSource | null;
  readonly reason: WidgetForecastReason;
  readonly selected: number | null;
  readonly selectedSource: WidgetForecastSource | null;
  readonly selectedUntil: string | null;
}

export interface WidgetForecastHour {
  readonly end: string;
  readonly rainMmPerHour: WidgetForecastField;
  readonly start: string;
  readonly temperatureC: WidgetForecastField;
}

export interface WidgetForecastSnapshot {
  readonly attribution: {
    readonly label: "Open-Meteo · CC BY 4.0";
    readonly licenseUrl: "https://creativecommons.org/licenses/by/4.0/";
    readonly providerUrl: "https://open-meteo.com/";
  };
  readonly calendar: {
    readonly cutoff: string;
    readonly date: string;
    readonly dayEnd: string;
    readonly dayStart: string;
    readonly sunset: string | null;
  };
  readonly generatedAt: string;
  readonly hours: readonly WidgetForecastHour[];
  readonly receivedAt: string;
  readonly schemaVersion: typeof WIDGET_FORECAST_SCHEMA_VERSION;
  readonly site: {
    readonly latitude: typeof WIDGET_FORECAST_SITE.latitude;
    readonly longitude: typeof WIDGET_FORECAST_SITE.longitude;
    readonly name: typeof WIDGET_FORECAST_SITE.name;
    readonly slug: typeof WIDGET_FORECAST_SITE.slug;
    readonly timezone: typeof WIDGET_FORECAST_SITE.timezone;
  };
  readonly status: WidgetForecastStatus;
}

interface ForecastEnvelope {
  readonly generatedAt: string;
  readonly site: {
    readonly latitude: number;
    readonly longitude: number;
    readonly name: string;
    readonly slug: string;
    readonly timezone: string;
  };
}

type FieldKind = "rain" | "temperature";

// retain one validated source envelope for versioned projections
export interface WidgetForecastProjectionContext {
  readonly generatedAt: string;
  readonly parsed: ReturnType<typeof parseForecastRecordsResponse>;
  readonly receivedAt: string;
}

// project one validated forecast response into the closed widget contract
export function projectWidgetForecast(
  value: unknown,
  receivedAtValue: string,
): WidgetForecastSnapshot {
  const context = parseWidgetForecastProjection(value, receivedAtValue);
  const date = toSiteWallClock(context.generatedAt, WIDGET_FORECAST_SITE.timezone).slice(0, 10);
  const nextDate = addWidgetForecastCalendarDays(date, 1);
  const dayStart = canonicalWidgetForecastInstant(
    fromSiteWallClock(`${date}T00:00`, WIDGET_FORECAST_SITE.timezone),
    "calendar.dayStart",
  );
  const dayEnd = canonicalWidgetForecastInstant(
    fromSiteWallClock(`${nextDate}T00:00`, WIDGET_FORECAST_SITE.timezone),
    "calendar.dayEnd",
  );
  const cutoff = canonicalWidgetForecastInstant(
    fromSiteWallClock(`${date}T20:00`, WIDGET_FORECAST_SITE.timezone),
    "calendar.cutoff",
  );
  const expectedStarts = widgetForecastHourlyInstants(dayStart, dayEnd, 23, 25);
  const records = indexWidgetForecastRecords(context.parsed.data, expectedStarts);
  const sunset = eveningSunTimes(WIDGET_FORECAST_SITE, new Date(context.generatedAt)).sunset;
  const hours = expectedStarts.map(
    // project each reviewed civil-day interval independently
    (start) => projectWidgetForecastHour(records.get(start) ?? null, start, context),
  );
  const snapshot: WidgetForecastSnapshot = {
    attribution: {
      label: "Open-Meteo · CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      providerUrl: "https://open-meteo.com/",
    },
    calendar: {
      cutoff,
      date,
      dayEnd,
      dayStart,
      sunset: sunset?.toISOString() ?? null,
    },
    generatedAt: context.generatedAt,
    hours,
    receivedAt: context.receivedAt,
    schemaVersion: WIDGET_FORECAST_SCHEMA_VERSION,
    site: {
      latitude: WIDGET_FORECAST_SITE.latitude,
      longitude: WIDGET_FORECAST_SITE.longitude,
      name: WIDGET_FORECAST_SITE.name,
      slug: WIDGET_FORECAST_SITE.slug,
      timezone: WIDGET_FORECAST_SITE.timezone,
    },
    status: summarizeStatus(hours),
  };

  // enforce the public response ceiling before the edge adapter is added
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > WIDGET_FORECAST_MAX_BYTES) {
    throw new RangeError("Widget forecast exceeds 128 KiB");
  }

  return snapshot;
}

// validate one upstream response without choosing a versioned calendar
export function parseWidgetForecastProjection(
  value: unknown,
  receivedAtValue: string,
): WidgetForecastProjectionContext {
  const envelope = parseEnvelope(value);
  const generatedAt = canonicalWidgetForecastInstant(envelope.generatedAt, "generatedAt");
  const receivedAt = canonicalWidgetForecastInstant(receivedAtValue, "receivedAt");

  // reject a forecast anchor the edge could not yet have received
  if (Date.parse(generatedAt) > Date.parse(receivedAt)) {
    throw new RangeError("Widget forecast generatedAt is after receivedAt");
  }

  return {
    generatedAt,
    parsed: parseForecastRecordsResponse(value),
    receivedAt,
  };
}

// project one genuine forecast row through the shared v1 field rules
export function projectWidgetForecastHour(
  record: WeatherRecord | null,
  start: string,
  context: WidgetForecastProjectionContext,
): WidgetForecastHour {
  return {
    end: new Date(Date.parse(start) + HOUR_MS).toISOString(),
    rainMmPerHour: projectField(
      record,
      "rain",
      context.generatedAt,
      context.parsed.adjustmentRuntime,
      context.parsed.temperatureAdjustmentRuntime,
    ),
    start,
    temperatureC: projectField(
      record,
      "temperature",
      context.generatedAt,
      context.parsed.adjustmentRuntime,
      context.parsed.temperatureAdjustmentRuntime,
    ),
  };
}

// validate the anchor and exact product site before invoking the shared parser
function parseEnvelope(value: unknown): ForecastEnvelope {
  const envelope = objectValue(value);
  const site = objectValue(envelope?.site);

  // require the sole calendar anchor and allowlisted site identity
  if (
    envelope === null ||
    typeof envelope.generatedAt !== "string" ||
    site === null ||
    site.slug !== WIDGET_FORECAST_SITE.slug ||
    site.timezone !== WIDGET_FORECAST_SITE.timezone ||
    site.latitude !== WIDGET_FORECAST_SITE.latitude ||
    site.longitude !== WIDGET_FORECAST_SITE.longitude ||
    site.name !== WIDGET_FORECAST_SITE.name
  ) {
    throw new RangeError("Widget forecast site or calendar anchor is invalid");
  }

  return envelope as unknown as ForecastEnvelope;
}

// narrow one untrusted json object
function objectValue(value: unknown): Record<string, unknown> | null {
  // reject arrays and primitives
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

// normalize one explicit-zone instant
export function canonicalWidgetForecastInstant(value: string, field: string): string {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d{1,3})?(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(value);

  // reject local, normalized, and malformed timestamps
  if (match?.groups === undefined || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`Widget forecast ${field} is invalid`);
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

  // reject every calendar and zone component overflow
  if (
    day < 1 ||
    day > monthLength ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new RangeError(`Widget forecast ${field} is invalid`);
  }

  return new Date(value).toISOString();
}

// advance one iso calendar date without applying a runtime timezone
export function addWidgetForecastCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);

  // reject an unexpected wall-clock representation
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError("Widget forecast calendar date is invalid");
  }

  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// enumerate every real utc hour in one site-local day
export function widgetForecastHourlyInstants(
  dayStart: string,
  dayEnd: string,
  minimumHours: number,
  maximumHours: number,
): readonly string[] {
  const start = Date.parse(dayStart);
  const end = Date.parse(dayEnd);
  const count = (end - start) / HOUR_MS;

  // accept only reviewed civil-day capacities
  if (!Number.isSafeInteger(count) || count < minimumHours || count > maximumHours) {
    throw new RangeError("Widget forecast day has an unsupported hour count");
  }

  return Array.from(
    { length: count },
    // retain explicit repeated-hour instants during fall-back
    (_, index) => new Date(start + index * HOUR_MS).toISOString(),
  );
}

// reject duplicate and foreign-day rows while allowing genuine missing hours
export function indexWidgetForecastRecords(
  records: readonly WeatherRecord[],
  expectedStarts: readonly string[],
): ReadonlyMap<string, WeatherRecord> {
  const allowed = new Set(expectedStarts);
  const indexed = new Map<string, WeatherRecord>();

  // validate each supplied forecast row once
  for (const record of records) {
    const start = canonicalWidgetForecastInstant(record.validAt, "hour.start");

    // reject nonforecast, off-day, and duplicate rows
    if (
      record.provenance.sourceKind !== "forecast" ||
      !allowed.has(start) ||
      indexed.has(start)
    ) {
      throw new RangeError("Widget forecast contains a duplicate or foreign hour");
    }

    indexed.set(start, record);
  }

  return indexed;
}

// project one field with its independent correction deadline and provenance
function projectField(
  record: WeatherRecord | null,
  kind: FieldKind,
  generatedAt: string,
  genericRuntime: ReturnType<typeof parseForecastRecordsResponse>["adjustmentRuntime"],
  temperatureRuntime: ReturnType<typeof parseForecastRecordsResponse>["temperatureAdjustmentRuntime"],
): WidgetForecastField {
  // preserve a missing grid row without inventing dry weather
  if (record === null) {
    return unavailableField("missing");
  }

  // reject either supplied raw rain representation when physically invalid
  if (
    kind === "rain" &&
    ((record.metrics.precipitationRateMmPerHour !== null &&
      !validFieldValue("rain", record.metrics.precipitationRateMmPerHour)) ||
      (record.metrics.precipitationMm !== null &&
        !validFieldValue("rain", record.metrics.precipitationMm)))
  ) {
    throw new RangeError("Widget forecast contains invalid rain");
  }

  const raw = fieldValue(record, kind, false);
  const validatedRawSource = recordSource(
    record.productRunAt,
    record.receivedAt,
    generatedAt,
  );

  // reject present field-specific physical violations for the whole snapshot
  if (raw !== null && !validFieldValue(kind, raw)) {
    throw new RangeError(`Widget forecast contains invalid ${kind}`);
  }

  const rawSource = raw === null ? null : validatedRawSource;
  const selected = fieldValue(record, kind, true);
  const adjustment = adjustmentSelection(
    record,
    kind,
    generatedAt,
    genericRuntime,
    temperatureRuntime,
  );

  // retain a truthful raw selection when no active correction survived parsing
  if (adjustment === null) {
    return raw === null
      ? unavailableField("missing")
      : rawField(raw, validatedRawSource, "raw_forecast");
  }

  // demote unbounded corrections to their captured raw counterpart
  if (adjustment.deadline === null) {
    return raw === null
      ? unavailableField("missing")
      : rawField(raw, validatedRawSource, "deadline_unavailable");
  }

  // demote corrections already expired at the snapshot anchor
  if (Date.parse(adjustment.deadline) <= Date.parse(generatedAt)) {
    return raw === null
      ? unavailableField("missing")
      : rawField(raw, validatedRawSource, "deadline_expired");
  }

  // reject an invalid correction at the public boundary
  if (!validFieldValue(kind, selected)) {
    throw new RangeError(`Widget forecast contains invalid selected ${kind}`);
  }

  return {
    mode: "adjusted",
    raw,
    rawSource,
    reason: adjustment.reason,
    selected,
    selectedSource: adjustment.source,
    selectedUntil: adjustment.deadline,
  };
}

// identify the active resolver branch without exposing private adjustment metadata
function adjustmentSelection(
  record: WeatherRecord,
  kind: FieldKind,
  generatedAt: string,
  genericRuntime: ReturnType<typeof parseForecastRecordsResponse>["adjustmentRuntime"],
  temperatureRuntime: ReturnType<typeof parseForecastRecordsResponse>["temperatureAdjustmentRuntime"],
): Readonly<{
  deadline: string | null;
  reason: Extract<WidgetForecastReason, "generic_adjustment" | "independent_adjustment" | "rain_adjustment">;
  source: WidgetForecastSource;
}> | null {
  const maximum = Date.parse(generatedAt) + ADJUSTMENT_MAX_AGE_MS;

  // prefer the independently selected temperature correction
  if (kind === "temperature" && record.temperatureAdjustment?.state === "active") {
    const source = record.temperatureAdjustment.sourceForecast;
    return {
      deadline: boundedDeadline(maximum, temperatureRuntime.expiresAt),
      reason: "independent_adjustment",
      source: recordSource(
        source?.runInitializedAt ?? null,
        source?.firstReceivedAt,
        generatedAt,
      ),
    };
  }

  // prefer the independently selected rain correction
  if (kind === "rain" && record.rainAdjustment?.state === "active") {
    const source = record.rainAdjustment.sourceForecast;
    return {
      deadline: rainDeadline(maximum, source?.decisionAt, generatedAt),
      reason: "rain_adjustment",
      source: recordSource(
        source?.runInitializedAt ?? null,
        source?.firstReceivedAt,
        generatedAt,
      ),
    };
  }

  // retain only the generic correction branch the shared resolver can select
  if (
    kind === "temperature" &&
    record.adjustment?.state === "active" &&
    record.adjustment.appliedMetrics.includes("temperatureC")
  ) {
    return {
      deadline: boundedDeadline(maximum, genericRuntime.expiresAt),
      reason: "generic_adjustment",
      source: recordSource(record.productRunAt, record.receivedAt, generatedAt),
    };
  }

  return null;
}

// resolve rain rate before its hourly-amount compatibility fallback
function fieldValue(
  record: WeatherRecord,
  kind: FieldKind,
  useAdjustments: boolean,
): number | null {
  // preserve temperature's single canonical metric
  if (kind === "temperature") {
    return forecastMetricValue(record, "temperatureC", useAdjustments);
  }

  const rate = forecastMetricValue(record, "precipitationRateMmPerHour", useAdjustments);

  // reject a present invalid rate rather than hiding it behind a valid amount
  if (rate !== null && !validFieldValue("rain", rate)) {
    return rate;
  }

  return rate ?? forecastMetricValue(record, "precipitationMm", useAdjustments);
}

// cap one known adjustment deadline at snapshot age
function boundedDeadline(maximum: number, value: string | null | undefined): string | null {
  // fail raw when the applicable expiry is absent
  if (value === null || value === undefined) {
    return null;
  }

  try {
    const canonical = canonicalWidgetForecastInstant(value, "adjustment deadline");
    return new Date(Math.min(maximum, Date.parse(canonical))).toISOString();
  } catch {
    // fail raw on a malformed required deadline
    return null;
  }
}

// derive rain expiry without exposing its private decision clock
function rainDeadline(
  maximum: number,
  value: string | undefined,
  generatedAt: string,
): string | null {
  // fail raw when the parsed decision unexpectedly lacks its clock
  if (value === undefined) {
    return null;
  }

  let decisionAt: string;

  try {
    decisionAt = canonicalWidgetForecastInstant(value, "rain decisionAt");
  } catch {
    // fail raw on a malformed required decision clock
    return null;
  }

  // reject decisions that had not happened at snapshot generation
  if (Date.parse(decisionAt) > Date.parse(generatedAt)) {
    throw new RangeError("Widget forecast rain decision is from the future");
  }

  return new Date(Math.min(
    maximum,
    Date.parse(decisionAt) + RAIN_DECISION_MAX_AGE_MS,
  )).toISOString();
}

// project one allowlisted source clock pair
function recordSource(
  runAt: string | null,
  receivedAt: string | undefined,
  generatedAt: string,
): WidgetForecastSource {
  // reject selected sources without a trustworthy receipt clock
  if (receivedAt === undefined) {
    throw new RangeError("Widget forecast selected source is incomplete");
  }

  const canonicalRunAt = runAt === null
      ? null
      : canonicalWidgetForecastInstant(runAt, "source.runAt");
  const canonicalReceivedAt = canonicalWidgetForecastInstant(receivedAt, "source.receivedAt");

  // reject impossible source ordering before it can produce negative ages
  if (
    Date.parse(canonicalReceivedAt) > Date.parse(generatedAt) ||
    (canonicalRunAt !== null && Date.parse(canonicalRunAt) > Date.parse(canonicalReceivedAt))
  ) {
    throw new RangeError("Widget forecast source timestamps are out of order");
  }

  return {
    runAt: canonicalRunAt,
    receivedAt: canonicalReceivedAt,
  };
}

// enforce canonical physical ranges at the public projection boundary
function validFieldValue(kind: FieldKind, value: number | null): value is number {
  // preserve explicit missing values
  if (value === null || !Number.isFinite(value)) {
    return false;
  }

  return kind === "temperature"
    ? value >= -100 && value <= 70
    : value >= 0 && value <= 2_000;
}

// create one raw field with matching raw and selected provenance
function rawField(
  raw: number,
  source: WidgetForecastSource,
  reason: Extract<WidgetForecastReason, "deadline_expired" | "deadline_unavailable" | "raw_forecast">,
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

// create one unavailable field without counterfeit provenance
function unavailableField(
  reason: Extract<WidgetForecastReason, "missing">,
): WidgetForecastField {
  return {
    mode: "unavailable",
    raw: null,
    rawSource: null,
    reason,
    selected: null,
    selectedSource: null,
    selectedUntil: null,
  };
}

// summarize the complete anchored day without pretending gaps are dry
function summarizeStatus(hours: readonly WidgetForecastHour[]): WidgetForecastStatus {
  const modes = new Set<WidgetForecastMode>();

  // include both independently expiring fields
  for (const hour of hours) {
    modes.add(hour.temperatureC.mode);
    modes.add(hour.rainMmPerHour.mode);
  }

  // preserve a single honest mode when the whole day agrees
  if (modes.size === 1) {
    return [...modes][0]!;
  }

  return "mixed";
}
