import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runMigrations } from "../dist/index.js";
import { createTestPool, prepareRuntimeRoles, startPostgres, stopPostgres } from "./postgres-harness.mjs";
import {
  accessRequest,
  finalizationProof,
  promotedOperatorOffTerminalRequest,
  sha256,
  terminalNoActionSha256,
  unsupportedProof,
} from "../../../deploy/test/fixtures/adjustment-owner-requests.mjs";
import {
  buildAdjustmentConfirmationAccessBurnSqlV3,
  buildAdjustmentShadowTerminalRecordSqlV3,
  buildAdjustmentShadowTerminalRetirementSqlV3,
  buildAdjustmentShadowUnsupportedTerminalRecordSqlV1,
  buildAdjustmentShadowUnsupportedTerminalRetirementSqlV1,
} from "../../../deploy/scripts/adjustment-evaluation-package.mjs";

// move only disposable fixture clocks while recomputing each distinct identity domain
function maturedAccessRequest() {
  const request = JSON.parse(JSON.stringify(accessRequest()).replaceAll("2027-", "2025-").replaceAll("2028-", "2026-"));
  const registrationFields = ["candidateKind", "candidateSha256", "cohortLineageSha256", "contractVersion", "family",
    "firstTargetAt", "gateManifestSha256", "inputHeadSha256", "intervalEndExclusiveLocalDate",
    "intervalStartLocalDate", "reservedKeySha256", "sourceLineageSha256", "terminalAccessAt"];
  const unsigned = Object.fromEntries(registrationFields.map(
    // preserve the journal registration preimage rather than its mutable access fields
    (key) => [key, request.confirmationRegistration[key]],
  ));
  request.confirmationRegistration.registrationSha256 = sha256(unsigned);
  request.localBurn.registrationSha256 = request.confirmationRegistration.registrationSha256;
  const { accessSha256: _access, ...burnUnsigned } = request.localBurn;
  request.localBurn.accessSha256 = sha256(burnUnsigned);
  const shadow = request.shadowRegistration;
  shadow.scheduleContractSha256 = "7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f";
  shadow.registrationSha256 = sha256(Buffer.from(["adjustment-shadow-registration/v3",
    ...["siteKey", "family", "candidateSha256", "artifactSha256", "policySha256", "cohortSha256",
      "reservedKeySha256", "sourceSha256", "epochWitnessSha256", "scheduleContractSha256",
      "predecessorRegistrationSha256", "intervalStartAt", "intervalEndAt", "targetCutoffAt", "terminalAt"].map(
      // retain the nullable predecessor token and terminal newline
      (key) => shadow[key] ?? "none",
    )].join("\n") + "\n"));
  const { acknowledgementSha256: _ack, ...ackUnsigned } = request.acknowledgement;
  request.acknowledgement.acknowledgementSha256 = sha256(ackUnsigned);
  return request;
}

