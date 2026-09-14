import assert from "node:assert/strict";
import test from "node:test";

// preserve timezone acceptance without retaining repeated native ICU allocations
test("timezone validation bounds repeated formatter allocation and rejects invalid input", async (context) => {
  const { validateTimeZone } = await import("../dist/weather-record.js?timezone-memory-regression");
  const Original = Intl.DateTimeFormat;
  let calls = 0;
  // count native constructors without substituting timezone acceptance rules
  context.mock.method(Intl, "DateTimeFormat", function (...arguments_) {
    calls += 1;
    return new Original(...arguments_);
  });
  const zone = "America/Los_Angeles";
  // repeat the per-record validation performed by captured station batches
  for (let index = 0; index < 100; index += 1) {
    assert.equal(validateTimeZone(zone), zone);
  }
  assert.equal(calls, 1);
  assert.throws(() => validateTimeZone("Mars/Olympus"), /unsupported IANA timezone/u);
  assert.throws(() => validateTimeZone("Mars/Olympus"), /unsupported IANA timezone/u);
  assert.equal(calls, 3);
  assert.throws(() => validateTimeZone(""), /non-empty and bounded/u);
  assert.throws(() => validateTimeZone("a".repeat(65)), /non-empty and bounded/u);
  assert.equal(calls, 3);
  const otherZones = Intl.supportedValuesOf("timeZone").filter((value) => value !== zone).slice(0, 64);
  // evict only the oldest valid identity at the fixed cache bound
  for (const value of otherZones) {
    assert.equal(validateTimeZone(value), value);
  }
  assert.equal(calls, 67);
  assert.equal(validateTimeZone(zone), zone);
  assert.equal(calls, 68);
  assert.equal(validateTimeZone(zone), zone);
  assert.equal(calls, 68);
});
