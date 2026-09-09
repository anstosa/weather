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
  evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon,
  evaluateRetainedForecastAdjustmentTemperatureOnly,
  evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive,
  evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid,
  evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage,
  evaluateRetainedForecastAdjustmentTemperatureWeatherRecency,
  evaluateRetainedForecastAdjustmentTemperatureBoosted,
  evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid,
  evaluateRetainedForecastAdjustmentTemperatureNearNowcast,
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
      const liveLeadHours = input.liveLeadHours ?? FORECAST_LEAD_BANDS.map(
        // preserve the original fixture leads unless explicitly overridden
        (leadBand) => leadBand.maximumHours,
      );
      const liveRows = instants.flatMap(
        // retain the requested near-term and unchanged longer-range examples
        (instant) => liveLeadHours.map(
          // materialize one observed retrieval for each declared lead
          (targetLeadHours) =>
          ({
            ...liveV4Row(instant, targetLeadHours),
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
    liveLeadHours: options.liveLeadHours,
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

// supply a deterministic stand-in without requiring a research runtime in application tests
function retainedBoostedTrainer(request) {
  return {
    modelJson: JSON.stringify({ trainingRequest: canonicalSha256({
      features: request.trainingFeatures,
      residuals: request.trainingResiduals,
      weights: request.trainingWeights,
      identities: request.trainingIds,
    }) }),
    configJson: JSON.stringify({ fixture: true }),
    predictionIds: [...request.predictionIds],
    predictedResiduals: request.predictionIds.map(
      // apply one bounded test correction to every requested forecast
      () => 1,
    ),
  };
}

// create fresh caller-owned external implementation identities
function retainedBoostedIdentity() {
  return {
    contractVersion: "temperature-boosted-python-bridge/v1",
    runtimeSha256: "1".repeat(64),
    sourceSha256: "2".repeat(64),
    parametersSha256: "3".repeat(64),
  };
}

// retain the unchanged original report and bind the isolated trainer
test("boosted research preserves original reports and external implementation identities", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "5".repeat(64) };
  const original = await evaluateRetainedForecastAdjustmentTemperatureWeather(input);
  const trainerIdentity = retainedBoostedIdentity();
  const boosted = await evaluateRetainedForecastAdjustmentTemperatureBoosted({
    ...input, trainer: retainedBoostedTrainer, trainerIdentity,
  });
  assert.equal(boosted.contractVersion, "forecast-adjustment-retained-temperature-boosted-research/v1");
  assert.equal(boosted.productionActivationAllowed, false);
  assert.equal(boosted.promotable, false);
  assert.equal(boosted.runtimeBundleCreated, false);
  assert.equal(boosted.diagnostics.length, 6);
  assert.equal(boosted.snapshotIdentitySha256, original.snapshotIdentitySha256);
  assert.deepEqual(boosted.externalTrainer, trainerIdentity);
  assert.equal(boosted.implementationIdentitySha256, canonicalSha256({
    implementationModules: boosted.implementationModules,
    runtime: boosted.runtime,
    externalTrainer: trainerIdentity,
  }));
  assert.notEqual(boosted.implementationIdentitySha256, original.implementationIdentitySha256);

  // compare every original fit and complete score population
  for (const [index, diagnostic] of boosted.diagnostics.entries()) {
    const previous = original.diagnostics[index];
    const { boostedResidual, contractVersion, ...unchanged } = diagnostic.analysis;
    assert.equal(contractVersion, "temperature-boosted-residual-research/v1");
    assert.deepEqual({ ...unchanged, contractVersion: previous.analysis.contractVersion }, previous.analysis);
    assert.deepEqual({ ...diagnostic, analysis: previous.analysis }, previous);
    assert.deepEqual(boostedResidual.overall.raw, previous.analysis.overall.raw);
    assert.deepEqual(boostedResidual.overall.rawTemperatureWeather, previous.analysis.overall.rawTemperatureWeather);
    assert.equal(boostedResidual.overall.boostedTemperature.eventCount, previous.analysis.inputCoverage.eventCount);
    assert.equal(boostedResidual.first48Hours.raw.eventCount + boostedResidual.after48Hours.raw.eventCount,
      boostedResidual.overall.raw.eventCount);
    assert.equal(boostedResidual.leadScopes.seenExactTrainingLead.raw.eventCount +
      boostedResidual.leadScopes.unseenExactTrainingLead.raw.eventCount,
    boostedResidual.overall.raw.eventCount);

    // preserve all diagnostic metadata and denominator partitions
    for (const [dimension, slices] of Object.entries(boostedResidual.diagnostics)) {
      const oldSlices = previous.analysis.diagnostics[dimension];
      assert.equal(slices.length, oldSlices.length);

      // bind each tree score to the existing raw and static endpoints
      for (const [sliceIndex, slice] of slices.entries()) {
        const oldSlice = oldSlices[sliceIndex];
        assert.deepEqual({ ...slice, comparison: oldSlice.comparison }, oldSlice);
        assert.deepEqual(slice.comparison.raw, oldSlice.comparison.raw);
        assert.deepEqual(slice.comparison.rawTemperatureWeather, oldSlice.comparison.rawTemperatureWeather);
        assert.equal(slice.comparison.boostedTemperature.eventCount, oldSlice.comparison.raw.eventCount);
      }
    }
  }
});

// preserve exact selected forecast features and pre-cutoff training
test("boosted research preserves missing predictors and temporal isolation", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const changed = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true, skipFixedIndex: 52,
  });
  const common = {
    experimentPlanSha256: "5".repeat(64),
    trainer: retainedBoostedTrainer,
    trainerIdentity: retainedBoostedIdentity(),
  };
  const first = await evaluateRetainedForecastAdjustmentTemperatureBoosted({ ...fixture, ...common });
  const second = await evaluateRetainedForecastAdjustmentTemperatureBoosted({ ...changed, ...common });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
  const live = first.diagnostics.at(-1).analysis.boostedResidual;
  assert.equal(live.coverage.missingFeatureCount, 3 * 24 * 7);
  assert.equal(live.overall.boostedTemperature.eventCount, 3 * 24 * 7);
  assert.equal(live.model.modelSha256, sha256(live.model.modelJson));
  assert.ok(live.trainingEvidence.weightSum > 0);
});

