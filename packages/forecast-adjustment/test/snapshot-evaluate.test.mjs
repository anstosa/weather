import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  canonicalJsonBytes,
  evaluateForecastAdjustmentSnapshot,
} from "../dist/index.js";

const provenance = {
  aggregationContractSha256:
    "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
  coordinateManifestSha256:
    "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
  metricEligibilitySha256:
    "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
  sourceLineageSha256:
    "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
  spatialWeightsSha256:
    "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
  stationManifestSha256:
    "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
};
const stationKeys = [
  "ambient-maxweather",
  "ambient-merlin",
  "ballydidean-ecowitt",
  "netatmo-nearby",
  "tempest-126537",
  "tempest-168853",
  "tempest-201058",
  "tempest-203055",
  "tempest-225947",
  "tempest-38270",
  "tempest-64255",
];

// hash exact fixture bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// build exact sanitized station coverage
function stationMetricCoverage(ecowittNonNullDates = 0) {
  return stationKeys.map((stationKey) => ({
    eligibleMetricNonNullLocalDates: {
      relative_humidity_percent:
        stationKey === "ballydidean-ecowitt" ? ecowittNonNullDates : 0,
      temperature_c:
        stationKey === "ballydidean-ecowitt" ? ecowittNonNullDates : 0,
      wind_direction_degrees:
        stationKey === "ballydidean-ecowitt" ? ecowittNonNullDates : 0,
      wind_gust_mps:
        stationKey === "ballydidean-ecowitt" ? ecowittNonNullDates : 0,
      wind_speed_mps:
        stationKey === "ballydidean-ecowitt" ? ecowittNonNullDates : 0,
    },
    stationKey,
  }));
}

