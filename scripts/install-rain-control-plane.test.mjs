import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const installer = join(repoRoot, "scripts/install-rain-control-plane.sh");
const previousCommit = "f1c02d3e4f09e1e5d5dde94114440e6cbb337607";
const previousDigest = "b9a5cd866f7ec62b0ee32339340186d28041d32c9d65df5719c0f064b27ca722";
const controlFiles = [
  "compose.yaml",
  "postgres/runtime-acl-v2.sql",
  "scripts/common.sh",
  "scripts/forecast-training-package.mjs",
  "scripts/weather-admin-store.mjs",
  "scripts/web-server.mjs",
  "scripts/update.sh",
];
const archivePaths = [
  "deploy/scripts",
  "deploy/postgres",
  "deploy/systemd",
  "deploy/sudoers",
  "deploy/compose.yaml",
];

// execute a sourced installer against a disposable tree
function runInstaller(fixture, archive = fixture.archive, archiveSha = fixture.archiveSha, failAfter = 0) {
  return spawnSync("bash", [
    "-c",
    `source "$1"
# bypass host process inspection only in the disposable test
require_quiet_weather() { :; }
install_control_plane "$2" "$3" "$4" "$5" "$6" "$7"`,
    "rain-control-test",
    installer,
    fixture.installed,
    fixture.backups,
    archive,
    archiveSha,
    fixture.candidateDigest,
    String(failAfter),
  ], { cwd: repoRoot, encoding: "utf8" });
}

