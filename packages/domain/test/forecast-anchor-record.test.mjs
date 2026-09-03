import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIXED_FORECAST_LEAD_HOURS,
  createFixedLeadAnchorTrainingRow,
  createLegacyV4RetrievalSnapshotTrainingRow,
  createNormalizedForecastAnchorRecord,
  forecastAnchorRecordContent,
  forecastAnchorRecordIdentity,
} from "../dist/index.js";

const metrics = {
  apparentTemperatureC: 8,
  blackGlobeTemperatureC: null,
  cloudCoverPercent: 75,
  pm25MicrogramsPerCubicMeter: null,
  precipitationMm: 0,
  precipitationRateMmPerHour: null,
  pressureHpa: 1012,
  relativeHumidityPercent: 82,
  soilElectricalConductivityMicrosiemensPerCm: null,
  soilMoisturePercent: null,
  solarRadiationWm2: null,
  temperatureC: 9,
  uvIndex: null,
  waterLevelM: null,
  windDirectionDegrees: 270,
  windGustMps: 9,
  windSpeedMps: 4,
  wetBulbGlobeTemperatureC: null,
};

const metadata = {
  device: null,
  model: "best_match",
  provider: { dataset: "previous_runs" },
  quality: null,
  upstreamTimezone: "UTC",
};

const baseInput = {
  adapterVersion: "open-meteo-previous-runs/v1",
  contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
  dataset: "previous_runs",
  leadHours: 24,
  metadata,
  metrics,
  receivedAt: "2026-08-22T04:00:01.000Z",
  sourceConfigFingerprint: "a".repeat(64),
  sourceId: "open-meteo-previous-runs-v1",
  upstreamModel: "best_match",
  validAt: "2026-08-23T04:00:00.000Z",
};

// verify every exact fixed lead and absent run semantics
test("U-FPR-01 fixed anchors expose exact lead provenance without a run instant", () => {
  // inspect every supported lead
  for (const leadHours of FIXED_FORECAST_LEAD_HOURS) {
    const record = createNormalizedForecastAnchorRecord({
      ...baseInput,
      leadHours,
    });

    assert.equal(record.contractVersion, "forecast-anchor-record/v1");
    assert.equal(record.leadHours, leadHours);
    assert.equal(record.dataset, "previous_runs");
    assert.equal(record.upstreamModel, "best_match");
    assert.equal(record.sourceKind, "forecast");
    assert.equal("productRunAt" in record, false);
    assert.equal("referenceAt" in record, false);
  }
});

// verify fixed-anchor boundary rejection
test("U-FPR-02 fixed anchors reject invalid provenance and exact-run claims", () => {
  // inspect every invalid lead
  for (const leadHours of [0, 23, 25, 192]) {
    assert.throws(
      () => createNormalizedForecastAnchorRecord({ ...baseInput, leadHours }),
      /leadHours/u,
    );
  }

  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        dataset: "historical_forecast",
      }),
    /previous_runs/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        upstreamModel: "gfs",
      }),
    /best_match/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        contractEpoch: "",
      }),
    /contractEpoch/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        productRunAt: "2026-08-22T00:00:00.000Z",
      }),
    /exact-run/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        referenceAt: "2026-08-22T00:00:00.000Z",
      }),
    /exact-run/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        metadata: { ...metadata, model: "gfs" },
      }),
    /metadata\.model must match/u,
  );
  assert.throws(
    () =>
      createNormalizedForecastAnchorRecord({
        ...baseInput,
        metadata: {
          ...metadata,
          provider: { dataset: "historical_forecast" },
        },
      }),
    /metadata\.provider\.dataset must match/u,
  );
});

// verify stable identity and revision content boundaries
test("U-FPR-04 and U-FPR-05 anchor identity is retry-stable and content-aware", () => {
  const record = createNormalizedForecastAnchorRecord(baseInput);
  const retry = createNormalizedForecastAnchorRecord({
    ...baseInput,
    receivedAt: "2026-08-22T04:10:01.000Z",
  });

  assert.equal(forecastAnchorRecordIdentity(record), forecastAnchorRecordIdentity(retry));
  assert.equal(forecastAnchorRecordContent(record), forecastAnchorRecordContent(retry));
  assert.notEqual(
    forecastAnchorRecordIdentity(record),
    forecastAnchorRecordIdentity({ ...record, leadHours: 48 }),
  );
  assert.notEqual(
    forecastAnchorRecordIdentity(record),
    forecastAnchorRecordIdentity({ ...record, sourceId: "other-source" }),
  );
  assert.notEqual(
    forecastAnchorRecordContent(record),
    forecastAnchorRecordContent({
      ...record,
      metrics: { ...record.metrics, temperatureC: 10 },
    }),
  );
  assert.notEqual(
    forecastAnchorRecordContent(record),
    forecastAnchorRecordContent({ ...record, contractEpoch: "changed/v2" }),
  );
});

// verify disjoint fixed-anchor and retrieval cohorts
test("U-FPR-06 fixed anchors project only to fixed-anchor cohort semantics", () => {
  const row = createFixedLeadAnchorTrainingRow(
    createNormalizedForecastAnchorRecord(baseInput),
  );

  assert.equal(row.cohort, "fixed_lead_anchor");
  assert.equal(row.referenceKind, "fixed_lead_anchor");
  assert.equal(row.targetLeadHours, 24);
  assert.equal("referenceAt" in row, false);
  assert.equal("productRunAt" in row, false);
});

// verify retrieval lead derivation and eligibility edges
test("U-FPR-03 and U-FPR-07 retrieval snapshots derive leads without clamping", () => {
  const retrievalBase = {
    adapterVersion: "open-meteo-forecast/v4",
    contractEpoch: "forecast-daily/v4:source-fingerprint",
    dataset: "forecast",
    metrics,
    sourceConfigFingerprint: "b".repeat(64),
    sourceId: "open-meteo-forecast-v4",
    stableRecordId: "record-1",
    upstreamModel: "best_match",
    validAt: "2026-08-23T04:00:00.000Z",
  };
  const oneSecond = createLegacyV4RetrievalSnapshotTrainingRow({
    ...retrievalBase,
    referenceAt: "2026-08-23T03:59:59.000Z",
  });
  const exact168 = createLegacyV4RetrievalSnapshotTrainingRow({
    ...retrievalBase,
    referenceAt: "2026-08-16T04:00:00.000Z",
  });

  assert.equal(oneSecond?.targetLeadHours, 1);
  assert.equal(oneSecond?.referenceKind, "retrieval_snapshot");
  assert.equal(oneSecond?.cohort, "legacy_v4_retrieval_snapshot");
  assert.equal(exact168?.targetLeadHours, 168);
  assert.equal(
    createLegacyV4RetrievalSnapshotTrainingRow({
      ...retrievalBase,
      referenceAt: retrievalBase.validAt,
    }),
    null,
  );
  assert.equal(
    createLegacyV4RetrievalSnapshotTrainingRow({
      ...retrievalBase,
      referenceAt: "2026-08-16T03:59:59.000Z",
    }),
    null,
  );
  assert.throws(
    () =>
      createLegacyV4RetrievalSnapshotTrainingRow({
        ...retrievalBase,
        referenceAt: "2026-08-23T04:00:01.000Z",
      }),
    /after validAt/u,
  );
});
