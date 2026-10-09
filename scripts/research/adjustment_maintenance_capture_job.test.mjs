import assert from "node:assert/strict";
import test from "node:test";
import { runAdjustmentMaintenanceCaptureJob } from "./adjustment_maintenance_capture_job.mjs";

// expose isolated writer boundaries while recording actual loop and lock ordering
function fixturePorts(events) {
  let locked = false;
  // fail if either writer escapes the shared process lock
  const record = async (name) => {
    assert.equal(locked, true);
    events.push(name);
  };
  const ports = {
    archive: {
      initialize: async () => await record("archive_initialize"),
      status: async () => ({}),
    },
    clock: () => new Date("2026-10-09T04:00:00.000Z"),
    initializeLifecycle: async () => await record("epoch_verify"),
    inspectSemanticInput: async () => { throw new Error("capture must not fit"); },
    journal: {
      initialize: async () => await record("journal_initialize"),
      status: async () => ({ activeLeases: [] }),
    },
    publishAttemptReport: async () => { throw new Error("capture must not publish model report"); },
    readArchiveHead: async () => null,
    runFit: async () => { throw new Error("capture must not fit"); },
    synchronizeEvidence: async () => await record("revision_capture"),
    withProcessLock: async (operation) => {
      assert.equal(locked, false);
      locked = true;
      events.push("lock");
      try {
        return await operation();
      } finally {
        events.push("unlock");
        locked = false;
      }
    },
  };
  // satisfy unused storage operations without providing spurious model authority
  for (const name of [
    "inspectDueKeys", "acquireLease", "completeDue", "releaseLease", "reconcileExpiredLease",
  ]) {
    ports.journal[name] = async () => { throw new Error(`unexpected journal ${name}`); };
  }
  // retain the graph surface required by canonical controller port validation
  for (const name of ["publishCasObject", "publishGraphManifest", "verifyFullGraph", "updateHead"]) {
    ports.archive[name] = async () => { throw new Error(`unexpected archive ${name}`); };
  }
  return ports;
}

// preserve an explicit stop before touching archive or transport state
test("capture job respects cancellation and rejects unknown path knobs", async () => {
  const events = [];
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runAdjustmentMaintenanceCaptureJob({
    ports: fixturePorts(events),
    signal: controller.signal,
  }), { iterations: 0, stopped: true });
  assert.deepEqual(events, []);
  // reject retired transport knobs rather than silently reviving the legacy consumer
  for (const unknown of [{ path: "/tmp/archive" }, { openCycle: {} }, { transport: {} }]) {
    await assert.rejects(runAdjustmentMaintenanceCaptureJob(unknown), /options are invalid/u);
  }
});

// drain the canonical graph every turn without initializing a legacy serving consumer
test("canonical capture job does not require legacy serving transport", async () => {
  const events = [];
  const result = await runAdjustmentMaintenanceCaptureJob({
    maximumIterations: 3,
    ports: fixturePorts(events),
    sleep: async () => {
      assert.equal(events.at(-1), "unlock");
      events.push("sleep");
    },
  });
  assert.deepEqual(result, { iterations: 3, stopped: false });
  assert.equal(events.filter((value) => value === "revision_capture").length, 3);
  assert.equal(events.filter((value) => value === "epoch_verify").length, 3);
  assert.equal(events.filter((value) => value === "lock").length, 3);
});

// stop between completed custody operations without touching a second writer turn
test("canonical capture job stops promptly after polling cancellation", async () => {
  const events = [];
  const controller = new AbortController();
  const result = await runAdjustmentMaintenanceCaptureJob({
    ports: fixturePorts(events),
    signal: controller.signal,
    sleep: async () => {
      assert.equal(events.at(-1), "unlock");
      controller.abort();
    },
  });
  assert.deepEqual(result, { iterations: 1, stopped: true });
  assert.equal(events.filter((value) => value === "revision_capture").length, 1);
});
