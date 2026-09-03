import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import {
  type ForecastAdjustmentReasonCode,
  type ForecastAdjustmentRegistryV1,
  type ForecastAdjustmentRuntimeBundleV2,
  type ForecastAdjustmentWindCanaryRegistryV1,
  type ForecastAdjustmentWindCanaryRuntimeBundleV1,
  validateForecastAdjustmentRegistry,
  validateForecastAdjustmentRuntimeBundleLinks,
  type JsonValue,
} from "@weather/domain";

import { canonicalJsonBytes, deepFreeze } from "./candidate.js";
import { runtimeCalendarFingerprintMatches } from "./calendar.js";
import { verifyForecastAdjustmentRuntimeBundle } from "./runtime-bundle.js";
import {
  forecastAdjustmentWindCanaryIsActiveAt,
  forecastAdjustmentWindCanaryIsKilled,
  validateForecastAdjustmentWindCanaryRegistry,
  validateForecastAdjustmentWindCanaryRuntimeBundleLinks,
  verifyForecastAdjustmentWindCanaryRuntimeBundle,
} from "./wind-canary.js";

export const FORECAST_ADJUSTMENT_RUNTIME_ROOT =
  "/opt/weather/config/forecast-adjustments";
export const FORECAST_ADJUSTMENT_REGISTRY_FILENAME = "ballydidean.json";
export const FORECAST_ADJUSTMENT_WIND_CANARY_REGISTRY_FILENAME =
  "ballydidean-wind-canary.json";

// cache one startup adjustment provider state
export type LoadedForecastAdjustmentRuntimeV1 =
  | {
      readonly bundle: ForecastAdjustmentRuntimeBundleV2;
      readonly reasonCode: null;
      readonly state: "active";
    }
  | {
      readonly bundle: null;
      readonly reasonCode: Extract<
        ForecastAdjustmentReasonCode,
        "bundle_invalid" | "bundle_missing" | "registry_inactive" | "registry_invalid"
      >;
      readonly state: "disabled";
    };

// define one startup-only cached loader
export interface ForecastAdjustmentRuntimeLoaderV1 {
  readonly load: () => Promise<LoadedForecastAdjustmentRuntimeV1>;
}

// cache one startup wind-canary state
export type LoadedForecastAdjustmentWindCanaryRuntimeV1 =
  | {
      readonly bundle: ForecastAdjustmentWindCanaryRuntimeBundleV1;
      readonly reasonCode: null;
      readonly state: "active";
    }
  | {
      readonly bundle: null;
      readonly reasonCode: Extract<
        ForecastAdjustmentReasonCode,
        | "bundle_invalid"
        | "bundle_missing"
        | "canary_expired"
        | "canary_killed"
        | "registry_inactive"
        | "registry_invalid"
      >;
      readonly state: "disabled";
    };

// define one startup-only canary loader
export interface ForecastAdjustmentWindCanaryRuntimeLoaderV1 {
  readonly load: () => Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1>;
}

// inject the one-way environment control and clock
export interface ForecastAdjustmentWindCanaryRuntimeOptionsV1 {
  readonly environmentKillSwitch?: string;
  readonly now?: () => string;
}

// create the production fixed-root startup loader
export function createForecastAdjustmentRuntimeLoader(): ForecastAdjustmentRuntimeLoaderV1 {
  return createForecastAdjustmentRuntimeLoaderForRoot(
    FORECAST_ADJUSTMENT_RUNTIME_ROOT,
  );
}

// create a test-only fixed-root startup loader
export function createForecastAdjustmentRuntimeLoaderForRoot(
  root: string,
): ForecastAdjustmentRuntimeLoaderV1 {
  let cached: Promise<LoadedForecastAdjustmentRuntimeV1> | null = null;

  return deepFreeze({
    // cache both success and failure for process lifetime
    load(): Promise<LoadedForecastAdjustmentRuntimeV1> {
      cached ??= loadRuntimeFromRoot(root);
      return cached;
    },
  });
}

// create the isolated production-root canary loader
export function createForecastAdjustmentWindCanaryRuntimeLoader(
  options: ForecastAdjustmentWindCanaryRuntimeOptionsV1 = {},
): ForecastAdjustmentWindCanaryRuntimeLoaderV1 {
  return createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(
    FORECAST_ADJUSTMENT_RUNTIME_ROOT,
    options,
  );
}

// create a test-injected isolated canary loader
export function createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(
  root: string,
  options: ForecastAdjustmentWindCanaryRuntimeOptionsV1 = {},
): ForecastAdjustmentWindCanaryRuntimeLoaderV1 {
  let cached: Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1> | null = null;

  return deepFreeze({
    // cache both success and fail-raw results for process lifetime
    load(): Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1> {
      cached ??= loadWindCanaryRuntimeFromRoot(root, options);
      return cached;
    },
  });
}

