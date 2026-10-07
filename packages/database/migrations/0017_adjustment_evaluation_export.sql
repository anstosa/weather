-- expose only the fixed Ballydidean adjustment-evaluation evidence contract
CREATE VIEW adjustment_evaluation_export_rows_v1
WITH (security_barrier = true)
AS
WITH
-- read only transaction-local export bounds
raw_requested_range AS MATERIALIZED (
  SELECT
    current_setting('weather.adjustment_evaluation_from_date', true) AS from_text,
    current_setting('weather.adjustment_evaluation_to_date', true) AS to_text
),
-- parse exact calendar dates before validation
parsed_requested_range AS MATERIALIZED (
  SELECT
    from_text,
    to_text,
    from_text::date AS from_date,
    to_text::date AS to_date
  FROM raw_requested_range
),
-- fail closed on missing, reversed, or oversized ranges
validated_range AS MATERIALIZED (
  SELECT
    from_date + (
      1 / (
        (
          from_date IS NOT NULL
          AND to_date IS NOT NULL
          AND from_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND to_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND from_date::text = from_text
          AND to_date::text = to_text
          AND to_date >= from_date
          AND to_date - from_date BETWEEN 0 AND 13
        )::integer
      ) - 1
    ) AS from_date,
    to_date
  FROM parsed_requested_range
),
-- derive DST-aware interval bounds
requested_interval AS MATERIALIZED (
  SELECT
    from_date,
    to_date,
    from_date::timestamp AT TIME ZONE 'America/Los_Angeles' AS start_inclusive,
    (to_date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles' AS end_exclusive
  FROM validated_range
),
-- retain immutable ECMWF run state when at least one exported hour is in range
temperature_runs AS (
  SELECT
    'temperature_run'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('ecmwf-temperature-canary:' || run.id)::text AS source_identity,
    ('ecmwf-temperature-canary-run:' || run.id || ':r' || run.revision_count)::text
      AS record_revision_identity,
    export_hour.local_date,
    run.run_initialized_at AS valid_at,
    run.run_initialized_at AS reference_at,
    run.first_received_at,
    run.last_received_at,
    run.revision_count,
    run.content_hash::text AS content_hash,
    NULL::bytea AS compressed_body,
    jsonb_build_object(
      'adapterVersion', run.adapter_version,
      'contentHash', run.content_hash,
      'firstReceivedAt', run.first_received_at,
      'id', run.id,
      'lastReceivedAt', run.last_received_at,
      'modelCycle', run.model_cycle,
      'providerResponseSha256', run.provider_response_sha256,
      'recentErrorState', run.recent_error_state,
      'recentErrorStateSha256', run.recent_error_state_sha256,
      'revisionCount', run.revision_count,
      'runInitializedAt', run.run_initialized_at,
      'stateReason', run.state_reason,
      'stateStatus', run.state_status,
      'upstreamModel', run.upstream_model
    ) AS payload
  FROM requested_interval requested
  JOIN sites site ON site.slug = 'ballydidean'
  JOIN ecmwf_temperature_canary_runs run ON run.site_id = site.id
  JOIN LATERAL (
    SELECT min((hour.valid_at AT TIME ZONE 'America/Los_Angeles')::date) AS local_date
    FROM ecmwf_temperature_canary_hours hour
    WHERE hour.run_id = run.id
      AND hour.valid_at >= requested.start_inclusive
      AND hour.valid_at < requested.end_exclusive
  ) export_hour ON export_hour.local_date IS NOT NULL
),
-- retain immutable ECMWF hourly inputs for the requested valid dates
temperature_hours AS (
  SELECT
    'temperature_hour'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('ecmwf-temperature-canary:' || run.id)::text AS source_identity,
    ('ecmwf-temperature-canary-hour:' || run.id || ':' || hour.model_lead_hours)::text
      AS record_revision_identity,
    (hour.valid_at AT TIME ZONE 'America/Los_Angeles')::date AS local_date,
    hour.valid_at,
    run.run_initialized_at AS reference_at,
    run.first_received_at,
    run.last_received_at,
    run.revision_count,
    hour.content_hash::text AS content_hash,
    NULL::bytea AS compressed_body,
    jsonb_build_object(
      'contentHash', hour.content_hash,
      'modelLeadHours', hour.model_lead_hours,
      'rawRelativeHumidityPercent', hour.raw_relative_humidity_percent,
      'rawTemperatureC', hour.raw_temperature_c,
      'rawWindSpeedMps', hour.raw_wind_speed_mps,
      'runId', hour.run_id,
      'validAt', hour.valid_at
    ) AS payload
  FROM requested_interval requested
  JOIN sites site ON site.slug = 'ballydidean'
  JOIN ecmwf_temperature_canary_runs run ON run.site_id = site.id
  JOIN ecmwf_temperature_canary_hours hour ON hour.run_id = run.id
  WHERE hour.valid_at >= requested.start_inclusive
    AND hour.valid_at < requested.end_exclusive
),
-- aggregate target revisions by source and hour without target values
target_revision_groups AS (
  SELECT
    source.id AS source_id,
    station.slug::text AS physical_station_key,
    source.source_key,
    source.source_config_fingerprint,
    source.material_provider_config ->> 'contractVersion' AS adapter_contract,
    provider.provider_key,
    date_trunc('hour', record.valid_at) AS valid_hour,
    min(record.first_received_at) AS first_received_at,
    max(record.last_received_at) AS last_received_at,
    count(*)::integer AS contributing_record_count,
    count(*) FILTER (WHERE record.revision_count > 0)::integer AS revised_record_count,
    max(record.revision_count) AS max_revision_count,
    encode(sha256(convert_to(
      string_agg(
        DISTINCT record.content_hash::text,
        E'\n' ORDER BY record.content_hash::text
      ),
      'UTF8'
    )), 'hex')::char(64) AS contributor_content_hashes_sha256,
    encode(sha256(convert_to(
      string_agg(
        record.id::text || ':r' || record.revision_count::text || ':'
          || record.content_hash || ':'
          || to_char(
            record.first_received_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) || ':'
          || to_char(
            record.last_received_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
        E'\n' ORDER BY record.valid_at, record.id
      ),
      'UTF8'
    )), 'hex')::char(64) AS contributor_revision_sha256
  FROM requested_interval requested
  JOIN sites site ON site.slug = 'ballydidean'
  JOIN stations station ON station.site_id = site.id
  JOIN sources source
    ON source.station_id = station.id
    AND source.source_kind = 'physical_sensor'
  JOIN providers provider ON provider.id = source.provider_id
  JOIN weather_records record
    ON record.source_id = source.id
    AND record.source_kind = 'physical_sensor'
    AND record.valid_at >= requested.start_inclusive
    AND record.valid_at < requested.end_exclusive
  GROUP BY
    source.id,
    station.slug,
    source.source_key,
    source.source_config_fingerprint,
    source.material_provider_config ->> 'contractVersion',
    provider.provider_key,
    date_trunc('hour', record.valid_at)
),
-- retain bounded hourly target revision fingerprints
target_revision_diagnostics AS (
  SELECT
    'target_revision_diagnostic'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('physical-target:' || grouped.source_id || ':' || grouped.source_key || ':'
      || grouped.provider_key)::text AS source_identity,
    ('physical-target-hour:' || grouped.source_id || ':'
      || to_char(
        grouped.valid_hour AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) || ':' || grouped.contributor_revision_sha256)::text
      AS record_revision_identity,
    (grouped.valid_hour AT TIME ZONE 'America/Los_Angeles')::date AS local_date,
    grouped.valid_hour AS valid_at,
    NULL::timestamptz AS reference_at,
    grouped.first_received_at,
    grouped.last_received_at,
    grouped.max_revision_count AS revision_count,
    grouped.contributor_revision_sha256::text AS content_hash,
    NULL::bytea AS compressed_body,
    jsonb_build_object(
      'adapterContract', grouped.adapter_contract,
      'contributorContentHashesSha256', grouped.contributor_content_hashes_sha256,
      'contributorRevisionSha256', grouped.contributor_revision_sha256,
      'firstReceivedAt', grouped.first_received_at,
      'maxSourceReceiptAt', grouped.last_received_at,
      'maxRevisionCount', grouped.max_revision_count,
      'physicalStationKey', grouped.physical_station_key,
      'providerKey', grouped.provider_key,
      'recordCount', grouped.contributing_record_count,
      'revisedRecordCount', grouped.revised_record_count,
      'sourceConfigFingerprint', grouped.source_config_fingerprint,
      'sourceId', grouped.source_id,
      'sourceKey', grouped.source_key,
      'sourceKeys', jsonb_build_array(grouped.source_key),
      'validAt', grouped.valid_hour
    ) AS payload
  FROM target_revision_groups grouped
),
-- retain fixed-policy rain claims whose scoring instant is in range
rain_claims AS (
  SELECT
    'rain_claim'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('rain-capture:' || claim.kind || ':' || claim.id)::text AS source_identity,
    ('rain-capture-claim:' || claim.id)::text AS record_revision_identity,
    (coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      AT TIME ZONE 'America/Los_Angeles')::date AS local_date,
    coalesce(claim.run_initialized_at, claim.window_end_exclusive) AS valid_at,
    claim.run_initialized_at AS reference_at,
    claim.claimed_at AS first_received_at,
    claim.claimed_at AS last_received_at,
    0::integer AS revision_count,
    claim.policy_sha256::text AS content_hash,
    NULL::bytea AS compressed_body,
    jsonb_build_object(
      'attempt', claim.attempt,
      'claimedAt', claim.claimed_at,
      'id', claim.id,
      'kind', claim.kind,
      'policy', claim.policy,
      'policySha256', claim.policy_sha256,
      'release', claim.release,
      'runInitializedAt', claim.run_initialized_at,
      'slotKey', claim.slot_key,
      'stationId', claim.station_id,
      'windowEndExclusive', claim.window_end_exclusive,
      'windowStart', claim.window_start
    ) AS payload
  FROM requested_interval requested
  JOIN rain_capture_claims claim
    ON coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      >= requested.start_inclusive
    AND coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      < requested.end_exclusive
),
-- retain receipts and their bounded compressed provider bodies
rain_receipts AS (
  SELECT
    'rain_receipt'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('rain-capture:' || claim.kind || ':' || claim.id)::text AS source_identity,
    ('rain-capture-receipt:' || receipt.claim_id)::text AS record_revision_identity,
    (coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      AT TIME ZONE 'America/Los_Angeles')::date AS local_date,
    coalesce(claim.run_initialized_at, claim.window_end_exclusive) AS valid_at,
    claim.run_initialized_at AS reference_at,
    receipt.completed_at AS first_received_at,
    receipt.completed_at AS last_received_at,
    0::integer AS revision_count,
    receipt.body_sha256::text AS content_hash,
    receipt.compressed_body,
    jsonb_build_object(
      'availableByDecision', receipt.available_by_decision,
      'bodyBytes', receipt.body_bytes,
      'bodySha256', receipt.body_sha256,
      'claimId', receipt.claim_id,
      'completedAt', receipt.completed_at,
      'compressedBytes', receipt.compressed_bytes,
      'errorCode', receipt.error_code,
      'httpStatus', receipt.http_status,
      'metadata', receipt.metadata,
      'outcome', receipt.outcome,
      'parserVersion', receipt.parser_version,
      'recordedAt', receipt.recorded_at,
      'rowCount', receipt.row_count,
      'startedAt', receipt.started_at
    ) AS payload
  FROM requested_interval requested
  JOIN rain_capture_claims claim
    ON coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      >= requested.start_inclusive
    AND coalesce(claim.run_initialized_at, claim.window_end_exclusive)
      < requested.end_exclusive
  JOIN rain_capture_receipts receipt ON receipt.claim_id = claim.id
),
-- retain saved deterministic rain outputs and their causal source receipt
rain_adjustment AS (
  SELECT
    'rain_adjustment_run'::text AS record_kind,
    'ballydidean'::text AS site_key,
    ('rain-adjustment:' || adjustment.forecast_claim_id)::text AS source_identity,
    ('rain-adjustment-run:' || adjustment.run_initialized_at || ':'
      || adjustment.model_sha256)::text AS record_revision_identity,
    (adjustment.run_initialized_at AT TIME ZONE 'America/Los_Angeles')::date
      AS local_date,
    adjustment.run_initialized_at AS valid_at,
    adjustment.run_initialized_at AS reference_at,
    adjustment.first_received_at,
    adjustment.generated_at AS last_received_at,
    0::integer AS revision_count,
    adjustment.input_sha256::text AS content_hash,
    NULL::bytea AS compressed_body,
    jsonb_build_object(
      'decisionAt', adjustment.decision_at,
      'firstReceivedAt', adjustment.first_received_at,
      'forecastClaimId', adjustment.forecast_claim_id,
      'generatedAt', adjustment.generated_at,
      'hours', adjustment.hours,
      'inputSha256', adjustment.input_sha256,
      'modelSha256', adjustment.model_sha256,
      'runInitializedAt', adjustment.run_initialized_at
    ) AS payload
  FROM requested_interval requested
  JOIN rain_adjustment_runs adjustment
    ON adjustment.run_initialized_at >= requested.start_inclusive
    AND adjustment.run_initialized_at < requested.end_exclusive
)
SELECT * FROM temperature_runs
UNION ALL
SELECT * FROM temperature_hours
UNION ALL
SELECT * FROM target_revision_diagnostics
UNION ALL
SELECT * FROM rain_claims
UNION ALL
SELECT * FROM rain_receipts
UNION ALL
SELECT * FROM rain_adjustment;

-- publish only immutable query and migration identity
CREATE VIEW adjustment_evaluation_export_manifest_v1
WITH (security_barrier = true)
AS
SELECT
  'adjustment-evaluation-export-manifest/v1'::text AS contract_version,
  '0017_adjustment_evaluation_export.sql'::text AS schema_migration,
  'adjustment-evaluation-export-query/v1'::text AS query_contract_version,
  'ballydidean'::text AS site_key,
  'America/Los_Angeles'::text AS site_timezone,
  'c21782034130d003e4af48fada4c8f6545f6f1c4dff550f92d0523c7d96d20e2'::char(64)
    AS row_schema_sha256,
  'c860039c72818a9b813ed9f9d93f5d8e115f4144e99d698734e9159ca3457bd4'::char(64)
    AS query_contract_sha256,
  array_agg(schema_migrations.name ORDER BY schema_migrations.name) AS migration_names,
  array_agg(schema_migrations.checksum::text ORDER BY schema_migrations.name)
    AS migration_checksums,
  encode(sha256(convert_to(
    string_agg(
      schema_migrations.name || ':' || schema_migrations.checksum,
      E'\n' ORDER BY schema_migrations.name
    ),
    'UTF8'
  )), 'hex')::char(64) AS migration_history_sha256
FROM schema_migrations;

REVOKE ALL ON adjustment_evaluation_export_rows_v1 FROM PUBLIC;
REVOKE ALL ON adjustment_evaluation_export_manifest_v1 FROM PUBLIC;
REVOKE ALL ON adjustment_evaluation_export_rows_v1 FROM weather_api, weather_ingest;
REVOKE ALL ON adjustment_evaluation_export_manifest_v1 FROM weather_api, weather_ingest;
GRANT SELECT ON adjustment_evaluation_export_rows_v1 TO weather_training_export;
GRANT SELECT ON adjustment_evaluation_export_manifest_v1 TO weather_training_export;
