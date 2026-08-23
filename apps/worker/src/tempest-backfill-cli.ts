import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  abandonExpiredRuns,
  acquireSourceSession,
  assertSupportedPostgres,
  completeBackfillIngestion,
  createDatabasePool,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
  type SourceSession,
  type TempestConfiguration,
  type TempestStationConfiguration,
} from "@weather/database";
import {
  backfillChunkKey,
  createBackfillChunkIdentity,
  type BackfillChunkIdentity,
  type JsonValue,
  type SourceKind,
} from "@weather/domain";
import {
  TEMPEST_OBSERVATION_ADAPTER_VERSION,
  TEMPEST_OBSERVATION_CHUNK_PLAN_VERSION,
  asProviderFailure,
  createTempestObservationOperation,
  resolveTempestStation,
  type ProviderFetchOptions,
  type TempestObservationOperation,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import {
  boundedWorkerError,
  combineWorkerDiagnostics,
  guardReleaseSession,
} from "./errors.js";
import { planIngestionDeadlines } from "./run-deadline.js";
import { sourceIdentityMatchesTempestConfiguration } from "./source-identity.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface TempestBackfillArguments {
  readonly chunkDays: number;
  readonly dryRun: boolean;
  readonly from: string | null;
  readonly reportPath: string | null;
  readonly resume: boolean;
  readonly site: string;
  readonly stationIds: readonly number[];
  readonly to: string;
}

export interface PlannedTempestChunk {
  readonly endDate: string;
  readonly identity: BackfillChunkIdentity;
  readonly key: string;
  readonly startDate: string;
}

export interface TempestBackfillSource {
  readonly id: string;
  readonly materialProviderConfig: JsonValue;
  readonly providerKey: string;
  readonly siteSlug: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly station: TempestStationConfiguration;
  readonly stationSlug: string;
  readonly timezone: string;
}

export interface TempestBackfillChunkReport {
  readonly errorCode: string | null;
  readonly identity: BackfillChunkIdentity;
  readonly recordCount: number;
  readonly secondaryError: string | null;
  readonly status: "abandoned" | "completed" | "failed" | "planned" | "skipped";
}

export interface TempestStationBackfillReport {
  readonly chunks: readonly TempestBackfillChunkReport[];
  readonly exitCode: 0 | 1;
  readonly from: string;
  readonly locationId: number;
  readonly source: string;
  readonly to: string;
}

export interface TempestBulkBackfillReport {
  readonly dryRun: boolean;
  readonly exitCode: 0 | 1;
  readonly resume: boolean;
  readonly site: string;
  readonly stations: readonly TempestStationBackfillReport[];
}

interface TempestBackfillRepository {
  readonly abandonExpiredRuns: typeof abandonExpiredRuns;
  readonly acquireSourceSession: typeof acquireSourceSession;
  readonly completeBackfillIngestion: typeof completeBackfillIngestion;
  readonly failIngestionRun: typeof failIngestionRun;
  readonly hasSuccessfulBackfillChunk: typeof hasSuccessfulBackfillChunk;
  readonly startIngestionRun: typeof startIngestionRun;
}

interface TempestBackfillExecutionOptions {
  readonly fetchObservations: TempestObservationOperation;
  readonly fetchOptions?: ProviderFetchOptions;
  readonly now?: () => Date;
  readonly repository?: TempestBackfillRepository;
}

const databaseRepository: TempestBackfillRepository = {
  abandonExpiredRuns,
  acquireSourceSession,
  completeBackfillIngestion,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
};

