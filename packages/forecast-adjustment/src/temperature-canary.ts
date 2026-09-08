import type { JsonValue } from "@weather/domain";

import {
  canonicalObjectSha256,
  canonicalSha256,
  deepFreeze,
} from "./candidate.js";
import { runtimeCalendarFingerprintMatches } from "./calendar.js";
import {
  TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY,
  applyEcmwfTemperatureMosRuntime,
  type TemperatureMosRuntimeModel,
  type TemperatureMosRuntimeRawReason,
  type TemperatureMosRuntimeRecentErrorState,
} from "./temperature-mos-runtime.js";

export const TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION =
  "forecast-adjustment-temperature-canary-bundle/v1" as const;
export const TEMPERATURE_CANARY_REGISTRY_CONTRACT_VERSION =
  "forecast-adjustment-temperature-canary-registry/v1" as const;
export const TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION =
  "forecast-temperature-canary-decision/v1" as const;
export const TEMPERATURE_CANARY_MAXIMUM_DURATION_MS =
  14 * 24 * 60 * 60 * 1_000;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const BUNDLE_KEYS = [
  "artifactKind",
  "authorization",
  "bundleSha256",
  "contractVersion",
  "evidence",
  "model",
  "runtimeFingerprint",
  "servedForecastIdentity",
  "siteKey",
  "timezone",
  "trainingForecastIdentity",
] as const;
const AUTHORIZATION_KEYS = [
  "activatedAt",
  "authorizationReason",
  "authorizationSha256",
  "authorized",
  "authorizedAt",
  "authorizedBy",
  "expiresAt",
] as const;
const EVIDENCE_KEYS = [
  "modelSourceSha256",
  "researchSummarySha256",
  "retentionManifestSha256",
  "strengthSourceSha256",
] as const;
const RUNTIME_FINGERPRINT_KEYS = ["icuVersion", "tzdataVersion"] as const;
const SERVED_IDENTITY_KEYS = [
  "adapterVersion",
  "dataset",
  "maximumReceiptAgeHours",
  "providerKey",
  "sourceDelayHours",
  "upstreamModel",
] as const;
const TRAINING_IDENTITY_KEYS = ["cohort", "scope"] as const;
const MODEL_KEYS = [
  "adaptiveCoefficients",
  "cohort",
  "contractVersion",
  "directCoefficients",
  "learnedStrengthContractVersion",
  "month",
  "scope",
  "strengthBands",
  "supported",
  "trainingCutoffUtc",
] as const;
const STRENGTH_KEYS = ["alpha", "supported", "trainingCutoffUtc"] as const;
const REGISTRY_KEYS = ["activeBundle", "contractVersion"] as const;
const ACTIVE_REGISTRY_KEYS = [
  "authorizationSha256",
  "bundleSha256",
  "modelSourceSha256",
  "path",
  "strengthSourceSha256",
] as const;

export interface ForecastAdjustmentTemperatureCanaryAuthorizationV1 {
  readonly activatedAt: string;
  readonly authorizationReason: string;
  readonly authorizationSha256: string;
  readonly authorized: true;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly expiresAt: string;
}

export interface ForecastAdjustmentTemperatureCanaryRuntimeBundleV1 {
  readonly artifactKind: "ecmwf_temperature_transfer_canary";
  readonly authorization: ForecastAdjustmentTemperatureCanaryAuthorizationV1;
  readonly bundleSha256: string;
  readonly contractVersion: typeof TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION;
  readonly evidence: {
    readonly modelSourceSha256: string;
    readonly researchSummarySha256: string;
    readonly retentionManifestSha256: string;
    readonly strengthSourceSha256: string;
  };
  readonly model: TemperatureMosRuntimeModel;
  readonly runtimeFingerprint: {
    readonly icuVersion: string;
    readonly tzdataVersion: string;
  };
  readonly servedForecastIdentity: {
    readonly adapterVersion: "open-meteo-ecmwf-single-run/v1";
    readonly dataset: "single_run";
    readonly maximumReceiptAgeHours: number;
    readonly providerKey: "open-meteo";
    readonly sourceDelayHours: 6;
    readonly upstreamModel: "ecmwf_ifs";
  };
  readonly siteKey: "ballydidean";
  readonly timezone: "America/Los_Angeles";
  readonly trainingForecastIdentity: {
    readonly cohort: "ecmwf_single_run_hindcast";
    readonly scope: "assumed_delay6_next12";
  };
}

