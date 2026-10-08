import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES,
  ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION,
  AdjustmentCyclePageDiskPorts,
  AdjustmentEvidenceArchiveTransport,
  AdjustmentEvidenceScheduler,
  AdjustmentEvidenceStore,
  createAdjustmentEvidenceCaptureV2,
  currentAdjustmentEvidenceDue,
  evaluateAdjustmentEvidenceSchedulerAdmission,
  createAdjustmentEvidenceCapture,
  freezeAdjustmentEvidenceSnapshot,
  normalizeAdjustmentEvidenceWindow,
  runAdjustmentArchiveCommand,
} from "../scripts/adjustment-evidence-store.mjs";
import {
  ackCyclePage,
  appendCyclePageFailOpen,
  createCyclePageState,
} from "../../scripts/research/adjustment_cycle_pages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const hashes = {
  rain: "a".repeat(64),
  temperature: "b".repeat(64),
  temperatureAuthorization: "c".repeat(64),
  wind: "d".repeat(64),
  windAuthorization: "e".repeat(64),
  windCandidate: "f".repeat(64),
};

// build one public filtered forecast row
function forecastRow(index = 0, overrides = {}) {
  const validAt = new Date(Date.parse("2026-10-07T08:00:00.000Z") + index * 3_600_000).toISOString();
  return {
    adjustment: {
      adjustedMetrics: { windGustMps: 3.5, windSpeedMps: 2.25 },
      appliedMetrics: ["windGustMps", "windSpeedMps"],
      authorizationSha256: hashes.windAuthorization,
      candidateArtifactSha256: hashes.windCandidate,
      leadBand: "001-024",
      reasonCode: null,
      state: "active",
    },
    freshness: { ageSeconds: 1, label: "fresh", status: "fresh" },
    id: String(index + 1),
    metadata: {
      provider: { dataset: "best_match" },
      upstream: { model: "best_match", timezone: "America/Los_Angeles" },
    },
    metrics: {
      precipitationMm: 0.2,
      temperatureC: 12.5,
      windGustMps: 4,
      windSpeedMps: 2.5,
    },
    productRunAt: "2026-10-07T00:00:00.000Z",
    provenance: {
      providerKey: "open-meteo",
      sourceId: "12",
      sourceKey: "open-meteo-forecast-v4",
    },
    rainAdjustment: {
      bundleSha256: hashes.rain,
      correctedPrecipitationMm: 0.15,
      rawBestMatchPrecipitationMm: 0.2,
      reasonCode: null,
      sourceForecast: {
        decisionAt: "2026-10-07T02:00:00.000Z",
        firstReceivedAt: "2026-10-07T00:05:00.000Z",
        modelLeadHours: 8 + index,
        providerKey: "open-meteo",
        rawPrecipitationMm: 0.25,
        runInitializedAt: "2026-10-07T00:00:00.000Z",
        upstreamModel: "ecmwf_ifs",
        validAt,
      },
      state: "active",
    },
    receivedAt: "2026-10-07T00:06:00.000Z",
    revisionCount: 2,
    temperatureAdjustment: {
      branch: "direct",
      bundleSha256: hashes.temperature,
      correctedTemperatureC: 12,
      rawBestMatchTemperatureC: 12.5,
      reasonCode: null,
      sourceForecast: {
        adapterVersion: "v1",
        dataset: "single_run",
        firstReceivedAt: "2026-10-07T00:04:00.000Z",
        modelCycle: "50r1",
        modelLeadHours: 8 + index,
        operationalHorizonHours: 2 + index,
        providerKey: "open-meteo",
        providerResponseSha256: "1".repeat(64),
        rawRelativeHumidityPercent: 75,
        rawTemperatureC: 11.5,
        rawWindSpeedMps: 3,
        runInitializedAt: "2026-10-07T00:00:00.000Z",
        upstreamModel: "ecmwf_ifs",
        validAt,
      },
      state: "active",
    },
    validAt,
    ...overrides,
  };
}

// build one post-settings response body
function forecastBody(rows = [forecastRow()], overrides = {}) {
  return Buffer.from(`${JSON.stringify({
    adjustmentRuntime: {
      activeBundle: hashes.wind,
      authorizationSha256: hashes.windAuthorization,
      candidateArtifactSha256: hashes.windCandidate,
      loadedAt: "2026-10-07T00:07:00.000Z",
      state: "active",
    },
    adjustmentSettings: { rain: true, temperature: true, version: 1, wind: true },
    data: rows,
    days: 1,
    generatedAt: "2026-10-07T00:08:00.000Z",
    rainAdjustmentRuntime: {
      activeBundle: hashes.rain,
      loadedAt: "2026-10-07T00:07:00.000Z",
      state: "active",
    },
    temperatureAdjustmentRuntime: {
      activeBundle: hashes.temperature,
      authorizationSha256: hashes.temperatureAuthorization,
      loadedAt: "2026-10-07T00:07:00.000Z",
      state: "active",
    },
    ...overrides,
  })}\n`);
}

// provide measured production headroom and ample inodes
function healthyStatfs() {
  return {
    bavail: 2_050_711_552n / 4_096n,
    bsize: 4_096n,
    ffree: 100_000n,
  };
}

// measure the immutable ledger's real filesystem allocation
async function evidenceAllocation(root) {
  let bytes = 0;
  let objects = 0;

  // include every final object and receipt allocation
  for (const directory of ["objects", "receipts"]) {
    const names = await readdir(join(root, directory));

    // measure one retained immutable entry
    for (const name of names) {
      const details = await lstat(join(root, directory, name), { bigint: true });
      bytes += Number(details.blocks * 512n);
    }

    // retain only the content-object count
    if (directory === "objects") {
      objects = names.length;
    }
  }

  return { bytes, objects };
}

