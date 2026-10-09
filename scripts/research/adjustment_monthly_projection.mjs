import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "./adjustment-maintenance-runtime/node_modules/@weather/domain/dist/forecast-adjustment.js";
import {
  canonicalSha256,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  scalarNetworkActual,
} from "./adjustment-maintenance-runtime/forecast/algorithm-v1.js";
import {
  localCalendarFeaturesFor,
} from "./adjustment-maintenance-runtime/forecast/calendar.js";
import {
  decodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  projectForecastAdjustmentMaintenanceTemperatureTargets,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import {
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";

export const ADJUSTMENT_MONTHLY_FIT_ASSEMBLY_CONTRACT_VERSION =
  "adjustment-monthly-fit-input-assembly/v1";

const DAY = 86_400_000;
const HASH = /^[a-f0-9]{64}$/u;
const MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/u;
const TEMPERATURE_DEVELOPMENT_DATES = 90;
const WIND_EPOCH_DATES = 402;

// assemble one exact family fitter input from authenticated future-only history
export function buildAdjustmentMonthlyFitAssembly(input) {
  requireExactKeys(input, [
    "dueMonth", "epochWitness", "family", "historicalProjection", "incumbent",
  ], "monthly fit assembly input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requireMonth(input.dueMonth);
  validateHistoricalProjection(input.historicalProjection, input.family,
    input.dueMonth, witness.witnessSha256);
  const fitInput = input.family === "temperature"
    ? buildTemperatureFitInput(input.historicalProjection, input.incumbent,
        input.dueMonth)
    : input.family === "wind"
      ? buildWindFitInput(input.historicalProjection, input.incumbent,
          input.dueMonth, witness)
      : null;
  // refuse rain here because its pre-target control projection has a distinct fitter
  if (fitInput === null) {
    throw new TypeError("monthly fit assembly family is invalid");
  }
  const value = {
    contractVersion: ADJUSTMENT_MONTHLY_FIT_ASSEMBLY_CONTRACT_VERSION,
    cutoffAt: input.historicalProjection.cutoffAt,
    dueMonth: input.dueMonth,
    epochWitnessSha256: witness.witnessSha256,
    family: input.family,
    fitInput,
    historicalMemberRootSha256: input.historicalProjection.memberRootSha256,
    inputManifestSha256: adjustmentSha256(canonicalJsonBytes(fitInput)),
  };
  return validateAdjustmentMonthlyFitAssembly(value);
}

// validate one closed monthly assembly and its exact private fit-input identity
export function validateAdjustmentMonthlyFitAssembly(value) {
  requireExactKeys(value, [
    "contractVersion", "cutoffAt", "dueMonth", "epochWitnessSha256", "family",
    "fitInput", "historicalMemberRootSha256", "inputManifestSha256",
  ], "monthly fit assembly");
  requireMonth(value.dueMonth);
  requireInstant(value.cutoffAt, "monthly fit cutoff");
  for (const field of [
    "epochWitnessSha256", "historicalMemberRootSha256", "inputManifestSha256",
  ]) {
    requireHash(value[field], `monthly fit ${field}`);
  }
  // bind only the two reviewed fit contracts to the assembly identity
  if (value.contractVersion !== ADJUSTMENT_MONTHLY_FIT_ASSEMBLY_CONTRACT_VERSION ||
    !["temperature", "wind"].includes(value.family) ||
    value.fitInput?.contractVersion !== `${value.family}-maintenance-fit-input/v2` ||
    value.inputManifestSha256 !== adjustmentSha256(canonicalJsonBytes(value.fitInput))) {
    throw new Error("monthly fit assembly identity differs");
  }
  return Object.freeze(value);
}

// build exact temperature rows from native source, best match and physical targets
function buildTemperatureFitInput(projection, incumbent, dueMonth) {
  validateIncumbent(incumbent, "temperature");
  const targetMembers = projection.projectionMembers.filter(
    // select only physical target revisions
    (member) => member.projectionKind === "target_revision",
  );
  const targetRows = temperatureTargetRows(targetMembers);
  const nativeMembers = projection.projectionMembers.filter(
    // select only source-decision-frozen temperature runs
    (member) => member.projectionKind === "native_source",
  );
  const bestMatchByTuple = temperatureBestMatchMembers(projection.projectionMembers);
  const nativeDocuments = new Map();
  const rows = [];

  // retain each complete native body once while preserving its selected row members
  for (const member of nativeMembers) {
    if (member.document.contractVersion !==
        "adjustment-temperature-native-source-projection/v2" ||
      member.document.family !== "temperature") {
      throw new Error("temperature monthly native projection is unavailable");
    }
    const existing = nativeDocuments.get(member.payloadIdentitySha256);
    // reject one payload identity resolving to different parsed documents
    if (existing !== undefined && existing.document !== member.document &&
      !canonicalJsonBytes(existing.document).equals(canonicalJsonBytes(member.document))) {
      throw new Error("temperature monthly native projection is ambiguous");
    }
    const selected = existing ?? { document: member.document, members: [] };
    selected.members.push(member);
    nativeDocuments.set(member.payloadIdentitySha256, selected);
  }

  // replay each frozen source decision without requiring a prior shadow candidate
  for (const selected of nativeDocuments.values()) {
    const source = selected.document;
    const replayedState = replayTemperatureRecentErrorState({
      nativeMembers,
      targetRows,
      targetRunInitializedAt: source.logicalKey.runInitializedAt,
    });
    // require the source-decision state bytes and identity to match independent replay
    if (!canonicalJsonBytes(replayedState).equals(canonicalJsonBytes(source.recentErrorState)) ||
      temperatureRecentErrorStateSha256(replayedState) !== source.recentErrorStateSha256) {
      throw new Error("temperature monthly recent-error state differs");
    }
    // consume only the archived row members admitted by the historical projection
    for (const native of selected.members) {
      const row = native.row;
      // omit the non-serving native warmup horizon rather than inventing comparators
      if (row.modelLeadHours < 7) {
        continue;
      }
      const bestMatch = bestMatchByTuple.get(temperatureBestMatchKey({
        contentSha256: row.bestMatchContentSha256,
        productRunAt: row.bestMatchProductRunAt,
        sourceId: row.bestMatchSourceId,
        validAt: row.validAt,
      }));
      const target = temperatureNetworkTargetAt(targetRows, row.validAt,
        projection.cutoffAt);
      // prohibit a source row lacking any authenticated causal class
      if (bestMatch === undefined || target === null ||
        row.bestMatchContentSha256 === null || row.bestMatchProductRunAt === null ||
        row.bestMatchSourceId === null || row.bestMatchTemperatureC64 === null ||
        bestMatch.row.temperatureC64 === null ||
        bestMatch.row.temperatureC64 !== row.bestMatchTemperatureC64) {
        throw new Error("temperature monthly projection is incomplete");
      }
      // require the exact best-match row to exist by the frozen native decision
      if (bestMatch.document.logicalReceivedAt > source.logicalReceivedAt ||
        bestMatch.receipt.archiveCommittedAt > source.logicalReceivedAt) {
        throw new Error("temperature monthly best-match receipt is late");
      }
      const sourceReceiptAt = [native.receipt.archiveCommittedAt,
        bestMatch.receipt.archiveCommittedAt].sort().at(-1);
      // keep every fit receipt strictly earlier than the original monthly cutoff
      if (sourceReceiptAt >= projection.cutoffAt ||
        target.maximumTargetReceiptAt >= projection.cutoffAt) {
        throw new Error("temperature monthly receipt exceeds its cutoff");
      }
      rows.push(Object.freeze({
        actualTemperatureC: target.actualTemperatureC,
        adapterVersion: source.source.adapterVersion,
        cohort: "ecmwf_single_run_hindcast",
        evidenceClass: "development",
        firstReceivedAt: source.logicalReceivedAt,
        key: native.memberSha256,
        modelCycle: row.modelCycle,
        modelLeadHours: row.modelLeadHours,
        operationalHorizonHours: row.modelLeadHours - 6,
        providerResponseSha256: source.logicalKey.providerResponseSha256,
        rawBestMatchTemperatureC: decodeMaintenanceBinary64(
          bestMatch.row.temperatureC64),
        rawRelativeHumidityPercent: decodeNullable(row.rawRelativeHumidityPercent64),
        rawTemperatureC: decodeMaintenanceBinary64(row.rawTemperatureC64),
        rawWindSpeedMps: decodeNullable(row.rawWindSpeedMps64),
        runInitializedAt: source.logicalKey.runInitializedAt,
        sourceReceiptAt,
        state: replayedState,
        targetMaxReceiptAt: target.maximumTargetReceiptAt,
        validAt: row.validAt,
      }));
    }
  }
  rows.sort(compareFitRow);
  const dates = [...new Set(rows.map((row) => localCalendarFeaturesFor(row.validAt).localDate))]
    .sort();
  const developmentDates = new Set(dates.slice(-TEMPERATURE_DEVELOPMENT_DATES));
  return Object.freeze({
    contractVersion: "temperature-maintenance-fit-input/v2",
    developmentRows: Object.freeze(rows.filter(
      // reserve the final ninety earlier-only dates for development
      (row) => developmentDates.has(localCalendarFeaturesFor(row.validAt).localDate),
    )),
    incumbentModel: incumbent.model,
    month: dueMonth,
    trainingRows: Object.freeze(rows.filter(
      // fit final coefficients only on dates outside development
      (row) => !developmentDates.has(localCalendarFeaturesFor(row.validAt).localDate),
    )),
  });
}

// authenticate physical target bodies and bind every row to its database receipt
function temperatureTargetRows(members) {
  const bodies = new Map();
  const projectedByBody = new Map();
  // retain one parser-verified body for every exact payload identity
  for (const member of members) {
    bodies.set(member.payloadIdentitySha256, member.payloadBytes);
  }
  // parse bodies separately so historical revisions cannot collide across payloads
  for (const [identity, bytes] of bodies) {
    projectedByBody.set(identity,
      projectForecastAdjustmentMaintenanceTemperatureTargets({
        projectionBytes: [bytes],
      }).stationRows);
  }
  return Object.freeze(members.map((member) => {
    const matches = projectedByBody.get(member.payloadIdentitySha256).filter(
      // crossbind the selected row to the independently parsed target body
      (row) => row.contentSha256 === member.row.contentSha256 &&
        row.sourceKey === member.document.source.sourceKey &&
        row.validAt === member.row.validAt,
    );
    // refuse an absent or ambiguous raw target member
    if (matches.length !== 1) {
      throw new Error("temperature monthly target member differs");
    }
    return Object.freeze({
      ...matches[0],
      archiveCommitOrdinal: member.receipt.archiveCommitOrdinal,
      archiveCommittedAt: member.receipt.archiveCommittedAt,
      logicalReceivedAt: member.document.logicalReceivedAt,
      sourceId: member.document.logicalKey.sourceId,
    });
  }));
}

// index only full best-match logical tuples rather than valid-time aliases
function temperatureBestMatchMembers(members) {
  const byTuple = new Map();
  // admit only authenticated actual best-match projection members
  for (const member of members.filter(
    (candidate) => candidate.projectionKind === "actual_best_match")) {
    const key = temperatureBestMatchKey({
      contentSha256: member.row.contentSha256,
      productRunAt: member.document.logicalKey.productRunAt,
      sourceId: member.document.logicalKey.sourceId,
      validAt: member.row.validAt,
    });
    // reject duplicate receipt authority for one exact source tuple
    if (byTuple.has(key)) {
      throw new Error("temperature monthly best-match tuple is duplicated");
    }
    byTuple.set(key, member);
  }
  return byTuple;
}

// encode one exact best-match source and content identity
function temperatureBestMatchKey(value) {
  return [value.sourceId, value.productRunAt, value.validAt, value.contentSha256]
    .join("\n");
}

// replay the original causal seventy-two-hour recent-error recipe
function replayTemperatureRecentErrorState(input) {
  const targetMilliseconds = Date.parse(input.targetRunInitializedAt);
  const windowEndValidAt = new Date(targetMilliseconds - 7 * 3_600_000).toISOString();
  const windowStart = Date.parse(windowEndValidAt) - 71 * 3_600_000;
  const priorByValidAt = new Map();
  // select the latest genuinely available lead-seven-to-eighteen source at each hour
  for (const member of input.nativeMembers) {
    const document = member.document;
    const runInitializedAt = document.logicalKey.runInitializedAt;
    const validMilliseconds = Date.parse(member.row.validAt);
    if (document.contractVersion !== "adjustment-temperature-native-source-projection/v2" ||
      member.row.modelLeadHours < 7 || member.row.modelLeadHours > 18 ||
      runInitializedAt >= input.targetRunInitializedAt ||
      document.logicalReceivedAt > input.targetRunInitializedAt ||
      member.receipt.archiveCommittedAt > input.targetRunInitializedAt ||
      validMilliseconds < windowStart || validMilliseconds > Date.parse(windowEndValidAt)) {
      continue;
    }
    const current = priorByValidAt.get(member.row.validAt);
    // mirror the database's latest prior run selection with ordinal tie-breaking
    if (current === undefined || runInitializedAt > current.runInitializedAt ||
      runInitializedAt === current.runInitializedAt &&
        BigInt(member.receipt.archiveCommitOrdinal) >
          BigInt(current.member.receipt.archiveCommitOrdinal)) {
      priorByValidAt.set(member.row.validAt, { member, runInitializedAt });
    }
  }
  const selected = [];
  // replay all exact inclusive state hours in chronological order
  for (let validMilliseconds = windowStart;
    validMilliseconds <= Date.parse(windowEndValidAt);
    validMilliseconds += 3_600_000) {
    const validAt = new Date(validMilliseconds).toISOString();
    const prior = priorByValidAt.get(validAt);
    const target = temperatureNetworkTargetAt(input.targetRows, validAt,
      input.targetRunInitializedAt);
    // retain only causal hours with both forecast and physical network target
    if (prior === undefined || target === null) {
      continue;
    }
    selected.push(Object.freeze({
      errorC: target.actualTemperatureC -
        decodeMaintenanceBinary64(prior.member.row.rawTemperatureC64),
      key: `${prior.runInitializedAt}/${validAt}`,
      runInitializedAt: prior.runInitializedAt,
      validAt,
    }));
  }
  const shortStart = Date.parse(windowEndValidAt) - 23 * 3_600_000;
  const short = selected.filter((item) => Date.parse(item.validAt) >= shortStart);
  const localDates = new Set(selected.map(
    (item) => localCalendarFeaturesFor(item.validAt).localDate));
  const shortSupported = short.length >= 6;
  const longSupported = selected.length >= 24;
  const rawB72 = longSupported ? numericMedian(selected.map((item) => item.errorC)) : null;
  return Object.freeze({
    b24C: shortSupported
      ? clipTemperatureState(numericMedian(short.map((item) => item.errorC)))
      : null,
    b72C: rawB72 === null ? null : clipTemperatureState(rawB72),
    cohort: "ecmwf_single_run_hindcast",
    localDates: localDates.size,
    mad72C: rawB72 === null ? null : Math.min(6,
      numericMedian(selected.map((item) => Math.abs(item.errorC - rawB72)))),
    maximumSourceRunInitializedAt: selected.length === 0 ? null : selected.reduce(
      (maximum, item) => item.runInitializedAt > maximum
        ? item.runInitializedAt : maximum,
      selected[0].runInitializedAt),
    maximumSourceValidAt: selected.at(-1)?.validAt ?? null,
    n24: short.length,
    n72: selected.length,
    sourceKeys: Object.freeze(selected.map((item) => item.key)),
    supported: shortSupported && longSupported && localDates.size >= 2,
    targetRunInitializedAt: input.targetRunInitializedAt,
    windowEndValidAt,
  });
}

// select one deterministic physical-network target available by a causal clock
function temperatureNetworkTargetAt(rows, validAt, asOf) {
  const currentBySourceClock = new Map();
  // retain the last archived content revision for each physical source clock
  for (const row of rows) {
    if (row.logicalReceivedAt > asOf || row.archiveCommittedAt > asOf) {
      continue;
    }
    const key = `${row.sourceId}\n${row.validAt}`;
    const current = currentBySourceClock.get(key);
    // prefer the database's later global ordinal for one logical source row
    if (current === undefined || BigInt(row.archiveCommitOrdinal) >
      BigInt(current.archiveCommitOrdinal)) {
      currentBySourceClock.set(key, row);
    }
  }
  const targetMilliseconds = Date.parse(validAt);
  const selected = [];
  // choose the closest earlier-tied raw observation for every frozen station
  for (const station of FORECAST_OBSERVATION_STATIONS) {
    const candidates = [...currentBySourceClock.values()].filter((row) =>
      row.physicalStationKey === station.key && row.temperatureC64 !== null &&
      Date.parse(row.validAt) >= targetMilliseconds - 5 * 60_000 &&
      Date.parse(row.validAt) < targetMilliseconds + 5 * 60_000);
    candidates.sort((left, right) => {
      const clockOrder = Math.abs(Date.parse(left.validAt) - targetMilliseconds) -
        Math.abs(Date.parse(right.validAt) - targetMilliseconds) ||
        left.validAt.localeCompare(right.validAt);
      // use stable database source identity only after the original clock rules tie
      if (clockOrder !== 0) {
        return clockOrder;
      }
      return BigInt(left.sourceId) < BigInt(right.sourceId) ? -1 :
        BigInt(left.sourceId) > BigInt(right.sourceId) ? 1 : 0;
    });
    // preserve missing station measurements without imputation
    if (candidates[0] !== undefined) {
      selected.push(candidates[0]);
    }
  }
  const actual = scalarNetworkActual(selected.map((row) => {
    const station = FORECAST_OBSERVATION_STATIONS.find(
      (candidate) => candidate.key === row.physicalStationKey);
    return {
      nearestRank: station.nearestRank,
      physicalStationKey: station.key,
      unnormalizedSpatialWeight: station.unnormalizedSpatialWeight,
      value: decodeMaintenanceBinary64(row.temperatureC64),
    };
  }));
  // refuse incomplete physical coverage instead of synthesizing a target
  if (actual === null) {
    return null;
  }
  return Object.freeze({
    actualTemperatureC: actual.value,
    maximumTargetReceiptAt: selected.map((row) => row.archiveCommittedAt).sort().at(-1),
  });
}

// hash the exact database-ordered recent-error state preimage
function temperatureRecentErrorStateSha256(state) {
  return adjustmentSha256(Buffer.from(JSON.stringify(state)));
}

// calculate one deterministic numeric median
function numericMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  // average the two center values for an even population
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

// retain the original signed rolling-state cap
function clipTemperatureState(value) {
  return Math.max(-6, Math.min(6, value));
}

// build one disjoint archive-derived wind manifest and exact sanitized rows
function buildWindFitInput(projection, incumbent, dueMonth, witness) {
  if (incumbent !== null) {
    throw new TypeError("wind monthly incumbent input must be null");
  }
  const rows = [];
  const members = [];
  const openedMembers = [];
  const targetReceiptByValidAt = maximumReceiptByValidAt(
    projection.projectionMembers.filter(
      // identify actual target availability for every forecast member
      (member) => member.projectionKind === "target_revision",
    ),
  );

  // project only database-backed forecast and physical-target rows
  for (const member of projection.projectionMembers) {
    if (!["actual_best_match", "target_revision"].includes(member.projectionKind)) {
      continue;
    }
    const row = member.row;
    const localDate = localCalendarFeaturesFor(row.validAt).localDate;
    const targetReceiptAt = targetReceiptByValidAt.get(row.validAt);
    // require one future-only physical target before opening any forecast member
    if (targetReceiptAt === undefined) {
      throw new Error("wind monthly target receipt is unavailable");
    }
    const sanitized = member.projectionKind === "actual_best_match"
      ? windForecastRow(member)
      : windTargetRow(member);
    rows.push(sanitized);
    const kind = member.projectionKind === "actual_best_match" ? "forecast" : "target";
    members.push(Object.freeze({
      localDate,
      maxValidAt: row.validAt,
      minValidAt: row.validAt,
      path: `archive-members/${localDate}/${kind}/${member.memberSha256}`,
      plaintextBytes: member.payloadBytes.length,
      recordKind: member.projectionKind,
      rowCount: 1,
      sha256: member.memberSha256,
      sizeBytes: member.payloadBytes.length,
      stationKey: sanitized.recordKind === "station_hour"
        ? sanitized.physicalStationKey : null,
    }));
    openedMembers.push(Object.freeze({
      maximumSourceReceiptAt: member.receipt.archiveCommittedAt,
      maximumTargetReceiptAt: targetReceiptAt,
      memberSha256: member.memberSha256,
    }));
  }
  members.sort((left, right) => left.path.localeCompare(right.path));
  openedMembers.sort((left, right) => left.memberSha256.localeCompare(right.memberSha256));
  const cutoffDate = localCalendarFeaturesFor(
    new Date(Date.parse(projection.cutoffAt) - 1).toISOString(),
  ).localDate;
  const selectedDates = trailingLocalDates(cutoffDate, WIND_EPOCH_DATES);
  const selected = new Set(selectedDates);
  const selectedMembers = members.filter((member) => selected.has(member.localDate));
  const selectedMemberIdentities = new Set(selectedMembers.map((member) => member.sha256));
  const selectedRows = rows.filter((row) => selected.has(
    localCalendarFeaturesFor(row.validAt).localDate));
  const selectedOpened = openedMembers.filter((member) =>
    selectedMemberIdentities.has(member.memberSha256));
  const covered = new Set(selectedMembers
    .filter((member) => member.recordKind === "actual_best_match")
    .map((member) => member.localDate));
  // require a genuine served forecast member on every fixed epoch date
  if (selectedDates.some((date) => !covered.has(date))) {
    throw new Error("wind monthly archive epoch is incomplete");
  }
  const selectedProjectionMembers = projection.projectionMembers.filter((member) =>
    selectedMemberIdentities.has(member.memberSha256));
  const receipts = selectedProjectionMembers.map((member) =>
    member.receipt.receiptSha256).sort();
  const sourceLineages = selectedProjectionMembers.map((member) =>
    member.document.source).sort(compareCanonical);
  const manifest = Object.freeze({
    aggregationContractSha256: adjustmentSha256(canonicalJsonBytes(receipts)),
    contractVersion: "adjustment-wind-archive-fit-manifest/v2",
    coordinateManifestSha256: adjustmentSha256(canonicalJsonBytes(selectedMembers.map(
      // bind every row position to its actual database-backed member identity
      (member) => [member.localDate, member.recordKind, member.sha256],
    ))),
    epochWitnessSha256: witness.witnessSha256,
    fromLocalDate: selectedDates[0],
    historyRootSha256: projection.historyRootSha256,
    members: Object.freeze(selectedMembers),
    metricEligibilitySha256: adjustmentSha256(canonicalJsonBytes([
      "windGustMps", "windSpeedMps",
    ])),
    sourceLineageSha256: adjustmentSha256(canonicalJsonBytes(sourceLineages)),
    spatialWeightsSha256: adjustmentSha256(canonicalJsonBytes(
      FORECAST_OBSERVATION_STATIONS.map((station) => ({
        key: station.key,
        nearestRank: station.nearestRank,
        unnormalizedSpatialWeight: station.unnormalizedSpatialWeight,
      })),
    )),
    stationManifestSha256: adjustmentSha256(canonicalJsonBytes(
      FORECAST_OBSERVATION_STATIONS,
    )),
    toLocalDate: selectedDates.at(-1),
    totalRowCount: selectedMembers.length,
  });
  return Object.freeze({
    contractVersion: "wind-maintenance-fit-input/v2",
    dueMonth,
    manifest,
    openedMembers: Object.freeze(selectedOpened),
    rows: Object.freeze(selectedRows),
    snapshotManifestSha256: canonicalSha256(manifest),
  });
}

// map one actual best-match row to the fitter's immutable forecast shape
function windForecastRow(member) {
  const row = member.row;
  const referenceAt = member.document.logicalKey.productRunAt;
  const targetLeadHours = Math.ceil(
    (Date.parse(row.validAt) - Date.parse(referenceAt)) / 3_600_000,
  );
  return Object.freeze({
    adapterContracts: Object.freeze([member.document.source.adapterVersion]),
    adapterVersion: member.document.source.adapterVersion,
    collisionCount: 0,
    contentHashes: Object.freeze([row.contentSha256]),
    contractEpoch: member.document.source.contractEpoch,
    dataset: member.document.source.dataset,
    exclusionReasonCodes: Object.freeze([]),
    ingestionRunIds: Object.freeze([member.receipt.archiveCommitOrdinal]),
    metrics: windMetrics(row),
    physicalStationKey: null,
    providerFamily: null,
    receivedAt: member.receipt.archiveCommittedAt,
    recordKind: "legacy_v4_retrieval_snapshot",
    referenceAt,
    referenceKind: "retrieval_snapshot",
    siteKey: "ballydidean",
    sourceConfigFingerprints: Object.freeze([
      member.document.source.sourceConfigFingerprint,
    ]),
    sourceKeys: Object.freeze([member.document.source.sourceKey]),
    targetLeadHours,
    upstreamModel: member.document.source.upstreamModel,
    validAt: row.validAt,
  });
}

// map one physical target revision through the frozen source-lineage table
function windTargetRow(member) {
  const source = member.document.source;
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    // authenticate the archived source by all frozen lineage identities
    (candidate) => candidate.sourceKey === source.sourceKey &&
      candidate.adapterContract === source.adapterVersion &&
      candidate.checkedFingerprint === source.sourceConfigFingerprint,
  );
  const station = lineage === undefined ? undefined :
    FORECAST_OBSERVATION_STATIONS.find(
      // bind the source lineage to its sole physical station
      (candidate) => candidate.key === lineage.physicalStationKey,
    );
  if (lineage === undefined || station === undefined) {
    throw new Error("wind monthly physical lineage differs");
  }
  return Object.freeze({
    adapterContracts: Object.freeze([source.adapterVersion]),
    collisionCount: 0,
    contentHashes: Object.freeze([member.row.contentSha256]),
    contractEpoch: source.contractEpoch,
    dataset: null,
    exclusionReasonCodes: Object.freeze([]),
    ingestionRunIds: Object.freeze([member.receipt.archiveCommitOrdinal]),
    metrics: windMetrics(member.row),
    physicalStationKey: station.key,
    providerFamily: station.providerFamily,
    receivedAt: member.receipt.archiveCommittedAt,
    recordKind: "station_hour",
    referenceAt: null,
    referenceKind: null,
    siteKey: "ballydidean",
    sourceConfigFingerprints: Object.freeze([source.sourceConfigFingerprint]),
    sourceKeys: Object.freeze([source.sourceKey]),
    targetLeadHours: null,
    upstreamModel: null,
    validAt: member.row.validAt,
  });
}

// decode only the five bounded fitter metrics from canonical binary64 values
function windMetrics(row) {
  return Object.freeze({
    relativeHumidityPercent: decodeNullable(row.relativeHumidityPercent64),
    temperatureC: decodeNullable(row.temperatureC64),
    windDirectionDegrees: decodeNullable(row.windDirectionDegrees64),
    windGustMps: decodeNullable(row.windGustMps64),
    windSpeedMps: decodeNullable(row.windSpeedMps64),
  });
}

// derive the actual latest database receipt for each physical target clock
function maximumReceiptByValidAt(members) {
  const map = new Map();
  for (const member of members) {
    const current = map.get(member.row.validAt);
    // retain the latest server receipt rather than a payload order artifact
    if (current === undefined || current < member.receipt.archiveCommittedAt) {
      map.set(member.row.validAt, member.receipt.archiveCommittedAt);
    }
  }
  return map;
}

// enumerate one fixed trailing los angeles date range
function trailingLocalDates(endLocalDate, count) {
  const end = Date.parse(`${endLocalDate}T12:00:00.000Z`);
  return Array.from({ length: count }, (_value, index) =>
    new Date(end - (count - index - 1) * DAY).toISOString().slice(0, 10));
}

// validate the existing authenticated history projection boundary
function validateHistoricalProjection(value, family, dueMonth, witnessSha256) {
  requireExactKeys(value, [
    "classCounts", "contractVersion", "cutoffAt", "dueMonth", "epochWitnessSha256",
    "family", "historyRootSha256", "memberRootSha256", "projectionMembers",
    "rowCount", "shadowMembers",
  ], "monthly historical projection");
  if (!["temperature", "wind"].includes(family) ||
    value.contractVersion !== "adjustment-revision-fit-projection/v2" ||
    value.family !== family || value.dueMonth !== dueMonth ||
    value.epochWitnessSha256 !== witnessSha256 ||
    !Array.isArray(value.projectionMembers) || !Array.isArray(value.shadowMembers)) {
    throw new Error("monthly historical projection differs");
  }
  requireHash(value.historyRootSha256, "monthly history root");
  requireHash(value.memberRootSha256, "monthly member root");
  requireInstant(value.cutoffAt, "monthly historical cutoff");
}

// require the fixed startup-loader shape for a compiled temperature incumbent
function validateIncumbent(value, family) {
  requireExactKeys(value, [
    "artifactBytes", "artifactIdentitySha256", "authorityKind", "candidate",
    "comparatorAuthorityBytes", "family", "model", "reasonCode", "state",
  ], "monthly incumbent");
  if (value.family !== family || value.model === null ||
    typeof value.model !== "object" || Array.isArray(value.model) ||
    !Buffer.isBuffer(value.artifactBytes) || !HASH.test(value.artifactIdentitySha256)) {
    throw new Error("monthly incumbent is unavailable");
  }
}

// decode one nullable canonical binary64 value
function decodeNullable(value) {
  return value === null ? null : decodeMaintenanceBinary64(value);
}

// compare rows by causal time and immutable key
function compareFitRow(left, right) {
  return left.validAt.localeCompare(right.validAt) || left.key.localeCompare(right.key);
}

// compare canonical values without caller insertion order
function compareCanonical(left, right) {
  return canonicalJsonBytes(left).compare(canonicalJsonBytes(right));
}

// require one exact utc millisecond instant
function requireInstant(value, name) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    .test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

// require one canonical monthly identity
function requireMonth(value) {
  if (typeof value !== "string" || !MONTH.test(value)) {
    throw new TypeError("monthly fit due month is invalid");
  }
}

// require one sha256 identity
function requireHash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

// require one exact object key set
function requireExactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} is invalid`);
  }
}
