import { createHash } from "node:crypto";

import {
  FORECAST_ADJUSTMENT_METRICS,
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
  createBackfillChunkIdentity,
  createFixedLeadAnchorTrainingRow,
  createLegacyV4RetrievalSnapshotTrainingRow,
  forecastAnchorRecordContent,
  validateFingerprint,
  validateIngestionError,
  validateUtcInstant,
  validateVersion,
  weatherRecordContent,
  type BackfillChunkIdentity,
  type CanonicalWeatherMetrics,
  type FixedLeadAnchorTrainingRow,
  type ForecastAdjustmentMetric,
  type ForecastObservationProviderFamily,
  type ForecastObservationStationKey,
  type IngestionError,
  type IngestionMode,
  type JsonValue,
  type LegacyV4RetrievalSnapshotTrainingRow,
  type NormalizedForecastAnchorRecord,
  type NormalizedWeatherRecord,
  type SourceKind,
  type StationKind,
} from "@weather/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { SiteConfiguration } from "./config.js";
import type { EcowittConfiguration } from "./ecowitt-config.js";
import { withTransaction } from "./pool.js";
import type { PublicStationConfiguration } from "./public-stations-config.js";
import type { TempestConfiguration } from "./tempest-config.js";
import type { TideConfiguration } from "./tides-config.js";

// remain below PostgreSQL's parameter limit
const WEATHER_RECORD_BATCH_SIZE = 2_000;
// remain below PostgreSQL's parameter limit for anchor rows
const FORECAST_ANCHOR_RECORD_BATCH_SIZE = 2_000;
// bound ten civil forecast days with daylight-saving headroom
const MAX_FORECAST_HOURS = 264;
// match the production export window ceiling
const MAX_FORECAST_TRAINING_DAYS = 450;
// freeze one UTC hour
const HOUR_MILLISECONDS = 3_600_000;
// freeze station sampling windows
const FIVE_MINUTES_MILLISECONDS = 5 * 60_000;
const TEN_MINUTES_MILLISECONDS = 10 * 60_000;

// hide non-live or superseded sources
const CURRENT_SOURCE_PREDICATE = "weather_source_is_current(s.id)";

export interface DueSource extends QueryResultRow {
  readonly active: boolean;
  readonly cadenceSeconds: number;
  readonly id: string;
  readonly materialProviderConfig: JsonValue;
  readonly providerKey: string;
  readonly siteSlug: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationSlug: string;
  readonly timezone: string;
}

// expose one active discovery row
export interface ActiveSiteRow extends QueryResultRow {
  readonly attributionLabel: string;
  readonly attributionUrl: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly providerKey: string;
  readonly providerName: string;
  readonly siteName: string;
  readonly siteSlug: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationKind: StationKind;
  readonly stationLatitude: number;
  readonly stationLongitude: number;
  readonly stationName: string;
  readonly stationSlug: string;
  readonly timezone: string;
}

export interface StartIngestionRunInput {
  readonly adapterVersion: string;
  readonly attempts?: number;
  readonly chunkPlanVersion?: string | null;
  readonly deadlineAt: string;
  readonly mode: IngestionMode;
  readonly requestMetadata?: Readonly<Record<string, JsonValue>> | null;
  readonly requestedEndExclusive: string;
  readonly requestedStart: string;
  readonly sourceConfigFingerprint: string;
}

export interface StartedIngestionRun extends QueryResultRow {
  readonly id: string;
  readonly startedAt: string;
  readonly state: "running";
}

