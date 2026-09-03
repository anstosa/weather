import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const deployRoot = join(repoRoot, "deploy");
const scriptsRoot = join(deployRoot, "scripts");

// render a deterministic Compose model
function renderCompose(overrides = []) {
  const files = [join(deployRoot, "compose.yaml"), ...overrides.map((name) => join(deployRoot, name))];
  const argumentsList = [
    "compose",
    "--project-name",
    "weather",
    "--env-file",
    join(deployRoot, ".env.example"),
  ];

  // add ordered Compose files
  for (const file of files) {
    argumentsList.push("--file", file);
  }

  argumentsList.push("config", "--format", "json");
  return JSON.parse(
    execFileSync("docker", argumentsList, { cwd: repoRoot, encoding: "utf8" }),
  );
}

// collect files recursively
function collectFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

// read one repository artifact
function read(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

// extract one executable workflow run block
function workflowRunScript(workflow, stepName) {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);

  // require the named step
  if (stepIndex < 0) {
    throw new Error(`workflow step not found: ${stepName}`);
  }

  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.trim() === "run: |",
  );

  // require one shell block
  if (runIndex < 0) {
    throw new Error(`workflow run block not found: ${stepName}`);
  }

  const indentation = lines[runIndex].indexOf("run:");
  const script = [];

  // collect the indented shell body
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const leading = line.search(/\S/u);

    // stop at the next workflow key
    if (leading >= 0 && leading <= indentation) {
      break;
    }

    script.push(line.slice(indentation + 2));
  }

  return script.join("\n");
}

// list secret sources
function secretSources(service) {
  return (service.secrets ?? []).map((secret) => secret.source).sort();
}

// reserve one loopback port
async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();

  // require a TCP listener address
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a TCP port");
  }

  listener.close();
  await once(listener, "close");
  return address.port;
}

// wait for a bounded local startup
async function waitForServer(url) {
  // retry only the disposable local server
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);

      // accept any completed HTTP response
      if (response.status > 0) {
        return;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  throw new Error(`server did not start: ${url}`);
}

// verify the production topology
test("production Compose has the exact six-network isolation matrix", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const services = Object.keys(compose.services).sort();
  assert.deepEqual(services, ["api", "cloudflared", "migration", "postgres", "web", "worker"]);
  assert.deepEqual(Object.keys(compose.networks).sort(), [
    "data",
    "edge",
    "map_egress",
    "provider_egress",
    "tunnel_egress",
    "web_api",
  ]);
  assert.equal(compose.networks.edge.internal, true);
  assert.equal(compose.networks.web_api.internal, true);
  assert.equal(compose.networks.data.internal, true);
  assert.notEqual(compose.networks.map_egress.internal, true);
  assert.notEqual(compose.networks.provider_egress.internal, true);
  assert.notEqual(compose.networks.tunnel_egress.internal, true);

  const memberships = Object.fromEntries(
    Object.entries(compose.services).map(([name, service]) => [
      name,
      Object.keys(service.networks).sort(),
    ]),
  );
  assert.deepEqual(memberships, {
    api: ["data", "web_api"],
    cloudflared: ["edge", "tunnel_egress"],
    migration: ["data"],
    postgres: ["data"],
    web: ["edge", "map_egress", "web_api"],
    worker: ["data", "provider_egress"],
  });

  // reject undeclared exposure and dual egress
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.platform, "linux/arm64", `${name} must target ARM64`);
    assert.equal(service.ports, undefined, `${name} must publish no production ports`);
    const networks = Object.keys(service.networks);
    const egressNetworks = networks.filter(
      // count only outbound network boundaries
      (network) => ["map_egress", "provider_egress", "tunnel_egress"].includes(network),
    );
    assert.equal(
      egressNetworks.length <= 1,
      true,
      `${name} must join at most one egress network`,
    );
  }
});

// verify hardening and capacity
test("services are non-root, read-only, bounded, ordered, and healthy", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const hardened = ["api", "cloudflared", "migration", "postgres", "web", "worker"];

  // check every container boundary
  for (const name of hardened) {
    const service = compose.services[name];
    assert.ok(service.user && !/^0(?::0)?$/u.test(service.user), `${name} must be non-root`);
    assert.equal(service.read_only, true, `${name} must use a read-only root filesystem`);
    assert.ok(service.cap_drop.includes("ALL"), `${name} must drop all capabilities`);
    assert.ok(
      service.security_opt.includes("no-new-privileges:true"),
      `${name} must disable privilege escalation`,
    );
    assert.ok(Number(service.pids_limit) > 0, `${name} must cap processes`);
    assert.ok(service.deploy.resources.limits.cpus, `${name} must cap CPU`);
    assert.ok(service.deploy.resources.limits.memory, `${name} must cap memory`);
    assert.ok(Number(service.mem_limit) > 0, `${name} must enforce memory outside Swarm`);
    assert.ok(service.logging.options["max-size"], `${name} must rotate logs`);
    assert.ok(service.stop_grace_period, `${name} must bound shutdown`);
  }

  assert.equal(compose.services.api.user, "10002:10002");
  assert.equal(compose.services.worker.user, "10002:10002");
  assert.equal(compose.services.web.user, "10002:10002");
  assert.equal(compose.services.postgres.user, "999:999");
  assert.equal(compose.services.cloudflared.user, "65532:65532");
  assert.equal(Number(compose.services.postgres.deploy.resources.limits.memory), 536870912);
  assert.equal(Number(compose.services.api.deploy.resources.limits.memory), 268435456);
  assert.equal(Number(compose.services.worker.deploy.resources.limits.memory), 268435456);
  assert.equal(Number(compose.services.web.deploy.resources.limits.memory), 402653184);
  assert.equal(Number(compose.services.cloudflared.deploy.resources.limits.memory), 134217728);
  assert.equal(Number(compose.services.postgres.mem_limit), 536870912);
  assert.equal(Number(compose.services.migration.mem_limit), 268435456);
  assert.equal(Number(compose.services.api.mem_limit), 268435456);
  assert.equal(Number(compose.services.worker.mem_limit), 268435456);
  assert.equal(Number(compose.services.web.mem_limit), 402653184);
  assert.equal(Number(compose.services.cloudflared.mem_limit), 134217728);
  assert.equal(compose.services.migration.depends_on.postgres.condition, "service_healthy");
  assert.equal(compose.services.api.depends_on.migration.condition, "service_completed_successfully");
  assert.equal(compose.services.worker.depends_on.migration.condition, "service_completed_successfully");
  assert.equal(compose.services.web.depends_on.api.condition, "service_healthy");
  assert.equal(compose.services.cloudflared.depends_on.web.condition, "service_healthy");

  // require health probes on steady services
  for (const name of ["api", "cloudflared", "postgres", "web", "worker"]) {
    assert.ok(compose.services[name].healthcheck.test, `${name} must define a health probe`);
  }
});

// verify role-specific secret access
test("database and connector secrets are scoped to least-privilege consumers", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  assert.deepEqual(secretSources(compose.services.api), ["weather_api_password"]);
  assert.deepEqual(secretSources(compose.services.worker), [
    "weather_tempest_api_key",
    "weather_worker_ingest_password",
  ]);
  assert.deepEqual(secretSources(compose.services.migration), ["weather_migration_owner_password"]);
  assert.deepEqual(secretSources(compose.services.cloudflared), ["cloudflare_tunnel_token"]);
  assert.deepEqual(secretSources(compose.services.web), [
    "weather_xweather_client_id",
    "weather_xweather_client_secret",
  ]);
  assert.deepEqual(secretSources(compose.services.postgres), [
    "weather_postgres_admin_password",
    "weather_postgres_api_password",
    "weather_postgres_ingest_password",
    "weather_postgres_owner_password",
    "weather_postgres_training_export_password",
  ]);
  assert.equal(
    compose.services.postgres.environment.POSTGRES_PASSWORD_FILE,
    "/run/secrets/weather_admin_password",
  );

  // isolate the administrator credential
  for (const [name, service] of Object.entries(compose.services)) {
    if (name !== "postgres") {
      assert.equal(secretSources(service).includes("weather_postgres_admin_password"), false);
      assert.equal(
        secretSources(service).includes("weather_postgres_training_export_password"),
        false,
      );
    }
  }

  // exclude operator-only training paths
  for (const serviceName of ["api", "web", "worker", "migration"]) {
    assert.doesNotMatch(
      JSON.stringify(compose.services[serviceName]),
      /weather_training_export|\.weather-data|\.weather-models|model-evidence/u,
    );
  }

  // require distinct host-owned secret sources
  const credentialSecretFiles = Object.entries(compose.secrets)
    .filter(([name]) => name !== "cloudflare_tunnel_token")
    .map(([, secret]) => secret.file);
  assert.equal(credentialSecretFiles.length, 11);
  assert.equal(new Set(credentialSecretFiles).size, credentialSecretFiles.length);

  // reject ignored compose ownership metadata
  for (const service of Object.values(compose.services)) {
    for (const secret of service.secrets ?? []) {
      assert.equal(secret.uid, undefined, `${secret.source} must use host ownership`);
      assert.equal(secret.gid, undefined, `${secret.source} must use host ownership`);
      assert.equal(secret.mode, undefined, `${secret.source} must use host mode`);
    }
  }

  const environments = JSON.stringify(
    Object.fromEntries(
      Object.entries(compose.services).map(([name, service]) => [name, service.environment ?? {}]),
    ),
  );
  assert.doesNotMatch(environments, /PASSWORD=(?!_FILE)|TUNNEL_TOKEN=/u);
  assert.match(environments, /WEATHER_DATABASE_PASSWORD_FILE/u);
});