// hash one file without trusting its archive metadata
async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// create one exact version-ten predecessor and seven-file candidate
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-rain-control-install-"));
  const old = join(root, "old");
  const installed = join(root, "installed");
  const candidate = join(root, "candidate");
  const backups = join(root, "backups");
  const archive = join(root, "candidate.tar");
  const oldArchive = join(root, "old.tar");
  await Promise.all([mkdir(old), mkdir(installed), mkdir(candidate)]);
  execFileSync("git", [
    "-c", "tar.umask=0022", "archive", "--format=tar", `--output=${oldArchive}`, previousCommit, ...archivePaths,
  ], { cwd: repoRoot });
  execFileSync("tar", ["-xf", oldArchive, "-C", old]);
  await cp(join(old, "deploy"), join(installed, "deploy"), { recursive: true });
  await cp(join(old, "deploy"), join(candidate, "deploy"), { recursive: true });
  await Promise.all([
    mkdir(join(installed, "deploy/state")),
    mkdir(join(installed, "deploy/releases")),
  ]);
  await writeFile(join(installed, "deploy/state/current-release"), "2026.09.13-3\n", { mode: 0o600 });
  await writeFile(join(installed, "deploy/releases/2026.09.13-3.env"), [
    "WEATHER_RELEASE=2026.09.13-3",
    `WEATHER_CONTROL_PLANE_SHA256=${previousDigest}`,
    "WEATHER_CONTROL_PLANE_VERSION=10",
    "",
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(installed, "deploy/.env"), "PRIVATE_EXISTING_BOOTSTRAP=unchanged\n", { mode: 0o600 });

  // overlay only the reviewed new production files
  for (const file of controlFiles) {
    await copyFile(join(repoRoot, "deploy", file), join(candidate, "deploy", file));
    await chmod(join(candidate, "deploy", file), file === "compose.yaml" || file.endsWith(".sql") ||
      file === "scripts/weather-admin-store.mjs" || file === "scripts/web-server.mjs" ? 0o644 : 0o755);
  }
  execFileSync("tar", ["-cf", archive, "-C", candidate, ...archivePaths]);
  const digestCommand = 'source "$1"; control_digest "$2"';
  const oldDigest = spawnSync("bash", ["-c", digestCommand, "rain-control-test", installer, old], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const candidateResult = spawnSync("bash", ["-c", digestCommand, "rain-control-test", installer, candidate], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(oldDigest.status, 0, oldDigest.stderr);
  assert.equal(oldDigest.stdout.trim(), previousDigest);
  assert.equal(candidateResult.status, 0, candidateResult.stderr);
  return {
    archive,
    archiveSha: await fileHash(archive),
    backups,
    candidate,
    candidateDigest: candidateResult.stdout.trim(),
    installed,
    root,
  };
}

// prove the exact seven-file handoff and retained prior state
test("installer atomically installs only the seven reviewed files and retains version ten", async () => {
  const fixture = await createFixture();

  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed version-eleven control plane:/u);
    assert.equal((await readFile(join(fixture.installed, "deploy/.env"), "utf8")), "PRIVATE_EXISTING_BOOTSTRAP=unchanged\n");
    assert.equal((await readFile(join(fixture.installed, "deploy/state/current-release"), "utf8")), "2026.09.13-3\n");
    const backups = await readdir(fixture.backups);
    const retained = backups.find((name) => name.startsWith("v10-"));
    assert.notEqual(retained, undefined);

    // compare every installed and retained control file
    for (const file of controlFiles) {
      assert.equal(
        await fileHash(join(fixture.installed, "deploy", file)),
        await fileHash(join(fixture.candidate, "deploy", file)),
      );
      assert.notEqual(await fileHash(join(fixture.backups, retained, "deploy", file)), undefined);
    }
    const digest = spawnSync("bash", [
      "-c", 'source "$1"; control_digest "$2"', "rain-control-test", installer, fixture.installed,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(digest.stdout.trim(), fixture.candidateDigest);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// reject substitutions before modifying the installed files
test("installer rejects tampered archive, current drift, and forbidden archive paths", async () => {
  const fixture = await createFixture();

  try {
    const tampered = join(fixture.root, "tampered.tar");
    await cp(fixture.archive, tampered);
    await writeFile(tampered, "changed-archive");
    const badHash = runInstaller(fixture, tampered);
    assert.notEqual(badHash.status, 0);
    assert.match(badHash.stderr, /archive hash differs/u);

    const forbidden = join(fixture.root, "forbidden.tar");
    const privateDirectory = join(fixture.candidate, "deploy/releases");
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, "candidate.env"), "forbidden\n");
    execFileSync("tar", ["-cf", forbidden, "-C", fixture.candidate, ...archivePaths, "deploy/releases/candidate.env"]);
    const forbiddenResult = runInstaller(fixture, forbidden, await fileHash(forbidden));
    assert.notEqual(forbiddenResult.status, 0);
    assert.match(forbiddenResult.stderr, /private or unrelated path/u);

    await writeFile(join(fixture.installed, "deploy/scripts/common.sh"), "# drift\n", { flag: "a" });
    const drift = runInstaller(fixture);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /installed control plane differs/u);
    assert.equal((await readdir(fixture.backups)).some((name) => name.startsWith("v10-")), false);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// fail midway and verify exact version-ten restoration
test("installer restores all seven old files after an interrupted replacement", async () => {
  const fixture = await createFixture();

  try {
    const result = runInstaller(fixture, fixture.archive, fixture.archiveSha, 2);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /internal mid-install failure probe/u);
    assert.match(result.stderr, /Restoring retained version-ten control plane/u);
    const digest = spawnSync("bash", [
      "-c", 'source "$1"; control_digest "$2"', "rain-control-test", installer, fixture.installed,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(digest.stdout.trim(), previousDigest);
    assert.equal((await readFile(join(fixture.installed, "deploy/state/current-release"), "utf8")), "2026.09.13-3\n");
    assert.equal((await readFile(join(fixture.installed, "deploy/.env"), "utf8")), "PRIVATE_EXISTING_BOOTSTRAP=unchanged\n");
    assert.equal((await readdir(fixture.backups)).some((name) => name.startsWith("v10-")), true);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// reject linked targets before copying any host control file
test("installer rejects linked deployment paths", async () => {
  const fixture = await createFixture();

  try {
    const linkedRoot = join(fixture.root, "installed-link");
    await symlink(fixture.installed, linkedRoot);
    assert.match(runInstaller({ ...fixture, installed: linkedRoot }).stderr, /canonical directory/u);

    await rename(join(fixture.installed, "deploy"), join(fixture.installed, "deploy-real"));
    await symlink(join(fixture.installed, "deploy-real"), join(fixture.installed, "deploy"));
    assert.match(runInstaller(fixture).stderr, /deployment is missing or linked/u);
    await rm(join(fixture.installed, "deploy"));
    await rename(join(fixture.installed, "deploy-real"), join(fixture.installed, "deploy"));

    const compose = join(fixture.installed, "deploy/compose.yaml");
    await rename(compose, join(fixture.installed, "compose-real.yaml"));
    await symlink(join(fixture.installed, "compose-real.yaml"), compose);
    assert.match(runInstaller(fixture).stderr, /Compose contract is missing or linked/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// require safe archive modes even when archive bytes are rehashed
test("installer rejects an unsafe candidate file mode", async () => {
  const fixture = await createFixture();

  try {
    await chmod(join(fixture.candidate, "deploy/scripts/update.sh"), 0o777);
    const unsafe = join(fixture.root, "unsafe-mode.tar");
    execFileSync("tar", ["-cf", unsafe, "-C", fixture.candidate, ...archivePaths]);
    const result = runInstaller(fixture, unsafe, await fileHash(unsafe));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mode is unsafe/u);
    assert.equal((await readdir(fixture.backups)).some((name) => name.startsWith("v10-")), true);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// serialize installers without claiming to lock old lifecycle commands
test("installer rejects an overlapping installer lock", async () => {
  const fixture = await createFixture();
  await mkdir(fixture.backups, { mode: 0o700 });
  const holder = spawn("bash", [
    "-c",
    'exec 9>"$1"; flock -n 9; printf "locked\\n"; sleep 5',
    "rain-control-test",
    join(fixture.backups, ".rain-control-install.lock"),
  ], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    await new Promise((resolveReady, rejectReady) => {
      holder.stdout.once("data", resolveReady);
      holder.once("error", rejectReady);
      holder.once("exit", () => rejectReady(new Error("lock holder exited early")));
    });
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another control-plane installer is in flight/u);
  } finally {
    holder.kill();
    await rm(fixture.root, { force: true, recursive: true });
  }
});
