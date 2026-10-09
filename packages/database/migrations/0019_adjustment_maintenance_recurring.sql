-- upgrade empty hot prediction storage to the bound v3 body contract
DO $adjustment_prediction_v3_preflight$
BEGIN
  -- refuse to relabel legacy prediction identities during migration
  IF EXISTS (SELECT 1 FROM adjustment_shadow_predictions_v2) THEN
    RAISE EXCEPTION 'adjustment prediction v3 requires an empty hot prediction table';
  END IF;
END;
$adjustment_prediction_v3_preflight$;

ALTER TABLE adjustment_shadow_predictions_v2
  ADD COLUMN candidate_sha256 char(64) NOT NULL
    CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_sha256 char(64) NOT NULL
    CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN scored_min_valid_at timestamptz NOT NULL,
  ADD COLUMN scored_max_valid_at timestamptz NOT NULL,
  ADD CONSTRAINT adjustment_shadow_predictions_v3_complete_geometry
    CHECK (max_valid_at - min_valid_at = (row_count - 1) * interval '1 hour'),
  ADD CONSTRAINT adjustment_shadow_predictions_v3_scored_geometry
    CHECK (min_valid_at <= scored_min_valid_at
      AND scored_min_valid_at <= scored_max_valid_at
      AND scored_max_valid_at <= max_valid_at);

