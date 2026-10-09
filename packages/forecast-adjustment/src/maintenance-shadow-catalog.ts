import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { JsonValue } from "@weather/domain";

import { canonicalJsonBytes } from "./candidate.js";
import {
  FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION,
  verifyForecastAdjustmentMaintenanceRuntimePackage,
  type ForecastAdjustmentMaintenanceRuntimePackage,
} from "./maintenance-runtime-package.js";
import { validateRainHurdleWindPortableArtifact } from "./rain-hurdle-wind.js";
import {
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
  type RainMaintenanceControlState,
} from "./rain-maintenance-controls.js";

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const RELEASE = /^\d{4}\.\d{2}\.\d{2}-[1-9]\d{0,2}$/u;
const CATALOG_KEYS = ["contractVersion", "entries"] as const;
const ENTRY_V1_KEYS = ["family", "receipt", "registration"] as const;
const ENTRY_V2_KEYS = ["family", "receipt", "registration", "slot"] as const;
const CONTROL_RECEIPT_KEYS = ["actionKind", "actionSha256", "contractVersion", "controlPlaneSha256",
  "controlStateSha256", "custodyAnchorSha256", "deployedCommit", "deployedImageDigest",
  "deployedRelease", "deployedSettingsSha256", "dueMonth", "fencingToken", "graphManifestSha256",
  "installedAt", "ordinalArtifactSha256", "sourceMemberRootSha256", "sourceReceiptRootSha256"] as const;
const CONTROL_ACTION_KEYS = ["actionKind", "contractVersion", "createdAt", "dueMonth",
  "expectedCatalogReceiptSha256", "expectedSettingsSha256", "expectedSourceCommit", "expectedSourceRelease",
  "family", "fencingToken", "graphManifestSha256", "ordinalArtifactSha256", "predecessorActionSha256",
  "reason", "controlStateSha256", "sourceMemberRootSha256", "sourceReceiptRootSha256", "validThrough"] as const;
const CONTROL_SELECTOR_KEYS = ["actionSha256", "contractVersion", "controlStatePath", "controlStateSha256",
  "dueMonth", "ordinalArtifactPath", "ordinalArtifactSha256", "siteKey"] as const;
const RECEIPT_V1_KEYS = ["contractVersion", "actionSha256", "registrationSha256", "candidateGraphSha256",
  "candidateSha256", "bundleSha256", "sourceSha256", "deployedCommit", "deployedRelease",
  "deployedImageDigest", "deployedSettingsSha256", "controlPlaneSha256", "fencingToken", "installedAt"] as const;
const RECEIPT_V2_KEYS = [...RECEIPT_V1_KEYS, "actionKind", "fullMemberRootSha256", "lifecycleHeadSha256",
  "policyDecision", "policyReportSha256"] as const;
const REGISTRATION_V2_KEYS = ["artifactSha256", "candidateSha256", "cohortSha256", "family", "intervalEndAt",
  "intervalStartAt", "policySha256", "registrationSha256", "reservedKeySha256", "siteKey", "sourceSha256",
  "targetCutoffAt", "terminalAt"] as const;
const REGISTRATION_V3_KEYS = [...REGISTRATION_V2_KEYS, "epochWitnessSha256",
  "predecessorRegistrationSha256", "scheduleContractSha256"] as const;
const REGISTRATION_V3_ONLY_KEYS = ["epochWitnessSha256", "predecessorRegistrationSha256",
  "scheduleContractSha256"] as const;
const ACTION_KEYS = ["actionKind", "candidateGraphSha256", "candidateSha256", "contractVersion", "createdAt",
  "expectedInstalledReceiptSha256", "expectedSettingsSha256", "expectedSourceCommit", "expectedSourceRelease",
  "family", "fencingToken",
  "fullMemberRootSha256", "lifecycleHeadSha256", "policyDecision", "policyReportSha256",
  "predecessorActionSha256", "reason", "reportCreatedAt", "siteKey", "validThrough"] as const;
const PROJECTION_KEYS = ["actionSha256", "artifactSha256", "bundleSha256", "candidateGraphSha256",
  "candidateSha256", "contractVersion", "family", "paritySha256", "registration", "siteKey"] as const;
const PARITY_KEYS = ["candidateSha256", "contractVersion", "family", "retainedInputSha256",
  "retainedNativeOutputSha256", "retainedPackagedOutputSha256", "syntheticInputSha256",
  "syntheticNativeOutputSha256", "syntheticPackagedOutputSha256"] as const;
const RAIN_PACKAGE_V1_KEYS = ["artifactPath", "artifactSha256", "candidateSha256", "compiledSourcePath",
  "compiledSourceSha256", "contractVersion", "modelMonth", "registrySha256"] as const;
const RAIN_PACKAGE_V2_KEYS = [...RAIN_PACKAGE_V1_KEYS, "controlStatePath", "controlStateSha256",
  "ordinalArtifactPath", "ordinalArtifactSha256"] as const;

export type InstalledMaintenanceShadowFamily = "temperature" | "wind" | "rain";

