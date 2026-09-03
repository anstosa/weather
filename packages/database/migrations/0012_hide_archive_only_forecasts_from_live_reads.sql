-- hide archive-only forecasts from legacy live reads
CREATE OR REPLACE FUNCTION weather_source_is_current(candidate_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.sources candidate
    WHERE candidate.id = candidate_id
      AND (
        (
          candidate.source_kind = 'forecast'
          AND candidate.cadence_seconds IS NULL
          AND candidate.capabilities @> '["historical"]'::jsonb
          AND NOT (candidate.capabilities @> '["forecast"]'::jsonb)
        )
        OR EXISTS (
          SELECT 1
          FROM public.sources successor
          WHERE successor.station_id = candidate.station_id
            AND successor.active
            AND successor.material_provider_config->>'supersedesSourceKey' =
              candidate.source_key
        )
      )
  );
$function$;
