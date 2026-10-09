import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_BYTES,
  ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_INODES,
  ADJUSTMENT_RELEASE_FUTURE_STATE_BYTES,
  BLUEBERRY_PROTECTED_FREE_BYTES, BLUEBERRY_NEXT_CAPTURE_BYTES,
  collectAdjustmentReleaseCapacityInventory, dockerChainIdentity, evaluateAdjustmentReleaseCapacity,
  evaluateAdjustmentFamilyReleaseCapacity, evaluateAdjustmentFullV14ReleaseCapacity,
  evaluateAdjustmentInertV14ReleaseCapacity,
  measureReleaseLayer, measureReleasePathEntry,
  weatherRegistryBlobRedirectUrl } from "./adjustment_release_capacity.mjs";

// use literal shared and parent-dependent layers in every accounting test
function fixture() {
  const digest = (value) => `sha256:${value.repeat(64)}`;
  const layer = (value, previous = []) => ({ diffId: digest(value),
    chainId: dockerChainIdentity([...previous, digest(value)]), blobDigest: digest(value),
    compressedBytes: 4_096, entryInodes: 2, unpackedBytes: 8_192 });
  return { freeBytes: BLUEBERRY_PROTECTED_FREE_BYTES + BLUEBERRY_NEXT_CAPTURE_BYTES +
    ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_BYTES + 2_097_152,
    freeInodes: 100_000, inventory: [{ chainId: digest("a"), allocatedBytes: 8_192 }],
    images: ["source", "target", "compensating"].flatMap(
      // each release owns both application images
      (role, index) => ["server", "web"].map(
        // retain the literal runtime even when filesystem chains are shared
        (runtime, runtimeIndex) => ({ role, runtime, digest: digest(String(index * 2 + runtimeIndex + 1)),
          metadataBytes: 4_096, layers: [layer("a"), layer(index === 1 ? "b" : "c", [digest("a")])] }),
      ),
    ),
    engineMetadataBytes: 4_096, futureStateBytes: ADJUSTMENT_RELEASE_FUTURE_STATE_BYTES,
    pullScratchBytes: 8_192, nextStateInodes: 1_004, retainedControlBytes: 4_096,
    runtimePackageBytes: 8_192, maximumOwnedBytes: 2_097_152, measuredAt: "2026-10-08T20:00:00.000Z" };
}

// persistent source and compensation ownership survives activation and restart
test("release capacity charges shared persistent images and literal pull/unpack peak", () => {
  const result = evaluateAdjustmentReleaseCapacity(fixture());
  assert.equal(result.state, "capacity_ready");
  assert.equal(result.persistentOwnedBytes, 1_114_112);
  assert.equal(result.persistentGrowthBytes, 1_101_824);
  assert.equal(result.compressedPeakBytes, 8_192);
  assert.equal(result.pullPeakGrowthBytes, 1_118_208);
  assert.equal(result.compatibilityFixtureBytes, 67_108_864);
  assert.equal(result.compatibilityFixtureInodes, 4_096);
  assert.equal(result.releaseTransactionPeakGrowthBytes, 68_210_688);
  assert.equal(result.futureStateBytes, 1_048_576);
  assert.equal(result.retainedControlBytes, 4_096);
  assert.equal(result.retirementCreditBytes, 0);
  const retainedControlGrowth = evaluateAdjustmentReleaseCapacity({
    ...fixture(),
    retainedControlBytes: 8_192,
  });
  assert.equal(retainedControlGrowth.persistentOwnedBytes, result.persistentOwnedBytes + 4_096);
  assert.equal(retainedControlGrowth.persistentGrowthBytes, result.persistentGrowthBytes);
  assert.equal(retainedControlGrowth.requiredFreeBytes, result.requiredFreeBytes);
});

// the current host observation cannot satisfy even an empty deployment delta
test("release capacity blocks the measured live Blueberry free space without pruning", () => {
  assert.equal(evaluateAdjustmentReleaseCapacity({ ...fixture(), freeBytes: 1_950_453_760 }).state, "capacity_blocked");
});

// one missing block fails while an exact reserved floor passes
test("release capacity is exact at the floor and rejects one-block over admission", () => {
  const input = fixture();
  const exact = evaluateAdjustmentReleaseCapacity(input).requiredFreeBytes;
  assert.equal(evaluateAdjustmentReleaseCapacity({ ...input, freeBytes: exact }).state, "capacity_ready");
  assert.equal(evaluateAdjustmentReleaseCapacity({ ...input, freeBytes: exact - 4_096 }).state, "capacity_blocked");
});

