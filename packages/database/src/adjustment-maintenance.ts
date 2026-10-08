import type { QueryResultRow } from "pg";

import type { Queryable } from "./pool.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DUE_KEY_PATTERN =
  /^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const HOUR_MS = 3_600_000;
const MAX_INPUT_BYTES = 2_048;
const MAX_AVAILABILITY_BYTES = 512 * 1_024;
const MAX_AUTHORIZATION_BYTES = 8_192;

const FAMILY_LIMITS = Object.freeze({
  rain: Object.freeze({
    bodyBytes: 12_288,
    rows: 23,
    schemaSha256: "5c07000d56ce21824aa545ebb10405dd80ba7c35368397128aa65c4fb799dd46",
  }),
  temperature: Object.freeze({
    bodyBytes: 8_192,
    rows: 12,
    schemaSha256: "eb9930a1e12919d6f35feb2d402b87b336859b24f031f0e2e3d99168716dc0cd",
  }),
  wind: Object.freeze({
    bodyBytes: 65_536,
    rows: 168,
    schemaSha256: "965272030594b887edf45c62c805f909d148c497d57e803010b6148b25d964d0",
  }),
} as const);

const REGISTRATION_KEYS = Object.freeze([
  "artifactSha256",
  "candidateSha256",
  "cohortSha256",
  "family",
  "intervalEndAt",
  "intervalStartAt",
  "policySha256",
  "registrationSha256",
  "reservedKeySha256",
  "siteKey",
  "sourceSha256",
  "targetCutoffAt",
  "terminalAt",
] as const);

const PREDICTION_KEYS = Object.freeze([
  "bodyByteCount",
  "dueKey",
  "inputSha256",
  "issuedAt",
  "maxValidAt",
  "minValidAt",
  "predictionBodySha256",
  "predictionSchemaSha256",
  "predictionSha256",
  "registrationSha256",
  "rowCount",
  "sourceReceiptSha256",
] as const);

const AVAILABILITY_KEYS = Object.freeze([
  "contractVersion",
  "expectedKeySetSha256",
  "family",
  "finalizedMetadataRootSha256",
  "finalizedPredictionCount",
  "finalizedThroughAt",
  "hotPredictionCount",
  "hotPredictions",
  "hotSetRootSha256",
  "intervalEndAt",
  "intervalStartAt",
  "metadataGeneration",
  "missingExpectedDueKeys",
  "missingExpectedDueKeysStatus",
  "registrationSha256",
  "targetCutoffAt",
] as const);

const HOT_PREDICTION_KEYS = Object.freeze([
  "dueKey",
  "maxValidAt",
  "minValidAt",
  "predictionSha256",
  "rowCount",
] as const);

const AUTHORIZATION_KEYS = Object.freeze([
  "accessSha256",
  "chunkCount",
  "chunkIndex",
  "contractVersion",
  "eligiblePredictionSetSha256",
  "expectedKeySetSha256",
  "family",
  "fromLocalDate",
  "metadataRootSha256",
  "registrationSha256",
  "revisionCatalogWatermarkSha256",
  "targetComparatorSnapshotRootSha256",
  "targetCutoffAt",
  "toLocalDateExclusive",
] as const);

export type AdjustmentShadowFamily = "temperature" | "wind" | "rain";

// define one frozen value-free registration input
export interface AdjustmentShadowRegistration<F extends AdjustmentShadowFamily> {
  readonly artifactSha256: string;
  readonly candidateSha256: string;
  readonly cohortSha256: string;
  readonly family: F;
  readonly intervalEndAt: string;
  readonly intervalStartAt: string;
  readonly policySha256: string;
  readonly registrationSha256: string;
  readonly reservedKeySha256: string;
  readonly siteKey: "ballydidean";
  readonly sourceSha256: string;
  readonly targetCutoffAt: string;
  readonly terminalAt: string;
}

