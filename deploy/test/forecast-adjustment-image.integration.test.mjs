import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";
const providedServerImage = process.env.WEATHER_TEST_SERVER_IMAGE;
const providedWebImage = process.env.WEATHER_TEST_WEB_IMAGE;
const providedBuildPackageRoot = process.env.WEATHER_TEST_BUILD_PACKAGE_ROOT;
const providedBuildWebContract = process.env.WEATHER_TEST_BUILD_WEB_CONTRACT;
const publicScorecardContractPath =
  "deploy/scripts/forecast-adjustment-scorecard-contract.mjs";
const publicMaintenanceContractPath =
  "apps/web/dist/adjustment-maintenance-contract.mjs";
const publicMaintenanceContractExports = [
  "createMaintenanceShadowPredictionMetadata",
  "parseAdjustmentRainFixedGaugeTargetProjection",
  "parseAdjustmentRevisionProjectionDocument",
  "parseMaintenanceShadowComparator",
  "parseMaintenanceShadowSourceProjection",
  "parseMaintenanceShadowValues",
  "parseRainMaintenanceControlState",
  "validateMaintenanceShadowComparatorBinding",
];

// hash the exact server package files expected from the build stage
async function collectExpectedPackageFiles(
  packageRoot = providedBuildPackageRoot ?? join(repoRoot, "packages/forecast-adjustment"),
) {
  const files = new Map();

  // hash one regular package subtree without following links
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    // retain deterministic relative file identities
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);

      // descend only through real directories
      if (metadata.isDirectory()) {
        await walk(path);
        continue;
      }

      // hash only regular package bytes
      if (metadata.isFile()) {
        files.set(
          relative(packageRoot, path),
          createHash("sha256").update(await readFile(path)).digest("hex"),
        );
      }
    }
  }

  await walk(join(packageRoot, "dist"));
  const packageJson = join(packageRoot, "package.json");
  files.set(
    "package.json",
    createHash("sha256").update(await readFile(packageJson)).digest("hex"),
  );
  return Object.fromEntries([...files].sort(([left], [right]) =>
    left.localeCompare(right)));
}

