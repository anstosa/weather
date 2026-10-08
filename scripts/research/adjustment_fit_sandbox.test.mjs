import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ADJUSTMENT_FIT_ENVIRONMENT,
  ADJUSTMENT_FIT_FAMILY_ENTRIES,
  ADJUSTMENT_FIT_SYSTEMD_PROPERTIES,
  AdjustmentFitSandboxError,
  buildAdjustmentFitSandboxArgv,
  buildAdjustmentFitSystemdArgv,
  captureAdjustmentFitRuntimeReadiness,
  hashAdjustmentFitRuntimeReadiness,
  inspectAdjustmentFitSnapshot,
  runAdjustmentFitSandbox,
} from "./adjustment_fit_sandbox.mjs";

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NAMESPACES = ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"];
const PRODUCTION_RUNTIME =
  "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1/lib/python3.14/site-packages";

// create one direct owner-private tmpfs root
async function privateRoot(prefix) {
  const root = await mkdtemp(`/dev/shm/${prefix}`);
  await chmod(root, 0o700);
  return root;
}

// write one owner-private nested snapshot file
async function privateFile(root, relativePath, contents) {
  const parent = dirname(join(root, relativePath));
  await mkdir(parent, { mode: 0o700, recursive: true });
  await chmod(parent, 0o700);
  await writeFile(join(root, relativePath), contents, { mode: 0o600 });
}

// read the host namespace identities before sandboxing
async function hostNamespaces() {
  const result = {};

  // retain every required namespace inode label
  for (const namespace of NAMESPACES) {
    result[namespace] = await readlink(`/proc/self/ns/${namespace}`);
  }

  return result;
}

// create one fixed-entry javascript isolation probe
function nodeProbeSource() {
  return `import { existsSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
const host = JSON.parse(readFileSync("/input/data/wind.json", "utf8"));
const expected = ${JSON.stringify(ADJUSTMENT_FIT_ENVIRONMENT)};
const namespaces = Object.fromEntries(${JSON.stringify(NAMESPACES)}.map((name) => [name, readlinkSync(\`/proc/self/ns/\${name}\`)]));
const fdTargets = readdirSync("/proc/self/fd").flatMap((name) => { try { return [readlinkSync(\`/proc/self/fd/\${name}\`)]; } catch { return []; } });
const networkError = await new Promise((resolve) => { const socket = new Socket(); socket.once("error", (error) => resolve(error.code)); socket.connect(9, "203.0.113.1"); });
const limits = readFileSync("/proc/self/limits", "utf8");
const pids = readdirSync("/proc").filter((name) => /^\\d+$/u.test(name)).map(Number);
const value = {
  contractVersion: "adjustment-fit-isolation-probe/v1",
  cwd: process.cwd(),
  environmentExact: JSON.stringify(process.env) === JSON.stringify(expected),
  fd0Null: readlinkSync("/proc/self/fd/0") === "/dev/null",
  fdSentinelVisible: fdTargets.includes(host.sentinelPath),
  hostHomeVisible: existsSync("/home/ubuntu"),
  limitsExact: /Max file size\\s+67108864\\s+67108864/u.test(limits) && /Max open files\\s+64\\s+64/u.test(limits),
  namespaces,
  networkError,
  pidMaximum: Math.max(...pids),
  repositoryVisible: existsSync("/home/ubuntu/weather"),
  sentinelVisible: existsSync(host.sentinelPath),
  syntheticHome: existsSync("/home/sandbox"),
};
writeFileSync("/output/wind.json", JSON.stringify(value) + "\\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify(value) + "\\n");
`;
}

