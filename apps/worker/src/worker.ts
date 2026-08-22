import { pathToFileURL } from "node:url";

import {
  abandonExpiredRuns,
  acquireSourceSession,
  assertSupportedPostgres,
  completeScheduledIngestion,
  createDatabasePool,
  discoverDueSources,
  failIngestionRun,
  getScheduledCheckpoint,
  startIngestionRun,
  updateWorkerHeartbeat,
  type DueSource,
  type ScheduledCheckpointState,
  type SiteConfiguration,
  type SourceSession,
} from "@weather/database";
import {
  OPEN_METEO_CURRENT_ADAPTER_VERSION,
  ProviderFailure,
  asProviderFailure,
  fetchOpenMeteoCurrent,
  type ProviderFetchOptions,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import {
  WORKER_CADENCE_MS,
  createNonOverlappingScheduler,
} from "./scheduler.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface WorkerRepository {
  readonly abandonExpiredRuns: typeof abandonExpiredRuns;
  readonly acquireSourceSession: typeof acquireSourceSession;
  readonly completeScheduledIngestion: typeof completeScheduledIngestion;
  readonly discoverDueSources: typeof discoverDueSources;
  readonly failIngestionRun: typeof failIngestionRun;
  readonly getScheduledCheckpoint: typeof getScheduledCheckpoint;
  readonly startIngestionRun: typeof startIngestionRun;
  readonly updateWorkerHeartbeat: typeof updateWorkerHeartbeat;
}

export interface WorkerIterationOptions {
  readonly fetchOptions?: ProviderFetchOptions;
  readonly instance: string;
  readonly lastSuccessAt: string | null;
  readonly now?: () => Date;
  readonly repository?: WorkerRepository;
  readonly site: SiteConfiguration;
  readonly version: string;
}

export interface SourceRunResult {
  readonly reason: string | null;
  readonly sourceId: string;
  readonly status: "failed" | "skipped" | "succeeded";
}

export interface WorkerIterationResult {
  readonly completedAt: string;
  readonly lastSuccessAt: string | null;
  readonly sources: readonly SourceRunResult[];
}

const databaseRepository: WorkerRepository = {
  abandonExpiredRuns,
  acquireSourceSession,
  completeScheduledIngestion,
  discoverDueSources,
  failIngestionRun,
  getScheduledCheckpoint,
  startIngestionRun,
  updateWorkerHeartbeat,
};

// execute one failure-isolated worker iteration
export async function runWorkerIteration(
  pool: DatabasePool,
  options: WorkerIterationOptions,
): Promise<WorkerIterationResult> {
  const repository = options.repository ?? databaseRepository;
  const now = options.now ?? defaultNow;
  const loopAt = now().toISOString();
  const dueSources = await repository.discoverDueSources(pool, loopAt);
  const results: SourceRunResult[] = [];
  let lastSuccessAt = options.lastSuccessAt;

  // isolate every due source
  for (const source of dueSources) {
    try {
      const result = await runScheduledSource(pool, source, {
        ...(options.fetchOptions === undefined
          ? {}
          : { fetchOptions: options.fetchOptions }),
        now,
        repository,
        site: options.site,
      });
      results.push(result);

      // track ingestion success separately from loop liveness
      if (result.status === "succeeded") {
        lastSuccessAt = now().toISOString();
      }
    } catch (error) {
      results.push({
        reason: boundedWorkerError(error),
        sourceId: source.id,
        status: "failed",
      });
    }
  }

  const completedAt = now().toISOString();
  await repository.updateWorkerHeartbeat(pool, {
    activity: results.some((result) => result.status === "failed")
      ? "degraded"
      : null,
    instance: options.instance,
    lastLoopAt: completedAt,
    lastSuccessAt,
    version: options.version,
  });

  return { completedAt, lastSuccessAt, sources: results };
}

