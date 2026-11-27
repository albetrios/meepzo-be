-- Migration: app_instagram_conversation_messages
-- Created: 2026-11-27T03:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
-- migration-safety: allow drop_table reason="the DROP TABLE is inside fn_manage_time_partitions' body, copied unchanged from 20261127010000_app_instagram_outgoing_messages_rename.sql (the upkeep's part drop past the keep days); this migration drops nothing"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R3 (routes-final § 2.B.3, I-D14): every message of a
-- conversation, both ways, split by month of `sent_at` and kept 12 months (I-D5): the shared partition
-- upkeep makes and drops the parts — its CASE gains the table as a month table. New table only: nothing
-- existing changes.

CREATE TABLE IF NOT EXISTS app.instagram_conversation_messages (
  id BIGSERIAL NOT NULL,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_conversation_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  sender_type VARCHAR(20) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  text VARCHAR(2200),
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_meta_message_id VARCHAR(1024),
  reaction JSONB,
  meta_message_id VARCHAR(1024),
  automation_id BIGINT,
  automation_run_id BIGINT,
  broadcast_id BIGINT,
  instagram_outgoing_message_id BIGINT,
  sent_by_membership_id BIGINT,
  send_status VARCHAR(10),
  failure_reason VARCHAR(50),
  is_edited BOOLEAN NOT NULL DEFAULT false,
  edited_at TIMESTAMPTZ,
  is_unsent BOOLEAN NOT NULL DEFAULT false,
  seen_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instagram_conversation_messages_pkey PRIMARY KEY (id, sent_at),
  CONSTRAINT instagram_conversation_messages_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversation_messages_conversation_fk FOREIGN KEY (organization_id, instagram_conversation_id) REFERENCES app.instagram_conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversation_messages_sent_by_membership_fk FOREIGN KEY (organization_id, sent_by_membership_id) REFERENCES tenancy.memberships (organization_id, id),
  CONSTRAINT chk_instagram_conversation_messages_sender_type CHECK (sender_type IN ('contact', 'automation', 'broadcast', 'team_member', 'instagram_app')),
  CONSTRAINT chk_instagram_conversation_messages_kind CHECK (kind IN ('text', 'image', 'video', 'audio', 'file', 'story_reply', 'story_mention', 'shared_post', 'button_tap', 'reaction', 'referral')),
  CONSTRAINT chk_instagram_conversation_messages_send_status CHECK (
    (send_status IS NULL OR send_status IN ('sending', 'sent', 'failed'))
    AND ((sender_type = 'team_member') = (send_status IS NOT NULL))
  ),
  CONSTRAINT chk_instagram_conversation_messages_sent_by CHECK ((sender_type = 'team_member') = (sent_by_membership_id IS NOT NULL)),
  CONSTRAINT chk_instagram_conversation_messages_attachments CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10),
  CONSTRAINT chk_instagram_conversation_messages_edited CHECK (is_edited = (edited_at IS NOT NULL))
) PARTITION BY RANGE (sent_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversation_messages_public_id ON app.instagram_conversation_messages USING btree (public_id, sent_at);
--> statement-breakpoint
-- The thread's keyset: newest first, then id.
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_messages_thread ON app.instagram_conversation_messages USING btree (instagram_conversation_id, sent_at DESC, id DESC);
--> statement-breakpoint
-- Once per Meta message id (the intake's and the echo's dedupe); a split table's unique index carries the split key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversation_messages_meta_message_id ON app.instagram_conversation_messages USING btree (channel_account_id, meta_message_id, sent_at) WHERE meta_message_id IS NOT NULL;
--> statement-breakpoint
-- The stuck-`sending` repair (CVC3).
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_messages_sending ON app.instagram_conversation_messages USING btree (send_status, created_at) WHERE send_status = 'sending';
--> statement-breakpoint
-- The conversation key and the erase step.
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_messages_conversation ON app.instagram_conversation_messages USING btree (organization_id, instagram_conversation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_messages_sent_by_membership ON app.instagram_conversation_messages USING btree (organization_id, sent_by_membership_id) WHERE sent_by_membership_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_messages OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_conversation_messages TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_conversation_messages_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_conversation_messages_tenant_isolation ON app.instagram_conversation_messages;
--> statement-breakpoint
CREATE POLICY instagram_conversation_messages_tenant_isolation ON app.instagram_conversation_messages
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
    OR (
      (SELECT current_setting('app.global_retention_cleanup', true)) = 'true'
      AND (SELECT current_user) = 'meepzo_be_maintenance'
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
--> statement-breakpoint
-- The month parts: three back, three ahead (the upkeep keeps them ahead from here), and the DEFAULT part.
SELECT app.fn_create_monthly_partitions('app.instagram_conversation_messages'::regclass, ((now() AT TIME ZONE 'UTC')::date - INTERVAL '3 months')::date, ((now() AT TIME ZONE 'UTC')::date + INTERVAL '3 months')::date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_conversation_messages_default PARTITION OF app.instagram_conversation_messages DEFAULT;
--> statement-breakpoint
REVOKE ALL ON TABLE app.instagram_conversation_messages_default FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_messages_default OWNER TO meepzo_be_owner;
--> statement-breakpoint

-- The partition upkeep visits it as a month table: the body below is
-- 20261127010000_app_instagram_outgoing_messages_rename.sql's, with the one entry added; CREATE OR REPLACE
-- keeps its owner and grants.
CREATE OR REPLACE FUNCTION app.fn_manage_time_partitions (
  parent_table_param REGCLASS,
  make_ahead_days_param INTEGER,
  keep_days_param INTEGER,
  drop_parts_param BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  parent_table_name TEXT;
  part_unit TEXT;
  partition_key_name TEXT;
  partition_key_type REGTYPE;
  today_date DATE := (now() AT TIME ZONE 'UTC')::date;
  unit_start DATE;
  unit_end DATE;
  last_ahead_day DATE;
  part_name TEXT;
  part_suffix TEXT;
  default_part_name TEXT;
  lower_bound TEXT;
  upper_bound TEXT;
  column_list TEXT;
  is_referenced BOOLEAN;
  has_open_run BOOLEAN;
  part_has_rows BOOLEAN;
  attempt_number INTEGER;
  moved_count BIGINT;
  created_count INTEGER := 0;
  moved_row_count BIGINT := 0;
  dropped_count INTEGER := 0;
  lock_timeout_count INTEGER := 0;
  blocked_parts TEXT[] := ARRAY[]::TEXT[];
  held_parts TEXT[] := ARRAY[]::TEXT[];
  failed_drops TEXT[] := ARRAY[]::TEXT[];
  ready_until DATE;
  default_row_count BIGINT := 0;
  overdue_seconds BIGINT := 0;
  part_record RECORD;
BEGIN
  SELECT class.relname, attribute.attname, attribute.atttypid::regtype
    INTO parent_table_name, partition_key_name, partition_key_type
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    JOIN pg_partitioned_table AS partitioned ON partitioned.partrelid = class.oid
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = class.oid AND attribute.attnum = partitioned.partattrs[0]
   WHERE class.oid = parent_table_param
     AND namespace.nspname = 'app'
     AND class.relkind = 'p';
  part_unit := CASE parent_table_name
    WHEN 'instagram_webhook_events' THEN 'day'
    WHEN 'instagram_webhook_event_keys' THEN 'day'
    WHEN 'instagram_send_attempts' THEN 'day'
    WHEN 'instagram_outgoing_messages' THEN 'week'
    WHEN 'automation_comment_logs' THEN 'month'
    WHEN 'instagram_conversation_messages' THEN 'month'
    WHEN 'automation_run_events' THEN 'month'
    WHEN 'automation_runs' THEN 'month'
  END;
  IF part_unit IS NULL THEN
    RAISE EXCEPTION 'fn_manage_time_partitions: % is not one of the time-split app tables', parent_table_param;
  END IF;
  -- S17: never fewer than 14 days ahead; never a keep time below the shortest one (8 days, D15).
  IF make_ahead_days_param IS NULL OR make_ahead_days_param < 14 OR make_ahead_days_param > 400 THEN
    RAISE EXCEPTION 'fn_manage_time_partitions: make_ahead_days % refused', make_ahead_days_param;
  END IF;
  IF keep_days_param IS NULL OR keep_days_param < 8 OR keep_days_param > 400 THEN
    RAISE EXCEPTION 'fn_manage_time_partitions: keep_days % refused', keep_days_param;
  END IF;
  default_part_name := parent_table_name || '_default';
  is_referenced := EXISTS (
    SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = parent_table_param AND conparentid = 0
  );

  -- 1–2. Make the coming parts, one at a time.
  last_ahead_day := today_date + make_ahead_days_param;
  unit_start := CASE part_unit
    WHEN 'day' THEN today_date
    WHEN 'week' THEN date_trunc('week', today_date)::date
    ELSE date_trunc('month', today_date)::date
  END;
  WHILE unit_start <= last_ahead_day LOOP
    unit_end := CASE part_unit
      WHEN 'day' THEN unit_start + 1
      WHEN 'week' THEN unit_start + 7
      ELSE (unit_start + INTERVAL '1 month')::date
    END;
    part_suffix := CASE part_unit
      WHEN 'day' THEN to_char(unit_start, 'YYYYMMDD')
      WHEN 'week' THEN to_char(unit_start, 'IYYY') || 'w' || to_char(unit_start, 'IW')
      ELSE to_char(unit_start, 'YYYYMM')
    END;
    part_name := parent_table_name || '_p' || part_suffix;
    IF to_regclass(format('app.%I', part_name)) IS NULL THEN
      BEGIN
        PERFORM CASE part_unit
          WHEN 'day' THEN app.fn_create_daily_partitions(parent_table_param, unit_start, unit_start)
          WHEN 'week' THEN app.fn_create_weekly_partitions(parent_table_param, unit_start, unit_start)
          ELSE app.fn_create_monthly_partitions(parent_table_param, unit_start, unit_start)
        END;
        created_count := created_count + 1;
      EXCEPTION
        WHEN check_violation THEN
          -- The DEFAULT part holds rows of this range: move them into the new part, unless
          -- something points into this table (deleting them would cascade or be refused).
          IF is_referenced THEN
            blocked_parts := blocked_parts || part_name;
          ELSE
            BEGIN
              IF partition_key_type = 'date'::regtype THEN
                lower_bound := to_char(unit_start, 'YYYY-MM-DD');
                upper_bound := to_char(unit_end, 'YYYY-MM-DD');
              ELSE
                lower_bound := to_char(unit_start, 'YYYY-MM-DD') || ' 00:00:00+00';
                upper_bound := to_char(unit_end, 'YYYY-MM-DD') || ' 00:00:00+00';
              END IF;
              -- Generated columns are computed again on the insert.
              SELECT string_agg(quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum)
                INTO column_list
                FROM pg_attribute AS attribute
               WHERE attribute.attrelid = parent_table_param
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
                 AND attribute.attgenerated = '';
              EXECUTE format(
                'CREATE TEMP TABLE app_partition_upkeep_moved_rows ON COMMIT DROP AS SELECT %s FROM app.%I WITH NO DATA',
                column_list, default_part_name
              );
              EXECUTE format(
                'WITH moved AS (DELETE FROM app.%I WHERE %I >= %L AND %I < %L RETURNING %s) '
                || 'INSERT INTO pg_temp.app_partition_upkeep_moved_rows (%s) SELECT %s FROM moved',
                default_part_name, partition_key_name, lower_bound, partition_key_name, upper_bound,
                column_list, column_list, column_list
              );
              GET DIAGNOSTICS moved_count = ROW_COUNT;
              PERFORM CASE part_unit
                WHEN 'day' THEN app.fn_create_daily_partitions(parent_table_param, unit_start, unit_start)
                WHEN 'week' THEN app.fn_create_weekly_partitions(parent_table_param, unit_start, unit_start)
                ELSE app.fn_create_monthly_partitions(parent_table_param, unit_start, unit_start)
              END;
              EXECUTE format(
                'INSERT INTO app.%I (%s) SELECT %s FROM pg_temp.app_partition_upkeep_moved_rows',
                part_name, column_list, column_list
              );
              DROP TABLE IF EXISTS pg_temp.app_partition_upkeep_moved_rows;
              created_count := created_count + 1;
              moved_row_count := moved_row_count + moved_count;
            EXCEPTION
              WHEN OTHERS THEN
                RAISE WARNING 'fn_manage_time_partitions: moving the DEFAULT rows of % failed: %', part_name, SQLERRM;
                blocked_parts := blocked_parts || part_name;
            END;
          END IF;
        WHEN lock_not_available THEN
          lock_timeout_count := lock_timeout_count + 1;
        WHEN duplicate_table THEN
          -- Another worker made it first.
          NULL;
      END;
    END IF;
    unit_start := unit_end;
  END LOOP;

  -- 3. Drop the parts past their keep time, oldest first.
  IF drop_parts_param THEN
    FOR part_record IN
      SELECT child.relname AS name, substr(child.relname, length(parent_table_name) + 3) AS suffix
        FROM pg_inherits AS inheritance
        JOIN pg_class AS child ON child.oid = inheritance.inhrelid
       WHERE inheritance.inhparent = parent_table_param
         AND child.relname <> default_part_name
       ORDER BY child.relname
    LOOP
      unit_start := CASE
        WHEN part_unit = 'day' AND part_record.suffix ~ '^[0-9]{8}$' THEN to_date(part_record.suffix, 'YYYYMMDD')
        WHEN part_unit = 'week' AND part_record.suffix ~ '^[0-9]{4}w[0-9]{2}$' THEN to_date(part_record.suffix, 'IYYY"w"IW')
        WHEN part_unit = 'month' AND part_record.suffix ~ '^[0-9]{6}$' THEN to_date(part_record.suffix, 'YYYYMM')
      END;
      CONTINUE WHEN unit_start IS NULL;
      unit_end := CASE part_unit
        WHEN 'day' THEN unit_start + 1
        WHEN 'week' THEN unit_start + 7
        ELSE (unit_start + INTERVAL '1 month')::date
      END;
      CONTINUE WHEN (unit_end::timestamp AT TIME ZONE 'UTC') + make_interval(days => keep_days_param) > now();

      -- AU36 (5): a runs part (and its run-events part) that still holds an open run is kept.
      IF parent_table_name IN ('automation_runs', 'automation_run_events')
         AND to_regclass(format('app.%I', 'automation_runs_p' || part_record.suffix)) IS NOT NULL THEN
        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM app.%I WHERE status IN (''running'', ''waiting''))',
          'automation_runs_p' || part_record.suffix
        ) INTO has_open_run;
        IF has_open_run THEN
          held_parts := held_parts || part_record.name::TEXT;
          CONTINUE;
        END IF;
      END IF;

      attempt_number := 1;
      LOOP
        BEGIN
          EXECUTE format('ALTER TABLE app.%I DETACH PARTITION app.%I', parent_table_name, part_record.name);
          EXECUTE format('DROP TABLE IF EXISTS app.%I', part_record.name);
          dropped_count := dropped_count + 1;
          EXIT;
        EXCEPTION
          WHEN lock_not_available THEN
            lock_timeout_count := lock_timeout_count + 1;
            IF attempt_number >= 3 THEN
              failed_drops := failed_drops || part_record.name::TEXT;
              EXIT;
            END IF;
            attempt_number := attempt_number + 1;
            PERFORM pg_sleep(0.5);
          WHEN OTHERS THEN
            -- e.g. a row elsewhere still points into it (a leftover open-run key): next hour.
            RAISE WARNING 'fn_manage_time_partitions: dropping % failed: %', part_record.name, SQLERRM;
            failed_drops := failed_drops || part_record.name::TEXT;
            EXIT;
        END;
      END LOOP;
    END LOOP;
  END IF;

  -- 4. The report.
  ready_until := today_date;
  LOOP
    unit_start := CASE part_unit
      WHEN 'day' THEN ready_until
      WHEN 'week' THEN date_trunc('week', ready_until)::date
      ELSE date_trunc('month', ready_until)::date
    END;
    part_suffix := CASE part_unit
      WHEN 'day' THEN to_char(unit_start, 'YYYYMMDD')
      WHEN 'week' THEN to_char(unit_start, 'IYYY') || 'w' || to_char(unit_start, 'IW')
      ELSE to_char(unit_start, 'YYYYMM')
    END;
    EXIT WHEN to_regclass(format('app.%I', parent_table_name || '_p' || part_suffix)) IS NULL;
    ready_until := CASE part_unit
      WHEN 'day' THEN unit_start + 1
      WHEN 'week' THEN unit_start + 7
      ELSE (unit_start + INTERVAL '1 month')::date
    END;
    EXIT WHEN ready_until - today_date > 400;
  END LOOP;

  IF to_regclass(format('app.%I', default_part_name)) IS NOT NULL THEN
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM app.%I LIMIT 1000) AS capped', default_part_name)
      INTO default_row_count;
  END IF;

  -- The oldest kept part that still holds a row, measured from its drop time (part granularity).
  FOR part_record IN
    SELECT child.relname AS name, substr(child.relname, length(parent_table_name) + 3) AS suffix
      FROM pg_inherits AS inheritance
      JOIN pg_class AS child ON child.oid = inheritance.inhrelid
     WHERE inheritance.inhparent = parent_table_param
       AND child.relname <> default_part_name
     ORDER BY child.relname
  LOOP
    unit_start := CASE
      WHEN part_unit = 'day' AND part_record.suffix ~ '^[0-9]{8}$' THEN to_date(part_record.suffix, 'YYYYMMDD')
      WHEN part_unit = 'week' AND part_record.suffix ~ '^[0-9]{4}w[0-9]{2}$' THEN to_date(part_record.suffix, 'IYYY"w"IW')
      WHEN part_unit = 'month' AND part_record.suffix ~ '^[0-9]{6}$' THEN to_date(part_record.suffix, 'YYYYMM')
    END;
    CONTINUE WHEN unit_start IS NULL;
    unit_end := CASE part_unit
      WHEN 'day' THEN unit_start + 1
      WHEN 'week' THEN unit_start + 7
      ELSE (unit_start + INTERVAL '1 month')::date
    END;
    EXIT WHEN (unit_end::timestamp AT TIME ZONE 'UTC') + make_interval(days => keep_days_param) > now();
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM app.%I)', part_record.name) INTO part_has_rows;
    IF part_has_rows THEN
      overdue_seconds := floor(extract(epoch FROM (
        now() - ((unit_end::timestamp AT TIME ZONE 'UTC') + make_interval(days => keep_days_param))
      )))::BIGINT;
      EXIT;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'table', parent_table_name,
    'created_parts', created_count,
    'moved_rows', moved_row_count,
    'blocked_parts', to_jsonb(blocked_parts),
    'dropped_parts', dropped_count,
    'held_parts', to_jsonb(held_parts),
    'failed_drops', to_jsonb(failed_drops),
    'lock_timeouts', lock_timeout_count,
    'ready_days', ready_until - today_date,
    'default_rows', default_row_count,
    'oldest_overdue_seconds', overdue_seconds
  );
END;
$$;
