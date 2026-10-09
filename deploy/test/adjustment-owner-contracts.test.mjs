import assert from "node:assert/strict";
import test from "node:test";

import {
  accessRequest,
  finalizationProof,
  promotedOperatorOffTerminalRequest,
  sha256,
  terminalNoActionSha256,
  unsupportedProof,
} from "./fixtures/adjustment-owner-requests.mjs";

import {
  validateAdjustmentConfirmationAccessBurnRequestV3,
  validateAdjustmentShadowTerminalRecordRequestV3,
  validateAdjustmentShadowTerminalRetirementRequestV3,
  validateAdjustmentShadowUnsupportedTerminalRecordRequestV1,
  validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1,
} from "../scripts/adjustment-evaluation-package.mjs";

test("owner access request preserves distinct local burn and native authority inputs", () => {
  const request = accessRequest();
  assert.equal(validateAdjustmentConfirmationAccessBurnRequestV3(request), request);
  assert.throws(() => validateAdjustmentConfirmationAccessBurnRequestV3({
    ...request,
    localBurn: { ...request.localBurn, expectedKeySetSha256: "0".repeat(64) },
  }), /local confirmation burn differs/u);
});

test("owner terminal request keeps local and database registration domains distinct", () => {
  const access = accessRequest();
  const result = {
    ...access.confirmationRegistration,
    accessState: "opened",
    actionIdentitySha256: null,
    actionState: "terminal_no_action",
    candidateReportSha256: "5".repeat(64),
    disposition: "rejected",
    fullMemberRootSha256: "a".repeat(64),
    nextConfirmationEligibleAt: "2028-02-16T09:10:00.000Z",
  };
  const nativeAccessUnsigned = {
    accessedAt: "2028-02-09T09:00:00.000Z",
    eligiblePredictionSetSha256: access.archive.eligiblePredictionSetSha256,
    expectedKeySetSha256: access.shadowRegistration.reservedKeySha256,
    gateManifestSha256: access.confirmationRegistration.gateManifestSha256,
    journalHeadSha256: access.journalHeadSha256,
    maintenanceAnchorSha256: "7".repeat(64),
    metadataRootSha256: access.metadata.rootSha256,
    registrationSha256: access.shadowRegistration.registrationSha256,
    revisionCatalogWatermarkSha256: access.localBurn.revisionCatalogWatermarkSha256,
    targetComparatorSnapshotRootSha256:
      access.localBurn.targetComparatorSnapshotRootSha256,
    targetCutoffAt: access.shadowRegistration.targetCutoffAt,
  };
  const nativePreimage = ["adjustment-confirmation-access/v2",
    ...["registrationSha256", "journalHeadSha256", "maintenanceAnchorSha256",
      "gateManifestSha256", "eligiblePredictionSetSha256", "expectedKeySetSha256",
      "metadataRootSha256", "targetComparatorSnapshotRootSha256",
      "revisionCatalogWatermarkSha256", "targetCutoffAt"].map(
      // retain the database trigger field order
      (key) => nativeAccessUnsigned[key],
    )].join("\n");
  const nativeAccess = { ...nativeAccessUnsigned, accessSha256: sha256(Buffer.from(nativePreimage)) };
  const actionSha256 = terminalNoActionSha256({
    disposition: "rejected",
    policyReportSha256: "5".repeat(64),
    registrationSha256: access.shadowRegistration.registrationSha256,
  });
  const proof = finalizationProof({
    actionSha256,
    confirmationAccessSha256: nativeAccess.accessSha256,
  });
  const request = {
    action: null,
    actionReceipt: {
      actionSha256: proof.actionSha256,
      completedAt: proof.finalizedAt,
      contractVersion: "adjustment-terminal-no-action-receipt/v3",
      disposition: "rejected",
      fullMemberRootSha256: proof.fullMemberRootSha256,
      policyReportSha256: proof.policyReportSha256,
      registrationSha256: access.shadowRegistration.registrationSha256,
      state: "verified_no_action",
    },
    confirmationRegistration: access.confirmationRegistration,
    contractVersion: "adjustment-shadow-terminal-record-request/v3",
    finalizationProof: proof,
    localResult: result,
    nativeAccess,
    previousTombstone: null,
    shadowRegistration: access.shadowRegistration,
    sourceCommit: proof.sourceCommit,
    terminalGraphManifestSha256: "8".repeat(64),
    terminalGraphVerifiedAt: "2028-02-09T09:11:00.000Z",
  };
  assert.equal(validateAdjustmentShadowTerminalRecordRequestV3(request), request);
  assert.notEqual(result.registrationSha256, nativeAccess.registrationSha256);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    actionReceipt: { ...request.actionReceipt, actionSha256: "0".repeat(64) },
    finalizationProof: { ...proof, actionSha256: "0".repeat(64) },
  }), /terminal no-action receipt differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    finalizationProof: { ...proof, confirmationAccessSha256: "0".repeat(64) },
  }), /terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    nativeAccess: { ...nativeAccess, accessedAt: "2028-02-09T07:59:59.999Z" },
  }), /terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    nativeAccess: { ...nativeAccess, accessedAt: "2028-02-09T09:08:00.001Z" },
  }), /terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    actionReceipt: { ...request.actionReceipt, completedAt: "2028-02-09T09:09:59.999Z" },
  }), /terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    actionReceipt: { ...request.actionReceipt, completedAt: "2028-02-09T09:11:00.001Z" },
  }), /terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    localResult: { ...result, sourceLineageSha256: "0".repeat(64) },
  }), /terminal record identity differs/u);
});

