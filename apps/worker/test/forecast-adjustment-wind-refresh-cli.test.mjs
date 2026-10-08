import assert from "node:assert/strict";
import test from "node:test";
import { parseWindRefreshArguments, parseWindRefreshInput, runWindRefreshCli }
  from "../dist/forecast-adjustment-wind-refresh-cli.js";

// preserve the exact command grammar before touching an input
test("wind monthly fit rejects paths and confirmation options", () => {
  assert.equal(parseWindRefreshArguments(["--fit-only"]), undefined);
  for (const arguments_ of [[], ["--fit-only", "--input", "/tmp/input"], ["--confirm"]]) {
    assert.throws(() => parseWindRefreshArguments(arguments_));
  }
});

// a fitter cannot accept caller-shaped qualification or search authority
test("wind monthly input is closed and bounded", () => {
  const value = { contractVersion: "wind-maintenance-fit-input/v2", manifest: {}, rows: [],
    snapshotManifestSha256: "a".repeat(64), dueMonth: "2026-10", openedMembers: [] };
  assert.equal(parseWindRefreshInput(value).dueMonth, "2026-10");
  assert.throws(() => parseWindRefreshInput({ ...value, qualified: true }));
  assert.throws(() => parseWindRefreshInput({ ...value, rows: null }));
});

// numerical refusal remains a durable non-error attempt rather than a fabricated model
test("wind monthly fit writes honest insufficiency and never qualifies it", async () => {
  let output;
  const result = await runWindRefreshCli(["--fit-only"], {
    readInput: async () => ({ contractVersion: "wind-maintenance-fit-input/v2", manifest: {}, rows: [],
      snapshotManifestSha256: "a".repeat(64), dueMonth: "2026-10", openedMembers: [] }),
    fit: async () => ({ contractVersion: "forecast-adjustment-insufficient-data/v1", failedGates: ["support"],
      reportSha256: "b".repeat(64), snapshotManifestSha256: "a".repeat(64), state: "insufficient_data" }),
    writeOutput: async (bytes) => { output = JSON.parse(bytes); },
  });
  assert.equal(result, 2);
  assert.equal(output.state, "no_candidate");
  assert.equal(output.confirmationOpened, false);
  assert.equal(Object.hasOwn(output, "qualificationReceipt"), false);
});
