import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
  FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES,
} from "../scripts/forecast-adjustment-scorecard-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixedExecutablePath =
  `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const installerTestName =
  "installer consumes exact stdin bytes and fails closed before publication";
const rootChildMarker = "WEATHER_SCORECARD_INSTALLER_ROOT_CHILD";

// build one complete aggregate metric
function metric(unit) {
  return {
    adjustedBias: -0.1,
    adjustedMae: 1,
    adjustedP95: 2.5,
    adjustedRmse: 1.25,
    deltaMae: -0.5,
    rawBias: 0.25,
    rawMae: 1.5,
    rawP95: 3,
    rawRmse: 1.75,
    skillInterval95: { lower: 5, upper: 20 },
    skillPercent: 12.5,
    unit,
  };
}

// build one aggregate support summary
function support() {
  return {
    dateCount: 60,
    effectiveWeightSum: 60,
    eventCount: 1_000,
    excludedCount: 2,
    exclusionReasons: { missing_target: 2 },
    fallbackCount: 3,
    fallbackReasons: { source_stale: 3 },
    gapCount: 4,
    rowCount: 1_000,
    targetRowCount: 1_000,
    validHourCount: 240,
    vintageCount: 120,
    wetDateCount: 20,
    wetRowCount: 100,
  };
}

// build the ten fixed reliability bins
function reliability() {
  return Array.from({ length: 10 }, (_value, index) => ({
    count: index === 0 ? 0 : 10,
    meanProbability: index === 0 ? null : (index + 0.5) / 10,
    observedFrequency: index === 0 ? null : index / 10,
  }));
}

// build one closed family card
function family(name, unit) {
  return {
    bestMatchDiagnostic: name === "wind"
      ? null
      : {
        bestMatchRawMae: 1.4,
        dateCount: 30,
        rowCount: 500,
        sourceAdjustedMae: 1,
        sourceRawMae: 1.5,
        unit,
      },
    comparisonState: "better",
    evidenceClass: "development",
    evidenceCutoffAt: "2026-10-07T00:00:00.000Z",
    family: name,
    metrics: metric(unit),
    qualificationState: "development_only",
    rainDiagnostics: name === "rain"
      ? {
        accumulations: [6, 12, 23].map((hours) => ({
          adjustedMae: 0.5,
          completeWindows: 10,
          hours,
          rawMae: 0.75,
        })),
        annualBalancedVolumeRatio: 1.1,
        heavyAdjustedMae: 1.1,
        heavyRawMae: 1.4,
        probabilityOrderViolationCount: 0,
        thresholds: [0.1, 1, 2.5].map((thresholdMmPerHour) => ({
          adjustedBrier: 0.1,
          csi: 0.5,
          falseAlarms: 2,
          far: 0.2,
          hits: 8,
          misses: 1,
          pod: 8 / 9,
          rawBrier: 0.2,
          reliability: reliability(),
          thresholdMmPerHour,
        })),
        wetAdjustedMae: 0.6,
        wetRawMae: 0.8,
        winterBalancedVolumeRatio: 1.2,
      }
      : null,
    recommendation: "retain",
    servingIdentitySha256: name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
    servingState: "authorized_active",
    slices: [],
    support: support(),
    supportState: "sufficient",
  };
}

// build one valid review-only scorecard
function scorecard() {
  return {
    automaticActivationEligible: false,
    contractVersion: "forecast-adjustment-scorecard/v1",
    families: {
      rain: family("rain", "millimeters_per_hour"),
      temperature: family("temperature", "celsius"),
      wind: family("wind", "meters_per_second"),
    },
    generatedAt: "2026-10-07T01:00:00.000Z",
    inputs: {
      adjustmentEvidenceManifestSha256: "a".repeat(64),
      adjustmentEvidenceWatermarkSha256: "b".repeat(64),
      forecastTrainingManifestSha256: "c".repeat(64),
      localDateFrom: "2026-09-01",
      localDateTo: "2026-09-30",
      reportSha256s: {
        rain: "d".repeat(64),
        temperature: "e".repeat(64),
        wind: "f".repeat(64),
      },
      sourceRevision: "1".repeat(40),
      targetCutoffAt: "2026-10-07T00:00:00.000Z",
    },
    operatorApprovalRequired: true,
    servingChanged: false,
    siteKey: "ballydidean",
    validThrough: "2099-10-08T01:00:00.000Z",
  };
}

// build one valid automatic-policy scorecard projection
function scorecardV2(overrides = {}) {
  const sameIdentity = (value) => ({ rain: value, temperature: value, wind: value });
  return {
    actionLineage: {
      actionSha256: "1".repeat(64),
      attemptSha256: "2".repeat(64),
      predecessorActionSha256: null,
      releaseManifestSha256: "3".repeat(64),
      sourceRevision: "4".repeat(40),
    },
    actionProjectionSha256: "5".repeat(64),
    actionState: "active",
    contractVersion: "forecast-adjustment-scorecard/v2",
    families: scorecard().families,
    generatedAt: "2099-10-01T01:00:00.000Z",
    history: [{
      actionLineageSha256: "6".repeat(64),
      actionProjectionSha256: "5".repeat(64),
      actionState: "active",
      attemptSha256: "2".repeat(64),
      occurredAt: "2099-10-01T00:59:00.000Z",
      policyDecision: "qualified",
      releaseManifestSha256: "3".repeat(64),
    }],
    identities: {
      active: sameIdentity("7".repeat(64)),
      prior: sameIdentity(null),
      raw: sameIdentity("8".repeat(64)),
      shadow: sameIdentity(null),
    },
    inputs: {
      ...scorecard().inputs,
      frontierSha256: "9".repeat(64),
      inputManifestSha256: "a".repeat(64),
      reportSha256: "b".repeat(64),
    },
    job: {
      attemptState: "completed",
      backlogState: "clear",
      dueState: "not_due",
      operatorState: "enabled",
      successState: "succeeded",
    },
    policyDecision: "qualified",
    progress: {
      confirmationCompletedEpochs: 4,
      confirmationRequiredEpochs: 4,
      rainCaptureExpiresAt: "2099-10-08T00:00:00.000Z",
      rollbackCompletedEpochs: 0,
      rollbackRequiredEpochs: 2,
    },
    siteKey: "ballydidean",
    validThrough: "2099-10-08T01:00:00.000Z",
    warnings: { capacity: [], capture: [], fallback: [], gauge: [], source: [] },
    ...overrides,
  };
}

// create one isolated publisher with a recording SSH boundary
async function publisherHarness(root) {
  const scripts = join(root, "deploy/scripts");
  await mkdir(scripts, { recursive: true });
  await Promise.all([
    cp(join(repoRoot, "deploy/scripts/common.sh"), join(scripts, "common.sh")),
    cp(
      join(repoRoot, "deploy/scripts/forecast-adjustment-scorecard-contract.mjs"),
      join(scripts, "forecast-adjustment-scorecard-contract.mjs"),
    ),
    cp(
      join(repoRoot, "deploy/scripts/publish-adjustment-scorecard.sh"),
      join(scripts, "publish-adjustment-scorecard.sh"),
    ),
    writeFile(join(scripts, "ssh-run.sh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$PUBLISH_ARGUMENTS_PATH"
dd of="$PUBLISH_STDIN_PATH" status=none
if [[ \${PUBLISH_FAIL:-0} == 1 ]]; then
  exit 19
fi
`),
  ]);
  await Promise.all([
    chmod(join(scripts, "publish-adjustment-scorecard.sh"), 0o700),
    chmod(join(scripts, "ssh-run.sh"), 0o700),
  ]);
  return join(scripts, "publish-adjustment-scorecard.sh");
}