export interface ForecastAdjustmentTemperatureCanaryRegistryV1 {
  readonly activeBundle: null | {
    readonly authorizationSha256: string;
    readonly bundleSha256: string;
    readonly modelSourceSha256: string;
    readonly path: string;
    readonly strengthSourceSha256: string;
  };
  readonly contractVersion: typeof TEMPERATURE_CANARY_REGISTRY_CONTRACT_VERSION;
}

export type LoadedForecastAdjustmentTemperatureCanaryRuntimeV1 =
  | {
      readonly bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1;
      readonly reasonCode: null;
      readonly state: "active";
    }
  | {
      readonly bundle: null;
      readonly reasonCode:
        | "bundle_invalid"
        | "bundle_missing"
        | "canary_expired"
        | "canary_killed"
        | "registry_inactive"
        | "registry_invalid";
      readonly state: "disabled";
    };

export interface TemperatureCanarySourceForecast {
  readonly adapterVersion: string;
  readonly dataset: "single_run";
  readonly firstReceivedAt: string;
  readonly modelCycle: "49r1" | "50r1";
  readonly modelLeadHours: number;
  readonly providerKey: "open-meteo";
  readonly providerResponseSha256: string;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawTemperatureC: number;
  readonly rawWindSpeedMps: number | null;
  readonly runInitializedAt: string;
  readonly upstreamModel: "ecmwf_ifs";
  readonly validAt: string;
}

export type TemperatureCanaryDecisionReason =
  | LoadedForecastAdjustmentTemperatureCanaryRuntimeV1["reasonCode"]
  | TemperatureMosRuntimeRawReason
  | "canary_expired"
  | "missing_source_forecast"
  | "outside_operational_window"
  | "source_identity_mismatch"
  | "source_not_available"
  | "source_stale"
  | "source_time_mismatch";

export interface ForecastTemperatureCanaryDecisionV1 {
  readonly branch: "adaptive" | "direct" | null;
  readonly bundleSha256: string | null;
  readonly contractVersion: typeof TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION;
  readonly correctedTemperatureC: number | null;
  readonly rawBestMatchTemperatureC: number | null;
  readonly reasonCode: TemperatureCanaryDecisionReason;
  readonly recentErrorStateSha256: string | null;
  readonly sourceForecast: null | TemperatureCanarySourceForecast & {
    readonly operationalHorizonHours: number;
  };
  readonly state: "active" | "disabled" | "raw_fallback";
}

export interface ApplyTemperatureCanaryInputV1 {
  readonly evaluatedAt: string;
  readonly rawBestMatchTemperatureC: number | null;
  readonly recentErrorState: TemperatureMosRuntimeRecentErrorState | null;
  readonly sourceForecast: TemperatureCanarySourceForecast | null;
  readonly validAt: string;
}

// carry one public fail-raw classification
class TemperatureCanaryFailure extends Error {
  readonly reasonCode: Exclude<TemperatureCanaryDecisionReason, null>;

