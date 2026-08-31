import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNoaaTideRequest,
  normalizeNoaaTidePayload,
} from "../dist/index.js";

const observationRequest = {
  datum: "MLLW",
  endExclusive: "2019-01-01T01:00:00.000Z",
  product: "water_level",
  sourceId: "41",
  sourceKind: "tide_observation",
  start: "2019-01-01T00:00:00.000Z",
  stationId: "9444900",
  timezone: "America/Los_Angeles",
};

const predictionRequest = {
  datum: "MLLW",
  endExclusive: "2019-01-03T00:00:00.000Z",
  interval: "hilo",
  product: "predictions",
  sourceId: "42",
  sourceKind: "tide_prediction",
  start: "2019-01-01T00:00:00.000Z",
  stationId: "9447814",
  timezone: "America/Los_Angeles",
};

test("NOAA observation requests use the inclusive minute before the half-open bound", () => {
  const url = buildNoaaTideRequest(observationRequest);
  assert.equal(url.searchParams.get("begin_date"), "2019-01-01 00:00");
  assert.equal(url.searchParams.get("end_date"), "2019-01-01 00:59");
  assert.equal(url.searchParams.get("station"), "9444900");
  assert.equal(url.searchParams.get("datum"), "MLLW");
});

test("NOAA verified observations normalize six-minute water levels", () => {
  const records = normalizeNoaaTidePayload(
    {
      data: [
        { f: "0,0,0,0", q: "v", s: "0.016", t: "2019-01-01 00:00", v: "0.770" },
        { f: "0,0,0,0", q: "v", s: "0.012", t: "2019-01-01 00:06", v: "0.731" },
      ],
    },
    observationRequest,
    "2026-08-25T00:00:00.000Z",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].metrics.waterLevelM, 0.77);
  assert.equal(records[1].validAt, "2019-01-01T00:06:00.000Z");
  assert.equal(records[0].sourceKind, "tide_observation");
  assert.deepEqual(records[0].metadata.quality, {
    flags: ["0", "0", "0", "0"],
    status: "v",
  });
});

test("NOAA local high-low predictions retain event type", () => {
  const records = normalizeNoaaTidePayload(
    {
      predictions: [
        { t: "2019-01-01 03:18", type: "L", v: "0.317" },
        { t: "2019-01-01 11:27", type: "H", v: "3.271" },
      ],
    },
    predictionRequest,
    "2026-08-25T00:00:00.000Z",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].metadata.provider.prediction_type, "L");
  assert.equal(records[1].metrics.waterLevelM, 3.271);
  assert.equal(records[1].sourceKind, "tide_prediction");
});

test("NOAA provider-declared failures fail closed", () => {
  assert.throws(
    () => normalizeNoaaTidePayload(
      { error: { message: "station unavailable" } },
      observationRequest,
      "2026-08-25T00:00:00.000Z",
    ),
    /station unavailable/u,
  );
});