// load one registry and reviewed bundle without external I/O
async function loadRuntimeFromRoot(
  root: string,
): Promise<LoadedForecastAdjustmentRuntimeV1> {
  const absoluteRoot = resolve(root);
  let registry: ForecastAdjustmentRegistryV1;

  // reject relative or normalized test-root aliases
  if (!isAbsolute(root) || root !== absoluteRoot) {
    return disabled("registry_invalid");
  }

  try {
    const rootReal = await realpath(absoluteRoot);
    const rootMetadata = await lstat(absoluteRoot);

    // reject root aliases and special nodes
    if (
      rootReal !== absoluteRoot ||
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink()
    ) {
      throw new RangeError("runtime root is not canonical");
    }

    const registryPath = join(absoluteRoot, FORECAST_ADJUSTMENT_REGISTRY_FILENAME);
    registry = await readRegularJson<ForecastAdjustmentRegistryV1>(
      registryPath,
      absoluteRoot,
    );
    validateForecastAdjustmentRegistry(registry);
  } catch {
    return disabled("registry_invalid");
  }

  // preserve the reviewed inactive default
  if (registry.activeBundle === null) {
    return disabled("registry_inactive");
  }

  try {
    const active = registry.activeBundle;

    // require the exact closed relative filename
    if (
      isAbsolute(active.path) ||
      active.path.includes("..") ||
      active.path !== `bundles/sha256-${active.bundleSha256}.json`
    ) {
      throw new RangeError("runtime bundle selection path is invalid");
    }

    const bundleRoot = join(absoluteRoot, "ballydidean");
    const bundlePath = resolve(bundleRoot, active.path);

    // keep reviewed bytes below the one site bundle root
    if (!bundlePath.startsWith(`${bundleRoot}${sep}`)) {
      throw new RangeError("runtime bundle path escapes the site root");
    }

    const bundle = await readRegularJson<ForecastAdjustmentRuntimeBundleV2>(
      bundlePath,
      absoluteRoot,
    );
    verifyForecastAdjustmentRuntimeBundle(bundle);
    validateForecastAdjustmentRuntimeBundleLinks(registry, bundle);

    // require the calendar runtime used by the fitted hierarchy
    if (!runtimeCalendarFingerprintMatches(bundle.candidate.runtimeFingerprint)) {
      throw new RangeError("runtime calendar fingerprint does not match candidate");
    }

    return deepFreeze({ bundle: deepFreeze(bundle), reasonCode: null, state: "active" });
  } catch (error: unknown) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
        ? "bundle_missing"
        : "bundle_invalid";
    return disabled(code);
  }
}

// load one separately reviewed short-lived canary bundle
async function loadWindCanaryRuntimeFromRoot(
  root: string,
  options: ForecastAdjustmentWindCanaryRuntimeOptionsV1,
): Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1> {
  // let the one-way switch fail raw before filesystem access
  if (forecastAdjustmentWindCanaryIsKilled(options.environmentKillSwitch)) {
    return disabledWindCanary("canary_killed");
  }

  const absoluteRoot = resolve(root);
  let registry: ForecastAdjustmentWindCanaryRegistryV1;

  // reject relative or normalized roots
  if (!isAbsolute(root) || root !== absoluteRoot) {
    return disabledWindCanary("registry_invalid");
  }

  try {
    const rootReal = await realpath(absoluteRoot);
    const rootMetadata = await lstat(absoluteRoot);

    // reject root aliases and special nodes
    if (
      rootReal !== absoluteRoot ||
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink()
    ) {
      throw new RangeError("wind canary runtime root is not canonical");
    }

    registry = await readRegularJson<ForecastAdjustmentWindCanaryRegistryV1>(
      join(absoluteRoot, FORECAST_ADJUSTMENT_WIND_CANARY_REGISTRY_FILENAME),
      absoluteRoot,
    );

    validateForecastAdjustmentWindCanaryRegistry(registry);
  } catch {
    return disabledWindCanary("registry_invalid");
  }

  // preserve the reviewed inactive default
  if (registry.activeBundle === null) {
    return disabledWindCanary("registry_inactive");
  }

  try {
    const active = registry.activeBundle;

    // require one closed content-addressed filename
    if (
      isAbsolute(active.path) ||
      active.path.includes("..") ||
      active.path !==
        `wind-canary-bundles/sha256-${active.bundleSha256}.json`
    ) {
      throw new RangeError("wind canary bundle selection path is invalid");
    }

    const bundleRoot = join(absoluteRoot, "ballydidean");
    const bundlePath = resolve(bundleRoot, active.path);

    // keep canary bytes under the site root
    if (!bundlePath.startsWith(`${bundleRoot}${sep}`)) {
      throw new RangeError("wind canary bundle path escapes the site root");
    }

    const bundle = await readRegularJson<ForecastAdjustmentWindCanaryRuntimeBundleV1>(
      bundlePath,
      absoluteRoot,
    );
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    validateForecastAdjustmentWindCanaryRuntimeBundleLinks(registry, bundle);

    // require the fitted calendar runtime
    if (!runtimeCalendarFingerprintMatches(bundle.candidate.runtimeFingerprint)) {
      throw new RangeError("wind canary runtime fingerprint does not match candidate");
    }

    const now = options.now?.() ?? new Date().toISOString();

    // fail raw outside the explicit short-lived window
    if (!forecastAdjustmentWindCanaryIsActiveAt(bundle, now)) {
      return disabledWindCanary("canary_expired");
    }

    return deepFreeze({ bundle: deepFreeze(bundle), reasonCode: null, state: "active" });
  } catch (error: unknown) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
        ? "bundle_missing"
        : "bundle_invalid";
    return disabledWindCanary(code);
  }
}

