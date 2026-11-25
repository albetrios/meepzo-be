-- Migration: app_instagram_messages
-- Created: 2026-11-25T09:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R19 (routes-final § 6.B.3 — SN16, SN17, SN19;
-- SNC13; P13, P33, P96): the sending engine's messages and its calls to Meta, in the `app` schema,
-- after the runs (20261121170217_app_automation_runs.sql) and the sending root
-- (20261124143012_app_instagram_sending.sql). Both are split while they are empty (P96).
--
--   app.instagram_messages       one message we send or plan to send, of a run or of a broadcast:
--                                its type, list number, kind, version and wording, lane and channel,
--                                whether it counts as a DM, its status and reason, the tries, Meta's
--                                id and error codes and the owner's one retry (D72). No text (6.B.10).
--                                Split by the ISO week (UTC, Monday) of its run's start
--                                (`automation_run_started_at`; a broadcast row puts its recipient's
--                                creation time there); parts dropped about 30 days after their week
--                                (WC-50, ROUTE R49).
--   app.instagram_send_attempts  one call to Meta for a message: lane, count group, start, result
--                                group, HTTP status, codes, duration. Split by the UTC day of
--                                `started_at`, kept 8 days (WC-49, ROUTE R49).
--
-- Keys: messages (id, automation_run_started_at), attempts (id, started_at). Nothing points INTO
-- either table (plan §19), so their parts drop freely. Messages -> runs (organization_id,
-- automation_run_id, automation_run_started_at) -> app.automation_runs (organization_id, id,
-- started_at) ON DELETE CASCADE (a broadcast row has no run: MATCH SIMPLE skips it); the broadcast key
-- is added by sub-domain 7's migration (SN17). The account, automation and contact are copies kept
-- without a reference (6.B.3), so the hottest table carries few indexes.
--
-- Week parts. `app.fn_create_weekly_partitions(parent, from_day, to_day)` creates the missing ISO
-- week parts (UTC, Monday to Monday) covering the two days, named `<table>_pIYYYwIW`, each owned by
-- `meepzo_be_owner` with no grant for the application roles — the weekly twin of
-- `app.fn_create_daily_partitions` (20261121094626) and `app.fn_create_monthly_partitions`
-- (20261121170217). A plain invoker function, EXECUTE revoked from PUBLIC. This file makes the
-- message parts from 5 weeks back to 3 ahead and the attempt parts from 8 days back to 14 ahead (S17),
-- plus one DEFAULT part per table; the shared upkeep (WC-55, ROUTE R49) keeps parts ahead and drops
-- the old ones.
--
-- Row-level security on both parents: ENABLE + FORCE, one `<table>_tenant_isolation` policy FOR ALL —
-- USING the organization arm plus the retention sweep arm bound to the maintenance role (the repair
-- duties and the upkeep read across organizations, SN6), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.instagram_messages (
  id BIGSERIAL NOT NULL,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  automation_id BIGINT,
  automation_run_id BIGINT,
  broadcast_id BIGINT,
  automation_run_started_at TIMESTAMPTZ NOT NULL,
  contact_id BIGINT NOT NULL,
  message_type VARCHAR(16) NOT NULL,
  message_number SMALLINT,
  message_kind VARCHAR(14) NOT NULL,
  version_number SMALLINT,
  wording_number SMALLINT,
  text_number SMALLINT,
  lane VARCHAR(9) NOT NULL,
  channel VARCHAR(14),
  is_counted_as_direct_message BOOLEAN NOT NULL,
  status VARCHAR(9) NOT NULL DEFAULT 'waiting',
  reason VARCHAR(30),
  not_before TIMESTAMPTZ,
  trigger_occurred_at TIMESTAMPTZ,
  tries SMALLINT NOT NULL DEFAULT 0,
  asks SMALLINT NOT NULL DEFAULT 0,
  instagram_message_id VARCHAR(128),
  sending_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_code INTEGER,
  error_subcode INTEGER,
  owner_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_messages_pkey PRIMARY KEY (id, automation_run_started_at),
  CONSTRAINT instagram_messages_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_messages_automation_run_fk FOREIGN KEY (organization_id, automation_run_id, automation_run_started_at) REFERENCES app.automation_runs (organization_id, id, started_at) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_messages_type CHECK (message_type IN ('opening_message', 'nudge', 'public_reply', 'hide_comment', 'follow_check', 'follow_request', 'email_question', 'invalid_email', 'phone_question', 'message', 'broadcast')),
  CONSTRAINT chk_instagram_messages_kind CHECK (message_kind IN ('text', 'image', 'cards', 'quick_replies', 'audio', 'file', 'post')),
  CONSTRAINT chk_instagram_messages_status CHECK (status IN ('waiting', 'sending', 'sent', 'unknown', 'failed', 'skipped', 'cancelled', 'expired')),
  CONSTRAINT chk_instagram_messages_reason CHECK (reason IN ('opted_out', 'hour_limit', 'duplicate', 'window_closed', 'deleted_comment', 'person_error', 'wrong_permission', 'once_per_post', 'broadcast_cancelled', 'recent_broadcast', 'owner_chat', 'plan_feature_off', 'contact_excluded', 'automation_deleted', 'contact_deleted', 'restore', 'cancelled_by_owner', 'answered', 'replaced', 'wait_expired', 'expired', 'reply_too_old', 'live_ended', 'plan_limit', 'bad_text', 'tries_used_up', 'attachment_failed', 'no_answer', 'worker_lost', 'assumed_following', 'following', 'not_following')),
  -- Waiting and sending rows carry no reason; every ended-without-sending status carries one.
  CONSTRAINT chk_instagram_messages_status_reason CHECK (
    (status NOT IN ('waiting', 'sending') OR reason IS NULL)
    AND (status NOT IN ('failed', 'skipped', 'cancelled', 'expired') OR reason IS NOT NULL)
  ),
  -- plan §19.1 check 1: the allowed lane and channel pairs.
  CONSTRAINT chk_instagram_messages_lane_channel CHECK (
    (lane = 'slow' AND channel = 'private_reply')
    OR (lane = 'reply' AND channel IN ('comment_reply', 'comment_hide'))
    OR (lane = 'fast' AND (channel IS NULL OR channel IN ('direct', 'private_reply')))
    OR (lane = 'broadcast' AND channel = 'direct')
  ),
  -- plan §19.1 checks 1–2: a public reply, a hide, a follow check and a broadcast each in their place.
  CONSTRAINT chk_instagram_messages_type_lane CHECK (
    (message_type = 'public_reply') = (channel IS NOT DISTINCT FROM 'comment_reply')
    AND (message_type = 'hide_comment') = (channel IS NOT DISTINCT FROM 'comment_hide')
    AND (message_type = 'follow_check') = (channel IS NULL)
    AND (message_type = 'broadcast') = (lane = 'broadcast')
  ),
  -- plan §19.1 check 8 (SN16): exactly one source; a broadcast row has no automation.
  CONSTRAINT chk_instagram_messages_source CHECK (
    num_nonnulls(automation_run_id, broadcast_id) = 1
    AND (message_type = 'broadcast') = (broadcast_id IS NOT NULL)
    AND (automation_id IS NULL) = (broadcast_id IS NOT NULL)
  ),
  -- plan §19.1 check 4: the list number exactly on list and broadcast messages.
  CONSTRAINT chk_instagram_messages_numbers CHECK (
    (message_number IS NOT NULL) = (message_type IN ('message', 'broadcast'))
    AND message_number BETWEEN 1 AND (CASE WHEN message_type = 'broadcast' THEN 3 ELSE 10 END)
    AND version_number BETWEEN 1 AND 3
    AND wording_number BETWEEN 1 AND 10
    AND text_number BETWEEN 1 AND 10
  ),
  -- plan §19.1 check 5: every message into her chat counts in the month (D34).
  CONSTRAINT chk_instagram_messages_counted CHECK (
    is_counted_as_direct_message = (message_type IN ('opening_message', 'nudge', 'follow_request', 'email_question', 'invalid_email', 'phone_question', 'message', 'broadcast'))
  ),
  -- plan §19.1 check 6: `sending_at` exactly while sending, `sent_at` exactly when sent.
  CONSTRAINT chk_instagram_messages_sending CHECK ((status = 'sending') = (sending_at IS NOT NULL)),
  CONSTRAINT chk_instagram_messages_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT chk_instagram_messages_counters CHECK (tries >= 0 AND asks >= 0),
  CONSTRAINT chk_instagram_messages_error CHECK (error_subcode IS NULL OR error_code IS NOT NULL),
  CONSTRAINT chk_instagram_messages_updated CHECK (updated_at >= created_at)
) PARTITION BY RANGE (automation_run_started_at);
--> statement-breakpoint
-- A split table's unique index carries the split key; tickets and button payloads carry both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_messages_public_id ON app.instagram_messages USING btree (public_id, automation_run_started_at);
--> statement-breakpoint
-- One row per run, type and list place (plan §19.1 `uq_instagram_messages_run_type`): asking again,
-- or her next action after an `unknown`, uses the same row. All messages of a run share its part;
-- NULLS NOT DISTINCT makes the empty list number of the other types count as equal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_messages_run_type ON app.instagram_messages USING btree (organization_id, automation_run_id, message_type, message_number, message_kind, automation_run_started_at) NULLS NOT DISTINCT WHERE automation_run_id IS NOT NULL;
--> statement-breakpoint
-- The run reference, its messages (cancel by run, the next list message) and the organization cascade.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_automation_run ON app.instagram_messages USING btree (organization_id, automation_run_id, automation_run_started_at);
--> statement-breakpoint
-- The lanes' pick, oldest first per lane.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_pick ON app.instagram_messages USING btree (channel_account_id, lane, not_before) WHERE status = 'waiting';
--> statement-breakpoint
-- An automation's waiting messages (route 31's cancel, a live edit, the pause's cancel — WC-19).
CREATE INDEX IF NOT EXISTS idx_instagram_messages_automation_waiting ON app.instagram_messages USING btree (organization_id, automation_id) WHERE status = 'waiting';
--> statement-breakpoint
-- A broadcast's messages (sub-domain 7).
CREATE INDEX IF NOT EXISTS idx_instagram_messages_broadcast ON app.instagram_messages USING btree (broadcast_id, status) WHERE broadcast_id IS NOT NULL;
--> statement-breakpoint
-- The own-message lookup of the webhook receiver (WHQ1, P62) and a tap's proof.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_instagram_message_id ON app.instagram_messages USING btree (channel_account_id, instagram_message_id) WHERE instagram_message_id IS NOT NULL;
--> statement-breakpoint
-- The person limit: her sent messages of the last hour.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_person_sent ON app.instagram_messages USING btree (contact_id, sent_at) WHERE status = 'sent';
--> statement-breakpoint
-- An automation's failed messages of the last 30 days (route 36–37's summary and retry, SN18).
CREATE INDEX IF NOT EXISTS idx_instagram_messages_automation_failed ON app.instagram_messages USING btree (organization_id, automation_id, created_at) WHERE status = 'failed';
--> statement-breakpoint
-- Her messages, newest first (route 24's "what happened"), her failed ones (routes 25–26) and the
-- contact pause / erase cancel.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_contact ON app.instagram_messages USING btree (organization_id, contact_id, created_at);
--> statement-breakpoint
-- The expiry of opening DMs, replies and hides (WC-15).
CREATE INDEX IF NOT EXISTS idx_instagram_messages_expiry ON app.instagram_messages USING btree (trigger_occurred_at) WHERE status = 'waiting' AND lane IN ('slow', 'reply');
--> statement-breakpoint
-- The stuck-send repair: leases over (WC-14).
CREATE INDEX IF NOT EXISTS idx_instagram_messages_sending ON app.instagram_messages USING btree (channel_account_id, sending_at) WHERE status = 'sending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_send_attempts (
  id BIGSERIAL NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  instagram_message_id BIGINT NOT NULL,
  automation_id BIGINT,
  contact_id BIGINT NOT NULL,
  lane VARCHAR(9) NOT NULL,
  count_group VARCHAR(9) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_group VARCHAR(20),
  http_status SMALLINT,
  error_code INTEGER,
  error_subcode INTEGER,
  duration_milliseconds INTEGER,
  CONSTRAINT instagram_send_attempts_pkey PRIMARY KEY (id, started_at),
  CONSTRAINT instagram_send_attempts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_send_attempts_lane CHECK (lane IN ('slow', 'reply', 'fast', 'broadcast')),
  CONSTRAINT chk_instagram_send_attempts_count_group CHECK (count_group IN ('open', 'reply', 'fast', 'broadcast', 'none')),
  CONSTRAINT chk_instagram_send_attempts_result_group CHECK (result_group ~ '^[a-z_]{1,20}$'),
  CONSTRAINT chk_instagram_send_attempts_http_status CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT chk_instagram_send_attempts_duration CHECK (duration_milliseconds >= 0),
  CONSTRAINT chk_instagram_send_attempts_finished CHECK (duration_milliseconds IS NULL OR result_group IS NOT NULL),
  CONSTRAINT chk_instagram_send_attempts_error CHECK (error_subcode IS NULL OR error_code IS NOT NULL)
) PARTITION BY RANGE (started_at);
--> statement-breakpoint
-- "In a row" on one account and the outage check (SN5, WC-22).
CREATE INDEX IF NOT EXISTS idx_instagram_send_attempts_account ON app.instagram_send_attempts USING btree (channel_account_id, started_at DESC);
--> statement-breakpoint
-- "5 refused texts in a row" on one automation, and the organization cascade.
CREATE INDEX IF NOT EXISTS idx_instagram_send_attempts_automation ON app.instagram_send_attempts USING btree (organization_id, automation_id, started_at DESC);
--> statement-breakpoint
-- The all-accounts 30 % rule (WC-22).
CREATE INDEX IF NOT EXISTS idx_instagram_send_attempts_started ON app.instagram_send_attempts USING btree (started_at) INCLUDE (result_group);
--> statement-breakpoint
ALTER TABLE app.instagram_messages OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_send_attempts OWNER TO meepzo_be_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.fn_create_weekly_partitions (
  parent_table_param REGCLASS,
  from_day_param DATE,
  to_day_param DATE
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
  partition_week DATE;
  last_week DATE;
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
    RAISE EXCEPTION 'fn_create_weekly_partitions: % is not a range-partitioned app table', parent_table_param;
  END IF;
  IF partition_key_type <> 'timestamp with time zone'::regtype THEN
    RAISE EXCEPTION 'fn_create_weekly_partitions: % is not split by a timestamptz column', parent_table_param;
  END IF;
  -- ISO weeks start on Monday.
  partition_week := date_trunc('week', from_day_param)::date;
  last_week := date_trunc('week', to_day_param)::date;
  IF last_week < partition_week OR last_week - partition_week > 7 * 104 THEN
    RAISE EXCEPTION 'fn_create_weekly_partitions: day range % to % refused', from_day_param, to_day_param;
  END IF;

  WHILE partition_week <= last_week LOOP
    partition_name := parent_table_name || '_p' || to_char(partition_week, 'IYYY') || 'w' || to_char(partition_week, 'IW');
    IF to_regclass(format('%I.%I', parent_schema_name, partition_name)) IS NULL THEN
      -- UTC weeks: an explicit offset, never the session's TimeZone.
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        parent_schema_name, partition_name, parent_schema_name, parent_table_name,
        to_char(partition_week, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char(partition_week + 7, 'YYYY-MM-DD') || ' 00:00:00+00'
      );
      -- A part is reached only through its parent (whose policy applies): no direct grant.
      EXECUTE format(
        'REVOKE ALL ON TABLE %I.%I FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance',
        parent_schema_name, partition_name
      );
      EXECUTE format('ALTER TABLE %I.%I OWNER TO meepzo_be_owner', parent_schema_name, partition_name);
      created_count := created_count + 1;
    END IF;
    partition_week := partition_week + 7;
  END LOOP;
  RETURN created_count;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.fn_create_weekly_partitions (REGCLASS, DATE, DATE) FROM PUBLIC;
--> statement-breakpoint
-- The first parts: 5 weeks back (the keep time, a run that started then may still send) to 3 ahead.
SELECT app.fn_create_weekly_partitions('app.instagram_messages'::regclass, (now() AT TIME ZONE 'UTC')::date - 35, (now() AT TIME ZONE 'UTC')::date + 21);
--> statement-breakpoint
-- 8 days back (the keep time) to 14 ahead (S17).
SELECT app.fn_create_daily_partitions('app.instagram_send_attempts'::regclass, (now() AT TIME ZONE 'UTC')::date - 8, (now() AT TIME ZONE 'UTC')::date + 14);
--> statement-breakpoint
-- The DEFAULT parts: a row whose week or day has no part lands here instead of failing the write;
-- the upkeep (R49) alerts while one holds rows. A run older than the first week part (a 7-day wait
-- started before it) writes its messages here.
CREATE TABLE IF NOT EXISTS app.instagram_messages_default PARTITION OF app.instagram_messages DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_send_attempts_default PARTITION OF app.instagram_send_attempts DEFAULT;
--> statement-breakpoint
REVOKE ALL ON TABLE app.instagram_messages_default, app.instagram_send_attempts_default FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_messages_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_send_attempts_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_messages, app.instagram_send_attempts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_messages_id_seq, app.instagram_send_attempts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_messages_tenant_isolation ON app.instagram_messages;
--> statement-breakpoint
CREATE POLICY instagram_messages_tenant_isolation ON app.instagram_messages
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
ALTER TABLE app.instagram_send_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_send_attempts_tenant_isolation ON app.instagram_send_attempts;
--> statement-breakpoint
CREATE POLICY instagram_send_attempts_tenant_isolation ON app.instagram_send_attempts
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
