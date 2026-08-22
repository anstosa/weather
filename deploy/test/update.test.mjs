import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const updateScript = join(repoRoot, "deploy/scripts/update.sh");

// run one isolated release function
function runBash(source, argumentsList = []) {
  return spawnSync("bash", ["-c", source, "weather-update-test", updateScript, ...argumentsList], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("rollback switches images and commits state without forward operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-rollback-"));
  const transcript = join(directory, "transcript");

  try {
    const result = runBash(
      `source "$1"
state_dir=/unused
transcript=$2
read_release_state() { [[ "$1" == */current-release ]] && printf '2026.08.22-2\\n' || printf '2026.08.22-1\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
restore_images() { printf 'restore:%s\\n' "$1" >>"$transcript"; }
record_release_success() { printf 'record:%s:%s\\n' "$1" "$2" >>"$transcript"; }
rollback_release`,
      [transcript],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(transcript, "utf8"),
      "restore:/releases/2026.08.22-1.env\nrecord:2026.08.22-1:2026.08.22-2\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("failed rollback restores current images without committing state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-rollback-failure-"));
  const transcript = join(directory, "transcript");

  try {
    const result = runBash(
      `source "$1"
state_dir=/unused
transcript=$2
attempt=0
read_release_state() { [[ "$1" == */current-release ]] && printf '2026.08.22-2\\n' || printf '2026.08.22-1\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
restore_images() { attempt=$((attempt + 1)); printf 'restore:%s\\n' "$1" >>"$transcript"; ((attempt > 1)); }
record_release_success() { printf 'unexpected-record\\n' >>"$transcript"; }
rollback_release`,
      [transcript],
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(transcript, "utf8"),
      "restore:/releases/2026.08.22-1.env\nrestore:/releases/2026.08.22-2.env\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("release environment validator rejects duplicate and unknown state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-release-env-"));
  const valid = join(directory, "valid.env");
  const digest = `sha256:${"a".repeat(64)}`;
  const content = [
    "WEATHER_RELEASE=2026.08.22-1",
    `WEATHER_SERVER_IMAGE=registry.example/weather-server@${digest}`,
    `WEATHER_WEB_IMAGE=registry.example/weather-web@${digest}`,
    `POSTGRES_IMAGE=postgres@${digest}`,
    `CLOUDFLARED_IMAGE=cloudflare/cloudflared@${digest}`,
    "WEATHER_DATABASE_NAME=weather",
    "WEATHER_POSTGRES_DIR=/var/lib/weather/postgres",
    `WEATHER_CONTROL_PLANE_SHA256=${"b".repeat(64)}`,
    "WEATHER_CONTROL_PLANE_VERSION=1",
  ].join("\n");

  try {
    await writeFile(valid, `${content}\n`, { mode: 0o600 });
    const accepted = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.equal(accepted.status, 0, accepted.stderr);
    // strip current control metadata
    const legacyContent = content
      .split("\n")
      .filter((line) => !line.startsWith("WEATHER_CONTROL_PLANE_"))
      .join("\n");
    await writeFile(valid, `${legacyContent}\n`, { mode: 0o600 });
    const acceptedLegacy = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.equal(acceptedLegacy.status, 0, acceptedLegacy.stderr);
    await writeFile(valid, `${content}\nWEATHER_RELEASE=2026.08.22-1\n`, { mode: 0o600 });
    const duplicate = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.notEqual(duplicate.status, 0);
    await writeFile(valid, `${content}\nUNKNOWN_STATE=value\n`, { mode: 0o600 });
    const unknown = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.notEqual(unknown.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("release environment validator rejects non-canonical PostgreSQL paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-release-path-"));
  const candidate = join(directory, "candidate.env");
  const digest = `sha256:${"a".repeat(64)}`;
  const controlPlane = "b".repeat(64);

  try {
    // reject every alias and escape
    for (const postgresDirectory of [
      "/var/lib/weather/postgres/../escape",
      "/var/lib/weather//postgres",
      "/var/lib/weather/postgres/.",
      "/var/lib/weather-postgres",
    ]) {
      const content = [
        "WEATHER_RELEASE=2026.08.22-1",
        `WEATHER_SERVER_IMAGE=registry.example/weather-server@${digest}`,
        `WEATHER_WEB_IMAGE=registry.example/weather-web@${digest}`,
        `POSTGRES_IMAGE=postgres@${digest}`,
        `CLOUDFLARED_IMAGE=cloudflare/cloudflared@${digest}`,
        "WEATHER_DATABASE_NAME=weather",
        `WEATHER_POSTGRES_DIR=${postgresDirectory}`,
        `WEATHER_CONTROL_PLANE_SHA256=${controlPlane}`,
        "WEATHER_CONTROL_PLANE_VERSION=1",
      ].join("\n");
      await writeFile(candidate, `${content}\n`, { mode: 0o600 });
      const result = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [candidate]);
      assert.notEqual(result.status, 0, postgresDirectory);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("secret validation rejects a symlink outside the Weather secret root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-secret-path-"));
  const deployDirectory = join(directory, "deploy");
  const outside = join(directory, "outside");
  const secret = join(outside, "weather_api_password");

  try {
    await mkdir(deployDirectory);
    await mkdir(outside);
    await writeFile(secret, "secret\n");
    await chmod(secret, 0o400);
    await symlink(outside, join(deployDirectory, "secrets"));
    const result = runBash(
      'source "$1"; deploy_dir="$2"; require_secret_source "$3" "$(id -u)" "$(id -g)"',
      [deployDirectory, join(deployDirectory, "secrets/weather_api_password")],
    );
    assert.notEqual(result.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("initial activation cleans the Weather project after every startup failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-initial-cleanup-"));

  try {
    await mkdir(join(directory, "scripts"));
    await writeFile(
      join(directory, "scripts/backup.sh"),
      '#!/usr/bin/env bash\nexit "${WEATHER_TEST_BACKUP_STATUS:-0}"\n',
    );
    await chmod(join(directory, "scripts/backup.sh"), 0o700);
    const failureCases = ["backup", "migration", "health"];

    // inject every post-start failure
    for (const failureCase of failureCases) {
      const transcript = join(directory, `${failureCase}.transcript`);
      const result = runBash(
        `source "$1"
deploy_dir=$2
state_dir=$2/state
transcript=$3
failure_case=$4
release_env() { printf '/target.env\\n'; }
validate_release_env() { :; }
read_optional_release_state() { :; }
require_capacity_gate() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
record_release_success() { printf 'recorded\\n' >>"$transcript"; }
compose() {
  printf 'compose:%s\\n' "$*" >>"$transcript"
  # fail the selected lifecycle stage
  if [[ "$failure_case" == migration && "$*" == 'run --rm migration' ]]; then return 1; fi
  if [[ "$failure_case" == health && "$*" == 'up -d --remove-orphans --wait' ]]; then return 1; fi
}
export WEATHER_TEST_BACKUP_STATUS=$([[ "$failure_case" == backup ]] && printf 1 || printf 0)
start_release 2026.08.22-1`,
        [directory, transcript, failureCase],
      );
      assert.notEqual(result.status, 0, failureCase);
      const output = await readFile(transcript, "utf8");
      assert.match(output, /compose:up -d postgres --wait[\s\S]*compose:down --remove-orphans/u);
      assert.doesNotMatch(output, /recorded/u);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("release operations reject incompatible deployment control-plane metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-control-plane-"));
  const release = join(directory, "release.env");

  try {
    const digest = runBash('source "$1"; control_plane_digest').stdout.trim();
    await writeFile(
      release,
      `WEATHER_CONTROL_PLANE_SHA256=${digest}\nWEATHER_CONTROL_PLANE_VERSION=1\n`,
    );
    const accepted = runBash('source "$1"; require_control_plane_compatibility "$2"', [release]);
    assert.equal(accepted.status, 0, accepted.stderr);
    await writeFile(
      release,
      `WEATHER_CONTROL_PLANE_SHA256=${digest}\nWEATHER_CONTROL_PLANE_VERSION=2\n`,
    );
    const versionRejected = runBash(
      'source "$1"; require_control_plane_compatibility "$2"',
      [release],
    );
    assert.notEqual(versionRejected.status, 0);
    await writeFile(
      release,
      `WEATHER_CONTROL_PLANE_SHA256=${"a".repeat(64)}\nWEATHER_CONTROL_PLANE_VERSION=1\n`,
    );
    const digestRejected = runBash(
      'source "$1"; require_control_plane_compatibility "$2"',
      [release],
    );
    assert.notEqual(digestRejected.status, 0);
    await writeFile(release, "WEATHER_CONTROL_PLANE_VERSION=1\n");
    const metadataRejected = runBash(
      'source "$1"; require_control_plane_compatibility "$2"',
      [release],
    );
    assert.notEqual(metadataRejected.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