// seed a matured administrator fixture without weakening any production owner function
async function seedMaturedFixture(admin, request) {
  const registration = request.shadowRegistration;
  const fields = ["registrationSha256", "siteKey", "family", "candidateSha256", "artifactSha256", "policySha256",
    "cohortSha256", "reservedKeySha256", "sourceSha256", "intervalStartAt", "intervalEndAt", "targetCutoffAt", "terminalAt"];
  const columns = ["registration_sha256", "site_key", "family", "candidate_sha256", "artifact_sha256", "policy_sha256",
    "cohort_sha256", "reserved_key_sha256", "source_sha256", "interval_start_at", "interval_end_at", "target_cutoff_at", "terminal_at"];
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    // disable only fixture admission triggers inside this disposable database transaction
    await client.query(`ALTER TABLE adjustment_shadow_registrations_v2 DISABLE TRIGGER ALL;
      ALTER TABLE adjustment_shadow_registration_windows_v3 DISABLE TRIGGER ALL;`);
    const values = [...fields.map((key) => registration[key]), "2025-01-31T08:00:00.000Z",
      request.metadata.rootSha256, request.metadata.finalizedPredictionCount, request.metadata.throughAt,
      request.metadata.generation, request.metadata.lastAnchorSha256];
    await client.query(`INSERT INTO adjustment_shadow_registrations_v2 (${columns.join(", ")}, registered_at,
      finalized_metadata_root_sha256, finalized_prediction_count, finalized_through_at, metadata_generation,
      last_finalization_anchor_sha256) VALUES (${values.map((_value, index) => `$${index + 1}`).join(", ")})`, values);
    const windowValues = [...fields.map((key) => registration[key]), "2025-01-31T08:00:00.000Z",
      registration.epochWitnessSha256, registration.scheduleContractSha256, null];
    await client.query(`INSERT INTO adjustment_shadow_registration_windows_v3 (${columns.join(", ")}, registered_at,
      epoch_witness_sha256, schedule_contract_sha256, predecessor_registration_sha256)
      VALUES (${windowValues.map((_value, index) => `$${index + 1}`).join(", ")})`, windowValues);
    // re-enable every guard before invoking any owner-native operation
    await client.query(`ALTER TABLE adjustment_shadow_registrations_v2 ENABLE TRIGGER ALL;
      ALTER TABLE adjustment_shadow_registration_windows_v3 ENABLE TRIGGER ALL; COMMIT;`);
  } finally { client.release(); }
}

// execute real owner statements and retain only their genuine query response
async function ownerResult(client, sql) {
  const results = await client.query(sql);
  return results.find((result) => result.rows[0]?.json_build_object !== undefined)?.rows[0].json_build_object;
}

// bind the actual native access into a closed negative terminal fixture
function terminalRequest(access, nativeAccess) {
  const proofClock = new Date().toISOString();
  const actionSha256 = terminalNoActionSha256({
    disposition: "rejected",
    policyReportSha256: "5".repeat(64),
    registrationSha256: access.shadowRegistration.registrationSha256,
  });
  const proof = finalizationProof({ actionSha256,
    confirmationAccessSha256: nativeAccess.accessSha256, finalizedAt: proofClock,
    fullGraphVerifiedAt: proofClock, publishedAt: proofClock });
  return {
    action: null,
    actionReceipt: { actionSha256: proof.actionSha256, completedAt: proof.finalizedAt,
      contractVersion: "adjustment-terminal-no-action-receipt/v3", disposition: "rejected",
      fullMemberRootSha256: proof.fullMemberRootSha256, policyReportSha256: proof.policyReportSha256,
      registrationSha256: access.shadowRegistration.registrationSha256, state: "verified_no_action" },
    confirmationRegistration: access.confirmationRegistration,
    contractVersion: "adjustment-shadow-terminal-record-request/v3",
    finalizationProof: proof,
    localResult: { ...access.confirmationRegistration, accessState: "opened", actionIdentitySha256: null,
      actionState: "terminal_no_action", candidateReportSha256: proof.candidateReportSha256, disposition: "rejected",
      fullMemberRootSha256: proof.fullMemberRootSha256, nextConfirmationEligibleAt: new Date(Date.parse(proofClock) + 7 * 86_400_000).toISOString() },
    nativeAccess, previousTombstone: null, shadowRegistration: access.shadowRegistration, sourceCommit: proof.sourceCommit,
    terminalGraphManifestSha256: "8".repeat(64), terminalGraphVerifiedAt: proofClock,
  };
}

