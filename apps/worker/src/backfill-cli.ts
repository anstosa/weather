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
  type SiteConfiguration,
  type SourceSession,
} from "@weather/database";
import {
  backfillChunkKey,
  createBackfillChunkIdentity,
  validateTimeZone,
  type BackfillChunkIdentity,
} from "@weather/domain";
import {
  OPEN_METEO_ARCHIVE_ADAPTER_VERSION,
  OPEN_METEO_ARCHIVE_CHUNK_PLAN_VERSION,
  asProviderFailure,
  createOpenMeteoHistoricalOperation,
  fetchOpenMeteoArchive,
  type OpenMeteoHistoricalOperation,
  type ProviderFetchOptions,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import {
  boundedWorkerError,
  combineWorkerDiagnostics,
} from "./errors.js";
import { planIngestionDeadlines } from "./run-deadline.js";
import {
  sourceIdentityMatchesConfiguration,
  type RuntimeSourceIdentity,
} from "./source-identity.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface BackfillArguments {
  readonly chunkDays: number;
  readonly dryRun: boolean;
  readonly from: string;
  readonly reportPath: string | null;
  readonly resume: boolean;
  readonly site: string;
  readonly source: string | null;
  readonly to: string;
}

export interface PlannedBackfillChunk {
  readonly endDate: string;
  readonly identity: BackfillChunkIdentity;
  readonly key: string;
  readonly startDate: string;
}

export interface BackfillChunkReport {
  readonly errorCode: string | null;
  readonly identity: BackfillChunkIdentity;
  readonly secondaryError: string | null;
  readonly status:
    | "abandoned"
    | "completed"
    | "failed"
    | "planned"
    | "remaining"
    | "skipped";
}

export interface BackfillReport {
  readonly chunks: readonly BackfillChunkReport[];
  readonly dryRun: boolean;
  readonly exitCode: 0 | 1;
  readonly from: string;
  readonly resume: boolean;
  readonly site: string;
  readonly source: string;
  readonly to: string;
}

export interface BackfillSource extends RuntimeSourceIdentity {
  readonly id: string;
  readonly key: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
}

interface BackfillRepository {
  readonly abandonExpiredRuns: typeof abandonExpiredRuns;
  readonly acquireSourceSession: typeof acquireSourceSession;
  readonly completeBackfillIngestion: typeof completeBackfillIngestion;
  readonly failIngestionRun: typeof failIngestionRun;
  readonly hasSuccessfulBackfillChunk: typeof hasSuccessfulBackfillChunk;
  readonly startIngestionRun: typeof startIngestionRun;
}

interface BackfillExecutionOptions {
  readonly fetchArchive?: OpenMeteoHistoricalOperation;
  readonly fetchOptions?: ProviderFetchOptions;
  readonly now?: () => Date;
  readonly repository?: BackfillRepository;
}

const databaseRepository: BackfillRepository = {
  abandonExpiredRuns,
  acquireSourceSession,
  completeBackfillIngestion,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
};

// parse the one-shot CLI contract
export function parseBackfillArguments(
  arguments_: readonly string[],
  today = new Date(),
): BackfillArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--site",
    "--source",
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
      throw new Error("backfill argument parsing failed");
    }

    // retain boolean controls
    if (flagOptions.has(argument)) {
      flags.add(argument);
      continue;
    }

    // reject unknown controls
    if (!valueOptions.has(argument)) {
      throw new Error(`unsupported backfill argument: ${argument}`);
    }

    const value = arguments_[index + 1];

    // require a following value
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }

    values.set(argument, value);
    index += 1;
  }

  const site = requireArgument(values, "--site");
  const from = validateDate(requireArgument(values, "--from"), "--from");
  const to = validateDate(requireArgument(values, "--to"), "--to");

  // reject reversed ranges
  if (from > to) {
    throw new RangeError("--from must not follow --to");
  }

  // reject current or future archive ranges
  if (to >= today.toISOString().slice(0, 10)) {
    throw new RangeError("--to must be before today");
  }

  const chunkDays = Number(values.get("--chunk-days") ?? "14");

  // enforce the exact maximum chunk size
  if (!Number.isSafeInteger(chunkDays) || chunkDays < 1 || chunkDays > 14) {
    throw new RangeError("--chunk-days must be between 1 and 14");
  }

  return {
    chunkDays,
    dryRun: flags.has("--dry-run"),
    from,
    reportPath: values.get("--report") ?? null,
    resume: flags.has("--resume"),
    site,
    source: values.get("--source") ?? null,
    to,
  };
}

