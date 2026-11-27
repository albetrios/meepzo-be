-- Migration: app_instagram_conversation_notes
-- Created: 2026-11-27T05:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R4 (routes-final § 2.C.3, CV3): the team's internal notes
-- on a conversation — never sent, never shown to the contact; soft-deleted; they go with their conversation.
-- New table only: nothing existing changes.

CREATE TABLE IF NOT EXISTS app.instagram_conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_conversation_id BIGINT NOT NULL,
  author_membership_id BIGINT NOT NULL,
  text VARCHAR(2000) NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instagram_conversation_notes_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversation_notes_conversation_fk FOREIGN KEY (organization_id, instagram_conversation_id) REFERENCES app.instagram_conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT instagram_conversation_notes_author_membership_fk FOREIGN KEY (organization_id, author_membership_id) REFERENCES tenancy.memberships (organization_id, id),
  CONSTRAINT chk_instagram_conversation_notes_text CHECK (char_length(text) BETWEEN 1 AND 2000),
  CONSTRAINT chk_instagram_conversation_notes_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_conversation_notes_public_id ON app.instagram_conversation_notes USING btree (public_id);
--> statement-breakpoint
-- The conversation's notes, newest first (2.C.3).
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_notes_list ON app.instagram_conversation_notes USING btree (instagram_conversation_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The conversation key's index.
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_notes_conversation ON app.instagram_conversation_notes USING btree (organization_id, instagram_conversation_id);
--> statement-breakpoint
-- The author key's index.
CREATE INDEX IF NOT EXISTS idx_instagram_conversation_notes_author_membership ON app.instagram_conversation_notes USING btree (organization_id, author_membership_id);
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_notes OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_conversation_notes TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_conversation_notes_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_conversation_notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_conversation_notes_tenant_isolation ON app.instagram_conversation_notes;
--> statement-breakpoint
CREATE POLICY instagram_conversation_notes_tenant_isolation ON app.instagram_conversation_notes
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
