import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  FORECAST_ADJUSTMENT_METRICS,
  FORECAST_LEAD_BANDS,
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "@weather/domain";

import {
  addLocalCalendarDays,
  canonicalJsonBytes,
  canonicalSha256,
  fitRetainedForecastAdjustmentFullHistoryResearch,
  evaluateRetainedForecastAdjustmentTemperatureLeads,
  evaluateRetainedForecastAdjustmentTemperatureWeather,
  localCalendarFeaturesFor,
} from "../dist/index.js";

const STATION_KEYS = [
  "ambient-merlin",
  "tempest-38270",
  "tempest-64255",
];
const SOURCE_IDENTITIES = [
  ...STATION_KEYS.map((stationKey) => {
    const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
      (candidate) => candidate.physicalStationKey === stationKey,
    );

    // retain exact frozen station lineage
    if (lineage === undefined) {
      throw new Error("station source fixture is unavailable");
    }

    return {
      adapterContract: lineage.adapterContract,
      sourceConfigFingerprint: lineage.checkedFingerprint,
      sourceKey: lineage.sourceKey,
    };
  }),
  {
    adapterContract: "previous-runs-hourly/v1",
    sourceConfigFingerprint:
      "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
    sourceKey: "open-meteo-previous-runs-v1",
  },
  {
    adapterContract: "forecast-daily/v4",
    sourceConfigFingerprint:
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    sourceKey: "open-meteo-forecast-v4",
  },
].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

// hash exact fixture bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// derive one Los Angeles local midnight
function localMidnight(localDate) {
  return Date.parse(`${localDate}T08:00:00.000Z`);
}

