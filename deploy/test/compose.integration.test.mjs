import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const deployRoot = join(repoRoot, "deploy");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";
const baselineServerRelease = "2026.09.01-9";
const expectedTrainingExportAuthority = {
  databasePrivileges: ["CONNECT"],
  executableFunctions: [],
  relationPrivileges: [
    "public.forecast_training_export_manifest_v1:SELECT",
    "public.forecast_training_export_rows_v1:SELECT",
  ],
  role: {
    bypassRls: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canLogin: true,
    configuration: ["default_transaction_read_only=on"],
    databaseSettings: [],
    inherit: false,
    memberships: [],
    replication: false,
    superuser: false,
  },
  schemaPrivileges: ["public:USAGE"],
  sequencePrivileges: [],
};

// enumerate exact export authority
const trainingExportAuthoritySql = `
  SELECT json_build_object(
    'databasePrivileges', ARRAY(
      SELECT privilege.name
      FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMP']) privilege(name)
      WHERE has_database_privilege(
        'weather_training_export', current_database(), privilege.name
      )
      ORDER BY privilege.name
    ),
    'schemaPrivileges', ARRAY(
      SELECT format('%s:%s', namespace.nspname, privilege.name)
      FROM pg_namespace namespace
      CROSS JOIN LATERAL unnest(ARRAY['CREATE', 'USAGE']) privilege(name)
      WHERE namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
        AND has_schema_privilege(
          'weather_training_export', namespace.oid, privilege.name
        )
      ORDER BY namespace.nspname, privilege.name
    ),
    'relationPrivileges', ARRAY(
      SELECT format(
        '%s.%s:%s', namespace.nspname, relation.relname, privilege.name
      )
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL unnest(ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]) privilege(name)
      WHERE namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(
          'weather_training_export', relation.oid, privilege.name
        )
      ORDER BY namespace.nspname, relation.relname, privilege.name
    ),
    'sequencePrivileges', ARRAY(
      SELECT format(
        '%s.%s:%s', namespace.nspname, sequence.relname, privilege.name
      )
      FROM pg_class sequence
      JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
      CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) privilege(name)
      WHERE namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
        AND sequence.relkind = 'S'
        AND has_sequence_privilege(
          'weather_training_export', sequence.oid, privilege.name
        )
      ORDER BY namespace.nspname, sequence.relname, privilege.name
    ),
    'executableFunctions', ARRAY(
      SELECT procedure.oid::regprocedure::text
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg_%'
        AND procedure.prosecdef
        AND has_function_privilege(
          'weather_training_export', procedure.oid, 'EXECUTE'
        )
      ORDER BY procedure.oid::regprocedure::text
    ),
    'role', (
      SELECT json_build_object(
        'canLogin', role.rolcanlogin,
        'inherit', role.rolinherit,
        'superuser', role.rolsuper,
        'canCreateDatabase', role.rolcreatedb,
        'canCreateRole', role.rolcreaterole,
        'replication', role.rolreplication,
        'bypassRls', role.rolbypassrls,
        'configuration', role.rolconfig,
        'databaseSettings', ARRAY(
          SELECT format(
            '%s:%s', database.datname, array_to_string(setting.setconfig, ',')
          )
          FROM pg_db_role_setting setting
          JOIN pg_database database ON database.oid = setting.setdatabase
          WHERE setting.setrole = role.oid
          ORDER BY database.datname
        ),
        'memberships', ARRAY(
          SELECT granted.rolname
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          WHERE membership.member = role.oid
          ORDER BY granted.rolname
        )
      )
      FROM pg_roles role
      WHERE role.rolname = 'weather_training_export'
    )
  )
`;

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

// build one distinct local release image
async function buildReleaseImage(directory, baseImage, targetImage, release, migrationSql) {
  const imageKey = targetImage.replaceAll(/[^a-z0-9]+/giu, "-");
  const buildRoot = join(directory, `image-${release}-${imageKey}`);
  const dockerfile = join(buildRoot, "Dockerfile");
  await executeFile("mkdir", ["-p", buildRoot]);
  const migrationName = "9999_candidate_contract.sql";
  let dockerfileBody = `FROM ${baseImage}\nLABEL weather.test.release=${release}\n`;

  // add only the candidate migration contract
  if (migrationSql !== undefined) {
    await writeFile(join(buildRoot, migrationName), migrationSql);
    dockerfileBody += `USER root\nCOPY --chown=10002:10002 ${migrationName} /opt/weather/packages/database/migrations/${migrationName}\nUSER 10002:10002\n`;
  }

  await writeFile(dockerfile, dockerfileBody);
  await executeFile(
    "docker",
    ["build", "--quiet", "--file", dockerfile, "--tag", targetImage, buildRoot],
    { cwd: repoRoot, timeout: 120_000 },
  );
}