// same diff-id under a different parent consumes another physical chain
test("docker chain ownership cannot deduplicate a diff-id across parents", () => {
  const a = `sha256:${"a".repeat(64)}`;
  const b = `sha256:${"b".repeat(64)}`;
  const c = `sha256:${"c".repeat(64)}`;
  assert.notEqual(dockerChainIdentity([a, c]), dockerChainIdentity([b, c]));
});

// absent measurements and unowned compensation never become admission
test("release capacity rejects absent, contradictory or caller-shaped inventory", () => {
  const input = fixture();
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, assumedTransientBytes: 1_048_576 }));
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, images: input.images.slice(0, 2) }));
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, inventory: [...input.inventory, ...input.inventory] }));
  const images = structuredClone(input.images);
  images[1].layers[0].unpackedBytes = 16_384;
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, images }));
});

// independent steady and package caps prevent transient-only success
test("release capacity enforces persistent ownership, package and inode limits", () => {
  const input = fixture();
  assert.ok(evaluateAdjustmentReleaseCapacity({ ...input, maximumOwnedBytes: 1 }).reasons.includes("persistent_image_ownership"));
  assert.ok(evaluateAdjustmentReleaseCapacity({ ...input, runtimePackageBytes: 8_388_609 }).reasons.includes("runtime_package_ceiling"));
  assert.ok(evaluateAdjustmentReleaseCapacity({ ...input,
    freeInodes: 33_771 + ADJUSTMENT_RELEASE_COMPATIBILITY_FIXTURE_INODES,
  }).reasons.includes("inode_floor"));
});

// omitting the web image cannot earn a release admission
test("release capacity requires both runtimes for all three ownership roles", () => {
  const input = fixture();
  const duplicate = structuredClone(input.images);
  duplicate[1].runtime = "server";
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, images: duplicate }));
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, images: input.images.filter(
    // a missing runtime must remain an incomplete inventory
    (image) => image.runtime === "server",
  ) }));
  const images = structuredClone(input.images);
  const digest = `sha256:${"d".repeat(64)}`;
  images[3].layers[1] = { ...images[3].layers[1], diffId: digest, blobDigest: digest,
    chainId: dockerChainIdentity([images[3].layers[0].diffId, digest]) };
  const original = evaluateAdjustmentReleaseCapacity(input);
  const changedWeb = evaluateAdjustmentReleaseCapacity({ ...input, images });
  assert.equal(changedWeb.requiredFreeBytes - original.requiredFreeBytes, 8_192);
  assert.equal(changedWeb.imageDigests.length, 6);
  assert.deepEqual(changedWeb.imageDigests.map(
    // preserve both runtime labels in the immutable receipt
    (image) => `${image.role}/${image.runtime}`,
  ), ["source/server", "source/web", "target/server", "target/web", "compensating/server", "compensating/web"]);
});

// immutable image identities cannot carry contradictory layer manifests
test("release capacity rejects contradictory same-digest manifests", () => {
  const input = fixture();
  const images = structuredClone(input.images);
  images[1].digest = images[0].digest;
  images[1].layers[1].blobDigest = `sha256:${"d".repeat(64)}`;
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, images }), /immutable image manifest/u);
  images[1].layers = structuredClone(images[0].layers);
  assert.equal(evaluateAdjustmentReleaseCapacity({ ...input, images }).state, "capacity_ready");
});

// malformed clocks and unsafe aggregate sums never produce capacity receipts
test("release capacity rejects normalized dates and overflowing aggregate accounting", () => {
  const input = fixture();
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, measuredAt: "2026-02-30T20:00:00.000Z" }));
  const hugeBlockBound = Number.MAX_SAFE_INTEGER - 8_191;
  assert.equal(hugeBlockBound % 4_096, 0);
  assert.throws(() => evaluateAdjustmentReleaseCapacity({ ...input, engineMetadataBytes: hugeBlockBound }), /overflow/u);
});