// mirror the shared value-free registration fields without a package cycle
interface InstalledMaintenanceShadowRegistrationBase<F extends InstalledMaintenanceShadowFamily> {
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

// retain the immutable finite-window registration shape
export interface InstalledMaintenanceShadowRegistrationV2<F extends InstalledMaintenanceShadowFamily>
  extends InstalledMaintenanceShadowRegistrationBase<F> {}

// bind one rolling registration to its future-only schedule lineage
export interface InstalledMaintenanceShadowRegistrationV3<F extends InstalledMaintenanceShadowFamily>
  extends InstalledMaintenanceShadowRegistrationBase<F> {
  readonly epochWitnessSha256: string;
  readonly predecessorRegistrationSha256: string | null;
  readonly scheduleContractSha256: string;
}

export type InstalledMaintenanceShadowRegistration<F extends InstalledMaintenanceShadowFamily> =
  | InstalledMaintenanceShadowRegistrationV2<F>
  | InstalledMaintenanceShadowRegistrationV3<F>;

export interface InstalledMaintenanceShadowReceiptV1 {
  readonly actionSha256: string;
  readonly bundleSha256: string;
  readonly candidateGraphSha256: string;
  readonly candidateSha256: string;
  readonly contractVersion: "adjustment-installed-candidate-receipt/v1";
  readonly controlPlaneSha256: string;
  readonly deployedCommit: string;
  readonly deployedImageDigest: string;
  readonly deployedRelease: string;
  readonly deployedSettingsSha256: string;
  readonly fencingToken: string;
  readonly installedAt: string;
  readonly registrationSha256: string;
  readonly sourceSha256: string;
}

export interface InstalledMaintenanceShadowReceiptV2
  extends Omit<InstalledMaintenanceShadowReceiptV1, "contractVersion"> {
  readonly actionKind: "shadow" | "promote" | "rollback_prior" | "raw";
  readonly contractVersion: "adjustment-installed-candidate-receipt/v2";
  readonly fullMemberRootSha256: string | null;
  readonly lifecycleHeadSha256: string;
  readonly policyDecision: "pending" | "qualified" | "regressed";
  readonly policyReportSha256: string;
}

export type InstalledMaintenanceShadowReceipt =
  | InstalledMaintenanceShadowReceiptV1
  | InstalledMaintenanceShadowReceiptV2;

export interface InstalledMaintenanceShadowCandidate<F extends InstalledMaintenanceShadowFamily> {
  readonly action: Readonly<Record<string, unknown>>;
  readonly bundle: Readonly<Record<string, unknown>>;
  readonly catalogSha256: string;
  readonly family: F;
  readonly receipt: InstalledMaintenanceShadowReceipt;
  readonly registration: InstalledMaintenanceShadowRegistration<F>;
}

// retain only the root-selected independent fixed-control members
export interface InstalledRainMaintenanceControlReference {
  readonly controlStateBytes: Uint8Array;
  readonly controlStateSha256: string;
  readonly ordinalArtifactBytes: Uint8Array;
  readonly ordinalArtifactSha256: string;
}

interface InstalledRainMaintenanceControlReceipt {
  readonly actionKind: "control_reference";
  readonly actionSha256: string;
  readonly contractVersion: "adjustment-installed-rain-control-reference-receipt/v1";
  readonly controlPlaneSha256: string;
  readonly controlStateSha256: string;
  readonly custodyAnchorSha256: string;
  readonly deployedCommit: string;
  readonly deployedImageDigest: string;
  readonly deployedRelease: string;
  readonly deployedSettingsSha256: string;
  readonly dueMonth: string;
  readonly fencingToken: string;
  readonly graphManifestSha256: string;
  readonly installedAt: string;
  readonly ordinalArtifactSha256: string;
  readonly sourceMemberRootSha256: string;
  readonly sourceReceiptRootSha256: string;
}

export interface InstalledMaintenanceServingCandidate<F extends InstalledMaintenanceShadowFamily> {
  readonly action: Readonly<Record<string, unknown>>;
  readonly bundle: Readonly<Record<string, unknown>>;
  readonly catalogSha256: string;
  readonly family: F;
  readonly receipt: InstalledMaintenanceShadowReceiptV2;
  readonly registration: InstalledMaintenanceShadowRegistration<F>;
}

// verify source-image projection bytes without conferring installed-file authority
export function verifyMaintenanceShadowCatalogProjection<F extends InstalledMaintenanceShadowFamily>(input: {
  readonly family: F;
  readonly parityBytes: Uint8Array;
  readonly projectionBytes: Uint8Array;
  readonly receipt: InstalledMaintenanceShadowReceipt;
  readonly registration: InstalledMaintenanceShadowRegistration<F>;
}): void {
  const receipt = validateReceipt(input.receipt);
  const registration = validateRegistration(input.registration, input.family);
  validateProjectionDocuments({ ...input, receipt, registration });
}

// verify control reference bytes without conferring installed-file authority
export function verifyInstalledRainMaintenanceControlReference(input: Readonly<{
  actionBytes: Uint8Array;
  controlStateBytes: Uint8Array;
  ordinalArtifactBytes: Uint8Array;
  receipt: unknown;
  selectorBytes: Uint8Array;
}>): InstalledRainMaintenanceControlReference {
  const receipt = parseRainControlReceipt(input.receipt);
  const selector = parseCanonicalJson(input.selectorBytes, "installed rain control selector");
  const action = parseCanonicalJson(input.actionBytes, "installed rain control action");
  validateRainControlSelector(selector, receipt);
  validateRainControlAction(action, receipt, input.actionBytes);
  const state = parseRainMaintenanceControlState(input.controlStateBytes);
  validateRainMaintenanceControlArtifact(state, input.ordinalArtifactBytes);
  // require exact selected bytes and their earlier-only state graph
  if (sha256(input.controlStateBytes) !== receipt.controlStateSha256 ||
      sha256(input.ordinalArtifactBytes) !== receipt.ordinalArtifactSha256 ||
      state.modelMonth !== receipt.dueMonth || state.generatedAt !== action.createdAt ||
      state.sourceMemberRootSha256 !== receipt.sourceMemberRootSha256 ||
      state.sourceReceiptRootSha256 !== receipt.sourceReceiptRootSha256) {
    throw new RangeError("installed rain control members differ");
  }
  return Object.freeze({
    controlStateBytes: Buffer.from(input.controlStateBytes),
    controlStateSha256: receipt.controlStateSha256,
    ordinalArtifactBytes: Buffer.from(input.ordinalArtifactBytes),
    ordinalArtifactSha256: receipt.ordinalArtifactSha256,
  });
}

// load one root-authenticated installed candidate without trusting environment hashes
export async function loadInstalledMaintenanceShadowCandidate<F extends InstalledMaintenanceShadowFamily>(input: {
  readonly catalogPath?: string;
  readonly family: F;
  readonly sourceRoot?: string;
}): Promise<InstalledMaintenanceShadowCandidate<F> | null> {
  const catalogPath = resolve(input.catalogPath ?? "/run/weather/adjustment-candidate-catalog.json");
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  await requireRootInstalledCatalog(catalogPath);
  const catalogBytes = await readFile(catalogPath);
  const catalog = parseCanonicalJson(catalogBytes, "installed candidate catalog");
  exactKeys(catalog, CATALOG_KEYS, "installed candidate catalog");
  const entry = selectCatalogEntry(catalog, input.family, "shadow");
  // an omitted shadow slot is an explicit fail-closed inactive selection
  if (entry === null) {
    return null;
  }
  const receipt = validateReceipt(entry.receipt);
  const registration = validateRegistration(entry.registration, input.family);
  const actionPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean", "actions",
    `sha256-${receipt.actionSha256}.json`));
  const projectionPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    "shadow-catalog", input.family, `sha256-${receipt.candidateSha256}.json`));
  const parityPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    "model-parity", input.family, `sha256-${receipt.candidateSha256}.json`));
  const bundlePath = inside(sourceRoot, bundleRelativePath(input.family, receipt.bundleSha256));
  const rainPackagePath = input.family === "rain"
    ? inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean", "rain-model-packages",
      `sha256-${receipt.candidateSha256}.json`))
    : null;
  await Promise.all([actionPath, projectionPath, parityPath, bundlePath, rainPackagePath]
    .filter((path): path is string => path !== null)
    .map(requireRootOwnedRegularFile));
  const [actionBytes, projectionBytes, parityBytes, bundleBytes, rainPackageBytes] = await Promise.all([
    readFile(actionPath), readFile(projectionPath), readFile(parityPath), readFile(bundlePath),
    rainPackagePath === null ? Promise.resolve(null) : readFile(rainPackagePath),
  ]);
  const action = parseCanonicalJson(actionBytes, "installed candidate action");
  const { parity, projection } = validateProjectionDocuments({
    family: input.family,
    parityBytes,
    projectionBytes,
    receipt,
    registration,
  });
  const bundle = parseCanonicalJson(bundleBytes, "installed candidate bundle");
  validateAction(action, receipt, input.family, actionBytes);
  const rainPackage = rainPackageBytes === null
    ? null
    : parseCanonicalJson(rainPackageBytes, "installed rain package receipt");
  validateBundle(bundle, receipt, input.family, bundleBytes, rainPackage);
  if (input.family === "rain" && rainPackage !== null) {
    await validateInstalledRainMaintenanceControls(sourceRoot, rainPackage, bundle);
  }
  crossBindRegistration(registration, receipt, input.family);
  return Object.freeze({
    action,
    bundle,
    catalogSha256: sha256(catalogBytes),
    family: input.family,
    receipt,
    registration,
  });
}