// capture callback identity before awaits and retain the original envelope fallback
test("boosted research captures trainer inputs and preserves raw fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = {
    ...fixture, experimentPlanSha256: "5".repeat(64),
    trainer: retainedBoostedTrainer, trainerIdentity: retainedBoostedIdentity(),
  };
  const pending = evaluateRetainedForecastAdjustmentTemperatureBoosted(input);
  input.experimentPlanSha256 = "8".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  input.trainerIdentity.runtimeSha256 = "9".repeat(64);
  // fail if the caller can replace the already captured implementation
  input.trainer = () => { throw new Error("mutated trainer must not run"); };
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "5".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.externalTrainer.runtimeSha256, "1".repeat(64));
  const live = result.diagnostics.at(-1).analysis.boostedResidual;
  assert.deepEqual(live.overall.boostedTemperature, live.overall.raw);
  assert.equal(live.coverage.baselineIneligibleCount, 3 * 24 * 7);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
});

// reject an unidentified external trainer before any retained input reads
test("boosted research rejects unbound external trainers", async () => {
  const input = {
    evidenceRoot: "/not-a-retained-fixture", snapshotPaths: [],
    expectedRange: { fromLocalDate: "2026-01-01", toLocalDate: "2026-01-02" },
    experimentPlanSha256: "5".repeat(64), trainer: retainedBoostedTrainer,
    trainerIdentity: { ...retainedBoostedIdentity(), runtimeSha256: "invalid" },
  };
  await assert.rejects(evaluateRetainedForecastAdjustmentTemperatureBoosted(input), /bound isolated trainer/);
});

// preserve frozen components while recomputing the combined prediction scores
test("boosted hybrid retains tree evidence and original hybrid controls", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = {
    ...fixture, experimentPlanSha256: "4".repeat(64),
    trainer: retainedBoostedTrainer, trainerIdentity: retainedBoostedIdentity(),
  };
  const boosted = await evaluateRetainedForecastAdjustmentTemperatureBoosted(input);
  const original = await evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid(input);
  const combined = await evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid(input);
  assert.equal(combined.contractVersion, "forecast-adjustment-retained-temperature-boosted-hybrid-research/v1");
  assert.equal(combined.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(combined.snapshotIdentitySha256, boosted.snapshotIdentitySha256);
  assert.equal(combined.implementationIdentitySha256, boosted.implementationIdentitySha256);
  assert.deepEqual(combined.externalTrainer, input.trainerIdentity);
  assert.equal(combined.productionActivationAllowed, false);
  assert.equal(combined.promotable, false);
  assert.equal(combined.runtimeBundleCreated, false);

  // retain every original fit and archive score without synthetic hybrid evidence
  for (const [index, diagnostic] of combined.diagnostics.entries()) {
    const previous = boosted.diagnostics[index];
    const { boostedHybrid, contractVersion, ...unchanged } = diagnostic.analysis;
    assert.equal(contractVersion, "temperature-boosted-hybrid-research/v1");
    assert.deepEqual({ ...unchanged, contractVersion: previous.analysis.contractVersion }, previous.analysis);
    assert.deepEqual({ ...diagnostic, analysis: previous.analysis }, previous);

    // archive anchors cannot supply genuine retrieval-time calibration
    if (diagnostic.cohort === "fixed_lead_anchor") {
      assert.equal(boostedHybrid.status, "not_applicable_archive_cohort");
      assert.equal(boostedHybrid.overall, null);
      assert.equal(boostedHybrid.diagnostics, null);
      continue;
    }

    const oldHybrid = original.diagnostics[index].analysis.hybridCorrection;
    assert.deepEqual(boostedHybrid.causalAudit, oldHybrid.causalAudit);
    assert.deepEqual(boostedHybrid.first48Hours.boostedHybrid, oldHybrid.first48Hours.hybrid);
    assert.deepEqual(boostedHybrid.after48Hours.boostedHybrid, previous.analysis.boostedResidual.after48Hours.boostedTemperature);

    // preserve all component scores on identical complete populations
    for (const scope of ["overall", "first48Hours", "after48Hours"]) {
      assert.deepEqual(boostedHybrid[scope].hybrid, oldHybrid[scope].hybrid);
      assert.deepEqual(boostedHybrid[scope].causalAdaptive, oldHybrid[scope].causalAdaptive);
      assert.deepEqual(boostedHybrid[scope].boostedTemperature, previous.analysis.boostedResidual[scope].boostedTemperature);
      assert.equal(boostedHybrid[scope].boostedHybrid.eventCount, oldHybrid[scope].raw.eventCount);
    }

    // preserve slice metadata and every inherited hybrid control
    for (const [dimension, slices] of Object.entries(boostedHybrid.diagnostics)) {
      assert.equal(slices.length, oldHybrid.diagnostics[dimension].length);

      // compare all descriptive slices without selecting favorable periods
      for (const [sliceIndex, slice] of slices.entries()) {
        const previousSlice = oldHybrid.diagnostics[dimension][sliceIndex];
        assert.deepEqual({ ...slice, comparison: previousSlice.comparison }, previousSlice);
        assert.deepEqual(slice.comparison.hybrid, previousSlice.comparison.hybrid);
        assert.equal(slice.comparison.boostedHybrid.eventCount, previousSlice.comparison.raw.eventCount);
      }
    }
  }
});

