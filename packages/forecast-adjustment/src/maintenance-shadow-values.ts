import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const MAINTENANCE_SHADOW_VALUES_VERSION = "adjustment-shadow-prediction-values/v2" as const;
export const MAINTENANCE_SHADOW_LIMITS = Object.freeze({
  temperature: { rows: 12, bytes: 8_192 },
  wind: { rows: 168, bytes: 65_536 },
  rain: { rows: 23, bytes: 12_288 },
});
const COMMON_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "dueKey",
  "issuedAt", "sourceReceiptSha256", "inputSha256", "rowCount", "rows"] as const;
const ROW_KEYS = Object.freeze({
  temperature: ["validAt", "leadHours", "sourceRowSha256", "candidateTemperatureC64", "wouldApply", "fallbackCode"],
  wind: ["validAt", "leadHours", "sourceRowSha256", "candidateSpeedMps64", "candidateGustMps64", "speedWouldApply", "gustWouldApply"],
  rain: ["validAt", "leadHours", "sourceRowSha256", "occurrenceProbability64", "positiveAmountMm64",
    "candidatePrecipitationMm64", "atLeast1_0Probability64", "atLeast2_5Probability64", "wouldApply", "fallbackCode"],
});
const HASH = /^[a-f0-9]{64}$/u;
const BINARY64 = /^[a-f0-9]{16}$/u;
const FALLBACK_CODES = ["none", "missing_source", "ineligible", "physical_cap", "model_unavailable"];

export type MaintenanceShadowFamily = keyof typeof MAINTENANCE_SHADOW_LIMITS;

// retain the closed common header without arbitrary nested payloads
export interface MaintenanceShadowValues {
  readonly contractVersion: typeof MAINTENANCE_SHADOW_VALUES_VERSION;
  readonly family: MaintenanceShadowFamily;
  readonly registrationSha256: string;
  readonly candidateSha256: string;
  readonly dueKey: string;
  readonly issuedAt: string;
  readonly sourceReceiptSha256: string;
  readonly inputSha256: string;
  readonly rowCount: number;
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
}

// carry only hashes, counts and clocks across the database boundary
export interface MaintenanceShadowPredictionMetadata {
  readonly bodyByteCount: number;
  readonly dueKey: string;
  readonly inputSha256: string;
  readonly issuedAt: string;
  readonly maxValidAt: string;
  readonly minValidAt: string;
  readonly predictionBodySha256: string;
  readonly predictionSchemaSha256: string;
  readonly predictionSha256: string;
  readonly registrationSha256: string;
  readonly rowCount: number;
  readonly sourceReceiptSha256: string;
}

// bind the exact ordered family schema and fixed limits
export const MAINTENANCE_SHADOW_SCHEMA_SHA256 = Object.freeze(Object.fromEntries(
  Object.keys(MAINTENANCE_SHADOW_LIMITS).map(
    // use only fixed public schema inputs
    (family) => [family, sha256(Buffer.from(JSON.stringify({
      contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION, family, commonKeys: COMMON_KEYS,
      rowKeys: ROW_KEYS[family as MaintenanceShadowFamily], limits: MAINTENANCE_SHADOW_LIMITS[family as MaintenanceShadowFamily],
    }) + "\n"))],
  ),
) as Record<MaintenanceShadowFamily, string>);

// encode one finite binary64 in network order without decimal ambiguity
export function encodeMaintenanceBinary64(value: number): string {
  // nonfinite values cannot be serialized into evidence
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError("shadow value must be finite");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString("hex");
}

// decode exactly one finite network-order value
export function decodeMaintenanceBinary64(value: unknown): number {
  // reject decimal strings and alternate encodings
  if (typeof value !== "string" || !BINARY64.test(value)) {
    throw new RangeError("invalid shadow binary64");
  }
  const decoded = Buffer.from(value, "hex").readDoubleBE();
  // reject all infinities and nan payloads
  if (!Number.isFinite(decoded)) {
    throw new RangeError("shadow value must be finite");
  }
  return decoded;
}

// build the only accepted ordered wire representation
export function encodeMaintenanceShadowValues(value: MaintenanceShadowValues): Buffer {
  validateMaintenanceShadowValues(value);
  const ordered: Record<string, unknown> = {};
  // preserve header order independently of caller insertion order
  for (const key of COMMON_KEYS) {
    ordered[key] = key === "rows" ? value.rows.map(
      // preserve the exact family row field order
      (row) => Object.fromEntries(ROW_KEYS[value.family].map((field) => [field, row[field]])),
    ) : value[key];
  }
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  // a large legal-looking body still fails its fixed family cap
  if (bytes.length > MAINTENANCE_SHADOW_LIMITS[value.family].bytes) {
    throw new RangeError("shadow body exceeds its family cap");
  }
  return bytes;
}

// parse bounded utf8 and require one canonical closed body
export function parseMaintenanceShadowValues(bytes: Uint8Array): MaintenanceShadowValues {
  // reject oversized input before decoding or allocating json objects
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAINTENANCE_SHADOW_LIMITS.wind.bytes) {
    throw new RangeError("invalid shadow body size");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as MaintenanceShadowValues;
  const canonical = encodeMaintenanceShadowValues(value);
  // duplicate keys, alternate order, numbers and whitespace cannot share an identity
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("shadow body is not canonical");
  }
  return value;
}

