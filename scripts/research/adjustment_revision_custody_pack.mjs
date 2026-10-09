import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  buildAdjustmentRevisionColdGraphSegment,
  validateAdjustmentRevisionColdPage,
  validateAdjustmentRevisionColdTransferStart,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  ADJUSTMENT_DEFAULT_STATE_ROOT,
} from "./adjustment_maintenance_state.mjs";
import {
  ADJUSTMENT_FREE_SPACE_FLOOR_BYTES,
  ADJUSTMENT_STAGING_CEILING_BYTES,
  ADJUSTMENT_STREAM_BUFFER_BYTES,
  ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES,
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";

export const ADJUSTMENT_REVISION_CUSTODY_PACK_CONTRACT_VERSION =
  "adjustment-revision-custody-open-pack/v1";
export const ADJUSTMENT_REVISION_CUSTODY_PACK_CHECKPOINT_CONTRACT_VERSION =
  "adjustment-revision-custody-open-pack-checkpoint/v1";
export const ADJUSTMENT_REVISION_CUSTODY_TRANSFER_MAXIMUM_BYTES = 4_832 * 1_024;
export const ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES = 32 * 1_024 * 1_024;
export const ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_PAGES = 19;

// preserve four worst-case transfer pages inside every newly opened pack
if (ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES <
  4 * ADJUSTMENT_REVISION_CUSTODY_TRANSFER_MAXIMUM_BYTES) {
  throw new Error("revision custody pack cannot retain four maximum transfers");
}

const METADATA_MAXIMUM_BYTES = 256 * 1_024;
const MINIMUM_FREE_INODES = 32_768n;
const PAYLOAD_PATH = join(
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  "revision-custody-open.payload",
);
const METADATA_PATH = join(
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  "revision-custody-open.current",
);

// create one fixed private custody pack with an injectable isolated store
export function createAdjustmentRevisionCustodyPack(options = {}) {
  requirePlainObject(options, "revision custody pack options");
  const allowed = new Set(["backingCapacity", "store"]);

  // prohibit caller-selected production paths and unknown capacity hooks
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    (options.backingCapacity !== undefined && typeof options.backingCapacity !== "function")) {
    throw new TypeError("revision custody pack options are invalid");
  }
  const store = options.store ?? new FixedRevisionCustodyPackStore({
    backingCapacity: options.backingCapacity,
  });
  return new AdjustmentRevisionCustodyPack(store);
}

// retain exact cold pages until a bounded multi-page graph is sealed
class AdjustmentRevisionCustodyPack {
  #store;

  // close the storage interface before any persistent reads
  constructor(store) {
    const methods = [
      "appendPayload", "payloadSize", "readMetadata", "readPayload", "remove",
      "truncatePayload", "writeMetadata",
    ];

    // require every durability boundary explicitly
    if (store === null || typeof store !== "object" ||
      methods.some((name) => typeof store[name] !== "function")) {
      throw new TypeError("revision custody pack store is invalid");
    }
    this.#store = store;
  }

