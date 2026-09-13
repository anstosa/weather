-- retain the old forecast policy while admitting only the authorized station policy
CREATE OR REPLACE FUNCTION weather_guard_rain_capture_claim()
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
  -- pair each complete policy envelope with its exact digest
  IF NOT (
    (NEW.policy = '{"contractVersion":"rain-prospective-capture/v1","siteSlug":"ballydidean","latitude":47.950429954185445,"longitude":-122.42797012608193,"startsAt":"2026-09-13T00:00:00.000Z","expiresAt":"2027-10-08T00:00:00.000Z","stationAccessAuthorized":false,"forecastHours":49,"decisionDelayHours":8,"forecastFirstAttemptHours":6,"forecastSecondAttemptHours":7,"stationCadenceMinutes":60,"stationWindowHours":2,"maximumForecastRequestsPerDay":8,"maximumStationRequestsPerDay":288,"maximumRequestsPerIteration":2,"minimumRequestSpacingMs":1100,"pendingRequestGuardMs":120000,"rateLimitCooldownHours":24,"maximumBodyBytes":2000000,"maximumCompressedBodyBytes":2100000,"maximumStoredBytesPerDay":8388608,"maximumStoredBytes":2147483648,"timeoutMs":45000,"modelEnabled":false,"qualificationEnabled":false}'::jsonb
      AND NEW.policy_sha256 = '89e863c1d7fe9aaba47ab507214b25cdc6dbb84329bfcf465962c318e7a49c11')
    OR (NEW.policy = '{"contractVersion":"rain-prospective-capture/v1","siteSlug":"ballydidean","latitude":47.950429954185445,"longitude":-122.42797012608193,"startsAt":"2026-09-13T00:00:00.000Z","expiresAt":"2027-10-08T00:00:00.000Z","stationAccessAuthorized":true,"forecastHours":49,"decisionDelayHours":8,"forecastFirstAttemptHours":6,"forecastSecondAttemptHours":7,"stationCadenceMinutes":60,"stationWindowHours":2,"maximumForecastRequestsPerDay":8,"maximumStationRequestsPerDay":288,"maximumRequestsPerIteration":2,"minimumRequestSpacingMs":1100,"pendingRequestGuardMs":120000,"rateLimitCooldownHours":24,"maximumBodyBytes":2000000,"maximumCompressedBodyBytes":2100000,"maximumStoredBytesPerDay":8388608,"maximumStoredBytes":2147483648,"timeoutMs":45000,"modelEnabled":false,"qualificationEnabled":false}'::jsonb
      AND NEW.policy_sha256 = '9f630d0fb4672dd44049e8fdda0b2f1efd35a18a955ce1ada39b421ed028ea51')
  ) THEN
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
    -- permit stations only under the new authorized envelope
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