// plan deterministic local-calendar chunks
export function planBackfillChunks(
  arguments_: Pick<BackfillArguments, "chunkDays" | "from" | "to"> &
    Readonly<{
      sourceConfigFingerprint: string;
      sourceId: string;
      timezone: string;
    }>,
): readonly PlannedBackfillChunk[] {
  validateTimeZone(arguments_.timezone);
  const chunks: PlannedBackfillChunk[] = [];
  let startDate = arguments_.from;

  // cover the inclusive requested date range
  while (startDate <= arguments_.to) {
    const maximumEnd = addCalendarDays(startDate, arguments_.chunkDays - 1);
    const endDate = maximumEnd < arguments_.to ? maximumEnd : arguments_.to;
    const identity = createBackfillChunkIdentity({
      adapterVersion: OPEN_METEO_ARCHIVE_ADAPTER_VERSION,
      chunkPlanVersion: OPEN_METEO_ARCHIVE_CHUNK_PLAN_VERSION,
      intervalEndExclusive: localMidnightToUtc(
        addCalendarDays(endDate, 1),
        arguments_.timezone,
      ),
      intervalStart: localMidnightToUtc(startDate, arguments_.timezone),
      requestedFromDate: arguments_.from,
      requestedToDate: arguments_.to,
      sourceConfigFingerprint: arguments_.sourceConfigFingerprint,
      sourceId: arguments_.sourceId,
    });
    chunks.push({
      endDate,
      identity,
      key: backfillChunkKey(identity),
      startDate,
    });
    startDate = addCalendarDays(endDate, 1);
  }

  return chunks;
}

// execute a sequential exact-identity backfill
export async function executeBackfill(
  pool: DatabasePool,
  arguments_: BackfillArguments,
  site: SiteConfiguration,
  source: BackfillSource,
  options: BackfillExecutionOptions = {},
): Promise<BackfillReport> {
  assertBackfillSite(arguments_.site, site.site.key);
  const repository = options.repository ?? databaseRepository;
  const fetchArchive = options.fetchArchive ?? fetchOpenMeteoArchive;
  const now = options.now ?? defaultNow;
  const sourceConfiguration = site.sources.find(
    (candidate) => candidate.key === source.key,
  );

  // require the historical source capability
  if (
    sourceConfiguration === undefined ||
    sourceConfiguration.sourceKind !== "reanalysis" ||
    !sourceConfiguration.capabilities.includes("historical")
  ) {
    throw new Error("selected source does not support historical ingestion");
  }

  // reject identity drift before resume reads locks or provider I/O
  if (
    !sourceIdentityMatchesConfiguration(source, site, sourceConfiguration) ||
    source.latitude !== site.site.latitude ||
    source.longitude !== site.site.longitude ||
    source.key !== sourceConfiguration.key
  ) {
    throw new Error("source identity does not match configuration");
  }

  requireArchiveContract(sourceConfiguration.adapterConfig);
  const chunks = planBackfillChunks({
    chunkDays: arguments_.chunkDays,
    from: arguments_.from,
    sourceConfigFingerprint: sourceConfiguration.fingerprint,
    sourceId: source.id,
    timezone: source.timezone,
    to: arguments_.to,
  });
  const reports: BackfillChunkReport[] = [];

  // execute each chunk with one retained source session
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];

    // guard unchecked indexing
    if (chunk === undefined) {
      throw new Error("backfill chunk planning failed");
    }

    // satisfy exact-success resume semantics
    if (
      arguments_.resume &&
      await repository.hasSuccessfulBackfillChunk(pool, chunk.identity)
    ) {
      reports.push({
        errorCode: null,
        identity: chunk.identity,
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
        secondaryError: null,
        status: "planned",
      });
      continue;
    }

    const session = await repository.acquireSourceSession(pool, source.id);

    // stop after lock contention
    if (session === null) {
      reports.push({
        errorCode: "source_locked",
        identity: chunk.identity,
        secondaryError: null,
        status: "abandoned",
      });
      appendRemaining(reports, chunks, index + 1);
      return createBackfillReport(arguments_, source, reports, 1);
    }

    const succeeded = await executeBackfillChunk(
      session,
      repository,
      fetchArchive,
      chunk,
      source,
      now,
      options.fetchOptions,
    );
    reports.push(succeeded.report);

    // stop after the first failed chunk
    if (!succeeded.ok) {
      appendRemaining(reports, chunks, index + 1);
      return createBackfillReport(arguments_, source, reports, 1);
    }
  }

  return createBackfillReport(arguments_, source, reports, 0);
}

