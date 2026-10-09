import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const ADJUSTMENT_FIT_SANDBOX_CONTRACT_VERSION =
  "adjustment-fit-sandbox/v1";
export const ADJUSTMENT_FIT_RUNTIME_READINESS_VERSION =
  "adjustment-fit-runtime-readiness/v1";
export const ADJUSTMENT_FIT_SNAPSHOT_VERSION =
  "adjustment-fit-snapshot/v1";
export const ADJUSTMENT_FIT_INPUT_MAXIMUM_BYTES = 512 * 1_024 * 1_024;
export const ADJUSTMENT_FIT_OUTPUT_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
export const ADJUSTMENT_FIT_CANDIDATE_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
export const ADJUSTMENT_FIT_LOG_MAXIMUM_BYTES = 1 * 1_024 * 1_024;

export const ADJUSTMENT_FIT_ENVIRONMENT = Object.freeze({
  HOME: "/home/sandbox",
  PATH: "/runtime:/usr/bin:/bin",
  PYTHONPATH: "/runtime/site-packages",
  PYTHONDONTWRITEBYTECODE: "1",
  TZ: "UTC",
  LC_ALL: "C.UTF-8",
  OMP_NUM_THREADS: "1",
  OPENBLAS_NUM_THREADS: "1",
  MKL_NUM_THREADS: "1",
  NUMEXPR_NUM_THREADS: "1",
  VECLIB_MAXIMUM_THREADS: "1",
  BLIS_NUM_THREADS: "1",
  PWD: "/input/code",
});

export const ADJUSTMENT_FIT_FAMILY_ENTRIES = Object.freeze({
  rain: Object.freeze({
    command: "/runtime/python",
    inputFilename: "rain.json",
    outputFilename: "rain.json",
    arguments: Object.freeze([
      "scripts/research/rain_refresh.py",
      "--fit-only",
    ]),
  }),
  temperature: Object.freeze({
    command: "/runtime/python",
    inputFilename: "temperature.json",
    outputFilename: "temperature.json",
    arguments: Object.freeze([
      "scripts/research/temperature_refresh.py",
      "--fit-only",
    ]),
  }),
  wind: Object.freeze({
    command: "/runtime/node",
    inputFilename: "wind.json",
    outputFilename: "wind.json",
    arguments: Object.freeze([
      "apps/worker/dist/forecast-adjustment-wind-refresh-cli.js",
      "--fit-only",
    ]),
  }),
});

export const ADJUSTMENT_FIT_SYSTEMD_PROPERTIES = Object.freeze([
  "MemoryMax=8G",
  "MemorySwapMax=0",
  "CPUQuota=800%",
  "TasksMax=64",
  "RuntimeMaxSec=4h",
  "LimitFSIZE=67108864",
  "LimitNOFILE=64",
  "Nice=10",
  "IOSchedulingClass=best-effort",
  "IOSchedulingPriority=7",
]);

const BWRAP_PATH = "/usr/bin/bwrap";
const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const NODE_PATH = "/home/ubuntu/n/bin/node";
const PYTHON_PATH =
  "/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/bin/python3.14";
const PYTHON_CELLAR_LIB =
  "/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/lib";
const PYTHON_STDLIB = `${PYTHON_CELLAR_LIB}/python3.14`;
const LINUXBREW_LIB = "/home/linuxbrew/.linuxbrew/lib";
const PRODUCTION_NUMERICAL_RUNTIME =
  "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1/lib/python3.14/site-packages";
const TMPFS_ROOT = "/dev/shm";
const TMPFS_MAGIC = 0x01021994;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const PRIVATE_KEY_PATTERN =
  /(?:password|secret|credential|private.?key|github.?token|archive.?root|key.?path|agent.?socket|dbus)/iu;
const PRIVATE_VALUE_PATTERN =
  /(?:-----BEGIN [^-]*PRIVATE KEY-----|\/home\/ubuntu(?:\/|$)|\/mnt\/|\.ssh(?:\/|$)|SSH_AUTH_SOCK|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|DBUS_SESSION_BUS_ADDRESS)/u;
const CANONICAL_NUMBER_PATTERN =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/u;
const execFileAsync = promisify(execFile);

// classify one closed sandbox failure
export class AdjustmentFitSandboxError extends Error {
  // retain one stable machine reason without raw child output
  constructor(reason, message) {
    super(message);
    this.name = "AdjustmentFitSandboxError";
    this.reason = reason;
  }
}