// create one fixed-entry python isolation probe
function pythonProbeSource(family) {
  return `import errno,json,os,resource,socket
from pathlib import Path
import numpy,xgboost
host=json.loads(Path("/input/data/${family}.json").read_text())
expected=${JSON.stringify(ADJUSTMENT_FIT_ENVIRONMENT).replaceAll("true", "True").replaceAll("false", "False").replaceAll("null", "None")}
namespaces={name:os.readlink(f"/proc/self/ns/{name}") for name in ${JSON.stringify(NAMESPACES)}}
fd_targets=[]
for name in os.listdir("/proc/self/fd"):
    try:
        fd_targets.append(os.readlink(f"/proc/self/fd/{name}"))
    except FileNotFoundError:
        pass
probe=socket.socket()
network_errno=probe.connect_ex(("203.0.113.1",9))
probe.close()
soft_file,hard_file=resource.getrlimit(resource.RLIMIT_FSIZE)
soft_open,hard_open=resource.getrlimit(resource.RLIMIT_NOFILE)
pids=[int(name) for name in os.listdir("/proc") if name.isdigit()]
value={
    "contractVersion":"adjustment-fit-isolation-probe/v1",
    "cwd":os.getcwd(),
    "environmentExact":dict(os.environ)==expected,
    "fd0Null":os.readlink("/proc/self/fd/0")=="/dev/null",
    "fdSentinelVisible":host["sentinelPath"] in fd_targets,
    "hostHomeVisible":Path("/home/ubuntu").exists(),
    "limitsExact":soft_file==hard_file==67108864 and soft_open==hard_open==64,
    "namespaces":namespaces,
    "networkError":errno.errorcode.get(network_errno,str(network_errno)),
    "numericalVersionsExact":numpy.__version__=="2.5.3" and xgboost.__version__=="3.4.1",
    "pidMaximum":max(pids),
    "repositoryVisible":Path("/home/ubuntu/weather").exists(),
    "sentinelVisible":Path(host["sentinelPath"]).exists(),
    "syntheticHome":Path("/home/sandbox").exists(),
}
data=json.dumps(value,sort_keys=True,separators=(",",":"))+"\\n"
fd=os.open("/output/${family}.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as output:
    output.write(data)
    output.flush()
    os.fsync(output.fileno())
print(data,end="")
`;
}

// create one fixed wind entry with caller-supplied hostile behavior
async function windSnapshots(source, inputValue = {}) {
  const codeRoot = await privateRoot("weather-adjustment-fit-code-test-");
  const inputRoot = await privateRoot("weather-adjustment-fit-input-test-");
  const entry = ADJUSTMENT_FIT_FAMILY_ENTRIES.wind;
  await privateFile(codeRoot, entry.arguments[0], source);
  await privateFile(
    inputRoot,
    entry.inputFilename,
    `${JSON.stringify(inputValue)}\n`,
  );
  const code = await inspectAdjustmentFitSnapshot(codeRoot, "code");
  const input = await inspectAdjustmentFitSnapshot(inputRoot, "input");
  return { code, codeRoot, input, inputRoot };
}

// populate one family-specific code and input snapshot pair
async function probeSnapshots(family, sentinelPath, namespaces) {
  // reuse the closed wind fixture constructor for javascript probes
  if (family === "wind") {
    return windSnapshots(nodeProbeSource(), { namespaces, sentinelPath });
  }

  const codeRoot = await privateRoot("weather-adjustment-fit-code-test-");
  const inputRoot = await privateRoot("weather-adjustment-fit-input-test-");
  const entry = ADJUSTMENT_FIT_FAMILY_ENTRIES[family];
  const source = pythonProbeSource(family);
  await privateFile(codeRoot, entry.arguments[0], source);
  await privateFile(
    inputRoot,
    entry.inputFilename,
    `${JSON.stringify({ namespaces, sentinelPath })}\n`,
  );
  const code = await inspectAdjustmentFitSnapshot(codeRoot, "code");
  const input = await inspectAdjustmentFitSnapshot(inputRoot, "input");
  return { code, codeRoot, input, inputRoot };
}

// assert one path was removed by unconditional teardown
async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
}

// list any obsolete host-visible output staging roots
async function hostOutputRoots() {
  const names = await readdir("/dev/shm");
  return names.filter((name) =>
    name.startsWith("weather-adjustment-fit-output-")).sort();
}