  // reopen and verify every exact page represented by the atomic checkpoint
  async inspect() {
    const metadataBytes = await this.#store.readMetadata();
    const metadata = parseMetadata(metadataBytes);
    let payloadBytes = await this.#store.payloadSize();

    // remove only a raw suffix not made durable by the metadata checkpoint
    if (payloadBytes > metadata.payloadBytes) {
      await this.#store.truncatePayload(metadata.payloadBytes);
      payloadBytes = metadata.payloadBytes;
    }

    // fail closed when acknowledged metadata has lost raw bytes
    if (payloadBytes !== metadata.payloadBytes) {
      throw new Error("revision custody pack payload length differs");
    }
    const records = await hydrateRecords(this.#store, metadata);
    const checkpointSha256 = records.length === 0
      ? null
      : checkpointIdentity(metadataBytes, records);
    return Object.freeze({
      byteLength: payloadBytes,
      checkpointSha256,
      metadataByteLength: metadataBytes.length,
      pages: Object.freeze(records),
    });
  }

  // fsync one nonempty cold page before it can be remotely retired
  async append(input) {
    requireExactKeys(input, ["page", "start"], "revision custody pack append");
    const page = validateAdjustmentRevisionColdPage(input.page);

    // empty authenticated polls carry no custody bytes
    if (page.entries.length === 0) {
      throw new TypeError("revision custody pack page is empty");
    }
    const firstPage = page.previousPageSha256 === page.startSha256;
    const start = firstPage
      ? validateAdjustmentRevisionColdTransferStart(input.start)
      : input.start;

    // include each transfer start exactly once
    if ((!firstPage && start !== null) || (firstPage && start === null)) {
      throw new TypeError("revision custody pack start differs");
    }
    const segment = buildAdjustmentRevisionColdGraphSegment({ page, start });
    const checkpoint = JSON.parse(segment.members[0].payload.toString("utf8"));
    const current = await this.inspect();
    const last = current.pages.at(-1);

    // converge only a byte-identical last-page retry
    if (last?.page.pageSha256 === page.pageSha256) {
      if (!canonicalJsonBytes(last.page).equals(canonicalJsonBytes(page)) ||
        !sameNullableDocument(last.start, start)) {
        throw new Error("revision custody pack page retry differs");
      }
      return current;
    }

    // prohibit replay within the bounded open pack
    if (current.pages.some((record) => record.page.pageSha256 === page.pageSha256)) {
      throw new Error("revision custody pack page order differs");
    }
    validateAppendOrder(last, page, start);
    const startBytes = start === null ? Buffer.alloc(0) : canonicalJsonBytes(start);
    const pageBytes = canonicalJsonBytes(page);
    const additionBytes = startBytes.length + pageBytes.length;

    // seal before crossing either fixed page or byte ceiling
    if (current.pages.length >= ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_PAGES ||
      current.byteLength + additionBytes > ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES) {
      const error = new RangeError("revision custody pack is full");
      error.code = "adjustment_custody_pack_full";
      throw error;
    }
    const offset = current.byteLength;

    // commit raw start and page bytes before publishing their metadata identity
    if (startBytes.length !== 0) {
      await this.#store.appendPayload(startBytes);
    }
    await this.#store.appendPayload(pageBytes);
    const record = {
      memberRootSha256: checkpoint.memberRootSha256,
      offset,
      pageLength: pageBytes.length,
      pageSha256: page.pageSha256,
      startLength: startBytes.length,
      startMemberSha256: checkpoint.startMemberSha256,
      startSha256: page.startSha256,
      transferSha256: adjustmentSha256(Buffer.concat([startBytes, pageBytes])),
    };
    const metadata = buildMetadata([
      ...current.pages.map((entry) => entry.record),
      record,
    ]);
    await this.#store.writeMetadata(canonicalJsonBytes(metadata));
    const verified = await this.inspect();
    const appended = verified.pages.at(-1);

    // re-open every durability layer before exposing the checkpoint hash
    if (appended?.page.pageSha256 !== page.pageSha256 ||
      appended.record.memberRootSha256 !== checkpoint.memberRootSha256) {
      throw new Error("revision custody pack verification failed");
    }
    return verified;
  }

  // project the verified private pages into one future immutable graph segment
  async buildSealedSegment() {
    const status = await this.inspect();

    // refuse an empty graph publication
    if (status.pages.length === 0 || status.checkpointSha256 === null) {
      throw new Error("revision custody pack is empty");
    }
    const members = [];
    const crossLinks = [];
    const identities = new Set();
    const relations = new Set();

    // merge only independently rebuilt exact page segments
    for (const record of status.pages) {
      const segment = buildAdjustmentRevisionColdGraphSegment({
        page: record.page,
        start: record.start,
      });

      // prevent ambiguous duplicate graph member identities
      for (const member of segment.members) {
        if (identities.has(member.identitySha256)) {
          throw new Error("revision custody pack member identity repeats");
        }
        identities.add(member.identitySha256);
        members.push(member);
      }

      // prevent repeated relation triples across packed pages
      for (const link of segment.crossLinks) {
        const identity = `${link.fromIdentitySha256}\n${link.relation}\n` +
          link.toIdentitySha256;
        if (relations.has(identity)) {
          throw new Error("revision custody pack relation repeats");
        }
        relations.add(identity);
        crossLinks.push(link);
      }
    }
    return Object.freeze({
      checkpointSha256: status.checkpointSha256,
      pageCheckpoints: Object.freeze(status.pages.map((entry) => Object.freeze({
        memberRootSha256: entry.record.memberRootSha256,
        pageSha256: entry.record.pageSha256,
        startMemberSha256: entry.record.startMemberSha256,
        startSha256: entry.record.startSha256,
      }))),
      segment: Object.freeze({
        crossLinks: Object.freeze(crossLinks),
        members: Object.freeze(members),
      }),
    });
  }

  // remove only the exact pack already sealed and durably mapped
  async removeSealed(checkpointSha256) {
    requireSha256(checkpointSha256, "revision custody checkpoint");
    const status = await this.inspect();

    // prohibit deleting a newer or changed open pack
    if (status.checkpointSha256 !== checkpointSha256) {
      throw new Error("revision custody sealed checkpoint differs");
    }
    await this.#store.remove();
    const empty = await this.inspect();

    // verify both private files are absent after the sealed handoff
    if (empty.byteLength !== 0 || empty.metadataByteLength !== 0) {
      throw new Error("revision custody pack removal failed");
    }
  }
}

// build one canonical bounded metadata checkpoint
function buildMetadata(pages) {
  return {
    contractVersion: ADJUSTMENT_REVISION_CUSTODY_PACK_CONTRACT_VERSION,
    pages,
    payloadBytes: pages.reduce(
      // total only exact raw ranges committed by the checkpoint
      (total, page) => total + page.startLength + page.pageLength,
      0,
    ),
  };
}

// parse one exact metadata checkpoint without reading raw payload bytes
function parseMetadata(bytes) {
  requireBuffer(bytes, "revision custody metadata bytes", 0, METADATA_MAXIMUM_BYTES);

  // treat two absent files as one empty open pack
  if (bytes.length === 0) {
    return buildMetadata([]);
  }
  let value;

  // reject malformed or noncanonical metadata
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("revision custody metadata JSON is invalid");
  }
  requireExactKeys(value, ["contractVersion", "pages", "payloadBytes"],
    "revision custody metadata");