// capture the exact fixed host runtime for a reviewed readiness receipt
export async function captureAdjustmentFitRuntimeReadiness(
  numericalRuntimeRoot = PRODUCTION_NUMERICAL_RUNTIME,
) {
  await requireAllowedNumericalRuntimeRoot(numericalRuntimeRoot);
  const versions = await fixedRuntimeVersions();
  const manifest = {
    bwrap: await fileIdentity(BWRAP_PATH, 0),
    contractVersion: ADJUSTMENT_FIT_RUNTIME_READINESS_VERSION,
    linuxbrewLib: await treeIdentity(LINUXBREW_LIB, { allowLinks: true }),
    node: await fileIdentity(NODE_PATH, process.getuid()),
    numericalSitePackages: await treeIdentity(numericalRuntimeRoot, {
      allowHardLinks: true,
      allowLinks: false,
      ownerPrivate: true,
    }),
    python: await fileIdentity(PYTHON_PATH, process.getuid()),
    pythonCellarLib: await treeIdentity(PYTHON_CELLAR_LIB, {
      allowLinks: true,
    }),
    pythonStdlib: await treeIdentity(PYTHON_STDLIB, { allowLinks: false }),
    systemDirectories: await Promise.all([
      directoryIdentity("/usr", 0),
      directoryIdentity("/usr/lib", 0),
      directoryIdentity("/usr/lib64", 0),
    ]),
    systemctl: await fileIdentity(SYSTEMCTL_PATH, 0),
    systemdRun: await fileIdentity(SYSTEMD_RUN_PATH, 0),
    versions,
  };
  await validateNumericalPackageMarkers(numericalRuntimeRoot);
  await validateNumericalRuntimeImports(numericalRuntimeRoot);
  return Object.freeze(manifest);
}

// hash one readiness receipt with canonical object ordering
export function hashAdjustmentFitRuntimeReadiness(manifest) {
  return sha256(Buffer.from(canonicalJson(manifest)));
}

// describe one immutable regular-file-only tmpfs snapshot
export async function inspectAdjustmentFitSnapshot(root, kind) {
  const expectedPrefix = kind === "code"
    ? "weather-adjustment-fit-code-"
    : kind === "input" ? "weather-adjustment-fit-input-" : null;

  // reject unknown snapshot roles
  if (expectedPrefix === null) {
    throw sandboxError("snapshot_invalid", "fit snapshot kind is invalid");
  }

  const canonicalRoot = await requirePrivateTmpfsRoot(root, expectedPrefix);
  const identity = await treeIdentity(canonicalRoot, {
    allowLinks: false,
    errorReason: "snapshot_invalid",
    ownerPrivate: true,
  });

  // keep raw inputs inside the frozen half-gibibyte ceiling
  if (kind === "input" && identity.totalBytes > ADJUSTMENT_FIT_INPUT_MAXIMUM_BYTES) {
    throw sandboxError("snapshot_invalid", "fit input snapshot exceeds 512 MiB");
  }

  return Object.freeze({
    contractVersion: ADJUSTMENT_FIT_SNAPSHOT_VERSION,
    fileCount: identity.fileCount,
    kind,
    rootSha256: identity.treeSha256,
    totalBytes: identity.totalBytes,
  });
}

// construct the exact cve-safe bubblewrap argument order
export function buildAdjustmentFitSandboxArgv(input) {
  requireExactKeys(
    input,
    ["codeRoot", "dataRoot", "family", "numericalRuntimeRoot"],
    "sandbox argv input",
  );
  const family = requireFamily(input.family);
  const entry = ADJUSTMENT_FIT_FAMILY_ENTRIES[family];
  const directories = [
    "/usr",
    "/lib",
    "/lib64",
    "/home",
    "/home/sandbox",
    "/home/linuxbrew",
    "/home/linuxbrew/.linuxbrew",
    "/home/linuxbrew/.linuxbrew/lib",
    "/home/linuxbrew/.linuxbrew/Cellar",
    "/home/linuxbrew/.linuxbrew/Cellar/python@3.14",
    "/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7",
    PYTHON_CELLAR_LIB,
    PYTHON_STDLIB,
    "/run",
    "/tmp",
    "/proc",
    "/dev",
    "/runtime",
    "/runtime/site-packages",
    "/input",
    "/input/code",
    "/input/data",
    "/output",
  ];
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--clearenv",
    "--cap-drop",
    "ALL",
  ];

  // precreate every trusted and untrusted bind destination
  for (const directory of directories) {
    argv.push("--dir", directory);
  }

  argv.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/run",
    "--tmpfs", "/tmp",
    "--perms", "0700",
    "--tmpfs", "/home/sandbox",
    "--ro-bind", "/dev/null", "/runtime/python",
    "--ro-bind", "/dev/null", "/runtime/node",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/usr/lib", "/lib",
    "--ro-bind", "/usr/lib64", "/lib64",
    "--ro-bind", LINUXBREW_LIB, LINUXBREW_LIB,
    "--ro-bind", PYTHON_CELLAR_LIB, PYTHON_CELLAR_LIB,
    "--ro-bind", PYTHON_STDLIB, PYTHON_STDLIB,
    "--ro-bind", PYTHON_PATH, "/runtime/python",
    "--ro-bind", NODE_PATH, "/runtime/node",
    "--ro-bind", input.numericalRuntimeRoot, "/runtime/site-packages",
    "--size", String(ADJUSTMENT_FIT_OUTPUT_MAXIMUM_BYTES),
    "--perms", "0700",
    "--tmpfs", "/output",
    "--ro-bind", input.codeRoot, "/input/code",
    "--ro-bind", input.dataRoot, "/input/data",
    "--chdir", "/input/code",
  );

  // restore only the exact thirteen reviewed environment entries
  for (const [key, value] of Object.entries(ADJUSTMENT_FIT_ENVIRONMENT)) {
    argv.push("--setenv", key, value);
  }

  argv.push(entry.command, ...entry.arguments);
  return Object.freeze(argv);
}