// construct one raw OCI image whose digests are derived from exact bytes
function collectedImage(role, runtime, marker) {
  const digest = (value) => `sha256:${value.repeat(64)}`;
  const configBytes = JSON.stringify({
    architecture: "arm64",
    os: "linux",
    rootfs: { diff_ids: [digest(marker)], type: "layers" },
  });
  const configDigest = `sha256:${createHash("sha256").update(configBytes).digest("hex")}`;
  const blobDigest = digest(marker === "a" ? "b" : marker);
  const manifestBytes = JSON.stringify({
    config: {
      digest: configDigest,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: Buffer.byteLength(configBytes),
    },
    layers: [{
      digest: blobDigest,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 4_096,
    }],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  return {
    configBytes,
    manifestBytes,
    reference: `ghcr.io/anstosa/weather-${runtime}@sha256:${manifestDigest}`,
    role,
    runtime,
    unpackedLayers: [{ allocatedBytes: 8_192, blobDigest, entryInodes: 2 }],
  };
}

// account for a new family-only compensation instead of reusing source images
test("family capacity binds all six literal images without weakening the inert v13 contract", () => {
  const input = {
    ...collectedFixture(),
    actionSha256: "a".repeat(64),
    compensationScope: "family-only-new-release-compensation",
    family: "wind",
    images: ["source", "target", "compensating"].flatMap(
      // distinguish the real immutable server and web image identities
      (role, index) => ["server", "web"].map(
        // preserve parent-chain accounting across all ownership roles
        (runtime, offset) => collectedImage(role, runtime, String(index * 2 + offset + 1)),
      ),
    ),
    sourceRelease: "2026.10.09-1",
    version: "adjustment-family-release-inventory/v1",
  };
  const result = evaluateAdjustmentFamilyReleaseCapacity(input);
  assert.equal(result.state, "capacity_ready");
  assert.equal(result.contractVersion, "adjustment-family-release-capacity/v1");
  assert.equal(result.sourceRelease, input.sourceRelease);
  assert.equal(result.actionSha256, input.actionSha256);
  assert.equal(result.family, "wind");
  assert.equal(result.compensationScope, input.compensationScope);
  assert.equal(result.imageDigests.length, 6);
  assert.equal(result.retirementCreditBytes, 0);
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(input));
  assert.throws(() => evaluateAdjustmentFamilyReleaseCapacity({ ...input, sourceRelease: "latest" }));
  assert.throws(() => evaluateAdjustmentFamilyReleaseCapacity({ ...input, family: "direction" }));
  const images = structuredClone(input.images);
  images[4] = { ...structuredClone(images[0]), role: "compensating" };
  assert.throws(() => evaluateAdjustmentFamilyReleaseCapacity({ ...input, images }), /new immutable server/u);
  const floor = result.requiredFreeBytes;
  assert.equal(evaluateAdjustmentFamilyReleaseCapacity({ ...input, freeBytes: floor }).state, "capacity_ready");
  assert.equal(evaluateAdjustmentFamilyReleaseCapacity({ ...input, freeBytes: floor - 4096 }).state, "capacity_blocked");
  assert.throws(() => evaluateAdjustmentFamilyReleaseCapacity({ ...input, assumedCompensationBytes: 0 }));
});

// load the exact reviewed public source image bytes
function reviewedSourceImage(role, runtime, prefix = "") {
  const root = new URL("./fixtures/adjustment-release-capacity/", import.meta.url);
  const manifestBytes = Buffer.from(
    readFileSync(new URL(`${prefix}source-${runtime}.manifest.json.b64`, root), "utf8")
      .replace(/\s/gu, ""),
    "base64",
  ).toString("utf8");
  const configBytes = Buffer.from(
    readFileSync(new URL(`${prefix}source-${runtime}.config.json.b64`, root), "utf8")
      .replace(/\s/gu, ""),
    "base64",
  ).toString("utf8");
  const manifest = JSON.parse(manifestBytes);
  return {
    configBytes,
    manifestBytes,
    reference: `ghcr.io/anstosa/weather-${runtime}@sha256:${
      createHash("sha256").update(manifestBytes).digest("hex")}`,
    role,
    runtime,
    unpackedLayers: manifest.layers.map((layer) => ({
      allocatedBytes: 4_096,
      blobDigest: layer.digest,
      entryInodes: 1,
    })),
  };
}

// collect only the fixed whole-release source restoration contract
function collectedFixture() {
  const sourceServer = reviewedSourceImage("source", "server");
  const sourceWeb = reviewedSourceImage("source", "web");
  const inventory = new Map();

  // retain the exact reviewed source parent chains
  for (const image of [sourceServer, sourceWeb]) {
    const config = JSON.parse(image.configBytes);
    const diffIds = [];
    for (const diffId of config.rootfs.diff_ids) {
      diffIds.push(diffId);
      inventory.set(dockerChainIdentity(diffIds), 4_096);
    }
  }
  return {
    compensationScope: "fixed-inert-v13-whole-release-source-restore",
    freeBytes: BLUEBERRY_PROTECTED_FREE_BYTES + BLUEBERRY_NEXT_CAPTURE_BYTES +
      256 * 1_024 * 1_024,
    freeInodes: 100_000,
    images: [
      sourceServer,
      sourceWeb,
      collectedImage("target", "server", "c"),
      collectedImage("target", "web", "d"),
      { ...structuredClone(sourceServer), role: "compensating" },
      { ...structuredClone(sourceWeb), role: "compensating" },
    ],
    inventory: [...inventory.entries()].map(([chainId, allocatedBytes]) => ({
      allocatedBytes,
      chainId,
    })),
    measuredAt: "2026-10-08T20:00:00.000Z",
    retainedControlBytes: 4_096,
    runtimePackageBytes: 0,
    sourceRelease: "2026.10.07-3",
    version: "adjustment-release-inventory/v1",
  };
}

// raw manifest, config and rollback identities are verified before accounting
test("release inventory collector binds OCI/config bytes and fixed source compensation", () => {
  const collected = collectAdjustmentReleaseCapacityInventory(collectedFixture());
  const result = evaluateAdjustmentReleaseCapacity(collected);
  assert.equal(result.state, "capacity_ready");
  assert.equal(result.imageDigests.length, 6);
  assert.equal(result.newLayerInodes, 4);
  assert.equal(result.retirementCreditBytes, 0);

  const changedManifest = collectedFixture();
  changedManifest.images[2].manifestBytes += " ";
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(changedManifest),
    /manifest digest differs/u);

  const changedConfig = collectedFixture();
  changedConfig.images[2].configBytes = changedConfig.images[2].configBytes.replace(
    '"arm64"', '"amd64"');
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(changedConfig),
    /OCI\/config identity/u);

  const changedCompensation = collectedFixture();
  changedCompensation.images[4] = collectedImage("compensating", "server", "e");
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(changedCompensation),
    /restore the exact reviewed source/u);
});

