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
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_SOURCE_FILES,
} from "./research/adjustment_maintenance_runtime_adapter.mjs";
import {
  ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST,
} from "./research/adjustment_fit_inputs.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const installer = join(repoRoot, "scripts/install-adjustment-maintenance-runner.sh");
const SOURCE_COMMIT = "1".repeat(40);
const runtimeAdapterSourceFiles = ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_SOURCE_FILES.map(
  // mirror the adapter's closed committed runtime closure
  ({ source }) => source,
);
const fitSourceFiles = [...new Set(
  Object.values(ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST).flat().map(
    // retain one copy of every family fitter source
    ({ source }) => source,
  ),
)];
const sourceFiles = [
  "deploy/config/ssh_config",
  "deploy/scripts/adjustment-evaluation-package.mjs",
  "deploy/scripts/adjustment-evidence-store.mjs",
  "deploy/scripts/forecast-adjustment-scorecard-contract.mjs",
  "scripts/await-check.mjs",
  "scripts/research/adjustment_archive_job.mjs",
  "scripts/research/adjustment_capture_readiness.mjs",
  "scripts/research/adjustment_confirmation_values.mjs",
  "scripts/research/adjustment_rain_confirmation_values.mjs",
  "scripts/research/adjustment_cycle_pages.mjs",
  "scripts/research/adjustment_fit_inputs.mjs",
  "scripts/research/adjustment_fit_sandbox.mjs",
  "scripts/research/adjustment_historical_archive.mjs",
  "scripts/research/adjustment_historical_fit_assembler.mjs",
  "scripts/research/adjustment_monthly_projection.mjs",
  "scripts/research/adjustment_daily_evaluation.mjs",
  "scripts/research/adjustment_maintenance_capture_job.mjs",
  "scripts/research/adjustment_maintenance_runtime_adapter.mjs",
  "scripts/research/adjustment_maintenance_runtime_manifest.mjs",
  "scripts/research/adjustment_maintenance_controller.mjs",
  "scripts/research/adjustment_maintenance_state.mjs",
  "scripts/research/adjustment_model_release.mjs",
  "scripts/research/adjustment_plaintext_archive.mjs",
  "scripts/research/adjustment_private_directory.mjs",
  "scripts/research/adjustment_rain_control_reference.mjs",
  "scripts/research/adjustment_rain_monthly_projection.mjs",
  "scripts/research/adjustment_rain_model_package.mjs",
  "scripts/research/adjustment_revision_custody_pack.mjs",
  "scripts/research/adjustment_revision_cold_drain.mjs",
  "scripts/research/adjustment_rolling_schedule.mjs",
  ...fitSourceFiles.filter(
    // omit fit snapshots already required by the portable adapter
    (source) => !runtimeAdapterSourceFiles.includes(source),
  ),
  ...runtimeAdapterSourceFiles.filter(
    // omit members already present in the runner's direct source closure
    (source) => ![
      "deploy/scripts/adjustment-evidence-store.mjs",
      "scripts/research/adjustment_maintenance_runtime_adapter.mjs",
      "scripts/research/adjustment_maintenance_runtime_manifest.mjs",
      "scripts/research/adjustment_plaintext_archive.mjs",
      "scripts/research/adjustment_rain_model_package.mjs",
    ].includes(source),
  ),
  "scripts/systemd/system/weather-adjustment-archive.service",
  "scripts/systemd/system/weather-adjustment-daily.service",
  "scripts/systemd/system/weather-adjustment-daily.timer",
  "scripts/systemd/system/weather-adjustment-monthly.service",
  "scripts/systemd/system/weather-adjustment-monthly.timer",
];
const unitFiles = sourceFiles.filter((path) => path.startsWith("scripts/systemd/system/"));