export interface ScheduledCheckpointState {
  readonly lastCommittedAt: string;
  readonly lastValidAt: string;
  readonly providerCursor: Readonly<Record<string, JsonValue>> | null;
  readonly sourceId: string;
  readonly version: number;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface CompleteScheduledIngestionInput {
  readonly attempts: number;
  readonly expectedCheckpointVersion: number | null;
  readonly lastValidAt: string;
  readonly providerCursor: Readonly<Record<string, JsonValue>> | null;
  readonly records: readonly NormalizedWeatherRecord[];
  readonly responseMetadata?: Readonly<Record<string, JsonValue>> | null;
  readonly runId: string;
  readonly upstreamResponseChecksum?: string | null;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface CompleteBackfillIngestionInput {
  readonly attempts: number;
  readonly identity: BackfillChunkIdentity;
  readonly records: readonly NormalizedWeatherRecord[];
  readonly responseMetadata?: Readonly<Record<string, JsonValue>> | null;
  readonly runId: string;
  readonly upstreamResponseChecksum?: string | null;
}

export interface CompleteForecastAnchorBackfillIngestionInput {
  readonly attempts: number;
  readonly identity: BackfillChunkIdentity;
  readonly records: readonly NormalizedForecastAnchorRecord[];
  readonly responseMetadata?: Readonly<Record<string, JsonValue>> | null;
  readonly runId: string;
  readonly upstreamResponseChecksum?: string | null;
}

export interface FailIngestionRunInput {
  readonly attempts: number;
  readonly backfillIdentity?: BackfillChunkIdentity;
  readonly error: IngestionError;
  readonly responseMetadata?: Readonly<Record<string, JsonValue>> | null;
  readonly runId: string;
}

export interface HistoryQuery {
  readonly cursor?: Readonly<{ id: string; validAt: string }>;
  readonly from?: string;
  readonly limit?: number;
  readonly siteSlug: string;
  readonly sourceId?: string;
  readonly sourceKind?: SourceKind;
  readonly stationSlug?: string;
  readonly to?: string;
}

export interface CurrentQuery {
  readonly sourceId?: string;
  readonly stationSlug?: string;
}

export interface ForecastQuery {
  readonly asOf: string;
  readonly hours: number;
  readonly siteSlug: string;
}

export interface ForecastTrainingQuery {
  readonly from: string;
  readonly siteSlug: string;
  readonly to: string;
}

export interface ForecastTrainingCohorts {
  readonly fixedLeadAnchors: readonly FixedLeadAnchorTrainingRow[];
  readonly legacyV4RetrievalSnapshots: readonly LegacyV4RetrievalSnapshotTrainingRow[];
}

export type ForecastObservationHourlyMetrics = Readonly<
  Record<ForecastAdjustmentMetric, number | null>
>;

export interface ForecastObservationHourlyStationRow {
  readonly metrics: ForecastObservationHourlyMetrics;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly sourceKeys: readonly string[];
  readonly validAt: string;
}

interface ForecastAnchorStorageRow extends QueryResultRow {
  readonly adapterVersion: string;
  readonly apparentTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  readonly contractEpoch: string;
  readonly dataset: "previous_runs";
  readonly leadHours: number;
  readonly pressureHpa: number | null;
  readonly precipitationMm: number | null;
  readonly providerMetadata: Readonly<Record<string, JsonValue>> | null;
  readonly qualityMetadata: Readonly<Record<string, JsonValue>> | null;
  readonly receivedAt: Date | string;
  readonly relativeHumidityPercent: number | null;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly temperatureC: number | null;
  readonly upstreamModel: "best_match";
  readonly upstreamTimezone: string;
  readonly validAt: Date | string;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

interface LegacyV4ForecastStorageRow extends QueryResultRow {
  readonly adapterVersion: string | null;
  readonly apparentTemperatureC: number | null;
  readonly blackGlobeTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  readonly dataset: string | null;
  readonly pm25MicrogramsPerCubicMeter: number | null;
  readonly precipitationMm: number | null;
  readonly precipitationRateMmPerHour: number | null;
  readonly pressureHpa: number | null;
  readonly referenceAt: Date | string;
  readonly relativeHumidityPercent: number | null;
  readonly soilElectricalConductivityMicrosiemensPerCm: number | null;
  readonly soilMoisturePercent: number | null;
  readonly solarRadiationWm2: number | null;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly stableRecordId: string;
  readonly temperatureC: number | null;
  readonly upstreamModel: string | null;
  readonly uvIndex: number | null;
  readonly validAt: Date | string;
  readonly waterLevelM: number | null;
  readonly wetBulbGlobeTemperatureC: number | null;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

interface ForecastObservationStorageRow extends QueryResultRow {
  readonly adapterContract: string | null;
  readonly id: string;
  readonly qualityMetadata: Readonly<Record<string, JsonValue>> | null;
  readonly relativeHumidityPercent: number | null;
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly stationSlug: string;
  readonly temperatureC: number | null;
  readonly validAt: Date | string;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

interface ValidatedForecastObservationStorageRow {
  readonly id: string;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly relativeHumidityPercent: number | null;
  readonly sourceKey: string;
  readonly temperatureC: number | null;
  readonly validAt: string;
  readonly validAtMilliseconds: number;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

export interface TrendQuery {
  readonly from: string;
  readonly siteSlug: string;
  readonly to: string;
}

export interface DailyPrecipitationQuery {
  readonly from: string;
  readonly siteSlug: string;
  readonly to: string;
}

export interface DailyPrecipitationRow extends QueryResultRow {
  readonly accumulationMm: number;
  readonly sourceId: string;
  readonly stationSlug: string;
  readonly validThrough: Date | string;
}

export interface TideQuery {
  readonly from: string;
  readonly limit?: number;
  readonly siteSlug: string;
  readonly to: string;
}

export interface TrendPointRow extends QueryResultRow {
  readonly apparentTemperatureC: number | null;
  readonly precipitationMm: number | null;
  readonly pressureHpa: number | null;
  readonly relativeHumidityPercent: number | null;
  readonly temperatureC: number | null;
  readonly temperatureMaximumC: number | null;
  readonly temperatureMinimumC: number | null;
  readonly validAt: Date;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

export interface LatestWorkerHeartbeat extends QueryResultRow {
  readonly lastLoopAt: Date | string;
}

export interface WeatherRecordRow extends QueryResultRow {
  readonly adapterVersion: string | null;
  readonly apparentTemperatureC: number | null;
  readonly blackGlobeTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  readonly contractEpoch: string | null;
  readonly deviceModel: string | null;
  readonly deviceSerial: string | null;
  readonly deviceVendor: string | null;
  readonly firstReceivedAt: Date | string;
  readonly id: string;
  readonly lastReceivedAt: Date | string;
  readonly pm25MicrogramsPerCubicMeter: number | null;
  readonly precipitationMm: number | null;
  readonly precipitationRateMmPerHour: number | null;
  readonly pressureHpa: number | null;
  readonly productRunAt: Date | string | null;
  readonly providerKey: string;
  readonly providerMetadata: Readonly<Record<string, JsonValue>> | null;
  readonly qualityMetadata: Readonly<Record<string, JsonValue>> | null;
  readonly relativeHumidityPercent: number | null;
  readonly revisionCount: number;
  readonly siteSlug: string;
  readonly sourceId: string;
  readonly sourceConfigFingerprint: string | null;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationSlug: string;
  readonly soilElectricalConductivityMicrosiemensPerCm: number | null;
  readonly soilMoisturePercent: number | null;
  readonly solarRadiationWm2: number | null;
  readonly temperatureC: number | null;
  readonly upstreamModel: string | null;
  readonly upstreamTimezone: string;
  readonly uvIndex: number | null;
  readonly validAt: Date | string;
  readonly waterLevelM: number | null;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
  readonly wetBulbGlobeTemperatureC: number | null;
}

interface ForecastRuntimeProvenanceRow extends QueryResultRow {
  readonly adapterVersion: string;
  readonly contractEpoch: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly weatherRecordId: string;
}

export interface TideRecordRow extends QueryResultRow {
  readonly attributionLabel: string;
  readonly attributionUrl: string;
  readonly predictionType: string | null;
  readonly providerKey: string;
  readonly sourceId: string;
  readonly sourceKind: "tide_observation" | "tide_prediction";
  readonly stationName: string;
  readonly stationSlug: string;
  readonly validAt: Date | string;
  readonly waterLevelM: number;
}

// retain one source-scoped advisory lock
export class SourceSession {
  readonly #client: PoolClient;
  #released = false;
  readonly sourceId: string;

  // initialize a claimed source session
  constructor(client: PoolClient, sourceId: string) {
    this.#client = client;
    this.sourceId = sourceId;
  }

  // expose the retained client internally
  get client(): PoolClient {
    // reject use after release
    if (this.#released) {
      throw new Error("source session has already been released");
    }

    return this.#client;
  }

  // release the source lock and client
  async release(): Promise<void> {
    // make release idempotent
    if (this.#released) {
      return;
    }

    try {
      await this.#client.query(
        "SELECT pg_advisory_unlock(hashtextextended('weather-source:' || $1, 0))",
        [this.sourceId],
      );
    } finally {
      this.#released = true;
      this.#client.release();
    }
  }
}

// idempotently bootstrap configured entities
export async function bootstrapSiteConfiguration(
  pool: Pool,
  configuration: SiteConfiguration,
): Promise<Readonly<{ providerId: string; siteId: string; sourceIds: readonly string[]; stationId: string }>> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const site = await client.query<{ id: string }>(
        `
          INSERT INTO sites (slug, display_name, latitude, longitude, timezone, active)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (slug) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            timezone = EXCLUDED.timezone,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          configuration.site.key,
          configuration.site.displayName,
          configuration.site.latitude,
          configuration.site.longitude,
          configuration.site.timezone,
          configuration.site.active,
        ],
      );
      const provider = await client.query<{ id: string }>(
        `
          INSERT INTO providers (
            provider_key,
            display_name,
            attribution_label,
            attribution_url,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            attribution_label = EXCLUDED.attribution_label,
            attribution_url = EXCLUDED.attribution_url,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          configuration.provider.key,
          configuration.provider.displayName,
          configuration.provider.attributionLabel,
          configuration.provider.attributionUrl,
          configuration.provider.active,
        ],
      );
      const siteId = requireRow(site.rows[0], "site bootstrap").id;
      const providerId = requireRow(provider.rows[0], "provider bootstrap").id;
      const station = await client.query<{ id: string }>(
        `
          INSERT INTO stations (
            site_id,
            slug,
            display_name,
            station_kind,
            latitude,
            longitude,
            vendor,
            model,
            serial,
            active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (site_id, slug) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            station_kind = EXCLUDED.station_kind,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            vendor = EXCLUDED.vendor,
            model = EXCLUDED.model,
            serial = EXCLUDED.serial,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          siteId,
          configuration.station.key,
          configuration.station.displayName,
          configuration.station.kind,
          configuration.station.latitude,
          configuration.station.longitude,
          configuration.station.vendor,
          configuration.station.model,
          configuration.station.serial,
          configuration.station.active,
        ],
      );
      const stationId = requireRow(station.rows[0], "station bootstrap").id;
      const sourceIds: string[] = [];

      // bootstrap every immutable source
      for (const source of configuration.sources) {
        const result = await client.query<{ id: string }>(
          `
            INSERT INTO sources (
              station_id,
              provider_id,
              source_key,
              source_kind,
              material_provider_config,
              source_config_fingerprint,
              capabilities,
              cadence_seconds,
              active
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
            ON CONFLICT (station_id, source_key) DO UPDATE SET
              cadence_seconds = EXCLUDED.cadence_seconds,
              active = EXCLUDED.active
            WHERE sources.source_config_fingerprint = EXCLUDED.source_config_fingerprint
            RETURNING id
          `,
          [
            stationId,
            providerId,
            source.key,
            source.sourceKind,
            JSON.stringify(source.adapterConfig),
            source.fingerprint,
            JSON.stringify(source.capabilities),
            source.cadenceSeconds,
            source.active,
          ],
        );

        // reject silent semantic drift
        if (result.rowCount !== 1 || result.rows[0] === undefined) {
          throw new Error(
            `source ${source.key} changed material configuration; create a new source key`,
          );
        }

        sourceIds.push(result.rows[0].id);
      }

      return { providerId, siteId, sourceIds, stationId };
    });
  } finally {
    client.release();
  }
}

// bootstrap the configured physical Tempest sources
export async function bootstrapTempestConfiguration(
  pool: Pool,
  configuration: TempestConfiguration,
): Promise<Readonly<{
  providerId: string;
  sourceIds: Readonly<Record<string, string>>;
  stationIds: Readonly<Record<string, string>>;
}>> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const site = await client.query<{ id: string }>(
        "SELECT id FROM sites WHERE slug = $1 AND active",
        [configuration.siteKey],
      );
      const siteId = requireRow(site.rows[0], "Tempest site bootstrap").id;
      const provider = await client.query<{ id: string }>(
        `
          INSERT INTO providers (
            provider_key,
            display_name,
            attribution_label,
            attribution_url,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            attribution_label = EXCLUDED.attribution_label,
            attribution_url = EXCLUDED.attribution_url,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          configuration.provider.key,
          configuration.provider.displayName,
          configuration.provider.attributionLabel,
          configuration.provider.attributionUrl,
          configuration.provider.active,
        ],
      );
      const providerId = requireRow(provider.rows[0], "Tempest provider bootstrap").id;
      const stationIds: Record<string, string> = {};
      const sourceIds: Record<string, string> = {};

      // bootstrap every configured station and source
      for (const station of configuration.stations) {
        const stationResult = await client.query<{ id: string }>(
          `
            INSERT INTO stations (
              site_id,
              slug,
              display_name,
              station_kind,
              latitude,
              longitude,
              vendor,
              model,
              serial,
              active
            )
            VALUES ($1, $2, $3, 'physical', $4, $5, 'WeatherFlow', 'Tempest', $6, $7)
            ON CONFLICT (site_id, slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              station_kind = EXCLUDED.station_kind,
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              vendor = EXCLUDED.vendor,
              model = EXCLUDED.model,
              serial = EXCLUDED.serial,
              active = EXCLUDED.active,
              updated_at = clock_timestamp()
            RETURNING id
          `,
          [
            siteId,
            station.key,
            station.displayName,
            station.latitude,
            station.longitude,
            station.serial,
            station.active,
          ],
        );
        const stationId = requireRow(
          stationResult.rows[0],
          `Tempest station ${station.key} bootstrap`,
        ).id;
        const sourceResult = await client.query<{ id: string }>(
          `
            INSERT INTO sources (
              station_id,
              provider_id,
              source_key,
              source_kind,
              material_provider_config,
              source_config_fingerprint,
              capabilities,
              cadence_seconds,
              active
            )
            VALUES ($1, $2, $3, 'physical_sensor', $4::jsonb, $5, $6::jsonb, $7, $8)
            ON CONFLICT (station_id, source_key) DO UPDATE SET
              cadence_seconds = EXCLUDED.cadence_seconds,
              active = EXCLUDED.active
            WHERE sources.source_config_fingerprint = EXCLUDED.source_config_fingerprint
            RETURNING id
          `,
          [
            stationId,
            providerId,
            station.sourceKey,
            JSON.stringify(station.adapterConfig),
            station.fingerprint,
            JSON.stringify(["current", "historical"]),
            station.cadenceSeconds,
            station.active,
          ],
        );

        // reject silent immutable-source drift
        if (sourceResult.rowCount !== 1 || sourceResult.rows[0] === undefined) {
          throw new Error(
            `Tempest source ${station.sourceKey} changed material configuration; create a new source key`,
          );
        }

        stationIds[station.key] = stationId;
        sourceIds[station.sourceKey] = sourceResult.rows[0].id;
      }

      return { providerId, sourceIds, stationIds };
    });
  } finally {
    client.release();
  }
}

// bootstrap configured first-party Ecowitt gateways
export async function bootstrapEcowittConfiguration(
  pool: Pool,
  configuration: EcowittConfiguration,
): Promise<Readonly<{
  providerId: string;
  sourceIds: Readonly<Record<string, string>>;
  stationIds: Readonly<Record<string, string>>;
}>> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const site = await client.query<{ id: string }>(
        "SELECT id FROM sites WHERE slug = $1 AND active",
        [configuration.siteKey],
      );
      const siteId = requireRow(site.rows[0], "Ecowitt site bootstrap").id;
      const provider = await client.query<{ id: string }>(
        `
          INSERT INTO providers (
            provider_key,
            display_name,
            attribution_label,
            attribution_url,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            attribution_label = EXCLUDED.attribution_label,
            attribution_url = EXCLUDED.attribution_url,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          configuration.provider.key,
          configuration.provider.displayName,
          configuration.provider.attributionLabel,
          configuration.provider.attributionUrl,
          configuration.provider.active,
        ],
      );
      const providerId = requireRow(provider.rows[0], "Ecowitt provider bootstrap").id;
      const stationIds: Record<string, string> = {};
      const sourceIds: Record<string, string> = {};

      // bootstrap every configured gateway and source
      for (const station of configuration.stations) {
        const stationResult = await client.query<{ id: string }>(
          `
            INSERT INTO stations (
              site_id,
              slug,
              display_name,
              station_kind,
              latitude,
              longitude,
              vendor,
              model,
              serial,
              active
            )
            VALUES ($1, $2, $3, 'physical', $4, $5, 'Ecowitt', $6, $7, $8)
            ON CONFLICT (site_id, slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              station_kind = EXCLUDED.station_kind,
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              vendor = EXCLUDED.vendor,
              model = EXCLUDED.model,
              serial = EXCLUDED.serial,
              active = EXCLUDED.active,
              updated_at = clock_timestamp()
            RETURNING id
          `,
          [
            siteId,
            station.key,
            station.displayName,
            station.latitude,
            station.longitude,
            station.model,
            station.expectedMac,
            station.active,
          ],
        );
        const stationId = requireRow(
          stationResult.rows[0],
          `Ecowitt station ${station.key} bootstrap`,
        ).id;
        const sourceResult = await client.query<{ id: string }>(
          `
            INSERT INTO sources (
              station_id,
              provider_id,
              source_key,
              source_kind,
              material_provider_config,
              source_config_fingerprint,
              capabilities,
              cadence_seconds,
              active
            )
            VALUES ($1, $2, $3, 'physical_sensor', $4::jsonb, $5, $6::jsonb, $7, $8)
            ON CONFLICT (station_id, source_key) DO UPDATE SET
              cadence_seconds = EXCLUDED.cadence_seconds,
              active = EXCLUDED.active
            WHERE sources.source_config_fingerprint = EXCLUDED.source_config_fingerprint
            RETURNING id
          `,
          [
            stationId,
            providerId,
            station.sourceKey,
            JSON.stringify(station.adapterConfig),
            station.fingerprint,
            JSON.stringify(["current"]),
            station.cadenceSeconds,
            station.active,
          ],
        );

        // reject silent immutable-source drift
        if (sourceResult.rowCount !== 1 || sourceResult.rows[0] === undefined) {
          throw new Error(
            `Ecowitt source ${station.sourceKey} changed material configuration; create a new source key`,
          );
        }

        stationIds[station.key] = stationId;
        sourceIds[station.sourceKey] = sourceResult.rows[0].id;
      }

      return { providerId, sourceIds, stationIds };
    });
  } finally {
    client.release();
  }
}

// bootstrap configured public physical-station sources
export async function bootstrapPublicStationConfiguration(
  pool: Pool,
  configuration: PublicStationConfiguration,
): Promise<Readonly<{
  providerIds: Readonly<Record<string, string>>;
  sourceIds: Readonly<Record<string, string>>;
  stationIds: Readonly<Record<string, string>>;
}>> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const site = await client.query<{ id: string }>(
        "SELECT id FROM sites WHERE slug = $1 AND active",
        [configuration.siteKey],
      );
      const siteId = requireRow(site.rows[0], "public-station site bootstrap").id;
      const providerIds: Record<string, string> = {};

      // bootstrap every declared provider
      for (const provider of configuration.providers) {
        const result = await client.query<{ id: string }>(
          `
            INSERT INTO providers (
              provider_key,
              display_name,
              attribution_label,
              attribution_url,
              active
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (provider_key) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              attribution_label = EXCLUDED.attribution_label,
              attribution_url = EXCLUDED.attribution_url,
              active = EXCLUDED.active,
              updated_at = clock_timestamp()
            RETURNING id
          `,
          [
            provider.key,
            provider.displayName,
            provider.attributionLabel,
            provider.attributionUrl,
            provider.active,
          ],
        );
        providerIds[provider.key] = requireRow(
          result.rows[0],
          `public-station provider ${provider.key} bootstrap`,
        ).id;
      }

      const stationIds: Record<string, string> = {};
      const sourceIds: Record<string, string> = {};

      // bootstrap every configured station
      for (const station of configuration.stations) {
        const stationResult = await client.query<{ id: string }>(
          `
            INSERT INTO stations (
              site_id,
              slug,
              display_name,
              station_kind,
              latitude,
              longitude,
              vendor,
              model,
              serial,
              active
            )
            VALUES ($1, $2, $3, 'physical', $4, $5, $6, $7, $8, $9)
            ON CONFLICT (site_id, slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              station_kind = EXCLUDED.station_kind,
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              vendor = EXCLUDED.vendor,
              model = EXCLUDED.model,
              serial = EXCLUDED.serial,
              active = EXCLUDED.active,
              updated_at = clock_timestamp()
            RETURNING id
          `,
          [
            siteId,
            station.key,
            station.displayName,
            station.latitude,
            station.longitude,
            station.vendor,
            station.model,
            station.serial,
            station.active,
          ],
        );
        const stationId = requireRow(
          stationResult.rows[0],
          `public station ${station.key} bootstrap`,
        ).id;
        stationIds[station.key] = stationId;

        // bootstrap every immutable source
        for (const source of station.sources) {
          const providerId = providerIds[source.providerKey];

          // require the parsed provider mapping
          if (providerId === undefined) {
            throw new Error(`public-station provider ${source.providerKey} is missing`);
          }

          const sourceResult = await client.query<{ id: string }>(
            `
              INSERT INTO sources (
                station_id,
                provider_id,
                source_key,
                source_kind,
                material_provider_config,
                source_config_fingerprint,
                capabilities,
                cadence_seconds,
                active
              )
              VALUES ($1, $2, $3, 'physical_sensor', $4::jsonb, $5, $6::jsonb, $7, $8)
              ON CONFLICT (station_id, source_key) DO UPDATE SET
                cadence_seconds = EXCLUDED.cadence_seconds,
                active = EXCLUDED.active
              WHERE sources.source_config_fingerprint = EXCLUDED.source_config_fingerprint
              RETURNING id
            `,
            [
              stationId,
              providerId,
              source.key,
              JSON.stringify(source.adapterConfig),
              source.fingerprint,
              JSON.stringify(source.capabilities),
              source.cadenceSeconds,
              source.active,
            ],
          );

          // reject silent immutable-source drift
          if (sourceResult.rowCount !== 1 || sourceResult.rows[0] === undefined) {
            throw new Error(
              `public-station source ${source.key} changed material configuration; create a new source key`,
            );
          }

          sourceIds[source.key] = sourceResult.rows[0].id;
        }
      }

      return { providerIds, sourceIds, stationIds };
    });
  } finally {
    client.release();
  }
}

// bootstrap configured NOAA tide sources
export async function bootstrapTideConfiguration(
  pool: Pool,
  configuration: TideConfiguration,
): Promise<Readonly<{
  providerId: string;
  sourceIds: Readonly<Record<string, string>>;
  stationIds: Readonly<Record<string, string>>;
}>> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const site = await client.query<{ id: string }>(
        "SELECT id FROM sites WHERE slug = $1 AND active",
        [configuration.siteKey],
      );
      const siteId = requireRow(site.rows[0], "tide site bootstrap").id;
      const provider = await client.query<{ id: string }>(
        `
          INSERT INTO providers (
            provider_key,
            display_name,
            attribution_label,
            attribution_url,
            active
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            attribution_label = EXCLUDED.attribution_label,
            attribution_url = EXCLUDED.attribution_url,
            active = EXCLUDED.active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          configuration.provider.key,
          configuration.provider.displayName,
          configuration.provider.attributionLabel,
          configuration.provider.attributionUrl,
          configuration.provider.active,
        ],
      );
      const providerId = requireRow(provider.rows[0], "tide provider bootstrap").id;
      const stationIds: Record<string, string> = {};
      const sourceIds: Record<string, string> = {};

      // bootstrap every tide station and source
      for (const station of configuration.stations) {
        const stationResult = await client.query<{ id: string }>(
          `
            INSERT INTO stations (
              site_id,
              slug,
              display_name,
              station_kind,
              latitude,
              longitude,
              vendor,
              model,
              serial,
              active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (site_id, slug) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              station_kind = EXCLUDED.station_kind,
              latitude = EXCLUDED.latitude,
              longitude = EXCLUDED.longitude,
              vendor = EXCLUDED.vendor,
              model = EXCLUDED.model,
              serial = EXCLUDED.serial,
              active = EXCLUDED.active,
              updated_at = clock_timestamp()
            RETURNING id
          `,
          [
            siteId,
            station.key,
            station.displayName,
            station.kind,
            station.latitude,
            station.longitude,
            station.vendor,
            station.model,
            station.serial,
            station.active,
          ],
        );
        const stationId = requireRow(
          stationResult.rows[0],
          `tide station ${station.key} bootstrap`,
        ).id;
        const source = station.source;
        const sourceResult = await client.query<{ id: string }>(
          `
            INSERT INTO sources (
              station_id,
              provider_id,
              source_key,
              source_kind,
              material_provider_config,
              source_config_fingerprint,
              capabilities,
              cadence_seconds,
              active
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
            ON CONFLICT (station_id, source_key) DO UPDATE SET
              cadence_seconds = EXCLUDED.cadence_seconds,
              active = EXCLUDED.active
            WHERE sources.source_config_fingerprint = EXCLUDED.source_config_fingerprint
            RETURNING id
          `,
          [
            stationId,
            providerId,
            source.key,
            source.sourceKind,
            JSON.stringify(source.adapterConfig),
            source.fingerprint,
            JSON.stringify(source.capabilities),
            source.cadenceSeconds,
            station.active && source.active,
          ],
        );

        // reject silent immutable-source drift
        if (sourceResult.rowCount !== 1 || sourceResult.rows[0] === undefined) {
          throw new Error(
            `tide source ${source.key} changed material configuration; create a new source key`,
          );
        }

        stationIds[station.key] = stationId;
        sourceIds[source.key] = sourceResult.rows[0].id;
      }

      return { providerId, sourceIds, stationIds };
    });
  } finally {
    client.release();
  }
}

// discover scheduled sources due for work
export async function discoverDueSources(
  pool: Pool,
  asOf: string,
  limit = 100,
): Promise<readonly DueSource[]> {
  const validatedAsOf = validateUtcInstant(asOf, "asOf");

  // enforce bounded discovery
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("source discovery limit must be between 1 and 500");
  }

  const result = await pool.query<DueSource>(
    `
      SELECT
        s.id,
        s.source_key AS "sourceKey",
        s.source_kind AS "sourceKind",
        s.source_config_fingerprint AS "sourceConfigFingerprint",
        s.material_provider_config AS "materialProviderConfig",
        s.cadence_seconds AS "cadenceSeconds",
        s.active,
        st.slug AS "stationSlug",
        si.slug AS "siteSlug",
        si.timezone,
        p.provider_key AS "providerKey"
      FROM sources s
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      LEFT JOIN ingestion_checkpoints checkpoint ON checkpoint.source_id = s.id
      WHERE s.active
        AND st.active
        AND si.active
        AND p.active
        AND ${CURRENT_SOURCE_PREDICATE}
        AND s.cadence_seconds IS NOT NULL
        AND (
          checkpoint.last_committed_at IS NULL
          OR checkpoint.last_committed_at + make_interval(secs => s.cadence_seconds) <= $1
        )
      ORDER BY checkpoint.last_committed_at ASC NULLS FIRST, s.id ASC
      LIMIT $2
    `,
    [validatedAsOf, limit],
  );

  return result.rows;
}

// try to retain one per-source session lock
export async function acquireSourceSession(
  pool: Pool,
  sourceId: string,
): Promise<SourceSession | null> {
  const client = await pool.connect();

  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('weather-source:' || $1, 0)) AS acquired",
      [sourceId],
    );

    // release unclaimed clients
    if (result.rows[0]?.acquired !== true) {
      client.release();
      return null;
    }

    return new SourceSession(client, sourceId);
  } catch (error) {
    client.release();
    throw error;
  }
}

