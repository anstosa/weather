import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION =
  "forecast-adjustment-evidence-object/v1";
export const ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION =
  "forecast-adjustment-edge-receipt/v1";
export const ADJUSTMENT_EVIDENCE_SNAPSHOT_CONTRACT_VERSION =
  "forecast-adjustment-evidence-snapshot/v1";
export const ADJUSTMENT_EVIDENCE_DEFAULT_ROOT =
  "/var/lib/weather/xweather/adjustment-evidence";

const OBJECT_MAXIMUM_BYTES = 512 * 1_024;
const COMPRESSED_OBJECT_MAXIMUM_BYTES = 16 * 1_024;
const RECEIPT_MAXIMUM_BYTES = 16 * 1_024;
const MAXIMUM_COMPRESSION_RATIO = 64;
const MAXIMUM_ROWS = 240;
const MAXIMUM_IDENTITIES = 8_192;
const LEDGER_ALLOCATION_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
const EXPORT_RESERVATION_BYTES = 64 * 1_024 * 1_024;
const OPERATIONAL_MARGIN_BYTES = 16 * 1_024 * 1_024;
const FREE_SPACE_FLOOR_BYTES = 1_879_048_192;
const FREE_INODE_FLOOR = 32_768;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBJECT_FILENAME_PATTERN = /^sha256-([a-f0-9]{64})\.json\.gz$/u;
const RECEIPT_FILENAME_PATTERN = /^sha256-([a-f0-9]{64})\.json$/u;
const WINDOWS = ["days=1", "days=5", "days=10", "overnight"];
const WIND_DECISION_STATES = ["active", "disabled", "not_applicable"];
const SOURCE_DECISION_STATES = ["active", "disabled", "raw_fallback"];
const RAW_METRICS = [
  "precipitationMm",
  "temperatureC",
  "windGustMps",
  "windSpeedMps",
];
const ADJUSTED_METRICS = [
  "apparentTemperatureC",
  "relativeHumidityPercent",
  "temperatureC",
  "windDirectionDegrees",
  "windGustMps",
  "windSpeedMps",
];