// construct the fixed outer user-systemd resource envelope
export function buildAdjustmentFitSystemdArgv(unitName, bwrapArgv) {
  // reject caller syntax in the transient unit identity
  if (!/^weather-adjustment-fit-[a-f0-9]{32}\.service$/u.test(unitName)) {
    throw sandboxError("runtime_invalid", "fit systemd unit name is invalid");
  }

  const argv = [
    "--user",
    "--wait",
    "--collect",
    "--quiet",
    "--pipe",
    `--unit=${unitName}`,
  ];

  // apply every reviewed service resource property
  for (const property of ADJUSTMENT_FIT_SYSTEMD_PROPERTIES) {
    argv.push(`--property=${property}`);
  }

  argv.push(BWRAP_PATH, ...bwrapArgv);
  return Object.freeze(argv);
}

// execute one fixed family entry and return only sanitized candidate bytes
export async function runAdjustmentFitSandbox(request) {
  requireExactKeys(request, [
    "codeRoot",
    "codeSnapshotSha256",
    "family",
    "inputRoot",
    "inputSnapshotSha256",
    "runtimeReadiness",
    "runtimeReadinessSha256",
  ], "sandbox request");
  const family = requireFamily(request.family);
  requireSha256(request.codeSnapshotSha256, "codeSnapshotSha256");
  requireSha256(request.inputSnapshotSha256, "inputSnapshotSha256");
  requireSha256(request.runtimeReadinessSha256, "runtimeReadinessSha256");
  let codeRoot = null;
  let inputRoot = null;
  let unitName = null;

  try {
    codeRoot = await requirePrivateTmpfsRoot(
      request.codeRoot,
      "weather-adjustment-fit-code-",
    );
    inputRoot = await requirePrivateTmpfsRoot(
      request.inputRoot,
      "weather-adjustment-fit-input-",
    );
    await verifyRuntimeReadiness(
      request.runtimeReadiness,
      request.runtimeReadinessSha256,
    );
    const codeSnapshot = await inspectAdjustmentFitSnapshot(codeRoot, "code");
    const inputSnapshot = await inspectAdjustmentFitSnapshot(inputRoot, "input");

    // bind the exact caller-authorized immutable snapshot identities
    if (
      codeSnapshot.rootSha256 !== request.codeSnapshotSha256 ||
      inputSnapshot.rootSha256 !== request.inputSnapshotSha256
    ) {
      throw sandboxError("snapshot_invalid", "fit snapshot hash is invalid");
    }

    const entry = ADJUSTMENT_FIT_FAMILY_ENTRIES[family];
    await requireSnapshotFile(codeRoot, entry.arguments[0]);
    await requireSnapshotFile(inputRoot, entry.inputFilename);
    const bwrapArgv = buildAdjustmentFitSandboxArgv({
      codeRoot,
      dataRoot: inputRoot,
      family,
      numericalRuntimeRoot: request.runtimeReadiness.numericalSitePackages.path,
    });
    unitName = `weather-adjustment-fit-${randomUUID().replaceAll("-", "")}.service`;
    const systemdArgv = buildAdjustmentFitSystemdArgv(unitName, bwrapArgv);
    const processReport = await executeBounded(unitName, systemdArgv);
    const candidate = sanitizeCandidateStdout(processReport.stdoutBytes);
    return Object.freeze({
      candidateJson: candidate.text,
      candidateSha256: candidate.sha256,
      codeSnapshotSha256: codeSnapshot.rootSha256,
      contractVersion: ADJUSTMENT_FIT_SANDBOX_CONTRACT_VERSION,
      family,
      inputSnapshotSha256: inputSnapshot.rootSha256,
      runtimeReadinessSha256: request.runtimeReadinessSha256,
      stderr: processReport.stderr,
      stdout: processReport.stdout,
    });
  } finally {
    // stop the complete transient cgroup before destroying private tmpfs data
    if (unitName !== null) {
      await killTransientUnit(unitName);
    }

    // destroy raw output and both exclusive snapshots on every exit path
    for (const root of [inputRoot, codeRoot]) {
      if (root !== null) {
        await rm(root, { force: true, recursive: true });
      }
    }
  }
}

