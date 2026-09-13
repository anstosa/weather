import assert from "node:assert/strict";
import test from "node:test";

import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";
import { collectRainEvidence, isRainCollectionEnabled, planRainCaptureRequests, runWorkerIteration } from "../dist/index.js";

const instant = "2026-09-14T12:10:00.000Z";

// reject disposable runs and require explicit production activation
test("rain activation rejects local, compatibility and unconfigured workers", () => {
  const configuration = {
    rainCollectionEnabled: true,
    openMeteoCompatibilityOrigin: null,
    site: { site: { key: "ballydidean" } },
    version: "2026.09.14-1",
  };
  assert.equal(isRainCollectionEnabled(configuration), true);
  // vary each independent activation guard
  for (const override of [
    { rainCollectionEnabled: false },
    { rainCollectionEnabled: undefined },
    { rainCollectionEnabled: "1" },
    { openMeteoCompatibilityOrigin: "http://fixture:8080" },
    { site: { site: { key: "another-site" } } },
    { version: "development" },
    { version: "2026.09.14-0" },
    { version: "2026.09.14-100" },
  ]) {
    assert.equal(isRainCollectionEnabled({ ...configuration, ...override }), false);
  }
});

// return a synthetic complete response without provider traffic
function receipt(outcome = "valid") {
  return {
    startedAt: instant,
    completedAt: instant,
    httpStatus: 200,
    body: Buffer.from("{}"),
    bodySha256: "fixture",
    outcome,
    errorCode: null,
    parserVersion: RAIN_COLLECTION_POLICY.contractVersion,
    rowCount: 48,
    availableByDecision: true,
    metadata: {},
  };
}

// verify chronology and the conservative provider entitlement boundary
test("rain planner preserves run timing and disables unconfirmed station capture", () => {
  const requests = planRainCaptureRequests(new Date(instant), false);
  assert.deepEqual(requests, [{
    kind: "forecast",
    runInitializedAt: "2026-09-14T06:00:00.000Z",
    attempt: 1,
    slotKey: "forecast:2026-09-14T06:00:00.000Z:1",
  }]);
  const late = planRainCaptureRequests(new Date("2026-09-14T16:00:00.000Z"), false);
  assert.equal(late[0].attempt, 2);
  assert.equal(late[0].runInitializedAt, "2026-09-14T06:00:00.000Z");
  assert.deepEqual(planRainCaptureRequests(new Date("invalid"), true), []);
  assert.deepEqual(planRainCaptureRequests(new Date(RAIN_COLLECTION_POLICY.expiresAt), true), []);
  assert.deepEqual(planRainCaptureRequests(new Date("2026-09-12T23:59:59Z"), true), []);
});

// retain the same twelve distinct gauges and complete-hour endpoint
test("authorized hourly sweeps retain all gauges and rotate priority", () => {
  const requests = planRainCaptureRequests(new Date(instant), true).slice(1);
  assert.equal(requests.length, 12);
  assert.deepEqual(new Set(requests.map((row) => row.stationId)), new Set(RAIN_COLLECTION_STATIONS.map((row) => row.locationId)));
  assert.equal(requests[0].endExclusive, "2026-09-14T12:00:01.000Z");
  assert.equal(requests[0].start, "2026-09-14T10:00:01.000Z");
  const later = planRainCaptureRequests(new Date("2026-09-14T13:10:00Z"), true).slice(1);
  assert.notEqual(requests[0].stationId, later[0].stationId);
  const waiting = planRainCaptureRequests(new Date("2026-09-14T12:01:00Z"), true).slice(1);
  assert.equal(waiting[0].endExclusive, "2026-09-14T11:00:01.000Z");
});

// prove durable claims precede traffic and responses precede paced successors
test("rain capture enforces two requests, immutable receipt order and spacing", async () => {
  const events = [];
  let claims = 0;
  const result = await collectRainEvidence({}, "2026.09.14-1", {
    now: () => new Date(instant),
    stationsAuthorized: true,
    repository: {
      // claim only the exact next durable slot
      async claimRainCaptureSlot(_pool, { request }) {
        events.push(`claim:${request.kind}`);
        return String(++claims);
      },
      // preserve each complete response under its claimed identity
      async appendRainCaptureReceipt(_pool, id) { events.push(`receipt:${id}`); },
    },
    // return a synthetic response after its claim
    async fetchCapture(request) { events.push(`fetch:${request.kind}`); return receipt(); },
    // record rather than wait during deterministic tests
    async sleep(milliseconds) { events.push(`sleep:${milliseconds}`); },
  });
  assert.deepEqual(result, { attempted: 2, valid: 2, failed: 0 });
  assert.deepEqual(events, ["claim:forecast", "fetch:forecast", "receipt:1", "sleep:1100", "claim:station", "fetch:station", "receipt:2"]);
});

// skip previously claimed work without replaying its provider request
test("duplicate and unknown claims never trigger a request", async () => {
  const result = await collectRainEvidence({}, "2026.09.14-1", {
    now: () => new Date(instant),
    stationsAuthorized: false,
    repository: {
      async claimRainCaptureSlot() { return null; },
      async appendRainCaptureReceipt() { assert.fail("no claimed receipt"); },
    },
    async fetchCapture() { assert.fail("duplicate HTTP request"); },
  });
  assert.deepEqual(result, { attempted: 0, valid: 0, failed: 0 });
});

// retain provider rejection and stop before another source request
test("rate and authorization errors stop the current collector loop", async () => {
  // test both explicit provider suspension signals
  for (const outcome of ["rate_limited", "unauthorized"]) {
    let saved = 0;
    const result = await collectRainEvidence({}, "2026.09.14-1", {
      now: () => new Date(instant),
      stationsAuthorized: true,
      repository: {
        async claimRainCaptureSlot() { return "1"; },
        async appendRainCaptureReceipt() { saved += 1; },
      },
      async fetchCapture() { return receipt(outcome); },
      async sleep() { assert.fail("rejection must stop the loop"); },
    });
    assert.equal(saved, 1);
    assert.deepEqual(result, { attempted: 1, valid: 0, failed: 1 });
  }
});

// isolate missing receipts from ordinary source ingestion and heartbeat
test("capture storage failure leaves an unknown claim without killing the worker", async () => {
  const diagnostics = [];
  let heartbeats = 0;
  const result = await runWorkerIteration({}, {
    now: () => new Date(instant),
    version: "2026.09.14-1",
    instance: "fixture",
    lastSuccessAt: null,
    site: { site: { key: "ballydidean" } },
    diagnosticWriter: (value) => diagnostics.push(value),
    repository: {
      async discoverDueSources() { return []; },
      async updateWorkerHeartbeat() { heartbeats += 1; },
    },
    rainCollection: {
      stationsAuthorized: false,
      repository: {
        async claimRainCaptureSlot() { return "1"; },
        async appendRainCaptureReceipt() { throw new Error("storage unavailable"); },
      },
      async fetchCapture() { return receipt(); },
    },
  });
  assert.equal(heartbeats, 1);
  assert.deepEqual(result.sources, []);
  // inspect the existing redacted diagnostic field rather than its input alias
  assert.ok(diagnostics.some((value) => value.error_code === "rain_collection_failed"));
});