// create one isolated root-namespace installer with privileged commands stubbed
async function installerHarness(root) {
  const scripts = join(root, "deploy/scripts");
  const commands = join(root, "commands");
  const scorecardRoot = join(root, "adjustment-evidence");
  const installerSource = await readFile(
    join(repoRoot, "deploy/scripts/install-adjustment-scorecard.sh"),
    "utf8",
  );
  const isolatedInstallerSource = installerSource.replace(
    "v2_scorecard_root=/var/lib/weather/xweather/adjustment-evidence",
    `v2_scorecard_root=${JSON.stringify(scorecardRoot)}`,
  );
  assert.notEqual(isolatedInstallerSource, installerSource);
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(commands, { recursive: true }),
  ]);
  await Promise.all([
    cp(join(repoRoot, "deploy/scripts/common.sh"), join(scripts, "common.sh")),
    cp(
      join(repoRoot, "deploy/scripts/forecast-adjustment-scorecard-contract.mjs"),
      join(scripts, "forecast-adjustment-scorecard-contract.mjs"),
    ),
    writeFile(join(scripts, "install-adjustment-scorecard.sh"), isolatedInstallerSource),
    writeFile(join(commands, "chown"), `#!/usr/bin/env bash
set -euo pipefail
exit 0
`),
    writeFile(join(commands, "install"), `#!/usr/bin/env bash
set -euo pipefail
mode=
# strip privileged directory options in the isolated namespace
while (($#)); do
  case "$1" in
    -d) shift ;;
    -o|-g) shift 2 ;;
    -m) mode=$2; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
mkdir -p -- "$@"
# apply the requested private mode without host ownership changes
if [[ -n "$mode" ]]; then
  chmod "$mode" "$@"
fi
`),
    writeFile(join(commands, "setpriv"), `#!/usr/bin/env bash
set -euo pipefail
# strip identity switches before the isolated readability check
while (($#)) && [[ "$1" == --* ]]; do
  shift
done
exec "$@"
`),
    writeFile(join(commands, "mv"), `#!/usr/bin/env bash
set -euo pipefail
destination=\${!#}
# inject one failure only at the final v2 selection rename
if [[ \${FAIL_V2_CURRENT_MOVE:-0} == 1 && "$destination" == */v2-current.json &&
  ! -e "$MV_FAILURE_MARKER" ]]; then
  : >"$MV_FAILURE_MARKER"
  exit 23
fi
exec /usr/bin/mv "$@"
`),
  ]);
  await Promise.all([
    chmod(join(scripts, "install-adjustment-scorecard.sh"), 0o700),
    chmod(join(commands, "chown"), 0o700),
    chmod(join(commands, "install"), 0o700),
    chmod(join(commands, "mv"), 0o700),
    chmod(join(commands, "setpriv"), 0o700),
  ]);
  return {
    environment: {
      PATH: `${commands}:${fixedExecutablePath}`,
      WEATHER_ADJUSTMENT_SCORECARD_ROOT: scorecardRoot,
    },
    installer: join(scripts, "install-adjustment-scorecard.sh"),
    scorecardRoot,
  };
}