// load the independently installed pre-month rain control reference
export async function loadInstalledRainMaintenanceControlReference(input: {
  readonly catalogPath?: string;
  readonly sourceRoot?: string;
} = {}): Promise<InstalledRainMaintenanceControlReference | null> {
  const catalogPath = resolve(input.catalogPath ?? "/run/weather/adjustment-candidate-catalog.json");
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  await requireRootInstalledCatalog(catalogPath);
  const catalogBytes = await readFile(catalogPath);
  const catalog = parseCanonicalJson(catalogBytes, "installed candidate catalog");
  exactKeys(catalog, CATALOG_KEYS, "installed candidate catalog");
  // older catalogs intentionally carry no independent control authority
  if (catalog.contractVersion !== "adjustment-installed-candidate-catalog/v3") {
    selectCatalogEntry(catalog, "rain", "control");
    return null;
  }
  const entry = selectCatalogEntry(catalog, "rain", "control");
  if (entry === null) {
    return null;
  }
  const receipt = parseRainControlReceipt(entry.receipt);
  const selectorPath = inside(sourceRoot, join("config", "forecast-adjustments",
    "ballydidean-rain-control-reference.json"));
  const actionPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean", "actions",
    `sha256-${receipt.actionSha256}.json`));
  await Promise.all([requireRootOwnedRegularFile(selectorPath), requireRootOwnedRegularFile(actionPath)]);
  const [selectorBytes, actionBytes] = await Promise.all([readFile(selectorPath), readFile(actionPath)]);
  const selector = parseCanonicalJson(selectorBytes, "installed rain control selector");
  const action = parseCanonicalJson(actionBytes, "installed rain control action");
  validateRainControlSelector(selector, receipt);
  validateRainControlAction(action, receipt, actionBytes);
  const controlStatePath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    String(selector.controlStatePath)));
  const ordinalArtifactPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    String(selector.ordinalArtifactPath)));
  await Promise.all([
    requireRootOwnedRegularFile(controlStatePath),
    requireRootOwnedRegularFile(ordinalArtifactPath),
  ]);
  const [controlStateBytes, ordinalArtifactBytes] = await Promise.all([
    readFile(controlStatePath),
    readFile(ordinalArtifactPath),
  ]);
  return verifyInstalledRainMaintenanceControlReference({
    actionBytes,
    controlStateBytes,
    ordinalArtifactBytes,
    receipt,
    selectorBytes,
  });
}

// load one root-authorized qualified package selected by the compiled registry
export async function loadInstalledMaintenanceServingCandidate<F extends InstalledMaintenanceShadowFamily>(input: {
  readonly family: F;
  readonly sourceRoot?: string;
}): Promise<InstalledMaintenanceServingCandidate<F> | null> {
  const catalogPath = "/run/weather/adjustment-candidate-catalog.json";
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  await requireRootInstalledCatalog(catalogPath);
  const catalogBytes = await readFile(catalogPath);
  const catalog = parseCanonicalJson(catalogBytes, "installed candidate catalog");
  exactKeys(catalog, CATALOG_KEYS, "installed candidate catalog");
  const entry = selectCatalogEntry(catalog, input.family, "active");
  // preserve raw serving when no qualified active slot is installed
  if (entry === null) {
    return null;
  }
  const receipt = validateServingReceipt(entry.receipt);
  const registration = validateRegistration(entry.registration, input.family);
  crossBindRegistration(registration, receipt, input.family);
  const registryPath = inside(sourceRoot, servingRegistryRelativePath(input.family));
  const actionPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean", "actions",
    `sha256-${receipt.actionSha256}.json`));
  const bundlePath = inside(sourceRoot, bundleRelativePath(input.family, receipt.bundleSha256));
  const rainPackagePath = input.family === "rain"
    ? inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean", "rain-model-packages",
      `sha256-${receipt.candidateSha256}.json`))
    : null;
  await Promise.all([registryPath, actionPath, bundlePath, rainPackagePath]
    .filter((path): path is string => path !== null)
    .map(requireRootOwnedRegularFile));
  const [registryBytes, actionBytes, bundleBytes, rainPackageBytes] = await Promise.all([
    readFile(registryPath), readFile(actionPath), readFile(bundlePath),
    rainPackagePath === null ? Promise.resolve(null) : readFile(rainPackagePath),
  ]);
  const registry = parseCanonicalJson(registryBytes, "maintenance serving registry");
  const action = parseCanonicalJson(actionBytes, "installed candidate action");
  const bundle = parseCanonicalJson(bundleBytes, "installed candidate bundle");
  const rainPackage = rainPackageBytes === null
    ? null
    : parseCanonicalJson(rainPackageBytes, "installed rain package receipt");
  validateServingRegistry(registry, receipt, input.family);
  validateServingAction(action, receipt, input.family, actionBytes);
  validateBundle(bundle, receipt, input.family, bundleBytes, rainPackage);
  return Object.freeze({
    action,
    bundle,
    catalogSha256: sha256(catalogBytes),
    family: input.family,
    receipt,
    registration,
  });
}

