import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const updateScript = join(repoRoot, "deploy/scripts/update.sh");
const coreRelease = "2026.10.09-1";
const targetRelease = "2026.10.10-1";
const sourceWeb = `ghcr.io/anstosa/weather-web@sha256:${"a".repeat(64)}`;
const targetWeb = `ghcr.io/anstosa/weather-web@sha256:${"b".repeat(64)}`;

// run one sourced deployment function in an isolated shell
function runBash(source, argumentsList = []) {
  return spawnSync("bash", ["-c", source, "dashboard-release-test", updateScript,
    ...argumentsList], { cwd: repoRoot, encoding: "utf8" });
}

// write one exact version-thirteen core environment
async function writeCoreEnvironment(path) {
  await writeFile(path, [
    `WEATHER_RELEASE=${coreRelease}`,
    `WEATHER_SERVER_IMAGE=ghcr.io/anstosa/weather-server@sha256:${"c".repeat(64)}`,
    `WEATHER_WEB_IMAGE=${sourceWeb}`,
    `POSTGRES_IMAGE=docker.io/library/postgres@sha256:${"d".repeat(64)}`,
    `CLOUDFLARED_IMAGE=docker.io/cloudflare/cloudflared@sha256:${"e".repeat(64)}`,
    "WEATHER_DATABASE_NAME=weather",
    "WEATHER_POSTGRES_DIR=/var/lib/weather/postgres",
    "WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH=0",
    "WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH=1",
    "WEATHER_CONTROL_PLANE_SHA256=603eb8f488ba78be3d7ecf76b0d587346d1c36432255d390d86d2b768c8fecba",
    "WEATHER_CONTROL_PLANE_VERSION=13",
    "",
  ].join("\n"), { mode: 0o600 });
}

// build one fixed-root release-state fixture
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-dashboard-release-"));
  const deploy = join(root, "deploy");
  const releases = join(deploy, "releases");
  const state = join(deploy, "state");
  await mkdir(releases, { recursive: true });
  await mkdir(state, { recursive: true });
  await chmod(releases, 0o700);
  await chmod(state, 0o700);
  await writeCoreEnvironment(join(releases, `${coreRelease}.env`));
  await writeFile(join(state, "current-release"), `${coreRelease}\n`, { mode: 0o600 });
  await writeFile(join(state, "schema-release"), `${coreRelease}\n`, { mode: 0o600 });
  await symlink(`../releases/${coreRelease}.env`, join(state, "active.env"));
  return { deploy, releases, root, state };
}

// remove one isolated fixture
async function removeFixture(fixture) {
  await rm(fixture.root, { force: true, recursive: true });
}

// emit stable proof and capacity receipts for shell transaction tests
const receiptMock = String.raw`
dashboard_package_receipt() {
  local output=$1 command=$2
  shift 2
  if [[ "$command" == web-release-proof ]]; then
    printf '%s\n' '{"checkRunId":1,"contractVersion":"dashboard-web-release-proof/v1","coreRelease":"2026.10.09-1","publishRunId":2,"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"publication_ready","targetCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","targetRelease":"2026.10.10-1"}' >"$output"
  else
    printf '%s\n' '{"compensationScope":"fixed-core-web-only-source-restore","contractVersion":"dashboard-web-release-capacity/v1","imageDigests":[{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","role":"source","runtime":"server"},{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","role":"source","runtime":"web"},{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","role":"target","runtime":"server"},{"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","role":"target","runtime":"web"},{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","role":"compensating","runtime":"server"},{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","role":"compensating","runtime":"web"}],"requiredFreeBytes":1,"requiredFreeInodes":1,"retirementCreditBytes":0,"sourceRelease":"2026.10.09-1","state":"capacity_ready"}' >"$output"
  fi
  chmod 600 "$output"
}`;

