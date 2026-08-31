import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  abandonExpiredRuns,
  acquireSourceSession,
  completeBackfillIngestion,
  createDatabasePool,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
  type PublicStationConfiguration,
  type PublicStationConfigurationStation,
  type PublicStationSourceConfiguration,
} from "@weather/database";
import {
  createBackfillChunkIdentity,
  type BackfillChunkIdentity,
  type JsonValue,
  type SourceKind,
} from "@weather/domain";
import {
  PUBLIC_STATION_CHUNK_PLAN_VERSION,
  asProviderFailure,
  fetchPublicStationRange,
  publicStationBackfillDelayMilliseconds,
  publicStationAdapterVersion,
  type ProviderFetchOptions,
  type PublicStationRangeOperation,
  type PublicStationRangeRequest,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import {
  boundedWorkerError,
  combineWorkerDiagnostics,
  guardReleaseSession,
} from "./errors.js";
import { planIngestionDeadlines } from "./run-deadline.js";
import {
  sourceIdentityMatchesPublicStationConfiguration,
  type RuntimeSourceIdentity,
} from "./source-identity.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface PublicStationBackfillArguments {
  readonly dryRun: boolean;
  readonly from: string | null;
  readonly reportPath: string | null;
  readonly resume: boolean;
  readonly site: string;
  readonly sourceKeys: readonly string[];
  readonly to: string;
}

export interface PublicStationBackfillSource extends RuntimeSourceIdentity {
  readonly id: string;
  readonly sourceConfigFingerprint: string;
  readonly source: PublicStationSourceConfiguration;
  readonly station: PublicStationConfigurationStation;
}

export interface PlannedPublicStationChunk {
  readonly endDate: string;
  readonly identity: BackfillChunkIdentity;
  readonly startDate: string;
}

export interface PublicStationBackfillSourceReport {
  readonly completedChunks: number;
  readonly exitCode: 0 | 1;
  readonly failedChunk: Readonly<{
    errorCode: string;
    startDate: string;
  }> | null;
  readonly from: string;
  readonly plannedChunks: number;
  readonly records: number;
  readonly skippedChunks: number;
  readonly source: string;
  readonly to: string;
}

export interface PublicStationBackfillReport {
  readonly dryRun: boolean;
  readonly exitCode: 0 | 1;
  readonly resume: boolean;
  readonly site: string;
  readonly sources: readonly PublicStationBackfillSourceReport[];
}

interface PublicStationBackfillRepository {
  readonly abandonExpiredRuns: typeof abandonExpiredRuns;
  readonly acquireSourceSession: typeof acquireSourceSession;
  readonly completeBackfillIngestion: typeof completeBackfillIngestion;
  readonly failIngestionRun: typeof failIngestionRun;
  readonly hasSuccessfulBackfillChunk: typeof hasSuccessfulBackfillChunk;
  readonly startIngestionRun: typeof startIngestionRun;
}

interface BackfillExecutionOptions {
  readonly fetchOptions?: ProviderFetchOptions;
  readonly fetchRange?: PublicStationRangeOperation;
  readonly now?: () => Date;
  readonly repository?: PublicStationBackfillRepository;
}

const databaseRepository: PublicStationBackfillRepository = {
  abandonExpiredRuns,
  acquireSourceSession,
  completeBackfillIngestion,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
};

