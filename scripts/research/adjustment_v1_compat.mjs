import { createHash } from "node:crypto";
import { basename } from "node:path";

export const ADJUSTMENT_V1_COMPATIBILITY_MANIFEST_CONTRACT_VERSION =
  "adjustment-v1-compatibility-manifest/v2";
export const ADJUSTMENT_V1_MAPPING_MAXIMUM_BYTES = 4n * 1_024n ** 3n;
export const ADJUSTMENT_V1_STREAM_BUFFER_BYTES = 256 * 1_024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/u;
const SAFE_FIXED_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const LEGACY_KINDS = new Set([
  "burned-ledger",
  "model-evidence",
  "object",
  "opened-ledger",
  "package",
  "receipt",
  "snapshot",
  "watermark",
]);

// create one content-addressed read-only v1 compatibility manifest
export async function createV1CompatibilityManifest(input, store) {
  requireExactKeys(input, ["graphLinks", "members", "oldWatermarkSha256"], "v1 manifest input");
  requireCompatibilityStore(store);
  requireSha256(input.oldWatermarkSha256, "oldWatermarkSha256");
  const identity = await store.identity();
  requireHeldRootIdentity(identity);

  // require one nonempty bounded legacy member list
  if (!Array.isArray(input.members) || input.members.length === 0 ||
    input.members.length > 65_536) {
    throw new TypeError("v1 members are invalid");
  }

  const names = new Set();
  const members = [];

  // hash every original member without rewriting it
  for (const requested of input.members) {
    requireExactKeys(requested, ["kind", "relativeName"], "v1 requested member");
    requireLegacyKind(requested.kind);
    requireRelativeName(requested.relativeName);

    // reject duplicate legacy names
    if (names.has(requested.relativeName)) {
      throw new TypeError("v1 member name is duplicated");
    }
    names.add(requested.relativeName);
    const details = await store.describe(requested.relativeName);
    requirePrivateLegacyFile(details);
    const digest = await hashLegacyMember(store, requested.relativeName, details.size);
    members.push({
      kind: requested.kind,
      relativeName: requested.relativeName,
      size: details.size,
      sha256: digest,
    });
  }

  members.sort(compareMembers);
  const graphLinks = normalizeGraphLinks(input.graphLinks, names);
  const manifest = {
    contractVersion: ADJUSTMENT_V1_COMPATIBILITY_MANIFEST_CONTRACT_VERSION,
    heldRootIdentitySha256: identity.heldRootIdentitySha256,
    oldWatermarkSha256: input.oldWatermarkSha256,
    members,
    graphLinks,
  };
  const bytes = canonicalJsonBytes(manifest);
  return { bytes, manifest, manifestSha256: sha256(bytes) };
}

// verify one manifest against unchanged original v1 bytes
export async function verifyV1CompatibilityManifest(manifest, expectedSha256, store) {
  requireCompatibilityStore(store);
  requireSha256(expectedSha256, "manifestSha256");
  validateV1CompatibilityManifest(manifest);
  const bytes = canonicalJsonBytes(manifest);

  // require the exact content-addressed manifest identity
  if (sha256(bytes) !== expectedSha256) {
    throw compatibilityError("compatibility_manifest_hash_mismatch");
  }

  const identity = await store.identity();
  requireHeldRootIdentity(identity);

  // bind access to the exact held legacy root
  if (identity.heldRootIdentitySha256 !== manifest.heldRootIdentitySha256) {
    throw compatibilityError("legacy_root_identity_mismatch");
  }

  // stream every original member and recheck metadata
  for (const member of manifest.members) {
    let details;

    try {
      details = await store.describe(member.relativeName);
      requirePrivateLegacyFile(details);
    } catch (error) {
      // convert every absent or unsafe member into honest history loss
      if (error?.code === "history_unavailable") {
        throw error;
      }
      throw compatibilityError("legacy_member_unavailable");
    }

    // reject missing, replaced, linked or resized members
    if (details.size !== member.size) {
      throw compatibilityError("legacy_member_metadata_mismatch");
    }

    let digest;

    try {
      digest = await hashLegacyMember(store, member.relativeName, member.size);
    } catch (error) {
      // preserve categorical compatibility failures
      if (error?.code === "history_unavailable") {
        throw error;
      }
      throw compatibilityError("legacy_member_unavailable");
    }

    // reject any byte mutation
    if (digest !== member.sha256) {
      throw compatibilityError("legacy_member_hash_mismatch");
    }
  }

  return {
    memberCount: manifest.members.length,
    oldWatermarkSha256: manifest.oldWatermarkSha256,
    status: "verified_read_only",
  };
}