// bind one genuine unsupported proof to the actual native access row
function unsupportedTerminalRequest(access, nativeAccess) {
  const fullGraphVerifiedAt = new Date().toISOString();
  const finalizedAt = fullGraphVerifiedAt;
  const policyReportSha256 = "5".repeat(64);
  const registrationSha256 = access.shadowRegistration.registrationSha256;
  const actionSha256 = terminalNoActionSha256({
    disposition: "support_failed",
    policyReportSha256,
    registrationSha256,
  });
  const proof = unsupportedProof({
    actionSha256,
    burnSha256: access.localBurn.accessSha256,
    candidateReportSha256: policyReportSha256,
    confirmationAccessSha256: nativeAccess.accessSha256,
    eligiblePredictionSetSha256: access.archive.eligiblePredictionSetSha256,
    expectedKeySetSha256: access.localBurn.expectedKeySetSha256,
    finalizedAt,
    fullGraphVerifiedAt,
    fullMemberRootSha256: "b".repeat(64),
    graphManifestSha256: "8".repeat(64),
    policyReportSha256,
    registrationSha256,
    sourceCommit: access.sourceCommit,
  });
  return {
    actionReceipt: {
      actionSha256,
      completedAt: finalizedAt,
      contractVersion: "adjustment-terminal-no-action-receipt/v3",
      disposition: "support_failed",
      fullMemberRootSha256: proof.fullMemberRootSha256,
      policyReportSha256,
      registrationSha256,
      state: "verified_no_action",
    },
    confirmationRegistration: access.confirmationRegistration,
    contractVersion: "adjustment-shadow-unsupported-terminal-record-request/v1",
    localResult: {
      ...access.confirmationRegistration,
      accessState: "opened",
      actionIdentitySha256: null,
      actionState: "terminal_no_action",
      candidateReportSha256: policyReportSha256,
      disposition: "support_failed",
      fullMemberRootSha256: proof.fullMemberRootSha256,
      nextConfirmationEligibleAt:
        new Date(Date.parse(finalizedAt) + 7 * 86_400_000).toISOString(),
    },
    nativeAccess,
    previousTombstone: null,
    shadowRegistration: access.shadowRegistration,
    sourceCommit: access.sourceCommit,
    terminalGraphManifestSha256: proof.graphManifestSha256,
    terminalGraphVerifiedAt: finalizedAt,
    unsupportedProof: proof,
  };
}

// prove actual native burn, reconciliation and retirement with retries and tamper refusal
test("owner operations execute guarded PostgreSQL statements and preserve immutable terminal history", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-owner-operations");
  const admin = createTestPool(server);
  let owner;
  let client;
  try {
    await prepareRuntimeRoles(admin);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, resolve(import.meta.dirname, "../migrations"));
    await admin.query("ALTER ROLE weather_owner IN DATABASE weather_test SET weather.adjustment_maintenance_v2_enabled = 'on'");
    const request = maturedAccessRequest();
    await seedMaturedFixture(admin, request);
    client = await owner.connect();
    assert.equal(Number((await client.query(`SELECT count(*) FROM pg_trigger
      WHERE tgrelid IN ('adjustment_shadow_registrations_v2'::regclass,
        'adjustment_shadow_registration_windows_v3'::regclass) AND tgenabled = 'D'`)).rows[0].count), 0);
    await assert.rejects(client.query("UPDATE adjustment_shadow_registrations_v2 SET metadata_generation = 2"),
      /immutable/u);
    const changed = { ...request, metadata: { ...request.metadata, rootSha256: "0".repeat(64) } };
    await assert.rejects(ownerResult(client, buildAdjustmentConfirmationAccessBurnSqlV3(changed, sha256(changed))),
      /actual metadata differs/u);
    await client.query("ROLLBACK");
    const burnSql = buildAdjustmentConfirmationAccessBurnSqlV3(request, sha256(request));
    const burn = await ownerResult(client, burnSql);
    assert.equal(burn.state, "burned");
    assert.notEqual(burn.localAccessSha256, burn.nativeAccessSha256);
    assert.deepEqual(await ownerResult(client, burnSql), burn);
    const recordedRequest = terminalRequest(request, burn.nativeAccess);
    const alteredAccess = { ...recordedRequest, nativeAccess: { ...burn.nativeAccess, accessedAt: "2026-02-09T09:00:00.000Z" } };
    await assert.rejects(ownerResult(client, buildAdjustmentShadowTerminalRecordSqlV3(alteredAccess,
      sha256(alteredAccess), recordedRequest.actionReceipt.completedAt)), /actual owner access differs/u);
    await client.query("ROLLBACK");
    const terminalSql = buildAdjustmentShadowTerminalRecordSqlV3(recordedRequest, sha256(recordedRequest),
      recordedRequest.actionReceipt.completedAt);
    const terminal = await ownerResult(client, terminalSql);
    assert.equal(terminal.state, "recorded");
    assert.equal(terminal.terminalRecord.accessSha256, burn.nativeAccessSha256);
    assert.equal(terminal.terminalRecord.actionDisposition, "rejected_no_action");
    assert.deepEqual(await ownerResult(client, terminalSql), terminal);
    const retirement = { contractVersion: "adjustment-shadow-terminal-retirement-request/v3",
      finalizationProof: recordedRequest.finalizationProof, registrationSha256: request.shadowRegistration.registrationSha256,
      terminalRecord: terminal.terminalRecord, terminalTombstone: { contractVersion: "adjustment-shadow-terminal-tombstone/v3",
        reconciliationSha256: terminal.reconciliationSha256, registrationSha256: terminal.registrationSha256,
        terminalResultSha256: terminal.terminalRecord.terminalResultSha256 } };
    const retireSql = buildAdjustmentShadowTerminalRetirementSqlV3(retirement, sha256(retirement));
    const retired = await ownerResult(client, retireSql);
    assert.equal(retired.state, "retired");
    assert.deepEqual(await ownerResult(client, retireSql), retired);
    const alteredRetirement = { ...retirement, terminalRecord: { ...retirement.terminalRecord,
      finalizedMetadataRootSha256: "0".repeat(64) } };
    await assert.rejects(ownerResult(client, buildAdjustmentShadowTerminalRetirementSqlV3(alteredRetirement,
      sha256(alteredRetirement))), /actual row differs/u);
    await client.query("ROLLBACK");
    assert.equal(Number((await client.query("SELECT count(*) FROM adjustment_shadow_registrations_v2")).rows[0].count), 0);
    assert.equal(Number((await client.query("SELECT count(*) FROM adjustment_confirmation_accesses_v2")).rows[0].count), 0);
    assert.equal(Number((await client.query("SELECT count(*) FROM adjustment_shadow_terminal_results_v2")).rows[0].count), 1);
    assert.equal(Number((await client.query("SELECT count(*) FROM adjustment_shadow_registration_windows_v3")).rows[0].count), 1);
  } finally {
    client?.release();
    await owner?.end();
    await admin.end();
    await stopPostgres(server);
  }
});