// execute one committed archive chunk
async function executeBackfillChunk(
  session: SourceSession,
  repository: BackfillRepository,
  fetchArchive: OpenMeteoHistoricalOperation,
  chunk: PlannedBackfillChunk,
  source: BackfillSource,
  now: () => Date,
  fetchOptions: ProviderFetchOptions | undefined,
): Promise<Readonly<{ ok: boolean; report: BackfillChunkReport }>> {
  let runId: string | null = null;
  let attempts = 0;
  let result: Readonly<{ ok: boolean; report: BackfillChunkReport }>;

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
        end_date: chunk.endDate,
        endpoint: "archive/hourly",
        start_date: chunk.startDate,
      },
      requestedEndExclusive: chunk.identity.intervalEndExclusive,
      requestedStart: chunk.identity.intervalStart,
      sourceConfigFingerprint: chunk.identity.sourceConfigFingerprint,
    });
    runId = started.id;
    const batch = await fetchArchive(
      {
        endDate: chunk.endDate,
        latitude: source.latitude,
        longitude: source.longitude,
        sourceId: source.id,
        startDate: chunk.startDate,
        timezone: source.timezone,
      },
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
      ok: true,
      report: {
        errorCode: null,
        identity: chunk.identity,
        secondaryError: null,
        status: "completed",
      },
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
      ok: false,
      report: {
        errorCode: failure.ingestionError.code,
        identity: chunk.identity,
        secondaryError,
        status: "failed",
      },
    };
  }

  const releaseError = await guardReleaseSession(session);

  // retain the primary chunk outcome when cleanup also fails
  if (releaseError !== null) {
    return {
      ok: false,
      report: {
        ...result.report,
        errorCode:
          result.report.status === "completed"
            ? "session_release_failed"
            : result.report.errorCode,
        secondaryError: combineWorkerDiagnostics([
          { label: "finalization", value: result.report.secondaryError },
          { label: "release", value: releaseError },
        ]),
        status: "failed",
      },
    };
  }

  return result;
}

// release a backfill session without masking its result
async function guardReleaseSession(
  session: SourceSession,
): Promise<string | null> {
  try {
    await session.release();
    return null;
  } catch (error) {
    // retain bounded cleanup diagnostics
    return boundedWorkerError(error);
  }
}

// require all records inside the exact half-open interval
function assertRecordsWithinChunk(
  records: readonly Readonly<{ validAt: string }>[],
  identity: BackfillChunkIdentity,
): void {
  // reject successful empty chunks
  if (records.length === 0) {
    throw new Error("archive payload contained no records");
  }

  // reject out-of-window provider records
  if (
    records.some(
      (record) =>
        record.validAt < identity.intervalStart ||
        record.validAt >= identity.intervalEndExclusive,
    )
  ) {
    throw new Error("archive payload contained records outside the requested chunk");
  }
}

// append untouched chunks after interruption
function appendRemaining(
  reports: BackfillChunkReport[],
  chunks: readonly PlannedBackfillChunk[],
  startIndex: number,
): void {
  // retain every unattempted exact identity
  for (const chunk of chunks.slice(startIndex)) {
    reports.push({
      errorCode: null,
      identity: chunk.identity,
      secondaryError: null,
      status: "remaining",
    });
  }
}

// create the bounded machine report
function createBackfillReport(
  arguments_: BackfillArguments,
  source: BackfillSource,
  chunks: readonly BackfillChunkReport[],
  exitCode: 0 | 1,
): BackfillReport {
  return {
    chunks,
    dryRun: arguments_.dryRun,
    exitCode,
    from: arguments_.from,
    resume: arguments_.resume,
    site: arguments_.site,
    source: source.key,
    to: arguments_.to,
  };
}

