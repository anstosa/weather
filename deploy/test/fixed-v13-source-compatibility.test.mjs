import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const updateScript = join(repoRoot, "deploy/scripts/update.sh");

// run one sourced update helper
function runBash(source, argumentsList = []) {
  return spawnSync(
    "bash",
    ["-c", source, "weather-fixed-v13-test", updateScript, ...argumentsList],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// build one minimal identity fixture
async function writeIdentity(path, values) {
  await writeFile(
    path,
    Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
    { mode: 0o600 },
  );
}

test("fixed v13 identity admits only the reviewed source images and a distinct v13 target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-fixed-v13-identity-"));
  const source = join(directory, "source.env");
  const target = join(directory, "target.env");
  const sourceValues = {
    WEATHER_CONTROL_PLANE_SHA256:
      "16d871c7aebb3a34097af219fd5c76a93b3ff1be3af521643dbf3a4d2041c61d",
    WEATHER_CONTROL_PLANE_VERSION: "12",
    WEATHER_RELEASE: "2026.10.07-3",
    WEATHER_SERVER_IMAGE:
      "ghcr.io/anstosa/weather-server@sha256:d0688756c33875940f67fbb782d9e67a2405a811d2aca40bd155f6ceffa71a74",
    WEATHER_WEB_IMAGE:
      "ghcr.io/anstosa/weather-web@sha256:739d063cd911bcd7c6637082e356889ef60ac7a76caabc737070703fdf83746f",
  };
  const targetValues = {
    WEATHER_CONTROL_PLANE_VERSION: "13",
    WEATHER_RELEASE: "2026.10.08-1",
  };

  try {
    await writeIdentity(source, sourceValues);
    await writeIdentity(target, targetValues);
    const admitted = runBash(
      'source "$1"; require_fixed_v13_source_identity "$2" "$3"',
      [target, source],
    );
    assert.equal(admitted.status, 0, admitted.stderr);

    const refusals = [
      [
        { ...sourceValues, WEATHER_RELEASE: "2026.10.07-2" },
        targetValues,
        /requires release 2026\.10\.07-3/u,
      ],
      [
        { ...sourceValues, WEATHER_CONTROL_PLANE_VERSION: "11" },
        targetValues,
        /source control-plane identity differs/u,
      ],
      [
        {
          ...sourceValues,
          WEATHER_SERVER_IMAGE: `ghcr.io/anstosa/weather-server@sha256:${"a".repeat(64)}`,
        },
        targetValues,
        /source server image identity differs/u,
      ],
      [
        {
          ...sourceValues,
          WEATHER_WEB_IMAGE: `ghcr.io/anstosa/weather-web@sha256:${"b".repeat(64)}`,
        },
        targetValues,
        /source web image identity differs/u,
      ],
      [sourceValues, { ...targetValues, WEATHER_CONTROL_PLANE_VERSION: "12" }, /version 13 target/u],
      [sourceValues, { ...targetValues, WEATHER_RELEASE: "2026.10.07-3" }, /distinct target release/u],
    ];

    // reject every identity mismatch independently
    for (const [rejectedSource, rejectedTarget, error] of refusals) {
      await writeIdentity(source, rejectedSource);
      await writeIdentity(target, rejectedTarget);
      const rejected = runBash(
        'source "$1"; require_fixed_v13_source_identity "$2" "$3"',
        [target, source],
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, error);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fixed v13 authorization target must be caller-owned private empty and single-link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-fixed-v13-authorization-"));
  const releases = join(directory, "releases");
  const valid = join(releases, ".valid.partial");
  const nonempty = join(releases, ".nonempty.partial");
  const publicFile = join(releases, ".public.partial");
  const linked = join(releases, ".linked.partial");
  const secondLink = join(releases, ".linked-second.partial");
  const symbolic = join(releases, ".symbolic.partial");

  try {
    await mkdir(releases);
    await writeFile(valid, "", { mode: 0o600 });
    await writeFile(nonempty, "occupied\n", { mode: 0o600 });
    await writeFile(publicFile, "", { mode: 0o600 });
    await chmod(publicFile, 0o644);
    await writeFile(linked, "", { mode: 0o600 });
    await link(linked, secondLink);
    await symlink(valid, symbolic);
    const accepted = runBash(
      'source "$1"; releases_dir="$2"; require_fixed_v13_authorization_target "$3"',
      [releases, valid],
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    // reject each unsafe publication inode
    for (const candidate of [nonempty, publicFile, linked, secondLink, symbolic]) {
      const rejected = runBash(
        'source "$1"; releases_dir="$2"; require_fixed_v13_authorization_target "$3"',
        [releases, candidate],
      );
      assert.notEqual(rejected.status, 0, candidate);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fixed v13 proof is empty-fixture bounded and publishes only after source runtime checks", async () => {
  const update = await readFile(updateScript, "utf8");
  const fixed = update
    .split("verify_fixed_v13_source_compatibility() (")[1]
    .split("\n)\n\n# run previous-image checks")[0];
  const legacy = update
    .split("verify_previous_image_compatibility() (")[1]
    .split("\n)\n\n# reconcile retained PostgreSQL")[0];
  const migrate = fixed.indexOf("compose run --rm --no-deps");
  const acl = fixed.indexOf("verify_runtime_database_acl");
  const ledger = fixed.indexOf('ledger_state=$(WEATHER_ENV_FILE=');
  const authorizedWorker = fixed.indexOf("worker node apps/worker/dist/worker.js --once");
  const rejectedWorker = fixed.indexOf("source worker accepted unproven migration history");
  const rejectedApi = fixed.indexOf("source API accepted invalid migration authorization");
  const acceptedApi = fixed.indexOf("source API compatibility failed");
  const createMeasure = fixed.indexOf('measure_fixed_v13_compatibility create "$candidate"');
  const schemaMeasure = fixed.indexOf('measure_fixed_v13_compatibility schema "$candidate"');
  const configurationMeasure = fixed.indexOf('measure_fixed_v13_compatibility configuration "$candidate"');
  const workerMeasure = fixed.indexOf('measure_fixed_v13_compatibility worker "$candidate"');
  const rejectionMeasure = fixed.indexOf('measure_fixed_v13_compatibility rejection "$candidate"');
  const apiMeasure = fixed.indexOf('measure_fixed_v13_compatibility api "$candidate"');
  const teardownMeasure = fixed.indexOf("measure_fixed_v13_compatibility teardown");
  const authorization = fixed.lastIndexOf("write_migration_authorization");

  assert.match(fixed, /fixture_budget_bytes=\$\(\(64 \* 1024 \* 1024\)\)/u);
  assert.match(fixed, /createdb --username postgres --owner weather_owner --template template0/u);
  assert.doesNotMatch(fixed, /pg_dump|pg_restore/u);
  assert.match(
    fixed,
    /18:1:c13d2c2c39096887712ae97f0b863f8a7ab52074ca320575f8c4c1f9b72a50a3/u,
  );
  assert.equal(migrate >= 0 && acl > migrate && ledger > acl, true);
  assert.equal(authorizedWorker > ledger && rejectedWorker > authorizedWorker, true);
  assert.equal(rejectedApi > rejectedWorker && acceptedApi > rejectedApi, true);
  assert.equal(createMeasure >= 0 && schemaMeasure > createMeasure, true);
  assert.equal(configurationMeasure > schemaMeasure && workerMeasure > configurationMeasure, true);
  assert.equal(rejectionMeasure > workerMeasure && apiMeasure > rejectionMeasure, true);
  assert.equal(teardownMeasure > apiMeasure && authorization > teardownMeasure, true);
  assert.doesNotMatch(fixed, /publish_migration_authorization/u);

  // retain the full-clone legacy stage proof unchanged
  assert.match(legacy, /pg_dump[\s\S]*pg_restore/u);
  assert.match(legacy, /baseline_schema_state" == "8:::::::"/u);
});

test("fixed v13 proof writes a target-bound temporary authorization after deterministic checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-fixed-v13-proof-"));
  const releases = join(directory, "releases");
  const source = join(directory, "source.env");
  const target = join(directory, "target.env");
  const authorization = join(releases, ".target.authorization.partial");
  const transcript = join(directory, "transcript");
  const workerMarker = join(directory, "worker-passed");
  const sourceValues = {
    WEATHER_DATABASE_NAME: "weather",
    WEATHER_CONTROL_PLANE_SHA256:
      "16d871c7aebb3a34097af219fd5c76a93b3ff1be3af521643dbf3a4d2041c61d",
    WEATHER_CONTROL_PLANE_VERSION: "12",
    WEATHER_RELEASE: "2026.10.07-3",
    WEATHER_SERVER_IMAGE:
      "ghcr.io/anstosa/weather-server@sha256:d0688756c33875940f67fbb782d9e67a2405a811d2aca40bd155f6ceffa71a74",
    WEATHER_WEB_IMAGE:
      "ghcr.io/anstosa/weather-web@sha256:739d063cd911bcd7c6637082e356889ef60ac7a76caabc737070703fdf83746f",
  };
  const targetValues = {
    WEATHER_CONTROL_PLANE_VERSION: "13",
    WEATHER_RELEASE: "2026.10.08-1",
    WEATHER_SERVER_IMAGE: `ghcr.io/anstosa/weather-server@sha256:${"c".repeat(64)}`,
  };

  try {
    await mkdir(releases);
    await writeIdentity(source, sourceValues);
    await writeIdentity(target, targetValues);
    await writeFile(authorization, "", { mode: 0o600 });
    const proved = runBash(
      `source "$1"
releases_dir=$2
transcript=$6
worker_marker=$7
validate_release_env() { :; }
require_canonical_descendant() { :; }
apply_runtime_database_acl() { printf 'acl:apply\n' >>"$transcript"; }
verify_runtime_database_acl() { printf 'acl:verify\n' >>"$transcript"; }
migration_history_sha256() { printf '%064d\n' 1; }
stat() {
  if [[ "$1" == --file-system ]]; then
    printf '1000000 4096 100000\n'
  else
    command stat "$@"
  fi
}
sleep() { :; }
write_migration_authorization() {
  printf 'authorization:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$transcript"
}
compose() {
  printf 'compose:%s\n' "$*" >>"$transcript"
  case "$*" in
    *pg_wal_lsn_diff*) printf '1048576\n' ;;
    *pg_current_wal_lsn*) printf '0/100\n' ;;
    *"count(*)::text || ':' || count(*) FILTER"*)
      printf '18:1:c13d2c2c39096887712ae97f0b863f8a7ab52074ca320575f8c4c1f9b72a50a3\n'
      ;;
    *"provider_key <> 'open-meteo'"*) printf '\n' ;;
    *"provider_key = 'open-meteo'"*) printf '1\n' ;;
    *"ingestion_runs WHERE state = 'succeeded'"*)
      [[ -e "$worker_marker" ]] && printf '1\n' || printf '0\n'
      ;;
    *"source_key = 'open-meteo-forecast-v4'"*)
      [[ -e "$worker_marker" ]] && printf '1\n' || printf '0\n'
      ;;
    *"worker.js --once"*) : >"$worker_marker" ;;
    *"worker/dist/health.js"*) return 1 ;;
    *pg_database_size*) printf '10485760\n' ;;
  esac
}
docker() {
  printf 'docker:%s\n' "$*" >>"$transcript"
  if [[ "$*" == *"_api_unproven node -e"* ]]; then
    printf '503\n'
  fi
}
verify_fixed_v13_source_compatibility "$3" "$4" "$5"`,
      [releases, target, source, authorization, transcript, workerMarker],
    );
    assert.equal(proved.status, 0, proved.stderr);
    const evidence = await readFile(transcript, "utf8");
    const migration = evidence.indexOf("run --rm --no-deps --env WEATHER_DATABASE_NAME=");
    const acl = evidence.indexOf("acl:verify");
    const sourceWorker = evidence.indexOf("worker node apps/worker/dist/worker.js --once");
    const wrongApi = evidence.indexOf("_api_unproven");
    const sourceApi = evidence.indexOf("api node apps/api/dist/main.js", wrongApi + 1);
    const fixtureDrop = evidence.lastIndexOf("dropdb --username postgres weather_v13_compat_");
    const teardownWal = evidence.lastIndexOf("pg_wal_lsn_diff");
    const publication = evidence.indexOf(`authorization:${authorization}:2026.10.07-3:2026.10.08-1:`);

    assert.equal(migration >= 0 && acl > migration, true);
    assert.equal(sourceWorker > acl && wrongApi > sourceWorker, true);
    assert.equal(sourceApi > wrongApi && publication > sourceApi, true);
    assert.equal(fixtureDrop > sourceApi && teardownWal > fixtureDrop, true);
    assert.equal(publication > teardownWal, true);
    assert.match(evidence, new RegExp(`authorization:${authorization.replaceAll("/", "\\/")}[^\n]+${"1".padStart(64, "0")}`, "u"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