// parse the bulk Tempest CLI contract
export function parseTempestBackfillArguments(
  arguments_: readonly string[],
  today = new Date(),
): TempestBackfillArguments {
  const values = new Map<string, string>();
  const stations: number[] = [];
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--site",
    "--station",
    "--from",
    "--to",
    "--chunk-days",
    "--report",
  ]);
  const flagOptions = new Set(["--dry-run", "--resume"]);

  // consume every documented argument
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    // guard unchecked indexing
    if (argument === undefined) {
      throw new Error("Tempest backfill argument parsing failed");
    }

    // retain boolean controls
    if (flagOptions.has(argument)) {
      flags.add(argument);
      continue;
    }

    // reject unknown controls
    if (!valueOptions.has(argument)) {
      throw new Error(`unsupported Tempest backfill argument: ${argument}`);
    }

    const value = arguments_[index + 1];

    // require a following value
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }

    // retain every repeated station selector
    if (argument === "--station") {
      stations.push(parseStationId(value));
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

  // reject reversed ranges
  if (from !== null && from > to) {
    throw new RangeError("--from must not follow --to");
  }

  // reserve partial current-day ingestion for the hourly worker
  if (to >= todayDate) {
    throw new RangeError("--to must be before today");
  }

  const chunkDays = Number(values.get("--chunk-days") ?? "5");

  // enforce WeatherFlow's documented maximum range
  if (!Number.isSafeInteger(chunkDays) || chunkDays < 1 || chunkDays > 5) {
    throw new RangeError("--chunk-days must be between 1 and 5");
  }

  return {
    chunkDays,
    dryRun: flags.has("--dry-run"),
    from,
    reportPath: values.get("--report") ?? null,
    resume: flags.has("--resume"),
    site: requireArgument(values, "--site"),
    stationIds: [...new Set(stations)],
    to,
  };
}

// plan exact five-day-or-smaller UTC chunks
export function planTempestBackfillChunks(
  input: Readonly<{
    chunkDays: number;
    from: string;
    sourceConfigFingerprint: string;
    sourceId: string;
    to: string;
  }>,
): readonly PlannedTempestChunk[] {
  const chunks: PlannedTempestChunk[] = [];
  let startDate = validateDate(input.from, "from");
  const to = validateDate(input.to, "to");

  // cover the inclusive requested UTC date range
  while (startDate <= to) {
    const maximumEnd = addUtcDays(startDate, input.chunkDays - 1);
    const endDate = maximumEnd < to ? maximumEnd : to;
    const identity = createBackfillChunkIdentity({
      adapterVersion: TEMPEST_OBSERVATION_ADAPTER_VERSION,
      chunkPlanVersion: TEMPEST_OBSERVATION_CHUNK_PLAN_VERSION,
      intervalEndExclusive: `${addUtcDays(endDate, 1)}T00:00:00.000Z`,
      intervalStart: `${startDate}T00:00:00.000Z`,
      requestedFromDate: input.from,
      requestedToDate: to,
      sourceConfigFingerprint: input.sourceConfigFingerprint,
      sourceId: input.sourceId,
    });
    chunks.push({
      endDate,
      identity,
      key: backfillChunkKey(identity),
      startDate,
    });
    startDate = addUtcDays(endDate, 1);
  }

  return chunks;
}

// resolve configured active Tempest sources
export async function resolveTempestBackfillSources(
  pool: DatabasePool,
  configuration: TempestConfiguration,
  stationIds: readonly number[],
): Promise<readonly TempestBackfillSource[]> {
  const selected = configuration.stations.filter(
    (station) =>
      station.active &&
      (stationIds.length === 0 || stationIds.includes(station.locationId)),
  );

  // reject unknown or inactive station selectors
  if (selected.length !== (stationIds.length === 0 ? configuration.stations.filter((station) => station.active).length : stationIds.length)) {
    throw new Error("one or more requested Tempest stations are not configured and active");
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
    [configuration.siteKey, selected.map((station) => station.sourceKey)],
  );
  const rows = new Map(result.rows.map((row) => [row.sourceKey, row]));

  return selected.map((station) => {
    const row = rows.get(station.sourceKey);

    // require every configured database identity
    if (row === undefined) {
      throw new Error(`active Tempest source ${station.sourceKey} is missing`);
    }

    const source: TempestBackfillSource = {
      id: row.sourceId,
      materialProviderConfig: row.materialProviderConfig,
      providerKey: row.providerKey,
      siteSlug: row.siteSlug,
      sourceConfigFingerprint: row.sourceConfigFingerprint,
      sourceKey: row.sourceKey,
      sourceKind: row.sourceKind,
      station,
      stationSlug: row.stationSlug,
      timezone: row.timezone,
    };

    // reject database identity drift before provider I/O
    if (!sourceIdentityMatchesTempestConfiguration(source, configuration, station)) {
      throw new Error(`Tempest source ${station.sourceKey} identity does not match configuration`);
    }

    return source;
  });
}