// read one regular in-root JSON file
async function readRegularJson<T>(
  path: string,
  root: string,
): Promise<T> {
  const absoluteRoot = resolve(root);
  const target = resolve(path);
  await verifyCanonicalDirectoryPath(absoluteRoot);

  // reject lexical escapes before filesystem traversal
  if (
    !isAbsolute(path) ||
    target === absoluteRoot ||
    !target.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new RangeError("runtime file is not a canonical regular file");
  }

  const relativeSegments = target.slice(absoluteRoot.length + 1).split(sep);
  let cursor = absoluteRoot;

  // verify every in-root path component without following links
  for (let index = 0; index < relativeSegments.length; index += 1) {
    cursor = join(cursor, relativeSegments[index] as string);
    const metadata = await lstat(cursor);
    const canonical = await realpath(cursor);
    const last = index === relativeSegments.length - 1;

    // reject symlinks, aliases, nonregular files, and intermediate special nodes
    if (
      metadata.isSymbolicLink() ||
      canonical !== cursor ||
      !canonical.startsWith(`${absoluteRoot}${sep}`) ||
      (last ? !metadata.isFile() : !metadata.isDirectory())
    ) {
      throw new RangeError("runtime file is not a canonical regular file");
    }
  }

  const before = await lstat(target);
  const beforeReal = await realpath(target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const opened = await handle.stat();

    // bind the opened descriptor to the validated path node
    if (
      !opened.isFile() ||
      !sameFileMetadata(before, opened) ||
      beforeReal !== target
    ) {
      throw new RangeError("runtime file changed before open");
    }

    const bytes = (await handle.readFile()).toString("utf8");
    const openedAfter = await handle.stat();
    const after = await lstat(target);
    const afterReal = await realpath(target);

    // reject path, inode, or size replacement during the read
    if (
      !sameFileMetadata(opened, openedAfter) ||
      !sameFileMetadata(opened, after) ||
      afterReal !== beforeReal
    ) {
      throw new RangeError("runtime file changed during read");
    }

    const parsed = JSON.parse(bytes) as JsonValue;

    // require exact canonical registry and bundle bytes
    if (bytes !== canonicalJsonBytes(parsed)) {
      throw new RangeError("runtime file bytes are not canonical JSON");
    }

    return parsed as T;
  } finally {
    await handle.close();
  }
}

// require every absolute directory component to be canonical
async function verifyCanonicalDirectoryPath(path: string): Promise<void> {
  const absolute = resolve(path);

  // reject relative test-root aliases
  if (!isAbsolute(path) || path !== absolute) {
    throw new RangeError("runtime root must be an absolute canonical directory");
  }

  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let cursor = parsed.root;

  // verify the full fixed-root chain
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const metadata = await lstat(cursor);
    const canonical = await realpath(cursor);

    // reject aliases and non-directory components
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      canonical !== cursor
    ) {
      throw new RangeError("runtime root must be an absolute canonical directory");
    }
  }
}

// compare the stable runtime file identity fields
function sameFileMetadata(
  left: { readonly dev: number; readonly ino: number; readonly size: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

// create one deeply frozen disabled provider
function disabled(
  reasonCode: Extract<
    ForecastAdjustmentReasonCode,
    "bundle_invalid" | "bundle_missing" | "registry_inactive" | "registry_invalid"
  >,
): LoadedForecastAdjustmentRuntimeV1 {
  return deepFreeze({ bundle: null, reasonCode, state: "disabled" });
}

// create one deeply frozen disabled canary provider
function disabledWindCanary(
  reasonCode: Extract<
    ForecastAdjustmentReasonCode,
    | "bundle_invalid"
    | "bundle_missing"
    | "canary_expired"
    | "canary_killed"
    | "registry_inactive"
    | "registry_invalid"
  >,
): LoadedForecastAdjustmentWindCanaryRuntimeV1 {
  return deepFreeze({ bundle: null, reasonCode, state: "disabled" });
}