  // enforce the fixed pack population and byte ceilings
  if (value.contractVersion !== ADJUSTMENT_REVISION_CUSTODY_PACK_CONTRACT_VERSION ||
    !Array.isArray(value.pages) || value.pages.length < 1 ||
    value.pages.length > ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_PAGES ||
    !Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 1 ||
    value.payloadBytes > ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES ||
    !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError("revision custody metadata is invalid");
  }
  let offset = 0;

  // validate each contiguous exact raw range
  for (const record of value.pages) {
    requireExactKeys(record, [
      "memberRootSha256", "offset", "pageLength", "pageSha256", "startLength",
      "startMemberSha256", "startSha256", "transferSha256",
    ], "revision custody metadata page");
    for (const name of [
      "memberRootSha256", "pageSha256", "startSha256", "transferSha256",
    ]) {
      requireSha256(record[name], name);
    }
    requireNullableSha256(record.startMemberSha256, "startMemberSha256");

    // require one contiguous bounded page representation
    if (record.offset !== offset || !Number.isSafeInteger(record.pageLength) ||
      record.pageLength < 2 || !Number.isSafeInteger(record.startLength) ||
      record.startLength < 0 || (record.startLength === 0) !==
        (record.startMemberSha256 === null)) {
      throw new TypeError("revision custody metadata page range is invalid");
    }
    offset += record.startLength + record.pageLength;
  }

  // bind the declared aggregate to every contiguous record
  if (offset !== value.payloadBytes) {
    throw new TypeError("revision custody metadata payload length differs");
  }
  return value;
}

// restore and independently verify every page from exact raw ranges
async function hydrateRecords(store, metadata) {
  const records = [];

  // read each page separately below the aggregate ceiling
  for (const record of metadata.pages) {
    const bytes = await store.readPayload(
      record.offset,
      record.startLength + record.pageLength,
    );
    requireBuffer(bytes, "revision custody raw record", 2,
      ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES);

    // bind raw bytes to their atomic metadata identity
    if (bytes.length !== record.startLength + record.pageLength ||
      adjustmentSha256(bytes) !== record.transferSha256) {
      throw new Error("revision custody raw record differs");
    }
    const startBytes = bytes.subarray(0, record.startLength);
    const pageBytes = bytes.subarray(record.startLength);
    const start = record.startLength === 0
      ? null
      : validateCanonicalJson(startBytes, validateAdjustmentRevisionColdTransferStart);
    const page = validateCanonicalJson(pageBytes, validateAdjustmentRevisionColdPage);
    const segment = buildAdjustmentRevisionColdGraphSegment({ page, start });
    const checkpoint = JSON.parse(segment.members[0].payload.toString("utf8"));

    // rebind all page, start and member-root identities after reopening
    if (page.pageSha256 !== record.pageSha256 || page.startSha256 !== record.startSha256 ||
      checkpoint.memberRootSha256 !== record.memberRootSha256 ||
      checkpoint.startMemberSha256 !== record.startMemberSha256) {
      throw new Error("revision custody record identity differs");
    }
    records.push(Object.freeze({ page, record: Object.freeze(record), start }));
  }
  return records;
}

