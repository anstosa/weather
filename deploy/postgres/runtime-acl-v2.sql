\set ON_ERROR_STOP on

SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC, weather_api, weather_ingest, weather_training_export',
  current_database()
)
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO weather_owner, weather_api, weather_ingest, weather_training_export',
  current_database()
)
\gexec

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM weather_api, weather_ingest;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM weather_api, weather_ingest;
REVOKE ALL ON SCHEMA public FROM weather_api, weather_ingest;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM weather_training_export;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM weather_training_export;
REVOKE ALL ON SCHEMA public FROM weather_training_export;

GRANT USAGE ON SCHEMA public TO weather_api, weather_ingest;
GRANT USAGE ON SCHEMA public TO weather_training_export;
GRANT SELECT ON sites, stations, providers, weather_records, worker_heartbeats, schema_migrations TO weather_api;
GRANT SELECT (
  id,
  station_id,
  provider_id,
  source_key,
  source_kind,
  capabilities,
  cadence_seconds,
  active,
  created_at,
  updated_at
) ON sources TO weather_api;
GRANT SELECT ON forecast_runtime_provenance_v1 TO weather_api;

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
  black_globe_temperature_c,
  precipitation_mm,
  precipitation_rate_mm_per_hour,
  wind_speed_mps,
  wind_gust_mps,
  pressure_hpa,
  relative_humidity_percent,
  cloud_cover_percent,
  wind_direction_degrees,
  pm25_micrograms_per_cubic_meter,
  soil_electrical_conductivity_us_cm,
  soil_moisture_percent,
  solar_radiation_wm2,
  uv_index,
  wet_bulb_globe_temperature_c,
  water_level_m,
  content_hash,
  revision_count
) ON weather_records TO weather_ingest;
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
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO weather_ingest;

GRANT SELECT ON forecast_training_export_rows_v1 TO weather_training_export;
GRANT SELECT ON forecast_training_export_manifest_v1 TO weather_training_export;

ALTER ROLE weather_training_export
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- clear database-specific role defaults
SELECT format(
  'ALTER ROLE weather_training_export IN DATABASE %I RESET ALL',
  database.datname
)
FROM pg_db_role_setting setting
JOIN pg_database database ON database.oid = setting.setdatabase
WHERE setting.setrole = 'weather_training_export'::regrole
ORDER BY database.datname
\gexec
ALTER ROLE weather_training_export RESET ALL;
ALTER ROLE weather_training_export SET default_transaction_read_only = on;
SELECT format('REVOKE %I FROM weather_training_export', granted_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
WHERE membership.member = 'weather_training_export'::regrole
\gexec

-- remove inherited execution from application-owned and reachable definers
DO $$
DECLARE
  application_function record;
  restricted_schema record;
BEGIN
  -- enumerate only non-system application function identities
  FOR application_function IN
    SELECT procedure.oid::regprocedure AS identity
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND procedure.prosecdef
      AND (
        procedure.proowner = 'weather_owner'::regrole
        OR (
          (
            EXISTS (
              SELECT 1
              FROM aclexplode(coalesce(
                namespace.nspacl,
                acldefault('n', namespace.nspowner)
              )) schema_acl
              WHERE schema_acl.grantee = 0
                AND schema_acl.privilege_type = 'USAGE'
            )
            AND EXISTS (
              SELECT 1
              FROM aclexplode(coalesce(
                procedure.proacl,
                acldefault('f', procedure.proowner)
              )) function_acl
              WHERE function_acl.grantee = 0
                AND function_acl.privilege_type = 'EXECUTE'
            )
          )
          OR (
            has_schema_privilege('weather_api', namespace.oid, 'USAGE')
            AND has_function_privilege('weather_api', procedure.oid, 'EXECUTE')
          )
          OR (
            has_schema_privilege('weather_ingest', namespace.oid, 'USAGE')
            AND has_function_privilege('weather_ingest', procedure.oid, 'EXECUTE')
          )
          OR (
            has_schema_privilege('weather_training_export', namespace.oid, 'USAGE')
            AND has_function_privilege(
              'weather_training_export', procedure.oid, 'EXECUTE'
            )
          )
        )
      )
    ORDER BY namespace.nspname, procedure.oid::regprocedure::text
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, weather_api, weather_ingest, weather_training_export',
      application_function.identity
    );
  END LOOP;

  -- remove direct export access from every non-system auxiliary namespace
  FOR restricted_schema IN
    SELECT namespace.nspname
    FROM pg_namespace namespace
    WHERE namespace.nspname <> 'public'
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY namespace.nspname
  LOOP
    EXECUTE format(
      'REVOKE ALL ON SCHEMA %I FROM weather_training_export',
      restricted_schema.nspname
    );
    -- remove ambient DDL without removing function reachability
    EXECUTE format(
      'REVOKE CREATE ON SCHEMA %I FROM PUBLIC',
      restricted_schema.nspname
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION weather_source_is_current(bigint)
TO weather_api, weather_ingest;
GRANT EXECUTE ON FUNCTION weather_json_object_keys_allowed(jsonb, text[])
TO weather_ingest;

ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
