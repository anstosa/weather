import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const shaPattern = /^[a-f0-9]{40}$/u;
const full = Object.freeze({
  fullTests: true,
  integration: true,
  deployIntegration: true,
  fullBrowser: true,
});

// retain both paths for copies and renames, including deleted sources
export function parseNameStatus(buffer) {
  // truncated records cannot narrow validation
  if (buffer.length > 0 && buffer.at(-1) !== 0) {
    return null;
  }
  const fields = buffer.toString("utf8").split("\0");
  fields.pop();
  const paths = [];

  // consume one status record at a time
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const count = /^[RC][0-9]+$/u.test(status) ? 2 : /^[AMDT]$/u.test(status) ? 1 : 0;

    // reject unsupported records instead of losing changed paths
    if (count === 0 || index + count > fields.length) {
      return null;
    }

    // include source and destination identities
    for (let position = 0; position < count; position++) {
      const path = fields[index++];

      // reject malformed or absolute path records
      if (!path || path.startsWith("/") || path.includes("\\")) {
        return null;
      }
      paths.push(path);
    }
  }

  return paths;
}

// select conservative dependent suites for every changed path
export function classifyPaths(paths) {
  // no baseline is not evidence for a scoped run
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ...full };
  }

  const result = {
    fullTests: false,
    integration: false,
    deployIntegration: false,
    fullBrowser: false,
  };

  // apply the broadest matching dependency boundary
  for (const path of paths) {
    // deployment and shared contracts can affect every target
    if (
      path === "Dockerfile" ||
      path === "package.json" ||
      path === "package-lock.json" ||
      path === ".nvmrc" ||
      path === "tsconfig.base.json" ||
      path.startsWith("deploy/") ||
      path.startsWith(".github/") ||
      path.startsWith("config/") ||
      path.startsWith("packages/domain/") ||
      path.startsWith("packages/database/") ||
      path.startsWith("packages/providers/") ||
      /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)
    ) {
      return { ...full };
    }

    // model code also affects serving integrations
    if (path.startsWith("packages/forecast-adjustment/")) {
      result.fullTests = true;
      result.integration = true;
      continue;
    }

    // model research is exercised by the complete unit suite
    if (path.startsWith("scripts/research/")) {
      result.fullTests = true;
      continue;
    }

    // UI changes need the complete rendered browser suite
    if (path.startsWith("apps/web/")) {
      result.fullBrowser = true;
      continue;
    }

    // storage, provider, worker and API changes need real PostgreSQL
    if (path.startsWith("apps/worker/")) {
      result.fullTests = true;
      result.integration = true;
      continue;
    }

    // API changes retain real database coverage
    if (path.startsWith("apps/api/")) {
      result.integration = true;
      continue;
    }

    // documentation-only paths keep mandatory baseline gates
    if (
      path === "README.md" ||
      path === ".editorconfig" ||
      path === ".gitignore" ||
      path.startsWith("docs/")
    ) {
      continue;
    }

    // any new or unclassified path gets full coverage
    return { ...full };
  }

  return result;
}

// resolve only a proven commit range, otherwise run all gates
export function classifyCommitRange(event, base, head, baselineVerified = false) {
  // scheduled and manual runs are complete rehearsals
  if (event === "schedule" || event === "workflow_dispatch") {
    return { ...full };
  }

  // unknown event or missing baseline cannot narrow validation
  if (
    !["push", "pull_request"].includes(event) ||
    !shaPattern.test(base ?? "") ||
    !shaPattern.test(head ?? "") ||
    /^0+$/u.test(base) ||
    !baselineVerified
  ) {
    return { ...full };
  }

  try {
    const compareBase = event === "pull_request"
      ? execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim()
      : base;

    // push baselines must precede the checked commit
    execFileSync("git", ["merge-base", "--is-ancestor", compareBase, head]);
    const names = execFileSync(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", compareBase, head],
      { encoding: "buffer" },
    );
    return classifyPaths(parseNameStatus(names));
  } catch {
    // shallow checkout and vanished commits must not skip tests
    return { ...full };
  }
}

// expose stable booleans to the workflow without test-runner dependencies
function main() {
  const result = classifyCommitRange(
    process.env.CI_EVENT,
    process.env.CI_BASE_SHA,
    process.env.CI_HEAD_SHA,
    process.env.CI_BASE_VERIFIED === "true",
  );
  const lines = [
    `full_tests=${result.fullTests}`,
    `integration=${result.integration}`,
    `deploy_integration=${result.deployIntegration}`,
    `full_browser=${result.fullBrowser}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  // publish exact classifications only through the Actions output file
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

// avoid side effects when unit tests import the classifier
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