// exercise the complete happy web-only transaction with mocked Docker boundaries
const happyMocks = String.raw`
require_control_plane_compatibility() { :; }
resolve_arm64_image() { printf '%s\n' 'ghcr.io/anstosa/weather-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; }
cleanup_obsolete_weather_images() { printf 'cleanup:%s:%s\n' "$1" "$2" >>"$transcript"; }
dashboard_core_snapshot_sha256() { printf '%s\n' "9999999999999999999999999999999999999999999999999999999999999999"; }
compose() {
  printf 'compose:%s:%s\n' "$WEATHER_ENV_FILE" "$*" >>"$transcript"
  if [[ "\${1:-} \${2:-} \${3:-} \${4:-} \${5:-}" == 'up -d --no-deps --wait' ]]; then
    RUNNING_IMAGE=$(env_value "$WEATHER_ENV_FILE" WEATHER_WEB_IMAGE)
  elif [[ "\${1:-} \${2:-} \${3:-}" == 'ps --quiet web' ]]; then
    printf '%s\n' aaaaaaaaaaaa
  fi
}
docker() {
  if [[ "\${1:-} \${2:-} \${3:-}" == 'container inspect --format' ]]; then
    printf '%s\n' "$RUNNING_IMAGE"
  elif [[ "\${1:-} \${2:-} \${3:-}" == 'image inspect --format' ]]; then
    printf '%s\n' arm64
  else
    return 0
  fi
}`;

test("dashboard release changes only web state and commits current last", async () => {
  const fixture = await createFixture();
  const transcript = join(fixture.root, "transcript");
  try {
    const coreBefore = await readFile(join(fixture.releases, `${coreRelease}.env`));
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
${receiptMock}
${happyMocks}
verify_dashboard_web_runtime() { printf 'verify:%s:%s:%s\n' "$1" "$2" "$3" >>"$transcript"; }
dashboard_release "$4" "$5" "$5"`,
    [fixture.deploy, transcript, targetRelease, coreRelease]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(fixture.state, "current-release"), "utf8"), `${coreRelease}\n`);
    assert.equal(await readFile(join(fixture.state, "schema-release"), "utf8"), `${coreRelease}\n`);
    assert.deepEqual(await readFile(join(fixture.releases, `${coreRelease}.env`)), coreBefore);
    assert.equal(await readFile(join(fixture.state, "current-web-release"), "utf8"), `${targetRelease}\n`);
    assert.equal(await readFile(join(fixture.state, "previous-web-release"), "utf8"), `${coreRelease}\n`);
    assert.equal(await readlink(join(fixture.state, "active-web.env")),
      `../releases/${targetRelease}.web.env`);
    assert.equal((await stat(join(fixture.releases, `${targetRelease}.web.env`))).mode & 0o777,
      0o600);
    await assert.rejects(readFile(join(fixture.state, "dashboard-web-transaction.env")));
    const operations = await readFile(transcript, "utf8");
    assert.match(operations, /compose:.*\.web\.env:pull web/u);
    assert.match(operations, /compose:.*\.web\.env:up -d --no-deps --wait web/u);
    assert.doesNotMatch(operations, /migration|postgres|api|worker|cloudflared/u);
  } finally {
    await removeFixture(fixture);
  }
});

test("dashboard release failure restores the exact source web and markers", async () => {
  const fixture = await createFixture();
  const transcript = join(fixture.root, "transcript");
  try {
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
failing_release=$4
${receiptMock}
${happyMocks}
verify_dashboard_web_runtime() {
  printf 'verify:%s\n' "$2" >>"$transcript"
  [[ "$2" != "$failing_release" ]]
}
dashboard_release "$4" "$5" "$5"`,
    [fixture.deploy, transcript, targetRelease, coreRelease]);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(join(fixture.state, "current-web-release")));
    await assert.rejects(readFile(join(fixture.state, "previous-web-release")));
    await assert.rejects(readlink(join(fixture.state, "active-web.env")));
    await assert.rejects(readFile(join(fixture.state, "dashboard-web-transaction.env")));
    const operations = await readFile(transcript, "utf8");
    assert.match(operations, new RegExp(`verify:${targetRelease}`, "u"));
    assert.match(operations, new RegExp(`verify:${coreRelease}`, "u"));
  } finally {
    await removeFixture(fixture);
  }
});