// create one exact complete station row
function stationRow(stationKey, validAt) {
  const station = FORECAST_OBSERVATION_STATIONS.find(
    (candidate) => candidate.key === stationKey,
  );
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
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

// append one compressed member
function addMember(members, memberBytes, input) {
  const plaintext = Buffer.from(
    input.rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const compressed = gzipSync(plaintext, { mtime: 0 });
  const instants = input.rows.map((row) => row.valid_at).sort();
  memberBytes.set(input.path, compressed);
  members.push({
    localDate: input.localDate,
    maxValidAt: instants.at(-1),
    minValidAt: instants[0],
    path: input.path,
    plaintextBytes: plaintext.byteLength,
    recordKind: input.recordKind,
    rowCount: input.rows.length,
    sha256: sha256(compressed),
    sizeBytes: compressed.byteLength,
    stationKey: input.stationKey,
  });
}

// package one bounded independent research snapshot
async function createSnapshot(evidenceRoot, input) {
  const memberBytes = new Map();
  const members = [];
  const observedSourceKeys = new Set();

  // package each exact local date
  for (let index = input.startIndex; index <= input.endIndex; index += 1) {
    const localDate = addLocalCalendarDays("2026-01-01", index);
    const start = localMidnight(localDate);
    const instants = Array.from({ length: 24 }, (_, hour) =>
      new Date(start + hour * 3_600_000).toISOString(),
    );

    // retain every station at every forecast instant
    for (const stationKey of STATION_KEYS) {
      addMember(members, memberBytes, {
        localDate,
        path: `members/${localDate}/station-hour/${stationKey}.jsonl.gz`,
        recordKind: "station-hour",
        rows: instants.map((instant) => stationRow(stationKey, instant)),
        stationKey,
      });
      observedSourceKeys.add(
        SOURCE_IDENTITIES.find((identity) =>
          identity.sourceKey.startsWith(stationKey))?.sourceKey,
      );
    }

    // retain explicit whole-date archive gaps
    if (index !== input.skipFixedIndex) {
      const fixedRows = instants.flatMap((instant) =>
        FORECAST_LEAD_BANDS.map((leadBand) =>
          fixedLeadRow(instant, leadBand.maximumHours),
        ),
      );
      addMember(members, memberBytes, {
        localDate,
        path: `members/${localDate}/fixed-lead-anchor/open-meteo.jsonl.gz`,
        recordKind: "fixed-lead-anchor",
        rows: fixedRows,
        stationKey: null,
      });
      observedSourceKeys.add("open-meteo-previous-runs-v1");
    }

    // overlap the final fit with the separate live diagnostic period
    if (index >= 50) {
      const liveRows = instants.flatMap((instant) =>
        FORECAST_LEAD_BANDS.map((leadBand) =>
          ({
            ...liveV4Row(instant, leadBand.maximumHours),
            relative_humidity_percent: input.liveHumidityPercent === undefined ? 60 : input.liveHumidityPercent,
            temperature_c: input.liveTemperatureC ?? 10,
            wind_speed_mps: input.liveWindSpeedMps === undefined ? 4 : input.liveWindSpeedMps,
          }),
        ),
      );

      // prefer a different row for other metrics without changing the temperature selection
      if (input.liveFeatureConflict === true) {
        liveRows.push(...liveRows.map(
          // give the competing non-temperature metrics higher jitter priority
          (row) => ({
            ...row,
            content_hashes: [sha256(`conflicting-features:${row.valid_at}:${row.target_lead_hours}`)],
            reference_at: new Date(
              Date.parse(row.valid_at) - (row.target_lead_hours - 0.1) * 3_600_000,
            ).toISOString(),
            relative_humidity_percent: 95,
            temperature_c: null,
            wind_speed_mps: 9,
          }),
        ));
      }
      addMember(members, memberBytes, {
        localDate,
        path: `members/${localDate}/legacy-v4-retrieval/open-meteo.jsonl.gz`,
        recordKind: "legacy-v4-retrieval",
        rows: liveRows,
        stationKey: null,
      });
      observedSourceKeys.add("open-meteo-forecast-v4");
    }
  }

  members.sort((left, right) => left.path.localeCompare(right.path));
  const fromLocalDate = addLocalCalendarDays("2026-01-01", input.startIndex);
  const toLocalDate = addLocalCalendarDays("2026-01-01", input.endIndex);
  const localDateCount = input.endIndex - input.startIndex + 1;
  const observedSourceIdentities = SOURCE_IDENTITIES.filter((identity) =>
    observedSourceKeys.has(identity.sourceKey),
  );
  const manifest = {
    aggregationContractSha256:
      "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
    contractVersion: "forecast-training-export-package/v1",
    coordinateManifestSha256:
      "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
    createdAtUtc: "2026-09-06T00:00:00.000Z",
    databaseManifest: {
      migration_checksums: ["a".repeat(64)],
      migration_names: ["0010_forecast_training_export.sql"],
      query_contract_version: "forecast-training-export-query/v2",
      schema_migration: "0010_forecast_training_export.sql",
    },
    fromLocalDate,
    limits: {
      conservativeExportRowFormula: "450 * ((24 * 264) + (11 * 24) + 168)",
      conservativeExportRows: 3_045_600,
      exportRowHeadroom: 954_400,
      maxDays: 450,
      maxRows: 4_000_000,
      rowCountMeaning: "export_rows_not_training_events",
    },
    members,
    metricEligibilitySha256:
      "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
    migrationHistorySha256: input.migrationHistorySha256 ?? "b".repeat(64),
    observedSourceIdentities,
    queryContractSha256:
      "3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76",
    queryContractVersion: "forecast-training-export-query/v2",
    rowSchemaSha256:
      "2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc",
    siteKey: "ballydidean",
    siteTimezone: "America/Los_Angeles",
    sourceIdentities: SOURCE_IDENTITIES,
    sourceLineageSha256:
      "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
    spatialWeightsSha256:
      "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
    stationMetricCoverage: FORECAST_OBSERVATION_STATIONS.map((station) => ({
      eligibleMetricNonNullLocalDates: {
        relative_humidity_percent: STATION_KEYS.includes(station.key)
          ? localDateCount
          : 0,
        temperature_c: STATION_KEYS.includes(station.key) ? localDateCount : 0,
        wind_direction_degrees: STATION_KEYS.includes(station.key)
          ? localDateCount
          : 0,
        wind_gust_mps: STATION_KEYS.includes(station.key) ? localDateCount : 0,
        wind_speed_mps: STATION_KEYS.includes(station.key) ? localDateCount : 0,
      },
      stationKey: station.key,
    })),
    stationManifestSha256:
      "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
    toLocalDate,
    totalRowCount: members.reduce((sum, member) => sum + member.rowCount, 0),
    transaction: {
      idleInTransactionSessionTimeout: "30s",
      isolationLevel: "repeatable read",
      lockTimeout: "5s",
      readOnly: "on",
      statementTimeout: "15min",
    },
    usageBoundary: {
      databaseImportAllowed: false,
      productionDerived: true,
      snapshotOnly: true,
    },
  };
  const manifestBytes = canonicalJsonBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const snapshotRoot = join(evidenceRoot, manifestSha256);

  // publish exact fixture members and control files
  for (const [path, bytes] of memberBytes) {
    await mkdir(join(snapshotRoot, dirname(path)), { recursive: true });
    await writeFile(join(snapshotRoot, path), bytes);
  }
  await writeFile(join(snapshotRoot, "manifest.json"), manifestBytes);
  await writeFile(
    join(snapshotRoot, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
  );
  return snapshotRoot;
}

// create one complete two-snapshot fixture
async function createCompleteFixture(context, options = {}) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "weather-full-history-"));
  // clean this fixture even when construction or assertions fail
  context.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const first = await createSnapshot(evidenceRoot, {
    endIndex: 26,
    startIndex: 0,
  });
  const second = await createSnapshot(evidenceRoot, {
    endIndex: options.secondEndIndex ?? 52,
    migrationHistorySha256: options.migrationHistorySha256,
    liveFeatureConflict: options.liveFeatureConflict,
    liveHumidityPercent: options.liveHumidityPercent,
    liveTemperatureC: options.liveTemperatureC,
    liveWindSpeedMps: options.liveWindSpeedMps,
    skipFixedIndex: options.skipFixedIndex,
    startIndex: options.secondStartIndex ?? 27,
  });
  return {
    evidenceRoot,
    expectedRange: {
      fromLocalDate: "2026-01-01",
      toLocalDate: addLocalCalendarDays(
        "2026-01-01",
        options.secondEndIndex ?? 52,
      ),
    },
    snapshotPaths: [first, second],
  };
}

