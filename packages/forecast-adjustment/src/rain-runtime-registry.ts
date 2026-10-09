import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { JsonValue } from "@weather/domain";

import {
  canonicalJsonBytes,
  canonicalSha256,
  deepFreeze,
} from "./candidate.js";
import { RAIN_HURDLE_WIND_ARTIFACT_SHA256 } from "./rain-hurdle-wind-artifact.js";
import { RAIN_HURDLE_WIND_ARTIFACT_JSON } from "./rain-hurdle-wind-artifact.js";
import { loadInstalledMaintenanceServingCandidate } from "./maintenance-shadow-catalog.js";
import {
  createMaintenanceShadowServingAuthority,
  type MaintenanceShadowServingAuthority,
} from "./maintenance-shadow-comparator.js";
import { FORECAST_ADJUSTMENT_RUNTIME_ROOT } from "./runtime-loader.js";

export const FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME =
  "ballydidean-rain-runtime.json" as const;
export const FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_SHA256 =
  "0bd90b7fdd9a0531bc9517c38093bdb59f53b84b58273a4cc8b4756b6683e888" as const;
export const FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_BYTES = 138 as const;

// describe one compiled rain artifact selection
export interface ForecastAdjustmentRainActiveArtifactV1 {
  readonly artifactSha256: string;
}

// describe the closed startup rain registry
export type ForecastAdjustmentRainRuntimeRegistryV1 =
  | {
      readonly activeArtifact: null;
      readonly contractVersion: "forecast-adjustment-rain-runtime-registry/v1";
      readonly rawReason: "policy_raw";
      readonly siteKey: "ballydidean";
    }
  | {
      readonly activeArtifact: ForecastAdjustmentRainActiveArtifactV1;
      readonly contractVersion: "forecast-adjustment-rain-runtime-registry/v1";
      readonly rawReason: null;
      readonly siteKey: "ballydidean";
    };

interface ForecastAdjustmentRainMaintenanceRegistryV1 {
  readonly activePackage: Readonly<{
    readonly actionSha256: string;
    readonly artifactSha256: string;
    readonly candidateSha256: string;
    readonly path: string;
  }> | null;
  readonly contractVersion: "forecast-adjustment-rain-maintenance-registry/v1";
  readonly rawReason: "policy_raw" | null;
  readonly siteKey: "ballydidean";
}

// report one hash-bound compiled rain runtime state
export type LoadedForecastAdjustmentRainRuntimeRegistryV1 =
  | {
      readonly artifactSha256: typeof RAIN_HURDLE_WIND_ARTIFACT_SHA256;
      readonly comparatorAuthority: MaintenanceShadowServingAuthority;
      readonly reasonCode: null;
      readonly state: "active";
    }
  | {
      readonly artifactSha256: null;
      readonly comparatorAuthority?: MaintenanceShadowServingAuthority;
      readonly reasonCode: "policy_raw" | "registry_invalid";
      readonly state: "disabled";
    };

// define one startup-only rain registry loader
export interface ForecastAdjustmentRainRuntimeRegistryLoaderV1 {
  readonly load: () => Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1>;
}

// create the production fixed-root rain registry loader
export function createForecastAdjustmentRainRuntimeRegistryLoader(): ForecastAdjustmentRainRuntimeRegistryLoaderV1 {
  return createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(
    FORECAST_ADJUSTMENT_RUNTIME_ROOT,
  );
}

// create one test-injected startup-only rain registry loader
export function createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(
  root: string,
): ForecastAdjustmentRainRuntimeRegistryLoaderV1 {
  let cached: Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1> | null = null;

  return deepFreeze({
    // cache active and disabled results for the process lifetime
    load(): Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1> {
      cached ??= loadRainRuntimeRegistryFromRoot(root);
      return cached;
    },
  });
}

// load and validate one compiled-artifact registry
async function loadRainRuntimeRegistryFromRoot(
  root: string,
): Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1> {
  const absoluteRoot = resolve(root);

  // reject relative and normalized startup roots
  if (!isAbsolute(root) || absoluteRoot !== root) {
    return disabledRainRuntime("registry_invalid");
  }

  try {
    const rootMetadata = await lstat(absoluteRoot);
    const rootReal = await realpath(absoluteRoot);

    // reject linked, aliased, and non-directory roots
    if (
      rootMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() ||
      rootReal !== absoluteRoot
    ) {
      throw new RangeError("rain runtime root is invalid");
    }

    const registry = await readRainRegistry(
      join(absoluteRoot, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME),
      absoluteRoot,
    );

    // require root-installed qualification before selecting compiled maintenance bytes
    if ("activePackage" in registry) {
      if (registry.activePackage === null) {
        validateRawRainMaintenanceRegistry(registry);
        return disabledRainRuntime("policy_raw", createMaintenanceShadowServingAuthority({
          artifactBytes: null,
          artifactIdentitySha256: null,
          authorityKind: "policy_raw",
          family: "rain",
          receiptBytes: Buffer.from(canonicalJsonBytes(registry as unknown as JsonValue)),
        }));
      }
      const installed = await loadInstalledMaintenanceServingCandidate({
        family: "rain",
        sourceRoot: resolve(absoluteRoot, "..", ".."),
      });
      // bind the selected portable artifact to the bytes compiled into this image
      if (installed === null || installed.receipt.bundleSha256 !== RAIN_HURDLE_WIND_ARTIFACT_SHA256) {
        throw new RangeError("compiled rain maintenance artifact differs");
      }
      return deepFreeze({
        artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
        comparatorAuthority: createMaintenanceShadowServingAuthority({
          artifactBytes: Buffer.from(canonicalJsonBytes(installed.bundle as unknown as JsonValue)),
          artifactIdentitySha256: installed.receipt.bundleSha256,
          authorityKind: "maintenance_qualified",
          family: "rain",
          receiptBytes: Buffer.from(canonicalJsonBytes(installed.receipt as unknown as JsonValue)),
        }),
        reasonCode: null,
        state: "active" as const,
      });
    }

    // preserve exact raw bytes without inspecting the compiled artifact
    if (registry.activeArtifact === null) {
      validateRawRainRegistry(registry);
      return disabledRainRuntime("policy_raw", createMaintenanceShadowServingAuthority({
        artifactBytes: null,
        artifactIdentitySha256: null,
        authorityKind: "policy_raw",
        family: "rain",
        receiptBytes: Buffer.from(canonicalJsonBytes(registry as unknown as JsonValue)),
      }));
    }

    validateActiveRainRegistry(registry);
    return deepFreeze({
      artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
      comparatorAuthority: createMaintenanceShadowServingAuthority({
        artifactBytes: Buffer.from(RAIN_HURDLE_WIND_ARTIFACT_JSON),
        artifactIdentitySha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
        authorityKind: "legacy_active",
        family: "rain",
        receiptBytes: Buffer.from(canonicalJsonBytes(registry as unknown as JsonValue)),
      }),
      reasonCode: null,
      state: "active" as const,
    });
  } catch {
    return disabledRainRuntime("registry_invalid");
  }
}

