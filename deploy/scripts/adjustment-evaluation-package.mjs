#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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
const EXPECTED_COMPLETE_MIGRATION_NAMES = [
  ...EXPECTED_MIGRATION_NAMES,
  "0018_adjustment_maintenance_v2.sql",
];
const EXPECTED_COMPLETE_MIGRATION_CHECKSUMS = [
  ...EXPECTED_MIGRATION_CHECKSUMS,
  "c13d2c2c39096887712ae97f0b863f8a7ab52074ca320575f8c4c1f9b72a50a3",
];
const EXPECTED_COMPLETE_MIGRATION_HISTORY_SHA256 = createHash("sha256").update(
  EXPECTED_COMPLETE_MIGRATION_NAMES.map(
    // serialize the exact additive ledger in database order
    (name, index) => `${name}:${EXPECTED_COMPLETE_MIGRATION_CHECKSUMS[index]}`,
  ).join("\n"),
).digest("hex");
const EXPECTED_MIGRATION_LEDGERS = [
  {
    checksums: EXPECTED_MIGRATION_CHECKSUMS,
    historySha256: EXPECTED_MIGRATION_HISTORY_SHA256,
    names: EXPECTED_MIGRATION_NAMES,
  },
  {
    checksums: EXPECTED_COMPLETE_MIGRATION_CHECKSUMS,
    historySha256: EXPECTED_COMPLETE_MIGRATION_HISTORY_SHA256,
    names: EXPECTED_COMPLETE_MIGRATION_NAMES,
  },
];
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

export const ADJUSTMENT_RELEASE_CAPACITY_VERSION = "adjustment-release-capacity/v3";
export const ADJUSTMENT_RELEASE_INVENTORY_VERSION = "adjustment-release-inventory/v1";
export const BLUEBERRY_PROTECTED_FREE_BYTES = 2_030_043_136;
export const BLUEBERRY_NEXT_CAPTURE_BYTES = 4_112_384;
export const ADJUSTMENT_RUNTIME_PACKAGE_MAX_BYTES = 8 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_CONTROL_MAX_BYTES = 4 * 1_024 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_FUTURE_STATE_BYTES = 1 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_ENGINE_METADATA_BYTES = 64 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_PULL_SCRATCH_BYTES = 64 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_BYTES = 64 * 1_024 * 1_024;
export const ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_INODES = 4_096;
export const ADJUSTMENT_RELEASE_ENGINE_METADATA_INODES = 4_096;
export const ADJUSTMENT_RELEASE_CONTROL_GROWTH_INODES = 128;
const ADJUSTMENT_RELEASE_MAXIMUM_COMPRESSED_IMAGE_BYTES = 2 * 1_024 * 1_024 * 1_024;
const ADJUSTMENT_RELEASE_MAXIMUM_UNPACKED_LAYER_BYTES = 4 * 1_024 * 1_024 * 1_024;
const ADJUSTMENT_RELEASE_MAXIMUM_LAYER_INODES = 1_000_000;
const ADJUSTMENT_RELEASE_BLOCK_BYTES = 4_096;
const ADJUSTMENT_RELEASE_ROLES = ["source", "target", "compensating"];
const ADJUSTMENT_RELEASE_RUNTIMES = ["server", "web"];
const ADJUSTMENT_RELEASE_SOURCE_RELEASE = "2026.10.07-3";
const ADJUSTMENT_RELEASE_COMPENSATION_SCOPE =
  "fixed-inert-v13-whole-release-source-restore";
const ADJUSTMENT_RELEASE_SOURCE_REFERENCES = new Map([
  ["server", "ghcr.io/anstosa/weather-server@sha256:d0688756c33875940f67fbb782d9e67a2405a811d2aca40bd155f6ceffa71a74"],
  ["web", "ghcr.io/anstosa/weather-web@sha256:739d063cd911bcd7c6637082e356889ef60ac7a76caabc737070703fdf83746f"],
]);
const ADJUSTMENT_RELEASE_REFERENCE =
  /^ghcr\.io\/anstosa\/weather-(server|web)@sha256:([a-f0-9]{64})$/u;
const ADJUSTMENT_RELEASE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

// round a capacity value to host filesystem blocks
function adjustmentReleaseAllocated(bytes) {
  // unknown or inexact values cannot authorize a release
  if (!Number.isSafeInteger(bytes) || bytes < 0 ||
    bytes > Number.MAX_SAFE_INTEGER - ADJUSTMENT_RELEASE_BLOCK_BYTES) {
    throw new RangeError("invalid measured release bytes");
  }
  return Math.ceil(bytes / ADJUSTMENT_RELEASE_BLOCK_BYTES) *
    ADJUSTMENT_RELEASE_BLOCK_BYTES;
}

// preserve exact aggregate accounting
function adjustmentReleaseSum(...values) {
  let total = 0;

  // reject precision loss in every bucket
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("release capacity accounting overflow");
    }
  }
  return total;
}

// freeze Docker parent-chain identities
export function dockerChainIdentity(diffIds) {
  // one diff-id beneath a different parent is separate storage
  if (!Array.isArray(diffIds) || diffIds.length === 0 ||
    diffIds.some((value) => !ADJUSTMENT_RELEASE_DIGEST.test(value))) {
    throw new RangeError("invalid docker layer chain");
  }
  let identity = diffIds[0];

  // match Docker's recursive parent-plus-diff identity
  for (const diffId of diffIds.slice(1)) {
    identity = `sha256:${createHash("sha256").update(`${identity} ${diffId}`).digest("hex")}`;
  }
  return identity;
}

// bind raw OCI manifests and configs to one closed release inventory
export function collectAdjustmentReleaseCapacityInventory(record) {
  const expectedKeys = [
    "compensationScope",
    "freeBytes",
    "freeInodes",
    "images",
    "inventory",
    "measuredAt",
    "retainedControlBytes",
    "runtimePackageBytes",
    "sourceRelease",
    "version",
  ];
  requireExactKeys(record, expectedKeys, "release capacity collection");

  // admit only the fixed inert v13 whole-release recovery transaction
  if (record.version !== ADJUSTMENT_RELEASE_INVENTORY_VERSION ||
    record.sourceRelease !== ADJUSTMENT_RELEASE_SOURCE_RELEASE ||
    record.compensationScope !== ADJUSTMENT_RELEASE_COMPENSATION_SCOPE ||
    !Array.isArray(record.images) || record.images.length !== 6 ||
    !Array.isArray(record.inventory) || record.inventory.length > 256) {
    throw new Error("release capacity collection scope is invalid");
  }
  const inventory = record.inventory.map((entry) => {
    requireExactKeys(entry, ["allocatedBytes", "chainId"], "allocated Docker layer");
    if (!ADJUSTMENT_RELEASE_DIGEST.test(entry.chainId) ||
      adjustmentReleaseAllocated(entry.allocatedBytes) !== entry.allocatedBytes) {
      throw new Error("allocated Docker layer is invalid");
    }
    return { allocatedBytes: entry.allocatedBytes, chainId: entry.chainId };
  });
  const inventoryChains = new Set(inventory.map(({ chainId }) => chainId));

  // reject duplicate physical inventory claims
  if (inventoryChains.size !== inventory.length) {
    throw new Error("allocated Docker layer is duplicated");
  }
  const images = record.images.map((entry) => {
    requireExactKeys(entry, [
      "configBytes",
      "manifestBytes",
      "reference",
      "role",
      "runtime",
      "unpackedLayers",
    ], "release image collection");
    const reference = ADJUSTMENT_RELEASE_REFERENCE.exec(entry.reference);

    // bind each fixed repository to its runtime and one immutable manifest
    if (reference === null || reference[1] !== entry.runtime ||
      !ADJUSTMENT_RELEASE_ROLES.includes(entry.role) ||
      !ADJUSTMENT_RELEASE_RUNTIMES.includes(entry.runtime) ||
      typeof entry.manifestBytes !== "string" ||
      typeof entry.configBytes !== "string" ||
      Buffer.byteLength(entry.manifestBytes) > 1_048_576 ||
      Buffer.byteLength(entry.configBytes) > 4_194_304 ||
      !Array.isArray(entry.unpackedLayers) || entry.unpackedLayers.length > 128) {
      throw new Error("release image collection is invalid");
    }
    const manifestDigest = `sha256:${createHash("sha256").update(entry.manifestBytes).digest("hex")}`;

    // verify the exact raw manifest against the pinned reference
    if (manifestDigest !== `sha256:${reference[2]}`) {
      throw new Error("release image manifest digest differs");
    }
    const manifest = JSON.parse(entry.manifestBytes);
    const config = JSON.parse(entry.configBytes);
    requireExactKeys(manifest, ["config", "layers", "mediaType", "schemaVersion"], "OCI manifest");

    // require the closed single-platform OCI manifest layout
    if (manifest.schemaVersion !== 2 ||
      manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
      !Array.isArray(manifest.layers) || manifest.layers.length < 1 ||
      manifest.layers.length > 128 ||
      typeof manifest.config !== "object" || manifest.config === null ||
      manifest.config.mediaType !== "application/vnd.oci.image.config.v1+json" ||
      !ADJUSTMENT_RELEASE_DIGEST.test(manifest.config.digest) ||
      manifest.config.size !== Buffer.byteLength(entry.configBytes) ||
      `sha256:${createHash("sha256").update(entry.configBytes).digest("hex")}` !==
        manifest.config.digest ||
      config.architecture !== "arm64" || config.os !== "linux" ||
      config.rootfs?.type !== "layers" || !Array.isArray(config.rootfs.diff_ids) ||
      config.rootfs.diff_ids.length !== manifest.layers.length ||
      entry.unpackedLayers.length !== manifest.layers.length) {
      throw new Error("release image OCI/config identity is invalid");
    }
    const diffIds = [];
    const layers = manifest.layers.map((layer, index) => {
      requireExactKeys(layer, ["digest", "mediaType", "size"], "OCI layer descriptor");
      const unpacked = entry.unpackedLayers[index];
      requireExactKeys(unpacked, ["allocatedBytes", "blobDigest", "entryInodes"],
        "unpacked OCI layer measurement");

      // accept only measured gzip layers bound to their exact descriptor
      if (layer.mediaType !== "application/vnd.oci.image.layer.v1.tar+gzip" ||
        !ADJUSTMENT_RELEASE_DIGEST.test(layer.digest) ||
        !Number.isSafeInteger(layer.size) || layer.size < 1 ||
        unpacked.blobDigest !== layer.digest ||
        adjustmentReleaseAllocated(unpacked.allocatedBytes) !== unpacked.allocatedBytes ||
        !Number.isSafeInteger(unpacked.entryInodes) || unpacked.entryInodes < 1) {
        throw new Error("release image layer measurement is invalid");
      }
      const diffId = config.rootfs.diff_ids[index];
      diffIds.push(diffId);
      return {
        blobDigest: layer.digest,
        chainId: dockerChainIdentity(diffIds),
        compressedBytes: layer.size,
        diffId,
        entryInodes: unpacked.entryInodes,
        unpackedBytes: unpacked.allocatedBytes,
      };
    });
    return {
      digest: manifestDigest,
      layers,
      metadataBytes: adjustmentReleaseSum(
        adjustmentReleaseAllocated(Buffer.byteLength(entry.manifestBytes)),
        adjustmentReleaseAllocated(Buffer.byteLength(entry.configBytes)),
      ),
      reference: entry.reference,
      role: entry.role,
      runtime: entry.runtime,
    };
  });
  const roles = new Map(images.map((image) => [`${image.role}/${image.runtime}`, image]));

  // require all six roles and literal source reuse only in this fixed rollback scope
  for (const role of ADJUSTMENT_RELEASE_ROLES) {
    for (const runtime of ADJUSTMENT_RELEASE_RUNTIMES) {
      if (!roles.has(`${role}/${runtime}`)) {
        throw new Error("release image roles are incomplete");
      }
    }
  }
  for (const runtime of ADJUSTMENT_RELEASE_RUNTIMES) {
    const sourceReference = roles.get(`source/${runtime}`).reference;

    // bind the one reviewed predecessor and its whole-release restoration images
    if (sourceReference !== ADJUSTMENT_RELEASE_SOURCE_REFERENCES.get(runtime) ||
      sourceReference !== roles.get(`compensating/${runtime}`).reference) {
      throw new Error("fixed inert v13 compensation must restore the exact reviewed source image");
    }
  }
  return {
    engineMetadataBytes: ADJUSTMENT_RELEASE_ENGINE_METADATA_BYTES,
    freeBytes: record.freeBytes,
    freeInodes: record.freeInodes,
    futureStateBytes: ADJUSTMENT_RELEASE_FUTURE_STATE_BYTES,
    images: images.map(({ reference: _reference, ...image }) => image),
    inventory,
    maximumOwnedBytes: ADJUSTMENT_RELEASE_CONTROL_MAX_BYTES,
    measuredAt: record.measuredAt,
    nextStateInodes: 1_004,
    pullScratchBytes: ADJUSTMENT_RELEASE_PULL_SCRATCH_BYTES,
    retainedControlBytes: record.retainedControlBytes,
    runtimePackageBytes: record.runtimePackageBytes,
  };
}

