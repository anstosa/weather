#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  lstatSync,
  readFileSync,
  readdirSync,
  statfsSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import { PassThrough, Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";

const PACKAGE_VERSION = "adjustment-evaluation-export-package/v1";
const DATABASE_MANIFEST_VERSION = "adjustment-evaluation-export-manifest/v1";
const EDGE_OBJECT_VERSION = "forecast-adjustment-evidence-object/v1";
const EDGE_RECEIPT_VERSION = "forecast-adjustment-edge-receipt/v1";
const EDGE_SNAPSHOT_VERSION = "forecast-adjustment-evidence-snapshot/v1";
const EDGE_WINDOWS = new Set(["days=1", "days=5", "days=10", "overnight"]);
const MAX_DAYS = 14;
const MAX_ROWS = 8_192;
const MAX_COMPRESSED_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 48 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_TEMP_BYTES = 64 * 1024 * 1024;
const MAX_OTHER_TEMP_BYTES = 16 * 1024 * 1024;
const MAX_DATABASE_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RATIO = 64;
const TAR_BLOCK_BYTES = 512;
const EXPECTED_ROW_SCHEMA_SHA256 =
  "c21782034130d003e4af48fada4c8f6545f6f1c4dff550f92d0523c7d96d20e2";
const EXPECTED_QUERY_CONTRACT_SHA256 =
  "c860039c72818a9b813ed9f9d93f5d8e115f4144e99d698734e9159ca3457bd4";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const EXPECTED_MIGRATION_NAMES = [
  "0001_initial_weather.sql",
  "0002_worker_migration_readiness.sql",
  "0003_ecowitt_measurements.sql",
  "0004_tempest_metadata.sql",
  "0005_source_supersession.sql",
  "0006_station_coordinates.sql",
  "0007_tide_sources.sql",
  "0008_ecowitt_property_sensors.sql",
  "0009_forecast_anchor_records.sql",
  "0010_forecast_training_export.sql",
  "0011_forecast_runtime_provenance.sql",
  "0012_hide_archive_only_forecasts_from_live_reads.sql",
  "0013_ecmwf_temperature_canary.sql",
  "0014_rain_collection.sql",
  "0015_rain_station_access.sql",
  "0016_rain_adjustment.sql",
  "0017_adjustment_evaluation_export.sql",
];
const EXPECTED_MIGRATION_CHECKSUMS = [
  "f4264482606a3476b4b54e3089e66c900f0ad5104ea678a9bf17e5e5ba385a62",
  "954731c9ddb791c85defc3bffd887a3d30e9ff9fb5c9dac96e050ac52a796f03",
  "250e9b49176fda732b23f797a6dbce6878ca93818fa1bf6a408b5d6611ee5a48",
  "5487c90a4e70f8e049f9ed48c3ee3f025eb9f1908ed04a1febfb736c22f30d34",
  "462be10d1a35419b52068d09ae5254134e0168fed0ada66f957c87d290c8e6f1",
  "33f3fc5b1b475add0e862b45488a4a3482435df0ae674599005bafd37c3886a8",
  "4e2ed3037ea82011e947e48102149a6ea6456e5fb9f504436f7ec35f6e191390",
  "3934568dcdbb840f5026a09bab676bede7ad7d2571c1d7415efdabb902dd8b81",
  "e144415b6ac8e19338cc4b53d7daeffbf3d32650af880ab7acb809c6f71ded20",
  "2590423b7787b0e5e5668bfa4af21db775b8926540b1d2e339d6656aa3f27dc8",
  "ebf5789636095982e6010a868cdfdd4d7449ca79fb1057adf3b8dd8f49a337dc",
  "663ed323104bb70f4d0e735c3b546fb111038be4d0fee83e0c76c018cf0da15c",
  "e05f0397529108641ad9b9eb5381ac968f35449514fe4d8ed0ac502c9d5bf3ee",
  "2a311e2effcc975442c1011c627c125521cc4396323b32f0d0c4f92ea1ccba04",
  "2f560ccec001246a3caa5d27476900b2694dfb7cc0701b35181265ef1fb78822",
  "9fa5659c032dc21fdf82dca693fa962d8b5212d1192ae35c4cfd04bef94be5f9",
  "6f18210453a18f0deefe95a0b70657cc4c4dd3fc20d0bab72f847ee04958ab90",
];
const EXPECTED_MIGRATION_HISTORY_SHA256 = createHash("sha256").update(
  EXPECTED_MIGRATION_NAMES.map((name, index) =>
    `${name}:${EXPECTED_MIGRATION_CHECKSUMS[index]}`).join("\n"),
).digest("hex");
const ROW_KINDS = new Set([
  "rain_adjustment_run",
  "rain_claim",
  "rain_receipt",
  "target_revision_diagnostic",
  "temperature_hour",
  "temperature_run",
]);
const PAYLOAD_KEYS = new Map([
  ["temperature_run", [
    "adapterVersion",
    "contentHash",
    "firstReceivedAt",
    "id",
    "lastReceivedAt",
    "modelCycle",
    "providerResponseSha256",
    "recentErrorState",
    "recentErrorStateSha256",
    "revisionCount",
    "runInitializedAt",
    "stateReason",
    "stateStatus",
    "upstreamModel",
  ]],
  ["temperature_hour", [
    "contentHash",
    "modelLeadHours",
    "rawRelativeHumidityPercent",
    "rawTemperatureC",
    "rawWindSpeedMps",
    "runId",
    "validAt",
  ]],
  ["rain_claim", [
    "attempt",
    "claimedAt",
    "id",
    "kind",
    "policy",
    "policySha256",
    "release",
    "runInitializedAt",
    "slotKey",
    "stationId",
    "windowEndExclusive",
    "windowStart",
  ]],
  ["rain_receipt", [
    "availableByDecision",
    "bodyBytes",
    "bodySha256",
    "claimId",
    "completedAt",
    "compressedBytes",
    "errorCode",
    "httpStatus",
    "metadata",
    "outcome",
    "parserVersion",
    "recordedAt",
    "rowCount",
    "startedAt",
  ]],
  ["rain_adjustment_run", [
    "decisionAt",
    "firstReceivedAt",
    "forecastClaimId",
    "generatedAt",
    "hours",
    "inputSha256",
    "modelSha256",
    "runInitializedAt",
  ]],
  ["target_revision_diagnostic", [
    "adapterContract",
    "contributorContentHashesSha256",
    "contributorRevisionSha256",
    "firstReceivedAt",
    "maxRevisionCount",
    "maxSourceReceiptAt",
    "physicalStationKey",
    "providerKey",
    "recordCount",
    "revisedRecordCount",
    "sourceConfigFingerprint",
    "sourceId",
    "sourceKey",
    "sourceKeys",
    "validAt",
  ]],
]);

// normalize canonical JSON
function canonicalize(value) {
  // preserve array order
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  // sort object keys
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

// encode canonical JSON
function canonicalJson(value) {
  return `${canonicalJsonValue(value)}\n`;
}

// encode one canonical JSON value without record framing
function canonicalJsonValue(value) {
  return JSON.stringify(canonicalize(value));
}

// pull bounded database records without eager line buffering
async function* databaseRecordLines(input) {
  let parts = [];
  let partBytes = 0;

  // request the next input chunk only after the prior record is consumed
  for await (const inputChunk of input) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    let start = 0;

    // split complete newline-delimited records inside this chunk
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      const nextBytes = partBytes + part.length;

      // reject oversize records before retaining the new bytes
      if (nextBytes > MAX_DATABASE_RECORD_BYTES) {
        throw new Error("database export record is empty or oversized");
      }
      // retain only the current bounded record
      if (part.length > 0) {
        parts.push(part);
        partBytes = nextBytes;
      }

      // await another pulled chunk for an incomplete record
      if (newline === -1) {
        break;
      }

      let line = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);

      // match the prior CRLF normalization without altering bare CR bytes
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      yield line.toString("utf8");
      parts = [];
      partBytes = 0;
      start = newline + 1;
    }
  }

  // preserve one final non-newline-terminated record
  if (partBytes > 0) {
    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
    yield line.toString("utf8");
  }
}

// hash exact bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// hash one bounded file without retaining it
async function sha256File(path) {
  const hash = createHash("sha256");

  // update the digest incrementally
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

// verify compressed plaintext without retaining decompressed bytes
async function validateCompressedBodyStream(input, compressedBytes, expectedBytes, expectedSha256) {
  // retain the database's fixed receipt bounds
  if (compressedBytes > 2_100_000 || expectedBytes > 2_000_000 ||
    expectedBytes > compressedBytes * MAX_RATIO) {
    throw new Error("rain receipt body exceeds its fixed size limit");
  }
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const forbiddenPrivateMaterial =
    /(api[_-]?key|authorization|password|secret|token|https?:\/\/)/iu;
  let inspectionTail = "";
  let plaintextBytes = 0;
  const counter = new Transform({
    // cap decompressed bytes before hashing them
    transform(chunk, encoding, callback) {
      plaintextBytes += chunk.length;
      if (plaintextBytes > expectedBytes || plaintextBytes > compressedBytes * MAX_RATIO) {
        callback(new Error("rain receipt body exceeds its decompression limit"));
        return;
      }
      hash.update(chunk);
      const inspection = `${inspectionTail}${decoder.write(chunk)}`;

      // reject private material without retaining the decoded body
      if (forbiddenPrivateMaterial.test(inspection)) {
        callback(new Error("rain receipt body contains forbidden private material"));
        return;
      }
      inspectionTail = inspection.slice(-16);
      callback();
    },
  });
  await pipeline(input, createGunzip(), counter);

  // bind exact length and plaintext identity
  if (plaintextBytes !== expectedBytes || hash.digest("hex") !== expectedSha256) {
    throw new Error("rain receipt body hash or decompression ratio is invalid");
  }

  // inspect the decoder's final partial character
  if (forbiddenPrivateMaterial.test(`${inspectionTail}${decoder.end()}`)) {
    throw new Error("rain receipt body contains forbidden private material");
  }
}

// verify one in-memory compressed body through the streaming validator
async function validateCompressedBody(body, expectedBytes, expectedSha256) {
  await validateCompressedBodyStream(
    Readable.from(body),
    body.length,
    expectedBytes,
    expectedSha256,
  );
}

// require a plain object
function requireObject(value, description) {
  // reject arrays and null
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }

  return value;
}