// recover expired work under its source lock
export async function abandonExpiredRuns(
  session: SourceSession,
  asOf: string,
): Promise<readonly string[]> {
  const result = await session.client.query<{ id: string }>(
    `
      UPDATE ingestion_runs
      SET
        state = 'abandoned',
        completed_at = $2,
        error_classification = 'retryable',
        error_code = 'deadline_expired',
        error_message = 'ingestion run exceeded its recovery deadline'
      WHERE source_id = $1
        AND state = 'running'
        AND deadline_at < $2
      RETURNING id
    `,
    [session.sourceId, validateUtcInstant(asOf, "asOf")],
  );

  return result.rows.map((row) => row.id);
}

// commit a running row before provider I/O
export async function startIngestionRun(
  session: SourceSession,
  input: StartIngestionRunInput,
): Promise<StartedIngestionRun> {
  const requestedStart = validateUtcInstant(input.requestedStart, "requestedStart");
  const requestedEndExclusive = validateUtcInstant(
    input.requestedEndExclusive,
    "requestedEndExclusive",
  );
  const deadlineAt = validateUtcInstant(input.deadlineAt, "deadlineAt");

  // require ordered request bounds
  if (requestedStart >= requestedEndExclusive) {
    throw new RangeError("ingestion interval must be increasing");
  }

  // require a future recovery deadline
  if (deadlineAt <= new Date().toISOString()) {
    throw new RangeError("ingestion deadline must be in the future");
  }

  validateFingerprint(input.sourceConfigFingerprint);
  validateVersion(input.adapterVersion, "adapterVersion");

  // validate backfill plan identity
  if (input.mode === "backfill" && input.chunkPlanVersion == null) {
    throw new RangeError("backfill runs require chunkPlanVersion");
  }

  // validate optional plan version
  if (input.chunkPlanVersion != null) {
    validateVersion(input.chunkPlanVersion, "chunkPlanVersion");
  }

  const existing = await session.client.query<{ deadline_at: Date; id: string }>(
    `
      SELECT id, deadline_at
      FROM ingestion_runs
      WHERE source_id = $1
        AND state = 'running'
      FOR UPDATE
    `,
    [session.sourceId],
  );

  // reject replacement before explicit recovery
  if (existing.rowCount !== 0) {
    throw new Error(
      `source already has a running ingestion: ${existing.rows[0]?.id ?? "unknown"}`,
    );
  }

  const result = await session.client.query<StartedIngestionRun>(
    `
      INSERT INTO ingestion_runs (
        source_id,
        mode,
        requested_start,
        requested_end_exclusive,
        source_config_fingerprint,
        adapter_version,
        chunk_plan_version,
        deadline_at,
        attempts,
        request_metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      RETURNING id, started_at AS "startedAt", state
    `,
    [
      session.sourceId,
      input.mode,
      requestedStart,
      requestedEndExclusive,
      input.sourceConfigFingerprint,
      input.adapterVersion,
      input.chunkPlanVersion ?? null,
      deadlineAt,
      input.attempts ?? 0,
      serializeNullableJson(input.requestMetadata ?? null),
    ],
  );

  return requireRow(result.rows[0], "running ingestion insert");
}

// atomically store scheduled success
export async function completeScheduledIngestion(
  session: SourceSession,
  input: CompleteScheduledIngestionInput,
): Promise<void> {
  validateCompletionCounts(input.attempts, input.records.length);

  await withTransaction(session.client, async () => {
    await assertScheduledRunMatches(session, input);
    await upsertWeatherRecords(session, input.runId, input.records);
    await advanceScheduledCheckpoint(session, input);
    await finalizeSuccessfulRun(
      session,
      input.runId,
      input.attempts,
      input.records.length,
      input.responseMetadata ?? null,
      input.upstreamResponseChecksum ?? null,
      "scheduled",
    );
  });
}

// atomically store backfill success
export async function completeBackfillIngestion(
  session: SourceSession,
  input: CompleteBackfillIngestionInput,
): Promise<void> {
  const identity = createBackfillChunkIdentity(input.identity);

  // require matching source identity
  if (identity.sourceId !== session.sourceId) {
    throw new Error("backfill identity source does not match the locked source");
  }

  validateCompletionCounts(input.attempts, input.records.length);

  await withTransaction(session.client, async () => {
    await assertBackfillRunMatches(session, input.runId, identity);
    await upsertWeatherRecords(session, input.runId, input.records);
    await upsertBackfillOutcome(session, input.runId, identity, "succeeded", null);
    await finalizeSuccessfulRun(
      session,
      input.runId,
      input.attempts,
      input.records.length,
      input.responseMetadata ?? null,
      input.upstreamResponseChecksum ?? null,
      "backfill",
    );
  });
}

// atomically store fixed-anchor backfill success
export async function completeForecastAnchorBackfillIngestion(
  session: SourceSession,
  input: CompleteForecastAnchorBackfillIngestionInput,
): Promise<void> {
  const identity = createBackfillChunkIdentity(input.identity);

  // require matching source identity
  if (identity.sourceId !== session.sourceId) {
    throw new Error("backfill identity source does not match the locked source");
  }

  // bind every anchor to the exact backfill provenance
  for (const record of input.records) {
    // reject cross-run anchor provenance
    if (
      record.sourceConfigFingerprint !== identity.sourceConfigFingerprint ||
      record.adapterVersion !== identity.adapterVersion
    ) {
      throw new Error("forecast anchor provenance does not match the backfill identity");
    }
  }

  validateCompletionCounts(input.attempts, input.records.length);

  await withTransaction(session.client, async () => {
    await assertBackfillRunMatches(session, input.runId, identity);
    await upsertForecastAnchorRecords(session, input.runId, input.records);
    await upsertBackfillOutcome(session, input.runId, identity, "succeeded", null);
    await finalizeSuccessfulRun(
      session,
      input.runId,
      input.attempts,
      input.records.length,
      input.responseMetadata ?? null,
      input.upstreamResponseChecksum ?? null,
      "backfill",
    );
  });
}

// guard-finalize a failed run
export async function failIngestionRun(
  session: SourceSession,
  input: FailIngestionRunInput,
): Promise<void> {
  const error = validateIngestionError(input.error);
  validateCompletionCounts(input.attempts, 0);

  await withTransaction(session.client, async () => {
    // record an eligible failed chunk
    if (input.backfillIdentity !== undefined) {
      const identity = createBackfillChunkIdentity(input.backfillIdentity);

      // require matching source identity
      if (identity.sourceId !== session.sourceId) {
        throw new Error("backfill identity source does not match the locked source");
      }

      await assertBackfillRunMatches(session, input.runId, identity);
      await upsertBackfillOutcome(
        session,
        input.runId,
        identity,
        "failed",
        error.code,
      );
    } else {
      await assertRunningMode(session, input.runId, "scheduled");
    }

    const result = await session.client.query(
      `
        UPDATE ingestion_runs
        SET
          state = 'failed',
          completed_at = clock_timestamp(),
          attempts = $3,
          response_metadata = $4::jsonb,
          error_classification = $5,
          error_code = $6,
          error_message = $7
        WHERE id = $1
          AND source_id = $2
          AND state = 'running'
      `,
      [
        input.runId,
        session.sourceId,
        input.attempts,
        serializeNullableJson(input.responseMetadata ?? null),
        error.classification,
        error.code,
        error.message,
      ],
    );
    requireGuardedUpdate(result.rowCount, "failed ingestion finalization");
  });
}

