import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalizeJson } from "@weather/domain";

import {
  parseForecastAdjustmentBundleArguments,
  runForecastAdjustmentBundleCli,
} from "../dist/forecast-adjustment-bundle-cli.js";
import {
  parseForecastAdjustmentEvaluateArguments,
  runForecastAdjustmentEvaluateCli,
} from "../dist/forecast-adjustment-evaluate-cli.js";
import {
  parseForecastAdjustmentEvidenceArguments,
  runForecastAdjustmentEvidenceCli,
} from "../dist/forecast-adjustment-evidence-cli.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const repositoryRoot = "/tmp/weather-cli-fixture";
const execFileAsync = promisify(execFile);
const evaluateEntrypoint = fileURLToPath(
  new URL("../dist/forecast-adjustment-evaluate-cli.js", import.meta.url),
);
const stationKeys = [
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
];

// hash exact fixture bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// publish one canonical insufficient snapshot
async function createInsufficientSnapshot(root) {
  const memberBytes = Buffer.from("member bytes are never parsed\n", "utf8");
  const memberPath =
    "members/2026-08-01/station-hour/ballydidean-ecowitt.jsonl.gz";
  const manifest = {
    aggregationContractSha256:
      "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
    contractVersion: "forecast-training-export-package/v1",
    coordinateManifestSha256:
      "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
    createdAtUtc: "2026-08-02T00:00:00.000Z",
    databaseManifest: {
      migration_checksums: ["d".repeat(64)],
      migration_names: ["0010_forecast_training_export.sql"],
      query_contract_version: "forecast-training-export-query/v2",
      schema_migration: "0010_forecast_training_export.sql",
    },
    fromLocalDate: "2026-08-01",
    limits: {
      conservativeExportRowFormula: "450 * ((24 * 264) + (11 * 24) + 168)",
      conservativeExportRows: 3_045_600,
      exportRowHeadroom: 954_400,
      maxDays: 450,
      maxRows: 4_000_000,
      rowCountMeaning: "export_rows_not_training_events",
    },
    members: [
      {
        localDate: "2026-08-01",
        maxValidAt: "2026-08-01T00:00:00.000Z",
        minValidAt: "2026-08-01T00:00:00.000Z",
        path: memberPath,
        plaintextBytes: 100,
        recordKind: "station-hour",
        rowCount: 1,
        sha256: sha256(memberBytes),
        sizeBytes: memberBytes.byteLength,
        stationKey: "ballydidean-ecowitt",
      },
    ],
    metricEligibilitySha256:
      "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
    migrationHistorySha256: "e".repeat(64),
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
    stationMetricCoverage: stationKeys.map(
      // cover every frozen station with zero eligible dates
      (stationKey) => ({
        eligibleMetricNonNullLocalDates: {
          relative_humidity_percent: 0,
          temperature_c: 0,
          wind_direction_degrees: 0,
          wind_gust_mps: 0,
          wind_speed_mps: 0,
        },
        stationKey,
      }),
    ),
    stationManifestSha256:
      "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
    toLocalDate: "2026-08-01",
    totalRowCount: 1,
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
  const manifestBytes = `${canonicalizeJson(manifest)}\n`;
  const manifestSha256 = sha256(manifestBytes);
  const snapshot = join(root, ".weather-data", manifestSha256);
  await mkdir(join(snapshot, "members/2026-08-01/station-hour"), {
    recursive: true,
  });
  await writeFile(join(snapshot, memberPath), memberBytes);
  await writeFile(join(snapshot, "manifest.json"), manifestBytes);
  await writeFile(
    join(snapshot, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
  );
  return { manifestSha256, memberPath, snapshot };
}

// verify fixed ignored-path parsing
test("evaluation accepts only ignored file-package paths", () => {
  assert.deepEqual(
    parseForecastAdjustmentEvaluateArguments(
      [
        "--snapshot",
        `.weather-data/${hashA}`,
        "--output",
        ".weather-models/evaluation-001",
      ],
      repositoryRoot,
    ),
    {
      outputPath: join(repositoryRoot, ".weather-models/evaluation-001"),
      snapshotPath: join(repositoryRoot, `.weather-data/${hashA}`),
    },
  );

  // reject database URL input
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateArguments(
        [
          "--snapshot",
          "postgresql://production/weather",
          "--output",
          ".weather-models/run",
        ],
        repositoryRoot,
      ),
    /snapshot must be one valid child/u,
  );
  // reject output traversal
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateArguments(
        ["--snapshot", `.weather-data/${hashA}`, "--output", "../report"],
        repositoryRoot,
      ),
    /output must be one valid child/u,
  );
  // reserve bundle staging
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateArguments(
        [
          "--snapshot",
          `.weather-data/${hashA}`,
          "--output",
          ".weather-models/bundle-staging",
        ],
        repositoryRoot,
      ),
    /must not use bundle staging/u,
  );
  // reject database options
  assert.throws(
    () =>
      parseForecastAdjustmentEvaluateArguments(
        [
          "--database-url",
          "postgresql://localhost/weather",
          "--snapshot",
          `.weather-data/${hashA}`,
          "--output",
          ".weather-models/run",
        ],
        repositoryRoot,
      ),
    /unsupported/u,
  );
});

