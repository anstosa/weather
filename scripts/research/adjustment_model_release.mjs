import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import { queryCheckState, waitForSuccessfulCheck } from "../await-check.mjs";
import {
  validatePortableRainServingPackageFiles,
  validatePortableRainShadowFiles,
} from "./adjustment_rain_model_package.mjs";
import {
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";

export const ADJUSTMENT_MODEL_ACTION_CONTRACT_VERSION =
  "forecast-adjustment-model-action/v1";
export const ADJUSTMENT_MODEL_PARITY_CONTRACT_VERSION =
  "forecast-adjustment-model-parity/v1";
export const ADJUSTMENT_RAIN_CONTROL_REFERENCE_ACTION_CONTRACT_VERSION =
  "forecast-adjustment-rain-control-reference-action/v1";
export const ADJUSTMENT_RAIN_CONTROL_REFERENCE_REGISTRY_CONTRACT_VERSION =
  "forecast-adjustment-rain-control-reference-registry/v1";
export const ADJUSTMENT_MODEL_PACKAGE_MAXIMUM_BYTES = 8 * 1_024 * 1_024;

const execFile = promisify(nodeExecFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RELEASE_DATE_PATTERN = /^\d{4}\.\d{2}\.\d{2}$/u;
const FAMILIES = new Set(["rain", "temperature", "wind"]);
const PRODUCTION_REPOSITORY_PATH = "/home/ubuntu/weather";
const PRODUCTION_REPOSITORY = Object.freeze({
  full_name: "anstosa/weather",
  id: 1_342_404_160,
});
const PRODUCTION_AGENT_SOCKET = "/run/user/1000/openssh_agent";
const PRODUCTION_GH = "/home/linuxbrew/.linuxbrew/bin/gh";
const MODEL_RELEASE_GIT_ENVIRONMENT = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: "/usr/bin/ssh -o BatchMode=yes -o IdentitiesOnly=yes " +
    "-o IdentityAgent=/run/user/1000/openssh_agent -o StrictHostKeyChecking=yes " +
    "-o UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/home/ubuntu",
  SSH_AUTH_SOCK: PRODUCTION_AGENT_SOCKET,
});
const PACKAGE_KINDS = new Map([
  ["temperature", {
    bundleDirectory: "temperature-canary-bundles",
    registryContract: "forecast-adjustment-temperature-maintenance-registry/v1",
    registryPath: "config/forecast-adjustments/ballydidean-temperature-canary.json",
  }],
  ["wind", {
    bundleDirectory: "wind-canary-bundles",
    registryContract: "forecast-adjustment-wind-maintenance-registry/v1",
    registryPath: "config/forecast-adjustments/ballydidean-wind-canary.json",
  }],
]);
const ACTIVE_PACKAGE_KEYS = [
  "actionSha256",
  "artifactSha256",
  "candidateSha256",
  "path",
];
const ACTION_RULES = new Map([
  ["shadow", { decisions: new Set(["pending"]), reasons: new Set(["development_candidate"]), target: "candidate" }],
  ["promote", { decisions: new Set(["qualified"]), reasons: new Set(["qualified_candidate"]), target: "candidate" }],
  ["rollback_prior", { decisions: new Set(["regressed"]), reasons: new Set(["qualified_prior"]), target: "candidate" }],
  ["raw", { decisions: new Set(["regressed"]), reasons: new Set(["policy_raw"]), target: "raw" }],
  ["compensate_incumbent", { decisions: new Set(["qualified", "regressed"]), reasons: new Set(["failed_promotion"]), target: "compensation_candidate" }],
  ["compensate_raw", { decisions: new Set(["qualified", "regressed"]), reasons: new Set(["invalid_incumbent"]), target: "compensation_raw" }],
  ["compensate_shadow", { decisions: new Set(["pending"]), reasons: new Set(["development_shadow_failure"]), target: "compensation_shadow" }],
]);
const ACTION_KEYS = [
  "actionKind",
  "candidateGraphSha256",
  "candidateSha256",
  "contractVersion",
  "createdAt",
  "expectedSettingsSha256",
  "expectedInstalledReceiptSha256",
  "expectedSourceCommit",
  "expectedSourceRelease",
  "family",
  "fencingToken",
  "fullMemberRootSha256",
  "lifecycleHeadSha256",
  "policyDecision",
  "policyReportSha256",
  "predecessorActionSha256",
  "reason",
  "reportCreatedAt",
  "siteKey",
  "validThrough",
];
const RAIN_CONTROL_REFERENCE_ACTION_KEYS = [
  "actionKind",
  "contractVersion",
  "createdAt",
  "dueMonth",
  "expectedCatalogReceiptSha256",
  "expectedSettingsSha256",
  "expectedSourceCommit",
  "expectedSourceRelease",
  "family",
  "fencingToken",
  "graphManifestSha256",
  "ordinalArtifactSha256",
  "predecessorActionSha256",
  "reason",
  "controlStateSha256",
  "sourceMemberRootSha256",
  "sourceReceiptRootSha256",
  "validThrough",
];
const RAIN_CONTROL_REFERENCE_SELECTOR_PATH =
  "config/forecast-adjustments/ballydidean-rain-control-reference.json";

// create authenticated exact-check and durable-journal production ports
export function createProductionAdjustmentModelReleasePorts(journal) {
  // require the durable journal methods used around remote mutation
  if (journal === null || typeof journal !== "object" ||
    typeof journal.prepareModelRelease !== "function" ||
    typeof journal.prepareCompensatingModelRelease !== "function" ||
    typeof journal.recordModelReleasePair !== "function" ||
    typeof journal.recordModelReleaseTagCollision !== "function") {
    throw new TypeError("model release journal is invalid");
  }
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return {
    // wait only for the exact same-repository push check
    awaitExactCheck: async ({ commitSha }) => await waitForSuccessfulCheck(
      async () => await queryCheckState({
        apiUrl,
        repository: PRODUCTION_REPOSITORY,
        sha: commitSha,
        token: await readProductionGithubToken(),
      }),
    ),
    clock: () => new Date(),
    prepareCompensatingRelease: async (mapping) =>
      await journal.prepareCompensatingModelRelease(mapping),
    prepareRelease: async (mapping) => await journal.prepareModelRelease(mapping),
    recordReleasePair: async (mapping) => await journal.recordModelReleasePair(mapping),
    recordTagCollision: async (collision) =>
      await journal.recordModelReleaseTagCollision(collision),
    verifyEnvironment: async (input) => await verifyProductionModelReleaseEnvironment(input),
  };
}

// load the existing gh credential without depending on a terminal environment secret
async function readProductionGithubToken() {
  const result = await execFile(PRODUCTION_GH, ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8",
    env: {
      GH_PROMPT_DISABLED: "1",
      HOME: "/home/ubuntu",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 4_096,
  });
  const token = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1)
    : result.stdout;

  // reject prompt text, multiple lines and empty credential output
  if (!/^[^\s]{20,255}$/u.test(token)) {
    throw releaseError("exact_check_identity_unavailable");
  }
  return token;
}

// prove the fixed repository and SSH agent before any detached worktree mutation
async function verifyProductionModelReleaseEnvironment(input) {
  requireExactKeys(input, ["repositoryPath", "sourceCommit", "sourceRelease"],
    "production model release environment");
  requireCommit(input.sourceCommit, "sourceCommit");
  requireReleaseTag(input.sourceRelease, "sourceRelease");
  const repositoryPath = resolve(input.repositoryPath);
  const repository = await lstat(repositoryPath);
  const socket = await lstat(PRODUCTION_AGENT_SOCKET);

  // require the reviewed checkout and exact current-user agent socket
  if (repositoryPath !== PRODUCTION_REPOSITORY_PATH ||
    await realpath(repositoryPath) !== repositoryPath || !repository.isDirectory() ||
    repository.isSymbolicLink() || repository.uid !== process.getuid() ||
    await realpath(PRODUCTION_AGENT_SOCKET) !== PRODUCTION_AGENT_SOCKET ||
    !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid()) {
    throw releaseError("model_release_environment_unavailable");
  }
  const keys = await execFile("/usr/bin/ssh-add", ["-L"], {
    encoding: "utf8",
    env: { ...process.env, SSH_AUTH_SOCK: PRODUCTION_AGENT_SOCKET },
    maxBuffer: 64 * 1_024,
  });

  // refuse an empty agent or unexpected command output
  if (!/^ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?\n(?:ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?\n)*$/u
    .test(keys.stdout)) {
    throw releaseError("model_release_environment_unavailable");
  }
  const remote = await gitOutput(repositoryPath, ["remote", "get-url", "origin"]);

  // require the fixed SSH repository instead of ambient credentialed remotes
  if (remote !== "git@github.com:anstosa/weather.git") {
    throw releaseError("model_release_environment_unavailable");
  }
  await git(repositoryPath, [
    "fetch", "--no-tags", "origin", `refs/tags/${input.sourceRelease}`,
  ]);
  const fetched = await gitOutput(repositoryPath, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);

  // bind the fresh public source tag to the action's deployed source commit
  if (fetched !== input.sourceCommit) {
    throw releaseError("deployed_source_commit_mismatch");
  }
}

