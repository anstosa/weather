-- publish only bounded rain predictions while retaining private capture evidence
CREATE TABLE rain_adjustment_runs (
  run_initialized_at timestamptz NOT NULL,
  model_sha256 char(64) NOT NULL CHECK (model_sha256 ~ '^[a-f0-9]{64}$'),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  forecast_claim_id uuid NOT NULL REFERENCES rain_capture_claims(id),
  first_received_at timestamptz NOT NULL,
  decision_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  hours jsonb NOT NULL CHECK (jsonb_typeof(hours) = 'array'
    AND jsonb_array_length(hours) BETWEEN 1 AND 23
    AND octet_length(hours::text) <= 16384),
  PRIMARY KEY (run_initialized_at, model_sha256),
  CHECK (date_trunc('hour', run_initialized_at) = run_initialized_at
    AND extract(hour FROM run_initialized_at AT TIME ZONE 'UTC')::integer % 6 = 0
    AND decision_at = run_initialized_at + interval '8 hours'
    AND first_received_at <= decision_at)
);

-- reject unbound forecasts, invalid hours, and mutation of saved inference
CREATE FUNCTION weather_guard_rain_adjustment_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
DECLARE horizon integer;
DECLARE seen integer[] := ARRAY[]::integer[];
BEGIN
  NEW.generated_at := clock_timestamp();
  -- require actual earlier retained source availability
  IF NEW.decision_at > NEW.generated_at OR NOT EXISTS (
    SELECT 1 FROM rain_capture_claims c JOIN rain_capture_receipts r ON r.claim_id = c.id
    WHERE c.id = NEW.forecast_claim_id AND c.kind = 'forecast'
      AND c.run_initialized_at = NEW.run_initialized_at AND r.outcome = 'valid'
      AND r.available_by_decision IS TRUE AND r.completed_at = NEW.first_received_at
  ) THEN
    RAISE EXCEPTION 'rain adjustment source is unavailable' USING ERRCODE = '23514';
  END IF;
  -- constrain the public projection to original hourly model outputs
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.hours) LOOP
    horizon := (item->>'modelLeadHours')::integer;
    IF coalesce((jsonb_typeof(item) <> 'object' OR NOT (item ?& ARRAY[
        'validAt', 'modelLeadHours', 'rawPrecipitationMm', 'correctedPrecipitationMm', 'applied', 'reasonCode'])
      OR item - ARRAY['validAt', 'modelLeadHours', 'rawPrecipitationMm', 'correctedPrecipitationMm', 'applied', 'reasonCode'] <> '{}'::jsonb
      OR horizon NOT BETWEEN 9 AND 31 OR horizon = ANY(seen)
      OR (item->>'validAt')::timestamptz IS DISTINCT FROM NEW.run_initialized_at + horizon * interval '1 hour'
      OR jsonb_typeof(item->'rawPrecipitationMm') <> 'number'
      OR (item->>'rawPrecipitationMm')::numeric NOT BETWEEN 0 AND 2000
      OR jsonb_typeof(item->'correctedPrecipitationMm') <> 'number'
      OR (item->>'correctedPrecipitationMm')::numeric NOT BETWEEN 0 AND 2000
      OR jsonb_typeof(item->'applied') <> 'boolean'
      OR ((item->>'applied')::boolean AND ((item->>'correctedPrecipitationMm')::numeric > 30
        OR item->'reasonCode' <> 'null'::jsonb))
      OR (NOT (item->>'applied')::boolean AND (item->'rawPrecipitationMm' <> item->'correctedPrecipitationMm'
        OR jsonb_typeof(item->'reasonCode') <> 'string'))), true) THEN
      RAISE EXCEPTION 'rain adjustment hour is invalid' USING ERRCODE = '23514';
    END IF;
    seen := array_append(seen, horizon);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rain_adjustment_runs_guard_insert BEFORE INSERT ON rain_adjustment_runs
FOR EACH ROW EXECUTE FUNCTION weather_guard_rain_adjustment_run();
CREATE TRIGGER rain_adjustment_runs_immutable BEFORE UPDATE OR DELETE ON rain_adjustment_runs
FOR EACH ROW EXECUTE FUNCTION weather_reject_rain_capture_mutation();
REVOKE ALL ON rain_adjustment_runs FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_guard_rain_adjustment_run() FROM PUBLIC;