// verify the stored receipt before any family process starts
async function verifyRuntimeReadiness(manifest, expectedSha256) {
  requireExactKeys(manifest, [
    "bwrap",
    "contractVersion",
    "linuxbrewLib",
    "node",
    "numericalSitePackages",
    "python",
    "pythonCellarLib",
    "pythonStdlib",
    "systemDirectories",
    "systemctl",
    "systemdRun",
    "versions",
  ], "runtime readiness");

  // reject substituted or stale receipt bytes
  if (
    manifest.contractVersion !== ADJUSTMENT_FIT_RUNTIME_READINESS_VERSION ||
    hashAdjustmentFitRuntimeReadiness(manifest) !== expectedSha256
  ) {
    throw sandboxError("runtime_invalid", "fit runtime readiness hash is invalid");
  }

  const current = await captureAdjustmentFitRuntimeReadiness(
    manifest.numericalSitePackages.path,
  );

  // compare the complete fixed source identities and versions
  if (canonicalJson(current) !== canonicalJson(manifest)) {
    throw sandboxError("runtime_invalid", "fit runtime readiness has drifted");
  }
}

// execute systemd-run with bounded candidate transport and digest-only errors
async function executeBounded(unitName, systemdArgv) {
  const child = spawn(SYSTEMD_RUN_PATH, systemdArgv, {
    env: {
      HOME: "/home/ubuntu",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collectBoundedStream(child.stdout, "stdout", true, () => {
    void killTransientUnit(unitName);
  });
  const stderr = collectBoundedStream(child.stderr, "stderr", false, () => {
    void killTransientUnit(unitName);
  });
  const exit = await new Promise((resolveExit, rejectExit) => {
    // retain only process state and never raw output in thrown errors
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const [stdoutCapture, stderrCapture] = await Promise.all([stdout, stderr]);

  // classify oversized candidate transport as a resource refusal
  if (stdoutCapture.report.overflow) {
    throw sandboxError("resource_refused", "fit candidate stdout exceeds 1 MiB");
  }

  // keep stderr as a separately classified bounded log
  if (stderrCapture.report.overflow) {
    throw sandboxError("log_limit", "fit process log ceiling exceeded");
  }

  // reject nonzero and signalled transient services
  if (exit.code !== 0 || exit.signal !== null) {
    throw sandboxError("process_failed", "isolated fit process failed");
  }

  return {
    stderr: stderrCapture.report,
    stdout: stdoutCapture.report,
    stdoutBytes: stdoutCapture.bytes,
  };
}

// capture only approved stdout while hashing either bounded stream
async function collectBoundedStream(stream, label, retainBytes, onOverflow) {
  const hash = createHash("sha256");
  const chunks = [];
  let bytes = 0;
  let overflow = false;

  // consume each pipe chunk under its independent ceiling
  for await (const chunk of stream) {
    const remaining = ADJUSTMENT_FIT_LOG_MAXIMUM_BYTES - bytes;

    // stop the full unit at the first overflowing byte
    if (chunk.length > remaining) {
      // hash and optionally retain only the allowed prefix
      if (remaining > 0) {
        const prefix = chunk.subarray(0, remaining);
        hash.update(prefix);

        // retain only candidate stdout under its transport ceiling
        if (retainBytes) {
          chunks.push(prefix);
        }
        bytes += remaining;
      }

      // kill the unit only once per overflowing stream
      if (!overflow) {
        overflow = true;
        onOverflow();
      }
      continue;
    }

    hash.update(chunk);

    // retain only candidate stdout under its transport ceiling
    if (retainBytes) {
      chunks.push(chunk);
    }
    bytes += chunk.length;
  }

  return {
    bytes: retainBytes ? Buffer.concat(chunks, bytes) : null,
    report: Object.freeze({
      bytes,
      label,
      overflow,
      sha256: hash.digest("hex"),
    }),
  };
}

// accept exactly one canonical candidate document from bounded stdout
function sanitizeCandidateStdout(bytes) {
  // retain the family artifact ceiling despite the stricter transport limit
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > ADJUSTMENT_FIT_CANDIDATE_MAXIMUM_BYTES
  ) {
    throw sandboxError("candidate_invalid", "fit candidate stdout is invalid");
  }

  const text = bytes.toString("utf8");

  // reject invalid utf8 replacement before parsing or hashing publication text
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw sandboxError("candidate_invalid", "fit candidate is not canonical utf8");
  }

  let value;

  try {
    value = parseCanonicalCandidateDocument(text);
  } catch {
    throw sandboxError("candidate_invalid", "fit candidate is not canonical JSON");
  }

  // require one canonical object rather than an alternate top-level value
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw sandboxError("candidate_invalid", "fit candidate is not canonical JSON");
  }

  rejectPrivateCandidateMaterial(value);
  return {
    sha256: sha256(bytes),
    text,
  };
}

// parse one compact sorted json document with one final line feed
function parseCanonicalCandidateDocument(text) {
  // reject empty, unterminated, and multiple-line transport documents
  if (!text.endsWith("\n") || text.length === 1) {
    throw new RangeError("candidate document framing is invalid");
  }

  const state = { index: 0, text: text.slice(0, -1) };
  const value = parseCanonicalValue(state);

  // require the parser to consume exactly one document
  if (state.index !== state.text.length) {
    throw new RangeError("candidate document has trailing bytes");
  }

  return value;
}

// parse one canonical json value without skipping whitespace
function parseCanonicalValue(state) {
  const character = state.text[state.index];

  // dispatch closed containers and strings by their first byte
  if (character === "{") {
    return parseCanonicalObject(state);
  }
  if (character === "[") {
    return parseCanonicalArray(state);
  }
  if (character === "\"") {
    return parseCanonicalString(state);
  }

  // accept the three exact json literal spellings
  for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
    // consume only a complete matching literal
    if (state.text.startsWith(literal, state.index)) {
      state.index += literal.length;
      return value;
    }
  }

  return parseCanonicalNumber(state);
}

// parse one object with strictly increasing unique keys
function parseCanonicalObject(state) {
  state.index += 1;
  const value = Object.create(null);
  let previousKey = null;

  // retain the exact empty-object spelling
  if (state.text[state.index] === "}") {
    state.index += 1;
    return value;
  }

  // consume every sorted field until the closing brace
  while (state.index < state.text.length) {
    const key = parseCanonicalString(state);

    // reject duplicate, descending, and locale-shaped key order
    if (previousKey !== null && previousKey >= key) {
      throw new RangeError("candidate object keys are not canonical");
    }
    previousKey = key;
    expectCanonicalByte(state, ":");
    value[key] = parseCanonicalValue(state);
    const delimiter = state.text[state.index];

    // close the object only after a complete field
    if (delimiter === "}") {
      state.index += 1;
      return value;
    }

    expectCanonicalByte(state, ",");
  }

  throw new RangeError("candidate object is unterminated");
}

// parse one compact array while preserving its declared order
function parseCanonicalArray(state) {
  state.index += 1;
  const value = [];

  // retain the exact empty-array spelling
  if (state.text[state.index] === "]") {
    state.index += 1;
    return value;
  }

  // consume every ordered member until the closing bracket
  while (state.index < state.text.length) {
    value.push(parseCanonicalValue(state));
    const delimiter = state.text[state.index];

    // close the array only after a complete member
    if (delimiter === "]") {
      state.index += 1;
      return value;
    }

    expectCanonicalByte(state, ",");
  }

  throw new RangeError("candidate array is unterminated");
}

// parse one minimally escaped json string
function parseCanonicalString(state) {
  const start = state.index;
  expectCanonicalByte(state, "\"");

  // scan escapes without allowing raw control bytes
  while (state.index < state.text.length) {
    const character = state.text[state.index];

    // decode and verify one complete minimal string token
    if (character === "\"") {
      state.index += 1;
      const token = state.text.slice(start, state.index);
      const value = JSON.parse(token);

      // reject alternate escape spellings and escaped ascii
      if (token !== JSON.stringify(value)) {
        throw new RangeError("candidate string is not canonical");
      }
      return value;
    }

    // consume one valid json escape sequence
    if (character === "\\") {
      const escape = state.text[state.index + 1];

      // require four lowercase hexadecimal digits after unicode escapes
      if (escape === "u") {
        const digits = state.text.slice(state.index + 2, state.index + 6);

        // reject truncated or uppercase unicode escapes
        if (!/^[a-f0-9]{4}$/u.test(digits)) {
          throw new RangeError("candidate unicode escape is invalid");
        }
        state.index += 6;
        continue;
      }

      // accept only json's short minimal escapes
      if (!/["\\bfnrt]/u.test(escape ?? "")) {
        throw new RangeError("candidate string escape is invalid");
      }
      state.index += 2;
      continue;
    }

    // prohibit raw json control characters
    if (character.charCodeAt(0) < 0x20) {
      throw new RangeError("candidate string contains a control byte");
    }
    state.index += 1;
  }

  throw new RangeError("candidate string is unterminated");
}

// parse one finite shortest-form javascript or python json number
function parseCanonicalNumber(state) {
  const match = CANONICAL_NUMBER_PATTERN.exec(state.text.slice(state.index));

  // reject nonnumbers without delegating to permissive coercion
  if (match === null) {
    throw new RangeError("candidate value is invalid");
  }

  const token = match[0];
  const fraction = /\.(\d+)/u.exec(token)?.[1] ?? null;
  const exponentMatch = /e([+-]?)(\d+)/u.exec(token);
  const exponentSign = exponentMatch?.[1] ?? null;
  const exponent = exponentMatch?.[2] ?? null;

  // reject redundant fraction zeros while retaining python's integral .0
  if (fraction !== null && fraction !== "0" && fraction.endsWith("0")) {
    throw new RangeError("candidate number fraction is not canonical");
  }

  // accept javascript exponents or python's signed zero-padded exponent
  if (
    exponent !== null &&
    exponent.length > 1 &&
    exponent.startsWith("0") &&
    (exponent.length !== 2 || exponentSign === "")
  ) {
    throw new RangeError("candidate number exponent is not canonical");
  }

  // reject a redundant integral fraction before an exponent
  if (exponent !== null && fraction === "0") {
    throw new RangeError("candidate number mantissa is not canonical");
  }

  // reject the nonfloat negative-zero spelling and native overflow
  if (token === "-0" || !Number.isFinite(Number(token))) {
    throw new RangeError("candidate number is not finite canonical json");
  }

  state.index += token.length;
  return Number(token);
}

// require one exact structural byte at the current parser offset
function expectCanonicalByte(state, expected) {
  // reject whitespace, missing delimiters, and alternate separators
  if (state.text[state.index] !== expected) {
    throw new RangeError("candidate structure is not canonical");
  }
  state.index += 1;
}

// kill all remaining processes in one exact transient unit
async function killTransientUnit(unitName) {
  try {
    await execFileAsync(SYSTEMCTL_PATH, [
      "--user",
      "kill",
      "--kill-whom=all",
      "--signal=KILL",
      unitName,
    ], { timeout: 30_000 });
  } catch {
    // ignore an already collected successful unit
  }
}

// reject private paths, credentials, and key-like candidate material
function rejectPrivateCandidateMaterial(value) {
  // inspect arrays without changing their order
  if (Array.isArray(value)) {
    // recurse through every array value
    for (const item of value) {
      rejectPrivateCandidateMaterial(item);
    }
    return;
  }

  // inspect every object field and its nested value
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // reject key names that declare private control material
      if (PRIVATE_KEY_PATTERN.test(key)) {
        throw sandboxError("candidate_invalid", "fit candidate contains private fields");
      }
      rejectPrivateCandidateMaterial(item);
    }
    return;
  }

  // reject host paths and credential markers in string leaves
  if (typeof value === "string" && PRIVATE_VALUE_PATTERN.test(value)) {
    throw sandboxError("candidate_invalid", "fit candidate contains private values");
  }
}

