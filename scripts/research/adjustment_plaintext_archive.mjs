import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  statfs as nodeStatfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensureAdjustmentPrivateDirectory } from "./adjustment_private_directory.mjs";

export const ADJUSTMENT_CAS_CONTRACT_VERSION = "adjustment-cas-pack/v1";
export const ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION =
  "adjustment-graph-manifest/v2";
export const ADJUSTMENT_ARCHIVE_ROOT_KIND = "home_native_ext4_primary";
export const ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES = 18n * 1_024n ** 3n;
export const ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES = 64n * 1_024n ** 3n;
export const ADJUSTMENT_FREE_SPACE_FLOOR_BYTES = 16n * 1_024n ** 3n;
export const ADJUSTMENT_PRIMARY_GROWTH_BYTES = 12_963_872_768n;
export const ADJUSTMENT_EXISTING_CENSUS_BYTES = 16n * 1_024n ** 3n;
export const ADJUSTMENT_STAGING_CEILING_BYTES = 4n * 1_024n ** 3n;
export const ADJUSTMENT_RELEASE_CONTROL_CEILING_BYTES = 4n * 1_024n ** 3n;
export const ADJUSTMENT_CATALOG_STATE_CEILING_BYTES = 1n * 1_024n ** 3n;
export const ADJUSTMENT_ACTIVE_BUCKET_CEILING_BYTES = 43n * 1_024n ** 3n;
export const ADJUSTMENT_UNASSIGNED_HEADROOM_BYTES = 18n * 1_024n ** 3n;
export const ADJUSTMENT_RESERVED_UNUSABLE_BYTES = 3n * 1_024n ** 3n;
export const ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS = 8_372;
export const ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS =
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS;
export const ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS =
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS + ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS;
export const ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES = 1;
export const ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES = 2;
export const ADJUSTMENT_MAXIMUM_ARCHIVE_FILES =
  ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS + ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES +
  ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES;
export const ADJUSTMENT_MAXIMUM_CATALOG_SHARDS = 512;
export const ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES = 384;
export const ADJUSTMENT_MAXIMUM_STAGING_FILES = 256;
export const ADJUSTMENT_MAXIMUM_TASK_INODES =
  ADJUSTMENT_MAXIMUM_ARCHIVE_FILES + ADJUSTMENT_MAXIMUM_CATALOG_SHARDS +
  ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES + ADJUSTMENT_MAXIMUM_STAGING_FILES;
export const ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES = 9_500_000;
export const ADJUSTMENT_CATALOG_ENTRY_BYTES = 96;
export const ADJUSTMENT_MAXIMUM_CATALOG_BYTES = 912_000_000;
export const ADJUSTMENT_STREAM_BUFFER_BYTES = 256 * 1_024;
export const ADJUSTMENT_DEFAULT_ARCHIVE_ROOT = join(
  homedir(),
  ".weather",
  "adjustment-maintenance",
  "v2",
  "archive-primary",
);

const CAS_MAGIC = Buffer.from("WXACAS01", "ascii");
const CATALOG_MAGIC = Buffer.from("WXACAT01", "ascii");
const CAS_HEADER_BYTES = 16;
const CATALOG_HEADER_BYTES = 64;
const EXT4_MAGIC = 0xef53n;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBJECT_FILENAME_PATTERN = /^sha256-[a-f0-9]{64}\.obj$/u;
const SAFE_RESTORE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAXIMUM_CAS_MEMBERS = 65_536;
const MAXIMUM_MANIFEST_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_FREE_INODE_FLOOR = 32_768n;

// encode stable canonical JSON bytes
export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJsonText(value), "utf8");
}