// test exact successful resume identity
export async function hasSuccessfulBackfillChunk(
  pool: Pool,
  identity: BackfillChunkIdentity,
): Promise<boolean> {
  const validated = createBackfillChunkIdentity(identity);
  const result = await pool.query(
    `
      SELECT 1
      FROM backfill_chunk_outcomes
      WHERE source_id = $1
        AND interval_start = $2
        AND interval_end_exclusive = $3
        AND source_config_fingerprint = $4
        AND adapter_version = $5
        AND chunk_plan_version = $6
        AND outcome = 'succeeded'
    `,
    [
      validated.sourceId,
      validated.intervalStart,
      validated.intervalEndExclusive,
      validated.sourceConfigFingerprint,
      validated.adapterVersion,
      validated.chunkPlanVersion,
    ],
  );

  return result.rowCount === 1;
}

// read checkpoint state under the source lock
export async function getScheduledCheckpoint(
  session: SourceSession,
): Promise<ScheduledCheckpointState | null> {
  const result = await session.client.query<{
    last_committed_at: Date;
    last_valid_at: Date;
    provider_cursor: Readonly<Record<string, JsonValue>> | null;
    source_id: string;
    version: string;
    window_end_exclusive: Date;
    window_start: Date;
  }>(
    `
      SELECT
        source_id,
        last_valid_at,
        window_start,
        window_end_exclusive,
        provider_cursor,
        version,
        last_committed_at
      FROM ingestion_checkpoints
      WHERE source_id = $1
    `,
    [session.sourceId],
  );
  const row = result.rows[0];

  // represent an uninitialized checkpoint
  if (row === undefined) {
    return null;
  }

  return {
    lastCommittedAt: row.last_committed_at.toISOString(),
    lastValidAt: row.last_valid_at.toISOString(),
    providerCursor: row.provider_cursor,
    sourceId: row.source_id,
    version: Number(row.version),
    windowEndExclusive: row.window_end_exclusive.toISOString(),
    windowStart: row.window_start.toISOString(),
  };
}

// update liveness independently from ingestion success
export async function updateWorkerHeartbeat(
  pool: Pool,
  input: Readonly<{
    activity: string | null;
    instance: string;
    lastLoopAt: string;
    lastSuccessAt: string | null;
    version: string;
  }>,
): Promise<void> {
  const lastLoopAt = validateUtcInstant(input.lastLoopAt, "lastLoopAt");
  const lastSuccessAt =
    input.lastSuccessAt === null
      ? null
      : validateUtcInstant(input.lastSuccessAt, "lastSuccessAt");

  // require bounded heartbeat fields
  if (
    input.instance.length === 0 ||
    input.instance.length > 128 ||
    input.version.length === 0 ||
    input.version.length > 128 ||
    (input.activity !== null && input.activity.length > 256)
  ) {
    throw new RangeError("heartbeat fields must be non-empty and bounded");
  }

  await pool.query(
    `
      INSERT INTO worker_heartbeats (
        worker_instance,
        last_loop_at,
        last_success_at,
        current_activity,
        worker_version
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (worker_instance) DO UPDATE SET
        last_loop_at = EXCLUDED.last_loop_at,
        last_success_at = EXCLUDED.last_success_at,
        current_activity = EXCLUDED.current_activity,
        worker_version = EXCLUDED.worker_version,
        updated_at = clock_timestamp()
    `,
    [input.instance, lastLoopAt, lastSuccessAt, input.activity, input.version],
  );
}

// list active site and source metadata
export async function listActiveSites(pool: Pool): Promise<readonly ActiveSiteRow[]> {
  const result = await pool.query<ActiveSiteRow>(
    `
      SELECT
        si.slug AS "siteSlug",
        si.display_name AS "siteName",
        si.latitude,
        si.longitude,
        si.timezone,
        st.slug AS "stationSlug",
        st.display_name AS "stationName",
        st.station_kind AS "stationKind",
        st.latitude AS "stationLatitude",
        st.longitude AS "stationLongitude",
        s.id AS "sourceId",
        s.source_key AS "sourceKey",
        s.source_kind AS "sourceKind",
        p.provider_key AS "providerKey",
        p.display_name AS "providerName",
        p.attribution_label AS "attributionLabel",
        p.attribution_url AS "attributionUrl"
      FROM sites si
      JOIN stations st ON st.site_id = si.id AND st.active
      JOIN sources s ON s.station_id = st.id AND s.active
      JOIN providers p ON p.id = s.provider_id AND p.active
      WHERE si.active
        AND (
          s.source_kind <> 'forecast'
          OR s.capabilities @> '["forecast"]'::jsonb
        )
        AND ${CURRENT_SOURCE_PREDICATE}
      ORDER BY si.slug, st.slug, s.source_key
    `,
  );

  return result.rows;
}

// read the newest worker loop
export async function getLatestWorkerHeartbeat(
  pool: Pool,
): Promise<LatestWorkerHeartbeat | null> {
  const result = await pool.query<LatestWorkerHeartbeat>(
    `
      SELECT last_loop_at AS "lastLoopAt"
      FROM worker_heartbeats
      ORDER BY last_loop_at DESC, worker_instance ASC
      LIMIT 1
    `,
  );

  return result.rows[0] ?? null;
}

// read the latest row per source
export async function getCurrentWeather(
  pool: Pool,
  siteSlug: string,
  query: CurrentQuery = {},
): Promise<readonly WeatherRecordRow[]> {
  const result = await pool.query<WeatherRecordRow>(
    `
      SELECT
        ${weatherRecordSelection()}
      FROM sources s
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      JOIN LATERAL (
        SELECT candidate.*
        FROM weather_records candidate
        WHERE candidate.source_id = s.id
        ORDER BY candidate.valid_at DESC, candidate.id DESC
        LIMIT 1
      ) wr ON true
      WHERE si.slug = $1
        AND si.active
        AND st.active
        AND s.active
        AND p.active
        AND s.source_kind IN ('physical_sensor', 'model_current', 'reanalysis')
        AND ${CURRENT_SOURCE_PREDICATE}
        AND ($2::text IS NULL OR st.slug = $2)
        AND ($3::bigint IS NULL OR s.id = $3)
      ORDER BY wr.source_id
    `,
    [siteSlug, query.stationSlug ?? null, query.sourceId ?? null],
  );

  return result.rows;
}

// read the latest bounded forecast product
export async function getWeatherForecast(
  pool: Pool,
  query: ForecastQuery,
): Promise<readonly WeatherRecordRow[]> {
  const asOf = validateUtcInstant(query.asOf, "asOf");

  // require a bounded public horizon
  if (!Number.isSafeInteger(query.hours) || query.hours < 1 || query.hours > MAX_FORECAST_HOURS) {
    throw new RangeError(`forecast hours must be between 1 and ${String(MAX_FORECAST_HOURS)}`);
  }

  const endExclusive = new Date(
    Date.parse(asOf) + query.hours * 3_600_000,
  ).toISOString();
  const rawResult = await pool.query<WeatherRecordRow>(
    `
      SELECT
        ${weatherRecordSelection()}
      FROM sources s
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      JOIN LATERAL (
        SELECT candidate.*
        FROM weather_records candidate
        WHERE candidate.source_id = s.id
          AND candidate.product_run_at = (
            SELECT MAX(product.product_run_at)
            FROM weather_records product
            WHERE product.source_id = s.id
          )
          AND candidate.valid_at >= $2
          AND candidate.valid_at < $3
        ORDER BY candidate.valid_at ASC, candidate.id ASC
        LIMIT ${String(MAX_FORECAST_HOURS)}
      ) wr ON true
      WHERE si.slug = $1
        AND si.active
        AND st.active
        AND s.active
        AND p.active
        AND s.source_kind = 'forecast'
        AND s.capabilities @> '["forecast"]'::jsonb
        AND ${CURRENT_SOURCE_PREDICATE}
      ORDER BY wr.valid_at ASC, wr.id ASC
    `,
    [query.siteSlug, asOf, endExclusive],
  );

  // skip optional provenance without raw records
  if (rawResult.rows.length === 0) {
    return rawResult.rows;
  }

  // fail raw when optional provenance is unavailable
  try {
    const provenanceResult = await pool.query<ForecastRuntimeProvenanceRow>(
      `
        SELECT
          weather_record_id AS "weatherRecordId",
          source_id AS "sourceId",
          source_key AS "sourceKey",
          source_config_fingerprint AS "sourceConfigFingerprint",
          adapter_version AS "adapterVersion",
          contract_epoch AS "contractEpoch"
        FROM forecast_runtime_provenance_v1
        WHERE weather_record_id = ANY($1::bigint[])
        ORDER BY weather_record_id ASC
        LIMIT ${String(MAX_FORECAST_HOURS)}
      `,
      [
        rawResult.rows.map(
          // bind only returned record identifiers
          (record) => record.id,
        ),
      ],
    );
    const rawByRecordId = new Map(
      rawResult.rows.map(
        // retain exact source linkage
        (record) => [record.id, record] as const,
      ),
    );
    const provenanceByRecordId = new Map<string, ForecastRuntimeProvenanceRow>();

    // validate every optional linkage before decoration
    for (const provenance of provenanceResult.rows) {
      const rawRecord = rawByRecordId.get(provenance.weatherRecordId);

      // reject partial or duplicate linkage
      if (
        rawRecord === undefined
        || rawRecord.sourceId !== provenance.sourceId
        || rawRecord.sourceKey !== provenance.sourceKey
        || provenanceByRecordId.has(provenance.weatherRecordId)
      ) {
        throw new Error("forecast runtime provenance linkage is invalid");
      }

      provenanceByRecordId.set(provenance.weatherRecordId, provenance);
    }

    return rawResult.rows.map(
      // decorate matching records without changing ordering
      (record) => {
        const provenance = provenanceByRecordId.get(record.id);

        // retain the authoritative raw record when unmatched
        if (provenance === undefined) {
          return record;
        }

        return {
          ...record,
          adapterVersion: provenance.adapterVersion,
          contractEpoch: provenance.contractEpoch,
          sourceConfigFingerprint: provenance.sourceConfigFingerprint,
        };
      },
    );
  } catch {
    return rawResult.rows;
  }
}

// read provenance-separated forecast training cohorts
export async function listForecastTrainingCohorts(
  pool: Pool,
  query: ForecastTrainingQuery,
): Promise<ForecastTrainingCohorts> {
  const { from, to } = validateForecastTrainingWindow(query.from, query.to);
  const anchors = await pool.query<ForecastAnchorStorageRow>(
    `
      SELECT
        far.source_id AS "sourceId",
        far.source_config_fingerprint AS "sourceConfigFingerprint",
        far.valid_at AS "validAt",
        far.lead_hours AS "leadHours",
        far.dataset,
        far.upstream_model AS "upstreamModel",
        far.contract_epoch AS "contractEpoch",
        far.adapter_version AS "adapterVersion",
        far.last_received_at AS "receivedAt",
        far.upstream_timezone AS "upstreamTimezone",
        far.quality_metadata AS "qualityMetadata",
        far.provider_metadata AS "providerMetadata",
        far.temperature_c AS "temperatureC",
        far.apparent_temperature_c AS "apparentTemperatureC",
        far.precipitation_mm AS "precipitationMm",
        far.wind_speed_mps AS "windSpeedMps",
        far.wind_gust_mps AS "windGustMps",
        far.pressure_hpa AS "pressureHpa",
        far.relative_humidity_percent AS "relativeHumidityPercent",
        far.cloud_cover_percent AS "cloudCoverPercent",
        far.wind_direction_degrees AS "windDirectionDegrees"
      FROM forecast_anchor_records far
      JOIN sources s ON s.id = far.source_id
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      WHERE si.slug = $1
        AND far.valid_at >= $2
        AND far.valid_at < $3
        AND far.source_kind = 'forecast'
        AND far.dataset = 'previous_runs'
        AND far.upstream_model = 'best_match'
        AND s.capabilities @> '["historical"]'::jsonb
      ORDER BY far.valid_at ASC, far.lead_hours ASC, far.id ASC
    `,
    [query.siteSlug, from, to],
  );
  const retrievals = await pool.query<LegacyV4ForecastStorageRow>(
    `
      SELECT
        wr.id AS "stableRecordId",
        wr.source_id AS "sourceId",
        s.source_config_fingerprint AS "sourceConfigFingerprint",
        wr.valid_at AS "validAt",
        wr.product_run_at AS "referenceAt",
        wr.upstream_model AS "upstreamModel",
        wr.provider_metadata ->> 'dataset' AS dataset,
        last_run.adapter_version AS "adapterVersion",
        wr.temperature_c AS "temperatureC",
        wr.apparent_temperature_c AS "apparentTemperatureC",
        wr.precipitation_mm AS "precipitationMm",
        wr.wind_speed_mps AS "windSpeedMps",
        wr.wind_gust_mps AS "windGustMps",
        wr.pressure_hpa AS "pressureHpa",
        wr.relative_humidity_percent AS "relativeHumidityPercent",
        wr.cloud_cover_percent AS "cloudCoverPercent",
        wr.wind_direction_degrees AS "windDirectionDegrees",
        wr.black_globe_temperature_c AS "blackGlobeTemperatureC",
        wr.pm25_micrograms_per_cubic_meter AS "pm25MicrogramsPerCubicMeter",
        wr.precipitation_rate_mm_per_hour AS "precipitationRateMmPerHour",
        wr.soil_electrical_conductivity_us_cm AS "soilElectricalConductivityMicrosiemensPerCm",
        wr.soil_moisture_percent AS "soilMoisturePercent",
        wr.solar_radiation_wm2 AS "solarRadiationWm2",
        wr.uv_index AS "uvIndex",
        wr.wet_bulb_globe_temperature_c AS "wetBulbGlobeTemperatureC",
        wr.water_level_m AS "waterLevelM"
      FROM weather_records wr
      JOIN sources s ON s.id = wr.source_id
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN ingestion_runs last_run ON last_run.id = wr.last_ingestion_run_id
      WHERE si.slug = $1
        AND wr.valid_at >= $2
        AND wr.valid_at < $3
        AND s.source_key = 'open-meteo-forecast-v4'
        AND s.source_kind = 'forecast'
        AND s.capabilities @> '["forecast"]'::jsonb
      ORDER BY wr.valid_at ASC, wr.product_run_at ASC, wr.id ASC
    `,
    [query.siteSlug, from, to],
  );

  return {
    fixedLeadAnchors: anchors.rows.map(projectFixedLeadAnchorStorageRow),
    legacyV4RetrievalSnapshots: projectLegacyV4RetrievalRows(retrievals.rows),
  };
}

