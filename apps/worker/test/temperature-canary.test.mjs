import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadSiteConfiguration } from "@weather/database";

import {
  buildCausalTemperatureRecentErrorState,
  collectEcmwfTemperatureCanaryRuns,
  latestAvailableEcmwfInitialization,
  runWorkerIteration,
} from "../dist/index.js";

const sitePath = new URL(
  "../../../config/sites/ballydidean.json",
  import.meta.url,
).pathname;

// create one private ECMWF hour
function forecastHour(runInitializedAt, modelLeadHours) {
  return {
    modelLeadHours,
    rawRelativeHumidityPercent: 75,
    rawTemperatureC: 10,
    rawWindSpeedMps: 3,
    validAt: new Date(
      Date.parse(runInitializedAt) + modelLeadHours * 3_600_000,
    ).toISOString(),
  };
}

test("latest ECMWF initialization preserves a conservative six-hour delay", () => {
  assert.equal(
    latestAvailableEcmwfInitialization(
      new Date("2026-09-08T00:35:00.000Z"),
    ),
    "2026-09-07T18:00:00.000Z",
  );
  assert.equal(
    latestAvailableEcmwfInitialization(
      new Date("2026-09-08T05:59:59.999Z"),
    ),
    "2026-09-07T18:00:00.000Z",
  );
});

test("causal temperature state uses exact network targets and receipt cutoff", async () => {
  const targetRunInitializedAt = "2026-09-08T00:00:00.000Z";
  const end = Date.parse("2026-09-07T17:00:00.000Z");
  const priorHours = Array.from({ length: 24 }, (_, index) => {
    const validAt = new Date(end - index * 3_600_000).toISOString();
    const latestSourceMilliseconds = Date.parse(validAt) - 7 * 3_600_000;
    const runInitializedAt = new Date(
      Math.floor(latestSourceMilliseconds / (6 * 3_600_000)) *
        6 * 3_600_000,
    ).toISOString();
    const modelLeadHours =
      (Date.parse(validAt) - Date.parse(runInitializedAt)) / 3_600_000;

    return {
      ...forecastHour(runInitializedAt, modelLeadHours),
      key: `${runInitializedAt}/${validAt}`,
      runInitializedAt,
      validAt,
    };
  });
  const stationHours = priorHours.flatMap((forecast) =>
    [
      ["ballydidean-ecowitt", "ecowitt"],
      ["tempest-64255", "tempest"],
      ["ambient-merlin", "ambient"],
    ].map(([physicalStationKey, providerFamily]) => ({
      metrics: {
        relativeHumidityPercent: null,
        temperatureC: 12,
        windDirectionDegrees: null,
        windGustMps: null,
        windSpeedMps: null,
      },
      physicalStationKey,
      providerFamily,
      sourceKeys: [`${physicalStationKey}-source`],
      validAt: forecast.validAt,
    })),
  );
  const calls = [];
  const repository = {
    async listCausalEcmwfTemperatureCanaryPriorHours(_pool, query) {
      calls.push(["forecasts", query]);
      return priorHours;
    },
    async listCausalForecastObservationHourlyStations(_pool, query) {
      calls.push(["observations", query]);
      return stationHours;
    },
  };
  const state = await buildCausalTemperatureRecentErrorState({}, {
    repository,
    siteSlug: "ballydidean",
    targetRunInitializedAt,
  });

  assert.equal(state.supported, true);
  assert.equal(state.b24C, 2);
  assert.equal(state.b72C, 2);
  assert.equal(state.mad72C, 0);
  assert.equal(state.n24, 24);
  assert.equal(state.n72, 24);
  assert.equal(state.localDates, 2);
  assert.equal(state.maximumSourceValidAt, "2026-09-07T17:00:00.000Z");
  assert.equal(state.maximumSourceRunInitializedAt, "2026-09-07T06:00:00.000Z");
  assert.equal(state.sourceKeys.length, 24);
  assert.equal(calls[1][1].asOf, targetRunInitializedAt);
  assert.equal(calls[1][1].to, "2026-09-07T18:00:00.000Z");
});

