import { createHash } from "node:crypto";

// encode the production canonical json framing
export function canonicalBytes(value) {
  const canonicalize = (item) => {
    // preserve arrays while sorting every plain object
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map(
        // canonicalize one named member
        (key) => [key, canonicalize(item[key])],
      ));
    }
    return item;
  };
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`);
}

// hash one canonical or already framed value
export function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : canonicalBytes(value))
    .digest("hex");
}

// derive one frozen nonmutating terminal identity
export function terminalNoActionSha256(input) {
  return sha256({
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: input.disposition,
    policyReportSha256: input.policyReportSha256,
    registrationSha256: input.registrationSha256,
  });
}

// construct one exact packed-custody acknowledgement
export function acknowledgement() {
  const retirementEntries = [
    ["revision_commit_receipt", "1"],
    ["revision_frontier_successor", "2"],
    ["revision_projection", "3"],
    ["revision_stage_receipt", "4"],
  ].map(([kind, digit]) => ({
    fileSha256: digit.repeat(64),
    identitySha256: digit.repeat(64),
    kind,
  }));
  const unsigned = {
    acknowledgedAt: "2027-01-01T00:00:00.000Z",
    afterArchiveCommitOrdinal: "0",
    afterFrontierSha256: "5".repeat(64),
    authority: "cold_custody_only",
    contractVersion: "adjustment-revision-custody-acknowledgement/v2",
    custodyCheckpointSha256: "6".repeat(64),
    memberRootSha256: "7".repeat(64),
    nextArchiveCommitOrdinal: "1",
    nextFrontierSha256: "8".repeat(64),
    pageSha256: "9".repeat(64),
    previousAcknowledgementSha256: null,
    previousPageSha256: "a".repeat(64),
    retirementEntries,
    startMemberSha256: "b".repeat(64),
    startSha256: "c".repeat(64),
    watermarkArchiveCommitOrdinal: "1",
    watermarkFrontierSha256: "8".repeat(64),
  };
  return { ...unsigned, acknowledgementSha256: sha256(unsigned) };
}

// construct cross-bound local and database registration documents
export function accessRequest() {
  const registrationBase = {
    candidateKind: "temperature-delayed-mos/v1",
    candidateSha256: "d".repeat(64),
    cohortLineageSha256: "e".repeat(64),
    contractVersion: "forecast-adjustment-lifecycle-ledger/v2",
    family: "temperature",
    firstTargetAt: "2027-02-01T08:00:00.000Z",
    gateManifestSha256: "f".repeat(64),
    inputHeadSha256: "1".repeat(64),
    intervalEndExclusiveLocalDate: "2028-02-02",
    intervalStartLocalDate: "2027-02-01",
    reservedKeySha256: "2".repeat(64),
    sourceLineageSha256: "3".repeat(64),
    terminalAccessAt: "2028-02-09T08:00:00.000Z",
  };
  const registrationSha256 = sha256(registrationBase);
  const confirmationRegistration = {
    ...registrationBase,
    accessState: "registered",
    actionIdentitySha256: null,
    actionState: "none",
    candidateReportSha256: null,
    registrationSha256,
  };
  const burnUnsigned = {
    ...confirmationRegistration,
    accessedAt: "2028-02-09T09:00:00.000Z",
    accessState: "burned",
    expectedKeySetSha256: registrationBase.reservedKeySha256,
    revisionCatalogWatermarkSha256: "5".repeat(64),
    targetComparatorSnapshotRootSha256: "6".repeat(64),
    targetCutoffAt: "2028-02-09T08:00:00.000Z",
  };
  const shadowUnsigned = {
    artifactSha256: "7".repeat(64),
    candidateSha256: registrationBase.candidateSha256,
    cohortSha256: "8".repeat(64),
    epochWitnessSha256: "9".repeat(64),
    family: "temperature",
    intervalEndAt: "2028-02-02T08:00:00.000Z",
    intervalStartAt: "2027-02-01T08:00:00.000Z",
    policySha256: "a".repeat(64),
    predecessorRegistrationSha256: null,
    reservedKeySha256: registrationBase.reservedKeySha256,
    scheduleContractSha256: "b".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "c".repeat(64),
    targetCutoffAt: "2028-02-09T08:00:00.000Z",
    terminalAt: "2028-02-09T08:00:00.000Z",
  };
  const shadowPreimage = ["adjustment-shadow-registration/v3",
    ...["siteKey", "family", "candidateSha256", "artifactSha256", "policySha256",
      "cohortSha256", "reservedKeySha256", "sourceSha256", "epochWitnessSha256",
      "scheduleContractSha256", "predecessorRegistrationSha256", "intervalStartAt",
      "intervalEndAt", "targetCutoffAt", "terminalAt"].map(
      // preserve the nullable predecessor domain token
      (key) => shadowUnsigned[key] ?? "none",
    )].join("\n") + "\n";
  return {
    acknowledgement: acknowledgement(),
    archive: {
      eligiblePredictionSetSha256: "d".repeat(64),
      fullGraphVerifiedAt: "2028-02-09T09:02:00.000Z",
      graphManifestSha256: "e".repeat(64),
    },
    confirmationRegistration,
    contractVersion: "adjustment-confirmation-access-burn-request/v3",
    epochWitnessSha256: "f".repeat(64),
    journalHeadSha256: "1".repeat(64),
    localBurn: { ...burnUnsigned, accessSha256: sha256(burnUnsigned) },
    metadata: {
      finalizedPredictionCount: 2,
      generation: 1,
      lastAnchorSha256: "2".repeat(64),
      rootSha256: "3".repeat(64),
      throughAt: "2028-02-09T08:30:00.000Z",
    },
    shadowRegistration: {
      ...shadowUnsigned,
      registrationSha256: sha256(Buffer.from(shadowPreimage)),
    },
    sourceCommit: "4".repeat(40),
  };
}

// construct one genuine finalization-proof grammar without a registration alias
export function finalizationProof(overrides = {}) {
  return {
    actionSha256: "2".repeat(64),
    archiveCommitOrdinal: "1",
    burnSha256: "3".repeat(64),
    candidateArtifactRootSha256: "4".repeat(64),
    candidateReportSha256: "5".repeat(64),
    captureEpochWitnessSha256: "6".repeat(64),
    confirmationAccessSha256: "1".repeat(64),
    confirmationChunkCount: 27,
    contractVersion: "adjustment-maintenance-finalization-proof/v3",
    controlSha256: "7".repeat(64),
    controlVersion: "14",
    custodyCheckpointSha256: "8".repeat(64),
    dueKey: `confirmation/temperature/${"d".repeat(64)}`,
    family: "temperature",
    finalizedAt: "2028-02-09T09:10:00.000Z",
    frontierSha256: "9".repeat(64),
    fullGraphVerifiedAt: "2028-02-09T09:08:00.000Z",
    fullMemberRootSha256: "a".repeat(64),
    graphManifestSha256: "b".repeat(64),
    inputSealSha256: "c".repeat(64),
    lifecycleLedgerRootSha256: "d".repeat(64),
    pageSha256: "e".repeat(64),
    policyReportSha256: "5".repeat(64),
    predecessorAnchorSha256: null,
    publishedAt: "2028-02-09T09:09:00.000Z",
    requiredInputRootSha256: "f".repeat(64),
    sequence: "0",
    sourceCommit: "4".repeat(40),
    transferredAnchorSha256: "5".repeat(64),
    workstationJournalHeadSha256: "6".repeat(64),
    ...overrides,
  };
}

// construct one qualified but intentionally unapplied owner terminal request
export function promotedOperatorOffTerminalRequest(access, nativeAccess, overrides = {}) {
  const completedAt = overrides.completedAt ?? "2028-02-09T09:10:00.000Z";
  const action = {
    actionKind: "promote",
    candidateGraphSha256: "7".repeat(64),
    candidateSha256: access.shadowRegistration.candidateSha256,
    contractVersion: "forecast-adjustment-model-action/v1",
    createdAt: completedAt,
    expectedInstalledReceiptSha256: null,
    expectedSettingsSha256: "8".repeat(64),
    expectedSourceCommit: access.sourceCommit,
    expectedSourceRelease: "2028.02.08-1",
    family: access.shadowRegistration.family,
    fencingToken: "7",
    fullMemberRootSha256: "a".repeat(64),
    lifecycleHeadSha256: "d".repeat(64),
    policyDecision: "qualified",
    policyReportSha256: "5".repeat(64),
    predecessorActionSha256: null,
    reason: "qualified_candidate",
    reportCreatedAt: completedAt,
    siteKey: "ballydidean",
    validThrough: new Date(Date.parse(completedAt) + 7 * 86_400_000).toISOString(),
  };
  const actionSha256 = sha256(action);
  const proof = finalizationProof({
    actionSha256,
    confirmationAccessSha256: nativeAccess.accessSha256,
    finalizedAt: completedAt,
    fullGraphVerifiedAt: completedAt,
    fullMemberRootSha256: action.fullMemberRootSha256,
    policyReportSha256: action.policyReportSha256,
    publishedAt: completedAt,
    sourceCommit: access.sourceCommit,
  });
  return {
    action,
    actionReceipt: {
      actionSha256,
      compensatingRelease: "2028.02.09-2",
      compensationState: "absent",
      contractVersion: "adjustment-family-release-status/v1",
      family: action.family,
      fencingToken: action.fencingToken,
      outcome: "operator_off_unapplied",
      state: "operator_off_unapplied",
      targetRelease: "2028.02.09-1",
    },
    confirmationRegistration: access.confirmationRegistration,
    contractVersion: "adjustment-shadow-terminal-record-request/v3",
    finalizationProof: proof,
    localResult: {
      ...access.confirmationRegistration,
      accessState: "opened",
      actionIdentitySha256: actionSha256,
      actionState: "action_pending",
      candidateReportSha256: proof.policyReportSha256,
      disposition: "promoted",
      fullMemberRootSha256: proof.fullMemberRootSha256,
      nextConfirmationEligibleAt:
        new Date(Date.parse(completedAt) + 7 * 86_400_000).toISOString(),
    },
    nativeAccess,
    previousTombstone: null,
    shadowRegistration: access.shadowRegistration,
    sourceCommit: access.sourceCommit,
    terminalGraphManifestSha256: "8".repeat(64),
    terminalGraphVerifiedAt: completedAt,
  };
}

// construct one terminal-only unsupported proof without qualification authority
export function unsupportedProof(overrides = {}) {
  const emptyRootSha256 = sha256([]);
  const inputClasses = {
    actual_best_match: { count: 1, rootSha256: sha256(["1".repeat(64)]) },
    artifact: { count: 1, rootSha256: sha256(["7".repeat(64)]) },
    candidate: { count: 1, rootSha256: sha256(["d".repeat(64)]) },
    comparator: { count: 1, rootSha256: sha256(["2".repeat(64)]) },
    native_source: { count: 1, rootSha256: sha256(["3".repeat(64)]) },
    rain_gate_input: { count: 0, rootSha256: emptyRootSha256 },
    shadow_body: { count: 1, rootSha256: sha256(["4".repeat(64)]) },
    shadow_source: { count: 1, rootSha256: sha256(["5".repeat(64)]) },
    target: { count: 0, rootSha256: emptyRootSha256 },
    target_revision: { count: 0, rootSha256: emptyRootSha256 },
  };
  const policyReportSha256 = "5".repeat(64);
  const registrationSha256 = accessRequest().shadowRegistration.registrationSha256;
  return {
    actionSha256: terminalNoActionSha256({
      disposition: "support_failed",
      policyReportSha256,
      registrationSha256,
    }),
    archiveCommitOrdinal: "1",
    burnSha256: "3".repeat(64),
    candidateReportSha256: policyReportSha256,
    captureEpochWitnessSha256: "6".repeat(64),
    confirmationAccessSha256: "1".repeat(64),
    confirmationChunkCount: 27,
    contractVersion: "adjustment-maintenance-unsupported-terminal-proof/v1",
    controlSha256: "7".repeat(64),
    controlVersion: "14",
    custodyCheckpointSha256: "8".repeat(64),
    dueKey: `confirmation/temperature/${"d".repeat(64)}`,
    eligiblePredictionSetSha256: "9".repeat(64),
    expectedKeySetSha256: "2".repeat(64),
    family: "temperature",
    finalizedAt: "2028-02-09T09:10:00.000Z",
    frontierSha256: "a".repeat(64),
    fullGraphVerifiedAt: "2028-02-09T09:08:00.000Z",
    fullMemberRootSha256: "b".repeat(64),
    graphManifestSha256: "8".repeat(64),
    inputClasses,
    lifecycleLedgerRootSha256: "c".repeat(64),
    missingClassNames: ["target", "target_revision"],
    missingKeyCount: 1,
    missingKeySetSha256: "d".repeat(64),
    pageSha256: "e".repeat(64),
    policyReportSha256,
    predecessorProofSha256: null,
    registrationSha256,
    requiredInputRootSha256: sha256(inputClasses),
    sequence: "0",
    sourceCommit: "4".repeat(40),
    unsupportedReason: "permanent_target_gap",
    workstationJournalHeadSha256: "6".repeat(64),
    ...overrides,
  };
}