test("dashboard journal recovers partial markers and retains a complete commit", async () => {
  const fixture = await createFixture();
  const targetEnv = join(fixture.releases, `${targetRelease}.web.env`);
  try {
    const setup = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
require_control_plane_compatibility() { :; }
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$3" "$4" "$5"
write_dashboard_release_journal release "$6" "$6" "$4" none none \
  "$releases_dir/${coreRelease}.env" "$3" "$7" "$5" "${"f".repeat(64)}" "${"9".repeat(64)}"
write_private_state "$state_dir/previous-web-release" "$6"
write_dashboard_active_symlink "$4"
reconcile_dashboard_release_journal`, [fixture.deploy, targetEnv, targetRelease, targetWeb,
      coreRelease, sourceWeb]);
    assert.equal(setup.status, 0, setup.stderr);
    await assert.rejects(readFile(join(fixture.state, "current-web-release")));
    await assert.rejects(readFile(join(fixture.state, "previous-web-release")));
    await assert.rejects(readlink(join(fixture.state, "active-web.env")));

    const committed = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
require_control_plane_compatibility() { :; }
write_dashboard_release_journal release "$3" "$3" "$4" none none \
  "$releases_dir/${coreRelease}.env" "$5" "$6" "$7" "${"f".repeat(64)}" "${"9".repeat(64)}"
record_dashboard_release_success "$4" "$3" "$3"
reconcile_dashboard_release_journal`, [fixture.deploy, coreRelease, targetRelease, targetEnv,
      sourceWeb, targetWeb]);
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(await readFile(join(fixture.state, "current-web-release"), "utf8"),
      `${targetRelease}\n`);
    assert.equal(await readFile(join(fixture.state, "previous-web-release"), "utf8"),
      `${coreRelease}\n`);
  } finally {
    await removeFixture(fixture);
  }
});

test("dashboard rollback to core removes only override state", async () => {
  const fixture = await createFixture();
  const targetEnv = join(fixture.releases, `${targetRelease}.web.env`);
  const transcript = join(fixture.root, "transcript");
  try {
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
require_control_plane_compatibility() { :; }
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$4" "$5" "$6"
record_dashboard_release_success "$5" "$7" "$7"
${happyMocks}
dashboard_package_receipt() {
  printf '%s\n' '{"checkRunId":1,"contractVersion":"dashboard-web-release-proof/v1","coreRelease":"2026.10.09-1","publishRunId":2,"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"publication_ready","targetCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targetRelease":"2026.10.09-1"}' >"$1"
  chmod 600 "$1"
}
verify_dashboard_web_runtime() { printf 'verify:%s\n' "$2" >>"$transcript"; }
dashboard_rollback`, [fixture.deploy, transcript, targetEnv, targetRelease, targetWeb, coreRelease]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(fixture.state, "current-release"), "utf8"), `${coreRelease}\n`);
    assert.equal(await readFile(join(fixture.state, "schema-release"), "utf8"), `${coreRelease}\n`);
    await assert.rejects(readFile(join(fixture.state, "current-web-release")));
    await assert.rejects(readFile(join(fixture.state, "previous-web-release")));
    await assert.rejects(readlink(join(fixture.state, "active-web.env")));
    assert.match(await readFile(transcript, "utf8"), new RegExp(`verify:${coreRelease}`, "u"));
  } finally {
    await removeFixture(fixture);
  }
});

test("unified release paths reject an active dashboard override", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.state, "current-web-release"), `${targetRelease}\n`, { mode: 0o600 });
    const rejected = runBash(`source "$1"
state_dir=$2
require_no_dashboard_override`, [fixture.state]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /dashboard web override is active/u);
  } finally {
    await removeFixture(fixture);
  }
});

test("dashboard metadata rejects unsafe modes and source CAS drift", async () => {
  const fixture = await createFixture();
  const targetEnv = join(fixture.releases, `${targetRelease}.web.env`);
  try {
    const created = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$3" "$4" "$5"`,
    [fixture.deploy, targetEnv, targetRelease, targetWeb]);
    assert.equal(created.status, 0, created.stderr);
    await chmod(targetEnv, 0o644);
    const unsafe = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
validate_dashboard_release_env "$3" "$4" "$5"`,
    [fixture.deploy, targetEnv, targetRelease, coreRelease]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /owner-private/u);
    const drift = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_source_environment "$3" "$4"`,
    [fixture.deploy, coreRelease, targetRelease]);
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /source CAS mismatch/u);
  } finally {
    await removeFixture(fixture);
  }
});