// define one compact body receipt input without value fields
export interface AdjustmentShadowPrediction {
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

// expose only the bounded registration receipt
export interface AdjustmentShadowRegistrationReceipt {
  readonly inserted: boolean;
  readonly registrationSha256: string;
}

// expose only the bounded compact-row receipt
export interface AdjustmentShadowPredictionReceipt {
  readonly committedAt: string;
  readonly inserted: boolean;
  readonly predictionSha256: string;
}

// expose one value-free hot prediction identity
export interface AdjustmentHotPrediction {
  readonly dueKey: string;
  readonly maxValidAt: string;
  readonly minValidAt: string;
  readonly predictionSha256: string;
  readonly rowCount: number;
}

// expose value-free availability pending cold reconstruction
export interface AdjustmentConfirmationAvailability {
  readonly contractVersion: "adjustment-confirmation-availability/v2";
  readonly expectedKeySetSha256: string;
  readonly family: AdjustmentShadowFamily;
  readonly finalizedMetadataRootSha256: string;
  readonly finalizedPredictionCount: number;
  readonly finalizedThroughAt: string | null;
  readonly hotPredictionCount: number;
  readonly hotPredictions: readonly AdjustmentHotPrediction[];
  readonly hotSetRootSha256: string;
  readonly intervalEndAt: string;
  readonly intervalStartAt: string;
  readonly metadataGeneration: number;
  readonly missingExpectedDueKeys: null;
  readonly missingExpectedDueKeysStatus: "requires_anchored_cold_reconstruction";
  readonly registrationSha256: string;
  readonly targetCutoffAt: string;
}

// expose one post-burn value-free chunk authorization
export interface AdjustmentConfirmationChunkAuthorization {
  readonly accessSha256: string;
  readonly chunkCount: 24 | 27;
  readonly chunkIndex: number;
  readonly contractVersion: "adjustment-confirmation-export-authorization/v2";
  readonly eligiblePredictionSetSha256: string;
  readonly expectedKeySetSha256: string;
  readonly family: AdjustmentShadowFamily;
  readonly fromLocalDate: string;
  readonly metadataRootSha256: string;
  readonly registrationSha256: string;
  readonly revisionCatalogWatermarkSha256: string;
  readonly targetComparatorSnapshotRootSha256: string;
  readonly targetCutoffAt: string;
  readonly toLocalDateExclusive: string;
}

interface JsonRow extends QueryResultRow {
  readonly value: unknown;
}

interface BooleanRow extends QueryResultRow {
  readonly admitted: unknown;
}

// register one API-owned temperature or wind slot
export async function registerApiAdjustmentShadow(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<"temperature" | "wind">,
): Promise<AdjustmentShadowRegistrationReceipt> {
  return registerAdjustmentShadow(queryable, registration, ["temperature", "wind"]);
}

// register the one ingest-owned rain slot
export async function registerRainAdjustmentShadow(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<"rain">,
): Promise<AdjustmentShadowRegistrationReceipt> {
  return registerAdjustmentShadow(queryable, registration, ["rain"]);
}

// append one API-owned temperature compact receipt
export async function appendTemperatureAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "temperature", prediction);
}

// append one API-owned wind compact receipt
export async function appendWindAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "wind", prediction);
}

// append one ingest-owned rain compact receipt
export async function appendRainAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "rain", prediction);
}

// check one exact API body relay tuple
export async function isAdjustmentShadowBodyAdmitted(
  queryable: Queryable,
  registrationSha256: string,
  dueKey: string,
  predictionBodySha256: string,
  bodyByteCount: number,
): Promise<boolean> {
  requireHash(registrationSha256, "registration identity");
  parseDueKey(dueKey);
  requireHash(predictionBodySha256, "prediction body identity");
  requireInteger(bodyByteCount, 1, FAMILY_LIMITS.wind.bodyBytes, "body byte count");
  const result = await queryable.query<BooleanRow>(
    `SELECT adjustment_shadow_body_admission_v2(
      $1::text, $2::text, $3::text, $4::integer
    ) AS admitted`,
    [registrationSha256, dueKey, predictionBodySha256, bodyByteCount],
  );
  const admitted = result.rows[0]?.admitted;
  // require the exact scalar contract
  if (typeof admitted !== "boolean" || result.rows.length !== 1) {
    throw new Error("adjustment body admission contract mismatch");
  }
  return admitted;
}