// prove unsupported terminal custody closes a slot without model authority
test("unsupported owner operations retain the failed member and retire its slot", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-owner-unsupported-operations");
  const admin = createTestPool(server);
  let owner;
  let client;
  try {
    await prepareRuntimeRoles(admin);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, resolve(import.meta.dirname, "../migrations"));
    await admin.query("ALTER ROLE weather_owner IN DATABASE weather_test SET weather.adjustment_maintenance_v2_enabled = 'on'");
    const request = maturedAccessRequest();
    await seedMaturedFixture(admin, request);
    client = await owner.connect();
    const burnSql = buildAdjustmentConfirmationAccessBurnSqlV3(request, sha256(request));
    const burn = await ownerResult(client, burnSql);
    const terminalRequest = unsupportedTerminalRequest(request, burn.nativeAccess);
    const terminalSql = buildAdjustmentShadowUnsupportedTerminalRecordSqlV1(
      terminalRequest,
      sha256(terminalRequest),
      terminalRequest.actionReceipt.completedAt,
    );
    const terminal = await ownerResult(client, terminalSql);
    assert.equal(terminal.state, "recorded");
    assert.equal(terminal.terminalRecord.actionDisposition, "support_failed_no_action");
    assert.equal(terminal.terminalRecord.maintenanceAnchorSha256,
      sha256(terminalRequest.unsupportedProof));
    assert.deepEqual(await ownerResult(client, terminalSql), terminal);
    const retirement = {
      contractVersion: "adjustment-shadow-unsupported-terminal-retirement-request/v1",
      registrationSha256: request.shadowRegistration.registrationSha256,
      terminalRecord: terminal.terminalRecord,
      terminalTombstone: {
        contractVersion: "adjustment-shadow-terminal-tombstone/v3",
        reconciliationSha256: terminal.reconciliationSha256,
        registrationSha256: terminal.registrationSha256,
        terminalResultSha256: terminal.terminalRecord.terminalResultSha256,
      },
      unsupportedProof: terminalRequest.unsupportedProof,
    };
    const retireSql = buildAdjustmentShadowUnsupportedTerminalRetirementSqlV1(
      retirement,
      sha256(retirement),
    );
    const retired = await ownerResult(client, retireSql);
    assert.equal(retired.state, "retired");
    assert.deepEqual(await ownerResult(client, retireSql), retired);
    assert.equal(Number((await client.query(
      "SELECT count(*) FROM adjustment_shadow_registrations_v2",
    )).rows[0].count), 0);
    assert.equal(Number((await client.query(
      "SELECT count(*) FROM adjustment_confirmation_accesses_v2",
    )).rows[0].count), 0);
    assert.equal(Number((await client.query(
      "SELECT count(*) FROM adjustment_shadow_terminal_results_v2",
    )).rows[0].count), 1);
  } finally {
    client?.release();
    await owner?.end();
    await admin.end();
    await stopPostgres(server);
  }
});

