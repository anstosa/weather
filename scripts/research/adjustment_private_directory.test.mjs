import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ensureAdjustmentPrivateDirectory } from "./adjustment_private_directory.mjs";

// isolate the HOME override inside a disposable child process only
function run(home, kind) {
  const source = `import { ensureAdjustmentPrivateDirectory } from ${JSON.stringify(import.meta.url.replace(".test.mjs", ".mjs"))};
try { await ensureAdjustmentPrivateDirectory(${JSON.stringify(kind)}); process.stdout.write('ready'); }
catch { process.stdout.write('refused'); }`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", env: { HOME: home, PATH: process.env.PATH },
  });
}

// no configurable production path is exposed by the safe initializer
test("private directory initializer accepts only fixed kinds", async () => {
  await assert.rejects(ensureAdjustmentPrivateDirectory("/tmp/untrusted"));
});

// every newly created child is private and a second call is idempotent
test("private directory initializer creates fixed owner-only children", async () => {
  const home = await mkdtemp("/dev/shm/weather-adjustment-private-home-");
  try {
    assert.equal(run(home, "archive"), "ready");
    assert.equal(run(home, "archive"), "ready");
    let path = home;
    for (const segment of [".weather", "adjustment-maintenance", "v2", "archive-primary", "objects"]) {
      path = join(path, segment);
      assert.equal((await lstat(path)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// rejection must happen before following an ancestor link or changing its mode
test("private directory initializer leaves linked and broadly accessible ancestors untouched", async () => {
  const home = await mkdtemp("/dev/shm/weather-adjustment-private-home-");
  const target = await mkdtemp("/dev/shm/weather-adjustment-private-target-");
  try {
    await chmod(target, 0o755);
    await symlink(target, join(home, ".weather"));
    assert.equal(run(home, "state"), "refused");
    assert.deepEqual(await readdir(target), []);
    assert.equal((await lstat(target)).mode & 0o777, 0o755);
    await rm(join(home, ".weather"));
    await mkdir(join(home, ".weather"), { mode: 0o755 });
    await chmod(join(home, ".weather"), 0o755);
    assert.equal(run(home, "archive"), "refused");
    assert.deepEqual(await readdir(join(home, ".weather")), []);
    assert.equal((await lstat(join(home, ".weather"))).mode & 0o777, 0o755);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
