import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  ADJUSTMENT_FIT_FAMILY_ENTRIES,
  ADJUSTMENT_FIT_INPUT_MAXIMUM_BYTES,
  inspectAdjustmentFitSnapshot,
  runAdjustmentFitSandbox,
} from "./adjustment_fit_sandbox.mjs";

export const ADJUSTMENT_FIT_INPUTS_CONTRACT_VERSION =
  "adjustment-fit-input-snapshots/v1";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const TMPFS_ROOT = "/dev/shm";
const CODE_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
const FORECAST_SNAPSHOT_ROOT =
  "scripts/research/adjustment-maintenance-runtime/forecast";
const DOMAIN_SNAPSHOT_ROOT =
  "scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/dist";
const WORKER_SNAPSHOT_ROOT =
  "scripts/research/adjustment-maintenance-runtime/worker";
const SAFE_RELATIVE_PATH = /^(?:[A-Za-z0-9@._-]+\/)*[A-Za-z0-9@._-]+$/u;
const PRIVATE_KEY_PATTERN =
  /(?:password|secret|credential|private.?key|access.?token|refresh.?token|ssh.?(?:auth|agent|key)|dbus|archive.?root|repository.?root)/iu;
const PRIVATE_VALUE_PATTERN =
  /(?:-----BEGIN [^-]*PRIVATE KEY-----|\/(?:home|root|mnt)(?:\/|$)|\.ssh(?:\/|$)|SSH_AUTH_SOCK|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|DBUS_SESSION_BUS_ADDRESS)/u;
const ISSUED_SNAPSHOT_PAIRS = new WeakSet();

const FORECAST_ADJUSTMENT_JAVASCRIPT = Object.freeze([
  "algorithm-v1.js",
  "apply.js",
  "bootstrap-v1.js",
  "calendar.js",
  "candidate.js",
  "evaluate.js",
  "evidence.js",
  "holdout-ledger.js",
  "index.js",
  "maintenance-capture-epoch.js",
  "maintenance-policy.js",
  "maintenance-revision-projection.js",
  "maintenance-runtime-package.js",
  "maintenance-shadow-catalog.js",
  "maintenance-shadow-comparator.js",
  "maintenance-shadow-values.js",
  "performance-scorecard.js",
  "rain-hurdle-wind-artifact.js",
  "rain-hurdle-wind.js",
  "rain-maintenance-controls.js",
  "rain-fixed-gauge-target.js",
  "rain-runtime-registry.js",
  "runtime-bundle.js",
  "runtime-loader.js",
  "temperature-analog-research.js",
  "temperature-analog-shrinkage.js",
  "temperature-analog-stress-validation.js",
  "temperature-analog-validation.js",
  "temperature-canary.js",
  "temperature-causal-guard.js",
  "temperature-frozen-replay.js",
  "temperature-lead-research.js",
  "temperature-live-replay-events.js",
  "temperature-mos-runtime.js",
  "temperature-nowcast-research.js",
  "temperature-weather-research.js",
  "wind-canary.js",
]);

const DOMAIN_JAVASCRIPT = Object.freeze([
  "forecast-adjustment.js",
  "forecast-anchor-record.js",
  "index.js",
  "ingestion.js",
  "provenance.js",
  "rain-collection.js",
  "weather-record.js",
]);

const RAIN_PYTHON = Object.freeze([
  "build_moisture_targets.py",
  "build_rain_sub24.py",
  "export_moisture_history.py",
  "export_rain_wind_runtime.py",
  "rain_context.py",
  "rain_context_features.py",
  "rain_event_guard.py",
  "rain_hurdle.py",
  "rain_hurdle_calibration.py",
  "rain_ordinal.py",
  "rain_recency.py",
  "rain_recency_calibration.py",
  "rain_refresh.py",
  "rain_residual.py",
  "rain_search.py",
  "rain_sub24.py",
  "rain_trajectory.py",
  "rain_trajectory_features.py",
  "rain_wind.py",
  "rain_wind_features.py",
  "rain_wind_source.py",
  "retain_moisture_research.py",
  "run_rain_sub24.py",
]);

// declare one reviewed source-to-snapshot copy
function codeFile(source, destination = source) {
  return Object.freeze({ destination, source });
}

// map one committed snapshot into an ordinary regular-file package tree
function packageFiles(packageRoot, snapshotRoot, destinationRoot, files) {
  return [
    codeFile(`${packageRoot}/package.json`, `${destinationRoot}/package.json`),
    ...files.map((name) =>
      codeFile(`${snapshotRoot}/${name}`, `${destinationRoot}/dist/${name}`)),
  ];
}