// encode stable canonical json text
function canonicalJsonText(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

// calculate one lowercase SHA-256 digest
export function adjustmentSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// encode one canonical CAS object
export function encodeCasPack(members, options = {}) {
  // reject unbounded or empty packs
  if (!Array.isArray(members) || members.length === 0 ||
    members.length > MAXIMUM_CAS_MEMBERS) {
    throw new TypeError("CAS members are invalid");
  }

  const validators = options.validators ?? new Map();
  const normalized = members.map(
    // validate and normalize every member
    (member) => normalizeMember(member, validators),
  ).sort(compareMembers);
  const identities = new Set();

  // reject duplicate identities across all kinds
  for (const member of normalized) {
    // preserve globally unique portable identities
    if (identities.has(member.identitySha256)) {
      throw new TypeError("CAS member identity is duplicated");
    }
    identities.add(member.identitySha256);
  }

  const header = Buffer.alloc(CAS_HEADER_BYTES);
  CAS_MAGIC.copy(header, 0);
  header.writeUInt32BE(normalized.length, 8);
  header.writeUInt32BE(0, 12);
  const parts = [header];

  // emit every member in canonical order
  for (const member of normalized) {
    const kindBytes = Buffer.from(member.kind, "ascii");
    const memberHeader = Buffer.alloc(2 + kindBytes.length + 32 + 8);
    memberHeader.writeUInt16BE(kindBytes.length, 0);
    kindBytes.copy(memberHeader, 2);
    Buffer.from(member.identitySha256, "hex").copy(memberHeader, 2 + kindBytes.length);
    memberHeader.writeBigUInt64BE(BigInt(member.payload.length), 34 + kindBytes.length);
    parts.push(memberHeader, member.payload);
  }

  return Buffer.concat(parts);
}

// inspect one in-memory CAS object
export function inspectCasPack(bytes, options = {}) {
  const buffer = requireBuffer(bytes, "CAS bytes");
  const reader = createBufferReader(buffer);
  const result = inspectCasReaderSync(reader, options.validators ?? new Map());

  // reject trailing bytes after the declared members
  if (result.byteLength !== buffer.length) {
    throw new TypeError("CAS object has trailing bytes");
  }

  return result;
}

// build one path-free graph manifest
export function buildGraphManifest(input) {
  requireExactKeys(input, ["crossLinks", "entries", "predecessorGraphSha256"], "graph input");
  const predecessorGraphSha256 = input.predecessorGraphSha256;

  // require either genesis or one strong predecessor
  if (predecessorGraphSha256 !== null) {
    requireSha256(predecessorGraphSha256, "predecessorGraphSha256");
  }

  // require one bounded entry list
  if (!Array.isArray(input.entries) || input.entries.length === 0 ||
    input.entries.length > ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES) {
    throw new TypeError("graph entries are invalid");
  }

  const entries = input.entries.map(
    // normalize each portable entry
    (entry) => normalizeGraphEntry(entry),
  ).sort(compareGraphEntries);
  const identities = new Set();
  const rangesByObject = new Map();

  // prove identity uniqueness and nonoverlapping offsets
  for (const entry of entries) {
    // reject a repeated graph identity
    if (identities.has(entry.identitySha256)) {
      throw new TypeError("graph identity is duplicated");
    }
    identities.add(entry.identitySha256);
    const ranges = rangesByObject.get(entry.objectSha256) ?? [];
    const start = BigInt(entry.memberOffset);
    const end = start + BigInt(entry.memberLength);

    // reject an overlapping member range
    if (ranges.some((range) => start < range.end && end > range.start)) {
      throw new TypeError("graph member ranges overlap");
    }
    ranges.push({ end, start });
    rangesByObject.set(entry.objectSha256, ranges);
  }

  const crossLinks = normalizeCrossLinks(input.crossLinks, identities);
  const graphRootSha256 = adjustmentSha256(canonicalJsonText({
    crossLinks,
    entries,
    predecessorGraphSha256,
  }));

  return {
    contractVersion: ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
    predecessorGraphSha256,
    entries,
    crossLinks,
    graphRootSha256,
  };
}

// validate one closed graph manifest
export function validateGraphManifest(manifest) {
  requireExactKeys(manifest, [
    "contractVersion",
    "predecessorGraphSha256",
    "entries",
    "crossLinks",
    "graphRootSha256",
  ], "graph manifest");

  // require the selected graph contract
  if (manifest.contractVersion !== ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION) {
    throw new TypeError("graph manifest contract is invalid");
  }

  const rebuilt = buildGraphManifest({
    crossLinks: manifest.crossLinks,
    entries: manifest.entries,
    predecessorGraphSha256: manifest.predecessorGraphSha256,
  });

  // require the exact canonical graph root
  if (manifest.graphRootSha256 !== rebuilt.graphRootSha256 ||
    canonicalJsonText(manifest) !== canonicalJsonText(rebuilt)) {
    throw new TypeError("graph manifest is not canonical");
  }

  return rebuilt;
}

// encode one fixed-width portable catalog entry
export function encodeCatalogEntry(entry) {
  requireExactKeys(entry, ["identitySha256", "kind", "memberSha256"], "catalog entry");
  requireKind(entry.kind);
  requireSha256(entry.identitySha256, "catalog identitySha256");
  requireSha256(entry.memberSha256, "catalog memberSha256");
  return Buffer.concat([
    Buffer.from(adjustmentSha256(Buffer.from(entry.kind, "ascii")), "hex"),
    Buffer.from(entry.identitySha256, "hex"),
    Buffer.from(entry.memberSha256, "hex"),
  ]);
}

// encode one bounded catalog shard
export function encodeCatalogShard(input) {
  requireExactKeys(input, ["entries", "generation", "objectSha256", "shardIndex"], "catalog shard");
  requireUint64String(input.generation, "catalog generation");
  requireSha256(input.objectSha256, "catalog objectSha256");

  // require one bounded shard index
  if (!Number.isInteger(input.shardIndex) || input.shardIndex < 0 ||
    input.shardIndex >= ADJUSTMENT_MAXIMUM_CATALOG_SHARDS) {
    throw new TypeError("catalog shardIndex is invalid");
  }

  // require the aggregate fixed-entry ceiling
  if (!Array.isArray(input.entries) ||
    input.entries.length > ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES) {
    throw new TypeError("catalog entries are invalid");
  }

  const entryBytes = input.entries.map(
    // encode every fixed-width entry
    (entry) => encodeCatalogEntry(entry),
  ).sort(Buffer.compare);

  // reject duplicate strong metadata records
  if (entryBytes.some((entry, index) =>
    index > 0 && entry.equals(entryBytes[index - 1]))) {
    throw new TypeError("catalog entry is duplicated");
  }
  const header = Buffer.alloc(CATALOG_HEADER_BYTES);
  CATALOG_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(BigInt(input.generation), 8);
  Buffer.from(input.objectSha256, "hex").copy(header, 16);
  header.writeUInt32BE(input.shardIndex, 48);
  header.writeUInt32BE(entryBytes.length, 52);
  return Buffer.concat([header, ...entryBytes]);
}

// inspect one fixed-width path-free catalog shard
export function inspectCatalogShard(bytes) {
  const buffer = requireBuffer(bytes, "catalog shard bytes");

  // reject a short, wrong-magic or nonzero-reserved header
  if (buffer.length < CATALOG_HEADER_BYTES ||
    !buffer.subarray(0, 8).equals(CATALOG_MAGIC) ||
    !buffer.subarray(56, 64).equals(Buffer.alloc(8))) {
    throw new TypeError("catalog shard header is invalid");
  }

  const generation = buffer.readBigUInt64BE(8).toString();
  const objectSha256 = buffer.subarray(16, 48).toString("hex");
  const shardIndex = buffer.readUInt32BE(48);
  const entryCount = buffer.readUInt32BE(52);

  // require exact bounded shard framing
  if (shardIndex >= ADJUSTMENT_MAXIMUM_CATALOG_SHARDS ||
    entryCount > ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES ||
    buffer.length !== CATALOG_HEADER_BYTES + entryCount * ADJUSTMENT_CATALOG_ENTRY_BYTES) {
    throw new TypeError("catalog shard bounds are invalid");
  }

  const entries = [];
  let previous = null;

  // decode every fixed-width strong metadata entry
  for (let index = 0; index < entryCount; index += 1) {
    const offset = CATALOG_HEADER_BYTES + index * ADJUSTMENT_CATALOG_ENTRY_BYTES;
    const encoded = buffer.subarray(offset, offset + ADJUSTMENT_CATALOG_ENTRY_BYTES);

    // require strict canonical byte order
    if (previous !== null && Buffer.compare(previous, encoded) >= 0) {
      throw new TypeError("catalog shard entry order is invalid");
    }
    entries.push({
      kindSha256: encoded.subarray(0, 32).toString("hex"),
      identitySha256: encoded.subarray(32, 64).toString("hex"),
      memberSha256: encoded.subarray(64, 96).toString("hex"),
    });
    previous = encoded;
  }

  return { entryCount, entries, generation, objectSha256, shardIndex };
}

// create the fixed-root production archive or an injected test archive
export function createPlaintextArchive(options = {}) {
  // prohibit configurable production archive roots
  if (Object.hasOwn(options, "root")) {
    throw new TypeError("archive root override is prohibited");
  }

  const store = options.store ?? new FixedRootArchiveStore({
    backingCapacity: options.backingCapacity,
    statfs: options.statfs,
  });
  return new PlaintextArchive({
    freeInodeFloor: options.freeInodeFloor ?? DEFAULT_FREE_INODE_FLOOR,
    memberValidators: options.memberValidators ?? new Map(),
    store,
  });
}

// coordinate bounded immutable archive operations
export class PlaintextArchive {
  #freeInodeFloor;
  #memberValidators;
  #store;

  // retain only explicit storage boundaries
  constructor({ freeInodeFloor, memberValidators, store }) {
    this.#freeInodeFloor = BigInt(freeInodeFloor);
    this.#memberValidators = memberValidators;
    this.#store = store;
  }

  // initialize and validate the configured archive
  async initialize() {
    const identity = await this.#store.initialize();

    // reject an unsafe or path-disclosing storage identity
    if (identity.rootKind !== ADJUSTMENT_ARCHIVE_ROOT_KIND ||
      Object.hasOwn(identity, "path")) {
      throw resourceError("archive_identity_refused");
    }

    return identity;
  }

  // publish one immutable CAS pack
  async publishCasObject(members) {
    const bytes = encodeCasPack(members, { validators: this.#memberValidators });
    const objectSha256 = adjustmentSha256(bytes);
    const fileName = `sha256-${objectSha256}.obj`;
    const existing = await this.#store.describe(fileName);

    // validate and reuse exact immutable bytes
    if (existing !== null) {
      const verified = await inspectStoredCas(this.#store, objectSha256, this.#memberValidators);
      return { created: false, objectSha256, members: verified.members };
    }

    await this.#admit(bytes.length, 1n);
    const published = await this.#store.publishExclusive(fileName, bytes);
    const verified = await inspectStoredCas(this.#store, objectSha256, this.#memberValidators);
    return { created: published.created, objectSha256, members: verified.members };
  }

  // publish one canonical graph manifest as a CAS member
  async publishGraphManifest(manifest) {
    const validated = validateGraphManifest(manifest);
    const payload = canonicalJsonBytes(validated);
    return await this.publishCasObject([{
      identitySha256: adjustmentSha256(payload),
      kind: ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
      payload,
    }]);
  }

  // verify every object and member reachable from one graph head
  async verifyFullGraph(manifestObjectSha256, options = {}) {
    return await verifyFullGraph(this.#store, manifestObjectSha256, {
      memberValidators: this.#memberValidators,
      verifyPredecessors: options.verifyPredecessors ?? true,
    });
  }

  // restore verified members to caller-chosen fixed names
  async restoreFullGraph(manifestObjectSha256, options) {
    return await restoreFullGraph(this.#store, manifestObjectSha256, {
      ...options,
      memberValidators: this.#memberValidators,
    });
  }

  // rotate one hash-only current and previous head
  async updateHead(manifestObjectSha256) {
    requireSha256(manifestObjectSha256, "manifestObjectSha256");
    await this.verifyFullGraph(manifestObjectSha256);
    await this.#store.writePointer("head", `${manifestObjectSha256}\n`);
    return { manifestObjectSha256 };
  }

  // report bounded path-free archive health
  async status() {
    const capacity = await this.#store.measure();
    return {
      rootKind: ADJUSTMENT_ARCHIVE_ROOT_KIND,
      objectCount: capacity.objectCount,
      fileCount: capacity.fileCount,
      incomingCount: capacity.incomingCount,
      allocatedBytes: capacity.allocatedBytes.toString(),
      freeBytes: capacity.freeBytes.toString(),
      freeInodes: capacity.freeInodes.toString(),
      backingRootKind: capacity.backing.rootKind,
      backingAllocatedBytes: capacity.backing.allocatedBytes.toString(),
      backingFreeBytes: capacity.backing.freeBytes.toString(),
      backingFreeInodes: capacity.backing.freeInodes.toString(),
    };
  }

  // reserve exact next-state allocation before mutation
  async #admit(logicalBytes, inodeDelta) {
    const capacity = await this.#store.measure();
    const allocatedDelta = roundAllocated(BigInt(logicalBytes), capacity.blockSize);
    const nextAllocated = capacity.allocatedBytes + allocatedDelta;

    // enforce every exact object, peak file and task-inode ceiling
    if (capacity.objectCount + 1 > ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS ||
      capacity.incomingCount + 1 > ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES ||
      capacity.fileCount + 2 > ADJUSTMENT_MAXIMUM_ARCHIVE_FILES ||
      capacity.taskInodes + inodeDelta > BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES)) {
      throw resourceError("archive_count_refused");
    }

    // enforce allocated rather than logical archive bytes
    if (nextAllocated > ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES) {
      throw resourceError("archive_bytes_refused");
    }

    // enforce the aggregate 64 GiB authorization from the physical census hook
    if (capacity.backing.allocatedBytes + allocatedDelta >
      ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES) {
      throw resourceError("aggregate_bytes_refused");
    }

    // preserve the exact ext4 byte and inode floors
    if (capacity.freeBytes - allocatedDelta < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      capacity.freeInodes - inodeDelta < this.#freeInodeFloor) {
      throw resourceError("ext4_floor_refused");
    }

    // preserve the backing-C hook byte and inode floors
    if (capacity.backing.freeBytes - allocatedDelta < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      capacity.backing.freeInodes - inodeDelta < this.#freeInodeFloor) {
      throw resourceError("backing_floor_refused");
    }
  }
}

// verify one complete predecessor-linked graph
export async function verifyFullGraph(store, manifestObjectSha256, options = {}) {
  requireSha256(manifestObjectSha256, "manifestObjectSha256");
  const validators = options.memberValidators ?? new Map();
  const visited = new Set();
  let currentSha256 = manifestObjectSha256;
  let headResult = null;

  // walk the immutable predecessor chain without lifetime scans
  while (currentSha256 !== null) {
    // reject a predecessor cycle or horizon overflow
    if (visited.has(currentSha256) || visited.size >= ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS) {
      throw new TypeError("graph predecessor chain is invalid");
    }
    visited.add(currentSha256);
    const manifestPack = await inspectStoredCas(store, currentSha256, validators);

    // require one manifest member and no hidden companion member
    if (manifestPack.members.length !== 1 ||
      manifestPack.members[0].kind !== ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION) {
      throw new TypeError("graph head object is invalid");
    }

    const manifest = await readCanonicalJsonMember(
      store,
      currentSha256,
      manifestPack.members[0],
      MAXIMUM_MANIFEST_BYTES,
      "graph manifest",
      validateGraphManifest,
    );
    const expectedEntriesByObject = new Map();

    // group the exact manifest entries by object
    for (const entry of manifest.entries) {
      const entries = expectedEntriesByObject.get(entry.objectSha256) ?? [];
      entries.push(entry);
      expectedEntriesByObject.set(entry.objectSha256, entries);
    }

    // stream and verify every listed object
    for (const [objectSha256, expectedEntries] of expectedEntriesByObject) {
      const inspected = await inspectStoredCas(store, objectSha256, validators);
      const actualEntries = inspected.members.map(
        // project only manifest-bound member metadata
        (member) => ({
          kind: member.kind,
          identitySha256: member.identitySha256,
          objectSha256,
          memberOffset: member.memberOffset,
          memberLength: member.memberLength,
          memberSha256: member.memberSha256,
        }),
      ).sort(compareGraphEntries);
      const expected = [...expectedEntries].sort(compareGraphEntries);

      // reject missing, extra or substituted members
      if (canonicalJsonText(actualEntries) !== canonicalJsonText(expected)) {
        throw new TypeError("graph object membership is invalid");
      }
    }

    const result = {
      graphRootSha256: manifest.graphRootSha256,
      manifest,
      manifestObjectSha256: currentSha256,
      objectCount: expectedEntriesByObject.size,
      memberCount: manifest.entries.length,
    };
    headResult ??= result;
    currentSha256 = options.verifyPredecessors === false
      ? null
      : manifest.predecessorGraphSha256;
  }

  return { ...headResult, predecessorCount: visited.size - 1 };
}

// restore exact verified members without archive-controlled paths
export async function restoreFullGraph(store, manifestObjectSha256, options) {
  // require an explicit bounded restore sink and target list
  if (options === null || typeof options !== "object" ||
    typeof options.sink?.writeExclusive !== "function" ||
    !Array.isArray(options.targets)) {
    throw new TypeError("restore options are invalid");
  }

  const verified = await verifyFullGraph(store, manifestObjectSha256, {
    memberValidators: options.memberValidators,
    verifyPredecessors: false,
  });
  const entriesByIdentity = new Map(verified.manifest.entries.map(
    // index exact verified member identities
    (entry) => [entry.identitySha256, entry],
  ));
  const targetNames = new Set();
  let totalBytes = 0n;
  const maximumBytes = BigInt(options.maximumBytes ?? 4 * 1_024 * 1_024 * 1_024);

  // materialize only caller-selected fixed filenames
  for (const target of options.targets) {
    requireExactKeys(target, ["fileName", "identitySha256"], "restore target");
    requireSha256(target.identitySha256, "restore identitySha256");

    // reject paths, duplicate names and implicit directory creation
    if (!SAFE_RESTORE_NAME_PATTERN.test(target.fileName) ||
      basename(target.fileName) !== target.fileName || targetNames.has(target.fileName)) {
      throw new TypeError("restore filename is invalid");
    }
    targetNames.add(target.fileName);
    const entry = entriesByIdentity.get(target.identitySha256);

    // reject an identity outside the verified graph
    if (entry === undefined) {
      throw new TypeError("restore identity is not in the graph");
    }
    totalBytes += BigInt(entry.memberLength);

    // enforce the bounded tmpfs materialization ceiling
    if (totalBytes > maximumBytes) {
      throw resourceError("restore_bytes_refused");
    }

    await options.sink.writeExclusive(
      target.fileName,
      streamMemberPayload(store, entry),
      entry.memberLength,
    );
  }

  return { restoredBytes: totalBytes.toString(), restoredFiles: targetNames.size };
}

// hold the one fixed production archive root
class FixedRootArchiveStore {
  #backingCapacity;
  #root = ADJUSTMENT_DEFAULT_ARCHIVE_ROOT;
  #statfs;

  // bind only injectable measurement hooks
  constructor(options) {
    this.#backingCapacity = options.backingCapacity;
    this.#statfs = options.statfs ?? ((path) => nodeStatfs(path, { bigint: true }));
  }

  // create and prove the owner-private native-ext4 root
  async initialize() {
    const parent = dirname(this.#root);
    await ensureAdjustmentPrivateDirectory("archive");
    await assertPrivateDirectory(parent);
    await assertPrivateDirectory(this.#root);
    await assertPrivateDirectory(join(this.#root, "objects"));
    const resolvedRoot = await realpath(this.#root);

    // refuse a symlinked, moved or forbidden production root
    if (resolvedRoot !== resolve(this.#root) || isForbiddenStoragePath(resolvedRoot)) {
      throw resourceError("archive_path_refused");
    }

    const filesystem = await this.#statfs(resolvedRoot);

    // require the native ext4 filesystem type
    if (BigInt(filesystem.type) !== EXT4_MAGIC) {
      throw resourceError("archive_filesystem_refused");
    }

    return { rootKind: ADJUSTMENT_ARCHIVE_ROOT_KIND };
  }

  // describe one safe immutable object
  async describe(fileName) {
    requireObjectFilename(fileName);
    const path = join(this.#root, "objects", fileName);

    try {
      return await assertPrivateFile(path);
    } catch (error) {
      // treat only absence as an unpublished object
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  // publish one exact object without overwrite
  async publishExclusive(fileName, bytes) {
    requireObjectFilename(fileName);
    const expectedSha256 = fileName.slice(7, -4);
    const objectDirectory = join(this.#root, "objects");
    const finalPath = join(objectDirectory, fileName);
    const temporaryPath = join(objectDirectory, `.incoming-${randomUUID()}`);
    let handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let linked = false;

    try {
      let offset = 0;

      // write the incoming object through the fixed streaming buffer
      while (offset < bytes.length) {
        const chunk = bytes.subarray(
          offset,
          Math.min(bytes.length, offset + ADJUSTMENT_STREAM_BUFFER_BYTES),
        );
        const { bytesWritten } = await handle.write(chunk);
        // a stalled write cannot publish a truncated content-addressed object
        if (bytesWritten === 0) throw new Error("CAS write made no progress");
        offset += bytesWritten;
      }
      await handle.sync();
      await handle.close();
      handle = null;
      const temporary = await assertPrivateFile(temporaryPath);

      // verify the incoming length and content identity before publication
      if (temporary.size !== bytes.length ||
        await sha256File(temporaryPath) !== expectedSha256) {
        throw new TypeError("incoming CAS object is invalid");
      }

      try {
        await link(temporaryPath, finalPath);
        linked = true;
      } catch (error) {
        // reuse only one already valid content-addressed object
        if (error?.code !== "EEXIST" || await sha256File(finalPath) !== expectedSha256) {
          throw error;
        }
      }

      await unlink(temporaryPath);
      await syncDirectory(objectDirectory);
      await assertPrivateFile(finalPath);
      return { created: linked };
    } catch (error) {
      // close only the still-open incoming handle
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      error.incomingRetainedForReconciliation = true;
      throw error;
    }
  }

  // open one safe random-access object reader
  async openObject(fileName) {
    requireObjectFilename(fileName);
    const path = join(this.#root, "objects", fileName);
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const details = await handle.stat();

    // require owner-private single-link regular bytes
    if (!details.isFile() || details.uid !== process.getuid() ||
      (details.mode & 0o777) !== 0o600 || details.nlink !== 1) {
      await handle.close();
      throw new TypeError("archive object metadata is invalid");
    }

    return {
      size: details.size,
      // read one bounded range
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, result.bytesRead);
      },
      // close the held no-follow reader
      close: async () => await handle.close(),
    };
  }

  // measure allocated bytes, files, inodes and both floors
  async measure() {
    const filesystem = await this.#statfs(this.#root);
    const names = await readdir(join(this.#root, "objects"));
    let allocatedBytes = 0n;
    let objectCount = 0;
    let incomingCount = 0;

    // count only verified archive-owned filenames
    for (const name of names) {
      const details = await lstat(join(this.#root, "objects", name), { bigint: true });

      // reject unexpected or unsafe archive entries
      if (!details.isFile() || details.uid !== BigInt(process.getuid()) ||
        (details.mode & 0o777n) !== 0o600n || details.nlink !== 1n) {
        throw resourceError("archive_entry_refused");
      }

      // classify committed objects and unique incoming bytes
      if (OBJECT_FILENAME_PATTERN.test(name)) {
        objectCount += 1;
      } else if (name.startsWith(".incoming-")) {
        incomingCount += 1;
      } else {
        throw resourceError("archive_entry_refused");
      }
      allocatedBytes += details.blocks * 512n;
    }

    const pointerNames = ["head.current", "head.previous"];
    const pointerStates = await Promise.all(pointerNames.map(
      // inspect each bounded pointer slot
      async (name) => {
        try {
          return await assertPrivateFile(join(this.#root, name));
        } catch (error) {
          // count only an existing pointer
          if (error?.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      },
    ));
    const pointerCount = pointerStates.filter(Boolean).length;

    // include every pointer's allocated blocks in the archive bucket
    for (const pointer of pointerStates) {
      // count only an existing pointer allocation
      if (pointer !== null) {
        allocatedBytes += BigInt(pointer.blocks) * 512n;
      }
    }
    const backing = await requireBackingCapacity(this.#backingCapacity);
    return {
      allocatedBytes,
      backing,
      blockSize: BigInt(filesystem.bsize),
      fileCount: objectCount + incomingCount + pointerCount,
      freeBytes: BigInt(filesystem.bavail) * BigInt(filesystem.bsize),
      freeInodes: BigInt(filesystem.ffree),
      incomingCount,
      objectCount,
      taskInodes: BigInt(objectCount + incomingCount + pointerCount),
    };
  }

  // atomically rotate one hash-only pointer pair
  async writePointer(prefix, contents) {
    const currentPath = join(this.#root, `${prefix}.current`);
    const previousPath = join(this.#root, `${prefix}.previous`);
    const temporaryPath = join(this.#root, `.${prefix}-${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );

    try {
      await handle.writeFile(contents, "ascii");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await unlink(previousPath);
    } catch (error) {
      // ignore only an absent previous slot
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await rename(currentPath, previousPath);
    } catch (error) {
      // allow only the genesis pointer rotation
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await rename(temporaryPath, currentPath);
    await syncDirectory(this.#root);
  }
}

// inspect and hash one stored CAS object through bounded reads
async function inspectStoredCas(store, objectSha256, validators) {
  requireSha256(objectSha256, "objectSha256");
  const reader = await store.openObject(`sha256-${objectSha256}.obj`);

  try {
    const result = await inspectCasReader(reader, validators);

    // bind the complete object bytes to the requested name
    if (result.objectSha256 !== objectSha256 || result.byteLength !== reader.size) {
      throw new TypeError("stored CAS object hash is invalid");
    }
    return result;
  } finally {
    await reader.close();
  }
}

// stream and validate one random-access CAS reader
async function inspectCasReader(reader, validators) {
  const objectHash = createHash("sha256");
  let offset = 0;

  // read exact bounded bytes and update the object hash
  const read = async (length) => {
    // enforce the universal streaming buffer ceiling
    if (!Number.isInteger(length) || length < 0 || length > ADJUSTMENT_STREAM_BUFFER_BYTES) {
      throw new RangeError("CAS read exceeds the streaming buffer");
    }
    const bytes = await reader.read(offset, length);

    // reject every short read
    if (bytes.length !== length) {
      throw new TypeError("CAS object is truncated");
    }
    offset += length;
    objectHash.update(bytes);
    return bytes;
  };

  const header = await read(CAS_HEADER_BYTES);
  const count = validateCasHeader(header);
  const members = [];
  const identities = new Set();
  let previous = null;

  // stream every declared member in order
  for (let index = 0; index < count; index += 1) {
    const kindLengthBytes = await read(2);
    const kindLength = kindLengthBytes.readUInt16BE(0);

    // reject an empty or oversized kind before allocation
    if (kindLength === 0 || kindLength > 255) {
      throw new TypeError("CAS kind length is invalid");
    }
    const kind = (await read(kindLength)).toString("ascii");
    requireKind(kind);
    const identitySha256 = (await read(32)).toString("hex");
    const lengthValue = (await read(8)).readBigUInt64BE(0);

    // reject unsafe JavaScript offsets before use
    if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("CAS member length is unsafe");
    }
    const memberLength = Number(lengthValue);
    const memberOffset = offset;
    const current = { identitySha256, kind };

    // require strict canonical order and unique identities
    if ((previous !== null && compareMembers(previous, current) >= 0) ||
      identities.has(identitySha256)) {
      throw new TypeError("CAS member order is invalid");
    }
    previous = current;
    identities.add(identitySha256);
    const validator = createMemberReadValidator(validators, kind, memberLength);
    const payloadHash = createHash("sha256");
    let remaining = memberLength;

    // read the payload through bounded chunks
    while (remaining > 0) {
      const chunk = await read(Math.min(remaining, ADJUSTMENT_STREAM_BUFFER_BYTES));
      payloadHash.update(chunk);
      await validator.write(chunk);
      remaining -= chunk.length;
    }
    await validator.finish();
    members.push({
      identitySha256,
      kind,
      memberLength,
      memberOffset,
      memberSha256: payloadHash.digest("hex"),
    });
  }

  // reject undeclared trailing bytes
  if (offset !== reader.size) {
    throw new TypeError("CAS object has trailing bytes");
  }

  return {
    byteLength: offset,
    members,
    objectSha256: objectHash.digest("hex"),
  };
}

// inspect a synchronous in-memory reader
function inspectCasReaderSync(reader, validators) {
  const header = reader.read(CAS_HEADER_BYTES);
  const count = validateCasHeader(header);
  const members = [];
  const identities = new Set();
  let previous = null;

  // decode every declared member
  for (let index = 0; index < count; index += 1) {
    const kindLength = reader.read(2).readUInt16BE(0);

    // reject invalid kind lengths before reading
    if (kindLength === 0 || kindLength > 255) {
      throw new TypeError("CAS kind length is invalid");
    }
    const kind = reader.read(kindLength).toString("ascii");
    requireKind(kind);
    const identitySha256 = reader.read(32).toString("hex");
    const lengthValue = reader.read(8).readBigUInt64BE(0);

    // reject unsafe member lengths
    if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("CAS member length is unsafe");
    }
    const memberLength = Number(lengthValue);
    const memberOffset = reader.offset;
    const current = { identitySha256, kind };

    // enforce canonical ordering and uniqueness
    if ((previous !== null && compareMembers(previous, current) >= 0) ||
      identities.has(identitySha256)) {
      throw new TypeError("CAS member order is invalid");
    }
    previous = current;
    identities.add(identitySha256);
    const payload = reader.read(memberLength);
    requireMemberValidator(validators, kind, memberLength)(payload);
    members.push({
      identitySha256,
      kind,
      memberLength,
      memberOffset,
      memberSha256: adjustmentSha256(payload),
    });
  }

  return { byteLength: reader.offset, members, objectSha256: reader.sha256() };
}

// validate one fixed CAS header
function validateCasHeader(header) {
  // require exact magic and reserved zeros
  if (!header.subarray(0, 8).equals(CAS_MAGIC) || header.readUInt32BE(12) !== 0) {
    throw new TypeError("CAS header is invalid");
  }
  const count = header.readUInt32BE(8);

  // require a bounded nonempty member count
  if (count === 0 || count > MAXIMUM_CAS_MEMBERS) {
    throw new TypeError("CAS member count is invalid");
  }
  return count;
}

// normalize one pack member
function normalizeMember(member, validators) {
  requireExactKeys(member, ["identitySha256", "kind", "payload"], "CAS member");
  requireKind(member.kind);
  requireSha256(member.identitySha256, "CAS identitySha256");
  const payload = requireBuffer(member.payload, "CAS payload");
  requireMemberValidator(validators, member.kind, payload.length)(payload);
  return { identitySha256: member.identitySha256, kind: member.kind, payload };
}

// require one explicit closed-schema member validator
function requireMemberValidator(validators, kind, byteLength) {
  const validator = validators instanceof Map ? validators.get(kind) : validators[kind];

  // always retain the built-in closed graph validator
  if (kind === ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION) {
    // enforce the graph schema ceiling before validation
    if (byteLength > MAXIMUM_MANIFEST_BYTES) {
      throw new RangeError("CAS member exceeds its schema limit");
    }

    // validate the closed graph JSON payload
    return (payload) => validateGraphManifest(parseCanonicalJson(payload, "graph manifest"));
  }

  // reject every unknown archive kind
  if (typeof validator !== "function") {
    throw new TypeError(`CAS member kind is not registered: ${kind}`);
  }

  // honor one declared validator byte ceiling
  if (Number.isInteger(validator.maximumBytes) && byteLength > validator.maximumBytes) {
    throw new RangeError("CAS member exceeds its schema limit");
  }
  return validator;
}

// create one independent streamed read validator
function createMemberReadValidator(validators, kind, byteLength) {
  const validator = requireMemberValidator(validators, kind, byteLength);

  // stream the built-in bounded graph json validator
  if (kind === ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION) {
    return createCanonicalJsonStreamValidator(
      "graph manifest",
      MAXIMUM_MANIFEST_BYTES,
      validateGraphManifest,
    );
  }

  // instantiate one explicitly bounded streaming validator
  if (typeof validator.createStream === "function") {
    // require an advertised finite schema ceiling
    if (!Number.isSafeInteger(validator.maximumBytes) || validator.maximumBytes < 0) {
      throw new TypeError("CAS streaming validator schema limit is invalid");
    }
    const session = validator.createStream({ byteLength, kind });
    requireExactKeys(session, ["finish", "write"], "CAS streaming validator");

    // require the complete streaming method pair
    if (typeof session.write !== "function" || typeof session.finish !== "function") {
      throw new TypeError("CAS streaming validator methods are invalid");
    }
    return session;
  }

  // never aggregate a large member for a buffered validator
  if (byteLength > ADJUSTMENT_STREAM_BUFFER_BYTES) {
    throw new RangeError("CAS member requires a streaming validator");
  }

  const chunks = [];
  return {
    // retain at most one stream-buffer-sized member
    write(chunk) {
      chunks.push(chunk);
    },
    // preserve the legacy callable validator contract
    finish() {
      const payload = chunks.length === 1
        ? Buffer.from(chunks[0])
        : Buffer.concat(chunks, byteLength);
      return validator(payload);
    },
  };
}

// validate one canonical json value from bounded raw chunks
function createCanonicalJsonStreamValidator(label, maximumBytes, validate) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts = [];
  let byteLength = 0;

  return {
    // decode one bounded raw chunk
    write(chunk) {
      byteLength += chunk.length;

      // enforce the advertised decoded schema ceiling
      if (byteLength > maximumBytes) {
        throw new RangeError("member payload exceeds its bound");
      }

      try {
        parts.push(decoder.decode(chunk, { stream: true }));
      } catch {
        throw new TypeError(`${label} JSON is invalid`);
      }
    },
    // parse and validate the bounded decoded state
    finish() {
      try {
        parts.push(decoder.decode());
      } catch {
        throw new TypeError(`${label} JSON is invalid`);
      }
      return validate(parseCanonicalJsonText(parts.join(""), label));
    },
  };
}

// normalize one manifest entry
function normalizeGraphEntry(entry) {
  requireExactKeys(entry, [
    "kind",
    "identitySha256",
    "objectSha256",
    "memberOffset",
    "memberLength",
    "memberSha256",
  ], "graph entry");
  requireKind(entry.kind);
  requireSha256(entry.identitySha256, "graph identitySha256");
  requireSha256(entry.objectSha256, "graph objectSha256");
  requireSha256(entry.memberSha256, "graph memberSha256");
  requireSafeNonnegativeInteger(entry.memberOffset, "graph memberOffset");
  requireSafeNonnegativeInteger(entry.memberLength, "graph memberLength");
  return { ...entry };
}

// normalize path-free graph links
function normalizeCrossLinks(value, identities) {
  // require a bounded cross-link list
  if (!Array.isArray(value) || value.length > ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES) {
    throw new TypeError("graph crossLinks are invalid");
  }

  return value.map(
    // validate one strong identity cross-link
    (linkValue) => {
      requireExactKeys(linkValue, ["fromIdentitySha256", "relation", "toIdentitySha256"], "graph crossLink");
      requireSha256(linkValue.fromIdentitySha256, "crossLink fromIdentitySha256");
      requireSha256(linkValue.toIdentitySha256, "crossLink toIdentitySha256");

      // require both endpoints in the same closed graph
      if (!identities.has(linkValue.fromIdentitySha256) ||
        !identities.has(linkValue.toIdentitySha256)) {
        throw new TypeError("graph crossLink endpoint is absent");
      }

      // reject path-like or unbounded relation labels
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(linkValue.relation)) {
        throw new TypeError("graph crossLink relation is invalid");
      }
      return { ...linkValue };
    },
  ).sort(
    // order links by their complete canonical tuple
    (left, right) => canonicalJsonBytes(left).compare(canonicalJsonBytes(right)),
  );
}

// compare canonical pack members
function compareMembers(left, right) {
  return compareAscii(left.kind, right.kind) ||
    compareAscii(left.identitySha256, right.identitySha256);
}

// compare canonical graph entries
function compareGraphEntries(left, right) {
  return compareAscii(left.kind, right.kind) ||
    compareAscii(left.identitySha256, right.identitySha256) ||
    compareAscii(left.objectSha256, right.objectSha256) ||
    left.memberOffset - right.memberOffset;
}

// compare canonical ASCII strings bytewise
function compareAscii(left, right) {
  // return equality without allocation
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// stream one exact member range
async function* streamMemberPayload(store, entry) {
  const reader = await store.openObject(`sha256-${entry.objectSha256}.obj`);
  let offset = entry.memberOffset;
  let remaining = entry.memberLength;

  try {
    // yield only bounded verified-range chunks
    while (remaining > 0) {
      const length = Math.min(remaining, ADJUSTMENT_STREAM_BUFFER_BYTES);
      const chunk = await reader.read(offset, length);

      // reject a short restore read
      if (chunk.length !== length) {
        throw new TypeError("restore member is truncated");
      }
      yield chunk;
      offset += chunk.length;
      remaining -= chunk.length;
    }
  } finally {
    await reader.close();
  }
}

// read one bounded canonical json member
async function readCanonicalJsonMember(
  store,
  objectSha256,
  member,
  maximumBytes,
  label,
  validate,
) {
  // reject the length before allocating
  if (member.memberLength > maximumBytes) {
    throw new RangeError("member payload exceeds its bound");
  }
  const validator = createCanonicalJsonStreamValidator(label, maximumBytes, validate);

  // decode bounded i/o chunks without whole-member buffers
  for await (const chunk of streamMemberPayload(store, {
    ...member,
    objectSha256,
  })) {
    validator.write(chunk);
  }
  return validator.finish();
}

// create one bounds-checking in-memory reader
function createBufferReader(buffer) {
  let offset = 0;
  return {
    // expose the current portable offset
    get offset() {
      return offset;
    },
    // read one exact range
    read(length) {
      const end = offset + length;

      // reject short or unsafe ranges
      if (!Number.isSafeInteger(end) || end > buffer.length) {
        throw new TypeError("CAS object is truncated");
      }
      const result = buffer.subarray(offset, end);
      offset = end;
      return result;
    },
    // hash the complete original bytes
    sha256() {
      return adjustmentSha256(buffer);
    },
  };
}

// normalize recursively sorted JSON values
function canonicalValue(value) {
  // retain JSON scalar values
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // retain only finite JSON numbers
  if (typeof value === "number") {
    // reject nonfinite or negative-zero encodings
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("canonical JSON number is invalid");
    }
    return value;
  }

  // preserve array order while normalizing entries
  if (Array.isArray(value)) {
    return value.map(
      // normalize one array member
      (entry) => canonicalValue(entry),
    );
  }

  requirePlainObject(value, "canonical JSON object");
  return Object.fromEntries(Object.keys(value).sort().map(
    // sort and normalize every object field
    (key) => [key, canonicalValue(value[key])],
  ));
}

// parse and prove canonical JSON bytes
function parseCanonicalJson(bytes, label) {
  return parseCanonicalJsonText(bytes.toString("utf8"), label);
}

// parse and prove canonical json text
function parseCanonicalJsonText(text, label) {
  let value;

  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }

  // require exact canonical text including one newline
  if (canonicalJsonText(value) !== text) {
    throw new TypeError(`${label} JSON is not canonical`);
  }
  return value;
}

// hash one file without following links
async function sha256File(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(ADJUSTMENT_STREAM_BUFFER_BYTES);

  try {
    let position = 0;

    // stream the complete file through one bounded buffer
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);

      // stop only on exact end of file
      if (result.bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

// fsync one held private directory
async function syncDirectory(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// prove one owner-private directory
async function assertPrivateDirectory(path) {
  const details = await lstat(path);

  // reject links, foreign ownership and broad modes
  if (!details.isDirectory() || details.isSymbolicLink() ||
    details.uid !== process.getuid() || (details.mode & 0o777) !== 0o700) {
    throw resourceError("archive_directory_refused");
  }
  return details;
}

// prove one owner-private single-link file
async function assertPrivateFile(path) {
  const details = await lstat(path);

  // reject links, special files, foreign ownership and broad modes
  if (!details.isFile() || details.isSymbolicLink() ||
    details.uid !== process.getuid() || (details.mode & 0o777) !== 0o600 ||
    details.nlink !== 1) {
    throw resourceError("archive_file_refused");
  }
  return details;
}

// obtain the required path-free backing-C capacity proof
async function requireBackingCapacity(hook) {
  // refuse production admission without the physical backing hook
  if (typeof hook !== "function") {
    throw resourceError("backing_capacity_unavailable");
  }
  const value = await hook();
  requireExactKeys(value, ["allocatedBytes", "freeBytes", "freeInodes", "rootKind"], "backing capacity");

  // require the designated path-free backing identity
  if (value.rootKind !== "backing_c" || typeof value.freeBytes !== "bigint" ||
    typeof value.freeInodes !== "bigint" || typeof value.allocatedBytes !== "bigint" ||
    value.freeBytes < 0n || value.freeInodes < 0n || value.allocatedBytes < 0n) {
    throw resourceError("backing_capacity_invalid");
  }
  return value;
}

// identify forbidden local and remote storage namespaces
function isForbiddenStoragePath(path) {
  const lower = path.toLowerCase();
  return lower === "/mnt" || lower.startsWith("/mnt/") ||
    lower.includes("/documents/") || lower.endsWith("/documents") ||
    lower.includes("onedrive") || lower.includes("dropbox") ||
    lower.includes("google drive") || lower.includes("/net/") ||
    lower.startsWith("//");
}

// round logical bytes to allocated filesystem blocks
function roundAllocated(bytes, blockSize) {
  // preserve zero-byte allocation
  if (bytes === 0n) {
    return 0n;
  }
  return ((bytes + blockSize - 1n) / blockSize) * blockSize;
}

// construct one categorical capacity refusal
function resourceError(code) {
  const error = new Error(code);
  error.code = "resource_refused";
  error.reason = code;
  return error;
}

// require one safe object filename
function requireObjectFilename(value) {
  // reject paths and malformed content-addressed names
  if (typeof value !== "string" || !OBJECT_FILENAME_PATTERN.test(value) ||
    basename(value) !== value) {
    throw new TypeError("archive object filename is invalid");
  }
}

// require one supported ASCII kind
function requireKind(value) {
  // reject path-like, non-ASCII and unbounded kinds
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9.-]*)?$/u.test(value) ||
    value.length > 255) {
    throw new TypeError("CAS member kind is invalid");
  }
  return value;
}

// require one lowercase SHA-256 value
function requireSha256(value, label) {
  // reject every noncanonical hash spelling
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one decimal unsigned 64-bit string
function requireUint64String(value, label) {
  // reject noncanonical decimal or overflowing values
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one safe nonnegative integer
function requireSafeNonnegativeInteger(value, label) {
  // reject fractional, negative and unsafe offsets
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one immutable byte buffer
function requireBuffer(value, label) {
  // reject coercible or shared non-buffer values
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be a Buffer`);
  }
  return value;
}

// require one plain object
function requirePlainObject(value, label) {
  // reject arrays, null and prototype-bearing objects
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

// require one exact closed key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  // reject missing, unknown or repeated semantic fields
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has invalid keys`);
  }
}
