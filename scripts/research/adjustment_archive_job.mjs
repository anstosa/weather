import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_MAXIMUM_PAGES,
  ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES,
  ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES,
  encodeCycleCapsule,
  validateCycleCapsule,
  validateCycleFinalManifest,
  validateCyclePage,
} from "./adjustment_cycle_pages.mjs";
import {
  ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES,
  ADJUSTMENT_DEFAULT_ARCHIVE_ROOT,
  ADJUSTMENT_FREE_SPACE_FLOOR_BYTES,
  ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
  ADJUSTMENT_MAXIMUM_ARCHIVE_FILES,
  ADJUSTMENT_MAXIMUM_CATALOG_SHARDS,
  ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS,
  ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES,
  ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES,
  ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES,
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS,
  ADJUSTMENT_MAXIMUM_STAGING_FILES,
  ADJUSTMENT_MAXIMUM_TASK_INODES,
  ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS,
  ADJUSTMENT_STAGING_CEILING_BYTES,
  ADJUSTMENT_STREAM_BUFFER_BYTES,
  ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES,
  adjustmentSha256,
  buildGraphManifest,
  canonicalJsonBytes,
  createPlaintextArchive,
} from "./adjustment_plaintext_archive.mjs";
import {
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  createMaintenanceJournal,
} from "./adjustment_maintenance_state.mjs";
import { ensureAdjustmentPrivateDirectory } from "./adjustment_private_directory.mjs";

export const ADJUSTMENT_ARCHIVE_TRANSFER_VERSION = "adjustment-archive-transfer/v1";
export const ADJUSTMENT_ARCHIVE_COUNT_CONTRACT_READY =
  ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION === "adjustment-graph-manifest/v2" &&
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS === 8_372 &&
  ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS === ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS &&
  ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS === 16_744 &&
  ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES === 1 &&
  ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES === 2 &&
  ADJUSTMENT_MAXIMUM_ARCHIVE_FILES === 16_747 &&
  ADJUSTMENT_MAXIMUM_CATALOG_SHARDS === 512 &&
  ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES === 384 &&
  ADJUSTMENT_MAXIMUM_STAGING_FILES === 256 &&
  ADJUSTMENT_MAXIMUM_TASK_INODES === 17_899 &&
  ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS ===
    ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS +
      ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS &&
  ADJUSTMENT_MAXIMUM_ARCHIVE_FILES ===
    ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS +
      ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES + ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES &&
  ADJUSTMENT_MAXIMUM_TASK_INODES ===
    ADJUSTMENT_MAXIMUM_ARCHIVE_FILES + ADJUSTMENT_MAXIMUM_CATALOG_SHARDS +
      ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES + ADJUSTMENT_MAXIMUM_STAGING_FILES;
export const ADJUSTMENT_ARCHIVE_REMOTE_GATE_READY = false;
export const ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS = 15_000;
export const ADJUSTMENT_ARCHIVE_TRANSFER_MAXIMUM_BYTES = 1_024 * 1_024;

const REQUIRED_NODE_VERSION = "v24.16.0";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const OPEN_CYCLE_CHECKPOINT_VERSION = "adjustment-open-cycle-checkpoint/v1";
const OPEN_CYCLE_METADATA_MAXIMUM_BYTES = ADJUSTMENT_ARCHIVE_TRANSFER_MAXIMUM_BYTES;
const CAPSULE_MANIFEST_MAXIMUM_BYTES = ADJUSTMENT_STREAM_BUFFER_BYTES;
const CAPSULE_MAXIMUM_BYTES = 16 + CAPSULE_MANIFEST_MAXIMUM_BYTES +
  ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES;
const EXT4_MAGIC = 0xef53n;
const MAXIMUM_CENSUS_ENTRIES = 10_000_000;
const MINIMUM_FREE_INODES = 32_768n;
const WINDOWS_CAPACITY_OUTPUT_MAXIMUM_BYTES = 512;
const WINDOWS_POWERSHELL =
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const WINDOWS_WSL = "/mnt/c/Windows/System32/wsl.exe";
const FIXED_WSL_DISTRIBUTION = "Ubuntu";
const FIXED_WSL_HOME = "/home/ubuntu";
const FIXED_SSH_CONFIG = join(homedir(), "weather", "deploy", "config", "ssh_config");
const FIXED_REMOTE_HOST = "weather-pi";
const FIXED_OPEN_CYCLE_PATH = join(
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  "archive-open.payload",
);
const FIXED_OPEN_CYCLE_METADATA_PATH = join(
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  "archive-open.current",
);
const FIXED_PROCESS_LOCK_PATH = join(ADJUSTMENT_DEFAULT_STATE_ROOT, "archive-job.lock");

// parse one exact bounded remote transfer document
export function parseAdjustmentArchiveTransfer(bytes) {
  const input = requireBuffer(bytes, "archive transfer bytes");
  // reject empty or oversized stdout before decoding
  if (input.length === 0 || input.length > ADJUSTMENT_ARCHIVE_TRANSFER_MAXIMUM_BYTES) {
    throw new RangeError("archive transfer size is invalid");
  }
  let value;
  // decode only strict utf8 json
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    throw new TypeError("archive transfer JSON is invalid");
  }
  requirePlainObject(value, "archive transfer");

  // accept only the exact idle document
  if (value.kind === "idle") {
    requireExactKeys(value, ["contractVersion", "kind"], "idle transfer");
    const normalized = {
      contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
      kind: "idle",
    };
    requireCanonicalTransfer(input, normalized);
    return normalized;
  }

  // validate one exact online page envelope
  if (value.kind === "page") {
    requireExactKeys(value, [
      "contractVersion",
      "header",
      "kind",
      "pageSha256",
      "payloadBase64",
      "projections",
    ], "page transfer");
    requireTransferVersion(value.contractVersion);
    const payload = decodeCanonicalBase64(value.payloadBase64);
    const page = validateCyclePage({
      header: value.header,
      pageSha256: value.pageSha256,
      payload,
      projections: value.projections,
    });
    const wire = {
      contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
      header: page.header,
      kind: "page",
      pageSha256: page.pageSha256,
      payloadBase64: payload.toString("base64"),
      projections: page.projections,
    };
    const canonicalBytes = requireCanonicalTransfer(input, wire);
    return { ...wire, canonicalBytes, payload };
  }

  // validate one genuine remote final manifest
  if (value.kind === "final") {
    requireExactKeys(value, [
      "contractVersion",
      "kind",
      "manifest",
      "manifestSha256",
    ], "final transfer");
    requireTransferVersion(value.contractVersion);
    requireSha256(value.manifestSha256, "final manifestSha256");
    const manifest = validateCycleFinalManifest(value.manifest);
    const manifestSha256 = adjustmentSha256(canonicalJsonBytes(manifest));
    // bind the transmitted identity to the canonical final bytes
    if (manifestSha256 !== value.manifestSha256) {
      throw new TypeError("archive final manifest identity is invalid");
    }
    const wire = {
      contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
      kind: "final",
      manifest,
      manifestSha256,
    };
    requireCanonicalTransfer(input, wire);
    return wire;
  }
  throw new TypeError("archive transfer kind is invalid");
}

// create one bounded persistent open-cycle checkpoint
export function createOpenCycleCheckpoint(options = {}) {
  // prohibit configurable production paths
  if (Object.hasOwn(options, "path")) {
    throw new TypeError("open-cycle path override is prohibited");
  }
  const store = options.store ?? new FixedOpenCycleStore();
  return new OpenCycleCheckpoint(store);
}

// own one append-only uncommitted cycle representation
class OpenCycleCheckpoint {
  #store;

  // retain only the bounded storage port
  constructor(store) {
    // require the complete checkpoint storage interface
    if (store === null || typeof store !== "object" ||
      typeof store.payloadSize !== "function" ||
      typeof store.readPayload !== "function" ||
      typeof store.readMetadata !== "function" ||
      typeof store.appendPayload !== "function" ||
      typeof store.writeMetadata !== "function" ||
      typeof store.truncatePayload !== "function" ||
      typeof store.remove !== "function") {
      throw new TypeError("open-cycle store is invalid");
    }
    this.#store = store;
  }