  // retain the exact bounded reason
  constructor(reasonCode: Exclude<TemperatureCanaryDecisionReason, null>) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

// create one short-lived immutable canary authorization
export function createForecastAdjustmentTemperatureCanaryAuthorization(input: {
  readonly activatedAt: string;
  readonly authorizationReason: string;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly expiresAt: string;
}): ForecastAdjustmentTemperatureCanaryAuthorizationV1 {
  const unsigned = {
    activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
    authorizationReason: validateText(
      input.authorizationReason,
      "authorizationReason",
    ),
    authorized: true as const,
    authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
    authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
    expiresAt: validateUtcInstant(input.expiresAt, "expiresAt"),
  };
  const authorization = deepFreeze({
    ...unsigned,
    authorizationSha256: canonicalSha256(unsigned as unknown as JsonValue),
  });
  validateAuthorization(authorization);
  return authorization;
}

// create one content-addressed sanitized canary bundle
export function createForecastAdjustmentTemperatureCanaryRuntimeBundle(input: {
  readonly authorization: ForecastAdjustmentTemperatureCanaryAuthorizationV1;
  readonly evidence: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1["evidence"];
  readonly model: TemperatureMosRuntimeModel;
  readonly runtimeFingerprint: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1["runtimeFingerprint"];
  readonly servedForecastIdentity: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1["servedForecastIdentity"];
}): ForecastAdjustmentTemperatureCanaryRuntimeBundleV1 {
  const unsigned = {
    artifactKind: "ecmwf_temperature_transfer_canary" as const,
    authorization: cloneJson(input.authorization),
    contractVersion: TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION,
    evidence: cloneJson(input.evidence),
    model: cloneJson(input.model),
    runtimeFingerprint: cloneJson(input.runtimeFingerprint),
    servedForecastIdentity: cloneJson(input.servedForecastIdentity),
    siteKey: "ballydidean" as const,
    timezone: "America/Los_Angeles" as const,
    trainingForecastIdentity: {
      cohort: "ecmwf_single_run_hindcast" as const,
      scope: "assumed_delay6_next12" as const,
    },
  };
  const bundle = deepFreeze({
    ...unsigned,
    bundleSha256: canonicalSha256(unsigned as unknown as JsonValue),
  });
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
  return bundle;
}

// verify the closed sanitized model and authorization envelope
export function verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(
  bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1,
): void {
  requireExactKeys(bundle, BUNDLE_KEYS, "temperature canary bundle");

  // bind the separate transfer-canary identity
  if (
    bundle.artifactKind !== "ecmwf_temperature_transfer_canary" ||
    bundle.contractVersion !== TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION ||
    bundle.siteKey !== "ballydidean" ||
    bundle.timezone !== "America/Los_Angeles"
  ) {
    throw new RangeError("temperature canary bundle identity mismatch");
  }

  validateHash(bundle.bundleSha256, "bundleSha256");
  validateAuthorization(bundle.authorization);
  requireExactKeys(bundle.evidence, EVIDENCE_KEYS, "temperature canary evidence");

  // require immutable evidence identities
  for (const [key, value] of Object.entries(bundle.evidence)) {
    validateHash(value, key);
  }

  requireExactKeys(
    bundle.runtimeFingerprint,
    RUNTIME_FINGERPRINT_KEYS,
    "temperature canary runtime fingerprint",
  );
  validateText(bundle.runtimeFingerprint.icuVersion, "icuVersion");
  validateText(bundle.runtimeFingerprint.tzdataVersion, "tzdataVersion");
  requireExactKeys(
    bundle.servedForecastIdentity,
    SERVED_IDENTITY_KEYS,
    "temperature canary served identity",
  );

  // bind live serving to one explicit single-runs source
  if (
    bundle.servedForecastIdentity.dataset !== "single_run" ||
    bundle.servedForecastIdentity.adapterVersion !==
      "open-meteo-ecmwf-single-run/v1" ||
    bundle.servedForecastIdentity.providerKey !== "open-meteo" ||
    bundle.servedForecastIdentity.upstreamModel !== "ecmwf_ifs" ||
    bundle.servedForecastIdentity.sourceDelayHours !== 6 ||
    !Number.isInteger(bundle.servedForecastIdentity.maximumReceiptAgeHours) ||
    bundle.servedForecastIdentity.maximumReceiptAgeHours < 6 ||
    bundle.servedForecastIdentity.maximumReceiptAgeHours > 12
  ) {
    throw new RangeError("temperature canary served identity mismatch");
  }

  requireExactKeys(
    bundle.trainingForecastIdentity,
    TRAINING_IDENTITY_KEYS,
    "temperature canary training identity",
  );

  // disclose the exact hindcast-to-live transfer boundary
  if (
    bundle.trainingForecastIdentity.cohort !== "ecmwf_single_run_hindcast" ||
    bundle.trainingForecastIdentity.scope !== "assumed_delay6_next12"
  ) {
    throw new RangeError("temperature canary training identity mismatch");
  }

  validateSanitizedModel(bundle.model);

  // reject any nested or outer substitution
  if (
    canonicalObjectSha256(
      bundle as unknown as Readonly<Record<string, unknown>>,
      "bundleSha256",
    ) !== bundle.bundleSha256
  ) {
    throw new RangeError("temperature canary bundle SHA-256 mismatch");
  }
}

// validate one content-addressed registry selection
export function validateForecastAdjustmentTemperatureCanaryRegistry(
  registry: ForecastAdjustmentTemperatureCanaryRegistryV1,
): void {
  requireExactKeys(registry, REGISTRY_KEYS, "temperature canary registry");

  // isolate the registry contract
  if (registry.contractVersion !== TEMPERATURE_CANARY_REGISTRY_CONTRACT_VERSION) {
    throw new RangeError("unsupported temperature canary registry contract");
  }

  // permit an intentionally inactive registry
  if (registry.activeBundle === null) {
    return;
  }

  const active = registry.activeBundle;
  requireExactKeys(active, ACTIVE_REGISTRY_KEYS, "temperature canary active bundle");
  validateHash(active.authorizationSha256, "authorizationSha256");
  validateHash(active.bundleSha256, "bundleSha256");
  validateHash(active.modelSourceSha256, "modelSourceSha256");
  validateHash(active.strengthSourceSha256, "strengthSourceSha256");

  // require the one closed relative bundle path
  if (
    active.path !==
      `temperature-canary-bundles/sha256-${active.bundleSha256}.json`
  ) {
    throw new RangeError("temperature canary registry path is invalid");
  }
}

// validate registry links without tolerating substituted evidence
export function validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks(
  registry: ForecastAdjustmentTemperatureCanaryRegistryV1,
  bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1,
): void {
  validateForecastAdjustmentTemperatureCanaryRegistry(registry);
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);