// parse the public-station bulk backfill contract
export function parsePublicStationBackfillArguments(
  arguments_: readonly string[],
  today = new Date(),
): PublicStationBackfillArguments {
  const values = new Map<string, string>();
  const sources: string[] = [];
  const flags = new Set<string>();
  const valueOptions = new Set(["--site", "--source", "--from", "--to", "--report"]);
  const flagOptions = new Set(["--dry-run", "--resume"]);

  // consume every documented argument
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    // guard unchecked indexing
    if (argument === undefined) {
      throw new Error("public-station backfill argument parsing failed");
    }

    // retain boolean controls
    if (flagOptions.has(argument)) {
      flags.add(argument);
      continue;
    }

    // reject unknown controls
    if (!valueOptions.has(argument)) {
      throw new Error(`unsupported public-station backfill argument: ${argument}`);
    }

    const value = arguments_[index + 1];

    // require a following value
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }

    // retain repeated source selectors
    if (argument === "--source") {
      sources.push(validateKey(value, "--source"));
    } else {
      values.set(argument, value);
    }
    index += 1;
  }

  const todayDate = today.toISOString().slice(0, 10);
  const to = validateDate(values.get("--to") ?? addUtcDays(todayDate, -1), "--to");
  const from = values.has("--from")
    ? validateDate(requireArgument(values, "--from"), "--from")
    : null;

  // reject reversed explicit ranges
  if (from !== null && from > to) {
    throw new RangeError("--from must not follow --to");
  }

  // reserve the partial current day for scheduled ingestion
  if (to >= todayDate) {
    throw new RangeError("--to must be before today");
  }

  return {
    dryRun: flags.has("--dry-run"),
    from,
    reportPath: values.get("--report") ?? null,
    resume: flags.has("--resume"),
    site: requireArgument(values, "--site"),
    sourceKeys: [...new Set(sources)],
    to,
  };
}

// plan exact bounded UTC-date chunks
export function planPublicStationBackfillChunks(
  source: PublicStationBackfillSource,
  from: string,
  to: string,
): readonly PlannedPublicStationChunk[] {
  const chunks: PlannedPublicStationChunk[] = [];
  let startDate = validateDate(from, "from");
  const finalDate = validateDate(to, "to");
  const adapterVersion = publicStationAdapterVersion(source.source.adapter);

  // cover the inclusive configured archive range
  while (startDate <= finalDate) {
    const maximumEnd = addUtcDays(
      startDate,
      source.source.maximumChunkDays - 1,
    );
    const endDate = maximumEnd < finalDate ? maximumEnd : finalDate;
    chunks.push({
      endDate,
      identity: createBackfillChunkIdentity({
        adapterVersion,
        chunkPlanVersion: PUBLIC_STATION_CHUNK_PLAN_VERSION,
        intervalEndExclusive: `${addUtcDays(endDate, 1)}T00:00:00.000Z`,
        intervalStart: `${startDate}T00:00:00.000Z`,
        requestedFromDate: from,
        requestedToDate: finalDate,
        sourceConfigFingerprint: source.sourceConfigFingerprint,
        sourceId: source.id,
      }),
      startDate,
    });
    startDate = addUtcDays(endDate, 1);
  }

  return chunks;
}

// resolve selected historical public-station sources
export async function resolvePublicStationBackfillSources(
  pool: DatabasePool,
  configuration: PublicStationConfiguration,
  sourceKeys: readonly string[],
): Promise<readonly PublicStationBackfillSource[]> {
  const configured = configuration.stations.flatMap((station) =>
    station.sources
      .filter(
        (source) =>
          source.active &&
          source.capabilities.includes("historical") &&
          (sourceKeys.length === 0 || sourceKeys.includes(source.key)),
      )
      .map((source) => ({ source, station })),
  );

  // reject unknown or non-historical selectors
  if (sourceKeys.length > 0 && configured.length !== sourceKeys.length) {
    throw new Error("one or more requested public-station sources are unavailable");
  }

  const result = await pool.query<{
    materialProviderConfig: JsonValue;
    providerKey: string;
    siteSlug: string;
    sourceConfigFingerprint: string;
    sourceId: string;
    sourceKey: string;
    sourceKind: SourceKind;
    stationSlug: string;
    timezone: string;
  }>(
    `
      SELECT
        s.material_provider_config AS "materialProviderConfig",
        p.provider_key AS "providerKey",
        si.slug AS "siteSlug",
        s.source_config_fingerprint AS "sourceConfigFingerprint",
        s.id AS "sourceId",
        s.source_key AS "sourceKey",
        s.source_kind AS "sourceKind",
        st.slug AS "stationSlug",
        si.timezone
      FROM sources s
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      WHERE si.slug = $1
        AND s.source_key = ANY($2::text[])
        AND s.active
        AND st.active
        AND si.active
        AND p.active
      ORDER BY s.source_key
    `,
    [configuration.siteKey, configured.map(({ source }) => source.key)],
  );
  const rows = new Map(result.rows.map((row) => [row.sourceKey, row]));

  return configured.map(({ source, station }) => {
    const row = rows.get(source.key);

    // require every configured database source
    if (row === undefined) {
      throw new Error(`active public-station source ${source.key} is missing`);
    }

    const resolved: PublicStationBackfillSource = {
      id: row.sourceId,
      materialProviderConfig: row.materialProviderConfig,
      providerKey: row.providerKey,
      siteSlug: row.siteSlug,
      source,
      sourceConfigFingerprint: row.sourceConfigFingerprint,
      sourceKey: row.sourceKey,
      sourceKind: row.sourceKind,
      station,
      stationSlug: row.stationSlug,
      timezone: row.timezone,
    };

    // reject database identity drift before provider I/O
    if (
      !sourceIdentityMatchesPublicStationConfiguration(
        resolved,
        configuration,
        station,
        source,
      )
    ) {
      throw new Error(`public-station source ${source.key} identity does not match configuration`);
    }

    return resolved;
  });
}

