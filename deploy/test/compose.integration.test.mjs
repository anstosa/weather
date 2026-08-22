import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const deployRoot = join(repoRoot, "deploy");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";

// reserve one loopback port
async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();

  // require one TCP address
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a TCP port");
  }

  listener.close();
  await once(listener, "close");
  return address.port;
}

// run one local compose command
async function compose(environment, override, ...argumentsList) {
  return await executeFile(
    "docker",
    [
      "compose",
      "--project-name",
      environment.WEATHER_COMPOSE_PROJECT_NAME,
      "--env-file",
      environment.WEATHER_ENV_FILE ?? join(deployRoot, ".env.example"),
      "--file",
      join(deployRoot, "compose.yaml"),
      "--file",
      join(deployRoot, "compose.local.yaml"),
      "--file",
      override,
      ...argumentsList,
    ],
    { cwd: repoRoot, env: environment, maxBuffer: 8 * 1024 * 1024, timeout: 600_000 },
  );
}

// execute one protocol-specific container probe
async function executeProbe(environment, override, service, kind, ...values) {
  const scripts = {
    dns: "require('node:dns').promises.lookup(process.argv[1]).catch(()=>process.exit(1))",
    http: "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))",
    tcp: "const socket=require('node:net').createConnection({host:process.argv[1],port:Number(process.argv[2])});const timer=setTimeout(()=>socket.destroy(new Error('timeout')),5000);socket.on('connect',()=>{clearTimeout(timer);socket.end()});socket.on('error',()=>process.exit(1))",
  };
  return await compose(environment, override, "exec", "-T", service, "node", "-e", scripts[kind], ...values);
}

// assert one allowed or denied network path
async function assertProbe(environment, override, expected, service, kind, ...values) {
  let succeeded = false;

  try {
    await executeProbe(environment, override, service, kind, ...values);
    succeeded = true;
  } catch (error) {
    // preserve failures for allowed paths
    if (expected === "allowed") {
      throw error;
    }
  }

  // reject unexpectedly reachable paths
  if (expected === "denied" && succeeded) {
    assert.fail(`${service} ${kind} ${values.join(":")} unexpectedly succeeded`);
  }
}

