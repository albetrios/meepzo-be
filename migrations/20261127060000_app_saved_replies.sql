-- Migration: app_saved_replies
-- Created: 2026-11-27T06:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R5 (routes-final § 3.3, SR1–SR6): the organization's
-- reusable reply texts, shared across channels (I-D2) — a title unique in any case, the text (1–1,000 UTF-8
-- bytes), and how often and when it was last used. Hard delete (SR5). New table only.

CREATE TABLE IF NOT EXISTS app.saved_replies (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  title VARCHAR(100) NOT NULL,
  text TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT saved_replies_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT saved_replies_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT saved_replies_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_saved_replies_title CHECK (char_length(title) BETWEEN 1 AND 100),
  CONSTRAINT chk_saved_replies_text CHECK (octet_length(text) BETWEEN 1 AND 1000),
  CONSTRAINT chk_saved_replies_use_count CHECK (use_count >= 0),
  CONSTRAINT chk_saved_replies_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_replies_public_id ON app.saved_replies USING btree (public_id);
--> statement-breakpoint
-- One title per organization, any case (SR3) — also the title-ordered list.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_replies_organization_title ON app.saved_replies USING btree (organization_id, lower(title));
--> statement-breakpoint
-- The most-used list (SR4).
CREATE INDEX IF NOT EXISTS idx_saved_replies_organization_use_count ON app.saved_replies USING btree (organization_id, use_count DESC, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_saved_replies_created_by_user_id ON app.saved_replies USING btree (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_saved_replies_updated_by_user_id ON app.saved_replies USING btree (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.saved_replies OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.saved_replies TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.saved_replies_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.saved_replies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.saved_replies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS saved_replies_tenant_isolation ON app.saved_replies;
--> statement-breakpoint
CREATE POLICY saved_replies_tenant_isolation ON app.saved_replies
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