// require exact object keys
function requireExactKeys(value, expected, description) {
  const actual = Object.keys(requireObject(value, description)).sort();
  const wanted = [...expected].sort();

  // reject schema drift
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${description} has unexpected keys`);
  }
}

// parse one canonical calendar date
function parseCalendarDate(value, description) {
  // reject noncanonical or impossible dates
  if (!DATE_PATTERN.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${description} must use YYYY-MM-DD`);
  }

  return Date.parse(`${value}T00:00:00.000Z`);
}

// validate one bounded inclusive interval
function validateDateRange(fromLocalDate, toLocalDate) {
  const from = parseCalendarDate(fromLocalDate, "fromLocalDate");
  const to = parseCalendarDate(toLocalDate, "toLocalDate");
  const days = Math.trunc((to - from) / 86_400_000) + 1;

  // reject reversed and oversized intervals
  if (days < 1 || days > MAX_DAYS) {
    throw new Error(`export range must contain 1 to ${MAX_DAYS} inclusive dates`);
  }
}

// require one regular nonlinked file below a fixed root
async function requireSafeFile(path, root, description) {
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(path));
  const metadata = lstatSync(path);

  // reject links, special nodes, and path escapes
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
    (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`))) {
    throw new Error(`${description} must be a regular file below its fixed root`);
  }

  return metadata;
}

// write one stream chunk with backpressure
async function writeChunk(stream, chunk) {
  // wait before accepting more input
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

// close one writable stream
async function finishStream(stream) {
  stream.end();
  await once(stream, "finish");
}

// count real temporary allocation without following links
function allocatedBytesBelow(path) {
  const details = lstatSync(path, { bigint: true });

  // reject linked and special temporary entries
  if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
    throw new Error("export temporary root contains an invalid entry");
  }

  let bytes = Number(details.blocks * 512n);

  // include every fixed-root descendant allocation
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) {
      bytes += allocatedBytesBelow(join(path, name));
    }
  }

  return bytes;
}

// encode one portable tar number
function writeTarNumber(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");

  // reject values that do not fit the reviewed ustar field
  if (encoded.length >= length) {
    throw new Error("package member is too large for its tar header");
  }

  header.write(`${encoded}\0`, offset, length, "ascii");
}

// build one deterministic regular-file ustar header
function tarFileHeader(path, sizeBytes) {
  const archivePath = `./${path}`;
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const splitAt = archivePath.lastIndexOf("/");
  const name = Buffer.byteLength(archivePath) <= 100
    ? archivePath
    : archivePath.slice(splitAt + 1);
  const prefix = name === archivePath ? "" : archivePath.slice(0, splitAt);

  // keep all reviewed package paths in portable ustar fields
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error("package member path exceeds the tar limit");
  }

  header.write(name, 0, 100, "utf8");
  writeTarNumber(header, 100, 8, 0o600);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, sizeBytes);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  header.write(`${encodedChecksum}\0 `, 148, 8, "ascii");
  return header;
}

// stream one exact buffer into the archive
async function writeTarBuffer(stream, path, bytes) {
  await writeChunk(stream, tarFileHeader(path, bytes.length));
  await writeChunk(stream, bytes);
  const padding = (TAR_BLOCK_BYTES - (bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

  // align the next member without retaining prior bytes
  if (padding > 0) {
    await writeChunk(stream, Buffer.alloc(padding));
  }
}

// stream one staged file into the archive
async function writeTarFile(stream, path, sourcePath, sizeBytes) {
  await writeChunk(stream, tarFileHeader(path, sizeBytes));

  // forward the bounded file without buffering it again
  for await (const chunk of createReadStream(sourcePath)) {
    await writeChunk(stream, chunk);
  }
  const padding = (TAR_BLOCK_BYTES - (sizeBytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

  // align the next member
  if (padding > 0) {
    await writeChunk(stream, Buffer.alloc(padding));
  }
}

// validate the immutable database manifest record
function validateDatabaseManifest(value) {
  const manifest = requireObject(value, "database manifest");
  requireExactKeys(manifest, [
    "contract_version",
    "migration_checksums",
    "migration_history_sha256",
    "migration_names",
    "query_contract_sha256",
    "query_contract_version",
    "row_schema_sha256",
    "schema_migration",
    "site_key",
    "site_timezone",
  ], "database manifest");

  // bind this package to migration 0017 and Ballydidean
  if (manifest.contract_version !== DATABASE_MANIFEST_VERSION ||
    manifest.schema_migration !== "0017_adjustment_evaluation_export.sql" ||
    manifest.query_contract_version !== "adjustment-evaluation-export-query/v1" ||
    manifest.site_key !== "ballydidean" ||
    manifest.site_timezone !== "America/Los_Angeles" ||
    manifest.row_schema_sha256 !== EXPECTED_ROW_SCHEMA_SHA256 ||
    manifest.query_contract_sha256 !== EXPECTED_QUERY_CONTRACT_SHA256 ||
    !HASH_PATTERN.test(manifest.migration_history_sha256) ||
    manifest.migration_history_sha256 !== EXPECTED_MIGRATION_HISTORY_SHA256 ||
    !Array.isArray(manifest.migration_names) ||
    !Array.isArray(manifest.migration_checksums) ||
    JSON.stringify(manifest.migration_names) !== JSON.stringify(EXPECTED_MIGRATION_NAMES) ||
    JSON.stringify(manifest.migration_checksums) !==
      JSON.stringify(EXPECTED_MIGRATION_CHECKSUMS)) {
    throw new Error("database manifest identity is invalid");
  }

  return manifest;
}

// validate the transaction envelope
function validateTransaction(value, fromLocalDate, toLocalDate) {
  const transaction = requireObject(value, "transaction");
  requireExactKeys(transaction, [
    "created_at_utc",
    "from_local_date",
    "idle_in_transaction_session_timeout",
    "isolation_level",
    "lock_timeout",
    "read_only",
    "statement_timeout",
    "to_local_date",
  ], "transaction");

  // require the fixed read-only repeatable-read query settings
  if (transaction.from_local_date !== fromLocalDate ||
    transaction.to_local_date !== toLocalDate ||
    transaction.isolation_level !== "repeatable read" ||
    transaction.read_only !== "on" ||
    transaction.statement_timeout !== "5min" ||
    transaction.lock_timeout !== "5s" ||
    transaction.idle_in_transaction_session_timeout !== "30s" ||
    !Number.isFinite(Date.parse(transaction.created_at_utc))) {
    throw new Error("transaction contract is invalid");
  }

  return transaction;
}

// validate one exported database row
function validateRow(value) {
  const row = requireObject(value, "export row");
  requireExactKeys(row, [
    "compressed_body_base64",
    "content_hash",
    "first_received_at",
    "last_received_at",
    "local_date",
    "payload",
    "record_kind",
    "record_revision_identity",
    "reference_at",
    "revision_count",
    "site_key",
    "source_identity",
    "valid_at",
  ], "export row");

  // reject unexpected sites, row kinds, and identities
  if (row.site_key !== "ballydidean" || !ROW_KINDS.has(row.record_kind) ||
    typeof row.source_identity !== "string" || row.source_identity.length > 256 ||
    typeof row.record_revision_identity !== "string" || row.record_revision_identity.length > 320 ||
    !DATE_PATTERN.test(row.local_date) || !Number.isFinite(Date.parse(row.valid_at)) ||
    (row.reference_at !== null && !Number.isFinite(Date.parse(row.reference_at))) ||
    !Number.isFinite(Date.parse(row.first_received_at)) ||
    !Number.isFinite(Date.parse(row.last_received_at)) ||
    !Number.isInteger(row.revision_count) || row.revision_count < 0 ||
    (row.content_hash !== null && !HASH_PATTERN.test(row.content_hash)) ||
    (row.compressed_body_base64 !== null &&
      (row.record_kind !== "rain_receipt" ||
        typeof row.compressed_body_base64 !== "string"))) {
    throw new Error("export row identity is invalid");
  }

  requireObject(row.payload, "export row payload");
  requireExactKeys(row.payload, PAYLOAD_KEYS.get(row.record_kind), `${row.record_kind} payload`);

  // reject credential, URL, and authorization material even inside bounded JSON fields
  if (/(api[_-]?key|authorization|password|secret|token|https?:\/\/)/iu.test(
    JSON.stringify(row.payload),
  )) {
    throw new Error("export row payload contains forbidden private material");
  }
  return row;
}

// copy a frozen edge snapshot into package members
async function copyEdgeSnapshot(snapshotPath, packageRoot, maximumBytes) {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  requireExactKeys(snapshot, ["contractVersion", "entries", "frozenAt", "watermarkSha256"], "edge snapshot");

  // reject incomplete or unbounded snapshot identity
  if (snapshot.contractVersion !== EDGE_SNAPSHOT_VERSION ||
    !Number.isFinite(Date.parse(snapshot.frozenAt)) ||
    !HASH_PATTERN.test(snapshot.watermarkSha256) ||
    !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ROWS) {
    throw new Error("edge snapshot identity is invalid");
  }

  const receiptRoot = join(packageRoot, "members/edge/receipts");
  const objectRoot = join(packageRoot, "members/edge/objects");
  await mkdir(receiptRoot, { mode: 0o700, recursive: true });
  await mkdir(objectRoot, { mode: 0o700, recursive: true });
  const members = [];
  const seenReceipts = new Set();
  const seenObjects = new Set();
  let copiedBytes = 0;

  // copy every already-validated immutable pair exactly once
  for (const entry of snapshot.entries) {
    requireExactKeys(entry, [
      "edgeReceiptIdentitySha256",
      "objectPath",
      "objectSha256",
      "receiptPath",
    ], "edge snapshot entry");
    if (!HASH_PATTERN.test(entry.edgeReceiptIdentitySha256) ||
      !HASH_PATTERN.test(entry.objectSha256) ||
      seenReceipts.has(entry.edgeReceiptIdentitySha256)) {
      throw new Error("edge snapshot entry identity is invalid");
    }
    seenReceipts.add(entry.edgeReceiptIdentitySha256);
    const receiptSource = resolve(entry.receiptPath);
    const objectSource = resolve(entry.objectPath);
    const sourceRoot = resolve(join(dirname(receiptSource), ".."));
    await requireSafeFile(receiptSource, join(sourceRoot, "receipts"), "edge receipt");
    await requireSafeFile(objectSource, join(sourceRoot, "objects"), "edge object");
    const receiptBytes = await readFile(receiptSource);
    const objectBytes = await readFile(objectSource);
    const objectPlaintext = gunzipSync(objectBytes, {
      maxOutputLength: Math.min(512 * 1024 + 1, objectBytes.length * MAX_RATIO + 1),
    });

    // recheck filename and content identity at the package boundary
    if (basename(receiptSource) !== `sha256-${entry.edgeReceiptIdentitySha256}.json` ||
      basename(objectSource) !== `sha256-${entry.objectSha256}.json.gz` ||
      objectPlaintext.length > objectBytes.length * MAX_RATIO ||
      sha256(objectPlaintext) !== entry.objectSha256) {
      throw new Error("edge snapshot bytes changed after freeze");
    }

    const receiptPath = `members/edge/receipts/${basename(receiptSource)}`;
    copiedBytes += receiptBytes.length;
    if (copiedBytes > maximumBytes) {
      throw new Error("edge evidence exceeds the remaining host temporary limit");
    }
    await writeFile(join(packageRoot, receiptPath), receiptBytes, { flag: "wx", mode: 0o600 });
    members.push({ path: receiptPath, sha256: sha256(receiptBytes), sizeBytes: receiptBytes.length });

    // deduplicate objects shared by overlapping receipts
    if (!seenObjects.has(entry.objectSha256)) {
      seenObjects.add(entry.objectSha256);
      const objectPath = `members/edge/objects/${basename(objectSource)}`;
      copiedBytes += objectBytes.length;
      if (copiedBytes > maximumBytes) {
        throw new Error("edge evidence exceeds the remaining host temporary limit");
      }
      await writeFile(join(packageRoot, objectPath), objectBytes, { flag: "wx", mode: 0o600 });
      members.push({ path: objectPath, sha256: sha256(objectBytes), sizeBytes: objectBytes.length });
    }
  }

  return {
    evidence: {
      contractVersion: snapshot.contractVersion,
      frozenAt: snapshot.frozenAt,
      objectCount: seenObjects.size,
      receiptCount: seenReceipts.size,
      watermarkSha256: snapshot.watermarkSha256,
    },
    members,
  };
}

// stream a frozen edge snapshot without staging its object set
async function streamEdgeSnapshot(snapshotPath, archive, maximumPackageBytes) {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  requireExactKeys(snapshot, ["contractVersion", "entries", "frozenAt", "watermarkSha256"], "edge snapshot");

  // reject incomplete or unbounded snapshot identity
  if (snapshot.contractVersion !== EDGE_SNAPSHOT_VERSION ||
    !Number.isFinite(Date.parse(snapshot.frozenAt)) ||
    !HASH_PATTERN.test(snapshot.watermarkSha256) ||
    !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ROWS) {
    throw new Error("edge snapshot identity is invalid");
  }

  const members = [];
  const seenReceipts = new Set();
  const seenObjects = new Set();
  let packageBytes = 0;

  // stream every frozen pair while retaining only one pair in memory
  for (const entry of snapshot.entries) {
    requireExactKeys(entry, [
      "edgeReceiptIdentitySha256",
      "objectPath",
      "objectSha256",
      "receiptPath",
    ], "edge snapshot entry");
    if (!HASH_PATTERN.test(entry.edgeReceiptIdentitySha256) ||
      !HASH_PATTERN.test(entry.objectSha256) ||
      seenReceipts.has(entry.edgeReceiptIdentitySha256)) {
      throw new Error("edge snapshot entry identity is invalid");
    }
    seenReceipts.add(entry.edgeReceiptIdentitySha256);
    const receiptSource = resolve(entry.receiptPath);
    const objectSource = resolve(entry.objectPath);
    const sourceRoot = resolve(join(dirname(receiptSource), ".."));
    await requireSafeFile(receiptSource, join(sourceRoot, "receipts"), "edge receipt");
    await requireSafeFile(objectSource, join(sourceRoot, "objects"), "edge object");
    const receiptBytes = await readFile(receiptSource);
    const objectBytes = await readFile(objectSource);
    const objectPlaintext = gunzipSync(objectBytes, {
      maxOutputLength: Math.min(512 * 1024 + 1, objectBytes.length * MAX_RATIO + 1),
    });
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const object = JSON.parse(objectPlaintext.toString("utf8"));
    requireExactKeys(receipt, [
      "availability",
      "contractVersion",
      "edgeReceiptIdentitySha256",
      "firstEdgeCommittedAt",
      "objectSha256",
      "siteKey",
      "window",
    ], "edge receipt");
    requireExactKeys(receipt.availability, ["rowTimestampIndexes", "timestamps"], "edge receipt availability");

    // rebind the frozen names, canonical bytes, and receipt-to-object pair
    if (basename(receiptSource) !== `sha256-${entry.edgeReceiptIdentitySha256}.json` ||
      basename(objectSource) !== `sha256-${entry.objectSha256}.json.gz` ||
      receipt.edgeReceiptIdentitySha256 !== entry.edgeReceiptIdentitySha256 ||
      receipt.objectSha256 !== entry.objectSha256 || receipt.siteKey !== "ballydidean" ||
      !Number.isFinite(Date.parse(receipt.firstEdgeCommittedAt)) ||
      !Array.isArray(receipt.availability.timestamps) ||
      !Array.isArray(receipt.availability.rowTimestampIndexes) ||
      !Array.isArray(object.rows) ||
      receipt.availability.rowTimestampIndexes.length !== object.rows.length ||
      receipt.availability.timestamps.some((value) => !Number.isFinite(Date.parse(value))) ||
      receipt.availability.rowTimestampIndexes.some((index) =>
        !Number.isSafeInteger(index) || index < 0 ||
        index >= receipt.availability.timestamps.length) ||
      !Buffer.from(canonicalJson(receipt)).equals(receiptBytes) ||
      !Buffer.from(canonicalJsonValue(object)).equals(objectPlaintext) ||
      !gzipSync(objectPlaintext, { level: 9, mtime: 0 }).equals(objectBytes) ||
      objectPlaintext.length > objectBytes.length * MAX_RATIO ||
      sha256(objectPlaintext) !== entry.objectSha256) {
      throw new Error("edge snapshot bytes changed after freeze");
    }

    const receiptPath = `members/edge/receipts/${basename(receiptSource)}`;
    packageBytes += receiptBytes.length;
    if (packageBytes > maximumPackageBytes) {
      throw new Error("edge evidence exceeds the remaining package limit");
    }
    await writeTarBuffer(archive, receiptPath, receiptBytes);
    members.push({ path: receiptPath, sha256: sha256(receiptBytes), sizeBytes: receiptBytes.length });

    // emit each shared object once
    if (!seenObjects.has(entry.objectSha256)) {
      seenObjects.add(entry.objectSha256);
      const objectPath = `members/edge/objects/${basename(objectSource)}`;
      packageBytes += objectBytes.length;
      if (packageBytes > maximumPackageBytes) {
        throw new Error("edge evidence exceeds the remaining package limit");
      }
      await writeTarBuffer(archive, objectPath, objectBytes);
      members.push({ path: objectPath, sha256: sha256(objectBytes), sizeBytes: objectBytes.length });
    }
  }

  return {
    evidence: {
      contractVersion: snapshot.contractVersion,
      frozenAt: snapshot.frozenAt,
      objectCount: seenObjects.size,
      receiptCount: seenReceipts.size,
      watermarkSha256: snapshot.watermarkSha256,
    },
    members,
    packageBytes,
  };
}

// build one verified package directory from the database stream
export async function buildAdjustmentEvaluationPackage({
  edgeSnapshotPath,
  fromLocalDate,
  input = process.stdin,
  packageRoot,
  toLocalDate,
}) {
  validateDateRange(fromLocalDate, toLocalDate);
  await mkdir(join(packageRoot, "members/bodies"), { mode: 0o700, recursive: true });
  const rowsPath = join(packageRoot, "members/rows.jsonl.gz");
  const rowsOutput = createWriteStream(rowsPath, { flags: "wx", mode: 0o600 });
  const rowsGzip = createGzip({ level: 9, mtime: 0 });
  let rowsCompressedBytes = 0;
  const rowsCap = new Transform({
    // count the only non-body database temporary
    transform(chunk, encoding, callback) {
      rowsCompressedBytes += chunk.length;
      if (rowsCompressedBytes > MAX_OTHER_TEMP_BYTES) {
        callback(new Error("compressed row member exceeds the non-body temporary limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  const rowsPipeline = pipeline(rowsGzip, rowsCap, rowsOutput);
  void rowsPipeline.catch(() => undefined);
  let databaseManifest;
  let transaction;
  let canonicalBytes = 0;
  let compressedBodyBytes = 0;
  let rowCount = 0;
  let revisedRowCount = 0;
  let maxRevisionCount = 0;
  let maxSourceReceiptAt = null;
  const sourceIdentities = new Set();
  const bodyMembers = [];
  const seenBodies = new Set();
  let completed = false;

  try {

  // stream the fixed manifest followed by ordered rows
  for await (const line of databaseRecordLines(input)) {
    // reject blank or individually unbounded records
    if (line.length === 0) {
      throw new Error("database export record is empty or oversized");
    }
    const record = JSON.parse(line);
    requireObject(record, "database export record");

    // accept exactly one leading manifest
    if (record.record_type === "manifest") {
      requireExactKeys(record, ["payload", "record_type", "transaction"], "manifest record");
      if (databaseManifest !== undefined || rowCount !== 0) {
        throw new Error("database manifest must be the first and only manifest");
      }
      databaseManifest = validateDatabaseManifest(record.payload);
      transaction = validateTransaction(record.transaction, fromLocalDate, toLocalDate);
      continue;
    }

    requireExactKeys(record, ["payload", "record_type"], "row record");
    if (record.record_type !== "row" || databaseManifest === undefined) {
      throw new Error("database row is outside its manifest");
    }
    const row = validateRow(record.payload);
    rowCount += 1;

    // stop before accepting a row beyond the reviewed bound
    if (rowCount > MAX_ROWS) {
      throw new Error("database export exceeds the row limit");
    }

    let bodyMemberPath = null;
    // separate retained compressed bodies from canonical row JSON
    if (row.compressed_body_base64 !== null) {
      const body = Buffer.from(row.compressed_body_base64, "base64");
      const declaredBytes = row.payload.compressedBytes;
      const bodySha256 = row.payload.bodySha256;
      const declaredPlaintextBytes = row.payload.bodyBytes;
      if (!Number.isInteger(declaredBytes) || declaredBytes !== body.length ||
        !Number.isInteger(declaredPlaintextBytes) || declaredPlaintextBytes < 0 ||
        !HASH_PATTERN.test(bodySha256) || row.content_hash !== bodySha256) {
        throw new Error("rain receipt body metadata is invalid");
      }
      await validateCompressedBody(body, declaredPlaintextBytes, bodySha256);
      bodyMemberPath = `members/bodies/sha256-${bodySha256}.json.gz`;

      // copy each content-addressed provider body once
      if (!seenBodies.has(bodySha256)) {
        seenBodies.add(bodySha256);
        compressedBodyBytes += body.length;
        if (compressedBodyBytes > MAX_COMPRESSED_BODY_BYTES) {
          throw new Error("retained compressed bodies exceed the package limit");
        }
        await writeFile(join(packageRoot, bodyMemberPath), body, { flag: "wx", mode: 0o600 });
        bodyMembers.push({ path: bodyMemberPath, sha256: sha256(body), sizeBytes: body.length });
      }
    }

    const canonicalRow = {
      ...row,
      body_member_path: bodyMemberPath,
    };
    delete canonicalRow.compressed_body_base64;
    const encoded = canonicalJson(canonicalRow);
    canonicalBytes += Buffer.byteLength(encoded);

    // reject the stream before it can exceed its canonical budget
    if (canonicalBytes > MAX_CANONICAL_BYTES) {
      throw new Error("canonical database stream exceeds the package limit");
    }
    await writeChunk(rowsGzip, encoded);
    sourceIdentities.add(row.source_identity);
    revisedRowCount += row.revision_count > 0 ? 1 : 0;
    maxRevisionCount = Math.max(maxRevisionCount, row.revision_count);
    if (maxSourceReceiptAt === null || row.last_received_at > maxSourceReceiptAt) {
      maxSourceReceiptAt = row.last_received_at;
    }
  }

  // require a complete transaction even when it contains no rows
  if (databaseManifest === undefined || transaction === undefined) {
    throw new Error("database export manifest is missing");
  }
  await finishStream(rowsGzip);
  await rowsPipeline;
  const rowsBytes = await readFile(rowsPath);
  const databaseTemporaryBytes = rowsBytes.length + bodyMembers.reduce(
    (total, member) => total + member.sizeBytes,
    0,
  );
  if (databaseTemporaryBytes > MAX_TEMP_BYTES) {
    throw new Error("database members exceed the host temporary limit");
  }
  const edge = await copyEdgeSnapshot(
    edgeSnapshotPath,
    packageRoot,
    MAX_TEMP_BYTES - databaseTemporaryBytes,
  );
  const members = [
    { path: "members/rows.jsonl.gz", sha256: sha256(rowsBytes), sizeBytes: rowsBytes.length },
    ...bodyMembers,
    ...edge.members,
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const temporaryBytes = members.reduce((total, member) => total + member.sizeBytes, 0);

  // enforce total simultaneous package allocation
  if (temporaryBytes > MAX_TEMP_BYTES) {
    throw new Error("package members exceed the host temporary limit");
  }

  const manifest = {
    canonicalStreamBytes: canonicalBytes,
    compressedBodyBytes,
    contractVersion: PACKAGE_VERSION,
    databaseManifest,
    edgeEvidence: edge.evidence,
    fromLocalDate,
    limits: {
      maxArchiveBytes: MAX_ARCHIVE_BYTES,
      maxCanonicalStreamBytes: MAX_CANONICAL_BYTES,
      maxCompressedBodyBytes: MAX_COMPRESSED_BODY_BYTES,
      maxDays: MAX_DAYS,
      maxDecompressionRatio: MAX_RATIO,
      maxOtherSimultaneousTemporaryBytes: MAX_OTHER_TEMP_BYTES,
      maxRows: MAX_ROWS,
      maxSimultaneousHostTemporaryBytes: MAX_TEMP_BYTES,
    },
    maxSourceReceiptAt,
    members,
    revisionDiagnostics: {
      maxRevisionCount,
      revisedRowCount,
      rowCount,
    },
    siteKey: "ballydidean",
    siteTimezone: "America/Los_Angeles",
    sourceIdentities: [...sourceIdentities].sort(),
    toLocalDate,
    transaction: {
      createdAtUtc: transaction.created_at_utc,
      idleInTransactionSessionTimeout: transaction.idle_in_transaction_session_timeout,
      isolationLevel: transaction.isolation_level,
      lockTimeout: transaction.lock_timeout,
      readOnly: transaction.read_only,
      statementTimeout: transaction.statement_timeout,
    },
  };
  const manifestBytes = canonicalJson(manifest);
  const manifestSha256 = sha256(manifestBytes);
  await writeFile(join(packageRoot, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(packageRoot, "manifest.sha256"), `${manifestSha256}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  completed = true;
  return manifestSha256;
  } finally {
    // remove every partial package after validation or streaming failure
    if (!completed) {
      rowsGzip.destroy();
      rowsOutput.destroy();
      await rm(packageRoot, { force: true, recursive: true });
    }
  }
}