// unknown and unmeasured layer facts never become release admission
test("release inventory collector refuses unmeasured and contradictory layer facts", () => {
  const missing = collectedFixture();
  delete missing.images[2].unpackedLayers[0].entryInodes;
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(missing),
    /unexpected keys/u);

  const wrongBlob = collectedFixture();
  wrongBlob.images[2].unpackedLayers[0].blobDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(wrongBlob),
    /layer measurement/u);

  const duplicateInventory = collectedFixture();
  duplicateInventory.inventory.push(duplicateInventory.inventory[0]);
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(duplicateInventory),
    /duplicated/u);
});

// represent one no-follow bigint stat result without creating a privileged device
function releasePathDetails(kind, rdev = 0n) {
  return {
    blocks: 8n,
    isCharacterDevice: () => kind === "character",
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    rdev,
  };
}

// admit only the actual overlay2 whiteout while retaining its inode and blocks
test("local layer measurement accepts only a zero-device character whiteout", () => {
  assert.deepEqual(measureReleasePathEntry(releasePathDetails("character")), {
    bytes: 4_096,
    descend: false,
    inodes: 1,
  });
  assert.deepEqual(measureReleasePathEntry(releasePathDetails("directory")), {
    bytes: 4_096,
    descend: true,
    inodes: 1,
  });

  // keep every other special filesystem entry outside the collector contract
  for (const details of [
    releasePathDetails("character", 1n),
    releasePathDetails("block"),
    releasePathDetails("fifo"),
    releasePathDetails("socket"),
  ]) {
    assert.throws(() => measureReleasePathEntry(details), /unsupported filesystem entry/u);
  }
});


// build one checksummed tar entry
function tarEntry(payload, name, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write("0000000", 100, "ascii");
  header.write("0000000", 108, "ascii");
  header.write("0000000", 116, "ascii");
  header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "binary");
  header.write("00", 263, "ascii");
  let checksum = 0;

  // encode the checksum after treating its field as spaces
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