// select one unambiguous catalog slot across all disjoint catalog contracts
function selectCatalogEntry(
  catalog: Record<string, unknown>,
  family: InstalledMaintenanceShadowFamily,
  slot: "active" | "control" | "shadow",
): Record<string, unknown> | null {
  const version = catalog.contractVersion;
  const maximum = version === "adjustment-installed-candidate-catalog/v1"
    ? 3
    : version === "adjustment-installed-candidate-catalog/v2"
      ? 6
      : version === "adjustment-installed-candidate-catalog/v3"
        ? 7
        : null;
  // reject unknown versions and unbounded entry sets
  if (maximum === null || !Array.isArray(catalog.entries) || catalog.entries.length > maximum) {
    throw new RangeError("installed candidate catalog is invalid");
  }
  const identities = new Set<string>();
  const matches: Record<string, unknown>[] = [];
  // validate every entry key and unique slot before selecting one family
  for (const value of catalog.entries) {
    exactKeys(value, version === "adjustment-installed-candidate-catalog/v1"
      ? ENTRY_V1_KEYS
      : ENTRY_V2_KEYS, "installed candidate entry");
    const entry = value as Record<string, unknown>;
    const entryFamily = entry.family;
    const entrySlot = version === "adjustment-installed-candidate-catalog/v1" ? "shadow" : entry.slot;
    const receiptVersion = isRecord(entry.receipt) ? entry.receipt.contractVersion : null;
    const controlEntry = version === "adjustment-installed-candidate-catalog/v3" &&
      entrySlot === "control";
    const candidateReceiptVersion = version === "adjustment-installed-candidate-catalog/v1"
      ? "adjustment-installed-candidate-receipt/v1"
      : "adjustment-installed-candidate-receipt/v2";
    if (controlEntry
      ? entryFamily !== "rain" || entry.registration !== null ||
        receiptVersion !== "adjustment-installed-rain-control-reference-receipt/v1"
      : !["temperature", "wind", "rain"].includes(String(entryFamily)) ||
        !["active", "shadow"].includes(String(entrySlot)) ||
        receiptVersion !== candidateReceiptVersion) {
      throw new RangeError("installed candidate catalog slot is invalid");
    }
    const identity = `${String(entryFamily)}:${String(entrySlot)}`;
    if (identities.has(identity)) {
      throw new RangeError("installed candidate catalog slot is duplicated");
    }
    identities.add(identity);
    // select only the exact requested family role
    if (entryFamily === family && entrySlot === slot) {
      matches.push(entry);
    }
  }
  return matches[0] ?? null;
}

// parse and cross-bind the two candidate-addressed source-image projections
function validateProjectionDocuments<F extends InstalledMaintenanceShadowFamily>(input: {
  readonly family: F;
  readonly parityBytes: Uint8Array;
  readonly projectionBytes: Uint8Array;
  readonly receipt: InstalledMaintenanceShadowReceipt;
  readonly registration: InstalledMaintenanceShadowRegistration<F>;
}): Readonly<{ parity: Record<string, unknown>; projection: Record<string, unknown> }> {
  const projection = parseCanonicalJson(input.projectionBytes, "installed candidate projection");
  const parity = parseCanonicalJson(input.parityBytes, "installed candidate parity");
  validateProjection(projection, input.receipt, input.registration, input.family);
  validateParity(parity, projection, input.receipt, input.family, input.parityBytes);
  return { parity, projection };
}

// parse one root-installed control reference receipt without candidate authority
function parseRainControlReceipt(value: unknown): InstalledRainMaintenanceControlReceipt {
  exactKeys(value, CONTROL_RECEIPT_KEYS, "installed rain control receipt");
  const receipt = value as unknown as InstalledRainMaintenanceControlReceipt;
  // require every archived graph, deployment and custody identity
  for (const identity of [receipt.actionSha256, receipt.controlPlaneSha256,
    receipt.controlStateSha256, receipt.custodyAnchorSha256, receipt.deployedSettingsSha256,
    receipt.graphManifestSha256, receipt.ordinalArtifactSha256, receipt.sourceMemberRootSha256,
    receipt.sourceReceiptRootSha256]) {
    if (!HASH.test(identity)) {
      throw new RangeError("installed rain control receipt identity differs");
    }
  }
  // close the root transaction and immutable deployed release identity
  if (receipt.contractVersion !== "adjustment-installed-rain-control-reference-receipt/v1" ||
      receipt.actionKind !== "control_reference" || !MONTH.test(receipt.dueMonth) ||
      !COMMIT.test(receipt.deployedCommit) || !IMAGE_DIGEST.test(receipt.deployedImageDigest) ||
      !RELEASE.test(receipt.deployedRelease) || !/^[1-9]\d{0,19}$/u.test(receipt.fencingToken) ||
      !validInstant(receipt.installedAt)) {
    throw new RangeError("installed rain control receipt differs");
  }
  return Object.freeze({ ...receipt });
}

// validate the fixed public selector against the installed control receipt
function validateRainControlSelector(
  value: Record<string, unknown>,
  receipt: InstalledRainMaintenanceControlReceipt,
): void {
  exactKeys(value, CONTROL_SELECTOR_KEYS, "installed rain control selector");
  // select only content-addressed state and ordinal paths from the exact action
  if (value.contractVersion !== "forecast-adjustment-rain-control-reference-registry/v1" ||
      value.siteKey !== "ballydidean" || value.actionSha256 !== receipt.actionSha256 ||
      value.dueMonth !== receipt.dueMonth || value.controlStateSha256 !== receipt.controlStateSha256 ||
      value.ordinalArtifactSha256 !== receipt.ordinalArtifactSha256 ||
      value.controlStatePath !==
        `rain-maintenance-control-states/sha256-${receipt.controlStateSha256}.json` ||
      value.ordinalArtifactPath !==
        `rain-runtime-artifacts/sha256-${receipt.ordinalArtifactSha256}.json`) {
    throw new RangeError("installed rain control selector differs");
  }
}