test("PostgreSQL bootstrap rejects equal administrator and owner credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-postgres-separation-"));
  const bin = join(directory, "bin");
  const admin = join(directory, "admin");
  const owner = join(directory, "owner");
  const api = join(directory, "api");
  const ingest = join(directory, "ingest");
  const trainingExport = join(directory, "training-export");

  try {
    await mkdir(bin);
    await Promise.all([
      writeFile(admin, "shared-password\n"),
      writeFile(owner, "shared-password\n"),
      writeFile(api, "api-password\n"),
      writeFile(ingest, "ingest-password\n"),
      writeFile(trainingExport, "training-export-password\n"),
      writeFile(join(bin, "psql"), "#!/usr/bin/env bash\ncat >/dev/null\n"),
    ]);
    await chmod(join(bin, "psql"), 0o700);
    const result = spawnSync(join(deployRoot, "postgres/010-create-runtime-roles.sh"), [], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WEATHER_ADMIN_PASSWORD_FILE: admin,
        WEATHER_API_PASSWORD_FILE: api,
        WEATHER_INGEST_PASSWORD_FILE: ingest,
        WEATHER_OWNER_PASSWORD_FILE: owner,
        WEATHER_TRAINING_EXPORT_PASSWORD_FILE: trainingExport,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /administrator and owner passwords must differ/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// verify retained administrator reconciliation
test("PostgreSQL reconciles retained administrator credentials before network startup", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const postgres = compose.services.postgres;
  const bootstrap = read("deploy/postgres/010-create-runtime-roles.sh");
  const entrypoint = read("deploy/postgres/postgres-admin-entrypoint.sh");
  const runtimeAcl = read("deploy/postgres/runtime-acl-v2.sql");
  const entrypointMount = postgres.volumes.find(
    (volume) => volume.target === "/usr/local/bin/weather-postgres-entrypoint",
  );
  assert.deepEqual(postgres.entrypoint, ["/usr/local/bin/weather-postgres-entrypoint"]);
  assert.deepEqual(postgres.command, ["postgres"]);
  assert.ok(entrypointMount);
  assert.equal(entrypointMount.read_only, true);
  assert.deepEqual(postgres.healthcheck.test, [
    "CMD",
    "/usr/local/bin/weather-postgres-entrypoint",
    "health",
  ]);
  assert.match(entrypoint, /PG_VERSION/u);
  assert.match(entrypoint, /listen_addresses=''/u);
  assert.match(entrypoint, /pg_ctl[\s\S]*start/u);
  assert.match(entrypoint, /ALTER ROLE postgres WITH LOGIN PASSWORD/u);
  assert.match(entrypoint, /pg_db_role_setting/u);
  assert.match(entrypoint, /IN DATABASE %I RESET ALL/u);
  assert.match(bootstrap, /pg_db_role_setting/u);
  assert.match(bootstrap, /IN DATABASE %I RESET ALL/u);
  assert.match(runtimeAcl, /pg_db_role_setting/u);
  assert.match(runtimeAcl, /IN DATABASE %I RESET ALL/u);
  assert.doesNotMatch(runtimeAcl, /REVOKE ALL ON SCHEMA %I FROM PUBLIC/u);
  assert.match(entrypoint, /exec \/usr\/local\/bin\/docker-entrypoint\.sh/u);
  assert.match(entrypoint, /PGPASSWORD[\s\S]*--host postgres/u);
  assert.doesNotMatch(entrypoint, /printf[^\n]*(?:admin_password|owner_password)/u);
  assert.match(read("deploy/scripts/verify-static.sh"), /deploy\/postgres\/\*\.sh/u);
});

// verify pinned dependencies and durable storage
test("all four production images are immutable digest references", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const images = new Set(Object.values(compose.services).map((service) => service.image));
  assert.equal(images.size, 4);

  // require complete registry references
  for (const image of images) {
    assert.match(image, /^[^@\s]+@sha256:[a-f0-9]{64}$/u);
  }

  assert.match(compose.services.postgres.image, /^postgres@sha256:/u);
  assert.match(compose.services.cloudflared.image, /^cloudflare\/cloudflared@sha256:/u);
  assert.equal(compose.services.api.image, compose.services.migration.image);
  assert.equal(compose.services.api.image, compose.services.worker.image);
  assert.ok(compose.services.cloudflared.command.includes("--token-file"));
  assert.ok(compose.services.cloudflared.command.includes("--no-autoupdate"));
  const postgresData = compose.services.postgres.volumes.find(
    (volume) => volume.target === "/var/lib/postgresql/data",
  );
  assert.equal(postgresData.type, "volume");
  assert.match(postgresData.source, /weather_verify_postgres/u);
  assert.match(read("deploy/compose.yaml"), /\/var\/lib\/weather\/postgres/u);
});

// verify deterministic arm64 resolution
test("image resolver selects one exact linux arm64 manifest", () => {
  const armDigest = `sha256:${"a".repeat(64)}`;
  const update = read("deploy/scripts/update.sh");
  const index = JSON.stringify({
    manifests: [
      { digest: `sha256:${"b".repeat(64)}`, platform: { architecture: "amd64", os: "linux" } },
      { digest: armDigest, platform: { architecture: "arm64", os: "linux", variant: "v8" } },
      { digest: `sha256:${"c".repeat(64)}`, platform: { architecture: "unknown", os: "unknown" } },
    ],
  });
  const result = spawnSync(
    process.execPath,
    [join(scriptsRoot, "resolve-image.mjs"), "registry.example/weather/server:release"],
    { encoding: "utf8", input: index },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `registry.example/weather/server@${armDigest}\n`);

  const descriptor = JSON.stringify({
    Descriptor: {
      digest: armDigest,
      platform: { architecture: "arm64", os: "linux", variant: "v8" },
    },
  });
  const pinned = spawnSync(
    process.execPath,
    [join(scriptsRoot, "resolve-image.mjs"), `registry.example/weather/server@${armDigest}`],
    { encoding: "utf8", input: descriptor },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, `registry.example/weather/server@${armDigest}\n`);
  assert.match(update, /if \[\[ "\$image" == \*@sha256:\* \]\]; then[\s\S]*docker manifest inspect --verbose/u);

  const ambiguous = JSON.stringify({
    manifests: [
      { digest: armDigest, platform: { architecture: "arm64", os: "linux" } },
      { digest: `sha256:${"d".repeat(64)}`, platform: { architecture: "arm64", os: "linux" } },
    ],
  });
  const rejected = spawnSync(
    process.execPath,
    [join(scriptsRoot, "resolve-image.mjs"), "registry.example/weather/server:release"],
    { encoding: "utf8", input: ambiguous },
  );
  assert.notEqual(rejected.status, 0);
});

