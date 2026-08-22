import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
read_release_state() { [[ "$1" == */current-release ]] && printf '2026.08.22-2\\n' || printf '2026.08.22-1\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
restore_images() { printf 'restore:%s\\n' "$1" >>"$2"; }
record_release_success() { printf 'record:%s:%s\\n' "$1" "$2" >>"$3"; }
export -f read_release_state release_env validate_release_env require_deployment_secrets restore_images record_release_success
rollback_release "$2" "$2"`,
      [transcript],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await Bun.file(transcript).text(),
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
attempt=0
read_release_state() { [[ "$1" == */current-release ]] && printf '2026.08.22-2\\n' || printf '2026.08.22-1\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
restore_images() { attempt=$((attempt + 1)); printf 'restore:%s\\n' "$1" >>"$2"; ((attempt > 1)); }
record_release_success() { printf 'unexpected-record\\n' >>"$2"; }
rollback_release "$2"`,
      [transcript],
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      await Bun.file(transcript).text(),
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
