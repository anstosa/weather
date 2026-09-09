import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FORECAST_OBSERVATION_SOURCE_LINEAGES, FORECAST_OBSERVATION_STATIONS } from "@weather/domain";
import { createTemperatureLiveReplayEvents } from "../dist/temperature-live-replay-events.js";

const VALID = "2026-09-07T10:00:00.000Z";
// bind deterministic synthetic row identities
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// create the same three-station eligible network as the established export tests
const stations = () => ["ambient-merlin", "tempest-38270", "tempest-64255"].map(
  // preserve one distinct physical source per row
  (key) => stationRow(key, VALID),
);

// create one exact complete station row
function stationRow(stationKey, validAt) {
  const station = FORECAST_OBSERVATION_STATIONS.find(
    // resolve one pinned station
    (candidate) => candidate.key === stationKey,
  );
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    // resolve one pinned source lineage
    (candidate) => candidate.physicalStationKey === stationKey,
  );

  // retain exact fixture identities
  if (station === undefined || lineage === undefined) {
    throw new Error("station fixture identity is unavailable");
  }

  return {
    adapter_contracts: [lineage.adapterContract],
    collision_count: 0,
    content_hashes: [sha256(`${stationKey}:${validAt}`)],
    contract_epoch: "physical-station-hourly/v1",
    dataset: null,
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: stationKey,
    provider_family: station.providerFamily,
    received_at: null,
    record_kind: "station_hour",
    reference_at: null,
    reference_kind: null,
    relative_humidity_percent: 70,
    site_key: "ballydidean",
    source_config_fingerprints: [lineage.checkedFingerprint],
    source_keys: [lineage.sourceKey],
    target_lead_hours: null,
    temperature_c: 12,
    upstream_model: null,
    valid_at: validAt,
    wind_direction_degrees: 100,
    wind_gust_mps: 10,
    wind_speed_mps: 6,
  };
}

// create one exact fixed-anchor row
function fixedLeadRow(validAt, targetLeadHours) {
  return {
    adapter_contracts: ["previous-runs-hourly/v1"],
    collision_count: 0,
    content_hashes: [sha256(`fixed:${validAt}:${targetLeadHours}`)],
    contract_epoch: "open-meteo-previous-runs-best-match/2026-09",
    dataset: "previous_runs",
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: null,
    provider_family: null,
    received_at: validAt,
    record_kind: "fixed_lead_anchor",
    reference_at: null,
    reference_kind: "fixed_lead_anchor",
    relative_humidity_percent: 60,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
    ],
    source_keys: ["open-meteo-previous-runs-v1"],
    target_lead_hours: targetLeadHours,
    temperature_c: 10,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: 80,
    wind_gust_mps: 8,
    wind_speed_mps: 4,
  };
}

// create one exact live-v4 row
function liveV4Row(validAt, targetLeadHours) {
  return {
    adapter_contracts: ["forecast-daily/v4"],
    collision_count: 0,
    content_hashes: [sha256(`live:${validAt}:${targetLeadHours}`)],
    contract_epoch:
      "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
    dataset: "forecast",
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: null,
    provider_family: null,
    received_at: validAt,
    record_kind: "legacy_v4_retrieval_snapshot",
    reference_at: new Date(
      Date.parse(validAt) - (targetLeadHours - 0.5) * 3_600_000,
    ).toISOString(),
    reference_kind: "retrieval_snapshot",
    relative_humidity_percent: 60,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    ],
    source_keys: ["open-meteo-forecast-v4"],
    target_lead_hours: targetLeadHours,
    temperature_c: 10,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: 80,
    wind_gust_mps: 8,
    wind_speed_mps: 4,
  };
}

// bind the existing jitter choice and weather from its exact selected row
test("reconstructs network targets and selects exact-row forecast weather", () => {
  const later = liveV4Row(VALID, 1);
  const earlier = { ...later, reference_at: "2026-09-07T09:01:00.000Z",
    relative_humidity_percent: 45, wind_speed_mps: 8, temperature_c: 14,
    content_hashes: [sha256("earlier")] };
  const rows = [...stations(), later, earlier];
  const before = JSON.stringify(rows);
  const result = createTemperatureLiveReplayEvents(rows);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { actual: 12, rawForecast: 14,
    rawRelativeHumidityPercent: 45, rawWindSpeedMps: 8,
    referenceAt: earlier.reference_at, targetLeadHours: 1, validAt: VALID });
  assert.equal(JSON.stringify(rows), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

// retain unsupported forecast weather as null while requiring measured temperature
test("preserves missing weather and excludes missing forecast temperature", () => {
  const forecast = { ...liveV4Row(VALID, 1), relative_humidity_percent: null, wind_speed_mps: null };
  const result = createTemperatureLiveReplayEvents([...stations(), forecast]);
  assert.equal(result[0].rawRelativeHumidityPercent, null);
  assert.equal(result[0].rawWindSpeedMps, null);
  assert.deepEqual(createTemperatureLiveReplayEvents([...stations(), { ...forecast, temperature_c: null }]), []);
});

// keep the network support contract instead of substituting one station
test("omits uncovered network hours and rejects duplicate station contributions", () => {
  const sources = stations();
  assert.deepEqual(createTemperatureLiveReplayEvents([...sources.slice(0, 2), liveV4Row(VALID, 1)]), []);
  assert.throws(
    // reject physical duplicates even when temperatures agree
    () => createTemperatureLiveReplayEvents([...sources, sources[0], liveV4Row(VALID, 1)]),
    /duplicate physical station/,
  );
});

// preserve the archive/live boundary even when fixed anchors have matching targets
test("never synthesizes a live event from a fixed archive anchor", () => {
  assert.deepEqual(createTemperatureLiveReplayEvents([...stations(), fixedLeadRow(VALID, 24)]), []);
  assert.equal(createTemperatureLiveReplayEvents([...stations(), fixedLeadRow(VALID, 24), liveV4Row(VALID, 24)]).length, 1);
});

// fail closed through the existing exact-row parser
test("rejects source collisions, unknown fields and invalid live references", () => {
  const invalid = [{ ...liveV4Row(VALID, 1), collision_count: 1 },
    { ...liveV4Row(VALID, 1), extra: true },
    { ...liveV4Row(VALID, 1), reference_at: null }];
  // reject each invalid sanitized row
  for (const row of invalid) {
    assert.throws(
      // exercise the unchanged parser boundary
      () => createTemperatureLiveReplayEvents([...stations(), row]),
    );
  }
});
