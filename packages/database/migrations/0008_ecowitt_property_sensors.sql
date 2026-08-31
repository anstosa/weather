SET LOCAL lock_timeout = '120s';

ALTER TABLE weather_records
  DROP CONSTRAINT weather_records_metadata_bounds,
  ADD CONSTRAINT weather_records_metadata_bounds CHECK (
    (quality_metadata IS NULL OR octet_length(quality_metadata::text) <= 2048)
    AND (provider_metadata IS NULL OR octet_length(provider_metadata::text) <= 8192)
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
        'property_sensors',
        'rain_accumulation_nc_mm',
        'report_interval_minutes',
        'request_id',
        'station_id',
        'wind_lull_mps',
        'wind_sample_interval_seconds'
      ]
    )
  ) NOT VALID;