// validate one closed compatibility manifest
export function validateV1CompatibilityManifest(manifest) {
  requireExactKeys(manifest, [
    "contractVersion",
    "graphLinks",
    "heldRootIdentitySha256",
    "members",
    "oldWatermarkSha256",
  ], "v1 compatibility manifest");

  // require the exact compatibility contract
  if (manifest.contractVersion !== ADJUSTMENT_V1_COMPATIBILITY_MANIFEST_CONTRACT_VERSION) {
    throw new TypeError("v1 compatibility contract is invalid");
  }
  requireSha256(manifest.heldRootIdentitySha256, "heldRootIdentitySha256");
  requireSha256(manifest.oldWatermarkSha256, "oldWatermarkSha256");

  // require one bounded canonical member array
  if (!Array.isArray(manifest.members) || manifest.members.length === 0 ||
    manifest.members.length > 65_536) {
    throw new TypeError("v1 manifest members are invalid");
  }

  const names = new Set();
  let previous = null;

  // validate every canonical member entry
  for (const member of manifest.members) {
    requireExactKeys(member, ["kind", "relativeName", "sha256", "size"], "v1 manifest member");
    requireLegacyKind(member.kind);
    requireRelativeName(member.relativeName);
    requireSha256(member.sha256, "v1 member sha256");

    // require one safe exact byte size
    if (!Number.isSafeInteger(member.size) || member.size < 0) {
      throw new TypeError("v1 member size is invalid");
    }

    // require unique canonical member order
    if (names.has(member.relativeName) ||
      (previous !== null && compareMembers(previous, member) >= 0)) {
      throw new TypeError("v1 member order is invalid");
    }
    names.add(member.relativeName);
    previous = member;
  }

  const normalizedLinks = normalizeGraphLinks(manifest.graphLinks, names);

  // require exact canonical link order
  if (!canonicalJsonBytes(normalizedLinks).equals(canonicalJsonBytes(manifest.graphLinks))) {
    throw new TypeError("v1 graph links are not canonical");
  }
  return manifest;
}

// map selected exact v1 bytes into a bounded private sink
export async function mapV1CompatibilityMembers(input, store, sink) {
  requireExactKeys(input, ["manifest", "manifestSha256", "targets"], "v1 mapping input");

  // require one fixed-name exclusive write sink
  if (sink === null || typeof sink !== "object" ||
    typeof sink.writeExclusive !== "function") {
    throw new TypeError("v1 mapping sink is invalid");
  }

  await verifyV1CompatibilityManifest(input.manifest, input.manifestSha256, store);

  // require one explicit bounded target selection
  if (!Array.isArray(input.targets) || input.targets.length > input.manifest.members.length) {
    throw new TypeError("v1 mapping targets are invalid");
  }

  const members = new Map(input.manifest.members.map(
    // index immutable members by relative name
    (member) => [member.relativeName, member],
  ));
  const fixedNames = new Set();
  let totalBytes = 0n;

  // materialize only caller-chosen fixed filenames
  for (const target of input.targets) {
    requireExactKeys(target, ["fixedName", "relativeName"], "v1 mapping target");
    requireRelativeName(target.relativeName);

    // reject paths and duplicate sink names
    if (typeof target.fixedName !== "string" ||
      !SAFE_FIXED_NAME_PATTERN.test(target.fixedName) ||
      basename(target.fixedName) !== target.fixedName || fixedNames.has(target.fixedName)) {
      throw new TypeError("v1 fixed mapping name is invalid");
    }
    fixedNames.add(target.fixedName);
    const member = members.get(target.relativeName);

    // reject selection outside the verified manifest
    if (member === undefined) {
      throw compatibilityError("legacy_member_not_manifested");
    }
    totalBytes += BigInt(member.size);

    // enforce the exclusive tmpfs compatibility ceiling
    if (totalBytes > ADJUSTMENT_V1_MAPPING_MAXIMUM_BYTES) {
      throw compatibilityError("legacy_mapping_capacity_refused");
    }

    await sink.writeExclusive(
      target.fixedName,
      streamLegacyMember(store, member.relativeName, member.size, member.sha256),
      member.size,
    );
  }

  return { mappedBytes: totalBytes.toString(), mappedFiles: fixedNames.size };
}