// verify full-history support and non-promotable implementation identity
test("full-history research fit is deterministic, complete, and inactive", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const first = await fitRetainedForecastAdjustmentFullHistoryResearch(fixture);
  const second = await fitRetainedForecastAdjustmentFullHistoryResearch(fixture);
  const expectedPairs = FORECAST_ADJUSTMENT_METRICS.length * FORECAST_LEAD_BANDS.length;

  assert.deepEqual(first, second);
  const implementationIdentity = {
    algorithmContractVersion: "robust-hierarchical-median/v1",
    algorithmModuleSha256: sha256(await readFile(new URL("../dist/algorithm-v1.js", import.meta.url))),
    calendarModuleSha256: sha256(await readFile(new URL("../dist/calendar.js", import.meta.url))),
    domainModuleSha256: sha256(await readFile(new URL("../../domain/dist/forecast-adjustment.js", import.meta.url))),
    fitterModuleSha256: sha256(await readFile(new URL("../dist/evidence.js", import.meta.url))),
    implementationVersion: "forecast-adjustment-full-history-research/v1",
  };
  assert.deepEqual(first.algorithmIdentity, {
    ...implementationIdentity,
    implementationSha256: canonicalSha256(implementationIdentity),
  });
  assert.equal(first.contractVersion, "forecast-adjustment-full-history-research-result/v1");
  assert.equal(first.snapshots.length, 2);
  assert.equal(first.finalFit.metricBands.length, expectedPairs);
  assert.equal(first.finalFit.metricBands.every((pair) => pair.eventCount > 200), true);
  assert.deepEqual(
    new Set(first.finalFit.metricBands.map((pair) => pair.metricBand.metric)),
    new Set(FORECAST_ADJUSTMENT_METRICS),
  );
  assert.deepEqual(
    new Set(first.finalFit.metricBands.map((pair) => pair.metricBand.leadBand)),
    new Set(FORECAST_LEAD_BANDS.map((leadBand) => leadBand.key)),
  );
  assert.equal(first.archiveDiagnostic.scores.length, expectedPairs);
  assert.equal(first.liveV4Diagnostic.scores.length, expectedPairs);
  assert.equal(
    first.archiveDiagnostic.scores.every(
      (score) => score.modelFitted && score.matchedNetworkEventCount > 0,
    ),
    true,
  );
  assert.equal(
    first.liveV4Diagnostic.scores.every(
      (score) => score.modelFitted && score.matchedNetworkEventCount > 0,
    ),
    true,
  );
  assertDiagnosticEmbargo(first.archiveDiagnostic);
  assertDiagnosticEmbargo(first.liveV4Diagnostic);
  assert.equal(first.archiveDiagnostic.scoreMissingLocalDateCount, 0);
  assert.equal(first.finalFit.fixedAnchorMissingLocalDateCount, 0);
  assert.equal(first.productionActivationAllowed, false);
  assert.equal(first.promotable, false);
  assert.equal(first.runtimeBundleCreated, false);
  assert.equal(first.qualificationStatus, "not_qualified");
  assert.equal(first.finalFit.exactModelIndependentlyValidated, false);
  assert.equal(first.trainingForecastIdentity.cohort, "fixed_lead_anchor");
  assert.equal(first.servedForecastIdentity.cohort, "legacy_v4_retrieval_snapshot");
  assert.equal(/candidateArtifactSha256|qualificationReceiptSha256|"bundle":/u.test(
    JSON.stringify(first),
  ), false);
});