// hash the canonical checkpoint and exact reopened raw payload stream
function checkpointIdentity(metadataBytes, records) {
  const raw = createHash("sha256");

  // retain page order in the complete private payload identity
  for (const record of records) {
    if (record.start !== null) {
      raw.update(canonicalJsonBytes(record.start));
    }
    raw.update(canonicalJsonBytes(record.page));
  }
  return adjustmentSha256(Buffer.from([
    ADJUSTMENT_REVISION_CUSTODY_PACK_CHECKPOINT_CONTRACT_VERSION,
    adjustmentSha256(metadataBytes),
    raw.digest("hex"),
    "",
  ].join("\n"), "ascii"));
}

// require one valid sequence across pages and transfer boundaries
function validateAppendOrder(last, page, start) {
  // accept any independently validated page as a new empty-pack head
  if (last === undefined) {
    return;
  }

  // continue one frozen transfer only by direct page hash and cursor succession
  if (page.startSha256 === last.page.startSha256) {
    if (start !== null || page.previousPageSha256 !== last.page.pageSha256 ||
      page.afterArchiveCommitOrdinal !== last.page.nextArchiveCommitOrdinal ||
      page.afterFrontierSha256 !== last.page.nextFrontierSha256) {
      throw new Error("revision custody same-transfer order differs");
    }
    return;
  }

  // begin a later snapshot only after the prior transfer reached its watermark
  if (!last.page.eof || start === null ||
    page.afterArchiveCommitOrdinal !== last.page.nextArchiveCommitOrdinal ||
    page.afterFrontierSha256 !== last.page.nextFrontierSha256) {
    throw new Error("revision custody next-transfer order differs");
  }
}

// compare nullable canonical documents without accepting aliases
function sameNullableDocument(left, right) {
  // preserve exact null boundaries
  if (left === null || right === null) {
    return left === right;
  }
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

// parse one exact canonical document with its contract validator
function validateCanonicalJson(bytes, validator) {
  let value;

  // reject malformed raw checkpoint bytes
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("revision custody raw JSON is invalid");
  }
  const validated = validator(value);

  // reject alternate whitespace and key ordering
  if (!canonicalJsonBytes(validated).equals(bytes)) {
    throw new TypeError("revision custody raw JSON is not canonical");
  }
  return validated;
}

// own the two fixed private open-pack files
class FixedRevisionCustodyPackStore {
  #backingCapacity;

  // retain only the path-free physical capacity hook
  constructor({ backingCapacity }) {
    this.#backingCapacity = backingCapacity;
  }