// read one training-only value-free availability document
export async function readTrainingAdjustmentConfirmationAvailability(
  queryable: Queryable,
  registrationSha256: string,
): Promise<AdjustmentConfirmationAvailability> {
  requireHash(registrationSha256, "registration identity");
  const result = await queryable.query<JsonRow>(
    "SELECT adjustment_confirmation_availability_v2($1::text) AS value",
    [registrationSha256],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment availability");
  validateAvailability(value, registrationSha256);
  return value as unknown as AdjustmentConfirmationAvailability;
}

// authorize one training-only post-burn chunk
export async function authorizeTrainingAdjustmentConfirmationChunk(
  queryable: Queryable,
  registrationSha256: string,
  accessSha256: string,
  chunkIndex: number,
): Promise<AdjustmentConfirmationChunkAuthorization> {
  requireHash(registrationSha256, "registration identity");
  requireHash(accessSha256, "access identity");
  requireInteger(chunkIndex, 0, 26, "chunk index");
  const result = await queryable.query<JsonRow>(
    `SELECT adjustment_confirmation_export_v2(
      $1::text, $2::text, $3::smallint
    ) AS value`,
    [registrationSha256, accessSha256, chunkIndex],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment chunk authorization");
  validateAuthorization(value, registrationSha256, accessSha256, chunkIndex);
  return value as unknown as AdjustmentConfirmationChunkAuthorization;
}

// register through the one closed database function
async function registerAdjustmentShadow<F extends AdjustmentShadowFamily>(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<F>,
  allowedFamilies: readonly F[],
): Promise<AdjustmentShadowRegistrationReceipt> {
  requireExactObject(registration, REGISTRATION_KEYS, "adjustment registration");
  // keep role-shaped methods from crossing family authority
  if (!allowedFamilies.includes(registration.family)) {
    throw new RangeError("adjustment registration family is invalid");
  }
  // keep the registration fixed to the deployed site
  if (registration.siteKey !== "ballydidean") {
    throw new RangeError("adjustment registration site is invalid");
  }
  // validate every frozen registration identity
  for (const [value, label] of [
    [registration.artifactSha256, "artifact identity"],
    [registration.candidateSha256, "candidate identity"],
    [registration.cohortSha256, "cohort identity"],
    [registration.policySha256, "policy identity"],
    [registration.registrationSha256, "registration identity"],
    [registration.reservedKeySha256, "reserved key identity"],
    [registration.sourceSha256, "source identity"],
  ] as const) {
    requireHash(value, label);
  }
  const intervalStart = parseUtcMilliseconds(registration.intervalStartAt, "interval start");
  const intervalEnd = parseUtcMilliseconds(registration.intervalEndAt, "interval end");
  const targetCutoff = parseUtcMilliseconds(registration.targetCutoffAt, "target cutoff");
  const terminal = parseUtcMilliseconds(registration.terminalAt, "terminal time");
  // require closed chronological interval clocks
  if (!(intervalStart < intervalEnd && intervalEnd <= targetCutoff && targetCutoff <= terminal)) {
    throw new RangeError("adjustment registration clocks are invalid");
  }
  const canonical = canonicalFlatJson(registration, REGISTRATION_KEYS, "adjustment registration");
  const result = await queryable.query<JsonRow>(
    "SELECT weather_register_adjustment_shadow_v2($1::jsonb) AS value",
    [canonical],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment registration receipt");
  requireExactObject(value, ["inserted", "registrationSha256"], "adjustment registration receipt");
  // require the database to bind the supplied identity
  if (typeof value.inserted !== "boolean" || value.registrationSha256 !== registration.registrationSha256) {
    throw new Error("adjustment registration receipt mismatch");
  }
  return value as unknown as AdjustmentShadowRegistrationReceipt;
}

// append through one fixed family function
async function appendAdjustmentShadow(
  queryable: Queryable,
  family: AdjustmentShadowFamily,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  requireExactObject(prediction, PREDICTION_KEYS, "adjustment prediction");
  // validate every compact prediction identity
  for (const [value, label] of [
    [prediction.inputSha256, "input identity"],
    [prediction.predictionBodySha256, "prediction body identity"],
    [prediction.predictionSchemaSha256, "prediction schema identity"],
    [prediction.predictionSha256, "prediction identity"],
    [prediction.registrationSha256, "registration identity"],
    [prediction.sourceReceiptSha256, "source receipt identity"],
  ] as const) {
    requireHash(value, label);
  }
  const limits = FAMILY_LIMITS[family];
  // require the exact public family schema
  if (prediction.predictionSchemaSha256 !== limits.schemaSha256) {
    throw new RangeError("adjustment prediction schema is invalid");
  }
  requireInteger(prediction.rowCount, 1, limits.rows, "prediction row count");
  requireInteger(prediction.bodyByteCount, 1, limits.bodyBytes, "prediction body byte count");
  const dueAt = parseDueKey(prediction.dueKey);
  const issuedAt = parseUtcMilliseconds(prediction.issuedAt, "prediction issue time");
  const minValidAt = parseUtcMilliseconds(prediction.minValidAt, "minimum valid time");
  const maxValidAt = parseUtcMilliseconds(prediction.maxValidAt, "maximum valid time");
  // preserve jitter while bounding it to the exact due window
  if (issuedAt < dueAt || issuedAt > dueAt + 12 * HOUR_MS) {
    throw new RangeError("adjustment prediction issue time is outside its due window");
  }
  // preserve actual source clocks before the prediction validity range
  if (issuedAt >= minValidAt || minValidAt > maxValidAt) {
    throw new RangeError("adjustment prediction validity clocks are invalid");
  }
  const canonical = canonicalFlatJson(prediction, PREDICTION_KEYS, "adjustment prediction");
  const functionName = {
    rain: "weather_append_adjustment_rain_shadow_v2",
    temperature: "weather_append_adjustment_temperature_shadow_v2",
    wind: "weather_append_adjustment_wind_shadow_v2",
  }[family];
  const result = await queryable.query<JsonRow>(
    `SELECT ${functionName}($1::jsonb) AS value`,
    [canonical],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment prediction receipt");
  requireExactObject(
    value,
    ["committedAt", "inserted", "predictionSha256"],
    "adjustment prediction receipt",
  );
  parseUtcMilliseconds(value.committedAt, "prediction commit time");
  // require the database to bind the supplied identity
  if (typeof value.inserted !== "boolean" || value.predictionSha256 !== prediction.predictionSha256) {
    throw new Error("adjustment prediction receipt mismatch");
  }
  return value as unknown as AdjustmentShadowPredictionReceipt;
}

// validate one value-free availability document
function validateAvailability(value: Record<string, unknown>, registrationSha256: string): void {
  requireExactObject(value, AVAILABILITY_KEYS, "adjustment availability");
  requireBoundedJson(value, MAX_AVAILABILITY_BYTES, "adjustment availability");
  // require the fixed availability contract and requested identity
  if (value.contractVersion !== "adjustment-confirmation-availability/v2" ||
    value.registrationSha256 !== registrationSha256 ||
    !isFamily(value.family) ||
    value.missingExpectedDueKeys !== null ||
    value.missingExpectedDueKeysStatus !== "requires_anchored_cold_reconstruction") {
    throw new Error("adjustment availability contract mismatch");
  }
  // validate every availability root
  for (const [candidate, label] of [
    [value.expectedKeySetSha256, "expected key set identity"],
    [value.finalizedMetadataRootSha256, "finalized metadata root"],
    [value.hotSetRootSha256, "hot set root"],
  ] as const) {
    requireHash(candidate, label);
  }
  requireInteger(value.finalizedPredictionCount, 0, Number.MAX_SAFE_INTEGER,
    "finalized prediction count");
  requireInteger(value.metadataGeneration, 0, Number.MAX_SAFE_INTEGER,
    "metadata generation");
  parseUtcMilliseconds(value.intervalStartAt, "interval start");
  parseUtcMilliseconds(value.intervalEndAt, "interval end");
  parseUtcMilliseconds(value.targetCutoffAt, "target cutoff");
  // validate an optional finalized clock
  if (value.finalizedThroughAt !== null) {
    parseUtcMilliseconds(value.finalizedThroughAt, "finalized through time");
  }
  // require one closed sorted hot projection array
  if (!Array.isArray(value.hotPredictions)) {
    throw new Error("adjustment availability hot predictions are invalid");
  }
  requireInteger(value.hotPredictionCount, 0, 8_192, "hot prediction count");
  // bind the declared count to every sorted projection
  if (value.hotPredictionCount !== value.hotPredictions.length) {
    throw new Error("adjustment availability hot prediction count differs");
  }
  let previousIdentity = "";
  // validate every sorted hot projection
  for (const prediction of value.hotPredictions) {
    requireExactObject(prediction, HOT_PREDICTION_KEYS, "hot prediction");
    requireHash(prediction.predictionSha256, "hot prediction identity");
    parseDueKey(prediction.dueKey);
    parseUtcMilliseconds(prediction.minValidAt, "hot minimum valid time");
    parseUtcMilliseconds(prediction.maxValidAt, "hot maximum valid time");
    requireInteger(prediction.rowCount, 1, FAMILY_LIMITS[value.family].rows,
      "hot prediction row count");
    // require the database's canonical identity ordering
    if (prediction.predictionSha256 <= previousIdentity) {
      throw new Error("adjustment availability hot predictions are unordered");
    }
    previousIdentity = prediction.predictionSha256;
  }
}

// validate one value-free chunk authorization
function validateAuthorization(
  value: Record<string, unknown>,
  registrationSha256: string,
  accessSha256: string,
  chunkIndex: number,
): void {
  requireExactObject(value, AUTHORIZATION_KEYS, "adjustment chunk authorization");
  requireBoundedJson(value, MAX_AUTHORIZATION_BYTES, "adjustment chunk authorization");
  // require the requested immutable authorization identity
  if (value.contractVersion !== "adjustment-confirmation-export-authorization/v2" ||
    value.registrationSha256 !== registrationSha256 || value.accessSha256 !== accessSha256 ||
    value.chunkIndex !== chunkIndex || !isFamily(value.family)) {
    throw new Error("adjustment chunk authorization contract mismatch");
  }
  const expectedChunkCount = value.family === "rain" ? 24 : 27;
  // require the family partition and exact index bound
  if (value.chunkCount !== expectedChunkCount || chunkIndex >= expectedChunkCount) {
    throw new Error("adjustment chunk authorization range mismatch");
  }
  // validate every immutable authorization root
  for (const [candidate, label] of [
    [value.eligiblePredictionSetSha256, "eligible prediction set identity"],
    [value.expectedKeySetSha256, "expected key set identity"],
    [value.metadataRootSha256, "metadata root identity"],
    [value.revisionCatalogWatermarkSha256, "revision catalog watermark"],
    [value.targetComparatorSnapshotRootSha256, "target comparator snapshot root"],
  ] as const) {
    requireHash(candidate, label);
  }
  const fromDate = parseLocalDate(value.fromLocalDate, "chunk start date");
  const toDate = parseLocalDate(value.toLocalDateExclusive, "chunk end date");
  parseUtcMilliseconds(value.targetCutoffAt, "target cutoff");
  // require a nonempty bounded local-date range
  if (toDate <= fromDate || toDate - fromDate > 14 * 24 * HOUR_MS) {
    throw new Error("adjustment chunk authorization dates are invalid");
  }
}

// require one exact JSON object
function requireExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  // reject arrays, null, aliases, and missing keys
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new RangeError(`${label} is not a closed object`);
  }
}

// encode one flat closed object with sorted keys
function canonicalFlatJson(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string {
  const canonical = JSON.stringify(Object.fromEntries(
    [...keys].sort().map((key) => [key, value[key]]),
  ));
  // enforce the fixed canonical input envelope
  if (Buffer.byteLength(canonical, "utf8") > MAX_INPUT_BYTES) {
    throw new RangeError(`${label} exceeds the canonical byte bound`);
  }
  return canonical;
}

// require one lowercase SHA-256 identity
function requireHash(value: unknown, label: string): asserts value is string {
  // reject aliases and non-string identities
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

// parse one canonical millisecond UTC instant
function parseUtcMilliseconds(value: unknown, label: string): number {
  // reject offsets, normalized aliases, and invalid calendar clocks
  if (typeof value !== "string" || !UTC_MILLISECOND_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError(`${label} is not canonical UTC milliseconds`);
  }
  return Date.parse(value);
}

// parse one fixed cycle due key
function parseDueKey(value: unknown): number {
  // reject non-cycle and noncanonical due identities
  if (typeof value !== "string" || !DUE_KEY_PATTERN.test(value)) {
    throw new RangeError("adjustment due key is invalid");
  }
  return parseUtcMilliseconds(value.slice("capture/".length), "adjustment due time");
}

// parse one exact local calendar date
function parseLocalDate(value: unknown, label: string): number {
  // reject normalized aliases and invalid calendar dates
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${label} is invalid`);
  }
  return Date.parse(`${value}T00:00:00.000Z`);
}

// require one bounded integer
function requireInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  // reject fractions, unsafe integers, and out-of-range counts
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
}

// require one known adjustment family
function isFamily(value: unknown): value is AdjustmentShadowFamily {
  return value === "temperature" || value === "wind" || value === "rain";
}

// require one bounded JSON result
function requireBoundedJson(value: Record<string, unknown>, maximum: number, label: string): void {
  // reject oversized server receipts before returning them
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new Error(`${label} exceeds its server receipt bound`);
  }
}

// require one JSON result row
function requireSingleJsonRow(rows: readonly JsonRow[], label: string): Record<string, unknown> {
  const value = rows[0]?.value;
  // reject missing, duplicate, scalar, or array results
  if (rows.length !== 1 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} contract mismatch`);
  }
  return value as Record<string, unknown>;
}