// isolate diagnostic models from later refit material
test("diagnostic models remain fixed when only final-fit evidence changes", { timeout: 30_000 }, async (context) => {
  const baselineFixture = await createCompleteFixture(context);
  const changedFinalFixture = await createCompleteFixture(context, { skipFixedIndex: 52 });
  const baseline = await fitRetainedForecastAdjustmentFullHistoryResearch(
    baselineFixture,
  );
  const changedFinal = await fitRetainedForecastAdjustmentFullHistoryResearch(
    changedFinalFixture,
  );

  assert.equal(
    changedFinal.archiveDiagnostic.diagnosticModelSha256,
    baseline.archiveDiagnostic.diagnosticModelSha256,
  );
  assert.equal(
    changedFinal.liveV4Diagnostic.diagnosticModelSha256,
    baseline.liveV4Diagnostic.diagnosticModelSha256,
  );
  assert.notEqual(
    changedFinal.coefficientPayloadSha256,
    baseline.coefficientPayloadSha256,
  );
});

// preserve rather than impute missing archive dates
test("full-history research preserves actual fixed-anchor date gaps", async (context) => {
  const fixture = await createCompleteFixture(context, { skipFixedIndex: 35 });
  const result = await fitRetainedForecastAdjustmentFullHistoryResearch(fixture);
  const missingLocalDate = addLocalCalendarDays("2026-01-01", 35);

  assert.deepEqual(result.finalFit.fixedAnchorMissingLocalDates, [missingLocalDate]);
  assert.equal(
    result.finalFit.metricBands.every(
      (pair) => pair.missingLocalDates.includes(missingLocalDate),
    ),
    true,
  );
  assert.equal(
    result.archiveDiagnostic.scoreMissingLocalDates.includes(missingLocalDate),
    true,
  );
});

// reject gaps between declared snapshot boundaries
test("full-history research rejects noncontiguous snapshot boundaries", async (context) => {
  const fixture = await createCompleteFixture(context, { secondStartIndex: 28 });

  await assert.rejects(
    fitRetainedForecastAdjustmentFullHistoryResearch(fixture),
    /chronological and contiguous/u,
  );
});