// require one fixed family and return its narrowed key
function requireFamily(value) {
  // reject alternate commands and family spellings
  if (!Object.hasOwn(ADJUSTMENT_FIT_FAMILY_ENTRIES, value)) {
    throw sandboxError("request_invalid", "fit family is invalid");
  }
  return value;
}

// require one named regular file already inside a verified snapshot
async function requireSnapshotFile(root, relativePath) {
  // prohibit absolute, normalized, and traversal entry paths
  if (
    !SAFE_RELATIVE_PATH_PATTERN.test(relativePath) ||
    resolve(root, relativePath) !== join(root, relativePath)
  ) {
    throw sandboxError("snapshot_invalid", "fit snapshot entry path is invalid");
  }

  const metadata = await lstat(join(root, relativePath));

  // require one owner-private nonlinked regular file
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw sandboxError("snapshot_invalid", "fit snapshot entry is invalid");
  }
}

// require one direct owner-only directory on the native tmpfs
async function requirePrivateTmpfsRoot(root, prefix) {
  const absolute = resolve(root);

  // prohibit aliases, nesting, and nonfixed tmpfs prefixes
  if (
    root !== absolute ||
    dirname(absolute) !== TMPFS_ROOT ||
    !basename(absolute).startsWith(prefix)
  ) {
    throw sandboxError("snapshot_invalid", "fit tmpfs root is invalid");
  }

  const metadata = await lstat(absolute);
  const canonical = await realpath(absolute);
  const filesystem = await statfs(absolute);

  // require an unlinked owner-only directory on Linux tmpfs
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    metadata.nlink < 2 ||
    (metadata.mode & 0o777) !== 0o700 ||
    canonical !== absolute ||
    filesystem.type !== TMPFS_MAGIC
  ) {
    throw sandboxError("snapshot_invalid", "fit tmpfs root is not private");
  }

  return canonical;
}

