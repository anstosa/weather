import assert from "node:assert/strict";
import test from "node:test";

import {
  parseForecastAdjustmentMaintenanceArguments,
  runForecastAdjustmentMaintenanceCli,
} from "../dist/forecast-adjustment-maintenance-cli.js";

// accept only one closed timer mode
test("maintenance arguments accept only daily or monthly", () => {
  assert.equal(parseForecastAdjustmentMaintenanceArguments(["--daily"]), "--daily");
  assert.equal(parseForecastAdjustmentMaintenanceArguments(["--monthly"]), "--monthly");

  // reject every path and caller-controlled variation
  for (const arguments_ of [
    [],
    ["daily"],
    ["--daily", "--monthly"],
    ["--daily", "--root", "/tmp/state"],
    ["/tmp/controller.mjs"],
  ]) {
    assert.throws(
      () => parseForecastAdjustmentMaintenanceArguments(arguments_),
      /requires exactly --daily or --monthly/u,
    );
  }
});

// forward only fixed installed executable and controller paths
test("maintenance wrapper launches the installed controller without a shell", async () => {
  const calls = [];
  const homeDirectory = "/home/weather-test";

  assert.equal(await runForecastAdjustmentMaintenanceCli(["--monthly"], {
    // capture the exact production execution boundary
    execute: async (executable, arguments_) => {
      calls.push({ arguments_, executable });
      return { code: 0, signal: null };
    },
    homeDirectory,
  }), 0);
  assert.deepEqual(calls, [{
    arguments_: [
      "/home/weather-test/.weather/adjustment-maintenance/runner/current/scripts/research/adjustment_maintenance_controller.mjs",
      "--monthly",
    ],
    executable: "/home/weather-test/n/bin/node",
  }]);
});

// surface nonzero and signaled controller failures
test("maintenance wrapper rejects unsuccessful controller exits", async () => {
  // reject each closed child failure form
  for (const result of [
    { code: 1, signal: null },
    { code: null, signal: "SIGTERM" },
  ]) {
    await assert.rejects(
      runForecastAdjustmentMaintenanceCli(["--daily"], {
        // return one failed child status
        execute: async () => result,
        homeDirectory: "/home/weather-test",
      }),
      /controller failed/u,
    );
  }
});