// validate the immutable pre-month action independently from its selector
function validateRainControlAction(
  value: Record<string, unknown>,
  receipt: InstalledRainMaintenanceControlReceipt,
  bytes: Uint8Array,
): void {
  exactKeys(value, CONTROL_ACTION_KEYS, "installed rain control action");
  const expectedCatalogReceipt = value.expectedCatalogReceiptSha256;
  // require bounded source ancestry and an optional exact prior control receipt
  if (!validInstant(value.createdAt) || !validInstant(value.validThrough) ||
      Date.parse(String(value.createdAt)) >= Date.parse(String(value.validThrough)) ||
      (expectedCatalogReceipt !== null &&
        (typeof expectedCatalogReceipt !== "string" || !HASH.test(expectedCatalogReceipt))) ||
      value.predecessorActionSha256 !== null || !COMMIT.test(String(value.expectedSourceCommit)) ||
      !RELEASE.test(String(value.expectedSourceRelease))) {
    throw new RangeError("installed rain control action ancestry differs");
  }
  // bind all state, graph and root transaction identities without granting serving authority
  if (sha256(bytes) !== receipt.actionSha256 ||
      value.contractVersion !== "forecast-adjustment-rain-control-reference-action/v1" ||
      value.actionKind !== "control_reference" || value.reason !== "premonth_reference" ||
      value.family !== "rain" || value.dueMonth !== receipt.dueMonth ||
      value.fencingToken !== receipt.fencingToken ||
      value.graphManifestSha256 !== receipt.graphManifestSha256 ||
      value.controlStateSha256 !== receipt.controlStateSha256 ||
      value.ordinalArtifactSha256 !== receipt.ordinalArtifactSha256 ||
      value.sourceMemberRootSha256 !== receipt.sourceMemberRootSha256 ||
      value.sourceReceiptRootSha256 !== receipt.sourceReceiptRootSha256 ||
      value.expectedSettingsSha256 !== receipt.deployedSettingsSha256) {
    throw new RangeError("installed rain control action differs");
  }
}

// validate one exact root transaction receipt
function parseReceipt(value: unknown): InstalledMaintenanceShadowReceipt {
  const contractVersion = isRecord(value) ? value.contractVersion : null;
  exactKeys(value, contractVersion === "adjustment-installed-candidate-receipt/v2"
    ? RECEIPT_V2_KEYS
    : RECEIPT_V1_KEYS, "installed candidate receipt");
  const receipt = value as unknown as InstalledMaintenanceShadowReceipt;
  // require every immutable identity and deployed clock
  for (const identity of [receipt.actionSha256, receipt.registrationSha256, receipt.candidateGraphSha256,
    receipt.candidateSha256, receipt.bundleSha256, receipt.sourceSha256, receipt.deployedSettingsSha256,
    receipt.controlPlaneSha256]) {
    if (!HASH.test(identity)) {
      throw new RangeError("installed candidate receipt identity is invalid");
    }
  }
  // close deployment identity formats without treating their text as authority
  if (!["adjustment-installed-candidate-receipt/v1", "adjustment-installed-candidate-receipt/v2"]
    .includes(receipt.contractVersion) ||
      !COMMIT.test(receipt.deployedCommit) || !RELEASE.test(receipt.deployedRelease) ||
      !IMAGE_DIGEST.test(receipt.deployedImageDigest) || !/^[1-9]\d{0,19}$/u.test(receipt.fencingToken) ||
      !validInstant(receipt.installedAt)) {
    throw new RangeError("installed candidate receipt is invalid");
  }
  return Object.freeze({ ...receipt });
}

// admit only inactive authority through the shadow loader
function validateReceipt(value: unknown): InstalledMaintenanceShadowReceipt {
  const receipt = parseReceipt(value);
  if (receipt.contractVersion === "adjustment-installed-candidate-receipt/v2" &&
      (receipt.actionKind !== "shadow" || receipt.policyDecision !== "pending" ||
        receipt.fullMemberRootSha256 !== null || !HASH.test(receipt.lifecycleHeadSha256) ||
        !HASH.test(receipt.policyReportSha256))) {
    throw new RangeError("installed shadow candidate receipt authority differs");
  }
  return receipt;
}

// admit only a fully qualified root-installed serving receipt
function validateServingReceipt(value: unknown): InstalledMaintenanceShadowReceiptV2 {
  const receipt = parseReceipt(value);
  // require the distinct post-confirmation receipt and complete lifecycle roots
  if (receipt.contractVersion !== "adjustment-installed-candidate-receipt/v2" ||
      receipt.actionKind !== "promote" || receipt.policyDecision !== "qualified" ||
      receipt.fullMemberRootSha256 === null || !HASH.test(receipt.fullMemberRootSha256) ||
      !HASH.test(receipt.lifecycleHeadSha256) || !HASH.test(receipt.policyReportSha256)) {
    throw new RangeError("installed serving candidate receipt authority differs");
  }
  return receipt;
}

// validate and recompute one exact database registration input
function validateRegistration<F extends InstalledMaintenanceShadowFamily>(
  value: unknown,
  family: F,
): InstalledMaintenanceShadowRegistration<F> {
  const version = installedRegistrationVersion(value);
  exactKeys(value, version === "v3" ? REGISTRATION_V3_KEYS : REGISTRATION_V2_KEYS,
    "installed candidate registration");
  const registration = value as unknown as InstalledMaintenanceShadowRegistration<F>;
  // close every registration identity and clock before recomputation
  for (const identity of [registration.artifactSha256, registration.candidateSha256, registration.cohortSha256,
    registration.policySha256, registration.registrationSha256, registration.reservedKeySha256,
    registration.sourceSha256]) {
    if (!HASH.test(identity)) {
      throw new RangeError("installed candidate registration identity is invalid");
    }
  }
  // validate the future-only schedule fields only for the disjoint v3 shape
  if ("epochWitnessSha256" in registration) {
    if (!HASH.test(registration.epochWitnessSha256) ||
        !HASH.test(registration.scheduleContractSha256) ||
        (registration.predecessorRegistrationSha256 !== null &&
          !HASH.test(registration.predecessorRegistrationSha256))) {
      throw new RangeError("installed candidate registration lineage is invalid");
    }
  }
  if (registration.family !== family || registration.siteKey !== "ballydidean" ||
      !validInstant(registration.intervalStartAt) || !validInstant(registration.intervalEndAt) ||
      !validInstant(registration.targetCutoffAt) || !validInstant(registration.terminalAt) ||
      registration.registrationSha256 !== registrationSha256(registration)) {
    throw new RangeError("installed candidate registration is invalid");
  }
  return Object.freeze({ ...registration });
}

