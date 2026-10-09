import { createHash } from "node:crypto";

import type {
  ForecastAdjustmentCandidateV2,
  ForecastAdjustmentForecastIdentity,
  JsonValue,
} from "@weather/domain";
import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  canonicalJsonBytes,
  canonicalSha256,
  canonicalObjectSha256,
  deepFreeze,
  verifyForecastAdjustmentCandidate,
} from "./candidate.js";
import { verifyDevelopmentReport, type ForecastAdjustmentDevelopmentReportV1 } from "./evaluate.js";
import type { TemperatureMosPermanentRuntimeModel } from "./temperature-mos-runtime.js";
import { ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT } from "./maintenance-revision-projection.js";

export const FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION =
  "forecast-adjustment-maintenance-runtime-package/v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const COMMON_KEYS = ["bundleSha256", "candidateSha256", "contractVersion", "dueMonth", "family", "source"];
const TEMPERATURE_KEYS = [...COMMON_KEYS, "model"];
const WIND_KEYS = [...COMMON_KEYS, "candidate"];
const TEMPERATURE_MODEL_KEYS = ["adaptiveCoefficients", "cohort", "contractVersion", "directCoefficients",
  "effectiveFrom", "latestTrainingValidAt", "learnedStrengthContractVersion", "scope", "strengthBands", "supported",
  "trainingCutoffUtc"];
const TEMPERATURE_SOURCE = Object.freeze({
  adapterVersion: "open-meteo-ecmwf-single-run/v1",
  cohort: "ecmwf_single_run_hindcast",
  dataset: "single_run",
  maximumReceiptAgeHours: 12,
  providerKey: "open-meteo",
  scope: "assumed_delay6_next12",
  sourceDelayHours: 6,
  upstreamModel: "ecmwf_ifs",
} as const);
const RAIN_SOURCE = Object.freeze({
  contractVersion: "forecast-adjustment-rain-maintenance-source-identity/v1",
  forecast: {
    adapterVersion: "open-meteo-rain-capture/v1",
    contractEpoch: RAIN_COLLECTION_POLICY.contractVersion,
    dataset: "ecmwf_ifs",
    providerKey: "open-meteo-single-runs",
    sourceConfigFingerprint: ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT,
    sourceKey: "rain-prospective-forecast",
    upstreamModel: "ecmwf_ifs",
  },
  policy: RAIN_COLLECTION_POLICY,
  stations: RAIN_COLLECTION_STATIONS,
} as const);

export interface ForecastAdjustmentTemperatureMaintenanceRuntimePackage {
  readonly bundleSha256: string;
  readonly candidateSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION;
  readonly dueMonth: string;
  readonly family: "temperature";
  readonly model: TemperatureMosPermanentRuntimeModel;
  readonly source: typeof TEMPERATURE_SOURCE;
}

export interface ForecastAdjustmentWindMaintenanceRuntimePackage {
  readonly bundleSha256: string;
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly candidateSha256: string;
  readonly contractVersion: typeof FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION;
  readonly dueMonth: string;
  readonly family: "wind";
  readonly source: ForecastAdjustmentForecastIdentity;
}

export type ForecastAdjustmentMaintenanceRuntimePackage =
  | ForecastAdjustmentTemperatureMaintenanceRuntimePackage
  | ForecastAdjustmentWindMaintenanceRuntimePackage;

// derive the fixed deployed ECMWF source identity for temperature registration
export function forecastAdjustmentTemperatureMaintenanceSourceIdentitySha256(): string {
  return canonicalSha256(TEMPERATURE_SOURCE as unknown as JsonValue);
}

// derive the exact fitted raw-forecast identity for wind registration
export function forecastAdjustmentWindMaintenanceSourceIdentitySha256(
  candidate: ForecastAdjustmentCandidateV2,
): string {
  verifyForecastAdjustmentCandidate(candidate);
  validateWindCandidate(candidate);
  return canonicalSha256(candidate.forecastIdentity as unknown as JsonValue);
}

// derive the actual fixed capture policy, provider and station identity for rain registration
export function forecastAdjustmentRainMaintenanceSourceIdentitySha256(): string {
  return canonicalSha256(RAIN_SOURCE as unknown as JsonValue);
}

