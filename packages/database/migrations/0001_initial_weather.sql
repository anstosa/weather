CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE weather_timezones (
  name varchar(64) PRIMARY KEY
);

INSERT INTO weather_timezones (name)
SELECT name
FROM pg_timezone_names
WHERE length(name) <= 64;

CREATE FUNCTION weather_json_object_keys_allowed(value jsonb, allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value IS NULL OR (
    jsonb_typeof(value) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(value) AS key
      WHERE NOT (key = ANY (allowed))
    )
  );
$$;

CREATE FUNCTION weather_json_array_values_allowed(value jsonb, allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(value) AS entry
      WHERE NOT (entry = ANY (allowed))
    );
$$;

CREATE TABLE sites (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name varchar(160) NOT NULL CHECK (length(trim(display_name)) > 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  timezone varchar(64) NOT NULL REFERENCES weather_timezones(name) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE stations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  slug varchar(80) NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name varchar(160) NOT NULL CHECK (length(trim(display_name)) > 0),
  station_kind varchar(16) NOT NULL CHECK (station_kind IN ('physical', 'virtual')),
  vendor varchar(128),
  model varchar(128),
  serial varchar(128),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (site_id, slug)
);

CREATE TABLE providers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key varchar(80) NOT NULL UNIQUE CHECK (provider_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name varchar(160) NOT NULL CHECK (length(trim(display_name)) > 0),
  attribution_label varchar(256) NOT NULL CHECK (length(trim(attribution_label)) > 0),
  attribution_url varchar(512) NOT NULL CHECK (attribution_url ~ '^https?://'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  station_id bigint NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  provider_id bigint NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  source_key varchar(80) NOT NULL CHECK (source_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  source_kind varchar(32) NOT NULL CHECK (source_kind IN ('physical_sensor', 'model_current', 'reanalysis', 'forecast')),
  material_provider_config jsonb NOT NULL CHECK (jsonb_typeof(material_provider_config) = 'object'),
  source_config_fingerprint char(64) NOT NULL CHECK (source_config_fingerprint ~ '^[a-f0-9]{64}$'),
  capabilities jsonb NOT NULL CHECK (
    weather_json_array_values_allowed(
      capabilities,
      ARRAY['current', 'historical', 'forecast', 'stream']
    )
  ),
  cadence_seconds integer CHECK (cadence_seconds IS NULL OR cadence_seconds BETWEEN 60 AND 31536000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (station_id, source_key),
  UNIQUE (id, source_kind),
  UNIQUE (id, source_config_fingerprint)
);

CREATE FUNCTION weather_reject_source_material_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- reject material mutation
  IF ROW(
    OLD.station_id,
    OLD.provider_id,
    OLD.source_key,
    OLD.source_kind,
    OLD.material_provider_config,
    OLD.source_config_fingerprint,
    OLD.capabilities
  ) IS DISTINCT FROM ROW(
    NEW.station_id,
    NEW.provider_id,
    NEW.source_key,
    NEW.source_kind,
    NEW.material_provider_config,
    NEW.source_config_fingerprint,
    NEW.capabilities
  ) THEN
    RAISE EXCEPTION 'source material configuration is immutable' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_material_immutable
BEFORE UPDATE ON sources
FOR EACH ROW
EXECUTE FUNCTION weather_reject_source_material_change();

CREATE TABLE ingestion_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  mode varchar(16) NOT NULL CHECK (mode IN ('scheduled', 'backfill')),
  requested_start timestamptz NOT NULL,
  requested_end_exclusive timestamptz NOT NULL,
  source_config_fingerprint char(64) NOT NULL,
  adapter_version varchar(128) NOT NULL CHECK (length(trim(adapter_version)) > 0),
  chunk_plan_version varchar(128),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  state varchar(16) NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed', 'abandoned')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  request_metadata jsonb,
  response_metadata jsonb,
  error_classification varchar(32) CHECK (error_classification IN ('retryable', 'rate_limited', 'permanent', 'invalid_payload')),
  error_code varchar(64) CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_:-]+$'),
  error_message varchar(512),
  upstream_response_checksum char(64) CHECK (upstream_response_checksum IS NULL OR upstream_response_checksum ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ingestion_runs_interval_check CHECK (requested_start < requested_end_exclusive),
  CONSTRAINT ingestion_runs_deadline_check CHECK (deadline_at > started_at),
  CONSTRAINT ingestion_runs_plan_check CHECK ((mode = 'backfill') = (chunk_plan_version IS NOT NULL)),
  CONSTRAINT ingestion_runs_completion_check CHECK ((state = 'running') = (completed_at IS NULL)),
  CONSTRAINT ingestion_runs_metadata_bounds CHECK (
    (request_metadata IS NULL OR octet_length(request_metadata::text) <= 4096)
    AND (response_metadata IS NULL OR octet_length(response_metadata::text) <= 4096)
  ),
  CONSTRAINT ingestion_runs_source_fingerprint_fkey
    FOREIGN KEY (source_id, source_config_fingerprint)
    REFERENCES sources(id, source_config_fingerprint)
    ON DELETE RESTRICT,
  UNIQUE (id, source_id)
);

CREATE INDEX ingestion_runs_source_state_deadline_idx
ON ingestion_runs (source_id, state, deadline_at);

CREATE UNIQUE INDEX ingestion_runs_one_running_source_idx
ON ingestion_runs (source_id)
WHERE state = 'running';

CREATE TABLE ingestion_checkpoints (
  source_id bigint PRIMARY KEY REFERENCES sources(id) ON DELETE RESTRICT,
  last_valid_at timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end_exclusive timestamptz NOT NULL,
  provider_cursor jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  last_committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ingestion_checkpoints_interval_check CHECK (window_start < window_end_exclusive),
  CONSTRAINT ingestion_checkpoints_cursor_bounds CHECK (
    provider_cursor IS NULL OR octet_length(provider_cursor::text) <= 4096
  )
);

CREATE TABLE backfill_chunk_outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  interval_start timestamptz NOT NULL,
  interval_end_exclusive timestamptz NOT NULL,
  source_config_fingerprint char(64) NOT NULL,
  adapter_version varchar(128) NOT NULL,
  chunk_plan_version varchar(128) NOT NULL,
  requested_from_date date NOT NULL,
  requested_to_date date NOT NULL,
  ingestion_run_id bigint NOT NULL,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_code varchar(64),
  CONSTRAINT backfill_chunk_outcomes_interval_check CHECK (interval_start < interval_end_exclusive),
  CONSTRAINT backfill_chunk_outcomes_dates_check CHECK (requested_from_date <= requested_to_date),
  CONSTRAINT backfill_chunk_outcomes_source_fingerprint_fkey
    FOREIGN KEY (source_id, source_config_fingerprint)
    REFERENCES sources(id, source_config_fingerprint)
    ON DELETE RESTRICT,
  CONSTRAINT backfill_chunk_outcomes_run_source_fkey
    FOREIGN KEY (ingestion_run_id, source_id)
    REFERENCES ingestion_runs(id, source_id)
    ON DELETE RESTRICT,
  UNIQUE (
    source_id,
    interval_start,
    interval_end_exclusive,
    source_config_fingerprint,
    adapter_version,
    chunk_plan_version
  )
);

CREATE INDEX backfill_chunk_outcomes_resume_idx
ON backfill_chunk_outcomes (
  source_id,
  source_config_fingerprint,
  adapter_version,
  chunk_plan_version,
  outcome
);

CREATE TABLE weather_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  source_kind varchar(32) NOT NULL,
  valid_at timestamptz NOT NULL,
  product_run_at timestamptz,
  first_ingestion_run_id bigint NOT NULL,
  last_ingestion_run_id bigint NOT NULL,
  first_received_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  upstream_timezone varchar(64) NOT NULL REFERENCES weather_timezones(name) ON DELETE RESTRICT,
  upstream_model varchar(128),
  device_vendor varchar(128),
  device_model varchar(128),
  device_serial varchar(128),
  quality_metadata jsonb,
  provider_metadata jsonb,
  temperature_c double precision,
  apparent_temperature_c double precision,
  precipitation_mm double precision,
  wind_speed_mps double precision,
  wind_gust_mps double precision,
  pressure_hpa double precision,
  relative_humidity_percent double precision,
  cloud_cover_percent double precision,
  wind_direction_degrees double precision,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  revision_count integer NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
  CONSTRAINT weather_records_source_kind_fkey
    FOREIGN KEY (source_id, source_kind)
    REFERENCES sources(id, source_kind)
    ON DELETE RESTRICT,
  CONSTRAINT weather_records_first_run_fkey
    FOREIGN KEY (first_ingestion_run_id, source_id)
    REFERENCES ingestion_runs(id, source_id)
    ON DELETE RESTRICT,
  CONSTRAINT weather_records_last_run_fkey
    FOREIGN KEY (last_ingestion_run_id, source_id)
    REFERENCES ingestion_runs(id, source_id)
    ON DELETE RESTRICT,
  CONSTRAINT weather_records_forecast_product_check CHECK (source_kind <> 'forecast' OR product_run_at IS NOT NULL),
  CONSTRAINT weather_records_receipt_order_check CHECK (last_received_at >= first_received_at),
  CONSTRAINT weather_records_temperature_check CHECK (temperature_c IS NULL OR temperature_c BETWEEN -100 AND 70),
  CONSTRAINT weather_records_apparent_temperature_check CHECK (apparent_temperature_c IS NULL OR apparent_temperature_c BETWEEN -100 AND 70),
  CONSTRAINT weather_records_precipitation_check CHECK (precipitation_mm IS NULL OR precipitation_mm BETWEEN 0 AND 2000),
  CONSTRAINT weather_records_wind_speed_check CHECK (wind_speed_mps IS NULL OR wind_speed_mps BETWEEN 0 AND 150),
  CONSTRAINT weather_records_wind_gust_check CHECK (wind_gust_mps IS NULL OR wind_gust_mps BETWEEN 0 AND 150),
  CONSTRAINT weather_records_pressure_check CHECK (pressure_hpa IS NULL OR pressure_hpa BETWEEN 100 AND 1200),
  CONSTRAINT weather_records_humidity_check CHECK (relative_humidity_percent IS NULL OR relative_humidity_percent BETWEEN 0 AND 100),
  CONSTRAINT weather_records_cloud_check CHECK (cloud_cover_percent IS NULL OR cloud_cover_percent BETWEEN 0 AND 100),
  CONSTRAINT weather_records_direction_check CHECK (wind_direction_degrees IS NULL OR wind_direction_degrees >= 0 AND wind_direction_degrees < 360),
  CONSTRAINT weather_records_metadata_bounds CHECK (
    (quality_metadata IS NULL OR octet_length(quality_metadata::text) <= 2048)
    AND (provider_metadata IS NULL OR octet_length(provider_metadata::text) <= 2048)
  ),
  CONSTRAINT weather_records_quality_keys_check CHECK (
    weather_json_object_keys_allowed(
      quality_metadata,
      ARRAY['confidence_percent', 'flags', 'interpolation', 'status']
    )
  ),
  CONSTRAINT weather_records_provider_keys_check CHECK (
    weather_json_object_keys_allowed(
      provider_metadata,
      ARRAY['dataset', 'elevation_m', 'grid_cell', 'request_id']
    )
  ),
  CONSTRAINT weather_records_identity_key
    UNIQUE NULLS NOT DISTINCT (source_id, source_kind, valid_at, product_run_at)
);

CREATE INDEX weather_records_source_valid_idx
ON weather_records (source_id, valid_at DESC, id DESC);

CREATE INDEX weather_records_kind_valid_idx
ON weather_records (source_kind, valid_at DESC, id DESC);

CREATE INDEX weather_records_current_idx
ON weather_records (source_id, valid_at DESC, id DESC)
INCLUDE (last_received_at, source_kind);

CREATE FUNCTION weather_guard_weather_record_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- preserve record identity and first linkage
  IF ROW(
    OLD.source_id,
    OLD.source_kind,
    OLD.valid_at,
    OLD.product_run_at,
    OLD.first_ingestion_run_id,
    OLD.first_received_at
  ) IS DISTINCT FROM ROW(
    NEW.source_id,
    NEW.source_kind,
    NEW.valid_at,
    NEW.product_run_at,
    NEW.first_ingestion_run_id,
    NEW.first_received_at
  ) THEN
    RAISE EXCEPTION 'weather record identity and first linkage are immutable' USING ERRCODE = '23514';
  END IF;

  -- guard identical retries
  IF OLD.content_hash = NEW.content_hash THEN
    -- permit only last linkage changes
    IF NEW.revision_count <> OLD.revision_count OR ROW(
      OLD.upstream_timezone,
      OLD.upstream_model,
      OLD.device_vendor,
      OLD.device_model,
      OLD.device_serial,
      OLD.quality_metadata,
      OLD.provider_metadata,
      OLD.temperature_c,
      OLD.apparent_temperature_c,
      OLD.precipitation_mm,
      OLD.wind_speed_mps,
      OLD.wind_gust_mps,
      OLD.pressure_hpa,
      OLD.relative_humidity_percent,
      OLD.cloud_cover_percent,
      OLD.wind_direction_degrees
    ) IS DISTINCT FROM ROW(
      NEW.upstream_timezone,
      NEW.upstream_model,
      NEW.device_vendor,
      NEW.device_model,
      NEW.device_serial,
      NEW.quality_metadata,
      NEW.provider_metadata,
      NEW.temperature_c,
      NEW.apparent_temperature_c,
      NEW.precipitation_mm,
      NEW.wind_speed_mps,
      NEW.wind_gust_mps,
      NEW.pressure_hpa,
      NEW.relative_humidity_percent,
      NEW.cloud_cover_percent,
      NEW.wind_direction_degrees
    ) THEN
      RAISE EXCEPTION 'identical weather retry may update only last linkage' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- require one monotonic revision
    IF NEW.revision_count <> OLD.revision_count + 1 THEN
      RAISE EXCEPTION 'changed weather content must increment revision_count once' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER weather_records_revision_guard
BEFORE UPDATE ON weather_records
FOR EACH ROW
EXECUTE FUNCTION weather_guard_weather_record_update();

CREATE TABLE worker_heartbeats (
  worker_instance varchar(128) PRIMARY KEY,
  last_loop_at timestamptz NOT NULL,
  last_success_at timestamptz,
  current_activity varchar(256),
  worker_version varchar(128) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO weather_api, weather_ingest;
GRANT SELECT ON sites, stations, providers, weather_records, worker_heartbeats, schema_migrations TO weather_api;
GRANT SELECT (
  id,
  station_id,
  provider_id,
  source_key,
  source_kind,
  cadence_seconds,
  active,
  created_at,
  updated_at
) ON sources TO weather_api;

GRANT SELECT ON sites, stations, providers, sources TO weather_ingest;
GRANT SELECT, INSERT, UPDATE ON ingestion_runs, ingestion_checkpoints, backfill_chunk_outcomes, worker_heartbeats TO weather_ingest;
GRANT SELECT, INSERT ON weather_records TO weather_ingest;
GRANT UPDATE (
  last_ingestion_run_id,
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
  content_hash,
  revision_count
) ON weather_records TO weather_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO weather_ingest;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
