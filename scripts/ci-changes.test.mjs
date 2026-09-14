import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommitRange, classifyPaths, parseNameStatus } from "./ci-changes.mjs";

// retain both rename paths and complete status records
test("rename classification includes source and destination", () => {
  assert.deepEqual(
    parseNameStatus(Buffer.from("R100\0docs/old.md\0deploy/new.sh\0")),
    ["docs/old.md", "deploy/new.sh"],
  );
  assert.deepEqual(
    parseNameStatus(Buffer.from("D\0apps/web/src/old.ts\0")),
    ["apps/web/src/old.ts"],
  );
  assert.equal(parseNameStatus(Buffer.from("M\0docs/truncated.md")), null);
});

// unknown inputs cannot narrow coverage
test("unknown statuses and paths fail to full coverage", () => {
  assert.equal(parseNameStatus(Buffer.from("Z\0README.md\0")), null);
  assert.deepEqual(classifyPaths(["new/unknown.txt"]), {
    fullTests: true,
    integration: true,
    deployIntegration: true,
    fullBrowser: true,
  });
});

// documentation still receives mandatory gates
test("documentation retains core smoke without expensive suites", () => {
  assert.deepEqual(classifyPaths(["docs/operations/example.md"]), {
    fullTests: false,
    integration: false,
    deployIntegration: false,
    fullBrowser: false,
  });
});

// UI changes keep browser coverage without unrelated rehearsals
test("UI changes keep fast units and integration defaults but require full browser", () => {
  assert.deepEqual(classifyPaths(["apps/web/src/index.ts", "apps/web/src/styles.css"]), {
    fullTests: false,
    integration: false,
    deployIntegration: false,
    fullBrowser: true,
  });
});

// transitive boundaries select their dependent suites
test("UI, model, backend, and deployment changes select dependent suites", () => {
  assert.equal(classifyPaths(["apps/web/src/styles.css"]).fullBrowser, true);
  assert.equal(classifyPaths(["scripts/research/rain_fit.py"]).fullTests, true);
  assert.equal(classifyPaths(["packages/forecast-adjustment/src/main.ts"]).integration, true);
  assert.equal(classifyPaths(["apps/api/src/main.ts"]).integration, true);
  assert.equal(classifyPaths(["packages/domain/src/main.ts"]).deployIntegration, true);
  assert.equal(classifyPaths(["packages/database/migrations/0017.sql"]).deployIntegration, true);
  assert.equal(classifyPaths(["packages/providers/src/index.ts"]).deployIntegration, true);
  assert.equal(classifyPaths(["apps/worker/src/index.ts"]).fullTests, true);
  assert.equal(classifyPaths(["deploy/compose.yaml"]).deployIntegration, true);
  assert.equal(classifyPaths([".github/workflows/check.yml"]).deployIntegration, true);
  assert.equal(classifyPaths(["package-lock.json"]).deployIntegration, true);
});

// untrusted ancestry must replay all gates
test("missing or failed baseline Check forces full inherited coverage", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  assert.deepEqual(classifyCommitRange("push", base, head, false), {
    fullTests: true,
    integration: true,
    deployIntegration: true,
    fullBrowser: true,
  });
  assert.deepEqual(classifyCommitRange("push", base, head, true), {
    fullTests: true,
    integration: true,
    deployIntegration: true,
    fullBrowser: true,
  });
  assert.deepEqual(classifyCommitRange("schedule", "", ""), {
    fullTests: true,
    integration: true,
    deployIntegration: true,
    fullBrowser: true,
  });
  assert.deepEqual(classifyCommitRange("workflow_dispatch", "", ""), {
    fullTests: true,
    integration: true,
    deployIntegration: true,
    fullBrowser: true,
  });
});
