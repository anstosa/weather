import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { lstat, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  AdjustmentEvidenceStore,
  createAdjustmentEvidenceCapture,
  freezeAdjustmentEvidenceSnapshot,
  normalizeAdjustmentEvidenceWindow,
} from "../scripts/adjustment-evidence-store.mjs";

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
    store.trackResponse(aborted, createAdjustmentEvidenceCapture(forecastBody(), "days=1"));
    aborted.emit("close");
    assert.equal(store.status().closeWithoutFinish, 1);
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