// account persistent source, target and exact fixed-scope compensation ownership
export function evaluateAdjustmentReleaseCapacity(input) {
  const keys = ["engineMetadataBytes", "freeBytes", "freeInodes", "futureStateBytes",
    "images", "inventory", "maximumOwnedBytes", "measuredAt", "nextStateInodes",
    "pullScratchBytes", "retainedControlBytes", "runtimePackageBytes"];
  requireExactKeys(input, keys, "release capacity inventory");
  adjustmentReleaseAllocated(input.freeBytes);
  const available = Math.floor(input.freeBytes / ADJUSTMENT_RELEASE_BLOCK_BYTES) *
    ADJUSTMENT_RELEASE_BLOCK_BYTES;
  adjustmentReleaseAllocated(input.engineMetadataBytes);
  adjustmentReleaseAllocated(input.futureStateBytes);
  adjustmentReleaseAllocated(input.pullScratchBytes);
  adjustmentReleaseAllocated(input.retainedControlBytes);
  adjustmentReleaseAllocated(input.runtimePackageBytes);
  adjustmentReleaseAllocated(input.maximumOwnedBytes);
  const observationMilliseconds = Date.parse(input.measuredAt);

  // bind a canonical observation and all integer inode measurements
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.measuredAt) ||
    !Number.isFinite(observationMilliseconds) ||
    new Date(observationMilliseconds).toISOString() !== input.measuredAt ||
    input.futureStateBytes !== ADJUSTMENT_RELEASE_FUTURE_STATE_BYTES ||
    !Number.isSafeInteger(input.freeInodes) || !Number.isSafeInteger(input.nextStateInodes) ||
    input.freeInodes < 0 || input.nextStateInodes < 0 ||
    !Array.isArray(input.inventory) || !Array.isArray(input.images) || input.images.length !== 6) {
    throw new RangeError("invalid exact release inventory");
  }
  const inventory = new Map();

  // retain literal current allocated layer measurements
  for (const layer of input.inventory) {
    requireExactKeys(layer, ["allocatedBytes", "chainId"], "allocated Docker layer");
    if (!ADJUSTMENT_RELEASE_DIGEST.test(layer.chainId) || inventory.has(layer.chainId) ||
      adjustmentReleaseAllocated(layer.allocatedBytes) !== layer.allocatedBytes) {
      throw new RangeError("invalid allocated docker inventory");
    }
    inventory.set(layer.chainId, layer.allocatedBytes);
  }
  const owned = new Map();
  const layerInodes = new Map();
  const newCompressed = new Map();
  const metadata = new Map();
  const manifests = new Map();
  const roles = new Set();

  // require all literal images to coexist through restart and compensation
  for (const image of input.images) {
    requireExactKeys(image, ["digest", "layers", "metadataBytes", "role", "runtime"],
      "release capacity image");
    if (!ADJUSTMENT_RELEASE_DIGEST.test(image.digest) ||
      !ADJUSTMENT_RELEASE_ROLES.includes(image.role) ||
      !ADJUSTMENT_RELEASE_RUNTIMES.includes(image.runtime) ||
      roles.has(`${image.role}/${image.runtime}`) ||
      !Array.isArray(image.layers) || image.layers.length === 0) {
      throw new RangeError("release images must contain both runtimes for source, target and compensation");
    }
    roles.add(`${image.role}/${image.runtime}`);
    const previousMetadata = metadata.get(image.digest);
    const bytes = adjustmentReleaseAllocated(image.metadataBytes);
    if (previousMetadata !== undefined && previousMetadata !== bytes) {
      throw new RangeError("image metadata measurement differs");
    }
    metadata.set(image.digest, bytes);
    const diffIds = [];

    // deduplicate only complete parent chains
    for (const layer of image.layers) {
      requireExactKeys(layer, ["blobDigest", "chainId", "compressedBytes", "diffId",
        "entryInodes", "unpackedBytes"], "release capacity layer");
      diffIds.push(layer.diffId);
      const chainId = dockerChainIdentity(diffIds);
      if (!ADJUSTMENT_RELEASE_DIGEST.test(layer.blobDigest) || layer.chainId !== chainId ||
        !Number.isSafeInteger(layer.entryInodes) || layer.entryInodes < 1) {
        throw new RangeError("image layer identity differs");
      }
      const unpacked = adjustmentReleaseAllocated(layer.unpackedBytes);
      const prior = owned.get(chainId);
      if (prior !== undefined && prior !== unpacked) {
        throw new RangeError("shared layer measurement differs");
      }
      owned.set(chainId, unpacked);
      const priorInodes = layerInodes.get(chainId);
      if (priorInodes !== undefined && priorInodes !== layer.entryInodes) {
        throw new RangeError("shared layer inode measurement differs");
      }
      layerInodes.set(chainId, layer.entryInodes);
      const compressed = adjustmentReleaseAllocated(layer.compressedBytes);

      // only absent chains consume pull growth
      if (!inventory.has(chainId)) {
        const oldCompressed = newCompressed.get(layer.blobDigest);
        if (oldCompressed !== undefined && oldCompressed !== compressed) {
          throw new RangeError("compressed blob measurement differs");
        }
        newCompressed.set(layer.blobDigest, compressed);
      }
    }
    const manifest = JSON.stringify(image.layers.map(
      // bind all immutable and bounded layer facts
      ({ blobDigest, chainId, compressedBytes, diffId, entryInodes, unpackedBytes }) =>
        [blobDigest, chainId, compressedBytes, diffId, entryInodes, unpackedBytes],
    ));
    if (manifests.has(image.digest) && manifests.get(image.digest) !== manifest) {
      throw new RangeError("immutable image manifest measurement differs");
    }
    manifests.set(image.digest, manifest);
  }
  let retainedLayerBytes = 0;
  let newLayerBytes = 0;
  let newLayerInodes = 0;

  // use actual existing blocks and measured absent-chain bounds
  for (const [chainId, bound] of owned) {
    const measured = inventory.get(chainId);
    retainedLayerBytes = adjustmentReleaseSum(retainedLayerBytes, measured ?? bound);
    if (measured === undefined) {
      newLayerBytes = adjustmentReleaseSum(newLayerBytes, bound);
      newLayerInodes = adjustmentReleaseSum(newLayerInodes, layerInodes.get(chainId));
    }
  }
  const metadataBytes = adjustmentReleaseSum(...metadata.values());
  const packageBytes = adjustmentReleaseAllocated(input.runtimePackageBytes);
  const futureStateBytes = adjustmentReleaseAllocated(input.futureStateBytes);
  const retainedControlBytes = adjustmentReleaseAllocated(input.retainedControlBytes);
  const persistentOwnedBytes = adjustmentReleaseSum(retainedLayerBytes, metadataBytes,
    adjustmentReleaseAllocated(input.engineMetadataBytes), packageBytes,
    retainedControlBytes, futureStateBytes);
  const persistentGrowthBytes = adjustmentReleaseSum(newLayerBytes, metadataBytes,
    adjustmentReleaseAllocated(input.engineMetadataBytes), packageBytes, futureStateBytes);
  const compressedPeakBytes = adjustmentReleaseSum(...newCompressed.values());
  const pullPeakGrowthBytes = adjustmentReleaseSum(persistentGrowthBytes,
    compressedPeakBytes, adjustmentReleaseAllocated(input.pullScratchBytes));
  const compatibilityPeakGrowthBytes = adjustmentReleaseSum(
    persistentGrowthBytes, ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_BYTES);
  const releaseTransactionPeakGrowthBytes = Math.max(
    pullPeakGrowthBytes, compatibilityPeakGrowthBytes);
  const requiredFreeBytes = adjustmentReleaseSum(BLUEBERRY_PROTECTED_FREE_BYTES,
    BLUEBERRY_NEXT_CAPTURE_BYTES, releaseTransactionPeakGrowthBytes);
  const requiredFreeInodes = adjustmentReleaseSum(32_768, input.nextStateInodes,
    newLayerInodes, ADJUSTMENT_RELEASE_ENGINE_METADATA_INODES,
    ADJUSTMENT_RELEASE_CONTROL_GROWTH_INODES,
    ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_INODES);
  const reasons = [];

  // retain both byte and inode floors after the next complete capture
  if (available < requiredFreeBytes) reasons.push("protected_floor_or_transaction_peak");
  if (input.freeInodes < requiredFreeInodes) reasons.push("inode_floor");
  if (persistentOwnedBytes > input.maximumOwnedBytes) reasons.push("persistent_image_ownership");
  if (input.runtimePackageBytes > ADJUSTMENT_RUNTIME_PACKAGE_MAX_BYTES) {
    reasons.push("runtime_package_ceiling");
  }
  return Object.freeze({
    availableFreeBytes: available,
    captureReservedBytes: BLUEBERRY_NEXT_CAPTURE_BYTES,
    compatibilityFixtureBytes: ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_BYTES,
    compatibilityFixtureInodes: ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_INODES,
    compensationScope: ADJUSTMENT_RELEASE_COMPENSATION_SCOPE,
    compressedPeakBytes,
    contractVersion: ADJUSTMENT_RELEASE_CAPACITY_VERSION,
    futureStateBytes,
    imageDigests: input.images.map(({ role, runtime, digest }) => ({ digest, role, runtime })),
    measuredAt: input.measuredAt,
    newLayerInodes,
    persistentGrowthBytes,
    persistentOwnedBytes,
    protectedFreeBytes: BLUEBERRY_PROTECTED_FREE_BYTES,
    pullPeakGrowthBytes,
    releaseTransactionPeakGrowthBytes,
    reasons,
    requiredFreeBytes,
    requiredFreeInodes,
    retainedControlBytes,
    retirementCreditBytes: 0,
    sourceRelease: ADJUSTMENT_RELEASE_SOURCE_RELEASE,
    state: reasons.length === 0 ? "capacity_ready" : "capacity_blocked",
  });
}

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
  const recognizedMigrationLedger = Array.isArray(manifest.migration_names) &&
    Array.isArray(manifest.migration_checksums) &&
    EXPECTED_MIGRATION_LEDGERS.some(
      // match only the exact legacy or complete maintenance ledger
      (ledger) => manifest.migration_history_sha256 === ledger.historySha256 &&
        JSON.stringify(manifest.migration_names) === JSON.stringify(ledger.names) &&
        JSON.stringify(manifest.migration_checksums) === JSON.stringify(ledger.checksums),
    );

  // bind both closed ledgers to the unchanged migration 0017 query
  if (manifest.contract_version !== DATABASE_MANIFEST_VERSION ||
    manifest.schema_migration !== "0017_adjustment_evaluation_export.sql" ||
    manifest.query_contract_version !== "adjustment-evaluation-export-query/v1" ||
    manifest.site_key !== "ballydidean" ||
    manifest.site_timezone !== "America/Los_Angeles" ||
    manifest.row_schema_sha256 !== EXPECTED_ROW_SCHEMA_SHA256 ||
    manifest.query_contract_sha256 !== EXPECTED_QUERY_CONTRACT_SHA256 ||
    !HASH_PATTERN.test(manifest.migration_history_sha256) ||
    !recognizedMigrationLedger) {
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

const V2_STREAM_MAGIC = Buffer.from("weather-adjustment-evaluation-envelope/v2\n");
const V2_ENVELOPE_VERSION = "adjustment-evaluation-export-envelope/v2";
const V2_AVAILABILITY_ENVELOPE_VERSION =
  "adjustment-confirmation-availability-envelope/v2";
const V2_AUTHORIZATION_ENVELOPE_VERSION =
  "adjustment-confirmation-export-authorization-envelope/v2";
const V2_MAXIMUM_HEADER_BYTES = 64 * 1024;
const V2_MAXIMUM_DATABASE_RESPONSE_BYTES = 768 * 1024;
const V2_UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const V2_DUE_KEY_PATTERN =
  /^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u;
const V2_FAMILIES = new Set(["rain", "temperature", "wind"]);

// require the complete additive maintenance ledger
function validateCompleteMaintenanceDatabaseManifest(value) {
  const manifest = validateDatabaseManifest(value);

  // reject legacy, partial, drifted, and future ledgers for v2
  if (JSON.stringify(manifest.migration_names) !==
      JSON.stringify(EXPECTED_COMPLETE_MIGRATION_NAMES) ||
    JSON.stringify(manifest.migration_checksums) !==
      JSON.stringify(EXPECTED_COMPLETE_MIGRATION_CHECKSUMS) ||
    manifest.migration_history_sha256 !== EXPECTED_COMPLETE_MIGRATION_HISTORY_SHA256) {
    throw new Error("maintenance database ledger is not exact");
  }
  return manifest;
}

// validate one read-only function transaction
function validateV2ReadOnlyTransaction(value) {
  const transaction = requireObject(value, "maintenance export transaction");
  requireExactKeys(transaction, [
    "created_at_utc",
    "idle_in_transaction_session_timeout",
    "isolation_level",
    "lock_timeout",
    "read_only",
    "statement_timeout",
  ], "maintenance export transaction");

  // require the fixed repeatable-read function boundary
  if (!Number.isFinite(Date.parse(transaction.created_at_utc)) ||
    transaction.idle_in_transaction_session_timeout !== "30s" ||
    transaction.isolation_level !== "repeatable read" ||
    transaction.lock_timeout !== "5s" ||
    transaction.read_only !== "on" ||
    transaction.statement_timeout !== "5min") {
    throw new Error("maintenance export transaction is invalid");
  }
  return transaction;
}

// require one canonical utc millisecond instant
function validateV2Instant(value, description) {
  // reject normalized aliases and invalid instants
  if (typeof value !== "string" || !V2_UTC_MILLISECOND_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))) {
    throw new Error(`${description} is invalid`);
  }
}

