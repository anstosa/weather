import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const MAX_RSS_BYTES = 192 * 1024 * 1024;

// bound native ICU and V8 memory during a realistic retained rain sweep
test("rain adjustment normalizes 264 station windows below 192 MiB peak RSS", {
  skip: process.platform !== "linux",
  timeout: 120_000,
}, async () => {
  const child = new URL("./rain-adjustment-memory-child.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    "--max-old-space-size=128", child.pathname,
  ], { timeout: 110_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.captures, 265);
  assert.equal(result.stationRecords, 15_840);
  assert.equal(result.stationHours, 72);
  assert.equal(result.modelHours, 23);
  assert.ok(result.adjustedHours > 0);
  assert.ok(result.peakRssBytes < MAX_RSS_BYTES,
    `rain inference peak RSS ${result.peakRssBytes} exceeds ${MAX_RSS_BYTES}`);
});
