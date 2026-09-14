import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaces, discoverWorkspaces, orderWorkspaces } from "./build-workspaces.mjs";

const workspaces = [
  { name: "@weather/api", path: "apps/api", dependencies: ["@weather/database", "@weather/domain"] },
  { name: "@weather/database", path: "packages/database", dependencies: ["@weather/domain"] },
  { name: "@weather/domain", path: "packages/domain", dependencies: [] },
  { name: "@weather/web", path: "apps/web", dependencies: [] },
];

// preserve a single dependency-ordered compilation
test("workspace build visits every package once after its dependencies", async () => {
  const built = [];

  await buildWorkspaces(workspaces, async (workspace) => {
    built.push(workspace.name);
  });

  assert.deepEqual(built, [
    "@weather/domain",
    "@weather/database",
    "@weather/api",
    "@weather/web",
  ]);
  assert.equal(new Set(built).size, workspaces.length);
});

// stop compilation at the first failure
test("workspace build does not continue after a compiler failure", async () => {
  const built = [];

  await assert.rejects(
    buildWorkspaces(workspaces, async (workspace) => {
      built.push(workspace.name);

      // simulate one failing dependency
      if (workspace.name === "@weather/database") {
        throw new Error("typescript failed");
      }
    }),
    /typescript failed/u,
  );
  assert.deepEqual(built, ["@weather/domain", "@weather/database"]);
});

// reject malformed workspace graphs
test("workspace build rejects cycles, duplicates, and unknown local dependencies", () => {
  assert.throws(
    () => orderWorkspaces([
      { name: "@weather/a", path: "packages/a", dependencies: ["@weather/b"] },
      { name: "@weather/b", path: "packages/b", dependencies: ["@weather/a"] },
    ]),
    /cycle/u,
  );
  assert.throws(
    () => orderWorkspaces([workspaces[0], workspaces[0]]),
    /duplicate/u,
  );
  assert.throws(
    () => orderWorkspaces([{ name: "@weather/a", path: "packages/a", dependencies: ["@weather/missing"] }]),
    /unknown workspace/u,
  );
});

// verify real package metadata still defines the intended graph
test("workspace discovery includes all seven production packages", async () => {
  const discovered = await discoverWorkspaces(new URL("..", import.meta.url));
  const ordered = orderWorkspaces(discovered);

  assert.equal(ordered.length, 7);
  assert.deepEqual(new Set(ordered.map((workspace) => workspace.name)), new Set([
    "@weather/api",
    "@weather/web",
    "@weather/worker",
    "@weather/database",
    "@weather/domain",
    "@weather/forecast-adjustment",
    "@weather/providers",
  ]));
});
