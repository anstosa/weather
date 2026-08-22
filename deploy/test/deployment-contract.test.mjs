import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
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
test("production Compose has the exact five-network isolation matrix", () => {
  const compose = renderCompose(["compose.verify.yaml"]);
  const services = Object.keys(compose.services).sort();
  assert.deepEqual(services, ["api", "cloudflared", "migration", "postgres", "web", "worker"]);
  assert.deepEqual(Object.keys(compose.networks).sort(), [
    "data",
    "edge",
    "provider_egress",
    "tunnel_egress",
    "web_api",
  ]);
  assert.equal(compose.networks.edge.internal, true);
  assert.equal(compose.networks.web_api.internal, true);
  assert.equal(compose.networks.data.internal, true);
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
    web: ["edge", "web_api"],
    worker: ["data", "provider_egress"],
  });

  // reject undeclared exposure and dual egress
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.platform, "linux/arm64", `${name} must target ARM64`);
    assert.equal(service.ports, undefined, `${name} must publish no production ports`);
    const networks = Object.keys(service.networks);
    assert.equal(
      networks.includes("provider_egress") && networks.includes("tunnel_egress"),
      false,
      `${name} must not join both egress networks`,
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
  assert.equal(Number(compose.services.web.deploy.resources.limits.memory), 134217728);
  assert.equal(Number(compose.services.cloudflared.deploy.resources.limits.memory), 134217728);
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
  assert.deepEqual(secretSources(compose.services.worker), ["weather_worker_ingest_password"]);
  assert.deepEqual(secretSources(compose.services.migration), ["weather_migration_owner_password"]);
  assert.deepEqual(secretSources(compose.services.cloudflared), ["cloudflare_tunnel_token"]);
  assert.deepEqual(secretSources(compose.services.web), []);
  assert.deepEqual(secretSources(compose.services.postgres), [
    "weather_postgres_api_password",
    "weather_postgres_ingest_password",
    "weather_postgres_owner_password",
  ]);

  // require distinct host-owned secret sources
  const passwordSecretFiles = Object.entries(compose.secrets)
    .filter(([name]) => name !== "cloudflare_tunnel_token")
    .map(([, secret]) => secret.file);
  assert.equal(passwordSecretFiles.length, 6);
  assert.equal(new Set(passwordSecretFiles).size, passwordSecretFiles.length);

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
  assert.equal(
    compose.services.migration.environment.WEATHER_SITE_CONFIG_PATH,
    "/opt/weather/config/sites/ballydidean.json",
  );
  assert.equal(compose.services.api.environment.WEATHER_API_PORT, "3001");
  assert.equal(compose.services.worker.environment.WEATHER_DATABASE_USER, "weather_ingest");
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
  assert.match(dockerfile, /COPY --chown=10002:10002 config config/u);
  assert.match(dockerfile, /apps\/web\/public apps\/web\/public/u);
  assert.match(dockerfile, /deploy\/scripts\/web-server\.mjs/u);
});

