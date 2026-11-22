-- Migration: app_instagram_webhook_events
-- Created: 2026-11-21T09:46:26.341Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R12 (routes-final.md § 4.3, 4.B.3 — WH16, WH19, WHC12): every
-- event of a Meta webhook delivery, stored once per Instagram account and event key, with what
-- happened to it. Route 18 lists one organization's rows; a daily clean-up deletes every row
-- received more than 30 days ago (D8).
--
--   app.instagram_webhook_events   one row per event (a `changes[]` or `messaging[]` item), born
--                                  `received` (or already `skipped`) by the receiver (4.A), then
--                                  `queued` → `processed` · `skipped` · `failed` by processing.
--                                  `organization_id` is required — events of an Instagram account
--                                  no team holds are never stored (WH4, WQ1). No soft delete (a
--                                  30-day log) and no `*_by_user_id` (WH6). `created_at` is the
--                                  received time (the API's `received_at`).
--
-- A new, empty table: its keys, CHECKs and indexes are created with it, inside this file's
-- transaction. The account is referenced through the composite key (organization_id,
-- instagram_account_id) -> app.instagram_accounts (organization_id, id), so an event cannot name
-- another organization's account (B2-5, as 20261121064529_app_instagram_account.sql's children).
--
-- Two index names are shortened from the review's (4.B.3) to fit Postgres's 63-byte identifier
-- limit — the long forms would be truncated silently and no longer match the Drizzle schema:
-- `..._organization_account_event_key` and `..._organization_status_created_at_id`.
--
-- Row-level security: ENABLE + FORCE, one `instagram_webhook_events_tenant_isolation` policy FOR
-- ALL — USING the organization arm plus the retention sweep arm bound to the maintenance role (the
-- stuck-event pick-up and the 30-day clean-up read across organizations, WH3, WH19), WITH CHECK the
-- organization arm only (the `member-role.schema.ts` pattern).

CREATE TABLE IF NOT EXISTS app.instagram_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_account_id BIGINT NOT NULL,
  instagram_user_id VARCHAR(64) NOT NULL,
  contact_instagram_user_id VARCHAR(64),
  event_kind VARCHAR(20) NOT NULL,
  event_key VARCHAR(512) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'received',
  skip_reason VARCHAR(30),
  error_message VARCHAR(2000),
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_webhook_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_webhook_events_instagram_account_fk FOREIGN KEY (organization_id, instagram_account_id) REFERENCES app.instagram_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_webhook_events_kind CHECK (event_kind IN ('comment', 'message', 'postback', 'story_reply', 'echo', 'read', 'reaction', 'edit', 'unknown')),
  CONSTRAINT chk_instagram_webhook_events_status CHECK (status IN ('received', 'queued', 'processed', 'skipped', 'failed')),
  CONSTRAINT chk_instagram_webhook_events_skip_reason CHECK (skip_reason IS NULL OR skip_reason IN ('automation_disabled', 'account_disconnected', 'echo', 'read_receipt', 'reaction', 'edit', 'unsupported')),
  CONSTRAINT chk_instagram_webhook_events_skipped CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT chk_instagram_webhook_events_failed CHECK ((status = 'failed') = (error_message IS NOT NULL)),
  CONSTRAINT chk_instagram_webhook_events_final CHECK ((status IN ('received', 'queued')) = (processed_at IS NULL)),
  CONSTRAINT chk_instagram_webhook_events_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_instagram_webhook_events_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT chk_instagram_webhook_events_instagram_ids CHECK (instagram_user_id ~ '^[0-9]{1,64}$' AND (contact_instagram_user_id IS NULL OR contact_instagram_user_id ~ '^[0-9]{1,64}$')),
  CONSTRAINT chk_instagram_webhook_events_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_webhook_events_public_id ON app.instagram_webhook_events USING btree (public_id);
--> statement-breakpoint
-- The repeat-delivery guard (`ON CONFLICT DO NOTHING`, WH9, WH10): one row per account and event
-- key. It leads with the composite key's columns, so it also serves the account and organization
-- cascades.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_account_event_key ON app.instagram_webhook_events USING btree (organization_id, instagram_account_id, event_key);
--> statement-breakpoint
-- Route 18: newest first.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_id_created_at_id ON app.instagram_webhook_events USING btree (organization_id, created_at DESC, id DESC);
--> statement-breakpoint
-- Route 18 filtered by status, as a keyset.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_organization_status_created_at_id ON app.instagram_webhook_events USING btree (organization_id, status, created_at DESC, id DESC);
--> statement-breakpoint
-- The claim and the stuck-event pick-up (WH12, WH15): only waiting rows, oldest first per account.
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_pending ON app.instagram_webhook_events USING btree (instagram_account_id, created_at, id) WHERE status IN ('received', 'queued');
--> statement-breakpoint
-- The 30-day clean-up (WH19).
CREATE INDEX IF NOT EXISTS idx_instagram_webhook_events_created_at ON app.instagram_webhook_events USING btree (created_at);
--> statement-breakpoint
ALTER TABLE app.instagram_webhook_events OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_webhook_events TO meepzo_be_app, meepzo_be_maintenance;
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