// preserve qualified authority while recording an intentional nonserving result
test("owner terminal request admits only an exact operator-off acknowledgement", () => {
  const access = accessRequest();
  const nativeAccessUnsigned = {
    accessedAt: "2028-02-09T09:00:00.000Z",
    eligiblePredictionSetSha256: access.archive.eligiblePredictionSetSha256,
    expectedKeySetSha256: access.shadowRegistration.reservedKeySha256,
    gateManifestSha256: access.confirmationRegistration.gateManifestSha256,
    journalHeadSha256: access.journalHeadSha256,
    maintenanceAnchorSha256: "7".repeat(64),
    metadataRootSha256: access.metadata.rootSha256,
    registrationSha256: access.shadowRegistration.registrationSha256,
    revisionCatalogWatermarkSha256: access.localBurn.revisionCatalogWatermarkSha256,
    targetComparatorSnapshotRootSha256:
      access.localBurn.targetComparatorSnapshotRootSha256,
    targetCutoffAt: access.shadowRegistration.targetCutoffAt,
  };
  const nativePreimage = ["adjustment-confirmation-access/v2",
    ...["registrationSha256", "journalHeadSha256", "maintenanceAnchorSha256",
      "gateManifestSha256", "eligiblePredictionSetSha256", "expectedKeySetSha256",
      "metadataRootSha256", "targetComparatorSnapshotRootSha256",
      "revisionCatalogWatermarkSha256", "targetCutoffAt"].map(
      // retain the database trigger field order
      (key) => nativeAccessUnsigned[key],
    )].join("\n");
  const nativeAccess = {
    ...nativeAccessUnsigned,
    accessSha256: sha256(Buffer.from(nativePreimage)),
  };
  const request = promotedOperatorOffTerminalRequest(access, nativeAccess);
  assert.equal(validateAdjustmentShadowTerminalRecordRequestV3(request), request);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    actionReceipt: { ...request.actionReceipt, fencingToken: "8" },
  }), /terminal promoted action differs|terminal action receipt differs|terminal record identity differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    actionReceipt: { ...request.actionReceipt, compensationState: "verified" },
  }), /terminal action receipt differs/u);
  assert.throws(() => validateAdjustmentShadowTerminalRecordRequestV3({
    ...request,
    action: { ...request.action, expectedSourceCommit: "0".repeat(40) },
  }), /terminal model action differs/u);
});