// build one closed hash-addressed action document
export function buildAdjustmentModelAction(input) {
  requireExactKeys(input, ACTION_KEYS, "model action");
  const action = structuredClone(input);
  const rule = ACTION_RULES.get(action.actionKind);

  // accept only the closed action matrix
  if (action.contractVersion !== ADJUSTMENT_MODEL_ACTION_CONTRACT_VERSION ||
    action.siteKey !== "ballydidean" || rule === undefined ||
    !FAMILIES.has(action.family) || !rule.decisions.has(action.policyDecision) ||
    !rule.reasons.has(action.reason)) {
    throw new TypeError("model action identity is invalid");
  }
  requireNullableSha256(action.candidateGraphSha256, "candidateGraphSha256");
  requireNullableSha256(action.candidateSha256, "candidateSha256");
  requireNullableSha256(
    action.expectedInstalledReceiptSha256,
    "expectedInstalledReceiptSha256",
  );
  requireSha256(action.expectedSettingsSha256, "expectedSettingsSha256");
  requireCommit(action.expectedSourceCommit, "expectedSourceCommit");
  requireReleaseTag(action.expectedSourceRelease, "expectedSourceRelease");
  requireFencingToken(action.fencingToken);
  requireNullableSha256(action.fullMemberRootSha256, "fullMemberRootSha256");
  requireSha256(action.lifecycleHeadSha256, "lifecycleHeadSha256");
  requireSha256(action.policyReportSha256, "policyReportSha256");
  requireNullableSha256(action.predecessorActionSha256, "predecessorActionSha256");
  requireInstant(action.createdAt, "createdAt");
  requireInstant(action.reportCreatedAt, "reportCreatedAt");
  requireInstant(action.validThrough, "validThrough");
  const compensation = rule.target.startsWith("compensation");
  const candidateTarget = rule.target === "candidate" ||
    rule.target === "compensation_candidate" || rule.target === "compensation_shadow";
  const developmentOnly = action.actionKind === "shadow" ||
    action.actionKind === "compensate_shadow";

  // require candidate identity and archive graph as one pair
  if ((action.candidateSha256 === null) !== (action.candidateGraphSha256 === null)) {
    throw new TypeError("model action candidate target is invalid");
  }

  // bind candidate target fields as one non-null pair
  if (candidateTarget !== (action.candidateSha256 !== null &&
    action.candidateGraphSha256 !== null)) {
    throw new TypeError("model action candidate target is invalid");
  }

  // preserve full confirmation evidence for every qualified or regressed action
  if (developmentOnly !== (action.fullMemberRootSha256 === null)) {
    throw new TypeError("model action full member is invalid");
  }

  // require an interrupted predecessor only for compensation
  if (compensation !== (action.predecessorActionSha256 !== null)) {
    throw new TypeError("model action predecessor is invalid");
  }
  const validityMilliseconds = Date.parse(action.validThrough) -
    Date.parse(action.reportCreatedAt);

  // bind action chronology and the fixed report freshness window
  if (Date.parse(action.reportCreatedAt) > Date.parse(action.createdAt) ||
    validityMilliseconds !== 7 * 86_400_000 ||
    (!compensation && Date.parse(action.createdAt) > Date.parse(action.validThrough))) {
    throw new TypeError("model action validity is invalid");
  }
  const bytes = canonicalJsonBytes(action);
  const actionSha256 = adjustmentSha256(bytes);
  return {
    action,
    actionSha256,
    bytes,
    path: `config/forecast-adjustments/ballydidean/actions/sha256-${actionSha256}.json`,
  };
}

// build one custody-only pre-month rain control reference action
export function buildAdjustmentRainControlReferenceAction(input) {
  requireExactKeys(input, RAIN_CONTROL_REFERENCE_ACTION_KEYS, "rain control action");
  const action = structuredClone(input);
  const compensation = action.actionKind === "compensate_control_reference";

  // accept only the disjoint control-reference action matrix
  if (action.contractVersion !== ADJUSTMENT_RAIN_CONTROL_REFERENCE_ACTION_CONTRACT_VERSION ||
    action.family !== "rain" ||
    !["control_reference", "compensate_control_reference"].includes(action.actionKind) ||
    action.reason !== (compensation ? "failed_control_reference" : "premonth_reference") ||
    typeof action.dueMonth !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(action.dueMonth)) {
    throw new TypeError("rain control action identity is invalid");
  }
  requireNullableSha256(action.expectedCatalogReceiptSha256,
    "expectedCatalogReceiptSha256");
  requireSha256(action.expectedSettingsSha256, "expectedSettingsSha256");
  requireCommit(action.expectedSourceCommit, "expectedSourceCommit");
  requireReleaseTag(action.expectedSourceRelease, "expectedSourceRelease");
  requireFencingToken(action.fencingToken);
  requireSha256(action.graphManifestSha256, "graphManifestSha256");
  requireSha256(action.ordinalArtifactSha256, "ordinalArtifactSha256");
  requireNullableSha256(action.predecessorActionSha256, "predecessorActionSha256");
  requireSha256(action.controlStateSha256, "controlStateSha256");
  requireSha256(action.sourceMemberRootSha256, "sourceMemberRootSha256");
  requireSha256(action.sourceReceiptRootSha256, "sourceReceiptRootSha256");
  requireInstant(action.createdAt, "createdAt");
  requireInstant(action.validThrough, "validThrough");
  const monthStart = Date.parse(`${action.dueMonth}-01T00:00:00.000Z`);
  const createdAt = Date.parse(action.createdAt);

  // bind both paired actions to the literal seven-day pre-month window
  if (action.validThrough !== new Date(monthStart).toISOString() ||
    createdAt < monthStart - 7 * 86_400_000 || createdAt >= monthStart ||
    compensation !== (action.predecessorActionSha256 !== null)) {
    throw new TypeError("rain control action chronology is invalid");
  }
  const bytes = canonicalJsonBytes(action);
  const actionSha256 = adjustmentSha256(bytes);
  return {
    action,
    actionSha256,
    bytes,
    path: `config/forecast-adjustments/ballydidean/actions/sha256-${actionSha256}.json`,
  };
}