// stream one verified archive while staging only its compressed row member
export async function streamAdjustmentEvaluationPackageArchive({
  edgeSnapshotPath,
  fromLocalDate,
  input = process.stdin,
  output = process.stdout,
  temporaryRoot,
  toLocalDate,
}) {
  validateDateRange(fromLocalDate, toLocalDate);
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const rowsPath = join(canonicalTemporaryRoot, "rows.jsonl.gz");
  const allocationBeforeRows = allocatedBytesBelow(canonicalTemporaryRoot);
  const filesystemBlockBytes = statfsSync(canonicalTemporaryRoot).bsize;

  // leave room for filesystem block rounding
  const rowsTemporaryLimit = MAX_OTHER_TEMP_BYTES - allocationBeforeRows -
    (filesystemBlockBytes - 1);
  if (rowsTemporaryLimit < 0) {
    throw new Error("export non-archive temporary allocation exceeds its limit");
  }

  const rowsOutput = createWriteStream(rowsPath, { flags: "wx", mode: 0o600 });
  const rowsGzip = createGzip({ level: 9, mtime: 0 });
  let rowsCompressedBytes = 0;
  const rowsCap = new Transform({
    // stop the only staged member before the fixed temp budget
    transform(chunk, encoding, callback) {
      rowsCompressedBytes += chunk.length;
      if (rowsCompressedBytes > rowsTemporaryLimit) {
        callback(new Error("compressed row member exceeds the non-archive temporary limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  const rowsPipeline = pipeline(rowsGzip, rowsCap, rowsOutput);
  void rowsPipeline.catch(() => undefined);
  const archiveGzip = createGzip({ level: 9, mtime: 0 });
  let archiveBytes = 0;
  const archiveCap = new Transform({
    // stop egress at the reviewed archive boundary
    transform(chunk, encoding, callback) {
      archiveBytes += chunk.length;
      if (archiveBytes > MAX_ARCHIVE_BYTES) {
        callback(new Error("compressed archive exceeds the package limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  const archivePipeline = pipeline(archiveGzip, archiveCap, output);
  void archivePipeline.catch(() => undefined);
  let databaseManifest;
  let transaction;
  let canonicalBytes = 0;
  let compressedBodyBytes = 0;
  let packageMemberBytes = 0;
  let rowCount = 0;
  let revisedRowCount = 0;
  let maxRevisionCount = 0;
  let maxSourceReceiptAt = null;
  const sourceIdentities = new Set();
  const bodyMembers = [];
  const seenBodies = new Set();
  let completed = false;

  try {
    // consume one manifest followed by bounded ordered rows
    for await (const line of databaseRecordLines(input)) {
      // reject blank or individually unbounded records
      if (line.length === 0) {
        throw new Error("database export record is empty or oversized");
      }
      const record = JSON.parse(line);
      requireObject(record, "database export record");

      // accept exactly one leading manifest
      if (record.record_type === "manifest") {
        requireExactKeys(record, ["payload", "record_type", "transaction"], "manifest record");
        if (databaseManifest !== undefined || rowCount !== 0) {
          throw new Error("database manifest must be the first and only manifest");
        }
        databaseManifest = validateDatabaseManifest(record.payload);
        transaction = validateTransaction(record.transaction, fromLocalDate, toLocalDate);
        continue;
      }

      requireExactKeys(record, ["payload", "record_type"], "row record");
      if (record.record_type !== "row" || databaseManifest === undefined) {
        throw new Error("database row is outside its manifest");
      }
      const row = validateRow(record.payload);
      rowCount += 1;

      // stop before accepting a row beyond the reviewed bound
      if (rowCount > MAX_ROWS) {
        throw new Error("database export exceeds the row limit");
      }

      let bodyMemberPath = null;

      // stream retained bodies directly into the archive
      if (row.compressed_body_base64 !== null) {
        const normalizedBase64 = row.compressed_body_base64.replaceAll("\n", "");
        const body = Buffer.from(normalizedBase64, "base64");
        const declaredBytes = row.payload.compressedBytes;
        const bodySha256 = row.payload.bodySha256;
        const declaredPlaintextBytes = row.payload.bodyBytes;
        if (!Number.isInteger(declaredBytes) || declaredBytes !== body.length ||
          !Number.isInteger(declaredPlaintextBytes) || declaredPlaintextBytes < 0 ||
          !HASH_PATTERN.test(bodySha256) || row.content_hash !== bodySha256 ||
          !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalizedBase64) ||
          body.toString("base64") !== normalizedBase64) {
          throw new Error("rain receipt body metadata is invalid");
        }
        await validateCompressedBody(body, declaredPlaintextBytes, bodySha256);
        bodyMemberPath = `members/bodies/sha256-${bodySha256}.json.gz`;

        // emit each content-addressed provider body once
        if (!seenBodies.has(bodySha256)) {
          seenBodies.add(bodySha256);
          compressedBodyBytes += body.length;
          packageMemberBytes += body.length;
          if (compressedBodyBytes > MAX_COMPRESSED_BODY_BYTES ||
            packageMemberBytes > MAX_TEMP_BYTES) {
            throw new Error("retained compressed bodies exceed the package limit");
          }
          await writeTarBuffer(archiveGzip, bodyMemberPath, body);
          bodyMembers.push({
            path: bodyMemberPath,
            sha256: sha256(body),
            sizeBytes: body.length,
          });
        }
      }

      const canonicalRow = { ...row, body_member_path: bodyMemberPath };
      delete canonicalRow.compressed_body_base64;
      const encoded = canonicalJson(canonicalRow);
      canonicalBytes += Buffer.byteLength(encoded);

      // reject the logical stream before it exceeds its fixed cap
      if (canonicalBytes > MAX_CANONICAL_BYTES) {
        throw new Error("canonical database stream exceeds the package limit");
      }
      await writeChunk(rowsGzip, encoded);
      sourceIdentities.add(row.source_identity);
      revisedRowCount += row.revision_count > 0 ? 1 : 0;
      maxRevisionCount = Math.max(maxRevisionCount, row.revision_count);
      if (maxSourceReceiptAt === null || row.last_received_at > maxSourceReceiptAt) {
        maxSourceReceiptAt = row.last_received_at;
      }
    }

    // require a complete database transaction envelope
    if (databaseManifest === undefined || transaction === undefined) {
      throw new Error("database export manifest is missing");
    }
    await finishStream(rowsGzip);
    await rowsPipeline;
    if (allocatedBytesBelow(canonicalTemporaryRoot) > MAX_OTHER_TEMP_BYTES) {
      throw new Error("export non-archive temporary allocation exceeds its limit");
    }
    const rowsSize = statSync(rowsPath).size;
    packageMemberBytes += rowsSize;
    if (packageMemberBytes > MAX_TEMP_BYTES) {
      throw new Error("database members exceed the package limit");
    }
    const edge = await streamEdgeSnapshot(
      edgeSnapshotPath,
      archiveGzip,
      MAX_TEMP_BYTES - packageMemberBytes,
    );
    packageMemberBytes += edge.packageBytes;
    const rowsMember = {
      path: "members/rows.jsonl.gz",
      sha256: await sha256File(rowsPath),
      sizeBytes: rowsSize,
    };
    await writeTarFile(archiveGzip, rowsMember.path, rowsPath, rowsSize);
    const members = [rowsMember, ...bodyMembers, ...edge.members]
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const manifest = {
      canonicalStreamBytes: canonicalBytes,
      compressedBodyBytes,
      contractVersion: PACKAGE_VERSION,
      databaseManifest,
      edgeEvidence: edge.evidence,
      fromLocalDate,
      limits: {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxCanonicalStreamBytes: MAX_CANONICAL_BYTES,
        maxCompressedBodyBytes: MAX_COMPRESSED_BODY_BYTES,
        maxDays: MAX_DAYS,
        maxDecompressionRatio: MAX_RATIO,
        maxOtherSimultaneousTemporaryBytes: MAX_OTHER_TEMP_BYTES,
        maxRows: MAX_ROWS,
        maxSimultaneousHostTemporaryBytes: MAX_TEMP_BYTES,
      },
      maxSourceReceiptAt,
      members,
      revisionDiagnostics: { maxRevisionCount, revisedRowCount, rowCount },
      siteKey: "ballydidean",
      siteTimezone: "America/Los_Angeles",
      sourceIdentities: [...sourceIdentities].sort(),
      toLocalDate,
      transaction: {
        createdAtUtc: transaction.created_at_utc,
        idleInTransactionSessionTimeout: transaction.idle_in_transaction_session_timeout,
        isolationLevel: transaction.isolation_level,
        lockTimeout: transaction.lock_timeout,
        readOnly: transaction.read_only,
        statementTimeout: transaction.statement_timeout,
      },
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    const manifestSha256 = sha256(manifestBytes);
    const manifestHashBytes = Buffer.from(`${manifestSha256}\n`);

    // include manifest overhead in the extracted-package cap
    if (packageMemberBytes + manifestBytes.length + manifestHashBytes.length > MAX_TEMP_BYTES) {
      throw new Error("package members exceed the extracted package limit");
    }
    await writeTarBuffer(archiveGzip, "manifest.json", manifestBytes);
    await writeTarBuffer(archiveGzip, "manifest.sha256", manifestHashBytes);
    await writeChunk(archiveGzip, Buffer.alloc(TAR_BLOCK_BYTES * 2));
    await finishStream(archiveGzip);
    await archivePipeline;
    completed = true;
    return manifestSha256;
  } finally {
    // close failed pipelines and remove only the staged row member
    if (!completed) {
      rowsGzip.destroy();
      rowsOutput.destroy();
      archiveGzip.destroy();
      archiveCap.destroy();
    }
    await Promise.allSettled([rowsPipeline, archivePipeline]);
    await rm(rowsPath, { force: true });
  }
}

// enumerate every regular package file
function listPackageFiles(root) {
  const files = [];

  // recurse through fixed package directories
  function visit(path) {
    // reject symbolic and special entries
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) {
        throw new Error("package contains a symbolic link");
      }
      if (metadata.isDirectory()) {
        visit(child);
      } else if (metadata.isFile()) {
        files.push(relative(root, child));
      } else {
        throw new Error("package contains a special file");
      }
    }
  }

  visit(root);
  return files.sort();
}

// read one stable no-follow control file inside a fixed byte bound
async function readNoFollowBoundedFile(path, maximumBytes, description) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const before = await handle.stat({ bigint: true });

    // reject special and oversized control files before allocation
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw new Error(`${description} is not a bounded regular file`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;

    // fill only the allocation proven by the opened descriptor
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);

      // reject an unexpected early end
      if (read.bytesRead === 0) {
        break;
      }
      offset += read.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, offset);
    const after = await handle.stat({ bigint: true });

    // reject replacement or mutation during the bounded read
    if (offset !== bytes.length || extra.bytesRead !== 0 ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${description} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

// validate one package manifest and its fixed contracts
async function readPackageManifest(packageRoot) {
  const manifestBytes = await readNoFollowBoundedFile(
    join(packageRoot, "manifest.json"),
    MAX_OTHER_TEMP_BYTES,
    "package manifest",
  );
  const hashBytes = await readNoFollowBoundedFile(
    join(packageRoot, "manifest.sha256"),
    65,
    "package manifest hash",
  );
  const recordedHash = hashBytes.toString("utf8").trim();
  const manifestHash = sha256(manifestBytes);

  // reject mutable or malformed manifest identity
  if (!HASH_PATTERN.test(recordedHash) || recordedHash !== manifestHash) {
    throw new Error("package manifest hash differs");
  }
  const manifest = JSON.parse(manifestBytes);
  requireExactKeys(manifest, [
    "canonicalStreamBytes",
    "compressedBodyBytes",
    "contractVersion",
    "databaseManifest",
    "edgeEvidence",
    "fromLocalDate",
    "limits",
    "maxSourceReceiptAt",
    "members",
    "revisionDiagnostics",
    "siteKey",
    "siteTimezone",
    "sourceIdentities",
    "toLocalDate",
    "transaction",
  ], "package manifest");

  // bind the immutable package contract
  if (manifest.contractVersion !== PACKAGE_VERSION || manifest.siteKey !== "ballydidean" ||
    manifest.siteTimezone !== "America/Los_Angeles") {
    throw new Error("package manifest contract is invalid");
  }
  requireExactKeys(manifest.limits, [
    "maxArchiveBytes",
    "maxCanonicalStreamBytes",
    "maxCompressedBodyBytes",
    "maxDays",
    "maxDecompressionRatio",
    "maxOtherSimultaneousTemporaryBytes",
    "maxRows",
    "maxSimultaneousHostTemporaryBytes",
  ], "package limits");

  // bind every published resource limit
  if (manifest.limits.maxArchiveBytes !== MAX_ARCHIVE_BYTES ||
    manifest.limits.maxCanonicalStreamBytes !== MAX_CANONICAL_BYTES ||
    manifest.limits.maxCompressedBodyBytes !== MAX_COMPRESSED_BODY_BYTES ||
    manifest.limits.maxDays !== MAX_DAYS ||
    manifest.limits.maxDecompressionRatio !== MAX_RATIO ||
    manifest.limits.maxOtherSimultaneousTemporaryBytes !== MAX_OTHER_TEMP_BYTES ||
    manifest.limits.maxRows !== MAX_ROWS ||
    manifest.limits.maxSimultaneousHostTemporaryBytes !== MAX_TEMP_BYTES ||
    !Number.isInteger(manifest.canonicalStreamBytes) ||
    manifest.canonicalStreamBytes < 0 || manifest.canonicalStreamBytes > MAX_CANONICAL_BYTES ||
    !Number.isInteger(manifest.compressedBodyBytes) ||
    manifest.compressedBodyBytes < 0 ||
    manifest.compressedBodyBytes > MAX_COMPRESSED_BODY_BYTES) {
    throw new Error("package limits are invalid");
  }
  requireExactKeys(manifest.edgeEvidence, [
    "contractVersion",
    "frozenAt",
    "objectCount",
    "receiptCount",
    "watermarkSha256",
  ], "edge evidence");

  // validate the frozen edge summary
  if (manifest.edgeEvidence.contractVersion !== EDGE_SNAPSHOT_VERSION ||
    !Number.isFinite(Date.parse(manifest.edgeEvidence.frozenAt)) ||
    !HASH_PATTERN.test(manifest.edgeEvidence.watermarkSha256) ||
    !Number.isInteger(manifest.edgeEvidence.objectCount) ||
    !Number.isInteger(manifest.edgeEvidence.receiptCount) ||
    manifest.edgeEvidence.objectCount < 0 || manifest.edgeEvidence.receiptCount < 0) {
    throw new Error("edge evidence identity is invalid");
  }
  requireExactKeys(manifest.revisionDiagnostics, [
    "maxRevisionCount",
    "revisedRowCount",
    "rowCount",
  ], "revision diagnostics");

  // validate the bounded row summary
  if (!Number.isInteger(manifest.revisionDiagnostics.maxRevisionCount) ||
    !Number.isInteger(manifest.revisionDiagnostics.revisedRowCount) ||
    !Number.isInteger(manifest.revisionDiagnostics.rowCount) ||
    manifest.revisionDiagnostics.maxRevisionCount < 0 ||
    manifest.revisionDiagnostics.revisedRowCount < 0 ||
    manifest.revisionDiagnostics.rowCount < 0 ||
    manifest.revisionDiagnostics.rowCount > MAX_ROWS ||
    manifest.revisionDiagnostics.revisedRowCount > manifest.revisionDiagnostics.rowCount) {
    throw new Error("revision diagnostics are invalid");
  }
  requireExactKeys(manifest.transaction, [
    "createdAtUtc",
    "idleInTransactionSessionTimeout",
    "isolationLevel",
    "lockTimeout",
    "readOnly",
    "statementTimeout",
  ], "package transaction");

  // validate the exported transaction and bounded identities
  if (!Number.isFinite(Date.parse(manifest.transaction.createdAtUtc)) ||
    manifest.transaction.isolationLevel !== "repeatable read" ||
    manifest.transaction.readOnly !== "on" ||
    manifest.transaction.statementTimeout !== "5min" ||
    manifest.transaction.lockTimeout !== "5s" ||
    manifest.transaction.idleInTransactionSessionTimeout !== "30s" ||
    (manifest.maxSourceReceiptAt !== null &&
      !Number.isFinite(Date.parse(manifest.maxSourceReceiptAt))) ||
    !Array.isArray(manifest.members) || !Array.isArray(manifest.sourceIdentities) ||
    manifest.sourceIdentities.some((identity) =>
      typeof identity !== "string" || identity.length > 256)) {
    throw new Error("package transaction or source identities are invalid");
  }
  validateDateRange(manifest.fromLocalDate, manifest.toLocalDate);
  validateDatabaseManifest(manifest.databaseManifest);
  return { manifest, manifestBytes, manifestHash };
}

// validate declared paths before opening any package member
function validatePackageMemberDeclarations(packageRoot, manifest) {
  const expectedFiles = new Set(["manifest.json", "manifest.sha256"]);
  const membersByPath = new Map();
  let memberBytes = 0;

  // validate every immutable member declaration
  for (const member of manifest.members) {
    requireExactKeys(member, ["path", "sha256", "sizeBytes"], "package member");
    if (member.path !== "members/rows.jsonl.gz" &&
      !/^members\/bodies\/sha256-[a-f0-9]{64}\.json\.gz$/u.test(member.path) &&
      !/^members\/edge\/objects\/sha256-[a-f0-9]{64}\.json\.gz$/u.test(member.path) &&
      !/^members\/edge\/receipts\/sha256-[a-f0-9]{64}\.json$/u.test(member.path)) {
      throw new Error("package member path is invalid");
    }

    // reject duplicate, escaping, and malformed identities
    if (member.path.includes("..") ||
      !HASH_PATTERN.test(member.sha256) || !Number.isInteger(member.sizeBytes) ||
      member.sizeBytes < 0 || expectedFiles.has(member.path)) {
      throw new Error("package member identity is invalid");
    }
    expectedFiles.add(member.path);
    membersByPath.set(member.path, member);
    memberBytes += member.sizeBytes;
  }

  // enforce the complete extracted allocation
  if (memberBytes > MAX_TEMP_BYTES) {
    throw new Error("package member allocation exceeds the host temporary limit");
  }
  const actualFiles = listPackageFiles(packageRoot);

  // reject undeclared members and archive additions
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error("package contains undeclared files");
  }
  return { memberBytes, membersByPath };
}

// consume one stable member while hashing the exact opened byte stream
async function consumeVerifiedMember(packageRoot, member, consume) {
  const path = join(packageRoot, member.path);
  await requireSafeFile(path, packageRoot, "package member");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  let source;
  let verifier;

  try {
    const before = await handle.stat({ bigint: true });

    // bind the opened regular file before consumption
    if (!before.isFile() || before.size !== BigInt(member.sizeBytes)) {
      throw new Error("package member bytes differ");
    }
    verifier = new Transform({
      // bind byte count and digest before forwarding
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > member.sizeBytes) {
          callback(new Error("package member bytes differ"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    source = handle.createReadStream({ autoClose: false });
    source.once("error", (error) => verifier.destroy(error));
    source.pipe(verifier);
    const result = await consume(verifier);
    const after = await handle.stat({ bigint: true });

    // reject content changes and identity replacement during consumption
    if (bytes !== member.sizeBytes || hash.digest("hex") !== member.sha256 ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) {
      throw new Error("package member bytes differ");
    }
    return result;
  } finally {
    source?.destroy();
    verifier?.destroy();
    await handle.close();
  }
}

// read one already-bounded member after binding its stream identity
async function readVerifiedMember(packageRoot, member, maximumBytes) {
  if (member.sizeBytes > maximumBytes) {
    throw new Error("package member exceeds its fixed size limit");
  }
  return consumeVerifiedMember(packageRoot, member, async (stream) => {
    const chunks = [];

    // retain only the caller's fixed member bound
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, member.sizeBytes);
  });
}

// drain one member whose identity is sufficient
async function verifyMemberIdentity(packageRoot, member) {
  await consumeVerifiedMember(packageRoot, member, async (stream) => {
    // hash the complete bounded member without retaining it
    for await (const _chunk of stream) {
      // consume only
    }
  });
}

// validate one canonical packaged database row
function validatePackagedRow(line) {
  const packagedRow = JSON.parse(line);
  requireExactKeys(packagedRow, [
    "body_member_path",
    "content_hash",
    "first_received_at",
    "last_received_at",
    "local_date",
    "payload",
    "record_kind",
    "record_revision_identity",
    "reference_at",
    "revision_count",
    "site_key",
    "source_identity",
    "valid_at",
  ], "packaged export row");

  // require the canonical row bytes emitted by the builder
  if (canonicalJson(packagedRow) !== `${line}\n`) {
    throw new Error("packaged export row is not canonical");
  }
  const { body_member_path: bodyMemberPath, ...rawRow } = packagedRow;
  const validated = validateRow({ ...rawRow, compressed_body_base64: null });

  // bind the optional body path to a rain receipt
  if (bodyMemberPath !== null &&
    !/^members\/bodies\/sha256-[a-f0-9]{64}\.json\.gz$/u.test(bodyMemberPath)) {
    throw new Error("packaged export row body path is invalid");
  }
  if ((validated.record_kind === "rain_receipt" &&
    validated.payload.compressedBytes !== null) !== (bodyMemberPath !== null)) {
    throw new Error("packaged export row body binding is invalid");
  }
  return { ...validated, body_member_path: bodyMemberPath };
}

// validate one edge object and return its stable receipt binding
async function verifyEdgeObject(packageRoot, member, expectedSha256) {
  const objectBytes = await readVerifiedMember(packageRoot, member, 16 * 1024);
  const objectPlaintext = gunzipSync(objectBytes, { maxOutputLength: 512 * 1024 + 1 });
  const object = JSON.parse(objectPlaintext.toString("utf8"));
  requireExactKeys(object, [
    "bundleIdentities",
    "contractVersion",
    "rows",
    "settingsSha256",
    "siteKey",
    "window",
  ], "edge object");

  // bind deterministic canonical object bytes and plaintext identity
  if (object.contractVersion !== EDGE_OBJECT_VERSION ||
    !Array.isArray(object.rows) || object.rows.length < 1 || object.rows.length > 240 ||
    !HASH_PATTERN.test(object.settingsSha256) || object.siteKey !== "ballydidean" ||
    !EDGE_WINDOWS.has(object.window) ||
    objectPlaintext.length > objectBytes.length * MAX_RATIO ||
    !Buffer.from(canonicalJsonValue(object)).equals(objectPlaintext) ||
    !gzipSync(objectPlaintext, { level: 9, mtime: 0 }).equals(objectBytes) ||
    sha256(objectPlaintext) !== expectedSha256) {
    throw new Error("edge object bytes differ");
  }
  const stableRows = object.rows.map((row) => {
    requireObject(row, "edge object row");
    requireObject(row.record, "edge object row record");
    requireObject(row.source, "edge object row source");
    return { record: row.record, source: row.source };
  });
  return {
    rowCount: object.rows.length,
    stableIdentitySha256: sha256(canonicalJsonValue({
      bundleIdentities: object.bundleIdentities,
      rows: stableRows,
      settingsSha256: object.settingsSha256,
      siteKey: object.siteKey,
      window: object.window,
    })),
    window: object.window,
  };
}

// stream-verify one package for bounded local publication
export async function verifyAdjustmentEvaluationPackage(packageRoot) {
  const firstManifest = await readPackageManifest(packageRoot);
  const { manifest, manifestHash } = firstManifest;
  const { membersByPath } = validatePackageMemberDeclarations(packageRoot, manifest);
  const rowsMember = membersByPath.get("members/rows.jsonl.gz");

  // require exactly one canonical row stream
  if (rowsMember === undefined) {
    throw new Error("package row member is missing");
  }
  const verifiedMembers = new Set();
  const verifiedBodies = new Map();
  const sourceIdentities = new Set();
  let canonicalBytes = 0;
  let maxRevisionCount = 0;
  let maxSourceReceiptAt = null;
  let revisedRowCount = 0;
  let rowCount = 0;
  let rowsLastByte = null;

  await consumeVerifiedMember(packageRoot, rowsMember, async (compressedRows) => {
    const decodedRows = new PassThrough();
    const decodedCap = new Transform({
      // cap decoded rows before line accumulation
      transform(chunk, encoding, callback) {
        canonicalBytes += chunk.length;
        rowsLastByte = chunk.length === 0 ? rowsLastByte : chunk[chunk.length - 1];
        if (canonicalBytes > MAX_CANONICAL_BYTES ||
          canonicalBytes > rowsMember.sizeBytes * MAX_RATIO) {
          callback(new Error("package row member exceeds the decompression limit"));
          return;
        }
        callback(null, chunk);
      },
    });
    const decompression = pipeline(compressedRows, createGunzip(), decodedCap, decodedRows);
    void decompression.catch(() => undefined);

    try {
      // validate each row and its body before pulling the next row
      for await (const line of databaseRecordLines(decodedRows)) {
        if (line.length === 0) {
          throw new Error("package row member contains an empty record");
        }
        const row = validatePackagedRow(line);
        rowCount += 1;

        // enforce the reviewed row bound during streaming
        if (rowCount > MAX_ROWS) {
          throw new Error("package row count exceeds its limit");
        }
        sourceIdentities.add(row.source_identity);
        revisedRowCount += row.revision_count > 0 ? 1 : 0;
        maxRevisionCount = Math.max(maxRevisionCount, row.revision_count);
        if (maxSourceReceiptAt === null || row.last_received_at > maxSourceReceiptAt) {
          maxSourceReceiptAt = row.last_received_at;
        }

        // validate each distinct retained body once
        if (row.body_member_path !== null) {
          const bodyMember = membersByPath.get(row.body_member_path);
          const binding = `${row.payload.bodyBytes}:${row.payload.bodySha256}:` +
            `${row.payload.compressedBytes}`;
          if (bodyMember === undefined ||
            bodyMember.sizeBytes !== row.payload.compressedBytes ||
            row.body_member_path !==
              `members/bodies/sha256-${row.payload.bodySha256}.json.gz`) {
            throw new Error("packaged export row body member is missing");
          }
          const priorBinding = verifiedBodies.get(row.body_member_path);
          if (priorBinding !== undefined && priorBinding !== binding) {
            throw new Error("packaged export row body binding differs");
          }

          // verify only the first row bound to shared content
          if (priorBinding === undefined) {
            await consumeVerifiedMember(packageRoot, bodyMember, async (bodyStream) => {
              await validateCompressedBodyStream(
                bodyStream,
                bodyMember.sizeBytes,
                row.payload.bodyBytes,
                row.payload.bodySha256,
              );
            });
            verifiedBodies.set(row.body_member_path, binding);
            verifiedMembers.add(row.body_member_path);
          }
        }
      }
      await decompression;
    } finally {
      decodedRows.destroy();
      decodedCap.destroy();
      await Promise.allSettled([decompression]);
    }
  });
  verifiedMembers.add(rowsMember.path);

  // require the exact row stream and aggregate identities
  if ((canonicalBytes > 0 && rowsLastByte !== 0x0a) ||
    canonicalBytes !== manifest.canonicalStreamBytes ||
    rowCount !== manifest.revisionDiagnostics.rowCount ||
    revisedRowCount !== manifest.revisionDiagnostics.revisedRowCount ||
    maxRevisionCount !== manifest.revisionDiagnostics.maxRevisionCount ||
    maxSourceReceiptAt !== manifest.maxSourceReceiptAt ||
    JSON.stringify([...sourceIdentities].sort()) !== JSON.stringify(manifest.sourceIdentities)) {
    throw new Error("package row diagnostics differ");
  }

  const bodyMembers = manifest.members.filter((member) =>
    member.path.startsWith("members/bodies/"));
  const compressedBodyBytes = bodyMembers.reduce((total, member) => total + member.sizeBytes, 0);

  // bind the complete body member allocation
  if (compressedBodyBytes !== manifest.compressedBodyBytes) {
    throw new Error("package compressed body allocation differs");
  }

  // hash any declared body not referenced by a row
  for (const bodyMember of bodyMembers) {
    if (!verifiedMembers.has(bodyMember.path)) {
      await verifyMemberIdentity(packageRoot, bodyMember);
      verifiedMembers.add(bodyMember.path);
    }
  }

  const objectMembers = manifest.members.filter((member) =>
    member.path.startsWith("members/edge/objects/"));
  const receiptMembers = manifest.members.filter((member) =>
    member.path.startsWith("members/edge/receipts/"));

  // bind edge member counts before pair validation
  if (objectMembers.length !== manifest.edgeEvidence.objectCount ||
    receiptMembers.length !== manifest.edgeEvidence.receiptCount) {
    throw new Error("edge evidence member counts differ");
  }
  const validatedObjects = new Map();
  const watermarkPairs = [];

  // validate each receipt and its referenced object pair
  for (const receiptMember of receiptMembers) {
    const receiptBytes = await readVerifiedMember(packageRoot, receiptMember, 16 * 1024);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    requireExactKeys(receipt, [
      "availability",
      "contractVersion",
      "edgeReceiptIdentitySha256",
      "firstEdgeCommittedAt",
      "objectSha256",
      "siteKey",
      "window",
    ], "edge receipt");
    requireExactKeys(receipt.availability, [
      "rowTimestampIndexes",
      "timestamps",
    ], "edge receipt availability");
    const receiptIdentity = basename(receiptMember.path).slice(7, -5);
    const objectPath = `members/edge/objects/sha256-${receipt.objectSha256}.json.gz`;
    const objectMember = membersByPath.get(objectPath);

    // bind canonical receipt bytes and pair identity
    if (receipt.contractVersion !== EDGE_RECEIPT_VERSION ||
      receipt.edgeReceiptIdentitySha256 !== receiptIdentity ||
      !HASH_PATTERN.test(receipt.objectSha256) || receipt.siteKey !== "ballydidean" ||
      !EDGE_WINDOWS.has(receipt.window) ||
      !Number.isFinite(Date.parse(receipt.firstEdgeCommittedAt)) ||
      !Array.isArray(receipt.availability.timestamps) ||
      !Array.isArray(receipt.availability.rowTimestampIndexes) ||
      receipt.availability.timestamps.some((value) => !Number.isFinite(Date.parse(value))) ||
      !Buffer.from(canonicalJson(receipt)).equals(receiptBytes) ||
      objectMember === undefined) {
      throw new Error("edge receipt identity is invalid");
    }
    let objectIdentity;

    // validate each shared edge object once
    if (!validatedObjects.has(objectPath)) {
      objectIdentity = await verifyEdgeObject(
        packageRoot,
        objectMember,
        receipt.objectSha256,
      );
      validatedObjects.set(objectPath, objectIdentity);
      verifiedMembers.add(objectPath);
    } else {
      objectIdentity = validatedObjects.get(objectPath);
    }

    // bind stable identity, window, and every availability index
    if (receipt.edgeReceiptIdentitySha256 !== objectIdentity.stableIdentitySha256 ||
      receipt.window !== objectIdentity.window ||
      receipt.availability.rowTimestampIndexes.length !== objectIdentity.rowCount ||
      receipt.availability.rowTimestampIndexes.some((index) =>
        !Number.isSafeInteger(index) || index < 0 ||
        index >= receipt.availability.timestamps.length)) {
      throw new Error("edge receipt availability is invalid");
    }
    watermarkPairs.push({
      edgeReceiptIdentitySha256: receipt.edgeReceiptIdentitySha256,
      objectSha256: receipt.objectSha256,
    });
    verifiedMembers.add(receiptMember.path);
  }

  // rebind the portable freeze watermark from ordered receipt pairs
  if (sha256(canonicalJsonValue(watermarkPairs)) !== manifest.edgeEvidence.watermarkSha256) {
    throw new Error("edge evidence watermark differs");
  }

  // validate any declared object not referenced by a receipt
  for (const objectMember of objectMembers) {
    if (!verifiedMembers.has(objectMember.path)) {
      const expectedSha256 = basename(objectMember.path).slice(7, -8);
      await verifyEdgeObject(packageRoot, objectMember, expectedSha256);
      verifiedMembers.add(objectMember.path);
    }
  }

  // require every declared member to be covered by strict verification
  if (verifiedMembers.size !== manifest.members.length) {
    throw new Error("package contains an unverified member");
  }
  const finalManifest = await readPackageManifest(packageRoot);

  // reject manifest replacement during member verification
  if (finalManifest.manifestHash !== manifestHash ||
    !finalManifest.manifestBytes.equals(firstManifest.manifestBytes)) {
    throw new Error("package manifest changed during verification");
  }
  return { manifest, manifestSha256: manifestHash };
}

// verify and decode one local package directory
export async function loadVerifiedAdjustmentEvaluationPackage(packageRoot) {
  const strict = await verifyAdjustmentEvaluationPackage(packageRoot);
  const { manifest, manifestSha256: manifestHash } = strict;
  const membersByPath = new Map(manifest.members.map((member) => [member.path, member]));
  const rowsMember = manifest.members.find((member) => member.path === "members/rows.jsonl.gz");
  if (rowsMember === undefined) {
    throw new Error("package row member is missing");
  }
  const rowsBytes = await readFile(join(packageRoot, rowsMember.path));

  // rebind the materialized row bytes to the strict manifest
  if (rowsBytes.length !== rowsMember.sizeBytes || sha256(rowsBytes) !== rowsMember.sha256) {
    throw new Error("package member bytes differ");
  }
  const decodedRows = gunzipSync(rowsBytes, {
    maxOutputLength: MAX_CANONICAL_BYTES + 1,
  }).toString("utf8");
  if (Buffer.byteLength(decodedRows) > rowsMember.sizeBytes * MAX_RATIO) {
    throw new Error("package row member exceeds the decompression ratio");
  }
  const rows = decodedRows === ""
    ? []
    : decodedRows.trimEnd().split("\n").map(validatePackagedRow);
  if (rows.length !== manifest.revisionDiagnostics.rowCount) {
    throw new Error("package row count differs");
  }

  const bodies = Object.fromEntries(
    manifest.members
      .filter((member) => member.path.startsWith("members/bodies/"))
      .map((member) => {
        const bytes = readFileSync(join(packageRoot, member.path));

        // rebind each materialized body to the strict manifest
        if (bytes.length !== member.sizeBytes || sha256(bytes) !== member.sha256) {
          throw new Error("package member bytes differ");
        }
        return [member.path, bytes];
      }),
  );
  const edgeEvidence = Object.fromEntries(
    manifest.members
      .filter((member) => member.path.startsWith("members/edge/"))
      .map((member) => {
        const bytes = readFileSync(join(packageRoot, member.path));

        // rebind each materialized edge member to the strict manifest
        if (bytes.length !== member.sizeBytes || sha256(bytes) !== member.sha256) {
          throw new Error("package member bytes differ");
        }
        return [member.path, bytes];
      }),
  );
  if (Object.keys(edgeEvidence).filter((path) => path.includes("/objects/")).length !==
      manifest.edgeEvidence.objectCount ||
    Object.keys(edgeEvidence).filter((path) => path.includes("/receipts/")).length !==
      manifest.edgeEvidence.receiptCount) {
    throw new Error("edge evidence member counts differ");
  }

  // recheck every row-to-body binding against plaintext identity and ratio
  for (const row of rows) {
    if (row.body_member_path === null) {
      continue;
    }
    const body = bodies[row.body_member_path];
    if (body === undefined) {
      throw new Error("packaged export row body member is missing");
    }
    await validateCompressedBody(body, row.payload.bodyBytes, row.payload.bodySha256);
  }

  // recheck every identity after materialization to close mutation races
  const finalStrict = await verifyAdjustmentEvaluationPackage(packageRoot);
  if (finalStrict.manifestSha256 !== manifestHash ||
    membersByPath.size !== manifest.members.length) {
    throw new Error("package identity changed during loading");
  }
  return { bodies, edgeEvidence, manifest, manifestSha256: manifestHash, rows };
}

// cap an archive stream without host-side publication
async function capArchive(input = process.stdin, output = process.stdout) {
  let bytes = 0;

  // forward only within the reviewed archive limit
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) {
      throw new Error("compressed archive exceeds the package limit");
    }
    await writeChunk(output, chunk);
  }
}

// run the narrow package CLI
async function main() {
  const [command, ...argumentsList] = process.argv.slice(2);

  // build from a streamed database transaction
  if (command === "build") {
    if (argumentsList.length !== 4) {
      throw new Error("usage: adjustment-evaluation-package.mjs build PACKAGE_ROOT FROM TO EDGE_SNAPSHOT");
    }
    const [packageRoot, fromLocalDate, toLocalDate, edgeSnapshotPath] = argumentsList;
    const manifest = await buildAdjustmentEvaluationPackage({
      edgeSnapshotPath,
      fromLocalDate,
      packageRoot,
      toLocalDate,
    });
    process.stderr.write(`manifest=${manifest}\n`);
    return;
  }

  // stream the production archive with only one staged row member
  if (command === "stream-archive") {
    if (argumentsList.length !== 4) {
      throw new Error("usage: adjustment-evaluation-package.mjs stream-archive TEMP_ROOT FROM TO EDGE_SNAPSHOT");
    }
    const [temporaryRoot, fromLocalDate, toLocalDate, edgeSnapshotPath] = argumentsList;
    const manifest = await streamAdjustmentEvaluationPackageArchive({
      edgeSnapshotPath,
      fromLocalDate,
      temporaryRoot,
      toLocalDate,
    });
    process.stderr.write(`manifest=${manifest}\n`);
    return;
  }

  // verify one extracted package
  if (command === "verify") {
    if (argumentsList.length !== 1) {
      throw new Error("usage: adjustment-evaluation-package.mjs verify PACKAGE_ROOT");
    }
    const verified = await verifyAdjustmentEvaluationPackage(argumentsList[0]);
    process.stdout.write(`${verified.manifestSha256}\n`);
    return;
  }

  // enforce the compressed archive egress cap
  if (command === "cap-archive") {
    if (argumentsList.length !== 0) {
      throw new Error("usage: adjustment-evaluation-package.mjs cap-archive");
    }
    await capArchive();
    return;
  }

  throw new Error("unknown adjustment evaluation package command");
}

// avoid running during library import
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