// snapshot injected replay state and preserve complete out-of-envelope cohorts
test("boosted hybrid captures caller inputs and keeps raw fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = {
    ...fixture, experimentPlanSha256: "4".repeat(64),
    trainer: retainedBoostedTrainer, trainerIdentity: retainedBoostedIdentity(),
  };
  const pending = evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid(input);
  input.experimentPlanSha256 = "8".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  input.trainerIdentity.runtimeSha256 = "9".repeat(64);
  // reject a late caller replacement of the captured replay callback
  input.trainer = () => { throw new Error("mutated trainer must not run"); };
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "4".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.externalTrainer.runtimeSha256, "1".repeat(64));
  const combined = result.diagnostics.at(-1).analysis.boostedHybrid;
  assert.equal(combined.overall.boostedHybrid.eventCount, 3 * 24 * 7);
  assert.deepEqual(combined.overall.boostedHybrid, combined.overall.raw);
});

// share strict implementation validation before any private snapshot reads
test("boosted hybrid rejects unbound external replay implementations", async () => {
  await assert.rejects(evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid({
    evidenceRoot: "/not-a-retained-fixture", snapshotPaths: [],
    expectedRange: { fromLocalDate: "2026-01-01", toLocalDate: "2026-01-02" },
    experimentPlanSha256: "4".repeat(64), trainer: retainedBoostedTrainer,
    trainerIdentity: { ...retainedBoostedIdentity(), parametersSha256: "invalid" },
  }), /bound isolated trainer/);
});

// retain complete controls and bind private predictions without publishing rows
test("near nowcast retains boosted hybrid controls and an immutable private audit", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveLeadHours: [1, 6, 12, 13, 24, 48, 49, 168] });
  const input = {
    ...fixture, experimentPlanSha256: "a".repeat(64),
    trainer: retainedBoostedTrainer, trainerIdentity: retainedBoostedIdentity(),
  };
  const previous = await evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid(input);
  const audits = [];
  const result = await evaluateRetainedForecastAdjustmentTemperatureNearNowcast({
    ...input,
    // retain audit material only in this private test callback
    onPrivatePredictionAudit(records) {
      audits.push(records);
      assert.equal(Object.isFrozen(records), true);
      assert.equal(Object.isFrozen(records[0]), true);
      assert.equal(Object.isFrozen(records[0].selectedSources), true);
      assert.throws(() => { records[0].actual = -999; }, TypeError);
    },
  });
  assert.equal(result.contractVersion, "forecast-adjustment-retained-temperature-near-nowcast-research/v1");
  assert.equal(result.snapshotIdentitySha256, previous.snapshotIdentitySha256);
  assert.equal(result.implementationIdentitySha256, previous.implementationIdentitySha256);
  assert.equal(result.productionActivationAllowed, false);
  assert.equal(result.promotable, false);
  assert.equal(result.runtimeBundleCreated, false);
  assert.equal(result.implementationModules.some(
    // bind the new numerical helper into retained implementation evidence
    (module) => module.name === "temperature-nowcast-research.js",
  ), true);

  // preserve every original model and diagnostic payload
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    const source = previous.diagnostics[index];
    const { nearNowcast, contractVersion, ...unchanged } = diagnostic.analysis;
    assert.equal(contractVersion, "temperature-near-nowcast-research/v1");
    assert.deepEqual({ ...unchanged, contractVersion: source.analysis.contractVersion }, source.analysis);
    assert.deepEqual({ ...diagnostic, analysis: source.analysis }, source);

    // exclude synthetic archive nowcast scores and private callbacks
    if (diagnostic.cohort === "fixed_lead_anchor") {
      assert.equal(nearNowcast.status, "not_applicable_archive_cohort");
      assert.equal(nearNowcast.first12Hours, null);
      assert.equal(nearNowcast.causalAudit, null);
      continue;
    }

    // retain complete previously scored horizon endpoints
    for (const scope of ["overall", "first48Hours", "after48Hours"]) {
      assert.deepEqual(nearNowcast[scope].raw, source.analysis.boostedHybrid[scope].raw);
      assert.deepEqual(nearNowcast[scope].boostedHybrid, source.analysis.boostedHybrid[scope].boostedHybrid);
    }
    assert.deepEqual(nearNowcast.after48Hours.nearNowcast, nearNowcast.after48Hours.boostedHybrid);
    assert.deepEqual(nearNowcast.hours13To48.nearNowcast, nearNowcast.hours13To48.boostedHybrid);
    assert.equal(nearNowcast.overall.raw.eventCount, 3 * 24 * 8);
    assert.equal(nearNowcast.first12Hours.raw.eventCount, 3 * 24 * 3);
    assert.ok(nearNowcast.coverage.adjustedEventCount > 0);
    assert.ok(nearNowcast.coverage.first12FallbackEventCount > 0);
    assert.equal(nearNowcast.first12Diagnostics.byLocalDate.length, 3);
  }
  assert.equal(audits.length, 1);
  const records = audits[0];
  const live = result.diagnostics.at(-1).analysis.nearNowcast;
  assert.equal(records.length, 3 * 24 * 8);
  assert.equal(live.causalAudit.auditSha256, canonicalSha256(records));
  assert.equal(live.causalAudit.recordCount, records.length);
  assert.equal(/"selectedSources"|"priorBoostedHybridPrediction"|"nearNowcastPrediction"/u.test(JSON.stringify(result)), false);

  // retain every later individual prediction without additional clipping
  for (const record of records) {
    // limit the new method to its frozen first-twelve-hour scope
    if (record.targetLeadHours > 12) {
      assert.equal(record.nearNowcastPrediction, record.priorBoostedHybridPrediction);
    }
  }
});

