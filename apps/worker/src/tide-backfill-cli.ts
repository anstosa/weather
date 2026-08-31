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
  type TideConfiguration,
  type TideStationConfiguration,
} from "@weather/database";
import {
  createBackfillChunkIdentity,
  type BackfillChunkIdentity,
  type JsonValue,
  type SourceKind,
} from "@weather/domain";
import {
  NOAA_TIDE_CHUNK_PLAN_VERSION,
  asProviderFailure,
  fetchNoaaTideRange,
  noaaTideAdapterVersion,
  type NoaaTideRangeOperation,
  type NoaaTideRangeRequest,
  type ProviderFetchOptions,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import { boundedWorkerError, guardReleaseSession } from "./errors.js";
import { planIngestionDeadlines } from "./run-deadline.js";
import {
  sourceIdentityMatchesTideConfiguration,
  type RuntimeSourceIdentity,
} from "./source-identity.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface TideBackfillArguments {
  readonly dryRun: boolean;
  readonly from: string;
  readonly reportPath: string | null;
  readonly resume: boolean;
  readonly site: string;
  readonly sourceKeys: readonly string[];
  readonly to: string;
}

export interface TideBackfillSource extends RuntimeSourceIdentity {
  readonly id: string;
  readonly sourceConfigFingerprint: string;
  readonly station: TideStationConfiguration;
}

export interface PlannedTideChunk {
  readonly endDate: string;
  readonly identity: BackfillChunkIdentity;
  readonly startDate: string;
}

export interface TideBackfillReport {
  readonly dryRun: boolean;
  readonly exitCode: 0 | 1;
  readonly resume: boolean;
  readonly site: string;
  readonly sources: readonly TideBackfillSourceReport[];
}

export interface TideBackfillSourceReport {
  readonly completedChunks: number;
  readonly exitCode: 0 | 1;
  readonly failedChunk: Readonly<{ errorCode: string; startDate: string }> | null;
  readonly from: string;
  readonly plannedChunks: number;
  readonly records: number;
  readonly skippedChunks: number;
  readonly source: string;
  readonly to: string;
}

interface TideBackfillRepository {
  readonly abandonExpiredRuns: typeof abandonExpiredRuns;
  readonly acquireSourceSession: typeof acquireSourceSession;
  readonly completeBackfillIngestion: typeof completeBackfillIngestion;
  readonly failIngestionRun: typeof failIngestionRun;
  readonly hasSuccessfulBackfillChunk: typeof hasSuccessfulBackfillChunk;
  readonly startIngestionRun: typeof startIngestionRun;
}

interface TideBackfillOptions {
  readonly fetchOptions?: ProviderFetchOptions;
  readonly fetchRange?: NoaaTideRangeOperation;
  readonly now?: () => Date;
  readonly repository?: TideBackfillRepository;
}

const databaseRepository: TideBackfillRepository = {
  abandonExpiredRuns,
  acquireSourceSession,
  completeBackfillIngestion,
  failIngestionRun,
  hasSuccessfulBackfillChunk,
  startIngestionRun,
};

