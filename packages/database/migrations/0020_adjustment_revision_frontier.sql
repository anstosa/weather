-- retain only the bounded authoritative frontier, not a growing hot ledger
CREATE SEQUENCE adjustment_revision_ordinal_v1 AS bigint MINVALUE 1 NO CYCLE;

CREATE TABLE adjustment_revision_frontier_v1 (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  archive_commit_ordinal bigint NOT NULL CHECK (archive_commit_ordinal >= 0),
  projection_count bigint NOT NULL CHECK (projection_count >= 0),
  frontier_sha256 char(64) NOT NULL CHECK (frontier_sha256 ~ '^[a-f0-9]{64}$')
);

INSERT INTO adjustment_revision_frontier_v1 (
  singleton, archive_commit_ordinal, projection_count, frontier_sha256
) VALUES (
  true, 0, 0,
  encode(sha256(convert_to('adjustment-revision-frontier/v1' || E'\n0\n', 'UTF8')), 'hex')
);

-- bind each compact native-source row to its server-issued archive receipt
ALTER TABLE adjustment_shadow_predictions_v2
  ADD COLUMN revision_contract_epoch smallint
    CHECK (revision_contract_epoch IS NULL OR revision_contract_epoch = 1),
  ADD COLUMN stage_receipt_sha256 char(64)
    CHECK (stage_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN archive_commit_ordinal bigint
    CHECK (archive_commit_ordinal > 0),
  ADD COLUMN predecessor_frontier_sha256 char(64)
    CHECK (predecessor_frontier_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN revision_frontier_sha256 char(64)
    CHECK (revision_frontier_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN revision_receipt_sha256 char(64)
    CHECK (revision_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN archive_committed_at timestamptz,
  ADD CONSTRAINT adjustment_shadow_prediction_revision_receipt_complete
    CHECK (num_nonnulls(stage_receipt_sha256, archive_commit_ordinal,
      predecessor_frontier_sha256, revision_frontier_sha256,
      revision_receipt_sha256, archive_committed_at) IN (0, 6));

-- mark only new rows while preserving legacy rows as permanently unqualified
ALTER TABLE adjustment_shadow_predictions_v2
  ALTER COLUMN revision_contract_epoch SET DEFAULT 1;

-- admit one exact server-owned receipt transition before the append commits
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
  -- allow only the server-owned archive receipt fields to become immutable once
  IF operation IS NOT NULL AND operation->>'operation' = 'bind_revision_v1'
    AND TG_TABLE_NAME = 'adjustment_shadow_predictions_v2' AND TG_OP = 'UPDATE' THEN
    IF OLD.revision_receipt_sha256 IS NOT NULL
      OR NEW.prediction_sha256 <> operation->>'predictionSha256'
      OR NEW.stage_receipt_sha256 <> operation->>'stageReceiptSha256'
      OR NEW.archive_commit_ordinal <> (operation->>'archiveCommitOrdinal')::bigint
      OR NEW.predecessor_frontier_sha256 <> operation->>'predecessorFrontierSha256'
      OR NEW.revision_frontier_sha256 <> operation->>'frontierSha256'
      OR NEW.revision_receipt_sha256 <> operation->>'receiptSha256'
      OR NEW.archive_committed_at <> (operation->>'archiveCommittedAt')::timestamptz
      OR ROW(NEW.prediction_sha256, NEW.revision_contract_epoch,
        NEW.registration_sha256, NEW.candidate_sha256,
        NEW.source_sha256, NEW.due_key, NEW.issued_at, NEW.committed_at,
        NEW.min_valid_at, NEW.max_valid_at, NEW.scored_min_valid_at,
        NEW.scored_max_valid_at, NEW.source_receipt_sha256, NEW.input_sha256,
        NEW.prediction_body_sha256, NEW.prediction_schema_sha256,
        NEW.row_count, NEW.body_byte_count)
      IS DISTINCT FROM ROW(OLD.prediction_sha256, OLD.revision_contract_epoch,
        OLD.registration_sha256, OLD.candidate_sha256, OLD.source_sha256,
        OLD.due_key, OLD.issued_at,
        OLD.committed_at, OLD.min_valid_at, OLD.max_valid_at,
        OLD.scored_min_valid_at, OLD.scored_max_valid_at,
        OLD.source_receipt_sha256, OLD.input_sha256,
        OLD.prediction_body_sha256, OLD.prediction_schema_sha256,
        OLD.row_count, OLD.body_byte_count) THEN
      RAISE EXCEPTION 'adjustment revision receipt transition is invalid' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
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

-- append and bind one native-source archive receipt in the same transaction
CREATE FUNCTION weather_append_adjustment_shadow_v4(argument jsonb, family_argument text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  append_receipt jsonb;
  prediction adjustment_shadow_predictions_v2%ROWTYPE;
  frontier adjustment_revision_frontier_v1%ROWTYPE;
  stage_sha256 text;
  ordinal_value bigint;
  receipt_sha256 text;
  next_frontier_sha256 text;
  archive_committed_clock timestamptz;
  committed_at_text text;
  previous_operation text;
  revision_receipt jsonb;
BEGIN
  stage_sha256 := argument->>'stageReceiptSha256';
  -- require one exact durable-stage identity before touching the hot row
  IF argument IS NULL OR jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['bodyByteCount', 'candidateSha256', 'dueKey', 'inputSha256', 'issuedAt',
        'maxValidAt', 'minValidAt', 'predictionBodySha256', 'predictionSchemaSha256',
        'predictionSha256', 'registrationSha256', 'rowCount', 'sourceReceiptSha256',
        'sourceSha256', 'stageReceiptSha256']
    OR stage_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'adjustment revision stage receipt is invalid' USING ERRCODE = '22023';
  END IF;

  append_receipt := weather_append_adjustment_shadow_v3(
    argument - 'stageReceiptSha256', family_argument);
  SELECT * INTO STRICT prediction FROM adjustment_shadow_predictions_v2
  WHERE prediction_sha256 = argument->>'predictionSha256' FOR UPDATE;
  -- refuse to qualify a prediction first committed before this contract
  IF prediction.revision_contract_epoch IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'legacy adjustment prediction is permanently unqualified'
      USING ERRCODE = '55000';
  END IF;
  -- preserve only byte-identical retries of an issued receipt
  IF prediction.revision_receipt_sha256 IS NOT NULL THEN
    IF prediction.stage_receipt_sha256 <> stage_sha256 THEN
      RAISE EXCEPTION 'adjustment revision receipt retry differs' USING ERRCODE = '23505';
    END IF;
    revision_receipt := jsonb_build_object(
      'archiveCommitOrdinal', prediction.archive_commit_ordinal::text,
      'archiveCommittedAt', to_char(prediction.archive_committed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'contractVersion', 'adjustment-revision-commit-receipt/v1',
      'frontierSha256', prediction.revision_frontier_sha256,
      'predecessorFrontierSha256', prediction.predecessor_frontier_sha256,
      'projectionIdentitySha256', prediction.source_receipt_sha256,
      'projectionKind', 'shadow_prediction',
      'projectionSha256', prediction.input_sha256,
      'receiptSha256', prediction.revision_receipt_sha256,
      'stageReceiptSha256', prediction.stage_receipt_sha256
    );
    RETURN append_receipt || jsonb_build_object('revisionReceipt', revision_receipt);
  END IF;

  SELECT * INTO STRICT frontier FROM adjustment_revision_frontier_v1
  WHERE singleton FOR UPDATE;
  ordinal_value := nextval('adjustment_revision_ordinal_v1');
  -- require a strictly advancing server sequence even when rollbacks leave gaps
  IF ordinal_value <= frontier.archive_commit_ordinal THEN
    RAISE EXCEPTION 'adjustment revision ordinal did not advance' USING ERRCODE = '55000';
  END IF;
  archive_committed_clock := date_trunc('milliseconds', clock_timestamp());
  committed_at_text := to_char(archive_committed_clock AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  receipt_sha256 := encode(sha256(convert_to(
    'adjustment-revision-commit-receipt/v1' || E'\n'
      || ordinal_value::text || E'\n' || committed_at_text || E'\nshadow_prediction\n'
      || prediction.source_receipt_sha256 || E'\n' || prediction.input_sha256 || E'\n'
      || stage_sha256 || E'\n' || frontier.frontier_sha256,
    'UTF8'
  )), 'hex');
  next_frontier_sha256 := encode(sha256(convert_to(
    'adjustment-revision-frontier/v1' || E'\n' || frontier.frontier_sha256 || E'\n'
      || ordinal_value::text || E'\n' || receipt_sha256,
    'UTF8'
  )), 'hex');
  previous_operation := current_setting('weather.adjustment_maintenance_operation', true);
  PERFORM set_config('weather.adjustment_maintenance_operation', jsonb_build_object(
    'operation', 'bind_revision_v1',
    'predictionSha256', prediction.prediction_sha256,
    'stageReceiptSha256', stage_sha256,
    'archiveCommitOrdinal', ordinal_value::text,
    'archiveCommittedAt', committed_at_text,
    'predecessorFrontierSha256', frontier.frontier_sha256,
    'frontierSha256', next_frontier_sha256,
    'receiptSha256', receipt_sha256
  )::text, true);
  UPDATE adjustment_shadow_predictions_v2 SET
    stage_receipt_sha256 = stage_sha256,
    archive_commit_ordinal = ordinal_value,
    predecessor_frontier_sha256 = frontier.frontier_sha256,
    revision_frontier_sha256 = next_frontier_sha256,
    revision_receipt_sha256 = receipt_sha256,
    archive_committed_at = archive_committed_clock
  WHERE prediction_sha256 = prediction.prediction_sha256;
  UPDATE adjustment_revision_frontier_v1 SET
    archive_commit_ordinal = ordinal_value,
    projection_count = projection_count + 1,
    frontier_sha256 = next_frontier_sha256
  WHERE singleton;
  PERFORM set_config('weather.adjustment_maintenance_operation', coalesce(previous_operation, ''), true);

  revision_receipt := jsonb_build_object(
    'archiveCommitOrdinal', ordinal_value::text,
    'archiveCommittedAt', committed_at_text,
    'contractVersion', 'adjustment-revision-commit-receipt/v1',
    'frontierSha256', next_frontier_sha256,
    'predecessorFrontierSha256', frontier.frontier_sha256,
    'projectionIdentitySha256', prediction.source_receipt_sha256,
    'projectionKind', 'shadow_prediction',
    'projectionSha256', prediction.input_sha256,
    'receiptSha256', receipt_sha256,
    'stageReceiptSha256', stage_sha256
  );
  RETURN append_receipt || jsonb_build_object('revisionReceipt', revision_receipt);
END;
$$;

-- preserve role-shaped public calls while requiring the new staged contract
CREATE OR REPLACE FUNCTION weather_append_adjustment_temperature_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v4(argument, 'temperature') $$;
CREATE OR REPLACE FUNCTION weather_append_adjustment_wind_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v4(argument, 'wind') $$;
CREATE OR REPLACE FUNCTION weather_append_adjustment_rain_shadow_v2(argument jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT weather_append_adjustment_shadow_v4(argument, 'rain') $$;

-- expose one bounded value-free watermark to the training exporter
CREATE FUNCTION adjustment_revision_frontier_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'archiveCommitOrdinal', frontier.archive_commit_ordinal::text,
    'contractVersion', 'adjustment-revision-frontier/v1',
    'frontierSha256', frontier.frontier_sha256,
    'projectionCount', frontier.projection_count::text
  )
  FROM adjustment_revision_frontier_v1 frontier
  WHERE frontier.singleton
$$;

-- return only the persisted receipt for one exact body admission tuple
CREATE FUNCTION adjustment_shadow_revision_admission_v1(
  registration_sha256_argument text,
  due_key_argument text,
  prediction_body_sha256_argument text,
  body_byte_count_argument integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'archiveCommitOrdinal', prediction.archive_commit_ordinal::text,
    'archiveCommittedAt', to_char(prediction.archive_committed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'contractVersion', 'adjustment-revision-commit-receipt/v1',
    'frontierSha256', prediction.revision_frontier_sha256,
    'predecessorFrontierSha256', prediction.predecessor_frontier_sha256,
    'projectionIdentitySha256', prediction.source_receipt_sha256,
    'projectionKind', 'shadow_prediction',
    'projectionSha256', prediction.input_sha256,
    'receiptSha256', prediction.revision_receipt_sha256,
    'stageReceiptSha256', prediction.stage_receipt_sha256
  )
  FROM adjustment_shadow_predictions_v2 prediction
  WHERE prediction.registration_sha256 = registration_sha256_argument
    AND prediction.due_key = due_key_argument
    AND prediction.prediction_body_sha256 = prediction_body_sha256_argument
    AND prediction.body_byte_count = body_byte_count_argument
    AND prediction.revision_receipt_sha256 IS NOT NULL
$$;

-- validate one closed server-issued serving pointer
CREATE FUNCTION weather_adjustment_revision_receipt_valid_v1(receipt jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT receipt IS NULL OR (jsonb_typeof(receipt) = 'object' AND (
    (
    ARRAY(SELECT key FROM jsonb_object_keys(receipt) key ORDER BY key) =
      ARRAY['archiveCommitOrdinal', 'archiveCommittedAt', 'contractVersion',
        'frontierSha256', 'predecessorFrontierSha256', 'projectionIdentitySha256',
        'projectionKind', 'projectionSha256', 'receiptSha256', 'stageReceiptSha256']
    AND receipt->>'contractVersion' = 'adjustment-revision-commit-receipt/v1'
    AND receipt->>'archiveCommitOrdinal' ~ '^[1-9][0-9]*$'
    AND receipt->>'archiveCommittedAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND receipt->>'projectionKind' IN (
      'actual_best_match', 'native_source', 'rain_gate_input', 'target_revision')
    AND receipt->>'frontierSha256' ~ '^[a-f0-9]{64}$'
    AND receipt->>'predecessorFrontierSha256' ~ '^[a-f0-9]{64}$'
    AND receipt->>'projectionIdentitySha256' ~ '^[a-f0-9]{64}$'
    AND receipt->>'projectionSha256' ~ '^[a-f0-9]{64}$'
    AND receipt->>'receiptSha256' ~ '^[a-f0-9]{64}$'
    AND receipt->>'stageReceiptSha256' ~ '^[a-f0-9]{64}$'
    ) OR (
      ARRAY(SELECT key FROM jsonb_object_keys(receipt) key ORDER BY key) =
        ARRAY['contractVersion', 'logicalKeySha256', 'projectionIdentitySha256',
          'projectionKind', 'projectionSha256', 'reason', 'storedContentSha256']
      AND receipt->>'contractVersion' = 'adjustment-revision-gap-marker/v1'
      AND receipt->>'logicalKeySha256' ~ '^[a-f0-9]{64}$'
      AND receipt->>'projectionKind' IN (
        'actual_best_match', 'native_source', 'rain_gate_input', 'target_revision')
      AND receipt->>'reason' IN ('archive_stage_failed', 'database_bind_failed',
        'database_admission_failed', 'archive_publish_failed')
      AND receipt->>'storedContentSha256' ~ '^[a-f0-9]{64}$'
      AND ((receipt->'projectionIdentitySha256' = 'null'::jsonb
          AND receipt->'projectionSha256' = 'null'::jsonb)
        OR (receipt->>'projectionIdentitySha256' ~ '^[a-f0-9]{64}$'
          AND receipt->>'projectionSha256' = receipt->>'projectionIdentitySha256'))
    )
  ) AND octet_length(receipt::text) <= 2048)
$$;

-- retain only the current qualified pointer on each existing serving row
ALTER TABLE weather_records
  ADD COLUMN adjustment_revision_receipt jsonb,
  ADD CONSTRAINT weather_records_adjustment_revision_receipt_check
    CHECK (weather_adjustment_revision_receipt_valid_v1(adjustment_revision_receipt));
ALTER TABLE forecast_anchor_records
  ADD COLUMN adjustment_revision_receipt jsonb,
  ADD CONSTRAINT forecast_anchor_records_adjustment_revision_receipt_check
    CHECK (weather_adjustment_revision_receipt_valid_v1(adjustment_revision_receipt));
ALTER TABLE rain_adjustment_runs
  ADD COLUMN adjustment_revision_receipt jsonb,
  ADD CONSTRAINT rain_adjustment_runs_adjustment_revision_receipt_check
    CHECK (weather_adjustment_revision_receipt_valid_v1(adjustment_revision_receipt));
ALTER TABLE ecmwf_temperature_canary_runs
  ADD COLUMN adjustment_revision_receipt jsonb,
  ADD CONSTRAINT ecmwf_temperature_canary_runs_adjustment_revision_receipt_check
    CHECK (weather_adjustment_revision_receipt_valid_v1(adjustment_revision_receipt));

-- discard a superseded current pointer without inventing a historical hot ledger
CREATE FUNCTION weather_clear_adjustment_revision_pointer_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- clear only when the existing upsert proves a content revision
  IF OLD.content_hash <> NEW.content_hash THEN
    NEW.adjustment_revision_receipt := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER weather_records_clear_adjustment_revision_pointer_v1
BEFORE UPDATE ON weather_records
FOR EACH ROW EXECUTE FUNCTION weather_clear_adjustment_revision_pointer_v1();
CREATE TRIGGER forecast_anchor_records_clear_adjustment_revision_pointer_v1
BEFORE UPDATE ON forecast_anchor_records
FOR EACH ROW EXECUTE FUNCTION weather_clear_adjustment_revision_pointer_v1();

-- issue one server-clocked receipt and advance only the fixed singleton frontier
CREATE FUNCTION weather_issue_adjustment_revision_receipt_v1(
  projection_kind_argument text,
  projection_identity_sha256_argument text,
  projection_sha256_argument text,
  stage_receipt_sha256_argument text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  frontier adjustment_revision_frontier_v1%ROWTYPE;
  ordinal_value bigint;
  committed_at_text text;
  receipt_sha256 text;
  next_frontier_sha256 text;
BEGIN
  -- reject caller-controlled aliases before advancing the server frontier
  IF projection_kind_argument NOT IN (
      'actual_best_match', 'native_source', 'rain_gate_input', 'target_revision')
    OR projection_identity_sha256_argument !~ '^[a-f0-9]{64}$'
    OR projection_sha256_argument !~ '^[a-f0-9]{64}$'
    OR stage_receipt_sha256_argument !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'adjustment revision projection is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT frontier FROM adjustment_revision_frontier_v1
  WHERE singleton FOR UPDATE;
  ordinal_value := nextval('adjustment_revision_ordinal_v1');
  -- reject sequence rollback or owner-side sequence drift
  IF ordinal_value <= frontier.archive_commit_ordinal THEN
    RAISE EXCEPTION 'adjustment revision ordinal did not advance' USING ERRCODE = '55000';
  END IF;
  committed_at_text := to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  receipt_sha256 := encode(sha256(convert_to(
    'adjustment-revision-commit-receipt/v1' || E'\n' || ordinal_value::text || E'\n'
      || committed_at_text || E'\n' || projection_kind_argument || E'\n'
      || projection_identity_sha256_argument || E'\n' || projection_sha256_argument || E'\n'
      || stage_receipt_sha256_argument || E'\n' || frontier.frontier_sha256,
    'UTF8')), 'hex');
  next_frontier_sha256 := encode(sha256(convert_to(
    'adjustment-revision-frontier/v1' || E'\n' || frontier.frontier_sha256 || E'\n'
      || ordinal_value::text || E'\n' || receipt_sha256,
    'UTF8')), 'hex');
  UPDATE adjustment_revision_frontier_v1 SET
    archive_commit_ordinal = ordinal_value,
    projection_count = projection_count + 1,
    frontier_sha256 = next_frontier_sha256
  WHERE singleton;
  RETURN jsonb_build_object(
    'archiveCommitOrdinal', ordinal_value::text,
    'archiveCommittedAt', committed_at_text,
    'contractVersion', 'adjustment-revision-commit-receipt/v1',
    'frontierSha256', next_frontier_sha256,
    'predecessorFrontierSha256', frontier.frontier_sha256,
    'projectionIdentitySha256', projection_identity_sha256_argument,
    'projectionKind', projection_kind_argument,
    'projectionSha256', projection_sha256_argument,
    'receiptSha256', receipt_sha256,
    'stageReceiptSha256', stage_receipt_sha256_argument
  );
END;
$$;

-- bind bounded target and comparator batches to the actual serving revisions
CREATE FUNCTION weather_bind_weather_record_revisions_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item jsonb;
  hot_row weather_records%ROWTYPE;
  projection_kind text;
  identity_sha256 text;
  receipt jsonb;
  receipts jsonb := '[]'::jsonb;
  valid_at_text text;
  product_run_at_text text;
BEGIN
  -- bound one staged metadata batch below the archive page and memory ceilings
  IF jsonb_typeof(argument) <> 'array' OR jsonb_array_length(argument) NOT BETWEEN 1 AND 4096
    OR octet_length(argument::text) > 4194304 THEN
    RAISE EXCEPTION 'weather revision batch is invalid' USING ERRCODE = '22023';
  END IF;
  -- serialize stable row identities before allocating ordinals
  FOR item IN SELECT value FROM jsonb_array_elements(argument)
    ORDER BY value->>'sourceId', value->>'sourceKind', value->>'validAt',
      coalesce(value->>'productRunAt', '') LOOP
    -- require the one closed row-key and durable-stage envelope
    IF jsonb_typeof(item) <> 'object'
      OR ARRAY(SELECT key FROM jsonb_object_keys(item) key ORDER BY key) <>
        ARRAY['productRunAt', 'projectionIdentitySha256',
          'projectionSha256', 'sourceId', 'sourceKind', 'stageReceiptSha256',
          'storedContentSha256', 'validAt']
      OR item->>'sourceId' !~ '^[1-9][0-9]*$'
      OR item->>'storedContentSha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionIdentitySha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionSha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionSha256' <> item->>'projectionIdentitySha256'
      OR item->>'stageReceiptSha256' !~ '^[a-f0-9]{64}$'
      OR item->>'sourceKind' NOT IN ('forecast', 'physical_sensor') THEN
      RAISE EXCEPTION 'weather revision item is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO STRICT hot_row FROM weather_records
    WHERE source_id = (item->>'sourceId')::bigint
      AND source_kind = item->>'sourceKind'
      AND valid_at = (item->>'validAt')::timestamptz
      AND product_run_at IS NOT DISTINCT FROM
        CASE WHEN item->'productRunAt' = 'null'::jsonb THEN NULL
          ELSE (item->>'productRunAt')::timestamptz END
    FOR UPDATE;
    valid_at_text := to_char(hot_row.valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    product_run_at_text := coalesce(to_char(hot_row.product_run_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'null');
    -- crossbind caller keys to the stored content revision and canonical clocks
    IF hot_row.content_hash <> item->>'storedContentSha256'
      OR valid_at_text <> item->>'validAt'
      OR product_run_at_text <> coalesce(item->>'productRunAt', 'null') THEN
      RAISE EXCEPTION 'weather revision item differs from serving row' USING ERRCODE = '23514';
    END IF;
    projection_kind := CASE hot_row.source_kind
      WHEN 'forecast' THEN 'actual_best_match' ELSE 'target_revision' END;
    identity_sha256 := item->>'projectionIdentitySha256';
    receipt := hot_row.adjustment_revision_receipt;
    -- preserve byte-identical retries and reject stage substitution
    IF receipt IS NOT NULL THEN
      IF receipt->>'projectionKind' <> projection_kind
        OR receipt->>'projectionIdentitySha256' <> identity_sha256
        OR receipt->>'projectionSha256' <> item->>'projectionSha256'
        OR receipt->>'stageReceiptSha256' <> item->>'stageReceiptSha256' THEN
        RAISE EXCEPTION 'weather revision receipt retry differs' USING ERRCODE = '23505';
      END IF;
    ELSE
      receipt := weather_issue_adjustment_revision_receipt_v1(
        projection_kind, identity_sha256, item->>'projectionSha256',
        item->>'stageReceiptSha256');
      UPDATE weather_records SET adjustment_revision_receipt = receipt
      WHERE id = hot_row.id;
    END IF;
    receipts := receipts || jsonb_build_array(jsonb_build_object(
      'storedContentSha256', hot_row.content_hash,
      'projectionKind', projection_kind,
      'revisionReceipt', receipt,
      'sourceId', hot_row.source_id::text,
      'validAt', valid_at_text
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'contractVersion', 'adjustment-revision-batch-receipt/v1',
    'receipts', receipts
  );
END;
$$;

-- bind bounded historical native-source batches to fixed anchor rows
CREATE FUNCTION weather_bind_forecast_anchor_revisions_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item jsonb;
  hot_row forecast_anchor_records%ROWTYPE;
  identity_sha256 text;
  receipt jsonb;
  receipts jsonb := '[]'::jsonb;
  valid_at_text text;
BEGIN
  -- bound one staged metadata batch below the archive page and memory ceilings
  IF jsonb_typeof(argument) <> 'array' OR jsonb_array_length(argument) NOT BETWEEN 1 AND 4096
    OR octet_length(argument::text) > 4194304 THEN
    RAISE EXCEPTION 'forecast anchor revision batch is invalid' USING ERRCODE = '22023';
  END IF;
  -- serialize stable row identities before allocating ordinals
  FOR item IN SELECT value FROM jsonb_array_elements(argument)
    ORDER BY value->>'sourceId', value->>'validAt', (value->>'leadHours')::integer LOOP
    -- require the one closed row-key and durable-stage envelope
    IF jsonb_typeof(item) <> 'object'
      OR ARRAY(SELECT key FROM jsonb_object_keys(item) key ORDER BY key) <>
        ARRAY['leadHours', 'projectionIdentitySha256',
          'projectionSha256', 'sourceId', 'stageReceiptSha256',
          'storedContentSha256', 'validAt']
      OR item->>'sourceId' !~ '^[1-9][0-9]*$'
      OR item->>'leadHours' !~ '^[1-9][0-9]*$'
      OR item->>'storedContentSha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionIdentitySha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionSha256' !~ '^[a-f0-9]{64}$'
      OR item->>'projectionSha256' <> item->>'projectionIdentitySha256'
      OR item->>'stageReceiptSha256' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'forecast anchor revision item is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO STRICT hot_row FROM forecast_anchor_records
    WHERE source_id = (item->>'sourceId')::bigint
      AND valid_at = (item->>'validAt')::timestamptz
      AND lead_hours = (item->>'leadHours')::smallint
      AND dataset = 'previous_runs' AND upstream_model = 'best_match'
    FOR UPDATE;
    valid_at_text := to_char(hot_row.valid_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    -- crossbind caller keys to the stored content revision and canonical clock
    IF hot_row.content_hash <> item->>'storedContentSha256'
      OR valid_at_text <> item->>'validAt' THEN
      RAISE EXCEPTION 'forecast anchor revision item differs from serving row'
        USING ERRCODE = '23514';
    END IF;
    identity_sha256 := item->>'projectionIdentitySha256';
    receipt := hot_row.adjustment_revision_receipt;
    -- preserve byte-identical retries and reject stage substitution
    IF receipt IS NOT NULL THEN
      IF receipt->>'projectionKind' <> 'native_source'
        OR receipt->>'projectionIdentitySha256' <> identity_sha256
        OR receipt->>'projectionSha256' <> item->>'projectionSha256'
        OR receipt->>'stageReceiptSha256' <> item->>'stageReceiptSha256' THEN
        RAISE EXCEPTION 'forecast anchor revision receipt retry differs' USING ERRCODE = '23505';
      END IF;
    ELSE
      receipt := weather_issue_adjustment_revision_receipt_v1(
        'native_source', identity_sha256, item->>'projectionSha256',
        item->>'stageReceiptSha256');
      UPDATE forecast_anchor_records SET adjustment_revision_receipt = receipt
      WHERE id = hot_row.id;
    END IF;
    receipts := receipts || jsonb_build_array(jsonb_build_object(
      'storedContentSha256', hot_row.content_hash,
      'leadHours', hot_row.lead_hours,
      'revisionReceipt', receipt,
      'sourceId', hot_row.source_id::text,
      'validAt', valid_at_text
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'contractVersion', 'adjustment-revision-batch-receipt/v1',
    'receipts', receipts
  );
END;
$$;

-- replace the rain row's blanket mutation guard with one exact pointer transition
DROP TRIGGER rain_adjustment_runs_immutable ON rain_adjustment_runs;
CREATE FUNCTION weather_guard_rain_adjustment_revision_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- reject deletion and every content mutation
  IF TG_OP <> 'UPDATE' OR ROW(NEW.run_initialized_at, NEW.model_sha256,
      NEW.input_sha256, NEW.forecast_claim_id, NEW.first_received_at,
      NEW.decision_at, NEW.generated_at, NEW.hours)
    IS DISTINCT FROM ROW(OLD.run_initialized_at, OLD.model_sha256,
      OLD.input_sha256, OLD.forecast_claim_id, OLD.first_received_at,
      OLD.decision_at, OLD.generated_at, OLD.hours)
    OR NEW.adjustment_revision_receipt IS NULL
    OR (OLD.adjustment_revision_receipt IS NOT NULL
      AND NEW.adjustment_revision_receipt->>'contractVersion' <>
        'adjustment-revision-gap-marker/v1') THEN
    RAISE EXCEPTION 'rain adjustment rows are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rain_adjustment_runs_immutable
BEFORE UPDATE OR DELETE ON rain_adjustment_runs
FOR EACH ROW EXECUTE FUNCTION weather_guard_rain_adjustment_revision_v1();

-- bind one rain gate projection derived from the stored inference output
CREATE FUNCTION weather_bind_rain_gate_revision_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  hot_row rain_adjustment_runs%ROWTYPE;
  identity_sha256 text;
  projection_sha256 text;
  receipt jsonb;
  run_initialized_at_text text;
BEGIN
  -- require the one closed row-key and durable-stage envelope
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['inputSha256', 'modelSha256', 'projectionIdentitySha256',
        'projectionSha256', 'runInitializedAt', 'stageReceiptSha256',
        'storedContentSha256']
    OR argument->>'inputSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'modelSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionIdentitySha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionSha256' <> argument->>'projectionIdentitySha256'
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'stageReceiptSha256' !~ '^[a-f0-9]{64}$'
    OR octet_length(argument::text) > 2048 THEN
    RAISE EXCEPTION 'rain gate revision item is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT hot_row FROM rain_adjustment_runs
  WHERE run_initialized_at = (argument->>'runInitializedAt')::timestamptz
    AND model_sha256 = argument->>'modelSha256'
    AND input_sha256 = argument->>'inputSha256'
  FOR UPDATE;
  run_initialized_at_text := to_char(hot_row.run_initialized_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- reject normalized timestamp aliases before deriving the exact stored projection
  IF run_initialized_at_text <> argument->>'runInitializedAt' THEN
    RAISE EXCEPTION 'rain gate revision item differs from serving row' USING ERRCODE = '23514';
  END IF;
  projection_sha256 := argument->>'projectionSha256';
  -- bind the staged body to the exact stored rain output bytes
  IF encode(sha256(convert_to(hot_row.hours::text, 'UTF8')), 'hex') <>
      argument->>'storedContentSha256' THEN
    RAISE EXCEPTION 'rain gate stored content differs' USING ERRCODE = '23514';
  END IF;
  identity_sha256 := argument->>'projectionIdentitySha256';
  receipt := hot_row.adjustment_revision_receipt;
  -- preserve byte-identical retries and reject stage substitution
  IF receipt IS NOT NULL THEN
    IF receipt->>'projectionIdentitySha256' <> identity_sha256
      OR receipt->>'projectionSha256' <> projection_sha256
      OR receipt->>'stageReceiptSha256' <> argument->>'stageReceiptSha256' THEN
      RAISE EXCEPTION 'rain gate revision receipt retry differs' USING ERRCODE = '23505';
    END IF;
  ELSE
    receipt := weather_issue_adjustment_revision_receipt_v1(
      'rain_gate_input', identity_sha256, projection_sha256,
      argument->>'stageReceiptSha256');
    UPDATE rain_adjustment_runs SET adjustment_revision_receipt = receipt
    WHERE run_initialized_at = hot_row.run_initialized_at
      AND model_sha256 = hot_row.model_sha256;
  END IF;
  RETURN jsonb_build_object(
    'contractVersion', 'adjustment-revision-row-receipt/v1',
    'revisionReceipt', receipt
  );
END;
$$;

-- bind one complete private temperature run including its exact hour hashes
CREATE FUNCTION weather_bind_ecmwf_temperature_revision_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  hot_row ecmwf_temperature_canary_runs%ROWTYPE;
  identity_sha256 text;
  receipt jsonb;
  run_initialized_at_text text;
BEGIN
  -- require the one closed row-key and durable-stage envelope
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['projectionIdentitySha256', 'projectionSha256',
        'providerResponseSha256', 'runInitializedAt', 'siteId', 'stageReceiptSha256',
        'storedContentSha256']
    OR argument->>'siteId' !~ '^[1-9][0-9]*$'
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'providerResponseSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionIdentitySha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'projectionSha256' <> argument->>'projectionIdentitySha256'
    OR argument->>'stageReceiptSha256' !~ '^[a-f0-9]{64}$'
    OR octet_length(argument::text) > 2048 THEN
    RAISE EXCEPTION 'temperature revision item is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT hot_row FROM ecmwf_temperature_canary_runs
  WHERE site_id = (argument->>'siteId')::bigint
    AND run_initialized_at = (argument->>'runInitializedAt')::timestamptz
  FOR UPDATE;
  run_initialized_at_text := to_char(hot_row.run_initialized_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- crossbind every caller key to the stored run and aggregate hour identity
  IF hot_row.content_hash <> argument->>'storedContentSha256'
    OR hot_row.provider_response_sha256 <> argument->>'providerResponseSha256'
    OR run_initialized_at_text <> argument->>'runInitializedAt'
    OR (SELECT count(*) FROM ecmwf_temperature_canary_hours hour
      WHERE hour.run_id = hot_row.id) <> 18 THEN
    RAISE EXCEPTION 'temperature revision item differs from serving row' USING ERRCODE = '23514';
  END IF;
  identity_sha256 := argument->>'projectionIdentitySha256';
  receipt := hot_row.adjustment_revision_receipt;
  -- preserve byte-identical retries and reject stage substitution
  IF receipt IS NOT NULL THEN
    IF receipt->>'projectionIdentitySha256' <> identity_sha256
      OR receipt->>'projectionSha256' <> argument->>'projectionSha256'
      OR receipt->>'stageReceiptSha256' <> argument->>'stageReceiptSha256' THEN
      RAISE EXCEPTION 'temperature revision receipt retry differs' USING ERRCODE = '23505';
    END IF;
  ELSE
    receipt := weather_issue_adjustment_revision_receipt_v1(
      'native_source', identity_sha256, argument->>'projectionSha256',
      argument->>'stageReceiptSha256');
    UPDATE ecmwf_temperature_canary_runs SET adjustment_revision_receipt = receipt
    WHERE id = hot_row.id;
  END IF;
  RETURN jsonb_build_object(
    'contractVersion', 'adjustment-revision-row-receipt/v1',
    'revisionReceipt', receipt
  );
END;
$$;

-- export one frozen value-free current-pointer snapshot for cold archival
CREATE FUNCTION adjustment_revision_serving_snapshot_v1(
  cutoff_argument timestamptz,
  archive_commit_ordinal_argument bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  frontier adjustment_revision_frontier_v1%ROWTYPE;
  entries jsonb;
  result jsonb;
  cutoff_text text;
BEGIN
  SELECT * INTO STRICT frontier FROM adjustment_revision_frontier_v1 WHERE singleton;
  cutoff_text := to_char(cutoff_argument AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- require the exact frontier observed inside the caller's frozen transaction
  IF archive_commit_ordinal_argument <> frontier.archive_commit_ordinal THEN
    RAISE EXCEPTION 'adjustment revision snapshot watermark differs' USING ERRCODE = '40001';
  END IF;
  WITH current_pointers AS (
    SELECT first_received_at AS logical_received_at,
      adjustment_revision_receipt AS receipt, 'weather_records'::text AS relation
    FROM weather_records
    WHERE adjustment_revision_receipt->>'contractVersion' =
      'adjustment-revision-commit-receipt/v1' AND first_received_at <= cutoff_argument
    UNION ALL
    SELECT first_received_at, adjustment_revision_receipt, 'forecast_anchor_records'
    FROM forecast_anchor_records
    WHERE adjustment_revision_receipt->>'contractVersion' =
      'adjustment-revision-commit-receipt/v1' AND first_received_at <= cutoff_argument
    UNION ALL
    SELECT first_received_at, adjustment_revision_receipt, 'rain_adjustment_runs'
    FROM rain_adjustment_runs
    WHERE adjustment_revision_receipt->>'contractVersion' =
      'adjustment-revision-commit-receipt/v1' AND first_received_at <= cutoff_argument
    UNION ALL
    SELECT first_received_at, adjustment_revision_receipt, 'ecmwf_temperature_canary_runs'
    FROM ecmwf_temperature_canary_runs
    WHERE adjustment_revision_receipt->>'contractVersion' =
      'adjustment-revision-commit-receipt/v1' AND first_received_at <= cutoff_argument
  ), bounded AS (
    SELECT * FROM current_pointers
    WHERE (receipt->>'archiveCommitOrdinal')::bigint <= archive_commit_ordinal_argument
    ORDER BY (receipt->>'archiveCommitOrdinal')::bigint
    LIMIT 4097
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'logicalReceivedAt', to_char(logical_received_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receipt', receipt,
    'relation', relation
  ) ORDER BY (receipt->>'archiveCommitOrdinal')::bigint), '[]'::jsonb)
  INTO entries FROM bounded;
  -- reject truncation instead of publishing an incomplete snapshot
  IF jsonb_array_length(entries) > 4096 THEN
    RAISE EXCEPTION 'adjustment revision snapshot exceeds entry bound' USING ERRCODE = '54000';
  END IF;
  result := jsonb_build_object(
    'archiveCommitOrdinal', archive_commit_ordinal_argument::text,
    'contractVersion', 'adjustment-revision-serving-snapshot/v1',
    'cutoffAt', cutoff_text,
    'entryCount', jsonb_array_length(entries),
    'entries', entries,
    'frontierSha256', frontier.frontier_sha256,
    'snapshotSha256', encode(sha256(convert_to(
      'adjustment-revision-serving-snapshot/v1' || E'\n' || cutoff_text || E'\n'
        || archive_commit_ordinal_argument::text || E'\n' || frontier.frontier_sha256 || E'\n'
        || coalesce((SELECT string_agg(entry->'receipt'->>'receiptSha256', E'\n'
          ORDER BY (entry->'receipt'->>'archiveCommitOrdinal')::bigint)
          FROM jsonb_array_elements(entries) entry), ''),
      'UTF8')), 'hex')
  );
  -- cap the complete metadata document before it leaves the database
  IF octet_length(result::text) > 4194304 THEN
    RAISE EXCEPTION 'adjustment revision snapshot exceeds byte bound' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END;
$$;

-- return one exact persisted weather pointer without serving values
CREATE FUNCTION adjustment_weather_revision_admission_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE receipt jsonb;
BEGIN
  -- require the closed comparator or target logical key
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['productRunAt', 'sourceId', 'sourceKind', 'storedContentSha256', 'validAt']
    OR argument->>'sourceId' !~ '^[1-9][0-9]*$'
    OR argument->>'sourceKind' NOT IN ('forecast', 'physical_sensor')
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'weather revision admission key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT adjustment_revision_receipt INTO receipt FROM weather_records
  WHERE source_id = (argument->>'sourceId')::bigint
    AND source_kind = argument->>'sourceKind'
    AND valid_at = (argument->>'validAt')::timestamptz
    AND product_run_at IS NOT DISTINCT FROM
      CASE WHEN argument->'productRunAt' = 'null'::jsonb THEN NULL
        ELSE (argument->>'productRunAt')::timestamptz END
    AND content_hash = argument->>'storedContentSha256';
  -- exclude permanent gap markers from qualified API admission
  IF receipt->>'contractVersion' <> 'adjustment-revision-commit-receipt/v1' THEN
    RETURN NULL;
  END IF;
  RETURN receipt;
END;
$$;

-- return one exact persisted forecast-anchor pointer without serving values
CREATE FUNCTION adjustment_forecast_anchor_revision_admission_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE receipt jsonb;
BEGIN
  -- require the closed fixed-anchor logical key
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['leadHours', 'sourceId', 'storedContentSha256', 'validAt']
    OR argument->>'sourceId' !~ '^[1-9][0-9]*$'
    OR argument->>'leadHours' !~ '^[1-9][0-9]*$'
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'forecast anchor revision admission key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT adjustment_revision_receipt INTO receipt FROM forecast_anchor_records
  WHERE source_id = (argument->>'sourceId')::bigint
    AND valid_at = (argument->>'validAt')::timestamptz
    AND lead_hours = (argument->>'leadHours')::smallint
    AND content_hash = argument->>'storedContentSha256';
  -- exclude permanent gap markers from qualified API admission
  IF receipt->>'contractVersion' <> 'adjustment-revision-commit-receipt/v1' THEN
    RETURN NULL;
  END IF;
  RETURN receipt;
END;
$$;

-- return one exact persisted rain-gate pointer without serving values
CREATE FUNCTION adjustment_rain_gate_revision_admission_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE receipt jsonb;
BEGIN
  -- require the closed rain gate logical key and retained content identity
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['inputSha256', 'modelSha256', 'runInitializedAt', 'storedContentSha256']
    OR argument->>'inputSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'modelSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'rain gate revision admission key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT adjustment_revision_receipt INTO receipt FROM rain_adjustment_runs
  WHERE run_initialized_at = (argument->>'runInitializedAt')::timestamptz
    AND model_sha256 = argument->>'modelSha256'
    AND input_sha256 = argument->>'inputSha256'
    AND encode(sha256(convert_to(hours::text, 'UTF8')), 'hex') =
      argument->>'storedContentSha256';
  -- exclude permanent gap markers from qualified API admission
  IF receipt->>'contractVersion' <> 'adjustment-revision-commit-receipt/v1' THEN
    RETURN NULL;
  END IF;
  RETURN receipt;
END;
$$;

-- return one exact persisted complete-temperature pointer without serving values
CREATE FUNCTION adjustment_ecmwf_temperature_revision_admission_v1(argument jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE receipt jsonb;
BEGIN
  -- require the closed complete-run logical key
  IF jsonb_typeof(argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(argument) key ORDER BY key) <>
      ARRAY['providerResponseSha256', 'runInitializedAt', 'siteId', 'storedContentSha256']
    OR argument->>'siteId' !~ '^[1-9][0-9]*$'
    OR argument->>'providerResponseSha256' !~ '^[a-f0-9]{64}$'
    OR argument->>'storedContentSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'temperature revision admission key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT adjustment_revision_receipt INTO receipt FROM ecmwf_temperature_canary_runs
  WHERE site_id = (argument->>'siteId')::bigint
    AND run_initialized_at = (argument->>'runInitializedAt')::timestamptz
    AND provider_response_sha256 = argument->>'providerResponseSha256'
    AND content_hash = argument->>'storedContentSha256';
  -- exclude permanent gap markers from qualified API admission
  IF receipt->>'contractVersion' <> 'adjustment-revision-commit-receipt/v1' THEN
    RETURN NULL;
  END IF;
  RETURN receipt;
END;
$$;

-- mark one exact current revision permanently unqualified after a durable archive gap
CREATE FUNCTION weather_mark_adjustment_revision_gap_v1(
  relation_kind_argument text,
  key_argument jsonb,
  gap_argument jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_pointer jsonb;
  expected_projection_kind text;
  marker jsonb;
  stored_content_sha256 text;
BEGIN
  -- require the exact value-free durable-gap contract
  IF jsonb_typeof(gap_argument) <> 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(gap_argument) key ORDER BY key) <>
      ARRAY['logicalKeySha256', 'projectionIdentitySha256', 'projectionKind',
        'projectionSha256', 'reason']
    OR gap_argument->>'logicalKeySha256' !~ '^[a-f0-9]{64}$'
    OR gap_argument->>'projectionKind' NOT IN (
      'actual_best_match', 'native_source', 'rain_gate_input', 'target_revision')
    OR gap_argument->>'reason' NOT IN ('archive_stage_failed', 'database_bind_failed',
      'database_admission_failed', 'archive_publish_failed')
    OR ((gap_argument->'projectionIdentitySha256' = 'null'::jsonb) <>
      (gap_argument->'projectionSha256' = 'null'::jsonb))
    OR (gap_argument->'projectionIdentitySha256' <> 'null'::jsonb
      AND (gap_argument->>'projectionIdentitySha256' !~ '^[a-f0-9]{64}$'
        OR gap_argument->>'projectionSha256' <> gap_argument->>'projectionIdentitySha256')) THEN
    RAISE EXCEPTION 'adjustment revision gap is invalid' USING ERRCODE = '22023';
  END IF;
  -- bind one of the four fixed serving-row key grammars
  IF relation_kind_argument = 'weather_record' THEN
    IF ARRAY(SELECT key FROM jsonb_object_keys(key_argument) key ORDER BY key) <>
        ARRAY['productRunAt', 'sourceId', 'sourceKind', 'storedContentSha256', 'validAt']
      OR key_argument->>'sourceId' !~ '^[1-9][0-9]*$'
      OR key_argument->>'sourceKind' NOT IN ('forecast', 'physical_sensor') THEN
      RAISE EXCEPTION 'weather revision gap key is invalid' USING ERRCODE = '22023';
    END IF;
    stored_content_sha256 := key_argument->>'storedContentSha256';
    expected_projection_kind := CASE key_argument->>'sourceKind'
      WHEN 'forecast' THEN 'actual_best_match' ELSE 'target_revision' END;
    SELECT adjustment_revision_receipt INTO current_pointer FROM weather_records
    WHERE source_id = (key_argument->>'sourceId')::bigint
      AND source_kind = key_argument->>'sourceKind'
      AND valid_at = (key_argument->>'validAt')::timestamptz
      AND product_run_at IS NOT DISTINCT FROM
        CASE WHEN key_argument->'productRunAt' = 'null'::jsonb THEN NULL
          ELSE (key_argument->>'productRunAt')::timestamptz END
      AND content_hash = stored_content_sha256 FOR UPDATE;
  ELSIF relation_kind_argument = 'forecast_anchor' THEN
    IF ARRAY(SELECT key FROM jsonb_object_keys(key_argument) key ORDER BY key) <>
        ARRAY['leadHours', 'sourceId', 'storedContentSha256', 'validAt']
      OR key_argument->>'sourceId' !~ '^[1-9][0-9]*$'
      OR key_argument->>'leadHours' !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'forecast anchor revision gap key is invalid' USING ERRCODE = '22023';
    END IF;
    stored_content_sha256 := key_argument->>'storedContentSha256';
    expected_projection_kind := 'native_source';
    SELECT adjustment_revision_receipt INTO current_pointer FROM forecast_anchor_records
    WHERE source_id = (key_argument->>'sourceId')::bigint
      AND valid_at = (key_argument->>'validAt')::timestamptz
      AND lead_hours = (key_argument->>'leadHours')::smallint
      AND content_hash = stored_content_sha256 FOR UPDATE;
  ELSIF relation_kind_argument = 'rain_gate' THEN
    IF ARRAY(SELECT key FROM jsonb_object_keys(key_argument) key ORDER BY key) <>
        ARRAY['inputSha256', 'modelSha256', 'runInitializedAt', 'storedContentSha256']
      OR key_argument->>'inputSha256' !~ '^[a-f0-9]{64}$'
      OR key_argument->>'modelSha256' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'rain gate revision gap key is invalid' USING ERRCODE = '22023';
    END IF;
    stored_content_sha256 := key_argument->>'storedContentSha256';
    expected_projection_kind := 'rain_gate_input';
    SELECT adjustment_revision_receipt INTO current_pointer FROM rain_adjustment_runs
    WHERE run_initialized_at = (key_argument->>'runInitializedAt')::timestamptz
      AND model_sha256 = key_argument->>'modelSha256'
      AND input_sha256 = key_argument->>'inputSha256'
      AND encode(sha256(convert_to(hours::text, 'UTF8')), 'hex') = stored_content_sha256
    FOR UPDATE;
  ELSIF relation_kind_argument = 'ecmwf_temperature' THEN
    IF ARRAY(SELECT key FROM jsonb_object_keys(key_argument) key ORDER BY key) <>
        ARRAY['providerResponseSha256', 'runInitializedAt', 'siteId', 'storedContentSha256']
      OR key_argument->>'siteId' !~ '^[1-9][0-9]*$'
      OR key_argument->>'providerResponseSha256' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'temperature revision gap key is invalid' USING ERRCODE = '22023';
    END IF;
    stored_content_sha256 := key_argument->>'storedContentSha256';
    expected_projection_kind := 'native_source';
    SELECT adjustment_revision_receipt INTO current_pointer
    FROM ecmwf_temperature_canary_runs
    WHERE site_id = (key_argument->>'siteId')::bigint
      AND run_initialized_at = (key_argument->>'runInitializedAt')::timestamptz
      AND provider_response_sha256 = key_argument->>'providerResponseSha256'
      AND content_hash = stored_content_sha256 FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'adjustment revision gap relation is invalid' USING ERRCODE = '22023';
  END IF;
  -- refuse nonexistent or substituted current content
  IF NOT FOUND OR stored_content_sha256 !~ '^[a-f0-9]{64}$'
    OR gap_argument->>'projectionKind' <> expected_projection_kind THEN
    RAISE EXCEPTION 'adjustment revision gap differs from serving row' USING ERRCODE = '23514';
  END IF;
  marker := jsonb_build_object(
    'contractVersion', 'adjustment-revision-gap-marker/v1',
    'logicalKeySha256', gap_argument->>'logicalKeySha256',
    'projectionIdentitySha256', gap_argument->'projectionIdentitySha256',
    'projectionKind', gap_argument->>'projectionKind',
    'projectionSha256', gap_argument->'projectionSha256',
    'reason', gap_argument->>'reason',
    'storedContentSha256', stored_content_sha256
  );
  -- preserve an exact permanent retry and reject relabelling
  IF current_pointer->>'contractVersion' = 'adjustment-revision-gap-marker/v1' THEN
    IF current_pointer <> marker THEN
      RAISE EXCEPTION 'adjustment revision gap marker collision' USING ERRCODE = '23505';
    END IF;
    RETURN marker;
  END IF;
  -- replace only the exact current pointer selected above
  IF relation_kind_argument = 'weather_record' THEN
    UPDATE weather_records SET adjustment_revision_receipt = marker
    WHERE source_id = (key_argument->>'sourceId')::bigint
      AND source_kind = key_argument->>'sourceKind'
      AND valid_at = (key_argument->>'validAt')::timestamptz
      AND product_run_at IS NOT DISTINCT FROM
        CASE WHEN key_argument->'productRunAt' = 'null'::jsonb THEN NULL
          ELSE (key_argument->>'productRunAt')::timestamptz END;
  ELSIF relation_kind_argument = 'forecast_anchor' THEN
    UPDATE forecast_anchor_records SET adjustment_revision_receipt = marker
    WHERE source_id = (key_argument->>'sourceId')::bigint
      AND valid_at = (key_argument->>'validAt')::timestamptz
      AND lead_hours = (key_argument->>'leadHours')::smallint;
  ELSIF relation_kind_argument = 'rain_gate' THEN
    UPDATE rain_adjustment_runs SET adjustment_revision_receipt = marker
    WHERE run_initialized_at = (key_argument->>'runInitializedAt')::timestamptz
      AND model_sha256 = key_argument->>'modelSha256';
  ELSE
    UPDATE ecmwf_temperature_canary_runs SET adjustment_revision_receipt = marker
    WHERE site_id = (key_argument->>'siteId')::bigint
      AND run_initialized_at = (key_argument->>'runInitializedAt')::timestamptz;
  END IF;
  RETURN marker;
END;
$$;

-- keep internal assignment owner-only and grant only the bounded frontier read
REVOKE ALL ON TABLE adjustment_revision_frontier_v1
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
REVOKE ALL ON SEQUENCE adjustment_revision_ordinal_v1
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
REVOKE EXECUTE ON FUNCTION weather_append_adjustment_shadow_v4(jsonb,text),
  weather_adjustment_revision_receipt_valid_v1(jsonb),
  weather_clear_adjustment_revision_pointer_v1(),
  weather_issue_adjustment_revision_receipt_v1(text,text,text,text),
  weather_bind_weather_record_revisions_v1(jsonb),
  weather_bind_forecast_anchor_revisions_v1(jsonb),
  weather_guard_rain_adjustment_revision_v1(),
  weather_bind_rain_gate_revision_v1(jsonb),
  weather_bind_ecmwf_temperature_revision_v1(jsonb),
  adjustment_revision_frontier_v1(),
  adjustment_shadow_revision_admission_v1(text,text,text,integer),
  adjustment_revision_serving_snapshot_v1(timestamptz,bigint),
  adjustment_weather_revision_admission_v1(jsonb),
  adjustment_forecast_anchor_revision_admission_v1(jsonb),
  adjustment_rain_gate_revision_admission_v1(jsonb),
  adjustment_ecmwf_temperature_revision_admission_v1(jsonb)
  ,weather_mark_adjustment_revision_gap_v1(text,jsonb,jsonb)
FROM PUBLIC, weather_api, weather_ingest, weather_training_export;
GRANT EXECUTE ON FUNCTION adjustment_revision_frontier_v1()
TO weather_training_export;
GRANT EXECUTE ON FUNCTION adjustment_shadow_revision_admission_v1(text,text,text,integer)
TO weather_api;
GRANT EXECUTE ON FUNCTION adjustment_weather_revision_admission_v1(jsonb),
  adjustment_forecast_anchor_revision_admission_v1(jsonb),
  adjustment_rain_gate_revision_admission_v1(jsonb),
  adjustment_ecmwf_temperature_revision_admission_v1(jsonb)
TO weather_api;
GRANT EXECUTE ON FUNCTION weather_bind_weather_record_revisions_v1(jsonb),
  weather_bind_forecast_anchor_revisions_v1(jsonb),
  weather_bind_rain_gate_revision_v1(jsonb),
  weather_bind_ecmwf_temperature_revision_v1(jsonb)
TO weather_ingest;
GRANT EXECUTE ON FUNCTION weather_mark_adjustment_revision_gap_v1(text,jsonb,jsonb)
TO weather_api, weather_ingest;
GRANT EXECUTE ON FUNCTION adjustment_revision_serving_snapshot_v1(timestamptz,bigint)
TO weather_training_export;
