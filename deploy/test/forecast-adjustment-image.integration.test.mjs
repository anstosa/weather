import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";
const providedServerImage = process.env.WEATHER_TEST_SERVER_IMAGE;
const providedWebImage = process.env.WEATHER_TEST_WEB_IMAGE;

// hash the exact server package files expected from the build stage
async function collectExpectedPackageFiles() {
  const packageRoot = join(repoRoot, "packages/forecast-adjustment");
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

// inspect image nodes with lstat and without following links
const imageInspectionScript = `
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, realpathSync } = require("node:fs");
const { join, relative } = require("node:path");
const root = "/opt/weather";
const nodes = [];
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
const forbidden = nodes.filter(({ path }) => /forecast-adjustment|(?:^|\\\/)\\.weather-(?:data|models)(?:\\\/|$)|(?:^|\\\/)model-evidence(?:\\\/|$)|sha256-[a-f0-9]{64}\\.json$|training[_-]export[_-]password|(?:decrypt|encrypt)(?:ion)?[-_]?key/iu.test(path));
const mode = process.argv[1];
// return only the requested bounded inspection
if (mode === "web") {
  process.stdout.write(JSON.stringify({ forbidden }));
} else {
  const packageRoot = join(root, "packages/forecast-adjustment");
  const packageLink = join(root, "node_modules/@weather/forecast-adjustment");
  process.stdout.write(JSON.stringify({
    bundleNodes: nodes.filter(({ path }) => /config\\\/forecast-adjustments\\\/ballydidean\\\/bundles\\\/sha256-[a-f0-9]{64}\\.json$/u.test(path)),
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