// package one control reference or its exact prepared baseline compensation
export function packageAdjustmentRainControlReference(input) {
  requireExactKeys(input, [
    "action", "baselineSelectorBytes", "controlStateBytes", "ordinalArtifactBytes",
  ], "rain control package");
  const built = buildAdjustmentRainControlReferenceAction(input.action);
  const compensation = built.action.actionKind === "compensate_control_reference";
  let files;
  let removedPaths = [];

  // target publication carries both immutable members and the selected reference
  if (!compensation) {
    if (input.baselineSelectorBytes !== null) {
      throw releaseError("rain_control_baseline_unexpected");
    }
    const stateBytes = requireBuffer(input.controlStateBytes, "controlStateBytes");
    const artifactBytes = requireBuffer(input.ordinalArtifactBytes, "ordinalArtifactBytes");
    const state = parseRainMaintenanceControlState(stateBytes);
    validateRainMaintenanceControlArtifact(state, artifactBytes);

    // bind the source graph action to the exact pre-month state and artifact
    if (state.modelMonth !== built.action.dueMonth ||
      state.generatedAt !== built.action.createdAt ||
      state.ordinalArtifactSha256 !== built.action.ordinalArtifactSha256 ||
      state.sourceMemberRootSha256 !== built.action.sourceMemberRootSha256 ||
      state.sourceReceiptRootSha256 !== built.action.sourceReceiptRootSha256 ||
      adjustmentSha256(stateBytes) !== built.action.controlStateSha256 ||
      adjustmentSha256(artifactBytes) !== built.action.ordinalArtifactSha256) {
      throw releaseError("rain_control_reference_binding_invalid");
    }
    const selector = buildRainControlReferenceSelector(built, state);
    files = [
      { bytes: built.bytes, path: built.path },
      {
        bytes: Buffer.from(stateBytes),
        path: `config/forecast-adjustments/ballydidean/rain-maintenance-control-states/` +
          `sha256-${built.action.controlStateSha256}.json`,
      },
      {
        bytes: Buffer.from(artifactBytes),
        path: `config/forecast-adjustments/ballydidean/rain-runtime-artifacts/` +
          `sha256-${built.action.ordinalArtifactSha256}.json`,
      },
      selector,
    ];
  } else {
    // compensation restores only the prepared selector baseline or its exact absence
    if (input.controlStateBytes !== null || input.ordinalArtifactBytes !== null) {
      throw releaseError("rain_control_compensation_members_unexpected");
    }
    files = [{ bytes: built.bytes, path: built.path }];
    if (input.baselineSelectorBytes === null) {
      removedPaths = [RAIN_CONTROL_REFERENCE_SELECTOR_PATH];
    } else {
      const selectorBytes = requireBuffer(input.baselineSelectorBytes, "baselineSelectorBytes");
      validateRainControlReferenceSelector(selectorBytes);
      files.push({ bytes: Buffer.from(selectorBytes), path: RAIN_CONTROL_REFERENCE_SELECTOR_PATH });
    }
  }
  const normalized = files.map(
    // normalize every public control member
    (file) => normalizeFile(file),
  ).sort((left, right) => left.path.localeCompare(right.path));
  const changedPaths = [...normalized.map((file) => file.path), ...removedPaths].sort();

  // prohibit duplicate operations and oversized or private public material
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw releaseError("rain_control_package_paths_invalid");
  }
  let totalBytes = 0;
  for (const file of normalized) {
    totalBytes += file.bytes.length;
    // enforce the existing public model package ceiling
    if (totalBytes > ADJUSTMENT_MODEL_PACKAGE_MAXIMUM_BYTES) {
      throw releaseError("model_package_size_refused");
    }
    rejectPrivateBytes(file.bytes);
  }
  const operations = [
    ...normalized.map(
      // bind each exact added or replaced byte member
      (file) => ({ operation: "write", path: file.path, sha256: adjustmentSha256(file.bytes) }),
    ),
    ...removedPaths.map(
      // bind the one possible absent-baseline selector deletion
      (path) => ({ operation: "remove", path, sha256: null }),
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    actionSha256: built.actionSha256,
    files: normalized,
    packageRootSha256: adjustmentSha256(canonicalJsonBytes(operations)),
    removedPaths,
    totalBytes,
  };
}

// build one action-selected public rain control reference
function buildRainControlReferenceSelector(built, state) {
  const selector = {
    actionSha256: built.actionSha256,
    contractVersion: ADJUSTMENT_RAIN_CONTROL_REFERENCE_REGISTRY_CONTRACT_VERSION,
    controlStatePath: `rain-maintenance-control-states/` +
      `sha256-${built.action.controlStateSha256}.json`,
    controlStateSha256: built.action.controlStateSha256,
    dueMonth: state.modelMonth,
    ordinalArtifactPath: `rain-runtime-artifacts/` +
      `sha256-${built.action.ordinalArtifactSha256}.json`,
    ordinalArtifactSha256: built.action.ordinalArtifactSha256,
    siteKey: "ballydidean",
  };
  return { bytes: canonicalJsonBytes(selector), path: RAIN_CONTROL_REFERENCE_SELECTOR_PATH };
}

// validate one previously published control selector before compensation
function validateRainControlReferenceSelector(bytes) {
  const selector = parseCanonicalJson(bytes, "rain control selector");
  requireExactKeys(selector, [
    "actionSha256", "contractVersion", "controlStatePath", "controlStateSha256",
    "dueMonth", "ordinalArtifactPath", "ordinalArtifactSha256", "siteKey",
  ], "rain control selector");
  requireSha256(selector.actionSha256, "selector.actionSha256");
  requireSha256(selector.controlStateSha256, "selector.controlStateSha256");
  requireSha256(selector.ordinalArtifactSha256, "selector.ordinalArtifactSha256");
  if (selector.contractVersion !== ADJUSTMENT_RAIN_CONTROL_REFERENCE_REGISTRY_CONTRACT_VERSION ||
    selector.siteKey !== "ballydidean" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(selector.dueMonth) ||
    selector.controlStatePath !== `rain-maintenance-control-states/` +
      `sha256-${selector.controlStateSha256}.json` ||
    selector.ordinalArtifactPath !== `rain-runtime-artifacts/` +
      `sha256-${selector.ordinalArtifactSha256}.json`) {
    throw releaseError("rain_control_selector_invalid");
  }
  return selector;
}

// package one public family change after byte-exact parity
export function packageAdjustmentModelFamily(input) {
  requireExactKeys(input, [
    "action",
    "familyFiles",
    "parity",
    "shadowRegistration",
  ], "model package");
  const builtAction = buildAdjustmentModelAction(input.action);
  const family = builtAction.action.family;
  const validated = validateFamilyFiles(
    family,
    input.familyFiles,
    builtAction.action,
    builtAction.actionSha256,
  );
  const parity = builtAction.action.candidateSha256 === null ||
    builtAction.action.actionKind === "compensate_shadow"
    ? null
    : buildParityFixture(family, builtAction.action.candidateSha256, input.parity);
  const parityFile = parity === null ? null : {
    bytes: parity.bytes,
    path: `config/forecast-adjustments/ballydidean/model-parity/${family}/` +
      `sha256-${builtAction.action.candidateSha256}.json`,
  };
  const shadowCatalog = buildShadowCatalogProjection({
    action: builtAction.action,
    actionSha256: builtAction.actionSha256,
    artifactSha256: validated.artifactSha256,
    paritySha256: parity?.paritySha256 ?? null,
    registration: input.shadowRegistration,
  });
  const files = [
    ...validated.files,
    { bytes: builtAction.bytes, path: builtAction.path },
    ...(parityFile === null ? [] : [parityFile]),
    ...(shadowCatalog === null ? [] : [{
      bytes: shadowCatalog.bytes,
      path: `config/forecast-adjustments/ballydidean/shadow-catalog/${family}/` +
        `sha256-${builtAction.action.candidateSha256}.json`,
    }]),
  ].sort((left, right) => left.path.localeCompare(right.path));
  let totalBytes = 0;

  // enforce individual and aggregate public package bounds
  for (const file of files) {
    totalBytes += file.bytes.length;

    // reject oversized single members before worktree mutation
    if (file.bytes.length === 0 || file.bytes.length > ADJUSTMENT_MODEL_PACKAGE_MAXIMUM_BYTES ||
      totalBytes > ADJUSTMENT_MODEL_PACKAGE_MAXIMUM_BYTES) {
      throw releaseError("model_package_size_refused");
    }
    rejectPrivateBytes(file.bytes);
  }
  const packageRootSha256 = adjustmentSha256(canonicalJsonBytes(files.map(
    // bind the exact allowed path and file bytes
    (file) => ({
      bytes: file.bytes.length,
      path: file.path,
      sha256: adjustmentSha256(file.bytes),
    }),
  )));
  return {
    actionSha256: builtAction.actionSha256,
    files,
    packageRootSha256,
    paritySha256: parity?.paritySha256 ?? null,
    totalBytes,
  };
}

// build one action-bound maintenance serving selector
export function buildAdjustmentMaintenanceServingRegistry(input) {
  requireExactKeys(input, ["action", "artifactSha256"], "maintenance serving registry");
  const built = buildAdjustmentModelAction(input.action);
  const family = built.action.family;

  // serving selectors require a concrete qualified or regression candidate
  if (!["promote", "rollback_prior", "compensate_incumbent"].includes(
    built.action.actionKind,
  ) || built.action.candidateSha256 === null) {
    throw releaseError("family_registry_action_invalid");
  }
  requireSha256(input.artifactSha256, "artifactSha256");
  const kind = family === "rain"
    ? {
        bundleDirectory: "rain-runtime-artifacts",
        registryContract: "forecast-adjustment-rain-maintenance-registry/v1",
        registryPath: "config/forecast-adjustments/ballydidean-rain-runtime.json",
      }
    : PACKAGE_KINDS.get(family);
  const registry = {
    activePackage: {
      actionSha256: built.actionSha256,
      artifactSha256: input.artifactSha256,
      candidateSha256: built.action.candidateSha256,
      path: `${kind.bundleDirectory}/sha256-${input.artifactSha256}.json`,
    },
    contractVersion: kind.registryContract,
    rawReason: null,
    siteKey: "ballydidean",
  };
  return Object.freeze({
    bytes: canonicalJsonBytes(registry),
    path: kind.registryPath,
  });
}