// exercise the static edge and same-origin proxy
test("web edge serves allowlisted assets and a bounded read-only API proxy", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "weather-web-edge-"));
  const apiPort = await reservePort();
  const webPort = await reservePort();
  await mkdir(join(fixtureRoot, "apps/web/public"), { recursive: true });
  await mkdir(join(fixtureRoot, "apps/web/dist"), { recursive: true });
  await writeFile(join(fixtureRoot, "apps/web/public/index.html"), "<!doctype html><title>Weather</title>\n");
  await writeFile(join(fixtureRoot, "apps/web/public/styles.css"), "body { color: #123; }\n");
  await writeFile(join(fixtureRoot, "apps/web/dist/client.js"), "export { ready } from './index.js';\n");
  await writeFile(join(fixtureRoot, "apps/web/dist/index.js"), "export const ready = true;\n");

  // provide one bounded fake API
  const api = createServer((request, response) => {
    const body = JSON.stringify({ method: request.method, path: request.url });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", String(Buffer.byteLength(body)));
    response.end(body);
  });
  api.listen(apiPort, "127.0.0.1");
  await once(api, "listening");

  const edge = spawn(process.execPath, [join(scriptsRoot, "web-server.mjs")], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PORT: String(webPort),
      WEATHER_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
    stdio: "ignore",
  });

  try {
    await waitForServer(`http://127.0.0.1:${webPort}/`);
    const home = await fetch(`http://127.0.0.1:${webPort}/`);
    const client = await fetch(`http://127.0.0.1:${webPort}/client.js`);
    const library = await fetch(`http://127.0.0.1:${webPort}/index.js`);
    const proxied = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites/ballydidean/current?check=1`);
    const health = await fetch(`http://127.0.0.1:${webPort}/api/v1/health`);
    const head = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`, { method: "HEAD" });
    const mutation = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`, { method: "POST" });
    const legacy = await fetch(`http://127.0.0.1:${webPort}/sites`);
    const future = await fetch(`http://127.0.0.1:${webPort}/api/v2/sites`);
    const encoded = await fetch(`http://127.0.0.1:${webPort}/api/v1%2fsites`);
    const unknown = await fetch(`http://127.0.0.1:${webPort}/secrets/weather_owner_password`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>Weather<\/title>/u);
    assert.equal(client.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(library.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.deepEqual(await proxied.json(), {
      method: "GET",
      path: "/api/v1/sites/ballydidean/current?check=1",
    });
    assert.deepEqual(await health.json(), { method: "GET", path: "/api/v1/health" });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get("content-length")) > 0);
    assert.equal(mutation.status, 405);
    assert.equal(legacy.status, 404);
    assert.equal(future.status, 404);
    assert.equal(encoded.status, 404);
    assert.equal(unknown.status, 404);
    assert.match(home.headers.get("content-security-policy"), /default-src 'self'/u);
  } finally {
    // stop only disposable test processes
    edge.kill("SIGTERM");
    await Promise.race([
      once(edge, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    api.close();
    await once(api, "close");
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
  assert.notEqual(compose.networks.local_postgres_ingress.internal, true);
  assert.notEqual(compose.networks.local_web_ingress.internal, true);
  assert.deepEqual(Object.keys(compose.services.api.networks).sort(), ["data", "web_api"]);
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
  assert.match(restore, /only verify mode is supported/u);
  assert.match(restore, /live database replacement and cutover are not supported/u);
  assert.match(restore, /weather_verify_/u);
  assert.match(restore, /createdb[\s\S]*--owner weather_owner/u);
  assert.match(restore, /age --decrypt[\s\S]*\|[\s\n]*[\s\S]*pg_restore/u);
  assert.match(restore, /server_version[\s\S]*150000/u);
  assert.match(restore, /schema_migrations/u);
  assert.match(restore, /rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication/u);
  assert.match(restore, /dropdb[\s\S]*--if-exists/u);
  assert.match(restore, /verify_runtime_database_acl/u);
  assert.doesNotMatch(restore, /ALTER DATABASE[\s\S]*(?:RENAME|OWNER)|mv[\s\S]*postgres/u);
});

// verify release-state safety
test("release operations stage, compatibility-check, activate, rollback, and recover Weather only", () => {
  const update = read("deploy/scripts/update.sh");
  const stageCase = update.split("  stage)\n")[1].split("  activate)\n")[0];
  const rollbackCase = update.split("  rollback)\n")[1].split("  recover)\n")[0];
  const rollbackFunction = update
    .split("rollback_release() {")[1]
    .split("\n}\n\n# dispatch one operator action")[0];
  assert.match(stageCase, /compose config --quiet/u);
  assert.match(stageCase, /resolve_arm64_image/u);
  assert.match(stageCase, /compose pull/u);
  assert.match(stageCase, /mktemp/u);
  assert.match(stageCase, /trap[\s\S]*EXIT/u);
  assert.match(stageCase, /mv[\s\S]*\$target/u);
  assert.doesNotMatch(stageCase, /compose up|compose down/u);
  assert.match(update, /imagetools inspect/u);
  assert.match(update, /weather_compat_/u);
  assert.match(update, /compatibility-provider\.mjs/u);
  assert.match(update, /WEATHER_OPEN_METEO_/u);
  assert.match(update, /WEATHER_DATABASE_NAME="\$candidate"/u);
  assert.match(update, /\/api\/v1\/health/u);
  assert.match(update, /\/api\/v1\/sites/u);
  assert.match(update, /apps\/api\/dist\/main\.js/u);
  assert.match(update, /apps\/worker\/dist\/worker\.js --once/u);
  assert.match(update, /state='succeeded'/u);
  assert.doesNotMatch(update, /state='success'/u);
  assert.match(update, /last_committed_at/u);
  assert.match(update, /verify_runtime_database_acl/u);
  assert.doesNotMatch(update, /pg_dump[^\n]*--no-acl/u);
  assert.match(update, /Creating pre-migration encrypted backup/u);
  assert.match(update, /compose up -d --remove-orphans --wait/u);
  assert.match(update, /record success only after every health gate/u);
  assert.match(update, /compose down --remove-orphans/u);
  assert.match(rollbackCase, /rollback_release/u);
  assert.match(rollbackFunction, /restore_images/u);
  assert.match(update, /--no-deps --wait[\s\\\n]*postgres api worker web cloudflared/u);
  assert.doesNotMatch(rollbackFunction, /backup\.sh|compose run[^\n]*migration|start_release/u);
  assert.doesNotMatch(
    update,
    /docker (?:system|volume|network) prune|compose down[^\n]*(?:--volumes|\s-v(?:\s|$))/u,
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
test("compatibility provider serves deterministic current and archive payloads", async () => {
  const providerPort = await reservePort();
  const provider = spawn(process.execPath, [join(scriptsRoot, "compatibility-provider.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(providerPort) },
    stdio: "ignore",
  });

  try {
    await waitForServer(`http://127.0.0.1:${providerPort}/health`);
    const current = await fetch(`http://127.0.0.1:${providerPort}/v1/forecast`);
    const archive = await fetch(`http://127.0.0.1:${providerPort}/v1/archive`);
    const unknown = await fetch(`http://127.0.0.1:${providerPort}/unknown`);
    assert.equal(current.status, 200);
    assert.equal(archive.status, 200);
    assert.equal(unknown.status, 404);
    assert.equal((await current.json()).current.time, "2026-08-22T06:30");
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
});

// verify no neighboring deployment identity leaked
test("deployment artifacts contain no neighboring identity or production secret", () => {
  const files = [
    join(repoRoot, "Dockerfile"),
    ...collectFiles(deployRoot),
    ...collectFiles(join(repoRoot, "docs/operations")),
    ...collectFiles(join(repoRoot, ".github/workflows")),
  ];
  const combined = files
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
  assert.match(workflow, /tags:[\s\S]*20\?\?\.\?\?\.\?\?-\*/u);
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

test("production release reaches the API and deployment status exposes operations evidence", () => {
  const compose = parseCompose("deploy/compose.yaml");
  const status = read("deploy/scripts/status.sh");
  assert.equal(compose.services.api.environment.WEATHER_RELEASE, "${WEATHER_RELEASE:?set WEATHER_RELEASE}");
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
    "backup.sh",
    "common.sh",
    "preflight-capacity.sh",
    "remote-ops.sh",
    "restore.sh",
    "ssh-dispatch.sh",
    "ssh-run.sh",
    "status.sh",
    "update.sh",
    "verify-static.sh",
  ]);
});