// execute one bulk public-station archive import
export async function executePublicStationBackfill(
  pool: DatabasePool,
  arguments_: PublicStationBackfillArguments,
  configuration: PublicStationConfiguration,
  sources: readonly PublicStationBackfillSource[],
  options: BackfillExecutionOptions = {},
): Promise<PublicStationBackfillReport> {
  // reject cross-site execution
  if (arguments_.site !== configuration.siteKey) {
    throw new Error("requested site does not match public-station configuration");
  }

  const reports: PublicStationBackfillSourceReport[] = [];

  // isolate every source archive
  for (const source of sources) {
    reports.push(
      await executeSourceBackfill(
        pool,
        arguments_,
        configuration,
        source,
        options,
      ),
    );
  }

  return {
    dryRun: arguments_.dryRun,
    exitCode: reports.some((report) => report.exitCode === 1) ? 1 : 0,
    resume: arguments_.resume,
    site: arguments_.site,
    sources: reports,
  };
}

// execute all chunks for one source
async function executeSourceBackfill(
  pool: DatabasePool,
  arguments_: PublicStationBackfillArguments,
  configuration: PublicStationConfiguration,
  source: PublicStationBackfillSource,
  options: BackfillExecutionOptions,
): Promise<PublicStationBackfillSourceReport> {
  // bind execution to the checked source contract
  if (
    !sourceIdentityMatchesPublicStationConfiguration(
      source,
      configuration,
      source.station,
      source.source,
    )
  ) {
    throw new Error("public-station source identity does not match configuration");
  }

  const configuredFrom = requireHistoryStart(source.source);
  const from = maximumDate(configuredFrom, arguments_.from);
  const to = minimumDate(arguments_.to, source.source.historyEndDate);
  const chunks = from > to ? [] : planPublicStationBackfillChunks(source, from, to);
  const repository = options.repository ?? databaseRepository;
  let completedChunks = 0;
  let records = 0;
  let skippedChunks = 0;
  let failedChunk: PublicStationBackfillSourceReport["failedChunk"] = null;

  // execute every exact chunk independently
  for (const [chunkIndex, chunk] of chunks.entries()) {
    // satisfy exact-success resume semantics
    if (
      arguments_.resume &&
      await repository.hasSuccessfulBackfillChunk(pool, chunk.identity)
    ) {
      skippedChunks += 1;
      continue;
    }

    // prove dry-run has no provider or database writes
    if (arguments_.dryRun) {
      skippedChunks += 1;
      continue;
    }

    const result = await executeChunk(
      pool,
      repository,
      source,
      chunk,
      options.fetchRange ?? fetchPublicStationRange,
      options.fetchOptions,
      options.now ?? defaultNow,
    );

    // stop this source after the first failed chunk
    if (!result.ok) {
      failedChunk = {
        errorCode: result.errorCode,
        startDate: chunk.startDate,
      };
      break;
    }

    completedChunks += 1;
    records += result.recordCount;

    const delayMilliseconds = publicStationBackfillDelayMilliseconds(
      source.source.adapter,
    );

    // respect provider pacing between completed network chunks
    if (delayMilliseconds > 0 && chunkIndex < chunks.length - 1) {
      await (options.fetchOptions?.sleep ?? sleep)(delayMilliseconds);
    }
  }

  return {
    completedChunks,
    exitCode: failedChunk === null ? 0 : 1,
    failedChunk,
    from,
    plannedChunks: chunks.length,
    records,
    skippedChunks,
    source: source.sourceKey,
    to,
  };
}