// execute one committed scheduled run
export async function runScheduledSource(
  pool: DatabasePool,
  source: DueSource,
  options: Readonly<{
    fetchOptions?: ProviderFetchOptions;
    now: () => Date;
    repository: WorkerRepository;
    site: SiteConfiguration;
  }>,
): Promise<SourceRunResult> {
  const sourceConfiguration = options.site.sources.find(
    (candidate) => candidate.key === source.sourceKey,
  );

  // skip sources outside the configured current capability
  if (
    !source.active ||
    source.providerKey !== "open-meteo" ||
    source.sourceKind !== "model_current" ||
    source.siteSlug !== options.site.site.key ||
    sourceConfiguration === undefined ||
    !sourceConfiguration.capabilities.includes("current")
  ) {
    return {
      reason: "source is not an active configured Open-Meteo current source",
      sourceId: source.id,
      status: "skipped",
    };
  }

  requireContractVersion(
    sourceConfiguration.adapterConfig,
    "forecast-current/v1",
  );
  const session = await options.repository.acquireSourceSession(pool, source.id);

  // skip a source already owned elsewhere
  if (session === null) {
    return { reason: "source lock is held", sourceId: source.id, status: "skipped" };
  }

  let runId: string | null = null;
  let attempts = 0;

  try {
    const now = options.now();
    await options.repository.abandonExpiredRuns(session, now.toISOString());
    const checkpoint = await options.repository.getScheduledCheckpoint(session);
    const window = scheduledWindow(now, source.cadenceSeconds, checkpoint);
    const started = await options.repository.startIngestionRun(session, {
      adapterVersion: OPEN_METEO_CURRENT_ADAPTER_VERSION,
      deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
      mode: "scheduled",
      requestMetadata: { endpoint: "forecast/current" },
      requestedEndExclusive: window.endExclusive,
      requestedStart: window.start,
      sourceConfigFingerprint: source.sourceConfigFingerprint,
    });
    runId = started.id;
    const batch = await fetchOpenMeteoCurrent(
      {
        latitude: options.site.site.latitude,
        longitude: options.site.site.longitude,
        sourceId: source.id,
        timezone: options.site.site.timezone,
      },
      { ...options.fetchOptions, now: options.now },
    );
    attempts = batch.attempts;
    const lastRecord = batch.records.at(-1);

    // reject successful empty batches
    if (lastRecord === undefined) {
      throw new ProviderFailure({
        classification: "invalid_payload",
        code: "empty_payload",
        message: "provider returned no current records",
      });
    }

    await options.repository.completeScheduledIngestion(session, {
      attempts,
      expectedCheckpointVersion: checkpoint?.version ?? null,
      lastValidAt: lastRecord.validAt,
      providerCursor: batch.providerCursor,
      records: batch.records,
      responseMetadata: batch.responseMetadata,
      runId,
      upstreamResponseChecksum: batch.checksum,
      windowEndExclusive: window.endExclusive,
      windowStart: window.start,
    });

    return { reason: null, sourceId: source.id, status: "succeeded" };
  } catch (error) {
    const failure = asProviderFailure(error, Math.max(1, attempts));

    // finalize only after a committed running row exists
    if (runId !== null) {
      await guardFailScheduledRun(
        options.repository,
        session,
        runId,
        failure,
      );
    }

    return {
      reason: failure.ingestionError.code,
      sourceId: source.id,
      status: "failed",
    };
  } finally {
    await session.release();
  }
}

// calculate an anchored half-open scheduled interval
export function scheduledWindow(
  now: Date,
  cadenceSeconds: number,
  checkpoint: ScheduledCheckpointState | null,
): Readonly<{ endExclusive: string; start: string }> {
  const cadenceMs = cadenceSeconds * 1_000;

  // require a bounded source cadence
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs < 60_000) {
    throw new RangeError("source cadence must be at least one minute");
  }

  const end = Math.floor(now.getTime() / cadenceMs) * cadenceMs;
  const start = checkpoint === null
    ? end - cadenceMs
    : Math.min(Date.parse(checkpoint.windowEndExclusive), end - cadenceMs);

  return {
    endExclusive: new Date(end).toISOString(),
    start: new Date(start).toISOString(),
  };
}

// finalize a failed scheduled run without masking its original failure
async function guardFailScheduledRun(
  repository: WorkerRepository,
  session: SourceSession,
  runId: string,
  failure: ProviderFailure,
): Promise<void> {
  try {
    await repository.failIngestionRun(session, {
      attempts: failure.attempts,
      error: failure.ingestionError,
      responseMetadata:
        failure.status === null ? null : { http_status: failure.status },
      runId,
    });
  } catch {
    // retain the first failure for loop isolation
  }
}

// validate the frozen source contract version
function requireContractVersion(
  adapterConfig: unknown,
  expected: string,
): void {
  // require object configuration
  if (
    typeof adapterConfig !== "object" ||
    adapterConfig === null ||
    Array.isArray(adapterConfig) ||
    !("contractVersion" in adapterConfig) ||
    adapterConfig.contractVersion !== expected
  ) {
    throw new Error(`source adapter contract must be ${expected}`);
  }
}

// redact and bound worker-level failure text
function boundedWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:password|token|authorization)=?[^\s&]*/giu, "[redacted]")
    .slice(0, 512);
}

// start the long-running worker process
export async function startWorkerProcess(): Promise<void> {
  const configuration = await loadWorkerConfiguration();
  const pool = createDatabasePool(configuration.database);
  await assertSupportedPostgres(pool);
  let lastSuccessAt: string | null = null;
  const scheduler = createNonOverlappingScheduler({
    cadenceMs: WORKER_CADENCE_MS,
    key: configuration.instance,
    run: async () => {
      const result = await runWorkerIteration(pool, {
        instance: configuration.instance,
        lastSuccessAt,
        site: configuration.site,
        version: configuration.version,
      });
      lastSuccessAt = result.lastSuccessAt;
    },
  });

  // close the retained database pool on termination
  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await pool.end();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  scheduler.start();
  await scheduler.trigger();
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}

// run only from the built worker entrypoint
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  startWorkerProcess().catch((error: unknown) => {
    process.stderr.write(`${boundedWorkerError(error)}\n`);
    process.exitCode = 1;
  });
}
