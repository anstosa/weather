// freeze the only supported local calendar
export const FORECAST_ADJUSTMENT_TIMEZONE = "America/Los_Angeles" as const;

// freeze the complete qualification epoch length
export const QUALIFICATION_EPOCH_LOCAL_DAYS = 402 as const;

// name one local meteorological season
export type LocalMeteorologicalSeason =
  | "autumn"
  | "spring"
  | "summer"
  | "winter";

// name one local six-hour daypart
export type LocalDaypart =
  | "afternoon"
  | "evening"
  | "morning"
  | "night";

// describe the pinned runtime calendar identity
export interface RuntimeCalendarFingerprint {
  readonly icuVersion: string;
  readonly tzdataVersion: string;
}

// describe one UTC instant in the local calendar
export interface LocalCalendarFeatures {
  readonly daypart: LocalDaypart;
  readonly hour: number;
  readonly localDate: string;
  readonly month: number;
  readonly season: LocalMeteorologicalSeason;
  readonly timezone: typeof FORECAST_ADJUSTMENT_TIMEZONE;
  readonly validAt: string;
}

// describe one inclusive calendar partition
export interface LocalDatePartition {
  readonly endIndex: number;
  readonly endLocalDate: string;
  readonly localDates: readonly string[];
  readonly startIndex: number;
  readonly startLocalDate: string;
}

// describe one frozen development fold
export interface DevelopmentCalendarFold {
  readonly embargo: LocalDatePartition;
  readonly fold: 1 | 2 | 3 | 4 | 5;
  readonly score: LocalDatePartition;
  readonly training: LocalDatePartition;
}

// describe the full qualification calendar
export interface QualificationCalendarEpoch {
  readonly d0: string;
  readonly d401: string;
  readonly finalEmbargo: LocalDatePartition;
  readonly finalTraining: LocalDatePartition;
  readonly folds: readonly DevelopmentCalendarFold[];
  readonly holdout: LocalDatePartition;
  readonly localDates: readonly string[];
  readonly timezone: typeof FORECAST_ADJUSTMENT_TIMEZONE;
}

// freeze exact fold index boundaries
export const DEVELOPMENT_FOLD_INDEXES = [
  { embargo: [180, 186], fold: 1, score: [187, 216], training: [0, 179] },
  { embargo: [217, 223], fold: 2, score: [224, 253], training: [0, 216] },
  { embargo: [254, 260], fold: 3, score: [261, 290], training: [0, 253] },
  { embargo: [291, 297], fold: 4, score: [298, 327], training: [0, 290] },
  { embargo: [328, 334], fold: 5, score: [335, 364], training: [0, 327] },
] as const;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const localCalendarFormatter = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  numberingSystem: "latn",
  timeZone: FORECAST_ADJUSTMENT_TIMEZONE,
  year: "numeric",
});

// parse one strict Gregorian local-date label
function parseLocalDate(localDate: string): {
  readonly day: number;
  readonly month: number;
  readonly year: number;
} {
  const match = LOCAL_DATE_PATTERN.exec(localDate);

  // reject malformed labels
  if (match === null) {
    throw new RangeError("localDate must use YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
    .toISOString()
    .slice(0, 10);

  // reject normalized or impossible dates
  if (roundTrip !== localDate) {
    throw new RangeError("localDate must be a valid Gregorian date");
  }

  return { day, month, year };
}

// validate and normalize one UTC instant
function normalizeUtcInstant(validAt: string): string {
  // reject offset and noncanonical timestamps
  if (!UTC_INSTANT_PATTERN.test(validAt) || !Number.isFinite(Date.parse(validAt))) {
    throw new RangeError("validAt must be a canonical UTC instant");
  }

  return new Date(validAt).toISOString();
}

// advance a Gregorian date label without fixed-duration arithmetic
export function addLocalCalendarDays(localDate: string, days: number): string {
  const parsed = parseLocalDate(localDate);

  // require a whole calendar-day offset
  if (!Number.isInteger(days)) {
    throw new RangeError("days must be an integer");
  }

  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
    .toISOString()
    .slice(0, 10);
}

// classify one calendar month into its meteorological season
export function meteorologicalSeasonForMonth(
  month: number,
): LocalMeteorologicalSeason {
  // reject values outside the Gregorian calendar
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("month must be an integer between 1 and 12");
  }

  // map the northern-hemisphere seasons
  if (month === 12 || month <= 2) {
    return "winter";
  }

  // map spring months
  if (month <= 5) {
    return "spring";
  }

  // map summer months
  if (month <= 8) {
    return "summer";
  }

  return "autumn";
}

// classify one local wall-clock hour into its six-hour daypart
export function daypartForLocalHour(hour: number): LocalDaypart {
  // reject values outside the local clock
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError("hour must be an integer between 0 and 23");
  }

  // map the first six local hours
  if (hour < 6) {
    return "night";
  }

  // map the next six local hours
  if (hour < 12) {
    return "morning";
  }

  // map the afternoon hours
  if (hour < 18) {
    return "afternoon";
  }

  return "evening";
}

