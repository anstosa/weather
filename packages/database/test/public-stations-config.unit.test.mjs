import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parsePublicStationConfiguration } from "../dist/index.js";

const configurationPath = new URL(
  "../../../config/public-stations/stations.json",
  import.meta.url,
);

test("public-station catalog freezes four provider contracts", async () => {
  const raw = JSON.parse(await readFile(configurationPath, "utf8"));
  const configuration = parsePublicStationConfiguration(raw);

  assert.equal(configuration.providers.length, 4);
  assert.equal(configuration.stations.length, 4);
  assert.deepEqual(
    configuration.stations.map(
      // retain each checked road label
      (station) => station.displayName,
    ),
    [
      "French Rd & Lapis Ln",
      "Maxwelton Rd & Swede Hill Rd",
      "Sills Rd & Twilight Ln",
      "Headlands Way",
    ],
  );
  assert.deepEqual(
    configuration.stations.flatMap((station) =>
      station.sources.map((source) => source.adapter),
    ),
    [
      "ambient-weather",
      "ambient-weather",
      "weather-underground",
      "netatmo",
      "purpleair",
    ],
  );
  assert.equal(
    configuration.stations[0].sources[0].fingerprint.length,
    64,
  );
});

test("public-station catalog rejects material and archive ambiguity", async () => {
  const raw = JSON.parse(await readFile(configurationPath, "utf8"));
  const missingHistory = structuredClone(raw);
  missingHistory.stations[0].sources[0].historyStartDate = null;
  assert.throws(
    () => parsePublicStationConfiguration(missingHistory),
    /historyStartDate is required/u,
  );

  const unexpectedMaterial = structuredClone(raw);
  unexpectedMaterial.stations[0].sources[0].adapterConfig.extra = true;
  assert.throws(
    () => parsePublicStationConfiguration(unexpectedMaterial),
    /unexpected keys/u,
  );
});
