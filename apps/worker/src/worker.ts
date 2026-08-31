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
  type EcowittConfiguration,
  type PublicStationConfiguration,
  type PublicStationConfigurationStation,
  type PublicStationSourceConfiguration,
  type ScheduledCheckpointState,
  type SiteConfiguration,
  type SourceSession,
  type TempestConfiguration,
  type TideConfiguration,
  type TideStationConfiguration,
} from "@weather/database";
import {
  ECOWITT_LOCAL_LIVE_ADAPTER_VERSION,
  NOAA_TIDE_OBSERVATION_ADAPTER_VERSION,
  NOAA_TIDE_PREDICTION_ADAPTER_VERSION,
  OPEN_METEO_CURRENT_ADAPTER_VERSION,
  OPEN_METEO_FORECAST_ADAPTER_VERSION,
  ProviderFailure,
  TEMPEST_OBSERVATION_ADAPTER_VERSION,
  asProviderFailure,
  createOpenMeteoCurrentOperation,
  createOpenMeteoForecastOperation,
  createTempestObservationOperation,
  fetchEcowittLive,
  fetchOpenMeteoCurrent,
  fetchOpenMeteoForecast,
  fetchNoaaTideRange,
  fetchPublicStationRange,
  publicStationAdapterVersion,
  type EcowittLiveOperation,
  type OpenMeteoCurrentOperation,
  type OpenMeteoForecastOperation,
  type NoaaTideRangeOperation,
  type NoaaTideRangeRequest,
  type ProviderFetchOptions,
  type PublicStationRangeOperation,
  type PublicStationRangeRequest,
  type TempestObservationOperation,
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
  executePublicStationBackfill,
  resolvePublicStationBackfillSources,
} from "./public-stations-backfill-cli.js";
import {
  WORKER_CADENCE_MS,
  createNonOverlappingScheduler,
} from "./scheduler.js";
import {
  sourceIdentityMatchesConfiguration,
  sourceIdentityMatchesEcowittConfiguration,
  sourceIdentityMatchesPublicStationConfiguration,
  sourceIdentityMatchesTempestConfiguration,
  sourceIdentityMatchesTideConfiguration,
} from "./source-identity.js";

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
  readonly fetchEcowitt?: EcowittLiveOperation;
  readonly fetchForecast?: OpenMeteoForecastOperation;
  readonly fetchTempest?: TempestObservationOperation;
  readonly fetchOptions?: ProviderFetchOptions;
  readonly fetchPublicStation?: PublicStationRangeOperation;
  readonly fetchTide?: NoaaTideRangeOperation;
  readonly instance: string;
  readonly lastSuccessAt: string | null;
  readonly now?: () => Date;
  readonly repository?: WorkerRepository;
  readonly site: SiteConfiguration;
  readonly ecowitt?: EcowittConfiguration | null;
  readonly publicStations?: PublicStationConfiguration | null;
  readonly tempest?: TempestConfiguration | null;
  readonly tides?: TideConfiguration | null;
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
        ...(options.fetchEcowitt === undefined
          ? {}
          : { fetchEcowitt: options.fetchEcowitt }),
        ...(options.fetchForecast === undefined
          ? {}
          : { fetchForecast: options.fetchForecast }),
        ...(options.fetchTempest === undefined
          ? {}
          : { fetchTempest: options.fetchTempest }),
        ...(options.fetchPublicStation === undefined
          ? {}
          : { fetchPublicStation: options.fetchPublicStation }),
        ...(options.fetchTide === undefined
          ? {}
          : { fetchTide: options.fetchTide }),
        publicStations: options.publicStations ?? null,
        ecowitt: options.ecowitt ?? null,
        tempest: options.tempest ?? null,
        tides: options.tides ?? null,
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
    fetchEcowitt?: EcowittLiveOperation;
    fetchForecast?: OpenMeteoForecastOperation;
    fetchTempest?: TempestObservationOperation;
    fetchOptions?: ProviderFetchOptions;
    fetchPublicStation?: PublicStationRangeOperation;
    fetchTide?: NoaaTideRangeOperation;
    now: () => Date;
    repository: WorkerRepository;
    site: SiteConfiguration;
    ecowitt?: EcowittConfiguration | null;
    publicStations?: PublicStationConfiguration | null;
    tempest?: TempestConfiguration | null;
    tides?: TideConfiguration | null;
  }>,
): Promise<SourceRunResult> {
  const executionStartedAt = options.now().getTime();
  const ecowittConfiguration = options.ecowitt ?? null;
  const tempestConfiguration = options.tempest ?? null;
  const publicStationConfiguration = options.publicStations ?? null;
  const tideConfiguration = options.tides ?? null;
  const sourceConfiguration = options.site.sources.find(
    (candidate) => candidate.key === source.sourceKey,
  );
  const ecowittStation = ecowittConfiguration?.stations.find(
    (candidate) => candidate.sourceKey === source.sourceKey,
  );
  const tempestStation = tempestConfiguration?.stations.find(
    (candidate) => candidate.sourceKey === source.sourceKey,
  );
  const publicStationMatch = findPublicStationSource(
    publicStationConfiguration,
    source.sourceKey,
  );
  const tideStation = tideConfiguration?.stations.find(
    (candidate) => candidate.source.key === source.sourceKey,
  );
  const openMeteoCurrentSource =
    source.active &&
    source.providerKey === "open-meteo" &&
    source.sourceKind === "model_current" &&
    source.siteSlug === options.site.site.key &&
    sourceConfiguration !== undefined &&
    sourceConfiguration.capabilities.includes("current") &&
    sourceIdentityMatchesConfiguration(source, options.site, sourceConfiguration);
  const openMeteoForecastSource =
    source.active &&
    source.providerKey === "open-meteo" &&
    source.sourceKind === "forecast" &&
    source.siteSlug === options.site.site.key &&
    sourceConfiguration !== undefined &&
    sourceConfiguration.capabilities.includes("forecast") &&
    sourceIdentityMatchesConfiguration(source, options.site, sourceConfiguration);
  const openMeteoSource = openMeteoCurrentSource || openMeteoForecastSource;
  const ecowittSource =
    source.active &&
    ecowittConfiguration !== null &&
    ecowittStation !== undefined &&
    sourceIdentityMatchesEcowittConfiguration(
      source,
      ecowittConfiguration,
      ecowittStation,
    );
  const tempestSource =
    source.active &&
    tempestConfiguration !== null &&
    tempestStation !== undefined &&
    sourceIdentityMatchesTempestConfiguration(
      source,
      tempestConfiguration,
      tempestStation,
    );
  const publicStationSource =
    source.active &&
    publicStationConfiguration !== null &&
    publicStationMatch !== null &&
    publicStationMatch.source.active &&
    publicStationMatch.source.capabilities.includes("current") &&
    sourceIdentityMatchesPublicStationConfiguration(
      source,
      publicStationConfiguration,
      publicStationMatch.station,
      publicStationMatch.source,
    );
  const tideSource =
    source.active &&
    tideConfiguration !== null &&
    tideStation !== undefined &&
    tideStation.active &&
    tideStation.source.active &&
    sourceIdentityMatchesTideConfiguration(
      source,
      tideConfiguration,
      tideStation,
    );

  // skip sources outside a loaded exact runtime contract
  if (
    !openMeteoSource &&
    !ecowittSource &&
    !tempestSource &&
    !publicStationSource &&
    !tideSource
  ) {
    return {
      durationMs: elapsedMilliseconds(executionStartedAt, options.now()),
      reason: "source is not an active configured scheduled source",
      recordCount: 0,
      runId: null,
      secondaryError: null,
      sourceId: source.id,
      status: "skipped",
    };
  }

  // verify the selected frozen adapter contract
  if (openMeteoSource) {
    requireContractVersion(
      sourceConfiguration.adapterConfig,
      openMeteoForecastSource ? "forecast-daily/v4" : "forecast-current/v1",
    );
  } else if (ecowittStation !== undefined) {
    requireContractVersion(
      ecowittStation.adapterConfig,
      ECOWITT_LOCAL_LIVE_ADAPTER_VERSION,
    );
  } else if (tempestStation !== undefined) {
    requireContractVersion(tempestStation.adapterConfig, "tempest-observations/v2");
  } else if (publicStationMatch !== null) {
    requireContractVersion(
      publicStationMatch.source.adapterConfig,
      publicStationAdapterVersion(publicStationMatch.source.adapter),
    );
  } else if (tideStation !== undefined) {
    requireContractVersion(
      tideStation.source.adapterConfig,
      tideStation.source.sourceKind === "tide_observation"
        ? NOAA_TIDE_OBSERVATION_ADAPTER_VERSION
        : NOAA_TIDE_PREDICTION_ADAPTER_VERSION,
    );
  }
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
    const window = tideSource && tideStation?.source.sourceKind === "tide_observation"
      ? scheduledWindow(
          new Date(now.getTime() - 12 * 60_000),
          source.cadenceSeconds,
          checkpoint,
          31 * 86_400,
        )
      : ecowittSource || tempestSource
      ? scheduledWindow(now, source.cadenceSeconds, null)
      : scheduledWindow(
          now,
          source.cadenceSeconds,
          checkpoint,
          publicStationSource && publicStationMatch !== null
            ? publicStationMatch.source.maximumChunkDays * 86_400
            : null,
        );
    const started = await options.repository.startIngestionRun(session, {
      adapterVersion: tempestSource
        ? TEMPEST_OBSERVATION_ADAPTER_VERSION
        : ecowittSource
          ? ECOWITT_LOCAL_LIVE_ADAPTER_VERSION
        : publicStationSource && publicStationMatch !== null
          ? publicStationAdapterVersion(publicStationMatch.source.adapter)
          : tideSource && tideStation !== undefined
            ? tideStation.source.sourceKind === "tide_observation"
              ? NOAA_TIDE_OBSERVATION_ADAPTER_VERSION
              : NOAA_TIDE_PREDICTION_ADAPTER_VERSION
          : openMeteoForecastSource
            ? OPEN_METEO_FORECAST_ADAPTER_VERSION
            : OPEN_METEO_CURRENT_ADAPTER_VERSION,
      deadlineAt: deadlines.runDeadlineAt,
      mode: "scheduled",
      requestMetadata: {
        endpoint: tempestSource
          ? "observations/device"
          : ecowittSource
            ? "get_livedata_info"
          : publicStationSource && publicStationMatch !== null
            ? publicStationEndpoint(publicStationMatch.source.adapter)
            : tideSource
              ? "noaa-co-ops/datagetter"
            : openMeteoForecastSource
              ? "forecast/hourly"
              : "forecast/current",
      },
      requestedEndExclusive: window.endExclusive,
      requestedStart: window.start,
      sourceConfigFingerprint: source.sourceConfigFingerprint,
    });
    runId = started.id;
    const providerOptions = {
      ...options.fetchOptions,
      deadlineAt: deadlines.providerDeadlineAt,
      now: options.now,
    };
    const batch =
      ecowittSource && ecowittStation !== undefined
        ? await (options.fetchEcowitt ?? fetchEcowittLive)(
            {
              expectedMac: ecowittStation.expectedMac,
              gatewayHost: ecowittStation.gatewayHost,
              model: ecowittStation.model,
              previousCursor: checkpoint?.providerCursor ?? null,
              sourceId: source.id,
              timezone: ecowittStation.timezone,
            },
            providerOptions,
          )
        : tempestSource && tempestStation !== undefined
        ? await requireTempestOperation(options.fetchTempest)(
            {
              deviceId: tempestStation.deviceId,
              endExclusive: window.endExclusive,
              locationId: tempestStation.locationId,
              serial: tempestStation.serial,
              sourceId: source.id,
              start: window.start,
              timezone: tempestStation.timezone,
            },
            providerOptions,
          )
        : publicStationSource && publicStationMatch !== null
          ? await (options.fetchPublicStation ?? fetchPublicStationRange)(
              publicStationRequest(
                publicStationMatch.station,
                publicStationMatch.source,
                source.id,
                window,
              ),
              providerOptions,
            )
          : tideSource && tideStation !== undefined
            ? await (options.fetchTide ?? fetchNoaaTideRange)(
                tideScheduledRequest(tideStation, source.id, window, now),
                providerOptions,
              )
          : openMeteoForecastSource
            ? await (options.fetchForecast ?? fetchOpenMeteoForecast)(
                {
                  latitude: options.site.site.latitude,
                  longitude: options.site.site.longitude,
                  sourceId: source.id,
                  timezone: options.site.site.timezone,
                },
                providerOptions,
              )
          : await (options.fetchCurrent ?? fetchOpenMeteoCurrent)(
              {
                latitude: options.site.site.latitude,
                longitude: options.site.site.longitude,
                sourceId: source.id,
                timezone: options.site.site.timezone,
              },
              providerOptions,
            );
    attempts = batch.attempts;
    recordCount = batch.records.length;
    const lastRecord = batch.records.at(-1);

    // reject successful empty batches
    if (lastRecord === undefined) {
      throw new ProviderFailure({
        classification: "invalid_payload",
        code: "empty_payload",
        message: "provider returned no records",
      });
    }

    await options.repository.completeScheduledIngestion(session, {
      attempts,
      expectedCheckpointVersion: checkpoint?.version ?? null,
      lastValidAt: openMeteoForecastSource ||
        tideStation?.source.sourceKind === "tide_prediction"
        ? window.endExclusive
        : lastRecord.validAt,
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
  maximumRangeSeconds: number | null = null,
): Readonly<{ endExclusive: string; start: string }> {
  const cadenceMs = cadenceSeconds * 1_000;

  // require a bounded source cadence
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs < 60_000) {
    throw new RangeError("source cadence must be at least one minute");
  }

  // require an optional range at least as large as one cadence
  if (
    maximumRangeSeconds !== null &&
    (!Number.isSafeInteger(maximumRangeSeconds) ||
      maximumRangeSeconds < cadenceSeconds)
  ) {
    throw new RangeError("scheduled maximum range must cover one cadence");
  }

  const end = Math.floor(now.getTime() / cadenceMs) * cadenceMs;
  const checkpointStart = checkpoint === null
    ? end - cadenceMs
    : Math.min(Date.parse(checkpoint.windowEndExclusive), end - cadenceMs);
  const maximumStart = maximumRangeSeconds === null
    ? checkpointStart
    : end - maximumRangeSeconds * 1_000;
  const start = Math.max(checkpointStart, maximumStart);

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

// require a credential-bound Tempest operation
function requireTempestOperation(
  operation: TempestObservationOperation | undefined,
): TempestObservationOperation {
  // fail before provider I/O when credentials are unavailable
  if (operation === undefined) {
    throw new Error("Tempest scheduled ingestion requires a configured API key");
  }

  return operation;
}

// find one public-station source and its station
function findPublicStationSource(
  configuration: PublicStationConfiguration | null,
  sourceKey: string,
): Readonly<{
  source: PublicStationSourceConfiguration;
  station: PublicStationConfigurationStation;
}> | null {
  // preserve an omitted integration
  if (configuration === null) {
    return null;
  }

  // scan the bounded checked catalog
  for (const station of configuration.stations) {
    const source = station.sources.find((candidate) => candidate.key === sourceKey);

    // return the unique parsed match
    if (source !== undefined) {
      return { source, station };
    }
  }

  return null;
}

// build one provider range from checked material
function publicStationRequest(
  station: PublicStationConfigurationStation,
  source: PublicStationSourceConfiguration,
  sourceId: string,
  window: Readonly<{ endExclusive: string; start: string }>,
): PublicStationRangeRequest {
  const shared = {
    endExclusive: window.endExclusive,
    model: station.model,
    serial: station.serial,
    sourceId,
    start: window.start,
    timezone: station.timezone,
  } as const;

  // build the Ambient request
  if (source.adapter === "ambient-weather") {
    return {
      ...shared,
      adapter: source.adapter,
      deviceId: requireConfiguredString(source.adapterConfig.deviceId, "deviceId"),
      macAddress: requireConfiguredString(
        source.adapterConfig.macAddress,
        "macAddress",
      ),
    };
  }

  // build the Weather Underground request
  if (source.adapter === "weather-underground") {
    return {
      ...shared,
      adapter: source.adapter,
      publicApiKey: requireConfiguredString(
        source.adapterConfig.publicApiKey,
        "publicApiKey",
      ),
      stationId: requireConfiguredString(
        source.adapterConfig.stationId,
        "stationId",
      ),
    };
  }

  // build the PurpleAir request
  if (source.adapter === "purpleair") {
    return {
      ...shared,
      adapter: source.adapter,
      mapVersion: requireConfiguredString(
        source.adapterConfig.mapVersion,
        "mapVersion",
      ),
      sensorIndex: requireConfiguredInteger(
        source.adapterConfig.sensorIndex,
        "sensorIndex",
      ),
    };
  }

  return {
    ...shared,
    adapter: source.adapter,
    deviceId: requireConfiguredString(source.adapterConfig.deviceId, "deviceId"),
    outdoorModuleId: requireConfiguredString(
      source.adapterConfig.outdoorModuleId,
      "outdoorModuleId",
    ),
    rainModuleId: requireConfiguredString(
      source.adapterConfig.rainModuleId,
      "rainModuleId",
    ),
    windModuleId: requireConfiguredString(
      source.adapterConfig.windModuleId,
      "windModuleId",
    ),
  };
}

// build one scheduled NOAA tide range
function tideScheduledRequest(
  station: TideStationConfiguration,
  sourceId: string,
  window: Readonly<{ endExclusive: string; start: string }>,
  now: Date,
): NoaaTideRangeRequest {
  const shared = {
    datum: "MLLW" as const,
    sourceId,
    stationId: station.serial,
    timezone: station.timezone,
  };

  // retain the checkpointed observation window
  if (station.source.sourceKind === "tide_observation") {
    return {
      ...shared,
      endExclusive: window.endExclusive,
      product: "water_level",
      sourceKind: station.source.sourceKind,
      start: window.start,
    };
  }

  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  return {
    ...shared,
    endExclusive: new Date(start + 30 * 86_400_000).toISOString(),
    interval: "hilo",
    product: "predictions",
    sourceKind: station.source.sourceKind,
    start: new Date(start).toISOString(),
  };
}

// label one public provider endpoint without credentials
function publicStationEndpoint(
  adapter: PublicStationSourceConfiguration["adapter"],
): string {
  // label Ambient requests
  if (adapter === "ambient-weather") {
    return "device-data";
  }

  // label Weather Underground requests
  if (adapter === "weather-underground") {
    return "pws/history/all";
  }

  // label PurpleAir public-map history requests
  if (adapter === "purpleair") {
    return "sensors/history/csv";
  }

  return "getmeasure";
}

// require one already-validated material string
function requireConfiguredString(value: unknown, field: string): string {
  // fail closed on impossible in-memory drift
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`public-station ${field} is invalid`);
  }

  return value;
}

