import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";
const image = "node:24-alpine";
const target = "/run/weather/adjustment-candidate-catalog.json";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// encode one bounded v2 catalog receipt marker
function catalogBytes(actionSha256) {
  return Buffer.from(`${JSON.stringify({
    contractVersion: "adjustment-family-catalog/v2",
    entries: [{
      family: "temperature",
      receipt: {
        actionSha256,
        contractVersion: "adjustment-installed-candidate-receipt/v2",
      },
      slot: "shadow",
    }],
  })}\n`);
}

// run one cached image without network or writable container state
async function docker(arguments_, options = {}) {
  return await executeFile("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 60_000,
    ...options,
  });
}

// replace the fixture catalog through one root container rename
async function publishRootCatalog(directory, bytes) {
  const script = [
    'const fs=require("node:fs")',
    'const path="/fixture/adjustment-candidate-catalog.json"',
    'const temporary=`${path}.incoming`',
    'const bytes=Buffer.from(process.env.CATALOG_BASE64,"base64")',
    'const descriptor=fs.openSync(temporary,"wx",0o600)',
    'fs.writeFileSync(descriptor,bytes)',
    'fs.fsyncSync(descriptor)',
    'fs.closeSync(descriptor)',
    'fs.chmodSync(temporary,0o644)',
    'fs.renameSync(temporary,path)',
    'const directoryDescriptor=fs.openSync("/fixture","r")',
    'fs.fsyncSync(directoryDescriptor)',
    'fs.closeSync(directoryDescriptor)',
  ].join(";");
  await docker([
    "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
    "--pids-limit", "32", "--memory", "64m", "--user", "0:0",
    "--env", `CATALOG_BASE64=${bytes.toString("base64")}`,
    "--mount", `type=bind,src=${directory},dst=/fixture`,
    "--entrypoint", "node", image, "--eval", script,
  ]);
}

// read the mounted receipt identity from one already-created container
async function readMountedReceipt(container) {
  const script = [
    'const fs=require("node:fs")',
    `const value=JSON.parse(fs.readFileSync(${JSON.stringify(target)},"utf8"))`,
    'process.stdout.write(value.entries[0].receipt.actionSha256)',
  ].join(";");
  const output = await docker(["exec", container, "node", "--eval", script]);
  return output.stdout;
}

// prove file-bind recreation observes an atomic root catalog replacement
test("catalog replacement precedes recreation while a running file bind retains its inode", {
  timeout: 120_000,
}, async (context) => {
  // require the explicit real-docker integration gate
  if (!runIntegration) {
    context.skip("set WEATHER_RUN_DEPLOY_INTEGRATION=1");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "weather-catalog-bind-"));
  const catalog = join(root, "adjustment-candidate-catalog.json");
  const suffix = `${process.pid}-${Date.now()}`;
  const first = `weather-catalog-bind-old-${suffix}`;
  const second = `weather-catalog-bind-new-${suffix}`;

  try {
    await publishRootCatalog(root, catalogBytes(HASH_A));
    const before = await lstat(catalog);
    assert.equal(before.uid, 0);
    assert.equal(before.mode & 0o777, 0o644);
    assert.equal(before.nlink, 1);
    await docker([
      "run", "--detach", "--name", first, "--pull", "never", "--network", "none",
      "--read-only", "--pids-limit", "32", "--memory", "64m",
      "--mount", `type=bind,src=${catalog},dst=${target},readonly`,
      "--entrypoint", "node", image, "--eval", "setInterval(()=>{},60000)",
    ]);
    assert.equal(await readMountedReceipt(first), HASH_A);

    await publishRootCatalog(root, catalogBytes(HASH_B));
    const after = await lstat(catalog);
    assert.equal(after.uid, 0);
    assert.equal(after.mode & 0o777, 0o644);
    assert.equal(after.nlink, 1);
    assert.notEqual(after.ino, before.ino);
    assert.deepEqual(await readFile(catalog), catalogBytes(HASH_B));
    assert.equal(await readMountedReceipt(first), HASH_A);

    await docker([
      "run", "--detach", "--name", second, "--pull", "never", "--network", "none",
      "--read-only", "--pids-limit", "32", "--memory", "64m",
      "--mount", `type=bind,src=${catalog},dst=${target},readonly`,
      "--entrypoint", "node", image, "--eval", "setInterval(()=>{},60000)",
    ]);
    assert.equal(await readMountedReceipt(second), HASH_B);
  } finally {
    // remove only the two uniquely named disposable readers
    for (const container of [first, second]) {
      await docker(["rm", "--force", container]).catch(() => undefined);
    }
    await rm(root, { force: true, recursive: true });
  }
});