// read one canonical regular registry without following links
async function readRainRegistry(
  path: string,
  root: string,
): Promise<ForecastAdjustmentRainRuntimeRegistryV1 | ForecastAdjustmentRainMaintenanceRegistryV1> {
  const target = resolve(path);

  // keep the fixed filename directly below the selected root
  if (
    !target.startsWith(`${root}${sep}`) ||
    target !== join(root, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME)
  ) {
    throw new RangeError("rain runtime registry path is invalid");
  }

  const metadata = await lstat(target);
  const canonical = await realpath(target);

  // reject registry aliases and nonregular nodes
  if (metadata.isSymbolicLink() || !metadata.isFile() || canonical !== target) {
    throw new RangeError("rain runtime registry is not a regular file");
  }

  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const opened = await handle.stat();

    // bind the descriptor to the inspected path node
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new RangeError("rain runtime registry changed before open");
    }

    const bytes = (await handle.readFile()).toString("utf8");
    const after = await handle.stat();

    // reject replacement or mutation during the read
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new RangeError("rain runtime registry changed during read");
    }

    const parsed = JSON.parse(bytes) as JsonValue;

    // require the one canonical byte serialization
    if (bytes !== canonicalJsonBytes(parsed)) {
      throw new RangeError("rain runtime registry is not canonical JSON");
    }

    return parsed as ForecastAdjustmentRainRuntimeRegistryV1 | ForecastAdjustmentRainMaintenanceRegistryV1;
  } finally {
    await handle.close();
  }
}

// validate one raw maintenance registry without consulting installed authority
function validateRawRainMaintenanceRegistry(registry: ForecastAdjustmentRainMaintenanceRegistryV1): void {
  // reject extensions and every active selector on the raw branch
  if (Object.keys(registry).join(",") !== "activePackage,contractVersion,rawReason,siteKey" ||
      registry.activePackage !== null || registry.contractVersion !==
        "forecast-adjustment-rain-maintenance-registry/v1" || registry.rawReason !== "policy_raw" ||
      registry.siteKey !== "ballydidean") {
    throw new RangeError("rain maintenance raw registry is invalid");
  }
}

// validate the exact policy-raw registry bytes
function validateRawRainRegistry(
  registry: Extract<ForecastAdjustmentRainRuntimeRegistryV1, { activeArtifact: null }>,
): void {
  // reject unknown, missing, reordered, or substituted raw fields
  if (
    Object.keys(registry).join(",") !==
      "activeArtifact,contractVersion,rawReason,siteKey" ||
    registry.contractVersion !==
      "forecast-adjustment-rain-runtime-registry/v1" ||
    registry.rawReason !== "policy_raw" ||
    registry.siteKey !== "ballydidean" ||
    canonicalJsonBytes(registry as unknown as JsonValue).length !==
      FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_BYTES ||
    canonicalSha256(registry as unknown as JsonValue) !==
      FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_SHA256
  ) {
    throw new RangeError("rain policy-raw registry is invalid");
  }
}

// validate one active registry against the compiled generated artifact
function validateActiveRainRegistry(
  registry: Extract<ForecastAdjustmentRainRuntimeRegistryV1, { activeArtifact: object }>,
): void {
  // reject unknown registry and active-artifact fields
  if (
    Object.keys(registry).join(",") !==
      "activeArtifact,contractVersion,rawReason,siteKey" ||
    Object.keys(registry.activeArtifact).join(",") !== "artifactSha256" ||
    registry.contractVersion !==
      "forecast-adjustment-rain-runtime-registry/v1" ||
    registry.rawReason !== null ||
    registry.siteKey !== "ballydidean" ||
    registry.activeArtifact.artifactSha256 !==
      RAIN_HURDLE_WIND_ARTIFACT_SHA256
  ) {
    throw new RangeError("active rain runtime registry is invalid");
  }
}

// create one deeply frozen disabled rain runtime
function disabledRainRuntime(
  reasonCode: "policy_raw" | "registry_invalid",
  comparatorAuthority?: MaintenanceShadowServingAuthority,
): LoadedForecastAdjustmentRainRuntimeRegistryV1 {
  return deepFreeze({
    artifactSha256: null,
    ...(comparatorAuthority === undefined ? {} : { comparatorAuthority }),
    reasonCode,
    state: "disabled",
  });
}