  // inspect and reconcile only an incomplete unacknowledgeable tail
  async inspect() {
    const metadataBytes = await this.#store.readMetadata();
    const metadata = parseOpenCycleMetadata(metadataBytes);
    let payloadBytes = await this.#store.payloadSize();
    // discard only raw bytes not committed by the atomic metadata checkpoint
    if (payloadBytes > metadata.payloadBytes) {
      await this.#store.truncatePayload(metadata.payloadBytes);
      payloadBytes = metadata.payloadBytes;
    }
    // reject lost bytes from an acknowledged metadata checkpoint
    if (payloadBytes !== metadata.payloadBytes) {
      throw new TypeError("open-cycle payload length differs");
    }
    const pages = await hydrateOpenCyclePages(this.#store, metadata);
    return {
      checkpointSha256: pages.length === 0
        ? null
        : hashOpenCycleCheckpoint(metadataBytes, pages),
      pages,
      byteLength: payloadBytes,
      metadataByteLength: metadataBytes.length,
    };
  }

  // append, fsync, reopen and verify one exact next page
  async append(transfer) {
    requireParsedPage(transfer);
    const current = await this.inspect();
    const last = current.pages.at(-1);

    // reuse only a byte-identical last page retry
    if (last?.pageSha256 === transfer.pageSha256) {
      // reject a changed envelope under one page identity
      if (!last.canonicalBytes.equals(transfer.canonicalBytes)) {
        throw new TypeError("open-cycle page retry differs");
      }
      return current;
    }

    // reject replay of an older acknowledged page
    if (current.pages.some(
      // match every earlier page identity
      (page) => page.pageSha256 === transfer.pageSha256,
    )) {
      throw new TypeError("open-cycle page order differs");
    }
    validateNextOpenPage(current.pages, transfer);
    // enforce the exact raw cycle ceiling before mutation
    if (current.byteLength + transfer.payload.length >
      ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES) {
      throw new RangeError("open-cycle checkpoint exceeds its bound");
    }
    await this.#store.appendPayload(transfer.payload);
    const metadata = buildOpenCycleMetadata([...current.pages, transfer]);
    await this.#store.writeMetadata(canonicalJsonBytes(metadata));
    const verified = await this.inspect();
    const appended = verified.pages.at(-1);
    // require exact post-fsync page and byte identity
    if (appended?.pageSha256 !== transfer.pageSha256 ||
      !appended.canonicalBytes.equals(transfer.canonicalBytes)) {
      throw new TypeError("open-cycle checkpoint verification failed");
    }
    return verified;
  }

  // bind one real final manifest to every retained page
  async verifyFinal(transfer) {
    requireParsedFinal(transfer);
    const status = await this.inspect();
    const manifest = transfer.manifest;
    const projectedPages = status.pages.map(
      // project the exact final-manifest page metadata
      (page) => ({
        pageIndex: page.header.pageIndex,
        pageSha256: page.pageSha256,
        predecessorPageSha256: page.header.predecessorPageSha256,
        payloadSha256: page.header.payloadSha256,
        payloadOffset: page.header.payloadOffset,
        payloadLength: page.payload.length,
      }),
    );
    const projectionIdentities = status.pages.flatMap(
      // retain only identities acknowledged by the page chain
      (page) => page.projections.map((projection) => projection.identitySha256),
    ).sort();
    // require the remote final to close exactly this incoming cycle
    if (status.pages.length === 0 || manifest.dueKey !== status.pages[0].header.dueKey ||
      manifest.generation !== status.pages[0].header.generation ||
      !canonicalJsonBytes(manifest.pages).equals(canonicalJsonBytes(projectedPages)) ||
      manifest.acknowledgedProjectionCount !== projectionIdentities.length ||
      manifest.acknowledgedProjectionRootSha256 !==
        adjustmentSha256(canonicalJsonBytes(projectionIdentities))) {
      throw new TypeError("archive final manifest differs from the open cycle");
    }
    return {
      checkpointSha256: status.checkpointSha256,
      pagePayloads: status.pages.map(
        // copy each bounded raw page for capsule encoding
        (page) => Buffer.from(page.payload),
      ),
    };
  }

  // remove only the exact cycle already sealed in the current graph
  async removeSealed(transfer) {
    await this.verifyFinal(transfer);
    await this.#store.remove();
    const after = await this.inspect();
    // require complete removal of only the incoming representation
    if (after.byteLength !== 0) {
      throw new TypeError("open-cycle checkpoint removal failed");
    }
  }

  // discard a pack only after its graph is durable and remote final advanced
  async discardAfterFinalGraph() {
    await this.#store.remove();
    const after = await this.inspect();
    // require both raw and metadata checkpoints to be absent
    if (after.byteLength !== 0 || after.metadataByteLength !== 0) {
      throw new TypeError("open-cycle checkpoint removal failed");
    }
  }
}

// create the existing capsule validator with bounded streaming reads
export function createAdjustmentCycleCapsuleValidator() {
  // validate in-memory publication bytes through the existing closed contract
  const validator = (bytes) => validateCycleCapsule(bytes);
  validator.maximumBytes = CAPSULE_MAXIMUM_BYTES;
  // create one independent bounded streaming validation session
  validator.createStream = ({ byteLength }) => createCapsuleStreamValidator(byteLength);
  return validator;
}

// continuously consume the closed transfer protocol until stopped
export async function consumeAdjustmentArchiveTransfers(ports) {
  requireConsumerPorts(ports);
  let iterations = 0;
  // poll serially so one page or final owns the archive lease at a time
  while (!ports.signal.aborted && iterations < (ports.maximumIterations ?? Infinity)) {
    const transfer = await ports.transport.next({ signal: ports.signal });
    await reconcileOutstandingArchiveLease(ports, transfer);
    // idle never creates a lease or archive state
    if (transfer.kind === "idle") {
      await ports.sleep(ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS, ports.signal);
      iterations += 1;
      continue;
    }
    const identity = transfer.kind === "page"
      ? transfer.pageSha256
      : transfer.manifestSha256;
    const lease = leaseIdentity(transfer.kind, identity);
    const now = ports.clock().toISOString();
    await ports.journal.acquireLease({
      dueKey: lease.dueKey,
      inputHeadSha256: identity,
      now,
      runId: lease.runId,
      scope: "archive",
    });

    // page acknowledgement names only the durable open checkpoint
    if (transfer.kind === "page") {
      const checkpoint = await ports.openCycle.append(transfer);
      await ports.transport.ackPage(
        transfer.pageSha256,
        checkpoint.checkpointSha256,
        { signal: ports.signal },
      );
    } else {
      const graphSha256 = await sealFinalCycle(ports, transfer);
      await ports.transport.ackFinal(
        transfer.manifestSha256,
        graphSha256,
        { signal: ports.signal },
      );
      await ports.openCycle.removeSealed(transfer);
    }
    await ports.journal.releaseLease({
      dueKey: lease.dueKey,
      now: ports.clock().toISOString(),
      runId: lease.runId,
      scope: "archive",
    });
    iterations += 1;
  }
  return { iterations, stopped: ports.signal.aborted };
}

// execute one fixed forced-command SSH verb
export async function executeAdjustmentArchiveSshVerb(verb, arguments_, options = {}) {
  const grammar = remoteVerbGrammar(verb, arguments_);
  const spawnImpl = options.spawnImpl ?? spawn;
  // refuse cancellation before creating a child process
  if (options.signal?.aborted) {
    throw transportError("transport_aborted", Buffer.alloc(0));
  }
  const sshAgentSocket = spawnImpl === spawn
    ? await requireSshAgentSocket()
    : undefined;
  const sshArguments = [
    "-F",
    FIXED_SSH_CONFIG,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "--",
    FIXED_REMOTE_HOST,
    grammar.command,
    ...grammar.arguments,
  ];
  const child = spawnImpl("/usr/bin/ssh", sshArguments, {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectBoundedChild(child, options.signal);
  // require acknowledgement verbs to emit no uncontrolled output
  if (verb !== "next") {
    if (output.stdout.length !== 0) {
      throw transportError("transport_ack_output_refused", output.stderr);
    }
    return undefined;
  }
  return parseAdjustmentArchiveTransfer(output.stdout);
}

// require one inherited owner socket for the fixed identity-agent config
async function requireSshAgentSocket() {
  const path = process.env.SSH_AUTH_SOCK;
  // reject absent, relative or unreasonable user-manager agent paths
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 4_096) {
    throw new Error("transport_agent_unavailable");
  }
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error("transport_agent_unavailable");
  }
  // require a literal current-user unix socket without link indirection
  if (!details.isSocket() || details.isSymbolicLink() || details.uid !== process.getuid() ||
    await realpath(path) !== path) {
    throw new Error("transport_agent_unavailable");
  }
  return path;
}

// measure the genuine backing-c capacity and approved local allocation census
export async function measureAdjustmentArchiveBackingCapacity(options = {}) {
  requirePlainObject(options, "archive backing capacity options");
  requireExactKeys(options, Object.hasOwn(options, "spawnImpl") ? ["spawnImpl"] : [],
    "archive backing capacity options");
  // accept only a process constructor for bounded regression injection
  if (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function") {
    throw new TypeError("archive backing capacity spawnImpl is invalid");
  }
  const evidence = await measureAdjustmentCapacityEvidence(options.spawnImpl ?? spawn);
  return evidence.backing;
}

// collect dual-layer capacity evidence without treating ext4 as backing c
async function measureAdjustmentCapacityEvidence(spawnImpl) {
  const home = resolve(homedir());
  const homeDetails = await lstat(home, { bigint: true });
  const filesystem = await statfs(home, { bigint: true });
  // require the fixed current-user native ext4 home
  if (home !== FIXED_WSL_HOME || !homeDetails.isDirectory() ||
    homeDetails.uid !== BigInt(process.getuid()) ||
    await realpath(home) !== home || BigInt(filesystem.type) !== EXT4_MAGIC) {
    throw new Error("archive backing filesystem is invalid");
  }
  const windows = await measureBackingCCapacity(spawnImpl, homeDetails);
  const roots = [
    join(home, ".weather"),
    join(home, "weather", ".omx", "evidence"),
    join(home, "weather", "deploy", "backups"),
    join(home, ".local", "lib", "weather-adjustment-maintenance"),
  ];
  const census = await measureImmutableLegacyCensus(roots, homeDetails.dev);
  return {
    backing: {
      allocatedBytes: census.allocatedBytes,
      freeBytes: windows.freeBytes,
      freeInodes: BigInt(filesystem.ffree),
      rootKind: "backing_c",
    },
    ext4FreeBytes: BigInt(filesystem.bavail) * BigInt(filesystem.bsize),
    ext4FreeInodes: BigInt(filesystem.ffree),
    ext4BlockSize: BigInt(filesystem.bsize),
    windowsTotalBytes: windows.totalBytes,
  };
}

// count immutable legacy allocations without following their links
export async function measureImmutableLegacyCensus(roots, expectedDevice) {
  // accept only one bounded absolute-root list
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 4 ||
    roots.some((root) => typeof root !== "string" || resolve(root) !== root || root.length > 4_096)) {
    throw new TypeError("archive backing census roots are invalid");
  }
  let device;
  try {
    device = BigInt(expectedDevice);
  } catch {
    throw new TypeError("archive backing census device is invalid");
  }
  // require one nonnegative filesystem identity
  if (device < 0n) {
    throw new TypeError("archive backing census device is invalid");
  }
  const ownerUid = BigInt(process.getuid());
  const seen = new Set();
  let allocatedBytes = 0n;
  let entryCount = 0;

