-- keep prospective rain evidence separate from serving forecasts and the temperature canary
CREATE TABLE rain_capture_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('forecast', 'station')),
  slot_key text NOT NULL UNIQUE CHECK (length(slot_key) BETWEEN 1 AND 120),
  station_id integer,
  run_initialized_at timestamptz,
  attempt smallint,
  window_start timestamptz,
  window_end_exclusive timestamptz,
  release text NOT NULL CHECK (release ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$'),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object' AND octet_length(policy::text) <= 8192),
  policy_sha256 char(64) NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT rain_capture_claim_identity CHECK (coalesce((
    (kind = 'forecast' AND station_id IS NULL AND run_initialized_at IS NOT NULL
      AND attempt IN (1, 2) AND window_start IS NULL AND window_end_exclusive IS NULL)
    OR
    (kind = 'station' AND station_id IS NOT NULL AND run_initialized_at IS NULL
      AND attempt IS NULL AND window_start IS NOT NULL AND window_end_exclusive IS NOT NULL
      AND window_start < window_end_exclusive)
  ), false))
);

CREATE INDEX rain_capture_claims_budget_idx ON rain_capture_claims (kind, claimed_at DESC);
CREATE INDEX rain_capture_claims_forecast_idx ON rain_capture_claims (run_initialized_at, attempt)
  WHERE kind = 'forecast';