// execute one bulk backfill across selected stations
export async function executeTempestBulkBackfill(
  pool: DatabasePool,
  arguments_: TempestBackfillArguments,
  configuration: TempestConfiguration,
  sources: readonly TempestBackfillSource[],
  options: TempestBackfillExecutionOptions,
): Promise<TempestBulkBackfillReport> {
  // reject cross-site execution
  if (arguments_.site !== configuration.siteKey) {
    throw new Error(
      `requested site ${arguments_.site} does not match configured site ${configuration.siteKey}`,
    );
  }

  const reports: TempestStationBackfillReport[] = [];

  // isolate each configured station result
  for (const source of sources) {
    reports.push(
      await executeTempestStationBackfill(
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
    stations: reports,
  };
}

// execute all chunks for one Tempest station
async function executeTempestStationBackfill(
  pool: DatabasePool,
  arguments_: TempestBackfillArguments,
  configuration: TempestConfiguration,
  source: TempestBackfillSource,
  options: TempestBackfillExecutionOptions,
): Promise<TempestStationBackfillReport> {
  // bind execution to the checked station contract
  if (!sourceIdentityMatchesTempestConfiguration(source, configuration, source.station)) {
    throw new Error("Tempest source identity does not match configuration");
  }

  requireTempestContract(source.materialProviderConfig);
  const from = arguments_.from ?? source.station.historyStartDate;
  const chunks = planTempestBackfillChunks({
    chunkDays: arguments_.chunkDays,
    from,
    sourceConfigFingerprint: source.sourceConfigFingerprint,
    sourceId: source.id,
    to: arguments_.to,
  });
  const reports: TempestBackfillChunkReport[] = [];
  const repository = options.repository ?? databaseRepository;

  // execute every exact chunk independently
  for (const chunk of chunks) {
    // satisfy exact-success resume semantics
    if (
      arguments_.resume &&
      await repository.hasSuccessfulBackfillChunk(pool, chunk.identity)
    ) {
      reports.push({
        errorCode: null,
        identity: chunk.identity,
        recordCount: 0,
        secondaryError: null,
        status: "skipped",
      });
      continue;
    }

    // prove dry-run has no provider or write side effects
    if (arguments_.dryRun) {
      reports.push({
        errorCode: null,
        identity: chunk.identity,
        recordCount: 0,
        secondaryError: null,
        status: "planned",
      });
      continue;
    }

    const session = await repository.acquireSourceSession(pool, source.id);

    // stop this station after lock contention
    if (session === null) {
      reports.push({
        errorCode: "source_locked",
        identity: chunk.identity,
        recordCount: 0,
        secondaryError: null,
        status: "abandoned",
      });
      break;
    }

    const result = await executeTempestChunk(
      session,
      repository,
      options.fetchObservations,
      chunk,
      source,
      options.now ?? defaultNow,
      options.fetchOptions,
    );
    reports.push(result);

    // stop this station after the first failed chunk
    if (result.status !== "completed") {
      break;
    }
  }

  return {
    chunks: reports,
    exitCode: reports.some((report) =>
      report.status === "failed" || report.status === "abandoned"
    ) ? 1 : 0,
    from,
    locationId: source.station.locationId,
    source: source.sourceKey,
    to: arguments_.to,
  };
}

// execute one committed Tempest chunk
async function executeTempestChunk(
  session: SourceSession,
  repository: TempestBackfillRepository,
  fetchObservations: TempestObservationOperation,
  chunk: PlannedTempestChunk,
  source: TempestBackfillSource,
  now: () => Date,
  fetchOptions: ProviderFetchOptions | undefined,
): Promise<TempestBackfillChunkReport> {
  let runId: string | null = null;
  let attempts = 0;
  let recordCount = 0;
  let result: TempestBackfillChunkReport;

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
        device_id: source.station.deviceId,
        endpoint: "observations/device",
        location_id: source.station.locationId,
      },
      requestedEndExclusive: chunk.identity.intervalEndExclusive,
      requestedStart: chunk.identity.intervalStart,
      sourceConfigFingerprint: chunk.identity.sourceConfigFingerprint,
    });
    runId = started.id;
    const batch = await fetchObservations(
      {
        deviceId: source.station.deviceId,
        endExclusive: chunk.identity.intervalEndExclusive,
        locationId: source.station.locationId,
        serial: source.station.serial,
        sourceId: source.id,
        start: chunk.identity.intervalStart,
        timezone: source.station.timezone,
      },
      { ...fetchOptions, deadlineAt: deadlines.providerDeadlineAt, now },
    );
    attempts = batch.attempts;
    recordCount = batch.records.length;
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
      errorCode: null,
      identity: chunk.identity,
      recordCount,
      secondaryError: null,
      status: "completed",
    };
  } catch (error) {
    const failure = asProviderFailure(error, Math.max(1, attempts));
    let secondaryError: string | null = null;

    // record failed exact identity after committed start
    if (runId !== null) {
      try {
        await repository.failIngestionRun(session, {
          attempts: failure.attempts,
          backfillIdentity: chunk.identity,
          error: failure.ingestionError,
          runId,
        });
      } catch (finalizationError) {
        // retain bounded secondary diagnostics
        secondaryError = boundedWorkerError(finalizationError);
      }
    }

    result = {
      errorCode: failure.ingestionError.code,
      identity: chunk.identity,
      recordCount,
      secondaryError,
      status: "failed",
    };
  }

  const releaseError = await guardReleaseSession(session);

  // retain primary diagnostics when cleanup also fails
  if (releaseError !== null) {
    return {
      ...result,
      errorCode:
        result.status === "completed" ? "session_release_failed" : result.errorCode,
      secondaryError: combineWorkerDiagnostics([
        { label: "finalization", value: result.secondaryError },
        { label: "release", value: releaseError },
      ]),
      status: "failed",
    };
  }

  return result;
}