// preserve stable content across response-ephemeral fields and mutable receipt time
test("capture excludes generated, freshness, loaded and mutable received times", () => {
  const first = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
  const changedRow = forecastRow(0, {
    freshness: { ageSeconds: 900, label: "late", status: "stale" },
    receivedAt: "2026-10-07T00:16:00.000Z",
  });
  const second = createAdjustmentEvidenceCapture(forecastBody([changedRow], {
    generatedAt: "2026-10-07T00:18:00.000Z",
  }), "days=1");

  assert.equal(first.edgeReceiptIdentitySha256, second.edgeReceiptIdentitySha256);
  assert.equal(first.objectSha256, second.objectSha256);
  assert.deepEqual(first.object, second.object);
  assert.notDeepEqual(first.availability, second.availability);
  assert.equal(first.object.rows[0].provenanceComplete, false);
});

// retain each family's exact public decision states
test("capture accepts wind not_applicable without widening source-family states", () => {
  const fallback = forecastRow(0, {
    adjustment: {
      adjustedMetrics: {},
      appliedMetrics: [],
      reasonCode: "unsupported_lead",
      state: "not_applicable",
    },
    rainAdjustment: { ...forecastRow().rainAdjustment, state: "raw_fallback" },
    temperatureAdjustment: { ...forecastRow().temperatureAdjustment, state: "raw_fallback" },
  });
  const capture = createAdjustmentEvidenceCapture(forecastBody([fallback, forecastRow(1)]), "days=1");
  assert.equal(capture.object.rows[0].windAdjustment.state, "not_applicable");
  assert.equal(capture.object.rows[0].rainAdjustment.state, "raw_fallback");
  assert.equal(capture.object.rows[0].temperatureAdjustment.state, "raw_fallback");
  assert.equal(capture.object.rows[1].windAdjustment.state, "active");

  // reject states belonging only to another family
  for (const [family, state] of [
    ["adjustment", "raw_fallback"],
    ["temperatureAdjustment", "not_applicable"],
    ["rainAdjustment", "not_applicable"],
    ["adjustment", "unknown"],
    ["temperatureAdjustment", "unknown"],
    ["rainAdjustment", "unknown"],
    ["adjustment", null],
  ]) {
    const row = forecastRow();
    row[family] = { ...row[family], state };
    assert.throws(() => createAdjustmentEvidenceCapture(forecastBody([row]), "days=1"), /state is invalid/u);
  }
});

// detect stable identity collisions without mutating record identity
test("same stable row identity with changed scoring content creates a different object", () => {
  const first = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
  const changed = forecastRow(0, {
    metrics: {
      ...forecastRow().metrics,
      windSpeedMps: 9,
    },
  });
  const second = createAdjustmentEvidenceCapture(forecastBody([changed]), "days=1");

  assert.equal(first.edgeReceiptIdentitySha256, second.edgeReceiptIdentitySha256);
  assert.notEqual(first.objectSha256, second.objectSha256);
});

