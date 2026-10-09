import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildAdjustmentEvaluationPackage,
  frameAdjustmentConfirmationAuthorizationV2,
  frameAdjustmentConfirmationAvailabilityV2,
  loadVerifiedAdjustmentEvaluationPackage,
  streamAdjustmentEvaluationPackageArchive,
  streamAdjustmentEvaluationV2EnvelopeArchive,
  verifyAdjustmentConfirmationAvailabilityV2,
  verifyAdjustmentEvaluationPackage,
  verifyAdjustmentEvaluationV2EnvelopePackage,
  verifyAdjustmentEvaluationV2Stream,
  validateAdjustmentV14DatabaseManifest,
  validateAdjustmentV14RollingDatabaseManifest,
  projectAdjustmentMaintenanceDatabaseLedgerV3,
} from "../scripts/adjustment-evaluation-package.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const executeFile = promisify(execFile);
const hashA = "a".repeat(64);
const queryContractSha256 =
  "c860039c72818a9b813ed9f9d93f5d8e115f4144e99d698734e9159ca3457bd4";
const rowSchemaSha256 =
  "c21782034130d003e4af48fada4c8f6545f6f1c4dff550f92d0523c7d96d20e2";
const migrationRoot = join(repoRoot, "packages/database/migrations");
const completeMigrationNames = readdirSync(migrationRoot)
  // retain only the ordered SQL migration ledger
  .filter((name) => name.endsWith(".sql"))
  .sort();
const completeMigrationChecksums = completeMigrationNames.map(
  // bind every checked-in migration byte-for-byte
  (name) => sha256(readFileSync(join(migrationRoot, name))),
);
const legacyMigrationNames = completeMigrationNames.slice(0, 17);
const legacyMigrationChecksums = completeMigrationChecksums.slice(0, 17);

// hash exact fixture bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// create one exact ordered migration ledger fixture
function migrationLedger(names, checksums) {
  return {
    checksums,
    historySha256: sha256(Buffer.from(
      names.map(
        // serialize the supplied ordered fixture exactly like PostgreSQL
        (name, index) => `${name}:${checksums[index]}`,
      ).join("\n"),
    )),
    names,
  };
}

const completeMigrationLedger = migrationLedger(
  completeMigrationNames,
  completeMigrationChecksums,
);
const legacyMigrationLedger = migrationLedger(
  legacyMigrationNames,
  legacyMigrationChecksums,
);

// create one fixed transaction manifest
function transactionManifest(
  ledger = completeMigrationLedger,
  fromLocalDate = "2026-10-01",
  toLocalDate = "2026-10-01",
) {
  return {
    payload: {
      contract_version: "adjustment-evaluation-export-manifest/v1",
      migration_checksums: ledger.checksums,
      migration_history_sha256: ledger.historySha256,
      migration_names: ledger.names,
      query_contract_sha256: queryContractSha256,
      query_contract_version: "adjustment-evaluation-export-query/v1",
      row_schema_sha256: rowSchemaSha256,
      schema_migration: "0017_adjustment_evaluation_export.sql",
      site_key: "ballydidean",
      site_timezone: "America/Los_Angeles",
    },
    record_type: "manifest",
    transaction: {
      created_at_utc: "2026-10-07T12:00:00.000000Z",
      from_local_date: fromLocalDate,
      idle_in_transaction_session_timeout: "30s",
      isolation_level: "repeatable read",
      lock_timeout: "5s",
      read_only: "on",
      statement_timeout: "5min",
      to_local_date: toLocalDate,
    },
  };
}

// keep frozen frontier and rolling deployment ledger authority disjoint
test("v14 ledger gates accept only their exact reviewed complete schema", () => {
  const rolling = transactionManifest().payload;
  const frontier = transactionManifest(migrationLedger(
    completeMigrationNames.slice(0, 20), completeMigrationChecksums.slice(0, 20),
  )).payload;
  assert.equal(validateAdjustmentV14RollingDatabaseManifest(rolling), rolling);
  assert.equal(validateAdjustmentV14DatabaseManifest(frontier), frontier);
  assert.throws(() => validateAdjustmentV14DatabaseManifest(rolling));
  assert.throws(() => validateAdjustmentV14RollingDatabaseManifest(frontier));
  const changed = structuredClone(rolling);
  changed.migration_checksums[20] = hashA;
  assert.throws(() => validateAdjustmentV14RollingDatabaseManifest(changed));
});

