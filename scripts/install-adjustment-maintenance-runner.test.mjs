import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const installer = join(repoRoot, "scripts/install-adjustment-maintenance-runner.sh");
const SOURCE_COMMIT = "1".repeat(40);
const sourceFiles = [
  "deploy/scripts/adjustment-evidence-store.mjs",
  "scripts/research/adjustment_archive_job.mjs",
  "scripts/research/adjustment_cycle_pages.mjs",
  "scripts/research/adjustment_maintenance_state.mjs",
  "scripts/research/adjustment_plaintext_archive.mjs",
  "scripts/research/adjustment_private_directory.mjs",
  "scripts/systemd/user/weather-adjustment-archive.service",
];

// invoke one sourced installer with disposable fixed roots
function runInstaller(fixture, options = {}) {
  const command = `source "$1"
require_source_commit() { :; }
require_install_ancestors() { :; }
require_runtime_readiness() { ${options.readinessFailure === true ? "return 1" : ":"}; }
runner_after_copy() { ${options.copyDrift === true
    ? "chmod 0600 \"$2/$1\"; printf 'drift\\n' >>\"$2/$1\""
    : ":"}; }
runner_before_unit_install() { ${options.installFailure === true ? "return 1" : ":"}; }
reload_user_systemd() { ${options.reloadFailure === true
    ? "return 1"
    : "printf 'daemon-reload\\n' >>\"$6/reload.log\""}; }
install_adjustment_maintenance_runner "$2" "$3" "$4" "$5" "$6"`;
  return spawnSync("bash", [
    "-c",
    command,
    "adjustment-maintenance-installer-test",
    installer,
    fixture.source,
    fixture.sourceCommit,
    fixture.manifestSha256,
    fixture.installRoot,
    fixture.unitRoot,
  ], { encoding: "utf8" });
}