// retain one exclusive first receipt and freeze all valid pairs
test("store converges duplicates, blocks collisions, and freezes a validated watermark", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-evidence-"));
  const store = await new AdjustmentEvidenceStore({
    now: () => new Date("2026-10-07T01:00:00.000Z"),
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();

  try {
    const first = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
    assert.deepEqual(
      await store.commit(first, "2026-10-07T01:00:00.000Z"),
      { status: "created" },
    );

    const retry = createAdjustmentEvidenceCapture(forecastBody([
      forecastRow(0, { receivedAt: "2026-10-07T00:30:00.000Z" }),
    ]), "days=1");
    assert.deepEqual(
      await store.commit(retry, "2026-10-07T01:30:00.000Z"),
      { status: "duplicate" },
    );

    const receiptPath = join(
      root,
      "receipts",
      `sha256-${first.edgeReceiptIdentitySha256}.json`,
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.firstEdgeCommittedAt, "2026-10-07T01:00:00.000Z");
    assert.deepEqual(receipt.availability.timestamps, ["2026-10-07T00:06:00.000Z"]);

    const changed = forecastRow(0, {
      metrics: { ...forecastRow().metrics, temperatureC: 99 },
    });
    const collision = createAdjustmentEvidenceCapture(forecastBody([changed]), "days=1");
    assert.deepEqual(
      await store.commit(collision, "2026-10-07T02:00:00.000Z"),
      { status: "identity_collision" },
    );

    // refuse repeated collisions before creating any new content object
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(
        await store.commit(collision, "2026-10-07T02:00:00.000Z"),
        { status: "identity_collision" },
      );
    }
    assert.equal(store.status().collisions, 1);
    assert.deepEqual(
      { bytes: store.status().bytes, objects: store.status().objects },
      await evidenceAllocation(root),
    );

    const snapshot = await freezeAdjustmentEvidenceSnapshot({
      now: () => new Date("2026-10-07T02:30:00.000Z"),
      root,
    });
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].edgeReceiptIdentitySha256, first.edgeReceiptIdentitySha256);
    assert.match(snapshot.watermarkSha256, /^[a-f0-9]{64}$/u);
    const compressed = await readFile(snapshot.entries[0].objectPath);
    assert.deepEqual(JSON.parse(gunzipSync(compressed)), first.object);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// account both immutable objects when two writers race one stable receipt
test("cross-writer receipt collision accounts the retained orphan object", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-race-"));
  let waiting = 0;
  let release;
  const gate = new Promise(
    // release both writers only after their receipt prechecks
    (resolveGate) => { release = resolveGate; },
  );
  // align two independent store instances at object publication
  async function beforeObjectWrite() {
    waiting += 1;

    // release the pair after both writers reach the barrier
    if (waiting === 2) {
      release();
    }
    await gate;
  }
  const firstStore = await new AdjustmentEvidenceStore({
    beforeObjectWrite,
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();
  const secondStore = await new AdjustmentEvidenceStore({
    beforeObjectWrite,
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();

  try {
    const first = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
    const changed = forecastRow(0, {
      metrics: { ...forecastRow().metrics, temperatureC: 13.25 },
    });
    const second = createAdjustmentEvidenceCapture(forecastBody([changed]), "days=1");
    const results = await Promise.all([
      firstStore.commit(first, "2026-10-07T01:00:00.000Z"),
      secondStore.commit(second, "2026-10-07T01:00:00.000Z"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["created", "identity_collision"],
    );
    const collisionStore = results[0].status === "identity_collision"
      ? firstStore
      : secondStore;
    assert.equal(collisionStore.status().collisions, 1);
    assert.deepEqual(
      { bytes: collisionStore.status().bytes, objects: collisionStore.status().objects },
      await evidenceAllocation(root),
    );
    assert.equal(collisionStore.status().objects, 2);
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// account a retained partial final and stop all later capture after a write fault
test("partial exclusive-write failure is accounted and disables capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-partial-"));
  let faulted = false;
  // inject the former direct-final partial-write failure mode
  async function partialWriter(path, bytes) {
    const handle = await open(path, "wx", 0o600);

    try {
      await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2))));
      await handle.sync();
    } finally {
      await handle.close();
    }
    faulted = true;
    throw new Error("injected partial write failure");
  }
  const store = await new AdjustmentEvidenceStore({
    root,
    statfs: async () => healthyStatfs(),
    writeExclusive: partialWriter,
  }).initialize();

  try {
    const capture = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
    await assert.rejects(
      store.commit(capture, "2026-10-07T01:00:00.000Z"),
      /injected partial write failure/u,
    );
    assert.equal(faulted, true);
    assert.deepEqual(
      { bytes: store.status().bytes, objects: store.status().objects },
      await evidenceAllocation(root),
    );
    assert.equal(store.status().objects, 1);
    assert.equal(store.prepare(forecastBody(), "days=1"), null);
    assert.deepEqual(
      await store.commit(capture, "2026-10-07T01:01:00.000Z"),
      { status: "store_unavailable" },
    );
    assert.equal((await readdir(join(root, "objects"))).length, 1);
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 0);
    const restarted = await new AdjustmentEvidenceStore({ root }).initialize();
    assert.equal(restarted.status().asyncErrors, 1);
    assert.equal(restarted.prepare(forecastBody(), "days=1"), null);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// preserve the exact shared-filesystem floor without pruning
test("capacity refusal leaves immutable directories empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-capacity-"));
  const store = await new AdjustmentEvidenceStore({
    root,
    statfs: async () => ({
      bavail: 1_950_000_000n / 4_096n,
      bsize: 4_096n,
      ffree: 100_000n,
    }),
  }).initialize();

  try {
    const capture = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
    assert.deepEqual(
      await store.commit(capture, "2026-10-07T01:00:00.000Z"),
      { status: "capacity_exhausted" },
    );
    assert.equal(store.status().freeSpaceRefusal, 1);
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// keep immediate writes from borrowing the reserved next-capture allocation
test("evidence and page writes preserve the next-capture reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-reservation-"));
  const statfs =
    // expose exactly the readiness boundary before any allocation
    async () => ({
      bavail: BigInt(ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES),
      bsize: 1n,
      ffree: 100_000n,
    });
  const store = await new AdjustmentEvidenceStore({ root, statfs }).initialize();
  const ports = await new AdjustmentCyclePageDiskPorts({ root, statfs }).initialize();

  try {
    const capture = createAdjustmentEvidenceCapture(forecastBody(), "days=1");
    assert.deepEqual(
      await store.commit(capture, "2026-10-07T01:00:00.000Z"),
      { status: "capacity_exhausted" },
    );
    const state = createCyclePageState({
      dailyPageCount: 0,
      dueKey: "capture/2026-10-08T00:35:00.000Z",
      generation: "1",
      localDate: "2026-10-08",
    });
    const page = await appendCyclePageFailOpen(state, {
      payload: Buffer.from("reserved-page"),
      projections: [{ channel: "scheduler_request", identitySha256: "8".repeat(64) }],
    }, ports);
    assert.equal(page.status, "evidence_gap_persistence_refused");
    assert.deepEqual(await readdir(join(root, "objects")), []);
    assert.deepEqual(await readdir(join(root, "receipts")), []);
    assert.deepEqual(await readdir(join(root, "online-pages", "slots")), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// reject a linked root before creating or changing any target child
test("store and scheduler do not mutate through a configured root symlink", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-adjustment-linked-"));
  const target = join(parent, "target");
  const linkedRoot = join(parent, "linked-root");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linkedRoot);

  try {
    const store = await new AdjustmentEvidenceStore({ root: linkedRoot }).initialize();
    assert.equal(store.prepare(forecastBody(), "days=1"), null);
    const scheduler = await new AdjustmentEvidenceScheduler({
      enabled: true,
      migrationReady: true,
      root: linkedRoot,
      statfs: async () => healthyStatfs(),
    }).initialize();
    assert.equal(scheduler.status().activation, "state_unavailable");
    assert.deepEqual(await readdir(target), []);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

// retain the representative maximum row count under both object limits
test("deterministic gzip accepts 240 forecast rows", () => {
  const rows = Array.from({ length: 240 },
    // build one ordered ten-day response
    (_value, index) => forecastRow(index));
  const first = createAdjustmentEvidenceCapture(forecastBody(rows, { days: 10 }), "days=10");
  const second = createAdjustmentEvidenceCapture(forecastBody(rows, {
    days: 10,
    generatedAt: "2026-10-07T00:20:00.000Z",
  }), "days=10");

  assert.ok(Buffer.byteLength(JSON.stringify(first.object)) <= 512 * 1_024);
  assert.ok(first.compressedObject.byteLength <= 16 * 1_024);
  assert.deepEqual(first.compressedObject, second.compressedObject);
});

// attach writes only to finish and count an aborted close
test("response tracking never writes on close without finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-finish-"));
  const store = await new AdjustmentEvidenceStore({
    now: () => new Date("2026-10-07T01:00:00.000Z"),
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();

  try {
    const aborted = new EventEmitter();
    let abortedStatus;
    store.trackResponse(
      aborted,
      createAdjustmentEvidenceCapture(forecastBody(), "days=1"),
      // retain the genuine close-without-finish outcome
      (result) => { abortedStatus = result.status; },
    );
    aborted.emit("close");
    assert.equal(store.status().closeWithoutFinish, 1);
    assert.equal(abortedStatus, "response_aborted");
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 0);

    const finished = new EventEmitter();
    store.trackResponse(finished, createAdjustmentEvidenceCapture(forecastBody(), "days=1"));
    finished.emit("finish");
    finished.emit("close");
    await new Promise(
      // wait for the asynchronous post-finish write
      (resolveWait) => setTimeout(resolveWait, 20),
    );
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// normalize only direct daily and overnight API queries
test("window normalization rejects duplicate and caller-controlled shapes", () => {
  assert.equal(normalizeAdjustmentEvidenceWindow(new URL("https://weather.test/forecast")), "days=1");
  assert.equal(normalizeAdjustmentEvidenceWindow(new URL("https://weather.test/forecast?days=5")), "days=5");
  assert.equal(normalizeAdjustmentEvidenceWindow(new URL("https://weather.test/forecast?window=overnight")), "overnight");
  assert.equal(normalizeAdjustmentEvidenceWindow(new URL("https://weather.test/forecast?days=1&days=1")), null);
  assert.equal(normalizeAdjustmentEvidenceWindow(new URL("https://weather.test/forecast?surface=widget")), null);
});

// retain one in-memory scheduler state port across restart tests
function memorySchedulerStateStore(initial = null) {
  let state = initial;
  return {
    // keep the injected port initialization side-effect free
    async initialize() {
      return this;
    },
    // return one detached durable state image
    async read() {
      return state === null ? {
        activation: "not_initialized",
        attempts: [],
        contractVersion: "adjustment-evidence-scheduler-state/v1",
        errors: [],
        gaps: [],
        lastCheckedAt: null,
        updatedAt: null,
      } : structuredClone(state);
    },
    // retain only one detached current state image
    async write(value) {
      state = structuredClone(value);
    },
    // expose test-only durable state
    value() {
      return structuredClone(state);
    },
  };
}

// admit the fall-back DST row only through the v2 object reader
test("v2 capture accepts exactly 241 days=10 rows while v1 stays byte-compatible", async () => {
  const rows = Array.from({ length: 241 },
    // build one maximum fall-back forecast result
    (_value, index) => forecastRow(index, {
      receivedAt: new Date(Date.parse("2026-10-07T00:06:00.000Z") + index * 60_000).toISOString(),
    }));
  assert.throws(
    () => createAdjustmentEvidenceCapture(forecastBody(rows, { days: 10 }), "days=10"),
    /forecast evidence body is invalid/u,
  );
  const capture = createAdjustmentEvidenceCaptureV2(
    forecastBody(rows, { days: 10 }),
    "days=10",
  );
  assert.equal(capture.object.rows.length, 241);
  assert.equal(capture.object.contractVersion, "forecast-adjustment-evidence-object/v2");
  assert.ok(capture.compressedObject.byteLength <= 16 * 1_024);
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-v2-"));
  const store = await new AdjustmentEvidenceStore({
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();

  try {
    const prepared = store.prepareV2(forecastBody(rows, { days: 10 }), "days=10", "scheduler_request");
    assert.deepEqual(
      await store.commit(prepared, "2026-10-08T06:40:00.000Z"),
      { status: "created" },
    );
    const receipt = await readFile(
      join(root, "receipts", `sha256-${prepared.edgeReceiptIdentitySha256}.json`),
    );
    assert.ok(receipt.byteLength <= 2_048);
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root })).entries.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// bind the first trusted channel without relabelling an existing receipt
test("v2 channel assertion keeps separate identity and legacy first receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-channel-"));
  const store = await new AdjustmentEvidenceStore({
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();

  try {
    const prepared = store.prepareV2(forecastBody(), "days=1", "public_get");
    assert.deepEqual(
      await store.commit(prepared, "2026-10-08T00:40:00.000Z"),
      { status: "created" },
    );
    const retry = store.prepareV2(forecastBody(), "days=1", "scheduler_request");
    assert.deepEqual(
      await store.commit(retry, "2026-10-08T06:40:00.000Z"),
      { status: "duplicate" },
    );
    const bindingName = `sha256-${prepared.edgeReceiptIdentitySha256}.json`;
    const binding = JSON.parse(await readFile(join(root, "channel-bindings", bindingName), "utf8"));
    const assertion = JSON.parse(await readFile(
      join(root, "channels", `sha256-${binding.assertionSha256}.json`),
      "utf8",
    ));
    assert.equal(assertion.channel, "public_get");
    assert.notEqual(binding.assertionSha256, prepared.edgeReceiptIdentitySha256);

    const legacyBody = forecastBody([forecastRow(1)]);
    const legacy = createAdjustmentEvidenceCapture(legacyBody, "days=1");
    assert.deepEqual(
      await store.commit(legacy, "2026-10-08T00:41:00.000Z"),
      { status: "created" },
    );
    const migrated = store.prepareV2(legacyBody, "days=1", "scheduler_request");
    assert.deepEqual(
      await store.commit(migrated, "2026-10-08T06:41:00.000Z"),
      { status: "duplicate" },
    );
    const legacyBinding = JSON.parse(await readFile(
      join(root, "channel-bindings", `sha256-${legacy.edgeReceiptIdentitySha256}.json`),
      "utf8",
    ));
    const legacyAssertion = JSON.parse(await readFile(
      join(root, "channels", `sha256-${legacyBinding.assertionSha256}.json`),
      "utf8",
    ));
    assert.equal(legacyAssertion.channel, "legacy_unattributed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// calculate fixed UTC cycles with deterministic bounded jitter
test("scheduler selects one jittered current due and never crosses the finite end", () => {
  const due = currentAdjustmentEvidenceDue("2026-10-08T06:40:00.000Z");
  assert.equal(due.dueKey, "capture/2026-10-08T06:35:00.000Z");
  assert.ok(due.jitterSeconds >= 0 && due.jitterSeconds <= 299);
  assert.equal(due.scheduledAt, "2026-10-08T06:38:22.000Z");
  const beforeJitter = currentAdjustmentEvidenceDue("2026-10-08T06:36:00.000Z");
  assert.equal(beforeJitter.dueKey, "capture/2026-10-08T00:35:00.000Z");
  assert.equal(currentAdjustmentEvidenceDue("2027-10-08T00:00:00.000Z"), null);
});

// block activation at the measured Blueberry free-space value
test("scheduler capacity gate rejects the measured host headroom", async () => {
  const admission = await evaluateAdjustmentEvidenceSchedulerAdmission({
    enabled: true,
    migrationReady: true,
    now: new Date("2026-10-08T06:40:00.000Z"),
    root: "/unused",
    statfs: async () => ({
      bavail: 1_950_453_760n / 4_096n,
      bsize: 4_096n,
      ffree: 100_000n,
    }),
  });
  assert.equal(admission.active, false);
  assert.equal(admission.reason, "capacity_blocked");
  assert.equal(ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES, 2_034_155_520);

  const exact = await evaluateAdjustmentEvidenceSchedulerAdmission({
    enabled: true,
    migrationReady: true,
    now: new Date("2026-10-08T06:40:00.000Z"),
    root: "/unused",
    // expose the exact protected-floor plus reservation boundary
    statfs: async () => ({
      bavail: BigInt(ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES),
      bsize: 1n,
      ffree: 32_768n,
    }),
  });
  assert.equal(exact.active, true);
  const oneByteUnder = await evaluateAdjustmentEvidenceSchedulerAdmission({
    enabled: true,
    migrationReady: true,
    now: new Date("2026-10-08T06:40:00.000Z"),
    root: "/unused",
    // expose one byte less than the complete readiness boundary
    statfs: async () => ({
      bavail: BigInt(ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES - 1),
      bsize: 1n,
      ffree: 32_768n,
    }),
  });
  assert.equal(oneByteUnder.reason, "capacity_blocked");
  const oneBlockUnder = await evaluateAdjustmentEvidenceSchedulerAdmission({
    enabled: true,
    migrationReady: true,
    now: new Date("2026-10-08T06:40:00.000Z"),
    root: "/unused",
    // expose one filesystem block less than the readiness boundary
    statfs: async () => ({
      bavail: BigInt(ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES / 4_096 - 1),
      bsize: 4_096n,
      ffree: 32_768n,
    }),
  });
  assert.equal(oneBlockUnder.reason, "capacity_blocked");
  const protectedFloorOnly = await evaluateAdjustmentEvidenceSchedulerAdmission({
    enabled: true,
    migrationReady: true,
    now: new Date("2026-10-08T06:40:00.000Z"),
    root: "/unused",
    // expose the protected floor without the mandatory reservation
    statfs: async () => ({
      bavail: 2_030_043_136n,
      bsize: 1n,
      ffree: 32_768n,
    }),
  });
  assert.equal(protectedFloorOnly.reason, "capacity_blocked");
});

// run only the current catch-up and record older cycles as permanent gaps
test("scheduler catch-up runs once at current time without backdating", async () => {
  let now = new Date("2026-10-08T18:40:00.000Z");
  const stateStore = memorySchedulerStateStore({
    activation: "active",
    attempts: [],
    contractVersion: "adjustment-evidence-scheduler-state/v1",
    errors: [],
    gaps: [],
    lastCheckedAt: "2026-10-08T00:40:00.000Z",
    updatedAt: "2026-10-08T00:40:00.000Z",
  });
  const triggers = [];
  const scheduler = await new AdjustmentEvidenceScheduler({
    enabled: true,
    migrationReady: true,
    now: () => now,
    root: "/unused",
    stateStore,
    statfs: async () => healthyStatfs(),
    trigger: async (input) => {
      triggers.push(input);
      return { status: "created" };
    },
  }).initialize();
  const result = await scheduler.runDue();
  assert.equal(result.dueKey, "capture/2026-10-08T18:35:00.000Z");
  assert.equal(triggers[0].commitAt, now.toISOString());
  assert.equal(triggers[0].path, "/api/v1/sites/ballydidean/forecast?days=10");
  assert.deepEqual(
    stateStore.value().gaps.map((gap) => gap.dueKey),
    [
      "capture/2026-10-08T06:35:00.000Z",
      "capture/2026-10-08T12:35:00.000Z",
    ],
  );
  const restarted = await new AdjustmentEvidenceScheduler({
    enabled: true,
    migrationReady: true,
    now: () => now,
    root: "/unused",
    stateStore,
    statfs: async () => healthyStatfs(),
    trigger: async (input) => {
      triggers.push(input);
      return { status: "created" };
    },
  }).initialize();
  assert.equal((await restarted.runDue()).status, "current_already_processed");
  assert.equal(triggers.length, 1);
  now = new Date("2026-10-08T12:40:00.000Z");
  assert.equal((await restarted.runDue()).status, "clock_rollback");
  assert.equal(triggers.length, 1);
  now = new Date("2026-10-08T18:41:00.000Z");
});

// trigger the first clock tick without any incoming public request
test("scheduler start is traffic-independent and keeps bounded restart history", async () => {
  let now = new Date("2026-10-08T00:40:00.000Z");
  const stateStore = memorySchedulerStateStore();
  const triggers = [];
  let intervalCallback;
  let intervalCleared = false;
  const timer = { unref() {} };
  const scheduler = await new AdjustmentEvidenceScheduler({
    clearInterval: () => { intervalCleared = true; },
    enabled: true,
    migrationReady: true,
    now: () => now,
    root: "/unused",
    setInterval: (callback) => {
      intervalCallback = callback;
      return timer;
    },
    stateStore,
    statfs: async () => healthyStatfs(),
    trigger: async (input) => {
      triggers.push(input);
      const error = new Error("injected capture failure");
      error.code = "injected_failure";
      throw error;
    },
  }).initialize();
  assert.equal(scheduler.start(), true);
  await new Promise(
    // wait for the immediate asynchronous startup tick
    (resolveWait) => setTimeout(resolveWait, 10),
  );
  assert.equal(triggers.length, 1);
  assert.equal(typeof intervalCallback, "function");

  // exercise enough later cycles to prove bounded retention
  for (let index = 1; index < 40; index += 1) {
    now = new Date(Date.parse("2026-10-08T00:40:00.000Z") + index * 6 * 60 * 60 * 1_000);
    await scheduler.runDue();
  }
  assert.equal(scheduler.status().attempts.length, 40);
  assert.equal(scheduler.status().errors.length, 40);
  assert.equal(scheduler.status().gaps.length, 40);
  scheduler.stop();
  assert.equal(intervalCleared, true);
});

// keep only current and next payload slots and fsync a gap on refusal
test("online page disk ports rotate two slots and fail open on a third", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-pages-"));
  const ports = await new AdjustmentCyclePageDiskPorts({
    now: () => new Date("2026-10-08T00:40:00.000Z"),
    root,
  }).initialize();
  let state = createCyclePageState({
    dailyPageCount: 0,
    dueKey: "capture/2026-10-08T00:35:00.000Z",
    generation: "1",
    localDate: "2026-10-08",
  });

  try {
    const identities = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];

    // fill the exact current and next slots
    for (let index = 0; index < 2; index += 1) {
      const result = await appendCyclePageFailOpen(state, {
        payload: Buffer.from(`page-${String(index)}`),
        projections: [{ channel: "scheduler_request", identitySha256: identities[index] }],
      }, ports);
      assert.equal(result.servingBlocked, false);
      assert.equal(result.status, "page_pending_acknowledgement");
      state = result.state;
    }

    const refused = await appendCyclePageFailOpen(state, {
      payload: Buffer.from("page-2"),
      projections: [{ channel: "scheduler_request", identitySha256: identities[2] }],
    }, ports);
    assert.equal(refused.servingBlocked, false);
    assert.equal(refused.status, "evidence_gap");
    state = refused.state;
    assert.deepEqual((await readdir(join(root, "online-pages", "slots"))).sort(), [
      "current.page",
      "next.page",
    ]);
    state = await ackCyclePage(state, {
      acknowledgedAt: "2026-10-08T00:41:00.000Z",
      pageSha256: state.pages[0].pageSha256,
    }, ports);
    assert.deepEqual(await readdir(join(root, "online-pages", "slots")), ["current.page"]);
    assert.equal(state.slots.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// preserve serving when page and gap persistence both refuse capacity
test("online page capacity refusal stays fail open and honest", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-page-capacity-"));
  const ports = await new AdjustmentCyclePageDiskPorts({
    now: () => new Date("2026-10-08T00:40:00.000Z"),
    root,
    statfs: async () => ({
      bavail: 1_950_453_760n,
      bsize: 1n,
      ffree: 100_000n,
    }),
  }).initialize();
  const state = createCyclePageState({
    dailyPageCount: 0,
    dueKey: "capture/2026-10-08T00:35:00.000Z",
    generation: "1",
    localDate: "2026-10-08",
  });

  try {
    const result = await appendCyclePageFailOpen(state, {
      payload: Buffer.from("refused-page"),
      projections: [{ channel: "scheduler_request", identitySha256: "4".repeat(64) }],
    }, ports);
    assert.equal(result.servingBlocked, false);
    assert.equal(result.status, "evidence_gap_persistence_refused");
    assert.equal(result.reason, "capacity_refused");
    assert.deepEqual(await readdir(join(root, "online-pages", "slots")), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// transfer one committed scheduler capture through page checkpoint and genuine final graph
test("archive transport exports canonical page and final envelopes with idempotent acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-archive-transfer-"));
  const now = new Date("2026-10-08T00:40:00.123Z");
  const store = await new AdjustmentEvidenceStore({
    now: () => now,
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();
  const prepared = store.prepareV2(forecastBody(), "days=10", "scheduler_request");

  try {
    assert.notEqual(prepared, null);
    assert.deepEqual(await store.commit(prepared, now.toISOString()), { status: "created" });
    const transport = await new AdjustmentEvidenceArchiveTransport({
      now: () => now,
      root,
      statfs: async () => healthyStatfs(),
    }).initialize();
    const captured = await transport.captureCommittedSchedulerEvidence({
      dueKey: "capture/2026-10-08T00:35:00.000Z",
      prepared,
    });
    assert.equal(captured.status, "page_pending_acknowledgement");
    const firstEnvelope = await transport.next();
    assert.equal(firstEnvelope.contractVersion, ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION);
    assert.equal(firstEnvelope.kind, "page");
    assert.equal(firstEnvelope.header.dueKey, "capture/2026-10-08T00:35:00.000Z");
    assert.deepEqual(firstEnvelope.projections, [{
      channel: "scheduler_request",
      identitySha256: prepared.edgeReceiptIdentitySha256,
    }]);
    const payload = JSON.parse(Buffer.from(firstEnvelope.payloadBase64, "base64").toString("utf8"));
    assert.equal(payload.contractVersion, "adjustment-evidence-page-payload/v1");
    assert.equal(payload.edgeReceiptIdentitySha256, prepared.edgeReceiptIdentitySha256);

    const restarted = await new AdjustmentEvidenceArchiveTransport({
      now: () => new Date("2026-10-08T00:41:00.456Z"),
      root,
      statfs: async () => healthyStatfs(),
    }).initialize();
    assert.deepEqual(await restarted.next(), firstEnvelope);
    const checkpointSha256 = "9".repeat(64);
    const nextOutput = [];
    await runAdjustmentArchiveCommand(["archive-next"], {
      now: () => new Date("2026-10-08T00:41:00.456Z"),
      root,
      statfs: async () => healthyStatfs(),
      stdout: { write: (bytes) => nextOutput.push(Buffer.from(bytes)) },
    });
    assert.deepEqual(JSON.parse(Buffer.concat(nextOutput).toString("utf8")), firstEnvelope);
    const ackOutput = [];
    // simulate a crash after durable checkpoint binding but before slot release
    const crashPorts = await new AdjustmentCyclePageDiskPorts({
      now: () => new Date("2026-10-08T00:41:00.456Z"),
      root,
      statfs: async () => healthyStatfs(),
    }).initialize();
    await crashPorts.persistTransferAcknowledgement({
      acknowledgedAt: "2026-10-08T00:41:00.456Z",
      checkpointSha256,
      contractVersion: "adjustment-archive-transfer-ack/v1",
      header: firstEnvelope.header,
      pageSha256: firstEnvelope.pageSha256,
      payloadLength: Buffer.from(firstEnvelope.payloadBase64, "base64").length,
      projections: firstEnvelope.projections,
    });
    await runAdjustmentArchiveCommand([
      "archive-ack",
      firstEnvelope.pageSha256,
      checkpointSha256,
    ], {
      now: () => new Date("2026-10-08T00:41:00.456Z"),
      root,
      statfs: async () => healthyStatfs(),
      stdout: { write: (bytes) => ackOutput.push(Buffer.from(bytes)) },
    });
    assert.deepEqual(ackOutput, []);
    const finalEnvelope = await restarted.next();
    assert.equal(finalEnvelope.contractVersion, ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION);
    assert.equal(finalEnvelope.kind, "final");
    assert.equal(finalEnvelope.manifest.dueKey, firstEnvelope.header.dueKey);
    assert.equal(finalEnvelope.manifest.pageCount, 1);
    assert.equal(finalEnvelope.manifest.pages[0].pageSha256, firstEnvelope.pageSha256);
    const finalGraphSha256 = "7".repeat(64);
    const finalAckOutput = [];
    await runAdjustmentArchiveCommand([
      "archive-ack-final",
      finalEnvelope.manifestSha256,
      finalGraphSha256,
    ], {
      now: () => new Date("2026-10-08T00:42:00.789Z"),
      root,
      statfs: async () => healthyStatfs(),
      stdout: { write: (bytes) => finalAckOutput.push(Buffer.from(bytes)) },
    });
    assert.deepEqual(finalAckOutput, []);
    assert.deepEqual(await restarted.next(), {
      contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION,
      kind: "idle",
    });
    await restarted.acknowledge(firstEnvelope.pageSha256, checkpointSha256);
    await assert.rejects(
      restarted.acknowledge(firstEnvelope.pageSha256, "8".repeat(64)),
      /acknowledgement collision/u,
    );
    await restarted.acknowledgeFinal(finalEnvelope.manifestSha256, finalGraphSha256);
    await assert.rejects(
      restarted.acknowledgeFinal(finalEnvelope.manifestSha256, "6".repeat(64)),
      /final acknowledgement collision/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// preserve the first pending page and record a permanent gap for a later due cycle
test("archive transport fails open without a third spool or after-valid backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-archive-gap-"));
  const store = await new AdjustmentEvidenceStore({
    root,
    statfs: async () => healthyStatfs(),
  }).initialize();
  const first = store.prepareV2(forecastBody(), "days=10", "scheduler_request");
  const secondBody = forecastBody([forecastRow(0), forecastRow(1)]);
  const second = store.prepareV2(secondBody, "days=10", "scheduler_request");

  try {
    assert.notEqual(first, null);
    assert.notEqual(second, null);
    await store.commit(first, "2026-10-08T00:40:00.123Z");
    await store.commit(second, "2026-10-08T06:40:00.123Z");
    const transport = await new AdjustmentEvidenceArchiveTransport({
      now: () => new Date("2026-10-08T06:40:00.123Z"),
      root,
      statfs: async () => healthyStatfs(),
    }).initialize();
    assert.equal((await transport.captureCommittedSchedulerEvidence({
      dueKey: "capture/2026-10-08T00:35:00.000Z",
      prepared: first,
    })).status, "page_pending_acknowledgement");
    const refused = await transport.captureCommittedSchedulerEvidence({
      dueKey: "capture/2026-10-08T06:35:00.000Z",
      prepared: second,
    });
    assert.equal(refused.status, "evidence_gap");
    assert.equal((await transport.next()).projections[0].identitySha256, first.edgeReceiptIdentitySha256);
    assert.equal((await readdir(join(root, "online-pages", "gaps"))).length, 1);
    const retried = await transport.captureCommittedSchedulerEvidence({
      dueKey: "capture/2026-10-08T06:35:00.000Z",
      prepared: second,
    });
    assert.equal(retried.status, "evidence_gap");
    assert.equal((await readdir(join(root, "online-pages", "gaps"))).length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// keep both archive forced commands closed against argument and shell expansion
test("archive SSH dispatch accepts only the exact next and acknowledgement grammars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-adjustment-archive-dispatch-"));
  const sudo = join(directory, "sudo");
  const dispatch = join(repoRoot, "deploy/scripts/ssh-dispatch.sh");

  try {
    await writeFile(sudo, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\"\n");
    await chmod(sudo, 0o700);

    // accept only the two complete fixed grammars
    for (const [command, expected] of [
      ["adjustment-archive-next", "-n /usr/local/sbin/weather-remote-ops adjustment-archive-next\n"],
      [
        `adjustment-archive-ack ${"a".repeat(64)} ${"b".repeat(64)}`,
        `-n /usr/local/sbin/weather-remote-ops adjustment-archive-ack ${"a".repeat(64)} ${"b".repeat(64)}\n`,
      ],
      [
        `adjustment-archive-ack-final ${"c".repeat(64)} ${"d".repeat(64)}`,
        `-n /usr/local/sbin/weather-remote-ops adjustment-archive-ack-final ${"c".repeat(64)} ${"d".repeat(64)}\n`,
      ],
    ]) {
      const result = spawnSync(dispatch, [], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }

    // reject every extra, malformed or shell-expanded argument
    for (const command of [
      "adjustment-archive-next extra",
      `adjustment-archive-ack ${"A".repeat(64)} ${"b".repeat(64)}`,
      `adjustment-archive-ack ${"a".repeat(64)} ${"b".repeat(63)}`,
      `adjustment-archive-ack ${"a".repeat(64)} ${"b".repeat(64)} extra`,
      `adjustment-archive-ack ${"a".repeat(64)};id ${"b".repeat(64)}`,
      `adjustment-archive-ack-final ${"a".repeat(64)} ${"B".repeat(64)}`,
      `adjustment-archive-ack-final ${"a".repeat(64)} ${"b".repeat(64)} extra`,
    ]) {
      const result = spawnSync(dispatch, [], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command },
      });
      assert.equal(result.status, 126, command);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "operation denied\n");
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// reserve one disposable listener port
async function unusedPort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await new Promise(
    // wait for the kernel-selected listener
    (resolveWait) => server.once("listening", resolveWait),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  await new Promise(
    // release the temporary listener
    (resolveClose) => server.close(resolveClose),
  );
  assert.notEqual(port, null);
  return port;
}

// wait for the edge listener without extending the test indefinitely
async function waitForServer(origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(origin);

      if (response.status > 0) {
        return;
      }
    } catch {
      await new Promise(
        // wait briefly between connection attempts
        (resolveWait) => setTimeout(resolveWait, 20),
      );
    }
  }
  throw new Error("edge server did not start");
}

// prove direct GET capture is post-finish and byte-preserving at the edge
test("web edge captures only a finished normal forecast GET without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-edge-"));
  const evidenceRoot = join(root, "evidence");
  const upstreamBody = forecastBody([
    forecastRow(0, {
      adjustment: {
        adjustedMetrics: {},
        appliedMetrics: [],
        reasonCode: "unsupported_lead",
        state: "not_applicable",
      },
    }),
    forecastRow(1),
  ]);
  const upstream = createHttpServer(
    // serve one exact successful forecast body
    (request, response) => {
      if (request.url?.startsWith("/api/v1/sites/ballydidean/forecast")) {
        response.writeHead(200, {
          "Content-Length": String(upstreamBody.byteLength),
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(request.method === "HEAD" ? undefined : upstreamBody);
        return;
      }

      response.writeHead(404);
      response.end();
    },
  );
  upstream.listen(0, "127.0.0.1");
  await new Promise(
    // wait for the disposable upstream
    (resolveWait) => upstream.once("listening", resolveWait),
  );
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  const edgePort = await unusedPort();
  const edge = spawn(process.execPath, [join(repoRoot, "deploy/scripts/web-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(edgePort),
      WEATHER_ADJUSTMENT_EVIDENCE_ROOT: evidenceRoot,
      WEATHER_ADMIN_AUTH_PATH: join(root, "admin-auth.json"),
      WEATHER_ADMIN_BOOTSTRAP_TOKEN_PATH: join(root, "missing-bootstrap"),
      WEATHER_API_ORIGIN: `http://127.0.0.1:${String(upstreamAddress.port)}`,
      WEATHER_PROPERTY_SENSOR_LAYOUT_PATH: join(root, "property-sensor-layout.json"),
      WEATHER_RELEASE: "2026.10.07-1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = [];
  edge.stderr.on(
    "data",
    // retain startup diagnostics for one failed assertion
    (chunk) => diagnostics.push(String(chunk)),
  );

  try {
    const origin = `http://127.0.0.1:${String(edgePort)}`;
    await waitForServer(`${origin}/`);
    const forecast = await fetch(`${origin}/api/v1/sites/ballydidean/forecast`);
    const edgeBytes = Buffer.from(await forecast.arrayBuffer());
    assert.equal(forecast.status, 200);
    const expectedReceiptName = `sha256-${createAdjustmentEvidenceCapture(
      edgeBytes,
      "days=1",
    ).edgeReceiptIdentitySha256}.json`;
    const duplicate = await fetch(`${origin}/api/v1/sites/ballydidean/forecast`);
    assert.deepEqual(Buffer.from(await duplicate.arrayBuffer()), edgeBytes);

    let receiptNames;
    let receiptDirectoryObserved = false;

    // wait for the asynchronous receipt publication only
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        receiptNames = (await readdir(join(evidenceRoot, "receipts"))).sort();
        receiptDirectoryObserved = true;
      } catch (error) {
        // tolerate only directory creation still in progress
        if (error?.code !== "ENOENT" || receiptDirectoryObserved) {
          throw error;
        }
        receiptNames = [];
      }
      const unexpectedNames = receiptNames.filter(
        // allow only the writer's private temporary before publication
        (name) => name !== expectedReceiptName && !/^\.capture-[a-f0-9-]+\.tmp$/u.test(name),
      );
      assert.deepEqual(unexpectedNames, []);

      // freeze only after the exact final remains alone
      if (receiptNames.length === 1 && receiptNames[0] === expectedReceiptName) {
        break;
      }

      await new Promise(
        // wait briefly for durable receipt creation
        (resolveWait) => setTimeout(resolveWait, 10),
      );
    }

    assert.deepEqual(receiptNames, [expectedReceiptName]);
    const snapshot = await freezeAdjustmentEvidenceSnapshot({ root: evidenceRoot });
    assert.equal(snapshot.entries.length, 1);
    const head = await fetch(`${origin}/api/v1/sites/ballydidean/forecast`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root: evidenceRoot })).entries.length, 1);
    const spoofed = await fetch(`${origin}/api/v1/sites/ballydidean/forecast?days=1`, {
      headers: { "X-Weather-Issuance-Channel": "scheduler_request" },
    });
    assert.equal(spoofed.status, 200);
    await spoofed.arrayBuffer();
    assert.deepEqual(await readdir(join(evidenceRoot, "channels")), []);
    const widget = await fetch(`${origin}/api/v1/sites/ballydidean/widget-forecast`);
    assert.equal(widget.status, 502);
    assert.equal((await freezeAdjustmentEvidenceSnapshot({ root: evidenceRoot })).entries.length, 1);
  } catch (error) {
    error.message += `\nedge diagnostics:\n${diagnostics.join("")}`;
    throw error;
  } finally {
    // stop only still-running disposable servers
    if (edge.exitCode === null && edge.signalCode === null) {
      edge.kill("SIGTERM");
      await new Promise(
        // wait for child cleanup before removing state
        (resolveExit) => edge.once("exit", resolveExit),
      );
    }
    await new Promise(
      // close the disposable upstream listener
      (resolveClose) => upstream.close(resolveClose),
    );
    await rm(root, { force: true, recursive: true });
  }
});