// bind the typed ledger to its real read-only transaction without leaking function values
test("database ledger projection closes the transaction envelope and CLI response", async () => {
  const envelope = maintenanceResponse(null);
  const projected = projectAdjustmentMaintenanceDatabaseLedgerV3(envelope);
  assert.deepEqual(projected, {
    contractVersion: "adjustment-database-ledger/v3",
    databaseManifest: envelope.databaseManifest,
    snapshotAt: "2026-10-08T12:00:00.000Z",
  });
  assert.throws(() => projectAdjustmentMaintenanceDatabaseLedgerV3({ ...envelope, payload: {} }));
  assert.throws(() => projectAdjustmentMaintenanceDatabaseLedgerV3({ ...envelope, extra: true }));
  assert.throws(() => projectAdjustmentMaintenanceDatabaseLedgerV3({
    ...envelope, transaction: { ...envelope.transaction, read_only: "off" },
  }));
  const child = spawn(process.execPath, [
    join(repoRoot, "deploy/scripts/adjustment-evaluation-package.mjs"),
    "project-maintenance-ledger-v3",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(JSON.stringify(envelope));
  const status = await new Promise((resolveClose) => child.once("close", resolveClose));
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), projected);
});

// create one function-only maintenance response
function maintenanceResponse(payload, ledger = completeMigrationLedger) {
  return {
    databaseManifest: transactionManifest(ledger).payload,
    payload,
    transaction: {
      created_at_utc: "2026-10-08T12:00:00.000000Z",
      idle_in_transaction_session_timeout: "30s",
      isolation_level: "repeatable read",
      lock_timeout: "5s",
      read_only: "on",
      statement_timeout: "5min",
    },
  };
}

// create one value-free availability fixture
function availabilityPayload(registrationSha256 = "1".repeat(64)) {
  return {
    contractVersion: "adjustment-confirmation-availability/v2",
    expectedKeySetSha256: "2".repeat(64),
    family: "temperature",
    finalizedMetadataRootSha256: "3".repeat(64),
    finalizedPredictionCount: 48,
    finalizedThroughAt: "2026-10-07T18:40:00.000Z",
    hotPredictionCount: 1,
    hotPredictions: [{
      dueKey: "capture/2026-10-08T00:35:00.000Z",
      maxValidAt: "2026-10-08T12:00:00.000Z",
      minValidAt: "2026-10-08T01:00:00.000Z",
      predictionSha256: "4".repeat(64),
      rowCount: 12,
    }],
    hotSetRootSha256: "5".repeat(64),
    intervalEndAt: "2027-10-08T07:00:00.000Z",
    intervalStartAt: "2026-10-08T07:00:00.000Z",
    metadataGeneration: 2,
    missingExpectedDueKeys: null,
    missingExpectedDueKeysStatus: "requires_anchored_cold_reconstruction",
    registrationSha256,
    targetCutoffAt: "2026-10-08T06:59:59.000Z",
  };
}

// create one persisted-burn authorization fixture
function authorizationPayload(
  registrationSha256 = "1".repeat(64),
  accessSha256 = "6".repeat(64),
) {
  return {
    accessSha256,
    chunkCount: 27,
    chunkIndex: 0,
    contractVersion: "adjustment-confirmation-export-authorization/v2",
    eligiblePredictionSetSha256: "7".repeat(64),
    expectedKeySetSha256: "2".repeat(64),
    family: "temperature",
    fromLocalDate: "2026-10-01",
    metadataRootSha256: "8".repeat(64),
    registrationSha256,
    revisionCatalogWatermarkSha256: "9".repeat(64),
    targetComparatorSnapshotRootSha256: "a".repeat(64),
    targetCutoffAt: "2026-10-08T06:59:59.000Z",
    toLocalDateExclusive: "2026-10-15",
  };
}

// create one closed temperature row
function temperatureRow(overrides = {}) {
  return {
    compressed_body_base64: null,
    content_hash: hashA,
    first_received_at: "2026-10-01T06:03:00.000Z",
    last_received_at: "2026-10-01T06:03:00.000Z",
    local_date: "2026-10-01",
    payload: {
      contentHash: hashA,
      modelLeadHours: 7,
      rawRelativeHumidityPercent: 80,
      rawTemperatureC: 12.5,
      rawWindSpeedMps: 3.1,
      runId: 1,
      validAt: "2026-10-01T07:00:00.000Z",
    },
    record_kind: "temperature_hour",
    record_revision_identity: "ecmwf-temperature-canary-hour:1:7",
    reference_at: "2026-10-01T00:00:00.000Z",
    revision_count: 0,
    site_key: "ballydidean",
    source_identity: "ecmwf-temperature-canary:1",
    valid_at: "2026-10-01T07:00:00.000Z",
    ...overrides,
  };
}

// create one retained compressed-body row
function rainReceiptRow(label = "fixture") {
  const bodyPlaintext = Buffer.from(`{"hourly":{"rain":[0,1]},"label":"${label}"}`);
  const body = gzipSync(bodyPlaintext, { level: 9, mtime: 0 });
  const bodySha256 = sha256(bodyPlaintext);
  return temperatureRow({
    compressed_body_base64: body.toString("base64").replace(/(.{76})/gu, "$1\n"),
    content_hash: bodySha256,
    payload: {
      availableByDecision: true,
      bodyBytes: bodyPlaintext.length,
      bodySha256,
      claimId: label,
      completedAt: "2026-10-01T06:03:00.000Z",
      compressedBytes: body.length,
      errorCode: null,
      httpStatus: 200,
      metadata: {},
      outcome: "valid",
      parserVersion: "rain-prospective-capture/v1",
      recordedAt: "2026-10-01T06:03:00.000Z",
      rowCount: 49,
      startedAt: "2026-10-01T06:02:00.000Z",
    },
    record_kind: "rain_receipt",
    record_revision_identity: `rain-capture-receipt:${label}`,
    source_identity: `rain-capture:forecast:${label}`,
  });
}