// reject mixed production provenance across snapshots
test("full-history research rejects cross-snapshot provenance drift", async (context) => {
  const fixture = await createCompleteFixture(context, {
    migrationHistorySha256: "c".repeat(64),
  });

  await assert.rejects(
    fitRetainedForecastAdjustmentFullHistoryResearch(fixture),
    /snapshot identity drift/u,
  );
});

// bind both operator-requested history endpoints
test("full-history research rejects truncated expected-range boundaries", async (context) => {
  const fixture = await createCompleteFixture(context);

  await assert.rejects(
    fitRetainedForecastAdjustmentFullHistoryResearch({
      ...fixture,
      expectedRange: {
        ...fixture.expectedRange,
        fromLocalDate: "2025-12-31",
      },
    }),
    /do not cover the expected range/u,
  );
  await assert.rejects(
    fitRetainedForecastAdjustmentFullHistoryResearch({
      ...fixture,
      expectedRange: {
        ...fixture.expectedRange,
        toLocalDate: "2026-02-23",
      },
    }),
    /do not cover the expected range/u,
  );
});

// preserve inputs across asynchronous filesystem reads
test("full-history research snapshots caller inputs before filesystem awaits", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const expectedRange = { ...fixture.expectedRange };
  const snapshotPaths = [...fixture.snapshotPaths];
  const pending = fitRetainedForecastAdjustmentFullHistoryResearch({
    evidenceRoot: fixture.evidenceRoot,
    expectedRange,
    snapshotPaths,
  });

  expectedRange.fromLocalDate = "2025-12-31";
  expectedRange.toLocalDate = "2026-02-23";
  snapshotPaths.reverse();
  const result = await pending;

  assert.deepEqual(result.expectedRange, fixture.expectedRange);
  assert.deepEqual(
    result.snapshots.map((snapshot) => snapshot.manifestSha256),
    fixture.snapshotPaths.map((path) => path.split("/").at(-1)),
  );
});

// assert a full seven-date embargo before each score window
function assertDiagnosticEmbargo(diagnostic) {
  const trainingEndLocalDate = localCalendarFeaturesFor(
    diagnostic.trainingEventMaximumValidAt,
  ).localDate;

  assert.equal(trainingEndLocalDate < diagnostic.embargoStartLocalDate, true);
  assert.equal(
    addLocalCalendarDays(diagnostic.embargoStartLocalDate, 6),
    diagnostic.embargoEndLocalDate,
  );
  assert.equal(
    addLocalCalendarDays(diagnostic.embargoStartLocalDate, 7),
    diagnostic.scoreStartLocalDate,
  );
}

// preserve baseline isolation while sharing the validated snapshot reader
test("retained temperature research ignores post-baseline archive changes", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const changed = await createCompleteFixture(context, { skipFixedIndex: 52 });
  const first = await evaluateRetainedForecastAdjustmentTemperatureLeads(fixture);
  const second = await evaluateRetainedForecastAdjustmentTemperatureLeads(changed);
  assert.equal(first.contractVersion, "forecast-adjustment-retained-temperature-lead-research/v1");
  assert.equal(first.baseline.modelSha256, second.baseline.modelSha256);
  assert.deepEqual(first.analysis, second.analysis);
  assert.equal(first.baseline.fitted.length, 7);
  assert.equal(first.baseline.coverage.adjusted, 3 * 24 * 7);
  assert.equal(
    Date.parse(first.baseline.finalTrainingCutoff) + 3_600_000 <=
      Date.parse(first.baseline.earliestForecastReferenceAt),
    true,
  );
  assert.equal(first.productionActivationAllowed, false);
  assert.equal(first.promotable, false);
  assert.equal(first.runtimeBundleCreated, false);
  assert.equal(first.analysis.productionActivationAllowed, false);
  assert.equal(
    first.implementationModules.some((module) =>
      module.name === "@weather/domain/forecast-adjustment.js" && /^[a-f0-9]{64}$/u.test(module.sha256)),
    true,
  );
});