// transform one canonical monthly fit into an authority-free portable runtime
export function buildForecastAdjustmentMaintenanceRuntimePackage(
  candidateBytes: Uint8Array,
): ForecastAdjustmentMaintenanceRuntimePackage {
  const bytes = Buffer.from(candidateBytes);
  const fit = parseCanonicalObject(bytes, "maintenance fit");
  const candidateSha256 = sha256(bytes);
  let unsigned:
    | Omit<ForecastAdjustmentTemperatureMaintenanceRuntimePackage, "bundleSha256">
    | Omit<ForecastAdjustmentWindMaintenanceRuntimePackage, "bundleSha256">;
  // project only the selected portable temperature parameters
  if (fit.contractVersion === "temperature-maintenance-fit/v2") {
    exactKeys(fit, ["arms", "confirmationOpened", "contractVersion", "developmentIncumbentMae",
      "developmentRawMae", "dueMonth", "model", "selectedArm", "servingChanged", "state"],
    "temperature maintenance fit");
    if (fit.state !== "development_candidate" || fit.confirmationOpened !== false ||
        fit.servingChanged !== false || typeof fit.selectedArm !== "string" ||
        !MONTH.test(String(fit.dueMonth))) {
      throw new RangeError("temperature maintenance fit is not selected");
    }
    validateTemperatureModel(fit.model, String(fit.dueMonth));
    unsigned = {
      candidateSha256,
      contractVersion: FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION,
      dueMonth: String(fit.dueMonth),
      family: "temperature",
      model: structuredClone(fit.model) as TemperatureMosPermanentRuntimeModel,
      source: TEMPERATURE_SOURCE,
    };
  } else if (fit.contractVersion === "wind-maintenance-fit/v2") {
    exactKeys(fit, ["candidate", "confirmationOpened", "contractVersion", "developmentReport", "dueMonth", "state"],
      "wind maintenance fit");
    if (fit.state !== "development_candidate" || fit.confirmationOpened !== false ||
        !MONTH.test(String(fit.dueMonth))) {
      throw new RangeError("wind maintenance fit is not selected");
    }
    const candidate = fit.candidate as unknown as ForecastAdjustmentCandidateV2;
    const report = fit.developmentReport as unknown as ForecastAdjustmentDevelopmentReportV1;
    verifyForecastAdjustmentCandidate(candidate);
    verifyDevelopmentReport(report);
    // bind the fitted runtime to its complete development report
    if (candidate.developmentReportSha256 !== report.developmentReportSha256) {
      throw new RangeError("wind maintenance development report differs");
    }
    validateWindCandidate(candidate);
    unsigned = {
      candidate: structuredClone(candidate),
      candidateSha256,
      contractVersion: FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION,
      dueMonth: String(fit.dueMonth),
      family: "wind",
      source: structuredClone(candidate.forecastIdentity),
    };
  } else {
    throw new RangeError("maintenance fit family is invalid");
  }
  const bundleSha256 = canonicalObjectSha256(unsigned as unknown as Readonly<Record<string, unknown>>, "bundleSha256");
  const runtimePackage = deepFreeze({ ...unsigned, bundleSha256 }) as ForecastAdjustmentMaintenanceRuntimePackage;
  verifyForecastAdjustmentMaintenanceRuntimePackage(runtimePackage);
  return runtimePackage;
}

// verify one closed portable development runtime without granting serving authority
export function verifyForecastAdjustmentMaintenanceRuntimePackage(
  value: ForecastAdjustmentMaintenanceRuntimePackage,
): void {
  exactKeys(value, value.family === "temperature" ? TEMPERATURE_KEYS : WIND_KEYS,
    "maintenance runtime package");
  // require one canonical family, fit identity and self-addressed runtime
  if (value.contractVersion !== FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION ||
      !["temperature", "wind"].includes(value.family) || !MONTH.test(value.dueMonth) ||
      !HASH.test(value.candidateSha256) || !HASH.test(value.bundleSha256) ||
      canonicalObjectSha256(value as unknown as Readonly<Record<string, unknown>>, "bundleSha256") !==
        value.bundleSha256) {
    throw new RangeError("maintenance runtime package identity differs");
  }
  // validate the selected family material and exact live-source identity
  if (value.family === "temperature") {
    validateTemperatureModel(value.model, value.dueMonth);
    if (canonicalJsonBytes(value.source as unknown as JsonValue) !==
        canonicalJsonBytes(TEMPERATURE_SOURCE as unknown as JsonValue)) {
      throw new RangeError("temperature maintenance source differs");
    }
    return;
  }
  verifyForecastAdjustmentCandidate(value.candidate);
  validateWindCandidate(value.candidate);
  if (canonicalJsonBytes(value.source as unknown as JsonValue) !==
      canonicalJsonBytes(value.candidate.forecastIdentity as unknown as JsonValue)) {
    throw new RangeError("wind maintenance source differs");
  }
}