// execute one committed chunk
async function executeChunk(
  pool: DatabasePool,
  repository: PublicStationBackfillRepository,
  source: PublicStationBackfillSource,
  chunk: PlannedPublicStationChunk,
  fetchRange: PublicStationRangeOperation,
  fetchOptions: ProviderFetchOptions | undefined,
  now: () => Date,
): Promise<Readonly<{
  errorCode: string;
  ok: boolean;
  recordCount: number;
  secondaryError: string | null;
}>> {
  const session = await repository.acquireSourceSession(pool, source.id);

  // stop on source lock contention
  if (session === null) {
    return {
      errorCode: "source_locked",
      ok: false,
      recordCount: 0,
      secondaryError: null,
    };
  }

  let attempts = 0;
  let runId: string | null = null;
  let result: Readonly<{
    errorCode: string;
    ok: boolean;
    recordCount: number;
    secondaryError: string | null;
  }>;

  try {
    const startedAt = now();
    const deadlines = planIngestionDeadlines(startedAt, fetchOptions);
    await repository.abandonExpiredRuns(session, startedAt.toISOString());
    const started = await repository.startIngestionRun(session, {
      adapterVersion: chunk.identity.adapterVersion,
      chunkPlanVersion: chunk.identity.chunkPlanVersion,
      deadlineAt: deadlines.runDeadlineAt,
      mode: "backfill",
      requestMetadata: {
        endpoint: source.source.adapter,
        station: source.station.key,
      },
      requestedEndExclusive: chunk.identity.intervalEndExclusive,
      requestedStart: chunk.identity.intervalStart,
      sourceConfigFingerprint: chunk.identity.sourceConfigFingerprint,
    });
    runId = started.id;
    const batch = await fetchRange(
      createRangeRequest(source, chunk.identity),
      { ...fetchOptions, deadlineAt: deadlines.providerDeadlineAt, now },
    );
    attempts = batch.attempts;
    assertRecordsWithinChunk(batch.records, chunk.identity);
    await repository.completeBackfillIngestion(session, {
      attempts,
      identity: chunk.identity,
      records: batch.records,
      responseMetadata: batch.responseMetadata,
      runId,
      upstreamResponseChecksum: batch.checksum,
    });
    result = {
      errorCode: "",
      ok: true,
      recordCount: batch.records.length,
      secondaryError: null,
    };
  } catch (error) {
    const failure = asProviderFailure(error, Math.max(1, attempts));
    let secondaryError: string | null = null;

    // record a failed exact chunk after committed start
    if (runId !== null) {
      try {
        await repository.failIngestionRun(session, {
          attempts: failure.attempts,
          backfillIdentity: chunk.identity,
          error: failure.ingestionError,
          runId,
        });
      } catch (finalizationError) {
        // retain bounded finalization diagnostics
        secondaryError = boundedWorkerError(finalizationError);
      }
    }

    result = {
      errorCode: failure.ingestionError.code,
      ok: false,
      recordCount: 0,
      secondaryError,
    };
  }

  const releaseError = await guardReleaseSession(session);

  // retain the primary result when cleanup also fails
  if (releaseError !== null) {
    return {
      errorCode: result.ok ? "session_release_failed" : result.errorCode,
      ok: false,
      recordCount: result.recordCount,
      secondaryError: combineWorkerDiagnostics([
        { label: "finalization", value: result.secondaryError },
        { label: "release", value: releaseError },
      ]),
    };
  }

  return result;
}