// capture callback state before awaits and preserve complete envelope fallbacks
test("near nowcast captures caller inputs and retains ineligible targets", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, {
    liveTemperatureC: 30, liveLeadHours: [1, 6, 12, 13, 24, 48, 49, 168],
  });
  let records;
  const input = {
    ...fixture, experimentPlanSha256: "a".repeat(64),
    trainer: retainedBoostedTrainer, trainerIdentity: retainedBoostedIdentity(),
    // capture the original private callback
    onPrivatePredictionAudit(audit) { records = audit; },
  };
  const pending = evaluateRetainedForecastAdjustmentTemperatureNearNowcast(input);
  input.experimentPlanSha256 = "b".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  input.trainerIdentity.runtimeSha256 = "9".repeat(64);
  // reject late replacements of captured implementations
  input.trainer = () => { throw new Error("mutated trainer must not run"); };
  // reject late replacements of the private evidence sink
  input.onPrivatePredictionAudit = () => { throw new Error("mutated audit callback must not run"); };
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "a".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.externalTrainer.runtimeSha256, "1".repeat(64));
  const live = result.diagnostics.at(-1).analysis.nearNowcast;
  assert.deepEqual(live.overall.nearNowcast, live.overall.raw);
  assert.equal(live.coverage.fallbackCounts.baseline_ineligible, 3 * 24 * 3);
  assert.equal(live.coverage.adjustedEventCount, 0);
  assert.equal(records.length, 3 * 24 * 8);
});

// reject an invalid evidence sink before any retained snapshot access
test("near nowcast rejects invalid audit callbacks before input reads", async () => {
  await assert.rejects(evaluateRetainedForecastAdjustmentTemperatureNearNowcast({
    evidenceRoot: "/not-a-retained-fixture", snapshotPaths: [],
    expectedRange: { fromLocalDate: "2026-01-01", toLocalDate: "2026-01-02" },
    experimentPlanSha256: "a".repeat(64), trainer: retainedBoostedTrainer,
    trainerIdentity: retainedBoostedIdentity(), onPrivatePredictionAudit: "invalid",
  }), /private audit callback must be a function/);
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

// preserve every existing fit and score while adding the fixed horizon gate
test("horizon research preserves the weather report and protects near-term forecasts", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "b".repeat(64) };
  const weather = await evaluateRetainedForecastAdjustmentTemperatureWeather(input);
  const horizon = await evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon(input);
  assert.equal(horizon.contractVersion, "forecast-adjustment-retained-temperature-weather-horizon-research/v1");
  assert.equal(horizon.productionActivationAllowed, false);
  assert.equal(horizon.promotable, false);
  assert.equal(horizon.runtimeBundleCreated, false);
  assert.equal(horizon.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(horizon.snapshotIdentitySha256, weather.snapshotIdentitySha256);
  assert.equal(horizon.implementationIdentitySha256, weather.implementationIdentitySha256);
  assert.equal(horizon.diagnostics.length, 6);

  // retain identical models, chronological boundaries and original comparisons
  for (const [index, diagnostic] of horizon.diagnostics.entries()) {
    const { horizonGate, contractVersion, ...unchangedAnalysis } = diagnostic.analysis;
    const { contractVersion: weatherVersion, ...previousAnalysis } = weather.diagnostics[index].analysis;
    assert.equal(contractVersion, "temperature-weather-horizon-research/v1");
    assert.equal(weatherVersion, "temperature-weather-research/v1");
    assert.deepEqual(unchangedAnalysis, previousAnalysis);
    assert.deepEqual(
      { ...diagnostic, analysis: weather.diagnostics[index].analysis },
      weather.diagnostics[index],
    );
    assert.deepEqual(horizonGate.first48Hours.gatedAfter48Hours, horizonGate.first48Hours.raw);
    assert.deepEqual(horizonGate.after48Hours.gatedAfter48Hours, horizonGate.after48Hours.rawTemperatureWeather);
    assert.deepEqual(horizonGate.overall.raw, diagnostic.analysis.overall.raw);
    assert.deepEqual(horizonGate.overall.rawTemperatureWeather, diagnostic.analysis.overall.rawTemperatureWeather);
  }
});

// snapshot caller-owned paths, dates and plan identity before asynchronous reads
test("horizon research captures caller inputs before filesystem awaits", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "b".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon(input);
  input.experimentPlanSha256 = "c".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "b".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
});

