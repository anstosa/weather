-- retain private ECMWF canary runs outside ordinary forecast sources
CREATE TABLE ecmwf_temperature_canary_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  run_initialized_at timestamptz NOT NULL,
  first_received_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  upstream_model varchar(32) NOT NULL,
  adapter_version varchar(128) NOT NULL,
  provider_response_sha256 char(64) NOT NULL,
  model_cycle varchar(16) NOT NULL,
  recent_error_state jsonb NOT NULL,
  recent_error_state_sha256 char(64) NOT NULL,
  state_status varchar(16) NOT NULL,
  state_reason varchar(128) NOT NULL,
  content_hash char(64) NOT NULL,
  revision_count integer NOT NULL DEFAULT 0,
  CONSTRAINT ecmwf_temperature_canary_runs_identity_key
    UNIQUE (site_id, run_initialized_at),
  CONSTRAINT ecmwf_temperature_canary_runs_initialization_check CHECK (
    date_trunc('hour', run_initialized_at AT TIME ZONE 'UTC') =
      run_initialized_at AT TIME ZONE 'UTC'
    AND extract(hour FROM run_initialized_at AT TIME ZONE 'UTC') IN (0, 6, 12, 18)
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_receipt_check CHECK (
    first_received_at >= run_initialized_at
    AND last_received_at >= first_received_at
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_model_check CHECK (
    upstream_model = 'ecmwf_ifs'
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_adapter_check CHECK (
    adapter_version = 'open-meteo-ecmwf-single-run/v1'
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_cycle_check CHECK (
    (
      run_initialized_at < timestamptz '2026-05-12 06:00:00+00'
      AND model_cycle = '49r1'
    )
    OR (
      run_initialized_at >= timestamptz '2026-05-12 06:00:00+00'
      AND model_cycle = '50r1'
    )
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_state_check CHECK (
    jsonb_typeof(recent_error_state) = 'object'
    AND octet_length(recent_error_state::text) <= 16384
    AND state_status IN ('supported', 'cold', 'insufficient', 'invalid')
    AND length(trim(state_reason)) > 0
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_hashes_check CHECK (
    provider_response_sha256 ~ '^[a-f0-9]{64}$'
    AND recent_error_state_sha256 ~ '^[a-f0-9]{64}$'
    AND content_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT ecmwf_temperature_canary_runs_revision_check CHECK (
    revision_count = 0
  )
);

-- retain only the bounded model inputs required by the canary
CREATE TABLE ecmwf_temperature_canary_hours (
  run_id bigint NOT NULL REFERENCES ecmwf_temperature_canary_runs(id) ON DELETE RESTRICT,
  valid_at timestamptz NOT NULL,
  model_lead_hours smallint NOT NULL,
  raw_temperature_c double precision NOT NULL,
  raw_relative_humidity_percent double precision,
  raw_wind_speed_mps double precision,
  content_hash char(64) NOT NULL,
  PRIMARY KEY (run_id, valid_at),
  CONSTRAINT ecmwf_temperature_canary_hours_lead_key
    UNIQUE (run_id, model_lead_hours),
  CONSTRAINT ecmwf_temperature_canary_hours_lead_check CHECK (
    model_lead_hours BETWEEN 1 AND 18
  ),
  CONSTRAINT ecmwf_temperature_canary_hours_temperature_check CHECK (
    raw_temperature_c BETWEEN -100 AND 70
  ),
  CONSTRAINT ecmwf_temperature_canary_hours_humidity_check CHECK (
    raw_relative_humidity_percent IS NULL
    OR raw_relative_humidity_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT ecmwf_temperature_canary_hours_wind_check CHECK (
    raw_wind_speed_mps IS NULL OR raw_wind_speed_mps BETWEEN 0 AND 150
  ),
  CONSTRAINT ecmwf_temperature_canary_hours_hash_check CHECK (
    content_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX ecmwf_temperature_canary_runs_live_idx
ON ecmwf_temperature_canary_runs (
  site_id,
  run_initialized_at DESC,
  first_received_at DESC,
  id DESC
);

CREATE INDEX ecmwf_temperature_canary_hours_valid_idx
ON ecmwf_temperature_canary_hours (valid_at, run_id);

-- guard immutable run content while allowing identical receipt advancement
CREATE FUNCTION weather_guard_ecmwf_temperature_canary_run_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- preserve all model and causal content
  IF ROW(
    OLD.site_id,
    OLD.run_initialized_at,
    OLD.first_received_at,
    OLD.upstream_model,
    OLD.adapter_version,
    OLD.provider_response_sha256,
    OLD.model_cycle,
    OLD.recent_error_state,
    OLD.recent_error_state_sha256,
    OLD.state_status,
    OLD.state_reason,
    OLD.content_hash,
    OLD.revision_count
  ) IS DISTINCT FROM ROW(
    NEW.site_id,
    NEW.run_initialized_at,
    NEW.first_received_at,
    NEW.upstream_model,
    NEW.adapter_version,
    NEW.provider_response_sha256,
    NEW.model_cycle,
    NEW.recent_error_state,
    NEW.recent_error_state_sha256,
    NEW.state_status,
    NEW.state_reason,
    NEW.content_hash,
    NEW.revision_count
  ) THEN
    RAISE EXCEPTION 'ECMWF temperature canary run content is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- keep identical receipts monotonic
  IF NEW.last_received_at < OLD.last_received_at THEN
    RAISE EXCEPTION 'ECMWF temperature canary last receipt cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ecmwf_temperature_canary_runs_guard_update
BEFORE UPDATE ON ecmwf_temperature_canary_runs
FOR EACH ROW EXECUTE FUNCTION weather_guard_ecmwf_temperature_canary_run_update();

-- bind each hour to its parent initialization
CREATE FUNCTION weather_require_ecmwf_temperature_canary_hour_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- require the exact initialization-relative hour
  IF NOT EXISTS (
    SELECT 1
    FROM ecmwf_temperature_canary_runs run
    WHERE run.id = NEW.run_id
      AND NEW.valid_at =
        run.run_initialized_at + NEW.model_lead_hours * interval '1 hour'
  ) THEN
    RAISE EXCEPTION 'ECMWF temperature canary hour identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ecmwf_temperature_canary_hours_require_identity
BEFORE INSERT ON ecmwf_temperature_canary_hours
FOR EACH ROW EXECUTE FUNCTION weather_require_ecmwf_temperature_canary_hour_identity();

-- reject every mutation to persisted model hours
CREATE FUNCTION weather_reject_ecmwf_temperature_canary_hour_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ECMWF temperature canary hours are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER ecmwf_temperature_canary_hours_reject_update
BEFORE UPDATE OR DELETE ON ecmwf_temperature_canary_hours
FOR EACH ROW EXECUTE FUNCTION weather_reject_ecmwf_temperature_canary_hour_mutation();

REVOKE ALL ON ecmwf_temperature_canary_runs FROM PUBLIC;
REVOKE ALL ON ecmwf_temperature_canary_hours FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_guard_ecmwf_temperature_canary_run_update()
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_require_ecmwf_temperature_canary_hour_identity()
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_reject_ecmwf_temperature_canary_hour_mutation()
FROM PUBLIC;