  // require one active exact selection
  if (registry.activeBundle === null) {
    throw new RangeError("temperature canary registry has no active bundle");
  }

  const active = registry.activeBundle;

  // bind every selected identity to bundle content
  if (
    active.bundleSha256 !== bundle.bundleSha256 ||
    active.authorizationSha256 !== bundle.authorization.authorizationSha256 ||
    active.modelSourceSha256 !== bundle.evidence.modelSourceSha256 ||
    active.strengthSourceSha256 !== bundle.evidence.strengthSourceSha256
  ) {
    throw new RangeError("temperature canary registry cross-link mismatch");
  }
}

// report whether one instant remains inside authorization
export function forecastAdjustmentTemperatureCanaryIsActiveAt(
  bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1,
  now: string,
): boolean {
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
  const instant = Date.parse(validateUtcInstant(now, "now"));
  return (
    instant >= Date.parse(bundle.authorization.activatedAt) &&
    instant < Date.parse(bundle.authorization.expiresAt)
  );
}

// default closed unless the operator explicitly enables the canary
export function forecastAdjustmentTemperatureCanaryIsKilled(
  environmentValue: string | undefined,
): boolean {
  return environmentValue !== "0";
}

// apply one independent live-source temperature decision
export function applyForecastAdjustmentTemperatureCanary(
  runtime: LoadedForecastAdjustmentTemperatureCanaryRuntimeV1,
  input: ApplyTemperatureCanaryInputV1,
): ForecastTemperatureCanaryDecisionV1 {
  // keep loader failures separate from forecast availability
  if (runtime.state === "disabled") {
    return fallbackDecision(input.rawBestMatchTemperatureC, "disabled", runtime.reasonCode);
  }

  const source = input.sourceForecast;

  // fail raw when the sidecar has no matching hour
  if (source === null || input.recentErrorState === null) {
    return fallbackDecision(
      input.rawBestMatchTemperatureC,
      "raw_fallback",
      "missing_source_forecast",
      runtime.bundle.bundleSha256,
    );
  }

  try {
    validateUtcInstant(input.evaluatedAt, "evaluatedAt");
    validateUtcInstant(input.validAt, "validAt");

    // recheck authorization per request after startup caching
    if (!forecastAdjustmentTemperatureCanaryIsActiveAt(runtime.bundle, input.evaluatedAt)) {
      return fallbackDecision(
        input.rawBestMatchTemperatureC,
        "disabled",
        "canary_expired",
      );
    }

    validateSourceForecast(runtime.bundle, source, input);
    const operationalHorizonHours =
      source.modelLeadHours -
      runtime.bundle.servedForecastIdentity.sourceDelayHours;
    const sourceForecast = deepFreeze({ ...source, operationalHorizonHours });
    const recentErrorStateSha256 = canonicalSha256(
      input.recentErrorState as unknown as JsonValue,
    );
    const result = applyEcmwfTemperatureMosRuntime({
      forecast: {
        cohort: runtime.bundle.trainingForecastIdentity.cohort,
        key: `${source.providerResponseSha256}:${source.validAt}`,
        modelCycle: source.modelCycle,
        modelLeadHours: source.modelLeadHours,
        rawRelativeHumidityPercent: source.rawRelativeHumidityPercent,
        rawTemperatureC: source.rawTemperatureC,
        rawWindSpeedMps: source.rawWindSpeedMps,
        runInitializedAt: source.runInitializedAt,
        validAt: source.validAt,
      },
      model: runtime.bundle.model,
      recentErrorState: input.recentErrorState,
    });

    // preserve raw when the numerical core rejects any input
    if (!result.applied) {
      return deepFreeze({
        branch: null,
        bundleSha256: runtime.bundle.bundleSha256,
        contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
        correctedTemperatureC: null,
        rawBestMatchTemperatureC: input.rawBestMatchTemperatureC,
        reasonCode: result.reason,
        recentErrorStateSha256,
        sourceForecast,
        state: "raw_fallback" as const,
      });
    }

    return deepFreeze({
      branch: result.branch,
      bundleSha256: runtime.bundle.bundleSha256,
      contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
      correctedTemperatureC: result.predictionTemperatureC,
      rawBestMatchTemperatureC: input.rawBestMatchTemperatureC,
      reasonCode: null,
      recentErrorStateSha256,
      sourceForecast,
      state: "active" as const,
    });
  } catch (error) {
    return fallbackDecision(
      input.rawBestMatchTemperatureC,
      "raw_fallback",
      error instanceof TemperatureCanaryFailure
        ? error.reasonCode
        : "source_identity_mismatch",
      runtime.bundle.bundleSha256,
    );
  }
}

