import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { RAIN_COLLECTION_POLICY } from "@weather/domain";

import {
  appendRainCaptureReceipt,
  claimRainCaptureSlot,
} from "../dist/index.js";

// reject malformed collection evidence before acquiring a database connection
test("rain raw payload and credential boundaries fail closed", async () => {
  const pool = {
    connect() { throw new Error("unexpected database connection"); },
    query() { throw new Error("unexpected database query"); },
  };
  const body = Buffer.from("rain");
  const receipt = {
    startedAt: "2026-09-13T07:00:00.000Z",
    completedAt: "2026-09-13T07:00:01.000Z",
    httpStatus: 200,
    body,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    outcome: "valid",
    errorCode: null,
    parserVersion: RAIN_COLLECTION_POLICY.contractVersion,
    rowCount: 49,
    availableByDecision: true,
    metadata: {},
  };

  // keep release identity explicit and bounded
  await assert.rejects(
    claimRainCaptureSlot(pool, { request: { kind: "forecast", slotKey: "bad",
      runInitializedAt: "2026-09-13T00:00:00.000Z", attempt: 1 }, release: "../../secret" }),
    /release is invalid/u,
  );
  // reject development and nonexistent release dates before DB access
  for (const release of ["development", "2026.02.30-1", "2026.09.13-0"]) {
    await assert.rejects(
      claimRainCaptureSlot(pool, { request: { kind: "forecast", slotKey: "bad",
        runInitializedAt: "2026-09-13T00:00:00.000Z", attempt: 1 }, release }),
      /release is invalid/u,
    );
  }
  // reject tampered bytes before any persistence
  await assert.rejects(appendRainCaptureReceipt(pool, "a".repeat(36),
    { ...receipt, bodySha256: "0".repeat(64) }), /hash mismatch/u);
  // reject oversized raw transport bodies before compression
  await assert.rejects(appendRainCaptureReceipt(pool, "a".repeat(36),
    { ...receipt, body: Buffer.alloc(RAIN_COLLECTION_POLICY.maximumBodyBytes + 1) }), /body exceeds/u);
  // never persist a credential-bearing request URL in metadata
  await assert.rejects(appendRainCaptureReceipt(pool, "a".repeat(36),
    { ...receipt, metadata: { providerUrl: "https://example.test/?api_key=secret" } }), /metadata is unsafe/u);
  // reject unsupported server hints rather than shortening a manual pause
  await assert.rejects(appendRainCaptureReceipt(pool, "a".repeat(36),
    { ...receipt, outcome: "rate_limited", httpStatus: 429, errorCode: "http_429",
      metadata: { retryAfterSeconds: 604_801, retryAfterRequiresManualResume: false } }),
  /retry-after metadata is invalid/u);
  // distinguish null from an exact empty provider body
  await assert.rejects(appendRainCaptureReceipt(pool, "a".repeat(36),
    { ...receipt, body: null }), /hash mismatch/u);
});
