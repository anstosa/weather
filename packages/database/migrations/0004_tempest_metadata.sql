ALTER TABLE weather_records
  DROP CONSTRAINT weather_records_quality_keys_check,
  DROP CONSTRAINT weather_records_provider_keys_check;

ALTER TABLE weather_records
  ADD CONSTRAINT weather_records_quality_keys_check CHECK (
    weather_json_object_keys_allowed(
      quality_metadata,
      ARRAY['confidence_percent', 'flags', 'interpolation', 'sampling', 'status']
    )
  ),
  ADD CONSTRAINT weather_records_provider_keys_check CHECK (
    weather_json_object_keys_allowed(
      provider_metadata,
      ARRAY[
        'battery_volts',
        'dataset',
        'device_id',
        'elevation_m',
        'grid_cell',
        'illuminance_lux',
        'lightning_average_distance_km',
        'lightning_strike_count',
        'location_id',
        'precipitation_type',
        'rain_accumulation_nc_mm',
        'report_interval_minutes',
        'request_id',
        'wind_lull_mps',
        'wind_sample_interval_seconds'
      ]
    )
  );
