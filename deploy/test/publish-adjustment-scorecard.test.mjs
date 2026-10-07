import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { join, resolve } from "node:path";
import test from "node:test";

import {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
} from "../scripts/forecast-adjustment-scorecard-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

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
    cp(
      join(repoRoot, "deploy/scripts/install-adjustment-scorecard.sh"),
      join(scripts, "install-adjustment-scorecard.sh"),
    ),
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
  ]);
  await Promise.all([
    chmod(join(scripts, "install-adjustment-scorecard.sh"), 0o700),
    chmod(join(commands, "chown"), 0o700),
    chmod(join(commands, "install"), 0o700),
    chmod(join(commands, "setpriv"), 0o700),
  ]);
  return {
    environment: {
      ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      WEATHER_ADJUSTMENT_SCORECARD_ROOT: scorecardRoot,
    },
    installer: join(scripts, "install-adjustment-scorecard.sh"),
    scorecardRoot,
  };
}

test("installer consumes exact stdin bytes and fails closed before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-installer-"));

  try {
    const bytes = Buffer.from(`${JSON.stringify(scorecard())}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const valid = await installerHarness(join(root, "valid"));
    const result = spawnSync("unshare", ["-Ur", valid.installer, digest], {
      encoding: "utf8",
      env: valid.environment,
      input: bytes,
    });
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
      const failed = spawnSync(
        "unshare",
        ["-Ur", harness.installer, failure.sha256],
        { encoding: "utf8", env: harness.environment, input: failure.input },
      );
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
    const invalid = join(root, "invalid.json");
    await writeFile(valid, `${JSON.stringify(scorecard())}\n`, { mode: 0o600 });
    await symlink(valid, linked);
    await writeFile(
      oversized,
      Buffer.alloc(FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES + 1, 0x20),
      { mode: 0o600 },
    );
    await writeFile(invalid, "{}\n", { mode: 0o600 });
    const environment = {
      ...process.env,
      PUBLISH_ARGUMENTS_PATH: argumentsPath,
      PUBLISH_STDIN_PATH: stdinPath,
    };

    for (const input of [linked, oversized, invalid]) {
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