// require one safe integer inside a closed range
function validateV2Integer(value, minimum, maximum, description) {
  // reject fractional and out-of-range counts
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${description} is invalid`);
  }
}

// require one lowercase content identity
function validateV2Hash(value, description) {
  // reject aliases and malformed identities
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${description} is invalid`);
  }
}

// validate one function-only value-free availability payload
function validateV2AvailabilityPayload(value, registrationSha256) {
  const payload = requireObject(value, "maintenance availability payload");
  requireExactKeys(payload, [
    "contractVersion",
    "expectedKeySetSha256",
    "family",
    "finalizedMetadataRootSha256",
    "finalizedPredictionCount",
    "finalizedThroughAt",
    "hotPredictionCount",
    "hotPredictions",
    "hotSetRootSha256",
    "intervalEndAt",
    "intervalStartAt",
    "metadataGeneration",
    "missingExpectedDueKeys",
    "missingExpectedDueKeysStatus",
    "registrationSha256",
    "targetCutoffAt",
  ], "maintenance availability payload");

  // require the exact requested value-free contract
  if (payload.contractVersion !== "adjustment-confirmation-availability/v2" ||
    payload.registrationSha256 !== registrationSha256 ||
    !V2_FAMILIES.has(payload.family) ||
    payload.missingExpectedDueKeys !== null ||
    payload.missingExpectedDueKeysStatus !==
      "requires_anchored_cold_reconstruction") {
    throw new Error("maintenance availability contract differs");
  }
  for (const [candidate, description] of [
    [payload.expectedKeySetSha256, "expected key set identity"],
    [payload.finalizedMetadataRootSha256, "finalized metadata root"],
    [payload.hotSetRootSha256, "hot set root"],
  ]) {
    validateV2Hash(candidate, description);
  }
  validateV2Integer(
    payload.finalizedPredictionCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "finalized prediction count",
  );
  validateV2Integer(
    payload.metadataGeneration,
    0,
    Number.MAX_SAFE_INTEGER,
    "metadata generation",
  );
  validateV2Instant(payload.intervalStartAt, "interval start");
  validateV2Instant(payload.intervalEndAt, "interval end");
  validateV2Instant(payload.targetCutoffAt, "target cutoff");

  // validate the nullable finalized clock
  if (payload.finalizedThroughAt !== null) {
    validateV2Instant(payload.finalizedThroughAt, "finalized through time");
  }
  if (!Array.isArray(payload.hotPredictions)) {
    throw new Error("maintenance hot predictions are invalid");
  }
  validateV2Integer(payload.hotPredictionCount, 0, 8_192, "hot prediction count");

  // bind the declared projection count
  if (payload.hotPredictionCount !== payload.hotPredictions.length) {
    throw new Error("maintenance hot prediction count differs");
  }
  let previousIdentity = "";
  for (const predictionValue of payload.hotPredictions) {
    const prediction = requireObject(predictionValue, "maintenance hot prediction");
    requireExactKeys(prediction, [
      "dueKey",
      "maxValidAt",
      "minValidAt",
      "predictionSha256",
      "rowCount",
    ], "maintenance hot prediction");
    validateV2Hash(prediction.predictionSha256, "hot prediction identity");
    validateV2Instant(prediction.minValidAt, "hot minimum valid time");
    validateV2Instant(prediction.maxValidAt, "hot maximum valid time");

    // require scheduler due keys and family row bounds
    const maximumRows = payload.family === "wind" ? 168 :
      payload.family === "rain" ? 23 : 12;
    if (typeof prediction.dueKey !== "string" ||
      !V2_DUE_KEY_PATTERN.test(prediction.dueKey)) {
      throw new Error("maintenance hot prediction due key is invalid");
    }
    validateV2Integer(prediction.rowCount, 1, maximumRows, "hot prediction row count");

    // require the database's canonical order
    if (prediction.predictionSha256 <= previousIdentity) {
      throw new Error("maintenance hot predictions are unordered");
    }
    previousIdentity = prediction.predictionSha256;
  }

  // enforce the function's reviewed response cap
  if (Buffer.byteLength(canonicalJsonValue(payload)) > 512 * 1024) {
    throw new Error("maintenance availability exceeds its limit");
  }
  return payload;
}

