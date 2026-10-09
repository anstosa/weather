-- retain one authenticated finite rolling schedule without rewriting legacy rows
CREATE TABLE adjustment_registration_schedule_v3 (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  bootstrap_sha256 char(64) NOT NULL UNIQUE
    CHECK (bootstrap_sha256 ~ '^[a-f0-9]{64}$'),
  epoch_witness_sha256 char(64) NOT NULL UNIQUE
    CHECK (epoch_witness_sha256 ~ '^[a-f0-9]{64}$'),
  epoch_at timestamptz NOT NULL,
  first_complete_local_date date NOT NULL,
  bootstrap_horizon_end_at timestamptz NOT NULL,
  schedule_contract_sha256 char(64) NOT NULL
    CHECK (schedule_contract_sha256 =
      '7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f'),
  initialized_at timestamptz NOT NULL,
  CHECK (epoch_at < bootstrap_horizon_end_at)
);

-- retain every finite horizon extension as one predecessor-linked receipt
CREATE TABLE adjustment_registration_horizons_v3 (
  horizon_sha256 char(64) PRIMARY KEY
    CHECK (horizon_sha256 ~ '^[a-f0-9]{64}$'),
  predecessor_horizon_sha256 char(64) UNIQUE
    REFERENCES adjustment_registration_horizons_v3(horizon_sha256)
    ON DELETE RESTRICT,
  registration_sha256 char(64) UNIQUE
    CHECK (registration_sha256 IS NULL
      OR registration_sha256 ~ '^[a-f0-9]{64}$'),
  horizon_end_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK ((predecessor_horizon_sha256 IS NULL AND registration_sha256 IS NULL)
    OR (predecessor_horizon_sha256 IS NOT NULL AND registration_sha256 IS NOT NULL))
);

-- retain rolling registration history after each hot family slot is retired
CREATE TABLE adjustment_shadow_registration_windows_v3 (
  registration_sha256 char(64) PRIMARY KEY
    CHECK (registration_sha256 ~ '^[a-f0-9]{64}$'),
  site_key text NOT NULL CHECK (site_key = 'ballydidean'),
  family text NOT NULL CHECK (family IN ('temperature', 'wind', 'rain')),
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
  epoch_witness_sha256 char(64) NOT NULL
    CHECK (epoch_witness_sha256 ~ '^[a-f0-9]{64}$'),
  schedule_contract_sha256 char(64) NOT NULL
    CHECK (schedule_contract_sha256 =
      '7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f'),
  predecessor_registration_sha256 char(64) UNIQUE
    REFERENCES adjustment_shadow_registration_windows_v3(registration_sha256)
    ON DELETE RESTRICT,
  interval_start_at timestamptz NOT NULL,
  interval_end_at timestamptz NOT NULL,
  target_cutoff_at timestamptz NOT NULL,
  terminal_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL,
  UNIQUE (family, interval_start_at),
  CHECK (interval_start_at < interval_end_at
    AND interval_end_at < target_cutoff_at
    AND target_cutoff_at = terminal_at)
);

-- admit only closed initializer and registration writes into the new history
CREATE FUNCTION weather_guard_adjustment_registration_v3()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation jsonb;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- reject every direct or mismatched history insertion
  IF operation IS NULL
    OR (TG_TABLE_NAME = 'adjustment_registration_schedule_v3'
      AND operation->>'operation' <> 'initialize_schedule_v3')
    OR (TG_TABLE_NAME = 'adjustment_registration_horizons_v3'
      AND operation->>'operation' NOT IN ('initialize_schedule_v3', 'extend_horizon_v3'))
    OR (TG_TABLE_NAME = 'adjustment_shadow_registration_windows_v3'
      AND operation->>'operation' <> 'register_v3') THEN
    RAISE EXCEPTION 'adjustment rolling history insert requires closed function context'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- reject every mutation after one closed append-only history insertion
CREATE FUNCTION weather_reject_adjustment_registration_v3_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'adjustment rolling history is immutable' USING ERRCODE = '42501';
END;
$$;

