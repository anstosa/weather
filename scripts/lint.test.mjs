import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const lintScript = join(repoRoot, "scripts/lint.mjs");

// include native source while excluding generated native output trees
test("lint scans authored native text without walking build artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-native-lint-"));

  try {
    await writeFile(join(root, "Weather.swift"), "let weather = true\n");
    await writeFile(join(root, "GenerateBrandAssets.java"), "final class GenerateBrandAssets {}\n");

    // populate every ignored native output boundary with invalid text
    for (const directory of [".artifacts", ".gradle", "build", "DerivedData", "host-evidence"]) {
      const generated = join(root, directory);
      await mkdir(generated);
      await writeFile(join(generated, "Generated.swift"), "let generated = true   \n");
    }

    const result = await executeFile(process.execPath, [lintScript, root], { cwd: repoRoot });
    assert.match(result.stdout, /Linted 2 files\./u);

    await writeFile(join(root, "Widget.kt"), "val widget = true   \n");
    await assert.rejects(
      executeFile(process.execPath, [lintScript, root], { cwd: repoRoot }),
      // require the authored native file to fail text lint
      (error) => `${error.stdout}${error.stderr}`.includes("Widget.kt:1: trailing whitespace"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