// validate one persisted-burn chunk authorization
function validateV2AuthorizationPayload(
  value,
  registrationSha256,
  accessSha256,
  chunkIndex,
) {
  const payload = requireObject(value, "maintenance authorization payload");
  requireExactKeys(payload, [
    "accessSha256",
    "chunkCount",
    "chunkIndex",
    "contractVersion",
    "eligiblePredictionSetSha256",
    "expectedKeySetSha256",
    "family",
    "fromLocalDate",
    "metadataRootSha256",
    "registrationSha256",
    "revisionCatalogWatermarkSha256",
    "targetComparatorSnapshotRootSha256",
    "targetCutoffAt",
    "toLocalDateExclusive",
  ], "maintenance authorization payload");

  // bind the function result to the exact forced operands
  if (payload.contractVersion !==
      "adjustment-confirmation-export-authorization/v2" ||
    payload.registrationSha256 !== registrationSha256 ||
    payload.accessSha256 !== accessSha256 || payload.chunkIndex !== chunkIndex ||
    !V2_FAMILIES.has(payload.family)) {
    throw new Error("maintenance authorization contract differs");
  }
  const expectedChunkCount = payload.family === "rain" ? 24 : 27;
  if (payload.chunkCount !== expectedChunkCount || chunkIndex < 0 ||
    chunkIndex >= expectedChunkCount) {
    throw new Error("maintenance authorization partition differs");
  }
  for (const [candidate, description] of [
    [payload.eligiblePredictionSetSha256, "eligible prediction set identity"],
    [payload.expectedKeySetSha256, "expected key set identity"],
    [payload.metadataRootSha256, "metadata root identity"],
    [payload.revisionCatalogWatermarkSha256, "revision catalog watermark"],
    [payload.targetComparatorSnapshotRootSha256, "target snapshot root"],
  ]) {
    validateV2Hash(candidate, description);
  }
  validateV2Instant(payload.targetCutoffAt, "target cutoff");
  const fromDate = parseCalendarDate(payload.fromLocalDate, "authorization start date");
  const toDateExclusive = parseCalendarDate(
    payload.toLocalDateExclusive,
    "authorization exclusive end date",
  );

  // require one to fourteen america/los_angeles local dates
  const spanDays = Math.round((toDateExclusive - fromDate) / 86_400_000);
  if (spanDays < 1 || spanDays > 14) {
    throw new Error("maintenance authorization dates differ");
  }
  if (Buffer.byteLength(canonicalJsonValue(payload)) > 8 * 1024) {
    throw new Error("maintenance authorization exceeds its limit");
  }
  return payload;
}

// read one bounded database function response
async function readV2DatabaseResponse(input = process.stdin) {
  const chunks = [];
  let bytes = 0;

  // retain only the bounded json response
  for await (const inputChunk of input) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    bytes += chunk.length;
    if (bytes > V2_MAXIMUM_DATABASE_RESPONSE_BYTES) {
      throw new Error("maintenance database response exceeds its limit");
    }
    chunks.push(chunk);
  }
  const encoded = Buffer.concat(chunks).toString("utf8").trim();
  const response = requireObject(JSON.parse(encoded), "maintenance database response");
  requireExactKeys(response, [
    "databaseManifest",
    "payload",
    "transaction",
  ], "maintenance database response");
  return {
    databaseManifest: validateCompleteMaintenanceDatabaseManifest(response.databaseManifest),
    payload: response.payload,
    transaction: validateV2ReadOnlyTransaction(response.transaction),
  };
}

// frame one value-free availability response
export async function frameAdjustmentConfirmationAvailabilityV2({
  input = process.stdin,
  registrationSha256,
}) {
  validateV2Hash(registrationSha256, "registration identity");
  const response = await readV2DatabaseResponse(input);
  const payload = validateV2AvailabilityPayload(response.payload, registrationSha256);
  const envelope = {
    contractVersion: V2_AVAILABILITY_ENVELOPE_VERSION,
    databaseManifest: response.databaseManifest,
    payload,
    payloadSha256: sha256(canonicalJson(payload)),
    transaction: response.transaction,
  };
  return Buffer.from(canonicalJson(envelope));
}

// frame one post-burn authorization response
export async function frameAdjustmentConfirmationAuthorizationV2({
  accessSha256,
  chunkIndex,
  input = process.stdin,
  registrationSha256,
}) {
  validateV2Hash(registrationSha256, "registration identity");
  validateV2Hash(accessSha256, "access identity");
  validateV2Integer(chunkIndex, 0, 26, "chunk index");
  const response = await readV2DatabaseResponse(input);
  const payload = validateV2AuthorizationPayload(
    response.payload,
    registrationSha256,
    accessSha256,
    chunkIndex,
  );
  const envelope = {
    contractVersion: V2_AUTHORIZATION_ENVELOPE_VERSION,
    databaseManifest: response.databaseManifest,
    payload,
    payloadSha256: sha256(canonicalJson(payload)),
    transaction: response.transaction,
  };
  return Buffer.from(canonicalJson(envelope));
}

// validate one framed function response
function validateV2FunctionEnvelope(value, expectedContractVersion) {
  const envelope = requireObject(value, "maintenance function envelope");
  requireExactKeys(envelope, [
    "contractVersion",
    "databaseManifest",
    "payload",
    "payloadSha256",
    "transaction",
  ], "maintenance function envelope");
  if (envelope.contractVersion !== expectedContractVersion) {
    throw new Error("maintenance function envelope contract differs");
  }
  validateCompleteMaintenanceDatabaseManifest(envelope.databaseManifest);
  validateV2ReadOnlyTransaction(envelope.transaction);
  validateV2Hash(envelope.payloadSha256, "maintenance payload identity");

  // bind the function payload to its canonical bytes
  if (sha256(canonicalJson(envelope.payload)) !== envelope.payloadSha256) {
    throw new Error("maintenance function payload hash differs");
  }
  return envelope;
}

// load one canonical authorization envelope
async function readV2AuthorizationEnvelope(path) {
  const bytes = await readNoFollowBoundedFile(
    path,
    V2_MAXIMUM_DATABASE_RESPONSE_BYTES,
    "maintenance authorization envelope",
  );
  const envelope = validateV2FunctionEnvelope(
    JSON.parse(bytes),
    V2_AUTHORIZATION_ENVELOPE_VERSION,
  );
  const payload = validateV2AuthorizationPayload(
    envelope.payload,
    envelope.payload.registrationSha256,
    envelope.payload.accessSha256,
    envelope.payload.chunkIndex,
  );

  // require canonical stored bytes
  if (!bytes.equals(Buffer.from(canonicalJson(envelope)))) {
    throw new Error("maintenance authorization envelope is not canonical");
  }
  return { bytes, envelope, payload };
}

// read one edge watermark without exporting host paths
async function readV2EdgeWatermark(snapshotPath) {
  const bytes = await readNoFollowBoundedFile(
    snapshotPath,
    4 * 1024 * 1024,
    "maintenance edge snapshot",
  );
  const snapshot = requireObject(JSON.parse(bytes), "maintenance edge snapshot");
  requireExactKeys(snapshot, [
    "contractVersion",
    "entries",
    "frozenAt",
    "watermarkSha256",
  ], "maintenance edge snapshot");
  validateV2Hash(snapshot.watermarkSha256, "edge snapshot watermark");
  if (snapshot.contractVersion !== EDGE_SNAPSHOT_VERSION ||
    !Array.isArray(snapshot.entries) || !Number.isFinite(Date.parse(snapshot.frozenAt))) {
    throw new Error("maintenance edge snapshot contract differs");
  }
  return snapshot.watermarkSha256;
}