// verify cross-lane runtime commands
test("container commands match the API, worker, and web runtime contracts", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  assert.deepEqual(compose.services.migration.command, ["node", "deploy/scripts/migrate.mjs"]);
  assert.deepEqual(compose.services.api.command, ["node", "apps/api/dist/main.js"]);
  assert.deepEqual(compose.services.worker.command, ["node", "apps/worker/dist/worker.js"]);
  assert.deepEqual(compose.services.web.command, ["node", "deploy/scripts/web-server.mjs"]);
  assert.equal(compose.services.migration.environment.WEATHER_DATABASE_USER, "weather_owner");
  assert.equal(compose.services.api.environment.WEATHER_MIGRATION_AUTHORIZATION_RELEASE, "");
  assert.equal(
    compose.services.api.environment.WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256,
    "",
  );
  assert.equal(compose.services.worker.environment.WEATHER_MIGRATION_AUTHORIZATION_RELEASE, "");
  assert.equal(
    compose.services.worker.environment.WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256,
    "",
  );

  // keep authorization outside unrelated services
  for (const service of ["migration", "postgres", "web", "cloudflared"]) {
    assert.equal(
      compose.services[service].environment?.WEATHER_MIGRATION_AUTHORIZATION_RELEASE,
      undefined,
    );
    assert.equal(
      compose.services[service].environment?.WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256,
      undefined,
    );
  }
  assert.equal(
    compose.services.migration.environment.WEATHER_SITE_CONFIG_PATH,
    "/opt/weather/config/sites/ballydidean.json",
  );
  assert.equal(compose.services.api.environment.WEATHER_API_PORT, "3001");
  assert.equal(compose.services.worker.environment.WEATHER_DATABASE_USER, "weather_ingest");
  assert.equal(compose.services.web.environment.WEATHER_RELEASE, "2026.08.22-1");
  assert.match(JSON.stringify(compose.services.api.healthcheck.test), /127\.0\.0\.1:3001\/api\/v1\/health/u);
  assert.deepEqual(compose.services.worker.healthcheck.test, [
    "CMD",
    "node",
    "apps/worker/dist/health.js",
  ]);
  assert.equal(
    compose.services.worker.environment.WEATHER_SITE_CONFIG_PATH,
    "/opt/weather/config/sites/ballydidean.json",
  );
  assert.equal(compose.services.migration.volumes, undefined);
  const dockerfile = read("Dockerfile");
  const webServer = read("deploy/scripts/web-server.mjs");
  assert.match(
    dockerfile,
    /COPY --chown=10002:10002 config\/forecast-adjustments config\/forecast-adjustments/u,
  );
  assert.match(dockerfile, /apps\/web\/public apps\/web\/public/u);
  assert.match(dockerfile, /deploy\/scripts\/web-server\.mjs/u);
  assert.match(dockerfile, /deploy\/scripts\/xweather-tile-cache\.mjs/u);
  assert.match(dockerfile, /deploy\/scripts\/xweather-usage-budget\.mjs/u);
  assert.match(webServer, /XWEATHER_FORECAST_FRESHNESS_MS = 60 \* 60 \* 1_000/u);
  assert.match(webServer, /XWEATHER_PROVIDER_DAILY_MAP_UNIT_BUDGET = 300/u);
  assert.match(webServer, /XWEATHER_PROVIDER_MONTHLY_MAP_UNIT_BUDGET = 10_000/u);
  assert.doesNotMatch(webServer, /XWEATHER_MANUAL_REFRESH_COOLDOWN|startForecastRefresh|forecastFootprints|X-Weather-Map-Refresh/u);
});

// verify the reviewed adjustment tree is server-only image material
test("server image bakes only reviewed forecast adjustment config", () => {
  const dockerfile = read("Dockerfile");
  const serverStage = dockerfile
    .split("FROM runtime AS server\n")[1]
    .split("\nFROM runtime AS web\n")[0];
  const webStage = dockerfile.split("\nFROM runtime AS web\n")[1];
  const registry = read("config/forecast-adjustments/ballydidean.json");
  assert.equal(
    registry,
    '{"activeBundle":null,"contractVersion":"forecast-adjustment-registry/v1"}\n',
  );
  assert.match(
    serverStage,
    /packages\/forecast-adjustment\/dist packages\/forecast-adjustment\/dist/u,
  );
  assert.match(
    serverStage,
    /packages\/forecast-adjustment\/package\.json packages\/forecast-adjustment\/package\.json/u,
  );
  assert.match(
    serverStage,
    /config\/forecast-adjustments config\/forecast-adjustments/u,
  );
  assert.doesNotMatch(
    serverStage,
    /\.weather-data|\.weather-models|model-evidence|training_export_password/u,
  );
  assert.doesNotMatch(webStage, /config\/forecast-adjustments|sha256-[a-f0-9]{64}\.json/u);
  assert.match(
    webStage,
    /RUN unlink node_modules\/@weather\/forecast-adjustment/u,
  );

  const compose = renderCompose(["compose.verify.yaml"]);

  // deny operator evidence and keys as API or web mounts
  for (const serviceName of ["api", "web"]) {
    assert.doesNotMatch(
      JSON.stringify(compose.services[serviceName].volumes ?? []),
      /\.weather-data|\.weather-models|model-evidence|training-export|training_export|decrypt|encryption-key/iu,
    );
  }
});

