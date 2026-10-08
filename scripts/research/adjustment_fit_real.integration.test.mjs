import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  captureAdjustmentFitRuntimeReadiness,
  hashAdjustmentFitRuntimeReadiness,
} from "./adjustment_fit_sandbox.mjs";
import { runAdjustmentFitWithInput } from "./adjustment_fit_inputs.mjs";
import {
  canonicalSha256,
  parseSanitizedTrainingExportRow,
} from "../../packages/forecast-adjustment/dist/index.js";
import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "../../packages/domain/dist/index.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const NUMERICAL_RUNTIME =
  "/home/ubuntu/.weather/research-runtimes/xgboost-cpu-3.4.1/lib/python3.14/site-packages";
const PYTHON =
  "/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/bin/python3.14";
const STATION_KEYS = Object.freeze([
  "ambient-maxweather",
  "ambient-merlin",
  "ballydidean-ecowitt",
  "netatmo-nearby",
  "tempest-126537",
  "tempest-168853",
  "tempest-201058",
  "tempest-203055",
  "tempest-225947",
  "tempest-38270",
  "tempest-64255",
]);
const WIND_STATION_KEYS = Object.freeze([
  "ambient-merlin",
  "ballydidean-ecowitt",
  "netatmo-nearby",
  "tempest-168853",
  "tempest-64255",
]);
const WIND_LEAD_HOURS = Object.freeze([24, 48, 72, 96, 120, 144, 168]);
const WIND_EXPECTED_PAIRS = Object.freeze([
  "windGustMps:001-024",
  "windGustMps:025-048",
  "windGustMps:073-096",
  "windGustMps:097-120",
  "windGustMps:121-144",
  "windGustMps:145-168",
  "windSpeedMps:001-024",
  "windSpeedMps:025-048",
  "windSpeedMps:049-072",
  "windSpeedMps:073-096",
  "windSpeedMps:097-120",
  "windSpeedMps:121-144",
  "windSpeedMps:145-168",
]);

// format one exact millisecond utc instant
function instant(value) {
  return value.toISOString();
}

// create one opened temperature population with both supported fit arms
async function temperatureInput() {
  const bundle = JSON.parse(await readFile(join(
    REPOSITORY_ROOT,
    "config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json",
  ), "utf8"));

  // create one finite earlier-only phase
  function rows(start, days) {
    const output = [];

    // retain twelve fixed model leads on every local-date sample
    for (let day = 0; day < days; day += 1) {
      const initialized = new Date(start.getTime() + day * 86_400_000);

      // include every operational horizon from one through twelve
      for (let lead = 7; lead <= 18; lead += 1) {
        const valid = new Date(initialized.getTime() + lead * 3_600_000);
        const raw = 10 + Math.sin(day / 30);
        output.push({
          actualTemperatureC: raw - 1,
          cohort: "ecmwf_single_run_hindcast",
          evidenceClass: "development",
          key: `${instant(initialized)}:${lead}`,
          modelCycle: initialized >= new Date("2026-05-12T06:00:00.000Z")
            ? "50r1"
            : "49r1",
          modelLeadHours: lead,
          operationalHorizonHours: lead - 6,
          rawRelativeHumidityPercent: 80,
          rawTemperatureC: raw,
          rawWindSpeedMps: 3,
          runInitializedAt: instant(initialized),
          sourceReceiptAt: instant(new Date(initialized.getTime() + 6 * 3_600_000)),
          state: {
            b24C: null,
            b72C: null,
            cohort: "ecmwf_single_run_hindcast",
            localDates: 0,
            mad72C: null,
            maximumSourceRunInitializedAt: null,
            maximumSourceValidAt: null,
            n24: 0,
            n72: 0,
            sourceKeys: [],
            supported: false,
            targetRunInitializedAt: instant(initialized),
            windowEndValidAt: instant(new Date(initialized.getTime() - 7 * 3_600_000)),
          },
          targetMaxReceiptAt: instant(new Date(valid.getTime() + 7 * 3_600_000)),
          validAt: instant(valid),
        });
      }
    }

    return output;
  }

  return {
    contractVersion: "temperature-maintenance-fit-input/v2",
    developmentRows: rows(new Date("2026-04-01T00:00:00.000Z"), 90),
    incumbentModel: bundle.model,
    month: "2026-10",
    trainingRows: rows(new Date("2025-11-01T00:00:00.000Z"), 120),
  };
}

