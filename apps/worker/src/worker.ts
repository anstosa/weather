import { pathToFileURL } from "node:url";

import {
  abandonExpiredRuns,
  acquireSourceSession,
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
  createOpenMeteoCurrentOperation,
  fetchOpenMeteoCurrent,
  type OpenMeteoCurrentOperation,
  type ProviderFetchOptions,
} from "@weather/providers";

import { loadWorkerConfiguration } from "./config.js";
import {
  boundedWorkerError,
  combineWorkerDiagnostics,
  createWorkerDiagnostic,
  guardReleaseSession,
  writeWorkerDiagnostic,
  type WorkerDiagnostic,
} from "./errors.js";
import {
  assertWorkerDatabaseReadiness,
  readWorkerHealth,
} from "./health.js";
import { planIngestionDeadlines } from "./run-deadline.js";
import {
  WORKER_CADENCE_MS,
  createNonOverlappingScheduler,
} from "./scheduler.js";
import { sourceIdentityMatchesConfiguration } from "./source-identity.js";

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
  readonly diagnosticWriter?: (diagnostic: WorkerDiagnostic) => void;
  readonly fetchCurrent?: OpenMeteoCurrentOperation;
  readonly fetchOptions?: ProviderFetchOptions;
  readonly instance: string;
  readonly lastSuccessAt: string | null;
  readonly now?: () => Date;
  readonly repository?: WorkerRepository;
  readonly site: SiteConfiguration;
  readonly version: string;
}

export interface SourceRunResult {
  readonly durationMs: number;
  readonly recordCount: number;
  readonly reason: string | null;
  readonly runId: string | null;
  readonly secondaryError: string | null;
  readonly sourceId: string;
  readonly status: "failed" | "skipped" | "succeeded";
}

export interface WorkerIterationResult {
  readonly completedAt: string;
  readonly lastSuccessAt: string | null;
  readonly sources: readonly SourceRunResult[];
}

interface WorkerSuccessState {
  lastSuccessAt: string | null;
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

// create one runner with retained success state
export function createWorkerIterationRunner(
  pool: DatabasePool,
  options: WorkerIterationOptions,
): () => Promise<WorkerIterationResult> {
  const successState: WorkerSuccessState = {
    lastSuccessAt: options.lastSuccessAt,
  };

  // preserve committed success across iteration failures
  return async () => await runWorkerIterationWithState(pool, options, successState);
}

// execute one standalone worker iteration
export async function runWorkerIteration(
  pool: DatabasePool,
  options: WorkerIterationOptions,
): Promise<WorkerIterationResult> {
  return await runWorkerIterationWithState(pool, options, {
    lastSuccessAt: options.lastSuccessAt,
  });
}

// execute one iteration against retained success state
async function runWorkerIterationWithState(
  pool: DatabasePool,
  options: WorkerIterationOptions,
  successState: WorkerSuccessState,
): Promise<WorkerIterationResult> {
  const repository = options.repository ?? databaseRepository;
  const now = options.now ?? defaultNow;
  const diagnosticWriter = options.diagnosticWriter ?? writeWorkerDiagnostic;
  const iterationStartedAt = now().getTime();
  const loopAt = now().toISOString();
  const dueSources = await repository.discoverDueSources(pool, loopAt);
  const results: SourceRunResult[] = [];

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
        ...(options.fetchCurrent === undefined
          ? {}
          : { fetchCurrent: options.fetchCurrent }),
      });
      results.push(result);
      diagnosticWriter(
        createWorkerDiagnostic({
          count: result.recordCount,
          durationMs: result.durationMs,
          errorCode: result.status === "failed" ? result.reason : null,
          event: "source_run",
          release: options.version,
          runId: result.runId,
          sourceId: result.sourceId,
        }),
      );

      // track ingestion success separately from loop liveness
      if (result.status === "succeeded") {
        successState.lastSuccessAt = now().toISOString();
      }
    } catch (error) {
      const result: SourceRunResult = {
        durationMs: elapsedMilliseconds(iterationStartedAt, now()),
        reason: "worker_source_failure",
        recordCount: 0,
        runId: null,
        secondaryError: boundedWorkerError(error),
        sourceId: source.id,
        status: "failed",
      };
      results.push(result);
      diagnosticWriter(
        createWorkerDiagnostic({
          count: 0,
          durationMs: result.durationMs,
          errorCode: result.reason,
          event: "source_run",
          release: options.version,
          runId: null,
          sourceId: source.id,
        }),
      );
    }
  }

  const completedAt = now().toISOString();
  await repository.updateWorkerHeartbeat(pool, {
    activity: results.some((result) => result.status === "failed")
      ? "degraded"
      : null,
    instance: options.instance,
    lastLoopAt: completedAt,
    lastSuccessAt: successState.lastSuccessAt,
    version: options.version,
  });
  diagnosticWriter(
    createWorkerDiagnostic({
      count: results.length,
      durationMs: elapsedMilliseconds(iterationStartedAt, now()),
      errorCode: results.some((result) => result.status === "failed")
        ? "worker_iteration_degraded"
        : null,
      event: "worker_iteration",
      release: options.version,
      runId: null,
      sourceId: null,
    }),
  );

  return {
    completedAt,
    lastSuccessAt: successState.lastSuccessAt,
    sources: results,
  };
}

