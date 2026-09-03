import assert from "node:assert/strict";
import test from "node:test";

import { startWeatherApi } from "../dist/main.js";

// build one inert server that records listen ordering
function recordingServer(events) {
  return {
    // record the one startup listen call
    listen(port, host) {
      events.push(`listen:${host}:${String(port)}`);
      return this;
    },
  };
}

test("I-BND-03 startup loads each eligible runtime once before preparation and listen", async () => {
  const events = [];
  let canaryLoads = 0;
  let loads = 0;
  const runtime = {
    bundle: null,
    reasonCode: "registry_inactive",
    state: "disabled",
  };
  let preparedAdjustment;
  const started = await startWeatherApi({
    // return an inactive canary selection
    async loadForecastAdjustmentWindCanaryRuntime() {
      canaryLoads += 1;
      events.push("canary");
      return {
        bundle: null,
        reasonCode: "registry_inactive",
        state: "disabled",
      };
    },
    // return the cached startup selection
    async loadForecastAdjustmentRuntime() {
      loads += 1;
      events.push("load");
      return runtime;
    },
    // freeze the loader timestamp
    now() {
      events.push("time");
      return new Date("2026-09-02T01:02:03.000Z");
    },
    // prepare only after the runtime is loaded
    async prepareServer(adjustment) {
      preparedAdjustment = adjustment;
      events.push("prepare");
      return { port: 8080, server: recordingServer(events) };
    },
  });

  assert.equal(canaryLoads, 1);
  assert.equal(loads, 1);
  assert.deepEqual(events, ["canary", "load", "time", "prepare", "listen:0.0.0.0:8080"]);
  assert.equal(started.adjustment, preparedAdjustment);
  assert.equal(started.adjustment.runtime, runtime);
  assert.equal(started.adjustment.loadedAt, "2026-09-02T01:02:03.000Z");
});

test("loader exceptions keep startup healthy with a disabled cached runtime", async () => {
  const events = [];
  const started = await startWeatherApi({
    // keep the canary path inactive
    async loadForecastAdjustmentWindCanaryRuntime() {
      return {
        bundle: null,
        reasonCode: "registry_inactive",
        state: "disabled",
      };
    },
    // simulate an unexpected fixed loader failure
    async loadForecastAdjustmentRuntime() {
      events.push("load");
      throw new Error("/secret/runtime/path");
    },
    // freeze the failure timestamp
    now() {
      return new Date("2026-09-02T01:02:03.000Z");
    },
    // accept the fail-raw selection
    async prepareServer(adjustment) {
      events.push(`prepare:${adjustment.runtime.state}`);
      return { port: 8080, server: recordingServer(events) };
    },
  });

  assert.deepEqual(started.adjustment.runtime, {
    bundle: null,
    reasonCode: "bundle_invalid",
    state: "disabled",
  });
  assert.deepEqual(events, [
    "load",
    "prepare:disabled",
    "listen:0.0.0.0:8080",
  ]);
});

test("I-BND-04 runtime selection changes only across simulated restarts", async () => {
  const events = [];
  const inactiveRuntime = {
    bundle: null,
    reasonCode: "registry_inactive",
    state: "disabled",
  };
  const firstBundleRuntime = {
    bundle: { bundleSha256: "a".repeat(64) },
    reasonCode: null,
    state: "active",
  };
  const secondBundleRuntime = {
    bundle: { bundleSha256: "b".repeat(64) },
    reasonCode: null,
    state: "active",
  };
  let selectedRuntime = inactiveRuntime;
  const loadCounts = [];

  // run one isolated process-start boundary
  async function simulatedRestart() {
    let loads = 0;
    const started = await startWeatherApi({
      // keep the canary path inactive
      async loadForecastAdjustmentWindCanaryRuntime() {
        return {
          bundle: null,
          reasonCode: "registry_inactive",
          state: "disabled",
        };
      },
      // snapshot the selection once for this process
      async loadForecastAdjustmentRuntime() {
        loads += 1;
        return selectedRuntime;
      },
      // freeze the restart timestamp
      now() {
        return new Date("2026-09-02T01:02:03.000Z");
      },
      // retain the startup snapshot without external I/O
      async prepareServer() {
        return { port: 8080, server: recordingServer(events) };
      },
    });
    loadCounts.push(loads);
    return started.adjustment.runtime;
  }

  const inactive = await simulatedRestart();
  selectedRuntime = firstBundleRuntime;
  assert.equal(inactive, inactiveRuntime);
  const firstBundle = await simulatedRestart();
  selectedRuntime = secondBundleRuntime;
  const secondBundle = await simulatedRestart();

  assert.equal(firstBundle, firstBundleRuntime);
  assert.equal(secondBundle, secondBundleRuntime);
  assert.deepEqual(loadCounts, [1, 1, 1]);
});

test("active wind canary is selected without loading the qualified runtime", async () => {
  const events = [];
  const runtime = {
    bundle: { artifactKind: "wind_transfer_canary_runtime_bundle" },
    reasonCode: null,
    state: "active",
  };
  const started = await startWeatherApi({
    // return the active isolated canary
    async loadForecastAdjustmentWindCanaryRuntime() {
      events.push("canary");
      return runtime;
    },
    // reject any fallback qualified load
    async loadForecastAdjustmentRuntime() {
      events.push("qualified");
      throw new Error("qualified runtime should not load");
    },
    // freeze the selected canary
    async prepareServer(adjustment) {
      events.push(`prepare:${adjustment.runtime.state}`);
      return { port: 8080, server: recordingServer(events) };
    },
  });

  assert.equal(started.adjustment.runtime, runtime);
  assert.deepEqual(events, ["canary", "prepare:active", "listen:0.0.0.0:8080"]);
});

test("canary safety failures stay fail-raw without qualified fallback", async () => {
  const events = [];
  const runtime = {
    bundle: null,
    reasonCode: "canary_killed",
    state: "disabled",
  };
  const started = await startWeatherApi({
    // return one explicit canary stop state
    async loadForecastAdjustmentWindCanaryRuntime() {
      events.push("canary");
      return runtime;
    },
    // reject unsafe fallback after a canary stop
    async loadForecastAdjustmentRuntime() {
      events.push("qualified");
      throw new Error("qualified runtime should not load");
    },
    // freeze the disabled canary selection
    async prepareServer(adjustment) {
      events.push(`prepare:${adjustment.runtime.reasonCode}`);
      return { port: 8080, server: recordingServer(events) };
    },
  });

  assert.equal(started.adjustment.runtime, runtime);
  assert.deepEqual(events, ["canary", "prepare:canary_killed", "listen:0.0.0.0:8080"]);
});
