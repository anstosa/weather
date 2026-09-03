import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { MODEL_EVIDENCE_ROOT } from "@weather/forecast-adjustment";

import {
  parseForecastAdjustmentEvaluateRetainedArguments,
  runForecastAdjustmentEvaluateRetainedCli,
} from "../dist/forecast-adjustment-evaluate-retained-cli.js";

const snapshotSha256 = "a".repeat(64);

// verify the single content-addressed input
test("retained evaluation accepts exactly one lowercase snapshot digest", () => {
  assert.deepEqual(
    parseForecastAdjustmentEvaluateRetainedArguments([
      "--snapshot-sha256",
      snapshotSha256,
    ]),
    { snapshotSha256 },
  );

  assert.throws(
    () => parseForecastAdjustmentEvaluateRetainedArguments([]),
    /requires exactly --snapshot-sha256/u,
  );
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateRetainedArguments([
        "--snapshot-sha256",
        snapshotSha256.toUpperCase(),
      ]),
    /lowercase SHA-256/u,
  );
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateRetainedArguments([
        "--snapshot-sha256",
        snapshotSha256,
        "--output",
        "/tmp/result",
      ]),
    /requires exactly --snapshot-sha256/u,
  );
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateRetainedArguments([
        "--snapshot",
        snapshotSha256,
      ]),
    /requires exactly --snapshot-sha256/u,
  );
});

// verify promoted evaluation authority and output
test("retained evaluation uses the fixed evidence root once and exits zero after promotion", async () => {
  const calls = [];
  const outputs = [];

  assert.equal(
    await runForecastAdjustmentEvaluateRetainedCli(
      ["--snapshot-sha256", snapshotSha256],
      {
        // capture the fixed evaluator input
        evaluateSnapshot: async (input) => {
          calls.push(input);
          return {
            state: "promoted",
            qualificationReceiptSha256: "c".repeat(64),
            evaluationReportSha256: "b".repeat(64),
            contractVersion: "forecast-adjustment-evidence-result/v1",
            candidateArtifactSha256: "d".repeat(64),
            accessTrace: ["evidence_promoted"],
          };
        },
        // capture deterministic output
        writeOutput: (value) => outputs.push(value),
      },
    ),
    0,
  );

  assert.deepEqual(calls, [
    {
      evidenceRoot: MODEL_EVIDENCE_ROOT,
      snapshotPath: join(
        MODEL_EVIDENCE_ROOT,
        "snapshots",
        snapshotSha256,
      ),
    },
  ]);
  assert.deepEqual(outputs, [
    `{"accessTrace":["evidence_promoted"],"candidateArtifactSha256":"${"d".repeat(64)}","contractVersion":"forecast-adjustment-evidence-result/v1","evaluationReportSha256":"${"b".repeat(64)}","qualificationReceiptSha256":"${"c".repeat(64)}","state":"promoted"}\n`,
  ]);
});

// verify deterministic insufficiency status
test("retained evaluation exits two for insufficient data", async () => {
  const calls = [];
  const outputs = [];

  assert.equal(
    await runForecastAdjustmentEvaluateRetainedCli(
      ["--snapshot-sha256", snapshotSha256],
      {
        // return one sanitized insufficiency report
        evaluateSnapshot: async (input) => {
          calls.push(input);
          return {
            state: "insufficient_data",
            failedGates: ["network_330_local_dates"],
            exitCode: 2,
          };
        },
        // capture deterministic output
        writeOutput: (value) => outputs.push(value),
      },
    ),
    2,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(outputs, [
    '{"exitCode":2,"failedGates":["network_330_local_dates"],"state":"insufficient_data"}\n',
  ]);
});

// reject undocumented evaluator states before output
test("retained evaluation rejects malformed states before output", async () => {
  const outputs = [];

  await assert.rejects(
    runForecastAdjustmentEvaluateRetainedCli(
      ["--snapshot-sha256", snapshotSha256],
      {
        // return one unsupported evaluator state
        evaluateSnapshot: async () => ({ state: "verified" }),
        // capture premature output
        writeOutput: (value) => outputs.push(value),
      },
    ),
    /invalid state/u,
  );
  assert.deepEqual(outputs, []);
});