-- replace the hot-row guard with disjoint legacy and rolling identity domains
CREATE OR REPLACE FUNCTION weather_guard_adjustment_shadow_registration_v2()
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
  predecessor_identity text;
BEGIN
  operation := nullif(current_setting('weather.adjustment_maintenance_operation', true), '')::jsonb;
  -- admit hot rows only through a closed legacy or rolling function
  IF operation IS NULL OR operation->>'operation' NOT IN ('register', 'register_v3') THEN
    RAISE EXCEPTION 'adjustment registration insert requires closed function context'
      USING ERRCODE = '42501';
  END IF;
  -- reject caller-owned identity and clock fields
  IF NEW.registration_sha256 IS NOT NULL OR NEW.registered_at IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment registration identity and clock are server assigned'
      USING ERRCODE = '23514';
  END IF;

  NEW.registered_at := CASE operation->>'operation'
    WHEN 'register_v3' THEN (operation->>'registeredAt')::timestamptz
    ELSE clock_timestamp()
  END;
  start_local_date := (NEW.interval_start_at AT TIME ZONE 'America/Los_Angeles')::date;
  end_local_date := (NEW.interval_end_at AT TIME ZONE 'America/Los_Angeles')::date;
  -- require exact local-midnight intervals and preregistration
  IF NEW.interval_start_at <> start_local_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR NEW.interval_end_at <> end_local_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR NEW.registered_at >= NEW.interval_start_at THEN
    RAISE EXCEPTION 'adjustment registration interval or clock is invalid'
      USING ERRCODE = '23514';
  END IF;

  -- preserve the exact legacy validation domain for existing retry compatibility
  IF operation->>'operation' = 'register' THEN
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
  ELSE
    -- require the rolling family span and fixed late closure
    IF (NEW.family IN ('temperature', 'wind') AND end_local_date - start_local_date <> 366)
      OR (NEW.family = 'rain' AND end_local_date - start_local_date <> 334)
      OR NEW.target_cutoff_at <> NEW.interval_end_at + interval '7 days'
      OR NEW.terminal_at <> NEW.target_cutoff_at THEN
      RAISE EXCEPTION 'adjustment rolling registration family span is invalid'
        USING ERRCODE = '23514';
    END IF;
    predecessor_identity := coalesce(operation->>'predecessorRegistrationSha256', 'none');
    computed_identity := encode(sha256(convert_to(
      'adjustment-shadow-registration/v3' || E'\n'
        || NEW.site_key || E'\n' || NEW.family || E'\n'
        || NEW.candidate_sha256 || E'\n' || NEW.artifact_sha256 || E'\n'
        || NEW.policy_sha256 || E'\n' || NEW.cohort_sha256 || E'\n'
        || NEW.reserved_key_sha256 || E'\n' || NEW.source_sha256 || E'\n'
        || (operation->>'epochWitnessSha256') || E'\n'
        || (operation->>'scheduleContractSha256') || E'\n'
        || predecessor_identity || E'\n'
        || to_char(NEW.interval_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
        || to_char(NEW.interval_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
        || to_char(NEW.target_cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n'
        || to_char(NEW.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || E'\n',
      'UTF8'
    )), 'hex');
  END IF;
  NEW.registration_sha256 := computed_identity;
  RETURN NEW;
END;
$$;

-- initialize one actual epoch-bound finite schedule through the owner boundary
CREATE FUNCTION weather_initialize_adjustment_registration_schedule_v3(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_keys constant text[] := ARRAY[
    'bootstrapSha256', 'contractVersion', 'epochAt', 'epochWitnessSha256',
    'firstCompleteLocalDate', 'horizonEndAt', 'scheduleContractSha256'
  ];
  existing adjustment_registration_schedule_v3%ROWTYPE;
  expected_bootstrap_sha256 text;
  expected_first_date date;
  expected_horizon_end timestamptz;
  genesis_horizon_sha256 text;
  initialized_at timestamptz;
  previous_operation text;
BEGIN
  -- keep epoch initialization behind the database owner
  IF session_user <> 'weather_owner' THEN
    RAISE EXCEPTION 'adjustment rolling schedule initialization is owner only'
      USING ERRCODE = '42501';
  END IF;
  -- require one exact canonical bootstrap document
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb)
    OR argument->>'contractVersion' <> 'adjustment-registration-schedule-bootstrap/v3'
    OR argument->>'scheduleContractSha256'
      <> '7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f'
    OR argument->>'epochWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'bootstrapSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'adjustment rolling schedule bootstrap is invalid'
      USING ERRCODE = '22023';
  END IF;

  expected_first_date := ((argument->>'epochAt')::timestamptz
    AT TIME ZONE 'America/Los_Angeles')::date + 1;
  -- retain an annual development window before the future confirmation member
  expected_horizon_end := (expected_first_date + 1053)::timestamp
    AT TIME ZONE 'America/Los_Angeles';
  expected_bootstrap_sha256 := encode(sha256(convert_to(
    '{"contractVersion":' || to_jsonb(argument->>'contractVersion')::text
      || ',"epochAt":' || to_jsonb(to_char(
        (argument->>'epochAt')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
      || ',"epochWitnessSha256":' || to_jsonb(argument->>'epochWitnessSha256')::text
      || ',"firstCompleteLocalDate":' || to_jsonb(expected_first_date::text)::text
      || ',"horizonEndAt":' || to_jsonb(to_char(
        expected_horizon_end AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
      || ',"scheduleContractSha256":'
      || to_jsonb(argument->>'scheduleContractSha256')::text || '}' || E'\n',
    'UTF8'
  )), 'hex');
  -- bind caller bytes to the exact database calendar projection
  IF argument->>'firstCompleteLocalDate' <> expected_first_date::text
    OR (argument->>'horizonEndAt')::timestamptz <> expected_horizon_end
    OR argument->>'bootstrapSha256' <> expected_bootstrap_sha256
    OR (argument->>'epochAt')::timestamptz >= clock_timestamp() THEN
    RAISE EXCEPTION 'adjustment rolling schedule bootstrap differs'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO existing FROM adjustment_registration_schedule_v3 WHERE singleton;
  -- accept only an exact create-once retry
  IF FOUND THEN
    IF ROW(existing.bootstrap_sha256, existing.epoch_witness_sha256,
      existing.epoch_at, existing.first_complete_local_date,
      existing.bootstrap_horizon_end_at, existing.schedule_contract_sha256)
      IS DISTINCT FROM ROW((argument->>'bootstrapSha256')::char(64),
        (argument->>'epochWitnessSha256')::char(64),
        (argument->>'epochAt')::timestamptz, expected_first_date,
        expected_horizon_end, (argument->>'scheduleContractSha256')::char(64)) THEN
      RAISE EXCEPTION 'adjustment rolling schedule retry differs'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'bootstrapSha256', existing.bootstrap_sha256,
      'initialized', false,
      'scheduleContractSha256', existing.schedule_contract_sha256
    );
  END IF;

  initialized_at := date_trunc('milliseconds', clock_timestamp());
  genesis_horizon_sha256 := encode(sha256(convert_to(
    'adjustment-registration-horizon/v3' || E'\n' || 'genesis' || E'\n'
      || (argument->>'bootstrapSha256') || E'\n'
      || to_char(expected_horizon_end AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  )), 'hex');
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'initialize_schedule_v3')::text, true);
  INSERT INTO adjustment_registration_schedule_v3 (
    singleton, bootstrap_sha256, epoch_witness_sha256, epoch_at,
    first_complete_local_date, bootstrap_horizon_end_at,
    schedule_contract_sha256, initialized_at
  ) VALUES (
    true, argument->>'bootstrapSha256', argument->>'epochWitnessSha256',
    (argument->>'epochAt')::timestamptz, expected_first_date,
    expected_horizon_end, argument->>'scheduleContractSha256', initialized_at
  );
  INSERT INTO adjustment_registration_horizons_v3 (
    horizon_sha256, predecessor_horizon_sha256, registration_sha256,
    horizon_end_at, recorded_at
  ) VALUES (genesis_horizon_sha256, NULL, NULL, expected_horizon_end, initialized_at);
  PERFORM set_config('weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''), true);
  RETURN jsonb_build_object(
    'bootstrapSha256', argument->>'bootstrapSha256',
    'initialized', true,
    'scheduleContractSha256', argument->>'scheduleContractSha256'
  );
END;
$$;

-- reduce legacy registration to exact active-row retry after future-only activation
CREATE OR REPLACE FUNCTION weather_register_adjustment_shadow_v2(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted adjustment_shadow_registrations_v2%ROWTYPE;
  existing adjustment_shadow_registrations_v2%ROWTYPE;
  previous_operation text;
  supplied_identity text;
  allowed_keys constant text[] := ARRAY[
    'artifactSha256', 'candidateSha256', 'cohortSha256', 'family',
    'intervalEndAt', 'intervalStartAt', 'policySha256', 'registrationSha256',
    'reservedKeySha256', 'siteKey', 'sourceSha256', 'targetCutoffAt', 'terminalAt'
  ];
BEGIN
  -- preserve the activation gate during the inert migration handoff
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- retain only the original closed object for legacy retry lookup
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 2048
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item WHERE item.value = 'null'::jsonb) THEN
    RAISE EXCEPTION 'adjustment registration object is invalid' USING ERRCODE = '22023';
  END IF;
  -- preserve the original role-family boundary
  IF (session_user = 'weather_api' AND argument->>'family' NOT IN ('temperature', 'wind'))
    OR (session_user = 'weather_ingest' AND argument->>'family' <> 'rain')
    OR session_user NOT IN ('weather_api', 'weather_ingest', 'weather_owner') THEN
    RAISE EXCEPTION 'adjustment registration family is unauthorized' USING ERRCODE = '42501';
  END IF;

  -- preserve legacy insertion only before the authenticated future-only schedule activates
  IF NOT EXISTS (SELECT 1 FROM adjustment_registration_schedule_v3 WHERE singleton) THEN
    supplied_identity := argument->>'registrationSha256';
    previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
    PERFORM set_config('weather.adjustment_maintenance_operation',
      jsonb_build_object('operation', 'register')::text, true);
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
    ) ON CONFLICT DO NOTHING RETURNING * INTO inserted;
    -- accept only the recomputed legacy identity
    IF inserted.registration_sha256 IS NOT NULL
      AND inserted.registration_sha256 <> supplied_identity THEN
      RAISE EXCEPTION 'adjustment registration identity is invalid' USING ERRCODE = '23514';
    END IF;
    -- require every legacy retry field to match
    IF inserted.registration_sha256 IS NULL THEN
      SELECT * INTO existing FROM adjustment_shadow_registrations_v2
      WHERE registration_sha256 = supplied_identity OR family = argument->>'family';
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
    PERFORM set_config('weather.adjustment_maintenance_operation',
      coalesce(previous_operation, ''), true);
    RETURN jsonb_build_object(
      'inserted', inserted.registration_sha256 IS NOT NULL,
      'registrationSha256', supplied_identity
    );
  END IF;
  SELECT * INTO existing FROM adjustment_shadow_registrations_v2
  WHERE registration_sha256 = argument->>'registrationSha256'
    OR family = argument->>'family';
  -- refuse new unbound legacy members while accepting exact active retries
  IF NOT FOUND OR ROW(
    existing.registration_sha256, existing.site_key, existing.family,
    existing.candidate_sha256, existing.artifact_sha256, existing.policy_sha256,
    existing.cohort_sha256, existing.reserved_key_sha256, existing.source_sha256,
    existing.interval_start_at, existing.interval_end_at,
    existing.target_cutoff_at, existing.terminal_at
  ) IS DISTINCT FROM ROW(
    (argument->>'registrationSha256')::char(64), argument->>'siteKey', argument->>'family',
    (argument->>'candidateSha256')::char(64), (argument->>'artifactSha256')::char(64),
    (argument->>'policySha256')::char(64), (argument->>'cohortSha256')::char(64),
    (argument->>'reservedKeySha256')::char(64), (argument->>'sourceSha256')::char(64),
    (argument->>'intervalStartAt')::timestamptz,
    (argument->>'intervalEndAt')::timestamptz,
    (argument->>'targetCutoffAt')::timestamptz,
    (argument->>'terminalAt')::timestamptz
  ) THEN
    RAISE EXCEPTION 'new adjustment v2 registration is disabled'
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'inserted', false,
    'registrationSha256', existing.registration_sha256
  );
END;
$$;

-- register one future-only rolling member while its family slot is free
CREATE FUNCTION weather_register_adjustment_shadow_v3(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_keys constant text[] := ARRAY[
    'artifactSha256', 'candidateSha256', 'cohortSha256', 'epochWitnessSha256',
    'family', 'intervalEndAt', 'intervalStartAt', 'policySha256',
    'predecessorRegistrationSha256', 'registrationSha256', 'reservedKeySha256',
    'scheduleContractSha256', 'siteKey', 'sourceSha256', 'targetCutoffAt', 'terminalAt'
  ];
  current_horizon adjustment_registration_horizons_v3%ROWTYPE;
  existing adjustment_shadow_registration_windows_v3%ROWTYPE;
  inserted adjustment_shadow_registrations_v2%ROWTYPE;
  latest adjustment_shadow_registration_windows_v3%ROWTYPE;
  schedule adjustment_registration_schedule_v3%ROWTYPE;
  expected_start_date date;
  expected_end_date date;
  next_horizon_end timestamptz;
  next_horizon_sha256 text;
  previous_operation text;
  registered_at timestamptz;
BEGIN
  -- require administrator activation for this exact database role
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
    JOIN pg_database database ON database.oid = setting.setdatabase
    WHERE setting.setrole = session_user::regrole
      AND database.datname = current_database()
      AND 'weather.adjustment_maintenance_v2_enabled=on' = ANY(setting.setconfig)
  ) THEN
    RAISE EXCEPTION 'adjustment maintenance v2 is inactive' USING ERRCODE = '55000';
  END IF;
  -- require one disjoint exact v3 public registration
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR octet_length(convert_to(argument::text, 'UTF8')) > 3072
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <> allowed_keys
    OR EXISTS (SELECT 1 FROM jsonb_each(argument) item
      WHERE item.value = 'null'::jsonb AND item.key <> 'predecessorRegistrationSha256')
    OR argument->>'registrationSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'epochWitnessSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'scheduleContractSha256'
      <> '7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f'
    OR (argument->>'predecessorRegistrationSha256' IS NOT NULL
      AND argument->>'predecessorRegistrationSha256' !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'adjustment rolling registration object is invalid'
      USING ERRCODE = '22023';
  END IF;
  -- preserve the original role-family boundary without granting new authority
  IF (session_user = 'weather_api' AND argument->>'family' NOT IN ('temperature', 'wind'))
    OR (session_user = 'weather_ingest' AND argument->>'family' <> 'rain')
    OR session_user NOT IN ('weather_api', 'weather_ingest', 'weather_owner') THEN
    RAISE EXCEPTION 'adjustment registration family is unauthorized' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('adjustment-registration-v3/'
    || (argument->>'family'), 0));
  SELECT * INTO existing FROM adjustment_shadow_registration_windows_v3
  WHERE registration_sha256 = argument->>'registrationSha256';
  -- accept an exact historical retry without reopening its retired slot
  IF FOUND THEN
    IF ROW(existing.registration_sha256, existing.site_key, existing.family,
      existing.candidate_sha256, existing.artifact_sha256, existing.policy_sha256,
      existing.cohort_sha256, existing.reserved_key_sha256, existing.source_sha256,
      existing.epoch_witness_sha256, existing.schedule_contract_sha256,
      existing.predecessor_registration_sha256, existing.interval_start_at,
      existing.interval_end_at, existing.target_cutoff_at, existing.terminal_at)
      IS DISTINCT FROM ROW(
        (argument->>'registrationSha256')::char(64), argument->>'siteKey',
        argument->>'family', (argument->>'candidateSha256')::char(64),
        (argument->>'artifactSha256')::char(64), (argument->>'policySha256')::char(64),
        (argument->>'cohortSha256')::char(64),
        (argument->>'reservedKeySha256')::char(64),
        (argument->>'sourceSha256')::char(64),
        (argument->>'epochWitnessSha256')::char(64),
        (argument->>'scheduleContractSha256')::char(64),
        (argument->>'predecessorRegistrationSha256')::char(64),
        (argument->>'intervalStartAt')::timestamptz,
        (argument->>'intervalEndAt')::timestamptz,
        (argument->>'targetCutoffAt')::timestamptz,
        (argument->>'terminalAt')::timestamptz) THEN
      RAISE EXCEPTION 'adjustment rolling registration retry differs'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('inserted', false,
      'registrationSha256', existing.registration_sha256);
  END IF;

  SELECT * INTO STRICT schedule FROM adjustment_registration_schedule_v3 WHERE singleton;
  -- bind the request to the root-initialized epoch and schedule
  IF argument->>'epochWitnessSha256' <> schedule.epoch_witness_sha256
    OR argument->>'scheduleContractSha256' <> schedule.schedule_contract_sha256 THEN
    RAISE EXCEPTION 'adjustment rolling registration schedule differs'
      USING ERRCODE = '23514';
  END IF;
  -- retain the active hot row as the sole family slot
  IF EXISTS (SELECT 1 FROM adjustment_shadow_registrations_v2
    WHERE family = argument->>'family') THEN
    RAISE EXCEPTION 'adjustment rolling registration family is busy'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO latest FROM adjustment_shadow_registration_windows_v3
  WHERE family = argument->>'family'
  ORDER BY registered_at DESC, registration_sha256 DESC LIMIT 1;
  -- require an exact reconciled predecessor for every successor
  IF (NOT FOUND AND argument->>'predecessorRegistrationSha256' IS NOT NULL)
    OR (FOUND AND (argument->>'predecessorRegistrationSha256' IS NULL
      OR argument->>'predecessorRegistrationSha256' <> latest.registration_sha256
      OR NOT EXISTS (SELECT 1 FROM adjustment_shadow_terminal_results_v2 terminal
        WHERE terminal.registration_sha256 = latest.registration_sha256
          AND terminal.family = latest.family))) THEN
    RAISE EXCEPTION 'adjustment rolling registration predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;

  registered_at := date_trunc('milliseconds', clock_timestamp());
  expected_start_date := (date_trunc('month', registered_at
    AT TIME ZONE 'America/Los_Angeles') + interval '1 month')::date;
  expected_end_date := expected_start_date + CASE argument->>'family'
    WHEN 'rain' THEN 334 ELSE 366 END;
  -- require the shared planner's exact next-month span and utc late closure
  IF (argument->>'intervalStartAt')::timestamptz
      <> expected_start_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR (argument->>'intervalEndAt')::timestamptz
      <> expected_end_date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR (argument->>'targetCutoffAt')::timestamptz
      <> (argument->>'intervalEndAt')::timestamptz + interval '7 days'
    OR (argument->>'terminalAt')::timestamptz
      <> (argument->>'targetCutoffAt')::timestamptz
    OR (argument->>'intervalStartAt')::timestamptz <= registered_at
    OR (argument->>'intervalStartAt')::timestamptz
      <= greatest(schedule.epoch_at, coalesce(latest.terminal_at, schedule.epoch_at)) THEN
    RAISE EXCEPTION 'adjustment rolling registration window differs'
      USING ERRCODE = '23514';
  END IF;

  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation', jsonb_build_object(
    'epochWitnessSha256', argument->>'epochWitnessSha256',
    'operation', 'register_v3',
    'predecessorRegistrationSha256', argument->'predecessorRegistrationSha256',
    'registeredAt', to_char(registered_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'scheduleContractSha256', argument->>'scheduleContractSha256'
  )::text, true);
  INSERT INTO adjustment_shadow_registrations_v2 (
    registration_sha256, site_key, family, candidate_sha256, artifact_sha256,
    policy_sha256, cohort_sha256, reserved_key_sha256, source_sha256,
    interval_start_at, interval_end_at, target_cutoff_at, terminal_at, registered_at
  ) VALUES (
    NULL, argument->>'siteKey', argument->>'family', argument->>'candidateSha256',
    argument->>'artifactSha256', argument->>'policySha256', argument->>'cohortSha256',
    argument->>'reservedKeySha256', argument->>'sourceSha256',
    (argument->>'intervalStartAt')::timestamptz,
    (argument->>'intervalEndAt')::timestamptz,
    (argument->>'targetCutoffAt')::timestamptz,
    (argument->>'terminalAt')::timestamptz, NULL
  ) RETURNING * INTO STRICT inserted;
  -- accept only the recomputed v3 public registration identity
  IF inserted.registration_sha256 <> argument->>'registrationSha256' THEN
    RAISE EXCEPTION 'adjustment rolling registration identity is invalid'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO adjustment_shadow_registration_windows_v3 (
    registration_sha256, site_key, family, candidate_sha256, artifact_sha256,
    policy_sha256, cohort_sha256, reserved_key_sha256, source_sha256,
    epoch_witness_sha256, schedule_contract_sha256,
    predecessor_registration_sha256, interval_start_at, interval_end_at,
    target_cutoff_at, terminal_at, registered_at
  ) VALUES (
    inserted.registration_sha256, inserted.site_key, inserted.family,
    inserted.candidate_sha256, inserted.artifact_sha256, inserted.policy_sha256,
    inserted.cohort_sha256, inserted.reserved_key_sha256, inserted.source_sha256,
    argument->>'epochWitnessSha256', argument->>'scheduleContractSha256',
    argument->>'predecessorRegistrationSha256', inserted.interval_start_at,
    inserted.interval_end_at, inserted.target_cutoff_at, inserted.terminal_at,
    inserted.registered_at
  );

  SELECT * INTO STRICT current_horizon FROM adjustment_registration_horizons_v3 horizon
  WHERE NOT EXISTS (SELECT 1 FROM adjustment_registration_horizons_v3 successor
    WHERE successor.predecessor_horizon_sha256 = horizon.horizon_sha256);
  next_horizon_end := greatest(current_horizon.horizon_end_at, inserted.terminal_at);
  next_horizon_sha256 := encode(sha256(convert_to(
    'adjustment-registration-horizon/v3' || E'\n'
      || current_horizon.horizon_sha256 || E'\n'
      || inserted.registration_sha256 || E'\n'
      || to_char(next_horizon_end AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  )), 'hex');
  PERFORM set_config('weather.adjustment_maintenance_operation',
    jsonb_build_object('operation', 'extend_horizon_v3')::text, true);
  INSERT INTO adjustment_registration_horizons_v3 (
    horizon_sha256, predecessor_horizon_sha256, registration_sha256,
    horizon_end_at, recorded_at
  ) VALUES (
    next_horizon_sha256, current_horizon.horizon_sha256,
    inserted.registration_sha256, next_horizon_end, registered_at
  );
  PERFORM set_config('weather.adjustment_maintenance_operation',
    coalesce(previous_operation, ''), true);
  RETURN jsonb_build_object(
    'inserted', true,
    'registrationSha256', inserted.registration_sha256
  );
END;
$$;

-- expose one bounded value-free family slot and finite-horizon projection
CREATE FUNCTION adjustment_shadow_registration_slot_v3(requested_family text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active adjustment_shadow_registrations_v2%ROWTYPE;
  current_horizon adjustment_registration_horizons_v3%ROWTYPE;
  schedule adjustment_registration_schedule_v3%ROWTYPE;
  version text;
BEGIN
  -- reject family aliases before reading private metadata
  IF requested_family NOT IN ('temperature', 'wind', 'rain') THEN
    RAISE EXCEPTION 'adjustment registration family is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT schedule FROM adjustment_registration_schedule_v3 WHERE singleton;
  SELECT * INTO STRICT current_horizon FROM adjustment_registration_horizons_v3 horizon
  WHERE NOT EXISTS (SELECT 1 FROM adjustment_registration_horizons_v3 successor
    WHERE successor.predecessor_horizon_sha256 = horizon.horizon_sha256);
  SELECT * INTO active FROM adjustment_shadow_registrations_v2
  WHERE family = requested_family;
  -- distinguish descriptive legacy occupancy from future-only rolling occupancy
  IF FOUND THEN
    version := CASE WHEN EXISTS (
      SELECT 1 FROM adjustment_shadow_registration_windows_v3 window_row
      WHERE window_row.registration_sha256 = active.registration_sha256
    ) THEN 'busy_v3' ELSE 'busy_v2_legacy' END;
  ELSE
    version := 'free';
  END IF;
  RETURN jsonb_build_object(
    'contractVersion', 'adjustment-shadow-registration-slot/v3',
    'epochWitnessSha256', schedule.epoch_witness_sha256,
    'family', requested_family,
    'horizonEndAt', to_char(current_horizon.horizon_end_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'registrationSha256', active.registration_sha256,
    'scheduleContractSha256', schedule.schedule_contract_sha256,
    'state', version,
    'terminalAt', CASE WHEN active.registration_sha256 IS NULL THEN NULL ELSE
      to_char(active.terminal_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
  );
END;
$$;

-- enforce append-only history through the existing mutation rejection policy
CREATE TRIGGER adjustment_registration_schedule_v3_guard_insert
BEFORE INSERT ON adjustment_registration_schedule_v3
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_registration_v3();
CREATE TRIGGER adjustment_registration_schedule_v3_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_registration_schedule_v3
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();
CREATE TRIGGER adjustment_registration_schedule_v3_guard_truncate
BEFORE TRUNCATE ON adjustment_registration_schedule_v3
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();
CREATE TRIGGER adjustment_registration_horizons_v3_guard_insert
BEFORE INSERT ON adjustment_registration_horizons_v3
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_registration_v3();
CREATE TRIGGER adjustment_registration_horizons_v3_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_registration_horizons_v3
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();
CREATE TRIGGER adjustment_registration_horizons_v3_guard_truncate
BEFORE TRUNCATE ON adjustment_registration_horizons_v3
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();
CREATE TRIGGER adjustment_shadow_registration_windows_v3_guard_insert
BEFORE INSERT ON adjustment_shadow_registration_windows_v3
FOR EACH ROW EXECUTE FUNCTION weather_guard_adjustment_registration_v3();
CREATE TRIGGER adjustment_shadow_registration_windows_v3_guard_mutation
BEFORE UPDATE OR DELETE ON adjustment_shadow_registration_windows_v3
FOR EACH ROW EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();
CREATE TRIGGER adjustment_shadow_registration_windows_v3_guard_truncate
BEFORE TRUNCATE ON adjustment_shadow_registration_windows_v3
FOR EACH STATEMENT EXECUTE FUNCTION weather_reject_adjustment_registration_v3_mutation();

-- remove ambient access until the runtime acl grants the closed role surfaces
REVOKE ALL ON adjustment_registration_schedule_v3,
  adjustment_registration_horizons_v3,
  adjustment_shadow_registration_windows_v3
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
REVOKE EXECUTE ON FUNCTION weather_guard_adjustment_registration_v3(),
  weather_reject_adjustment_registration_v3_mutation(),
  weather_initialize_adjustment_registration_schedule_v3(jsonb),
  weather_register_adjustment_shadow_v3(jsonb),
  adjustment_shadow_registration_slot_v3(text)
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
