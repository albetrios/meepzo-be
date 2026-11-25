-- Migration: app_automation_runs
-- Created: 2026-11-21T17:02:17.622Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R10 (routes-final.md § 3.B.3), changed in place by
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R14 (routes-final.md § 4.B.3 — AU21–AU28, AU36,
-- AU37; AUC9, AUC14, AUC15; P29, P35, P96, P100): what happens when an automation runs for a person,
-- shared by every channel, in the `app` schema next to app.automations
-- (20261121150135_app_automations.sql). The run tables are split by month while they are empty (P96).
--
--   app.automation_runs           one person going through one automation: how it started (the 15
--                                 ways) and its once key, the 7-day clock, its status, step and wait,
--                                 the versions it picked, its first DM and last list message, the
--                                 event that last moved it. Split by the UTC month of `started_at`.
--   app.automation_run_events     append-only: one row per status change, email or phone received and
--                                 hello or follow tap. Split by the month of its run's start (a copy,
--                                 `automation_run_started_at`), dropped with its run's part.
--   app.automation_comment_logs   one comment an automation saw, with each step's status. Split by the
--                                 month of `created_at`; its run is a copy with no reference.
--   app.automation_run_open_keys  one row per open run (P100): the rule "one open run per automation
--                                 and person", which a unique index on a split table cannot hold.
--                                 Plain. Written in the run's start commit, deleted in its end commit.
--
-- Keys: every reference is composite (organization_id, <parent>_id) -> <parent> (organization_id, id)
-- (B2-5) — runs -> automations RESTRICT, -> contacts RESTRICT; run events -> runs (organization_id,
-- id, started_at) CASCADE; comment logs -> automations RESTRICT, -> contacts RESTRICT; open keys ->
-- automations CASCADE, -> contacts RESTRICT, -> runs (organization_id, id, started_at) CASCADE. A split
-- table's keys carry its split key: runs (id, started_at), run events (id, automation_run_started_at),
-- comment logs (id, created_at).
--
-- Month parts. `app.fn_create_monthly_partitions(parent, from_month, to_month)` creates the missing
-- UTC-month parts of an `app` table split by a timestamptz column, named `<table>_pYYYYMM`, each
-- owned by `meepzo_be_owner` with no grant for the application roles (app code reads and writes
-- through the parent, whose policy applies) — the monthly twin of `app.fn_create_daily_partitions`
-- (20261121094626). A plain invoker function, EXECUTE revoked from PUBLIC. This file makes the parts
-- from 3 months back to 3 ahead and one DEFAULT part per table; the shared upkeep (WC-55, ROUTE R49)
-- keeps parts ahead and drops a runs part (with its run-events part) once its month ended over 98
-- days ago, a comment-log part 90 days after its month (AU36) — no batch delete remains.
--
-- Row-level security on all four: ENABLE + FORCE, one `<table>_tenant_isolation` policy FOR ALL —
-- USING the organization arm plus the retention sweep arm bound to the maintenance role (the 7-day
-- wait scan, the open-key repair), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.automation_runs (
  id BIGSERIAL NOT NULL,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  trigger_type VARCHAR(20) NOT NULL,
  trigger_instagram_media_id VARCHAR(64),
  trigger_instagram_comment_id VARCHAR(64),
  trigger_instagram_story_id VARCHAR(64),
  trigger_occurred_at TIMESTAMPTZ NOT NULL,
  once_key VARCHAR(255) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'running',
  current_step VARCHAR(20) NOT NULL DEFAULT 'keyword_match',
  waiting_for VARCHAR(25),
  last_instagram_event_key VARCHAR(512) NOT NULL,
  direct_message_sent_at TIMESTAMPTZ,
  last_message_number SMALLINT,
  version_numbers JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  cancel_reason VARCHAR(20),
  started_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', NOW()),
  last_step_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  waiting_since_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ GENERATED ALWAYS AS (coalesce(completed_at, failed_at, cancelled_at)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_runs_pkey PRIMARY KEY (id, started_at),
  CONSTRAINT automation_runs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_automation_runs_trigger_type CHECK (trigger_type IN ('comment', 'live_comment', 'story_reply', 'story_mention', 'story_repost', 'dm_keyword', 'first_message', 'shared_post', 'starter_question', 'ref_link', 'default_reply', 'ad_comment', 'ad_message', 'tag_added', 'tag_removed')),
  CONSTRAINT chk_automation_runs_status CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  CONSTRAINT chk_automation_runs_current_step CHECK (current_step IN ('keyword_match', 'comment_reply', 'follow_check', 'email_collect', 'phone_collect', 'messages')),
  CONSTRAINT chk_automation_runs_waiting_for CHECK (waiting_for IN ('opening_message_button', 'follow', 'email', 'phone', 'any')),
  CONSTRAINT chk_automation_runs_cancel_reason CHECK (cancel_reason IN ('automation_deleted', 'wait_expired', 'contact_deleted', 'contact_excluded', 'opted_out', 'expired', 'window_closed', 'replaced')),
  CONSTRAINT chk_automation_runs_waiting CHECK ((status = 'waiting') = (waiting_for IS NOT NULL AND waiting_since_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_failed CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_cancelled CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT chk_automation_runs_trigger_targets CHECK (
    (trigger_type NOT IN ('comment', 'live_comment', 'ad_comment') OR (trigger_instagram_media_id IS NOT NULL AND trigger_instagram_comment_id IS NOT NULL))
    AND (trigger_type NOT IN ('story_reply', 'story_mention') OR trigger_instagram_story_id IS NOT NULL)
  ),
  CONSTRAINT chk_automation_runs_instagram_ids CHECK (
    trigger_instagram_media_id ~ '^[0-9]{1,64}$'
    AND trigger_instagram_comment_id ~ '^[0-9]{1,64}$'
    AND trigger_instagram_story_id ~ '^[0-9]{1,64}$'
  ),
  CONSTRAINT chk_automation_runs_once_key CHECK (length(once_key) BETWEEN 1 AND 255),
  CONSTRAINT chk_automation_runs_last_message_number CHECK (last_message_number BETWEEN 1 AND 10),
  CONSTRAINT chk_automation_runs_version_numbers CHECK (jsonb_typeof(version_numbers) = 'object'),
  -- The run key's start is copied into the run events, open keys, comment logs and messages: whole
  -- milliseconds, so the application's copy (a JavaScript Date) is the same value.
  CONSTRAINT chk_automation_runs_started_at_milliseconds CHECK (started_at = date_trunc('milliseconds', started_at)),
  CONSTRAINT chk_automation_runs_updated CHECK (updated_at >= created_at)
) PARTITION BY RANGE (started_at);
--> statement-breakpoint
-- A button payload names a run by its public id; a split table's unique index carries the split key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_public_id ON app.automation_runs USING btree (public_id, started_at);
--> statement-breakpoint
-- The parent key of the run events' and the open keys' composite references; it also serves the
-- organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_organization_id_id ON app.automation_runs USING btree (organization_id, id, started_at);
--> statement-breakpoint
-- Her open run of an automation — a look-up in each part since the split; the rule is
-- app.automation_run_open_keys (AU37).
CREATE INDEX IF NOT EXISTS idx_automation_runs_one_open ON app.automation_runs USING btree (organization_id, automation_id, contact_id) WHERE status IN ('running', 'waiting');
--> statement-breakpoint
-- The automation reference and the contacts list's automation filter (CT5).
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_contact ON app.automation_runs USING btree (organization_id, automation_id, contact_id, started_at);
--> statement-breakpoint
-- The contact reference, the erase and a retried event's runs.
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact ON app.automation_runs USING btree (organization_id, contact_id, started_at);
--> statement-breakpoint
-- A message or tap finding the run that waits for it.
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact_waiting ON app.automation_runs USING btree (organization_id, contact_id, waiting_for) WHERE status = 'waiting';
--> statement-breakpoint
-- The hourly 7-day scan across organizations (WC-45).
CREATE INDEX IF NOT EXISTS idx_automation_runs_waiting_since ON app.automation_runs USING btree (waiting_since_at) WHERE status = 'waiting';
--> statement-breakpoint
-- The once rule (AU22, D13): a DM already went for this automation, person and once key — read across
-- the kept parts.
CREATE INDEX IF NOT EXISTS idx_automation_runs_once ON app.automation_runs USING btree (organization_id, automation_id, contact_id, once_key) WHERE direct_message_sent_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_run_events (
  id BIGSERIAL NOT NULL,
  organization_id BIGINT NOT NULL,
  automation_run_id BIGINT NOT NULL,
  automation_run_started_at TIMESTAMPTZ NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  status VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_run_events_pkey PRIMARY KEY (id, automation_run_started_at),
  CONSTRAINT automation_run_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_run_events_automation_run_fk FOREIGN KEY (organization_id, automation_run_id, automation_run_started_at) REFERENCES app.automation_runs (organization_id, id, started_at) ON DELETE CASCADE,
  CONSTRAINT chk_automation_run_events_event_type CHECK (event_type IN ('status_changed', 'email_received', 'phone_received', 'hello_tapped', 'follow_tapped')),
  CONSTRAINT chk_automation_run_events_status CHECK (
    status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')
    AND (event_type = 'status_changed') = (status IS NOT NULL)
  )
) PARTITION BY RANGE (automation_run_started_at);
--> statement-breakpoint
-- The run reference and a run's history, oldest first.
CREATE INDEX IF NOT EXISTS idx_automation_run_events_automation_run ON app.automation_run_events USING btree (organization_id, automation_run_id, automation_run_started_at, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_comment_logs (
  id BIGSERIAL NOT NULL,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  automation_name VARCHAR(255) NOT NULL,
  automation_run_id BIGINT,
  automation_run_started_at TIMESTAMPTZ,
  contact_id BIGINT NOT NULL,
  instagram_media_id VARCHAR(64) NOT NULL,
  instagram_comment_id VARCHAR(64) NOT NULL,
  comment_occurred_at TIMESTAMPTZ,
  comment_text TEXT,
  commenter_username VARCHAR(64),
  commenter_instagram_user_id VARCHAR(64),
  public_reply_status VARCHAR(10) NOT NULL DEFAULT 'off',
  public_reply_text TEXT,
  public_reply_skip_reason VARCHAR(20),
  public_reply_at TIMESTAMPTZ,
  opening_dm_status VARCHAR(10) NOT NULL DEFAULT 'off',
  opening_dm_at TIMESTAMPTZ,
  button_clicked_at TIMESTAMPTZ,
  follow_status VARCHAR(10) NOT NULL DEFAULT 'off',
  follow_at TIMESTAMPTZ,
  follow_confirmed_at TIMESTAMPTZ,
  email_status VARCHAR(10) NOT NULL DEFAULT 'off',
  email_at TIMESTAMPTZ,
  email_received VARCHAR(255),
  phone_status VARCHAR(10) NOT NULL DEFAULT 'off',
  phone_at TIMESTAMPTZ,
  phone_received VARCHAR(50),
  messages_status VARCHAR(10) NOT NULL DEFAULT 'off',
  messages_at TIMESTAMPTZ,
  hide_status VARCHAR(10) NOT NULL DEFAULT 'off',
  hidden_at TIMESTAMPTZ,
  overall_status VARCHAR(10) NOT NULL DEFAULT 'started',
  current_step VARCHAR(15),
  failed_step VARCHAR(15),
  waiting_for VARCHAR(25),
  ignored_reason VARCHAR(30),
  error_type VARCHAR(15),
  http_status INTEGER,
  error_code INTEGER,
  error_subcode INTEGER,
  error_message TEXT,
  error_reason TEXT,
  error_stack TEXT,
  fbtrace_id VARCHAR(100),
  error_response JSONB,
  error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_comment_logs_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT automation_comment_logs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_comment_logs_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_comment_logs_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_automation_comment_logs_public_reply_status CHECK (public_reply_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_opening_dm_status CHECK (opening_dm_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_follow_status CHECK (follow_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_email_status CHECK (email_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_phone_status CHECK (phone_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_messages_status CHECK (messages_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_hide_status CHECK (hide_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed', 'expired', 'unknown')),
  CONSTRAINT chk_automation_comment_logs_overall_status CHECK (overall_status IN ('started', 'waiting', 'completed', 'failed', 'cancelled', 'ignored')),
  CONSTRAINT chk_automation_comment_logs_current_step CHECK (current_step IN ('public_reply', 'opening_dm', 'follow_check', 'email_collect', 'phone_collect', 'messages', 'hide_comment')),
  CONSTRAINT chk_automation_comment_logs_failed_step CHECK (failed_step IN ('public_reply', 'opening_dm', 'follow_check', 'email_collect', 'phone_collect', 'messages', 'hide_comment')),
  CONSTRAINT chk_automation_comment_logs_waiting_for CHECK (waiting_for IN ('opening_message_button', 'follow', 'email', 'phone', 'any')),
  CONSTRAINT chk_automation_comment_logs_ignored_reason CHECK (ignored_reason IN ('waiting_for_other_email', 'already_waiting', 'run_in_progress', 'once_per_post', 'comment_already_answered', 'thread_reply_off', 'own_comment', 'contact_excluded')),
  CONSTRAINT chk_automation_comment_logs_error_type CHECK (error_type IN ('instagram_api', 'token', 'network', 'code')),
  CONSTRAINT chk_automation_comment_logs_public_reply_skip_reason CHECK (public_reply_skip_reason IN ('duplicate', 'random', 'hour_limit', 'deleted_comment')),
  CONSTRAINT chk_automation_comment_logs_ignored CHECK ((overall_status = 'ignored') = (ignored_reason IS NOT NULL)),
  CONSTRAINT chk_automation_comment_logs_failed_has_error CHECK (overall_status <> 'failed' OR error_at IS NOT NULL),
  CONSTRAINT chk_automation_comment_logs_public_reply_skipped CHECK ((public_reply_status = 'skipped') = (public_reply_skip_reason IS NOT NULL)),
  CONSTRAINT chk_automation_comment_logs_instagram_ids CHECK (
    instagram_media_id ~ '^[0-9]{1,64}$'
    AND instagram_comment_id ~ '^[0-9]{1,64}$'
  ),
  CONSTRAINT chk_automation_comment_logs_run_copy CHECK ((automation_run_id IS NULL) = (automation_run_started_at IS NULL)),
  CONSTRAINT chk_automation_comment_logs_updated CHECK (updated_at >= created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_comment_logs_public_id ON app.automation_comment_logs USING btree (public_id, created_at);
--> statement-breakpoint
-- The automation reference and one log per comment and automation — plain since the split (AU28):
-- the engine checks it in the last two month parts under the contact lock.
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_automation_comment ON app.automation_comment_logs USING btree (organization_id, automation_id, instagram_comment_id);
--> statement-breakpoint
-- The duplicate public reply and a retried comment finding its logs.
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_comment ON app.automation_comment_logs USING btree (organization_id, instagram_comment_id);
--> statement-breakpoint
-- A run's log (a copy, no reference).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_automation_run ON app.automation_comment_logs USING btree (organization_id, automation_run_id) WHERE automation_run_id IS NOT NULL;
--> statement-breakpoint
-- The contact reference and the erase step.
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_contact ON app.automation_comment_logs USING btree (organization_id, contact_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_run_open_keys (
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  automation_run_id BIGINT NOT NULL,
  automation_run_started_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_run_open_keys_pkey PRIMARY KEY (organization_id, automation_id, contact_id),
  CONSTRAINT automation_run_open_keys_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_run_open_keys_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_run_open_keys_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_run_open_keys_automation_run_fk FOREIGN KEY (organization_id, automation_run_id, automation_run_started_at) REFERENCES app.automation_runs (organization_id, id, started_at) ON DELETE CASCADE
);
--> statement-breakpoint
-- The run reference and the end-of-run delete.
CREATE INDEX IF NOT EXISTS idx_automation_run_open_keys_automation_run ON app.automation_run_open_keys USING btree (organization_id, automation_run_id, automation_run_started_at);
--> statement-breakpoint
-- The contact reference and her open runs (the lock order, the erase, the pause).
CREATE INDEX IF NOT EXISTS idx_automation_run_open_keys_contact ON app.automation_run_open_keys USING btree (organization_id, contact_id);
--> statement-breakpoint
ALTER TABLE app.automation_runs OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_run_events OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_run_open_keys OWNER TO meepzo_be_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.fn_create_monthly_partitions (
  parent_table_param REGCLASS,
  from_month_param DATE,
  to_month_param DATE
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_schema_name TEXT;
  parent_table_name TEXT;
  partition_key_type REGTYPE;
  partition_month DATE;
  last_month DATE;
  partition_name TEXT;
  created_count INTEGER := 0;
BEGIN
  SELECT namespace.nspname, class.relname, attribute.atttypid::regtype
    INTO parent_schema_name, parent_table_name, partition_key_type
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    JOIN pg_partitioned_table AS partitioned ON partitioned.partrelid = class.oid
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = class.oid AND attribute.attnum = partitioned.partattrs[0]
   WHERE class.oid = parent_table_param
     AND class.relkind = 'p'
     AND partitioned.partstrat = 'r'
     AND partitioned.partnatts = 1;
  IF parent_table_name IS NULL OR parent_schema_name <> 'app' THEN
    RAISE EXCEPTION 'fn_create_monthly_partitions: % is not a range-partitioned app table', parent_table_param;
  END IF;
  IF partition_key_type <> 'timestamp with time zone'::regtype THEN
    RAISE EXCEPTION 'fn_create_monthly_partitions: % is not split by a timestamptz column', parent_table_param;
  END IF;
  partition_month := date_trunc('month', from_month_param)::date;
  last_month := date_trunc('month', to_month_param)::date;
  IF last_month < partition_month OR last_month > (partition_month + INTERVAL '36 months')::date THEN
    RAISE EXCEPTION 'fn_create_monthly_partitions: month range % to % refused', from_month_param, to_month_param;
  END IF;

  WHILE partition_month <= last_month LOOP
    partition_name := parent_table_name || '_p' || to_char(partition_month, 'YYYYMM');
    IF to_regclass(format('%I.%I', parent_schema_name, partition_name)) IS NULL THEN
      -- UTC months: an explicit offset, never the session's TimeZone.
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        parent_schema_name, partition_name, parent_schema_name, parent_table_name,
        to_char(partition_month, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char((partition_month + INTERVAL '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00'
      );
      -- A part is reached only through its parent (whose policy applies): no direct grant.
      EXECUTE format(
        'REVOKE ALL ON TABLE %I.%I FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance',
        parent_schema_name, partition_name
      );
      EXECUTE format('ALTER TABLE %I.%I OWNER TO meepzo_be_owner', parent_schema_name, partition_name);
      created_count := created_count + 1;
    END IF;
    partition_month := (partition_month + INTERVAL '1 month')::date;
  END LOOP;
  RETURN created_count;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.fn_create_monthly_partitions (REGCLASS, DATE, DATE) FROM PUBLIC;
--> statement-breakpoint
-- The first parts: 3 months back (a run waiting since then still has its part) to 3 ahead.
SELECT app.fn_create_monthly_partitions('app.automation_runs'::regclass, ((now() AT TIME ZONE 'UTC')::date - INTERVAL '3 months')::date, ((now() AT TIME ZONE 'UTC')::date + INTERVAL '3 months')::date);
--> statement-breakpoint
SELECT app.fn_create_monthly_partitions('app.automation_run_events'::regclass, ((now() AT TIME ZONE 'UTC')::date - INTERVAL '3 months')::date, ((now() AT TIME ZONE 'UTC')::date + INTERVAL '3 months')::date);
--> statement-breakpoint
SELECT app.fn_create_monthly_partitions('app.automation_comment_logs'::regclass, ((now() AT TIME ZONE 'UTC')::date - INTERVAL '3 months')::date, ((now() AT TIME ZONE 'UTC')::date + INTERVAL '3 months')::date);
--> statement-breakpoint
-- The DEFAULT parts: a row whose month has no part lands here instead of failing the write; the
-- upkeep (R49) alerts while one holds rows.
CREATE TABLE IF NOT EXISTS app.automation_runs_default PARTITION OF app.automation_runs DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_run_events_default PARTITION OF app.automation_run_events DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_comment_logs_default PARTITION OF app.automation_comment_logs DEFAULT;
--> statement-breakpoint
REVOKE ALL ON TABLE app.automation_runs_default, app.automation_run_events_default, app.automation_comment_logs_default FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_runs_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_run_events_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automation_runs, app.automation_run_events, app.automation_comment_logs TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON app.automation_run_open_keys TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automation_runs_id_seq, app.automation_run_events_id_seq, app.automation_comment_logs_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_runs_tenant_isolation ON app.automation_runs;
--> statement-breakpoint
CREATE POLICY automation_runs_tenant_isolation ON app.automation_runs
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
ALTER TABLE app.automation_run_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_run_events_tenant_isolation ON app.automation_run_events;
--> statement-breakpoint
CREATE POLICY automation_run_events_tenant_isolation ON app.automation_run_events
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
ALTER TABLE app.automation_comment_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_comment_logs_tenant_isolation ON app.automation_comment_logs;
--> statement-breakpoint
CREATE POLICY automation_comment_logs_tenant_isolation ON app.automation_comment_logs
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
ALTER TABLE app.automation_run_open_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_run_open_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_run_open_keys_tenant_isolation ON app.automation_run_open_keys;
--> statement-breakpoint
CREATE POLICY automation_run_open_keys_tenant_isolation ON app.automation_run_open_keys
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
