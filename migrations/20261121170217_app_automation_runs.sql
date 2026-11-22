-- Migration: app_automation_runs
-- Created: 2026-11-21T17:02:17.622Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R10 (routes-final.md § 3.B.3 — AU16–AU26; AUC10): what happens
-- when an automation runs for a contact, in the `app` schema R1 created
-- (20261121050908_app_schema.sql), next to app.automations (20261121150135_app_automations.sql).
--
--   app.automation_runs          one automation flow for one contact: its trigger, status and step,
--                                what it waits for, the automations queued behind its email
--                                question (AU21), the message it is sending (AU19) and the event
--                                that last moved it. One open run per automation × contact (AU17).
--   app.automation_run_events    append-only: one row per status change and per email or phone
--                                collected, written with the run change (AU23).
--   app.automation_comment_logs  the step results of one comment × automation — the automation
--                                that answered the comment and every other match (AU16, AU24).
--
-- New, empty tables: their keys, CHECKs and indexes are created with them, inside this file's
-- transaction — nothing to lock against, nothing to validate. Every reference is a composite key
-- (organization_id, <parent>_id) -> <parent> (organization_id, id), so a row cannot name another
-- organization's parent (B2-5): runs -> automations RESTRICT (an automation is only soft-deleted)
-- and -> contacts RESTRICT (a contact is erased in place, CT7); run events -> runs CASCADE; comment
-- logs -> automations RESTRICT, -> contacts RESTRICT (NOT NULL, AU24) and -> runs
-- ON DELETE SET NULL (automation_run_id) — run retention clears the run column only, never the
-- organization (PostgreSQL 15+, as 20261101101100_tenant_composite_foreign_keys.sql).
--
-- ended_at is a stored generated column, coalesce(completed_at, failed_at, cancelled_at): the
-- 180-day retention clock (D8). No partitioning at launch (be-sql-design-guard E.3): run events and
-- comment logs are time-pruned and well under 10M rows.
--
-- Row-level security on all three: ENABLE + FORCE, one `<table>_tenant_isolation` policy FOR ALL —
-- USING the organization arm plus the retention sweep arm bound to the maintenance role (the 7-day
-- wait scan, run and comment-log retention read across organizations), WITH CHECK the organization
-- arm only (the member-role.schema.ts pattern), so the sweep can read and delete but never update
-- across organizations.

