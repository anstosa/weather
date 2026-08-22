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
      join(deployRoot, ".env.example"),
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
    image: weather-server:local
    build:
      context: ..
      dockerfile: Dockerfile
      target: server
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
    const identity = join(directory, "age-identity.txt");
    const backups = join(directory, "backups");
    const webPort = await reservePort();
    const postgresPort = await reservePort();
    // isolate shared Docker state
    const projectName = basename(directory).toLowerCase();
    const environment = {
      ...process.env,
      WEATHER_COMPOSE_PROJECT_NAME: projectName,
      WEATHER_LOCAL_POSTGRES_PORT: String(postgresPort),
      WEATHER_LOCAL_WEB_PORT: String(webPort),
    };

    await executeFile("mkdir", ["-p", secretsRoot, backups]);

    try {
      await provisionSecrets(secretsRoot);
      await writeOverride(override, secretsRoot);
      await compose(environment, override, "up", "--detach", "--build", "--wait");
      const firstSites = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`);
      assert.equal(firstSites.status, 200);
      const firstBody = await firstSites.text();

      // prove forbidden network paths stay closed
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "web",
        "node",
        "-e",
        "fetch('http://postgres:5432',{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))",
      );
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "api",
        "node",
        "-e",
        "fetch('https://api.open-meteo.com',{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))",
      );

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
        ["--recipient", recipient, "--output-dir", backups, "--env-file", join(deployRoot, ".env.example")],
        { cwd: repoRoot, env: environment, timeout: 120_000 },
      );
      const archive = (await executeFile("bash", ["-c", 'printf "%s\\n" "$1"/*.dump.age', "weather-backup", backups])).stdout.trim();
      assert.match(archive, /\.dump\.age$/u);
      assert.equal((await readFile(`${archive}.sha256`, "utf8")).includes("weather-"), true);
      await executeFile(
        join(deployRoot, "scripts/restore.sh"),
        ["verify", archive, "--identity", identity, "--env-file", join(deployRoot, ".env.example")],
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