  // census only caller-frozen local buckets
  for (const root of roots) {
    let details;
    try {
      details = await lstat(root, { bigint: true });
    } catch (error) {
      // skip only an absent frozen bucket
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const pending = [{ details, path: root }];
    // walk without following links or crossing the expected filesystem
    while (pending.length > 0) {
      const current = pending.pop();
      entryCount += 1;
      const supportedType = current.details.isDirectory() || current.details.isFile() ||
        current.details.isSymbolicLink();
      // stop an unexpectedly unbounded, foreign or active special census
      if (entryCount > MAXIMUM_CENSUS_ENTRIES || current.details.dev !== device ||
        current.details.uid !== ownerUid || !supportedType) {
        throw new Error("archive backing census is invalid");
      }
      const identity = `${current.details.dev}:${current.details.ino}`;
      // count each retained inode allocation only once
      if (!seen.has(identity)) {
        seen.add(identity);
        allocatedBytes += current.details.blocks * 512n;
      }
      // never traverse an immutable legacy symlink
      if (current.details.isDirectory()) {
        const directory = await opendir(current.path);
        // inspect every literal child through lstat only
        for await (const entry of directory) {
          const path = join(current.path, entry.name);
          pending.push({ details: await lstat(path, { bigint: true }), path });
        }
      }
    }
  }
  return { allocatedBytes, entryCount };
}

// obtain one exact bounded readonly windows c capacity result
async function measureBackingCCapacity(spawnImpl, homeDetails) {
  // prove the fixed executable on the production process boundary
  if (spawnImpl === spawn) {
    // require both standard literal executables rather than path lookup
    for (const path of [WINDOWS_WSL, WINDOWS_POWERSHELL]) {
      const details = await lstat(path);
      // reject missing, linked or substituted windows executables
      if (!details.isFile() || details.isSymbolicLink() || await realpath(path) !== path) {
        throw new Error("archive_backing_c_probe_unavailable");
      }
    }
  }
  const identityChild = spawnImpl(WINDOWS_WSL, [
    "-d",
    FIXED_WSL_DISTRIBUTION,
    "--exec",
    "/usr/bin/stat",
    "-Lc",
    "%d|%i",
    FIXED_WSL_HOME,
  ], {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identityOutput = await collectBoundedChild(
    identityChild,
    undefined,
    WINDOWS_CAPACITY_OUTPUT_MAXIMUM_BYTES,
  );
  const expectedIdentity = `${homeDetails.dev}|${homeDetails.ino}`;
  const identityText = identityOutput.stdout.toString("ascii");
  // bind literal ubuntu to this process's exact native ext4 home inode
  if (identityText !== `${expectedIdentity}\n` &&
    identityText !== `${expectedIdentity}\r\n`) {
    throw new Error("archive_wsl_identity_probe_invalid");
  }
  const command = [
    "$ErrorActionPreference='Stop'",
    "$distros=@(Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss | " +
      "ForEach-Object { Get-ItemProperty $_.PSPath } | " +
      `Where-Object { $_.DistributionName -eq '${FIXED_WSL_DISTRIBUTION}' })`,
    "if ($distros.Count -ne 1) { throw 'wsl distro mapping unavailable' }",
    "$vhd=[IO.Path]::GetFullPath((Join-Path $distros[0].BasePath 'ext4.vhdx'))",
    "if (-not $vhd.StartsWith('C:\\',[StringComparison]::OrdinalIgnoreCase) -or " +
      "-not (Test-Path -LiteralPath $vhd -PathType Leaf)) { throw 'wsl vhd is not c backed' }",
    "$drive=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"",
    "if ($null -eq $drive) { throw 'missing drive' }",
    "[Console]::Out.Write(('weather-backing-c/v1|{0}|{1}|ubuntu-vhd-on-c' -f " +
      "[uint64]$drive.Size,[uint64]$drive.FreeSpace))",
  ].join("; ");
  const child = spawnImpl(WINDOWS_POWERSHELL, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], {
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectBoundedChild(
    child,
    undefined,
    WINDOWS_CAPACITY_OUTPUT_MAXIMUM_BYTES,
  );
  const match = /^weather-backing-c\/v1\|([0-9]+)\|([0-9]+)\|ubuntu-vhd-on-c$/u.exec(
    output.stdout.toString("ascii"),
  );
  // reject ext4-shaped, localized, partial or impossible capacity output
  if (match === null) {
    throw new Error("archive_backing_c_probe_invalid");
  }
  const totalBytes = BigInt(match[1]);
  const freeBytes = BigInt(match[2]);
  // require one positive physical capacity with a bounded free result
  if (totalBytes < 1n || freeBytes < 0n || freeBytes > totalBytes) {
    throw new Error("archive_backing_c_probe_invalid");
  }
  return { freeBytes, totalBytes };
}

// evaluate every local and remote gate without creating archive state
export async function inspectAdjustmentArchiveJobReadiness() {
  const reasons = [];
  let capacityEvidence = null;
  // retain every independent code/runtime blocker
  if (process.version !== REQUIRED_NODE_VERSION) {
    reasons.push("node_runtime_unready");
  }
  if (ADJUSTMENT_ARCHIVE_COUNT_CONTRACT_READY !== true) {
    reasons.push("committed_graph_count_contract_pending");
  }
  if (ADJUSTMENT_ARCHIVE_REMOTE_GATE_READY !== true) {
    reasons.push("remote_predecessor_activation_contract_pending");
  }

  try {
    capacityEvidence = await measureAdjustmentCapacityEvidence(spawn);
    // require both real physical layers and the aggregate authorization
    if (capacityEvidence.ext4FreeBytes < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      capacityEvidence.backing.freeBytes < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
      capacityEvidence.ext4FreeInodes < MINIMUM_FREE_INODES ||
      capacityEvidence.backing.allocatedBytes > ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES) {
      reasons.push("physical_capacity_refused");
    }
  } catch {
    reasons.push("physical_capacity_unavailable");
  }

  try {
    const archive = await inspectExistingArchiveEnvelope(capacityEvidence);
    // preserve every literal archive and task count ceiling
    if (archive.allocatedBytes > ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES ||
      archive.objectCount > ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS ||
      archive.fileCount > ADJUSTMENT_MAXIMUM_ARCHIVE_FILES ||
      archive.taskInodes > BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES) ||
      archive.incomingCount > 1) {
      reasons.push("archive_envelope_refused");
    }
  } catch (error) {
    // classify prospective capacity refusal separately from invalid layout
    if (error?.code === "resource_refused" &&
      error?.reason === "archive_genesis_capacity_refused") {
      reasons.push("physical_capacity_refused");
    } else {
      reasons.push("archive_envelope_unavailable");
    }
  }

  // prove inherited agent and forced next only after reviewed remote gates exist
  if (reasons.length === 0) {
    await executeAdjustmentArchiveSshVerb("next", []);
  }
  return {
    contractVersion: "adjustment-archive-runner-readiness/v1",
    ready: reasons.length === 0,
    reason: reasons[0] ?? "ready",
  };
}

// inspect existing archive counts without initializing or repairing paths
async function inspectExistingArchiveEnvelope(capacity) {
  return await inspectArchiveEnvelopeAtRoot({
    archiveRoot: ADJUSTMENT_DEFAULT_ARCHIVE_ROOT,
    capacity,
    homeRoot: resolve(homedir()),
  });
}

// inspect one literal archive layout without creating or repairing it
async function inspectArchiveEnvelopeAtRoot(options) {
  requirePlainObject(options, "archive envelope inspection options");
  requireExactKeys(options, ["archiveRoot", "capacity", "homeRoot"],
    "archive envelope inspection options");
  const { archiveRoot, capacity, homeRoot } = options;
  // require the exact fixed layout shape even for test-only fixture roots
  if (typeof homeRoot !== "string" || resolve(homeRoot) !== homeRoot ||
    archiveRoot !== join(
      homeRoot,
      ".weather",
      "adjustment-maintenance",
      "v2",
      "archive-primary",
    )) {
    throw new TypeError("archive envelope paths are invalid");
  }
  const chain = await inspectProspectiveArchiveChain(homeRoot);
  const objectRoot = join(archiveRoot, "objects");
  const rootDetails = chain.details.get(archiveRoot) ?? null;
  const objectRootDetails = chain.details.get(objectRoot) ?? null;
  // refuse nonempty interrupted initialization before inspecting history
  if (rootDetails !== null && objectRootDetails === null &&
    !(await directoryIsEmpty(archiveRoot))) {
    throw new Error("archive interrupted initialization is not empty");
  }
  let allocatedBytes = 0n;
  let incomingCount = 0;
  let objectCount = 0;
  const objectHashes = new Set();
  // charge both existing archive directories
  for (const details of [rootDetails, objectRootDetails]) {
    // charge only one existing directory allocation
    if (details !== null) {
      allocatedBytes += details.blocks * 512n;
    }
  }
  // inspect complete object storage only after both directories exist
  if (objectRootDetails !== null) {
    await assertClosedArchiveRoot(archiveRoot);
    const opened = await openPrivateDirectoryStream(objectRoot);
    try {
      // count only the two closed object filename classes
      for await (const entry of opened.directory) {
        const path = join(objectRoot, entry.name);
        const details = await lstat(path, { bigint: true });
        // reject special, linked, foreign or broad archive entries
        if (!isPrivateFileDetails(details)) {
          throw new Error("archive envelope entry is invalid");
        }
        // classify committed objects without trusting their payload
        if (/^sha256-[a-f0-9]{64}\.obj$/u.test(entry.name)) {
          objectCount += 1;
          objectHashes.add(entry.name.slice(7, -4));
        } else if (/^\.incoming-[a-zA-Z0-9-]+$/u.test(entry.name)) {
          incomingCount += 1;
        } else {
          throw new Error("archive envelope filename is invalid");
        }
        allocatedBytes += details.blocks * 512n;
      }
    } finally {
      await opened.close();
    }
  }
  let pointerCount = 0;
  const pointers = new Map();
  // count only existing exact current and previous pointers
  for (const name of ["head.current", "head.previous"]) {
    try {
      const path = join(archiveRoot, name);
      const pointer = await readPrivatePointer(path);
      pointerCount += 1;
      allocatedBytes += pointer.details.blocks * 512n;
      pointers.set(name, pointer.sha256);
    } catch (error) {
      // accept only an absent genesis pointer
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const currentHead = pointers.get("head.current") ?? null;
  const previousHead = pointers.get("head.previous") ?? null;
  // reject incomplete publication or pointer history
  if (incomingCount !== 0 || previousHead !== null && currentHead === null ||
    objectCount !== 0 && currentHead === null ||
    currentHead !== null && !objectHashes.has(currentHead) ||
    previousHead !== null && !objectHashes.has(previousHead)) {
    throw new Error("archive history is incomplete");
  }
  const blockSize = requirePositiveBigInt(capacity?.ext4BlockSize,
    "archive genesis block size");
  const stateGenesis = await inspectProspectiveStateGenesis(
    chain.stateRoot,
    chain.details.get(chain.stateRoot) ?? null,
    blockSize,
  );
  const initializationDirectories = chain.missing.length;
  const initializationAllocatedBytes = BigInt(initializationDirectories) * blockSize +
    stateGenesis.allocatedBytes;
  const initializationInodes = BigInt(initializationDirectories) + stateGenesis.inodes;
  allocatedBytes += BigInt(chain.archiveMissing.length) * blockSize;
  const taskRoot = join(homeRoot, ".weather", "adjustment-maintenance", "v2");
  const taskInodes = await countPrivateTaskInodesIfPresent(taskRoot) + initializationInodes;
  assertProspectiveArchiveCapacity(capacity, {
    allocatedBytes,
    initializationAllocatedBytes,
    initializationInodes,
    taskInodes,
  });
  return {
    allocatedBytes,
    fileCount: objectCount + incomingCount + pointerCount,
    initializationAllocatedBytes,
    initializationAtomicAllocatedBytes: stateGenesis.allocatedBytes,
    initializationAtomicInodes: 1n,
    initializationDirectories,
    initializationInodes,
    initializationLockFiles: stateGenesis.missingLockFiles,
    incomingCount,
    objectCount,
    taskInodes,
  };
}

// prove every existing ancestor and list each prospective private directory
async function inspectProspectiveArchiveChain(homeRoot) {
  const homeDetails = await lstat(homeRoot, { bigint: true });
  // require the same home anchor accepted by actual initialization
  if (!homeDetails.isDirectory() || homeDetails.isSymbolicLink() ||
    homeDetails.uid !== BigInt(process.getuid()) ||
    (homeDetails.mode & 0o022n) !== 0n || await realpath(homeRoot) !== homeRoot) {
    throw new Error("archive envelope home is invalid");
  }
  const details = new Map();
  const missing = [];
  let path = homeRoot;
  let parentMissing = false;

  // inspect the exact fixed initialization suffix without following links
  for (const segment of [
    ".weather",
    "adjustment-maintenance",
    "v2",
    "archive-primary",
    "objects",
  ]) {
    path = join(path, segment);
    // every descendant of an absent parent is prospectively absent
    if (parentMissing) {
      missing.push(path);
      continue;
    }
    let current;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      // begin one contiguous absent suffix only at a missing literal child
      if (error?.code === "ENOENT") {
        parentMissing = true;
        missing.push(path);
        continue;
      }
      throw error;
    }
    // require owner-private same-filesystem literal ancestors
    if (!isPrivateDirectoryDetails(current) || current.dev !== homeDetails.dev ||
      await realpath(path) !== path) {
      throw new Error("archive envelope ancestor is invalid");
    }
    details.set(path, current);
  }
  const archiveMissing = [...missing];
  const stateRoot = join(
    homeRoot,
    ".weather",
    "adjustment-maintenance",
    "v2",
    "state",
  );
  const taskRoot = join(homeRoot, ".weather", "adjustment-maintenance", "v2");
  // inspect the sibling state root only when its literal parent exists
  if (details.has(taskRoot)) {
    try {
      const stateDetails = await lstat(stateRoot, { bigint: true });
      // require the same private filesystem boundary as archive state
      if (!isPrivateDirectoryDetails(stateDetails) || stateDetails.dev !== homeDetails.dev ||
        await realpath(stateRoot) !== stateRoot) {
        throw new Error("archive state ancestor is invalid");
      }
      details.set(stateRoot, stateDetails);
    } catch (error) {
      // admit only one prospectively absent state directory
      if (error?.code === "ENOENT") {
        missing.push(stateRoot);
      } else {
        throw error;
      }
    }
  } else {
    missing.push(stateRoot);
  }
  return { archiveMissing, details, missing, stateRoot };
}

// inspect deterministic state files and charge the atomic journal-head peak
async function inspectProspectiveStateGenesis(stateRoot, stateDetails, blockSize) {
  let missingLockFiles = 0;
  // inspect both persistent empty lock files
  for (const name of ["archive-job.lock", "journal.lock"]) {
    // every file beneath an absent state root is prospectively absent
    if (stateDetails === null) {
      missingLockFiles += 1;
      continue;
    }
    try {
      const details = await lstat(join(stateRoot, name), { bigint: true });
      // require one owner-private single-link lock inode
      if (!isPrivateFileDetails(details) || details.size !== 0n) {
        throw new Error("archive genesis state file is invalid");
      }
    } catch (error) {
      // admit only an absent deterministic lock file
      if (error?.code === "ENOENT") {
        missingLockFiles += 1;
      } else {
        throw error;
      }
    }
  }
  // validate an existing head before charging its atomic replacement
  if (stateDetails !== null) {
    try {
      const details = await lstat(join(stateRoot, "head.current"), { bigint: true });
      // require one replaceable owner-private head inode
      if (!isPrivateFileDetails(details)) {
        throw new Error("archive genesis state file is invalid");
      }
    } catch (error) {
      // an absent genesis head is created by the same atomic temp inode
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return {
    allocatedBytes: blockSize,
    inodes: BigInt(missingLockFiles) + 1n,
    missingLockFiles,
  };
}

// report whether one proven directory has no entries
async function directoryIsEmpty(path) {
  const opened = await openPrivateDirectoryStream(path);
  try {
    return await opened.directory.read() === null;
  } finally {
    await opened.close();
  }
}

// reject names outside the complete archive-root grammar
async function assertClosedArchiveRoot(archiveRoot) {
  const opened = await openPrivateDirectoryStream(archiveRoot);
  try {
    // inspect every root entry without following it
    for await (const entry of opened.directory) {
      // allow only object storage and the two pointer slots
      if (entry.name !== "objects" && entry.name !== "head.current" &&
        entry.name !== "head.previous") {
        throw new Error("archive envelope root entry is invalid");
      }
    }
  } finally {
    await opened.close();
  }
}

// hold one private directory inode while listing its entries
async function openPrivateDirectoryStream(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const held = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    // bind the literal path to the held private directory
    if (!isPrivateDirectoryDetails(held) || held.dev !== current.dev ||
      held.ino !== current.ino) {
      throw new Error("archive envelope directory changed");
    }
    const directory = await opendir(`/proc/self/fd/${handle.fd}`);
    return {
      directory,
      // close both listing and identity handles on every branch
      close: async () => {
        try {
          await directory.close();
        } catch (error) {
          // ignore only async-iteration's prior close
          if (error?.code !== "ERR_DIR_CLOSED") {
            throw error;
          }
        } finally {
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// read one private pointer through its held no-follow file handle
async function readPrivatePointer(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat({ bigint: true });
    const before = await lstat(path, { bigint: true });
    // bind metadata and path to the same private regular inode
    if (!isPrivateFileDetails(details) || before.dev !== details.dev ||
      before.ino !== details.ino || details.size !== 65n) {
      throw new Error("archive envelope pointer is invalid");
    }
    const bytes = await handle.readFile();
    const after = await lstat(path, { bigint: true });
    // reject replacement, resizing or a noncanonical hash pointer
    if (after.dev !== details.dev || after.ino !== details.ino || bytes.length !== 65 ||
      !/^[a-f0-9]{64}\n$/u.test(bytes.toString("ascii"))) {
      throw new Error("archive envelope pointer is invalid");
    }
    return { details, sha256: bytes.subarray(0, 64).toString("ascii") };
  } finally {
    await handle.close();
  }
}

// count an existing private task tree or one wholly absent genesis tree
async function countPrivateTaskInodesIfPresent(root) {
  try {
    await lstat(root, { bigint: true });
  } catch (error) {
    // accept only a wholly absent task root
    if (error?.code === "ENOENT") {
      return 0n;
    }
    throw error;
  }
  return await countPrivateTaskInodes(root);
}

// require one positive bigint capacity value
function requirePositiveBigInt(value, label) {
  // reject non-bigint and nonpositive capacity evidence
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one nonnegative bigint capacity value
function requireNonnegativeBigInt(value, label) {
  // reject non-bigint or negative capacity evidence
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// preserve every byte and inode bound across prospective initialization
function assertProspectiveArchiveCapacity(capacity, prospective) {
  requirePlainObject(capacity, "archive genesis capacity");
  requirePlainObject(capacity.backing, "archive genesis backing capacity");
  const ext4FreeBytes = requireNonnegativeBigInt(
    capacity.ext4FreeBytes,
    "archive genesis ext4 free bytes",
  );
  const ext4FreeInodes = requireNonnegativeBigInt(
    capacity.ext4FreeInodes,
    "archive genesis ext4 free inodes",
  );
  const backingAllocatedBytes = requireNonnegativeBigInt(
    capacity.backing.allocatedBytes,
    "archive genesis backing allocated bytes",
  );
  const backingFreeBytes = requireNonnegativeBigInt(
    capacity.backing.freeBytes,
    "archive genesis backing free bytes",
  );
  const backingFreeInodes = requireNonnegativeBigInt(
    capacity.backing.freeInodes,
    "archive genesis backing free inodes",
  );
  const nextFreeBytes = ADJUSTMENT_FREE_SPACE_FLOOR_BYTES +
    prospective.initializationAllocatedBytes;
  const nextFreeInodes = MINIMUM_FREE_INODES + prospective.initializationInodes;
  // refuse any next state beyond a frozen archive, aggregate or floor bound
  if (prospective.allocatedBytes > ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES ||
    prospective.taskInodes > BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES) ||
    ext4FreeBytes < nextFreeBytes || backingFreeBytes < nextFreeBytes ||
    ext4FreeInodes < nextFreeInodes || backingFreeInodes < nextFreeInodes ||
    backingAllocatedBytes + prospective.initializationAllocatedBytes >
      ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES) {
    const error = new Error("archive_genesis_capacity_refused");
    error.code = "resource_refused";
    error.reason = "archive_genesis_capacity_refused";
    throw error;
  }
}

export const adjustmentArchiveJobTestOnly = Object.freeze({
  // inspect only caller-owned readonly fixture paths
  inspectArchiveEnvelope: async (options) => await inspectArchiveEnvelopeAtRoot(options),
  // exercise bounded backing-c framing without claiming native workstation authority
  measureBackingCCapacity,
});

// count only private adjustment-maintenance inodes without following links
async function countPrivateTaskInodes(root) {
  const pending = [root];
  let count = 0n;
  // walk the fixed task root under the global finite ceiling
  while (pending.length > 0) {
    const path = pending.pop();
    const details = await lstat(path, { bigint: true });
    // reject links, foreign owners, broad modes and special files
    if (details.uid !== BigInt(process.getuid()) || details.isSymbolicLink() ||
      (details.mode & 0o077n) !== 0n ||
      (!details.isDirectory() && !details.isFile())) {
      throw new Error("archive task inode census is invalid");
    }
    count += 1n;
    // refuse an unbounded tree before further traversal
    if (count > BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES)) {
      return count;
    }
    // descend only through private literal directories
    if (details.isDirectory()) {
      const opened = await openPrivateDirectoryStream(path);
      try {
        // retain each literal child for bounded inspection
        for await (const entry of opened.directory) {
          pending.push(join(path, entry.name));
        }
      } finally {
        await opened.close();
      }
    }
  }
  return count;
}

// classify one private task directory from bigint stat data
function isPrivateDirectoryDetails(details) {
  return details.isDirectory() && !details.isSymbolicLink() &&
    details.uid === BigInt(process.getuid()) && (details.mode & 0o777n) === 0o700n;
}

// classify one private single-link task file from bigint stat data
function isPrivateFileDetails(details) {
  return details.isFile() && !details.isSymbolicLink() &&
    details.uid === BigInt(process.getuid()) && (details.mode & 0o777n) === 0o600n &&
    details.nlink === 1n;
}

// run the production job only after every activation gate is closed
export async function runAdjustmentArchiveJob() {
  const readiness = await inspectAdjustmentArchiveJobReadiness();
  // refuse initialization until every local and remote gate is proven
  if (!readiness.ready) {
    throw new Error(readiness.reason);
  }
  await ensureAdjustmentPrivateDirectory("state");
  const processLock = await acquireProcessLifetimeLock(FIXED_PROCESS_LOCK_PATH);
  const abortController = new AbortController();
  // request a clean stop without inventing completion
  const stop = () => abortController.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    const journal = createMaintenanceJournal();
    await journal.initialize();
    const archive = createPlaintextArchive({
      backingCapacity: measureAdjustmentArchiveBackingCapacity,
      memberValidators: new Map([[
        ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
        createAdjustmentCycleCapsuleValidator(),
      ]]),
    });
    await archive.initialize();
    const openCycle = createOpenCycleCheckpoint();
    const transport = {
      // request only one current remote transfer
      next: async ({ signal }) => await executeAdjustmentArchiveSshVerb("next", [], { signal }),
      // acknowledge one durable page checkpoint
      ackPage: async (pageSha256, checkpointSha256, { signal }) =>
        await executeAdjustmentArchiveSshVerb(
          "page_ack",
          [pageSha256, checkpointSha256],
          { signal },
        ),
      // acknowledge one fully verified final graph
      ackFinal: async (manifestSha256, graphSha256, { signal }) =>
        await executeAdjustmentArchiveSshVerb(
          "final_ack",
          [manifestSha256, graphSha256],
          { signal },
        ),
    };
    return await consumeAdjustmentArchiveTransfers({
      archive,
      clock: () => new Date(),
      journal,
      openCycle,
      readHead: readProductionArchiveHead,
      signal: abortController.signal,
      sleep: waitForAdjustmentArchivePoll,
      transport,
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await processLock.release();
  }
}

// project parsed pages into one sanitized atomic checkpoint
function buildOpenCycleMetadata(pages) {
  const records = pages.map(
    // omit every raw payload while retaining its closed transfer identity
    (page) => ({
      header: page.header,
      pageSha256: page.pageSha256,
      payloadLength: page.payload.length,
      projections: page.projections,
      transferSha256: adjustmentSha256(page.canonicalBytes),
    }),
  );
  return {
    contractVersion: OPEN_CYCLE_CHECKPOINT_VERSION,
    pages: records,
    payloadBytes: records.reduce(
      // sum the exact contiguous raw payload ranges
      (total, page) => total + page.payloadLength,
      0,
    ),
  };
}

// parse one canonical value-free checkpoint document
function parseOpenCycleMetadata(bytes) {
  const input = requireBuffer(bytes, "open-cycle metadata bytes");
  // treat two absent files as an empty open cycle
  if (input.length === 0) {
    return {
      contractVersion: OPEN_CYCLE_CHECKPOINT_VERSION,
      pages: [],
      payloadBytes: 0,
    };
  }
  // refuse an oversized metadata allocation before decoding
  if (input.length > OPEN_CYCLE_METADATA_MAXIMUM_BYTES) {
    throw new RangeError("open-cycle metadata exceeds its bound");
  }
  let value;
  // decode only strict canonical utf8 json
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    throw new TypeError("open-cycle metadata JSON is invalid");
  }
  requireExactKeys(value, ["contractVersion", "pages", "payloadBytes"], "open-cycle metadata");
  // require one exact closed checkpoint contract and bounded page list
  if (value.contractVersion !== OPEN_CYCLE_CHECKPOINT_VERSION ||
    !Array.isArray(value.pages) || value.pages.length < 1 ||
    value.pages.length > ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
    !Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 1 ||
    value.payloadBytes > ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES) {
    throw new TypeError("open-cycle metadata bounds are invalid");
  }
  let totalPayloadBytes = 0;
  // validate every sanitized page record before reading raw bytes
  for (const page of value.pages) {
    requireExactKeys(page, [
      "header",
      "pageSha256",
      "payloadLength",
      "projections",
      "transferSha256",
    ], "open-cycle metadata page");
    requireSha256(page.pageSha256, "open-cycle pageSha256");
    requireSha256(page.transferSha256, "open-cycle transferSha256");
    // preserve the existing per-page raw ceiling
    if (!Number.isSafeInteger(page.payloadLength) || page.payloadLength < 1 ||
      page.payloadLength > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES ||
      !Array.isArray(page.projections)) {
      throw new TypeError("open-cycle metadata page is invalid");
    }
    totalPayloadBytes += page.payloadLength;
  }
  // bind the declared total and exact canonical bytes
  if (totalPayloadBytes !== value.payloadBytes ||
    !canonicalJsonBytes(value).equals(input)) {
    throw new TypeError("open-cycle metadata is not canonical");
  }
  return value;
}

// hydrate and validate every bounded raw page from its metadata range
async function hydrateOpenCyclePages(store, metadata) {
  const pages = [];
  let offset = 0;
  // read no more than one 256-kib page at a time
  for (const record of metadata.pages) {
    const payload = await store.readPayload(offset, record.payloadLength);
    // reject a truncated or widened storage-port read
    if (!Buffer.isBuffer(payload) || payload.length !== record.payloadLength) {
      throw new TypeError("open-cycle payload read differs");
    }
    const wire = {
      contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
      header: record.header,
      kind: "page",
      pageSha256: record.pageSha256,
      payloadBase64: payload.toString("base64"),
      projections: record.projections,
    };
    const canonicalBytes = canonicalJsonBytes(wire);
    // bind sanitized metadata to the exact received transfer envelope
    if (adjustmentSha256(canonicalBytes) !== record.transferSha256) {
      throw new TypeError("open-cycle transfer identity differs");
    }
    const page = parseAdjustmentArchiveTransfer(canonicalBytes);
    validateNextOpenPage(pages, page);
    pages.push(page);
    offset += payload.length;
  }
  return pages;
}

// bind atomic metadata and streamed raw payload identities into one receipt
function hashOpenCycleCheckpoint(metadataBytes, pages) {
  const rawHash = createHash("sha256");
  // hash only already bounded hydrated pages without aggregate concatenation
  for (const page of pages) {
    rawHash.update(page.payload);
  }
  return adjustmentSha256(Buffer.from(
    `${OPEN_CYCLE_CHECKPOINT_VERSION}\n${adjustmentSha256(metadataBytes)}\n` +
    `${rawHash.digest("hex")}\n`,
    "ascii",
  ));
}

// enforce one consecutive same-cycle page append
function validateNextOpenPage(pages, page) {
  const previous = pages.at(-1);
  // require genesis to start at the first page
  if (previous === undefined) {
    if (page.header.pageIndex !== 0 || page.header.predecessorPageSha256 !== null ||
      page.header.payloadOffset !== 0) {
      throw new TypeError("open-cycle genesis page is invalid");
    }
    return;
  }
  // require exact due, generation, predecessor, index and byte offset continuity
  if (page.header.dueKey !== previous.header.dueKey ||
    page.header.generation !== previous.header.generation ||
    page.header.pageIndex !== previous.header.pageIndex + 1 ||
    page.header.predecessorPageSha256 !== previous.pageSha256 ||
    page.header.payloadOffset !== previous.header.payloadOffset + previous.payload.length) {
    throw new TypeError("open-cycle page chain differs");
  }
}

// stream one finalized capsule without whole-member read buffers
function createCapsuleStreamValidator(byteLength) {
  // reject the declared member bound before allocation
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > CAPSULE_MAXIMUM_BYTES) {
    throw new RangeError("cycle capsule member size is invalid");
  }
  const header = Buffer.alloc(16);
  let headerBytes = 0;
  let manifestBytes = null;
  let manifestOffset = 0;
  let manifest = null;
  let pageIndex = 0;
  let pageBytes = 0;
  let pageHash = createHash("sha256");
  let consumed = 0;

  return {
    // consume each archive reader chunk through the capsule state machine
    write(chunk) {
      let offset = 0;
      consumed += chunk.length;
      // reject bytes beyond the declared member length
      if (consumed > byteLength) {
        throw new TypeError("cycle capsule has trailing bytes");
      }
      // advance through header, manifest and bounded page hashes
      while (offset < chunk.length) {
        // fill and validate the fixed header first
        if (headerBytes < header.length) {
          const length = Math.min(header.length - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + length);
          headerBytes += length;
          offset += length;
          // initialize the bounded manifest only after a complete header
          if (headerBytes === header.length) {
            if (!header.subarray(0, 8).equals(Buffer.from("WXACYCL2", "ascii"))) {
              throw new TypeError("cycle capsule header is invalid");
            }
            const manifestLength = header.readUInt32BE(8);
            // bound the decoded manifest independently of the capsule
            if (manifestLength === 0 || manifestLength > CAPSULE_MANIFEST_MAXIMUM_BYTES) {
              throw new TypeError("cycle capsule manifest length is invalid");
            }
            manifestBytes = Buffer.alloc(manifestLength);
          }
          continue;
        }
        // fill and validate the canonical final manifest
        if (manifest === null) {
          const length = Math.min(manifestBytes.length - manifestOffset, chunk.length - offset);
          chunk.copy(manifestBytes, manifestOffset, offset, offset + length);
          manifestOffset += length;
          offset += length;
          // parse only after the complete bounded manifest arrives
          if (manifestOffset === manifestBytes.length) {
            let value;
            try {
              value = JSON.parse(manifestBytes.toString("utf8"));
            } catch {
              throw new TypeError("cycle capsule manifest JSON is invalid");
            }
            // require exact canonical manifest bytes and redundant count
            if (!canonicalJsonBytes(value).equals(manifestBytes) ||
              header.readUInt32BE(12) !== value.pageCount) {
              throw new TypeError("cycle capsule manifest is not canonical");
            }
            manifest = validateCycleFinalManifest(value);
            if (byteLength !== 16 + manifestBytes.length + manifest.totalPayloadBytes) {
              throw new TypeError("cycle capsule byte length is invalid");
            }
          }
          continue;
        }
        const page = manifest.pages[pageIndex];
        // reject payload bytes after the declared final page
        if (page === undefined) {
          throw new TypeError("cycle capsule has trailing bytes");
        }
        const length = Math.min(page.payloadLength - pageBytes, chunk.length - offset);
        pageHash.update(chunk.subarray(offset, offset + length));
        pageBytes += length;
        offset += length;
        // close each page at its exact declared hash
        if (pageBytes === page.payloadLength) {
          if (pageHash.digest("hex") !== page.payloadSha256) {
            throw new TypeError("cycle capsule page hash is invalid");
          }
          pageIndex += 1;
          pageBytes = 0;
          pageHash = createHash("sha256");
        }
      }
    },
    // require the complete capsule and every page hash
    finish() {
      if (consumed !== byteLength || manifest === null ||
        pageIndex !== manifest.pageCount || pageBytes !== 0) {
        throw new TypeError("cycle capsule is truncated");
      }
      return true;
    },
  };
}

// publish one final capsule and predecessor graph exactly once
async function sealFinalCycle(ports, transfer) {
  const verifiedOpen = await ports.openCycle.verifyFinal(transfer);
  const capsule = encodeCycleCapsule({
    manifest: transfer.manifest,
    manifestSha256: transfer.manifestSha256,
    pagePayloads: verifiedOpen.pagePayloads,
  });
  const published = await ports.archive.publishCasObject([{
    identitySha256: transfer.manifestSha256,
    kind: ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
    payload: capsule,
  }]);
  const expectedEntry = graphEntryForMember(published, published.members[0]);
  const currentHead = await ports.readHead();

  // reuse only the already current exact finalized cycle graph
  if (currentHead !== null) {
    requireSha256(currentHead, "archive current head");
    const current = await ports.archive.verifyFullGraph(currentHead);
    const existing = current.manifest.entries.find(
      // locate the finalized cycle identity at the current head
      (entry) => entry.identitySha256 === transfer.manifestSha256,
    );
    // accept only an exact retry of the same capsule entry
    if (existing !== undefined) {
      if (!canonicalJsonBytes(existing).equals(canonicalJsonBytes(expectedEntry))) {
        throw new TypeError("archive final graph retry differs");
      }
      return currentHead;
    }
  }
  const manifest = buildGraphManifest({
    crossLinks: [],
    entries: [expectedEntry],
    predecessorGraphSha256: currentHead,
  });
  const graph = await ports.archive.publishGraphManifest(manifest);
  await ports.archive.verifyFullGraph(graph.objectSha256);
  await ports.archive.updateHead(graph.objectSha256);
  const durableHead = await ports.readHead();
  // require pointer fsync visibility before remote final acknowledgement
  if (durableHead !== graph.objectSha256) {
    throw new TypeError("archive final graph head differs");
  }
  return graph.objectSha256;
}

// reconcile one prior crash before acting on the current remote state
async function reconcileOutstandingArchiveLease(ports, transfer) {
  const status = await ports.journal.status();
  const active = status.activeLeases.find(
    // select only the process-wide archive lease
    (lease) => lease.scope === "archive",
  );
  // continue immediately without an old archive lease
  if (active === undefined) {
    return;
  }
  const remoteIdentity = transfer.kind === "page"
    ? transfer.pageSha256
    : transfer.kind === "final" ? transfer.manifestSha256 : null;
  const activeIdentity = active.dueKey.split("/").at(-1);
  requireSha256(activeIdentity, "active archive identity");
  const now = ports.clock().toISOString();
  const expired = Date.parse(active.expiresAt) <= Date.parse(now);

  // retain an exact same-transfer lease for idempotent retry
  if (remoteIdentity === activeIdentity) {
    // reconcile expiry only against the still-present remote state
    if (expired) {
      const immutableOutputSha256 = active.dueKey.startsWith("archive/final/")
        ? await requireDurableFinalOutput(ports, activeIdentity)
        : await requireDurablePageOutput(ports, activeIdentity);
      await ports.journal.reconcileExpiredLease({
        dueKey: active.dueKey,
        immutableOutputSha256,
        now,
        remoteStateSha256: activeIdentity,
        resolution: "resume",
        runId: active.runId,
        scope: "archive",
      });
    }
    return;
  }
  const immutableOutputSha256 = active.dueKey.startsWith("archive/final/")
    ? await requireDurableFinalOutput(ports, activeIdentity)
    : await requireDurablePageOutput(ports, activeIdentity);
  // remove a final incoming pack only after the remote advanced past its final
  if (active.dueKey.startsWith("archive/final/")) {
    const open = await ports.openCycle.inspect();
    // remove only the remaining temporary pack after durable final output
    if (open.byteLength > 0) {
      await ports.openCycle.discardAfterFinalGraph();
    }
  }
  // close an expired or live lease with the exact durable and remote evidence
  if (expired) {
    await ports.journal.reconcileExpiredLease({
      dueKey: active.dueKey,
      immutableOutputSha256,
      now,
      remoteStateSha256: remoteIdentity,
      resolution: "complete",
      runId: active.runId,
      scope: "archive",
    });
  } else {
    await ports.journal.releaseLease({
      dueKey: active.dueKey,
      now,
      runId: active.runId,
      scope: "archive",
    });
  }
}

// require one prior page checkpoint to remain locally durable
async function requireDurablePageOutput(ports, pageSha256) {
  const open = await ports.openCycle.inspect();
  // find the exact retained page before resolving its lease
  if (!open.pages.some((page) => page.pageSha256 === pageSha256) ||
    open.checkpointSha256 === null) {
    throw new Error("archive page checkpoint unavailable");
  }
  return open.checkpointSha256;
}

// require one final graph identity at the current verified head
async function requireDurableFinalOutput(ports, manifestSha256) {
  const head = await ports.readHead();
  // require a current finalized graph
  if (head === null) {
    throw new Error("archive final graph unavailable");
  }
  const verified = await ports.archive.verifyFullGraph(head);
  // require the exact finalized cycle entry at the head
  if (!verified.manifest.entries.some(
    (entry) => entry.identitySha256 === manifestSha256 &&
      entry.kind === ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
  )) {
    throw new Error("archive final graph unavailable");
  }
  return head;
}

// project one published member into a graph entry
function graphEntryForMember(published, member) {
  return {
    kind: member.kind,
    identitySha256: member.identitySha256,
    objectSha256: published.objectSha256,
    memberOffset: member.memberOffset,
    memberLength: member.memberLength,
    memberSha256: member.memberSha256,
  };
}

// derive one stable journal lease identity
function leaseIdentity(kind, identity) {
  requireSha256(identity, "archive lease identity");
  return {
    dueKey: `archive/${kind}/${identity}`,
    runId: `archive-${kind}-${identity}`,
  };
}

// require the complete injected consumer boundary
function requireConsumerPorts(ports) {
  requirePlainObject(ports, "archive consumer ports");
  // require every concrete operation used by the loop
  if (typeof ports.archive?.publishCasObject !== "function" ||
    typeof ports.archive?.publishGraphManifest !== "function" ||
    typeof ports.archive?.verifyFullGraph !== "function" ||
    typeof ports.archive?.updateHead !== "function" ||
    typeof ports.journal?.status !== "function" ||
    typeof ports.journal?.acquireLease !== "function" ||
    typeof ports.journal?.releaseLease !== "function" ||
    typeof ports.journal?.reconcileExpiredLease !== "function" ||
    typeof ports.openCycle?.inspect !== "function" ||
    typeof ports.openCycle?.append !== "function" ||
    typeof ports.openCycle?.verifyFinal !== "function" ||
    typeof ports.openCycle?.removeSealed !== "function" ||
    typeof ports.openCycle?.discardAfterFinalGraph !== "function" ||
    typeof ports.transport?.next !== "function" ||
    typeof ports.transport?.ackPage !== "function" ||
    typeof ports.transport?.ackFinal !== "function" ||
    typeof ports.clock !== "function" || typeof ports.readHead !== "function" ||
    typeof ports.sleep !== "function" || !(ports.signal instanceof AbortSignal)) {
    throw new TypeError("archive consumer ports are invalid");
  }
  // accept only a positive finite test iteration bound
  if (ports.maximumIterations !== undefined &&
    (!Number.isInteger(ports.maximumIterations) || ports.maximumIterations < 1)) {
    throw new TypeError("archive consumer iteration bound is invalid");
  }
}

// read one fixed owner-private graph head
async function readProductionArchiveHead() {
  const path = join(ADJUSTMENT_DEFAULT_ARCHIVE_ROOT, "head.current");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    // treat only an absent genesis pointer as empty
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const details = await handle.stat();
    // require one exact owner-private single-link pointer
    if (!details.isFile() || details.uid !== process.getuid() ||
      (details.mode & 0o777) !== 0o600 || details.nlink !== 1 || details.size !== 65) {
      throw new TypeError("archive head metadata is invalid");
    }
    const value = await handle.readFile("ascii");
    // accept only one lowercase hash and newline
    if (!/^[a-f0-9]{64}\n$/u.test(value)) {
      throw new TypeError("archive head value is invalid");
    }
    return value.slice(0, 64);
  } finally {
    await handle.close();
  }
}

// hold one process-lifetime kernel flock
async function acquireProcessLifetimeLock(path) {
  const lockHandle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const holder = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", path, "/bin/sh", "-c", "printf ready; cat >/dev/null"],
    { shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  const ready = await readLockReady(holder);
  // refuse a second process or malformed lock helper
  if (ready !== "ready") {
    holder.stdin.end();
    await waitForChildExit(holder).catch(() => undefined);
    await lockHandle.close();
    throw new Error("archive_process_lock_occupied");
  }
  return {
    // release only by closing the held helper stdin
    async release() {
      holder.stdin.end();
      await waitForChildExit(holder);
      await lockHandle.close();
    },
  };
}

// retain one fixed raw pack and one sanitized atomic checkpoint
class FixedOpenCycleStore {
  #path = FIXED_OPEN_CYCLE_PATH;
  #metadataPath = FIXED_OPEN_CYCLE_METADATA_PATH;

  // report one bounded raw pack length without allocation
  async payloadSize() {
    try {
      const details = await assertPrivateOpenCycleFile(this.#path);
      // reject an oversized incoming pack before reading it
      if (details.size > ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES) {
        throw new RangeError("open-cycle checkpoint exceeds its bound");
      }
      return details.size;
    } catch (error) {
      // treat only absence as no open cycle
      if (error?.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  // read one bounded raw page range
  async readPayload(offset, length) {
    // reject aggregate or out-of-range reads at the storage boundary
    if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 1 ||
      length > ADJUSTMENT_STREAM_BUFFER_BYTES ||
      offset + length > ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES) {
      throw new RangeError("open-cycle payload read is invalid");
    }
    const handle = await open(this.#path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      // require one private in-range raw file
      if (!isPrivateOpenCycleDetails(details) || offset + length > details.size) {
        throw new TypeError("open-cycle payload target is invalid");
      }
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  // read one bounded canonical metadata checkpoint
  async readMetadata() {
    let handle;
    try {
      handle = await open(
        this.#metadataPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const details = await handle.stat();
      // reject oversized metadata before allocation
      if (!isPrivateOpenCycleDetails(details) ||
        details.size > OPEN_CYCLE_METADATA_MAXIMUM_BYTES) {
        throw new RangeError("open-cycle metadata exceeds its bound");
      }
      return await handle.readFile();
    } catch (error) {
      // treat only absence as no checkpoint
      if (error?.code === "ENOENT") {
        return Buffer.alloc(0);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  // append and fsync one bounded raw page
  async appendPayload(bytes) {
    const input = requireBuffer(bytes, "open-cycle append bytes");
    // accept no aggregate write above one protocol page
    if (input.length < 1 || input.length > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES) {
      throw new RangeError("open-cycle append bytes are invalid");
    }
    let existingSize = 0;
    try {
      existingSize = (await assertPrivateOpenCycleFile(this.#path)).size;
    } catch (error) {
      // treat only an absent raw pack as a new inode
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await assertLocalStagingAdmission(input.length, existingSize === 0 ? 1n : 0n);
    const handle = await open(
      this.#path,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const details = await handle.stat();
      // require one private file and bounded post-append length
      if (!isPrivateOpenCycleDetails(details) ||
        details.size + input.length > ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES) {
        throw new TypeError("open-cycle append target is invalid");
      }
      let offset = 0;
      // write only through the universal archive buffer ceiling
      while (offset < input.length) {
        const chunk = input.subarray(offset, Math.min(
          input.length,
          offset + ADJUSTMENT_STREAM_BUFFER_BYTES,
        ));
        const result = await handle.write(chunk);
        // reject a stalled partial append
        if (result.bytesWritten === 0) {
          throw new Error("open-cycle append made no progress");
        }
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(this.#path));
  }

  // publish one canonical metadata checkpoint by atomic rename
  async writeMetadata(bytes) {
    const input = requireBuffer(bytes, "open-cycle metadata bytes");
    // require a nonempty checkpoint below its independent ceiling
    if (input.length < 1 || input.length > OPEN_CYCLE_METADATA_MAXIMUM_BYTES) {
      throw new RangeError("open-cycle metadata exceeds its bound");
    }
    await assertLocalStagingAdmission(input.length, 1n);
    const parent = dirname(this.#metadataPath);
    const temporaryPath = join(parent, `.archive-open-${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false;
    try {
      let offset = 0;
      // write the bounded checkpoint through the fixed buffer ceiling
      while (offset < input.length) {
        const result = await handle.write(input.subarray(
          offset,
          Math.min(input.length, offset + ADJUSTMENT_STREAM_BUFFER_BYTES),
        ));
        // reject a stalled atomic checkpoint write
        if (result.bytesWritten === 0) {
          throw new Error("open-cycle metadata write made no progress");
        }
        offset += result.bytesWritten;
      }
      await handle.sync();
      await handle.close();
      await assertPrivateOpenCycleFile(temporaryPath);
      await rename(temporaryPath, this.#metadataPath);
      renamed = true;
      await syncDirectory(parent);
    } finally {
      // clean only an unpublished temporary checkpoint
      if (!renamed) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  // truncate only one incomplete unacknowledgeable raw suffix
  async truncatePayload(length) {
    const handle = await open(this.#path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      // reject expansion or an unsafe checkpoint file
      if (!isPrivateOpenCycleDetails(details) ||
        !Number.isSafeInteger(length) || length < 0 || length > details.size) {
        throw new TypeError("open-cycle truncate is invalid");
      }
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(this.#path));
  }

  // remove only the sealed temporary incoming representation
  async remove() {
    const paths = [this.#path, this.#metadataPath];
    // remove both bounded checkpoint files idempotently
    for (const path of paths) {
      try {
        await assertPrivateOpenCycleFile(path);
        await unlink(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        // retain idempotence only for an absent checkpoint file
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

// preserve aggregate, dual free-space and inode floors before staging writes
async function assertLocalStagingAdmission(byteLength, inodeDelta) {
  // reject writes beyond the entire authorized transient bucket
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 ||
    BigInt(byteLength) > ADJUSTMENT_STAGING_CEILING_BYTES ||
    (inodeDelta !== 0n && inodeDelta !== 1n)) {
    throw new RangeError("open-cycle staging admission is invalid");
  }
  const evidence = await measureAdjustmentCapacityEvidence(spawn);
  const blockSize = evidence.ext4BlockSize;
  const allocatedDelta = ((BigInt(byteLength) + blockSize - 1n) / blockSize) * blockSize;
  // require the aggregate ceiling and both physical byte floors
  if (evidence.backing.allocatedBytes + allocatedDelta >
      ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES ||
    evidence.ext4FreeBytes - allocatedDelta < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
    evidence.backing.freeBytes - allocatedDelta < ADJUSTMENT_FREE_SPACE_FLOOR_BYTES ||
    evidence.ext4FreeInodes - inodeDelta < MINIMUM_FREE_INODES) {
    const error = new Error("open_cycle_staging_resource_refused");
    error.code = "resource_refused";
    throw error;
  }
}

// require one safe fixed incoming file
async function assertPrivateOpenCycleFile(path) {
  const details = await lstat(path);
  // reject links, special files, foreign ownership and broad access
  if (!isPrivateOpenCycleDetails(details) || details.isSymbolicLink()) {
    throw new TypeError("open-cycle file is invalid");
  }
  return details;
}

// classify one owner-private single-link regular checkpoint
function isPrivateOpenCycleDetails(details) {
  return details.isFile() && details.uid === process.getuid() &&
    (details.mode & 0o777) === 0o600 && details.nlink === 1;
}

// fsync one already-created fixed directory
async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// validate and map one fixed remote verb
function remoteVerbGrammar(verb, arguments_) {
  // require a real argument array before grammar checks
  if (!Array.isArray(arguments_)) {
    throw new TypeError("archive remote arguments are invalid");
  }
  // accept only the zero-argument next verb
  if (verb === "next") {
    if (arguments_.length !== 0) {
      throw new TypeError("archive next arguments are invalid");
    }
    return { arguments: [], command: "adjustment-archive-next" };
  }
  const command = verb === "page_ack"
    ? "adjustment-archive-ack"
    : verb === "final_ack" ? "adjustment-archive-ack-final" : null;
  // require exactly two lowercase SHA arguments for acknowledgements
  if (command === null || arguments_.length !== 2 ||
    arguments_.some((value) => typeof value !== "string" || !SHA256_PATTERN.test(value))) {
    throw new TypeError("archive remote verb or arguments are invalid");
  }
  return { arguments: [...arguments_], command };
}

// collect one child with closed one-mib stdout and stderr bounds
async function collectBoundedChild(
  child,
  signal,
  maximumBytes = ADJUSTMENT_ARCHIVE_TRANSFER_MAXIMUM_BYTES,
) {
  // require one positive closed stdout and stderr ceiling
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
    maximumBytes > ADJUSTMENT_ARCHIVE_TRANSFER_MAXIMUM_BYTES) {
    throw new RangeError("transport output bound is invalid");
  }
  return await new Promise(
    // settle exactly once on exit, timeout, abort or stream overflow
    (resolvePromise, rejectPromise) => {
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timeout;
      // remove every bounded operation listener and timer
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      // retain no more than the already admitted stderr chunks
      const retainedStderr = () => Buffer.concat(stderr, Math.min(
        stderr.reduce(
          // sum only retained bounded diagnostic chunks
          (total, chunk) => total + chunk.length,
          0,
        ),
        maximumBytes,
      ));
      const fail = (code) => {
        // ignore secondary events after one terminal result
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          child.kill("SIGTERM");
        } catch {
          // retain the primary bounded failure
        }
        rejectPromise(transportError(code, retainedStderr()));
      };
      const onAbort = () => fail("transport_aborted");
      // reject an already cancelled operation without listener retention
      if (signal?.aborted) {
        fail("transport_aborted");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(
        // stop one stalled remote operation at the poll bound
        () => fail("transport_timeout"),
        ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS,
      );
      child.stdout.on("data", (chunk) => {
        // ignore stream activity after settlement
        if (settled) {
          return;
        }
        stdoutBytes += chunk.length;
        // refuse output above the exact transport cap
        if (stdoutBytes > maximumBytes) {
          fail("transport_output_refused");
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        // ignore stream activity after settlement
        if (settled) {
          return;
        }
        stderrBytes += chunk.length;
        // retain only bounded stderr for hashing
        if (stderrBytes > maximumBytes) {
          fail("transport_output_refused");
          return;
        }
        stderr.push(Buffer.from(chunk));
      });
      child.once("error", () => fail("transport_spawn_refused"));
      child.once("close", (code, closeSignal) => {
        // ignore exit after an earlier terminal event
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const stderrBytesValue = Buffer.concat(stderr, stderrBytes);
        // require a normal zero exit
        if (code !== 0 || closeSignal !== null) {
          rejectPromise(transportError("transport_remote_refused", stderrBytesValue));
          return;
        }
        resolvePromise({
          stderr: stderrBytesValue,
          stdout: Buffer.concat(stdout, stdoutBytes),
        });
      });
    },
  );
}

// construct one sanitized remote transport error
function transportError(code, stderr) {
  const error = new Error(code);
  error.code = code;
  error.stderrSha256 = adjustmentSha256(stderr);
  return error;
}

// wait one bounded poll interval or abort immediately
export async function waitForAdjustmentArchivePoll(milliseconds, signal) {
  // require the fixed bounded consumer interval
  if (!Number.isInteger(milliseconds) || milliseconds < 0 ||
    milliseconds > ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS) {
    throw new RangeError("archive poll interval is invalid");
  }
  // settle immediately without retaining a listener
  if (signal.aborted) {
    return;
  }
  await new Promise(
    // settle on the timer or one stop request
    (resolvePromise) => {
      let timer;
      // remove the opposite completion branch on every settlement
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolvePromise();
      };
      signal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, milliseconds);
    },
  );
}

// wait for the exact process-lock readiness marker
async function readLockReady(child) {
  return await new Promise(
    // settle on readiness, error or early exit
    (resolvePromise, rejectPromise) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("ascii");
        // resolve only the complete fixed marker
        if (output === "ready") {
          resolvePromise(output);
        }
      });
      child.once("error", rejectPromise);
      child.once("exit", () => resolvePromise(output));
    },
  );
}

// wait for one lock-holder child exit
async function waitForChildExit(child) {
  // return an already observed exit
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise(
    // settle on exit or process error
    (resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", resolvePromise);
    },
  );
}

// decode one canonical base64 page without widening its raw ceiling
function decodeCanonicalBase64(value) {
  // reject aliases, whitespace and impossible lengths
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)) {
    throw new TypeError("archive page base64 is invalid");
  }
  const payload = Buffer.from(value, "base64");
  // require exact re-encoding and the existing page ceiling
  if (payload.length === 0 || payload.length > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES ||
    payload.toString("base64") !== value) {
    throw new TypeError("archive page base64 is invalid");
  }
  return payload;
}

// require one exact transfer version
function requireTransferVersion(value) {
  // reject every old, future or absent transfer contract
  if (value !== ADJUSTMENT_ARCHIVE_TRANSFER_VERSION) {
    throw new TypeError("archive transfer contract is invalid");
  }
}

// require byte-for-byte canonical transfer json
function requireCanonicalTransfer(input, normalized) {
  const canonical = canonicalJsonBytes(normalized);
  // reject alternate key order, whitespace, aliases or duplicate keys
  if (!canonical.equals(input)) {
    throw new TypeError("archive transfer is not canonical");
  }
  return canonical;
}

// require one already parsed page transfer
function requireParsedPage(value) {
  // require internal decoded fields in addition to the closed wire fields
  if (value === null || typeof value !== "object" || value.kind !== "page" ||
    !Buffer.isBuffer(value.payload) || !Buffer.isBuffer(value.canonicalBytes)) {
    throw new TypeError("parsed archive page is invalid");
  }
}

// require one already parsed final transfer
function requireParsedFinal(value) {
  // require the exact final discriminator and identity
  if (value === null || typeof value !== "object" || value.kind !== "final") {
    throw new TypeError("parsed archive final is invalid");
  }
  requireSha256(value.manifestSha256, "parsed final manifestSha256");
  validateCycleFinalManifest(value.manifest);
}

// require one lowercase SHA-256 value
function requireSha256(value, label) {
  // reject alternate or non-string digest representations
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one Buffer without implicit conversion
function requireBuffer(value, label) {
  // reject strings, views and shared mutable aliases
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${label} must be a Buffer`);
  }
  return value;
}

// require one ordinary json object
function requirePlainObject(value, label) {
  // reject null, arrays and custom prototypes
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

// require the exact closed object key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  // reject missing, duplicate-normalized or unknown fields
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} keys are invalid`);
  }
}

// run only the fixed readiness probe or continuous job as a program
async function main() {
  // expose a no-mutation readiness result before activation
  if (process.argv.length === 3 && process.argv[2] === "--readiness") {
    const result = await inspectAdjustmentArchiveJobReadiness();
    process.stdout.write(canonicalJsonBytes(result));
    // fail closed before archive initialization
    if (!result.ready) {
      process.exitCode = 1;
      return;
    }
    return;
  }
  // prohibit arbitrary command-line modes
  if (process.argv.length !== 2) {
    throw new TypeError("archive runner arguments are invalid");
  }
  await runAdjustmentArchiveJob();
}

// execute main only for the direct fixed script entry
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(
    // emit only one sanitized failure code
    (error) => {
      process.stderr.write(`${error?.code ?? error?.message ?? "archive_job_failed"}\n`);
      process.exitCode = 1;
    },
  );
}