// preserve qualification while retiring an intentionally unapplied operator-off action
test("operator-off owner operations record nonserving authority and retire the slot", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-owner-operator-off-operations");
  const admin = createTestPool(server);
  let owner;
  let client;
  try {
    await prepareRuntimeRoles(admin);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, resolve(import.meta.dirname, "../migrations"));
    await admin.query("ALTER ROLE weather_owner IN DATABASE weather_test SET weather.adjustment_maintenance_v2_enabled = 'on'");
    const request = maturedAccessRequest();
    await seedMaturedFixture(admin, request);
    client = await owner.connect();
    const burn = await ownerResult(client, buildAdjustmentConfirmationAccessBurnSqlV3(
      request,
      sha256(request),
    ));
    const completedAt = new Date().toISOString();
    const terminalRequest = promotedOperatorOffTerminalRequest(
      request,
      burn.nativeAccess,
      { completedAt },
    );
    const terminalSql = buildAdjustmentShadowTerminalRecordSqlV3(
      terminalRequest,
      sha256(terminalRequest),
      completedAt,
    );
    const terminal = await ownerResult(client, terminalSql);
    assert.equal(terminal.state, "recorded");
    assert.equal(
      terminal.terminalRecord.actionDisposition,
      "promoted_operator_off_unapplied",
    );
    assert.equal(terminal.terminalRecord.actionCompletedAt, completedAt);
    assert.deepEqual(await ownerResult(client, terminalSql), terminal);
    const retirement = {
      contractVersion: "adjustment-shadow-terminal-retirement-request/v3",
      finalizationProof: terminalRequest.finalizationProof,
      registrationSha256: request.shadowRegistration.registrationSha256,
      terminalRecord: terminal.terminalRecord,
      terminalTombstone: {
        contractVersion: "adjustment-shadow-terminal-tombstone/v3",
        reconciliationSha256: terminal.reconciliationSha256,
        registrationSha256: terminal.registrationSha256,
        terminalResultSha256: terminal.terminalRecord.terminalResultSha256,
      },
    };
    const retireSql = buildAdjustmentShadowTerminalRetirementSqlV3(
      retirement,
      sha256(retirement),
    );
    const retired = await ownerResult(client, retireSql);
    assert.equal(retired.state, "retired");
    assert.deepEqual(await ownerResult(client, retireSql), retired);
    assert.equal(Number((await client.query(
      "SELECT count(*) FROM adjustment_shadow_registrations_v2",
    )).rows[0].count), 0);
    assert.equal(Number((await client.query(
      "SELECT count(*) FROM adjustment_confirmation_accesses_v2",
    )).rows[0].count), 0);
    const retained = (await client.query(`SELECT action_disposition
      FROM adjustment_shadow_terminal_results_v2`)).rows;
    assert.deepEqual(retained, [{ action_disposition: "promoted_operator_off_unapplied" }]);
  } finally {
    client?.release();
    await owner?.end();
    await admin.end();
    await stopPostgres(server);
  }
});