// require one already-validated material integer
function requireConfiguredInteger(value: unknown, field: string): number {
  // fail closed on impossible in-memory drift
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`public-station ${field} is invalid`);
  }

  return Number(value);
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
  const fetchForecast = createOpenMeteoForecastOperation(
    configuration.openMeteoCompatibilityOrigin,
  );
  const fetchTempest =
    configuration.tempestApiKey === null
      ? undefined
      : createTempestObservationOperation(configuration.tempestApiKey);
  await assertWorkerDatabaseReadiness(
    pool,
    configuration.migrationDirectory,
    configuration.version,
    configuration.migrationAuthorization,
  );
  const durableHealth = await readWorkerHealth(pool, configuration.instance);
  const runIteration = createWorkerIterationRunner(pool, {
    fetchCurrent,
    fetchForecast,
    ...(fetchTempest === undefined ? {} : { fetchTempest }),
    instance: configuration.instance,
    lastSuccessAt: durableHealth.lastSuccessAt,
    site: configuration.site,
    publicStations: configuration.publicStations,
    ecowitt: configuration.ecowitt,
    tempest: configuration.tempest,
    tides: configuration.tides,
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
  let startupBackfill: Promise<void> | null = null;

  // run one compatibility loop without retaining timers
  if (options.once === true) {
    await scheduler.trigger();
    await pool.end();
    return;
  }

  // close the retained database pool on termination
  const shutdown = async (): Promise<void> => {
    scheduler.stop();

    // allow an active exact chunk to finish during graceful shutdown
    if (startupBackfill !== null) {
      await startupBackfill.catch(() => undefined);
    }

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
  startupBackfill = runStartupPublicStationBackfill(
    pool,
    configuration.publicStations,
    configuration.version,
  );
}

// resume configured public archives without blocking worker readiness
async function runStartupPublicStationBackfill(
  pool: DatabasePool,
  configuration: PublicStationConfiguration | null,
  version: string,
): Promise<void> {
  // preserve an explicitly disabled integration
  if (configuration === null) {
    return;
  }

  const startedAt = Date.now();

  try {
    const sources = await resolvePublicStationBackfillSources(
      pool,
      configuration,
      [],
    );
    const today = new Date().toISOString().slice(0, 10);
    const report = await executePublicStationBackfill(
      pool,
      {
        dryRun: false,
        from: null,
        reportPath: null,
        resume: true,
        site: configuration.siteKey,
        sourceKeys: [],
        to: addUtcDays(today, -1),
      },
      configuration,
      sources,
    );

    // emit one bounded result per source
    for (const source of report.sources) {
      writeWorkerDiagnostic(
        createWorkerDiagnostic({
          count: source.records,
          durationMs: Date.now() - startedAt,
          errorCode:
            source.exitCode === 0 ? null : "public_station_backfill_failed",
          event: "source_run",
          release: version,
          runId: null,
          sourceId: source.source,
        }),
      );
    }
  } catch {
    // emit only an allowlisted startup failure
    writeWorkerDiagnostic(
      createWorkerDiagnostic({
        count: 0,
        durationMs: Date.now() - startedAt,
        errorCode: "public_station_backfill_failed",
        event: "worker_iteration",
        release: version,
        runId: null,
        sourceId: null,
      }),
    );
  }
}

// add UTC calendar days
function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