// classify honest local history availability without fabrication
export function classifyHistoryAvailability(input) {
  requireExactKeys(input, ["anchorPresent", "requirements"], "history availability input");

  // require one bounded requirement list
  if (!Array.isArray(input.requirements) || input.requirements.length === 0 ||
    input.requirements.length > 65_536 || typeof input.anchorPresent !== "boolean") {
    throw new TypeError("history requirements are invalid");
  }

  const unavailable = input.requirements.filter(
    // validate and select unavailable exact history classes
    (requirement) => {
      requireExactKeys(requirement, ["available", "kind", "verified"], "history requirement");

      // require one bounded categorical kind
      if (typeof requirement.kind !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(requirement.kind) ||
        typeof requirement.available !== "boolean" ||
        typeof requirement.verified !== "boolean") {
        throw new TypeError("history requirement is invalid");
      }
      return !requirement.available || !requirement.verified;
    },
  ).map(
    // expose only categorical missing classes
    (requirement) => requirement.kind,
  ).sort();

  // distinguish a complete local graph from an anchor-only projection
  if (unavailable.length === 0) {
    return {
      status: "history_available",
      unavailableKinds: [],
      anchorIsBackup: false,
      qualificationAllowed: true,
      priorReuseAllowed: true,
      rollbackEvidenceReuseAllowed: true,
      hotRetirementAllowed: true,
    };
  }

  return {
    status: "history_unavailable",
    unavailableKinds: unavailable,
    anchorIsBackup: false,
    anchorPresent: input.anchorPresent,
    qualificationAllowed: false,
    priorReuseAllowed: false,
    rollbackEvidenceReuseAllowed: false,
    hotRetirementAllowed: false,
    recoveryDisposition: "new_causal_interval_with_discontinuity_only",
  };
}

// normalize strong path-free graph links
function normalizeGraphLinks(value, names) {
  // require one bounded link array
  if (!Array.isArray(value) || value.length > 65_536) {
    throw new TypeError("v1 graph links are invalid");
  }

  return value.map(
    // validate one exact member-to-member link
    (linkValue) => {
      requireExactKeys(linkValue, ["fromRelativeName", "relation", "toRelativeName"], "v1 graph link");
      requireRelativeName(linkValue.fromRelativeName);
      requireRelativeName(linkValue.toRelativeName);

      // require both endpoints in the manifest
      if (!names.has(linkValue.fromRelativeName) || !names.has(linkValue.toRelativeName)) {
        throw new TypeError("v1 graph link endpoint is absent");
      }

      // require one bounded relation name
      if (typeof linkValue.relation !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(linkValue.relation)) {
        throw new TypeError("v1 graph relation is invalid");
      }
      return { ...linkValue };
    },
  ).sort(
    // order the complete link tuple canonically
    (left, right) => canonicalJsonBytes(left).compare(canonicalJsonBytes(right)),
  );
}

// hash one unchanged legacy member through bounded reads
async function hashLegacyMember(store, relativeName, size) {
  const hash = createHash("sha256");
  let bytes = 0;

  // stream every member byte without making a compatibility copy
  for await (const chunk of store.readChunks(relativeName, ADJUSTMENT_V1_STREAM_BUFFER_BYTES)) {
    // reject non-buffer or oversized reads
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 ||
      chunk.length > ADJUSTMENT_V1_STREAM_BUFFER_BYTES) {
      throw compatibilityError("legacy_reader_invalid");
    }
    hash.update(chunk);
    bytes += chunk.length;

    // reject bytes beyond the declared member
    if (bytes > size) {
      throw compatibilityError("legacy_member_size_mismatch");
    }
  }

  // require the exact declared member length
  if (bytes !== size) {
    throw compatibilityError("legacy_member_size_mismatch");
  }
  return hash.digest("hex");
}