test("SSH boundaries allow only closed dashboard command shapes", async () => {
  const dispatch = join(repoRoot, "deploy/scripts/ssh-dispatch.sh");
  const directory = await mkdtemp(join(tmpdir(), "weather-dashboard-dispatch-"));
  const sudo = join(directory, "sudo");
  try {
    await writeFile(sudo, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\"\n", { mode: 0o700 });
    const environment = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
    const accepted = spawnSync("bash", [dispatch], { encoding: "utf8", env: {
      ...environment,
      SSH_ORIGINAL_COMMAND: `dashboard-release ${targetRelease} ${coreRelease} ${coreRelease}`,
    } });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /weather-remote-ops dashboard-release/u);
    const rejected = spawnSync("bash", [dispatch], { encoding: "utf8", env: {
      ...environment,
      SSH_ORIGINAL_COMMAND: `dashboard-release ${targetRelease} ${coreRelease} latest`,
    } });
    assert.equal(rejected.status, 126);
    assert.match(rejected.stderr, /operation denied/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("dashboard release exact retry keeps the committed source boundary without pulling", async () => {
  const fixture = await createFixture();
  const targetEnv = join(fixture.releases, `${targetRelease}.web.env`);
  const transcript = join(fixture.root, "transcript-retry");
  try {
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
require_control_plane_compatibility() { :; }
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$4" "$5" "$6"
record_dashboard_release_success "$5" "$7" "$7"
${receiptMock}
dashboard_core_snapshot_sha256() { printf '%s\\n' "${"9".repeat(64)}"; }
verify_dashboard_web_runtime() { printf 'verify:%s\\n' "$2" >>"$transcript"; }
compose() { printf 'unexpected-compose:%s\\n' "$*" >>"$transcript"; }
dashboard_release "$5" "$7" "$7"`,
    [fixture.deploy, transcript, targetEnv, targetRelease, targetWeb, coreRelease]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(fixture.state, "current-web-release"), "utf8"),
      `${targetRelease}\n`);
    assert.equal(await readFile(join(fixture.state, "previous-web-release"), "utf8"),
      `${coreRelease}\n`);
    const operations = await readFile(transcript, "utf8");
    assert.equal(operations, `verify:${targetRelease}\n`);
  } finally {
    await removeFixture(fixture);
  }
});

// exercise the recover dispatcher after a journal reconciles to no override
async function runCoreRecoveryFixture({ action, expectedStable, originalCurrent, originalPrevious,
  source, target }) {
  const fixture = await createFixture();
  const transcript = join(fixture.root, "transcript-recovery");
  const sourceEnv = source === coreRelease ? join(fixture.releases, `${coreRelease}.env`) :
    join(fixture.releases, `${source}.web.env`);
  const targetEnv = target === coreRelease ? join(fixture.releases, `${coreRelease}.env`) :
    join(fixture.releases, `${target}.web.env`);
  try {
    const setupParts = [];
    if (source !== coreRelease) {
      setupParts.push(`write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$8" "$9" "${targetWeb}"`);
    }
    if (target !== coreRelease && target !== source) {
      setupParts.push(`write_dashboard_release_env "$releases_dir/${coreRelease}.env" "${targetEnv}" "${target}" "${targetWeb}"`);
    }
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
core_release=$5
expected_stable=\${10}
require_control_plane_compatibility() { :; }
${setupParts.join("\n")}
write_dashboard_release_journal "$4" "$5" "$6" "$7" "${originalCurrent}" "${originalPrevious}" \
  "${sourceEnv}" "${targetEnv}" "${source === coreRelease ? sourceWeb : targetWeb}" \
  "${target === coreRelease ? sourceWeb : targetWeb}" "${"f".repeat(64)}" "${"9".repeat(64)}"
require_command() { :; }
acquire_release_transaction_lock() { :; }
require_dashboard_fixed_roots() { :; }
require_dashboard_journal_publication_proof() { :; }
require_deployment_secrets() { :; }
dashboard_core_snapshot_sha256() { printf '%s\\n' "$expected_stable"; }
compose() { printf 'compose:%s\\n' "$*" >>"$transcript"; }
restore_dashboard_core_runtime() { printf 'pre-epoch-core\\n' >>"$transcript"; }
restore_images() { printf 'BAD-ordinary-restore\\n' >>"$transcript"; }
restore_dashboard_override_after_core_health() {
  local current_web
  current_web=$(read_optional_release_state "$state_dir/current-web-release")
  printf 'web:%s\\n' "\${current_web:-$core_release}" >>"$transcript"
}
main recover`, [fixture.deploy, transcript, action, coreRelease, source, target,
      sourceEnv, source, expectedStable],);
    return { fixture, result, transcript };
  } catch (error) {
    await removeFixture(fixture);
    throw error;
  }
}

test("recovery uses pre-epoch core after first-release crash with no web marker", async () => {
  const recovered = await runCoreRecoveryFixture({
    action: "release",
    expectedStable: "9".repeat(64),
    originalCurrent: "none",
    originalPrevious: "none",
    source: coreRelease,
    target: targetRelease,
  });
  try {
    assert.equal(recovered.result.status, 0, recovered.result.stderr);
    const operations = await readFile(recovered.transcript, "utf8");
    assert.match(operations, /pre-epoch-core/u);
    assert.match(operations, new RegExp(`web:${coreRelease}`, "u"));
    assert.doesNotMatch(operations, /BAD-ordinary-restore/u);
    await assert.rejects(readFile(join(recovered.fixture.state,
      "dashboard-web-transaction.env")));
  } finally {
    await removeFixture(recovered.fixture);
  }
});

test("recovery uses pre-epoch core after committed rollback-to-core", async () => {
  const recovered = await runCoreRecoveryFixture({
    action: "rollback",
    expectedStable: "9".repeat(64),
    originalCurrent: targetRelease,
    originalPrevious: coreRelease,
    source: targetRelease,
    target: coreRelease,
  });
  try {
    assert.equal(recovered.result.status, 0, recovered.result.stderr);
    const operations = await readFile(recovered.transcript, "utf8");
    assert.match(operations, /pre-epoch-core/u);
    assert.match(operations, new RegExp(`web:${coreRelease}`, "u"));
    assert.doesNotMatch(operations, /BAD-ordinary-restore/u);
  } finally {
    await removeFixture(recovered.fixture);
  }
});

test("recovery rejects stable core drift before runtime restoration", async () => {
  const recovered = await runCoreRecoveryFixture({
    action: "release",
    expectedStable: "8".repeat(64),
    originalCurrent: "none",
    originalPrevious: "none",
    source: coreRelease,
    target: targetRelease,
  });
  try {
    assert.notEqual(recovered.result.status, 0);
    assert.match(recovered.result.stderr, /stable core proof differs/u);
    const operations = await readFile(recovered.transcript, "utf8");
    assert.doesNotMatch(operations, /pre-epoch-core|BAD-ordinary-restore/u);
    assert.equal((await stat(join(recovered.fixture.state,
      "dashboard-web-transaction.env"))).mode & 0o777, 0o600);
  } finally {
    await removeFixture(recovered.fixture);
  }
});

test("ordinary core-one recovery uses the pre-epoch path without dashboard markers", async () => {
  const fixture = await createFixture();
  const transcript = join(fixture.root, "transcript-core-recovery");
  try {
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
transcript=$3
require_command() { :; }
acquire_release_transaction_lock() { :; }
require_dashboard_fixed_roots() { :; }
require_control_plane_compatibility() { :; }
require_deployment_secrets() { :; }
dashboard_core_snapshot_sha256() { printf '%s\\n' "${"9".repeat(64)}"; }
compose() { printf 'compose:%s\\n' "$*" >>"$transcript"; }
restore_dashboard_core_runtime() { printf 'pre-epoch-core\\n' >>"$transcript"; }
restore_images() { printf 'BAD-ordinary-restore\\n' >>"$transcript"; }
restore_dashboard_override_after_core_health() { printf 'web:${coreRelease}\\n' >>"$transcript"; }
main recover`, [fixture.deploy, transcript]);
    assert.equal(result.status, 0, result.stderr);
    const operations = await readFile(transcript, "utf8");
    assert.match(operations, /pre-epoch-core/u);
    assert.match(operations, new RegExp(`web:${coreRelease}`, "u"));
    assert.doesNotMatch(operations, /BAD-ordinary-restore/u);
  } finally {
    await removeFixture(fixture);
  }
});

test("pre-epoch core render removes future API and worker mounts", async () => {
  const fixture = await createFixture();
  const override = join(fixture.state, "compatibility.yaml");
  try {
    const result = runBash(`source "$1"
write_v14_compatibility_compose_override "$2"
require_v14_compatibility_compose_override "$3" "$2"`,
    [override, join(fixture.releases, `${coreRelease}.env`)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await stat(override)).mode & 0o777, 0o600);
  } finally {
    await removeFixture(fixture);
  }
});

test("web runtime rejects a container whose actual image ID differs", () => {
  const expected = `ghcr.io/anstosa/weather-web@sha256:${"a".repeat(64)}`;
  const result = runBash(`source "$1"
compose() {
  if [[ "$1" == ps ]]; then printf '%s\\n' aaaaaaaaaaaa; else return 0; fi
}
docker() {
  if [[ "$1" == container ]]; then
    printf '%s|%s\\n' "$2" 'sha256:${"b".repeat(64)}'
  elif [[ "$3" == '{{.Id}}' ]]; then
    printf '%s\\n' 'sha256:${"c".repeat(64)}'
  else
    printf '%s\\n' linux/arm64
  fi
}
verify_dashboard_web_runtime /tmp/web.env 2026.10.10-1 "$2"`, [expected]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /container image digest differs/u);
});

test("core rollback clears a two-release dashboard override chain", async () => {
  const fixture = await createFixture();
  const releaseA = "2026.10.10-1";
  const releaseB = "2026.10.10-2";
  const envA = join(fixture.releases, `${releaseA}.web.env`);
  const envB = join(fixture.releases, `${releaseB}.web.env`);
  const webA = `ghcr.io/anstosa/weather-web@sha256:${"a".repeat(64)}`;
  const webB = `ghcr.io/anstosa/weather-web@sha256:${"b".repeat(64)}`;
  try {
    const result = runBash(`source "$1"
deploy_dir=$2
releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
dashboard_release_journal="$state_dir/dashboard-web-transaction.env"
require_control_plane_compatibility() { :; }
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$3" "$4" "$5"
write_dashboard_release_env "$releases_dir/${coreRelease}.env" "$6" "$7" "$8"
record_dashboard_release_success "$4" "$9" "$9"
record_dashboard_release_success "$7" "$4" "$9"
dashboard_package_receipt() {
  printf '%s\\n' '{"checkRunId":1,"contractVersion":"dashboard-web-release-proof/v1","coreRelease":"2026.10.09-1","publishRunId":2,"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"publication_ready","targetCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targetRelease":"2026.10.09-1"}' >"$1"
  chmod 600 "$1"
}
dashboard_core_snapshot_sha256() { printf '%s\\n' "${"9".repeat(64)}"; }
verify_dashboard_web_runtime() { :; }
start_dashboard_web() { :; }
cleanup_obsolete_weather_images() { :; }
docker() { :; }
dashboard_rollback core`, [fixture.deploy, envA, releaseA, webA, envB, releaseB, webB,
      coreRelease]);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(join(fixture.state, "current-web-release")));
    await assert.rejects(readFile(join(fixture.state, "previous-web-release")));
    await assert.rejects(readlink(join(fixture.state, "active-web.env")));
  } finally {
    await removeFixture(fixture);
  }
});
