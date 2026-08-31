ALTER TABLE sources
  DROP CONSTRAINT sources_source_kind_check,
  ADD CONSTRAINT sources_source_kind_check CHECK (
    source_kind IN (
      'physical_sensor',
      'model_current',
      'reanalysis',
      'forecast',
      'tide_observation',
      'tide_prediction'
    )
  );

ALTER TABLE weather_records
  ADD COLUMN water_level_m double precision,
  ADD CONSTRAINT weather_records_water_level_check CHECK (
    water_level_m IS NULL OR water_level_m BETWEEN -20 AND 30
  ) NOT VALID,
  DROP CONSTRAINT weather_records_provider_keys_check,
  ADD CONSTRAINT weather_records_provider_keys_check CHECK (
    weather_json_object_keys_allowed(
      provider_metadata,
      ARRAY[
        'battery_volts',
        'dataset',
        'datum',
        'device_id',
        'elevation_m',
        'grid_cell',
        'illuminance_lux',
        'lightning_average_distance_km',
        'lightning_strike_count',
        'location_id',
        'precipitation_type',
        'prediction_type',
        'product',
        'rain_accumulation_nc_mm',
        'report_interval_minutes',
        'request_id',
        'station_id',
        'wind_lull_mps',
        'wind_sample_interval_seconds'
      ]
    )
  ) NOT VALID;

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
      OLD.wet_bulb_globe_temperature_c,
      OLD.water_level_m
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
      NEW.wet_bulb_globe_temperature_c,
      NEW.water_level_m
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

GRANT UPDATE (water_level_m) ON weather_records TO weather_ingest;