  // report one bounded private payload size
  async payloadSize() {
    try {
      return (await assertPrivateFile(PAYLOAD_PATH)).size;
    } catch (error) {
      // accept only an absent pack as empty
      if (error?.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  // read one exact bounded raw range
  async readPayload(offset, length) {
    requireRange(offset, length);
    const handle = await open(PAYLOAD_PATH, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const details = await handle.stat();

      // reject changed or out-of-range payload files
      if (!isPrivateFile(details) || offset + length > details.size) {
        throw new Error("revision custody payload target is invalid");
      }
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  // read one bounded canonical metadata file
  async readMetadata() {
    let handle;
    try {
      handle = await open(METADATA_PATH, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const details = await handle.stat();

      // reject broad, linked or oversized metadata files
      if (!isPrivateFile(details) || details.size > METADATA_MAXIMUM_BYTES) {
        throw new Error("revision custody metadata target is invalid");
      }
      return await handle.readFile();
    } catch (error) {
      // accept only an absent metadata file as empty
      if (error?.code === "ENOENT") {
        return Buffer.alloc(0);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  // append and fsync one exact raw range
  async appendPayload(bytes) {
    requireBuffer(bytes, "revision custody append bytes", 1,
      ADJUSTMENT_REVISION_CUSTODY_TRANSFER_MAXIMUM_BYTES);
    await this.#admit(bytes.length, 0n);
    const handle = await open(PAYLOAD_PATH,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW, 0o600);
    try {
      const details = await handle.stat();

      // prohibit changed ownership or aggregate overflow
      if (!isPrivateFile(details) ||
        details.size + bytes.length > ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES) {
        throw new Error("revision custody append target is invalid");
      }
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(PAYLOAD_PATH));
  }

  // atomically publish and fsync one metadata checkpoint
  async writeMetadata(bytes) {
    requireBuffer(bytes, "revision custody metadata bytes", 1, METADATA_MAXIMUM_BYTES);
    await this.#admit(bytes.length, 1n);
    const temporary = join(dirname(METADATA_PATH),
      `.revision-custody-${randomUUID()}.tmp`);
    const handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      await writeAll(handle, bytes);
      await handle.sync();
      await handle.close();
      await assertPrivateFile(temporary);
      await rename(temporary, METADATA_PATH);
      renamed = true;
      await syncDirectory(dirname(METADATA_PATH));
    } finally {
      // remove only an unpublished private temporary file
      if (!renamed) {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    }
  }

  // trim only an uncheckpointed raw suffix
  async truncatePayload(length) {
    const handle = await open(PAYLOAD_PATH, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const details = await handle.stat();

      // prohibit expansion or truncating a changed file
      if (!isPrivateFile(details) || !Number.isSafeInteger(length) || length < 0 ||
        length > details.size) {
        throw new Error("revision custody truncate target is invalid");
      }
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(PAYLOAD_PATH));
  }

  // remove both exact files after their immutable graph mapping is durable
  async remove() {
    for (const path of [PAYLOAD_PATH, METADATA_PATH]) {
      try {
        await assertPrivateFile(path);
        await unlink(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        // retain idempotence only for absent fixed files
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  // require dual physical and local allocation headroom
  async #admit(byteLength, inodeDelta) {
    if (typeof this.#backingCapacity !== "function") {
      throw new Error("revision custody backing capacity is unavailable");
    }
    const backing = await this.#backingCapacity();
    requireExactKeys(backing, ["allocatedBytes", "freeBytes", "freeInodes", "rootKind"],
      "revision custody backing capacity");

    // require the designated backing-c authority
    if (backing.rootKind !== "backing_c" ||
      [backing.allocatedBytes, backing.freeBytes, backing.freeInodes]
        .some((value) => typeof value !== "bigint" || value < 0n)) {
      throw new Error("revision custody backing capacity is invalid");
    }
    const filesystem = await statfs(ADJUSTMENT_DEFAULT_STATE_ROOT, { bigint: true });
    const allocated = roundAllocated(BigInt(byteLength), BigInt(filesystem.bsize));

    // preserve aggregate allocation plus both byte and inode floors
    if (BigInt(byteLength) > ADJUSTMENT_STAGING_CEILING_BYTES ||
      backing.allocatedBytes + allocated > ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES ||
      backing.freeBytes - allocated < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      BigInt(filesystem.bavail) * BigInt(filesystem.bsize) - allocated <
        ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      backing.freeInodes - inodeDelta < MINIMUM_FREE_INODES ||
      BigInt(filesystem.ffree) - inodeDelta < MINIMUM_FREE_INODES) {
      throw new Error("revision custody capacity refused");
    }
  }
}

// require one owner-private literal file
async function assertPrivateFile(path) {
  const details = await lstat(path);

  // reject links, aliases, foreign ownership and broad modes
  if (!isPrivateFile(details) || details.isSymbolicLink() ||
    await realpath(path) !== path) {
    throw new Error("revision custody private file is invalid");
  }
  return details;
}

// classify one safe private file stat
function isPrivateFile(details) {
  return details.isFile() && !details.isSymbolicLink() &&
    details.uid === process.getuid() && details.gid === process.getgid() &&
    details.nlink === 1 && (details.mode & 0o777) === 0o600;
}

// write one bounded buffer completely
async function writeAll(handle, bytes) {
  let offset = 0;

  // cap each write by the archive stream ceiling
  while (offset < bytes.length) {
    const result = await handle.write(bytes.subarray(offset,
      Math.min(bytes.length, offset + ADJUSTMENT_STREAM_BUFFER_BYTES)));

    // reject stalled partial writes
    if (result.bytesWritten < 1) {
      throw new Error("revision custody write made no progress");
    }
    offset += result.bytesWritten;
  }
}

// fsync one fixed private parent directory
async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// require one bounded raw range
function requireRange(offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(length) || length < 1 ||
    offset + length > ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES) {
    throw new RangeError("revision custody payload range is invalid");
  }
}

// round logical bytes to local filesystem blocks
function roundAllocated(bytes, blockSize) {
  return bytes === 0n ? 0n : ((bytes + blockSize - 1n) / blockSize) * blockSize;
}

// require one exact object key set
function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} fields differ`);
  }
}

// require one plain options object
function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one bounded byte buffer
function requireBuffer(value, label, minimumBytes, maximumBytes) {
  if (!Buffer.isBuffer(value) || value.length < minimumBytes ||
    value.length > maximumBytes) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one lowercase sha256 identity
function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one nullable lowercase sha256 identity
function requireNullableSha256(value, label) {
  if (value !== null) {
    requireSha256(value, label);
  }
}
