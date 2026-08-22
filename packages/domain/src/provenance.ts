export const SOURCE_KINDS = [
  "physical_sensor",
  "model_current",
  "reanalysis",
  "forecast",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const STATION_KINDS = ["physical", "virtual"] as const;

export type StationKind = (typeof STATION_KINDS)[number];

export const SOURCE_CAPABILITIES = [
  "current",
  "historical",
  "forecast",
  "stream",
] as const;

export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SourceMaterialConfiguration {
  readonly adapterConfig: JsonValue;
  readonly location: {
    readonly latitude: number;
    readonly longitude: number;
    readonly siteKey: string;
    readonly timezone: string;
  };
  readonly providerKey: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationKey: string;
  readonly version: number;
}

const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  forecast: "forecast model product",
  model_current: "model-derived current conditions",
  physical_sensor: "physical sensor measurement",
  reanalysis: "gridded historical reanalysis",
};

// parse a closed source kind
export function parseSourceKind(value: string): SourceKind {
  // reject unknown semantics
  if (!SOURCE_KINDS.some((sourceKind) => sourceKind === value)) {
    throw new RangeError(`unsupported source kind: ${value}`);
  }

  return value as SourceKind;
}

// describe provenance without ambiguity
export function sourceKindLabel(sourceKind: SourceKind): string {
  return SOURCE_KIND_LABELS[sourceKind];
}

// distinguish physical measurements
export function isPhysicalMeasurement(sourceKind: SourceKind): boolean {
  return sourceKind === "physical_sensor";
}

// validate bounded identifiers
export function validateStableKey(value: string, fieldName: string): string {
  // require portable keys
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 80) {
    throw new RangeError(`${fieldName} must be a lowercase kebab-case key`);
  }

  return value;
}

// serialize material semantics deterministically
export function serializeSourceMaterial(
  configuration: SourceMaterialConfiguration,
): string {
  // require location identity
  if (configuration.location === undefined) {
    throw new TypeError("source material location is required");
  }

  validateStableKey(configuration.providerKey, "providerKey");
  validateStableKey(configuration.sourceKey, "sourceKey");
  validateStableKey(configuration.stationKey, "stationKey");
  validateStableKey(configuration.location.siteKey, "location.siteKey");

  // require bounded location coordinates
  if (
    !Number.isFinite(configuration.location.latitude) ||
    configuration.location.latitude < -90 ||
    configuration.location.latitude > 90 ||
    !Number.isFinite(configuration.location.longitude) ||
    configuration.location.longitude < -180 ||
    configuration.location.longitude > 180
  ) {
    throw new RangeError("source material location coordinates are invalid");
  }

  // require timezone identity
  if (
    typeof configuration.location.timezone !== "string" ||
    configuration.location.timezone.trim().length === 0 ||
    configuration.location.timezone.length > 128
  ) {
    throw new RangeError("source material location timezone is invalid");
  }

  // require versioned configuration
  if (!Number.isSafeInteger(configuration.version) || configuration.version < 1) {
    throw new RangeError("source material version must be a positive integer");
  }

  return canonicalizeJson(configuration as unknown as JsonValue);
}

// canonicalize JSON values
export function canonicalizeJson(value: JsonValue): string {
  // render null explicitly
  if (value === null) {
    return "null";
  }

  // reject non-json numbers
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("JSON numbers must be finite");
  }

  // render primitives directly
  if (typeof value !== "object") {
    const serialized = JSON.stringify(value);

    // reject non-json numbers
    if (serialized === undefined) {
      throw new TypeError("value is not valid JSON");
    }

    return serialized;
  }

  // preserve array order
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    compareJsonKeys(left, right),
  );

  return `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalizeJson(entry as JsonValue)}`,
    )
    .join(",")}}`;
}

// compare keys without locale drift
function compareJsonKeys(left: string, right: string): number {
  // order lower code units first
  if (left < right) {
    return -1;
  }

  // order higher code units last
  if (left > right) {
    return 1;
  }

  return 0;
}