// read deterministic physical-station hours without spatial fitting
export async function listForecastObservationHourlyStations(
  pool: Pool,
  query: ForecastTrainingQuery,
): Promise<readonly ForecastObservationHourlyStationRow[]> {
  const { from, to } = validateForecastTrainingWindow(query.from, query.to);

  // require exact hourly projection boundaries
  if (Date.parse(from) % HOUR_MILLISECONDS !== 0 || Date.parse(to) % HOUR_MILLISECONDS !== 0) {
    throw new RangeError("forecast observation projection bounds must align to UTC hours");
  }

  const sourceKeys = FORECAST_OBSERVATION_SOURCE_LINEAGES.map(
    (lineage) => lineage.sourceKey,
  );
  const result = await pool.query<ForecastObservationStorageRow>(
    `
      SELECT
        wr.id,
        wr.valid_at AS "validAt",
        wr.quality_metadata AS "qualityMetadata",
        wr.temperature_c AS "temperatureC",
        wr.relative_humidity_percent AS "relativeHumidityPercent",
        wr.wind_speed_mps AS "windSpeedMps",
        wr.wind_gust_mps AS "windGustMps",
        wr.wind_direction_degrees AS "windDirectionDegrees",
        s.source_key AS "sourceKey",
        s.source_config_fingerprint AS "sourceConfigFingerprint",
        s.material_provider_config ->> 'contractVersion' AS "adapterContract",
        st.slug AS "stationSlug"
      FROM weather_records wr
      JOIN sources s ON s.id = wr.source_id
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      WHERE si.slug = $1
        AND wr.valid_at >= $2::timestamptz - interval '1 hour'
        AND wr.valid_at < $3::timestamptz + interval '5 minutes'
        AND s.source_kind = 'physical_sensor'
        AND s.source_key = ANY($4::text[])
      ORDER BY wr.valid_at ASC, wr.id ASC
    `,
    [query.siteSlug, from, to, sourceKeys],
  );
  const records = validateForecastObservationRows(result.rows);

  return projectForecastObservationHours(records, from, to);
}

// sum today's nearest physical rain gauge
export async function getDailyPrecipitation(
  pool: Pool,
  query: DailyPrecipitationQuery,
): Promise<DailyPrecipitationRow | null> {
  const from = validateUtcInstant(query.from, "from");
  const to = validateUtcInstant(query.to, "to");

  // require an ordered local-day window
  if (from >= to) {
    throw new RangeError("daily precipitation from must be earlier than to");
  }

  const result = await pool.query<DailyPrecipitationRow>(
    `
      WITH nearest_source AS (
        SELECT
          s.id AS source_id,
          st.slug AS station_slug
        FROM sources s
        JOIN stations st ON st.id = s.station_id
        JOIN sites si ON si.id = st.site_id
        JOIN providers p ON p.id = s.provider_id
        WHERE si.slug = $1
          AND si.active
          AND st.active
          AND s.active
          AND p.active
          AND s.source_kind = 'physical_sensor'
          AND ${CURRENT_SOURCE_PREDICATE}
          AND EXISTS (
            SELECT 1
            FROM weather_records candidate
            WHERE candidate.source_id = s.id
              AND candidate.valid_at >= $2
              AND candidate.valid_at < $3
              AND candidate.precipitation_mm IS NOT NULL
          )
        ORDER BY
          POWER(st.latitude - si.latitude, 2) +
            POWER((st.longitude - si.longitude) * COS(RADIANS(si.latitude)), 2),
          st.slug ASC,
          s.id ASC
        LIMIT 1
      )
      SELECT
        SUM(wr.precipitation_mm)::double precision AS "accumulationMm",
        nearest_source.source_id AS "sourceId",
        nearest_source.station_slug AS "stationSlug",
        MAX(wr.valid_at) AS "validThrough"
      FROM nearest_source
      JOIN weather_records wr ON wr.source_id = nearest_source.source_id
      WHERE wr.valid_at >= $2
        AND wr.valid_at < $3
        AND wr.precipitation_mm IS NOT NULL
      GROUP BY nearest_source.source_id, nearest_source.station_slug
    `,
    [query.siteSlug, from, to],
  );

  return result.rows[0] ?? null;
}

// aggregate normalized recent conditions into chart buckets
export async function listWeatherTrends(
  pool: Pool,
  query: TrendQuery,
): Promise<readonly TrendPointRow[]> {
  const from = validateUtcInstant(query.from, "from");
  const to = validateUtcInstant(query.to, "to");

  // require an ordered trend window
  if (from >= to) {
    throw new RangeError("trend from must be earlier than to");
  }

  const result = await pool.query<TrendPointRow>(
    `
      WITH daily_sources AS (
        SELECT
          date_trunc('day', wr.valid_at AT TIME ZONE si.timezone) AT TIME ZONE si.timezone AS valid_at,
          s.source_kind,
          AVG(wr.temperature_c) AS temperature_c,
          MAX(wr.temperature_c) AS temperature_maximum_c,
          MIN(wr.temperature_c) AS temperature_minimum_c,
          AVG(wr.apparent_temperature_c) AS apparent_temperature_c,
          SUM(wr.precipitation_mm) AS precipitation_mm,
          AVG(wr.wind_speed_mps) AS wind_speed_mps,
          MAX(wr.wind_gust_mps) AS wind_gust_mps,
          DEGREES(ATAN2(
            AVG(SIN(RADIANS(wr.wind_direction_degrees))),
            AVG(COS(RADIANS(wr.wind_direction_degrees)))
          )) AS wind_direction_degrees,
          AVG(wr.pressure_hpa) AS pressure_hpa,
          AVG(wr.relative_humidity_percent) AS relative_humidity_percent
        FROM weather_records wr
        JOIN sources s ON s.id = wr.source_id
        JOIN stations st ON st.id = s.station_id
        JOIN sites si ON si.id = st.site_id
        JOIN providers p ON p.id = s.provider_id
        WHERE si.slug = $1
          AND wr.valid_at >= $2
          AND wr.valid_at < $3
          AND si.active
          AND st.active
          AND s.active
          AND p.active
          AND s.source_kind IN ('model_current', 'reanalysis')
          AND ${CURRENT_SOURCE_PREDICATE}
        GROUP BY 1, s.source_kind
      ),
      preferred_days AS (
        SELECT
          daily_sources.*,
          ROW_NUMBER() OVER (
            PARTITION BY valid_at
            ORDER BY CASE source_kind WHEN 'reanalysis' THEN 0 ELSE 1 END
          ) AS source_priority
        FROM daily_sources
      )
      SELECT
        valid_at AS "validAt",
        temperature_c AS "temperatureC",
        temperature_maximum_c AS "temperatureMaximumC",
        temperature_minimum_c AS "temperatureMinimumC",
        apparent_temperature_c AS "apparentTemperatureC",
        precipitation_mm AS "precipitationMm",
        wind_speed_mps AS "windSpeedMps",
        wind_gust_mps AS "windGustMps",
        wind_direction_degrees AS "windDirectionDegrees",
        pressure_hpa AS "pressureHpa",
        relative_humidity_percent AS "relativeHumidityPercent"
      FROM preferred_days
      WHERE source_priority = 1
      ORDER BY valid_at ASC
    `,
    [query.siteSlug, from, to],
  );

  return result.rows;
}

// read bounded observed and predicted tide levels
export async function listTideRecords(
  pool: Pool,
  query: TideQuery,
): Promise<readonly TideRecordRow[]> {
  const from = validateUtcInstant(query.from, "from");
  const to = validateUtcInstant(query.to, "to");
  const limit = query.limit ?? 10_000;

  // require one bounded ordered public range
  if (
    from >= to ||
    Date.parse(to) - Date.parse(from) > 31 * 86_400_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10_000
  ) {
    throw new RangeError("tide query range or limit is invalid");
  }

  const result = await pool.query<TideRecordRow>(
    `
      SELECT
        wr.source_id AS "sourceId",
        wr.source_kind AS "sourceKind",
        wr.valid_at AS "validAt",
        wr.water_level_m AS "waterLevelM",
        wr.provider_metadata ->> 'prediction_type' AS "predictionType",
        st.slug AS "stationSlug",
        st.display_name AS "stationName",
        p.provider_key AS "providerKey",
        p.attribution_label AS "attributionLabel",
        p.attribution_url AS "attributionUrl"
      FROM weather_records wr
      JOIN sources s ON s.id = wr.source_id
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      WHERE si.slug = $1
        AND wr.valid_at >= $2
        AND wr.valid_at < $3
        AND wr.water_level_m IS NOT NULL
        AND s.source_kind IN ('tide_observation', 'tide_prediction')
        AND si.active
        AND st.active
        AND s.active
        AND p.active
        AND ${CURRENT_SOURCE_PREDICATE}
      ORDER BY wr.valid_at ASC, wr.id ASC
      LIMIT $4
    `,
    [query.siteSlug, from, to, limit],
  );

  return result.rows;
}

// read bounded cursor history
export async function listWeatherHistory(
  pool: Pool,
  query: HistoryQuery,
): Promise<readonly WeatherRecordRow[]> {
  const limit = query.limit ?? 100;
  const from =
    query.from === undefined ? undefined : validateUtcInstant(query.from, "from");
  const to = query.to === undefined ? undefined : validateUtcInstant(query.to, "to");

  // enforce the API bound at the repository edge
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 251) {
    throw new RangeError("history limit must be between 1 and 251");
  }

  // reject reversed query ranges
  if (from !== undefined && to !== undefined && from >= to) {
    throw new RangeError("history from must be earlier than to");
  }

  const sourceConditions = [
    "si.slug = $1",
    "si.active",
    "st.active",
    "s.active",
    "p.active",
    "s.source_kind IN ('physical_sensor', 'model_current', 'reanalysis')",
    CURRENT_SOURCE_PREDICATE,
  ];
  const recordConditions = ["candidate.source_id = s.id"];
  const values: unknown[] = [query.siteSlug];

  // add station filter
  if (query.stationSlug !== undefined) {
    values.push(query.stationSlug);
    sourceConditions.push(`st.slug = $${values.length}`);
  }

  // add source filter
  if (query.sourceId !== undefined) {
    values.push(query.sourceId);
    sourceConditions.push(`s.id = $${values.length}`);
  }

  // add provenance filter
  if (query.sourceKind !== undefined) {
    values.push(query.sourceKind);
    sourceConditions.push(`s.source_kind = $${values.length}`);
  }

  // add lower time bound
  if (from !== undefined) {
    values.push(from);
    recordConditions.push(`candidate.valid_at >= $${values.length}`);
  }

  // add upper time bound
  if (to !== undefined) {
    values.push(to);
    recordConditions.push(`candidate.valid_at < $${values.length}`);
  }

  // add stable cursor
  if (query.cursor !== undefined) {
    values.push(validateUtcInstant(query.cursor.validAt, "cursor.validAt"));
    const validAtParameter = values.length;
    values.push(query.cursor.id);
    const idParameter = values.length;
    recordConditions.push(
      `(candidate.valid_at, candidate.id) < ($${validAtParameter}::timestamptz, $${idParameter}::bigint)`,
    );
  }

  values.push(limit);
  const limitParameter = values.length;
  const result = await pool.query<WeatherRecordRow>(
    `
      SELECT
        ${weatherRecordSelection()}
      FROM sources s
      JOIN stations st ON st.id = s.station_id
      JOIN sites si ON si.id = st.site_id
      JOIN providers p ON p.id = s.provider_id
      JOIN LATERAL (
        SELECT candidate.*
        FROM weather_records candidate
        WHERE ${recordConditions.join("\n          AND ")}
        ORDER BY candidate.valid_at DESC, candidate.id DESC
        LIMIT $${limitParameter}
      ) wr ON true
      WHERE ${sourceConditions.join("\n        AND ")}
      ORDER BY wr.valid_at DESC, wr.id DESC
      LIMIT $${limitParameter}
    `,
    values,
  );

  return result.rows;
}

