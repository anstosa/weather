CREATE VIEW forecast_runtime_provenance_v1
WITH (security_barrier = true)
AS
SELECT
  wr.id AS weather_record_id,
  wr.source_id,
  s.source_key,
  last_run.source_config_fingerprint::text AS source_config_fingerprint,
  last_run.adapter_version,
  ('legacy-v4/' || encode(sha256(
    convert_to(last_run.adapter_version, 'UTF8')
    || decode('00', 'hex')
    || convert_to(last_run.source_config_fingerprint::text, 'UTF8')
  ), 'hex'))::varchar(128) AS contract_epoch
FROM weather_records wr
JOIN sources s ON s.id = wr.source_id
JOIN ingestion_runs last_run
  ON last_run.id = wr.last_ingestion_run_id
  AND last_run.source_id = wr.source_id
  AND last_run.source_config_fingerprint = s.source_config_fingerprint
WHERE s.source_key = 'open-meteo-forecast-v4'
  AND s.source_kind = 'forecast'
  AND s.active
  AND s.capabilities @> '["forecast"]'::jsonb
  AND weather_source_is_current(s.id)
  AND wr.source_kind = 'forecast'
  AND wr.product_run_at IS NOT NULL;

REVOKE ALL ON forecast_runtime_provenance_v1 FROM PUBLIC;
REVOKE ALL ON forecast_runtime_provenance_v1
FROM weather_api, weather_ingest, weather_training_export;
GRANT SELECT ON forecast_runtime_provenance_v1 TO weather_api;