const TEMPERATURE_CODE_FILES = Object.freeze([
  codeFile("scripts/research/temperature_refresh.py"),
  codeFile("scripts/research/temperature_shortlead_models.py"),
  codeFile("scripts/research/temperature_seasonal_ridge.py"),
  ...packageFiles(
    "packages/forecast-adjustment",
    FORECAST_SNAPSHOT_ROOT,
    "packages/forecast-adjustment",
    ["calendar.js", "temperature-mos-runtime.js"],
  ),
]);

const RAIN_CODE_FILES = Object.freeze([
  ...RAIN_PYTHON.map((name) => codeFile(`scripts/research/${name}`)),
  ...packageFiles(
    "packages/forecast-adjustment",
    FORECAST_SNAPSHOT_ROOT,
    "packages/forecast-adjustment",
    FORECAST_ADJUSTMENT_JAVASCRIPT,
  ),
  ...packageFiles(
    "packages/domain",
    DOMAIN_SNAPSHOT_ROOT,
    "node_modules/@weather/domain",
    DOMAIN_JAVASCRIPT,
  ),
]);

const WIND_CODE_FILES = Object.freeze([
  codeFile("apps/worker/package.json"),
  codeFile(`${WORKER_SNAPSHOT_ROOT}/forecast-adjustment-wind-refresh-cli.js`,
    "apps/worker/dist/forecast-adjustment-wind-refresh-cli.js"),
  ...packageFiles(
    "packages/forecast-adjustment",
    FORECAST_SNAPSHOT_ROOT,
    "node_modules/@weather/forecast-adjustment",
    FORECAST_ADJUSTMENT_JAVASCRIPT,
  ),
  ...packageFiles(
    "packages/domain",
    DOMAIN_SNAPSHOT_ROOT,
    "node_modules/@weather/domain",
    DOMAIN_JAVASCRIPT,
  ),
]);

const CODE_FILES = Object.freeze({
  rain: RAIN_CODE_FILES,
  temperature: TEMPERATURE_CODE_FILES,
  wind: WIND_CODE_FILES,
});

export const ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST = Object.freeze(
  Object.fromEntries(Object.entries(CODE_FILES).map(([family, files]) => [
    family,
    Object.freeze(files.map(({ destination, source }) =>
      Object.freeze({ destination, source }))),
  ])),
);

// create hash-bound code and canonical input snapshots on native tmpfs
async function createAdjustmentFitSnapshots(request) {
  requireExactKeys(request, ["family", "input"], "fit snapshot request");
  const family = requireFamily(request.family);
  rejectPrivateMaterial(request.input);
  const inputBytes = Buffer.from(`${canonicalJson(request.input)}\n`);

  // refuse decoded input before creating any transient directory
  if (inputBytes.length > ADJUSTMENT_FIT_INPUT_MAXIMUM_BYTES) {
    throw new RangeError("fit input exceeds 512 MiB");
  }

  let codeRoot = null;
  let inputRoot = null;
  let completed = false;

  try {
    codeRoot = await privateRoot("weather-adjustment-fit-code-");
    inputRoot = await privateRoot("weather-adjustment-fit-input-");
    let codeBytes = 0;

    // copy only the closed family source set into ordinary regular files
    for (const file of CODE_FILES[family]) {
      codeBytes += await copyReviewedFile(codeRoot, file);

      // stop an unexpectedly expanded build before the snapshot is usable
      if (codeBytes > CODE_MAXIMUM_BYTES) {
        throw new RangeError("fit code snapshot exceeds 64 MiB");
      }
    }

    const entry = ADJUSTMENT_FIT_FAMILY_ENTRIES[family];
    await writeImmutableFile(inputRoot, entry.inputFilename, inputBytes);
    const codeSnapshot = await inspectAdjustmentFitSnapshot(codeRoot, "code");
    const inputSnapshot = await inspectAdjustmentFitSnapshot(inputRoot, "input");
    completed = true;
    const snapshots = Object.freeze({
      codeRoot,
      codeSnapshot,
      contractVersion: ADJUSTMENT_FIT_INPUTS_CONTRACT_VERSION,
      family,
      inputRoot,
      inputSnapshot,
    });
    ISSUED_SNAPSHOT_PAIRS.add(snapshots);
    return snapshots;
  } finally {
    // remove every partial snapshot when construction fails
    if (!completed) {
      await removeRoots([inputRoot, codeRoot]);
    }
  }
}