// load only the public frozen rain feature order with the pinned interpreter
function rainFeatureNames() {
  return JSON.parse(execFileSync(PYTHON, [
    "-c",
    "import json;from rain_wind_features import FEATURE_NAMES;print(json.dumps(list(FEATURE_NAMES)))",
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      BLIS_NUM_THREADS: "1",
      HOME: "/home/sandbox",
      LC_ALL: "C.UTF-8",
      MKL_NUM_THREADS: "1",
      NUMEXPR_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      PATH: "/usr/bin:/bin",
      PYTHONPATH: `${NUMERICAL_RUNTIME}:${join(REPOSITORY_ROOT, "scripts/research")}`,
      PYTHONDONTWRITEBYTECODE: "1",
      TZ: "UTC",
      VECLIB_MAXIMUM_THREADS: "1",
    },
  }));
}

// create the finite supported four-head rain attempt population
function rainInput() {
  const rows = [];
  const start = Date.parse("2025-11-01T00:00:00.000Z");

  // preserve the exact 295-date synthetic support fixture
  for (let day = 0; day < 295; day += 1) {
    // retain eight evenly spaced hours on every date
    for (let hour = 0; hour < 24; hour += 3) {
      const valid = new Date(start + (day * 24 + hour) * 3_600_000);
      rows.push({
        actual: [0, 0.4, 1.5, 3][(hour / 3) % 4],
        evidenceClass: "development",
        features: Array.from({ length: 107 }, () => 1),
        key: instant(valid),
        raw: 0.5,
        rawTargetHourTemperatureC: 10,
        runInitializedAt: instant(new Date(valid.getTime() - 9 * 3_600_000)),
        sourceReceiptAt: instant(new Date(valid.getTime() - 3_600_000)),
        targetMaxReceiptAt: instant(new Date(valid.getTime() + 3_600_000)),
        validAt: instant(valid),
      });
    }
  }

  return {
    contractVersion: "rain-maintenance-fit-input/v2",
    developmentRows: [],
    featureNames: rainFeatureNames(),
    month: "2026-09",
    trainingRows: rows,
  };
}

// add utc dates for synthetic local-calendar manifest identities
function addDays(localDate, days) {
  return new Date(Date.parse(`${localDate}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// hash one deterministic synthetic member identity
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// derive one los angeles local midnight
function localMidnight(localDate) {
  const target = Date.parse(`${localDate}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "America/Los_Angeles",
    year: "numeric",
  });
  let candidate = target;

  // converge to local wall midnight
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Map(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    );
    candidate += target - represented;
  }

  return candidate;
}

// create one source-bound station observation
function windStationRow(stationKey, validAt, speed, gust) {
  const station = FORECAST_OBSERVATION_STATIONS.find(
    (candidate) => candidate.key === stationKey,
  );
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    (candidate) =>
      candidate.physicalStationKey === stationKey &&
      (candidate.acceptedStartInclusive === null ||
        validAt >= candidate.acceptedStartInclusive) &&
      (candidate.acceptedEndExclusive === null ||
        validAt < candidate.acceptedEndExclusive),
  );

  // require the frozen public station lineage
  if (station === undefined || lineage === undefined) {
    throw new Error("wind station fixture identity is unavailable");
  }

  return parseSanitizedTrainingExportRow({
    adapter_contracts: [lineage.adapterContract],
    collision_count: 0,
    content_hashes: [sha256(`station:${stationKey}:${validAt}`)],
    contract_epoch: "physical-station-hourly/v1",
    dataset: null,
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: stationKey,
    provider_family: station.providerFamily,
    received_at: instant(new Date(Date.parse(validAt) + 30 * 60_000)),
    record_kind: "station_hour",
    reference_at: null,
    reference_kind: null,
    relative_humidity_percent: null,
    site_key: "ballydidean",
    source_config_fingerprints: [lineage.checkedFingerprint],
    source_keys: [lineage.sourceKey],
    target_lead_hours: null,
    temperature_c: null,
    upstream_model: null,
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: gust,
    wind_speed_mps: speed,
  });
}