// atomically upsert normalized fixed anchors
async function upsertForecastAnchorRecords(
  session: SourceSession,
  runId: string,
  records: readonly NormalizedForecastAnchorRecord[],
): Promise<void> {
  // persist bounded batches
  for (
    let offset = 0;
    offset < records.length;
    offset += FORECAST_ANCHOR_RECORD_BATCH_SIZE
  ) {
    const batch = records.slice(
      offset,
      offset + FORECAST_ANCHOR_RECORD_BATCH_SIZE,
    );
    await upsertForecastAnchorRecordBatch(session, runId, batch);
  }
}

// upsert one bounded fixed-anchor batch
async function upsertForecastAnchorRecordBatch(
  session: SourceSession,
  runId: string,
  records: readonly NormalizedForecastAnchorRecord[],
): Promise<void> {
  const values: unknown[] = [];

  // serialize every truthful fixed anchor
  const placeholders = records.map((record) => {
    // reject cross-source writes
    if (record.sourceId !== session.sourceId) {
      throw new Error("forecast anchor source does not match the locked source");
    }

    const contentHash = createHash("sha256")
      .update(forecastAnchorRecordContent(record))
      .digest("hex");
    const firstParameter = values.length + 1;
    values.push(
      session.sourceId,
      record.sourceKind,
      record.sourceConfigFingerprint,
      record.validAt,
      record.leadHours,
      record.dataset,
      record.upstreamModel,
      record.contractEpoch,
      record.adapterVersion,
      runId,
      record.receivedAt,
      record.metadata.upstreamTimezone,
      serializeNullableJson(record.metadata.quality),
      serializeNullableJson(record.metadata.provider),
      record.metrics.temperatureC,
      record.metrics.apparentTemperatureC,
      record.metrics.precipitationMm,
      record.metrics.windSpeedMps,
      record.metrics.windGustMps,
      record.metrics.pressureHpa,
      record.metrics.relativeHumidityPercent,
      record.metrics.cloudCoverPercent,
      record.metrics.windDirectionDegrees,
      contentHash,
    );

    return forecastAnchorRecordPlaceholder(firstParameter);
  });

  // skip empty caller batches
  if (placeholders.length === 0) {
    return;
  }

  const result = await session.client.query(
    `
      INSERT INTO forecast_anchor_records (
        source_id,
        source_kind,
        source_config_fingerprint,
        valid_at,
        lead_hours,
        dataset,
        upstream_model,
        contract_epoch,
        adapter_version,
        first_ingestion_run_id,
        last_ingestion_run_id,
        first_received_at,
        last_received_at,
        upstream_timezone,
        quality_metadata,
        provider_metadata,
        temperature_c,
        apparent_temperature_c,
        precipitation_mm,
        wind_speed_mps,
        wind_gust_mps,
        pressure_hpa,
        relative_humidity_percent,
        cloud_cover_percent,
        wind_direction_degrees,
        content_hash
      )
      VALUES ${placeholders.join(",\n        ")}
      ON CONFLICT ON CONSTRAINT forecast_anchor_records_identity_key DO UPDATE SET
        last_ingestion_run_id = EXCLUDED.last_ingestion_run_id,
        last_received_at = EXCLUDED.last_received_at,
        quality_metadata = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.quality_metadata ELSE forecast_anchor_records.quality_metadata END,
        provider_metadata = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.provider_metadata ELSE forecast_anchor_records.provider_metadata END,
        temperature_c = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.temperature_c ELSE forecast_anchor_records.temperature_c END,
        apparent_temperature_c = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.apparent_temperature_c ELSE forecast_anchor_records.apparent_temperature_c END,
        precipitation_mm = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.precipitation_mm ELSE forecast_anchor_records.precipitation_mm END,
        wind_speed_mps = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_speed_mps ELSE forecast_anchor_records.wind_speed_mps END,
        wind_gust_mps = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_gust_mps ELSE forecast_anchor_records.wind_gust_mps END,
        pressure_hpa = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.pressure_hpa ELSE forecast_anchor_records.pressure_hpa END,
        relative_humidity_percent = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.relative_humidity_percent ELSE forecast_anchor_records.relative_humidity_percent END,
        cloud_cover_percent = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.cloud_cover_percent ELSE forecast_anchor_records.cloud_cover_percent END,
        wind_direction_degrees = CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_direction_degrees ELSE forecast_anchor_records.wind_direction_degrees END,
        revision_count = forecast_anchor_records.revision_count + CASE WHEN forecast_anchor_records.content_hash <> EXCLUDED.content_hash THEN 1 ELSE 0 END,
        content_hash = EXCLUDED.content_hash
      WHERE forecast_anchor_records.source_kind = EXCLUDED.source_kind
        AND forecast_anchor_records.source_config_fingerprint = EXCLUDED.source_config_fingerprint
        AND forecast_anchor_records.dataset = EXCLUDED.dataset
        AND forecast_anchor_records.upstream_model = EXCLUDED.upstream_model
        AND forecast_anchor_records.contract_epoch = EXCLUDED.contract_epoch
        AND forecast_anchor_records.adapter_version = EXCLUDED.adapter_version
        AND forecast_anchor_records.upstream_timezone = EXCLUDED.upstream_timezone
    `,
    values,
  );

  // fail the transaction on immutable-provenance conflicts
  if (result.rowCount !== records.length) {
    throw new Error("forecast anchor upsert did not persist every input row");
  }
}

// create one repeated fixed-anchor tuple
function forecastAnchorRecordPlaceholder(firstParameter: number): string {
  const parameters = Array.from(
    { length: 24 },
    (_unused, index) => `$${String(firstParameter + index)}`,
  );
  parameters[12] = `${parameters[12]!}::jsonb`;
  parameters[13] = `${parameters[13]!}::jsonb`;
  parameters.splice(10, 0, parameters[9]!);
  parameters.splice(12, 0, parameters[11]!);
  return `(${parameters.join(", ")})`;
}

// atomically upsert normalized records
async function upsertWeatherRecords(
  session: SourceSession,
  runId: string,
  records: readonly NormalizedWeatherRecord[],
): Promise<void> {
  // persist bounded batches
  for (let offset = 0; offset < records.length; offset += WEATHER_RECORD_BATCH_SIZE) {
    const batch = records.slice(offset, offset + WEATHER_RECORD_BATCH_SIZE);
    await upsertWeatherRecordBatch(session, runId, batch);
  }
}

// upsert one bounded provider-neutral batch
async function upsertWeatherRecordBatch(
  session: SourceSession,
  runId: string,
  records: readonly NormalizedWeatherRecord[],
): Promise<void> {
  const values: unknown[] = [];

  // serialize each normalized row
  const placeholders = records.map((record) => {
    // reject cross-source writes
    if (record.sourceId !== session.sourceId) {
      throw new Error("weather record source does not match the locked source");
    }

    const contentHash = createHash("sha256")
      .update(weatherRecordContent(record))
      .digest("hex");
    const firstParameter = values.length + 1;
    values.push(
      session.sourceId,
      record.sourceKind,
      record.validAt,
      record.productRunAt,
      runId,
      record.receivedAt,
      record.metadata.upstreamTimezone,
      record.metadata.model,
      record.metadata.device?.vendor ?? null,
      record.metadata.device?.model ?? null,
      record.metadata.device?.serial ?? null,
      serializeNullableJson(record.metadata.quality),
      serializeNullableJson(record.metadata.provider),
      record.metrics.temperatureC,
      record.metrics.apparentTemperatureC,
      record.metrics.precipitationMm,
      record.metrics.windSpeedMps,
      record.metrics.windGustMps,
      record.metrics.pressureHpa,
      record.metrics.relativeHumidityPercent,
      record.metrics.cloudCoverPercent,
      record.metrics.windDirectionDegrees,
      record.metrics.blackGlobeTemperatureC,
      record.metrics.pm25MicrogramsPerCubicMeter,
      record.metrics.precipitationRateMmPerHour,
      record.metrics.soilElectricalConductivityMicrosiemensPerCm,
      record.metrics.soilMoisturePercent,
      record.metrics.solarRadiationWm2,
      record.metrics.uvIndex,
      record.metrics.wetBulbGlobeTemperatureC,
      record.metrics.waterLevelM,
      contentHash,
    );

    return weatherRecordPlaceholder(firstParameter);
  });

  // skip empty caller batches
  if (placeholders.length === 0) {
    return;
  }

  await session.client.query(
    `
      INSERT INTO weather_records (
          source_id,
          source_kind,
          valid_at,
          product_run_at,
          first_ingestion_run_id,
          last_ingestion_run_id,
          first_received_at,
          last_received_at,
          upstream_timezone,
          upstream_model,
          device_vendor,
          device_model,
          device_serial,
          quality_metadata,
          provider_metadata,
          temperature_c,
          apparent_temperature_c,
          precipitation_mm,
          wind_speed_mps,
          wind_gust_mps,
          pressure_hpa,
          relative_humidity_percent,
          cloud_cover_percent,
          wind_direction_degrees,
          black_globe_temperature_c,
          pm25_micrograms_per_cubic_meter,
          precipitation_rate_mm_per_hour,
          soil_electrical_conductivity_us_cm,
          soil_moisture_percent,
          solar_radiation_wm2,
          uv_index,
          wet_bulb_globe_temperature_c,
          water_level_m,
          content_hash
      )
      VALUES ${placeholders.join(",\n        ")}
      ON CONFLICT ON CONSTRAINT weather_records_identity_key DO UPDATE SET
        last_ingestion_run_id = EXCLUDED.last_ingestion_run_id,
        last_received_at = EXCLUDED.last_received_at,
        upstream_timezone = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.upstream_timezone ELSE weather_records.upstream_timezone END,
        upstream_model = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.upstream_model ELSE weather_records.upstream_model END,
        device_vendor = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.device_vendor ELSE weather_records.device_vendor END,
        device_model = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.device_model ELSE weather_records.device_model END,
        device_serial = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.device_serial ELSE weather_records.device_serial END,
        quality_metadata = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.quality_metadata ELSE weather_records.quality_metadata END,
        provider_metadata = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.provider_metadata ELSE weather_records.provider_metadata END,
        temperature_c = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.temperature_c ELSE weather_records.temperature_c END,
        apparent_temperature_c = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.apparent_temperature_c ELSE weather_records.apparent_temperature_c END,
        precipitation_mm = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.precipitation_mm ELSE weather_records.precipitation_mm END,
        wind_speed_mps = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_speed_mps ELSE weather_records.wind_speed_mps END,
        wind_gust_mps = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_gust_mps ELSE weather_records.wind_gust_mps END,
        pressure_hpa = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.pressure_hpa ELSE weather_records.pressure_hpa END,
        relative_humidity_percent = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.relative_humidity_percent ELSE weather_records.relative_humidity_percent END,
        cloud_cover_percent = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.cloud_cover_percent ELSE weather_records.cloud_cover_percent END,
        wind_direction_degrees = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wind_direction_degrees ELSE weather_records.wind_direction_degrees END,
        black_globe_temperature_c = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.black_globe_temperature_c ELSE weather_records.black_globe_temperature_c END,
        pm25_micrograms_per_cubic_meter = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.pm25_micrograms_per_cubic_meter ELSE weather_records.pm25_micrograms_per_cubic_meter END,
        precipitation_rate_mm_per_hour = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.precipitation_rate_mm_per_hour ELSE weather_records.precipitation_rate_mm_per_hour END,
        soil_electrical_conductivity_us_cm = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.soil_electrical_conductivity_us_cm ELSE weather_records.soil_electrical_conductivity_us_cm END,
        soil_moisture_percent = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.soil_moisture_percent ELSE weather_records.soil_moisture_percent END,
        solar_radiation_wm2 = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.solar_radiation_wm2 ELSE weather_records.solar_radiation_wm2 END,
        uv_index = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.uv_index ELSE weather_records.uv_index END,
        wet_bulb_globe_temperature_c = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.wet_bulb_globe_temperature_c ELSE weather_records.wet_bulb_globe_temperature_c END,
        water_level_m = CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.water_level_m ELSE weather_records.water_level_m END,
        revision_count = weather_records.revision_count + CASE WHEN weather_records.content_hash <> EXCLUDED.content_hash THEN 1 ELSE 0 END,
        content_hash = EXCLUDED.content_hash
    `,
    values,
  );
}

// create one repeated insert tuple
function weatherRecordPlaceholder(firstParameter: number): string {
  const parameters = Array.from(
    { length: 32 },
    (_unused, index) => `$${String(firstParameter + index)}`,
  );
  parameters[11] = `${parameters[11]!}::jsonb`;
  parameters[12] = `${parameters[12]!}::jsonb`;
  parameters.splice(5, 0, parameters[4]!);
  parameters.splice(7, 0, parameters[6]!);
  return `(${parameters.join(", ")})`;
}