// build the exact pre-adjustment production server image
async function buildBaselineServerImage(directory, targetImage) {
  const buildRoot = join(directory, "baseline-server");
  const archivePath = join(directory, "baseline-server.tar");
  const revision = (
    await executeFile("git", ["rev-parse", `${baselineServerRelease}^{commit}`], {
      cwd: repoRoot,
      timeout: 30_000,
    })
  ).stdout.trim();
  await mkdir(buildRoot);
  await executeFile(
    "git",
    ["archive", "--format=tar", "--output", archivePath, revision],
    { cwd: repoRoot, timeout: 30_000 },
  );
  await executeFile(
    "tar",
    ["--extract", "--file", archivePath, "--directory", buildRoot],
    { timeout: 30_000 },
  );
  await executeFile(
    "docker",
    [
      "build",
      "--quiet",
      "--target",
      "server",
      "--label",
      `weather.test.baseline=${revision}`,
      "--tag",
      targetImage,
      buildRoot,
    ],
    { cwd: repoRoot, timeout: 300_000 },
  );
  return revision;
}

// read one local image identity
async function imageId(image) {
  return (
    await executeFile("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      timeout: 30_000,
    })
  ).stdout.trim();
}

// read one committed baseline label
async function imageLabel(image, label) {
  return (
    await executeFile(
      "docker",
      ["image", "inspect", "--format", `{{ index .Config.Labels "${label}" }}`, image],
      { timeout: 30_000 },
    )
  ).stdout.trim();
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

// read one normalized export authority snapshot
async function trainingExportAuthority(environment, override, databaseName) {
  const snapshot = await compose(
    environment,
    override,
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    "postgres",
    "--dbname",
    databaseName,
    "--tuples-only",
    "--no-align",
    "--command",
    trainingExportAuthoritySql,
  );
  return JSON.parse(snapshot.stdout.trim());
}

// execute one protocol-specific container probe
async function executeProbe(environment, override, service, kind, ...values) {
  // use tools available in PostgreSQL
  if (service === "postgres" && kind === "dns") {
    return await compose(environment, override, "exec", "-T", service, "getent", "hosts", ...values);
  }

  // use a protocol-correct PostgreSQL TCP probe
  if (service === "postgres" && kind === "tcp") {
    return await compose(
      environment,
      override,
      "exec",
      "-T",
      service,
      "bash",
      "-c",
      'timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2"',
      "weather-network-probe",
      ...values,
    );
  }

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
  const admin = "admin-integration-password\n";
  const owner = "owner-integration-password\n";
  const api = "api-integration-password\n";
  const ingest = "ingest-integration-password\n";
  await Promise.all([
    writeFile(join(directory, "weather_postgres_admin_password"), admin),
    writeFile(join(directory, "weather_postgres_owner_password"), owner),
    writeFile(join(directory, "weather_migration_owner_password"), owner),
    writeFile(join(directory, "weather_postgres_api_password"), api),
    writeFile(join(directory, "weather_api_password"), api),
    writeFile(join(directory, "weather_postgres_ingest_password"), ingest),
    writeFile(join(directory, "weather_postgres_training_export_password"), "training-export-integration-password\n"),
    writeFile(join(directory, "weather_worker_ingest_password"), ingest),
    writeFile(join(directory, "weather_tempest_api_key"), "test-tempest-api-key\n"),
    writeFile(join(directory, "weather_xweather_client_id"), "test-xweather-client-id\n"),
    writeFile(join(directory, "weather_xweather_client_secret"), "test-xweather-client-secret\n"),
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
        "chown 999:999 /secrets/weather_postgres_admin_password",
        "chown 999:999 /secrets/weather_postgres_*",
        "chown 10002:10002 /secrets/weather_migration_owner_password /secrets/weather_api_password /secrets/weather_worker_ingest_password /secrets/weather_tempest_api_key /secrets/weather_xweather_client_id /secrets/weather_xweather_client_secret",
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
  migration-network-probe:
    image: \${WEATHER_LOCAL_SERVER_IMAGE:-weather-server:local}
    command: [node, -e, "require('node:http').createServer((_,response)=>response.end('migration network probe')).listen(3004,'0.0.0.0')"]
    networks: [data]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3004/').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 2s
      retries: 15
  provider-egress-probe:
    image: node:24-bookworm-slim
    command: [node, -e, "require('node:http').createServer((_,response)=>response.end('provider egress probe')).listen(3003,'0.0.0.0')"]
    networks: [provider_egress]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3003/').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 2s
      retries: 15
  tunnel-egress-probe:
    image: node:24-bookworm-slim
    command: [node, -e, "require('node:http').createServer((_,response)=>response.end('tunnel egress probe')).listen(3005,'0.0.0.0')"]
    networks: [tunnel_egress]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3005/').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 2s
      retries: 15
  worker:
    environment:
      WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN: http://compatibility-provider:3002
    depends_on:
      compatibility-provider:
        condition: service_started
secrets:
  ${secret("weather_postgres_admin_password")}  ${secret("weather_postgres_owner_password")}  ${secret("weather_migration_owner_password")}  ${secret("weather_postgres_api_password")}  ${secret("weather_api_password")}  ${secret("weather_postgres_ingest_password")}  ${secret("weather_postgres_training_export_password")}  ${secret("weather_worker_ingest_password")}  ${secret("weather_tempest_api_key")}  ${secret("weather_xweather_client_id")}  ${secret("weather_xweather_client_secret")}  ${secret("cloudflare_tunnel_token")}`,
  );
}

test(
  "local Compose proves lifecycle, persistence, isolation, secrets, and encrypted restore",
  {
    skip: runIntegration ? false : "set WEATHER_RUN_DEPLOY_INTEGRATION=1",
    timeout: 1_200_000,
  },
  // exercise lifecycle behavior
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
      WEATHER_LOCAL_CLOUDFLARED_IMAGE: "node:24-bookworm-slim",
      WEATHER_LOCAL_POSTGRES_IMAGE: "postgres:17.10-bookworm",
      WEATHER_LOCAL_POSTGRES_PORT: String(postgresPort),
      WEATHER_LOCAL_SERVER_IMAGE: `${projectName}-server:local`,
      WEATHER_LOCAL_WEB_PORT: String(webPort),
      WEATHER_LOCAL_WEB_IMAGE: `${projectName}-web:local`,
    };
    const previousServerImage = `${projectName}-server:2026.08.22-1`;
    const targetServerImage = `${projectName}-server:2026.08.22-3`;
    const previousWebImage = `${projectName}-web:2026.08.22-1`;
    const targetWebImage = `${projectName}-web:2026.08.22-3`;
    const previousPostgresImage = `${projectName}-postgres:2026.08.22-1`;
    const targetPostgresImage = `${projectName}-postgres:2026.08.22-3`;
    const previousCloudflaredImage = `${projectName}-cloudflared:2026.08.22-1`;
    const targetCloudflaredImage = `${projectName}-cloudflared:2026.08.22-3`;
    const disposableImages = [
      environment.WEATHER_LOCAL_SERVER_IMAGE,
      environment.WEATHER_LOCAL_WEB_IMAGE,
      previousServerImage,
      targetServerImage,
      previousWebImage,
      targetWebImage,
      previousPostgresImage,
      targetPostgresImage,
      previousCloudflaredImage,
      targetCloudflaredImage,
    ];

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
      const baselineRevision = await buildBaselineServerImage(directory, previousServerImage);
      await buildReleaseImage(
        directory,
        environment.WEATHER_LOCAL_SERVER_IMAGE,
        targetServerImage,
        "2026.08.22-3",
        "SELECT 1;\n",
      );
      await buildReleaseImage(directory, environment.WEATHER_LOCAL_WEB_IMAGE, previousWebImage, "2026.08.22-1");
      await buildReleaseImage(directory, environment.WEATHER_LOCAL_WEB_IMAGE, targetWebImage, "2026.08.22-3");
      await buildReleaseImage(
        directory,
        environment.WEATHER_LOCAL_POSTGRES_IMAGE,
        previousPostgresImage,
        "2026.08.22-1",
      );
      await buildReleaseImage(
        directory,
        environment.WEATHER_LOCAL_POSTGRES_IMAGE,
        targetPostgresImage,
        "2026.08.22-3",
      );
      await buildReleaseImage(
        directory,
        environment.WEATHER_LOCAL_CLOUDFLARED_IMAGE,
        previousCloudflaredImage,
        "2026.08.22-1",
      );
      await buildReleaseImage(
        directory,
        environment.WEATHER_LOCAL_CLOUDFLARED_IMAGE,
        targetCloudflaredImage,
        "2026.08.22-3",
      );
      const imagePairs = [
        [previousServerImage, targetServerImage],
        [previousWebImage, targetWebImage],
        [previousPostgresImage, targetPostgresImage],
        [previousCloudflaredImage, targetCloudflaredImage],
      ];

      // require four changed release identities
      for (const [previousImage, targetImage] of imagePairs) {
        assert.notEqual(await imageId(previousImage), await imageId(targetImage));
      }
      assert.equal(
        await imageLabel(previousServerImage, "weather.test.baseline"),
        baselineRevision,
      );
      await executeFile("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        previousServerImage,
        "-c",
        "test ! -f /opt/weather/packages/database/migrations/0009_forecast_anchor_records.sql && test ! -f /opt/weather/packages/database/migrations/0010_forecast_training_export.sql && test ! -f /opt/weather/packages/database/migrations/0011_forecast_runtime_provenance.sql && test ! -f /opt/weather/packages/database/migrations/0012_hide_archive_only_forecasts_from_live_reads.sql && test ! -f /opt/weather/packages/database/migrations/9999_candidate_contract.sql",
      ]);
      await executeFile("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        targetServerImage,
        "-c",
        "test -f /opt/weather/packages/database/migrations/0009_forecast_anchor_records.sql && test -f /opt/weather/packages/database/migrations/0010_forecast_training_export.sql && test -f /opt/weather/packages/database/migrations/0011_forecast_runtime_provenance.sql && test -f /opt/weather/packages/database/migrations/0012_hide_archive_only_forecasts_from_live_reads.sql && test -f /opt/weather/packages/database/migrations/9999_candidate_contract.sql",
      ]);
      const firstSites = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`);
      assert.equal(firstSites.status, 200);
      const firstBody = await firstSites.text();
      const health = await fetch(`http://127.0.0.1:${webPort}/api/v1/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).data.version, "2026.08.22-1");
      await assert.rejects(
        compose(
          environment,
          override,
          "exec",
          "-T",
          "postgres",
          "env",
          "PGPASSWORD=owner-integration-password",
          "psql",
          "--host",
          "postgres",
          "--username",
          "postgres",
          "--dbname",
          "weather_deploy_test",
          "--command",
          "SELECT 1",
        ),
      );
      const administratorLogin = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=admin-integration-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT current_user",
      );
      assert.equal(administratorLogin.stdout.trim(), "postgres");

      // emulate retained owner authority
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "psql",
        "--set=ON_ERROR_STOP=1",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--command",
        "DO $$ BEGIN EXECUTE format('ALTER ROLE postgres WITH LOGIN PASSWORD %L', regexp_replace(pg_read_file('/run/secrets/weather_owner_password'), E'[\\r\\n]+$', '')); END $$;",
      );
      const legacyOwnerLogin = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=owner-integration-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT current_user",
      );
      assert.equal(legacyOwnerLogin.stdout.trim(), "postgres");
      // restart without deleting data
      await compose(environment, override, "restart", "postgres");
      await compose(environment, override, "up", "--detach", "--no-deps", "--wait", "postgres");
      await assert.rejects(
        compose(
          environment,
          override,
          "exec",
          "-T",
          "postgres",
          "env",
          "PGPASSWORD=owner-integration-password",
          "psql",
          "--host",
          "postgres",
          "--username",
          "postgres",
          "--dbname",
          "weather_deploy_test",
          "--command",
          "SELECT 1",
        ),
      );
      const reconciledAdministratorLogin = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=admin-integration-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT current_user",
      );
      assert.equal(reconciledAdministratorLogin.stdout.trim(), "postgres");
      await compose(environment, override, "restart", "postgres");
      await compose(environment, override, "up", "--detach", "--no-deps", "--wait", "postgres");
      const idempotentAdministratorLogin = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=admin-integration-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT current_user",
      );
      assert.equal(idempotentAdministratorLogin.stdout.trim(), "postgres");

      const initialTrainingExportLogin = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=training-export-integration-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "weather_training_export",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT contract_version FROM forecast_training_export_manifest_v1",
      );
      assert.equal(
        initialTrainingExportLogin.stdout.trim(),
        "forecast-training-export-manifest/v1",
      );
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "psql",
        "--set=ON_ERROR_STOP=1",
        "--username",
        "postgres",
        "--dbname",
        "weather_deploy_test",
        "--command",
        "CREATE ROLE weather_export_retained_extra NOLOGIN; GRANT weather_export_retained_extra TO weather_training_export; ALTER ROLE weather_training_export SET search_path = pg_catalog; ALTER ROLE weather_training_export IN DATABASE weather_deploy_test SET default_transaction_read_only = off; ALTER ROLE weather_training_export IN DATABASE weather_deploy_test SET search_path = pg_catalog;",
      );
      await executeFile(
        "docker",
        [
          "run",
          "--rm",
          "--volume",
          `${secretsRoot}:/secrets`,
          "--entrypoint",
          "sh",
          "node:24-bookworm-slim",
          "-c",
          "printf '%s\\n' 'training-export-rotated-password' > /secrets/weather_postgres_training_export_password && chown 999:999 /secrets/weather_postgres_training_export_password && chmod 0400 /secrets/weather_postgres_training_export_password",
        ],
        { timeout: 120_000 },
      );
      await compose(environment, override, "restart", "postgres");
      await compose(environment, override, "up", "--detach", "--no-deps", "--wait", "postgres");
      await assert.rejects(
        compose(
          environment,
          override,
          "exec",
          "-T",
          "postgres",
          "env",
          "PGPASSWORD=training-export-integration-password",
          "psql",
          "--host",
          "postgres",
          "--username",
          "weather_training_export",
          "--dbname",
          "weather_deploy_test",
          "--command",
          "SELECT 1",
        ),
      );
      const rotatedTrainingExport = await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "env",
        "PGPASSWORD=training-export-rotated-password",
        "psql",
        "--host",
        "postgres",
        "--username",
        "weather_training_export",
        "--dbname",
        "weather_deploy_test",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT current_user || ':' || current_setting('default_transaction_read_only')",
      );
      assert.equal(
        rotatedTrainingExport.stdout.trim(),
        "weather_training_export:on",
      );
      const retainedTrainingRole = await compose(
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
        "SELECT rolconfig = ARRAY['default_transaction_read_only=on'] AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'weather_training_export'::regrole) AND NOT EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole = 'weather_training_export'::regrole AND setdatabase <> 0) FROM pg_roles WHERE rolname = 'weather_training_export'",
      );
      assert.equal(retainedTrainingRole.stdout.trim(), "t");
      assert.deepEqual(
        await trainingExportAuthority(
          environment,
          override,
          "weather_deploy_test",
        ),
        expectedTrainingExportAuthority,
      );
      const postgresLogs = await compose(environment, override, "logs", "--no-color", "postgres");

      // reject credential disclosure
      for (const secret of [
        "admin-integration-password",
        "owner-integration-password",
        "api-integration-password",
        "ingest-integration-password",
        "training-export-integration-password",
        "training-export-rotated-password",
      ]) {
        assert.equal(`${postgresLogs.stdout}${postgresLogs.stderr}`.includes(secret), false);
      }

      const networkServices = [
        { name: "postgres", service: "postgres", target: "postgres", networks: ["data"] },
        {
          name: "migration",
          service: "migration-network-probe",
          target: "migration-network-probe",
          networks: ["data"],
        },
        { name: "api", service: "api", target: "api", networks: ["data", "web_api"] },
        {
          name: "worker",
          service: "worker",
          target: "worker",
          networks: ["data", "provider_egress"],
        },
        { name: "web", service: "web", target: "web", networks: ["edge", "web_api"] },
        {
          name: "cloudflared",
          service: "cloudflared",
          target: "cloudflared",
          networks: ["edge", "tunnel_egress"],
        },
      ];

      // prove the complete directional DNS matrix
      for (const source of networkServices) {
        // compare every distinct target
        for (const target of networkServices) {
          // skip self reachability
          if (source.name === target.name) {
            continue;
          }

          const expected = source.networks.some((network) => target.networks.includes(network))
            ? "allowed"
            : "denied";
          await assertProbe(environment, override, expected, source.service, "dns", target.target);
        }
      }

      // prove data paths with TCP
      await assertProbe(environment, override, "allowed", "migration-network-probe", "tcp", "postgres", "5432");
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

      // prove both controlled egress boundaries
      for (const source of networkServices) {
        const probeKind = source.service === "postgres" ? "tcp" : "http";
        const providerValues =
          probeKind === "tcp"
            ? ["provider-egress-probe", "3003"]
            : ["http://provider-egress-probe:3003/"];
        const tunnelValues =
          probeKind === "tcp"
            ? ["tunnel-egress-probe", "3005"]
            : ["http://tunnel-egress-probe:3005/"];
        await assertProbe(
          environment,
          override,
          source.name === "worker" ? "allowed" : "denied",
          source.service,
          probeKind,
          ...providerValues,
        );
        await assertProbe(
          environment,
          override,
          source.name === "cloudflared" ? "allowed" : "denied",
          source.service,
          probeKind,
          ...tunnelValues,
        );
      }

      // capture the previous-release schema
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

      const compatibilityEnv = join(directory, "compatibility.env");
      const codeOnlyCompatibilityEnv = join(directory, "code-only-compatibility.env");
      const previousCompatibilityEnv = join(directory, "previous-compatibility.env");
      const compatibilityReleases = join(directory, "compatibility-releases");
      const compatibilityAuthorization = join(
        compatibilityReleases,
        "2026.08.22-3.migration-authorization",
      );
      const codeOnlyAuthorization = join(
        compatibilityReleases,
        "2026.08.22-2.migration-authorization",
      );
      await mkdir(compatibilityReleases);
      await writeFile(
        compatibilityEnv,
        (await readFile(envFile, "utf8"))
          .replace(/^WEATHER_RELEASE=.*$/mu, "WEATHER_RELEASE=2026.08.22-3")
          .replace(/^WEATHER_SERVER_IMAGE=.*$/mu, `WEATHER_SERVER_IMAGE=${targetServerImage}`),
      );
      await writeFile(
        codeOnlyCompatibilityEnv,
        (await readFile(envFile, "utf8"))
          .replace(/^WEATHER_RELEASE=.*$/mu, "WEATHER_RELEASE=2026.08.22-2")
          .replace(/^WEATHER_SERVER_IMAGE=.*$/mu, `WEATHER_SERVER_IMAGE=${previousServerImage}`),
      );
      await writeFile(
        previousCompatibilityEnv,
        (await readFile(envFile, "utf8")).replace(
          /^WEATHER_SERVER_IMAGE=.*$/mu,
          `WEATHER_SERVER_IMAGE=${previousServerImage}`,
        ),
      );

      // run one release compatibility gate
      const verifyCompatibility = async (candidateEnv, candidateAuthorization) =>
        await executeFile(
          "bash",
          [
            "-c",
            `source "$1"
override=$2
compatibility_env=$3
previous_compatibility_env=$4
compose_file=$5
local_compose_file=$6
releases_dir=$7
authorization=$8
# use the disposable Compose project
compose() {
  local selected_env=\${WEATHER_ENV_FILE:-$compatibility_env}
  local selected_image
  selected_image=$(env_value "$selected_env" WEATHER_SERVER_IMAGE)
  WEATHER_LOCAL_SERVER_IMAGE="$selected_image" docker compose \\
    --project-name "$WEATHER_COMPOSE_PROJECT_NAME" --env-file "$selected_env" \\
    --file "$compose_file" --file "$local_compose_file" --file "$override" "$@"
}
verify_previous_image_compatibility "$compatibility_env" "$previous_compatibility_env" "$authorization"`,
            "weather-compatibility-test",
            join(deployRoot, "scripts/update.sh"),
            override,
            candidateEnv,
            previousCompatibilityEnv,
            join(deployRoot, "compose.yaml"),
            join(deployRoot, "compose.local.yaml"),
            compatibilityReleases,
            candidateAuthorization,
          ],
          { cwd: repoRoot, env: environment, timeout: 300_000 },
        );

      await verifyCompatibility(codeOnlyCompatibilityEnv, codeOnlyAuthorization);
      const codeOnlyAuthorizationText = await readFile(codeOnlyAuthorization, "utf8");
      assert.match(
        codeOnlyAuthorizationText,
        /^WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=[a-f0-9]{64}$/mu,
      );
      await verifyCompatibility(compatibilityEnv, compatibilityAuthorization);
      const authorizationText = await readFile(compatibilityAuthorization, "utf8");
      const authorizationHistorySha256 = authorizationText.match(
        /^WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=([a-f0-9]{64})$/mu,
      )?.[1];
      assert.match(authorizationHistorySha256 ?? "", /^[a-f0-9]{64}$/u);
      await compose(
        {
          ...environment,
          WEATHER_ENV_FILE: compatibilityEnv,
          WEATHER_LOCAL_SERVER_IMAGE: targetServerImage,
        },
        override,
        "run",
        "--rm",
        "migration",
      );

      const previousWorkerHealthEnvironment = {
        ...environment,
        WEATHER_ENV_FILE: previousCompatibilityEnv,
        WEATHER_LOCAL_SERVER_IMAGE: previousServerImage,
        WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256:
          authorizationHistorySha256,
        WEATHER_MIGRATION_AUTHORIZATION_RELEASE: "2026.08.22-1",
      };
      // run the deployed previous-image health command
      const runPreviousWorkerHealth = async () =>
        await compose(
          previousWorkerHealthEnvironment,
          override,
          "run",
          "--rm",
          "--no-deps",
          "worker",
          "node",
          "apps/worker/dist/health.js",
        );
      const trailingMigrationHealth = await runPreviousWorkerHealth();
      assert.equal(JSON.parse(trailingMigrationHealth.stdout.trim()).ready, true);
      const knownMigrationChecksum = (
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
          "SELECT checksum FROM schema_migrations WHERE name = '0001_initial_weather.sql'",
        )
      ).stdout.trim();
      assert.match(knownMigrationChecksum, /^[a-f0-9]{64}$/u);

      try {
        // corrupt one known checksum
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
          "--command",
          "UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = '0001_initial_weather.sql'",
        );
        await assert.rejects(
          runPreviousWorkerHealth(),
          // require bounded migration diagnostics
          (error) => {
            assert.match(
              `${error.stdout ?? ""}${error.stderr ?? ""}`,
              /migration checksum mismatch: 0001_initial_weather\.sql/u,
            );
            return true;
          },
        );
      } finally {
        // restore the disposable ledger
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
          "--command",
          `UPDATE schema_migrations SET checksum = '${knownMigrationChecksum}' WHERE name = '0001_initial_weather.sql'`,
        );
      }

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
      const rollbackTranscript = join(releaseRoot, "rollback-transcript");
      await executeFile("mkdir", ["-p", releases, releaseState]);

      // create three immutable lifecycle states
      for (const release of ["2026.08.22-1", "2026.08.22-2", "2026.08.22-3"]) {
        // select lifecycle image digests
        const digestKeys = release.endsWith("-3")
          ? { cloudflared: "2", postgres: "1", server: "e", web: "f" }
          : { cloudflared: "d", postgres: "c", server: "a", web: "b" };
        await writeFile(
          join(releases, `${release}.env`),
          [
            `WEATHER_RELEASE=${release}`,
            `WEATHER_SERVER_IMAGE=registry.example/weather-server@sha256:${digestKeys.server.repeat(64)}`,
            `WEATHER_WEB_IMAGE=registry.example/weather-web@sha256:${digestKeys.web.repeat(64)}`,
            `POSTGRES_IMAGE=postgres@sha256:${digestKeys.postgres.repeat(64)}`,
            `CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:${digestKeys.cloudflared.repeat(64)}`,
            "WEATHER_DATABASE_NAME=weather_deploy_test",
            "WEATHER_POSTGRES_DIR=/var/lib/weather/postgres",
            "WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH=0",
            `WEATHER_CONTROL_PLANE_SHA256=${controlPlane}`,
            "WEATHER_CONTROL_PLANE_VERSION=7",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
      }
      await writeFile(join(releaseState, "current-release"), "2026.08.22-3\n", { mode: 0o600 });
      await writeFile(join(releaseState, "previous-release"), "2026.08.22-1\n", { mode: 0o600 });
      await writeFile(join(releaseState, "schema-release"), "2026.08.22-3\n", { mode: 0o600 });
      await writeFile(
        join(releases, "2026.08.22-2.migration-authorization"),
        codeOnlyAuthorizationText,
        { mode: 0o600 },
      );
      await writeFile(
        join(releases, "2026.08.22-3.migration-authorization"),
        authorizationText,
        { mode: 0o600 },
      );
      await executeFile(
        "bash",
        [
          "-c",
          `source "$1"
releases_dir=$2
state_dir=$3
override=$4
default_env=$5
compose_file=$6
local_compose_file=$7
transcript=$8
previous_server=$9
previous_web=\${10}
current_server=\${11}
current_web=\${12}
previous_postgres=\${13}
current_postgres=\${14}
previous_cloudflared=\${15}
current_cloudflared=\${16}
# bypass host secret ownership
require_deployment_secrets() { :; }
# bypass host runtime ownership
prepare_xweather_usage_directory() { :; }
# publish only fixture state
write_active_symlink() { ln -sfn "../releases/$1.env" "$state_dir/active.env"; }
# use the disposable Compose project
compose() {
  local selected_env=\${WEATHER_ENV_FILE:-$default_env}
  local selected_release local_server local_web local_postgres local_cloudflared
  selected_release=$(env_value "$selected_env" WEATHER_RELEASE)
  # select the fixture image set
  if [[ "$selected_release" == '2026.08.22-3' ]]; then
    local_server=$current_server
    local_web=$current_web
    local_postgres=$current_postgres
    local_cloudflared=$current_cloudflared
  else
    local_server=$previous_server
    local_web=$previous_web
    local_postgres=$previous_postgres
    local_cloudflared=$previous_cloudflared
  fi
  printf '%s|%s\\n' "$selected_env" "$*" >>"$transcript"
  WEATHER_LOCAL_SERVER_IMAGE="$local_server" WEATHER_LOCAL_WEB_IMAGE="$local_web" \\
    WEATHER_LOCAL_POSTGRES_IMAGE="$local_postgres" \\
    WEATHER_LOCAL_CLOUDFLARED_IMAGE="$local_cloudflared" \\
    docker compose --project-name "$WEATHER_COMPOSE_PROJECT_NAME" --env-file "$selected_env" \\
      --file "$compose_file" --file "$local_compose_file" --file "$override" "$@"
}
# record one service identity
record_service_image() {
  local phase=$1
  local env_file=$2
  local service=$3
  local container
  container=$(WEATHER_ENV_FILE="$env_file" compose ps -q "$service")
  printf 'image-%s-%s:%s\\n' "$phase" "$service" \\
    "$(docker inspect --format '{{.Image}}' "$container")" >>"$transcript"
}
# establish the newer image set
current_env="$releases_dir/2026.08.22-3.env"
restore_images "$current_env"
record_service_image before "$current_env" postgres
record_service_image before "$current_env" api
record_service_image before "$current_env" web
record_service_image before "$current_env" cloudflared
printf 'release-before:%s\\n' "$(WEATHER_ENV_FILE=$current_env compose exec -T api node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(async response=>process.stdout.write((await response.json()).data.version))")" >>"$transcript"
rollback_release
previous_env="$releases_dir/2026.08.22-1.env"
verify_runtime_database_acl "$previous_env" weather_deploy_test
printf 'acl-after-rollback:verified\\n' >>"$transcript"
record_service_image after "$previous_env" postgres
record_service_image after "$previous_env" api
record_service_image after "$previous_env" web
record_service_image after "$previous_env" cloudflared
printf 'release-after:%s\\n' "$(WEATHER_ENV_FILE=$previous_env compose exec -T api node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(async response=>process.stdout.write((await response.json()).data.version))")" >>"$transcript"
printf 'stale-activate-before\\n' >>"$transcript"
# require fail-closed stale activation
if (main activate 2026.08.22-2) 2>>"$transcript"; then
  die "stale release activation unexpectedly succeeded"
fi
printf 'stale-activate-after\\n' >>"$transcript"
WEATHER_ENV_FILE=$previous_env compose down --remove-orphans
main recover
verify_runtime_database_acl "$previous_env" weather_deploy_test
printf 'acl-after-recover:verified\\n' >>"$transcript"
printf 'release-recovered:%s\\n' "$(WEATHER_ENV_FILE=$previous_env compose exec -T api node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(async response=>process.stdout.write((await response.json()).data.version))")" >>"$transcript"`,
          "weather-rollback-integration",
          join(deployRoot, "scripts/update.sh"),
          releases,
          releaseState,
          override,
          envFile,
          join(deployRoot, "compose.yaml"),
          join(deployRoot, "compose.local.yaml"),
          rollbackTranscript,
          previousServerImage,
          previousWebImage,
          targetServerImage,
          targetWebImage,
          previousPostgresImage,
          targetPostgresImage,
          previousCloudflaredImage,
          targetCloudflaredImage,
        ],
        { cwd: repoRoot, env: environment, timeout: 300_000 },
      );
      assert.equal(await readFile(join(releaseState, "current-release"), "utf8"), "2026.08.22-1\n");
      const rollbackCommands = await readFile(rollbackTranscript, "utf8");
      assert.match(rollbackCommands, /2026\.08\.22-1\.env\|up -d --no-deps --wait/u);
      assert.doesNotMatch(rollbackCommands, /\brun\b[^\n]*\bmigration\b/u);
      assert.match(rollbackCommands, /release-before:2026\.08\.22-3/u);
      assert.match(rollbackCommands, /release-after:2026\.08\.22-1/u);
      assert.match(rollbackCommands, /acl-after-rollback:verified/u);
      assert.match(rollbackCommands, /acl-after-recover:verified/u);
      assert.match(
        rollbackCommands,
        /stale-activate-before\nerror: cannot activate release 2026\.08\.22-2 while runtime release 2026\.08\.22-1 differs from retained schema release 2026\.08\.22-3\nstale-activate-after/u,
      );
      assert.match(rollbackCommands, /release-recovered:2026\.08\.22-1/u);
      assert.equal(await readFile(join(releaseState, "schema-release"), "utf8"), "2026.08.22-3\n");
      assert.equal(
        await readFile(join(releases, "2026.08.22-2.migration-authorization"), "utf8"),
        codeOnlyAuthorizationText,
      );
      const rollbackIdentities = [
        ["postgres", previousPostgresImage, targetPostgresImage],
        ["api", previousServerImage, targetServerImage],
        ["web", previousWebImage, targetWebImage],
        ["cloudflared", previousCloudflaredImage, targetCloudflaredImage],
      ];

      // prove all four identities changed
      for (const [service, previousImage, targetImage] of rollbackIdentities) {
        assert.equal(
          rollbackCommands.includes(`image-before-${service}:${await imageId(targetImage)}`),
          true,
        );
        assert.equal(
          rollbackCommands.includes(`image-after-${service}:${await imageId(previousImage)}`),
          true,
        );
      }
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
      assert.deepEqual(
        await trainingExportAuthority(
          environment,
          override,
          "weather_deploy_test",
        ),
        expectedTrainingExportAuthority,
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
      const forbiddenTrainingPaths = [
        "/run/secrets/weather_training_export_password",
        "/opt/weather/.weather-data",
        "/opt/weather/.weather-models",
        "/home/weather/.weather-data",
        "/home/weather/.weather/model-evidence",
        "/root/.weather-data",
        "/root/.weather/model-evidence",
      ];

      // deny runtime evidence and key paths
      for (const service of ["api", "web", "worker"]) {
        await compose(
          environment,
          override,
          "exec",
          "-T",
          service,
          "sh",
          "-eu",
          "-c",
          'for path do test ! -e "$path"; done',
          "training-path-denial",
          ...forbiddenTrainingPaths,
        );
      }
      await compose(
        environment,
        override,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "sh",
        "migration",
        "-eu",
        "-c",
        'for path do test ! -e "$path"; done',
        "training-path-denial",
        ...forbiddenTrainingPaths,
      );

      // prove named-volume persistence through recovery
      const secondSites = await fetch(`http://127.0.0.1:${webPort}/api/v1/sites`);
      assert.equal(secondSites.status, 200);
      assert.equal(await secondSites.text(), firstBody);

      // verify the retained pre-candidate backup
      const restored = await executeFile(
        join(deployRoot, "scripts/restore.sh"),
        [
          "verify",
          archive,
          "--identity",
          identity,
          "--env-file",
          envFile,
          "--retain",
        ],
        { cwd: repoRoot, env: environment, timeout: 120_000 },
      );
      const restoredDatabase = restored.stdout.match(
        /Retained diagnostic database: ([a-z0-9_]+)/u,
      )?.[1];
      assert.ok(restoredDatabase);
      assert.deepEqual(
        await trainingExportAuthority(environment, override, restoredDatabase),
        expectedTrainingExportAuthority,
      );
      await compose(
        environment,
        override,
        "exec",
        "-T",
        "postgres",
        "dropdb",
        "--username",
        "postgres",
        restoredDatabase,
      );
    } finally {
      await compose(environment, override, "down", "--volumes", "--remove-orphans").catch(
        () => undefined,
      );
      // remove every disposable application image
      for (const image of disposableImages) {
        await executeFile("docker", ["image", "rm", "--force", image]).catch(() => undefined);
      }
      await rm(directory, { force: true, recursive: true });
    }
  },
);
