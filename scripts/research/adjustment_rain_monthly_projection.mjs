import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind-artifact.js";
import {
  buildAdjustmentRainHistoricalRows,
} from "./adjustment_rain_control_reference.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import {
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";

export const ADJUSTMENT_RAIN_MONTHLY_FIT_ASSEMBLY_VERSION =
  "adjustment-rain-monthly-fit-assembly/v1";
export const ADJUSTMENT_RAIN_DEVELOPMENT_POPULATION_VERSION =
  "rain-maintenance-development-population/v3";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/u;
const CYCLE_HOURS = Object.freeze([0, 6, 12, 18]);
const SOURCE_MODEL_LEADS = Object.freeze(Array.from({ length: 23 }, (_unused, index) => index + 9));
const OPERATIONAL_HORIZONS = Object.freeze(Array.from({ length: 23 }, (_unused, index) => index + 1));
const FEATURE_NAMES = Object.freeze(JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON).featureNames);
const POPULATION_MEMBER_KEYS = Object.freeze([
  "issuedAt", "key", "modelLeadHours", "operationalHorizonHours", "phaseEligible",
  "sourceMemberSha256", "sourceReceiptSha256", "targetAvailable", "validAt",
]);

// assemble one authenticated future-only rain fit request
export function buildAdjustmentRainMonthlyFitAssembly(input) {
  exact(input, ["dueMonth", "epochWitness", "historicalProjection"],
    "rain monthly assembly input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  month(input.dueMonth);
  const assembled = buildAdjustmentRainHistoricalRows({
    dueMonth: input.dueMonth,
    epochWitness: witness,
    projection: input.historicalProjection,
  });
  const population = buildAdjustmentRainDevelopmentPopulationV3({
    dueMonth: input.dueMonth,
    populationMembers: assembled.populationMembers,
    rows: assembled.rows,
  });
  const common = {
    contractVersion: ADJUSTMENT_RAIN_MONTHLY_FIT_ASSEMBLY_VERSION,
    cutoffAt: input.historicalProjection.cutoffAt,
    developmentEndAt: population.developmentEndAt,
    developmentPopulation: population,
    developmentStartAt: population.developmentStartAt,
    dueMonth: input.dueMonth,
    epochWitnessSha256: witness.witnessSha256,
    family: "rain",
    historicalMemberRootSha256: input.historicalProjection.memberRootSha256,
    sourceMemberRootSha256: assembled.sourceMemberRootSha256,
    sourceReceiptRootSha256: assembled.sourceReceiptRootSha256,
  };

  // return an honest noncandidate before any native fit when source custody is incomplete
  if (population.missingSourceRowCount > 0 || population.missingTargetRowCount > 0) {
    return validateAdjustmentRainMonthlyFitAssembly(Object.freeze({
      ...common,
      reason: population.missingSourceRowCount > 0
        ? "incomplete_development_population"
        : "incomplete_development_target",
      state: "no_candidate",
    }));
  }
  const developmentKeys = new Set(population.sourcePopulation.filter(
    // fit only source-eligible rows whose actual native target is present
    (member) => member.phaseEligible && member.targetAvailable,
  ).map((member) => member.key));
  const fitInput = Object.freeze({
    contractVersion: "rain-maintenance-fit-input/v3",
    developmentPopulation: population,
    developmentRows: Object.freeze(assembled.rows.filter(
      // reserve the exact full-year target interval for the original grid
      (row) => developmentKeys.has(row.key),
    )),
    featureNames: FEATURE_NAMES,
    month: input.dueMonth,
    trainingRows: Object.freeze(assembled.rows.filter(
      // train only on target rows strictly before the development interval
      (row) => row.validAt < population.developmentStartAt,
    )),
  });
  return validateAdjustmentRainMonthlyFitAssembly(Object.freeze({
    ...common,
    fitInput,
    inputManifestSha256: adjustmentSha256(canonicalJsonBytes(fitInput)),
    state: "ready",
  }));
}

// derive one explicit annual value-blind source population
export function buildAdjustmentRainDevelopmentPopulationV3(input) {
  exact(input, ["dueMonth", "populationMembers", "rows"],
    "rain development population input");
  const { developmentEndAt, developmentStartAt } = developmentInterval(input.dueMonth);
  // reject non-array source or target populations
  if (!Array.isArray(input.populationMembers) || !Array.isArray(input.rows)) {
    throw new TypeError("rain development population arrays are invalid");
  }
  const expected = expectedPopulationKeys(developmentStartAt, developmentEndAt);
  const observed = new Map();

  // validate every compact archive-derived source member before interval selection
  for (const member of input.populationMembers) {
    validatePopulationMember(member);
    const previous = observed.get(member.key);
    // reject contradictory revisions instead of choosing by target availability
    if (previous !== undefined && !canonicalJsonBytes(previous).equals(canonicalJsonBytes(member))) {
      throw new Error("rain development source member differs");
    }
    observed.set(member.key, member);
  }
  const sourcePopulation = [];
  let missingSourceRowCount = 0;
  let missingTargetRowCount = 0;

  // preserve expected key order without inspecting any target values
  for (const expectedMember of expected.values()) {
    const member = observed.get(expectedMember.key);
    // count absent source rows without inventing a placeholder identity
    if (member === undefined) {
      missingSourceRowCount += 1;
      continue;
    }
    // require the archive member to match exact cycle and horizon geometry
    if (member.issuedAt !== expectedMember.issuedAt ||
      member.modelLeadHours !== expectedMember.modelLeadHours ||
      member.operationalHorizonHours !== expectedMember.operationalHorizonHours ||
      member.validAt !== expectedMember.validAt) {
      throw new Error("rain development source geometry differs");
    }
    sourcePopulation.push(member);
    // a source-eligible row without a genuine target keeps the month noncandidate
    if (member.phaseEligible && !member.targetAvailable) {
      missingTargetRowCount += 1;
    }
  }
  const rowsByKey = new Map();

  // bind each eligible target row to one compact source identity
  for (const row of input.rows) {
    // prohibit duplicate joined targets
    if (rowsByKey.has(row.key)) {
      throw new Error("rain development target row is duplicated");
    }
    rowsByKey.set(row.key, row);
  }
  for (const member of sourcePopulation) {
    // missing joined rows cannot be concealed by targetAvailable metadata
    if (member.phaseEligible && member.targetAvailable && !rowsByKey.has(member.key)) {
      missingTargetRowCount += 1;
    }
  }
  const proof = {
    contractVersion: ADJUSTMENT_RAIN_DEVELOPMENT_POPULATION_VERSION,
    cycleHours: CYCLE_HOURS,
    developmentEndAt,
    developmentStartAt,
    eligibleRowCount: sourcePopulation.filter((member) => member.phaseEligible).length,
    excludedColdRowCount: sourcePopulation.filter((member) => !member.phaseEligible).length,
    expectedRowCount: expected.size,
    missingSourceRowCount,
    missingTargetRowCount,
    observedRowCount: sourcePopulation.length,
    operationalHorizonHours: OPERATIONAL_HORIZONS,
    populationMemberRootSha256: adjustmentSha256(canonicalJsonBytes(
      sourcePopulation.map((member) => member.sourceMemberSha256).sort(),
    )),
    populationReceiptRootSha256: adjustmentSha256(canonicalJsonBytes(
      [...new Set(sourcePopulation.map((member) => member.sourceReceiptSha256))].sort(),
    )),
    populationSha256: adjustmentSha256(canonicalJsonBytes(sourcePopulation)),
    sourceModelLeadHours: SOURCE_MODEL_LEADS,
    sourcePopulation: Object.freeze(sourcePopulation),
  };
  return Object.freeze(proof);
}

// validate one ready or explicitly incomplete rain assembly
export function validateAdjustmentRainMonthlyFitAssembly(value) {
  const ready = value?.state === "ready";
  exact(value, ready
    ? ["contractVersion", "cutoffAt", "developmentEndAt", "developmentPopulation",
      "developmentStartAt", "dueMonth", "epochWitnessSha256", "family", "fitInput",
      "historicalMemberRootSha256", "inputManifestSha256", "sourceMemberRootSha256",
      "sourceReceiptRootSha256", "state"]
    : ["contractVersion", "cutoffAt", "developmentEndAt", "developmentPopulation",
      "developmentStartAt", "dueMonth", "epochWitnessSha256", "family",
      "historicalMemberRootSha256", "reason", "sourceMemberRootSha256",
      "sourceReceiptRootSha256", "state"], "rain monthly fit assembly");
  month(value.dueMonth);
  // require every archived and input identity hash
  for (const field of ["epochWitnessSha256", "historicalMemberRootSha256",
    "sourceMemberRootSha256", "sourceReceiptRootSha256"]) {
    hash(value[field], `rain monthly ${field}`);
  }
  // retain one exact rain-only contract and annual proof identity
  if (value.contractVersion !== ADJUSTMENT_RAIN_MONTHLY_FIT_ASSEMBLY_VERSION ||
    value.family !== "rain" || value.developmentPopulation?.contractVersion !==
      ADJUSTMENT_RAIN_DEVELOPMENT_POPULATION_VERSION ||
    value.developmentStartAt !== value.developmentPopulation.developmentStartAt ||
    value.developmentEndAt !== value.developmentPopulation.developmentEndAt) {
    throw new Error("rain monthly fit assembly identity differs");
  }
  // validate disjoint ready and incomplete result shapes
  if (ready) {
    hash(value.inputManifestSha256, "rain monthly input manifest");
    // bind the ready assembly to the exact runner input
    if (value.fitInput?.contractVersion !== "rain-maintenance-fit-input/v3" ||
      value.fitInput.developmentPopulation !== value.developmentPopulation ||
      value.inputManifestSha256 !== adjustmentSha256(canonicalJsonBytes(value.fitInput)) ||
      value.developmentPopulation.missingSourceRowCount !== 0 ||
      value.developmentPopulation.missingTargetRowCount !== 0) {
      throw new Error("rain monthly ready input differs");
    }
  // permit only the two truthful source incompleteness states
  } else if (value.state !== "no_candidate" ||
    !["incomplete_development_population", "incomplete_development_target"].includes(value.reason)) {
    throw new Error("rain monthly noncandidate state differs");
  }
  return Object.freeze(value);
}

// derive one full utc calendar year ending at the embargo boundary
function developmentInterval(dueMonth) {
  month(dueMonth);
  const monthStart = new Date(`${dueMonth}-01T00:00:00.000Z`);
  const end = new Date(monthStart.getTime() - 7 * DAY);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  return Object.freeze({ developmentEndAt: end.toISOString(),
    developmentStartAt: start.toISOString() });
}

// enumerate every cycle and source lead whose target lies inside the year
function expectedPopulationKeys(developmentStartAt, developmentEndAt) {
  const start = Date.parse(developmentStartAt);
  const end = Date.parse(developmentEndAt);
  const firstRun = Math.floor((start - 31 * HOUR) / (6 * HOUR)) * 6 * HOUR;
  const expected = new Map();

  // retain the issuance halo needed by targets at both year boundaries
  for (let run = firstRun; run <= end - 9 * HOUR; run += 6 * HOUR) {
    const runInitializedAt = new Date(run).toISOString();
    const issuedAt = new Date(run + 8 * HOUR).toISOString();
    // enumerate the unchanged source leads as operational horizons one through twenty-three
    for (const modelLeadHours of SOURCE_MODEL_LEADS) {
      const valid = run + modelLeadHours * HOUR;
      // omit only targets outside the half-open year
      if (valid < start || valid >= end) {
        continue;
      }
      const validAt = new Date(valid).toISOString();
      const value = Object.freeze({ issuedAt, key: `${runInitializedAt}/${validAt}`,
        modelLeadHours, operationalHorizonHours: modelLeadHours - 8, validAt });
      expected.set(value.key, value);
    }
  }
  return expected;
}

// validate one compact archive-derived source identity
function validatePopulationMember(value) {
  exact(value, POPULATION_MEMBER_KEYS, "rain development population member");
  instant(value.issuedAt, "rain development issuedAt");
  instant(value.validAt, "rain development validAt");
  hash(value.sourceMemberSha256, "rain development source member");
  hash(value.sourceReceiptSha256, "rain development source receipt");
  // retain only exact geometry and bounded value-blind fields
  if (typeof value.key !== "string" || value.key.length > 128 ||
    typeof value.phaseEligible !== "boolean" || typeof value.targetAvailable !== "boolean" ||
    !SOURCE_MODEL_LEADS.includes(value.modelLeadHours) ||
    value.operationalHorizonHours !== value.modelLeadHours - 8) {
    throw new TypeError("rain development population member differs");
  }
}

// require one exact object field set
function exact(value, fields, label) {
  // reject nonobjects and field drift together
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new TypeError(`${label} fields differ`);
  }
}

// require one canonical due month
function month(value) {
  // reject normalized or out-of-range months
  if (typeof value !== "string" || !MONTH.test(value) ||
    new Date(`${value}-01T00:00:00.000Z`).toISOString().slice(0, 7) !== value) {
    throw new TypeError("rain due month differs");
  }
}

// require one canonical instant
function instant(value, label) {
  // reject normalized or malformed timestamps
  if (typeof value !== "string" || !INSTANT.test(value) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} differs`);
  }
}

// require one lowercase sha256 identity
function hash(value, label) {
  // reject noncanonical digests
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} differs`);
  }
}
