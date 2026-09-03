CREATE VIEW forecast_training_export_rows_v1
WITH (security_barrier = true)
AS
WITH
-- read only the transaction-local exporter bounds
raw_requested_range AS MATERIALIZED (
  SELECT
    current_setting('weather.forecast_training_from_date', true) AS from_text,
    current_setting('weather.forecast_training_to_date', true) AS to_text
),
-- parse only after retaining the exact setting bytes
parsed_requested_range AS MATERIALIZED (
  SELECT
    from_text,
    to_text,
    from_text::date AS from_date,
    to_text::date AS to_date
  FROM raw_requested_range
),
-- force missing, reversed, and oversized ranges to fail closed
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
          AND to_date - from_date BETWEEN 0 AND 449
        )::integer
      ) - 1
    ) AS from_date,
    to_date
  FROM parsed_requested_range
),
-- derive DST-aware bounds from each local calendar date
requested_days AS MATERIALIZED (
  SELECT
    local_date::date AS local_date,
    local_date::timestamp AT TIME ZONE 'America/Los_Angeles' AS day_start,
    (local_date::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles' AS day_end
  FROM validated_range
  CROSS JOIN LATERAL generate_series(
    validated_range.from_date,
    validated_range.to_date,
    INTERVAL '1 day'
  ) AS requested(local_date)
)
SELECT daily_rows.*
FROM requested_days requested_day
-- evaluate the frozen row contract one local date at a time
CROSS JOIN LATERAL (
WITH
station_manifest(physical_station_key, provider_family) AS (
  VALUES
    ('ambient-maxweather'::varchar(80), 'ambient'::varchar(32)),
    ('ambient-merlin'::varchar(80), 'ambient'::varchar(32)),
    ('ballydidean-ecowitt'::varchar(80), 'ecowitt'::varchar(32)),
    ('netatmo-nearby'::varchar(80), 'netatmo'::varchar(32)),
    ('tempest-126537'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-168853'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-201058'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-203055'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-225947'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-38270'::varchar(80), 'tempest'::varchar(32)),
    ('tempest-64255'::varchar(80), 'tempest'::varchar(32))
),
source_lineage(
  physical_station_key,
  source_key,
  source_config_fingerprint,
  adapter_contract,
  accepted_start,
  accepted_end,
  quality_rule
) AS (
  VALUES
    ('ambient-maxweather', 'ambient-maxweather-observations-v1',
      '7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4',
      'ambient-device-data/v1', TIMESTAMPTZ '2026-08-24 00:00:00+00', NULL, 'absent'),
    ('ambient-merlin', 'ambient-merlin-observations-v1',
      'c3829701bfc25a050022dc3965569d3a87376e8a43b5fdcb7621533f1ae3c65d',
      'ambient-device-data/v1', TIMESTAMPTZ '2021-01-01 00:00:00+00', NULL, 'absent'),
    ('ballydidean-ecowitt', 'ecowitt-88f15505d89f-local-live-v1',
      '0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d',
      'ecowitt-local-live/v1', NULL, NULL, 'absent'),
    ('netatmo-nearby', 'netatmo-nearby-observations-v1',
      '5495917dd2465a32d9878e73c68781a229b432901cdc4867875726351efbdbbc',
      'netatmo-public-measures/v1', TIMESTAMPTZ '2022-06-21 00:00:00+00', NULL, 'absent'),
    ('tempest-126537', 'tempest-126537-observations-v2',
      '34dafbd6584c93d55ed4d3d43dc7e74a0876165d4ddfc921413f7b826dff7ab7',
      'tempest-observations/v2', TIMESTAMPTZ '2023-12-17 00:00:00+00', NULL, 'tempest'),
    ('tempest-168853', 'tempest-168853-observations-v2',
      '1c7a402337a44a5441775246cbc02da7994599dad6ab83dc04b248303facfea5',
      'tempest-observations/v2', TIMESTAMPTZ '2025-01-22 00:00:00+00', NULL, 'tempest'),
    ('tempest-201058', 'tempest-201058-observations-v2',
      'a61cce798cddf682da9608dc245659fc7734a6d5304068939d3115ae7d81a50e',
      'tempest-observations/v2', TIMESTAMPTZ '2025-12-22 00:00:00+00', NULL, 'tempest'),
    ('tempest-203055', 'tempest-203055-observations-v2',
      '9ead4c5359a6a9640f334be91397180aa62b90b0f0ce813b9ff26fe84537acc4',
      'tempest-observations/v2', TIMESTAMPTZ '2025-12-25 00:00:00+00', NULL, 'tempest'),
    ('tempest-225947', 'tempest-225947-observations-v2',
      'b4dd6105d9a56a7c5d0dc4063f830e1cf28d693222a8de15536dd83d3a6178c4',
      'tempest-observations/v2', TIMESTAMPTZ '2026-07-14 00:00:00+00', NULL, 'tempest'),
    ('tempest-38270', 'tempest-38270-observations-v2',
      'ce162067aced4ab3522fb83145a21e608ff24dec189097726188e96fd6cca52f',
      'tempest-observations/v2', TIMESTAMPTZ '2021-01-04 00:00:00+00', NULL, 'tempest'),
    ('tempest-64255', 'tempest-64255-observations-v2',
      '8eb488a358375fc3526347d9ef6c9f23080095a22ea874a42ec400b0317d868a',
      'tempest-observations/v2', TIMESTAMPTZ '2021-12-10 00:00:00+00', NULL, 'tempest'),
    ('ambient-maxweather', 'wunderground-maxweather-history-v1',
      '52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c',
      'wunderground-pws-history/v1', TIMESTAMPTZ '2024-11-29 00:00:00+00',
      TIMESTAMPTZ '2026-08-24 00:00:00+00', 'wunderground')
),
excluded_source_lineage(physical_station_key, source_key) AS (
  VALUES
    ('tempest-126537', 'tempest-126537-observations-v1'),
    ('tempest-168853', 'tempest-168853-observations-v1'),
    ('tempest-201058', 'tempest-201058-observations-v1'),
    ('tempest-203055', 'tempest-203055-observations-v1'),
    ('tempest-225947', 'tempest-225947-observations-v1'),
    ('tempest-38270', 'tempest-38270-observations-v1'),
    ('tempest-64255', 'tempest-64255-observations-v1')
),
candidate_source_keys(physical_station_key, source_key) AS (
  SELECT physical_station_key, source_key
  FROM source_lineage
  UNION
  SELECT physical_station_key, source_key
  FROM excluded_source_lineage
),
-- freeze the finite accepted and explicitly rejected source catalog
configured_station_sources AS MATERIALIZED (
  SELECT
    source.id AS source_id,
    station.slug::varchar(80) AS physical_station_key,
    station_manifest.provider_family,
    source.source_key,
    source.source_config_fingerprint::text AS source_config_fingerprint,
    source.material_provider_config
  FROM candidate_source_keys candidate_source
  JOIN station_manifest
    ON station_manifest.physical_station_key = candidate_source.physical_station_key
  JOIN sites site ON site.slug = 'ballydidean'
  JOIN stations station
    ON station.site_id = site.id
    AND station.slug = candidate_source.physical_station_key
  JOIN sources source
    ON source.station_id = station.id
    AND source.source_key = candidate_source.source_key
    AND source.source_kind = 'physical_sensor'
),
-- retain only the daily lookback needed by hourly metrics
station_candidate_rows AS MATERIALIZED (
  SELECT
    wr.id,
    configured_source.physical_station_key,
    configured_source.provider_family,
    configured_source.source_key,
    configured_source.source_config_fingerprint,
    lineage.adapter_contract,
    wr.valid_at,
    wr.last_received_at,
    wr.last_ingestion_run_id,
    wr.content_hash::text AS content_hash,
    wr.temperature_c,
    wr.relative_humidity_percent,
    wr.wind_speed_mps,
    wr.wind_gust_mps,
    wr.wind_direction_degrees,
    CASE
      WHEN excluded.source_key IS NOT NULL THEN 'source_superseded'
      WHEN lineage.source_key IS NULL
        OR lineage.source_config_fingerprint IS DISTINCT FROM
          configured_source.source_config_fingerprint
        OR lineage.adapter_contract IS DISTINCT FROM
          configured_source.material_provider_config ->> 'contractVersion'
        THEN 'source_superseded'
      WHEN (lineage.accepted_start IS NOT NULL AND wr.valid_at < lineage.accepted_start)
        OR (lineage.accepted_end IS NOT NULL AND wr.valid_at >= lineage.accepted_end)
        THEN 'source_interval_out_of_range'
      WHEN lineage.quality_rule = 'wunderground'
        AND coalesce(wr.quality_metadata, '{}'::jsonb) ? 'status'
        AND coalesce(wr.quality_metadata, '{}'::jsonb) ->> 'status' IS DISTINCT FROM
          'provider_qc_1'
        THEN 'quality_status_rejected'
      WHEN lineage.quality_rule <> 'wunderground'
        AND coalesce(wr.quality_metadata, '{}'::jsonb) ? 'status'
        THEN 'quality_status_rejected'
      WHEN coalesce(wr.quality_metadata, '{}'::jsonb) ? 'flags'
        AND CASE
          WHEN jsonb_typeof(coalesce(wr.quality_metadata, '{}'::jsonb) -> 'flags')
            <> 'array' THEN true
          WHEN lineage.quality_rule = 'tempest' THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              coalesce(wr.quality_metadata, '{}'::jsonb) -> 'flags'
            ) AS flag(value)
            WHERE flag.value <> 'uv_index_out_of_range'
          )
          ELSE jsonb_array_length(
            coalesce(wr.quality_metadata, '{}'::jsonb) -> 'flags'
          ) <> 0
        END
        THEN 'quality_flag_rejected'
      ELSE NULL
    END::text AS exclusion_reason
  FROM configured_station_sources configured_source
  JOIN weather_records wr
    ON wr.source_id = configured_source.source_id
    AND wr.valid_at >= requested_day.day_start - INTERVAL '1 hour'
    AND wr.valid_at < requested_day.day_end
  LEFT JOIN source_lineage lineage
    ON lineage.source_key = configured_source.source_key
    AND lineage.physical_station_key = configured_source.physical_station_key
  LEFT JOIN excluded_source_lineage excluded
    ON excluded.source_key = configured_source.source_key
    AND excluded.physical_station_key = configured_source.physical_station_key
),
eligible_station_rows AS (
  SELECT
    id,
    physical_station_key,
    provider_family,
    source_key,
    source_config_fingerprint,
    adapter_contract,
    valid_at,
    last_received_at,
    last_ingestion_run_id,
    content_hash,
    temperature_c,
    relative_humidity_percent,
    wind_speed_mps,
    wind_gust_mps,
    wind_direction_degrees
  FROM station_candidate_rows
  WHERE exclusion_reason IS NULL
),
-- generate only the requested local date's 23 to 25 hours
station_hours AS MATERIALIZED (
  SELECT
    station_manifest.physical_station_key,
    station_manifest.provider_family,
    hour.valid_at
  FROM station_manifest
  CROSS JOIN LATERAL generate_series(
    requested_day.day_start,
    requested_day.day_end - INTERVAL '1 hour',
    INTERVAL '1 hour'
  ) AS hour(valid_at)
),
rejected_station_reasons AS (
  SELECT
    station_hours.physical_station_key,
    station_hours.valid_at AS hour_valid_at,
    array_agg(
      DISTINCT candidate.exclusion_reason ORDER BY candidate.exclusion_reason
    ) AS exclusion_reason_codes
  FROM station_hours
  JOIN station_candidate_rows candidate
    ON candidate.physical_station_key = station_hours.physical_station_key
    AND candidate.exclusion_reason IS NOT NULL
    AND (
      (
        candidate.wind_gust_mps IS NOT NULL
        AND candidate.valid_at > station_hours.valid_at - INTERVAL '1 hour'
        AND candidate.valid_at <= station_hours.valid_at
      )
      OR (
        num_nonnulls(
          candidate.temperature_c,
          candidate.relative_humidity_percent,
          candidate.wind_speed_mps,
          candidate.wind_direction_degrees
        ) > 0
        AND candidate.valid_at >= station_hours.valid_at - INTERVAL '5 minutes'
        AND candidate.valid_at < station_hours.valid_at + INTERVAL '5 minutes'
      )
    )
  GROUP BY station_hours.physical_station_key, station_hours.valid_at
),
station_direction_diagnostics AS (
  SELECT DISTINCT
    station_hours.physical_station_key,
    station_hours.valid_at AS hour_valid_at
  FROM station_hours
  JOIN eligible_station_rows eligible
    ON eligible.physical_station_key = station_hours.physical_station_key
    AND eligible.valid_at >= station_hours.valid_at - INTERVAL '5 minutes'
    AND eligible.valid_at < station_hours.valid_at + INTERVAL '5 minutes'
    AND eligible.wind_direction_degrees IS NOT NULL
    AND (eligible.wind_speed_mps IS NULL OR eligible.wind_speed_mps < 1)
),
instant_candidates AS (
  SELECT
    station_hours.physical_station_key,
    station_hours.provider_family,
    station_hours.valid_at AS hour_valid_at,
    metric.name AS metric_name,
    metric.value AS metric_value,
    eligible.id,
    eligible.source_key,
    eligible.source_config_fingerprint,
    eligible.adapter_contract,
    eligible.valid_at,
    eligible.last_received_at,
    eligible.last_ingestion_run_id,
    eligible.content_hash,
    row_number() OVER (
      PARTITION BY station_hours.physical_station_key, station_hours.valid_at, metric.name
      ORDER BY
        abs(extract(epoch FROM eligible.valid_at - station_hours.valid_at)),
        eligible.valid_at,
        eligible.id
    ) AS candidate_rank
  FROM station_hours
  JOIN eligible_station_rows eligible
    ON eligible.physical_station_key = station_hours.physical_station_key
    AND eligible.valid_at >= station_hours.valid_at - INTERVAL '5 minutes'
    AND eligible.valid_at < station_hours.valid_at + INTERVAL '5 minutes'
  CROSS JOIN LATERAL (
    VALUES
      ('temperature_c', eligible.temperature_c),
      ('relative_humidity_percent', eligible.relative_humidity_percent),
      ('wind_speed_mps', eligible.wind_speed_mps),
      ('wind_direction_degrees', CASE
        WHEN eligible.wind_speed_mps >= 1 THEN eligible.wind_direction_degrees
        ELSE NULL
      END)
  ) AS metric(name, value)
  WHERE metric.value IS NOT NULL
),
instant_metrics AS (
  SELECT
    physical_station_key,
    hour_valid_at,
    max(metric_value) FILTER (WHERE metric_name = 'temperature_c') AS temperature_c,
    max(metric_value) FILTER (WHERE metric_name = 'relative_humidity_percent')
      AS relative_humidity_percent,
    max(metric_value) FILTER (WHERE metric_name = 'wind_speed_mps') AS wind_speed_mps,
    max(metric_value) FILTER (WHERE metric_name = 'wind_direction_degrees')
      AS wind_direction_degrees
  FROM instant_candidates
  WHERE candidate_rank = 1
  GROUP BY physical_station_key, hour_valid_at
),
gust_ordered AS (
  SELECT
    station_hours.physical_station_key,
    station_hours.valid_at AS hour_valid_at,
    eligible.id,
    eligible.source_key,
    eligible.source_config_fingerprint,
    eligible.adapter_contract,
    eligible.valid_at,
    eligible.last_received_at,
    eligible.last_ingestion_run_id,
    eligible.content_hash,
    eligible.wind_gust_mps,
    eligible.valid_at - lag(eligible.valid_at) OVER (
      PARTITION BY station_hours.physical_station_key, station_hours.valid_at
      ORDER BY eligible.valid_at, eligible.id
    ) AS preceding_gap
  FROM station_hours
  JOIN eligible_station_rows eligible
    ON eligible.physical_station_key = station_hours.physical_station_key
    AND eligible.valid_at > station_hours.valid_at - INTERVAL '1 hour'
    AND eligible.valid_at <= station_hours.valid_at
    AND eligible.wind_gust_mps IS NOT NULL
),
gust_metrics AS (
  SELECT
    physical_station_key,
    hour_valid_at,
    CASE
      WHEN min(valid_at) - (hour_valid_at - INTERVAL '1 hour') <= INTERVAL '10 minutes'
        AND hour_valid_at - max(valid_at) <= INTERVAL '10 minutes'
        AND coalesce(max(preceding_gap), INTERVAL '0') <= INTERVAL '10 minutes'
        THEN max(wind_gust_mps)
      ELSE NULL
    END AS wind_gust_mps,
    min(valid_at) - (hour_valid_at - INTERVAL '1 hour') <= INTERVAL '10 minutes'
      AND hour_valid_at - max(valid_at) <= INTERVAL '10 minutes'
      AND coalesce(max(preceding_gap), INTERVAL '0') <= INTERVAL '10 minutes'
      AS coverage_complete
  FROM gust_ordered
  GROUP BY physical_station_key, hour_valid_at
),
collision_counts AS (
  SELECT physical_station_key, hour_valid_at, sum(collision_count)::integer AS collision_count
  FROM (
    SELECT
      station_hours.physical_station_key,
      station_hours.valid_at AS hour_valid_at,
      metric.name,
      eligible.valid_at,
      count(*) - 1 AS collision_count
    FROM station_hours
    JOIN eligible_station_rows eligible
      ON eligible.physical_station_key = station_hours.physical_station_key
      AND eligible.valid_at > station_hours.valid_at - INTERVAL '1 hour'
      AND eligible.valid_at < station_hours.valid_at + INTERVAL '5 minutes'
    CROSS JOIN LATERAL (
      VALUES
        ('temperature_c', eligible.temperature_c),
        ('relative_humidity_percent', eligible.relative_humidity_percent),
        ('wind_speed_mps', eligible.wind_speed_mps),
        ('wind_gust_mps', eligible.wind_gust_mps),
        ('wind_direction_degrees', CASE
          WHEN eligible.wind_speed_mps >= 1 THEN eligible.wind_direction_degrees
          ELSE NULL
        END)
    ) AS metric(name, value)
    WHERE metric.value IS NOT NULL
      AND (
        (
          metric.name = 'wind_gust_mps'
          AND eligible.valid_at > station_hours.valid_at - INTERVAL '1 hour'
          AND eligible.valid_at <= station_hours.valid_at
        )
        OR (
          metric.name <> 'wind_gust_mps'
          AND eligible.valid_at >= station_hours.valid_at - INTERVAL '5 minutes'
          AND eligible.valid_at < station_hours.valid_at + INTERVAL '5 minutes'
        )
      )
    GROUP BY
      station_hours.physical_station_key,
      station_hours.valid_at,
      metric.name,
      eligible.valid_at
    HAVING count(*) > 1
  ) collisions
  GROUP BY physical_station_key, hour_valid_at
),
selected_station_records AS (
  SELECT
    physical_station_key,
    hour_valid_at,
    source_key,
    source_config_fingerprint,
    adapter_contract,
    last_received_at,
    last_ingestion_run_id,
    content_hash
  FROM instant_candidates
  WHERE candidate_rank = 1
  UNION
  SELECT
    gust.physical_station_key,
    gust.hour_valid_at,
    gust.source_key,
    gust.source_config_fingerprint,
    gust.adapter_contract,
    gust.last_received_at,
    gust.last_ingestion_run_id,
    gust.content_hash
  FROM gust_ordered gust
  JOIN gust_metrics
    ON gust_metrics.physical_station_key = gust.physical_station_key
    AND gust_metrics.hour_valid_at = gust.hour_valid_at
    AND gust_metrics.coverage_complete
),
station_source_identities AS (
  SELECT DISTINCT
    physical_station_key,
    hour_valid_at,
    source_key,
    source_config_fingerprint,
    adapter_contract
  FROM selected_station_records
),
station_source_provenance AS (
  SELECT
    physical_station_key,
    hour_valid_at,
    array_agg(source_key ORDER BY source_key) AS source_keys,
    array_agg(source_config_fingerprint ORDER BY source_key)
      AS source_config_fingerprints,
    array_agg(adapter_contract ORDER BY source_key) AS adapter_contracts
  FROM station_source_identities
  GROUP BY physical_station_key, hour_valid_at
),
station_record_provenance AS (
  SELECT
    physical_station_key,
    hour_valid_at,
    max(last_received_at) AS received_at,
    array_agg(DISTINCT last_ingestion_run_id ORDER BY last_ingestion_run_id)::text[]
      AS ingestion_run_ids,
    array_agg(DISTINCT content_hash ORDER BY content_hash) AS content_hashes
  FROM selected_station_records
  GROUP BY physical_station_key, hour_valid_at
),
-- isolate the one configured live forecast source before reading records
configured_forecast_source AS MATERIALIZED (
  SELECT
    source.id AS source_id,
    source.source_key,
    source.source_config_fingerprint::text AS source_config_fingerprint,
    source.material_provider_config,
    site.slug::varchar(80) AS site_key
  FROM sites site
  JOIN stations station ON station.site_id = site.id
  JOIN sources source ON source.station_id = station.id
  WHERE site.slug = 'ballydidean'
    AND source.source_key = 'open-meteo-forecast-v4'
    AND source.source_kind = 'forecast'
    AND source.capabilities @> '["forecast"]'::jsonb
),
forecast_rows AS (
  SELECT
    'legacy_v4_retrieval_snapshot'::varchar(32) AS record_kind,
    configured_source.site_key,
    NULL::varchar(80) AS physical_station_key,
    NULL::varchar(32) AS provider_family,
    ARRAY[configured_source.source_key::text] AS source_keys,
    ARRAY[configured_source.source_config_fingerprint] AS source_config_fingerprints,
    ARRAY[(configured_source.material_provider_config ->> 'contractVersion')]::text[]
      AS adapter_contracts,
    wr.valid_at,
    wr.product_run_at AS reference_at,
    wr.last_received_at AS received_at,
    'retrieval_snapshot'::varchar(32) AS reference_kind,
    ceil(extract(epoch FROM wr.valid_at - wr.product_run_at) / 3600)::smallint
      AS target_lead_hours,
    (wr.provider_metadata ->> 'dataset')::varchar(64) AS dataset,
    wr.upstream_model::varchar(128) AS upstream_model,
    ('legacy-v4/' || encode(sha256(
      convert_to(last_run.adapter_version, 'UTF8')
      || decode('00', 'hex')
      || convert_to(configured_source.source_config_fingerprint, 'UTF8')
    ), 'hex'))::varchar(128) AS contract_epoch,
    wr.temperature_c,
    wr.relative_humidity_percent,
    wr.wind_speed_mps,
    wr.wind_gust_mps,
    wr.wind_direction_degrees,
    ARRAY[wr.last_ingestion_run_id::text] AS ingestion_run_ids,
    ARRAY[wr.content_hash::text] AS content_hashes,
    ARRAY[]::text[] AS exclusion_reason_codes,
    0::integer AS collision_count
  FROM configured_forecast_source configured_source
  JOIN weather_records wr
    ON wr.source_id = configured_source.source_id
    AND wr.valid_at >= requested_day.day_start
    AND wr.valid_at < requested_day.day_end
  JOIN ingestion_runs last_run ON last_run.id = wr.last_ingestion_run_id
  WHERE wr.product_run_at IS NOT NULL
    AND wr.product_run_at <= wr.valid_at
    AND wr.provider_metadata ->> 'dataset' IS NOT NULL
    AND wr.upstream_model IS NOT NULL
    AND ceil(extract(epoch FROM wr.valid_at - wr.product_run_at) / 3600)
      BETWEEN 1 AND 168
),
-- isolate the one configured historical source before reading anchors
configured_anchor_source AS MATERIALIZED (
  SELECT
    source.id AS source_id,
    source.source_key,
    source.material_provider_config,
    site.slug::varchar(80) AS site_key
  FROM sites site
  JOIN stations station ON station.site_id = site.id
  JOIN sources source ON source.station_id = station.id
  WHERE site.slug = 'ballydidean'
    AND source.source_key = 'open-meteo-previous-runs-v1'
    AND source.source_kind = 'forecast'
    AND source.capabilities @> '["historical"]'::jsonb
),
anchor_rows AS (
  SELECT
    'fixed_lead_anchor'::varchar(32) AS record_kind,
    configured_source.site_key,
    NULL::varchar(80) AS physical_station_key,
    NULL::varchar(32) AS provider_family,
    ARRAY[configured_source.source_key::text] AS source_keys,
    ARRAY[far.source_config_fingerprint::text] AS source_config_fingerprints,
    ARRAY[(configured_source.material_provider_config ->> 'contractVersion')]::text[]
      AS adapter_contracts,
    far.valid_at,
    NULL::timestamptz AS reference_at,
    far.last_received_at AS received_at,
    'fixed_lead_anchor'::varchar(32) AS reference_kind,
    far.lead_hours AS target_lead_hours,
    far.dataset::varchar(64) AS dataset,
    far.upstream_model::varchar(128) AS upstream_model,
    far.contract_epoch::varchar(128) AS contract_epoch,
    far.temperature_c,
    far.relative_humidity_percent,
    far.wind_speed_mps,
    far.wind_gust_mps,
    far.wind_direction_degrees,
    array_agg(DISTINCT runs.run_id ORDER BY runs.run_id)::text[]
      AS ingestion_run_ids,
    ARRAY[far.content_hash::text] AS content_hashes,
    ARRAY[]::text[] AS exclusion_reason_codes,
    0::integer AS collision_count
  FROM configured_anchor_source configured_source
  JOIN forecast_anchor_records far
    ON far.source_id = configured_source.source_id
    AND far.valid_at >= requested_day.day_start
    AND far.valid_at < requested_day.day_end
  CROSS JOIN LATERAL (
    VALUES (far.first_ingestion_run_id), (far.last_ingestion_run_id)
  ) AS runs(run_id)
  GROUP BY
    far.id,
    configured_source.source_key,
    configured_source.material_provider_config,
    configured_source.site_key
),
station_rows AS (
  SELECT
    'station_hour'::varchar(32) AS record_kind,
    'ballydidean'::varchar(80) AS site_key,
    station_hours.physical_station_key,
    station_hours.provider_family,
    coalesce(station_source_provenance.source_keys, ARRAY[]::text[]) AS source_keys,
    coalesce(station_source_provenance.source_config_fingerprints, ARRAY[]::text[])
      AS source_config_fingerprints,
    coalesce(station_source_provenance.adapter_contracts, ARRAY[]::text[])
      AS adapter_contracts,
    station_hours.valid_at,
    NULL::timestamptz AS reference_at,
    station_record_provenance.received_at,
    NULL::varchar(32) AS reference_kind,
    NULL::smallint AS target_lead_hours,
    NULL::varchar(64) AS dataset,
    NULL::varchar(128) AS upstream_model,
    'physical-station-hourly/v1'::varchar(128) AS contract_epoch,
    instant_metrics.temperature_c,
    instant_metrics.relative_humidity_percent,
    instant_metrics.wind_speed_mps,
    gust_metrics.wind_gust_mps,
    instant_metrics.wind_direction_degrees,
    coalesce(station_record_provenance.ingestion_run_ids, ARRAY[]::text[])
      AS ingestion_run_ids,
    coalesce(station_record_provenance.content_hashes, ARRAY[]::text[])
      AS content_hashes,
    ARRAY(
      SELECT DISTINCT reason
      FROM unnest(
        coalesce(rejected.exclusion_reason_codes, ARRAY[]::text[])
        || array_remove(ARRAY[
          CASE
            WHEN num_nonnulls(
              instant_metrics.temperature_c,
              instant_metrics.relative_humidity_percent,
              instant_metrics.wind_speed_mps,
              gust_metrics.wind_gust_mps,
              instant_metrics.wind_direction_degrees
            ) < 5 THEN 'metric_missing'
          END,
          CASE
            WHEN num_nonnulls(
              instant_metrics.temperature_c,
              instant_metrics.relative_humidity_percent,
              instant_metrics.wind_speed_mps,
              gust_metrics.wind_gust_mps,
              instant_metrics.wind_direction_degrees
            ) = 0 THEN 'station_coverage_insufficient'
          END,
          CASE
            WHEN direction.physical_station_key IS NOT NULL
              THEN 'station_direction_calm'
          END,
          CASE
            WHEN gust_metrics.physical_station_key IS NOT NULL
              AND NOT gust_metrics.coverage_complete
              THEN 'station_gust_coverage_incomplete'
          END
        ], NULL)::text[]
      ) AS diagnostic(reason)
      ORDER BY reason
    )::text[] AS exclusion_reason_codes,
    coalesce(collision_counts.collision_count, 0)::integer AS collision_count
  FROM station_hours
  LEFT JOIN instant_metrics
    ON instant_metrics.physical_station_key = station_hours.physical_station_key
    AND instant_metrics.hour_valid_at = station_hours.valid_at
  LEFT JOIN gust_metrics
    ON gust_metrics.physical_station_key = station_hours.physical_station_key
    AND gust_metrics.hour_valid_at = station_hours.valid_at
  LEFT JOIN station_source_provenance
    ON station_source_provenance.physical_station_key = station_hours.physical_station_key
    AND station_source_provenance.hour_valid_at = station_hours.valid_at
  LEFT JOIN station_record_provenance
    ON station_record_provenance.physical_station_key = station_hours.physical_station_key
    AND station_record_provenance.hour_valid_at = station_hours.valid_at
  LEFT JOIN collision_counts
    ON collision_counts.physical_station_key = station_hours.physical_station_key
    AND collision_counts.hour_valid_at = station_hours.valid_at
  LEFT JOIN rejected_station_reasons rejected
    ON rejected.physical_station_key = station_hours.physical_station_key
    AND rejected.hour_valid_at = station_hours.valid_at
  LEFT JOIN station_direction_diagnostics direction
    ON direction.physical_station_key = station_hours.physical_station_key
    AND direction.hour_valid_at = station_hours.valid_at
)
SELECT * FROM forecast_rows
UNION ALL
SELECT * FROM anchor_rows
UNION ALL
SELECT * FROM station_rows
) AS daily_rows
WHERE daily_rows.valid_at >= requested_day.day_start
  AND daily_rows.valid_at < requested_day.day_end;