// build one explicit action-bound raw selector
export function buildAdjustmentMaintenanceRawRegistry(action) {
  const built = buildAdjustmentModelAction(action);
  const family = built.action.family;

  // raw selectors carry no candidate package authority
  if (!["raw", "compensate_raw"].includes(built.action.actionKind)) {
    throw releaseError("family_registry_action_invalid");
  }
  const kind = family === "rain"
    ? {
        registryContract: "forecast-adjustment-rain-maintenance-registry/v1",
        registryPath: "config/forecast-adjustments/ballydidean-rain-runtime.json",
      }
    : PACKAGE_KINDS.get(family);
  const registry = {
    activePackage: null,
    contractVersion: kind.registryContract,
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  };
  return Object.freeze({
    bytes: canonicalJsonBytes(registry),
    path: kind.registryPath,
  });
}

// publish one detached model-only commit with immutable refs
export async function publishAdjustmentModelRelease(input, ports) {
  requireExactKeys(input, [
    "action",
    "familyFiles",
    "parity",
    "releaseDate",
    "releaseDueKey",
    "releaseRunId",
    "repositoryPath",
    "shadowRegistration",
    "sourceCommit",
  ], "model release input");
  validateReleasePorts(ports);

  // prove production credentials and deployed-source identity before mutation
  if (typeof ports.verifyEnvironment === "function") {
    await ports.verifyEnvironment({
      repositoryPath: input.repositoryPath,
      sourceCommit: input.sourceCommit,
      sourceRelease: input.action.expectedSourceRelease,
    });
  }
  requireCommit(input.sourceCommit, "sourceCommit");
  const startedAt = ports.clock();
  requireInstant(startedAt.toISOString(), "release start");
  const compensation = input.action.actionKind === "compensate_incumbent" ||
    input.action.actionKind === "compensate_raw" ||
    input.action.actionKind === "compensate_shadow";

  // reject future or policy-expired ordinary actions before local mutation
  if (startedAt.getTime() < Date.parse(input.action.createdAt) ||
    (!compensation && startedAt.getTime() > Date.parse(input.action.validThrough))) {
    throw releaseError("model_action_not_current");
  }

  // bind action source to the separately proven deployed source commit
  if (input.action.expectedSourceCommit !== input.sourceCommit) {
    throw releaseError("deployed_source_commit_mismatch");
  }
  if (typeof input.repositoryPath !== "string" || !isAbsolute(input.repositoryPath)) {
    throw new TypeError("repositoryPath is invalid");
  }
  if (typeof input.releaseDate !== "string" || !RELEASE_DATE_PATTERN.test(input.releaseDate)) {
    throw new TypeError("releaseDate is invalid");
  }
  const packaged = packageAdjustmentModelFamily({
    action: input.action,
    familyFiles: input.familyFiles,
    parity: input.parity,
    shadowRegistration: input.shadowRegistration,
  });
  return await publishPackagedAdjustmentRelease(input, ports, packaged, {
    action: input.action,
    compensation,
    targetIdentity: input.action.candidateSha256 ?? packaged.actionSha256,
  });
}

// publish one pre-month control reference through the reviewed release pipeline
export async function publishAdjustmentRainControlReferenceRelease(input, ports) {
  requireExactKeys(input, [
    "action", "baselineSelectorBytes", "controlStateBytes", "ordinalArtifactBytes",
    "releaseDate", "releaseDueKey", "releaseRunId", "repositoryPath", "sourceCommit",
  ], "rain control release input");
  validateReleasePorts(ports);
  const built = buildAdjustmentRainControlReferenceAction(input.action);

  // prove production credentials and deployed-source identity before mutation
  if (typeof ports.verifyEnvironment === "function") {
    await ports.verifyEnvironment({
      repositoryPath: input.repositoryPath,
      sourceCommit: input.sourceCommit,
      sourceRelease: built.action.expectedSourceRelease,
    });
  }
  requireCommit(input.sourceCommit, "sourceCommit");
  const startedAt = ports.clock();
  requireInstant(startedAt.toISOString(), "release start");
  const compensation = built.action.actionKind === "compensate_control_reference";

  // ordinary references remain inside the month-bound window while prepared compensation may recover
  if (startedAt.getTime() < Date.parse(built.action.createdAt) ||
    (!compensation && startedAt.getTime() > Date.parse(built.action.validThrough))) {
    throw releaseError("rain_control_action_not_current");
  }
  if (built.action.expectedSourceCommit !== input.sourceCommit) {
    throw releaseError("deployed_source_commit_mismatch");
  }
  if (typeof input.repositoryPath !== "string" || !isAbsolute(input.repositoryPath)) {
    throw new TypeError("repositoryPath is invalid");
  }
  if (typeof input.releaseDate !== "string" || !RELEASE_DATE_PATTERN.test(input.releaseDate)) {
    throw new TypeError("releaseDate is invalid");
  }
  const packaged = packageAdjustmentRainControlReference({
    action: built.action,
    baselineSelectorBytes: input.baselineSelectorBytes,
    controlStateBytes: input.controlStateBytes,
    ordinalArtifactBytes: input.ordinalArtifactBytes,
  });
  return await publishPackagedAdjustmentRelease(input, ports, packaged, {
    action: built.action,
    compensation,
    targetIdentity: built.action.controlStateSha256,
  });
}

// publish and journal one control target plus its prebuilt baseline compensation
export async function publishAdjustmentRainControlReferenceReleasePair(input, ports) {
  requireExactKeys(input, ["buildCompensation", "target"], "rain control release pair input");

  // require a post-target factory so compensation is based on the immutable target commit
  if (typeof input.buildCompensation !== "function" ||
    typeof ports?.recordReleasePair !== "function" ||
    input.target?.action?.actionKind !== "control_reference") {
    throw new TypeError("rain control release pair ports are invalid");
  }
  const target = await publishAdjustmentRainControlReferenceRelease(input.target, ports);
  const compensationInput = await input.buildCompensation(Object.freeze({ ...target }));
  const targetAction = input.target.action;
  const compensationAction = compensationInput?.action;

  // bind the compensation release to the target and its prepared source/catalog baseline
  if (compensationInput === null || typeof compensationInput !== "object" ||
    compensationAction?.actionKind !== "compensate_control_reference" ||
    compensationAction.predecessorActionSha256 !== target.actionSha256 ||
    compensationAction.expectedSourceCommit !== target.commitSha ||
    compensationAction.expectedSourceRelease !== target.releaseTag ||
    compensationAction.expectedCatalogReceiptSha256 !==
      targetAction.expectedCatalogReceiptSha256 ||
    compensationAction.controlStateSha256 !== targetAction.controlStateSha256 ||
    compensationAction.ordinalArtifactSha256 !== targetAction.ordinalArtifactSha256 ||
    compensationAction.graphManifestSha256 !== targetAction.graphManifestSha256 ||
    compensationAction.sourceMemberRootSha256 !== targetAction.sourceMemberRootSha256 ||
    compensationAction.sourceReceiptRootSha256 !== targetAction.sourceReceiptRootSha256 ||
    compensationAction.dueMonth !== targetAction.dueMonth ||
    compensationAction.fencingToken !== targetAction.fencingToken ||
    compensationInput.sourceCommit !== target.commitSha ||
    compensationInput.releaseDueKey !== input.target.releaseDueKey ||
    compensationInput.releaseRunId !== input.target.releaseRunId ||
    compensationInput.repositoryPath !== input.target.repositoryPath) {
    throw releaseError("rain_control_compensation_pair_invalid");
  }
  const compensation = await publishAdjustmentRainControlReferenceRelease(
    compensationInput,
    ports,
  );
  await ports.recordReleasePair({
    compensationActionSha256: compensation.actionSha256,
    compensationCommitSha: compensation.commitSha,
    compensationReleaseTag: compensation.releaseTag,
    family: "rain",
    fencingToken: targetAction.fencingToken,
    now: ports.clock().toISOString(),
    targetActionSha256: target.actionSha256,
    targetCommitSha: target.commitSha,
    targetReleaseTag: target.releaseTag,
  });
  return { compensation, target };
}