// select v3 when any v3-only field is present so partial extensions fail closed
function installedRegistrationVersion(value: unknown): "v2" | "v3" {
  const v3 = isRecord(value) && REGISTRATION_V3_ONLY_KEYS.some(
    // inspect own fields only on parsed plain objects
    (key) => Object.prototype.hasOwnProperty.call(value, key),
  );
  return v3 ? "v3" : "v2";
}

// validate the independently addressed public action bytes
function validateAction(
  action: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceipt,
  family: InstalledMaintenanceShadowFamily,
  bytes: Uint8Array,
): void {
  exactKeys(action, ACTION_KEYS, "installed candidate action");
  // validate every action clock and nullable ancestry identity
  if (!validInstant(action.createdAt) || !validInstant(action.reportCreatedAt) ||
      !validInstant(action.validThrough) ||
      (action.expectedInstalledReceiptSha256 !== null &&
        (typeof action.expectedInstalledReceiptSha256 !== "string" ||
          !HASH.test(action.expectedInstalledReceiptSha256))) ||
      (action.predecessorActionSha256 !== null &&
        (typeof action.predecessorActionSha256 !== "string" || !HASH.test(action.predecessorActionSha256)))) {
    throw new RangeError("installed candidate action clocks differ");
  }
  // require every action graph identity to be an exact hash
  for (const identity of [action.candidateGraphSha256, action.candidateSha256, action.expectedSettingsSha256,
    action.lifecycleHeadSha256, action.policyReportSha256]) {
    if (typeof identity !== "string" || !HASH.test(identity)) {
      throw new RangeError("installed candidate action identity differs");
    }
  }
  // accept only a pending inactive shadow action bound to this deployed receipt
  if (sha256(bytes) !== receipt.actionSha256 || action.contractVersion !== "forecast-adjustment-model-action/v1" ||
      action.actionKind !== "shadow" || action.policyDecision !== "pending" ||
      action.reason !== "development_candidate" || action.siteKey !== "ballydidean" || action.family !== family ||
      action.candidateGraphSha256 !== receipt.candidateGraphSha256 ||
      action.candidateSha256 !== receipt.candidateSha256 || action.fullMemberRootSha256 !== null ||
      action.expectedSettingsSha256 !== receipt.deployedSettingsSha256 ||
      action.fencingToken !== receipt.fencingToken) {
    throw new RangeError("installed candidate action differs");
  }
  // cross-bind every v2 lifecycle authority projection to the exact action
  if (receipt.contractVersion === "adjustment-installed-candidate-receipt/v2" &&
      (action.actionKind !== receipt.actionKind || action.fullMemberRootSha256 !== receipt.fullMemberRootSha256 ||
        action.lifecycleHeadSha256 !== receipt.lifecycleHeadSha256 || action.policyDecision !== receipt.policyDecision ||
        action.policyReportSha256 !== receipt.policyReportSha256)) {
    throw new RangeError("installed candidate receipt action differs");
  }
}

// validate one qualified action independently from the serving registry
function validateServingAction(
  action: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceiptV2,
  family: InstalledMaintenanceShadowFamily,
  bytes: Uint8Array,
): void {
  exactKeys(action, ACTION_KEYS, "installed candidate action");
  // validate every bounded clock and predecessor identity
  if (!validInstant(action.createdAt) || !validInstant(action.reportCreatedAt) ||
      !validInstant(action.validThrough) || typeof action.predecessorActionSha256 !== "string" ||
      !HASH.test(action.predecessorActionSha256) ||
      typeof action.expectedInstalledReceiptSha256 !== "string" ||
      !HASH.test(action.expectedInstalledReceiptSha256)) {
    throw new RangeError("installed serving action clocks differ");
  }
  // bind the qualified action to the independently installed v2 receipt
  if (sha256(bytes) !== receipt.actionSha256 || action.contractVersion !== "forecast-adjustment-model-action/v1" ||
      action.actionKind !== "promote" || action.policyDecision !== "qualified" ||
      action.reason !== "qualified_candidate" || action.siteKey !== "ballydidean" || action.family !== family ||
      action.candidateGraphSha256 !== receipt.candidateGraphSha256 ||
      action.candidateSha256 !== receipt.candidateSha256 ||
      action.fullMemberRootSha256 !== receipt.fullMemberRootSha256 ||
      action.lifecycleHeadSha256 !== receipt.lifecycleHeadSha256 ||
      action.policyReportSha256 !== receipt.policyReportSha256 ||
      action.expectedSettingsSha256 !== receipt.deployedSettingsSha256 ||
      action.fencingToken !== receipt.fencingToken) {
    throw new RangeError("installed serving action differs");
  }
}

// validate one compiled registry selection against root-installed authority
function validateServingRegistry(
  registry: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceiptV2,
  family: InstalledMaintenanceShadowFamily,
): void {
  exactKeys(registry, ["activePackage", "contractVersion", "rawReason", "siteKey"],
    "maintenance serving registry");
  const active = registry.activePackage;
  exactKeys(active, ["actionSha256", "artifactSha256", "candidateSha256", "path"],
    "maintenance serving registry package");
  const expectedContract = `forecast-adjustment-${family}-maintenance-registry/v1`;
  const expectedPath = bundleRelativePath(family, receipt.bundleSha256)
    .slice("config/forecast-adjustments/ballydidean/".length);
  // require the exact qualified package and prohibit a raw reason alongside it
  if (registry.contractVersion !== expectedContract || registry.siteKey !== "ballydidean" ||
      registry.rawReason !== null || active.actionSha256 !== receipt.actionSha256 ||
      active.artifactSha256 !== receipt.bundleSha256 || active.candidateSha256 !== receipt.candidateSha256 ||
      active.path !== expectedPath) {
    throw new RangeError("maintenance serving registry differs");
  }
}