// run one fixed family and destroy both snapshots on every exit path
export async function runAdjustmentFitWithInput(request) {
  requireExactKeys(request, [
    "family",
    "input",
    "runtimeReadiness",
    "runtimeReadinessSha256",
  ], "fit input run request");
  // pass only hash-bound roots into the fixed launcher callback
  return withAdjustmentFitSnapshots({
    family: request.family,
    input: request.input,
  }, async (snapshots) =>
    runAdjustmentFitSandbox({
      codeRoot: snapshots.codeRoot,
      codeSnapshotSha256: snapshots.codeSnapshot.rootSha256,
      family: snapshots.family,
      inputRoot: snapshots.inputRoot,
      inputSnapshotSha256: snapshots.inputSnapshot.rootSha256,
      runtimeReadiness: request.runtimeReadiness,
      runtimeReadinessSha256: request.runtimeReadinessSha256,
    }));
}

// expose snapshots only for one bounded operation and always destroy them
export async function withAdjustmentFitSnapshots(request, operation) {
  // reject nonfunctions before allocating either snapshot
  if (typeof operation !== "function") {
    throw new RangeError("fit snapshot operation is invalid");
  }

  const snapshots = await createAdjustmentFitSnapshots(request);

  try {
    return await operation(snapshots);
  } finally {
    // tolerate the launcher's earlier cleanup while closing prelaunch failures
    await destroyAdjustmentFitSnapshots(snapshots);
  }
}

// remove one exact issued snapshot pair without accepting other paths
async function destroyAdjustmentFitSnapshots(snapshots) {
  requireExactKeys(snapshots, [
    "codeRoot",
    "codeSnapshot",
    "contractVersion",
    "family",
    "inputRoot",
    "inputSnapshot",
  ], "fit snapshots");

  // reject caller-shaped deletion targets and copied receipts
  if (
    !ISSUED_SNAPSHOT_PAIRS.has(snapshots) ||
    snapshots.contractVersion !== ADJUSTMENT_FIT_INPUTS_CONTRACT_VERSION ||
    !isSnapshotRoot(snapshots.codeRoot, "weather-adjustment-fit-code-") ||
    !isSnapshotRoot(snapshots.inputRoot, "weather-adjustment-fit-input-")
  ) {
    throw new RangeError("fit snapshot roots are invalid");
  }

  try {
    await removeRoots([snapshots.inputRoot, snapshots.codeRoot]);
  } finally {
    // prevent a retained receipt from deleting a later reused path
    ISSUED_SNAPSHOT_PAIRS.delete(snapshots);
  }
}

// create one direct owner-private root on the native shared-memory tmpfs
async function privateRoot(prefix) {
  const root = await mkdtemp(`${TMPFS_ROOT}/${prefix}`);
  await chmod(root, 0o700);
  return root;
}

// copy one reviewed source through stable no-follow descriptors
async function copyReviewedFile(codeRoot, file) {
  validateRelativePath(file.source);
  validateRelativePath(file.destination);
  const source = join(REPOSITORY_ROOT, file.source);
  const before = await lstat(source);
  const canonical = await realpath(source);

  // reject build links, foreign files, world-writable code, and path aliases
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid() ||
    before.nlink !== 1 ||
    (before.mode & 0o002) !== 0 ||
    canonical !== source
  ) {
    throw new RangeError(`reviewed fit source is invalid: ${file.source}`);
  }

  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;

  try {
    const opened = await handle.stat();

    // bind copied bytes to the inspected source inode
    if (!sameFile(before, opened)) {
      throw new RangeError(`reviewed fit source changed: ${file.source}`);
    }

    bytes = await handle.readFile();
    const after = await handle.stat();

    // reject mutation while copying public code
    if (!sameFile(opened, after)) {
      throw new RangeError(`reviewed fit source changed: ${file.source}`);
    }
  } finally {
    await handle.close();
  }

  await writeImmutableFile(codeRoot, file.destination, bytes);
  return bytes.length;
}

// write one new owner-readable regular file beneath a fresh snapshot root
async function writeImmutableFile(root, relativePath, bytes) {
  validateRelativePath(relativePath);
  const destination = join(root, relativePath);
  await createPrivateParents(root, dirname(relativePath));
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await chmod(destination, 0o400);
}

