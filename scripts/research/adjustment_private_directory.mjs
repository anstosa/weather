import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SUFFIXES = new Map([
  ["archive", [".weather", "adjustment-maintenance", "v2", "archive-primary", "objects"]],
  ["state", [".weather", "adjustment-maintenance", "v2", "state"]],
]);

// create only fixed owner-private children after proving every existing ancestor
export async function ensureAdjustmentPrivateDirectory(kind) {
  const suffix = SUFFIXES.get(kind);
  // no caller path or permission-repair operation is available
  if (suffix === undefined) {
    throw new RangeError("unknown adjustment directory kind");
  }
  let path = resolve(homedir());
  const home = await lstat(path);
  // a linked, foreign or externally writable home cannot anchor private state
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() ||
      (home.mode & 0o022) !== 0 || await realpath(path) !== path) {
    throw new Error("adjustment home identity refused");
  }
  // inspect each ancestor before any mkdir, never chmod an existing directory
  for (const segment of suffix) {
    const parent = path;
    const heldParent = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await heldParent.stat();
      const current = await lstat(parent);
      // hold the proven parent inode through child creation
      if (opened.dev !== current.dev || opened.ino !== current.ino || await realpath(parent) !== parent) {
        throw new Error("adjustment ancestor identity changed");
      }
      path = join(parent, segment);
      try {
        await mkdir(`/proc/self/fd/${heldParent.fd}/${segment}`, { mode: 0o700 });
      } catch (error) {
        // only an already-existing literal child may be reused
        if (error?.code !== "EEXIST") throw error;
      }
      const metadata = await lstat(path);
      // reject path drift and broad permissions instead of repairing them
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() ||
          (metadata.mode & 0o777) !== 0o700 || await realpath(path) !== path) {
        throw new Error("adjustment private directory refused");
      }
      const after = await lstat(parent);
      // recheck identity before advancing to the next fixed child
      if (after.dev !== opened.dev || after.ino !== opened.ino) {
        throw new Error("adjustment ancestor identity changed");
      }
      await heldParent.sync();
    } finally {
      await heldParent.close();
    }
  }
  return path;
}