// retain out-of-envelope forecasts as raw rather than cherry-picking coverage
test("retained temperature research scores raw envelope fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const result = await evaluateRetainedForecastAdjustmentTemperatureLeads(fixture);
  assert.equal(result.baseline.coverage.adjusted, 0);
  assert.equal(result.baseline.coverage.missingCoefficient, 0);
  assert.equal(result.baseline.coverage.outsideTrainingEnvelope, 3 * 24 * 7);
  assert.equal(result.productionActivationAllowed, false);
});

// preserve the exact temperature-row features through metric-specific jitter selection
test("weather research binds selected forecast features and isolated windows", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const conflicting = await createCompleteFixture(context, { liveFeatureConflict: true });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...fixture, experimentPlanSha256: "a".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...conflicting, experimentPlanSha256: "a".repeat(64),
  });
  assert.equal(first.contractVersion, "forecast-adjustment-retained-temperature-weather-research/v1");
  assert.equal(first.productionActivationAllowed, false);
  assert.equal(first.promotable, false);
  assert.equal(first.runtimeBundleCreated, false);
  assert.equal(first.predictorSource, "exact_selected_temperature_forecast_row_not_observations");
  assert.equal(first.experimentPlanSha256, "a".repeat(64));
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.diagnostics.length, 6);
  assert.deepEqual(
    first.diagnostics.at(-1).analysis.diagnostics.byWeatherRegime.filter(
      // isolate only genuinely observed forecast regimes
      (slice) => slice.comparison.raw.eventCount > 0,
    ).map(
      // prove forecast wind is used instead of valid-time station wind
      (slice) => [slice.humidityBin, slice.windSpeedBin],
    ),
    [["[50,80)", "[2,5)"]],
  );
  assert.deepEqual(
    first.diagnostics.slice(0, 4).map(
      // retain the four predeclared seasonal archive windows
      (diagnostic) => [diagnostic.fromLocalDate, diagnostic.toLocalDate],
    ),
    [
      ["2025-01-01", "2025-01-30"],
      ["2025-04-01", "2025-04-30"],
      ["2025-07-01", "2025-07-30"],
      ["2025-10-01", "2025-10-30"],
    ],
  );

  // verify every available diagnostic obeys both cutoff boundaries
  for (const diagnostic of first.diagnostics) {
    assert.equal(diagnostic.trainingBeforeInformationBoundary, true);

    // check only genuine fitted windows
    if (diagnostic.baseline.finalTrainingCutoff !== null) {
      assert.ok(localCalendarFeaturesFor(diagnostic.baseline.finalTrainingCutoff).localDate < diagnostic.embargoStartLocalDate);
      assert.ok(Date.parse(diagnostic.baseline.finalTrainingCutoff) + 3_600_000 <= Date.parse(diagnostic.informationBoundaryAt));
    }
  }
});

// keep all diagnostic models independent from later archive material
test("weather research models ignore post-cutoff archive changes", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const changed = await createCompleteFixture(context, { skipFixedIndex: 52 });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...fixture, experimentPlanSha256: "a".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...changed, experimentPlanSha256: "a".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
});

// preserve raw output for every variant when the baseline envelope rejects a forecast
test("weather research retains out-of-envelope temperature examples", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const result = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...fixture, experimentPlanSha256: "a".repeat(64),
  });
  const live = result.diagnostics.at(-1);
  assert.equal(live.baseline.scoreCoverage.outsideTrainingEnvelope, 3 * 24 * 7);

  // require identical raw results rather than dropping unsupported forecasts
  for (const score of Object.values(live.analysis.overall)) {
    assert.deepEqual(score, live.analysis.overall.raw);
  }
});

// retain forecasts whose weather predictors are missing rather than borrowing observations
test("weather research preserves missing predictor fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const result = await evaluateRetainedForecastAdjustmentTemperatureWeather({
    ...fixture, experimentPlanSha256: "a".repeat(64),
  });
  const live = result.diagnostics.at(-1).analysis;
  assert.equal(live.inputCoverage.eventCount, 3 * 24 * 7);
  assert.equal(live.coverage.calendarTemperatureWeather.weatherFeatureMissingCount, 3 * 24 * 7);
  assert.deepEqual(live.overall.calendarTemperatureWeather, live.overall.calendarTemperature);
});