// keep exact-row feature selection and missing-predictor fallbacks in the new path
test("horizon research preserves missing predictors and metric-specific selection", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const conflicting = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true,
  });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon({
    ...fixture, experimentPlanSha256: "b".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon({
    ...conflicting, experimentPlanSha256: "b".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  const live = first.diagnostics.at(-1).analysis.horizonGate;
  assert.equal(live.coverage.eventCount, 3 * 24 * 7);
  assert.equal(live.coverage.rawProtectedEventCount, 3 * 24 * 2);
  assert.equal(live.coverage.after48WeatherFeatureMissingCount, 3 * 24 * 5);
  assert.deepEqual(live.first48Hours.gatedAfter48Hours, live.first48Hours.raw);
  assert.deepEqual(live.after48Hours.gatedAfter48Hours, live.after48Hours.rawTemperatureWeather);
});

// preserve original models, cutoffs and score populations for the stage ablation
test("temperature-only research preserves weather evidence and all six windows", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "d".repeat(64) };
  const weather = await evaluateRetainedForecastAdjustmentTemperatureWeather(input);
  const only = await evaluateRetainedForecastAdjustmentTemperatureOnly(input);
  assert.equal(only.contractVersion, "forecast-adjustment-retained-temperature-only-research/v1");
  assert.equal(only.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(only.snapshotIdentitySha256, weather.snapshotIdentitySha256);
  assert.equal(only.implementationIdentitySha256, weather.implementationIdentitySha256);
  assert.equal(only.productionActivationAllowed, false);
  assert.equal(only.promotable, false);
  assert.equal(only.runtimeBundleCreated, false);
  assert.equal(only.diagnostics.length, 6);

  // require exact source evidence before comparing the new stage
  for (const [index, diagnostic] of only.diagnostics.entries()) {
    const { temperatureOnly, contractVersion, ...unchanged } = diagnostic.analysis;
    assert.equal(contractVersion, "temperature-only-research/v1");
    assert.deepEqual(
      { ...diagnostic, analysis: { ...unchanged, contractVersion: "temperature-weather-research/v1" } },
      weather.diagnostics[index],
    );
    assert.deepEqual(temperatureOnly.overall.raw, unchanged.overall.raw);
    assert.deepEqual(temperatureOnly.overall.rawTemperatureWeather, unchanged.overall.rawTemperatureWeather);
    assert.equal(temperatureOnly.overall.rawTemperatureOnly.eventCount, unchanged.overall.raw.eventCount);
    assert.equal(temperatureOnly.overall.rawTemperatureOnly.uniqueValidHours, unchanged.overall.raw.uniqueValidHours);
    assert.equal(
      temperatureOnly.first48Hours.rawTemperatureOnly.eventCount + temperatureOnly.after48Hours.rawTemperatureOnly.eventCount,
      temperatureOnly.overall.raw.eventCount,
    );
  }
});

// preserve exact-row predictors and missing-weather equivalence without observations
test("temperature-only research ignores conflicting rows and missing weather stages", { timeout: 60_000 }, async (context) => {
  const options = { liveHumidityPercent: null, liveWindSpeedMps: null };
  const fixture = await createCompleteFixture(context, options);
  const conflicting = await createCompleteFixture(context, { ...options, liveFeatureConflict: true });
  const first = await evaluateRetainedForecastAdjustmentTemperatureOnly({
    ...fixture, experimentPlanSha256: "d".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureOnly({
    ...conflicting, experimentPlanSha256: "d".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  const live = first.diagnostics.at(-1).analysis.temperatureOnly;
  assert.equal(live.overall.raw.eventCount, 3 * 24 * 7);
  assert.deepEqual(live.overall.rawTemperatureOnly, live.overall.rawTemperatureWeather);
  assert.equal(live.coverage.differsFromRawTemperatureWeatherCount, 0);
});

// capture caller inputs and retain all out-of-envelope forecasts as raw
test("temperature-only research captures inputs and preserves envelope fallback", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = { ...fixture, experimentPlanSha256: "d".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureOnly(input);
  input.experimentPlanSha256 = "e".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "d".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  const live = result.diagnostics.at(-1).analysis.temperatureOnly;
  assert.deepEqual(live.overall.rawTemperatureOnly, live.overall.raw);
  assert.equal(live.coverage.baselineIneligibleCount, 3 * 24 * 7);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
});

// preserve all source windows while limiting adaptive replay to truthful live retrievals
test("adaptive weather research preserves source evidence and excludes archive calibration", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "f".repeat(64) };
  const weather = await evaluateRetainedForecastAdjustmentTemperatureWeather(input);
  const adaptive = await evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive(input);
  assert.equal(adaptive.contractVersion, "forecast-adjustment-retained-temperature-weather-adaptive-research/v1");
  assert.equal(adaptive.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(adaptive.snapshotIdentitySha256, weather.snapshotIdentitySha256);
  assert.equal(adaptive.implementationIdentitySha256, weather.implementationIdentitySha256);
  assert.equal(adaptive.productionActivationAllowed, false);
  assert.equal(adaptive.promotable, false);
  assert.equal(adaptive.runtimeBundleCreated, false);
  assert.equal(adaptive.diagnostics.length, 6);

  // require unchanged independent models, cutoffs and source scores
  for (const [index, diagnostic] of adaptive.diagnostics.entries()) {
    const { adaptiveCorrection, contractVersion, ...unchanged } = diagnostic.analysis;
    assert.equal(contractVersion, "temperature-weather-adaptive-research/v1");
    assert.deepEqual(
      { ...diagnostic, analysis: { ...unchanged, contractVersion: "temperature-weather-research/v1" } },
      weather.diagnostics[index],
    );
    assert.equal(adaptiveCorrection.policy.liveOnly, true);
    assert.equal(adaptiveCorrection.policy.noArchiveWarmStart, true);

    // archive anchors cannot authorize an observed-retrieval calibration replay
    if (diagnostic.cohort === "fixed_lead_anchor") {
      assert.equal(adaptiveCorrection.status, "not_applicable_archive_cohort");
      assert.equal(adaptiveCorrection.reason, "archive_has_no_observed_retrieval_time");

      // make every unavailable score explicit rather than returning apparent raw success
      for (const field of ["overall", "first48Hours", "after48Hours", "calibratedSubset", "coverage", "causalAudit", "diagnostics"]) {
        assert.equal(adaptiveCorrection[field], null);
      }
    } else {
      assert.equal(adaptiveCorrection.status, "evaluated");
      assert.deepEqual(adaptiveCorrection.overall.raw, unchanged.overall.raw);
      assert.deepEqual(adaptiveCorrection.overall.rawTemperatureWeather, unchanged.overall.rawTemperatureWeather);
      assert.equal(adaptiveCorrection.coverage.eventCount, unchanged.inputCoverage.eventCount);
      assert.equal(adaptiveCorrection.causalAudit.selectionCount, unchanged.inputCoverage.eventCount);
      assert.equal(adaptiveCorrection.causalAudit.violationCount, 0);
      assert.equal(
        adaptiveCorrection.coverage.calibratedEventCount + adaptiveCorrection.coverage.uncalibratedEventCount,
        adaptiveCorrection.coverage.eventCount,
      );
    }
  }
});

// retain selected forecast features without leaking post-cutoff archive outcomes
test("adaptive weather research preserves feature selection and temporal isolation", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const changed = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true, skipFixedIndex: 52,
  });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive({
    ...fixture, experimentPlanSha256: "f".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive({
    ...changed, experimentPlanSha256: "f".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
  const live = first.diagnostics.at(-1).analysis;
  assert.equal(live.coverage.rawTemperatureWeather.weatherFeatureMissingCount, 3 * 24 * 7);
  assert.equal(live.adaptiveCorrection.overall.causalAdaptive.eventCount, 3 * 24 * 7);
  assert.equal(live.adaptiveCorrection.causalAudit.violationCount, 0);
});

// freeze caller input before awaits and preserve the common raw fallback mask
test("adaptive weather research captures inputs and retains envelope fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = { ...fixture, experimentPlanSha256: "f".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive(input);
  input.experimentPlanSha256 = "e".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "f".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  const live = result.diagnostics.at(-1).analysis.adaptiveCorrection;
  assert.deepEqual(live.overall.causalAdaptive, live.overall.raw);
  assert.equal(live.overall.causalAdaptive.eventCount, 3 * 24 * 7);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
});

// combine the two frozen components without changing their source evidence
test("hybrid weather research preserves adaptive and horizon source comparisons", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "9".repeat(64) };
  const adaptive = await evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive(input);
  const horizon = await evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon(input);
  const hybrid = await evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid(input);
  assert.equal(hybrid.contractVersion, "forecast-adjustment-retained-temperature-weather-hybrid-research/v1");
  assert.equal(hybrid.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(hybrid.snapshotIdentitySha256, adaptive.snapshotIdentitySha256);
  assert.equal(hybrid.implementationIdentitySha256, adaptive.implementationIdentitySha256);
  assert.equal(hybrid.productionActivationAllowed, false);
  assert.equal(hybrid.promotable, false);
  assert.equal(hybrid.runtimeBundleCreated, false);
  assert.equal(hybrid.diagnostics.length, 6);

  // preserve every independent model, cutoff and original weather report field
  for (const [index, diagnostic] of hybrid.diagnostics.entries()) {
    const { hybridCorrection, contractVersion, ...unchanged } = diagnostic.analysis;
    const { adaptiveCorrection, contractVersion: adaptiveVersion, ...oldSource } = adaptive.diagnostics[index].analysis;
    assert.equal(contractVersion, "temperature-weather-hybrid-research/v1");
    assert.equal(adaptiveVersion, "temperature-weather-adaptive-research/v1");
    assert.deepEqual(unchanged, oldSource);
    assert.deepEqual({ ...diagnostic, analysis: adaptive.diagnostics[index].analysis }, adaptive.diagnostics[index]);
    assert.equal(hybridCorrection.policy.thresholdHours, 48);

    // keep all historical hybrid comparisons explicitly unavailable
    if (diagnostic.cohort === "fixed_lead_anchor") {
      assert.equal(hybridCorrection.status, "not_applicable_archive_cohort");
      assert.equal(hybridCorrection.reason, "archive_has_no_observed_retrieval_time");

      // reject invented raw-fallback success on archive controls
      for (const field of ["overall", "first48Hours", "after48Hours", "coverage", "causalAudit", "diagnostics"]) {
        assert.equal(hybridCorrection[field], null);
      }
    } else {
      assert.equal(hybridCorrection.status, "evaluated");
      assert.deepEqual(hybridCorrection.overall.raw, unchanged.overall.raw);
      assert.deepEqual(hybridCorrection.overall.rawTemperatureWeather, unchanged.overall.rawTemperatureWeather);
      assert.deepEqual(hybridCorrection.overall.causalAdaptive, adaptiveCorrection.overall.causalAdaptive);
      assert.deepEqual(hybridCorrection.overall.gatedAfter48Hours, horizon.diagnostics[index].analysis.horizonGate.overall.gatedAfter48Hours);
      assert.deepEqual(hybridCorrection.first48Hours.hybrid, adaptiveCorrection.first48Hours.causalAdaptive);
      assert.deepEqual(hybridCorrection.after48Hours.hybrid, hybridCorrection.after48Hours.rawTemperatureWeather);
      assert.equal(hybridCorrection.causalAudit.selectionCount, unchanged.inputCoverage.eventCount);
      assert.equal(hybridCorrection.causalAudit.violationCount, 0);
      assert.equal(hybridCorrection.coverage.first48EventCount + hybridCorrection.coverage.after48EventCount, unchanged.inputCoverage.eventCount);
    }
  }
});

// preserve exact forecast predictors and temporal fitting isolation in the hybrid path
test("hybrid weather research preserves missing features and post-cutoff isolation", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const changed = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true, skipFixedIndex: 52,
  });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid({
    ...fixture, experimentPlanSha256: "9".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid({
    ...changed, experimentPlanSha256: "9".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
  const live = first.diagnostics.at(-1).analysis;
  assert.equal(live.coverage.rawTemperatureWeather.weatherFeatureMissingCount, 3 * 24 * 7);
  assert.equal(live.hybridCorrection.overall.hybrid.eventCount, 3 * 24 * 7);
  assert.deepEqual(live.hybridCorrection.after48Hours.hybrid, live.hybridCorrection.after48Hours.rawTemperatureWeather);
});

// capture caller input before awaits and retain raw fallbacks in both hybrid branches
test("hybrid weather research captures inputs and preserves envelope fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = { ...fixture, experimentPlanSha256: "9".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid(input);
  input.experimentPlanSha256 = "8".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "9".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  const live = result.diagnostics.at(-1).analysis.hybridCorrection;
  assert.deepEqual(live.overall.hybrid, live.overall.raw);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
  assert.equal(live.coverage.differsFromGatedAfter48HoursCount, 0);
});

// preserve the static endpoint evidence across all six chronological windows
test("weather shrinkage preserves source models, cutoffs and endpoint scores", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "7".repeat(64) };
  const only = await evaluateRetainedForecastAdjustmentTemperatureOnly(input);
  const half = await evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage(input);
  assert.equal(half.contractVersion, "forecast-adjustment-retained-temperature-weather-shrinkage-research/v1");
  assert.equal(half.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(half.snapshotIdentitySha256, only.snapshotIdentitySha256);
  assert.equal(half.implementationIdentitySha256, only.implementationIdentitySha256);
  assert.equal(half.productionActivationAllowed, false);
  assert.equal(half.promotable, false);
  assert.equal(half.runtimeBundleCreated, false);
  assert.equal(half.diagnostics.length, 6);

  // preserve each original fit and report before inspecting the fixed ablation
  for (const [index, diagnostic] of half.diagnostics.entries()) {
    const { weatherShrinkage, contractVersion, ...unchanged } = diagnostic.analysis;
    const { temperatureOnly, contractVersion: oldContract, ...source } = only.diagnostics[index].analysis;
    assert.equal(contractVersion, "temperature-weather-shrinkage-research/v1");
    assert.equal(oldContract, "temperature-only-research/v1");
    assert.deepEqual(unchanged, source);
    assert.deepEqual({ ...diagnostic, analysis: only.diagnostics[index].analysis }, only.diagnostics[index]);
    assert.equal(weatherShrinkage.policy.weatherComponentWeight, 0.5);
    assert.equal(weatherShrinkage.policy.temperatureComponentWeight, 1);
    assert.equal(weatherShrinkage.policy.weightsAppliedBeforeCumulativeClipping, true);
    assert.equal(weatherShrinkage.policy.noAdaptiveCalibration, true);
    assert.equal(weatherShrinkage.policy.noHorizonGate, true);

    // retain every frozen endpoint on the complete common population
    for (const scope of ["overall", "first48Hours", "after48Hours"]) {
      const comparison = weatherShrinkage[scope];
      const { rawTemperatureHalfWeather, ...endpoints } = comparison;
      assert.deepEqual(endpoints, temperatureOnly[scope]);
      assert.equal(rawTemperatureHalfWeather.eventCount, comparison.raw.eventCount);
      assert.equal(rawTemperatureHalfWeather.uniqueValidHours, comparison.raw.uniqueValidHours);
      assert.equal(rawTemperatureHalfWeather.localDateCount, comparison.raw.localDateCount);
    }

    // retain every source diagnostic and recompute the new prediction per slice
    for (const [dimension, slices] of Object.entries(weatherShrinkage.diagnostics)) {
      assert.equal(slices.length, temperatureOnly.diagnostics[dimension].length);

      // compare identical metadata and unchanged endpoint predictions
      for (const [sliceIndex, slice] of slices.entries()) {
        const { rawTemperatureHalfWeather, ...endpoints } = slice.comparison;
        assert.deepEqual({ ...slice, comparison: endpoints }, temperatureOnly.diagnostics[dimension][sliceIndex]);
        assert.equal(rawTemperatureHalfWeather.eventCount, endpoints.raw.eventCount);
      }
    }
  }
});

// preserve exact-row predictors and exclude post-cutoff changes from each fit
test("weather shrinkage preserves missing-feature and temporal isolation", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const changed = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true, skipFixedIndex: 52,
  });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage({
    ...fixture, experimentPlanSha256: "7".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage({
    ...changed, experimentPlanSha256: "7".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
  const live = first.diagnostics.at(-1).analysis.weatherShrinkage;
  assert.equal(live.overall.raw.eventCount, 3 * 24 * 7);
  assert.equal(live.coverage.weatherFeatureMissingCount, 3 * 24 * 7);
  assert.deepEqual(live.overall.rawTemperatureHalfWeather, live.overall.rawTemperatureOnly);
  assert.deepEqual(live.overall.rawTemperatureHalfWeather, live.overall.rawTemperatureWeather);
  assert.equal(live.coverage.differsFromRawTemperatureOnlyCount, 0);
  assert.equal(live.coverage.differsFromRawTemperatureWeatherCount, 0);
});

// capture caller input before awaits and preserve out-of-envelope raw fallbacks
test("weather shrinkage captures inputs and preserves envelope fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = { ...fixture, experimentPlanSha256: "7".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage(input);
  input.experimentPlanSha256 = "8".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "7".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  const live = result.diagnostics.at(-1).analysis.weatherShrinkage;
  assert.deepEqual(live.overall.rawTemperatureHalfWeather, live.overall.raw);
  assert.equal(live.coverage.baselineIneligibleCount, 3 * 24 * 7);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
  assert.equal(live.coverage.differsFromRawTemperatureOnlyCount, 0);
  assert.equal(live.coverage.differsFromRawTemperatureWeatherCount, 0);
});

// preserve full-history controls and prove the short-history negative control
test("recency research preserves original fits and unchanged short histories", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context);
  const input = { ...fixture, experimentPlanSha256: "6".repeat(64) };
  const previous = await evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage(input);
  const recent = await evaluateRetainedForecastAdjustmentTemperatureWeatherRecency(input);
  assert.equal(recent.contractVersion, "forecast-adjustment-retained-temperature-weather-recency-research/v1");
  assert.equal(recent.experimentPlanSha256, input.experimentPlanSha256);
  assert.equal(recent.snapshotIdentitySha256, previous.snapshotIdentitySha256);
  assert.equal(recent.implementationIdentitySha256, previous.implementationIdentitySha256);
  assert.equal(recent.productionActivationAllowed, false);
  assert.equal(recent.promotable, false);
  assert.equal(recent.runtimeBundleCreated, false);
  assert.equal(recent.diagnostics.length, 6);

  // retain original models and expose new model identity separately
  for (const [index, diagnostic] of recent.diagnostics.entries()) {
    const { recencyTraining, contractVersion, ...unchanged } = diagnostic.analysis;
    const { weatherShrinkage, contractVersion: previousContract, ...source } = previous.diagnostics[index].analysis;
    assert.equal(contractVersion, "temperature-weather-recency-research/v1");
    assert.equal(previousContract, "temperature-weather-shrinkage-research/v1");
    assert.deepEqual(unchanged, source);
    assert.deepEqual({ ...diagnostic, analysis: previous.diagnostics[index].analysis }, previous.diagnostics[index]);
    assert.equal(recencyTraining.modelSha256, canonicalSha256(recencyTraining.models));
    assert.deepEqual(recencyTraining.models, source.models.rawStart);
    assert.equal(recencyTraining.trainingCoverage.excludedEventCount, 0);
    assert.deepEqual(recencyTraining.trainingCoverage.available, source.trainingCoverage);
    assert.deepEqual(recencyTraining.trainingCoverage.retained, source.trainingCoverage);
    assert.equal(recencyTraining.trainingWindow.lookbackLocalDates, 365);

    // distinguish an empty training set from a complete short training interval
    if (diagnostic.baseline.finalTrainingCutoff === null) {
      assert.equal(recencyTraining.trainingWindow.fromLocalDate, null);
      assert.equal(recencyTraining.trainingWindow.throughLocalDate, null);
      assert.equal(recencyTraining.trainingWindow.firstRetainedValidAt, null);
      assert.equal(recencyTraining.trainingWindow.lastRetainedValidAt, null);
    } else {
      const throughLocalDate = localCalendarFeaturesFor(diagnostic.baseline.finalTrainingCutoff).localDate;
      assert.equal(recencyTraining.trainingWindow.throughLocalDate, throughLocalDate);
      assert.equal(recencyTraining.trainingWindow.fromLocalDate, addLocalCalendarDays(throughLocalDate, -364));
      assert.equal(recencyTraining.trainingWindow.lastRetainedValidAt, diagnostic.baseline.finalTrainingCutoff);
    }

    // keep endpoint scores and prove exact equality when no training rows are removed
    for (const scope of ["overall", "first48Hours", "after48Hours"]) {
      const comparison = recencyTraining[scope];
      assert.deepEqual(comparison.raw, weatherShrinkage[scope].raw);
      assert.deepEqual(comparison.rawTemperatureWeather, weatherShrinkage[scope].rawTemperatureWeather);
      assert.deepEqual(comparison.recentTemperatureWeather, comparison.rawTemperatureWeather);
    }

    // preserve metadata and all score denominators throughout the diagnostics
    for (const [dimension, slices] of Object.entries(recencyTraining.diagnostics)) {
      assert.equal(slices.length, weatherShrinkage.diagnostics[dimension].length);

      // inspect every fixed diagnostic cell including empty cells
      for (const [sliceIndex, slice] of slices.entries()) {
        const oldSlice = weatherShrinkage.diagnostics[dimension][sliceIndex];
        assert.deepEqual({ ...slice, comparison: oldSlice.comparison }, oldSlice);
        assert.deepEqual(slice.comparison.raw, oldSlice.comparison.raw);
        assert.deepEqual(slice.comparison.rawTemperatureWeather, oldSlice.comparison.rawTemperatureWeather);
        assert.deepEqual(slice.comparison.recentTemperatureWeather, slice.comparison.rawTemperatureWeather);
      }
    }
    assert.equal(recencyTraining.coverage.temperatureSupportLostCount, 0);
    assert.equal(recencyTraining.coverage.weatherSupportLostCount, 0);
    assert.equal(recencyTraining.coverage.differsFromRawTemperatureWeatherCount, 0);
  }
});