// encode one already-verified package in its unique public representation
export function encodeForecastAdjustmentMaintenanceRuntimePackage(
  value: ForecastAdjustmentMaintenanceRuntimePackage,
): Buffer {
  verifyForecastAdjustmentMaintenanceRuntimePackage(value);
  return Buffer.from(canonicalJsonBytes(value as unknown as JsonValue));
}

// require the fixed thirteen supported wind pairs
function validateWindCandidate(candidate: ForecastAdjustmentCandidateV2): void {
  const pairs = candidate.enabledMetricBands.map((pair) => `${pair.metric}:${pair.leadBand}`);
  // exclude direction and the intentionally unsupported gust 49-72 band
  if (pairs.length !== 13 || new Set(pairs).size !== 13 || pairs.some((pair) =>
    pair.startsWith("windDirectionDegrees:") || pair === "windGustMps:049-072")) {
    throw new RangeError("wind maintenance candidate bands differ");
  }
}

// validate the selected permanent temperature model material
function validateTemperatureModel(value: unknown, dueMonth: string): asserts value is TemperatureMosPermanentRuntimeModel {
  exactKeys(value, TEMPERATURE_MODEL_KEYS, "temperature maintenance model");
  const model = value as unknown as Record<string, unknown>;
  // require the exact selected delayed-source runtime family
  if (model.contractVersion !== "temperature-permanent-model/v1" || model.cohort !== "ecmwf_single_run_hindcast" ||
      model.scope !== "assumed_delay6_next12" || model.learnedStrengthContractVersion !==
        "temperature-winner-extensions-research/v1" || model.supported !== true ||
      !finiteVector(model.adaptiveCoefficients, 49) || !finiteVector(model.directCoefficients, 35) ||
      !validInstant(model.effectiveFrom) || !validInstant(model.latestTrainingValidAt) ||
      !validInstant(model.trainingCutoffUtc) || !String(model.effectiveFrom).startsWith(`${dueMonth}-`)) {
    throw new RangeError("temperature maintenance model differs");
  }
  exactKeys(model.strengthBands, ["1-6", "7-12"], "temperature maintenance strength bands");
  // require both selected strength bands and their causal cutoff clocks
  for (const key of ["1-6", "7-12"] as const) {
    const band = (model.strengthBands as Record<string, unknown>)[key];
    exactKeys(band, ["alpha", "supported", "trainingCutoffUtc"], "temperature maintenance strength band");
    const material = band as Record<string, unknown>;
    if (![0.35, 0.5, 0.65, 0.8, 1].includes(Number(material.alpha)) || material.supported !== true ||
        !validInstant(material.trainingCutoffUtc) || Date.parse(String(material.trainingCutoffUtc)) >=
          Date.parse(String(model.effectiveFrom))) {
      throw new RangeError("temperature maintenance strength band differs");
    }
  }
}

// test one fixed-width finite coefficient vector
function finiteVector(value: unknown, width: number): boolean {
  return Array.isArray(value) && value.length === width && value.every(
    // reject nonnumeric or nonfinite parameters
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
}

// parse exact canonical object bytes
function parseCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  // prohibit alternate bytes, arrays and extension prototypes
  if (!record(value) || Buffer.from(canonicalJsonBytes(value as JsonValue)).compare(bytes) !== 0) {
    throw new RangeError(`${label} is not canonical`);
  }
  return value;
}

// require one exact object key set
function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  // reject arrays and extension fields
  if (!record(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new RangeError(`${label} fields differ`);
  }
}

// identify one plain decoded object
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// test one canonical utc-millisecond instant
function validInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

// hash exact candidate bytes
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
