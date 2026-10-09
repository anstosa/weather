import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  bootstrapAdjustmentFamilyReleaseCurrent,
  buildInstalledAdjustmentTargetCatalog,
  discardFailedAdjustmentInertV14Bootstrap,
  createAdjustmentFamilyReleasePorts,
  projectAdjustmentFamilyReleaseLineage,
  readAdjustmentFamilyReleaseCurrent,
  readAdjustmentFamilyReleaseLineage,
  readAdjustmentFamilyReleaseStatus,
  runAdjustmentFamilyReleaseCommand,
  validateAdjustmentDevelopmentActionBinding,
  verifyAdjustmentFamilyReleaseAncestorProjection,
} from "../scripts/adjustment-evaluation-package.mjs";

const ACTION = "a".repeat(64);
const COMPENSATION_ACTION = "b".repeat(64);
const HASH = "c".repeat(64);
const ROOT = resolve(import.meta.dirname, "../..");

// sort one JSON value like the release-state canonical writer
function canonicalValue(value) {
  // retain array order while normalizing every member
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  // sort every plain-object key recursively
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonicalValue(value[key])],
    ));
  }
  return value;
}

// encode the exact newline-terminated canonical JSON bytes
function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`);
}

// build one exact capture epoch for release-lineage tests
function lineageWitness() {
  const unsigned = {
    activationKind: "inert_v14_pre_activation",
    archiveCommitOrdinal: "0",
    catalogFrontierSha256: createHash("sha256").update(
      "adjustment-revision-frontier/v1\n0\n",
    ).digest("hex"),
    contractVersion: "adjustment-revision-capture-epoch-witness/v1",
    controlPlaneSha256: HASH,
    controlPlaneVersion: "14",
    databaseMigrationHistorySha256:
      "6de5c8c7efaa448aeb12bf1a9debe6fe7d4d4d1003ee0e21ab619ffa624c3424",
    epochAt: "2026-10-10T08:00:00.000Z",
    servingSnapshotSha256: HASH,
    sourceCommit: "1".repeat(40),
    sourceRelease: "2026.10.10-1",
    sourceServerImageDigest: `sha256:${"4".repeat(64)}`,
    sourceWebImageDigest: `sha256:${"5".repeat(64)}`,
  };
  return {
    ...unsigned,
    witnessSha256: createHash("sha256").update(canonicalBytes(unsigned)).digest("hex"),
  };
}

// build one exact acknowledged family transaction edge
function lineageTransaction(input) {
  const action = {
    actionKind: "shadow",
    candidateGraphSha256: "2".repeat(64),
    candidateSha256: "3".repeat(64),
    contractVersion: "forecast-adjustment-model-action/v1",
    createdAt: "2026-10-11T08:00:00.000Z",
    expectedInstalledReceiptSha256: null,
    expectedSettingsSha256: HASH,
    expectedSourceCommit: input.sourceCommit,
    expectedSourceRelease: input.sourceRelease,
    family: input.family ?? "temperature",
    fencingToken: input.marker === undefined ? "1" : String(input.marker.length + 1),
    fullMemberRootSha256: null,
    lifecycleHeadSha256: "4".repeat(64),
    policyDecision: "pending",
    policyReportSha256: HASH,
    predecessorActionSha256: null,
    reason: "development_candidate",
    reportCreatedAt: "2026-10-11T08:00:00.000Z",
    siteKey: "ballydidean",
    validThrough: "2026-10-18T08:00:00.000Z",
  };
  const actionSha256 = createHash("sha256").update(canonicalBytes(action)).digest("hex");
  return {
    actionSha256,
    document: {
      compensation: {
        actionSha256: input.compensationActionSha256 ?? COMPENSATION_ACTION,
        release: input.compensatingRelease,
        state: input.compensated ? "verified" : "absent",
        verifiedAt: input.compensated ? "2026-10-12T08:00:00.000Z" : null,
      },
      contractVersion: "adjustment-family-release-transaction/v1",
      proof: {
        baselineCatalogBase64: "e30K",
        compensationActionSha256: input.compensationActionSha256 ?? COMPENSATION_ACTION,
        compensationCommit: input.compensationCommit,
        compensationFamilyIdentitySha256: "6".repeat(64),
        compensationImageDigestsSha256: "7".repeat(64),
        sourceSettingsBase64: "e30K",
        targetCatalogBase64: "e30K",
        targetCommit: input.targetCommit,
        targetFamilyIdentitySha256: "8".repeat(64),
        targetImageDigestsSha256: "9".repeat(64),
      },
      record: {
        action,
        createdAt: "2026-10-11T08:00:00.000Z",
        ...(input.compensated ? { failedAt: "2026-10-12T07:59:00.000Z" } : {}),
        input: {
          actionSha256,
          compensatingRelease: input.compensatingRelease,
          expectedCurrentRelease: input.sourceRelease,
          expectedSettingsSha256: HASH,
          expectedSourceRelease: input.sourceRelease,
          family: input.family ?? "temperature",
          fencingToken: action.fencingToken,
          reportSha256: HASH,
          targetRelease: input.targetRelease,
        },
        sourceCommit: input.sourceCommit,
        sourceSettingsSha256: HASH,
        state: input.compensated ? "compensation_required" : "acknowledged",
        targetCommit: input.targetCommit,
        ...(input.compensated ? {} : {
          outcome: "applied",
          verifiedAt: "2026-10-11T09:00:00.000Z",
        }),
      },
    },
  };
}

// distinguish the retained witness document from its unsigned identity
test("development custody binds both epoch hash domains independently", () => {
  const unsigned = {
    activationKind: "inert_v14_pre_activation", archiveCommitOrdinal: "0",
    catalogFrontierSha256: createHash("sha256").update("adjustment-revision-frontier/v1\n0\n").digest("hex"),
    contractVersion: "adjustment-revision-capture-epoch-witness/v1",
    controlPlaneSha256: HASH, controlPlaneVersion: "14",
    databaseMigrationHistorySha256: "6de5c8c7efaa448aeb12bf1a9debe6fe7d4d4d1003ee0e21ab619ffa624c3424",
    epochAt: "2026-10-10T08:00:00.000Z", servingSnapshotSha256: HASH,
    sourceCommit: "1".repeat(40), sourceRelease: "2026.10.10-1",
    sourceServerImageDigest: `sha256:${HASH}`, sourceWebImageDigest: `sha256:${HASH}`,
  };
  // reproduce the canonical framing without borrowing either expected hash
  const digest = (value) => createHash("sha256").update(`${JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))}\n`).digest("hex");
  const witness = { ...unsigned, witnessSha256: digest(unsigned) };
  const action = { actionKind: "shadow", policyDecision: "pending", fullMemberRootSha256: null,
    family: "temperature", candidateGraphSha256: HASH, candidateSha256: HASH,
    policyReportSha256: HASH, lifecycleHeadSha256: HASH, expectedSourceCommit: "2".repeat(40) };
  const authority = { ...action, actionSha256: ACTION,
    contractVersion: "adjustment-development-custody-anchor/v1", lifecycleLedgerRootSha256: HASH,
    sourceCommit: action.expectedSourceCommit, artifactSha256: HASH, registrationSha256: HASH,
    sourceSha256: HASH, captureEpochWitnessSha256: digest(witness) };
  const entry = { family: "temperature", slot: "shadow", receipt: { actionSha256: ACTION, bundleSha256: HASH },
    registration: { artifactSha256: HASH, registrationSha256: HASH, sourceSha256: HASH,
      epochWitnessSha256: witness.witnessSha256 } };
  assert.notEqual(witness.witnessSha256, authority.captureEpochWitnessSha256);
  assert.equal(validateAdjustmentDevelopmentActionBinding(action, ACTION, authority, { entries: [entry] }, witness), true);
  assert.throws(() => validateAdjustmentDevelopmentActionBinding(action, ACTION,
    { ...authority, captureEpochWitnessSha256: witness.witnessSha256 }, { entries: [entry] }, witness), /binding differs/u);
  assert.throws(() => validateAdjustmentDevelopmentActionBinding(action, ACTION, authority,
    { entries: [{ ...entry, registration: { ...entry.registration,
      epochWitnessSha256: authority.captureEpochWitnessSha256 } }] }, witness), /binding differs/u);
  assert.throws(() => validateAdjustmentDevelopmentActionBinding(action, ACTION,
    { ...authority, sourceCommit: unsigned.sourceCommit }, { entries: [entry] }, witness), /binding differs/u);
});

// build one durable record without invoking the pure proof executor
function record(state = "prepared") {
  return {
    action: { actionKind: "promote" },
    createdAt: "2026-10-10T08:00:00.000Z",
    input: {
      actionSha256: ACTION,
      compensatingRelease: "2026.10.10-2",
      expectedCurrentRelease: "2026.10.09-1",
      expectedSettingsSha256: HASH,
      expectedSourceRelease: "2026.10.09-1",
      family: "temperature",
      fencingToken: "7",
      reportSha256: HASH,
      targetRelease: "2026.10.10-1",
    },
    sourceCommit: "1".repeat(40),
    sourceSettingsSha256: HASH,
    state,
    targetCommit: "2".repeat(40),
  };
}

// retain only the evidence required for crash compensation
function proof() {
  return {
    durable: {
      baselineCatalogBase64: Buffer.from('{"contractVersion":"adjustment-installed-candidate-catalog/v1","entries":[]}\n').toString("base64"),
      compensationActionSha256: COMPENSATION_ACTION,
      compensationCommit: "3".repeat(40),
      compensationFamilyIdentitySha256: "d".repeat(64),
      compensationImageDigestsSha256: "e".repeat(64),
      targetCatalogBase64: Buffer.from('{"contractVersion":"adjustment-installed-candidate-catalog/v1","entries":[]}\n').toString("base64"),
      targetCommit: "2".repeat(40),
      targetFamilyIdentitySha256: "f".repeat(64),
      targetImageDigestsSha256: "9".repeat(64),
    },
  };
}

// bind two immutable application images like the production authority reader
function imageIdentity(serverImage, webImage) {
  const bytes = `${JSON.stringify([
    { digest: serverImage.split("@")[1], runtime: "server" },
    { digest: webImage.split("@")[1], runtime: "web" },
  ])}\n`;
  return createHash("sha256").update(bytes).digest("hex");
}

test("inert v14 bootstrap authority is actionless, closed and idempotent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-family-bootstrap-"));
  const root = join(parent, "adjustment-release-state");
  const serverImage = `ghcr.io/anstosa/weather-server@sha256:${"1".repeat(64)}`;
  const webImage = `ghcr.io/anstosa/weather-web@sha256:${"2".repeat(64)}`;
  const input = {
    catalogSha256: "3".repeat(64),
    commit: "4".repeat(40),
    release: "2026.10.10-1",
    serverImage,
    settingsSha256: "5".repeat(64),
    webImage,
  };

  try {
    const first = await bootstrapAdjustmentFamilyReleaseCurrent(input, {
      clock: () => "2026-10-10T09:00:00.000Z",
      root,
    });
    assert.deepEqual(first, {
      bootstrappedAt: "2026-10-10T09:00:00.000Z",
      ...input,
      contractVersion: "adjustment-family-release-bootstrap-current/v1",
      imageDigestsSha256: imageIdentity(serverImage, webImage),
      state: "inert_v14_bootstrap",
    });
    assert.doesNotMatch(
      await readFile(join(root, "current.json"), "utf8"),
      /"actionSha256"|"family":/u,
    );

    // a retry keeps the original time and commit-time settings evidence
    const second = await bootstrapAdjustmentFamilyReleaseCurrent(input, {
      clock: () => "2026-10-10T10:00:00.000Z",
      root,
    });
    assert.deepEqual(second, first);
    const changedSettingsRetry = await bootstrapAdjustmentFamilyReleaseCurrent({
      ...input,
      settingsSha256: "6".repeat(64),
    }, {
      clock: () => "2026-10-10T10:00:00.000Z",
      root,
    });
    assert.deepEqual(changedSettingsRetry, first);
    await assert.rejects(bootstrapAdjustmentFamilyReleaseCurrent({
      ...input,
      commit: "9".repeat(40),
      settingsSha256: "6".repeat(64),
    }, {
      clock: () => "2026-10-10T10:00:00.000Z",
      root,
    }), /already exists/u);
    // discard only the exact actionless failed bridge after caller-proven source restore
    const before = await readFile(join(root, "current.json"));
    await assert.rejects(discardFailedAdjustmentInertV14Bootstrap({
      ...input, commit: "9".repeat(40),
    }, { root }), /differs/u);
    assert.deepEqual(await readFile(join(root, "current.json")), before);
    assert.equal(await discardFailedAdjustmentInertV14Bootstrap({
      ...input,
      settingsSha256: "6".repeat(64),
    }, { root }),
      "discarded_exact_failed_bootstrap");
    assert.equal(await discardFailedAdjustmentInertV14Bootstrap(input, { root }), "absent");
    await writeFile(join(root, "current.json"),
      '{"actionSha256":"' + "a".repeat(64) + '","state":"acknowledged"}\n', { mode: 0o600 });
    await assert.rejects(discardFailedAdjustmentInertV14Bootstrap(input, { root }));
    assert.match(await readFile(join(root, "current.json"), "utf8"), /acknowledged/u);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

// retain operator-off as an exact durable no-mutation transaction
test("family release command durably reports operator-off without serving mutation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-family-operator-off-"));
  const root = join(parent, "adjustment-release-state");
  const settingsBytes = Buffer.from(
    '{"version":1,"temperature":false,"wind":true,"rain":true}\n',
  );
  const settingsSha256 = createHash("sha256").update(settingsBytes).digest("hex");
  const calls = [];
  const ports = createAdjustmentFamilyReleasePorts({
    clock: () => "2026-10-10T09:00:00.000Z",
    host: {
      applyTarget: async () => { throw new Error("operator-off applied target"); },
      compensate: async () => { throw new Error("operator-off compensated"); },
      inspectCurrent: async () => {
        calls.push("inspect");
        return {
          commit: "1".repeat(40),
          release: "2026.10.09-1",
          settingsBytes,
        };
      },
      verifyLive: async () => { throw new Error("operator-off verified live target"); },
      verifyProof: async () => { throw new Error("operator-off verified model proof"); },
    },
    root,
  });
  try {
    const argumentsList = [
      "2026.10.10-1",
      "2026.10.10-2",
      "2026.10.09-1",
      "2026.10.09-1",
      settingsSha256,
      "temperature",
      ACTION,
      HASH,
      "7",
    ];
    const expected = {
      actionSha256: ACTION,
      compensatingRelease: "2026.10.10-2",
      compensationState: "absent",
      contractVersion: "adjustment-family-release-status/v1",
      family: "temperature",
      fencingToken: "7",
      outcome: "operator_off_unapplied",
      state: "operator_off_unapplied",
      targetRelease: "2026.10.10-1",
    };
    const result = await runAdjustmentFamilyReleaseCommand(argumentsList, { ports });
    assert.deepEqual(result, expected);
    assert.deepEqual(await readAdjustmentFamilyReleaseStatus(ACTION, { ports }), expected);
    assert.deepEqual(await runAdjustmentFamilyReleaseCommand(argumentsList, { ports }), expected);
    assert.deepEqual(calls, ["inspect"]);
    assert.equal(await readFile(join(root, "maximum-fence"), "utf8"), "7\n");
    assert.deepEqual(JSON.parse(await readFile(join(
      root,
      "transactions",
      `sha256-${ACTION}.json`,
    ), "utf8")), {
      contractVersion: "adjustment-family-operator-off-transaction/v1",
      record: {
        completedAt: "2026-10-10T09:00:00.000Z",
        input: {
          actionSha256: ACTION,
          compensatingRelease: "2026.10.10-2",
          expectedCurrentRelease: "2026.10.09-1",
          expectedSettingsSha256: settingsSha256,
          expectedSourceRelease: "2026.10.09-1",
          family: "temperature",
          fencingToken: "7",
          reportSha256: HASH,
          targetRelease: "2026.10.10-1",
        },
        sourceCommit: "1".repeat(40),
        sourceSettingsSha256: settingsSha256,
        state: "operator_off_unapplied",
      },
    });
    await assert.rejects(readFile(join(root, "current.json")), /ENOENT/u);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("current family authority exposes only exact source and slot identities", async () => {
  const settingsBytes = Buffer.from('{"rain":true,"temperature":true,"version":1,"wind":true}\n');
  const catalogBytes = Buffer.from(
    '{"contractVersion":"adjustment-installed-candidate-catalog/v2","entries":[]}\n',
  );
  const status = await readAdjustmentFamilyReleaseCurrent("wind", {
    host: {
      inspectCurrent: async () => ({
        catalogBytes,
        commit: "1".repeat(40),
        environment: {
          WEATHER_SERVER_IMAGE: `ghcr.io/anstosa/weather-server@sha256:${"2".repeat(64)}`,
        },
        installedReceiptSha256BySlot: { active: HASH, shadow: null },
        release: "2026.10.10-1",
        settingsBytes,
      }),
    },
  });
  assert.deepEqual(status, {
    activeInstalledReceiptSha256: HASH,
    catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
    commit: "1".repeat(40),
    controlInstalledReceiptSha256: null,
    contractVersion: "adjustment-family-release-current-status/v1",
    family: "wind",
    release: "2026.10.10-1",
    settingsSha256: createHash("sha256").update(settingsBytes).digest("hex"),
    shadowInstalledReceiptSha256: null,
    sourceServerImageDigest: `sha256:${"2".repeat(64)}`,
  });
});

// prove multi-hop, side-branch and compensation ancestry to the immutable epoch source
test("family release lineage verifies transitive acknowledged and compensated edges", () => {
  const witness = lineageWitness();
  const first = lineageTransaction({
    compensatingRelease: "2026.10.11-2",
    compensationCommit: "6".repeat(40),
    sourceCommit: witness.sourceCommit,
    sourceRelease: witness.sourceRelease,
    targetCommit: "2".repeat(40),
    targetRelease: "2026.10.11-1",
  });
  const second = lineageTransaction({
    compensatingRelease: "2026.10.12-2",
    compensationCommit: "7".repeat(40),
    marker: "second",
    sourceCommit: "2".repeat(40),
    sourceRelease: "2026.10.11-1",
    targetCommit: "3".repeat(40),
    targetRelease: "2026.10.12-1",
  });
  const prepared = lineageTransaction({
    compensatingRelease: "2026.10.11-4",
    compensationCommit: "9".repeat(40),
    marker: "prepared-side-branch",
    sourceCommit: witness.sourceCommit,
    sourceRelease: witness.sourceRelease,
    targetCommit: "8".repeat(40),
    targetRelease: "2026.10.11-3",
  });
  prepared.document.record.state = "prepared";
  delete prepared.document.record.outcome;
  delete prepared.document.record.verifiedAt;
  const acknowledgedInput = {
    controlSha256: HASH,
    controlVersion: "14",
    current: {
      acknowledgedAt: "2026-10-12T09:00:00.000Z",
      actionSha256: second.actionSha256,
      commit: "3".repeat(40),
      contractVersion: "adjustment-family-release-current/v1",
      family: "temperature",
      imageDigestsSha256: "8".repeat(64),
      release: "2026.10.12-1",
      state: "acknowledged",
    },
    epochWitness: witness,
    transactions: [second, prepared, first],
    verifiedAt: "2026-10-12T10:00:00.000Z",
  };
  const acknowledged = projectAdjustmentFamilyReleaseLineage(acknowledgedInput);
  assert.deepEqual(acknowledged, {
    contractVersion: "adjustment-family-release-lineage/v2",
    controlSha256: HASH,
    controlVersion: "14",
    currentActionSha256: second.actionSha256,
    currentCommit: "3".repeat(40),
    currentRelease: "2026.10.12-1",
    epochAncestorCommit: witness.sourceCommit,
    epochWitnessSha256: witness.witnessSha256,
    state: "verified_epoch_descendant",
    verifiedAt: "2026-10-12T10:00:00.000Z",
  });
  assert.equal(verifyAdjustmentFamilyReleaseAncestorProjection(
    acknowledgedInput, witness.sourceCommit), true);
  assert.equal(verifyAdjustmentFamilyReleaseAncestorProjection(
    acknowledgedInput, "2".repeat(40)), true);
  assert.equal(verifyAdjustmentFamilyReleaseAncestorProjection(
    acknowledgedInput, "3".repeat(40)), true);
  assert.equal(verifyAdjustmentFamilyReleaseAncestorProjection(
    acknowledgedInput, "8".repeat(40)), false);
  const compensated = lineageTransaction({
    compensated: true,
    compensatingRelease: "2026.10.12-2",
    compensationActionSha256: "d".repeat(64),
    compensationCommit: "4".repeat(40),
    marker: "compensated",
    sourceCommit: "2".repeat(40),
    sourceRelease: "2026.10.11-1",
    targetCommit: "3".repeat(40),
    targetRelease: "2026.10.12-1",
  });
  const compensationProof = projectAdjustmentFamilyReleaseLineage({
    controlSha256: HASH,
    controlVersion: "14",
    current: {
      acknowledgedAt: "2026-10-12T09:00:00.000Z",
      actionSha256: "d".repeat(64),
      commit: "4".repeat(40),
      contractVersion: "adjustment-family-release-current/v1",
      family: "temperature",
      imageDigestsSha256: "8".repeat(64),
      release: "2026.10.12-2",
      state: "compensated",
    },
    epochWitness: witness,
    transactions: [first, compensated],
    verifiedAt: "2026-10-12T10:00:00.000Z",
  });
  assert.equal(compensationProof.currentActionSha256, "d".repeat(64));
  assert.equal(compensationProof.epochAncestorCommit, witness.sourceCommit);
});

// refuse missing, ambiguous and cyclic retained ancestry
test("family release lineage rejects unrelated, ambiguous and cyclic journals", () => {
  const witness = lineageWitness();
  const first = lineageTransaction({
    compensatingRelease: "2026.10.11-2",
    compensationCommit: "6".repeat(40),
    sourceCommit: witness.sourceCommit,
    sourceRelease: witness.sourceRelease,
    targetCommit: "2".repeat(40),
    targetRelease: "2026.10.11-1",
  });
  const second = lineageTransaction({
    compensatingRelease: "2026.10.12-2",
    compensationCommit: "7".repeat(40),
    marker: "second",
    sourceCommit: "2".repeat(40),
    sourceRelease: "2026.10.11-1",
    targetCommit: "3".repeat(40),
    targetRelease: "2026.10.12-1",
  });
  const current = {
    acknowledgedAt: "2026-10-12T09:00:00.000Z",
    actionSha256: second.actionSha256,
    commit: "3".repeat(40),
    contractVersion: "adjustment-family-release-current/v1",
    family: "temperature",
    imageDigestsSha256: "8".repeat(64),
    release: "2026.10.12-1",
    state: "acknowledged",
  };
  const input = {
    controlSha256: HASH,
    controlVersion: "14",
    current,
    epochWitness: witness,
    transactions: [first, second],
    verifiedAt: "2026-10-12T10:00:00.000Z",
  };
  assert.throws(() => projectAdjustmentFamilyReleaseLineage({
    ...input,
    transactions: [first],
  }), /predecessor is ambiguous/u);
  const duplicate = lineageTransaction({
    compensatingRelease: "2026.10.12-3",
    compensationCommit: "8".repeat(40),
    marker: "duplicate",
    sourceCommit: "2".repeat(40),
    sourceRelease: "2026.10.11-1",
    targetCommit: "3".repeat(40),
    targetRelease: "2026.10.12-1",
  });
  assert.throws(() => projectAdjustmentFamilyReleaseLineage({
    ...input,
    transactions: [first, second, duplicate],
  }), /predecessor is ambiguous/u);
  const back = lineageTransaction({
    compensatingRelease: "2026.10.13-2",
    compensationCommit: "9".repeat(40),
    marker: "back",
    sourceCommit: "3".repeat(40),
    sourceRelease: "2026.10.12-1",
    targetCommit: "2".repeat(40),
    targetRelease: "2026.10.11-1",
  });
  assert.throws(() => projectAdjustmentFamilyReleaseLineage({
    ...input,
    current: { ...current, actionSha256: back.actionSha256, commit: "2".repeat(40),
      release: "2026.10.11-1" },
    transactions: [second, back],
  }), /cycle/u);
});

// recheck the current authority bytes after the bounded journal walk
test("family release lineage rejects current-authority drift", async () => {
  const witness = lineageWitness();
  const serverImage = `ghcr.io/anstosa/weather-server@${witness.sourceServerImageDigest}`;
  const webImage = `ghcr.io/anstosa/weather-web@${witness.sourceWebImageDigest}`;
  const current = {
    bootstrappedAt: witness.epochAt,
    catalogSha256: HASH,
    commit: witness.sourceCommit,
    contractVersion: "adjustment-family-release-bootstrap-current/v1",
    imageDigestsSha256: imageIdentity(serverImage, webImage),
    release: witness.sourceRelease,
    serverImage,
    settingsSha256: HASH,
    state: "inert_v14_bootstrap",
    webImage,
  };
  const before = canonicalBytes(current);
  let reads = 0;
  await assert.rejects(readAdjustmentFamilyReleaseLineage({
    host: {
      clock: () => "2026-10-10T09:00:00.000Z",
      inspectLive: async () => ({
        commit: witness.sourceCommit,
        environment: {
          WEATHER_CONTROL_PLANE_SHA256: HASH,
          WEATHER_CONTROL_PLANE_VERSION: "14",
          WEATHER_SERVER_IMAGE: serverImage,
          WEATHER_WEB_IMAGE: webImage,
        },
        release: witness.sourceRelease,
      }),
      readCurrent: async () => reads++ === 0 ? before : Buffer.concat([before, Buffer.from(" ")]),
      readTransactions: async () => [],
      readWitness: async () => witness,
    },
  }), /changed during lineage read/u);
});

// lock the family transaction to the real root-owned deployment tree
test("family release roots use the observed installed deployment tree", async () => {
  const evaluator = await readFile(
    join(ROOT, "deploy/scripts/adjustment-evaluation-package.mjs"),
    "utf8",
  );
  const update = await readFile(join(ROOT, "deploy/scripts/update.sh"), "utf8");
  const remote = await readFile(join(ROOT, "deploy/scripts/remote-ops.sh"), "utf8");

  // never recreate the nonexistent runtime deployment mirror
  for (const source of [evaluator, update, remote]) {
    assert.doesNotMatch(source, /\/var\/lib\/weather\/deploy/u);
  }
  assert.match(
    evaluator,
    /\/opt\/weather\/current\/deploy\/state\/adjustment-release-state/u,
  );
  assert.match(
    evaluator,
    /\/opt\/weather\/current\/deploy\/state\/adjustment-candidate-catalog\.json/u,
  );
  assert.match(update, /adjustment_family_deploy_state=\/opt\/weather\/current\/deploy\/state/u);
  assert.match(update, /adjustment_family_releases=\/opt\/weather\/current\/deploy\/releases/u);
  assert.match(update, /stat -c '%a'.*adjustment_family_deploy_state.*== 775/us);
  assert.match(update, /stat -c '%a'.*adjustment_family_releases.*== 775/us);
  assert.match(update, /record_adjustment_family_release_success "\$target" "\$current"/u);
  assert.doesNotMatch(
    update,
    /record_adjustment_family_release_success "\$target" "\$expected_current"/u,
  );
  const familyCase = update.slice(update.indexOf("  adjustment-family-release)"));
  assert.ok(familyCase.indexOf("require_adjustment_family_source_cas") <
    familyCase.indexOf("prepare_adjustment_family_release_pair"));

  // publish each file-bound catalog inode before recreating its containers
  const targetPort = evaluator.slice(
    evaluator.indexOf("async function applyTarget"),
    evaluator.indexOf("async function verifyLive"),
  );
  const compensationPort = evaluator.slice(
    evaluator.indexOf("async function compensate"),
    evaluator.indexOf("return {\n    compensate,"),
  );
  assert.ok(targetPort.indexOf("installAdjustmentFamilyCatalog") <
    targetPort.indexOf("runAdjustmentFamilyUpdate"));
  assert.ok(compensationPort.indexOf("installAdjustmentFamilyCatalog") <
    compensationPort.indexOf("runAdjustmentFamilyUpdate"));
});

test("installed catalog v2 preserves active and promotes only the exact shadow slot", async () => {
  const candidateSha256 = "4".repeat(64);
  const artifactSha256 = "5".repeat(64);
  const graphSha256 = "6".repeat(64);
  const registration = {
    artifactSha256,
    candidateSha256,
    cohortSha256: "7".repeat(64),
    family: "temperature",
    intervalEndAt: "2026-10-17T08:00:00.000Z",
    intervalStartAt: "2026-10-10T08:00:00.000Z",
    policySha256: "8".repeat(64),
    registrationSha256: "9".repeat(64),
    reservedKeySha256: "a".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "b".repeat(64),
    targetCutoffAt: "2026-10-17T08:00:00.000Z",
    terminalAt: "2026-10-18T08:00:00.000Z",
  };
  const baseAction = {
    candidateGraphSha256: graphSha256,
    candidateSha256,
    fencingToken: "7",
    lifecycleHeadSha256: "c".repeat(64),
    policyReportSha256: "d".repeat(64),
  };
  const environment = {
    WEATHER_CONTROL_PLANE_SHA256: "e".repeat(64),
    WEATHER_RELEASE: "2026.10.10-1",
    WEATHER_SERVER_IMAGE: `ghcr.io/anstosa/weather-server@sha256:${"f".repeat(64)}`,
  };
  const source = { contractVersion: "adjustment-installed-candidate-catalog/v1", entries: [] };
  const shadowActionSha256 = "1".repeat(64);
  const projection = Buffer.from(`${JSON.stringify({
    actionSha256: shadowActionSha256,
    artifactSha256,
    bundleSha256: artifactSha256,
    candidateGraphSha256: graphSha256,
    candidateSha256,
    contractVersion: "forecast-adjustment-shadow-catalog-projection/v1",
    family: "temperature",
    paritySha256: "2".repeat(64),
    registration,
    siteKey: "ballydidean",
  })}\n`);
  const shadow = await buildInstalledAdjustmentTargetCatalog({
    action: { ...baseAction, actionKind: "shadow", fullMemberRootSha256: null,
      policyDecision: "pending" },
    actionSha256: shadowActionSha256,
    clock: () => "2026-10-10T09:00:00.000Z",
    environment,
    family: "temperature",
    imageCommit: "1".repeat(40),
    imageRead: () => projection,
    settingsBytes: Buffer.from('{"rain":true,"temperature":true,"version":1,"wind":true}\n'),
    source,
  });
  assert.equal(shadow.contractVersion, "adjustment-installed-candidate-catalog/v2");
  assert.deepEqual(shadow.entries.map((entry) => `${entry.family}/${entry.slot}`),
    ["temperature/shadow"]);
  assert.equal(shadow.entries[0].receipt.contractVersion,
    "adjustment-installed-candidate-receipt/v2");
  const promoted = await buildInstalledAdjustmentTargetCatalog({
    action: { ...baseAction, actionKind: "promote", fullMemberRootSha256: "3".repeat(64),
      policyDecision: "qualified" },
    actionSha256: ACTION,
    clock: () => "2026-10-18T09:00:00.000Z",
    environment: { ...environment, WEATHER_RELEASE: "2026.10.18-1" },
    family: "temperature",
    imageCommit: "2".repeat(40),
    imageRead: () => { throw new Error("promotion must reuse installed shadow bytes"); },
    settingsBytes: Buffer.from('{"rain":true,"temperature":true,"version":1,"wind":true}\n'),
    source: shadow,
  });
  assert.deepEqual(promoted.entries.map((entry) => `${entry.family}/${entry.slot}`),
    ["temperature/active"]);
  assert.equal(promoted.entries[0].receipt.actionKind, "promote");
  assert.equal(promoted.entries[0].receipt.bundleSha256, artifactSha256);
});

test("durable family ports fence before mutation and reconcile only the prebuilt compensation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-family-ports-"));
  const root = join(parent, "adjustment-release-state");
  const calls = [];
  const host = {
    // target failure forces the independently prebuilt compensation
    applyTarget: async () => {
      calls.push("target");
      throw new Error("target failed");
    },
    compensate: async () => {
      calls.push("compensation");
      return {
        actionSha256: COMPENSATION_ACTION,
        commit: "3".repeat(40),
        imageDigestsSha256: "e".repeat(64),
        release: "2026.10.10-2",
      };
    },
    inspectCurrent: async () => ({ release: "2026.10.09-1" }),
    verifyLive: async () => {
      throw new Error("target must not verify");
    },
    verifyProof: async () => proof(),
  };
  const ports = createAdjustmentFamilyReleasePorts({
    clock: () => "2026-10-10T09:00:00.000Z",
    host,
    root,
  });
  const prepared = record();

  try {
    await ports.prepare(prepared, proof());
    assert.equal((await ports.inspectCurrent()).maximumFence, "7");
    await ports.markApplying(prepared);
    await assert.rejects(ports.applyImages(prepared, proof()), /target failed/u);
    await ports.recordFailure({
      ...prepared,
      failedAt: "2026-10-10T09:00:00.000Z",
      state: "compensation_required",
    });
    assert.deepEqual(calls, ["target", "compensation"]);
    assert.equal((await ports.status(ACTION)).compensationState, "verified");
    assert.equal((await ports.readPrepared(ACTION)).state, "compensation_required");
    const current = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
    assert.equal(current.release, "2026.10.10-2");
    assert.equal(current.state, "compensated");

    // a restarted process must not repeat an already verified compensation
    const restarted = createAdjustmentFamilyReleasePorts({
      clock: () => "2026-10-10T09:01:00.000Z",
      host: {
        ...host,
        compensate: async () => {
          throw new Error("compensation replayed");
        },
      },
      root,
    });
    const reconciled = await restarted.reconcileCompensation(ACTION);
    assert.equal(reconciled.state, "verified");
    assert.deepEqual(calls, ["target", "compensation"]);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("durable family ports refuse prepared identity collisions", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-family-collision-"));
  const root = join(parent, "adjustment-release-state");
  const host = {
    applyTarget: async () => undefined,
    compensate: async () => undefined,
    inspectCurrent: async () => ({ release: "2026.10.09-1" }),
    verifyLive: async () => undefined,
    verifyProof: async () => proof(),
  };
  const ports = createAdjustmentFamilyReleasePorts({
    clock: () => "2026-10-10T09:00:00.000Z",
    host,
    root,
  });

  try {
    await ports.prepare(record(), proof());
    await assert.rejects(ports.prepare({
      ...record(),
      targetCommit: "4".repeat(40),
    }, proof()), /collision/u);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("forced ssh grammar admits only exact family and revision-catalog operands", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weather-family-dispatch-"));
  const bin = join(parent, "bin");
  const log = join(parent, "arguments");
  await mkdir(bin);
  await writeFile(join(bin, "sudo"), "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" >\"$DISPATCH_LOG\"\n");
  await chmod(join(bin, "sudo"), 0o755);
  const command = [
    "adjustment-family-release",
    "2026.10.10-1",
    "2026.10.10-2",
    "2026.10.09-1",
    "2026.10.09-1",
    HASH,
    "temperature",
    ACTION,
    HASH,
    "7",
  ].join(" ");
  // invoke the forced dispatcher with a nonprivileged sudo recorder
  const dispatch = (original) => spawnSync("bash", [
    join(ROOT, "deploy/scripts/ssh-dispatch.sh"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
      SSH_ORIGINAL_COMMAND: original,
    },
  });

  try {
    const accepted = dispatch(command);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...command.split(" "),
    ]);
    const status = dispatch(`adjustment-family-release-status ${ACTION}`);
    assert.equal(status.status, 0, status.stderr);
    const current = dispatch("adjustment-family-release-current-v1 temperature");
    assert.equal(current.status, 0, current.stderr);
    const lineage = dispatch("adjustment-family-release-lineage-v2");
    assert.equal(lineage.status, 0, lineage.stderr);
    const captureEpoch = dispatch("adjustment-revision-capture-epoch-v1");
    assert.equal(captureEpoch.status, 0, captureEpoch.stderr);
    const captureEpochSnapshot = dispatch("adjustment-revision-capture-epoch-snapshot-v1");
    assert.equal(captureEpochSnapshot.status, 0, captureEpochSnapshot.stderr);
    const databaseLedger = dispatch("adjustment-database-ledger-v3");
    assert.equal(databaseLedger.status, 0, databaseLedger.stderr);
    const currentCatalogStart = dispatch(
      "adjustment-revision-catalog-current-start-v1 2026-10-10T07:00:00.000Z",
    );
    assert.equal(currentCatalogStart.status, 0, currentCatalogStart.stderr);
    const catalogStart = [
      "adjustment-revision-catalog-start-v1",
      "2026-10-10T07:00:00.000Z",
      "19",
    ].join(" ");
    assert.equal(dispatch(catalogStart).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...catalogStart.split(" "),
    ]);
    const catalogPage = [
      "adjustment-revision-catalog-page-v1",
      "19",
      ACTION,
      COMPENSATION_ACTION,
      "7",
      HASH,
      "d".repeat(64),
    ].join(" ");
    assert.equal(dispatch(catalogPage).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...catalogPage.split(" "),
    ]);
    const custodyAck = [
      "adjustment-revision-custody-ack-v1", "19", ACTION, COMPENSATION_ACTION,
      "7", HASH, "d".repeat(64), "e".repeat(64), "f".repeat(64),
      "1".repeat(64), "none",
    ].join(" ");
    assert.equal(dispatch(custodyAck).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...custodyAck.split(" "),
    ]);
    // preserve the operand grammar for packed custody
    const packedCustodyAck = custodyAck.replace(
      "adjustment-revision-custody-ack-v1",
      "adjustment-revision-custody-ack-v2",
    );
    assert.equal(dispatch(packedCustodyAck).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...packedCustodyAck.split(" "),
    ]);
    assert.equal(dispatch("adjustment-revision-gap-start-v1").status, 0);
    const gapPage = `adjustment-revision-gap-page-v1 ${ACTION} ${HASH}`;
    assert.equal(dispatch(gapPage).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...gapPage.split(" "),
    ]);
    const gapAck = `adjustment-revision-gap-ack-v1 ${HASH} ${ACTION}`;
    assert.equal(dispatch(gapAck).status, 0);
    assert.deepEqual((await readFile(log, "utf8")).split("\0").slice(0, -1), [
      "-n", "/usr/local/sbin/weather-remote-ops", ...gapAck.split(" "),
    ]);

    // reject alternate hashes, ordinals, families, fences, arity and shell framing
    for (const rejected of [
      command.replace(HASH, HASH.toUpperCase()),
      command.replace("temperature", "all"),
      `${command} extra`,
      command.replace(/ 7$/u, " 07"),
      `adjustment-family-release-status ${ACTION}; id`,
      `adjustment-family-release-status ${ACTION.toUpperCase()}`,
      "adjustment-family-release-current-v1 all",
      "adjustment-family-release-lineage-v2 extra",
      "adjustment-database-ledger-v3 extra",
      catalogStart.replace(" 19", " 019"),
      catalogStart.replace(".000Z", "Z"),
      catalogPage.replace(` ${HASH} `, ` ${HASH.toUpperCase()} `),
      `${catalogPage} extra`,
      custodyAck.replace(" 7 ", " 07 "),
      custodyAck.replace(/ none$/u, " none extra"),
      packedCustodyAck.replace(/ [a-f0-9]{64} /u, " bad "),
      "adjustment-revision-gap-start-v1 extra",
      gapPage.replace(HASH, HASH.toUpperCase()),
      `${gapAck} extra`,
    ]) {
      assert.equal(dispatch(rejected).status, 126);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