// create one bounded aggregate revision diagnostic
function targetRevisionDiagnosticRow() {
  return temperatureRow({
    content_hash: hashA,
    first_received_at: "2026-10-01T07:01:00.000Z",
    last_received_at: "2026-10-01T07:04:00.000Z",
    payload: {
      adapterContract: "target/v1",
      contributorContentHashesSha256: hashA,
      contributorRevisionSha256: hashA,
      firstReceivedAt: "2026-10-01T07:01:00.000Z",
      maxRevisionCount: 2,
      maxSourceReceiptAt: "2026-10-01T07:04:00.000Z",
      physicalStationKey: "fixture-station",
      providerKey: "fixture-provider",
      recordCount: 12,
      revisedRecordCount: 1,
      sourceConfigFingerprint: hashA,
      sourceId: 1,
      sourceKey: "fixture-source",
      sourceKeys: ["fixture-source"],
      validAt: "2026-10-01T07:00:00.000Z",
    },
    record_kind: "target_revision_diagnostic",
    record_revision_identity: `physical-target-hour:1:2026-10-01T07:00:00Z:${hashA}`,
    reference_at: null,
    revision_count: 2,
    source_identity: "physical-target:1:fixture-source:fixture-provider",
    valid_at: "2026-10-01T07:00:00.000Z",
  });
}

// create one validated frozen edge pair
async function createEdgeSnapshot(root) {
  const evidenceRoot = join(root, "evidence");
  const objects = join(evidenceRoot, "objects");
  const receipts = join(evidenceRoot, "receipts");
  await Promise.all([
    mkdir(objects, { recursive: true }),
    mkdir(receipts, { recursive: true }),
  ]);
  const object = {
    bundleIdentities: {},
    contractVersion: "forecast-adjustment-evidence-object/v1",
    rows: [{
      record: { id: "fixture-record" },
      source: { sourceId: "fixture-source" },
    }],
    settingsSha256: hashA,
    siteKey: "ballydidean",
    window: "days=1",
  };
  const objectPlaintext = Buffer.from(JSON.stringify(object));
  const objectSha256 = sha256(objectPlaintext);
  const receiptIdentity = sha256(JSON.stringify({
    bundleIdentities: object.bundleIdentities,
    rows: object.rows.map((row) => ({ record: row.record, source: row.source })),
    settingsSha256: object.settingsSha256,
    siteKey: object.siteKey,
    window: object.window,
  }));
  const objectPath = join(objects, `sha256-${objectSha256}.json.gz`);
  const receiptPath = join(receipts, `sha256-${receiptIdentity}.json`);
  await writeFile(objectPath, gzipSync(objectPlaintext, { level: 9, mtime: 0 }));
  await writeFile(receiptPath, `${JSON.stringify({
    availability: {
      rowTimestampIndexes: [0],
      timestamps: ["2026-10-07T11:59:00.000Z"],
    },
    contractVersion: "forecast-adjustment-edge-receipt/v1",
    edgeReceiptIdentitySha256: receiptIdentity,
    firstEdgeCommittedAt: "2026-10-07T12:00:00.000Z",
    objectSha256,
    siteKey: "ballydidean",
    window: "days=1",
  })}\n`);
  const snapshotPath = join(root, "snapshot.json");
  const watermarkSha256 = sha256(JSON.stringify([{
    edgeReceiptIdentitySha256: receiptIdentity,
    objectSha256,
  }]));
  await writeFile(snapshotPath, `${JSON.stringify({
    contractVersion: "forecast-adjustment-evidence-snapshot/v1",
    entries: [{
      edgeReceiptIdentitySha256: receiptIdentity,
      objectPath,
      objectSha256,
      receiptPath,
    }],
    frozenAt: "2026-10-07T12:00:00.000Z",
    watermarkSha256,
  })}\n`);
  return snapshotPath;
}

// collect one streamed production archive
async function streamArchive(
  root,
  snapshotPath,
  rows,
  fromLocalDate = "2026-10-01",
  toLocalDate = "2026-10-01",
) {
  const temporaryRoot = join(root, "temporary");
  await mkdir(temporaryRoot, { recursive: true });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const manifestSha256 = await streamAdjustmentEvaluationPackageArchive({
    edgeSnapshotPath: snapshotPath,
    fromLocalDate,
    input: databaseStream(rows, completeMigrationLedger, fromLocalDate, toLocalDate),
    output,
    temporaryRoot,
    toLocalDate,
  });
  return { archive: Buffer.concat(chunks), manifestSha256, temporaryRoot };
}

