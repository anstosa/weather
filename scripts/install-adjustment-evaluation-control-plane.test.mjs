import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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

// construct the exact reviewed live v11 tree and current v12 candidate
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-control-"));
  const old = join(root, "old");
  const installed = join(root, "installed");
  const candidate = join(root, "candidate");
  const backups = join(root, "backups");
  const archive = join(root, "candidate.tar");
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

  // copy only the public candidate deployment surface
  for (const path of archivePaths) {
    const source = join(repoRoot, path);
    const target = join(candidate, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(source, target, { recursive: true });
  }
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
