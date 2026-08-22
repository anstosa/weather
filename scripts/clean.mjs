import { readdir, rm } from "node:fs/promises";

const workspaceParents = [
  new URL("../apps/", import.meta.url),
  new URL("../packages/", import.meta.url),
];

// clean workspace groups
for (const workspaceParent of workspaceParents) {
  const entries = await readdir(workspaceParent, { withFileTypes: true });

  // clean workspace outputs
  for (const entry of entries) {
    // skip non-workspaces
    if (!entry.isDirectory()) {
      continue;
    }

    await rm(new URL(`${entry.name}/dist/`, workspaceParent), {
      force: true,
      recursive: true,
    });
  }
}

console.log("Removed workspace build output.");