CREATE VIEW forecast_training_export_manifest_v1
WITH (security_barrier = true)
AS
SELECT
  'forecast-training-export-manifest/v1'::text AS contract_version,
  '0010_forecast_training_export.sql'::text AS schema_migration,
  'forecast-training-export-query/v2'::text AS query_contract_version,
  'ballydidean'::varchar(80) AS site_key,
  'America/Los_Angeles'::varchar(64) AS site_timezone,
  '2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc'::char(64)
    AS row_schema_sha256,
  '3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76'::char(64)
    AS query_contract_sha256,
  'a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49'::char(64)
    AS station_manifest_sha256,
  '261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc'::char(64)
    AS source_lineage_sha256,
  '53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e'::char(64)
    AS metric_eligibility_sha256,
  '04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58'::char(64)
    AS coordinate_manifest_sha256,
  '8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74'::char(64)
    AS spatial_weights_sha256,
  '9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64'::char(64)
    AS aggregation_contract_sha256,
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

REVOKE ALL ON forecast_training_export_rows_v1 FROM PUBLIC;
REVOKE ALL ON forecast_training_export_manifest_v1 FROM PUBLIC;
REVOKE ALL ON forecast_training_export_rows_v1 FROM weather_api, weather_ingest;
REVOKE ALL ON forecast_training_export_manifest_v1 FROM weather_api, weather_ingest;
GRANT SELECT ON forecast_training_export_rows_v1 TO weather_training_export;
GRANT SELECT ON forecast_training_export_manifest_v1 TO weather_training_export;

-- remove inherited execution from application-owned and reachable definers
DO $$
DECLARE
  application_function record;
BEGIN
  -- enumerate only non-system application function identities
  FOR application_function IN
    SELECT procedure.oid::regprocedure AS identity
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND (
        procedure.proowner = current_user::regrole
        OR (
          procedure.prosecdef
          AND (
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
      )
    ORDER BY namespace.nspname, procedure.oid::regprocedure::text
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, weather_api, weather_ingest, weather_training_export',
      application_function.identity
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION weather_source_is_current(bigint)
TO weather_api, weather_ingest;
GRANT EXECUTE ON FUNCTION weather_json_object_keys_allowed(jsonb, text[])
TO weather_ingest;

ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
