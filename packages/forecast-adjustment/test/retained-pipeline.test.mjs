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
  evaluateRetainedForecastAdjustmentSnapshot,
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

// create one exact station export row
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
    temperature_c: 12,
    upstream_model: null,
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: null,
    wind_speed_mps: null,
  };
}

// create one exact legacy forecast export row
function forecastRow(validAt) {
  return {
    adapter_contracts: ["forecast-daily/v4"],
    collision_count: 0,
    content_hashes: [sha256(`forecast:${validAt}`)],
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
    temperature_c: 10,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: null,
    wind_speed_mps: null,
  };
}

// package one complete synthetic retained snapshot
async function createSufficientSnapshot(evidenceRoot) {
  const d0 = "2025-09-01";
  const d401 = addLocalCalendarDays(d0, 401);
  const memberBytes = new Map();
  const members = [];

  // package final-training and holdout dates only
  for (const index of [...Array(365).keys(), ...Array.from({ length: 30 }, (_item, offset) => 372 + offset)]) {
    const localDate = addLocalCalendarDays(d0, index);
    const start = localMidnight(localDate);
    const end = localMidnight(addLocalCalendarDays(localDate, 1));
    const instants = [];

    // enumerate exact local-day UTC hours across DST
    for (let instant = start; instant < end; instant += 3_600_000) {
      instants.push(new Date(instant).toISOString());
    }

    for (const stationKey of STATION_KEYS) {
      const rows = instants.map((instant) => stationRow(stationKey, instant));
      addMember(members, memberBytes, {
        localDate,
        path: `members/${localDate}/station-hour/${stationKey}.jsonl.gz`,
        recordKind: "station-hour",
        rows,
        stationKey,
      });
    }
    addMember(members, memberBytes, {
      localDate,
      path: `members/${localDate}/legacy-v4-retrieval/open-meteo.jsonl.gz`,
      recordKind: "legacy-v4-retrieval",
      rows: instants.map(forecastRow),
      stationKey: null,
    });
  }

  const embargoDate = addLocalCalendarDays(d0, 365);
  const embargoInstant = new Date(localMidnight(embargoDate)).toISOString();
  addMember(members, memberBytes, {
    localDate: embargoDate,
    path: `members/${embargoDate}/legacy-v4-retrieval/open-meteo.jsonl.gz`,
    recordKind: "legacy-v4-retrieval",
    rows: [forecastRow(embargoInstant)],
    stationKey: null,
  });

  members.sort((left, right) => left.path.localeCompare(right.path));
  const totalRowCount = members.reduce((sum, member) => sum + member.rowCount, 0);
  const manifest = {
    aggregationContractSha256:
      "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
    contractVersion: "forecast-training-export-package/v1",
    coordinateManifestSha256:
      "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
    createdAtUtc: "2026-10-08T00:00:00.000Z",
    databaseManifest: {
      migration_checksums: ["a".repeat(64)],
      migration_names: ["0010_forecast_training_export.sql"],
      query_contract_version: "forecast-training-export-query/v2",
      schema_migration: "0010_forecast_training_export.sql",
    },
    fromLocalDate: d0,
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
        relative_humidity_percent: STATION_KEYS.includes(station.key) ? 395 : 0,
        temperature_c: STATION_KEYS.includes(station.key) ? 395 : 0,
        wind_direction_degrees: STATION_KEYS.includes(station.key) ? 395 : 0,
        wind_gust_mps: STATION_KEYS.includes(station.key) ? 395 : 0,
        wind_speed_mps: STATION_KEYS.includes(station.key) ? 395 : 0,
      },
      stationKey: station.key,
    })),
    stationManifestSha256:
      "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
    toLocalDate: d401,
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

  // publish synthetic compressed members
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

// add one compressed content-addressed member
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

test("retained snapshot fits, burns, scores, and promotes without holdout leakage", { timeout: 60_000 }, async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "weather-retained-e2e-"));
  const redundancyRoot = await mkdtemp("/dev/shm/weather-retained-redundancy-");
  const snapshotPath = await createSufficientSnapshot(evidenceRoot);
  const result = await evaluateRetainedForecastAdjustmentSnapshot({
    evidenceRoot,
    redundancyRoot,
    snapshotPath,
  });
  assert.equal(result.state, "promoted");
  const markerIndex = result.accessTrace.findIndex((entry) =>
    entry.startsWith("holdout_marker_durable:"),
  );
  const openIndex = result.accessTrace.findIndex((entry) =>
    entry.startsWith("fs_opened:holdout:"),
  );
  assert.ok(markerIndex >= 0 && markerIndex < openIndex);
  assert.equal(
    result.accessTrace.slice(0, markerIndex).some((entry) =>
      entry.startsWith("fs_opened:holdout:") ||
      entry.startsWith("fs_read:holdout:"),
    ),
    false,
  );
  assert.equal(
    result.accessTrace.some((entry) => entry.includes("2026-09-01")),
    false,
  );
  await assert.rejects(
    evaluateRetainedForecastAdjustmentSnapshot(
      { evidenceRoot, snapshotPath },
      {
        evaluateHoldout: async () => assert.fail("fake scorer reached holdout"),
        fitDevelopment: async ({ snapshotManifestSha256 }) => ({
          contractVersion: "forecast-adjustment-insufficient-data/v1",
          failedGates: ["fabricated"],
          reportSha256: "f".repeat(64),
          snapshotManifestSha256,
          state: "insufficient_data",
        }),
      },
    ),
    /disagrees with authoritative fit/u,
  );
});
