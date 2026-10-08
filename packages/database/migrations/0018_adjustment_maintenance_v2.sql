-- retain only value-free adjustment maintenance metadata in PostgreSQL
CREATE TABLE adjustment_shadow_registrations_v2 (
  registration_sha256 char(64) PRIMARY KEY
    CHECK (registration_sha256 ~ '^[a-f0-9]{64}$'),
  site_key text NOT NULL CHECK (site_key = 'ballydidean'),
  family text NOT NULL UNIQUE
    CHECK (family IN ('temperature', 'wind', 'rain')),
  candidate_sha256 char(64) NOT NULL
    CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 char(64) NOT NULL
    CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  policy_sha256 char(64) NOT NULL
    CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  cohort_sha256 char(64) NOT NULL
    CHECK (cohort_sha256 ~ '^[a-f0-9]{64}$'),
  reserved_key_sha256 char(64) NOT NULL
    CHECK (reserved_key_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 char(64) NOT NULL
    CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  interval_start_at timestamptz NOT NULL,
  interval_end_at timestamptz NOT NULL,
  target_cutoff_at timestamptz NOT NULL,
  terminal_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL,
  finalized_metadata_root_sha256 char(64) NOT NULL
    DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    CHECK (finalized_metadata_root_sha256 ~ '^[a-f0-9]{64}$'),
  finalized_prediction_count integer NOT NULL DEFAULT 0
    CHECK (finalized_prediction_count >= 0),
  finalized_through_at timestamptz,
  metadata_generation integer NOT NULL DEFAULT 0
    CHECK (metadata_generation >= 0),
  last_finalization_anchor_sha256 char(64)
    CHECK (last_finalization_anchor_sha256 IS NULL
      OR last_finalization_anchor_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (interval_start_at < interval_end_at
    AND interval_end_at <= target_cutoff_at
    AND target_cutoff_at <= terminal_at),
  CHECK (
    (metadata_generation = 0
      AND finalized_prediction_count = 0
      AND finalized_through_at IS NULL
      AND last_finalization_anchor_sha256 IS NULL)
    OR
    (metadata_generation > 0
      AND finalized_prediction_count > 0
      AND finalized_through_at IS NOT NULL
      AND last_finalization_anchor_sha256 IS NOT NULL)
  )
);

-- retain one compact body receipt per registration due key
CREATE TABLE adjustment_shadow_predictions_v2 (
  prediction_sha256 char(64) PRIMARY KEY
    CHECK (prediction_sha256 ~ '^[a-f0-9]{64}$'),
  registration_sha256 char(64) NOT NULL
    REFERENCES adjustment_shadow_registrations_v2(registration_sha256)
    ON DELETE RESTRICT,
  due_key text NOT NULL
    CHECK (due_key ~ '^capture/[0-9]{4}-[0-9]{2}-[0-9]{2}T(00|06|12|18):35:00[.]000Z$'),
  issued_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL,
  min_valid_at timestamptz NOT NULL,
  max_valid_at timestamptz NOT NULL,
  source_receipt_sha256 char(64) NOT NULL
    CHECK (source_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  input_sha256 char(64) NOT NULL
    CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  prediction_body_sha256 char(64) NOT NULL
    CHECK (prediction_body_sha256 ~ '^[a-f0-9]{64}$'),
  prediction_schema_sha256 char(64) NOT NULL
    CHECK (prediction_schema_sha256 ~ '^[a-f0-9]{64}$'),
  row_count smallint NOT NULL CHECK (row_count > 0),
  body_byte_count integer NOT NULL CHECK (body_byte_count > 0),
  UNIQUE (registration_sha256, due_key),
  CHECK (issued_at <= committed_at AND committed_at < min_valid_at),
  CHECK (min_valid_at <= max_valid_at)
);

-- retain one immutable confirmation burn receipt per registration
CREATE TABLE adjustment_confirmation_accesses_v2 (
  access_sha256 char(64) PRIMARY KEY
    CHECK (access_sha256 ~ '^[a-f0-9]{64}$'),
  registration_sha256 char(64) NOT NULL UNIQUE
    REFERENCES adjustment_shadow_registrations_v2(registration_sha256)
    ON DELETE RESTRICT,
  journal_head_sha256 char(64) NOT NULL
    CHECK (journal_head_sha256 ~ '^[a-f0-9]{64}$'),
  maintenance_anchor_sha256 char(64) NOT NULL
    CHECK (maintenance_anchor_sha256 ~ '^[a-f0-9]{64}$'),
  gate_manifest_sha256 char(64) NOT NULL
    CHECK (gate_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  eligible_prediction_set_sha256 char(64) NOT NULL
    CHECK (eligible_prediction_set_sha256 ~ '^[a-f0-9]{64}$'),
  expected_key_set_sha256 char(64) NOT NULL
    CHECK (expected_key_set_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_root_sha256 char(64) NOT NULL
    CHECK (metadata_root_sha256 ~ '^[a-f0-9]{64}$'),
  target_comparator_snapshot_root_sha256 char(64) NOT NULL
    CHECK (target_comparator_snapshot_root_sha256 ~ '^[a-f0-9]{64}$'),
  revision_catalog_watermark_sha256 char(64) NOT NULL
    CHECK (revision_catalog_watermark_sha256 ~ '^[a-f0-9]{64}$'),
  target_cutoff_at timestamptz NOT NULL,
  accessed_at timestamptz NOT NULL
);

-- assign and validate server-owned registration fields
CREATE FUNCTION weather_guard_adjustment_shadow_registration_v2()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
  computed_identity text;
  start_local_date date;
  end_local_date date;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- admit registration only through the closed function
  IF operation IS NULL OR operation->>'operation' <> 'register' THEN
    RAISE EXCEPTION 'adjustment registration insert requires closed function context'
      USING ERRCODE = '42501';
  END IF;
  -- reject caller-owned identity and clock fields
  IF NEW.registration_sha256 IS NOT NULL OR NEW.registered_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment registration identity and clock are server assigned'
      USING ERRCODE = '23514';
  END IF;

  NEW.registered_at := clock_timestamp();
  start_local_date := (NEW.interval_start_at AT TIME ZONE 'America/Los_Angeles')::date;
  end_local_date := (NEW.interval_end_at AT TIME ZONE 'America/Los_Angeles')::date;
  -- require exact local-midnight intervals and preregistration
  IF NEW.interval_start_at <> start_local_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR NEW.interval_end_at <> end_local_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR NEW.registered_at >= NEW.interval_start_at THEN
    RAISE EXCEPTION 'adjustment registration interval or clock is invalid'
      USING ERRCODE = '23514';
  END IF;
  -- require exact family spans and terminal clocks
  IF (NEW.family IN ('temperature', 'wind')
      AND (end_local_date - start_local_date <> 366
        OR NEW.target_cutoff_at <> NEW.interval_end_at + interval '7 days'
        OR NEW.terminal_at <> NEW.target_cutoff_at))
    OR (NEW.family = 'rain'
      AND (start_local_date <> date '2026-10-31'
        OR end_local_date <> date '2027-09-30'
        OR NEW.target_cutoff_at <> timestamptz '2027-10-07 07:00:00+00'
        OR NEW.terminal_at <> timestamptz '2027-10-07 07:00:00+00')) THEN
    RAISE EXCEPTION 'adjustment registration family span is invalid'
      USING ERRCODE = '23514';
  END IF;

  computed_identity := encode(sha256(convert_to(
    'adjustment-shadow-registration/v2' || E'\n'
      || NEW.site_key || E'\n' || NEW.family || E'\n'
      || NEW.candidate_sha256 || E'\n' || NEW.artifact_sha256 || E'\n'
      || NEW.policy_sha256 || E'\n' || NEW.cohort_sha256 || E'\n'
      || NEW.reserved_key_sha256 || E'\n' || NEW.source_sha256 || E'\n'
      || to_char(NEW.interval_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.interval_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.target_cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || to_char(NEW.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  )), 'hex');
  NEW.registration_sha256 := computed_identity;
  RETURN NEW;
END;
$$;

-- assign and validate server-owned prediction fields
CREATE FUNCTION weather_guard_adjustment_shadow_prediction_v2()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  expected_schema_sha256 text;
  computed_identity text;
  due_at timestamptz;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- admit predictions only through the matching closed function
  IF operation IS NULL OR operation->>'operation' <> 'append'
    OR operation->>'family' NOT IN ('temperature', 'wind', 'rain') THEN
    RAISE EXCEPTION 'adjustment prediction insert requires closed function context'
      USING ERRCODE = '42501';
  END IF;
  -- reject caller-owned identity and clock fields
  IF NEW.prediction_sha256 IS NOT NULL OR NEW.committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment prediction identity and commit clock are server assigned'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = NEW.registration_sha256;
  NEW.committed_at := date_trunc('milliseconds', clock_timestamp());
  due_at := substring(NEW.due_key FROM 9)::timestamptz;
  -- select the exact public wire schema identity
  expected_schema_sha256 := CASE registration.family
    WHEN 'temperature' THEN 'eb9930a1e12919d6f35feb2d402b87b336859b24f031f0e2e3d99168716dc0cd'
    WHEN 'wind' THEN '965272030594b887edf45c62c805f909d148c497d57e803010b6148b25d964d0'
    WHEN 'rain' THEN '5c07000d56ce21824aa545ebb10405dd80ba7c35368397128aa65c4fb799dd46'
  END;
  -- require the matching family and exact fixed schema
  IF registration.family <> operation->>'family'
    OR NEW.prediction_schema_sha256 <> expected_schema_sha256 THEN
    RAISE EXCEPTION 'adjustment prediction family or schema is invalid'
      USING ERRCODE = '23514';
  END IF;
  -- require bounded body metadata for the registered family
  IF (registration.family = 'temperature'
      AND (NEW.row_count > 12 OR NEW.body_byte_count > 8192))
    OR (registration.family = 'wind'
      AND (NEW.row_count > 168 OR NEW.body_byte_count > 65536))
    OR (registration.family = 'rain'
      AND (NEW.row_count > 23 OR NEW.body_byte_count > 12288)) THEN
    RAISE EXCEPTION 'adjustment prediction body bounds are invalid'
      USING ERRCODE = '23514';
  END IF;
  -- require an actual issuance inside the fixed due window
  IF due_at > NEW.issued_at
    OR NEW.issued_at > due_at + interval '12 hours'
    OR NEW.issued_at > NEW.committed_at
    OR NEW.committed_at >= NEW.min_valid_at
    OR NEW.min_valid_at < registration.interval_start_at
    OR NEW.max_valid_at >= registration.interval_end_at THEN
    RAISE EXCEPTION 'adjustment prediction due key or clocks are invalid'
      USING ERRCODE = '23514';
  END IF;

  computed_identity := encode(sha256(convert_to(
    'adjustment-shadow-prediction/v2' || E'\n'
      || NEW.registration_sha256 || E'\n' || NEW.due_key || E'\n'
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

-- assign and validate server-owned access fields
CREATE FUNCTION weather_guard_adjustment_confirmation_access_v2()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
  computed_identity text;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- admit access only through the closed owner function
  IF operation IS NULL OR operation->>'operation' <> 'record_access' THEN
    RAISE EXCEPTION 'adjustment access insert requires closed function context'
      USING ERRCODE = '42501';
  END IF;
  -- reject caller-owned identity and clock fields
  IF NEW.access_sha256 IS NOT NULL OR NEW.accessed_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment access identity and clock are server assigned'
      USING ERRCODE = '23514';
  END IF;

  NEW.accessed_at := clock_timestamp();
  computed_identity := encode(sha256(convert_to(
    'adjustment-confirmation-access/v2' || E'\n'
      || NEW.registration_sha256 || E'\n' || NEW.journal_head_sha256 || E'\n'
      || NEW.maintenance_anchor_sha256 || E'\n' || NEW.gate_manifest_sha256 || E'\n'
      || NEW.eligible_prediction_set_sha256 || E'\n' || NEW.expected_key_set_sha256 || E'\n'
      || NEW.metadata_root_sha256 || E'\n'
      || NEW.target_comparator_snapshot_root_sha256 || E'\n'
      || NEW.revision_catalog_watermark_sha256 || E'\n'
      || to_char(NEW.target_cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  )), 'hex');
  NEW.access_sha256 := computed_identity;
  RETURN NEW;
END;
$$;

-- reject mutation outside one exact finalization context
CREATE FUNCTION weather_reject_adjustment_maintenance_mutation()
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
    RAISE EXCEPTION 'adjustment maintenance tables are not truncatable'
      USING ERRCODE = '42501';
  END IF;

  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- reject mutation without exact finalization context
  IF operation IS NULL OR operation->>'operation' <> 'finalize'
    OR operation->>'registrationSha256' IS NULL
    OR operation->>'metadataManifestSha256' IS NULL THEN
    RAISE EXCEPTION 'adjustment maintenance rows are immutable'
      USING ERRCODE = '42501';
  END IF;

  -- admit only the five-field one-generation registration transition
  IF TG_TABLE_NAME = 'adjustment_shadow_registrations_v2' AND TG_OP = 'UPDATE' THEN
    -- validate the exact accumulator delta and frozen fields
    IF OLD.registration_sha256 <> operation->>'registrationSha256'
      OR NEW.metadata_generation <> OLD.metadata_generation + 1
      OR NEW.metadata_generation <> (operation->>'generation')::integer
      OR NEW.finalized_metadata_root_sha256 <> operation->>'newMetadataRootSha256'
      OR NEW.finalized_prediction_count
        <> OLD.finalized_prediction_count + (operation->>'rowCount')::integer
      OR NEW.finalized_through_at
        <> (operation->>'throughCommittedAt')::timestamptz
      OR NEW.last_finalization_anchor_sha256 <> operation->>'maintenanceAnchorSha256'
      OR ROW(
        NEW.registration_sha256, NEW.site_key, NEW.family,
        NEW.candidate_sha256, NEW.artifact_sha256, NEW.policy_sha256,
        NEW.cohort_sha256, NEW.reserved_key_sha256, NEW.source_sha256,
        NEW.interval_start_at, NEW.interval_end_at, NEW.target_cutoff_at, NEW.terminal_at,
        NEW.registered_at
      ) IS DISTINCT FROM ROW(
        OLD.registration_sha256, OLD.site_key, OLD.family,
        OLD.candidate_sha256, OLD.artifact_sha256, OLD.policy_sha256,
        OLD.cohort_sha256, OLD.reserved_key_sha256, OLD.source_sha256,
        OLD.interval_start_at, OLD.interval_end_at, OLD.target_cutoff_at, OLD.terminal_at,
        OLD.registered_at
      ) THEN
      RAISE EXCEPTION 'adjustment registration transition is invalid'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- admit only exact compact rows selected by finalization
  IF TG_TABLE_NAME = 'adjustment_shadow_predictions_v2' AND TG_OP = 'DELETE' THEN
    -- validate the exact selected registration and commit interval
    IF OLD.registration_sha256 <> operation->>'registrationSha256'
      OR OLD.committed_at < (operation->>'fromCommittedAt')::timestamptz
      OR OLD.committed_at > (operation->>'throughCommittedAt')::timestamptz THEN
      RAISE EXCEPTION 'adjustment prediction deletion is invalid'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- admit terminal access removal only with final disposition
  IF TG_TABLE_NAME = 'adjustment_confirmation_accesses_v2' AND TG_OP = 'DELETE' THEN
    -- validate the exact terminal access identity
    IF operation->>'finalDisposition' <> 'final'
      OR OLD.registration_sha256 <> operation->>'registrationSha256' THEN
      RAISE EXCEPTION 'adjustment access deletion is invalid'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- admit terminal registration removal only with no hot row
  IF TG_TABLE_NAME = 'adjustment_shadow_registrations_v2' AND TG_OP = 'DELETE' THEN
    -- validate the exact terminal registration state
    IF operation->>'finalDisposition' <> 'final'
      OR OLD.registration_sha256 <> operation->>'registrationSha256'
      OR EXISTS (
        SELECT 1 FROM adjustment_shadow_predictions_v2 prediction
        WHERE prediction.registration_sha256 = OLD.registration_sha256
      ) THEN
      RAISE EXCEPTION 'adjustment registration deletion is invalid'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'adjustment maintenance mutation is invalid'
    USING ERRCODE = '42501';
END;
$$;

-- guard every insert through a server-owned field allocator
CREATE TRIGGER adjustment_shadow_registrations_v2_guard_insert
BEFORE INSERT ON adjustment_shadow_registrations_v2
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_shadow_registration_v2();
CREATE TRIGGER adjustment_shadow_predictions_v2_guard_insert
BEFORE INSERT ON adjustment_shadow_predictions_v2
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_shadow_prediction_v2();
CREATE TRIGGER adjustment_confirmation_accesses_v2_guard_insert
BEFORE INSERT ON adjustment_confirmation_accesses_v2
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_confirmation_access_v2();

-- reject direct row mutation and truncation
CREATE TRIGGER adjustment_shadow_registrations_v2_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_shadow_registrations_v2
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();
CREATE TRIGGER adjustment_shadow_predictions_v2_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_shadow_predictions_v2
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();
CREATE TRIGGER adjustment_confirmation_accesses_v2_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_confirmation_accesses_v2
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();
CREATE TRIGGER adjustment_shadow_registrations_v2_guard_truncate
BEFORE TRUNCATE ON adjustment_shadow_registrations_v2
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();
CREATE TRIGGER adjustment_shadow_predictions_v2_guard_truncate
BEFORE TRUNCATE ON adjustment_shadow_predictions_v2
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();
CREATE TRIGGER adjustment_confirmation_accesses_v2_guard_truncate
BEFORE TRUNCATE ON adjustment_confirmation_accesses_v2
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_maintenance_mutation();

-- register one frozen family slot through a closed role-specific API
CREATE FUNCTION weather_register_adjustment_shadow_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted adjustment_shadow_registrations_v2%ROWTYPE;
  existing adjustment_shadow_registrations_v2%ROWTYPE;
  supplied_identity text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'artifactSha256', 'candidateSha256', 'cohortSha256', 'family',
    'intervalEndAt', 'intervalStartAt', 'policySha256', 'registrationSha256',
    'reservedKeySha256', 'siteKey', 'sourceSha256', 'targetCutoffAt', 'terminalAt'
  ];
BEGIN
  -- require administrator activation for this exact database role
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require one bounded closed object
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb) THEN
    RAISE EXCEPTION 'adjustment registration object is invalid' USING ERRCODE = '22023';
  END IF;
  -- constrain registration authority by login role and family
  IF (session_user = 'weather_api' AND argument->>'family' NOT IN ('temperature', 'wind'))
    OR (session_user = 'weather_ingest' AND argument->>'family' <> 'rain')
    OR session_user NOT IN ('weather_api', 'weather_ingest', 'weather_owner') THEN
    RAISE EXCEPTION 'adjustment registration family is unauthorized' USING ERRCODE = '42501';
  END IF;

  supplied_identity := argument->>'registrationSha256';
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'register')::text,
    true
  );
  INSERT INTO adjustment_shadow_registrations_v2 (
    registration_sha256, site_key, family, candidate_sha256,
    artifact_sha256, policy_sha256, cohort_sha256, reserved_key_sha256,
    source_sha256, interval_start_at, interval_end_at, target_cutoff_at,
    terminal_at, registered_at
  ) VALUES (
    NULL, argument->>'siteKey', argument->>'family', argument->>'candidateSha256',
    argument->>'artifactSha256', argument->>'policySha256', argument->>'cohortSha256',
    argument->>'reservedKeySha256', argument->>'sourceSha256',
    (argument->>'intervalStartAt')::timestamptz,
    (argument->>'intervalEndAt')::timestamptz,
    (argument->>'targetCutoffAt')::timestamptz,
    (argument->>'terminalAt')::timestamptz, NULL
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the recomputed identity
  IF inserted.registration_sha256 IS NOT NULL
    AND inserted.registration_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment registration identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require byte-identical retry after either unique conflict
  IF inserted.registration_sha256 IS NULL THEN
    SELECT * INTO existing
    FROM adjustment_shadow_registrations_v2
    WHERE registration_sha256 = supplied_identity
      OR family = argument->>'family';
    -- compare every frozen registration field
    IF NOT FOUND OR ROW(
      existing.registration_sha256, existing.site_key, existing.family,
      existing.candidate_sha256, existing.artifact_sha256, existing.policy_sha256,
      existing.cohort_sha256, existing.reserved_key_sha256, existing.source_sha256,
      existing.interval_start_at, existing.interval_end_at,
      existing.target_cutoff_at, existing.terminal_at
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), argument->>'siteKey', argument->>'family',
      (argument->>'candidateSha256')::char(64), (argument->>'artifactSha256')::char(64),
      (argument->>'policySha256')::char(64), (argument->>'cohortSha256')::char(64),
      (argument->>'reservedKeySha256')::char(64), (argument->>'sourceSha256')::char(64),
      (argument->>'intervalStartAt')::timestamptz,
      (argument->>'intervalEndAt')::timestamptz,
      (argument->>'targetCutoffAt')::timestamptz,
      (argument->>'terminalAt')::timestamptz
    ) THEN
      RAISE EXCEPTION 'adjustment registration retry differs' USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'inserted', inserted.registration_sha256 IS NOT NULL,
    'registrationSha256', supplied_identity
  );
END;
$$;

-- append one family-bound compact receipt
CREATE FUNCTION weather_append_adjustment_wind_shadow_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted adjustment_shadow_predictions_v2%ROWTYPE;
  existing adjustment_shadow_predictions_v2%ROWTYPE;
  family constant text := 'wind';
  supplied_identity text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'bodyByteCount', 'dueKey', 'inputSha256', 'issuedAt', 'maxValidAt',
    'minValidAt', 'predictionBodySha256', 'predictionSchemaSha256',
    'predictionSha256', 'registrationSha256', 'rowCount', 'sourceReceiptSha256'
  ];
BEGIN
  -- require administrator activation for this exact database role
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require the matching API role and family
  IF family NOT IN ('temperature', 'wind')
    OR session_user NOT IN ('weather_api', 'weather_owner') THEN
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
  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'append', 'family', family)::text,
    true
  );
  INSERT INTO adjustment_shadow_predictions_v2 (
    prediction_sha256, registration_sha256, due_key, issued_at, committed_at,
    min_valid_at, max_valid_at, source_receipt_sha256, input_sha256,
    prediction_body_sha256, prediction_schema_sha256, row_count, body_byte_count
  ) VALUES (
    NULL, argument->>'registrationSha256', argument->>'dueKey',
    (argument->>'issuedAt')::timestamptz, NULL,
    (argument->>'minValidAt')::timestamptz, (argument->>'maxValidAt')::timestamptz,
    argument->>'sourceReceiptSha256', argument->>'inputSha256',
    argument->>'predictionBodySha256', argument->>'predictionSchemaSha256',
    (argument->>'rowCount')::smallint, (argument->>'bodyByteCount')::integer
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the recomputed identity
  IF inserted.prediction_sha256 IS NOT NULL
    AND inserted.prediction_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment prediction identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require byte-identical retry after either unique conflict
  IF inserted.prediction_sha256 IS NULL THEN
    SELECT * INTO existing
    FROM adjustment_shadow_predictions_v2
    WHERE prediction_sha256 = supplied_identity
      OR (registration_sha256 = argument->>'registrationSha256'
        AND due_key = argument->>'dueKey');
    -- compare every compact prediction field
    IF NOT FOUND OR ROW(
      existing.prediction_sha256, existing.registration_sha256, existing.due_key,
      existing.issued_at, existing.min_valid_at, existing.max_valid_at,
      existing.source_receipt_sha256, existing.input_sha256,
      existing.prediction_body_sha256, existing.prediction_schema_sha256,
      existing.row_count, existing.body_byte_count
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), (argument->>'registrationSha256')::char(64),
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

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'committedAt', to_char(coalesce(inserted.committed_at, existing.committed_at)
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'inserted', inserted.prediction_sha256 IS NOT NULL,
    'predictionSha256', supplied_identity
  );
END;
$$;

-- append one temperature compact receipt
CREATE FUNCTION weather_append_adjustment_temperature_shadow_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted adjustment_shadow_predictions_v2%ROWTYPE;
  existing adjustment_shadow_predictions_v2%ROWTYPE;
  family constant text := 'temperature';
  supplied_identity text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'bodyByteCount', 'dueKey', 'inputSha256', 'issuedAt', 'maxValidAt',
    'minValidAt', 'predictionBodySha256', 'predictionSchemaSha256',
    'predictionSha256', 'registrationSha256', 'rowCount', 'sourceReceiptSha256'
  ];
BEGIN
  -- require administrator activation for this exact database role
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require the matching API role and family
  IF family NOT IN ('temperature', 'wind')
    OR session_user NOT IN ('weather_api', 'weather_owner') THEN
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
  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'append', 'family', family)::text,
    true
  );
  INSERT INTO adjustment_shadow_predictions_v2 (
    prediction_sha256, registration_sha256, due_key, issued_at, committed_at,
    min_valid_at, max_valid_at, source_receipt_sha256, input_sha256,
    prediction_body_sha256, prediction_schema_sha256, row_count, body_byte_count
  ) VALUES (
    NULL, argument->>'registrationSha256', argument->>'dueKey',
    (argument->>'issuedAt')::timestamptz, NULL,
    (argument->>'minValidAt')::timestamptz, (argument->>'maxValidAt')::timestamptz,
    argument->>'sourceReceiptSha256', argument->>'inputSha256',
    argument->>'predictionBodySha256', argument->>'predictionSchemaSha256',
    (argument->>'rowCount')::smallint, (argument->>'bodyByteCount')::integer
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the recomputed identity
  IF inserted.prediction_sha256 IS NOT NULL
    AND inserted.prediction_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment prediction identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require byte-identical retry after either unique conflict
  IF inserted.prediction_sha256 IS NULL THEN
    SELECT * INTO existing
    FROM adjustment_shadow_predictions_v2
    WHERE prediction_sha256 = supplied_identity
      OR (registration_sha256 = argument->>'registrationSha256'
        AND due_key = argument->>'dueKey');
    -- compare every compact prediction field
    IF NOT FOUND OR ROW(
      existing.prediction_sha256, existing.registration_sha256, existing.due_key,
      existing.issued_at, existing.min_valid_at, existing.max_valid_at,
      existing.source_receipt_sha256, existing.input_sha256,
      existing.prediction_body_sha256, existing.prediction_schema_sha256,
      existing.row_count, existing.body_byte_count
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), (argument->>'registrationSha256')::char(64),
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

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'committedAt', to_char(coalesce(inserted.committed_at, existing.committed_at)
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'inserted', inserted.prediction_sha256 IS NOT NULL,
    'predictionSha256', supplied_identity
  );
END;
$$;

-- append one rain compact receipt without sharing API authority
CREATE FUNCTION weather_append_adjustment_rain_shadow_v2(argument jsonb)
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
    'bodyByteCount', 'dueKey', 'inputSha256', 'issuedAt', 'maxValidAt',
    'minValidAt', 'predictionBodySha256', 'predictionSchemaSha256',
    'predictionSha256', 'registrationSha256', 'rowCount', 'sourceReceiptSha256'
  ];
BEGIN
  -- require administrator activation for this exact database role
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require only the ingest login or owner wrapper
  IF session_user NOT IN ('weather_ingest', 'weather_owner') THEN
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
  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'append', 'family', 'rain')::text,
    true
  );
  INSERT INTO adjustment_shadow_predictions_v2 (
    prediction_sha256, registration_sha256, due_key, issued_at, committed_at,
    min_valid_at, max_valid_at, source_receipt_sha256, input_sha256,
    prediction_body_sha256, prediction_schema_sha256, row_count, body_byte_count
  ) VALUES (
    NULL, argument->>'registrationSha256', argument->>'dueKey',
    (argument->>'issuedAt')::timestamptz, NULL,
    (argument->>'minValidAt')::timestamptz, (argument->>'maxValidAt')::timestamptz,
    argument->>'sourceReceiptSha256', argument->>'inputSha256',
    argument->>'predictionBodySha256', argument->>'predictionSchemaSha256',
    (argument->>'rowCount')::smallint, (argument->>'bodyByteCount')::integer
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the recomputed identity
  IF inserted.prediction_sha256 IS NOT NULL
    AND inserted.prediction_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment prediction identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require byte-identical retry after either unique conflict
  IF inserted.prediction_sha256 IS NULL THEN
    SELECT * INTO existing
    FROM adjustment_shadow_predictions_v2
    WHERE prediction_sha256 = supplied_identity
      OR (registration_sha256 = argument->>'registrationSha256'
        AND due_key = argument->>'dueKey');
    -- compare every compact prediction field
    IF NOT FOUND OR ROW(
      existing.prediction_sha256, existing.registration_sha256, existing.due_key,
      existing.issued_at, existing.min_valid_at, existing.max_valid_at,
      existing.source_receipt_sha256, existing.input_sha256,
      existing.prediction_body_sha256, existing.prediction_schema_sha256,
      existing.row_count, existing.body_byte_count
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), (argument->>'registrationSha256')::char(64),
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

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'committedAt', to_char(coalesce(inserted.committed_at, existing.committed_at)
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'inserted', inserted.prediction_sha256 IS NOT NULL,
    'predictionSha256', supplied_identity
  );
END;
$$;

-- answer one exact body-admission tuple without enumeration
CREATE FUNCTION adjustment_shadow_body_admission_v2(
  registration_identity text,
  due_identity text,
  body_identity text,
  body_bytes integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- refuse use before explicit administrator activation
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM adjustment_shadow_predictions_v2 prediction
    WHERE prediction.registration_sha256 = registration_identity
      AND prediction.due_key = due_identity
      AND prediction.prediction_body_sha256 = body_identity
      AND prediction.body_byte_count = body_bytes
  );
END;
$$;

-- finalize one exact cold-transferred compact-row generation
CREATE FUNCTION weather_finalize_adjustment_shadow_metadata_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  compact_manifest jsonb;
  manifest_sha256 text;
  successor_sha256 text;
  selected_count integer;
  operation jsonb;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'coldCommitSha256', 'expectedPreviousMetadataRootSha256', 'finalDisposition',
    'fromCommittedAt', 'generation', 'maintenanceAnchorSha256',
    'metadataManifestSha256', 'newMetadataRootSha256', 'registrationSha256',
    'rowCount', 'throughCommittedAt'
  ];
