import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

// verify retained credential handoff
test("restore recreates PostgreSQL before starting runtime images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-postgres-restore-"));
  const transcript = join(directory, "transcript");

  try {
    const result = runBash(
      `source "$1"
transcript=$2
compose() { printf '%s:%s\n' "$WEATHER_ENV_FILE" "$*" >>"$transcript"; }
restore_images /releases/current.env`,
      [transcript],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(transcript, "utf8"),
      "/releases/current.env:up -d --no-deps --force-recreate --wait postgres\n" +
        "/releases/current.env:up -d --no-deps --wait api worker web cloudflared\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// verify private immutable authorization state
test("migration authorization is private exact and release-bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-migration-authorization-"));
  const releases = join(directory, "releases");
  const stagedAuthorization = join(releases, ".2026.08.22-2.authorization.partial");
  const replacementAuthorization = join(releases, ".2026.08.22-2.replacement.partial");
  const authorization = join(releases, "2026.08.22-2.migration-authorization");

  try {
    await mkdir(releases);
    const result = runBash(
      `source "$1"
releases_dir=$2
write_migration_authorization "$3" "2026.08.22-1" "2026.08.22-2" "${"a".repeat(64)}"
publish_migration_authorization "$3" "$4"
validate_migration_authorization "$4" "2026.08.22-1" "2026.08.22-2"`,
      [releases, stagedAuthorization, authorization],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await stat(authorization)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(authorization, "utf8"),
      `WEATHER_MIGRATION_AUTHORIZATION_VERSION=1\n` +
        `WEATHER_MIGRATION_AUTHORIZATION_RELEASE=2026.08.22-1\n` +
        `WEATHER_MIGRATION_AUTHORIZATION_SCHEMA_RELEASE=2026.08.22-2\n` +
        `WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=${"a".repeat(64)}\n`,
    );
    const replacement = runBash(
      `source "$1"
releases_dir=$2
write_migration_authorization "$3" "2026.08.22-1" "2026.08.22-2" "${"b".repeat(64)}"
publish_migration_authorization "$3" "$4"`,
      [releases, replacementAuthorization, authorization],
    );
    assert.notEqual(replacement.status, 0);
    assert.match(replacement.stderr, /migration authorization already exists/u);
    assert.match(await readFile(authorization, "utf8"), new RegExp(`${"a".repeat(64)}\\n$`, "u"));
    assert.match(
      await readFile(replacementAuthorization, "utf8"),
      new RegExp(`${"b".repeat(64)}\\n$`, "u"),
    );
    await writeFile(authorization, `${await readFile(authorization, "utf8")}UNKNOWN=value\n`, {
      mode: 0o600,
    });
    const rejected = runBash(
      'source "$1"; releases_dir="$2"; validate_migration_authorization "$3" "2026.08.22-1" "2026.08.22-2"',
      [releases, authorization],
    );
    assert.notEqual(rejected.status, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("restore injects authorization only for an older compatible release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-authorized-restore-"));
  const releases = join(directory, "releases");
  const authorization = join(releases, "2026.08.22-2.migration-authorization");
  const transcript = join(directory, "transcript");

  try {
    await mkdir(releases);
    const result = runBash(
      `source "$1"
releases_dir=$2
transcript=$3
write_migration_authorization "$4" "2026.08.22-1" "2026.08.22-2" "${"a".repeat(64)}"
start_postgres() { :; }
compose() { printf '%s|%s\n' "\${WEATHER_MIGRATION_AUTHORIZATION_RELEASE-unset}" "\${WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256-unset}" >>"$transcript"; }
restore_images /releases/previous.env 2026.08.22-1 2026.08.22-2
export WEATHER_MIGRATION_AUTHORIZATION_RELEASE=untrusted
export WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=untrusted
restore_images /releases/current.env 2026.08.22-2 2026.08.22-2`,
      [releases, transcript, authorization],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(transcript, "utf8"),
      `2026.08.22-1|${"a".repeat(64)}\nunset|unset\n`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rollback switches images and commits state without forward operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-rollback-"));
  const transcript = join(directory, "transcript");

  try {
    const result = runBash(
      `source "$1"
state_dir=/unused
transcript=$2
read_release_state() { [[ "$1" == */current-release ]] && printf '2026.08.22-2\\n' || printf '2026.08.22-1\\n'; }
read_optional_release_state() { printf '2026.08.22-2\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
restore_images() { printf 'restore:%s:%s:%s\\n' "$1" "$2" "$3" >>"$transcript"; }
record_release_success() { printf 'record:%s:%s\\n' "$1" "$2" >>"$transcript"; }
rollback_release`,
      [transcript],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(transcript, "utf8"),
      "restore:/releases/2026.08.22-1.env:2026.08.22-1:2026.08.22-2\n" +
        "record:2026.08.22-1:2026.08.22-2\n",
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
read_optional_release_state() { printf '2026.08.22-2\\n'; }
release_env() { printf '/releases/%s.env\\n' "$1"; }
validate_release_env() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() { :; }
restore_images() { attempt=$((attempt + 1)); printf 'restore:%s:%s:%s\\n' "$1" "$2" "$3" >>"$transcript"; ((attempt > 1)); }
record_release_success() { printf 'unexpected-record\\n' >>"$transcript"; }
rollback_release`,
      [transcript],
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(transcript, "utf8"),
      "restore:/releases/2026.08.22-1.env:2026.08.22-1:2026.08.22-2\n" +
        "restore:/releases/2026.08.22-2.env:2026.08.22-2:2026.08.22-2\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("failed activation records schema state before authorized image recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-activation-authorization-"));
  const scripts = join(directory, "scripts");
  const transcript = join(directory, "transcript");

  try {
    await mkdir(scripts);
    await writeFile(join(scripts, "backup.sh"), "#!/usr/bin/env bash\nexit 0\n");
    await chmod(join(scripts, "backup.sh"), 0o700);
    const result = runBash(
      `source "$1"
deploy_dir=$2
state_dir=$2/state
transcript=$3
release_env() { printf '/releases/%s.env\n' "$1"; }
validate_release_env() { :; }
require_control_plane_compatibility() { :; }
read_optional_release_state() { printf '2026.08.22-1\n'; }
require_capacity_gate() { :; }
require_deployment_secrets() { :; }
start_postgres() { :; }
compose() { printf 'compose:%s\n' "$*" >>"$transcript"; }
write_private_state() { printf 'state:%s:%s\n' "$1" "$2" >>"$transcript"; }
start_exact_release() { printf 'start-exact:%s\n' "$1" >>"$transcript"; return 1; }
migration_authorization() { printf '/releases/%s.migration-authorization\n' "$1"; }
validate_migration_authorization() { printf 'validate-auth:%s:%s:%s\n' "$1" "$2" "$3" >>"$transcript"; }
restore_images() { printf 'restore:%s:%s:%s\n' "$1" "$2" "$3" >>"$transcript"; }
start_release 2026.08.22-2`,
      [directory, transcript],
    );
    assert.notEqual(result.status, 0);
    const output = await readFile(transcript, "utf8");
    assert.match(
      output,
      /validate-auth:.*2026\.08\.22-2\.migration-authorization:2026\.08\.22-1:2026\.08\.22-2[\s\S]*state:.*schema-release:2026\.08\.22-2[\s\S]*compose:run --rm migration/u,
    );
    assert.match(
      output,
      /compose:run --rm migration[\s\S]*start-exact:.*2026\.08\.22-2\.env[\s\S]*validate-auth:.*2026\.08\.22-2\.migration-authorization:2026\.08\.22-1:2026\.08\.22-2[\s\S]*restore:.*2026\.08\.22-1\.env:2026\.08\.22-1:2026\.08\.22-2/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("recovery restores the active runtime against retained schema state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-recovery-authorization-"));
  const transcript = join(directory, "transcript");

  try {
    const result = runBash(
      `source "$1"
state_dir=$2/state
transcript=$3
read_release_state() { printf '2026.08.22-1\n'; }
read_optional_release_state() { printf '2026.08.22-2\n'; }
release_env() { printf '/releases/%s.env\n' "$1"; }
validate_release_env() { :; }
require_control_plane_compatibility() { :; }
require_command() { :; }
require_deployment_secrets() { :; }
restore_images() { printf 'restore:%s:%s:%s\n' "$1" "$2" "$3" >>"$transcript"; }
write_active_symlink() { printf 'active:%s\n' "$1" >>"$transcript"; }
main recover`,
      [directory, transcript],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(transcript, "utf8"),
      "restore:/releases/2026.08.22-1.env:2026.08.22-1:2026.08.22-2\n" +
        "active:2026.08.22-1\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("persistent authorization is written only after API and worker compatibility", async () => {
  const update = await readFile(updateScript, "utf8");
  const compatibility = update
    .split("verify_previous_image_compatibility() (")[1]
    .split("\n)\n\n# reconcile retained PostgreSQL")[0];
  const previousHistory = compatibility.indexOf(
    'previous_history_sha256=$(migration_history_sha256',
  );
  const currentHistory = compatibility.indexOf(
    'history_sha256=$(migration_history_sha256',
  );
  const authorizedWorker = compatibility.indexOf(
    "worker node apps/worker/dist/worker.js --once",
  );
  const workerGate = compatibility.indexOf("previous worker compatibility failed");
  const schemaChangeGate = compatibility.indexOf(
    'if [[ "$history_sha256" != "$previous_history_sha256" ]]',
  );
  const unprovenWorkerHealth = compatibility.indexOf(
    "worker node apps/worker/dist/health.js",
  );
  const workerRejection = compatibility.indexOf(
    "previous worker accepted unproven migration history",
  );
  const apiRejection = compatibility.indexOf(
    "previous API accepted invalid migration authorization",
  );
  const apiGate = compatibility.indexOf("previous API compatibility failed");
  const publication = compatibility.lastIndexOf("write_migration_authorization");

  assert.equal(previousHistory >= 0, true);
  assert.equal(currentHistory > previousHistory, true);
  assert.equal(authorizedWorker > currentHistory, true);
  assert.equal(workerGate > authorizedWorker, true);
  assert.equal(schemaChangeGate > workerGate, true);
  assert.equal(unprovenWorkerHealth > schemaChangeGate, true);
  assert.equal(workerRejection > unprovenWorkerHealth, true);
  assert.equal(apiRejection > workerGate, true);
  assert.equal(apiGate > apiRejection, true);
  assert.equal(publication > apiGate, true);
  const stage = update.split("  stage)\n")[1].split("  activate)\n")[0];
  assert.match(stage, /published_authorization/u);
  assert.match(stage, /trap 'rm -f[^']*published_authorization/u);
});

test("release environment validator requires exact current control metadata", async () => {
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
    // reject missing control metadata
    const legacyContent = content
      .split("\n")
      .filter((line) => !line.startsWith("WEATHER_CONTROL_PLANE_"))
      .join("\n");
    await writeFile(valid, `${legacyContent}\n`, { mode: 0o600 });
    const rejectedLegacy = runBash('source "$1"; validate_release_env "$2" "2026.08.22-1"', [valid]);
    assert.notEqual(rejectedLegacy.status, 0);
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

test("deployment secret validation rejects equal administrator and owner credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-secret-separation-"));
  const secrets = join(directory, "secrets");

  try {
    await mkdir(secrets);
    const values = {
      cloudflare_tunnel_token: "tunnel",
      weather_api_password: "api",
      weather_migration_owner_password: "owner",
      weather_postgres_admin_password: "owner",
      weather_postgres_api_password: "api",
      weather_postgres_ingest_password: "ingest",
      weather_postgres_owner_password: "owner",
      weather_worker_ingest_password: "ingest",
    };

    // provision every required source
    await Promise.all(
      Object.entries(values).map(([name, value]) => writeFile(join(secrets, name), `${value}\n`)),
    );
    const result = runBash(
      'source "$1"; deploy_dir="$2"; require_secret_source() { :; }; require_deployment_secrets',
      [directory],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /administrator and owner passwords must differ/u);
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
      assert.match(
        output,
        /compose:up -d --no-deps --force-recreate --wait postgres[\s\S]*compose:down --remove-orphans/u,
      );
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
    assert.match(versionRejected.stderr, /unsupported without a versioned allowlisted handoff/u);
    await writeFile(
      release,
      `WEATHER_CONTROL_PLANE_SHA256=${"a".repeat(64)}\nWEATHER_CONTROL_PLANE_VERSION=1\n`,
    );
    const digestRejected = runBash(
      'source "$1"; require_control_plane_compatibility "$2"',
      [release],
    );
    assert.notEqual(digestRejected.status, 0);
    assert.match(digestRejected.stderr, /unsupported without a versioned allowlisted handoff/u);
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

// prove stage rejects before mutation
test("stage rejects an unsupported current control plane before any mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-stage-current-gate-"));
  const releases = join(directory, "releases");
  const state = join(directory, "state");
  const sourceEnv = join(directory, "source.env");
  const transcript = join(directory, "transcript");

  try {
    await mkdir(releases);
    await mkdir(state);
    await writeFile(sourceEnv, "source\n");
    const result = runBash(
      `source "$1"
deploy_dir=$2
releases_dir=$3
state_dir=$4
transcript=$5
require_file() { :; }
require_command() { :; }
require_capacity_gate() { printf 'capacity\n' >>"$transcript"; }
env_value() {
  case "$2" in
    WEATHER_SERVER_IMAGE) printf 'registry.example/weather-server\n' ;;
    WEATHER_WEB_IMAGE) printf 'registry.example/weather-web\n' ;;
    POSTGRES_IMAGE) printf 'postgres\n' ;;
    CLOUDFLARED_IMAGE) printf 'cloudflare/cloudflared\n' ;;
  esac
}
resolve_arm64_image() { printf 'resolve:%s\n' "$1" >>"$transcript"; printf '%s@sha256:%064d\n' "$1" 0; }
write_release_env() { printf 'write:%s\n' "$2" >>"$transcript"; : >"$2"; }
compose() {
  printf 'compose:%s\n' "$*" >>"$transcript"
  if [[ "$*" == 'config --images' ]]; then
    printf '%s\n' \
      'registry.example/weather-server@sha256:${"a".repeat(64)}' \
      'registry.example/weather-web@sha256:${"b".repeat(64)}' \
      'postgres@sha256:${"c".repeat(64)}' \
      'cloudflare/cloudflared@sha256:${"d".repeat(64)}'
  fi
}
read_optional_release_state() { printf '2026.08.22-1\n'; }
release_env() { printf '%s/%s.env\n' "$releases_dir" "$1"; }
validate_release_env() { :; }
require_control_plane_compatibility() { printf 'gate:%s\n' "$1" >>"$transcript"; return 1; }
require_deployment_secrets() { printf 'secrets\n' >>"$transcript"; }
verify_previous_image_compatibility() { printf 'compatibility-migration\n' >>"$transcript"; }
main stage 2026.08.22-2 --from "$6"`,
      [directory, releases, state, transcript, sourceEnv],
    );
    assert.notEqual(result.status, 0);
    const output = await readFile(transcript, "utf8");
    assert.match(output, /gate:.*2026\.08\.22-1\.env/u);
    assert.doesNotMatch(
      output,
      /capacity|resolve:|write:|compose:|secrets|compatibility-migration/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("activation never migrates or restores an unchecked current release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-activate-current-gate-"));
  const scripts = join(directory, "scripts");
  const transcript = join(directory, "transcript");

  try {
    await mkdir(scripts);
    await writeFile(
      join(scripts, "backup.sh"),
      '#!/usr/bin/env bash\nprintf \'backup\\n\' >>"$WEATHER_TEST_TRANSCRIPT"\n',
    );
    await chmod(join(scripts, "backup.sh"), 0o700);
    const result = runBash(
      `source "$1"
deploy_dir=$2
state_dir=$2/state
transcript=$3
export WEATHER_TEST_TRANSCRIPT=$transcript
release_env() { printf '/releases/%s.env\n' "$1"; }
validate_release_env() { :; }
read_optional_release_state() { printf '2026.08.22-1\n'; }
require_capacity_gate() { :; }
require_deployment_secrets() { :; }
require_control_plane_compatibility() {
  printf 'gate:%s\n' "$1" >>"$transcript"
  [[ "$1" != */2026.08.22-1.env ]]
}
compose() {
  printf 'compose:%s\n' "$*" >>"$transcript"
  [[ "$*" != 'up -d --remove-orphans --wait' ]]
}
restore_images() { printf 'restore:%s\n' "$1" >>"$transcript"; }
record_release_success() { printf 'record:%s\n' "$1" >>"$transcript"; }
start_release 2026.08.22-2`,
      [directory, transcript],
    );
    assert.notEqual(result.status, 0);
    const output = await readFile(transcript, "utf8");
    assert.match(output, /gate:.*2026\.08\.22-2\.env[\s\S]*gate:.*2026\.08\.22-1\.env/u);
    assert.doesNotMatch(output, /backup|compose:|restore:|record:/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// prove rollback and recovery gate every release
test("rollback and recovery reject unsupported control planes before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-rollback-control-gate-"));

  try {
    // reject either rollback boundary
    for (const rejectedRelease of ["2026.08.22-2", "2026.08.22-1"]) {
      const transcript = join(directory, `${rejectedRelease}.transcript`);
      const result = runBash(
        `source "$1"
state_dir=$2/state
transcript=$3
rejected_release=$4
read_release_state() {
  case "$1" in
    */current-release) printf '2026.08.22-2\n' ;;
    */previous-release) printf '2026.08.22-1\n' ;;
  esac
}
release_env() { printf '/releases/%s.env\n' "$1"; }
validate_release_env() { :; }
require_control_plane_compatibility() {
  printf 'gate:%s\n' "$1" >>"$transcript"
  [[ "$1" != *"$rejected_release.env" ]]
}
require_deployment_secrets() { printf 'secrets\n' >>"$transcript"; }
restore_images() { printf 'restore:%s\n' "$1" >>"$transcript"; }
record_release_success() { printf 'record:%s\n' "$1" >>"$transcript"; }
rollback_release`,
        [directory, transcript, rejectedRelease],
      );
      assert.notEqual(result.status, 0, rejectedRelease);
      const output = await readFile(transcript, "utf8");
      assert.match(output, new RegExp(`gate:.*${rejectedRelease.replaceAll(".", "\\.")}\\.env`, "u"));
      assert.doesNotMatch(output, /secrets|restore:|record:/u);
    }

    const recoverTranscript = join(directory, "recover.transcript");
    const recover = runBash(
      `source "$1"
state_dir=$2/state
transcript=$3
read_release_state() { printf '2026.08.22-2\n'; }
release_env() { printf '/releases/%s.env\n' "$1"; }
validate_release_env() { :; }
require_control_plane_compatibility() { printf 'gate:%s\n' "$1" >>"$transcript"; return 1; }
require_deployment_secrets() { printf 'secrets\n' >>"$transcript"; }
restore_images() { printf 'restore:%s\n' "$1" >>"$transcript"; }
write_active_symlink() { printf 'active:%s\n' "$1" >>"$transcript"; }
main recover`,
      [directory, recoverTranscript],
    );
    assert.notEqual(recover.status, 0);
    assert.match(await readFile(recoverTranscript, "utf8"), /^gate:.*2026\.08\.22-2\.env\n$/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
