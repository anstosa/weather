ALTER TABLE weather_records
  ADD COLUMN black_globe_temperature_c double precision,
  ADD COLUMN pm25_micrograms_per_cubic_meter double precision,
  ADD COLUMN precipitation_rate_mm_per_hour double precision,
  ADD COLUMN soil_electrical_conductivity_us_cm double precision,
  ADD COLUMN soil_moisture_percent double precision,
  ADD COLUMN solar_radiation_wm2 double precision,
  ADD COLUMN uv_index double precision,
  ADD COLUMN wet_bulb_globe_temperature_c double precision;

ALTER TABLE weather_records
  ADD CONSTRAINT weather_records_black_globe_temperature_check
    CHECK (black_globe_temperature_c IS NULL OR black_globe_temperature_c BETWEEN -100 AND 125),
  ADD CONSTRAINT weather_records_pm25_check
    CHECK (pm25_micrograms_per_cubic_meter IS NULL OR pm25_micrograms_per_cubic_meter BETWEEN 0 AND 999),
  ADD CONSTRAINT weather_records_precipitation_rate_check
    CHECK (precipitation_rate_mm_per_hour IS NULL OR precipitation_rate_mm_per_hour BETWEEN 0 AND 10000),
  ADD CONSTRAINT weather_records_soil_ec_check
    CHECK (soil_electrical_conductivity_us_cm IS NULL OR soil_electrical_conductivity_us_cm BETWEEN 0 AND 10000),
  ADD CONSTRAINT weather_records_soil_moisture_check
    CHECK (soil_moisture_percent IS NULL OR soil_moisture_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT weather_records_solar_radiation_check
    CHECK (solar_radiation_wm2 IS NULL OR solar_radiation_wm2 BETWEEN 0 AND 2500),
  ADD CONSTRAINT weather_records_uv_index_check
    CHECK (uv_index IS NULL OR uv_index BETWEEN 0 AND 20),
  ADD CONSTRAINT weather_records_wbgt_check
    CHECK (wet_bulb_globe_temperature_c IS NULL OR wet_bulb_globe_temperature_c BETWEEN -100 AND 125);

CREATE OR REPLACE FUNCTION weather_guard_weather_record_update()
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
      OLD.black_globe_temperature_c,
      OLD.precipitation_mm,
      OLD.precipitation_rate_mm_per_hour,
      OLD.wind_speed_mps,
      OLD.wind_gust_mps,
      OLD.pressure_hpa,
      OLD.relative_humidity_percent,
      OLD.cloud_cover_percent,
      OLD.wind_direction_degrees,
      OLD.pm25_micrograms_per_cubic_meter,
      OLD.soil_electrical_conductivity_us_cm,
      OLD.soil_moisture_percent,
      OLD.solar_radiation_wm2,
      OLD.uv_index,
      OLD.wet_bulb_globe_temperature_c
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
      NEW.black_globe_temperature_c,
      NEW.precipitation_mm,
      NEW.precipitation_rate_mm_per_hour,
      NEW.wind_speed_mps,
      NEW.wind_gust_mps,
      NEW.pressure_hpa,
      NEW.relative_humidity_percent,
      NEW.cloud_cover_percent,
      NEW.wind_direction_degrees,
      NEW.pm25_micrograms_per_cubic_meter,
      NEW.soil_electrical_conductivity_us_cm,
      NEW.soil_moisture_percent,
      NEW.solar_radiation_wm2,
      NEW.uv_index,
      NEW.wet_bulb_globe_temperature_c
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

GRANT UPDATE (
  black_globe_temperature_c,
  pm25_micrograms_per_cubic_meter,
  precipitation_rate_mm_per_hour,
  soil_electrical_conductivity_us_cm,
  soil_moisture_percent,
  solar_radiation_wm2,
  uv_index,
  wet_bulb_globe_temperature_c
) ON weather_records TO weather_ingest;