// stream one exact legacy member to a fixed sink
async function* streamLegacyMember(store, relativeName, size, expectedSha256) {
  let bytes = 0;
  const hash = createHash("sha256");

  // forward only bounded original byte chunks
  for await (const chunk of store.readChunks(relativeName, ADJUSTMENT_V1_STREAM_BUFFER_BYTES)) {
    // reject invalid or oversized storage chunks
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 ||
      chunk.length > ADJUSTMENT_V1_STREAM_BUFFER_BYTES) {
      throw compatibilityError("legacy_reader_invalid");
    }
    bytes += chunk.length;
    hash.update(chunk);

    // reject a reader exceeding the immutable manifest size
    if (bytes > size) {
      throw compatibilityError("legacy_member_size_mismatch");
    }
    yield chunk;
  }

  // reject a short mapping read
  if (bytes !== size) {
    throw compatibilityError("legacy_member_size_mismatch");
  }

  // reject a mutation between verification and tmpfs mapping
  if (hash.digest("hex") !== expectedSha256) {
    throw compatibilityError("legacy_member_hash_mismatch");
  }
}

// compare canonical legacy members
function compareMembers(left, right) {
  return compareAscii(left.kind, right.kind) ||
    compareAscii(left.relativeName, right.relativeName);
}

// compare canonical ASCII strings bytewise
function compareAscii(left, right) {
  // return equality without allocation
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// require the injected read-only compatibility store
function requireCompatibilityStore(store) {
  // prohibit stores with mutation methods in this compatibility boundary
  if (store === null || typeof store !== "object" ||
    typeof store.identity !== "function" || typeof store.describe !== "function" ||
    typeof store.readChunks !== "function" ||
    ["write", "delete", "unlink", "rename", "copy", "decrypt"].some(
      // detect any exposed mutation capability
      (name) => typeof store[name] === "function",
    )) {
    throw new TypeError("v1 compatibility store must be read only");
  }
}

// require one path-free held-root identity
function requireHeldRootIdentity(identity) {
  requireExactKeys(identity, ["heldRootIdentitySha256", "rootKind"], "v1 held root identity");
  requireSha256(identity.heldRootIdentitySha256, "heldRootIdentitySha256");

  // reject path disclosure or unbounded root kinds
  if (typeof identity.rootKind !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(identity.rootKind)) {
    throw new TypeError("v1 root kind is invalid");
  }
}

// require owner-private single-link legacy metadata
function requirePrivateLegacyFile(details) {
  requireExactKeys(details, ["mode", "nlink", "owner", "size", "type"], "v1 member metadata");

  // reject missing, linked, foreign, mutable-mode or special files
  if (details.type !== "file" || details.mode !== 0o600 || details.nlink !== 1 ||
    details.owner !== "current_user" || !Number.isSafeInteger(details.size) ||
    details.size < 0) {
    throw compatibilityError("legacy_member_metadata_mismatch");
  }
}

// require one known legacy byte class
function requireLegacyKind(value) {
  // reject aliases and unknown legacy classes
  if (!LEGACY_KINDS.has(value)) {
    throw new TypeError("v1 member kind is invalid");
  }
}

// require one safe held-root-relative member name
function requireRelativeName(value) {
  // reject absolute paths, traversal and repeated separators
  if (typeof value !== "string" || !SAFE_RELATIVE_NAME_PATTERN.test(value) ||
    value.startsWith("/") || value.includes("..") || value.includes("//") ||
    value.endsWith("/")) {
    throw new TypeError("v1 relative member name is invalid");
  }
}

// encode recursively sorted canonical JSON
function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

// recursively normalize canonical JSON values
function canonicalValue(value) {
  // retain JSON scalar values
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // retain only finite nonnegative-zero numbers
  if (typeof value === "number") {
    // reject nonfinite and negative-zero encodings
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("canonical JSON number is invalid");
    }
    return value;
  }

  // preserve semantic array order
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

// calculate one lowercase SHA-256 digest
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// create one honest compatibility refusal
function compatibilityError(reason) {
  const error = new Error(reason);
  error.code = "history_unavailable";
  error.reason = reason;
  return error;
}

// require one lowercase SHA-256 value
function requireSha256(value, label) {
  // reject every noncanonical hash
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one plain object
function requirePlainObject(value, label) {
  // reject null, arrays and custom prototypes
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

// require one exact closed key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  // reject unknown or missing fields
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has invalid keys`);
  }
}