// validate the source-image catalog projection independently from the root receipt
function validateProjection<F extends InstalledMaintenanceShadowFamily>(
  projection: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceipt,
  registration: InstalledMaintenanceShadowRegistration<F>,
  family: F,
): void {
  exactKeys(projection, PROJECTION_KEYS, "installed candidate projection");
  // cross-bind the exact action, graph, artifact and database registration
  if (projection.contractVersion !== "forecast-adjustment-shadow-catalog-projection/v1" ||
      projection.siteKey !== "ballydidean" || projection.family !== family ||
      projection.actionSha256 !== receipt.actionSha256 ||
      projection.candidateGraphSha256 !== receipt.candidateGraphSha256 ||
      projection.candidateSha256 !== receipt.candidateSha256 ||
      projection.artifactSha256 !== receipt.bundleSha256 ||
      projection.bundleSha256 !== receipt.bundleSha256 ||
      !HASH.test(String(projection.paritySha256)) ||
      canonicalJsonBytes(projection.registration as JsonValue) !== canonicalJsonBytes(registration as unknown as JsonValue)) {
    throw new RangeError("installed candidate projection differs");
  }
}

// validate one exact native-to-packaged parity receipt addressed by the candidate
function validateParity(
  parity: Record<string, unknown>,
  projection: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceipt,
  family: InstalledMaintenanceShadowFamily,
  bytes: Uint8Array,
): void {
  exactKeys(parity, PARITY_KEYS, "installed candidate parity");
  // validate every retained and synthetic byte identity
  for (const key of PARITY_KEYS.slice(3)) {
    if (typeof parity[key] !== "string" || !HASH.test(parity[key] as string)) {
      throw new RangeError("installed candidate parity identity differs");
    }
  }
  // require exact candidate/family addressing and both native output equalities
  if (parity.contractVersion !== "forecast-adjustment-model-parity/v1" ||
      parity.candidateSha256 !== receipt.candidateSha256 || parity.family !== family ||
      sha256(bytes) !== projection.paritySha256 ||
      parity.retainedNativeOutputSha256 !== parity.retainedPackagedOutputSha256 ||
      parity.syntheticNativeOutputSha256 !== parity.syntheticPackagedOutputSha256) {
    throw new RangeError("installed candidate parity differs");
  }
}

// verify one full portable runtime bundle rather than accepting a hash claim
function validateBundle(
  bundle: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceipt,
  family: InstalledMaintenanceShadowFamily,
  bytes: Uint8Array,
  rainPackage: Record<string, unknown> | null,
): void {
  // preserve rain's standalone byte-addressed artifact grammar
  if (family === "rain") {
    if (sha256(bytes) !== receipt.bundleSha256) {
      throw new RangeError("installed candidate bundle identity differs");
    }
    // require the candidate-addressed technical receipt before inactive evaluation
    if (rainPackage === null) {
      throw new RangeError("installed rain package receipt is missing");
    }
    validateRainPackage(rainPackage, receipt, bundle);
    validateRainHurdleWindPortableArtifact(Buffer.from(bytes).toString("utf8"), receipt.bundleSha256);
    return;
  }
  // accept only the authority-free monthly development package for new shadows
  if (bundle.contractVersion !== FORECAST_ADJUSTMENT_MAINTENANCE_RUNTIME_PACKAGE_VERSION ||
      bundle.family !== family || bundle.bundleSha256 !== receipt.bundleSha256 ||
      bundle.candidateSha256 !== receipt.candidateSha256) {
    throw new RangeError("installed candidate bundle identity differs");
  }
  verifyForecastAdjustmentMaintenanceRuntimePackage(
    bundle as unknown as ForecastAdjustmentMaintenanceRuntimePackage,
  );
}

// validate the immutable fit-candidate to portable-artifact mapping
function validateRainPackage(
  rainPackage: Record<string, unknown>,
  receipt: InstalledMaintenanceShadowReceipt,
  bundle: Record<string, unknown>,
): void {
  const version = rainPackage.contractVersion;
  exactKeys(rainPackage, version === "forecast-adjustment-rain-model-package/v2"
    ? RAIN_PACKAGE_V2_KEYS
    : RAIN_PACKAGE_V1_KEYS, "installed rain package receipt");
  // validate every technical build output identity without requiring promoted files
  for (const identity of [rainPackage.artifactSha256, rainPackage.candidateSha256,
    rainPackage.compiledSourceSha256, rainPackage.registrySha256]) {
    if (typeof identity !== "string" || !HASH.test(identity)) {
      throw new RangeError("installed rain package identity differs");
    }
  }
  // bind the selected fit to the exact inactive runtime artifact and month
  if (!["forecast-adjustment-rain-model-package/v1", "forecast-adjustment-rain-model-package/v2"]
      .includes(String(version)) ||
      rainPackage.candidateSha256 !== receipt.candidateSha256 ||
      rainPackage.artifactSha256 !== receipt.bundleSha256 ||
      rainPackage.artifactPath !== `rain-runtime-artifacts/sha256-${receipt.bundleSha256}.json` ||
      rainPackage.compiledSourcePath !== "packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts" ||
      rainPackage.modelMonth !== bundle.modelMonth) {
    throw new RangeError("installed rain package differs");
  }
  // v2 binds the exact immutable control state and fixed ordinal runtime paths
  if (version === "forecast-adjustment-rain-model-package/v2" &&
      (typeof rainPackage.controlStateSha256 !== "string" ||
        !HASH.test(rainPackage.controlStateSha256) ||
        typeof rainPackage.ordinalArtifactSha256 !== "string" ||
        !HASH.test(rainPackage.ordinalArtifactSha256) ||
        rainPackage.controlStatePath !==
          `rain-maintenance-control-states/sha256-${rainPackage.controlStateSha256}.json` ||
        rainPackage.ordinalArtifactPath !==
          `rain-runtime-artifacts/sha256-${rainPackage.ordinalArtifactSha256}.json`)) {
    throw new RangeError("installed rain control package differs");
  }
}