// invoke the copied installer directly inside an already-root process
function runInstallerDirectly(harness, sha256, input) {
  return spawnSync(harness.installer, [sha256], {
    encoding: "utf8",
    env: harness.environment,
    input,
  });
}

// invoke the copied v2 installer directly inside an already-root process
function runInstallerV2Directly(harness, sha256, input, extraEnvironment = {}) {
  return spawnSync(harness.installer, ["--v2", sha256], {
    encoding: "utf8",
    env: { ...harness.environment, ...extraEnvironment },
    input,
  });
}

// invoke the copied installer inside a disposable user namespace
function runInstallerInNamespace(harness, sha256, input) {
  return spawnSync("unshare", ["-Ur", harness.installer, sha256], {
    encoding: "utf8",
    env: harness.environment,
    input,
  });
}

// invoke the copied v2 installer inside a disposable user namespace
function runInstallerV2InNamespace(harness, sha256, input, extraEnvironment = {}) {
  return spawnSync("unshare", ["-Ur", harness.installer, "--v2", sha256], {
    encoding: "utf8",
    env: { ...harness.environment, ...extraEnvironment },
    input,
  });
}

// exercise the complete publication and fail-closed matrix in one owner process
async function verifyInstallerPublication(runInstaller) {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-installer-"));

  try {
    const bytes = Buffer.from(`${JSON.stringify(scorecard())}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const valid = await installerHarness(join(root, "valid"));
    const result = runInstaller(valid, digest, bytes);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      await readFile(join(valid.scorecardRoot, "scorecards", `sha256-${digest}.json`)),
      bytes,
    );
    assert.equal(
      await readFile(join(valid.scorecardRoot, "current.json"), "utf8"),
      `{"sha256":"${digest}"}\n`,
    );
    assert.equal(
      (await stat(join(valid.scorecardRoot, "scorecards", `sha256-${digest}.json`))).mode &
        0o777,
      0o600,
    );
    assert.equal((await stat(join(valid.scorecardRoot, "current.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(valid.scorecardRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(valid.scorecardRoot, "scorecards"))).mode & 0o777, 0o700);

    const failures = [
      { input: bytes, name: "wrong-sha", sha256: "0".repeat(64) },
      {
        input: Buffer.alloc(FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES + 1, 0x20),
        name: "oversized",
        sha256: digest,
      },
      { input: Buffer.from("{}\n"), name: "corrupt", sha256: digest },
    ];

    // prove every rejected payload leaves no selected or immutable object
    for (const failure of failures) {
      const harness = await installerHarness(join(root, failure.name));
      const failed = runInstaller(harness, failure.sha256, failure.input);
      assert.notEqual(failed.status, 0, failure.name);
      assert.deepEqual(await readdir(join(harness.scorecardRoot, "scorecards")), []);
      await assert.rejects(
        readFile(join(harness.scorecardRoot, "current.json")),
        (error) => error.code === "ENOENT",
      );
      assert.deepEqual(
        (await readdir(harness.scorecardRoot)).filter((name) => name.endsWith(".partial")),
        [],
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// exercise bounded v2 rotation, idempotence and version/hash refusal
async function verifyInstallerV2Publication(runInstaller, runLegacyInstaller) {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-v2-installer-"));

  try {
    const harness = await installerHarness(root);
    const firstBytes = Buffer.from(`${JSON.stringify(scorecardV2())}\n`);
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
    const oversizedHarness = await installerHarness(join(root, "oversized"));
    const oversizedBytes = Buffer.concat([
      Buffer.from(JSON.stringify(scorecardV2())),
      Buffer.alloc(FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES, 0x20),
    ]);
    const oversizedDigest = createHash("sha256").update(oversizedBytes).digest("hex");
    const oversizedResult = runInstaller(
      oversizedHarness,
      oversizedDigest,
      oversizedBytes,
    );
    assert.notEqual(oversizedResult.status, 0);
    assert.match(oversizedResult.stderr, /v2 is too large/u);
    assert.deepEqual(
      await readdir(join(oversizedHarness.scorecardRoot, "scorecards-v2")),
      [],
    );
    const secondBytes = Buffer.from(`${JSON.stringify(scorecardV2({
      actionProjectionSha256: "c".repeat(64),
      generatedAt: "2099-10-02T01:00:00.000Z",
      history: [{
        ...scorecardV2().history[0],
        actionProjectionSha256: "c".repeat(64),
        occurredAt: "2099-10-02T00:59:00.000Z",
      }],
      validThrough: "2099-10-09T01:00:00.000Z",
    }))}\n`);
    const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
    const locked = await installerHarness(join(root, "locked"));
    await mkdir(locked.scorecardRoot, { recursive: true, mode: 0o700 });
    const holder = spawn("bash", [
      "-c",
      'exec 9<"$1"; flock --exclusive 9; printf ready; read -r ignored || :',
      "scorecard-lock-holder",
      locked.scorecardRoot,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(holder.stdout, "data");
      const concurrent = runInstaller(locked, firstDigest, firstBytes);
      assert.notEqual(concurrent.status, 0);
      assert.match(concurrent.stderr, /another scorecard installation is in flight/u);
      await assert.rejects(readFile(join(locked.scorecardRoot, "v2-current.json")), { code: "ENOENT" });
    } finally {
      const exited = once(holder, "exit");
      holder.stdin.end();
      await exited;
    }

    const hidden = await installerHarness(join(root, "hidden"));
    await mkdir(join(hidden.scorecardRoot, "scorecards-v2"), { recursive: true, mode: 0o700 });
    await writeFile(join(hidden.scorecardRoot, "scorecards-v2/.unanchored"), "unanchored", { mode: 0o600 });
    const hiddenResult = runInstaller(hidden, firstDigest, firstBytes);
    assert.notEqual(hiddenResult.status, 0);
    assert.match(hiddenResult.stderr, /invalid entry/u);

    const failureMarker = join(root, "mv-failure-marker");
    const first = runInstaller(harness, firstDigest, firstBytes, {
        FAIL_V2_CURRENT_MOVE: "1",
        MV_FAILURE_MARKER: failureMarker,
    });
    assert.equal(first.status, 23, first.stderr);
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-pending.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    await assert.rejects(
      readFile(join(harness.scorecardRoot, "v2-current.json")),
      (error) => error.code === "ENOENT",
    );
    const resumed = runInstaller(harness, firstDigest, firstBytes);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-current.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    const secondFailureMarker = join(root, "second-mv-failure-marker");
    const interruptedSecond = runInstaller(harness, secondDigest, secondBytes, {
      FAIL_V2_CURRENT_MOVE: "1",
      MV_FAILURE_MARKER: secondFailureMarker,
    });
    assert.equal(interruptedSecond.status, 23, interruptedSecond.stderr);
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-current.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-previous.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-pending.json"), "utf8"),
      `{"sha256":"${secondDigest}"}\n`,
    );
    const second = runInstaller(harness, secondDigest, secondBytes);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-current.json"), "utf8"),
      `{"sha256":"${secondDigest}"}\n`,
    );
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-previous.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    const thirdBytes = Buffer.from(`${JSON.stringify(scorecardV2({
      actionProjectionSha256: "d".repeat(64),
      generatedAt: "2099-10-03T01:00:00.000Z",
      history: [{
        ...scorecardV2().history[0],
        actionProjectionSha256: "d".repeat(64),
        occurredAt: "2099-10-03T00:59:00.000Z",
      }],
      validThrough: "2099-10-10T01:00:00.000Z",
    }))}\n`);
    const thirdDigest = createHash("sha256").update(thirdBytes).digest("hex");
    const third = runInstaller(harness, thirdDigest, thirdBytes);
    assert.notEqual(third.status, 0);
    assert.match(third.stderr, /retirement authority is required/u);
    await assert.rejects(
      readFile(join(harness.scorecardRoot, "scorecards-v2", `sha256-${thirdDigest}.json`)),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      readFile(join(harness.scorecardRoot, "v2-pending.json")),
      (error) => error.code === "ENOENT",
    );
    const repeated = runInstaller(harness, secondDigest, secondBytes);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(
      await readFile(join(harness.scorecardRoot, "v2-previous.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    const legacyBytes = Buffer.from(`${JSON.stringify(scorecard())}\n`);
    const legacyDigest = createHash("sha256").update(legacyBytes).digest("hex");
    const wrongVersion = runInstaller(harness, legacyDigest, legacyBytes);
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /requires a v2 document/u);
    const wrongHash = runInstaller(harness, "0".repeat(64), secondBytes);
    assert.notEqual(wrongHash.status, 0);
    assert.match(wrongHash.stderr, /requested SHA-256/u);

    const migration = await installerHarness(join(root, "migration"));
    assert.equal(runLegacyInstaller(migration, legacyDigest, legacyBytes).status, 0);
    assert.equal(runInstaller(migration, firstDigest, firstBytes).status, 0);
    assert.equal(
      await readFile(join(migration.scorecardRoot, "v2-pending.json"), "utf8"),
      `{"sha256":"${firstDigest}"}\n`,
    );
    await assert.rejects(
      readFile(join(migration.scorecardRoot, "v2-current.json")),
      (error) => error.code === "ENOENT",
    );
    assert.equal(
      await readFile(join(migration.scorecardRoot, "current.json"), "utf8"),
      `{"sha256":"${legacyDigest}"}\n`,
    );
    const migrationRefusal = runInstaller(migration, secondDigest, secondBytes);
    assert.notEqual(migrationRefusal.status, 0);
    assert.match(migrationRefusal.stderr, /another v2 scorecard installation is pending/u);
    await assert.rejects(
      readFile(join(migration.scorecardRoot, "scorecards-v2", `sha256-${secondDigest}.json`)),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// format one bounded privilege-child failure without hiding its exit evidence
function childFailure(result, operation) {
  return [
    `${operation} failed`,
    result.error?.message ?? "",
    result.stderr ?? "",
    result.stdout ?? "",
  ].filter((line) => line.length > 0).join("\n");
}

test(installerTestName, async () => {
  const uid = process.getuid?.();
  const isRoot = uid === 0;
  const isRequestedRootChild = process.env[rootChildMarker] === "1";

  // reject a forged child marker before any fixture creation
  if (isRequestedRootChild && !isRoot) {
    assert.fail("scorecard installer root child is not root");
  }

  // keep root-owned fixtures and cleanup wholly inside the root child
  if (isRoot) {
    await verifyInstallerPublication(runInstallerDirectly);
    return;
  }

  const namespaceProbe = spawnSync("unshare", ["-Ur", "true"], {
    encoding: "utf8",
    env: { PATH: fixedExecutablePath },
    timeout: 5_000,
  });

  // prefer the unprivileged namespace when the host permits uid mapping
  if (namespaceProbe.status === 0) {
    await verifyInstallerPublication(runInstallerInNamespace);
    return;
  }

  const rootChild = spawnSync("sudo", [
    "-n",
    "/usr/bin/env",
    `PATH=${fixedExecutablePath}`,
    `${rootChildMarker}=1`,
    process.execPath,
    "--test",
    `--test-name-pattern=^${installerTestName}$`,
    fileURLToPath(import.meta.url),
  ], {
    encoding: "utf8",
    env: { PATH: fixedExecutablePath },
    timeout: 30_000,
  });
  assert.equal(rootChild.status, 0, childFailure(rootChild, "scorecard installer root child"));
});

test("v2 installer rotates only fixed hash pointers and is idempotent", async () => {
  const uid = process.getuid?.();
  const isRoot = uid === 0;

  // keep root-owned fixtures and cleanup wholly inside the root process
  if (isRoot) {
    await verifyInstallerV2Publication(runInstallerV2Directly, runInstallerDirectly);
    return;
  }

  const namespaceProbe = spawnSync("unshare", ["-Ur", "true"], {
    encoding: "utf8",
    env: { PATH: fixedExecutablePath },
    timeout: 5_000,
  });

  // use the isolated uid namespace when available
  if (namespaceProbe.status === 0) {
    await verifyInstallerV2Publication(runInstallerV2InNamespace, runInstallerInNamespace);
    return;
  }

  // retain explicit coverage only on hosts that can provide root isolation
  assert.match(namespaceProbe.stderr, /(?:Operation not permitted|unshare failed)/u);
});

test("publisher hashes and transports the exact bounded no-follow capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-publisher-"));

  try {
    const publisher = await publisherHarness(root);
    const input = join(root, "scorecard.json");
    const argumentsPath = join(root, "arguments");
    const stdinPath = join(root, "stdin");
    const bytes = Buffer.from(`${JSON.stringify(scorecard())}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(input, bytes, { mode: 0o600 });
    const result = spawnSync(publisher, [input], {
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH_ARGUMENTS_PATH: argumentsPath,
        PUBLISH_STDIN_PATH: stdinPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(argumentsPath, "utf8"),
      `install-adjustment-scorecard ${digest}\n`,
    );
    assert.deepEqual(await readFile(stdinPath), bytes);

    const v2Bytes = Buffer.from(`${JSON.stringify(scorecardV2())}\n`);
    const v2Digest = createHash("sha256").update(v2Bytes).digest("hex");
    await writeFile(input, v2Bytes, { mode: 0o600 });
    const v2Result = spawnSync(publisher, [input], {
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH_ARGUMENTS_PATH: argumentsPath,
        PUBLISH_STDIN_PATH: stdinPath,
      },
    });
    assert.equal(v2Result.status, 0, v2Result.stderr);
    assert.equal(
      await readFile(argumentsPath, "utf8"),
      `install-adjustment-scorecard-v2 ${v2Digest}\n`,
    );
    assert.deepEqual(await readFile(stdinPath), v2Bytes);

    const source = await readFile(publisher, "utf8");
    assert.match(source, /O_NOFOLLOW/u);
    assert.equal(source.match(/await open\(/gu)?.length, 1);
    assert.doesNotMatch(source, /readFile\(scorecardPath\)|cat -- "\$scorecard"/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("publisher rejects linked, oversized, invalid, and failed transports", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-publisher-reject-"));

  try {
    const publisher = await publisherHarness(root);
    const argumentsPath = join(root, "arguments");
    const stdinPath = join(root, "stdin");
    const valid = join(root, "valid.json");
    const linked = join(root, "linked.json");
    const oversized = join(root, "oversized.json");
    const oversizedV2 = join(root, "oversized-v2.json");
    const invalid = join(root, "invalid.json");
    await writeFile(valid, `${JSON.stringify(scorecard())}\n`, { mode: 0o600 });
    await symlink(valid, linked);
    await writeFile(
      oversized,
      Buffer.alloc(FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES + 1, 0x20),
      { mode: 0o600 },
    );
    await writeFile(
      oversizedV2,
      Buffer.concat([
        Buffer.from(JSON.stringify(scorecardV2())),
        Buffer.alloc(FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES, 0x20),
      ]),
      { mode: 0o600 },
    );
    await writeFile(invalid, "{}\n", { mode: 0o600 });
    const environment = {
      ...process.env,
      PUBLISH_ARGUMENTS_PATH: argumentsPath,
      PUBLISH_STDIN_PATH: stdinPath,
    };

    for (const input of [linked, oversized, oversizedV2, invalid]) {
      const result = spawnSync(publisher, [input], { encoding: "utf8", env: environment });
      assert.notEqual(result.status, 0, input);
    }

    const failed = spawnSync(publisher, [valid], {
      encoding: "utf8",
      env: { ...environment, PUBLISH_FAIL: "1" },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /status 19/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