// build one discriminated provider request
function createRangeRequest(
  source: PublicStationBackfillSource,
  identity: BackfillChunkIdentity,
): PublicStationRangeRequest {
  const shared = {
    endExclusive: identity.intervalEndExclusive,
    model: source.station.model,
    serial: source.station.serial,
    sourceId: source.id,
    start: identity.intervalStart,
    timezone: source.station.timezone,
  } as const;
  const material = source.source.adapterConfig;

  // build the Ambient request
  if (source.source.adapter === "ambient-weather") {
    return {
      ...shared,
      adapter: source.source.adapter,
      deviceId: requireMaterialString(material.deviceId, "deviceId"),
      macAddress: requireMaterialString(material.macAddress, "macAddress"),
    };
  }

  // build the Weather Underground request
  if (source.source.adapter === "weather-underground") {
    return {
      ...shared,
      adapter: source.source.adapter,
      publicApiKey: requireMaterialString(material.publicApiKey, "publicApiKey"),
      stationId: requireMaterialString(material.stationId, "stationId"),
    };
  }

  // build the PurpleAir request
  if (source.source.adapter === "purpleair") {
    return {
      ...shared,
      adapter: source.source.adapter,
      mapVersion: requireMaterialString(material.mapVersion, "mapVersion"),
      sensorIndex: requireMaterialInteger(material.sensorIndex, "sensorIndex"),
    };
  }

  return {
    ...shared,
    adapter: source.source.adapter,
    deviceId: requireMaterialString(material.deviceId, "deviceId"),
    outdoorModuleId: requireMaterialString(
      material.outdoorModuleId,
      "outdoorModuleId",
    ),
    rainModuleId: requireMaterialString(material.rainModuleId, "rainModuleId"),
    windModuleId: requireMaterialString(material.windModuleId, "windModuleId"),
  };
}

// require records inside the exact chunk
function assertRecordsWithinChunk(
  records: readonly Readonly<{ validAt: string }>[],
  identity: BackfillChunkIdentity,
): void {
  // reject provider response leakage
  if (
    records.some(
      (record) =>
        record.validAt < identity.intervalStart ||
        record.validAt >= identity.intervalEndExclusive,
    )
  ) {
    throw new Error("public-station payload contained records outside the requested chunk");
  }
}

// run the complete one-shot CLI
export async function runPublicStationBackfillCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<0 | 1> {
  const parsed = parsePublicStationBackfillArguments(arguments_);
  const worker = await loadWorkerConfiguration();

  // require the mounted checked catalog
  if (worker.publicStations === null) {
    throw new Error("public-station configuration is required");
  }

  const pool = createDatabasePool(worker.database);

  try {
    const sources = await resolvePublicStationBackfillSources(
      pool,
      worker.publicStations,
      parsed.sourceKeys,
    );
    const report = await executePublicStationBackfill(
      pool,
      parsed,
      worker.publicStations,
      sources,
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    // persist the requested private machine report
    if (parsed.reportPath !== null) {
      await writeFile(parsed.reportPath, serialized, { mode: 0o600 });
    }

    process.stdout.write(serialized);
    return report.exitCode;
  } finally {
    await pool.end();
  }
}

// require one configured history start
function requireHistoryStart(source: PublicStationSourceConfiguration): string {
  // reject impossible parsed state
  if (source.historyStartDate === null) {
    throw new Error(`historical source ${source.key} has no start date`);
  }

  return source.historyStartDate;
}

// choose the later lower bound
function maximumDate(configured: string, requested: string | null): string {
  // retain the configured bound without an override
  if (requested === null) {
    return configured;
  }

  return configured > requested ? configured : requested;
}

// choose the earlier upper bound
function minimumDate(requested: string, configured: string | null): string {
  // retain the requested bound without a provider cutoff
  if (configured === null) {
    return requested;
  }

  return configured < requested ? configured : requested;
}

// require one material string
function requireMaterialString(value: unknown, field: string): string {
  // reject impossible parsed state
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`public-station ${field} is invalid`);
  }

  return value;
}

// require one material integer
function requireMaterialInteger(value: unknown, field: string): number {
  // reject impossible parsed state
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`public-station ${field} is invalid`);
  }

  return Number(value);
}

// sleep between provider requests
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// require one argument value
function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);

  // reject missing or empty values
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// validate one stable selector
function validateKey(value: string, field: string): string {
  // reject unstable identifiers
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 80) {
    throw new RangeError(`${field} must be a stable key`);
  }

  return value;
}

// validate one calendar date
function validateDate(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject rollover dates
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must use a valid YYYY-MM-DD date`);
  }

  return value;
}

// add UTC calendar days
function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}

// run only from the built CLI entrypoint
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runPublicStationBackfillCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${boundedWorkerError(error)}\n`);
      process.exitCode = 1;
    });
}