// require all records inside the exact half-open interval
function assertRecordsWithinChunk(
  records: readonly Readonly<{ validAt: string }>[],
  identity: BackfillChunkIdentity,
): void {
  // reject out-of-window provider records
  if (
    records.some(
      (record) =>
        record.validAt < identity.intervalStart ||
        record.validAt >= identity.intervalEndExclusive,
    )
  ) {
    throw new Error("Tempest payload contained records outside the requested chunk");
  }
}

// run the complete one-shot CLI
export async function runTempestBackfillCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<0 | 1> {
  const parsed = parseTempestBackfillArguments(arguments_);
  const worker = await loadWorkerConfiguration();

  // require the mounted Tempest connector inputs
  if (worker.tempest === null || worker.tempestApiKey === null) {
    throw new Error("Tempest configuration and API key are required");
  }

  const pool = createDatabasePool(worker.database);

  try {
    await assertSupportedPostgres(pool);
    const sources = await resolveTempestBackfillSources(
      pool,
      worker.tempest,
      parsed.stationIds,
    );

    // verify every live ST identity before mutating history
    if (!parsed.dryRun) {
      for (const source of sources) {
        const resolved = await resolveTempestStation({
          apiKey: worker.tempestApiKey,
          locationId: source.station.locationId,
        });

        // require a new immutable source after physical device replacement
        if (
          resolved.deviceId !== source.station.deviceId ||
          resolved.serial !== source.station.serial
        ) {
          throw new Error(
            `Tempest ST identity changed for location ${String(source.station.locationId)}`,
          );
        }
      }
    }

    const report = await executeTempestBulkBackfill(
      pool,
      parsed,
      worker.tempest,
      sources,
      {
        fetchObservations: createTempestObservationOperation(worker.tempestApiKey),
      },
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    // persist the requested machine report
    if (parsed.reportPath !== null) {
      await writeFile(parsed.reportPath, serialized, { mode: 0o600 });
    }

    process.stdout.write(serialized);
    return report.exitCode;
  } finally {
    await pool.end();
  }
}

// validate the frozen Tempest source contract
function requireTempestContract(value: JsonValue): void {
  const configuration = value as Readonly<Record<string, JsonValue>>;

  // reject changed source semantics
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(configuration).sort().join(",") !==
      "contractVersion,deviceId,locationId,sample" ||
    configuration.contractVersion !== "tempest-observations/v1" ||
    configuration.sample !== "first-observation-per-utc-hour" ||
    !Number.isSafeInteger(configuration.deviceId) ||
    Number(configuration.deviceId) < 1 ||
    !Number.isSafeInteger(configuration.locationId) ||
    Number(configuration.locationId) < 1
  ) {
    throw new Error("source adapter contract must be tempest-observations/v1");
  }
}

// require one value argument
function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);

  // reject absent values
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// parse one public location identifier
function parseStationId(value: string): number {
  const normalized = value.startsWith("tempest-") ? value.slice(8) : value;
  const parsed = Number(normalized);

  // reject non-integer station selectors
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("--station must be a positive location ID");
  }

  return parsed;
}

// validate one calendar date
function validateDate(value: string, fieldName: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject rollover dates
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} must use a valid YYYY-MM-DD date`);
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
  runTempestBackfillCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${boundedWorkerError(error)}\n`);
      process.exitCode = 1;
    });
}
