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
  ].join("\n");

  try {
    await writeFile(valid, `${content}\n`, { mode: 0o600 });
    const accepted = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.equal(accepted.status, 0, accepted.stderr);
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

test("initial activation cleans the Weather project after backup failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-initial-cleanup-"));
  const transcript = join(directory, "transcript");

  try {
    await mkdir(join(directory, "scripts"));
    await writeFile(join(directory, "scripts/backup.sh"), "#!/usr/bin/env bash\nexit 1\n");
    await chmod(join(directory, "scripts/backup.sh"), 0o700);
    const result = runBash(
      `source "$1"
deploy_dir=$2
state_dir=$2/state
transcript=$3
release_env() { printf '/target.env\\n'; }
validate_release_env() { :; }
read_optional_release_state() { :; }
require_capacity_gate() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
compose() { printf 'compose:%s\\n' "$*" >>"$transcript"; }
start_release 2026.08.22-1`,
      [directory, transcript],
    );
    assert.notEqual(result.status, 0);
    assert.match(
      await readFile(transcript, "utf8"),
      /compose:up -d postgres --wait[\s\S]*compose:down --remove-orphans/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