test("owner retirement request binds the archived tombstone to the terminal row", () => {
  const terminalRecord = {
    accessSha256: "1".repeat(64),
    actionCompletedAt: "2028-02-09T09:10:00.000Z",
    actionDisposition: "promoted_verified",
    actionSha256: "2".repeat(64),
    candidateSha256: "3".repeat(64),
    contractVersion: "adjustment-shadow-terminal-record/v3",
    family: "temperature",
    finalizedMetadataRootSha256: "4".repeat(64),
    finalizedPredictionCount: 2,
    maintenanceAnchorSha256: "5".repeat(64),
    metadataGeneration: 1,
    recordedAt: "2028-02-09T09:11:00.000Z",
    reconciliationSha256: "6".repeat(64),
    registrationSha256: "7".repeat(64),
    reservedKeySha256: "8".repeat(64),
    sourceSha256: "9".repeat(64),
    terminalMemberSha256: "a".repeat(64),
    terminalResultSha256: "b".repeat(64),
  };
  const terminalTombstone = {
    contractVersion: "adjustment-shadow-terminal-tombstone/v3",
    reconciliationSha256: terminalRecord.reconciliationSha256,
    registrationSha256: terminalRecord.registrationSha256,
    terminalResultSha256: terminalRecord.terminalResultSha256,
  };
  const request = {
    contractVersion: "adjustment-shadow-terminal-retirement-request/v3",
    finalizationProof: finalizationProof({
      actionSha256: terminalRecord.actionSha256,
      confirmationAccessSha256: terminalRecord.accessSha256,
      fullMemberRootSha256: terminalRecord.terminalMemberSha256,
      transferredAnchorSha256: terminalRecord.maintenanceAnchorSha256,
    }),
    registrationSha256: terminalRecord.registrationSha256,
    terminalRecord,
    terminalTombstone,
  };
  assert.equal(validateAdjustmentShadowTerminalRetirementRequestV3(request), request);
  assert.throws(() => validateAdjustmentShadowTerminalRetirementRequestV3({
    ...request,
    terminalTombstone: { ...terminalTombstone, reconciliationSha256: "c".repeat(64) },
  }), /retirement identity differs/u);
});

