-- Migration: app_instagram_sending
-- Created: 2026-11-24T14:30:12.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R18 (routes-final § 6.A.3 — SN12, SN13, SNC10;
-- § 6.3; scale review S8, S13, S29, P97): the sending engine's root tables, in the `app` schema R1
-- created (20261121050908_app_schema.sql), after the channel account (20261121064529).
--
--   app.instagram_send_lanes         four rows per Instagram channel account (slow, reply, fast,
--                                    broadcast): the turn, lease, box, limits and the lane's error
--                                    stop — the pause, suspend and plan stop are the channel
--                                    account's (P99). The slow row also keeps the stored waiting
--                                    estimate (S29).
--   app.instagram_send_stops         the history of every stop, 90 days (WC-53).
--   app.instagram_send_minute_counts messages sent per account, count group and minute: gate 2.
--   app.message_month_counts         messages sent per organization and month of its time zone, in 16
--                                    slots (D34) — shared by every channel (P43).
--   app.instagram_send_day_counts    one account's results of one day of its organization's time
--                                    zone — route 63's "today" line (S8).
--   app.sending_states               one row for the whole system: the environment id, the settings
--                                    versions (P95), the all-accounts stop and Meta's app-level usage
--                                    (S13) — no organization (P16).
--
-- New, empty tables: the keys, CHECKs and indexes are created with them, inside this file's
-- transaction. The account's children reference it through the composite key
-- (organization_id, channel_account_id) -> app.channel_accounts (organization_id, id) ON DELETE
-- CASCADE, so a row cannot name another organization's account (B2-5). The hot counter tables (the
-- lanes, minute, month and day counts) take fillfactor = 80 for HOT updates (plan §37.2).
--
-- Row-level security: ENABLE + FORCE on all six. The five tenant tables carry one
-- `<table>_tenant_isolation` policy FOR ALL — USING the organization arm plus the retention sweep arm
-- bound to the maintenance role (the repair duties and clean-ups read across organizations, SN6),
-- WITH CHECK the organization arm only. app.sending_states is the documented exemption (P16): one
-- policy whose USING and WITH CHECK are the app.sending_state_access arm bound to the maintenance
-- role, and no grant to meepzo_be_app — the maintenance login under MAINTENANCE_SCOPE.SENDING_STATE
-- is the only reader and writer (the audit.outbox pattern).