// validate one truthful live source receipt
function validateSourceForecast(
  bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1,
  source: TemperatureCanarySourceForecast,
  input: ApplyTemperatureCanaryInputV1,
): void {
  const evaluatedAt = Date.parse(validateUtcInstant(input.evaluatedAt, "evaluatedAt"));
  const runInitializedAt = Date.parse(
    validateUtcInstant(source.runInitializedAt, "runInitializedAt"),
  );
  const firstReceivedAt = Date.parse(
    validateUtcInstant(source.firstReceivedAt, "firstReceivedAt"),
  );
  const validAt = Date.parse(validateUtcInstant(source.validAt, "source.validAt"));
  validateHash(source.providerResponseSha256, "providerResponseSha256");
  validateText(source.adapterVersion, "adapterVersion");

  // bind the live source to the served identity
  if (
    source.adapterVersion !== bundle.servedForecastIdentity.adapterVersion ||
    source.providerKey !== bundle.servedForecastIdentity.providerKey ||
    source.dataset !== bundle.servedForecastIdentity.dataset ||
    source.upstreamModel !== bundle.servedForecastIdentity.upstreamModel
  ) {
    throw new TemperatureCanaryFailure("source_identity_mismatch");
  }

  // bind this sidecar hour to exactly one requested public hour
  if (
    source.validAt !== input.validAt ||
    validAt - runInitializedAt !== source.modelLeadHours * 3_600_000
  ) {
    throw new TemperatureCanaryFailure("source_time_mismatch");
  }

  const assumedAvailableAt =
    runInitializedAt + bundle.servedForecastIdentity.sourceDelayHours * 3_600_000;
  const availableAt = Math.max(firstReceivedAt, assumedAvailableAt);
  const maximumReceiptAgeMilliseconds =
    bundle.servedForecastIdentity.maximumReceiptAgeHours * 3_600_000;

  // reject backdated, future, and stale acquisition receipts
  if (firstReceivedAt < runInitializedAt || evaluatedAt < availableAt) {
    throw new TemperatureCanaryFailure("source_not_available");
  }

  // reject a run after its bounded serving lifetime
  if (evaluatedAt - availableAt > maximumReceiptAgeMilliseconds) {
    throw new TemperatureCanaryFailure("source_stale");
  }

  // constrain serving to fitted future operational hours
  if (
    validAt <= evaluatedAt ||
    !Number.isInteger(source.modelLeadHours) ||
    source.modelLeadHours < 7 ||
    source.modelLeadHours > 18
  ) {
    throw new TemperatureCanaryFailure("outside_operational_window");
  }
}

// validate the sanitized exact-width delayed model
function validateSanitizedModel(model: TemperatureMosRuntimeModel): void {
  requireExactKeys(model, MODEL_KEYS, "temperature canary model");

  // prohibit other research scopes and unsupported material
  if (
    model.contractVersion !== "temperature-shortlead-models-research/v1" ||
    model.learnedStrengthContractVersion !==
      "temperature-winner-extensions-research/v1" ||
    model.cohort !== "ecmwf_single_run_hindcast" ||
    model.scope !== TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope ||
    model.supported !== true ||
    !/^\d{4}-\d{2}$/u.test(model.month)
  ) {
    throw new RangeError("temperature canary model identity mismatch");
  }

  validateUtcInstant(model.trainingCutoffUtc, "trainingCutoffUtc");
  validateCoefficientVector(model.directCoefficients, 35, "directCoefficients");
  validateCoefficientVector(model.adaptiveCoefficients, 49, "adaptiveCoefficients");

  // require only the two learned operational bands
  if (
    model.strengthBands === null ||
    typeof model.strengthBands !== "object" ||
    Object.keys(model.strengthBands).sort().join(",") !== "1-6,7-12"
  ) {
    throw new RangeError("temperature canary strength bands are invalid");
  }

  // bind learned strengths to the same fit cutoff
  for (const key of ["1-6", "7-12"] as const) {
    const band = model.strengthBands[key];
    requireExactKeys(band, STRENGTH_KEYS, `temperature strength ${key}`);

    // accept only the retained fully supported learned winner
    if (
      band.supported !== true ||
      band.alpha !== 1 ||
      band.trainingCutoffUtc !== model.trainingCutoffUtc
    ) {
      throw new RangeError("temperature canary strength band mismatch");
    }
  }
}

