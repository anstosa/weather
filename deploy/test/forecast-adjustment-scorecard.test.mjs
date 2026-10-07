import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
  parseForecastAdjustmentScorecard,
  validateForecastAdjustmentScorecard,
} from "../scripts/forecast-adjustment-scorecard-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// build one complete null-safe common metric
function metric(unit) {
  return {
    adjustedBias: -0.1,
    adjustedMae: 1,
    adjustedP95: 2.5,
    adjustedRmse: 1.25,
    deltaMae: -0.5,
    rawBias: 0.25,
    rawMae: 1.5,
    rawP95: 3,
    rawRmse: 1.75,
    skillInterval95: { lower: 5, upper: 20 },
    skillPercent: 12.5,
    unit,
  };
}

// build one closed aggregate support summary
function support() {
  return {
    dateCount: 60,
    effectiveWeightSum: 60,
    eventCount: 1_000,
    excludedCount: 2,
    exclusionReasons: { missing_target: 2 },
    fallbackCount: 3,
    fallbackReasons: { source_stale: 3 },
    gapCount: 4,
    rowCount: 1_000,
    targetRowCount: 1_000,
    validHourCount: 240,
    vintageCount: 120,
    wetDateCount: 20,
    wetRowCount: 100,
  };
}

// build ten explicit reliability bins including empty bins
function reliability() {
  return Array.from({ length: 10 }, (_value, index) => ({
    count: index === 0 ? 0 : 10,
    meanProbability: index === 0 ? null : (index + 0.5) / 10,
    observedFrequency: index === 0 ? null : index / 10,
  }));
}

// build one sanitized family card
function family(name, unit) {
  return {
    bestMatchDiagnostic: name === "wind"
      ? null
      : {
        bestMatchRawMae: 1.4,
        dateCount: 30,
        rowCount: 500,
        sourceAdjustedMae: 1,
        sourceRawMae: 1.5,
        unit,
      },
    comparisonState: "better",
    evidenceClass: "development",
    evidenceCutoffAt: "2026-10-07T00:00:00.000Z",
    family: name,
    metrics: metric(unit),
    qualificationState: "development_only",
    rainDiagnostics: name === "rain"
      ? {
        accumulations: [6, 12, 23].map((hours) => ({
          adjustedMae: 0.5,
          completeWindows: 10,
          hours,
          rawMae: 0.75,
        })),
        annualBalancedVolumeRatio: 1.1,
        heavyAdjustedMae: 1.1,
        heavyRawMae: 1.4,
        probabilityOrderViolationCount: 0,
        thresholds: [0.1, 1, 2.5].map((thresholdMmPerHour) => ({
          adjustedBrier: 0.1,
          csi: 0.5,
          falseAlarms: 2,
          far: 0.2,
          hits: 8,
          misses: 1,
          pod: 8 / 9,
          rawBrier: 0.2,
          reliability: reliability(),
          thresholdMmPerHour,
        })),
        wetAdjustedMae: 0.6,
        wetRawMae: 0.8,
        winterBalancedVolumeRatio: 1.2,
      }
      : null,
    recommendation: "retain",
    servingIdentitySha256: name.repeat(1).charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
    servingState: "authorized_active",
    slices: [{
      dimension: "horizon",
      label: "001-024",
      metrics: metric(unit),
      rowCount: 250,
    }],
    support: support(),
    supportState: "sufficient",
  };
}

// build one valid aggregate-only scorecard
function scorecard(overrides = {}) {
  return {
    automaticActivationEligible: false,
    contractVersion: "forecast-adjustment-scorecard/v1",
    families: {
      rain: family("rain", "millimeters_per_hour"),
      temperature: family("temperature", "celsius"),
      wind: family("wind", "meters_per_second"),
    },
    generatedAt: "2026-10-07T01:00:00.000Z",
    inputs: {
      adjustmentEvidenceManifestSha256: "a".repeat(64),
      adjustmentEvidenceWatermarkSha256: "b".repeat(64),
      forecastTrainingManifestSha256: "c".repeat(64),
      localDateFrom: "2026-09-01",
      localDateTo: "2026-09-30",
      reportSha256s: {
        rain: "d".repeat(64),
        temperature: "e".repeat(64),
        wind: "f".repeat(64),
      },
      sourceRevision: "1".repeat(40),
      targetCutoffAt: "2026-10-07T00:00:00.000Z",
    },
    operatorApprovalRequired: true,
    servingChanged: false,
    siteKey: "ballydidean",
    validThrough: "2099-10-08T01:00:00.000Z",
    ...overrides,
  };
}

