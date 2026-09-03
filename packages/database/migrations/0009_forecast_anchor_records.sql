CREATE TABLE forecast_anchor_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  source_kind varchar(32) NOT NULL,
  source_config_fingerprint char(64) NOT NULL,
  valid_at timestamptz NOT NULL,
  lead_hours smallint NOT NULL,
  dataset varchar(64) NOT NULL,
  upstream_model varchar(128) NOT NULL,
  contract_epoch varchar(128) NOT NULL,
  adapter_version varchar(128) NOT NULL,
  first_ingestion_run_id bigint NOT NULL,
  last_ingestion_run_id bigint NOT NULL,
  first_received_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  upstream_timezone varchar(64) NOT NULL REFERENCES weather_timezones(name) ON DELETE RESTRICT,
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
  CONSTRAINT forecast_anchor_records_source_kind_fkey
    FOREIGN KEY (source_id, source_kind)
    REFERENCES sources(id, source_kind)
    ON DELETE RESTRICT,
  CONSTRAINT forecast_anchor_records_source_fingerprint_fkey
    FOREIGN KEY (source_id, source_config_fingerprint)
    REFERENCES sources(id, source_config_fingerprint)
    ON DELETE RESTRICT,
  CONSTRAINT forecast_anchor_records_first_run_fkey
    FOREIGN KEY (first_ingestion_run_id, source_id)
    REFERENCES ingestion_runs(id, source_id)
    ON DELETE RESTRICT,
  CONSTRAINT forecast_anchor_records_last_run_fkey
    FOREIGN KEY (last_ingestion_run_id, source_id)
    REFERENCES ingestion_runs(id, source_id)
    ON DELETE RESTRICT,
  CONSTRAINT forecast_anchor_records_source_kind_check CHECK (source_kind = 'forecast'),
  CONSTRAINT forecast_anchor_records_lead_check CHECK (
    lead_hours IN (24, 48, 72, 96, 120, 144, 168)
  ),
  CONSTRAINT forecast_anchor_records_dataset_check CHECK (dataset = 'previous_runs'),
  CONSTRAINT forecast_anchor_records_model_check CHECK (upstream_model = 'best_match'),
  CONSTRAINT forecast_anchor_records_contract_epoch_check CHECK (
    length(trim(contract_epoch)) > 0
  ),
  CONSTRAINT forecast_anchor_records_adapter_version_check CHECK (
    length(trim(adapter_version)) > 0
  ),
  CONSTRAINT forecast_anchor_records_timezone_check CHECK (upstream_timezone = 'UTC'),
  CONSTRAINT forecast_anchor_records_receipt_order_check CHECK (
    last_received_at >= first_received_at
  ),
  CONSTRAINT forecast_anchor_records_metadata_bounds CHECK (
    (quality_metadata IS NULL OR (
      jsonb_typeof(quality_metadata) = 'object'
      AND octet_length(quality_metadata::text) <= 4096
    ))
    AND (provider_metadata IS NULL OR (
      jsonb_typeof(provider_metadata) = 'object'
      AND octet_length(provider_metadata::text) <= 4096
    ))
  ),
  CONSTRAINT forecast_anchor_records_provider_dataset_check CHECK (
    provider_metadata IS NULL
    OR NOT (provider_metadata ? 'dataset')
    OR provider_metadata ->> 'dataset' = dataset
  ),
  CONSTRAINT forecast_anchor_records_metrics_present_check CHECK (
    num_nonnulls(
      temperature_c,
      apparent_temperature_c,
      precipitation_mm,
      wind_speed_mps,
      wind_gust_mps,
      pressure_hpa,
      relative_humidity_percent,
      cloud_cover_percent,
      wind_direction_degrees
    ) > 0
  ),
  CONSTRAINT forecast_anchor_records_temperature_check CHECK (
    temperature_c IS NULL OR temperature_c BETWEEN -100 AND 70
  ),
  CONSTRAINT forecast_anchor_records_apparent_temperature_check CHECK (
    apparent_temperature_c IS NULL OR apparent_temperature_c BETWEEN -100 AND 70
  ),
  CONSTRAINT forecast_anchor_records_precipitation_check CHECK (
    precipitation_mm IS NULL OR precipitation_mm BETWEEN 0 AND 2000
  ),
  CONSTRAINT forecast_anchor_records_wind_speed_check CHECK (
    wind_speed_mps IS NULL OR wind_speed_mps BETWEEN 0 AND 150
  ),
  CONSTRAINT forecast_anchor_records_wind_gust_check CHECK (
    wind_gust_mps IS NULL OR wind_gust_mps BETWEEN 0 AND 150
  ),
  CONSTRAINT forecast_anchor_records_pressure_check CHECK (
    pressure_hpa IS NULL OR pressure_hpa BETWEEN 100 AND 1200
  ),
  CONSTRAINT forecast_anchor_records_humidity_check CHECK (
    relative_humidity_percent IS NULL OR relative_humidity_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT forecast_anchor_records_cloud_check CHECK (
    cloud_cover_percent IS NULL OR cloud_cover_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT forecast_anchor_records_direction_check CHECK (
    wind_direction_degrees IS NULL
    OR wind_direction_degrees >= 0 AND wind_direction_degrees < 360
  ),
  CONSTRAINT forecast_anchor_records_identity_key
    UNIQUE (source_id, valid_at, lead_hours)
);

CREATE INDEX forecast_anchor_records_source_valid_idx
ON forecast_anchor_records (source_id, valid_at DESC, id DESC);

CREATE INDEX forecast_anchor_records_source_lead_valid_idx
ON forecast_anchor_records (source_id, lead_hours, valid_at DESC, id DESC);

CREATE INDEX forecast_anchor_records_model_evaluation_idx
ON forecast_anchor_records (
  dataset,
  upstream_model,
  contract_epoch,
  lead_hours,
  valid_at,
  source_id
);

-- require historical-source authority
CREATE FUNCTION weather_require_historical_forecast_anchor_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- reject non-historical sources
  IF NOT EXISTS (
    SELECT 1
    FROM sources
    WHERE id = NEW.source_id
      AND source_kind = 'forecast'
      AND capabilities @> '["historical"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'forecast anchors require a historical forecast source'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- preserve anchor identity and revision semantics
CREATE FUNCTION weather_guard_forecast_anchor_record_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- preserve identity, first linkage, and forecast provenance
  IF ROW(
    OLD.source_id,
    OLD.source_kind,
    OLD.source_config_fingerprint,
    OLD.valid_at,
    OLD.lead_hours,
    OLD.dataset,
    OLD.upstream_model,
    OLD.contract_epoch,
    OLD.adapter_version,
    OLD.first_ingestion_run_id,
    OLD.first_received_at,
    OLD.upstream_timezone
  ) IS DISTINCT FROM ROW(
    NEW.source_id,
    NEW.source_kind,
    NEW.source_config_fingerprint,
    NEW.valid_at,
    NEW.lead_hours,
    NEW.dataset,
    NEW.upstream_model,
    NEW.contract_epoch,
    NEW.adapter_version,
    NEW.first_ingestion_run_id,
    NEW.first_received_at,
    NEW.upstream_timezone
  ) THEN
    RAISE EXCEPTION 'forecast anchor identity, first linkage, and provenance are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- keep receipt linkage monotonic
  IF NEW.last_received_at < OLD.last_received_at THEN
    RAISE EXCEPTION 'forecast anchor last receipt cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  -- guard identical retries
  IF OLD.content_hash = NEW.content_hash THEN
    -- permit only last linkage changes
    IF NEW.revision_count <> OLD.revision_count OR ROW(
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
      RAISE EXCEPTION 'identical forecast anchor retry may update only last linkage'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    -- require actual revision-bearing change
    IF ROW(
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
    ) IS NOT DISTINCT FROM ROW(
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
      RAISE EXCEPTION 'changed forecast anchor hash requires changed content'
        USING ERRCODE = '23514';
    END IF;

    -- require one monotonic revision
    IF NEW.revision_count <> OLD.revision_count + 1 THEN
      RAISE EXCEPTION 'changed forecast anchor content must increment revision_count once'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER forecast_anchor_records_source_guard
BEFORE INSERT OR UPDATE ON forecast_anchor_records
FOR EACH ROW
EXECUTE FUNCTION weather_require_historical_forecast_anchor_source();

CREATE TRIGGER forecast_anchor_records_revision_guard
BEFORE UPDATE ON forecast_anchor_records
FOR EACH ROW
EXECUTE FUNCTION weather_guard_forecast_anchor_record_update();

REVOKE ALL ON forecast_anchor_records FROM PUBLIC, weather_api, weather_ingest;
REVOKE ALL ON SEQUENCE forecast_anchor_records_id_seq FROM PUBLIC, weather_api, weather_ingest;

GRANT SELECT (capabilities) ON sources TO weather_api;
GRANT INSERT ON forecast_anchor_records TO weather_ingest;
GRANT SELECT (
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
  content_hash,
  revision_count
) ON forecast_anchor_records TO weather_ingest;
GRANT UPDATE (
  last_ingestion_run_id,
  last_received_at,
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
) ON forecast_anchor_records TO weather_ingest;
GRANT USAGE, SELECT ON SEQUENCE forecast_anchor_records_id_seq TO weather_ingest;
