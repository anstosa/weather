import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");

// read the declared local workspaces without adding a package dependency
export async function discoverWorkspaces(root) {
  const directory = root instanceof URL ? fileURLToPath(root) : root;
  const workspaces = [];

  // inspect both workspace parent directories
  for (const parent of ["apps", "packages"]) {
    const entries = await readdir(join(directory, parent), { withFileTypes: true });

    // load each package manifest once
    for (const entry of entries) {
      // ignore non-workspace files
      if (!entry.isDirectory()) {
        continue;
      }

      const path = join(parent, entry.name);
      const manifest = JSON.parse(await readFile(join(directory, path, "package.json"), "utf8"));
      workspaces.push({
        dependencies: Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@weather/")),
        name: manifest.name,
        path,
      });
    }
  }

  return workspaces;
}

// sort the package graph before invoking any compiler
export function orderWorkspaces(workspaces) {
  const packages = new Map();

  // reject ambiguous workspace names
  for (const workspace of workspaces) {
    // stop before compiling a duplicate
    if (packages.has(workspace.name)) {
      throw new Error(`duplicate workspace ${workspace.name}`);
    }

    packages.set(workspace.name, workspace);
  }

  const ordered = [];
  const visiting = new Set();
  const completed = new Set();

  // visit dependencies before their consumer
  function visit(name) {
    // reject a dependency cycle
    if (visiting.has(name)) {
      throw new Error(`workspace dependency cycle at ${name}`);
    }

    // skip an already ordered workspace
    if (completed.has(name)) {
      return;
    }

    const workspace = packages.get(name);

    // reject a missing local package
    if (workspace === undefined) {
      throw new Error(`unknown workspace ${name}`);
    }

    visiting.add(name);

    // sort dependencies to keep the build stable
    for (const dependency of [...workspace.dependencies].sort()) {
      visit(dependency);
    }

    visiting.delete(name);
    completed.add(name);
    ordered.push(workspace);
  }

  // visit every workspace exactly once
  for (const name of [...packages.keys()].sort()) {
    visit(name);
  }

  return ordered;
}

// execute one compiler command per ordered workspace
export async function buildWorkspaces(workspaces, runWorkspace) {
  const ordered = orderWorkspaces(workspaces);

  // fail before attempting a downstream compilation
  for (const workspace of ordered) {
    await runWorkspace(workspace);
  }
}

// compile declarations and JavaScript in the same typechecked pass
function compileWorkspace(workspace) {
  const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [compiler, "-p", join(workspace.path, "tsconfig.json")], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  // preserve compiler failure as the build result
  if (result.error !== undefined) {
    throw result.error;
  }

  // stop on a nonzero exit or termination signal
  if (result.status !== 0) {
    throw new Error(`build failed for ${workspace.name}: ${result.signal ?? result.status}`);
  }
}

// run only when invoked as the root build command
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorkspaces(await discoverWorkspaces(repositoryRoot), compileWorkspace);
}