// resolve one configured active archive source
export async function resolveBackfillSource(
  pool: DatabasePool,
  site: SiteConfiguration,
  sourceKey: string | null,
): Promise<BackfillSource> {
  const configuredSource = site.sources.find(
    (candidate) =>
      candidate.sourceKind === "reanalysis" &&
      candidate.capabilities.includes("historical") &&
      (sourceKey === null || candidate.key === sourceKey),
  );

  // require one configured historical source
  if (configuredSource === undefined) {
    throw new Error("no configured Open-Meteo reanalysis source matches the request");
  }

  const result = await pool.query<{
    latitude: number;
    longitude: number;
    materialProviderConfig: RuntimeSourceIdentity["materialProviderConfig"];
    providerKey: string;
    siteSlug: string;
    sourceConfigFingerprint: string;
    sourceId: string;
    sourceKey: string;
    sourceKind: RuntimeSourceIdentity["sourceKind"];
    stationSlug: string;
    timezone: string;
  }>(
    `
      SELECT
        si.latitude,
        si.longitude,
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
        AND s.source_key = $2
        AND s.active
        AND st.active
        AND si.active
        AND p.active
      LIMIT 1
    `,
    [site.site.key, configuredSource.key],
  );
  const row = result.rows[0];

  // reject absent or unsupported sources
  if (row === undefined) {
    throw new Error("no active Open-Meteo reanalysis source matches the request");
  }

  const source: BackfillSource = {
    id: row.sourceId,
    key: row.sourceKey,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    materialProviderConfig: row.materialProviderConfig,
    providerKey: row.providerKey,
    siteSlug: row.siteSlug,
    sourceConfigFingerprint: row.sourceConfigFingerprint,
    sourceKey: row.sourceKey,
    sourceKind: row.sourceKind,
    stationSlug: row.stationSlug,
    timezone: row.timezone,
  };

  // reject database identity drift before execution
  if (
    !sourceIdentityMatchesConfiguration(source, site, configuredSource) ||
    source.latitude !== site.site.latitude ||
    source.longitude !== site.site.longitude
  ) {
    throw new Error("source identity does not match configuration");
  }

  return source;
}

// run the complete one-shot CLI
export async function runBackfillCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<0 | 1> {
  const parsed = parseBackfillArguments(arguments_);
  const configuration = await loadWorkerConfiguration();
  assertBackfillSite(parsed.site, configuration.site.site.key);
  const pool = createDatabasePool(configuration.database);
  const fetchArchive = createOpenMeteoHistoricalOperation(
    configuration.openMeteoCompatibilityOrigin,
  );

  try {
    await assertSupportedPostgres(pool);
    const source = await resolveBackfillSource(
      pool,
      configuration.site,
      parsed.source,
    );
    const report = await executeBackfill(
      pool,
      parsed,
      configuration.site,
      source,
      { fetchArchive },
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

// require CLI and configured site equality
function assertBackfillSite(requested: string, configured: string): void {
  // reject cross-site execution
  if (requested !== configured) {
    throw new Error(
      `requested site ${requested} does not match configured site ${configured}`,
    );
  }
}

// validate the frozen archive contract
function requireArchiveContract(adapterConfig: unknown): void {
  // reject changed source semantics
  if (
    typeof adapterConfig !== "object" ||
    adapterConfig === null ||
    Array.isArray(adapterConfig) ||
    !("contractVersion" in adapterConfig) ||
    adapterConfig.contractVersion !== "archive-hourly/v1" ||
    !("maximumChunkDays" in adapterConfig) ||
    adapterConfig.maximumChunkDays !== 14
  ) {
    throw new Error("source adapter contract must be archive-hourly/v1 with 14-day chunks");
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

// validate one calendar date
function validateDate(value: string, fieldName: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject rollover dates
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} must use a valid YYYY-MM-DD date`);
  }

  return value;
}

// add local calendar days without timezone math
function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// map a local calendar midnight to its UTC instant
function localMidnightToUtc(value: string, timezone: string): string {
  const naive = Date.parse(`${value}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

  // search modern quarter-hour timezone offsets
  for (let offsetMinutes = -840; offsetMinutes <= 840; offsetMinutes += 15) {
    const candidate = naive - offsetMinutes * 60_000;
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );

    // return the exact local midnight match
    if (
      `${parts.year}-${parts.month}-${parts.day}` === value &&
      parts.hour === "00" &&
      parts.minute === "00"
    ) {
      return new Date(candidate).toISOString();
    }
  }

  throw new RangeError(`${value} has no local midnight in ${timezone}`);
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
  runBackfillCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${boundedWorkerError(error)}\n`);
      process.exitCode = 1;
    });
}