-- retain immutable terminal action reconciliation after hot registration retirement
CREATE TABLE adjustment_shadow_terminal_results_v2 (
  registration_sha256 char(64) PRIMARY KEY
    CHECK (registration_sha256 ~ '^[a-f0-9]{64}$'),
  family text NOT NULL UNIQUE CHECK (family IN ('temperature', 'wind', 'rain')),
  terminal_member_sha256 char(64) NOT NULL
    CHECK (terminal_member_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 char(64) NOT NULL
    CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  reserved_key_sha256 char(64) NOT NULL
    CHECK (reserved_key_sha256 ~ '^[a-f0-9]{64}$'),
  terminal_result_sha256 char(64) NOT NULL
    CHECK (terminal_result_sha256 ~ '^[a-f0-9]{64}$'),
  confirmation_access_sha256 char(64) NOT NULL
    CHECK (confirmation_access_sha256 ~ '^[a-f0-9]{64}$'),
  action_sha256 char(64) NOT NULL
    CHECK (action_sha256 ~ '^[a-f0-9]{64}$'),
  action_disposition text NOT NULL CHECK (action_disposition IN (
    'promoted_verified', 'rejected_no_action',
    'resource_refused_no_action', 'support_failed_no_action',
    'promotion_failed_compensated', 'operator_off_compensated',
    'promoted_operator_off_unapplied'
  )),
  action_completed_at timestamptz NOT NULL,
  metadata_root_sha256 char(64) NOT NULL
    CHECK (metadata_root_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_generation integer NOT NULL CHECK (metadata_generation > 0),
  finalized_prediction_count integer NOT NULL CHECK (finalized_prediction_count > 0),
  maintenance_anchor_sha256 char(64) NOT NULL
    CHECK (maintenance_anchor_sha256 ~ '^[a-f0-9]{64}$'),
  reconciliation_sha256 char(64) NOT NULL UNIQUE
    CHECK (reconciliation_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL
);

-- assign bound v3 prediction identities and scored target geometry
CREATE OR REPLACE FUNCTION weather_guard_adjustment_shadow_prediction_v2()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  due_at timestamptz;
  expected_rows integer;
  expected_schema_sha256 text;
  expected_source_receipt_sha256 text;
  computed_identity text;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- admit inserts only through the closed v3 append context
  IF operation IS NULL OR operation->>'operation' <> 'append_v3'
    OR operation->>'family' NOT IN ('temperature', 'wind', 'rain') THEN
    RAISE EXCEPTION 'adjustment prediction insert requires closed v3 function context'
      USING ERRCODE = '42501';
  END IF;
  -- reject every caller-owned server field
  IF NEW.prediction_sha256 IS NOT NULL OR NEW.committed_at IS NOT NULL
    OR NEW.scored_min_valid_at IS NOT NULL OR NEW.scored_max_valid_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment prediction server fields are caller assigned'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = NEW.registration_sha256;
  NEW.committed_at := date_trunc('milliseconds', clock_timestamp());
  due_at := substring(NEW.due_key FROM 9)::timestamptz;
  expected_rows := CASE registration.family
    WHEN 'temperature' THEN 12 WHEN 'wind' THEN 168 WHEN 'rain' THEN 23 END;
  expected_schema_sha256 := CASE registration.family
    WHEN 'temperature' THEN '4255feacfd464adf2cbbf1139ecdf30d9d00b847775c556407367ad1449d9e63'
    WHEN 'wind' THEN '3f573c3e49ed3b97636674b0630e49508cf80533ff8edc8f31f6f0411f70d902'
    WHEN 'rain' THEN 'c7ae2f750f13970137b1b2d885f7cce81b8ecbc2720635c6716f005bc04a5e25'
  END;
  -- bind candidate and source identities to the frozen registration
  IF registration.family <> operation->>'family'
    OR NEW.candidate_sha256 <> registration.candidate_sha256
    OR NEW.source_sha256 <> registration.source_sha256
    OR NEW.prediction_schema_sha256 <> expected_schema_sha256
    OR NEW.row_count <> expected_rows THEN
    RAISE EXCEPTION 'adjustment prediction registration binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  -- require exact family caps without shortened complete bodies
  IF (registration.family = 'temperature' AND NEW.body_byte_count > 8192)
    OR (registration.family = 'wind' AND NEW.body_byte_count > 65536)
    OR (registration.family = 'rain' AND NEW.body_byte_count > 12288) THEN
    RAISE EXCEPTION 'adjustment prediction body bounds are invalid'
      USING ERRCODE = '23514';
  END IF;
  -- require a complete hourly halo that intersects the scored interval
  IF NEW.max_valid_at - NEW.min_valid_at <> (expected_rows - 1) * interval '1 hour'
    OR NEW.max_valid_at < registration.interval_start_at
    OR NEW.min_valid_at >= registration.interval_end_at THEN
    RAISE EXCEPTION 'adjustment prediction lead halo is invalid'
      USING ERRCODE = '23514';
  END IF;
  NEW.scored_min_valid_at := greatest(NEW.min_valid_at, registration.interval_start_at);
  NEW.scored_max_valid_at := least(NEW.max_valid_at, registration.interval_end_at - interval '1 hour');
  -- require score bounds to remain actual hourly body targets
  IF NEW.scored_min_valid_at > NEW.scored_max_valid_at
    OR mod(extract(epoch FROM (NEW.scored_min_valid_at - NEW.min_valid_at))::bigint, 3600) <> 0
    OR mod(extract(epoch FROM (NEW.scored_max_valid_at - NEW.min_valid_at))::bigint, 3600) <> 0 THEN
    RAISE EXCEPTION 'adjustment prediction scored geometry is invalid'
      USING ERRCODE = '23514';
  END IF;
  -- preserve issuance causality and the exact due window
  IF due_at > NEW.issued_at OR NEW.issued_at > due_at + interval '12 hours'
    OR NEW.issued_at > NEW.committed_at OR NEW.committed_at >= NEW.min_valid_at THEN
    RAISE EXCEPTION 'adjustment prediction due key or clocks are invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_source_receipt_sha256 := encode(sha256(convert_to(
    'adjustment-shadow-source-receipt/v1' || E'\n'
      || NEW.registration_sha256 || E'\n' || NEW.candidate_sha256 || E'\n'
      || NEW.source_sha256 || E'\n' || NEW.due_key || E'\n'
      || to_char(NEW.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.min_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.max_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || NEW.row_count::text || E'\n' || NEW.input_sha256,
    'UTF8'
  )), 'hex');
  -- require the anchored receipt to bind the exact raw source projection
  IF NEW.source_receipt_sha256 <> expected_source_receipt_sha256 THEN
    RAISE EXCEPTION 'adjustment prediction source receipt is invalid'
      USING ERRCODE = '23514';
  END IF;

  computed_identity := encode(sha256(convert_to(
    'adjustment-shadow-prediction/v3' || E'\n'
      || NEW.registration_sha256 || E'\n' || NEW.candidate_sha256 || E'\n'
      || NEW.source_sha256 || E'\n' || NEW.due_key || E'\n'
      || to_char(NEW.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.min_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.max_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || NEW.source_receipt_sha256 || E'\n' || NEW.input_sha256 || E'\n'
      || NEW.prediction_body_sha256 || E'\n' || NEW.prediction_schema_sha256 || E'\n'
      || NEW.row_count::text || E'\n' || NEW.body_byte_count::text,
    'UTF8'
  )), 'hex');
  NEW.prediction_sha256 := computed_identity;
  RETURN NEW;
END;
$$;

-- centralize the three closed role-shaped v3 append operations
CREATE FUNCTION weather_append_adjustment_shadow_v3(argument jsonb, family_argument text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted adjustment_shadow_predictions_v2%ROWTYPE;
  existing adjustment_shadow_predictions_v2%ROWTYPE;
  supplied_identity text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'bodyByteCount', 'candidateSha256', 'dueKey', 'inputSha256', 'issuedAt',
    'maxValidAt', 'minValidAt', 'predictionBodySha256', 'predictionSchemaSha256',
    'predictionSha256', 'registrationSha256', 'rowCount', 'sourceReceiptSha256',
    'sourceSha256'
  ];
BEGIN
  -- require administrator activation for this exact login
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- retain the original family ownership split
  IF family_argument NOT IN ('temperature', 'wind', 'rain')
    OR (family_argument IN ('temperature', 'wind')
      AND session_user NOT IN ('weather_api', 'weather_owner'))
    OR (family_argument = 'rain'
      AND session_user NOT IN ('weather_ingest', 'weather_owner')) THEN
    RAISE EXCEPTION 'adjustment prediction family is unauthorized' USING ERRCODE = '42501';
  END IF;
  -- require one bounded closed compact object
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb)
    OR argument->>'issuedAt'
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    OR to_char((argument->>'issuedAt')::timestamptz AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> argument->>'issuedAt' THEN
    RAISE EXCEPTION 'adjustment prediction object is invalid' USING ERRCODE = '22023';
  END IF;

  supplied_identity := argument->>'predictionSha256';
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'append_v3', 'family', family_argument)::text, true);
  INSERT INTO adjustment_shadow_predictions_v2 (
    prediction_sha256, registration_sha256, candidate_sha256, source_sha256,
    due_key, issued_at, committed_at, min_valid_at, max_valid_at,
    scored_min_valid_at, scored_max_valid_at, source_receipt_sha256, input_sha256,
    prediction_body_sha256, prediction_schema_sha256, row_count, body_byte_count
  ) VALUES (
    NULL, argument->>'registrationSha256', argument->>'candidateSha256',
    argument->>'sourceSha256', argument->>'dueKey',
    (argument->>'issuedAt')::timestamptz, NULL,
    (argument->>'minValidAt')::timestamptz, (argument->>'maxValidAt')::timestamptz,
    NULL, NULL, argument->>'sourceReceiptSha256', argument->>'inputSha256',
    argument->>'predictionBodySha256', argument->>'predictionSchemaSha256',
    (argument->>'rowCount')::smallint, (argument->>'bodyByteCount')::integer
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the server-recomputed identity
  IF inserted.prediction_sha256 IS NOT NULL
    AND inserted.prediction_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment prediction identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require a byte-identical retry after either unique conflict
  IF inserted.prediction_sha256 IS NULL THEN
    SELECT * INTO existing FROM adjustment_shadow_predictions_v2
    WHERE prediction_sha256 = supplied_identity
      OR (registration_sha256 = argument->>'registrationSha256'
        AND due_key = argument->>'dueKey');
    IF NOT FOUND OR ROW(
      existing.prediction_sha256, existing.registration_sha256,
      existing.candidate_sha256, existing.source_sha256, existing.due_key,
      existing.issued_at, existing.min_valid_at, existing.max_valid_at,
      existing.source_receipt_sha256, existing.input_sha256,
      existing.prediction_body_sha256, existing.prediction_schema_sha256,
      existing.row_count, existing.body_byte_count
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), (argument->>'registrationSha256')::char(64),
      (argument->>'candidateSha256')::char(64), (argument->>'sourceSha256')::char(64),
      argument->>'dueKey', (argument->>'issuedAt')::timestamptz,
      (argument->>'minValidAt')::timestamptz, (argument->>'maxValidAt')::timestamptz,
      (argument->>'sourceReceiptSha256')::char(64), (argument->>'inputSha256')::char(64),
      (argument->>'predictionBodySha256')::char(64),
      (argument->>'predictionSchemaSha256')::char(64),
      (argument->>'rowCount')::smallint, (argument->>'bodyByteCount')::integer
    ) THEN
      RAISE EXCEPTION 'adjustment prediction retry differs' USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM set_config('weather.adjustment_maintenance_operation', coalesce(previous_operation, ''), true);
  RETURN jsonb_build_object(
    'committedAt', to_char(coalesce(inserted.committed_at, existing.committed_at)
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'inserted', inserted.prediction_sha256 IS NOT NULL,
    'predictionSha256', supplied_identity
  );
END;
$$;

-- preserve the application-facing role-shaped function names
CREATE OR REPLACE FUNCTION weather_append_adjustment_temperature_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v3(argument, 'temperature') $$;
CREATE OR REPLACE FUNCTION weather_append_adjustment_wind_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v3(argument, 'wind') $$;
CREATE OR REPLACE FUNCTION weather_append_adjustment_rain_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v3(argument, 'rain') $$;

-- admit terminal result rows only inside one owner reconciliation
CREATE FUNCTION weather_guard_adjustment_shadow_terminal_result_v2()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- allow only one anchored cold rotation of a retired predecessor tombstone
  IF TG_OP = 'DELETE' AND operation IS NOT NULL
    AND operation->>'operation' = 'rotate_terminal_result'
    AND OLD.registration_sha256 = operation->>'registrationSha256'
    AND OLD.reconciliation_sha256 = operation->>'reconciliationSha256'
    AND NOT EXISTS (SELECT 1 FROM adjustment_shadow_registrations_v2 registration
      WHERE registration.registration_sha256 = OLD.registration_sha256) THEN
    RETURN OLD;
  END IF;
  -- reject all remaining mutation and direct insertion paths
  IF TG_OP = 'TRUNCATE' OR TG_OP IN ('UPDATE', 'DELETE')
    OR operation IS NULL OR operation->>'operation' <> 'record_terminal_result'
    OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment terminal results are immutable' USING ERRCODE = '42501';
  END IF;
  NEW.recorded_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE TRIGGER adjustment_shadow_terminal_results_v2_guard_insert
BEFORE INSERT ON adjustment_shadow_terminal_results_v2
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_shadow_terminal_result_v2();
CREATE TRIGGER adjustment_shadow_terminal_results_v2_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_shadow_terminal_results_v2
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_shadow_terminal_result_v2();
CREATE TRIGGER adjustment_shadow_terminal_results_v2_guard_truncate
BEFORE TRUNCATE ON adjustment_shadow_terminal_results_v2
FOR EACH STATEMENT EXECUTE FUNCTION weather_guard_adjustment_shadow_terminal_result_v2();

-- record one terminal member result and fully reconciled action
CREATE FUNCTION weather_record_adjustment_shadow_terminal_result_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  access adjustment_confirmation_accesses_v2%ROWTYPE;
  predecessor adjustment_shadow_terminal_results_v2%ROWTYPE;
  inserted adjustment_shadow_terminal_results_v2%ROWTYPE;
  existing adjustment_shadow_terminal_results_v2%ROWTYPE;
  computed_reconciliation_sha256 text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'actionCompletedAt', 'actionDisposition', 'actionSha256',
    'maintenanceAnchorSha256', 'reconciliationSha256', 'registrationSha256',
    'terminalMemberSha256', 'terminalResultSha256'
  ];