// invoke one sourced installer with disposable fixed roots
function runInstaller(fixture, options = {}) {
  const command = `source "$1"
require_source_commit() { :; }
require_private_install_ancestors() { :; }
adjustment_require_public_unit_root() {
  # preserve literal public-root rejection in fixtures
  if [[ ! -d "$1" || -L "$1" || "$(readlink -f -- "$1")" != "$1" ]]; then
    printf 'public unit directory is invalid: %s\\n' "$1" >&2
    return 1
  fi
}
adjustment_require_public_unit_file() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%u:%a' -- "$1")" == "$(id -u):644" ]]
}
adjustment_public_install() { install -m 0644 -- "$1" "$2"; }
adjustment_public_move() { mv -Tf -- "$1" "$2"; }
adjustment_public_remove() { rm -f -- "$1"; }
require_loaded_public_unit() { :; }
require_runtime_readiness() { ${options.readinessFailure === true ? "return 1" : ":"}; }
runner_after_copy() { ${options.copyDrift === true
    ? "chmod 0600 \"$2/$1\"; printf 'drift\\n' >>\"$2/$1\""
    : ":"}; }
runner_before_unit_install() { ${options.installFailure === true ? "return 1" : ":"}; }
reload_systemd() { ${options.reloadFailure === true
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

test("runner installer publishes one immutable manifest release and disabled system unit", async () => {
  const fixture = await createFixture();

  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    const release = join(fixture.installRoot, "releases", fixture.sourceCommit);
    assert.equal(await readlink(join(fixture.installRoot, "current")), `releases/${fixture.sourceCommit}`);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_archive_job\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /deploy\/config\/ssh_config/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment-evaluation-package\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_capture_readiness\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_maintenance_runtime_adapter\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_maintenance_capture_job\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_revision_custody_pack\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_revision_cold_drain\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_rolling_schedule\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_rain_control_reference\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_rain_confirmation_values\.mjs/u);
    assert.match(await readFile(join(release, "MANIFEST.sha256"), "utf8"),
      /adjustment_rain_monthly_projection\.mjs/u);
    assert.equal((await lstat(join(release, "scripts/research/adjustment_archive_job.mjs"))).mode & 0o777, 0o400);
    assert.equal((await lstat(join(release,
      "scripts/research/adjustment_maintenance_capture_job.mjs"))).mode & 0o777, 0o400);
    assert.equal((await lstat(join(fixture.unitRoot, "weather-adjustment-archive.service"))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(fixture.unitRoot, "weather-backup-local.service"), "utf8"), "sentinel\n");
    assert.equal(await readFile(join(fixture.unitRoot, "reload.log"), "utf8"), "daemon-reload\n");
    // require the complete disabled unit set without unrelated mutation
    for (const relative of unitFiles) {
      assert.equal(
        (await lstat(join(fixture.unitRoot, relative.split("/").at(-1)))).mode & 0o777,
        0o644,
      );
    }
    assert.doesNotMatch(result.stdout + result.stderr, /enable|start/u);
  } finally {
    await cleanupFixture(fixture);
  }
});

// prove the installed adapter resolves only its committed closure
test("runner installs the exact portable adapter closure without ambient build output", async () => {
  const fixture = await createFixture();

  try {
    assert.equal(new Set(runtimeAdapterSourceFiles).size, 40);
    assert.equal(
      sourceFiles.some((path) => /^(?:apps|packages)\/.*\/dist\//u.test(path)),
      false,
    );
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr);
    const release = join(fixture.installRoot, "releases", fixture.sourceCommit);
    const installedAdapter = join(
      release,
      "scripts/research/adjustment_maintenance_runtime_adapter.mjs",
    );
    const invocation = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "const adapter = await import(process.argv[1]); " +
        "process.stdout.write(adapter.forecastAdjustmentRainMaintenanceSourceIdentitySha256());",
      pathToFileURL(installedAdapter).href,
    ], { encoding: "utf8" });
    assert.equal(invocation.status, 0, invocation.stderr);
    assert.match(invocation.stdout, /^[a-f0-9]{64}$/u);
    const installedCaptureJob = join(
      release,
      "scripts/research/adjustment_maintenance_capture_job.mjs",
    );
    // import the installed service graph without invoking its guarded entrypoint
    const captureInvocation = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "const capture = await import(process.argv[1]); " +
        "process.stdout.write(typeof capture.runAdjustmentMaintenanceCaptureJob);",
      pathToFileURL(installedCaptureJob).href,
    ], { encoding: "utf8" });
    assert.equal(captureInvocation.status, 0, captureInvocation.stderr);
    assert.equal(captureInvocation.stdout, "function");
    const manifest = await readFile(join(release, "MANIFEST.sha256"), "utf8");

    // bind every runtime member to the immutable release manifest
    for (const relative of runtimeAdapterSourceFiles) {
      assert.match(manifest, new RegExp(`  ${relative.replaceAll("/", "\\/")}$`, "mu"));
    }
    // bind every fitter source to the same immutable release manifest
    for (const relative of fitSourceFiles) {
      assert.match(manifest, new RegExp(`  ${relative.replaceAll("/", "\\/")}$`, "mu"));
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runner production roots avoid broad user configuration parents", async () => {
  const result = spawnSync("bash", [
    "-c",
    'source "$1"; printf "%s\\n%s\\n" "$ADJUSTMENT_RUNNER_INSTALL_ROOT" "$ADJUSTMENT_RUNNER_UNIT_ROOT"',
    "adjustment-maintenance-roots-test",
    installer,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `${process.env.HOME}/.weather/adjustment-maintenance/runner\n/etc/systemd/system\n`,
  );
  const unit = await readFile(
    join(repoRoot, "scripts/systemd/system/weather-adjustment-archive.service"),
    "utf8",
  );
  assert.match(unit, /^User=ubuntu$/mu);
  assert.match(unit, /^Group=ubuntu$/mu);
  assert.match(unit, /^Environment=XDG_RUNTIME_DIR=\/run\/user\/1000$/mu);
  assert.match(unit, /^Environment=SSH_AUTH_SOCK=\/run\/user\/1000\/openssh_agent$/mu);
  assert.match(unit, /^WorkingDirectory=\/home\/ubuntu\/\.weather\/adjustment-maintenance\/runner\/current$/mu);
  assert.doesNotMatch(unit, /%h|systemd\/user/u);
  assert.match(unit,
    /^ExecStart=\/home\/ubuntu\/n\/bin\/node \/home\/ubuntu\/\.weather\/adjustment-maintenance\/runner\/current\/scripts\/research\/adjustment_maintenance_capture_job\.mjs$/mu);
  assert.doesNotMatch(unit,
    /^ExecStart=.*\/scripts\/research\/adjustment_archive_job\.mjs$/mu);

  // require scheduled controllers to use the same verified user-agent socket
  for (const name of ["weather-adjustment-daily.service", "weather-adjustment-monthly.service"]) {
    const scheduledUnit = await readFile(join(repoRoot, "scripts/systemd/system", name), "utf8");
    assert.match(scheduledUnit, /^Environment=SSH_AUTH_SOCK=\/run\/user\/1000\/openssh_agent$/mu);
    assert.match(scheduledUnit,
      /^ReadWritePaths=\/home\/ubuntu\/\.weather\/adjustment-maintenance \/home\/ubuntu\/weather$/mu);
  }
});

test("runner creates only its missing private maintenance parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-private-parent-"));
  const home = join(root, "home");
  const weather = join(home, ".weather");
  const target = join(weather, "adjustment-maintenance");

  // isolate the private parent creation boundary
  try {
    await mkdir(weather, { mode: 0o700, recursive: true });
    const result = spawnSync("bash", [
      "-c",
      'source "$1"; require_private_install_ancestors "$2"',
      "adjustment-maintenance-private-parent-test",
      installer,
      target,
    ], { encoding: "utf8", env: { ...process.env, HOME: home } });

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(target)).mode & 0o777, 0o700);
    await assert.rejects(lstat(join(home, ".local")), { code: "ENOENT" });
    await assert.rejects(lstat(join(home, ".config")), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("runner accepts only a root-owned public system-unit directory", async () => {
  const fixture = await createFixture();

  try {
    const publicRoot = spawnSync("bash", [
      "-c",
      'source "$1"; adjustment_require_public_unit_root /etc/systemd/system',
      "adjustment-maintenance-public-root-test",
      installer,
    ], { encoding: "utf8" });
    assert.equal(publicRoot.status, 0, publicRoot.stderr);

    const privateRoot = spawnSync("bash", [
      "-c",
      'source "$1"; adjustment_require_public_unit_root "$2"',
      "adjustment-maintenance-private-root-test",
      installer,
      fixture.unitRoot,
    ], { encoding: "utf8" });
    assert.notEqual(privateRoot.status, 0);
    assert.match(privateRoot.stderr, /public unit directory/u);
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
    await assert.rejects(
      lstat(join(fixture.installRoot, "releases", fixture.sourceCommit)),
      { code: "ENOENT" },
    );
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
    assert.match(linkedRoot.stderr, /public unit directory/u);
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
    const priorUnits = new Map();
    // retain every prior public unit identity for rollback comparison
    for (const relative of unitFiles) {
      const unitFile = join(fixture.unitRoot, relative.split("/").at(-1));
      priorUnits.set(unitFile, await readFile(unitFile));
    }
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
    // retain every public unit after an installation failure
    for (const [unitFile, priorUnit] of priorUnits) {
      assert.deepEqual(await readFile(unitFile), priorUnit);
    }
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
    // retain every public unit after a manager reload failure
    for (const [unitFile, priorUnit] of priorUnits) {
      assert.deepEqual(await readFile(unitFile), priorUnit);
    }
    await assert.rejects(
      lstat(join(fixture.installRoot, "releases", nextSourceCommit)),
      { code: "ENOENT" },
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