// create one exact served forecast observation
function windForecastRow(validAt, leadHours, speed, gust) {
  return parseSanitizedTrainingExportRow({
    adapter_contracts: ["forecast-daily/v4"],
    collision_count: 0,
    content_hashes: [sha256(`forecast:${validAt}:${leadHours}`)],
    contract_epoch:
      "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
    dataset: "forecast",
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: null,
    provider_family: null,
    received_at: instant(new Date(Date.parse(validAt) + 30 * 60_000)),
    record_kind: "legacy_v4_retrieval_snapshot",
    reference_at: instant(new Date(Date.parse(validAt) - leadHours * 3_600_000)),
    reference_kind: "retrieval_snapshot",
    relative_humidity_percent: null,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    ],
    source_keys: ["open-meteo-forecast-v4"],
    target_lead_hours: leadHours,
    temperature_c: null,
    upstream_model: "best_match",
    valid_at: validAt,
    wind_direction_degrees: null,
    wind_gust_mps: gust,
    wind_speed_mps: speed,
  });
}

// append one immutable manifest member and receipt
function addWindMember(members, openedMembers, input) {
  const memberSha256 = sha256(`wind-member:${input.path}`);
  members.push({
    localDate: input.localDate,
    maxValidAt: input.maxValidAt,
    minValidAt: input.minValidAt,
    path: input.path,
    plaintextBytes: Math.max(1, input.rowCount),
    recordKind: input.recordKind,
    rowCount: input.rowCount,
    sha256: memberSha256,
    sizeBytes: Math.max(1, input.rowCount),
    stationKey: input.stationKey,
  });
  openedMembers.push({
    maximumSourceReceiptAt: "2026-09-22T00:00:00.000Z",
    maximumTargetReceiptAt: "2026-09-22T00:00:00.000Z",
    memberSha256,
  });
}