// validate one exact finite coefficient payload
function validateCoefficientVector(
  value: readonly number[] | null,
  width: number,
  description: string,
): void {
  // reject absent, extra, or nonfinite model content
  if (
    !Array.isArray(value) ||
    value.length !== width ||
    value.some((coefficient) => !Number.isFinite(coefficient))
  ) {
    throw new RangeError(`${description} is invalid`);
  }
}

// validate one short-lived authorization receipt
function validateAuthorization(
  authorization: ForecastAdjustmentTemperatureCanaryAuthorizationV1,
): void {
  requireExactKeys(authorization, AUTHORIZATION_KEYS, "temperature authorization");
  validateHash(authorization.authorizationSha256, "authorizationSha256");
  validateText(authorization.authorizedBy, "authorizedBy");
  validateText(authorization.authorizationReason, "authorizationReason");
  const authorizedAt = Date.parse(
    validateUtcInstant(authorization.authorizedAt, "authorizedAt"),
  );
  const activatedAt = Date.parse(
    validateUtcInstant(authorization.activatedAt, "activatedAt"),
  );
  const expiresAt = Date.parse(validateUtcInstant(authorization.expiresAt, "expiresAt"));

  // require explicit authority and no more than fourteen days
  if (
    authorization.authorized !== true ||
    authorizedAt > activatedAt ||
    expiresAt <= activatedAt ||
    expiresAt - activatedAt > TEMPERATURE_CANARY_MAXIMUM_DURATION_MS
  ) {
    throw new RangeError("temperature canary authorization window is invalid");
  }

  // reject authorization mutation
  if (
    canonicalObjectSha256(
      authorization as unknown as Readonly<Record<string, unknown>>,
      "authorizationSha256",
    ) !== authorization.authorizationSha256
  ) {
    throw new RangeError("temperature canary authorization SHA-256 mismatch");
  }
}

// create one schema-complete raw decision
function fallbackDecision(
  rawBestMatchTemperatureC: number | null,
  state: "disabled" | "raw_fallback",
  reasonCode: TemperatureCanaryDecisionReason,
  bundleSha256: string | null = null,
): ForecastTemperatureCanaryDecisionV1 {
  return deepFreeze({
    branch: null,
    bundleSha256,
    contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
    correctedTemperatureC: null,
    rawBestMatchTemperatureC,
    reasonCode,
    recentErrorStateSha256: null,
    sourceForecast: null,
    state,
  });
}

// require one exact closed object schema
function requireExactKeys(
  value: object,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();

  // reject missing or added fields
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new RangeError(`${description} has unexpected fields`);
  }
}

// validate one lowercase content hash
function validateHash(value: string, description: string): string {
  // reject malformed immutable identities
  if (!HASH_PATTERN.test(value)) {
    throw new RangeError(`${description} must be a SHA-256 hex value`);
  }

  return value;
}

// validate one bounded public or operator label
function validateText(value: string, description: string): string {
  // reject empty, unbounded, or credential-like material
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 256 ||
    /[\r\n]|:\/\/|\b(?:credential|password|private[-_ ]?key|secret|token)\b/iu.test(
      value,
    )
  ) {
    throw new RangeError(`${description} must be bounded nonempty text`);
  }

  return value;
}

// validate one canonical utc instant
function validateUtcInstant(value: string, description: string): string {
  const milliseconds = Date.parse(value);

  // require exact millisecond utc serialization
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${description} must be a canonical UTC instant`);
  }

  return value;
}

// clone one immutable json value
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// expose loader fingerprint validation without model leakage
export function temperatureCanaryRuntimeFingerprintMatches(
  bundle: ForecastAdjustmentTemperatureCanaryRuntimeBundleV1,
): boolean {
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
  return runtimeCalendarFingerprintMatches(bundle.runtimeFingerprint);
}
