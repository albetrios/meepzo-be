-- Migration: app_instagram_conversations
-- Created: 2026-11-27T02:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R2 (routes-final § 2.A.3, CV1–CV4): one conversation per
-- contact — its state, who holds it (a member or the Instagram app), the unread count, the newest message
-- and the response times the team inbox lists. Created lazily by the first message of a contact (CV2);
-- the routes land at R7. New table only: nothing existing changes.

CREATE TABLE IF NOT EXISTS app.instagram_conversations (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'open',
  taken_by VARCHAR(20),
  taken_by_membership_id BIGINT,
  taken_at TIMESTAMPTZ,
  last_team_message_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ NOT NULL,
  last_message_sender_type VARCHAR(20) NOT NULL,
  last_message_preview VARCHAR(200),
  first_response_at TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ,
  meta_conversation_id VARCHAR(1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instagram_conversations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversations_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversations_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT instagram_conversations_taken_by_membership_fk FOREIGN KEY (organization_id, taken_by_membership_id) REFERENCES tenancy.memberships (organization_id, id),
  CONSTRAINT chk_instagram_conversations_state CHECK (state IN ('open', 'waiting_on_us', 'waiting_on_contact', 'closed')),
  CONSTRAINT chk_instagram_conversations_taken_by CHECK (taken_by IS NULL OR taken_by IN ('team_member', 'instagram_app')),
  CONSTRAINT chk_instagram_conversations_taken CHECK (
    (taken_by IS NOT NULL OR (taken_by_membership_id IS NULL AND taken_at IS NULL))
    AND (taken_by IS DISTINCT FROM 'instagram_app' OR taken_by_membership_id IS NULL)
  ),
  CONSTRAINT chk_instagram_conversations_sender_type CHECK (last_message_sender_type IN ('contact', 'automation', 'broadcast', 'team_member', 'instagram_app')),
  CONSTRAINT chk_instagram_conversations_unread_count CHECK (unread_count >= 0),
  CONSTRAINT chk_instagram_conversations_preview CHECK (last_message_preview IS NULL OR char_length(last_message_preview) <= 200),
  CONSTRAINT chk_instagram_conversations_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversations_public_id ON app.instagram_conversations USING btree (public_id);
--> statement-breakpoint
-- The parent key of the conversation's messages and notes (2.B, 2.C).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversations_organization_id_id ON app.instagram_conversations USING btree (organization_id, id);
--> statement-breakpoint
-- One conversation per contact: the lazy upsert's target (CV2) and the contact key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversations_organization_contact ON app.instagram_conversations USING btree (organization_id, contact_id);
--> statement-breakpoint
-- The inbox list's keyset: newest message first, then id.
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_list ON app.instagram_conversations USING btree (organization_id, last_message_at DESC, id DESC);
--> statement-breakpoint
-- "Mine" and the holder key's index.
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_taken_by_membership ON app.instagram_conversations USING btree (organization_id, taken_by_membership_id) WHERE taken_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_unread ON app.instagram_conversations USING btree (organization_id, last_message_at) WHERE unread_count > 0;
--> statement-breakpoint
-- The 24-hour idle release's sweep (CV4).
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_idle_release ON app.instagram_conversations USING btree (last_team_message_at) WHERE taken_by IS NOT NULL;
--> statement-breakpoint
-- The account key's index.
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_channel_account ON app.instagram_conversations USING btree (organization_id, channel_account_id);
--> statement-breakpoint
ALTER TABLE app.instagram_conversations OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_conversations TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_conversations_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_conversations_tenant_isolation ON app.instagram_conversations;
--> statement-breakpoint
CREATE POLICY instagram_conversations_tenant_isolation ON app.instagram_conversations
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
