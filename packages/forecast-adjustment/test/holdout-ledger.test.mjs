import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalObjectSha256,
  createForecastAdjustmentPreregistration,
  isHoldoutLedgerLocked,
  parseHoldoutLedger,
  withGuardedHoldoutAccess,
} from "../dist/index.js";

import { createHoldoutFixture } from "./evidence-fixtures.mjs";

test("holdout marker is durable and lock released before member open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-"));
  const { marker } = await createHoldoutFixture(directory);
  const bytes = await readFile(join(directory, "ledger.jsonl"), "utf8");
  const parsed = parseHoldoutLedger(bytes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].markerSha256, marker.markerSha256);
  assert.equal(await isHoldoutLedgerLocked(directory), false);
});

// reject an invalid regular-file ledger directory
test("holdout lock status exposes non-directory filesystem failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-invalid-"));
  const regularFile = join(directory, "not-a-directory");
  await writeFile(regularFile, "not a directory", "utf8");

  await assert.rejects(
    isHoldoutLedgerLocked(regularFile),
    /holdout ledger lock status cannot be read \(ENOTDIR\)/u,
  );
});

test("crash after durable marker burns interval and shifted overlap rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-crash-"));
  const { candidate, lineage, preregistration } =
    await createHoldoutFixture(directory);
  const shifted = createForecastAdjustmentPreregistration({
    algorithmImplementationSha256:
      preregistration.algorithmImplementationSha256,
    candidate,
    holdoutEndExclusive: "2026-02-08T08:00:00.000Z",
    holdoutEndLocalDate: "2026-02-07",
    holdoutStartInclusive: "2026-01-09T08:00:00.000Z",
    holdoutStartLocalDate: "2026-01-09",
    snapshotManifestSha256: preregistration.snapshotManifestSha256,
  });
  await assert.rejects(
    withGuardedHoldoutAccess(
      {
        candidate,
        directory,
        lineage,
        preregistration: shifted,
      },
      async () => assert.fail("shifted holdout member opened"),
    ),
    /strictly after/u,
  );

  const disjoint = createForecastAdjustmentPreregistration({
    algorithmImplementationSha256:
      preregistration.algorithmImplementationSha256,
    candidate,
    holdoutEndExclusive: "2026-03-09T07:00:00.000Z",
    holdoutEndLocalDate: "2026-03-08",
    holdoutStartInclusive: "2026-02-07T08:00:00.000Z",
    holdoutStartLocalDate: "2026-02-07",
    snapshotManifestSha256: preregistration.snapshotManifestSha256,
  });
  let opened = false;
  await withGuardedHoldoutAccess(
    {
      candidate,
      directory,
      lineage,
      onDurableMarker: async () => {
        assert.equal(await isHoldoutLedgerLocked(directory), false);
      },
      preregistration: disjoint,
    },
    async () => {
      opened = true;
    },
  );
  assert.equal(opened, true);
  assert.equal(
    parseHoldoutLedger(await readFile(join(directory, "ledger.jsonl"), "utf8"))
      .length,
    2,
  );
});

test("an error immediately after append burns interval before member access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-burn-"));
  const seedDirectory = await mkdtemp(join(tmpdir(), "weather-holdout-seed-"));
  const { candidate, lineage, preregistration } =
    await createHoldoutFixture(seedDirectory);
  let memberOpened = false;
  await assert.rejects(
    withGuardedHoldoutAccess(
      {
        candidate,
        directory,
        lineage,
        onDurableMarker: () => {
          throw new Error("simulated crash");
        },
        preregistration,
      },
      async () => {
        memberOpened = true;
      },
    ),
    /simulated crash/u,
  );
  assert.equal(memberOpened, false);
  const markers = parseHoldoutLedger(
    await readFile(join(directory, "ledger.jsonl"), "utf8"),
  );
  assert.equal(markers.length, 1);
  await assert.rejects(
    withGuardedHoldoutAccess(
      { candidate, directory, lineage, preregistration },
      async () => undefined,
    ),
    /strictly after/u,
  );
});

test("SIGKILL leaves a burned interval and a dead-owner lock is recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-kill-"));
  const seedDirectory = await mkdtemp(join(tmpdir(), "weather-holdout-kill-seed-"));
  const { candidate, lineage, preregistration } =
    await createHoldoutFixture(seedDirectory);
  const inputPath = join(directory, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({ candidate, directory, lineage, preregistration }),
  );
  const modulePath = new URL("../dist/index.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readFile } from "node:fs/promises"; import { withGuardedHoldoutAccess } from ${JSON.stringify(modulePath)}; const input=JSON.parse(await readFile(${JSON.stringify(inputPath)},"utf8")); await withGuardedHoldoutAccess({...input,afterDurableAppendBeforeLockRelease:()=>process.kill(process.pid,"SIGKILL")},async()=>{throw new Error("opened")});`,
    ],
    { stdio: "ignore" },
  );
  const exit = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.signal, "SIGKILL");
  assert.equal(await isHoldoutLedgerLocked(directory), true);
  await assert.rejects(
    withGuardedHoldoutAccess(
      { candidate, directory, lineage, preregistration },
      async () => assert.fail("burned holdout opened"),
    ),
    /strictly after/u,
  );
  assert.equal(await isHoldoutLedgerLocked(directory), false);
});

test("forged candidate lineage rejects before lock or ledger creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-lineage-"));
  const seedDirectory = await mkdtemp(join(tmpdir(), "weather-holdout-lineage-seed-"));
  const { candidate, lineage, preregistration } =
    await createHoldoutFixture(seedDirectory);
  await assert.rejects(
    withGuardedHoldoutAccess(
      {
        candidate,
        directory,
        lineage: { ...lineage, dataset: "forged" },
        preregistration,
      },
      async () => assert.fail("forged lineage opened holdout"),
    ),
    /immutable candidate/u,
  );
  assert.equal(await isHoldoutLedgerLocked(directory), false);
  await assert.rejects(readFile(join(directory, "ledger.jsonl")), /ENOENT/u);
});

test("cascading candidate and preregistration rehash cannot mint a burn lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-holdout-cascade-"));
  const seedDirectory = await mkdtemp(join(tmpdir(), "weather-holdout-cascade-seed-"));
  const { candidate, lineage, preregistration } =
    await createHoldoutFixture(seedDirectory);
  const forgedCandidate = {
    ...candidate,
    forecastIdentity: {
      ...candidate.forecastIdentity,
      contractEpoch: "legacy-v4/forged",
      dataset: "forged",
    },
  };
  forgedCandidate.candidateArtifactSha256 = canonicalObjectSha256(
    forgedCandidate,
    "candidateArtifactSha256",
  );
  const forgedPreregistration = {
    ...preregistration,
    candidateArtifactSha256: forgedCandidate.candidateArtifactSha256,
  };
  forgedPreregistration.preregistrationSha256 = canonicalObjectSha256(
    forgedPreregistration,
    "preregistrationSha256",
  );
  await assert.rejects(
    withGuardedHoldoutAccess(
      {
        candidate: forgedCandidate,
        directory,
        lineage: {
          ...lineage,
          contractEpoch: "legacy-v4/forged",
          dataset: "forged",
        },
        preregistration: forgedPreregistration,
      },
      async () => assert.fail("forged cascade opened holdout"),
    ),
    /forecast identity is not canonical/u,
  );
  assert.equal(await isHoldoutLedgerLocked(directory), false);
  await assert.rejects(readFile(join(directory, "ledger.jsonl")), /ENOENT/u);
});