// execute one committed scheduled run
export async function runScheduledSource(
  pool: DatabasePool,
  source: DueSource,
  options: Readonly<{
    fetchCurrent?: OpenMeteoCurrentOperation;
    fetchOptions?: ProviderFetchOptions;
    now: () => Date;
    repository: WorkerRepository;
    site: SiteConfiguration;
  }>,
): Promise<SourceRunResult> {
  const executionStartedAt = options.now().getTime();
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
    !sourceConfiguration.capabilities.includes("current") ||
    !sourceIdentityMatchesConfiguration(
      source,
      options.site,
      sourceConfiguration,
    )
  ) {
    return {
      durationMs: elapsedMilliseconds(executionStartedAt, options.now()),
      reason: "source is not an active configured Open-Meteo current source",
      recordCount: 0,
      runId: null,
      secondaryError: null,
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
    return {
      durationMs: elapsedMilliseconds(executionStartedAt, options.now()),
      reason: "source lock is held",
      recordCount: 0,
      runId: null,
      secondaryError: null,
      sourceId: source.id,
      status: "skipped",
    };
  }

  let runId: string | null = null;
  let attempts = 0;
  let recordCount = 0;
  let result: SourceRunResult;

  try {
    const now = options.now();
    const deadlines = planIngestionDeadlines(now, options.fetchOptions);
    await options.repository.abandonExpiredRuns(session, now.toISOString());
    const checkpoint = await options.repository.getScheduledCheckpoint(session);
    const window = scheduledWindow(now, source.cadenceSeconds, checkpoint);
    const started = await options.repository.startIngestionRun(session, {
      adapterVersion: OPEN_METEO_CURRENT_ADAPTER_VERSION,
      deadlineAt: deadlines.runDeadlineAt,
      mode: "scheduled",
      requestMetadata: { endpoint: "forecast/current" },
      requestedEndExclusive: window.endExclusive,
      requestedStart: window.start,
      sourceConfigFingerprint: source.sourceConfigFingerprint,
    });
    runId = started.id;
    const batch = await (options.fetchCurrent ?? fetchOpenMeteoCurrent)(
      {
        latitude: options.site.site.latitude,
        longitude: options.site.site.longitude,
        sourceId: source.id,
        timezone: options.site.site.timezone,
      },
      {
        ...options.fetchOptions,
        deadlineAt: deadlines.providerDeadlineAt,
        now: options.now,
      },
    );
    attempts = batch.attempts;
    recordCount = batch.records.length;
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

    result = {
      durationMs: 0,
      reason: null,
      recordCount,
      runId,
      secondaryError: null,
      sourceId: source.id,
      status: "succeeded",
    };
  } catch (error) {
    const failure = asProviderFailure(error, Math.max(1, attempts));
    let secondaryError: string | null = null;

    // finalize only after a committed running row exists
    if (runId !== null) {
      secondaryError = await guardFailScheduledRun(
        options.repository,
        session,
        runId,
        failure,
      );
    }

    result = {
      durationMs: 0,
      reason: failure.ingestionError.code,
      recordCount,
      runId,
      secondaryError,
      sourceId: source.id,
      status: "failed",
    };
  }

  const releaseError = await guardReleaseSession(session);

  // retain primary results when cleanup also fails
  if (releaseError !== null) {
    return {
      ...result,
      durationMs: elapsedMilliseconds(executionStartedAt, options.now()),
      reason:
        result.status === "succeeded"
          ? "session_release_failed"
          : result.reason,
      secondaryError: combineWorkerDiagnostics([
        { label: "finalization", value: result.secondaryError },
        { label: "release", value: releaseError },
      ]),
      status: "failed",
    };
  }

  return {
    ...result,
    durationMs: elapsedMilliseconds(executionStartedAt, options.now()),
  };
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
): Promise<string | null> {
  try {
    await repository.failIngestionRun(session, {
      attempts: failure.attempts,
      error: failure.ingestionError,
      responseMetadata:
        failure.status === null ? null : { http_status: failure.status },
      runId,
    });
    return null;
  } catch (error) {
    // retain bounded secondary diagnostics
    return boundedWorkerError(error);
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

// start the long-running worker process
export async function startWorkerProcess(
  options: Readonly<{ once?: boolean }> = {},
): Promise<void> {
  const configuration = await loadWorkerConfiguration();
  const pool = createDatabasePool(configuration.database);
  const fetchCurrent = createOpenMeteoCurrentOperation(
    configuration.openMeteoCompatibilityOrigin,
  );
  await assertWorkerDatabaseReadiness(
    pool,
    configuration.migrationDirectory,
  );
  const durableHealth = await readWorkerHealth(pool, configuration.instance);
  const runIteration = createWorkerIterationRunner(pool, {
    fetchCurrent,
    instance: configuration.instance,
    lastSuccessAt: durableHealth.lastSuccessAt,
    site: configuration.site,
    version: configuration.version,
  });
  const scheduler = createNonOverlappingScheduler({
    cadenceMs: WORKER_CADENCE_MS,
    key: configuration.instance,
    onError: (_error: unknown) => {
      // emit an allowlisted scheduler failure
      writeWorkerDiagnostic(
        createWorkerDiagnostic({
          count: 0,
          durationMs: 0,
          errorCode: "worker_iteration_failed",
          event: "worker_iteration",
          release: configuration.version,
          runId: null,
          sourceId: null,
        }),
      );
    },
    run: async () => {
      await runIteration();
    },
  });

  // run one compatibility loop without retaining timers
  if (options.once === true) {
    await scheduler.trigger();
    await pool.end();
    return;
  }

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

// calculate a bounded non-negative duration
function elapsedMilliseconds(startedAt: number, completedAt: Date): number {
  return Math.max(0, Math.round(completedAt.getTime() - startedAt));
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
  const arguments_ = process.argv.slice(2);

  // reject undocumented process controls
  if (arguments_.some((argument) => argument !== "--once")) {
    process.stderr.write("worker supports only the optional --once flag\n");
    process.exitCode = 1;
  } else {
    startWorkerProcess({ once: arguments_.includes("--once") }).catch((error: unknown) => {
      process.stderr.write(`${boundedWorkerError(error)}\n`);
      process.exitCode = 1;
    });
  }
}
