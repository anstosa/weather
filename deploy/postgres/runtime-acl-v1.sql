\set ON_ERROR_STOP on

SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC, weather_api, weather_ingest',
  current_database()
)
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO weather_owner, weather_api, weather_ingest',
  current_database()
)
\gexec

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM weather_api, weather_ingest;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM weather_api, weather_ingest;
REVOKE ALL ON SCHEMA public FROM weather_api, weather_ingest;

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
GRANT SELECT ON schema_migrations TO weather_ingest;
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

ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