// build one minimal terminated tar stream for the registry layer meter
function tarFixture(payload, name = "nested/deep/payload") {
  return Buffer.concat([tarEntry(payload, name), Buffer.alloc(1_024)]);
}

// encode one exact length-framed PAX record
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;

  // converge after the decimal length width is known
  for (;;) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}

// registry streaming derives exact compressed identity and conservative unpack allocation
test("release layer meter streams exact gzip and tar bounds", async () => {
  const tar = tarFixture(Buffer.from("x"));
  const compressed = gzipSync(tar, { mtime: 0 });
  const descriptor = {
    digest: `sha256:${createHash("sha256").update(compressed).digest("hex")}`,
    size: compressed.length,
  };
  const diffId = `sha256:${createHash("sha256").update(tar).digest("hex")}`;
  const measured = await measureReleaseLayer(
    new Response(compressed),
    descriptor,
    diffId,
  );
  assert.deepEqual(measured, {
    allocatedBytes: 16_384,
    blobDigest: descriptor.digest,
    entryInodes: 3,
  });
  await assert.rejects(
    measureReleaseLayer(
      new Response(compressed),
      { ...descriptor, size: compressed.length - 1 },
      diffId,
    ),
    /compressed size differs/u,
  );
  await assert.rejects(
    measureReleaseLayer(
      new Response(compressed),
      descriptor,
      `sha256:${"f".repeat(64)}`,
    ),
    /digest or size differs/u,
  );

  const pax = paxRecord("path", "nested/deep/payload");
  const paxTar = Buffer.concat([
    tarEntry(pax, "PaxHeaders/path", "x"),
    tarEntry(Buffer.from("x"), "placeholder"),
    Buffer.alloc(1_024),
  ]);
  const paxCompressed = gzipSync(paxTar, { mtime: 0 });
  const paxMeasured = await measureReleaseLayer(new Response(paxCompressed), {
    digest: `sha256:${createHash("sha256").update(paxCompressed).digest("hex")}`,
    size: paxCompressed.length,
  }, `sha256:${createHash("sha256").update(paxTar).digest("hex")}`);
  assert.deepEqual(paxMeasured, {
    allocatedBytes: 28_672,
    blobDigest: `sha256:${createHash("sha256").update(paxCompressed).digest("hex")}`,
    entryInodes: 5,
  });

  const unsafeTar = tarFixture(Buffer.from("x"), "../payload");
  const unsafeCompressed = gzipSync(unsafeTar, { mtime: 0 });
  await assert.rejects(measureReleaseLayer(new Response(unsafeCompressed), {
    digest: `sha256:${createHash("sha256").update(unsafeCompressed).digest("hex")}`,
    size: unsafeCompressed.length,
  }, `sha256:${createHash("sha256").update(unsafeTar).digest("hex")}`),
  /tar path is unsafe/u);
});


// generate one current-shaped read-only GHCR signed blob handoff
function registryRedirect(digest) {
  const query = new URLSearchParams({
    hmac: "a".repeat(64),
    se: "2026-10-09T00:00:00Z",
    sig: "a".repeat(32) + "==",
    ske: "2026-10-09T01:00:00Z",
    skoid: "fb3d2a07-ec6c-4fe4-aced-9efe0fd2fe1a",
    sks: "b",
    skt: "2026-10-08T22:00:00Z",
    sktid: "398a6654-997b-47e9-b12b-9515b896b4de",
    skv: "2025-01-05",
    sp: "r",
    spr: "https",
    sr: "b",
    sv: "2025-01-05",
  });
  return `https://pkg-containers.githubusercontent.com/ghcr1/blobs/${digest}?${query}`;
}