// compare-and-set a scheduled checkpoint
async function advanceScheduledCheckpoint(
  session: SourceSession,
  input: CompleteScheduledIngestionInput,
): Promise<void> {
  const lastValidAt = validateUtcInstant(input.lastValidAt, "lastValidAt");
  const windowStart = validateUtcInstant(input.windowStart, "windowStart");
  const windowEndExclusive = validateUtcInstant(
    input.windowEndExclusive,
    "windowEndExclusive",
  );

  // create the initial checkpoint
  if (input.expectedCheckpointVersion === null) {
    const result = await session.client.query(
      `
        INSERT INTO ingestion_checkpoints (
          source_id,
          last_valid_at,
          window_start,
          window_end_exclusive,
          provider_cursor
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (source_id) DO NOTHING
      `,
      [
        session.sourceId,
        lastValidAt,
        windowStart,
        windowEndExclusive,
        serializeNullableJson(input.providerCursor),
      ],
    );
    requireGuardedUpdate(result.rowCount, "initial checkpoint insert");
    return;
  }

  const result = await session.client.query(
    `
      UPDATE ingestion_checkpoints
      SET
        last_valid_at = $3,
        window_start = $4,
        window_end_exclusive = $5,
        provider_cursor = $6::jsonb,
        version = version + 1,
        last_committed_at = clock_timestamp()
      WHERE source_id = $1
        AND version = $2
    `,
    [
      session.sourceId,
      input.expectedCheckpointVersion,
      lastValidAt,
      windowStart,
      windowEndExclusive,
      serializeNullableJson(input.providerCursor),
    ],
  );
  requireGuardedUpdate(result.rowCount, "checkpoint compare-and-set");
}

// insert or revise an exact chunk outcome
async function upsertBackfillOutcome(
  session: SourceSession,
  runId: string,
  identity: BackfillChunkIdentity,
  outcome: "failed" | "succeeded",
  errorCode: string | null,
): Promise<void> {
  await session.client.query(
    `
      INSERT INTO backfill_chunk_outcomes (
        source_id,
        interval_start,
        interval_end_exclusive,
        source_config_fingerprint,
        adapter_version,
        chunk_plan_version,
        requested_from_date,
        requested_to_date,
        ingestion_run_id,
        outcome,
        error_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (
        source_id,
        interval_start,
        interval_end_exclusive,
        source_config_fingerprint,
        adapter_version,
        chunk_plan_version
      ) DO UPDATE SET
        ingestion_run_id = EXCLUDED.ingestion_run_id,
        requested_from_date = EXCLUDED.requested_from_date,
        requested_to_date = EXCLUDED.requested_to_date,
        outcome = EXCLUDED.outcome,
        error_code = EXCLUDED.error_code,
        completed_at = clock_timestamp()
      WHERE NOT (
        backfill_chunk_outcomes.outcome = 'succeeded'
        AND EXCLUDED.outcome = 'failed'
      )
    `,
    [
      session.sourceId,
      identity.intervalStart,
      identity.intervalEndExclusive,
      identity.sourceConfigFingerprint,
      identity.adapterVersion,
      identity.chunkPlanVersion,
      identity.requestedFromDate,
      identity.requestedToDate,
      runId,
      outcome,
      errorCode,
    ],
  );
}

// guard-finalize successful work
async function finalizeSuccessfulRun(
  session: SourceSession,
  runId: string,
  attempts: number,
  recordCount: number,
  responseMetadata: Readonly<Record<string, JsonValue>> | null,
  upstreamResponseChecksum: string | null,
  mode: IngestionMode,
): Promise<void> {
  // validate optional upstream checksum
  if (upstreamResponseChecksum !== null) {
    validateFingerprint(upstreamResponseChecksum);
  }

  const result = await session.client.query(
    `
      UPDATE ingestion_runs
      SET
        state = 'succeeded',
        completed_at = clock_timestamp(),
        attempts = $3,
        record_count = $4,
        response_metadata = $5::jsonb,
        upstream_response_checksum = $6,
        error_classification = NULL,
        error_code = NULL,
        error_message = NULL
      WHERE id = $1
        AND source_id = $2
        AND state = 'running'
        AND mode = $7
    `,
    [
      runId,
      session.sourceId,
      attempts,
      recordCount,
      serializeNullableJson(responseMetadata),
      upstreamResponseChecksum,
      mode,
    ],
  );
  requireGuardedUpdate(result.rowCount, "successful ingestion finalization");
}

// bind scheduled completion to its committed run
async function assertScheduledRunMatches(
  session: SourceSession,
  input: CompleteScheduledIngestionInput,
): Promise<void> {
  const windowStart = validateUtcInstant(input.windowStart, "windowStart");
  const windowEndExclusive = validateUtcInstant(
    input.windowEndExclusive,
    "windowEndExclusive",
  );
  const result = await session.client.query(
    `
      SELECT 1
      FROM ingestion_runs
      WHERE id = $1
        AND source_id = $2
        AND state = 'running'
        AND mode = 'scheduled'
        AND requested_start = $3
        AND requested_end_exclusive = $4
    `,
    [input.runId, session.sourceId, windowStart, windowEndExclusive],
  );
  requireGuardedUpdate(result.rowCount, "scheduled run identity check");
}

// bind backfill outcome to its committed run
async function assertBackfillRunMatches(
  session: SourceSession,
  runId: string,
  identity: BackfillChunkIdentity,
): Promise<void> {
  const result = await session.client.query(
    `
      SELECT 1
      FROM ingestion_runs
      WHERE id = $1
        AND source_id = $2
        AND state = 'running'
        AND mode = 'backfill'
        AND requested_start = $3
        AND requested_end_exclusive = $4
        AND source_config_fingerprint = $5
        AND adapter_version = $6
        AND chunk_plan_version = $7
    `,
    [
      runId,
      session.sourceId,
      identity.intervalStart,
      identity.intervalEndExclusive,
      identity.sourceConfigFingerprint,
      identity.adapterVersion,
      identity.chunkPlanVersion,
    ],
  );
  requireGuardedUpdate(result.rowCount, "backfill run identity check");
}

// require the expected running mode
async function assertRunningMode(
  session: SourceSession,
  runId: string,
  mode: IngestionMode,
): Promise<void> {
  const result = await session.client.query(
    `
      SELECT 1
      FROM ingestion_runs
      WHERE id = $1
        AND source_id = $2
        AND state = 'running'
        AND mode = $3
    `,
    [runId, session.sourceId, mode],
  );
  requireGuardedUpdate(result.rowCount, "running ingestion mode check");
}

// validate completion counts
function validateCompletionCounts(attempts: number, recordCount: number): void {
  // require non-negative integer counts
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0
  ) {
    throw new RangeError("completion counts must be non-negative integers");
  }
}

// require exactly one guarded row
function requireGuardedUpdate(
  rowCount: number | null,
  operation: string,
): void {
  // reject stale or duplicated lifecycle transitions
  if (rowCount !== 1) {
    throw new Error(`${operation} did not affect exactly one row`);
  }
}

// require an expected query row
function requireRow<R>(row: R | undefined, operation: string): R {
  // reject missing results
  if (row === undefined) {
    throw new Error(`${operation} returned no row`);
  }

  return row;
}

// validate one bounded training/export interval
function validateForecastTrainingWindow(
  fromInput: string,
  toInput: string,
): Readonly<{ from: string; to: string }> {
  const from = validateUtcInstant(fromInput, "from");
  const to = validateUtcInstant(toInput, "to");

  // require an ordered bounded export window
  if (
    from >= to ||
    Date.parse(to) - Date.parse(from) >
      MAX_FORECAST_TRAINING_DAYS * 86_400_000 + 2 * HOUR_MILLISECONDS
  ) {
    throw new RangeError("forecast training range must be increasing and at most 450 days");
  }

  return { from, to };
}

// project one stored fixed anchor through the domain contract
function projectFixedLeadAnchorStorageRow(
  row: ForecastAnchorStorageRow,
): FixedLeadAnchorTrainingRow {
  return createFixedLeadAnchorTrainingRow({
    adapterVersion: row.adapterVersion,
    contractEpoch: row.contractEpoch,
    contractVersion: "forecast-anchor-record/v1",
    dataset: row.dataset,
    leadHours: row.leadHours as NormalizedForecastAnchorRecord["leadHours"],
    metadata: {
      device: null,
      model: row.upstreamModel,
      provider: row.providerMetadata,
      quality: row.qualityMetadata,
      upstreamTimezone: row.upstreamTimezone,
    },
    metrics: canonicalMetricsFromForecastStorage(row),
    receivedAt: storageInstant(row.receivedAt, "receivedAt"),
    sourceConfigFingerprint: row.sourceConfigFingerprint,
    sourceId: String(row.sourceId),
    sourceKind: "forecast",
    upstreamModel: row.upstreamModel,
    validAt: storageInstant(row.validAt, "validAt"),
  });
}

// project only eligible legacy v4 retrieval snapshots
function projectLegacyV4RetrievalRows(
  rows: readonly LegacyV4ForecastStorageRow[],
): readonly LegacyV4RetrievalSnapshotTrainingRow[] {
  const projected: LegacyV4RetrievalSnapshotTrainingRow[] = [];

  // retain storage order across eligible rows
  for (const row of rows) {
    const adapterVersion = requireStorageText(row.adapterVersion, "adapterVersion");
    const dataset = requireStorageText(row.dataset, "dataset");
    const upstreamModel = requireStorageText(row.upstreamModel, "upstreamModel");
    const trainingRow = createLegacyV4RetrievalSnapshotTrainingRow({
      adapterVersion,
      contractEpoch: deriveLegacyV4ContractEpoch(
        adapterVersion,
        row.sourceConfigFingerprint,
      ),
      dataset,
      metrics: canonicalMetricsFromForecastStorage(row),
      referenceAt: storageInstant(row.referenceAt, "referenceAt"),
      sourceConfigFingerprint: row.sourceConfigFingerprint,
      sourceId: String(row.sourceId),
      stableRecordId: String(row.stableRecordId),
      upstreamModel,
      validAt: storageInstant(row.validAt, "validAt"),
    });

    // exclude current and unsupported target leads
    if (trainingRow === null) {
      continue;
    }

    // fail closed on a malformed domain projection
    if (!Number.isInteger(trainingRow.targetLeadHours)) {
      throw new Error("legacy v4 target lead must be an integer");
    }

    projected.push(trainingRow);
  }

  return projected;
}

// derive one local epoch from the immutable v4 tuple
export function deriveLegacyV4ContractEpoch(
  adapterVersionInput: string,
  sourceConfigFingerprintInput: string,
): string {
  const adapterVersion = validateVersion(adapterVersionInput, "adapterVersion");
  const sourceConfigFingerprint = validateFingerprint(
    sourceConfigFingerprintInput,
  );
  const tupleHash = createHash("sha256")
    .update(adapterVersion)
    .update("\0")
    .update(sourceConfigFingerprint)
    .digest("hex");

  return `legacy-v4/${tupleHash}`;
}

// build the complete canonical metric shape from storage
function canonicalMetricsFromForecastStorage(
  row: ForecastAnchorStorageRow | LegacyV4ForecastStorageRow,
): CanonicalWeatherMetrics {
  return {
    apparentTemperatureC: row.apparentTemperatureC,
    blackGlobeTemperatureC:
      "blackGlobeTemperatureC" in row ? row.blackGlobeTemperatureC : null,
    cloudCoverPercent: row.cloudCoverPercent,
    pm25MicrogramsPerCubicMeter:
      "pm25MicrogramsPerCubicMeter" in row
        ? row.pm25MicrogramsPerCubicMeter
        : null,
    precipitationMm: "precipitationMm" in row ? row.precipitationMm : null,
    precipitationRateMmPerHour:
      "precipitationRateMmPerHour" in row
        ? row.precipitationRateMmPerHour
        : null,
    pressureHpa: row.pressureHpa,
    relativeHumidityPercent: row.relativeHumidityPercent,
    soilElectricalConductivityMicrosiemensPerCm:
      "soilElectricalConductivityMicrosiemensPerCm" in row
        ? row.soilElectricalConductivityMicrosiemensPerCm
        : null,
    soilMoisturePercent:
      "soilMoisturePercent" in row ? row.soilMoisturePercent : null,
    solarRadiationWm2:
      "solarRadiationWm2" in row ? row.solarRadiationWm2 : null,
    temperatureC: row.temperatureC,
    uvIndex: "uvIndex" in row ? row.uvIndex : null,
    waterLevelM: "waterLevelM" in row ? row.waterLevelM : null,
    wetBulbGlobeTemperatureC:
      "wetBulbGlobeTemperatureC" in row
        ? row.wetBulbGlobeTemperatureC
        : null,
    windDirectionDegrees: row.windDirectionDegrees,
    windGustMps: row.windGustMps,
    windSpeedMps: row.windSpeedMps,
  };
}