// create a supported complete 402-date wind fit population
function windInput() {
  const fromLocalDate = "2025-08-16";
  const toLocalDate = addDays(fromLocalDate, 401);
  const members = [];
  const openedMembers = [];
  const rows = [];

  // bind all training rows and every frozen epoch date
  for (let index = 0; index < 402; index += 1) {
    const localDate = addDays(fromLocalDate, index);
    const isTrainingDate = index < 365;
    const trainingInstants = [];
    const localStart = localMidnight(localDate);

    // allocate four distinct observations to each lead band
    if (isTrainingDate) {
      for (let sample = 0; sample < 4; sample += 1) {
        // keep lead-band atoms distinct before forecast deduplication
        for (let leadIndex = 0; leadIndex < WIND_LEAD_HOURS.length; leadIndex += 1) {
          const leadHours = WIND_LEAD_HOURS[leadIndex];
          const slot = sample * WIND_LEAD_HOURS.length + leadIndex;
          const validAt = instant(new Date(localStart + slot * 30 * 60_000));
          const actualSpeed = 4 + (index % 29) / 29 + slot / 100;
          const actualGust = actualSpeed + 3;
          trainingInstants.push(validAt);

          // retain five independent physical stations at the same target instant
          for (const stationKey of WIND_STATION_KEYS) {
            rows.push(windStationRow(stationKey, validAt, actualSpeed, actualGust));
          }

          rows.push(windForecastRow(
            validAt,
            leadHours,
            actualSpeed + 1.5 + leadIndex / 20,
            leadHours === 72 ? null : actualGust + 2 + leadIndex / 20,
          ));
        }
      }
    } else {
      const validAt = `${localDate}T12:00:00.000Z`;
      rows.push(windForecastRow(validAt, 24, 7, 10));
    }

    const minimum = trainingInstants[0] ?? `${localDate}T12:00:00.000Z`;
    const maximum = trainingInstants.at(-1) ?? minimum;
    const forecastRows = isTrainingDate ? 28 : 1;
    addWindMember(members, openedMembers, {
      localDate,
      maxValidAt: maximum,
      minValidAt: minimum,
      path: `members/${localDate}/legacy-v4-retrieval/open-meteo.jsonl.gz`,
      recordKind: "legacy-v4-retrieval",
      rowCount: forecastRows,
      stationKey: null,
    });

    // describe each populated station member exactly once per date
    if (isTrainingDate) {
      for (const stationKey of WIND_STATION_KEYS) {
        addWindMember(members, openedMembers, {
          localDate,
          maxValidAt: maximum,
          minValidAt: minimum,
          path: `members/${localDate}/station-hour/${stationKey}.jsonl.gz`,
          recordKind: "station-hour",
          rowCount: 28,
          stationKey,
        });
      }
    }
  }

  members.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    aggregationContractSha256:
      "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
    contractVersion: "forecast-training-export-package/v1",
    coordinateManifestSha256:
      "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
    createdAtUtc: "2026-09-23T00:00:00.000Z",
    databaseManifest: {
      migration_checksums: ["a".repeat(64)],
      migration_names: ["0010_forecast_training_export.sql"],
      query_contract_version: "forecast-training-export-query/v2",
      schema_migration: "0010_forecast_training_export.sql",
    },
    fromLocalDate,
    limits: {
      conservativeExportRowFormula: "450 * ((24 * 264) + (11 * 24) + 168)",
      conservativeExportRows: 3_045_600,
      exportRowHeadroom: 954_400,
      maxDays: 450,
      maxRows: 4_000_000,
      rowCountMeaning: "export_rows_not_training_events",
    },
    members,
    metricEligibilitySha256:
      "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
    migrationHistorySha256: "b".repeat(64),
    observedSourceIdentities: [],
    queryContractSha256:
      "3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76",
    queryContractVersion: "forecast-training-export-query/v2",
    rowSchemaSha256:
      "2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc",
    siteKey: "ballydidean",
    siteTimezone: "America/Los_Angeles",
    sourceIdentities: [],
    sourceLineageSha256:
      "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
    spatialWeightsSha256:
      "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
    stationManifestSha256:
      "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
    stationMetricCoverage: STATION_KEYS.map((stationKey) => ({
      eligibleMetricNonNullLocalDates: {
        relative_humidity_percent: 0,
        temperature_c: 0,
        wind_direction_degrees: 0,
        wind_gust_mps: WIND_STATION_KEYS.includes(stationKey) ? 365 : 0,
        wind_speed_mps: WIND_STATION_KEYS.includes(stationKey) ? 365 : 0,
      },
      stationKey,
    })),
    toLocalDate,
    totalRowCount: members.reduce((sum, member) => sum + member.rowCount, 0),
    transaction: {
      idleInTransactionSessionTimeout: "30s",
      isolationLevel: "repeatable read",
      lockTimeout: "5s",
      readOnly: "on",
      statementTimeout: "15min",
    },
    usageBoundary: {
      databaseImportAllowed: false,
      productionDerived: true,
      snapshotOnly: true,
    },
  };

  return {
    contractVersion: "wind-maintenance-fit-input/v2",
    dueMonth: "2026-10",
    manifest,
    openedMembers,
    rows,
    snapshotManifestSha256: canonicalSha256(manifest),
  };
}

// report one explicit workstation prerequisite gap without runtime substitution
async function missingWorkstationReadiness() {
  const required = [
    "/usr/bin/bwrap",
    "/usr/bin/systemd-run",
    "/usr/bin/systemctl",
    "/home/ubuntu/n/bin/node",
    PYTHON,
    NUMERICAL_RUNTIME,
    `/run/user/${process.getuid()}/bus`,
  ];

  // identify only genuinely absent fixed host prerequisites
  for (const path of required) {
    try {
      await access(path);
    } catch {
      return `pinned workstation readiness absent: ${path}`;
    }
  }

  return null;
}