// lock the shared installer and edge validation behavior
test("scorecard validator accepts aggregates and rejects open or activating documents", () => {
  const value = scorecard();
  assert.equal(validateForecastAdjustmentScorecard(value), value);
  assert.deepEqual(parseForecastAdjustmentScorecard(Buffer.from(JSON.stringify(value))), value);

  assert.throws(
    () => validateForecastAdjustmentScorecard({ ...value, servingChanged: true }),
    /servingChanged/u,
  );
  assert.throws(
    () => validateForecastAdjustmentScorecard({ ...value, action: "activate" }),
    /invalid keys/u,
  );
  assert.throws(
    () => validateForecastAdjustmentScorecard({
      ...value,
      families: {
        ...value.families,
        wind: {
          ...value.families.wind,
          metrics: { ...value.families.wind.metrics, rawMae: Number.NaN },
        },
      },
    }),
    /rawMae/u,
  );
  assert.throws(
    () => validateForecastAdjustmentScorecard(value, { now: "2100-01-01T00:00:00.000Z" }),
    /stale/u,
  );
  assert.throws(
    () => parseForecastAdjustmentScorecard(Buffer.alloc(
      FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES + 1,
      0x20,
    )),
    /too large/u,
  );
});

// reserve one disposable listener port
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise(
    // wait for the kernel-selected listener
    (resolveWait) => server.once("listening", resolveWait),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  await new Promise(
    // release the temporary listener
    (resolveClose) => server.close(resolveClose),
  );
  assert.notEqual(port, null);
  return port;
}

// wait for the edge listener without extending the test indefinitely
async function waitForServer(origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(origin);

      if (response.status > 0) {
        return;
      }
    } catch {
      await new Promise(
        // wait briefly between connection attempts
        (resolveWait) => setTimeout(resolveWait, 20),
      );
    }
  }
  throw new Error("edge server did not start");
}

// prove authenticated queryless GET and HEAD over the fixed hash pointer
test("admin scorecard route is authenticated, queryless, read-only and fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-scorecard-route-"));
  const evidenceRoot = join(root, "evidence");
  const bootstrapPath = join(root, "bootstrap-token");
  const authPath = join(root, "admin-auth.json");
  const layoutPath = join(root, "property-sensor-layout.json");
  const port = await unusedPort();
  const value = scorecard();
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(evidenceRoot, "scorecards"), { mode: 0o700, recursive: true });
  await writeFile(join(evidenceRoot, "scorecards", `sha256-${hash}.json`), bytes, { mode: 0o600 });
  await writeFile(join(evidenceRoot, "current.json"), `${JSON.stringify({ sha256: hash })}\n`, { mode: 0o600 });
  await writeFile(bootstrapPath, "test-admin-bootstrap-token-with-32-bytes", { mode: 0o600 });

  const edge = spawn(process.execPath, [join(repoRoot, "deploy/scripts/web-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WEATHER_ADJUSTMENT_EVIDENCE_ROOT: evidenceRoot,
      WEATHER_ADMIN_AUTH_PATH: authPath,
      WEATHER_ADMIN_BOOTSTRAP_TOKEN_PATH: bootstrapPath,
      WEATHER_API_ORIGIN: "http://127.0.0.1:9",
      WEATHER_PROPERTY_SENSOR_LAYOUT_PATH: layoutPath,
      WEATHER_RELEASE: "2026.10.07-1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = [];
  edge.stderr.on(
    "data",
    // retain startup diagnostics for one failed assertion
    (chunk) => diagnostics.push(String(chunk)),
  );

  try {
    await waitForServer(`http://127.0.0.1:${String(port)}/`);
    const endpoint = `http://127.0.0.1:${String(port)}/api/v1/admin/sites/ballydidean/forecast-adjustment-scorecard`;
    assert.equal((await fetch(endpoint)).status, 401);

    const bootstrap = await fetch(`http://127.0.0.1:${String(port)}/api/v1/admin/bootstrap`, {
      body: JSON.stringify({ password: "test-admin-password" }),
      headers: {
        "content-type": "application/json",
        "x-weather-admin-bootstrap": "test-admin-bootstrap-token-with-32-bytes",
      },
      method: "POST",
    });
    assert.equal(bootstrap.status, 201);
    const login = await fetch(`http://127.0.0.1:${String(port)}/admin/login`, {
      body: new URLSearchParams({ password: "test-admin-password", username: "admin" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.notEqual(cookie, "");

    const response = await fetch(endpoint, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: value });

    // reject even an empty caller-controlled query delimiter
    assert.equal((await fetch(`${endpoint}?`, { headers: { cookie } })).status, 400);
    const head = await fetch(endpoint, { headers: { cookie }, method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${endpoint}?sha256=${hash}`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(endpoint, { headers: { cookie }, method: "POST" })).status, 405);

    await writeFile(join(evidenceRoot, "current.json"), '{"sha256":"invalid"}\n');
    const corrupt = await fetch(endpoint, { headers: { cookie } });
    assert.equal(corrupt.status, 503);
    assert.equal(await corrupt.text(), "scorecard unavailable\n");
  } catch (error) {
    error.message += `\nedge diagnostics:\n${diagnostics.join("")}`;
    throw error;
  } finally {
    // wait only when the child is still running
    if (edge.exitCode === null && edge.signalCode === null) {
      edge.kill("SIGTERM");
      await new Promise(
        // wait for child cleanup before removing its state
        (resolveExit) => edge.once("exit", resolveExit),
      );
    }
    await rm(root, { force: true, recursive: true });
  }
});
