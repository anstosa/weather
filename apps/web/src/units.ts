export type PrecipitationUnit = "inches" | "millimeters";
export type PressureUnit = "atmosphere_percent" | "hectopascals" | "inches_of_mercury";
export type TemperatureUnit = "celsius" | "fahrenheit";
export type WaterLevelUnit = "feet" | "meters";
export type WindSpeedUnit = "kilometers_per_hour" | "meters_per_second" | "miles_per_hour";

export interface UnitPreferences {
  readonly precipitation: PrecipitationUnit;
  readonly pressure: PressureUnit;
  readonly temperature: TemperatureUnit;
  readonly waterLevel: WaterLevelUnit;
  readonly windSpeed: WindSpeedUnit;
}

export interface FormattedMeasurement {
  readonly unit: string;
  readonly value: string;
}

export interface UnitPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const UNIT_PREFERENCE_STORAGE_KEY = "weather.unit-preferences.v1";

export const DEFAULT_UNIT_PREFERENCES: UnitPreferences = {
  precipitation: "inches",
  pressure: "atmosphere_percent",
  temperature: "fahrenheit",
  waterLevel: "feet",
  windSpeed: "miles_per_hour",
};

const PRECIPITATION_UNITS = new Set<PrecipitationUnit>(["inches", "millimeters"]);
const PRESSURE_UNITS = new Set<PressureUnit>([
  "atmosphere_percent",
  "hectopascals",
  "inches_of_mercury",
]);
const TEMPERATURE_UNITS = new Set<TemperatureUnit>(["celsius", "fahrenheit"]);
const WATER_LEVEL_UNITS = new Set<WaterLevelUnit>(["feet", "meters"]);
const WIND_SPEED_UNITS = new Set<WindSpeedUnit>([
  "kilometers_per_hour",
  "meters_per_second",
  "miles_per_hour",
]);

// load one validated browser preference record
export function loadUnitPreferences(
  storage: UnitPreferenceStorage | null,
): UnitPreferences {
  // retain defaults without browser storage
  if (storage === null) {
    return DEFAULT_UNIT_PREFERENCES;
  }

  try {
    const serialized = storage.getItem(UNIT_PREFERENCE_STORAGE_KEY);

    // retain defaults before first customization
    if (serialized === null) {
      return DEFAULT_UNIT_PREFERENCES;
    }

    return normalizeUnitPreferences(JSON.parse(serialized) as unknown);
  } catch {
    return DEFAULT_UNIT_PREFERENCES;
  }
}

// persist one normalized browser preference record
export function persistUnitPreferences(
  storage: UnitPreferenceStorage | null,
  preferences: UnitPreferences,
): void {
  // skip unavailable browser storage
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(UNIT_PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // retain in-memory preferences when storage is unavailable
  }
}

// replace invalid or stale preference fields with US defaults
export function normalizeUnitPreferences(value: unknown): UnitPreferences {
  const record = isRecord(value) ? value : {};
  return {
    precipitation: readPreference(
      record.precipitation,
      PRECIPITATION_UNITS,
      DEFAULT_UNIT_PREFERENCES.precipitation,
    ),
    pressure: readPreference(
      record.pressure,
      PRESSURE_UNITS,
      DEFAULT_UNIT_PREFERENCES.pressure,
    ),
    temperature: readPreference(
      record.temperature,
      TEMPERATURE_UNITS,
      DEFAULT_UNIT_PREFERENCES.temperature,
    ),
    waterLevel: readPreference(
      record.waterLevel,
      WATER_LEVEL_UNITS,
      DEFAULT_UNIT_PREFERENCES.waterLevel,
    ),
    windSpeed: readPreference(
      record.windSpeed,
      WIND_SPEED_UNITS,
      DEFAULT_UNIT_PREFERENCES.windSpeed,
    ),
  };
}

// format one canonical database value in the preferred display unit
export function formatMeasurement(
  value: number | null,
  kind: keyof UnitPreferences,
  preferences: UnitPreferences,
  maximumFractionDigits?: number,
): FormattedMeasurement {
  // preserve unavailable measurements
  if (value === null) {
    return { unit: "", value: "—" };
  }

  // convert from canonical metric storage
  switch (kind) {
    case "temperature":
      return preferences.temperature === "fahrenheit"
        ? formatValue((value * 9) / 5 + 32, "°F", maximumFractionDigits ?? 1)
        : formatValue(value, "°C", maximumFractionDigits ?? 1);
    case "windSpeed":
      switch (preferences.windSpeed) {
        case "miles_per_hour":
          return formatValue(value * 2.236_936_292_1, "mph", maximumFractionDigits ?? 1);
        case "kilometers_per_hour":
          return formatValue(value * 3.6, "km/h", maximumFractionDigits ?? 1);
        case "meters_per_second":
          return formatValue(value, "m/s", maximumFractionDigits ?? 1);
      }
    case "precipitation":
      return preferences.precipitation === "inches"
        ? formatValue(value / 25.4, "in", maximumFractionDigits ?? 2)
        : formatValue(value, "mm", maximumFractionDigits ?? 1);
    case "pressure":
      switch (preferences.pressure) {
        case "atmosphere_percent":
          return formatAtmosphereDeviation(value);
        case "inches_of_mercury":
          return formatValue(value * 0.029_529_983_1, "inHg", 1, 1);
        case "hectopascals":
          return formatValue(value, "hPa", 1, 1);
      }
    case "waterLevel":
      return preferences.waterLevel === "feet"
        ? formatValue(value * 3.280_839_895, "ft", maximumFractionDigits ?? 1)
        : formatValue(value, "m", maximumFractionDigits ?? 2);
  }
}

// expose browser storage without breaking restricted contexts
export function browserUnitPreferenceStorage(): UnitPreferenceStorage | null {
  try {
    // require the browser storage surface
    if (!("localStorage" in globalThis)) {
      return null;
    }

    return globalThis.localStorage;
  } catch {
    return null;
  }
}

// select one allowlisted stored preference
function readPreference<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<Value>,
  fallback: Value,
): Value {
  // reject malformed or unsupported values
  if (typeof value !== "string" || !allowed.has(value as Value)) {
    return fallback;
  }

  return value as Value;
}

// identify a JSON object safely
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// format one converted numeric value
function formatValue(
  value: number,
  unit: string,
  maximumFractionDigits: number,
  minimumFractionDigits = 0,
): FormattedMeasurement {
  return {
    unit,
    value: new Intl.NumberFormat("en-US", {
      maximumFractionDigits,
      minimumFractionDigits,
    }).format(value),
  };
}

// format pressure as a fixed one-decimal deviation from one atmosphere
function formatAtmosphereDeviation(valueHpa: number): FormattedMeasurement {
  const deviationPercent = ((valueHpa / 1_013.25) - 1) * 100;
  return {
    unit: "%",
    value: new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
      signDisplay: "always",
    }).format(deviationPercent),
  };
}
