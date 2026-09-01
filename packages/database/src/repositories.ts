import { createHash } from "node:crypto";

import {
  createBackfillChunkIdentity,
  validateFingerprint,
  validateIngestionError,
  validateUtcInstant,
  validateVersion,
  weatherRecordContent,
  type BackfillChunkIdentity,
  type IngestionError,
  type IngestionMode,
  type JsonValue,
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
// bound ten civil forecast days with daylight-saving headroom
const MAX_FORECAST_HOURS = 264;

// hide sources replaced by an active material successor
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
  readonly apparentTemperatureC: number | null;
  readonly blackGlobeTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
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
        AND ${CURRENT_SOURCE_PREDICATE}
      ORDER BY wr.valid_at ASC, wr.id ASC
    `,
    [query.siteSlug, asOf, endExclusive],
  );

  return result.rows;
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

// centralize the read projection
function weatherRecordSelection(): string {
  return `
    wr.id,
    wr.source_id AS "sourceId",
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