// add UTC calendar days
function addDays(localDate, days) {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// build one manifest-valid short snapshot
async function createShortSnapshot(root, mutateManifest = () => {}) {
  const memberBytes = Buffer.from("compressed-fixture-bytes");
  const memberPath =
    "members/2026-08-01/station-hour/ballydidean-ecowitt.jsonl.gz";
  const manifest = {
    ...provenance,
    contractVersion: "forecast-training-export-package/v1",
    createdAtUtc: "2026-08-03T00:00:00.000Z",
    databaseManifest: {
      migration_checksums: ["a".repeat(64)],
      migration_names: ["0010_forecast_training_export.sql"],
      query_contract_version: "forecast-training-export-query/v2",
      schema_migration: "0010_forecast_training_export.sql",
    },
    fromLocalDate: "2026-08-01",
    limits: {
      conservativeExportRowFormula: "450 * ((24 * 264) + (11 * 24) + 168)",
      conservativeExportRows: 3_045_600,
      exportRowHeadroom: 954_400,
      maxDays: 450,
      maxRows: 4_000_000,
      rowCountMeaning: "export_rows_not_training_events",
    },
    members: [
      {
        localDate: "2026-08-01",
        maxValidAt: "2026-08-01T00:00:00.000Z",
        minValidAt: "2026-08-01T00:00:00.000Z",
        path: memberPath,
        plaintextBytes: 100,
        recordKind: "station-hour",
        rowCount: 1,
        sha256: sha256(memberBytes),
        sizeBytes: memberBytes.byteLength,
        stationKey: "ballydidean-ecowitt",
      },
    ],
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
    toLocalDate: "2026-08-02",
    totalRowCount: 1,
    transaction: {
      idleInTransactionSessionTimeout: "30s",
      isolationLevel: "repeatable read",
      lockTimeout: "5s",
      readOnly: "on",
      statementTimeout: "15min",
    },
    stationMetricCoverage: stationMetricCoverage(),
    usageBoundary: {
      databaseImportAllowed: false,
      productionDerived: true,
      snapshotOnly: true,
    },
  };
  mutateManifest(manifest);
  const manifestBytes = canonicalJsonBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const snapshot = join(root, ".weather-data", manifestSha256);
  await mkdir(join(snapshot, dirname(memberPath)), { recursive: true });
  await writeFile(join(snapshot, memberPath), memberBytes);
  await writeFile(join(snapshot, "manifest.json"), manifestBytes);
  await writeFile(
    join(snapshot, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
  );
  return { memberPath, snapshot };
}

// build a long empty-grid snapshot
async function createLongSparseSnapshot(root) {
  const memberBytes = Buffer.from("compressed-fixture-bytes");
  const fromLocalDate = "2025-06-28";
  const members = [];

  // create one target-site member on every epoch date
  for (let index = 0; index < 402; index += 1) {
    const localDate = addDays(fromLocalDate, index);
    const memberPath =
      `members/${localDate}/station-hour/ballydidean-ecowitt.jsonl.gz`;
    members.push({
      localDate,
      maxValidAt: `${localDate}T23:00:00.000Z`,
      minValidAt: `${localDate}T00:00:00.000Z`,
      path: memberPath,
      plaintextBytes: 100,
      recordKind: "station-hour",
      rowCount: 24,
      sha256: sha256(memberBytes),
      sizeBytes: memberBytes.byteLength,
      stationKey: "ballydidean-ecowitt",
    });
  }

  const manifest = {
    ...provenance,
    contractVersion: "forecast-training-export-package/v1",
    createdAtUtc: "2026-08-03T00:00:00.000Z",
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
    stationMetricCoverage: stationMetricCoverage(4),
    toLocalDate: addDays(fromLocalDate, 401),
    totalRowCount: 402 * 24,
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
  const snapshot = join(root, ".weather-data", manifestSha256);

  // publish every declared member
  for (const member of members) {
    await mkdir(join(snapshot, dirname(member.path)), { recursive: true });
    await writeFile(join(snapshot, member.path), memberBytes);
  }

  await writeFile(join(snapshot, "manifest.json"), manifestBytes);
  await writeFile(
    join(snapshot, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
  );
  return snapshot;
}

test("snapshot evaluation verifies all member hashes then emits deterministic insufficiency", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-snapshot-"));
  const { memberPath, snapshot } = await createShortSnapshot(root);
  const outputPath = join(root, ".weather-models", "run-1");
  const result = await evaluateForecastAdjustmentSnapshot({
    outputPath,
    snapshotPath: snapshot,
  });
  assert.equal(result.state, "insufficient_data");
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.failedGates, [
    "ecowitt_complete_local_dates",
    "ecowitt_metric_matches",
    "epoch_402_local_dates",
  ]);
  assert.ok(
    result.accessTrace.indexOf("member_metadata_verified") <
      result.accessTrace.indexOf(`member_hash_verified:${memberPath}`),
  );
  assert.equal(result.accessTrace.at(-1), "insufficient_data_emitted");
});

test("snapshot evaluation fails before reporting when a member is substituted", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-snapshot-tamper-"));
  const { memberPath, snapshot } = await createShortSnapshot(root);
  await writeFile(join(snapshot, memberPath), "tampered");
  await assert.rejects(
    evaluateForecastAdjustmentSnapshot({
      outputPath: join(root, ".weather-models", "run-1"),
      snapshotPath: snapshot,
    }),
    /checksum or size mismatch/u,
  );
});

test("snapshot evaluation proves sparse Ecowitt metric dates despite a long member grid", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-snapshot-sparse-"));
  const snapshot = await createLongSparseSnapshot(root);
  const result = await evaluateForecastAdjustmentSnapshot({
    outputPath: join(root, ".weather-models", "run-1"),
    snapshotPath: snapshot,
  });
  assert.equal(result.state, "insufficient_data");
  assert.deepEqual(result.failedGates, ["ecowitt_complete_local_dates"]);
});

test("snapshot evaluation rejects station metric coverage schema drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-snapshot-coverage-schema-"));
  const { snapshot } = await createShortSnapshot(root, (manifest) => {
    manifest.stationMetricCoverage[0].eligibleMetricNonNullLocalDates.extra = 0;
  });
  await assert.rejects(
    evaluateForecastAdjustmentSnapshot({
      outputPath: join(root, ".weather-models", "run-1"),
      snapshotPath: snapshot,
    }),
    /station metric coverage counts has unexpected fields/u,
  );
});