// keep exact-row predictors and later observations outside both fitted models
test("recency research preserves feature selection and post-cutoff isolation", { timeout: 60_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveHumidityPercent: null, liveWindSpeedMps: null });
  const changed = await createCompleteFixture(context, {
    liveHumidityPercent: null, liveWindSpeedMps: null, liveFeatureConflict: true, skipFixedIndex: 52,
  });
  const first = await evaluateRetainedForecastAdjustmentTemperatureWeatherRecency({
    ...fixture, experimentPlanSha256: "6".repeat(64),
  });
  const second = await evaluateRetainedForecastAdjustmentTemperatureWeatherRecency({
    ...changed, experimentPlanSha256: "6".repeat(64),
  });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.notEqual(first.researchArtifactSha256, second.researchArtifactSha256);
  const live = first.diagnostics.at(-1).analysis.recencyTraining;
  assert.equal(live.overall.recentTemperatureWeather.eventCount, 3 * 24 * 7);
  assert.equal(live.coverage.weatherFeatureMissingCount, 3 * 24 * 7);
  assert.equal(live.coverage.weatherSupportedCount, 0);
  assert.deepEqual(live.overall.recentTemperatureWeather, live.overall.rawTemperatureWeather);
});

// capture asynchronous caller inputs and preserve complete raw fallback cohorts
test("recency research captures inputs and preserves envelope fallbacks", { timeout: 30_000 }, async (context) => {
  const fixture = await createCompleteFixture(context, { liveTemperatureC: 30 });
  const input = { ...fixture, experimentPlanSha256: "6".repeat(64) };
  const pending = evaluateRetainedForecastAdjustmentTemperatureWeatherRecency(input);
  input.experimentPlanSha256 = "8".repeat(64);
  input.snapshotPaths.length = 0;
  input.expectedRange.fromLocalDate = "2099-01-01";
  const result = await pending;
  assert.equal(result.experimentPlanSha256, "6".repeat(64));
  assert.equal(result.expectedRange.fromLocalDate, "2026-01-01");
  assert.equal(result.snapshots.length, 2);
  const live = result.diagnostics.at(-1).analysis.recencyTraining;
  assert.deepEqual(live.overall.recentTemperatureWeather, live.overall.raw);
  assert.equal(live.coverage.baselineIneligibleCount, 3 * 24 * 7);
  assert.equal(live.coverage.nonzeroCorrectionCount, 0);
  assert.equal(live.coverage.differsFromRawTemperatureWeatherCount, 0);
});