// derive the compact identity from the exact already-staged body
export function createMaintenanceShadowPredictionMetadata(bytes: Uint8Array): MaintenanceShadowPredictionMetadata {
  const body = parseMaintenanceShadowValues(bytes);
  const predictionBodySha256 = sha256(Buffer.from(bytes));
  const predictionSchemaSha256 = MAINTENANCE_SHADOW_SCHEMA_SHA256[body.family];
  const minValidAt = body.rows[0]!.validAt as string;
  const maxValidAt = body.rows.at(-1)!.validAt as string;
  // share the exact millisecond clocks with PostgreSQL
  const predictionSha256 = sha256(Buffer.from([
    "adjustment-shadow-prediction/v2", body.registrationSha256, body.dueKey,
    body.issuedAt, minValidAt, maxValidAt,
    body.sourceReceiptSha256, body.inputSha256, predictionBodySha256, predictionSchemaSha256,
    String(body.rowCount), String(bytes.byteLength),
  ].join("\n")));
  return {
    bodyByteCount: bytes.byteLength, dueKey: body.dueKey, inputSha256: body.inputSha256,
    issuedAt: body.issuedAt, maxValidAt, minValidAt, predictionBodySha256, predictionSchemaSha256,
    predictionSha256, registrationSha256: body.registrationSha256,
    rowCount: body.rowCount, sourceReceiptSha256: body.sourceReceiptSha256,
  };
}

// validate identities and before-valid family predictions without qualification
export function validateMaintenanceShadowValues(value: MaintenanceShadowValues): void {
  exactKeys(value, COMMON_KEYS);
  // accept only the frozen three families and schema
  if (value.contractVersion !== MAINTENANCE_SHADOW_VALUES_VERSION ||
      !Object.hasOwn(MAINTENANCE_SHADOW_LIMITS, value.family)) {
    throw new RangeError("invalid shadow contract");
  }
  // close every portable identity
  for (const key of ["registrationSha256", "candidateSha256", "sourceReceiptSha256", "inputSha256"] as const) {
    requireHash(value[key]);
  }
  requireInstant(value.issuedAt);
  // due identity is a fixed six-hour capture cycle rather than a caller path
  if (typeof value.dueKey !== "string" || !/^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(value.dueKey)) {
    throw new RangeError("invalid shadow due key");
  }
  requireInstant(value.dueKey.slice(8));
  const limit = MAINTENANCE_SHADOW_LIMITS[value.family];
  // missing leads are gaps rather than a shortened qualifying body
  if (!Array.isArray(value.rows) || value.rowCount !== limit.rows || value.rows.length !== limit.rows) {
    throw new RangeError("invalid shadow row count");
  }
  let previousValidAt: string | null = null;
  // require each ordered lead once and before its actual valid instant
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, ROW_KEYS[value.family]);
    requireInstant(row.validAt);
    requireHash(row.sourceRowSha256);
    // a reordered, duplicated or late row cannot become prospective evidence
    if (row.leadHours !== index + 1 || (row.validAt as string) <= value.issuedAt ||
        (previousValidAt !== null && Date.parse(row.validAt as string) - Date.parse(previousValidAt) !== 3_600_000)) {
      throw new RangeError("shadow lead or clock differs");
    }
    previousValidAt = row.validAt as string;
    // temperature predictions retain the existing physical caps
    if (value.family === "temperature") {
      boundedValue(row.candidateTemperatureC64, -100, 70);
      validateFallback(row);
    } else if (value.family === "rain") {
      boundedValue(row.occurrenceProbability64, 0, 1);
      boundedValue(row.atLeast1_0Probability64, 0, 1);
      boundedValue(row.atLeast2_5Probability64, 0, 1);
      boundedValue(row.positiveAmountMm64, 0, 30);
      boundedValue(row.candidatePrecipitationMm64, 0, 30);
      validateFallback(row);
    } else {
      boundedValue(row.candidateSpeedMps64, 0, 150);
      requireBoolean(row.speedWouldApply);
      requireBoolean(row.gustWouldApply);
      // the disabled gust pair must remain structurally absent
      if (index + 1 >= 49 && index + 1 <= 72) {
        // null and false are the only disabled-gust representation
        if (row.candidateGustMps64 !== null || row.gustWouldApply !== false) {
          throw new RangeError("disabled gust shadow is present");
        }
      } else {
        boundedValue(row.candidateGustMps64, 0, 150);
      }
    }
  }
}

// retain an explicit fallback without inventing a successful application
function validateFallback(row: Readonly<Record<string, unknown>>): void {
  requireBoolean(row.wouldApply);
  // fallback classifications and application must agree
  if (!FALLBACK_CODES.includes(row.fallbackCode as string) || row.wouldApply !== (row.fallbackCode === "none")) {
    throw new RangeError("shadow fallback differs");
  }
}

// reject nonphysical binary64 without clipping evidence
function boundedValue(value: unknown, minimum: number, maximum: number): void {
  const decoded = decodeMaintenanceBinary64(value);
  // preserve the frozen physical interval
  if (decoded < minimum || decoded > maximum) {
    throw new RangeError("shadow value exceeds its physical cap");
  }
}

// prohibit arbitrary properties at every wire boundary
function exactKeys(value: unknown, keys: readonly string[]): void {
  // allow only plain records with the exact known fields
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new RangeError("shadow fields differ");
  }
}

// reject normalized timestamps before causal comparison
function requireInstant(value: unknown): void {
  // use exact millisecond utc representation
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError("invalid shadow instant");
  }
}

// restrict identities to lowercase content addresses
function requireHash(value: unknown): void {
  // never accept unbounded labels or paths as hashes
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new RangeError("invalid shadow identity");
  }
}

// retain booleans without javascript truthiness
function requireBoolean(value: unknown): void {
  // reject numeric and string aliases
  if (typeof value !== "boolean") {
    throw new RangeError("invalid shadow boolean");
  }
}

// hash only the exact ordered canonical bytes
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