// create host-owned consumer secret copies
async function provisionSecrets(directory) {
  const owner = "owner-integration-password\n";
  const api = "api-integration-password\n";
  const ingest = "ingest-integration-password\n";
  await Promise.all([
    writeFile(join(directory, "weather_postgres_owner_password"), owner),
    writeFile(join(directory, "weather_migration_owner_password"), owner),
    writeFile(join(directory, "weather_postgres_api_password"), api),
    writeFile(join(directory, "weather_api_password"), api),
    writeFile(join(directory, "weather_postgres_ingest_password"), ingest),
    writeFile(join(directory, "weather_worker_ingest_password"), ingest),
    writeFile(join(directory, "cloudflare_tunnel_token"), "local-disabled-token\n"),
  ]);
  await executeFile(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${directory}:/secrets`,
      "--entrypoint",
      "sh",
      "node:24-bookworm-slim",
      "-c",
      [
        "chown 999:999 /secrets/weather_postgres_*",
        "chown 10002:10002 /secrets/weather_migration_owner_password /secrets/weather_api_password /secrets/weather_worker_ingest_password",
        "chown 65532:65532 /secrets/cloudflare_tunnel_token",
        "chmod 0400 /secrets/*",
      ].join(" && "),
    ],
    { timeout: 120_000 },
  );
}

// write one isolated integration override
async function writeOverride(path, secretsRoot) {
  // render one secret override
  const secret = (name) => `${name}:\n    file: ${join(secretsRoot, name)}\n`;
  await writeFile(
    path,
    `services:
  compatibility-provider:
    image: \${WEATHER_LOCAL_SERVER_IMAGE:-weather-server:local}
    command: [node, deploy/scripts/compatibility-provider.mjs]
    environment:
      PORT: "3002"
    networks: [provider_egress]
  worker:
    environment:
      WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN: http://compatibility-provider:3002
    depends_on:
      compatibility-provider:
        condition: service_started
secrets:
  ${secret("weather_postgres_owner_password")}  ${secret("weather_migration_owner_password")}  ${secret("weather_postgres_api_password")}  ${secret("weather_api_password")}  ${secret("weather_postgres_ingest_password")}  ${secret("weather_worker_ingest_password")}  ${secret("cloudflare_tunnel_token")}`,
  );
}

test(
  "local Compose proves lifecycle, persistence, isolation, secrets, and encrypted restore",
  {
    skip: runIntegration ? false : "set WEATHER_RUN_DEPLOY_INTEGRATION=1",
    timeout: 900_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "weather-compose-integration-"));
    const secretsRoot = join(directory, "secrets");
    const override = join(directory, "compose.override.yaml");
    const envFile = join(directory, "deployment.env");
    const identity = join(directory, "age-identity.txt");
    const backups = join(directory, "backups");
    const webPort = await reservePort();
    const postgresPort = await reservePort();
    // isolate shared Docker state
    const projectName = basename(directory).toLowerCase();
    const environment = {
      ...process.env,
      WEATHER_COMPOSE_PROJECT_NAME: projectName,
      WEATHER_ENV_FILE: envFile,
      WEATHER_LOCAL_POSTGRES_PORT: String(postgresPort),
      WEATHER_LOCAL_SERVER_IMAGE: `${projectName}-server:local`,
      WEATHER_LOCAL_WEB_PORT: String(webPort),
      WEATHER_LOCAL_WEB_IMAGE: `${projectName}-web:local`,
    };

    await executeFile("mkdir", ["-p", secretsRoot, backups]);
    await writeFile(
      envFile,
      (await readFile(join(deployRoot, ".env.example"), "utf8")).replace(
        "WEATHER_DATABASE_NAME=weather",
        "WEATHER_DATABASE_NAME=weather_deploy_test",
      ),
    );

    try {
      await provisionSecrets(secretsRoot);
      await writeOverride(override, secretsRoot);
      await compose(environment, override, "up", "--detach", "--build", "--wait");
      const firstSites = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`);
      assert.equal(firstSites.status, 200);
      const firstBody = await firstSites.text();
      const health = await fetch(`http://127.0.0.1:${webPort}/api/v1/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).data.version, "2026.08.22-1");

      const allowedDns = [
        ["web", "api"],
        ["api", "web"],
        ["api", "postgres"],
        ["worker", "api"],
        ["worker", "postgres"],
        ["worker", "compatibility-provider"],
        ["web", "cloudflared"],
        ["cloudflared", "web"],
      ];
      const deniedDns = [
        ["web", "postgres"],
        ["web", "worker"],
        ["web", "compatibility-provider"],
        ["api", "cloudflared"],
        ["api", "compatibility-provider"],
        ["worker", "web"],
        ["worker", "cloudflared"],
        ["cloudflared", "api"],
        ["cloudflared", "postgres"],
        ["cloudflared", "worker"],
        ["cloudflared", "compatibility-provider"],
      ];

      // prove every declared DNS membership
      for (const [service, target] of allowedDns) {
        await assertProbe(environment, override, "allowed", service, "dns", target);
      }

      // prove every undeclared DNS path
      for (const [service, target] of deniedDns) {
        await assertProbe(environment, override, "denied", service, "dns", target);
      }

      await assertProbe(environment, override, "allowed", "api", "tcp", "postgres", "5432");
      await assertProbe(environment, override, "allowed", "worker", "tcp", "postgres", "5432");
      await assertProbe(environment, override, "denied", "web", "tcp", "postgres", "5432");
      await assertProbe(environment, override, "denied", "cloudflared", "tcp", "postgres", "5432");
      await assertProbe(environment, override, "allowed", "web", "http", "http://api:3001/api/v1/health");
      await assertProbe(environment, override, "allowed", "api", "http", "http://web:3000/");
      await assertProbe(environment, override, "allowed", "worker", "http", "http://api:3001/api/v1/health");
      await assertProbe(environment, override, "allowed", "worker", "http", "http://compatibility-provider:3002/health");
      await assertProbe(environment, override, "allowed", "web", "http", "http://cloudflared:2000/");
      await assertProbe(environment, override, "allowed", "cloudflared", "http", "http://web:3000/");
      await assertProbe(environment, override, "denied", "api", "http", "http://compatibility-provider:3002/health");
      await assertProbe(environment, override, "denied", "worker", "http", "http://web:3000/");
      await assertProbe(environment, override, "denied", "cloudflared", "http", "http://api:3001/api/v1/health");
      await assertProbe(environment, override, "allowed", "worker", "http", "https://example.com/");
      await assertProbe(environment, override, "allowed", "cloudflared", "http", "https://example.com/");
      await assertProbe(environment, override, "denied", "api", "http", "https://example.com/");
      await assertProbe(environment, override, "denied", "web", "http", "https://example.com/");

      const compatibilityEnv = join(directory, "compatibility.env");
      await writeFile(
        compatibilityEnv,
        (await readFile(envFile, "utf8")).replace(
          /^WEATHER_SERVER_IMAGE=.*$/mu,
          `WEATHER_SERVER_IMAGE=${projectName}-server:local`,
        ),
      );
      await executeFile(
        "bash",
        [
          "-c",
          `source "$1"
override=$2
# use the disposable Compose project
compose() {
  local selected_env=\${WEATHER_ENV_FILE:-$3}
  docker compose --project-name "$WEATHER_COMPOSE_PROJECT_NAME" --env-file "$selected_env" \\
    --file "$4" --file "$5" --file "$override" "$@"
}
verify_previous_image_compatibility "$3" "$3"`,
          "weather-compatibility-test",
          join(deployRoot, "scripts/update.sh"),
          override,
          compatibilityEnv,
          join(deployRoot, "compose.yaml"),
          join(deployRoot, "compose.local.yaml"),
        ],
        { cwd: repoRoot, env: environment, timeout: 300_000 },
      );

      const migrationBefore = (
        await compose(
          environment,
          override,
          "exec",
          "-T",
          "postgres",
          "psql",
          "--username",
          "postgres",
          "--dbname",
          "weather_deploy_test",
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT string_agg(name || ':' || checksum, ',' ORDER BY name) FROM schema_migrations",
        )
      ).stdout.trim();
      const controlPlane = (
        await executeFile(
          "bash",
          ["-c", 'source "$1"; control_plane_digest', "weather-control-test", join(deployRoot, "scripts/common.sh")],
          { cwd: repoRoot, env: environment },
        )
      ).stdout.trim();
      const releaseRoot = join(directory, "release-control");
      const releases = join(releaseRoot, "releases");
      const releaseState = join(releaseRoot, "state");
      await executeFile("mkdir", ["-p", releases, releaseState]);
      const digest = `sha256:${"a".repeat(64)}`;

      // create two immutable rollback states
      for (const release of ["2026.08.22-1", "2026.08.22-2"]) {
        await writeFile(
          join(releases, `${release}.env`),
          [
            `WEATHER_RELEASE=${release}`,
            `WEATHER_SERVER_IMAGE=registry.example/weather-server@${digest}`,
            `WEATHER_WEB_IMAGE=registry.example/weather-web@${digest}`,
            `POSTGRES_IMAGE=postgres@${digest}`,
            `CLOUDFLARED_IMAGE=cloudflare/cloudflared@${digest}`,
            "WEATHER_DATABASE_NAME=weather_deploy_test",
            "WEATHER_POSTGRES_DIR=/var/lib/weather/postgres",
            `WEATHER_CONTROL_PLANE_SHA256=${controlPlane}`,
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
      }
      await writeFile(join(releaseState, "current-release"), "2026.08.22-2\n", { mode: 0o600 });
      await writeFile(join(releaseState, "previous-release"), "2026.08.22-1\n", { mode: 0o600 });
      await executeFile(
        "bash",
        [
          "-c",
          `source "$1"
releases_dir=$2
state_dir=$3
override=$4
# bypass host secret ownership
require_deployment_secrets() { :; }
# publish only fixture state
write_active_symlink() { ln -sfn "../releases/$1.env" "$state_dir/active.env"; }
# use the disposable Compose project
compose() {
  local selected_env=\${WEATHER_ENV_FILE:-$5}
  docker compose --project-name "$WEATHER_COMPOSE_PROJECT_NAME" --env-file "$selected_env" \\
    --file "$6" --file "$7" --file "$override" "$@"
}
rollback_release`,
          "weather-rollback-integration",
          join(deployRoot, "scripts/update.sh"),
          releases,
          releaseState,
          override,
          envFile,
          join(deployRoot, "compose.yaml"),
          join(deployRoot, "compose.local.yaml"),
        ],
        { cwd: repoRoot, env: environment, timeout: 300_000 },
      );
      assert.equal(await readFile(join(releaseState, "current-release"), "utf8"), "2026.08.22-1\n");
      const migrationAfter = (
        await compose(
          environment,
          override,
          "exec",
          "-T",
          "postgres",
          "psql",
          "--username",
          "postgres",
          "--dbname",
          "weather_deploy_test",
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT string_agg(name || ':' || checksum, ',' ORDER BY name) FROM schema_migrations",
        )
      ).stdout.trim();
      assert.equal(migrationAfter, migrationBefore);

      // prove consumer secret isolation
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "api",
        "node",
        "-e",
        "require('node:fs').accessSync('/run/secrets/weather_api_password')",
      );
      await assert.rejects(
        compose(
          environment,
          override,
          "exec",
          "-T",
          "api",
          "node",
          "-e",
          "require('node:fs').accessSync('/run/secrets/weather_ingest_password')",
        ),
      );

      // prove named-volume persistence across recreation
      await compose(environment, override, "down", "--remove-orphans");
      await compose(environment, override, "up", "--detach", "--build", "--wait");
      const secondSites = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`);
      assert.equal(secondSites.status, 200);
      assert.equal(await secondSites.text(), firstBody);

      await executeFile("age-keygen", ["--output", identity]);
      const recipient = (await executeFile("age-keygen", ["-y", identity])).stdout.trim();
      await executeFile(
        join(deployRoot, "scripts/backup.sh"),
        ["--recipient", recipient, "--output-dir", backups, "--env-file", envFile],
        { cwd: repoRoot, env: environment, timeout: 120_000 },
      );
      const archive = (await executeFile("bash", ["-c", 'printf "%s\\n" "$1"/*.dump.age', "weather-backup", backups])).stdout.trim();
      assert.match(archive, /\.dump\.age$/u);
      assert.equal((await readFile(`${archive}.sha256`, "utf8")).includes("weather-"), true);
      await executeFile(
        join(deployRoot, "scripts/restore.sh"),
        ["verify", archive, "--identity", identity, "--env-file", envFile],
        { cwd: repoRoot, env: environment, timeout: 120_000 },
      );
    } finally {
      await compose(environment, override, "down", "--volumes", "--remove-orphans").catch(
        () => undefined,
      );
      await rm(directory, { force: true, recursive: true });
    }
  },
);
