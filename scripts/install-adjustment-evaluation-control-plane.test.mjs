import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const installer = join(repoRoot, "scripts/install-adjustment-evaluation-control-plane.sh");
const previousDigest = "ae098ea591868b9f0d093815fa94d05082af96ece7e9f6fd62e1d903bb8179eb";
const previousRelease = "2026.10.01-6";
const previousWebCommit = "287399e8d01059b9b7f80da8092290c40d01b26c";
const repairPreviousCommit = "247911559d2d1fc2fae69031984ffdde92474338";
const repairPreviousDigest = "9a48c7e5c7450dfeee12c0813bf343f24f6c0f68e6472338bf33dde5c6fea2c0";
const repairPreviousRelease = "2026.10.07-1";
const passwordPreviousCommit = "cddaa7e971cb9c7b58173244c770fa94a41451dd";
const passwordPreviousDigest = "5685ead4440468ecdb58402fbe14e76ce63ed03a018b9b4724fa24ffef4eb3c8";
const passwordPreviousRelease = "2026.10.07-2";
// retain the immutable historical password repair candidate
const passwordCandidateCommit = "072af3f880431ff9020a2ec2ada222210e45f00b";
const passwordCandidateDigest = "16d871c7aebb3a34097af219fd5c76a93b3ff1be3af521643dbf3a4d2041c61d";
const archivePaths = [
  "deploy/scripts",
  "deploy/postgres",
  "deploy/systemd",
  "deploy/sudoers",
  "deploy/compose.yaml",
];

// hash one exact file
async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// execute the sourced installer against a disposable deployment
function runInstaller(fixture, failAfter = 0) {
  return spawnSync("bash", [
    "-c",
    `source "$1"
require_quiet_weather() { :; }
install_control_plane "$2" "$3" "$4" "$5" "$6" "$7"`,
    "adjustment-control-test",
    installer,
    fixture.installed,
    fixture.backups,
    fixture.archive,
    fixture.archiveSha256,
    fixture.candidateDigest,
    String(failAfter),
  ], { cwd: repoRoot, encoding: "utf8" });
}

// execute the sourced first-v12 repair against a disposable deployment
function runRepairInstaller(fixture, failAfter = 0) {
  return spawnSync("bash", [
    "-c",
    `source "$1"
require_quiet_weather() { :; }
repair_v12_control_plane "$2" "$3" "$4" "$5" "$6" "$7"`,
    "adjustment-control-repair-test",
    installer,
    fixture.installed,
    fixture.backups,
    fixture.archive,
    fixture.archiveSha256,
    fixture.candidateDigest,
    String(failAfter),
  ], { cwd: repoRoot, encoding: "utf8" });
}

// execute the sourced password-only repair against a disposable deployment
function runPasswordRepairInstaller(fixture, failAfter = 0) {
  return spawnSync("bash", [
    "-c",
    `source "$1"
require_quiet_weather() { :; }
repair_password_v12_control_plane "$2" "$3" "$4" "$5" "$6" "$7"`,
    "adjustment-control-password-repair-test",
    installer,
    fixture.installed,
    fixture.backups,
    fixture.archive,
    fixture.archiveSha256,
    fixture.candidateDigest,
    String(failAfter),
  ], { cwd: repoRoot, encoding: "utf8" });
}