// parse the NOAA tide bulk-import contract
export function parseTideBackfillArguments(
  arguments_: readonly string[],
  today = new Date(),
): TideBackfillArguments {
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
      throw new Error("tide backfill argument parsing failed");
    }

    // retain boolean controls
    if (flagOptions.has(argument)) {
      flags.add(argument);
      continue;
    }

    // reject unknown controls
    if (!valueOptions.has(argument)) {
      throw new Error(`unsupported tide backfill argument: ${argument}`);
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
  const from = validateDate(values.get("--from") ?? "2019-01-01", "--from");

  // reserve the partial current day for scheduled ingestion
  if (to >= todayDate) {
    throw new RangeError("--to must be before today");
  }

  // reject reversed ranges
  if (from > to) {
    throw new RangeError("--from must not follow --to");
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
export function planTideBackfillChunks(
  source: TideBackfillSource,
  from: string,
  to: string,
): readonly PlannedTideChunk[] {
  const chunks: PlannedTideChunk[] = [];
  let startDate = validateDate(from, "from");
  const finalDate = validateDate(to, "to");
  const adapterVersion = noaaTideAdapterVersion(source.station.source.sourceKind);

  // cover the inclusive archive range
  while (startDate <= finalDate) {
    const maximumEnd = addUtcDays(
      startDate,
      source.station.source.maximumChunkDays - 1,
    );
    const endDate = maximumEnd < finalDate ? maximumEnd : finalDate;
    chunks.push({
      endDate,
      identity: createBackfillChunkIdentity({
        adapterVersion,
        chunkPlanVersion: NOAA_TIDE_CHUNK_PLAN_VERSION,
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

// resolve configured tide sources against storage identity
export async function resolveTideBackfillSources(
  pool: DatabasePool,
  configuration: TideConfiguration,
  sourceKeys: readonly string[],
): Promise<readonly TideBackfillSource[]> {
  const configured = configuration.stations.filter(
    (station) =>
      station.active &&
      station.source.active &&
      (sourceKeys.length === 0 || sourceKeys.includes(station.source.key)),
  );

  // reject unknown selectors
  if (sourceKeys.length > 0 && configured.length !== sourceKeys.length) {
    throw new Error("one or more requested tide sources are unavailable");
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
    [configuration.siteKey, configured.map((station) => station.source.key)],
  );
  const rows = new Map(result.rows.map((row) => [row.sourceKey, row]));

  return configured.map((station) => {
    const row = rows.get(station.source.key);

    // require every configured storage source
    if (row === undefined) {
      throw new Error(`active tide source ${station.source.key} is missing`);
    }

    const source: TideBackfillSource = {
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

    // reject material identity drift before provider I/O
    if (!sourceIdentityMatchesTideConfiguration(source, configuration, station)) {
      throw new Error(`tide source ${station.source.key} identity does not match configuration`);
    }

    return source;
  });
}

// execute one bulk NOAA tide import
export async function executeTideBackfill(
  pool: DatabasePool,
  arguments_: TideBackfillArguments,
  configuration: TideConfiguration,
  sources: readonly TideBackfillSource[],
  options: TideBackfillOptions = {},
): Promise<TideBackfillReport> {
  // reject cross-site execution
  if (arguments_.site !== configuration.siteKey) {
    throw new Error("requested site does not match tide configuration");
  }

  const reports: TideBackfillSourceReport[] = [];

  // isolate every source archive
  for (const source of sources) {
    reports.push(await executeSourceBackfill(pool, arguments_, source, options));
  }

  return {
    dryRun: arguments_.dryRun,
    exitCode: reports.some((report) => report.exitCode === 1) ? 1 : 0,
    resume: arguments_.resume,
    site: arguments_.site,
    sources: reports,
  };
}

// execute all exact chunks for one tide source
async function executeSourceBackfill(
  pool: DatabasePool,
  arguments_: TideBackfillArguments,
  source: TideBackfillSource,
  options: TideBackfillOptions,
): Promise<TideBackfillSourceReport> {
  const from = maximumDate(arguments_.from, source.station.source.historyStartDate);
  const chunks = planTideBackfillChunks(source, from, arguments_.to);
  const repository = options.repository ?? databaseRepository;
  let completedChunks = 0;
  let records = 0;
  let skippedChunks = 0;
  let failedChunk: TideBackfillSourceReport["failedChunk"] = null;

  // execute every exact chunk independently
  for (const chunk of chunks) {
    // satisfy exact-success resume semantics
    if (
      arguments_.resume &&
      await repository.hasSuccessfulBackfillChunk(pool, chunk.identity)
    ) {
      skippedChunks += 1;
      continue;
    }

    // prove dry-run has no writes
    if (arguments_.dryRun) {
      skippedChunks += 1;
      continue;
    }

    const result = await executeChunk(
      pool,
      repository,
      source,
      chunk,
      options.fetchRange ?? fetchNoaaTideRange,
      options.fetchOptions,
      options.now ?? defaultNow,
    );

    // stop this source after its first failed chunk
    if (!result.ok) {
      failedChunk = { errorCode: result.errorCode, startDate: chunk.startDate };
      break;
    }

    completedChunks += 1;
    records += result.recordCount;
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
    to: arguments_.to,
  };
}

// execute one committed tide chunk
async function executeChunk(
  pool: DatabasePool,
  repository: TideBackfillRepository,
  source: TideBackfillSource,
  chunk: PlannedTideChunk,
  fetchRange: NoaaTideRangeOperation,
  fetchOptions: ProviderFetchOptions | undefined,
  now: () => Date,
): Promise<Readonly<{ errorCode: string; ok: boolean; recordCount: number }>> {
  const session = await repository.acquireSourceSession(pool, source.id);

  // stop on source lock contention
  if (session === null) {
    return { errorCode: "source_locked", ok: false, recordCount: 0 };
  }

  let attempts = 0;
  let runId: string | null = null;
  let result: Readonly<{ errorCode: string; ok: boolean; recordCount: number }>;

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
        endpoint: "noaa-co-ops/datagetter",
        station_id: source.station.serial,
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
    result = { errorCode: "", ok: true, recordCount: batch.records.length };
  } catch (error) {
    const failure = asProviderFailure(error, Math.max(1, attempts));

    // persist the exact failed chunk after committed start
    if (runId !== null) {
      try {
        await repository.failIngestionRun(session, {
          attempts: failure.attempts,
          backfillIdentity: chunk.identity,
          error: failure.ingestionError,
          runId,
        });
      } catch {
        // preserve the provider failure as primary
      }
    }

    result = {
      errorCode: failure.ingestionError.code,
      ok: false,
      recordCount: 0,
    };
  }

  const releaseError = await guardReleaseSession(session);

  // surface release failure after otherwise successful work
  if (releaseError !== null && result.ok) {
    return { errorCode: "session_release_failed", ok: false, recordCount: result.recordCount };
  }

  return result;
}

// build one discriminated NOAA request
function createRangeRequest(
  source: TideBackfillSource,
  identity: BackfillChunkIdentity,
): NoaaTideRangeRequest {
  const shared = {
    datum: "MLLW" as const,
    endExclusive: identity.intervalEndExclusive,
    sourceId: source.id,
    start: identity.intervalStart,
    stationId: source.station.serial,
    timezone: source.station.timezone,
  };

  // build observed water-level requests
  if (source.station.source.sourceKind === "tide_observation") {
    return {
      ...shared,
      product: "water_level",
      sourceKind: source.station.source.sourceKind,
    };
  }

  return {
    ...shared,
    interval: "hilo",
    product: "predictions",
    sourceKind: source.station.source.sourceKind,
  };
}

// require records stay inside their durable chunk
function assertRecordsWithinChunk(
  records: readonly { readonly sourceId: string; readonly validAt: string }[],
  identity: BackfillChunkIdentity,
): void {
  // validate every normalized identity and time
  for (const record of records) {
    if (
      record.sourceId !== identity.sourceId ||
      record.validAt < identity.intervalStart ||
      record.validAt >= identity.intervalEndExclusive
    ) {
      throw new Error("NOAA tide record escaped its backfill chunk");
    }
  }
}

// require one named CLI argument
function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);

  // reject missing required values
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// validate one stable key
function validateKey(value: string, field: string): string {
  // require portable selector keys
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 80) {
    throw new RangeError(`${field} must be a lowercase kebab-case key`);
  }

  return value;
}

// validate one UTC date
function validateDate(value: string, field: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);

  // reject malformed and rolled-over dates
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${field} must use YYYY-MM-DD`);
  }

  return value;
}

// add UTC calendar days
function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// select the later date
function maximumDate(left: string, right: string): string {
  return left > right ? left : right;
}

// provide a testable clock default
function defaultNow(): Date {
  return new Date();
}

// run the one-shot CLI entrypoint
async function main(): Promise<void> {
  const arguments_ = parseTideBackfillArguments(process.argv.slice(2));
  const configuration = await loadWorkerConfiguration();

  // require the mounted tide catalog
  if (configuration.tides === null) {
    throw new Error("tide configuration is not enabled");
  }

  const pool = createDatabasePool(configuration.database);

  try {
    const sources = await resolveTideBackfillSources(
      pool,
      configuration.tides,
      arguments_.sourceKeys,
    );
    const report = await executeTideBackfill(
      pool,
      arguments_,
      configuration.tides,
      sources,
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    // persist an optional operator report
    if (arguments_.reportPath !== null) {
      await writeFile(arguments_.reportPath, serialized, "utf8");
    }

    process.stdout.write(serialized);
    process.exitCode = report.exitCode;
  } finally {
    await pool.end();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

// execute only as the bulk-import command
if (isEntrypoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${boundedWorkerError(error)}\n`);
    process.exitCode = 1;
  });
}