// restrict runtime injection to the fixed production root or private test tmpfs
async function requireAllowedNumericalRuntimeRoot(root) {
  const absolute = resolve(root);
  const testRoot =
    dirname(absolute) === TMPFS_ROOT &&
    basename(absolute).startsWith("weather-adjustment-fit-runtime-");

  // reject arbitrary host paths even when caller supplies matching hashes
  if (absolute !== root || (absolute !== PRODUCTION_NUMERICAL_RUNTIME && !testRoot)) {
    throw sandboxError("runtime_invalid", "numerical runtime root is invalid");
  }

  // require test fixtures to remain owner-only native tmpfs roots
  if (testRoot) {
    await requirePrivateTmpfsRoot(root, "weather-adjustment-fit-runtime-");
  } else {
    await requirePrivateProductionRuntimePath(root);
  }
}

// require every reviewed numerical-runtime ancestor without exposing host home
async function requirePrivateProductionRuntimePath(root) {
  const ancestors = [
    "/home/ubuntu/.weather",
    "/home/ubuntu/.weather/research-runtimes",
    "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1",
    "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1/lib",
    "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1/lib/python3.14",
    root,
  ];

  // reject linked, broad, or foreign path components
  for (const path of ancestors) {
    const metadata = await lstat(path);
    const canonical = await realpath(path);

    // retain only the exact owner-private reviewed runtime chain
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o777) !== 0o700 ||
      canonical !== path
    ) {
      throw sandboxError("runtime_invalid", "numerical runtime path is invalid");
    }
  }
}