// compare exported build bytes without compiling a second reference package
test("image inspection hashes an exported build package without local compilation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-image-build-export-"));
  try {
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "dist/index.js"), "export const value = 1;\n");
    await writeFile(join(directory, "package.json"), "{}\n");
    assert.deepEqual(await collectExpectedPackageFiles(directory), {
      "dist/index.js": createHash("sha256").update("export const value = 1;\n").digest("hex"),
      "package.json": createHash("sha256").update("{}\n").digest("hex"),
    });
    await assert.rejects(collectExpectedPackageFiles(join(directory, "missing")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// inspect image nodes with lstat and without following links
const imageInspectionScript = `
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, realpathSync } = require("node:fs");
const { join, relative } = require("node:path");
const root = "/opt/weather";
const nodes = [];
const publicForecastAdjustmentPaths = new Set([${JSON.stringify(publicScorecardContractPath)}, ${JSON.stringify(publicMaintenanceContractPath)}]);
// collect nodes without following links
function walk(directory) {
  // inspect deterministic child nodes
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    const metadata = lstatSync(path);
    nodes.push({ path: relative(root, path), type: metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "special" });
    // descend only through real directories
    if (metadata.isDirectory()) walk(path);
  }
}
// hash regular package files
function hashes(directory) {
  const output = {};
  // visit one package directory
  function visit(current) {
    // inspect deterministic package children
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      const metadata = lstatSync(path);
      // descend or hash without following links
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) output[relative(directory, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(directory);
  return output;
}
walk(root);
// identify every sensitive adjustment or private-data node
const sensitiveNodes = nodes.filter(({ path }) => /forecast-adjustment|(?:^|\\\/)\\.weather-(?:data|models)(?:\\\/|$)|(?:^|\\\/)model-evidence(?:\\\/|$)|sha256-[a-f0-9]{64}\\.json$|training[_-]export[_-]password|(?:decrypt|encrypt)(?:ion)?[-_]?key/iu.test(path));
// permit only the two reviewed public contracts among sensitive nodes
const forbidden = sensitiveNodes.filter(({ path }) => !publicForecastAdjustmentPaths.has(path));
// bind every required public path to its exact image bytes and node type
const publicForecastAdjustmentNodes = nodes
  .filter(({ path }) => publicForecastAdjustmentPaths.has(path))
  .map(({ path, type }) => ({
    path,
    sha256: type === "file" ? createHash("sha256").update(readFileSync(join(root, path))).digest("hex") : null,
    type,
  }));
const mode = process.argv[1];
// return only the requested bounded inspection
if (mode === "web") {
  process.stdout.write(JSON.stringify({ forbidden, publicForecastAdjustmentNodes }));
} else {
  const packageRoot = join(root, "packages/forecast-adjustment");
  const packageLink = join(root, "node_modules/@weather/forecast-adjustment");
  process.stdout.write(JSON.stringify({
    bundleNodes: nodes.filter(({ path }) => /config\\\/forecast-adjustments\\\/ballydidean\\\/bundles\\\/sha256-[a-f0-9]{64}\\.json$/u.test(path)),
    windCanaryBundleNodes: nodes.filter(({ path }) => /config\\\/forecast-adjustments\\\/ballydidean\\\/wind-canary-bundles\\\/sha256-[a-f0-9]{64}\\.json$/u.test(path)),
    temperatureCanaryBundleNodes: nodes.filter(({ path }) => path.startsWith("config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-") && path.endsWith(".json")),
    temperatureCanaryRegistry: readFileSync(join(root, "config/forecast-adjustments/ballydidean-temperature-canary.json"), "utf8"),
    windCanaryRegistry: readFileSync(join(root, "config/forecast-adjustments/ballydidean-wind-canary.json"), "utf8"),
    linkRealpath: realpathSync(packageLink),
    linkType: lstatSync(packageLink).isSymbolicLink() ? "link" : "other",
    packageFiles: hashes(packageRoot),
    registry: readFileSync(join(root, "config/forecast-adjustments/ballydidean.json"), "utf8"),
  }));
}
`;

// run one bounded command against a built image
async function inspectImage(image, mode) {
  const { stdout } = await executeFile(
    "docker",
    ["run", "--rm", "--entrypoint", "node", image, "-e", imageInspectionScript, mode],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  return JSON.parse(stdout);
}

// import the exact public maintenance contract from the built web image
async function inspectWebContractExports(image) {
  const script = `import(${JSON.stringify("./apps/web/dist/adjustment-maintenance-contract.mjs")})`
    + ".then((module) => process.stdout.write(JSON.stringify(Object.keys(module).sort())))";
  const { stdout } = await executeFile(
    "docker",
    ["run", "--rm", "--entrypoint", "node", image, "--input-type=module", "-e", script],
    { cwd: repoRoot, maxBuffer: 1024 * 1024, timeout: 120_000 },
  );
  return JSON.parse(stdout);
}

// start the production web command and prove its complete import graph serves
async function inspectWebServerStartup(image, suffix) {
  const name = `weather-web-import-test-${suffix}`;
  try {
    await executeFile(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--env",
        "PORT=3000",
        "--env",
        "WEATHER_ADJUSTMENT_EVIDENCE_ROOT=/tmp/adjustment-evidence",
        "--env",
        "WEATHER_ADMIN_AUTH_PATH=/tmp/admin-auth.json",
        "--env",
        "WEATHER_PROPERTY_SENSOR_LAYOUT_PATH=/tmp/property-sensor-layout.json",
        image,
      ],
      { cwd: repoRoot, timeout: 120_000 },
    );
    let lastError;
    // allow the production listener to initialize its disposable private state
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await executeFile(
          "docker",
          [
            "exec",
            name,
            "node",
            "-e",
            "fetch('http://127.0.0.1:3000/', { method: 'HEAD' }).then((response) => { if (response.status !== 200) process.exit(1); })",
          ],
          { cwd: repoRoot, timeout: 10_000 },
        );
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
    }
    const { stdout, stderr } = await executeFile(
      "docker",
      ["logs", name],
      { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
    );
    throw new Error(`web image did not serve after startup: ${String(lastError)}\n${stdout}${stderr}`);
  } finally {
    await executeFile(
      "docker",
      ["rm", "--force", name],
      { cwd: repoRoot, timeout: 30_000 },
    ).catch(() => undefined);
  }
}

// verify immutable canary material stays server-only and separately selected
test("built server and web images enforce the adjustment filesystem boundary", {
  timeout: 300_000,
}, async (context) => {
  // require the explicit disposable image gate
  if (!runIntegration) {
    context.skip("set WEATHER_RUN_DEPLOY_INTEGRATION=1");
    return;
  }

  // require an exact pair of caller-built inspection images
  if ((providedServerImage === undefined) !== (providedWebImage === undefined)) {
    throw new Error("both WEATHER_TEST_SERVER_IMAGE and WEATHER_TEST_WEB_IMAGE are required");
  }

  const buildImages = providedServerImage === undefined;
  const suffix = `${process.pid}-${Date.now()}`;
  const serverImage = providedServerImage ??
    `weather-forecast-adjustment-server-test:${suffix}`;
  const webImage = providedWebImage ??
    `weather-forecast-adjustment-web-test:${suffix}`;

  try {
    // build both exact production targets when images were not supplied
    if (buildImages) {
      // build both production targets
      for (const [target, image] of [["server", serverImage], ["web", webImage]]) {
        await executeFile(
          "docker",
          [
            "build",
            "--target",
            target,
            "--tag",
            image,
            ".",
          ],
          { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024, timeout: 240_000 },
        );
      }
    }

    const web = await inspectImage(webImage, "web");
    assert.deepEqual(web.forbidden, []);
    const expectedWebContract = providedBuildWebContract ??
      join(repoRoot, "apps/web/dist/adjustment-maintenance-contract.mjs");
    // require both copied public validators to match reviewed build bytes
    assert.deepEqual(web.publicForecastAdjustmentNodes, [{
      path: publicMaintenanceContractPath,
      sha256: createHash("sha256").update(await readFile(expectedWebContract)).digest("hex"),
      type: "file",
    }, {
      path: publicScorecardContractPath,
      sha256: createHash("sha256").update(await readFile(
        join(repoRoot, publicScorecardContractPath),
      )).digest("hex"),
      type: "file",
    }]);
    assert.deepEqual(
      await inspectWebContractExports(webImage),
      publicMaintenanceContractExports,
    );
    await inspectWebServerStartup(webImage, suffix);
    const server = await inspectImage(serverImage, "server");
    assert.equal(server.linkType, "link");
    assert.equal(
      server.linkRealpath,
      "/opt/weather/packages/forecast-adjustment",
    );
    assert.deepEqual(
      server.packageFiles,
      await collectExpectedPackageFiles(),
    );
    assert.equal(
      server.registry,
      '{"activeBundle":null,"contractVersion":"forecast-adjustment-registry/v1"}\n',
    );
    assert.deepEqual(server.bundleNodes, []);
    const expectedWindCanaryRegistry = await readFile(
      join(repoRoot, "config/forecast-adjustments/ballydidean-wind-canary.json"),
      "utf8",
    );
    assert.equal(server.windCanaryRegistry, expectedWindCanaryRegistry);
    const windCanaryRegistry = JSON.parse(server.windCanaryRegistry);
    assert.equal(windCanaryRegistry.contractVersion, "forecast-adjustment-wind-canary-registry/v1");
    assert.equal(windCanaryRegistry.activeBundle.bundleSha256, "51f8efd63bef678a7f02d11bdab91405ec48f19808f64d3fe8354036c9b302a2");
    assert.equal(server.temperatureCanaryRegistry, await readFile(join(repoRoot, "config/forecast-adjustments/ballydidean-temperature-canary.json"), "utf8"));
    assert.deepEqual(server.temperatureCanaryBundleNodes, [{
      path: "config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-3e82073a266ca88c15f492f86bbefbca8b8cda029520af6cc78e0a0062ee50dd.json",
      type: "file",
    }, {
      path: "config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json",
      type: "file",
    }]);
    // retain historical and permanent immutable bundles
    assert.deepEqual(server.windCanaryBundleNodes, [{
      path: "config/forecast-adjustments/ballydidean/wind-canary-bundles/sha256-51f8efd63bef678a7f02d11bdab91405ec48f19808f64d3fe8354036c9b302a2.json",
      type: "file",
    }, {
      path: "config/forecast-adjustments/ballydidean/wind-canary-bundles/sha256-5e8b2e3932111621af6785a1b16dfd22edc0a2d26059c6e396654c70119abbe1.json",
      type: "file",
    }, {
      path: "config/forecast-adjustments/ballydidean/wind-canary-bundles/sha256-8ada04b924326665b7c49be37876727e9fdc853e9b0eb3decc7fe68c62acc96b.json",
      type: "file",
    }]);
  } finally {
    // remove only the disposable test images
    if (buildImages) {
      try {
        await executeFile(
          "docker",
          ["image", "rm", "--force", serverImage, webImage],
          { cwd: repoRoot, timeout: 120_000 },
        );
      } catch {
        // preserve the primary inspection result
      }
    }
  }
});