// encode one database COPY stream for an exact ledger
function databaseStream(
  rows,
  ledger = completeMigrationLedger,
  fromLocalDate = "2026-10-01",
  toLocalDate = "2026-10-01",
) {
  return Readable.from([
    `${JSON.stringify(transactionManifest(ledger, fromLocalDate, toLocalDate))}\n`,
    ...rows.map((row) => `${JSON.stringify({ payload: row, record_type: "row" })}\n`),
  ]);
}

// retain packages produced before the additive maintenance migration
test("package accepts the exact legacy 0017 ledger for the v1 read-only query", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-export-legacy-"));
  const packageRoot = join(root, "package");

  try {
    const snapshotPath = await createEdgeSnapshot(root);
    await buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream([], legacyMigrationLedger),
      packageRoot,
      toLocalDate: "2026-10-01",
    });
    const verified = await verifyAdjustmentEvaluationPackage(packageRoot);
    assert.deepEqual(verified.manifest.databaseManifest.migration_names, legacyMigrationNames);
    assert.equal(
      verified.manifest.databaseManifest.schema_migration,
      "0017_adjustment_evaluation_export.sql",
    );
    assert.equal(
      verified.manifest.databaseManifest.query_contract_version,
      "adjustment-evaluation-export-query/v1",
    );
    assert.equal(verified.manifest.transaction.readOnly, "on");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// preserve the exact deployed v13 ledger without treating it as recurring action authority