// keep capture errors outside the response path
export class AdjustmentEvidenceStore {
  #allocatedBytes = 0;
  #blockedIdentities = new Set();
  #initialized = false;
  #objectCount = 0;
  #options;
  #queue = Promise.resolve();
  #receiptCount = 0;
  #status = {
    asyncErrors: 0,
    asyncGaps: 0,
    bytes: 0,
    capacityExhausted: 0,
    closeWithoutFinish: 0,
    collisions: 0,
    finishedSuccesses: 0,
    freeSpaceRefusal: 0,
    inodeRefusal: 0,
    objectTooLarge: 0,
    objects: 0,
    provenanceIncomplete: 0,
  };

  // retain injectable boundaries for deterministic fault tests
  constructor(options = {}) {
    this.#options = {
      beforeObjectWrite: options.beforeObjectWrite ?? (() => undefined),
      now: options.now ?? (() => new Date()),
      root: resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT),
      statfs: options.statfs ?? ((path) => statfs(path, { bigint: true })),
      writeExclusive: options.writeExclusive ?? writeExclusive,
    };
  }

  // create and scan the bounded immutable store
  async initialize() {
    try {
      await ensureEvidenceDirectories(this.#options.root);
      const scan = await scanEvidenceDirectories(this.#options.root, true);
      this.#allocatedBytes = scan.allocatedBytes;
      this.#objectCount = scan.objectCount;
      this.#receiptCount = scan.receiptCount;
      this.#status.bytes = scan.allocatedBytes;
      this.#status.objects = scan.objectCount;
      this.#initialized = true;
    } catch {
      this.#status.asyncErrors += 1;
      this.#initialized = false;
    }
    return this;
  }

  // derive immutable capture bytes before writing the response
  prepare(filteredBody, window) {
    // refuse capture while filesystem integrity is unknown
    if (!this.#initialized) {
      this.#status.asyncGaps += 1;
      return null;
    }

    try {
      return createAdjustmentEvidenceCapture(filteredBody, window);
    } catch (error) {
      // classify only bounded projection failures
      if (error?.code === "adjustment_evidence_object_too_large") {
        this.#status.objectTooLarge += 1;
      } else {
        this.#status.asyncErrors += 1;
      }
      this.#status.asyncGaps += 1;
      return null;
    }
  }

  // attach persistence only to Node's successful finish event
  trackResponse(response, prepared) {
    let finished = false;

    // persist asynchronously only after the response commits
    response.once("finish", () => {
      finished = true;

      // retain one explicit capture gap when preparation failed
      if (prepared === null) {
        return;
      }

      const firstEdgeCommittedAt = this.#options.now().toISOString();
      void this.commit(prepared, firstEdgeCommittedAt).catch(
        // contain all filesystem failures after response completion
        () => {
          this.#status.asyncErrors += 1;
          this.#status.asyncGaps += 1;
        },
      );
    });

    // distinguish aborted sockets from successfully finished responses
    response.once("close", () => {
      if (!finished) {
        this.#status.closeWithoutFinish += 1;
      }
    });
  }

  // serialize exclusive writes and capacity accounting
  async commit(prepared, firstEdgeCommittedAt) {
    const operation = this.#queue.then(
      // keep one writer inside the allocation guard
      () => this.#commitExclusive(prepared, firstEdgeCommittedAt),
    );
    this.#queue = operation.catch(() => undefined);
    return await operation;
  }

  // return bounded in-memory health counters only
  status() {
    return Object.freeze({ ...this.#status });
  }

  // write one content object and one first-issuance receipt
  async #commitExclusive(prepared, firstEdgeCommittedAt) {
    requireInstant(firstEdgeCommittedAt, "firstEdgeCommittedAt");

    // stop prepared work after any integrity-threatening write failure
    if (!this.#initialized) {
      this.#status.asyncGaps += 1;
      return { status: "store_unavailable" };
    }

    // stop a known collision identity without attempting repair
    if (this.#blockedIdentities.has(prepared.edgeReceiptIdentitySha256)) {
      this.#status.asyncGaps += 1;
      return { status: "identity_collision" };
    }

    const objectPath = evidenceObjectPath(this.#options.root, prepared.objectSha256);
    const receiptPath = evidenceReceiptPath(
      this.#options.root,
      prepared.edgeReceiptIdentitySha256,
    );
    const receiptExists = await regularFileExists(receiptPath);

    // honor an existing first receipt before creating any content object
    if (receiptExists) {
      const existing = await readReceipt(receiptPath, prepared.edgeReceiptIdentitySha256);

      // block a stable identity already bound to different scoring content
      if (existing.objectSha256 !== prepared.objectSha256) {
        this.#blockedIdentities.add(prepared.edgeReceiptIdentitySha256);
        this.#status.collisions += 1;
        this.#status.asyncGaps += 1;
        await this.#refreshAllocationFromDisk();
        return { status: "identity_collision" };
      }

      const existingObject = await readRegularFile(
        objectPath,
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
      );

      // require the receipt's immutable object to remain byte-identical
      if (!existingObject.equals(prepared.compressedObject)) {
        throw new Error("adjustment evidence receipt object is invalid");
      }

      await this.#refreshAllocationFromDisk();
      return { status: "duplicate" };
    }

    const objectExists = await regularFileExists(objectPath);
    const receipt = createReceipt(prepared, firstEdgeCommittedAt);
    const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`);

    // enforce the independent receipt bound before filesystem work
    if (receiptBytes.byteLength > RECEIPT_MAXIMUM_BYTES) {
      this.#status.objectTooLarge += 1;
      this.#status.asyncGaps += 1;
      return { status: "object_too_large" };
    }

    const filesystem = await this.#options.statfs(this.#options.root);
    const blockSize = Number(filesystem.bsize);
    const prospectiveBytes =
      (objectExists ? 0 : allocatedSize(prepared.compressedObject.byteLength, blockSize)) +
      (receiptExists ? 0 : allocatedSize(receiptBytes.byteLength, blockSize));

    // keep identities and allocated bytes inside the frozen envelope
    if (
      (!objectExists && this.#objectCount >= MAXIMUM_IDENTITIES) ||
      (!receiptExists && this.#receiptCount >= MAXIMUM_IDENTITIES) ||
      this.#allocatedBytes + prospectiveBytes > LEDGER_ALLOCATION_MAXIMUM_BYTES
    ) {
      this.#status.capacityExhausted += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    const freeBytes = Number(filesystem.bavail * filesystem.bsize);
    const freeInodes = Number(filesystem.ffree);

    // preserve the shared filesystem floor and export reservation
    if (freeBytes - prospectiveBytes <
      FREE_SPACE_FLOOR_BYTES + EXPORT_RESERVATION_BYTES + OPERATIONAL_MARGIN_BYTES) {
      this.#status.freeSpaceRefusal += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    // retain enough free inodes for host operations
    if (freeInodes < FREE_INODE_FLOOR) {
      this.#status.inodeRefusal += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    let objectCreated;

    try {
      await this.#options.beforeObjectWrite();
      objectCreated = await writeOrVerifyImmutable(
        objectPath,
        prepared.compressedObject,
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
        this.#options.writeExclusive,
      );
    } catch (error) {
      // reconcile any complete or injected partial final before disabling capture
      await this.#reconcileWriteFailure();
      throw error;
    }

    // account an object before any receipt race or failure can return
    this.#applyCreatedAllocation(objectCreated, false, prepared, receiptBytes, blockSize);

    let receiptCreated;

    try {
      receiptCreated = await writeOrVerifyReceipt(
        receiptPath,
        receiptBytes,
        prepared,
        this.#options.writeExclusive,
      );
    } catch (error) {
      // retain an orphan immutable object as an explicit gap
      if (objectCreated) {
        this.#status.asyncGaps += 1;
      }
      await this.#reconcileWriteFailure();
      throw error;
    }

    // a concurrent first writer may have bound a different object
    if (!receiptCreated) {
      const existing = await readReceipt(receiptPath, prepared.edgeReceiptIdentitySha256);

      if (existing.objectSha256 !== prepared.objectSha256) {
        this.#blockedIdentities.add(prepared.edgeReceiptIdentitySha256);
        this.#status.collisions += 1;
        this.#status.asyncGaps += 1;
        await this.#refreshAllocationFromDisk();
        return { status: "identity_collision" };
      }
    }

    this.#applyCreatedAllocation(
      false,
      receiptCreated,
      prepared,
      receiptBytes,
      blockSize,
    );

    // count only the writer that retained the first receipt
    if (receiptCreated) {
      // reconcile an object published by another writer after our last scan
      if (!objectCreated) {
        await this.#refreshAllocationFromDisk();
      }
      this.#status.finishedSuccesses += 1;
      this.#status.provenanceIncomplete += prepared.object.rows.length;
      return { status: "created" };
    }

    await this.#refreshAllocationFromDisk();
    return { status: "duplicate" };
  }

  // refresh global immutable allocation after a cross-writer observation
  async #refreshAllocationFromDisk() {
    const scan = await scanEvidenceDirectories(this.#options.root, false);
    this.#allocatedBytes = scan.allocatedBytes;
    this.#objectCount = scan.objectCount;
    this.#receiptCount = scan.receiptCount;
    this.#status.bytes = scan.allocatedBytes;
    this.#status.objects = scan.objectCount;
  }

  // account retained finals and stop further capture after a write fault
  async #reconcileWriteFailure() {
    try {
      await this.#refreshAllocationFromDisk();
    } finally {
      this.#initialized = false;
    }
  }

  // apply only allocations created by this process
  #applyCreatedAllocation(objectCreated, receiptCreated, prepared, receiptBytes, blockSize) {
    // update immutable object allocation once
    if (objectCreated) {
      this.#objectCount += 1;
      this.#allocatedBytes += allocatedSize(prepared.compressedObject.byteLength, blockSize);
    }

    // update immutable receipt allocation once
    if (receiptCreated) {
      this.#receiptCount += 1;
      this.#allocatedBytes += allocatedSize(receiptBytes.byteLength, blockSize);
    }

    this.#status.bytes = this.#allocatedBytes;
    this.#status.objects = this.#objectCount;
  }
}

// normalize only supported direct forecast GET query shapes
export function normalizeAdjustmentEvidenceWindow(requestUrl) {
  const entries = [...requestUrl.searchParams.entries()];

  // retain the dedicated overnight query
  if (entries.length === 1 && entries[0][0] === "window" && entries[0][1] === "overnight") {
    return "overnight";
  }

  // treat the API's empty query as its one-day default
  if (entries.length === 0) {
    return "days=1";
  }

  // retain one reviewed daily query only
  if (entries.length === 1 && entries[0][0] === "days" &&
    ["1", "5", "10"].includes(entries[0][1])) {
    return `days=${entries[0][1]}`;
  }

  return null;
}

// create one deterministic object and its stable identity
export function createAdjustmentEvidenceCapture(filteredBody, window) {
  if (!WINDOWS.includes(window)) {
    throw new TypeError("adjustment evidence window is invalid");
  }

  const forecast = JSON.parse(Buffer.from(filteredBody).toString("utf8"));

  // require one successful filtered forecast envelope
  if (forecast === null || typeof forecast !== "object" || !Array.isArray(forecast.data) ||
    forecast.data.length < 1 || forecast.data.length > MAXIMUM_ROWS) {
    throw new TypeError("forecast evidence body is invalid");
  }

  const settingsSha256 = sha256(canonicalJson(forecast.adjustmentSettings));
  const bundleIdentities = projectBundleIdentities(forecast);
  const availability = projectAvailability(forecast.data);
  const rows = forecast.data.map(
    // preserve response order for row-to-availability joins
    (row) => projectEvidenceRow(row),
  );
  const object = {
    bundleIdentities,
    contractVersion: ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION,
    rows,
    settingsSha256,
    siteKey: "ballydidean",
    window,
  };
  const canonicalObject = Buffer.from(canonicalJson(object));

  // bound canonical bytes before compression
  if (canonicalObject.byteLength > OBJECT_MAXIMUM_BYTES) {
    throw objectTooLargeError();
  }

  const compressedObject = gzipSync(canonicalObject, { level: 9, mtime: 0 });

  // reject oversized or suspiciously compressed objects
  if (compressedObject.byteLength > COMPRESSED_OBJECT_MAXIMUM_BYTES ||
    canonicalObject.byteLength > compressedObject.byteLength * MAXIMUM_COMPRESSION_RATIO) {
    throw objectTooLargeError();
  }

  const stableIdentity = {
    bundleIdentities,
    rows: rows.map(
      // exclude all scoring values from the stable record identity
      (row) => ({ record: row.record, source: row.source }),
    ),
    settingsSha256,
    siteKey: "ballydidean",
    window,
  };

  return Object.freeze({
    availability,
    compressedObject,
    edgeReceiptIdentitySha256: sha256(canonicalJson(stableIdentity)),
    object,
    objectSha256: sha256(canonicalObject),
  });
}

// freeze and validate every receipt selected at snapshot start
export async function freezeAdjustmentEvidenceSnapshot(options = {}) {
  const root = resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT);
  const now = options.now ?? (() => new Date());
  await validateEvidenceDirectories(root);
  const receiptDirectory = join(root, "receipts");
  const names = (await readdir(receiptDirectory)).sort();

  // reject unbounded or unexpected receipt directory contents
  if (names.length > MAXIMUM_IDENTITIES || names.some((name) => !RECEIPT_FILENAME_PATTERN.test(name))) {
    throw new Error("adjustment evidence receipt directory is invalid");
  }

  const entries = [];

  // validate the frozen list without observing later receipts
  for (const name of names) {
    const identity = RECEIPT_FILENAME_PATTERN.exec(name)?.[1];
    const receiptPath = evidenceReceiptPath(root, identity);
    const receipt = await readReceipt(receiptPath, identity);
    const objectPath = evidenceObjectPath(root, receipt.objectSha256);
    const objectBytes = await readRegularFile(
      objectPath,
      COMPRESSED_OBJECT_MAXIMUM_BYTES,
    );
    const canonicalObject = gunzipBounded(objectBytes);

    // bind compressed bytes to the content-addressed canonical object
    if (sha256(canonicalObject) !== receipt.objectSha256) {
      throw new Error("adjustment evidence object hash is invalid");
    }

    const object = JSON.parse(canonicalObject.toString("utf8"));
    validateEvidenceObject(object);

    // require canonical deterministic content at the export boundary
    if (!Buffer.from(canonicalJson(object)).equals(canonicalObject) ||
      !gzipSync(canonicalObject, { level: 9, mtime: 0 }).equals(objectBytes)) {
      throw new Error("adjustment evidence object encoding is invalid");
    }

    // bind row availability and stable identity to the selected object
    if (receipt.availability.rowTimestampIndexes.length !== object.rows.length ||
      stableIdentitySha256(object) !== identity ||
      receipt.window !== object.window) {
      throw new Error("adjustment evidence receipt pairing is invalid");
    }
    entries.push({
      edgeReceiptIdentitySha256: identity,
      objectPath,
      objectSha256: receipt.objectSha256,
      receiptPath,
    });
  }

  const watermarkSha256 = sha256(canonicalJson(entries.map(
    // exclude host paths from the portable watermark
    (entry) => ({
      edgeReceiptIdentitySha256: entry.edgeReceiptIdentitySha256,
      objectSha256: entry.objectSha256,
    }),
  )));
  return Object.freeze({
    contractVersion: ADJUSTMENT_EVIDENCE_SNAPSHOT_CONTRACT_VERSION,
    entries: Object.freeze(entries),
    frozenAt: now().toISOString(),
    watermarkSha256,
  });
}

// create the first-observed availability receipt
function createReceipt(prepared, firstEdgeCommittedAt) {
  return {
    availability: prepared.availability,
    contractVersion: ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION,
    edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
    firstEdgeCommittedAt,
    objectSha256: prepared.objectSha256,
    siteKey: "ballydidean",
    window: prepared.object.window,
  };
}

// retain only active response-level serving identities
function projectBundleIdentities(forecast) {
  return {
    rain: {
      activeBundle: nullableSha256(forecast.rainAdjustmentRuntime?.activeBundle),
    },
    temperature: {
      activeBundle: nullableSha256(forecast.temperatureAdjustmentRuntime?.activeBundle),
      authorizationSha256: nullableSha256(
        forecast.temperatureAdjustmentRuntime?.authorizationSha256,
      ),
    },
    wind: {
      activeBundle: nullableSha256(forecast.adjustmentRuntime?.activeBundle),
      authorizationSha256: nullableSha256(forecast.adjustmentRuntime?.authorizationSha256),
      candidateArtifactSha256: nullableSha256(
        forecast.adjustmentRuntime?.candidateArtifactSha256,
      ),
    },
  };
}

// group mutable first-observed timestamps by ordered row index
function projectAvailability(rows) {
  const indexes = new Map();
  const timestamps = [];
  const rowTimestampIndexes = rows.map(
    // retain each distinct mutable timestamp only once
    (row) => {
      requireInstant(row?.receivedAt, "row.receivedAt");
      let index = indexes.get(row.receivedAt);

      // add one first-seen canonical timestamp
      if (index === undefined) {
        index = timestamps.length;
        indexes.set(row.receivedAt, index);
        timestamps.push(row.receivedAt);
      }

      return index;
    },
  );
  return { rowTimestampIndexes, timestamps };
}

// project one closed scoring row without volatile response metadata
function projectEvidenceRow(row) {
  if (row === null || typeof row !== "object") {
    throw new TypeError("forecast evidence row is invalid");
  }

  return {
    provenanceComplete: false,
    rainAdjustment: projectRainAdjustment(row.rainAdjustment),
    raw: projectMetricValues(row.metrics, RAW_METRICS, "row.metrics"),
    record: {
      id: requireBoundedString(row.id, "row.id"),
      productRunAt: nullableInstant(row.productRunAt, "row.productRunAt"),
      revisionCount: requireRevisionCount(row.revisionCount),
      validAt: instant(row.validAt, "row.validAt"),
    },
    source: {
      dataset: nullableBoundedString(row.metadata?.provider?.dataset, "row.metadata.provider.dataset"),
      providerKey: requireBoundedString(row.provenance?.providerKey, "row.provenance.providerKey"),
      sourceId: requireBoundedString(row.provenance?.sourceId, "row.provenance.sourceId"),
      sourceKey: requireBoundedString(row.provenance?.sourceKey, "row.provenance.sourceKey"),
      upstreamModel: nullableBoundedString(row.metadata?.upstream?.model, "row.metadata.upstream.model"),
    },
    temperatureAdjustment: projectTemperatureAdjustment(row.temperatureAdjustment),
    windAdjustment: projectWindAdjustment(row.adjustment),
  };
}

// retain post-settings generic decision fields only
function projectWindAdjustment(value) {
  const decision = requireDecision(value, "row.adjustment");
  const adjustedMetrics = projectMetricValues(
    decision.adjustedMetrics ?? {},
    ADJUSTED_METRICS,
    "row.adjustment.adjustedMetrics",
    true,
  );
  return {
    adjustedMetrics,
    appliedMetrics: requireStringArray(decision.appliedMetrics ?? [], "row.adjustment.appliedMetrics"),
    authorizationSha256: nullableSha256(decision.authorizationSha256),
    candidateArtifactSha256: nullableSha256(decision.candidateArtifactSha256),
    leadBand: nullableBoundedString(decision.leadBand, "row.adjustment.leadBand"),
    reasonCode: nullableBoundedString(decision.reasonCode, "row.adjustment.reasonCode"),
    state: requireState(decision.state, "row.adjustment.state", WIND_DECISION_STATES),
  };
}

// retain temperature amount, reason and immutable source receipt fields
function projectTemperatureAdjustment(value) {
  const decision = requireDecision(value, "row.temperatureAdjustment");
  return {
    branch: nullableBoundedString(decision.branch, "row.temperatureAdjustment.branch"),
    bundleSha256: nullableSha256(decision.bundleSha256),
    correctedTemperatureC: nullableFinite(
      decision.correctedTemperatureC,
      "row.temperatureAdjustment.correctedTemperatureC",
    ),
    rawBestMatchTemperatureC: nullableFinite(
      decision.rawBestMatchTemperatureC,
      "row.temperatureAdjustment.rawBestMatchTemperatureC",
    ),
    reasonCode: nullableBoundedString(
      decision.reasonCode,
      "row.temperatureAdjustment.reasonCode",
    ),
    sourceForecast: projectTemperatureSource(decision.sourceForecast),
    state: requireState(decision.state, "row.temperatureAdjustment.state", SOURCE_DECISION_STATES),
  };
}

// retain only the closed temperature source forecast
function projectTemperatureSource(value) {
  if (value === null || value === undefined) {
    return null;
  }

  requirePlainObject(value, "row.temperatureAdjustment.sourceForecast");
  return {
    adapterVersion: requireBoundedString(value.adapterVersion, "temperature.source.adapterVersion"),
    dataset: requireBoundedString(value.dataset, "temperature.source.dataset"),
    firstReceivedAt: instant(value.firstReceivedAt, "temperature.source.firstReceivedAt"),
    modelCycle: requireBoundedString(value.modelCycle, "temperature.source.modelCycle"),
    modelLeadHours: requireBoundedInteger(value.modelLeadHours, "temperature.source.modelLeadHours"),
    operationalHorizonHours: requireBoundedInteger(
      value.operationalHorizonHours,
      "temperature.source.operationalHorizonHours",
    ),
    providerKey: requireBoundedString(value.providerKey, "temperature.source.providerKey"),
    providerResponseSha256: requireSha256(value.providerResponseSha256, "temperature.source.providerResponseSha256"),
    rawRelativeHumidityPercent: nullableFinite(value.rawRelativeHumidityPercent, "temperature.source.rawRelativeHumidityPercent"),
    rawTemperatureC: finite(value.rawTemperatureC, "temperature.source.rawTemperatureC"),
    rawWindSpeedMps: nullableFinite(value.rawWindSpeedMps, "temperature.source.rawWindSpeedMps"),
    runInitializedAt: instant(value.runInitializedAt, "temperature.source.runInitializedAt"),
    upstreamModel: requireBoundedString(value.upstreamModel, "temperature.source.upstreamModel"),
    validAt: instant(value.validAt, "temperature.source.validAt"),
  };
}

// retain rain amount, reason and immutable source receipt fields
function projectRainAdjustment(value) {
  const decision = requireDecision(value, "row.rainAdjustment");
  return {
    bundleSha256: nullableSha256(decision.bundleSha256),
    correctedPrecipitationMm: nullableFinite(
      decision.correctedPrecipitationMm,
      "row.rainAdjustment.correctedPrecipitationMm",
    ),
    rawBestMatchPrecipitationMm: nullableFinite(
      decision.rawBestMatchPrecipitationMm,
      "row.rainAdjustment.rawBestMatchPrecipitationMm",
    ),
    reasonCode: nullableBoundedString(decision.reasonCode, "row.rainAdjustment.reasonCode"),
    sourceForecast: projectRainSource(decision.sourceForecast),
    state: requireState(decision.state, "row.rainAdjustment.state", SOURCE_DECISION_STATES),
  };
}

// retain only the closed rain source forecast
function projectRainSource(value) {
  if (value === null || value === undefined) {
    return null;
  }

  requirePlainObject(value, "row.rainAdjustment.sourceForecast");
  return {
    decisionAt: instant(value.decisionAt, "rain.source.decisionAt"),
    firstReceivedAt: instant(value.firstReceivedAt, "rain.source.firstReceivedAt"),
    modelLeadHours: requireBoundedInteger(value.modelLeadHours, "rain.source.modelLeadHours"),
    providerKey: requireBoundedString(value.providerKey, "rain.source.providerKey"),
    rawPrecipitationMm: finite(value.rawPrecipitationMm, "rain.source.rawPrecipitationMm"),
    runInitializedAt: instant(value.runInitializedAt, "rain.source.runInitializedAt"),
    upstreamModel: requireBoundedString(value.upstreamModel, "rain.source.upstreamModel"),
    validAt: instant(value.validAt, "rain.source.validAt"),
  };
}

// retain a fixed metric allowlist with nulls for absent raw values
function projectMetricValues(value, keys, path, omitAbsent = false) {
  requirePlainObject(value, path);
  const projected = {};

  // preserve the reviewed metric order
  for (const key of keys) {
    if (!omitAbsent || Object.hasOwn(value, key)) {
      projected[key] = nullableFinite(value[key] ?? null, `${path}.${key}`);
    }
  }

  return projected;
}

// scan bounded immutable directories and allocation
async function scanEvidenceDirectories(root, validatePairs) {
  await validateEvidenceDirectories(root);
  const objects = await readdir(join(root, "objects"));
  const receipts = await readdir(join(root, "receipts"));

  // stop startup on unexpected or unbounded contents
  if (objects.length > MAXIMUM_IDENTITIES || receipts.length > MAXIMUM_IDENTITIES ||
    objects.some((name) => !OBJECT_FILENAME_PATTERN.test(name)) ||
    receipts.some((name) => !RECEIPT_FILENAME_PATTERN.test(name))) {
    throw new Error("adjustment evidence directory is invalid");
  }

  let allocatedBytes = 0;

  // count real allocation without following symlinks
  for (const [directory, names] of [["objects", objects], ["receipts", receipts]]) {
    for (const name of names) {
      const details = await lstat(join(root, directory, name), { bigint: true });

      // reject links, devices and oversized files
      if (!details.isFile() || details.isSymbolicLink() ||
        (Number(details.mode) & 0o777) !== 0o600 ||
        details.size > BigInt(directory === "objects"
          ? COMPRESSED_OBJECT_MAXIMUM_BYTES
          : RECEIPT_MAXIMUM_BYTES)) {
        throw new Error("adjustment evidence entry is invalid");
      }

      allocatedBytes += Number(details.blocks * 512n);
    }
  }

  // reserve optional exhaustive validation for export
  if (validatePairs) {
    // validate every object, including a retained orphan from a failed receipt
    for (const name of objects) {
      const expectedSha256 = OBJECT_FILENAME_PATTERN.exec(name)?.[1];
      const bytes = await readRegularFile(
        join(root, "objects", name),
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
      );
      const canonical = gunzipBounded(bytes);
      const object = JSON.parse(canonical.toString("utf8"));

      if (sha256(canonical) !== expectedSha256 ||
        !Buffer.from(canonicalJson(object)).equals(canonical) ||
        !gzipSync(canonical, { level: 9, mtime: 0 }).equals(bytes)) {
        throw new Error("adjustment evidence object is corrupt");
      }

      validateEvidenceObject(object);
    }

    await freezeAdjustmentEvidenceSnapshot({ root });
  }

  return {
    allocatedBytes,
    objectCount: objects.length,
    receiptCount: receipts.length,
  };
}

// create fixed evidence directories and validate real paths
async function ensureEvidenceDirectories(root) {
  await mkdir(root, { mode: 0o700, recursive: true });
  await mkdir(join(root, "objects"), { mode: 0o700, recursive: true });
  await mkdir(join(root, "receipts"), { mode: 0o700, recursive: true });
  await chmod(root, 0o700);
  await chmod(join(root, "objects"), 0o700);
  await chmod(join(root, "receipts"), 0o700);
  await validateEvidenceDirectories(root);
}

// reject directory links and path escapes
async function validateEvidenceDirectories(root) {
  const rootDetails = await lstat(root);

  // require a real private root directory
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() ||
    (rootDetails.mode & 0o777) !== 0o700) {
    throw new Error("adjustment evidence root is invalid");
  }

  const canonicalRoot = await realpath(root);

  // bind both fixed child directories beneath the canonical root
  for (const directory of ["objects", "receipts"]) {
    const path = join(root, directory);
    const details = await lstat(path);
    const canonicalPath = await realpath(path);

    if (!details.isDirectory() || details.isSymbolicLink() ||
      (details.mode & 0o777) !== 0o700 ||
      dirname(canonicalPath) !== canonicalRoot) {
      throw new Error("adjustment evidence directory is invalid");
    }
  }
}

// create or verify one immutable content object
async function writeOrVerifyImmutable(path, bytes, maximumBytes, writer) {
  try {
    await writer(path, bytes);
    return true;
  } catch (error) {
    // verify an existing content-addressed object byte for byte
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const existing = await readRegularFile(path, maximumBytes);

    if (!existing.equals(bytes)) {
      throw new Error("adjustment evidence object collision");
    }

    return false;
  }
}

// create or verify one exclusive stable-identity receipt
async function writeOrVerifyReceipt(path, bytes, prepared, writer) {
  try {
    await writer(path, bytes);
    return true;
  } catch (error) {
    // leave an existing first receipt authoritative
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const existing = await readReceipt(path, prepared.edgeReceiptIdentitySha256);

    if (existing.objectSha256 !== prepared.objectSha256) {
      return false;
    }

    return false;
  }
}

// durably publish one complete private file through an exclusive hard link
async function writeExclusive(path, bytes) {
  const directoryPath = dirname(path);
  const temporaryPath = join(directoryPath, `.capture-${randomUUID()}.tmp`);
  let handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let linked = false;
  let temporaryExists = true;

  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, path);
    linked = true;
    await unlink(temporaryPath);
    temporaryExists = false;

    const directory = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    // close only the still-open private temporary handle
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }

    // remove only the uniquely named temporary created by this call
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
        temporaryExists = false;
      } catch (cleanupError) {
        // ignore only a path already removed by the publication flow
        if (cleanupError?.code !== "ENOENT") {
          error.adjustmentEvidenceTemporaryCleanupFailed = true;
        }
      }
    }

    // disclose only whether the complete final link exists for reconciliation
    if (linked) {
      error.adjustmentEvidenceFinalCreated = true;
    }
    throw error;
  }
}

// read and validate one first-issuance receipt
async function readReceipt(path, expectedIdentity) {
  const bytes = await readRegularFile(path, RECEIPT_MAXIMUM_BYTES);
  const value = JSON.parse(bytes.toString("utf8"));
  validateReceipt(value, expectedIdentity);
  return value;
}

// read one bounded regular file without following links
async function readRegularFile(path, maximumBytes) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  try {
    const details = await handle.stat();

    if (!details.isFile() || (details.mode & 0o777) !== 0o600 ||
      details.size > maximumBytes) {
      throw new Error("adjustment evidence file is invalid");
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// validate one receipt without accepting unknown fields
function validateReceipt(value, expectedIdentity) {
  requireExactKeys(value, [
    "availability",
    "contractVersion",
    "edgeReceiptIdentitySha256",
    "firstEdgeCommittedAt",
    "objectSha256",
    "siteKey",
    "window",
  ], "receipt");
  requireEqual(value.contractVersion, ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION, "receipt.contractVersion");
  requireEqual(value.edgeReceiptIdentitySha256, expectedIdentity, "receipt.edgeReceiptIdentitySha256");
  requireSha256(value.objectSha256, "receipt.objectSha256");
  requireInstant(value.firstEdgeCommittedAt, "receipt.firstEdgeCommittedAt");
  requireEqual(value.siteKey, "ballydidean", "receipt.siteKey");

  if (!WINDOWS.includes(value.window)) {
    throw new TypeError("receipt.window is invalid");
  }

  requireExactKeys(value.availability, ["rowTimestampIndexes", "timestamps"], "receipt.availability");

  if (!Array.isArray(value.availability.timestamps) ||
    !Array.isArray(value.availability.rowTimestampIndexes) ||
    value.availability.rowTimestampIndexes.length > MAXIMUM_ROWS) {
    throw new TypeError("receipt availability is invalid");
  }

  // validate all grouped timestamps
  for (const timestamp of value.availability.timestamps) {
    requireInstant(timestamp, "receipt.availability.timestamps[]");
  }

  // validate every row timestamp reference
  for (const index of value.availability.rowTimestampIndexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.availability.timestamps.length) {
      throw new TypeError("receipt availability index is invalid");
    }
  }
}

// validate the outer object and row count before export
function validateEvidenceObject(value) {
  requireExactKeys(value, [
    "bundleIdentities",
    "contractVersion",
    "rows",
    "settingsSha256",
    "siteKey",
    "window",
  ], "object");
  requireEqual(value.contractVersion, ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION, "object.contractVersion");
  requireSha256(value.settingsSha256, "object.settingsSha256");
  requireEqual(value.siteKey, "ballydidean", "object.siteKey");

  if (!WINDOWS.includes(value.window) || !Array.isArray(value.rows) ||
    value.rows.length < 1 || value.rows.length > MAXIMUM_ROWS) {
    throw new TypeError("adjustment evidence object is invalid");
  }
}

// decompress within the canonical and ratio limits
function gunzipBounded(compressed) {
  const canonical = gunzipSync(compressed, {
    finishFlush: 4,
    maxOutputLength: OBJECT_MAXIMUM_BYTES + 1,
  });

  if (canonical.byteLength > OBJECT_MAXIMUM_BYTES ||
    canonical.byteLength > compressed.byteLength * MAXIMUM_COMPRESSION_RATIO) {
    throw new Error("adjustment evidence object exceeds decompression limits");
  }

  return canonical;
}

// calculate one content-addressed object path
function evidenceObjectPath(root, sha256Value) {
  requireSha256(sha256Value, "objectSha256");
  return join(root, "objects", `sha256-${sha256Value}.json.gz`);
}

// calculate one stable-identity receipt path
function evidenceReceiptPath(root, sha256Value) {
  requireSha256(sha256Value, "edgeReceiptIdentitySha256");
  return join(root, "receipts", `sha256-${sha256Value}.json`);
}

// detect one existing regular path without accepting invalid entries
async function regularFileExists(path) {
  try {
    const details = await lstat(path);

    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("adjustment evidence path is invalid");
    }

    return true;
  } catch (error) {
    // treat only a missing path as available for exclusive creation
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

// calculate conservative filesystem allocation
function allocatedSize(bytes, blockSize) {
  return Math.ceil(bytes / blockSize) * blockSize;
}

// create one classified projection limit error
function objectTooLargeError() {
  const error = new RangeError("adjustment evidence object is too large");
  error.code = "adjustment_evidence_object_too_large";
  return error;
}

// create canonical JSON with recursively sorted object keys
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

// recreate the stable receipt identity from one stored object
function stableIdentitySha256(object) {
  return sha256(canonicalJson({
    bundleIdentities: object.bundleIdentities,
    rows: object.rows.map(
      // exclude all scoring values from the stable record identity
      (row) => ({ record: row.record, source: row.source }),
    ),
    settingsSha256: object.settingsSha256,
    siteKey: object.siteKey,
    window: object.window,
  }));
}

// recursively sort plain object keys and reject unsupported values
function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(
      // preserve semantic array order
      (entry) => canonicalValue(entry),
    );
  }

  requirePlainObject(value, "canonical value");
  return Object.fromEntries(Object.keys(value).sort().map(
    // normalize every property recursively
    (key) => [key, canonicalValue(value[key])],
  ));
}

// calculate one lowercase SHA-256 digest
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// require one plain object
function requirePlainObject(value, path) {
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value;
}

// require exact closed object keys
function requireExactKeys(value, keys, path) {
  requirePlainObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has invalid keys`);
  }
}

// require one exact value
function requireEqual(value, expected, path) {
  if (value !== expected) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one SHA-256 value
function requireSha256(value, path) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize an unavailable SHA-256 identity
function nullableSha256(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return requireSha256(value, "sha256");
}

// require one canonical UTC instant
function requireInstant(value, path) {
  if (typeof value !== "string" || !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${path} is invalid`);
  }
}

// return one validated UTC instant
function instant(value, path) {
  requireInstant(value, path);
  return value;
}

// normalize an unavailable UTC instant
function nullableInstant(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return instant(value, path);
}

// require one bounded opaque string
function requireBoundedString(value, path) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize an unavailable bounded string
function nullableBoundedString(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return requireBoundedString(value, path);
}

// require one bounded string array
function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError(`${path} is invalid`);
  }
  return value.map(
    // validate every metric name
    (entry) => requireBoundedString(entry, `${path}[]`),
  );
}

// require one nonnegative record revision
function requireRevisionCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError("row.revisionCount is invalid");
  }
  return value;
}

// require one bounded integer
function requireBoundedInteger(value, path) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// require one finite number
function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize one unavailable number
function nullableFinite(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return finite(value, path);
}

// require one adjustment decision object
function requireDecision(value, path) {
  return requirePlainObject(value, path);
}

// require the exact public state union for this family
function requireState(value, path, states) {
  // reject unknown and cross-family states
  if (!states.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}