test("collector fetches only two missing runs latest first and preserves cold start", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const requests = [];
  const persisted = [];
  const repository = {
    async listEcmwfTemperatureCanaryRunInitializations() {
      return [];
    },
    async listCausalEcmwfTemperatureCanaryPriorHours() {
      return [];
    },
    async listCausalForecastObservationHourlyStations() {
      return [];
    },
    async persistEcmwfTemperatureCanaryRun(_pool, input) {
      persisted.push(input);
      return {};
    },
  };
  const result = await collectEcmwfTemperatureCanaryRuns({}, {
    async fetchEcmwfSingleRun(request, options) {
      requests.push([request, options]);
      return {
        adapterVersion: "open-meteo-ecmwf-single-run/v1",
        attempts: 1,
        hours: Array.from({ length: 18 }, (_, index) =>
          forecastHour(request.runInitializedAt, index + 1),
        ),
        modelCycle: "50r1",
        providerResponseSha256: "a".repeat(64),
        receivedAt: "2026-09-08T00:35:00.000Z",
        runInitializedAt: request.runInitializedAt,
        upstreamModel: "ecmwf_ifs",
      };
    },
    fetchOptions: { maxAttempts: 3, timeoutMs: 20_000 },
    now: () => new Date("2026-09-08T00:35:00.000Z"),
    repository,
    site,
  });

  assert.deepEqual(result.requestedRuns, [
    "2026-09-07T18:00:00.000Z",
    "2026-09-07T12:00:00.000Z",
  ]);
  assert.equal(result.persistedRuns, 2);
  assert.equal(result.failedRuns, 0);
  assert.equal(requests[0][1].maxAttempts, 1);
  assert.equal(requests[0][1].timeoutMs, 5_000);
  assert.equal(persisted[0].stateStatus, "cold");
  assert.equal(persisted[0].recentErrorState.targetRunInitializedAt, result.requestedRuns[0]);
});

test("collector isolates one unavailable run and continues bounded warmup", async () => {
  const site = await loadSiteConfiguration(sitePath);
  let call = 0;
  const persisted = [];
  const repository = {
    async listEcmwfTemperatureCanaryRunInitializations() {
      return [];
    },
    async listCausalEcmwfTemperatureCanaryPriorHours() {
      return [];
    },
    async listCausalForecastObservationHourlyStations() {
      return [];
    },
    async persistEcmwfTemperatureCanaryRun(_pool, input) {
      persisted.push(input.runInitializedAt);
      return {};
    },
  };
  const result = await collectEcmwfTemperatureCanaryRuns({}, {
    async fetchEcmwfSingleRun(request) {
      call += 1;

      // simulate the newest run not yet published
      if (call === 1) {
        throw new Error("run unavailable");
      }

      return {
        adapterVersion: "open-meteo-ecmwf-single-run/v1",
        attempts: 1,
        hours: Array.from({ length: 18 }, (_, index) =>
          forecastHour(request.runInitializedAt, index + 1),
        ),
        modelCycle: "50r1",
        providerResponseSha256: "a".repeat(64),
        receivedAt: "2026-09-08T00:35:00.000Z",
        runInitializedAt: request.runInitializedAt,
        upstreamModel: "ecmwf_ifs",
      };
    },
    now: () => new Date("2026-09-08T00:35:00.000Z"),
    repository,
    site,
  });

  assert.equal(result.failedRuns, 1);
  assert.equal(result.persistedRuns, 1);
  assert.deepEqual(persisted, ["2026-09-07T12:00:00.000Z"]);
});

test("worker performs no sidecar I/O after canary expiration", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const registryPath = new URL(
    "../../../config/forecast-adjustments/ballydidean-temperature-canary.json",
    import.meta.url,
  );
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const bundlePath = new URL(
    `../../../config/forecast-adjustments/ballydidean/${registry.activeBundle.path}`,
    import.meta.url,
  );
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  let inventoryCalls = 0;
  let heartbeatCalls = 0;
  const repository = {
    async discoverDueSources() {
      return [];
    },
    async listEcmwfTemperatureCanaryRunInitializations() {
      inventoryCalls += 1;
      return [];
    },
    async updateWorkerHeartbeat() {
      heartbeatCalls += 1;
    },
  };

  await runWorkerIteration({}, {
    diagnosticWriter: () => undefined,
    instance: "worker-test",
    lastSuccessAt: null,
    now: () => new Date(bundle.authorization.expiresAt),
    repository,
    site,
    temperatureCanaryRuntime: {
      bundle,
      reasonCode: null,
      state: "active",
    },
    version: "test",
  });

  assert.equal(inventoryCalls, 0);
  assert.equal(heartbeatCalls, 1);
});