// exercise the static edge and same-origin proxy
test("web edge serves allowlisted assets and bounded read-only upstream proxies", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "weather-web-edge-"));
  const apiPort = await reservePort();
  const xweatherPort = await reservePort();
  const webPort = await reservePort();
  await mkdir(join(fixtureRoot, "apps/web/public/brand"), { recursive: true });
  await mkdir(join(fixtureRoot, "apps/web/public/fonts"), { recursive: true });
  await mkdir(join(fixtureRoot, "apps/web/public"), { recursive: true });
  await mkdir(join(fixtureRoot, "apps/web/dist"), { recursive: true });
  await mkdir(join(fixtureRoot, "config/sites"), { recursive: true });
  await writeFile(
    join(fixtureRoot, "apps/web/public/index.html"),
    '<!doctype html><title>Weather</title><link rel="manifest" href="/manifest.webmanifest">__WEATHER_ROUTE_PRELOAD__<link rel="stylesheet" href="/assets/__WEATHER_ASSET_VERSION__/styles.css"><script type="module" src="/assets/__WEATHER_ASSET_VERSION__/client.js"></script>\n',
  );
  await writeFile(
    join(fixtureRoot, "apps/web/public/manifest.webmanifest"),
    JSON.stringify({ display: "standalone", icons: [], name: "Weather", start_url: "/" }),
  );
  await writeFile(
    join(fixtureRoot, "apps/web/public/service-worker.js"),
    'const release = "__WEATHER_ASSET_VERSION__";\n',
  );
  await writeFile(
    join(fixtureRoot, "config/sites/ballydidean.json"),
    JSON.stringify({ site: { latitude: 47.950429954185445, longitude: -122.42797012608193 } }),
  );
  await writeFile(join(fixtureRoot, "apps/web/public/styles.css"), "body { color: #123; }\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-wide.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-weather-icon-32.png"), "favicon\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-weather-icon-180.png"), "apple-touch\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-weather-icon-192.png"), "icon-192\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-weather-icon-512.png"), "icon-512\n");
  await writeFile(join(fixtureRoot, "apps/web/public/brand/ballydidean-weather-icon-maskable-512.png"), "icon-maskable\n");
  await writeFile(join(fixtureRoot, "apps/web/public/fonts/google-sans-flex-latin.woff2"), "google-sans-flex-font\n");
  await writeFile(join(fixtureRoot, "apps/web/public/fonts/LICENSE-google-sans-flex.txt"), "OFL-1.1\n");
  await writeFile(join(fixtureRoot, "apps/web/public/fonts/material-symbols-rounded-v4.woff2"), "material-symbols-rounded-font\n");
  await writeFile(join(fixtureRoot, "apps/web/public/fonts/LICENSE-material-symbols.txt"), "Apache-2.0\n");
  await writeFile(join(fixtureRoot, "apps/web/dist/client.js"), "export { ready } from './index.js';\n");
  await writeFile(join(fixtureRoot, "apps/web/dist/index.js"), "export { ready } from './units.js';\n");
  await writeFile(join(fixtureRoot, "apps/web/dist/units.js"), "export const ready = true;\n");
  const xweatherClientId = join(fixtureRoot, "xweather-client-id");
  const xweatherClientSecret = join(fixtureRoot, "xweather-client-secret");
  const xweatherUsagePath = join(fixtureRoot, "xweather-usage.json");
  const adminAuthPath = join(fixtureRoot, "admin-auth.json");
  const adminBootstrapTokenPath = join(fixtureRoot, "admin-bootstrap-token");
  const propertySensorLayoutPath = join(fixtureRoot, "property-sensor-layout.json");
  await writeFile(xweatherClientId, "test-client-id\n");
  await writeFile(xweatherClientSecret, "test-client-secret\n");
  await writeFile(adminBootstrapTokenPath, "test-admin-bootstrap-token-with-32-bytes\n");

  // provide one bounded fake API
  const api = createServer((request, response) => {
    const body = JSON.stringify({ method: request.method, path: request.url });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", String(Buffer.byteLength(body)));
    response.end(body);
  });
  api.listen(apiPort, "127.0.0.1");
  await once(api, "listening");

  const xweatherRequests = [];
  let xweatherActive = 0;
  let xweatherMaximumActive = 0;
  const xweatherStartedAt = [];
  const mapPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const xweather = createServer(async (request, response) => {
    xweatherRequests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    xweatherStartedAt.push(Date.now());
    xweatherActive += 1;
    xweatherMaximumActive = Math.max(xweatherMaximumActive, xweatherActive);

    await new Promise(
      // keep concurrent provider requests observable
      (resolveWait) => setTimeout(resolveWait, 20),
    );
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Length", String(mapPng.byteLength));
    response.end(request.method === "HEAD" ? undefined : mapPng);
    xweatherActive -= 1;
  });
  xweather.listen(xweatherPort, "127.0.0.1");
  await once(xweather, "listening");

  const edge = spawn(process.execPath, [join(scriptsRoot, "web-server.mjs")], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PORT: String(webPort),
      WEATHER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      WEATHER_ADMIN_AUTH_PATH: adminAuthPath,
      WEATHER_ADMIN_BOOTSTRAP_TOKEN_PATH: adminBootstrapTokenPath,
      WEATHER_PROPERTY_SENSOR_LAYOUT_PATH: propertySensorLayoutPath,
      WEATHER_RELEASE: "2026.08.25-7",
      WEATHER_XWEATHER_CLIENT_ID_FILE: xweatherClientId,
      WEATHER_XWEATHER_CLIENT_SECRET_FILE: xweatherClientSecret,
      WEATHER_XWEATHER_MAP_ORIGIN: `http://127.0.0.1:${xweatherPort}`,
      WEATHER_XWEATHER_USAGE_PATH: xweatherUsagePath,
    },
    stdio: "ignore",
  });

  try {
    await waitForServer(`http://127.0.0.1:${webPort}/`);
    const home = await fetch(`http://127.0.0.1:${webPort}/`);
    const forecast = await fetch(`http://127.0.0.1:${webPort}/forecast`);
    const logs = await fetch(`http://127.0.0.1:${webPort}/logs`);
    const map = await fetch(`http://127.0.0.1:${webPort}/map`);
    const trends = await fetch(`http://127.0.0.1:${webPort}/trends`);
    const settings = await fetch(`http://127.0.0.1:${webPort}/settings`);
    const remoteAgentsPreview = await fetch(
      `http://127.0.0.1:${webPort}/__rac/browser-device?mode=desktop&location=%2Ftrends%3Fpreview%3D1`,
      { redirect: "manual" },
    );
    const invalidRemoteAgentsPreview = await fetch(
      `http://127.0.0.1:${webPort}/__rac/browser-device?mode=desktop&location=https%3A%2F%2Fevil.example`,
      { redirect: "manual" },
    );
    const adminBeforeBootstrap = await fetch(`http://127.0.0.1:${webPort}/admin`);
    const publicLayoutBefore = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites/ballydidean/property-sensor-layout`);
    const rejectedBootstrap = await fetch(`http://127.0.0.1:${webPort}/api/v1/admin/bootstrap`, {
      body: JSON.stringify({ password: "test-admin-password" }),
      headers: {
        "content-type": "application/json",
        "x-weather-admin-bootstrap": "wrong-bootstrap-token-that-is-long-enough",
      },
      method: "POST",
    });
    const acceptedBootstrap = await fetch(`http://127.0.0.1:${webPort}/api/v1/admin/bootstrap`, {
      body: JSON.stringify({ password: "test-admin-password" }),
      headers: {
        "content-type": "application/json",
        "x-weather-admin-bootstrap": "test-admin-bootstrap-token-with-32-bytes",
      },
      method: "POST",
    });
    const basicAuthorization = `Basic ${Buffer.from("admin:test-admin-password").toString("base64")}`;
    const admin = await fetch(`http://127.0.0.1:${webPort}/admin`, {
      headers: { authorization: basicAuthorization },
    });
    const savedLayout = await fetch(`http://127.0.0.1:${webPort}/api/v1/admin/sites/ballydidean/property-sensor-layout/soil-1`, {
      body: JSON.stringify({
        displayName: "Orchard soil",
        icon: "temperature",
        latitude: 47.9505,
        longitude: -122.4281,
      }),
      headers: {
        authorization: basicAuthorization,
        "content-type": "application/json",
      },
      method: "PUT",
    });
    const publicLayoutAfter = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites/ballydidean/property-sensor-layout`);
    const repeatedBootstrap = await fetch(`http://127.0.0.1:${webPort}/api/v1/admin/bootstrap`, {
      body: JSON.stringify({ password: "replacement-password" }),
      headers: {
        "content-type": "application/json",
        "x-weather-admin-bootstrap": "test-admin-bootstrap-token-with-32-bytes",
      },
      method: "POST",
    });
    const brand = await fetch(`http://127.0.0.1:${webPort}/brand/ballydidean-wide.svg`);
    const favicon = await fetch(`http://127.0.0.1:${webPort}/brand/favicon.svg`);
    const pwaFavicon = await fetch(`http://127.0.0.1:${webPort}/brand/ballydidean-weather-icon-32.png`);
    const appIcon = await fetch(`http://127.0.0.1:${webPort}/brand/ballydidean-weather-icon-512.png`);
    const manifest = await fetch(`http://127.0.0.1:${webPort}/manifest.webmanifest`);
    const serviceWorker = await fetch(`http://127.0.0.1:${webPort}/service-worker.js`);
    const font = await fetch(`http://127.0.0.1:${webPort}/fonts/google-sans-flex-latin.woff2`);
    const fontLicense = await fetch(`http://127.0.0.1:${webPort}/fonts/LICENSE-google-sans-flex.txt`);
    const iconFont = await fetch(`http://127.0.0.1:${webPort}/fonts/material-symbols-rounded-v4.woff2`);
    const iconFontLicense = await fetch(`http://127.0.0.1:${webPort}/fonts/LICENSE-material-symbols.txt`);
    const client = await fetch(`http://127.0.0.1:${webPort}/assets/2026.08.25-7/client.js`);
    const library = await fetch(`http://127.0.0.1:${webPort}/assets/2026.08.25-7/index.js`);
    const units = await fetch(`http://127.0.0.1:${webPort}/assets/2026.08.25-7/units.js`);
    const stylesheet = await fetch(`http://127.0.0.1:${webPort}/assets/2026.08.25-7/styles.css`);
    const staleAsset = await fetch(`http://127.0.0.1:${webPort}/assets/2026.08.25-6/index.js`);
    const unversionedAsset = await fetch(`http://127.0.0.1:${webPort}/index.js`);
    const proxied = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites/ballydidean/current?check=1`);
    const annualTrends = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites/ballydidean/trends`);
    const health = await fetch(`http://127.0.0.1:${webPort}/api/v1/health`);
    const head = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`, { method: "HEAD" });
    const mutation = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`, { method: "POST" });
    const legacy = await fetch(`http://127.0.0.1:${webPort}/sites`);
    const future = await fetch(`http://127.0.0.1:${webPort}/api/v2/sites`);
    const encoded = await fetch(`http://127.0.0.1:${webPort}/api/v1%2fsites`);
    const unknown = await fetch(`http://127.0.0.1:${webPort}/secrets/weather_owner_password`);
    const mapValidTime = new Date(Math.floor(Date.now() / (10 * 60 * 1_000)) * 10 * 60 * 1_000).toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14);
    const mapForecastTime = new Date(Math.ceil(Date.now() / (60 * 60 * 1_000)) * 60 * 60 * 1_000).toISOString().replace(/[-:T.Z]/gu, "").slice(0, 14);
    const frameGeometry = "10/256x168/47.950430,-122.427970.png";
    const weatherTile = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/history/radar/${mapValidTime}/${frameGeometry}`);
    const weatherTileAgain = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/history/radar/${mapValidTime}/${frameGeometry}`);
    const weatherTileHead = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/forecast/wind/${mapForecastTime}/${frameGeometry}`, { method: "HEAD" });
    const refreshMutation = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/forecast/refresh`, { method: "POST" });
    const refreshRead = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/forecast/refresh`);

    const forecastTileAgain = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/forecast/wind/${mapForecastTime}/${frameGeometry}`);
    const invalidWeatherLayer = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/history/temperature/${mapValidTime}/${frameGeometry}`);
    const staleWeatherTile = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/history/radar/20190101000000/${frameGeometry}`);
    const weatherMutation = await fetch(`http://127.0.0.1:${webPort}/maps/xweather/history/radar/${mapValidTime}/${frameGeometry}`, { method: "POST" });
    assert.equal(home.status, 200);
    assert.equal(forecast.status, 200);
    assert.equal(logs.status, 200);
    assert.equal(map.status, 200);
    assert.equal(trends.status, 200);
    assert.equal(settings.status, 200);
    assert.equal(remoteAgentsPreview.status, 302);
    assert.equal(remoteAgentsPreview.headers.get("location"), "/trends?preview=1");
    assert.equal(remoteAgentsPreview.headers.get("cache-control"), "no-store");
    assert.equal(invalidRemoteAgentsPreview.status, 400);
    assert.equal(adminBeforeBootstrap.status, 401);
    assert.match(adminBeforeBootstrap.headers.get("www-authenticate"), /Basic realm=/u);
    assert.deepEqual(await publicLayoutBefore.json(), { data: [] });
    assert.equal(rejectedBootstrap.status, 401);
    assert.equal(acceptedBootstrap.status, 201);
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get("cache-control"), "no-store");
    assert.equal(savedLayout.status, 200);
    assert.deepEqual(await publicLayoutAfter.json(), {
      data: [
        {
          displayName: "Orchard soil",
          icon: "temperature",
          latitude: 47.9505,
          longitude: -122.4281,
          sensorKey: "soil-1",
          updatedAt: (await savedLayout.clone().json()).data.updatedAt,
        },
      ],
    });
    assert.equal(repeatedBootstrap.status, 409);
    const homeBody = await home.text();
    const forecastBody = await forecast.text();
    const logsBody = await logs.text();
    const mapBody = await map.text();
    const trendsBody = await trends.text();
    const settingsBody = await settings.text();
    assert.match(homeBody, /<title>Weather<\/title>/u);
    assert.match(homeBody, /rel="manifest" href="\/manifest\.webmanifest"/u);
    assert.match(homeBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(homeBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.match(logsBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(logsBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.match(mapBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(mapBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.match(forecastBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(forecastBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.match(forecastBody, /rel="preload" as="image"[\s\S]*\/maps\/xweather\/history\/radar\/\d{14}\/10\/256x168\/47\.950430,-122\.427970\.png/u);
    assert.doesNotMatch(homeBody, /\/maps\/xweather\/history\/radar\//u);
    assert.match(trendsBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(trendsBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.match(settingsBody, /\/assets\/2026\.08\.25-7\/styles\.css/u);
    assert.match(settingsBody, /\/assets\/2026\.08\.25-7\/client\.js/u);
    assert.equal(brand.headers.get("content-type"), "image/svg+xml");
    assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
    assert.equal(pwaFavicon.headers.get("content-type"), "image/png");
    assert.equal(appIcon.headers.get("content-type"), "image/png");
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json; charset=utf-8");
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.equal(serviceWorker.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(serviceWorker.headers.get("cache-control"), "no-store");
    assert.match(await serviceWorker.text(), /2026\.08\.25-7/u);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.match(font.headers.get("cache-control"), /immutable/u);
    assert.equal(fontLicense.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(iconFont.headers.get("content-type"), "font/woff2");
    assert.match(iconFont.headers.get("cache-control"), /immutable/u);
    assert.equal(iconFontLicense.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(client.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(library.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(units.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(stylesheet.headers.get("cache-control"), /immutable/u);
    assert.equal(staleAsset.status, 404);
    assert.equal(annualTrends.status, 200);
    assert.equal(annualTrends.headers.get("cache-control"), "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
    assert.equal(unversionedAsset.status, 404);
    assert.deepEqual(await proxied.json(), {
      method: "GET",
      path: "/api/v1/sites/ballydidean/current?check=1",
    });
    assert.match(proxied.headers.get("cache-control"), /max-age=15/u);
    assert.equal(proxied.headers.get("vary"), "Accept");
    assert.deepEqual(await health.json(), { method: "GET", path: "/api/v1/health" });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get("content-length")) > 0);
    assert.equal(mutation.status, 405);
    assert.equal(legacy.status, 404);
    assert.equal(future.status, 404);
    assert.equal(encoded.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(weatherTile.status, 200);
    assert.equal(weatherTile.headers.get("content-type"), "image/png");
    assert.equal(weatherTile.headers.get("x-weather-tile-cache"), "miss");
    assert.match(weatherTile.headers.get("cache-control"), /immutable/u);
    assert.deepEqual(Buffer.from(await weatherTile.arrayBuffer()), mapPng);
    assert.equal(weatherTileAgain.status, 200);
    assert.equal(weatherTileAgain.headers.get("x-weather-tile-cache"), "hit");
    assert.deepEqual(Buffer.from(await weatherTileAgain.arrayBuffer()), mapPng);
    assert.equal(weatherTileHead.status, 200);
    assert.equal(Number(weatherTileHead.headers.get("content-length")), mapPng.byteLength);
    assert.equal(weatherTileHead.headers.get("x-weather-tile-cache"), "miss");
    assert.equal(weatherTileHead.headers.get("cache-control"), "no-store");
    assert.equal(refreshMutation.status, 405);
    assert.equal(refreshRead.status, 404);
    assert.equal(forecastTileAgain.status, 200);
    assert.equal(forecastTileAgain.headers.get("x-weather-tile-cache"), "hit");
    assert.equal(invalidWeatherLayer.status, 404);
    assert.equal(staleWeatherTile.status, 404);
    assert.equal(weatherMutation.status, 405);
    assert.equal(
      xweatherRequests.filter((entry) => entry.endsWith(`/radar/256x168/47.950430,-122.427970,10/${mapValidTime}.png`)).length,
      1,
    );
    assert.equal(
      xweatherRequests.filter((entry) => entry.endsWith(`/fwind-speeds/256x168/47.950430,-122.427970,10/${mapForecastTime}.png`)).length,
      1,
    );
    const usage = JSON.parse(await readFile(xweatherUsagePath, "utf8"));
    assert.equal(usage.dayUnits, 2);
    assert.equal(usage.monthUnits, 2);
    assert.ok(xweatherMaximumActive <= 8);

    // keep every provider start below the shared request-rate ceiling
    for (let index = 1; index < xweatherStartedAt.length; index += 1) {
      assert.ok((xweatherStartedAt[index] ?? 0) - (xweatherStartedAt[index - 1] ?? 0) >= 100);
    }
    assert.match(home.headers.get("content-security-policy"), /default-src 'self'/u);
    // allow tunnel preview embedding
    assert.match(home.headers.get("content-security-policy"), /frame-ancestors \*/u);
    assert.match(
      home.headers.get("content-security-policy"),
      /img-src 'self' blob: data: https:\/\/tile\.openstreetmap\.org https:\/\/basemap\.nationalmap\.gov https:\/\/imagery\.nationalmap\.gov/u,
    );
    assert.equal(
      home.headers.get("referrer-policy"),
      "strict-origin-when-cross-origin",
    );
    assert.equal(home.headers.get("x-frame-options"), null);
  } finally {
    // stop only disposable test processes
    edge.kill("SIGTERM");
    await Promise.race([
      once(edge, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    api.close();
    await once(api, "close");
    xweather.close();
    await once(xweather, "close");
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

// verify the local-only override
test("local Compose binds loopback, preserves isolation, and replaces the connector", () => {
  const compose = renderCompose(["compose.local.yaml"]);

  // preserve application egress boundaries
  assert.equal(compose.networks.edge.internal, true);
  assert.equal(compose.networks.web_api.internal, true);
  assert.equal(compose.networks.data.internal, true);
  assert.notEqual(compose.networks.map_egress.internal, true);
  assert.notEqual(compose.networks.local_postgres_ingress.internal, true);
  assert.notEqual(compose.networks.local_web_ingress.internal, true);
  assert.deepEqual(Object.keys(compose.services.api.networks).sort(), ["data", "web_api"]);
  assert.deepEqual(Object.keys(compose.services.web.networks).sort(), [
    "edge",
    "local_web_ingress",
    "map_egress",
    "web_api",
  ]);
  assert.ok(compose.services.migration.build);
  assert.equal(compose.services.api.build, undefined);
  assert.equal(compose.services.worker.build, undefined);
  const published = [
    ...(compose.services.web.ports ?? []),
    ...(compose.services.postgres.ports ?? []),
  ];

  // require loopback for each local port
  for (const port of published) {
    assert.equal(port.host_ip, "127.0.0.1");
  }

  assert.equal(compose.services.cloudflared.image, "node:24-bookworm-slim");
  assert.deepEqual(secretSources(compose.services.cloudflared), []);
  assert.match(JSON.stringify(compose.services.cloudflared.command), /local tunnel disabled/u);
  const postgresData = compose.services.postgres.volumes.find(
    (volume) => volume.target === "/var/lib/postgresql/data",
  );
  assert.equal(postgresData.type, "volume");
  assert.match(postgresData.source, /weather_local_postgres/u);
});

// verify backup and restore boundaries
test("backup is encrypted and restore is disposable verification only", () => {
  const backup = read("deploy/scripts/backup.sh");
  const backupStream = read("deploy/scripts/backup-stream.sh");
  const common = read("deploy/scripts/common.sh");
  const pullBackup = read("deploy/scripts/pull-backup.sh");
  const restore = read("deploy/scripts/restore.sh");
  assert.match(backup, /pg_dump[\s\S]*--format=custom/u);
  assert.match(backup, /\|[\s\n]*age --recipient/u);
  assert.match(backup, /\.partial/u);
  assert.match(backup, /sha256sum/u);
  assert.match(backup, /chmod 600/u);
  assert.match(backup, /trap cleanup EXIT/u);
  assert.match(backup, /env_value[^\n]*WEATHER_DATABASE_NAME/u);
  assert.doesNotMatch(backup, /--dbname weather\b/u);
  assert.match(backup, /output_dir=\/var\/lib\/weather\/backups/u);
  assert.match(backup, /publication_complete/u);
  assert.match(backup, /sync -f/u);
  assert.doesNotMatch(backup, /pg_dump[^\n]*--file|>[^\n]*\.dump(?:["']|\s)/u);
  assert.match(backupStream, /pg_dump[\s\S]*--format=custom[\s\S]*\|[\s\n]*age --recipient/u);
  assert.match(backupStream, /Progress and errors use standard error/u);
  assert.doesNotMatch(backupStream, /\.dump|output_dir|mktemp/u);
  assert.match(pullBackup, /\$deploy_dir\/backups\/weather-nightly\.dump\.age/u);
  assert.match(pullBackup, /ssh-run\.sh" backup-stream/u);
  assert.match(pullBackup, /pg_restore --list[\s\S]*cat >\/dev\/null/u);
  assert.match(pullBackup, /age --decrypt[\s\S]*\|[\s\n]*verify_archive_stream/u);
  assert.match(pullBackup, /weather\.env/u);
  assert.match(pullBackup, /sha256sum/u);
  assert.match(pullBackup, /mv "\$partial" "\$output"/u);
  assert.match(pullBackup, /trap cleanup EXIT/u);
  assert.match(restore, /only verify mode is supported/u);
  assert.match(restore, /live database replacement and cutover are not supported/u);
  assert.match(restore, /_verify_/u);
  assert.match(restore, /createdb[\s\S]*--owner weather_owner/u);
  assert.match(restore, /age --decrypt[\s\S]*\|[\s\n]*[\s\S]*pg_restore/u);
  assert.match(restore, /server_version[\s\S]*150000/u);
  assert.match(restore, /schema_migrations/u);
  assert.match(restore, /rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication/u);
  assert.match(restore, /dropdb[\s\S]*--if-exists/u);
  assert.match(restore, /verify_runtime_database_acl/u);
  const runtimeAclV1 = read("deploy/postgres/runtime-acl-v1.sql");
  const runtimeAclV2 = read("deploy/postgres/runtime-acl-v2.sql");
  assert.match(runtimeAclV1, /REVOKE ALL ON ALL TABLES[^;]*weather_api, weather_ingest/u);
  assert.match(runtimeAclV1, /GRANT SELECT ON schema_migrations TO weather_ingest/u);
  assert.match(runtimeAclV1, /black_globe_temperature_c[\s\S]*wet_bulb_globe_temperature_c/u);
  assert.match(runtimeAclV1, /wet_bulb_globe_temperature_c[\s\S]*water_level_m/u);
  assert.match(runtimeAclV1, /ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner/u);
  assert.doesNotMatch(runtimeAclV1, /forecast_anchor_records/u);
  assert.match(runtimeAclV2, /source_kind,[\s\S]*capabilities,[\s\S]*cadence_seconds/u);
  assert.match(runtimeAclV2, /GRANT INSERT ON forecast_anchor_records TO weather_ingest/u);
  assert.match(runtimeAclV2, /GRANT SELECT \([\s\S]*content_hash,[\s\S]*revision_count[\s\S]*\) ON forecast_anchor_records TO weather_ingest/u);
  assert.doesNotMatch(runtimeAclV2, /forecast_anchor_records TO weather_api/u);
  assert.match(
    runtimeAclV2,
    /GRANT SELECT ON forecast_runtime_provenance_v1 TO weather_api/u,
  );
  assert.doesNotMatch(
    runtimeAclV2,
    /source_config_fingerprint[\s\S]*ON sources TO weather_api/u,
  );
  assert.match(common, /runtime-acl-v2\.sql/u);
  assert.match(
    common,
    /has_table_privilege\('weather_ingest', 'schema_migrations', 'SELECT'\)/u,
  );
  assert.match(
    common,
    /NOT has_schema_privilege\('weather_ingest', 'public', 'CREATE'\)/u,
  );
  assert.match(
    common,
    /NOT has_table_privilege\('weather_ingest', 'schema_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\)/u,
  );
  assert.doesNotMatch(restore, /ALTER DATABASE[\s\S]*(?:RENAME|OWNER)|mv[\s\S]*postgres/u);
});

// verify the explicit direct-deploy path
test("yolo deployment skips clone, capacity, and deployment-time backup gates", () => {
  const packageJson = JSON.parse(read("package.json"));
  const update = read("deploy/scripts/update.sh");
  const yoloFunction = update
    .split("\nyolo_release() {")[1]
    .split("\n}\n\n# activate one forward release")[0];
  const prepareFunction = update
    .split("prepare_yolo_release() {")[1]
    .split("\n}\n\n# apply one direct release")[0];
  assert.equal(packageJson.scripts["remote:deploy"], "deploy/scripts/ssh-run.sh yolo");
  assert.match(prepareFunction, /resolve_arm64_image/u);
  assert.match(prepareFunction, /compose config --quiet/u);
  assert.match(prepareFunction, /compose pull/u);
  assert.match(yoloFunction, /start_postgres "\$target"/u);
  assert.match(yoloFunction, /compose run --rm migration/u);
  assert.equal(
    yoloFunction.indexOf('start_postgres "$target"') <
      yoloFunction.indexOf("compose run --rm migration"),
    true,
  );
  assert.match(yoloFunction, /start_exact_release/u);
  assert.match(yoloFunction, /record_release_success/u);
  assert.doesNotMatch(
    `${prepareFunction}\n${yoloFunction}`,
    /require_capacity_gate|verify_previous_image_compatibility|backup\.sh|pg_dump|weather_compat_/u,
  );
});

// verify trap-only cleanup portability
test("trap-only cleanup functions suppress supported ShellCheck diagnostics", () => {
  const update = read("deploy/scripts/update.sh");
  assert.match(
    update,
    /  # shellcheck disable=SC2317,SC2329\n  cleanup_compatibility\(\) \{/u,
  );
  assert.match(
    update,
    /  # shellcheck disable=SC2317,SC2329\n  cleanup_initial_activation\(\) \{/u,
  );
});

// verify release-state safety
test("release operations stage, compatibility-check, activate, rollback, and recover Weather only", () => {
  const update = read("deploy/scripts/update.sh");
  const stageCase = update.split("  stage)\n")[1].split("  activate)\n")[0];
  const rollbackCase = update.split("  rollback)\n")[1].split("  recover)\n")[0];
  const rollbackFunction = update
    .split("rollback_release() {")[1]
    .split("\n}\n\n# dispatch one operator action")[0];
  const startRelease = update
    .split("start_release() (")[1]
    .split("\n)\n\n# roll back images")[0];
  assert.match(stageCase, /compose config --quiet/u);
  assert.match(stageCase, /resolve_arm64_image/u);
  assert.match(stageCase, /compose pull/u);
  assert.match(stageCase, /mktemp/u);
  assert.match(stageCase, /trap[\s\S]*EXIT/u);
  assert.match(stageCase, /mv[\s\S]*\$target/u);
  assert.doesNotMatch(stageCase, /compose up|compose down/u);
  const stageControlGate = stageCase.indexOf("require_control_plane_compatibility");
  assert.notEqual(stageControlGate, -1);

  // require compatibility before stage mutation
  for (const mutation of [
    "require_capacity_gate",
    "mkdir -p \"$releases_dir\"",
    "resolve_arm64_image",
    "mktemp",
    "trap 'rm -f",
    "compose pull",
  ]) {
    assert.equal(stageControlGate < stageCase.indexOf(mutation), true, mutation);
  }
  assert.doesNotMatch(
    update.split("# locate one validated release environment")[0],
    /mkdir -p/u,
  );
  const activationControlGate = startRelease.lastIndexOf("require_control_plane_compatibility");
  const activationSchemaRead = startRelease.indexOf(
    'read_optional_release_state "$state_dir/schema-release"',
  );
  const activationSchemaGate = startRelease.indexOf(
    'if [[ "$current" != "$schema_release" && "$target" != "$schema_release" ]]',
  );
  const activationCleanupTrap = startRelease.indexOf("trap cleanup_initial_activation EXIT");
  assert.notEqual(activationSchemaRead, -1);
  assert.equal(activationSchemaRead < activationSchemaGate, true);
  // reject stale targets before every mutation boundary
  for (const mutation of [
    "require_capacity_gate",
    "require_deployment_secrets",
    'start_postgres "$backup_env"',
    "Creating pre-migration encrypted backup",
    'write_private_state "$state_dir/schema-release"',
    "compose run --rm migration",
  ]) {
    assert.equal(activationSchemaGate < startRelease.indexOf(mutation), true, mutation);
  }
  assert.equal(activationSchemaGate < activationCleanupTrap, true);
  assert.equal(activationControlGate < activationCleanupTrap, true);
  assert.equal(activationCleanupTrap < startRelease.indexOf('start_postgres "$backup_env"'), true);
  assert.match(update, /imagetools inspect/u);
  assert.match(update, /weather_compat_/u);
  assert.match(update, /compatibility-provider\.mjs/u);
  assert.match(update, /WEATHER_OPEN_METEO_/u);
  assert.match(update, /WEATHER_DATABASE_NAME="\$candidate"/u);
  assert.match(update, /\/api\/v1\/health/u);
  assert.match(update, /\/api\/v1\/sites/u);
  assert.match(update, /\/current/u);
  assert.match(update, /\/history/u);
  assert.match(update, /apps\/api\/dist\/main\.js/u);
  assert.match(update, /apps\/worker\/dist\/worker\.js --once/u);
  assert.match(update, /state='succeeded'/u);
  assert.match(update, /0009_forecast_anchor_records\.sql/u);
  assert.match(update, /DROP TABLE IF EXISTS forecast_anchor_records/u);
  assert.match(update, /open-meteo-forecast-v4/u);
  assert.match(update, /\/forecast/u);
  assert.match(update, /forecastBody\.data\.length===0/u);
  assert.match(update, /non_compatibility_source_ids/u);
  assert.match(update, /provider_key = 'open-meteo'/u);
  assert.match(update, /provider_key <> 'open-meteo'/u);
  assert.match(update, /UPDATE sources SET active = false/u);
  assert.match(update, /UPDATE sources SET active = true/u);
  assert.doesNotMatch(update, /state='success'/u);
  assert.match(update, /last_committed_at/u);
  assert.match(update, /verify_runtime_database_acl/u);
  assert.match(update, /migration_history_sha256/u);
  assert.match(update, /write_migration_authorization/u);
  assert.match(update, /schema-release/u);
  assert.doesNotMatch(update, /pg_dump[^\n]*--no-acl/u);
  assert.match(update, /Creating pre-migration encrypted backup/u);
  assert.match(update, /compose up -d --remove-orphans --wait/u);
  assert.match(update, /record success only after every health gate/u);
  assert.match(update, /compose down --remove-orphans/u);
  assert.match(rollbackCase, /rollback_release/u);
  assert.match(rollbackFunction, /restore_images/u);
  assert.match(update, /--no-deps --force-recreate --wait postgres/u);
  assert.match(update, /--no-deps --wait api worker web cloudflared/u);
  assert.doesNotMatch(rollbackFunction, /backup\.sh|compose run[^\n]*migration|start_release/u);
  assert.doesNotMatch(
    update,
    /docker (?:system|volume|network) prune|compose down[^\n]*(?:--volumes|\s-v(?:\s|$))/u,
  );
  assert.match(read("deploy/compose.local.yaml"), /WEATHER_LOCAL_CLOUDFLARED_IMAGE/u);
  const composeIntegration = read("deploy/test/compose.integration.test.mjs");
  assert.match(composeIntegration, /"git",[\s\n]*\["archive"/u);
  assert.match(composeIntegration, /baselineServerRelease = "2026\.09\.01-9"/u);
  assert.match(composeIntegration, /weather\.test\.baseline/u);
  assert.match(composeIntegration, /0009_forecast_anchor_records\.sql/u);
  assert.match(composeIntegration, /9999_candidate_contract\.sql/u);
  assert.match(
    read("docs/operations/raspberry-pi.md"),
    /allowlists only the exact installed version 5[\s\S]*rejects any other[\s\S]*mismatch before changing/u,
  );
});

// verify capacity thresholds
test("capacity preflight records every numeric coexistence gate", () => {
  const preflight = read("deploy/scripts/preflight-capacity.sh");
  assert.match(preflight, /sample_seconds=900/u);
  assert.match(preflight, /aarch64/u);
  assert.match(preflight, /cpus >= 4/u);
  assert.match(preflight, /cpus \* 0\.50/u);
  assert.match(preflight, /1792 \* 1024 \* 1024/u);
  assert.match(preflight, /1024 \* 1024/u);
  assert.match(preflight, /3 \* database_bytes \+ 5 \* 1024 \* 1024 \* 1024/u);
  assert.match(preflight, /10 \* 1024 \* 1024 \* 1024/u);
  assert.match(preflight, /4 \* 1024 \* 1024 \* 1024/u);
  assert.match(preflight, /inode_free_percent >= 10/u);
  assert.match(preflight, /df --output=ipcent/u);
  assert.doesNotMatch(preflight, /df -Pi --output=ipcent/u);
  assert.match(preflight, /JSON\.stringify/u);
  assert.match(preflight, /while \(\([\s\S]*done\n\nload15=\$\(awk/u);
});

// verify strict release-state parsing
test("release state fails closed on missing, multiline, and unsafe values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-release-state-"));
  const common = join(scriptsRoot, "common.sh");
  const cases = ["", "2026.08.22-1\nextra\n", "../../escape\n", "latest\n"];

  try {
    // reject every malformed state case
    for (const [index, value] of cases.entries()) {
      const path = join(directory, `invalid-${index}`);
      await writeFile(path, value, { mode: 0o600 });
      const result = spawnSync(
        "bash",
        ["-c", 'source "$1"; read_release_state "$2"', "weather-state-test", common, path],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, `${JSON.stringify(value)} must fail closed`);
    }

    const valid = join(directory, "valid");
    await writeFile(valid, "2026.08.22-1\n", { mode: 0o600 });
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; read_release_state "$2"', "weather-state-test", common, valid],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2026.08.22-1\n");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// verify deterministic compatibility responses
test("compatibility provider serves deterministic weather and air-quality payloads", async () => {
  const providerPort = await reservePort();
  const provider = spawn(process.execPath, [join(scriptsRoot, "compatibility-provider.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(providerPort) },
    stdio: "ignore",
  });

  try {
    await waitForServer(`http://127.0.0.1:${providerPort}/health`);
    const current = await fetch(`http://127.0.0.1:${providerPort}/v1/forecast`);
    const forecast = await fetch(
      `http://127.0.0.1:${providerPort}/v1/forecast?hourly=temperature_2m`,
    );
    const airQuality = await fetch(
      `http://127.0.0.1:${providerPort}/v1/air-quality?hourly=pm2_5`,
    );
    const archive = await fetch(`http://127.0.0.1:${providerPort}/v1/archive`);
    const unknown = await fetch(`http://127.0.0.1:${providerPort}/unknown`);
    assert.equal(current.status, 200);
    assert.equal(forecast.status, 200);
    assert.equal(airQuality.status, 200);
    assert.equal(archive.status, 200);
    assert.equal(unknown.status, 404);
    assert.equal((await current.json()).current.time, "2026-08-22T06:30");
    assert.deepEqual(
      (await forecast.json()).hourly.uv_index,
      [0.2, 0.5, 0.9],
    );
    assert.deepEqual((await airQuality.json()).hourly.pm2_5, [5, 8, 12]);
    assert.deepEqual((await archive.json()).hourly.time, ["2026-08-22T05:00", "2026-08-22T06:00"]);
  } finally {
    // stop only the disposable provider
    provider.kill("SIGTERM");
    await Promise.race([
      once(provider, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
});

// verify isolated operator controls
test("SSH, sudo, and systemd controls use Weather-only absolute identities", () => {
  const ssh = [
    read("deploy/scripts/ssh-dispatch.sh"),
    read("deploy/scripts/ssh-run.sh"),
    read("deploy/scripts/remote-ops.sh"),
    read("deploy/config/ssh_config.example"),
    read("docs/operations/raspberry-pi.md"),
  ].join("\n");
  assert.match(ssh, /SSH_ORIGINAL_COMMAND/u);
  assert.match(ssh, /weather-ssh/u);
  assert.match(ssh, /PasswordAuthentication no/u);
  assert.match(ssh, /PermitRootLogin no/u);
  assert.doesNotMatch(ssh, /\beval\b|sh\s+-c\s+["']?\$SSH_ORIGINAL_COMMAND/u);
  assert.match(read("deploy/sudoers/weather-ops"), /weather-ssh[\s\S]*weather-remote-ops/u);
  const unit = read("deploy/systemd/weather-compose.service");
  assert.match(unit, /WorkingDirectory=\/opt\/weather\/current\/deploy/u);
  assert.match(unit, /--project-name weather/u);
  assert.doesNotMatch(unit, /\.\.\/|actionable/u);
  const backupService = read("deploy/systemd/weather-backup-local.service");
  const backupTimer = read("deploy/systemd/weather-backup-local.timer");
  assert.match(backupService, /ExecStart=%h\/weather\/deploy\/scripts\/pull-backup\.sh/u);
  assert.match(backupTimer, /OnCalendar=\*-\*-\* 02:30:00/u);
  assert.match(backupTimer, /Persistent=true/u);
  assert.match(ssh, /backup-stream/u);
  assert.match(ssh, /yolo/u);
});

// verify no neighboring deployment identity leaked
test("deployment artifacts contain no neighboring identity or production secret", () => {
  const backupsRoot = join(deployRoot, "backups");
  const files = [
    join(repoRoot, "Dockerfile"),
    ...collectFiles(deployRoot),
    ...collectFiles(join(repoRoot, "docs/operations")),
    ...collectFiles(join(repoRoot, ".github/workflows")),
  ];
  const combined = files
    // exclude encrypted runtime payloads
    .filter((path) => !path.startsWith(`${backupsRoot}${sep}`))
    .filter((path) => !path.endsWith("deployment-contract.test.mjs"))
    .map((path) => `# ${relative(repoRoot, path)}\n${readFileSync(path, "utf8")}`)
    .join("\n");
  assert.doesNotMatch(combined, /\/opt\/actionable|\/var\/lib\/actionable|actionable-compose|10001:10001/iu);
  assert.doesNotMatch(combined, /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY|age-secret-key-/iu);
  assert.doesNotMatch(combined, /docker\s+(?:system|volume|network)\s+prune/iu);
  assert.doesNotMatch(combined, /cloudflared\s+tunnel\s+(?:create|delete|route)/iu);
});

// verify release workflow immutability
test("release workflow publishes only immutable ARM64 server and web images", () => {
  const workflow = read(".github/workflows/publish-images.yml");
  assert.match(
    workflow,
    /tags:\n\s+- "20\[0-9\]\[0-9\]\.\[0-9\]\[0-9\]\.\[0-9\]\[0-9\]-\[0-9\]\+"/u,
  );
  assert.doesNotMatch(workflow, /tags:\n\s+- "[^"\n]*\?/u);
  assert.match(workflow, /matrix:[\s\S]*target: \[server, web\]/u);
  assert.match(workflow, /platforms: linux\/arm64/u);
  assert.match(workflow, /push: true/u);
  assert.match(workflow, /imagetools inspect/u);
  assert.match(workflow, /postgres:17\.10-bookworm/u);
  assert.match(workflow, /upload-artifact/u);
  const dependencyJob = workflow.split("  dependency-manifests:\n")[1].split("\n  publish:\n")[0];
  assert.match(dependencyJob, /docker\/setup-qemu-action@v3/u);
  assert.ok(
    dependencyJob.indexOf("docker/setup-qemu-action@v3") <
      dependencyJob.indexOf("docker run --rm --platform linux/arm64"),
  );
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm run test:integration/u);
  assert.match(workflow, /npm run test:e2e/u);
  assert.match(workflow, /npm run test:deploy/u);
  assert.doesNotMatch(workflow, /:latest|ssh-run|update\.sh activate/u);
});

// verify canonical PostgreSQL version output
test("dependency manifest workflow shell enforces ARM64 PostgreSQL 17+ verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-workflow-execution-"));
  const bin = join(directory, "bin");
  const workflow = read(".github/workflows/publish-images.yml");
  const script = workflowRunScript(workflow, "Resolve pinned dependency ARM64 digests").replaceAll(
    "deploy/scripts/resolve-image.mjs",
    join(deployRoot, "scripts/resolve-image.mjs"),
  );

  try {
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
# emulate manifest inspection
if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  printf '{"schemaVersion":2,"manifests":[{"digest":"sha256:%s","platform":{"architecture":"arm64","os":"linux"}}]}\n' "$(printf 'c%.0s' {1..64})"
  exit 0
fi
# emulate ARM64 execution
if [[ "$1" == run ]]; then
  printf '%s\n' "$POSTGRES_VERSION_OUTPUT"
  exit 0
fi
exit 64
`,
    );
    await chmod(join(bin, "docker"), 0o700);
    // execute the exact workflow shell
    const runWithVersion = (versionOutput) =>
      spawnSync("bash", ["-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          POSTGRES_VERSION_OUTPUT: versionOutput,
        },
      });
    const accepted17 = runWithVersion("postgres (PostgreSQL) 17.10 (Debian 17.10-1.pgdg13+1)");
    assert.equal(accepted17.status, 0, accepted17.stderr);
    assert.match(readFileSync(join(directory, "dependency-images.env"), "utf8"), /POSTGRES_IMAGE=.*@sha256:/u);
    assert.match(readFileSync(join(directory, "dependency-images.env"), "utf8"), /CLOUDFLARED_IMAGE=.*@sha256:/u);
    const accepted20 = runWithVersion("postgres (PostgreSQL) 20.1 (Debian 20.1-1.pgdg13+1)");
    assert.equal(accepted20.status, 0, accepted20.stderr);
    const rejected16 = runWithVersion("postgres (PostgreSQL) 16.9 (Debian 16.9-1.pgdg13+1)");
    assert.equal(rejected16.status, 1, rejected16.stderr);
    const rejected100 = runWithVersion("postgres (PostgreSQL) 100.1 (Debian 100.1-1.pgdg13+1)");
    assert.equal(rejected100.status, 1, rejected100.stderr);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("production release reaches the API and deployment status exposes operations evidence", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const status = read("deploy/scripts/status.sh");
  assert.equal(compose.services.api.environment.WEATHER_RELEASE, "2026.08.22-1");
  assert.equal(compose.services.api.environment.WEATHER_VERSION, undefined);
  assert.match(status, /env_value[^\n]*WEATHER_DATABASE_NAME/u);
  assert.doesNotMatch(status, /--dbname weather\b/u);
  assert.match(status, /connector/u);
  assert.match(status, /latest_run/u);
  assert.match(status, /stale_run/u);
  assert.match(status, /chunk_outcome/u);
  assert.match(status, /failure_evidence/u);
});

// verify pull-request quality gates
test("check workflow runs every substantive root and deployment gate", () => {
  const workflow = read(".github/workflows/check.yml");
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm run test:integration/u);
  assert.match(workflow, /npm run test:e2e/u);
  assert.match(workflow, /npm run test:deploy/u);
  assert.match(workflow, /deploy\/scripts\/verify-static\.sh/u);
  assert.match(workflow, /docker build --target server/u);
  assert.match(workflow, /docker build --target web/u);
});

// keep helper coverage visible
test("all deployment shell entrypoints have stable names", () => {
  const names = collectFiles(scriptsRoot)
    .filter((path) => path.endsWith(".sh"))
    .map((path) => basename(path))
    .sort();
  assert.deepEqual(names, [
    "backup-stream.sh",
    "backup.sh",
    "common.sh",
    "forecast-training-export.sh",
    "preflight-capacity.sh",
    "public-stations-backfill.sh",
    "pull-backup.sh",
    "pull-forecast-training-export.sh",
    "remote-ops.sh",
    "restore.sh",
    "ssh-dispatch.sh",
    "ssh-run.sh",
    "status.sh",
    "tempest-backfill.sh",
    "tide-backfill.sh",
    "update.sh",
    "verify-static.sh",
  ]);
});