BEGIN
  -- restrict finalization to the owner login
  IF session_user <> 'weather_owner' THEN
    RAISE EXCEPTION 'adjustment finalization is owner only' USING ERRCODE = '42501';
  END IF;
  -- require explicit administrator activation for the owner
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require the authenticated current transfer anchor
  IF current_setting('weather.adjustment_maintenance_anchor_kind', true)
      IS DISTINCT FROM 'shadow_metadata_transfer'
    OR current_setting('weather.adjustment_maintenance_anchor_sha256', true)
      IS DISTINCT FROM argument->>'maintenanceAnchorSha256' THEN
    RAISE EXCEPTION 'current shadow metadata transfer anchor is unavailable'
      USING ERRCODE = '55000';
  END IF;
  -- require the exact bounded finalization object
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb)
    OR argument->>'finalDisposition' NOT IN ('retain', 'final')
    OR (argument->>'rowCount')::integer <= 0
    OR (argument->>'fromCommittedAt')::timestamptz
      > (argument->>'throughCommittedAt')::timestamptz
    OR NOT (
      argument->>'registrationSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'metadataManifestSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'expectedPreviousMetadataRootSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'newMetadataRootSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'coldCommitSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'maintenanceAnchorSha256' ~ '^[a-f0-9]{64}$'
    ) THEN
    RAISE EXCEPTION 'adjustment finalization object is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(argument->>'registrationSha256', 0));
  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = argument->>'registrationSha256'
  FOR UPDATE;

  successor_sha256 := encode(sha256(convert_to(
    (argument->>'expectedPreviousMetadataRootSha256') || E'\n'
      || (argument->>'metadataManifestSha256') || E'\n'
      || (argument->>'generation') || E'\n' || (argument->>'rowCount') || E'\n'
      || to_char((argument->>'throughCommittedAt')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
      || (argument->>'coldCommitSha256') || E'\n'
      || (argument->>'maintenanceAnchorSha256'),
    'UTF8'
  )), 'hex');
  -- return only an exact completed-generation retry
  IF registration.metadata_generation = (argument->>'generation')::integer THEN
    -- bind retry fields through the deterministic successor hash
    IF registration.finalized_metadata_root_sha256 <> argument->>'newMetadataRootSha256'
      OR successor_sha256 <> argument->>'newMetadataRootSha256'
      OR registration.finalized_through_at
        <> (argument->>'throughCommittedAt')::timestamptz
      OR registration.last_finalization_anchor_sha256
        <> argument->>'maintenanceAnchorSha256' THEN
      RAISE EXCEPTION 'adjustment finalization retry differs' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'generation', registration.metadata_generation,
      'registrationSha256', registration.registration_sha256,
      'status', 'already_finalized'
    );
  END IF;
  -- require one successor generation and previous root
  IF (argument->>'generation')::integer <> registration.metadata_generation + 1
    OR argument->>'expectedPreviousMetadataRootSha256'
      <> registration.finalized_metadata_root_sha256 THEN
    RAISE EXCEPTION 'adjustment finalization generation is invalid' USING ERRCODE = '40001';
  END IF;

  SELECT
    count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'bodyByteCount', prediction.body_byte_count,
      'committedAt', to_char(prediction.committed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dueKey', prediction.due_key,
      'inputSha256', prediction.input_sha256,
      'issuedAt', to_char(prediction.issued_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'maxValidAt', to_char(prediction.max_valid_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minValidAt', to_char(prediction.min_valid_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'predictionBodySha256', prediction.prediction_body_sha256,
      'predictionSchemaSha256', prediction.prediction_schema_sha256,
      'predictionSha256', prediction.prediction_sha256,
      'rowCount', prediction.row_count,
      'sourceReceiptSha256', prediction.source_receipt_sha256
    ) ORDER BY prediction.prediction_sha256), '[]'::jsonb)
  INTO selected_count, compact_manifest
  FROM adjustment_shadow_predictions_v2 prediction
  WHERE prediction.registration_sha256 = registration.registration_sha256
    AND prediction.committed_at >= (argument->>'fromCommittedAt')::timestamptz
    AND prediction.committed_at <= (argument->>'throughCommittedAt')::timestamptz;
  manifest_sha256 := encode(sha256(convert_to(compact_manifest::text, 'UTF8')), 'hex');
  -- require the exact selected compact-row manifest and successor root
  IF selected_count <> (argument->>'rowCount')::integer
    OR manifest_sha256 <> argument->>'metadataManifestSha256'
    OR successor_sha256 <> argument->>'newMetadataRootSha256' THEN
    RAISE EXCEPTION 'adjustment finalization manifest is invalid' USING ERRCODE = '23514';
  END IF;

  operation := jsonb_build_object(
    'finalDisposition', argument->>'finalDisposition',
    'fromCommittedAt', argument->>'fromCommittedAt',
    'generation', (argument->>'generation')::integer,
    'maintenanceAnchorSha256', argument->>'maintenanceAnchorSha256',
    'metadataManifestSha256', manifest_sha256,
    'newMetadataRootSha256', successor_sha256,
    'operation', 'finalize',
    'registrationSha256', registration.registration_sha256,
    'rowCount', selected_count,
    'throughCommittedAt', argument->>'throughCommittedAt'
  );
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation', operation::text, true);
  UPDATE adjustment_shadow_registrations_v2
  SET finalized_metadata_root_sha256 = successor_sha256,
      finalized_prediction_count = finalized_prediction_count + selected_count,
      finalized_through_at = (argument->>'throughCommittedAt')::timestamptz,
      metadata_generation = (argument->>'generation')::integer,
      last_finalization_anchor_sha256 = argument->>'maintenanceAnchorSha256'
  WHERE registration_sha256 = registration.registration_sha256;
  DELETE FROM adjustment_shadow_predictions_v2
  WHERE registration_sha256 = registration.registration_sha256
    AND committed_at >= (argument->>'fromCommittedAt')::timestamptz
    AND committed_at <= (argument->>'throughCommittedAt')::timestamptz;

  -- remove only a fully cold terminal registration
  IF argument->>'finalDisposition' = 'final' THEN
    -- reject terminal removal while any compact row remains hot
    IF EXISTS (
      SELECT 1 FROM adjustment_shadow_predictions_v2 prediction
      WHERE prediction.registration_sha256 = registration.registration_sha256
    ) THEN
      RAISE EXCEPTION 'final adjustment disposition retains hot predictions'
        USING ERRCODE = '23514';
    END IF;
    DELETE FROM adjustment_confirmation_accesses_v2
    WHERE registration_sha256 = registration.registration_sha256;
    DELETE FROM adjustment_shadow_registrations_v2
    WHERE registration_sha256 = registration.registration_sha256;
  END IF;

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'generation', (argument->>'generation')::integer,
    'metadataManifestSha256', manifest_sha256,
    'newMetadataRootSha256', successor_sha256,
    'registrationSha256', registration.registration_sha256,
    'status', 'finalized'
  );
