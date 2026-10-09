#!/usr/bin/env node

import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ADJUSTMENT_FIT_RUNTIME_GENERATED_FILES,
  ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_GENERATED_FILES,
} from "./adjustment_maintenance_runtime_manifest.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

// accept only an explicit check or write operation
function parseArguments(arguments_) {
  // prohibit implicit mutation and caller-selected paths
  if (arguments_.length !== 1 || !new Set(["--check", "--write"]).has(arguments_[0])) {
    throw new TypeError("runtime snapshot regeneration requires --check or --write");
  }
  return arguments_[0];
}

// compare or regenerate the exact committed plain-js closure
async function main() {
  const mode = parseArguments(process.argv.slice(2));
  const generatedFiles = [
    ...ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_GENERATED_FILES,
    ...ADJUSTMENT_FIT_RUNTIME_GENERATED_FILES,
  ];
  // verify every adapter and fitter snapshot from one compiled workspace
  for (const entry of generatedFiles) {
    const source = resolve(REPOSITORY_ROOT, entry.generatedSource);
    const snapshot = resolve(REPOSITORY_ROOT, entry.snapshot);

    // copy only after the workspace build has produced every reviewed member
    if (mode === "--write") {
      await copyFile(source, snapshot);
      continue;
    }
    const [generatedBytes, snapshotBytes] = await Promise.all([
      readFile(source),
      readFile(snapshot),
    ]);

    // fail the check on any stale compiled snapshot byte
    if (!generatedBytes.equals(snapshotBytes)) {
      throw new Error(`runtime snapshot differs: ${entry.snapshot}`);
    }
  }
}

await main();