// add calendar days without timezone conversion
function addV2CalendarDays(value, days) {
  const parsed = new Date(parseCalendarDate(value, "maintenance local date"));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// validate one immutable v2 stream header
function validateV2StreamHeader(value) {
  const header = requireObject(value, "maintenance stream header");
  requireExactKeys(header, [
    "authorization",
    "authorizationSha256",
    "contractVersion",
    "dateSemantics",
    "exportKind",
    "fromLocalDate",
    "payloadBytes",
    "payloadSha256",
    "snapshotLineage",
    "sourcePackageContractVersion",
    "toLocalDate",
    "valueAuthority",
  ], "maintenance stream header");
  if (header.contractVersion !== V2_ENVELOPE_VERSION ||
    header.dateSemantics !== "america_los_angeles_inclusive_local_dates" ||
    header.sourcePackageContractVersion !== PACKAGE_VERSION) {
    throw new Error("maintenance stream contract differs");
  }
  validateDateRange(header.fromLocalDate, header.toLocalDate);
  validateV2Hash(header.payloadSha256, "maintenance stream payload identity");
  validateV2Integer(header.payloadBytes, 1, MAX_ARCHIVE_BYTES, "stream payload bytes");
  const lineage = requireObject(header.snapshotLineage, "maintenance snapshot lineage");
  requireExactKeys(lineage, [
    "edgeEvidenceWatermarkSha256",
    "revisionCatalogWatermarkSha256",
    "targetComparatorSnapshotRootSha256",
  ], "maintenance snapshot lineage");
  validateV2Hash(lineage.edgeEvidenceWatermarkSha256, "edge evidence watermark");

  // separate descriptive daily transport from post-burn authority
  if (header.exportKind === "daily_monitoring") {
    if (header.authorization !== null || header.authorizationSha256 !== null ||
      header.valueAuthority !== "none" ||
      lineage.revisionCatalogWatermarkSha256 !== null ||
      lineage.targetComparatorSnapshotRootSha256 !== null) {
      throw new Error("daily maintenance stream has action authority");
    }
  } else if (header.exportKind === "post_burn_confirmation") {
    validateV2Hash(header.authorizationSha256, "authorization envelope identity");
    const authorization = validateV2FunctionEnvelope(
      header.authorization,
      V2_AUTHORIZATION_ENVELOPE_VERSION,
    );
    const payload = validateV2AuthorizationPayload(
      authorization.payload,
      authorization.payload.registrationSha256,
      authorization.payload.accessSha256,
      authorization.payload.chunkIndex,
    );
    if (sha256(canonicalJson(header.authorization)) !== header.authorizationSha256 ||
      header.valueAuthority !== "persisted_burn_authorization" ||
      payload.fromLocalDate !== header.fromLocalDate ||
      addV2CalendarDays(payload.toLocalDateExclusive, -1) !== header.toLocalDate ||
      lineage.revisionCatalogWatermarkSha256 !==
        payload.revisionCatalogWatermarkSha256 ||
      lineage.targetComparatorSnapshotRootSha256 !==
        payload.targetComparatorSnapshotRootSha256) {
      throw new Error("confirmation maintenance stream lineage differs");
    }
  } else {
    throw new Error("maintenance stream kind is invalid");
  }
  return header;
}

// hash one stable no-follow archive descriptor
async function hashV2Archive(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ARCHIVE_BYTES)) {
      throw new Error("maintenance source archive is invalid");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;

    // stream the bounded source archive
    while (offset < Number(before.size)) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new Error("maintenance source archive ended early");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) {
      throw new Error("maintenance source archive changed while hashing");
    }
    return {
      metadata: before,
      sha256: hash.digest("hex"),
      sizeBytes: Number(before.size),
    };
  } finally {
    await handle.close();
  }
}

// stream one v2 header followed by one immutable v1 archive
export async function streamAdjustmentEvaluationV2EnvelopeArchive({
  authorizationPath = null,
  edgeSnapshotPath,
  exportKind,
  fromLocalDate,
  output = process.stdout,
  sourceArchivePath,
  toLocalDate,
}) {
  validateDateRange(fromLocalDate, toLocalDate);
  const source = await hashV2Archive(sourceArchivePath);
  const edgeEvidenceWatermarkSha256 = await readV2EdgeWatermark(edgeSnapshotPath);
  let authorization = null;
  let authorizationSha256 = null;
  let valueAuthority = "none";
  let revisionCatalogWatermarkSha256 = null;
  let targetComparatorSnapshotRootSha256 = null;

  // require a persisted burn for confirmation transport
  if (exportKind === "post_burn_confirmation") {
    if (authorizationPath === null) {
      throw new Error("confirmation authorization is missing");
    }
    const authorized = await readV2AuthorizationEnvelope(authorizationPath);
    authorization = authorized.envelope;
    authorizationSha256 = sha256(authorized.bytes);
    valueAuthority = "persisted_burn_authorization";
    revisionCatalogWatermarkSha256 =
      authorized.payload.revisionCatalogWatermarkSha256;
    targetComparatorSnapshotRootSha256 =
      authorized.payload.targetComparatorSnapshotRootSha256;
    if (authorized.payload.fromLocalDate !== fromLocalDate ||
      addV2CalendarDays(authorized.payload.toLocalDateExclusive, -1) !== toLocalDate) {
      throw new Error("confirmation archive dates differ from authorization");
    }
  } else if (exportKind !== "daily_monitoring" || authorizationPath !== null) {
    throw new Error("maintenance export kind is invalid");
  }
  const header = validateV2StreamHeader({
    authorization,
    authorizationSha256,
    contractVersion: V2_ENVELOPE_VERSION,
    dateSemantics: "america_los_angeles_inclusive_local_dates",
    exportKind,
    fromLocalDate,
    payloadBytes: source.sizeBytes,
    payloadSha256: source.sha256,
    snapshotLineage: {
      edgeEvidenceWatermarkSha256,
      revisionCatalogWatermarkSha256,
      targetComparatorSnapshotRootSha256,
    },
    sourcePackageContractVersion: PACKAGE_VERSION,
    toLocalDate,
    valueAuthority,
  });
  const headerBytes = Buffer.from(canonicalJson(header));
  if (headerBytes.length > V2_MAXIMUM_HEADER_BYTES) {
    throw new Error("maintenance stream header exceeds its limit");
  }
  await writeChunk(output, V2_STREAM_MAGIC);
  await writeChunk(output, Buffer.from(`${headerBytes.length.toString(16).padStart(8, "0")}\n`));
  await writeChunk(output, headerBytes);
  const handle = await open(sourceArchivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== source.metadata.dev || before.ino !== source.metadata.ino ||
      before.size !== source.metadata.size || before.mtimeNs !== source.metadata.mtimeNs ||
      before.ctimeNs !== source.metadata.ctimeNs) {
      throw new Error("maintenance source archive changed before streaming");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;

    // stream only the prehashed source bytes
    while (offset < source.sizeBytes) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, source.sizeBytes - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new Error("maintenance source archive ended early");
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      await writeChunk(output, chunk);
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (hash.digest("hex") !== source.sha256 || before.dev !== after.dev ||
      before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("maintenance source archive changed while streaming");
    }
  } finally {
    await handle.close();
  }
  return header;
}

// read one exact descriptor range
async function readV2DescriptorRange(handle, length, position, description) {
  const bytes = Buffer.alloc(length);
  let offset = 0;

  // fill the proven descriptor range
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (read.bytesRead === 0) {
      throw new Error(`${description} ended early`);
    }
    offset += read.bytesRead;
  }
  return bytes;
}

// verify one downloaded v2 stream without extracting its payload
export async function verifyAdjustmentEvaluationV2Stream(framePath) {
  const handle = await open(framePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < BigInt(V2_STREAM_MAGIC.length + 10) ||
      before.size > BigInt(MAX_ARCHIVE_BYTES + V2_MAXIMUM_HEADER_BYTES + 64)) {
      throw new Error("maintenance stream is not a bounded regular file");
    }
    const magic = await readV2DescriptorRange(
      handle,
      V2_STREAM_MAGIC.length,
      0,
      "maintenance stream magic",
    );
    if (!magic.equals(V2_STREAM_MAGIC)) {
      throw new Error("maintenance stream magic differs");
    }
    const lengthOffset = V2_STREAM_MAGIC.length;
    const encodedLength = await readV2DescriptorRange(
      handle,
      9,
      lengthOffset,
      "maintenance stream header length",
    );
    if (!/^[a-f0-9]{8}\n$/u.test(encodedLength.toString("ascii"))) {
      throw new Error("maintenance stream header length is invalid");
    }
    const headerLength = Number.parseInt(encodedLength.toString("ascii").trim(), 16);
    if (headerLength < 2 || headerLength > V2_MAXIMUM_HEADER_BYTES) {
      throw new Error("maintenance stream header exceeds its limit");
    }
    const headerOffset = lengthOffset + encodedLength.length;
    const headerBytes = await readV2DescriptorRange(
      handle,
      headerLength,
      headerOffset,
      "maintenance stream header",
    );
    const header = validateV2StreamHeader(JSON.parse(headerBytes));
    if (!headerBytes.equals(Buffer.from(canonicalJson(header)))) {
      throw new Error("maintenance stream header is not canonical");
    }
    const payloadOffset = headerOffset + headerLength;
    if (BigInt(payloadOffset + header.payloadBytes) !== before.size) {
      throw new Error("maintenance stream framing differs");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;

    // verify the framed v1 archive without buffering it
    while (offset < header.payloadBytes) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, header.payloadBytes - offset),
        payloadOffset + offset,
      );
      if (read.bytesRead === 0) {
        throw new Error("maintenance stream payload ended early");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (hash.digest("hex") !== header.payloadSha256 || before.dev !== after.dev ||
      before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("maintenance stream changed or has an invalid payload");
    }
    return { header, headerBytes, payloadBytes: header.payloadBytes, payloadOffset };
  } finally {
    await handle.close();
  }
}

// verify one normalized v2 package against its v1 payload
export async function verifyAdjustmentEvaluationV2EnvelopePackage({
  envelopePath,
  packageRoot,
}) {
  const envelopeBytes = await readNoFollowBoundedFile(
    envelopePath,
    V2_MAXIMUM_HEADER_BYTES,
    "maintenance stream envelope",
  );
  const header = validateV2StreamHeader(JSON.parse(envelopeBytes));
  if (!envelopeBytes.equals(Buffer.from(canonicalJson(header)))) {
    throw new Error("maintenance stream envelope is not canonical");
  }
  const verified = await verifyAdjustmentEvaluationPackage(packageRoot);
  validateCompleteMaintenanceDatabaseManifest(verified.manifest.databaseManifest);
  if (verified.manifest.fromLocalDate !== header.fromLocalDate ||
    verified.manifest.toLocalDate !== header.toLocalDate ||
    verified.manifest.edgeEvidence.watermarkSha256 !==
      header.snapshotLineage.edgeEvidenceWatermarkSha256) {
    throw new Error("maintenance package lineage differs");
  }
  return {
    envelopeSha256: sha256(envelopeBytes),
    manifestSha256: verified.manifestSha256,
    snapshotLineage: header.snapshotLineage,
  };
}