// preserve and restore inherited variables around the clearenv proof
function setInheritedEnvironment(values) {
  const prior = Object.fromEntries(Object.keys(values).map((key) =>
    [key, Object.hasOwn(process.env, key) ? process.env[key] : null]));
  Object.assign(process.env, values);
  return () => {
    // restore every mutated inherited variable exactly
    for (const [key, value] of Object.entries(prior)) {
      // delete keys that were originally absent
      if (value === null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

// report one explicit reason when ci lacks the pinned workstation boundary
async function missingWorkstationReadiness() {
  const required = [
    "/usr/bin/bwrap",
    "/usr/bin/systemd-run",
    "/usr/bin/systemctl",
    "/home/ubuntu/n/bin/node",
    "/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/bin/python3.14",
    PRODUCTION_RUNTIME,
    `/run/user/${process.getuid()}/bus`,
  ];

  // identify only genuinely absent host prerequisites
  for (const path of required) {
    try {
      await access(path);
    } catch {
      return `pinned workstation readiness absent: ${path}`;
    }
  }

  return null;
}

// prove exact argv ordering, fixed commands, environment, and resource envelope
test("sandbox argv precreates destinations and leaves untrusted mounts last", () => {
  const common = {
    codeRoot: "/dev/shm/weather-adjustment-fit-code-test",
    dataRoot: "/dev/shm/weather-adjustment-fit-input-test",
    numericalRuntimeRoot: "/dev/shm/weather-adjustment-fit-runtime-test",
  };

  // inspect every fixed family command without accepting caller argv
  for (const family of ["temperature", "rain", "wind"]) {
    const argv = buildAdjustmentFitSandboxArgv({ ...common, family });
    assert.deepEqual(argv.slice(0, 11), [
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
    ]);
    assert.equal(argv.includes("--try"), false);
    const firstMount = argv.indexOf("--proc");
    const lastDirectory = argv.lastIndexOf("--dir");
    assert.ok(lastDirectory < firstMount);
    const pythonPlaceholder = argv.indexOf("/runtime/python");
    const firstSystemBind = argv.indexOf("/usr", argv.indexOf("--ro-bind"));
    assert.deepEqual(argv.slice(pythonPlaceholder - 2, pythonPlaceholder + 4), [
      "--ro-bind", "/dev/null", "/runtime/python",
      "--ro-bind", "/dev/null", "/runtime/node",
    ]);
    assert.ok(pythonPlaceholder < firstSystemBind);
    const codeMount = argv.lastIndexOf(common.codeRoot);
    const dataMount = argv.lastIndexOf(common.dataRoot);
    const outputMount = argv.indexOf("/output", argv.indexOf("--size"));
    assert.deepEqual(argv.slice(outputMount - 5, outputMount + 1), [
      "--size",
      "67108864",
      "--perms",
      "0700",
      "--tmpfs",
      "/output",
    ]);
    assert.ok(outputMount < codeMount);
    assert.ok(codeMount < dataMount);
    assert.equal(argv.includes("/dev/shm/weather-adjustment-fit-output-test"), false);
    const afterLastMount = argv.slice(dataMount + 2);
    assert.equal(afterLastMount.some((value) =>
      ["--dir", "--proc", "--dev", "--tmpfs", "--bind", "--ro-bind"].includes(value)), false);
    const environment = {};

    // recover every exact setenv pair from the frozen argv
    for (let index = 0; index < argv.length; index += 1) {
      // retain only complete setenv triples
      if (argv[index] === "--setenv") {
        environment[argv[index + 1]] = argv[index + 2];
      }
    }

    assert.deepEqual(environment, ADJUSTMENT_FIT_ENVIRONMENT);
    assert.equal(Object.keys(environment).length, 13);
    assert.deepEqual(
      argv.slice(-1 - ADJUSTMENT_FIT_FAMILY_ENTRIES[family].arguments.length),
      [
        ADJUSTMENT_FIT_FAMILY_ENTRIES[family].command,
        ...ADJUSTMENT_FIT_FAMILY_ENTRIES[family].arguments,
      ],
    );
  }

  const systemd = buildAdjustmentFitSystemdArgv(
    "weather-adjustment-fit-0123456789abcdef0123456789abcdef.service",
    ["--clearenv", "/runtime/node"],
  );
  assert.deepEqual(
    systemd.filter((value) => value.startsWith("--property=")),
    ADJUSTMENT_FIT_SYSTEMD_PROPERTIES.map((value) => `--property=${value}`),
  );
  assert.equal(systemd.includes("/usr/bin/bwrap"), true);
});

// prove malicious tmpfs snapshots cannot redirect any bwrap destination
test("snapshot inspection rejects symlinks, hardlinks, and broad modes", async () => {
  const sentinelRoot = await privateRoot("weather-adjustment-host-sentinel-test-");
  const sentinel = join(sentinelRoot, "sentinel");
  await writeFile(sentinel, "outside", { mode: 0o600 });
  const linkedRoot = await privateRoot("weather-adjustment-fit-code-test-");
  const hardRoot = await privateRoot("weather-adjustment-fit-input-test-");

  try {
    await mkdir(join(linkedRoot, "scripts"), { mode: 0o700 });
    await symlink(sentinel, join(linkedRoot, "scripts", "malicious.py"));
    await assert.rejects(
      inspectAdjustmentFitSnapshot(linkedRoot, "code"),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "snapshot_invalid",
    );
    await privateFile(hardRoot, "rain.json", "{}\n");
    await link(join(hardRoot, "rain.json"), join(hardRoot, "alias.json"));
    await assert.rejects(
      inspectAdjustmentFitSnapshot(hardRoot, "input"),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "snapshot_invalid",
    );
    await chmod(hardRoot, 0o755);
    await assert.rejects(
      inspectAdjustmentFitSnapshot(hardRoot, "input"),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "snapshot_invalid",
    );
  } finally {
    await rm(sentinelRoot, { force: true, recursive: true });
    await rm(linkedRoot, { force: true, recursive: true });
    await rm(hardRoot, { force: true, recursive: true });
  }
});

// exercise isolation and output contracts through installed bwrap and systemd
test("installed sandbox isolates host state and enforces output contracts", async (context) => {
  const missingReadiness = await missingWorkstationReadiness();

  // keep portable ci explicit while requiring the configured workstation proof
  if (missingReadiness !== null) {
    context.skip(missingReadiness);
    return;
  }

  const sentinelRoot = await privateRoot("weather-adjustment-host-sentinel-test-");
  const sentinelPath = join(sentinelRoot, "release-credential-sentinel");
  await writeFile(sentinelPath, "never visible", { mode: 0o600 });
  const sentinelDescriptor = await open(sentinelPath, "r");
  const namespaces = await hostNamespaces();
  const restoreEnvironment = setInheritedEnvironment({
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/must-not-cross",
    HTTP_PROXY: "http://must-not-cross.invalid",
    LC_CTYPE: "must-not-cross",
    SSH_AUTH_SOCK: sentinelPath,
  });
  const outputRootsBefore = await hostOutputRoots();

  try {
    const readiness = await captureAdjustmentFitRuntimeReadiness();
    const runtimeReadinessSha256 = hashAdjustmentFitRuntimeReadiness(readiness);

    // execute every frozen family entry under the identical boundary
    for (const family of ["temperature", "rain", "wind"]) {
      const snapshots = await probeSnapshots(
        family,
        sentinelPath,
        namespaces,
      );
      const result = await runAdjustmentFitSandbox({
        codeRoot: snapshots.codeRoot,
        codeSnapshotSha256: snapshots.code.rootSha256,
        family,
        inputRoot: snapshots.inputRoot,
        inputSnapshotSha256: snapshots.input.rootSha256,
        runtimeReadiness: readiness,
        runtimeReadinessSha256,
      });
      const probe = JSON.parse(result.candidateJson);
      assert.equal(probe.cwd, "/input/code");
      assert.equal(probe.environmentExact, true);
      assert.equal(probe.fd0Null, true);
      assert.equal(probe.fdSentinelVisible, false);
      assert.equal(probe.hostHomeVisible, false);
      assert.equal(probe.limitsExact, true);
      assert.equal(probe.networkError, "ENETUNREACH");
      // prove both python entries import the pinned numerical runtime
      if (family !== "wind") {
        assert.equal(probe.numericalVersionsExact, true);
      }
      assert.ok(probe.pidMaximum <= 2);
      assert.equal(probe.repositoryVisible, false);
      assert.equal(probe.sentinelVisible, false);
      assert.equal(probe.syntheticHome, true);

      // require every explicit namespace to differ from the host
      for (const namespace of NAMESPACES) {
        assert.notEqual(probe.namespaces[namespace], namespaces[namespace]);
      }

      assert.deepEqual(result.stdout, {
        bytes: Buffer.byteLength(result.candidateJson),
        label: "stdout",
        overflow: false,
        sha256: result.candidateSha256,
      });
      assert.deepEqual(result.stderr, {
        bytes: 0,
        label: "stderr",
        overflow: false,
        sha256: EMPTY_SHA256,
      });
      await assertMissing(snapshots.codeRoot);
      await assertMissing(snapshots.inputRoot);
    }

    const quota = await windSnapshots(`import { statfsSync, writeFileSync } from "node:fs";
const filesystem = statfsSync("/output");
const quotaBytes = Number(filesystem.bsize) * Number(filesystem.blocks);
writeFileSync("/output/first.bin", Buffer.alloc(32 * 1024 * 1024), { flag: "wx", mode: 0o600 });
let secondWriteError = null;
// capture the aggregate mount refusal without masking its errno
try {
  writeFileSync("/output/second.bin", Buffer.alloc(64 * 1024 * 1024), { flag: "wx", mode: 0o600 });
} catch (error) {
  secondWriteError = error.code;
}
const value = { contractVersion: "adjustment-fit-quota-probe/v1", quotaBytes, secondWriteError };
const data = JSON.stringify(value) + "\\n";
process.stdout.write(data);
`);
    const quotaResult = await runAdjustmentFitSandbox({
      codeRoot: quota.codeRoot,
      codeSnapshotSha256: quota.code.rootSha256,
      family: "wind",
      inputRoot: quota.inputRoot,
      inputSnapshotSha256: quota.input.rootSha256,
      runtimeReadiness: readiness,
      runtimeReadinessSha256,
    });
    const quotaProbe = JSON.parse(quotaResult.candidateJson);
    assert.equal(quotaProbe.quotaBytes, 64 * 1_024 * 1_024);
    assert.equal(quotaProbe.secondWriteError, "ENOSPC");
    await assertMissing(quota.codeRoot);
    await assertMissing(quota.inputRoot);

    const overflow = await windSnapshots(`process.stdout.write("x".repeat(1024 * 1024 + 1));\n`);
    await assert.rejects(
      runAdjustmentFitSandbox({
        codeRoot: overflow.codeRoot,
        codeSnapshotSha256: overflow.code.rootSha256,
        family: "wind",
        inputRoot: overflow.inputRoot,
        inputSnapshotSha256: overflow.input.rootSha256,
        runtimeReadiness: readiness,
        runtimeReadinessSha256,
      }),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "resource_refused",
    );
    await assertMissing(overflow.codeRoot);
    await assertMissing(overflow.inputRoot);

    const noncanonical = await windSnapshots(`import { writeFileSync } from "node:fs";
const data = "{\\\"z\\\":0,\\\"a\\\":1}\\n";
writeFileSync("/output/wind.json", data, { flag: "wx", mode: 0o600 });
process.stdout.write(data);
`);
    await assert.rejects(
      runAdjustmentFitSandbox({
        codeRoot: noncanonical.codeRoot,
        codeSnapshotSha256: noncanonical.code.rootSha256,
        family: "wind",
        inputRoot: noncanonical.inputRoot,
        inputSnapshotSha256: noncanonical.input.rootSha256,
        runtimeReadiness: readiness,
        runtimeReadinessSha256,
      }),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "candidate_invalid",
    );
    await assertMissing(noncanonical.codeRoot);
    await assertMissing(noncanonical.inputRoot);

    const drift = await probeSnapshots("wind", sentinelPath, namespaces);
    const substitutedReadiness = {
      ...readiness,
      versions: { ...readiness.versions, node: "v0.0.0" },
    };
    await assert.rejects(
      runAdjustmentFitSandbox({
        codeRoot: drift.codeRoot,
        codeSnapshotSha256: drift.code.rootSha256,
        family: "wind",
        inputRoot: drift.inputRoot,
        inputSnapshotSha256: drift.input.rootSha256,
        runtimeReadiness: substitutedReadiness,
        runtimeReadinessSha256,
      }),
      (error) => error instanceof AdjustmentFitSandboxError &&
        error.reason === "runtime_invalid",
    );
    await assertMissing(drift.codeRoot);
    await assertMissing(drift.inputRoot);
    assert.deepEqual(await hostOutputRoots(), outputRootsBefore);
  } finally {
    restoreEnvironment();
    await sentinelDescriptor.close();
    await rm(sentinelRoot, { force: true, recursive: true });
  }
});