// load the root-owned state and ordinal artifact selected by a v2 technical receipt
async function validateInstalledRainMaintenanceControls(
  sourceRoot: string,
  rainPackage: Record<string, unknown>,
  bundle: Record<string, unknown>,
): Promise<void> {
  // legacy packages do not grant fixed-control scoring authority
  if (rainPackage.contractVersion === "forecast-adjustment-rain-model-package/v1") {
    return;
  }
  const controlStatePath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    String(rainPackage.controlStatePath)));
  const ordinalArtifactPath = inside(sourceRoot, join("config", "forecast-adjustments", "ballydidean",
    String(rainPackage.ordinalArtifactPath)));
  await Promise.all([
    requireRootOwnedRegularFile(controlStatePath),
    requireRootOwnedRegularFile(ordinalArtifactPath),
  ]);
  const [controlStateBytes, ordinalArtifactBytes] = await Promise.all([
    readFile(controlStatePath),
    readFile(ordinalArtifactPath),
  ]);
  const controlState: RainMaintenanceControlState = parseRainMaintenanceControlState(controlStateBytes);
  validateRainMaintenanceControlArtifact(controlState, ordinalArtifactBytes);
  // cross-bind exact files, monthly selection and package identities
  if (sha256(controlStateBytes) !== rainPackage.controlStateSha256 ||
      sha256(ordinalArtifactBytes) !== rainPackage.ordinalArtifactSha256 ||
      controlState.modelMonth !== bundle.modelMonth) {
    throw new RangeError("installed rain control members differ");
  }
}

// cross-bind the installed action receipt to the only database registration
function crossBindRegistration<F extends InstalledMaintenanceShadowFamily>(
  registration: InstalledMaintenanceShadowRegistration<F>,
  receipt: InstalledMaintenanceShadowReceipt,
  family: F,
): void {
  // reject candidate, source, artifact or family substitutions
  if (registration.family !== family || registration.registrationSha256 !== receipt.registrationSha256 ||
      registration.candidateSha256 !== receipt.candidateSha256 ||
      registration.artifactSha256 !== receipt.bundleSha256 ||
      registration.sourceSha256 !== receipt.sourceSha256) {
    throw new RangeError("installed candidate registration differs");
  }
}

// derive the same registration identity enforced by PostgreSQL
function registrationSha256(registration: InstalledMaintenanceShadowRegistration<InstalledMaintenanceShadowFamily>): string {
  // preserve the immutable v2 identity exactly
  if (!("epochWitnessSha256" in registration)) {
    return sha256(Buffer.from([
      "adjustment-shadow-registration/v2", registration.siteKey, registration.family,
      registration.candidateSha256, registration.artifactSha256, registration.policySha256,
      registration.cohortSha256, registration.reservedKeySha256, registration.sourceSha256,
      registration.intervalStartAt, registration.intervalEndAt, registration.targetCutoffAt,
      registration.terminalAt,
    ].join("\n")));
  }
  return sha256(Buffer.from(`${[
    "adjustment-shadow-registration/v3", registration.siteKey, registration.family,
    registration.candidateSha256, registration.artifactSha256, registration.policySha256,
    registration.cohortSha256, registration.reservedKeySha256, registration.sourceSha256,
    registration.epochWitnessSha256, registration.scheduleContractSha256,
    registration.predecessorRegistrationSha256 ?? "none", registration.intervalStartAt,
    registration.intervalEndAt, registration.targetCutoffAt, registration.terminalAt,
  ].join("\n")}\n`));
}

// map one family to its reviewed public runtime artifact path
function bundleRelativePath(family: InstalledMaintenanceShadowFamily, identity: string): string {
  // retain family-specific portable artifact directories
  if (family === "temperature") {
    return join("config", "forecast-adjustments", "ballydidean", "temperature-canary-bundles",
      `sha256-${identity}.json`);
  }
  if (family === "wind") {
    return join("config", "forecast-adjustments", "ballydidean", "wind-canary-bundles",
      `sha256-${identity}.json`);
  }
  return join("config", "forecast-adjustments", "ballydidean", "rain-runtime-artifacts",
    `sha256-${identity}.json`);
}

// map one family to its fixed compiled registry path
function servingRegistryRelativePath(family: InstalledMaintenanceShadowFamily): string {
  const filename = family === "temperature"
    ? "ballydidean-temperature-canary.json"
    : family === "wind"
      ? "ballydidean-wind-canary.json"
      : "ballydidean-rain-runtime.json";
  return join("config", "forecast-adjustments", filename);
}

// require the catalog itself to come from the fixed root-owned read-only mount
async function requireRootInstalledCatalog(path: string): Promise<void> {
  // prohibit compatibility paths and source-owned catalog substitution
  if (path !== "/run/weather/adjustment-candidate-catalog.json") {
    throw new RangeError("installed candidate catalog path is invalid");
  }
  await requireRootOwnedRegularFile(path);
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const line = mountInfo.split("\n").find((candidate) => {
    const fields = candidate.split(" ");
    return fields[4] === "/run/weather/adjustment-candidate-catalog.json";
  });
  // require one literal file bind mount with read-only VFS options
  if (line === undefined || !line.split(" ")[5]?.split(",").includes("ro")) {
    throw new RangeError("installed candidate catalog mount is not read only");
  }
}

// require one nonsymlinked root-owned single-link immutable-image file
async function requireRootOwnedRegularFile(path: string): Promise<void> {
  const [status, resolved] = await Promise.all([lstat(path), realpath(path)]);
  // reject links, alternate resolution, ownership and writable non-root modes
  if (!status.isFile() || status.nlink !== 1 || status.uid !== 0 || status.gid !== 0 ||
      (status.mode & 0o777) !== 0o644 || resolved !== path) {
    throw new RangeError("installed candidate file authority is invalid");
  }
}

// keep every content path inside the exact immutable application root
function inside(root: string, path: string): string {
  if (!isAbsolute(root) || !isAbsolute(path)) {
    throw new RangeError("installed candidate source path is invalid");
  }
  const candidate = resolve(path);
  const child = relative(root, candidate);
  // reject parent traversal and the root itself
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new RangeError("installed candidate source path escapes root");
  }
  return candidate;
}

// parse only canonical LF-terminated object json
function parseCanonicalJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonValue;
  // reject alternate whitespace, duplicate-key normalization and nonobjects
  if (!isRecord(value) || canonicalJsonBytes(value) !== Buffer.from(bytes).toString("utf8")) {
    throw new RangeError(`${label} is not canonical`);
  }
  return value;
}

// require an exact closed plain-object key set
function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  // reject arrays, prototypes and extension fields
  if (!isRecord(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new RangeError(`${label} fields differ`);
  }
}

// narrow one plain parsed json object
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// require one canonical utc millisecond clock
function validInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

// hash exact deployed bytes
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