// map one UTC event to the pinned Los Angeles calendar
export function localCalendarFeaturesFor(validAt: string): LocalCalendarFeatures {
  const normalizedValidAt = normalizeUtcInstant(validAt);
  const parts = localCalendarFormatter.formatToParts(new Date(normalizedValidAt));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const monthText = values.get("month");
  const day = values.get("day");
  const hourText = values.get("hour");

  // reject incomplete ICU calendar output
  if (
    year === undefined ||
    monthText === undefined ||
    day === undefined ||
    hourText === undefined
  ) {
    throw new Error("ICU did not return complete local calendar features");
  }

  const month = Number(monthText);
  const hour = Number(hourText);

  return {
    daypart: daypartForLocalHour(hour),
    hour,
    localDate: `${year}-${monthText}-${day}`,
    month,
    season: meteorologicalSeasonForMonth(month),
    timezone: FORECAST_ADJUSTMENT_TIMEZONE,
    validAt: normalizedValidAt,
  };
}

// capture the runtime ICU and tzdata identity
export function runtimeCalendarFingerprint(): RuntimeCalendarFingerprint {
  const icuVersion = process.versions.icu;
  const tzdataVersion = process.versions.tz;

  // fail closed when Node omits either runtime component
  if (!icuVersion || !tzdataVersion) {
    throw new Error("Node runtime must expose ICU and tzdata versions");
  }

  return { icuVersion, tzdataVersion };
}

// compare an artifact fingerprint with the current runtime
export function runtimeCalendarFingerprintMatches(
  expected: RuntimeCalendarFingerprint,
): boolean {
  const current = runtimeCalendarFingerprint();
  return (
    expected.icuVersion === current.icuVersion &&
    expected.tzdataVersion === current.tzdataVersion
  );
}

// materialize one inclusive partition from epoch indexes
function createPartition(
  localDates: readonly string[],
  startIndex: number,
  endIndex: number,
): LocalDatePartition {
  const startLocalDate = localDates[startIndex];
  const endLocalDate = localDates[endIndex];

  // reject incomplete epoch slices
  if (startLocalDate === undefined || endLocalDate === undefined) {
    throw new RangeError("partition indexes fall outside the qualification epoch");
  }

  return {
    endIndex,
    endLocalDate,
    localDates: localDates.slice(startIndex, endIndex + 1),
    startIndex,
    startLocalDate,
  };
}

// construct the literal D0 through D401 calendar and folds
export function createQualificationCalendarEpoch(
  latestFullyCoveredLocalDate: string,
): QualificationCalendarEpoch {
  parseLocalDate(latestFullyCoveredLocalDate);
  const d0 = addLocalCalendarDays(
    latestFullyCoveredLocalDate,
    -(QUALIFICATION_EPOCH_LOCAL_DAYS - 1),
  );
  const localDates = Array.from(
    { length: QUALIFICATION_EPOCH_LOCAL_DAYS },
    (_unused, index) => addLocalCalendarDays(d0, index),
  );
  const folds = DEVELOPMENT_FOLD_INDEXES.map((definition) => ({
    embargo: createPartition(
      localDates,
      definition.embargo[0],
      definition.embargo[1],
    ),
    fold: definition.fold,
    score: createPartition(localDates, definition.score[0], definition.score[1]),
    training: createPartition(
      localDates,
      definition.training[0],
      definition.training[1],
    ),
  }));

  return {
    d0,
    d401: latestFullyCoveredLocalDate,
    finalEmbargo: createPartition(localDates, 365, 371),
    finalTraining: createPartition(localDates, 0, 364),
    folds,
    holdout: createPartition(localDates, 372, 401),
    localDates,
    timezone: FORECAST_ADJUSTMENT_TIMEZONE,
  };
}