BEGIN
  -- keep terminal authority behind the owner wrapper
  IF session_user <> 'weather_owner' THEN
    RAISE EXCEPTION 'adjustment terminal reconciliation is owner only' USING ERRCODE = '42501';
  END IF;
  -- require the authenticated terminal action anchor
  IF current_setting('weather.adjustment_maintenance_anchor_kind', true)
      IS DISTINCT FROM 'terminal_action_reconciliation'
    OR current_setting('weather.adjustment_maintenance_anchor_sha256', true)
      IS DISTINCT FROM argument->>'maintenanceAnchorSha256'
    OR current_setting('weather.adjustment_terminal_member_root_sha256', true)
      IS DISTINCT FROM argument->>'terminalMemberSha256' THEN
    RAISE EXCEPTION 'current terminal action reconciliation anchor is unavailable'
      USING ERRCODE = '55000';
  END IF;
  -- close every supplied field and action state
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb)
    OR argument->>'actionCompletedAt'
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    OR to_char((argument->>'actionCompletedAt')::timestamptz AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> argument->>'actionCompletedAt'
    OR argument->>'actionDisposition' NOT IN (
      'promoted_verified', 'rejected_no_action',
      'resource_refused_no_action', 'support_failed_no_action',
      'promotion_failed_compensated', 'operator_off_compensated',
      'promoted_operator_off_unapplied'
    )
    OR NOT (
      argument->>'registrationSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'terminalMemberSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'terminalResultSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'actionSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'maintenanceAnchorSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'reconciliationSha256' ~ '^[a-f0-9]{64}$'
    ) THEN
    RAISE EXCEPTION 'adjustment terminal reconciliation object is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(argument->>'registrationSha256', 0));
  SELECT * INTO STRICT registration FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = argument->>'registrationSha256' FOR UPDATE;
  SELECT * INTO STRICT access FROM adjustment_confirmation_accesses_v2
  WHERE registration_sha256 = registration.registration_sha256;
  -- bind a completed terminal member and action to the cold metadata state
  IF registration.metadata_generation <= 0 OR registration.finalized_prediction_count <= 0
    OR registration.finalized_through_at IS NULL
    OR (argument->>'actionCompletedAt')::timestamptz < registration.terminal_at
    OR (argument->>'actionCompletedAt')::timestamptz > clock_timestamp()
    OR EXISTS (SELECT 1 FROM adjustment_shadow_predictions_v2 prediction
      WHERE prediction.registration_sha256 = registration.registration_sha256) THEN
    RAISE EXCEPTION 'adjustment terminal reconciliation is not complete'
      USING ERRCODE = '23514';
  END IF;
  -- reject category aliases in place of the authenticated cold full-member root
  IF argument->>'terminalMemberSha256' IN (
      registration.candidate_sha256, registration.source_sha256,
      registration.reserved_key_sha256, argument->>'terminalResultSha256',
      argument->>'actionSha256'
    ) THEN
    RAISE EXCEPTION 'adjustment terminal member root is invalid' USING ERRCODE = '23514';
  END IF;
  computed_reconciliation_sha256 := encode(sha256(convert_to(
    'adjustment-shadow-terminal-reconciliation/v2' || E'\n'
      || registration.registration_sha256 || E'\n' || registration.family || E'\n'
      || registration.candidate_sha256 || E'\n' || registration.source_sha256 || E'\n'
      || registration.reserved_key_sha256 || E'\n'
      || (argument->>'terminalMemberSha256') || E'\n'
      || (argument->>'terminalResultSha256') || E'\n'
      || access.access_sha256 || E'\n'
      || (argument->>'actionSha256') || E'\n'
      || (argument->>'actionDisposition') || E'\n'
      || to_char((argument->>'actionCompletedAt')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || registration.finalized_metadata_root_sha256 || E'\n'
      || registration.metadata_generation::text || E'\n'
      || registration.finalized_prediction_count::text || E'\n'
      || (argument->>'maintenanceAnchorSha256'),
    'UTF8'
  )), 'hex');
  -- reject literal hash claims not bound by the owner computation
  IF computed_reconciliation_sha256 <> argument->>'reconciliationSha256' THEN
    RAISE EXCEPTION 'adjustment terminal reconciliation identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  SELECT * INTO predecessor FROM adjustment_shadow_terminal_results_v2
  WHERE family = registration.family;
  -- rotate only an already-retired predecessor proven in the anchored cold catalog
  IF predecessor.registration_sha256 IS NOT NULL
    AND predecessor.registration_sha256 <> registration.registration_sha256 THEN
    IF current_setting('weather.adjustment_previous_terminal_tombstone_sha256', true)
        IS DISTINCT FROM predecessor.reconciliation_sha256 THEN
      RAISE EXCEPTION 'previous adjustment terminal tombstone is not cold anchored'
        USING ERRCODE = '55000';
    END IF;
    PERFORM set_config('weather.adjustment_maintenance_operation', jsonb_build_object(
      'operation', 'rotate_terminal_result',
      'reconciliationSha256', predecessor.reconciliation_sha256,
      'registrationSha256', predecessor.registration_sha256
    )::text, true);
    DELETE FROM adjustment_shadow_terminal_results_v2
    WHERE registration_sha256 = predecessor.registration_sha256;
  END IF;
  PERFORM set_config('weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'record_terminal_result')::text, true);
  INSERT INTO adjustment_shadow_terminal_results_v2 (
    registration_sha256, family, terminal_member_sha256, source_sha256,
    reserved_key_sha256, terminal_result_sha256, confirmation_access_sha256,
    action_sha256, action_disposition, action_completed_at,
    metadata_root_sha256, metadata_generation, finalized_prediction_count,
    maintenance_anchor_sha256, reconciliation_sha256, recorded_at
  ) VALUES (
    registration.registration_sha256, registration.family,
    argument->>'terminalMemberSha256',
    registration.source_sha256, registration.reserved_key_sha256,
    argument->>'terminalResultSha256', access.access_sha256,
    argument->>'actionSha256', argument->>'actionDisposition',
    (argument->>'actionCompletedAt')::timestamptz,
    registration.finalized_metadata_root_sha256, registration.metadata_generation,
    registration.finalized_prediction_count, argument->>'maintenanceAnchorSha256',
    computed_reconciliation_sha256, NULL
  ) ON CONFLICT DO NOTHING RETURNING * INTO inserted;
  -- require exact idempotent reconciliation retries
  IF inserted.registration_sha256 IS NULL THEN
    SELECT * INTO STRICT existing FROM adjustment_shadow_terminal_results_v2
    WHERE registration_sha256 = registration.registration_sha256;
    IF existing.reconciliation_sha256 <> computed_reconciliation_sha256 THEN
      RAISE EXCEPTION 'adjustment terminal reconciliation retry differs'
        USING ERRCODE = '23505';
    END IF;
  END IF;
  PERFORM set_config('weather.adjustment_maintenance_operation', coalesce(previous_operation, ''), true);
  RETURN jsonb_build_object(
    'reconciliationSha256', computed_reconciliation_sha256,
    'registrationSha256', registration.registration_sha256,
    'status', CASE WHEN inserted.registration_sha256 IS NULL THEN 'already_recorded' ELSE 'recorded' END
  );
END;
$$;

-- replace mutation policy with explicit terminal retirement authority
CREATE OR REPLACE FUNCTION weather_reject_adjustment_maintenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
BEGIN
  -- reject every truncation path
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'adjustment maintenance tables are not truncatable' USING ERRCODE = '42501';
  END IF;
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- retain only the exact metadata-generation transition
  IF operation IS NOT NULL AND operation->>'operation' = 'finalize'
    AND TG_TABLE_NAME = 'adjustment_shadow_registrations_v2' AND TG_OP = 'UPDATE' THEN
    IF OLD.registration_sha256 <> operation->>'registrationSha256'
      OR NEW.metadata_generation <> OLD.metadata_generation + 1
      OR NEW.metadata_generation <> (operation->>'generation')::integer
      OR NEW.finalized_metadata_root_sha256 <> operation->>'newMetadataRootSha256'
      OR NEW.finalized_prediction_count
        <> OLD.finalized_prediction_count + (operation->>'rowCount')::integer
      OR NEW.finalized_through_at <> (operation->>'throughCommittedAt')::timestamptz
      OR NEW.last_finalization_anchor_sha256 <> operation->>'maintenanceAnchorSha256'
      OR ROW(NEW.registration_sha256, NEW.site_key, NEW.family, NEW.candidate_sha256,
        NEW.artifact_sha256, NEW.policy_sha256, NEW.cohort_sha256,
        NEW.reserved_key_sha256, NEW.source_sha256, NEW.interval_start_at,
        NEW.interval_end_at, NEW.target_cutoff_at, NEW.terminal_at, NEW.registered_at)
      IS DISTINCT FROM ROW(OLD.registration_sha256, OLD.site_key, OLD.family,
        OLD.candidate_sha256, OLD.artifact_sha256, OLD.policy_sha256,
        OLD.cohort_sha256, OLD.reserved_key_sha256, OLD.source_sha256,
        OLD.interval_start_at, OLD.interval_end_at, OLD.target_cutoff_at,
        OLD.terminal_at, OLD.registered_at) THEN
      RAISE EXCEPTION 'adjustment registration transition is invalid' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- retain exact compact rows selected by finalization
  IF operation IS NOT NULL AND operation->>'operation' = 'finalize'
    AND TG_TABLE_NAME = 'adjustment_shadow_predictions_v2' AND TG_OP = 'DELETE' THEN
    IF OLD.registration_sha256 <> operation->>'registrationSha256'
      OR OLD.committed_at < (operation->>'fromCommittedAt')::timestamptz
      OR OLD.committed_at > (operation->>'throughCommittedAt')::timestamptz THEN
      RAISE EXCEPTION 'adjustment prediction deletion is invalid' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- allow terminal access and registration deletion only through bounded retirement
  IF operation IS NOT NULL AND operation->>'operation' = 'retire_terminal'
    AND TG_OP = 'DELETE'
    AND TG_TABLE_NAME IN ('adjustment_confirmation_accesses_v2', 'adjustment_shadow_registrations_v2')
    AND OLD.registration_sha256 = operation->>'registrationSha256'
    AND EXISTS (
      SELECT 1 FROM adjustment_shadow_terminal_results_v2 terminal
      WHERE terminal.registration_sha256 = OLD.registration_sha256
        AND terminal.reconciliation_sha256 = operation->>'reconciliationSha256'
    ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'adjustment maintenance rows are immutable' USING ERRCODE = '42501';
END;
$$;

-- retire one reconciled terminal registration while retaining its immutable tombstone
CREATE FUNCTION weather_retire_adjustment_shadow_registration_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  terminal adjustment_shadow_terminal_results_v2%ROWTYPE;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'reconciliationSha256', 'registrationSha256', 'retirementAnchorSha256'
  ];
BEGIN
  -- keep recurring slot retirement behind the owner wrapper
  IF session_user <> 'weather_owner' THEN
    RAISE EXCEPTION 'adjustment registration retirement is owner only' USING ERRCODE = '42501';
  END IF;
  -- require one current authenticated retirement anchor
  IF current_setting('weather.adjustment_maintenance_anchor_kind', true)
      IS DISTINCT FROM 'terminal_registration_retirement'
    OR current_setting('weather.adjustment_maintenance_anchor_sha256', true)
      IS DISTINCT FROM argument->>'retirementAnchorSha256' THEN
    RAISE EXCEPTION 'current terminal retirement anchor is unavailable' USING ERRCODE = '55000';
  END IF;
  -- close the bounded retirement identity tuple
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR NOT (argument->>'registrationSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'reconciliationSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'retirementAnchorSha256' ~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'adjustment registration retirement object is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(argument->>'registrationSha256', 0));
  SELECT * INTO STRICT registration FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = argument->>'registrationSha256' FOR UPDATE;
  SELECT * INTO STRICT terminal FROM adjustment_shadow_terminal_results_v2
  WHERE registration_sha256 = registration.registration_sha256;
  -- require the exact completed reconciliation and empty hot set
  IF terminal.reconciliation_sha256 <> argument->>'reconciliationSha256'
    OR clock_timestamp() < registration.terminal_at
    OR EXISTS (SELECT 1 FROM adjustment_shadow_predictions_v2 prediction
      WHERE prediction.registration_sha256 = registration.registration_sha256) THEN
    RAISE EXCEPTION 'adjustment terminal registration is not retireable' USING ERRCODE = '23514';
  END IF;

  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation', jsonb_build_object(
    'operation', 'retire_terminal',
    'reconciliationSha256', terminal.reconciliation_sha256,
    'registrationSha256', registration.registration_sha256
  )::text, true);
  DELETE FROM adjustment_confirmation_accesses_v2
  WHERE registration_sha256 = registration.registration_sha256;
  DELETE FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = registration.registration_sha256;
  PERFORM set_config('weather.adjustment_maintenance_operation', coalesce(previous_operation, ''), true);
  RETURN jsonb_build_object(
    'reconciliationSha256', terminal.reconciliation_sha256,
    'registrationSha256', registration.registration_sha256,
    'status', 'retired'
  );
END;
$$;

-- remove ambient access to the new tombstone and owner-only operations
REVOKE ALL ON adjustment_shadow_terminal_results_v2
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
REVOKE EXECUTE ON FUNCTION weather_append_adjustment_shadow_v3(jsonb,text),
  weather_guard_adjustment_shadow_terminal_result_v2(),
  weather_record_adjustment_shadow_terminal_result_v2(jsonb),
  weather_retire_adjustment_shadow_registration_v2(jsonb)
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