// require the pinned numerical package identities inside one reviewed tree
async function validateNumericalPackageMarkers(root) {
  const directory = await opendir(root);
  const names = [];

  try {
    // retain the exact top-level numerical package marker set
    for await (const entry of directory) {
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  const numpyMarkers = names.filter((name) =>
    /^numpy-.*\.dist-info$/u.test(name));
  const xgboostMarkers = names.filter((name) =>
    /^xgboost(?:_cpu)?-.*\.dist-info$/u.test(name));

  // reject alternate versions and executable path injection files
  if (
    JSON.stringify(numpyMarkers) !== JSON.stringify(["numpy-2.5.3.dist-info"]) ||
    JSON.stringify(xgboostMarkers) !== JSON.stringify(["xgboost_cpu-3.4.1.dist-info"]) ||
    names.some((name) =>
      (name.endsWith(".pth") && name !== "_virtualenv.pth") ||
      name === "sitecustomize.py" ||
      name === "usercustomize.py")
  ) {
    throw sandboxError("runtime_invalid", "numerical runtime markers are invalid");
  }

  try {
    const values = await Promise.all([
      lstat(join(root, numpyMarkers[0])),
      lstat(join(root, xgboostMarkers[0])),
    ]);

    // reject marker substitution by regular files or links
    if (values.some((value) => !value.isDirectory() || value.isSymbolicLink())) {
      throw sandboxError("runtime_invalid", "numerical runtime markers are invalid");
    }
  } catch (error) {
    // preserve already classified runtime failures
    if (error instanceof AdjustmentFitSandboxError) {
      throw error;
    }
    throw sandboxError("runtime_invalid", "numerical runtime markers are missing");
  }
}

// import the exact numerical packages with the pinned production interpreter
async function validateNumericalRuntimeImports(root) {
  const source = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(root)})`,
    "import numpy,xgboost",
    "print(numpy.__version__ + '\\n' + xgboost.__version__)",
  ].join(";");
  let versions;

  // execute without ambient site or user configuration
  try {
    versions = await execFileAsync(PYTHON_PATH, ["-I", "-S", "-c", source], {
      encoding: "utf8",
      env: {
        HOME: "/home/sandbox",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
        PYTHONDONTWRITEBYTECODE: "1",
        TZ: "UTC",
      },
      maxBuffer: 16 * 1_024,
      timeout: 30_000,
    });
  } catch {
    throw sandboxError("runtime_invalid", "fit numerical runtime import failed");
  }

  // reject marker-only or import-shadowed numerical packages
  if (versions.stdout !== "2.5.3\n3.4.1\n") {
    throw sandboxError("runtime_invalid", "fit numerical runtime import differs");
  }
}

// read exact installed tool versions without a shell
async function fixedRuntimeVersions() {
  const [bwrap, node, python, systemd] = await Promise.all([
    execFileText(BWRAP_PATH, ["--version"]),
    execFileText(NODE_PATH, ["--version"]),
    execFileText(PYTHON_PATH, ["--version"]),
    execFileText(SYSTEMD_RUN_PATH, ["--version"]),
  ]);

  // reject runtime substitution before hashing any user-owned tree
  if (
    bwrap !== "bubblewrap 0.11.1" ||
    node !== "v24.16.0" ||
    python !== "Python 3.14.7" ||
    !systemd.startsWith("systemd 259 ")
  ) {
    throw sandboxError("runtime_invalid", "fit runtime version is invalid");
  }

  return Object.freeze({ bwrap, node, numpy: "2.5.3", python, systemd, xgboost: "3.4.1" });
}

// execute one fixed version command and normalize its one-line result
async function execFileText(path, arguments_) {
  try {
    const result = await execFileAsync(path, arguments_, {
      encoding: "utf8",
      maxBuffer: 16 * 1_024,
      timeout: 30_000,
    });
    return result.stdout.trim();
  } catch {
    throw sandboxError("runtime_invalid", "fit runtime version check failed");
  }
}

// capture one exact root-owned system directory
async function directoryIdentity(path, expectedUid) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);

  // reject aliases, writable roots, and foreign ownership
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o022) !== 0 ||
    canonical !== path
  ) {
    throw sandboxError("runtime_invalid", "trusted system directory is invalid");
  }

  return Object.freeze({
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    path,
    uid: metadata.uid,
  });
}

// capture one exact regular executable identity
async function fileIdentity(path, expectedUid) {
  const before = await lstat(path);
  const canonical = await realpath(path);

  // reject links, writable executables, and foreign ownership
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== expectedUid ||
    before.nlink !== 1 ||
    (before.mode & 0o022) !== 0 ||
    canonical !== path
  ) {
    throw sandboxError("runtime_invalid", "trusted runtime file is invalid");
  }

  const digest = await hashRegularFile(path, before);
  return Object.freeze({
    gid: before.gid,
    mode: before.mode & 0o777,
    path,
    sha256: digest,
    size: before.size,
    uid: before.uid,
  });
}

// hash one tree including exact modes and reviewed relative links
async function treeIdentity(root, options) {
  const errorReason = options.errorReason ?? "runtime_invalid";
  const rootMetadata = await lstat(root);
  const canonicalRoot = await realpath(root);

  // reject root aliases and foreign runtime ownership
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.getuid() ||
    (options.ownerPrivate === true && (rootMetadata.mode & 0o077) !== 0) ||
    canonicalRoot !== root
  ) {
    throw sandboxError(errorReason, "trusted runtime tree root is invalid");
  }

  const records = [];
  const pending = [root];
  let fileCount = 0;
  let totalBytes = 0;

  // walk every directory without following entry links
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    const directory = await opendir(directoryPath);
    const entries = [];

    try {
      // collect one stable lexical directory batch
      for await (const entry of directory) {
        entries.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }

    entries.sort((left, right) => left.localeCompare(right));

    // record every child without trusting dirent type hints
    for (const name of entries) {
      const path = join(directoryPath, name);
      const metadata = await lstat(path);
      const relativePath = relative(root, path).split(sep).join("/");

      // reject special nodes and foreign owners throughout the tree
      if (metadata.uid !== process.getuid()) {
        throw sandboxError(errorReason, "trusted runtime tree owner is invalid");
      }

      // retain directories for complete mode hashing
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        // preserve owner-private snapshot and numerical directory modes
        if (options.ownerPrivate === true && (metadata.mode & 0o077) !== 0) {
          throw sandboxError(errorReason, "trusted runtime directory mode is invalid");
        }
        records.push({ kind: "directory", mode: metadata.mode & 0o777, path: relativePath });
        pending.push(path);
        continue;
      }

      // hash regular files through no-follow descriptors
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        // reject hard links and nonprivate snapshot or numerical files
        if (
          (metadata.nlink !== 1 && options.allowHardLinks !== true) ||
          (options.ownerPrivate === true && (metadata.mode & 0o066) !== 0)
        ) {
          throw sandboxError(errorReason, "trusted runtime file mode is invalid");
        }
        const digest = await hashRegularFile(path, metadata);
        records.push({
          kind: "file",
          mode: metadata.mode & 0o777,
          nlink: metadata.nlink,
          path: relativePath,
          sha256: digest,
          size: metadata.size,
        });
        fileCount += 1;
        totalBytes += metadata.size;
        continue;
      }

      // retain only expected in-prefix runtime links
      if (metadata.isSymbolicLink() && options.allowLinks) {
        const linkTarget = await readlink(path);
        const resolvedTarget = await realpath(path);
        const systemLoader =
          path === `${LINUXBREW_LIB}/ld.so` &&
          linkTarget === "/lib64/ld-linux-x86-64.so.2" &&
          resolvedTarget === "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";

        // reject links that escape the fixed Linuxbrew prefix
        if (
          !systemLoader &&
          !resolvedTarget.startsWith("/home/linuxbrew/.linuxbrew/")
        ) {
          throw sandboxError("runtime_invalid", "trusted runtime link escapes its prefix");
        }

        records.push({
          kind: "link",
          mode: metadata.mode & 0o777,
          path: relativePath,
          target: linkTarget,
        });
        continue;
      }

      throw sandboxError(errorReason, "trusted runtime tree node is invalid");
    }
  }

  records.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    fileCount,
    gid: rootMetadata.gid,
    mode: rootMetadata.mode & 0o777,
    path: root,
    totalBytes,
    treeSha256: sha256(Buffer.from(canonicalJson(records))),
    uid: rootMetadata.uid,
  });
}

// hash one stable regular file through a no-follow descriptor
async function hashRegularFile(path, before) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");

  try {
    const opened = await handle.stat();

    // bind the read to the inspected inode
    if (!sameFile(before, opened)) {
      throw sandboxError("runtime_invalid", "trusted runtime file changed before open");
    }

    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: 256 * 1_024,
    });

    // hash bounded chunks without buffering whole runtime files
    for await (const chunk of stream) {
      hash.update(chunk);
    }

    const after = await handle.stat();

    // reject mutation during the readiness read
    if (!sameFile(opened, after)) {
      throw sandboxError("runtime_invalid", "trusted runtime file changed during read");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  return hash.digest("hex");
}

// compare stable file identity and mutation fields
function sameFile(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs;
}

// serialize one JSON value with recursively sorted object keys
function canonicalJson(value) {
  // retain arrays in their declared semantic order
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  // sort object fields before serializing their values
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

// require one exact closed object field set
function requireExactKeys(value, expected, name) {
  // reject nonobjects before field enumeration
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw sandboxError("request_invalid", `${name} is invalid`);
  }

  const actual = Object.keys(value).sort();
  const required = [...expected].sort();

  // reject unknown and missing fields together
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw sandboxError("request_invalid", `${name} fields are invalid`);
  }
}

// require one lowercase sha256 identity
function requireSha256(value, name) {
  // reject alternate digests and encodings
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw sandboxError("request_invalid", `${name} is invalid`);
  }
}

// calculate one lowercase sha256 digest
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// create one classified fail-closed error
function sandboxError(reason, message) {
  return new AdjustmentFitSandboxError(reason, message);
}
