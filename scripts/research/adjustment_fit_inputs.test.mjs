import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  lstat,
  opendir,
  readFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import {
  ADJUSTMENT_FIT_INPUTS_CONTRACT_VERSION,
  ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST,
  runAdjustmentFitWithInput,
  withAdjustmentFitSnapshots,
} from "./adjustment_fit_inputs.mjs";
import {
  ADJUSTMENT_FIT_FAMILY_ENTRIES,
  AdjustmentFitSandboxError,
} from "./adjustment_fit_sandbox.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

// enumerate one snapshot without following any links
async function snapshotEntries(root) {
  const pending = [root];
  const entries = [];

  // inspect every created directory and leaf
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    const directory = await opendir(directoryPath);

    try {
      // retain every entry after explicit metadata inspection
      for await (const entry of directory) {
        const path = join(directoryPath, entry.name);
        const metadata = await lstat(path);
        entries.push({
          metadata,
          path: relative(root, path),
        });

        // descend only into verified ordinary directories
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          pending.push(path);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

// list only roots owned by the fitter input constructor
function fitSnapshotRoots() {
  return readdirSync("/dev/shm").filter((name) =>
    name.startsWith("weather-adjustment-fit-code-") ||
    name.startsWith("weather-adjustment-fit-input-")).sort();
}

// prove each family uses only exact reviewed regular public code
test("fit snapshots copy the closed real-family source allowlists", async () => {
  assert.deepEqual(Object.keys(ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST).sort(), [
    "rain",
    "temperature",
    "wind",
  ]);
  const builtForecastAdjustment = readdirSync(join(
    REPOSITORY_ROOT,
    "packages/forecast-adjustment/dist",
  )).filter((name) => name.endsWith(".js")).sort();

  // force review when the built package gains another runtime module
  for (const family of ["rain", "wind"]) {
    const packaged = ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST[family]
      .filter((entry) =>
        entry.destination.includes("forecast-adjustment/dist/"))
      .map((entry) => entry.destination.split("/").at(-1))
      .sort();
    assert.deepEqual(packaged, builtForecastAdjustment);
    assert.equal(
      ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST[family].some((entry) =>
        entry.source.startsWith("packages/forecast-adjustment/dist/")),
      false,
    );
  }

  // construct every family layout rather than accepting an unexercised list
  for (const family of ["temperature", "rain", "wind"]) {
    const allowlist = ADJUSTMENT_FIT_PUBLIC_CODE_ALLOWLIST[family];
    const destinations = allowlist.map((entry) => entry.destination);
    assert.equal(new Set(destinations).size, destinations.length);
    assert.equal(
      allowlist.some((entry) =>
        entry.destination === ADJUSTMENT_FIT_FAMILY_ENTRIES[family].arguments[0]),
      true,
    );
    assert.equal(allowlist.some((entry) => /(?:^|\/)(?:\.ssh|\.npmrc|package-lock\.json)(?:$|\/)/u
      .test(entry.source)), false);
    let codeRoot;
    let inputRoot;

    // inspect the bounded snapshot only inside its guaranteed cleanup scope
    await withAdjustmentFitSnapshots({
      family,
      input: {
        contractVersion: `${family}-fixture/v1`,
        nested: { a: 1, z: 2 },
      },
    }, async (snapshots) => {
      codeRoot = snapshots.codeRoot;
      inputRoot = snapshots.inputRoot;
      assert.equal(snapshots.contractVersion, ADJUSTMENT_FIT_INPUTS_CONTRACT_VERSION);
      assert.equal(snapshots.codeSnapshot.fileCount, allowlist.length);
      assert.equal(snapshots.inputSnapshot.fileCount, 1);
      const codeEntries = await snapshotEntries(snapshots.codeRoot);
      const inputEntries = await snapshotEntries(snapshots.inputRoot);

      // require owner-private directories and immutable nonlinked files
      for (const { metadata } of [...codeEntries, ...inputEntries]) {
        assert.equal(metadata.isSymbolicLink(), false);

        // retain exact private directory modes
        if (metadata.isDirectory()) {
          assert.equal(metadata.mode & 0o777, 0o700);
          assert.equal(metadata.uid, process.getuid());
        } else {
          assert.equal(metadata.isFile(), true);
          assert.equal(metadata.mode & 0o777, 0o400);
          assert.equal(metadata.nlink, 1);
          assert.equal(metadata.uid, process.getuid());
        }
      }

      // byte-compare every copied file to its reviewed repository source
      for (const { destination, source } of allowlist) {
        assert.deepEqual(
          await readFile(join(snapshots.codeRoot, destination)),
          await readFile(join(REPOSITORY_ROOT, source)),
        );
      }

      assert.equal(
        await readFile(
          join(snapshots.inputRoot, ADJUSTMENT_FIT_FAMILY_ENTRIES[family].inputFilename),
          "utf8",
        ),
        `{"contractVersion":"${family}-fixture/v1","nested":{"a":1,"z":2}}\n`,
      );

      // node package destinations must be ordinary directories rather than links
      if (family !== "temperature") {
        const nodeModules = await lstat(join(snapshots.codeRoot, "node_modules"));
        assert.equal(nodeModules.isDirectory(), true);
        assert.equal(nodeModules.isSymbolicLink(), false);
      }
    });

    await assert.rejects(lstat(codeRoot), (error) => error.code === "ENOENT");
    await assert.rejects(lstat(inputRoot), (error) => error.code === "ENOENT");
  }
});

// reject private material and nonfinite input before creating tmpfs roots
test("fit snapshots reject private paths, credentials, and nonfinite input", async () => {
  const before = fitSnapshotRoots();
  const cyclic = {};
  cyclic.self = cyclic;
  const requests = [
    { family: "temperature", input: { credential: "not-allowed" } },
    { family: "rain", input: { value: "/home/ubuntu/private" } },
    { family: "wind", input: { value: Number.NaN } },
    { family: "temperature", input: cyclic },
    { family: "unknown", input: {} },
  ];

  // fail if an invalid request ever reaches its bounded operation
  const attempt = (request) => withAdjustmentFitSnapshots(request, async () => {
    assert.fail("invalid fit input reached its snapshot operation");
  });

  // require every unsafe input shape to fail before allocation
  for (const request of requests) {
    await assert.rejects(attempt(request), RangeError);
  }

  await assert.rejects(
    attempt({ family: "temperature", input: {}, extra: true }),
    RangeError,
  );
  assert.deepEqual(fitSnapshotRoots(), before);
});

// prove the integrated launcher closes snapshots on a preflight failure
test("fit input runner destroys snapshots on every sandbox exit", async () => {
  const before = fitSnapshotRoots();
  await assert.rejects(
    runAdjustmentFitWithInput({
      family: "temperature",
      input: { contractVersion: "invalid-before-process/v1" },
      runtimeReadiness: {},
      runtimeReadinessSha256: "a".repeat(64),
    }),
    (error) => error instanceof AdjustmentFitSandboxError &&
      error.reason === "request_invalid",
  );
  assert.deepEqual(fitSnapshotRoots(), before);
});