// verify one downloaded value-free availability envelope
export async function verifyAdjustmentConfirmationAvailabilityV2(path) {
  const bytes = await readNoFollowBoundedFile(
    path,
    V2_MAXIMUM_DATABASE_RESPONSE_BYTES,
    "maintenance availability envelope",
  );
  const envelope = validateV2FunctionEnvelope(
    JSON.parse(bytes),
    V2_AVAILABILITY_ENVELOPE_VERSION,
  );
  validateV2AvailabilityPayload(
    envelope.payload,
    envelope.payload.registrationSha256,
  );
  if (!bytes.equals(Buffer.from(canonicalJson(envelope)))) {
    throw new Error("maintenance availability envelope is not canonical");
  }
  return sha256(bytes);
}

// read one bounded registry response
async function readBoundedRegistryResponse(response, maximumBytes, description) {
  if (response.body === null) {
    throw new Error(`${description} response is empty`);
  }
  const chunks = [];
  let bytes = 0;

  // retain only small manifest, config and token responses
  for await (const chunk of Readable.fromWeb(response.body)) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw new Error(`${description} response exceeds its bound`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

// validate one closed GHCR signed-blob redirect without forwarding credentials
export function weatherRegistryBlobRedirectUrl(location, repository, digest) {
  if (!/^weather-(server|web)$/u.test(repository) ||
    !ADJUSTMENT_RELEASE_DIGEST.test(digest) || typeof location !== "string" ||
    location.length > 4_096) {
    throw new Error("registry blob redirect identity is invalid");
  }
  const redirected = new URL(location);
  const expectedKeys = [
    "hmac", "se", "sig", "ske", "skoid", "sks", "skt", "sktid",
    "skv", "sp", "spr", "sr", "sv",
  ];
  const actualKeys = [...redirected.searchParams.keys()].sort();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

  // accept one exact HTTPS content host, path, and read-only signed query shape
  if (redirected.protocol !== "https:" || redirected.port !== "" ||
    redirected.username !== "" || redirected.password !== "" ||
    redirected.hostname !== "pkg-containers.githubusercontent.com" ||
    !new RegExp(`^/ghcr(?:[0-9]{1,3}|blobs[0-9]{2})/blobs/${digest}$`, "u")
      .test(redirected.pathname) ||
    redirected.hash !== "" ||
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    redirected.searchParams.get("sp") !== "r" ||
    redirected.searchParams.get("spr") !== "https" ||
    redirected.searchParams.get("sr") !== "b" ||
    redirected.searchParams.get("sks") !== "b" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(redirected.searchParams.get("skv") ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(redirected.searchParams.get("sv") ?? "") ||
    !uuid.test(redirected.searchParams.get("skoid") ?? "") ||
    !uuid.test(redirected.searchParams.get("sktid") ?? "") ||
    !/^[a-f0-9]{64}$/u.test(redirected.searchParams.get("hmac") ?? "") ||
    !/^[A-Za-z0-9+/=]{16,512}$/u.test(redirected.searchParams.get("sig") ?? "") ||
    !Number.isFinite(Date.parse(redirected.searchParams.get("se") ?? "")) ||
    !Number.isFinite(Date.parse(redirected.searchParams.get("ske") ?? "")) ||
    !Number.isFinite(Date.parse(redirected.searchParams.get("skt") ?? ""))) {
    throw new Error("registry blob redirect is outside the closed policy");
  }
  return redirected.href;
}

// fetch one public GHCR object with a bounded anonymous pull token
async function fetchWeatherRegistryObject(repository, kind, digest, accept) {
  if (!/^weather-(server|web)$/u.test(repository) ||
    !ADJUSTMENT_RELEASE_DIGEST.test(digest) || !["blobs", "manifests"].includes(kind)) {
    throw new Error("registry object identity is invalid");
  }
  const url = `https://ghcr.io/v2/anstosa/${repository}/${kind}/${digest}`;
  const headers = { Accept: accept };
  let response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(300_000),
  });

  // obtain only an anonymous token for the fixed public repository
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const match = /^Bearer realm="(https:\/\/ghcr\.io\/token)",service="ghcr\.io",scope="(repository:anstosa\/weather-(?:server|web):pull)"$/u.exec(challenge);
    if (match === null || match[2] !== `repository:anstosa/${repository}:pull`) {
      throw new Error("registry authentication challenge is invalid");
    }
    await response.body?.cancel();
    const tokenResponse = await fetch(
      `${match[1]}?service=ghcr.io&scope=${encodeURIComponent(match[2])}`,
      { redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
    if (!tokenResponse.ok) {
      throw new Error("registry token request failed");
    }
    const tokenBytes = await readBoundedRegistryResponse(tokenResponse, 16_384, "registry token");
    const token = JSON.parse(tokenBytes.toString("utf8")).token;
    if (typeof token !== "string" || token.length < 1 || token.length > 8_192) {
      throw new Error("registry token is invalid");
    }
    response = await fetch(url, {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    });
  }

  // follow only the fixed signed GHCR blob handoff without its bearer token
  if (response.status === 307) {
    const redirectUrl = weatherRegistryBlobRedirectUrl(
      response.headers.get("location"),
      repository,
      digest,
    );
    if (kind !== "blobs") {
      throw new Error("registry manifest redirect is unsupported");
    }
    await response.body?.cancel();
    response = await fetch(redirectUrl, {
      headers: { Accept: accept },
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
  }
  if (!response.ok) {
    throw new Error(`registry ${kind} request failed`);
  }
  return response;
}

// parse one portable tar size field
function parseReleaseTarSize(header) {
  const bytes = header.subarray(124, 136);
  const text = bytes.toString("ascii").replace(/\0.*$/u, "").trim();

  // reject base-256 and noncanonical archive sizes
  if (!/^[0-7]{1,11}$/u.test(text)) {
    throw new Error("release layer tar size is invalid");
  }
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("release layer tar size is invalid");
  }
  return size;
}

// decode one bounded canonical tar path
function parseReleaseTarPath(bytes, description) {
  const nul = bytes.indexOf(0);
  const end = nul === -1 ? bytes.length : nul;

  // require zero padding and one exact UTF-8 representation
  if (nul !== -1 && bytes.subarray(nul).some((byte) => byte !== 0)) {
    throw new Error(`${description} padding is invalid`);
  }
  const path = bytes.subarray(0, end).toString("utf8");
  if (!Buffer.from(path, "utf8").equals(bytes.subarray(0, end)) ||
    Buffer.byteLength(path) < 1 || Buffer.byteLength(path) > 4_095 ||
    /[\u0000-\u001f\u007f\\]/u.test(path)) {
    throw new Error(`${description} is invalid`);
  }
  return path;
}

// normalize one extraction path without widening archive semantics
function releaseTarPathParts(path) {
  let normalized = path;

  // discard only explicit current-directory prefixes
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized.length === 0 || normalized === ".") return [];
  const parts = normalized.split("/");
  if (normalized.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("release layer tar path is unsafe");
  }
  return parts;
}

// parse one bounded local PAX header and return its path override
function parseReleasePaxPath(bytes) {
  let offset = 0;
  let path = null;
  const allowed = new Set([
    "atime", "ctime", "gid", "gname", "linkpath", "mtime", "path", "uid", "uname",
  ]);

  // validate every length-framed PAX record
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < offset + 2 || space > offset + 8) {
      throw new Error("release layer PAX framing is invalid");
    }
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]{1,6}$/u.test(lengthText)) {
      throw new Error("release layer PAX length is invalid");
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length ||
      bytes[end - 1] !== 0x0a) {
      throw new Error("release layer PAX record is incomplete");
    }
    const record = bytes.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("release layer PAX record is invalid");
    const key = record.subarray(0, equals).toString("ascii");
    if (!allowed.has(key) || key === "path" && path !== null) {
      throw new Error("release layer PAX keyword is unsupported");
    }

    // retain only the extraction path override
    if (key === "path") {
      path = parseReleaseTarPath(record.subarray(equals + 1), "release layer PAX path");
    }
    offset = end;
  }
  return path;
}

// verify one POSIX/GNU tar header checksum
function requireReleaseTarChecksum(header) {
  const checksumText = header.subarray(148, 156).toString("ascii")
    .replace(/\0.*$/u, "").trim();
  if (!/^[0-7]{1,7}$/u.test(checksumText)) {
    throw new Error("release layer tar checksum is invalid");
  }
  let checksum = 0;

  // treat the checksum field as spaces per the tar contract
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (checksum !== Number.parseInt(checksumText, 8)) {
    throw new Error("release layer tar checksum differs");
  }
}