// rebuild one private repair archive and its bound identities
async function refreshRepairCandidate(fixture) {
  execFileSync("tar", ["-cf", fixture.archive, "-C", fixture.candidate, ...archivePaths]);
  fixture.archiveSha256 = await fileHash(fixture.archive);
  const digest = spawnSync("bash", [
    "-c",
    'source "$1"; control_digest "$2"',
    "adjustment-control-repair-test",
    installer,
    fixture.candidate,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(digest.status, 0, digest.stderr);
  fixture.candidateDigest = digest.stdout.trim();
}

// construct the exact first-v12 release and its two-file repair candidate
async function createRepairFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-control-repair-"));
  const baseline = join(root, "baseline");
  const installed = join(root, "installed");
  const candidate = join(root, "candidate");
  const backups = join(root, "backups");
  const archive = join(root, "candidate.tar");
  const baselineArchive = join(root, "baseline.tar");
  await Promise.all([mkdir(baseline), mkdir(installed), mkdir(candidate)]);
  execFileSync("git", [
    "-c",
    "tar.umask=0022",
    "archive",
    "--format=tar",
    `--output=${baselineArchive}`,
    repairPreviousCommit,
    ...archivePaths,
  ], { cwd: repoRoot });
  execFileSync("tar", ["-xf", baselineArchive, "-C", baseline]);
  await cp(join(baseline, "deploy"), join(installed, "deploy"), { recursive: true });
  await cp(join(baseline, "deploy"), join(candidate, "deploy"), { recursive: true });

  // overlay the frozen repair rather than a later checkout
  for (const file of ["adjustment-evidence-store.mjs", "update.sh"]) {
    const bytes = execFileSync("git", [
      "show",
      `${passwordPreviousCommit}:deploy/scripts/${file}`,
    ], { cwd: repoRoot });
    await writeFile(join(candidate, `deploy/scripts/${file}`), bytes, { mode: 0o644 });
    // restore the reviewed executable bits as well as content
    await chmod(join(candidate, `deploy/scripts/${file}`), file.endsWith(".sh") ? 0o755 : 0o644);
  }

  await Promise.all([
    mkdir(join(installed, "deploy/state")),
    mkdir(join(installed, "deploy/releases")),
  ]);
  const releaseBytes = [
    `WEATHER_RELEASE=${repairPreviousRelease}`,
    `WEATHER_CONTROL_PLANE_SHA256=${repairPreviousDigest}`,
    "WEATHER_CONTROL_PLANE_VERSION=12",
    "WEATHER_SERVER_IMAGE=registry.example/weather-server@sha256:baseline",
    "WEATHER_WEB_IMAGE=registry.example/weather-web@sha256:baseline",
    "",
  ].join("\n");
  await writeFile(
    join(installed, "deploy/state/current-release"),
    `${repairPreviousRelease}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(installed, `deploy/releases/${repairPreviousRelease}.env`),
    releaseBytes,
    { mode: 0o600 },
  );
  const fixture = {
    archive,
    archiveSha256: "",
    backups,
    baseline,
    candidate,
    candidateDigest: "",
    installed,
    releaseBytes,
    root,
  };
  await refreshRepairCandidate(fixture);
  const baselineDigest = spawnSync("bash", [
    "-c",
    'source "$1"; verify_repair_previous_manifest "$2"; control_digest "$2"',
    "adjustment-control-repair-test",
    installer,
    baseline,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(baselineDigest.status, 0, baselineDigest.stderr);
  assert.equal(baselineDigest.stdout.trim(), repairPreviousDigest);
  assert.equal(fixture.candidateDigest, passwordPreviousDigest);
  return fixture;
}

// construct the exact second-v12 release and its four-file password candidate
async function createPasswordRepairFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-password-control-repair-"));
  const baseline = join(root, "baseline");
  const installed = join(root, "installed");
  const candidate = join(root, "candidate");
  const backups = join(root, "backups");
  const archive = join(root, "candidate.tar");
  const baselineArchive = join(root, "baseline.tar");
  await Promise.all([mkdir(baseline), mkdir(installed), mkdir(candidate)]);
  execFileSync("git", [
    "-c",
    "tar.umask=0022",
    "archive",
    "--format=tar",
    `--output=${baselineArchive}`,
    passwordPreviousCommit,
    ...archivePaths,
  ], { cwd: repoRoot });
  execFileSync("tar", ["-xf", baselineArchive, "-C", baseline]);
  await cp(join(baseline, "deploy"), join(installed, "deploy"), { recursive: true });
  await cp(join(baseline, "deploy"), join(candidate, "deploy"), { recursive: true });

  // overlay the frozen repair rather than a later checkout
  for (const file of [
    "install-adjustment-scorecard.sh",
    "weather-admin-store.mjs",
    "web-server.mjs",
    "update.sh",
  ]) {
    const bytes = execFileSync("git", ["show", `${passwordCandidateCommit}:deploy/scripts/${file}`],
      { cwd: repoRoot });
    await writeFile(join(candidate, `deploy/scripts/${file}`), bytes, { mode: 0o644 });
    // restore the reviewed executable bits as well as content
    await chmod(join(candidate, `deploy/scripts/${file}`), file.endsWith(".sh") ? 0o755 : 0o644);
  }

  await Promise.all([
    mkdir(join(installed, "deploy/state")),
    mkdir(join(installed, "deploy/releases")),
  ]);
  const releaseBytes = [
    `WEATHER_RELEASE=${passwordPreviousRelease}`,
    `WEATHER_CONTROL_PLANE_SHA256=${passwordPreviousDigest}`,
    "WEATHER_CONTROL_PLANE_VERSION=12",
    "WEATHER_SERVER_IMAGE=registry.example/weather-server@sha256:baseline",
    "WEATHER_WEB_IMAGE=registry.example/weather-web@sha256:baseline",
    "",
  ].join("\n");
  await writeFile(
    join(installed, "deploy/state/current-release"),
    `${passwordPreviousRelease}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(installed, `deploy/releases/${passwordPreviousRelease}.env`),
    releaseBytes,
    { mode: 0o600 },
  );
  const fixture = {
    archive,
    archiveSha256: "",
    backups,
    baseline,
    candidate,
    candidateDigest: "",
    installed,
    releaseBytes,
    root,
  };
  await refreshRepairCandidate(fixture);
  const baselineDigest = spawnSync("bash", [
    "-c",
    'source "$1"; verify_password_previous_manifest "$2"; control_digest "$2"',
    "adjustment-control-password-repair-test",
    installer,
    baseline,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(baselineDigest.status, 0, baselineDigest.stderr);
  assert.equal(baselineDigest.stdout.trim(), passwordPreviousDigest);
  assert.equal(fixture.candidateDigest, passwordCandidateDigest);
  return fixture;
}

// require one fixture to retain the exact reviewed password predecessor
function assertPasswordPredecessor(fixture) {
  const verified = spawnSync("bash", [
    "-c",
    'source "$1"; verify_password_previous_manifest "$2"',
    "adjustment-control-password-repair-test",
    installer,
    fixture.installed,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
}

// construct the exact reviewed live v11 tree and frozen initial v12 candidate
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-control-"));
  const old = join(root, "old");
  const installed = join(root, "installed");
  const candidate = join(root, "candidate");
  const backups = join(root, "backups");
  const archive = join(root, "candidate.tar");
  const candidateArchive = join(root, "candidate-source.tar");
  const oldArchive = join(root, "old.tar");
  await Promise.all([mkdir(old), mkdir(installed), mkdir(candidate)]);
  execFileSync("git", [
    "-c",
    "tar.umask=0022",
    "archive",
    "--format=tar",
    `--output=${oldArchive}`,
    previousRelease,
    ...archivePaths,
  ], { cwd: repoRoot });
  execFileSync("tar", ["-xf", oldArchive, "-C", old]);
  await rm(join(old, "deploy/scripts/home-network.mjs"));

  // restore the two older live host files absent from the tagged tree
  for (const file of ["weather-admin-store.mjs", "web-server.mjs"]) {
    const bytes = execFileSync(
      "git",
      ["show", `${previousWebCommit}:deploy/scripts/${file}`],
      { cwd: repoRoot },
    );
    await writeFile(join(old, `deploy/scripts/${file}`), bytes, { mode: 0o644 });
  }

  await cp(join(old, "deploy"), join(installed, "deploy"), { recursive: true });
  await Promise.all([
    mkdir(join(installed, "deploy/state")),
    mkdir(join(installed, "deploy/releases")),
  ]);
  await writeFile(join(installed, "deploy/state/current-release"), `${previousRelease}\n`, {
    mode: 0o600,
  });
  await writeFile(join(installed, `deploy/releases/${previousRelease}.env`), [
    `WEATHER_RELEASE=${previousRelease}`,
    `WEATHER_CONTROL_PLANE_SHA256=${previousDigest}`,
    "WEATHER_CONTROL_PLANE_VERSION=11",
    "",
  ].join("\n"), { mode: 0o600 });

  // materialize the frozen initial v12 candidate
  execFileSync("git", [
    "-c",
    "tar.umask=0022",
    "archive",
    "--format=tar",
    `--output=${candidateArchive}`,
    repairPreviousCommit,
    ...archivePaths,
  ], { cwd: repoRoot });
  execFileSync("tar", ["--same-permissions", "-xf", candidateArchive, "-C", candidate]);
  execFileSync("tar", ["-cf", archive, "-C", candidate, ...archivePaths]);
  const digest = spawnSync("bash", [
    "-c",
    'source "$1"; control_digest "$2"',
    "adjustment-control-test",
    installer,
    candidate,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(digest.status, 0, digest.stderr);
  const oldDigest = spawnSync("bash", [
    "-c",
    'source "$1"; verify_previous_manifest "$2"; control_digest "$2"',
    "adjustment-control-test",
    installer,
    old,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(oldDigest.status, 0, oldDigest.stderr);
  assert.equal(oldDigest.stdout.trim(), previousDigest);
  assert.equal(digest.stdout.trim(), repairPreviousDigest);
  return {
    archive,
    archiveSha256: await fileHash(archive),
    backups,
    candidate,
    candidateDigest: digest.stdout.trim(),
    installed,
    old,
    root,
  };
}

test("v12 installer accepts only the exact reviewed live v11 predecessor", async () => {
  const fixture = await createFixture();

  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed version-twelve control plane/u);
    assert.equal(
      await readFile(join(fixture.installed, "deploy/state/current-release"), "utf8"),
      `${previousRelease}\n`,
    );
    assert.equal(
      await readFile(join(fixture.installed, `deploy/releases/${previousRelease}.env`), "utf8"),
      `WEATHER_RELEASE=${previousRelease}\n` +
        `WEATHER_CONTROL_PLANE_SHA256=${previousDigest}\n` +
        "WEATHER_CONTROL_PLANE_VERSION=11\n",
    );
    const backups = await readdir(fixture.backups);
    assert.equal(backups.some((name) => name.startsWith("v11-ae098ea59186.")), true);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("v12 installer restores v11 after ordinary failure and supports exact crash recovery", async () => {
  const fixture = await createFixture();

  try {
    const failed = runInstaller(fixture, 3);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Restoring retained version-eleven/u);
    const restored = spawnSync("bash", [
      "-c",
      'source "$1"; verify_previous_manifest "$2"',
      "adjustment-control-test",
      installer,
      fixture.installed,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(restored.status, 0, restored.stderr);

    const succeeded = runInstaller(fixture);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    const backupName = (await readdir(fixture.backups))
      .find((name) => name.startsWith("v11-ae098ea59186."));
    assert.notEqual(backupName, undefined);
    const backup = join(fixture.backups, backupName);
    const recovered = spawnSync("bash", [
      "-c",
      'source "$1"; require_quiet_weather() { :; }; recover_control_plane "$2" "$3"',
      "adjustment-control-test",
      installer,
      fixture.installed,
      backup,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("tagged local-main control bytes are not accepted as the live predecessor", async () => {
  const fixture = await createFixture();

  try {
    const localMain = join(fixture.root, "local-main");
    await cp(join(fixture.candidate, "deploy"), join(localMain, "deploy"), {
      recursive: true,
    });
    const rejected = spawnSync("bash", [
      "-c",
      'source "$1"; verify_previous_manifest "$2"',
      "adjustment-control-test",
      installer,
      localMain,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /differs from reviewed v11/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("first-v12 repair accepts only the frozen release and fixed two-file candidate", async () => {
  const fixture = await createRepairFixture();

  try {
    const result = runRepairInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed first version-twelve control-plane repair/u);
    assert.equal(
      await readFile(join(fixture.installed, "deploy/state/current-release"), "utf8"),
      `${repairPreviousRelease}\n`,
    );
    assert.equal(
      await readFile(
        join(fixture.installed, `deploy/releases/${repairPreviousRelease}.env`),
        "utf8",
      ),
      fixture.releaseBytes,
    );
    assert.equal(
      await fileHash(join(fixture.installed, "deploy/scripts/adjustment-evidence-store.mjs")),
      await fileHash(join(fixture.candidate, "deploy/scripts/adjustment-evidence-store.mjs")),
    );
    assert.equal(
      await fileHash(join(fixture.installed, "deploy/scripts/update.sh")),
      await fileHash(join(fixture.candidate, "deploy/scripts/update.sh")),
    );
    const backupName = (await readdir(fixture.backups))
      .find((name) => name.startsWith("v12-9a48c7e5c745."));
    assert.notEqual(backupName, undefined);
    const verifiedBackup = spawnSync("bash", [
      "-c",
      'source "$1"; verify_repair_previous_manifest "$2"',
      "adjustment-control-repair-test",
      installer,
      join(fixture.backups, backupName),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(verifiedBackup.status, 0, verifiedBackup.stderr);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("first-v12 repair restores both ordinary failure points and supports exact recovery", async () => {
  const fixture = await createRepairFixture();

  try {
    // exercise both bounded replacement failure points
    for (const failAfter of [1, 2]) {
      const failed = runRepairInstaller(fixture, failAfter);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Restoring retained first version-twelve/u);
      const restored = spawnSync("bash", [
        "-c",
        'source "$1"; verify_repair_previous_manifest "$2"',
        "adjustment-control-repair-test",
        installer,
        fixture.installed,
      ], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(
        await readFile(
          join(fixture.installed, `deploy/releases/${repairPreviousRelease}.env`),
          "utf8",
        ),
        fixture.releaseBytes,
      );
    }

    const succeeded = runRepairInstaller(fixture);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    const backupName = (await readdir(fixture.backups))
      .find((name) => name.startsWith("v12-9a48c7e5c745."));
    assert.notEqual(backupName, undefined);
    const recovered = spawnSync("bash", [
      "-c",
      'source "$1"; require_quiet_weather() { :; }; recover_v12_control_plane "$2" "$3"',
      "adjustment-control-repair-test",
      installer,
      fixture.installed,
      join(fixture.backups, backupName),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(
      await readFile(
        join(fixture.installed, `deploy/releases/${repairPreviousRelease}.env`),
        "utf8",
      ),
      fixture.releaseBytes,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("first-v12 repair rejects installed drift and unreviewed candidate changes", async () => {
  const drifted = await createRepairFixture();
  const unreviewed = await createRepairFixture();

  try {
    await writeFile(
      join(drifted.installed, "deploy/scripts/common.sh"),
      "# drift\n",
      { flag: "a" },
    );
    const driftRejected = runRepairInstaller(drifted);
    assert.notEqual(driftRejected.status, 0);
    assert.match(driftRejected.stderr, /differs from reviewed first v12/u);

    await writeFile(
      join(unreviewed.candidate, "deploy/scripts/common.sh"),
      "# unreviewed\n",
      { flag: "a" },
    );
    await refreshRepairCandidate(unreviewed);
    const unreviewedRejected = runRepairInstaller(unreviewed);
    assert.notEqual(unreviewedRejected.status, 0);
    assert.match(unreviewedRejected.stderr, /changes unreviewed path: deploy\/scripts\/common\.sh/u);
  } finally {
    await Promise.all([
      rm(drifted.root, { force: true, recursive: true }),
      rm(unreviewed.root, { force: true, recursive: true }),
    ]);
  }
});

test("first-v12 repair rejects the reviewed digest without the exact release identity", async () => {
  const fixture = await createRepairFixture();

  try {
    await writeFile(
      join(fixture.installed, `deploy/releases/${repairPreviousRelease}.env`),
      [
        "WEATHER_RELEASE=2026.10.07-2",
        `WEATHER_CONTROL_PLANE_SHA256=${repairPreviousDigest}`,
        "WEATHER_CONTROL_PLANE_VERSION=12",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const rejected = runRepairInstaller(fixture);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /first v12 release identity differs/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("password-only repair accepts the frozen release and exact four-file candidate", async () => {
  const fixture = await createPasswordRepairFixture();

  try {
    const result = runPasswordRepairInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed password-only version-twelve control-plane repair/u);
    assert.equal(
      await readFile(join(fixture.installed, "deploy/state/current-release"), "utf8"),
      `${passwordPreviousRelease}\n`,
    );
    assert.equal(
      await readFile(
        join(fixture.installed, `deploy/releases/${passwordPreviousRelease}.env`),
        "utf8",
      ),
      fixture.releaseBytes,
    );
    // bind every installed repair path to the candidate bytes
    for (const file of [
      "install-adjustment-scorecard.sh",
      "weather-admin-store.mjs",
      "web-server.mjs",
      "update.sh",
    ]) {
      assert.equal(
        await fileHash(join(fixture.installed, `deploy/scripts/${file}`)),
        await fileHash(join(fixture.candidate, `deploy/scripts/${file}`)),
      );
    }
    const backupName = (await readdir(fixture.backups))
      .find((name) => name.startsWith("v12-5685ead44404."));
    assert.notEqual(backupName, undefined);
    const verifiedBackup = spawnSync("bash", [
      "-c",
      'source "$1"; verify_password_previous_manifest "$2"',
      "adjustment-control-password-repair-test",
      installer,
      join(fixture.backups, backupName),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(verifiedBackup.status, 0, verifiedBackup.stderr);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("password-only repair restores all failure points and supports exact recovery", async () => {
  const fixture = await createPasswordRepairFixture();

  try {
    // exercise every bounded replacement failure point
    for (const failAfter of [1, 2, 3, 4]) {
      const failed = runPasswordRepairInstaller(fixture, failAfter);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Restoring retained password-only version-twelve/u);
      assertPasswordPredecessor(fixture);
      assert.equal(
        await readFile(
          join(fixture.installed, `deploy/releases/${passwordPreviousRelease}.env`),
          "utf8",
        ),
        fixture.releaseBytes,
      );
    }

    const succeeded = runPasswordRepairInstaller(fixture);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    const backupName = (await readdir(fixture.backups))
      .find((name) => name.startsWith("v12-5685ead44404."));
    assert.notEqual(backupName, undefined);
    const recovered = spawnSync("bash", [
      "-c",
      'source "$1"; require_quiet_weather() { :; }; recover_password_v12_control_plane "$2" "$3"',
      "adjustment-control-password-repair-test",
      installer,
      fixture.installed,
      join(fixture.backups, backupName),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
    assertPasswordPredecessor(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("password-only repair rejects installed drift and release identity changes before mutation", async () => {
  const scenarios = [
    {
      expected: /differs from reviewed password predecessor/u,
      // drift one installed public file
      mutate: async (fixture) => await writeFile(
        join(fixture.installed, "deploy/scripts/common.sh"),
        "# drift\n",
        { flag: "a" },
      ),
    },
    {
      expected: /installed release is not the reviewed password predecessor/u,
      // change only the current release pointer
      mutate: async (fixture) => await writeFile(
        join(fixture.installed, "deploy/state/current-release"),
        "2026.10.07-1\n",
        { mode: 0o600 },
      ),
    },
    {
      expected: /password predecessor control-plane digest differs/u,
      // replace only the persisted predecessor digest
      mutate: async (fixture) => await writeFile(
        join(fixture.installed, `deploy/releases/${passwordPreviousRelease}.env`),
        fixture.releaseBytes.replace(passwordPreviousDigest, "a".repeat(64)),
        { mode: 0o600 },
      ),
    },
    {
      expected: /password predecessor control-plane version differs/u,
      // replace only the persisted predecessor version
      mutate: async (fixture) => await writeFile(
        join(fixture.installed, `deploy/releases/${passwordPreviousRelease}.env`),
        fixture.releaseBytes.replace("WEATHER_CONTROL_PLANE_VERSION=12", "WEATHER_CONTROL_PLANE_VERSION=11"),
        { mode: 0o600 },
      ),
    },
  ];

  // isolate every pre-mutation rejection case
  for (const scenario of scenarios) {
    const fixture = await createPasswordRepairFixture();
    try {
      const installedScorecardHash = await fileHash(
        join(fixture.installed, "deploy/scripts/install-adjustment-scorecard.sh"),
      );
      await scenario.mutate(fixture);
      const rejected = runPasswordRepairInstaller(fixture);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, scenario.expected);
      assert.equal(
        await fileHash(join(fixture.installed, "deploy/scripts/install-adjustment-scorecard.sh")),
        installedScorecardHash,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

test("password-only repair rejects incomplete, extra, wrong, linked, unsafe, and traversing candidates", async () => {
  const scenarios = [
    {
      expected: /repair handoff paths must be absolute/u,
      // replace the archive with a relative handoff path
      mutate: async (fixture) => {
        fixture.archive = "candidate.tar";
      },
    },
    {
      expected: /repair archive is missing or linked/u,
      // replace the private archive path with a symlink
      mutate: async (fixture) => {
        const retainedArchive = `${fixture.archive}.retained`;
        await cp(fixture.archive, retainedArchive);
        await unlink(fixture.archive);
        await symlink(retainedArchive, fixture.archive);
      },
    },
    {
      expected: /repair archive hash differs from the committed artifact/u,
      // present a different committed archive identity
      mutate: async (fixture) => {
        fixture.archiveSha256 = "a".repeat(64);
      },
    },
    {
      expected: /leaves required path unchanged: deploy\/scripts\/web-server\.mjs/u,
      // omit one required change
      mutate: async (fixture) => {
        await cp(
          join(fixture.baseline, "deploy/scripts/web-server.mjs"),
          join(fixture.candidate, "deploy/scripts/web-server.mjs"),
        );
        await refreshRepairCandidate(fixture);
      },
    },
    {
      expected: /changes unreviewed path: deploy\/scripts\/common\.sh/u,
      // add one fifth changed control path
      mutate: async (fixture) => {
        await writeFile(
          join(fixture.candidate, "deploy/scripts/common.sh"),
          "# fifth path\n",
          { flag: "a" },
        );
        await refreshRepairCandidate(fixture);
      },
    },
    {
      expected: /does not pin the reviewed password-only version-twelve release/u,
      // change the exact candidate predecessor pin
      mutate: async (fixture) => {
        const updatePath = join(fixture.candidate, "deploy/scripts/update.sh");
        const source = await readFile(updatePath, "utf8");
        await writeFile(
          updatePath,
          source.replace(passwordPreviousRelease, "2026.10.07-3"),
        );
        await refreshRepairCandidate(fixture);
      },
    },
    {
      expected: /repair archive includes a non-file entry/u,
      // replace one candidate file with a relative symlink
      mutate: async (fixture) => {
        const webPath = join(fixture.candidate, "deploy/scripts/web-server.mjs");
        await unlink(webPath);
        await symlink("weather-admin-store.mjs", webPath);
        await refreshRepairCandidate(fixture);
      },
    },
    {
      expected: /repair control file mode is unsafe: scripts\/install-adjustment-scorecard\.sh/u,
      // remove the executable bit from one required script
      mutate: async (fixture) => {
        await chmod(
          join(fixture.candidate, "deploy/scripts/install-adjustment-scorecard.sh"),
          0o644,
        );
        await refreshRepairCandidate(fixture);
      },
    },
    {
      expected: /repair archive contains a forbidden path/u,
      // rewrite one archive member outside the public tree
      mutate: async (fixture) => {
        execFileSync("tar", [
          "-cf",
          fixture.archive,
          "--transform=s#^deploy/scripts/web-server.mjs#../web-server.mjs#",
          "-C",
          fixture.candidate,
          ...archivePaths,
        ]);
        fixture.archiveSha256 = await fileHash(fixture.archive);
      },
    },
  ];

  // isolate every candidate-validation rejection case
  for (const scenario of scenarios) {
    const fixture = await createPasswordRepairFixture();
    try {
      await scenario.mutate(fixture);
      const rejected = runPasswordRepairInstaller(fixture);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, scenario.expected);
      assertPasswordPredecessor(fixture);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});