// verify deterministic evaluation output
test("evaluation forwards only canonical paths and emits stable JSON", async () => {
  const calls = [];
  const outputs = [];
  const arguments_ = [
    "--output",
    ".weather-models/insufficient-run",
    "--snapshot",
    `.weather-data/${hashA}`,
  ];
  const dependencies = {
    // capture exact evaluator inputs
    evaluateSnapshot: async (input) => {
      calls.push(input);
      return {
        exitCode: 2,
        state: "insufficient_data",
        failedGates: ["epoch_402_local_dates"],
        reportSha256: hashB,
      };
    },
    workingDirectory: repositoryRoot,
    // capture stable output bytes
    writeOutput: (value) => outputs.push(value),
  };

  assert.equal(await runForecastAdjustmentEvaluateCli(arguments_, dependencies), 2);
  assert.equal(await runForecastAdjustmentEvaluateCli(arguments_, dependencies), 2);
  assert.deepEqual(calls, [calls[0], calls[0]]);
  assert.equal(outputs[0], outputs[1]);
  assert.equal(
    outputs[0],
    `{"exitCode":2,"failedGates":["epoch_402_local_dates"],"reportSha256":"${hashB}","state":"insufficient_data"}\n`,
  );
});

// reject malformed evaluator statuses before writing output
test("evaluation rejects malformed status results before output", async () => {
  const inheritedExitCode = Object.create({ exitCode: 2 });
  const nonPlainExitCode = Object.assign(new Date(0), { exitCode: 2 });
  const cases = [
    ["null result", null],
    ["array result", [{ exitCode: 2 }]],
    ["missing exit code", {}],
    ["inherited exit code", inheritedExitCode],
    ["non-plain result", nonPlainExitCode],
    ["unsupported exit code", { exitCode: 1 }],
    ["string exit code", { exitCode: "2" }],
  ];

  // verify each malformed result produces no output
  for (const [name, result] of cases) {
    const outputs = [];

    await assert.rejects(
      runForecastAdjustmentEvaluateCli(
        [
          "--output",
          ".weather-models/malformed-run",
          "--snapshot",
          `.weather-data/${hashA}`,
        ],
        {
          // return the malformed boundary value
          evaluateSnapshot: async () => result,
          workingDirectory: repositoryRoot,
          // capture any premature output
          writeOutput: (value) => outputs.push(value),
        },
      ),
      /invalid exit code/u,
      name,
    );
    assert.deepEqual(outputs, [], name);
  }
});

// accept a null-prototype plain result with an own success status
test("evaluation accepts a null-prototype plain status result", async () => {
  const result = Object.assign(Object.create(null), { exitCode: 0 });
  const outputs = [];

  assert.equal(
    await runForecastAdjustmentEvaluateCli(
      [
        "--output",
        ".weather-models/null-prototype-run",
        "--snapshot",
        `.weather-data/${hashA}`,
      ],
      {
        // return one valid plain boundary value
        evaluateSnapshot: async () => result,
        workingDirectory: repositoryRoot,
        // capture stable output
        writeOutput: (value) => outputs.push(value),
      },
    ),
    0,
  );
  assert.deepEqual(outputs, ['{"exitCode":0}\n']);
});

// verify the real evaluator boundary
test("evaluation verifies member hashes before deterministic insufficiency", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-adjustment-cli-"));

  try {
    const fixture = await createInsufficientSnapshot(root);
    const outputs = [];
    const argumentsFor = (outputId) => [
      "--snapshot",
      `.weather-data/${fixture.manifestSha256}`,
      "--output",
      `.weather-models/${outputId}`,
    ];

    // evaluate two independent output directories
    for (const outputId of ["repeat-a", "repeat-b"]) {
      assert.equal(
        await runForecastAdjustmentEvaluateCli(argumentsFor(outputId), {
          workingDirectory: root,
          // capture exact result bytes
          writeOutput: (value) => outputs.push(value),
        }),
        2,
      );
    }

    assert.equal(outputs[0], outputs[1]);
    const result = JSON.parse(outputs[0]);
    assert.equal(result.state, "insufficient_data");
    assert.equal(result.snapshotManifestSha256, fixture.manifestSha256);
    assert.deepEqual(result.failedGates, [
      "epoch_402_local_dates",
      "network_330_local_dates",
    ]);
    assert.deepEqual(result.accessTrace, [
      "manifest_control_opened",
      "manifest_schema_verified",
      "member_metadata_verified",
      `member_hash_verified:${fixture.memberPath}`,
      "insufficient_data_emitted",
    ]);
    assert.equal(
      await readFile(
        join(root, ".weather-models/repeat-a/insufficient-data.json"),
        "utf8",
      ),
      outputs[0],
    );

    await writeFile(join(fixture.snapshot, fixture.memberPath), "tampered\n");
    await assert.rejects(
      runForecastAdjustmentEvaluateCli(argumentsFor("tampered"), {
        workingDirectory: root,
        // discard unavailable success output
        writeOutput: () => undefined,
      }),
      /member checksum or size mismatch/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// verify process errors reveal no caller input
test("evaluation entrypoint returns a bounded error", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      evaluateEntrypoint,
      "--snapshot",
      "postgresql://production.example/weather?password=secret",
      "--output",
      ".weather-models/run",
    ]),
    // inspect the bounded subprocess failure
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "forecast-adjustment evaluation failed\n");
      assert.doesNotMatch(error.stderr, /production|password|secret/iu);
      return true;
    },
  );
});

