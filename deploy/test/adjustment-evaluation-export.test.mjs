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
  loadVerifiedAdjustmentEvaluationPackage,
  streamAdjustmentEvaluationPackageArchive,
  verifyAdjustmentEvaluationPackage,
} from "../scripts/adjustment-evaluation-package.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const executeFile = promisify(execFile);
const hashA = "a".repeat(64);
const queryContractSha256 =
  "c860039c72818a9b813ed9f9d93f5d8e115f4144e99d698734e9159ca3457bd4";
const rowSchemaSha256 =
  "c21782034130d003e4af48fada4c8f6545f6f1c4dff550f92d0523c7d96d20e2";
const migrationRoot = join(repoRoot, "packages/database/migrations");
const migrationNames = readdirSync(migrationRoot).filter((name) => name.endsWith(".sql")).sort();
const migrationChecksums = migrationNames.map((name) => sha256(readFileSync(join(migrationRoot, name))));
const migrationHistorySha256 = sha256(Buffer.from(
  migrationNames.map((name, index) => `${name}:${migrationChecksums[index]}`).join("\n"),
));

// hash exact fixture bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// create one fixed transaction manifest
function transactionManifest() {
  return {
    payload: {
      contract_version: "adjustment-evaluation-export-manifest/v1",
      migration_checksums: migrationChecksums,
      migration_history_sha256: migrationHistorySha256,
      migration_names: migrationNames,
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
      from_local_date: "2026-10-01",
      idle_in_transaction_session_timeout: "30s",
      isolation_level: "repeatable read",
      lock_timeout: "5s",
      read_only: "on",
      statement_timeout: "5min",
      to_local_date: "2026-10-01",
    },
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
async function streamArchive(root, snapshotPath, rows) {
  const temporaryRoot = join(root, "temporary");
  await mkdir(temporaryRoot, { recursive: true });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const manifestSha256 = await streamAdjustmentEvaluationPackageArchive({
    edgeSnapshotPath: snapshotPath,
    fromLocalDate: "2026-10-01",
    input: databaseStream(rows),
    output,
    temporaryRoot,
    toLocalDate: "2026-10-01",
  });
  return { archive: Buffer.concat(chunks), manifestSha256, temporaryRoot };
}

// encode one database COPY stream
function databaseStream(rows) {
  return Readable.from([
    `${JSON.stringify(transactionManifest())}\n`,
    ...rows.map((row) => `${JSON.stringify({ payload: row, record_type: "row" })}\n`),
  ]);
}

test("package binds the repeatable-read manifest, rows, bodies, and frozen edge watermark", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-export-"));
  const packageRoot = join(root, "package");

  try {
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
    assert.match(verified.rows[1].body_member_path, /^members\/bodies\/sha256-/u);
    assert.deepEqual(
      verified.bodies[verified.rows[1].body_member_path],
      body,
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

test("forced operation surfaces expose only the two new exact verbs", async () => {
  const dispatch = await readFile(join(repoRoot, "deploy/scripts/ssh-dispatch.sh"), "utf8");
  const remote = await readFile(join(repoRoot, "deploy/scripts/remote-ops.sh"), "utf8");
  const installer = await readFile(join(repoRoot, "deploy/scripts/install-adjustment-scorecard.sh"), "utf8");
  const exporter = await readFile(
    join(repoRoot, "deploy/scripts/adjustment-evaluation-export.sh"),
    "utf8",
  );
  const pull = await readFile(
    join(repoRoot, "deploy/scripts/pull-adjustment-evaluation-export.sh"),
    "utf8",
  );
  assert.match(dispatch, /adjustment-evaluation-export/u);
  assert.match(dispatch, /install-adjustment-scorecard/u);
  assert.match(remote, /validate_calendar_date_range "\$1" "\$2" 14/u);
  assert.match(installer, /forecast-adjustment-scorecard-contract\.mjs/u);
  assert.equal(
    exporter.match(/node --max-old-space-size=48 --max-semi-space-size=1/gu)?.length,
    2,
  );
  assert.match(
    pull,
    /node --max-old-space-size=48 --max-semi-space-size=1[\s\S]*adjustment-evaluation-package\.mjs" verify/u,
  );
  assert.doesNotMatch(installer, /forecast-adjustments|weather-admin-store/u);
});
