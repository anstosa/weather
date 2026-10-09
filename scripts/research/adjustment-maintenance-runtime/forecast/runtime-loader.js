import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { validateForecastAdjustmentRegistry, validateForecastAdjustmentRuntimeBundleLinks, } from "@weather/domain";
import { canonicalJsonBytes, canonicalSha256, deepFreeze } from "./candidate.js";
import { runtimeCalendarFingerprintMatches } from "./calendar.js";
import { loadInstalledMaintenanceServingCandidate, } from "./maintenance-shadow-catalog.js";
import { createMaintenanceShadowServingAuthority, } from "./maintenance-shadow-comparator.js";
import { verifyForecastAdjustmentRuntimeBundle } from "./runtime-bundle.js";
import { forecastAdjustmentTemperatureCanaryIsActiveAt, forecastAdjustmentTemperatureCanaryIsKilled, temperatureCanaryRuntimeFingerprintMatches, validateForecastAdjustmentTemperatureCanaryRegistry, validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks, verifyForecastAdjustmentTemperatureCanaryRuntimeBundle, } from "./temperature-canary.js";
import { forecastAdjustmentWindCanaryIsActiveAt, forecastAdjustmentWindCanaryIsKilled, validateForecastAdjustmentWindCanaryRegistry, validateForecastAdjustmentWindCanaryRuntimeBundleLinks, verifyForecastAdjustmentWindCanaryRuntimeBundle, } from "./wind-canary.js";
export const FORECAST_ADJUSTMENT_RUNTIME_ROOT = "/opt/weather/config/forecast-adjustments";
export const FORECAST_ADJUSTMENT_REGISTRY_FILENAME = "ballydidean.json";
export const FORECAST_ADJUSTMENT_WIND_CANARY_REGISTRY_FILENAME = "ballydidean-wind-canary.json";
export const FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_REGISTRY_FILENAME = "ballydidean-temperature-canary.json";
export const FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_RAW_REGISTRY_SHA256 = "cee570ec382a99b25427523438bde556b6daed780e49ad14d1399d182ac14165";
export const FORECAST_ADJUSTMENT_WIND_CANARY_RAW_REGISTRY_SHA256 = "fa9856f136b731427ddedf2be40410142912198b8eabc3222735a0563c6964b9";
export const FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_RAW_REGISTRY_BYTES = 142;
export const FORECAST_ADJUSTMENT_WIND_CANARY_RAW_REGISTRY_BYTES = 763;
export const FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS = deepFreeze([
    { leadBand: "001-024", metric: "windGustMps" },
    { leadBand: "025-048", metric: "windGustMps" },
    { leadBand: "073-096", metric: "windGustMps" },
    { leadBand: "097-120", metric: "windGustMps" },
    { leadBand: "121-144", metric: "windGustMps" },
    { leadBand: "145-168", metric: "windGustMps" },
    { leadBand: "001-024", metric: "windSpeedMps" },
    { leadBand: "025-048", metric: "windSpeedMps" },
    { leadBand: "049-072", metric: "windSpeedMps" },
    { leadBand: "073-096", metric: "windSpeedMps" },
    { leadBand: "097-120", metric: "windSpeedMps" },
    { leadBand: "121-144", metric: "windSpeedMps" },
    { leadBand: "145-168", metric: "windSpeedMps" },
]);
// create the production fixed-root startup loader
export function createForecastAdjustmentRuntimeLoader() {
    return createForecastAdjustmentRuntimeLoaderForRoot(FORECAST_ADJUSTMENT_RUNTIME_ROOT);
}
// create a test-only fixed-root startup loader
export function createForecastAdjustmentRuntimeLoaderForRoot(root) {
    let cached = null;
    return deepFreeze({
        // cache both success and failure for process lifetime
        load() {
            cached ??= loadRuntimeFromRoot(root);
            return cached;
        },
    });
}
// create the isolated production-root canary loader
export function createForecastAdjustmentWindCanaryRuntimeLoader(options = {}) {
    return createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(FORECAST_ADJUSTMENT_RUNTIME_ROOT, options);
}
// create a test-injected isolated canary loader
export function createForecastAdjustmentWindCanaryRuntimeLoaderForRoot(root, options = {}) {
    let cached = null;
    return deepFreeze({
        // cache both success and fail-raw results for process lifetime
        load() {
            cached ??= loadWindCanaryRuntimeFromRoot(root, options);
            return cached;
        },
    });
}
// create the isolated production-root temperature loader
export function createForecastAdjustmentTemperatureCanaryRuntimeLoader(options = {}) {
    return createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(FORECAST_ADJUSTMENT_RUNTIME_ROOT, options);
}
// create a test-injected temperature loader
export function createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(root, options = {}) {
    let cached = null;
    return deepFreeze({
        // cache both success and fail-raw results for process lifetime
        load() {
            cached ??= loadTemperatureCanaryRuntimeFromRoot(root, options);
            return cached;
        },
    });
}
// load one registry and reviewed bundle without external I/O
async function loadRuntimeFromRoot(root) {
    const absoluteRoot = resolve(root);
    let registry;
    // reject relative or normalized test-root aliases
    if (!isAbsolute(root) || root !== absoluteRoot) {
        return disabled("registry_invalid");
    }
    try {
        const rootReal = await realpath(absoluteRoot);
        const rootMetadata = await lstat(absoluteRoot);
        // reject root aliases and special nodes
        if (rootReal !== absoluteRoot ||
            !rootMetadata.isDirectory() ||
            rootMetadata.isSymbolicLink()) {
            throw new RangeError("runtime root is not canonical");
        }
        const registryPath = join(absoluteRoot, FORECAST_ADJUSTMENT_REGISTRY_FILENAME);
        registry = await readRegularJson(registryPath, absoluteRoot);
        validateForecastAdjustmentRegistry(registry);
    }
    catch {
        return disabled("registry_invalid");
    }
    // preserve the reviewed inactive default
    if (registry.activeBundle === null) {
        return disabled("registry_inactive");
    }
    try {
        const active = registry.activeBundle;
        // require the exact closed relative filename
        if (isAbsolute(active.path) ||
            active.path.includes("..") ||
            active.path !== `bundles/sha256-${active.bundleSha256}.json`) {
            throw new RangeError("runtime bundle selection path is invalid");
        }
        const bundleRoot = join(absoluteRoot, "ballydidean");
        const bundlePath = resolve(bundleRoot, active.path);
        // keep reviewed bytes below the one site bundle root
        if (!bundlePath.startsWith(`${bundleRoot}${sep}`)) {
            throw new RangeError("runtime bundle path escapes the site root");
        }
        const bundle = await readRegularJson(bundlePath, absoluteRoot);
        verifyForecastAdjustmentRuntimeBundle(bundle);
        validateForecastAdjustmentRuntimeBundleLinks(registry, bundle);
        // require the calendar runtime used by the fitted hierarchy
        if (!runtimeCalendarFingerprintMatches(bundle.candidate.runtimeFingerprint)) {
            throw new RangeError("runtime calendar fingerprint does not match candidate");
        }
        return deepFreeze({
            bundle: deepFreeze(bundle),
            comparatorAuthority: createMaintenanceShadowServingAuthority({
                artifactBytes: Buffer.from(canonicalJsonBytes(bundle)),
                artifactIdentitySha256: bundle.bundleSha256,
                authorityKind: "legacy_active",
                family: "wind",
                receiptBytes: Buffer.from(canonicalJsonBytes(bundle.qualificationReceipt)),
            }),
            reasonCode: null,
            state: "active",
        });
    }
    catch (error) {
        const code = error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
            ? "bundle_missing"
            : "bundle_invalid";
        return disabled(code);
    }
}
// load one separately reviewed canary bundle
async function loadWindCanaryRuntimeFromRoot(root, options) {
    // let the one-way switch fail raw before filesystem access
    if (forecastAdjustmentWindCanaryIsKilled(options.environmentKillSwitch)) {
        return disabledWindCanary("canary_killed");
    }
    const absoluteRoot = resolve(root);
    let registry;
    // reject relative or normalized roots
    if (!isAbsolute(root) || root !== absoluteRoot) {
        return disabledWindCanary("registry_invalid");
    }
    try {
        const rootReal = await realpath(absoluteRoot);
        const rootMetadata = await lstat(absoluteRoot);
        // reject root aliases and special nodes
        if (rootReal !== absoluteRoot ||
            !rootMetadata.isDirectory() ||
            rootMetadata.isSymbolicLink()) {
            throw new RangeError("wind canary runtime root is not canonical");
        }
        const parsed = await readRegularJson(join(absoluteRoot, FORECAST_ADJUSTMENT_WIND_CANARY_REGISTRY_FILENAME), absoluteRoot);
        // require root-installed qualification before selecting a maintenance package
        if (parsed.contractVersion === "forecast-adjustment-wind-maintenance-registry/v1") {
            if (parsed.activePackage === null) {
                validateMaintenanceRawRegistry(parsed, "wind");
                return disabledWindCanary("policy_raw", createMaintenanceShadowServingAuthority({
                    artifactBytes: null,
                    artifactIdentitySha256: null,
                    authorityKind: "policy_raw",
                    family: "wind",
                    receiptBytes: Buffer.from(canonicalJsonBytes(parsed)),
                }));
            }
            const installed = await loadInstalledMaintenanceServingCandidate({
                family: "wind",
                sourceRoot: resolve(absoluteRoot, "..", ".."),
            });
            if (installed === null) {
                throw new RangeError("wind maintenance serving authority is missing");
            }
            const runtimePackage = installed.bundle;
            // require the fitted calendar runtime before executing the selected package
            if (!runtimeCalendarFingerprintMatches(runtimePackage.candidate.runtimeFingerprint)) {
                throw new RangeError("wind maintenance runtime fingerprint does not match candidate");
            }
            return deepFreeze({
                bundle: {
                    bundleSha256: runtimePackage.bundleSha256,
                    candidate: runtimePackage.candidate,
                    maintenanceAuthority: {
                        actionSha256: installed.receipt.actionSha256,
                        fullMemberRootSha256: installed.receipt.fullMemberRootSha256,
                        policyReportSha256: installed.receipt.policyReportSha256,
                    },
                    maintenanceBundleSha256: runtimePackage.bundleSha256,
                },
                comparatorAuthority: createMaintenanceShadowServingAuthority({
                    artifactBytes: Buffer.from(canonicalJsonBytes(installed.bundle)),
                    artifactIdentitySha256: installed.receipt.bundleSha256,
                    authorityKind: "maintenance_qualified",
                    family: "wind",
                    receiptBytes: Buffer.from(canonicalJsonBytes(installed.receipt)),
                }),
                reasonCode: null,
                state: "active",
            });
        }
        // reject a maintenance registry for the wrong family
        if ("activePackage" in parsed) {
            throw new RangeError("wind maintenance registry family differs");
        }
        // accept only the exact nullable v2 bytes and fixed thirteen-pair mask
        if (parsed.contractVersion === "forecast-adjustment-wind-canary-registry/v2") {
            validateForecastAdjustmentWindCanaryRegistryV2(parsed);
            return disabledWindCanary("policy_raw", createMaintenanceShadowServingAuthority({
                artifactBytes: null,
                artifactIdentitySha256: null,
                authorityKind: "policy_raw",
                family: "wind",
                receiptBytes: Buffer.from(canonicalJsonBytes(parsed)),
            }));
        }
        validateForecastAdjustmentWindCanaryRegistry(parsed);
        registry = parsed;
    }
    catch {
        return disabledWindCanary("registry_invalid");
    }
    // preserve the reviewed inactive default
    if (registry.activeBundle === null) {
        return disabledWindCanary("registry_inactive");
    }
    try {
        const active = registry.activeBundle;
        // require one closed content-addressed filename
        if (isAbsolute(active.path) ||
            active.path.includes("..") ||
            active.path !==
                `wind-canary-bundles/sha256-${active.bundleSha256}.json`) {
            throw new RangeError("wind canary bundle selection path is invalid");
        }
        const bundleRoot = join(absoluteRoot, "ballydidean");
        const bundlePath = resolve(bundleRoot, active.path);
        // keep canary bytes under the site root
        if (!bundlePath.startsWith(`${bundleRoot}${sep}`)) {
            throw new RangeError("wind canary bundle path escapes the site root");
        }
        const bundle = await readRegularJson(bundlePath, absoluteRoot);
        verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
        validateForecastAdjustmentWindCanaryRuntimeBundleLinks(registry, bundle);
        // require the fitted calendar runtime
        if (!runtimeCalendarFingerprintMatches(bundle.candidate.runtimeFingerprint)) {
            throw new RangeError("wind canary runtime fingerprint does not match candidate");
        }
        const now = options.now?.() ?? new Date().toISOString();
        // fail raw outside the explicit authorization
        if (!forecastAdjustmentWindCanaryIsActiveAt(bundle, now)) {
            return disabledWindCanary("canary_expired");
        }
        return deepFreeze({
            bundle: deepFreeze(bundle),
            comparatorAuthority: createMaintenanceShadowServingAuthority({
                artifactBytes: Buffer.from(canonicalJsonBytes(bundle)),
                artifactIdentitySha256: bundle.bundleSha256,
                authorityKind: "legacy_active",
                family: "wind",
                receiptBytes: Buffer.from(canonicalJsonBytes(bundle.authorization)),
            }),
            reasonCode: null,
            state: "active",
        });
    }
    catch (error) {
        const code = error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
            ? "bundle_missing"
            : "bundle_invalid";
        return disabledWindCanary(code);
    }
}
// load one independently selected temperature canary bundle
async function loadTemperatureCanaryRuntimeFromRoot(root, options) {
    // default closed until the operator explicitly enables serving
    if (forecastAdjustmentTemperatureCanaryIsKilled(options.environmentKillSwitch)) {
        return disabledTemperatureCanary("canary_killed");
    }
    const absoluteRoot = resolve(root);
    let registry;
    // reject relative or normalized roots
    if (!isAbsolute(root) || root !== absoluteRoot) {
        return disabledTemperatureCanary("registry_invalid");
    }
    try {
        const rootReal = await realpath(absoluteRoot);
        const rootMetadata = await lstat(absoluteRoot);
        // reject root aliases and special nodes
        if (rootReal !== absoluteRoot ||
            !rootMetadata.isDirectory() ||
            rootMetadata.isSymbolicLink()) {
            throw new RangeError("temperature canary runtime root is not canonical");
        }
        const parsed = await readRegularJson(join(absoluteRoot, FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_REGISTRY_FILENAME), absoluteRoot);
        // require root-installed qualification before selecting a maintenance package
        if (parsed.contractVersion === "forecast-adjustment-temperature-maintenance-registry/v1") {
            if (parsed.activePackage === null) {
                validateMaintenanceRawRegistry(parsed, "temperature");
                return disabledTemperatureCanary("policy_raw", createMaintenanceShadowServingAuthority({
                    artifactBytes: null,
                    artifactIdentitySha256: null,
                    authorityKind: "policy_raw",
                    family: "temperature",
                    receiptBytes: Buffer.from(canonicalJsonBytes(parsed)),
                }));
            }
            const installed = await loadInstalledMaintenanceServingCandidate({
                family: "temperature",
                sourceRoot: resolve(absoluteRoot, "..", ".."),
            });
            if (installed === null) {
                throw new RangeError("temperature maintenance serving authority is missing");
            }
            const runtimePackage = installed.bundle;
            return deepFreeze({
                bundle: {
                    bundleSha256: runtimePackage.bundleSha256,
                    maintenanceAuthority: {
                        actionSha256: installed.receipt.actionSha256,
                        fullMemberRootSha256: installed.receipt.fullMemberRootSha256,
                        policyReportSha256: installed.receipt.policyReportSha256,
                    },
                    maintenancePackage: true,
                    model: runtimePackage.model,
                    servedForecastIdentity: {
                        adapterVersion: runtimePackage.source.adapterVersion,
                        dataset: runtimePackage.source.dataset,
                        maximumReceiptAgeHours: runtimePackage.source.maximumReceiptAgeHours,
                        providerKey: runtimePackage.source.providerKey,
                        sourceDelayHours: runtimePackage.source.sourceDelayHours,
                        upstreamModel: runtimePackage.source.upstreamModel,
                    },
                    trainingForecastIdentity: {
                        cohort: runtimePackage.source.cohort,
                        scope: runtimePackage.source.scope,
                    },
                },
                comparatorAuthority: createMaintenanceShadowServingAuthority({
                    artifactBytes: Buffer.from(canonicalJsonBytes(installed.bundle)),
                    artifactIdentitySha256: installed.receipt.bundleSha256,
                    authorityKind: "maintenance_qualified",
                    family: "temperature",
                    receiptBytes: Buffer.from(canonicalJsonBytes(installed.receipt)),
                }),
                reasonCode: null,
                state: "active",
            });
        }
        // reject a maintenance registry for the wrong family
        if ("activePackage" in parsed) {
            throw new RangeError("temperature maintenance registry family differs");
        }
        // accept only the exact nullable v2 bytes
        if (parsed.contractVersion ===
            "forecast-adjustment-temperature-canary-registry/v2") {
            validateForecastAdjustmentTemperatureCanaryRegistryV2(parsed);
            return disabledTemperatureCanary("policy_raw", createMaintenanceShadowServingAuthority({
                artifactBytes: null,
                artifactIdentitySha256: null,
                authorityKind: "policy_raw",
                family: "temperature",
                receiptBytes: Buffer.from(canonicalJsonBytes(parsed)),
            }));
        }
        validateForecastAdjustmentTemperatureCanaryRegistry(parsed);
        registry = parsed;
    }
    catch {
        return disabledTemperatureCanary("registry_invalid");
    }
    // preserve the reviewed inactive default
    if (registry.activeBundle === null) {
        return disabledTemperatureCanary("registry_inactive");
    }
    try {
        const active = registry.activeBundle;
        // require one closed content-addressed filename
        if (isAbsolute(active.path) ||
            active.path.includes("..") ||
            active.path !==
                `temperature-canary-bundles/sha256-${active.bundleSha256}.json`) {
            throw new RangeError("temperature canary bundle selection path is invalid");
        }
        const bundleRoot = join(absoluteRoot, "ballydidean");
        const bundlePath = resolve(bundleRoot, active.path);
        // keep canary bytes under the one site root
        if (!bundlePath.startsWith(`${bundleRoot}${sep}`)) {
            throw new RangeError("temperature canary bundle path escapes the site root");
        }
        const bundle = await readRegularJson(bundlePath, absoluteRoot);
        verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
        validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks(registry, bundle);
        // require the fitted local-calendar runtime
        if (!temperatureCanaryRuntimeFingerprintMatches(bundle)) {
            throw new RangeError("temperature canary runtime fingerprint mismatch");
        }
        const now = options.now?.() ?? new Date().toISOString();
        // fail raw outside the explicit authorization
        if (!forecastAdjustmentTemperatureCanaryIsActiveAt(bundle, now)) {
            return disabledTemperatureCanary("canary_expired");
        }
        return deepFreeze({
            bundle: deepFreeze(bundle),
            comparatorAuthority: createMaintenanceShadowServingAuthority({
                artifactBytes: Buffer.from(canonicalJsonBytes(bundle)),
                artifactIdentitySha256: bundle.bundleSha256,
                authorityKind: "legacy_active",
                family: "temperature",
                receiptBytes: Buffer.from(canonicalJsonBytes(bundle.authorization)),
            }),
            reasonCode: null,
            state: "active",
        });
    }
    catch (error) {
        const code = error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
            ? "bundle_missing"
            : "bundle_invalid";
        return disabledTemperatureCanary(code);
    }
}
// read one regular in-root JSON file
async function readRegularJson(path, root) {
    const absoluteRoot = resolve(root);
    const target = resolve(path);
    await verifyCanonicalDirectoryPath(absoluteRoot);
    // reject lexical escapes before filesystem traversal
    if (!isAbsolute(path) ||
        target === absoluteRoot ||
        !target.startsWith(`${absoluteRoot}${sep}`)) {
        throw new RangeError("runtime file is not a canonical regular file");
    }
    const relativeSegments = target.slice(absoluteRoot.length + 1).split(sep);
    let cursor = absoluteRoot;
    // verify every in-root path component without following links
    for (let index = 0; index < relativeSegments.length; index += 1) {
        cursor = join(cursor, relativeSegments[index]);
        const metadata = await lstat(cursor);
        const canonical = await realpath(cursor);
        const last = index === relativeSegments.length - 1;
        // reject symlinks, aliases, nonregular files, and intermediate special nodes
        if (metadata.isSymbolicLink() ||
            canonical !== cursor ||
            !canonical.startsWith(`${absoluteRoot}${sep}`) ||
            (last ? !metadata.isFile() : !metadata.isDirectory())) {
            throw new RangeError("runtime file is not a canonical regular file");
        }
    }
    const before = await lstat(target);
    const beforeReal = await realpath(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        // bind the opened descriptor to the validated path node
        if (!opened.isFile() ||
            !sameFileMetadata(before, opened) ||
            beforeReal !== target) {
            throw new RangeError("runtime file changed before open");
        }
        const bytes = (await handle.readFile()).toString("utf8");
        const openedAfter = await handle.stat();
        const after = await lstat(target);
        const afterReal = await realpath(target);
        // reject path, inode, or size replacement during the read
        if (!sameFileMetadata(opened, openedAfter) ||
            !sameFileMetadata(opened, after) ||
            afterReal !== beforeReal) {
            throw new RangeError("runtime file changed during read");
        }
        const parsed = JSON.parse(bytes);
        // require exact canonical registry and bundle bytes
        if (bytes !== canonicalJsonBytes(parsed)) {
            throw new RangeError("runtime file bytes are not canonical JSON");
        }
        return parsed;
    }
    finally {
        await handle.close();
    }
}
// require every absolute directory component to be canonical
async function verifyCanonicalDirectoryPath(path) {
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
        if (metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            canonical !== cursor) {
            throw new RangeError("runtime root must be an absolute canonical directory");
        }
    }
}
// compare the stable runtime file identity fields
function sameFileMetadata(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
// validate the closed nullable temperature registry
function validateForecastAdjustmentTemperatureCanaryRegistryV2(registry) {
    const keys = Object.keys(registry);
    // reject unknown, missing, or reordered raw fields
    if (keys.join(",") !== "activeBundle,contractVersion,rawReason,siteKey" ||
        registry.activeBundle !== null ||
        registry.rawReason !== "policy_raw" ||
        registry.siteKey !== "ballydidean" ||
        canonicalJsonBytes(registry).length !==
            FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_RAW_REGISTRY_BYTES ||
        canonicalSha256(registry) !==
            FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_RAW_REGISTRY_SHA256) {
        throw new RangeError("temperature maintenance raw registry is invalid");
    }
}
// validate one actionless raw maintenance registry
function validateMaintenanceRawRegistry(registry, family) {
    // reject every active selector and extension field on the raw branch
    if (Object.keys(registry).join(",") !== "activePackage,contractVersion,rawReason,siteKey" ||
        registry.activePackage !== null || registry.rawReason !== "policy_raw" ||
        registry.siteKey !== "ballydidean" ||
        registry.contractVersion !== `forecast-adjustment-${family}-maintenance-registry/v1`) {
        throw new RangeError(`${family} maintenance raw registry is invalid`);
    }
}
// validate the closed nullable wind registry and exact mask
function validateForecastAdjustmentWindCanaryRegistryV2(registry) {
    const keys = Object.keys(registry);
    // reject unknown, missing, reordered, or expanded raw fields
    if (keys.join(",") !==
        "activeBundle,contractVersion,enabledMetricBands,rawReason,siteKey" ||
        registry.activeBundle !== null ||
        registry.rawReason !== "policy_raw" ||
        registry.siteKey !== "ballydidean" ||
        JSON.stringify(registry.enabledMetricBands) !==
            JSON.stringify(FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS) ||
        canonicalJsonBytes(registry).length !==
            FORECAST_ADJUSTMENT_WIND_CANARY_RAW_REGISTRY_BYTES ||
        canonicalSha256(registry) !==
            FORECAST_ADJUSTMENT_WIND_CANARY_RAW_REGISTRY_SHA256) {
        throw new RangeError("wind maintenance raw registry is invalid");
    }
}
// create one deeply frozen disabled provider
function disabled(reasonCode) {
    return deepFreeze({ bundle: null, reasonCode, state: "disabled" });
}
// create one deeply frozen disabled canary provider
function disabledWindCanary(reasonCode, comparatorAuthority) {
    return deepFreeze({
        bundle: null,
        ...(comparatorAuthority === undefined ? {} : { comparatorAuthority }),
        reasonCode,
        state: "disabled",
    });
}
// create one deeply frozen disabled temperature canary
function disabledTemperatureCanary(reasonCode, comparatorAuthority) {
    return deepFreeze({
        bundle: null,
        ...(comparatorAuthority === undefined ? {} : { comparatorAuthority }),
        reasonCode,
        state: "disabled",
    });
}