// stream one gzip layer into a conservative filesystem allocation bound
export async function measureReleaseLayer(response, descriptor, expectedDiffId) {
  if (response.body === null || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 ||
    !ADJUSTMENT_RELEASE_DIGEST.test(descriptor.digest) ||
    !ADJUSTMENT_RELEASE_DIGEST.test(expectedDiffId)) {
    throw new Error("release layer descriptor is invalid");
  }
  const compressedHash = createHash("sha256");
  const uncompressedHash = createHash("sha256");
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let entryInodes = 0;
  let allocatedBytes = 0;
  let bodyBytes = 0;
  let bodyContentBytes = 0;
  let bodyKind = null;
  let bodyChunks = [];
  let pendingPath = null;
  let pendingLongLink = false;
  let terminatorBlocks = 0;
  let header = Buffer.alloc(0);

  // charge one materialized entry and every possibly implicit parent directory
  const accountPath = (path, size) => {
    const parts = releaseTarPathParts(path);
    const parentCount = Math.max(0, parts.length - 1);
    const addedInodes = 1 + parentCount;
    entryInodes = adjustmentReleaseSum(entryInodes, addedInodes);
    if (entryInodes > ADJUSTMENT_RELEASE_MAXIMUM_LAYER_INODES) {
      throw new Error("release layer inode count exceeds its bound");
    }
    allocatedBytes = adjustmentReleaseSum(
      allocatedBytes,
      adjustmentReleaseAllocated(size),
      adjustmentReleaseAllocated(Buffer.byteLength(path) + 1),
      parentCount * ADJUSTMENT_RELEASE_BLOCK_BYTES,
    );
    if (allocatedBytes > ADJUSTMENT_RELEASE_MAXIMUM_UNPACKED_LAYER_BYTES) {
      throw new Error("release layer allocation exceeds its bound");
    }
  };

  // apply one captured PAX or GNU long-name body to the following header
  const finishExtensionBody = () => {
    if (bodyKind === null) return;
    const bytes = Buffer.concat(bodyChunks);
    if (bodyKind === "x") {
      pendingPath = parseReleasePaxPath(bytes);
    } else {
      if (bytes.length < 2 || bytes.at(-1) !== 0 ||
        bytes.subarray(0, -1).includes(0)) {
        throw new Error("release layer GNU long value is invalid");
      }
      const value = parseReleaseTarPath(bytes.subarray(0, -1),
        `release layer GNU long ${bodyKind === "L" ? "path" : "link"}`);
      if (bodyKind === "L") pendingPath = value;
      else pendingLongLink = true;
    }
    bodyKind = null;
    bodyChunks = [];
    bodyContentBytes = 0;
  };
  const compressedCounter = new Transform({
    // verify exact compressed descriptor bytes while streaming
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > descriptor.size) {
        callback(new Error("release layer compressed size differs"));
        return;
      }
      compressedHash.update(chunk);
      callback(null, chunk);
    },
  });
  const tarCounter = new Transform({
    // retain at most one 512-byte tar header
    transform(chunk, _encoding, callback) {
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > ADJUSTMENT_RELEASE_MAXIMUM_UNPACKED_LAYER_BYTES) {
        callback(new Error("release layer unpacked stream exceeds its bound"));
        return;
      }
      uncompressedHash.update(chunk);
      let offset = 0;
      try {
        while (offset < chunk.length) {
          if (bodyBytes > 0) {
            const consumed = Math.min(bodyBytes, chunk.length - offset);
            const content = Math.min(bodyContentBytes, consumed);
            if (bodyKind !== null && content > 0) {
              bodyChunks.push(chunk.subarray(offset, offset + content));
            }
            bodyContentBytes -= content;
            bodyBytes -= consumed;
            offset += consumed;
            if (bodyBytes === 0) finishExtensionBody();
            continue;
          }
          const needed = 512 - header.length;
          const consumed = Math.min(needed, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + consumed)]);
          offset += consumed;
          if (header.length < 512) continue;
          const zero = header.every((byte) => byte === 0);
          if (zero) {
            terminatorBlocks += 1;
            header = Buffer.alloc(0);
            continue;
          }
          if (terminatorBlocks > 0) {
            throw new Error("release layer tar contains data after its terminator");
          }
          requireReleaseTarChecksum(header);
          const size = parseReleaseTarSize(header);
          const storedBytes = Math.ceil(size / 512) * 512;
          const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
          const magic = header.subarray(257, 263).toString("binary");
          const version = header.subarray(263, 265).toString("binary");
          if (!((magic === "ustar\0" && version === "00") ||
            (magic === "ustar " && version === " \0"))) {
            throw new Error("release layer tar format is unsupported");
          }
          const name = parseReleaseTarPath(header.subarray(0, 100), "release layer tar name");
          const prefixBytes = header.subarray(345, 500);
          const prefix = prefixBytes.every((byte) => byte === 0) ? null :
            parseReleaseTarPath(prefixBytes, "release layer tar prefix");
          const headerPath = prefix === null ? name : `${prefix}/${name}`;

          // capture only bounded local PAX and GNU long-name extensions
          if (["x", "L", "K"].includes(type)) {
            if (pendingPath !== null || pendingLongLink || size < 1 || size > 16_384) {
              throw new Error("release layer tar extension sequence is unsupported");
            }
            accountPath(headerPath, size);
            bodyKind = type;
            bodyContentBytes = size;
            bodyChunks = [];
          } else {
            if (!["0", "1", "2", "3", "4", "5", "6"].includes(type)) {
              throw new Error("release layer tar entry type is unsupported");
            }
            if (pendingLongLink && !["1", "2"].includes(type)) {
              throw new Error("release layer GNU long link is misplaced");
            }
            accountPath(pendingPath ?? headerPath, size);
            pendingPath = null;
            pendingLongLink = false;
          }
          bodyBytes = storedBytes;
          header = Buffer.alloc(0);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    // require a complete terminated tar stream
    flush(callback) {
      if (terminatorBlocks < 2 || header.length !== 0 || bodyBytes !== 0 ||
        bodyKind !== null || pendingPath !== null || pendingLongLink || entryInodes < 1) {
        callback(new Error("release layer tar framing is incomplete"));
        return;
      }
      callback();
    },
  });
  await pipeline(Readable.fromWeb(response.body), compressedCounter, createGunzip(), tarCounter);

  // verify descriptor and diff-id identities after complete consumption
  if (compressedBytes !== descriptor.size ||
    `sha256:${compressedHash.digest("hex")}` !== descriptor.digest ||
    `sha256:${uncompressedHash.digest("hex")}` !== expectedDiffId ||
    uncompressedBytes < 1) {
    throw new Error("release layer digest or size differs");
  }
  return {
    allocatedBytes: adjustmentReleaseAllocated(allocatedBytes),
    blobDigest: descriptor.digest,
    entryInodes,
  };
}

// inspect one pinned image and measure every literal layer without storing it
async function inspectRemoteReleaseImage(reference, layerMeasurements) {
  const match = ADJUSTMENT_RELEASE_REFERENCE.exec(reference);
  if (match === null) {
    throw new Error("release image reference is not pinned to the fixed repository");
  }
  const repository = `weather-${match[1]}`;
  const manifestDigest = `sha256:${match[2]}`;
  const manifestResponse = await fetchWeatherRegistryObject(
    repository,
    "manifests",
    manifestDigest,
    "application/vnd.oci.image.manifest.v1+json",
  );
  const manifestBytes = await readBoundedRegistryResponse(
    manifestResponse,
    1_048_576,
    "release image manifest",
  );
  if (`sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` !== manifestDigest) {
    throw new Error("release image manifest digest differs");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!ADJUSTMENT_RELEASE_DIGEST.test(manifest.config?.digest)) {
    throw new Error("release image config descriptor is invalid");
  }
  const configResponse = await fetchWeatherRegistryObject(
    repository,
    "blobs",
    manifest.config.digest,
    "application/vnd.oci.image.config.v1+json",
  );
  const configBytes = await readBoundedRegistryResponse(
    configResponse,
    4_194_304,
    "release image config",
  );
  if (`sha256:${createHash("sha256").update(configBytes).digest("hex")}` !==
    manifest.config.digest) {
    throw new Error("release image config digest differs");
  }
  const config = JSON.parse(configBytes.toString("utf8"));
  if (!Array.isArray(manifest.layers) || !Array.isArray(config.rootfs?.diff_ids) ||
    manifest.layers.length !== config.rootfs.diff_ids.length) {
    throw new Error("release image layers and config differ");
  }
  const compressedImageBytes = manifest.layers.reduce(
    // reject descriptor overflow and unbounded registry reads
    (total, layer) => adjustmentReleaseSum(total, layer.size),
    0,
  );
  if (compressedImageBytes > ADJUSTMENT_RELEASE_MAXIMUM_COMPRESSED_IMAGE_BYTES) {
    throw new Error("release image compressed layers exceed their bound");
  }
  const unpackedLayers = [];

  // fetch one copy of each content-addressed blob measurement
  for (const [index, descriptor] of manifest.layers.entries()) {
    const measurementKey = `${descriptor.digest}/${config.rootfs.diff_ids[index]}`;
    let measurement = layerMeasurements.get(measurementKey);
    if (measurement === undefined) {
      const layerResponse = await fetchWeatherRegistryObject(
        repository,
        "blobs",
        descriptor.digest,
        "application/vnd.oci.image.layer.v1.tar+gzip",
      );
      measurement = await measureReleaseLayer(
        layerResponse,
        descriptor,
        config.rootfs.diff_ids[index],
      );
      layerMeasurements.set(measurementKey, measurement);
    }
    unpackedLayers.push(measurement);
  }
  return {
    configBytes: configBytes.toString("utf8"),
    manifestBytes: manifestBytes.toString("utf8"),
    reference,
    unpackedLayers,
  };
}

// classify one no-follow Docker layer entry and its actual allocation
export function measureReleasePathEntry(details) {
  const overlayWhiteout = details.isCharacterDevice() && details.rdev === 0n;

  // accept only ordinary entries or the exact overlay2 whiteout representation
  if (!details.isDirectory() && !details.isFile() && !details.isSymbolicLink() &&
    !overlayWhiteout) {
    throw new Error("Docker layer contains an unsupported filesystem entry");
  }
  return {
    bytes: adjustmentReleaseAllocated(Number(details.blocks * 512n)),
    descend: details.isDirectory(),
    inodes: 1,
  };
}

// count actual blocks below one Docker layer without following links
function measureReleasePath(path) {
  const details = lstatSync(path, { bigint: true });
  const entry = measureReleasePathEntry(details);
  let bytes = entry.bytes;
  let inodes = entry.inodes;

  // descend through real directories only
  if (entry.descend) {
    for (const name of readdirSync(path)) {
      const child = measureReleasePath(join(path, name));
      bytes = adjustmentReleaseSum(bytes, child.bytes);
      inodes = adjustmentReleaseSum(inodes, child.inodes);
    }
  }
  return { bytes: adjustmentReleaseAllocated(bytes), inodes };
}

