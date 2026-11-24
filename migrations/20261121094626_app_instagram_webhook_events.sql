-- Migration: app_instagram_webhook_events
-- Created: 2026-11-21T09:46:26.341Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R12 (routes-final.md § 4.3, 4.B.3 — WH16, WH19, WHC12), changed in
-- place by feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R16 (routes-final.md § 5.3, 5.B.3 —
-- WH18–WH22, WHC11, WHC12; P29, P33, P96, P97 S17): every event of a Meta webhook delivery and every
-- event key seen, each split by day while the tables are empty (P96).
--
--   app.instagram_webhook_events      one row per event (a `changes[]` or `messaging[]` item, or a
--                                     missed / past comment), born `received` (or already
--                                     `skipped`, without a body) by the store function, then
--                                     `queued` → `processed` · `skipped` · `failed` by intake. Split
--                                     by the UTC day of `created_at` (the received time), kept 8
--                                     days (WH19). The body is cleared when the event is done
--                                     (WH22). `intake_group` is generated from the kind (WH11).
--                                     Primary key `(id, created_at)` — a partitioned table's keys
--                                     carry the partition key. No soft delete, no `*_by_user_id`.
--   app.instagram_webhook_event_keys  one row per organization, account, event key and Meta event
--                                     day (WH20): the repeat guard a partitioned events table can no
--                                     longer hold itself. Inserted `ON CONFLICT DO NOTHING` before
--                                     the events; split by `event_day`, the UTC day of Meta's own
--                                     time, so a redelivery lands on the same day. Never changed.
--
-- Both point at the account through the composite key (organization_id, channel_account_id) ->
-- app.channel_accounts (organization_id, id) ON DELETE CASCADE (R5 moved the account row there).
--
-- Day parts. `app.fn_create_daily_partitions(parent, from_day, to_day)` creates the missing UTC-day
-- parts of an `app` range-split table, each owned by `meepzo_be_owner` and born with no grant for the
-- application roles: app code reads and writes only through the parent, whose policy applies. It is
-- a plain (invoker) function, EXECUTE revoked from PUBLIC, so only an owner member (the migration
-- login) runs it today; the shared upkeep (worker-changes WC-55, ROUTE R49 — the drops, the "parts ≥
-- 14 days ahead" run at worker start, the alert on the DEFAULT part, the maintenance scope, P33)
-- builds on it. This file makes the parts from 8 days back to 14 days ahead (S17) and one DEFAULT
-- part per table, which catches a row whose day has no part (the upkeep fell behind) instead of
-- failing the store.
--
-- Index names are shortened from the review's (5.B.3) to fit Postgres's 63-byte identifier limit.
--
-- Row-level security on both parents: ENABLE + FORCE, one `<table>_tenant_isolation` policy FOR ALL
-- — USING the organization arm plus the retention sweep arm bound to the maintenance role (the
-- stuck-event pick-up's cross-organization read, the upkeep's oldest-part check), WITH CHECK the
-- organization arm only (the `member-role.schema.ts` pattern).

CREATE TABLE IF NOT EXISTS app.instagram_webhook_events (
  id BIGSERIAL NOT NULL,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  instagram_user_id VARCHAR(64) NOT NULL,
  contact_instagram_user_id VARCHAR(64),
  event_kind VARCHAR(20) NOT NULL,
  intake_group VARCHAR(8) GENERATED ALWAYS AS (
    CASE event_kind WHEN 'comment' THEN 'comments' WHEN 'live_comment' THEN 'live' ELSE 'messages' END
  ) STORED,
  event_key VARCHAR(512) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'received',
  skip_reason VARCHAR(30),
  error_message VARCHAR(2000),
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  payload JSONB,
  occurred_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_webhook_events_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT instagram_webhook_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_webhook_events_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_webhook_events_kind CHECK (event_kind IN ('comment', 'live_comment', 'message', 'story_reply', 'story_mention', 'shared_post', 'postback', 'ice_breaker', 'referral', 'reaction', 'echo', 'edit', 'unknown')),
  CONSTRAINT chk_instagram_webhook_events_status CHECK (status IN ('received', 'queued', 'processed', 'skipped', 'failed')),
  CONSTRAINT chk_instagram_webhook_events_skip_reason CHECK (skip_reason IS NULL OR skip_reason IN ('automation_disabled', 'account_disconnected', 'own_comment', 'edit', 'unsupported', 'flood')),
  CONSTRAINT chk_instagram_webhook_events_skipped CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT chk_instagram_webhook_events_failed CHECK ((status = 'failed') = (error_message IS NOT NULL)),
  CONSTRAINT chk_instagram_webhook_events_final CHECK ((status IN ('received', 'queued')) = (processed_at IS NULL)),
  CONSTRAINT chk_instagram_webhook_events_payload CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_instagram_webhook_events_body CHECK ((status IN ('received', 'queued', 'failed')) = (payload IS NOT NULL)),
  CONSTRAINT chk_instagram_webhook_events_next_attempt CHECK (next_attempt_at IS NULL OR status = 'failed'),
  CONSTRAINT chk_instagram_webhook_events_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT chk_instagram_webhook_events_instagram_ids CHECK (instagram_user_id ~ '^[0-9]{1,64}$' AND (contact_instagram_user_id IS NULL OR contact_instagram_user_id ~ '^[0-9]{1,64}$')),
  CONSTRAINT chk_instagram_webhook_events_updated CHECK (updated_at >= created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
-- `generatePublicId` makes a clash negligible; a partitioned table's unique index carries the
-- partition key (no route reads an event by its id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_webhook_events_public_id ON app.instagram_webhook_events USING btree (public_id, created_at);
--> statement-breakpoint
-- Route 62, every account: newest first. Leads with organization_id, so it also serves the
-- organization cascade.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_id_created_at_id ON app.instagram_webhook_events USING btree (organization_id, created_at DESC, id DESC);
--> statement-breakpoint
-- Route 62, one account (WH23). Leads with the composite key's columns, so it also serves the
-- account cascade.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_account_created_at ON app.instagram_webhook_events USING btree (organization_id, channel_account_id, created_at DESC, id DESC);
--> statement-breakpoint
-- Route 62 filtered by status, as a keyset.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_status_created_at_id ON app.instagram_webhook_events USING btree (organization_id, status, created_at DESC, id DESC);
--> statement-breakpoint
-- The claim and the stuck-event pick-up, per intake group (WH11, WH12, WH17): only waiting rows.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_pending ON app.instagram_webhook_events USING btree (channel_account_id, intake_group, created_at, id) WHERE status IN ('received', 'queued');
--> statement-breakpoint
-- The hourly retry of a failed event (WH21).
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_next_attempt_at ON app.instagram_webhook_events USING btree (next_attempt_at) WHERE status = 'failed' AND next_attempt_at IS NOT NULL;
--> statement-breakpoint
-- The inbound flood count (WH16, WHQ2): her message events of the last minute.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_flood ON app.instagram_webhook_events USING btree (channel_account_id, contact_instagram_user_id, created_at) WHERE intake_group = 'messages';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_webhook_event_keys (
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  event_key VARCHAR(512) NOT NULL,
  event_day DATE NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_webhook_event_keys_pkey PRIMARY KEY (organization_id, channel_account_id, event_key, event_day),
  CONSTRAINT instagram_webhook_event_keys_organization_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_webhook_event_keys_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_webhook_event_keys_event_key CHECK (length(event_key) > 0)
) PARTITION BY RANGE (event_day);
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_events OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_event_keys OWNER TO meepzo_be_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.fn_create_daily_partitions (
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
  partition_day DATE;
  partition_name TEXT;
  lower_bound TEXT;
  upper_bound TEXT;
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
    RAISE EXCEPTION 'fn_create_daily_partitions: % is not a range-partitioned app table', parent_table_param;
  END IF;
  IF partition_key_type NOT IN ('date'::regtype, 'timestamp with time zone'::regtype) THEN
    RAISE EXCEPTION 'fn_create_daily_partitions: % is not split by a date or timestamptz column', parent_table_param;
  END IF;
  IF to_day_param < from_day_param OR to_day_param - from_day_param > 400 THEN
    RAISE EXCEPTION 'fn_create_daily_partitions: day range % to % refused', from_day_param, to_day_param;
  END IF;

  partition_day := from_day_param;
  WHILE partition_day <= to_day_param LOOP
    partition_name := parent_table_name || '_p' || to_char(partition_day, 'YYYYMMDD');
    IF to_regclass(format('%I.%I', parent_schema_name, partition_name)) IS NULL THEN
      IF partition_key_type = 'date'::regtype THEN
        lower_bound := to_char(partition_day, 'YYYY-MM-DD');
        upper_bound := to_char(partition_day + 1, 'YYYY-MM-DD');
      ELSE
        -- UTC days: an explicit offset, never the session's TimeZone.
        lower_bound := to_char(partition_day, 'YYYY-MM-DD') || ' 00:00:00+00';
        upper_bound := to_char(partition_day + 1, 'YYYY-MM-DD') || ' 00:00:00+00';
      END IF;
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        parent_schema_name, partition_name, parent_schema_name, parent_table_name,
        lower_bound, upper_bound
      );
      -- A part is reached only through its parent (whose policy applies): no direct grant.
      EXECUTE format(
        'REVOKE ALL ON TABLE %I.%I FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance',
        parent_schema_name, partition_name
      );
      EXECUTE format('ALTER TABLE %I.%I OWNER TO meepzo_be_owner', parent_schema_name, partition_name);
      created_count := created_count + 1;
    END IF;
    partition_day := partition_day + 1;
  END LOOP;
  RETURN created_count;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.fn_create_daily_partitions (REGCLASS, DATE, DATE) FROM PUBLIC;
--> statement-breakpoint
-- The first parts (S17): 8 days back (the keep time — a replayed day still has its part) to 14 ahead.
SELECT app.fn_create_daily_partitions('app.instagram_webhook_events'::regclass, (now() AT TIME ZONE 'UTC')::date - 8, (now() AT TIME ZONE 'UTC')::date + 14);
--> statement-breakpoint
SELECT app.fn_create_daily_partitions('app.instagram_webhook_event_keys'::regclass, (now() AT TIME ZONE 'UTC')::date - 8, (now() AT TIME ZONE 'UTC')::date + 14);
--> statement-breakpoint
-- The DEFAULT parts (S17): a row whose day has no part lands here instead of failing the store; the
-- upkeep (R49) alerts while one holds rows.
CREATE TABLE IF NOT EXISTS app.instagram_webhook_events_default PARTITION OF app.instagram_webhook_events DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_webhook_event_keys_default PARTITION OF app.instagram_webhook_event_keys DEFAULT;
--> statement-breakpoint
REVOKE ALL ON TABLE app.instagram_webhook_events_default, app.instagram_webhook_event_keys_default FROM PUBLIC, meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_events_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_event_keys_default OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_webhook_events TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.instagram_webhook_event_keys TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_webhook_events_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_webhook_events_tenant_isolation ON app.instagram_webhook_events;
--> statement-breakpoint
CREATE POLICY instagram_webhook_events_tenant_isolation ON app.instagram_webhook_events
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
ALTER TABLE app.instagram_webhook_event_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_event_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_webhook_event_keys_tenant_isolation ON app.instagram_webhook_event_keys;
--> statement-breakpoint
CREATE POLICY instagram_webhook_event_keys_tenant_isolation ON app.instagram_webhook_event_keys
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