CREATE TABLE IF NOT EXISTS app.instagram_send_lanes (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  lane VARCHAR(9) NOT NULL,
  state VARCHAR(8) NOT NULL DEFAULT 'ready',
  next_run_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  box_start TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  half_speed_until TIMESTAMPTZ,
  wait_reason VARCHAR(12),
  turn_number BIGINT NOT NULL DEFAULT 0,
  working_turn BIGINT,
  pick_count SMALLINT NOT NULL DEFAULT 0,
  day_date DATE,
  day_count INTEGER,
  stop_reason VARCHAR(24),
  stop_until TIMESTAMPTZ,
  stop_count SMALLINT NOT NULL DEFAULT 0,
  stop_error_code INTEGER,
  stop_error_subcode INTEGER,
  stop_cleared_at TIMESTAMPTZ,
  testing_lane VARCHAR(9),
  testing_until TIMESTAMPTZ,
  sending_count SMALLINT NOT NULL DEFAULT 0,
  estimate_waiting_count INTEGER,
  estimate_will_go_count INTEGER,
  estimate_may_expire_count INTEGER,
  estimate_done_at TIMESTAMPTZ,
  estimated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_send_lanes_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_send_lanes_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_send_lanes_lane CHECK (lane IN ('slow', 'reply', 'fast', 'broadcast')),
  CONSTRAINT chk_instagram_send_lanes_state CHECK (state IN ('ready', 'working', 'sleeping', 'stopped') AND (lane <> 'fast' OR state IN ('ready', 'stopped'))),
  CONSTRAINT chk_instagram_send_lanes_working CHECK ((state = 'working') = (lease_until IS NOT NULL) AND (state = 'working') = (working_turn IS NOT NULL)),
  CONSTRAINT chk_instagram_send_lanes_wait_reason CHECK (wait_reason IS NULL OR wait_reason IN ('box', 'gap', 'hour_limit', 'day_limit', 'not_before', 'stop', 'test')),
  CONSTRAINT chk_instagram_send_lanes_turn CHECK (turn_number >= 0 AND (working_turn IS NULL OR working_turn BETWEEN 0 AND turn_number)),
  CONSTRAINT chk_instagram_send_lanes_pick_count CHECK (pick_count BETWEEN 0 AND 5 AND (lane = 'slow' OR pick_count = 0)),
  CONSTRAINT chk_instagram_send_lanes_day CHECK ((day_date IS NULL) = (day_count IS NULL) AND (day_count IS NULL OR (lane = 'slow' AND day_count >= 0))),
  CONSTRAINT chk_instagram_send_lanes_stop CHECK ((stop_reason IS NULL OR stop_reason IN ('too_fast', 'instagram_down', 'access_off', 'app_not_approved', 'account_flagged', 'blocked', 'wrong_permission', 'account_not_shared', 'login_expired')) AND (stop_reason IS NOT NULL OR (stop_until IS NULL AND stop_error_code IS NULL AND stop_error_subcode IS NULL)) AND stop_count >= 0),
  CONSTRAINT chk_instagram_send_lanes_testing CHECK ((testing_lane IS NULL) = (testing_until IS NULL) AND (testing_lane IS NULL OR (lane = 'slow' AND testing_lane IN ('slow', 'reply', 'fast', 'broadcast')))),
  CONSTRAINT chk_instagram_send_lanes_sending_count CHECK (sending_count BETWEEN 0 AND 20 AND (lane = 'fast' OR sending_count = 0)),
  CONSTRAINT chk_instagram_send_lanes_estimate CHECK ((estimated_at IS NULL OR lane = 'slow') AND (estimated_at IS NOT NULL OR (estimate_waiting_count IS NULL AND estimate_will_go_count IS NULL AND estimate_may_expire_count IS NULL AND estimate_done_at IS NULL)) AND (estimate_waiting_count IS NULL OR estimate_waiting_count >= 0) AND (estimate_will_go_count IS NULL OR estimate_will_go_count >= 0) AND (estimate_may_expire_count IS NULL OR estimate_may_expire_count >= 0)),
  CONSTRAINT chk_instagram_send_lanes_updated CHECK (updated_at >= created_at)
) WITH (fillfactor = 80);
--> statement-breakpoint
-- Four rows per account, and the composite key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_send_lanes_account_lane ON app.instagram_send_lanes USING btree (organization_id, channel_account_id, lane);
--> statement-breakpoint
-- The repair's cross-organization reads (SN6): lanes due a turn, and leases running out.
CREATE INDEX IF NOT EXISTS idx_instagram_send_lanes_next_run ON app.instagram_send_lanes USING btree (next_run_at) WHERE state IN ('ready', 'sleeping');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_send_lanes_lease ON app.instagram_send_lanes USING btree (lease_until) WHERE state = 'working';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_send_stops (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  lane VARCHAR(9) NOT NULL,
  reason VARCHAR(24) NOT NULL,
  error_code INTEGER,
  error_subcode INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stop_until TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_by VARCHAR(5),
  CONSTRAINT instagram_send_stops_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_send_stops_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_send_stops_lane CHECK (lane IN ('slow', 'reply', 'fast', 'broadcast', 'all')),
  CONSTRAINT chk_instagram_send_stops_reason CHECK (reason IN ('too_fast', 'instagram_down', 'access_off', 'app_not_approved', 'account_flagged', 'blocked', 'wrong_permission', 'account_not_shared', 'login_expired', 'plan_limit', 'plan_ended', 'plan_downgrade')),
  CONSTRAINT chk_instagram_send_stops_ended CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_by IS NULL OR ended_by IN ('time', 'test', 'owner', 'team')) AND (ended_at IS NULL OR ended_at >= started_at))
);
--> statement-breakpoint
-- An account's history, newest first — and the composite key's index.
CREATE INDEX IF NOT EXISTS idx_instagram_send_stops_account_started ON app.instagram_send_stops USING btree (organization_id, channel_account_id, started_at DESC);
--> statement-breakpoint
-- The 90-day delete (WC-53).
CREATE INDEX IF NOT EXISTS idx_instagram_send_stops_started ON app.instagram_send_stops USING btree (started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_send_minute_counts (
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  count_group VARCHAR(9) NOT NULL,
  minute_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT instagram_send_minute_counts_pkey PRIMARY KEY (organization_id, channel_account_id, count_group, minute_start),
  CONSTRAINT instagram_send_minute_counts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_send_minute_counts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_send_minute_counts_count_group CHECK (count_group IN ('open', 'reply', 'fast', 'broadcast')),
  CONSTRAINT chk_instagram_send_minute_counts_count CHECK (count >= 0)
) WITH (fillfactor = 80);
--> statement-breakpoint
-- The 2-hour delete (WC-20).
CREATE INDEX IF NOT EXISTS idx_instagram_send_minute_counts_minute ON app.instagram_send_minute_counts USING btree (minute_start);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.message_month_counts (
  organization_id BIGINT NOT NULL,
  month_start DATE NOT NULL,
  slot SMALLINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_month_counts_pkey PRIMARY KEY (organization_id, month_start, slot),
  CONSTRAINT message_month_counts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT chk_message_month_counts_slot CHECK (slot BETWEEN 0 AND 15),
  CONSTRAINT chk_message_month_counts_count CHECK (count >= 0),
  CONSTRAINT chk_message_month_counts_month_start CHECK (extract(day FROM month_start) = 1)
) WITH (fillfactor = 80);
--> statement-breakpoint
-- The 13-month delete (WC-54).
CREATE INDEX IF NOT EXISTS idx_message_month_counts_month ON app.message_month_counts USING btree (month_start);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_send_day_counts (
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  day_date DATE NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  skipped_window_closed_count INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_send_day_counts_pkey PRIMARY KEY (organization_id, channel_account_id, day_date),
  CONSTRAINT instagram_send_day_counts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_send_day_counts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_send_day_counts_counts CHECK (sent_count >= 0 AND unknown_count >= 0 AND skipped_count >= 0 AND skipped_window_closed_count BETWEEN 0 AND skipped_count AND expired_count >= 0)
) WITH (fillfactor = 80);
--> statement-breakpoint
-- The clean-up's delete by age.
CREATE INDEX IF NOT EXISTS idx_instagram_send_day_counts_day ON app.instagram_send_day_counts USING btree (day_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.sending_states (
  id SMALLINT PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  settings_version VARCHAR(32) NOT NULL,
  settings_version_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  minimum_compatible_settings_version VARCHAR(32) NOT NULL,
  all_stop_until TIMESTAMPTZ,
  all_stop_reason VARCHAR(14),
  all_stop_count SMALLINT NOT NULL DEFAULT 0,
  testing_lane VARCHAR(9),
  testing_until TIMESTAMPTZ,
  app_usage_percent SMALLINT,
  app_usage_read_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sending_states_single_row CHECK (id = 1),
  CONSTRAINT chk_sending_states_environment_id CHECK (length(environment_id) > 0),
  CONSTRAINT chk_sending_states_settings_versions CHECK (settings_version ~ '^[0-9]{1,32}$' AND minimum_compatible_settings_version ~ '^[0-9]{1,32}$'),
  CONSTRAINT chk_sending_states_all_stop CHECK ((all_stop_reason IS NULL OR all_stop_reason IN ('app_limit', 'instagram_down')) AND (all_stop_reason IS NOT NULL OR all_stop_until IS NULL) AND all_stop_count >= 0),
  CONSTRAINT chk_sending_states_testing CHECK ((testing_lane IS NULL) = (testing_until IS NULL) AND (testing_lane IS NULL OR testing_lane IN ('slow', 'reply', 'fast', 'broadcast'))),
  CONSTRAINT chk_sending_states_app_usage CHECK ((app_usage_percent IS NULL) = (app_usage_read_at IS NULL) AND (app_usage_percent IS NULL OR app_usage_percent BETWEEN 0 AND 100))
);
--> statement-breakpoint
ALTER TABLE app.instagram_send_lanes OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_send_stops OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_send_minute_counts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.message_month_counts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_send_day_counts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.sending_states OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_send_lanes, app.instagram_send_stops, app.instagram_send_minute_counts, app.message_month_counts, app.instagram_send_day_counts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_send_lanes_id_seq, app.instagram_send_stops_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
-- P16: the maintenance login only — the schema's default privileges gave both runtime roles every
-- write, so take them back: nothing for meepzo_be_app, and no DELETE (the row is never removed).
REVOKE ALL ON app.sending_states FROM meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.sending_states TO meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_send_lanes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_lanes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_minute_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_minute_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.message_month_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.message_month_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_day_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_send_day_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.sending_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.sending_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_send_lanes_tenant_isolation ON app.instagram_send_lanes;
--> statement-breakpoint
CREATE POLICY instagram_send_lanes_tenant_isolation ON app.instagram_send_lanes
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
DROP POLICY IF EXISTS instagram_send_stops_tenant_isolation ON app.instagram_send_stops;
--> statement-breakpoint
CREATE POLICY instagram_send_stops_tenant_isolation ON app.instagram_send_stops
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
DROP POLICY IF EXISTS instagram_send_minute_counts_tenant_isolation ON app.instagram_send_minute_counts;
--> statement-breakpoint
CREATE POLICY instagram_send_minute_counts_tenant_isolation ON app.instagram_send_minute_counts
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
DROP POLICY IF EXISTS message_month_counts_tenant_isolation ON app.message_month_counts;
--> statement-breakpoint
CREATE POLICY message_month_counts_tenant_isolation ON app.message_month_counts
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
DROP POLICY IF EXISTS instagram_send_day_counts_tenant_isolation ON app.instagram_send_day_counts;
--> statement-breakpoint
CREATE POLICY instagram_send_day_counts_tenant_isolation ON app.instagram_send_day_counts
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
-- P16: the one tenantless row — the app.sending_state_access arm, bound to the maintenance role, in
-- USING and WITH CHECK alike.
DROP POLICY IF EXISTS sending_states_maintenance_access ON app.sending_states;
--> statement-breakpoint
CREATE POLICY sending_states_maintenance_access ON app.sending_states
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    (SELECT current_setting('app.sending_state_access', true)) = 'true'
    AND (SELECT current_user) = 'meepzo_be_maintenance'
  )
  WITH CHECK (
    (SELECT current_setting('app.sending_state_access', true)) = 'true'
    AND (SELECT current_user) = 'meepzo_be_maintenance'
  );
