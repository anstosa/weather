import { readFile } from "node:fs/promises";

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
const raw = await readFile(0, "utf8");
const document = JSON.parse(raw);

// require a credential-free repository name
if (!/^[a-z0-9][a-z0-9._/:=-]*$/u.test(repository)) {
  throw new Error("image reference contains an invalid repository");
}

// require an explicit platform index
if (!Array.isArray(document.manifests)) {
  throw new Error("image manifest does not expose an ARM64 platform index");
}

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

process.stdout.write(`${repository}@${arm64[0].digest}\n`);