test("package still accepts complete 0018 and rejects partial 0019", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-export-ledger-"));
  try {
    const snapshotPath = await createEdgeSnapshot(root);
    const previous = migrationLedger(completeMigrationNames.slice(0, 18),
      completeMigrationChecksums.slice(0, 18));
    await buildAdjustmentEvaluationPackage({ edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01", toLocalDate: "2026-10-01",
      input: databaseStream([temperatureRow()], previous), packageRoot: join(root, "previous") });
    const partialNames = [...legacyMigrationNames, "0019_adjustment_maintenance_recurring.sql"];
    const partial = migrationLedger(partialNames,
      [...legacyMigrationChecksums, completeMigrationChecksums[18]]);
    await assert.rejects(buildAdjustmentEvaluationPackage({ edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01", toLocalDate: "2026-10-01",
      input: databaseStream([temperatureRow()], partial), packageRoot: join(root, "partial") }));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// accept the exact additive maintenance ledger without widening the export query
test("package accepts the complete 0021 ledger for the unchanged v1 query", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-export-"));
  const packageRoot = join(root, "package");

  try {
    assert.deepEqual(completeMigrationNames.slice(17), [
      "0018_adjustment_maintenance_v2.sql",
      "0019_adjustment_maintenance_recurring.sql",
      "0020_adjustment_revision_frontier.sql",
      "0021_adjustment_rolling_registration.sql",
    ]);
    const snapshotPath = await createEdgeSnapshot(root);
    const rainRow = rainReceiptRow();
    const body = Buffer.from(rainRow.compressed_body_base64, "base64");
    const manifestHash = await buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream([temperatureRow(), rainRow]),
      packageRoot,
      toLocalDate: "2026-10-01",
    });
    const strict = await verifyAdjustmentEvaluationPackage(packageRoot);
    const verified = await loadVerifiedAdjustmentEvaluationPackage(packageRoot);
    assert.equal(strict.manifestSha256, manifestHash);
    assert.deepEqual(strict.manifest, verified.manifest);
    assert.equal(verified.manifestSha256, manifestHash);
    assert.equal(verified.rows.length, 2);
    assert.equal(verified.manifest.revisionDiagnostics.rowCount, 2);
    assert.equal(verified.manifest.edgeEvidence.receiptCount, 1);
    assert.equal(verified.manifest.edgeEvidence.objectCount, 1);
    assert.deepEqual(
      verified.manifest.databaseManifest.migration_names,
      completeMigrationNames,
    );
    assert.equal(
      verified.manifest.databaseManifest.schema_migration,
      "0017_adjustment_evaluation_export.sql",
    );
    assert.equal(
      verified.manifest.databaseManifest.query_contract_version,
      "adjustment-evaluation-export-query/v1",
    );
    assert.match(verified.rows[1].body_member_path, /^members\/bodies\/sha256-/u);
    assert.deepEqual(
      verified.bodies[verified.rows[1].body_member_path],
      body,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("v2 function envelopes require the complete ledger and remain value-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-v2-functions-"));
  const registrationSha256 = "1".repeat(64);
  const accessSha256 = "6".repeat(64);

  try {
    const availability = await frameAdjustmentConfirmationAvailabilityV2({
      input: Readable.from([JSON.stringify(maintenanceResponse(
        availabilityPayload(registrationSha256),
      ))]),
      registrationSha256,
    });
    const availabilityPath = join(root, "availability.json");
    await writeFile(availabilityPath, availability, { mode: 0o600 });
    assert.match(
      await verifyAdjustmentConfirmationAvailabilityV2(availabilityPath),
      /^[a-f0-9]{64}$/u,
    );
    const decodedAvailability = JSON.parse(availability);
    assert.equal(decodedAvailability.payload.missingExpectedDueKeys, null);
    assert.equal(
      decodedAvailability.payload.missingExpectedDueKeysStatus,
      "requires_anchored_cold_reconstruction",
    );
    assert.doesNotMatch(
      availability.toString("utf8"),
      /candidateTemperature|rawTemperature|targetValue|comparatorValue/iu,
    );

    const authorization = await frameAdjustmentConfirmationAuthorizationV2({
      accessSha256,
      chunkIndex: 0,
      input: Readable.from([JSON.stringify(maintenanceResponse(
        authorizationPayload(registrationSha256, accessSha256),
      ))]),
      registrationSha256,
    });
    const decodedAuthorization = JSON.parse(authorization);
    assert.equal(decodedAuthorization.payload.fromLocalDate, "2026-10-01");
    assert.equal(decodedAuthorization.payload.toLocalDateExclusive, "2026-10-15");
    assert.equal(decodedAuthorization.transaction.read_only, "on");

    await assert.rejects(
      frameAdjustmentConfirmationAvailabilityV2({
        input: Readable.from([JSON.stringify(maintenanceResponse(
          availabilityPayload(registrationSha256),
          legacyMigrationLedger,
        ))]),
        registrationSha256,
      }),
      /maintenance database ledger is not exact/u,
    );
    const partialLedger = migrationLedger(
      [...legacyMigrationNames, completeMigrationNames.at(-1)],
      [...legacyMigrationChecksums, completeMigrationChecksums.at(-1)],
    );
    await assert.rejects(
      frameAdjustmentConfirmationAuthorizationV2({
        accessSha256,
        chunkIndex: 0,
        input: Readable.from([JSON.stringify(maintenanceResponse(
          authorizationPayload(registrationSha256, accessSha256),
          partialLedger,
        ))]),
        registrationSha256,
      }),
      /database manifest identity|maintenance database ledger/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("v2 streams bind local-date semantics, lineage, payload hash, and persisted burn", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-v2-stream-"));
  const snapshotPath = await createEdgeSnapshot(root);
  const registrationSha256 = "1".repeat(64);
  const accessSha256 = "6".repeat(64);

  try {
    const streamed = await streamArchive(root, snapshotPath, [], "2026-10-01", "2026-10-14");
    const sourceArchivePath = join(root, "source-v1.tar.gz");
    await writeFile(sourceArchivePath, streamed.archive, { mode: 0o600 });
    const dailyOutput = new PassThrough();
    const dailyChunks = [];
    dailyOutput.on("data", (chunk) => dailyChunks.push(chunk));
    await streamAdjustmentEvaluationV2EnvelopeArchive({
      edgeSnapshotPath: snapshotPath,
      exportKind: "daily_monitoring",
      fromLocalDate: "2026-10-01",
      output: dailyOutput,
      sourceArchivePath,
      toLocalDate: "2026-10-14",
    });
    const dailyFrame = Buffer.concat(dailyChunks);
    const dailyFramePath = join(root, "daily-v2.frame");
    await writeFile(dailyFramePath, dailyFrame, { mode: 0o600 });
    const verifiedFrame = await verifyAdjustmentEvaluationV2Stream(dailyFramePath);
    assert.equal(verifiedFrame.header.exportKind, "daily_monitoring");
    assert.equal(verifiedFrame.header.valueAuthority, "none");
    assert.equal(verifiedFrame.header.authorization, null);
    assert.equal(
      verifiedFrame.header.dateSemantics,
      "america_los_angeles_inclusive_local_dates",
    );
    assert.deepEqual(
      dailyFrame.subarray(verifiedFrame.payloadOffset),
      streamed.archive,
    );

    const envelopePath = join(root, "envelope.json");
    const packageRoot = join(root, "normalized-package");
    await mkdir(packageRoot);
    await writeFile(envelopePath, verifiedFrame.headerBytes, { mode: 0o600 });
    await writeFile(join(root, "payload.tar.gz"), streamed.archive, { mode: 0o600 });
    await executeFile("tar", [
      "--extract",
      "--gzip",
      "--file",
      join(root, "payload.tar.gz"),
      "--directory",
      packageRoot,
    ]);
    const normalized = await verifyAdjustmentEvaluationV2EnvelopePackage({
      envelopePath,
      packageRoot,
    });
    assert.match(normalized.envelopeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(normalized.manifestSha256, streamed.manifestSha256);

    await assert.rejects(
      streamAdjustmentEvaluationV2EnvelopeArchive({
        edgeSnapshotPath: snapshotPath,
        exportKind: "post_burn_confirmation",
        fromLocalDate: "2026-10-01",
        output: new PassThrough(),
        sourceArchivePath,
        toLocalDate: "2026-10-14",
      }),
      /confirmation authorization is missing/u,
    );
    const authorization = await frameAdjustmentConfirmationAuthorizationV2({
      accessSha256,
      chunkIndex: 0,
      input: Readable.from([JSON.stringify(maintenanceResponse(
        authorizationPayload(registrationSha256, accessSha256),
      ))]),
      registrationSha256,
    });
    const authorizationPath = join(root, "authorization.json");
    await writeFile(authorizationPath, authorization, { mode: 0o600 });
    const confirmationOutput = new PassThrough();
    const confirmationChunks = [];
    confirmationOutput.on("data", (chunk) => confirmationChunks.push(chunk));
    await streamAdjustmentEvaluationV2EnvelopeArchive({
      authorizationPath,
      edgeSnapshotPath: snapshotPath,
      exportKind: "post_burn_confirmation",
      fromLocalDate: "2026-10-01",
      output: confirmationOutput,
      sourceArchivePath,
      toLocalDate: "2026-10-14",
    });
    const confirmationFramePath = join(root, "confirmation-v2.frame");
    await writeFile(
      confirmationFramePath,
      Buffer.concat(confirmationChunks),
      { mode: 0o600 },
    );
    const confirmed = await verifyAdjustmentEvaluationV2Stream(confirmationFramePath);
    assert.equal(confirmed.header.valueAuthority, "persisted_burn_authorization");
    assert.equal(
      confirmed.header.snapshotLineage.revisionCatalogWatermarkSha256,
      "9".repeat(64),
    );
    assert.equal(
      confirmed.header.snapshotLineage.targetComparatorSnapshotRootSha256,
      "a".repeat(64),
    );

    const corrupted = Buffer.from(await readFile(confirmationFramePath));
    corrupted[corrupted.length - 1] ^= 0xff;
    const corruptedPath = join(root, "confirmation-corrupt.frame");
    await writeFile(corruptedPath, corrupted, { mode: 0o600 });
    await assert.rejects(
      verifyAdjustmentEvaluationV2Stream(corruptedPath),
      /invalid payload/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("package rejects schema drift, row overflow, body bombs, and member tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-reject-"));

  try {
    const snapshotPath = await createEdgeSnapshot(root);
    const forgedManifest = transactionManifest();
    forgedManifest.payload.query_contract_sha256 = hashA;
    await assert.rejects(buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: Readable.from([`${JSON.stringify(forgedManifest)}\n`]),
      packageRoot: join(root, "forged-query-contract"),
      toLocalDate: "2026-10-01",
    }), /database manifest identity/u);

    const partialLedger = migrationLedger(
      completeMigrationNames,
      legacyMigrationChecksums,
    );
    const driftedChecksums = [...completeMigrationChecksums];
    driftedChecksums[driftedChecksums.length - 1] = hashA;
    const driftedLedger = migrationLedger(completeMigrationNames, driftedChecksums);
    const extraLedger = migrationLedger(
      [...completeMigrationNames, "0019_unknown.sql"],
      [...completeMigrationChecksums, hashA],
    );

    // reject partial, drifted and unknown-extra migration histories
    for (const [label, ledger] of [
      ["partial-ledger", partialLedger],
      ["drifted-ledger", driftedLedger],
      ["unknown-extra-ledger", extraLedger],
    ]) {
      await assert.rejects(buildAdjustmentEvaluationPackage({
        edgeSnapshotPath: snapshotPath,
        fromLocalDate: "2026-10-01",
        input: databaseStream([], ledger),
        packageRoot: join(root, label),
        toLocalDate: "2026-10-01",
      }), /database manifest identity/u);
    }

    await assert.rejects(buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream([temperatureRow({ privateUrl: "https://example.invalid" })]),
      packageRoot: join(root, "unknown-key"),
      toLocalDate: "2026-10-01",
    }), /unexpected keys/u);

    const overflowRows = Array.from({ length: 8_193 }, (_, index) => temperatureRow({
      record_revision_identity: `temperature:${String(index)}`,
    }));
    await assert.rejects(buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream(overflowRows),
      packageRoot: join(root, "overflow"),
      toLocalDate: "2026-10-01",
    }), /row limit/u);

    const bombPlaintext = Buffer.from("x".repeat(100_000));
    const bomb = gzipSync(bombPlaintext, { level: 9, mtime: 0 });
    const bombSha256 = sha256(bombPlaintext);
    const bombRow = temperatureRow({
      compressed_body_base64: bomb.toString("base64"),
      content_hash: bombSha256,
      payload: {
        availableByDecision: true,
        bodyBytes: bombPlaintext.length,
        bodySha256: bombSha256,
        claimId: "bomb",
        completedAt: "2026-10-01T06:03:00.000Z",
        compressedBytes: bomb.length,
        errorCode: null,
        httpStatus: 200,
        metadata: {},
        outcome: "valid",
        parserVersion: "rain-prospective-capture/v1",
        recordedAt: "2026-10-01T06:03:00.000Z",
        rowCount: 49,
        startedAt: "2026-10-01T06:02:00.000Z",
      },
      record_kind: "rain_receipt",
      record_revision_identity: "rain-capture-receipt:bomb",
      source_identity: "rain-capture:forecast:bomb",
    });
    await assert.rejects(buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream([bombRow]),
      packageRoot: join(root, "bomb"),
      toLocalDate: "2026-10-01",
    }));

    const packageRoot = join(root, "tamper");
    await buildAdjustmentEvaluationPackage({
      edgeSnapshotPath: snapshotPath,
      fromLocalDate: "2026-10-01",
      input: databaseStream([temperatureRow()]),
      packageRoot,
      toLocalDate: "2026-10-01",
    });
    await writeFile(join(packageRoot, "members/rows.jsonl.gz"), "changed");
    await assert.rejects(
      verifyAdjustmentEvaluationPackage(packageRoot),
      /member bytes differ/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("production package streams deterministic archives with only bounded row staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-stream-"));

  try {
    const snapshotPath = await createEdgeSnapshot(root);
    const rows = [
      temperatureRow(),
      targetRevisionDiagnosticRow(),
      rainReceiptRow("stream"),
    ];
    const first = await streamArchive(join(root, "first"), snapshotPath, rows);
    const second = await streamArchive(join(root, "second"), snapshotPath, rows);
    assert.deepEqual(first.archive, second.archive);
    assert.deepEqual(readdirSync(first.temporaryRoot), []);
    assert.ok(first.archive.length < 48 * 1024 * 1024);
    const archivePath = join(root, "export.tar.gz");
    const extracted = join(root, "extracted");
    await writeFile(archivePath, first.archive);
    await mkdir(extracted);
    await executeFile("tar", ["--extract", "--gzip", "--file", archivePath, "--directory", extracted]);
    const verified = await loadVerifiedAdjustmentEvaluationPackage(extracted);
    assert.equal(verified.manifestSha256, first.manifestSha256);
    assert.equal(verified.rows.length, 3);
    assert.equal(verified.rows[1].record_kind, "target_revision_diagnostic");
    assert.match(verified.rows[2].body_member_path, /^members\/bodies\/sha256-/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("server export mutex refuses a concurrent reservation before capacity accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-lock-"));
  const lock = join(root, "export.lock");
  const script = await readFile(
    join(repoRoot, "deploy/scripts/adjustment-evaluation-export.sh"),
    "utf8",
  );
  const holder = spawn("bash", [
    "-c",
    "exec 9>\"$1\"; flock -n 9; printf ready; read -r _",
    "adjustment-export-lock-holder",
    lock,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  try {
    await new Promise((resolveReady, rejectReady) => {
      holder.once("error", rejectReady);
      holder.stdout.once("data", (chunk) => {
        assert.equal(chunk.toString(), "ready");
        resolveReady();
      });
    });
    await assert.rejects(
      executeFile("flock", ["--nonblock", lock, "true"]),
      (error) => error.code === 1,
    );
    assert.match(script, /install -d -o 0 -g 0 -m 0700 "\$lock_root"/u);
    assert.ok(
      script.indexOf("flock -n \"$export_lock_fd\"") <
        script.indexOf("# reserve the complete reviewed export envelope"),
    );
  } finally {
    holder.stdin.end("release\n");
    await new Promise((resolveClose) => holder.once("close", resolveClose));
    await rm(root, { force: true, recursive: true });
  }
});

test("forced operation surfaces expose only closed adjustment verbs", async () => {
  const dispatch = await readFile(join(repoRoot, "deploy/scripts/ssh-dispatch.sh"), "utf8");
  const remote = await readFile(join(repoRoot, "deploy/scripts/remote-ops.sh"), "utf8");
  const sshRun = await readFile(join(repoRoot, "deploy/scripts/ssh-run.sh"), "utf8");
  const installer = await readFile(join(repoRoot, "deploy/scripts/install-adjustment-scorecard.sh"), "utf8");
  const exporter = await readFile(
    join(repoRoot, "deploy/scripts/adjustment-evaluation-export.sh"),
    "utf8",
  );
  const pull = await readFile(
    join(repoRoot, "deploy/scripts/pull-adjustment-evaluation-export.sh"),
    "utf8",
  );
  const statusPath = join(repoRoot, "deploy/scripts/status.sh");
  const status = await readFile(statusPath, "utf8");
  assert.match(dispatch, /adjustment-evaluation-export/u);
  assert.match(dispatch, /adjustment-maintenance-anchor-status-v2/u);
  assert.match(dispatch, /adjustment-future-input-seal-install-v2/u);
  assert.match(dispatch, /adjustment-maintenance-anchor-install-v3/u);
  assert.match(dispatch, /adjustment-maintenance-anchor-finalize-v3/u);
  assert.match(dispatch, /install-adjustment-scorecard/u);
  assert.match(remote, /validate_calendar_date_range "\$1" "\$2" 14/u);
  assert.match(
    remote,
    /adjustment-maintenance-anchor-status-v2\)[\s\S]*status\.sh" --adjustment-maintenance-v2/u,
  );
  assert.match(remote,
    /adjustment-future-input-seal-install-v2\)[\s\S]*future-input-seal-install-v2/u);
  assert.match(remote,
    /adjustment-maintenance-anchor-install-v3\)[\s\S]*maintenance-anchor-install-v3/u);
  assert.match(remote,
    /adjustment-maintenance-anchor-finalize-v3\)[\s\S]*maintenance-anchor-finalize-v3/u);
  assert.match(sshRun, /adjustment-future-input-seal-install-v2/u);
  assert.match(sshRun, /adjustment-maintenance-anchor-install-v3/u);
  assert.match(sshRun, /adjustment-maintenance-anchor-finalize-v3/u);
  assert.match(installer, /forecast-adjustment-scorecard-contract\.mjs/u);
  assert.equal(
    exporter.match(/node --max-old-space-size=48 --max-semi-space-size=1/gu)?.length,
    12,
  );
  assert.match(exporter, /--availability-v2/u);
  assert.match(exporter, /adjustment_confirmation_availability_v2/u);
  assert.match(exporter, /--confirmation-v2/u);
  assert.match(exporter, /adjustment_confirmation_export_v2/u);
  assert.match(exporter, /--revision-catalog-start-v1/u);
  assert.match(exporter, /revision-cold-start-v1/u);
  assert.match(exporter, /--revision-catalog-current-start-v1/u);
  assert.match(exporter, /adjustment_revision_frontier_v1\(\)/u);
  assert.match(exporter, /--revision-catalog-page-v1/u);
  assert.match(exporter, /revision-cold-page-v1/u);
  assert.match(exporter, /--revision-gap-start-v1/u);
  assert.match(exporter, /revision-gap-start-v1/u);
  assert.match(exporter, /--revision-gap-page-v1/u);
  assert.match(exporter, /revision-gap-page-v1/u);
  assert.match(exporter, /--revision-gap-ack-v1/u);
  assert.match(exporter, /revision-gap-ack-v1/u);
  assert.match(exporter, /--revision-capture-epoch-init-v1/u);
  assert.match(exporter, /revision-capture-epoch-init-v1/u);
  assert.match(exporter, /--revision-capture-epoch-v1/u);
  assert.match(exporter, /revision-capture-epoch-read-v1/u);
  assert.match(exporter, /--revision-capture-epoch-snapshot-v1/u);
  assert.match(exporter, /revision-capture-epoch-snapshot-read-v1/u);
  assert.match(exporter, /--database-ledger-v3/u);
  assert.match(exporter, /project-maintenance-ledger-v3/u);
  assert.match(dispatch, /adjustment-database-ledger-v3/u);
  assert.match(remote,
    /adjustment-database-ledger-v3\)[\s\S]*adjustment-evaluation-export\.sh" --database-ledger-v3/u);
  assert.match(remote,
    /adjustment-revision-custody-ack-v1\|adjustment-revision-custody-ack-v2\)[\s\S]*revision_custody_action=\$\{action\/adjustment-revision\/revision-cold\}/u);
  assert.match(remote, /"\$\{10\}" =~ \^\(none\|\[a-f0-9\]\{64\}\)\$/u);
  assert.match(sshRun, /"\$\{10\}" =~ \^\(none\|\[a-f0-9\]\{64\}\)\$/u);
  assert.doesNotMatch(remote, /"\$10"/u);
  assert.doesNotMatch(sshRun, /"\$10"/u);
  assert.match(exporter, /--username weather_training_export/u);
  assert.doesNotMatch(exporter, /--username weather_owner/u);
  assert.doesNotMatch(exporter, /FROM adjustment_shadow_/u);
  assert.match(pull, /adjustment-evaluation-export-v2/u);
  assert.match(pull, /adjustment-confirmation-availability-v2/u);
  assert.match(pull, /adjustment-confirmation-export-v2/u);
  assert.match(status, /--adjustment-maintenance-v2/u);
  assert.match(status, /maintenance-anchor-status-v2/u);
  assert.match(
    pull,
    /node --max-old-space-size=48 --max-semi-space-size=1[\s\S]*adjustment-evaluation-package\.mjs" verify/u,
  );
  assert.doesNotMatch(installer, /forecast-adjustments|weather-admin-store/u);

  const projected = JSON.parse((await executeFile(
    "bash",
    [statusPath, "--adjustment-maintenance-v2"],
  )).stdout);
  assert.deepEqual(Object.keys(projected).sort(), [
    "actionEligible",
    "contractVersion",
    "privacyState",
    "rootState",
    "schemaReadiness",
    "slots",
  ]);
  assert.equal(projected.actionEligible, false);
  assert.equal(projected.contractVersion, "adjustment-maintenance-anchor-status/v2");
  assert.doesNotMatch(JSON.stringify(projected), /\/var\/|hostname|journalHead/iu);
});