// signed blob redirects never widen host, path, query or credential authority
test("registry redirect policy permits only the exact signed blob handoff", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const allowed = registryRedirect(digest);
  assert.equal(weatherRegistryBlobRedirectUrl(allowed, "weather-server", digest), allowed);
  const legacyShard = allowed.replace("/ghcr1/", "/ghcrblobs09/");
  assert.equal(
    weatherRegistryBlobRedirectUrl(legacyShard, "weather-server", digest),
    legacyShard,
  );
  assert.throws(() => weatherRegistryBlobRedirectUrl(
    allowed.replace("pkg-containers.githubusercontent.com", "example.com"),
    "weather-server",
    digest,
  ), /outside the closed policy/u);
  assert.throws(() => weatherRegistryBlobRedirectUrl(
    allowed.replace("sp=r", "sp=rw"),
    "weather-server",
    digest,
  ), /outside the closed policy/u);
  assert.throws(() => weatherRegistryBlobRedirectUrl(
    `${allowed}&extra=value`,
    "weather-server",
    digest,
  ), /outside the closed policy/u);
  assert.throws(() => weatherRegistryBlobRedirectUrl(
    allowed.replace(digest, `sha256:${"b".repeat(64)}`),
    "weather-server",
    digest,
  ), /outside the closed policy/u);
});

// preserve separate literal predecessor and compensation scopes for each inert bridge
test("inert v14 capacity admits only exact deployed v13 source restoration", () => {
  const input = collectedFixture();
  const server = reviewedSourceImage("source", "server", "v13-");
  const web = reviewedSourceImage("source", "web", "v13-");
  input.images = [server, web, ...input.images.slice(2, 4),
    { ...structuredClone(server), role: "compensating" },
    { ...structuredClone(web), role: "compensating" }];
  input.version = "adjustment-inert-v14-release-inventory/v1";
  input.sourceRelease = "2026.10.09-1";
  input.compensationScope = "fixed-inert-v14-whole-release-source-restore";
  const result = evaluateAdjustmentInertV14ReleaseCapacity(input);
  assert.equal(result.state, "capacity_ready");
  assert.equal(result.contractVersion, "adjustment-inert-v14-release-capacity/v1");
  assert.equal(result.sourceRelease, "2026.10.09-1");
  assert.equal(result.retirementCreditBytes, 0);
  assert.throws(() => collectAdjustmentReleaseCapacityInventory(input));
  assert.throws(() => evaluateAdjustmentInertV14ReleaseCapacity(collectedFixture()));
  assert.throws(() => evaluateAdjustmentInertV14ReleaseCapacity({ ...input,
    sourceRelease: "2026.10.07-3" }));
  const compensation = structuredClone(input);
  compensation.images[4] = collectedImage("compensating", "server", "e");
  assert.throws(() => evaluateAdjustmentInertV14ReleaseCapacity(compensation), /exact reviewed source/u);
  const exact = result.requiredFreeBytes;
  assert.equal(evaluateAdjustmentInertV14ReleaseCapacity({ ...input, freeBytes: exact }).state, "capacity_ready");
  assert.equal(evaluateAdjustmentInertV14ReleaseCapacity({ ...input, freeBytes: exact - 4_096 }).state, "capacity_blocked");
});

// full handoff binds the separately published bridge images in both retained roles
test("full v14 capacity admits only exact published bridge restoration", () => {
  const input = collectedFixture();
  const server = reviewedSourceImage("source", "server", "v14-bridge-");
  const web = reviewedSourceImage("source", "web", "v14-bridge-");
  input.images = [server, web, ...input.images.slice(2, 4),
    { ...structuredClone(server), role: "compensating" },
    { ...structuredClone(web), role: "compensating" }];
  input.version = "adjustment-full-v14-release-inventory/v1";
  input.sourceRelease = "2026.10.09-2";
  input.compensationScope = "fixed-full-v14-whole-release-source-restore";
  const result = evaluateAdjustmentFullV14ReleaseCapacity(input);
  assert.equal(result.state, "capacity_ready");
  assert.equal(result.contractVersion, "adjustment-full-v14-release-capacity/v1");
  assert.equal(result.sourceRelease, "2026.10.09-2");
  assert.equal(result.retirementCreditBytes, 0);
  const floor = result.requiredFreeBytes;
  assert.equal(evaluateAdjustmentFullV14ReleaseCapacity({ ...input, freeBytes: floor }).state,
    "capacity_ready");
  assert.equal(evaluateAdjustmentFullV14ReleaseCapacity({ ...input, freeBytes: floor - 4_096 }).state,
    "capacity_blocked");
  const drift = structuredClone(input);
  drift.images[4] = collectedImage("compensating", "server", "e");
  assert.throws(() => evaluateAdjustmentFullV14ReleaseCapacity(drift), /reviewed bridge image/u);
});