// validate source lineage and row quality before aggregation
function validateForecastObservationRows(
  rows: readonly ForecastObservationStorageRow[],
): readonly ValidatedForecastObservationStorageRow[] {
  const validated: ValidatedForecastObservationStorageRow[] = [];

  // verify every selected accepted source row
  for (const row of rows) {
    const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
      (candidate) => candidate.sourceKey === row.sourceKey,
    );

    // reject unexpected repository rows
    if (lineage === undefined) {
      throw new Error(`unexpected forecast observation source ${row.sourceKey}`);
    }

    // fail closed on station or immutable source drift
    if (
      row.stationSlug !== lineage.physicalStationKey ||
      row.sourceConfigFingerprint !== lineage.checkedFingerprint ||
      row.adapterContract !== lineage.adapterContract
    ) {
      throw new Error(`forecast observation lineage mismatch for ${row.sourceKey}`);
    }

    const validAt = storageInstant(row.validAt, "validAt");
    const validAtMilliseconds = Date.parse(validAt);

    // exclude rows outside the literal half-open lineage interval
    if (
      (lineage.acceptedStartInclusive !== null &&
        validAtMilliseconds < Date.parse(lineage.acceptedStartInclusive)) ||
      (lineage.acceptedEndExclusive !== null &&
        validAtMilliseconds >= Date.parse(lineage.acceptedEndExclusive))
    ) {
      continue;
    }

    // exclude rows rejected by literal quality rules
    if (!forecastObservationQualityAccepted(row.qualityMetadata, lineage.qualityRule)) {
      continue;
    }

    validated.push({
      id: String(row.id),
      physicalStationKey: lineage.physicalStationKey,
      relativeHumidityPercent: row.relativeHumidityPercent,
      sourceKey: row.sourceKey,
      temperatureC: row.temperatureC,
      validAt,
      validAtMilliseconds,
      windDirectionDegrees: row.windDirectionDegrees,
      windGustMps: row.windGustMps,
      windSpeedMps: row.windSpeedMps,
    });
  }

  // establish bounded-memory collision order
  validated.sort(
    (left, right) =>
      left.validAtMilliseconds - right.validAtMilliseconds ||
      left.physicalStationKey.localeCompare(right.physicalStationKey) ||
      left.id.localeCompare(right.id),
  );
  assertNoForecastObservationCollisions(validated);
  return validated;
}

// apply literal status and flag allowlists
function forecastObservationQualityAccepted(
  quality: Readonly<Record<string, JsonValue>> | null,
  rule: Readonly<{
    allowedFlags: readonly string[];
    statusRule: "absent" | "absent_or_provider_qc_1";
  }>,
): boolean {
  const rawFlags = quality?.flags;
  const rawStatus = quality?.status;

  // reject malformed or unknown flags
  if (
    rawFlags !== undefined &&
    (!Array.isArray(rawFlags) ||
      rawFlags.some(
        (flag) => typeof flag !== "string" || !rule.allowedFlags.includes(flag),
      ))
  ) {
    return false;
  }

  // require absent status for non-WU sources
  if (rule.statusRule === "absent") {
    return rawStatus === undefined;
  }

  return rawStatus === undefined || rawStatus === "provider_qc_1";
}

// reject post-precedence station/time/metric collisions
function assertNoForecastObservationCollisions(
  rows: readonly ValidatedForecastObservationStorageRow[],
): void {
  const latestMetricInstants = new Map<string, number>();

  // inspect each eligible station metric
  for (const row of rows) {
    // inspect the exact five-metric matrix
    for (const metric of FORECAST_ADJUSTMENT_METRICS) {
      // skip missing station values
      if (row[metric] === null) {
        continue;
      }

      // exclude calm directions before collision identity
      if (
        metric === "windDirectionDegrees" &&
        (row.windSpeedMps === null || row.windSpeedMps < 1)
      ) {
        continue;
      }

      const identity = `${row.physicalStationKey}\0${metric}`;

      // fail on duplicate post-precedence observations
      if (latestMetricInstants.get(identity) === row.validAtMilliseconds) {
        throw new Error(
          `forecast observation collision for ${row.physicalStationKey} ${row.validAt} ${metric}`,
        );
      }

      latestMetricInstants.set(identity, row.validAtMilliseconds);
    }
  }
}

// aggregate literal station hours without network fitting
function projectForecastObservationHours(
  rows: readonly ValidatedForecastObservationStorageRow[],
  from: string,
  to: string,
): readonly ForecastObservationHourlyStationRow[] {
  const byStation = new Map<
    ForecastObservationStationKey,
    readonly ValidatedForecastObservationStorageRow[]
  >();

  // group source-precedence rows by physical identity
  for (const station of FORECAST_OBSERVATION_STATIONS) {
    byStation.set(
      station.key,
      rows
        .filter((row) => row.physicalStationKey === station.key)
        .sort(
          (left, right) =>
            left.validAtMilliseconds - right.validAtMilliseconds ||
            left.id.localeCompare(right.id),
        ),
    );
  }

  const projected: ForecastObservationHourlyStationRow[] = [];

  // emit every requested UTC hour
  for (
    let validAtMilliseconds = Date.parse(from);
    validAtMilliseconds < Date.parse(to);
    validAtMilliseconds += HOUR_MILLISECONDS
  ) {
    const validAt = new Date(validAtMilliseconds).toISOString();

    // emit every frozen physical station
    for (const station of FORECAST_OBSERVATION_STATIONS) {
      const stationRows = byStation.get(station.key) ?? [];
      const temperature = selectInstantObservation(
        stationRows,
        validAtMilliseconds,
        "temperatureC",
      );
      const humidity = selectInstantObservation(
        stationRows,
        validAtMilliseconds,
        "relativeHumidityPercent",
      );
      const speed = selectInstantObservation(
        stationRows,
        validAtMilliseconds,
        "windSpeedMps",
      );
      const direction = selectInstantObservation(
        stationRows,
        validAtMilliseconds,
        "windDirectionDegrees",
      );
      const gust = selectCoveredGustObservation(stationRows, validAtMilliseconds);
      const sourceKeys = [
        ...temperature.sourceKeys,
        ...humidity.sourceKeys,
        ...speed.sourceKeys,
        ...direction.sourceKeys,
        ...gust.sourceKeys,
      ];

      projected.push({
        metrics: {
          relativeHumidityPercent: humidity.value,
          temperatureC: temperature.value,
          windDirectionDegrees: direction.value,
          windGustMps: gust.value,
          windSpeedMps: speed.value,
        },
        physicalStationKey: station.key,
        providerFamily: station.providerFamily,
        sourceKeys: [...new Set(sourceKeys)].sort(),
        validAt,
      });
    }
  }

  return projected;
}

// choose one closest instant metric with earlier ties
function selectInstantObservation(
  rows: readonly ValidatedForecastObservationStorageRow[],
  validAtMilliseconds: number,
  metric: Exclude<ForecastAdjustmentMetric, "windGustMps">,
): Readonly<{ sourceKeys: readonly string[]; value: number | null }> {
  const candidates = rows
    .slice(
      firstObservationAtOrAfter(
        rows,
        validAtMilliseconds - FIVE_MINUTES_MILLISECONDS,
      ),
      firstObservationAtOrAfter(
        rows,
        validAtMilliseconds + FIVE_MINUTES_MILLISECONDS,
      ),
    )
    .filter((row) => {
      // skip missing station metrics
      if (row[metric] === null) {
        return false;
      }

      // require paired station speed for direction
      if (
        metric === "windDirectionDegrees" &&
        (row.windSpeedMps === null || row.windSpeedMps < 1)
      ) {
        return false;
      }

      return true;
    });
  candidates.sort((left, right) => {
    const distanceDifference =
      Math.abs(left.validAtMilliseconds - validAtMilliseconds) -
      Math.abs(right.validAtMilliseconds - validAtMilliseconds);

    // prefer the closest instant
    if (distanceDifference !== 0) {
      return distanceDifference;
    }

    // break equal-distance ties earlier
    if (left.validAtMilliseconds !== right.validAtMilliseconds) {
      return left.validAtMilliseconds - right.validAtMilliseconds;
    }

    return left.id.localeCompare(right.id);
  });
  const selected = candidates[0];

  // preserve missing instant metrics
  if (selected === undefined) {
    return { sourceKeys: [], value: null };
  }

  return { sourceKeys: [selected.sourceKey], value: selected[metric] };
}

// select a fully covered preceding-hour gust maximum
function selectCoveredGustObservation(
  rows: readonly ValidatedForecastObservationStorageRow[],
  validAtMilliseconds: number,
): Readonly<{ sourceKeys: readonly string[]; value: number | null }> {
  const windowStart = validAtMilliseconds - HOUR_MILLISECONDS;
  const candidates = rows
    .slice(
      firstObservationAfter(rows, windowStart),
      firstObservationAfter(rows, validAtMilliseconds),
    )
    .filter((row) => row.windGustMps !== null)
    .sort(
      (left, right) =>
        left.validAtMilliseconds - right.validAtMilliseconds ||
        left.id.localeCompare(right.id),
    );
  const first = candidates[0];
  const last = candidates.at(-1);

  // require observations at both window boundaries
  if (
    first === undefined ||
    last === undefined ||
    first.validAtMilliseconds - windowStart > TEN_MINUTES_MILLISECONDS ||
    validAtMilliseconds - last.validAtMilliseconds > TEN_MINUTES_MILLISECONDS
  ) {
    return { sourceKeys: [], value: null };
  }

  // reject any internal coverage gap
  for (let index = 1; index < candidates.length; index += 1) {
    // preserve missing gust on wide gaps
    if (
      candidates[index]!.validAtMilliseconds -
        candidates[index - 1]!.validAtMilliseconds >
      TEN_MINUTES_MILLISECONDS
    ) {
      return { sourceKeys: [], value: null };
    }
  }

  return {
    sourceKeys: [...new Set(candidates.map((row) => row.sourceKey))].sort(),
    value: Math.max(...candidates.map((row) => row.windGustMps!)),
  };
}

// find the first observation at or after one instant
function firstObservationAtOrAfter(
  rows: readonly ValidatedForecastObservationStorageRow[],
  instant: number,
): number {
  let lower = 0;
  let upper = rows.length;

  // narrow the sorted observation interval
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);

    // keep the matching half
    if (rows[middle]!.validAtMilliseconds < instant) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }

  return lower;
}

// find the first observation strictly after one instant
function firstObservationAfter(
  rows: readonly ValidatedForecastObservationStorageRow[],
  instant: number,
): number {
  let lower = 0;
  let upper = rows.length;

  // narrow the sorted observation interval
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);

    // keep the matching half
    if (rows[middle]!.validAtMilliseconds <= instant) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }

  return lower;
}

// convert one PostgreSQL timestamptz value
function storageInstant(value: Date | string, fieldName: string): string {
  return validateUtcInstant(
    value instanceof Date ? value.toISOString() : value,
    fieldName,
  );
}

// require one bounded storage provenance value
function requireStorageText(value: string | null, fieldName: string): string {
  // reject missing or oversized storage provenance
  if (value === null || value.trim().length === 0 || value.length > 128) {
    throw new Error(`legacy v4 ${fieldName} is missing or invalid`);
  }

  return value;
}

// centralize the raw read projection
function weatherRecordSelection(): string {
  return `
    wr.id,
    wr.source_id AS "sourceId",
    NULL::text AS "sourceConfigFingerprint",
    NULL::text AS "adapterVersion",
    NULL::text AS "contractEpoch",
    s.source_key AS "sourceKey",
    wr.source_kind AS "sourceKind",
    wr.valid_at AS "validAt",
    wr.product_run_at AS "productRunAt",
    wr.first_received_at AS "firstReceivedAt",
    wr.last_received_at AS "lastReceivedAt",
    wr.upstream_timezone AS "upstreamTimezone",
    wr.upstream_model AS "upstreamModel",
    wr.device_vendor AS "deviceVendor",
    wr.device_model AS "deviceModel",
    wr.device_serial AS "deviceSerial",
    wr.quality_metadata AS "qualityMetadata",
    wr.provider_metadata AS "providerMetadata",
    wr.revision_count AS "revisionCount",
    wr.temperature_c AS "temperatureC",
    wr.apparent_temperature_c AS "apparentTemperatureC",
    wr.precipitation_mm AS "precipitationMm",
    wr.wind_speed_mps AS "windSpeedMps",
    wr.wind_gust_mps AS "windGustMps",
    wr.pressure_hpa AS "pressureHpa",
    wr.relative_humidity_percent AS "relativeHumidityPercent",
    wr.cloud_cover_percent AS "cloudCoverPercent",
    wr.wind_direction_degrees AS "windDirectionDegrees",
    wr.black_globe_temperature_c AS "blackGlobeTemperatureC",
    wr.pm25_micrograms_per_cubic_meter AS "pm25MicrogramsPerCubicMeter",
    wr.precipitation_rate_mm_per_hour AS "precipitationRateMmPerHour",
    wr.soil_electrical_conductivity_us_cm AS "soilElectricalConductivityMicrosiemensPerCm",
    wr.soil_moisture_percent AS "soilMoisturePercent",
    wr.solar_radiation_wm2 AS "solarRadiationWm2",
    wr.uv_index AS "uvIndex",
    wr.wet_bulb_globe_temperature_c AS "wetBulbGlobeTemperatureC",
    wr.water_level_m AS "waterLevelM",
    st.slug AS "stationSlug",
    si.slug AS "siteSlug",
    p.provider_key AS "providerKey"
  `;
}

// preserve SQL null for absent JSON
function serializeNullableJson(value: JsonValue | undefined): string | null {
  // retain absent metadata as SQL null
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}