-- enforce source, schedule, and egress budgets even for direct ingest-role SQL
CREATE FUNCTION weather_guard_rain_capture_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capture_now timestamptz;
DECLARE latest_boundary timestamptz;
DECLARE daily_limit integer;
DECLARE station_hour timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(7203492731157622);
  capture_now := clock_timestamp();
  NEW.claimed_at := capture_now;
  -- enforce the frozen collection lifetime
  IF capture_now < timestamptz '2026-09-13 00:00:00+00'
    OR capture_now >= timestamptz '2027-10-08 00:00:00+00' THEN
    RAISE EXCEPTION 'rain capture policy is inactive' USING ERRCODE = '23514';
  END IF;
  -- reject noncanonical or nonexistent release dates
  IF to_char(to_date(substr(NEW.release, 1, 10), 'YYYY.MM.DD'), 'YYYY.MM.DD')
    IS DISTINCT FROM substr(NEW.release, 1, 10) THEN
    RAISE EXCEPTION 'rain capture release date is invalid' USING ERRCODE = '23514';
  END IF;
  -- pin the complete non-serving policy envelope
  IF NEW.policy IS DISTINCT FROM '{"contractVersion":"rain-prospective-capture/v1","siteSlug":"ballydidean","latitude":47.950429954185445,"longitude":-122.42797012608193,"startsAt":"2026-09-13T00:00:00.000Z","expiresAt":"2027-10-08T00:00:00.000Z","stationAccessAuthorized":false,"forecastHours":49,"decisionDelayHours":8,"forecastFirstAttemptHours":6,"forecastSecondAttemptHours":7,"stationCadenceMinutes":60,"stationWindowHours":2,"maximumForecastRequestsPerDay":8,"maximumStationRequestsPerDay":288,"maximumRequestsPerIteration":2,"minimumRequestSpacingMs":1100,"pendingRequestGuardMs":120000,"rateLimitCooldownHours":24,"maximumBodyBytes":2000000,"maximumCompressedBodyBytes":2100000,"maximumStoredBytesPerDay":8388608,"maximumStoredBytes":2147483648,"timeoutMs":45000,"modelEnabled":false,"qualificationEnabled":false}'::jsonb
    OR NEW.policy_sha256 IS DISTINCT FROM '89e863c1d7fe9aaba47ab507214b25cdc6dbb84329bfcf465962c318e7a49c11' THEN
    RAISE EXCEPTION 'rain capture policy identity changed' USING ERRCODE = '23514';
  END IF;
  -- distinguish exact forecast and station scheduling contracts
  IF NEW.kind = 'forecast' THEN
    -- require the fixed six-hour cycle and attempt window
    IF extract(hour FROM NEW.run_initialized_at AT TIME ZONE 'UTC')::integer % 6 <> 0
      OR date_trunc('hour', NEW.run_initialized_at) <> NEW.run_initialized_at
      OR NEW.slot_key <> 'forecast:' || to_char(NEW.run_initialized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':' || NEW.attempt::text
      OR (NEW.attempt = 1 AND (capture_now < NEW.run_initialized_at + interval '6 hours'
        OR capture_now >= NEW.run_initialized_at + interval '7 hours'))
      OR (NEW.attempt = 2 AND (capture_now < NEW.run_initialized_at + interval '7 hours'
        OR capture_now >= NEW.run_initialized_at + interval '12 hours')) THEN
      RAISE EXCEPTION 'rain forecast claim is outside its fixed slot' USING ERRCODE = '23514';
    END IF;
    -- never request a run again after a valid retained response
    IF EXISTS (
      SELECT 1 FROM rain_capture_claims c JOIN rain_capture_receipts r ON r.claim_id = c.id
      WHERE c.kind = 'forecast' AND c.run_initialized_at = NEW.run_initialized_at AND r.outcome = 'valid'
    ) THEN
      RAISE EXCEPTION 'valid rain forecast already retained' USING ERRCODE = '23514';
    END IF;
    daily_limit := 8;
  ELSE
    -- require separately approved station access
    IF NEW.policy->>'stationAccessAuthorized' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'rain station access is not authorized' USING ERRCODE = '23514';
    END IF;
    station_hour := NEW.window_end_exclusive - interval '1 second';
    -- bind one physical gauge and exact two-hour source window
    IF NEW.station_id <> ALL(ARRAY[64255,225947,38270,168853,126537,201058,203055,66270,34768,88159,126197,27140])
      OR date_trunc('hour', station_hour) <> station_hour
      OR NEW.window_end_exclusive - NEW.window_start <> interval '2 hours'
      OR NEW.slot_key <> 'station:' || NEW.station_id::text || ':' ||
        to_char(NEW.window_end_exclusive AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR capture_now < station_hour + interval '2 minutes'
      OR capture_now >= station_hour + interval '2 hours' THEN
      RAISE EXCEPTION 'rain station claim is outside its fixed slot' USING ERRCODE = '23514';
    END IF;
    daily_limit := 288;
  END IF;
  -- suspend on outstanding transport or provider access failures
  IF EXISTS (
    SELECT 1 FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
    WHERE r.claim_id IS NULL AND c.claimed_at > capture_now - interval '120 seconds'
  ) OR EXISTS (
    SELECT 1 FROM rain_capture_receipts r JOIN rain_capture_claims c ON c.id = r.claim_id
    WHERE (r.outcome = 'rate_limited' AND (
      r.metadata->>'retryAfterRequiresManualResume' = 'true' OR r.completed_at + greatest(
        interval '24 hours', coalesce((r.metadata->>'retryAfterSeconds')::integer, 0) * interval '1 second'
      ) > capture_now))
      OR (r.outcome = 'unauthorized' AND c.kind = NEW.kind
        AND r.completed_at > capture_now - interval '24 hours')
  ) THEN
    RAISE EXCEPTION 'rain capture is pending or paused' USING ERRCODE = '23514';
  END IF;
  -- reserve one maximum response before authorizing any HTTP
  IF (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000 ELSE coalesce(r.compressed_bytes, 0) END), 0)
      FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id) + 2100000 > 2147483648
    OR (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000 ELSE coalesce(r.compressed_bytes, 0) END), 0)
      FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
      WHERE c.claimed_at >= date_trunc('day', capture_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + 2100000 > 8388608 THEN
    RAISE EXCEPTION 'rain capture storage budget is exhausted' USING ERRCODE = '23514';
  END IF;
  SELECT greatest((SELECT max(claimed_at) FROM rain_capture_claims),
    (SELECT max(completed_at) FROM rain_capture_receipts)) INTO latest_boundary;
  -- pace starts against the last completed response or claim
  IF latest_boundary IS NOT NULL AND capture_now - latest_boundary < interval '1100 milliseconds' THEN
    RAISE EXCEPTION 'rain capture spacing is not met' USING ERRCODE = '23514';
  END IF;
  -- cap both UTC-day and rolling requests by provider kind
  IF (SELECT count(*) FROM rain_capture_claims
      WHERE kind = NEW.kind AND claimed_at >= date_trunc('day', capture_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') >= daily_limit
    OR (SELECT count(*) FROM rain_capture_claims
      WHERE kind = NEW.kind AND claimed_at > capture_now - interval '24 hours') >= daily_limit THEN
    RAISE EXCEPTION 'rain capture budget is exhausted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rain_capture_claims_guard_insert
BEFORE INSERT ON rain_capture_claims
FOR EACH ROW EXECUTE FUNCTION weather_guard_rain_capture_claim();

-- retain one immutable transport outcome for every completed claimed attempt
CREATE TABLE rain_capture_receipts (
  claim_id uuid PRIMARY KEY REFERENCES rain_capture_claims(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  http_status smallint CHECK (http_status BETWEEN 100 AND 599),
  outcome text NOT NULL CHECK (outcome IN ('valid', 'invalid', 'transport_error', 'rate_limited', 'unauthorized')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  compressed_body bytea,
  body_sha256 char(64) CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  body_bytes integer CHECK (body_bytes BETWEEN 0 AND 2000000),
  compressed_bytes integer CHECK (compressed_bytes BETWEEN 0 AND 2100000),
  parser_version text NOT NULL CHECK (parser_version = 'rain-prospective-capture/v1'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 100000),
  available_by_decision boolean,
  metadata jsonb NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
    AND metadata::text !~* '(api_key|apiKey|authorization|password|secret|token|https?://)'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT rain_capture_receipt_body CHECK (coalesce((
    (compressed_body IS NULL AND body_sha256 IS NULL AND body_bytes IS NULL AND compressed_bytes IS NULL)
    OR
    (compressed_body IS NOT NULL AND body_sha256 IS NOT NULL AND body_bytes IS NOT NULL
      AND compressed_bytes = octet_length(compressed_body))
  ), false)),
  CONSTRAINT rain_capture_receipt_time CHECK (completed_at >= started_at),
  CONSTRAINT rain_capture_receipt_outcome CHECK (coalesce((
    (outcome = 'valid' AND http_status = 200 AND compressed_body IS NOT NULL AND error_code IS NULL)
    OR (outcome = 'rate_limited' AND http_status = 429)
    OR (outcome = 'unauthorized' AND http_status IN (401, 403))
    OR (outcome = 'transport_error' AND http_status IS NULL AND error_code IS NOT NULL)
    OR (outcome = 'invalid' AND http_status IS NOT NULL AND http_status NOT IN (401, 403, 429))
  ), false))
);

CREATE INDEX rain_capture_receipts_completed_idx ON rain_capture_receipts (completed_at DESC);
CREATE INDEX rain_capture_receipts_outcome_idx ON rain_capture_receipts (outcome, completed_at DESC);

-- reject evidence mutation even when a privileged owner accidentally updates a row
CREATE FUNCTION weather_reject_rain_capture_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rain capture evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER rain_capture_claims_immutable
BEFORE UPDATE OR DELETE ON rain_capture_claims
FOR EACH ROW EXECUTE FUNCTION weather_reject_rain_capture_mutation();
CREATE TRIGGER rain_capture_receipts_immutable
BEFORE UPDATE OR DELETE ON rain_capture_receipts
FOR EACH ROW EXECUTE FUNCTION weather_reject_rain_capture_mutation();

-- bind receipt clocks and causal availability to its immutable request claim
CREATE FUNCTION weather_guard_rain_capture_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_claim rain_capture_claims%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(7203492731157622);
  NEW.recorded_at := clock_timestamp();
  SELECT * INTO source_claim FROM rain_capture_claims WHERE id = NEW.claim_id;
  -- require an earlier claim and tightly bounded receipt clock
  IF NOT FOUND OR NEW.started_at < date_trunc('milliseconds', source_claim.claimed_at)
    OR NEW.completed_at > clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION 'rain capture receipt is outside its claim clock' USING ERRCODE = '23514';
  END IF;
  -- derive availability only from the observed receipt time
  IF source_claim.kind = 'forecast' THEN
    -- reject unsupported promotion of a late or invalid response
    IF NEW.available_by_decision IS DISTINCT FROM
      (NEW.outcome = 'valid' AND NEW.completed_at <= source_claim.run_initialized_at + interval '8 hours') THEN
      RAISE EXCEPTION 'rain forecast availability differs from receipt clock' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.available_by_decision IS NOT NULL THEN
    RAISE EXCEPTION 'station receipt cannot assert forecast availability' USING ERRCODE = '23514';
  END IF;
  -- preserve only bounded numeric provider retry hints
  IF NEW.metadata ? 'retryAfterSeconds' THEN
    -- reject unsupported values instead of shortening a cooldown
    IF NEW.outcome <> 'rate_limited'
      OR (jsonb_typeof(NEW.metadata->'retryAfterSeconds') <> 'null'
        AND (jsonb_typeof(NEW.metadata->'retryAfterSeconds') <> 'number'
          OR (NEW.metadata->>'retryAfterSeconds') !~ '^(0|[1-9][0-9]{0,6})$'
          OR (NEW.metadata->>'retryAfterSeconds')::bigint > 604800)) THEN
      RAISE EXCEPTION 'rain retry-after hint is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- keep uncertain retry timing under manual review
  IF NEW.metadata ? 'retryAfterRequiresManualResume' AND (
    NEW.outcome <> 'rate_limited'
    OR jsonb_typeof(NEW.metadata->'retryAfterRequiresManualResume') <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'rain retry-after manual flag is invalid' USING ERRCODE = '23514';
  END IF;
  -- replace this claim's reservation with its actual stored bytes
  IF (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000 ELSE coalesce(r.compressed_bytes, 0) END), 0)
      FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
      WHERE c.id <> NEW.claim_id) + coalesce(NEW.compressed_bytes, 0) > 2147483648
    OR (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000 ELSE coalesce(r.compressed_bytes, 0) END), 0)
      FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
      WHERE c.id <> NEW.claim_id
        AND c.claimed_at >= date_trunc('day', source_claim.claimed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND c.claimed_at < date_trunc('day', source_claim.claimed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day')
      + coalesce(NEW.compressed_bytes, 0) > 8388608 THEN
    RAISE EXCEPTION 'rain capture storage budget is exhausted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rain_capture_receipts_guard_insert
BEFORE INSERT ON rain_capture_receipts
FOR EACH ROW EXECUTE FUNCTION weather_guard_rain_capture_receipt();

-- expose aggregate progress only, not credentials, raw bodies, or station evidence
CREATE VIEW rain_collection_status_v1 WITH (security_barrier = true) AS
WITH totals AS (
  SELECT count(*)::integer AS claims,
    count(*) FILTER (WHERE r.claim_id IS NOT NULL)::integer AS receipts,
    count(*) FILTER (WHERE c.kind = 'forecast' AND r.outcome = 'valid')::integer AS valid_forecasts,
    count(*) FILTER (WHERE r.available_by_decision IS TRUE)::integer AS timely_forecasts,
    count(*) FILTER (WHERE c.kind = 'station' AND r.outcome = 'valid')::integer AS valid_station_windows,
    count(DISTINCT c.station_id) FILTER (WHERE c.kind = 'station' AND r.outcome = 'valid')::integer AS stations_seen,
    count(*) FILTER (WHERE r.claim_id IS NOT NULL AND r.outcome <> 'valid')::integer AS failed_requests,
    count(*) FILTER (WHERE r.claim_id IS NULL AND c.claimed_at > clock_timestamp() - interval '120 seconds')::integer AS pending_requests,
    count(*) FILTER (WHERE r.claim_id IS NULL AND c.claimed_at <= clock_timestamp() - interval '120 seconds')::integer AS unknown_requests,
    max(c.claimed_at) AS last_claim_at, max(r.completed_at) AS last_receipt_at,
    max(r.completed_at) FILTER (WHERE c.kind = 'forecast') AS last_forecast_receipt_at,
    max(r.completed_at) FILTER (WHERE c.kind = 'station') AS last_station_receipt_at,
    max(CASE WHEN r.metadata->>'retryAfterRequiresManualResume' = 'true'
      THEN timestamptz '2027-10-08 00:00:00+00'
      ELSE r.completed_at + CASE WHEN r.outcome = 'rate_limited'
      THEN greatest(interval '24 hours', coalesce((r.metadata->>'retryAfterSeconds')::integer, 0) * interval '1 second')
      ELSE interval '24 hours' END END) FILTER (
      WHERE r.outcome IN ('rate_limited', 'unauthorized')
        AND (CASE WHEN r.metadata->>'retryAfterRequiresManualResume' = 'true'
          THEN timestamptz '2027-10-08 00:00:00+00'
          ELSE r.completed_at + CASE WHEN r.outcome = 'rate_limited'
          THEN greatest(interval '24 hours', coalesce((r.metadata->>'retryAfterSeconds')::integer, 0) * interval '1 second')
          ELSE interval '24 hours' END END) > clock_timestamp()
    ) AS paused_until,
    coalesce(sum(r.compressed_bytes), 0)::bigint AS compressed_bytes
  FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
)
SELECT 'rain-prospective-capture/v1'::text AS contract_version,
  false AS model_enabled, false AS qualification_enabled, totals.* FROM totals;

REVOKE ALL ON rain_capture_claims, rain_capture_receipts, rain_collection_status_v1 FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_reject_rain_capture_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_guard_rain_capture_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION weather_guard_rain_capture_receipt() FROM PUBLIC;
