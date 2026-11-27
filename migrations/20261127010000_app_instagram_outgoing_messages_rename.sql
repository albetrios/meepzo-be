-- Migration: app_instagram_outgoing_messages_rename
-- Created: 2026-11-27T01:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow rename_column_or_table reason="feat-instagram-inbox R1 (AM1, I-D21): a table rename cannot be expand-only; it runs in one transaction and the release that ships it is the first to read the new name (the previous release stops before the migration)"
-- migration-safety: allow drop_table reason="the DROP TABLE is inside fn_manage_time_partitions' body, copied unchanged from 20261125190000_app_partition_upkeep.sql (the upkeep's part drop past the keep days); this migration drops nothing"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R1 (routes-final § 1, AM1; name I-D21): the paced sender's
-- ledger `app.instagram_messages` becomes `app.instagram_outgoing_messages` — it holds every DM the sender
-- sends (automation and broadcast), so the new conversation messages can sit beside it without a clash.
--
-- One transaction, renames only — no row is rewritten: the parent, its weekly parts and the DEFAULT part,
-- the id sequence, every constraint and index whose name carries the old table name (on the parent, its
-- parts and the tables that point at it), the RLS policy, and the partition upkeep's CASE entry. The
-- previous release stops before this migration (the runner's deploy order), so nothing reads the old name
-- after it. Columns, `igm_` ids and RLS behaviour are unchanged.

ALTER TABLE app.instagram_messages RENAME TO instagram_outgoing_messages;
--> statement-breakpoint

-- The parts (`instagram_messages_p<IYYY>w<IW>`, `instagram_messages_default`) follow the parent's name,
-- which the upkeep derives part names from.
DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT child.relname
      FROM pg_inherits AS inheritance
      JOIN pg_class AS child ON child.oid = inheritance.inhrelid
      JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace AS namespace ON namespace.oid = parent.relnamespace
     WHERE namespace.nspname = 'app'
       AND parent.relname = 'instagram_outgoing_messages'
       AND child.relname LIKE 'instagram\_messages\_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE app.%I RENAME TO %I',
      part.relname,
      replace(part.relname, 'instagram_messages', 'instagram_outgoing_messages')
    );
  END LOOP;
END $$;
--> statement-breakpoint

ALTER SEQUENCE IF EXISTS app.instagram_messages_id_seq RENAME TO instagram_outgoing_messages_id_seq;
--> statement-breakpoint

-- Constraints first (a primary key or unique constraint renames its index with it), on the parent, the
-- parts and the tables pointing at it; a part's inherited CHECK follows its parent's rename.
DO $$
DECLARE
  item RECORD;
  new_name TEXT;
BEGIN
  FOR item IN
    SELECT constraint_row.conname, owner.relname AS table_name
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS owner ON owner.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = owner.relnamespace
     WHERE namespace.nspname = 'app'
       AND constraint_row.conname LIKE '%instagram\_messages%'
       AND constraint_row.conparentid = 0
     ORDER BY owner.relname, constraint_row.conname
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint AS still
        JOIN pg_class AS still_owner ON still_owner.oid = still.conrelid
       WHERE still.conname = item.conname AND still_owner.relname = item.table_name
    ) THEN
      new_name := replace(item.conname, 'instagram_messages', 'instagram_outgoing_messages');
      IF octet_length(new_name) > 63 THEN
        new_name := left(new_name, 54) || '_' || left(md5(new_name), 8);
      END IF;
      EXECUTE format(
        'ALTER TABLE app.%I RENAME CONSTRAINT %I TO %I',
        item.table_name,
        item.conname,
        new_name
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Every index still carrying the old name (plain indexes of the parent and its parts).
DO $$
DECLARE
  item RECORD;
  new_name TEXT;
BEGIN
  FOR item IN
    SELECT index_class.relname
      FROM pg_class AS index_class
      JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
     WHERE namespace.nspname = 'app'
       AND index_class.relkind IN ('i', 'I')
       AND index_class.relname LIKE '%instagram\_messages%'
  LOOP
    new_name := replace(item.relname, 'instagram_messages', 'instagram_outgoing_messages');
    -- A name Postgres made for a part's index may pass 63 bytes once longer; two would then truncate
    -- to one name, so a long one keeps 54 bytes and an 8-character hash of the full name.
    IF octet_length(new_name) > 63 THEN
      new_name := left(new_name, 54) || '_' || left(md5(new_name), 8);
    END IF;
    EXECUTE format('ALTER INDEX app.%I RENAME TO %I', item.relname, new_name);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER POLICY instagram_messages_tenant_isolation ON app.instagram_outgoing_messages
  RENAME TO instagram_outgoing_messages_tenant_isolation;
--> statement-breakpoint

-- The partition upkeep: its CASE names the weekly table (`20261125190000_app_partition_upkeep.sql:95`).
-- The body below is that file's, with the one entry renamed; CREATE OR REPLACE keeps its owner and grants.
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