// create every destination directory inside the already private root
async function createPrivateParents(root, relativeDirectory) {
  // keep root-level files from creating an alternate path
  if (relativeDirectory === ".") {
    return;
  }

  validateRelativePath(`${relativeDirectory}/leaf`);
  let current = root;

  // create and verify each fixed destination component
  for (const component of relativeDirectory.split("/")) {
    current = join(current, component);
    await mkdir(current, { mode: 0o700, recursive: true });
    const metadata = await lstat(current);

    // require ordinary private directories instead of linked package trees
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new RangeError("fit snapshot directory is invalid");
    }
  }
}

// reject traversal and alternate spellings in reviewed relative paths
function validateRelativePath(value) {
  // accept only one normalized portable relative spelling
  if (
    typeof value !== "string" ||
    !SAFE_RELATIVE_PATH.test(value) ||
    value.includes("..") ||
    resolve("/snapshot", value) !== join("/snapshot", value)
  ) {
    throw new RangeError("fit snapshot path is invalid");
  }
}

// accept only the three fixed family keys
function requireFamily(value) {
  // reject inherited keys and alternate family spellings
  if (!Object.hasOwn(CODE_FILES, value)) {
    throw new RangeError("fit snapshot family is invalid");
  }
  return value;
}

// reject credential-shaped fields and host-private string values recursively
function rejectPrivateMaterial(value, ancestors = new Set()) {
  // inspect array members without changing their semantic order
  if (Array.isArray(value)) {
    // reject recursive arrays before descending
    if (ancestors.has(value)) {
      throw new RangeError("fit input contains a cycle");
    }
    ancestors.add(value);

    // inspect every input member before serialization
    for (const item of value) {
      rejectPrivateMaterial(item, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  // inspect every object key and nested value
  if (value !== null && typeof value === "object") {
    // reject non-json objects and cyclic authority wrappers
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) {
      throw new RangeError("fit input contains a non-json object");
    }

    // reject recursive objects before descending
    if (ancestors.has(value)) {
      throw new RangeError("fit input contains a cycle");
    }
    ancestors.add(value);

    // inspect every declared input field
    for (const [key, item] of Object.entries(value)) {
      // reject private control material by field identity
      if (PRIVATE_KEY_PATTERN.test(key)) {
        throw new RangeError("fit input contains private fields");
      }
      rejectPrivateMaterial(item, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  // reject host paths and credential markers in string leaves
  if (typeof value === "string" && PRIVATE_VALUE_PATTERN.test(value)) {
    throw new RangeError("fit input contains private values");
  }
}

// serialize one finite json value with recursively sorted object keys
function canonicalJson(value, ancestors = new Set()) {
  // retain array order while rejecting cycles
  if (Array.isArray(value)) {
    // reject recursive arrays before descending
    if (ancestors.has(value)) {
      throw new RangeError("fit input contains a cycle");
    }
    ancestors.add(value);
    const output = `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return output;
  }

  // sort ordinary object fields before serialization
  if (value !== null && typeof value === "object") {
    // reject recursive objects before descending
    if (ancestors.has(value)) {
      throw new RangeError("fit input contains a cycle");
    }
    ancestors.add(value);
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareJsonKeys(left, right));
    const output = `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`).join(",")}}`;
    ancestors.delete(value);
    return output;
  }

  // reject nonfinite numbers and unsupported json primitives
  if (
    (typeof value === "number" && !Number.isFinite(value)) ||
    !["boolean", "number", "string"].includes(typeof value) && value !== null
  ) {
    throw new RangeError("fit input is not finite json");
  }

  return JSON.stringify(value);
}

// compare json keys without locale-dependent ordering
function compareJsonKeys(left, right) {
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

// require one exact closed object field set
function requireExactKeys(value, expected, name) {
  // reject nonobjects before field enumeration
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${name} is invalid`);
  }

  const actual = Object.keys(value).sort();
  const required = [...expected].sort();

  // reject missing and additional fields together
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new RangeError(`${name} fields are invalid`);
  }
}

// compare source identity and mutation-sensitive metadata
function sameFile(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs;
}

// constrain cleanup to direct fitter roots on native tmpfs
function isSnapshotRoot(value, prefix) {
  return typeof value === "string" &&
    dirname(value) === TMPFS_ROOT &&
    basename(value).startsWith(prefix);
}

// remove only roots created by this module
async function removeRoots(roots) {
  // remove each completed or partial root independently
  for (const root of roots) {
    // ignore absent partial roots while rejecting other paths
    if (root !== null) {
      await rm(root, { force: true, recursive: true });
    }
  }
}