// calculate the installer's exact source manifest digest
function sourceManifestSha256(source) {
  const result = spawnSync("bash", [
    "-c",
    'source "$1"; adjustment_runner_manifest_digest "$2"',
    "adjustment-maintenance-manifest-test",
    installer,
    source,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// build one owner-private source checkout and unrelated unit sentinel
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-maintenance-runner-"));
  const source = join(root, "source");
  const installRoot = join(root, "install");
  const unitRoot = join(root, "units");
  await Promise.all([mkdir(source), mkdir(installRoot), mkdir(unitRoot)]);
  await Promise.all([chmod(installRoot, 0o700), chmod(unitRoot, 0o700)]);

  // copy only the approved finite source manifest
  for (const relative of sourceFiles) {
    const target = join(source, relative);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await cp(join(repoRoot, relative), target);
    await chmod(target, 0o600);
  }
  await writeFile(join(unitRoot, "weather-backup-local.service"), "sentinel\n", { mode: 0o600 });
  return {
    installRoot,
    manifestSha256: sourceManifestSha256(source),
    root,
    source,
    sourceCommit: SOURCE_COMMIT,
    unitRoot,
  };
}

// restore write permission only for disposable immutable-release teardown
async function cleanupFixture(fixture) {
  const result = spawnSync("chmod", ["-R", "u+w", fixture.root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await rm(fixture.root, { force: true, recursive: true });
}

test("runner installer publishes one immutable manifest release and disabled user unit", async () => {
  const fixture = await createFixture();

  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    const release = join(fixture.installRoot, "releases", fixture.sourceCommit);
    assert.equal(await readlink(join(fixture.installRoot, "current")), `releases/${fixture.sourceCommit}`);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_archive_job\.mjs/u);
    assert.equal((await lstat(join(release, "scripts/research/adjustment_archive_job.mjs"))).mode & 0o777, 0o400);
    assert.equal((await lstat(join(fixture.unitRoot, "weather-adjustment-archive.service"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(fixture.unitRoot, "weather-backup-local.service"), "utf8"), "sentinel\n");
    assert.equal(await readFile(join(fixture.unitRoot, "reload.log"), "utf8"), "daemon-reload\n");
    assert.doesNotMatch(result.stdout + result.stderr, /enable|start/u);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runner installer refuses unproven readiness and source drift before installation", async () => {
  const fixture = await createFixture();

  try {
    const readiness = runInstaller(fixture, { readinessFailure: true });
    assert.notEqual(readiness.status, 0);
    await assert.rejects(lstat(join(fixture.installRoot, "current")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.unitRoot, "weather-adjustment-archive.service")), { code: "ENOENT" });

    await writeFile(join(fixture.source, sourceFiles[0]), "drift\n", { flag: "a" });
    const drift = runInstaller(fixture);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /manifest/u);
    await assert.rejects(lstat(join(fixture.installRoot, "current")), { code: "ENOENT" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runner installer rejects a linked reviewed source member", async () => {
  const fixture = await createFixture();

  try {
    const target = join(fixture.source, sourceFiles[0]);
    await rm(target);
    await symlink(join(repoRoot, sourceFiles[0]), target);
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular owner file/u);
    await assert.rejects(lstat(join(fixture.installRoot, "current")), { code: "ENOENT" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runner installer rejects copied drift and unsafe install roots", async () => {
  const fixture = await createFixture();

  try {
    const copiedDrift = runInstaller(fixture, { copyDrift: true });
    assert.notEqual(copiedDrift.status, 0);
    assert.match(copiedDrift.stderr, /copied release manifest/u);
    await assert.rejects(lstat(join(fixture.installRoot, "current")), { code: "ENOENT" });

    await chmod(fixture.installRoot, 0o777);
    const broadRoot = runInstaller(fixture);
    assert.notEqual(broadRoot.status, 0);
    assert.match(broadRoot.stderr, /private directory mode/u);
    await chmod(fixture.installRoot, 0o700);

    const literalUnitRoot = `${fixture.unitRoot}-literal`;
    await mkdir(literalUnitRoot, { mode: 0o700 });
    await rm(fixture.unitRoot, { force: true, recursive: true });
    await symlink(literalUnitRoot, fixture.unitRoot);
    const linkedRoot = runInstaller(fixture);
    assert.notEqual(linkedRoot.status, 0);
    assert.match(linkedRoot.stderr, /controlled directory/u);
  } finally {
    await cleanupFixture(fixture);
    await rm(`${fixture.unitRoot}-literal`, { force: true, recursive: true });
  }
});

test("runner installer rolls back current and unit on install or reload failure", async () => {
  const fixture = await createFixture();

  try {
    const first = runInstaller(fixture);
    assert.equal(first.status, 0, first.stderr);
    const priorCurrent = await readlink(join(fixture.installRoot, "current"));
    const unitFile = join(fixture.unitRoot, "weather-adjustment-archive.service");
    const priorUnit = await readFile(unitFile);
    await writeFile(join(fixture.source, sourceFiles[0]), "second release\n", { flag: "a" });
    const nextManifestSha256 = sourceManifestSha256(fixture.source);
    const nextSourceCommit = "2".repeat(40);

    const installFailure = runInstaller({
      ...fixture,
      manifestSha256: nextManifestSha256,
      sourceCommit: nextSourceCommit,
    }, { installFailure: true });
    assert.notEqual(installFailure.status, 0);
    assert.equal(await readlink(join(fixture.installRoot, "current")), priorCurrent);
    assert.deepEqual(await readFile(unitFile), priorUnit);
    await assert.rejects(
      lstat(join(fixture.installRoot, "releases", nextSourceCommit)),
      { code: "ENOENT" },
    );

    const reloadFailure = runInstaller({
      ...fixture,
      manifestSha256: nextManifestSha256,
      sourceCommit: nextSourceCommit,
    }, { reloadFailure: true });
    assert.notEqual(reloadFailure.status, 0);
    assert.equal(await readlink(join(fixture.installRoot, "current")), priorCurrent);
    assert.deepEqual(await readFile(unitFile), priorUnit);
    await assert.rejects(
      lstat(join(fixture.installRoot, "releases", nextSourceCommit)),
      { code: "ENOENT" },
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
