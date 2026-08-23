CREATE FUNCTION weather_source_is_current(candidate_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.sources candidate
    JOIN public.sources successor
      ON successor.station_id = candidate.station_id
      AND successor.active
      AND successor.material_provider_config->>'supersedesSourceKey' = candidate.source_key
    WHERE candidate.id = candidate_id
  );
$function$;

REVOKE ALL ON FUNCTION weather_source_is_current(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION weather_source_is_current(bigint)
TO weather_api, weather_ingest;