// collect actual local Docker parent-chain allocation for one retained image
function inspectLocalReleaseImage(reference, remoteImage) {
  let output;
  try {
    output = execFileSync("docker", ["image", "inspect", "--format", "{{json .}}", reference], {
      encoding: "utf8",
      maxBuffer: 8 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  if (Buffer.byteLength(output) > 8 * 1_024 * 1_024) {
    throw new Error("local Docker image inspection exceeds its bound");
  }
  const inspected = JSON.parse(output);
  const config = JSON.parse(remoteImage.configBytes);
  const paths = [];
  const lower = inspected.GraphDriver?.Data?.LowerDir;
  const upper = inspected.GraphDriver?.Data?.UpperDir;

  // bind local identity, platform and diff-id sequence to registry config
  if (inspected.Id !== JSON.parse(remoteImage.manifestBytes).config.digest ||
    inspected.Architecture !== "arm64" || inspected.Os !== "linux" ||
    inspected.GraphDriver?.Name !== "overlay2" ||
    JSON.stringify(inspected.RootFS?.Layers) !== JSON.stringify(config.rootfs.diff_ids)) {
    throw new Error("local Docker image identity differs from registry config");
  }
  if (typeof lower === "string" && lower.length > 0) {
    paths.push(...lower.split(":").reverse());
  }
  if (typeof upper === "string" && upper.length > 0) {
    paths.push(upper);
  }
  if (paths.length !== config.rootfs.diff_ids.length ||
    paths.some((path) => !path.startsWith("/var/lib/docker/overlay2/") || !path.endsWith("/diff"))) {
    throw new Error("local Docker layer paths are unavailable or unsupported");
  }
  const inventory = [];
  const diffIds = [];

  // measure each literal parent chain once
  for (const [index, diffId] of config.rootfs.diff_ids.entries()) {
    diffIds.push(diffId);
    const measured = measureReleasePath(paths[index]);
    inventory.push({
      allocatedBytes: measured.bytes,
      chainId: dockerChainIdentity(diffIds),
    });
  }
  return inventory;
}

// measure fixed release/control state without following symlinks
function measureReleaseControlRoot() {
  const root = resolve(dirname(import.meta.filename), "../..");
  return measureReleasePath(root).bytes;
}

// collect the literal fixed-scope release inventory
async function collectFixedInertV13ReleaseCapacity(sourceServer, sourceWeb, targetServer, targetWeb) {
  const references = [sourceServer, sourceWeb, targetServer, targetWeb];
  const layerMeasurements = new Map();
  const remote = new Map();

  // bind all unique source and target image bytes from GHCR
  for (const reference of references) {
    if (!remote.has(reference)) {
      remote.set(reference, await inspectRemoteReleaseImage(reference, layerMeasurements));
    }
  }
  const sourceImages = [remote.get(sourceServer), remote.get(sourceWeb)];
  const targetImages = [remote.get(targetServer), remote.get(targetWeb)];
  const inventoryByChain = new Map();

  // merge one exact locally allocated image into the physical inventory
  const mergeLocalImage = (image, required) => {
    const local = inspectLocalReleaseImage(image.reference, image);
    if (required && local.length === 0) {
      throw new Error("fixed v13 source image is not locally measurable");
    }
    for (const layer of local) {
      const old = inventoryByChain.get(layer.chainId);
      if (old !== undefined && old !== layer.allocatedBytes) {
        throw new Error("local Docker layer allocation differs across release images");
      }
      inventoryByChain.set(layer.chainId, layer.allocatedBytes);
    }
  };

  // source must exist; an already-pulled target is measured without baseline reset
  for (const image of sourceImages) mergeLocalImage(image, true);
  for (const image of targetImages) mergeLocalImage(image, false);
  const filesystem = statfsSync("/var/lib/weather", { bigint: true });
  const freeBytesBig = filesystem.bavail * filesystem.bsize;
  if (freeBytesBig > BigInt(Number.MAX_SAFE_INTEGER) || filesystem.ffree > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("release filesystem capacity exceeds exact integer precision");
  }
  const roleImage = (role, runtime, reference) => ({
    ...structuredClone(remote.get(reference)),
    role,
    runtime,
  });
  const record = {
    compensationScope: ADJUSTMENT_RELEASE_COMPENSATION_SCOPE,
    freeBytes: Number(freeBytesBig),
    freeInodes: Number(filesystem.ffree),
    images: [
      roleImage("source", "server", sourceServer),
      roleImage("source", "web", sourceWeb),
      roleImage("target", "server", targetServer),
      roleImage("target", "web", targetWeb),
      roleImage("compensating", "server", sourceServer),
      roleImage("compensating", "web", sourceWeb),
    ],
    inventory: [...inventoryByChain.entries()].map(([chainId, allocatedBytes]) => ({
      allocatedBytes,
      chainId,
    })).sort((left, right) => left.chainId.localeCompare(right.chainId)),
    measuredAt: new Date().toISOString(),
    retainedControlBytes: measureReleaseControlRoot(),
    runtimePackageBytes: 0,
    sourceRelease: ADJUSTMENT_RELEASE_SOURCE_RELEASE,
    version: ADJUSTMENT_RELEASE_INVENTORY_VERSION,
  };
  return evaluateAdjustmentReleaseCapacity(
    collectAdjustmentReleaseCapacityInventory(record),
  );
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

  // frame one function-only availability response
  if (command === "frame-v2-availability") {
    if (argumentsList.length !== 1) {
      throw new Error("usage: adjustment-evaluation-package.mjs frame-v2-availability REGISTRATION_SHA256");
    }
    const bytes = await frameAdjustmentConfirmationAvailabilityV2({
      registrationSha256: argumentsList[0],
    });
    await writeChunk(process.stdout, bytes);
    return;
  }

  // require exact v2 ledger readiness without adding data authority
  if (command === "verify-v2-readiness") {
    if (argumentsList.length !== 0) {
      throw new Error("usage: adjustment-evaluation-package.mjs verify-v2-readiness");
    }
    const response = await readV2DatabaseResponse();
    if (response.payload !== null) {
      throw new Error("maintenance readiness payload must be null");
    }
    return;
  }

  // frame one persisted-burn authorization response
  if (command === "frame-v2-authorization") {
    if (argumentsList.length !== 3 || !/^(?:0|[1-9][0-9]?)$/u.test(argumentsList[2])) {
      throw new Error("usage: adjustment-evaluation-package.mjs frame-v2-authorization REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX");
    }
    const bytes = await frameAdjustmentConfirmationAuthorizationV2({
      accessSha256: argumentsList[1],
      chunkIndex: Number(argumentsList[2]),
      registrationSha256: argumentsList[0],
    });
    await writeChunk(process.stdout, bytes);
    return;
  }

  // print the authorized inclusive legacy observation interval
  if (command === "v2-authorization-dates") {
    if (argumentsList.length !== 1) {
      throw new Error("usage: adjustment-evaluation-package.mjs v2-authorization-dates AUTHORIZATION_ENVELOPE");
    }
    const authorization = await readV2AuthorizationEnvelope(argumentsList[0]);
    process.stdout.write(
      `${authorization.payload.fromLocalDate} ${addV2CalendarDays(
        authorization.payload.toLocalDateExclusive,
        -1,
      )}\n`,
    );
    return;
  }

  // stream one prehashed v2 envelope around the unchanged v1 package
  if (command === "stream-v2-envelope") {
    if (argumentsList.length !== 5 && argumentsList.length !== 6) {
      throw new Error("usage: adjustment-evaluation-package.mjs stream-v2-envelope KIND SOURCE_ARCHIVE FROM TO EDGE_SNAPSHOT [AUTHORIZATION_ENVELOPE]");
    }
    const [exportKind, sourceArchivePath, fromLocalDate, toLocalDate,
      edgeSnapshotPath, authorizationPath] = argumentsList;
    await streamAdjustmentEvaluationV2EnvelopeArchive({
      authorizationPath: authorizationPath ?? null,
      edgeSnapshotPath,
      exportKind,
      fromLocalDate,
      sourceArchivePath,
      toLocalDate,
    });
    return;
  }

  // verify one bounded framed stream and publish its canonical header
  if (command === "verify-v2-stream") {
    if (argumentsList.length !== 2) {
      throw new Error("usage: adjustment-evaluation-package.mjs verify-v2-stream FRAME ENVELOPE_OUTPUT");
    }
    const verified = await verifyAdjustmentEvaluationV2Stream(argumentsList[0]);
    await writeFile(argumentsList[1], verified.headerBytes, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${verified.payloadOffset} ${verified.payloadBytes}\n`);
    return;
  }

  // verify one normalized local v2 package
  if (command === "verify-v2-envelope") {
    if (argumentsList.length !== 2) {
      throw new Error("usage: adjustment-evaluation-package.mjs verify-v2-envelope ENVELOPE PACKAGE_ROOT");
    }
    const verified = await verifyAdjustmentEvaluationV2EnvelopePackage({
      envelopePath: argumentsList[0],
      packageRoot: argumentsList[1],
    });
    process.stdout.write(`${verified.envelopeSha256}\n`);
    return;
  }

  // verify one normalized value-free availability envelope
  if (command === "verify-v2-availability") {
    if (argumentsList.length !== 1) {
      throw new Error("usage: adjustment-evaluation-package.mjs verify-v2-availability ENVELOPE");
    }
    process.stdout.write(
      `${await verifyAdjustmentConfirmationAvailabilityV2(argumentsList[0])}\n`,
    );
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

  // collect and enforce the fixed inert v13 literal image capacity
  if (command === "release-capacity") {
    if (argumentsList.length !== 4) {
      throw new Error("usage: adjustment-evaluation-package.mjs release-capacity SOURCE_SERVER SOURCE_WEB TARGET_SERVER TARGET_WEB");
    }
    const receipt = await collectFixedInertV13ReleaseCapacity(...argumentsList);
    process.stdout.write(`${canonicalJsonValue(receipt)}\n`);

    // preserve the complete refusal receipt while returning a failing gate
    if (receipt.state !== "capacity_ready") {
      process.exitCode = 3;
    }
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
