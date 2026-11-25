-- Migration: app_partition_upkeep
-- Created: 2026-11-25T19:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow drop_table reason="no table is dropped by this migration: the function body detaches and drops expired time-split parts at run time (WC-55), and drops its own temp table"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R49 (routes-final § 5.B WHC13, WHC15, § 4.B AUC14,
-- § 6.B SNC13; worker-changes WC-48–WC-52, WC-55; P33, P92, P96, P97 S17, P410): the shared upkeep of
-- the seven time-split `app` tables. One function, run by the upkeep worker
-- (`src/domains/app/workers/app-partition-upkeep.*`) under `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP`,
-- per table:
--
--   1. makes the missing parts from today to `make_ahead_days` ahead (S17: ≥ 14) through the part
--      makers R16, R19 and R14 left (`app.fn_create_daily_partitions`, `_weekly_`, `_monthly_`),
--      one part at a time;
--   2. when a part cannot be made because the DEFAULT part already holds rows of its range (the
--      upkeep fell behind), moves those rows into the new part in the same step — for a table that
--      nothing points into; a table something points into (`app.automation_runs`) is left for the
--      team (the report names the range, and the DEFAULT part's rows alert);
--   3. when asked (`drop_parts`), drops every part whose range ended more than `keep_days` ago —
--      DETACH then DROP, under a 2 s lock timeout with up to 3 tries, a failure left for the next hour
--      — except a runs or run-events part whose runs part still holds an open run (`running`,
--      `waiting`), which is kept and reported (AU36 (5)). Parts are visited oldest first, and the
--      worker runs the tables in the order messages → comment logs → run events → runs, so the
--      messages' and run events' rows that point into a runs part are gone before it;
--   4. reports, for the alerts and the gauges (P92, S17): the days ahead that are ready, the DEFAULT
--      part's rows (capped at 1,000), and how long the oldest kept part is past its drop time.
--
-- Why SECURITY DEFINER (P410, the open point R16's P303 left): making and dropping a part needs the
-- parent's owner, and the maintenance login is no owner member (role taxonomy). So the function runs
-- as its owner — the per-environment migration role, never `meepzo_be_owner` (role-taxonomy) — and is
-- executable by `meepzo_be_maintenance` ONLY: unlike the resolvers, `meepzo_be_app` must never drop a
-- part, so role-taxonomy.db.unit.test.ts lists it as the one maintenance-only definer. Its body is the
-- boundary: only the seven tables, fixed floors on both day counts, and it returns counts and part
-- names — never a row. The part reads go to the parts directly (a part carries no policy; the
-- parent's RLS is not involved), so they hold under any owner posture.

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
    WHEN 'instagram_messages' THEN 'week'
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
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.fn_manage_time_partitions (REGCLASS, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.fn_manage_time_partitions (REGCLASS, INTEGER, INTEGER, BOOLEAN) FROM meepzo_be_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.fn_manage_time_partitions (REGCLASS, INTEGER, INTEGER, BOOLEAN) TO meepzo_be_maintenance;
--> statement-breakpoint
-- The three part makers are plain invoker functions: making a part needs the parent's owner anyway.
-- EXECUTE for the owner group makes "owner members only" (R16, R19, R14) hold whoever owns the
-- function (the local superuser or the hosted migrator), so the operator's test fixtures make their
-- parts through the same functions (P410).
GRANT EXECUTE ON FUNCTION app.fn_create_daily_partitions (REGCLASS, DATE, DATE), app.fn_create_weekly_partitions (REGCLASS, DATE, DATE), app.fn_create_monthly_partitions (REGCLASS, DATE, DATE) TO meepzo_be_owner;