END;
$$;

-- record one anchored confirmation burn after value-free reconstruction
CREATE FUNCTION weather_record_adjustment_confirmation_access_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  inserted adjustment_confirmation_accesses_v2%ROWTYPE;
  existing adjustment_confirmation_accesses_v2%ROWTYPE;
  hot_manifest jsonb;
  hot_root_sha256 text;
  combined_metadata_root_sha256 text;
  supplied_identity text;
  previous_operation text;
  allowed_keys constant text[] := ARRAY[
    'accessSha256', 'eligiblePredictionSetSha256', 'expectedKeySetSha256',
    'gateManifestSha256', 'journalHeadSha256', 'maintenanceAnchorSha256',
    'metadataRootSha256', 'registrationSha256', 'revisionCatalogWatermarkSha256',
    'targetComparatorSnapshotRootSha256', 'targetCutoffAt'
  ];
BEGIN
  -- restrict burn recording to the owner login
  IF session_user <> 'weather_owner' THEN
    RAISE EXCEPTION 'adjustment access is owner only' USING ERRCODE = '42501';
  END IF;
  -- require explicit administrator activation for the owner
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require the authenticated current burn anchor and reconstructed eligible root
  IF current_setting('weather.adjustment_maintenance_anchor_kind', true)
      IS DISTINCT FROM 'confirmation_accessed'
    OR current_setting('weather.adjustment_maintenance_anchor_sha256', true)
      IS DISTINCT FROM argument->>'maintenanceAnchorSha256'
    OR current_setting('weather.adjustment_eligible_prediction_set_sha256', true)
      IS DISTINCT FROM argument->>'eligiblePredictionSetSha256' THEN
    RAISE EXCEPTION 'current confirmation access anchor is unavailable'
      USING ERRCODE = '55000';
  END IF;
  -- require the exact bounded access object
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb)
    OR NOT (
      argument->>'registrationSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'accessSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'journalHeadSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'maintenanceAnchorSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'gateManifestSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'eligiblePredictionSetSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'expectedKeySetSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'metadataRootSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'targetComparatorSnapshotRootSha256' ~ '^[a-f0-9]{64}$'
      AND argument->>'revisionCatalogWatermarkSha256' ~ '^[a-f0-9]{64}$'
    ) THEN
    RAISE EXCEPTION 'adjustment access object is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(argument->>'registrationSha256', 0));
  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = argument->>'registrationSha256';
  -- require terminal clocks and the frozen expected-key root
  IF clock_timestamp() < registration.terminal_at
    OR (argument->>'targetCutoffAt')::timestamptz <> registration.target_cutoff_at
    OR argument->>'expectedKeySetSha256' <> registration.reserved_key_sha256
    OR registration.metadata_generation = 0 THEN
    RAISE EXCEPTION 'adjustment access registration state is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dueKey', prediction.due_key,
    'maxValidAt', to_char(prediction.max_valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minValidAt', to_char(prediction.min_valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'predictionSha256', prediction.prediction_sha256,
    'rowCount', prediction.row_count
  ) ORDER BY prediction.prediction_sha256), '[]'::jsonb)
  INTO hot_manifest
  FROM adjustment_shadow_predictions_v2 prediction
  WHERE prediction.registration_sha256 = registration.registration_sha256;
  hot_root_sha256 := encode(sha256(convert_to(hot_manifest::text, 'UTF8')), 'hex');
  combined_metadata_root_sha256 := encode(sha256(convert_to(
    registration.finalized_metadata_root_sha256 || E'\n'
      || hot_root_sha256 || E'\n'
      || registration.finalized_prediction_count::text || E'\n'
      || jsonb_array_length(hot_manifest)::text || E'\n'
      || registration.metadata_generation::text,
    'UTF8'
  )), 'hex');
  -- bind the exact finalized accumulator and remaining hot set
  IF argument->>'metadataRootSha256' <> combined_metadata_root_sha256 THEN
    RAISE EXCEPTION 'adjustment access metadata root is invalid' USING ERRCODE = '23514';
  END IF;

  supplied_identity := argument->>'accessSha256';
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'record_access')::text,
    true
  );
  INSERT INTO adjustment_confirmation_accesses_v2 (
    access_sha256, registration_sha256, journal_head_sha256,
    maintenance_anchor_sha256, gate_manifest_sha256,
    eligible_prediction_set_sha256, expected_key_set_sha256,
    metadata_root_sha256, target_comparator_snapshot_root_sha256,
    revision_catalog_watermark_sha256, target_cutoff_at, accessed_at
  ) VALUES (
    NULL, registration.registration_sha256, argument->>'journalHeadSha256',
    argument->>'maintenanceAnchorSha256', argument->>'gateManifestSha256',
    argument->>'eligiblePredictionSetSha256', argument->>'expectedKeySetSha256',
    argument->>'metadataRootSha256', argument->>'targetComparatorSnapshotRootSha256',
    argument->>'revisionCatalogWatermarkSha256',
    (argument->>'targetCutoffAt')::timestamptz, NULL
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO inserted;

  -- accept only the recomputed identity
  IF inserted.access_sha256 IS NOT NULL AND inserted.access_sha256 <> supplied_identity THEN
    RAISE EXCEPTION 'adjustment access identity is invalid' USING ERRCODE = '23514';
  END IF;
  -- require byte-identical retry after either unique conflict
  IF inserted.access_sha256 IS NULL THEN
    SELECT * INTO existing
    FROM adjustment_confirmation_accesses_v2
    WHERE access_sha256 = supplied_identity
      OR registration_sha256 = registration.registration_sha256;
    -- compare every frozen access field
    IF NOT FOUND OR ROW(
      existing.access_sha256, existing.registration_sha256,
      existing.journal_head_sha256, existing.maintenance_anchor_sha256,
      existing.gate_manifest_sha256, existing.eligible_prediction_set_sha256,
      existing.expected_key_set_sha256, existing.metadata_root_sha256,
      existing.target_comparator_snapshot_root_sha256,
      existing.revision_catalog_watermark_sha256, existing.target_cutoff_at
    ) IS DISTINCT FROM ROW(
      supplied_identity::char(64), registration.registration_sha256,
      (argument->>'journalHeadSha256')::char(64),
      (argument->>'maintenanceAnchorSha256')::char(64),
      (argument->>'gateManifestSha256')::char(64),
      (argument->>'eligiblePredictionSetSha256')::char(64),
      (argument->>'expectedKeySetSha256')::char(64),
      (argument->>'metadataRootSha256')::char(64),
      (argument->>'targetComparatorSnapshotRootSha256')::char(64),
      (argument->>'revisionCatalogWatermarkSha256')::char(64),
      (argument->>'targetCutoffAt')::timestamptz
    ) THEN
      RAISE EXCEPTION 'adjustment access retry differs' USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM set_config(
    'weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''),
    true
  );
  RETURN jsonb_build_object(
    'accessSha256', supplied_identity,
    'hotSetRootSha256', hot_root_sha256,
    'inserted', inserted.access_sha256 IS NOT NULL,
    'metadataRootSha256', combined_metadata_root_sha256
  );
END;
$$;

-- return bounded value-free hot availability for one registration
CREATE FUNCTION adjustment_confirmation_availability_v2(registration_identity text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  hot_manifest jsonb;
  hot_root_sha256 text;
  result jsonb;
BEGIN
  -- require explicit administrator activation for the exporter
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = registration_identity;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dueKey', prediction.due_key,
    'maxValidAt', to_char(prediction.max_valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minValidAt', to_char(prediction.min_valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'predictionSha256', prediction.prediction_sha256,
    'rowCount', prediction.row_count
  ) ORDER BY prediction.prediction_sha256), '[]'::jsonb)
  INTO hot_manifest
  FROM adjustment_shadow_predictions_v2 prediction
  WHERE prediction.registration_sha256 = registration.registration_sha256;
  hot_root_sha256 := encode(sha256(convert_to(hot_manifest::text, 'UTF8')), 'hex');
  result := jsonb_build_object(
    'contractVersion', 'adjustment-confirmation-availability/v2',
    'family', registration.family,
    'finalizedMetadataRootSha256', registration.finalized_metadata_root_sha256,
    'finalizedPredictionCount', registration.finalized_prediction_count,
    'finalizedThroughAt', CASE
      WHEN registration.finalized_through_at IS NULL THEN NULL
      ELSE to_char(registration.finalized_through_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    END,
    'hotPredictionCount', jsonb_array_length(hot_manifest),
    'hotPredictions', hot_manifest,
    'hotSetRootSha256', hot_root_sha256,
    'intervalEndAt', to_char(registration.interval_end_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'intervalStartAt', to_char(registration.interval_start_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'metadataGeneration', registration.metadata_generation,
    'missingExpectedDueKeys', NULL,
    'missingExpectedDueKeysStatus', 'requires_anchored_cold_reconstruction',
    'expectedKeySetSha256', registration.reserved_key_sha256,
    'registrationSha256', registration.registration_sha256,
    'targetCutoffAt', to_char(registration.target_cutoff_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  -- enforce the fixed export envelope
  IF octet_length(convert_to(result::text, 'UTF8')) > 524288 THEN
    RAISE EXCEPTION 'adjustment availability exceeds fixed bound' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END;
$$;

-- authorize one deterministic post-burn fourteen-date chunk
CREATE FUNCTION adjustment_confirmation_export_v2(
  registration_identity text,
  access_identity text,
  chunk_index smallint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  registration adjustment_shadow_registrations_v2%ROWTYPE;
  access adjustment_confirmation_accesses_v2%ROWTYPE;
  interval_start_date date;
  interval_end_date date;
  from_date date;
  to_date date;
  chunk_count smallint;
BEGIN
  -- require explicit administrator activation for the exporter
  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO STRICT registration
  FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = registration_identity;
  SELECT * INTO STRICT access
  FROM adjustment_confirmation_accesses_v2
  WHERE access_sha256 = access_identity
    AND registration_sha256 = registration.registration_sha256;
  chunk_count := CASE WHEN registration.family = 'rain' THEN 24 ELSE 27 END;
  -- reject every noncanonical index and root association
  IF chunk_index IS NULL OR chunk_index < 0 OR chunk_index >= chunk_count
    OR access.expected_key_set_sha256 <> registration.reserved_key_sha256
    OR access.metadata_root_sha256 IS NULL
    OR access.target_comparator_snapshot_root_sha256 IS NULL
    OR access.revision_catalog_watermark_sha256 IS NULL THEN
    RAISE EXCEPTION 'adjustment confirmation export authorization is invalid'
      USING ERRCODE = '22023';
  END IF;

  interval_start_date :=
    (registration.interval_start_at AT TIME ZONE 'America/Los_Angeles')::date;
  interval_end_date :=
    (registration.interval_end_at AT TIME ZONE 'America/Los_Angeles')::date;
  from_date := interval_start_date + chunk_index::integer * 14;
  to_date := least(from_date + 14, interval_end_date);
  -- reject range drift from the deterministic partition
  IF from_date >= interval_end_date
    OR (chunk_index < chunk_count - 1 AND to_date - from_date <> 14)
    OR (registration.family IN ('temperature', 'wind')
      AND chunk_index = 26 AND to_date - from_date <> 2)
    OR (registration.family = 'rain'
      AND chunk_index = 23 AND to_date - from_date <> 12) THEN
    RAISE EXCEPTION 'adjustment confirmation chunk range is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'accessSha256', access.access_sha256,
    'chunkCount', chunk_count,
    'chunkIndex', chunk_index,
    'contractVersion', 'adjustment-confirmation-export-authorization/v2',
    'eligiblePredictionSetSha256', access.eligible_prediction_set_sha256,
    'expectedKeySetSha256', access.expected_key_set_sha256,
    'family', registration.family,
    'fromLocalDate', from_date,
    'metadataRootSha256', access.metadata_root_sha256,
    'registrationSha256', registration.registration_sha256,
    'revisionCatalogWatermarkSha256', access.revision_catalog_watermark_sha256,
    'targetComparatorSnapshotRootSha256', access.target_comparator_snapshot_root_sha256,
    'targetCutoffAt', to_char(access.target_cutoff_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'toLocalDateExclusive', to_date
  );
END;
$$;

-- remove every ambient right before runtime ACL reconciliation
REVOKE ALL ON adjustment_shadow_registrations_v2,
  adjustment_shadow_predictions_v2,
  adjustment_confirmation_accesses_v2
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
REVOKE EXECUTE ON FUNCTION weather_guard_adjustment_shadow_registration_v2(),
  weather_guard_adjustment_shadow_prediction_v2(),
  weather_guard_adjustment_confirmation_access_v2(),
  weather_reject_adjustment_maintenance_mutation(),
  weather_register_adjustment_shadow_v2(jsonb),
  weather_append_adjustment_temperature_shadow_v2(jsonb),
  weather_append_adjustment_wind_shadow_v2(jsonb),
  weather_append_adjustment_rain_shadow_v2(jsonb),
  adjustment_shadow_body_admission_v2(text,text,text,integer),
  weather_finalize_adjustment_shadow_metadata_v2(jsonb),
  weather_record_adjustment_confirmation_access_v2(jsonb),
  adjustment_confirmation_availability_v2(text),
  adjustment_confirmation_export_v2(text,text,smallint)
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