// exercise actual family entries through installed bwrap and user systemd
test("real fitters run from finite regular-file snapshots", async (context) => {
  const missingReadiness = await missingWorkstationReadiness();

  // keep ci absence explicit without replacing the numerical runtime
  if (missingReadiness !== null) {
    context.skip(missingReadiness);
    return;
  }

  const runtimeReadiness = await captureAdjustmentFitRuntimeReadiness();
  const runtimeReadinessSha256 = hashAdjustmentFitRuntimeReadiness(runtimeReadiness);

  await context.test("temperature fits both supported real arms", async () => {
    const result = await runAdjustmentFitWithInput({
      family: "temperature",
      input: await temperatureInput(),
      runtimeReadiness,
      runtimeReadinessSha256,
    });
    const candidate = JSON.parse(result.candidateJson);
    assert.equal(candidate.contractVersion, "temperature-maintenance-fit/v2");
    assert.equal(candidate.confirmationOpened, false);

    // require both real fit arms and their complete finite support
    for (const arm of ["month_start_expanding", "month_start_trailing365"]) {
      assert.equal(candidate.arms[arm].fitReceipt.trainingRows, 1_440);
      assert.equal(candidate.arms[arm].fitReceipt.trainingDates, 120);
      assert.equal(candidate.arms[arm].developmentRows, 1_080);
      assert.equal(candidate.arms[arm].developmentDates, 90);
      assert.equal(candidate.arms[arm].fallbackCount, 0);
    }
  });

  await context.test("rain completes one real supported four-head attempt", async () => {
    const result = await runAdjustmentFitWithInput({
      family: "rain",
      input: rainInput(),
      runtimeReadiness,
      runtimeReadinessSha256,
    });
    const candidate = JSON.parse(result.candidateJson);
    assert.equal(candidate.contractVersion, "rain-maintenance-fit/v2");
    assert.equal(candidate.confirmationOpened, false);
    assert.equal(candidate.state, "no_candidate");
    assert.equal(candidate.reason, "insufficient_development");
    assert.equal(candidate.fitState.supported, true);
    assert.equal(candidate.fitState.model.rounds, 160);
    assert.equal(Object.keys(candidate.fitState.model.heads).length, 4);
    assert.equal(
      Object.values(candidate.fitState.model.heads)
        .every((head) => head.reason === "fitted"),
      true,
    );
  });

  await context.test("wind fits all thirteen pairs through the real core", async () => {
    const input = windInput();
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    assert.ok(inputBytes < 512 * 1_024 * 1_024);
    assert.equal(input.rows.length, input.manifest.totalRowCount);
    const result = await runAdjustmentFitWithInput({
      family: "wind",
      input,
      runtimeReadiness,
      runtimeReadinessSha256,
    });
    const candidate = JSON.parse(result.candidateJson);
    assert.equal(candidate.contractVersion, "wind-maintenance-fit/v2");
    assert.equal(candidate.confirmationOpened, false);
    assert.equal(candidate.state, "development_candidate");
    assert.deepEqual(
      candidate.candidate.enabledMetricBands
        .map((pair) => `${pair.metric}:${pair.leadBand}`)
        .sort(),
      [...WIND_EXPECTED_PAIRS].sort(),
    );
    assert.equal(candidate.developmentReport.folds.length, 65);
    assert.equal(candidate.developmentReport.folds.every((fold) => fold.passed), true);
    assert.equal(
      candidate.developmentReport.folds.every((fold) =>
        fold.scoreableStationKeys.length === 5 && fold.providerFamilies.length >= 3),
      true,
    );
    assert.ok(candidate.candidate.coefficients.length >= 13);
    assert.equal(
      candidate.candidate.coefficients.every((coefficient) =>
        Number.isFinite(coefficient.coefficient)),
      true,
    );
    assert.equal(
      candidate.candidate.coefficients.some((coefficient) =>
        Math.abs(coefficient.coefficient) > 0),
      true,
    );
    assert.equal(
      candidate.candidate.developmentReportSha256,
      candidate.developmentReport.developmentReportSha256,
    );
    assert.equal(Object.hasOwn(candidate, "qualificationReceipt"), false);
  });
});
