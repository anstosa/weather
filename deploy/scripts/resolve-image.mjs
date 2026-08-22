import { readFileSync } from "node:fs";

// remove a mutable tag or existing digest
function imageRepository(reference) {
  const withoutDigest = reference.split("@", 1)[0] ?? "";
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");

  // strip only a tag after the final slash
  if (lastColon > lastSlash) {
    return withoutDigest.slice(0, lastColon);
  }

  return withoutDigest;
}

const reference = process.argv[2] ?? "";
const repository = imageRepository(reference);
const raw = readFileSync(0, "utf8");
const document = JSON.parse(raw);
let resolvedDigest;

// require a credential-free repository name
if (!/^[a-z0-9][a-z0-9._/:=-]*$/u.test(repository)) {
  throw new Error("image reference contains an invalid repository");
}

// resolve indexed or already pinned platform metadata
if (Array.isArray(document.manifests)) {
  const arm64 = document.manifests.filter(
    // select only runnable linux arm64 manifests
    (manifest) =>
      manifest.platform?.architecture === "arm64" &&
      manifest.platform?.os === "linux",
  );

  // reject missing or ambiguous platform selection
  if (arm64.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(arm64[0]?.digest ?? "")) {
    throw new Error("image index must contain exactly one linux/arm64 manifest");
  }
  resolvedDigest = arm64[0].digest;
} else {
  const pinnedDigest = reference.match(/@(sha256:[a-f0-9]{64})$/u)?.[1];
  const descriptor = document.Descriptor;

  // require exact pinned linux arm64 metadata
  if (
    pinnedDigest === undefined ||
    descriptor?.digest !== pinnedDigest ||
    descriptor.platform?.architecture !== "arm64" ||
    descriptor.platform?.os !== "linux"
  ) {
    throw new Error("pinned image must expose matching linux/arm64 descriptor metadata");
  }
  resolvedDigest = pinnedDigest;
}

process.stdout.write(`${repository}@${resolvedDigest}\n`);