CREATE TABLE IF NOT EXISTS app.automation_runs (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  trigger_type VARCHAR(15) NOT NULL,
  trigger_instagram_media_id VARCHAR(64),
  trigger_instagram_comment_id VARCHAR(64),
  trigger_instagram_story_id VARCHAR(64),
  trigger_text TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'running',
  current_step VARCHAR(20) NOT NULL DEFAULT 'keyword_match',
  waiting_for VARCHAR(25),
  queued_automations JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_instagram_event_key VARCHAR(512) NOT NULL,
  sending_message_kind VARCHAR(20),
  sending_started_at TIMESTAMPTZ,
  error_message TEXT,
  cancel_reason VARCHAR(20),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_step_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  waiting_since_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ GENERATED ALWAYS AS (coalesce(completed_at, failed_at, cancelled_at)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_runs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_runs_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_automation_runs_trigger_type CHECK (trigger_type IN ('comment', 'story_reply', 'dm')),
  CONSTRAINT chk_automation_runs_status CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  CONSTRAINT chk_automation_runs_current_step CHECK (current_step IN ('keyword_match', 'comment_reply', 'follow_check', 'email_collect', 'phone_collect', 'final_dm')),
  CONSTRAINT chk_automation_runs_waiting_for CHECK (waiting_for IN ('opening_message_button', 'follow', 'email', 'phone')),
  CONSTRAINT chk_automation_runs_sending_message_kind CHECK (sending_message_kind IN ('public_reply', 'opening_message', 'follow_request', 'email_question', 'invalid_email', 'phone_question', 'final_message')),
  CONSTRAINT chk_automation_runs_cancel_reason CHECK (cancel_reason IN ('automation_deleted', 'wait_expired', 'contact_deleted')),
  CONSTRAINT chk_automation_runs_waiting CHECK ((status = 'waiting') = (waiting_for IS NOT NULL AND waiting_since_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_failed CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  CONSTRAINT chk_automation_runs_cancelled CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT chk_automation_runs_sending CHECK ((sending_message_kind IS NULL) = (sending_started_at IS NULL)),
  CONSTRAINT chk_automation_runs_trigger_targets CHECK (
    (trigger_type <> 'comment' OR (trigger_instagram_media_id IS NOT NULL AND trigger_instagram_comment_id IS NOT NULL))
    AND (trigger_type <> 'story_reply' OR trigger_instagram_story_id IS NOT NULL)
  ),
  CONSTRAINT chk_automation_runs_instagram_ids CHECK (
    trigger_instagram_media_id ~ '^[0-9]{1,64}$'
    AND trigger_instagram_comment_id ~ '^[0-9]{1,64}$'
    AND trigger_instagram_story_id ~ '^[0-9]{1,64}$'
  ),
  CONSTRAINT chk_automation_runs_queued_automations CHECK (jsonb_typeof(queued_automations) = 'array' AND jsonb_array_length(queued_automations) <= 100),
  CONSTRAINT chk_automation_runs_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_public_id ON app.automation_runs USING btree (public_id);
--> statement-breakpoint
-- The parent key of the run events' and comment logs' composite references; it also serves the
-- organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_organization_id_id ON app.automation_runs USING btree (organization_id, id);
--> statement-breakpoint
-- One open run per automation × contact (AU17); also the organization's open runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_one_open ON app.automation_runs USING btree (organization_id, automation_id, contact_id) WHERE status IN ('running', 'waiting');
--> statement-breakpoint
-- The automation reference, "this automation's last run for this contact" (AU17) and the contacts
-- list's automation filter (CT5).
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_contact ON app.automation_runs USING btree (organization_id, automation_id, contact_id, started_at);
--> statement-breakpoint
-- The contact reference and the erase step (AU26).
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact ON app.automation_runs USING btree (organization_id, contact_id, started_at);
--> statement-breakpoint
-- A DM finding the run that waits for its answer (AU16).
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact_waiting ON app.automation_runs USING btree (organization_id, contact_id, waiting_for) WHERE status = 'waiting';
--> statement-breakpoint
-- The hourly 7-day scan across organizations (AU25).
CREATE INDEX IF NOT EXISTS idx_automation_runs_waiting_since ON app.automation_runs USING btree (waiting_since_at) WHERE status = 'waiting';
--> statement-breakpoint
-- Run retention (D8).
CREATE INDEX IF NOT EXISTS idx_automation_runs_ended ON app.automation_runs USING btree (ended_at) WHERE ended_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_run_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  automation_run_id BIGINT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  status VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_run_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_run_events_automation_run_fk FOREIGN KEY (organization_id, automation_run_id) REFERENCES app.automation_runs (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_automation_run_events_event_type CHECK (event_type IN ('status_changed', 'email_received', 'phone_received')),
  CONSTRAINT chk_automation_run_events_status CHECK (
    status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')
    AND (event_type = 'status_changed') = (status IS NOT NULL)
  )
);
--> statement-breakpoint
-- The run reference and a run's history, oldest first.
CREATE INDEX IF NOT EXISTS idx_automation_run_events_automation_run ON app.automation_run_events USING btree (organization_id, automation_run_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_comment_logs (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  automation_name VARCHAR(255) NOT NULL,
  automation_run_id BIGINT,
  contact_id BIGINT NOT NULL,
  instagram_media_id VARCHAR(64) NOT NULL,
  instagram_comment_id VARCHAR(64) NOT NULL,
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
  final_dm_status VARCHAR(10) NOT NULL DEFAULT 'off',
  final_dm_at TIMESTAMPTZ,
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
  CONSTRAINT automation_comment_logs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_comment_logs_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_comment_logs_automation_run_fk FOREIGN KEY (organization_id, automation_run_id) REFERENCES app.automation_runs (organization_id, id) ON DELETE SET NULL (automation_run_id),
  CONSTRAINT automation_comment_logs_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_automation_comment_logs_public_reply_status CHECK (public_reply_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_opening_dm_status CHECK (opening_dm_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_follow_status CHECK (follow_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_email_status CHECK (email_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_phone_status CHECK (phone_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_final_dm_status CHECK (final_dm_status IN ('off', 'sent', 'waiting', 'done', 'skipped', 'failed')),
  CONSTRAINT chk_automation_comment_logs_overall_status CHECK (overall_status IN ('started', 'waiting', 'completed', 'failed', 'cancelled', 'ignored')),
  CONSTRAINT chk_automation_comment_logs_current_step CHECK (current_step IN ('public_reply', 'opening_dm', 'follow_check', 'email_collect', 'phone_collect', 'final_dm')),
  CONSTRAINT chk_automation_comment_logs_failed_step CHECK (failed_step IN ('public_reply', 'opening_dm', 'follow_check', 'email_collect', 'phone_collect', 'final_dm')),
  CONSTRAINT chk_automation_comment_logs_waiting_for CHECK (waiting_for IN ('opening_message_button', 'follow', 'email', 'phone')),
  CONSTRAINT chk_automation_comment_logs_ignored_reason CHECK (ignored_reason IN ('waiting_for_other_email', 'already_waiting', 'run_in_progress', 'previous_run_final', 'comment_already_answered')),
  CONSTRAINT chk_automation_comment_logs_error_type CHECK (error_type IN ('instagram_api', 'token', 'network', 'code')),
  CONSTRAINT chk_automation_comment_logs_public_reply_skip_reason CHECK (public_reply_skip_reason IN ('duplicate', 'random', 'hour_limit', 'gap')),
  CONSTRAINT chk_automation_comment_logs_ignored CHECK ((overall_status = 'ignored') = (ignored_reason IS NOT NULL)),
  CONSTRAINT chk_automation_comment_logs_failed_has_error CHECK (overall_status <> 'failed' OR error_at IS NOT NULL),
  CONSTRAINT chk_automation_comment_logs_public_reply_skipped CHECK ((public_reply_status = 'skipped') = (public_reply_skip_reason IS NOT NULL)),
  CONSTRAINT chk_automation_comment_logs_instagram_ids CHECK (
    instagram_media_id ~ '^[0-9]{1,64}$'
    AND instagram_comment_id ~ '^[0-9]{1,64}$'
  ),
  CONSTRAINT chk_automation_comment_logs_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_comment_logs_public_id ON app.automation_comment_logs USING btree (public_id);
--> statement-breakpoint
-- One log per comment × automation (AU24), and the automation reference; it also serves the
-- organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_comment_logs_automation_comment ON app.automation_comment_logs USING btree (organization_id, automation_id, instagram_comment_id);
--> statement-breakpoint
-- The duplicate check (AU20) and a retried comment finding its logs (AU16).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_comment ON app.automation_comment_logs USING btree (organization_id, instagram_comment_id);
--> statement-breakpoint
-- The run reference (SET NULL).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_automation_run ON app.automation_comment_logs USING btree (organization_id, automation_run_id) WHERE automation_run_id IS NOT NULL;
--> statement-breakpoint
-- The contact reference and the erase step (AU26).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_contact ON app.automation_comment_logs USING btree (organization_id, contact_id);
--> statement-breakpoint
-- The hour limit and the gap of reply safety (AU20).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_public_replies ON app.automation_comment_logs USING btree (organization_id, public_reply_at) WHERE public_reply_status = 'sent';
--> statement-breakpoint
-- The automation's last reply text (AU20).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_automation_public_replies ON app.automation_comment_logs USING btree (organization_id, automation_id, public_reply_at) WHERE public_reply_status = 'sent';
--> statement-breakpoint
-- Comment-log retention across organizations (D8).
CREATE INDEX IF NOT EXISTS idx_automation_comment_logs_created ON app.automation_comment_logs USING btree (created_at);
--> statement-breakpoint
ALTER TABLE app.automation_runs OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_run_events OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automation_runs, app.automation_run_events, app.automation_comment_logs TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automation_runs_id_seq, app.automation_run_events_id_seq, app.automation_comment_logs_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_run_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_comment_logs FORCE ROW LEVEL SECURITY;
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
