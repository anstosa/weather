import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "@weather/domain";

import {
  addLocalCalendarDays,
  canonicalJsonBytes,
  evaluateRetainedForecastAdjustmentWindCanarySnapshot,
} from "../dist/index.js";

const STATION_KEYS = [
  "ambient-merlin",
  "ballydidean-ecowitt",
  "netatmo-nearby",
  "tempest-168853",
  "tempest-64255",
];

// hash exact fixture bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// derive one Los Angeles local midnight
function localMidnight(localDate) {
  const target = Date.parse(`${localDate}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "America/Los_Angeles",
    year: "numeric",
  });
  let candidate = target;

  // converge to local wall midnight
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Map(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    );
    candidate += target - represented;
  }

  return candidate;
}

// create one exact station wind row
function stationRow(stationKey, validAt) {
  const station = FORECAST_OBSERVATION_STATIONS.find(
    (candidate) => candidate.key === stationKey,
  );
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    (candidate) =>
      candidate.physicalStationKey === stationKey &&
      (candidate.acceptedStartInclusive === null ||
        validAt >= candidate.acceptedStartInclusive) &&
      (candidate.acceptedEndExclusive === null ||
        validAt < candidate.acceptedEndExclusive),
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
    relative_humidity_percent: null,
    site_key: "ballydidean",
    source_config_fingerprints: [lineage.checkedFingerprint],
    source_keys: [lineage.sourceKey],
    target_lead_hours: null,
    temperature_c: null,
    upstream_model: null,
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: 11,
    wind_speed_mps: 7,
  };
}

// create one exact fixed-lead training row
function fixedLeadRow(validAt) {
  return {
    adapter_contracts: ["previous-runs-hourly/v1"],
    collision_count: 0,
    content_hashes: [sha256(`fixed:${validAt}`)],
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
    relative_humidity_percent: null,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
    ],
    source_keys: ["open-meteo-previous-runs-v1"],
    target_lead_hours: 24,
    temperature_c: null,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: 8,
    wind_speed_mps: 5,
  };
}

// create one exact live-v4 bridge row
function bridgeRow(validAt) {
  return {
    adapter_contracts: ["forecast-daily/v4"],
    collision_count: 0,
    content_hashes: [sha256(`bridge:${validAt}`)],
    contract_epoch:
      "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
    dataset: "forecast",
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: null,
    provider_family: null,
    received_at: validAt,
    record_kind: "legacy_v4_retrieval_snapshot",
    reference_at: new Date(Date.parse(validAt) - 23.5 * 3_600_000).toISOString(),
    reference_kind: "retrieval_snapshot",
    relative_humidity_percent: null,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    ],
    source_keys: ["open-meteo-forecast-v4"],
    target_lead_hours: 24,
    temperature_c: null,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: 8,
    wind_speed_mps: 5,
  };
}

// append one compressed content-addressed member
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

// package one verified fixed-lead and live-v4 snapshot
async function createCanarySnapshot(evidenceRoot) {
  const fromLocalDate = "2026-08-17";
  const trainingDays = 10;
  const bridgeDays = 2;
  const memberBytes = new Map();
  const members = [];

  // package disjoint training and bridge dates
  for (let index = 0; index < trainingDays + bridgeDays; index += 1) {
    const localDate = addLocalCalendarDays(fromLocalDate, index);
    const start = localMidnight(localDate);
    const end = localMidnight(addLocalCalendarDays(localDate, 1));
    const instants = [];

    // enumerate the exact local day hours
    for (let instant = start; instant < end; instant += 3_600_000) {
      instants.push(new Date(instant).toISOString());
    }

    // retain every available local station
    for (const stationKey of STATION_KEYS) {
      addMember(members, memberBytes, {
        localDate,
        path: `members/${localDate}/station-hour/${stationKey}.jsonl.gz`,
        recordKind: "station-hour",
        rows: instants.map((instant) => stationRow(stationKey, instant)),
        stationKey,
      });
    }

    const training = index < trainingDays;
    addMember(members, memberBytes, {
      localDate,
      path: training
        ? `members/${localDate}/fixed-lead-anchor/open-meteo.jsonl.gz`
        : `members/${localDate}/legacy-v4-retrieval/open-meteo.jsonl.gz`,
      recordKind: training ? "fixed-lead-anchor" : "legacy-v4-retrieval",
      rows: instants.map(training ? fixedLeadRow : bridgeRow),
      stationKey: null,
    });
  }

  members.sort((left, right) => left.path.localeCompare(right.path));
  const totalRowCount = members.reduce((sum, member) => sum + member.rowCount, 0);
  const toLocalDate = addLocalCalendarDays(
    fromLocalDate,
    trainingDays + bridgeDays - 1,
  );
  const manifest = {
    aggregationContractSha256:
      "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
    contractVersion: "forecast-training-export-package/v1",
    coordinateManifestSha256:
      "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
    createdAtUtc: "2026-09-03T00:00:00.000Z",
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
    migrationHistorySha256: "b".repeat(64),
    observedSourceIdentities: [],
    queryContractSha256:
      "3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76",
    queryContractVersion: "forecast-training-export-query/v2",
    rowSchemaSha256:
      "2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc",
    siteKey: "ballydidean",
    siteTimezone: "America/Los_Angeles",
    sourceIdentities: [],
    sourceLineageSha256:
      "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
    spatialWeightsSha256:
      "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
    stationMetricCoverage: FORECAST_OBSERVATION_STATIONS.map((station) => ({
      eligibleMetricNonNullLocalDates: {
        relative_humidity_percent: 0,
        temperature_c: 0,
        wind_direction_degrees: 0,
        wind_gust_mps: STATION_KEYS.includes(station.key)
          ? trainingDays + bridgeDays
          : 0,
        wind_speed_mps: STATION_KEYS.includes(station.key)
          ? trainingDays + bridgeDays
          : 0,
      },
      stationKey: station.key,
    })),
    stationManifestSha256:
      "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
    toLocalDate,
    totalRowCount,
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
  const manifestHash = sha256(manifestBytes);
  const snapshot = join(evidenceRoot, "snapshots", manifestHash);

  // publish every exact compressed member
  for (const [path, bytes] of memberBytes) {
    await mkdir(join(snapshot, dirname(path)), { recursive: true });
    await writeFile(join(snapshot, path), bytes);
  }
  await writeFile(join(snapshot, "manifest.json"), manifestBytes);
  await writeFile(
    join(snapshot, "manifest.sha256"),
    `${manifestHash}  manifest.json\n`,
  );
  return snapshot;
}

test("retained canary fits fixed leads and scores live-v4 separately", { timeout: 30_000 }, async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "weather-wind-canary-retained-"));
  const snapshotPath = await createCanarySnapshot(evidenceRoot);
  const result = await evaluateRetainedForecastAdjustmentWindCanarySnapshot({
    authorization: {
      activatedAt: "2026-09-03T07:00:00.000Z",
      authorizationReason: "operator-approved wind-only production canary",
      authorizedAt: "2026-09-03T06:55:00.000Z",
      authorizedBy: "ansel",
      expiresAt: "2026-09-10T07:00:00.000Z",
    },
    enabledMetrics: ["windGustMps", "windSpeedMps"],
    evidenceRoot,
    snapshotPath,
  });
  assert.equal(
    result.contractVersion,
    "forecast-adjustment-retained-wind-canary-result/v1",
  );
  assert.equal(result.candidate.trainingForecastIdentity.cohort, "fixed_lead_anchor");
  assert.equal(
    result.candidate.servedForecastIdentity.cohort,
    "legacy_v4_retrieval_snapshot",
  );
  assert.deepEqual(result.candidate.enabledMetricBands, enabledMetricBandsForTest());
  assert.equal(
    result.candidate.coefficients.some(
      (coefficient) => coefficient.metric === "windDirectionDegrees",
    ),
    false,
  );
  assert.equal(
    result.transferReport.bridgeEvaluations.every(
      (evaluation) =>
        evaluation.network.eventCount >= 30 && evaluation.network.skill > 0,
    ),
    true,
  );
  assert.deepEqual(
    result.transferReport.bridgeEvaluations.map(
      (evaluation) => evaluation.network.eventCount,
    ),
    [48, 48],
  );
  assert.equal(result.authorization.authorizedBy, "ansel");
  assert.equal(result.bundle.artifactKind, "wind_transfer_canary_runtime_bundle");
  assert.equal(
    result.accessTrace.some((entry) => entry === "wind_canary_bundle_ready"),
    true,
  );
});

// freeze the deterministic expected pair order
function enabledMetricBandsForTest() {
  return [
    { leadBand: "001-024", metric: "windGustMps" },
    { leadBand: "001-024", metric: "windSpeedMps" },
  ];
}