test("unsupported owner requests close one failed member without qualified authority", () => {
  const access = accessRequest();
  const proof = unsupportedProof();
  const result = {
    ...access.confirmationRegistration,
    accessState: "opened",
    actionIdentitySha256: null,
    actionState: "terminal_no_action",
    candidateReportSha256: proof.policyReportSha256,
    disposition: "support_failed",
    fullMemberRootSha256: proof.fullMemberRootSha256,
    nextConfirmationEligibleAt: "2028-02-16T09:10:00.000Z",
  };
  const nativeAccessUnsigned = {
    accessedAt: "2028-02-09T09:00:00.000Z",
    eligiblePredictionSetSha256: access.archive.eligiblePredictionSetSha256,
    expectedKeySetSha256: access.shadowRegistration.reservedKeySha256,
    gateManifestSha256: access.confirmationRegistration.gateManifestSha256,
    journalHeadSha256: access.journalHeadSha256,
    maintenanceAnchorSha256: "7".repeat(64),
    metadataRootSha256: access.metadata.rootSha256,
    registrationSha256: access.shadowRegistration.registrationSha256,
    revisionCatalogWatermarkSha256: access.localBurn.revisionCatalogWatermarkSha256,
    targetComparatorSnapshotRootSha256:
      access.localBurn.targetComparatorSnapshotRootSha256,
    targetCutoffAt: access.shadowRegistration.targetCutoffAt,
  };
  const nativePreimage = ["adjustment-confirmation-access/v2",
    ...["registrationSha256", "journalHeadSha256", "maintenanceAnchorSha256",
      "gateManifestSha256", "eligiblePredictionSetSha256", "expectedKeySetSha256",
      "metadataRootSha256", "targetComparatorSnapshotRootSha256",
      "revisionCatalogWatermarkSha256", "targetCutoffAt"].map(
      // retain the database trigger field order
      (key) => nativeAccessUnsigned[key],
    )].join("\n");
  const nativeAccess = {
    ...nativeAccessUnsigned,
    accessSha256: sha256(Buffer.from(nativePreimage)),
  };
  const boundProof = {
    ...proof,
    confirmationAccessSha256: nativeAccess.accessSha256,
  };
  const actionReceipt = {
    actionSha256: boundProof.actionSha256,
    completedAt: boundProof.finalizedAt,
    contractVersion: "adjustment-terminal-no-action-receipt/v3",
    disposition: "support_failed",
    fullMemberRootSha256: boundProof.fullMemberRootSha256,
    policyReportSha256: boundProof.policyReportSha256,
    registrationSha256: access.shadowRegistration.registrationSha256,
    state: "verified_no_action",
  };
  const request = {
    actionReceipt,
    confirmationRegistration: access.confirmationRegistration,
    contractVersion: "adjustment-shadow-unsupported-terminal-record-request/v1",
    localResult: result,
    nativeAccess,
    previousTombstone: null,
    shadowRegistration: access.shadowRegistration,
    sourceCommit: boundProof.sourceCommit,
    terminalGraphManifestSha256: boundProof.graphManifestSha256,
    terminalGraphVerifiedAt: "2028-02-09T09:11:00.000Z",
    unsupportedProof: boundProof,
  };
  assert.equal(validateAdjustmentShadowUnsupportedTerminalRecordRequestV1(request), request);
  assert.throws(() => validateAdjustmentShadowUnsupportedTerminalRecordRequestV1({
    ...request,
    localResult: { ...result, disposition: "rejected" },
  }), /unsupported terminal record identity differs/u);
  const proofSha256 = sha256(boundProof);
  const terminalRecord = {
    accessSha256: nativeAccess.accessSha256,
    actionCompletedAt: boundProof.finalizedAt,
    actionDisposition: "support_failed_no_action",
    actionSha256: boundProof.actionSha256,
    candidateSha256: access.shadowRegistration.candidateSha256,
    contractVersion: "adjustment-shadow-terminal-record/v3",
    family: "temperature",
    finalizedMetadataRootSha256: access.metadata.rootSha256,
    finalizedPredictionCount: 2,
    maintenanceAnchorSha256: proofSha256,
    metadataGeneration: 1,
    recordedAt: "2028-02-09T09:11:00.000Z",
    reconciliationSha256: "6".repeat(64),
    registrationSha256: access.shadowRegistration.registrationSha256,
    reservedKeySha256: access.shadowRegistration.reservedKeySha256,
    sourceSha256: access.shadowRegistration.sourceSha256,
    terminalMemberSha256: boundProof.fullMemberRootSha256,
    terminalResultSha256: "b".repeat(64),
  };
  const terminalTombstone = {
    contractVersion: "adjustment-shadow-terminal-tombstone/v3",
    reconciliationSha256: terminalRecord.reconciliationSha256,
    registrationSha256: terminalRecord.registrationSha256,
    terminalResultSha256: terminalRecord.terminalResultSha256,
  };
  const retirement = {
    contractVersion: "adjustment-shadow-unsupported-terminal-retirement-request/v1",
    registrationSha256: terminalRecord.registrationSha256,
    terminalRecord,
    terminalTombstone,
    unsupportedProof: boundProof,
  };
  assert.equal(validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1(retirement),
    retirement);
  assert.throws(() => validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1({
    ...retirement,
    terminalRecord: { ...terminalRecord, maintenanceAnchorSha256: "0".repeat(64) },
  }), /unsupported terminal retirement identity differs/u);
});