// publish one already-validated package without widening its file operations
async function publishPackagedAdjustmentRelease(input, ports, packaged, metadata) {
  const action = metadata.action;
  const branch = `automation/adjustment-${action.family}-` +
    `${metadata.targetIdentity.slice(0, 12)}-${packaged.actionSha256.slice(0, 12)}`;
  const actionTag = `adjustment-action/${action.family}/${packaged.actionSha256}`;
  const sourceCommit = await gitOutput(input.repositoryPath, [
    "rev-parse", "--verify", `${input.sourceCommit}^{commit}`,
  ]);

  // refuse a tag, abbreviation, or changed source identity
  if (sourceCommit !== input.sourceCommit) {
    throw releaseError("deployed_source_commit_mismatch");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "weather-adjustment-release-"));
  const worktree = join(temporaryRoot, "worktree");
  let added = false;

  try {
    await git(input.repositoryPath, ["worktree", "add", "--detach", worktree, input.sourceCommit]);
    added = true;
    await requireCleanWorktree(worktree);
    await writePackageFiles(worktree, packaged.files);
    await removePackagePaths(worktree, packaged.removedPaths ?? []);
    const changed = await changedPaths(worktree);
    const allowed = [
      ...packaged.files.map((file) => file.path),
      ...(packaged.removedPaths ?? []),
    ].sort();

    // refuse any recipe side effect outside the closed package operations
    if (!sameStrings(changed, allowed)) {
      throw releaseError("unexpected_model_diff");
    }
    await git(worktree, ["add", "--", ...allowed]);
    const staged = (await gitOutput(worktree, ["diff", "--cached", "--name-only", "-z"]))
      .split("\0").filter(Boolean).sort();

    // prove the staged commit contains only the reviewed package operations
    if (!sameStrings(staged, allowed)) {
      throw releaseError("unexpected_model_diff");
    }
    await inspectStagedFiles(worktree, packaged.files);
    await inspectRemovedPaths(worktree, packaged.removedPaths ?? []);
    await git(worktree, [
      "-c", "user.name=Weather Adjustment Automation",
      "-c", "user.email=weather-adjustment@localhost",
      "commit", "--no-gpg-sign", "-m",
      `chore(adjustment): publish ${action.family} ${metadata.targetIdentity.slice(0, 12)}`,
    ], {
      GIT_AUTHOR_DATE: action.createdAt,
      GIT_COMMITTER_DATE: action.createdAt,
    });
    const commitSha = await gitOutput(worktree, ["rev-parse", "HEAD"]);
    requireCommit(commitSha, "commitSha");
    let releaseTag = await selectReleaseTag(input.repositoryPath, input.releaseDate, commitSha);
    const preparation = {
      actionSha256: packaged.actionSha256,
      actionTag,
      branch,
      commitSha,
      expectedSourceCommit: input.sourceCommit,
      family: action.family,
      fencingToken: action.fencingToken,
      now: ports.clock().toISOString(),
      packageRootSha256: packaged.packageRootSha256,
      releaseDueKey: input.releaseDueKey,
      releaseRunId: input.releaseRunId,
      releaseTag,
    };

    // route only paired compensation through the predecessor-bound journal transition
    if (metadata.compensation) {
      if (typeof ports.prepareCompensatingRelease !== "function") {
        throw new TypeError("compensating model release port is invalid");
      }
      await ports.prepareCompensatingRelease({
        ...preparation,
        predecessorActionSha256: action.predecessorActionSha256,
      });
    } else {
      await ports.prepareRelease(preparation);
    }
    await publishRef(input.repositoryPath, commitSha, `refs/heads/${branch}`);
    await ports.awaitExactCheck({ branch, commitSha });
    await publishRef(input.repositoryPath, commitSha, `refs/tags/${actionTag}`);
    releaseTag = await publishReleaseTag({
      actionSha256: packaged.actionSha256,
      commitSha,
      family: action.family,
      fencingToken: action.fencingToken,
      initialTag: releaseTag,
      ports,
      releaseDate: input.releaseDate,
      repositoryPath: input.repositoryPath,
    });
    return {
      actionSha256: packaged.actionSha256,
      actionTag,
      branch,
      commitSha,
      packageRootSha256: packaged.packageRootSha256,
      releaseTag,
    };
  } finally {
    // remove only this disposable detached worktree
    if (added) {
      await git(input.repositoryPath, ["worktree", "remove", "--force", worktree])
        .catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

// publish and journal one target plus prebuilt family-only compensation pair
export async function publishAdjustmentModelReleasePair(input, ports) {
  requireExactKeys(input, ["buildCompensation", "target"], "model release pair input");

  // require a post-target action factory because its source commit is not known earlier
  if (typeof input.buildCompensation !== "function" ||
    typeof ports?.recordReleasePair !== "function") {
    throw new TypeError("model release pair ports are invalid");
  }
  const target = await publishAdjustmentModelRelease(input.target, ports);
  const compensationInput = await input.buildCompensation(Object.freeze({ ...target }));

  // bind the compensation action and commit base before its own publication
  if (compensationInput === null || typeof compensationInput !== "object" ||
    !new Set(["compensate_incumbent", "compensate_raw", "compensate_shadow"])
      .has(compensationInput.action?.actionKind) ||
    compensationInput.action.predecessorActionSha256 !== target.actionSha256 ||
    compensationInput.action.expectedSourceCommit !== target.commitSha ||
    compensationInput.action.expectedSourceRelease !== target.releaseTag ||
    compensationInput.action.expectedInstalledReceiptSha256 !==
      input.target.action.expectedInstalledReceiptSha256 ||
    compensationInput.sourceCommit !== target.commitSha ||
    compensationInput.action.family !== input.target.action.family ||
    compensationInput.action.fencingToken !== input.target.action.fencingToken ||
    compensationInput.releaseDueKey !== input.target.releaseDueKey ||
    compensationInput.releaseRunId !== input.target.releaseRunId ||
    compensationInput.repositoryPath !== input.target.repositoryPath) {
    throw releaseError("model_compensation_pair_invalid");
  }
  const compensation = await publishAdjustmentModelRelease(compensationInput, ports);
  await ports.recordReleasePair({
    compensationActionSha256: compensation.actionSha256,
    compensationCommitSha: compensation.commitSha,
    compensationReleaseTag: compensation.releaseTag,
    family: input.target.action.family,
    fencingToken: input.target.action.fencingToken,
    now: ports.clock().toISOString(),
    targetActionSha256: target.actionSha256,
    targetCommitSha: target.commitSha,
    targetReleaseTag: target.releaseTag,
  });
  return { compensation, target };
}

// publish a release tag with journaled append-only collision successors
async function publishReleaseTag(input) {
  let tag = input.initialTag;

  // retry only bounded immutable tag races
  for (let collisionCount = 0; collisionCount < 999; collisionCount += 1) {
    let existing = await remoteRef(input.repositoryPath, `refs/tags/${tag}`);

    // publish or reuse an exact same-commit tag
    if (existing === null || existing === input.commitSha) {
      try {
        await publishRef(input.repositoryPath, input.commitSha, `refs/tags/${tag}`);
        return tag;
      } catch (error) {
        existing = await remoteRef(input.repositoryPath, `refs/tags/${tag}`);

        // rethrow failures that are not a proven competing immutable tag
        if (existing === null || existing === input.commitSha) {
          throw error;
        }
      }
    }
    const successor = await selectReleaseTag(
      input.repositoryPath,
      input.releaseDate,
      input.commitSha,
      Number(tag.slice(tag.lastIndexOf("-") + 1)) + 1,
    );
    await input.ports.recordTagCollision({
      actionSha256: input.actionSha256,
      attemptedReleaseTag: tag,
      collisionCommitSha: existing,
      family: input.family,
      fencingToken: input.fencingToken,
      now: input.ports.clock().toISOString(),
      successorReleaseTag: successor,
    });
    tag = successor;
  }
  throw releaseError("release_tag_namespace_exhausted");
}

// validate the action-specific family-controlled runtime files
function validateFamilyFiles(family, value, action, actionSha256) {
  if (!Array.isArray(value)) {
    throw releaseError("family_package_files_invalid");
  }
  const normalized = value.map(
    // normalize every caller-owned byte member
    (file) => normalizeFile(file),
  );
  const shadowCompensation = action.actionKind === "compensate_shadow";

  // shadow compensation changes only immutable action metadata
  if (shadowCompensation) {
    if (normalized.length !== 0) {
      throw releaseError("family_shadow_compensation_files_invalid");
    }
    return { artifactSha256: null, files: normalized };
  }
  const rawAction = action.actionKind === "raw" || action.actionKind === "compensate_raw";

  // raw actions change only the fixed family serving registry
  if (rawAction) {
    validateRawFamilyRegistry(family, normalized, actionSha256);
    return { artifactSha256: null, files: normalized };
  }
  const shadow = action.actionKind === "shadow";

  // apply the distinct inactive and active compiled-rain matrices
  if (family === "rain") {
    const validated = shadow
      ? validatePortableRainShadowFiles(normalized, action.candidateSha256)
      : validatePortableRainServingPackageFiles(
          normalized,
          action.candidateSha256,
          actionSha256,
        );
    return {
      artifactSha256: validated.receipt.artifactSha256,
      files: normalized,
    };
  }
  const kind = PACKAGE_KINDS.get(family);
  const expectedCount = shadow ? 1 : 2;

  // require only a candidate bundle for an inactive shadow release
  if (normalized.length !== expectedCount) {
    throw releaseError("family_package_files_invalid");
  }
  const bundleFile = shadow
    ? normalized[0]
    : normalized.find((file) => file.path.startsWith(
      `config/forecast-adjustments/ballydidean/${kind.bundleDirectory}/sha256-`,
    ));

  // require the exact content-addressed candidate bundle
  if (bundleFile === undefined) {
    throw releaseError("family_package_files_invalid");
  }
  const bundle = validateFamilyBundle(family, bundleFile.bytes, action.candidateSha256);
  const bundlePath = `config/forecast-adjustments/ballydidean/${kind.bundleDirectory}/` +
    `sha256-${bundle.bundleSha256}.json`;

  // bind both legacy and maintenance packages to their own artifact address
  if (bundleFile.path !== bundlePath) {
    throw releaseError("family_package_files_invalid");
  }

  // shadows must not carry an active serving registry delta
  if (shadow) {
    return { artifactSha256: bundle.bundleSha256, files: normalized };
  }
  const registryFile = normalized.find((file) => file.path === kind.registryPath);

  // require the fixed registry path
  if (registryFile === undefined) {
    throw releaseError("family_package_files_invalid");
  }
  const registry = parseCanonicalJson(registryFile.bytes, "family registry");
  requireExactKeys(registry, [
    "activePackage",
    "contractVersion",
    "rawReason",
    "siteKey",
  ], "family registry");

  // require an action-bound maintenance registry for the chosen family
  if (registry.contractVersion !== kind.registryContract ||
    registry.siteKey !== "ballydidean" || registry.rawReason !== null ||
    registry.activePackage === null || typeof registry.activePackage !== "object" ||
    Array.isArray(registry.activePackage)) {
    throw releaseError("family_registry_invalid");
  }
  requireExactKeys(registry.activePackage, ACTIVE_PACKAGE_KEYS, "family active registry");
  const artifactSha256 = registry.activePackage.artifactSha256;
  requireSha256(artifactSha256, "artifactSha256");
  const relativeBundlePath = `${kind.bundleDirectory}/sha256-${artifactSha256}.json`;

  // bind the registry to the exact action, raw fit, and runtime artifact
  if (registry.activePackage.path !== relativeBundlePath ||
    registry.activePackage.actionSha256 !== actionSha256 ||
    registry.activePackage.candidateSha256 !== action.candidateSha256 ||
    artifactSha256 !== bundle.bundleSha256 ||
    bundle.candidateSha256 !== action.candidateSha256 ||
    bundle.contractVersion !== "forecast-adjustment-maintenance-runtime-package/v1") {
    throw releaseError("family_registry_invalid");
  }
  return { artifactSha256, files: normalized };
}

// validate one standalone content-addressed temperature or wind bundle
function validateFamilyBundle(family, bytes, candidateSha256) {
  const bundle = parseCanonicalJson(bytes, "family bundle");
  const unsigned = { ...bundle };
  delete unsigned.bundleSha256;

  // bind the candidate identity to its canonical unsigned runtime bundle
  if (!SHA256_PATTERN.test(bundle.bundleSha256 ?? "") ||
    adjustmentSha256(canonicalJsonBytes(unsigned)) !== bundle.bundleSha256) {
    throw releaseError("family_bundle_invalid");
  }

  // bind the authority-free maintenance package to its raw fit identity
  if (bundle.contractVersion === "forecast-adjustment-maintenance-runtime-package/v1") {
    validateMaintenanceRuntimePackage(family, bundle, candidateSha256);
    return bundle;
  }

  // preserve exact legacy bundle identity semantics for serving releases
  if (bundle.bundleSha256 !== candidateSha256) {
    throw releaseError("family_bundle_invalid");
  }

  // preserve the validated wind runtime's exact 13-band exclusion
  if (family === "wind") {
    validateWindBands(bundle);
  }
  return bundle;
}

// validate one inactive authority-free temperature or wind runtime package
function validateMaintenanceRuntimePackage(family, bundle, candidateSha256) {
  const commonKeys = [
    "bundleSha256", "candidateSha256", "contractVersion", "dueMonth", "family", "source",
  ];
  requireExactKeys(bundle, family === "temperature"
    ? [...commonKeys, "model"]
    : [...commonKeys, "candidate"], "maintenance runtime package");

  // require the raw fit identity and closed monthly family projection
  if (bundle.family !== family || bundle.candidateSha256 !== candidateSha256 ||
    typeof bundle.dueMonth !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(bundle.dueMonth) ||
    bundle.source === null || Array.isArray(bundle.source) || typeof bundle.source !== "object") {
    throw releaseError("family_bundle_invalid");
  }

  // preserve the exact installed wind mask and source lineage
  if (family === "wind") {
    if (bundle.candidate === null || Array.isArray(bundle.candidate) ||
      typeof bundle.candidate !== "object" ||
      !canonicalJsonBytes(bundle.source).equals(
        canonicalJsonBytes(bundle.candidate.forecastIdentity),
      )) {
      throw releaseError("family_bundle_invalid");
    }
    validateWindBands(bundle);
    return;
  }
  requireExactKeys(bundle.source, [
    "adapterVersion", "cohort", "dataset", "maximumReceiptAgeHours", "providerKey",
    "scope", "sourceDelayHours", "upstreamModel",
  ], "temperature maintenance source");
  const expectedSource = {
    adapterVersion: "open-meteo-ecmwf-single-run/v1",
    cohort: "ecmwf_single_run_hindcast",
    dataset: "single_run",
    maximumReceiptAgeHours: 12,
    providerKey: "open-meteo",
    scope: "assumed_delay6_next12",
    sourceDelayHours: 6,
    upstreamModel: "ecmwf_ifs",
  };

  // prohibit another source identity under a rehashed temperature package
  if (!canonicalJsonBytes(bundle.source).equals(canonicalJsonBytes(expectedSource)) ||
    bundle.model === null || Array.isArray(bundle.model) || typeof bundle.model !== "object" ||
    bundle.model.contractVersion !== "temperature-permanent-model/v1") {
    throw releaseError("family_bundle_invalid");
  }
}

// validate one exact reviewed raw fallback registry
function validateRawFamilyRegistry(family, files, actionSha256) {
  const registryPath = family === "rain"
    ? "config/forecast-adjustments/ballydidean-rain-runtime.json"
    : PACKAGE_KINDS.get(family).registryPath;

  // prohibit bundle or parity changes during raw fallback
  if (files.length !== 1 || files[0].path !== registryPath) {
    throw releaseError("family_raw_registry_invalid");
  }
  requireSha256(actionSha256, "actionSha256");
  const contractVersion = `forecast-adjustment-${family}-maintenance-registry/v1`;
  const expected = {
    activePackage: null,
    contractVersion,
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  };

  // require the exact canonical runtime-reviewed raw bytes
  if (!canonicalJsonBytes(expected).equals(files[0].bytes)) {
    throw releaseError("family_raw_registry_invalid");
  }
}

// build the public projection consumed by the privileged installed catalog
function buildShadowCatalogProjection(input) {
  const shadow = input.action.actionKind === "shadow";

  // prohibit registration material on serving or raw actions
  if (!shadow) {
    if (input.registration !== null) {
      throw releaseError("shadow_registration_unexpected");
    }
    return null;
  }
  const registrationV2Keys = [
    "artifactSha256",
    "candidateSha256",
    "cohortSha256",
    "family",
    "intervalEndAt",
    "intervalStartAt",
    "policySha256",
    "registrationSha256",
    "reservedKeySha256",
    "siteKey",
    "sourceSha256",
    "targetCutoffAt",
    "terminalAt",
  ];
  const registrationV3OnlyKeys = ["epochWitnessSha256", "predecessorRegistrationSha256",
    "scheduleContractSha256"];
  const registrationV3 = registrationV3OnlyKeys.some(
    // treat any v3-only field as v3 so partial extensions fail closed
    (key) => Object.prototype.hasOwnProperty.call(input.registration, key),
  );
  requireExactKeys(input.registration,
    registrationV3 ? [...registrationV2Keys, ...registrationV3OnlyKeys] : registrationV2Keys,
    "shadow registration");

  // validate every immutable registration identity
  for (const name of [
    "artifactSha256",
    "candidateSha256",
    "cohortSha256",
    "policySha256",
    "registrationSha256",
    "reservedKeySha256",
    "sourceSha256",
  ]) {
    requireSha256(input.registration[name], `registration.${name}`);
  }
  // validate the future-only schedule lineage only for v3
  if (registrationV3) {
    requireSha256(input.registration.epochWitnessSha256, "registration.epochWitnessSha256");
    requireSha256(input.registration.scheduleContractSha256, "registration.scheduleContractSha256");
    requireNullableSha256(input.registration.predecessorRegistrationSha256,
      "registration.predecessorRegistrationSha256");
  }

  // validate every exact registration clock
  for (const name of [
    "intervalEndAt",
    "intervalStartAt",
    "targetCutoffAt",
    "terminalAt",
  ]) {
    requireInstant(input.registration[name], `registration.${name}`);
  }
  const registrationMaterial = registrationV3
    ? `${[
      "adjustment-shadow-registration/v3",
      input.registration.siteKey,
      input.registration.family,
      input.registration.candidateSha256,
      input.registration.artifactSha256,
      input.registration.policySha256,
      input.registration.cohortSha256,
      input.registration.reservedKeySha256,
      input.registration.sourceSha256,
      input.registration.epochWitnessSha256,
      input.registration.scheduleContractSha256,
      input.registration.predecessorRegistrationSha256 ?? "none",
      input.registration.intervalStartAt,
      input.registration.intervalEndAt,
      input.registration.targetCutoffAt,
      input.registration.terminalAt,
    ].join("\n")}\n`
    : [
      "adjustment-shadow-registration/v2",
      input.registration.siteKey,
      input.registration.family,
      input.registration.candidateSha256,
      input.registration.artifactSha256,
      input.registration.policySha256,
      input.registration.cohortSha256,
      input.registration.reservedKeySha256,
      input.registration.sourceSha256,
      input.registration.intervalStartAt,
      input.registration.intervalEndAt,
      input.registration.targetCutoffAt,
      input.registration.terminalAt,
    ].join("\n");

  // cross-bind the registration to the action and family artifact
  if (input.registration.siteKey !== "ballydidean" ||
    input.registration.family !== input.action.family ||
    input.registration.candidateSha256 !== input.action.candidateSha256 ||
    input.registration.artifactSha256 !== input.artifactSha256 ||
    input.registration.registrationSha256 !== adjustmentSha256(Buffer.from(registrationMaterial)) ||
    input.paritySha256 === null) {
    throw releaseError("shadow_registration_invalid");
  }
  const projection = {
    actionSha256: input.actionSha256,
    artifactSha256: input.artifactSha256,
    bundleSha256: input.artifactSha256,
    candidateGraphSha256: input.action.candidateGraphSha256,
    candidateSha256: input.action.candidateSha256,
    contractVersion: "forecast-adjustment-shadow-catalog-projection/v1",
    family: input.action.family,
    paritySha256: input.paritySha256,
    registration: structuredClone(input.registration),
    siteKey: "ballydidean",
  };
  const bytes = canonicalJsonBytes(projection);
  return { bytes, projection, projectionSha256: adjustmentSha256(bytes) };
}

// build one byte-exact synthetic and retained parity receipt
function buildParityFixture(family, candidateSha256, value) {
  // reuse one already verified immutable parity receipt for compensation
  if (Buffer.isBuffer(value)) {
    const fixture = parseCanonicalJson(value, "model parity receipt");
    requireExactKeys(fixture, [
      "candidateSha256", "contractVersion", "family", "retainedInputSha256",
      "retainedNativeOutputSha256", "retainedPackagedOutputSha256",
      "syntheticInputSha256", "syntheticNativeOutputSha256",
      "syntheticPackagedOutputSha256",
    ], "model parity receipt");
    for (const name of [
      "candidateSha256", "retainedInputSha256", "retainedNativeOutputSha256",
      "retainedPackagedOutputSha256", "syntheticInputSha256",
      "syntheticNativeOutputSha256", "syntheticPackagedOutputSha256",
    ]) {
      requireSha256(fixture[name], `model parity ${name}`);
    }

    // bind reuse to the exact prior family candidate and frozen receipt contract
    if (fixture.contractVersion !== ADJUSTMENT_MODEL_PARITY_CONTRACT_VERSION ||
      fixture.family !== family || fixture.candidateSha256 !== candidateSha256) {
      throw releaseError("model_parity_receipt_invalid");
    }
    return {
      bytes: Buffer.from(value),
      fixture,
      paritySha256: adjustmentSha256(value),
    };
  }
  requireExactKeys(value, [
    "retainedInput",
    "retainedNativeOutput",
    "retainedPackagedOutput",
    "syntheticInput",
    "syntheticNativeOutput",
    "syntheticPackagedOutput",
  ], "model parity");
  const pairs = [
    ["synthetic", value.syntheticInput, value.syntheticNativeOutput, value.syntheticPackagedOutput],
    ["retained", value.retainedInput, value.retainedNativeOutput, value.retainedPackagedOutput],
  ];
  const hashes = {};

  // require both independently supplied output byte streams to match
  for (const [label, inputBytes, nativeBytes, packagedBytes] of pairs) {
    const input = requireBuffer(inputBytes, `${label}Input`);
    const native = requireBuffer(nativeBytes, `${label}NativeOutput`);
    const packaged = requireBuffer(packagedBytes, `${label}PackagedOutput`);

    // reject hash-only or boolean parity claims
    if (!native.equals(packaged)) {
      throw releaseError(`${label}_parity_failed`);
    }
    hashes[`${label}InputSha256`] = adjustmentSha256(input);
    hashes[`${label}NativeOutputSha256`] = adjustmentSha256(native);
    hashes[`${label}PackagedOutputSha256`] = adjustmentSha256(packaged);
  }
  const fixture = {
    candidateSha256,
    contractVersion: ADJUSTMENT_MODEL_PARITY_CONTRACT_VERSION,
    family,
    ...hashes,
  };
  const bytes = canonicalJsonBytes(fixture);
  return { bytes, fixture, paritySha256: adjustmentSha256(bytes) };
}

// require the exact wind speed and gust band mask
function validateWindBands(bundle) {
  const bands = bundle.candidate?.enabledMetricBands;

  // require the closed 13-band runtime projection
  if (!Array.isArray(bands) || bands.length !== 13) {
    throw releaseError("wind_band_mask_invalid");
  }
  const keys = bands.map(
    // project one metric and lead-band identity
    (band) => `${band?.metric}/${band?.leadBand}`,
  );
  const expected = [
    "windGustMps/001-024", "windGustMps/025-048", "windGustMps/073-096",
    "windGustMps/097-120", "windGustMps/121-144", "windGustMps/145-168",
    "windSpeedMps/001-024", "windSpeedMps/025-048", "windSpeedMps/049-072",
    "windSpeedMps/073-096", "windSpeedMps/097-120", "windSpeedMps/121-144",
    "windSpeedMps/145-168",
  ];

  // reject the unsupported gust 49-72 hole or any reordered mask
  if (!sameStrings(keys, expected)) {
    throw releaseError("wind_band_mask_invalid");
  }
}

// normalize one bounded repository-relative public file
function normalizeFile(value) {
  requireExactKeys(value, ["bytes", "path"], "model package file");
  const bytes = requireBuffer(value.bytes, "file bytes");

  // reject absolute paths, traversal, workflow edits, and duplicate separators
  if (typeof value.path !== "string" || value.path.length > 240 ||
    value.path.startsWith("/") || value.path.includes("..") || value.path.includes("//") ||
    value.path.startsWith(".github/") || value.path.includes("\\")) {
    throw releaseError("model_package_path_refused");
  }
  return { bytes: Buffer.from(bytes), path: value.path };
}

// reject obvious credential and host-private material
function rejectPrivateBytes(bytes) {
  const text = bytes.toString("utf8");

  // public model packages must not contain credentials or host paths
  if (/-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/u.test(text) ||
    /(?:ghp|github_pat|glpat)-?[A-Za-z0-9_]{20,}/u.test(text) ||
    /(?:\/home\/|\/root\/|\/mnt\/c\/Users\/|SSH_AUTH_SOCK|ANSEL_HOST_PASSWORD)/u.test(text)) {
    throw releaseError("private_model_material_refused");
  }
}

// write only the validated package into one detached worktree
async function writePackageFiles(worktree, files) {
  // materialize every allowed path without following a final symlink
  for (const file of files) {
    const target = resolve(worktree, file.path);

    // retain every path strictly below the detached root
    if (!target.startsWith(`${resolve(worktree)}${sep}`)) {
      throw releaseError("model_package_path_refused");
    }
    await requireNoSymlinkAncestors(worktree, dirname(target));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });

    try {
      const details = await lstat(target);

      // refuse replacing a link or non-regular entry
      if (details.isSymbolicLink() || !details.isFile()) {
        throw releaseError("model_package_symlink_refused");
      }
    } catch (error) {
      // accept only an absent new target
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await writeFile(target, file.bytes, { flag: "w", mode: 0o644 });
  }
}

// remove only a package-declared regular file for an absent prepared baseline
async function removePackagePaths(worktree, paths) {
  // retain a no-op for every package without deletion operations
  for (const path of paths) {
    if (path !== RAIN_CONTROL_REFERENCE_SELECTOR_PATH) {
      throw releaseError("model_package_path_refused");
    }
    const target = resolve(worktree, path);
    const details = await lstat(target);

    // refuse links, directories and an already absent compensation source
    if (!target.startsWith(`${resolve(worktree)}${sep}`) || details.isSymbolicLink() ||
      !details.isFile()) {
      throw releaseError("model_package_symlink_refused");
    }
    await rm(target, { force: false });
  }
}

// reject links in every existing path component
async function requireNoSymlinkAncestors(worktree, directory) {
  const root = resolve(worktree);
  const suffix = relative(root, directory);
  let current = root;

  // inspect only already existing ancestors
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);

    try {
      const details = await lstat(current);

      // reject linked or non-directory ancestors
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw releaseError("model_package_symlink_refused");
      }
    } catch (error) {
      // later components are absent below the first absent directory
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

// reopen every staged file and bind its exact bytes
async function inspectStagedFiles(worktree, files) {
  // inspect all allowed targets after staging
  for (const file of files) {
    const target = join(worktree, file.path);
    const details = await lstat(target);

    // reject link substitution, permission aliases, and byte drift
    if (!details.isFile() || details.isSymbolicLink() || details.size !== file.bytes.length ||
      !Buffer.from(await readFile(target)).equals(file.bytes)) {
      throw releaseError("model_package_staged_file_invalid");
    }
  }
}

// verify every declared deletion remains absent after staging
async function inspectRemovedPaths(worktree, paths) {
  // reject recreated selector bytes after the deletion operation
  for (const path of paths) {
    try {
      await lstat(join(worktree, path));
      throw releaseError("model_package_staged_file_invalid");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

// require a clean detached source worktree
async function requireCleanWorktree(worktree) {
  const status = await gitOutput(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);

  // refuse submodule, tracked, or untracked source drift
  if (status !== "") {
    throw releaseError("source_worktree_not_clean");
  }
  const submodules = await gitOutput(worktree, ["submodule", "status", "--recursive"]);

  // require every declared submodule to be initialized at its recorded commit
  if (submodules.split("\n").filter(Boolean).some((line) => !line.startsWith(" "))) {
    throw releaseError("source_submodule_not_clean");
  }
}

// list every changed path without quote parsing
async function changedPaths(worktree) {
  const output = await gitOutput(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = output.split("\0").filter(Boolean);
  return fields.map(
    // strip the fixed status prefix from each ordinary model path
    (field) => field.slice(3),
  ).sort();
}

// select the first absent immutable release tag
async function selectReleaseTag(repositoryPath, releaseDate, commitSha, firstSuffix = 1) {
  // search one bounded calendar release namespace
  for (let suffix = firstSuffix; suffix <= 999; suffix += 1) {
    const tag = `${releaseDate}-${suffix}`;
    const existing = await remoteRef(repositoryPath, `refs/tags/${tag}`);

    // reuse only a same-commit idempotent tag or choose the first absent tag
    if (existing === null || existing === commitSha) {
      return tag;
    }
  }
  throw releaseError("release_tag_namespace_exhausted");
}

// publish or reconcile one immutable remote ref without force
async function publishRef(repositoryPath, commitSha, ref) {
  const existing = await remoteRef(repositoryPath, ref);

  // accept only an exact already-published retry
  if (existing !== null) {
    if (existing !== commitSha) {
      throw releaseError("immutable_remote_ref_collision");
    }
    return;
  }
  await git(repositoryPath, ["push", "origin", `${commitSha}:${ref}`]);
  const published = await remoteRef(repositoryPath, ref);

  // require the remote to expose the exact pushed commit
  if (published !== commitSha) {
    throw releaseError("immutable_remote_ref_verification_failed");
  }
}

// read one exact remote ref target
async function remoteRef(repositoryPath, ref) {
  const output = await gitOutput(repositoryPath, ["ls-remote", "--refs", "origin", ref]);

  // retain an absent immutable ref
  if (output === "") {
    return null;
  }
  const lines = output.split("\n");

  // reject ambiguous or malformed remote ref evidence
  if (lines.length !== 1 || !COMMIT_PATTERN.test(lines[0].split("\t")[0] ?? "") ||
    lines[0].split("\t")[1] !== ref) {
    throw releaseError("remote_ref_evidence_invalid");
  }
  return lines[0].slice(0, 40);
}

// run one shell-free git command
async function git(cwd, arguments_, environment = {}) {
  await execFile("/usr/bin/git", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...MODEL_RELEASE_GIT_ENVIRONMENT, ...environment },
    maxBuffer: 4 * 1_024 * 1_024,
  });
}

// run one shell-free git query and trim only its final line ending
async function gitOutput(cwd, arguments_) {
  const result = await execFile("/usr/bin/git", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...MODEL_RELEASE_GIT_ENVIRONMENT },
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}

// validate the journal and exact-check publication ports
function validateReleasePorts(ports) {
  // require every irreversible boundary to be explicit
  if (ports === null || typeof ports !== "object" ||
    typeof ports.prepareRelease !== "function" ||
    typeof ports.recordTagCollision !== "function" ||
    typeof ports.awaitExactCheck !== "function" || typeof ports.clock !== "function" ||
    (ports.verifyEnvironment !== undefined &&
      typeof ports.verifyEnvironment !== "function")) {
    throw new TypeError("model release ports are invalid");
  }
}

// parse only canonical json bytes
function parseCanonicalJson(bytes, label) {
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }

  // reject noncanonical or non-object documents
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError(`${label} is not canonical`);
  }
  return value;
}

// require one exact object key set
function requireExactKeys(value, keys, label) {
  // reject arrays, custom objects, missing, or extra keys
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !sameStrings(Object.keys(value), keys)) {
    throw new TypeError(`${label} keys are invalid`);
  }
}

// require byte material rather than a hash-only assertion
function requireBuffer(value, label) {
  // accept only real nonempty byte buffers
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one lowercase sha256
function requireSha256(value, label) {
  // reject uppercase and abbreviated hashes
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one nullable lowercase sha256
function requireNullableSha256(value, label) {
  // validate only a present identity
  if (value !== null) {
    requireSha256(value, label);
  }
}

// require one exact git commit id
function requireCommit(value, label) {
  // reject abbreviated and uppercase commit ids
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical release tag
function requireReleaseTag(value, label) {
  // accept only the immutable calendar namespace
  if (typeof value !== "string" || !/^\d{4}\.\d{2}\.\d{2}-[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical utc millisecond instant
function requireInstant(value, label) {
  // reject impossible or noncanonical instants
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical positive uint64 fence
function requireFencingToken(value) {
  // reject zero, leading zeros, and overflow
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value) ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError("fencingToken is invalid");
  }
}

// compare two sets after deterministic ordering
function sameStrings(left, right) {
  // preserve duplicates as mismatches
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

// create one closed error reason for callers
function releaseError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}