// verify hash-only evidence operations
test("evidence commands accept only exact content hashes", async () => {
  assert.deepEqual(
    parseForecastAdjustmentEvidenceArguments([
      "promote",
      "--candidate-sha256",
      hashA,
      "--evaluation-sha256",
      hashB,
      "--qualification-sha256",
      hashC,
    ]),
    {
      candidateArtifactSha256: hashA,
      command: "promote",
      evaluationReportSha256: hashB,
      qualificationReceiptSha256: hashC,
    },
  );
  assert.deepEqual(
    parseForecastAdjustmentEvidenceArguments([
      "verify",
      "--qualification-sha256",
      hashC,
    ]),
    { command: "verify", qualificationReceiptSha256: hashC },
  );
  // reject evidence-root overrides
  assert.throws(
    () =>
      parseForecastAdjustmentEvidenceArguments([
        "verify",
        "--evidence-root",
        "/tmp/evidence",
        "--qualification-sha256",
        hashC,
      ]),
    /unsupported/u,
  );
  // reject noncanonical digests
  assert.throws(
    () =>
      parseForecastAdjustmentEvidenceArguments([
        "promote",
        "--candidate-sha256",
        hashA.toUpperCase(),
        "--evaluation-sha256",
        hashB,
        "--qualification-sha256",
        hashC,
      ]),
    /lowercase SHA-256/u,
  );

  const calls = [];
  const outputs = [];
  await runForecastAdjustmentEvidenceCli(
    ["verify", "--qualification-sha256", hashC],
    {
      // capture exact verify identity
      verifyEvidence: async (input) => {
        calls.push(input);
        return { verified: true, qualificationReceiptSha256: hashC };
      },
      // capture stable output bytes
      writeOutput: (value) => outputs.push(value),
    },
  );
  assert.deepEqual(calls, [{ qualificationReceiptSha256: hashC }]);
  assert.equal(
    outputs[0],
    `{"qualificationReceiptSha256":"${hashC}","verified":true}\n`,
  );
});

// verify operator-only bundle staging
test("bundle command stages one exact triple without activation controls", async () => {
  const parsed = parseForecastAdjustmentBundleArguments([
    "--qualification-sha256",
    hashC,
    "--candidate-sha256",
    hashA,
    "--evaluation-sha256",
    hashB,
  ]);
  assert.deepEqual(parsed, {
    candidateArtifactSha256: hashA,
    evaluationReportSha256: hashB,
    qualificationReceiptSha256: hashC,
  });
  // reject activation controls
  assert.throws(
    () =>
      parseForecastAdjustmentBundleArguments([
        "--candidate-sha256",
        hashA,
        "--evaluation-sha256",
        hashB,
        "--qualification-sha256",
        hashC,
        "--registry",
        "config/forecast-adjustments/ballydidean.json",
      ]),
    /unsupported/u,
  );

  const calls = [];
  const outputs = [];
  assert.equal(
    await runForecastAdjustmentBundleCli(
      [
        "--candidate-sha256",
        hashA,
        "--evaluation-sha256",
        hashB,
        "--qualification-sha256",
        hashC,
      ],
      {
        // capture exact staging identity
        stageBundle: async (input) => {
          calls.push(input);
          return {
            outputPath: `.weather-models/bundle-staging/sha256-${hashA}.json`,
            bundleSha256: hashA,
          };
        },
        // capture stable output bytes
        writeOutput: (value) => outputs.push(value),
      },
    ),
    0,
  );
  assert.deepEqual(calls, [parsed]);
  assert.equal(
    outputs[0],
    `{"bundleSha256":"${hashA}","outputPath":".weather-models/bundle-staging/sha256-${hashA}.json"}\n`,
  );
});
